import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { createDatabase } from "../core/database.js";
import { createTaskRunner } from "../core/task-runner.js";

class FakeClock {
  constructor(value = "2026-08-03T00:00:00.000Z") { this.ms = new Date(value).getTime(); }
  now() { return new Date(this.ms).toISOString(); }
  advance(milliseconds) { this.ms += milliseconds; }
}

async function projectTemp(t, prefix) {
  const root = join(process.cwd(), ".tmp");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, prefix));
  return directory;
}

function runChild(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr, signal });
      else reject(new Error(`child exited ${code ?? signal}: ${stderr}`));
    });
  });
}

test("committed effect intent survives process termination and reconciles without replay", async (t) => {
  const directory = await projectTemp(t, "fault-intent-");
  const filename = join(directory, "state.sqlite");
  await runChild(`
    import { createDatabase } from './core/database.js';
    import { createTaskRunner } from './core/task-runner.js';
    const db = createDatabase(process.env.FAULT_DB);
    let sequence = 0;
    const runner = createTaskRunner({ db, now: () => '2026-08-03T00:00:00.000Z', randomId: (prefix) => prefix + '_child_' + (++sequence) });
    const task = runner.createTask({ id: 'task-crash', title: 'Crash recovery' });
    const run = runner.startRun(task.id, { id: 'run-crash' });
    runner.beginEffect(run.id, { id: 'effect-crash', kind: 'file.write', idempotencyKey: 'crash-1', intent: { path: 'a.txt', content: 'x' } });
    process.exit(0);
  `, { FAULT_DB: filename });

  const db = createDatabase(filename);
  t.after(() => { db.close(); return rm(directory, { recursive: true, force: true }); });
  const calls = [];
  const runner = createTaskRunner({
    db,
    now: () => "2026-08-03T00:00:00.000Z",
    modelClient: { async run() { calls.push("replayed"); return { progressMade: true }; } }
  });
  assert.equal(db.get("SELECT status FROM effects WHERE id = 'effect-crash'").status, "intent");
  assert.equal(runner.reconcileUncertainEffects("run-crash"), 1);
  assert.equal(runner.getRun("run-crash").status, "reconciling");
  assert.equal(runner.getEffect("effect-crash").status, "uncertain");
  await runner.tick();
  assert.deepEqual(calls, [], "uncertain effects must not trigger an automatic replay");
});

test("completed effect ledger can backfill usage without calling the model provider", async (t) => {
  const directory = await projectTemp(t, "fault-ledger-");
  const filename = join(directory, "state.sqlite");
  let db = createDatabase(filename);
  let setupSequence = 0;
  const setup = createTaskRunner({ db, now: () => "2026-08-03T00:00:00.000Z", randomId: (prefix) => `${prefix}_setup_${++setupSequence}` });
  const task = setup.createTask({ id: "task-ledger", title: "Ledger recovery" });
  const run = setup.startRun(task.id, { id: "run-ledger" });
  const effect = setup.beginEffect(run.id, {
    id: "effect-ledger",
    kind: "model.response",
    idempotencyKey: "response-1",
    intent: { prompt: "complete" }
  });
  setup.completeEffect(effect.id, {
    response: { text: "already completed" },
    usage: { model: "mock", inputTokens: 5, outputTokens: 2, progressMade: true }
  }, "response-checksum");
  setup.transitionRun(run.id, "completed", "effect_committed");
  db.close();

  db = createDatabase(filename);
  t.after(() => { db.close(); return rm(directory, { recursive: true, force: true }); });
  let providerCalls = 0;
  const runner = createTaskRunner({
    db,
    now: () => "2026-08-03T00:00:00.000Z",
    modelClient: { async run() { providerCalls += 1; return { progressMade: true }; } }
  });
  const ledger = runner.getEffect(effect.id);
  assert.equal(ledger.status, "completed");
  assert.equal(db.get("SELECT count(*) AS count FROM usage WHERE run_id = ?", run.id).count, 0);
  const recoveredUsage = ledger.result.usage;
  runner.recordModelUsage(run.id, recoveredUsage);
  assert.equal(db.get("SELECT count(*) AS count FROM usage WHERE run_id = ?", run.id).count, 1);
  await runner.tick();
  assert.equal(providerCalls, 0, "a completed effect must be the durable source of truth");
});

test("throwing before SQLite commit leaves no half-created task state", async (t) => {
  const directory = await projectTemp(t, "fault-tx-");
  const db = createDatabase(join(directory, "state.sqlite"));
  t.after(() => { db.close(); return rm(directory, { recursive: true, force: true }); });
  assert.throws(() => db.transaction(() => {
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", "project-fault", "Fault", "2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z");
    db.run("INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", "task-fault", "project-fault", "Half state", "2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z");
    throw new Error("fault before commit");
  }), /fault before commit/);
  assert.equal(db.get("SELECT count(*) AS count FROM projects WHERE id = 'project-fault'").count, 0);
  assert.equal(db.get("SELECT count(*) AS count FROM tasks WHERE id = 'task-fault'").count, 0);
});

test("an expired lease is taken over by another worker connection", async (t) => {
  const directory = await projectTemp(t, "fault-lease-");
  const filename = join(directory, "state.sqlite");
  const clock = new FakeClock();
  const dbA = createDatabase(filename);
  const dbB = createDatabase(filename);
  t.after(() => { dbA.close(); dbB.close(); return rm(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const runnerA = createTaskRunner({ db: dbA, now: () => clock.now(), randomId: (prefix) => `${prefix}_a_${++sequence}` });
  const runnerB = createTaskRunner({ db: dbB, now: () => clock.now(), randomId: (prefix) => `${prefix}_b_${++sequence}` });
  const task = runnerA.createTask({ title: "Lease takeover" });
  const run = runnerA.startRun(task.id, { id: "run-lease" });
  assert.equal(runnerA.acquireLease(run.id, "worker-a"), true);
  assert.equal(runnerB.acquireLease(run.id, "worker-b"), false);
  clock.advance(90_001);
  assert.equal(runnerB.acquireLease(run.id, "worker-b"), true);
  assert.equal(runnerB.getRun(run.id).leaseOwner, "worker-b");
});
