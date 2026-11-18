import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';

/**
 * Inspector retention/durability over the new HTTP routes.
 *
 * These tests edit/delete live Chat rows through the real services, restart the real backend on
 * the same dataDir, and check that immutable promoted origins, task-owned canonical records and
 * already-consumed one-shot prompt edits keep their exact bytes and SHAs.
 */

const TREE = process.cwd();
const DATA_ROOT = path.join(TREE, '.tmp', 'inspector-integration', 'b', 'data', 'retention');
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
  const owned = path.join(DATA_ROOT, 'retention-' + process.pid + '-' + Date.now() + '-' + run++);
  const workspace = path.join(owned, 'workspace');
  const dataDir = path.join(owned, 'data');
  mkdirSync(workspace, { recursive: true });
  const relative = path.relative(TREE, dataDir);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'dataDir must stay inside the project root');
  const wire: any[] = [];
  const settings = { dataDir, projectRoot: TREE, mockOptions: { ...mockOptions, trace: (body: any) => wire.push(body) } };
  let backend: Backend = await startBackend(settings);
  let closed = false;

  const request = async (method: string, route: string, options: { body?: unknown; auth?: boolean } = {}): Promise<{ status: number; json: any; text: string }> => {
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
    return { status: response.status, json, text };
  };
  const ok = async (method: string, route: string, body?: unknown): Promise<any> => {
    const reply = await request(method, route, { body });
    assert.equal(reply.status, 200, method + ' ' + route + ' -> ' + reply.status + ': ' + reply.text.slice(0, 400));
    return reply.json;
  };
  const fails = async (method: string, route: string, body: unknown, status: number | number[], code: string): Promise<any> => {
    const reply = await request(method, route, { body });
    const statuses = Array.isArray(status) ? status : [status];
    assert.ok(statuses.includes(reply.status), method + ' ' + route + ' -> ' + reply.status + ': ' + reply.text.slice(0, 400));
    assert.equal(reply.json?.code, code, method + ' ' + route + ' -> ' + reply.text.slice(0, 400));
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
    }, (value: any) => Boolean(value && TERMINAL.has(value.status)), 'chat request settles for ' + sessionId);
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

function canonical(f: Fixture, sessionId: string, messageId: string): { sha256: string; text: string } {
  return f.harness.store.memory(sessionId).read({ id: messageId, field: 'record', length: 12_000 });
}

function kernelCanonical(f: Fixture, taskId: string, messageId: string): { sha256: string; text: string } {
  return f.kernel.memory(taskId, 'main').read({ id: messageId, field: 'record', length: 12_000 });
}

test('promoted Chat origins and task-owned records stay immutable and readable across edits, deletes and restart', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const created = await f.session({ title: 'Retention origin', workspace: f.workspace });
  const sessionId = created.id as string;
  const saved = await f.ok('POST', inspector + '/prompt', { sessionId, partId: 'session:systemPrompt', content: 'RETENTION_PROMPT_V1', scope: 'session' });
  assert.equal(saved.parts.find((part: any) => part.id === 'session:systemPrompt').version, 1);

  const request = await f.send(sessionId, 'RETENTION_ORIGIN_TEXT');
  const requestId = request.id as string;
  const origin = f.harness.store.allMessages(sessionId).find(message => message.role === 'user');
  assert.ok(origin);
  assert.equal(origin.content, 'RETENTION_ORIGIN_TEXT');
  const extra = f.harness.store.addMessage(sessionId, { role: 'user', content: 'RETENTION_EXTRA_TEXT' });
  const originCanonical = canonical(f, sessionId, origin.id);
  const extraCanonical = canonical(f, sessionId, extra.id);

  await f.runner.stop();
  const promoted = await f.ok('POST', '/v1/product/sessions/' + encodeURIComponent(sessionId) + '/promote', { objective: 'Retain the original records', acceptance: ['origin and task records survive'] });
  const taskId = promoted.id as string;
  assert.ok(f.kernel.getTask(taskId), 'promotion creates a real Kernel task');
  const own = f.kernel.addMessage(taskId, 'user', 'RETENTION_TASK_OWN_TEXT');
  const ownCanonical = kernelCanonical(f, taskId, own.id);

  const promptBefore = await f.ok('GET', inspector + '/prompt' + query({ sessionId, requestId }));
  const requestsBefore = await f.ok('GET', inspector + '/requests' + query({ sessionId }));
  const traceBefore = await f.ok('GET', inspector + '/trace' + query({ sessionId }));

  for (const [label, sourceId, expectedText, expectedSha] of [
    ['origin', origin.id, 'RETENTION_ORIGIN_TEXT', originCanonical.sha256],
    ['extra', extra.id, 'RETENTION_EXTRA_TEXT', extraCanonical.sha256],
    ['own', own.id, 'RETENTION_TASK_OWN_TEXT', ownCanonical.sha256],
  ] as const) {
    const page = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId }));
    assert.equal(page.text, expectedText, label + ' text is readable from the promoted task');
    assert.equal(page.sha, expectedSha, label + ' keeps its canonical SHA from the promoted task');
    assert.equal(page.offset, 0);
  }
  const liveOrigin = await f.ok('GET', inspector + '/recall' + query({ sessionId, sourceId: origin.id }));
  assert.equal(liveOrigin.text, 'RETENTION_ORIGIN_TEXT');
  assert.equal(liveOrigin.sha, originCanonical.sha256);

  f.harness.store.updateMessageContent(sessionId, origin.id, 'RETENTION_MUTATED_SOURCE');
  f.harness.store.deleteMessagesAfter(sessionId, origin.id);
  assert.equal(f.harness.store.allMessages(sessionId).some(message => message.id === extra.id), false, 'the extra source message is really deleted from the live Chat');
  const editedLive = await f.ok('GET', inspector + '/recall' + query({ sessionId, sourceId: origin.id }));
  assert.equal(editedLive.text, 'RETENTION_MUTATED_SOURCE');
  assert.notEqual(editedLive.sha, originCanonical.sha256);
  await f.fails('GET', inspector + '/recall' + query({ sessionId, sourceId: extra.id }), undefined, 404, 'not_found');
  const afterMutation = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: origin.id }));
  assert.equal(afterMutation.text, 'RETENTION_ORIGIN_TEXT', 'a source edit cannot rewrite the promoted origin');
  assert.equal(afterMutation.sha, originCanonical.sha256);
  const afterExtraDelete = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: extra.id }));
  assert.equal(afterExtraDelete.text, 'RETENTION_EXTRA_TEXT', 'a source delete cannot remove the promoted origin');
  assert.equal(afterExtraDelete.sha, extraCanonical.sha256);

  await f.restart();
  await f.runner.stop();

  for (const [label, sourceId, expectedText, expectedSha] of [
    ['origin', origin.id, 'RETENTION_ORIGIN_TEXT', originCanonical.sha256],
    ['extra', extra.id, 'RETENTION_EXTRA_TEXT', extraCanonical.sha256],
    ['own', own.id, 'RETENTION_TASK_OWN_TEXT', ownCanonical.sha256],
  ] as const) {
    const page = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId }));
    assert.equal(page.text, expectedText, label + ' survives restart');
    assert.equal(page.sha, expectedSha, label + ' SHA survives restart');
  }

  const promptAfter = await f.ok('GET', inspector + '/prompt' + query({ sessionId, requestId }));
  assert.deepEqual(promptAfter, promptBefore, 'prompt snapshots and versions are stable after restart');
  const requestsAfter = await f.ok('GET', inspector + '/requests' + query({ sessionId }));
  for (const before of requestsBefore) {
    const after = requestsAfter.find((item: any) => item.id === before.id);
    assert.ok(after, 'request ' + before.id + ' remains readable after restart');
    assert.deepEqual(after.body, before.body);
    assert.deepEqual(after.usage, before.usage);
    assert.equal(after.status, before.status);
  }
  const traceAfter = await f.ok('GET', inspector + '/trace' + query({ sessionId }));
  const traceIds = new Set(traceAfter.spans.map((span: any) => span.id));
  for (const span of traceBefore.spans) assert.ok(traceIds.has(span.id), 'trace span ' + span.id + ' remains readable after restart');

  const chatB = await f.session({ title: 'Other scope' });
  const messageB = f.harness.store.addMessage(chatB.id, { role: 'user', content: 'RETENTION_OTHER_SCOPE' });
  await f.fails('GET', inspector + '/recall' + query({ sessionId, sourceId: messageB.id }), undefined, 404, 'not_found');
  await f.fails('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: messageB.id }), undefined, 404, 'not_found');
  await f.fails('GET', inspector + '/recall' + query({ sessionId: chatB.id, sourceId: origin.id }), undefined, 404, 'not_found');

  assert.equal((await f.ok('POST', '/v1/product/sessions/' + encodeURIComponent(chatB.id) + '/remove')).removed, true);
  const chatC = await f.session({ title: 'After retention' });
  await f.fails('GET', inspector + '/recall' + query({ sessionId: chatC.id, sourceId: messageB.id }), undefined, 404, 'not_found');

  assert.equal((await f.ok('POST', '/v1/product/sessions/' + encodeURIComponent(sessionId) + '/remove')).removed, true);
  const originAfterRemoval = await f.ok('GET', inspector + '/recall' + query({ sessionId: taskId, sourceId: origin.id }));
  assert.equal(originAfterRemoval.text, 'RETENTION_ORIGIN_TEXT', 'the promoted origin outlives the removed source Chat');
  assert.equal(originAfterRemoval.sha, originCanonical.sha256);
  await f.fails('GET', inspector + '/recall' + query({ sessionId: chatC.id, sourceId: origin.id }), undefined, 404, 'not_found');
  await f.fails('GET', inspector + '/recall' + query({ sessionId, sourceId: origin.id }), undefined, 404, 'not_found');
});

test('a consumed request-scope edit is not re-applied after restart while old request bodies and prompt versions stay stable', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const created = await f.session({ title: 'Retention one-shot' });
  const sessionId = created.id as string;
  await f.ok('POST', inspector + '/prompt', { sessionId, partId: 'session:systemPrompt', content: 'RETENTION_DURABLE_PROMPT', scope: 'session' });

  const first = await f.send(sessionId, 'RETENTION_BEFORE_ONCE');
  const firstRequestId = first.id as string;
  const firstBody = JSON.stringify(first.body);
  const firstPrompt = await f.ok('GET', inspector + '/prompt' + query({ sessionId, requestId: firstRequestId }));
  assert.equal(firstPrompt.parts.find((part: any) => part.id === 'session:systemPrompt').version, 1);

  const draft = await f.ok('POST', inspector + '/prompt', { sessionId, partId: 'request:systemPrompt', content: 'RETENTION_ONCE_MARKER', scope: 'request' });
  assert.equal(typeof draft.requestId, 'string');
  assert.ok(Number(draft.pendingEdits) >= 1);

  const consumed = await f.send(sessionId, 'RETENTION_CONSUME_ONCE');
  const consumedBody = JSON.stringify(consumed.body);
  const markerBodies = (): number => f.wire.filter((body: any) => JSON.stringify(body).includes('RETENTION_ONCE_MARKER')).length;
  assert.ok(JSON.stringify(f.wire.at(-1)).includes('RETENTION_ONCE_MARKER'), 'the next real Chat request applies the pending one-shot edit');
  assert.equal(markerBodies(), 1, 'the one-shot edit is consumed exactly once');
  const consumedPrompt = await f.ok('GET', inspector + '/prompt' + query({ sessionId, requestId: consumed.id }));
  assert.ok(consumedPrompt.parts.some((part: any) => part.content === 'RETENTION_ONCE_MARKER' && part.scope === 'request'), 'the consumed edit is visible only on the request that used it');
  const previewBefore = await f.ok('GET', inspector + '/prompt' + query({ sessionId }));
  assert.equal(previewBefore.pendingEdits, 0);
  const requestsBefore = await f.ok('GET', inspector + '/requests' + query({ sessionId }));

  await f.restart();

  const requestsAfter = await f.ok('GET', inspector + '/requests' + query({ sessionId }));
  assert.equal(requestsAfter.length, requestsBefore.length, 'restart adds no request records');
  assert.equal(JSON.stringify(requestsAfter.find((item: any) => item.id === firstRequestId).body), firstBody, 'the first request body stays byte-identical');
  assert.equal(JSON.stringify(requestsAfter.find((item: any) => item.id === consumed.id).body), consumedBody, 'the consuming request body stays byte-identical');
  const firstPromptAfter = await f.ok('GET', inspector + '/prompt' + query({ sessionId, requestId: firstRequestId }));
  assert.deepEqual(firstPromptAfter, firstPrompt, 'prompt snapshots and versions stay stable across restart');
  const previewAfter = await f.ok('GET', inspector + '/prompt' + query({ sessionId }));
  assert.equal(previewAfter.pendingEdits, 0, 'the consumed edit is not pending after restart');
  assert.equal(previewAfter.parts.find((part: any) => part.id === 'session:systemPrompt').content, 'RETENTION_DURABLE_PROMPT');
  assert.equal(previewAfter.parts.find((part: any) => part.id === 'session:systemPrompt').version, 1);

  const later = await f.send(sessionId, 'RETENTION_AFTER_RESTART');
  assert.ok(!JSON.stringify(f.wire.at(-1)).includes('RETENTION_ONCE_MARKER'), 'a later request after restart does not re-apply the consumed edit');
  assert.equal(markerBodies(), 1, 'the consumed edit stays consumed across restart');
  const laterPrompt = await f.ok('GET', inspector + '/prompt' + query({ sessionId, requestId: later.id }));
  assert.ok(!laterPrompt.parts.some((part: any) => String(part.content).includes('RETENTION_ONCE_MARKER')));
  const finalRequests = await f.ok('GET', inspector + '/requests' + query({ sessionId }));
  assert.equal(JSON.stringify(finalRequests.find((item: any) => item.id === firstRequestId).body), firstBody);
  assert.equal(JSON.stringify(finalRequests.find((item: any) => item.id === consumed.id).body), consumedBody);
});
