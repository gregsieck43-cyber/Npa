import crypto from "node:crypto";
import path from "node:path";

export function sha256(text = "") {
  return crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

export function fileSnapshot({ path: filePath = "", content = "", stat = null } = {}) {
  return {
    path: filePath,
    sha256: sha256(content),
    bytes: Buffer.byteLength(String(content ?? ""), "utf8"),
    updatedAt: stat?.mtime ? stat.mtime.toISOString() : ""
  };
}

export function verifyBaseHash({ currentContent = "", expectedSha256 = "", required = false } = {}) {
  const currentSha256 = sha256(currentContent);
  if (!expectedSha256) return { ok: !required, currentSha256, reason: required ? "base_hash_required" : "" };
  if (currentSha256 !== expectedSha256) return { ok: false, currentSha256, expectedSha256, reason: "base_hash_mismatch" };
  return { ok: true, currentSha256, expectedSha256, reason: "" };
}

export function conflictError({ path: filePath = "", expectedSha256 = "", currentContent = "", diff = "" } = {}) {
  const error = new Error(`File changed since it was read: ${filePath}`);
  error.statusCode = 409;
  error.code = "base_hash_mismatch";
  error.detail = {
    path: filePath,
    expectedSha256,
    actualSha256: sha256(currentContent),
    diff
  };
  return error;
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
    if (file.baseSha256 && sha256(oldText) !== file.baseSha256) {
      results.push({ ...conflictResult(file.path, "base_hash_mismatch"), expectedSha256: file.baseSha256, actualSha256: sha256(oldText) });
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
  return { status: results.some((item) => item.status === "conflicted") ? "conflicted" : "applied", results, writes, summary: summarizePatchResults(results) };
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

function now() {
  return new Date().toISOString();
}
