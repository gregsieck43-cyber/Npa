import { spawn } from "node:child_process";
import { join } from "node:path";
import { readJsonBody, sendJson } from "../core/http.js";
import { encodeJson, decodeJson, nowIso } from "../core/database.js";
import { sanitizeSecretObject } from "../core/app-repository.js";
import * as DataAnalysisService from "../services/data-analysis-service.js";

export async function tryHandleDataApi({ req, res, url, db, repo, rootDir }) {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/data/")) return false;
  const settings = repo.getSettings();
  if (req.method === "POST" && settings.capabilities?.dataAnalysis === false) throw forbidden("数据分析开关已关闭");

  if (req.method === "POST" && pathname === "/api/data/import-upload") {
    const body = await readJsonBody(req, { maxBytes: 20 * 1024 * 1024 });
    const files = (Array.isArray(body.files) ? body.files : [body.file || body]).filter(Boolean).slice(0, 6);
    if (!files.length) throw badRequest("没有收到数据文件");
    const datasets = [];
    for (const file of files) {
      for (const parsed of parseDatasetsFromUpload(file)) datasets.push(saveDataset(db, parsed, { sourceName: file.name, mimeType: file.mimeType }));
    }
    db.recordAudit("data.imported", { count: datasets.length, names: datasets.map((dataset) => dataset.name) });
    sendJson(res, 200, { datasets, state: hydrate(db, repo) }); return true;
  }

  const datasetMatch = pathname.match(/^\/api\/data\/datasets\/([^/]+)$/);
  if (req.method === "DELETE" && datasetMatch) {
    const id = decodeURIComponent(datasetMatch[1]);
    const dataset = getDataset(db, id);
    if (!dataset) throw notFound("数据集不存在");
    db.run("DELETE FROM datasets WHERE id = ?", id);
    db.recordAudit("data.deleted", { datasetId: id, name: dataset.name });
    sendJson(res, 200, { dataset, state: hydrate(db, repo) }); return true;
  }

  if (req.method === "POST" && ["/api/data/run", "/api/data/clean", "/api/data/pivot"].includes(pathname)) {
    const body = await readJsonBody(req);
    const language = pathname.endsWith("/clean") ? "clean" : pathname.endsWith("/pivot") ? "pivot" : body.language || "javascript";
    const run = await runAnalysis({ db, rootDir, input: { ...body, language }, settings: settings.analysis || {} });
    sendJson(res, 200, { run, state: hydrate(db, repo) }); return true;
  }

  if (req.method === "POST" && pathname === "/api/data/chart/export") {
    const body = await readJsonBody(req);
    const stored = body.runId ? getAnalysisRun(db, body.runId) : null;
    const chart = body.chart || stored?.chart;
    if (!chart) throw badRequest("没有可导出的图表");
    const svg = DataAnalysisService.chartToSvg(chart, { title: body.title || stored?.id || "数据图表" });
    sendJson(res, 200, { mimeType: "image/svg+xml", data: Buffer.from(svg, "utf8").toString("base64"), svg }); return true;
  }

  if (req.method === "POST" && pathname === "/api/data/packages") {
    const body = await readJsonBody(req);
    const environment = DataAnalysisService.normalizePackageEnvironment(body);
    const environments = repo.getValue("package_environments", {});
    environments[body.envId || "default"] = environment;
    repo.setValue("package_environments", environments);
    db.recordAudit("data.package_environment_saved", { envId: body.envId || "default", manager: environment.manager, packages: environment.packages.length });
    sendJson(res, 200, { environment, state: hydrate(db, repo) }); return true;
  }
  return false;
}

function parseDatasetsFromUpload(file = {}) {
  const name = String(file.name || "dataset");
  const text = decodeFileContent(file);
  if (/\.json$/i.test(name) || String(file.mimeType || "").includes("json")) {
    const parsed = JSON.parse(text || "[]");
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : [parsed];
    return [{ name: name.replace(/\.json$/i, ""), rows }];
  }
  const rows = parseCsv(text);
  return [{ name: name.replace(/\.(csv|tsv)$/i, ""), rows }];
}

function decodeFileContent(file) {
  if (file.encoding === "base64" || file.base64) return Buffer.from(String(file.content || file.data || file.base64), "base64").toString("utf8");
  if (typeof file.content === "string") return file.content;
  if (typeof file.data === "string") return file.data;
  if (Array.isArray(file.rows)) return JSON.stringify(file.rows);
  return JSON.stringify(file);
}

function parseCsv(text) {
  const delimiter = String(text).split(/\r?\n/, 1)[0]?.includes("\t") ? "\t" : ",";
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = csvLine(lines.shift(), delimiter).map((value, index) => value || `column_${index + 1}`);
  return lines.slice(0, 5000).map((line) => Object.fromEntries(headers.map((header, index) => [header, coerce(csvLine(line, delimiter)[index] ?? "")])));
}

function csvLine(line, delimiter) {
  const values = []; let value = ""; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { values.push(value); value = ""; }
    else value += char;
  }
  values.push(value); return values;
}
function coerce(value) { if (value === "") return null; const number = Number(value); return Number.isFinite(number) && value.trim() !== "" ? number : value; }

function saveDataset(db, parsed, meta = {}) {
  const rows = Array.isArray(parsed.rows) ? parsed.rows.slice(0, 5000) : [];
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  const id = `dataset_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const at = nowIso();
  db.run("INSERT INTO datasets (id, project_id, name, rows_json, columns_json, metadata_json, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)",
    id, String(parsed.name || meta.sourceName || "dataset"), encodeJson(rows), encodeJson(columns), encodeJson(sanitizeSecretObject(meta)), at, at);
  return getDataset(db, id);
}

function getDataset(db, id) {
  const row = db.get("SELECT * FROM datasets WHERE id = ?", String(id));
  return row ? { id: row.id, projectId: row.project_id, name: row.name, rows: decodeJson(row.rows_json, []), columns: decodeJson(row.columns_json, []), metadata: sanitizeSecretObject(decodeJson(row.metadata_json, {})), createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

async function runAnalysis({ db, rootDir, input, settings }) {
  const dataset = getDataset(db, input.datasetId);
  if (!dataset) throw notFound("数据集不存在");
  const limits = DataAnalysisService.normalizeAnalysisLimits({ ...settings, ...(input.limits || {}) });
  const language = String(input.language || "javascript");
  let output = {};
  if (language === "clean") output = { table: DataAnalysisService.cleanRows(dataset.rows, input.plan || input).rows };
  else if (language === "pivot") output = { table: DataAnalysisService.pivotRows(dataset.rows, input).rows };
  else if (language === "sql") output = { table: DataAnalysisService.runSimpleSql(input.query || input.code || "", dataset.rows).rows };
  else if (language === "javascript") {
    const scan = DataAnalysisService.scanAnalysisCode(input.code || "", "javascript", limits);
    if (!scan.ok) throw badRequest(scan.error || "分析代码未通过安全检查");
    output = await runJavascriptWorker(rootDir, { rows: dataset.rows, columns: dataset.columns, dataset: { id: dataset.id, name: dataset.name }, code: input.code || "", timeoutMs: limits.javascriptTimeoutMs }, limits);
  } else throw badRequest("当前版本仅支持 JavaScript、SQL、清洗和透视分析");
  const id = `analysis_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const at = nowIso();
  db.run("INSERT INTO analysis_runs (id, dataset_id, language, input_json, output_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)",
    id, dataset.id, language, encodeJson(sanitizeSecretObject(input)), encodeJson(sanitizeSecretObject(output)), at, at);
  return getAnalysisRun(db, id);
}

function runJavascriptWorker(rootDir, payload, limits) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(rootDir, "tools", "analysis-js-worker.js")], {
      cwd: rootDir,
      env: DataAnalysisService.sanitizedAnalysisEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true
    });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error("JavaScript 分析超时"), { statusCode: 408 })); }, limits.javascriptTimeoutMs + 1000);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > limits.maxStdoutChars * 2) child.kill(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(Object.assign(new Error(stderr.slice(0, limits.maxStdoutChars) || "分析进程失败"), { statusCode: 400 })); return; }
      const marker = stdout.lastIndexOf("__RESULT_JSON__");
      if (marker < 0) { reject(new Error("分析进程没有返回结构化结果")); return; }
      resolvePromise(JSON.parse(stdout.slice(marker + "__RESULT_JSON__".length).trim()));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function getAnalysisRun(db, id) {
  const row = db.get("SELECT * FROM analysis_runs WHERE id = ?", String(id));
  if (!row) return null;
  const output = decodeJson(row.output_json, {});
  return { id: row.id, datasetId: row.dataset_id, language: row.language, input: sanitizeSecretObject(decodeJson(row.input_json, {})), status: row.status, ...sanitizeSecretObject(output), createdAt: row.created_at, updatedAt: row.updated_at };
}

function hydrate(db, repo) {
  return {
    datasets: db.all("SELECT id FROM datasets ORDER BY updated_at DESC").map((row) => getDataset(db, row.id)),
    analysisRuns: db.all("SELECT id FROM analysis_runs ORDER BY updated_at DESC LIMIT 50").map((row) => getAnalysisRun(db, row.id)),
    packageEnvironments: repo.getValue("package_environments", {})
  };
}
function badRequest(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
function forbidden(message) { return Object.assign(new Error(message), { statusCode: 403 }); }
function notFound(message) { return Object.assign(new Error(message), { statusCode: 404 }); }
