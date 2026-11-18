import type { AgentMetrics } from '../harness/metrics.js';
export const metricNumber = (value: number | null | undefined) => value == null ? '未报告' : value.toLocaleString('zh-CN');
export function metricTokens(value: number): string { return value < 1000 ? String(value) : value < 1e6 ? `${Number((value / 1000).toFixed(1))}K` : `${Number((value / 1e6).toFixed(2))}M`; }
export function metricsPresentation(data?: AgentMetrics) {
  const latest = data?.latest;
  const speed = latest?.outputTokens != null && latest.durationMs != null && latest.durationMs > 0 ? latest.outputTokens / (latest.durationMs / 1000) : null;
  const cache = data?.cachedTokens != null && data.cachePromptTokens != null && data.cachePromptTokens > 0 ? 100 * data.cachedTokens / data.cachePromptTokens : null;
  const context = latest?.promptTokens != null && latest.contextWindowTokens != null && latest.contextWindowTokens > 0 ? 100 * latest.promptTokens / latest.contextWindowTokens : null;
  return { speed, cache, context };
}
export function agentPhase(data?: AgentMetrics): { label: string; detail: string; tone: string; tab: 'Trace' | 'Tools' | 'Request' } {
  if (!data) return { label: '读取运行记录…', detail: '', tone: 'idle', tab: 'Trace' };
  const task = data.task, tool = data.activeTools[0];
  if (task?.status === 'paused') return { label: '任务已暂停', detail: task.reason ?? '', tone: 'waiting', tab: 'Trace' };
  if (task?.status === 'waiting_approval' || data.activeTools.some(item => item.status === 'awaiting_approval')) return { label: '等待你批准', detail: data.activeTools.map(item => item.name).join(' · '), tone: 'waiting', tab: 'Tools' };
  if (tool?.status === 'unknown' || task?.status === 'reconciling') return { label: '正在核对工具结果', detail: tool?.name ?? task?.reason ?? '', tone: 'waiting', tab: 'Tools' };
  if (task?.status === 'failed') return { label: '任务失败', detail: task.reason ?? '', tone: 'error', tab: 'Trace' };
  if (task?.status === 'cancelled') return { label: '任务已取消', detail: '', tone: 'idle', tab: 'Trace' };
  if (task?.retryAt && Date.parse(task.retryAt) > Date.now()) return { label: '等待重试', detail: `下次 ${new Date(task.retryAt).toLocaleTimeString()} · ${task.reason ?? ''}`, tone: 'waiting', tab: 'Trace' };
  if (data.active) return { label: '正在生成', detail: data.active.model ?? '模型请求进行中', tone: 'active', tab: 'Request' };
  if (tool) return { label: ['proposed','prepared'].includes(tool.status) ? '正在准备工具' : '正在执行工具', detail: data.activeTools.map(item => item.name).join(' · '), tone: 'active', tab: 'Tools' };
  if (task?.status === 'waiting_input') return { label: '等待你补充信息', detail: task.reason ?? '', tone: 'waiting', tab: 'Trace' };
  if (task?.status === 'waiting_children') return { label: '子任务执行中', detail: `${task.children} 个子任务尚未结束`, tone: 'active', tab: 'Trace' };
  if (task?.status === 'running' || task?.status === 'queued') return { label: 'Agent 推进中', detail: task.reason ?? '正在准备下一步', tone: 'active', tab: 'Trace' };
  if (data.latest?.status === 'failed') return { label: '最近请求失败', detail: '点击查看错误与请求', tone: 'error', tab: 'Request' };
  return { label: task?.status === 'completed' ? '任务已完成' : data.requests ? '本轮已结束' : '准备就绪', detail: data.latest?.model ?? '', tone: 'idle', tab: 'Trace' };
}
