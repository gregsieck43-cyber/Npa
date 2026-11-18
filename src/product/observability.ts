import type { ActivityDay, ConnectionInfo, MetricsView } from '../frontend/api/types.js';
import type { Activity } from '../kernel/types.js';
import type { AgentMetrics } from '../harness/metrics.js';
import { boundedInteger, invalid, notFound, type ProductRuntime } from './shared.js';
import { resourceBudget } from '../app/resource-budget.js';

export class ProductObservability {
  constructor(private readonly rt: ProductRuntime) {}

  connection(): ConnectionInfo {
    const access = this.rt.services.dataDirectoryAccess;
    const resources = resourceBudget.status();
    const projection = this.rt.harness.store.getSetting<{ message: string; cursor: number } | null>('workTraceError', null);
    const messages = [access.status !== 'private' ? access.message : undefined,
      projection ? `历史投影暂不可用（事件游标 ${projection.cursor}）：${this.rt.harness.sanitize(projection.message).slice(0, 500)}` : undefined,
      resources.pressure === 'critical' ? '内存接近预算，新工作暂缓；内存释放后自动继续，可随时暂停或取消。' :
      resources.pressure === 'unavailable' ? '资源监测不可用，新工作暂缓；请查看诊断并重启后台。' : undefined].filter(Boolean);
    return { status: projection ? 'degraded' : 'online', demo: false, ...(messages.length ? { message: messages.join(' ') } : {}) };
  }

  metrics(sessionId: string): MetricsView {
    const id = String(sessionId ?? '');
    if (!id) invalid('sessionId is required.');
    const record = this.rt.store.getSession(id);
    const task = this.rt.services.kernel.getTask(id);
    let metrics: AgentMetrics;
    if (task) {
      metrics = this.rt.harness.store.metrics({ taskId: id });
      const rounds = this.rt.services.kernel.userTurnCount(id);
      return this.view(metrics, rounds);
    }
    if (record?.kind === 'work') {
      // The index may outlive a deleted task only until refresh; do not invent metrics for it.
      notFound('Task not found: ' + id);
    }
    if (!record) notFound('Session not found: ' + id);
    metrics = this.rt.harness.store.metrics({ sessionId: id });
    return this.view(metrics, metrics.rounds);
  }

  activity(days: unknown): ActivityDay[] {
    const count = days === undefined ? 30 : boundedInteger(days, 'days', 1, 365);
    const activity: Activity = this.rt.services.kernel.activity(count);
    return activity.days;
  }

  /** Best-effort push after a settled request; failures must not break the request path. */
  publishMetrics(sessionId: string): void {
    try { this.rt.append({ type: 'metrics.updated', sessionId, metrics: this.metrics(sessionId) }, sessionId); }
    catch { /* An unindexed or removed session has no metrics to publish. */ }
  }

  private view(metrics: AgentMetrics, rounds: number): MetricsView {
    // 数值字段沿用旧契约（未报告时 0）；真假由 usageCoverage 说明，界面据此显示未报告/部分。
    const tokens = { input: metrics.promptTokens ?? 0, output: metrics.outputTokens ?? 0,
      ...(metrics.cachedTokens !== undefined && metrics.cachedTokens !== null ? { cached: metrics.cachedTokens } : {}) };
    const latest = metrics.latest;
    // Numerator and denominator must come from the same rows: prompts that are missing or zero are
    // excluded from both, while cachedTokens above still exposes every reported cache token.
    const cacheHitRate = metrics.cacheMatchedPromptTokens && metrics.cacheMatchedPromptTokens > 0
      && metrics.cacheMatchedTokens !== null && metrics.cacheMatchedTokens !== undefined
      ? Math.max(0, Math.min(1, metrics.cacheMatchedTokens / metrics.cacheMatchedPromptTokens)) : undefined;
    const tokensPerSecond = latest && (latest.outputTokens ?? 0) > 0 && (latest.durationMs ?? 0) > 0
      ? Math.round((latest.outputTokens ?? 0) / ((latest.durationMs ?? 0) / 1000)) : undefined;
    return {
      rounds, modelSteps: metrics.steps, tokens, toolCalls: metrics.toolCalls, activeTools: metrics.activeTools.length,
      usageCoverage: metrics.usageCoverage,
      ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
      ...(typeof latest?.durationMs === 'number' ? { lastLatencyMs: latest.durationMs } : {}),
      ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
      ...(typeof latest?.promptTokens === 'number' ? { contextUsed: latest.promptTokens } : {}),
      ...(typeof latest?.contextWindowTokens === 'number' ? { contextWindow: latest.contextWindowTokens } : {}),
    };
  }
}
