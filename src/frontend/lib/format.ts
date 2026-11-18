import type { MetricsFieldCoverage } from '../api/types';

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso)), minute = 60_000, hour = 60 * minute, day = 24 * hour;
  if (diff < 45_000) return '刚刚';
  if (diff < hour) return `${Math.round(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.round(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.round(diff / day)} 天前`;
  const date = new Date(iso);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

export function duration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000), seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds ? ` ${seconds}s` : ''}`;
}

export function bytes(value: number | undefined): string {
  if (value === undefined) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function percent(value: number | undefined, digits = 0): string {
  return value === undefined ? '—' : `${(value * 100).toFixed(digits)}%`;
}

/** 指标数值：未知显示“未报告”，部分覆盖附“（部分）”；没有覆盖信息时保持旧显示。 */
export function metricTokens(value: number, coverage?: MetricsFieldCoverage): string {
  if (!coverage || coverage.state === 'known') return compactNumber(value);
  if (coverage.state === 'unknown') return '未报告';
  return `${compactNumber(value)}（部分）`;
}

/** 部分/未知覆盖的悬停说明（reported/total）；known 或旧数据不提示。 */
export function coverageHint(coverage?: MetricsFieldCoverage): string | undefined {
  if (!coverage || coverage.state === 'known') return undefined;
  return `${coverage.reportedRequests}/${coverage.totalRequests} 个请求报告`;
}

/** 缓存命中率：未知返回“未报告”（不猜数字），部分覆盖附“（部分）”；undefined 沿用旧界面。 */
export function cacheHitRateLabel(rate: number | undefined, coverage?: MetricsFieldCoverage): string | undefined {
  if (rate === undefined) return coverage?.state === 'unknown' ? '未报告' : undefined;
  return coverage?.state === 'partial' ? `${percent(rate)}（部分）` : percent(rate);
}

export type DateGroup = '今天' | '昨天' | '本周' | '本月' | '更早';

export function dateGroup(iso: string, now = new Date()): DateGroup {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), time = Date.parse(iso), day = 86_400_000;
  if (time >= start) return '今天';
  if (time >= start - day) return '昨天';
  if (time >= start - 6 * day) return '本周';
  if (time >= start - 30 * day) return '本月';
  return '更早';
}

export function greeting(hour = new Date().getHours()): string {
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}
