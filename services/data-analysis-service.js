export const DEFAULT_ANALYSIS_LIMITS = {
  jsTimeoutMs: 3000,
  pythonTimeoutMs: 8000,
  maxRows: 5000,
  maxCodeChars: 50000,
  maxStdoutChars: 40000,
  allowPythonImports: false,
  allowPackageInstall: false
};

export const DEFAULT_PACKAGE_ENV = {
  manager: "none",
  packages: [],
  offlineOnly: true,
  lastInstallAt: "",
  lastError: ""
};

const DANGEROUS_JS = [
  /\bprocess\b/,
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bfetch\s*\(/,
  /\bglobalThis\b/,
  /\bconstructor\b/,
  /\bprototype\b/,
  /\bgetPrototypeOf\b/,
  /\bsetPrototypeOf\b/,
  /\bdefineProperty\b/,
  /\bdefineProperties\b/,
  /\bgetOwnPropertyDescriptor\b/,
  /\bgetOwnPropertyDescriptors\b/,
  /\bassign\s*\(/,
  /__proto__/,
  /\bReflect\b/,
  /\bProxy\b/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bWorker\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/
];

const DANGEROUS_PYTHON = [
  /\bimport\s+(os|sys|subprocess|socket|pathlib|shutil|requests|urllib|http|ftplib)\b/,
  /\bfrom\s+(os|sys|subprocess|socket|pathlib|shutil|requests|urllib|http|ftplib)\s+import\b/,
  /\b(open|exec|eval|compile|__import__|input)\s*\(/,
  /__\w+__/,
  /\bglobals\s*\(/,
  /\blocals\s*\(/,
  /\bvars\s*\(/,
  /\bdir\s*\(/,
  /\bgetattr\s*\(/,
  /\bsetattr\s*\(/,
  /\bdelattr\s*\(/,
  /\bpip\s+install\b/,
  /\bconda\s+install\b/
];

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeAnalysisLimits(input = {}) {
  return {
    jsTimeoutMs: clampNumber(input.jsTimeoutMs, 500, 30000, DEFAULT_ANALYSIS_LIMITS.jsTimeoutMs),
    pythonTimeoutMs: clampNumber(input.pythonTimeoutMs, 1000, 60000, DEFAULT_ANALYSIS_LIMITS.pythonTimeoutMs),
    maxRows: clampNumber(input.maxRows, 100, 50000, DEFAULT_ANALYSIS_LIMITS.maxRows),
    maxCodeChars: clampNumber(input.maxCodeChars, 1000, 200000, DEFAULT_ANALYSIS_LIMITS.maxCodeChars),
    maxStdoutChars: clampNumber(input.maxStdoutChars, 2000, 200000, DEFAULT_ANALYSIS_LIMITS.maxStdoutChars),
    allowPythonImports: input.allowPythonImports === true,
    allowPackageInstall: input.allowPackageInstall === true
  };
}

export function sanitizedAnalysisEnv(baseEnv = {}, extraEnv = {}) {
  const allowed = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (baseEnv[key]) allowed[key] = baseEnv[key];
  }
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (!/API[_-]?KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH|ANTHROPIC|CLAUDE/i.test(key)) {
      allowed[key] = String(value);
    }
  }
  delete allowed.NODE_OPTIONS;
  return {
    ...allowed,
    NO_COLOR: "1",
    NODE_NO_WARNINGS: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONIOENCODING: "utf-8"
  };
}

export function nodeAnalysisSandboxArgs(workerPath = "") {
  const args = [];
  try {
    if (process.allowedNodeEnvironmentFlags?.has("--experimental-permission")) {
      args.push("--experimental-permission");
      if (workerPath) args.push(`--allow-fs-read=${workerPath}`);
    }
  } catch {
  }
  return args;
}

export function analysisSandboxProfile(language = "javascript", limits = {}) {
  const normalized = normalizeAnalysisLimits(limits);
  return {
    language,
    isolated: true,
    process: "child",
    cwd: "ephemeral",
    env: "sanitized",
    filesystem: "permission-denied-by-default",
    network: "blocked-by-policy",
    timeoutMs: language === "python" ? normalized.pythonTimeoutMs : normalized.jsTimeoutMs,
    maxRows: normalized.maxRows
  };
}

export function scanAnalysisCode(code = "", language = "javascript", limits = {}) {
  const normalized = normalizeAnalysisLimits(limits);
  const text = String(code || "");
  if (!text.trim()) throw Object.assign(new Error("分析代码不能为空"), { statusCode: 400 });
  if (text.length > normalized.maxCodeChars) throw Object.assign(new Error(`分析代码超过 ${normalized.maxCodeChars} 字符限制`), { statusCode: 413 });
  const patterns = language === "python" ? DANGEROUS_PYTHON : DANGEROUS_JS;
  if (language === "python" && normalized.allowPythonImports) {
    const packageInstall = DANGEROUS_PYTHON.slice(-2).find((pattern) => pattern.test(text));
    if (packageInstall && !normalized.allowPackageInstall) {
      throw Object.assign(new Error("包管理命令需要单独开启 allowPackageInstall"), { statusCode: 403 });
    }
    return { ok: true, warnings: [] };
  }
  const blocked = patterns.find((pattern) => pattern.test(text));
  if (blocked) {
    throw Object.assign(new Error(`危险代码隔离：已阻止 ${language} 代码中的 ${blocked}`), { statusCode: 403 });
  }
  return { ok: true, warnings: [] };
}

export function trimAnalysisOutput(value = "", limits = {}) {
  const normalized = normalizeAnalysisLimits(limits);
  const text = String(value || "");
  return text.length > normalized.maxStdoutChars ? `${text.slice(0, normalized.maxStdoutChars)}\n...[输出已截断]` : text;
}

export function normalizeNotebookRun(input = {}, limits = {}) {
  return {
    ...input,
    cellType: ["javascript", "python", "sql", "clean", "pivot", "chart"].includes(input.cellType) ? input.cellType : (input.language || "javascript"),
    stdout: trimAnalysisOutput(input.stdout || "", limits),
    stderr: trimAnalysisOutput(input.stderr || "", limits),
    resources: {
      jsTimeoutMs: normalizeAnalysisLimits(limits).jsTimeoutMs,
      pythonTimeoutMs: normalizeAnalysisLimits(limits).pythonTimeoutMs,
      maxRows: normalizeAnalysisLimits(limits).maxRows,
      isolated: true
    }
  };
}

export function normalizePackageEnvironment(input = {}) {
  const packages = Array.isArray(input.packages)
    ? input.packages
    : String(input.packages || "").split(/[,\n]/);
  return {
    manager: ["none", "npm", "pip"].includes(input.manager) ? input.manager : DEFAULT_PACKAGE_ENV.manager,
    packages: packages.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 80),
    offlineOnly: input.offlineOnly !== false,
    lastInstallAt: input.lastInstallAt || "",
    lastError: String(input.lastError || "").slice(0, 2000)
  };
}

export function runSimpleSql(query = "", rows = []) {
  const text = String(query || "").trim();
  const match = text.match(/^select\s+(.+?)\s+from\s+\w+(?:\s+where\s+(.+?))?(?:\s+limit\s+(\d+))?\s*;?$/i);
  if (!match) throw Object.assign(new Error("SQL cell 当前支持 SELECT columns FROM rows WHERE column = value LIMIT n"), { statusCode: 400 });
  const columnsRaw = match[1].trim();
  const whereRaw = match[2] || "";
  const limit = Math.min(5000, Math.max(1, Number(match[3] || 100)));
  const columns = columnsRaw === "*" ? null : columnsRaw.split(",").map((item) => item.trim()).filter(Boolean);
  let filtered = [...rows];
  const where = whereRaw.match(/^([\w.-]+)\s*(>=|<=|!=|=|>|<)\s*['"]?(.+?)['"]?$/);
  if (where) {
    const [, key, op, expected] = where;
    filtered = filtered.filter((row) => {
      const actual = row?.[key];
      const aNumber = Number(actual);
      const eNumber = Number(expected);
      const numeric = Number.isFinite(aNumber) && Number.isFinite(eNumber);
      if (op === "=") return String(actual) === expected;
      if (op === "!=") return String(actual) !== expected;
      if (!numeric) return false;
      if (op === ">") return aNumber > eNumber;
      if (op === "<") return aNumber < eNumber;
      if (op === ">=") return aNumber >= eNumber;
      if (op === "<=") return aNumber <= eNumber;
      return false;
    });
  }
  const resultRows = filtered.slice(0, limit).map((row) => {
    if (!columns) return row;
    return Object.fromEntries(columns.map((column) => [column, row?.[column]]));
  });
  return {
    rows: resultRows,
    columns: columns || Object.keys(resultRows[0] || rows[0] || {}),
    total: filtered.length,
    limited: filtered.length > resultRows.length
  };
}

export function cleanRows(rows = [], plan = {}) {
  const trimStrings = plan.trimStrings !== false;
  const dropEmptyRows = plan.dropEmptyRows === true;
  const fillNullWith = plan.fillNullWith ?? "";
  const dedupe = plan.dedupe === true;
  const seen = new Set();
  const cleaned = [];
  let removed = 0;
  for (const row of rows || []) {
    const next = {};
    for (const [key, value] of Object.entries(row || {})) {
      if (value === null || value === undefined || value === "") next[key] = fillNullWith;
      else next[key] = trimStrings && typeof value === "string" ? value.trim() : value;
    }
    const empty = Object.values(next).every((value) => value === "" || value === null || value === undefined);
    if (dropEmptyRows && empty) {
      removed += 1;
      continue;
    }
    const hash = JSON.stringify(next);
    if (dedupe && seen.has(hash)) {
      removed += 1;
      continue;
    }
    seen.add(hash);
    cleaned.push(next);
  }
  return { rows: cleaned, removed, plan: { trimStrings, dropEmptyRows, fillNullWith, dedupe } };
}

export function pivotRows(rows = [], { groupBy = "", value = "", op = "sum" } = {}) {
  if (!groupBy) throw Object.assign(new Error("透视表需要 groupBy 字段"), { statusCode: 400 });
  const groups = new Map();
  for (const row of rows || []) {
    const key = String(row?.[groupBy] ?? "");
    const current = groups.get(key) || [];
    current.push(row);
    groups.set(key, current);
  }
  const output = [...groups.entries()].map(([key, group]) => {
    const nums = value ? group.map((row) => Number(row?.[value])).filter(Number.isFinite) : [];
    let result = group.length;
    if (op === "sum") result = nums.reduce((sum, item) => sum + item, 0);
    if (op === "avg") result = nums.length ? nums.reduce((sum, item) => sum + item, 0) / nums.length : 0;
    if (op === "min") result = nums.length ? Math.min(...nums) : 0;
    if (op === "max") result = nums.length ? Math.max(...nums) : 0;
    if (op === "count") result = group.length;
    return { [groupBy]: key, [op]: Number(result.toFixed ? result.toFixed(4) : result), count: group.length };
  });
  return { rows: output, columns: [groupBy, op, "count"] };
}

export function chartToSvg(chart = {}, { title = "数据图表" } = {}) {
  const rows = Array.isArray(chart.data) ? chart.data : Array.isArray(chart) ? chart : [];
  const values = rows.map((row, index) => ({
    label: String(row.label ?? row.name ?? row.x ?? `项目 ${index + 1}`),
    value: Number(row.value ?? row.y ?? row.count ?? 0)
  })).filter((row) => Number.isFinite(row.value)).slice(0, 24);
  const width = 920;
  const height = 420;
  const max = Math.max(1, ...values.map((row) => row.value));
  const gap = 10;
  const barWidth = values.length ? Math.max(16, (width - 96 - gap * (values.length - 1)) / values.length) : 24;
  const bars = values.map((row, index) => {
    const barHeight = Math.max(2, (row.value / max) * 260);
    const x = 56 + index * (barWidth + gap);
    const y = 338 - barHeight;
    return `<g><rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="4" fill="#2f6fed"/><text x="${x + barWidth / 2}" y="366" text-anchor="middle" font-size="11">${escapeXml(row.label.slice(0, 12))}</text><text x="${x + barWidth / 2}" y="${y - 8}" text-anchor="middle" font-size="11">${row.value}</text></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img"><rect width="${width}" height="${height}" fill="#fff"/><text x="32" y="38" font-size="20" font-family="Microsoft YaHei, sans-serif">${escapeXml(title)}</text><line x1="48" y1="338" x2="${width - 24}" y2="338" stroke="#dedbd2"/>${bars}</svg>`;
}

function escapeXml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
