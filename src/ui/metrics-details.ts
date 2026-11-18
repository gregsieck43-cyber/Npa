import type { AgentMetrics } from '../harness/metrics.js';
import { append, button, element } from './dom.js';
import { metricNumber, metricsPresentation } from './agent-metrics.js';
import type { HarnessUiHost } from './harness-ui.js';
export function showMetricsDetails(host: Pick<HarnessUiHost, 'showModal'>, data?: AgentMetrics): void {
  const dialog = host.showModal('Agent 运行用量', '统计范围为当前会话或任务保留的完整请求记录，包含 Studio 重发；清理请求历史后会重新累计。');
  if (!data) { dialog.body.append(element('p', '', '尚未取得运行记录。')); return; }
  const reading = metricsPresentation(data), last = data.latest;
  const rows: [string, string][] = [
    ['实际费用', '未提供金额、币种与计费覆盖范围；不会使用 Token 估算费用'],
    ['用户轮次 / Agent 步数', `${data.rounds} / ${data.steps}`], ['全部模型请求 / Studio 重发', `${data.requests} / ${data.studioRequests}`],
    ['输入 Token（已报告）', metricNumber(data.promptTokens)], ['输出 Token（已报告）', metricNumber(data.outputTokens)],
    ['累计 Token（已报告）', metricNumber(data.totalTokens)], ['用量报告覆盖', `${data.reportedRequests} / ${data.requests} 请求；${data.unreportedRequests} 次尚未报告`],
    ['缓存读取 Token / 对应输入', `${metricNumber(data.cachedTokens)} / ${metricNumber(data.cachePromptTokens)}`],
    ['缓存报告覆盖', `${data.cacheReportedRequests} / ${data.requests} 请求；未报告的请求不计入命中率`],
    ['工具调用 / 完成 / 需检查', `${data.toolCalls} / ${data.toolsCompleted} / ${data.toolsFailed}`], ['失败模型请求', String(data.failed)],
    ['最近请求模型', last?.model ?? '未记录'], ['最近请求耗时', last?.durationMs == null ? '未报告' : `${metricNumber(last.durationMs)} ms`],
    ['最近请求平均速度', reading.speed == null ? '未报告' : `${reading.speed.toFixed(2)} tok/s（含首段等待）`],
    ['最近输入 / 配置的上下文容量', `${metricNumber(last?.promptTokens)} / ${last?.contextWindowTokens == null ? '未配置' : metricNumber(last.contextWindowTokens)}`],
    ['上下文占用', reading.context == null ? '需要接口报告输入用量，并在服务商设置中填写模型上下文容量' : `${reading.context.toFixed(2)}%；最近已发送请求，不包含尚未发送的草稿`],
  ];
  const list = element('dl', 'metrics-detail-list');
  for (const [label, value] of rows) list.append(append(element('div'), element('dt', '', label), element('dd', '', value)));
  dialog.body.append(list, button('关闭', dialog.close, 'small'));
}
