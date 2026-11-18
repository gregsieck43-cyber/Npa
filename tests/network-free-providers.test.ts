import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BING_RSS_ENDPOINT, EXA_ENDPOINT, FREE_PROVIDERS, bingRssProvider, exaFreeProvider,
  type ProviderRequest, type ProviderTransport,
} from '../src/network/free-search-providers.js';
import { WebError } from '../src/network/url-policy.js';

const EXA_LABEL = 'Exa free anonymous web search';
const BING_LABEL = 'Bing public RSS search';

function signal(): AbortSignal { return new AbortController().signal; }

async function rejectedWith(promise: Promise<unknown>, expected: string, label = ''): Promise<WebError> {
  const prefix = label ? label + ': ' : '';
  try { await promise; }
  catch (error) {
    if (!(error instanceof WebError)) assert.fail(prefix + 'expected a WebError, received ' + String(error));
    assert.equal(error.code, expected, prefix + 'error code');
    return error;
  }
  assert.fail(prefix + 'expected ' + expected + ' but the search resolved');
}

function textResponse(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
}
function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return textResponse(typeof value === 'string' ? value : JSON.stringify(value), status, { 'content-type': 'application/json', ...headers });
}
/** Each string is served as its own byte chunk; an open body keeps the next read pending. */
function sseResponse(chunks: string[], open = false, headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!open) controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}
function fixedTransport(make: () => Response, requests: ProviderRequest[] = []): ProviderTransport {
  return async request => { requests.push(request); return make(); };
}

const EXA_TEXT = [
  'Title: Palace Museum',
  'URL: https://www.dpm.org.cn/',
  'Published: N/A',
  'Author: N/A',
  'Highlights:',
  'The <b>Palace</b>  Museum',
  'is open.',
  '',
  '---',
  '',
  'Title: 导览 - 故宫博物院',
  'URL: https://www.dpm.org.cn/Visit.html',
  'Highlights:',
  'Tickets and routes.',
].join('\n');
const EXA_RESULTS = [
  { title: 'Palace Museum', url: 'https://www.dpm.org.cn/', snippet: 'The Palace Museum is open.', source: 'exa' },
  { title: '导览 - 故宫博物院', url: 'https://www.dpm.org.cn/Visit.html', snippet: 'Tickets and routes.', source: 'exa' },
];
const EXA_SEARCH_RESULT = { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: EXA_TEXT }] } };

interface ExaSteps {
  initialize?: () => Response;
  notification?: () => Response;
  search?: () => Response;
}
function exaTransport(steps: ExaSteps = {}, requests: ProviderRequest[] = []): ProviderTransport {
  return async request => {
    requests.push(request);
    const message = JSON.parse(request.body ?? '{}') as { method?: string };
    if (message.method === 'initialize') {
      return steps.initialize ? steps.initialize()
        : jsonResponse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'exa-mcp' } } });
    }
    if (message.method === 'notifications/initialized') return steps.notification ? steps.notification() : new Response(null, { status: 202 });
    if (message.method === 'tools/call') return steps.search ? steps.search() : jsonResponse(EXA_SEARCH_RESULT);
    throw new Error('unexpected MCP method ' + String(message.method));
  };
}

function bingFeed(items: string): string {
  return '<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Bing</title>' + items + '</channel></rss>';
}
function bingItem(title: string, link: string, description: string): string {
  return '<item><title>' + title + '</title><link>' + link + '</link><description>' + description + '</description></item>';
}

test('Exa anonymous MCP search speaks the verified SSE wire and echoes the issued session', async () => {
  const requests: ProviderRequest[] = [];
  const initMessage = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'exa-mcp', version: '1.0.0' } } };
  const initFrame = ': keepalive\r\nevent: message\r\ndata: ' + JSON.stringify(initMessage) + '\r\n\r\n';
  const cutData = initFrame.indexOf('"id":1') + 6;
  assert.ok(initFrame.slice(0, cutData).endsWith('"id":1'), 'the first chunk splits a data line');
  const searchFrames = [
    'data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' }) + '\n\n',
    'data: ' + JSON.stringify({ jsonrpc: '2.0', id: '2', result: { content: [{ type: 'text', text: 'Title: Wrong\nURL: https://wrong.example.org/' }] } }) + '\n\n',
    'event: message\ndata: ' + JSON.stringify(EXA_SEARCH_RESULT) + '\n\n',
  ];
  const outcome = await exaFreeProvider.search('故宫博物院', exaTransport({
    // Three chunks: one ends inside the data line, one ends inside the closing CRLF pair.
    initialize: () => sseResponse([
      initFrame.slice(0, cutData), initFrame.slice(cutData, initFrame.length - 2), initFrame.slice(initFrame.length - 2),
    ], false, { 'mcp-session-id': 'session-abc' }),
    search: () => sseResponse(searchFrames),
  }, requests), signal());

  assert.equal(requests.length, 3);
  for (const request of requests) assert.equal(request.url, EXA_ENDPOINT);
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].headers, {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-03-26',
  });
  assert.deepEqual(JSON.parse(requests[0].body ?? ''), {
    jsonrpc: '2.0', method: 'initialize', id: 1,
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'npn-gamma-network', version: '0.7.0' } },
  });
  // The negotiated version and the issued session id are echoed on later calls.
  assert.equal(requests[1].headers['Mcp-Session-Id'], 'session-abc');
  assert.equal(requests[1].headers['MCP-Protocol-Version'], '2025-06-18');
  const notification = JSON.parse(requests[1].body ?? '') as Record<string, unknown>;
  assert.deepEqual(notification, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.ok(!('id' in notification), 'the initialized notification carries no id');
  assert.equal(requests[2].headers['Mcp-Session-Id'], 'session-abc');
  assert.equal(requests[2].headers['MCP-Protocol-Version'], '2025-06-18');
  assert.deepEqual(JSON.parse(requests[2].body ?? ''), {
    jsonrpc: '2.0', method: 'tools/call', id: 2,
    params: { name: 'web_search_exa', arguments: { query: '故宫博物院', numResults: 10 } },
  });
  assert.deepEqual(outcome, { results: EXA_RESULTS, endpoint: EXA_ENDPOINT });
});

test('Exa parses whole-body JSON responses and accepts an empty tool result', async () => {
  const outcome = await exaFreeProvider.search('Palace Museum', exaTransport(), signal());
  assert.deepEqual(outcome, { results: EXA_RESULTS, endpoint: EXA_ENDPOINT });
  const empty = await exaFreeProvider.search('no hits', exaTransport({ search: () => jsonResponse({ jsonrpc: '2.0', id: 2, result: { content: [] } }) }), signal());
  assert.deepEqual(empty.results, []);
  const blank = await exaFreeProvider.search('no hits', exaTransport({ search: () => jsonResponse({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '   ' }] } }) }), signal());
  assert.deepEqual(blank.results, []);
});

test('Exa protocol violations surface as SEARCH_PROTOCOL and never as an empty success', async () => {
  const failures: [string, () => Response][] = [
    ['a response for another request id', () => jsonResponse({ jsonrpc: '2.0', id: 7, result: { content: [] } })],
    ['a message that is not JSON-RPC 2.0', () => jsonResponse({ id: 2, result: { content: [] } })],
    ['malformed JSON', () => textResponse('not json', 200, { 'content-type': 'application/json' })],
    ['an empty body', () => textResponse('', 200, { 'content-type': 'application/json' })],
    ['a JSON-RPC error object', () => jsonResponse({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found' } })],
    ['a tool result flagged as an error', () => jsonResponse({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: 'INTERNAL_ERROR' }] } })],
    ['text without a Title/URL block', () => jsonResponse({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Sorry, no results found.' }] } })],
  ];
  for (const [label, search] of failures) await rejectedWith(exaFreeProvider.search('query', exaTransport({ search }), signal()), 'SEARCH_PROTOCOL', label);

  const rpc = await rejectedWith(exaFreeProvider.search('query', exaTransport({
    search: () => jsonResponse({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'x'.repeat(400) } }),
  }), signal()), 'SEARCH_PROTOCOL');
  assert.match(rpc.message, /-32000/);
  assert.ok(rpc.message.length < 300, 'the reported JSON-RPC message is truncated');

  const wrongId: ProviderRequest[] = [];
  await rejectedWith(exaFreeProvider.search('query', exaTransport({
    initialize: () => jsonResponse({ jsonrpc: '2.0', id: 9, result: { protocolVersion: '2025-03-26' } }),
  }, wrongId), signal()), 'SEARCH_PROTOCOL', 'initialize answered with another id');
  assert.equal(wrongId.length, 1);

  const undated: ProviderRequest[] = [];
  await rejectedWith(exaFreeProvider.search('query', exaTransport({
    initialize: () => jsonResponse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 'v1' } }),
  }, undated), signal()), 'SEARCH_PROTOCOL', 'undated protocol version');
  assert.equal(undated.length, 1);

  const unmatchedStream = await rejectedWith(exaFreeProvider.search('query', exaTransport({
    search: () => sseResponse(['data: ' + JSON.stringify({ jsonrpc: '2.0', id: 5, result: {} }) + '\n\n']),
  }), signal()), 'SEARCH_PROTOCOL');
  assert.match(unmatchedStream.message, /without a response/);
});

test('Exa bounds bodies, refuses redirects and reports HTTP failures without retrying', async () => {
  const oversize = 'x'.repeat(1024 * 1024 + 1);
  await rejectedWith(exaFreeProvider.search('q', exaTransport({ search: () => sseResponse([oversize]) }), signal()), 'BODY_LIMIT', 'streamed body');
  await rejectedWith(exaFreeProvider.search('q', exaTransport({ search: () => jsonResponse(oversize) }), signal()), 'BODY_LIMIT', 'JSON body');

  const limitedRequests: ProviderRequest[] = [];
  const limited = await rejectedWith(exaFreeProvider.search('q', exaTransport({ initialize: () => textResponse('', 429) }, limitedRequests), signal()), 'RATE_LIMITED');
  assert.match(limited.message, /free tier/i);
  assert.match(limited.message, /no credential/i);
  assert.match(limited.message, /paid upgrade/i);
  assert.match(limited.message, /bypass/i);
  assert.equal(limitedRequests.length, 1, 'a rate-limited provider is not retried');

  const failedRequests: ProviderRequest[] = [];
  const failed = await rejectedWith(exaFreeProvider.search('q', exaTransport({ search: () => textResponse('boom', 500) }, failedRequests), signal()), 'HTTP_FAILED');
  assert.match(failed.message, /500/);
  assert.equal(failedRequests.length, 3);

  const redirected = await rejectedWith(exaFreeProvider.search('q', exaTransport({ initialize: () => textResponse('', 302, { location: EXA_ENDPOINT }) }), signal()), 'HTTP_FAILED');
  assert.match(redirected.message, /redirect/i);
});

test('Exa drops private and credential links, deduplicates and caps at ten', async () => {
  const block = (title: string, url: string) => ['Title: ' + title, 'URL: ' + url, 'Highlights:', 'snippet for ' + title].join('\n');
  const blocks = [
    block('Local admin', 'http://127.0.0.1/admin'),
    block('Credential', 'https://example.org/page?api_key=hidden'),
    block('First', 'https://example.org/page'),
    block('Same page', 'https://example.org/page#fragment'),
    ...Array.from({ length: 12 }, (_, index) => block('Result ' + index, 'https://example.org/' + index)),
  ];
  const outcome = await exaFreeProvider.search('query', exaTransport({
    search: () => jsonResponse({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: blocks.join('\n\n---\n\n') }] } }),
  }), signal());
  assert.equal(outcome.results.length, 10);
  assert.equal(outcome.results[0].url, 'https://example.org/page');
  assert.equal(new Set(outcome.results.map(result => result.url)).size, 10);
  assert.ok(outcome.results.every(result => !result.url.includes('127.0.0.1') && !result.url.includes('api_key')));
  assert.ok(outcome.results.every(result => result.source === 'exa'));
});

test('Exa aborts with the caller reason and an aborted search never reaches the transport', async () => {
  const early = new AbortController();
  const earlyRequests: ProviderRequest[] = [];
  early.abort(new Error('stop before dispatch'));
  const earlyError = await exaFreeProvider.search('q', exaTransport({}, earlyRequests), early.signal).catch(error => error);
  assert.equal(earlyError, early.signal.reason);
  assert.equal(earlyRequests.length, 0);

  const controller = new AbortController();
  const requests: ProviderRequest[] = [];
  const pending = exaFreeProvider.search('q', exaTransport({
    search: () => sseResponse(['data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' }) + '\n\n'], true),
  }, requests), controller.signal);
  // Let the request chain reach the stalled stream read, then cancel it.
  await new Promise<void>(resolve => { setImmediate(() => resolve()); });
  controller.abort(new Error('stop mid stream'));
  const error = await pending.catch(reason => reason);
  assert.equal(error, controller.signal.reason);
  assert.equal(requests.length, 3);
});

test('Bing RSS parses items, entities and CDATA while dropping unsafe links', async () => {
  const items = [
    bingItem('Python &amp; docs', 'https://docs.python.org/', '<![CDATA[Official <b>Python</b> documentation &amp; tutorial]]>'),
    bingItem('<![CDATA[中文 官方文档]]>', 'https://docs.python.org/zh-cn/?a=1&amp;b=2', 'Chinese &#x4E2D; &#20013; text'),
    bingItem('Script', 'javascript:alert(1)', 'drop'),
    bingItem('Data', 'data:text/html;base64,AAAA', 'drop'),
    bingItem('Local', 'http://localhost/private', 'drop'),
    bingItem('Duplicate', 'https://docs.python.org/', 'second copy'),
    ...Array.from({ length: 12 }, (_, index) => bingItem('Result ' + index, 'https://example.org/' + index, '&lt;b&gt;markup&lt;/b&gt;')),
  ].join('');
  const requests: ProviderRequest[] = [];
  const query = 'Python 中文官方文档';
  const outcome = await bingRssProvider.search(query, fixedTransport(() => textResponse(bingFeed(items), 200, { 'content-type': 'text/xml; charset=utf-8' }), requests), signal());

  const expectedUrl = BING_RSS_ENDPOINT + '?format=rss&q=' + encodeURIComponent(query);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, expectedUrl);
  assert.equal(requests[0].method, 'GET');
  assert.deepEqual(requests[0].headers, { Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8' });
  assert.equal(requests[0].body, undefined);
  assert.equal(outcome.endpoint, expectedUrl);
  assert.equal(outcome.results.length, 10);
  assert.deepEqual(outcome.results.slice(0, 3), [
    { title: 'Python & docs', url: 'https://docs.python.org/', snippet: 'Official Python documentation & tutorial', source: 'bing' },
    { title: '中文 官方文档', url: 'https://docs.python.org/zh-cn/?a=1&b=2', snippet: 'Chinese 中 中 text', source: 'bing' },
    { title: 'Result 0', url: 'https://example.org/0', snippet: 'markup', source: 'bing' },
  ]);
  assert.equal(new Set(outcome.results.map(result => result.url)).size, 10);
  assert.ok(outcome.results.every(result => !/^(?:javascript|data):|localhost/.test(result.url)));
});

test('Bing RSS rejects DTD documents and non-RSS bodies without resolving entities', async () => {
  const doctype = '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe "EXPANDED">]><rss version="2.0"><channel><item><title>&xxe;</title><link>https://example.org/</link></item></channel></rss>';
  const dtd = await rejectedWith(bingRssProvider.search('q', fixedTransport(() => textResponse(doctype, 200, { 'content-type': 'text/xml' })), signal()), 'SEARCH_PROTOCOL');
  assert.match(dtd.message, /DTD/);
  assert.ok(!dtd.message.includes('EXPANDED'), 'no entity is expanded');
  await rejectedWith(bingRssProvider.search('q', fixedTransport(() => textResponse('<!ENTITY xxe SYSTEM "file:///c:/windows/win.ini"><rss version="2.0"/>', 200, { 'content-type': 'text/xml' })), signal()), 'SEARCH_PROTOCOL', 'entity declaration without a DOCTYPE');
  for (const document of ['<html><body>blocked</body></html>', '{"results":[]}', '', '<rssx><channel/></rssx>']) {
    await rejectedWith(bingRssProvider.search('q', fixedTransport(() => textResponse(document, 200, { 'content-type': 'text/xml' })), signal()), 'SEARCH_PROTOCOL', 'not an RSS document');
  }
});

test('Bing RSS reports rate limits, HTTP failures and oversized bodies without retrying', async () => {
  const limitedRequests: ProviderRequest[] = [];
  const limited = await rejectedWith(bingRssProvider.search('q', fixedTransport(() => textResponse('', 429), limitedRequests), signal()), 'RATE_LIMITED');
  assert.match(limited.message, /free tier/i);
  assert.match(limited.message, /no credential/i);
  assert.match(limited.message, /paid upgrade/i);
  assert.match(limited.message, /bypass/i);
  assert.equal(limitedRequests.length, 1, 'a rate-limited provider is not retried');

  const failed = await rejectedWith(bingRssProvider.search('q', fixedTransport(() => textResponse('boom', 500)), signal()), 'HTTP_FAILED');
  assert.match(failed.message, /500/);
  await rejectedWith(bingRssProvider.search('q', fixedTransport(() => textResponse('x'.repeat(1024 * 1024 + 1), 200, { 'content-type': 'text/xml' })), signal()), 'BODY_LIMIT', 'oversized feed');
});

test('free providers advertise stable identities and contact only their fixed endpoints', async () => {
  assert.deepEqual(FREE_PROVIDERS.map(provider => provider.id), ['exa', 'bing-rss']);
  assert.equal(exaFreeProvider.id, 'exa');
  assert.equal(exaFreeProvider.label, EXA_LABEL);
  assert.deepEqual(exaFreeProvider.endpoints, [EXA_ENDPOINT]);
  assert.equal(bingRssProvider.id, 'bing-rss');
  assert.equal(bingRssProvider.label, BING_LABEL);
  assert.deepEqual(bingRssProvider.endpoints, [BING_RSS_ENDPOINT]);

  const exaRequests: ProviderRequest[] = [];
  await exaFreeProvider.search('q', exaTransport({}, exaRequests), signal());
  assert.equal(exaRequests.length, 3);
  assert.ok(exaRequests.every(request => request.url === EXA_ENDPOINT));

  const bingRequests: ProviderRequest[] = [];
  await bingRssProvider.search('q', fixedTransport(() => textResponse(bingFeed(bingItem('Only hit', 'https://example.org/', 'text')), 200, { 'content-type': 'text/xml' }), bingRequests), signal());
  assert.equal(bingRequests.length, 1);
  assert.ok(bingRequests[0].url.startsWith(BING_RSS_ENDPOINT + '?format=rss&q='));
  const targets = [...exaRequests.map(request => request.url), ...bingRequests.map(request => request.url.split('?')[0])];
  assert.deepEqual([...new Set(targets)], [EXA_ENDPOINT, BING_RSS_ENDPOINT]);
});

test('Exa distinguishes an explicitly empty content array from malformed tool results', async () => {
  const malformed: unknown[] = [
    {},
    { content: 'not an array' },
    { content: [{ type: 'text' }] },
    { content: [{ type: 'image', data: 'x' }] },
    { content: [null] },
  ];
  for (const result of malformed) {
    await rejectedWith(
      exaFreeProvider.search('query', exaTransport({ search: () => jsonResponse({ jsonrpc: '2.0', id: 2, result }) }), signal()),
      'SEARCH_PROTOCOL',
      JSON.stringify(result),
    );
  }
  const empty = await exaFreeProvider.search('query', exaTransport({
    search: () => jsonResponse({ jsonrpc: '2.0', id: 2, result: { content: [] } }),
  }), signal());
  assert.deepEqual(empty.results, []);
});

test('Exa negotiates only the implemented MCP versions and stops before initialized', async () => {
  const accepted: ProviderRequest[] = [];
  const outcome = await exaFreeProvider.search('q', exaTransport({
    initialize: () => jsonResponse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }),
  }, accepted), signal());
  assert.deepEqual(outcome.results, EXA_RESULTS);
  assert.equal(accepted.length, 3);
  for (const version of ['2099-99-99', '2024-11-05']) {
    const requests: ProviderRequest[] = [];
    const error = await rejectedWith(exaFreeProvider.search('q', exaTransport({
      initialize: () => jsonResponse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: version } }),
    }, requests), signal()), 'SEARCH_PROTOCOL', version);
    assert.match(error.message, /unsupported/i);
    assert.equal(requests.length, 1, 'no initialized or search request after an unsupported version');
  }
});

test('Exa and Bing drop tracking parameters before dedupe while keeping real query parameters', async () => {
  const exaText = [
    'Title: Campaign copy',
    'URL: https://example.org/page?utm_source=news&id=7&gclid=abc',
    'Highlights:',
    'first',
    '',
    '---',
    '',
    'Title: Clean copy',
    'URL: https://example.org/page?id=7',
    'Highlights:',
    'second',
  ].join('\n');
  const exa = await exaFreeProvider.search('q', exaTransport({
    search: () => jsonResponse({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: exaText }] } }),
  }), signal());
  assert.equal(exa.results.length, 1, 'tracking variants collapse to one result');
  assert.equal(exa.results[0].url, 'https://example.org/page?id=7');

  const items = bingItem('Bing campaign', 'https://example.org/page?fbclid=xyz&id=7', 'first')
    + bingItem('Bing clean', 'https://example.org/page?id=7', 'second');
  const bing = await bingRssProvider.search('q', fixedTransport(() => textResponse(bingFeed(items), 200, { 'content-type': 'text/xml' })), signal());
  assert.equal(bing.results.length, 1, 'tracking variants collapse to one result');
  assert.equal(bing.results[0].url, 'https://example.org/page?id=7');
});
