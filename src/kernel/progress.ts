import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Task } from '../contracts.js';

interface Port { db: DatabaseSync; tx<T>(run: () => T): T; task(id: string): Task; fence(id: string, run: string): void; wait(id: string, reason: string): void; event(id: string, payload: Record<string, unknown>): void }
/** Content novelty is a loop guard, never acceptance evidence. Waiting time and task generations do not spend it. */
export class ProgressGuard {
  readonly limit = 12;
  constructor(private readonly port: Port) {
    port.db.exec(`CREATE TABLE IF NOT EXISTS task_progress(task_id TEXT PRIMARY KEY,input_key TEXT NOT NULL,evidence INTEGER NOT NULL,observed INTEGER NOT NULL,stagnant INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_progress_sources(task_id TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(task_id,sha256));`);
  }
  evidence(taskId: string, source: unknown): void {
    const hash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
    this.port.tx(() => {
      const inserted = this.port.db.prepare('INSERT OR IGNORE INTO task_progress_sources VALUES(?,?)').run(taskId, hash).changes;
      if (inserted) this.port.db.prepare("INSERT INTO task_progress VALUES(?,'',1,0,0) ON CONFLICT(task_id) DO UPDATE SET evidence=evidence+1").run(taskId);
    });
  }
  beforeRequest(taskId: string, runId: string, input: { cursor: number; offset: number; consumedCursor?: number }): boolean {
    return this.port.tx(() => {
      this.port.fence(taskId, runId);
      const task = this.port.task(taskId);
      if (task.status !== 'running') return false;
      const inputKey = JSON.stringify([task.goalVersion, input.cursor, input.consumedCursor ?? input.cursor, input.offset]);
      const row = this.port.db.prepare('SELECT * FROM task_progress WHERE task_id=?').get(taskId);
      const changed = !row || row.input_key !== inputKey || row.evidence !== row.observed;
      const stagnant = changed ? 0 : Number(row.stagnant) + 1;
      this.port.db.prepare('INSERT INTO task_progress VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET input_key=excluded.input_key,observed=excluded.observed,stagnant=excluded.stagnant').run(taskId, inputKey, Number(row?.evidence ?? 0), Number(row?.evidence ?? 0), stagnant);
      if (stagnant < this.limit) return true;
      const reason = `连续 ${this.limit} 个工作段没有新的已保存证据或产物，已停止自动继续。请提供新的信息、调整目标，或明确发送继续要求。已有结果和预算均已保留。`;
      this.port.event(taskId, { stagnant, limit: this.limit, evidence: Number(row?.evidence ?? 0), reason });
      this.port.wait(taskId, reason);
      return false;
    });
  }
}
