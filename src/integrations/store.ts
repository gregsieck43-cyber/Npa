import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** Annotations and independent tool receipts only. Kernel remains the sole task authority. */
export class IntegrationStore {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'integrations.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,scope TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,scope,id));`);
  }
  close(): void { this.db.close(); }
  /** Read only the plan identity for model context; large node objectives stay in the saved plan. */
  planHeader(scope: string) {
    const row = this.db.prepare(`SELECT json_extract(body,'$.id') AS id,json_extract(body,'$.title') AS title,
      json_extract(body,'$.revision') AS revision,json_extract(body,'$.goalVersion') AS goalVersion,
      json_array_length(body,'$.nodes') AS nodeCount FROM records WHERE kind='plan' AND scope=? AND id='current'`).get(scope);
    return row ? { id: String(row.id), title: String(row.title), revision: Number(row.revision), nodeCount: Number(row.nodeCount),
      ...(row.goalVersion !== null ? { goalVersion: Number(row.goalVersion) } : {}) } : undefined;
  }
  get<T>(kind: string, scope: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT body FROM records WHERE kind=? AND scope=? AND id=?').get(kind, scope, id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as T : undefined;
  }
  list<T>(kind: string, scope: string): T[] {
    return (this.db.prepare('SELECT body FROM records WHERE kind=? AND scope=? ORDER BY rowid').all(kind, scope) as { body: string }[]).map(row => JSON.parse(row.body) as T);
  }
  put(kind: string, scope: string, id: string, value: unknown): void {
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,scope,id) DO UPDATE SET body=excluded.body').run(kind, scope, id, JSON.stringify(value));
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

export function text(value: unknown, label: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${label} must be nonempty text up to ${max} characters.`);
  return value.trim();
}
export function identifier(value: unknown): string {
  const id = text(value, 'ID', 80);
  if (!/^[\w.-]+$/.test(id)) throw new Error('ID must use letters, digits, dots, underscores or hyphens.');
  return id;
}
