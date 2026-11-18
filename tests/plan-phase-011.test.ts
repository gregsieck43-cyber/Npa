import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Kernel, KernelError } from '../src/kernel/index.js';
import { IntegrationService } from '../src/integrations/index.js';

const base = path.resolve('.tmp/hardening-011-root/plan-tests');
function fixture(fn: (kernel: Kernel, integration: IntegrationService, taskId: string) => void) {
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'case-'));
  const kernel = new Kernel(directory);
  const integration = new IntegrationService({ dataDir: directory, projectRoot: process.cwd(), kernel });
  const taskId = kernel.command({ commandId: 'new', type: 'create_task', parameters: {
    title: 'Plan before changing files', workspace: directory, permissionMode: 'full-access', executionPhase: 'planning',
  } }).taskId!;
  try { fn(kernel, integration, taskId); }
  finally { integration.close(); kernel.close(); assert.ok(directory.startsWith(base + path.sep)); rmSync(directory, { recursive: true, force: true }); }
}
const plan = { id: 'plan', title: 'Read then implement', nodes: [{ id: 'first', title: 'Implement', objective: 'Make the approved change', dependencies: [], paths: ['src'] }] };
const code = (value: string) => (error: unknown) => error instanceof KernelError && error.code === value;

test('approving a plan fences the real planning run before a new execution owner starts', () => fixture((kernel, integration, taskId) => {
  const first = kernel.createRun(taskId); kernel.transition(taskId, 'running');
  integration.createPlan(taskId, plan);
  const saved = kernel.getTask(taskId)!;
  kernel.command({ commandId: 'approve', type: 'approve_plan', taskId, expectedRevision: saved.revision, parameters: { plan: saved.plan } });
  const second = kernel.createRun(taskId);
  assert.notEqual(second.id, first.id); assert.ok(second.generation > first.generation);
  assert.throws(() => kernel.assertFence(taskId, first.id), code('STALE_GENERATION'));
}));

test('cancelled plans cannot be saved or approved using a fresh task revision', () => fixture((kernel, integration, taskId) => {
  integration.createPlan(taskId, plan);
  kernel.command({ commandId: 'cancel', type: 'cancel', taskId });
  const cancelled = kernel.getTask(taskId)!;
  for (const type of ['approve_plan', 'save_plan']) assert.throws(() => kernel.command({ commandId: type, type, taskId, expectedRevision: cancelled.revision, parameters: { plan: cancelled.plan } }), code('TERMINAL_TASK'));
  assert.throws(() => integration.createPlan(taskId, { ...plan, title: 'must not overwrite the cancelled plan' }), /terminal task/);
  assert.equal(kernel.getTask(taskId)!.status, 'cancelled'); assert.equal(integration.plan(taskId)!.title, plan.title);
  assert.doesNotThrow(() => integration.activateApprovedPlan(taskId));
}));

test('reconfirming the same plan resumes only children paused by that planning transition', () => fixture((kernel, integration, taskId) => {
  const two = { ...plan, nodes: [...plan.nodes, { id: 'second', title: 'User paused', objective: 'stay paused', dependencies: [], paths: ['other'] }] };
  const approve = (id: string) => { const task = kernel.getTask(taskId)!; kernel.command({ commandId: id, type: 'approve_plan', taskId, parameters: { plan: task.plan } }); integration.activateApprovedPlan(taskId); };
  integration.createPlan(taskId, two); approve('first');
  const children = kernel.childTasks(taskId); kernel.command({ commandId: 'manual-pause', type: 'pause', taskId: children[1]!.id });
  kernel.command({ commandId: 'replan', type: 'enter_plan', taskId }); integration.createPlan(taskId, two); approve('second');
  assert.equal(kernel.childTasks(taskId).length, 2);
  assert.equal(kernel.getTask(children[0]!.id)!.status, 'queued'); assert.equal(kernel.getTask(children[1]!.id)!.status, 'paused');
}));

test('successive drafts retain and settle children from the last executed plan', () => fixture((kernel, integration, taskId) => {
  integration.createPlan(taskId, plan); let task = kernel.getTask(taskId)!;
  kernel.command({ commandId: 'first', type: 'approve_plan', taskId, parameters: { plan: task.plan } }); integration.activateApprovedPlan(taskId);
  const previous = kernel.childTasks(taskId)[0]!;
  kernel.command({ commandId: 'replan', type: 'enter_plan', taskId });
  integration.createPlan(taskId, { ...plan, title: 'draft two' }); integration.createPlan(taskId, { ...plan, title: 'draft three' });
  task = kernel.getTask(taskId)!; kernel.command({ commandId: 'third', type: 'approve_plan', taskId, parameters: { plan: task.plan } }); integration.activateApprovedPlan(taskId);
  assert.equal(kernel.getTask(previous.id)!.status, 'cancelled'); assert.equal(kernel.childTasks(taskId).length, 2);
  assert.equal(kernel.delegations(taskId).find(item => item.childTaskId === previous.id)!.state, 'dismissed');
  assert.ok(integration.plan(taskId)!.nodes[0]!.childTaskId !== previous.id);
}));

test('planning survives full-access and cannot dispatch effects or delegate', () => fixture((kernel, _integration, taskId) => {
  assert.equal((kernel.getTask(taskId) as any).executionPhase, 'planning');
  const run = kernel.createRun(taskId); kernel.transition(taskId, 'running');
  assert.throws(() => kernel.prepareIntent(taskId, run.id, { id: 'write', name: 'write_file', arguments: { path: 'x', content: 'no' } }), code('PLAN_MODE'));
  assert.throws(() => kernel.command({ commandId: 'child', type: 'delegate', taskId, parameters: { title: 'must not start' } }), code('PLAN_MODE'));
  assert.equal(kernel.prepareIntent(taskId, run.id, { id: 'read', name: 'read_file', arguments: { path: 'x' } }).state, 'prepared');
}));

test('children cannot bypass a parent planning gate through resume, retry or a new run', () => fixture((kernel, integration, taskId) => {
  integration.createPlan(taskId, plan); let parent = kernel.getTask(taskId)!;
  kernel.command({ commandId: 'approved-parent', type: 'approve_plan', taskId, parameters: { plan: parent.plan } }); integration.activateApprovedPlan(taskId);
  const child = kernel.childTasks(taskId)[0]!;
  kernel.command({ commandId: 'parent-planning', type: 'enter_plan', taskId });
  for (const type of ['resume', 'retry']) assert.throws(() => kernel.command({ commandId: `child-${type}`, type, taskId: child.id }), code('PLAN_CONFIRMATION_REQUIRED'));
  assert.throws(() => kernel.createRun(child.id), code('PLAN_CONFIRMATION_REQUIRED'));
  assert.equal(kernel.taskRunnable(child.id), false);
  kernel.command({ commandId: 'pause-plan', type: 'pause', taskId }); kernel.command({ commandId: 'resume-plan', type: 'resume', taskId });
  assert.equal(kernel.getTask(child.id)!.status, 'paused');
  integration.createPlan(taskId, plan); parent = kernel.getTask(taskId)!;
  kernel.command({ commandId: 'reapproved-parent', type: 'approve_plan', taskId, parameters: { plan: parent.plan } }); integration.activateApprovedPlan(taskId);
  assert.equal(kernel.getTask(child.id)!.status, 'queued'); assert.ok(kernel.createRun(child.id));
}));

test('a plan is persisted without children until the exact version is approved', () => fixture((kernel, integration, taskId) => {
  integration.createPlan(taskId, plan);
  const saved = kernel.getTask(taskId) as any;
  assert.equal(saved.executionPhase, 'awaiting_plan_confirmation');
  assert.equal(kernel.delegations(taskId).length, 0);
  assert.throws(() => kernel.command({ commandId: 'model-confirm', type: 'approve_plan', taskId, origin: 'model', parameters: { plan: saved.plan } }), code('OPERATOR_REQUIRED'));
  assert.throws(() => kernel.command({ commandId: 'stale-confirm', type: 'approve_plan', taskId, origin: 'operator', parameters: { plan: { ...saved.plan, revision: 99 } } }), code('PLAN_CONFLICT'));
  kernel.command({ commandId: 'confirm', type: 'approve_plan', taskId, expectedRevision: saved.revision, origin: 'operator', parameters: { plan: saved.plan } });
  integration.createPlan(taskId, plan);
  assert.equal((kernel.getTask(taskId) as any).executionPhase, 'executing');
  assert.equal(kernel.delegations(taskId).length, 1);
  integration.createPlan(taskId, plan);
  assert.equal(kernel.delegations(taskId).length, 1);
}));

test('goal revision invalidates the approved plan and fences old execution', () => fixture((kernel, integration, taskId) => {
  integration.createPlan(taskId, plan);
  const saved = kernel.getTask(taskId) as any;
  kernel.command({ commandId: 'confirm', type: 'approve_plan', taskId, origin: 'operator', parameters: { plan: saved.plan } });
  kernel.command({ commandId: 'revise', type: 'revise_goal', taskId, origin: 'operator', parameters: { goal: { objective: 'A different objective' }, reason: 'User changed requirements' } });
  assert.equal((kernel.getTask(taskId) as any).executionPhase, 'planning');
  assert.throws(() => kernel.command({ commandId: 'old-confirm', type: 'approve_plan', taskId, parameters: { plan: saved.plan } }), code('PLAN_CONFLICT'));
}));
