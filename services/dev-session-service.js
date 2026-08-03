import crypto from "node:crypto";
import path from "node:path";

export const DEV_SESSION_STATUSES = new Set([
  "planned",
  "editing",
  "testing",
  "repairing",
  "ready_for_commit",
  "blocked",
  "failed",
  "paused",
  "done"
]);

export const DEFAULT_DEV_SESSION_MAX_REPAIRS = 3;

const TEST_COMMAND_PATTERNS = [
  /^npm\s+test(?:\s|$)/i,
  /^npm\s+run\s+(?:test(?::[\w.-]+)?|build)(?:\s|$)/i,
  /^node\s+--test(?:\s|$)/i
];

const BLOCKED_COMMAND_PATTERNS = [
  /\b(rm|del|erase|rmdir|remove-item|format|shutdown|restart-computer)\b/i,
  /\bgit\s+(push|reset|clean|rebase|merge|checkout|switch|commit|add)\b/i,
  /\b(npm\s+i|npm\s+install|pnpm\s+install|yarn\s+add|pip\s+install)\b/i,
  /\b(curl|wget|irm|iwr)\b/i,
  /[;&|`<>]/
];

function now() {
  return new Date().toISOString();
}

export function createId(prefix = "dev") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

export function normalizeDevSession(input = {}) {
  const checkpoints = Array.isArray(input.checkpoints) ? input.checkpoints : [];
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const iterations = Array.isArray(input.iterations) ? input.iterations : [];
  const observations = Array.isArray(input.observations) ? input.observations : [];
  const patches = Array.isArray(input.patches) ? input.patches : [];
  const conflicts = Array.isArray(input.conflicts) ? input.conflicts : [];
  return {
    id: String(input.id || createId("dev")),
    title: String(input.title || "Development session").trim().slice(0, 180),
    goal: String(input.goal || input.prompt || "").trim().slice(0, 60000),
    status: DEV_SESSION_STATUSES.has(input.status) ? input.status : "planned",
    projectId: input.projectId || null,
    chatId: input.chatId || null,
    workspacePath: String(input.workspacePath || "").slice(0, 1000),
    branch: String(input.branch || "").slice(0, 240),
    source: String(input.source || "manual").slice(0, 80),
    githubEventId: input.githubEventId || null,
    maxRepairRounds: clampInteger(input.maxRepairRounds, 0, 8, DEFAULT_DEV_SESSION_MAX_REPAIRS),
    repairRound: clampInteger(input.repairRound, 0, 50, 0),
    testCommand: normalizeTestCommand(input.testCommand || "npm test"),
    plan: String(input.plan || "").slice(0, 120000),
    changedFiles: normalizeStringList(input.changedFiles, 80, 1000),
    lastTest: normalizeTestResult(input.lastTest || null),
    failureSummary: String(input.failureSummary || "").slice(0, 12000),
    nextAction: String(input.nextAction || "").slice(0, 12000),
    steps: steps.map(normalizeStep).slice(0, 80),
    checkpoints: checkpoints.map(normalizeCheckpoint).slice(-120),
    iterations: iterations.map(normalizeIteration).slice(-40),
    observations: observations.map(normalizeObservation).slice(-120),
    patches: patches.map(normalizePatchRecord).slice(-120),
    conflicts: conflicts.map(normalizeConflictRecord).slice(-80),
    pendingFinalization: normalizePendingFinalization(input.pendingFinalization || null),
    finalize: normalizeFinalize(input.finalize || {}),
    createdAt: input.createdAt || now(),
    updatedAt: input.updatedAt || now(),
    completedAt: input.completedAt || ""
  };
}

export function publicDevSession(session = {}) {
  const normalized = normalizeDevSession(session);
  return {
    ...normalized,
    planPreview: normalized.plan.slice(0, 2000),
    checkpoints: normalized.checkpoints.slice(-30),
    iterations: normalized.iterations.slice(-20),
    observations: normalized.observations.slice(-30),
    patches: normalized.patches.slice(-30),
    conflicts: normalized.conflicts.slice(-20)
  };
}

export function createDevSession(input = {}) {
  const goal = String(input.goal || input.prompt || "").trim();
  const session = normalizeDevSession({
    ...input,
    goal,
    title: input.title || titleFromGoal(goal),
    status: "planned",
    steps: input.steps?.length ? input.steps : defaultStepsForGoal(goal),
    checkpoints: [
      ...(input.checkpoints || []),
      { status: "planned", note: "Development session created." }
    ]
  });
  return session;
}

export function transitionDevSession(session = {}, status, patch = {}) {
  const nextStatus = DEV_SESSION_STATUSES.has(status) ? status : session.status || "planned";
  return normalizeDevSession({
    ...session,
    ...patch,
    status: nextStatus,
    updatedAt: now(),
    completedAt: ["done", "failed", "blocked", "ready_for_commit"].includes(nextStatus) ? (patch.completedAt || session.completedAt || now()) : patch.completedAt || session.completedAt || "",
    checkpoints: [
      ...(session.checkpoints || []),
      {
        status: nextStatus,
        note: patch.checkpointNote || statusNote(nextStatus, patch),
        detail: patch.checkpointDetail || {},
        at: now()
      }
    ]
  });
}

export function canRepair(session = {}) {
  const normalized = normalizeDevSession(session);
  return normalized.repairRound < normalized.maxRepairRounds;
}

export function normalizeTestCommand(command = "") {
  const value = String(command || "npm test").trim().replace(/\s+/g, " ");
  return value || "npm test";
}

export function isAllowedTestCommand(command = "") {
  const normalized = normalizeTestCommand(command);
  if (BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  if (/^(?:node\s+--test|npm\s+(?:test|run\s+\S+))\b/i.test(normalized)) {
    const tokens = normalized.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    if (tokens.some((token) => {
      const value = token.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
      return path.isAbsolute(value) || /^[A-Za-z]:\//.test(value) || value.split("/").includes("..")
        || /^(?:--import|--require|-r|--loader|--experimental-loader|--env-file|--test-reporter-destination)(?:=|$)/.test(value);
    })) return false;
  }
  return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function assertAllowedTestCommand(command = "") {
  const normalized = normalizeTestCommand(command);
  if (!isAllowedTestCommand(normalized)) {
    throw Object.assign(new Error(`Dev Session test command is not allowed: ${normalized}`), { statusCode: 403 });
  }
  return normalized;
}

export function normalizeAgentPatch(payload = {}) {
  const files = Array.isArray(payload.files) ? payload.files : [];
  const tests = Array.isArray(payload.tests) ? payload.tests : [];
  return {
    plan: String(payload.plan || payload.summary || "").slice(0, 120000),
    files: files
      .map((file) => ({
        path: String(file.path || "").trim().replaceAll("\\", "/").slice(0, 1000),
        content: String(file.content ?? ""),
        reason: String(file.reason || "").slice(0, 2000),
        replaceFile: file.replaceFile === true
      }))
      .filter((file) => file.path && !path.isAbsolute(file.path) && !file.path.split("/").includes(".."))
      .slice(0, 40),
    diff: String(payload.diff || payload.patch || "").slice(0, 240000),
    tests: tests
      .map((command) => normalizeTestCommand(command))
      .filter(isAllowedTestCommand)
      .slice(0, 8),
    nextAction: String(payload.nextAction || "").slice(0, 12000),
    finalize: normalizeFinalize(payload.finalize || {}),
    steps: Array.isArray(payload.steps) ? payload.steps.map(normalizeStep).slice(0, 80) : []
  };
}

export function parseAgentJson(text = "") {
  const value = String(text || "").trim();
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced || value.match(/\{[\s\S]*\}/)?.[0] || value;
  try {
    return normalizeAgentPatch(JSON.parse(source));
  } catch {
    return normalizeAgentPatch({ plan: value, files: [], tests: [] });
  }
}

export function summarizeTestFailure(output = "", limit = 8000) {
  const lines = String(output || "").split(/\r?\n/);
  const interesting = lines.filter((line) => /not ok|fail|error|exception|expected|actual|assert|timeout|ERR_|SyntaxError|TypeError|ReferenceError/i.test(line));
  const selected = (interesting.length ? interesting : lines.slice(-80)).join("\n");
  return selected.slice(0, limit);
}

export function issueSessionGrant(input = {}) {
  const createdAtMs = Date.now();
  const ttlMs = clampInteger(input.ttlMs, 60_000, 24 * 60 * 60 * 1000, 2 * 60 * 60 * 1000);
  return {
    id: String(input.id || createId("grant")),
    sessionId: String(input.sessionId || ""),
    workspacePath: String(input.workspacePath || ""),
    scope: input.scope === "finalize" ? "finalize" : "dev-session",
    allowedCommands: normalizeStringList(input.allowedCommands || ["npm test", "npm run test:syntax"], 20, 240).filter(isAllowedTestCommand),
    allowedWriteGlobs: normalizeStringList(input.allowedWriteGlobs || ["**/*"], 20, 240),
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(createdAtMs + ttlMs).toISOString(),
    usedAt: "",
    revokedAt: ""
  };
}

export function normalizeSessionGrant(input = {}) {
  return {
    id: String(input.id || createId("grant")),
    sessionId: String(input.sessionId || ""),
    workspacePath: String(input.workspacePath || ""),
    scope: input.scope === "finalize" ? "finalize" : "dev-session",
    allowedCommands: normalizeStringList(input.allowedCommands || [], 20, 240).filter(isAllowedTestCommand),
    allowedWriteGlobs: normalizeStringList(input.allowedWriteGlobs || ["**/*"], 20, 240),
    createdAt: input.createdAt || now(),
    expiresAt: input.expiresAt || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    usedAt: input.usedAt || "",
    revokedAt: input.revokedAt || ""
  };
}

export function validateSessionGrant(grant = {}, { sessionId = "", workspacePath = "", command = "", filePath = "" } = {}) {
  const normalized = normalizeSessionGrant(grant);
  if (!normalized.id || normalized.revokedAt) return { ok: false, reason: "grant_revoked" };
  if (normalized.sessionId !== sessionId) return { ok: false, reason: "session_mismatch" };
  if (normalized.workspacePath && path.resolve(normalized.workspacePath) !== path.resolve(workspacePath || ".")) {
    return { ok: false, reason: "workspace_mismatch" };
  }
  if (new Date(normalized.expiresAt).getTime() <= Date.now()) return { ok: false, reason: "grant_expired" };
  if (command && !normalized.allowedCommands.includes(normalizeTestCommand(command))) return { ok: false, reason: "command_not_allowed" };
  if (filePath) {
    const root = path.resolve(workspacePath || normalized.workspacePath || ".");
    const target = path.resolve(filePath);
    const relative = path.relative(root, target).replace(/\\/g, "/");
    if (!relative || relative === ".") return { ok: false, reason: "write_path_not_allowed" };
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return { ok: false, reason: "write_path_outside_workspace" };
    if (!normalized.allowedWriteGlobs.some((pattern) => globMatches(relative, pattern))) return { ok: false, reason: "write_path_not_allowed" };
  }
  return { ok: true, grant: normalized };
}

function globMatches(value, pattern) {
  const glob = String(pattern || "").replace(/\\/g, "/");
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(String(value || "").replace(/\\/g, "/"));
}

function normalizeStep(step = {}, index = 0) {
  if (typeof step === "string") {
    return { id: createId("step"), title: step.slice(0, 240), status: index === 0 ? "running" : "todo", detail: "" };
  }
  return {
    id: String(step.id || createId("step")),
    title: String(step.title || step.name || `Step ${index + 1}`).slice(0, 240),
    status: ["todo", "running", "done", "skipped", "failed"].includes(step.status) ? step.status : "todo",
    detail: String(step.detail || step.summary || "").slice(0, 4000)
  };
}

function normalizeCheckpoint(checkpoint = {}) {
  return {
    at: checkpoint.at || now(),
    status: String(checkpoint.status || "").slice(0, 80),
    note: String(checkpoint.note || "").slice(0, 12000),
    detail: checkpoint.detail && typeof checkpoint.detail === "object" ? checkpoint.detail : {}
  };
}

function normalizeIteration(iteration = {}) {
  return {
    id: String(iteration.id || createId("iter")),
    round: clampInteger(iteration.round, 0, 100, 0),
    status: String(iteration.status || "planned").slice(0, 80),
    plan: String(iteration.plan || "").slice(0, 120000),
    patchIds: normalizeStringList(iteration.patchIds || [], 80, 120),
    observationIds: normalizeStringList(iteration.observationIds || [], 120, 120),
    testRunId: String(iteration.testRunId || "").slice(0, 120),
    summary: String(iteration.summary || "").slice(0, 12000),
    createdAt: iteration.createdAt || now(),
    updatedAt: iteration.updatedAt || now()
  };
}

function normalizeObservation(observation = {}) {
  return {
    id: String(observation.id || createId("obs")),
    iterationId: observation.iterationId || null,
    type: String(observation.type || "note").slice(0, 80),
    status: String(observation.status || "").slice(0, 80),
    summary: String(observation.summary || "").slice(0, 12000),
    detail: observation.detail && typeof observation.detail === "object" ? observation.detail : {},
    compacted: observation.compacted === true,
    createdAt: observation.createdAt || now()
  };
}

function normalizePatchRecord(patch = {}) {
  return {
    id: String(patch.id || createId("patch")),
    iterationId: patch.iterationId || null,
    path: String(patch.path || "").slice(0, 1000),
    status: ["pending", "applied", "conflicted", "rejected"].includes(patch.status) ? patch.status : "pending",
    mode: String(patch.mode || "diff").slice(0, 40),
    reason: String(patch.reason || "").slice(0, 4000),
    additions: clampInteger(patch.additions, 0, 1_000_000, 0),
    deletions: clampInteger(patch.deletions, 0, 1_000_000, 0),
    changedLines: clampInteger(patch.changedLines, 0, 2_000_000, 0),
    createdAt: patch.createdAt || now()
  };
}

function normalizeConflictRecord(conflict = {}) {
  return {
    id: String(conflict.id || createId("conflict")),
    patchId: conflict.patchId || null,
    path: String(conflict.path || "").slice(0, 1000),
    reason: String(conflict.reason || "context_mismatch").slice(0, 120),
    detail: conflict.detail && typeof conflict.detail === "object" ? conflict.detail : {},
    createdAt: conflict.createdAt || now()
  };
}

function normalizePendingFinalization(input = null) {
  if (!input || typeof input !== "object") return null;
  return {
    action: ["commit", "pr", "comment", "done"].includes(input.action) ? input.action : "done",
    summary: String(input.summary || "").slice(0, 12000),
    connectorId: String(input.connectorId || "").slice(0, 120),
    githubCommentId: input.githubCommentId || null,
    createdAt: input.createdAt || now()
  };
}

function normalizeTestResult(test = null) {
  if (!test || typeof test !== "object") return null;
  return {
    command: normalizeTestCommand(test.command || ""),
    exitCode: Number.isFinite(Number(test.exitCode)) ? Number(test.exitCode) : null,
    status: ["passed", "failed", "skipped"].includes(test.status) ? test.status : Number(test.exitCode) === 0 ? "passed" : "failed",
    output: String(test.output || "").slice(0, 60000),
    summary: String(test.summary || "").slice(0, 12000),
    runId: String(test.runId || ""),
    finishedAt: test.finishedAt || now()
  };
}

function normalizeFinalize(finalize = {}) {
  return {
    commitMessage: String(finalize.commitMessage || "").slice(0, 240),
    prTitle: String(finalize.prTitle || "").slice(0, 240),
    prBody: String(finalize.prBody || "").slice(0, 12000),
    branch: String(finalize.branch || "").slice(0, 240)
  };
}

function normalizeStringList(value, limit, itemLimit) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n|,/) : [];
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean).map((item) => item.slice(0, itemLimit)))].slice(0, limit);
}

function defaultStepsForGoal(goal = "") {
  const label = goal ? titleFromGoal(goal) : "Development task";
  return [
    { title: `Plan: ${label}`, status: "todo" },
    { title: "Apply focused edits", status: "todo" },
    { title: "Run tests", status: "todo" },
    { title: "Repair failures if needed", status: "todo" },
    { title: "Prepare commit and PR notes", status: "todo" }
  ].map(normalizeStep);
}

function titleFromGoal(goal = "") {
  const cleaned = String(goal || "Development task").replace(/\s+/g, " ").trim();
  return (cleaned || "Development task").slice(0, 80);
}

function statusNote(status, patch = {}) {
  if (patch.checkpointNote) return patch.checkpointNote;
  const table = {
    planned: "Plan updated.",
    editing: "Applying model-proposed edits.",
    testing: "Running allowed test command.",
    repairing: "Test failed; preparing next repair round.",
    ready_for_commit: "Tests passed; ready for explicit commit or PR approval.",
    blocked: "Session is blocked.",
    failed: "Session failed.",
    paused: "Session paused.",
    done: "Session completed."
  };
  return table[status] || status;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
