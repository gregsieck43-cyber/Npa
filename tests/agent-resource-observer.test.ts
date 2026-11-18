import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const helperUrl = pathToFileURL(path.resolve('scripts/endurance-resources.mjs')).href;
const { assessResourceTrend } = await import(helperUrl);
const MiB = 1024 * 1024;

function samples(growth = 0) {
  return Array.from({ length: 20 }, (_, i) => ({ stage: i + 1, forcedGc: true,
    afterGc: { rss: 100 * MiB + (i % 2) * 128 * 1024, heapUsed: 8 * MiB + i * growth, external: MiB, arrayBuffers: 64 * 1024 },
    activeResources: { PipeWrap: 2 }, libuvHandles: { pipe: 2 }, children: { active: 0 },
  }));
}

test('post-warmup assessment accepts a plateau but rejects retained growth far below 12 GB', () => {
  const plateau = assessResourceTrend(samples());
  assert.equal(plateau.ok, true);
  assert.equal(plateau.trends.heapUsed.slopeBytesPerStage, 0);
  assert.equal(plateau.measuredStages.length, 15);
  const leaking = assessResourceTrend(samples(512 * 1024));
  assert.equal(leaking.ok, false);
  assert.ok(leaking.failures.includes('heapUsed-retained-growth'));
  assert.ok(leaking.failures.includes('heapUsed-positive-slope'));
  assert.ok(leaking.trends.heapUsed.maxBytes < 20 * MiB);
});

test('missing GC, missing metrics, insufficient stages and growing resources cannot silently pass', () => {
  const noGc = samples(); noGc[9]!.forcedGc = false;
  assert.ok(assessResourceTrend(noGc).failures.includes('forced-gc-unavailable'));
  assert.ok(assessResourceTrend(samples().slice(0, 6)).failures.includes('insufficient-post-warmup-samples'));
  const unobserved = samples(); unobserved[8]!.afterGc.external = NaN;
  assert.ok(assessResourceTrend(unobserved).failures.includes('external-unobserved'));
  const handles = samples(); handles[19]!.libuvHandles.pipe = 3;
  assert.ok(assessResourceTrend(handles).failures.includes('stage-20-libuvHandles-pipe-growth'));
  const children = samples(); children[19]!.children.active = 1;
  assert.ok(assessResourceTrend(children).failures.includes('stage-20-child-still-active'));
});

test('RSS and external buffers are assessed independently from V8 retained heap', () => {
  const external = samples();
  for (const sample of external) sample.afterGc.external += sample.stage * 512 * 1024;
  const result = assessResourceTrend(external);
  assert.ok(result.failures.includes('external-positive-slope'));
  assert.equal(result.trends.heapUsed.growthBytes, 0);
  const rss = samples();
  for (const sample of rss) sample.afterGc.rss += sample.stage * 5 * MiB;
  assert.ok(assessResourceTrend(rss).failures.includes('rss-positive-slope'));
});

test('test-only observer measures real live/closed children and pre/post-GC memory without creating a diagnostic report', () => {
  const program = `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { captureResourceSample, observeChildProcesses } from ${JSON.stringify(helperUrl)};
    const observer = observeChildProcesses();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
    assert.equal(observer.snapshot().active, 1);
    assert.equal(await observer.settle(20), false);
    child.kill();
    assert.equal(await observer.settle(5000), true);
    const sample = await captureResourceSample(1, observer);
    assert.equal(sample.forcedGc, true);
    assert.equal(sample.children.spawned, 1); assert.equal(sample.children.closed, 1);
    assert.equal(sample.children.active, 0);
    for (const key of ['rss','heapUsed','external','arrayBuffers']) {
      assert.ok(Number.isFinite(sample.beforeGc[key])); assert.ok(Number.isFinite(sample.afterGc[key]));
    }
    assert.ok(sample.activeResources && sample.libuvHandles);
    assert.ok(sample.heapSpaces.length > 0 && Number.isFinite(sample.heapSpacePhysicalBytes));
    observer.restore();
    process.stdout.write(JSON.stringify({ ok: true, memoryFields: Object.keys(sample.afterGc), children: sample.children }));
  `;
  const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', program], {
    cwd: process.cwd(), env: process.env, windowsHide: true, timeout: 15_000, encoding: 'utf8', maxBuffer: 64 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).ok, true);
});
