import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { WebClient, WebError, WebSearchError, searchConfigurationScope, withinSearchScope, type DnsResolver } from '../src/network/index.js';
import { publicRequest } from '../src/network/public-transport.js';

const publicDns: DnsResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const code = (expected: string) => (error: unknown) => error instanceof WebError && error.code === expected;

interface Observed { url: string; method: string; body?: string }
function fetchFrom(fixture: (request: Observed) => Response | Promise<Response>): { requests: Observed[]; fetch: typeof fetch } {
  const requests: Observed[] = [];
  const impl: typeof fetch = async (input, init) => {
    const request: Observed = { url: String(input), method: (init?.method ?? 'GET').toUpperCase() };
    if (typeof init?.body === 'string') request.body = init.body;
    requests.push(request);
    return fixture(request);
  };
  return { requests, fetch: impl };
}

interface ExaOptions { text?: string; wrongId?: boolean; status?: number; sse?: boolean; corrupt?: boolean; redirect?: string }
// Anonymous Exa MCP fixtures follow the reviewed protocol only: initialize, initialized notification,
// then one tools/call. No fixture returns invented success for a malformed exchange.
function exaServer(options: ExaOptions = {}): (request: Observed) => Response {
  const text = options.text ?? [
    'Title: TypeScript: JavaScript With Syntax For Types.',
    'URL: https://www.typescriptlang.org/',
    'Published: N/A',
    'Author: N/A',
    'Highlights:',
    'TypeScript extends JavaScript by adding types.',
    '---',
    'Title: 故宫博物院',
    'URL: https://www.dpm.org.cn/',
    'Published: N/A',
    'Author: N/A',
    'Highlights:',
    '故宫博物院官方网站。',
  ].join('\n');
  return request => {
    assert.ok(request.url.startsWith('https://mcp.exa.ai/mcp'), request.url);
    if (options.redirect) return new Response(null, { status: 302, headers: { location: options.redirect } });
    const message = request.body === undefined ? {} : JSON.parse(request.body) as { id?: number | string; method?: string };
    if (message.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }), { headers: { 'content-type': 'application/json' } });
    }
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(message.method, 'tools/call');
    if (options.status) return new Response('busy', { status: options.status });
    const id = options.wrongId ? Number(message.id ?? 0) + 1 : message.id;
    if (options.corrupt) {
      const body = new TextEncoder().encode('event: message\ndata: {"jsonrpc":"2.0","id":NOT-JSON}\n\n');
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(body); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
    if (!options.sse) return new Response(payload, { headers: { 'content-type': 'application/json' } });
    const bytes = new TextEncoder().encode(`event: message\ndata: ${payload}\n\n`);
    const split = Math.floor(bytes.length / 2);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
}

const mwmblRows = [{ url: 'https://www.typescriptlang.org/', title: [{ value: 'TypeScript', is_bold: false }], extract: [{ value: 'Typed JavaScript.', is_bold: false }], source: 'mwmbl' }];

/** Routes the two automatic free sources; anything else is a scope violation. */
function autoFetch(exa: (request: Observed) => Response | Promise<Response>, mwmbl: () => Response | Promise<Response> = () => Response.json([])) {
  return fetchFrom(request => request.url.startsWith('https://api.mwmbl.org/') ? mwmbl() : exa(request));
}

test('search scope is deterministic and lists every destination before any request', async () => {
  const scope = searchConfigurationScope({ searchProvider: 'auto' });
  assert.deepEqual(scope.providers, ['exa', 'mwmbl']);
  assert.deepEqual(scope.endpoints, ['https://mcp.exa.ai/mcp', 'https://api.mwmbl.org/search/']);
  assert.deepEqual(scope.origins, ['https://mcp.exa.ai', 'https://api.mwmbl.org']);
  assert.deepEqual(searchConfigurationScope({ searchProvider: 'auto' }), scope, 'scope must not depend on call order or time');
  assert.equal(scope.origins.includes('https://en.wikipedia.org'), false, 'encyclopedia stays a separate explicit source');
  assert.deepEqual(searchConfigurationScope({ searchProvider: 'wikipedia' }).origins, ['https://en.wikipedia.org']);
  assert.deepEqual(searchConfigurationScope({ searchProvider: 'bing-rss' }).origins, ['https://www.bing.com']);
  assert.deepEqual(searchConfigurationScope({ searchProvider: 'searxng', searxUrl: 'https://search.example.org' }), {
    providers: ['searxng'], endpoints: ['https://search.example.org/search'], origins: ['https://search.example.org'],
  });
  assert.throws(() => searchConfigurationScope({ searchProvider: 'unknown' as never }), code('SEARCH_CONFIGURATION'));
  assert.throws(() => searchConfigurationScope({ searchProvider: 'searxng' }), code('SEARCH_CONFIGURATION'));
});

test('automatic search falls back to Mwmbl when the free Exa endpoint has no rows', async () => {
  const fake = autoFetch(exaServer({ text: '   ' }) as (request: Observed) => Response, () => Response.json(mwmblRows));
  const client = new WebClient({ searchProvider: 'auto', resolveDns: publicDns, fetch: fake.fetch });
  const response = await client.search('TypeScript 官方文档');
  assert.equal(response.provider, 'Mwmbl general web search');
  assert.equal(response.scope, 'general-web');
  assert.deepEqual(response.results.map(row => row.url), ['https://www.typescriptlang.org/']);
  assert.deepEqual(response.attempts.map(attempt => [attempt.provider, attempt.status]), [['exa', 'empty'], ['mwmbl', 'results']]);
  assert.equal(response.attempts[0].results, 0);
  const scope = searchConfigurationScope({ searchProvider: 'auto' });
  for (const request of fake.requests) assert.ok(scope.origins.includes(new URL(request.url).origin), request.url);
  const hosts = [...new Set(fake.requests.map(request => new URL(request.url).origin))];
  assert.deepEqual(hosts.sort(), [...scope.origins].sort(), 'scope list and actual request origins must match');
  assert.deepEqual(fake.requests.filter(request => request.url.startsWith('https://api.mwmbl.org/')).map(request => request.method), ['GET']);
});

test('automatic search starts with Exa and stops once it returns rows', async () => {
  const fake = autoFetch(exaServer() as (request: Observed) => Response, () => Response.json(mwmblRows));
  const response = await new WebClient({ searchProvider: 'auto', resolveDns: publicDns, fetch: fake.fetch }).search('TypeScript');
  assert.equal(response.provider, 'Exa free anonymous web search');
  assert.equal(response.attempts.length, 1);
  assert.equal(response.attempts[0].provider, 'exa');
  assert.equal(fake.requests.length, 3, 'initialize, initialized and one tools/call only');
  assert.ok(fake.requests.every(request => request.url.startsWith('https://mcp.exa.ai/mcp')));
});

test('explicit sources never fall back to another provider', async () => {
  const mwmbl = fetchFrom(() => new Response('', { status: 429 }));
  const mwmblError = await new WebClient({ searchProvider: 'mwmbl', resolveDns: publicDns, fetch: mwmbl.fetch }).search('query').then(() => undefined, error => error);
  assert.ok(mwmblError instanceof WebError && mwmblError.code === 'RATE_LIMITED');
  assert.equal(mwmbl.requests.length, 1);
  const wikipedia = fetchFrom(() => new Response('', { status: 429 }));
  const wikipediaError = await new WebClient({ searchProvider: 'wikipedia', resolveDns: publicDns, fetch: wikipedia.fetch }).search('query').then(() => undefined, error => error);
  assert.ok(wikipediaError instanceof WebError && wikipediaError.code === 'RATE_LIMITED');
  assert.deepEqual([...new Set(wikipedia.requests.map(request => new URL(request.url).origin))], ['https://en.wikipedia.org']);
  const exa = fetchFrom(exaServer({ status: 429 }));
  const exaError = await new WebClient({ searchProvider: 'exa', resolveDns: publicDns, fetch: exa.fetch }).search('query').then(() => undefined, error => error);
  assert.ok(exaError instanceof WebError && exaError.code === 'RATE_LIMITED', String(exaError));
  assert.deepEqual([...new Set(exa.requests.map(request => new URL(request.url).origin))], ['https://mcp.exa.ai']);
});

test('a failed automatic chain reports every attempt instead of a fake empty result', async () => {
  const fake = autoFetch(exaServer({ status: 503 }), () => new Response('', { status: 500 }));
  const error = await new WebClient({ searchProvider: 'auto', resolveDns: publicDns, fetch: fake.fetch }).search('query').then(() => undefined, failure => failure);
  assert.ok(error instanceof WebSearchError, String(error));
  assert.equal(error.code, 'SEARCH_UNAVAILABLE');
  assert.deepEqual(error.attempts.map(attempt => [attempt.provider, attempt.status, attempt.errorCode]), [
    ['exa', 'error', 'HTTP_FAILED'],
    ['mwmbl', 'error', 'HTTP_FAILED'],
  ]);
  assert.ok(error.attempts.every(attempt => attempt.durationMs >= 0 && attempt.endpoint.length > 0 && attempt.label.length > 0));
});

test('only empty results across the chain become a no-result response', async () => {
  const fake = autoFetch(exaServer({ text: '   ' }) as (request: Observed) => Response);
  const response = await new WebClient({ searchProvider: 'auto', resolveDns: publicDns, fetch: fake.fetch }).search('query');
  assert.equal(response.results.length, 0);
  assert.equal(response.provider, 'Free web search (no results)');
  assert.deepEqual(response.attempts.map(attempt => attempt.status), ['empty', 'empty']);
});

test('malformed JSON-RPC ids and SSE frames are source failures, never results', async () => {
  const wrong = autoFetch(exaServer({ wrongId: true }) as (request: Observed) => Response);
  const wrongError = await new WebClient({ searchProvider: 'auto', resolveDns: publicDns, fetch: wrong.fetch }).search('query').then(() => undefined, failure => failure);
  assert.ok(wrongError instanceof WebSearchError);
  assert.equal(wrongError.attempts[0].provider, 'exa');
  assert.equal(wrongError.attempts[0].errorCode, 'SEARCH_PROTOCOL');
  const corrupt = fetchFrom(exaServer({ corrupt: true }));
  await assert.rejects(new WebClient({ searchProvider: 'exa', resolveDns: publicDns, fetch: corrupt.fetch }).search('query'), code('SEARCH_PROTOCOL'));
  const explicitSse = fetchFrom(exaServer({ sse: true }));
  const sse = await new WebClient({ searchProvider: 'exa', resolveDns: publicDns, fetch: explicitSse.fetch }).search('query');
  assert.equal(sse.results[0].url, 'https://www.typescriptlang.org/', 'split SSE frames must still decode');
});

test('oversized search payloads are refused and the chain may try the next source', async () => {
  const oversized = () => new Response(new Uint8Array(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(new WebClient({ searchProvider: 'mwmbl', resolveDns: publicDns, fetch: async () => oversized() }).search('query'), code('BODY_LIMIT'));
  const fake = autoFetch(oversized as unknown as (request: Observed) => Response, () => Response.json(mwmblRows));
  const response = await new WebClient({ searchProvider: 'auto', resolveDns: publicDns, fetch: fake.fetch }).search('query');
  assert.equal(response.provider, 'Mwmbl general web search');
  assert.deepEqual(response.attempts.map(attempt => [attempt.provider, attempt.errorCode ?? attempt.status]), [['exa', 'BODY_LIMIT'], ['mwmbl', 'results']]);
});

test('private DNS blocks search before a socket is opened', async () => {
  const privateResolver: DnsResolver = async hostname => [{ address: hostname === 'mcp.exa.ai' ? '10.0.0.1' : '93.184.216.34', family: 4 }];
  const fake = autoFetch(exaServer() as (request: Observed) => Response, () => Response.json(mwmblRows));
  const response = await new WebClient({ searchProvider: 'auto', resolveDns: privateResolver, fetch: fake.fetch }).search('query');
  assert.equal(response.provider, 'Mwmbl general web search');
  assert.deepEqual(response.attempts.map(attempt => [attempt.provider, attempt.errorCode ?? attempt.status]), [['exa', 'DNS_BLOCKED'], ['mwmbl', 'results']]);
  assert.equal(fake.requests.some(request => request.url.startsWith('https://mcp.exa.ai')), false);
  const blocked = fetchFrom(() => Response.json([]));
  await assert.rejects(new WebClient({ searchProvider: 'mwmbl', resolveDns: async () => [{ address: '192.168.1.1', family: 4 }], fetch: blocked.fetch }).search('query'), code('DNS_BLOCKED'));
  assert.equal(blocked.requests.length, 0);
});

test('search redirects leave the prepared scope instead of following', async () => {
  const fake = fetchFrom(exaServer({ redirect: 'https://evil.example.org/mcp' }));
  await assert.rejects(new WebClient({ searchProvider: 'exa', resolveDns: publicDns, fetch: fake.fetch }).search('query'), code('SEARCH_SCOPE'));
  assert.equal(fake.requests.length, 1);
});

test('cancellation before and during an automatic search stops without another source', async () => {
  const pre = new AbortController();
  pre.abort();
  const none = fetchFrom(() => Response.json([]));
  await assert.rejects(new WebClient({ searchProvider: 'auto', resolveDns: publicDns, fetch: none.fetch }).search('query', pre.signal), code('CANCELLED'));
  assert.equal(none.requests.length, 0);
  const mid = new AbortController();
  const fake = autoFetch(() => new Response('unused', { status: 500 }));
  const aborting: typeof fetch = async (input, init) => { mid.abort(); return fake.fetch(input, init); };
  await assert.rejects(new WebClient({ searchProvider: 'auto', resolveDns: publicDns, fetch: aborting }).search('query', mid.signal), code('CANCELLED'));
  assert.equal(fake.requests.length, 1, 'no second source is contacted after cancellation');
});

test('per-source budget expires while the overall deadline keeps the next source available', async () => {
  const fake = autoFetch(() => new Promise<Response>(() => {}), () => Response.json(mwmblRows));
  const client = new WebClient({ searchProvider: 'auto', timeoutMs: 5000, searchAttemptMs: 100, resolveDns: publicDns, fetch: fake.fetch });
  const response = await client.search('TypeScript');
  assert.equal(response.provider, 'Mwmbl general web search');
  assert.deepEqual(response.attempts.map(attempt => [attempt.provider, attempt.errorCode ?? attempt.status]), [['exa', 'TIMEOUT'], ['mwmbl', 'results']]);
});

test('the entire automatic search obeys one overall deadline', async () => {
  const client = new WebClient({ searchProvider: 'auto', timeoutMs: 40, searchAttemptMs: 1000, resolveDns: publicDns, fetch: () => new Promise<Response>(() => {}) });
  await assert.rejects(client.search('query'), code('TIMEOUT'));
});

test('concurrent operations on one client are bounded', async () => {
  const controller = new AbortController();
  const client = new WebClient({ maxConcurrent: 1, timeoutMs: 2000, resolveDns: publicDns, fetch: () => new Promise<Response>(() => {}) });
  const first = client.fetchPage('https://www.example.org/', controller.signal);
  await assert.rejects(client.fetchPage('https://www.example.org/other'), code('CONCURRENCY_LIMIT'));
  controller.abort();
  await assert.rejects(first, code('CANCELLED'));
});

test('robots policy cache stays bounded across many hosts', async () => {
  const client = new WebClient({ robotsLimit: 2, resolveDns: publicDns, fetch: async input => new URL(String(input)).pathname === '/robots.txt'
    ? new Response('', { status: 404 })
    : new Response('missing', { status: 404 }) });
  for (const host of ['a.example.org', 'b.example.org', 'c.example.org']) await assert.rejects(client.fetchPage(`https://${host}/`), code('HTTP_FAILED'));
  assert.equal(client.robotsCacheEntries(), 2);
});

function pageFetch(routes: Record<string, () => Response>): typeof fetch {
  return async input => {
    const url = new URL(String(input));
    if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
    const route = routes[url.pathname];
    return route ? route() : new Response('missing', { status: 404 });
  };
}

test('GBK page bytes are decoded instead of replaced', async () => {
  const encoder = new TextEncoder();
  const page = new Uint8Array([
    ...encoder.encode('<html><head><title>'),
    0xb9, 0xca, 0xb9, 0xac, // 故宫
    ...encoder.encode('</title></head><body><main><p>'),
    0xb2, 0xa9, 0xce, 0xef, 0xd4, 0xba, // 博物院
    ...encoder.encode('</p></main></body></html>'),
  ]);
  const client = new WebClient({ resolveDns: publicDns, fetch: pageFetch({ '/': () => new Response(page, { headers: { 'content-type': 'text/html; charset=gbk' } }) }) });
  const result = await client.fetchPage('https://www.example.org/');
  assert.equal(result.title, '故宫');
  assert.match(result.text, /博物院/);
});

test('empty and script-only pages are reported instead of an empty success', async () => {
  const empty = new WebClient({ resolveDns: publicDns, fetch: pageFetch({ '/': () => new Response('', { headers: { 'content-type': 'text/html' } }) }) });
  await assert.rejects(empty.fetchPage('https://www.example.org/'), code('PAGE_EMPTY'));
  const shell = new WebClient({ resolveDns: publicDns, fetch: pageFetch({ '/': () => new Response('<html><body><div id="root"></div><script src="/app.js"></script></body></html>', { headers: { 'content-type': 'text/html' } }) }) });
  await assert.rejects(shell.fetchPage('https://www.example.org/'), code('PAGE_RENDERING_REQUIRED'));
});

test('pinned transport sends a fixed POST body while retaining the public Host header', async t => {
  let observed = { host: '', method: '', body: '' };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      observed = { host: request.headers.host ?? '', method: request.method ?? '', body };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  const response = await publicRequest(new URL(`http://fixture.example.org:${address.port}/mcp`), { address: '127.0.0.1', family: 4 }, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1}',
  }, AbortSignal.timeout(2000));
  assert.equal(response.status, 200);
  assert.equal(observed.method, 'POST');
  assert.equal(observed.host, `fixture.example.org:${address.port}`);
  assert.equal(observed.body, '{"jsonrpc":"2.0","id":1}');
});

test('the prepared scope accepts only declared origin and path pairs', () => {
  const scope = searchConfigurationScope({ searchProvider: 'auto' });
  assert.equal(withinSearchScope(scope, new URL('https://mcp.exa.ai/mcp')), true);
  assert.equal(withinSearchScope(scope, new URL('https://api.mwmbl.org/search/?s=query')), true);
  assert.equal(withinSearchScope(scope, new URL('https://mcp.exa.ai/arbitrary-tool')), false);
  assert.equal(withinSearchScope(scope, new URL('https://api.mwmbl.org/admin')), false);
  assert.equal(withinSearchScope(scope, new URL('https://mcp.exa.ai/mcp#fragment')), false);
  assert.equal(withinSearchScope(scope, new URL('https://TEST_ONLY_USER:TEST_ONLY_PASSWORD@mcp.exa.ai/mcp')), false);
  assert.equal(withinSearchScope(scope, new URL('https://example.org/mcp')), false);
});

test('an overall deadline keeps completed and interrupted attempt provenance', async () => {
  const fake = autoFetch(exaServer({ text: '   ' }) as (request: Observed) => Response, () => new Promise<Response>(() => {}));
  const client = new WebClient({ searchProvider: 'auto', resolveDns: publicDns, fetch: fake.fetch, timeoutMs: 60, searchAttemptMs: 500 });
  const error = await client.search('TypeScript').then(() => null, (failure: unknown) => failure);
  assert.ok(error instanceof WebSearchError, String(error));
  assert.equal(error.code, 'TIMEOUT');
  assert.deepEqual(error.attempts.map(attempt => [attempt.provider, attempt.status, attempt.errorCode]), [
    ['exa', 'empty', undefined],
    ['mwmbl', 'error', 'TIMEOUT'],
  ]);
});

test('caller cancellation keeps interrupted provenance and stops the chain', async () => {
  const controller = new AbortController();
  const fake = fetchFrom(() => { controller.abort(); return Response.json([]); });
  const client = new WebClient({ searchProvider: 'auto', resolveDns: publicDns, fetch: fake.fetch });
  const error = await client.search('SQLite', controller.signal).then(() => null, (failure: unknown) => failure);
  assert.ok(error instanceof WebSearchError, String(error));
  assert.equal(error.code, 'CANCELLED');
  assert.equal(error.attempts.length, 1);
  assert.equal(error.attempts[0].provider, 'exa');
  assert.equal(error.attempts[0].status, 'error');
  assert.equal(error.attempts[0].errorCode, 'CANCELLED');
  assert.equal(fake.requests.length, 1, 'no second source is contacted after cancellation');
});

test('an explicit source keeps its failure and stated provenance without falling back', async () => {
  const fake = fetchFrom(() => new Response('busy', { status: 429 }));
  const error = await new WebClient({ searchProvider: 'mwmbl', resolveDns: publicDns, fetch: fake.fetch }).search('SQLite').then(() => null, (failure: unknown) => failure);
  assert.ok(error instanceof WebSearchError, String(error));
  assert.equal(error.code, 'RATE_LIMITED');
  assert.deepEqual(error.attempts.map(attempt => [attempt.provider, attempt.status, attempt.errorCode]), [['mwmbl', 'error', 'RATE_LIMITED']]);
  assert.equal(fake.requests.length, 1);
});
