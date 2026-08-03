import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_BUSY_TIMEOUT = 5_000;
const DEFAULT_DATABASE_FILE = 'data/workbench.sqlite';

/**
 * JSON codec used for values persisted in SQLite TEXT columns.  Keeping this
 * in one place makes the wire format explicit and gives callers a safe
 * fallback when reading data written by an older migration.
 */
export function encodeJson(value) {
  if (value === undefined) return null;
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === 'bigint') return { __workbenchType: 'bigint', value: nested.toString() };
    if (nested instanceof Uint8Array && !Buffer.isBuffer(nested)) {
      return { __workbenchType: 'bytes', value: Buffer.from(nested).toString('base64') };
    }
    if (Buffer.isBuffer(nested)) {
      return { __workbenchType: 'bytes', value: nested.toString('base64') };
    }
    return nested;
  });
}

export function decodeJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value, (_key, nested) => {
      if (nested && nested.__workbenchType === 'bigint') {
        try { return BigInt(nested.value); } catch { return nested.value; }
      }
      if (nested && nested.__workbenchType === 'bytes') {
        try { return Buffer.from(nested.value, 'base64'); } catch { return nested.value; }
      }
      if (nested && nested.type === 'Buffer' && Array.isArray(nested.data)) return Buffer.from(nested.data);
      return nested;
    });
  } catch {
    return fallback;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

const MIGRATION_ONE = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  workspace_id TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  budget_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload_json TEXT,
  sequence INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run_sequence ON events(run_id, sequence, created_at);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  response_json TEXT,
  status_code INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key, scope)
);

CREATE TABLE IF NOT EXISTS context_workspaces (
  id TEXT PRIMARY KEY,
  run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  goal TEXT NOT NULL DEFAULT '',
  token_limit INTEGER NOT NULL DEFAULT 200000,
  pressure_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_blocks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES context_workspaces(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,
  type TEXT NOT NULL,
  parent_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  token_estimate INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  payload_hash TEXT,
  checksum TEXT,
  integrity TEXT NOT NULL DEFAULT 'unchecked',
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  offloaded INTEGER NOT NULL DEFAULT 0 CHECK (offloaded IN (0, 1)),
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accessed_at TEXT NOT NULL,
  UNIQUE(workspace_id, stable_key)
);
CREATE INDEX IF NOT EXISTS idx_context_blocks_workspace ON context_blocks(workspace_id, archived, visible, pinned);
CREATE INDEX IF NOT EXISTS idx_context_blocks_payload ON context_blocks(payload_hash);

CREATE TABLE IF NOT EXISTS effects (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  idempotency_key TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'intent',
  intent_json TEXT,
  result_json TEXT,
  checksum TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  effect_id TEXT REFERENCES effects(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  request_json TEXT,
  decision_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  paths_json TEXT,
  commands_json TEXT,
  network_json TEXT,
  model TEXT,
  expires_at TEXT,
  budget_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id, created_at);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  entity_type TEXT,
  entity_id TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_run_created ON audit(run_id, created_at);
`;

const MIGRATION_TWO = `
CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'step',
  status TEXT NOT NULL DEFAULT 'queued',
  title TEXT NOT NULL DEFAULT '',
  detail_json TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_run_sequence ON steps(run_id, sequence, created_at);
`;

const MIGRATION_THREE = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_effects_run_idempotency
  ON effects(run_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
`;

const IDEMPOTENCY_COLUMNS = [
  ['request_hash', 'TEXT'],
  ['lease_owner', 'TEXT'],
  ['lease_expires_at', 'TEXT']
];

const RUN_COLUMNS = [
  ['next_wake_at', 'TEXT'],
  ['heartbeat_at', 'TEXT'],
  ['attempt', 'INTEGER NOT NULL DEFAULT 0'],
  ['model_calls', 'INTEGER NOT NULL DEFAULT 0'],
  ['input_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['output_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['estimated_cost', 'REAL NOT NULL DEFAULT 0'],
  ['checkpoint_seq', 'INTEGER NOT NULL DEFAULT 0'],
  ['worktree_path', 'TEXT'],
  ['branch', 'TEXT']
];

function normalizeDatabaseOptions(filenameOrOptions, maybeOptions = {}) {
  if (filenameOrOptions && typeof filenameOrOptions === 'object') {
    return { ...filenameOrOptions };
  }
  return { ...maybeOptions, filename: filenameOrOptions };
}

function bindParameters(parameters) {
  if (parameters.length === 1 && Array.isArray(parameters[0])) return parameters[0];
  return parameters;
}

/** Synchronous SQLite persistence wrapper used by the local server. */
export class WorkbenchDatabase {
  constructor(filenameOrOptions = {}, maybeOptions = {}) {
    const options = normalizeDatabaseOptions(filenameOrOptions, maybeOptions);
    const requested = options.filename ?? options.path ?? options.dbPath
      ?? (options.dataDir ? join(String(options.dataDir), 'workbench.sqlite') : (options.database ? ':memory:' : DEFAULT_DATABASE_FILE));
    this.filename = requested === ':memory:' ? requested : resolve(String(requested));
    this.path = this.filename;
    this.busyTimeout = Math.max(1, Number(options.busyTimeout ?? DEFAULT_BUSY_TIMEOUT));
    if (this.filename !== ':memory:') mkdirSync(dirname(this.filename), { recursive: true });
    this.sqlite = options.database ?? new DatabaseSync(this.filename);
    this.raw = this.sqlite;
    this._transactionDepth = 0;
    this._afterCommitCallbacks = [];
    this._closed = false;
    this._configure();
    this.migrate();
  }

  _configure() {
    // These pragmas are intentionally issued as separate statements.  SQLite
    // returns the resulting journal mode from the WAL statement, while the
    // others are connection-local settings.
    if (this.filename !== ':memory:') this.sqlite.exec('PRAGMA journal_mode = WAL');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.sqlite.exec(`PRAGMA busy_timeout = ${this.busyTimeout}`);
    this.sqlite.exec('PRAGMA synchronous = NORMAL');
  }

  migrate() {
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = this.get('SELECT max(version) AS version FROM schema_migrations');
    const version = Number(applied?.version || 0);
    if (version < 1) {
      this.sqlite.exec('BEGIN IMMEDIATE');
      try {
        this.sqlite.exec(MIGRATION_ONE);
        this.run('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)', 1, nowIso());
        this.sqlite.exec('COMMIT');
      } catch (error) {
        try { this.sqlite.exec('ROLLBACK'); } catch { /* preserve original migration error */ }
        throw error;
      }
    }
    const afterOne = Number(this.get('SELECT max(version) AS version FROM schema_migrations')?.version || 0);
    if (afterOne < 2) {
      this.sqlite.exec('BEGIN IMMEDIATE');
      try {
        this.sqlite.exec(MIGRATION_TWO);
        const columns = new Set(this.all('PRAGMA table_info(runs)').map((column) => column.name));
        for (const [name, definition] of RUN_COLUMNS) {
          if (!columns.has(name)) this.sqlite.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
        }
        this.run('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)', 2, nowIso());
        this.sqlite.exec('COMMIT');
      } catch (error) {
        try { this.sqlite.exec('ROLLBACK'); } catch { /* preserve original migration error */ }
        throw error;
      }
    }
    const afterTwo = Number(this.get('SELECT max(version) AS version FROM schema_migrations')?.version || 0);
    if (afterTwo < 3) {
      this.sqlite.exec('BEGIN IMMEDIATE');
      try {
        this.sqlite.exec(MIGRATION_THREE);
        this.run('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)', 3, nowIso());
        this.sqlite.exec('COMMIT');
      } catch (error) {
        try { this.sqlite.exec('ROLLBACK'); } catch { /* preserve original migration error */ }
        throw error;
      }
    }
    const afterThree = Number(this.get('SELECT max(version) AS version FROM schema_migrations')?.version || 0);
    if (afterThree < 4) {
      this.sqlite.exec('BEGIN IMMEDIATE');
      try {
        const columns = new Set(this.all('PRAGMA table_info(idempotency)').map((column) => column.name));
        for (const [name, definition] of IDEMPOTENCY_COLUMNS) {
          if (!columns.has(name)) this.sqlite.exec(`ALTER TABLE idempotency ADD COLUMN ${name} ${definition}`);
        }
        this.run('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)', 4, nowIso());
        this.sqlite.exec('COMMIT');
      } catch (error) {
        try { this.sqlite.exec('ROLLBACK'); } catch { /* preserve original migration error */ }
        throw error;
      }
    }
    return 4;
  }

  exec(sql) {
    return this.sqlite.exec(String(sql));
  }

  prepare(sql) {
    return this.sqlite.prepare(String(sql));
  }

  run(sql, ...parameters) {
    return this.sqlite.prepare(String(sql)).run(...bindParameters(parameters));
  }

  get(sql, ...parameters) {
    return this.sqlite.prepare(String(sql)).get(...bindParameters(parameters)) ?? null;
  }

  all(sql, ...parameters) {
    return this.sqlite.prepare(String(sql)).all(...bindParameters(parameters));
  }

  query(sql, ...parameters) {
    return this.all(sql, ...parameters);
  }

  scalar(sql, ...parameters) {
    const row = this.get(sql, ...parameters);
    return row ? Object.values(row)[0] : null;
  }

  transaction(callback, { mode = 'IMMEDIATE' } = {}) {
    if (typeof callback !== 'function') throw new TypeError('transaction callback must be a function');
    if (this._transactionDepth > 0) {
      this._transactionDepth += 1;
      try { return callback(this); } finally { this._transactionDepth -= 1; }
    }
    this.sqlite.exec(`BEGIN ${mode}`);
    this._transactionDepth = 1;
    this._afterCommitCallbacks = [];
    let committed = false;
    try {
      const result = callback(this);
      this.sqlite.exec('COMMIT');
      committed = true;
      return result;
    } catch (error) {
      try { this.sqlite.exec('ROLLBACK'); } catch { /* preserve callback error */ }
      throw error;
    } finally {
      this._transactionDepth = 0;
      const callbacks = this._afterCommitCallbacks;
      this._afterCommitCallbacks = [];
      if (committed) {
        for (const afterCommit of callbacks) {
          try { afterCommit(); } catch (error) { process.emitWarning(`afterCommit callback failed: ${error?.message || error}`); }
        }
      }
    }
  }

  afterCommit(callback) {
    if (typeof callback !== 'function') throw new TypeError('afterCommit callback must be a function');
    if (this._transactionDepth > 0) this._afterCommitCallbacks.push(callback);
    else callback();
  }

  withTransaction(callback, options) {
    return this.transaction(callback, options);
  }

  runInTransaction(callback, options) {
    return this.transaction(callback, options);
  }

  getIdempotency(key, scope = '') {
    const row = this.get('SELECT * FROM idempotency WHERE key = ? AND scope = ?', String(key), String(scope));
    if (!row) return null;
    return { ...row, response: decodeJson(row.response_json, null) };
  }

  saveIdempotency(key, response, { scope = '', statusCode = 200 } = {}) {
    const now = nowIso();
    this.run(`INSERT INTO idempotency (key, scope, response_json, status_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key, scope) DO UPDATE SET response_json = excluded.response_json,
        status_code = excluded.status_code, updated_at = excluded.updated_at`,
    String(key), String(scope), encodeJson(response), Number(statusCode), now, now);
    return this.getIdempotency(key, scope);
  }

  setIdempotency(key, response, options) {
    return this.saveIdempotency(key, response, options);
  }

  putIdempotency(key, response, options) {
    return this.saveIdempotency(key, response, options);
  }

  recordAudit(action, payload = {}, { runId = null, actor = 'system', entityType = null, entityId = null } = {}) {
    const id = payload.id || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    this.run(`INSERT INTO audit (id, run_id, action, actor, entity_type, entity_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, runId, String(action), String(actor), entityType, entityId,
    encodeJson(payload), nowIso());
    return id;
  }

  close() {
    if (this._closed) return;
    this.sqlite.close();
    this._closed = true;
  }
}

export function createDatabase(filenameOrOptions, maybeOptions) {
  return new WorkbenchDatabase(filenameOrOptions, maybeOptions);
}

export const Database = WorkbenchDatabase;

export const jsonEncode = encodeJson;
export const jsonDecode = decodeJson;

export function openDatabase(options = {}) {
  return new WorkbenchDatabase(options);
}

export function migrateDatabase(database) {
  if (!database || typeof database.migrate !== 'function') throw new TypeError('migrateDatabase expects WorkbenchDatabase');
  return database.migrate();
}

export function runInTransaction(database, callback, options) {
  if (!database || typeof database.transaction !== 'function') throw new TypeError('runInTransaction expects WorkbenchDatabase');
  return database.transaction(callback, options);
}
