import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Kernel, KernelError } from '../src/kernel/index.js';
import type { Task } from '../src/contracts.js';

function fixture(body: (kernel: Kernel, directory: string) => void): void {
  const root = path.resolve('.tmp');
  const directory = mkdtempSync(path.join(root, 'kernel-collaboration-test-'));
  const kernel = new Kernel(directory);
  try { body(kernel, directory); }
  finally { kernel.close(); assert.ok(directory.startsWith(root + path.sep)); rmSync(directory, { recursive: true, force: true }); }
}
function create(kernel: Kernel, objective = 'Parent collaboration', mode: 'autonomous' | 'collaborative' = 'autonomous'): Task {
  const ack = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { goal: { objective, mode, maxModelCalls: 20 } } });
  return kernel.getTask(ack.taskId!)!;
}
function delegate(kernel: Kernel, parentId: string, title = 'Scoped child'): Task {
  kernel.command({ commandId: randomUUID(), type: 'delegate', taskId: parentId, parameters: { objective: title } });
  return kernel.getTask(kernel.delegations(parentId).at(-1)!.childTaskId)!;
}
function run(kernel: Kernel, taskId: string): string {
  const active = kernel.createRun(taskId); kernel.transition(taskId, 'running'); return active.id;
}
function complete(kernel: Kernel, taskId: string): void {
  const runId = run(kernel, taskId);
  kernel.verify(taskId, runId, { passed: true, reviewer: 'independent-fixture', evidence: 'Scoped result checked' });
  kernel.transition(taskId, 'completed', { result: 'Verified scoped result' });
  kernel.finishRun(runId, 'completed');
}
const code = (expected: string) => (error: unknown) => error instanceof KernelError && error.code === expected;

test('waiting children survives recovery and queues a fresh generation only when resumed', () => fixture((kernel, directory) => {
  const parent = create(kernel); const child = delegate(kernel, parent.id); const parentRun = run(kernel, parent.id);
  kernel.transition(parent.id, 'waiting_children', { waitingReason: 'Waiting for scoped result' });
  const recovery = kernel.recover();
  assert.deepEqual(recovery.waitingChildren, [parent.id]);
  assert.equal(kernel.getTask(parent.id)!.status, 'waiting_children');
  assert.equal(kernel.getTask(parent.id)!.waitingReason, 'Waiting for scoped result');
  assert.throws(() => kernel.assertFence(parent.id, parentRun), code('STALE_GENERATION'));
  const reader = new Kernel(directory);
  try { assert.equal(reader.getTask(parent.id)!.status, 'waiting_children'); assert.equal(reader.queryDelegations(parent.id)[0].task.id, child.id); }
  finally { reader.close(); }
  complete(kernel, child.id);
  const before = kernel.getTask(parent.id)!.generation;
  kernel.transition(parent.id, 'queued');
  assert.equal(kernel.createRun(parent.id).generation, before + 1);
}));

test('parent pause and recovery restore only children paused by that parent', () => fixture(kernel => {
  const parent = create(kernel); const activeChild = delegate(kernel, parent.id, 'Active child'); const heldChild = delegate(kernel, parent.id, 'User paused child');
  kernel.command({ commandId: randomUUID(), type: 'pause', taskId: heldChild.id });
  const childRun = run(kernel, activeChild.id); run(kernel, parent.id);
  kernel.transition(parent.id, 'waiting_children', { waitingReason: 'Pending child' });
  kernel.command({ commandId: randomUUID(), type: 'pause', taskId: parent.id });
  assert.equal(kernel.getTask(activeChild.id)!.status, 'paused');
  assert.throws(() => kernel.assertFence(activeChild.id, childRun), code('STALE_GENERATION'));
  assert.throws(() => kernel.command({ commandId: randomUUID(), type: 'resume', taskId: activeChild.id }), code('PARENT_PAUSED'));
  assert.throws(() => kernel.command({ commandId: randomUUID(), type: 'retry', taskId: activeChild.id }), code('PARENT_PAUSED'));
  kernel.recover();
  kernel.command({ commandId: randomUUID(), type: 'resume', taskId: parent.id });
  assert.equal(kernel.getTask(parent.id)!.status, 'waiting_children');
  assert.equal(kernel.getTask(activeChild.id)!.status, 'queued');
  assert.equal(kernel.getTask(heldChild.id)!.status, 'paused');
  assert.ok(kernel.createRun(activeChild.id));
}));

test('waiting parent retry controls its own generation and cancelled children stay cancelled', () => fixture(kernel => {
  const parent = create(kernel); const child = delegate(kernel, parent.id); run(kernel, parent.id);
  kernel.transition(parent.id, 'waiting_children');
  kernel.command({ commandId: randomUUID(), type: 'cancel_child', taskId: parent.id, parameters: { childTaskId: child.id } });
  const childGeneration = kernel.getTask(child.id)!.generation;
  kernel.command({ commandId: randomUUID(), type: 'retry', taskId: parent.id });
  assert.equal(kernel.getTask(parent.id)!.status, 'queued');
  assert.equal(kernel.getTask(child.id)!.status, 'cancelled');
  assert.equal(kernel.getTask(child.id)!.generation, childGeneration);
  assert.throws(() => kernel.command({ commandId: randomUUID(), type: 'retry', taskId: child.id }), code('CANCELLED_TASK'));
  kernel.command({ commandId: randomUUID(), type: 'cancel', taskId: parent.id });
  assert.equal(kernel.getTask(parent.id)!.status, 'cancelled');
}));

test('scoped cancellation, dismissal and acceptance cannot act on another parent child', () => fixture(kernel => {
  const parent = create(kernel); const outsider = create(kernel, 'Other parent'); const otherChild = delegate(kernel, outsider.id);
  assert.deepEqual(kernel.queryDelegations(parent.id), []);
  for (const type of ['cancel_child', 'dismiss_child', 'accept_result']) {
    assert.throws(() => kernel.command({ commandId: randomUUID(), type, taskId: parent.id, parameters: { childTaskId: otherChild.id, reason: 'Irrelevant' } }));
  }
  assert.equal(kernel.getTask(otherChild.id)!.status, 'queued');
}));

test('acceptance binds a current child PASS and later child changes invalidate parent completion', () => fixture(kernel => {
  const parent = create(kernel); const child = delegate(kernel, parent.id); const parentRun = run(kernel, parent.id);
  complete(kernel, child.id);
  kernel.command({ commandId: randomUUID(), type: 'accept_result', taskId: parent.id, parameters: { childTaskId: child.id } });
  assert.equal(kernel.delegations(parent.id)[0].settledSnapshot!.generation, kernel.getTask(child.id)!.generation);
  kernel.consumeModelCall(child.id);
  assert.throws(() => kernel.command({ commandId: randomUUID(), type: 'accept_result', taskId: parent.id, parameters: { childTaskId: child.id } }), code('STALE_VERIFICATION'));
  kernel.verify(parent.id, parentRun, { passed: true, reviewer: 'independent-fixture' });
  assert.throws(() => kernel.transition(parent.id, 'completed'), code('UNACCEPTED_DELEGATION'));
}));

test('failed child dismissal preserves failure and requires parent independent acceptance', () => fixture(kernel => {
  const parent = create(kernel); const child = delegate(kernel, parent.id); const childRun = run(kernel, child.id); const parentRun = run(kernel, parent.id);
  kernel.transition(child.id, 'failed', { error: 'Fixture failed' }); kernel.finishRun(childRun, 'failed');
  assert.throws(() => kernel.command({ commandId: randomUUID(), type: 'accept_result', taskId: parent.id, parameters: { childTaskId: child.id } }), code('RESULT_NOT_READY'));
  kernel.command({ commandId: randomUUID(), type: 'dismiss_child', taskId: parent.id, parameters: { childTaskId: child.id, reason: 'Replaced with verified parent implementation' } });
  assert.equal(kernel.queryDelegations(parent.id)[0].task.status, 'failed');
  assert.equal(kernel.delegations(parent.id)[0].state, 'dismissed');
  assert.throws(() => kernel.transition(parent.id, 'completed'), code('UNVERIFIED_RESULT'));
  kernel.verify(parent.id, parentRun, { passed: true, reviewer: 'independent-fixture', evidence: { dismissedFailure: child.id, reason: 'Parent independently satisfies goal' } });
  kernel.transition(parent.id, 'completed');
}));

test('dismissal cannot hide unknown effects from a cancelled child', () => fixture(kernel => {
  const parent = create(kernel); const child = delegate(kernel, parent.id); const childRun = run(kernel, child.id);
  const intent = kernel.prepareIntent(child.id, childRun, { id: 'effect', name: 'fixture_increment', arguments: {} });
  kernel.approve(intent.id); kernel.dispatch(intent.id);
  kernel.command({ commandId: randomUUID(), type: 'cancel_child', taskId: parent.id, parameters: { childTaskId: child.id } });
  assert.throws(() => kernel.command({ commandId: randomUUID(), type: 'dismiss_child', taskId: parent.id, parameters: { childTaskId: child.id, reason: 'Skip it' } }), code('UNRESOLVED_EFFECT'));
}));

test('autonomous clarification is bounded, typed, durable and deduplicated', () => fixture(kernel => {
  const task = create(kernel); run(kernel, task.id);
  assert.throws(() => kernel.command({ commandId: randomUUID(), type: 'ask_question', taskId: task.id, parameters: { question: 'Which routine approach?', reason: 'choice' } }), code('AUTONOMOUS_CHOICE'));
  for (let index = 0; index < 3; index++) {
    const question = { commandId: randomUUID(), type: 'ask_question', taskId: task.id, parameters: { question: `Initial requirement ${index}?`, reason: 'initial_clarification' } };
    kernel.command(question); assert.equal(kernel.command(question).status, 'duplicate');
    kernel.command({ commandId: randomUUID(), type: 'answer', taskId: task.id, parameters: { answer: `Answer ${index}` } });
    run(kernel, task.id);
  }
  assert.equal(kernel.events(task.id).filter(event => event.type === 'question.asked').length, 3);
  assert.ok(kernel.events(task.id).find(event => event.type === 'question.asked')!.payload.id);
  assert.throws(() => kernel.command({ commandId: randomUUID(), type: 'ask_question', taskId: task.id, parameters: { question: 'Fourth initial question?', reason: 'initial_clarification' } }), code('CLARIFICATION_LIMIT'));
  kernel.recover(); assert.equal(kernel.events(task.id).filter(event => event.type === 'question.asked').length, 3);
}));

test('initial clarification closes after effect dispatch and collaborative choice remains allowed', () => fixture(kernel => {
  const task = create(kernel); const taskRun = run(kernel, task.id);
  const intent = kernel.prepareIntent(task.id, taskRun, { id: 'fixture', name: 'fixture_increment', arguments: {} });
  kernel.approve(intent.id); kernel.dispatch(intent.id); kernel.receipt(intent.id, { applied: true });
  assert.throws(() => kernel.command({ commandId: randomUUID(), type: 'ask_question', taskId: task.id, parameters: { question: 'Another initial question?', reason: 'initial_clarification' } }), code('INITIAL_CLARIFICATION_CLOSED'));
  kernel.command({ commandId: randomUUID(), type: 'ask_question', taskId: task.id, parameters: { question: 'Authorization needed?', reason: 'authorization' } });
  assert.equal(kernel.getTask(task.id)!.status, 'waiting_input');
  const collaborative = create(kernel, 'Collaborative task', 'collaborative'); run(kernel, collaborative.id);
  kernel.command({ commandId: randomUUID(), type: 'ask_question', taskId: collaborative.id, parameters: { question: 'Choose a format?', reason: 'choice' } });
  assert.equal(kernel.getTask(collaborative.id)!.status, 'waiting_input');
}));
