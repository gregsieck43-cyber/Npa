import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBackend } from '../src/app/backend.js';
import { Kernel, KernelError } from '../src/kernel/index.js';

for (const outcome of ['completed', 'failed', 'cancelled'] as const) test(`side ${outcome} publishes committed live budget and usage events for task and ancestor`, { timeout: 45_000 }, async t => {
  const root = path.resolve(process.env.TEMP ?? '.tmp'), directory = mkdtempSync(path.join(root, 'side-budget-events-'));
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined, sideResponse: Promise<Response> | undefined;
  let release!: () => void, entered!: () => void;
  const providerGate = new Promise<void>(resolve => { release = resolve; });
  const providerEntered = new Promise<void>(resolve => { entered = resolve; });
  t.after(async () => { release(); await sideResponse?.catch(() => undefined); await backend?.close(); assert.equal(path.dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  backend = await startBackend({ projectRoot: process.cwd(), dataDir: path.join(directory, 'data'), mockOptions: {
    fault: outcome === 'failed' ? 'truncated_stream' : 'none', responder: async () => {
      entered(); await providerGate; return { content: 'A pure side answer without any task control.' };
    },
  } });
  await backend.services.runner.stop();
  const kernel = backend.services.kernel;
  const parent = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: 'Parent live budget', workspace: directory, initialStatus: 'paused' } }).taskId!;
  kernel.command({ commandId: randomUUID(), type: 'delegate', taskId: parent, parameters: { objective: 'Child live budget' } });
  const id = kernel.delegations(parent)[0]!.childTaskId;
  kernel.command({ commandId: randomUUID(), type: 'pause', taskId: id });
  const ids = [id, parent], revisions = ids.map(taskId => kernel.getTask(taskId)!.revision);
  const headers = { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' };
  const endpoint = `http://127.0.0.1:${backend.port}/v1/product`;
  const page = async (cursor: number) => {
    const response = await fetch(`${endpoint}/events?cursor=${cursor}&limit=200&waitMs=0`, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); const result = await response.json() as any;
    assert.equal(result.reset, false); return result;
  };
  const historyResponse = await fetch(`${endpoint}/chat/side-history?sessionId=${id}`, { headers });
  assert.equal(historyResponse.status, 200); const history = await historyResponse.json() as any;
  const before = await page(0);
  sideResponse = fetch(`${endpoint}/chat/side-ask`, { method: 'POST', headers, signal: AbortSignal.timeout(30_000), body: JSON.stringify({ sessionId: id, sideSessionId: history.sideSessionId, messageId: 'held-side-answer', question: 'Explain only; do not control this task.', attachments: [], modelId: 'default' }) });
  const signal = AbortSignal.timeout(10_000);
  await Promise.race([providerEntered, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('Provider never reached held response')), { once: true }))]);
  const held = await page(before.nextCursor);
  const unchanged = await page(held.nextCursor);
  assert.equal(unchanged.events.length, 0, 'No repeated projection while the provider is held');
  if (outcome === 'cancelled') {
    const cancellation = await fetch(`${endpoint}/chat/side-cancel`, { method: 'POST', headers, body: JSON.stringify({ sessionId: id, sideSessionId: history.sideSessionId }), signal: AbortSignal.timeout(5000) });
    assert.equal(cancellation.status, 200);
  }
  release();
  const response = await sideResponse;
  if (outcome === 'completed') { assert.equal(response.status, 200); assert.equal(((await response.json()) as any).operations.length, 0); }
  else assert.ok(response.status >= 400);
  const after = await page(unchanged.nextCursor);
  const summarize = (entries: any[], taskId: string) => {
    const events = entries.map(entry => entry.event).filter(event => event.sessionId === taskId);
    return { tasks: events.filter(event => event.type === 'task.updated').map(event => ({ calls: event.task.budget.modelCalls, tokens: event.task.budget.tokens, revision: event.task.revision })),
      metrics: events.filter(event => event.type === 'metrics.updated').map(event => ({ steps: event.metrics.modelSteps, requests: event.metrics.usageCoverage.requests, input: event.metrics.usageCoverage.input.state, output: event.metrics.usageCoverage.output.state })),
      invalidated: events.filter(event => event.type === 'inspector.invalidated').length };
  };
  const expectedUsage = outcome === 'completed' ? 'known' : 'unknown';
  const finalHistory = await (await fetch(`${endpoint}/chat/side-history?sessionId=${id}`, { headers })).json() as any;
  const record = backend.services.harness!.store.getRequest(finalHistory.items[0].requestId);
  const tokens = outcome === 'completed' ? record.usage!.total_tokens! : 0;
  if (outcome === 'completed') assert.ok(tokens > 0, 'The provider reported real usage for the completed request');
  for (const [index, taskId] of ids.entries()) {
    assert.equal(kernel.getTask(taskId)!.revision, revisions[index]); assert.equal(kernel.getBudgets(taskId).modelCalls, 1);
    assert.equal(kernel.eventCount(taskId, 'budget.consumed'), 1); assert.equal(kernel.eventCount(taskId, 'command.side_applied'), 0);
    assert.deepEqual({ pending: summarize(held.events, taskId), settled: summarize(after.events, taskId) }, {
      pending: { tasks: [{ calls: 1, tokens: 0, revision: revisions[index] }], metrics: [{ steps: 1, requests: 1, input: 'unknown', output: 'unknown' }], invalidated: 1 },
      settled: { tasks: [{ calls: 1, tokens, revision: revisions[index] }], metrics: [{ steps: 1, requests: 1, input: expectedUsage, output: expectedUsage }], invalidated: 1 },
    }, `${outcome}: task and ancestor must receive actual dispatch/settlement projections without duplicate side budget events`);
  }
  assert.equal(record.status, outcome); assert.equal(kernel.sideRequests.get(record.id)!.usageState, expectedUsage);
  assert.deepEqual(new Set(record.budgetTaskIds), new Set(ids)); assert.equal(backend.mock.requests(), 1);
});

for (const change of ['none', 'goal', 'permission', 'control'] as const) test(`real HTTP side inspect then next-request manage preserves accounting but rejects ${change} authority change`, { timeout: 45_000 }, async t => {
  const root = path.resolve(process.env.TEMP ?? '.tmp'), directory = mkdtempSync(path.join(root, 'side-authority-'));
  const workspace = path.join(directory, 'workspace'); mkdirSync(workspace);
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined, taskId = '', inspected: any, manageResult: any;
  const observations: { revision: number; modelCalls: number }[] = [];
  t.after(async () => { await backend?.close(); assert.equal(path.dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  backend = await startBackend({ projectRoot: process.cwd(), dataDir: path.join(directory, 'data'), mockOptions: { responder: body => {
    const messages = body.messages as any[], last = messages.findLast(item => item.role === 'tool');
    if (!last) return { content: '', toolCalls: [{ id: 'actual-inspect', name: 'inspect_task', arguments: {} }] };
    if (last.tool_call_id === 'actual-inspect') {
      inspected = JSON.parse(last.content);
      const kernel = backend!.services.kernel, actual = kernel.getTask(taskId)!;
      observations.push({ revision: actual.revision, modelCalls: actual.modelCalls });
      if (change === 'goal') kernel.command({ commandId: randomUUID(), type: 'revise_goal', taskId, parameters: { goal: { objective: 'Real operator revised goal' }, reason: 'Independent control change' } });
      if (change === 'permission') kernel.command({ commandId: randomUUID(), type: 'set_permission', taskId, parameters: { permissionMode: 'read-only', reason: 'Independent permission change' } });
      if (change === 'control') kernel.command({ commandId: randomUUID(), type: 'pause', taskId });
      return { content: '', toolCalls: [{ id: 'actual-manage', name: 'manage_task', arguments: { action: 'pause', parameters: {}, expectedRevision: inspected.revision, goalVersion: inspected.goalVersion, generation: inspected.generation } }] };
    }
    manageResult = JSON.parse(last.content);
    return { content: 'The actual control receipt has been observed.' };
  } } });
  await backend.services.runner.stop();
  const kernel = backend.services.kernel;
  taskId = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: 'Bound side control', workspace, permissionMode: 'full-access' } }).taskId!;
  kernel.createRun(taskId); kernel.transition(taskId, 'running'); kernel.transition(taskId, 'waiting_input', { waitingReason: 'Awaiting side control' });
  const before = kernel.getTask(taskId)!;
  const input = { sessionId: taskId, messageId: 'inspect-then-control', question: 'Inspect this task and then pause it.', attachments: [], modelId: 'default' };
  const ask = async () => {
    const response = await fetch(`http://127.0.0.1:${backend!.port}/v1/product/chat/side-ask`, { method: 'POST', headers: { Authorization: 'Bearer ' + backend!.token, 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) });
    const answer = await response.json() as any; assert.equal(response.status, 200, JSON.stringify(answer)); return answer;
  };
  const answer = await ask();
  assert.equal(backend.mock.requests(), 3, 'inspect, manage and final answer are three actual provider requests');
  assert.equal(kernel.getBudgets(taskId).modelCalls, 3); assert.equal(kernel.getTask(taskId)!.modelCalls, 3);
  assert.equal(kernel.getSideBudgets(taskId)[0]!.modelCalls, 3); assert.equal(kernel.eventCount(taskId, 'budget.consumed'), 3);
  assert.equal(kernel.latestEvent(taskId, 'budget.consumed')!.payload.modelCalls, 3);
  const projected = await fetch(`http://127.0.0.1:${backend.port}/v1/product/tasks/${taskId}`, { headers: { Authorization: 'Bearer ' + backend.token }, signal: AbortSignal.timeout(5000) });
  assert.equal(projected.status, 200);
  const detail = await projected.json() as any;
  assert.equal(detail.budget.modelCalls, 3); assert.equal(detail.revision, kernel.getTask(taskId)!.revision);
  if (change === 'none') {
    assert.equal(answer.operations.length, 1, JSON.stringify(manageResult));
    assert.equal(kernel.getTask(taskId)!.status, 'paused');
    assert.equal(inspected.revision, before.revision, 'first side accounting does not invalidate authority');
    assert.equal(observations[0]!.revision, inspected.revision, 'next dispatch accounting preserves inspected authority');
    assert.equal(kernel.eventCount(taskId, 'command.side_applied'), 1);
  } else {
    assert.equal(answer.operations.length, 0); assert.equal(manageResult.ok, false); assert.match(manageResult.error, /version changed/);
    assert.equal(kernel.eventCount(taskId, 'command.side_applied'), 0);
    if (change === 'goal') assert.equal(kernel.getTask(taskId)!.goal.objective, 'Real operator revised goal');
    if (change === 'permission') assert.equal(kernel.permissionMode(taskId), 'read-only');
  }
  assert.deepEqual(await ask(), answer); assert.equal(backend.mock.requests(), 3, 'same user message is not redispatched');
  assert.equal(kernel.getBudgets(taskId).modelCalls, 3);
});

test('side ledger charges child and ancestor atomically without changing either authority revision; main charge retains revision behavior', t => {
  const root = path.resolve(process.env.TEMP ?? '.tmp'), directory = mkdtempSync(path.join(root, 'side-ancestor-'));
  const kernel = new Kernel(directory);
  t.after(() => { kernel.close(); assert.equal(path.dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  const parent = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { goal: { objective: 'Bounded parent', constraints: [], acceptance: [], maxModelCalls: 2 } } }).taskId!;
  kernel.command({ commandId: randomUUID(), type: 'delegate', taskId: parent, parameters: { objective: 'Bounded child' } });
  const child = kernel.delegations(parent)[0]!.childTaskId;
  const revisions = [kernel.getTask(parent)!.revision, kernel.getTask(child)!.revision];
  kernel.sideRequests.dispatch('side-one', child, 'side-session');
  for (const id of [parent, child]) { assert.equal(kernel.getBudgets(id).modelCalls, 1); assert.equal(kernel.getTask(id)!.modelCalls, 1); }
  assert.deepEqual([kernel.getTask(parent)!.revision, kernel.getTask(child)!.revision], revisions);
  kernel.sideRequests.settle('side-one', 'completed', { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
  assert.equal(kernel.sideRequests.get('side-one')!.usageState, 'known');
  assert.throws(() => kernel.sideRequests.dispatch('side-one', child, 'side-session'), /already dispatched/);
  kernel.consumeModelCall(parent); assert.equal(kernel.getTask(parent)!.revision, revisions[0]! + 1, 'main accounting keeps the old revision contract');
  assert.throws(() => kernel.sideRequests.dispatch('side-over-budget', child, 'side-session'), error => error instanceof KernelError && error.code === 'BUDGET_EXHAUSTED');
  assert.equal(kernel.getBudgets(child).modelCalls, 1); assert.equal(kernel.getSideBudgets(child)[0]!.modelCalls, 1);
  assert.equal(kernel.sideRequests.get('side-over-budget'), undefined); assert.equal(kernel.getTask(child)!.revision, revisions[1]);
});

test('unknown side accounting survives restart without replay or lost budget projection', t => {
  const root = path.resolve(process.env.TEMP ?? '.tmp'), directory = mkdtempSync(path.join(root, 'side-unknown-'));
  let kernel = new Kernel(directory);
  t.after(() => { kernel.close(); assert.equal(path.dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  const id = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { initialStatus: 'paused', title: 'Unknown side request' } }).taskId!;
  const revision = kernel.getTask(id)!.revision;
  kernel.sideRequests.dispatch('uncertain-side-request', id, 'side-session');
  kernel.close(); kernel = new Kernel(directory);
  assert.equal(kernel.sideRequests.get('uncertain-side-request')!.status, 'unknown');
  assert.equal(kernel.sideRequests.get('uncertain-side-request')!.usageState, 'unknown');
  assert.throws(() => kernel.sideRequests.dispatch('uncertain-side-request', id, 'side-session'), /already dispatched/);
  assert.equal(kernel.getTask(id)!.revision, revision); assert.equal(kernel.getTask(id)!.modelCalls, 1);
  assert.equal(kernel.getBudgets(id).modelCalls, 1); assert.equal(kernel.getSideBudgets(id)[0]!.modelCalls, 1);
  assert.equal(kernel.eventCount(id, 'budget.consumed'), 1);
});
