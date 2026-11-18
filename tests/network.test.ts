import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { WebClient, WebError, isPublicAddress, parsePublicUrl, type DnsResolver } from '../src/network/index.js';
import { publicGet } from '../src/network/public-transport.js';

const publicDns: DnsResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
function fixtures(routes: Record<string, () => Response>, requests: string[] = []): typeof fetch {
  return async input => {
    const url = new URL(String(input));
    requests.push(url.href);
    const route = routes[url.pathname];
    return route ? route() : new Response('not found', { status: 404 });
  };
}
function errorCode(code: string): (error: unknown) => boolean {
  return error => error instanceof WebError && error.code === code;
}

test('explicit Wikipedia search is labeled encyclopedia and uses MediaWiki documented wire', async () => {
  let requested: URL | undefined;
  const client = new WebClient({ searchProvider: 'wikipedia', resolveDns: publicDns, fetch: async input => {
    requested = new URL(String(input));
    return Response.json({ query: { search: [{ title: 'Node.js', snippet: 'A <span>JavaScript</span> runtime.' }] } });
  } });
  const result = await client.search('Node.js');
  assert.equal(requested?.origin, 'https://en.wikipedia.org');
  assert.equal(requested?.pathname, '/w/api.php');
  assert.equal(requested?.searchParams.get('action'), 'query');
  assert.equal(requested?.searchParams.get('list'), 'search');
  assert.equal(requested?.searchParams.get('srsearch'), 'Node.js');
  assert.equal(result.scope, 'encyclopedia');
  assert.equal(result.provider, 'Wikipedia encyclopedia search');
  assert.equal(result.results[0].snippet, 'A JavaScript runtime.');
  assert.equal(result.results[0].url, 'https://en.wikipedia.org/wiki/Node.js');
  assert.equal(result.trust, 'untrusted');
});

test('SearXNG requires configuration and requests JSON without an API key', async () => {
  assert.throws(() => new WebClient({ searchProvider: 'searxng' }), errorCode('SEARCH_CONFIGURATION'));
  let requested: URL | undefined;
  const client = new WebClient({ searchProvider: 'searxng', searxUrl: 'https://search.example.org', resolveDns: publicDns, fetch: async input => {
    requested = new URL(String(input));
    return Response.json({ results: [{ title: 'Primary source', url: 'https://www.example.org/article', content: 'Verified <b>source</b>.' }] });
  } });
  const result = await client.search('research');
  assert.equal(requested?.pathname, '/search');
  assert.equal(requested?.searchParams.get('format'), 'json');
  assert.equal(requested?.searchParams.get('q'), 'research');
  assert.equal(result.scope, 'general-web');
  assert.equal(result.results[0].snippet, 'Verified source.');
});

test('URL and DNS checks reject private targets before any request', async () => {
  for (const url of ['http://localhost/', 'http://127.0.0.1/', 'https://[::1]/', 'http://2130706433/', 'https://TEST_ONLY_USER:TEST_ONLY_PASSWORD@example.org/', 'file:///file', 'http://server.local/']) {
    assert.throws(() => parsePublicUrl(url), errorCode('URL_BLOCKED'));
  }
  for (const address of ['10.1.2.3', '172.16.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.1', '127.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:0db8::1', '2001::1', '2002:a01:203::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('93.184.216.34'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  let requests = 0;
  const client = new WebClient({ resolveDns: async () => [{ address: '192.168.1.1', family: 4 }], fetch: async () => { requests++; return html('unsafe'); } });
  await assert.rejects(client.fetchPage('https://private.example.org'), errorCode('DNS_BLOCKED'));
  assert.equal(requests, 0);
});

test('redirects revalidate public target and do not escape approved origin', async () => {
  const requests: string[] = [];
  const client = new WebClient({ resolveDns: publicDns, fetch: fixtures({
    '/': () => html('', 302, { location: 'http://127.0.0.1/private' }),
  }, requests) });
  await assert.rejects(client.fetchPage('https://www.example.org/'), errorCode('URL_BLOCKED'));
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => url.startsWith('https://www.example.org/')));
  const other = new WebClient({ resolveDns: publicDns, fetch: fixtures({ '/': () => html('', 302, { location: 'https://other.example.org/' }) }) });
  await assert.rejects(other.fetchPage('https://www.example.org/'), errorCode('REDIRECT_SCOPE'));
});

test('robots deny, longest allow and redirect target checks happen before page requests', async () => {
  const requests: string[] = [];
  const client = new WebClient({ resolveDns: publicDns, fetch: fixtures({
    '/robots.txt': () => new Response('User-agent: *\nDisallow: /private\nAllow: /private/public$\n', { headers: { 'content-type': 'text/plain' } }),
    '/private/public': () => html('<title>Public</title><p>Allowed</p>'),
    '/start': () => html('', 302, { location: '/private/secret' }),
  }, requests) });
  await assert.rejects(client.fetchPage('https://www.example.org/private/secret'), errorCode('ROBOTS_DENIED'));
  assert.equal(requests.length, 1);
  assert.equal((await client.fetchPage('https://www.example.org/private/public')).text, 'Allowed');
  await assert.rejects(client.fetchPage('https://www.example.org/start'), errorCode('ROBOTS_DENIED'));
  assert.equal(requests.filter(url => url.includes('secret')).length, 0);
});

test('DNS is checked for every network request, including after robots retrieval', async () => {
  let resolutions = 0;
  const requests: string[] = [];
  const client = new WebClient({ resolveDns: async () => [{ address: ++resolutions === 1 ? '93.184.216.34' : '10.0.0.1', family: 4 }], fetch: fixtures({}, requests) });
  await assert.rejects(client.fetchPage('https://www.example.org/'), errorCode('DNS_BLOCKED'));
  assert.equal(requests.length, 1);
});

test('page extraction includes provenance, excludes scripts and deduplicates same-origin links', async () => {
  const client = new WebClient({ resolveDns: publicDns, fetch: fixtures({
    '/': () => html('<html><head><title>Research &amp; notes</title></head><body><script>steal()</script><h1>Evidence</h1><p>A &lt; B.</p><a href="/next#one">Next</a><a href="/next#two">Again</a><a href="https://elsewhere.example.org/">External</a></body></html>'),
  }) });
  const page = await client.fetchPage('https://www.example.org/');
  assert.equal(page.title, 'Research & notes');
  assert.match(page.text, /Evidence/);
  assert.match(page.text, /A < B\./);
  assert.doesNotMatch(page.text, /steal|Research/);
  assert.deepEqual(page.links, ['https://www.example.org/next']);
  assert.equal(page.url, 'https://www.example.org/');
  assert.ok(Date.parse(page.fetchedAt));
  assert.equal(page.trust, 'untrusted');
});

test('crawl respects depth, page limits, duplicate links and robots failures', async () => {
  const requests: string[] = [];
  const client = new WebClient({ resolveDns: publicDns, fetch: fixtures({
    '/robots.txt': () => new Response('User-agent: *\nDisallow: /blocked'),
    '/': () => html('<a href="/one">One</a><a href="/one#same">Dup</a><a href="/blocked">Blocked</a><a href="/two">Two</a>'),
    '/one': () => html('<a href="/three">Three</a>'),
    '/two': () => html('<a href="/four">Four</a>'),
    '/three': () => html('<a href="/deep">Deep</a>'),
    '/four': () => html('Fourth'),
  }, requests) });
  const result = await client.crawl('https://www.example.org/', { maxPages: 5, maxDepth: 2 });
  assert.equal(result.pages.length, 4);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'ROBOTS_DENIED');
  assert.equal(requests.filter(url => url.endsWith('/one')).length, 1);
  assert.equal(requests.filter(url => url.endsWith('/deep') || url.endsWith('/blocked')).length, 0);
  await assert.rejects(client.crawl('https://www.example.org/', { maxPages: 6 }), errorCode('CRAWL_LIMIT'));
  await assert.rejects(client.crawl('https://www.example.org/', { maxDepth: 3 }), errorCode('CRAWL_LIMIT'));
});

test('login, subscription, HTTP restrictions and inaccessible robots stop without bypass', async () => {
  for (const body of ['<input type="password">', '<p>Subscribe to continue</p>', '<p>Verify you are human</p>']) {
    const client = new WebClient({ resolveDns: publicDns, fetch: fixtures({ '/': () => html(body) }) });
    await assert.rejects(client.fetchPage('https://www.example.org/'), errorCode('ACCESS_BLOCKED'));
  }
  const denied = new WebClient({ resolveDns: publicDns, fetch: fixtures({ '/': () => html('denied', 403) }) });
  await assert.rejects(denied.fetchPage('https://www.example.org/'), errorCode('ACCESS_BLOCKED'));
  const robotsDown = new WebClient({ resolveDns: publicDns, fetch: fixtures({ '/robots.txt': () => new Response('down', { status: 503 }) }) });
  await assert.rejects(robotsDown.fetchPage('https://www.example.org/'), errorCode('ROBOTS_UNAVAILABLE'));
});

test('timeout and cancellation terminate pending DNS or fetch work', async () => {
  const timeout = new WebClient({ timeoutMs: 10, resolveDns: () => new Promise(() => {}), fetch: async () => html('never') });
  await assert.rejects(timeout.fetchPage('https://www.example.org/'), errorCode('TIMEOUT'));
  const controller = new AbortController();
  const cancelled = new WebClient({ resolveDns: publicDns, fetch: () => new Promise(() => {}) });
  const pending = cancelled.fetchPage('https://www.example.org/', controller.signal);
  controller.abort();
  await assert.rejects(pending, errorCode('CANCELLED'));
});

test('download size and binary content are bounded before extraction', async () => {
  const oversized = new WebClient({ resolveDns: publicDns, fetch: fixtures({ '/': () => html('large', 200, { 'content-length': String(2 * 1024 * 1024) }) }) });
  await assert.rejects(oversized.fetchPage('https://www.example.org/'), errorCode('BODY_LIMIT'));
  const binary = new WebClient({ resolveDns: publicDns, fetch: fixtures({ '/': () => new Response('binary', { headers: { 'content-type': 'application/octet-stream' } }) }) });
  await assert.rejects(binary.fetchPage('https://www.example.org/'), errorCode('CONTENT_TYPE'));
});

test('missing robots response body is cancelled before public page request', async () => {
  let cancelled = false;
  const client = new WebClient({ resolveDns: publicDns, fetch: async input => {
    if (new URL(String(input)).pathname === '/robots.txt') return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 404 });
    assert.equal(cancelled, true);
    return html('<p>Page</p>');
  } });
  assert.equal((await client.fetchPage('https://www.example.org/')).text, 'Page');
});

test('native transport connects to its pinned fixture address and retains public Host header', async t => {
  let observedHost = '';
  const server = createServer((request, response) => {
    observedHost = request.headers.host ?? '';
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('pinned-fixture');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  // This internal transport fixture does not call the production URL admission path.
  const response = await publicGet(new URL(`http://fixture.example.org:${address.port}/`), { address: '127.0.0.1', family: 4 }, AbortSignal.timeout(2000));
  assert.equal(await response.text(), 'pinned-fixture');
  assert.equal(observedHost, `fixture.example.org:${address.port}`);
});
