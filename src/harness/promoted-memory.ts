import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { HistoryArchive, ScopedMemory, type NoteInput, type NotesInput, type ReadInput, type SearchInput } from '../memory/archive.js';
import type { ScopedMemoryPort } from '../memory/tools.js';

/** The promotion link a Work task keeps to its origin Chat. Older links may only carry source IDs. */
export interface PromotedLink {
  sessionId: string;
  archiveSnapshot?: number;
  sourceMessageIds?: string[];
}

interface MessageRow { seq: number; id: string; record: string }

const COPY_PAGE = 500;

/** One durable file per Work task; the task id never appears in a path. */
export function promotedOriginFile(dataDir: string, taskId: string): string {
  return path.join(dataDir, 'promoted', createHash('sha256').update(taskId).digest('hex') + '.sqlite');
}

function hasArchiveSchema(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name='history_documents'").get());
}

function rowCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT COUNT(*) AS total FROM chat_messages').get() as { total: number }).total);
}

/**
 * Copy every original row at or below the promotion snapshot in bounded keyset pages. The source and
 * destination are separate SQLite handles, so no page is ever held after it is inserted and the copy
 * size does not grow with the conversation. The destination transaction makes a crash recoverable:
 * a partial copy is rolled back and retried on the next read.
 */
function copyPages(source: DatabaseSync, target: DatabaseSync, sessionId: string, snapshot: number): void {
  const read = source.prepare('SELECT seq,id,record FROM chat_messages WHERE session_id=? AND seq<=? AND seq>? ORDER BY seq LIMIT ?');
  const insert = target.prepare('INSERT INTO chat_messages(seq,id,session_id,record) VALUES(?,?,?,?)');
  target.exec('BEGIN IMMEDIATE');
  try {
    let after = 0;
    for (;;) {
      const rows = read.all(sessionId, snapshot, after, COPY_PAGE) as unknown as MessageRow[];
      for (const row of rows) insert.run(row.seq, row.id, sessionId, row.record);
      if (rows.length < COPY_PAGE) break;
      after = rows[rows.length - 1]!.seq;
    }
    target.exec('COMMIT');
  } catch (error) {
    target.exec('ROLLBACK');
    throw error;
  }
}

/** Upgrade once, copying only ancestry whose local anchor still matches the frozen original bytes. */
function copyAncestorSources(source: DatabaseSync, target: DatabaseSync, sessionId: string, snapshot: number, prepareAncestors?: (messageId: string) => void): void {
  if (target.prepare("SELECT 1 FROM origin_metadata WHERE key='ancestor-sources-v1'").get()) return;
  target.exec('BEGIN IMMEDIATE');
  try {
    const available = source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_history_sources'").get();
    if (available) {
      const insert = target.prepare('INSERT OR IGNORE INTO chat_history_sources(session_id,source_id,anchor_message_id,record) VALUES(?,?,?,?)');
      let after = 0;
      for (;;) {
        const rows = target.prepare('SELECT seq,id,record FROM chat_messages WHERE session_id=? AND seq<=? AND seq>? ORDER BY seq LIMIT ?').all(sessionId, snapshot, after, COPY_PAGE) as unknown as MessageRow[];
        for (const row of rows) {
          const live = source.prepare('SELECT record FROM chat_messages WHERE session_id=? AND id=?').get(sessionId, row.id) as { record: string } | undefined;
          if (live?.record !== row.record) continue;
          prepareAncestors?.(row.id);
          for (const ancestor of source.prepare('SELECT source_id,record FROM chat_history_sources WHERE session_id=? AND anchor_message_id=?').iterate(sessionId, row.id)) insert.run(sessionId, ancestor.source_id, row.id, ancestor.record);
        }
        if (rows.length < COPY_PAGE) break;
        after = rows[rows.length - 1]!.seq;
      }
    }
    target.prepare("INSERT INTO origin_metadata(key,value) VALUES('ancestor-sources-v1','complete')").run();
    target.exec('COMMIT');
  } catch (error) { target.exec('ROLLBACK'); throw error; }
}

/**
 * Materialize the immutable origin rows once. Later reads only verify the durable copy exists, so a
 * source delete/edit/restart cannot change or remove what a promoted Work task may read. The schema
 * is built after the page copy, so bulk rows are indexed once instead of triggering FTS per insert.
 */
export function ensurePromotedOrigin(source: DatabaseSync, file: string, sessionId: string, snapshot: number, prepareAncestors?: (messageId: string) => void): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    db.exec('CREATE TABLE IF NOT EXISTS chat_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,record TEXT NOT NULL);');
    db.exec('CREATE TABLE IF NOT EXISTS chat_history_sources(session_id TEXT NOT NULL,source_id TEXT NOT NULL,anchor_message_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(session_id,source_id)); CREATE TABLE IF NOT EXISTS origin_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
    const schema = hasArchiveSchema(db);
    const total = rowCount(db);
    if (total === 0) copyPages(source, db, sessionId, snapshot);
    copyAncestorSources(source, db, sessionId, snapshot, prepareAncestors);
    if (!schema) {
      // Build the archive view/FTS/triggers and index the copied rows in one bulk rebuild.
      new HistoryArchive(db, 'chat');
    } else if (total === 0) {
      // A durable schema existed with no rows (an interrupted copy); the copied rows bypassed the triggers.
      db.exec("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
    }
  } finally {
    db.close();
  }
}

/**
 * A promoted origin that opens its own database handle per operation and closes it before returning.
 * No handle is cached and no ScopedMemory instance escapes this class, so a retained reference never
 * points at a closed database; the cost is one SQLite open per origin call, bounded by the call.
 */
export class PreservedOriginMemory implements ScopedMemoryPort {
  constructor(private readonly file: string, private readonly sessionId: string, private readonly snapshot: number) {}

  private use<T>(action: (memory: ScopedMemory) => T): T {
    const db = new DatabaseSync(this.file);
    try {
      return action(new ScopedMemory(db, this.sessionId, this.snapshot, (id, through) => {
        const row = db.prepare('SELECT source.record FROM chat_history_sources source JOIN chat_messages anchor ON anchor.id=source.anchor_message_id AND anchor.session_id=source.session_id WHERE source.session_id=? AND source.source_id=? AND anchor.seq<=?').get(this.sessionId, id, through) as { record: string } | undefined;
        return row?.record;
      }));
    } finally {
      db.close();
    }
  }

  manifest() { return this.use(memory => memory.manifest()); }
  search(input: SearchInput) { return this.use(memory => memory.search(input)); }
  read(input: ReadInput) { return this.use(memory => memory.read(input)); }
  remember(input: NoteInput, operationId: string) { return this.use(memory => memory.remember(input, operationId)); }
  notes(input: NotesInput = {}) { return this.use(memory => memory.notes(input)); }
  context(query: string, maxChars?: number) { return this.use(memory => memory.context(query, maxChars)); }
}
