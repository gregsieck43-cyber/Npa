import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import { ProductStore } from '../src/product/store.js';
import { getEventListeners } from 'node:events';
import { randomUUID } from 'node:crypto';

test('event long poll waits without repeated requests and wakes on a committed update', { timeout: 30000 }, async () => {
  const base = path.resolve(process.env.TEMP ?? '.tmp');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'product-event-wait-'));
  const backend = await startBackend({ dataDir: path.join(root, 'data'), projectRoot: root });
  const headers = { Authorization: 'Bearer ' + backend.token };
  const url = `http://127.0.0.1:${backend.port}/v1/product/events`;
  try {
    const cursor = backend.services.product!.store.latestEventId();
    let settled = false;
    const pending = fetch(`${url}?cursor=${cursor}&waitMs=2000`, { headers }).then(async r => {
      assert.equal(r.status, 200); const page = await r.json() as any; settled = true; return page;
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(settled, false, 'idle subscription must stay pending instead of returning an empty page');
    const start = performance.now();
    backend.services.product!.store.append([{ event: { type: 'notify', tone: 'info', title: 'fresh committed event' } }]);
    const page = await pending;
    assert.equal(page.longPoll, true);
    assert.equal(page.events.at(-1)?.event.title, 'fresh committed event');
    assert.ok(performance.now() - start < 500, 'event should arrive without waiting for the one-second client timer');
    const timeoutStart = performance.now();
    const empty = await (await fetch(`${url}?cursor=${page.nextCursor}&waitMs=50`, { headers })).json() as any;
    assert.equal(empty.events.length, 0);
    assert.equal(empty.longPoll, true);
    assert.ok(performance.now() - timeoutStart >= 40);
    for (const value of ['-1', '25001', 'NaN', '1.5']) assert.equal((await fetch(`${url}?waitMs=${value}`, { headers })).status, 400);

    // A terminal Work transition has no later model call to incidentally refresh WorkTrace.
    const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
    const ack = backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace, objective: 'Wait for operator', acceptance: ['Operator verifies'] } });
    const taskId = ack.taskId!;
    backend.services.kernel.transition(taskId, 'paused');
    backend.services.harness!.workTrace.sync(taskId);
    const workCursor = backend.services.product!.store.latestEventId();
    const workRead = fetch(`${url}?cursor=${workCursor}&waitMs=800`, { headers }).then(r => r.json() as Promise<any>);
    await new Promise(resolve => setTimeout(resolve, 30));
    backend.services.kernel.transition(taskId, 'cancelled');
    const changed = await workRead;
    assert.ok(changed.events.some((entry: any) => entry.event.type === 'task.updated' && entry.event.task.status === 'cancelled'), 'held read must see Kernel transitions without a second client query: ' + JSON.stringify(changed));
    const closingRead = fetch(`${url}?cursor=${backend.services.product!.store.latestEventId()}&waitMs=15000`, { headers });
    await new Promise(resolve => setTimeout(resolve, 30));
    const closingStarted = performance.now();
    await backend.close();
    assert.equal((await closingRead).status, 503);
    assert.ok(performance.now() - closingStarted < 2000, 'shutdown must not wait for the event timeout');
  } finally {
    await backend.close();
    const relative = path.relative(base, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    rmSync(root, { recursive: true, force: true });
  }
});

test('held event readers release abort listeners, honor scope, bound slots and settle before store shutdown', async () => {
  const base = path.resolve(process.env.TEMP ?? '.tmp');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'product-event-wait-store-'));
  const store = new ProductStore(root);
  try {
    for (let index = 0; index < 100; index++) {
      const controller = new AbortController();
      const pending = store.waitEvents(0, 20, undefined, 5000, controller.signal);
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
    let settled = false;
    const scoped = store.waitEvents(0, 20, 'wanted', 1000).then(value => { settled = true; return value; });
    store.append([{ sessionId: 'other', event: { type: 'notify', tone: 'info', title: 'other' } }]);
    await Promise.resolve();
    assert.equal(settled, false);
    store.append([{ sessionId: 'wanted', event: { type: 'notify', tone: 'info', title: 'wanted' } }]);
    assert.equal((await scoped).events[0]!.event.type, 'notify');
    const cursor = store.latestEventId();
    const held = Array.from({ length: 64 }, () => store.waitEvents(cursor, 20, undefined, 10000));
    await assert.rejects(store.waitEvents(cursor, 20, undefined, 10000), /Too many live event readers/);
    const completion = Promise.allSettled(held);
    store.stopEventWaits();
    assert.ok((await completion).every(result => result.status === 'rejected'));
    await assert.rejects(store.waitEvents(cursor, 20, undefined, 10000), /closing/);
  } finally {
    store.close();
    assert.ok(root.startsWith(base + path.sep));
    rmSync(root, { recursive: true, force: true });
  }
});
