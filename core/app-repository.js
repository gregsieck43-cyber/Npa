import { decodeJson, encodeJson, nowIso } from "./database.js";

const DEFAULT_SETTINGS = Object.freeze({
  theme: "light",
  modelProvider: "openai",
  apiProtocol: "openai_responses",
  model: "gpt-5.5",
  effort: "xhigh",
  apiBaseUrl: "",
  contextWindowHint: 200000,
  autostartEnabled: false,
  capabilities: {
    chat: true,
    web: true,
    knowledge: true,
    dataAnalysis: true,
    code: true,
    terminal: true,
    git: true,
    artifacts: true
  },
  runBudget: {
    durationHours: 72,
    maxModelCalls: 288,
    maxInputTokens: 12000000,
    maxOutputTokens: 2000000,
    maxEstimatedUsd: 25,
    enforced: true
  },
  web: { provider: "mock", rateLimitPerMinute: 30, cacheTtlSeconds: 900 },
  rag: { embeddingProvider: "local", vectorStore: "json" },
  image: { provider: "mock", size: "1024x1024", quality: "auto" },
  analysis: { javascriptTimeoutMs: 3000, pythonTimeoutMs: 8000, packageManager: "none" }
});

export function createAppRepository(db) {
  ensureApplicationTables(db);
  return new AppRepository(db);
}

export function ensureApplicationTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      rows_json TEXT,
      columns_json TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analysis_runs (
      id TEXT PRIMARY KEY,
      dataset_id TEXT REFERENCES datasets(id) ON DELETE CASCADE,
      language TEXT NOT NULL,
      input_json TEXT,
      output_json TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export class AppRepository {
  constructor(db) { this.db = db; }

  getSettings() {
    const row = this.db.get("SELECT value_json FROM app_settings WHERE key = 'settings'");
    return mergeDeep(structuredClone(DEFAULT_SETTINGS), decodeJson(row?.value_json, {}));
  }

  saveSettings(patch = {}) {
    const settings = mergeDeep(this.getSettings(), sanitizeSettings(patch));
    const at = nowIso();
    this.db.run(`INSERT INTO app_settings (key, value_json, updated_at) VALUES ('settings', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`, encodeJson(settings), at);
    return settings;
  }

  getValue(key, fallback = null) {
    const row = this.db.get("SELECT value_json FROM app_settings WHERE key = ?", String(key));
    return decodeJson(row?.value_json, fallback);
  }

  setValue(key, value) {
    this.db.run(`INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`, String(key), encodeJson(value), nowIso());
    return value;
  }

  createConversation({ id = makeId("chat"), projectId, title = "新对话", metadata = {} } = {}) {
    const at = nowIso();
    this.db.run("INSERT INTO conversations (id, project_id, title, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      id, projectId || null, title, encodeJson(sanitizeSecretObject(metadata)), at, at);
    return this.getConversation(id);
  }

  getConversation(id) {
    const row = this.db.get("SELECT * FROM conversations WHERE id = ?", String(id));
    if (!row) return null;
    return { id: row.id, projectId: row.project_id, title: row.title, metadata: sanitizeSecretObject(decodeJson(row.metadata_json, {})), messages: this.listMessages(row.id), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  listConversations(projectId = "") {
    const rows = projectId
      ? this.db.all("SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC", projectId)
      : this.db.all("SELECT * FROM conversations ORDER BY updated_at DESC");
    return rows.map((row) => ({ id: row.id, projectId: row.project_id, title: row.title, metadata: sanitizeSecretObject(decodeJson(row.metadata_json, {})), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  addMessage(conversationId, { id = makeId("msg"), role = "user", content = "", metadata = {} } = {}) {
    if (!this.getConversation(conversationId)) throw Object.assign(new Error("对话不存在"), { statusCode: 404 });
    const at = nowIso();
    this.db.transaction(() => {
      this.db.run("INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, conversationId, role, String(content), encodeJson(sanitizeSecretObject(metadata)), at);
      this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", at, conversationId);
    });
    return { id, conversationId, role, content: String(content), metadata: sanitizeSecretObject(metadata), createdAt: at };
  }

  listMessages(conversationId) {
    return this.db.all("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at", String(conversationId))
      .map((row) => ({ id: row.id, conversationId: row.conversation_id, role: row.role, content: row.content, metadata: sanitizeSecretObject(decodeJson(row.metadata_json, {})), createdAt: row.created_at }));
  }

  upsertKnowledgeDocument(input = {}) {
    const id = String(input.id || makeId("doc"));
    const at = nowIso();
    this.db.run(`INSERT INTO knowledge_documents (id, project_id, name, content, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, content = excluded.content,
        metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`, id, input.projectId || null,
    String(input.name || "未命名文档"), String(input.content || ""), encodeJson(sanitizeSecretObject(input.metadata || {})), at, at);
    return this.getKnowledgeDocument(id);
  }

  getKnowledgeDocument(id) {
    const row = this.db.get("SELECT * FROM knowledge_documents WHERE id = ?", String(id));
    return row ? publicDocument(row) : null;
  }

  listKnowledgeDocuments(projectId = "") {
    const rows = projectId ? this.db.all("SELECT * FROM knowledge_documents WHERE project_id = ? ORDER BY updated_at DESC", projectId)
      : this.db.all("SELECT * FROM knowledge_documents ORDER BY updated_at DESC");
    return rows.map(publicDocument);
  }

  deleteKnowledgeDocument(id) {
    const result = this.db.run("DELETE FROM knowledge_documents WHERE id = ?", String(id));
    return Number(result.changes || 0) > 0;
  }
}

function publicDocument(row) {
  return { id: row.id, projectId: row.project_id, name: row.name, content: row.content, metadata: sanitizeSecretObject(decodeJson(row.metadata_json, {})), createdAt: row.created_at, updatedAt: row.updated_at };
}

function sanitizeSettings(input) {
  return sanitizeSecretObject(input);
}

export function sanitizeSecretObject(input) {
  if (Array.isArray(input)) return input.map(sanitizeSecretObject);
  if (!input || typeof input !== "object") return input;
  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["apikey", "token", "accesstoken", "refreshtoken", "secret", "clientsecret", "password", "connectortoken", "authorization", "privatekey"].includes(normalized)) continue;
    clean[key] = sanitizeSecretObject(value);
  }
  return clean;
}

function mergeDeep(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      base[key] = mergeDeep({ ...base[key] }, value);
    } else if (value !== undefined) base[key] = value;
  }
  return base;
}

function makeId(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`; }

export { DEFAULT_SETTINGS };
