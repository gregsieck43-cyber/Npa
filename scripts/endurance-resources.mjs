// Test-only observability. No production runtime depends on this module or explicit GC.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { getHeapSpaceStatistics } from 'node:v8';

const MiB = 1024 * 1024;
export const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  warmupStages: 5, minimumSamples: 12, window: 3,
  // Retained JS/buffers should plateau; RSS has a larger allocator/SQLite tolerance.
  heapUsed: { growth: 4 * MiB, slope: 256 * 1024 },
  external: { growth: 4 * MiB, slope: 128 * 1024 },
  arrayBuffers: { growth: 2 * MiB, slope: 64 * 1024 },
  rss: { growth: 48 * MiB, slope: 2 * MiB },
});

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function counts(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

/** All samples must be observed, post-GC and from distinct increasing equal-work stages. */
export function assessResourceTrend(samples, limits = DEFAULT_RESOURCE_LIMITS) {
  const measured = samples.filter(sample => sample.stage > limits.warmupStages);
  const failures = [], trends = {};
  if (measured.length < limits.minimumSamples) failures.push('insufficient-post-warmup-samples');
  if (samples.some((sample, index) => !Number.isSafeInteger(sample.stage) || (index > 0 && sample.stage <= samples[index - 1].stage))) failures.push('invalid-stage-order');
  if (samples.some(sample => sample.forcedGc !== true)) failures.push('forced-gc-unavailable');
  for (const key of ['rss', 'heapUsed', 'external', 'arrayBuffers']) {
    if (!measured.length || measured.some(sample => !Number.isFinite(sample.afterGc?.[key]) || sample.afterGc[key] < 0)) {
      failures.push(key + '-unobserved'); continue;
    }
    const values = measured.map(sample => sample.afterGc[key]), stages = measured.map(sample => sample.stage);
    const xMean = mean(stages), yMean = mean(values), denominator = stages.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
    const slope = denominator ? stages.reduce((sum, value, i) => sum + (value - xMean) * (values[i] - yMean), 0) / denominator : 0;
    const growth = mean(values.slice(-limits.window)) - mean(values.slice(0, limits.window));
    trends[key] = { samples: values.length, firstWindowMean: mean(values.slice(0, limits.window)), lastWindowMean: mean(values.slice(-limits.window)),
      growthBytes: growth, slopeBytesPerStage: slope, minBytes: Math.min(...values), maxBytes: Math.max(...values), limits: limits[key] };
    if (growth > limits[key].growth) failures.push(key + '-retained-growth');
    if (slope > limits[key].slope) failures.push(key + '-positive-slope');
  }
  const baseline = measured[0];
  for (const sample of measured) {
    if (sample.children?.active !== 0) failures.push(`stage-${sample.stage}-child-still-active`);
    if (!sample.activeResources || !sample.libuvHandles) { failures.push(`stage-${sample.stage}-handles-unobserved`); continue; }
    for (const field of ['activeResources', 'libuvHandles']) {
      for (const [kind, count] of Object.entries(sample[field])) {
        if (count > (baseline?.[field]?.[kind] ?? 0)) failures.push(`stage-${sample.stage}-${field}-${kind}-growth`);
      }
    }
  }
  return { ok: failures.length === 0, limits, measuredStages: measured.map(sample => sample.stage), trends, failures: [...new Set(failures)] };
}

/** Instrument only this validation process, before loading ToolGateway's named spawn import. */
export function observeChildProcesses() {
  const original = childProcess.spawn, active = new Set();
  let spawned = 0, closed = 0, peakActive = 0;
  const wrapped = function (...args) {
    const child = original.apply(this, args);
    spawned++; active.add(child); peakActive = Math.max(peakActive, active.size);
    child.once('close', () => { closed++; active.delete(child); });
    return child;
  };
  childProcess.spawn = wrapped;
  syncBuiltinESMExports();
  return {
    snapshot: () => ({ spawned, closed, active: active.size, peakActive, activePids: [...active].map(child => child.pid).filter(Number.isInteger) }),
    async settle(timeoutMs = 3000) {
      const deadline = performance.now() + timeoutMs;
      while (active.size && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      return active.size === 0;
    },
    restore() {
      if (childProcess.spawn !== wrapped) throw new Error('Another observer replaced child_process.spawn');
      childProcess.spawn = original; syncBuiltinESMExports();
    },
  };
}

export async function captureResourceSample(stage, children) {
  await children.settle();
  await new Promise(resolve => setImmediate(resolve));
  const beforeGc = process.memoryUsage(), forcedGc = typeof globalThis.gc === 'function';
  if (forcedGc) {
    globalThis.gc();
    await new Promise(resolve => setImmediate(resolve));
    globalThis.gc();
  }
  const afterGc = process.memoryUsage();
  const heapSpaces = getHeapSpaceStatistics();
  // Extract only libuv counts; never write a diagnostic report containing env/configuration.
  const report = process.report.getReport();
  const activeResources = counts(process.getActiveResourcesInfo());
  const libuvHandles = counts(report.libuv.filter(handle => handle.is_active && handle.is_referenced).map(handle => handle.type));
  return { stage, elapsedMs: Math.round(performance.now()), forcedGc, beforeGc, afterGc, heapSpaces,
    heapSpacePhysicalBytes: heapSpaces.reduce((sum, space) => sum + space.physical_space_size, 0),
    activeResources, libuvHandles, children: children.snapshot() };
}
