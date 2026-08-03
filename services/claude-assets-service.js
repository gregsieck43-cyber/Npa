import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAX_ASSET_BYTES = 1.5 * 1024 * 1024;

export function parseFrontmatterMarkdown(text = "") {
  const value = String(text || "");
  if (!value.startsWith("---")) return { meta: {}, body: value.trim() };
  const end = value.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: value.trim() };
  const rawMeta = value.slice(3, end).trim();
  const body = value.slice(end + 4).trim();
  const meta = {};
  for (const line of rawMeta.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    meta[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body };
}

export async function readMarkdownAssets(directory, type = "asset") {
  const results = [];
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const filePath = path.join(directory, entry.name);
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_ASSET_BYTES) continue;
      const content = await fs.readFile(filePath, "utf8");
      const parsed = parseFrontmatterMarkdown(content);
      const name = parsed.meta.name || path.basename(entry.name, ".md");
      results.push({
        id: `${type}_${name.replace(/[^a-z0-9_-]/gi, "_")}`,
        name,
        description: parsed.meta.description || "",
        tools: splitList(parsed.meta.tools),
        globs: splitList(parsed.meta.globs),
        mode: parsed.meta.mode || "",
        path: filePath,
        prompt: parsed.body,
        content: parsed.body,
        sha256: sha256(content),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        updatedAt: stat.mtime.toISOString()
      });
    }
  } catch {
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readClaudeAssetFile(filePath, label) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) return { content: "", meta: publicFileMeta(filePath, label, stat) };
    const content = await fs.readFile(filePath, "utf8");
    return { content, meta: publicFileMeta(filePath, label, stat, content) };
  } catch {
    return { content: "", meta: { label, path: filePath, exists: false, size: 0, sha256: "", updatedAt: "" } };
  }
}

export async function loadClaudeAssets({ root, claudeDir = path.join(root, ".claude") } = {}) {
  const commandsDir = path.join(claudeDir, "commands");
  const agentsDir = path.join(claudeDir, "agents");
  const rulesDir = path.join(claudeDir, "rules");
  const settingsPath = path.join(claudeDir, "settings.json");
  const claudePath = path.join(root, "CLAUDE.md");
  const localPath = path.join(root, "CLAUDE.local.md");
  const [claude, local, commands, agents, rules] = await Promise.all([
    readClaudeAssetFile(claudePath, "CLAUDE.md"),
    readClaudeAssetFile(localPath, "CLAUDE.local.md"),
    readMarkdownAssets(commandsDir, "command"),
    readMarkdownAssets(agentsDir, "agent"),
    readMarkdownAssets(rulesDir, "rule")
  ]);
  return {
    root,
    claudeDir,
    commandsDir,
    agentsDir,
    rulesDir,
    settingsPath,
    claudePath,
    localPath,
    claudeMemory: claude.content,
    localMemory: local.content,
    commands,
    agents,
    rules,
    meta: {
      memoryPath: claudePath,
      localMemoryPath: localPath,
      commandsDir,
      agentsDir,
      rulesDir,
      settingsPath,
      files: [claude.meta, local.meta, ...commands.map(publicAssetMeta), ...agents.map(publicAssetMeta), ...rules.map(publicAssetMeta)],
      generatedAt: new Date().toISOString()
    }
  };
}

export function publicAssetState(assets = {}) {
  return {
    memoryPath: assets.claudePath || assets.meta?.memoryPath || "",
    localMemoryPath: assets.localPath || assets.meta?.localMemoryPath || "",
    commandsDir: assets.commandsDir || assets.meta?.commandsDir || "",
    agentsDir: assets.agentsDir || assets.meta?.agentsDir || "",
    rulesDir: assets.rulesDir || assets.meta?.rulesDir || "",
    settingsPath: assets.settingsPath || assets.meta?.settingsPath || "",
    files: assets.meta?.files || [],
    commands: (assets.commands || []).map(publicAssetMeta),
    agents: (assets.agents || []).map(publicAssetMeta),
    rules: (assets.rules || []).map(publicAssetMeta),
    counts: {
      commands: (assets.commands || []).length,
      agents: (assets.agents || []).length,
      rules: (assets.rules || []).length,
      claudeMd: assets.claudeMemory ? 1 : 0,
      localMd: assets.localMemory ? 1 : 0
    },
    generatedAt: assets.meta?.generatedAt || ""
  };
}

export function buildRulesContext(assets = {}, { workspacePath = "", mode = "" } = {}) {
  const rules = applicableRules(assets.rules || [], { workspacePath, mode });
  const parts = [];
  if (assets.claudeMemory) parts.push(`CLAUDE.md memory:\n${assets.claudeMemory}`);
  if (assets.localMemory) parts.push(`CLAUDE.local.md private memory:\n${assets.localMemory}`);
  if (rules.length) {
    parts.push(`Project rules:\n${rules.map((rule) => `## ${rule.name}\n${rule.content || rule.prompt || ""}`).join("\n\n")}`);
  }
  return { text: parts.join("\n\n"), rules };
}

export function applicableRules(rules = [], { workspacePath = "", mode = "" } = {}) {
  return (rules || []).filter((rule) => {
    if (rule.mode && mode && rule.mode !== mode) return false;
    if (!rule.globs?.length) return true;
    const normalized = String(workspacePath || "").replaceAll("\\", "/");
    return rule.globs.some((glob) => globMatches(normalized, glob));
  });
}

function publicFileMeta(filePath, label, stat = null, content = "") {
  return {
    label,
    path: filePath,
    exists: Boolean(stat),
    size: stat?.size || 0,
    sha256: content ? sha256(content) : "",
    updatedAt: stat?.mtime ? stat.mtime.toISOString() : ""
  };
}

function publicAssetMeta(asset = {}) {
  return {
    id: asset.id || "",
    name: asset.name || asset.label || "",
    description: asset.description || "",
    path: asset.path || "",
    exists: asset.exists !== false,
    size: asset.size || 0,
    sha256: asset.sha256 || "",
    updatedAt: asset.updatedAt || "",
    globs: asset.globs || [],
    mode: asset.mode || ""
  };
}

function splitList(value = "") {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function sha256(text = "") {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function globMatches(value = "", glob = "") {
  const escaped = String(glob || "*").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value) || new RegExp(escaped, "i").test(value);
}
