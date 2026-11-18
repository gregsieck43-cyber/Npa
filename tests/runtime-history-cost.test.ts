import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startBackend } from '../src/app/backend.js';
import type { Kernel } from '../src/kernel/index.js';

async function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(path.resolve('.tmp', 'history-cost-'));
  const backend = await startBackend({ dataDir: path.join(root, 'data'), projectRoot: process.cwd() });
  await backend.services.runner.stop();
  t.after(async () => { await backend.close(); assert.equal(path.dirname(root), path.resolve('.tmp')); rmSync(root, { recursive: true, force: true }); });
  const kernel = backend.services.kernel;
  const task = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace: path.join(root, 'workspace'), objective: 'Current project', maxModelCalls: 100 } }).taskId!;
  return { root, backend, kernel, task };
}
function traceRows(kernel: Kernel) {
  const traced = kernel as unknown as { rows(sql: string, ...params: (number | string)[]): Record<string, unknown>[] };
  const original = traced.rows.bind(kernel), reads: { sql: string; params: (number | string)[]; count: number; fields: string[] }[] = [];
  traced.rows = (sql, ...params) => { const values = original(sql, ...params); reads.push({ sql, params, count: values.length,
    fields: [...new Set(values.flatMap(value => Object.keys(value)))] }); return values; };
  return reads;
}

async function drainFixtureProjection(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const harness = f.backend.services.harness!, latest = f.kernel.latestEventSequence();
  const deadline = Date.now() + 10_000;
  // sync() only schedules catch-up. Measure the instructions route after fixture broadcasts
  // reach their durable cursor, without hiding any query made by the HTTP request itself.
  harness.workTrace.sync();
  do {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(harness.store.getSetting('workTraceError', null), null, 'fixture projection must finish without errors');
    if (harness.store.getSetting('kernelCursor', 0) >= latest) return;
    assert.ok(Date.now() < deadline, 'fixture projection did not catch up before measurement');
  } while (true);
}

test('pause, resume, cancel and interruption read only the selected task tree amid large unrelated history', async t => {
  const f = await fixture(t), task = f.kernel.getTask(f.task)!;
  for (const name of ['one', 'two']) f.kernel.command({ commandId: randomUUID(), taskId: f.task, type: 'delegate', parameters: { title: name, objective: name, paths: [name] } });
  const child = f.kernel.delegations(f.task)[0]!.childTaskId;
  f.kernel.command({ commandId: randomUUID(), taskId: child, type: 'delegate', parameters: { title: 'leaf', objective: 'leaf', paths: ['leaf'] } });
  const leaf = f.kernel.delegations(child)[0]!.childTaskId;
  const ids = [f.task, ...f.kernel.delegations(f.task).map(d => d.childTaskId), leaf];
  const db = new DatabaseSync(f.kernel.dbPath);
  try {
    // Unrelated completed archive rows with large bodies; never execute these synthetic tasks.
    db.exec('BEGIN'); const insert = db.prepare('INSERT INTO tasks VALUES(?,NULL,?,?,?)');
    for (let i = 0; i < 2000; i++) insert.run('archived-' + i, 'completed', 1, JSON.stringify({ ...task, id: 'archived-' + i, status: 'completed', result: 'x'.repeat(4096) }));
    db.exec('COMMIT');
    const reads = traceRows(f.kernel);
    const interrupt = new AbortController();
    const active = (f.backend.services.runner as unknown as { active: Map<string, AbortController> }).active;
    active.set(leaf, interrupt); f.backend.services.runner.interrupt(f.task); active.delete(leaf);
    assert.equal(interrupt.signal.aborted, true);
    for (const [type, status] of [['pause', 'paused'], ['resume', 'queued'], ['cancel', 'cancelled']] as const) {
      f.kernel.command({ commandId: randomUUID(), taskId: f.task, type, parameters: {} });
      for (const id of ids) assert.equal(f.kernel.getTask(id)!.status, status);
      assert.equal(f.kernel.getTask('archived-1999')!.status, 'completed');
    }
    const taskReads = reads.filter(read => /FROM tasks/i.test(read.sql));
    assert.ok(taskReads.length > 0);
    assert.ok(taskReads.every(read => read.count <= 2), 'tree actions must not materialize 2,000 unrelated task bodies');
    assert.ok(taskReads.every(read => db.prepare('EXPLAIN QUERY PLAN ' + read.sql).all(...read.params).some(row => String(row.detail).includes('tasks_parent'))));
  } finally { db.close(); }
});

test('instruction HTTP reads only three main user turns and the latest scope event after a long tool conversation', async t => {
  const f = await fixture(t), workspace = f.kernel.getTask(f.task)!.workspace;
  const nested = path.join(workspace, 'nested'); mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(nested, 'AGENTS.md'), 'CURRENT NESTED INSTRUCTION');
  f.kernel.appendEvent(f.task, 'instruction.scope.loaded', { path: path.join(nested, 'current.ts') });
  const db = new DatabaseSync(f.kernel.dbPath);
  try {
    db.exec('BEGIN'); const insert = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)');
    for (let i = 0; i < 2003; i++) {
      const id = 'history-' + i, role = i < 3 ? 'user' : 'assistant', createdAt = new Date(100000 - i).toISOString();
      insert.run(id, f.task, 'main', JSON.stringify({ id, taskId: f.task, role, sessionId: 'main', content: i < 3 ? 'Current user ' + i : 'x'.repeat(4096), createdAt }), createdAt);
    }
    db.exec('COMMIT');
    await drainFixtureProjection(f);
    let fullMessages = 0, fullEvents = 0;
    const messages = f.kernel.getMessages.bind(f.kernel), events = f.kernel.events.bind(f.kernel);
    const tail = f.kernel.tailMessages.bind(f.kernel), tailCalls: Parameters<Kernel['tailMessages']>[] = [];
    f.kernel.getMessages = (...args) => { fullMessages++; return messages(...args); };
    f.kernel.events = (...args) => { fullEvents++; return events(...args); };
    f.kernel.tailMessages = (...args) => { tailCalls.push(args); return tail(...args); };
    const reads = traceRows(f.kernel);
    const response = await fetch(`http://127.0.0.1:${f.backend.port}/v1/instructions?taskId=${f.task}`, { headers: { Authorization: 'Bearer ' + f.backend.token } });
    assert.equal(response.status, 200); assert.match((await response.json() as { text: string }).text, /CURRENT NESTED INSTRUCTION/);
    assert.equal(fullMessages, 0, 'instruction selection must not load the raw conversation');
    assert.equal(fullEvents, 0, 'scope selection must not load the event archive');
    assert.deepEqual(tailCalls, [[f.task, 3, 'main', 'user']], 'select the bounded user tail exactly once');
    const messageReads = reads.filter(read => /FROM messages/i.test(read.sql));
    // Byte-bounded reads first fetch small row headers, then only those selected bodies.
    const headers = messageReads.filter(read => read.fields.includes('bytes') && !read.fields.includes('body'));
    const bodies = messageReads.filter(read => read.fields.includes('body'));
    assert.equal(headers.length, 1); assert.equal(bodies.length, 1);
    assert.equal(messageReads.length, headers.length + bodies.length, 'no additional message query may hide behind the two-phase read');
    assert.equal(headers[0]!.count, 3, 'only three small message headers enter JS');
    assert.equal(bodies[0]!.count, 3, 'only three selected message bodies enter JS');
    assert.match(headers[0]!.sql, /\bLIMIT\s+\?/i);
    assert.equal(headers[0]!.params.at(-1), 3);
    assert.equal(bodies[0]!.params.length, 3, 'body lookup must be restricted to the selected rowids');
    assert.ok(db.prepare('EXPLAIN QUERY PLAN ' + headers[0]!.sql).all(...headers[0]!.params).some(row => String(row.detail).includes('messages_session_role')));
    assert.ok(db.prepare('EXPLAIN QUERY PLAN ' + bodies[0]!.sql).all(...bodies[0]!.params).some(row => String(row.detail).includes('SEARCH messages USING INTEGER PRIMARY KEY')));
  } finally { db.close(); }
});
