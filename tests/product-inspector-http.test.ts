import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';

/**
 * New Inspector HTTP routes: direct HTTP acceptance against the fixed contract.
 *
 * Every call goes through the real startBackend listener (Bearer token, raw /v1/product body),
 * a real SQLite Harness/Kernel/ProductApi and the mock provider. No inspector domain is invoked
 * directly and no applied tool receipt is fabricated.
 */

const TREE = process.cwd();
const DATA_ROOT = path.join(TREE, '.tmp', 'inspector-integration', 'b', 'data', 'http');
mkdirSync(DATA_ROOT, { recursive: true });

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
let run = 0;

type Backend = Awaited<ReturnType<typeof startBackend>>;

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text ? '?' + text : '';
};

async function fixture(t: import('node:test').TestContext, mockOptions: MockProviderOptions = {}) {
  const owned = path.join(DATA_ROOT, 'http-' + process.pid + '-' + Date.now() + '-' + run++);
  const workspace = path.join(owned, 'workspace');
  const dataDir = path.join(owned, 'data');
  mkdirSync(workspace, { recursive: true });
  const relative = path.relative(TREE, dataDir);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'dataDir must stay inside the project root');
  const wire: any[] = [];
  const settings = { dataDir, projectRoot: TREE, mockOptions: { ...mockOptions, trace: (body: any) => wire.push(body) } };
  let backend: Backend = await startBackend(settings);
  let closed = false;

  const request = async (method: string, route: string, options: { body?: unknown; auth?: boolean } = {}): Promise<{ status: number; json: any; text: string; headers: Headers }> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.auth !== false) headers.Authorization = 'Bearer ' + backend.token;
    const response = await fetch('http://127.0.0.1:' + backend.port + route, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: response.status, json, text, headers: response.headers };
  };
  const ok = async (method: string, route: string, body?: unknown): Promise<any> => {
    const reply = await request(method, route, { body });
    assert.equal(reply.status, 200, method + ' ' + route + ' -> ' + reply.status + ': ' + reply.text.slice(0, 400));
    assert.match(String(reply.headers.get('content-type') ?? ''), /application\/json/);
    return reply.json;
  };
  const fails = async (method: string, route: string, body: unknown, status: number | number[], code: string): Promise<any> => {
    const reply = await request(method, route, { body });
    const statuses = Array.isArray(status) ? status : [status];
    assert.ok(statuses.includes(reply.status), method + ' ' + route + ' -> ' + reply.status + ': ' + reply.text.slice(0, 400));
    assert.equal(reply.json?.code, code, method + ' ' + route + ' -> ' + reply.text.slice(0, 400));
    assert.equal(typeof reply.json?.error, 'string');
    return reply.json;
  };
  const until = async (read: () => Promise<any>, ready: (value: any) => boolean, label: string): Promise<any> => {
    const deadline = performance.now() + 20_000;
    for (;;) {
      const value = await read();
      if (ready(value)) return value;
      assert.ok(performance.now() < deadline, 'Did not settle: ' + label + ' ' + JSON.stringify(value)?.slice(0, 800));
      await sleep(25);
    }
  };
  const session = async (input: Record<string, unknown>): Promise<any> => ok('POST', '/v1/harness/sessions', input);
  const send = async (sessionId: string, text: string, modelId = 'default'): Promise<any> => {
    const previous = backend.services.harness!.store.latestRequest(sessionId, 'chat');
    await ok('POST', '/v1/product/chat/send', { sessionId, mode: 'chat', text, modelId, permission: 'read-only' });
    const record = await until(async () => {
      const latest = backend.services.harness!.store.latestRequest(sessionId, 'chat');
      return latest && latest.id !== previous?.id ? latest : undefined;
    }, (value: any) => Boolean(value && TERMINAL.has(value.status) && !backend.services.harness!.chat.busy(sessionId)), 'all Chat input fragments settle for ' + sessionId);
    assert.ok(record);
    assert.equal(record.status, 'completed', JSON.stringify(record.error));
    return record;
  };
  const restart = async (): Promise<void> => {
    await backend.close();
    backend = await startBackend(settings);
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await backend.close();
  };
  t.after(async () => {
    await close();
    rmSync(owned, { recursive: true, force: true });
  });

  return {
    get backend(): Backend { return backend; },
    get harness() { return backend.services.harness!; },
    get kernel() { return backend.services.kernel; },
    get runner() { return backend.services.runner; },
    wire,
    workspace,
    dataDir,
    request,
    ok,
    fails,
    until,
    session,
    send,
    restart,
    close,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const inspector = '/v1/product/inspector';

test('Inspector HTTP contract exposes all nine methods with strict auth, query and body validation', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const created = await f.session({ title: 'HTTP contract' });
  const sessionId = created.id as string;
  const first = await f.send(sessionId, 'CONTRACT_BASELINE');
  const requestId = first.id as string;
  const wireBody = first.body;
  const user = f.harness.store.allMessages(sessionId).find(message => message.role === 'user');
  assert.ok(user);

  const preview = await f.ok('GET', inspector + '/prompt' + query({ sessionId }));
  assert.ok(Array.isArray(preview.parts) && preview.parts.length > 0);
  assert.equal(typeof preview.totalTokens, 'number');
  assert.equal(preview.pendingEdits, 0);

  const recorded = await f.ok('GET', inspector + '/prompt' + query({ sessionId, requestId }));
  assert.equal(recorded.requestId, requestId);
  assert.ok(Array.isArray(recorded.parts));

  const saved = await f.ok('POST', inspector + '/prompt', { sessionId, partId: 'session:systemPrompt', content: 'HTTP_CONTRACT_SESSION', scope: 'session' });
  const savedPart = saved.parts.find((part: any) => part.id === 'session:systemPrompt');
  assert.ok(savedPart);
  assert.equal(savedPart.content, 'HTTP_CONTRACT_SESSION');
  assert.equal(savedPart.editable, true);
  assert.equal(typeof savedPart.version, 'number');

  const requests = await f.ok('GET', inspector + '/requests' + query({ sessionId }));
  assert.ok(Array.isArray(requests));
  const view = requests.find((item: any) => item.id === requestId);
  assert.ok(view);
  assert.equal(view.status, 'completed');
  assert.equal(view.kind, 'chat');
  assert.deepEqual(view.body, wireBody);
  assert.ok(Array.isArray(view.redactions));
  assert.equal(typeof view.model, 'string');
  assert.equal(typeof view.endpoint, 'string');
  assert.equal(typeof view.createdAt, 'string');
  assert.deepEqual(view.usage, { input: first.usage.prompt_tokens, output: first.usage.completion_tokens });

  const wireBefore = f.wire.length;
  const branch = await f.ok('POST', inspector + '/replay', { requestId, body: wireBody, mode: 'branch' });
  assert.equal(branch.status, 'draft');
  assert.equal(branch.parentId, requestId);
  assert.equal(f.wire.length, wireBefore, 'branch draft never calls the provider');

  const tools = await f.ok('GET', inspector + '/tools' + query({ sessionId }));
  assert.ok(Array.isArray(tools.registered));
  assert.ok(Array.isArray(tools.allowed));
  assert.ok(Array.isArray(tools.exposed));
  assert.ok(Array.isArray(tools.calls));

  const trace = await f.ok('GET', inspector + '/trace' + query({ sessionId }));
  assert.equal(typeof trace.startedAt, 'string');
  assert.ok(Array.isArray(trace.spans) && trace.spans.length > 0);
  assert.equal(typeof trace.hasMore, 'boolean');
  assert.ok(trace.spans.every((span: any) => typeof span.id === 'string' && typeof span.type === 'string' && Number.isFinite(span.startMs)));
  if (trace.nextCursor !== undefined) assert.equal(typeof trace.nextCursor, 'string');

  const context = await f.ok('GET', inspector + '/context' + query({ sessionId }));
  assert.equal(typeof context.windowTokens, 'number');
  assert.equal(typeof context.usedTokens, 'number');
  assert.ok(Array.isArray(context.segments));
  assert.ok(Array.isArray(context.omitted));
  if (context.windowTokensKnown !== undefined) assert.equal(typeof context.windowTokensKnown, 'boolean');
  if (context.usedTokensEstimated !== undefined) assert.equal(typeof context.usedTokensEstimated, 'boolean');

  const recall = await f.ok('GET', inspector + '/recall' + query({ sessionId, sourceId: user.id }));
  assert.equal(recall.sourceId, user.id);
  assert.match(recall.sha, /^[a-f0-9]{64}$/);
  assert.equal(recall.offset, 0);
  assert.match(recall.text, /CONTRACT_BASELINE/);

  const diffs = await f.ok('GET', inspector + '/diffs' + query({ sessionId }));
  assert.deepEqual(diffs, []);

  const unauthenticated = await f.request('GET', inspector + '/prompt' + query({ sessionId }), { auth: false });
  assert.equal(unauthenticated.status, 401);
  assert.ok(!JSON.stringify(unauthenticated.json).includes(user.content));

  await f.fails('GET', inspector + '/unknown' + query({ sessionId }), undefined, 404, 'not_found');
  await f.fails('GET', '/v1/product/unknown-route', undefined, 404, 'not_found');

  for (const route of ['prompt', 'requests', 'tools', 'trace', 'context', 'diffs']) {
    await f.fails('GET', inspector + '/' + route, undefined, 400, 'validation');
  }
  await f.fails('GET', inspector + '/recall' + query({ sessionId }), undefined, 400, 'validation');
  await f.fails('GET', inspector + '/recall' + query({ sessionId, sourceId: 'missing-record' }), undefined, 404, 'not_found');
  await f.fails('GET', inspector + '/recall' + query({ sessionId, sourceId: user.id, offset: -1 }), undefined, 400, 'validation');
  await f.fails('GET', inspector + '/recall' + query({ sessionId, sourceId: user.id, offset: 'abc' }), undefined, 400, 'validation');
  await f.fails('GET', inspector + '/prompt' + query({ sessionId, requestId: 'missing-request' }), undefined, 404, 'not_found');
  await f.fails('GET', inspector + '/trace' + query({ sessionId, cursor: 'NaN' }), undefined, 400, 'validation');
  await f.fails('GET', inspector + '/trace' + query({ sessionId, type: 'bogus' }), undefined, 400, 'validation');

  await f.fails('POST', inspector + '/prompt', { sessionId, partId: 'session:systemPrompt', content: 'x', scope: 'bogus' }, 400, 'validation');
  await f.fails('POST', inspector + '/prompt', { sessionId, partId: 'chat-mode', content: 'x', scope: 'session' }, 403, 'denied');
  await f.fails('POST', inspector + '/prompt', { sessionId, partId: 'not-a-field', content: 'x', scope: 'session' }, 400, 'validation');
  await f.fails('POST', inspector + '/prompt', { sessionId, partId: 'session:systemPrompt', content: 'x', scope: 'session', model: 'evil-model' }, 400, 'validation');
  await f.fails('POST', inspector + '/prompt', { sessionId, partId: 'session:systemPrompt', content: 'x', scope: 'session', provider: { mode: 'live' } }, 400, 'validation');
  await f.fails('POST', inspector + '/replay', { requestId, body: wireBody, mode: 'bogus' }, 400, 'validation');
  await f.fails('POST', inspector + '/replay', { requestId: 'missing-request', body: wireBody, mode: 'branch' }, 404, 'not_found');
  await f.fails('POST', inspector + '/replay', { requestId, body: [], mode: 'branch' }, 400, 'validation');

  for (const [method, route] of [['POST', inspector + '/requests'], ['GET', inspector + '/replay'], ['DELETE', inspector + '/prompt']] as const) {
    const reply = await f.request(method, route, { ...(method === 'POST' ? { body: {} } : {}) });
    assert.ok(reply.status === 404 || reply.status === 405, method + ' ' + route + ' -> ' + reply.status);
    assert.equal(typeof reply.json?.code, 'string');
  }
});

test('Inspector prompt identity/scopes stay versioned and a request-scope edit binds exactly once to the next real Chat request', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const created = await f.session({ title: 'Prompt identity' });
  const sessionId = created.id as string;

  const globalSaved = await f.ok('POST', inspector + '/prompt', { sessionId, partId: 'global:systemPrompt', content: 'GLOBAL_HTTP_V1', scope: 'global' });
  const globalPart = globalSaved.parts.find((part: any) => part.id === 'global:systemPrompt');
  assert.ok(globalPart);
  assert.equal(globalPart.content, 'GLOBAL_HTTP_V1');
  assert.equal(globalPart.version, 1);

  const sessionSaved = await f.ok('POST', inspector + '/prompt', { sessionId, partId: 'session:systemPrompt', content: 'SESSION_HTTP_V1', scope: 'session' });
  const sessionPart = sessionSaved.parts.find((part: any) => part.id === 'session:systemPrompt');
  assert.ok(sessionPart);
  assert.equal(sessionPart.content, 'SESSION_HTTP_V1');
  assert.equal(sessionPart.version, 1);
  assert.equal(sessionPart.effective, true);
  const overriddenGlobal = sessionSaved.parts.find((part: any) => part.id === 'global:systemPrompt');
  assert.ok(overriddenGlobal);
  assert.equal(overriddenGlobal.effective, false);
  assert.equal(overriddenGlobal.overriddenBy, 'session:systemPrompt');

  const first = await f.send(sessionId, 'FIRST_SCOPED_TURN');
  assert.ok((f.wire.at(-1).messages ?? []).some((message: any) => message.content === 'SESSION_HTTP_V1'), 'the session edit reaches the next request');
  assert.ok(!JSON.stringify(f.wire.at(-1)).includes('GLOBAL_HTTP_V1'), 'the overridden global layer is not sent');
  const firstBody = JSON.stringify(first.body);
  const firstPrompt = await f.ok('GET', inspector + '/prompt' + query({ sessionId, requestId: first.id }));
  assert.equal(firstPrompt.parts.find((part: any) => part.id === 'session:systemPrompt').content, 'SESSION_HTTP_V1');
  assert.equal(firstPrompt.parts.find((part: any) => part.id === 'session:systemPrompt').version, 1);

  await f.ok('POST', inspector + '/prompt', { sessionId, partId: 'session:systemPrompt', content: 'SESSION_HTTP_V2', scope: 'session' });
  const oldPrompt = await f.ok('GET', inspector + '/prompt' + query({ sessionId, requestId: first.id }));
  assert.equal(oldPrompt.parts.find((part: any) => part.id === 'session:systemPrompt').content, 'SESSION_HTTP_V1', 'a recorded request keeps its prompt snapshot');
  const current = await f.ok('GET', inspector + '/prompt' + query({ sessionId }));
  assert.equal(current.parts.find((part: any) => part.id === 'session:systemPrompt').content, 'SESSION_HTTP_V2');
  assert.equal(current.parts.find((part: any) => part.id === 'session:systemPrompt').version, 2);
  const afterEdit = await f.ok('GET', inspector + '/requests' + query({ sessionId }));
  assert.equal(JSON.stringify(afterEdit.find((item: any) => item.id === first.id).body), firstBody, 'a recorded body stays byte-identical after a later prompt edit');

  const second = await f.send(sessionId, 'SECOND_SCOPED_TURN');
  assert.ok((f.wire.at(-1).messages ?? []).some((message: any) => message.content === 'SESSION_HTTP_V2'), 'the later version reaches only new requests');
  assert.ok(!JSON.stringify(f.wire.at(-1)).includes('SESSION_HTTP_V1'));
  assert.equal(JSON.stringify((await f.ok('GET', inspector + '/requests' + query({ sessionId }))).find((item: any) => item.id === first.id).body), firstBody);

  const draft = await f.ok('POST', inspector + '/prompt', { sessionId, partId: 'request:systemPrompt', content: 'ONCE_HTTP_OVERRIDE', scope: 'request' });
  assert.equal(typeof draft.requestId, 'string');
  assert.ok(Number(draft.pendingEdits) >= 1, JSON.stringify(draft));
  const draftPreview = await f.ok('GET', inspector + '/prompt' + query({ sessionId }));
  const draftPart = draftPreview.parts.find((part: any) => part.id === 'request:systemPrompt');
  assert.ok(draftPart, 'the request-scope draft is inspectable through prompt(session)');
  assert.equal(draftPart.content, 'ONCE_HTTP_OVERRIDE');
  assert.equal(draftPart.effective, true);
  assert.ok(Number(draftPreview.pendingEdits) >= 1);
  const withDraft = await f.ok('GET', inspector + '/requests' + query({ sessionId }));
  const draftRecord = withDraft.find((item: any) => item.id === draft.requestId);
  assert.ok(draftRecord, 'the request-scope draft is inspectable through requests(session)');
  assert.equal(draftRecord.status, 'draft');
  assert.match(JSON.stringify(draftRecord.body), /ONCE_HTTP_OVERRIDE/);

  // Exactly-once consumption even under a concurrent send attempt.
  const wireBefore = f.wire.length;
  const known = new Set(f.harness.store.listRequests({ sessionId, limit: 200 }).requests.map(record => record.id));
  const concurrent = await Promise.all([
    f.request('POST', '/v1/product/chat/send', { body: { sessionId, mode: 'chat', text: 'CONCURRENT_A', modelId: 'default', permission: 'read-only' } }),
    f.request('POST', '/v1/product/chat/send', { body: { sessionId, mode: 'chat', text: 'CONCURRENT_B', modelId: 'default', permission: 'read-only' } }),
  ]);
  assert.ok(concurrent.some(reply => reply.status === 200), JSON.stringify(concurrent.map(reply => reply.status)));
  await f.until(async () => f.harness.store.listRequests({ sessionId, limit: 200 }).requests.filter(record => !known.has(record.id)), (list: any[]) => list.length >= 1 && list.every(record => TERMINAL.has(record.status)), 'concurrent chat requests settle');
  const concurrentWire = f.wire.slice(wireBefore);
  const countOverrides = (bodies: any[]): number => bodies.reduce((total, body) => total + JSON.stringify(body).split('ONCE_HTTP_OVERRIDE').length - 1, 0);
  assert.equal(countOverrides(concurrentWire), 1, 'exactly one dispatched request receives the one-shot edit');

  const followUp = await f.send(sessionId, 'AFTER_ONCE_TURN');
  assert.ok(!JSON.stringify(f.wire.at(-1)).includes('ONCE_HTTP_OVERRIDE'), 'a later request does not re-apply the consumed edit');
  assert.equal(countOverrides(f.wire.slice(wireBefore)), 1);
  const followPrompt = await f.ok('GET', inspector + '/prompt' + query({ sessionId, requestId: followUp.id }));
  assert.ok(!followPrompt.parts.some((part: any) => String(part.content).includes('ONCE_HTTP_OVERRIDE')));
  const settledPreview = await f.ok('GET', inspector + '/prompt' + query({ sessionId }));
  assert.equal(settledPreview.pendingEdits, 0, 'the consumed edit is no longer pending');
  assert.equal(JSON.stringify((await f.ok('GET', inspector + '/requests' + query({ sessionId }))).find((item: any) => item.id === first.id).body), firstBody, 'old requests stay immutable');

  // Prompt-field-only payload: control fields can never be injected into the write path.
  const beforeRejected = (await f.ok('GET', inspector + '/requests' + query({ sessionId }))).length;
  await f.fails('POST', inspector + '/prompt', { sessionId, partId: 'request:systemPrompt', content: 'INJECTED', scope: 'request', model: 'evil-model' }, 400, 'validation');
  await f.fails('POST', inspector + '/prompt', { sessionId, partId: 'request:systemPrompt', content: 'INJECTED', scope: 'request', provider: { mode: 'live', baseUrl: 'https://example.invalid' } }, 400, 'validation');
  await f.fails('POST', inspector + '/prompt', { sessionId, partId: 'request:systemPrompt', content: 'INJECTED', scope: 'request', tools: [{ type: 'function' }] }, 400, 'validation');
  await f.fails('POST', inspector + '/prompt', { sessionId, partId: 'request:tools', content: '[]', scope: 'request' }, 400, 'validation');
  await f.fails('POST', inspector + '/prompt', { sessionId, partId: 'request:systemPrompt', content: 42, scope: 'request' }, 400, 'validation');
  assert.equal((await f.ok('GET', inspector + '/requests' + query({ sessionId }))).length, beforeRejected, 'rejected payloads create no draft or request');
  assert.equal((await f.ok('GET', inspector + '/prompt' + query({ sessionId }))).pendingEdits, 0);
});

test('Inspector requests expose redacted real bodies, keep usage under recordContent=false and still recall canonical records', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const secret = 'fixture-only-value';
  const profile = await f.ok('POST', '/v1/harness/profiles', {
    name: 'HTTP scoped mock',
    provider: { mode: 'mock', maxOutputTokens: 512, contextWindowTokens: 65536 },
    apiKey: secret,
  });
  const created = await f.session({ title: 'Recording', profileId: profile.id });
  const sessionId = created.id as string;
  const longA = 'A'.repeat(11_000);
  const longB = 'B'.repeat(11_000);
  const first = await f.send(sessionId, longA, profile.id);
  // Make omission deliberate; fragmented ingestion no longer produces one long echoed answer.
  for (let index = 0; index < 8; index++) f.harness.store.addMessage(sessionId, { role: 'assistant', content: `Archived context ${index}: ` + 'P'.repeat(3500) });
  const second = await f.send(sessionId, 'SECRET_TURN ' + secret + ' ' + longB, profile.id);

  const views = await f.ok('GET', inspector + '/requests' + query({ sessionId }));
  const view = views.find((item: any) => item.id === second.id);
  assert.ok(view);
  assert.ok(view.redactions.length > 0, 'credential redaction is reported with a real path');
  assert.ok(view.redactions.some((item: string) => item.includes('messages')), view.redactions.join(','));
  assert.ok(!JSON.stringify(view.body).includes(secret), 'the saved body never contains the credential');
  assert.match(JSON.stringify(view.body), /\[credential redacted\]/);
  // A long user turn makes several ingestion requests; match the recorded request identity,
  // not the first wire body containing a preview of the same user text.
  const wireSecond = f.wire.find((body: any) => sha256(JSON.stringify(body)) === second.bodyHash);
  assert.ok(wireSecond);
  assert.deepEqual(view.body, wireSecond, 'the inspector body equals the actual provider wire body');
  assert.equal(view.usage.input, second.usage.prompt_tokens);
  assert.equal(view.usage.output, second.usage.completion_tokens);
  assert.ok(Number.isFinite(view.durationMs));
  const recordedPrompt = await f.ok('GET', inspector + '/prompt' + query({ sessionId, requestId: second.id }));
  assert.ok(!JSON.stringify(recordedPrompt).includes(secret));

  const context = await f.ok('GET', inspector + '/context' + query({ sessionId }));
  assert.ok(context.omitted.length > 0, 'the working projection omits an older long message');
  const firstUser = f.harness.store.allMessages(sessionId).find(message => message.role === 'user' && message.content === longA);
  assert.ok(firstUser);
  const omitted = context.omitted.find((item: any) => item.sourceId === firstUser.id);
  assert.ok(omitted);
  const canonical = f.harness.store.memory(sessionId).read({ id: firstUser.id, field: 'record', length: 12_000 });
  assert.equal(omitted.sha, canonical.sha256);
  assert.equal(canonical.sha256, sha256(canonical.text));
  const omittedRecall = await f.ok('GET', inspector + '/recall' + query({ sessionId, sourceId: firstUser.id }));
  assert.equal(omittedRecall.sha, canonical.sha256);
  assert.equal(omittedRecall.text.length, 6_000);

  await f.ok('POST', '/v1/harness/settings', { recordContent: false });
  const hidden = await f.send(sessionId, 'HIDDEN_BODY_TURN', profile.id);
  const hiddenView = (await f.ok('GET', inspector + '/requests' + query({ sessionId }))).find((item: any) => item.id === hidden.id);
  assert.ok(hiddenView);
  assert.equal(hiddenView.body, null);
  assert.deepEqual(hiddenView.redactions, []);
  assert.equal(hiddenView.response, undefined);
  assert.ok(Number.isFinite(hiddenView.durationMs));
  assert.deepEqual(hiddenView.usage, { input: hidden.usage.prompt_tokens, output: hidden.usage.completion_tokens }, 'usage is real metadata even when content is not recorded');
  const hiddenPrompt = await f.ok('GET', inspector + '/prompt' + query({ sessionId, requestId: hidden.id }));
  assert.deepEqual(hiddenPrompt.parts, []);
  assert.equal(hiddenPrompt.totalTokens, 0);
  const hiddenContext = await f.ok('GET', inspector + '/context' + query({ sessionId }));
  assert.deepEqual(hiddenContext.segments, []);
  assert.deepEqual(hiddenContext.omitted, []);
  assert.equal(hiddenContext.usedTokens, hiddenView.usage.input, 'usage stays real without a recorded body');

  const hiddenUser = f.harness.store.allMessages(sessionId).find(message => message.role === 'user' && message.content === 'HIDDEN_BODY_TURN');
  assert.ok(hiddenUser);
  const hiddenCanonical = f.harness.store.memory(sessionId).read({ id: hiddenUser.id, field: 'record', length: 12_000 });
  const hiddenRecall = await f.ok('GET', inspector + '/recall' + query({ sessionId, sourceId: hiddenUser.id }));
  assert.equal(hiddenRecall.sha, hiddenCanonical.sha256);
  assert.equal(hiddenRecall.text, 'HIDDEN_BODY_TURN');
  const omittedAfter = await f.ok('GET', inspector + '/recall' + query({ sessionId, sourceId: firstUser.id }));
  assert.equal(omittedAfter.sha, canonical.sha256, 'an omitted canonical record stays readable when content recording is off');
});

test('Inspector recall keeps the promoted Chat origin immutable and adds the Work task own canonical message', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const created = await f.session({ title: 'Workbench origin', workspace: f.workspace });
  const sessionId = created.id as string;
  const request = await f.send(sessionId, 'ORIGIN_CHAT_MESSAGE');
  const origin = f.harness.store.allMessages(sessionId).find(message => message.role === 'user');
  assert.ok(origin);
  assert.equal(origin.content, 'ORIGIN_CHAT_MESSAGE');
  const originSha = f.harness.store.memory(sessionId).read({ id: origin.id, field: 'record', length: 12_000 }).sha256;

  await f.runner.stop();
  const promoted = await f.ok('POST', '/v1/product/sessions/' + encodeURIComponent(sessionId) + '/promote', { objective: 'Preserve the origin record', acceptance: ['origin stays readable'] });
  const taskId = promoted.id as string;
  assert.equal(promoted.mode, 'cowork');
  assert.ok(f.kernel.getTask(taskId), 'promotion creates a real Kernel task');

  const own = f.kernel.addMessage(taskId, 'user', 'TASK_OWN_CANONICAL_MESSAGE');
  const ownSha = f.kernel.memory(taskId, 'main').read({ id: own.id, field: 'record', length: 12_000 }).sha256;

  const originRecall = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: origin.id }));
  assert.equal(originRecall.sha, originSha, 'the origin record keeps its canonical Chat SHA');
  assert.equal(originRecall.offset, 0);
  assert.equal(originRecall.text, origin.content);

  const ownRecall = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: own.id }));
  assert.equal(ownRecall.sha, ownSha, 'the task own message uses its canonical Kernel SHA');
  assert.equal(ownRecall.offset, 0);
  assert.equal(ownRecall.text, 'TASK_OWN_CANONICAL_MESSAGE');

  const project = await f.ok('POST', '/v1/product/workspace/projects', { path: f.workspace });
  const other = await f.ok('POST', '/v1/product/chat/send', { mode: 'cowork', text: 'UNRELATED_WORK_TASK', modelId: 'default', permission: 'read-only', projectId: project.id });
  const otherTaskId = other.sessionId as string;
  assert.ok(f.kernel.getTask(otherTaskId));
  await f.fails('GET', inspector + '/recall' + query({ sessionId: otherTaskId, sourceId: origin.id }), undefined, 404, 'not_found');
  await f.fails('GET', inspector + '/recall' + query({ sessionId: otherTaskId, sourceId: own.id }), undefined, 404, 'not_found');

  f.harness.store.updateMessageContent(sessionId, origin.id, 'MUTATED_ORIGIN_TEXT');
  const afterEdit = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: origin.id }));
  assert.equal(afterEdit.text, origin.content, 'editing the source Chat cannot rewrite the promoted origin');
  assert.equal(afterEdit.sha, originSha);
  const liveChat = await f.ok('GET', inspector + '/recall' + query({ sessionId, sourceId: origin.id }));
  assert.equal(liveChat.text, 'MUTATED_ORIGIN_TEXT');
  assert.notEqual(liveChat.sha, originSha);

  f.harness.store.deleteSession(sessionId);
  const afterDelete = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: origin.id }));
  assert.equal(afterDelete.text, origin.content, 'deleting the source Chat cannot remove the promoted origin');
  assert.equal(afterDelete.sha, originSha);

  await f.restart();
  const originAfterRestart = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: origin.id }));
  assert.equal(originAfterRestart.sha, originSha);
  assert.equal(originAfterRestart.text, origin.content);
  const ownAfterRestart = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: own.id }));
  assert.equal(ownAfterRestart.sha, ownSha);
  assert.equal(ownAfterRestart.text, 'TASK_OWN_CANONICAL_MESSAGE');
});

test('Inspector replay branches inertly and sends exactly one model request without replaying tool effects', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const created = await f.session({ title: 'Replay HTTP' });
  const sessionId = created.id as string;
  const origin = await f.send(sessionId, 'REPLAY_ORIGIN_HTTP');
  const requestId = origin.id as string;
  const wireBody = origin.body;
  const messagesBefore = f.harness.store.messageCount(sessionId);
  const requestsBefore = f.harness.store.listRequests({ sessionId }).requests.length;
  const wireBefore = f.wire.length;
  const toolsBefore = await f.ok('GET', inspector + '/tools' + query({ sessionId }));
  const approvalsBefore = await f.ok('GET', '/v1/product/approvals' + query({ sessionId }));
  assert.deepEqual(await f.ok('GET', inspector + '/diffs' + query({ sessionId })), []);

  const branch = await f.ok('POST', inspector + '/replay', { requestId, body: wireBody, mode: 'branch' });
  assert.equal(branch.status, 'draft');
  assert.equal(branch.parentId, requestId);
  assert.notEqual(branch.id, requestId);
  assert.deepEqual(branch.body, wireBody);
  assert.equal(f.wire.length, wireBefore, 'branch never calls the provider');
  assert.equal(f.harness.store.messageCount(sessionId), messagesBefore, 'branch does not write conversation messages');
  assert.equal(f.harness.store.listRequests({ sessionId }).requests.length, requestsBefore + 1);

  const sent = await f.ok('POST', inspector + '/replay', { requestId, body: wireBody, mode: 'send' });
  assert.equal(sent.status, 'completed');
  assert.equal(sent.parentId, requestId);
  assert.notEqual(sent.id, requestId);
  assert.equal(f.wire.length, wireBefore + 1, 'send dispatches exactly one provider request');
  assert.deepEqual(f.wire.at(-1), wireBody);
  assert.equal(f.harness.store.messageCount(sessionId), messagesBefore, 'replay send does not rewrite the source conversation');
  assert.equal((await f.ok('GET', inspector + '/tools' + query({ sessionId }))).calls.length, toolsBefore.calls.length, 'no tool call is replayed');
  assert.deepEqual(await f.ok('GET', inspector + '/diffs' + query({ sessionId })), [], 'no applied receipt is fabricated');
  assert.deepEqual(await f.ok('GET', '/v1/product/approvals' + query({ sessionId })), approvalsBefore, 'no approval is replayed');

  const original = (await f.ok('GET', inspector + '/requests' + query({ sessionId }))).find((item: any) => item.id === requestId);
  assert.ok(original);
  assert.equal(original.status, 'completed');
  assert.deepEqual(original.body, wireBody);
  assert.equal(f.harness.store.listRequests({ sessionId }).requests.length, requestsBefore + 2);

  await f.fails('POST', inspector + '/replay', { requestId, body: wireBody, mode: 'bogus' }, 400, 'validation');
  await f.fails('POST', inspector + '/replay', { requestId: 'missing-request', body: wireBody, mode: 'branch' }, 404, 'not_found');
  await f.fails('POST', inspector + '/replay', { requestId, body: [], mode: 'branch' }, 400, 'validation');
});

test('Inspector trace supports bounded filtered pages with a strictly forward native cursor', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const created = await f.session({ title: 'Trace paging' });
  const sessionId = created.id as string;
  for (let index = 0; index < 250; index++) f.harness.store.trace({ sessionId, type: 'task.note', status: 'completed', payload: { sequence: index } });

  const pageOne = await f.ok('GET', inspector + '/trace' + query({ sessionId, type: 'task' }));
  assert.equal(pageOne.spans.length, 200, 'one page is bounded to 200 spans');
  assert.equal(pageOne.hasMore, true);
  assert.match(String(pageOne.nextCursor), /^\d+$/);
  const pageTwo = await f.ok('GET', inspector + '/trace' + query({ sessionId, type: 'task', cursor: pageOne.nextCursor }));
  assert.equal(pageTwo.spans.length, 50);
  assert.equal(pageTwo.hasMore, false);
  const spanNumber = (span: { id: string }): number => Number(span.id.slice('trace-'.length));
  const ids = [...pageOne.spans, ...pageTwo.spans].map((span: any) => span.id);
  assert.equal(new Set(ids).size, 250, 'pages contain no duplicate or missing spans');
  assert.ok(spanNumber(pageTwo.spans[0]) > spanNumber(pageOne.spans.at(-1)!), 'cursor pages strictly forward');

  const second = await f.session({ title: 'Trace filtered' });
  const filteredId = second.id as string;
  for (let index = 0; index < 1005; index++) f.harness.store.trace({ sessionId: filteredId, type: 'task.note', status: 'completed', payload: { sequence: index } });
  const emptyPage = await f.ok('GET', inspector + '/trace' + query({ sessionId: filteredId, type: 'model' }));
  assert.equal(emptyPage.spans.length, 0);
  assert.equal(emptyPage.hasMore, true, 'more scanned events remain even though this page has zero spans');
  assert.match(String(emptyPage.nextCursor), /^\d+$/, 'a filtered-out page still reports the native cursor');
  const cursor = Number(emptyPage.nextCursor);
  const injected = f.harness.store.trace({ sessionId: filteredId, type: 'request.completed', status: 'completed', requestId: 'req-injected', payload: { model: 'mock' } });
  assert.ok(injected.id > cursor);
  const nextPage = await f.ok('GET', inspector + '/trace' + query({ sessionId: filteredId, type: 'model', cursor: emptyPage.nextCursor }));
  assert.equal(nextPage.spans.length, 1);
  assert.equal(nextPage.spans[0].id, 'trace-' + injected.id, 'the next page starts strictly after the cursor');
  assert.equal(nextPage.spans[0].type, 'model');
  assert.equal(nextPage.hasMore, false);
});

test('Inspector context reports truthful usage/window flags and recall paginates at the 6000-character boundary', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const known = await f.ok('POST', '/v1/product/models/save', { name: 'HTTP known window', provider: 'HTTP mock', model: 'mock-http-known', mode: 'mock', contextWindow: 65_536 });
  const knownSession = await f.session({ title: 'Known window', profileId: known.id });
  const knownRequest = await f.send(knownSession.id, 'KNOWN_WINDOW_TURN', known.id);
  const knownView = (await f.ok('GET', inspector + '/requests' + query({ sessionId: knownSession.id }))).find((item: any) => item.id === knownRequest.id);
  assert.ok(knownView);
  const knownContext = await f.ok('GET', inspector + '/context' + query({ sessionId: knownSession.id }));
  assert.equal(knownContext.windowTokens, 65_536);
  assert.equal(knownContext.windowTokensKnown, true);
  assert.equal(knownContext.usedTokens, knownView.usage.input, 'usedTokens is the recorded provider usage, never a fake estimate');
  assert.equal(knownContext.usedTokensEstimated, false);
  assert.ok(knownContext.segments.length > 0);

  const unknown = await f.ok('POST', '/v1/product/models/save', { name: 'HTTP unknown window', provider: 'HTTP mock', model: 'mock-http-unknown', mode: 'mock' });
  const unknownSession = await f.session({ title: 'Unknown window', profileId: unknown.id });
  const unknownRequest = await f.send(unknownSession.id, 'UNKNOWN_WINDOW_TURN', unknown.id);
  const unknownView = (await f.ok('GET', inspector + '/requests' + query({ sessionId: unknownSession.id }))).find((item: any) => item.id === unknownRequest.id);
  assert.ok(unknownView);
  const unknownContext = await f.ok('GET', inspector + '/context' + query({ sessionId: unknownSession.id }));
  assert.equal(unknownContext.windowTokens, 0);
  assert.equal(unknownContext.windowTokensKnown, false);
  assert.ok(!(unknownContext.windowTokensKnown === true && unknownContext.windowTokens === 0), 'an unknown window cannot be both zero and known');
  assert.equal(unknownContext.usedTokens, unknownView.usage.input);
  assert.equal(unknownContext.usedTokensEstimated, false);

  const sessionId = unknownSession.id as string;
  const boundary = f.harness.store.addMessage(sessionId, { role: 'user', content: 'C'.repeat(6001) });
  const exact = f.harness.store.addMessage(sessionId, { role: 'user', content: 'D'.repeat(6000) });
  const boundarySha = f.harness.store.memory(sessionId).read({ id: boundary.id, field: 'record', length: 12_000 }).sha256;
  const exactSha = f.harness.store.memory(sessionId).read({ id: exact.id, field: 'record', length: 12_000 }).sha256;

  const firstPage = await f.ok('GET', inspector + '/recall' + query({ sessionId, sourceId: boundary.id }));
  assert.equal(firstPage.sha, boundarySha);
  assert.equal(firstPage.offset, 0);
  assert.equal(firstPage.text.length, 6_000);
  assert.equal(firstPage.nextOffset, 6_000);
  const secondPage = await f.ok('GET', inspector + '/recall' + query({ sessionId, sourceId: boundary.id, offset: firstPage.nextOffset }));
  assert.equal(secondPage.sha, boundarySha, 'pagination keeps the canonical SHA');
  assert.equal(secondPage.offset, 6_000);
  assert.equal(secondPage.text.length, 1);
  assert.equal(secondPage.nextOffset, undefined);
  const exactPage = await f.ok('GET', inspector + '/recall' + query({ sessionId, sourceId: exact.id }));
  assert.equal(exactPage.sha, exactSha);
  assert.equal(exactPage.text.length, 6_000);
  assert.equal(exactPage.nextOffset, undefined, 'a 6000-character record fits one page exactly');
});
