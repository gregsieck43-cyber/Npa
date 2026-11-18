/* Adapted from DeepSeek Harness StatsPills (MIT). The dock/pill structure and
 * CSS are retained; NPN supplies durable metrics and its existing modal host. */
import { useEffect, useState } from 'react';
import type { AgentMetrics } from '../../harness/metrics.js';
import { agentPhase, metricsPresentation, metricTokens } from '../agent-metrics.js';
import { ContextMeter } from './ContextMeter.js';
import css from './StatsPills.module.css';
export interface StatsPillsProps {
  data?: AgentMetrics; error?: string; sending?: boolean;
  onDetails(): void; onInspect(tab: 'Trace' | 'Tools' | 'Request'): void;
}
function Gauge({ tokens = false }: { tokens?: boolean }) {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">{tokens ? <><ellipse cx="10" cy="4" rx="6" ry="2.5"/><path d="M4 4v11c0 3.5 12 3.5 12 0V4M4 9c0 3.5 12 3.5 12 0"/></> : <><path d="M3 16a8 8 0 1 1 14 0M10 11l4-5"/><circle cx="10" cy="11" r="1"/></>}</svg>;
}
export function StatsPills({ data, error, sending, onDetails, onInspect }: StatsPillsProps) {
  const [, tick] = useState(0), phase = agentPhase(data), reading = metricsPresentation(data);
  useEffect(() => { if (!data?.active) return; const timer = window.setInterval(() => tick(value => value + 1), 1000); return () => clearInterval(timer); }, [data?.active?.id]);
  const elapsed = data?.active?.startedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(data.active.startedAt)) / 1000)) : null;
  const label = error ? '运行信息暂不可用' : sending ? '正在保存消息…' : phase.label;
  return <div className="agent-telemetry" data-testid="agent-telemetry" data-tone={error ? 'error' : phase.tone}>
    <div className="agent-motion-row">
      <button type="button" className="agent-motion" onClick={() => onInspect(phase.tab)} title={error || phase.detail || '查看执行轨迹'}>
        <span className="agent-motion-dot" aria-hidden="true"/><span aria-live="polite">{label}</span>
        <span className="agent-motion-detail">{error || phase.detail}</span>
      </button>
      {elapsed !== null && <span className="agent-elapsed">已等待 {elapsed}s</span>}
      <button type="button" className="agent-trace-link" onClick={() => onInspect('Trace')}>轨迹 ↗</button>
    </div>
    <div className={`${css.root} agent-readings`}>
      <button type="button" className={css.pill} onClick={onDetails} data-testid="agent-steps" title="轮次为用户消息数；步数为 Chat / Work 实际模型调用；均速包含等待响应时间">
        <Gauge/><span className={css.label}>{data ? `${data.rounds} 轮 ${data.steps} 步` : '轮次 —'}<span className={css.sep}>·</span>{reading.speed === null ? '均速未报告' : `${Number(reading.speed.toFixed(1))} tok/s 均速`}</span>
      </button>
      <button type="button" className={css.pill} onClick={onDetails} data-testid="agent-tokens" title="点击查看精确 Token 用量、报告覆盖范围与缓存命中分母">
        <Gauge tokens/><span className={css.label}>{data?.totalTokens != null ? `${metricTokens(data.totalTokens)} tok${data.unreportedRequests ? '（部分）' : ''}` : '用量未报告'}<span className={css.sep}>·</span>{reading.cache === null ? '缓存未报告' : `缓存命中 ${Number(reading.cache.toFixed(1))}%`}</span>
      </button>
      <ContextMeter percent={reading.context} configured={data?.latest?.contextWindowTokens != null} onClick={onDetails}/>
      <button type="button" className={css.pill} onClick={onDetails} data-testid="agent-cost" title="当前接口未提供金额、币种与计费覆盖范围；不按 Token 猜测费用。">费用未提供</button>
      <button type="button" className={css.pill} onClick={() => onInspect('Tools')} data-testid="agent-tools" title="查看工具参数、状态、审批与结果">{data?.toolCalls ?? '—'} 次工具{data?.toolsFailed ? ` · ${data.toolsFailed} 个需检查` : ''}</button>
    </div>
  </div>;
}
