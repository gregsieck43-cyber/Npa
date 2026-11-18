/**
 * Real-HTTP regression for the fetched page's OWN HTTP status.
 *
 * The product route answers HTTP 200 once the read succeeds, so the DTO must carry the status of the
 * response that was actually read (200/201/206 or a redirect target) instead of a synthetic success code.
 * Every test starts the real backend and a REAL ExternalTools whose transport is a deterministic fixture:
 * no public socket, DNS lookup, model call or Agent task is involved.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import { ExternalTools } from '../src/app/external-tools.js';

const root = path.resolve(process.env.TEMP ?? path.join('.tmp', 'network-integration', 'root', 'product-status'));
mkdirSync(root, { recursive: true });

const PAGE_ORIGIN = 'https://www.example.org';
const HTML = '<html><head><title>Status fixture</title></head><body><main>Status fixture body.</main></body></html>';
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

interface FixtureTransport {
  fetch: typeof fetch;
  requests: string[];
}

function createFixture(): FixtureTransport {
  const requests: string[] = [];
  const fixtureFetch: typeof fetch = async input => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (url.hostname !== 'www.example.org') throw new Error('fixture: unexpected host ' + url.hostname);
    if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    switch (url.pathname) {
      case '/p200': return new Response(HTML, { status: 200, headers });
      case '/p201': return new Response(HTML, { status: 201, headers });
      case '/p206': return new Response(HTML, { status: 206, headers });
      case '/moved': return new Response('', { status: 302, headers: { location: '/p206-final' } });
      case '/p206-final': return new Response(HTML, { status: 206, headers });
      case '/fail503': return new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });
      default: throw new Error('fixture: unexpected path ' + url.pathname);
    }
  };
  return { fetch: fixtureFetch, requests };
}

async function setup() {
  const dir = mkdtempSync(path.join(root, 'status-'));
  let modelCalls = 0;
  const backend = await startBackend({
    dataDir: path.join(dir, 'data'),
    projectRoot: process.cwd(),
    mockOptions: { responder: () => { modelCalls++; return { content: 'The model must not be called for manual browsing.' }; } },
  });
  const fixture = createFixture();
  const external = new ExternalTools({
    dataDir: path.join(dir, 'network'),
    projectRoot: process.cwd(),
    webOptions: { searchProvider: 'mwmbl', resolveDns: publicDns, fetch: fixture.fetch },
  });
  const services = backend.services as unknown as { external: ExternalTools };
  const startup = services.external;
  services.external = external;
  if (startup && startup !== external) {
    // A startup instance captured by an older layer must still run against the deterministic fixture.
    const surface = startup as unknown as Record<string, unknown>;
    for (const name of ['operatorWeb', 'configureWeb', 'webConfiguration', 'networkSettings', 'networkStatus', 'prepare', 'execute', 'close'] as const) {
      const method = (external as unknown as Record<string, unknown>)[name];
      if (typeof method === 'function') surface[name] = (method as (...args: unknown[]) => unknown).bind(external);
    }
  }
  const request = async (route: string, body?: unknown): Promise<{ status: number; text: string; body: any }> => {
    const response = await fetch('http://127.0.0.1:' + backend.port + route, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* keep the raw body for failure messages */ }
    return { status: response.status, body: parsed, text };
  };
  const close = async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); };
  return { backend, fixture, request, close, tasks: () => backend.services.kernel.listTasks().length, modelCalls: () => modelCalls };
}

test('product fetch returns the observed source status while its own HTTP answer stays 200', { timeout: 60000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const tasksBefore = env.tasks();

  for (const status of [200, 201, 206] as const) {
    const url = PAGE_ORIGIN + '/p' + status;
    const reply = await env.request('/v1/product/web/fetch', { url });
    assert.equal(reply.status, 200, 'the product request itself succeeds with HTTP 200: ' + reply.text);
    assert.equal(reply.body.status, status, 'the DTO must carry the source response status ' + status + ' (received ' + reply.body.status + ')');
    assert.equal(reply.body.url, url);
    assert.equal(reply.body.requestedUrl, url);
    assert.equal(reply.body.trust, 'untrusted');
    assert.ok(reply.body.text.includes('Status fixture body'), reply.body.text);
  }

  assert.equal(env.tasks(), tasksBefore, 'manual browsing must not create a kernel task');
  assert.equal(env.modelCalls(), 0, 'manual browsing must not call the model');
});

test('a redirect reports the final response status and final URL', { timeout: 60000 }, async t => {
  const env = await setup();
  t.after(() => env.close());

  const reply = await env.request('/v1/product/web/fetch', { url: PAGE_ORIGIN + '/moved' });
  assert.equal(reply.status, 200, reply.text);
  assert.equal(reply.body.requestedUrl, PAGE_ORIGIN + '/moved');
  assert.equal(reply.body.url, PAGE_ORIGIN + '/p206-final');
  assert.equal(reply.body.status, 206, 'the reported status must be the final response, not the redirect or a synthetic 200');
});

test('a failed source response keeps a structured error instead of a fabricated status', { timeout: 60000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const tasksBefore = env.tasks();

  const reply = await env.request('/v1/product/web/fetch', { url: PAGE_ORIGIN + '/fail503' });
  assert.equal(reply.status, 502, reply.text);
  assert.equal(typeof reply.body.code, 'string');
  assert.equal(reply.body.code, 'HTTP_FAILED');
  assert.equal(typeof reply.body.error, 'string');
  assert.ok(reply.body.error.length > 0);
  assert.equal(Object.hasOwn(reply.body as object, 'status'), false, 'a failed read must not answer a synthetic page status');
  assert.ok(env.fixture.requests.some(url => url.endsWith('/fail503')), 'the fixture transport must have been exercised');
  assert.equal(env.tasks(), tasksBefore);
  assert.equal(env.modelCalls(), 0);
});