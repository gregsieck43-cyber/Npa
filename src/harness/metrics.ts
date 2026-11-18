import type { DatabaseSync } from 'node:sqlite';
import type { RequestRecord, TraceQuery } from './types.js';

export type UsageCoverageState = 'known' | 'partial' | 'unknown';
export interface UsageFieldCoverage { reportedRequests: number; totalRequests: number; state: UsageCoverageState; }
/** 覆盖范围是 scope 内除 draft 外的全部请求；totalRequests=0 表示空历史（真 0），不是未知。 */
export interface UsageCoverage {
  requests: number; input: UsageFieldCoverage; output: UsageFieldCoverage; total: UsageFieldCoverage;
  /** cached_tokens 自身是否报告，独立于下面真正可用于命中率计算的行覆盖。 */
  cached: UsageFieldCoverage;
  /** 同时有可用 prompt（>0）与 cached 的行覆盖；命中率只在这个同一行集上计算。 */
  cacheRatio: UsageFieldCoverage;
}

export interface AgentMetrics {
  scopeId: string; rounds: number; requests: number; steps: number; studioRequests: number; failed: number;
  totalTokens: number | null; reportedRequests: number; unreportedRequests: number;
  promptTokens: number | null; outputTokens: number | null; cachedTokens: number | null; cachePromptTokens: number | null; cacheReportedRequests: number;
  cacheMatchedTokens: number | null; cacheMatchedPromptTokens: number | null; cacheMatchedRequests: number;
  toolCalls: number; toolsCompleted: number; toolsFailed: number;
  activeTools: { id: string; name: string; status: string }[];
  latest?: { id: string; model: string | null; status: string; startedAt: string | null; durationMs: number | null; promptTokens: number | null; outputTokens: number | null; contextWindowTokens: number | null };
  active?: { id: string; model: string | null; startedAt: string | null };
  task?: { status: string; reason?: string; retryAt?: string; children: number };
  /** 逐字段用量覆盖；total_tokens 的报告数不冒充 input/output/cached 已报告。 */
  usageCoverage: UsageCoverage;
}
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** 每个字段用自己那一列的报告数判断：空历史 known，全未报告 unknown，部分报告 partial。 */
const fieldCoverage = (reported: unknown, totalRequests: number): UsageFieldCoverage => {
  const reportedRequests = Number(reported) || 0;
  const state: UsageCoverageState = totalRequests === 0 || reportedRequests === totalRequests ? 'known'
    : reportedRequests === 0 ? 'unknown' : 'partial';
  return { reportedRequests, totalRequests, state };
};

/** Small durable projection: polling never reads bodies, streamed text or tool output. */
export function initializeMetrics(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS request_metrics(
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
    model TEXT, started_at TEXT, duration_ms REAL, prompt_tokens INTEGER, output_tokens INTEGER,
    total_tokens INTEGER, cached_tokens INTEGER, context_window INTEGER);
    CREATE INDEX IF NOT EXISTS request_metrics_session ON request_metrics(session_id);
    CREATE INDEX IF NOT EXISTS request_metrics_task ON request_metrics(task_id);
    CREATE TABLE IF NOT EXISTS request_metric_scopes(task_id TEXT NOT NULL,request_id TEXT NOT NULL,PRIMARY KEY(task_id,request_id));
    CREATE INDEX IF NOT EXISTS request_metric_scopes_request ON request_metric_scopes(request_id);
    CREATE TRIGGER IF NOT EXISTS metric_scopes_delete AFTER DELETE ON requests BEGIN DELETE FROM request_metric_scopes WHERE request_id=old.id; END;
    CREATE TRIGGER IF NOT EXISTS metrics_delete AFTER DELETE ON requests BEGIN DELETE FROM request_metrics WHERE id=old.id; END;`);
  // Only missing records need migration; no large response content crosses the SQLite boundary.
  for (const row of db.prepare(`SELECT json_remove(record,'$.sources','$.draft','$.response','$.body.messages','$.body.tools') AS record
    FROM requests WHERE id NOT IN (SELECT id FROM request_metrics)`).all() as { record: string }[]) saveMetrics(db, JSON.parse(row.record));
  db.exec('INSERT OR IGNORE INTO request_metric_scopes SELECT task_id,id FROM request_metrics WHERE task_id IS NOT NULL');
}
export function saveMetrics(db: DatabaseSync, record: RequestRecord): void {
  for (const taskId of new Set(record.budgetTaskIds ?? (record.taskId ? [record.taskId] : [])))
    db.prepare('INSERT OR IGNORE INTO request_metric_scopes VALUES(?,?)').run(taskId, record.id);
  const usage = record.usage, prompt = count(usage?.prompt_tokens), output = count(usage?.completion_tokens);
  const promptMissing = usage?.prompt_tokens === undefined || usage?.prompt_tokens === null;
  const total = count(usage?.total_tokens) ?? (prompt !== null && output !== null ? prompt + output : null);
  const cache = count(usage?.prompt_tokens_details?.cached_tokens) ?? count(usage?.prompt_cache_hit_tokens);
  db.prepare(`INSERT INTO request_metrics VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    status=excluded.status,model=excluded.model,started_at=excluded.started_at,duration_ms=excluded.duration_ms,
    prompt_tokens=excluded.prompt_tokens,output_tokens=excluded.output_tokens,total_tokens=excluded.total_tokens,
    cached_tokens=excluded.cached_tokens,context_window=excluded.context_window`).run(
    record.id, record.sessionId, record.taskId ?? null, record.kind, record.status, record.model ?? record.body?.model ?? null,
    record.startedAt ?? (record.status !== 'draft' ? record.createdAt : null), record.durationMs ?? null,
    prompt, output, total, cache !== null && (promptMissing || (prompt !== null && cache <= prompt)) ? cache : null, record.contextWindowTokens ?? null);
}
export function readMetrics(db: DatabaseSync, query: TraceQuery): AgentMetrics {
  const scopeId = query.taskId ?? query.sessionId;
  if (!scopeId) throw new Error('Metrics require a sessionId or taskId.');
  const column = query.taskId ? 'task_id' : 'session_id';
  const requestScope = query.taskId ? 'id IN (SELECT request_id FROM request_metric_scopes WHERE task_id=?)' : 'session_id=?';
  const totals = db.prepare(`SELECT COUNT(*) AS requests,
    COALESCE(SUM(kind IN ('chat','work','side')),0) AS steps, COALESCE(SUM(kind='studio'),0) AS studioRequests,
    COALESCE(SUM(status='failed'),0) AS failed, SUM(total_tokens) AS totalTokens,
    COUNT(total_tokens) AS reportedRequests, COUNT(*)-COUNT(total_tokens) AS unreportedRequests,
    COUNT(prompt_tokens) AS promptReported, COUNT(output_tokens) AS outputReported,
    SUM(prompt_tokens) AS promptTokens, SUM(output_tokens) AS outputTokens, SUM(cached_tokens) AS cachedTokens,
    SUM(CASE WHEN cached_tokens IS NOT NULL THEN prompt_tokens END) AS cachePromptTokens, COUNT(cached_tokens) AS cacheReportedRequests,
    SUM(CASE WHEN cached_tokens IS NOT NULL AND prompt_tokens IS NOT NULL AND prompt_tokens > 0 THEN cached_tokens END) AS cacheMatchedTokens,
    SUM(CASE WHEN cached_tokens IS NOT NULL AND prompt_tokens IS NOT NULL AND prompt_tokens > 0 THEN prompt_tokens END) AS cacheMatchedPromptTokens,
    COUNT(CASE WHEN cached_tokens IS NOT NULL AND prompt_tokens IS NOT NULL AND prompt_tokens > 0 THEN 1 END) AS cacheMatchedRequests
    FROM request_metrics WHERE ${requestScope} AND status!='draft'`).get(scopeId) as any;
  const latest = db.prepare(`SELECT id,model,status,started_at AS startedAt,duration_ms AS durationMs,prompt_tokens AS promptTokens,
    output_tokens AS outputTokens,context_window AS contextWindowTokens FROM request_metrics
    WHERE ${requestScope} AND status!='draft' ORDER BY rowid DESC LIMIT 1`).get(scopeId) as AgentMetrics['latest'];
  const active = db.prepare(`SELECT id,model,started_at AS startedAt FROM request_metrics WHERE ${requestScope} AND status='running' ORDER BY rowid DESC LIMIT 1`).get(scopeId) as AgentMetrics['active'];
  const tools = db.prepare(`SELECT COUNT(*) AS toolCalls, COALESCE(SUM(json_extract(record,'$.status') IN ('completed','applied')),0) AS toolsCompleted,
    COALESCE(SUM(json_extract(record,'$.status') IN ('failed','denied','unknown')),0) AS toolsFailed
    FROM tool_calls WHERE ${column}=? AND json_extract(record,'$.status')!='not_executed'`).get(scopeId) as any;
  const activeTools = db.prepare(`SELECT id,json_extract(record,'$.name') AS name,json_extract(record,'$.status') AS status
    FROM tool_calls WHERE ${column}=? AND json_extract(record,'$.status') IN ('proposed','prepared','approved','sent','running','awaiting_approval','unknown')
    ORDER BY rowid DESC LIMIT 12`).all(scopeId) as AgentMetrics['activeTools'];
  const rounds = query.taskId ? 0 : Number((db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE session_id=? AND json_extract(record,'$.role')='user'").get(scopeId) as any).n);
  const requests = Number(totals.requests);
  const { promptReported, outputReported, ...summary } = totals;
  const usageCoverage: UsageCoverage = { requests, input: fieldCoverage(promptReported, requests),
    output: fieldCoverage(outputReported, requests), total: fieldCoverage(summary.reportedRequests, requests),
    cached: fieldCoverage(summary.cacheReportedRequests, requests),
    cacheRatio: fieldCoverage(summary.cacheMatchedRequests, requests) };
  return { scopeId, rounds, ...summary, ...tools, activeTools, latest, active, usageCoverage };
}
