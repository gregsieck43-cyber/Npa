import crypto from "node:crypto";
import path from "node:path";

function now() {
  return new Date().toISOString();
}

export function normalizePatchInput(input = {}) {
  const diff = String(input.diff || input.patch || "").trim();
  const files = Array.isArray(input.files) ? input.files : [];
  return {
    diff,
    files: files.map((file) => ({
      path: String(file.path || "").trim().replaceAll("\\", "/").slice(0, 1000),
      content: String(file.content ?? ""),
      reason: String(file.reason || "").slice(0, 2000),
      replaceFile: file.replaceFile === true
    })).filter((file) => file.path).slice(0, 40)
  };
}

export function parseUnifiedDiff(diff = "") {
  const lines = String(diff || "").replace(/\r\n/g, "\n").split("\n");
  const files = [];
  let current = null;
  let hunk = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      current = { oldPath: "", newPath: "", hunks: [] };
      hunk = null;
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match) {
        current.oldPath = cleanDiffPath(match[1]);
        current.newPath = cleanDiffPath(match[2]);
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      current ||= { oldPath: "", newPath: "", hunks: [] };
      current.oldPath = cleanDiffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      current ||= { oldPath: "", newPath: "", hunks: [] };
      current.newPath = cleanDiffPath(line.slice(4));
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      current ||= { oldPath: "", newPath: "", hunks: [] };
      hunk = {
        oldStart: Number(hunkMatch[1]),
        oldCount: Number(hunkMatch[2] || 1),
        newStart: Number(hunkMatch[3]),
        newCount: Number(hunkMatch[4] || 1),
        lines: []
      };
      current.hunks.push(hunk);
      continue;
    }
    if (hunk && (/^[ +\-\\]/.test(line) || line === "")) {
      hunk.lines.push(line);
    }
  }
  if (current) files.push(current);
  return files
    .map((file) => ({ ...file, path: file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.oldPath }))
    .filter((file) => file.path && file.hunks.length);
}

export function analyzePatch(diff = "") {
  const files = parseUnifiedDiff(diff);
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) additions += 1;
        else if (line.startsWith("-")) deletions += 1;
      }
    }
  }
  return { files: files.length, additions, deletions, changedLines: additions + deletions };
}

export async function applyUnifiedDiff({ diff = "", workspace = "", readFile, writeFile, mkdir } = {}) {
  const plan = await planUnifiedDiff({ diff, workspace, readFile });
  if (plan.status === "conflicted") return { status: plan.status, summary: plan.summary, results: plan.results };
  for (const write of plan.writes) {
    await mkdir(path.dirname(write.target));
    await writeFile(write.target, write.content);
  }
  return { status: plan.status, summary: plan.summary, results: plan.results };
}

export async function planUnifiedDiff({ diff = "", workspace = "", readFile } = {}) {
  const parsed = parseUnifiedDiff(diff);
  const results = [];
  const writes = [];
  for (const file of parsed) {
    if (!isSafeRelativePath(file.path)) {
      results.push(conflictResult(file.path, "unsafe_path"));
      continue;
    }
    const target = path.resolve(workspace, file.path);
    let oldText = "";
    let existed = true;
    try {
      oldText = await readFile(target);
    } catch (error) {
      existed = false;
      oldText = "";
    }
    const applied = applyFilePatch(oldText, file, { existed });
    if (!applied.ok) {
      results.push({ ...conflictResult(file.path, applied.reason), target, conflicts: applied.conflicts || [] });
      continue;
    }
    const result = {
      id: patchId("patch"),
      path: file.path,
      target,
      status: "applied",
      existed,
      additions: applied.additions,
      deletions: applied.deletions,
      changedLines: applied.additions + applied.deletions,
      beforeSha256: sha256(oldText),
      afterSha256: sha256(applied.content),
      createdAt: now()
    };
    results.push(result);
    writes.push({ target, content: applied.content, result });
  }
  return {
    status: results.some((item) => item.status === "conflicted") ? "conflicted" : "applied",
    summary: summarizePatchResults(results),
    results,
    writes
  };
}

export async function applyReplacementFiles({ files = [], workspace = "", readFile, writeFile, mkdir, maxReplaceBytes = 240000 } = {}) {
  const plan = await planReplacementFiles({ files, workspace, readFile, maxReplaceBytes });
  if (plan.status === "conflicted") return { status: plan.status, summary: plan.summary, results: plan.results };
  for (const write of plan.writes) {
    await mkdir(path.dirname(write.target));
    await writeFile(write.target, write.content);
  }
  return { status: plan.status, summary: plan.summary, results: plan.results };
}

export async function planReplacementFiles({ files = [], workspace = "", readFile, maxReplaceBytes = 240000 } = {}) {
  const results = [];
  const writes = [];
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) {
      results.push(conflictResult(file.path, "unsafe_path"));
      continue;
    }
    const target = path.resolve(workspace, file.path);
    let oldText = "";
    let existed = true;
    try {
      oldText = await readFile(target);
    } catch {
      existed = false;
    }
    if (existed && file.replaceFile !== true) {
      results.push(conflictResult(file.path, "replace_requires_explicit_flag"));
      continue;
    }
    if (Buffer.byteLength(file.content || "", "utf8") > maxReplaceBytes) {
      results.push(conflictResult(file.path, "replacement_too_large"));
      continue;
    }
    const changed = lineDelta(oldText, String(file.content || ""));
    const result = {
      id: patchId("patch"),
      path: file.path,
      target,
      status: "applied",
      existed,
      additions: changed.additions,
      deletions: changed.deletions,
      changedLines: changed.additions + changed.deletions,
      mode: existed ? "replace" : "create",
      beforeSha256: sha256(oldText),
      afterSha256: sha256(file.content || ""),
      createdAt: now()
    };
    results.push(result);
    writes.push({ target, content: String(file.content || ""), result });
  }
  return {
    status: results.some((item) => item.status === "conflicted") ? "conflicted" : "applied",
    summary: summarizePatchResults(results),
    results,
    writes
  };
}

function applyFilePatch(oldText, file, { existed = true } = {}) {
  let cursor = 0;
  const oldLines = splitLines(oldText);
  const output = [];
  let additions = 0;
  let deletions = 0;
  const conflicts = [];
  for (const hunk of file.hunks) {
    const startIndex = Math.max(0, hunk.oldStart - 1);
    if (startIndex < cursor) return { ok: false, reason: "overlapping_hunks" };
    output.push(...oldLines.slice(cursor, startIndex));
    let index = startIndex;
    for (const rawLine of hunk.lines) {
      if (rawLine.startsWith("\\")) continue;
      const marker = rawLine[0] || " ";
      const text = rawLine.slice(1);
      if (marker === " ") {
        if (oldLines[index] !== text) {
          conflicts.push({ expected: text, actual: oldLines[index] ?? "", line: index + 1 });
          return { ok: false, reason: "context_mismatch", conflicts };
        }
        output.push(oldLines[index]);
        index += 1;
      } else if (marker === "-") {
        if (oldLines[index] !== text) {
          conflicts.push({ expected: text, actual: oldLines[index] ?? "", line: index + 1 });
          return { ok: false, reason: "delete_mismatch", conflicts };
        }
        deletions += 1;
        index += 1;
      } else if (marker === "+") {
        output.push(text);
        additions += 1;
      }
    }
    cursor = index;
  }
  if (existed) output.push(...oldLines.slice(cursor));
  else if (cursor < oldLines.length) output.push(...oldLines.slice(cursor));
  return { ok: true, content: joinLines(output, oldText), additions, deletions };
}

function cleanDiffPath(value = "") {
  const cleaned = String(value || "").trim().replace(/^"|"$/g, "");
  if (cleaned === "/dev/null") return cleaned;
  return cleaned.replace(/^[ab]\//, "").replaceAll("\\", "/");
}

function isSafeRelativePath(value = "") {
  const normalized = String(value || "").replaceAll("\\", "/");
  return Boolean(normalized) && !path.isAbsolute(normalized) && !normalized.split("/").includes("..");
}

function splitLines(text = "") {
  const value = String(text ?? "");
  if (!value) return [];
  return value.endsWith("\n") ? value.slice(0, -1).split("\n") : value.split("\n");
}

function joinLines(lines = [], original = "") {
  const value = lines.join("\n");
  return String(original || "").endsWith("\n") || lines.length ? `${value}\n` : value;
}

function lineDelta(oldText = "", newText = "") {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let samePrefix = 0;
  while (samePrefix < oldLines.length && samePrefix < newLines.length && oldLines[samePrefix] === newLines[samePrefix]) samePrefix += 1;
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= samePrefix && newEnd >= samePrefix && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return {
    additions: Math.max(0, newEnd - samePrefix + 1),
    deletions: Math.max(0, oldEnd - samePrefix + 1)
  };
}

function conflictResult(filePath, reason) {
  return { id: patchId("patch"), path: filePath, status: "conflicted", reason, createdAt: now(), additions: 0, deletions: 0, changedLines: 0 };
}

function summarizePatchResults(results = []) {
  return {
    files: results.length,
    applied: results.filter((item) => item.status === "applied").length,
    conflicted: results.filter((item) => item.status === "conflicted").length,
    additions: results.reduce((sum, item) => sum + Number(item.additions || 0), 0),
    deletions: results.reduce((sum, item) => sum + Number(item.deletions || 0), 0),
    changedLines: results.reduce((sum, item) => sum + Number(item.changedLines || 0), 0)
  };
}

function patchId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

function sha256(text = "") {
  return crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}
