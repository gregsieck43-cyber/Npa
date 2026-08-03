import { readJsonBody, sendJson } from "../core/http.js";
import { decodeJson, encodeJson } from "../core/database.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sanitizeSecretObject } from "../core/app-repository.js";

const DEFAULT_COMMANDS = ["node", "node.exe", "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "dotnet"];

export async function tryHandleDevApi(ctx) {
  const { req, res, url, db, repo, runner, worktreeService } = ctx;
  if (!worktreeService || !url.pathname.startsWith("/api/v1/runs/")) return false;
  const worktreeMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/worktree$/);
  const grantMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/grant$/);
  const resourceMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/(diff|tests|commits)$/);

  if (worktreeMatch && req.method === "POST") {
    const run = runner.getRun(decodeURIComponent(worktreeMatch[1]));
    const body = await readJsonBody(req);
    const outcome = await effectOnce(runner, run.id, req, "worktree.create", { baseRef: body.baseRef || "HEAD" }, async () => {
      const worktree = await worktreeService.createWorktree({ runId: run.id, baseRef: body.baseRef || "HEAD", shortId: body.shortId || "" });
      const metadata = { ...run.metadata, worktreePath: worktree.path, branch: worktree.branch };
      db.run("UPDATE runs SET metadata_json = ?, updated_at = ? WHERE id = ?", encodeJson(metadata), new Date().toISOString(), run.id);
      ensureGrant(db, repo, runner.getRun(run.id), worktree);
      runner.recordEvent(run.id, "artifact.updated", { kind: "worktree", path: worktree.path, branch: worktree.branch });
      return { worktree, run: runner.getRun(run.id) };
    });
    sendJson(res, 201, outcome); return true;
  }
  if (worktreeMatch && req.method === "GET") {
    const run = runner.getRun(decodeURIComponent(worktreeMatch[1]));
    if (!run.metadata.worktreePath) { sendJson(res, 200, { worktree: null, run }); return true; }
    sendJson(res, 200, { worktree: await worktreeService.status(run.id), run }); return true;
  }

  if (grantMatch && req.method === "GET") {
    const run = runner.getRun(decodeURIComponent(grantMatch[1]));
    const row = db.get("SELECT * FROM grants WHERE run_id = ? ORDER BY updated_at DESC LIMIT 1", run.id);
    sendJson(res, 200, { grant: publicGrant(row), run }); return true;
  }
  if (grantMatch && req.method === "PUT") {
    const run = runner.getRun(decodeURIComponent(grantMatch[1]));
    const body = await readJsonBody(req);
    const current = db.get("SELECT * FROM grants WHERE run_id = ? ORDER BY updated_at DESC LIMIT 1", run.id);
    const id = current?.id || makeId("grant");
    const at = new Date().toISOString();
    const expiresAt = body.expiresAt || current?.expires_at || new Date(Date.now() + Math.min(72, Math.max(1, Number(body.durationHours || 72))) * 60 * 60_000).toISOString();
    const paths = validateGrantPaths(normalizeStrings(body.paths, current ? decodeJson(current.paths_json, []) : [run.metadata.worktreePath].filter(Boolean)), run);
    const commands = validateGrantCommands(normalizeStrings(body.commands, current ? decodeJson(current.commands_json, []) : DEFAULT_COMMANDS));
    const network = validateGrantNetwork(normalizeStrings(body.network, current ? decodeJson(current.network_json, []) : []));
    const maximumExpiry = new Date(new Date(run.createdAt).getTime() + run.budget.durationHours * 60 * 60_000).getTime();
    const expiryMs = new Date(expiresAt).getTime();
    if (!Number.isFinite(expiryMs)) throw Object.assign(new Error("Run Grant 期限无效"), { statusCode: 400, code: "invalid_grant_expiry" });
    if (expiryMs > maximumExpiry) throw Object.assign(new Error("Run Grant 期限不能超过运行预算"), { statusCode: 403, code: "grant_duration_exceeded" });
    const grantBudget = constrainGrantBudget(body.budget || (current ? decodeJson(current.budget_json, {}) : run.budget), run.budget);
    db.run(`INSERT INTO grants (id, run_id, paths_json, commands_json, network_json, model, expires_at, budget_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET paths_json=excluded.paths_json, commands_json=excluded.commands_json,
        network_json=excluded.network_json, model=excluded.model, expires_at=excluded.expires_at,
        budget_json=excluded.budget_json, status='active', updated_at=excluded.updated_at`,
    id, run.id, encodeJson(paths), encodeJson(commands), encodeJson(network), String(body.model || current?.model || repo.getSettings().model || "").slice(0, 200), expiresAt, encodeJson(grantBudget), current?.created_at || at, at);
    db.recordAudit("grant.updated", { grantId: id, paths, commands, network, expiresAt }, { runId: run.id, actor: "local-session", entityType: "grant", entityId: id });
    sendJson(res, 200, { grant: publicGrant(db.get("SELECT * FROM grants WHERE id = ?", id)) }); return true;
  }

  if (!resourceMatch) return false;
  const run = runner.getRun(decodeURIComponent(resourceMatch[1]));
  const resource = resourceMatch[2];

  if (resource === "diff" && req.method === "GET") {
    sendJson(res, 200, { diff: run.metadata.worktreePath ? await worktreeService.diff(run.id) : null, run }); return true;
  }
  if (resource === "tests" && req.method === "GET") {
    const rows = db.all("SELECT * FROM steps WHERE run_id = ? AND type = 'test' ORDER BY sequence, created_at", run.id);
    sendJson(res, 200, { tests: rows.map(publicStep), run }); return true;
  }
  if (resource === "tests" && req.method === "POST") {
    const body = await readJsonBody(req);
    assertGrant(db, run, { command: body.command || body.file });
    const outcome = await effectOnce(runner, run.id, req, "test.run", { command: body.command || [body.file, ...(body.args || [])] }, async () => {
      const result = await worktreeService.runTest(run.id, body);
      const step = insertStep(db, run.id, "test", result.status, body.label || "验证切片", result);
      runner.recordEvent(run.id, "step.updated", { step });
      let commit = null;
      if ((result.passed === true || result.status === "passed") && body.autoCommit !== false) {
        const status = await worktreeService.status(run.id);
        if (status.clean !== true) {
          const message = String(body.commitMessage || `chore(agent): verified slice ${step.sequence}`).slice(0, 240);
          const committed = await worktreeService.createCommit(run.id, { message, paths: body.paths || ["."] });
          commit = insertStep(db, run.id, "commit", "completed", message, committed.commit);
          runner.recordEvent(run.id, "artifact.updated", { kind: "commit", step: commit, automatic: true });
        }
      }
      return { test: step, result, commit };
    });
    sendJson(res, 200, outcome); return true;
  }
  if (resource === "commits" && req.method === "GET") {
    const rows = db.all("SELECT * FROM steps WHERE run_id = ? AND type = 'commit' ORDER BY sequence, created_at", run.id);
    const head = run.metadata.worktreePath ? await worktreeService.queryCommit(run.id).catch(() => null) : null;
    sendJson(res, 200, { commits: rows.map(publicStep), head, run }); return true;
  }
  if (resource === "commits" && req.method === "POST") {
    const body = await readJsonBody(req);
    assertGrant(db, run);
    const latestTest = db.get("SELECT * FROM steps WHERE run_id = ? AND type = 'test' ORDER BY sequence DESC LIMIT 1", run.id);
    if (!latestTest || latestTest.status !== "passed") throw Object.assign(new Error("原子提交前需要最近一次验证通过"), { statusCode: 409, code: "tests_required" });
    const outcome = await effectOnce(runner, run.id, req, "git.commit", { message: body.message, paths: body.paths || ["."] }, async () => {
      const result = await worktreeService.createCommit(run.id, body);
      const step = insertStep(db, run.id, "commit", "completed", body.message || result.message, result.commit);
      runner.recordEvent(run.id, "artifact.updated", { kind: "commit", step });
      return { commit: step, result };
    });
    sendJson(res, 201, outcome); return true;
  }
  return false;
}

async function effectOnce(runner, runId, req, kind, intent, action) {
  const effect = runner.beginEffect(runId, { kind, idempotencyKey: String(req.headers["idempotency-key"] || ""), intent });
  if (effect.status === "completed") return effect.result;
  if (effect.status !== "intent") throw Object.assign(new Error("副作用结果不确定，运行已进入对账状态"), { statusCode: 409, code: "effect_reconciling" });
  try {
    const result = await action();
    runner.completeEffect(effect.id, result);
    return result;
  } catch (error) {
    runner.reconcileUncertainEffects(runId);
    throw error;
  }
}

function ensureGrant(db, repo, run, worktree) {
  const existing = db.get("SELECT * FROM grants WHERE run_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1", run.id);
  if (existing) {
    const at = new Date().toISOString();
    const paths = [...new Set([...decodeJson(existing.paths_json, []), worktree.path])];
    const commands = [...new Set([...decodeJson(existing.commands_json, []), ...DEFAULT_COMMANDS])];
    db.run("UPDATE grants SET paths_json = ?, commands_json = ?, updated_at = ? WHERE id = ?", encodeJson(paths), encodeJson(commands), at, existing.id);
    return publicGrant(db.get("SELECT * FROM grants WHERE id = ?", existing.id));
  }
  const id = makeId("grant");
  const at = new Date().toISOString();
  const expiresAt = new Date(new Date(run.createdAt).getTime() + run.budget.durationHours * 60 * 60_000).toISOString();
  const hostname = modelHostname(repo.getSettings());
  db.run(`INSERT INTO grants (id, run_id, paths_json, commands_json, network_json, model, expires_at, budget_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`, id, run.id, encodeJson([worktree.path]), encodeJson(DEFAULT_COMMANDS), encodeJson(hostname ? [hostname] : []), String(repo.getSettings().model || ""), expiresAt, encodeJson(run.budget), at, at);
  return publicGrant(db.get("SELECT * FROM grants WHERE id = ?", id));
}

function assertGrant(db, run, { command = "" } = {}) {
  const row = db.get("SELECT * FROM grants WHERE run_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1", run.id);
  if (!row) throw Object.assign(new Error("运行缺少有效 Run Grant"), { statusCode: 403, code: "grant_required" });
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) throw Object.assign(new Error("Run Grant 已过期"), { statusCode: 403, code: "grant_expired" });
  if (run.metadata.worktreePath) {
    const grantedPaths = decodeJson(row.paths_json, []).map((item) => resolve(String(item)));
    const worktreePath = resolve(run.metadata.worktreePath);
    if (!grantedPaths.some((base) => worktreePath === base || (!relative(base, worktreePath).startsWith(`..${sep}`) && relative(base, worktreePath) !== ".." && !isAbsolute(relative(base, worktreePath))))) {
      throw Object.assign(new Error("Run Grant 不允许当前 worktree 路径"), { statusCode: 403, code: "grant_path_denied" });
    }
  }
  if (command) {
    const executable = String(Array.isArray(command) ? command[0] : command).trim().split(/\s+/)[0].replace(/^.*[\\/]/, "").toLowerCase();
    const allowed = decodeJson(row.commands_json, []).map((item) => String(item).toLowerCase());
    if (!allowed.includes(executable)) throw Object.assign(new Error(`Run Grant 不允许命令: ${executable}`), { statusCode: 403, code: "grant_command_denied" });
  }
  return publicGrant(row);
}

function insertStep(db, runId, type, status, title, detail) {
  const sequence = Number(db.get("SELECT coalesce(max(sequence), 0) AS sequence FROM steps WHERE run_id = ?", runId)?.sequence || 0) + 1;
  const id = makeId("step");
  const at = new Date().toISOString();
  db.run("INSERT INTO steps (id, run_id, type, status, title, detail_json, sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, runId, type, status, String(title || ""), encodeJson(detail || {}), sequence, at, at);
  return publicStep(db.get("SELECT * FROM steps WHERE id = ?", id));
}

function publicStep(row) { return { id: row.id, runId: row.run_id, type: row.type, status: row.status, title: row.title, detail: sanitizeSecretObject(decodeJson(row.detail_json, {})), sequence: Number(row.sequence || 0), createdAt: row.created_at, updatedAt: row.updated_at }; }
function publicGrant(row) { return row ? { id: row.id, runId: row.run_id, paths: decodeJson(row.paths_json, []), commands: decodeJson(row.commands_json, []), network: decodeJson(row.network_json, []), model: row.model || "", expiresAt: row.expires_at || "", budget: decodeJson(row.budget_json, {}), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
function normalizeStrings(value, fallback) { return (Array.isArray(value) ? value : fallback).map(String).map((item) => item.trim()).filter(Boolean).slice(0, 100); }
function validateGrantPaths(paths, run) {
  const worktree = run.metadata.worktreePath ? resolve(run.metadata.worktreePath) : "";
  for (const item of paths) {
    const candidate = resolve(item);
    if (!worktree || candidate !== worktree) throw Object.assign(new Error("Run Grant 写路径只能是当前运行的 worktree"), { statusCode: 403, code: "grant_path_denied" });
  }
  return [...new Set(paths.map((item) => resolve(item)))];
}
function validateGrantCommands(commands) {
  const allowed = new Set(DEFAULT_COMMANDS.map((item) => item.toLowerCase()));
  if (commands.some((item) => !allowed.has(item.toLowerCase()))) throw Object.assign(new Error("Run Grant 包含未允许的命令"), { statusCode: 403, code: "grant_command_denied" });
  return [...new Set(commands.map((item) => item.toLowerCase()))];
}
function validateGrantNetwork(network) {
  const hostPattern = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
  if (network.some((item) => !hostPattern.test(item))) throw Object.assign(new Error("Run Grant 网络范围必须是公开域名"), { statusCode: 403, code: "grant_network_denied" });
  return [...new Set(network.map((item) => item.toLowerCase()))];
}
function constrainGrantBudget(input, maximum) {
  const candidate = { ...maximum, ...(input || {}) };
  for (const key of ["durationHours", "maxModelCalls", "maxInputTokens", "maxOutputTokens", "maxEstimatedUsd"]) {
    if (!Number.isFinite(Number(candidate[key])) || Number(candidate[key]) < 0 || (key !== "maxEstimatedUsd" && Number(candidate[key]) < 1)) {
      throw Object.assign(new Error(`Run Grant 预算无效: ${key}`), { statusCode: 400, code: "invalid_grant_budget" });
    }
    candidate[key] = Number(candidate[key]);
    if (Number(candidate[key]) > Number(maximum[key])) throw Object.assign(new Error(`Run Grant 预算不能扩大: ${key}`), { statusCode: 403, code: "grant_budget_exceeded" });
  }
  if (maximum.enforced !== false && candidate.enforced === false) throw Object.assign(new Error("关闭硬预算需要单独风险确认"), { statusCode: 403, code: "grant_budget_confirmation_required" });
  return candidate;
}
function modelHostname(settings) {
  try { if (settings.apiBaseUrl) return new URL(settings.apiBaseUrl).hostname.toLowerCase(); } catch { return ""; }
  if (settings.modelProvider === "anthropic") return "api.anthropic.com";
  if (settings.modelProvider === "gemini") return "generativelanguage.googleapis.com";
  if (settings.modelProvider === "deepseek") return "api.deepseek.com";
  return "api.openai.com";
}
function makeId(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`; }
