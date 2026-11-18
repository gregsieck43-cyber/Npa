import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { HarnessStore } from '../src/harness/store.js';
import { ChatService } from '../src/harness/chat.js';
import { compactPhase } from '../src/runtime/phase-summary.js';
import { DEFAULT_PROVIDER } from '../src/runtime/model.js';
import type { Configuration } from '../src/app/configuration.js';
import type { Services } from '../src/app/services.js';
import { startBackend } from '../src/app/backend.js';
import { randomUUID } from 'node:crypto';

function fixture(t: import('node:test').TestContext) {
  const base = path.resolve(process.env.TEMP ?? '.tmp'), root = mkdtempSync(path.join(base, 'phase-summary-011-'));
  const store = new HarnessStore(root), session = store.createSession();
  const user = store.addMessage(session.id, { role: 'user', content: 'Authoritative correction: publishing is forbidden; the database is SQLite.' }, 'authority');
  const cursor = store.messageRef(session.id, user.id)!.seq;
  for (let i = 0; i < 190; i++) store.addMessage(session.id, { role: 'assistant', content: 'Completed observation ' + i, sampledUserInput: { cursor, offset: 0 } });
  t.after(() => { store.close(); assert.equal(path.dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  return { store, session, cursor, root };
}

test('production Chat acknowledges a turn before installing a bounded summary without consuming further input', async t => {
  const f = fixture(t), requests: any[] = [];
  const config = { ...DEFAULT_PROVIDER, maxOutputTokens: 2048 };
  const chat = new ChatService({ store: f.store, configuration: { globalPaths: [], skillRoots: [], sanitize: (value: unknown) => value } as unknown as Configuration,
    services: { projectRoot: process.cwd() } as Services, profileConfig: () => config, getPromptParts: () => [],
    prepareModel: (context, body, sources) => {
      requests.push(body);
      if (requests.length === 1) assert.deepEqual(f.store.consumedUserInput(f.session.id), { cursor: f.cursor, offset: 0 });
      return f.store.createRequest({ ...context, profileId: 'default', body, bodyHash: 'fixture', sources, recordContent: true, status: 'draft', draft: '', endpoint: 'http://127.0.0.1' });
    },
    sendPrepared: async () => ({ content: requests.length === 2 ? 'PHASE_INTERPRETATION: The source says publishing is forbidden and SQLite is current.' : 'New turn answered.', toolCalls: [], finishReason: 'stop' }),
  });
  t.after(() => chat.stop());
  await chat.send({ sessionId: f.session.id, content: 'What constraints remain?' });
  await chat.waitForSettlement(f.session.id);
  assert.equal(f.store.memory(f.session.id).phaseSummaryStats(1).count, 1);
  assert.equal(requests.length, 2); assert.equal(requests[1].tools, undefined);
  assert.match(JSON.stringify((await chat.preview(f.session.id)).body.messages), /PHASE_INTERPRETATION/);
  assert.equal(f.store.messageRef(f.session.id, 'authority')!.message.content, 'Authoritative correction: publishing is forbidden; the database is SQLite.');
  assert.equal(f.store.consumedUserInput(f.session.id).cursor, f.store.previousUserSeq(f.session.id, Number.MAX_SAFE_INTEGER));
});

test('phase summary uses new raw sources after each install and old-goal interpretations stay out of current context', async t => {
  const f = fixture(t), memory = f.store.memory(f.session.id), batches: any[] = [];
  for (let i = 0; i < 2; i++) assert.equal((await compactPhase(memory, { goalVersion: 3, config: DEFAULT_PROVIDER, stillCurrent: () => true,
    complete: async messages => { batches.push(JSON.parse(messages[1]!.content!)); return { content: 'PHASE_ONLY_INTERPRETATION_' + i, toolCalls: [], finishReason: 'stop' }; } })).installed, true);
  assert.equal(memory.phaseSummaryStats(3).count, 2);
  assert.ok(batches[0].sources.every((source: any) => !batches[1].sources.some((second: any) => second.id === source.id)));
  assert.ok(batches.every(batch => !JSON.stringify(batch).includes('PHASE_ONLY_INTERPRETATION')));
  assert.ok(!memory.context('unrelated', 6000, 4).includes('PHASE_ONLY_INTERPRETATION'));
  assert.throws(() => memory.remember({ key: '__phase_summary_3_forged', kind: 'fact', text: 'Fake', sourceIds: ['authority'], expectedRevision: 0 }, 'forged'), /compiler/);
});

test('phase summary installation rejects changed source bytes and superseded authority', async t => {
  const f = fixture(t), memory = f.store.memory(f.session.id);
  let current = true;
  const stale = await compactPhase(memory, { goalVersion: 1, config: DEFAULT_PROVIDER, stillCurrent: () => current, complete: async () => { current = false; return { content: 'Stale interpretation', toolCalls: [], finishReason: 'stop' }; } });
  assert.equal(stale.installed, false); assert.equal(memory.phaseSummaryStats(1).count, 0);
  const changed = await compactPhase(memory, { goalVersion: 1, config: DEFAULT_PROVIDER, stillCurrent: () => true, complete: async () => {
    f.store.updateMessageContent(f.session.id, 'authority', 'Changed authority'); return { content: 'Old source interpretation', toolCalls: [], finishReason: 'stop' };
  } });
  assert.equal(changed.installed, false); assert.equal(memory.phaseSummaryStats(1).count, 0);
});

test('new Chat input interrupts only the previous phase tail and its old finally keeps the new owner', async t => {
  const f = fixture(t), bodies = new Map<string, any>();
  let started!: () => void; const summarizing = new Promise<void>(resolve => { started = resolve; });
  let summaries = 0, aborted = false;
  const chat = new ChatService({ store: f.store, configuration: { globalPaths: [], skillRoots: [], sanitize: (value: unknown) => value } as unknown as Configuration,
    services: { projectRoot: process.cwd() } as Services, profileConfig: () => DEFAULT_PROVIDER, getPromptParts: () => [],
    prepareModel: (context, body, sources) => {
      const record = f.store.createRequest({ ...context, profileId: 'default', body, bodyHash: 'fixture', sources, recordContent: true, status: 'draft', draft: '', endpoint: 'http://127.0.0.1' }); bodies.set(record.id, body); return record;
    },
    sendPrepared: async (id, _body, signal) => {
      if (bodies.get(id).messages[0].content.startsWith('Summarize only these bounded original archive')) {
        if (++summaries === 1) {
          started(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('phase interrupted')); }, { once: true }));
        }
        return { content: 'The current sources remain authoritative.', toolCalls: [], finishReason: 'stop' };
      }
      return { content: 'Ordinary response', toolCalls: [], finishReason: 'stop' };
    },
  });
  t.after(() => chat.stop());
  await chat.send({ sessionId: f.session.id, content: 'First new question' });
  const firstSettlement = chat.waitForSettlement(f.session.id);
  await summarizing;
  assert.equal(chat.busy(f.session.id), false); assert.equal(chat.activeRequestId(f.session.id), undefined);
  await chat.send({ sessionId: f.session.id, content: 'A correction supersedes the pending summary' });
  await Promise.all([firstSettlement, chat.waitForSettlement(f.session.id)]);
  assert.equal(aborted, true); assert.equal(chat.busy(f.session.id), false);
  assert.equal(f.store.memory(f.session.id).phaseSummaryStats(1).count, 1);
  assert.equal(f.store.consumedUserInput(f.session.id).cursor, f.store.previousUserSeq(f.session.id, Number.MAX_SAFE_INTEGER));
});

for (const [maxModelCalls, observations] of [[2, 190], [10, 190], [10, 1]] as const) test(`production Work summary preserves dispatch allowance and review reserve (${maxModelCalls} calls, ${observations} observations)`, { timeout: 40000 }, async t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp'), root = mkdtempSync(path.join(base, 'phase-work-011-')), workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  let compacted = 0;
  const backend = await startBackend({ dataDir: path.join(root, 'data'), projectRoot: process.cwd(), mockOptions: { responder: body => {
    if (body.messages[0]?.content.startsWith('Summarize only these bounded original archive')) { compacted++; return { content: 'WORK_PHASE_SUMMARY: user constraints remain in original sources.' }; }
    if (body.messages[0]?.content.includes('REVIEWER ROLE')) return { content: '{"verdict":"unknown"}' };
    return { content: 'The proposed result requires independent verification.' };
  } } });
  await backend.services.runner.stop();
  const config = backend.services.configuration;
  config.set({ ...config.provider, mode: 'live', baseUrl: 'https://phase-fixture.invalid/v1', apiKey: 'harmless-phase-fixture', authorizePaid: true, maxRequests: maxModelCalls });
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://phase-fixture.invalid/v1/chat/completions');
    return originalFetch(new URL('chat/completions', backend.mock.url.replace(/\/?$/, '/')), { ...init, headers: { 'Content-Type': 'application/json' } });
  });
  t.after(async () => { await backend.close(); assert.equal(path.dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  const kernel = backend.services.kernel;
  const taskId = backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace, objective: 'Retain original constraints', maxModelCalls } }).taskId!;
  const cursor = kernel.latestUserCursor(taskId);
  for (let i = 0; i < observations; i++) kernel.addMessage(taskId, 'assistant', 'Completed observation ' + i, 'main', { sampledUserInput: { cursor, offset: 0 } });
  backend.services.runner.start();
  const deadline = Date.now() + 30000;
  while (!['waiting_input', 'failed', 'completed'].includes(kernel.getTask(taskId)!.status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(kernel.getTask(taskId)!.status, 'waiting_input');
  assert.equal(compacted, maxModelCalls === 2 || observations === 1 ? 0 : 1);
  assert.equal(kernel.memory(taskId).phaseSummaryStats(1).count, compacted);
  assert.equal(kernel.getBudgets(taskId).modelCalls, compacted + 2);
  assert.equal(config.view().remainingLiveRequests, maxModelCalls - compacted - 2, 'Only actual model dispatches spend allowance, including no_retired_sources');
  assert.equal(kernel.consumedUserInput(taskId).cursor, cursor);
});
