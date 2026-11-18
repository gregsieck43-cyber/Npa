import type { TraceSpan } from '../api/types';

/** 把顶层回合之间的长空闲折叠成固定短间隔，返回时间映射函数与折叠次数。 */
export function idleCompressor(spans: TraceSpan[], enabled: boolean) {
  const roots = spans.filter(s => !s.parentId).map(s => [s.startMs, s.startMs + s.durationMs] as [number, number]).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of roots) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
  }
  const active = merged.reduce((n, [a, b]) => n + (b - a), 0), idle = Math.max(400, active * 0.04);
  const shifts: { at: number; removed: number }[] = [];
  let removed = 0;
  for (let i = 1; enabled && i < merged.length; i++) {
    const gap = merged[i][0] - merged[i - 1][1];
    if (gap > idle) { removed += gap - idle; shifts.push({ at: merged[i][0], removed }); }
  }
  return { map: (t: number) => t - (shifts.filter(s => t >= s.at).pop()?.removed ?? 0), folded: shifts.length };
}
