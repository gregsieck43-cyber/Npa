import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Kernel, KernelError } from '../src/kernel/index.js';
import type { Command, Task, ToolCall } from '../src/contracts.js';

function fixture(run: (kernel: Kernel, directory: string) => void): void {
  const root = path.resolve('.tmp');
  const directory = mkdtempSync(path.join(root, 'kernel-test-'));
  const kernel = new Kernel(directory);
  try { run(kernel, directory); }
  finally { kernel.close(); assert.ok(directory.startsWith(root + path.sep)); rmSync(directory, { recursive: true, force: true }); }
}
function create(kernel: Kernel, extra: Record<string, unknown> = {}): Task {
  const ack = kernel.command({ commandId: crypto.randomUUID(), type: 'create_task', parameters: { title: 'Produce verified local artifact', ...extra } });
  return kernel.getTask(ack.taskId!)!;
}
function active(kernel: Kernel): { task: Task; runId: string } {
  const task = create(kernel); const run = kernel.createRun(task.id); kernel.transition(task.id, 'running'); return { task, runId: run.id };
}
const call: ToolCall = { id: 'call-1', name: 'write_file', arguments: { path: 'output.txt', content: 'hello' } };
const isCode = (code: string) => (error: unknown) => error instanceof KernelError && error.code === code;

test('commands deduplicate before current revision check and reject content drift', () => fixture(kernel => {
  const task = create(kernel);
  const command: Command = { commandId: 'stable-command', taskId: task.id, type: 'pause', expectedRevision: task.revision };
  const ack = kernel.command(command);
  assert.equal(kernel.command(command).status, 'duplicate');
  assert.equal(kernel.getTask(task.id)!.revision, ack.revision);
  assert.throws(() => kernel.command({ ...command, type: 'cancel' }), isCode('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => kernel.command({ ...command, commandId: 'another-command' }), isCode('REVISION_CONFLICT'));
  assert.equal(kernel.events(task.id).filter(event => event.type === 'task.paused').length, 1);
}));

test('raw histories survive checkpoints and database reopen', () => fixture((kernel, directory) => {
  const { task, runId } = active(kernel);
  kernel.addMessage(task.id, 'user', 'Original requirement');
  kernel.addMessage(task.id, 'assistant', 'Original answer');
  const checkpoint = kernel.checkpoint(task.id, runId, { summary: 'Compressed working context' });
  assert.equal(checkpoint.messageCount, 3);
  assert.equal(kernel.getMessages(task.id)[1].content, 'Original requirement');
  const reader = new Kernel(directory);
  try { assert.equal(reader.getCheckpoints(task.id)[0].context.summary, 'Compressed working context'); assert.equal(reader.getMessages(task.id).length, 3); }
  finally { reader.close(); }
}));

test('side session remains auxiliary and cannot pause or answer the main task', () => fixture(kernel => {
  const task = create(kernel);
  kernel.command({ commandId: 'side-message', type: 'send_message', taskId: task.id, parameters: { sessionId: 'side-review', content: 'Explain this requirement' } });
  assert.equal(kernel.getMessages(task.id).length, 1);
  assert.equal(kernel.getMessages(task.id, 'side-review').length, 1);
  assert.equal(kernel.listSessions(task.id)[0].id, 'side-review');
  assert.equal(kernel.getTask(task.id)!.status, 'queued');
  assert.throws(() => kernel.command({ commandId: 'side-pause', type: 'pause', taskId: task.id, parameters: { sessionId: 'side-review' } }), isCode('SIDE_SESSION_CONTROL'));
}));

test('retry is a persisted control event and creates no synthetic user message', () => fixture(kernel => {
  const { task, runId } = active(kernel);
  kernel.command({ commandId: 'retry-control', type: 'retry', taskId: task.id });
  assert.equal(kernel.getMessages(task.id).length, 1);
  assert.equal(kernel.getTask(task.id)!.generation, task.generation + 1);
  assert.throws(() => kernel.saveDecision(task.id, runId, { action: 'late' }), isCode('STALE_GENERATION'));
  assert.ok(kernel.events(task.id).some(event => event.type === 'task.retry_requested'));
}));

test('tool approval binds payload, effect identity and current generation', () => fixture(kernel => {
  const { task, runId } = active(kernel);
  const intent = kernel.prepareIntent(task.id, runId, call, { effectKey: 'stable-effect' });
  assert.equal(kernel.prepareIntent(task.id, runId, call, { effectKey: 'stable-effect' }).id, intent.id);
  assert.throws(() => kernel.dispatch(intent.id), isCode('INVALID_INTENT_STATE'));
  assert.throws(() => kernel.prepareIntent(task.id, runId, { ...call, arguments: { path: 'output.txt', content: 'changed' } }, { effectKey: 'stable-effect' }), isCode('EFFECT_KEY_CONFLICT'));
  kernel.approve(intent.id); kernel.dispatch(intent.id);
  assert.throws(() => kernel.dispatch(intent.id), isCode('INVALID_INTENT_STATE'));
  kernel.receipt(intent.id, { artifact: 'artifact-1', verified: true });
  assert.equal(kernel.receipt(intent.id, { verified: true, artifact: 'artifact-1' }).state, 'applied');
  assert.throws(() => kernel.receipt(intent.id, { artifact: 'other' }), isCode('RECEIPT_CONFLICT'));
}));

test('revoked approvals cannot dispatch and a different task cannot grant', () => fixture(kernel => {
  const { task, runId } = active(kernel); const other = create(kernel);
  const intent = kernel.prepareIntent(task.id, runId, call); kernel.approve(intent.id);
  assert.throws(() => kernel.command({ commandId: 'wrong-grant', type: 'grant', taskId: other.id, parameters: { intentId: intent.id } }), isCode('WRONG_TASK'));
  kernel.revoke(task.id, intent.id);
  assert.equal(kernel.getIntent(intent.id)!.state, 'denied');
  assert.throws(() => kernel.dispatch(intent.id), isCode('STALE_GENERATION'));
}));

test('recovery turns sent into unknown and prevents duplicate tool execution', () => fixture(kernel => {
  const { task, runId } = active(kernel); const intent = kernel.prepareIntent(task.id, runId, call);
  kernel.approve(intent.id); kernel.dispatch(intent.id);
  const recovered = kernel.recover();
  assert.deepEqual(recovered.unknownIntents, [intent.id]); assert.deepEqual(recovered.reconciling, [task.id]);
  assert.equal(kernel.getTask(task.id)!.status, 'reconciling');
  assert.throws(() => kernel.createRun(task.id), isCode('TASK_NOT_RUNNABLE'));
  assert.throws(() => kernel.dispatch(intent.id), isCode('STALE_GENERATION'));
  kernel.command({ commandId: 'retry-unknown', type: 'retry', taskId: task.id });
  assert.equal(kernel.getTask(task.id)!.status, 'reconciling');
  kernel.reconcile(intent.id, { observed: 'artifact exists', artifact: 'output-hash' });
  assert.equal(kernel.getIntent(intent.id)!.state, 'applied'); assert.equal(kernel.getTask(task.id)!.status, 'queued');
  assert.equal(kernel.createRun(task.id).generation, kernel.getTask(task.id)!.generation);
}));

test('recovery revokes unsent approval and preserves original history', () => fixture(kernel => {
  const { task, runId } = active(kernel); kernel.addMessage(task.id, 'user', 'Run once');
  const intent = kernel.prepareIntent(task.id, runId, call); kernel.approve(intent.id); kernel.transition(task.id, 'waiting_approval');
  const recovered = kernel.recover();
  assert.deepEqual(recovered.requeued, [task.id]); assert.equal(kernel.getIntent(intent.id)!.state, 'denied');
  assert.equal(kernel.getMessages(task.id).at(-1)!.content, 'Run once');
  assert.throws(() => kernel.dispatch(intent.id), isCode('STALE_GENERATION'));
}));

test('budget persists and autonomous mode never bypasses capability ceiling', () => fixture(kernel => {
  const task = create(kernel, { goal: { objective: 'Bounded autonomous task', mode: 'autonomous', maxModelCalls: 1 } });
  kernel.setCapabilityCeiling(task.id, ['workspace.read']); const run = kernel.createRun(task.id);
  kernel.consumeModelCall(task.id, run.id);
  assert.throws(() => kernel.consumeModelCall(task.id, run.id), isCode('BUDGET_EXHAUSTED'));
  assert.throws(() => kernel.prepareIntent(task.id, run.id, call), isCode('CAPABILITY_DENIED'));
  assert.throws(() => kernel.setCapabilityCeiling(task.id, ['workspace.read', 'workspace.write']), isCode('CAPABILITY_ESCALATION'));
  assert.equal(kernel.getBudgets(task.id).modelCalls, 1);
}));

test('delegation ownership is transactional and parent cancel cancels descendants', () => fixture(kernel => {
  const parent = create(kernel);
  kernel.command({ commandId: 'delegate-one', type: 'delegate', taskId: parent.id, parameters: { title: 'First child', paths: ['shared'] } });
  const child = kernel.getTask(kernel.delegations(parent.id)[0].childTaskId)!;
  assert.equal(child.workspace, parent.workspace, 'Explicit shared paths retain the parent workspace');
  const count = kernel.listTasks().length;
  assert.throws(() => kernel.command({ commandId: 'delegate-conflict', type: 'delegate', taskId: parent.id, parameters: { title: 'Conflicting child', paths: ['shared/file.txt'] } }), isCode('OWNERSHIP_CONFLICT'));
  assert.equal(kernel.listTasks().length, count);
  const parentRun = kernel.createRun(parent.id);
  assert.throws(() => kernel.prepareIntent(parent.id, parentRun.id, { ...call, arguments: { path: 'shared/file.txt', content: 'overwrite' } }), isCode('OWNERSHIP_CONFLICT'));
  kernel.command({ commandId: 'delegate-grandchild', type: 'delegate', taskId: child.id, parameters: { title: 'Grandchild', paths: ['separate'] } });
  kernel.command({ commandId: 'cancel-tree', type: 'cancel', taskId: parent.id });
  assert.ok(kernel.listTasks().every(task => task.status === 'cancelled'));
}));

test('tool path cannot escape task workspace', () => fixture(kernel => {
  const { task, runId } = active(kernel);
  assert.throws(() => kernel.prepareIntent(task.id, runId, { ...call, arguments: { path: '../escaped.txt', content: 'x' } }), isCode('OUTSIDE_WORKSPACE'));
}));

test('independent verification gates child result acceptance', () => fixture(kernel => {
  const parent = create(kernel); kernel.command({ commandId: 'delegate-review', type: 'delegate', taskId: parent.id, parameters: { title: 'Verified child', paths: ['result.txt'] } });
  const childId = kernel.delegations(parent.id)[0].childTaskId; const child = kernel.getTask(childId)!; const run = kernel.createRun(childId);
  kernel.transition(childId, 'running');
  assert.throws(() => kernel.transition(childId, 'completed'), isCode('UNVERIFIED_RESULT'));
  assert.throws(() => kernel.command({ commandId: 'accept-unverified', type: 'accept_result', taskId: parent.id, parameters: { childTaskId: childId } }), isCode('RESULT_NOT_READY'));
  assert.throws(() => kernel.verify(childId, run.id, { passed: true, reviewer: child.owner }), isCode('INDEPENDENT_REVIEW_REQUIRED'));
  kernel.verify(childId, run.id, { passed: true, reviewer: 'independent-reviewer', evidence: ['artifact-hash'] });
  kernel.transition(childId, 'completed', { result: 'Produced expected artifact' });
  kernel.command({ commandId: 'accept-verified', type: 'accept_result', taskId: parent.id, parameters: { childTaskId: childId } });
  assert.equal(kernel.delegations(parent.id)[0].state, 'accepted');
  const parentRun = kernel.createRun(parent.id);
  assert.equal(kernel.prepareIntent(parent.id, parentRun.id, { ...call, arguments: { path: 'result.txt', content: 'Accepted parent update' } }).state, 'prepared');
}));

test('completion cannot hide an unresolved effect', () => fixture(kernel => {
  const { task, runId } = active(kernel); const intent = kernel.prepareIntent(task.id, runId, call);
  assert.throws(() => kernel.transition(task.id, 'completed'), isCode('UNRESOLVED_EFFECT'));
  kernel.deny(intent.id); kernel.verify(task.id, runId, { passed: true, reviewer: 'independent-reviewer', evidence: ['no artifact effect'] }); kernel.transition(task.id, 'completed');
  assert.equal(kernel.getTask(task.id)!.status, 'completed');
}));

test('completion rejects a PASS after the main user changes the task', () => fixture(kernel => {
  const { task, runId } = active(kernel);
  const current = kernel.getTask(task.id)!;
  kernel.verify(task.id, runId, { passed: true, reviewer: 'independent-reviewer', expectedRevision: current.revision, generation: current.generation, goalVersion: current.goalVersion, evidence: ['output-hash'] });
  kernel.command({ commandId: 'change-requirement', type: 'send_message', taskId: task.id, parameters: { content: 'Also include a second section' } });
  assert.throws(() => kernel.transition(task.id, 'completed'), isCode('INVALID_TRANSITION'));
  assert.throws(() => kernel.verify(task.id, runId, { passed: true, reviewer: 'independent-reviewer', expectedRevision: current.revision }), isCode('STALE_GENERATION'));
  const replacement = kernel.createRun(task.id); kernel.transition(task.id, 'running');
  kernel.verify(task.id, replacement.id, { passed: true, reviewer: 'independent-reviewer', evidence: ['updated-output-hash'] });
  kernel.transition(task.id, 'completed');
}));

test('parent policy narrowing invalidates child approval and its run', () => fixture(kernel => {
  const parent = create(kernel);
  kernel.command({ commandId: 'delegate-policy', type: 'delegate', taskId: parent.id, parameters: { title: 'Child fixture task' } });
  const childId = kernel.delegations(parent.id)[0].childTaskId; const run = kernel.createRun(childId);
  const intent = kernel.prepareIntent(childId, run.id, { id: 'fixture', name: 'fixture_increment', arguments: {} });
  kernel.approve(intent.id);
  kernel.setCapabilityCeiling(parent.id, ['workspace.read']);
  assert.deepEqual(kernel.getCapabilityCeiling(childId), ['workspace.read']);
  assert.equal(kernel.getIntent(intent.id)!.state, 'denied');
  assert.throws(() => kernel.dispatch(intent.id), isCode('STALE_GENERATION'));
  const next = kernel.createRun(childId);
  assert.throws(() => kernel.prepareIntent(childId, next.id, { id: 'fixture-again', name: 'fixture_increment', arguments: {} }), isCode('CAPABILITY_DENIED'));
}));

test('recovered unsent intent rebinds same effect and requires fresh approval', () => fixture(kernel => {
  const { task, runId } = active(kernel);
  const intent = kernel.prepareIntent(task.id, runId, call, { effectKey: 'stable-assistant-effect' });
  kernel.approve(intent.id); kernel.recover();
  const run = kernel.createRun(task.id); const rebound = kernel.rebindIntent(intent.id, run.id);
  assert.equal(rebound.effectKey, intent.effectKey); assert.equal(rebound.state, 'prepared'); assert.notEqual(rebound.digest, intent.digest);
  assert.throws(() => kernel.dispatch(intent.id), isCode('INVALID_INTENT_STATE'));
  kernel.approve(intent.id); kernel.dispatch(intent.id); kernel.receipt(intent.id, { artifact: 'one-output' });
  assert.equal(kernel.intents(task.id).length, 1);
}));

test('user denial stays final even when its reason imitates recovery text', () => fixture(kernel => {
  const { task, runId } = active(kernel);
  const intent = kernel.prepareIntent(task.id, runId, call);
  kernel.deny(intent.id, 'Previous process approval was invalidated during recovery');
  kernel.recover(); const run = kernel.createRun(task.id);
  assert.throws(() => kernel.rebindIntent(intent.id, run.id), isCode('INTENT_NOT_REBINDABLE'));
}));

test('raw initial goal is stored atomically as user history', () => fixture(kernel => {
  const task = create(kernel, { goal: { objective: '  exact supplied objective  ', constraints: ['Use local files'], acceptance: ['Has two sections'] } });
  assert.equal(task.goal.objective, 'exact supplied objective');
  assert.deepEqual(kernel.getMessages(task.id).map(message => [message.role, message.content]), [['user', '  exact supplied objective  ']]);
  assert.ok(kernel.events(task.id).some(event => event.type === 'message.appended'));
}));

test('parent authorization revocation invalidates active descendant approval', () => fixture(kernel => {
  const parent = create(kernel);
  kernel.command({ commandId: 'delegate-revoke', type: 'delegate', taskId: parent.id, parameters: { title: 'Child write' } });
  const childId = kernel.delegations(parent.id)[0].childTaskId; const run = kernel.createRun(childId);
  const intent = kernel.prepareIntent(childId, run.id, call); kernel.approve(intent.id);
  kernel.revoke(parent.id);
  assert.equal(kernel.getIntent(intent.id)!.state, 'denied');
  assert.throws(() => kernel.dispatch(intent.id), isCode('STALE_GENERATION'));
}));

test('child model calls atomically consume the saved ancestor budget', () => fixture(kernel => {
  const parent = create(kernel, { maxModelCalls: 1 });
  kernel.command({ commandId: 'delegate-budget-one', type: 'delegate', taskId: parent.id, parameters: { title: 'First child', maxModelCalls: 2 } });
  kernel.command({ commandId: 'delegate-budget-two', type: 'delegate', taskId: parent.id, parameters: { title: 'Second child', maxModelCalls: 2 } });
  const children = kernel.delegations(parent.id).map(delegation => delegation.childTaskId);
  const runs = children.map(childId => kernel.createRun(childId));
  kernel.consumeModelCall(children[0], runs[0].id);
  assert.equal(kernel.getBudgets(parent.id).modelCalls, 1);
  assert.equal(kernel.getBudgets(children[0]).modelCalls, 1);
  assert.throws(() => kernel.consumeModelCall(children[1], runs[1].id), isCode('BUDGET_EXHAUSTED'));
  assert.equal(kernel.getBudgets(children[1]).modelCalls, 0);
}));

test('answer queues a fresh fenced run after clarification and terminal input continues', () => fixture(kernel => {
  const { task, runId } = active(kernel);
  kernel.transition(task.id, 'waiting_input', { waitingReason: 'Choose the required output format' });
  kernel.command({ commandId: 'answer-format', type: 'answer', taskId: task.id, parameters: { content: 'Use a text file' } });
  assert.equal(kernel.getTask(task.id)!.status, 'queued');
  assert.throws(() => kernel.assertFence(task.id, runId), isCode('STALE_GENERATION'));
  const next = kernel.createRun(task.id); kernel.transition(task.id, 'running');
  kernel.verify(task.id, next.id, { passed: true, reviewer: 'independent-reviewer' });
  kernel.transition(task.id, 'completed'); kernel.finishRun(next.id, 'completed');
  kernel.command({ commandId: 'continue-task', type: 'send_message', taskId: task.id, parameters: { content: 'Add an example' } });
  assert.equal(kernel.getTask(task.id)!.status, 'queued');
  assert.equal(kernel.getMessages(task.id).at(-1)!.content, 'Add an example');
  assert.equal(kernel.createRun(task.id).generation, next.generation + 1);
}));

test('derived memory is scoped, source-bound and leaves raw history and task authority intact', () => fixture((kernel, directory) => {
  const { task } = active(kernel);
  const source = kernel.addMessage(task.id, 'assistant', 'A durable original discussion');
  const side = kernel.addMessage(task.id, 'assistant', 'Side discussion', 'side-a');
  const revision = kernel.getTask(task.id)!.revision;
  const raw = kernel.getMessages(task.id);
  const memory = kernel.saveMemory(task.id, { kind: 'episode-summary', sourceIds: raw.map(message => message.id), text: 'Short derived episode summary' });
  assert.equal(kernel.saveMemory(task.id, { kind: 'episode-summary', sourceIds: raw.map(message => message.id), text: memory.text }).id, memory.id);
  assert.deepEqual(kernel.getMessages(task.id), raw);
  assert.equal(kernel.getTask(task.id)!.revision, revision);
  assert.ok(memory.sources.find(manifest => manifest.id === source.id)!.hash.length === 64);
  assert.throws(() => kernel.saveMemory(task.id, { kind: 'episode-summary', sourceIds: [side.id], text: 'Wrong session' }), isCode('INVALID_MEMORY_SOURCE'));
  kernel.saveMemory(task.id, { kind: 'episode-summary', sourceIds: [side.id], text: 'Side summary', sessionId: 'side-a' });
  assert.equal(kernel.getMemories(task.id).length, 1); assert.equal(kernel.getMemories(task.id, 'side-a').length, 1);
  const reader = new Kernel(directory);
  try { assert.equal(reader.getMemories(task.id)[0].sourceDigest, memory.sourceDigest); assert.deepEqual(reader.getMessages(task.id), raw); }
  finally { reader.close(); }
}));

test('manual acceptance from waiting input requires a fresh independent PASS', () => fixture(kernel => {
  const { task, runId } = active(kernel);
  kernel.addMessage(task.id, 'assistant', 'A proposed natural-language result');
  kernel.transition(task.id, 'waiting_input', { waitingReason: 'Manual acceptance needed for this criterion' });
  assert.throws(() => kernel.transition(task.id, 'completed'), isCode('UNVERIFIED_RESULT'));
  const current = kernel.getTask(task.id)!;
  kernel.verify(task.id, runId, { passed: true, reviewer: 'local-operator', expectedRevision: current.revision, humanEvidence: 'Checked the required explanation' });
  kernel.transition(task.id, 'completed', { result: 'A proposed natural-language result' });
  assert.equal(kernel.getTask(task.id)!.status, 'completed');
}));

test('operator tool proposals deduplicate atomically before task state checking', () => fixture(kernel => {
  const task = create(kernel);
  const proposal: Command = { commandId: 'operator-save-request', taskId: task.id, type: 'propose_tool', expectedRevision: task.revision,
    parameters: { name: 'write_file', arguments: { path: 'operator.txt', content: 'one write' } } };
  const ack = kernel.command(proposal);
  assert.equal(kernel.getTask(task.id)!.generation, task.generation + 1);
  const messages = kernel.getMessages(task.id);
  assert.equal(messages.filter(message => message.toolCalls?.length).length, 1);
  assert.equal(kernel.events(task.id).find(event => event.type === 'tool.proposal_owned')!.payload.toolCallId, messages.find(message => message.toolCalls?.length)!.toolCalls![0]!.id);
  assert.equal(messages.filter(message => message.role === 'user').length, 1);
  const run = kernel.createRun(task.id); kernel.transition(task.id, 'running');
  assert.equal(kernel.command(proposal).status, 'duplicate');
  assert.equal(kernel.command(proposal).revision, ack.revision);
  assert.equal(kernel.getMessages(task.id).length, messages.length);
  assert.throws(() => kernel.command({ ...proposal, parameters: { name: 'write_file', arguments: { path: 'operator.txt', content: 'different write' } } }), isCode('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => kernel.command({ ...proposal, commandId: 'second-request', expectedRevision: undefined }), isCode('TASK_NOT_EDITABLE'));
  assert.equal(kernel.getRuns(task.id).find(item => item.id === run.id)!.status, 'running');
}));

test('identical operator proposals have distinct call provenance and replay keeps the original call', () => fixture(kernel => {
  const task = create(kernel);
  const proposal: Command = { commandId: 'save-request-one', taskId: task.id, type: 'propose_tool',
    parameters: { name: 'write_file', arguments: { path: 'same.txt', content: 'same contents' } } };
  kernel.command(proposal);
  kernel.command({ ...proposal, commandId: 'save-request-two' });
  assert.equal(kernel.command(proposal).status, 'duplicate');
  const messages = kernel.getMessages(task.id).filter(message => message.toolCalls?.length);
  const events = kernel.events(task.id).filter(event => event.type === 'tool.proposal_owned');
  assert.equal(messages.length, 2); assert.equal(events.length, 2);
  assert.notEqual(messages[0]!.toolCalls![0]!.id, messages[1]!.toolCalls![0]!.id);
  assert.equal(events[0]!.payload.commandId, 'save-request-one'); assert.equal(events[1]!.payload.commandId, 'save-request-two');
  assert.equal(events[0]!.payload.toolCallId, messages[0]!.toolCalls![0]!.id);
  assert.equal(events[1]!.payload.toolCallId, messages[1]!.toolCalls![0]!.id);
}));

test('default delegation isolates workspace and recursively preserves ancestor constraints', () => fixture(kernel => {
  const parent = create(kernel, { goal: { objective: 'Parent work', constraints: ['Preserve safety kernel'] } });
  kernel.command({ commandId: 'isolated-child', type: 'delegate', taskId: parent.id, parameters: { goal: { objective: 'Child work', constraints: ['Produce scoped artifact'] } } });
  const child = kernel.getTask(kernel.delegations(parent.id)[0].childTaskId)!;
  assert.equal(child.workspace, path.join(parent.workspace, 'subtasks', child.id));
  assert.deepEqual(child.goal.constraints, ['Preserve safety kernel', 'Produce scoped artifact']);
  const childRun = kernel.createRun(child.id);
  assert.equal(kernel.prepareIntent(child.id, childRun.id, call).state, 'prepared');
  const parentRun = kernel.createRun(parent.id);
  const childFile = path.relative(parent.workspace, path.join(child.workspace, 'output.txt'));
  assert.throws(() => kernel.prepareIntent(parent.id, parentRun.id, { ...call, id: 'parent-overlap', arguments: { path: childFile, content: 'overwrite' } }), isCode('OWNERSHIP_CONFLICT'));
  assert.equal(kernel.prepareIntent(parent.id, parentRun.id, { id: 'parent-read', name: 'read_file', arguments: { path: childFile } }).state, 'prepared');
  kernel.command({ commandId: 'isolated-grandchild', type: 'delegate', taskId: child.id, parameters: { objective: 'Grandchild work' } });
  const grandchild = kernel.getTask(kernel.delegations(child.id)[0].childTaskId)!;
  assert.equal(grandchild.workspace, path.join(child.workspace, 'subtasks', grandchild.id));
  const grandchildRun = kernel.createRun(grandchild.id);
  assert.equal(kernel.prepareIntent(grandchild.id, grandchildRun.id, call).state, 'prepared');
}));

test('storage health reports actual SQLite settings', () => fixture(kernel => {
  const info = kernel.storageInfo();
  assert.equal(info.driver, 'node:sqlite');
  assert.match(info.sqliteVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(info.journalMode, 'wal');
  assert.equal(info.synchronous, 2);
  assert.equal(info.schemaVersion, 4);
}));

test('event pages traverse more than 200 persisted events without gaps and preserve full legacy history', () => fixture((kernel, directory) => {
  const task = create(kernel); const outsider = create(kernel);
  for (let index = 0; index < 300; index++) {
    kernel.appendEvent(task.id, 'pagination.fixture', { index });
    if (index % 30 === 0) kernel.appendEvent(outsider.id, 'unrelated.fixture', { index });
  }
  const all = kernel.events(task.id);
  assert.equal(all.length, 302);
  const reopened = new Kernel(directory);
  try {
    let after = 0; const visited: number[] = []; const pageSizes: number[] = [];
    while (true) {
      const page = reopened.events(task.id, after, 128);
      if (!page.length) break;
      pageSizes.push(page.length); visited.push(...page.map(event => event.seq)); after = page.at(-1)!.seq;
    }
    assert.deepEqual(pageSizes, [128, 128, 46]);
    assert.deepEqual(visited, all.map(event => event.seq));
    assert.equal(new Set(visited).size, all.length);
    assert.equal(reopened.events(task.id, after, 1).length, 0);
    assert.deepEqual(reopened.events(task.id, 0, 1001), all);
    assert.deepEqual(reopened.events(task.id), all);
    for (const limit of [0, -1, 1.1, 1002, Infinity, NaN]) assert.throws(() => reopened.events(task.id, 0, limit), isCode('INVALID_EVENT_LIMIT'));
    assert.equal(reopened.events(outsider.id, 0, 1)[0].taskId, outsider.id);
  } finally { reopened.close(); }
}));
