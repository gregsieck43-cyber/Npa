import assert from "node:assert/strict";
import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  branchNameForRun,
  createWorktreeService,
  worktreePathForRun
} from "../core/worktree-service.js";

const execFile = promisify(nodeExecFile);

async function git(cwd, args) {
  return execFile("git", args, { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
}

async function makeRepository() {
  const parent = resolve(process.cwd(), ".tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "worktree-service-"));
  await git(root, ["init", "--initial-branch", "main"]);
  await git(root, ["config", "user.name", "Workbench Tests"]);
  await git(root, ["config", "user.email", "workbench-tests@example.invalid"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await writeFile(join(root, "README.md"), "initial\n", "utf8");
  await git(root, ["add", "--", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

test("worktree paths and branches are constrained to the run namespace", () => {
  const root = resolve(process.cwd(), ".tmp", "repo");
  assert.equal(branchNameForRun("run-abc123"), "codex/run-abc123");
  assert.equal(branchNameForRun("abc123"), "codex/run-abc123");
  assert.equal(branchNameForRun("run_ABC", "short-1"), "codex/run-short-1");
  assert.equal(worktreePathForRun(root, "run-abc123"), join(root, ".worktrees", "run-abc123"));
  assert.throws(() => worktreePathForRun(root, "../outside"), /run id|path|invalid/i);
  assert.throws(() => worktreePathForRun(root, "nested/run"), /run id|path|invalid/i);
});

test("creates an isolated worktree, reports status and diff, and records tests", async (t) => {
  const root = await makeRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createWorktreeService({ rootDir: root });
  const runId = "run-abc123";

  const created = await service.createWorktree(runId);
  assert.equal(created.runId, runId);
  assert.equal(created.branch, "codex/run-abc123");
  assert.equal(relative(root, created.path), join(".worktrees", runId));
  assert.equal(await readFile(join(created.path, "README.md"), "utf8"), "initial\n");

  const clean = await service.status(runId);
  assert.equal(clean.branch, created.branch);
  assert.equal(clean.clean, true);
  assert.equal(clean.entries.length, 0);

  await writeFile(join(created.path, "README.md"), "changed\n", "utf8");
  const dirty = await service.status(runId);
  assert.equal(dirty.clean, false);
  assert.equal(dirty.entries[0].path, "README.md");
  const diff = await service.diff(runId);
  assert.match(diff.diff, /changed/);

  await writeFile(join(created.path, "pass.test.mjs"), "import test from 'node:test'; test('ok', () => {});\n", "utf8");
  const testResult = await service.runTest(runId, {
    file: process.execPath,
    args: ["--test", "pass.test.mjs"],
    label: "node smoke"
  });
  assert.equal(testResult.status, "passed");
  assert.equal(testResult.passed, true);
  assert.equal(testResult.exitCode, 0);
  assert.equal(service.listTests(runId).length, 1);
  const failedTest = await service.runTest(runId, {
    file: process.execPath,
    args: ["--test", "missing.test.mjs"],
    label: "expected failure"
  });
  assert.equal(failedTest.status, "failed");
  assert.equal(failedTest.passed, false);

  const recorded = service.recordTest(runId, { status: "skipped", command: ["node", "--version"], note: "manual" });
  assert.equal(recorded.status, "skipped");
  assert.equal(service.listTests(runId).length, 3);
});

test("queries and creates commits without exposing merge, push, or delete operations", async (t) => {
  const root = await makeRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createWorktreeService({ rootDir: root });
  const runId = "run-commit123";
  await service.createWorktree(runId);
  const before = await service.queryCommit(runId);
  assert.equal(before.subject, "initial");
  assert.match(before.hash, /^[0-9a-f]{40}$/);

  const worktree = worktreePathForRun(root, runId);
  await writeFile(join(worktree, "README.md"), "committed\n", "utf8");
  const created = await service.createCommit(runId, { message: "worktree change" });
  assert.equal(created.commit.subject, "worktree change");
  assert.match(created.commit.hash, /^[0-9a-f]{40}$/);
  assert.notEqual(created.commit.hash, before.hash);
  assert.equal((await service.status(runId)).clean, true);
  assert.equal(service.merge, undefined);
  assert.equal(service.push, undefined);
  assert.equal(service.delete, undefined);
});

test("rejects path/ref/command injection and duplicate worktrees", async (t) => {
  const root = await makeRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createWorktreeService({ rootDir: root });

  await assert.rejects(() => service.createWorktree("run/../../escape"), /run id|path|invalid/i);
  await assert.rejects(() => service.createWorktree("run-safe", { baseRef: "--upload-pack=evil" }), /ref|invalid/i);
  const created = await service.createWorktree("run-safe");
  await assert.rejects(() => service.createWorktree("run-safe"), /exist|already|worktree/i);
  await assert.rejects(() => service.runTest("run-safe", { command: "node -e ok; whoami" }), /shell|unsafe|command/i);
  await assert.rejects(() => service.runTest("run-safe", { file: "C:\\attacker\\node.exe", args: ["--test"] }), /absolute|path|allowed/i);
  await assert.rejects(() => service.runTest("run-safe", { command: "node -e process.exit(0)" }), /test|arguments|eval|allow/i);
  await assert.rejects(() => service.runTest("run-safe", { command: "node --test ..\\outside.test.mjs" }), /inside|path|worktree/i);
  await assert.rejects(() => service.createCommit("run-safe", { message: "   " }), /message|empty/i);
  assert.ok(created.path.startsWith(join(root, ".worktrees")));
});
