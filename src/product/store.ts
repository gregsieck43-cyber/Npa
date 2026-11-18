import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { assertLocalPath } from '../app/local-paths.js';
import type { GatewayEvent, SideAnswer, SideHistory } from '../frontend/api/types.js';
import type { ArchivedHistory, SessionIndexRecord } from './shared.js';
import { ProductError } from './shared.js';
import type { InputRange, UserInputProgress } from '../runtime/context.js';

export interface SideInputNote { ranges: InputRange[]; text: string; }

type HistoryRow = { id: string; kind: 'chat' | 'work' };
type StoredEvent = { event: GatewayEvent; sessionId?: string };

const stamp = () => new Date().toISOString();
const encodeCursor = (value: { pinned: number; updatedAt: string; id: string }): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const decodeCursor = (cursor: string): { pinned: number; updatedAt: string; id: string } => {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    const item = value as Record<string, unknown>;
    if (typeof item.pinned !== 'number' || typeof item.updatedAt !== 'string' || typeof item.id !== 'string') throw new Error('shape');
    return { pinned: item.pinned, updatedAt: item.updatedAt, id: item.id };
  } catch {
    throw new Error('Invalid session cursor.');
  }
};
const like = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

/**
 * Durable display-log budget. "Rows only" retention let one long answer retain thousands of
 * cumulative snapshots; the byte quota is the actual resource bound and the row quota keeps a
 * page replay bounded for tiny events. Both are enforced by oldest-id eviction (a watermark),
 * so cursors below the evicted floor must resynchronize through the snapshot.
 */
export const PRODUCT_EVENT_ROW_LIMIT = 5000;
export const PRODUCT_EVENT_BYTES_LIMIT = 8 * 1024 * 1024;
/** Separator is not valid in our generated session/message ids, so the key is unambiguous. */
const STREAM_KEY_SEPARATOR = '\u001f';
const streamKeyOf = (sessionId: string, messageId: string): string => sessionId + STREAM_KEY_SEPARATOR + messageId;

/**
 * 产品展示层索引与有界变更日志。
 *
 * 只保存展示元数据、分页游标和事件；会话正文仍在 HarnessStore/Kernel，执行状态不复制。
 * 独立 SQLite 文件避免与 Harness/Kernel 的单写者事务耦合。
 */
export class ProductStore {
  private readonly eventWaiters = new Set<{ update: () => void; close: () => void }>();
  private eventsClosing = false;
  private eventNotificationPending = false;
  private readonly db: DatabaseSync;
  private readonly filename: string;
  /** 事件日志代际：持久化在 product_meta；数据库文件被替换后会重新生成，供前端识别"换了数据源"。 */
  private readonly eventEpochValue: string;
  constructor(dataDir: string) {
    assertLocalPath(dataDir, 'Product data directory');
    mkdirSync(dataDir, { recursive: true });
    this.filename = path.join(dataDir, 'product.sqlite');
    this.db = new DatabaseSync(this.filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_index(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, mode TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
        permission TEXT NOT NULL, model_id TEXT NOT NULL, reasoning_effort TEXT, project_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0, preview TEXT, unread INTEGER, parent_session_id TEXT,
        work_task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS session_index_order ON session_index(pinned DESC, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS session_index_mode ON session_index(mode, pinned DESC, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS session_index_project ON session_index(project_id, pinned DESC, updated_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS dismissed_sessions(id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS product_events(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, type TEXT NOT NULL, record TEXT NOT NULL, created_at TEXT NOT NULL, stream_key TEXT);
      CREATE INDEX IF NOT EXISTS product_events_session ON product_events(session_id, id);
      CREATE TABLE IF NOT EXISTS archived_history(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, source_ids TEXT NOT NULL, record TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS archived_history_session ON archived_history(session_id, created_at);
      CREATE TABLE IF NOT EXISTS product_meta(key TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS side_sessions(id TEXT PRIMARY KEY,parent_key TEXT NOT NULL,target_task_id TEXT,consumed_seq INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS side_parent_active ON side_sessions(parent_key) WHERE archived=0;
      CREATE TABLE IF NOT EXISTS side_turns(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,record TEXT NOT NULL,input_text TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS side_turn_session ON side_turns(session_id,seq);
      CREATE TABLE IF NOT EXISTS side_request_inputs(request_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,after_seq INTEGER NOT NULL,through_seq INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS product_event_stats(singleton INTEGER PRIMARY KEY CHECK(singleton=1), rows INTEGER NOT NULL, bytes INTEGER NOT NULL);`);
    if (!(this.db.prepare('PRAGMA table_info(side_turns)').all() as { name: string }[]).some(column => column.name === 'input_text')) this.db.exec("ALTER TABLE side_turns ADD COLUMN input_text TEXT NOT NULL DEFAULT ''");
    if (!(this.db.prepare('PRAGMA table_info(side_sessions)').all() as { name: string }[]).some(column => column.name === 'consumed_offset')) this.db.exec('ALTER TABLE side_sessions ADD COLUMN consumed_offset INTEGER NOT NULL DEFAULT 0');
    if (!(this.db.prepare('PRAGMA table_info(side_request_inputs)').all() as { name: string }[]).some(column => column.name === 'ranges')) this.db.exec("ALTER TABLE side_request_inputs ADD COLUMN ranges TEXT NOT NULL DEFAULT '[]'; ALTER TABLE side_request_inputs ADD COLUMN after_offset INTEGER NOT NULL DEFAULT 0; ALTER TABLE side_request_inputs ADD COLUMN through_offset INTEGER NOT NULL DEFAULT 0");
    if (!(this.db.prepare('PRAGMA table_info(side_request_inputs)').all() as { name: string }[]).some(column => column.name === 'notes')) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec("ALTER TABLE side_request_inputs ADD COLUMN notes TEXT NOT NULL DEFAULT '[]'");
        // Old input-only samples advanced the cursor without retaining their reading result.
        // Replay affected unfinished sources once; completed exchanges remain outside the queue.
        const sessions = this.db.prepare('SELECT id,consumed_seq,consumed_offset FROM side_sessions').all() as { id: string; consumed_seq: number; consumed_offset: number }[];
        for (const session of sessions) {
          const row = this.db.prepare(`SELECT MIN(seq) AS seq FROM side_turns WHERE session_id=?
            AND json_extract(record,'$.status') IN ('running','failed','cancelled')
            AND seq>COALESCE((SELECT MAX(seq) FROM side_turns WHERE session_id=? AND json_extract(record,'$.status')='completed'),0)
            AND (seq<=? OR (? > 0 AND seq=(SELECT MIN(seq) FROM side_turns WHERE session_id=? AND seq>?)))`)
            .get(session.id, session.id, session.consumed_seq, session.consumed_offset, session.id, session.consumed_seq) as { seq: number | null };
          if (row.seq !== null) this.db.prepare('UPDATE side_sessions SET consumed_seq=?,consumed_offset=0 WHERE id=?').run(row.seq - 1, session.id);
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS side_input_checkpoints ON side_request_inputs(session_id,consumed)');
    const hadSideSearch = (this.db.prepare('PRAGMA table_info(side_fts)').all() as { name: string }[]).some(column => column.name === 'input_text');
    if (!hadSideSearch) this.db.exec('DROP TRIGGER IF EXISTS side_search_insert; DROP TRIGGER IF EXISTS side_search_update; DROP TABLE IF EXISTS side_fts');
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS side_fts USING fts5(record,input_text,content='side_turns',content_rowid='seq',tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS side_search_insert AFTER INSERT ON side_turns BEGIN INSERT INTO side_fts(rowid,record,input_text) VALUES(new.seq,new.record,new.input_text); END;
      CREATE TRIGGER IF NOT EXISTS side_search_update AFTER UPDATE OF record,input_text ON side_turns BEGIN
        INSERT INTO side_fts(side_fts,rowid,record,input_text) VALUES('delete',old.seq,old.record,old.input_text);
        INSERT INTO side_fts(rowid,record,input_text) VALUES(new.seq,new.record,new.input_text); END;`);
    if (!hadSideSearch) this.db.exec("INSERT INTO side_fts(side_fts) VALUES('rebuild')");
    const storedEpoch = this.meta<string>('eventEpoch', '');
    this.eventEpochValue = typeof storedEpoch === 'string' && storedEpoch ? storedEpoch : randomUUID();
    if (this.eventEpochValue !== storedEpoch) this.setMeta('eventEpoch', this.eventEpochValue);
    // Consume the previous JSON list in the same transaction as the inserts; a restart can retry safely.
    if (this.db.prepare("SELECT 1 FROM product_meta WHERE key='dismissedSessions'").get()) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const ids = this.meta<unknown>('dismissedSessions', []);
        if (!Array.isArray(ids)) throw new Error('Invalid dismissed session list.');
        for (const id of ids) if (typeof id === 'string') this.dismissSession(id);
        this.db.exec("DELETE FROM product_meta WHERE key='dismissedSessions'; COMMIT");
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    this.migrateEventLog();
  }
  close(): void { this.stopEventWaits(); this.db.close(); }
  /** Wake held HTTP requests before closing the server or the database. */
  stopEventWaits(): void {
    this.eventsClosing = true;
    for (const waiter of this.eventWaiters) waiter.close();
  }
  path(): string { return this.filename; }
  sideSession(parentKey: string, id?: string): { id: string; parentKey: string; targetTaskId?: string; consumed: number; offset: number } {
    let row = (id ? this.db.prepare('SELECT * FROM side_sessions WHERE id=? AND archived=0').get(id)
      : this.db.prepare('SELECT * FROM side_sessions WHERE parent_key=? AND archived=0').get(parentKey)) as Record<string, any> | undefined;
    if (id && (!row || row.parent_key !== parentKey)) throw new ProductError('scope', 'Side session does not belong to this conversation.', 403);
    if (!row) {
      const newId = `side-${randomUUID()}`;
      this.db.prepare('INSERT INTO side_sessions(id,parent_key) VALUES(?,?)').run(newId, parentKey);
      row = { id: newId, parent_key: parentKey, consumed_seq: 0 };
    }
    return { id: row.id, parentKey: row.parent_key, ...(row.target_task_id ? { targetTaskId: row.target_task_id } : {}), consumed: Number(row.consumed_seq), offset: Number(row.consumed_offset ?? 0) };
  }
  bindSideTask(id: string, taskId: string): void {
    const row = this.db.prepare('SELECT target_task_id FROM side_sessions WHERE id=?').get(id) as { target_task_id: string | null };
    if (row.target_task_id && row.target_task_id !== taskId) throw new ProductError('conflict', 'A side session cannot change its task binding.', 409);
    this.db.prepare('UPDATE side_sessions SET target_task_id=? WHERE id=?').run(taskId, id);
  }
  sideTurn(id: string): { seq: number; sessionId: string; record: SideAnswer } | undefined {
    const row = this.db.prepare('SELECT seq,session_id,record FROM side_turns WHERE id=?').get(id) as { seq: number; session_id: string; record: string } | undefined;
    return row ? { seq: Number(row.seq), sessionId: row.session_id, record: JSON.parse(row.record) } : undefined;
  }
  sideSource(sessionId: string, id: string, inputOnly = false): string {
    const row = this.db.prepare('SELECT input_text,record FROM side_turns WHERE id=? AND session_id=?').get(id, sessionId) as { input_text: string; record: string } | undefined;
    if (!row) throw new ProductError('scope', 'The historical turn is outside this side session.', 403);
    if (inputOnly) return row.input_text || (JSON.parse(row.record) as SideAnswer).question;
    return JSON.stringify({ input: row.input_text, turn: JSON.parse(row.record) });
  }
  searchSide(sessionId: string, query: string, before = Number.MAX_SAFE_INTEGER) {
    if (query.length < 3 || query.length > 300) throw new ProductError('validation', 'Side history search requires 3–300 characters.');
    const rows = this.db.prepare(`SELECT t.seq,t.id,substr(json_extract(t.record,'$.question'),1,400) AS question,substr(json_extract(t.record,'$.answer'),1,400) AS answer
      FROM side_fts JOIN side_turns t ON t.seq=side_fts.rowid WHERE side_fts MATCH ? AND t.session_id=? AND t.seq<? ORDER BY t.seq DESC LIMIT 6`)
      .all('"' + query.replaceAll('"', '""') + '"', sessionId, before) as { seq: number; id: string; question: string; answer: string }[];
    return { items: rows.slice(0, 5), nextCursor: rows.length > 5 ? rows[4]!.seq : null };
  }
  saveSideTurn(sessionId: string, record: SideAnswer, inputText = ''): void {
    const encoded = JSON.stringify(record);
    if (Buffer.byteLength(encoded) > 256 * 1024) throw new ProductError('validation', 'Side turn exceeds its durable record limit.');
    if (Buffer.byteLength(inputText) > 128 * 1024) throw new ProductError('validation', 'Side input exceeds its durable input limit.');
    this.db.prepare("INSERT INTO side_turns(id,session_id,record,input_text) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record,input_text=CASE WHEN side_turns.input_text='' THEN excluded.input_text ELSE side_turns.input_text END WHERE side_turns.session_id=excluded.session_id").run(record.id, sessionId, encoded, inputText);
  }
  recordSideInput(requestId: string, sessionId: string, after: UserInputProgress, through: UserInputProgress, ranges: InputRange[]): void {
    this.db.prepare('INSERT INTO side_request_inputs(request_id,session_id,after_seq,through_seq,after_offset,through_offset,ranges) VALUES(?,?,?,?,?,?,?)').run(requestId, sessionId, after.cursor, through.cursor, after.offset, through.offset, JSON.stringify(ranges));
  }
  sideInputNotes(sessionId: string): SideInputNote[] {
    const row = this.db.prepare('SELECT notes FROM side_request_inputs WHERE session_id=? AND consumed=1 ORDER BY rowid DESC LIMIT 1').get(sessionId) as { notes: string } | undefined;
    return row ? JSON.parse(row.notes) : [];
  }
  consumeSideInput(sessionId: string, progress: UserInputProgress, requestId: string, notes: SideInputNote[] = []): void {
    this.checkpointSideInput(sessionId, progress, requestId, notes);
  }
  completeSideTurn(sessionId: string, progress: UserInputProgress, record: SideAnswer): void {
    if (record.status !== 'completed' || !record.requestId || this.sideTurn(record.id)?.sessionId !== sessionId) throw new ProductError('conflict', 'Side completion must name its existing turn and final request.', 409);
    this.checkpointSideInput(sessionId, progress, record.requestId, [], record);
  }
  private checkpointSideInput(sessionId: string, progress: UserInputProgress, requestId: string, notes: SideInputNote[], completedTurn?: SideAnswer): void {
    const encoded = JSON.stringify(notes);
    if (Buffer.byteLength(encoded) > 64 * 1024) throw new ProductError('validation', 'Side input notes exceed their durable checkpoint limit.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT after_seq,after_offset,through_seq,through_offset FROM side_request_inputs WHERE request_id=? AND session_id=?').get(requestId, sessionId) as { after_seq: number; after_offset: number; through_seq: number; through_offset: number } | undefined;
      if (!row || row.through_seq !== progress.cursor || row.through_offset !== progress.offset) throw new ProductError('conflict', 'Side input checkpoint does not match its recorded request.', 409);
      const updated = this.db.prepare('UPDATE side_sessions SET consumed_seq=?,consumed_offset=? WHERE id=? AND ((consumed_seq=? AND consumed_offset=?) OR (consumed_seq=? AND consumed_offset=?))')
        .run(progress.cursor, progress.offset, sessionId, row.after_seq, row.after_offset, progress.cursor, progress.offset);
      if (updated.changes !== 1) throw new ProductError('conflict', 'Side input checkpoint is stale.', 409);
      this.db.prepare('UPDATE side_request_inputs SET consumed=1,notes=? WHERE request_id=? AND session_id=?').run(encoded, requestId, sessionId);
      // Readers must never observe completion with the previous unfinished-input notes.
      if (completedTurn) this.saveSideTurn(sessionId, completedTurn);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  sidePending(sessionId: string, after: number, through: number): { seq: number; record: SideAnswer; inputText: string }[] {
    const result: { seq: number; record: SideAnswer; inputText: string }[] = []; let bytes = 0;
    for (const row of this.db.prepare("SELECT seq,input_text,json_set(record,'$.answer','','$.operations',json('[]')) AS record FROM side_turns WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 32").iterate(sessionId, after, through) as Iterable<{ seq: number; input_text: string; record: string }>) {
      const size = Buffer.byteLength(row.input_text) + Buffer.byteLength(row.record);
      if (result.length && bytes + size > 256 * 1024) break;
      result.push({ seq: Number(row.seq), record: JSON.parse(row.record), inputText: row.input_text }); bytes += size;
    }
    return result;
  }
  sideHistory(parentKey: string, id?: string, before = Number.MAX_SAFE_INTEGER): SideHistory {
    const session = this.sideSession(parentKey, id);
    const items: SideAnswer[] = []; let bytes = 0; let cursor: number | undefined;
    for (const row of this.db.prepare('SELECT seq,record FROM side_turns WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT 41').iterate(session.id, before) as Iterable<{ seq: number; record: string }>) {
      if (items.length >= 40 || (items.length && bytes + Buffer.byteLength(row.record) > 256 * 1024)) { cursor = Number(this.sideTurn(items.at(-1)!.id)!.seq); break; }
      items.push(JSON.parse(row.record)); bytes += Buffer.byteLength(row.record);
    }
    return { sideSessionId: session.id, targetTaskId: session.targetTaskId, items: items.reverse(), ...(cursor ? { nextCursor: String(cursor) } : {}) };
  }
  archiveSideSession(parentKey: string, id: string): void {
    this.sideSession(parentKey, id);
    this.db.prepare('UPDATE side_sessions SET archived=1 WHERE id=?').run(id);
  }
  recoverSideTurns(): void {
    this.db.prepare("UPDATE side_turns SET record=json_set(record,'$.status','failed','$.answer','请求被后台重启中断；已执行操作保留原回执，请核对后继续。') WHERE json_extract(record,'$.status')='running'").run();
  }

  private row(value: unknown): SessionIndexRecord | undefined {
    if (!value) return undefined;
    const item = value as Record<string, unknown>;
    return {
      id: String(item.id), kind: item.kind === 'work' ? 'work' : 'chat', mode: String(item.mode) as SessionIndexRecord['mode'],
      title: String(item.title), status: String(item.status), permission: String(item.permission) as SessionIndexRecord['permission'],
      modelId: String(item.model_id), ...(item.reasoning_effort === null ? {} : { reasoningEffort: String(item.reasoning_effort) }),
      ...(item.project_id === null ? {} : { projectId: String(item.project_id) }), pinned: Number(item.pinned) === 1,
      ...(item.preview === null ? {} : { preview: String(item.preview) }), ...(item.unread === null ? {} : { unread: Number(item.unread) === 1 }),
      ...(item.parent_session_id === null ? {} : { parentSessionId: String(item.parent_session_id) }),
      ...(item.work_task_id === null ? {} : { workTaskId: String(item.work_task_id) }),
      createdAt: String(item.created_at), updatedAt: String(item.updated_at),
    };
  }

  getSession(id: string): SessionIndexRecord | undefined {
    return this.row(this.db.prepare('SELECT * FROM session_index WHERE id=?').get(id));
  }
  upsertSession(record: SessionIndexRecord): void {
    this.db.prepare(`INSERT INTO session_index(id,kind,mode,title,status,permission,model_id,reasoning_effort,project_id,pinned,preview,unread,parent_session_id,work_task_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,mode=excluded.mode,title=excluded.title,status=excluded.status,permission=excluded.permission,
        model_id=excluded.model_id,reasoning_effort=excluded.reasoning_effort,project_id=excluded.project_id,pinned=excluded.pinned,
        preview=excluded.preview,unread=excluded.unread,parent_session_id=excluded.parent_session_id,work_task_id=excluded.work_task_id,
        updated_at=excluded.updated_at`).run(record.id, record.kind, record.mode, record.title, record.status, record.permission, record.modelId,
      record.reasoningEffort ?? null, record.projectId ?? null, record.pinned ? 1 : 0, record.preview ?? null,
      record.unread === undefined ? null : record.unread ? 1 : 0, record.parentSessionId ?? null, record.workTaskId ?? null, record.createdAt, record.updatedAt);
  }
  /** 只更新展示字段；调用方必须先保证索引行存在。 */
  patchSession(id: string, patch: Partial<Omit<SessionIndexRecord, 'id'>>): SessionIndexRecord {
    const current = this.getSession(id);
    if (!current) throw new Error('Session index entry not found.');
    const next = { ...current, ...patch, id: current.id, createdAt: current.createdAt };
    this.upsertSession(next);
    return next;
  }
  removeSession(id: string): void {
    this.db.prepare('DELETE FROM session_index WHERE id=?').run(id);
  }
  listSessions(query: { mode?: string; projectId?: string; text?: string; cursor?: string; limit?: number }): { items: SessionIndexRecord[]; nextCursor?: string } {
    const limit = Math.max(1, Math.min(100, query.limit ?? 40));
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    if (query.mode) { clauses.push('mode=?'); values.push(query.mode); }
    if (query.projectId) { clauses.push('project_id=?'); values.push(query.projectId); }
    if (query.text) {
      const pattern = `%${like(query.text.slice(0, 200))}%`;
      clauses.push("(title LIKE ? ESCAPE '\\' OR COALESCE(preview,'') LIKE ? ESCAPE '\\')");
      values.push(pattern, pattern);
    }
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      clauses.push('(pinned < ? OR (pinned = ? AND (updated_at < ? OR (updated_at = ? AND id < ?))))');
      values.push(cursor.pinned, cursor.pinned, cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const rows = this.db.prepare(`SELECT * FROM session_index ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
      ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ?`).all(...values, limit + 1);
    const items = rows.slice(0, limit).map(row => this.row(row)!);
    const nextCursor = rows.length > limit && items.length
      ? encodeCursor({ pinned: items.at(-1)!.pinned ? 1 : 0, updatedAt: items.at(-1)!.updatedAt, id: items.at(-1)!.id })
      : undefined;
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }
  workSessions(limit = 500): SessionIndexRecord[] {
    return this.db.prepare("SELECT * FROM session_index WHERE kind='work' ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(2000, limit))).map(row => this.row(row)!);
  }
  chatSessions(limit = 500): SessionIndexRecord[] {
    return this.db.prepare("SELECT * FROM session_index WHERE kind='chat' ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(2000, limit))).map(row => this.row(row)!);
  }
  *unpinnedSessionPages(): Generator<HistoryRow[]> {
    const select = this.db.prepare('SELECT rowid AS pos,id,kind FROM session_index WHERE pinned=0 AND rowid>? ORDER BY rowid LIMIT 128');
    let cursor = 0;
    for (;;) {
      const page = select.all(cursor) as (HistoryRow & { pos: number })[];
      if (!page.length) return;
      cursor = page[page.length - 1].pos;
      yield page;
    }
  }
  isSessionDismissed(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM dismissed_sessions WHERE id=?').get(id));
  }
  dismissSession(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO dismissed_sessions(id) VALUES(?)').run(id);
  }
  removeHistoryPage(rows: HistoryRow[]): void {
    this.commitEvents(rows.map(({ id }) => ({ event: { type: 'session.removed', sessionId: id }, sessionId: id })), () => {
      for (const row of rows) {
        if (row.kind === 'work') this.dismissSession(row.id);
        this.removeSession(row.id);
      }
    });
  }
  projectSessionCount(projectId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS total FROM session_index WHERE project_id=?').get(projectId) as { total: number }).total);
  }
  unlinkProject(projectId: string): number {
    return Number(this.db.prepare('UPDATE session_index SET project_id=NULL WHERE project_id=?').run(projectId).changes);
  }

  /**
   * 有界变更日志。只保留可重建界面所需的最近投影：
   * - 同一消息的流式快照是自包含的累积文本，后一条总覆盖前一条，因此只保留最新一条；
   * - 字节配额（而非仅行数）约束真实磁盘/WAL 与首次回放，淘汰按最旧 id 推进水位；
   * - 淘汰水位写入 product_meta，事件游标低于水位时必须 reset 走 snapshot，不能静默跳过；
   * - 配额在事务内每写入一条后立即执行，批量 append 提交后同样有界，而不是只对"一次一条"的
   *   调用有界。唯一例外是单条事件本身大于配额：保留最新一条（无法拆分），下一条事件到来即
   *   淘汰。持久化日志的精确上界是 max(PRODUCT_EVENT_BYTES_LIMIT, 最新一条记录字节数)，
   *   行数不超过 PRODUCT_EVENT_ROW_LIMIT。
   * 计数器 product_event_stats 让每次追加都是 O(1)，不对全表做 SUM。
   * 说明：Chat 的流式 partial 在 chat.ts 限制 256KiB、Work 的 delta tail 限制 16KiB，但终态消息
   * 本身没有 store 层硬上限，因此不能宣称任何时刻都严格 ≤ 8MiB。
   */
  append(events: StoredEvent[]): number[] {
    return this.commitEvents(events);
  }
  private commitEvents(events: StoredEvent[], updateIndex?: () => void): number[] {
    if (!events.length) return [];
    const insert = this.db.prepare('INSERT INTO product_events(session_id,type,record,created_at,stream_key) VALUES(?,?,?,?,?)');
    const findProjection = this.db.prepare('SELECT id, LENGTH(CAST(record AS BLOB)) AS bytes FROM product_events WHERE stream_key=? ORDER BY id LIMIT 1');
    const remove = this.db.prepare('DELETE FROM product_events WHERE id=?');
    const ids: number[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      updateIndex?.();
      for (const item of events) {
        const record = JSON.stringify(item.event);
        const bytes = Buffer.byteLength(record, 'utf8');
        const sessionId = item.sessionId ?? (item.event.type === 'message.upsert' ? item.event.sessionId : undefined);
        const key = item.event.type === 'message.upsert' && sessionId ? streamKeyOf(sessionId, item.event.message.id) : undefined;
        if (key) {
          const previous = findProjection.get(key) as { id: number; bytes: number } | undefined;
          if (previous) {
            remove.run(Number(previous.id));
            this.db.prepare('UPDATE product_event_stats SET rows=rows-1, bytes=bytes-? WHERE singleton=1').run(Number(previous.bytes));
          }
        }
        const streaming = item.event.type === 'message.upsert' && item.event.message.status === 'streaming';
        const result = insert.run(sessionId ?? null, item.event.type, record, stamp(), streaming && key ? key : null);
        ids.push(Number(result.lastInsertRowid));
        this.db.prepare('UPDATE product_event_stats SET rows=rows+1, bytes=bytes+? WHERE singleton=1').run(bytes);
        this.enforceEventCaps();
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (this.eventWaiters.size && !this.eventNotificationPending) {
      this.eventNotificationPending = true;
      queueMicrotask(() => {
        this.eventNotificationPending = false;
        for (const waiter of this.eventWaiters) waiter.update();
      });
    }
    return ids;
  }
  /** One bounded held read per client; committed events wake it, so idle clients do no polling work. */
  async waitEvents(cursor: number, limit: number, sessionId: string | undefined, waitMs: number, signal?: AbortSignal) {
    if (this.eventsClosing) throw new ProductError('unavailable', 'The event store is closing.', 503, true);
    signal?.throwIfAborted();
    const first = this.eventsAfter(cursor, limit, sessionId);
    if (first.events.length || first.reset) return { ...first, longPoll: true };
    if (this.eventWaiters.size >= 64) throw new ProductError('busy', 'Too many live event readers.', 429, true);
    type Page = ReturnType<ProductStore['eventsAfter']>;
    const page = await new Promise<Page>((resolve, reject) => {
      const finish = (result?: Page, error?: unknown) => {
        clearTimeout(timer);
        this.eventWaiters.delete(waiter);
        signal?.removeEventListener('abort', aborted);
        if (result) resolve(result); else reject(error);
      };
      const aborted = () => finish(undefined, signal!.reason);
      const waiter = {
        update: () => {
          try {
            const current = this.eventsAfter(cursor, limit, sessionId);
            if (current.events.length || current.reset) finish(current);
          } catch (error) { finish(undefined, error); }
        },
        close: () => finish(undefined, new ProductError('unavailable', 'The event store is closing.', 503, true)),
      };
      const timer = setTimeout(() => {
        try { finish(this.eventsAfter(cursor, limit, sessionId)); }
        catch (error) { finish(undefined, error); }
      }, waitMs);
      timer.unref();
      this.eventWaiters.add(waiter);
      signal?.addEventListener('abort', aborted, { once: true });
    });
    return { ...page, longPoll: true };
  }
  eventsAfter(cursor: number, limit = 100, sessionId?: string): { events: { id: number; event: GatewayEvent }[]; nextCursor: number; earliest: number; reset: boolean; epoch: string } {
    const size = Math.max(1, Math.min(200, limit));
    const earliest = Number((this.db.prepare('SELECT COALESCE(MIN(id),0) AS id FROM product_events').get() as { id: number }).id);
    const latest = this.latestEventId();
    // 两种需要重建游标的情况：游标不属于本日志（未来 id/空库），或低于配额淘汰水位。
    // 注意：被"同消息最新快照"覆盖而删除的行不构成历史丢失，不推进水位，因此不会误报 reset。
    const evictedThrough = this.eventEvictionFloor();
    const resync = cursor > 0 && (latest === 0 || cursor > latest || cursor < evictedThrough);
    const rows = resync ? [] : (sessionId
      ? this.db.prepare('SELECT id,record FROM product_events WHERE id>? AND session_id=? ORDER BY id LIMIT ?').all(cursor, sessionId, size)
      : this.db.prepare('SELECT id,record FROM product_events WHERE id>? ORDER BY id LIMIT ?').all(cursor, size)) as { id: number; record: string }[];
    return {
      events: rows.map(row => ({ id: Number(row.id), event: JSON.parse(row.record) as GatewayEvent })),
      nextCursor: resync ? latest : rows.length ? Number(rows.at(-1)!.id) : cursor,
      earliest, reset: resync, epoch: this.eventEpochValue,
    };
  }
  latestEventId(): number {
    return Number((this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM product_events').get() as { id: number }).id);
  }
  /** 事件日志代际：数据库被替换后会变化，前端据此判断整份状态是否需要重建。 */
  eventEpoch(): string {
    return this.eventEpochValue;
  }
  /** 当前保留量（O(1) 计数器），用于资源回归检查和诊断。 */
  eventLogUsage(): { rows: number; bytes: number; evictedThrough: number; rowLimit: number; byteLimit: number } {
    const stats = this.eventStats() ?? { rows: 0, bytes: 0 };
    return { ...stats, evictedThrough: this.eventEvictionFloor(), rowLimit: PRODUCT_EVENT_ROW_LIMIT, byteLimit: PRODUCT_EVENT_BYTES_LIMIT };
  }

  private eventStats(): { rows: number; bytes: number } | undefined {
    const row = this.db.prepare('SELECT rows, bytes FROM product_event_stats WHERE singleton=1').get() as { rows: number; bytes: number } | undefined;
    return row ? { rows: Number(row.rows), bytes: Number(row.bytes) } : undefined;
  }
  private eventEvictionFloor(): number {
    const value = this.meta<unknown>('eventLogEvictedThrough', 0);
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
  }
  /** 打开旧库时补齐 schema/计数器，清掉旧的累积快照，并回收一次被行数保留撑大的文件。 */
  private migrateEventLog(): void {
    const columns = this.db.prepare('PRAGMA table_info(product_events)').all() as { name: string }[];
    const hadStreamKey = columns.some(column => column.name === 'stream_key');
    if (!hadStreamKey) this.db.exec('ALTER TABLE product_events ADD COLUMN stream_key TEXT');
    // 流式投影键唯一，保证同一消息最多一条可覆盖的快照。
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS product_events_stream ON product_events(stream_key) WHERE stream_key IS NOT NULL');
    if (!this.eventStats()) {
      const counted = this.db.prepare('SELECT COUNT(*) AS rows, CAST(COALESCE(SUM(LENGTH(CAST(record AS BLOB))), 0) AS INTEGER) AS bytes FROM product_events').get() as { rows: number; bytes: number };
      const earliest = Number((this.db.prepare('SELECT COALESCE(MIN(id),0) AS id FROM product_events').get() as { id: number }).id);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('INSERT INTO product_event_stats(singleton,rows,bytes) VALUES(1,?,?)').run(Number(counted.rows), Number(counted.bytes));
        // 旧实现只按行数淘汰，可能已经删掉了最早的一段真实事件。记录一次水位，让从旧日志
        // 继承的游标走 snapshot，而不是把"永远等不到的事件"当成正常追赶。
        const floor = Math.max(0, earliest - 1);
        if (floor > 0) this.setMeta('eventLogEvictedThrough', Math.max(floor, this.eventEvictionFloor()));
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    // 标记值让"ALTER 已提交但清理前崩溃"的旧库下次仍能完成一次性迁移；没有标记的库重扫一遍
    // 是幂等的（只设置/删除被覆盖的快照）。
    if (!hadStreamKey || this.meta<unknown>('eventLogStreamCompaction', 0) !== 1) {
      this.compactLegacyStreamEvents();
      this.setMeta('eventLogStreamCompaction', 1);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try { this.enforceEventCaps(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.reclaimEventLogSpace();
  }
  /** 旧库的一次性迁移：同一消息的历史累积快照只留最新一条；已有终态则快照全部作废。 */
  private compactLegacyStreamEvents(): void {
    // 旧库最多约 5000 行，但每行可能接近 256KiB；一次 .all() 物化全表会占用 >1GiB。按 id keyset
    // 分页（每页 50 行）扫描，内存只与页大小和每个 key 的元数据（id/bytes）相关。每页仍会读入
    // 该页的完整记录（需要 JSON 解析出消息 id/status），所以峰值是"50 × 最大单条记录"，不是全表。
    const pageSize = 50;
    const page = this.db.prepare("SELECT id, session_id, record FROM product_events WHERE type='message.upsert' AND id>? ORDER BY id LIMIT ?");
    const latest = new Map<string, { id: number; bytes: number }>();
    const terminal = new Map<string, number>();
    const superseded: { id: number; bytes: number }[] = [];
    let cursor = 0;
    for (;;) {
      const rows = page.all(cursor, pageSize) as { id: number; session_id: string | null; record: string }[];
      if (!rows.length) break;
      for (const row of rows) {
        cursor = Number(row.id);
        if (!row.session_id) continue;
        let event: GatewayEvent;
        try { event = JSON.parse(row.record) as GatewayEvent; } catch { continue; }
        if (event.type !== 'message.upsert') continue;
        const key = streamKeyOf(row.session_id, event.message.id);
        if (event.message.status === 'streaming') {
          const previous = latest.get(key);
          if (previous) superseded.push(previous);
          latest.set(key, { id: Number(row.id), bytes: Buffer.byteLength(row.record, 'utf8') });
        } else {
          terminal.set(key, Math.max(terminal.get(key) ?? 0, Number(row.id)));
        }
      }
    }
    // 扫描只读；删除在下一个事务里提交。崩溃时标记尚未写入，下次重新扫描，重复执行幂等。
    const kept: { key: string; id: number }[] = [];
    for (const [key, value] of latest) {
      const terminalId = terminal.get(key) ?? 0;
      if (terminalId > value.id) superseded.push(value);
      else kept.push({ key, id: value.id });
    }
    if (!superseded.length && !kept.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const setKey = this.db.prepare('UPDATE product_events SET stream_key=? WHERE id=?');
      const removeOne = this.db.prepare('DELETE FROM product_events WHERE id=?');
      for (const item of kept) setKey.run(item.key, item.id);
      let removedRows = 0; let removedBytes = 0;
      for (const item of superseded) {
        if (Number(removeOne.run(item.id).changes) === 1) { removedRows += 1; removedBytes += item.bytes; }
      }
      if (removedRows) this.db.prepare('UPDATE product_event_stats SET rows=rows-?, bytes=bytes-? WHERE singleton=1').run(removedRows, removedBytes);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /**
   * 按字节/行数配额从最旧 id 淘汰。只保护最新一条事件（单条 oversize 的唯一例外），不保护整个
   * append 批次：批次越大越应淘汰自己的旧行，否则批量写入可以绕过配额。事务内调用，失败回滚。
   */
  private enforceEventCaps(): void {
    let stats = this.eventStats();
    if (!stats) return;
    let evictedThrough = this.eventEvictionFloor();
    let evicted = false;
    while (stats.bytes > PRODUCT_EVENT_BYTES_LIMIT || stats.rows > PRODUCT_EVENT_ROW_LIMIT) {
      const oldest = this.db.prepare('SELECT id, LENGTH(CAST(record AS BLOB)) AS bytes FROM product_events ORDER BY id LIMIT 1').get() as { id: number; bytes: number } | undefined;
      if (!oldest) break;
      const id = Number(oldest.id);
      if (id === this.latestEventId()) break;
      this.db.prepare('DELETE FROM product_events WHERE id=?').run(id);
      stats = { rows: stats.rows - 1, bytes: stats.bytes - Number(oldest.bytes) };
      evictedThrough = Math.max(evictedThrough, id);
      evicted = true;
    }
    this.db.prepare('UPDATE product_event_stats SET rows=?, bytes=? WHERE singleton=1').run(stats.rows, stats.bytes);
    if (evicted) this.setMeta('eventLogEvictedThrough', evictedThrough);
  }
  /**
   * 旧库被行数保留撑大的物理文件一次性 VACUUM；失败只记录并留待下次启动，不阻塞启动。
   * 代价必须如实计入：VACUUM 会重写整个 product.sqlite（包括与事件无关的归档表），需要大致
   * 同样大小的临时空间，并在重写期间持有排他锁。只在启动时、且事件淘汰留下的 freelist 超过
   * 8MiB 时触发，普通追加不会反复触发；大归档库上的这一次启动会明显变慢。
   */
  private reclaimEventLogSpace(): void {
    const pageSize = Number((this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size);
    const freePages = Number((this.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count);
    // 只回收"事件淘汰产生的空闲页"，不因正常增长的其他表（例如历史归档）反复 VACUUM。
    if (!Number.isFinite(pageSize * freePages) || pageSize * freePages <= PRODUCT_EVENT_BYTES_LIMIT) return;
    try {
      this.db.exec('VACUUM');
      this.db.prepare("DELETE FROM product_meta WHERE key='eventLogReclaimDeferred'").run();
    } catch (error) {
      this.setMeta('eventLogReclaimDeferred', { at: stamp(), message: error instanceof Error ? error.message : String(error) });
    }
  }
  archive(input: { sessionId: string; kind: ArchivedHistory['kind']; sourceIds: string[]; record: unknown }): string {
    const serialized = JSON.stringify(input.record);
    if (Buffer.byteLength(serialized, 'utf8') > 4 * 1024 * 1024) throw new Error('The replaced history is too large to archive in one operation.');
    const id = `archive-${randomUUID()}`;
    this.db.prepare('INSERT INTO archived_history(id,session_id,kind,source_ids,record,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, input.sessionId, input.kind, JSON.stringify(input.sourceIds.slice(0, 5000)), serialized, stamp());
    return id;
  }
  archives(sessionId: string): ArchivedHistory[] {
    return (this.db.prepare('SELECT id,session_id,kind,source_ids,record,created_at FROM archived_history WHERE session_id=? ORDER BY created_at DESC LIMIT 200').all(sessionId) as Record<string, string>[])
      .map(row => ({ id: row.id, sessionId: row.session_id, kind: row.kind as ArchivedHistory['kind'], sourceIds: JSON.parse(row.source_ids) as string[], createdAt: row.created_at, record: JSON.parse(row.record) }));
  }
  getArchive(id: string): ArchivedHistory | undefined {
    const row = this.db.prepare('SELECT id,session_id,kind,source_ids,record,created_at FROM archived_history WHERE id=?').get(id) as Record<string, string> | undefined;
    return row ? { id: row.id, sessionId: row.session_id, kind: row.kind as ArchivedHistory['kind'], sourceIds: JSON.parse(row.source_ids) as string[], createdAt: row.created_at, record: JSON.parse(row.record) } : undefined;
  }
  meta<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT record FROM product_meta WHERE key=?').get(key) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as T : fallback;
  }
  setMeta(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO product_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET record=excluded.record').run(key, JSON.stringify(value));
  }
}
