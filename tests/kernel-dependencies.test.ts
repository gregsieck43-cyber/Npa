import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Kernel, KernelError } from '../src/kernel/index.js';

function fixture(run: (kernel: Kernel, directory: string) => void) {
  const directory = mkdtempSync(path.resolve('.tmp', 'kernel-dependencies-'));
  const kernel = new Kernel(directory);
  try { run(kernel, directory); }
  finally { kernel.close(); rmSync(directory, { recursive: true, force: true }); }
}
function parent(kernel: Kernel) {
  return kernel.command({ commandId: crypto.randomUUID(), type: 'create_task', parameters: { title: 'Local dependency workflow' } }).taskId!;
}
function delegate(kernel: Kernel, taskId: string, name: string, dependsOn: unknown = []) {
  kernel.command({ commandId: crypto.randomUUID(), taskId, type: 'delegate', parameters: { title: name, paths: [name], dependsOn } });
  return kernel.delegations(taskId).at(-1)!.childTaskId;
}
function complete(kernel: Kernel, taskId: string) {
  const run = kernel.createRun(taskId);
  kernel.transition(taskId, 'running');
  kernel.verify(taskId, run.id, { passed: true, reviewer: 'independent-test-observer', expectedRevision: kernel.getTask(taskId)!.revision });
  kernel.transition(taskId, 'completed', { result: `Verified ${taskId}` });
  kernel.finishRun(run.id, 'completed');
}
const code = (expected: string) => (error: unknown) => error instanceof KernelError && error.code === expected;

test('dependency-driven children wait for all predecessors and survive restart', () => fixture((kernel, directory) => {
  const root = parent(kernel), first = delegate(kernel, root, 'first'), second = delegate(kernel, root, 'second');
  const final = delegate(kernel, root, 'final', [first, second]);
  assert.equal(kernel.runnableTasks().some(task => task.id === final), false);
  assert.throws(() => kernel.createRun(final), code('DEPENDENCY_BLOCKED'));
  complete(kernel, first);
  assert.equal(kernel.runnableTasks().some(task => task.id === final), false);
  complete(kernel, second);
  assert.equal(kernel.runnableTasks().some(task => task.id === final), true);
  const restarted = new Kernel(directory);
  try {
    assert.equal(restarted.runnableTasks().some(task => task.id === final), true);
    const run = restarted.createRun(final);
    assert.equal(run.taskId, final);
  } finally { restarted.close(); }
}));

test('failed and cancelled dependencies never count as successful completion', () => fixture(kernel => {
  const root = parent(kernel), first = delegate(kernel, root, 'first'), second = delegate(kernel, root, 'second');
  const dependent = delegate(kernel, root, 'dependent', [first, second]);
  kernel.transition(first, 'failed', { error: 'Simulated bounded failure' });
  kernel.command({ commandId: crypto.randomUUID(), type: 'cancel', taskId: second });
  assert.equal(kernel.runnableTasks().some(task => task.id === dependent), false);
  assert.throws(() => kernel.createRun(dependent), code('DEPENDENCY_BLOCKED'));
  assert.equal(kernel.getTask(dependent)!.modelCalls, 0);
}));

test('dependency validation is atomic and excludes unrelated or nonexistent tasks', () => fixture(kernel => {
  const root = parent(kernel), other = parent(kernel), foreign = delegate(kernel, other, 'foreign');
  for (const invalid of [[foreign], ['missing-task'], 'not-an-array', [root], Array(65).fill(foreign)]) {
    const before = kernel.listTasks().length;
    assert.throws(() => delegate(kernel, root, 'invalid', invalid), code('INVALID_DEPENDENCY'));
    assert.equal(kernel.listTasks().length, before);
    assert.equal(kernel.delegations(root).length, 0);
  }
}));

test('planning while paused keeps new children paused until the parent resumes', () => fixture(kernel => {
  const root = parent(kernel);
  kernel.command({ commandId: crypto.randomUUID(), type: 'pause', taskId: root });
  const child = delegate(kernel, root, 'planned-child');
  assert.equal(kernel.getTask(child)!.status, 'paused');
  assert.equal(kernel.runnableTasks().some(task => task.id === child), false);
  assert.throws(() => kernel.command({ commandId: crypto.randomUUID(), type: 'resume', taskId: child }), code('PARENT_PAUSED'));
  kernel.command({ commandId: crypto.randomUUID(), type: 'resume', taskId: root });
  assert.equal(kernel.getTask(child)!.status, 'queued');
}));

test('commit notifications observe durable commands, coalesce, and exclude rollbacks', async () => {
  const directory = mkdtempSync(path.resolve('.tmp', 'kernel-commit-events-'));
  const kernel = new Kernel(directory);
  let notifications = 0;
  const unsubscribe = kernel.onCommitted(() => { notifications++; });
  try {
    const root = parent(kernel);
    const child = delegate(kernel, root, 'child');
    await Promise.resolve();
    assert.equal(notifications, 1);
    assert.equal(kernel.getTask(child)!.parentId, root);
    assert.throws(() => delegate(kernel, root, 'invalid', ['missing']), code('INVALID_DEPENDENCY'));
    await Promise.resolve();
    assert.equal(notifications, 1);
    unsubscribe();
    kernel.command({ commandId: crypto.randomUUID(), type: 'pause', taskId: child });
    await Promise.resolve();
    assert.equal(notifications, 1);
  } finally { unsubscribe(); kernel.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('retrying a completed predecessor blocks the dependent before further effects', () => fixture(kernel => {
  const root = parent(kernel), first = delegate(kernel, root, 'first');
  const second = delegate(kernel, root, 'second', [first]);
  complete(kernel, first);
  const run = kernel.createRun(second);
  kernel.transition(second, 'running');
  kernel.command({ commandId: crypto.randomUUID(), type: 'retry', taskId: first });
  assert.throws(() => kernel.assertFence(second, run.id), code('DEPENDENCY_BLOCKED'));
  assert.equal(kernel.intents(second).length, 0);
}));
