import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ExternalTools } from '../src/app/external-tools.js';
import { WebError, type CrawlResult, type DnsResolver, type SearchResponse, type WebPage } from '../src/network/index.js';

/**
 * Operator-facing network tests for ExternalTools. Every transport is a local fixture: DNS is
 * injected and fetch is replaced, so these tests never open a public connection. The shared
 * network runtime is process-wide, so only the final close test shuts it down.
 */

const PAGE_URL = 'https://www.example.org/page';
const MWMBL_ROWS = [{ url: 'https://www.example.org/result', title: [{ value: 'Fixture result' }], extract: [{ value: 'Fixture snippet' }] }];
const PAGE_HTML = '<html><head><title>Fixture</title></head><body><main>Page evidence</main></body></html>';

const publicDns: DnsResolver = async () => [{ address: '93.184.216.34', family: 4 }];

/** Search rows, robots.txt and one HTML page; every other destination is a fixture 404. */
function fixtureFetch(requests: string[] = []): typeof fetch {
  return async input => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (url.hostname === 'api.mwmbl.org' && url.pathname === '/search/') return Response.json(MWMBL_ROWS);
    if (url.hostname === 'www.example.org' && url.pathname === '/robots.txt') return new Response('', { status: 404 });
    if (url.hostname === 'www.example.org' && url.pathname === '/page') return new Response(PAGE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response('not found', { status: 404 });
  };
}

function abortError(): DOMException { return new DOMException('aborted', 'AbortError'); }

/** A request that only ends when the caller aborts the signal handed to fetch. */
function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) { reject(new Error('fixture fetch was called without an abort signal')); return; }
    if (signal.aborted) { reject(abortError()); return; }
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

async function temporaryDirectory(): Promise<string> {
  const root = process.env.TEMP ?? process.env.TMP ?? path.resolve('.tmp', 'network-external', 'child', 'temp');
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, 'operator-'));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`${label} (waited ${timeoutMs} ms)`);
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} (did not settle within ${ms} ms)`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function describeError(value: unknown): string {
  return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
}

async function webError(run: () => Promise<unknown>, label: string, codes?: string[]): Promise<WebError> {
  let failure: unknown;
  try { await run(); } catch (error) { failure = error; }
  if (!(failure instanceof WebError)) throw new Error(`${label}: expected a WebError rejection, received ${describeError(failure)}`);
  if (codes && !codes.includes(failure.code)) throw new Error(`${label}: expected ${codes.join(' or ')}, received ${failure.code} (${failure.message})`);
  return failure;
}

function assertFields(value: object, keys: readonly string[], label: string): void {
  for (const key of keys) assert.ok(Object.prototype.hasOwnProperty.call(value, key), `${label} is missing the ${key} field`);
}

/** Structured failure diagnostics are JSON, so a restarted instance can recover the exact code. */
function structuredFailureCode(text: string | undefined): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown } };
    return typeof parsed?.error?.code === 'string' ? parsed.error.code : undefined;
  } catch { return undefined; }
}

test('operatorWeb rejects invalid input and disabled capabilities before any network request', { timeout: 30000 }, async () => {
  const directory = await temporaryDirectory();
  try {
    let calls = 0;
    const fetchMock: typeof fetch = async () => { calls++; return new Response('unused', { status: 500 }); };
    const external = new ExternalTools({ dataDir: path.join(directory, 'data'), projectRoot: process.cwd(), webOptions: { searchProvider: 'mwmbl', resolveDns: publicDns, fetch: fetchMock } });

    await webError(() => external.operatorWeb('search', { query: '' }), 'empty search query', ['INVALID_QUERY']);
    await webError(() => external.operatorWeb('search', { query: '   ' }), 'whitespace search query', ['INVALID_QUERY']);
    await webError(() => external.operatorWeb('search', { query: 'x'.repeat(501) }), 'overlong search query', ['INVALID_QUERY']);
    await webError(() => external.operatorWeb('fetch', {} as never), 'missing URL', ['INVALID_URL']);
    await webError(() => external.operatorWeb('fetch', { url: 42 } as never), 'non-string URL', ['INVALID_URL']);
    await webError(() => external.operatorWeb('fetch', { url: '' }), 'empty URL', ['INVALID_URL']);
    for (const url of ['https://127.0.0.1/private', 'http://localhost:8080/admin', 'ftp://www.example.org/file']) {
      await webError(() => external.operatorWeb('fetch', { url }), `non-public URL ${url}`);
    }
    await webError(() => external.operatorWeb('crawl', { url: PAGE_URL, maxPages: 6 }), 'crawl maxPages above the limit', ['CRAWL_LIMIT']);
    await webError(() => external.operatorWeb('crawl', { url: PAGE_URL, maxPages: 0 }), 'crawl maxPages below the limit', ['CRAWL_LIMIT']);
    await webError(() => external.operatorWeb('crawl', { url: PAGE_URL, maxDepth: 3 }), 'crawl maxDepth above the limit', ['CRAWL_LIMIT']);
    await webError(() => external.operatorWeb('crawl', { url: PAGE_URL, maxDepth: -1 }), 'crawl maxDepth below the limit', ['CRAWL_LIMIT']);
    await webError(() => external.operatorWeb('describe' as never, {} as never), 'unknown action', ['INVALID_ACTION']);
    assert.equal(calls, 0, 'invalid input must not reach the network');

    external.configureWeb({ network: { webSearch: false } });
    await webError(() => external.operatorWeb('search', { query: 'local fixture' }), 'disabled search', ['NETWORK_DISABLED']);
    external.configureWeb({ network: { fetch: false } });
    await webError(() => external.operatorWeb('fetch', { url: PAGE_URL }), 'disabled fetch', ['NETWORK_DISABLED']);
    await webError(() => external.operatorWeb('crawl', { url: PAGE_URL }), 'disabled crawl', ['NETWORK_DISABLED']);
    assert.equal(calls, 0, 'disabled capabilities must not reach the network');
    assert.deepEqual(external.networkSettings(), { webSearch: false, fetch: false, proxy: '' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('operatorWeb returns real untrusted search, page and crawl shapes without receipts', { timeout: 30000 }, async () => {
  const directory = await temporaryDirectory();
  try {
    const dataDir = path.join(directory, 'data');
    const requests: string[] = [];
    const external = new ExternalTools({ dataDir, projectRoot: process.cwd(), webOptions: { searchProvider: 'mwmbl', resolveDns: publicDns, fetch: fixtureFetch(requests) } });
    external.configureWeb({ searchProvider: 'mwmbl' });

    const search = await external.operatorWeb('search', { query: 'fixture query' }) as SearchResponse;
    assertFields(search, ['provider', 'scope', 'query', 'searchUrl', 'results', 'attempts', 'fetchedAt', 'trust'], 'SearchResponse');
    assert.equal(search.query, 'fixture query');
    assert.equal(search.scope, 'general-web');
    assert.equal(search.trust, 'untrusted');
    assert.ok(search.provider.length > 0, 'search provider label must be reported');
    assert.ok(search.searchUrl.startsWith('https://api.mwmbl.org/search/'), search.searchUrl);
    assert.equal(search.results.length, 1);
    assert.deepEqual({ url: search.results[0].url, title: search.results[0].title, snippet: search.results[0].snippet }, { url: 'https://www.example.org/result', title: 'Fixture result', snippet: 'Fixture snippet' });
    assert.deepEqual(search.attempts.map(attempt => [attempt.provider, attempt.status, attempt.results]), [['mwmbl', 'results', 1]]);
    assert.ok(!Number.isNaN(Date.parse(search.fetchedAt)), search.fetchedAt);

    const page = await external.operatorWeb('fetch', { url: PAGE_URL }) as WebPage;
    assertFields(page, ['requestedUrl', 'url', 'title', 'text', 'links', 'fetchedAt', 'contentType', 'trust'], 'WebPage');
    assert.equal(page.requestedUrl, PAGE_URL);
    assert.equal(page.url, PAGE_URL);
    assert.equal(page.title, 'Fixture');
    assert.match(page.text, /Page evidence/);
    assert.ok(Array.isArray(page.links));
    assert.equal(page.trust, 'untrusted');
    assert.match(page.contentType, /^text\/html/);
    assert.ok(!Number.isNaN(Date.parse(page.fetchedAt)), page.fetchedAt);

    const crawl = await external.operatorWeb('crawl', { url: PAGE_URL, maxPages: 1, maxDepth: 0 }) as CrawlResult;
    assertFields(crawl, ['pages', 'errors', 'maxPages', 'maxDepth', 'trust'], 'CrawlResult');
    assert.equal(crawl.maxPages, 1);
    assert.equal(crawl.maxDepth, 0);
    assert.equal(crawl.pages.length, 1);
    assert.equal(crawl.pages[0].title, 'Fixture');
    assert.deepEqual(crawl.errors, []);
    assert.equal(crawl.trust, 'untrusted');

    for (const result of [search, page, crawl]) {
      for (const key of ['taskId', 'runId', 'model']) assert.equal(Object.prototype.hasOwnProperty.call(result, key), false, `operator result must not expose ${key}`);
    }
    assert.equal(existsSync(path.join(dataDir, 'external-receipts')), false, 'operatorWeb must not write external effect receipts');
    assert.ok(requests.every(request => request.startsWith('https://api.mwmbl.org/') || request.startsWith('https://www.example.org/')), requests.join(', '));
    const status = external.networkStatus();
    assert.equal(status.activeOperations, 0);
    assert.equal(status.closed, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a fresh installation defaults to automatic search and persists network switches', { timeout: 30000 }, async () => {
  const directory = await temporaryDirectory();
  try {
    const dataDir = path.join(directory, 'data');
    const external = new ExternalTools({ dataDir, projectRoot: process.cwd() });
    assert.equal(external.webConfiguration().searchProvider, 'auto');
    assert.deepEqual(external.networkSettings(), { webSearch: true, fetch: true, proxy: '' });
    assert.equal(existsSync(path.join(dataDir, 'web-settings.json')), false);

    external.configureWeb({ network: { webSearch: false } });
    assert.deepEqual(external.networkSettings(), { webSearch: false, fetch: true, proxy: '' });
    external.configureWeb({ network: { fetch: false } });
    assert.deepEqual(external.networkSettings(), { webSearch: false, fetch: false, proxy: '' });

    const restarted = new ExternalTools({ dataDir, projectRoot: process.cwd() });
    assert.equal(restarted.webConfiguration().searchProvider, 'auto');
    assert.deepEqual(restarted.networkSettings(), { webSearch: false, fetch: false, proxy: '' });

    external.configureWeb({ network: { webSearch: true } });
    const secondRestart = new ExternalTools({ dataDir, projectRoot: process.cwd() });
    assert.equal(secondRestart.webConfiguration().searchProvider, 'auto');
    assert.deepEqual(secondRestart.networkSettings(), { webSearch: true, fetch: false, proxy: '' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a configured proxy is rejected explicitly and a stored proxy blocks operations before network', { timeout: 30000 }, async () => {
  const directory = await temporaryDirectory();
  try {
    const dataDir = path.join(directory, 'data');
    const external = new ExternalTools({ dataDir, projectRoot: process.cwd() });
    external.configureWeb({ searchProvider: 'mwmbl' });
    const savedSettings = await readFile(path.join(dataDir, 'web-settings.json'), 'utf8');
    const beforeWeb = external.webConfiguration();
    const beforeNetwork = external.networkSettings();
    const error = await webError(async () => external.configureWeb({ proxy: 'http://127.0.0.1:8080' }), 'explicit proxy', ['PROXY_UNSUPPORTED']);
    assert.deepEqual(external.webConfiguration(), beforeWeb);
    assert.deepEqual(external.networkSettings(), beforeNetwork);
    assert.equal(await readFile(path.join(dataDir, 'web-settings.json'), 'utf8'), savedSettings, 'a rejected proxy must not rewrite saved settings');

    const proxiedDataDir = path.join(directory, 'proxied');
    await mkdir(proxiedDataDir, { recursive: true });
    await writeFile(path.join(proxiedDataDir, 'web-settings.json'), JSON.stringify({ searchProvider: 'mwmbl', proxy: 'http://127.0.0.1:8080' }));
    let calls = 0;
    const blockedFetch: typeof fetch = async () => { calls++; return new Response('unexpected', { status: 500 }); };
    const proxied = new ExternalTools({ dataDir: proxiedDataDir, projectRoot: process.cwd(), webOptions: { resolveDns: publicDns, fetch: blockedFetch } });
    await webError(() => proxied.operatorWeb('search', { query: 'proxy blocked' }), 'stored proxy search', ['PROXY_UNSUPPORTED']);
    await webError(() => proxied.operatorWeb('fetch', { url: PAGE_URL }), 'stored proxy fetch', ['PROXY_UNSUPPORTED']);
    assert.equal(calls, 0, 'a stored proxy must stop the request before the network');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a prepared search revoked by saved settings fails with a structured diagnostic that survives restart', { timeout: 30000 }, async () => {
  const directory = await temporaryDirectory();
  try {
    const dataDir = path.join(directory, 'data');
    let calls = 0;
    const fetchMock: typeof fetch = async () => { calls++; return new Response('unused', { status: 500 }); };
    const external = new ExternalTools({ dataDir, projectRoot: process.cwd(), webOptions: { searchProvider: 'mwmbl', resolveDns: publicDns, fetch: fetchMock } });
    const prepared = external.prepare({ name: 'web_search', arguments: { query: 'revoked fixture' } })!;
    assert.ok(prepared, 'web_search must be prepared');

    external.configureWeb({ network: { webSearch: false } });
    const outcome = await external.execute(prepared, { effectKey: 'revoked', approvedDigest: prepared.digest });
    assert.equal(outcome.status, 'failed');
    const diagnostic = JSON.parse(outcome.output) as { error?: { code?: string } };
    assert.equal(diagnostic.error?.code, 'NETWORK_DISABLED', `expected a structured NETWORK_DISABLED output, received ${outcome.output}`);
    assert.equal(calls, 0, 'a revoked request must not reach the network');

    const restarted = new ExternalTools({ dataDir, projectRoot: process.cwd() });
    const observed = await restarted.queryOutcome('revoked', prepared.digest);
    assert.equal(observed.status, 'failed');
    const persistedCode = structuredFailureCode(observed.output) ?? structuredFailureCode(observed.error);
    assert.equal(persistedCode, 'NETWORK_DISABLED', `a restarted instance must recover the structured code (output=${JSON.stringify(observed.output)}, error=${JSON.stringify(observed.error)})`);
    assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('disabling search while a request is in flight cancels it and frees the shared slot', { timeout: 30000 }, async () => {
  const directory = await temporaryDirectory();
  try {
    const dataDir = path.join(directory, 'data');
    let searches = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== 'api.mwmbl.org') return new Response('unexpected host', { status: 500 });
      searches++;
      if (searches === 1) return hangUntilAborted(init);
      return Response.json(MWMBL_ROWS);
    };
    const external = new ExternalTools({ dataDir, projectRoot: process.cwd(), webOptions: { searchProvider: 'mwmbl', resolveDns: publicDns, fetch: fetchMock } });
    external.configureWeb({ searchProvider: 'mwmbl' });

    const controller = new AbortController();
    const pending = external.operatorWeb('search', { query: 'in flight fixture' }, controller.signal).then(() => null, (error: unknown) => error);
    await waitFor(() => searches >= 1, 'the in-flight search never reached its fetch');
    assert.equal(external.networkStatus().activeOperations, 1);

    external.configureWeb({ network: { webSearch: false } });
    assert.equal(controller.signal.aborted, false, 'the caller controller must not be aborted');
    const failure = await within(pending, 5000, 'the in-flight search did not settle after search was disabled');
    if (!(failure instanceof WebError)) throw new Error(`expected WebError, received ${describeError(failure)}`);
    assert.ok(['CANCELLED', 'NETWORK_DISABLED'].includes(failure.code), `unexpected code ${failure.code} (${failure.message})`);
    await waitFor(() => external.networkStatus().activeOperations === 0, 'active operations did not return to zero');

    external.configureWeb({ network: { webSearch: true } });
    const search = await external.operatorWeb('search', { query: 'after re-enable' }) as SearchResponse;
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].url, 'https://www.example.org/result');
    assert.equal(searches, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the shared network runtime enforces one total concurrency bound across instances', { timeout: 30000 }, async () => {
  const directory = await temporaryDirectory();
  try {
    let callsA = 0;
    let callsB = 0;
    const hangA: typeof fetch = async (_input, init) => { callsA++; return hangUntilAborted(init); };
    const hangB: typeof fetch = async (_input, init) => { callsB++; return hangUntilAborted(init); };
    const externalA = new ExternalTools({ dataDir: path.join(directory, 'a'), projectRoot: process.cwd(), webOptions: { searchProvider: 'wikipedia', resolveDns: publicDns, fetch: hangA } });
    const externalB = new ExternalTools({ dataDir: path.join(directory, 'b'), projectRoot: process.cwd(), webOptions: { searchProvider: 'searxng', searxUrl: 'https://search.example.org', resolveDns: publicDns, fetch: hangB } });
    assert.equal(externalA.networkStatus().concurrencyLimit, 4);
    assert.equal(externalB.networkStatus().concurrencyLimit, 4);
    assert.ok(externalA.networkStatus().cachedClients <= 8);

    const controllers = [new AbortController(), new AbortController(), new AbortController(), new AbortController()];
    const running = [
      externalA.operatorWeb('search', { query: 'a one' }, controllers[0].signal).then(() => null, (error: unknown) => error),
      externalA.operatorWeb('search', { query: 'a two' }, controllers[1].signal).then(() => null, (error: unknown) => error),
      externalB.operatorWeb('search', { query: 'b one' }, controllers[2].signal).then(() => null, (error: unknown) => error),
      externalB.operatorWeb('search', { query: 'b two' }, controllers[3].signal).then(() => null, (error: unknown) => error),
    ];
    await waitFor(() => callsA >= 2 && callsB >= 2, 'four shared operations did not reach their fetch mocks');
    assert.equal(externalA.networkStatus().activeOperations, 4);

    const startedAt = Date.now();
    await webError(() => externalA.operatorWeb('search', { query: 'a five' }), 'a fifth shared operation', ['CONCURRENCY_LIMIT']);
    assert.ok(Date.now() - startedAt < 1000, 'the refused operation must be rejected promptly');
    assert.equal(callsA, 2, 'the refused operation must not reach the network');

    for (const controller of controllers) controller.abort();
    const settled = await Promise.all(running);
    for (const result of settled) assert.ok(result instanceof WebError, `an aborted shared operation settled without a WebError: ${describeError(result)}`);
    await waitFor(() => externalA.networkStatus().activeOperations === 0, 'the shared runtime did not return to zero active operations');
    assert.ok(externalA.networkStatus().cachedClients <= 8, 'cached clients must stay bounded');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('close cancels in-flight work and refuses later operations', { timeout: 30000 }, async () => {
  const directory = await temporaryDirectory();
  try {
    const dataDir = path.join(directory, 'data');
    let pages = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      pages++;
      return hangUntilAborted(init);
    };
    const external = new ExternalTools({ dataDir, projectRoot: process.cwd(), webOptions: { resolveDns: publicDns, fetch: fetchMock } });
    const pending = external.operatorWeb('fetch', { url: PAGE_URL }).then(() => null, (error: unknown) => error);
    await waitFor(() => pages >= 1, 'the page fetch never started');
    assert.equal(external.networkStatus().activeOperations, 1);

    await external.close();
    const failure = await within(pending, 5000, 'close did not settle the pending page fetch');
    if (!(failure instanceof WebError)) throw new Error(`expected WebError, received ${describeError(failure)}`);
    assert.ok(['CANCELLED', 'CLOSED'].includes(failure.code), `unexpected code ${failure.code} (${failure.message})`);
    assert.equal(external.networkStatus().closed, true);
    await waitFor(() => external.networkStatus().activeOperations === 0, 'active operations did not return to zero after close');
    await webError(() => external.operatorWeb('fetch', { url: PAGE_URL }), 'operation after close', ['CLOSED']);
    assert.equal(pages, 1, 'no request may start after close');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
