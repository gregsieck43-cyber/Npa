import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startBackend } from '../src/app/backend.js';
import { Runner } from '../src/app/runner.js';
import type { Configuration } from '../src/app/configuration.js';
import type { CandidateManager } from '../src/adaptation/index.js';
import { Kernel, KernelError } from '../src/kernel/index.js';
import type { Task } from '../src/contracts.js';
import type { TaskDetail } from '../src/frontend/api/types.js';
import type { Delegation, Verification } from '../src/kernel/types.js';

const ROOT = path.resolve('.tmp/product-subagent-projection-tests');
const COUNT = 150;
const PAYLOAD = 'ARCHIVED_CHILD_BODY_' + 'x'.repeat(32_000);
type Backend = Awaited<ReturnType<typeof startBackend>>;
type Query = { sql: string; args: (string | number | null)[]; rows: number; bytes: number; archivedBody: boolean; fields: string[] };

function directory(t: TestContext): string {
  mkdirSync(ROOT, { recursive: true });
  const owned = mkdtempSync(path.join(ROOT, 'projection-'));
  t.after(() => { assert.equal(path.dirname(owned), ROOT); rmSync(owned, { recursive: true, force: true }); });
  return owned;
}

function create(kernel: Kernel): Task {
  const ack = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    title: 'Projection fixture', initialStatus: 'paused', permissionMode: 'read-only',
  } });
  return kernel.getTask(ack.taskId!)!;
}

// Synthetic archived children avoid model execution. Real schema, Kernel queries, HTTP and tick run below.
function children(kernel: Kernel, parent: Task, count = COUNT): Task[] {
  const db = new DatabaseSync(kernel.dbPath), result: Task[] = [];
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const taskInsert = db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)');
    const delegationInsert = db.prepare('INSERT INTO delegations VALUES(?,?,?,?)');
    const runInsert = db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)');
    const verificationInsert = db.prepare('INSERT INTO verifications VALUES(?,?,?,?)');
    for (let i = 0; i < count; i++) {
      const task: Task = { ...parent, id: randomUUID(), parentId: parent.id, title: `Child ${i}`, result: PAYLOAD,
        status: (['completed', 'failed', 'cancelled'] as const)[i % 3], createdAt: new Date(Date.UTC(2026, 0, 1) - i * 1000).toISOString() };
      const delegation: Delegation = { id: `delegation-${task.id}`, taskId: parent.id, childTaskId: task.id,
        owner: task.owner, state: 'assigned', parentGoalVersion: parent.goalVersion, createdAt: task.createdAt };
      const runId = randomUUID(), verification: Verification = { id: randomUUID(), taskId: task.id, runId,
        snapshot: { revision: task.revision, goalVersion: task.goalVersion, generation: task.generation, policyEpoch: task.policyEpoch },
        record: { passed: false, evidence: PAYLOAD }, createdAt: task.createdAt };
      taskInsert.run(task.id, parent.id, task.status, task.revision, JSON.stringify(task));
      delegationInsert.run(delegation.id, parent.id, task.id, JSON.stringify(delegation));
      runInsert.run(runId, task.id, task.generation, task.policyEpoch, 'completed', JSON.stringify({ id: runId, taskId: task.id, status: 'completed' }));
      verificationInsert.run(verification.id, task.id, runId, JSON.stringify(verification));
      result.push(task);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  return result;
}

function setStatus(kernel: Kernel, taskId: string, status: Task['status']) {
  const db = new DatabaseSync(kernel.dbPath);
  try { db.prepare("UPDATE tasks SET status=?,body=json_set(body,'$.status',?) WHERE id=?").run(status, status, taskId); }
  finally { db.close(); }
}

function breakLastReference(kernel: Kernel, childId: string) {
  const db = new DatabaseSync(kernel.dbPath);
  try {
    db.exec('PRAGMA foreign_keys=OFF'); // Simulate a damaged legacy reference; normal writes forbid it.
    db.prepare("UPDATE delegations SET child_task_id='missing-child',body=json_set(body,'$.childTaskId','missing-child') WHERE child_task_id=?").run(childId);
  }
  finally { db.close(); }
}

function observe(kernel: Kernel) {
  const target = kernel as unknown as {
    rows(sql: string, ...args: (string | number | null)[]): Record<string, unknown>[];
    row(sql: string, ...args: (string | number | null)[]): Record<string, unknown> | undefined;
  };
  const rows = target.rows, row = target.row, queries: Query[] = [];
  const record = (sql: string, args: Query['args'], result: Record<string, unknown>[]) => {
    const serialized = JSON.stringify(result);
    queries.push({ sql, args, rows: result.length, bytes: Buffer.byteLength(serialized),
      archivedBody: serialized.includes('ARCHIVED_CHILD_BODY_'), fields: [...new Set(result.flatMap(value => Object.keys(value)))] });
  };
  target.rows = function (sql, ...args) { const result = rows.call(this, sql, ...args); record(sql, args, result); return result; };
  target.row = function (sql, ...args) { const result = row.call(this, sql, ...args); record(sql, args, result ? [result] : []); return result; };
  return { queries, restore: () => { target.rows = rows; target.row = row; } };
}

function assertNoArchive(t: TestContext, queries: Query[]) {
  t.diagnostic(JSON.stringify({ queries: queries.length, rows: queries.reduce((n, q) => n + q.rows, 0),
    bytes: queries.reduce((n, q) => n + q.bytes, 0), archiveQueries: queries.filter(q => q.archivedBody).length }));
  assert.equal(queries.filter(q => q.archivedBody).length, 0, 'refresh/poll must not materialize archived child result or verification bodies');
  assert.ok(queries.reduce((n, q) => n + q.bytes, 0) < 50_000, 'JS data must be bounded independently of child result size and sibling count');
}

async function response(backend: Backend, taskId: string) {
  return fetch(`http://127.0.0.1:${backend.port}/v1/product/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${backend.token}` }, signal: AbortSignal.timeout(10_000),
  });
}

async function drainFixtureProjection(backend: Backend): Promise<void> {
  const harness = backend.services.harness!, latest = backend.services.kernel.latestEventSequence();
  const deadline = Date.now() + 10_000;
  // sync() schedules bounded catch-up; it no longer imports the whole fixture synchronously.
  // Await its durable cursor so fixture broadcasts are not counted as this one HTTP read.
  harness.workTrace.sync();
  do {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(harness.store.getSetting('workTraceError', null), null, 'fixture projection must finish without errors');
    if (harness.store.getSetting('kernelCursor', 0) >= latest) return;
    assert.ok(Date.now() < deadline, 'fixture projection did not catch up before measurement');
  } while (true);
}

test('real Product HTTP reads only the first 50 child display rows, no child results or verification, including restart', async t => {
  const owned = directory(t), dataDir = path.join(owned, 'data');
  let backend: Backend | undefined;
  try {
    backend = await startBackend({ dataDir, projectRoot: process.cwd(), mockOptions: {} });
    await backend.services.runner.stop();
    const parent = create(backend.services.kernel), empty = create(backend.services.kernel);
    const selected = children(backend.services.kernel, parent);
    children(backend.services.kernel, create(backend.services.kernel), 7);
    for (let attempt = 0; attempt < 2; attempt++) {
      await drainFixtureProjection(backend);
      const observation = observe(backend.services.kernel);
      try {
        const http = await response(backend, parent.id); assert.equal(http.status, 200);
        const view = await http.json() as TaskDetail;
        assert.deepEqual(view.subagents, selected.slice(0, 50).map(child => ({ id: `delegation-${child.id}`, role: 'worker',
          title: child.title, status: child.status, model: backend!.services.product!.store.getSession(child.id)?.modelId ?? 'unknown', sessionId: child.id })));
        assertNoArchive(t, observation.queries);
        assert.equal(observation.queries.filter(q => /FROM verifications/i.test(q.sql)).length, 1, 'only the parent verdict is used');
        const displayQuery = observation.queries.find(q => /FROM delegations/i.test(q.sql) && q.rows === 50);
        assert.ok(displayQuery, 'actual SQLite projection must return 50 rows');
        assert.ok(!displayQuery.fields.includes('body'));
        assert.match(displayQuery.sql, /LIMIT 50/i);
        const db = new DatabaseSync(backend.services.kernel.dbPath, { readOnly: true });
        try {
          const plan = db.prepare('EXPLAIN QUERY PLAN ' + displayQuery.sql).all(...displayQuery.args).map(row => String(row.detail));
          assert.ok(plan.some(line => line.includes('delegations_parent')), JSON.stringify(plan));
          assert.ok(plan.every(line => !/TEMP B-TREE/.test(line)), JSON.stringify(plan));
        } finally { db.close(); }
        const blank = await response(backend, empty.id);
        assert.deepEqual((await blank.json() as TaskDetail).subagents, []);
        const missing = await response(backend, 'missing-parent');
        assert.equal(missing.status, 200); assert.equal(await missing.json(), null);
      } finally { observation.restore(); }
      // Explicit archive access still returns all children and original independent-verification records.
      const archive = backend.services.kernel.queryDelegations(parent.id);
      assert.equal(archive.length, COUNT); assert.equal(archive.at(-1)!.task.result, PAYLOAD);
      assert.equal(archive.at(-1)!.verification!.record.passed, false);
      if (attempt === 0) {
        await backend.close();
        backend = await startBackend({ dataDir, projectRoot: process.cwd(), mockOptions: {} });
        await backend.services.runner.stop();
      }
    }
    assert.equal(backend.mock.requests(), 0);
  } finally { await backend?.close(); }
});

test('Product projection preserves missing-child failure even beyond the displayed first 50', async t => {
  const backend = await startBackend({ dataDir: path.join(directory(t), 'data'), projectRoot: process.cwd(), mockOptions: {} });
  try {
    await backend.services.runner.stop();
    const parent = create(backend.services.kernel), selected = children(backend.services.kernel, parent, 51);
    breakLastReference(backend.services.kernel, selected.at(-1)!.id);
    const http = await response(backend, parent.id); assert.equal(http.status, 400);
    assert.match(await http.text(), /NOT_FOUND.*missing-child/);
    assert.equal(backend.mock.requests(), 0);
  } finally { await backend.close(); }
});

function runnerFixture(kernel: Kernel, owned: string) {
  const runner = new Runner(kernel, {} as Configuration, {} as CandidateManager, owned), dispatched: string[] = [];
  const internal = runner as unknown as { tick(): void; wake(): void; execute(taskId: string, signal: AbortSignal): Promise<void> };
  // Observe the real scheduling decision without invoking a model or changing final verification rules.
  internal.execute = async taskId => { dispatched.push(taskId); };
  internal.wake = () => {}; // Manual ticks without an unrelated execute-finally timer.
  return { runner, dispatched, tick: () => internal.tick(), settle: () => new Promise<void>(resolve => setImmediate(resolve)) };
}

test('Runner waiting_children polling uses scalar terminal status across many large archived children', async t => {
  const owned = directory(t), kernel = new Kernel(owned), parent = create(kernel), selected = children(kernel, parent);
  const fixture = runnerFixture(kernel, owned);
  try {
    setStatus(kernel, parent.id, 'waiting_children'); setStatus(kernel, selected.at(-1)!.id, 'paused');
    const observation = observe(kernel);
    try {
      fixture.tick();
      assert.deepEqual(fixture.dispatched, []); assert.equal(kernel.getTask(parent.id)!.status, 'waiting_children');
      assertNoArchive(t, observation.queries);
      observation.queries.length = 0;
      setStatus(kernel, selected.at(-1)!.id, 'completed');
      fixture.tick(); await fixture.settle();
      assert.deepEqual(fixture.dispatched, [parent.id]); assert.equal(kernel.getTask(parent.id)!.status, 'queued');
      assertNoArchive(t, observation.queries);
      assert.equal(observation.queries.filter(q => /FROM verifications/i.test(q.sql)).length, 0, 'polling terminal status is not independent acceptance');
      assert.ok(observation.queries.filter(q => /FROM delegations/i.test(q.sql)).every(q => q.rows <= 1 && !q.fields.includes('body')));
      assert.equal(kernel.latestVerification(selected[0]!.id)!.record.passed, false, 'terminal polling does not rewrite or accept a failed verdict');
    } finally { observation.restore(); }
  } finally { await fixture.runner.stop(); kernel.close(); }
});

test('Runner terminal polling preserves empty-child readiness and missing-child error semantics', async t => {
  const owned = directory(t), kernel = new Kernel(owned), empty = create(kernel), broken = create(kernel);
  const selected = children(kernel, broken, 51), fixture = runnerFixture(kernel, owned);
  try {
    setStatus(kernel, empty.id, 'waiting_children');
    fixture.tick(); await fixture.settle();
    assert.deepEqual(fixture.dispatched, [empty.id]);
    setStatus(kernel, empty.id, 'paused'); setStatus(kernel, broken.id, 'waiting_children');
    breakLastReference(kernel, selected.at(-1)!.id);
    assert.throws(() => fixture.tick(), error => error instanceof KernelError && error.code === 'NOT_FOUND' && /missing-child/.test(error.message));
    assert.equal(kernel.getTask(broken.id)!.status, 'waiting_children');
  } finally { await fixture.runner.stop(); kernel.close(); }
});
