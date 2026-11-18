import { BING_RSS_ENDPOINT, EXA_ENDPOINT, bingRssProvider, exaFreeProvider } from './free-search-providers.js';
import { searchBase, type SearchProvider, type WireSearchProvider } from './search-results.js';
import { WebError } from './url-policy.js';

export interface WebSearchConfiguration { searchProvider: SearchProvider; searxUrl?: string }
export type SearchSourceKind = 'wire-json' | 'exa-mcp' | 'bing-rss';
export interface SearchSource {
  provider: SearchProvider;
  label: string;
  kind: SearchSourceKind;
  /** Endpoint recorded in the approval scope; query strings are added only at dispatch time. */
  endpoint: string;
}
/** Complete set of destinations one configured search may contact. Approval covers exactly this list. */
export interface SearchScope { providers: SearchProvider[]; endpoints: string[]; origins: string[] }

const WIRE_LABELS: Record<WireSearchProvider, string> = {
  mwmbl: 'Mwmbl general web search',
  wikipedia: 'Wikipedia encyclopedia search',
  searxng: 'Configured SearXNG general web search',
};

/**
 * Ordered attempts for one search call. Auto starts with Exa because its free anonymous endpoint
 * answered both the English and Chinese sample probes with relevant official results, while Mwmbl
 * returned no rows for the Chinese query and weaker English matches. Mwmbl stays a bounded second
 * source, so an empty or rate-limited Exa still resolves without unbounded retries. Bing RSS stays
 * explicit-only: its Chinese probe failed with ECONNRESET and it would consume the shared deadline.
 */
export function searchSources(configuration: WebSearchConfiguration): SearchSource[] {
  const provider = configuration.searchProvider;
  if (provider === 'auto') return [source('exa', configuration), source('mwmbl', configuration)];
  if (provider === 'mwmbl' || provider === 'wikipedia' || provider === 'searxng' || provider === 'exa' || provider === 'bing-rss') {
    return [source(provider, configuration)];
  }
  // Stored settings are a real input boundary even though the union type documents the values.
  throw new WebError('SEARCH_CONFIGURATION', `Unsupported search provider: ${String(provider)}.`);
}

function source(provider: SearchProvider, configuration: WebSearchConfiguration): SearchSource {
  if (provider === 'mwmbl' || provider === 'wikipedia' || provider === 'searxng') {
    return { provider, label: WIRE_LABELS[provider], kind: 'wire-json', endpoint: searchBase(provider, configuration.searxUrl).href };
  }
  if (provider === 'exa') return { provider, label: exaFreeProvider.label, kind: 'exa-mcp', endpoint: EXA_ENDPOINT };
  if (provider === 'bing-rss') return { provider, label: bingRssProvider.label, kind: 'bing-rss', endpoint: BING_RSS_ENDPOINT };
  throw new WebError('SEARCH_CONFIGURATION', `Unsupported search provider: ${String(provider)}.`);
}

export function searchConfigurationScope(configuration: WebSearchConfiguration): SearchScope {
  const sources = searchSources(configuration);
  const endpoints = [...new Set(sources.map(item => item.endpoint))];
  return { providers: sources.map(item => item.provider), endpoints, origins: [...new Set(endpoints.map(endpoint => new URL(endpoint).origin))] };
}

/**
 * A destination is inside the prepared scope only when it matches a declared endpoint's origin and
 * path. Query strings are allowed because each provider builds its fixed request there, while
 * embedded credentials, fragments and every other path on the same origin stay outside the scope.
 */
export function withinSearchScope(scope: SearchScope, url: URL): boolean {
  if (url.username || url.password || url.hash) return false;
  return scope.endpoints.some(endpoint => {
    const declared = new URL(endpoint);
    return declared.origin === url.origin && declared.pathname === url.pathname;
  });
}
