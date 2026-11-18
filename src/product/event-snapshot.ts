/**
 * 有界状态快照 —— 只用于"事件日志被截断 / 后端数据被替换 / 长时间断线"后的状态重建。
 *
 * 投影顺序是协议的一部分：先读事件水位 cursor，再读各域当前状态。
 * 两次读取之间新增的事件 id 必然大于 cursor，前端恢复后从 cursor 继续增量，不会漏也不会回放旧状态。
 *
 * 边界：
 *   - 会话只返回第一页（<=100）；仍有更多页时带 nextCursor，由前端按原有分页契约继续取（前端总预算 <=500）。
 *   - 审批最多 200 条，与现有轮询/审批列表上限一致。
 *   - 聚焦会话的详情另取一次；会话已被删除时 session=null（确认删除，而不是省略字段）。
 *   - 指标是展示数据：会话存在但指标暂不可读时省略，不让整份快照失败。
 */
import type { SessionDetail, StateSnapshot } from '../frontend/api/types.js';
import type { ProductApprovals } from './approvals.js';
import type { ProductObservability } from './observability.js';
import type { ProductSessions } from './sessions.js';
import type { ProductTasks } from './tasks.js';
import { ProductError, type ProductRuntime } from './shared.js';

const MAX_SNAPSHOT_APPROVALS = 200;

export class ProductEventSnapshot {
  constructor(
    private readonly rt: ProductRuntime,
    private readonly sessions: ProductSessions,
    private readonly approvals: ProductApprovals,
    private readonly tasks: ProductTasks,
    private readonly observability: ProductObservability,
  ) {}

  async capture(input: { sessionId?: string; limit?: number } = {}): Promise<StateSnapshot> {
    const cursor = this.rt.store.latestEventId();
    const epoch = this.rt.store.eventEpoch();
    const sessions = await this.sessions.list({ limit: input.limit ?? 100 });
    const snapshot: StateSnapshot = {
      cursor,
      epoch,
      sessions: { items: sessions.items, ...(sessions.nextCursor ? { nextCursor: sessions.nextCursor } : {}) },
      approvals: this.approvals.pending().slice(0, MAX_SNAPSHOT_APPROVALS),
    };
    if (!input.sessionId) return snapshot;

    snapshot.sessionId = input.sessionId;
    let session: SessionDetail | null;
    try {
      session = await this.sessions.get(input.sessionId);
    } catch (error) {
      // not_found 是确定的"已删除"；其他错误不能伪装成删除。
      if (error instanceof ProductError && error.code === 'not_found') session = null;
      else throw error;
    }
    snapshot.session = session;
    if (!session) return snapshot;

    const task = this.tasks.get(input.sessionId);
    if (task) snapshot.task = task;
    try {
      snapshot.metrics = this.observability.metrics(input.sessionId);
    } catch {
      // 指标只是展示数据；会话已确认存在，读取失败时留空，前端下次打开会再取。
    }
    return snapshot;
  }
}
