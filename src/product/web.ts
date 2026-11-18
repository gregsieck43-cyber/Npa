/**
 * 产品 Web 路由的 DTO 映射。
 *
 * 这里只做形状转换：网络传输由 Services 直连 ExternalTools.operatorWeb 完成，
 * 不创建 Agent 任务/run/intent/审批/模型请求。前端 DTO 以
 * src/frontend/api/types.ts 为准，bridge.ts 由前端接线层维护。
 */
import type { WebPage as FrontendWebPage, WebSearchResult } from '../frontend/api/types.js';
import { pickFields, requiredString, type ProductRuntime } from './shared.js';

/** search 结果在 WebSearchResult 之外保留可追溯的来源 provider 信息。 */
export type ProductWebSearchResult = WebSearchResult & { source: string };

/** fetch 结果在 WebPage 之外保留请求 URL/内容类型/trust，避免抹除来源。 */
export interface ProductWebPage extends FrontendWebPage {
  requestedUrl: string;
  contentType: string;
  trust: 'untrusted';
}

export async function searchWeb(runtime: ProductRuntime, input: unknown, signal?: AbortSignal): Promise<ProductWebSearchResult[]> {
  const body = pickFields(input, ['query']);
  const query = requiredString(body.query, 'query', 500);
  const response = await runtime.services.operatorSearch(query, signal);
  return response.results.map(result => ({ title: result.title, url: result.url, snippet: result.snippet, source: result.source }));
}

export async function fetchWebPage(runtime: ProductRuntime, input: unknown, signal?: AbortSignal): Promise<ProductWebPage> {
  const body = pickFields(input, ['url']);
  const url = requiredString(body.url, 'url', 4096);
  const page = await runtime.services.operatorFetch(url, signal);
  return {
    url: page.url,
    title: page.title,
    text: page.text,
    fetchedAt: page.fetchedAt,
    // The transport only returns pages that completed a 2xx/HTML read; carry the status it observed
    // (200/201/206 or the final redirect target) instead of collapsing it to a synthetic 200.
    status: page.status,
    requestedUrl: page.requestedUrl,
    contentType: page.contentType,
    trust: page.trust,
  };
}
