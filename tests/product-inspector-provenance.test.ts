import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';
import { ProductInspector, type InspectorDomain } from '../src/product/inspector.js';
import { ProductError, type ProductRuntime } from '../src/product/shared.js';
import { ProductStore } from '../src/product/store.js';

const ROOT = path.resolve(process.cwd(), '.tmp', 'product-inspector', 'child', 'runtime');
mkdirSync(ROOT, { recursive: true });

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function fixture(t: import('node:test').TestContext, mockOptions: MockProviderOptions = {}) {
  const owned = mkdtempSync(path.join(ROOT, 'provenance-'));
  const workspace = path.join(owned, 'workspace');
  const dataDir = path.join(owned, 'data');
  const productDir = path.join(owned, 'product');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(productDir, { recursive: true });
  const wire: any[] = [];
  const settings = {
    dataDir,
    projectRoot: process.cwd(),
    mockOptions: { ...mockOptions, trace: (body: any) => wire.push(body) },
  };

  let backend = await startBackend(settings);
  let productStore = new ProductStore(productDir);
  let inspector: InspectorDomain = ProductInspector({
    services: backend.services,
    harness: backend.services.harness!,
    store: productStore,
    append: () => undefined,
  } as ProductRuntime);
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    await backend.close();
    productStore.close();
  };
  t.after(async () => {
    await close();
    assert.equal(path.dirname(owned), ROOT);
    rmSync(owned, { recursive: true, force: true });
  });

  const restart = async () => {
    await backend.close();
    productStore.close();
    backend = await startBackend(settings);
    productStore = new ProductStore(productDir);
    inspector = ProductInspector({
      services: backend.services,
      harness: backend.services.harness!,
      store: productStore,
      append: () => undefined,
    } as ProductRuntime);
  };

  const call = async (method: string, route: string, input?: unknown, status = 200): Promise<any> => {
    const response = await fetch(
      'http://127.0.0.1:' + backend.port + (route.startsWith('/v1') ? route : '/v1/harness' + route),
      {
        method,
        headers: {
          Authorization: 'Bearer ' + backend.token,
          'Content-Type': 'application/json',
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      },
    );
    const value: any = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };

  const until = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
    const deadline = performance.now() + 18_000;
    for (;;) {
      const value = await read();
      if (ready(value)) return value;
      assert.ok(performance.now() < deadline, 'Did not settle: ' + JSON.stringify(value));
      await sleep(30);
    }
  };

  return {
    get backend() { return backend; },
    get harness() { return backend.services.harness!; },
    get inspector() { return inspector; },
    wire,
    workspace,
    dataDir,
    call,
    until,
    restart,
    close,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function createChat(f: Fixture, title = 'Provenance chat'): Promise<string> {
  const session = await f.call('POST', '/sessions', { title, workspace: f.workspace });
  return session.id as string;
}

async function sendChat(f: Fixture, sessionId: string, content: string): Promise<any> {
  const started = await f.call('POST', '/chat', { sessionId, content });
  const record = await f.until(
    async () => {
      const latest = f.harness.store.latestRequest(sessionId, 'chat');
      return f.call('GET', '/requests/' + (latest?.id ?? started.requestId));
    },
    (value: any) => ['completed', 'failed', 'cancelled'].includes(value.status) && !f.harness.chat.busy(sessionId),
  );
  assert.equal(record.status, 'completed', JSON.stringify(record.error));
  return record;
}

function canonical(f: Fixture, sessionId: string, messageId: string) {
  return f.harness.store.memory(sessionId).read({ id: messageId, field: 'record', length: 12_000 });
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof ProductError && error.code === code);
}

test('canonical Chat archive SHAs survive projection, omission and promotion recall', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const sessionId = await createChat(f);
  const padding = 'P'.repeat(3_500);
  for (let index = 0; index < 8; index++) {
    f.harness.store.addMessage(sessionId, { role: 'user', content: 'seed-user-' + index + '-' + padding });
    f.harness.store.addMessage(sessionId, { role: 'assistant', content: 'seed-assistant-' + index + '-' + padding });
  }
  const longContent = 'LONG-RECALL-' + 'x'.repeat(9_000);
  const longMessage = f.harness.store.addMessage(sessionId, { role: 'user', content: longContent });
  const done = await sendChat(f, sessionId, 'Which archived messages are the original records?');
  assert.equal(typeof done.usage?.prompt_tokens, 'number');

  const context = await f.inspector.context(sessionId);
  const history = context.segments.find(segment => segment.kind === 'history');
  assert.ok(history?.items?.length, 'Chat context exposes selected history items');
  for (const item of history.items!) {
    const sourceId = item.sourceId!;
    const original = canonical(f, sessionId, sourceId);
    assert.equal(item.sha, original.sha256);
    assert.equal(sha256(original.text), original.sha256);
    const projected = done.sources.find((source: any) => source.id === sourceId);
    assert.ok(projected, 'request retained projected source ' + sourceId);
    assert.notEqual(item.sha, sha256(projected.content));
  }
  assert.ok(context.omitted.length > 0, 'older messages are omitted from the working projection');
  for (const omitted of context.omitted) {
    const original = canonical(f, sessionId, omitted.sourceId);
    assert.equal(omitted.sha, original.sha256);
    assert.equal(sha256(original.text), original.sha256);
  }
  assert.equal(context.usedTokens, done.usage.prompt_tokens);
  assert.ok(
    context.segments.every(segment => !segment.id.startsWith('effective:')),
    'projection parts are not counted as context segments',
  );

  const page = await f.inspector.recall(sessionId, longMessage.id);
  assert.equal(page.sha, canonical(f, sessionId, longMessage.id).sha256);
  assert.equal(page.offset, 0);
  assert.equal(page.text, longContent.slice(0, 6_000));
  assert.equal(page.nextOffset, 6_000);
  const next = await f.inspector.recall(sessionId, longMessage.id, page.nextOffset);
  assert.equal(next.sha, page.sha);
  assert.equal(next.offset, 6_000);
  assert.equal(next.text, longContent.slice(6_000, 12_000));
  assert.equal(next.nextOffset, undefined);
  await rejectsWith(f.inspector.recall(sessionId, longMessage.id, -1), 'validation');

  await f.backend.services.runner.stop();
  const promoted = await f.call('POST', '/sessions/' + sessionId + '/promote', {});
  assert.equal(typeof promoted.taskId, 'string');
  const taskRecall = await f.inspector.recall(promoted.taskId, longMessage.id);
  const promotedCanonical = canonical(f, sessionId, longMessage.id);
  assert.equal(taskRecall.sha, promotedCanonical.sha256);
  assert.equal(sha256(promotedCanonical.text), promotedCanonical.sha256);
  const projectedLong = done.sources.find((source: any) => source.id === longMessage.id);
  assert.ok(projectedLong);
  assert.notEqual(taskRecall.sha, sha256(projectedLong.content));
  assert.equal(taskRecall.text, longContent.slice(0, 6_000));
});

test('Inspector snapshots survive a real backend restart', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const sessionId = await createChat(f);
  const done = await sendChat(f, sessionId, 'RESTART_ORIGIN');
  const originalMessage = f.harness.store.allMessages(sessionId).find(message => message.role === 'user')!;
  await f.backend.services.runner.stop();
  const promoted = await f.call('POST', '/sessions/' + sessionId + '/promote', {});
  const taskId = promoted.taskId as string;

  f.backend.services.runner.start();
  const workRecord = await f.until(
    async () => {
      const page = await f.call('GET', '/requests?taskId=' + taskId);
      const found = page.requests.find((item: any) => item.kind === 'work');
      return found ? f.call('GET', '/requests/' + found.id) : undefined;
    },
    (value: any) => Boolean(value && ['completed', 'failed', 'cancelled'].includes(value.status)),
  );
  assert.equal(workRecord.kind, 'work');
  await f.until(
    async () => f.call('GET', '/v1/snapshot?taskId=' + taskId),
    (value: any) => ['waiting_approval', 'completed', 'failed', 'cancelled'].includes(value.selectedTask?.status),
  );
  await f.backend.services.runner.stop();

  const snapshot = async () => ({
    requests: await f.inspector.requests(sessionId),
    prompt: await f.inspector.prompt(sessionId, done.id),
    preview: await f.inspector.prompt(sessionId),
    context: await f.inspector.context(sessionId),
    recall: await f.inspector.recall(sessionId, originalMessage.id),
    workRecall: await f.inspector.recall(taskId, originalMessage.id),
    workContext: await f.inspector.context(taskId),
    diffs: await f.inspector.diffs(sessionId),
    workDiffs: await f.inspector.diffs(taskId),
  });
  const before = await snapshot();
  await f.restart();
  const after = await snapshot();
  assert.deepEqual(after, before);
  assert.ok(after.requests.length > 0);
  assert.deepEqual(after.diffs, []);
  assert.ok(after.workContext.segments.length > 0, 'Work request context persisted');
  assert.ok(after.workContext.segments.every(segment => !segment.id.startsWith('effective:')));
  const original = canonical(f, sessionId, originalMessage.id);
  assert.equal(after.recall.sha, original.sha256);
  assert.equal(after.workRecall.sha, original.sha256);
  assert.equal(sha256(original.text), original.sha256);

  const chatIds = new Set(f.harness.store.allMessages(sessionId).map(message => message.id));
  const workHistory = before.workContext.segments.find(segment => segment.kind === 'history');
  for (const item of workHistory?.items ?? []) {
    const sourceId = item.sourceId!;
    if (chatIds.has(sourceId)) {
      assert.equal(item.sha, canonical(f, sessionId, sourceId).sha256);
    } else {
      assert.equal(item.sha, undefined, 'a kernel message id must not be labeled with a Chat archive hash');
    }
  }
});

test('Inspector scopes recall to each conversation and the promotion snapshot', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const chatA = await createChat(f, 'Scoped chat A');
  const chatB = await createChat(f, 'Scoped chat B');
  const sentA = await sendChat(f, chatA, 'A original message');
  await sendChat(f, chatB, 'B original message');
  const messageA = f.harness.store.allMessages(chatA).find(message => message.role === 'user')!;
  const messageB = f.harness.store.allMessages(chatB).find(message => message.role === 'user')!;
  assert.equal((await f.inspector.recall(chatA, messageA.id)).sha, canonical(f, chatA, messageA.id).sha256);

  await rejectsWith(f.inspector.recall(chatB, messageA.id), 'not_found');
  await rejectsWith(f.inspector.prompt(chatB, sentA.id), 'not_found');
  await rejectsWith(f.inspector.requests('chat-missing'), 'not_found');
  await rejectsWith(f.inspector.context('chat-missing'), 'not_found');
  await rejectsWith(f.inspector.recall(chatA, 'msg-missing'), 'not_found');
  await rejectsWith(f.inspector.prompt(chatA, 'req-missing'), 'not_found');
  const requestCount = f.harness.store.listRequests({ sessionId: chatA }).requests.length;
  const wireCount = f.wire.length;
  await rejectsWith(f.inspector.replay('req-missing', sentA.body, 'branch'), 'not_found');
  assert.equal(f.harness.store.listRequests({ sessionId: chatA }).requests.length, requestCount);
  assert.equal(f.wire.length, wireCount);

  await f.backend.services.runner.stop();
  const promoted = await f.call('POST', '/sessions/' + chatA + '/promote', {});
  const taskId = promoted.taskId as string;
  assert.equal((await f.inspector.recall(taskId, messageA.id)).sha, canonical(f, chatA, messageA.id).sha256);
  await rejectsWith(f.inspector.recall(taskId, messageB.id), 'not_found');

  await sendChat(f, chatA, 'A later message outside the promotion snapshot');
  const later = f.harness.store.allMessages(chatA).filter(message => message.role === 'user').at(-1)!;
  await rejectsWith(f.inspector.recall(taskId, later.id), 'not_found');
  assert.equal((await f.inspector.recall(chatA, later.id)).sha, canonical(f, chatA, later.id).sha256);
  const oldPrompt = await f.inspector.prompt(chatA, sentA.id);
  assert.ok(!oldPrompt.parts.some(part => part.content.includes('A later message outside the promotion snapshot')));
});

test('prompt snapshots stay immutable while later edits affect only new requests', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const sessionId = await createChat(f);
  const saved = await f.inspector.savePrompt(sessionId, 'session:systemPrompt', 'PROVENANCE_V1', 'session');
  assert.equal(saved.parts.find(part => part.id === 'session:systemPrompt')?.content, 'PROVENANCE_V1');
  assert.equal(saved.parts.find(part => part.id === 'session:systemPrompt')?.editable, true);

  const first = await sendChat(f, sessionId, 'FIRST_PROMPT_SNAPSHOT');
  assert.ok(f.wire.at(-1).messages.some((message: any) => message.content === 'PROVENANCE_V1'));
  const frozen = await f.inspector.prompt(sessionId, first.id);
  assert.equal(frozen.parts.find(part => part.id === 'session:systemPrompt')?.content, 'PROVENANCE_V1');

  await f.inspector.savePrompt(sessionId, 'session:systemPrompt', 'PROVENANCE_V2', 'session');
  const stillFrozen = await f.inspector.prompt(sessionId, first.id);
  assert.equal(stillFrozen.parts.find(part => part.id === 'session:systemPrompt')?.content, 'PROVENANCE_V1');
  const current = await f.inspector.prompt(sessionId);
  assert.equal(current.parts.find(part => part.id === 'session:systemPrompt')?.content, 'PROVENANCE_V2');

  await sendChat(f, sessionId, 'SECOND_PROMPT_SNAPSHOT');
  assert.ok(f.wire.at(-1).messages.some((message: any) => message.content === 'PROVENANCE_V2'));
  assert.ok(!f.wire.at(-1).messages.some((message: any) => message.content === 'PROVENANCE_V1'));
  const firstRecord = await f.call('GET', '/requests/' + first.id);
  assert.ok(firstRecord.body.messages.some((message: any) => message.content === 'PROVENANCE_V1'));

  for (const locked of ['chat-mode', 'instruction-test', 'archive-navigation', 'context-selection']) {
    await rejectsWith(f.inspector.savePrompt(sessionId, locked, 'MUTATED', 'session'), 'denied');
  }
  await rejectsWith(f.inspector.savePrompt(sessionId, 'not-a-field', 'MUTATED', 'session'), 'validation');
  assert.equal(
    (await f.inspector.prompt(sessionId, first.id)).parts.find(part => part.id === 'session:systemPrompt')?.content,
    'PROVENANCE_V1',
  );
});

test('replay keeps branch drafts inert and send makes exactly one explicit model call', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const sessionId = await createChat(f);
  const origin = await sendChat(f, sessionId, 'REPLAY_ORIGIN');
  const original = await f.call('GET', '/requests/' + origin.id);
  const messagesBefore = f.harness.store.messageCount(sessionId);
  const wireBefore = f.wire.length;
  assert.deepEqual(await f.inspector.diffs(sessionId), []);

  const branch = await f.inspector.replay(original.id, original.body, 'branch');
  assert.equal(branch.status, 'draft');
  assert.equal(branch.parentId, original.id);
  assert.notEqual(branch.id, original.id);
  assert.deepEqual(branch.body, original.body);
  assert.equal(f.wire.length, wireBefore);
  assert.equal(f.harness.store.messageCount(sessionId), messagesBefore);
  assert.deepEqual(f.harness.store.toolCalls({ requestId: branch.id }), []);
  assert.deepEqual(await f.call('GET', '/requests/' + original.id), original);

  const sendBody = structuredClone(original.body);
  sendBody.temperature = 0.11;
  sendBody.seed = 7;
  sendBody.stream = false;
  delete sendBody.stream_options;
  const sent = await f.inspector.replay(original.id, sendBody, 'send');
  assert.equal(sent.status, 'completed');
  assert.equal(sent.parentId, original.id);
  assert.notEqual(sent.id, original.id);
  assert.equal(f.wire.length, wireBefore + 1);
  assert.deepEqual(f.wire.at(-1), sendBody);
  assert.equal(f.harness.store.messageCount(sessionId), messagesBefore);
  assert.deepEqual(f.harness.store.toolCalls({ requestId: sent.id }), []);
  assert.deepEqual(await f.call('GET', '/requests/' + original.id), original);
  assert.deepEqual(await f.inspector.diffs(sessionId), []);
});

test('context reports real usage without double counting and unapplied Chat proposals stay out of diffs', { timeout: 60_000 }, async t => {
  const f = await fixture(t, {
    responder: (body: any) => body.messages.some((message: any) => message.role === 'tool')
      ? { content: 'Observed the permission refusal.' }
      : {
          content: '',
          toolCalls: [{
            id: 'chat-write-proposal',
            name: 'write_file',
            arguments: { path: 'never-written.txt', content: 'NO_EFFECT' },
          }],
        },
  });
  const sessionId = await createChat(f, 'Proposal chat');
  await f.call('POST', '/sessions/' + sessionId, { capabilities: { tools: true } });
  const started = await f.call('POST', '/chat', { sessionId, content: 'Please propose a write' });
  const write = await f.until(
    async () => f.harness.store.toolCalls({ sessionId }).find(record => record.name === 'write_file'),
    (value: any) => Boolean(value && ['failed', 'denied', 'not_executed'].includes(value.status)),
  );
  assert.ok(write);
  assert.notEqual(write.status, 'completed');
  const settled = await f.until(
    async () => f.call('GET', '/sessions/' + sessionId),
    (value: any) => value.activeRequestId === undefined && value.messages.length >= 4,
  );
  assert.ok(settled.messages.length >= 4, 'Chat continuation consumed the tool result');
  assert.deepEqual(await f.inspector.diffs(sessionId), []);
  assert.equal(existsSync(path.join(f.workspace, 'never-written.txt')), false);

  const tools = await f.inspector.tools(sessionId);
  const call = tools.calls.find(item => item.name === 'write_file');
  assert.ok(call);
  assert.notEqual(call.status, 'completed');

  const latest = f.harness.store.latestRequest(sessionId, 'chat')!;
  assert.ok(latest);
  assert.ok(latest.usage);
  assert.equal(typeof latest.usage.prompt_tokens, 'number');
  const context = await f.inspector.context(sessionId);
  assert.equal(context.usedTokens, latest.usage.prompt_tokens);
  assert.ok(context.segments.every(segment => !segment.id.startsWith('effective:')));
  assert.ok(f.wire.length >= 2);
  assert.ok(started.requestId);
});
