import type { TraceSpan, TraceSpanType, TraceView } from '../../api/types';

/**
 * 把后端按游标返回的下一页追加到已加载 span 之后：按 id 去重、保持到达顺序。
 * 只追加用户显式请求的页，不扫描历史、不自动追页；内存随用户翻页线性增长。
 */
export function appendTracePage(loaded: readonly TraceSpan[], page: readonly TraceSpan[]): TraceSpan[] {
  if (page.length === 0) return [...loaded];
  const seen = new Set(loaded.map(span => span.id));
  const merged = [...loaded];
  for (const span of page) {
    if (seen.has(span.id)) continue;
    seen.add(span.id);
    merged.push(span);
  }
  return merged;
}

/** 下一页游标：hasMore 为 false 时即使后端带了游标也不再请求。 */
export function nextTraceCursor(view: Pick<TraceView, 'hasMore' | 'nextCursor'>): string | undefined {
  return view.hasMore && typeof view.nextCursor === 'string' && view.nextCursor ? view.nextCursor : undefined;
}

/**
 * 面板的搜索/类型过滤转换成后端查询。
 * 文本始终转发；type 是后端单值参数，因此只在恰好选中一个类型时转发。
 * 多选类型由面板在已加载页内即时过滤，不再发额外请求。
 */
export function traceQueryOf(text: string, types: Iterable<TraceSpanType>): { text?: string; type?: string } {
  const selected = [...types];
  const query: { text?: string; type?: string } = {};
  const trimmed = text.trim();
  if (trimmed) query.text = trimmed;
  if (selected.length === 1) query.type = selected[0];
  return query;
}
