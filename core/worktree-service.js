import { execFile as nodeExecFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const defaultExecFile = promisify(nodeExecFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEST_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const WORKTREE_DIRECTORY = ".worktrees";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REV_PATTERN = /^[A-Za-z0-9_./@~^:-]{1,240}$/;
const TEST_EXECUTABLES = new Set([
  "node",
  "node.exe",
  "npm",
  "npm.cmd",
  "pnpm",
  "pnpm.cmd",
  "yarn",
  "yarn.cmd",
  "dotnet"
]);

/** Error raised when a caller attempts to escape the worktree namespace. */
export class WorktreeSecurityError extends Error {
  constructor(message, code = "worktree_security_error") {
    super(message);
    this.name = "WorktreeSecurityError";
    this.code = code;
    this.statusCode = 403;
  }
}

/** Error raised for an invalid or unsupported worktree operation. */
export class WorktreeOperationError extends Error {
  constructor(message, code = "worktree_operation_error", cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "WorktreeOperationError";
    this.code = code;
    this.statusCode = 400;
  }
}

/**
 * Return a short, deterministic branch suffix for a run identifier.
 * `run-`/`run_` prefixes are removed so the final branch remains
 * `codex/run-<short-id>` rather than `codex/run-run-...`.
 */
export function shortIdForRun(runId, explicitShortId = "") {
  const explicit = String(explicitShortId || "").trim();
  if (explicit && !SHORT_ID_PATTERN.test(explicit)) {
    throw new WorktreeSecurityError("Invalid run short id", "invalid_short_id");
  }
  const source = explicit || String(runId || "").replace(/^run[-_]/i, "");
  const normalized = explicit ? source : source.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || !SHORT_ID_PATTERN.test(normalized)) {
    throw new WorktreeSecurityError("Invalid run short id", "invalid_short_id");
  }
  return normalized.slice(0, 32);
}

/** Return the required branch name for a run. */
export function branchNameForRun(runId, explicitShortId = "") {
  return `codex/run-${shortIdForRun(runId, explicitShortId)}`;
}

function assertRunId(runId) {
  const value = String(runId ?? "").trim();
  if (!RUN_ID_PATTERN.test(value) || value === "." || value === "..") {
    throw new WorktreeSecurityError("Invalid run id", "invalid_run_id");
  }
  return value;
}

function assertInside(baseDir, targetPath) {
  const base = resolve(baseDir);
  const target = resolve(targetPath);
  const relativePath = relative(base, target);
  if (relativePath === "" || relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new WorktreeSecurityError("Path is outside the repository", "path_outside_repository");
  }
  return target;
}

function assertNoSymlink(pathValue, label) {
  if (!existsSync(pathValue)) return;
  let info;
  try {
    info = lstatSync(pathValue);
  } catch (error) {
    throw new WorktreeOperationError(`Unable to inspect ${label}`, "path_inspection_failed", error);
  }
  if (info.isSymbolicLink()) {
    throw new WorktreeSecurityError(`${label} cannot be a symbolic link`, "symlink_not_allowed");
  }
}

/** Return the absolute path reserved for a run's worktree. */
export function worktreePathForRun(rootDir, runId) {
  const root = resolve(String(rootDir || process.cwd()));
  const id = assertRunId(runId);
  const worktreesRoot = assertInside(root, join(root, WORKTREE_DIRECTORY));
  assertNoSymlink(worktreesRoot, "worktrees directory");
  const target = assertInside(worktreesRoot, join(worktreesRoot, id));
  assertNoSymlink(target, "worktree path");
  return target;
}

function validateRevision(value, label = "revision") {
  const revision = String(value || "").trim();
  if (!REV_PATTERN.test(revision) || revision.startsWith("-")) {
    throw new WorktreeSecurityError(`Invalid git ${label}`, "invalid_git_revision");
  }
  return revision;
}

function validateRelativePath(value) {
  const input = String(value ?? "");
  if (!input || /[\0\u0001-\u001f]/.test(input) || isAbsolute(input) || /^[A-Za-z]:/.test(input)) {
    throw new WorktreeSecurityError("Commit path must stay inside the worktree", "invalid_commit_path");
  }
  const normalized = input.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.includes("..") || normalized.startsWith("../") || normalized === "..") {
    throw new WorktreeSecurityError("Commit path must stay inside the worktree", "invalid_commit_path");
  }
  return normalized || ".";
}

function normalizeWorktreeInput(runIdOrInput, options = {}) {
  if (runIdOrInput && typeof runIdOrInput === "object" && !Array.isArray(runIdOrInput)) {
    return { ...runIdOrInput, ...options, runId: runIdOrInput.runId ?? runIdOrInput.id };
  }
  return { ...options, runId: runIdOrInput };
}

function normalizeGitError(error, args, cwd) {
  if (error instanceof WorktreeSecurityError || error instanceof WorktreeOperationError) return error;
  const detail = String(error?.stderr || error?.message || "git command failed").trim();
  const wrapped = new WorktreeOperationError(`git ${args.join(" ")} failed: ${detail}`, "git_command_failed", error);
  wrapped.args = args;
  wrapped.cwd = cwd;
  wrapped.stdout = error?.stdout || "";
  wrapped.stderr = error?.stderr || "";
  wrapped.exitCode = typeof error?.code === "number" ? error.code : null;
  return wrapped;
}

function parseStatus(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("##")) || "";
  const entries = lines
    .filter((line) => !line.startsWith("##"))
    .map((line) => {
      const match = line.match(/^(.{2})\s+(.*)$/);
      if (!match) return { code: "", path: line };
      return { code: match[1], path: match[2] };
    });
  const branch = branchLine.replace(/^##\s*/, "").split("...")[0].trim();
  return { branch, entries, clean: entries.length === 0 };
}

function parseCommandString(command) {
  const source = String(command || "").trim();
  if (!source) throw new WorktreeOperationError("Test command cannot be empty", "empty_test_command");
  if (/[;&|<>`$\n\r\0]/.test(source)) {
    throw new WorktreeSecurityError("Shell operators are not allowed in test commands", "shell_operator_not_allowed");
  }
  const parts = source.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|\S+/g);
  if (!parts?.length) throw new WorktreeOperationError("Test command cannot be empty", "empty_test_command");
  return parts.map((part) => part.replace(/^['"]|['"]$/g, ""));
}

function executableName(file) {
  return basename(String(file || "")).toLowerCase();
}

function validateTestCommand(spec, allowedExecutables) {
  let parts;
  if (Array.isArray(spec?.command)) parts = spec.command.map(String);
  else if (typeof spec?.command === "string") parts = parseCommandString(spec.command);
  else {
    const file = spec?.file || spec?.executable;
    const args = spec?.args === undefined ? [] : spec.args;
    if (!file || !Array.isArray(args)) throw new WorktreeOperationError("Test command must provide file and args", "invalid_test_command");
    parts = [String(file), ...args.map(String)];
  }
  const file = parts.shift();
  if (!file || parts.some((part) => part.includes("\0"))) throw new WorktreeSecurityError("Invalid test command", "invalid_test_command");
  const name = executableName(file);
  const processName = executableName(process.execPath);
  const isProcessNode = isAbsolute(file) && resolve(file) === resolve(process.execPath);
  if (isAbsolute(file) && !isProcessNode) throw new WorktreeSecurityError("Absolute executable paths are not allowed", "absolute_executable_not_allowed");
  if (!isProcessNode && /[\\/]/.test(file)) throw new WorktreeSecurityError("Executable must be resolved from the trusted PATH", "executable_path_not_allowed");
  const allowed = allowedExecutables.has(name) || name === processName || isProcessNode;
  if (!allowed) throw new WorktreeSecurityError(`Test executable is not allowed: ${name}`, "test_executable_not_allowed");
  if (parts.length > 100 || parts.some((part) => part.length > 4000)) throw new WorktreeOperationError("Test command is too large", "test_command_too_large");
  validateTestArguments(name, parts);
  return { file, args: parts };
}

function validateTestArguments(name, args) {
  for (const arg of args) {
    const value = String(arg).replace(/\\/g, "/");
    if (isAbsolute(arg) || /^[A-Za-z]:\//.test(value) || value.split("/").includes("..")) {
      throw new WorktreeSecurityError("Test arguments must stay inside the worktree", "test_path_outside_worktree");
    }
  }
  if (["node", "node.exe", executableName(process.execPath)].includes(name)) {
    if (args[0] !== "--test") throw new WorktreeSecurityError("Node test commands must use --test", "test_arguments_not_allowed");
    if (args.some((arg) => ["-e", "--eval", "-p", "--print"].includes(arg))) throw new WorktreeSecurityError("Node eval flags are not allowed", "test_arguments_not_allowed");
    if (args.some((arg) => /^(?:--import|--require|-r|--loader|--experimental-loader|--env-file)(?:=|$)/.test(arg) || /^--test-reporter-destination(?:=|$)/.test(arg))) {
      throw new WorktreeSecurityError("Node preload and external output flags are not allowed", "test_arguments_not_allowed");
    }
    return;
  }
  if (["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"].includes(name)) {
    const script = args[0] === "run" ? args[1] : args[0];
    if (!["test", "build", "typecheck", "lint", "check"].includes(String(script || "").toLowerCase())) {
      throw new WorktreeSecurityError("Package command is outside the test/build allowlist", "test_arguments_not_allowed");
    }
    return;
  }
  if (name === "dotnet" && !["test", "build"].includes(String(args[0] || "").toLowerCase())) {
    throw new WorktreeSecurityError("dotnet command is outside the test/build allowlist", "test_arguments_not_allowed");
  }
}

function normalizeCommitMessage(message) {
  const value = String(message ?? "").trim();
  if (!value) throw new WorktreeOperationError("Commit message cannot be empty", "empty_commit_message");
  if (value.length > 5000 || value.includes("\0")) throw new WorktreeOperationError("Commit message is invalid", "invalid_commit_message");
  return value;
}

function parseCommit(stdout, { runId = "", path = "", ref = "HEAD" } = {}) {
  const raw = String(stdout || "").trimEnd();
  const fields = raw.split("\0");
  const hash = String(fields[0] || "").trim();
  const parents = String(fields[1] || "").trim().split(/\s+/).filter(Boolean);
  const commit = {
    runId,
    path,
    ref,
    hash,
    id: hash,
    parents,
    author: fields[2] || "",
    email: fields[3] || "",
    date: fields[4] || "",
    subject: String(fields[5] || "").replace(/\r?\n$/, ""),
    stdout: raw
  };
  if (!/^[0-9a-f]{40}$/i.test(hash)) throw new WorktreeOperationError("Git did not return a commit", "invalid_commit_result");
  return commit;
}

/**
 * Create a secure, dependency-free wrapper around Git worktree operations.
 * Merge, push, and delete are deliberately not exposed by this service.
 */
export function createWorktreeService(options = {}) {
  const rootDir = resolve(String(options.rootDir || options.repoRoot || process.cwd()));
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs || options.timeout || DEFAULT_TIMEOUT_MS));
  const execFile = options.execFile || defaultExecFile;
  const allowedExecutables = new Set([...(options.allowedTestExecutables || []), ...TEST_EXECUTABLES]);
  const testRecords = new Map();

  function pathsFor(runId) {
    const id = assertRunId(runId);
    const worktreesRoot = assertInside(rootDir, join(rootDir, WORKTREE_DIRECTORY));
    const path = worktreePathForRun(rootDir, id);
    return { runId: id, rootDir, worktreesRoot, path, worktreePath: path, relativePath: relative(rootDir, path).replace(/\\/g, "/") };
  }

  async function execute(file, args, cwd, optionsForCommand = {}) {
    const commandOptions = {
      cwd,
      windowsHide: true,
      timeout: Math.max(1_000, Number(optionsForCommand.timeoutMs || optionsForCommand.timeout || timeoutMs)),
      maxBuffer: MAX_BUFFER,
      ...optionsForCommand,
      env: scrubChildEnvironment(optionsForCommand.env || process.env)
    };
    try {
      return await execFile(file, args, commandOptions);
    } catch (error) {
      throw normalizeGitError(error, [file, ...args], cwd);
    }
  }

  async function runGit(args, cwd = rootDir, optionsForCommand = {}) {
    return execute("git", args, cwd, optionsForCommand);
  }

  async function ensureWorktreeDirectory(paths) {
    assertNoSymlink(rootDir, "repository root");
    assertNoSymlink(paths.worktreesRoot, "worktrees directory");
    await mkdir(paths.worktreesRoot, { recursive: true });
    assertNoSymlink(paths.worktreesRoot, "worktrees directory");
  }

  async function assertWorktree(paths) {
    assertInside(rootDir, paths.path);
    assertNoSymlink(paths.worktreesRoot, "worktrees directory");
    let info;
    try {
      info = await stat(paths.path);
    } catch (error) {
      if (error?.code === "ENOENT") throw new WorktreeOperationError(`Worktree does not exist: ${paths.runId}`, "worktree_not_found");
      throw new WorktreeOperationError(`Unable to inspect worktree: ${paths.runId}`, "worktree_inspection_failed", error);
    }
    if (!info.isDirectory()) throw new WorktreeOperationError(`Worktree is not a directory: ${paths.runId}`, "invalid_worktree_path");
    assertNoSymlink(paths.path, "worktree path");
  }

  async function createWorktree(runIdOrInput, maybeOptions = {}) {
    const input = normalizeWorktreeInput(runIdOrInput, maybeOptions);
    const paths = pathsFor(input.runId);
    const branch = branchNameForRun(paths.runId, input.shortId);
    const baseRef = validateRevision(input.baseRef || input.baseBranch || input.startPoint || "HEAD", "base ref");
    await ensureWorktreeDirectory(paths);
    if (existsSync(paths.path)) throw new WorktreeOperationError(`Worktree already exists: ${paths.runId}`, "worktree_exists");
    await runGit(["worktree", "add", "-b", branch, paths.path, baseRef], rootDir);
    return { ...paths, branch, branchName: branch, baseRef };
  }

  async function status(runIdOrInput) {
    const input = normalizeWorktreeInput(runIdOrInput);
    const paths = pathsFor(input.runId);
    await assertWorktree(paths);
    const result = await runGit(["status", "--short", "--branch"], paths.path);
    const parsed = parseStatus(result.stdout);
    return { ...paths, ...parsed, status: result.stdout, stdout: result.stdout, stderr: result.stderr || "" };
  }

  async function diff(runIdOrInput, maybeOptions = {}) {
    const input = normalizeWorktreeInput(runIdOrInput, maybeOptions);
    const paths = pathsFor(input.runId);
    await assertWorktree(paths);
    const args = ["diff", "--no-ext-diff"];
    if (input.staged === true || input.cached === true) args.push("--cached");
    args.push("--", ".");
    const result = await runGit(args, paths.path);
    return { ...paths, staged: input.staged === true || input.cached === true, diff: result.stdout, stdout: result.stdout, stderr: result.stderr || "" };
  }

  function recordTest(runIdOrInput, maybeRecord = {}) {
    const input = normalizeWorktreeInput(runIdOrInput, maybeRecord);
    const paths = pathsFor(input.runId);
    const record = input.record && typeof input.record === "object" ? input.record : input;
    const now = new Date().toISOString();
    const normalized = {
      id: String(record.id || `test_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`),
      runId: paths.runId,
      status: ["passed", "failed", "skipped", "running"].includes(record.status) ? record.status : record.passed === true ? "passed" : "failed",
      passed: record.passed === true || record.status === "passed",
      command: Array.isArray(record.command) ? record.command.map(String) : record.command ? String(record.command) : [],
      label: String(record.label || "").slice(0, 240),
      note: String(record.note || "").slice(0, 4000),
      exitCode: Number.isInteger(record.exitCode) ? record.exitCode : null,
      stdout: String(record.stdout || ""),
      stderr: String(record.stderr || ""),
      startedAt: record.startedAt || now,
      completedAt: record.completedAt || now,
      recordedAt: now,
      metadata: record.metadata && typeof record.metadata === "object" ? record.metadata : {}
    };
    const rows = testRecords.get(paths.runId) || [];
    rows.push(normalized);
    testRecords.set(paths.runId, rows.slice(-200));
    return normalized;
  }

  function listTests(runIdOrInput) {
    const input = normalizeWorktreeInput(runIdOrInput);
    const id = assertRunId(input.runId);
    return [...(testRecords.get(id) || [])];
  }

  async function runTest(runIdOrInput, maybeSpec = {}) {
    const input = normalizeWorktreeInput(runIdOrInput, maybeSpec);
    const paths = pathsFor(input.runId);
    await assertWorktree(paths);
    const command = validateTestCommand(input, allowedExecutables);
    const startedAt = new Date().toISOString();
    try {
      const result = await execute(command.file, command.args, paths.path, { timeout: Math.min(MAX_TEST_TIMEOUT_MS, Math.max(1_000, Number(input.timeoutMs || input.timeout || timeoutMs))) });
      return recordTest(paths.runId, {
        id: input.id,
        command: [command.file, ...command.args],
        label: input.label,
        note: input.note,
        status: "passed",
        passed: true,
        exitCode: 0,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        startedAt,
        completedAt: new Date().toISOString(),
        metadata: input.metadata
      });
    } catch (error) {
      const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : typeof error?.code === "number" ? error.code : 1;
      const failed = recordTest(paths.runId, {
        id: input.id,
        command: [command.file, ...command.args],
        label: input.label,
        note: input.note,
        status: "failed",
        passed: false,
        exitCode,
        stdout: error?.stdout || "",
        stderr: error?.stderr || error?.message || "",
        startedAt,
        completedAt: new Date().toISOString(),
        metadata: input.metadata
      });
      error.testRecord = failed;
      if (input.throwOnFailure === true) throw error;
      return failed;
    }
  }

  async function queryCommit(runIdOrInput, maybeRef = "HEAD") {
    const input = normalizeWorktreeInput(runIdOrInput, typeof maybeRef === "object" ? maybeRef : { ref: maybeRef });
    const paths = pathsFor(input.runId);
    await assertWorktree(paths);
    const ref = validateRevision(input.ref || "HEAD");
    const result = await runGit(["show", "-s", "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s", ref], paths.path);
    return parseCommit(result.stdout, { runId: paths.runId, path: paths.path, ref });
  }

  async function createCommit(runIdOrInput, maybeOptions = {}) {
    const input = normalizeWorktreeInput(runIdOrInput, maybeOptions);
    const paths = pathsFor(input.runId);
    await assertWorktree(paths);
    const message = normalizeCommitMessage(input.message || input.commitMessage);
    const commitPaths = input.paths === undefined ? ["."] : (Array.isArray(input.paths) ? input.paths : [input.paths]).map(validateRelativePath);
    const addArgs = ["add", "--all", "--", ...commitPaths];
    await runGit(addArgs, paths.path);
    const commitArgs = ["commit", "-m", message];
    if (input.allowEmpty === true) commitArgs.push("--allow-empty");
    await runGit(commitArgs, paths.path);
    const commit = await queryCommit(paths.runId, "HEAD");
    return { ...paths, branch: commitBranch(commit, await status(paths.runId)), message, commit, commitInfo: commit };
  }

  function commitBranch(commit, statusResult) {
    return statusResult.branch || commit.branch || "";
  }

  return {
    rootDir,
    worktreeDirectory: WORKTREE_DIRECTORY,
    pathForRun: (runId) => worktreePathForRun(rootDir, runId),
    worktreePath: (runId) => worktreePathForRun(rootDir, runId),
    branchForRun: branchNameForRun,
    branchName: branchNameForRun,
    createWorktree,
    create: createWorktree,
    status,
    getStatus: status,
    getWorktreeStatus: status,
    diff,
    getDiff: diff,
    getWorktreeDiff: diff,
    recordTest,
    recordTestResult: recordTest,
    runTest,
    test: runTest,
    runTestCommand: runTest,
    listTests,
    queryCommit,
    getCommit: queryCommit,
    getCommitInfo: queryCommit,
    createCommit,
    commit: createCommit,
    createAtomicCommit: createCommit
  };
}

/** Class form kept for callers that prefer an injectable service instance. */
export class WorktreeService {
  constructor(options = {}) {
    Object.assign(this, createWorktreeService(options));
  }
}

export const WorktreeManager = WorktreeService;

/** Convenience one-shot creator for callers that do not need a service object. */
export async function createWorktree(input = {}, runId, options = {}) {
  if (typeof input === "string") {
    const service = createWorktreeService({ rootDir: input });
    return service.createWorktree(runId, options);
  }
  const service = createWorktreeService(input);
  return service.createWorktree(input);
}

export const getWorktreePath = worktreePathForRun;
export const getWorktreeBranch = branchNameForRun;

export function scrubChildEnvironment(input = process.env) {
  const output = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (/NODE_TEST_CONTEXT|NODE_TEST_WORKER_ID|NODE_OPTIONS/i.test(key)) continue;
    if (/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|AUTHORIZATION|COOKIE|SESSION)/i.test(key)) continue;
    output[key] = value;
  }
  output.GIT_TERMINAL_PROMPT = "0";
  output.GCM_INTERACTIVE = "Never";
  return output;
}
