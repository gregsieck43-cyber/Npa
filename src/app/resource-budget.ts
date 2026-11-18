import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export interface ResourceSample {
  physicalBytes: number; availableBytes: number; limitBytes: number; commitBytes: number;
  peakCommitBytes: number; workingSetBytes: number; processes: number; processIds?: number[]; hardLimited: boolean;
  handles?: number; privateBytes?: number;
}
export type ResourcePressure = 'normal' | 'reduced' | 'critical' | 'unavailable';
export interface ExternalResourceSample { pid: number; workingSetBytes: number; privateBytes?: number }
interface Waiter { signal?: AbortSignal; abort: () => void; resolve: (release: () => void) => void; reject: (error: unknown) => void }
const EXTERNAL_TTL_MS = 15000, MAX_EXTERNAL_PROCESSES = 128, MAX_WAITERS = 256;

/** One current sample, no per-process history retained over the application's lifetime. */
export class ResourceBudget {
  private sample?: ResourceSample;
  private sampledAt = 0;
  private pressure: ResourcePressure = 'normal';
  private failure?: string;
  private monitoring = false;
  private readonly listeners = new Set<() => void>();
  private readonly leaseContext = new AsyncLocalStorage<{ active: boolean }>();
  private active = 0;
  private readonly queue: Waiter[] = [];
  private wake?: ReturnType<typeof setTimeout>;
  private readonly external = new Map<string, ExternalResourceSample & { at: number }>();
  constructor(private readonly now = Date.now) {}
  update(sample: ResourceSample) {
    const before = this.currentPressure();
    this.sample = sample; this.sampledAt = this.now(); this.failure = undefined;
    this.changed(before);
  }
  private externalTotals() {
    const ids = new Set(this.sample?.processIds), totals = { workingSetBytes: 0, privateBytes: 0, processes: 0 };
    for (const [id, sample] of this.external) {
      if (this.now() - sample.at > EXTERNAL_TTL_MS) { this.external.delete(id); continue; }
      if (ids.has(sample.pid)) continue;
      ids.add(sample.pid); totals.processes++;
      totals.workingSetBytes += sample.workingSetBytes; totals.privateBytes += sample.privateBytes ?? 0;
    }
    return totals;
  }
  private currentPressure(): ResourcePressure {
    if (this.failure || (this.monitoring && (!this.sample || this.now() - this.sampledAt > 15000))) return 'unavailable';
    if (!this.sample) return 'normal';
    const external = this.externalTotals();
    const fraction = Math.max(this.sample.commitBytes + external.privateBytes, this.sample.workingSetBytes + external.workingSetBytes) / this.sample.limitBytes;
    const available = this.sample.availableBytes / this.sample.physicalBytes;
    // Hysteresis keeps dispatch from oscillating at the boundary. The hard job cap is independent.
    if (fraction >= .8 || available <= .05 || (this.pressure === 'critical' && (fraction >= .7 || available <= .08))) this.pressure = 'critical';
    else this.pressure = fraction >= .65 || available <= .10 ? 'reduced' : 'normal';
    return this.pressure;
  }
  private changed(before: ResourcePressure) {
    if (before !== this.currentPressure()) for (const listener of this.listeners) listener();
    this.drain();
  }
  observe() { this.monitoring = true; }
  unavailable(reason: string) {
    const before = this.currentPressure(); this.failure = reason; this.changed(before);
  }
  onPressureChanged(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  status() {
    const external = this.externalTotals(), memory = process.memoryUsage();
    return { hardLimited: false, ...this.sample, sampledAt: this.sampledAt || undefined, pressure: this.currentPressure(),
      observedWorkingSetBytes: (this.sample?.workingSetBytes ?? 0) + external.workingSetBytes,
      externalWorkingSetBytes: external.workingSetBytes, externalPrivateBytes: external.privateBytes, externalProcesses: external.processes,
      nodeMemory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external, arrayBuffers: memory.arrayBuffers },
      activeLeases: this.active, waitingLeases: this.queue.length,
      monitoring: this.monitoring, ...(this.failure ? { error: this.failure } : {}), metric: 'job-committed-memory', maximumHostFraction: .6, maximumBytes: 8 * 1024 ** 3 };
  }
  concurrency(): number { const pressure = this.currentPressure(); return pressure === 'normal' ? 3 : pressure === 'reduced' ? 1 : 0; }
  /** Authenticated local callers self-report telemetry; this is not OS identity proof or Job authority. */
  updateExternalProcess(id: string, sample: ExternalResourceSample): void {
    if (!id || id.length > 200 || !Number.isSafeInteger(sample.pid) || sample.pid <= 0
      || !Number.isSafeInteger(sample.workingSetBytes) || sample.workingSetBytes < 0
      || (sample.privateBytes !== undefined && (!Number.isSafeInteger(sample.privateBytes) || sample.privateBytes < 0))) throw new Error('Invalid external resource sample.');
    const before = this.currentPressure(); this.externalTotals();
    if (this.external.has(id) && this.external.get(id)!.pid !== sample.pid) throw new Error('A live proxy resource identity cannot change its process.');
    if (!this.external.has(id) && this.external.size >= MAX_EXTERNAL_PROCESSES) throw new Error('External resource registry is full.');
    this.external.set(id, { ...sample, at: this.now() }); this.changed(before);
  }
  removeExternalProcess(id: string, expectedPid?: number): void {
    const registered = this.external.get(id);
    if (registered && expectedPid !== undefined && registered.pid !== expectedPid) throw new Error('External resource identity cannot change PID.');
    const before = this.currentPressure(); this.external.delete(id); this.changed(before);
  }
  /** Raw leases are useful at explicit lifecycle boundaries. Prefer withLease for nested model calls. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.queue.length >= MAX_WAITERS) return Promise.reject(Object.assign(new Error('Execution admission queue is full.'), { code: 'resource_queue_full' }));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject, abort: () => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1); signal?.removeEventListener('abort', waiter.abort);
        reject(signal?.reason); this.drain();
      } };
      this.queue.push(waiter); signal?.addEventListener('abort', waiter.abort, { once: true }); this.drain();
    });
  }
  async withLease<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (this.leaseContext.getStore()?.active) return action();
    const release = await this.acquire(signal), context = { active: true };
    try { signal?.throwIfAborted(); return await this.leaseContext.run(context, action); }
    finally { context.active = false; release(); }
  }
  private drain() {
    if (this.wake) { clearTimeout(this.wake); this.wake = undefined; }
    while (this.queue.length && this.active < this.concurrency()) {
      const waiter = this.queue.shift()!; waiter.signal?.removeEventListener('abort', waiter.abort);
      this.active++; let released = false;
      waiter.resolve(() => { if (!released) { released = true; this.active--; this.drain(); } });
    }
    // Only pending admission owns this timer. It also observes expiring proxy heartbeats.
    if (this.queue.length) this.wake = setTimeout(() => { this.wake = undefined; this.drain(); }, 500);
  }
  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    while (this.concurrency() === 0) await delay(500, undefined, { signal });
    signal?.throwIfAborted();
  }
}
export const resourceBudget = new ResourceBudget();

/** Called only by native launch entries; test fixtures that instantiate Services do not attach their test host. */
export async function attachResourceBudget(helper: string, watch = false, budget = resourceBudget,
  testScope?: { name: string; limitBytes: number }): Promise<() => void> {
  if (process.platform !== 'win32') { budget.unavailable('Native memory limit requires Windows.'); return () => {}; }
  const args = [watch ? 'watch' : 'attach', String(process.pid), ...(testScope ? [testScope.name, String(testScope.limitBytes)] : [])];
  if (watch) budget.observe();
  const restartDelays = [250, 1000, 4000];
  let child: ReturnType<typeof spawn> | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined, shutdown: ReturnType<typeof setTimeout> | undefined;
  let restarts = 0, closing = false, published = false;
  const close = () => {
    if (closing) return;
    closing = true; clearTimeout(retry); clearTimeout(timeout);
    if (watch) budget.unavailable('Resource monitoring stopped.');
    if (child) {
      const stopping = child; stopping.stdin?.end();
      shutdown = setTimeout(() => { stopping.kill(); }, 1000); shutdown.unref();
    }
  };
  await new Promise<void>((resolve, reject) => {
    const start = () => {
      if (closing) return;
      // Keep the durable shared Job outside libuv's kill-on-parent-close Job.
      const current = spawn(helper, args, { detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); child = current;
      let buffer = '', errorText = '', ready = false, failure: Error | undefined;
      const fail = (error: Error) => {
        if (failure || closing) return;
        failure = error; clearTimeout(timeout); budget.unavailable(error.message); current.kill();
      };
      const armTimeout = (ms: number) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fail(new Error('Resource guard sample timed out.')), ms);
        if (published) timeout.unref();
      };
      armTimeout(10000);
      current.stdin.on('error', () => { /* error/close reports helper lifetime, not pipe shutdown. */ });
      current.stderr.setEncoding('utf8'); current.stderr.on('data', (chunk: string) => { errorText = (errorText + chunk).slice(-4096); });
      current.stdout.setEncoding('utf8');
      current.stdout.on('data', (chunk: string) => {
        if (failure || closing) return;
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          // Bound each frame, including its terminator, rather than the pipe's arbitrary chunk size.
          if (end + 1 > 8192) { fail(new Error('Resource guard response too large.')); return; }
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const sample = JSON.parse(line) as ResourceSample;
            if (!sample.hardLimited || !Number.isFinite(sample.physicalBytes) || sample.physicalBytes <= 0
              || !Number.isFinite(sample.limitBytes) || sample.limitBytes <= 0 || sample.limitBytes > sample.physicalBytes * .6
              || [sample.commitBytes, sample.workingSetBytes, sample.availableBytes, sample.peakCommitBytes, sample.processes].some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid resource guard sample.');
            budget.update(sample); ready = true; clearTimeout(timeout);
            if (watch) {
              published = true; resolve(); armTimeout(15000);
              current.unref();
              for (const pipe of [current.stdin, current.stdout, current.stderr]) (pipe as typeof pipe & { unref?: () => void }).unref?.();
            }
          } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
        }
        if (buffer.length > 8192) { fail(new Error('Resource guard response too large.')); return; }
      });
      current.once('error', fail);
      current.once('close', code => {
        clearTimeout(timeout); clearTimeout(shutdown); child = undefined;
        if (closing) return;
        if (!watch && code === 0 && ready && !failure) { published = true; resolve(); return; }
        const reason = failure?.message ?? (errorText.trim() || 'Resource guard stopped.');
        if (watch && restarts < restartDelays.length) {
          budget.unavailable(`${reason} Restarting resource monitor.`);
          retry = setTimeout(start, restartDelays[restarts++]!); if (published) retry.unref();
        } else {
          const error = new Error(watch ? `${reason} Resource monitor restart limit reached.` : reason);
          budget.unavailable(error.message); if (!published) reject(error);
        }
      });
    };
    start();
  });
  return close;
}
