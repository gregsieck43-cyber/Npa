import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Kernel } from '../src/kernel/index.js';
import { HarnessStore } from '../src/harness/store.js';
import { WorkTrace } from '../src/harness/work-trace.js';
import type { Services } from '../src/app/services.js';
import { startBackend } from '../src/app/backend.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class FixtureKernel extends Kernel { batch(action: () => void): void { this.tx(action); } }
test('current Work stream bypasses unrelated and same-task backlog without moving the continuous cursor or replaying observers', async t => {
  const base = path.resolve(process.env.TEMP!); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'trace-backlog-'));
  const kernel = new FixtureKernel(directory); let store = new HarnessStore(directory);
  let trace = new WorkTrace({ kernel } as unknown as Services, store, value => value);
  t.after(() => { (trace as any).close?.(); store.close(); kernel.close(); rmSync(directory, { recursive: true }); });
  const taskId = kernel.command({ commandId: 'create', type: 'create_task', parameters: { title: 'Current task' } }).taskId!;
  const other = kernel.command({ commandId: 'other', type: 'create_task', parameters: { title: 'Unrelated task' } }).taskId!;
  kernel.batch(() => { for (let index = 0; index < 1200; index++) kernel.appendEvent(index % 2 ? taskId : other, 'old.fixture', { index }); });
  kernel.appendEvent(taskId, 'task.paused', {});
  const observed: number[] = [], types: string[] = [];
  trace.setObserver(event => { observed.push(event.seq); if (event.taskId === taskId) types.push(event.type); });
  trace.sync();
  assert.equal(store.getSetting('kernelCursor', 0), 0, 'scheduling catch-up must not import a synchronous global batch');
  const started = kernel.appendEvent(taskId, 'model.stream.started', { messageId: 'fresh' });
  const delta = kernel.appendEvent(taskId, 'model.stream.delta', { messageId: 'fresh', text: 'current text' });
  (trace.sync as (taskId?: string) => void)(taskId);
  assert.deepEqual(observed.slice(-2), [started.seq, delta.seq]);
  assert.equal(store.getSetting('kernelCursor', 0), 0, 'out-of-order live projection must not skip old global events');
  await tick();
  const partial = store.getSetting('kernelCursor', 0);
  assert.ok(partial > 0 && partial < started.seq, 'one event-loop turn does only a small batch');
  (trace as any).close(); store.close(); store = new HarnessStore(directory);
  trace = new WorkTrace({ kernel } as unknown as Services, store, value => value);
  trace.setObserver(event => { observed.push(event.seq); if (event.taskId === taskId) types.push(event.type); });
  trace.sync();
  for (let attempt = 0; attempt < 200 && store.getSetting('kernelCursor', 0) < delta.seq; attempt++) await tick();
  assert.equal(store.getSetting('kernelCursor', 0), delta.seq);
  assert.equal(new Set(observed).size, observed.length, 'global replay and restart must not replay an imported observer');
  assert.equal(types.slice(types.indexOf('model.stream.started') + 1).includes('task.paused'), false, 'old same-task terminal history cannot terminate a fresh stream');
  let cursor = 0, count = 0;
  for (;;) { const page = store.traces({ after: cursor, limit: 100 }); count += page.events.length; if (!page.events.length) break; cursor = page.events.at(-1)!.id; }
  assert.equal(count, kernel.eventsSince(0, 1000).length + kernel.eventsSince(1000, 1000).length, 'every authoritative event remains in trace exactly once');
  kernel.appendEvent(taskId, 'after.close.fixture', {});
  trace.sync(); trace.close(); await tick();
  assert.equal(store.getSetting('kernelCursor', 0), delta.seq, 'close cancels the pending catch-up callback');
});

test('HTTP send, current streaming and pause remain available while historical projection is behind', async t => {
  const base = path.resolve(process.env.TEMP!); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'trace-http-')), dataDir = path.join(directory, 'data');
  const seed = new FixtureKernel(dataDir);
  const taskId = seed.command({ commandId: 'create-http', type: 'create_task', parameters: { title: 'Current HTTP task', objective: 'Await current input', initialStatus: 'paused', workspace: directory } }).taskId!;
  seed.batch(() => { for (let index = 0; index < 1200; index++) seed.appendEvent(taskId, 'old.http.fixture', { index }); });
  seed.appendEvent(taskId, 'task.paused', {}); seed.close();
  const backend = await startBackend({ dataDir, projectRoot: directory, mockOptions: { responder: () => ({ content: 'fixture' }) } });
  t.after(async () => { await backend.close(); rmSync(directory, { recursive: true }); });
  await backend.services.runner.stop();
  const kernel = backend.services.kernel, store = backend.services.harness!.store;
  store.setSetting('kernelCursor', 0);
  const original = kernel.traceEventsSince.bind(kernel), counts: number[] = [];
  t.mock.method(kernel, 'traceEventsSince', (after: number, limit: number) => { counts.push(limit); assert.ok(limit <= 16); return original(after, limit); });
  const request = async (method: string, route: string, body?: unknown) => {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${backend.port}/v1/product${route}`, { method,
      headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json() as any; assert.equal(response.status, 200, JSON.stringify(result));
    return { result, elapsed: performance.now() - started };
  };
  const sent = await request('POST', '/chat/send', { sessionId: taskId, mode: 'cowork', text: 'Current input', attachments: [], permission: 'ask', modelId: 'default' });
  assert.equal(sent.result.sessionId, taskId);
  assert.ok(store.getSetting('kernelCursor', 0) < 1200, 'send does not need the old prefix to finish');
  if (kernel.getTask(taskId)!.status === 'paused') kernel.command({ commandId: 'resume-http', type: 'resume', taskId });
  kernel.transition(taskId, 'running');
  kernel.appendEvent(taskId, 'model.stream.started', { messageId: 'fresh-http' });
  for (let index = 0; index < 40; index++) kernel.appendEvent(taskId, 'model.stream.delta', { messageId: 'fresh-http', text: `Fresh live text ${index}` });
  const current = await request('GET', `/events?sessionId=${taskId}&limit=200`);
  assert.ok(current.result.events.some((row: any) => row.event.type === 'message.upsert' && row.event.message.id === 'fresh-http' && row.event.message.status === 'streaming'));
  assert.ok(current.result.events.some((row: any) => row.event.type === 'message.upsert' && row.event.message.id === 'fresh-http' && JSON.stringify(row.event.message.parts).includes('Fresh live text 39')), 'the newest cumulative delta retains identity when started is outside the priority window');
  kernel.appendEvent(taskId, 'model.stream.completed', { messageId: 'fresh-http', requestId: 'fixture-current-request' });
  kernel.addMessage(taskId, 'assistant', 'Fresh live text 39', 'main', { id: 'fresh-http', requestId: 'fixture-current-request' });
  const completed = await request('GET', `/events?sessionId=${taskId}&limit=200&cursor=${current.result.nextCursor}`);
  const done = completed.result.events.filter((row: any) => row.event.type === 'message.upsert' && row.event.message.id === 'fresh-http' && row.event.message.status === 'done');
  assert.equal(done.length, 1); assert.equal(done[0].event.message.requestId, 'fixture-current-request');
  const paused = await request('POST', `/tasks/${taskId}/control`, { action: 'pause' });
  assert.equal(kernel.getTask(taskId)!.status, 'paused');
  assert.ok(counts.length > 0);
  t.diagnostic(JSON.stringify({ sendMs: sent.elapsed, pauseMs: paused.elapsed, maxGlobalBatch: Math.max(...counts), historicalCursor: store.getSetting('kernelCursor', 0) }));
});

test('an oversized historical event leaves an explicit projection diagnostic and does not skip the global cursor', async t => {
  const base = path.resolve(process.env.TEMP!); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'trace-oversize-')), kernel = new Kernel(directory), store = new HarnessStore(directory);
  const taskId = kernel.command({ commandId: 'create', type: 'create_task', parameters: { title: 'Oversized history' } }).taskId!;
  const trace = new WorkTrace({ kernel } as unknown as Services, store, value => value);
  t.after(() => { trace.close(); store.close(); kernel.close(); rmSync(directory, { recursive: true }); });
  kernel.appendEvent(taskId, 'oversized.fixture', { text: 'x'.repeat(1100 * 1024) });
  assert.throws(() => trace.sync(taskId), /exceeds.*page budget/);
  trace.sync(); await tick();
  assert.match(store.getSetting<{ message: string } | null>('workTraceError', null)?.message ?? '', /exceeds.*page budget/);
  assert.equal(store.getSetting('kernelCursor', 0), 0);
});

test('out-of-order import is atomic and does not advance the global history cursor', t => {
  const base = path.resolve(process.env.TEMP!); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'trace-import-')), store = new HarnessStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  let imports = 0;
  assert.equal(store.importEvent(100, () => { imports++; }), true);
  assert.equal(store.getSetting('kernelCursor', 0), 0);
  assert.equal(store.importEvent(100, () => { imports++; }), false);
  assert.equal(imports, 1);
  assert.throws(() => store.importEvent(101, () => { throw new Error('interrupted import'); }));
  assert.equal(store.importEvent(101, () => { imports++; }), true);
  assert.equal(imports, 2);
});
