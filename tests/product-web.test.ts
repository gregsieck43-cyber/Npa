import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import { ExternalTools } from '../src/app/external-tools.js';
import type { CrawlResult, SearchAttempt, SearchResponse, WebPage } from '../src/network/index.js';

/**
 * Real-HTTP coverage for the operator browsing wiring (legacy /v1/web/* and product /v1/product/web/*).
 *
 * Every test starts the real backend and injects one deterministic transport into a REAL ExternalTools
 * instance, so the routes exercise the actual WebClient/operatorWeb path while no public socket, DNS
 * lookup, model call or Agent task is involved. The startup adapter object is replaced after startup and
 * its web surface is pointed at the fixture as well, so an implementation that captured the startup
 * instance still cannot reach the network from this test.
 */

const root = path.resolve(process.env.TEMP ?? path.join('.tmp', 'network-product', 'b'));
mkdirSync(root, { recursive: true });

const PAGE_URL = 'https://www.example.org/page';
const RESULT_URL = 'https://www.example.org/result';
const SLOW_URL = 'https://www.example.org/slow';
const MWMBL_SEARCH_PREFIX = 'https://api.mwmbl.org/search/';
const MWMBL_ROWS = [{ url: RESULT_URL, title: [{ value: 'Fixture result' }], extract: [{ value: 'Fixture snippet' }] }];
const PAGE_HTML = '<html><head><title>Fixture page</title></head><body><main>Readable fixture article body.</main></body></html>';
const ARTICLE_TEXT = 'Readable fixture article body';
const RECEIPTS_DIRECTORY = 'external-receipts';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

interface CapturedRequest { url: string; signal: AbortSignal | undefined }

interface FixtureState {
  mode: 'ok' | 'fail';
  requests: CapturedRequest[];
  pageRequests: CapturedRequest[];
  hang: CapturedRequest | undefined;
  hangStarted: boolean;
  searchCalls: number;
  pageCalls: number;
  unexpected: string[];
}

function abortError(): Error { return new DOMException('The operation was aborted.', 'AbortError'); }

/** A transport response that settles only when the caller's signal aborts. */
function waitForAbort(signal: AbortSignal | undefined, label: string): Promise<Response> {
  if (!signal) throw new Error(`fixture: ${label} was fetched without an abort signal`);
  return new Promise<Response>((_resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

function createFixture(): { state: FixtureState; fetch: typeof fetch } {
  const state: FixtureState = { mode: 'ok', requests: [], pageRequests: [], hang: undefined, hangStarted: false, searchCalls: 0, pageCalls: 0, unexpected: [] };
  const fixtureFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const captured: CapturedRequest = { url: url.href, signal: init?.signal ?? undefined };
    state.requests.push(captured);
    // robots.txt is requested before a page; 404 means "no rules" and keeps the fixture deterministic.
    if (url.hostname === 'www.example.org' && url.pathname === '/robots.txt') return new Response('', { status: 404 });
    if (url.hostname === 'api.mwmbl.org' && url.pathname === '/search/') {
      state.searchCalls++;
      if (state.mode === 'fail') return new Response('rate limited', { status: 429 });
      return Response.json(MWMBL_ROWS);
    }
    if (url.hostname === 'mcp.exa.ai') {
      state.searchCalls++;
      if (state.mode === 'fail') return new Response('rate limited', { status: 429 });
      throw new Error('fixture: an explicit Mwmbl search must not reach the Exa endpoint');
    }
    if (url.hostname === 'www.example.org') {
      state.pageRequests.push(captured);
      state.pageCalls++;
      if (state.mode === 'fail') return new Response('unavailable', { status: 503 });
      if (url.pathname === '/slow') {
        state.hang = captured;
        state.hangStarted = true;
        return waitForAbort(captured.signal, 'slow page');
      }
      return new Response(PAGE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    state.unexpected.push(url.href);
    throw new Error('fixture: unexpected URL ' + url.href);
  };
  return { state, fetch: fixtureFetch };
}

interface SetupInput { networkSettings?: Record<string, unknown> }

async function setup(input: SetupInput = {}) {
  const dir = mkdtempSync(path.join(root, 'product-web-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const networkDir = path.join(dir, 'network');
  if (input.networkSettings) {
    mkdirSync(networkDir, { recursive: true });
    writeFileSync(path.join(networkDir, 'web-settings.json'), JSON.stringify(input.networkSettings));
  }
  let modelCalls = 0;
  const backend = await startBackend({
    dataDir: path.join(dir, 'data'),
    projectRoot: process.cwd(),
    mockOptions: { responder: () => { modelCalls++; return { content: 'Mock must not be called for operator browsing.' }; } },
  });
  const fixture = createFixture();
  const external = new ExternalTools({
    dataDir: networkDir,
    projectRoot: process.cwd(),
    webOptions: { searchProvider: 'mwmbl', resolveDns: publicDns, fetch: fixture.fetch },
  });
  const services = backend.services as unknown as { external: ExternalTools };
  const startup = services.external;
  services.external = external;
  if (startup && startup !== external) {
    // The product layer may have captured the startup instance; delegate its web surface to the fixture
    // so a cached reference still runs against the deterministic transport instead of the real network.
    const surface = startup as unknown as Record<string, unknown>;
    for (const name of ['operatorWeb', 'configureWeb', 'webConfiguration', 'networkSettings', 'networkStatus', 'prepare', 'execute', 'close'] as const) {
      const method = (external as unknown as Record<string, unknown>)[name];
      if (typeof method === 'function') surface[name] = (method as (...args: unknown[]) => unknown).bind(external);
    }
  }
  const base = () => 'http://127.0.0.1:' + backend.port;
  const request = async (method: string, route: string, body?: unknown): Promise<HttpReply> => {
    const response = await fetch(base() + route, {
      method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* Keep the raw body for the failure message. */ }
    return { status: response.status, body: parsed, text };
  };
  const close = async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); };
  return { backend, dir, fixture, request, base, tasks: () => backend.services.kernel.listTasks().length, modelCalls: () => modelCalls, close };
}

type Env = Awaited<ReturnType<typeof setup>>;
interface HttpReply { status: number; body: any; text: string }
type CodeExpectation = readonly string[] | ((code: string) => boolean);

function expectStructuredError(reply: HttpReply, status: number, codes: CodeExpectation | undefined, label: string): SearchAttempt[] {
  assert.equal(reply.status, status, `${label}: expected HTTP ${status}, received ${reply.status} (${reply.text})`);
  assert.ok(reply.body && typeof reply.body === 'object' && !Array.isArray(reply.body), `${label}: expected a JSON error object (${reply.text})`);
  assert.equal(typeof reply.body.code, 'string', `${label}: the error code must be a string (${reply.text})`);
  assert.equal(typeof reply.body.error, 'string', `${label}: the error message must be a string (${reply.text})`);
  assert.ok(reply.body.error.length > 0, `${label}: the error message must not be empty`);
  const code = reply.body.code as string;
  if (typeof codes === 'function') assert.ok(codes(code), `${label}: unexpected code ${code} (${reply.text})`);
  else if (codes) assert.ok(codes.includes(code), `${label}: unexpected code ${code} (${reply.text})`);
  if (reply.body.attempts === undefined) return [];
  assert.ok(Array.isArray(reply.body.attempts), `${label}: attempts must be an array (${reply.text})`);
  return reply.body.attempts as SearchAttempt[];
}

function assertNoBrowsingSideEffects(env: Env, tasksBefore: number): void {
  assert.equal(env.tasks(), tasksBefore, 'operator browsing must not create a kernel task');
  assert.equal(env.modelCalls(), 0, 'operator browsing must not call the model');
  assert.equal(existsSync(path.join(env.dir, 'network', RECEIPTS_DIRECTORY)), false, 'operator browsing must not write Agent effect receipts');
}

function assertAutomaticSearchAttempts(attempts: SearchAttempt[], label: string): void {
  assert.equal(attempts.length, 2, `${label}: the automatic chain must report both attempts`);
  assert.deepEqual(attempts.map(attempt => attempt.provider), ['exa', 'mwmbl'], `${label}: attempts must keep provider provenance`);
  for (const attempt of attempts) {
    assert.equal(attempt.status, 'error', `${label}: ${attempt.provider} must be reported as an error`);
    assert.equal(attempt.results, 0, `${label}: ${attempt.provider} produced no results`);
    assert.equal(attempt.errorCode, 'RATE_LIMITED', `${label}: ${attempt.provider} must keep its real error code`);
    assert.equal(typeof attempt.label, 'string');
    assert.ok(attempt.label.length > 0);
    assert.equal(typeof attempt.endpoint, 'string');
    assert.ok(attempt.endpoint.startsWith('https://'), attempt.endpoint);
    assert.equal(typeof attempt.durationMs, 'number');
    assert.equal(typeof attempt.error, 'string');
  }
}

async function until(read: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (read()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms.`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

test('legacy web search reports the real provider, attempts and no task or model call', { timeout: 60000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const tasksBefore = env.tasks();

  const reply = await env.request('POST', '/v1/web/search', { query: 'fixture query' });
  assert.equal(reply.status, 200, reply.text);
  const body = reply.body as SearchResponse;
  assert.equal(body.query, 'fixture query');
  assert.equal(body.scope, 'general-web');
  assert.equal(body.trust, 'untrusted');
  assert.equal(typeof body.provider, 'string');
  assert.ok(body.provider.length > 0, 'the winning provider label must be reported');
  assert.ok(body.searchUrl.startsWith(MWMBL_SEARCH_PREFIX), body.searchUrl);
  assert.equal(body.results.length, 1);
  assert.deepEqual(
    { title: body.results[0].title, url: body.results[0].url, snippet: body.results[0].snippet },
    { title: 'Fixture result', url: RESULT_URL, snippet: 'Fixture snippet' },
  );
  assert.equal(typeof body.results[0].source, 'string');
  assert.equal(body.attempts.length, 1);
  assert.equal(body.attempts[0].provider, 'mwmbl');
  assert.equal(body.attempts[0].status, 'results');
  assert.equal(body.attempts[0].results, 1);
  assert.ok(body.attempts[0].endpoint.startsWith(MWMBL_SEARCH_PREFIX), body.attempts[0].endpoint);
  assert.equal(typeof body.attempts[0].label, 'string');
  assert.ok(body.attempts[0].label.length > 0);
  assert.equal(typeof body.attempts[0].durationMs, 'number');
  assert.ok(body.attempts[0].durationMs >= 0);
  assert.ok(!Number.isNaN(Date.parse(body.fetchedAt)), body.fetchedAt);
  assert.equal(Object.hasOwn(body as object, 'taskId'), false, 'legacy search must not return a task id');
  assertNoBrowsingSideEffects(env, tasksBefore);
});

test('product search feeds product fetch through the same real operator transport', { timeout: 60000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const tasksBefore = env.tasks();

  const search = await env.request('POST', '/v1/product/web/search', { query: 'fixture query' });
  assert.equal(search.status, 200, search.text);
  assert.ok(Array.isArray(search.body), 'product search must return a JSON array: ' + search.text);
  assert.equal(search.body.length, 1);
  const hit = search.body[0] as { title?: unknown; url?: unknown; snippet?: unknown; source?: unknown };
  assert.equal(hit.title, 'Fixture result');
  assert.equal(hit.url, RESULT_URL);
  assert.equal(hit.snippet, 'Fixture snippet');
  assert.ok(hit.source === undefined || typeof hit.source === 'string', 'source is optional provider provenance');

  const page = await env.request('POST', '/v1/product/web/fetch', { url: hit.url as string });
  assert.equal(page.status, 200, page.text);
  const view = page.body as WebPage & { status: number };
  assert.equal(view.url, RESULT_URL);
  assert.equal(view.title, 'Fixture page');
  assert.equal(typeof view.text, 'string');
  assert.ok(view.text.includes(ARTICLE_TEXT), view.text);
  assert.equal(view.status, 200);
  assert.ok(!Number.isNaN(Date.parse(view.fetchedAt)), view.fetchedAt);
  assert.equal(Object.hasOwn(page.body as object, 'taskId'), false, 'product fetch must not return a task id');
  assertNoBrowsingSideEffects(env, tasksBefore);
});

test('legacy web fetch returns the full untrusted WebPage shape without a task', { timeout: 60000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const tasksBefore = env.tasks();

  const reply = await env.request('POST', '/v1/web/fetch', { url: PAGE_URL });
  assert.equal(reply.status, 200, reply.text);
  const page = reply.body as WebPage;
  assert.equal(page.requestedUrl, PAGE_URL);
  assert.equal(page.url, PAGE_URL);
  assert.equal(page.title, 'Fixture page');
  assert.equal(typeof page.text, 'string');
  assert.ok(page.text.includes(ARTICLE_TEXT), page.text);
  assert.ok(Array.isArray(page.links));
  assert.ok(!Number.isNaN(Date.parse(page.fetchedAt)), page.fetchedAt);
  assert.ok(page.contentType.startsWith('text/html'), page.contentType);
  assert.equal(page.trust, 'untrusted');
  assert.equal(Object.hasOwn(reply.body as object, 'taskId'), false, 'legacy fetch must not return a task id');
  assertNoBrowsingSideEffects(env, tasksBefore);
});

test('legacy crawl returns the untrusted CrawlResult without a task', { timeout: 60000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const tasksBefore = env.tasks();

  const reply = await env.request('POST', '/v1/web/crawl', { url: PAGE_URL, maxPages: 2, maxDepth: 1 });
  assert.equal(reply.status, 200, reply.text);
  const crawl = reply.body as CrawlResult;
  assert.equal(crawl.trust, 'untrusted');
  assert.equal(crawl.maxPages, 2);
  assert.equal(crawl.maxDepth, 1);
  assert.equal(crawl.pages.length, 1);
  assert.equal(crawl.pages[0].url, PAGE_URL);
  assert.equal(crawl.pages[0].title, 'Fixture page');
  assert.ok(crawl.pages[0].text.includes(ARTICLE_TEXT), crawl.pages[0].text);
  assert.ok(Array.isArray(crawl.errors));
  assert.equal(Object.hasOwn(reply.body as object, 'taskId'), false, 'legacy crawl must not return a task id');
  assertNoBrowsingSideEffects(env, tasksBefore);
});

test('invalid browsing input fails with a structured 400 before any transport call', { timeout: 60000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const tasksBefore = env.tasks();
  const queryCode = (code: string) => code === 'INVALID_QUERY' || code === 'validation';
  const urlCode = (code: string) => code === 'INVALID_URL' || code === 'URL_BLOCKED' || code === 'validation';
  const crawlCode = (code: string) => code === 'CRAWL_LIMIT' || code === 'validation';
  const unknownField = (code: string) => code === 'validation' || code.startsWith('INVALID_');

  const queryCases: { label: string; body: Record<string, unknown>; accepts: CodeExpectation }[] = [
    { label: 'missing query', body: {}, accepts: queryCode },
    { label: 'empty query', body: { query: '' }, accepts: queryCode },
    { label: 'whitespace query', body: { query: '   ' }, accepts: queryCode },
    { label: 'overlong query', body: { query: 'x'.repeat(501) }, accepts: queryCode },
    { label: 'unknown search field', body: { query: 'fixture', surprise: true }, accepts: unknownField },
  ];
  const urlCases: { label: string; body: Record<string, unknown>; accepts: CodeExpectation }[] = [
    { label: 'missing url', body: {}, accepts: urlCode },
    { label: 'empty url', body: { url: '' }, accepts: urlCode },
    { label: 'malformed url', body: { url: 'not a url' }, accepts: urlCode },
    { label: 'private ip url', body: { url: 'https://127.0.0.1/private' }, accepts: urlCode },
    { label: 'file url', body: { url: 'file:///C:/Windows/win.ini' }, accepts: urlCode },
    { label: 'unknown fetch field', body: { url: PAGE_URL, surprise: true }, accepts: unknownField },
  ];

  // Collect every mismatch so one run reports the whole validation surface, not just the first failure.
  const problems: string[] = [];
  const check = async (route: string, body: Record<string, unknown>, accepts: CodeExpectation, label: string) => {
    try {
      expectStructuredError(await env.request('POST', route, body), 400, accepts, label);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  };
  for (const family of ['/v1/web', '/v1/product/web']) {
    for (const item of queryCases) await check(family + '/search', item.body, item.accepts, family + ' search / ' + item.label);
    for (const item of urlCases) await check(family + '/fetch', item.body, item.accepts, family + ' fetch / ' + item.label);
  }
  for (const item of [
    { label: 'crawl maxPages above the limit', body: { url: PAGE_URL, maxPages: 6 } },
    { label: 'crawl maxDepth above the limit', body: { url: PAGE_URL, maxDepth: 3 } },
  ]) {
    await check('/v1/web/crawl', item.body, crawlCode, 'legacy crawl / ' + item.label);
  }
  await check('/v1/web/crawl', { url: PAGE_URL, surprise: true }, unknownField, 'legacy crawl / unknown crawl field');
  assert.deepEqual(problems, [], 'invalid browsing input must fail with a structured 400:\n' + problems.join('\n'));

  assert.equal(env.fixture.state.requests.length, 0, 'invalid browsing input must never reach the transport');
  assert.equal(env.fixture.state.unexpected.length, 0);
  assertNoBrowsingSideEffects(env, tasksBefore);
});

test('provider failures answer 502 with search attempts preserved on both families', { timeout: 60000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const tasksBefore = env.tasks();

  const configured = await env.request('POST', '/v1/config', { searchProvider: 'auto' });
  assert.equal(configured.status, 200, configured.text);
  assert.equal(configured.body.searchProvider, 'auto');
  env.fixture.state.mode = 'fail';

  const legacySearch = await env.request('POST', '/v1/web/search', { query: 'provider failure' });
  const legacyAttempts = expectStructuredError(legacySearch, 502, ['SEARCH_UNAVAILABLE'], 'legacy search failure');
  assertAutomaticSearchAttempts(legacyAttempts, 'legacy search');

  const productSearch = await env.request('POST', '/v1/product/web/search', { query: 'provider failure' });
  const productAttempts = expectStructuredError(productSearch, 502, ['SEARCH_UNAVAILABLE'], 'product search failure');
  assertAutomaticSearchAttempts(productAttempts, 'product search');

  const legacyPage = await env.request('POST', '/v1/web/fetch', { url: PAGE_URL });
  expectStructuredError(legacyPage, 502, ['HTTP_FAILED'], 'legacy page failure');
  const productPage = await env.request('POST', '/v1/product/web/fetch', { url: PAGE_URL });
  expectStructuredError(productPage, 502, ['HTTP_FAILED'], 'product page failure');

  assert.ok(env.fixture.state.requests.length > 0, 'the fixture transport must have been exercised');
  assertNoBrowsingSideEffects(env, tasksBefore);
});

test('saved web switches and unsupported proxies block both route families before the transport', { timeout: 60000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const tasksBefore = env.tasks();

  const searchOff = await env.request('POST', '/v1/config', { webSearch: false });
  assert.equal(searchOff.status, 200, searchOff.text);
  assert.equal(searchOff.body.webSearch, false);
  expectStructuredError(await env.request('POST', '/v1/web/search', { query: 'disabled' }), 409, ['NETWORK_DISABLED'], 'legacy search disabled');
  expectStructuredError(await env.request('POST', '/v1/product/web/search', { query: 'disabled' }), 409, ['NETWORK_DISABLED'], 'product search disabled');

  const fetchOff = await env.request('POST', '/v1/config', { fetch: false });
  assert.equal(fetchOff.status, 200, fetchOff.text);
  assert.equal(fetchOff.body.fetch, false);
  expectStructuredError(await env.request('POST', '/v1/web/fetch', { url: PAGE_URL }), 409, ['NETWORK_DISABLED'], 'legacy fetch disabled');
  expectStructuredError(await env.request('POST', '/v1/product/web/fetch', { url: PAGE_URL }), 409, ['NETWORK_DISABLED'], 'product fetch disabled');
  assert.equal(env.fixture.state.requests.length, 0, 'disabled switches must not reach the transport');

  const proxy = await env.request('POST', '/v1/config', { proxy: 'http://127.0.0.1:9' });
  expectStructuredError(proxy, 409, ['PROXY_UNSUPPORTED'], 'config unsupported proxy');
  assert.equal(env.fixture.state.requests.length, 0);
  assertNoBrowsingSideEffects(env, tasksBefore);

  // A proxy saved by an older version is a real stored boundary: both families must refuse it before
  // any socket work. (The settings route itself refuses to store a proxy, so seed the saved file.)
  const stored = await setup({ networkSettings: { searchProvider: 'mwmbl', proxy: 'http://127.0.0.1:9' } });
  t.after(() => stored.close());
  const storedTasks = stored.tasks();
  expectStructuredError(await stored.request('POST', '/v1/web/fetch', { url: PAGE_URL }), 409, ['PROXY_UNSUPPORTED'], 'legacy stored proxy');
  expectStructuredError(await stored.request('POST', '/v1/product/web/fetch', { url: PAGE_URL }), 409, ['PROXY_UNSUPPORTED'], 'product stored proxy');
  assert.equal(stored.fixture.state.requests.length, 0, 'a stored proxy must not reach the transport');
  assert.equal(stored.tasks(), storedTasks);
  assert.equal(stored.modelCalls(), 0);
});

test('aborting one client request cancels only its transport call and leaves the backend healthy', { timeout: 60000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const tasksBefore = env.tasks();

  const hangController = new AbortController();
  const hanging = fetch(env.base() + '/v1/web/fetch', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.backend.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: SLOW_URL }),
    signal: hangController.signal,
  }).then(
    async response => ({ responded: true as const, status: response.status, body: await response.json().catch(() => undefined) }),
    error => ({ responded: false as const, error }),
  );
  await until(() => env.fixture.state.hangStarted, 'the slow page transport to start');
  const hangSignal = env.fixture.state.hang?.signal;
  assert.ok(hangSignal, 'the transport must receive an abort signal');
  assert.equal(hangSignal.aborted, false);

  const healthy = await env.request('POST', '/v1/product/web/fetch', { url: PAGE_URL });
  assert.equal(healthy.status, 200, healthy.text);
  assert.equal(healthy.body.status, 200);
  assert.ok(healthy.body.text.includes(ARTICLE_TEXT), healthy.body.text);
  const healthySignal = env.fixture.state.pageRequests.find(request => request.url === PAGE_URL)?.signal;
  assert.ok(healthySignal, 'the healthy request must receive an abort signal');
  assert.equal(healthySignal.aborted, false);

  hangController.abort();
  await hanging;
  await until(() => hangSignal.aborted, 'the aborted client request to reach its transport');

  const health = await env.request('GET', '/health');
  assert.equal(health.status, 200, health.text);
  assert.equal(health.body.status, 'ready');

  const signals = [...new Set(env.fixture.state.requests.map(request => request.signal).filter((signal): signal is AbortSignal => Boolean(signal)))];
  assert.equal(signals.filter(signal => signal.aborted).length, 1, 'exactly the aborted request transport signal may abort');
  assert.equal(healthySignal.aborted, false, 'the concurrent healthy request must not be aborted');
  assertNoBrowsingSideEffects(env, tasksBefore);
});

test('backend shutdown cancels in-flight browsing without aborting completed requests', { timeout: 90000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  const tasksBefore = env.tasks();

  const normal = await env.request('POST', '/v1/web/fetch', { url: PAGE_URL });
  assert.equal(normal.status, 200, normal.text);
  const normalSignal = env.fixture.state.pageRequests.find(request => request.url === PAGE_URL)?.signal;
  assert.ok(normalSignal, 'the completed request must have received an abort signal');
  assert.equal(normalSignal.aborted, false, 'a completed page request must not be left aborted');
  assert.equal(env.tasks(), tasksBefore);
  assert.equal(env.modelCalls(), 0);

  const hangController = new AbortController();
  const hanging = fetch(env.base() + '/v1/product/web/fetch', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.backend.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: SLOW_URL }),
    signal: hangController.signal,
  }).then(
    async response => ({ responded: true as const, status: response.status, body: await response.json().catch(() => undefined) }),
    error => ({ responded: false as const, error }),
  );
  await until(() => env.fixture.state.hangStarted, 'the slow product page fetch to start');
  const hangSignal = env.fixture.state.hang?.signal;
  assert.ok(hangSignal, 'the in-flight transport must receive an abort signal');
  assert.equal(hangSignal.aborted, false);
  assert.equal(env.tasks(), tasksBefore, 'an in-flight browse must not create a kernel task');

  const closePromise = env.backend.close();
  let timedOut = false;
  try { await within(closePromise, 5000, 'backend.close'); } catch { timedOut = true; }
  if (timedOut) {
    hangController.abort();
    await within(closePromise.catch(() => undefined), 15000, 'backend.close after the client disconnected').catch(() => undefined);
  }
  await within(hanging, 5000, 'the in-flight client request to settle').catch(() => undefined);

  assert.equal(timedOut, false, 'backend.close must resolve within about five seconds while a browse is in flight');
  assert.equal(hangSignal.aborted, true, 'shutdown must abort the in-flight transport call');
  assert.equal(normalSignal.aborted, false, 'shutdown must not abort an already completed request');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(rejections, []);
});
