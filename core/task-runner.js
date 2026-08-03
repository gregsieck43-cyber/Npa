import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { decodeJson, encodeJson, nowIso } from "./database.js";

export const RUN_STATUSES = new Set([
  "queued", "running", "sleeping", "waiting_approval", "paused", "reconciling",
  "blocked", "completed", "failed", "canceled"
]);

export const DEFAULT_RUN_BUDGET = Object.freeze({
  durationHours: 72,
  maxModelCalls: 288,
  maxInputTokens: 12_000_000,
  maxOutputTokens: 2_000_000,
  maxEstimatedUsd: 25,
  enforced: true
});

export const LEASE_TTL_MS = 90_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const BACKOFF_DELAYS_MS = Object.freeze([60_000, 300_000, 900_000, 3_600_000]);
export const NO_PROGRESS_LIMIT = 8;
export const AUTO_REPAIR_LIMIT = 3;

export function createTaskRunner(options = {}) {
  return new DurableTaskRunner(options);
}

export class DurableTaskRunner {
  constructor({
    db,
    contextService = null,
    modelClient = null,
    now = nowIso,
    randomId = defaultId,
    schedulerIntervalMs = HEARTBEAT_INTERVAL_MS,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    leaseTtlMs = LEASE_TTL_MS,
    backoffDelaysMs = BACKOFF_DELAYS_MS,
    noProgressLimit = NO_PROGRESS_LIMIT,
    autoRepairLimit = AUTO_REPAIR_LIMIT
  } = {}) {
    if (!db) throw new TypeError("db is required");
    this.db = db;
    this.contextService = contextService;
    if (this.contextService?.registerBlock && !this.contextService.__durablePayloadAdapter) {
      try {
        const registerBlock = this.contextService.registerBlock.bind(this.contextService);
        this.contextService.registerBlock = (workspaceId, block = {}) => registerBlock(workspaceId, {
          ...block,
          payload: block.payload ?? block.content ?? block.summary ?? ""
        });
        this.contextService.__durablePayloadAdapter = true;
      } catch { /* frozen adapters can still persist their own payloads */ }
    }
    this.modelClient = modelClient;
    this._clock = typeof now === "function" ? now : () => now;
    this.now = () => normalizeTimestamp(this._clock());
    this.randomId = randomId;
    this.schedulerIntervalMs = schedulerIntervalMs;
    this.heartbeatIntervalMs = Math.max(1, Number(heartbeatIntervalMs));
    this.leaseTtlMs = Math.max(1, Number(leaseTtlMs));
    this.backoffDelaysMs = Array.isArray(backoffDelaysMs) && backoffDelaysMs.length
      ? backoffDelaysMs.map((value) => Math.max(0, Number(value)))
      : [...BACKOFF_DELAYS_MS];
    this.noProgressLimit = Math.max(1, Number(noProgressLimit));
    this.autoRepairLimit = Math.max(1, Number(autoRepairLimit));
    this.events = new EventEmitter();
    this.timer = null;
    this.activeTick = null;
    this.workerId = `worker_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
  }

  ensureDefaultProject() {
    const existing = this.db.get("SELECT * FROM projects ORDER BY created_at LIMIT 1");
    if (existing) return publicProject(existing);
    const at = this.now();
    const id = this.randomId("project");
    this.db.run(`INSERT INTO projects (id, name, description, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?)`, id, "本地工作台", "默认本地项目", encodeJson({ default: true }), at, at);
    return this.getProject(id);
  }

  createProject(input = {}) {
    const at = this.now();
    const id = String(input.id || this.randomId("project"));
    this.db.run(`INSERT INTO projects (id, name, description, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, id, String(input.name || "未命名项目"), String(input.description || ""),
    String(input.status || "active"), encodeJson(sanitizeRunMetadata(input.metadata || {})), at, at);
    return this.getProject(id);
  }

  getProject(id) {
    const row = this.db.get("SELECT * FROM projects WHERE id = ?", String(id));
    if (!row) throw notFound("项目不存在");
    return publicProject(row);
  }

  listProjects() {
    return this.db.all("SELECT * FROM projects ORDER BY updated_at DESC").map(publicProject);
  }

  createTask(input = {}) {
    const project = input.projectId ? this.getProject(input.projectId) : this.ensureDefaultProject();
    const at = this.now();
    const id = String(input.id || this.randomId("task"));
    const metadata = {
      acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.map(String).filter(Boolean) : [],
      constraints: Array.isArray(input.constraints) ? input.constraints.map(String).filter(Boolean) : [],
      ...sanitizeRunMetadata(input.metadata || {})
    };
    this.db.run(`INSERT INTO tasks (id, project_id, title, description, status, priority, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, project.id, String(input.title || "未命名任务"), String(input.description || ""),
    String(input.status || "queued"), Number(input.priority || 0), encodeJson(metadata), at, at);
    return this.getTask(id);
  }

  getTask(id) {
    const row = this.db.get("SELECT * FROM tasks WHERE id = ?", String(id));
    if (!row) throw notFound("任务不存在");
    return publicTask(row);
  }

  listTasks({ projectId = "", status = "" } = {}) {
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const params = [];
    if (projectId) { sql += " AND project_id = ?"; params.push(projectId); }
    if (status) { sql += " AND status = ?"; params.push(status); }
    sql += " ORDER BY updated_at DESC";
    return this.db.all(sql, ...params).map(publicTask);
  }

  startRun(taskId, input = {}) {
    const task = this.getTask(taskId);
    const at = this.now();
    const id = String(input.id || this.randomId("run"));
    const workspaceId = String(input.workspaceId || `ctx_${id}`);
    const budget = normalizeBudget(input.budget, { allowUnsafe: input.__budgetConfirmed === true });
    const metadata = {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedUsd: 0,
      checkpointSeq: 0,
      nextWakeAt: input.nextWakeAt || at,
      worktreePath: input.worktreePath || "",
      branch: input.branch || "",
      ...sanitizeRunMetadata(input.metadata || {})
    };
    this.db.transaction(() => {
      this.db.run(`INSERT INTO runs
        (id, project_id, task_id, status, workspace_id, budget_json, metadata_json,
         next_wake_at, attempt, model_calls, input_tokens, output_tokens, estimated_cost, checkpoint_seq,
         worktree_path, branch, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?)`,
      id, task.projectId, task.id, workspaceId, encodeJson(budget), encodeJson(metadata), metadata.nextWakeAt,
      metadata.worktreePath, metadata.branch, at, at);
      this.db.run("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?", at, task.id);
    });
    if (this.contextService) {
      this.contextService.createWorkspace({ id: workspaceId, runId: id, goal: task.title, tokenLimit: input.tokenLimit || 200_000, skipAutoBlocks: true });
      this.contextService.registerBlock(workspaceId, { type: "task_goal", status: "pinned", pinned: true, source: "task", content: [task.title, task.description].filter(Boolean).join("\n"), payload: { title: task.title, description: task.description }, metadata: { permanentPinned: true } });
      this.contextService.registerBlock(workspaceId, { type: "acceptance", status: "pinned", pinned: true, source: "task", content: task.acceptanceCriteria.join("\n") || "按任务目标完成并验证", metadata: { permanentPinned: true } });
      this.contextService.registerBlock(workspaceId, { type: "constraints", status: "pinned", pinned: true, source: "task", content: task.constraints.join("\n") || "遵守本地权限、预算与安全策略", metadata: { permanentPinned: true } });
    }
    this.db.transaction(() => {
      this.recordEvent(id, "run.snapshot", { run: this.getRun(id), task });
      this.recordEvent(id, "run.status", { status: "queued", reason: "created" });
    });
    return this.getRun(id);
  }

  getRun(id) {
    const row = this.db.get("SELECT * FROM runs WHERE id = ?", String(id));
    if (!row) throw notFound("运行不存在");
    return publicRun(row);
  }

  listRuns({ status = "", taskId = "" } = {}) {
    let sql = "SELECT * FROM runs WHERE 1=1";
    const params = [];
    if (status) { sql += " AND status = ?"; params.push(status); }
    if (taskId) { sql += " AND task_id = ?"; params.push(taskId); }
    sql += " ORDER BY updated_at DESC";
    return this.db.all(sql, ...params).map(publicRun);
  }

  transitionRun(id, status, reason = "") {
    if (!RUN_STATUSES.has(status)) throw Object.assign(new Error(`不支持的运行状态: ${status}`), { statusCode: 400 });
    const run = this.getRun(id);
    if (terminalStatus(run.status) && run.status !== status) throw Object.assign(new Error("终态运行不能再次转换"), { statusCode: 409 });
    const at = this.now();
    this.db.transaction(() => {
      this.db.run("UPDATE runs SET status = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?", status, at, id);
      this.recordEvent(id, "run.status", { from: run.status, status, reason });
    });
    return this.getRun(id);
  }

  pauseRun(id, reason = "manual") { return this.transitionRun(id, "paused", reason); }
  resumeRun(id) {
    const run = this.getRun(id);
    if (!["paused", "sleeping", "blocked", "waiting_approval", "reconciling"].includes(run.status)) {
      throw Object.assign(new Error("当前运行不可恢复"), { statusCode: 409 });
    }
    if (run.status === "reconciling") {
      const uncertain = Number(this.db.get("SELECT count(*) AS count FROM effects WHERE run_id = ? AND status = 'uncertain'", run.id)?.count || 0);
      if (uncertain > 0) throw Object.assign(new Error("仍有结果不确定的副作用，必须先显式对账"), { statusCode: 409, code: "effect_reconciliation_required" });
    }
    const pendingApprovals = Number(this.db.get("SELECT count(*) AS count FROM approvals WHERE run_id = ? AND status = 'pending'", run.id)?.count || 0);
    if (pendingApprovals > 0) throw Object.assign(new Error("Pending approvals must be resolved before resuming the run"), { statusCode: 409, code: "approval_pending" });
    return this.transitionRun(id, "queued", "resumed");
  }
  cancelRun(id) { return this.transitionRun(id, "canceled", "canceled"); }
  wakeRun(id) {
    const run = this.getRun(id);
    if (run.status === "sleeping" || run.status === "paused") return this.transitionRun(id, "queued", "wake");
    return run;
  }

  pauseAll(reason = "desktop") {
    const runs = this.listRuns().filter((run) => ["queued", "running", "sleeping"].includes(run.status));
    return runs.map((run) => this.pauseRun(run.id, reason));
  }
  resumeAll() {
    return this.listRuns({ status: "paused" }).map((run) => this.resumeRun(run.id));
  }
  checkpointAll() {
    return this.listRuns().filter((run) => !terminalStatus(run.status)).map((run) => this.checkpoint(run.id, "desktop_exit"));
  }

  checkpoint(id, reason = "periodic") {
    const run = this.getRun(id);
    const at = this.now();
    const metadata = { ...run.metadata, checkpointSeq: Number(run.metadata.checkpointSeq || 0) + 1, checkpointAt: at };
    this.db.transaction(() => {
      this.db.run("UPDATE runs SET metadata_json = ?, checkpoint_seq = ?, updated_at = ? WHERE id = ?", encodeJson(metadata), metadata.checkpointSeq, at, id);
      this.recordEvent(id, "run.snapshot", { reason, checkpointSeq: metadata.checkpointSeq, run: this.getRun(id) });
    });
    return this.getRun(id);
  }

  acquireLease(id, owner = this.workerId, ttlMs = this.leaseTtlMs) {
    const at = this.now();
    const nowMs = new Date(at).getTime();
    const expires = new Date(nowMs + ttlMs).toISOString();
    const result = this.db.run(`UPDATE runs SET lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
      attempt = coalesce(attempt, 0) + 1, status = 'running', updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running', 'sleeping')
        AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    owner, expires, at, at, id, owner, at);
    return Number(result.changes || 0) === 1;
  }

  heartbeat(id, owner = this.workerId, ttlMs = this.leaseTtlMs) {
    const at = this.now();
    const result = this.db.run(`UPDATE runs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND lease_expires_at > ?`,
    at, new Date(new Date(at).getTime() + ttlMs).toISOString(), at, id, owner, at);
    return Number(result.changes || 0) === 1;
  }

  heartbeatRun(id, owner = this.workerId, ttlMs = this.leaseTtlMs) {
    return this.heartbeat(id, owner, ttlMs);
  }

  renewLease(id, owner = this.workerId, ttlMs = this.leaseTtlMs) {
    return this.heartbeat(id, owner, ttlMs);
  }

  releaseLease(id, owner = this.workerId) {
    const result = this.db.run("UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_owner = ?", this.now(), id, owner);
    return Number(result.changes || 0) === 1;
  }

  recordModelUsage(id, usage = {}) {
    const run = this.getRun(id);
    const progressMade = isVerifiableProgress(usage);
    const at = this.now();
    const modelCalls = boundedAdd(nonNegativeInteger(run.metadata.modelCalls), 1);
    const inputTokens = nonNegativeInteger(usage.inputTokens ?? usage.input_tokens);
    const outputTokens = nonNegativeInteger(usage.outputTokens ?? usage.output_tokens);
    const rawEstimatedUsd = usage.estimatedUsd ?? usage.estimated_usd;
    const estimatedUsd = nonNegativeNumber(rawEstimatedUsd);
    const metadata = {
      ...run.metadata,
      modelCalls,
      inputTokens: boundedAdd(nonNegativeInteger(run.metadata.inputTokens), inputTokens),
      outputTokens: boundedAdd(nonNegativeInteger(run.metadata.outputTokens), outputTokens),
      estimatedUsd: boundedAdd(nonNegativeNumber(run.metadata.estimatedUsd), estimatedUsd),
      noProgressCalls: progressMade ? 0 : nonNegativeInteger(run.metadata.noProgressCalls) + 1,
      lastProgressAt: progressMade ? at : run.metadata.lastProgressAt || null,
      lastModelAt: at
    };
    if (usage.effectId) metadata.lastModelEffectId = String(usage.effectId);
    metadata.stagnantCalls = metadata.noProgressCalls;
    if (progressMade) {
      metadata.retryAttempt = 0;
      metadata.failureSignature = null;
      metadata.autoRepairAttempts = 0;
    }
    if (usage.checkpoint) metadata.checkpoint = usage.checkpoint;
    if (usage.checkpoint || progressMade) metadata.checkpointSeq = nonNegativeInteger(run.metadata.checkpointSeq) + 1;
    const usageId = this.randomId("usage");
    const exhausted = budgetExhausted({ ...run, metadata }, at);
    const noProgress = metadata.noProgressCalls >= this.noProgressLimit;
    this.db.transaction(() => {
      this.db.run(`UPDATE runs SET metadata_json = ?, model_calls = ?, input_tokens = ?, output_tokens = ?, estimated_cost = ?, checkpoint_seq = ?, updated_at = ? WHERE id = ?`,
      encodeJson(metadata), metadata.modelCalls, metadata.inputTokens, metadata.outputTokens, metadata.estimatedUsd,
      metadata.checkpointSeq || 0, at, id);
      this.db.run(`INSERT INTO usage (id, run_id, model, input_tokens, output_tokens, total_tokens, estimated_cost, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, usageId, id, String(usage.model || ""), inputTokens,
      outputTokens, inputTokens + outputTokens,
      estimatedUsd, encodeJson({ priceKnown: Number.isFinite(Number(rawEstimatedUsd)) }), at);
      this.recordEvent(id, "usage.updated", { usage: metadata, budget: run.budget, exhausted, progressMade });
      this.recordEvent(id, "model.response", { response: usage.response || null, usage, progressMade });
      if (usage.response !== null && usage.response !== undefined && String(usage.response).length) {
        this.recordEvent(id, "message.delta", {
          text: String(usage.response),
          complete: true,
          effectId: usage.effectId || ""
        });
      }
      if (exhausted || noProgress) {
        const reason = exhausted ? "budget_exhausted" : "no_verifiable_progress";
        this.db.run("UPDATE runs SET status = 'paused', next_wake_at = NULL, updated_at = ? WHERE id = ?", at, id);
        metadata.pauseReason = reason;
        this.db.run("UPDATE runs SET metadata_json = ? WHERE id = ?", encodeJson(metadata), id);
        this.recordEvent(id, "run.status", { status: "paused", reason });
      }
    });
    const updated = this.getRun(id);
    return { run: this.getRun(id), exhausted };
  }

  recordProgress(id, progress = {}) {
    return this.recordModelUsage(id, { ...progress, progressMade: true, inputTokens: 0, outputTokens: 0 });
  }

  beginEffect(runId, { id = this.randomId("effect"), kind = "tool", idempotencyKey = "", intent = {} } = {}) {
    this.getRun(runId);
    const at = this.now();
    let inserted = true;
    this.db.transaction(() => {
      const result = idempotencyKey
        ? this.db.run(`INSERT OR IGNORE INTO effects (id, run_id, idempotency_key, kind, status, intent_json, result_json, checksum, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'intent', ?, NULL, NULL, ?, ?)`, id, runId, idempotencyKey, kind, encodeJson(intent), at, at)
        : this.db.run(`INSERT INTO effects (id, run_id, idempotency_key, kind, status, intent_json, result_json, checksum, created_at, updated_at)
          VALUES (?, ?, NULL, ?, 'intent', ?, NULL, NULL, ?, ?)`, id, runId, kind, encodeJson(intent), at, at);
      inserted = Number(result.changes || 0) === 1;
      if (inserted) this.recordEvent(runId, "tool.requested", { effectId: id, kind, intent });
    });
    if (inserted) return this.getEffect(id);
    const existing = this.db.get("SELECT * FROM effects WHERE run_id = ? AND idempotency_key = ?", runId, idempotencyKey);
    if (existing) return publicEffect(existing);
    const conflictingId = this.db.get("SELECT id FROM effects WHERE id = ?", id);
    if (conflictingId) {
      throw Object.assign(new Error("effect id is already used by another effect"), { statusCode: 409, code: "effect_id_conflict" });
    }
    throw Object.assign(new Error("effect idempotency key conflict"), { statusCode: 409, code: "effect_idempotency_conflict" });
  }

  getEffect(id) {
    const row = this.db.get("SELECT * FROM effects WHERE id = ?", String(id));
    if (!row) throw notFound("副作用记录不存在");
    return publicEffect(row);
  }

  completeEffect(id, result = {}, checksum = "", { allowUncertain = false } = {}) {
    const effect = this.getEffect(id);
    if (effect.status === "completed") return effect;
    if (effect.status !== "intent" && !(allowUncertain && effect.status === "uncertain")) {
      throw Object.assign(new Error("副作用状态不允许写入完成结果"), { statusCode: 409, code: "effect_state_conflict" });
    }
    const at = this.now();
    const verifiedChecksum = String(checksum || createHash("sha256").update(encodeJson(result) || "null", "utf8").digest("hex"));
    this.db.transaction(() => {
      this.db.run("UPDATE effects SET status = 'completed', result_json = ?, checksum = ?, updated_at = ? WHERE id = ?",
        encodeJson(result), verifiedChecksum, at, id);
      this.recordEvent(effect.runId, "tool.completed", { effectId: id, kind: effect.kind, result, checksum: verifiedChecksum });
    });
    return this.getEffect(id);
  }

  reconcileUncertainEffects(runId) {
    const rows = this.db.all("SELECT * FROM effects WHERE run_id = ? AND status IN ('intent', 'running')", String(runId));
    if (!rows.length) return 0;
    const at = this.now();
    this.db.transaction(() => {
      this.db.run("UPDATE effects SET status = 'uncertain', updated_at = ? WHERE run_id = ? AND status IN ('intent', 'running')", at, runId);
      this.db.run("UPDATE runs SET status = 'reconciling', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?", at, runId);
      this.recordEvent(runId, "run.status", { status: "reconciling", reason: "uncertain_effect", effectIds: rows.map((row) => row.id) });
    });
    return rows.length;
  }

  resolveEffect(id, { decision, result = {}, checksum = "" } = {}) {
    const effect = this.getEffect(id);
    if (effect.status !== "uncertain") throw Object.assign(new Error("副作用不在待对账状态"), { statusCode: 409, code: "effect_not_uncertain" });
    if (decision === "completed") return this.completeEffect(id, result, checksum, { allowUncertain: true });
    if (decision !== "not_applied") throw Object.assign(new Error("对账决定必须是 completed 或 not_applied"), { statusCode: 400, code: "invalid_reconciliation_decision" });
    const at = this.now();
    this.db.transaction(() => {
      this.db.run("UPDATE effects SET status = 'not_applied', result_json = ?, checksum = ?, updated_at = ? WHERE id = ?", encodeJson({ decision }), createHash("sha256").update(decision).digest("hex"), at, id);
      this.recordEvent(effect.runId, "tool.completed", { effectId: id, kind: effect.kind, reconciliation: decision });
    });
    return this.getEffect(id);
  }

  recordEvent(runId, type, payload = {}) {
    const write = () => {
      const current = this.db.get("SELECT coalesce(max(sequence), 0) AS sequence FROM events WHERE run_id = ?", String(runId));
      const sequence = Number(current?.sequence || 0) + 1;
      const event = { id: this.randomId("event"), runId: String(runId), type: String(type), payload, sequence, createdAt: this.now() };
      this.db.run("INSERT INTO events (id, run_id, type, payload_json, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        event.id, event.runId, event.type, encodeJson(payload), sequence, event.createdAt);
      const emit = () => {
        this.events.emit(`run:${runId}`, event);
        this.events.emit("event", event);
      };
      if (typeof this.db.afterCommit === "function") this.db.afterCommit(emit); else emit();
      return event;
    };
    return this.db._transactionDepth > 0 ? write() : this.db.transaction(write);
  }

  /**
   * Validate the durable grant before a scheduler model call or a run-bound
   * tool effect.  A grant is intentionally narrower than the run budget and
   * may additionally restrict model, network, command, and filesystem scope.
   */
  assertRunGrant(runId, { model = "", hosts = [], command = "", path = "" } = {}) {
    const run = this.getRun(runId);
    const row = this.db.get("SELECT * FROM grants WHERE run_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1", run.id);
    const deny = (code, message, extra = {}) => {
      throw Object.assign(new Error(message), { statusCode: 403, code, ...extra });
    };
    if (!row) deny("grant_required", "Run Grant is required");

    const expiryMs = row.expires_at ? new Date(row.expires_at).getTime() : Number.NaN;
    if (!Number.isFinite(expiryMs)) deny("grant_invalid", "Run Grant expiry is invalid");
    if (expiryMs <= new Date(this.now()).getTime()) deny("grant_expired", "Run Grant has expired");

    const grantedModel = String(row.model || "").trim();
    const requestedModel = String(model || "").trim();
    if (grantedModel && requestedModel && grantedModel !== requestedModel) {
      deny("grant_model_denied", "Run Grant does not allow the requested model", { grantedModel, requestedModel });
    }

    let budget = decodeJson(row.budget_json, null);
    if (!budget || typeof budget !== "object" || Array.isArray(budget)) deny("grant_invalid", "Run Grant budget is invalid");
    if (budgetExhausted(run, this.now())) deny("grant_budget_exhausted", "Run budget is exhausted");
    if (run.budget.enforced !== false && budget.enforced === false) deny("grant_invalid", "Run Grant cannot disable the run budget");
    const constrainedBudget = { ...run.budget, ...budget, enforced: run.budget.enforced !== false || budget.enforced !== false };
    for (const key of ["durationHours", "maxModelCalls", "maxInputTokens", "maxOutputTokens", "maxEstimatedUsd"]) {
      const runLimit = Number(run.budget[key]);
      const grantLimit = Number(constrainedBudget[key]);
      if (!Number.isFinite(grantLimit) || grantLimit < 0 || (key === "maxEstimatedUsd" && runLimit > 0 && grantLimit === 0) || (Number.isFinite(runLimit) && grantLimit > runLimit)) {
        deny("grant_invalid", `Run Grant cannot expand budget field: ${key}`);
      }
    }
    if (constrainedBudget.enforced !== false) {
      const exhausted = budgetExhausted({ ...run, budget: constrainedBudget }, this.now());
      if (exhausted) deny("grant_budget_exhausted", "Run Grant budget is exhausted");
    }

    let allowedHosts = decodeJson(row.network_json, null);
    if (!Array.isArray(allowedHosts)) deny("grant_invalid", "Run Grant network scope is invalid");
    const requestedHosts = [...new Set((Array.isArray(hosts) ? hosts : [hosts]).map(normalizeGrantHost).filter(Boolean))];
    if (requestedHosts.length && !requestedHosts.every((host) => allowedHosts.some((domain) => grantHostMatches(host, domain)))) {
      deny("grant_network_denied", "Run Grant does not allow the requested network host", { requestedHosts });
    }

    let allowedCommands = decodeJson(row.commands_json, null);
    if (!Array.isArray(allowedCommands)) deny("grant_invalid", "Run Grant command scope is invalid");
    if (command) {
      const executable = normalizeGrantCommand(command);
      if (!executable || !allowedCommands.some((item) => normalizeGrantCommand(item) === executable)) {
        deny("grant_command_denied", `Run Grant does not allow command: ${executable || "unknown"}`, { command: executable });
      }
    }

    let allowedPaths = decodeJson(row.paths_json, null);
    if (!Array.isArray(allowedPaths)) deny("grant_invalid", "Run Grant path scope is invalid");
    if (path) {
      const candidate = resolve(String(path));
      const permitted = allowedPaths.some((base) => {
        const root = resolve(String(base));
        const rest = relative(root, candidate);
        return candidate === root || (rest && !rest.startsWith(`..${sep}`) && rest !== ".." && !isAbsolute(rest));
      });
      if (!permitted) deny("grant_path_denied", "Run Grant does not allow the requested path", { path: candidate });
    }
    return publicGrant(row);
  }

  /**
   * Persist (or reuse) a single approval request and put the run in the
   * waiting_approval state.  The request key is stable so repeated retries
   * cannot manufacture duplicate approvals or duplicate approval events.
   */
  requestApproval(runId, request = {}) {
    const run = this.getRun(runId);
    const safeRequest = sanitizeRunMetadata({ ...request });
    const requestKey = String(safeRequest.requestKey || createHash("sha256").update(encodeJson(safeRequest) || "{}", "utf8").digest("hex"));
    safeRequest.requestKey = requestKey;
    let approval = null;
    let created = false;
    const at = this.now();
    this.db.transaction(() => {
      const pending = this.db.all("SELECT * FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at", run.id)
        .find((row) => String(decodeJson(row.request_json, {})?.requestKey || "") === requestKey);
      if (pending) {
        approval = publicApproval(pending);
      } else {
        const id = this.randomId("approval");
        this.db.run(`INSERT INTO approvals (id, run_id, effect_id, status, request_json, decision_json, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', ?, NULL, ?, ?)`, id, run.id, safeRequest.effectId || null, encodeJson(safeRequest), at, at);
        approval = publicApproval(this.db.get("SELECT * FROM approvals WHERE id = ?", id));
        created = true;
      }
      const current = this.getRun(run.id);
      if (current.status !== "waiting_approval") {
        this.db.run("UPDATE runs SET status = 'waiting_approval', next_wake_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?", at, run.id);
        this.recordEvent(run.id, "run.status", { from: current.status, status: "waiting_approval", reason: "approval_required", approvalId: approval.id });
      }
      if (created) this.recordEvent(run.id, "approval.requested", { approvalId: approval.id, effectId: approval.effectId || null, request: safeRequest });
    });
    return approval;
  }

  getEvents(runId, { after = 0, limit = 1000 } = {}) {
    return this.db.all("SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?", String(runId), Number(after || 0), Math.min(5000, Math.max(1, Number(limit || 1000))))
      .map(publicEvent);
  }

  subscribe(runId, listener) {
    const name = `run:${runId}`;
    this.events.on(name, listener);
    return () => this.events.off(name, listener);
  }

  startScheduler() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => this.events.emit("error", error)), this.schedulerIntervalMs);
    this.timer.unref?.();
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.activeTick) return this.activeTick;
    this.activeTick = this._tickSlice();
    try { return await this.activeTick; } finally { this.activeTick = null; }
  }

  async _tickSlice() {
    const nowMs = new Date(this.now()).getTime();
    const candidates = this.listRuns().filter((run) => ["queued", "running", "sleeping"].includes(run.status));
    const run = candidates.find((item) => {
      const nextWakeAt = item.nextWakeAt || item.metadata.nextWakeAt;
      return !nextWakeAt || new Date(nextWakeAt).getTime() <= nowMs;
    });
    if (!run || !this.acquireLease(run.id)) return null;
    const owner = this.workerId;
    try {
      if (budgetExhausted(run, this.now())) return this._pauseForReason(run.id, "budget_exhausted");
      this.heartbeat(run.id, owner);
      if (!this._hasModelProvider()) return this._sleepWithoutProvider(run.id);
      const recovered = this._recoverCompletedModelEffect(run.id);
      if (recovered) return this._persistModelResponse(run.id, recovered);
      const response = await this._invokeModel(run.id, owner);
      return this._persistModelResponse(run.id, response);
    } catch (error) {
      if (error?.code === "context_hard_preflight") return this._pauseForReason(run.id, "context_hard_preflight");
      if (error?.code === "grant_budget_exhausted") return this._pauseForReason(run.id, "grant_budget_exhausted");
      if (error?.code === "grant_invalid") return this._pauseForReason(run.id, "grant_invalid");
      if (error?.code === "effect_reconciling") return this.getRun(run.id);
      if (isGrantApprovalCode(error?.code)) {
        this.requestApproval(run.id, {
          kind: "model.call",
          reason: error.code,
          model: error.requestedModel || run.metadata?.model || "",
          hosts: error.requestedHosts || []
        });
        return this.getRun(run.id);
      }
      return this.recordFailure(run.id, error);
    } finally {
      this.releaseLease(run.id, owner);
    }
  }

  async _invokeModel(runId, owner) {
    const run = this.getRun(runId);
    const task = run.taskId ? this.getTask(run.taskId) : null;
    const request = { run, task, now: this.now(), context: this.contextService?.assemble?.(run.workspaceId) || null };
    const provider = this.modelClient;
    const invoke = typeof provider === "function" ? provider
      : provider?.run || provider?.runSlice || provider?.invoke || provider?.complete || provider?.generate || provider?.request || provider?.call;
    if (typeof invoke !== "function") throw new Error("model provider is not callable");
    const modelRequest = provider?.generate && !provider?.run && !provider?.invoke && !provider?.complete
      ? {
        ...request,
        messages: [{ role: "user", content: task?.description || task?.title || "Continue the durable task." }],
        settings: run.metadata.settings || {},
        secrets: run.metadata.secrets || {},
        tools: run.metadata.tools || []
      }
      : request;
    const providerGrant = typeof provider?.getGrantScope === "function" ? provider.getGrantScope({ run, task, request: modelRequest }) || {} : {};
    this.assertRunGrant(runId, {
      model: providerGrant.model || resolveModelIdentity(run, provider, modelRequest),
      hosts: providerGrant.hosts || resolveModelHosts(run, provider, modelRequest)
    });
    const timer = setInterval(() => { this.heartbeat(runId, owner); }, this.heartbeatIntervalMs);
    timer.unref?.();
    const callNumber = Math.max(Number(run.attempt || 0), Number(run.metadata.modelCalls || 0) + 1);
    const effect = this.beginEffect(runId, { kind: "model.call", idempotencyKey: `model:${runId}:${callNumber}`, intent: { callNumber, model: run.metadata.model || "" } });
    if (effect.status === "completed") { clearInterval(timer); return { ...effect.result, __effectId: effect.id }; }
    if (effect.status !== "intent") {
      clearInterval(timer);
      this.reconcileUncertainEffects(runId);
      throw Object.assign(new Error("模型调用结果不确定，等待对账"), { code: "effect_reconciling" });
    }
    let response;
    try {
      response = await invoke.call(provider, modelRequest);
    } catch (error) {
      clearInterval(timer);
      const failure = error instanceof Error ? error : new Error(String(error));
      if (isUncertainModelError(failure)) {
        this.reconcileUncertainEffects(runId);
        throw Object.assign(failure, { code: "effect_reconciling" });
      }
      this.completeEffect(effect.id, { ok: false, error: { code: failure.code || "model_error", message: String(failure.message || failure).slice(0, 2000) } });
      throw failure;
    }
    try {
      const durable = this._durableModelResult(run, callNumber, response);
      this.completeEffect(effect.id, durable.result, durable.checksum);
      return { ...durable.result, __effectId: effect.id };
    } catch (error) {
      this.reconcileUncertainEffects(runId);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "effect_reconciling" });
    } finally { clearInterval(timer); }
  }

  _recoverCompletedModelEffect(runId) {
    const run = this.getRun(runId);
    const expectedCall = Number(run.metadata.modelCalls || 0) + 1;
    const effect = this.db.all("SELECT * FROM effects WHERE run_id = ? AND kind = 'model.call' AND status = 'completed' ORDER BY updated_at DESC", runId)
      .map(publicEffect)
      .find((item) => Number(item.intent?.callNumber || 0) === expectedCall && item.result?.ok !== false);
    if (!effect) return null;
    return { ...(effect.result || {}), __effectId: effect.id };
  }

  _durableModelResult(run, callNumber, response) {
    const raw = response && typeof response === "object" ? response : { text: String(response ?? "") };
    const serialized = JSON.stringify(raw);
    const estimatedTokens = Math.max(Number(raw.usage?.outputTokens || raw.usage?.output_tokens || 0), Math.ceil(Buffer.byteLength(serialized, "utf8") / 4));
    let block = null;
    if (this.contextService?.registerBlock && run.workspaceId) {
      block = this.contextService.registerBlock(run.workspaceId, {
        type: "model_result",
        stableKey: `model:${callNumber}`,
        source: "model",
        summary: String(raw.text || raw.output || "模型响应").slice(0, 500),
        payload: raw,
        tokenEstimate: estimatedTokens,
        resultTokens: estimatedTokens,
        metadata: { completeness: "complete", callNumber }
      });
    }
    if (block?.offloaded) {
      return {
        checksum: block.checksum || "",
        result: {
          text: block.summary,
          model: raw.model || "",
          usage: raw.usage || {},
          progressMade: raw.progressMade === true,
          checkpoint: raw.checkpoint || null,
          status: raw.status || "sleeping",
          nextWakeAt: raw.nextWakeAt,
          externalized: { blockId: block.id, payloadRef: block.payloadRef, checksum: block.checksum, tokenEstimate: block.tokenEstimate }
        }
      };
    }
    const result = { ...raw, contextBlockId: block?.id || "" };
    return { checksum: block?.checksum || createHash("sha256").update(encodeJson(result) || "null", "utf8").digest("hex"), result };
  }

  _hasModelProvider() {
    if (typeof this.modelClient?.isConfigured === "function") return this.modelClient.isConfigured() === true;
    if (typeof this.modelClient === "function") return true;
    return Boolean(this.modelClient && ["run", "runSlice", "invoke", "complete", "generate", "request", "call"].some((name) => typeof this.modelClient[name] === "function"));
  }

  _sleepWithoutProvider(runId) {
    const at = this.now();
    const nextWakeAt = new Date(new Date(at).getTime() + 15 * 60_000).toISOString();
    const current = this.getRun(runId);
    const metadata = { ...current.metadata, nextWakeAt, sleepingReason: "model_not_configured" };
    this.db.transaction(() => {
      this.db.run("UPDATE runs SET status = 'sleeping', metadata_json = ?, next_wake_at = ?, updated_at = ? WHERE id = ?", encodeJson(metadata), nextWakeAt, at, runId);
      this.recordEvent(runId, "run.status", { status: "sleeping", reason: "model_not_configured", nextWakeAt });
    });
    return this.getRun(runId);
  }

  _persistModelResponse(runId, rawResponse = {}) {
    const response = normalizeModelResponse(rawResponse);
    if (response.error || response.ok === false) {
      const error = response.error instanceof Error
        ? response.error
        : new Error(String(response.error?.message || response.message || response.error || "model response failed"));
      return this.recordFailure(runId, error);
    }
    const usage = {
      ...(response.usage || {}),
      inputTokens: response.usage?.inputTokens ?? response.usage?.input_tokens ?? response.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? response.usage?.output_tokens ?? response.outputTokens ?? 0,
      estimatedUsd: response.usage?.estimatedUsd ?? response.usage?.estimated_usd ?? response.estimatedUsd ?? response.estimatedCost,
      progressMade: response.progressMade ?? response.verifiedProgress ?? response.progress ?? Boolean(response.checkpoint),
      checkpoint: response.checkpoint,
      response: response.text ?? response.output ?? null
    };
    usage.effectId = response.__effectId || "";
    let usageResult;
    this.db.transaction(() => {
      usageResult = this.recordModelUsage(runId, usage);
      const current = usageResult.run;
      if (current.status === "paused") return;
      const at = this.now();
      const nextWakeAt = response.nextWakeAt
        ? normalizeTimestamp(response.nextWakeAt)
        : new Date(new Date(at).getTime() + 15 * 60_000).toISOString();
      const requestedStatus = response.status && RUN_STATUSES.has(response.status) ? response.status : "sleeping";
      const metadata = { ...current.metadata, nextWakeAt, lastResponseAt: at };
      this.db.run("UPDATE runs SET status = ?, metadata_json = ?, next_wake_at = ?, updated_at = ? WHERE id = ?", requestedStatus, encodeJson(metadata), nextWakeAt, at, runId);
      this.recordEvent(runId, "run.status", { status: requestedStatus, reason: "model_response", nextWakeAt });
    });
    if (usageResult.run.status === "paused") return usageResult.run;
    return this.getRun(runId);
  }

  recordFailure(id, error, { failureSignature = "" } = {}) {
    const run = this.getRun(id);
    const at = this.now();
    const signature = String(failureSignature || error?.code || error?.message || error || "unknown_failure").slice(0, 500);
    const sameFailure = run.metadata.failureSignature === signature;
    const autoRepairAttempts = sameFailure ? Number(run.metadata.autoRepairAttempts || 0) + 1 : 1;
    const retryAttempt = Number(run.metadata.retryAttempt || 0) + 1;
    const pause = autoRepairAttempts >= this.autoRepairLimit;
    const delay = this.backoffDelaysMs[Math.min(Math.max(0, retryAttempt - 1), this.backoffDelaysMs.length - 1)] || 0;
    const nextWakeAt = pause ? null : new Date(new Date(at).getTime() + delay).toISOString();
    const metadata = {
      ...run.metadata,
      failureSignature: signature,
      autoRepairAttempts,
      repairAttempts: autoRepairAttempts,
      retryAttempt,
      lastError: signature,
      lastErrorAt: at,
      nextWakeAt,
      retryAt: nextWakeAt,
      backoffMs: pause ? 0 : delay,
      pauseReason: pause ? "repeated_failure" : null
    };
    const status = pause ? "paused" : "sleeping";
    this.db.transaction(() => {
      this.db.run("UPDATE runs SET status = ?, metadata_json = ?, next_wake_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?", status, encodeJson(metadata), nextWakeAt, at, id);
      this.recordEvent(id, "run.error", { message: signature, retryAttempt, autoRepairAttempts, nextWakeAt });
      this.recordEvent(id, "run.status", { status, reason: pause ? "repeated_failure" : "backoff", nextWakeAt });
    });
    return this.getRun(id);
  }

  failRun(id, error, options) {
    return this.recordFailure(id, error, options);
  }

  _pauseForReason(id, reason) {
    const at = this.now();
    const run = this.getRun(id);
    const metadata = { ...run.metadata, pauseReason: reason, nextWakeAt: null };
    this.db.transaction(() => {
      this.db.run("UPDATE runs SET status = 'paused', metadata_json = ?, next_wake_at = NULL, updated_at = ? WHERE id = ?", encodeJson(metadata), at, id);
      this.recordEvent(id, "run.status", { status: "paused", reason });
    });
    return this.getRun(id);
  }
}

function normalizeBudget(input = {}, { allowUnsafe = false, strict = true } = {}) {
  const clamp = (key, minimum) => {
    const raw = input[key] ?? DEFAULT_RUN_BUDGET[key];
    const number = Number(raw);
    if ((!Number.isFinite(number) || number < minimum) && strict && input[key] !== undefined) {
      throw Object.assign(new Error(`运行预算无效: ${key}`), { statusCode: 400, code: "invalid_run_budget" });
    }
    const requested = Number.isFinite(number) ? Math.max(minimum, number) : DEFAULT_RUN_BUDGET[key];
    if (key === "maxEstimatedUsd" && !allowUnsafe && input[key] !== undefined && requested === 0) return DEFAULT_RUN_BUDGET.maxEstimatedUsd;
    return allowUnsafe ? requested : Math.min(requested, DEFAULT_RUN_BUDGET[key]);
  };
  return {
    durationHours: clamp("durationHours", 1),
    maxModelCalls: clamp("maxModelCalls", 1),
    maxInputTokens: clamp("maxInputTokens", 1),
    maxOutputTokens: clamp("maxOutputTokens", 1),
    maxEstimatedUsd: clamp("maxEstimatedUsd", 0),
    enforced: allowUnsafe ? input.enforced !== false : true
  };
}

function budgetExhausted(run, nowValue = nowIso()) {
  if (!run.budget.enforced) return false;
  const used = run.metadata;
  const ageMs = new Date(normalizeTimestamp(nowValue)).getTime() - new Date(run.createdAt).getTime();
  return nonNegativeInteger(used.modelCalls) >= run.budget.maxModelCalls
    || nonNegativeInteger(used.inputTokens) >= run.budget.maxInputTokens
    || nonNegativeInteger(used.outputTokens) >= run.budget.maxOutputTokens
    || (run.budget.maxEstimatedUsd > 0 && nonNegativeNumber(used.estimatedUsd) >= run.budget.maxEstimatedUsd)
    || ageMs >= run.budget.durationHours * 60 * 60_000;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  if (number === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(number, Number.MAX_SAFE_INTEGER);
}

function nonNegativeInteger(value) {
  return Math.floor(nonNegativeNumber(value));
}

function boundedAdd(left, right) {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function publicProject(row) {
  return { id: row.id, name: row.name, description: row.description, status: row.status, metadata: sanitizeRunMetadata(decodeJson(row.metadata_json, {})), createdAt: row.created_at, updatedAt: row.updated_at };
}
function publicTask(row) {
  const metadata = sanitizeRunMetadata(decodeJson(row.metadata_json, {}));
  return { id: row.id, projectId: row.project_id, title: row.title, description: row.description, status: row.status, priority: row.priority, metadata, acceptanceCriteria: metadata.acceptanceCriteria || [], constraints: metadata.constraints || [], createdAt: row.created_at, updatedAt: row.updated_at };
}
function publicRun(row) {
  const metadata = sanitizeRunMetadata(decodeJson(row.metadata_json, {}));
  if (metadata.modelCalls === undefined && row.model_calls !== undefined) metadata.modelCalls = Number(row.model_calls || 0);
  if (metadata.inputTokens === undefined && row.input_tokens !== undefined) metadata.inputTokens = Number(row.input_tokens || 0);
  if (metadata.outputTokens === undefined && row.output_tokens !== undefined) metadata.outputTokens = Number(row.output_tokens || 0);
  if (metadata.estimatedUsd === undefined && row.estimated_cost !== undefined) metadata.estimatedUsd = Number(row.estimated_cost || 0);
  if (metadata.checkpointSeq === undefined && row.checkpoint_seq !== undefined) metadata.checkpointSeq = Number(row.checkpoint_seq || 0);
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    status: row.status,
    workspaceId: row.workspace_id,
    leaseOwner: row.lease_owner || "",
    leaseExpiresAt: row.lease_expires_at || "",
    heartbeatAt: row.heartbeat_at || "",
    nextWakeAt: row.next_wake_at || metadata.nextWakeAt || null,
    attempt: Number(row.attempt || 0),
    modelCalls: Number(row.model_calls ?? metadata.modelCalls ?? 0),
    inputTokens: Number(row.input_tokens ?? metadata.inputTokens ?? 0),
    outputTokens: Number(row.output_tokens ?? metadata.outputTokens ?? 0),
    estimatedCost: Number(row.estimated_cost ?? metadata.estimatedUsd ?? 0),
    checkpointSeq: Number(row.checkpoint_seq ?? metadata.checkpointSeq ?? 0),
    worktreePath: row.worktree_path || metadata.worktreePath || "",
    branch: row.branch || metadata.branch || "",
    budget: normalizeBudget(decodeJson(row.budget_json, {}), { allowUnsafe: true, strict: false }),
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function publicEvent(row) {
  return { id: row.id, runId: row.run_id, type: row.type, payload: sanitizeRunMetadata(decodeJson(row.payload_json, {})), sequence: Number(row.sequence || 0), createdAt: row.created_at };
}
function publicEffect(row) {
  return { id: row.id, runId: row.run_id, idempotencyKey: row.idempotency_key || "", kind: row.kind, status: row.status, intent: sanitizeRunMetadata(decodeJson(row.intent_json, {})), result: sanitizeRunMetadata(decodeJson(row.result_json, null)), checksum: row.checksum || "", createdAt: row.created_at, updatedAt: row.updated_at };
}
function publicApproval(row) {
  return row ? {
    id: row.id,
    runId: row.run_id,
    effectId: row.effect_id || "",
    status: row.status,
    request: sanitizeRunMetadata(decodeJson(row.request_json, {})),
    decision: sanitizeRunMetadata(decodeJson(row.decision_json, {})),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}
function publicGrant(row) {
  return row ? {
    id: row.id,
    runId: row.run_id,
    paths: decodeJson(row.paths_json, []),
    commands: decodeJson(row.commands_json, []),
    network: decodeJson(row.network_json, []),
    model: row.model || "",
    expiresAt: row.expires_at || "",
    budget: decodeJson(row.budget_json, {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}
function terminalStatus(status) { return ["completed", "failed", "canceled"].includes(status); }
function defaultId(prefix = "id") { return `${prefix}_${randomUUID()}`; }
function notFound(message) { return Object.assign(new Error(message), { statusCode: 404 }); }

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  const text = String(value ?? "");
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function isVerifiableProgress(input = {}) {
  if (input.progressMade === true || input.verifiedProgress === true || input.progress === true) return true;
  if (input.progress && typeof input.progress === "object" && (input.progress.verified === true || input.progress.made === true)) return true;
  if (input.validation && typeof input.validation === "object" && (input.validation.passed === true || input.validation.verified === true)) return true;
  return Boolean(input.checkpoint || input.checkpointSeq || input.commit || input.testPassed || input.testsPassed || input.acceptancePassed || input.verified === true || input.completedStep);
}

function normalizeModelResponse(response) {
  if (typeof response === "string") return { text: response };
  if (!response || typeof response !== "object") return { output: response };
  return response;
}

function sanitizeRunMetadata(input) {
  if (Array.isArray(input)) return input.map(sanitizeRunMetadata);
  if (!input || typeof input !== "object") return input;
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["apikey", "token", "accesstoken", "refreshtoken", "secret", "secrets", "password", "authorization", "privatekey"].includes(normalized)) continue;
    output[key] = sanitizeRunMetadata(value);
  }
  return output;
}

function isUncertainModelError(error) {
  return error?.code === "model_network_error" || error?.name === "AbortError" || ["ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(error?.code);
}

function normalizeGrantHost(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  try { return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase(); } catch { return raw.replace(/^[*.]+/, ""); }
}

function grantHostMatches(host, domain) {
  const normalizedHost = normalizeGrantHost(host);
  const normalizedDomain = String(domain || "").trim().toLowerCase();
  if (!normalizedHost || !normalizedDomain) return false;
  if (normalizedDomain.startsWith("*.")) {
    const suffix = normalizedDomain.slice(1);
    return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
  }
  return normalizedHost === normalizeGrantHost(normalizedDomain);
}

function normalizeGrantCommand(value) {
  return String(Array.isArray(value) ? value[0] : value || "")
    .trim().split(/\s+/)[0].replace(/^.*[\\/]/, "").toLowerCase();
}

function resolveModelIdentity(run, provider, request) {
  return String(
    request?.settings?.model
      || request?.model
      || run?.metadata?.settings?.model
      || run?.metadata?.model
      || provider?.model
      || provider?.settings?.model
      || ""
  ).trim();
}

function resolveModelHosts(run, provider, request) {
  const values = [
    request?.settings?.apiBaseUrl,
    request?.settings?.endpoint,
    request?.apiBaseUrl,
    request?.endpoint,
    run?.metadata?.settings?.apiBaseUrl,
    run?.metadata?.apiBaseUrl,
    provider?.apiBaseUrl,
    provider?.endpoint
  ].filter(Boolean);
  const hosts = [];
  for (const value of values) {
    try { hosts.push(new URL(String(value)).hostname); } catch { /* the provider adapter performs its own endpoint validation */ }
  }
  return [...new Set(hosts.map(normalizeGrantHost).filter(Boolean))];
}

function isGrantApprovalCode(code) {
  return ["grant_required", "grant_expired", "grant_model_denied", "grant_network_denied", "grant_command_denied", "grant_path_denied"].includes(String(code || ""));
}
