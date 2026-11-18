import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import { randomUUID } from 'node:crypto';
import { Kernel, digest } from '../src/kernel/index.js';
import { HarnessStore } from '../src/harness/store.js';
import { WorkTrace } from '../src/harness/work-trace.js';
import type { Services } from '../src/app/services.js';

const ROOT = process.cwd();
const TEMP = path.join(ROOT, '.tmp', 'approval-resume', 'fixtures');
const CALL_ID = 'mock_increment_1';
type Backend = Awaited<ReturnType<typeof startBackend>>;
type Call = { id: string; requestId: string; status: string; approvalId?: string; result?: unknown };

for (const restartPaused of [false, true]) test(`Work pause/resume binds reused provider call ids to the current approval${restartPaused ? ' across restart' : ''}`, { timeout: 60_000 }, async t => {
  mkdirSync(TEMP, { recursive: true });
  const owned = mkdtempSync(path.join(TEMP, 'http-'));
  const settings = { projectRoot: ROOT, dataDir: path.join(owned, 'data') };
  let backend: Backend = await startBackend(settings);
  t.after(async () => { await backend.close(); rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const request = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${backend.port}/v1/product${route}`, {
      method, headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const ok = async (method: string, route: string, body?: unknown): Promise<any> => {
    const response = await request(method, route, body);
    assert.equal(response.status, 200, JSON.stringify({ route, ...response }));
    return response.body;
  };
  const until = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const value = await read();
      if (ready(value)) return value;
      assert.ok(Date.now() < deadline, 'Timed out: ' + JSON.stringify(value));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const sent = await ok('POST', '/chat/send', { mode: 'cowork', text: 'increment counter once', attachments: [], permission: 'ask', modelId: 'default' });
  const taskId = sent.sessionId as string;
  const pending = () => ok('GET', '/approvals?sessionId=' + taskId) as Promise<any[]>;
  const calls = async (): Promise<Call[]> => (await ok('GET', '/inspector/tools?sessionId=' + taskId)).calls;
  const task = () => ok('GET', '/tasks/' + taskId);
  const first = (await until(pending, rows => rows.length === 1))[0];
  const firstCalls = await calls();
  assert.equal(firstCalls.length, 1);
  assert.equal(firstCalls[0]!.approvalId, first.id);
  assert.equal(first.toolCallId, CALL_ID);
  const firstRequestId = firstCalls[0]!.requestId;
  await ok('POST', '/tasks/' + taskId + '/control', { action: 'pause' });
  await until(task, value => value.status === 'paused');
  assert.deepEqual(await pending(), []);
  assert.equal(backend.services.kernel.getIntent(first.id)!.state, 'denied');
  if (restartPaused) {
    await backend.close();
    backend = await startBackend(settings);
    assert.equal((await task()).status, 'paused');
    assert.deepEqual(await pending(), []);
  }
  await ok('POST', '/tasks/' + taskId + '/control', { action: 'resume' });
  const current = (await until(pending, rows => rows.length === 1 && rows[0].id !== first.id))[0];
  const resumed = await calls();
  const native = backend.services.harness!.store.toolCalls({ taskId });
  t.diagnostic(JSON.stringify({ restartPaused, firstApproval: first.id, currentApproval: current.id, calls: resumed,
    native: native.map(({ id, toolCallId, requestId, intentId, runId, status }) => ({ id, toolCallId, requestId, intentId, runId, status })) }));
  assert.equal(current.toolCallId, CALL_ID, 'fixture reuses the provider call id in the next request');
  const active = resumed.find(call => call.requestId !== firstRequestId);
  const previous = resumed.find(call => call.requestId === firstRequestId);
  assert.ok(active, 'the new request retains its own call');
  assert.equal(active.status, 'awaiting_approval');
  assert.equal(active.approvalId, current.id, 'current request must link its own pending intent');
  assert.ok(previous, 'the superseded call remains separate history');
  assert.equal(previous.status, 'denied');
  assert.equal(previous.approvalId, undefined);
  assert.equal(new Set(resumed.map(call => call.id)).size, resumed.length, 'Inspector call identities cannot collide between requests');
  assert.equal(resumed.filter(call => call.approvalId).length, 1);
  const intent = backend.services.kernel.getIntent(current.id)!;
  const currentTask = backend.services.kernel.getTask(taskId)!;
  assert.equal(intent.generation, currentTask.generation);
  assert.equal(intent.policyEpoch, currentTask.policyEpoch);
  assert.equal(native.find(call => call.requestId === active.requestId)!.runId, intent.runId);
  assert.equal(native.find(call => call.requestId === active.requestId)!.receivedByRequestId, undefined, 'an unsatisfied proposal has no received result');
  assert.equal(native.find(call => call.requestId === firstRequestId)!.receivedByRequestId, active.requestId);
  assert.equal((await request('POST', '/approvals/decide', { approvalId: first.id, approved: true, scope: 'once' })).status, 409);
  assert.equal(backend.services.kernel.intents(taskId).filter(item => item.receipt).length, 0);
  await ok('POST', '/approvals/decide', { approvalId: active.approvalId, approved: true, scope: 'once' });
  await until(task, value => value.status === 'completed');
  const finalCalls = await calls();
  assert.equal(finalCalls.find(call => call.requestId === active.requestId)!.status, 'succeeded');
  assert.equal(finalCalls.find(call => call.requestId === firstRequestId)!.status, 'denied');
  const followup = backend.services.harness!.store.latestRequest(taskId, 'work')!;
  assert.equal(followup.body!.messages.filter((message: any) => message.role === 'tool').length, 2);
  for (const record of backend.services.harness!.store.toolCalls({ taskId }))
    assert.equal(record.receivedByRequestId, followup.id, 'both exact tool results were received by the final follow-up');
  assert.ok(finalCalls.every(call => call.approvalId === undefined));
  assert.deepEqual(await pending(), []);
  const receipts = backend.services.kernel.intents(taskId).flatMap(item => item.receipt ? [item.receipt] : []);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.fixtureValue, 1);
  assert.equal(backend.services.kernel.events(taskId).filter(event => event.type === 'effect.receipted').length, 1);
  assert.equal((await request('POST', '/approvals/decide', { approvalId: current.id, approved: true, scope: 'once' })).status, 409);
  await backend.close();
  backend = await startBackend(settings);
  assert.equal((await task()).status, 'completed');
  assert.deepEqual(await pending(), []);
  assert.equal(backend.services.kernel.intents(taskId).filter(item => item.receipt).length, 1);
  assert.equal(backend.services.kernel.getIntent(current.id)!.receipt!.fixtureValue, 1);
});

test('WorkTrace catch-up keeps repeated call ids separate across requests and resumed runs', async t => {
  mkdirSync(TEMP, { recursive: true });
  const owned = mkdtempSync(path.join(TEMP, 'catchup-'));
  const kernel = new Kernel(path.join(owned, 'kernel'));
  const store = new HarnessStore(path.join(owned, 'harness'));
  let trace: WorkTrace | undefined;
  t.after(() => { trace?.close(); store.close(); kernel.close(); rmSync(owned, { recursive: true, force: true }); });
  const taskId = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    workspace: owned, objective: 'increment counter', permission: { mode: 'ask', app: 'work' },
  } }).taskId!;
  const call = { id: CALL_ID, name: 'fixture_increment', arguments: { amount: 1 } };
  const propose = (runId: string) => {
    const request = store.createRequest({ sessionId: taskId, taskId, runId, profileId: 'default', kind: 'work', status: 'completed', endpoint: 'fixture', bodyHash: 'fixture', recordContent: true, draft: '', sources: [] });
    const id = request.id + ':' + call.id;
    store.saveTool({ id, requestId: request.id, sessionId: taskId, taskId, runId, toolCallId: call.id, name: call.name, arguments: call.arguments,
      source: 'builtin', permission: 'unassessed', status: 'proposed', retries: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const message = kernel.addMessage(taskId, 'assistant', '', 'main', { requestId: request.id, toolCalls: [call] });
    const intent = kernel.prepareIntent(taskId, runId, call, { effectKey: digest({ taskId, messageId: message.id, toolCallId: call.id }), capability: 'fixture.write', resources: ['fixture:counter'] });
    return { id, requestId: request.id, intentId: intent.id };
  };
  kernel.transition(taskId, 'running');
  const originalRun = kernel.createRun(taskId);
  const first = propose(originalRun.id);
  kernel.deny(first.intentId, 'Earlier request declined');
  kernel.addMessage(taskId, 'tool', 'First denial', 'main', { requestId: first.requestId, toolCallId: CALL_ID });
  const second = propose(originalRun.id);
  kernel.transition(taskId, 'waiting_approval');
  kernel.command({ commandId: randomUUID(), type: 'pause', taskId });
  kernel.addMessage(taskId, 'tool', 'Tool was denied: Task control superseded an active run', 'main', { requestId: second.requestId, toolCallId: CALL_ID });
  kernel.command({ commandId: randomUUID(), type: 'resume', taskId });
  kernel.transition(taskId, 'running');
  const current = propose(kernel.createRun(taskId).id);
  kernel.transition(taskId, 'waiting_approval');
  trace = new WorkTrace({ kernel } as unknown as Services, store, value => value);
  trace.sync();
  for (let attempt = 0; attempt < 100 && store.getSetting('kernelCursor', 0) < kernel.latestEventSequence(); attempt++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(store.getSetting('kernelCursor', 0), kernel.latestEventSequence());
  t.diagnostic(JSON.stringify({ first, second, current, calls: store.toolCalls({ taskId }) }));
  for (const historical of [first, second]) {
    assert.equal(store.getTool(historical.id).intentId, historical.intentId);
    assert.equal(store.getTool(historical.id).status, 'denied');
  }
  assert.equal(store.getTool(first.id).result, 'First denial');
  assert.equal(store.getTool(second.id).result, 'Tool was denied: Task control superseded an active run');
  assert.equal(store.getTool(current.id).intentId, current.intentId);
  assert.equal(store.getTool(current.id).status, 'prepared');
  assert.equal(store.getTool(current.id).result, undefined);
  assert.equal(store.getTool(current.id).error, undefined);
  const before = JSON.stringify(store.toolCalls({ taskId }));
  trace.sync();
  assert.equal(JSON.stringify(store.toolCalls({ taskId })), before, 'catch-up must be idempotent');
});
