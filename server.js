import http from "node:http";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "./core/database.js";
import { createPayloadStore } from "./core/payload-store.js";
import { createContextWorkspaceService } from "./core/context-workspace.js";
import { createAppRepository } from "./core/app-repository.js";
import { createTaskRunner } from "./core/task-runner.js";
import { createModelClient } from "./core/model-client.js";
import { createWorktreeService } from "./core/worktree-service.js";
import { createSessionGuard, sendError, sendJson, serveStatic, setBaseSecurityHeaders, readJsonBody } from "./core/http.js";
import { createRiskConfirmationStore } from "./services/risk-confirmation-service.js";
import { tryHandleApiV1 } from "./routes/api-v1.js";
import { tryHandleDataApi } from "./routes/data-api.js";
import { createToolRuntime, tryHandleToolApi } from "./routes/tool-api.js";
import { tryHandleDevApi } from "./routes/dev-api.js";

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));

export async function createWorkbenchServer(options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const dataDir = resolve(options.dataDir || process.env.WORKBENCH_DATA_DIR || join(rootDir, "data"));
  const host = options.host || "127.0.0.1";
  const port = Number(options.port ?? process.env.PORT ?? 3137);
  const instanceId = String(process.env.WORKBENCH_INSTANCE_ID || crypto.createHash("sha256").update(rootDir.replace(/[\\/]+$/, "").toUpperCase()).digest("hex"));
  mkdirSync(dataDir, { recursive: true });

  const masterKeyPath = join(dataDir, "workbench-master.key");
  const masterKey = ensureMasterKey(masterKeyPath);
  const db = openDatabase({ dataDir, busyTimeout: 5000 });
  const repo = createAppRepository(db);
  try {
    migrateLegacyStore({ dataDir, repo, db });
  } catch (error) {
    db.close();
    throw error;
  }
  const payloadStore = createPayloadStore({ dataDir, key: masterKey });
  const contextService = createContextWorkspaceService({ db, payloadStore });
  const modelClient = options.modelClient || createModelClient({ fetchImpl: options.fetchImpl || fetch });
  const runnerModelClient = options.disableModelRunner
    ? null
    : options.runnerModelClient || createRunnerModelAdapter({ repo, modelClient });
  const runner = createTaskRunner({ db, contextService, modelClient: runnerModelClient });
  const session = createSessionGuard({ rootToken: options.sessionToken || process.env.WORKBENCH_SESSION_TOKEN });
  const riskStore = createRiskConfirmationStore();
  const toolRuntime = createToolRuntime();
  const worktreeService = options.worktreeService || createWorktreeService({ rootDir });

  runner.ensureDefaultProject();
  for (const run of runner.listRuns().filter((item) => !["completed", "failed", "canceled"].includes(item.status))) {
    runner.reconcileUncertainEffects(run.id);
  }
  if (options.startScheduler !== false) runner.startScheduler();

  const server = http.createServer(async (req, res) => {
    setBaseSecurityHeaders(res);
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
      if (req.method === "GET" && url.pathname === "/api/health") {
        const migration = db.get("SELECT max(version) AS version FROM schema_migrations");
        let owned = String(req.headers["x-workbench-instance-id"] || "") === instanceId;
        try {
          session.authorize(req);
          owned = true;
        } catch {
          // Health remains public for local readiness checks. The ownership bit
          // is returned only to a caller holding this process' short-lived token.
        }
        sendJson(res, 200, { ok: true, app: "local-claude-workbench", version: "0.2.0", node: process.version, schemaVersion: Number(migration?.version || 0), ...(owned ? { owned: true } : {}) });
        return;
      }

      if (url.pathname === "/api/security/confirmations" && req.method === "POST") {
        session.authorize(req, { write: true });
        if (await prepareIdempotentWrite(db, req, res, url)) return;
        const body = await readJsonBody(req);
        if (body.confirmed !== true) throw Object.assign(new Error("需要显式确认"), { statusCode: 400 });
        sendJson(res, 201, { confirmation: riskStore.issue({ action: body.action, detail: body.detail, actor: "local-session" }) });
        return;
      }

      if (url.pathname.startsWith("/api/v1/")) {
        if (url.pathname !== "/api/v1/bootstrap") session.authorize(req, { write: !["GET", "HEAD", "OPTIONS"].includes(req.method || "GET") });
        if (await prepareIdempotentWrite(db, req, res, url)) return;
        if (await tryHandleDevApi({ req, res, url, rootDir, dataDir, db, repo, runner, worktreeService })) return;
        const handled = await tryHandleApiV1({
          req, res, url, rootDir, dataDir, db, repo, runner, contextService, payloadStore, modelClient, session, riskStore,
          secrets: { modelToken: process.env.WORKBENCH_MODEL_TOKEN || "" }
        });
        if (handled) return;
        if (await tryHandleToolApi({ req, res, url, rootDir, dataDir, db, repo, runner, contextService, payloadStore, modelClient, session, riskStore, toolRuntime,
          secrets: { webToken: process.env.WORKBENCH_WEB_TOKEN || "", imageToken: process.env.WORKBENCH_IMAGE_TOKEN || "" } })) return;
      }

      if (url.pathname.startsWith("/api/data/")) {
        session.authorize(req, { write: !["GET", "HEAD", "OPTIONS"].includes(req.method || "GET") });
        if (await prepareIdempotentWrite(db, req, res, url)) return;
        if (await tryHandleDataApi({ req, res, url, db, repo, rootDir })) return;
      }

      if (url.pathname.startsWith("/api/")) {
        session.authorize(req, { write: !["GET", "HEAD", "OPTIONS"].includes(req.method || "GET") });
        sendJson(res, 404, { ok: false, error: "API 路由不存在", code: "not_found" });
        return;
      }

      if (serveStatic(req, res, { roots: [join(rootDir, "frontend", "dist"), join(rootDir, "public")] })) return;
      sendJson(res, 404, { ok: false, error: "资源不存在", code: "not_found" });
    } catch (error) {
      if (!res.headersSent) sendError(res, error);
      else res.end();
    }
  });

  let listening = false;
  async function listen() {
    if (listening) return server.address();
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); listening = true; resolveListen(); });
    });
    return server.address();
  }
  async function close() {
    runner.stopScheduler();
    if (listening) await new Promise((resolveClose) => server.close(() => resolveClose()));
    listening = false;
    db.close();
  }
  return { server, listen, close, rootDir, dataDir, db, repo, runner, contextService, payloadStore, session, riskStore, worktreeService };
}

async function prepareIdempotentWrite(db, req, res, url) {
  const method = String(req.method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return false;
  const key = String(req.headers["idempotency-key"] || "").trim();
  if (!key) return false;
  if (key.length > 240) throw Object.assign(new Error("Idempotency-Key 过长"), { statusCode: 400 });
  await readJsonBody(req, { maxBytes: url.pathname.startsWith("/api/data/") ? 20 * 1024 * 1024 : 4 * 1024 * 1024 });
  const requestHash = String(req.__workbenchBodyHash || "");
  const scope = `http:${method}:${url.pathname}`;
  const owner = `request_${process.pid}_${crypto.randomBytes(8).toString("hex")}`;
  let claimed = false;
  const cached = db.transaction(() => {
    const existing = db.getIdempotency(key, scope);
    const at = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + 90_000).toISOString();
    if (existing) {
      if (existing.request_hash && existing.request_hash !== requestHash) return { ...existing, conflict: true };
      if (existing.response !== null && existing.response !== undefined) return existing;
      if (existing.lease_expires_at && existing.lease_expires_at > at) return existing;
      db.run("UPDATE idempotency SET request_hash = ?, lease_owner = ?, lease_expires_at = ?, status_code = 102, updated_at = ? WHERE key = ? AND scope = ?", requestHash, owner, leaseExpiresAt, at, key, scope);
      claimed = true;
      return null;
    }
    db.run(`INSERT INTO idempotency (key, scope, response_json, status_code, request_hash, lease_owner, lease_expires_at, created_at, updated_at)
      VALUES (?, ?, NULL, 102, ?, ?, ?, ?, ?)`, key, scope, requestHash, owner, leaseExpiresAt, at, at);
    claimed = true;
    return null;
  });
  if (cached?.conflict) {
    sendJson(res, 409, { ok: false, error: "Idempotency-Key 已绑定到不同请求内容", code: "idempotency_key_conflict" });
    return true;
  }
  if (cached?.response !== null && cached?.response !== undefined) {
    sendJson(res, Number(cached.status_code || 200), cached.response);
    return true;
  }
  if (cached && !claimed) {
    sendJson(res, 409, { ok: false, error: "相同 Idempotency-Key 的请求仍在处理或需要对账", code: "idempotency_in_progress" });
    return true;
  }

  const originalEnd = res.end;
  let captured = false;
  res.end = function idempotentEnd(chunk, encoding, callback) {
    if (!captured) {
      captured = true;
      const statusCode = Number(res.statusCode || 200);
      const contentType = String(res.getHeader("Content-Type") || "");
      if (statusCode >= 200 && statusCode < 300 && contentType.includes("application/json") && chunk != null) {
        try {
          const text = Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === "string" ? encoding : "utf8") : String(chunk);
          db.run("UPDATE idempotency SET response_json = ?, status_code = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE key = ? AND scope = ? AND lease_owner = ?",
            JSON.stringify(JSON.parse(text)), statusCode, new Date().toISOString(), key, scope, owner);
        } catch {
          // The response still succeeds; an unparseable body is simply not replayable.
        }
      } else {
        db.run("DELETE FROM idempotency WHERE key = ? AND scope = ? AND lease_owner = ?", key, scope, owner);
      }
    }
    return originalEnd.call(this, chunk, encoding, callback);
  };
  return false;
}

function createRunnerModelAdapter({ repo, modelClient }) {
  return {
    isConfigured() {
      const settings = repo.getSettings();
      return Boolean(runtimeModelToken(settings) || (settings.modelProvider === "custom" && settings.apiBaseUrl));
    },
    getGrantScope() {
      const settings = repo.getSettings();
      return { model: String(settings.model || ""), hosts: [runtimeModelHostname(settings)].filter(Boolean) };
    },
    async runSlice({ run, task, context }) {
      const settings = repo.getSettings();
      const token = runtimeModelToken(settings);
      const visibleContext = (context?.blocks || []).map((block) => ({
        id: block.id,
        type: block.type,
        status: block.status,
        summary: block.summary,
        source: block.source
      }));
      const result = await modelClient.generate({
        settings,
        secrets: { token },
        messages: [
          {
            role: "system",
            content: "You are advancing one durable local task slice. Do not reveal hidden reasoning. Return a JSON object with message, progressMade, checkpoint, status, and optional nextWakeAt. Only mark progressMade true when the response names a verifiable artifact, test, commit, or accepted step."
          },
          {
            role: "user",
            content: JSON.stringify({ goal: task?.title || "Continue task", description: task?.description || "", acceptanceCriteria: task?.acceptanceCriteria || [], constraints: task?.constraints || [], context: visibleContext })
          }
        ]
      });
      const structured = parseRunnerEnvelope(result.text);
      return {
        ...result,
        ...structured,
        text: structured.message || result.text,
        progressMade: structured.progressMade === true,
        checkpoint: structured.checkpoint || null,
        status: structured.status || "sleeping"
      };
    }
  };
}

function runtimeModelHostname(settings) {
  try {
    if (settings.apiBaseUrl) return new URL(settings.apiBaseUrl).hostname.toLowerCase();
  } catch { return ""; }
  if (settings.modelProvider === "anthropic") return "api.anthropic.com";
  if (settings.modelProvider === "gemini") return "generativelanguage.googleapis.com";
  if (settings.modelProvider === "deepseek") return "api.deepseek.com";
  return "api.openai.com";
}

function runtimeModelToken(settings) {
  if (process.env.WORKBENCH_MODEL_TOKEN) return process.env.WORKBENCH_MODEL_TOKEN;
  if (settings.modelProvider === "anthropic") return process.env.ANTHROPIC_API_KEY || "";
  if (settings.modelProvider === "gemini") return process.env.GEMINI_API_KEY || "";
  if (settings.modelProvider === "deepseek") return process.env.DEEPSEEK_API_KEY || "";
  return process.env.OPENAI_API_KEY || "";
}

function parseRunnerEnvelope(text) {
  const source = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return {
      message: String(parsed.message || "").slice(0, 100_000),
      progressMade: parsed.progressMade === true,
      checkpoint: parsed.checkpoint && typeof parsed.checkpoint === "object" ? parsed.checkpoint : null,
      status: ["sleeping", "waiting_approval", "blocked", "completed"].includes(parsed.status) ? parsed.status : "sleeping",
      nextWakeAt: parsed.nextWakeAt || undefined
    };
  } catch {
    return {};
  }
}

function ensureMasterKey(filePath) {
  if (existsSync(filePath)) {
    const value = readFileSync(filePath);
    if (value.length === 32) return value;
    if (/^[a-f0-9]{64}$/i.test(value.toString("utf8").trim())) return Buffer.from(value.toString("utf8").trim(), "hex");
    throw new Error("workbench-master.key 格式无效");
  }
  const key = crypto.randomBytes(32);
  writeFileSync(filePath, key, { mode: 0o600, flag: "wx" });
  return key;
}

function migrateLegacyStore({ dataDir, repo, db }) {
  const previous = repo.getValue("legacy_migration_v1", null);
  if (previous?.status === "imported") return;
  const source = join(dataDir, "store.json");
  if (!existsSync(source)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(dataDir, `store.backup-${stamp}.json`);
  copyFileSync(source, backup);
  try {
    const legacy = JSON.parse(readFileSync(source, "utf8"));
    db.transaction(() => {
      if (legacy.settings) repo.saveSettings(legacy.settings);
      repo.setValue("legacy_state", legacy);
      repo.setValue("legacy_migration_v1", { status: "imported", source, backup, importedAt: new Date().toISOString() });
    });
  } catch (error) {
    repo.setValue("legacy_migration_v1", { status: "failed", source, backup, error: String(error.message || error), failedAt: new Date().toISOString() });
    throw Object.assign(new Error(`旧数据迁移失败，原文件与备份均已保留: ${error.message}`), { cause: error });
  }
}

async function main() {
  const app = await createWorkbenchServer();
  await app.listen();
  const address = app.server.address();
  process.stdout.write(`Local Claude Workbench listening on http://127.0.0.1:${address.port}\n`);
  const shutdown = async () => {
    try { app.runner.checkpointAll(); } catch { /* best effort on process shutdown */ }
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
}
