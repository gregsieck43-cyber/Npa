import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import { BackendClient } from '../src/extensions/client.js';
import { resourceBudget } from '../src/app/resource-budget.js';

test('proxy observer reports only its own PID/RSS and unregisters exactly once', async t => {
  const reports: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-token');
    let body = '';
    for await (const chunk of request) body += chunk;
    reports.push(JSON.parse(body));
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"recorded":true}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as { port: number }).port;
  const client = new BackendClient({ dataDir: '.', baseUrl: `http://127.0.0.1:${port}`, token: 'fixture-token' });
  const stop = await client.observeOwnResources('cli');
  await stop(); await stop();
  assert.equal(reports.length, 2, 'a repeated lifecycle cleanup must not send a second unregister');
  assert.equal(reports[0]!.pid, process.pid);
  assert.equal(reports[0]!.kind, 'cli');
  assert.match(String(reports[0]!.id), /^cli-[0-9a-f-]{36}$/);
  assert.ok(Number.isSafeInteger(reports[0]!.workingSetBytes) && Number(reports[0]!.workingSetBytes) > 0);
  assert.deepEqual(Object.keys(reports[0]!).sort(), ['id', 'kind', 'pid', 'workingSetBytes']);
  assert.deepEqual(reports[1], { id: reports[0]!.id, kind: 'cli', pid: process.pid, remove: true });
});

test('a slow proxy heartbeat stays single-flight and shutdown cancels it before unregistering', async t => {
  const originalInterval = globalThis.setInterval;
  let tick!: () => void;
  t.mock.method(globalThis, 'setInterval', ((callback: () => void, interval: number) => {
    assert.equal(interval, 5000); tick = callback;
    return originalInterval(() => {}, 1_000_000);
  }) as typeof setInterval);
  const client = new BackendClient({ dataDir: '.' });
  const calls: { body: Record<string, unknown>; signal?: AbortSignal }[] = [];
  const transport = client as unknown as { request(method: string, route: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> };
  t.mock.method(transport, 'request', async (_method: string, route: string, body: Record<string, unknown>, signal?: AbortSignal) => {
    assert.equal(route, '/v1/resources/proxy'); calls.push({ body, signal });
    if (calls.length !== 2) return { recorded: true };
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  });
  const stop = await client.observeOwnResources('mcp');
  t.after(stop);
  tick(); tick(); tick();
  assert.equal(calls.length, 2, 'only one heartbeat may remain in flight');
  await Promise.all([stop(), stop()]);
  assert.equal(calls[1]!.signal!.aborted, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.body.remove, true);
  tick();
  assert.equal(calls.length, 3, 'an expired interval callback cannot restart reporting');
});

test('proxy telemetry authentication and identity do not grant control of native limits', async t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp/hardening-011-reconciliation'); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'proxy-'));
  const backend = await startBackend({ dataDir: path.join(directory, 'data'), projectRoot: directory });
  const id = 'cli-fixture-identity';
  t.after(async () => { resourceBudget.removeExternalProcess(id); await backend.close(); rmSync(directory, { recursive: true }); });
  const submit = (body: unknown, authenticated = true) => fetch(`http://127.0.0.1:${backend.port}/v1/resources/proxy`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${backend.token}` } : {}) }, body: JSON.stringify(body) });
  const before = resourceBudget.status();
  assert.equal((await submit({ id, kind: 'cli', pid: process.pid, workingSetBytes: 100 }, false)).status, 401);
  assert.equal(resourceBudget.status().externalProcesses, before.externalProcesses);
  assert.equal((await submit({ id, kind: 'cli', pid: process.pid, workingSetBytes: 100, hardLimited: true, limitBytes: 1 })).status, 200);
  assert.equal(resourceBudget.status().hardLimited, before.hardLimited);
  assert.equal(resourceBudget.status().limitBytes, before.limitBytes);
  assert.equal((await submit({ id, kind: 'cli', pid: process.pid + 10_000_000, workingSetBytes: 200 })).status, 400, 'an active proxy identity cannot change PID');
  assert.equal((await submit({ id, kind: 'cli', pid: process.pid + 10_000_000, remove: true })).status, 400, 'a different PID cannot unregister that identity');
  assert.equal((await submit({ id, kind: 'cli', pid: process.pid, remove: true })).status, 200);
  assert.equal(resourceBudget.status().externalProcesses, before.externalProcesses);
});
