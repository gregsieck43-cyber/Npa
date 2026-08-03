import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");
export const distDir = process.env.NODE_ENV === "test" && process.env.RELEASE_GATE_DIST_DIR
  ? path.resolve(process.env.RELEASE_GATE_DIST_DIR)
  : path.join(root, "dist");
const forbiddenDirectoryNames = new Set([
  ".git",
  ".agents",
  ".claude",
  ".codex",
  ".cache",
  ".tmp",
  ".tools",
  ".packages",
  ".playwright-cli",
  "data",
  "logs",
  "node_modules",
  "output",
  "docs",
  "launcher",
  "test",
  "test-results"
]);
const forbiddenFileNames = new Set([
  "claude.local.md",
  "claude.md",
  "agents.md",
  "项目记忆&状态.md",
  "security-report.json",
  "connector-secrets.key",
  "workbench-master.key",
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".npmrc"
]);

function normalized(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function isForbiddenPackagePath(value) {
  const segments = normalized(value).split("/").filter(Boolean);
  return segments.some((segment) => forbiddenDirectoryNames.has(segment))
    || segments.some((segment) => forbiddenFileNames.has(segment))
    || segments.some((segment) => segment.endsWith(".log") || segment.endsWith(".key") || segment.endsWith(".pem"));
}

async function walk(dir, rows = []) {
  if (!existsSync(dir)) return rows;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(fullPath, rows);
    else rows.push(fullPath);
  }
  return rows;
}

function readUInt16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

async function listZipEntries(zipPath) {
  const buffer = await fs.readFile(zipPath);
  const minEocd = 22;
  let eocd = -1;
  for (let offset = buffer.length - minEocd; offset >= Math.max(0, buffer.length - 0xffff - minEocd); offset -= 1) {
    if (readUInt32(buffer, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error(`Invalid zip: ${zipPath}`);
  const totalEntries = readUInt16(buffer, eocd + 10);
  let cursor = readUInt32(buffer, eocd + 16);
  const entries = [];
  for (let index = 0; index < totalEntries; index += 1) {
    if (readUInt32(buffer, cursor) !== 0x02014b50) throw new Error(`Invalid zip central directory: ${zipPath}`);
    const nameLength = readUInt16(buffer, cursor + 28);
    const extraLength = readUInt16(buffer, cursor + 30);
    const commentLength = readUInt16(buffer, cursor + 32);
    const name = buffer.slice(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    entries.push(name);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function collectReleaseGateIssues(targetDistDir = distDir) {
  const issues = [];
  const requiredFiles = [
    "ClaudeWorkbench.exe",
    "ClaudeWorkbench.zip",
    "ClaudeWorkbench/node.exe",
    "ClaudeWorkbench/node-LICENSE.txt",
    "ClaudeWorkbench/server.js",
    "ClaudeWorkbench/code-cli.js",
    "ClaudeWorkbench/frontend/dist/index.html"
  ];
  if (!existsSync(targetDistDir)) return [`Release directory is missing: ${targetDistDir}`];
  for (const relative of requiredFiles) {
    if (!existsSync(path.join(targetDistDir, ...relative.split("/")))) issues.push(`Required release artifact is missing: ${relative}`);
  }
  const launcherPath = path.join(targetDistDir, "ClaudeWorkbench.exe");
  if (existsSync(launcherPath) && (await fs.stat(launcherPath)).size < 10 * 1024 * 1024) {
    issues.push("Launcher is not a self-contained .NET single-file executable");
  }
  for (const filePath of await walk(targetDistDir)) {
    const relative = path.relative(targetDistDir, filePath);
    if ((await fs.lstat(filePath)).isSymbolicLink()) issues.push(`Packaged directory contains a symbolic link: ${relative}`);
    if (isForbiddenPackagePath(relative)) issues.push(`Packaged directory contains forbidden local artifact: ${relative}`);
  }

  const zipPath = path.join(targetDistDir, "ClaudeWorkbench.zip");
  if (existsSync(zipPath)) {
    const entries = await listZipEntries(zipPath);
    const normalizedEntries = new Set(entries.map((entry) => String(entry).replace(/\\/g, "/")));
    const requiredZipEntries = [
      "ClaudeWorkbench.exe",
      "ClaudeWorkbench/node.exe",
      "ClaudeWorkbench/node-LICENSE.txt",
      "ClaudeWorkbench/server.js",
      "ClaudeWorkbench/code-cli.js",
      "ClaudeWorkbench/frontend/dist/index.html"
    ];
    for (const entry of requiredZipEntries) {
      if (!normalizedEntries.has(entry)) issues.push(`Packaged zip is missing required artifact: ${entry}`);
    }
    for (const entry of entries) {
      if (isForbiddenPackagePath(entry)) issues.push(`Packaged zip contains forbidden local artifact: ${entry}`);
    }
  }
  return issues;
}

async function main() {
  const issues = await collectReleaseGateIssues(distDir);

  if (issues.length) {
    console.error(`RELEASE_GATE_FAILED issues=${issues.length}`);
    for (const issue of issues) console.error(`- ${issue}`);
    process.exitCode = 1;
    return;
  }
  console.log("RELEASE_GATE_OK issues=0");
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(`RELEASE_GATE_FAILED ${error.message}`);
    process.exitCode = 1;
  });
}
