import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { resourceBudget } from '../src/app/resource-budget.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { startBackend } from '../src/app/backend.js';
import { Services } from '../src/app/services.js';
import { startMockProvider, type MockCompletion, type MockProviderOptions } from '../src/fixtures/mock-provider.js';
import { ModelDiagnosticError } from '../src/runtime/model.js';
import { assertProjectFixtureRoot } from './project-boundary.js';

function gate() {
  let entered!: () => void, release!: (result: MockCompletion) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const response = new Promise<MockCompletion>(resolve => { release = resolve; });
  return { started, response, entered, release };
}

function fixture(t: TestContext) {
  const tempRoot = path.resolve('.tmp');
  assertProjectFixtureRoot(tempRoot);
  mkdirSync(tempRoot, { recursive: true });
  const owned = mkdtempSync(path.join(tempRoot, 'app-side-cancel-'));
  const gates = new Map<string, ReturnType<typeof gate>>(), closers: (() => Promise<void>)[] = [];
  const mockOptions: MockProviderOptions = {
    responder: body => {
      const message = body.messages.findLast((item: any) => item.role === 'user' && item.content?.startsWith('side-fixture-'))?.content;
      const pending = gates.get(message);
      assert.ok(pending, 'Only an explicitly gated side request may reach this fixture HTTP provider');
      pending.entered(); return pending.response;
    },
  };
  const addGate = (message: string) => { const pending = gate(); gates.set(message, pending); return pending; };
  t.after(async () => {
    for (const pending of gates.values()) pending.release({ content: 'Fixture cleanup release.' });
    try {
      for (const close of closers.reverse()) await close();
    } finally {
      const relative = path.relative(realpathSync(tempRoot), realpathSync(owned));
      assert.ok(relative.startsWith('app-side-cancel-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
      rmSync(owned, { recursive: true });
    }
  });
  return { owned, closers, mockOptions, addGate };
}

async function servicesFixture(t: TestContext) {
  const f = fixture(t), provider = await startMockProvider(f.mockOptions);
  const services = new Services(path.join(f.owned, 'data'), f.owned, provider.url, path.join(f.owned, 'product'));
  f.closers.push(async () => { await services.stop(); await services.external.close(); services.integrations.close(); services.kernel.close(); await provider.close(); });
  return { ...f, services };
}

function createTask(services: Services) {
  return services.command({ commandId: randomUUID(), type: 'create_task', parameters: { goal: {
    objective: 'Keep main ownership while side sessions advise.', constraints: [], acceptance: [], mode: 'collaborative', maxModelCalls: 8,
  } } }).taskId!;
}

function mainState(services: Services, taskId: string) {
  const snapshot = services.snapshot(taskId);
  return { task: snapshot.selectedTask, budget: snapshot.budget, intents: snapshot.intents, messages: services.kernel.getMessages(taskId, 'main'), runs: snapshot.runs };
}
function assertOnlySideAccounting(services: Services, taskId: string, before: ReturnType<typeof mainState>, calls: number) {
  const after = mainState(services, taskId);
  assert.deepEqual(after, { ...before, task: { ...before.task!, modelCalls: before.task!.modelCalls + calls, updatedAt: after.task!.updatedAt }, budget: { ...before.budget!, modelCalls: before.budget!.modelCalls + calls } }, 'Side replies preserve main control revision, execution authority and history, while every dispatched attempt consumes the shared budget');
}
const cancelled = (error: unknown) => error instanceof ModelDiagnosticError && error.code === 'cancelled';

test('side cancellation isolates task/session ownership, rejects duplicate answers and frees the cancelled session', { timeout: 15_000 }, async t => {
  const started = performance.now(), stages: {stage:string; elapsedMs:number}[] = [];
  const loop = monitorEventLoopDelay({resolution:20}); loop.enable();
  const stage = (name:string) => stages.push({stage:name, elapsedMs:Math.round(performance.now()-started)});
  t.after(() => { loop.disable(); t.diagnostic(JSON.stringify({stages, elapsedMs:Math.round(performance.now()-started), eventLoopMaxMs:loop.max/1e6, resource:resourceBudget.status()})); });
  stage('fixture-start');
  const f = await servicesFixture(t), taskA = createTask(f.services), taskB = createTask(f.services);
  stage('fixture-created');
  await f.services.proposeTool({ taskId: taskA, path: 'pending-main.txt', content: 'Exact operator proposal remains pending.' }, 'write_file');
  stage('main-proposal-prepared');
  const beforeA = mainState(f.services, taskA), beforeB = mainState(f.services, taskB);
  const gateA = f.addGate('side-fixture-A'), gateB = f.addGate('side-fixture-B'), gateOther = f.addGate('side-fixture-other');
  const answerA = f.services.sidechat({ taskId: taskA, sessionId: 'shared', message: 'side-fixture-A' });
  const rejectA = assert.rejects(answerA, cancelled);
  const answerB = f.services.sidechat({ taskId: taskB, sessionId: 'shared', message: 'side-fixture-B' });
  const answerOther = f.services.sidechat({ taskId: taskA, sessionId: 'other', message: 'side-fixture-other' });
  stage('three-side-requests-started');
  await Promise.all([gateA.started, gateB.started, gateOther.started]);
  stage('all-three-provider-requests-entered');
  await assert.rejects(f.services.sidechat({ taskId: taskA, sessionId: 'shared', message: 'Duplicate must not become history.' }), /already has an active answer/);
  assert.equal(f.services.kernel.getMessages(taskA, 'shared').length, 1);
  assert.equal(f.services.kernel.getSideBudgets(taskA).find(budget => budget.sessionId === 'shared')!.modelCalls, 1);
  assert.equal(f.services.cancelSidechat({ taskId: taskA, sessionId: 'missing' }).cancelled, false);
  assert.throws(() => f.services.cancelSidechat({ taskId: taskA, sessionId: 'main' }), /separate side session/);
  assert.deepEqual(f.services.cancelSidechat({ taskId: taskA, sessionId: 'shared' }), { taskId: taskA, sessionId: 'shared', cancelled: true });
  await rejectA;
  stage('cancelled-request-settled');
  assert.equal(f.services.cancelSidechat({ taskId: taskA, sessionId: 'shared' }).cancelled, false);
  gateB.release({ content: 'Other task completed independently.' });
  gateOther.release({ content: 'Other session completed independently.' });
  assert.equal((await answerB).content, 'Other task completed independently.');
  assert.equal((await answerOther).content, 'Other session completed independently.');
  stage('other-requests-settled');
  assert.deepEqual(f.services.kernel.getMessages(taskA, 'shared').map(message => [message.role, message.content]), [['user', 'side-fixture-A']]);
  const retryGate = f.addGate('side-fixture-retry');
  const retry = f.services.sidechat({ taskId: taskA, sessionId: 'shared', message: 'side-fixture-retry' });
  await retryGate.started; retryGate.release({ content: 'The freed session can answer again.' });
  stage('retry-entered');
  assert.equal((await retry).content, 'The freed session can answer again.');
  stage('retry-settled');
  assert.equal(f.services.kernel.getSideBudgets(taskA).find(budget => budget.sessionId === 'shared')!.modelCalls, 2);
  const diagnostic = f.services.snapshot(taskA).events.filter(event => event.type === 'side.diagnostic');
  assert.equal(diagnostic.length, 1); assert.equal(diagnostic[0]!.payload.sessionId, 'shared'); assert.equal(diagnostic[0]!.payload.cancelled, true);
  assert.equal(f.services.snapshot(taskB).events.some(event => event.type === 'side.diagnostic'), false);
  assertOnlySideAccounting(f.services, taskA, beforeA, 3);
  assertOnlySideAccounting(f.services, taskB, beforeB, 1);
});

test('the HTTP side cancellation route interrupts its in-flight reply and retains the user plus diagnostic', { timeout: 15_000 }, async t => {
  const f = fixture(t), pending = f.addGate('side-fixture-http');
  const backend = await startBackend({ dataDir: path.join(f.owned, 'data'), projectRoot: f.owned, productRoot: path.join(f.owned, 'product'), mockOptions: f.mockOptions });
  f.closers.push(backend.close);
  const taskId = createTask(backend.services);
  backend.services.command({ commandId: randomUUID(), taskId, type: 'pause' });
  const before = mainState(backend.services, taskId);
  const post = (route: string, input: Record<string, unknown>) => fetch(`http://127.0.0.1:${backend.port}${route}`, {
    method: 'POST', headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  const answer = post('/v1/sidechat', { taskId, sessionId: 'http-side', message: 'side-fixture-http' });
  await pending.started;
  const cancellation = await post('/v1/sidechat/cancel', { taskId, sessionId: 'http-side' });
  assert.equal(cancellation.status, 200);
  assert.deepEqual(await cancellation.json(), { taskId, sessionId: 'http-side', cancelled: true });
  const rejected = await answer;
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json() as { error: string }).error, /cancelled/i);
  assert.deepEqual(backend.services.kernel.getMessages(taskId, 'http-side').map(message => [message.role, message.content]), [['user', 'side-fixture-http']]);
  assert.ok(backend.services.snapshot(taskId).events.some(event => event.type === 'side.diagnostic' && event.payload.sessionId === 'http-side' && event.payload.cancelled === true));
  assertOnlySideAccounting(backend.services, taskId, before, 1);
});

test('stopping services aborts and awaits unfinished side answers while preserving their original inputs', { timeout: 15_000 }, async t => {
  const f = await servicesFixture(t), taskId = createTask(f.services), before = mainState(f.services, taskId);
  const pendingA = f.addGate('side-fixture-stop-A'), pendingB = f.addGate('side-fixture-stop-B');
  const answerA = f.services.sidechat({ taskId, sessionId: 'stop-A', message: 'side-fixture-stop-A' });
  const answerB = f.services.sidechat({ taskId, sessionId: 'stop-B', message: 'side-fixture-stop-B' });
  const rejections = [assert.rejects(answerA, cancelled), assert.rejects(answerB, cancelled)];
  await Promise.all([pendingA.started, pendingB.started]);
  await f.services.stop();
  await Promise.all(rejections);
  for (const sessionId of ['stop-A', 'stop-B']) {
    assert.equal(f.services.cancelSidechat({ taskId, sessionId }).cancelled, false, 'stop() must await active-side cleanup');
    assert.deepEqual(f.services.kernel.getMessages(taskId, sessionId).map(message => [message.role, message.content]), [['user', `side-fixture-${sessionId}`]]);
    assert.ok(f.services.snapshot(taskId).events.some(event => event.type === 'side.diagnostic' && event.payload.sessionId === sessionId && event.payload.cancelled === true));
  }
  assertOnlySideAccounting(f.services, taskId, before, 2);
});

test('actual side HTTP wire keeps the current question last and the read-only main snapshot out of raw history', { timeout: 15_000 }, async t => {
  const f = fixture(t), requests: any[] = [];
  const provider = await startMockProvider({ trace: body => requests.push(body) });
  const services = new Services(path.join(f.owned, 'data'), f.owned, provider.url, path.join(f.owned, 'product'));
  f.closers.push(async () => { await services.stop(); await services.external.close(); services.integrations.close(); services.kernel.close(); await provider.close(); });
  const taskId = createTask(services), sessionId = 'wire-order';
  await services.proposeTool({ taskId, path: 'pending-main.txt', content: 'Main operation still needs approval.' }, 'write_file');
  const before = mainState(services, taskId), previous = 'Previous side question: explain the saved goal.';
  const current = 'Latest side question:\n\n## Read-only advice\n\n- **Retain main ownership**\n- Keep `approval` under program control.';
  await services.sidechat({ taskId, sessionId, message: previous });
  const answer = await services.sidechat({ taskId, sessionId, message: current });
  assert.equal(requests.length, 2);
  assertOnlySideAccounting(services, taskId, before, 2);
  const wire = requests[1];
  assert.match(wire.messages[0].content, /SIDE ROLE/);
  assert.equal(wire.tools, undefined, 'The auxiliary session must have no execution tool grant');
  const snapshots = wire.messages.filter((message: any) => message.content?.startsWith('Read-only main task snapshot: '));
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].role, 'user', 'The program snapshot is contextual data, not new system authority');
  const snapshot = JSON.parse(snapshots[0].content.slice('Read-only main task snapshot: '.length));
  assert.equal(snapshot.id, taskId); assert.equal(snapshot.revision, before.task!.revision); assert.equal(snapshot.status, before.task!.status);
  assert.deepEqual(wire.messages.at(-1), { role: 'user', content: current }, 'The latest side question must remain the final user turn after derived context is added');
  assert.match(answer.content, /Latest side question/);
  assert.ok(answer.content.includes('**Retain main ownership**'));
  const raw = services.kernel.getMessages(taskId, sessionId);
  assert.deepEqual(raw.filter(message => message.role === 'user').map(message => message.content), [previous, current]);
  assert.equal(raw.some(message => message.content.includes('Read-only main task snapshot: ')), false, 'The derived main snapshot must not become a persisted side message');
});
