import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Kernel } from '../src/kernel/index.js';
import { IntegrationService } from '../src/integrations/index.js';

const base = path.resolve('.tmp/final-integrations');
function fixture(run: (kernel: Kernel, service: IntegrationService, directory: string, taskId: string) => void) {
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'collaboration-'));
  const kernel = new Kernel(path.join(directory, 'kernel'));
  const taskId = kernel.command({ commandId: 'create', type: 'create_task', parameters: { title: 'Local authorized fixture' } }).taskId!;
  const service = new IntegrationService({ dataDir: path.join(directory, 'integrations'), projectRoot: process.cwd(), kernel });
  try { run(kernel, service, directory, taskId); } finally { service.close(); kernel.close(); rmSync(directory, { recursive: true, force: true }); }
}
const plan = { id: 'inspect', title: 'Inspect then report', nodes: [
  { id: 'report', title: 'Report', objective: 'Write a source-backed report', dependencies: ['inspect'], paths: ['report'] },
  { id: 'inspect', title: 'Inspect', objective: 'Read the authorized fixture', dependencies: [], paths: ['inspect'] },
] };
test('persistent DAG delegates topologically once and takes all runnable state from Kernel', () => fixture((kernel, service, directory, taskId) => {
  const created = service.createPlan(taskId, plan);
  assert.equal(created.nodes.length, 2);
  const first = created.nodes.find(node => node.id === 'inspect')!, second = created.nodes.find(node => node.id === 'report')!;
  assert.deepEqual(kernel.dependencies(second.childTaskId!).map(task => task.id), [first.childTaskId]);
  assert.equal(second.ready, false); assert.match(second.blockedReason!, /depend/i);
  assert.equal(kernel.delegations(taskId).length, 2);
  const restarted = new IntegrationService({ dataDir: path.join(directory, 'integrations'), projectRoot: process.cwd(), kernel });
  try { assert.deepEqual(restarted.createPlan(taskId, plan), created); } finally { restarted.close(); }
  assert.equal(kernel.delegations(taskId).length, 2);
  kernel.command({ commandId: 'pause-child', type: 'pause', taskId: first.childTaskId });
  assert.equal(service.snapshot(taskId).plan!.nodes.find(node => node.id === 'inspect')!.status, 'paused');
}));
test('a crash after Kernel delegation resumes the same plan without a duplicate child', () => fixture((kernel, service, _directory, taskId) => {
  const command = kernel.command.bind(kernel);
  let interrupted = false;
  kernel.command = input => {
    const ack = command(input);
    if (input.type === 'delegate' && !interrupted) { interrupted = true; throw new Error('simulated coordinator interruption'); }
    return ack;
  };
  assert.throws(() => service.createPlan(taskId, plan), /interruption/);
  assert.equal(kernel.delegations(taskId).length, 1);
  kernel.command = command;
  const resumed = service.createPlan(taskId, plan);
  assert.equal(kernel.delegations(taskId).length, 2);
  assert.ok(resumed.nodes.every(node => node.childTaskId));
  assert.throws(() => service.createPlan(taskId, { ...plan, title: 'changed request' }), /immutable/);
}));

test('cycles, unknown dependencies and overlapping paths fail before any Kernel delegation', () => fixture((kernel, service, _dir, taskId) => {
  assert.throws(() => service.createPlan(taskId, { ...plan, nodes: plan.nodes.map(node => ({ ...node, dependencies: [node.id] })) }), /cycle/i);
  assert.throws(() => service.createPlan(taskId, { ...plan, nodes: [{ ...plan.nodes[0]!, dependencies: ['missing'] }] }), /dependency/i);
  assert.throws(() => service.createPlan(taskId, { ...plan, nodes: plan.nodes.map(node => ({ ...node, paths: ['shared'] })) }), /overlap/i);
  assert.throws(() => service.createPlan(taskId, { ...plan, nodes: [{ ...plan.nodes[1]!, paths: ['../outside'] }] }), /path/i);
  assert.throws(() => service.createPlan(taskId, { ...plan, nodes: [{ ...plan.nodes[1]!, paths: ['./'] }] }), /path/i);
  assert.equal(kernel.delegations(taskId).length, 0);
}));
test('shared todos use optimistic revisions and fact claims require same-tree original evidence', () => fixture((kernel, service, _dir, taskId) => {
  const created = service.createPlan(taskId, plan), child = created.nodes[0]!.childTaskId!;
  const message = kernel.addMessage(child, 'assistant', 'Observed the local preload bridge in sample.js');
  const resource = service.addResource(taskId, { path: 'sample.js', label: 'Owned sample' });
  const evidence = service.captureEvidence(taskId, { sourceTaskId: child, kind: 'message', sourceId: message.id });
  assert.equal(evidence.trust, 'untrusted'); assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
  const fact = service.addFact(taskId, { resourceId: resource.id, statement: 'A preload bridge is present', kind: 'observation', evidenceIds: [evidence.id] });
  assert.deepEqual(fact.evidenceIds, [evidence.id]);
  assert.throws(() => service.addFact(taskId, { resourceId: resource.id, statement: 'False proof', kind: 'observation', evidenceIds: ['missing'] }), /evidence/i);
  const todo = service.saveTodo(taskId, { id: 'review', title: 'Review observed bridge', owner: 'planner', status: 'open', evidenceIds: [], expectedRevision: 0 });
  assert.equal(todo.revision, 1);
  assert.throws(() => service.saveTodo(taskId, { ...todo, expectedRevision: 0 }), /revision/i);
  assert.throws(() => service.saveTodo(taskId, { ...todo, status: 'done', expectedRevision: 1 }), /evidence/i);
  assert.equal(service.saveTodo(taskId, { ...todo, status: 'done', evidenceIds: [evidence.id], expectedRevision: 1 }).revision, 2);
  const foreignId = kernel.command({ commandId: 'foreign', type: 'create_task', parameters: { title: 'Foreign' } }).taskId!;
  assert.throws(() => service.captureEvidence(taskId, { sourceTaskId: foreignId, kind: 'message', sourceId: message.id }), /scope/i);
}));
test('process retrieval spans delegated histories and excludes the requesting worker without losing raw text', () => fixture((kernel, service, _dir, taskId) => {
  const created = service.createPlan(taskId, plan), children = created.nodes.map(node => node.childTaskId!);
  const message = kernel.addMessage(children[0]!, 'assistant', 'searchable original trace '.repeat(600));
  kernel.addMessage(children[1]!, 'assistant', 'searchable requesting worker');
  const found = service.searchProcesses(taskId, { query: 'searchable', excludeTaskId: children[1] });
  assert.equal(found.results.length, 1); assert.equal(found.results[0]!.sourceId, message.id);
  const read = service.readProcess(taskId, children[0]!, message.id, 0, 1000);
  assert.equal(read.totalChars, message.content.length); assert.equal(read.nextOffset, 1000);
}));
