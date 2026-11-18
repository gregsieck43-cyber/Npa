import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { HarnessStore } from '../src/harness/store.js';
import { customParts, promptSettings } from '../src/harness/prompts.js';
import { Profiles } from '../src/harness/profiles.js';
import { Configuration } from '../src/app/configuration.js';

function fixture(t: import('node:test').TestContext) {
  const root = path.resolve(process.env.TEMP ?? '.tmp'), owned = mkdtempSync(path.join(root, 'prompt-store-'));
  let store = new HarnessStore(owned);
  t.after(() => { store.close(); assert.equal(path.dirname(owned), root); rmSync(owned, { recursive: true, force: true }); });
  return { owned, get store() { return store; }, restart() { store.close(); store = new HarnessStore(owned); } };
}

test('prompt scopes replace scalar prompts, append dynamic content, and retain superseded sources and versions', t => {
  const f = fixture(t), session = f.store.createSession({ workspace: path.resolve('.'), systemPrompt: 'direct session' });
  promptSettings(f.store, { scope: 'global', systemPrompt: 'global system', developerPrompt: 'global developer', dynamic: 'global addition' }, true);
  promptSettings(f.store, { scope: 'project', scopeId: session.workspace, systemPrompt: 'project system', dynamic: 'project addition' }, true);
  promptSettings(f.store, { scope: 'session', scopeId: session.id, systemPrompt: 'scoped session', developerPrompt: '', dynamic: 'session addition' }, true);
  const sources = customParts(f.store, session);
  assert.deepEqual(sources.filter(part => part.effective && part.role === 'system').map(part => part.content), ['direct session']);
  assert.deepEqual(sources.filter(part => part.effective && part.role === 'developer').map(part => part.content), ['']);
  assert.deepEqual(sources.filter(part => part.effective && part.role === 'user').map(part => part.content), ['global addition', 'project addition', 'session addition']);
  assert.ok(sources.some(part => part.content === 'project system' && part.effective === false && part.version === 1));
  f.restart(); assert.deepEqual(customParts(f.store, session), sources);
});

test('single-request prompt overrides supersede session values without changing stored configuration', t => {
  const f = fixture(t), session = f.store.createSession({ systemPrompt: 'persistent prompt' });
  const sources = customParts(f.store, session, { systemPrompt: 'one request', dynamic: 'one addition' });
  assert.deepEqual(sources.filter(part => part.effective && part.role === 'system').map(part => part.content), ['one request']);
  assert.equal(sources.at(-1)!.scope, 'request');
  assert.equal(customParts(f.store, session).find(part => part.effective)!.content, 'persistent prompt');
});

test('prompt edits retain exact older versions while restored content becomes a new version', t => {
  const f = fixture(t);
  const first = promptSettings(f.store, { scope: 'global', systemPrompt: 'Original' }, true);
  promptSettings(f.store, { scope: 'global', systemPrompt: 'Changed' }, true);
  assert.equal(promptSettings(f.store, { scope: 'global', version: first.version }).systemPrompt, 'Original');
  const restored = promptSettings(f.store, { scope: 'global', systemPrompt: 'Original' }, true);
  assert.equal(restored.version, 3); assert.equal(promptSettings(f.store, { scope: 'global', version: 2 }).systemPrompt, 'Changed');
});

test('trace pagination, request metadata and preset versions remain durable after interruption and cleanup', t => {
  const f = fixture(t), session = f.store.createSession();
  const request = f.store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'chat', status: 'running', endpoint: 'fixture', bodyHash: 'fixture', sources: [], recordContent: true, body: { messages: [{ role: 'user', content: 'large body' }] }, draft: 'partial' });
  for (let i = 0; i < 23; i++) f.store.trace({ sessionId: session.id, requestId: request.id, type: i % 2 ? 'model.delta' : 'tool.result', status: 'running', payload: { index: i } });
  const preset = f.store.savePreset({ name: 'Prompt', kind: 'prompt', scope: 'global', scopeId: '', value: { systemPrompt: 'v1' } });
  f.store.savePreset({ ...preset, value: { systemPrompt: 'v2' } });
  f.restart();
  assert.equal(f.store.getRequest(request.id).error!.code, 'restart_interrupted');
  assert.equal(f.store.listRequests({ sessionId: session.id }).requests[0]!.body, undefined);
  const collected: number[] = []; let after = 0;
  do { const page = f.store.traces({ sessionId: session.id, after, limit: 7 }); collected.push(...page.events.map(event => event.id)); if (!page.nextCursor) break; after = page.nextCursor; } while (true);
  assert.equal(collected.length, 24); assert.equal(new Set(collected).size, 24);
  assert.equal(f.store.traces({ requestId: request.id, type: 'tool.result' }).events.length, 12);
  assert.equal(f.store.presets()[0]!.version, 2); assert.equal(f.store.presets(undefined, true).length, 2);
  assert.deepEqual(f.store.clearHistory(session.id), { requests: 1, events: 24 });
  assert.equal(f.store.getSession(session.id).id, session.id);
});

test('recovery pages bound memory and pin the startup snapshot while new requests are created', t => {
  const f = fixture(t), session = f.store.createSession();
  const create = () => {
    const request = f.store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'chat', status: 'completed', endpoint: 'fixture', bodyHash: 'fixture', sources: [], recordContent: false, draft: '' });
    f.store.saveTool({ id: `${request.id}:call`, requestId: request.id, sessionId: session.id, toolCallId: 'call', name: 'read_history', arguments: { id: 'source' }, source: 'builtin', permission: 'unassessed', status: 'proposed', retries: 0, createdAt: 'now', updatedAt: 'now' });
    return request.id;
  };
  const original = f.store.transaction(() => Array.from({ length: 205 }, create));
  let page = f.store.recoveryRequests();
  assert.equal(page.requestIds.length, 100);
  const future = create(), collected = [...page.requestIds];
  while (page.nextCursor !== null) {
    page = f.store.recoveryRequests(page.nextCursor, page.snapshot);
    assert.ok(page.requestIds.length <= 100); collected.push(...page.requestIds);
  }
  assert.deepEqual(collected, original); assert.ok(!collected.includes(future));
});

test('clearing inspection history retains undelivered results and the ancestry of active tool rounds', t => {
  const f = fixture(t), session = f.store.createSession();
  const request = (parentId?: string) => f.store.createRequest({ sessionId: session.id, parentId, profileId: 'default', kind: 'chat', status: 'completed', endpoint: 'fixture', bodyHash: 'fixture', sources: [], recordContent: false, draft: '' });
  const ancestor = request(), pending = request(ancestor.id), undelivered = request(), disposable = request();
  const tool = (requestId: string, status: string) => f.store.saveTool({ id: `${requestId}:call`, requestId, sessionId: session.id, toolCallId: 'call', name: 'read_history', arguments: { id: 'source' }, source: 'builtin', permission: 'session_memory', status, result: 'durable source', retries: 0, createdAt: 'now', updatedAt: 'now' });
  const waiting = tool(pending.id, 'awaiting_approval'), completed = tool(undelivered.id, 'completed');
  assert.equal(f.store.clearHistory(session.id).requests, 1);
  assert.throws(() => f.store.getRequest(disposable.id), /not found/);
  for (const id of [ancestor.id, pending.id, undelivered.id]) assert.equal(f.store.getRequest(id).id, id);
  assert.equal(f.store.getTool(completed.id).result, 'durable source');
  f.restart();
  for (const id of [ancestor.id, pending.id, undelivered.id]) assert.equal(f.store.getRequest(id).id, id);
  f.store.saveTool({ ...waiting, status: 'completed', receivedByRequestId: disposable.id });
  f.store.saveTool({ ...completed, receivedByRequestId: disposable.id });
  assert.equal(f.store.clearHistory(session.id).requests, 3);
});

test('provider profile label edits preserve provider configuration and mask credentials in profile metadata', t => {
  const f = fixture(t), primary = new Configuration('http://127.0.0.1:1/provider/v1'), profiles = new Profiles(f.store, primary, f.owned);
  const marker = 'FAKE_PROFILE_KEY_FOR_TEST_ONLY';
  const saved = profiles.save({ name: marker, provider: { mode: 'live', baseUrl: 'https://example.invalid/v1', model: 'configured-model', supportsDeveloper: true }, apiKey: marker });
  assert.ok(!JSON.stringify(saved).includes(marker));
  const renamed = profiles.save({ id: saved.id, name: 'Renamed' });
  assert.equal(renamed.provider.mode, 'live'); assert.equal(renamed.provider.model, 'configured-model'); assert.equal(renamed.supportsDeveloper, true);
  assert.equal(profiles.sanitize({ content: marker }).content, '[credential redacted]');
  f.restart(); const restored = new Profiles(f.store, primary, f.owned).list().find(profile => profile.id === saved.id)!;
  assert.equal(restored.provider.model, 'configured-model'); assert.equal(restored.credentialPresent, false);
});

test('conversation history pages use stable cursors without dropping the retained archive', t => {
  const f = fixture(t), session = f.store.createSession();
  for (let i = 0; i < 215; i++) f.store.addMessage(session.id, { role: 'user', content: String(i) });
  const current = f.store.messagePage(session.id), older = f.store.messagePage(session.id, 200, current.nextMessageCursor!);
  assert.equal(current.messages.length, 200); assert.equal(older.messages.length, 15); assert.equal(older.nextMessageCursor, null);
  assert.equal(f.store.messageCount(session.id), 215);
  assert.equal(new Set([...older.messages, ...current.messages].map(message => message.id)).size, 215);
});
