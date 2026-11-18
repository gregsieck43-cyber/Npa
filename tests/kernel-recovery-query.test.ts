import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Kernel, KernelError } from '../src/kernel/index.js';
import type { Intent } from '../src/contracts.js';

const ROOT = path.resolve('.tmp/long-runtime-completion-20261104/recovery-tests');
const HISTORY = 1500;

function fixture(t: TestContext) {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(ROOT, 'recover-'));
  let kernel = new Kernel(dir);
  t.after(() => { kernel.close(); assert.equal(path.dirname(dir), ROOT); rmSync(dir, { recursive: true, force: true }); });
  return { get kernel() { return kernel; }, reopen() { kernel.close(); kernel = new Kernel(dir); return kernel; } };
}

function running(kernel: Kernel) {
  const taskId = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    title: 'Recovery query fixture', permissionMode: 'ask', goal: { objective: 'Recover only actionable intent states', maxToolCalls: 1000 },
  } }).taskId!;
  const run = kernel.createRun(taskId); kernel.transition(taskId, 'running');
  return { taskId, runId: run.id };
}

function prepare(kernel: Kernel, taskId: string, runId: string): Intent {
  return kernel.prepareIntent(taskId, runId, { id: randomUUID(), name: 'write_file', arguments: { path: randomUUID() + '.txt', content: 'synthetic, never executed' } });
}

function seedSettled(kernel: Kernel, template: Intent) {
  const db = new DatabaseSync(kernel.dbPath);
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const insert = db.prepare('INSERT INTO intents(id,task_id,run_id,effect_key,state,body,capability,paths) VALUES(?,?,?,?,?,?,?,?)');
    for (let i = 0; i < HISTORY; i++) {
      const state = (['applied', 'failed', 'denied'] as const)[i % 3]!;
      const intent = { ...template, id: 'history-' + randomUUID(), effectKey: 'history-' + randomUUID(), state };
      insert.run(intent.id, template.taskId, template.runId, intent.effectKey, state, JSON.stringify(intent), 'workspace.write', '[]');
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}

function archiveDigest(kernel: Kernel): string {
  const db = new DatabaseSync(kernel.dbPath, { readOnly: true }), hash = createHash('sha256');
  try {
    for (const row of db.prepare("SELECT body FROM intents WHERE id LIKE 'history-%' ORDER BY rowid").iterate()) hash.update(String(row.body));
    return hash.digest('hex');
  } finally { db.close(); }
}

function observe(kernel: Kernel) {
  const target = kernel as unknown as { rows(sql: string, ...args: (string | number | null)[]): Record<string, unknown>[] };
  const original = target.rows;
  const stats = { materialized: 0, settled: 0, maxBatch: 0, queries: [] as { sql: string; args: (string | number | null)[] }[] };
  target.rows = function (sql, ...args) {
    const rows = original.call(this, sql, ...args);
    if (/\bFROM\s+intents\b/i.test(sql)) {
      stats.queries.push({ sql, args });
      // recoveryTasks also probes intents in EXISTS, but its returned bodies are tasks.
      // Keep that query's index check without counting a task as a materialized intent.
      if (sql.match(/\bFROM\s+(\w+)\b/i)?.[1]?.toLowerCase() === 'intents') {
        stats.materialized += rows.length; stats.maxBatch = Math.max(stats.maxBatch, rows.length);
        for (const row of rows) if (row.body && ['applied', 'failed', 'denied'].includes(JSON.parse(String(row.body)).state)) stats.settled++;
      }
    }
    return rows;
  };
  return { stats, restore() { target.rows = original; } };
}

function assertIndexed(kernel: Kernel, queries: { sql: string; args: (string | number | null)[] }[]) {
  const db = new DatabaseSync(kernel.dbPath, { readOnly: true });
  try {
    assert.ok(queries.length > 0);
    for (const query of queries) {
      assert.match(query.sql, /\bLIMIT\b/i);
      const plan = db.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.args).map(row => String(row.detail));
      assert.ok(plan.some(line => /SEARCH (?:intents|i) USING (?:COVERING )?INDEX intents_task_state\b/.test(line)), JSON.stringify(plan));
      assert.ok(plan.every(line => !/TEMP B-TREE|SCAN (?:intents|i)\b/.test(line)), JSON.stringify(plan));
    }
  } finally { db.close(); }
}

test('recovery of paused settled history materializes zero intent bodies and preserves archive bytes', t => {
  const f = fixture(t), active = running(f.kernel), template = prepare(f.kernel, active.taskId, active.runId);
  f.kernel.deny(template.id);
  f.kernel.command({ commandId: randomUUID(), type: 'pause', taskId: active.taskId });
  seedSettled(f.kernel, template);
  const kernel = f.reopen(), before = archiveDigest(kernel), task = kernel.getTask(active.taskId)!;
  const observation = observe(kernel);
  try {
    assert.deepEqual(kernel.recover(), { requeued: [], unknownIntents: [], reconciling: [], waitingChildren: [] });
    assert.deepEqual(kernel.getTask(active.taskId), task);
    assert.equal(archiveDigest(kernel), before);
    assert.equal(observation.stats.materialized, 0, 'settled history must not enter JavaScript during recovery');
    assertIndexed(kernel, observation.stats.queries);
  } finally { observation.restore(); }
});

for (const [label, sentCount, unsentCount] of [['few-pending', 2, 3], ['multi-page', 103, 207]] as const) {
  test(`recovery selects only actionable states and preserves fences, unknown outcomes and denial order (${label})`, t => {
    const f = fixture(t), active = running(f.kernel), template = prepare(f.kernel, active.taskId, active.runId);
    f.kernel.deny(template.id); seedSettled(f.kernel, template);
    const sent: string[] = [], unsent: string[] = [];
    for (let i = 0; i < sentCount; i++) {
      const intent = prepare(f.kernel, active.taskId, active.runId); f.kernel.approve(intent.id); f.kernel.dispatch(intent.id); sent.push(intent.id);
    }
    for (let i = 0; i < unsentCount; i++) {
      const intent = prepare(f.kernel, active.taskId, active.runId);
      if (i % 2 === 0) f.kernel.approve(intent.id);
      unsent.push(intent.id);
    }
    const kernel = f.reopen(), before = archiveDigest(kernel), generation = kernel.getTask(active.taskId)!.generation;
    const observation = observe(kernel);
    try {
      const summary = kernel.recover();
      assert.deepEqual(summary.unknownIntents, sent);
      assert.deepEqual(summary.reconciling, [active.taskId]);
      assert.equal(kernel.getTask(active.taskId)!.generation, generation + 1);
      assert.throws(() => kernel.assertFence(active.taskId, active.runId), error => error instanceof KernelError && error.code === 'STALE_GENERATION');
      for (const id of sent) {
        assert.equal(kernel.getIntent(id)!.state, 'unknown');
        assert.throws(() => kernel.dispatch(id), error => error instanceof KernelError && error.code === 'STALE_GENERATION');
      }
      for (const id of unsent) {
        const intent = kernel.getIntent(id) as Intent & { recoveryRebindable?: boolean };
        assert.equal(intent.state, 'denied'); assert.equal(intent.recoveryRebindable, true);
      }
      const denialOrder = kernel.events(active.taskId).filter(event => event.type === 'intent.denied' && unsent.includes(String(event.payload.intentId))).map(event => String(event.payload.intentId));
      assert.deepEqual(denialOrder, unsent, 'mixed prepared/approved rows preserve insertion order even as recovery changes their states');
      assert.equal(archiveDigest(kernel), before, 'settled archive records are byte-identical');
      assert.equal(observation.stats.settled, 0);
      assert.equal(observation.stats.materialized, sentCount + unsentCount);
      assert.ok(observation.stats.maxBatch <= 100, `largest materialized batch=${observation.stats.maxBatch}`);
      assertIndexed(kernel, observation.stats.queries);
      observation.stats.materialized = 0; observation.stats.queries.length = 0;
      const repeated = kernel.recover();
      assert.deepEqual(repeated.unknownIntents, []);
      assert.deepEqual(repeated.reconciling, [active.taskId]);
      assert.equal(observation.stats.materialized, 0, 'a repeated recovery does not reread settled/unknown bodies');
      assert.equal(kernel.events(active.taskId).filter(event => event.type === 'effect.unknown').length, sentCount);
    } finally { observation.restore(); }
  });
}

test('pausing a long task fences only unfinished effects and running executions in bounded batches', t => {
  const f = fixture(t), active = running(f.kernel), template = prepare(f.kernel, active.taskId, active.runId);
  f.kernel.deny(template.id); seedSettled(f.kernel, template);
  const sent: string[] = [], unsent: string[] = [];
  for (let i = 0; i < 205; i++) {
    const intent = prepare(f.kernel, active.taskId, active.runId);
    if (i % 3 !== 0) f.kernel.approve(intent.id);
    if (i % 3 === 2) { f.kernel.dispatch(intent.id); sent.push(intent.id); }
    else unsent.push(intent.id);
  }
  const before = archiveDigest(f.kernel), observation = observe(f.kernel);
  let fullRunReads = 0;
  const runs = f.kernel.getRuns.bind(f.kernel);
  f.kernel.getRuns = (...args) => { fullRunReads++; return runs(...args); };
  try {
    f.kernel.command({ commandId: randomUUID(), taskId: active.taskId, type: 'pause' });
    assert.equal(f.kernel.getTask(active.taskId)!.status, 'paused');
    for (const id of sent) assert.equal(f.kernel.getIntent(id)!.state, 'unknown');
    for (const id of unsent) assert.equal(f.kernel.getIntent(id)!.state, 'denied');
    assert.equal(archiveDigest(f.kernel), before);
    assert.equal(observation.stats.settled, 0, 'pause must not decode settled tool history');
    assert.equal(observation.stats.materialized, 205);
    assert.ok(observation.stats.maxBatch <= 100); assertIndexed(f.kernel, observation.stats.queries);
    assert.equal(fullRunReads, 0, 'pause must select only running executions');
    assert.equal(runs(active.taskId).find(run => run.id === active.runId)!.status, 'superseded');
  } finally { observation.restore(); }
});
