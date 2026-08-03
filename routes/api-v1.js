import { readJsonBody, sendJson, openEventStream } from "../core/http.js";
import { createHash } from "node:crypto";
import net from "node:net";
import { resolve } from "node:path";
import { normalizeModelSettings, resolveModelProfile } from "../services/model-provider-service.js";
import { rebuildKnowledgeIndex, searchKnowledge, indexStatus } from "../services/rag-service.js";
import { sanitizeSecretObject } from "../core/app-repository.js";

const APPROVABLE_COMMANDS = new Set(["node", "node.exe", "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "dotnet"]);

export async function tryHandleApiV1(ctx) {
  const { req, res, url, rootDir, runner, repo, db, contextService, session, modelClient, riskStore, secrets = {} } = ctx;
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/v1/")) return false;

  if (req.method === "GET" && pathname === "/api/v1/bootstrap") {
    const auth = session.bootstrap(req, res);
    const projects = runner.listProjects();
    const tasks = runner.listTasks();
    const runs = runner.listRuns();
    const activeRun = runs.find((run) => !["completed", "failed", "canceled"].includes(run.status)) || runs[0] || null;
    const events = activeRun ? runner.getEvents(activeRun.id, { limit: 200 }).map(toTimelineEvent) : [];
    const dashboard = activeRun ? contextService.getDashboard(activeRun.workspaceId) : null;
    const approvals = activeRun
      ? db.all("SELECT * FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC", activeRun.id).map(publicApproval)
      : [];
    sendJson(res, 200, {
      ok: true,
      app: "local-claude-workbench",
      version: "0.2.0",
      csrfToken: auth.csrfToken,
      settings: publicSettings(repo.getSettings()),
      capabilities: repo.getSettings().capabilities,
      projects,
      tasks,
      runs,
      activeRun,
      timeline: events,
      context: dashboard,
      vista: toVista(dashboard, activeRun, approvals),
      connected: true
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/v1/projects") {
    sendJson(res, 200, { projects: runner.listProjects() }); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/projects") {
    const body = await readJsonBody(req);
    const response = await idempotent(db, req, "projects.create", () => ({ project: runner.createProject(body) }));
    sendJson(res, response.cached ? response.statusCode : 201, response.value); return true;
  }

  if (req.method === "GET" && pathname === "/api/v1/tasks") {
    sendJson(res, 200, { tasks: runner.listTasks({ projectId: url.searchParams.get("projectId") || "", status: url.searchParams.get("status") || "" }) }); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/tasks") {
    const body = await readJsonBody(req);
    const response = await idempotent(db, req, "tasks.create", () => ({ task: runner.createTask(body) }));
    sendJson(res, response.cached ? response.statusCode : 201, response.value); return true;
  }

  const taskRunMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/runs$/);
  if (req.method === "POST" && taskRunMatch) {
    const body = await readJsonBody(req);
    const taskId = decodeURIComponent(taskRunMatch[1]);
    const runInput = { ...body, __budgetConfirmed: false };
    delete runInput.confirmationToken;
    if (requiresBudgetConfirmation(body.budget)) {
      const detail = { taskId, budget: body.budget };
      riskStore.consume({ token: body.confirmationToken, action: "run.budget.expand", detail });
      runInput.__budgetConfirmed = true;
    }
    const response = await idempotent(db, req, `tasks.${taskRunMatch[1]}.runs`, () => {
      return db.transaction(() => {
        const run = runner.startRun(taskId, runInput);
        ensureBaseRunGrant(db, repo, run, rootDir);
        return { run };
      });
    });
    sendJson(res, response.cached ? response.statusCode : 201, response.value); return true;
  }

  if (req.method === "POST" && pathname === "/api/v1/runs") {
    const body = await readJsonBody(req);
    let budgetConfirmed = false;
    if (requiresBudgetConfirmation(body.budget)) {
      const detail = { title: String(body.title || body.goal || body.task || body.prompt || "CLI 任务").slice(0, 240), budget: body.budget };
      riskStore.consume({ token: body.confirmationToken, action: "run.budget.expand", detail });
      budgetConfirmed = true;
    }
    const response = await idempotent(db, req, "runs.create", () => db.transaction(() => {
      const title = String(body.title || body.goal || body.task || body.prompt || "CLI 任务").slice(0, 240);
      const task = runner.createTask({ projectId: body.projectId, title, description: String(body.description || body.prompt || ""), acceptanceCriteria: body.acceptanceCriteria, constraints: body.constraints, metadata: body.metadata });
      const run = runner.startRun(task.id, { budget: body.budget, tokenLimit: body.tokenLimit, metadata: body.runMetadata, __budgetConfirmed: budgetConfirmed });
      ensureBaseRunGrant(db, repo, run, rootDir);
      return { task, run };
    }));
    sendJson(res, response.cached ? response.statusCode : 201, response.value); return true;
  }
  if (req.method === "GET" && pathname === "/api/v1/runs") {
    sendJson(res, 200, { runs: runner.listRuns({ status: url.searchParams.get("status") || "", taskId: url.searchParams.get("taskId") || "" }) }); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/runs/pause-all") {
    sendJson(res, 200, { runs: runner.pauseAll("desktop") }); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/runs/resume-all") {
    sendJson(res, 200, { runs: runner.resumeAll() }); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/runs/checkpoint-all") {
    sendJson(res, 200, { runs: runner.checkpointAll() }); return true;
  }

  const runMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
  if (req.method === "GET" && runMatch) {
    sendJson(res, 200, { run: runner.getRun(decodeURIComponent(runMatch[1])) }); return true;
  }
  const runActionMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/(pause|resume|cancel|wake|checkpoint)$/);
  if (req.method === "POST" && runActionMatch) {
    const runId = decodeURIComponent(runActionMatch[1]);
    const actions = {
      pause: () => runner.pauseRun(runId), resume: () => runner.resumeRun(runId), cancel: () => runner.cancelRun(runId),
      wake: () => runner.wakeRun(runId), checkpoint: () => runner.checkpoint(runId, "manual")
    };
    sendJson(res, 200, { run: actions[runActionMatch[2]]() }); return true;
  }

  const effectReconcileMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/effects\/([^/]+)\/reconcile$/);
  if (req.method === "POST" && effectReconcileMatch) {
    const runId = decodeURIComponent(effectReconcileMatch[1]);
    const effectId = decodeURIComponent(effectReconcileMatch[2]);
    runner.getRun(runId);
    const body = await readJsonBody(req);
    const existingEffect = runner.getEffect(effectId);
    if (existingEffect.runId !== runId) throw Object.assign(new Error("副作用不属于该运行"), { statusCode: 404, code: "effect_not_found" });
    const resultChecksum = createHash("sha256").update(JSON.stringify(body.result || {})).digest("hex");
    const detail = { runId, effectId, decision: body.decision, resultChecksum, checksum: body.checksum || "" };
    riskStore.consume({ token: body.confirmationToken, action: "effect.reconcile", detail });
    const effect = runner.resolveEffect(effectId, { decision: body.decision, result: body.result || {}, checksum: body.checksum || "" });
    const unresolved = Number(db.get("SELECT count(*) AS count FROM effects WHERE run_id = ? AND status = 'uncertain'", runId)?.count || 0);
    const run = unresolved === 0 ? runner.resumeRun(runId) : runner.getRun(runId);
    sendJson(res, 200, { effect, run, unresolved }); return true;
  }

  const eventsMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/events$/);
  if (req.method === "GET" && eventsMatch) {
    const after = Number(url.searchParams.get("after") || req.headers["last-event-id"] || 0);
    sendJson(res, 200, { events: runner.getEvents(decodeURIComponent(eventsMatch[1]), { after }) }); return true;
  }
  const streamMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/stream$/);
  if (req.method === "GET" && streamMatch) {
    const runId = decodeURIComponent(streamMatch[1]);
    runner.getRun(runId);
    const after = Number(url.searchParams.get("after") || req.headers["last-event-id"] || 0);
    openEventStream(req, res, {
      getInitialEvents: () => runner.getEvents(runId, { after }).map(toTimelineEvent),
      subscribe: (write) => runner.subscribe(runId, (event) => write(toTimelineEvent(event)))
    });
    return true;
  }

  const contextMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/context$/);
  if (req.method === "GET" && contextMatch) {
    const run = runner.getRun(decodeURIComponent(contextMatch[1]));
    sendJson(res, 200, { context: contextService.getDashboard(run.workspaceId) }); return true;
  }
  const contextActionMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/context\/actions$/);
  if (req.method === "POST" && contextActionMatch) {
    const run = runner.getRun(decodeURIComponent(contextActionMatch[1]));
    const body = await readJsonBody(req);
    const blockIds = (Array.isArray(body.blockIds) ? body.blockIds : [body.blockId]).filter(Boolean).map(String);
    if (!blockIds.length) throw badRequest("需要 blockIds");
    const results = blockIds.map((blockId) => executeContextAction(contextService, run.workspaceId, blockId, body));
    const dashboard = contextService.getDashboard(run.workspaceId);
    runner.recordEvent(run.id, "context.updated", { action: body.action, blockIds, pressure: dashboard.pressure });
    sendJson(res, 200, { results, context: dashboard }); return true;
  }

  if (req.method === "GET" && pathname === "/api/v1/approvals") {
    const status = url.searchParams.get("status") || "pending";
    const rows = db.all("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC", status);
    sendJson(res, 200, { approvals: rows.map(publicApproval) }); return true;
  }
  const approvalMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/approvals\/([^/]+)$/);
  if (req.method === "POST" && approvalMatch) {
    const body = await readJsonBody(req);
    const runId = decodeURIComponent(approvalMatch[1]);
    const approvalId = decodeURIComponent(approvalMatch[2]);
    const run = runner.getRun(runId);
    const row = db.get("SELECT * FROM approvals WHERE id = ? AND run_id = ?", approvalId, run.id);
    if (!row) throw Object.assign(new Error("审批不存在"), { statusCode: 404, code: "approval_not_found" });
    if (row.status !== "pending") { sendJson(res, 200, { approval: publicApproval(row), run }); return true; }
    const allowed = ["allow", "approved", "approve"].includes(String(body.decision || "").toLowerCase());
    const rejected = ["deny", "rejected", "reject"].includes(String(body.decision || "").toLowerCase());
    if (!allowed && !rejected) throw badRequest("decision 必须为 allow 或 deny");
    const at = new Date().toISOString();
    let updatedRun;
    db.transaction(() => {
      if (allowed) applyApprovedGrant(db, run, safeJson(row.request_json), at);
      db.run("UPDATE approvals SET status = ?, decision_json = ?, updated_at = ? WHERE id = ? AND run_id = ?", allowed ? "approved" : "rejected", JSON.stringify(sanitizeSecretObject(body)), at, approvalId, run.id);
      runner.recordEvent(run.id, "approval.updated", { approvalId, status: allowed ? "approved" : "rejected" });
      const pending = Number(db.get("SELECT count(*) AS count FROM approvals WHERE run_id = ? AND status = 'pending'", run.id)?.count || 0);
      if (rejected) updatedRun = runner.pauseRun(run.id, "approval_rejected");
      else if (pending === 0 && runner.getRun(run.id).status === "waiting_approval") updatedRun = runner.resumeRun(run.id);
      else updatedRun = runner.getRun(run.id);
    });
    sendJson(res, 200, { approval: publicApproval(db.get("SELECT * FROM approvals WHERE id = ?", approvalId)), run: updatedRun }); return true;
  }

  if (req.method === "GET" && pathname === "/api/v1/settings") {
    sendJson(res, 200, { settings: publicSettings(repo.getSettings()), profile: resolveModelProfile(repo.getSettings()) }); return true;
  }
  if (req.method === "PUT" && pathname === "/api/v1/settings") {
    const body = await readJsonBody(req);
    const currentSettings = repo.getSettings();
    if (body.allowPrivateModelEndpoint === true && currentSettings.allowPrivateModelEndpoint !== true) {
      riskStore.consume({ token: body.confirmationToken, action: "settings.private_model_endpoint", detail: { endpoint: body.apiBaseUrl || currentSettings.apiBaseUrl || "" } });
    }
    if ((body.web?.allowPrivate === true && currentSettings.web?.allowPrivate !== true) || (body.image?.allowPrivate === true && currentSettings.image?.allowPrivate !== true)) {
      riskStore.consume({ token: body.confirmationToken, action: "settings.private_tool_endpoints", detail: { web: body.web?.customEndpoint || "", image: body.image?.endpoint || "" } });
    }
    const safeBody = { ...body };
    delete safeBody.confirmationToken;
    const normalized = { ...safeBody, ...normalizeModelSettings(safeBody, currentSettings) };
    sendJson(res, 200, { settings: publicSettings(repo.saveSettings(normalized)) }); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/providers/test") {
    const body = await readJsonBody(req);
    const settings = { ...repo.getSettings(), ...(body.settings || {}) };
    if (settings.allowPrivateModelEndpoint === true) {
      riskStore.consume({ token: body.confirmationToken, action: "provider.test.private_endpoint", detail: { endpoint: settings.apiBaseUrl || "" } });
    }
    const result = await modelClient.generate({ settings, secrets: { token: body.token || secrets.modelToken || providerToken(settings) }, messages: [{ role: "user", content: "Reply with OK." }] });
    sendJson(res, 200, { ok: true, provider: resolveModelProfile(settings).provider, model: result.model || settings.model, usage: result.usage }); return true;
  }

  if (req.method === "GET" && pathname === "/api/v1/conversations") {
    sendJson(res, 200, { conversations: repo.listConversations(url.searchParams.get("projectId") || "") }); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/conversations") {
    sendJson(res, 201, { conversation: repo.createConversation(await readJsonBody(req)) }); return true;
  }
  const messageMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/);
  if (req.method === "POST" && messageMatch) {
    const body = await readJsonBody(req);
    const conversationId = decodeURIComponent(messageMatch[1]);
    const userMessage = repo.addMessage(conversationId, { role: "user", content: body.content || "" });
    const settings = repo.getSettings();
    const messages = repo.listMessages(conversationId).map(({ role, content }) => ({ role, content }));
    const result = await modelClient.generate({ settings, secrets: { token: body.token || secrets.modelToken || providerToken(settings) }, messages });
    const assistantMessage = repo.addMessage(conversationId, { role: "assistant", content: result.text, metadata: { usage: result.usage } });
    sendJson(res, 200, { userMessage, assistantMessage, usage: result.usage }); return true;
  }

  if (req.method === "GET" && pathname === "/api/v1/knowledge/documents") {
    sendJson(res, 200, { documents: repo.listKnowledgeDocuments(url.searchParams.get("projectId") || "") }); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/knowledge/documents") {
    sendJson(res, 201, { document: repo.upsertKnowledgeDocument(await readJsonBody(req)) }); return true;
  }
  const docMatch = pathname.match(/^\/api\/v1\/knowledge\/documents\/([^/]+)$/);
  if (req.method === "DELETE" && docMatch) {
    sendJson(res, 200, { deleted: repo.deleteKnowledgeDocument(decodeURIComponent(docMatch[1])) }); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/knowledge/search") {
    const body = await readJsonBody(req);
    const docs = repo.listKnowledgeDocuments(body.projectId || "");
    const settings = repo.getSettings().rag;
    const index = rebuildKnowledgeIndex({ docs, settings });
    const results = searchKnowledge({ query: body.query || "", docs, index, settings, maxChunks: body.maxChunks });
    sendJson(res, 200, { results, status: indexStatus(index, docs) }); return true;
  }

  if (req.method === "GET" && pathname === "/api/v1/diagnostics") {
    const migration = db.get("SELECT max(version) AS version FROM schema_migrations");
    sendJson(res, 200, { ok: true, database: { file: db.filename, migrationVersion: Number(migration?.version || 0) }, scheduler: { running: Boolean(runner.timer), workerId: runner.workerId }, node: process.version }); return true;
  }

  const runResourceMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/(diff|tests|artifacts|commits)$/);
  if (req.method === "GET" && runResourceMatch) {
    const run = runner.getRun(decodeURIComponent(runResourceMatch[1]));
    if (runResourceMatch[2] === "artifacts") {
      const rows = db.all("SELECT * FROM artifacts WHERE run_id = ? ORDER BY updated_at DESC", run.id);
      sendJson(res, 200, { artifacts: rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind, content: row.content, metadata: sanitizeSecretObject(safeJson(row.metadata_json)), createdAt: row.created_at, updatedAt: row.updated_at })) });
    } else sendJson(res, 200, { [runResourceMatch[2]]: [], run });
    return true;
  }

  return false;
}

async function idempotent(db, req, scope, create) {
  const key = String(req.headers["idempotency-key"] || "");
  if (key) {
    const cached = db.getIdempotency(key, scope);
    if (cached) return { cached: true, statusCode: cached.status_code || 200, value: cached.response };
  }
  const value = await create();
  if (key) db.saveIdempotency(key, value, { scope, statusCode: 201 });
  return { cached: false, statusCode: 201, value };
}

function executeContextAction(service, workspaceId, blockId, body) {
  if (body.action === "archive") return service.archive(workspaceId, blockId);
  if (body.action === "recover") return body.range ? service.restoreBlock(workspaceId, blockId, { range: body.range }) : service.recover(workspaceId, blockId);
  if (body.action === "restore") return service.restoreBlock(workspaceId, blockId, { range: body.range });
  if (body.action === "pin") return service.pin(workspaceId, blockId);
  if (body.action === "unpin") return service.unpin(workspaceId, blockId);
  if (body.action === "delete") return service.delete(workspaceId, blockId, { confirm: body.confirmed === true });
  throw badRequest("不支持的上下文动作");
}

function toTimelineEvent(event) {
  const payload = event.payload || {};
  const type = timelineType(event.type, payload);
  return {
    id: event.id,
    sequence: event.sequence,
    type,
    title: timelineTitle(event.type, payload, type),
    detail: payload.reason || payload.detail || payload.message || payload.text || payload.delta || "",
    timestamp: event.createdAt,
    actor: ["tool", "test", "commit", "artifact", "diff"].includes(type) || event.type.startsWith("tool") ? "agent" : "system",
    status: timelineStatus(payload, event.type),
    rawType: event.type,
    payload
  };
}
function timelineType(rawType, payload) {
  if (["message", "plan", "tool", "approval", "diff", "test", "checkpoint", "error", "commit", "artifact"].includes(rawType)) return rawType;
  if (rawType === "run.error" || rawType === "error") return "error";
  if (rawType.startsWith("tool.")) return "tool";
  if (rawType.startsWith("approval.")) return "approval";
  if (rawType.startsWith("artifact.")) return payload.kind === "commit" ? "commit" : "artifact";
  if (rawType.startsWith("plan.")) return "plan";
  if (rawType === "diff.updated") return "diff";
  if (rawType === "test.updated" || rawType === "test.completed") return "test";
  if (rawType === "commit.created") return "commit";
  if (rawType === "step.updated") {
    const stepType = String(payload.step?.type || "").toLowerCase();
    if (stepType === "test") return "test";
    if (stepType === "commit") return "commit";
    if (stepType === "diff") return "diff";
  }
  if (rawType.startsWith("run.") || rawType === "context.updated" || rawType === "usage.updated") return "checkpoint";
  return "message";
}
function timelineTitle(type, payload, timelineType = "message") {
  if (type === "run.status") return `运行状态：${payload.status || "已更新"}`;
  if (type === "message.delta") return "模型响应";
  if (type === "run.snapshot") return "恢复点已创建";
  if (type === "tool.requested") return `请求工具：${payload.kind || "tool"}`;
  if (type === "tool.completed") return `工具完成：${payload.kind || "tool"}`;
  if (type === "context.updated") return "上下文工作区已更新";
  if (type === "usage.updated") return "模型预算已更新";
  if (type === "approval.requested" || type === "approval.updated") return "待审批动作";
  if (type === "step.updated") return String(payload.step?.title || timelineType);
  if (type === "artifact.updated" || type === "artifact.created") return timelineType === "commit" ? "提交已记录" : "产物已更新";
  if (type === "diff.updated") return "Diff 已更新";
  if (type === "test.updated" || type === "test.completed") return "测试结果已记录";
  if (type === "commit.created") return "提交已记录";
  return payload.title || type;
}
function timelineStatus(payload, rawType = "") {
  const status = String(payload.status || payload.state || payload.step?.status || "").toLowerCase();
  if (rawType.startsWith("approval.") && (!status || status === "pending")) return "warning";
  if (["failed", "error"].includes(status)) return "error";
  if (["paused", "waiting_approval", "blocked", "reconciling"].includes(status)) return "warning";
  if (["running", "queued", "sleeping"].includes(status)) return "running";
  return "success";
}
function toVista(dashboard, run, approvals = []) {
  if (!dashboard) return { blocks: [], runId: run?.id || undefined, tokenPressure: 0, tokenUsed: 0, tokenLimit: 200000, budgetUsed: 0, budgetLimit: 25, budgetCurrency: "USD", permission: "本地审阅", approvals: approvals.map(toVistaApproval) };
  return {
    runId: run?.id,
    blocks: [...dashboard.pinned, ...dashboard.blocks.filter((block) => !block.pinned), ...dashboard.archived].map((block) => ({
      id: block.id, type: normalizeVistaType(block.type), title: block.summary || block.type, summary: block.summary, pinned: block.pinned,
      status: block.archived ? "stale" : block.integrity === "verified" ? "verified" : "active", tokens: block.tokenEstimate, source: block.source,
      archived: block.archived, payloadRef: block.payloadRef, checksum: block.checksum, integrity: block.integrity, permanentPinned: block.metadata?.permanentPinned === true
    })),
    tokenPressure: dashboard.pressure.percent,
    tokenUsed: dashboard.tokenEstimate,
    tokenLimit: dashboard.workspace.tokenLimit,
    budgetUsed: Number(run?.metadata?.estimatedUsd || 0),
    budgetLimit: Number(run?.budget?.maxEstimatedUsd || 25),
    budgetCurrency: "USD",
    permission: run?.status === "waiting_approval" ? "等待审批" : "范围授权",
    approvals: approvals.map(toVistaApproval)
  };
}
function toVistaApproval(approval) {
  const request = approval?.request && typeof approval.request === "object" ? approval.request : {};
  const action = String(request.action || request.kind || approval?.effectId || "").toLowerCase();
  const requestedRisk = String(request.risk || request.riskLevel || "").toLowerCase();
  const risk = ["low", "medium", "high"].includes(requestedRisk)
    ? requestedRisk
    : /delete|terminal|commit|push|budget|network|private|write/.test(action) ? "high" : "medium";
  return {
    ...approval,
    title: String(request.title || request.label || request.action || request.kind || "待审批动作"),
    risk
  };
}

function applyApprovedGrant(db, run, request, at) {
  const requested = request?.grant && typeof request.grant === "object" ? request.grant : request || {};
  const current = db.get("SELECT * FROM grants WHERE run_id = ? ORDER BY updated_at DESC LIMIT 1", run.id);
  const values = (raw) => Array.isArray(raw) ? raw.map(String).map((item) => item.trim()).filter(Boolean) : [];
  const worktreePath = run.metadata?.worktreePath ? resolve(String(run.metadata.worktreePath)) : "";
  const requestedPaths = [...values(requested.paths), requested.path].filter(Boolean).map((item) => resolve(String(item)));
  if (requestedPaths.some((item) => !worktreePath || item !== worktreePath)) throw Object.assign(new Error("Approved path must be the run worktree"), { statusCode: 403, code: "approval_scope_invalid" });
  const paths = [...new Set([...values(current ? safeJson(current.paths_json) : []), ...requestedPaths].map((item) => resolve(String(item))))];
  const requestedCommands = [...values(requested.commands), requested.command].filter(Boolean).map((item) => String(item).trim().split(/\s+/)[0].replace(/^.*[\\/]/, "").toLowerCase());
  if (requestedCommands.some((item) => !APPROVABLE_COMMANDS.has(item))) throw Object.assign(new Error("Approved command is outside the safe command allowlist"), { statusCode: 403, code: "approval_scope_invalid" });
  const commands = [...new Set([...values(current ? safeJson(current.commands_json) : []), ...requestedCommands].map((item) => String(item).toLowerCase()))];
  const requestedHosts = [...values(requested.hosts), ...values(requested.network)].map((item) => String(item).toLowerCase());
  const hostPattern = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
  const privateHost = (host) => net.isIP(host) || host === "localhost" || host.endsWith(".local");
  if (requestedHosts.some((host) => (privateHost(host) && requested.allowPrivate !== true) || (!privateHost(host) && !hostPattern.test(host)))) {
    throw Object.assign(new Error("Approved network scope must be a public domain"), { statusCode: 403, code: "approval_scope_invalid" });
  }
  const network = [...new Set([...values(current ? safeJson(current.network_json) : []), ...requestedHosts].map((item) => String(item).toLowerCase()))];
  const model = String(requested.model || current?.model || "").trim();
  const maximumExpiry = new Date(new Date(run.createdAt).getTime() + Number(run.budget.durationHours || 72) * 60 * 60_000).toISOString();
  const expiresAt = request?.reason === "grant_expired" || !current?.expires_at ? maximumExpiry : current.expires_at;
  const budget = current?.budget_json || JSON.stringify(run.budget);
  const id = current?.id || `grant_${createHash("sha256").update(run.id).digest("hex").slice(0, 16)}`;
  db.run(`INSERT INTO grants (id, run_id, paths_json, commands_json, network_json, model, expires_at, budget_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(id) DO UPDATE SET paths_json=excluded.paths_json, commands_json=excluded.commands_json,
      network_json=excluded.network_json, model=excluded.model, expires_at=excluded.expires_at,
      budget_json=excluded.budget_json, status='active', updated_at=excluded.updated_at`,
  id, run.id, JSON.stringify(paths), JSON.stringify(commands), JSON.stringify(network), model, expiresAt, budget, current?.created_at || at, at);
  db.recordAudit("grant.approved", { approvalAction: request?.action || request?.kind || "", paths, commands, network, model }, { runId: run.id, actor: "local-session", entityType: "grant", entityId: id });
}
function normalizeVistaType(type) {
  if (["goal", "task_goal"].includes(type)) return "goal";
  if (type === "acceptance") return "acceptance";
  if (["constraint", "constraints"].includes(type)) return "constraint";
  if (type.includes("tool")) return "tool";
  if (type.includes("result")) return "result";
  if (type.includes("memory")) return "memory";
  return "context";
}
function publicSettings(settings) {
  return sanitizeSecretObject(settings);
}
function publicApproval(row) { return row ? { id: row.id, runId: row.run_id, effectId: row.effect_id, status: row.status, request: sanitizeSecretObject(safeJson(row.request_json)), decision: sanitizeSecretObject(safeJson(row.decision_json)), createdAt: row.created_at, updatedAt: row.updated_at } : null; }
function safeJson(value) { try { return value ? JSON.parse(value) : {}; } catch { return {}; } }
function providerToken(settings) {
  if (settings.modelProvider === "anthropic") return process.env.ANTHROPIC_API_KEY || "";
  if (settings.modelProvider === "gemini") return process.env.GEMINI_API_KEY || "";
  if (settings.modelProvider === "deepseek") return process.env.DEEPSEEK_API_KEY || "";
  return process.env.OPENAI_API_KEY || "";
}
function ensureBaseRunGrant(db, repo, run, rootDir) {
  const existing = db.get("SELECT id FROM grants WHERE run_id = ? AND status = 'active'", run.id);
  if (existing) return;
  const settings = repo.getSettings();
  const at = new Date().toISOString();
  const expiresAt = new Date(new Date(run.createdAt).getTime() + run.budget.durationHours * 60 * 60_000).toISOString();
  const hostname = modelHostname(settings);
  db.run(`INSERT INTO grants (id, run_id, paths_json, commands_json, network_json, model, expires_at, budget_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`, `grant_${cryptoId()}`, run.id, JSON.stringify([]), JSON.stringify([]), JSON.stringify(hostname ? [hostname] : []), String(settings.model || ""), expiresAt, JSON.stringify(run.budget), at, at);
  db.recordAudit("grant.created", { root: rootDir, model: settings.model || "", network: hostname ? [hostname] : [] }, { runId: run.id, entityType: "grant" });
}
function requiresBudgetConfirmation(budget) {
  if (!budget || typeof budget !== "object") return false;
  const defaults = { durationHours: 72, maxModelCalls: 288, maxInputTokens: 12_000_000, maxOutputTokens: 2_000_000, maxEstimatedUsd: 25 };
  return budget.enforced === false
    || Number(budget.maxEstimatedUsd) === 0
    || Object.entries(defaults).some(([key, maximum]) => Number(budget[key] ?? maximum) > maximum);
}
function modelHostname(settings) {
  try {
    if (settings.apiBaseUrl) return new URL(settings.apiBaseUrl).hostname.toLowerCase();
  } catch { return ""; }
  if (settings.modelProvider === "anthropic") return "api.anthropic.com";
  if (settings.modelProvider === "gemini") return "generativelanguage.googleapis.com";
  if (settings.modelProvider === "deepseek") return "api.deepseek.com";
  return "api.openai.com";
}
function cryptoId() { return `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`; }
function badRequest(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
