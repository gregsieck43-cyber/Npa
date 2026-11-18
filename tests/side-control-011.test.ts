import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Kernel } from '../src/kernel/index.js';
import { IntegrationService } from '../src/integrations/index.js';
import { ProductStore } from '../src/product/store.js';
import { ProductSideChat } from '../src/product/sidechat.js';
import type { ProductRuntime } from '../src/product/shared.js';
import type { ProductSessions } from '../src/product/sessions.js';
import type { ModelResult, ToolCall } from '../src/contracts.js';

const root = path.resolve(process.env.NPN_SIDE_TEST_ROOT ?? '.tmp/continuation-20261117-side/cases');
const reply = (toolCalls: ToolCall[] = [], content = 'Recorded.'): ModelResult => ({ toolCalls, content, finishReason: toolCalls.length ? 'tool_calls' : 'stop' });
const tool = (action: string, parameters: Record<string, unknown>, task: { revision: number; goalVersion: number; generation: number }): ToolCall =>
  ({ id: `call-${action}`, name: 'manage_task', arguments: { action, parameters, expectedRevision: task.revision, goalVersion: task.goalVersion, generation: task.generation } });
async function setup(t: test.TestContext, respond: (body: any, index: number, signal: AbortSignal) => ModelResult | Promise<ModelResult>, maxRequestBytes = 32768) {
  mkdirSync(root, { recursive: true }); const dir = mkdtempSync(path.join(root, 'case-'));
  const kernel = new Kernel(dir); const integrations = new IntegrationService({ kernel, dataDir: dir, projectRoot: dir });
  const store = new ProductStore(dir); const trace: any[] = [];
  const rt = { services: { kernel, integrations, command: (command: any) => kernel.command(command) }, store,
    harness: { sanitize: (value: string) => value, profiles: { get: () => ({ provider: { mode: 'mock', baseUrl: 'http://localhost/', model: 'test', maxOutputTokens: 64, timeoutMs: 10000, maxRequestBytes } }) },
      requests: { prepare: (_meta: any, body: any) => { trace.push(body); return { id: `request-${trace.length}` }; },
        send: (_id: string, body: any, signal: AbortSignal) => respond(body, trace.length, signal) }, store: { getSession: () => { throw new Error('No Chat session'); } } },
    append: () => undefined,
  } as unknown as ProductRuntime;
  const side = new ProductSideChat(rt, { indexWorkTask: () => undefined, summary: () => ({}) } as unknown as ProductSessions);
  t.after(async () => { await side.close(); store.close(); integrations.close(); kernel.close(); assert.ok(dir.startsWith(root + path.sep)); rmSync(dir, { recursive: true, force: true }); });
  const create = (permissionMode = 'ask') => kernel.command({ commandId: 'create', type: 'create_task', parameters: { workspace: dir, title: 'main', initialStatus: 'paused', permissionMode } }).taskId!;
  const ask = (sessionId?: string, messageId = 'side-input') => side.ask({ sessionId, messageId, question: 'Please manage the task as requested.', attachments: [], modelId: 'test' }, async () => '', () => 'Main reference');
  return { kernel, integrations, store, side, create, ask, trace, rt };
}

test('side controls share the exact main task and retain user provenance and duplicate receipts', async t => {
  let env: Awaited<ReturnType<typeof setup>>, taskId: string;
  env = await setup(t, (_body, index) => index === 1 ? reply([tool('resume', {}, env.kernel.getTask(taskId)!)]) : reply());
  taskId = env.create('full-access');
  const answer = await env.ask(taskId);
  assert.equal(env.kernel.getTask(taskId)!.status, 'queued');
  assert.equal(env.kernel.permissionMode(taskId), 'full-access');
  assert.equal(env.kernel.listTasks().length, 1);
  assert.equal(answer.targetTaskId, taskId);
  assert.equal(answer.operations?.length, 1);
  const event = env.kernel.latestEvent(taskId, 'command.side_applied')!;
  assert.deepEqual(event.payload.source, { surface: 'side', sessionId: answer.sideSessionId, userMessageId: 'side-input' });
  const requests = env.trace.length;
  assert.deepEqual(await env.ask(taskId), answer);
  assert.equal(env.trace.length, requests);
  assert.equal(env.side.history(taskId).items[0]!.operations?.[0]!.commandId, answer.operations![0]!.commandId);
});

test('stale side proposals and plan approval cannot mutate the main task', async t => {
  let env: Awaited<ReturnType<typeof setup>>, taskId: string;
  env = await setup(t, (_body, index) => {
    const current = env.kernel.getTask(taskId)!;
    if (index === 1) { env.kernel.command({ commandId: 'new-user', type: 'send_message', taskId, parameters: { content: 'Keep paused.' } }); return reply([tool('resume', {}, current)]); }
    if (index === 2) return reply([tool('approve_plan', {}, current)]);
    return reply();
  });
  taskId = env.create(); const answer = await env.ask(taskId);
  assert.equal(answer.operations?.length, 0);
  assert.equal(env.kernel.getTask(taskId)!.status, 'paused');
  assert.ok(env.trace.some(body => body.messages.some((m: any) => m.role === 'tool' && m.content.includes('version changed'))));
  assert.ok(env.trace.some(body => body.messages.some((m: any) => m.role === 'tool' && m.content.includes('Unsupported side control'))));
});

test('first side operation binds a paused task with fixed authority, never another running owner', async t => {
  const env = await setup(t, (_body, index) => index === 1 ? reply([{ id: 'bind', name: 'manage_task', arguments: { action: 'resume', parameters: {} } }]) : reply());
  const answer = await env.ask();
  const task = env.kernel.getTask(answer.targetTaskId!)!;
  assert.equal(task.status, 'paused'); assert.equal(task.permissionMode, 'ask'); assert.equal(task.goal.objective, answer.question);
  assert.equal(env.kernel.listTasks().length, 1);
  assert.equal(env.kernel.isManagedExternally(task.id), false);
  assert.equal(env.side.history().targetTaskId, task.id);
  assert.equal(env.kernel.latestEvent(task.id, 'command.side_applied')!.payload.commandType, 'create_task');
});

test('a cancelled main task cannot be resurrected by an old side proposal', async t => {
  let env: Awaited<ReturnType<typeof setup>>, taskId: string;
  env = await setup(t, (_body, index) => {
    if (index !== 1) return reply();
    const current = env.kernel.getTask(taskId)!;
    env.kernel.command({ commandId: 'cancel-main', type: 'cancel', taskId });
    return reply([tool('send_message', { content: 'run again' }, current)]);
  });
  taskId = env.create(); const before = env.kernel.messageCount(taskId);
  const answer = await env.ask(taskId);
  assert.equal(env.kernel.getTask(taskId)!.status, 'cancelled'); assert.equal(answer.operations?.length, 0);
  assert.equal(env.kernel.messageCount(taskId), before);
});

test('side input recovery includes every unconsumed user message, and history is paged', async t => {
  const env = await setup(t, () => reply());
  const session = env.store.sideSession('');
  env.store.saveSideTurn(session.id, { id: 'offline', sideSessionId: session.id, question: 'Preserve the earlier constraint', answer: 'offline', createdAt: new Date().toISOString(), status: 'failed' }, 'Preserve the earlier constraint');
  await env.ask();
  const inputs = env.trace[0].messages.filter((message: any) => message.role === 'user').map((message: any) => message.content).join('\n');
  assert.match(inputs, /Preserve the earlier constraint/); assert.match(inputs, /Please manage the task/);
  for (let i = 0; i < 90; i++) env.store.saveSideTurn(session.id, { id: `old-${i}`, question: 'old', answer: 'x'.repeat(6000), createdAt: new Date().toISOString(), status: 'completed' });
  const first = env.side.history(); assert.ok(first.items.length <= 40 && first.nextCursor);
  const second = env.side.history(undefined, session.id, first.nextCursor);
  assert.ok(second.items.length > 0); assert.ok(!second.items.some(item => first.items.some(other => other.id === item.id)));
});

test('cancelling side sampling releases its request without cancelling the main task', async t => {
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const env = await setup(t, (_body, _index, signal) => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  const taskId = env.create(); const session = env.side.history(taskId);
  const pending = env.ask(taskId); await active;
  await env.side.cancel(taskId, session.sideSessionId);
  await assert.rejects(pending, /cancelled/);
  assert.equal(env.kernel.getTask(taskId)!.status, 'paused');
  assert.equal(env.side.history(taskId).items[0]!.status, 'cancelled');
  assert.deepEqual(env.store.sideInputNotes(session.sideSessionId), []);
  assert.equal(env.store.sideSession(taskId, session.sideSessionId).consumed, 0);
});

test('large side inputs use durable ordered fragments before any control can execute', async t => {
  let env: Awaited<ReturnType<typeof setup>>, taskId: string;
  env = await setup(t, body => !body.tools?.length ? reply([], 'Attachment constraints require review before resuming.')
    : body.messages.some((item: any) => item.role === 'tool') ? reply() : reply([tool('resume', {}, env.kernel.getTask(taskId)!)]));
  taskId = env.create();
  const input = 'attachment constraint '.repeat(4000) + ' final Unicode 🧭';
  const answer = await env.side.ask({ sessionId: taskId, messageId: 'fragmented', question: 'Read every attachment constraint before resuming.', attachments: [], modelId: 'test' }, async () => input, () => '');
  assert.equal(answer.operations?.length, 1); assert.equal(env.kernel.getTask(taskId)!.status, 'queued');
  assert.ok(env.trace.length > 2); assert.ok(env.trace.every(body => Buffer.byteLength(JSON.stringify(body)) <= 32768));
  const db = new DatabaseSync(env.store.path(), { readOnly: true });
  try {
    const rows = db.prepare('SELECT ranges,consumed FROM side_request_inputs ORDER BY rowid').all() as { ranges: string; consumed: number }[];
    const ranges = rows.flatMap(row => { assert.equal(row.consumed, 1); return JSON.parse(row.ranges); });
    let through = 0;
    for (const range of ranges) { assert.equal(range.id, 'fragmented'); assert.equal(range.start, through); through = range.end; }
    assert.equal(through, answer.question.length + input.length);
    const session = env.store.sideSession(taskId, answer.sideSessionId); assert.equal(session.offset, 0); assert.equal(session.consumed, env.store.sideTurn('fragmented')!.seq);
  } finally { db.close(); }
});

test('side indexed recall includes original attachments and enforces session ownership', async t => {
  const env = await setup(t, () => reply()); const a = env.store.sideSession('a'), b = env.store.sideSession('b');
  env.store.saveSideTurn(a.id, { id: 'archive-a', question: 'Remember the attachment', answer: '', createdAt: new Date().toISOString(), status: 'completed' }, 'original constraint amber-checkpoint');
  env.store.saveSideTurn(b.id, { id: 'archive-b', question: 'amber-checkpoint', answer: '', createdAt: new Date().toISOString(), status: 'completed' });
  assert.deepEqual(env.store.searchSide(a.id, 'amber-checkpoint').items.map(item => item.id), ['archive-a']);
  assert.match(env.store.sideSource(a.id, 'archive-a'), /original constraint/);
  assert.throws(() => env.store.sideSource(a.id, 'archive-b'), /outside this side session/);
});

test('a long current question fits a small request budget without losing the earliest fragment', async t => {
  const env = await setup(t, body => {
    const text = JSON.stringify(body.messages);
    if (!body.tools?.length) return reply([], text.includes('AMBER-REQUIRED') ? 'AMBER-REQUIRED must be checked.' : 'No additional constraints.');
    assert.match(text, /AMBER-REQUIRED/, 'final sample must retain evidence from the first fragment');
    return reply([], 'AMBER-REQUIRED remains required.');
  }, 8192);
  const question = 'AMBER-REQUIRED ' + 'long current question '.repeat(350);
  const answer = await env.side.ask({ messageId: 'long-question', question, attachments: [], modelId: 'test' }, async () => '', () => '');
  assert.equal(answer.status, 'completed');
  assert.ok(env.trace.length > 2);
  assert.ok(env.trace.every(body => Buffer.byteLength(JSON.stringify(body)) <= 8192));
});

test('fragment samples preserve early attachment meaning for the final answer', async t => {
  let fragments = 0;
  const env = await setup(t, body => {
    const text = JSON.stringify(body.messages);
    if (!body.tools?.length) { fragments++; return reply([], text.includes('AMBER-REQUIRED') ? 'AMBER-REQUIRED must be checked.' : 'No additional constraints.'); }
    assert.ok(fragments > 1, 'input-only fragments must not expose task controls');
    assert.match(text, /AMBER-REQUIRED/, 'earlier fragment results must reach the final model request');
    assert.match(text, /derived|non-authoritative/i);
    return reply([], 'AMBER-REQUIRED remains required.');
  });
  const answer = await env.side.ask({ messageId: 'meaning', question: 'Describe the attachment constraints.', attachments: [], modelId: 'test' },
    async () => ' AMBER-REQUIRED ' + 'filler '.repeat(12000), () => '');
  assert.equal(answer.status, 'completed');
});

for (const interruption of ['failure', 'cancel'] as const) test(`${interruption} during fragment reading recovers durable notes and exact original input after service restart`, async t => {
  let fail = true;
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const source = 'Read attachment constraints.' + ' AMBER-REQUIRED ' + 'filler '.repeat(9000);
  const env = await setup(t, (body, index, signal) => {
    if (fail && index === 2) {
      if (interruption === 'failure') throw new Error('provider interrupted');
      return new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    }
    if (!body.tools?.length) return reply([], JSON.stringify(body.messages).includes('AMBER-REQUIRED') ? 'AMBER-REQUIRED must be checked.' : 'No additional constraints.');
    assert.match(JSON.stringify(body.messages), /AMBER-REQUIRED/);
    const evidence = body.messages.find((message: any) => message.role === 'tool');
    if (!evidence) return reply([{ id: 'recall-original', name: 'read_side_history', arguments: { turnId: 'interrupted', inputOnly: true, offset: 0 } }]);
    const original = JSON.parse(evidence.content);
    assert.equal(original.sha256, createHash('sha256').update(source).digest('hex'));
    assert.equal(original.text, source.slice(0, 3000));
    return reply([], 'AMBER-REQUIRED remains required.');
  });
  const pending = env.side.ask({ messageId: 'interrupted', question: 'Read attachment constraints.', attachments: [], modelId: 'test' }, async () => source.slice('Read attachment constraints.'.length), () => '');
  if (interruption === 'cancel') { await active; await env.side.cancel(undefined, env.store.sideSession('').id); }
  await assert.rejects(pending, /provider interrupted|cancelled/);
  const session = env.store.sideSession('');
  assert.ok(session.offset > 0);
  const checkpoint = env.store.sideInputNotes(session.id);
  assert.equal(checkpoint.length, 1);
  const reopened = new ProductStore(path.dirname(env.store.path()));
  try { assert.deepEqual(reopened.sideInputNotes(session.id), checkpoint); assert.equal(reopened.sideSource(session.id, 'interrupted', true), source); }
  finally { reopened.close(); }
  await env.side.close();
  fail = false;
  const restarted = new ProductSideChat(env.rt, { indexWorkTask: () => undefined, summary: () => ({}) } as unknown as ProductSessions);
  t.after(() => restarted.close());
  const answer = await restarted.ask({ messageId: 'recover', question: 'Continue the interrupted review.', attachments: [], modelId: 'test' }, async () => '', () => '');
  assert.equal(answer.status, 'completed');
  assert.deepEqual(env.store.sideInputNotes(session.id), []);
  const db = new DatabaseSync(env.store.path(), { readOnly: true });
  try { assert.equal((db.prepare('SELECT consumed FROM side_request_inputs WHERE request_id=?').get('request-2') as { consumed: number }).consumed, 0); }
  finally { db.close(); }
});

test('side completion and clearing input notes commit together or recover together', async t => {
  const env = await setup(t, body => {
    const text = JSON.stringify(body.messages);
    if (!body.tools?.length) return reply([], text.includes('AMBER-REQUIRED') ? 'AMBER-REQUIRED must be checked.' : 'No additional constraints.');
    assert.match(text, /AMBER-REQUIRED/);
    return reply([], 'AMBER-REQUIRED remains required.');
  });
  const save = env.store.saveSideTurn.bind(env.store);
  let interrupt = true, visibleAtInterruption: string | undefined;
  env.store.saveSideTurn = (sessionId, record, inputText) => {
    save(sessionId, record, inputText);
    if (record.status !== 'completed' || !interrupt) return;
    const observer = new DatabaseSync(env.store.path(), { readOnly: true });
    try {
      const row = observer.prepare('SELECT record FROM side_turns WHERE id=?').get(record.id) as { record: string };
      visibleAtInterruption = JSON.parse(row.record).status;
    } finally { observer.close(); }
    throw new Error('injected interruption while completing the side turn');
  };
  await assert.rejects(env.side.ask({ messageId: 'atomic-completion', question: 'Read attachment constraints.', attachments: [], modelId: 'test' },
    async () => ' AMBER-REQUIRED ' + 'filler '.repeat(9000), () => ''), /injected interruption/);
  assert.notEqual(visibleAtInterruption, 'completed', 'an independent reader must not see completion before its notes are cleared');
  const session = env.store.sideSession('');
  const notes = env.store.sideInputNotes(session.id);
  assert.ok(notes.length > 0, 'failed completion must retain its prior reading notes');
  const reopened = new ProductStore(path.dirname(env.store.path()));
  try {
    assert.equal(reopened.sideTurn('atomic-completion')!.record.status, 'failed');
    assert.deepEqual(reopened.sideInputNotes(session.id), notes);
  } finally { reopened.close(); }
  await env.side.close();
  interrupt = false;
  const restarted = new ProductSideChat(env.rt, { indexWorkTask: () => undefined, summary: () => ({}) } as unknown as ProductSessions);
  t.after(() => restarted.close());
  const recovered = await restarted.ask({ messageId: 'atomic-recovery', question: 'Continue the interrupted review.', attachments: [], modelId: 'test' }, async () => '', () => '');
  assert.equal(recovered.status, 'completed');
  const completed = new ProductStore(path.dirname(env.store.path()));
  try {
    assert.equal(completed.sideTurn('atomic-recovery')!.record.status, 'completed');
    assert.deepEqual(completed.sideInputNotes(session.id), []);
  } finally { completed.close(); }
});

test('invalid fragment notes cannot advance the durable consumption checkpoint', async t => {
  const env = await setup(t, () => reply([], 'x'.repeat(513)));
  await assert.rejects(env.side.ask({ messageId: 'invalid-notes', question: 'Read the attachment.', attachments: [], modelId: 'test' }, async () => 'filler '.repeat(9000), () => ''), /within 512 UTF-8 bytes/);
  const session = env.store.sideSession('');
  assert.equal(session.consumed, 0); assert.equal(session.offset, 0);
  assert.deepEqual(env.store.sideInputNotes(session.id), []);
  assert.throws(() => env.store.consumeSideInput(session.id, { cursor: 99, offset: 0 }, 'request-1', []), /does not match/);
  assert.equal(env.store.sideSession('').consumed, 0);
});

test('legacy unfinished input checkpoints replay sources when notes are first introduced', async t => {
  const env = await setup(t, () => reply());
  const session = env.store.sideSession('');
  env.store.saveSideTurn(session.id, { id: 'legacy', question: 'original constraint', answer: 'interrupted', createdAt: new Date().toISOString(), status: 'failed' }, 'original constraint');
  env.store.recordSideInput('legacy-request', session.id, { cursor: 0, offset: 0 }, { cursor: 0, offset: 8 }, []);
  env.store.consumeSideInput(session.id, { cursor: 0, offset: 8 }, 'legacy-request');
  const completed = env.store.sideSession('completed-parent');
  env.store.saveSideTurn(completed.id, { id: 'old-failure', question: 'old', answer: '', createdAt: new Date().toISOString(), status: 'failed' }, 'old');
  env.store.saveSideTurn(completed.id, { id: 'later-completion', question: 'continued', answer: 'done', createdAt: new Date().toISOString(), status: 'completed' }, 'continued');
  const completeSeq = env.store.sideTurn('later-completion')!.seq;
  env.store.recordSideInput('completed-request', completed.id, { cursor: 0, offset: 0 }, { cursor: completeSeq, offset: 0 }, []);
  env.store.consumeSideInput(completed.id, { cursor: completeSeq, offset: 0 }, 'completed-request');
  const db = new DatabaseSync(env.store.path());
  try { db.exec('ALTER TABLE side_request_inputs DROP COLUMN notes'); } finally { db.close(); }
  const reopened = new ProductStore(path.dirname(env.store.path()));
  try {
    assert.equal(reopened.sideSession('').offset, 0);
    assert.equal(reopened.sideSource(session.id, 'legacy', true), 'original constraint');
    assert.deepEqual(reopened.sideInputNotes(session.id), []);
    assert.equal(reopened.sideSession('completed-parent').consumed, completeSeq);
  } finally { reopened.close(); }
});

test('Kernel side provenance cannot grant permissions or additional budget', async t => {
  const env = await setup(t, () => reply()); const taskId = env.create();
  const session = env.side.history(taskId); env.kernel.authorizeSideTurn(taskId, session.sideSessionId, 'user');
  for (const type of ['set_permission', 'approve_plan', 'renew_budget']) assert.throws(() => env.kernel.command({ commandId: type, type, taskId,
    origin: 'side', expectedRevision: env.kernel.getTask(taskId)!.revision, source: { surface: 'side', sessionId: session.sideSessionId, userMessageId: 'user' }, parameters: { mode: 'full-access' } }), /outside.*scope/);
  assert.throws(() => env.kernel.command({ commandId: 'budget-in-goal', type: 'revise_goal', taskId, origin: 'side', expectedRevision: env.kernel.getTask(taskId)!.revision,
    source: { surface: 'side', sessionId: session.sideSessionId, userMessageId: 'user' }, parameters: { goal: { maxModelCalls: 9999 } } }), /cannot authorize more budget/);
});
