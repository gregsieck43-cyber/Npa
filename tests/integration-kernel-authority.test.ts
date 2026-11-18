import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Command } from '../src/contracts.js';
import { Kernel, KernelError } from '../src/kernel/index.js';
import { assertProjectFixtureRoot } from './project-boundary.js';

function isolatedKernel(t: TestContext): Kernel {
  const tempRoot = path.resolve('.tmp');
  assertProjectFixtureRoot(tempRoot);
  mkdirSync(tempRoot, { recursive: true });
  const directory = mkdtempSync(path.join(tempRoot, 'audit-kernel-'));
  let kernel: Kernel | undefined;
  t.after(() => {
    kernel?.close();
    assert.ok(path.relative(tempRoot, directory).startsWith('audit-kernel-'));
    rmSync(directory, { recursive: true, force: true });
  });
  kernel = new Kernel(directory);
  return kernel;
}

function createTask(kernel: Kernel, objective = 'Independent authority fixture'): string {
  return kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { goal: {
    objective, constraints: ['Do not change the approval or audit kernel'],
    acceptance: ['Independent evidence is required'], maxModelCalls: 5, mode: 'autonomous',
  } } }).taskId!;
}

function errorCode(code: string): (error: unknown) => boolean {
  return error => error instanceof KernelError && error.code === code;
}

test('independent: identical typed controls replay before stale revision checking and preserve raw input', t => {
  const kernel = isolatedKernel(t);
  const taskId = createTask(kernel);
  kernel.addMessage(taskId, 'user', 'Original user input, with no synthetic continuation');
  const originalMessages = kernel.getMessages(taskId);
  const command: Command = { commandId: randomUUID(), taskId, type: 'retry', expectedRevision: kernel.getTask(taskId)!.revision };
  const first = kernel.command(command);
  const replay = kernel.command(command);
  assert.equal(first.status, 'accepted');
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.revision, first.revision);
  assert.equal(kernel.events(taskId).filter(event => event.type === 'task.retry_requested').length, 1);
  assert.deepEqual(kernel.getMessages(taskId), originalMessages);
  assert.throws(() => kernel.command({ ...command, type: 'cancel' }), errorCode('IDEMPOTENCY_CONFLICT'));
});

for (const type of ['grant', 'deny'] as const) {
  test(`independent: ${type} cannot act on an intent owned by another task`, t => {
    const kernel = isolatedKernel(t);
    const firstTaskId = createTask(kernel, 'First task');
    const otherTaskId = createTask(kernel, 'Other task');
    const run = kernel.createRun(otherTaskId);
    const intent = kernel.prepareIntent(otherTaskId, run.id, { id: 'fixture-call', name: 'fixture_increment', arguments: { amount: 1 } });
    assert.throws(() => kernel.command({ commandId: randomUUID(), taskId: firstTaskId, type, parameters: { intentId: intent.id } }), errorCode('WRONG_TASK'));
    assert.equal(kernel.getIntent(intent.id)!.state, 'prepared');
    assert.equal(kernel.events(otherTaskId).filter(event => event.type === `intent.${type === 'grant' ? 'approved' : 'denied'}`).length, 0);
  });
}

test('independent: model completion text does not grant a completed task state', t => {
  const kernel = isolatedKernel(t);
  const taskId = createTask(kernel);
  const run = kernel.createRun(taskId);
  kernel.transition(taskId, 'running');
  kernel.saveDecision(taskId, run.id, { content: 'Done. All acceptance passed.', toolCalls: [] });
  assert.throws(() => kernel.transition(taskId, 'completed', { result: 'Model says done' }));
  assert.notEqual(kernel.getTask(taskId)!.status, 'completed');
  assert.equal(kernel.getVerifications(taskId).length, 0);
});

test('independent: a passing verifier snapshot cannot complete a subsequently revised task', t => {
  const kernel = isolatedKernel(t);
  const taskId = createTask(kernel);
  const run = kernel.createRun(taskId);
  kernel.transition(taskId, 'running');
  const inspected = kernel.getTask(taskId)!;
  kernel.verify(taskId, run.id, { passed: true, reviewer: 'independent-fixed-fixture',
    expectedRevision: inspected.revision, goalVersion: inspected.goalVersion, generation: inspected.generation, policyEpoch: inspected.policyEpoch });
  kernel.consumeModelCall(taskId, run.id);
  assert.throws(() => kernel.transition(taskId, 'completed', { result: 'Old verifier result' }));
  assert.notEqual(kernel.getTask(taskId)!.status, 'completed');
  assert.throws(() => kernel.verify(taskId, run.id, { passed: true, reviewer: 'independent-fixed-fixture', expectedRevision: inspected.revision }));
});

test('independent: a child cannot dispatch authority removed from its current parent', t => {
  const kernel = isolatedKernel(t);
  const parentId = createTask(kernel, 'Parent task');
  kernel.command({ commandId: randomUUID(), taskId: parentId, type: 'delegate', parameters: { goal: {
    objective: 'Child fixture', constraints: [], acceptance: ['One fixture receipt'], maxModelCalls: 3, mode: 'autonomous',
  } } });
  const childId = kernel.delegations(parentId)[0]!.childTaskId;
  const childRun = kernel.createRun(childId);
  const intent = kernel.prepareIntent(childId, childRun.id, { id: 'child-call', name: 'fixture_increment', arguments: { amount: 1 } });
  kernel.approve(intent.id);
  kernel.setCapabilityCeiling(parentId, ['workspace.read']);
  assert.throws(() => kernel.dispatch(intent.id));
  assert.notEqual(kernel.getIntent(intent.id)!.state, 'sent');
  assert.throws(() => kernel.setCapabilityCeiling(childId, ['workspace.read', 'fixture.write']));
});

test('independent: auxiliary session control and overlapping child ownership are rejected by the program', t => {
  const kernel = isolatedKernel(t);
  const parentId = createTask(kernel);
  assert.throws(() => kernel.command({ commandId: randomUUID(), taskId: parentId, type: 'cancel', parameters: { sessionId: 'side-audit' } }), errorCode('SIDE_SESSION_CONTROL'));
  assert.equal(kernel.getTask(parentId)!.status, 'queued');
  kernel.command({ commandId: randomUUID(), taskId: parentId, type: 'delegate', parameters: { objective: 'First child', paths: ['owned.txt'] } });
  assert.throws(() => kernel.command({ commandId: randomUUID(), taskId: parentId, type: 'delegate', parameters: { objective: 'Second child', paths: ['owned.txt'] } }), errorCode('OWNERSHIP_CONFLICT'));
  assert.equal(kernel.delegations(parentId).length, 1, 'Failed delegation must roll back its child and lock transaction');
  assert.equal(kernel.listTasks().length, 2);
});
