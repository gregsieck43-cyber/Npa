import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ExternalTools } from '../src/app/external-tools.js';
import { WebError, type CrawlResult, type SearchResponse, type WebPage } from '../src/network/index.js';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const MWMBL_ROWS = [{
  url: 'https://www.example.org/result',
  title: [{ value: 'Fixture search result' }],
  extract: [{ value: 'Fixture search evidence' }],
}];
const WIKIPEDIA_ANSWER = { query: { search: [{ title: 'Fixture encyclopedia', snippet: 'Encyclopedia evidence' }] } };

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(process.cwd(), '.tmp', 'network-external-it-'));
}

/** Injected transport only: no test in this file reaches the public network. */
function mockFetch(handler: (url: URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(new URL(String(input)), init)) as typeof fetch;
}

function pageFetch(counts: { robots: number; pages: number }, log?: string[]): typeof fetch {
  return mockFetch(async url => {
    log?.push(url.href);
    if (url.pathname === '/robots.txt') { counts.robots++; return new Response('', { status: 404 }); }
    counts.pages++;
    return new Response('<title>Fixture page</title><main>Page evidence</main>', { headers: { 'content-type': 'text/html' } });
  });
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 5000) throw new Error(`Timed out waiting for ${description}.`);
    await delay(10);
  }
}

function failureCode(output: string): { code: string; attempts?: { provider: string; errorCode?: string }[]; tool?: string } {
  const parsed = JSON.parse(output) as { error: { code: string; attempts?: { provider: string; errorCode?: string }[]; tool?: string } };
  return parsed.error;
}

test('fresh installation selects the free automatic chain and freezes the complete approved scope', async () => {
  const directory = await temporaryDirectory();
  const external = new ExternalTools({ dataDir: directory, projectRoot: process.cwd() });
  try {
    assert.deepEqual(external.webConfiguration(), { searchProvider: 'auto' });
    const prepared = external.prepare({ name: 'web_search', arguments: { query: 'fixture' } })!;
    assert.deepEqual(prepared.resources, ['https://api.mwmbl.org', 'https://mcp.exa.ai']);
    const frozen = structuredClone(prepared.arguments);
    const scope = prepared.arguments.searchScope as { providers: string[]; origins: string[] };
    assert.deepEqual(scope.providers, ['exa', 'mwmbl']);
    assert.deepEqual([...scope.origins].sort(), ['https://api.mwmbl.org', 'https://mcp.exa.ai']);
    external.configureWeb({ searchProvider: 'searxng', searxUrl: 'https://search.example.org' });
    assert.deepEqual(prepared.arguments, frozen);
    assert.deepEqual(prepared.resources, ['https://api.mwmbl.org', 'https://mcp.exa.ai']);
    assert.deepEqual(external.prepare({ name: 'web_search', arguments: { query: 'fixture' } })!.resources, ['https://search.example.org']);
  } finally {
    await external.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy explicit saved providers survive restart and remain explicit', async () => {
  const cases = [
    { stored: { searchProvider: 'mwmbl' }, resources: ['https://api.mwmbl.org'] },
    { stored: { searchProvider: 'wikipedia' }, resources: ['https://en.wikipedia.org'] },
    { stored: { searchProvider: 'searxng', searxUrl: 'https://search.example.org' }, resources: ['https://search.example.org'] },
  ];
  for (const current of cases) {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, 'web-settings.json'), JSON.stringify(current.stored), 'utf8');
    const external = new ExternalTools({ dataDir: directory, projectRoot: process.cwd() });
    try {
      assert.equal(external.webConfiguration().searchProvider, current.stored.searchProvider);
      assert.equal(external.webConfiguration().searchConfigurationError, undefined);
      assert.deepEqual(external.prepare({ name: 'web_search', arguments: { query: 'fixture' } })!.resources, current.resources);
    } finally {
      await external.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('corrupt saved search settings are preserved and fail clearly until repaired', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'web-settings.json');
  const corrupted = '{broken';
  await writeFile(file, corrupted, 'utf8');
  const external = new ExternalTools({ dataDir: directory, projectRoot: process.cwd() });
  try {
    const view = external.webConfiguration();
    assert.match(view.searchConfigurationError ?? '', /invalid|repair/i);
    assert.equal(view.searchProvider, 'mwmbl');
    assert.equal(await readFile(file, 'utf8'), corrupted);
    assert.throws(() => external.prepare({ name: 'web_search', arguments: { query: 'fixture' } }), /invalid|repair/i);
    external.configureWeb({ searchProvider: 'wikipedia' });
    const restarted = new ExternalTools({ dataDir: directory, projectRoot: process.cwd() });
    assert.equal(restarted.webConfiguration().searchProvider, 'wikipedia');
    assert.equal(restarted.webConfiguration().searchConfigurationError, undefined);
    assert.deepEqual(restarted.prepare({ name: 'web_search', arguments: { query: 'fixture' } })!.resources, ['https://en.wikipedia.org']);
    await restarted.close();
  } finally {
    await external.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('automatic search falls back after a rate limit and keeps every attempt', async () => {
  const directory = await temporaryDirectory();
  const requests: string[] = [];
  const transport = mockFetch(async url => {
    requests.push(url.hostname + url.pathname);
    if (url.hostname === 'mcp.exa.ai') return new Response('', { status: 429 });
    if (url.hostname === 'api.mwmbl.org') return Response.json(MWMBL_ROWS);
    throw new Error('Unexpected request ' + url.href);
  });
  const external = new ExternalTools({ dataDir: directory, projectRoot: process.cwd(), webOptions: { fetch: transport, resolveDns: publicDns } });
  try {
    const prepared = external.prepare({ name: 'web_search', arguments: { query: 'fixture' } })!;
    const outcome = await external.execute(prepared, { effectKey: 'auto-fallback', approvedDigest: prepared.digest });
    assert.equal(outcome.status, 'applied');
    const response = JSON.parse(outcome.output) as SearchResponse;
    assert.equal(response.trust, 'untrusted');
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0].source, 'mwmbl');
    assert.equal(response.attempts.length, 2);
    assert.equal(response.attempts[0].provider, 'exa');
    assert.equal(response.attempts[0].status, 'error');
    assert.equal(response.attempts[0].errorCode, 'RATE_LIMITED');
    assert.equal(response.attempts[1].provider, 'mwmbl');
    assert.equal(response.attempts[1].status, 'results');
    assert.deepEqual(requests, ['mcp.exa.ai/mcp', 'api.mwmbl.org/search/']);
  } finally {
    await external.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an approved automatic request executes against its frozen free targets after settings change', async () => {
  const directory = await temporaryDirectory();
  const requests: string[] = [];
  const transport = mockFetch(async url => {
    requests.push(url.hostname + url.pathname);
    if (url.hostname === 'mcp.exa.ai') return new Response('', { status: 429 });
    if (url.hostname === 'api.mwmbl.org') return Response.json(MWMBL_ROWS);
    throw new Error('Unexpected request ' + url.href);
  });
  const external = new ExternalTools({ dataDir: directory, projectRoot: process.cwd(), webOptions: { fetch: transport, resolveDns: publicDns } });
  try {
    const prepared = external.prepare({ name: 'web_search', arguments: { query: 'fixture' } })!;
    external.configureWeb({ searchProvider: 'mwmbl' });
    const outcome = await external.execute(prepared, { effectKey: 'frozen-auto', approvedDigest: prepared.digest });
    assert.equal(outcome.status, 'applied');
    assert.deepEqual(requests, ['mcp.exa.ai/mcp', 'api.mwmbl.org/search/']);
    const response = JSON.parse(outcome.output) as SearchResponse;
    assert.equal(response.attempts.length, 2);
  } finally {
    await external.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed search keeps structured attempts and diagnostics across restart', async () => {
  const directory = await temporaryDirectory();
  const transport = mockFetch(async () => new Response('', { status: 429 }));
  const external = new ExternalTools({ dataDir: directory, projectRoot: process.cwd(), webOptions: { fetch: transport, resolveDns: publicDns } });
  try {
    const prepared = external.prepare({ name: 'web_search', arguments: { query: 'fixture' } })!;
    const outcome = await external.execute(prepared, { effectKey: 'failed-search', approvedDigest: prepared.digest });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.receipt, undefined);
    const diagnostic = failureCode(outcome.output);
    assert.equal(diagnostic.code, 'SEARCH_UNAVAILABLE');
    assert.equal(diagnostic.tool, 'web_search');
    assert.equal(diagnostic.attempts?.length, 2);
    assert.deepEqual(diagnostic.attempts?.map(attempt => [attempt.provider, attempt.errorCode]), [['exa', 'RATE_LIMITED'], ['mwmbl', 'RATE_LIMITED']]);
    assert.match(outcome.error ?? '', /^SEARCH_UNAVAILABLE: /);

    const restarted = new ExternalTools({ dataDir: directory, projectRoot: process.cwd() });
    try {
      const reread = await restarted.queryOutcome('failed-search', prepared.digest);
      assert.equal(reread.status, 'failed');
      assert.equal(reread.output, outcome.output);
      assert.equal(reread.error, outcome.error);
      const record = JSON.parse(await readFile(path.join(directory, 'external-receipts', 'failed-search.json'), 'utf8').catch(() => '{}')) as unknown;
      assert.equal(typeof record, 'object');
    } finally {
      await restarted.close();
    }
  } finally {
    await external.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancellation before dispatch persists a known CANCELLED failure that survives restart', async () => {
  const directory = await temporaryDirectory();
  let calls = 0;
  const transport = mockFetch(async () => {
    calls++;
    return Response.json(MWMBL_ROWS);
  });
  const options = { dataDir: directory, projectRoot: process.cwd(), webOptions: { searchProvider: 'mwmbl' as const, fetch: transport, resolveDns: publicDns } };
  const external = new ExternalTools(options);
  const prepared = external.prepare({ name: 'web_search', arguments: { query: 'cancelled before dispatch' } })!;
  try {
    const controller = new AbortController();
    controller.abort();
    const outcome = await external.execute(prepared, { effectKey: 'pre-cancel', approvedDigest: prepared.digest, signal: controller.signal });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.receipt, undefined);
    assert.equal(calls, 0);
    const diagnostic = failureCode(outcome.output);
    assert.equal(diagnostic.code, 'CANCELLED');
    assert.equal(diagnostic.tool, 'web_search');
    assert.match(outcome.error ?? '', /^CANCELLED: /);

    const saved = await external.queryOutcome('pre-cancel', prepared.digest);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.output, outcome.output);
    assert.equal(saved.error, outcome.error);
  } finally {
    await external.close();
  }
  const restarted = new ExternalTools(options);
  try {
    const reread = await restarted.queryOutcome('pre-cancel', prepared.digest);
    assert.equal(reread.status, 'failed');
    assert.equal(failureCode(reread.output).code, 'CANCELLED');
    assert.equal(calls, 0);
  } finally {
    await restarted.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an already applied effect stays authoritative when a repeated call is cancelled', async () => {
  const directory = await temporaryDirectory();
  let calls = 0;
  const transport = mockFetch(async () => {
    calls++;
    return Response.json(MWMBL_ROWS);
  });
  const external = new ExternalTools({ dataDir: directory, projectRoot: process.cwd(), webOptions: { searchProvider: 'mwmbl' as const, fetch: transport, resolveDns: publicDns } });
  try {
    const prepared = external.prepare({ name: 'web_search', arguments: { query: 'applied first' } })!;
    const options = { effectKey: 'applied-repeat', approvedDigest: prepared.digest };
    const applied = await external.execute(prepared, options);
    assert.equal(applied.status, 'applied');
    const before = calls;
    const controller = new AbortController();
    controller.abort();
    const repeat = await external.execute(prepared, { ...options, signal: controller.signal });
    assert.equal(repeat.status, 'applied');
    assert.deepEqual(repeat.receipt, applied.receipt);
    assert.equal(calls, before);
    assert.equal((await external.queryOutcome(options.effectKey, prepared.digest)).status, 'applied');
  } finally {
    await external.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('saved capability switches gate prepared dispatch, cancel in-flight work and persist', async () => {
  const directory = await temporaryDirectory();
  let calls = 0;
  let mode: 'normal' | 'hang' = 'normal';
  const transport = mockFetch(async (url, init) => {
    calls++;
    if (mode === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    if (url.pathname === '/w/api.php') return Response.json(WIKIPEDIA_ANSWER);
    if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
    return new Response('<title>Fixture page</title><main>Page evidence</main>', { headers: { 'content-type': 'text/html' } });
  });
  const options = { dataDir: directory, projectRoot: process.cwd(), webOptions: { searchProvider: 'wikipedia' as const, fetch: transport, resolveDns: publicDns } };
  const external = new ExternalTools(options);
  try {
    const prepared = external.prepare({ name: 'web_search', arguments: { query: 'gated' } })!;
    external.configureWeb({ network: { webSearch: false } });
    const disabled = await external.execute(prepared, { effectKey: 'disabled-search', approvedDigest: prepared.digest });
    assert.equal(disabled.status, 'failed');
    assert.equal(failureCode(disabled.output).code, 'NETWORK_DISABLED');
    assert.equal(calls, 0);
    await assert.rejects(external.operatorWeb('search', { query: 'gated' }), (error: unknown) => error instanceof WebError && error.code === 'NETWORK_DISABLED');

    const restarted = new ExternalTools({ dataDir: directory, projectRoot: process.cwd() });
    try { assert.equal(restarted.networkSettings().webSearch, false); } finally { await restarted.close(); }

    external.configureWeb({ network: { webSearch: true } });
    mode = 'hang';
    const inFlight = external.operatorWeb('search', { query: 'slow' });
    await waitFor(() => calls > 0, 'in-flight operator search');
    external.configureWeb({ network: { webSearch: false } });
    await assert.rejects(inFlight, (error: unknown) => error instanceof WebError && error.code === 'CANCELLED');
    assert.equal(external.networkStatus().activeOperations, 0);

    external.configureWeb({ network: { webSearch: true } });
    mode = 'normal';
    const recovered = await external.operatorWeb('search', { query: 'recovered' });
    assert.equal(recovered.results.length, 1);

    mode = 'hang';
    const cancellable = external.prepare({ name: 'web_search', arguments: { query: 'cancelled' } })!;
    const controller = new AbortController();
    const beforeCancelled = calls;
    const pending = external.execute(cancellable, { effectKey: 'cancelled-search', approvedDigest: cancellable.digest, signal: controller.signal });
    await waitFor(() => calls > beforeCancelled, 'in-flight Agent search');
    controller.abort();
    const cancelledOutcome = await pending;
    assert.equal(cancelledOutcome.status, 'failed');
    const cancelled = failureCode(cancelledOutcome.output);
    assert.equal(cancelled.code, 'CANCELLED');
    assert.ok((cancelled.attempts?.length ?? 0) >= 1);
    mode = 'normal';

    const reread = new ExternalTools({ dataDir: directory, projectRoot: process.cwd() });
    try {
      const outcome = await reread.queryOutcome('cancelled-search', cancellable.digest);
      assert.equal(outcome.status, 'failed');
      assert.equal(failureCode(outcome.output).code, 'CANCELLED');
      assert.equal(outcome.output, cancelledOutcome.output);
    } finally {
      await reread.close();
    }

    external.configureWeb({ network: { fetch: false } });
    const before = calls;
    await assert.rejects(external.operatorWeb('fetch', { url: 'https://www.example.org/page' }), (error: unknown) => error instanceof WebError && error.code === 'NETWORK_DISABLED');
    assert.equal(calls, before);
  } finally {
    await external.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a non-empty proxy is rejected explicitly and a stored proxy blocks real execution', async () => {
  const directory = await temporaryDirectory();
  const counts = { robots: 0, pages: 0 };
  const transport = pageFetch(counts);
  const external = new ExternalTools({ dataDir: directory, projectRoot: process.cwd(), webOptions: { fetch: transport, resolveDns: publicDns } });
  try {
    assert.throws(() => external.configureWeb({ network: { proxy: 'http://127.0.0.1:8080' } }),
      (error: unknown) => error instanceof WebError && error.code === 'PROXY_UNSUPPORTED');
    assert.equal(existsSync(path.join(directory, 'web-settings.json')), false);

    await writeFile(path.join(directory, 'web-settings.json'), JSON.stringify({ searchProvider: 'mwmbl', proxy: 'http://127.0.0.1:8080' }), 'utf8');
    const proxied = new ExternalTools({ dataDir: directory, projectRoot: process.cwd(), webOptions: { fetch: transport, resolveDns: publicDns } });
    try {
      assert.equal(proxied.networkSettings().proxy, 'http://127.0.0.1:8080');
      assert.equal(proxied.webConfiguration().searchConfigurationError, undefined);
      await assert.rejects(proxied.operatorWeb('search', { query: 'fixture' }), (error: unknown) => error instanceof WebError && error.code === 'PROXY_UNSUPPORTED');
      const prepared = proxied.prepare({ name: 'web_fetch', arguments: { url: 'https://www.example.org/page' } })!;
      const outcome = await proxied.execute(prepared, { effectKey: 'proxy-fetch', approvedDigest: prepared.digest });
      assert.equal(outcome.status, 'failed');
      assert.equal(failureCode(outcome.output).code, 'PROXY_UNSUPPORTED');
      assert.equal(counts.pages + counts.robots, 0);

      proxied.configureWeb({ proxy: '' });
      assert.equal(proxied.networkSettings().proxy, '');
      const page = await proxied.operatorWeb('fetch', { url: 'https://www.example.org/page' });
      assert.equal(page.trust, 'untrusted');
      assert.equal(counts.pages, 1);
    } finally {
      await proxied.close();
    }
  } finally {
    await external.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('operator browsing returns real untrusted results without receipts, tasks or kernel work', async () => {
  const directory = await temporaryDirectory();
  const counts = { robots: 0, pages: 0 };
  let calls = 0;
  const transport = mockFetch(async (url, init) => {
    calls++;
    if (url.pathname === '/robots.txt') { counts.robots++; return new Response('', { status: 404 }); }
    if (url.pathname === '/w/api.php') return Response.json(WIKIPEDIA_ANSWER);
    counts.pages++;
    return new Response('<title>Fixture page</title><main>Page evidence</main>', { headers: { 'content-type': 'text/html' } });
  });
  const external = new ExternalTools({ dataDir: directory, projectRoot: process.cwd(), webOptions: { searchProvider: 'wikipedia', fetch: transport, resolveDns: publicDns } });
  try {
    const search = await external.operatorWeb('search', { query: 'fixture' }) as SearchResponse;
    assert.equal(search.trust, 'untrusted');
    assert.equal(search.results.length, 1);
    assert.equal(search.attempts.length, 1);
    const page = await external.operatorWeb('fetch', { url: 'https://www.example.org/page' }) as WebPage;
    assert.equal(page.trust, 'untrusted');
    assert.match(page.text, /Page evidence/);
    const crawl = await external.operatorWeb('crawl', { url: 'https://www.example.org/page', maxPages: 1, maxDepth: 0 }) as CrawlResult;
    assert.equal(crawl.maxPages, 1);
    assert.equal(crawl.maxDepth, 0);
    assert.equal(crawl.pages.length, 1);
    assert.equal(crawl.trust, 'untrusted');
    assert.equal(existsSync(path.join(directory, 'external-receipts')), false);
    assert.equal(external.networkStatus().activeOperations, 0);

    const source = readFileSync(path.join(process.cwd(), 'src', 'app', 'external-tools.ts'), 'utf8');
    assert.doesNotMatch(source, /from ['"][^'"]*(?:kernel|agent|services|runner)[^'"]*['"]/i);

    const before = calls;
    await assert.rejects(external.operatorWeb('search', { query: '' }), (error: unknown) => error instanceof WebError && error.code === 'INVALID_QUERY');
    await assert.rejects(external.operatorWeb('fetch', { url: 'http://127.0.0.1/private' }), (error: unknown) => error instanceof WebError);
    await assert.rejects(external.operatorWeb('crawl', { url: 'https://www.example.org/page', maxPages: 9 }), (error: unknown) => error instanceof WebError && error.code === 'CRAWL_LIMIT');
    await assert.rejects((external.operatorWeb as unknown as (action: string, input: unknown) => Promise<unknown>)('bogus', {}),
      (error: unknown) => error instanceof WebError && error.code === 'INVALID_ACTION');
    assert.equal(calls, before);
  } finally {
    await external.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('robots policy is reused across requests, instances and saved configuration changes', async () => {
  const first = await temporaryDirectory();
  const second = await temporaryDirectory();
  const counts = { robots: 0, pages: 0 };
  const transport = pageFetch(counts);
  const webOptions = { fetch: transport, resolveDns: publicDns };
  const a = new ExternalTools({ dataDir: first, projectRoot: process.cwd(), webOptions });
  const b = new ExternalTools({ dataDir: second, projectRoot: process.cwd(), webOptions });
  try {
    await a.operatorWeb('fetch', { url: 'https://www.example.org/page' });
    assert.equal(counts.robots, 1);
    await a.operatorWeb('fetch', { url: 'https://www.example.org/other' });
    assert.equal(counts.robots, 1);
    assert.equal(counts.pages, 2);
    await b.operatorWeb('fetch', { url: 'https://www.example.org/third' });
    assert.equal(counts.robots, 1);
    assert.equal(counts.pages, 3);
    a.configureWeb({ searchProvider: 'searxng', searxUrl: 'https://search.example.org' });
    await a.operatorWeb('fetch', { url: 'https://www.example.org/fourth' });
    assert.equal(counts.robots, 1);
    assert.equal(counts.pages, 4);
    assert.equal(a.networkStatus().activeOperations, 0);
  } finally {
    await a.close();
    await b.close();
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test('total concurrency is bounded across differently configured instances', async () => {
  const first = await temporaryDirectory();
  const second = await temporaryDirectory();
  let entered = 0;
  const hangingFetch = mockFetch(async (_url, init) => {
    entered++;
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  const a = new ExternalTools({ dataDir: first, projectRoot: process.cwd(), webOptions: { searchProvider: 'wikipedia', fetch: hangingFetch, resolveDns: publicDns } });
  const b = new ExternalTools({ dataDir: second, projectRoot: process.cwd(), webOptions: { searchProvider: 'searxng', searxUrl: 'https://search.example.org', fetch: hangingFetch, resolveDns: publicDns } });
  const controllers = [new AbortController(), new AbortController(), new AbortController(), new AbortController()];
  try {
    const pending = [
      a.operatorWeb('search', { query: 'one' }, controllers[0].signal),
      a.operatorWeb('search', { query: 'two' }, controllers[1].signal),
      b.operatorWeb('search', { query: 'three' }, controllers[2].signal),
      b.operatorWeb('search', { query: 'four' }, controllers[3].signal),
    ];
    await waitFor(() => entered === 4, 'four shared network operations');
    await assert.rejects(a.operatorWeb('search', { query: 'over the bound' }),
      (error: unknown) => error instanceof WebError && error.code === 'CONCURRENCY_LIMIT');
    assert.equal(entered, 4);
    for (const controller of controllers) controller.abort();
    const settled = await Promise.allSettled(pending);
    assert.ok(settled.every(result => result.status === 'rejected' && (result.reason as WebError).code === 'CANCELLED'));
    assert.equal(a.networkStatus().activeOperations, 0);
  } finally {
    await a.close();
    await b.close();
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test('close cancels in-flight operator work, waits for it and rejects later calls', async () => {
  const directory = await temporaryDirectory();
  let entered = 0;
  const transport = mockFetch(async (_url, init) => {
    entered++;
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  const external = new ExternalTools({ dataDir: directory, projectRoot: process.cwd(), webOptions: { fetch: transport, resolveDns: publicDns } });
  try {
    const pending = external.operatorWeb('fetch', { url: 'https://www.example.org/page' });
    await waitFor(() => entered === 1, 'in-flight operator fetch');
    const closing = external.close();
    await assert.rejects(pending, (error: unknown) => error instanceof WebError && error.code === 'CANCELLED');
    await closing;
    assert.equal(external.networkStatus().closed, true);
    assert.equal(external.networkStatus().activeOperations, 0);
    await assert.rejects(external.operatorWeb('search', { query: 'after close' }), (error: unknown) => error instanceof WebError && error.code === 'CLOSED');
  } finally {
    await external.close();
    await rm(directory, { recursive: true, force: true });
  }
});
