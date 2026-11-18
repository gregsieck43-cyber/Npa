import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Kernel } from '../src/kernel/index.js';
import { buildContext } from '../src/runtime/context.js';
import type { Message } from '../src/contracts.js';

function fixture(t: import('node:test').TestContext) {
  const tempRoot = path.resolve('.tmp'), owned = mkdtempSync(path.join(tempRoot, 'long-kernel-'));
  let kernel = new Kernel(owned);
  t.after(() => { kernel.close(); assert.equal(path.dirname(owned), tempRoot); rmSync(owned, { recursive: true, force: true }); });
  return { get kernel() { return kernel; }, restart() { kernel.close(); kernel = new Kernel(owned); kernel.recover(); return kernel; } };
}
function create(kernel: Kernel) { return kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { objective: 'Persist checked milestones', maxModelCalls: 100 } }).taskId!; }
function running(kernel: Kernel, taskId: string) { const run = kernel.createRun(taskId); kernel.transition(taskId, 'running'); return run; }

test('durable Retry-After survives shutdown, a 21-day clock jump and repeated restart without extending due', t => {
  const f = fixture(t), taskId = create(f.kernel), start = Date.UTC(2026, 9, 1);
  running(f.kernel, taskId);
  const before = f.kernel.getMessages(taskId);
  const schedule = f.kernel.scheduleModelRetry(taskId, f.kernel.getTask(taskId)!.generation, 'rate_limited', 'Controlled fixture', 30 * 86400_000, start);
  const generation = f.kernel.getTask(taskId)!.generation;
  assert.equal(schedule.due, start + 30 * 86400_000, 'Provider waits beyond the JS timer range must not be shortened');
  for (let day = 1; day <= 21; day++) {
    const kernel = f.restart();
    assert.equal(kernel.getSchedule(taskId).due, schedule.due);
    assert.equal(kernel.runnableTasks(start + day * 86400_000).length, 0);
    assert.equal(kernel.getTask(taskId)!.generation, generation);
  }
  assert.equal(f.kernel.runnableTasks(schedule.due - 1).length, 0);
  assert.equal(f.kernel.runnableTasks(schedule.due).at(0)?.id, taskId);
  assert.deepEqual(f.kernel.getMessages(taskId), before);
  assert.equal(f.kernel.getBudgets(taskId).modelCalls, 0, 'Reopening and due checks consume no model budget');
});

test('consecutive retry backoff is capped, success resets it, and 12 failures safely require operator input', t => {
  const { kernel } = fixture(t), taskId = create(kernel);
  let at = Date.UTC(2026, 9, 1);
  for (let attempt = 1; attempt <= 12; attempt++) {
    running(kernel, taskId);
    const state = kernel.scheduleModelRetry(taskId, kernel.getTask(taskId)!.generation, 'provider_unavailable', 'Fixture unavailable', 0, at);
    assert.equal(state.consecutiveFailures, attempt);
    assert.equal(state.due - at, Math.min(900_000, 500 * 2 ** (attempt - 1)));
    at = state.due;
  }
  assert.equal(kernel.getTask(taskId)!.status, 'waiting_input');
  assert.match(kernel.getTask(taskId)!.waitingReason!, /12 consecutive/);
  assert.equal(kernel.runnableTasks(at + 86400_000).length, 0);
  kernel.command({ commandId: randomUUID(), taskId, type: 'retry' });
  assert.equal(kernel.runnableTasks(at - 1).length, 0, 'Operator retry also preserves provider due');
  const run = running(kernel, taskId); kernel.modelSucceeded(taskId, run.id);
  assert.deepEqual(kernel.getSchedule(taskId), { taskId, due: 0, consecutiveFailures: 0 });
  const state = kernel.scheduleModelRetry(taskId, kernel.getTask(taskId)!.generation, 'rate_limited', 'New outage', 0, at);
  assert.equal(state.consecutiveFailures, 1); assert.equal(state.due, at + 500);
});

test('retry scheduling preserves generation fences, unknown-effect barriers and spent budgets', t => {
  const { kernel } = fixture(t), taskId = create(kernel), run = running(kernel, taskId);
  kernel.consumeModelCall(taskId);
  const intent = kernel.prepareIntent(taskId, run.id, { id: 'write', name: 'write_file', arguments: { path: 'fixture.txt', content: 'value' } }, { capability: 'workspace.write' });
  kernel.approve(intent.id); kernel.dispatch(intent.id);
  assert.throws(() => kernel.scheduleModelRetry(taskId, 1, 'timeout', 'Unknown write'), /reconciled/);
  assert.equal(kernel.getIntent(intent.id)!.state, 'sent');
  assert.equal(kernel.getBudgets(taskId).modelCalls, 1);
  kernel.command({ commandId: randomUUID(), taskId, type: 'pause' });
  assert.throws(() => kernel.scheduleModelRetry(taskId, 1, 'timeout', 'Stale worker'), /generation/);
  assert.throws(() => kernel.modelSucceeded(taskId, run.id), /owns/);
  assert.equal(kernel.getIntent(intent.id)!.state, 'unknown');
});

test('pending tool projection preserves reused IDs, side isolation and recovery from schema version 2', t => {
  const f = fixture(t), taskId = create(f.kernel);
  const call = { id: 'reused', name: 'read_file', arguments: { path: 'a.txt' } };
  const first = f.kernel.addMessage(taskId, 'assistant', '', 'main', { toolCalls: [call] });
  f.kernel.addMessage(taskId, 'tool', 'first result', 'main', { toolCallId: call.id });
  const second = f.kernel.addMessage(taskId, 'assistant', '', 'main', { toolCalls: [call] });
  f.kernel.addMessage(taskId, 'tool', 'side result', 'side-test', { toolCallId: call.id });
  assert.deepEqual(f.kernel.pendingCalls(taskId), [{ messageId: second.id, call }]);
  assert.notEqual(first.id, second.id);
  const raw = f.kernel.getMessages(taskId), db = new DatabaseSync(f.kernel.dbPath);
  db.exec('DELETE FROM pending_calls; DELETE FROM schema_version WHERE version=3'); db.close();
  f.restart();
  assert.deepEqual(f.kernel.pendingCalls(taskId), [{ messageId: second.id, call }]);
  assert.deepEqual(f.kernel.getMessages(taskId), raw);
  f.kernel.addMessage(taskId, 'tool', 'second result', 'main', { toolCallId: call.id });
  assert.deepEqual(f.kernel.pendingCalls(taskId), []);
});

test('90-day UTC activity counts model attempts once across ancestor charges and records actual receipts', t => {
  const { kernel } = fixture(t), parent = create(kernel);
  kernel.command({ commandId: randomUUID(), taskId: parent, type: 'delegate', parameters: { title: 'Child', objective: 'Child milestone' } });
  const child = kernel.listTasks().find(task => task.parentId === parent)!;
  const run = running(kernel, child.id); kernel.consumeModelCall(child.id); kernel.consumeSideModelCall(parent, 'side');
  const intent = kernel.prepareIntent(child.id, run.id, { id: 'count', name: 'fixture_increment', arguments: { amount: 1 } }, { capability: 'fixture.write' });
  kernel.approve(intent.id); kernel.dispatch(intent.id); kernel.receipt(intent.id, { count: 1 });
  const db = new DatabaseSync(kernel.dbPath);
  db.prepare('UPDATE events SET created_at=?').run('2026-10-08T00:00:00.000Z'); db.close();
  const activity = kernel.activity(90, Date.parse('2026-10-08T23:59:59.999Z'));
  assert.equal(activity.timezone, 'UTC'); assert.equal(activity.days.length, 90);
  assert.equal(activity.days.at(-2)!.events, 0);
  assert.equal(activity.days.at(-1)!.modelCalls, 2, 'Child request plus side request; parent budget charge is not another request');
  assert.equal(activity.days.at(-1)!.toolEffects, 1); assert.equal(activity.days.at(-1)!.tasksCreated, 2);
  assert.equal(kernel.activity(1, Date.parse('2026-10-07T23:59:59.999Z')).days[0]!.events, 0);
});

test('bounded message and event projections keep exact tails while archived evidence remains searchable', t => {
  const { kernel } = fixture(t), taskId = create(kernel);
  for (let index = 0; index < 220; index++) kernel.addMessage(taskId, index % 2 ? 'assistant' : 'user', `milestone ${index}`);
  const raw = kernel.getMessages(taskId), events = kernel.events(taskId);
  assert.deepEqual(kernel.tailMessages(taskId, 12), raw.slice(-12));
  assert.deepEqual(kernel.recentEvents(taskId, 12), events.slice(-12));
  assert.equal(kernel.messageCount(taskId), 221);
  assert.equal(kernel.searchMessages(taskId, 'milestone 0').length, 1);
  assert.throws(() => kernel.tailMessages(taskId, Infinity), /limit/i);
});

test('context includes complete serialized summary and runtime snapshot cost in its bound', () => {
  const messages: Message[] = Array.from({ length: 120 }, (_, index) => ({ id: `${index}-${'source'.repeat(30)}`, taskId: 'task', sessionId: 'main', role: 'user', content: `Saved ${index}`, createdAt: 'now' }));
  const goal = { objective: 'Inspect historical milestones', constraints: [], acceptance: [], maxModelCalls: 100, mode: 'autonomous' as const };
  const context = buildContext({ messages, goal, role: 'main', maxChars: 4500, archivedCount: 10_000,
    summary: { text: 'Small summary with expensive source IDs', sourceIds: messages.map(message => message.id), createdAt: 'now' },
    runtimeMessages: [{ role: 'user', content: 'Current task state '.repeat(30) }] });
  assert.ok(JSON.stringify(context.messages).length <= 4500);
  assert.match(context.messages.map(message => message.content).join('\n'), /raw history records are outside/);
  assert.equal(messages.length, 120);
});

test('oversized latest tool text is a marked preview with intact protocol and preserved original', () => {
  const goal = { objective: 'Inspect the file', constraints: [], acceptance: [], maxModelCalls: 10, mode: 'autonomous' as const };
  const messages: Message[] = [
    { id: 'assistant', taskId: 'task', sessionId: 'main', role: 'assistant', content: '', createdAt: 'now', toolCalls: [{ id: 'read', name: 'read_file', arguments: { path: 'large.txt' } }] },
    { id: 'tool', taskId: 'task', sessionId: 'main', role: 'tool', toolCallId: 'read', content: '现有真实证据\n'.repeat(20_000), createdAt: 'now' },
  ];
  const original = JSON.stringify(messages), context = buildContext({ messages, goal, role: 'main', maxChars: 4500 });
  assert.ok(JSON.stringify(context.messages).length <= 4500);
  assert.equal(context.messages.at(-1)?.tool_call_id, 'read');
  assert.equal(context.messages.at(-2)?.tool_calls?.[0]?.id, 'read');
  assert.match(context.messages.at(-1)!.content!, /Preview truncated/);
  assert.equal(context.sourceManifest.find(source => source.id === 'tool')?.truncated, true);
  assert.equal(JSON.stringify(messages), original);
});

test('archive-validated memory survives the working tail while forged source IDs and cross-task memory are rejected', t => {
  const { kernel } = fixture(t), taskId = create(kernel), otherTask = create(kernel);
  const original = kernel.getMessages(taskId)[0]!;
  const memory = kernel.saveMemory(taskId, { kind: 'episode-summary', sourceIds: [original.id], text: 'An archived milestone with its original source.' });
  const recent = kernel.addMessage(taskId, 'user', 'New phase beyond the old source window');
  const messages = kernel.tailMessages(taskId, 1), goal = kernel.getTask(taskId)!.goal;
  assert.equal(messages[0]!.id, recent.id);
  const context = buildContext({ messages, goal, role: 'main', summary: memory, verifiedSummarySourceIds: kernel.verifiedMemorySources(taskId, memory) });
  assert.ok(context.messages.some(message => message.content?.includes(memory.text)));
  const forged = { ...memory, sourceIds: ['missing-raw-source'] };
  assert.deepEqual(kernel.verifiedMemorySources(taskId, forged), []);
  assert.deepEqual(kernel.verifiedMemorySources(otherTask, memory), []);
  const rejected = buildContext({ messages, goal, role: 'main', summary: forged, verifiedSummarySourceIds: kernel.verifiedMemorySources(taskId, forged) });
  assert.equal(rejected.summary, undefined);
});

test('large completed arguments are source-addressable and interrupted exchanges retain valid wire order', () => {
  const goal = { objective: 'Continue editing', constraints: [], acceptance: [], maxModelCalls: 20, mode: 'autonomous' as const };
  const message = (id: string, role: Message['role'], content: string): Message => ({ id, taskId: 'task', sessionId: 'main', role, content, createdAt: 'now' });
  const raw = [
    { ...message('write', 'assistant', ''), toolCalls: [{ id: 'write-1', name: 'write_file', arguments: { path: 'large.txt', content: '中文'.repeat(30000) } }] },
    { ...message('result', 'tool', 'Recorded actual receipt'), toolCallId: 'write-1' },
  ];
  const original = JSON.stringify(raw), context = buildContext({ messages: raw, goal, role: 'main', maxChars: 4500 });
  assert.ok(JSON.stringify(context.messages).length <= 4500);
  assert.match(context.messages.at(-2)!.tool_calls![0]!.function.arguments, /archivedArguments/);
  assert.equal(context.messages.at(-1)!.tool_call_id, 'write-1');
  assert.equal(context.sourceManifest[0]!.truncated, true); assert.equal(JSON.stringify(raw), original);
  const intervened = [
    { ...message('read', 'assistant', ''), toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'large.txt' } }] },
    message('steering', 'user', 'Apply the new naming convention'),
    { ...message('read-result', 'tool', 'Actual read result'), toolCallId: 'read-1' },
  ];
  const next = buildContext({ messages: intervened, goal, role: 'main' });
  assert.deepEqual(next.messages.slice(-3).map(item => item.role), ['assistant', 'tool', 'user']);
  assert.equal(next.messages.at(-1)!.content, intervened[1]!.content);
});
