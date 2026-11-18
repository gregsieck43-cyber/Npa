import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Kernel, KernelError } from '../src/kernel/index.js';
import type { Command, Task } from '../src/contracts.js';

function fixture(body: (kernel: Kernel, directory: string) => void): void {
  const root = path.resolve('.tmp');
  const directory = mkdtempSync(path.join(root, 'kernel-budget-test-'));
  const kernel = new Kernel(directory);
  try { body(kernel, directory); }
  finally { kernel.close(); assert.ok(directory.startsWith(root + path.sep)); rmSync(directory, { recursive: true, force: true }); }
}
function create(kernel: Kernel, maxModelCalls = 20, maxToolCalls = 100): Task {
  const ack = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { goal: {
    objective: 'Original objective', constraints: ['Retain source history'], acceptance: ['Produce checked artifact'],
    mode: 'autonomous', maxModelCalls, maxToolCalls,
  } } });
  return kernel.getTask(ack.taskId!)!;
}
function delegate(kernel: Kernel, parentId: string): Task {
  kernel.command({ commandId: randomUUID(), type: 'delegate', taskId: parentId, parameters: { objective: 'Scoped child' } });
  return kernel.getTask(kernel.delegations(parentId).at(-1)!.childTaskId)!;
}
function run(kernel: Kernel, taskId: string): string {
  const active = kernel.createRun(taskId); kernel.transition(taskId, 'running'); return active.id;
}
function approved(kernel: Kernel, taskId: string, runId: string): string {
  const intent = kernel.prepareIntent(taskId, runId, { id: randomUUID(), name: 'fixture_increment', arguments: { path: 'counter.txt' } });
  kernel.approve(intent.id); return intent.id;
}
function complete(kernel: Kernel, taskId: string): void {
  const runId = run(kernel, taskId);
  kernel.verify(taskId, runId, { passed: true, reviewer: 'independent-fixture' });
  kernel.transition(taskId, 'completed', { result: 'Verified result' }); kernel.finishRun(runId, 'completed');
}
const code = (expected: string) => (error: unknown) => error instanceof KernelError && error.code === expected;
function renew(taskId: string, maxModelCalls: number, maxToolCalls: number): Command {
  return { commandId: randomUUID(), type: 'renew_budget', origin: 'operator', taskId, parameters: { maxModelCalls, maxToolCalls, reason: 'Operator authorized these finite totals' } };
}

test('goal and budget controls reject model authority, side scope and unbounded limits without mutation', () => fixture(kernel => {
  const task = create(kernel); const before = kernel.getTask(task.id)!;
  const revision: Command = { commandId: randomUUID(), type: 'revise_goal', origin: 'model', taskId: task.id, parameters: { goal: { objective: 'Model changed goal' }, reason: 'model' } };
  assert.throws(() => kernel.command(revision), code('OPERATOR_REQUIRED'));
  assert.throws(() => kernel.command({ ...renew(task.id, 30, 100), origin: 'model' }), code('OPERATOR_REQUIRED'));
  assert.throws(() => kernel.command({ ...renew(task.id, 30, 100), parameters: { maxModelCalls: 30, maxToolCalls: 100, reason: 'side', sessionId: 'side-1' } }), code('SIDE_SESSION_CONTROL'));
  for (const limit of [Infinity, NaN, 0, -1, 1.5, 1000001]) assert.throws(() => kernel.command(renew(task.id, limit, 100)), code('INVALID_BUDGET'));
  assert.throws(() => kernel.command({ ...renew(task.id, 20, 100), parameters: { maxModelCalls: 20, reason: 'Missing explicit tool limit' } }), code('INVALID_BUDGET'));
  assert.deepEqual(kernel.getTask(task.id), before);
  assert.equal(kernel.getBudgets(task.id).modelCalls, 0);
  assert.equal(kernel.events(task.id).filter(event => event.type === 'goal.revised' || event.type === 'budget.renewed').length, 0);
}));

test('revised goal keeps original messages and usage, versions objective and fences old approval and child work', () => fixture(kernel => {
  const task = create(kernel, 5, 7); const child = delegate(kernel, task.id); const runId = run(kernel, task.id);
  kernel.consumeModelCall(task.id, runId); const intentId = approved(kernel, task.id, runId); run(kernel, child.id);
  const command: Command = { commandId: randomUUID(), type: 'revise_goal', origin: 'operator', taskId: task.id, parameters: {
    goal: { objective: '  Revised objective  ', acceptance: ['New checked acceptance'] }, reason: 'User changed expected deliverable',
  } };
  const ack = kernel.command(command); const next = kernel.getTask(task.id)!;
  assert.equal(next.goal.objective, 'Revised objective'); assert.equal(next.goalVersion, 2);
  assert.deepEqual(next.goal.constraints, ['Retain source history']); assert.equal(next.modelCalls, 1);
  assert.equal(next.goal.maxModelCalls, 5); assert.equal(next.goal.maxToolCalls, 7);
  assert.equal(next.status, 'queued'); assert.equal(next.generation, task.generation + 1);
  assert.equal(next.policyEpoch, task.policyEpoch + 1); assert.equal(kernel.getTask(child.id)!.status, 'cancelled');
  assert.throws(() => kernel.assertFence(task.id, runId), code('STALE_GENERATION'));
  assert.throws(() => kernel.dispatch(intentId), code('STALE_GENERATION'));
  assert.equal(kernel.getIntent(intentId)!.state, 'denied');
  assert.equal(kernel.getMessages(task.id)[0].content, 'Original objective');
  assert.equal(kernel.getMessages(task.id).at(-1)!.content, '  Revised objective  ');
  assert.equal(kernel.command(command).status, 'duplicate'); assert.equal(kernel.command(command).revision, ack.revision);
  assert.equal(kernel.events(task.id).filter(event => event.type === 'goal.revised').length, 1);
  assert.throws(() => kernel.command({ ...command, parameters: { ...command.parameters, reason: 'Different intent' } }), code('IDEMPOTENCY_CONFLICT'));
}));

test('revision preserves inherited constraints and paused ownership and requires new acceptance of old child result', () => fixture(kernel => {
  const parent = create(kernel); const child = delegate(kernel, parent.id); complete(kernel, child.id);
  kernel.command({ commandId: randomUUID(), type: 'accept_result', taskId: parent.id, parameters: { childTaskId: child.id } });
  kernel.command({ commandId: randomUUID(), type: 'revise_goal', taskId: parent.id, parameters: { goal: { objective: 'Changed parent acceptance' }, reason: 'New objective' } });
  const parentRun = run(kernel, parent.id); kernel.verify(parent.id, parentRun, { passed: true, reviewer: 'independent-fixture' });
  assert.throws(() => kernel.transition(parent.id, 'completed'), code('UNACCEPTED_DELEGATION'));
  kernel.command({ commandId: randomUUID(), type: 'accept_result', taskId: parent.id, parameters: { childTaskId: child.id } });
  kernel.verify(parent.id, parentRun, { passed: true, reviewer: 'independent-fixture' }); kernel.transition(parent.id, 'completed');
  const otherParent = create(kernel); const pausedChild = delegate(kernel, otherParent.id);
  kernel.command({ commandId: randomUUID(), type: 'pause', taskId: otherParent.id });
  kernel.command({ commandId: randomUUID(), type: 'revise_goal', taskId: pausedChild.id, parameters: {
    goal: { objective: 'Revised child', constraints: [] }, reason: 'Operator narrowed child work',
  } });
  assert.equal(kernel.getTask(pausedChild.id)!.status, 'paused');
  assert.deepEqual(kernel.getTask(pausedChild.id)!.goal.constraints, ['Retain source history']);
  assert.throws(() => kernel.command({ commandId: randomUUID(), type: 'resume', taskId: pausedChild.id }), code('PARENT_PAUSED'));
}));

test('budget renewal uses new finite totals, preserves original consumption, fences grants and retry does not reset', () => fixture(kernel => {
  const task = create(kernel, 2, 3); const runId = run(kernel, task.id);
  kernel.consumeModelCall(task.id, runId); kernel.consumeModelCall(task.id, runId);
  assert.throws(() => kernel.consumeModelCall(task.id, runId), code('BUDGET_EXHAUSTED'));
  const oldIntent = approved(kernel, task.id, runId);
  kernel.transition(task.id, 'failed', { error: 'Saved finite model budget exhausted' });
  assert.throws(() => kernel.command(renew(task.id, 1, 3)), code('BUDGET_BELOW_USAGE'));
  const command = renew(task.id, 4, 5); const ack = kernel.command(command);
  assert.equal(kernel.getTask(task.id)!.status, 'queued');
  assert.equal(kernel.getTask(task.id)!.goalVersion, task.goalVersion); assert.equal(kernel.getBudgets(task.id).modelCalls, 2);
  assert.equal(kernel.getBudgets(task.id).maxModelCalls, 4); assert.equal(kernel.getBudgets(task.id).maxToolCalls, 5);
  assert.throws(() => kernel.dispatch(oldIntent), code('STALE_GENERATION'));
  assert.equal(kernel.command(command).status, 'duplicate'); assert.equal(kernel.command(command).revision, ack.revision);
  kernel.command({ commandId: randomUUID(), type: 'retry', taskId: task.id });
  assert.equal(kernel.getBudgets(task.id).modelCalls, 2);
  kernel.consumeModelCall(task.id, run(kernel, task.id));
  assert.equal(kernel.getBudgets(task.id).modelCalls, 3);
  assert.equal(kernel.events(task.id).filter(event => event.type === 'budget.consumed').length, 3);
  const event = kernel.events(task.id).find(event => event.type === 'budget.renewed')!;
  assert.equal((event.payload.previous as { modelCalls: number }).modelCalls, 2);
  assert.equal((event.payload.budget as { maxModelCalls: number }).maxModelCalls, 4);
}));

test('tool dispatch charges cumulative ancestor totals once and exhaustion leaves approval and child counters intact', () => fixture(kernel => {
  const parent = create(kernel, 20, 1); const first = delegate(kernel, parent.id); const second = delegate(kernel, parent.id);
  const firstRun = run(kernel, first.id); const secondRun = run(kernel, second.id);
  const effect = approved(kernel, first.id, firstRun); kernel.dispatch(effect); kernel.receipt(effect, { value: 1 });
  assert.equal(kernel.getBudgets(parent.id).toolCalls, 1); assert.equal(kernel.getBudgets(first.id).toolCalls, 1);
  assert.throws(() => kernel.dispatch(effect), code('INVALID_INTENT_STATE'));
  assert.equal(kernel.getBudgets(parent.id).toolCalls, 1);
  const blocked = approved(kernel, second.id, secondRun);
  assert.throws(() => kernel.dispatch(blocked), code('TOOL_BUDGET_EXHAUSTED'));
  assert.equal(kernel.getIntent(blocked)!.state, 'approved'); assert.equal(kernel.getBudgets(second.id).toolCalls, 0);
  kernel.command(renew(parent.id, 20, 2));
  assert.throws(() => kernel.dispatch(blocked), code('STALE_GENERATION'));
  const nextRun = run(kernel, second.id); const nextEffect = approved(kernel, second.id, nextRun); kernel.dispatch(nextEffect);
  assert.equal(kernel.getBudgets(parent.id).toolCalls, 2); assert.equal(kernel.getBudgets(second.id).toolCalls, 1);
  kernel.recover(); assert.equal(kernel.getIntent(nextEffect)!.state, 'unknown');
  assert.equal(kernel.getBudgets(parent.id).toolCalls, 2);
  kernel.reconcile(nextEffect, { value: 1 });
  assert.equal(kernel.getBudgets(parent.id).toolCalls, 2);
  assert.throws(() => kernel.command(renew(parent.id, 20, 1)), code('BUDGET_BELOW_USAGE'));
}));

test('renewal keeps settled child verification current and cancelled tasks cannot reopen through operator controls', () => fixture(kernel => {
  const parent = create(kernel); const child = delegate(kernel, parent.id); complete(kernel, child.id);
  kernel.command({ commandId: randomUUID(), type: 'accept_result', taskId: parent.id, parameters: { childTaskId: child.id } });
  const before = kernel.getTask(child.id)!; kernel.command(renew(parent.id, 30, 150));
  assert.deepEqual(kernel.getTask(child.id), before);
  const parentRun = run(kernel, parent.id); kernel.verify(parent.id, parentRun, { passed: true, reviewer: 'independent-fixture' }); kernel.transition(parent.id, 'completed');
  const cancelled = create(kernel); kernel.command({ commandId: randomUUID(), type: 'cancel', taskId: cancelled.id });
  assert.throws(() => kernel.command(renew(cancelled.id, 30, 150)), code('CANCELLED_TASK'));
  assert.throws(() => kernel.command({ commandId: randomUUID(), type: 'revise_goal', taskId: cancelled.id, parameters: { goal: { objective: 'Reopen cancelled' }, reason: 'Try again' } }), code('CANCELLED_TASK'));
}));

test('side model quotas are durable per session and never consume primary or ancestor authority', () => fixture((kernel, directory) => {
  const parent = create(kernel, 1); const child = delegate(kernel, parent.id); const before = kernel.getTask(child.id)!;
  const parentBefore = kernel.getTask(parent.id)!;
  for (let count = 0; count < 20; count++) assert.equal(kernel.consumeSideModelCall(child.id, 'side-review').modelCalls, count + 1);
  assert.throws(() => kernel.consumeSideModelCall(child.id, 'side-review'), code('SIDE_BUDGET_EXHAUSTED'));
  assert.equal(kernel.consumeSideModelCall(child.id, 'side-explanation').modelCalls, 1);
  assert.throws(() => kernel.consumeSideModelCall(child.id, 'main'), code('INVALID_SIDE_SESSION'));
  assert.deepEqual(kernel.getTask(child.id), before); assert.deepEqual(kernel.getTask(parent.id), parentBefore);
  assert.equal(kernel.getBudgets(child.id).modelCalls, 0); assert.equal(kernel.getBudgets(parent.id).modelCalls, 0);
  const reopened = new Kernel(directory);
  try {
    assert.equal(reopened.getSideBudgets(child.id).find(budget => budget.sessionId === 'side-review')!.modelCalls, 20);
    assert.throws(() => reopened.consumeSideModelCall(child.id, 'side-review'), code('SIDE_BUDGET_EXHAUSTED'));
    assert.equal(reopened.getSideBudgets(parent.id).length, 0);
  } finally { reopened.close(); }
  kernel.consumeModelCall(child.id, run(kernel, child.id));
  assert.equal(kernel.getBudgets(parent.id).modelCalls, 1);
  assert.throws(() => kernel.consumeModelCall(parent.id), code('BUDGET_EXHAUSTED'));
}));

test('schema v1 migration reconstructs historical descendant tool usage once and keeps original model usage', () => {
  const root = path.resolve('.tmp'); const directory = mkdtempSync(path.join(root, 'kernel-budget-migration-'));
  const original = new Kernel(directory); const parent = create(original); const child = delegate(original, parent.id);
  original.consumeModelCall(child.id, run(original, child.id));
  const parentRun = run(original, parent.id); const parentIntent = approved(original, parent.id, parentRun);
  original.dispatch(parentIntent); original.receipt(parentIntent, { value: 1 });
  const childRun = original.getRuns(child.id).at(-1)!.id;
  const childIntent = approved(original, child.id, childRun); original.dispatch(childIntent); original.receipt(childIntent, { value: 1 });
  original.close();
  // A saved v1 fixture has the same raw histories and attempts, without the v2 budget columns.
  const legacy = new DatabaseSync(path.join(directory, 'kernel.sqlite'));
  legacy.exec('ALTER TABLE budgets DROP COLUMN max_tool_calls; ALTER TABLE budgets DROP COLUMN tool_calls; DROP TABLE side_budgets; DELETE FROM schema_version WHERE version=2;');
  legacy.close();
  const upgraded = new Kernel(directory);
  try {
    assert.equal(upgraded.storageInfo().schemaVersion, 4);
    assert.equal(upgraded.getBudgets(parent.id).toolCalls, 2); assert.equal(upgraded.getBudgets(child.id).toolCalls, 1);
    assert.equal(upgraded.getBudgets(parent.id).modelCalls, 1); assert.equal(upgraded.getBudgets(child.id).modelCalls, 1);
    assert.equal(upgraded.getMessages(parent.id)[0].content, 'Original objective');
    const reopened = new Kernel(directory);
    try { assert.equal(reopened.getBudgets(parent.id).toolCalls, 2); } finally { reopened.close(); }
  } finally { upgraded.close(); assert.ok(directory.startsWith(root + path.sep)); rmSync(directory, { recursive: true, force: true }); }
});
