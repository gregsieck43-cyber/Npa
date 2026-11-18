import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// The preloader is a source script, not a compiled/runtime application module.
const { withTestLoopbackConnections } = await import(pathToFileURL(path.resolve('scripts/test-loopback-http.mjs')).href) as {
  withTestLoopbackConnections(implementation: typeof fetch): typeof fetch;
};

test('loopback test transport preserves request data and caller connection policy', async () => {
  const calls: { input: Parameters<typeof fetch>[0]; init?: RequestInit }[] = [];
  const client = withTestLoopbackConnections(async (input, init) => { calls.push({ input, init }); return new Response('ok'); });
  const controller = new AbortController(), body = new Uint8Array([1, 2, 3]);
  const headers = new Headers({ authorization: 'Bearer demo-only', 'content-type': 'application/octet-stream' });
  const options = { method: 'POST', body, headers, signal: controller.signal };
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    await client(`http://${host}:12345/fixture`, options);
    const sent = calls.at(-1)!.init!;
    assert.equal(sent.body, body); assert.equal(sent.signal, controller.signal); assert.equal(sent.method, 'POST');
    assert.equal(new Headers(sent.headers).get('authorization'), 'Bearer demo-only');
    assert.equal(new Headers(sent.headers).get('content-type'), 'application/octet-stream');
    assert.equal(new Headers(sent.headers).get('connection'), 'close');
  }
  assert.equal(headers.has('connection'), false, 'the caller header object must not be mutated');
  for (const connection of ['keep-alive', 'close']) {
    const explicit = { ...options, headers: { Connection: connection } };
    await client('http://127.0.0.1:12345/fixture', explicit);
    assert.equal(calls.at(-1)!.init, explicit);
  }
  const request = new Request('http://localhost:12345/fixture', { method: 'POST', body: 'owned body', headers: { authorization: 'Bearer owned-request' }, signal: controller.signal });
  await client(request);
  assert.equal(calls.at(-1)!.input, request); assert.equal(request.bodyUsed, false);
  assert.equal(new Headers(calls.at(-1)!.init!.headers).get('authorization'), 'Bearer owned-request');
  assert.equal(await request.text(), 'owned body');
  const reuse = new Request('http://localhost:12345/fixture', { headers: { Connection: 'keep-alive' } });
  await client(reuse); assert.equal(calls.at(-1)!.init, undefined);
  for (const url of ['https://localhost/fixture', 'http://example.invalid/fixture', 'http://localhost.example.invalid/fixture']) {
    await client(url, options); assert.equal(calls.at(-1)!.init, options);
  }
});

test('loopback test transport never retries a failed mutation', async () => {
  let calls = 0;
  const failure = new Error('owned transport failure');
  const client = withTestLoopbackConnections(async () => { calls++; throw failure; });
  await assert.rejects(client('http://127.0.0.1:12345/fixture', { method: 'POST', body: 'one mutation' }), error => error === failure);
  assert.equal(calls, 1);
});

test('loopback test transport reaches a real server once and honors abort signals', { timeout: 10000 }, async t => {
  const observed: { body: string; authorization?: string; connection?: string }[] = [];
  let receivedAbort!: () => void;
  const abortArrived = new Promise<void>(resolve => { receivedAbort = resolve; });
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    observed.push({ body, authorization: request.headers.authorization, connection: request.headers.connection });
    if (request.url === '/abort') { receivedAbort(); return; }
    response.end('ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await (await fetch(url, { method: 'POST', body: 'owned body', headers: { authorization: 'Bearer demo-only' } })).text();
  assert.deepEqual(observed, [{ body: 'owned body', authorization: 'Bearer demo-only', connection: 'close' }]);
  await (await fetch(url, { headers: { Connection: 'keep-alive' } })).text();
  assert.equal(observed.at(-1)!.connection, 'keep-alive');
  const controller = new AbortController();
  const pending = fetch(`${url}/abort`, { method: 'POST', body: 'abortable body', signal: controller.signal });
  await abortArrived; controller.abort();
  await assert.rejects(pending, error => (error as Error).name === 'AbortError');
  assert.equal(observed.length, 3, 'no duplicate request after cancellation');
});
