import assert from 'node:assert/strict';
import test from 'node:test';
import { WebClient, WebError, type DnsResolver } from '../src/network/index.js';

const publicDns: DnsResolver = async () => [{ address: '93.184.216.34', family: 4 }];
// First three entries captured from the public API on 2026-10-08; no invented search results.
// https://api.mwmbl.org/search/?s=SQLite (HTTP 200, unauthenticated)
const mwmblFixture = [
  { url: 'https://en.wikipedia.org/wiki/SQLite', title: [{ value: 'SQLite', is_bold: true }],
    extract: [{ value: 'SQLite', is_bold: true }, { value: ' (/ˌɛsˌkjuːˌɛlˈaɪt/ "S-Q-L-ite", /ˈsiːkwəˌlaɪt/ "sequel-ite") is a free and open-source relational database engine written in the C programming language', is_bold: false }], source: 'wikipedia' },
  { url: 'https://sqlitestudio.pl/', title: [{ value: 'SQLiteStudio', is_bold: false }], extract: [], source: 'user' },
  { url: 'http://sqlite.org/', title: [{ value: 'SQLite', is_bold: true }, { value: ' Home Page', is_bold: false }],
    extract: [{ value: 'The ', is_bold: false }, { value: 'SQLite', is_bold: true }, { value: ' file format is stable, cross-platform, and\nbackwards compatible and the developers pledge to keep it\nthat way through the year 2050. ', is_bold: false }, { value: 'SQLite', is_bold: true }, { value: ' dat…', is_bold: false }], source: 'user' },
];

const clientFor = (body: unknown) => new WebClient({ resolveDns: publicDns, fetch: async () => Response.json(body) });
const code = (expected: string) => (error: unknown) => error instanceof WebError && error.code === expected;

test('default general search parses the real Mwmbl wire and preserves indexed provenance', async () => {
  let requested: URL | undefined;
  const client = new WebClient({ resolveDns: publicDns, fetch: async input => {
    requested = new URL(String(input));
    return Response.json(mwmblFixture);
  } });
  const response = await client.search('  SQLite  ');
  assert.equal(requested?.href, 'https://api.mwmbl.org/search/?s=SQLite');
  assert.equal(response.scope, 'general-web');
  assert.equal(response.provider, 'Mwmbl general web search');
  assert.equal(response.query, 'SQLite');
  assert.equal(response.trust, 'untrusted');
  assert.deepEqual(response.results[1], { title: 'SQLiteStudio', url: 'https://sqlitestudio.pl/', snippet: '', source: 'mwmbl:user' });
  assert.equal(response.results[2].title, 'SQLite Home Page');
  assert.equal((response as unknown as { searchUrl: string }).searchUrl, requested?.href);
});

test('search discards private and credential links, deduplicates tracking variants, and caps accepted results', async () => {
  const row = (url: string) => ({ title: [{ value: 'Result', is_bold: false }], extract: [], url, source: 'mwmbl' });
  const response = await clientFor([
    row('http://127.0.0.1/'), row('https://example.org/?api_key=hidden'),
    row('https://example.org/page?utm_source=search#part'), row('https://example.org/page'),
    ...Array.from({ length: 20 }, (_, index) => row(`https://example.org/${index}`)),
  ]).search('query');
  assert.equal(response.results.length, 10);
  assert.equal(response.results[0].url, 'https://example.org/page');
  assert.equal(new Set(response.results.map(row => row.url)).size, response.results.length);
});

test('malformed provider payloads are protocol failures and never silently become encyclopedia results', async () => {
  for (const body of [null, {}, { results: [] }, '<html>Challenge</html>']) {
    await assert.rejects(clientFor(body).search('query'), code('SEARCH_PROTOCOL'));
  }
  assert.deepEqual((await clientFor([]).search('no indexed result')).results, []);
});

test('search skips malformed rows and does not stringify objects into source text', async () => {
  const response = await clientFor([
    null, 17, {}, { ...mwmblFixture[0], title: [{ value: {}, is_bold: false }] },
    { ...mwmblFixture[1], extract: [{ value: { secret: true } }], source: { engine: 'wrong' } },
  ]).search('query');
  assert.deepEqual(response.results, [{ title: 'SQLiteStudio', url: 'https://sqlitestudio.pl/', snippet: '', source: 'mwmbl' }]);
});

test('search has bounded input, cancellation and rate-limit errors without retrying another provider', async () => {
  let requests = 0;
  const client = new WebClient({ resolveDns: publicDns, fetch: async () => { requests++; return new Response('', { status: 429 }); } });
  for (const query of ['', '   ', 'x'.repeat(501)]) await assert.rejects(client.search(query), code('INVALID_QUERY'));
  assert.equal(requests, 0);
  await assert.rejects(client.search('query'), code('RATE_LIMITED'));
  assert.equal(requests, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.search('query', controller.signal), code('CANCELLED'));
  assert.equal(requests, 1);
});

test('semantic page extraction keeps article content and omits navigation, forms and hidden text', async () => {
  const client = new WebClient({ resolveDns: publicDns, fetch: async input => {
    if (new URL(String(input)).pathname === '/robots.txt') return new Response('', { status: 404 });
    return new Response('<html><head><title>Research</title></head><body><header>Site banner</header><nav><a href="/menus">Menu</a></nav><main><header><h1>Article heading</h1></header><p>Useful body &mdash; source.</p><aside>Ads</aside><form>Subscribe</form><div hidden>Hidden text</div><p aria-hidden="true">Duplicate</p><a href="/reference">Reference</a></main><footer>Footer</footer></body></html>', { headers: { 'content-type': 'text/html' } });
  } });
  const page = await client.fetchPage('https://example.org/article');
  assert.match(page.text, /Article heading/);
  assert.match(page.text, /Useful body — source/);
  assert.doesNotMatch(page.text, /Site banner|Menu|Ads|Subscribe|Hidden text|Duplicate|Footer/);
  assert.deepEqual(page.links, ['https://example.org/reference']);
});

test('crawl page budget counts requests rather than both redirect aliases', async () => {
  const requests: string[] = [];
  const client = new WebClient({ resolveDns: publicDns, fetch: async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
    if (url.pathname === '/start') return new Response('', { status: 302, headers: { location: '/article' } });
    return new Response('<main><a href="/article">Self</a><a href="/next#one">Next</a><a href="/next#two">Duplicate</a><a href="https://outside.example.org/">Outside</a></main>', { headers: { 'content-type': 'text/html' } });
  } });
  const result = await client.crawl('https://example.org/start', { maxPages: 2, maxDepth: 1 });
  assert.deepEqual(result.pages.map(page => page.url), ['https://example.org/article', 'https://example.org/next']);
  assert.deepEqual(result.errors, []);
  assert.equal(requests.filter(url => url === '/next').length, 1);
});

test('anti-bot challenge markup is reported as blocked instead of source evidence', async () => {
  const client = new WebClient({ resolveDns: publicDns, fetch: async input => new URL(String(input)).pathname === '/robots.txt'
    ? new Response('', { status: 404 })
    : new Response('<form id="challenge-form" action="/anomaly.js"><p>Please complete the following challenge to confirm this search was made by a human.</p></form>', { headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(client.fetchPage('https://example.org/'), code('ACCESS_BLOCKED'));
});
