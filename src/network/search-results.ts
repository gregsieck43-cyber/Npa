import { cleanText } from './page-content.js';
import { parsePublicUrl, WebError } from './url-policy.js';

/** Providers with a documented public JSON wire format. */
export type WireSearchProvider = 'mwmbl' | 'wikipedia' | 'searxng';
/**
 * Every selectable search source. 'auto' is the bounded free chain in search-scope.ts;
 * exa and bing-rss are single free adapters. An explicit id never falls back to another source.
 */
export type SearchProvider = WireSearchProvider | 'exa' | 'bing-rss' | 'auto';

export interface SearchResult { title: string; url: string; snippet: string; source: string }

/** Endpoint without query parameters; shared by dispatch and by the approval scope list. */
export function searchBase(provider: WireSearchProvider, searxUrl?: string): URL {
  if (provider === 'mwmbl') return new URL('https://api.mwmbl.org/search/');
  if (provider === 'searxng') {
    if (!searxUrl) throw new WebError('SEARCH_CONFIGURATION', 'Configure a public SearXNG instance that enables JSON search.');
    const url = parsePublicUrl(searxUrl);
    if (url.protocol !== 'https:') throw new WebError('SEARCH_CONFIGURATION', 'SearXNG must use HTTPS.');
    url.pathname = `${url.pathname.replace(/\/$/, '')}/search`;
    url.search = '';
    return url;
  }
  return new URL('https://en.wikipedia.org/w/api.php');
}

export function searchEndpoint(provider: WireSearchProvider, query: string, searxUrl?: string): URL {
  const url = searchBase(provider, searxUrl);
  if (provider === 'mwmbl') url.search = new URLSearchParams({ s: query }).toString();
  else if (provider === 'searxng') url.search = new URLSearchParams({ q: query, format: 'json', categories: 'general' }).toString();
  else url.search = new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: '5', srprop: 'snippet', format: 'json', utf8: '1' }).toString();
  return url;
}

/** Adapters only normalize returned data; they never follow result links or choose a fallback provider. */
export function parseSearchResults(provider: WireSearchProvider, body: string): SearchResult[] {
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { throw new WebError('SEARCH_PROTOCOL', 'Search endpoint returned invalid JSON.'); }
  const object = record(raw);
  const rows = provider === 'mwmbl' ? raw : provider === 'searxng' ? object?.results : record(object?.query)?.search;
  if (!Array.isArray(rows)) throw new WebError('SEARCH_PROTOCOL', 'Search endpoint did not return its documented JSON result format.');
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, 100)) {
    const item = record(row);
    if (!item) continue;
    const title = cleanText(provider === 'mwmbl' ? segments(item.title) : string(item.title)).slice(0, 300);
    const target = provider === 'wikipedia' ? `https://en.wikipedia.org/wiki/${encodeURIComponent(string(item.title).replace(/ /g, '_'))}` : string(item.url);
    if (!title || !target) continue;
    let url: URL;
    try { url = parsePublicUrl(target); }
    catch { continue; }
    // Tracking and fragment variants identify the same cited page; meaningful query parameters remain.
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.+|fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const snippet = provider === 'mwmbl' ? segments(item.extract) : string(provider === 'wikipedia' ? item.snippet : item.content);
    const engine = string(provider === 'mwmbl' ? item.source : provider === 'searxng' ? item.engine : '').replace(/[^a-z\d _.-]/gi, '').slice(0, 80);
    results.push({ title, url: url.href, snippet: cleanText(snippet).slice(0, 1000), source: engine ? `${provider}:${engine}` : provider });
    if (results.length === 10) break;
  }
  return results;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function segments(value: unknown): string {
  return Array.isArray(value) ? value.slice(0, 1000).map(segment => string(record(segment)?.value)).join('') : '';
}
