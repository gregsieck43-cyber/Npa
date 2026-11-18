import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startBackend } from '../src/app/backend.js';
import { Kernel, KernelError } from '../src/kernel/index.js';
import type { Task } from '../src/contracts.js';
import type { TaskDetail } from '../src/frontend/api/types.js';
import type { Checkpoint, Verification } from '../src/kernel/types.js';

// Deep history is synthetic SQLite data, while all projections and completion checks are real.
// Count actual rows materialized into JS and inspect the SQL plan; a small DTO alone is not proof.
const ROOT = path.resolve('.tmp/long-runtime-completion-20261104/query-tests');
const DEPTH = 1200;
type Backend = Awaited<ReturnType<typeof startBackend>>;
type Query = { sql: string; args: (string | number | null)[]; rows: number };

function directory(t: TestContext): string {
  mkdirSync(ROOT, { recursive: true });
  const owned = mkdtempSync(path.join(ROOT, 'history-'));
  t.after(() => { assert.equal(path.dirname(owned), ROOT); rmSync(owned, { recursive: true, force: true }); });
  return owned;
}

function create(kernel: Kernel, paused = true): Task {
  const ack = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    title: 'Bounded history fixture', ...(paused ? { initialStatus: 'paused' } : {}), permissionMode: 'read-only',
  } });
  return kernel.getTask(ack.taskId!)!;
}

function seed(kernel: Kernel, task: Task, count: number): void {
  const db = new DatabaseSync(kernel.dbPath);
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const runId = randomUUID();
    db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)').run(runId, task.id, task.generation, task.policyEpoch, 'completed', JSON.stringify({
      id: runId, taskId: task.id, generation: task.generation, policyEpoch: task.policyEpoch, status: 'completed', startedAt: task.createdAt,
    }));
    const checkpoint = db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?)');
    const verification = db.prepare('INSERT INTO verifications VALUES(?,?,?,?)');
    for (let i = 0; i < count; i++) {
      // Deliberately descending timestamps: the legacy contract is insertion order, not clock order.
      const createdAt = new Date(Date.UTC(2026, 0, 1) - i * 1000).toISOString();
      const cp: Checkpoint = { id: `${task.id}-cp-${i}`, taskId: task.id, runId, context: { label: `Checkpoint ${i}`, archive: 'x'.repeat(2048) },
        digest: `digest-${i}`, eventSeq: i, messageCount: i, createdAt };
      const v: Verification = { id: `${task.id}-v-${i}`, taskId: task.id, runId, snapshot: {
        revision: task.revision, goalVersion: task.goalVersion, generation: task.generation, policyEpoch: task.policyEpoch,
      }, record: { passed: i !== count - 1, reviewer: 'synthetic-independent', checks: [{ label: `Verification ${i}`, ok: i !== count - 1 }], archive: 'x'.repeat(2048) }, createdAt };
      checkpoint.run(cp.id, task.id, runId, JSON.stringify(cp));
      verification.run(v.id, task.id, runId, JSON.stringify(v));
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}

function observe(kernel: Kernel): { queries: Query[]; restore: () => void } {
  const target = kernel as unknown as {
    rows(sql: string, ...args: (string | number | null)[]): Record<string, unknown>[];
    row(sql: string, ...args: (string | number | null)[]): Record<string, unknown> | undefined;
  };
  const rows = target.rows, row = target.row, queries: Query[] = [];
  const watched = (sql: string) => /\bFROM\s+(?:checkpoints|verifications)\b/i.test(sql);
  target.rows = function (sql, ...args) {
    const result = rows.call(this, sql, ...args);
    if (watched(sql)) queries.push({ sql, args, rows: result.length });
    return result;
  };
  target.row = function (sql, ...args) {
    const result = row.call(this, sql, ...args);
    if (watched(sql)) queries.push({ sql, args, rows: result ? 1 : 0 });
    return result;
  };
  return { queries, restore: () => { target.rows = rows; target.row = row; } };
}

function assertBounded(queries: Query[], checkpointRows: number, verificationRows: number): void {
  assert.equal(queries.filter(q => /FROM checkpoints/i.test(q.sql)).reduce((n, q) => n + q.rows, 0), checkpointRows,
    'checkpoint SQL must materialize only the displayed tail, not the entire task history');
  assert.equal(queries.filter(q => /FROM verifications/i.test(q.sql)).reduce((n, q) => n + q.rows, 0), verificationRows,
    'verification SQL must materialize one latest record per requested task');
  for (const query of queries) assert.match(query.sql, /\bLIMIT\b/i, 'the bound must be applied by SQLite');
}

async function detail(backend: Backend, id: string): Promise<TaskDetail> {
  const response = await fetch(`http://127.0.0.1:${backend.port}/v1/product/tasks/${id}`, {
    headers: { Authorization: `Bearer ${backend.token}` }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  return await response.json() as TaskDetail;
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

test('real Product HTTP task detail reads only 20 checkpoints and the latest verification before and after restart', async t => {
  const owned = directory(t), dataDir = path.join(owned, 'data');
  let backend: Backend | undefined;
  try {
    backend = await startBackend({ dataDir, projectRoot: process.cwd(), mockOptions: {} });
    await backend.services.runner.stop();
    const kernel = backend.services.kernel, selected = create(kernel), other = create(kernel), empty = create(kernel);
    seed(kernel, selected, DEPTH); seed(kernel, other, DEPTH);
    for (let attempt = 0; attempt < 2; attempt++) {
      // Drain fixture-creation events before measuring this one HTTP projection.
      await drainFixtureProjection(backend);
      const current: Kernel = backend.services.kernel, observation = observe(current);
      try {
        const view = await detail(backend, selected.id);
        assert.deepEqual(view.checkpoints.map(cp => cp.id), Array.from({ length: 20 }, (_, i) => `${selected.id}-cp-${DEPTH - 20 + i}`));
        assert.equal(view.verification.status, 'fail');
        assert.deepEqual(view.verification.items, [{ label: `Verification ${DEPTH - 1}`, status: 'fail' }]);
        assertBounded(observation.queries, 20, 1);
        observation.queries.length = 0;
        const blank = await detail(backend, empty.id);
        assert.deepEqual(blank.checkpoints, []); assert.deepEqual(blank.verification, { status: 'pending', items: [] });
        assertBounded(observation.queries, 0, 0);
        // Full historical readers remain available and immutable; the projection does not prune data.
        observation.restore();
        assert.equal(current.getCheckpoints(selected.id).length, DEPTH);
        assert.equal(current.getVerifications(other.id).length, DEPTH);
      } finally { observation.restore(); }
      if (attempt === 0) {
        await backend.close();
        backend = await startBackend({ dataDir, projectRoot: process.cwd(), mockOptions: {} });
        await backend.services.runner.stop();
      }
    }
    assert.equal(backend.mock.requests(), 0);
  } finally { await backend?.close(); }
});

test('delegation queries read one latest verification per child despite deep sibling histories', t => {
  const kernel = new Kernel(directory(t));
  try {
    const parent = create(kernel), children: Task[] = [];
    for (let i = 0; i < 2; i++) {
      kernel.command({ commandId: randomUUID(), type: 'delegate', taskId: parent.id, parameters: { objective: `Child ${i}` } });
      const child = kernel.getTask(kernel.delegations(parent.id).at(-1)!.childTaskId)!;
      children.push(child); seed(kernel, child, DEPTH);
    }
    const observation = observe(kernel);
    try {
      const results = kernel.queryDelegations(parent.id);
      assert.deepEqual(results.map(result => result.verification?.id), children.map(child => `${child.id}-v-${DEPTH - 1}`));
      assert.ok(results.every(result => result.verification?.record.passed === false));
      assertBounded(observation.queries, 0, 2);
    } finally { observation.restore(); }
  } finally { kernel.close(); }
});

test('completion still rejects the latest failed verdict and accepts a fresh independent verification with bounded reads', t => {
  const kernel = new Kernel(directory(t));
  try {
    const task = create(kernel, false); seed(kernel, task, DEPTH);
    const run = kernel.createRun(task.id); kernel.transition(task.id, 'running');
    const observation = observe(kernel);
    try {
      assert.throws(() => kernel.transition(task.id, 'completed'), error => error instanceof KernelError && error.code === 'UNVERIFIED_RESULT');
      assertBounded(observation.queries, 0, 1);
      observation.queries.length = 0;
      kernel.verify(task.id, run.id, { passed: true, reviewer: 'independent-test', evidence: 'Current run checked' });
      kernel.transition(task.id, 'completed', { result: 'Verified result' });
      assert.equal(kernel.getTask(task.id)!.status, 'completed');
      assertBounded(observation.queries, 0, 1);
    } finally { observation.restore(); }
  } finally { kernel.close(); }
});

test('existing SQLite databases gain task-filtered history indexes on reopen without a temporary sort', t => {
  const owned = directory(t);
  let kernel = new Kernel(owned);
  const task = create(kernel); seed(kernel, task, 30); seed(kernel, create(kernel), DEPTH);
  kernel.close();
  const legacy = new DatabaseSync(path.join(owned, 'kernel.sqlite'));
  try { legacy.exec('DROP INDEX IF EXISTS checkpoints_task; DROP INDEX IF EXISTS verifications_task'); } finally { legacy.close(); }
  kernel = new Kernel(owned);
  try {
    const db = new DatabaseSync(kernel.dbPath, { readOnly: true });
    try {
      for (const [table, limit] of [['checkpoints', 20], ['verifications', 1]] as const) {
        const sql = `SELECT body FROM ${table} WHERE task_id=? ORDER BY rowid DESC LIMIT ?`;
        const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(task.id, limit).map(row => String(row.detail));
        assert.ok(plan.some(line => line.includes(`SEARCH ${table} USING INDEX ${table}_task (task_id=?)`)), JSON.stringify(plan));
        assert.ok(plan.every(line => !/SCAN |TEMP B-TREE/.test(line)), JSON.stringify(plan));
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id=?`).get(task.id)?.n, 30);
      }
    } finally { db.close(); }
  } finally { kernel.close(); }
});

test('checkpoint tail limits reject unbounded inputs before querying and preserve chronological insertion order', t => {
  const kernel = new Kernel(directory(t));
  try {
    const task = create(kernel); seed(kernel, task, 30);
    const observation = observe(kernel);
    try {
      for (const limit of [0, -1, 1.5, NaN, Infinity, 1002]) {
        assert.throws(() => kernel.recentCheckpoints(task.id, limit), error => error instanceof KernelError && error.code === 'INVALID_PAGE_LIMIT');
      }
      assert.equal(observation.queries.length, 0);
      assert.deepEqual(kernel.recentCheckpoints(task.id, 2).map(cp => cp.id), [`${task.id}-cp-28`, `${task.id}-cp-29`]);
      assertBounded(observation.queries, 2, 0);
      observation.queries.length = 0;
      assert.deepEqual(kernel.recentCheckpoints('missing-task'), []);
      assert.equal(kernel.latestVerification('missing-task'), undefined);
      assertBounded(observation.queries, 0, 0);
    } finally { observation.restore(); }
  } finally { kernel.close(); }
});
