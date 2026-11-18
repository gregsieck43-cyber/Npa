import type { ContextView, RecallPage } from '../../api/types';

export interface ContextMeter {
  /** usedTokens / windowTokens；窗口未知或非正数时为 undefined，界面不得渲染 NaN/Infinity。 */
  share?: number;
  /** 使用量是否为估算；true 时 token 数前缀 ≈。 */
  usedPrefix: string;
  /** 窗口是否可信；false 时显示“未知”而不是 0，且不渲染百分比。 */
  windowKnown: boolean;
}

/** 只在窗口真实可信且为正数时计算比例；任何未知/非法输入都返回 undefined。 */
export function contextShare(tokens: number, windowTokens: number, windowTokensKnown?: boolean): number | undefined {
  if (windowTokensKnown === false) return undefined;
  if (!Number.isFinite(tokens) || !Number.isFinite(windowTokens) || windowTokens <= 0) return undefined;
  return tokens / windowTokens;
}

export function contextMeter(view: Pick<ContextView, 'usedTokens' | 'windowTokens' | 'windowTokensKnown' | 'usedTokensEstimated'>): ContextMeter {
  const share = contextShare(view.usedTokens, view.windowTokens, view.windowTokensKnown);
  return {
    ...(share === undefined ? {} : { share }),
    usedPrefix: view.usedTokensEstimated === true ? '≈' : '',
    windowKnown: share !== undefined,
  };
}

/**
 * 回查分页的偏移历史：只记录真正加载过的 offset。
 * 下一页用后端返回的 nextOffset；上一页取历史里的上一项，绝不按固定 20 字符反推。
 */
export function recallTrailPush(trail: readonly number[], offset: number): number[] {
  if (!Number.isFinite(offset) || offset < 0) return [...trail];
  return trail[trail.length - 1] === offset ? [...trail] : [...trail, offset];
}

export function recallTrailPop(trail: readonly number[]): number[] {
  return trail.length > 1 ? trail.slice(0, -1) : [...trail];
}

export function recallTrailPrevious(trail: readonly number[]): number | undefined {
  return trail.length > 1 ? trail[trail.length - 2] : undefined;
}

/** 下一页的目标偏移；undefined 表示后端明确没有更多页，按钮必须禁用。 */
export function recallNextOffset(page: Pick<RecallPage, 'nextOffset'>): number | undefined {
  return Number.isFinite(page.nextOffset) && (page.nextOffset as number) >= 0 ? page.nextOffset : undefined;
}
