import type { DatabaseSync } from 'node:sqlite';
import type { ModelResult } from '../contracts.js';
import { fail } from './types.js';

interface Port { db: DatabaseSync; tx<T>(run: () => T): T; charge(taskId: string, sessionId: string): void }
interface Entry { taskId: string; sessionId: string; status: string; usageState: 'known' | 'partial' | 'unknown' }
/** Kernel-owned dispatch ledger. A charge is durable before fetch; uncertain network effects are never replayed. */
export class SideRequestLedger {
  constructor(private readonly port: Port) {
    port.db.exec(`CREATE TABLE IF NOT EXISTS side_requests(request_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,session_id TEXT NOT NULL,status TEXT NOT NULL,usage_state TEXT NOT NULL,usage TEXT,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS side_requests_task ON side_requests(task_id,created_at);
      UPDATE side_requests SET status='unknown' WHERE status IN ('attempting','response_observed');`);
  }
  get(requestId: string): Entry | undefined {
    return this.port.db.prepare('SELECT task_id AS taskId,session_id AS sessionId,status,usage_state AS usageState FROM side_requests WHERE request_id=?').get(requestId) as unknown as Entry | undefined;
  }
  dispatch(requestId: string, taskId: string, sessionId: string): void {
    this.port.tx(() => {
      const prior = this.get(requestId);
      if (prior && (prior.taskId !== taskId || prior.sessionId !== sessionId)) fail('SIDE_REQUEST_IDENTITY', 'Side request identity changed');
      if (prior) fail('SIDE_REQUEST_DISPATCHED', 'Side request was already dispatched; its network effect cannot be replayed');
      this.port.charge(taskId, sessionId);
      this.port.db.prepare('INSERT INTO side_requests VALUES(?,?,?,?,?,?,?)').run(requestId, taskId, sessionId, 'attempting', 'unknown', null, new Date().toISOString());
    });
  }
  settle(requestId: string, status: 'response_observed' | 'completed' | 'failed' | 'cancelled', usage?: ModelResult['usage']): void {
    const reported = [usage?.prompt_tokens, usage?.completion_tokens, usage?.total_tokens].map(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
    const state = reported.every(Boolean) || reported[0] && reported[1] ? 'known' : reported.some(Boolean) ? 'partial' : 'unknown';
    this.port.db.prepare(`UPDATE side_requests SET status=CASE WHEN status='completed' THEN status ELSE ? END,
      usage_state=CASE WHEN usage_state='known' OR ?='unknown' THEN usage_state ELSE ? END,
      usage=CASE WHEN usage_state='known' OR ?='unknown' THEN usage ELSE ? END WHERE request_id=?`).run(status, state, state, state, usage ? JSON.stringify(usage) : null, requestId);
  }
}
