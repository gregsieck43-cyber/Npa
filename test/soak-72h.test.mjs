import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { createDatabase } from "../core/database.js";
import { createContextWorkspaceService } from "../core/context-workspace.js";
import { createPayloadStore } from "../core/payload-store.js";
import { createTaskRunner, DEFAULT_RUN_BUDGET } from "../core/task-runner.js";

class FakeClock {
  constructor(value = "2026-08-03T00:00:00.000Z") { this.ms = new Date(value).getTime(); }
  now() { return new Date(this.ms).toISOString(); }
  advance(milliseconds) { this.ms += milliseconds; }
}

test("accelerated 72h Mock Provider soak preserves checkpoints, lease, budget, and pinned goal blocks", async (t) => {
  const root = join(process.cwd(), ".tmp");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "soak-72h-"));
  const filename = join(directory, "state.sqlite");
  let db = createDatabase(filename);
  t.after(() => { db.close(); return rm(directory, { recursive: true, force: true }); });

  const clock = new FakeClock();
  let idSequence = 0;
  let providerCalls = 0;
  const payloadStore = createPayloadStore({ root: join(directory, "payloads"), key: Buffer.alloc(32, 9) });
  const context = createContextWorkspaceService({ db, payloadStore, now: () => clock.now() });
  const provider = {
    async run({ run }) {
      providerCalls += 1;
      return {
        text: `checkpoint-${providerCalls}`,
        progressMade: true,
        usage: { inputTokens: 100, outputTokens: 20 },
        checkpoint: { sequence: providerCalls, marker: run.id }
      };
    }
  };
  const runner = createTaskRunner({
    db,
    contextService: context,
    modelClient: provider,
    now: () => clock.now(),
    randomId: (prefix) => `${prefix}_soak_${++idSequence}`
  });
  const task = runner.createTask({
    title: "72h durable task",
    acceptanceCriteria: ["checkpoint survives restart"],
    constraints: ["mock provider only"]
  });
  const run = runner.startRun(task.id, {
    budget: { ...DEFAULT_RUN_BUDGET, maxModelCalls: 288, maxInputTokens: 12_000_000, maxOutputTokens: 2_000_000 }
  });
  db.run(`INSERT INTO grants (id, run_id, paths_json, commands_json, network_json, model, expires_at, budget_json, status, created_at, updated_at)
    VALUES (?, ?, '[]', '[]', '[]', '', ?, ?, 'active', ?, ?)`,
  `grant_${run.id}`, run.id, new Date(clock.ms + 72 * 60 * 60_000).toISOString(), JSON.stringify(run.budget), run.createdAt, run.createdAt);

  // One slice per 15 minutes gives exactly 288 model calls over 72 accelerated hours.
  for (let slice = 0; slice < 288; slice += 1) {
    await runner.tick();
    const state = runner.getRun(run.id);
    if (state.status === "paused") break;
    const wakeAt = new Date(state.nextWakeAt).getTime();
    assert.ok(wakeAt > clock.ms, `slice ${slice} must persist a future wake time`);
    clock.advance(wakeAt - clock.ms);
  }

  assert.equal(providerCalls, 288);
  const completedBudget = runner.getRun(run.id);
  assert.equal(completedBudget.status, "paused");
  assert.equal(completedBudget.metadata.modelCalls, 288);
  assert.equal(completedBudget.metadata.pauseReason, "budget_exhausted");
  assert.equal(completedBudget.metadata.checkpointSeq, 288);
  assert.equal(db.get("SELECT count(*) AS count FROM usage WHERE run_id = ?", run.id).count, 288);
  assert.equal(db.get("SELECT count(*) AS count FROM events WHERE run_id = ? AND type = 'model.response'", run.id).count, 288);

  // Reopen the file to prove the durable checkpoint and pinned context survive a restart.
  db.close();
  db = createDatabase(filename);
  const reopenedContext = createContextWorkspaceService({ db, payloadStore, now: () => clock.now() });
  const reopenedRunner = createTaskRunner({ db, contextService: reopenedContext, now: () => clock.now() });
  const recovered = reopenedRunner.getRun(run.id);
  assert.equal(recovered.metadata.checkpointSeq, 288);
  assert.equal(recovered.metadata.modelCalls, 288);
  const pinned = reopenedContext.listBlocks(recovered.workspaceId, { pinned: true });
  assert.equal(pinned.length, 3);
  assert.ok(pinned.every((block) => block.pinned && block.status === "pinned"));
  assert.ok(pinned.every((block) => block.payloadHash), "pinned goal context keeps lossless payload references");
});
