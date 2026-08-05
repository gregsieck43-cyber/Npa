import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";

import { collectReleaseGateIssues } from "../tools/release-gate.js";

async function makeRelease(name) {
  const root = path.resolve(".tmp", "tests", `${name}-${process.pid}-${Date.now()}`);
  const required = [
    "ClaudeWorkbench.exe",
    "ClaudeWorkbench.zip",
    "ClaudeWorkbench/node.exe",
    "ClaudeWorkbench/node-LICENSE.txt",
    "ClaudeWorkbench/LICENSE",
    "ClaudeWorkbench/server.js",
    "ClaudeWorkbench/code-cli.js",
    "ClaudeWorkbench/frontend/dist/index.html",
    "ClaudeWorkbench/frontend/dist/favicon.ico",
    "ClaudeWorkbench/frontend/dist/npa-mark.png"
  ];
  for (const relative of required) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    const content = relative.endsWith(".html")
      ? '<title>NPA · 本地智能工作台</title><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/npa-mark.png">'
      : relative.endsWith(".ico")
        ? Buffer.from([0x00, 0x00, 0x01, 0x00, 0x00, 0x00])
        : relative.endsWith(".png")
          ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
          : relative.endsWith(".zip") ? minimalZip([
      "ClaudeWorkbench.exe",
      "ClaudeWorkbench/node.exe",
      "ClaudeWorkbench/node-LICENSE.txt",
      "ClaudeWorkbench/LICENSE",
      "ClaudeWorkbench/server.js",
      "ClaudeWorkbench/code-cli.js",
      "ClaudeWorkbench/frontend/dist/index.html",
      "ClaudeWorkbench/frontend/dist/favicon.ico",
      "ClaudeWorkbench/frontend/dist/npa-mark.png"
    ]) : "release-test";
    await writeFile(target, content);
    if (relative === "ClaudeWorkbench.exe") await truncate(target, 11 * 1024 * 1024);
  }
  return root;
}

test("release gate requires the launcher, runtime, license, backend, CLI and built frontend", async () => {
  const root = await makeRelease("release-ok");
  try {
    assert.deepEqual(await collectReleaseGateIssues(root), []);
    await rm(path.join(root, "ClaudeWorkbench", "LICENSE"));
    assert.ok((await collectReleaseGateIssues(root)).some((issue) => issue.includes("LICENSE")));
    await rm(path.join(root, "ClaudeWorkbench", "node.exe"));
    assert.ok((await collectReleaseGateIssues(root)).some((issue) => issue.includes("node.exe")));
    await writeFile(path.join(root, "ClaudeWorkbench", "frontend", "dist", "npa-mark.png"), "not-a-png");
    assert.ok((await collectReleaseGateIssues(root)).some((issue) => issue.includes("invalid file signature")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release gate rejects credentials, local data, caches and logs", async () => {
  const root = await makeRelease("release-secret");
  try {
    const secret = path.join(root, "ClaudeWorkbench", "data", "workbench-master.key");
    await mkdir(path.dirname(secret), { recursive: true });
    await writeFile(secret, "secret");
    const log = path.join(root, "ClaudeWorkbench", "server.log");
    await writeFile(log, "private");
    const rules = path.join(root, "ClaudeWorkbench", ".agents", "rules.md");
    await mkdir(path.dirname(rules), { recursive: true });
    await writeFile(rules, "local rule");
    const issues = await collectReleaseGateIssues(root);
    assert.ok(issues.some((issue) => issue.includes("data")));
    assert.ok(issues.some((issue) => issue.includes("server.log")));
    assert.ok(issues.some((issue) => issue.includes(".agents")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release gate rejects development metadata and source-only logo input", async () => {
  const root = await makeRelease("release-development-metadata");
  try {
    const githubWorkflow = path.join(root, "ClaudeWorkbench", ".github", "workflows", "ci.yml");
    await mkdir(path.dirname(githubWorkflow), { recursive: true });
    await writeFile(githubWorkflow, "name: CI");
    await writeFile(path.join(root, "ClaudeWorkbench", "LOGO.png"), "source-only");
    const issues = await collectReleaseGateIssues(root);
    assert.ok(issues.some((issue) => issue.includes(".github")));
    assert.ok(issues.some((issue) => issue.toLowerCase().includes("logo.png")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function minimalZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name);

    const row = Buffer.alloc(46);
    row.writeUInt32LE(0x02014b50, 0);
    row.writeUInt16LE(20, 4);
    row.writeUInt16LE(20, 6);
    row.writeUInt16LE(name.length, 28);
    row.writeUInt32LE(offset, 42);
    central.push(row, name);
    offset += local.length + name.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}
