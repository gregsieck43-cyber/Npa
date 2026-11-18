/**
 * 事件日志过期 / 后端数据替换后的纯数据恢复逻辑（无 React、无 DOM、无网关调用）。
 *
 * 恢复目标不是"补几条事件"，而是用一次有界快照替换无法确认的旧缓存：
 *   - 已确认被删除的会话：连同 details/metrics/inspectorRevision/approvals 一起清除；
 *   - 快照重建过的会话缓存：只保留快照确认过的内容，其余旧详情不再假装有效；
 *   - 当前选中会话被删除：视图回到首页；
 *   - 并发事件与旧异步请求：由 generation guard 拒绝过期结果。
 */
import type { ApprovalRequest, MetricsView, SessionDetail, SessionSummary, StateSnapshot } from '../api/types';
import type { AppState, View } from './store';

export type RecoverySlice = Pick<AppState, 'sessions' | 'details' | 'approvals' | 'metrics' | 'inspectorRevision' | 'view'>;

export interface RecoveryPatch {
  state: Partial<AppState>;
  /** 本地确认删除的会话 id；调用方可以据此清理自己的其它缓存。 */
  removedSessionIds: string[];
  /** 当前视图指向的会话已被删除（已切回首页）。 */
  focusRemoved: boolean;
  /** 当前视图仍在，但快照没有带它的详情；调用方应重新加载。 */
  reloadSessionId?: string;
}

/** session.removed 的完整清理：此前只删 sessions，留下 details/metrics/approvals 等旧缓存。 */
export function applySessionRemoved(state: RecoverySlice, sessionId: string): RecoveryPatch {
  const sessions = { ...state.sessions };
  delete sessions[sessionId];
  const details = { ...state.details };
  delete details[sessionId];
  const metrics = { ...state.metrics };
  delete metrics[sessionId];
  const inspectorRevision = { ...state.inspectorRevision };
  delete inspectorRevision[sessionId];
  const approvals: Record<string, ApprovalRequest> = {};
  for (const [id, approval] of Object.entries(state.approvals)) {
    if (approval.sessionId !== sessionId) approvals[id] = approval;
  }
  const focusRemoved = state.view.kind === 'session' && state.view.id === sessionId;
  const view: View = focusRemoved ? { kind: 'home' } : state.view;
  return { state: { sessions, details, approvals, metrics, inspectorRevision, view }, removedSessionIds: [sessionId], focusRemoved };
}

/**
 * 用快照重建可确认的状态。
 *
 * 会话页是否完整决定"未出现的会话"能否当作删除：
 *   - nextCursor 为空：快照是第一页且是最后一页，未出现的会话 = 已删除；
 *   - 还有后续页：只合并，不把 500 以外的真实会话误判为删除；
 *   - 聚焦会话 session=null 是确定的删除，即使会话页未取全也可以清理。
 * 详情、指标与 Inspector 缓存无法从快照之外确认，因此只保留快照明确带回的那一个会话。
 */
export function applySnapshot(state: RecoverySlice, snapshot: StateSnapshot): RecoveryPatch {
  const complete = snapshot.sessions.nextCursor === undefined;
  const fetched = new Map(snapshot.sessions.items.map(item => [item.id, item]));
  const removed = new Set<string>();
  if (complete) {
    for (const id of Object.keys(state.sessions)) if (!fetched.has(id)) removed.add(id);
  }
  if (snapshot.sessionId !== undefined && snapshot.session === null) removed.add(snapshot.sessionId);

  const sessions: Record<string, SessionSummary> = complete ? {} : { ...state.sessions };
  for (const [id, summary] of fetched) sessions[id] = summary;
  for (const id of removed) delete sessions[id];

  const details: Record<string, SessionDetail> = {};
  const metrics: Record<string, MetricsView> = {};
  const inspectorRevision: Record<string, number> = {};
  if (snapshot.session) {
    const id = snapshot.session.id;
    details[id] = snapshot.task ? { ...snapshot.session, task: snapshot.task } : { ...snapshot.session };
    if (snapshot.metrics) metrics[id] = snapshot.metrics;
    // 快照与旧 Inspector 缓存可能不一致，递增一次让面板重新拉取。
    inspectorRevision[id] = (state.inspectorRevision[id] ?? 0) + 1;
  }

  // 审批以快照为权威：已解决的审批不能因为没出现在增量日志里而继续弹着。
  const approvals: Record<string, ApprovalRequest> = {};
  for (const approval of snapshot.approvals) approvals[approval.id] = approval;

  const focusRemoved = snapshot.sessionId !== undefined && snapshot.session === null;
  const view: View = state.view.kind === 'session' && removed.has(state.view.id) ? { kind: 'home' } : state.view;
  const reloadSessionId = view.kind === 'session' && !details[view.id] ? view.id : undefined;
  return {
    state: { sessions, details, approvals, metrics, inspectorRevision, view },
    removedSessionIds: [...removed],
    focusRemoved,
    ...(reloadSessionId ? { reloadSessionId } : {}),
  };
}

/** 快照恢复会作废所有旧请求结果；用单调代数区分"旧一代"的异步返回。 */
export interface GenerationGuard {
  current(): number;
  bump(): number;
  isCurrent(token: number): boolean;
}

export function createGenerationGuard(): GenerationGuard {
  let generation = 0;
  return { current: () => generation, bump: () => ++generation, isCurrent: token => token === generation };
}

/** 读取完成后若代数已变化则丢弃结果（旧请求不能把旧状态重新灌回新快照）。 */
export async function fetchIfCurrent<T>(guard: GenerationGuard, token: number, read: () => Promise<T>): Promise<T | undefined> {
  const value = await read();
  return guard.isCurrent(token) ? value : undefined;
}

/**
 * 异步读取的短期否决标记。
 *
 * 删除/结算事件只需要影响“开始于它之前”的读取：记下事件里程碑即可，不必永久保存 id。
 * 读取结束时立即释放不再被任何在途窗口需要的标记；快照 reset 则丢弃整代（旧读取已被
 * generation guard 作废）。这样长期运行的删除/结算不会像永久 tombstone 那样无限累积。
 */
export interface RecoveryRead {
  /** 读取开始时的里程碑；只有晚于它的标记才与本次读取相关。 */
  readonly revision: number;
}

export interface RecoveryFenceStats {
  reads: number;
  removed: number;
  resolved: number;
}

export interface RecoveryFence {
  /** 开始一次异步读取（启动列表、会话详情/指标）；调用方必须在 finally 中 endRead。 */
  beginRead(): RecoveryRead;
  endRead(read: RecoveryRead): void;
  /** session.removed：否决所有开始于该事件之前的读取，直到它们结束。 */
  removed(sessionId: string): void;
  /** approval.resolved：否决开始于该事件之前的旧待审批列表。 */
  resolved(approvalId: string): void;
  /** approval.requested：同一 id 重新出现为待审批，撤销此前的结算标记。 */
  requested(approvalId: string): void;
  wasRemoved(read: RecoveryRead, sessionId: string): boolean;
  wasResolved(read: RecoveryRead, approvalId: string): boolean;
  /** 当前保留的窗口/标记数，用于验证生命周期有界。 */
  stats(): RecoveryFenceStats;
  /** 快照是权威状态：旧代数读取已失效，整代窗口与标记一起丢弃。 */
  reset(): void;
}

export function createRecoveryFence(): RecoveryFence {
  let revision = 0;
  const reads = new Set<RecoveryRead>();
  const removedAt = new Map<string, number>();
  const resolvedAt = new Map<string, number>();

  /** 早于或等于最早在途读取开始的标记，对任何剩余读取都不再可见，可以立即释放。 */
  const releaseObsolete = () => {
    if (reads.size === 0) {
      removedAt.clear();
      resolvedAt.clear();
      return;
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (const read of reads) earliest = Math.min(earliest, read.revision);
    for (const [id, at] of removedAt) if (at <= earliest) removedAt.delete(id);
    for (const [id, at] of resolvedAt) if (at <= earliest) resolvedAt.delete(id);
  };

  return {
    beginRead() {
      const read = { revision: ++revision };
      reads.add(read);
      releaseObsolete();
      return read;
    },
    endRead(read) {
      if (!reads.delete(read)) return;
      releaseObsolete();
    },
    removed(sessionId) {
      revision += 1;
      if (reads.size > 0) removedAt.set(sessionId, revision);
    },
    resolved(approvalId) {
      revision += 1;
      if (reads.size > 0) resolvedAt.set(approvalId, revision);
    },
    requested(approvalId) {
      resolvedAt.delete(approvalId);
    },
    wasRemoved(read, sessionId) {
      const at = removedAt.get(sessionId);
      return at !== undefined && at > read.revision;
    },
    wasResolved(read, approvalId) {
      const at = resolvedAt.get(approvalId);
      return at !== undefined && at > read.revision;
    },
    stats() {
      return { reads: reads.size, removed: removedAt.size, resolved: resolvedAt.size };
    },
    reset() {
      reads.clear();
      removedAt.clear();
      resolvedAt.clear();
    },
  };
}

