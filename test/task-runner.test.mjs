import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { createDatabase } from "../core/database.js";
import { createTaskRunner, DEFAULT_RUN_BUDGET } from "../core/task-runner.js";

class FakeClock {
  constructor(value = "2026-08-03T00:00:00.000Z") { this.ms = new Date(value).getTime(); }
  now() { return new Date(this.ms).toISOString(); }
  advance(milliseconds) { this.ms += milliseconds; return this.now(); }
}

function harness(nowValue = "2026-08-03T00:00:00.000Z") {
  const db = createDatabase(":memory:");
  const registered = [];
  const context = {
    createWorkspace(input) { registered.push({ type: "workspace", input }); return { id: input.id || `ctx_${input.runId}` }; },
    registerBlock(workspaceId, input) { registered.push({ type: "block", workspaceId, input }); return { id: "B1", ...input }; }
  };
  const runner = createTaskRunner({ db, contextService: context, now: () => nowValue, randomId: (prefix) => `${prefix}_${registered.length + db.all("SELECT id FROM events").length + 1}` });
  return { db, runner, registered };
}

function grantRun(db, run, { model = "", network = [] } = {}) {
  const at = run.createdAt;
  const expiresAt = new Date(new Date(at).getTime() + run.budget.durationHours * 60 * 60_000).toISOString();
  db.run(`INSERT INTO grants (id, run_id, paths_json, commands_json, network_json, model, expires_at, budget_json, status, created_at, updated_at)
    VALUES (?, ?, '[]', '[]', ?, ?, ?, ?, 'active', ?, ?)`,
  `grant_${run.id}`, run.id, JSON.stringify(network), model, expiresAt, JSON.stringify(run.budget), at, at);
}

test("创建任务和运行会固定目标、验收标准与默认 72h 预算", () => {
  const { db, runner, registered } = harness();
  const task = runner.createTask({ title: "重建应用", description: "恢复并重构", acceptanceCriteria: ["API 可用", "移动端无溢出"] });
  const run = runner.startRun(task.id);

  assert.equal(run.status, "queued");
  assert.deepEqual(run.budget, DEFAULT_RUN_BUDGET);
  assert.equal(registered.filter((item) => item.type === "block").length, 3);
  assert.equal(registered.find((item) => item.type === "block").input.status, "pinned");
  assert.ok(registered.filter((item) => item.type === "block").every((item) => item.input.metadata.permanentPinned === true));
  assert.deepEqual(runner.getEvents(run.id).map((event) => event.type), ["run.snapshot", "run.status"]);
  db.close();
});

test("租约具有排他性，暂停/恢复产生单调事件序列", () => {
  const { db, runner } = harness();
  const task = runner.createTask({ title: "Long run" });
  const run = runner.startRun(task.id);
  assert.equal(runner.acquireLease(run.id, "worker-a", 90_000), true);
  assert.equal(runner.acquireLease(run.id, "worker-b", 90_000), false);
  runner.pauseRun(run.id, "manual");
  runner.resumeRun(run.id);
  const events = runner.getEvents(run.id);
  assert.ok(events.every((event, index) => index === 0 || event.sequence > events[index - 1].sequence));
  assert.equal(runner.getRun(run.id).status, "queued");
  db.close();
});

test("预算命中任一上限就暂停，未知价格仍受 token/调用次数限制", () => {
  const { db, runner } = harness();
  const task = runner.createTask({ title: "Budget" });
  const run = runner.startRun(task.id, { budget: { ...DEFAULT_RUN_BUDGET, maxModelCalls: 1 } });
  const result = runner.recordModelUsage(run.id, { model: "unknown", inputTokens: 20, outputTokens: 10, estimatedUsd: null });
  assert.equal(result.exhausted, true);
  assert.equal(runner.getRun(run.id).status, "paused");
  assert.equal(runner.getEvents(run.id).at(-1).type, "run.status");
  db.close();
});

test("未完成 effect 在恢复时进入 reconciling 而不是重放", () => {
  const { db, runner } = harness();
  const task = runner.createTask({ title: "Effect" });
  const run = runner.startRun(task.id);
  runner.beginEffect(run.id, { kind: "file.write", idempotencyKey: "write-1", intent: { path: "a.txt" } });
  const count = runner.reconcileUncertainEffects(run.id);
  assert.equal(count, 1);
  assert.equal(runner.getRun(run.id).status, "reconciling");
  assert.throws(() => runner.resumeRun(run.id), (error) => error.code === "effect_reconciliation_required");
  const effect = db.get("SELECT id FROM effects WHERE run_id = ? AND status = 'uncertain'", run.id);
  runner.resolveEffect(effect.id, { decision: "not_applied" });
  assert.equal(runner.resumeRun(run.id).status, "queued");
  db.close();
});

test("malformed model usage cannot underflow durable budget counters", () => {
  const { db, runner } = harness();
  const task = runner.createTask({ title: "Usage validation" });
  const run = runner.startRun(task.id, {
    budget: { ...DEFAULT_RUN_BUDGET, maxModelCalls: 99, maxInputTokens: 1, maxOutputTokens: 1 }
  });

  const malformed = runner.recordModelUsage(run.id, { inputTokens: -999, outputTokens: Number.NaN, estimatedUsd: -50 });
  assert.equal(malformed.run.inputTokens, 0);
  assert.equal(malformed.run.outputTokens, 0);
  assert.equal(malformed.run.estimatedCost, 0);
  assert.equal(malformed.run.status, "queued");
  const usageRow = db.get("SELECT input_tokens, output_tokens, estimated_cost FROM usage WHERE run_id = ?", run.id);
  assert.equal(usageRow.input_tokens, 0);
  assert.equal(usageRow.output_tokens, 0);
  assert.equal(usageRow.estimated_cost, 0);

  const exhausted = runner.recordModelUsage(run.id, { inputTokens: 1, outputTokens: 0 });
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.run.status, "paused");
  db.close();
});

test("effect id collisions return a durable conflict instead of a null ledger row", () => {
  const { db, runner } = harness();
  const task = runner.createTask({ title: "Effect identity" });
  const run = runner.startRun(task.id);
  const effect = runner.beginEffect(run.id, { id: "fixed-effect", idempotencyKey: "key-a" });
  assert.equal(effect.id, "fixed-effect");
  assert.throws(
    () => runner.beginEffect(run.id, { id: "fixed-effect", idempotencyKey: "key-b" }),
    (error) => error.code === "effect_id_conflict" && error.statusCode === 409
  );
  db.close();
});

test("fake clock leases expire after 90s and heartbeat refreshes them at 30s", () => {
  const clock = new FakeClock();
  const db = createDatabase(":memory:");
  let sequence = 0;
  const runner = createTaskRunner({ db, now: () => clock.now(), randomId: (prefix) => `${prefix}_lease_${++sequence}` });
  const task = runner.createTask({ title: "Lease" });
  const run = runner.startRun(task.id);
  assert.equal(runner.acquireLease(run.id, "worker-a"), true);
  const firstExpiry = new Date(runner.getRun(run.id).leaseExpiresAt).getTime();
  assert.equal(firstExpiry - clock.ms, 90_000);
  clock.advance(30_000);
  assert.equal(runner.heartbeat(run.id, "worker-a"), true);
  const heartbeatRun = runner.getRun(run.id);
  assert.equal(new Date(heartbeatRun.heartbeatAt).getTime(), clock.ms);
  assert.equal(new Date(heartbeatRun.leaseExpiresAt).getTime() - clock.ms, 90_000);
  clock.advance(89_999);
  assert.equal(runner.acquireLease(run.id, "worker-b"), false);
  clock.advance(1);
  assert.equal(runner.acquireLease(run.id, "worker-b"), true);
  db.close();
});

test("Run Grant enforces model, network, command, and path and deduplicates approvals", async () => {
  const clock = new FakeClock();
  const db = createDatabase(":memory:");
  const runner = createTaskRunner({
    db,
    now: () => clock.now(),
    modelClient: { async run() { return { text: "must not run" }; } }
  });
  const task = runner.createTask({ title: "Grant boundary" });
  const missing = runner.startRun(task.id);
  await runner.tick();
  assert.equal(runner.getRun(missing.id).status, "waiting_approval");
  const approval = db.get("SELECT * FROM approvals WHERE run_id = ?", missing.id);
  assert.ok(approval);
  assert.equal(runner.getEvents(missing.id).filter((event) => event.type === "approval.requested").length, 1);
  runner.requestApproval(missing.id, JSON.parse(approval.request_json));
  assert.equal(db.get("SELECT count(*) AS count FROM approvals WHERE run_id = ?", missing.id).count, 1);

  const granted = runner.startRun(task.id);
  grantRun(db, granted, { model: "model-a", network: ["api.example.com"] });
  db.run("UPDATE grants SET commands_json = ?, paths_json = ? WHERE run_id = ?", JSON.stringify(["node"]), JSON.stringify([process.cwd()]), granted.id);
  assert.ok(runner.assertRunGrant(granted.id, { model: "model-a", hosts: ["api.example.com"], command: "node --test", path: process.cwd() }));
  assert.throws(() => runner.assertRunGrant(granted.id, { model: "model-b" }), (error) => error.code === "grant_model_denied");
  assert.throws(() => runner.assertRunGrant(granted.id, { hosts: ["evil.example"] }), (error) => error.code === "grant_network_denied");
  assert.throws(() => runner.assertRunGrant(granted.id, { command: "powershell whoami" }), (error) => error.code === "grant_command_denied");
  assert.throws(() => runner.assertRunGrant(granted.id, { path: join(process.cwd(), "..") }), (error) => error.code === "grant_path_denied");
  db.run("UPDATE grants SET budget_json = ? WHERE run_id = ?", JSON.stringify({ ...granted.budget, enforced: false }), granted.id);
  assert.throws(() => runner.assertRunGrant(granted.id), (error) => error.code === "grant_invalid");
  db.run("UPDATE grants SET budget_json = ? WHERE run_id = ?", JSON.stringify({ ...granted.budget, maxEstimatedUsd: 0 }), granted.id);
  assert.throws(() => runner.assertRunGrant(granted.id), (error) => error.code === "grant_invalid");
  db.close();
});

test("model failures use 1/5/15/60 minute backoff and repeat failures pause after three repairs", async () => {
  const clock = new FakeClock();
  const db = createDatabase(":memory:");
  let sequence = 0;
  const runner = createTaskRunner({
    db,
    now: () => clock.now(),
    randomId: (prefix) => `${prefix}_backoff_${++sequence}`,
    modelClient: { async run() { throw new Error(`failure-${sequence}`); } }
  });
  const task = runner.createTask({ title: "Backoff" });
  const run = runner.startRun(task.id);
  grantRun(db, run);
  const delays = [60_000, 300_000, 900_000, 3_600_000];
  for (const delay of delays) {
    await runner.tick();
    const sleeping = runner.getRun(run.id);
    assert.equal(sleeping.status, "sleeping");
    assert.equal(new Date(sleeping.nextWakeAt).getTime() - clock.ms, delay);
    clock.advance(delay);
  }
  assert.equal(runner.getRun(run.id).status, "sleeping");
  db.close();

  const repairClock = new FakeClock();
  const repairDb = createDatabase(":memory:");
  let repairSequence = 0;
  const repairRunner = createTaskRunner({
    db: repairDb,
    now: () => repairClock.now(),
    randomId: (prefix) => `${prefix}_repair_${++repairSequence}`,
    modelClient: { async run() { throw new Error("same failure"); } }
  });
  const repairTask = repairRunner.createTask({ title: "Repair" });
  const repairRun = repairRunner.startRun(repairTask.id);
  grantRun(repairDb, repairRun);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await repairRunner.tick();
    const state = repairRunner.getRun(repairRun.id);
    if (state.status === "paused") break;
    repairClock.advance(new Date(state.nextWakeAt).getTime() - repairClock.ms);
  }
  assert.equal(repairRunner.getRun(repairRun.id).status, "paused");
  assert.equal(repairRunner.getRun(repairRun.id).metadata.autoRepairAttempts, 3);
  repairDb.close();
});

test("eight model calls without verifiable progress pause the run", async () => {
  const clock = new FakeClock();
  const db = createDatabase(":memory:");
  let sequence = 0;
  const runner = createTaskRunner({
    db,
    now: () => clock.now(),
    randomId: (prefix) => `${prefix}_progress_${++sequence}`,
    modelClient: { async run() { return { text: "still working", progressMade: false, usage: { inputTokens: 1, outputTokens: 1 } }; } }
  });
  const task = runner.createTask({ title: "No progress" });
  const run = runner.startRun(task.id);
  grantRun(db, run);
  for (let index = 0; index < 8; index += 1) {
    await runner.tick();
    const state = runner.getRun(run.id);
    if (state.status === "paused") break;
    clock.advance(Math.max(1, new Date(state.nextWakeAt).getTime() - clock.ms));
  }
  const paused = runner.getRun(run.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.metadata.noProgressCalls, 8);
  assert.equal(paused.metadata.pauseReason, "no_verifiable_progress");
  db.close();
});

test("model response, tool intent/result, and status events are persisted transactionally", async () => {
  const clock = new FakeClock();
  const db = createDatabase(":memory:");
  let sequence = 0;
  const runner = createTaskRunner({
    db,
    now: () => clock.now(),
    randomId: (prefix) => `${prefix}_tx_${++sequence}`,
    modelClient: { async run() { return { text: "verified", progressMade: true, usage: { inputTokens: 3, outputTokens: 2 }, checkpoint: { marker: "cp" } }; } }
  });
  const task = runner.createTask({ title: "Transactions" });
  const run = runner.startRun(task.id);
  grantRun(db, run);
  await runner.tick();
  assert.equal(db.get("SELECT count(*) AS count FROM usage WHERE run_id = ?", run.id).count, 1);
  assert.equal(db.get("SELECT count(*) AS count FROM events WHERE run_id = ? AND type = 'model.response'", run.id).count, 1);
  assert.equal(db.get("SELECT count(*) AS count FROM events WHERE run_id = ? AND type = 'message.delta'", run.id).count, 1);
  const effect = runner.beginEffect(run.id, { kind: "file.write", idempotencyKey: "tx-1", intent: { path: "x" } });
  assert.equal(db.get("SELECT status FROM effects WHERE id = ?", effect.id).status, "intent");
  runner.completeEffect(effect.id, { ok: true }, "checksum");
  assert.equal(db.get("SELECT status FROM effects WHERE id = ?", effect.id).status, "completed");
  assert.equal(db.get("SELECT checksum FROM effects WHERE id = ?", effect.id).checksum, "checksum");
  assert.ok(runner.getEvents(run.id).some((event) => event.type === "tool.requested"));
  assert.ok(runner.getEvents(run.id).some((event) => event.type === "tool.completed"));
  assert.equal(runner.getRun(run.id).metadata.checkpointSeq, 1);
  db.close();
});

test("budget duration uses injected clock rather than wall clock", () => {
  const clock = new FakeClock();
  const db = createDatabase(":memory:");
  let sequence = 0;
  const runner = createTaskRunner({ db, now: () => clock.now(), randomId: (prefix) => `${prefix}_clock_${++sequence}` });
  const task = runner.createTask({ title: "Duration" });
  const run = runner.startRun(task.id, { budget: { ...DEFAULT_RUN_BUDGET, durationHours: 1, maxModelCalls: 99 } });
  clock.advance(60 * 60 * 1000 + 1);
  const result = runner.recordModelUsage(run.id, { inputTokens: 1, outputTokens: 1, progressMade: true });
  assert.equal(result.exhausted, true);
  assert.equal(runner.getRun(run.id).status, "paused");
  db.close();
});

test("跨数据库连接原子竞争租约与 effect idempotency key", async (t) => {
  const parent = join(process.cwd(), ".tmp");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "runner-race-"));
  const filename = join(directory, "state.sqlite");
  const clock = new FakeClock();
  const firstDb = createDatabase(filename);
  const first = createTaskRunner({ db: firstDb, now: () => clock.now(), randomId: (prefix) => `${prefix}_first_${Math.random()}` });
  const task = first.createTask({ title: "race" });
  const run = first.startRun(task.id);
  const secondDb = createDatabase(filename);
  const second = createTaskRunner({ db: secondDb, now: () => clock.now(), randomId: (prefix) => `${prefix}_second_${Math.random()}` });
  t.after(async () => { firstDb.close(); secondDb.close(); await rm(directory, { recursive: true, force: true }); });

  assert.equal(first.acquireLease(run.id, "worker-a"), true);
  assert.equal(second.acquireLease(run.id, "worker-b"), false);
  const effectA = first.beginEffect(run.id, { kind: "model.call", idempotencyKey: "same-effect", intent: { callNumber: 1 } });
  const effectB = second.beginEffect(run.id, { kind: "model.call", idempotencyKey: "same-effect", intent: { callNumber: 1 } });
  assert.equal(effectA.id, effectB.id);
  assert.equal(firstDb.get("SELECT count(*) AS count FROM effects WHERE run_id = ? AND idempotency_key = ?", run.id, "same-effect").count, 1);
});

test("外部 metadata 秘密被递归剥离，未确认预算不能扩大或关闭", () => {
  const { db, runner } = harness();
  const task = runner.createTask({ title: "safe", metadata: { apiKey: "secret", nested: { token: "nested", label: "kept" } } });
  const run = runner.startRun(task.id, {
    budget: { durationHours: 999, maxModelCalls: 9999, enforced: false },
    metadata: { secrets: { apiKey: "secret" }, nested: { authorization: "Bearer secret", label: "kept" } }
  });
  assert.equal(task.metadata.apiKey, undefined);
  assert.equal(task.metadata.nested.token, undefined);
  assert.equal(task.metadata.nested.label, "kept");
  assert.deepEqual(run.budget, DEFAULT_RUN_BUDGET);
  assert.equal(run.metadata.secrets, undefined);
  assert.equal(run.metadata.nested.authorization, undefined);
  assert.equal(run.metadata.nested.label, "kept");
  assert.equal(db.get("SELECT metadata_json FROM runs WHERE id = ?", run.id).metadata_json.includes("secret"), false);
  const confirmed = runner.startRun(task.id, { __budgetConfirmed: true, budget: { durationHours: 96, maxModelCalls: 400, enforced: false } });
  assert.equal(confirmed.budget.durationHours, 96);
  assert.equal(confirmed.budget.maxModelCalls, 400);
  assert.equal(confirmed.budget.enforced, false);
  db.close();
});

test("连续三次成功模型调用不会回放旧 effect", async () => {
  const clock = new FakeClock();
  const db = createDatabase(":memory:");
  let calls = 0;
  const runner = createTaskRunner({ db, now: () => clock.now(), modelClient: { async run() { calls += 1; return { text: `slice-${calls}`, progressMade: true, usage: { inputTokens: 1, outputTokens: 1 } }; } } });
  const task = runner.createTask({ title: "three calls" });
  const run = runner.startRun(task.id);
  grantRun(db, run);
  for (let index = 0; index < 3; index += 1) {
    await runner.tick();
    const state = runner.getRun(run.id);
    clock.advance(Math.max(1, new Date(state.nextWakeAt).getTime() - clock.ms));
  }
  assert.equal(calls, 3);
  assert.equal(runner.getRun(run.id).metadata.modelCalls, 3);
  db.close();
});

test("回滚事务不会向 SSE 订阅者发送幻象事件", () => {
  const { db, runner } = harness();
  const task = runner.createTask({ title: "rollback event" });
  const run = runner.startRun(task.id);
  const seen = [];
  const unsubscribe = runner.subscribe(run.id, (event) => seen.push(event));
  assert.throws(() => db.transaction(() => {
    runner.recordEvent(run.id, "step.updated", { title: "must rollback" });
    throw new Error("rollback");
  }), /rollback/);
  unsubscribe();
  assert.equal(seen.length, 0);
  assert.equal(runner.getEvents(run.id).some((event) => event.payload?.title === "must rollback"), false);
  db.close();
});
