import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';

/**
 * Settings <-> Inspector integration acceptance on the merged tree.
 *
 * The three overlapping files were merged by hand (frontend types, Harness Chat dependencies,
 * ProductApi route table). These tests boot the real listener and prove the two accepted feature
 * sets coexist: Settings owns its 11 routes and Inspector keeps its nine methods, the one-shot
 * request edit is consumed exactly once without rewriting recorded requests, a promoted Work task
 * keeps dual canonical archive recall, and Settings defaults/recording/clear-history interact with
 * Inspector truthfully. No domain is called directly and no response is fabricated.
 */

const TREE = process.cwd();
const TEMP_ROOT = path.resolve(process.env.TEMP ?? path.join(TREE, '.tmp'));
mkdirSync(TEMP_ROOT, { recursive: true });

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const inspector = '/v1/product/inspector';

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text ? '?' + text : '';
};

type Backend = Awaited<ReturnType<typeof startBackend>>;

const until = async <T>(read: () => T | undefined | Promise<T | undefined>, ready: (value: T) => boolean, label: string, timeoutMs = 30000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && ready(value)) return value;
    assert.ok(Date.now() < deadline, 'Timed out waiting for ' + label);
    await sleep(25);
  }
};

const fixture = async (t: import('node:test').TestContext, options: { configure?: (dir: string, workspace: string) => void } = {}) => {
  const dir = mkdtempSync(path.join(TEMP_ROOT, 'settings-inspector-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  options.configure?.(dir, workspace);
  const dataDir = path.join(dir, 'data');
  const wire: any[] = [];
  const settings = { dataDir, projectRoot: TREE, mockOptions: { trace: (body: any) => wire.push(body) } };
  let backend: Backend = await startBackend(settings);
  let closed = false;

  const request = async (method: string, route: string, body?: unknown, auth = true) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = 'Bearer ' + backend.token;
    const response = await fetch('http://127.0.0.1:' + backend.port + route, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: response.status, json, text, headers: response.headers };
  };
  const ok = async (method: string, route: string, body?: unknown): Promise<any> => {
    const reply = await request(method, route, body);
    assert.equal(reply.status, 200, method + ' ' + route + ' -> ' + reply.status + ': ' + reply.text.slice(0, 500));
    assert.match(String(reply.headers.get('content-type') ?? ''), /application\/json/);
    return reply.json;
  };
  const fails = async (method: string, route: string, body: unknown, status: number | number[], code: string): Promise<any> => {
    const reply = await request(method, route, body);
    const statuses = Array.isArray(status) ? status : [status];
    assert.ok(statuses.includes(reply.status), method + ' ' + route + ' -> ' + reply.status + ': ' + reply.text.slice(0, 500));
    assert.equal(reply.json?.code, code, method + ' ' + route + ' -> ' + reply.text.slice(0, 500));
    return reply.json;
  };
  const session = async (input: Record<string, unknown>): Promise<any> => {
    const created = await ok('POST', '/v1/harness/sessions', input);
    assert.equal(typeof created.id, 'string');
    return created;
  };
  const settle = async (sessionId: string, previousId?: string): Promise<any> => {
    const record = await until(async () => {
      const latest = backend.services.harness!.store.latestRequest(sessionId, 'chat');
      return latest && latest.id !== previousId && TERMINAL.has(latest.status) ? latest : undefined;
    }, (value: any) => Boolean(value), 'chat request settles for ' + sessionId);
    assert.equal(record.status, 'completed', JSON.stringify(record.error ?? record.status));
    return record;
  };
  const send = async (sessionId: string, text: string, modelId = 'default'): Promise<any> => {
    const previous = backend.services.harness!.store.latestRequest(sessionId, 'chat');
    await ok('POST', '/v1/product/chat/send', { sessionId, mode: 'chat', text, attachments: [], permission: 'read-only', modelId });
    return settle(sessionId, previous?.id);
  };
  const restart = async (): Promise<void> => { await backend.close(); backend = await startBackend(settings); };
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  };
  t.after(async () => { await close(); });

  return {
    get backend(): Backend { return backend; },
    get harness() { return backend.services.harness!; },
    get kernel() { return backend.services.kernel; },
    get runner() { return backend.services.runner; },
    wire, dir, workspace, dataDir,
    request, ok, fails, session, send, settle, restart, close,
  };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;

const GLOBAL_FILE = 'Global instruction marker: settings-inspector-global-marker.';

const configureInstructions = (dir: string) => {
  const dataDir = path.join(dir, 'data');
  const globalDir = path.join(dir, 'global');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  const globalFile = path.join(globalDir, 'AGENTS.md');
  writeFileSync(globalFile, GLOBAL_FILE, 'utf8');
  writeFileSync(path.join(dataDir, 'configuration.json'), JSON.stringify({
    provider: { mode: 'mock', model: 'mock' }, globalPaths: [globalFile], skillRoots: [],
  }), 'utf8');
};

test('Settings routes and all nine Inspector methods boot together on the merged route table', { timeout: 120_000 }, async t => {
  const f = await fixture(t, { configure: configureInstructions });

  const settings = await f.ok('GET', '/v1/product/settings');
  assert.equal(settings.appearance.theme, 'light');
  assert.equal(settings.appearance.accent, 'ember');
  assert.equal(settings.defaults.modelId, 'default');
  assert.equal(settings.privacy.redactSecrets, true);
  const instructions = await f.ok('GET', '/v1/product/settings/instructions');
  const globalEntry = instructions.find((entry: any) => entry.scope === 'global');
  assert.ok(globalEntry, 'the configured global instruction file is listed');
  assert.equal(globalEntry.status, 'loaded');
  assert.equal(globalEntry.bytes, Buffer.byteLength(GLOBAL_FILE, 'utf8'));
  assert.equal(globalEntry.sha256, sha256(GLOBAL_FILE), 'sha256 is the real loaded content hash');
  assert.deepEqual(await f.ok('GET', '/v1/product/settings/mcp'), []);
  assert.ok(Array.isArray(await f.ok('GET', '/v1/product/settings/plugins')));
  assert.ok(Array.isArray(await f.ok('GET', '/v1/product/settings/skills')));

  const patched = await f.ok('POST', '/v1/product/settings/update', { appearance: { theme: 'dark' } });
  assert.equal(patched.appearance.theme, 'dark');
  assert.equal(patched.appearance.accent, 'ember', 'a partial patch keeps sibling appearance fields');

  const created = await f.session({ title: 'Merged routes' });
  const sessionId = created.id as string;
  const first = await f.send(sessionId, 'ROUTE_BASELINE_TURN');
  const user = f.harness.store.allMessages(sessionId).find((message: any) => message.role === 'user');
  assert.ok(user);

  const prompt = await f.ok('GET', inspector + '/prompt' + query({ sessionId }));
  assert.ok(Array.isArray(prompt.parts) && prompt.parts.length > 0);
  const requests = await f.ok('GET', inspector + '/requests' + query({ sessionId }));
  const recorded = requests.find((item: any) => item.id === first.id);
  assert.ok(recorded, 'the settled request is visible through Inspector');
  assert.equal(recorded.status, 'completed');
  assert.ok(recorded.body, 'the recorded provider body is kept');
  const tools = await f.ok('GET', inspector + '/tools' + query({ sessionId }));
  assert.ok(Array.isArray(tools.registered) && Array.isArray(tools.exposed));
  const trace = await f.ok('GET', inspector + '/trace' + query({ sessionId }));
  assert.ok(Array.isArray(trace.spans) && trace.spans.length > 0);
  const context = await f.ok('GET', inspector + '/context' + query({ sessionId }));
  assert.equal(typeof context.windowTokensKnown, 'boolean');
  const recall = await f.ok('GET', inspector + '/recall' + query({ sessionId, sourceId: user.id }));
  assert.match(recall.sha, /^[a-f0-9]{64}$/);
  assert.match(recall.text, /ROUTE_BASELINE_TURN/);
  assert.deepEqual(await f.ok('GET', inspector + '/diffs' + query({ sessionId })), []);

  const saved = await f.ok('POST', inspector + '/prompt', { sessionId, partId: 'session:systemPrompt', content: 'MERGED_ROUTE_SESSION_PROMPT', scope: 'session' });
  assert.equal(saved.parts.find((part: any) => part.id === 'session:systemPrompt').content, 'MERGED_ROUTE_SESSION_PROMPT');
  const branch = await f.ok('POST', inspector + '/replay', { requestId: first.id, body: recorded.body, mode: 'branch' });
  assert.equal(branch.status, 'draft');
  assert.equal(branch.parentId, first.id);

  const unauthenticated = await f.request('GET', inspector + '/prompt' + query({ sessionId }), undefined, false);
  assert.equal(unauthenticated.status, 401);
  assert.ok(!JSON.stringify(unauthenticated.json).includes('ROUTE_BASELINE_TURN'));
  await f.fails('PUT', inspector + '/prompt' + query({ sessionId }), undefined, 405, 'validation');
  await f.fails('GET', inspector + '/unknown' + query({ sessionId }), undefined, 404, 'not_found');
  await f.fails('GET', '/v1/product/settings/unknown', undefined, 404, 'not_found');

  const after = await f.ok('GET', '/v1/product/settings');
  assert.equal(after.appearance.theme, 'dark', 'Inspector traffic never mutates Settings');
  const instructionsAfter = await f.ok('GET', '/v1/product/settings/instructions');
  assert.equal(instructionsAfter.find((entry: any) => entry.scope === 'global').sha256, globalEntry.sha256);
});

test('a request-scope edit binds exactly once and never rewrites a recorded request', { timeout: 120_000 }, async t => {
  const f = await fixture(t, { configure: configureInstructions });
  // Instructions are only read for a session that has a workspace; capabilities alone are not enough.
  const created = await f.session({ title: 'One-shot integration', workspace: f.workspace, capabilities: { skills: false, projectInstructions: true } });
  const sessionId = created.id as string;

  const baseline = await f.send(sessionId, 'ONE_SHOT_BASELINE');
  assert.ok(JSON.stringify(f.wire.at(-1)).includes('settings-inspector-global-marker'), 'the merged Chat loader still injects global instructions');
  const baselineView = (await f.ok('GET', inspector + '/requests' + query({ sessionId }))).find((item: any) => item.id === baseline.id);
  const recordedBody = JSON.stringify(baselineView.body);

  const draft = await f.ok('POST', inspector + '/prompt', { sessionId, partId: 'request:systemPrompt', content: 'ONE_SHOT_INTEGRATION_MARKER', scope: 'request' });
  assert.equal(typeof draft.requestId, 'string');
  assert.ok(Number(draft.pendingEdits) >= 1, JSON.stringify(draft));
  const preview = await f.ok('GET', inspector + '/prompt' + query({ sessionId }));
  const draftPart = preview.parts.find((part: any) => part.id === 'request:systemPrompt');
  assert.ok(draftPart, 'the pending one-shot edit is inspectable');
  assert.equal(draftPart.content, 'ONE_SHOT_INTEGRATION_MARKER');

  const wireBefore = f.wire.length;
  await f.send(sessionId, 'ONE_SHOT_CONSUME');
  const consumed = f.wire.slice(wireBefore).map((body: any) => JSON.stringify(body));
  assert.equal(consumed.filter(text => text.includes('ONE_SHOT_INTEGRATION_MARKER')).length, 1, 'exactly one dispatched request receives the one-shot edit');

  const settledPreview = await f.ok('GET', inspector + '/prompt' + query({ sessionId }));
  assert.equal(settledPreview.pendingEdits, 0, 'the consumed edit is no longer pending');
  const afterView = (await f.ok('GET', inspector + '/requests' + query({ sessionId }))).find((item: any) => item.id === baseline.id);
  assert.equal(JSON.stringify(afterView.body), recordedBody, 'a recorded request body never changes');

  await f.send(sessionId, 'ONE_SHOT_LATER');
  assert.ok(!JSON.stringify(f.wire.at(-1)).includes('ONE_SHOT_INTEGRATION_MARKER'), 'a later request never re-applies the consumed edit');

  await f.restart();
  const persisted = (await f.ok('GET', inspector + '/requests' + query({ sessionId }))).find((item: any) => item.id === baseline.id);
  assert.equal(JSON.stringify(persisted.body), recordedBody, 'request bodies persist byte-identically');
  assert.equal((await f.ok('GET', inspector + '/prompt' + query({ sessionId }))).pendingEdits, 0);
});

test('promoted Work keeps dual canonical archive recall while the merged tree runs', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const created = await f.session({ title: 'Dual archive', workspace: f.workspace });
  const sessionId = created.id as string;
  await f.send(sessionId, 'DUAL_ARCHIVE_ORIGIN');
  const origin = f.harness.store.allMessages(sessionId).find((message: any) => message.role === 'user');
  assert.ok(origin);
  const originSha = f.harness.store.memory(sessionId).read({ id: origin.id, field: 'record', length: 12_000 }).sha256;

  await f.runner.stop();
  const promoted = await f.ok('POST', '/v1/product/sessions/' + encodeURIComponent(sessionId) + '/promote', { objective: 'Keep both archives readable', acceptance: ['both recalls stay canonical'] });
  const taskId = promoted.id as string;
  assert.ok(f.kernel.getTask(taskId));
  const own = f.kernel.addMessage(taskId, 'user', 'DUAL_ARCHIVE_OWN_MESSAGE');
  const ownSha = f.kernel.memory(taskId, 'main').read({ id: own.id, field: 'record', length: 12_000 }).sha256;

  const originRecall = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: origin.id }));
  assert.equal(originRecall.sha, originSha, 'the origin record keeps its canonical Chat SHA');
  assert.equal(originRecall.text, origin.content);
  const ownRecall = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: own.id }));
  assert.equal(ownRecall.sha, ownSha, 'the task own message uses its canonical Kernel SHA');

  f.harness.store.updateMessageContent(sessionId, origin.id, 'DUAL_ARCHIVE_MUTATED');
  const immutable = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: origin.id }));
  assert.equal(immutable.text, origin.content, 'editing the source Chat cannot rewrite the promoted origin');
  const live = await f.ok('GET', inspector + '/recall' + query({ sessionId, sourceId: origin.id }));
  assert.equal(live.text, 'DUAL_ARCHIVE_MUTATED', 'the live Chat scope reads its mutated record');

  f.harness.store.deleteSession(sessionId);
  const afterDelete = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: origin.id }));
  assert.equal(afterDelete.sha, originSha, 'deleting the source Chat cannot remove the promoted origin');

  await f.restart();
  const afterRestart = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: origin.id }));
  assert.equal(afterRestart.sha, originSha);
  assert.equal(afterRestart.text, origin.content);
});

test('Settings defaults, hidden recording and clear-history interact with Inspector truthfully', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  const seeded = await f.ok('GET', '/v1/product/settings');
  assert.equal(seeded.defaults.modelId, 'default');

  const model = await f.ok('POST', '/v1/product/models/save', { name: 'Integration default model', provider: 'Mock vendor', model: 'mock-integration-default', mode: 'mock', contextWindow: 65536 });
  assert.equal(typeof model.id, 'string');

  const chat = await f.session({ title: 'Existing model session' });
  const chatId = chat.id as string;
  await f.send(chatId, 'EXISTING_MODEL_TURN');
  assert.equal((await f.ok('GET', '/v1/product/sessions/' + encodeURIComponent(chatId))).modelId, 'default');

  const updated = await f.ok('POST', '/v1/product/settings/update', { defaults: { modelId: model.id } });
  assert.equal(updated.defaults.modelId, model.id);
  assert.equal((await f.ok('GET', '/v1/product/settings')).defaults.modelId, model.id);
  const existing = await f.ok('GET', '/v1/product/sessions/' + encodeURIComponent(chatId));
  assert.equal(existing.modelId, 'default', 'changing the default never rewrites an existing session');

  const removal = await f.request('POST', '/v1/product/models/' + encodeURIComponent(model.id) + '/remove');
  assert.equal(removal.status, 409, JSON.stringify(removal.json));
  assert.equal(removal.json.code, 'conflict');

  // A new conversation resolves the default at send time (frontend actions.ts passes this exact
  // settings.defaults.modelId), and the backend indexes exactly the model that received the request.
  const defaults = (await f.ok('GET', '/v1/product/settings')).defaults;
  const wireBefore = f.wire.length;
  const started = await f.ok('POST', '/v1/product/chat/send', { mode: 'chat', text: 'NEW_DEFAULT_MODEL_TURN', attachments: [], permission: 'ask', modelId: defaults.modelId });
  const freshId = started.sessionId as string;
  await f.settle(freshId);
  const fresh = await f.ok('GET', '/v1/product/sessions/' + encodeURIComponent(freshId));
  assert.equal(fresh.modelId, model.id, 'a new session records the default model that served it');
  assert.equal(f.wire.slice(wireBefore).at(-1).model, 'mock-integration-default', 'the new default model really receives the request');

  const hidden = await f.ok('POST', '/v1/product/settings/update', { privacy: { recordContent: false } });
  assert.equal(hidden.privacy.recordContent, false);
  const hiddenTurn = await f.send(chatId, 'HIDDEN_CONTENT_TURN');
  const hiddenView = (await f.ok('GET', inspector + '/requests' + query({ sessionId: chatId }))).find((item: any) => item.id === hiddenTurn.id);
  assert.ok(hiddenView);
  assert.equal(hiddenView.body, null, 'hidden recording keeps no content');
  assert.deepEqual(hiddenView.usage, { input: hiddenTurn.usage.prompt_tokens, output: hiddenTurn.usage.completion_tokens }, 'usage stays real metadata');
  const hiddenContext = await f.ok('GET', inspector + '/context' + query({ sessionId: chatId }));
  assert.equal(hiddenContext.usedTokens, hiddenView.usage.input);
  assert.equal(hiddenContext.usedTokensEstimated, false);
  assert.deepEqual(hiddenContext.segments, []);
  const hiddenUser = f.harness.store.allMessages(chatId).find((message: any) => message.role === 'user' && message.content === 'HIDDEN_CONTENT_TURN');
  assert.ok(hiddenUser);
  const canonical = f.harness.store.memory(chatId).read({ id: hiddenUser.id, field: 'record', length: 12_000 }).sha256;
  const hiddenRecall = await f.ok('GET', inspector + '/recall' + query({ sessionId: chatId, sourceId: hiddenUser.id }));
  assert.equal(hiddenRecall.sha, canonical, 'canonical recall survives hidden recording');

  await f.ok('POST', '/v1/product/sessions/' + encodeURIComponent(chatId) + '/update', { pinned: true });
  const auditBefore = f.harness.store.listRequests({}).requests.length;
  assert.deepEqual(await f.ok('POST', '/v1/product/settings/clear-history', {}), { cleared: true });
  const list = await f.ok('GET', '/v1/product/sessions');
  const ids = list.items.map((item: any) => item.id);
  assert.ok(ids.includes(chatId), 'pinned chats stay');
  assert.ok(!ids.includes(freshId), 'non-pinned chats are cleared from the index');
  assert.equal(f.harness.store.listRequests({}).requests.length, auditBefore, 'Inspector request audit rows stay');
  const pinnedPrompt = await f.ok('GET', inspector + '/prompt' + query({ sessionId: chatId }));
  assert.ok(Array.isArray(pinnedPrompt.parts));
  assert.equal((await f.ok('GET', '/v1/product/settings')).defaults.modelId, model.id, 'settings survive clear-history');
  assert.equal((await f.ok('GET', '/v1/product/sessions/' + encodeURIComponent(chatId))).modelId, 'default', 'an existing session still keeps its own model');
});
