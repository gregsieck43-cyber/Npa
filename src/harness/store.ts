import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { HistoryArchive } from '../memory/archive.js';
import { ensurePromotedOrigin, PreservedOriginMemory, promotedOriginFile, type PromotedLink } from './promoted-memory.js';
import type { ScopedMemoryPort } from '../memory/tools.js';
import type { Command } from '../contracts.js';
import { assertLocalPath } from '../app/local-paths.js';
import { initializeMetrics, readMetrics, saveMetrics } from './metrics.js';
import type { ChatSession, ChatMessage, RequestRecord, TraceEvent, TraceQuery, Preset, ToolRecord } from './types.js';

const stamp = () => new Date().toISOString();
const decode = <T>(row: unknown): T | undefined => row ? JSON.parse((row as { record: string }).record) as T : undefined;
/** A claimed one-shot edit older than this was left by a crashed request; it becomes claimable again. */
const OVERRIDE_CLAIM_STALE_MS = 10 * 60_000;
/** A branch copy page bound: total work may be O(n), but only one page of decoded history is resident. */
const BRANCH_COPY_PAGE = 500;
export type PromptOverrideField = 'systemPrompt' | 'developerPrompt' | 'dynamic';
export interface PendingRequestOverride { partId: string; field: PromptOverrideField; content: string }
export interface RequestOverrideClaim { token: string; edits: PendingRequestOverride[]; overrides: Partial<Record<PromptOverrideField, string>> }
export interface PendingChatToolBinding { index: number; scope?: string; command: Command }

/** One local writer; indexed metadata keeps large request bodies out of list queries. */

export class HarnessStore {
  private readonly db: DatabaseSync;
  private readonly archive: HistoryArchive;
  private readonly dataDir: string;
  private inTransaction = false;
  constructor(dataDir: string) {
    assertLocalPath(dataDir, 'Harness data directory'); mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.db = new DatabaseSync(path.join(dataDir, 'harness.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.transaction(() => {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions(id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_sessions_workspace ON chat_sessions(lower(json_extract(record,'$.workspace')),updated_at DESC);
      CREATE TABLE IF NOT EXISTS chat_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_messages_session ON chat_messages(session_id,seq);
      -- Branch regeneration finds the nearest prior user row through the role partial index, never
      -- by decoding the assistant/tool rows in between.
      CREATE INDEX IF NOT EXISTS chat_messages_user ON chat_messages(session_id,seq) WHERE json_extract(record,'$.role')='user';
      CREATE INDEX IF NOT EXISTS chat_messages_source ON chat_messages(session_id,json_extract(record,'$.sourceMessageId'));
      -- A branch owns immutable original records only through a message actually copied into it.
      CREATE TABLE IF NOT EXISTS chat_history_sources(session_id TEXT NOT NULL,source_id TEXT NOT NULL,anchor_message_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(session_id,source_id));
      CREATE INDEX IF NOT EXISTS chat_history_sources_anchor ON chat_history_sources(session_id,anchor_message_id);
      CREATE TRIGGER IF NOT EXISTS chat_history_sources_delete AFTER DELETE ON chat_messages BEGIN
        DELETE FROM chat_history_sources WHERE session_id=old.session_id AND anchor_message_id=old.id;
      END;
      CREATE INDEX IF NOT EXISTS chat_tool_results ON chat_messages(session_id,json_extract(record,'$.requestId'),json_extract(record,'$.toolCallId')) WHERE json_extract(record,'$.role')='tool';
      CREATE TABLE IF NOT EXISTS requests(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,task_id TEXT,created_at TEXT NOT NULL,status TEXT NOT NULL,record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_session ON requests(session_id,seq);
      CREATE INDEX IF NOT EXISTS requests_session_created ON requests(session_id,created_at,seq);
      CREATE INDEX IF NOT EXISTS requests_task ON requests(task_id,seq);
      CREATE TABLE IF NOT EXISTS trace(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,task_id TEXT,request_id TEXT,type TEXT NOT NULL,timestamp TEXT NOT NULL,status TEXT NOT NULL,record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trace_session ON trace(session_id,id);
      CREATE INDEX IF NOT EXISTS trace_task ON trace(task_id,id);
      CREATE INDEX IF NOT EXISTS trace_request ON trace(request_id,id);
      CREATE INDEX IF NOT EXISTS trace_type ON trace(type,id);
      CREATE INDEX IF NOT EXISTS trace_branch_history ON trace(session_id,id) WHERE type='chat.branched';
      CREATE TABLE IF NOT EXISTS tool_calls(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,session_id TEXT NOT NULL,task_id TEXT,record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tool_calls_request ON tool_calls(request_id);
      CREATE INDEX IF NOT EXISTS tool_calls_session ON tool_calls(session_id);
      CREATE INDEX IF NOT EXISTS tool_calls_task ON tool_calls(task_id);
      CREATE INDEX IF NOT EXISTS tool_calls_task_call ON tool_calls(task_id,json_extract(record,'$.toolCallId'));
      CREATE INDEX IF NOT EXISTS tool_calls_unreceived ON tool_calls(request_id) WHERE json_extract(record,'$.receivedByRequestId') IS NULL;
      CREATE TABLE IF NOT EXISTS imported_events(source_id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS work_projection_versions(kind TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS presets(id TEXT NOT NULL,version INTEGER NOT NULL,kind TEXT NOT NULL,scope TEXT NOT NULL,scope_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE INDEX IF NOT EXISTS presets_scope ON presets(kind,scope,scope_id);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_tool_bindings(session_id TEXT NOT NULL,ordinal INTEGER NOT NULL,task_id TEXT NOT NULL,owner_registered INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,ordinal));
      CREATE INDEX IF NOT EXISTS chat_tool_bindings_unregistered ON chat_tool_bindings(owner_registered);
      CREATE TABLE IF NOT EXISTS chat_tool_pending(session_id TEXT PRIMARY KEY,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_overrides(id INTEGER PRIMARY KEY AUTOINCREMENT,target_id TEXT NOT NULL,part_id TEXT NOT NULL,field TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,claimed_token TEXT,claimed_at TEXT,consumed_request_id TEXT,UNIQUE(target_id,field));`);
    initializeMetrics(this.db);
    // Interrupted requests are observations, never silently replayed on startup.
    for (const row of this.db.prepare("SELECT record FROM requests WHERE status='running'").all()) {
      const request = decode<RequestRecord>(row)!;
      this.updateRequest(request.id, { status: 'cancelled', error: { code: 'restart_interrupted', message: 'Backend restarted before this request finished. Replay is an explicit new request.' } });
      this.trace({ sessionId: request.sessionId, taskId: request.taskId, requestId: request.id, runId: request.runId, type: 'request.interrupted', status: 'cancelled' });
    }
    });
    this.archive = new HistoryArchive(this.db, 'chat');
  }
  memory(sessionId: string, through?: number, sanitize?: (content: string) => string) {
    this.getSession(sessionId);
    return this.archive.scope(sessionId, through, (id, bound) => {
      return this.historySource(sessionId, id, bound, sanitize)?.record;
    });
  }
  private sourceRecord(raw: string, sanitize?: (content: string) => string): string {
    if (!sanitize) return raw;
    const source = JSON.parse(raw) as ChatMessage, content = sanitize(source.content), reasoning = source.reasoningContent === undefined ? undefined : sanitize(source.reasoningContent);
    if (content === source.content && reasoning === source.reasoningContent) return raw;
    return JSON.stringify({ ...source, content, ...(reasoning === undefined ? {} : { reasoningContent: reasoning }) });
  }
  /** Lazy legacy recovery follows trusted branch edges only, bounded to 32 single-record steps. */
  private historySource(sessionId: string, id: string, through: number, sanitize?: (content: string) => string, depth = 0): { record: string; anchorId: string } | undefined {
    const saved = this.db.prepare('SELECT source.record,anchor.id AS anchorId FROM chat_history_sources source JOIN chat_messages anchor ON anchor.id=source.anchor_message_id AND anchor.session_id=source.session_id WHERE source.session_id=? AND source.source_id=? AND anchor.seq<=?').get(sessionId, id, through) as { record: string; anchorId: string } | undefined;
    if (saved) return saved;
    if (depth >= 32) throw new Error('Source not found in this conversation scope: legacy provenance exceeds the bounded recovery depth.');
    const session = this.getSession(sessionId);
    if (!session.parentSessionId || !session.branchMessageId) return undefined;
    const event = decode<TraceEvent>(this.db.prepare("SELECT record FROM trace WHERE session_id=? AND type='chat.branched' ORDER BY id LIMIT 1").get(sessionId));
    const proof = event?.payload as Record<string, unknown> | undefined;
    const unavailable = (reason: string): never => { throw new Error(`Source not found in this conversation scope: legacy original cannot be recovered (${reason}).`); };
    if (!event || event.parentId !== session.parentSessionId || event.status !== 'completed' || proof?.originalMessageId !== session.branchMessageId || typeof proof.edited !== 'boolean' || typeof proof.sourceLastMessageId !== 'string') return unavailable('missing bounded branch evidence');
    const cutoff = this.messageRef(session.parentSessionId, proof.sourceLastMessageId);
    if (!cutoff) return unavailable('original prefix anchor was deleted');
    const parent = this.db.prepare('SELECT id AS anchorId,record FROM chat_messages WHERE session_id=? AND id=? AND seq<=?').get(session.parentSessionId, id, cutoff.seq) as { anchorId: string; record: string } | undefined;
    const origin = parent ?? this.historySource(session.parentSessionId, id, cutoff.seq, sanitize, depth + 1);
    if (!origin) return undefined;
    const local = this.db.prepare("SELECT id,record FROM chat_messages WHERE session_id=? AND json_extract(record,'$.sourceMessageId')=? AND seq<=? ORDER BY seq LIMIT 1").get(sessionId, origin.anchorId, through) as { id: string; record: string } | undefined;
    if (!local) return undefined;
    if (proof.edited && proof.originalMessageId === origin.anchorId) return unavailable('the selected message was edited without an original snapshot');
    const parentAnchor = this.messageRef(session.parentSessionId, origin.anchorId)?.message;
    const copy = JSON.parse(local.record) as ChatMessage;
    if (!parentAnchor || !(Date.parse(parentAnchor.createdAt) <= Date.parse(copy.createdAt) && Date.parse(copy.createdAt) <= Date.parse(event.timestamp))) return unavailable('source/copy timestamps do not establish the branch boundary');
    const fields = (message: ChatMessage) => JSON.stringify({ role: message.role, content: sanitize ? sanitize(message.content) : message.content,
      reasoningContent: message.reasoningContent === undefined ? undefined : sanitize ? sanitize(message.reasoningContent) : message.reasoningContent,
      attachments: message.attachments ?? [], toolCalls: message.toolCalls ?? [], toolCallId: message.toolCallId, archiveRecall: !!message.archiveRecall });
    if (fields(parentAnchor) !== fields(copy)) return unavailable('the original or copied message changed since branching');
    // Timestamp equality and matching copies alone are insufficient: both messages can be edited
    // in place later. Require a raw-record hash already recorded before this branch was created.
    const expected = createHash('sha256').update(JSON.stringify(parentAnchor)).digest('hex');
    const witnessed = this.db.prepare(`WITH recent AS (
      SELECT seq FROM requests WHERE session_id=? AND created_at<=? ORDER BY created_at DESC,seq DESC LIMIT 16
    ) SELECT 1 AS valid FROM recent JOIN requests r ON r.seq=recent.seq,
      json_each(r.record,'$.sources') part,
      json_each(CASE WHEN json_valid(json_extract(part.value,'$.content')) THEN json_extract(part.value,'$.content') ELSE '{}' END,'$.sources') source
    WHERE json_extract(part.value,'$.id') IN ('context-selection','context-manifest')
      AND json_extract(source.value,'$.id')=? AND json_extract(source.value,'$.sessionId')=?
      AND json_extract(source.value,'$.sha256')=? LIMIT 1`).get(session.parentSessionId, session.createdAt, origin.anchorId, session.parentSessionId, expected);
    if (!witnessed) return unavailable('no matching original SHA in the bounded pre-branch request evidence');
    const record = this.sourceRecord(origin.record, sanitize);
    this.db.prepare('INSERT OR IGNORE INTO chat_history_sources(session_id,source_id,anchor_message_id,record) VALUES(?,?,?,?)').run(sessionId, id, local.id, record);
    return { record, anchorId: local.id };
  }
  promotedMemory(taskId: string): ScopedMemoryPort | undefined {
    const link = this.getSetting<PromotedLink | null>(`promotedChat:${taskId}`, null);
    if (!link) return undefined;
    const snapshot = this.promotedSnapshot(taskId, link);
    return snapshot === undefined ? undefined : this.preservedOrigin(taskId, link, snapshot);
  }
  /** Copy every origin record a promotion may still read, before the live rows change or disappear. */
  preservePromotedOrigins(sessionId: string): void {
    // Narrow the scan in SQLite: only this Chat's links are decoded, never every promotion record.
    const rows = this.db.prepare(
      "SELECT key,record FROM settings WHERE key LIKE 'promotedChat:%' AND json_valid(record) AND json_extract(record,'$.sessionId')=?",
    ).all(sessionId) as { key: string; record: string }[];
    for (const row of rows) {
      const link = decode<PromotedLink>({ record: row.record });
      if (!link?.sessionId) continue;
      const taskId = row.key.slice('promotedChat:'.length);
      const snapshot = this.promotedSnapshot(taskId, link);
      if (snapshot !== undefined) this.preservedOrigin(taskId, link, snapshot);
    }
  }
  private promotedSnapshot(taskId: string, link: PromotedLink): number | undefined {
    if (link.archiveSnapshot !== undefined) return link.archiveSnapshot;
    if (!link.sourceMessageIds?.length) return undefined;
    // Older promotions already retained the selected source IDs, including the last record.
    const marks = link.sourceMessageIds.map(() => '?').join(',');
    const row = this.db.prepare('SELECT MAX(seq) AS seq FROM chat_messages WHERE session_id=? AND id IN (' + marks + ')').get(link.sessionId, ...link.sourceMessageIds) as { seq: number | null };
    if (row.seq === null) return undefined;
    this.setSetting('promotedChat:' + taskId, { ...link, archiveSnapshot: row.seq });
    return row.seq;
  }
  private preservedOrigin(taskId: string, link: PromotedLink, snapshot: number): ScopedMemoryPort {
    const file = promotedOriginFile(this.dataDir, taskId);
    ensurePromotedOrigin(this.db, file, link.sessionId, snapshot, messageId => {
      const source = this.messageRef(link.sessionId, messageId)?.message.sourceMessageId;
      if (source) this.recoverHistorySourceChain(link.sessionId, source);
    });
    return new PreservedOriginMemory(file, link.sessionId, snapshot);
  }
  close(): void { this.db.close(); }
  transaction<T>(action: () => T): T {
    if (this.inTransaction) return action();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  createSession(input: Partial<ChatSession> = {}): ChatSession {
    const now = stamp();
    const session: ChatSession = { ...input, id: `chat-${randomUUID()}`, title: input.title?.trim() || '新对话', createdAt: now, updatedAt: now,
      profileId: input.profileId ?? 'default', systemPrompt: input.systemPrompt ?? '', developerPrompt: input.developerPrompt ?? '',
      parameters: input.parameters ?? {}, capabilities: { web: false, tools: false, mcp: false, skills: false, projectInstructions: false, ...input.capabilities } };
    this.db.prepare('INSERT INTO chat_sessions VALUES(?,?,?)').run(session.id, now, JSON.stringify(session));
    return session;
  }
  getSession(id: string): ChatSession { const row = decode<ChatSession>(this.db.prepare('SELECT record FROM chat_sessions WHERE id=?').get(id)); if (!row) throw new Error('Chat session not found.'); return row; }
  listSessions(): ChatSession[] { return this.db.prepare('SELECT record FROM chat_sessions ORDER BY updated_at DESC').all().map(row => decode<ChatSession>(row)!); }
  workspaceSessions(workspace: string): Pick<ChatSession, 'id' | 'title' | 'workspace' | 'profileId' | 'updatedAt'>[] {
    return this.db.prepare(`SELECT json_object('id',id,'title',substr(json_extract(record,'$.title'),1,200),'workspace',json_extract(record,'$.workspace'),
      'profileId',json_extract(record,'$.profileId'),'updatedAt',updated_at) AS record FROM chat_sessions WHERE lower(json_extract(record,'$.workspace'))=? ORDER BY updated_at DESC LIMIT 60`)
      .all(path.resolve(workspace).toLowerCase()).map(row => decode<Pick<ChatSession, 'id' | 'title' | 'workspace' | 'profileId' | 'updatedAt'>>(row)!);
  }
  sessionPage(after = 0, limit = 100): { items: ChatSession[]; nextCursor: number | null } {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Session page needs a nonnegative cursor and limit 1–100.');
    const headers = this.db.prepare('SELECT rowid AS cursor,length(CAST(record AS BLOB)) AS bytes FROM chat_sessions WHERE rowid>? ORDER BY rowid LIMIT ?').all(after, limit);
    const cursors: number[] = [];
    let bytes = 2;
    for (const header of headers) {
      const size = Number(header.bytes) + 1;
      if (bytes + size > 1024 * 1024) {
        if (cursors.length) break;
        throw new Error(`Chat session ${header.cursor} exceeds the 1 MiB projection page budget.`);
      }
      cursors.push(Number(header.cursor)); bytes += size;
    }
    const items = cursors.length ? this.db.prepare(`SELECT record FROM chat_sessions WHERE rowid IN (${cursors.map(() => '?').join(',')}) ORDER BY rowid`).all(...cursors).map(row => decode<ChatSession>(row)!) : [];
    return { items, nextCursor: cursors.length < headers.length || headers.length === limit ? cursors.at(-1)! : null };
  }
  updateSession(id: string, patch: Partial<ChatSession>): ChatSession {
    const old = this.getSession(id), next = { ...old, ...patch, id: old.id, createdAt: old.createdAt, updatedAt: stamp() };
    this.db.prepare('UPDATE chat_sessions SET record=?,updated_at=? WHERE id=?').run(JSON.stringify(next), next.updatedAt, id); return next;
  }
  /** Delete one conversation and its messages in one transaction; requests/trace stay as audit. */
  deleteSession(id: string, options: { ifExists?: boolean } = {}): void {
    // A prior attempt may already have committed this database before its product-index commit failed.
    if (options.ifExists && !this.db.prepare('SELECT 1 FROM chat_sessions WHERE id=?').get(id)) return;
    this.getSession(id);
    this.preservePromotedOrigins(id);
    this.transaction(() => {
      this.db.prepare('DELETE FROM chat_messages WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM chat_sessions WHERE id=?').run(id);
    });
  }
  addMessage(sessionId: string, input: Omit<ChatMessage, 'id' | 'sessionId' | 'createdAt'>, id = `msg-${randomUUID()}`, createdAt = stamp()): ChatMessage {
    this.getSession(sessionId);
    const message: ChatMessage = { ...input, id, sessionId, createdAt };
    return this.transaction(() => {
      this.db.prepare('INSERT INTO chat_messages(id,session_id,record) VALUES(?,?,?)').run(message.id, sessionId, JSON.stringify(message));
      this.updateSession(sessionId, {}); return message;
    });
  }
  messages(sessionId: string, limit = 200, before = Number.MAX_SAFE_INTEGER): ChatMessage[] {
    const size = Math.max(1, Math.min(10000, limit));
    return this.boundedMessageRows('session_id=? AND seq<?', [sessionId, before], size, true, true).rows.reverse().map(row => decode<ChatMessage>(row)!);
  }
  private boundedMessageRows(where: string, parameters: (string | number)[], limit: number, descending = false, allowLargeFirst = false) {
    const order = descending ? 'DESC' : 'ASC';
    const headers = this.db.prepare(`SELECT seq,length(CAST(record AS BLOB)) AS bytes FROM chat_messages WHERE ${where} ORDER BY seq ${order} LIMIT ?`).all(...parameters, limit);
    const sequences: number[] = [];
    let bytes = 2;
    for (const header of headers) {
      const size = Number(header.bytes) + 1;
      if (bytes + size > 1024 * 1024) {
        if (sequences.length) break;
        if (!allowLargeFirst) throw new Error(`Chat message ${header.seq} exceeds the 1 MiB page budget; read its archived source by reference.`);
      }
      sequences.push(Number(header.seq)); bytes += size;
    }
    const rows = sequences.length ? this.db.prepare(`SELECT seq,record FROM chat_messages WHERE seq IN (${sequences.map(() => '?').join(',')}) ORDER BY seq ${order}`).all(...sequences) : [];
    return { rows, hasMore: sequences.length < headers.length || headers.length === limit };
  }
  userMessagesAfter(sessionId: string, afterCursor: number, limit = 32): { cursor: number; message: ChatMessage }[] {
    const { rows } = this.boundedMessageRows("session_id=? AND json_extract(record,'$.role')='user' AND seq>?", [sessionId, afterCursor], Math.max(1, Math.min(100, limit)), false, true);
    return rows.map(row => ({ cursor: Number(row.seq), message: decode<ChatMessage>(row)! }));
  }
  consumedUserInput(sessionId: string): { cursor: number; offset: number } {
    const row = this.db.prepare("SELECT json_extract(record,'$.sampledUserInput.cursor') AS cursor,json_extract(record,'$.sampledUserInput.offset') AS offset FROM chat_messages WHERE session_id=? AND json_extract(record,'$.role')='assistant' AND json_type(record,'$.sampledUserInput') IS NOT NULL ORDER BY seq DESC LIMIT 1").get(sessionId);
    return { cursor: Number(row?.cursor ?? 0), offset: Number(row?.offset ?? 0) };
  }
  messageCount(sessionId: string): number { return Number((this.db.prepare('SELECT COUNT(*) AS total FROM chat_messages WHERE session_id=?').get(sessionId) as { total: number }).total); }
  messagePage(sessionId: string, limit = 200, before = Number.MAX_SAFE_INTEGER): { messages: ChatMessage[]; nextMessageCursor: number | null } {
    const size = Math.max(1, Math.min(10000, limit));
    const page = this.boundedMessageRows('session_id=? AND seq<?', [sessionId, before], size, true);
    const rows = page.rows.reverse();
    return { messages: rows.map(row => decode<ChatMessage>(row)!), nextMessageCursor: page.hasMore ? Number(rows[0]!.seq) : null };
  }
  allMessages(sessionId: string): ChatMessage[] { return this.db.prepare('SELECT record FROM chat_messages WHERE session_id=? ORDER BY seq').all(sessionId).map(row => decode<ChatMessage>(row)!); }
  /** Archive/export readers request one raw row at a time and carry a fixed upper sequence. */
  librarySnapshot(sessionId: string, section: 'messages' | 'requests', through = Number.MAX_SAFE_INTEGER): { through: number; count: number } {
    const table = section === 'messages' ? 'chat_messages' : 'requests';
    const row = this.db.prepare(`SELECT MAX(seq) AS seq,COUNT(*) AS count FROM ${table} WHERE session_id=? AND seq<=?`).get(sessionId, through) as { seq: number | null; count: number };
    return { through: Number(row.seq ?? 0), count: Number(row.count) };
  }
  libraryRow(sessionId: string, section: 'messages' | 'requests', after: number, through: number): { seq: number; id: string; record: string } | undefined {
    const table = section === 'messages' ? 'chat_messages' : 'requests';
    return this.db.prepare(`SELECT seq,id,record FROM ${table} WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 1`).get(sessionId, after, through) as { seq: number; id: string; record: string } | undefined;
  }
  libraryRequestRunning(sessionId: string, through: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM requests WHERE session_id=? AND seq<=? AND status='running' LIMIT 1").get(sessionId, through));
  }
  /**
   * Branch selection resolves one stored message by its conversation identity. chat_messages.id is
   * UNIQUE and the session filter keeps a foreign id from resolving; seq is the durable insertion
   * order that a branch copies through.
   */
  messageRef(sessionId: string, messageId: string): { seq: number; message: ChatMessage } | undefined {
    const row = this.db.prepare('SELECT seq,record FROM chat_messages WHERE session_id=? AND id=?').get(sessionId, messageId) as { seq: number; record: string } | undefined;
    return row ? { seq: Number(row.seq), message: decode<ChatMessage>(row)! } : undefined;
  }
  /** Nearest user row at or before a seq, answered by the role partial index (never a JS history scan). */
  previousUserSeq(sessionId: string, throughSeq: number): number | undefined {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM chat_messages WHERE session_id=? AND seq<=? AND json_extract(record,'$.role')='user'").get(sessionId, throughSeq) as { seq: number | null };
    return row.seq === null ? undefined : Number(row.seq);
  }
  /**
   * One ascending page bounded by afterSeq (exclusive) and throughSeq (inclusive). The page never
   * exceeds BRANCH_COPY_PAGE rows, so a copy can stream the whole conversation at constant memory.
   */
  messagePageAfter(sessionId: string, afterSeq: number, throughSeq: number, limit = BRANCH_COPY_PAGE): { messages: ChatMessage[]; lastSeq: number } {
    const size = Math.max(1, Math.min(BRANCH_COPY_PAGE, limit));
    const rows = this.db.prepare('SELECT seq,record FROM chat_messages WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?').all(sessionId, afterSeq, throughSeq, size) as { seq: number; record: string }[];
    return { messages: rows.map(row => decode<ChatMessage>(row)!), lastSeq: rows.length ? Number(rows.at(-1)!.seq) : afterSeq };
  }
  /**
   * Copy stored messages through throughSeq into targetSessionId, oldest first, one bounded page at a
   * time. Every copy keeps the stored attachments/tool fields and records sourceMessageId; edit
   * replaces only the text of one selected copy. The caller owns the transaction: the branch session,
   * these rows and its scoped prompt settings must commit or roll back together.
   */
  copyMessagesThrough(sourceSessionId: string, targetSessionId: string, throughSeq: number, options: { edit?: { messageId: string; content: string }; sanitizeContent?: (content: string) => string; pageSize?: number } = {}): { count: number; firstSourceMessageId?: string; lastSourceMessageId?: string } {
    const size = Math.max(1, Math.min(BRANCH_COPY_PAGE, options.pageSize ?? BRANCH_COPY_PAGE));
    let afterSeq = 0, count = 0, firstSourceMessageId: string | undefined, lastSourceMessageId: string | undefined;
    let previousUserCursor = 0;
    for (;;) {
      const page = this.messagePageAfter(sourceSessionId, afterSeq, throughSeq, size);
      for (const message of page.messages) {
        const content = options.edit?.messageId === message.id ? options.edit.content : message.content;
        let sampledUserInput = message.sampledUserInput;
        if (sampledUserInput) {
          // Sequence numbers are database-wide, so a source cursor cannot be reused in a branch.
          // Resolve through indexed identities without retaining a map of the whole conversation.
          const mapped = sampledUserInput.cursor === 0 ? undefined : this.db.prepare("SELECT target.seq FROM chat_messages source JOIN chat_messages target ON json_extract(target.record,'$.sourceMessageId')=source.id AND target.session_id=? WHERE source.session_id=? AND source.seq=?").get(targetSessionId, sourceSessionId, sampledUserInput.cursor);
          if (sampledUserInput.cursor !== 0 && !mapped) throw new Error('Cannot branch an input checkpoint whose source is outside the copied history.');
          let offset = sampledUserInput.offset;
          if (offset > 0) {
            const pending = this.userMessagesAfter(sourceSessionId, sampledUserInput.cursor, 1)[0];
            const copied = pending && this.db.prepare("SELECT json_extract(record,'$.content') AS content FROM chat_messages WHERE session_id=? AND json_extract(record,'$.sourceMessageId')=?").get(targetSessionId, pending.message.id);
            if (!pending || !copied) throw new Error('Cannot branch a partial input outside the copied history.');
            // Current credential redaction may change old source text. UTF-16 offsets only identify
            // that exact text; reread the changed fragment instead of skipping an unread suffix.
            if (copied.content !== pending.message.content) offset = 0;
          }
          sampledUserInput = { cursor: Number(mapped?.seq ?? 0), offset };
        } else if (message.role === 'assistant') {
          // Pre-fragment histories had one answer per submitted input. Preserve that boundary in
          // the new branch; later unanswered user rows must remain pending. Never alter originals.
          sampledUserInput = { cursor: previousUserCursor, offset: 0 };
        }
        const copied = this.addMessage(targetSessionId, { role: message.role, content: options.sanitizeContent ? options.sanitizeContent(content) : content, sourceMessageId: message.id,
          ...(sampledUserInput ? { sampledUserInput } : {}),
          ...(message.reasoningContent ? { reasoningContent: options.sanitizeContent ? options.sanitizeContent(message.reasoningContent) : message.reasoningContent } : {}),
          ...(message.attachments ? { attachments: message.attachments } : {}), ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
          ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}), ...(message.archiveRecall ? { archiveRecall: true } : {}) });
        this.copyHistorySources(sourceSessionId, message.id, targetSessionId, copied.id, options.sanitizeContent);
        if (message.role === 'user') previousUserCursor = this.messageRef(targetSessionId, copied.id)!.seq;
        count += 1; firstSourceMessageId ??= message.id; lastSourceMessageId = message.id;
      }
      if (page.messages.length < size) break;
      afterSeq = page.lastSeq;
    }
    return { count, firstSourceMessageId, lastSourceMessageId };
  }
  /** Preserve source identity, not an alias to an edited copy. Each iterator holds one original. */
  private copyHistorySources(sourceSessionId: string, sourceMessageId: string, targetSessionId: string, anchorMessageId: string, sanitize?: (content: string) => string): void {
    const save = this.db.prepare('INSERT INTO chat_history_sources(session_id,source_id,anchor_message_id,record) VALUES(?,?,?,?)');
    const record = this.db.prepare('SELECT record FROM chat_messages WHERE session_id=? AND id=?').get(sourceSessionId, sourceMessageId) as { record: string };
    const source = JSON.parse(record.record) as ChatMessage;
    if (source.sourceMessageId) this.recoverHistorySourceChain(sourceSessionId, source.sourceMessageId, sanitize);
    save.run(targetSessionId, sourceMessageId, anchorMessageId, this.sourceRecord(record.record, sanitize));
    for (const ancestor of this.db.prepare('SELECT source_id,record FROM chat_history_sources WHERE session_id=? AND anchor_message_id=?').iterate(sourceSessionId, sourceMessageId)) {
      save.run(targetSessionId, ancestor.source_id, anchorMessageId, this.sourceRecord(ancestor.record as string, sanitize));
    }
  }
  private recoverHistorySourceChain(sourceSessionId: string, sourceId: string, sanitize?: (content: string) => string): void {
    // Old branches may have no saved originals. Recover only provable ancestry; absence must not
    // stop a new branch or turn edited copies into counterfeit original records.
    const seen = new Set<string>(); let ancestorId: string | undefined = sourceId;
    while (ancestorId && !seen.has(ancestorId) && seen.size < 32) {
      seen.add(ancestorId);
      try {
        const ancestor = this.historySource(sourceSessionId, ancestorId, Number.MAX_SAFE_INTEGER, sanitize);
        ancestorId = ancestor ? (JSON.parse(ancestor.record) as ChatMessage).sourceMessageId : undefined;
      } catch { break; /* read_history reports the precise legacy limitation if requested */ }
    }
  }
  /** Truncate the tail after one message; editing/regeneration owns this conversation only. */
  deleteMessagesAfter(sessionId: string, messageId: string): number {
    this.getSession(sessionId);
    this.preservePromotedOrigins(sessionId);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT seq FROM chat_messages WHERE session_id=? AND id=?').get(sessionId, messageId) as { seq: number } | undefined;
      if (!row) throw new Error('Message not found in this conversation.');
      return Number(this.db.prepare('DELETE FROM chat_messages WHERE session_id=? AND seq>?').run(sessionId, row.seq).changes);
    });
  }
  /** Replace only the text of one message; every other field and its original row identity stay. */
  updateMessageContent(sessionId: string, messageId: string, content: string): ChatMessage {
    this.getSession(sessionId);
    this.preservePromotedOrigins(sessionId);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT record FROM chat_messages WHERE session_id=? AND id=?').get(sessionId, messageId) as { record: string } | undefined;
      if (!row) throw new Error('Message not found in this conversation.');
      const message: ChatMessage = { ...decode<ChatMessage>(row)!, content };
      this.db.prepare('UPDATE chat_messages SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(message), sessionId, messageId);
      this.updateSession(sessionId, {});
      return message;
    });
  }
  /**
   * SHA-256 of the raw stored record text, exactly what read_history(field:'record') returns.
   * The Inspector must identify original bytes; projections (attachment text, role normalization)
   * get their own hash instead of silently replacing provenance.
   */
  recordHashes(sessionId: string, ids: string[]): Record<string, string> {
    if (!Array.isArray(ids) || ids.length > 5000) throw new Error('A history hash request covers at most 5000 message IDs.');
    this.getSession(sessionId);
    const unique = [...new Set(ids.filter(id => typeof id === 'string' && id))];
    const hashes: Record<string, string> = {};
    for (let offset = 0; offset < unique.length; offset += 400) {
      const chunk = unique.slice(offset, offset + 400);
      const rows = this.db.prepare(`SELECT id,record FROM chat_messages WHERE session_id=? AND id IN (${chunk.map(() => '?').join(',')})`).all(sessionId, ...chunk) as { id: string; record: string }[];
      for (const row of rows) hashes[row.id] = createHash('sha256').update(row.record).digest('hex');
    }
    return hashes;
  }
  createRequest(input: Omit<RequestRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): RequestRecord {
    const now = stamp(), request = { ...input, id: input.id ?? `req-${randomUUID()}`, createdAt: now, updatedAt: now };
    return this.transaction(() => {
      this.db.prepare('INSERT INTO requests(id,session_id,task_id,created_at,status,record) VALUES(?,?,?,?,?,?)').run(request.id, request.sessionId, request.taskId ?? null, now, request.status, JSON.stringify(request));
      saveMetrics(this.db, request); return request;
    });
  }
  getRequest(id: string): RequestRecord { const request = decode<RequestRecord>(this.db.prepare('SELECT record FROM requests WHERE id=?').get(id)); if (!request) throw new Error('Request not found.'); return request; }
  updateRequest(id: string, patch: Partial<RequestRecord>): RequestRecord {
    const old = this.getRequest(id), request = { ...old, ...patch, id: old.id, createdAt: old.createdAt, updatedAt: stamp() };
    return this.transaction(() => {
      this.db.prepare('UPDATE requests SET status=?,record=? WHERE id=?').run(request.status, JSON.stringify(request), id);
      if (['status','model','startedAt','durationMs','usage','contextWindowTokens'].some(key => key in patch)) saveMetrics(this.db, request);
      return request;
    });
  }
  metrics(query: TraceQuery) { return readMetrics(this.db, query); }
  accountingRequestPage(after: number) {
    return this.db.prepare("SELECT r.seq,r.id,r.task_id,json_extract(r.record,'$.parentId') AS parent FROM requests r JOIN request_metrics m ON m.id=r.id WHERE r.seq>? ORDER BY r.seq LIMIT 256").all(after) as { seq: number; id: string; task_id: string | null; parent: string | null }[];
  }
  saveAccountingScopes(requestId: string, taskIds: string[]): void {
    for (const task of taskIds) this.db.prepare('INSERT OR IGNORE INTO request_metric_scopes VALUES(?,?)').run(task, requestId);
  }
  listRequests(query: TraceQuery = {}): { requests: RequestRecord[]; nextCursor: number | null } {
    const descending = query.order === 'desc';
    const conditions = [descending ? 'seq<?' : 'seq>?'], values: (string | number)[] = [query.after ?? (descending ? Number.MAX_SAFE_INTEGER : 0)];
    for (const [column, value] of [['session_id', query.sessionId], ['task_id', query.taskId]] as const) if (value) { conditions.push(`${column}=?`); values.push(value); }
    const limit = Math.max(1, Math.min(200, query.limit ?? 50));
    const rows = this.db.prepare(`SELECT seq, json_remove(record,'$.body','$.sources','$.draft','$.response') AS record FROM requests WHERE ${conditions.join(' AND ')} ORDER BY seq ${descending ? 'DESC' : 'ASC'} LIMIT ?`).all(...values, limit) as { seq: number; record: string }[];
    return { requests: rows.map(row => decode<RequestRecord>(row)!), nextCursor: rows.length === limit ? rows.at(-1)!.seq : null };
  }
  latestRequest(sessionId: string, kind?: RequestRecord['kind']): RequestRecord | undefined {
    return decode<RequestRecord>(this.db.prepare(`SELECT record FROM requests WHERE session_id=?${kind ? " AND json_extract(record,'$.kind')=?" : ''} ORDER BY seq DESC LIMIT 1`).get(sessionId, ...(kind ? [kind] : [])));
  }
  saveTool(input: ToolRecord): ToolRecord {
    const record = { ...input, updatedAt: stamp() };
    this.db.prepare('INSERT INTO tool_calls VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record,task_id=excluded.task_id').run(record.id, record.requestId, record.sessionId, record.taskId ?? null, JSON.stringify(record)); return record;
  }
  getTool(id: string): ToolRecord { const record = decode<ToolRecord>(this.db.prepare('SELECT record FROM tool_calls WHERE id=?').get(id)); if (!record) throw new Error('Tool call not found.'); return record; }
  findTool(taskId: string, toolCallId: string, identity: { requestId?: string; runId?: string; intentId?: string } = {}): ToolRecord | undefined {
    const conditions = ["task_id=?", "json_extract(record,'$.toolCallId')=?"], values = [taskId, toolCallId];
    for (const key of ['requestId', 'runId', 'intentId'] as const) if (identity[key]) {
      conditions.push(key === 'requestId' ? 'request_id=?' : `json_extract(record,'$.${key}')=?`);
      values.push(identity[key]);
    }
    return decode<ToolRecord>(this.db.prepare(`SELECT record FROM tool_calls WHERE ${conditions.join(' AND ')} ORDER BY rowid DESC LIMIT 1`).get(...values));
  }
  importEvent(sourceId: number, action: () => void): boolean {
    let imported = false;
    this.transaction(() => {
      imported = Boolean(this.db.prepare('INSERT OR IGNORE INTO imported_events VALUES(?)').run(sourceId).changes);
      if (imported) action();
    });
    return imported;
  }
  workProjectionVersion(kind: 'task' | 'tool', id: string): number {
    return Number((this.db.prepare('SELECT seq FROM work_projection_versions WHERE kind=? AND id=?').get(kind, id) as { seq: number } | undefined)?.seq ?? 0);
  }
  advanceWorkProjection(kind: 'task' | 'tool', id: string, seq: number): boolean {
    return Boolean(this.db.prepare('INSERT INTO work_projection_versions VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET seq=excluded.seq WHERE seq<excluded.seq').run(kind, id, seq).changes);
  }
  advanceKernelCursor(seq: number): void {
    // Only the ordered global importer calls this; live imports must never skip an unseen prefix.
    this.setSetting('kernelCursor', Math.max(seq, this.getSetting('kernelCursor', 0)));
  }
  toolResultExists(sessionId: string, requestId: string, toolCallId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM chat_messages WHERE session_id=? AND json_extract(record,'$.role')='tool' AND json_extract(record,'$.requestId')=? AND json_extract(record,'$.toolCallId')=? LIMIT 1").get(sessionId, requestId, toolCallId));
  }
  /** Stable startup snapshot; recovery must not inherit the Inspector's recent-call limit. */
  recoveryRequests(after = 0, snapshot?: number): { requestIds: string[]; nextCursor: number | null; snapshot: number } {
    snapshot ??= Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM requests').get() as { seq: number }).seq);
    const rows = this.db.prepare(`SELECT r.seq,r.id FROM requests r WHERE r.seq>? AND r.seq<=? AND json_extract(r.record,'$.kind')='chat'
      AND EXISTS (SELECT 1 FROM tool_calls t WHERE t.request_id=r.id AND json_extract(t.record,'$.receivedByRequestId') IS NULL)
      ORDER BY r.seq LIMIT 100`).all(after, snapshot) as { seq: number; id: string }[];
    return { requestIds: rows.map(row => row.id), nextCursor: rows.length === 100 ? rows.at(-1)!.seq : null, snapshot };
  }
  toolCalls(query: TraceQuery = {}): ToolRecord[] {
    const clauses: string[] = [], values: string[] = [];
    for (const [column, value] of [['session_id', query.sessionId], ['task_id', query.taskId], ['request_id', query.requestId]] as const) if (value) { clauses.push(`${column}=?`); values.push(value); }
    return this.db.prepare(`SELECT record FROM tool_calls ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY rowid DESC LIMIT ?`).all(...values, Math.min(500, query.limit ?? 200)).map(row => decode<ToolRecord>(row)!);
  }
  trace(input: Omit<TraceEvent, 'id' | 'timestamp'> & { timestamp?: string }): TraceEvent {
    const event = { ...input, timestamp: input.timestamp ?? stamp() };
    const result = this.db.prepare('INSERT INTO trace(session_id,task_id,request_id,type,timestamp,status,record) VALUES(?,?,?,?,?,?,?)').run(event.sessionId, event.taskId ?? null, event.requestId ?? null, event.type, event.timestamp, event.status, JSON.stringify(event));
    return { ...event, id: Number(result.lastInsertRowid) };
  }
  traces(query: TraceQuery = {}): { events: TraceEvent[]; nextCursor: number | null } {
    const conditions = ['id>?'], values: (string | number)[] = [query.after ?? 0];
    for (const [column, value] of [['session_id', query.sessionId], ['task_id', query.taskId], ['request_id', query.requestId], ['type', query.type]] as const) if (value) { conditions.push(`${column}=?`); values.push(value); }
    if (query.q) { conditions.push('record LIKE ?'); values.push(`%${query.q.slice(0, 300)}%`); }
    const limit = Math.max(1, Math.min(500, query.limit ?? 100));
    const rows = this.db.prepare(`SELECT id,record FROM trace WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT ?`).all(...values, limit) as { id: number; record: string }[];
    return { events: rows.map(row => ({ ...decode<TraceEvent>(row)!, id: row.id })), nextCursor: rows.length === limit ? rows.at(-1)!.id : null };
  }
  /**
   * Request-scope prompt edits: durable next-request-only state. The row is claimed before request
   * assembly and confirmed with the created request id, so two concurrent assemblies cannot both
   * consume it; release restores it when assembly fails before a request record exists. Only prompt
   * field text is stored, never arbitrary body/provider/permission fields.
   */
  saveRequestOverride(targetId: string, partId: string, field: PromptOverrideField, content: string): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO request_overrides(target_id,part_id,field,content,created_at) VALUES(?,?,?,?,?) ON CONFLICT(target_id,field) DO UPDATE SET part_id=excluded.part_id,content=excluded.content,created_at=excluded.created_at,claimed_token=NULL,claimed_at=NULL,consumed_request_id=NULL').run(targetId, partId, field, content, stamp());
    });
  }
  pendingRequestOverrides(targetId: string): PendingRequestOverride[] {
    const rows = this.db.prepare('SELECT part_id,field,content FROM request_overrides WHERE target_id=? AND consumed_request_id IS NULL ORDER BY id').all(targetId) as { part_id: string; field: string; content: string }[];
    return rows.map(row => ({ partId: row.part_id, field: row.field as PromptOverrideField, content: row.content }));
  }
  takeRequestOverrides(targetId: string): RequestOverrideClaim | undefined {
    return this.transaction(() => {
      const cutoff = new Date(Date.now() - OVERRIDE_CLAIM_STALE_MS).toISOString();
      const rows = this.db.prepare('SELECT id,part_id,field,content FROM request_overrides WHERE target_id=? AND consumed_request_id IS NULL AND (claimed_token IS NULL OR claimed_at<?) ORDER BY id').all(targetId, cutoff) as { id: number; part_id: string; field: string; content: string }[];
      if (!rows.length) return undefined;
      const token = 'override-' + randomUUID(), now = stamp();
      const claim = this.db.prepare('UPDATE request_overrides SET claimed_token=?,claimed_at=? WHERE id=?');
      for (const row of rows) claim.run(token, now, row.id);
      const edits = rows.map(row => ({ partId: row.part_id, field: row.field as PromptOverrideField, content: row.content }));
      const overrides: Partial<Record<PromptOverrideField, string>> = {};
      for (const edit of edits) overrides[edit.field] = edit.content;
      return { token, edits, overrides };
    });
  }
  confirmRequestOverrides(token: string, requestId: string): void {
    this.transaction(() => { this.db.prepare('UPDATE request_overrides SET consumed_request_id=?,claimed_token=NULL,claimed_at=NULL WHERE claimed_token=?').run(requestId, token); });
  }
  releaseRequestOverrides(token: string): void {
    this.transaction(() => { this.db.prepare('UPDATE request_overrides SET claimed_token=NULL,claimed_at=NULL WHERE claimed_token=?').run(token); });
  }
  getSetting<T>(key: string, fallback: T): T { return decode<T>(this.db.prepare('SELECT record FROM settings WHERE key=?').get(key)) ?? fallback; }
  setSetting(key: string, value: unknown): void { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET record=excluded.record').run(key, JSON.stringify(value)); }
  /** One-time SQLite migration: never materialize the legacy settings object in JavaScript. */
  migrateChatToolBindings(): void {
    if (this.db.prepare("SELECT 1 FROM settings WHERE key='chatToolBindingsVersion' AND record='1'").get()) return;
    this.transaction(() => {
      this.db.exec(`INSERT OR IGNORE INTO chat_tool_bindings(session_id,ordinal,task_id)
        SELECT session_id,ROW_NUMBER() OVER(PARTITION BY session_id ORDER BY ordinal)-1,task_id FROM (
          SELECT entries.key AS session_id,CAST(ids.key AS INTEGER) AS ordinal,ids.value AS task_id
          FROM settings s,json_each(s.record) entries,
            json_each(CASE entries.type WHEN 'array' THEN entries.value WHEN 'text' THEN json_array(entries.value) ELSE '[]' END) ids
          WHERE s.key='chatToolTasks' AND ids.type='text' AND length(ids.value)>0);
        INSERT OR IGNORE INTO chat_tool_pending(session_id,record)
        SELECT session_id,record FROM (
          SELECT entries.key AS session_id,CASE entries.type WHEN 'object' THEN entries.value ELSE '{}' END AS record
          FROM settings s,json_each(s.record) entries WHERE s.key='chatToolPending')
        WHERE json_type(record,'$.index')='integer' AND json_extract(record,'$.index') BETWEEN 0 AND 9007199254740991
          AND (json_type(record,'$.scope') IS NULL OR json_type(record,'$.scope')='text')
          AND json_extract(record,'$.command.type')='create_task'
          AND json_type(record,'$.command.commandId')='text' AND length(json_extract(record,'$.command.commandId'))>0;
        INSERT INTO settings VALUES('chatToolBindingsVersion','1') ON CONFLICT(key) DO UPDATE SET record='1';`);
      // chatToolTasks/chatToolPending remain immutable backups; all subsequent operations use rows.
    });
  }
  latestChatToolBinding(sessionId: string): { index: number; taskId: string } | undefined {
    const row = this.db.prepare('SELECT ordinal,task_id FROM chat_tool_bindings WHERE session_id=? ORDER BY ordinal DESC LIMIT 1').get(sessionId) as { ordinal: number; task_id: string } | undefined;
    return row ? { index: row.ordinal, taskId: row.task_id } : undefined;
  }
  chatToolBinding(sessionId: string, index: number): string | undefined {
    return (this.db.prepare('SELECT task_id FROM chat_tool_bindings WHERE session_id=? AND ordinal=?').get(sessionId, index) as { task_id: string } | undefined)?.task_id;
  }
  unregisteredChatToolBindings(after = 0, limit = 100): { cursor: number; sessionId: string; index: number; taskId: string }[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid binding page limit.');
    return (this.db.prepare('SELECT rowid,session_id,ordinal,task_id FROM chat_tool_bindings WHERE owner_registered=0 AND rowid>? ORDER BY rowid LIMIT ?').all(after, limit) as { rowid: number; session_id: string; ordinal: number; task_id: string }[])
      .map(row => ({ cursor: row.rowid, sessionId: row.session_id, index: row.ordinal, taskId: row.task_id }));
  }
  markChatToolBindingRegistered(sessionId: string, index: number): void {
    this.db.prepare('UPDATE chat_tool_bindings SET owner_registered=1 WHERE session_id=? AND ordinal=?').run(sessionId, index);
  }
  pendingChatToolBinding(sessionId: string): PendingChatToolBinding | undefined {
    return decode<PendingChatToolBinding>(this.db.prepare('SELECT record FROM chat_tool_pending WHERE session_id=?').get(sessionId));
  }
  pendingChatToolBindings(after = '', limit = 100): { sessionId: string; pending: PendingChatToolBinding }[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid binding page limit.');
    return (this.db.prepare('SELECT session_id,record FROM chat_tool_pending WHERE session_id>? ORDER BY session_id LIMIT ?').all(after, limit) as { session_id: string; record: string }[])
      .map(row => ({ sessionId: row.session_id, pending: JSON.parse(row.record) as PendingChatToolBinding }));
  }
  setPendingChatToolBinding(sessionId: string, marker: PendingChatToolBinding): void {
    const previous = this.pendingChatToolBinding(sessionId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(marker)) throw new Error('A different Chat binding is still pending.');
    this.db.prepare('INSERT OR IGNORE INTO chat_tool_pending VALUES(?,?)').run(sessionId, JSON.stringify(marker));
  }
  /** Kernel command and ownership commit first; this local transaction publishes the bound scope. */
  completeChatToolBinding(sessionId: string, marker: PendingChatToolBinding, taskId: string): void {
    this.transaction(() => {
      const pending = this.pendingChatToolBinding(sessionId), recorded = this.chatToolBinding(sessionId, marker.index);
      if (!pending && recorded === taskId) return;
      if (!pending || JSON.stringify(pending) !== JSON.stringify(marker) || (recorded && recorded !== taskId)) throw new Error('Chat binding identity changed before completion.');
      this.db.prepare('INSERT INTO chat_tool_bindings VALUES(?,?,?,1) ON CONFLICT(session_id,ordinal) DO UPDATE SET owner_registered=1').run(sessionId, marker.index, taskId);
      this.db.prepare('DELETE FROM chat_tool_pending WHERE session_id=?').run(sessionId);
    });
  }
  savePreset(input: Omit<Preset, 'id' | 'version' | 'createdAt'> & { id?: string }): Preset {
    return this.transaction(() => {
      const id = input.id ?? `preset-${randomUUID()}`;
      const previous = this.db.prepare('SELECT MAX(version) AS version FROM presets WHERE id=?').get(id) as { version: number | null };
      const preset = { ...input, id, version: (previous.version ?? 0) + 1, createdAt: stamp() };
      this.db.prepare('INSERT INTO presets VALUES(?,?,?,?,?,?)').run(id, preset.version, preset.kind, preset.scope, preset.scopeId, JSON.stringify(preset)); return preset;
    });
  }
  getPreset(id: string, version?: number): Preset | undefined {
    return decode<Preset>(version === undefined
      ? this.db.prepare('SELECT record FROM presets WHERE id=? ORDER BY version DESC LIMIT 1').get(id)
      : this.db.prepare('SELECT record FROM presets WHERE id=? AND version=?').get(id, version));
  }
  /** Scope filtering and latest-version selection happen in SQLite before the bounded row page. */
  presetPage(input: { kind: string; scope: string; scopeId: string; id?: string; before: number; limit: number }): { items: Preset[]; next: number | null } {
    const { kind, scope, scopeId, id, before } = input;
    const limit = Math.max(1, Math.min(50, input.limit));
    const rows = this.db.prepare(`SELECT p.rowid AS cursor,p.record FROM presets p WHERE p.kind=? AND p.scope=? AND p.scope_id=? AND p.rowid<?
      ${id ? 'AND p.id=?' : 'AND p.version=(SELECT MAX(v.version) FROM presets v WHERE v.id=p.id)'} ORDER BY p.rowid DESC LIMIT ?`)
      .all(kind, scope, scopeId, before, ...(id ? [id] : []), limit) as { cursor: number; record: string }[];
    return { items: rows.map(row => decode<Preset>(row)!), next: rows.length === limit ? Number(rows.at(-1)!.cursor) : null };
  }
  presets(kind?: string, history = false): Preset[] {
    const where = kind ? ' WHERE kind=?' : '', args = kind ? [kind] : [];
    const rows = this.db.prepare(`SELECT record FROM presets ${where} ${history ? '' : `${where ? 'AND' : 'WHERE'} (id,version) IN (SELECT id,MAX(version) FROM presets GROUP BY id)`} ORDER BY rowid DESC`).all(...args);
    return rows.map(row => decode<Preset>(row)!);
  }
  clearHistory(sessionId?: string): { requests: number; events: number } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Debug cleanup cannot delete undelivered Chat receipts or the parent chain used by
      // active tool rounds to enforce their durable request allowance after a restart.
      const requests = this.db.prepare(`WITH RECURSIVE retained(id) AS (
        SELECT r.id FROM requests r WHERE r.status IN ('running','draft') OR EXISTS (
          SELECT 1 FROM tool_calls t WHERE t.request_id=r.id AND (
            json_extract(t.record,'$.status') NOT IN ('completed','failed','denied','not_executed') OR
            (json_extract(r.record,'$.kind')='chat' AND json_extract(t.record,'$.receivedByRequestId') IS NULL AND json_extract(t.record,'$.status')!='not_executed')))
        UNION SELECT json_extract(r.record,'$.parentId') FROM requests r JOIN retained p ON p.id=r.id WHERE json_extract(r.record,'$.parentId') IS NOT NULL
      ) DELETE FROM requests WHERE id NOT IN (SELECT id FROM retained)${sessionId ? ' AND session_id=?' : ''}`).run(...(sessionId ? [sessionId] : []));
      const events = this.db.prepare(`DELETE FROM trace WHERE (request_id IS NULL OR request_id NOT IN (SELECT id FROM requests))${sessionId ? ' AND session_id=?' : ''}`).run(...(sessionId ? [sessionId] : []));
      this.db.prepare(`DELETE FROM tool_calls WHERE request_id NOT IN (SELECT id FROM requests)${sessionId ? ' AND session_id=?' : ''}`).run(...(sessionId ? [sessionId] : []));
      this.db.exec('COMMIT'); this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); return { requests: Number(requests.changes), events: Number(events.changes) };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
