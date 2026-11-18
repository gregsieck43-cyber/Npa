import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import { ProductInspector, type InspectorDomain } from '../src/product/inspector.js';
import { ProductError, type ProductRuntime } from '../src/product/shared.js';
import { ProductStore } from '../src/product/store.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';

/**
 * 真实后端上的产品 Inspector 适配器验收。
 *
 * 所有数据都来自真实 startBackend + mock provider + HarnessStore/Kernel/archive：
 * 不 stub 内部方法，不直接写 Harness/Kernel 表来伪造“已应用”，不访问公网。
 */

type Backend = Awaited<ReturnType<typeof startBackend>>;

interface Fixture {
  readonly owned: string;
  readonly workspace: string;
  readonly wire: any[];
  readonly backend: Backend;
  readonly store: ProductStore;
  readonly inspector: InspectorDomain;
  call(method: string, route: string, input?: unknown, status?: number): Promise<any>;
  until(read: () => Promise<any>, ready: (value: any) => boolean): Promise<any>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

async function fixture(t: import('node:test').TestContext, options: MockProviderOptions = {}): Promise<Fixture> {
  const root = path.resolve(process.env.TEMP ?? '.tmp');
  mkdirSync(root, { recursive: true });
  const owned = mkdtempSync(path.join(root, 'product-inspector-'));
  const workspace = path.join(owned, 'workspace');
  mkdirSync(workspace);
  const wire: any[] = [];
  const settings = {
    dataDir: path.join(owned, 'data'),
    projectRoot: process.cwd(),
    mockOptions: { ...options, trace: (body: any) => wire.push(body) },
  };
  let backend: Backend = await startBackend(settings);
  let store = new ProductStore(settings.dataDir);
  const runtime = (): ProductRuntime => ({
    services: backend.services,
    harness: backend.services.harness!,
    store,
    append: () => undefined,
  });
  let inspector = ProductInspector(runtime());
  const call = async (method: string, route: string, input?: unknown, status = 200): Promise<any> => {
    const response = await fetch(`http://127.0.0.1:${backend.port}${route.startsWith('/v1') ? route : '/v1/harness' + route}`, {
      method,
      headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const text = await response.text();
    const value = text ? JSON.parse(text) : undefined;
    assert.equal(response.status, status, `${method} ${route} -> ${response.status}: ${text.slice(0, 500)}`);
    return value;
  };
  const until = async (read: () => Promise<any>, ready: (value: any) => boolean): Promise<any> => {
    const deadline = performance.now() + 20000;
    let value: any;
    do {
      value = await read();
      if (ready(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 30));
    } while (performance.now() < deadline);
    assert.fail(`Did not settle: ${JSON.stringify(value).slice(0, 1000)}`);
  };
  let closed = false;
  const f: Fixture = {
    owned, workspace, wire,
    get backend() { return backend; },
    get store() { return store; },
    get inspector() { return inspector; },
    call, until,
    async restart() {
      if (!closed) { await backend.close(); store.close(); closed = true; }
      backend = await startBackend(settings);
      store = new ProductStore(settings.dataDir);
      inspector = ProductInspector(runtime());
      closed = false;
    },
    async close() {
      if (closed) return;
      closed = true;
      await backend.close();
      store.close();
    },
  };
  t.after(async () => {
    await f.close();
    assert.equal(path.dirname(owned), root);
    rmSync(owned, { recursive: true, force: true });
  });
  return f;
}

async function sendChat(f: Fixture, sessionId: string, content: string): Promise<any> {
  const started = await f.call('POST', '/chat', { sessionId, content });
  return f.until(() => {
    const latest = f.backend.services.harness!.store.latestRequest(sessionId, 'chat');
    return f.call('GET', `/requests/${latest?.id ?? started.requestId}`);
  }, (record: any) => ['completed', 'failed', 'cancelled'].includes(record.status) && !f.backend.services.harness!.chat.busy(sessionId));
}

async function createTask(f: Fixture, objective: string): Promise<string> {
  const task = await f.call('POST', '/v1/commands', {
    commandId: randomUUID(),
    type: 'create_task',
    parameters: { workspace: f.workspace, objective, maxModelCalls: 10 },
  });
  return String(task.taskId);
}

async function grantPending(f: Fixture, taskId: string): Promise<void> {
  const snapshot = await f.until(
    () => f.call('GET', `/v1/snapshot?taskId=${taskId}`),
    (value: any) => value.selectedTask?.status === 'waiting_approval' && Array.isArray(value.intents) && value.intents.length > 0,
  );
  const intent = (Array.isArray(snapshot.intents) ? snapshot.intents : []).find((item: any) => item?.state === 'prepared' && item?.name === 'write_file') ?? snapshot.intents[0];
  await f.call('POST', '/v1/commands', {
    commandId: randomUUID(),
    type: 'grant',
    taskId,
    expectedRevision: snapshot.selectedTask.revision,
    parameters: { intentId: intent.id, digest: intent.digest, generation: intent.generation, policyEpoch: intent.policyEpoch },
  });
}

test('Inspector prompt edits are versioned, keep old request snapshots, and request overrides apply to exactly one next request', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const session = await f.call('POST', '/sessions', { title: 'Prompt scopes' });
  const sessionId = String(session.id);
  await f.call('POST', '/prompts', { scope: 'global', systemPrompt: 'GLOBAL_V1' });
  await f.call('POST', '/prompts', { scope: 'session', scopeId: sessionId, systemPrompt: 'SESSION_V1' });

  const first = await sendChat(f, sessionId, 'first message');
  assert.equal(first.status, 'completed');
  const snapshot = await f.inspector.prompt(sessionId, first.id);
  assert.equal(snapshot.requestId, first.id);
  const sessionPart = snapshot.parts.find(part => part.id === 'session:systemPrompt');
  assert.ok(sessionPart, 'session prompt part is present in the real snapshot');
  assert.equal(sessionPart.content, 'SESSION_V1');
  assert.equal(sessionPart.effective, true);
  assert.equal(sessionPart.editable, true);
  assert.equal(sessionPart.scope, 'session');
  assert.equal(sessionPart.tokens, Math.ceil('SESSION_V1'.length / 3));
  const globalPart = snapshot.parts.find(part => part.id === 'global:systemPrompt');
  assert.ok(globalPart);
  assert.equal(globalPart.effective, false);
  assert.equal(globalPart.overriddenBy, 'session:systemPrompt');
  const fixed = snapshot.parts.find(part => part.id === 'chat-mode');
  assert.ok(fixed, 'Harness fixed prompt is visible');
  assert.equal(fixed.editable, false);
  assert.equal(fixed.merge, 'locked');
  assert.ok(snapshot.totalTokens > 0, 'recorded usage gives an exact total');

  await assert.rejects(
    f.inspector.savePrompt(sessionId, 'chat-mode', 'not allowed', 'session'),
    (error: unknown) => error instanceof ProductError && error.code === 'denied',
  );

  const edited = await f.inspector.savePrompt(sessionId, 'session:systemPrompt', 'SESSION_V2', 'session');
  const editedSession = edited.parts.find(part => part.id === 'session:systemPrompt');
  assert.equal(editedSession?.content, 'SESSION_V2');
  assert.equal(editedSession?.version, 2);

  const oldSnapshot = await f.inspector.prompt(sessionId, first.id);
  assert.equal(oldSnapshot.parts.find(part => part.id === 'session:systemPrompt')?.content, 'SESSION_V1', 'old requests keep their snapshot');

  const compiled = await f.backend.services.harness!.chat.preview(sessionId);
  const effectiveText = compiled.sources.filter(source => source.effective !== false).map(source => source.content);
  assert.ok(effectiveText.includes('SESSION_V2'), 'later assembly uses the edited version');
  assert.ok(!effectiveText.includes('SESSION_V1'));

  const draft = await f.inspector.savePrompt(sessionId, 'request:systemPrompt', 'ONCE_ONLY', 'request');
  assert.ok(draft.requestId, 'request-scope edit creates an inspectable draft');
  assert.equal(draft.pendingEdits, 1);
  const draftRecord = await f.call('GET', `/requests/${draft.requestId}`);
  assert.equal(draftRecord.status, 'draft');
  assert.equal(draftRecord.kind, 'studio');
  assert.match(JSON.stringify(draftRecord.sources), /ONCE_ONLY/);

  const second = await sendChat(f, sessionId, 'second message');
  assert.equal(second.status, 'completed');
  assert.ok(JSON.stringify(second.sources).includes('ONCE_ONLY'), 'the next real Chat request consumes the request-scope edit');
  assert.ok(JSON.stringify(f.wire.at(-1)).includes('ONCE_ONLY'), 'the one-shot edit reaches the actual provider wire body');
  const secondView = await f.inspector.prompt(sessionId, second.id);
  const appliedOnce = secondView.parts.find(part => part.id === 'request:systemPrompt');
  assert.ok(appliedOnce, 'the consumed request edit is part of that request snapshot');
  assert.equal(appliedOnce.content, 'ONCE_ONLY');
  assert.equal(appliedOnce.effective, true);
  assert.equal(appliedOnce.scope, 'request');
  assert.equal(secondView.pendingEdits, 0, 'a consumed edit is no longer pending');

  const third = await sendChat(f, sessionId, 'third message');
  assert.equal(third.status, 'completed');
  assert.ok(!JSON.stringify(third.sources).includes('ONCE_ONLY'), 'the override is consumed exactly once');
  assert.ok(!JSON.stringify(f.wire.at(-1)).includes('ONCE_ONLY'));
  const thirdView = await f.inspector.prompt(sessionId, third.id);
  assert.ok(!thirdView.parts.some(part => part.id === 'request:systemPrompt'), 'the next request has no request-scope part');
  assert.ok(!thirdView.parts.some(part => part.content === 'ONCE_ONLY'));
  assert.equal(thirdView.pendingEdits, 0);

  const oldAgain = await f.inspector.prompt(sessionId, first.id);
  assert.equal(oldAgain.parts.find(part => part.id === 'session:systemPrompt')?.content, 'SESSION_V1', 'old requests stay immutable after a one-shot edit');
  assert.ok(!oldAgain.parts.some(part => part.content === 'ONCE_ONLY'));
});

test('Inspector requests return the real redacted Body and respect disabled content recording', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const secret = 'sk-inspector-secret-value';
  const profile = await f.call('POST', '/profiles', {
    name: 'Scoped mock with credential',
    provider: { mode: 'mock', maxOutputTokens: 512, contextWindowTokens: 65536 },
    apiKey: secret,
  });
  const session = await f.call('POST', '/sessions', { title: 'Requests', profileId: profile.id });
  const sessionId = String(session.id);
  const record = await sendChat(f, sessionId, `inspect the body ${secret}`);
  assert.equal(record.status, 'completed');

  const views = await f.inspector.requests(sessionId);
  const view = views.find(item => item.id === record.id);
  assert.ok(view);
  assert.equal(view.kind, 'chat');
  assert.equal(view.status, 'completed');
  assert.deepEqual(view.body, f.wire[0], 'recorded Body equals the actual provider wire body');
  assert.ok(view.redactions.length > 0, 'credential redaction is reported with a real path');
  assert.ok(view.redactions.some(item => item.includes('messages')), view.redactions.join(','));
  assert.ok(!JSON.stringify(view.body).includes(secret), 'the saved Body never contains the credential');
  assert.ok(!JSON.stringify(f.wire[0]).includes(secret));
  assert.equal(view.model, (record.body as any).model);
  assert.match(view.endpoint, /chat\/completions$/);
  assert.equal(view.createdAt, record.createdAt);
  assert.equal(view.parentId, undefined);
  assert.equal(view.branchLabel, undefined);
  assert.ok((view.durationMs ?? 0) >= 0);
  assert.deepEqual(view.usage, { input: record.usage.prompt_tokens, output: record.usage.completion_tokens });
  assert.match(view.response?.content ?? '', /Mock response:/);
  assert.equal(view.response?.finishReason, 'stop');

  await f.call('POST', '/settings', { recordContent: false });
  const hidden = await sendChat(f, sessionId, 'hidden body');
  const hiddenView = (await f.inspector.requests(sessionId)).find(item => item.id === hidden.id);
  assert.ok(hiddenView);
  assert.equal(hiddenView.body, null);
  assert.deepEqual(hiddenView.redactions, []);
  assert.equal(hiddenView.response, undefined);
  assert.deepEqual(hiddenView.usage, { input: hidden.usage.prompt_tokens, output: hidden.usage.completion_tokens }, 'usage is metadata and stays real even when content is not recorded');
  assert.ok(hiddenView.durationMs !== undefined);
  const hiddenPrompt = await f.inspector.prompt(sessionId, hidden.id);
  assert.equal(hiddenPrompt.requestId, hidden.id);
  assert.deepEqual(hiddenPrompt.parts, []);
  assert.equal(hiddenPrompt.totalTokens, 0);
  const hiddenContext = await f.inspector.context(sessionId);
  assert.deepEqual(hiddenContext.segments, []);
  assert.deepEqual(hiddenContext.omitted, []);
});

test('Inspector replay branches without sending and sends exactly one bounded request without replaying tools', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const session = await f.call('POST', '/sessions', { title: 'Replay' });
  const sessionId = String(session.id);
  const first = await sendChat(f, sessionId, 'replay me');
  const wireBefore = f.wire.length;
  const messagesBefore = (await f.call('GET', `/sessions/${sessionId}`)).messages.length;

  const branch = await f.inspector.replay(first.id, first.body, 'branch');
  assert.equal(branch.status, 'draft');
  assert.equal(branch.parentId, first.id);
  assert.equal(branch.branchLabel, '分叉草稿');
  assert.deepEqual(branch.body, first.body);
  assert.equal(f.wire.length, wireBefore, 'branch never calls the provider');
  assert.equal((await f.call('GET', `/sessions/${sessionId}`)).messages.length, messagesBefore, 'branch does not write session messages');
  assert.equal((await f.inspector.tools(sessionId)).calls.length, 0);

  const sent = await f.inspector.replay(first.id, first.body, 'send');
  assert.equal(sent.status, 'completed', JSON.stringify(sent.error));
  assert.equal(sent.parentId, first.id);
  assert.equal(sent.branchLabel, '重放');
  assert.deepEqual(sent.body, first.body);
  assert.equal(f.wire.length, wireBefore + 1, 'send dispatches exactly one provider request');
  assert.deepEqual(f.wire.at(-1), first.body);
  assert.equal((await f.call('GET', `/sessions/${sessionId}`)).messages.length, messagesBefore, 'replay send does not rewrite the source conversation');
  assert.equal((await f.inspector.tools(sessionId)).calls.length, 0, 'no tool execution is replayed');

  await assert.rejects(
    f.inspector.replay(first.id, first.body, 'bogus' as any),
    (error: unknown) => error instanceof ProductError && error.code === 'validation',
  );
  await assert.rejects(
    f.inspector.replay(first.id, [] as any, 'branch'),
    (error: unknown) => error instanceof ProductError && error.code === 'validation',
  );
  await assert.rejects(
    f.inspector.replay('missing-request', first.body, 'branch'),
    (error: unknown) => error instanceof ProductError && error.code === 'not_found',
  );
});

test('Inspector tools expose real registration/exposure/calls, not the native capability ceiling', { timeout: 60000 }, async t => {
  const f = await fixture(t, {
    responder: body => body.messages?.some((message: any) => message.role === 'tool')
      ? { content: 'Observed the denial without an effect.' }
      : { content: '', toolCalls: [{ id: 'forged-inspector-write', name: 'write_file', arguments: { path: 'inspector-denied.txt', content: 'MUST NOT EXIST' } }] },
  });
  const session = await f.call('POST', '/sessions', { title: 'Tools', workspace: f.workspace, capabilities: { tools: true, web: true } });
  const sessionId = String(session.id);
  const started = await sendChat(f, sessionId, 'Try a write');
  assert.equal(started.status, 'completed');

  const native = await f.call('GET', `/tools?sessionId=${sessionId}`);
  const nativeAllowed = (Array.isArray(native.allowed) ? native.allowed : []).map((tool: any) => tool?.function?.name ?? tool?.name);
  assert.ok(nativeAllowed.includes('write_file'), 'native inspectTools still over-advertises write tools in Chat');
  const inventory = await f.until(
    () => f.inspector.tools(sessionId),
    (value: any) => value.calls.some((call: any) => call.name === 'write_file' && call.receivedByRequestId),
  );
  assert.ok(inventory.registered.some((tool: any) => tool.name === 'write_file'));
  assert.ok(inventory.registered.some((tool: any) => tool.name === 'read_file'));
  assert.ok(inventory.registered.some((tool: any) => tool.name === 'search_history'));
  const write = inventory.registered.find((tool: any) => tool.name === 'write_file');
  assert.equal(write.capability, 'write');
  assert.equal(write.source, 'builtin');
  assert.ok(inventory.allowed.includes('read_file'));
  assert.ok(inventory.allowed.includes('list_files'));
  assert.ok(inventory.allowed.includes('search_history'));
  assert.ok(inventory.allowed.includes('web_search'));
  assert.ok(!inventory.allowed.includes('write_file'), 'Chat never allows write_file');
  assert.ok(!inventory.allowed.includes('run_shell'));
  assert.ok(!inventory.allowed.includes('run_command'));
  assert.ok(inventory.exposed.length > 0, 'exposed comes from the real request Body');
  assert.ok(!inventory.exposed.includes('write_file'));
  const latestId = (await f.inspector.requests(sessionId))[0]!.id;
  const latestBodyTools = (await f.call('GET', `/requests/${latestId}`)).body.tools.map((tool: any) => tool.function.name);
  assert.deepEqual(inventory.exposed, latestBodyTools);

  const call = inventory.calls.find((item: any) => item.name === 'write_file');
  assert.ok(call);
  assert.equal(call.status, 'failed');
  assert.equal(call.error?.stage, 'permission');
  assert.ok(call.requestId);
  assert.ok(call.receivedByRequestId);
  assert.equal(call.args.path, 'inspector-denied.txt');
  assert.equal(call.result, undefined, 'a denied call has no fabricated result');
  assert.equal(call.source, 'builtin');
  assert.equal(call.risk, 'high');
  assert.equal(existsSync(path.join(f.workspace, 'inspector-denied.txt')), false);
  assert.deepEqual(await f.inspector.diffs(sessionId), [], 'denied writes are never presented as applied diffs');
});

test('Inspector trace uses real relative times, type/text filters and native cursor paging', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const session = await f.call('POST', '/sessions', { title: 'Trace' });
  const sessionId = String(session.id);
  const request = await sendChat(f, sessionId, 'trace me');
  assert.equal(request.status, 'completed');

  const all = await f.inspector.trace(sessionId);
  assert.equal(all.startedAt, session.createdAt);
  assert.ok(all.spans.length > 0);
  assert.ok(all.spans.some(span => span.type === 'model' && span.requestId === request.id));
  assert.ok(all.spans.every(span => span.id.startsWith('trace-')));
  assert.ok(all.spans.every(span => Number.isFinite(span.startMs) && span.startMs >= 0 && span.startMs < 600000));
  assert.ok(all.spans.every(span => Number.isFinite(span.durationMs) && span.durationMs >= 0));

  const models = await f.inspector.trace(sessionId, { type: 'model' });
  assert.ok(models.spans.length > 0);
  assert.ok(models.spans.every(span => span.type === 'model'));
  const byRequest = await f.inspector.trace(sessionId, { text: request.id });
  assert.ok(byRequest.spans.length > 0);
  assert.ok(byRequest.spans.every(span => span.requestId === request.id));
  const none = await f.inspector.trace(sessionId, { text: 'text-that-does-not-exist' });
  assert.equal(none.spans.length, 0);

  await assert.rejects(
    f.inspector.trace(sessionId, { cursor: 'not-a-number' }),
    (error: unknown) => error instanceof ProductError && error.code === 'validation',
  );
  await assert.rejects(
    f.inspector.trace(sessionId, { type: 'bogus' }),
    (error: unknown) => error instanceof ProductError && error.code === 'validation',
  );

  const store = f.backend.services.harness!.store;
  for (let index = 0; index < 250; index++) store.trace({ sessionId, type: 'task.note', status: 'completed', payload: { sequence: index } });
  const pageOne = await f.inspector.trace(sessionId, { type: 'task' });
  assert.equal(pageOne.spans.length, 200, 'one Inspector page is bounded to 200 spans');
  assert.equal(pageOne.hasMore, true);
  const cursor = pageOne.spans.at(-1)!.id.replace('trace-', '');
  const pageTwo = await f.inspector.trace(sessionId, { type: 'task', cursor });
  assert.equal(pageTwo.spans.length, 50);
  assert.equal(pageTwo.hasMore, false);
  const spanNumber = (span: { id: string }) => Number(span.id.slice('trace-'.length));
  assert.ok(spanNumber(pageTwo.spans[0]!) > spanNumber(pageOne.spans.at(-1)!), 'cursor pages strictly forward');
  assert.equal(new Set([...pageOne.spans, ...pageTwo.spans].map(span => span.id)).size, 250);

  // A page whose filter matches nothing must still advance over the rows it scanned:
  // seed enough excluded events to exhaust one bounded scan budget after the current cursor.
  const scanStart = spanNumber(pageTwo.spans.at(-1)!);
  for (let index = 0; index < 1010; index++) store.trace({ sessionId, type: 'task.note', status: 'completed', payload: { later: index } });
  const filteredEmpty = await f.inspector.trace(sessionId, { text: 'filtered-out-match', cursor: String(scanStart) });
  assert.equal(filteredEmpty.spans.length, 0);
  assert.equal(filteredEmpty.hasMore, true, 'scanned rows remain even when the filter returns no spans');
  assert.ok(filteredEmpty.nextCursor, 'a filtered-empty page still returns a real next cursor');
  assert.ok(Number(filteredEmpty.nextCursor) > scanStart, 'the cursor is the last scanned native row, not the last returned span');
  const filteredTail = await f.inspector.trace(sessionId, { text: 'filtered-out-match', cursor: filteredEmpty.nextCursor });
  assert.equal(filteredTail.spans.length, 0);
  assert.equal(filteredTail.hasMore, false);
  assert.equal(filteredTail.nextCursor, undefined, 'the terminal filtered page has no fabricated cursor');
});

test('Inspector context and recall use canonical raw archive SHA, bounded pages, and no effective double count', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const session = await f.call('POST', '/sessions', { title: 'Context' });
  const sessionId = String(session.id);
  const firstText = 'A'.repeat(11000);
  const secondText = 'B'.repeat(11000);
  await sendChat(f, sessionId, firstText);
  // Explicit source pressure keeps this an omission test independently of ingestion round count.
  for (let index = 0; index < 8; index++) f.backend.services.harness!.store.addMessage(sessionId, { role: 'assistant', content: `Archived context ${index}: ` + 'P'.repeat(3500) });
  const second = await sendChat(f, sessionId, secondText);
  assert.equal(second.status, 'completed');

  const state = await f.call('GET', `/sessions/${sessionId}`);
  const users = state.messages.filter((message: any) => message.role === 'user');
  assert.equal(users.length, 2);
  const firstUser = users.find((message: any) => message.content === firstText);
  const secondUser = users.find((message: any) => message.content === secondText);
  assert.ok(firstUser && secondUser);

  const raw = await f.call('GET', `/requests/${second.id}`);
  const context = await f.inspector.context(sessionId);
  assert.equal(context.usedTokens, raw.usage.prompt_tokens, 'exact recorded usage wins over estimates');
  assert.equal(context.usedTokensEstimated, false);
  assert.equal(context.windowTokensKnown, false, 'an unconfigured context window is reported as unknown, not as a fake number');
  assert.equal(context.windowTokens, 0, 'unknown window keeps the legacy numeric field at zero');

  const wideProfile = await f.call('POST', '/profiles', { name: 'Wide mock', provider: { mode: 'mock', maxOutputTokens: 512, contextWindowTokens: 65536 } });
  const wideSession = await f.call('POST', '/sessions', { title: 'Known window', profileId: wideProfile.id });
  const wideRecord = await sendChat(f, String(wideSession.id), 'window known');
  assert.equal(wideRecord.status, 'completed');
  const wideContext = await f.inspector.context(String(wideSession.id));
  assert.equal(wideContext.windowTokensKnown, true, 'a configured window is known');
  assert.equal(wideContext.windowTokens, 65536);
  assert.equal(wideContext.usedTokens, wideRecord.usage.prompt_tokens);
  assert.equal(wideContext.usedTokensEstimated, false);
  assert.ok(context.segments.length > 0);
  assert.equal(new Set(context.segments.map(segment => segment.id)).size, context.segments.length, 'segment ids are unique');
  assert.ok(!context.segments.some(segment => segment.id.startsWith('effective:')));
  assert.ok(!context.segments.some(segment => segment.kind === 'user' && segment.items?.some(item => item.label === 'user message')), 'history messages live only in the history segment, not also as user prompt layers');
  assert.ok(context.segments.some(segment => segment.kind === 'system'));
  assert.ok(context.segments.some(segment => segment.kind === 'memory'));
  const history = context.segments.find(segment => segment.kind === 'history');
  assert.ok(history);
  assert.ok(history.items?.some(item => item.sourceId === secondUser.id));
  assert.ok(!history.items?.some(item => item.sourceId === firstUser.id), 'archived-out messages are omitted, not double counted');
  const historyItem = history.items!.find(item => item.sourceId === secondUser.id)!;
  const memory = f.backend.services.harness!.store.memory(sessionId);
  assert.equal(historyItem.sha, memory.read({ id: secondUser.id, length: 1 }).sha256);
  assert.equal(historyItem.tokens, Math.ceil(secondText.length / 4));

  assert.ok(context.omitted.length > 0, 'working budget omits an older long message');
  const omitted = context.omitted.find(item => item.sourceId === firstUser.id);
  assert.ok(omitted, JSON.stringify(context.omitted.map(item => item.sourceId)));
  const record = memory.read({ id: firstUser.id, field: 'record', length: 12000 });
  assert.equal(record.sha256, sha256(record.text), 'raw record JSON re-hashes to the canonical SHA');
  assert.equal(omitted.sha, record.sha256);
  const recall = await f.inspector.recall(sessionId, firstUser.id);
  assert.equal(recall.sha, record.sha256, 'recall returns the canonical raw SHA');
  assert.equal(recall.offset, 0);
  assert.equal(recall.text.length, 6000);
  assert.equal(recall.nextOffset, 6000);
  const recallPageTwo = await f.inspector.recall(sessionId, firstUser.id, recall.nextOffset);
  assert.equal(recallPageTwo.offset, 6000);
  assert.equal(recallPageTwo.text.length, 5000);
  assert.equal(recallPageTwo.nextOffset, undefined);
  assert.equal(recallPageTwo.sha, record.sha256, 'pagination keeps the same canonical SHA');

  const other = await f.call('POST', '/sessions', { title: 'Other scope' });
  await assert.rejects(
    f.inspector.recall(other.id, firstUser.id),
    (error: unknown) => error instanceof ProductError && error.code === 'not_found',
  );
  await assert.rejects(
    f.inspector.recall(sessionId, firstUser.id, -1),
    (error: unknown) => error instanceof ProductError && error.code === 'validation',
  );
  await assert.rejects(
    f.inspector.recall(sessionId, 'missing-source'),
    (error: unknown) => error instanceof ProductError && error.code === 'not_found',
  );
});

test('Inspector diffs require an applied real receipt and a verifiable pre-image', { timeout: 90000 }, async t => {
  const original = 'original line\nsecond line';
  const replacement = 'changed line\nsecond line';
  const f = await fixture(t, {
    responder: body => {
      const system = (body.messages ?? []).find((message: any) => message.role === 'system')?.content ?? '';
      if (String(system).includes('REVIEWER ROLE')) return { content: JSON.stringify({ verdict: 'pass', reason: 'Mock reviewer: verified receipt.', findings: [] }) };
      const toolMessages = (body.messages ?? []).filter((message: any) => message.role === 'tool').length;
      if (toolMessages === 0) return { content: '', toolCalls: [{ id: 'read-before-write', name: 'read_file', arguments: { path: 'work.txt' } }] };
      if (toolMessages === 1) return { content: '', toolCalls: [{ id: 'write-after-read', name: 'write_file', arguments: { path: 'work.txt', content: replacement } }] };
      return { content: 'Write complete.' };
    },
  });
  writeFileSync(path.join(f.workspace, 'work.txt'), original, 'utf8');
  const taskId = await createTask(f, 'Read then write work.txt');
  const waiting = await f.until(
    () => f.call('GET', `/v1/snapshot?taskId=${taskId}`),
    (value: any) => value.selectedTask?.status === 'waiting_approval',
  );
  assert.ok(waiting.intents.some((intent: any) => intent.state === 'prepared' && intent.name === 'write_file'), 'the write intent is waiting for a human grant');
  assert.deepEqual(await f.inspector.diffs(taskId), [], 'unapplied proposals never appear as diffs');
  assert.equal(existsSync(path.join(f.workspace, 'work.txt')), true);
  await grantPending(f, taskId);
  await f.until(() => f.call('GET', `/v1/snapshot?taskId=${taskId}`), (value: any) => value.selectedTask?.status === 'completed');

  const diffs = await f.inspector.diffs(taskId);
  assert.equal(diffs.length, 1);
  const diff = diffs[0];
  assert.equal(diff.path, 'work.txt');
  assert.equal(diff.status, 'modified');
  assert.equal(diff.applied, true);
  assert.ok(diff.toolCallId);
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
  assert.equal(diff.hunks.length, 1);
  const lines = diff.hunks[0].lines;
  assert.deepEqual(lines.map(line => line.kind), ['del', 'add', 'ctx']);
  assert.equal(lines[0].text, 'original line');
  assert.equal(lines[0].oldNo, 1);
  assert.equal(lines[1].text, 'changed line');
  assert.equal(lines[1].newNo, 1);
  assert.equal(lines[2].text, 'second line');
  assert.equal(lines[2].oldNo, 2);
  assert.equal(lines[2].newNo, 2);
});

test('Inspector survives a real restart with the same persisted requests, prompt snapshots and archive SHAs', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.call('POST', '/prompts', { scope: 'global', systemPrompt: 'RESTART_ONE' });
  const session = await f.call('POST', '/sessions', { title: 'Restart' });
  const sessionId = String(session.id);
  const request = await sendChat(f, sessionId, 'persist me');
  const user = (await f.call('GET', `/sessions/${sessionId}`)).messages.find((message: any) => message.role === 'user');
  assert.ok(user);
  const before = {
    prompt: await f.inspector.prompt(sessionId, request.id),
    recall: await f.inspector.recall(sessionId, user.id),
    requests: await f.inspector.requests(sessionId),
    body: request.body,
  };
  assert.equal(before.prompt.parts.find(part => part.id === 'global:systemPrompt')?.content, 'RESTART_ONE');

  await f.restart();

  const afterPrompt = await f.inspector.prompt(sessionId, request.id);
  assert.deepEqual(afterPrompt, before.prompt, 'prompt snapshot is stable after restart');
  const afterRecall = await f.inspector.recall(sessionId, user.id);
  assert.equal(afterRecall.sha, before.recall.sha, 'canonical archive SHA is stable after restart');
  assert.equal(afterRecall.text, before.recall.text);
  const afterRequests = await f.inspector.requests(sessionId);
  const same = afterRequests.find(item => item.id === request.id);
  assert.ok(same);
  assert.deepEqual(same.body, before.body);
  const persisted = await f.call('GET', `/requests/${request.id}`);
  assert.deepEqual(same.usage, { input: persisted.usage.prompt_tokens, output: persisted.usage.completion_tokens });
  const toolsAfter = await f.inspector.tools(sessionId);
  assert.ok(toolsAfter.registered.length > 0);
  assert.ok(!toolsAfter.allowed.includes('write_file'));
  assert.deepEqual(await f.inspector.diffs(sessionId), []);
});
