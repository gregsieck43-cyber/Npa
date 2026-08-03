import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { readJsonBody, sanitizeSensitiveText, sanitizeSensitiveValue, sendJson } from "../core/http.js";
import * as WebService from "../services/web-service.js";
import * as ArtifactService from "../services/artifact-service.js";
import * as ImageService from "../services/image-service.js";
import * as PatchService from "../services/patch-service.js";
import { assertPathInside } from "../services/path-security-service.js";
import { isAllowedTestCommand, normalizeTestCommand } from "../services/dev-session-service.js";
import { scrubChildEnvironment } from "../core/worktree-service.js";
import { sanitizeSecretObject } from "../core/app-repository.js";

const execFileAsync = promisify(execFile);

export function createToolRuntime() {
  return { webCache: WebService.normalizeWebCache({ entries: [] }), rateLimit: WebService.createRateLimiter() };
}

export async function tryHandleToolApi(ctx) {
  const { req, res, url, rootDir, repo, db, runner, payloadStore, riskStore, toolRuntime, secrets = {} } = ctx;
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/v1/")) return false;
  const settings = repo.getSettings();

  if (req.method === "POST" && pathname === "/api/v1/tools/web/search") {
    const body = await readJsonBody(req);
    requirePrivateNetworkApproval(body, riskStore, "web");
    const effectiveSettings = { ...settings.web, ...(body.settings || {}) };
    const result = await runExternal(() => runToolEffect({ runner, db, req, body, kind: "web.search", grantScope: toolGrantScope("web.search", { ...body, settings: effectiveSettings }, {}), action: () => WebService.webSearch(body.query || "", webOptions(body, settings, toolRuntime, secrets)) }), body, secrets);
    sendJson(res, 200, sanitizeExternalPayload(result, body, secrets)); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/tools/web/images") {
    const body = await readJsonBody(req);
    requirePrivateNetworkApproval(body, riskStore, "web");
    const effectiveSettings = { ...settings.web, ...(body.settings || {}) };
    const result = await runExternal(() => runToolEffect({ runner, db, req, body, kind: "web.images", grantScope: toolGrantScope("web.images", { ...body, settings: effectiveSettings }, {}), action: () => WebService.webImageSearch(body.query || "", { ...webOptions(body, settings, toolRuntime, secrets), limit: body.limit }) }), body, secrets);
    sendJson(res, 200, sanitizeExternalPayload(result, body, secrets)); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/tools/web/finance") {
    const body = await readJsonBody(req); const effective = { ...body, settings: { ...settings.web, ...(body.settings || {}) } }; requirePrivateNetworkApproval(body, riskStore, "web"); sendJson(res, 200, sanitizeExternalPayload(await runExternal(() => runToolEffect({ runner, db, req, body, kind: "web.finance", grantScope: toolGrantScope("web.finance", effective, {}), action: () => WebService.webFinanceQuote(body, webOptions(body, settings, toolRuntime, secrets)) }), body, secrets), body, secrets)); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/tools/web/weather") {
    const body = await readJsonBody(req); const effective = { ...body, settings: { ...settings.web, ...(body.settings || {}) } }; requirePrivateNetworkApproval(body, riskStore, "web"); sendJson(res, 200, sanitizeExternalPayload(await runExternal(() => runToolEffect({ runner, db, req, body, kind: "web.weather", grantScope: toolGrantScope("web.weather", effective, {}), action: () => WebService.webWeatherForecast(body, webOptions(body, settings, toolRuntime, secrets)) }), body, secrets), body, secrets)); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/tools/web/sports") {
    const body = await readJsonBody(req); const effective = { ...body, settings: { ...settings.web, ...(body.settings || {}) } }; requirePrivateNetworkApproval(body, riskStore, "web"); sendJson(res, 200, sanitizeExternalPayload(await runExternal(() => runToolEffect({ runner, db, req, body, kind: "web.sports", grantScope: toolGrantScope("web.sports", effective, {}), action: () => WebService.webSportsLookup(body, webOptions(body, settings, toolRuntime, secrets)) }), body, secrets), body, secrets)); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/tools/web/time") {
    const body = await readJsonBody(req); const effective = { ...body, settings: { ...settings.web, ...(body.settings || {}) } }; requirePrivateNetworkApproval(body, riskStore, "web"); sendJson(res, 200, sanitizeExternalPayload(await runExternal(() => runToolEffect({ runner, db, req, body, kind: "web.time", grantScope: toolGrantScope("web.time", effective, {}), action: () => WebService.webTimeLookup(body, webOptions(body, settings, toolRuntime, secrets)) }), body, secrets), body, secrets)); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/tools/web/cache/clear") {
    const body = await readJsonBody(req); toolRuntime.webCache = WebService.clearWebCache(toolRuntime.webCache, { expiredOnly: body.expiredOnly === true }); sendJson(res, 200, { cache: WebService.webCacheStats(toolRuntime.webCache) }); return true;
  }

  if (req.method === "POST" && pathname === "/api/v1/images/test") {
    const body = await readJsonBody(req); const imageSettings = ImageService.normalizeImageSettings({ ...settings.image, ...(body.settings || {}), ...body });
    requirePrivateNetworkApproval(body, riskStore, "image");
    await validateImageEndpoint(imageSettings);
    sendJson(res, 200, sanitizeExternalPayload(await runExternal(() => runToolEffect({ runner, db, req, body, kind: "image.test", grantScope: toolGrantScope("image.test", { ...body, settings: imageSettings }, {}), action: () => ImageService.testImageProvider({ settings: imageSettings, secrets: { token: body.token || secrets.imageToken || "" } }) }), body, secrets), body, secrets)); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/images/generate") {
    const body = await readJsonBody(req); const imageSettings = ImageService.normalizeImageSettings({ ...settings.image, ...(body.settings || {}), ...body });
    requirePrivateNetworkApproval(body, riskStore, "image");
    await validateImageEndpoint(imageSettings);
    sendJson(res, 200, sanitizeExternalPayload({ image: await runExternal(() => runToolEffect({ runner, db, req, body, kind: "image.generate", grantScope: toolGrantScope("image.generate", { ...body, settings: imageSettings }, {}), action: () => ImageService.generateImage(body, { settings: imageSettings, secrets: { token: body.token || secrets.imageToken || "" } }) }), body, secrets) }, body, secrets)); return true;
  }

  if (req.method === "POST" && pathname === "/api/v1/artifacts/preview") {
    const body = await readJsonBody(req);
    const artifact = { ...body, kind: ArtifactService.normalizeArtifactKind(body.kind) };
    sendJson(res, 200, { html: ArtifactService.artifactPreviewHtml(artifact), csp: ArtifactService.previewCsp(), plan: ArtifactService.buildPreviewPlan(artifact) }); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/artifacts") {
    const body = await readJsonBody(req); const id = body.id || makeId("artifact"); const at = new Date().toISOString();
    db.run(`INSERT INTO artifacts (id, project_id, run_id, name, kind, content, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, content=excluded.content, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`,
    id, body.projectId || null, body.runId || null, String(body.name || "未命名产物"), ArtifactService.normalizeArtifactKind(body.kind), String(body.content || ""), JSON.stringify(sanitizeSecretObject(body.metadata || {})), at, at);
    sendJson(res, 201, { artifact: { id, projectId: body.projectId || null, runId: body.runId || null, name: body.name || "未命名产物", kind: ArtifactService.normalizeArtifactKind(body.kind), content: String(body.content || ""), createdAt: at, updatedAt: at } }); return true;
  }

  if (req.method === "GET" && pathname === "/api/v1/tools/code/tree") {
    const base = await securePath(rootDir, url.searchParams.get("path") || ".");
    sendJson(res, 200, { root: relative(rootDir, base) || ".", entries: await listTree(rootDir, base) }); return true;
  }
  if (req.method === "GET" && pathname === "/api/v1/tools/code/read") {
    const filePath = await securePath(rootDir, url.searchParams.get("path") || ""); const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > 1_500_000) throw badRequest("文件过大或不是普通文件");
    sendJson(res, 200, { path: relative(rootDir, filePath).replace(/\\/g, "/"), content: await fs.readFile(filePath, "utf8"), size: stat.size, updatedAt: stat.mtime.toISOString() }); return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/tools/code/search") {
    const body = await readJsonBody(req); const query = String(body.query || "").toLowerCase();
    if (!query) throw badRequest("搜索内容不能为空");
    const base = await securePath(rootDir, body.path || "."); const files = (await listTree(rootDir, base, { includeFiles: true })).filter((entry) => entry.type === "file").slice(0, 300);
    const matches = [];
    for (const entry of files) {
      if (matches.length >= 200) break;
      if (!/\.(?:js|mjs|cjs|ts|tsx|json|md|css|html|ps1|cs)$/i.test(entry.path)) continue;
      const content = await fs.readFile(resolve(rootDir, entry.path), "utf8").catch(() => "");
      content.split(/\r?\n/).forEach((line, index) => { if (matches.length < 200 && line.toLowerCase().includes(query)) matches.push({ path: entry.path, line: index + 1, preview: line.trim().slice(0, 300) }); });
    }
    sendJson(res, 200, { query: body.query, matches }); return true;
  }

  if (req.method === "POST" && pathname === "/api/v1/tools/patch/plan") {
    const body = await readJsonBody(req);
    const plan = body.diff
      ? await PatchService.planUnifiedDiff({ diff: body.diff, workspace: rootDir, readFile: async (filePath) => fs.readFile(await securePath(rootDir, filePath), "utf8") })
      : await PatchService.planReplacementFiles({ files: body.files || [], workspace: rootDir, readFile: async (filePath) => fs.readFile(await securePath(rootDir, filePath), "utf8") });
    sendJson(res, 200, { plan }); return true;
  }

  if (req.method === "POST" && pathname === "/api/v1/tools/terminal/run") {
    const body = await readJsonBody(req); const command = normalizeTestCommand(body.command || "");
    if (!isAllowedTestCommand(command)) throw Object.assign(new Error("命令不在允许的测试/构建白名单中"), { statusCode: 403 });
    if (body.confirmationToken) riskStore.consume({ token: body.confirmationToken, action: "terminal.run", detail: { command } });
    else throw Object.assign(new Error("运行命令需要一次性风险确认"), { statusCode: 428, code: "confirmation_required" });
    const run = body.runId ? runner.getRun(String(body.runId)) : null;
    if (run && !run.metadata?.worktreePath) throw Object.assign(new Error("Run-bound terminal commands require an isolated worktree"), { statusCode: 409, code: "worktree_required" });
    const cwd = run?.metadata?.worktreePath ? resolve(String(run.metadata.worktreePath)) : rootDir;
    assertPathInside(rootDir, cwd, "Terminal working directory is outside the workspace");
    const { file, args } = executableCommand(command); const result = await runToolEffect({ runner, db, req, body, kind: "terminal.run", intent: { command, path: cwd }, action: () => execFileAsync(file, args, { cwd, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024, env: scrubChildEnvironment(process.env) }) });
    sendJson(res, 200, { command, stdout: result.stdout, stderr: result.stderr, exitCode: 0 }); return true;
  }

  if (req.method === "GET" && pathname === "/api/v1/tools/git/status") {
    sendJson(res, 200, { status: await git(rootDir, ["status", "--short", "--branch"]) }); return true;
  }
  if (req.method === "GET" && pathname === "/api/v1/tools/git/diff") {
    sendJson(res, 200, { diff: await git(rootDir, ["diff", "--", "."]) }); return true;
  }
  if (req.method === "GET" && pathname === "/api/v1/tools/git/log") {
    sendJson(res, 200, { log: await git(rootDir, ["log", "-20", "--oneline", "--decorate"]) }); return true;
  }

  if (req.method === "GET" && pathname === "/api/v1/connectors") {
    const connectors = repo.getValue("connectors", []).map(({ tokenRef, ...connector }) => ({ ...connector, tokenConfigured: Boolean(tokenRef) }));
    sendJson(res, 200, { connectors }); return true;
  }
  if (req.method === "PUT" && pathname === "/api/v1/connectors") {
    const body = await readJsonBody(req); const connectors = repo.getValue("connectors", []);
    const sanitized = { ...sanitizeSecretObject(body), tokenRef: body.token ? payloadStore.putSync(String(body.token), { mimeType: "text/plain" }).hash : body.tokenRef || "" };
    delete sanitized.token;
    const index = connectors.findIndex((connector) => connector.id === sanitized.id); if (index >= 0) connectors[index] = sanitized; else connectors.push(sanitized);
    repo.setValue("connectors", connectors); sendJson(res, 200, { connector: { ...sanitized, tokenRef: undefined, tokenConfigured: Boolean(sanitized.tokenRef) } }); return true;
  }
  return false;
}

function webOptions(body, settings, runtime, secrets) {
  return { settings: { ...settings.web, ...(body.settings || {}) }, cache: runtime.webCache, rateLimit: runtime.rateLimit, providerToken: body.token || secrets.webToken || "", customEndpoint: body.customEndpoint || settings.web?.customEndpoint || "" };
}
async function validateImageEndpoint(settings) {
  if (settings.endpoint) await WebService.assertPublicWebUrl(settings.endpoint, { allowPrivate: settings.allowPrivate === true });
}
async function securePath(rootDir, userPath) {
  const target = resolve(rootDir, String(userPath || ""));
  assertPathInside(rootDir, target, "Path is outside the workspace");
  const [realRoot, realTarget] = await Promise.all([fs.realpath(rootDir), fs.realpath(target)]);
  assertPathInside(realRoot, realTarget, "Symlink target is outside the workspace");
  return realTarget;
}
async function listTree(rootDir, base, { includeFiles = true } = {}) {
  const ignored = new Set([".git", "node_modules", ".cache", ".tmp", ".tools", ".packages", "dist", "test-results", "logs"]); const output = []; const queue = [base];
  while (queue.length && output.length < 500) {
    const directory = queue.shift(); const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue; const absolute = resolve(directory, entry.name); const path = relative(rootDir, absolute).replace(/\\/g, "/");
      if (entry.isDirectory()) { output.push({ path, name: entry.name, type: "directory" }); queue.push(absolute); }
      else if (includeFiles && entry.isFile()) output.push({ path, name: entry.name, type: "file" });
      if (output.length >= 500) break;
    }
  }
  return output;
}
function executableCommand(command) { const parts = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^['"]|['"]$/g, "")) || []; const executable = parts.shift(); return { file: executable === "npm" ? "npm.cmd" : executable, args: parts }; }
async function git(rootDir, args) { const result = await execFileAsync("git", args, { cwd: rootDir, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: scrubChildEnvironment(process.env) }); return result.stdout; }
function makeId(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`; }
function badRequest(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
function requirePrivateNetworkApproval(body, riskStore, kind) {
  const allowPrivate = body.allowPrivate === true || body.settings?.allowPrivate === true;
  if (!allowPrivate) return;
  const endpoint = body.customEndpoint || body.endpoint || body.settings?.endpoint || body.settings?.customEndpoint || "";
  riskStore.consume({ token: body.confirmationToken, action: `${kind}.private_endpoint`, detail: { endpoint } });
}

function externalSecrets(body = {}, secrets = {}) {
  return [body.token, secrets.webToken, secrets.imageToken].filter(Boolean).map(String);
}

function sanitizeExternalPayload(payload, body, secrets) {
  return sanitizeSensitiveValue(payload, externalSecrets(body, secrets));
}

async function runExternal(action, body, secrets) {
  try {
    return await action();
  } catch (error) {
    const safe = new Error(sanitizeSensitiveText(error?.message || error, externalSecrets(body, secrets)));
    safe.statusCode = error?.statusCode;
    safe.code = error?.code;
    safe.providerErrors = sanitizeSensitiveValue(error?.providerErrors || [], externalSecrets(body, secrets));
    throw safe;
  }
}

async function runToolEffect({ runner, db, req, body = {}, runId = body.runId, kind, intent = {}, grantScope = null, action }) {
  if (!runId || !runner) return action();
  const run = runner.getRun(String(runId));
  const scope = { ...(grantScope || toolGrantScope(kind, body, intent)), allowPrivate: body.allowPrivate === true || body.settings?.allowPrivate === true };
  try {
    runner.assertRunGrant(run.id, scope);
  } catch (error) {
    if (error?.code === "grant_budget_exhausted") {
      runner.pauseRun(run.id, "grant_budget_exhausted");
      throw error;
    }
    if (!["grant_required", "grant_expired", "grant_model_denied", "grant_network_denied", "grant_command_denied", "grant_path_denied"].includes(String(error?.code || ""))) throw error;
    const approval = runner.requestApproval(run.id, {
      action: kind,
      title: `允许 ${kind} 超出当前 Run Grant`,
      risk: kind.startsWith("terminal.") ? "high" : "medium",
      reason: error.code,
      grant: scope
    });
    throw Object.assign(new Error("操作超出 Run Grant，等待用户审批"), { statusCode: 428, code: "approval_required", approvalId: approval.id });
  }
  const requestHash = String(req.__workbenchBodyHash || createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"));
  const idempotencyKey = String(req.headers["idempotency-key"] || `api:${kind}:${requestHash}`);
  const effect = runner.beginEffect(run.id, { kind, idempotencyKey, intent: { ...intent, runId: run.id, requestHash } });
  if (effect.status === "completed") return effect.result;
  if (effect.status !== "intent") throw Object.assign(new Error("副作用结果不确定，运行已进入对账状态"), { statusCode: 409, code: "effect_reconciling" });
  try {
    const result = await action();
    runner.completeEffect(effect.id, result);
    return result;
  } catch (error) {
    runner.reconcileUncertainEffects(run.id);
    throw error;
  }
}

function toolGrantScope(kind, body, intent) {
  if (kind === "terminal.run") return { command: intent.command || body.command || "", path: intent.path || "" };
  if (kind.startsWith("image.")) {
    const provider = String(body.settings?.provider || body.provider || "").toLowerCase();
    if (["mock", "offline"].includes(provider)) return { hosts: [] };
    const endpoint = body.endpoint || body.settings?.endpoint || "https://api.openai.com/v1/images/generations";
    return { hosts: hostnames(endpoint) };
  }
  if (!kind.startsWith("web.")) return {};
  const provider = String(body.settings?.provider || body.provider || "duckduckgo").toLowerCase();
  if (["mock", "offline"].includes(provider)) return { hosts: [] };
  if (kind === "web.time") return { hosts: body.utcOffset || body.utc_offset || !String(body.location || "").trim() ? [] : ["geocoding-api.open-meteo.com"] };
  if (kind === "web.finance") return { hosts: ["api.coingecko.com", "query1.finance.yahoo.com", "stooq.com"] };
  if (kind === "web.weather") return { hosts: ["geocoding-api.open-meteo.com", "api.open-meteo.com"] };
  if (kind === "web.sports") return { hosts: ["site.web.api.espn.com", "site.api.espn.com"] };
  if (kind === "web.images") return { hosts: ["www.bing.com"] };
  const endpoints = {
    brave: "https://api.search.brave.com",
    bing: "https://api.bing.microsoft.com",
    tavily: body.settings?.endpoint || "https://api.tavily.com",
    custom: body.customEndpoint || body.settings?.customEndpoint || body.settings?.endpoint || ""
  };
  if (provider === "duckduckgo") return { hosts: ["duckduckgo.com", "www.bing.com"] };
  return { hosts: hostnames(endpoints[provider] || "") };
}

function hostnames(...values) {
  return values.flat().filter(Boolean).map((value) => {
    try { return new URL(String(value)).hostname.toLowerCase(); } catch { return ""; }
  }).filter(Boolean);
}
