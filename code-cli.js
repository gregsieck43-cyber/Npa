#!/usr/bin/env node

/*
 * Small, dependency-free command line client for the local Workbench API.
 *
 * The launcher invokes this file from both a source checkout and the Windows
 * package. Keep it free of imports so it works with either CommonJS or ESM
 * package defaults. Node 18+ supplies the fetch implementation we need.
 */

const DEFAULT_PORT = 3137;
const DEFAULT_COMMAND = "health";
const FALLBACK_STATUS_CODES = new Set([404, 405]);

function parseArgs(argv) {
  const flags = Object.create(null);
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--") || token === "-") {
      positional.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    let key = equals >= 0 ? token.slice(2, equals) : token.slice(2);
    let value = equals >= 0 ? token.slice(equals + 1) : true;
    if (key.startsWith("no-") && equals < 0) {
      key = key.slice(3);
      value = false;
    } else if (value === true && index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
      value = argv[index + 1];
      index += 1;
    }
    flags[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }

  const command = String(positional.shift() || (flags.selfTest ? "self-test" : DEFAULT_COMMAND)).toLowerCase();
  return { command, flags, positional };
}

function envFirst(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return "";
}

function resolveBaseUrl(flags) {
  const configured = flags.url || flags.baseUrl || envFirst([
    "WORKBENCH_URL",
    "WORKBENCH_API_URL",
    "WORKBENCH_EXTERNAL_API_URL"
  ]);
  const raw = configured || `http://127.0.0.1:${process.env.PORT || DEFAULT_PORT}`;
  const parsed = new URL(raw);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function resolveToken(flags) {
  const token = flags.token || flags.sessionToken || flags.localSessionToken;
  if (token === false) return "";
  return String(token || envFirst([
    "WORKBENCH_SESSION_TOKEN",
    "WORKBENCH_TOKEN",
    "LOCAL_SESSION_TOKEN",
    "CODE_CLI_TOKEN",
    "SESSION_TOKEN"
  ]) || "").trim();
}

function parseJson(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function integerOrOriginal(value) {
  if (value === true || value === false || value === undefined) return value;
  const number = Number(value);
  return Number.isFinite(number) && String(number) === String(value).trim() ? number : value;
}

function createRunBody(parsed) {
  const { flags, positional } = parsed;
  const explicitBody = parseJson(flags.body ?? flags.payload, "--body/--payload");
  const body = explicitBody && typeof explicitBody === "object" && !Array.isArray(explicitBody)
    ? { ...explicitBody }
    : {};
  const copyKeys = [
    "prompt",
    "goal",
    "task",
    "title",
    "project",
    "projectId",
    "taskId",
    "provider",
    "model",
    "priority",
    "budget",
    "maxInputTokens",
    "maxOutputTokens",
    "metadata",
    "context",
    "runId",
    "id"
  ];
  for (const key of copyKeys) {
    if (flags[key] !== undefined && flags[key] !== true && flags[key] !== false) {
      body[key] = ["budget", "maxInputTokens", "maxOutputTokens"].includes(key)
        ? integerOrOriginal(flags[key])
        : flags[key];
    }
  }
  const freeParts = positional.slice();
  const positionalTaskId = freeParts[0] && /^(?:task|tsk)[_-]/i.test(String(freeParts[0]));
  if (flags.taskId || flags.taskID || positionalTaskId) freeParts.shift();
  const freeText = freeParts.join(" ").trim();
  if (freeText && body.prompt === undefined && body.goal === undefined && body.task === undefined) {
    body.prompt = freeText;
  }
  return body;
}

function endpoint(pathname, method = "GET", body) {
  return { pathname, method, body };
}

function makeHeaders(token, hasBody, idempotencyKey = "") {
  const headers = { accept: "application/json" };
  if (hasBody) headers["content-type"] = "application/json";
  if (hasBody && idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  if (token) {
    headers["x-local-session-token"] = token;
    // Authorization is useful for reverse proxies while the explicit local
    // header remains the canonical Workbench contract.
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function requestApi(baseUrl, token, request, timeoutMs, idempotencyKey = "") {
  const url = `${baseUrl}${request.pathname.startsWith("/") ? "" : "/"}${request.pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: request.method || "GET",
      headers: makeHeaders(token, request.body !== undefined, idempotencyKey),
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal
    });
    const text = await response.text();
    let data = text;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        // Keep plain-text API responses usable by the CLI.
      }
    } else {
      data = { ok: response.ok };
    }
    if (!response.ok) {
      const error = new Error(`API ${response.status} ${response.statusText || "request failed"}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`API request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestWithFallback(baseUrl, token, candidates, timeoutMs) {
  let lastError;
  const idempotencyKey = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  for (const request of candidates) {
    try {
      return await requestApi(baseUrl, token, request, timeoutMs, idempotencyKey);
    } catch (error) {
      lastError = error;
      if (!FALLBACK_STATUS_CODES.has(error?.status)) throw error;
    }
  }
  throw lastError || new Error("No API endpoint candidates configured");
}

function requireRunId(parsed) {
  const id = parsed.flags.id || parsed.flags.runId || parsed.positional[0];
  if (!id || id === "all") return "";
  return String(id);
}

function commandRequests(parsed, baseUrl, token) {
  const command = parsed.command;
  const { flags } = parsed;
  const configuredTimeout = Number(flags.timeout || process.env.WORKBENCH_CLI_TIMEOUT_MS || 10_000);
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(500, configuredTimeout) : 10_000;
  if (command === "health" || command === "status") {
    return { candidates: [endpoint("/api/health")], timeoutMs };
  }
  if (command === "list" || command === "ls" || command === "runs" || command === "tasks") {
    const query = flags.status ? `?status=${encodeURIComponent(String(flags.status))}` : "";
    const taskListing = command === "tasks";
    return {
      candidates: taskListing
        ? [endpoint(`/api/v1/tasks${query}`), endpoint(`/api/tasks${query}`), endpoint(`/api/v1/runs${query}`)]
        : [endpoint(`/api/v1/runs${query}`), endpoint(`/api/runs${query}`), endpoint(`/api/tasks${query}`), endpoint(`/api/agents/runs${query}`)],
      timeoutMs
    };
  }
  if (command === "run" || command === "start" || command === "create") {
    const body = createRunBody(parsed);
    const candidate = parsed.positional[0];
    const taskId = flags.taskId || flags.taskID
      || (flags.task && /^(?:task|tsk)[_-]/i.test(String(flags.task)) ? flags.task : "")
      || (candidate && /^(?:task|tsk)[_-]/i.test(String(candidate)) ? candidate : "");
    const taskRunEndpoint = taskId ? `/api/v1/tasks/${encodeURIComponent(String(taskId))}/runs` : "/api/v1/runs";
    return {
      candidates: [
        endpoint(taskRunEndpoint, "POST", body),
        endpoint("/api/v1/runs", "POST", body),
        endpoint("/api/runs", "POST", body),
        endpoint("/api/tasks", "POST", body)
      ],
      timeoutMs
    };
  }
  if (command === "pause" || command === "resume") {
    const action = command;
    const all = flags.all === true || flags.all === "true" || !requireRunId(parsed);
    if (all) {
      const body = flags.reason ? { reason: String(flags.reason) } : {};
      return {
        candidates: [
          endpoint(`/api/v1/runs/${action}-all`, "POST", body),
          endpoint(`/api/v1/${action}-all`, "POST", body),
          endpoint(`/api/runs/${action}-all`, "POST", body),
          endpoint(`/api/runs/${action}`, "POST", body),
          endpoint(`/api/tasks/${action}-all`, "POST", body)
        ],
        timeoutMs
      };
    }
    const id = encodeURIComponent(requireRunId(parsed));
    return {
      candidates: [
        endpoint(`/api/v1/runs/${id}/${action}`, "POST", {}),
        endpoint(`/api/runs/${id}/${action}`, "POST", {}),
        endpoint(`/api/runs/${id}`, "PATCH", { status: action === "pause" ? "paused" : "running" }),
        endpoint(`/api/tasks/${id}/${action}`, "POST", {})
      ],
      timeoutMs
    };
  }
  if (command === "checkpoint" || command === "check-point") {
    const body = parseJson(flags.body || flags.payload, "--body/--payload") || {};
    return {
      candidates: [
        endpoint("/api/v1/runs/checkpoint-all", "POST", body),
        endpoint("/api/v1/checkpoint-all", "POST", body),
        endpoint("/api/checkpoint", "POST", body),
        endpoint("/api/runs/checkpoint", "POST", body)
      ],
      timeoutMs
    };
  }
  if (command === "approvals" || command === "pending" || command === "waiting-approval") {
    return {
      candidates: [
        endpoint("/api/v1/approvals?status=pending"),
        endpoint("/api/approvals"),
        endpoint("/api/runs?status=waiting_approval"),
        endpoint("/api/tasks?status=waiting_approval")
      ],
      timeoutMs
    };
  }
  throw new Error(`Unknown command: ${command}. Use --help for available commands.`);
}

function printHelp() {
  process.stdout.write([
    "Claude Workbench CLI",
    "",
    "Usage:",
    "  node code-cli.js --self-test",
    "  node code-cli.js health [--url URL] [--token TOKEN]",
    "  node code-cli.js run [PROMPT|TASK_ID] [--task-id ID] [--goal TEXT] [--project ID]",
    "  node code-cli.js list [--status STATUS]",
    "  node code-cli.js pause [RUN_ID|--all]",
    "  node code-cli.js resume [RUN_ID|--all]",
    "  node code-cli.js approvals",
    "",
    "URL: WORKBENCH_URL (or WORKBENCH_EXTERNAL_API_URL), default http://127.0.0.1:3137",
    "Token: --token or WORKBENCH_SESSION_TOKEN; required for API commands and sent as X-Local-Session-Token",
    "Output is JSON for API commands."
  ].join("\n") + "\n");
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.flags.help || parsed.flags.h || parsed.command === "help") {
    printHelp();
    return 0;
  }
  if (parsed.command === "self-test" || parsed.flags.selfTest) {
    process.stdout.write("SELF_TEST_OK\n");
    return 0;
  }

  let baseUrl;
  try {
    baseUrl = resolveBaseUrl(parsed.flags);
  } catch (error) {
    throw new Error(`Invalid --url: ${error.message}`);
  }
  const token = resolveToken(parsed.flags);
  const request = commandRequests(parsed, baseUrl, token);
  const data = await requestWithFallback(baseUrl, token, request.candidates, request.timeoutMs);
  if (typeof data === "string") process.stdout.write(data + "\n");
  else process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  return 0;
}

if (typeof process !== "undefined" && process.argv[1] && process.argv[1].toLowerCase().endsWith("code-cli.js")) {
  main().then((code) => {
    if (code) process.exitCode = code;
  }).catch((error) => {
    const detail = error?.data ? ` ${JSON.stringify(error.data)}` : "";
    process.stderr.write(`CLI_ERROR ${error.message}${detail}\n`);
    process.exitCode = 1;
  });
}
