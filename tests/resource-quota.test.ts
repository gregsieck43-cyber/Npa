import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { ResourceBudget, type ResourceSample } from '../src/app/resource-budget.js';

const sample: ResourceSample = { physicalBytes: 10000, availableBytes: 5000, limitBytes: 6000,
  commitBytes: 1000, workingSetBytes: 1000, peakCommitBytes: 1000, processes: 1, processIds: [1], hardLimited: true };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
interface Quota extends ResourceBudget {
  acquire(signal?: AbortSignal): Promise<() => void>;
  withLease<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T>;
  updateExternalProcess(id: string, sample: { pid: number; workingSetBytes: number; privateBytes?: number }): void;
  removeExternalProcess(id: string): void;
}
const create = (now?: () => number) => new ResourceBudget(now) as Quota;

test('shared execution admission is FIFO, cancellable and releases every lease', async () => {
  const budget = create(); budget.update(sample);
  const gates = Array.from({ length: 5 }, latch), started: number[] = [];
  const controllers = gates.map(() => new AbortController());
  const jobs = gates.map((gate, index) => budget.withLease(controllers[index]!.signal, async () => {
    started.push(index); await gate.promise; return index;
  }));
  const cancelled = assert.rejects(jobs[3]!, { name: 'AbortError' });
  await tick(); assert.deepEqual(started, [0, 1, 2]);
  controllers[3]!.abort(); await cancelled;
  assert.equal(getEventListeners(controllers[3]!.signal, 'abort').length, 0);
  gates[0]!.release(); await tick(); assert.deepEqual(started, [0, 1, 2, 4]);
  for (const gate of gates) gate.release();
  await Promise.allSettled(jobs);
  for (const controller of controllers) assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const leases = await Promise.all([budget.acquire(), budget.acquire(), budget.acquire()]);
  for (const release of leases) { release(); release(); }
});

test('nested review reuses its lease, but detached work after release must acquire again', async () => {
  const budget = create(); budget.update({ ...sample, commitBytes: 4000 });
  const gate = latch(); let detached!: Promise<number>, complete = false;
  const value = await budget.withLease(undefined, async () => {
    detached = (async () => { await gate.promise; return budget.withLease(undefined, async () => { complete = true; return 9; }); })();
    return budget.withLease(undefined, async () => 7);
  });
  assert.equal(value, 7); await tick();
  const release = await budget.acquire();
  gate.release(); await tick(); assert.equal(complete, false); release(); assert.equal(await detached, 9);
});

test('admission and proxy registries reject unbounded accumulation and release capacity on cancellation or expiry', async () => {
  let now = 100;
  const budget = create(() => now); budget.update({ ...sample, commitBytes: 4900 });
  const controllers = Array.from({ length: 256 }, () => new AbortController());
  const pending = controllers.map(controller => budget.acquire(controller.signal));
  const settled = Promise.allSettled(pending);
  await assert.rejects(budget.acquire(), { code: 'resource_queue_full' });
  for (const controller of controllers) controller.abort();
  const results = await settled; assert.ok(results.every(result => result.status === 'rejected'));
  for (let i = 0; i < 128; i++) budget.updateExternalProcess(`proxy-${i}`, { pid: 100 + i, workingSetBytes: 1 });
  assert.throws(() => budget.updateExternalProcess('excess', { pid: 500, workingSetBytes: 1 }), /registry is full/);
  now += 15001;
  budget.updateExternalProcess('new', { pid: 501, workingSetBytes: 1 });
  budget.update(sample); await budget.withLease(undefined, async () => {});
});

test('pressure prevents new leases and recovery admits only the reduced concurrency', async () => {
  const budget = create(); budget.update(sample);
  const leases = await Promise.all([budget.acquire(), budget.acquire(), budget.acquire()]);
  budget.update({ ...sample, commitBytes: 4900 });
  let entered = 0;
  const waiting = budget.withLease(undefined, async () => { entered++; });
  leases[0]!(); leases[1]!(); await tick(); assert.equal(entered, 0);
  budget.update({ ...sample, commitBytes: 4100 }); await tick(); assert.equal(entered, 0);
  leases[2]!(); await waiting; assert.equal(entered, 1);
  await assert.rejects(budget.withLease(undefined, async () => { throw new Error('failed work'); }), /failed work/);
  await budget.withLease(undefined, async () => {});
});

test('external proxy telemetry expires, does not duplicate Job members or alter its hard ceiling', async () => {
  let now = 100;
  const budget = create(() => now); budget.update(sample);
  budget.updateExternalProcess('proxy-a', { pid: 7, workingSetBytes: 4000, privateBytes: 3000 });
  assert.equal(budget.concurrency(), 0);
  assert.equal(budget.status().limitBytes, 6000); assert.equal(budget.status().hardLimited, true);
  budget.removeExternalProcess('proxy-a'); assert.equal(budget.concurrency(), 3);
  budget.updateExternalProcess('already-in-job', { pid: 1, workingSetBytes: 4000 });
  assert.equal(budget.concurrency(), 3);
  budget.updateExternalProcess('proxy-b', { pid: 8, workingSetBytes: 4000 });
  now += 15001; assert.equal(budget.concurrency(), 3);
  assert.throws(() => budget.updateExternalProcess('invalid', { pid: 9, workingSetBytes: NaN }), /Invalid/);
  assert.throws(() => budget.updateExternalProcess('invalid', { pid: -1, workingSetBytes: 1 }), /Invalid/);
});
