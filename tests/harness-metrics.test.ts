import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { HarnessStore } from '../src/harness/store.js';
import { Configuration } from '../src/app/configuration.js';
import { metricsPresentation, agentPhase } from '../src/ui/agent-metrics.js';

function fixture(t: import('node:test').TestContext) {
  const root = path.resolve(process.env.TEMP ?? '.tmp'), owned = mkdtempSync(path.join(root, 'metrics-'));
  let store = new HarnessStore(owned);
  t.after(() => { store.close(); assert.equal(path.dirname(owned), root); rmSync(owned, { recursive: true, force: true }); });
  return { owned, get store() { return store; }, restart() { store.close(); store = new HarnessStore(owned); } };
}
const request = { profileId: 'default', kind: 'chat' as const, status: 'completed' as const, endpoint: 'fixture', bodyHash: 'hash', sources: [], recordContent: false, draft: '' };

test('whole-log metrics survive paging/restart, exclude unsent drafts, and clean up with their requests', t => {
  const f = fixture(t), session = f.store.createSession();
  f.store.transaction(() => { for (let i = 0; i < 205; i++) {
    f.store.addMessage(session.id, { role: 'user', content: `turn ${i}` });
    f.store.createRequest({ ...request, sessionId: session.id, usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125, prompt_tokens_details: { cached_tokens: 80 } }, model: 'fixture', contextWindowTokens: 1000, durationMs: 1000 });
  } });
  f.store.createRequest({ ...request, sessionId: session.id, status: 'draft' });
  const other = f.store.createSession(); f.store.createRequest({ ...request, sessionId: other.id, usage: { total_tokens: 999 } });
  const read = () => f.store.metrics({ sessionId: session.id });
  const metrics = read(); assert.equal(f.store.listRequests({ sessionId: session.id, limit: 200 }).requests.length, 200);
  assert.equal(metrics.rounds, 205); assert.equal(metrics.steps, 205); assert.equal(metrics.totalTokens, 205 * 125);
  assert.equal(metrics.reportedRequests, 205); assert.equal(metrics.cachedTokens, 205 * 80);
  assert.deepEqual(metricsPresentation(metrics), { speed: 25, cache: 80, context: 10 });
  f.restart(); assert.deepEqual(read(), metrics);
  f.store.clearHistory(session.id); const cleared = read(); assert.equal(cleared.requests, 0); assert.equal(cleared.totalTokens, null);
  assert.equal(f.store.metrics({ sessionId: other.id }).totalTokens, 999);
});

test('missing usage, zero usage, partial cache coverage and tool updates never invent or duplicate readings', t => {
  const f = fixture(t), session = f.store.createSession();
  f.store.createRequest({ ...request, sessionId: session.id });
  assert.equal(f.store.metrics({ sessionId: session.id }).totalTokens, null);
  const known = f.store.createRequest({ ...request, sessionId: session.id, usage: { prompt_tokens: 100, completion_tokens: 0, prompt_cache_hit_tokens: 0 }, durationMs: 1000 });
  const studio = f.store.createRequest({ ...request, sessionId: session.id, kind: 'studio', usage: { prompt_tokens: 80, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } });
  const tool = { id: 'tool', requestId: known.id, sessionId: session.id, toolCallId: 'call', name: 'write_file', arguments: {}, source: 'builtin', permission: 'approval_required', status: 'awaiting_approval', retries: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  f.store.saveTool(tool); f.store.saveTool({ ...tool, status: 'awaiting_approval' });
  let metrics = f.store.metrics({ sessionId: session.id });
  assert.equal(metrics.requests, 3); assert.equal(metrics.steps, 2); assert.equal(metrics.studioRequests, 1); assert.equal(metrics.unreportedRequests, 1);
  assert.equal(metrics.totalTokens, 200); assert.equal(metrics.toolCalls, 1); assert.equal(metrics.cachePromptTokens, 180);
  assert.equal(agentPhase(metrics).label, '等待你批准');
  f.store.updateRequest(known.id, { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 101 } });
  f.store.saveTool({ ...tool, status: 'completed' });
  f.store.saveTool({ ...tool, id: 'studio-tool', requestId: studio.id, status: 'not_executed' });
  metrics = f.store.metrics({ sessionId: session.id });
  assert.equal(metrics.totalTokens, 220); assert.equal(metrics.cachePromptTokens, 80); assert.equal(metrics.toolCalls, 1); assert.equal(metrics.toolsCompleted, 1); assert.equal(metrics.activeTools.length, 0);
  assert.equal(metricsPresentation(metrics).cache, 50); assert.equal(metricsPresentation(metrics).context, null);
});

test('active request metadata remains observable with content recording disabled and after interruption', t => {
  const f = fixture(t), session = f.store.createSession();
  const created = f.store.createRequest({ ...request, sessionId: session.id, status: 'running', model: 'private-model', startedAt: new Date().toISOString() });
  f.store.updateRequest(created.id, { draft: 'ignored by metrics' });
  const metrics = f.store.metrics({ sessionId: session.id }); assert.equal(metrics.active!.model, 'private-model');
  assert.equal(agentPhase(metrics).label, '正在生成'); assert.equal(JSON.stringify(metrics).includes('ignored by metrics'), false);
  assert.equal(agentPhase({ ...metrics, task: { status: 'paused', children: 0 } }).label, '任务已暂停');
  assert.equal(agentPhase({ ...metrics, active: undefined, task: { status: 'queued', children: 0, retryAt: new Date(Date.now() + 10000).toISOString() } }).label, '等待重试');
  f.restart(); assert.equal(f.store.metrics({ sessionId: session.id }).active, undefined);
});

test('context capacity is optional, persisted, validated and cleared when the configured model changes', t => {
  const f = fixture(t), config = new Configuration('http://fixture', f.owned);
  config.set({ mode: 'mock', model: 'one', contextWindowTokens: 64000 });
  assert.equal(new Configuration('http://fixture', f.owned).provider.contextWindowTokens, 64000);
  assert.throws(() => config.set({ mode: 'mock', contextWindowTokens: -1 }), /positive integer/);
  config.set({ mode: 'mock', model: 'two' }); assert.equal(config.provider.contextWindowTokens, undefined);
  config.set({ mode: 'mock', model: 'two', contextWindowTokens: null }); assert.equal(config.provider.contextWindowTokens, undefined);
});
