import { decodeBody } from './body-decoder.js';
import { FREE_PROVIDERS, type ProviderTransport } from './free-search-providers.js';
import { extractPage, parseRobots, robotsAllows, type RobotsPolicy } from './page-content.js';
import { publicGet, publicRequest, WEB_USER_AGENT, type PublicRequestInit } from './public-transport.js';
import { parseSearchResults, searchEndpoint, type SearchProvider, type SearchResult, type WireSearchProvider } from './search-results.js';
import { searchConfigurationScope, searchSources, withinSearchScope, type SearchScope, type SearchSource, type WebSearchConfiguration } from './search-scope.js';
import { abortable, parsePublicUrl, resolvePublicUrl, systemResolver, WebError, type DnsResolver } from './url-policy.js';

export type { SearchProvider, SearchResult } from './search-results.js';

export interface WebClientOptions {
  searchProvider?: SearchProvider;
  searxUrl?: string;
  timeoutMs?: number;
  /** Per-source budget inside an automatic chain, so one slow free source cannot consume the whole deadline. */
  searchAttemptMs?: number;
  /** Simultaneous operations allowed on one client. */
  maxConcurrent?: number;
  /** Remembered robots.txt policies; the oldest host is evicted first. */
  robotsLimit?: number;
  fetch?: typeof fetch;
  resolveDns?: DnsResolver;
}
export type SearchAttemptStatus = 'results' | 'empty' | 'error';
/** One source's outcome inside a search call; provenance survives even when a later source wins. */
export interface SearchAttempt {
  provider: SearchProvider;
  label: string;
  endpoint: string;
  status: SearchAttemptStatus;
  results: number;
  durationMs: number;
  errorCode?: string;
  error?: string;
}
export interface SearchResponse {
  provider: string;
  scope: 'encyclopedia' | 'general-web';
  query: string;
  searchUrl: string;
  results: SearchResult[];
  attempts: SearchAttempt[];
  fetchedAt: string;
  trust: 'untrusted';
}
export interface WebPage { requestedUrl: string; url: string; title: string; text: string; links: string[]; fetchedAt: string; contentType: string; /** HTTP status of the response that was actually read (the final redirect target). */ status: number; trust: 'untrusted' }
export interface CrawlOptions { maxPages?: number; maxDepth?: number }
export interface CrawlResult { pages: WebPage[]; errors: { url: string; code: string; message: string }[]; maxPages: number; maxDepth: number; trust: 'untrusted' }

/** Raised when an automatic chain had sources to try but none returned usable results. */
export class WebSearchError extends WebError {
  constructor(code: string, message: string, readonly attempts: SearchAttempt[]) {
    super(code, message);
    this.name = 'WebSearchError';
  }
}

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_SEARCH_ATTEMPT_MS = 15000;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_ROBOTS_LIMIT = 64;
const MAX_SEARCH_BODY_BYTES = 1024 * 1024;
const MAX_PAGE_BODY_BYTES = 1024 * 1024;
const ROBOTS_TTL_MS = 300000;
const REDIRECT_STATUS = [301, 302, 303, 307, 308];
/** Codes another source may plausibly answer after; semantic and scope failures stop the chain. */
const RETRYABLE_CODES = new Set(['TIMEOUT', 'RATE_LIMITED', 'HTTP_FAILED', 'BODY_LIMIT', 'SEARCH_PROTOCOL', 'NETWORK_FAILED', 'DNS_BLOCKED', 'CONTENT_TYPE', 'CONTENT_ENCODING']);

export class WebClient {
  private readonly resolver: DnsResolver;
  private readonly timeoutMs: number;
  private readonly attemptMs: number;
  private readonly maxConcurrent: number;
  private readonly robotsLimit: number;
  private readonly robots = new Map<string, { policy: RobotsPolicy; loadedAt: number; lastPageAt: number }>();
  private active = 0;

  constructor(private readonly options: WebClientOptions = {}) {
    this.resolver = options.resolveDns ?? systemResolver;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attemptMs = positiveLimit(options.searchAttemptMs ?? DEFAULT_SEARCH_ATTEMPT_MS, 'searchAttemptMs');
    this.maxConcurrent = positiveLimit(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, 'maxConcurrent');
    this.robotsLimit = positiveLimit(options.robotsLimit ?? DEFAULT_ROBOTS_LIMIT, 'robotsLimit');
    // A stored but unusable configuration must fail before any socket work, not mid-request.
    searchSources(this.configuration());
  }

  search(query: string, signal?: AbortSignal): Promise<SearchResponse> {
    return this.operation(signal, async deadline => {
      if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new WebError('INVALID_QUERY', 'Search query must contain 1–500 characters.');
      query = query.trim();
      const configuration = this.configuration();
      const sources = searchSources(configuration);
      const scope = searchConfigurationScope(configuration);
      const attempts: SearchAttempt[] = [];
      for (const source of sources) {
        if (deadline.aborted) throw this.abortedSearch(signal, attempts);
        const startedAt = Date.now();
        const budget = this.attemptBudget(deadline);
        try {
          const outcome = await this.runSearchSource(source, query, budget.signal, scope);
          attempts.push({ provider: source.provider, label: source.label, endpoint: outcome.endpoint, status: outcome.results.length ? 'results' : 'empty', results: outcome.results.length, durationMs: Date.now() - startedAt });
          if (outcome.results.length) {
            // Only the winning label is promoted; every attempt stays visible for provenance.
            return { provider: source.label, scope: source.provider === 'wikipedia' ? 'encyclopedia' : 'general-web', query, searchUrl: outcome.endpoint, results: outcome.results, attempts, fetchedAt: new Date().toISOString(), trust: 'untrusted' };
          }
        } catch (error) {
          const aborted = deadline.aborted;
          const failure = aborted
            ? new WebError(signal?.aborted ? 'CANCELLED' : 'TIMEOUT', signal?.aborted ? 'Search cancelled by the caller.' : 'Search deadline expired before this source answered.')
            : budget.expired() ? new WebError('TIMEOUT', `${source.label} exceeded its ${this.attemptMs} ms search budget.`) : error;
          attempts.push({ provider: source.provider, label: source.label, endpoint: source.endpoint, status: 'error', results: 0, durationMs: Date.now() - startedAt, errorCode: failure instanceof WebError ? failure.code : 'NETWORK_FAILED', error: failure instanceof Error ? failure.message : String(failure) });
          // A cancelled call, an explicit provider and a semantic failure all stop here; only a
          // retryable failure of an automatic chain continues. Provenance is kept in every case.
          if (aborted) throw this.abortedSearch(signal, attempts);
          if (sources.length === 1 || !retryableFailure(failure)) {
            throw new WebSearchError(failure instanceof WebError ? failure.code : 'NETWORK_FAILED', failure instanceof Error ? failure.message : String(failure), attempts);
          }
        } finally { budget.dispose(); }
      }
      if (deadline.aborted) throw this.abortedSearch(signal, attempts);
      if (attempts.every(attempt => attempt.status === 'empty')) return this.emptyResponse(sources, query, attempts);
      throw new WebSearchError('SEARCH_UNAVAILABLE', `No free search source returned results (${attempts.map(attempt => `${attempt.provider}: ${attempt.errorCode ?? attempt.status}`).join('; ')}).`, attempts);
    });
  }

  fetchPage(input: string, signal?: AbortSignal): Promise<WebPage> {
    return this.operation(signal, deadline => this.readPage(parsePublicUrl(input), deadline));
  }

  crawl(input: string, options: CrawlOptions = {}, signal?: AbortSignal): Promise<CrawlResult> {
    return this.operation(signal, async deadline => {
      const start = parsePublicUrl(input);
      const maxPages = integerLimit(options.maxPages ?? 5, 1, 5, 'maxPages');
      const maxDepth = integerLimit(options.maxDepth ?? 2, 0, 2, 'maxDepth');
      const queue = [{ url: start, depth: 0 }];
      const visited = new Set<string>();
      const result: CrawlResult = { pages: [], errors: [], maxPages, maxDepth, trust: 'untrusted' };
      let attempted = 0;
      while (queue.length && attempted < maxPages) {
        deadline.throwIfAborted();
        const next = queue.shift()!;
        if (visited.has(next.url.href)) continue;
        visited.add(next.url.href);
        attempted++;
        try {
          const page = await this.readPage(next.url, deadline);
          result.pages.push(page);
          visited.add(page.url);
          if (next.depth < maxDepth) {
            for (const link of page.links) if (!visited.has(link) && new URL(link).origin === start.origin) queue.push({ url: new URL(link), depth: next.depth + 1 });
          }
        } catch (error) {
          if (deadline.aborted) throw error;
          result.errors.push({ url: next.url.href, code: error instanceof WebError ? error.code : 'NETWORK_FAILED', message: error instanceof Error ? error.message : String(error) });
        }
      }
      return result;
    });
  }

  /** Observable bound of the robots cache; long crawls over many hosts must not grow it without limit. */
  robotsCacheEntries(): number { return this.robots.size; }

  private configuration(): WebSearchConfiguration {
    return this.options.searxUrl === undefined
      ? { searchProvider: this.options.searchProvider ?? 'mwmbl' }
      : { searchProvider: this.options.searchProvider ?? 'mwmbl', searxUrl: this.options.searxUrl };
  }

  private async runSearchSource(source: SearchSource, query: string, signal: AbortSignal, scope: SearchScope): Promise<{ results: SearchResult[]; endpoint: string }> {
    if (source.kind === 'wire-json') {
      const provider = source.provider as WireSearchProvider;
      const url = searchEndpoint(provider, query, this.options.searxUrl);
      this.assertWithinScope(scope, url);
      const response = await this.requestSearch(url, { method: 'GET', headers: { Accept: 'text/html,application/json,text/plain;q=0.9' } }, signal);
      await this.assertReadableStatus(response);
      const bytes = await readBytes(response, signal, MAX_SEARCH_BODY_BYTES);
      return { endpoint: url.href, results: parseSearchResults(provider, new TextDecoder().decode(bytes)) };
    }
    const provider = FREE_PROVIDERS.find(entry => entry.id === source.provider);
    if (!provider) throw new WebError('SEARCH_CONFIGURATION', `No free search adapter is registered for ${String(source.provider)}.`);
    const outcome = await provider.search(query, this.providerTransport(scope), signal);
    // The adapter declares where it went; verify the declaration is still inside the approved scope.
    this.assertWithinScope(scope, new URL(outcome.endpoint));
    return { endpoint: outcome.endpoint, results: outcome.results };
  }

  /** Every dispatch from a free adapter passes the same pinned transport and scope check as wire providers. */
  private providerTransport(scope: SearchScope): ProviderTransport {
    return async (request, signal) => {
      const url = new URL(request.url);
      this.assertWithinScope(scope, url);
      const init: PublicRequestInit = { method: request.method, headers: request.headers };
      if (request.body !== undefined) init.body = request.body;
      return this.requestSearch(url, init, signal);
    };
  }

  private async requestSearch(url: URL, init: PublicRequestInit, signal: AbortSignal): Promise<Response> {
    const address = await resolvePublicUrl(url, this.resolver, signal);
    const response = this.options.fetch
      ? await abortable(this.options.fetch(url.href, {
        method: init.method, redirect: 'manual', signal,
        headers: { 'User-Agent': WEB_USER_AGENT, 'Accept-Encoding': 'identity', ...init.headers },
        ...(init.body === undefined ? {} : { body: init.body }),
      }), signal)
      : await publicRequest(url, address, init, signal);
    // Search endpoints are fixed; a redirect would leave the reviewed destination list.
    if (REDIRECT_STATUS.includes(response.status)) {
      await response.body?.cancel();
      throw new WebError('SEARCH_SCOPE', 'A search provider redirect is outside the prepared search scope.');
    }
    return response;
  }

  private assertWithinScope(scope: SearchScope, url: URL): void {
    if (!withinSearchScope(scope, url)) throw new WebError('SEARCH_SCOPE', `Search destination ${url.origin}${url.pathname} is outside the prepared search scope.`);
  }

  /** Timeout or cancellation after some sources ran still reports everything that was attempted. */
  private abortedSearch(signal: AbortSignal | undefined, attempts: SearchAttempt[]): WebSearchError {
    const cancelled = signal?.aborted === true;
    return new WebSearchError(cancelled ? 'CANCELLED' : 'TIMEOUT', cancelled ? 'Search cancelled by the caller.' : 'Search deadline expired.', attempts);
  }

  private attemptBudget(deadline: AbortSignal): { signal: AbortSignal; expired: () => boolean; dispose: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('SEARCH_ATTEMPT_BUDGET')), this.attemptMs);
    timer.unref();
    return { signal: AbortSignal.any([deadline, controller.signal]), expired: () => controller.signal.aborted, dispose: () => clearTimeout(timer) };
  }

  private emptyResponse(sources: SearchSource[], query: string, attempts: SearchAttempt[]): SearchResponse {
    const single = sources.length === 1 ? sources[0] : undefined;
    return {
      provider: single?.label ?? 'Free web search (no results)',
      scope: single?.provider === 'wikipedia' ? 'encyclopedia' : 'general-web',
      query,
      searchUrl: attempts.at(-1)?.endpoint ?? single?.endpoint ?? '',
      results: [],
      attempts,
      fetchedAt: new Date().toISOString(),
      trust: 'untrusted',
    };
  }

  private async readPage(url: URL, signal: AbortSignal): Promise<WebPage> {
    const { response, finalUrl } = await this.get(url, signal, true);
    await this.assertReadableStatus(response);
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^(?:text\/html|application\/xhtml\+xml|text\/plain)(?:;|$)/i.test(contentType)) {
      await response.body?.cancel();
      throw new WebError('CONTENT_TYPE', 'Only public HTML and plain-text pages can be extracted.');
    }
    const bytes = await readBytes(response, signal, MAX_PAGE_BODY_BYTES);
    const { text } = decodeBody(bytes, contentType, MAX_PAGE_BODY_BYTES);
    const extracted = /html/i.test(contentType) ? extractPage(text, finalUrl) : { title: finalUrl.hostname, text: text.slice(0, 40000), links: [] };
    // status is the observed source response, not the caller's transport outcome: a 201/206 page is a
    // successful read and must stay distinguishable from a synthetic 200.
    return { requestedUrl: url.href, url: finalUrl.href, ...extracted, fetchedAt: new Date().toISOString(), contentType, status: response.status, trust: 'untrusted' };
  }

  private async get(initial: URL, signal: AbortSignal, obeyRobots: boolean): Promise<{ response: Response; finalUrl: URL }> {
    let current = initial;
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      if (obeyRobots) await this.checkRobots(current, signal);
      const address = await resolvePublicUrl(current, this.resolver, signal);
      const response = this.options.fetch ? await abortable(this.options.fetch(current.href, {
        method: 'GET', redirect: 'manual', signal, headers: { 'User-Agent': WEB_USER_AGENT, 'Accept-Encoding': 'identity' },
      }), signal) : await publicGet(current, address, signal);
      if (!REDIRECT_STATUS.includes(response.status)) return { response, finalUrl: current };
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new WebError('REDIRECT_INVALID', 'Redirect has no Location header.');
      const target = parsePublicUrl(new URL(location, current).href);
      if (target.origin !== initial.origin) throw new WebError('REDIRECT_SCOPE', 'Cross-origin redirect requires a separate approved request.');
      current = target;
    }
    throw new WebError('REDIRECT_LIMIT', 'More than five redirects were refused.');
  }

  private async checkRobots(url: URL, signal: AbortSignal): Promise<void> {
    let entry = this.robots.get(url.origin);
    if (!entry || Date.now() - entry.loadedAt > ROBOTS_TTL_MS) {
      const { response } = await this.get(new URL('/robots.txt', url), signal, false);
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel();
        entry = { policy: { rules: [], crawlDelayMs: 0 }, loadedAt: Date.now(), lastPageAt: 0 };
      }
      else {
        if (!response.ok) { await response.body?.cancel(); throw new WebError('ROBOTS_UNAVAILABLE', `robots.txt returned HTTP ${response.status}; crawl stopped.`); }
        entry = { policy: parseRobots(await readText(response, signal, 512 * 1024)), loadedAt: Date.now(), lastPageAt: 0 };
      }
      this.rememberRobots(url.origin, entry);
    }
    if (!robotsAllows(entry.policy, url)) throw new WebError('ROBOTS_DENIED', 'Site robots.txt excludes this page.');
    if (entry.policy.crawlDelayMs > 10000) throw new WebError('ROBOTS_DELAY', 'Site requests more than the supported ten-second crawl delay; request stopped.');
    const wait = entry.policy.crawlDelayMs - (Date.now() - entry.lastPageAt);
    if (wait > 0) await abortable(new Promise<void>(resolve => setTimeout(resolve, wait)), signal);
    entry.lastPageAt = Date.now();
  }

  private rememberRobots(origin: string, entry: { policy: RobotsPolicy; loadedAt: number; lastPageAt: number }): void {
    this.robots.delete(origin);
    this.robots.set(origin, entry);
    while (this.robots.size > this.robotsLimit) {
      const oldest = this.robots.keys().next().value;
      if (oldest === undefined) break;
      this.robots.delete(oldest);
    }
  }

  private async assertReadableStatus(response: Response): Promise<void> {
    if (response.ok) return;
    await response.body?.cancel();
    if ([401, 402, 403].includes(response.status)) throw new WebError('ACCESS_BLOCKED', `HTTP ${response.status}: access is restricted; no bypass is attempted.`);
    throw new WebError(response.status === 429 ? 'RATE_LIMITED' : 'HTTP_FAILED', `HTTP ${response.status}: request failed.`);
  }

  private async operation<T>(signal: AbortSignal | undefined, callback: (deadline: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) throw new WebError('CONCURRENCY_LIMIT', `At most ${this.maxConcurrent} network operations may run at once on this client.`);
    this.active++;
    const deadline = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    try { return await callback(deadline); }
    catch (error) {
      // Search provenance survives timeout and cancellation; only errors still lacking attempts
      // are mapped to the operation-level abort error here.
      if (error instanceof WebSearchError) throw error;
      if (deadline.aborted) throw new WebError(signal?.aborted ? 'CANCELLED' : 'TIMEOUT', signal?.aborted ? 'Network request cancelled.' : 'Network request timed out.');
      throw error;
    } finally { this.active--; }
  }
}

function retryableFailure(error: unknown): boolean {
  // An unexpected transport failure is worth one other source; a refused semantic or scope error is not.
  return error instanceof WebError ? RETRYABLE_CODES.has(error.code) : true;
}

/** Reads a body once, refusing compressed payloads and enforcing the byte cap while streaming. */
async function readBytes(response: Response, signal: AbortSignal, maxBytes: number): Promise<Uint8Array> {
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding !== 'identity') { await response.body?.cancel(); throw new WebError('CONTENT_ENCODING', 'Server ignored identity encoding; compressed payload was refused.'); }
  if (!response.body) return new Uint8Array(0);
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body.cancel(); throw new WebError('BODY_LIMIT', 'Page exceeds the permitted download size.'); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new WebError('BODY_LIMIT', 'Page exceeds the permitted download size.');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

async function readText(response: Response, signal: AbortSignal, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBytes(response, signal, maxBytes));
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new WebError('CONFIGURATION', `${name} must be a positive integer.`);
  return value;
}
function integerLimit(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new WebError('CRAWL_LIMIT', `${name} must be ${minimum}–${maximum}.`);
  return value;
}
