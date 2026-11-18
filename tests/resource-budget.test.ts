import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResourceBudget, resourceBudget, type ResourceSample } from '../src/app/resource-budget.js';
import { ModelClient } from '../src/runtime/model.js';
import { startMockProvider } from '../src/fixtures/mock-provider.js';

const sample: ResourceSample = { physicalBytes: 10000, availableBytes: 5000, limitBytes: 6000, commitBytes: 1000,
  workingSetBytes: 1000, peakCommitBytes: 1000, processes: 4, hardLimited: true };
test('resource pressure reduces admission, has hysteresis, and bounds retained state', async () => {
  let now = 100;
  const budget = new ResourceBudget(() => now);
  budget.observe(); assert.equal(budget.concurrency(), 0);
  let notifications = 0;
  const unsubscribe = budget.onPressureChanged(() => { notifications++; });
  for (let i = 0; i < 100000; i++) budget.update({ ...sample, peakCommitBytes: i });
  assert.equal(notifications, 1); unsubscribe();
  assert.equal(budget.concurrency(), 3);
  assert.ok(JSON.stringify(budget).length < 500, 'samples replace state instead of accumulating history');
  budget.update({ ...sample, commitBytes: 4000 }); assert.equal(budget.concurrency(), 1);
  budget.update({ ...sample, commitBytes: 4900 }); assert.equal(budget.concurrency(), 0);
  budget.update({ ...sample, commitBytes: 4500 }); assert.equal(budget.concurrency(), 0);
  budget.update({ ...sample, commitBytes: 4100 }); assert.equal(budget.concurrency(), 1);
  budget.update({ ...sample, availableBytes: 400 }); assert.equal(budget.concurrency(), 0);
  const controller = new AbortController();
  const pending = budget.wait(controller.signal); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  budget.update(sample); await budget.wait(); assert.equal(budget.concurrency(), 3);
  now += 15001; assert.equal(budget.status().pressure, 'unavailable');
  budget.update(sample); assert.equal(budget.concurrency(), 3);
  budget.unavailable('watcher exited'); assert.equal(budget.concurrency(), 0);
  budget.update(sample); assert.equal(budget.concurrency(), 3);
});

test('memory pressure prevents model dispatch, resumes without replay, and can be cancelled or time out', async () => {
  const mock = await startMockProvider();
  const client = new ModelClient({ mode: 'mock', baseUrl: mock.url, timeoutMs: 1000 });
  try {
    resourceBudget.update({ ...sample, commitBytes: 5000 });
    const controller = new AbortController();
    const cancelled = client.complete([{ role: 'user', content: 'hello' }], [], controller.signal);
    controller.abort(); await assert.rejects(cancelled, { code: 'cancelled' });
    assert.equal(mock.requests(), 0);
    const timeout = new ModelClient({ mode: 'mock', baseUrl: mock.url, timeoutMs: 20 });
    await assert.rejects(timeout.complete([{ role: 'user', content: 'hello' }]), { code: 'resource_pressure' });
    const resumed = client.complete([{ role: 'user', content: 'hello' }]);
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(mock.requests(), 0);
    resourceBudget.update(sample); await resumed; assert.equal(mock.requests(), 1);
  } finally { resourceBudget.update(sample); await mock.close(); }
});

test('real Windows job covers existing/new children, shares its cap, and survives the attach helper', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(process.cwd(), '.tmp', 'resource-budget-'));
  const probe = path.join(directory, 'probe.exe');
  const compiler = path.join(process.env.SystemRoot!, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const compiled = spawnSync(compiler, ['/nologo', '/platform:x64', `/out:${probe}`, path.resolve('tests/fixtures/resource-probe.cs')],
    { windowsHide: true, env: { ...process.env, TEMP: directory, TMP: directory }, encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const helper = fileURLToPath(new URL('../native/resource-budget.exe', import.meta.url));
  const module = new URL('../src/app/resource-budget.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { spawn, execFileSync } from 'node:child_process';
    import { createInterface } from 'node:readline';
    import { once } from 'node:events';
    import { attachResourceBudget, ResourceBudget } from ${JSON.stringify(module)};
    const helper = process.argv[1], probe = process.argv[2], scope = process.argv[3];
    const createProbe = async () => {
      const child = spawn(probe, [], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      const lines = createInterface({ input: child.stdout }); const closed = once(child, 'close');
      await once(lines, 'line');
      return async () => { const result = once(lines, 'line'); child.stdin.end('go\\n'); const [line] = await result; const [code] = await closed; assert.equal(code, 0, line); return JSON.parse(line); };
    };
    const existing = await createProbe();
    const budget = new ResourceBudget();
    const stop = await attachResourceBudget(helper, false, budget, { name: scope, limitBytes: 256 * 1024 * 1024 });
    const first = budget.status();
    assert.equal(first.limitBytes, 256 * 1024 * 1024);
    assert.ok(first.processes >= 2);
    assert.ok(first.commitBytes > 0 && first.commitBytes <= first.limitBytes);
    assert.ok(first.privateBytes > 0 && first.handles > 0);
    console.log(JSON.stringify({ stage: 'ready', first }));
    const control = createInterface({ input: process.stdin }); await once(control, 'line'); control.close(); process.stdin.destroy();
    const before = await existing(); const after = await (await createProbe())();
    // A separate helper opening this group cannot enlarge its existing lower limit.
    const other = JSON.parse(execFileSync(helper, ['attach', String(process.pid), scope, String(512 * 1024 * 1024)], { encoding: 'utf8', windowsHide: true }));
    assert.equal(other.limitBytes, first.limitBytes);
    stop(); await new Promise(resolve => setTimeout(resolve, 250));
    // No helper remains; the owner-held handle and membership survive until the root exits.
    const survived = await (await createProbe())();
    console.log(JSON.stringify({ first, before, after, other, survived }));
  `;
  const scope = `test-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, helper, probe, scope],
    { windowsHide: true, env: { ...process.env, TEMP: directory, TMP: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  let ready: () => void;
  const readyPromise = new Promise<void>(resolve => { ready = resolve; });
  child.stdout.setEncoding('utf8').on('data', (text: string) => { output += text; });
  child.stdout.on('data', () => { if (output.includes('\n')) ready(); });
  child.stderr.setEncoding('utf8').on('data', (text: string) => { errors += text; });
  const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  try {
    await Promise.race([readyPromise, closed.then(code => { throw new Error(`Host exited before ready (${code}): ${errors}`); })]);
    // This root is a sibling of the first host, not its descendant. Same per-user scope, same cap.
    const independent = `import { attachResourceBudget, ResourceBudget } from ${JSON.stringify(module)};
      const budget = new ResourceBudget(); await attachResourceBudget(process.argv[1], false, budget, { name: process.argv[2], limitBytes: 512 * 1024 * 1024 });
      console.log(JSON.stringify(budget.status()));`;
    const second = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', independent, helper, scope],
      { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, TEMP: directory, TMP: directory } }));
    assert.equal(second.limitBytes, 256 * 1024 * 1024); assert.ok(second.processes >= 3);
    assert.ok(second.processIds.includes(child.pid), 'independent roots must share membership, not just equal limits');
    child.stdin.end('continue\n');
    const code = await closed;
    assert.equal(code, 0, errors + output);
    const result = JSON.parse(output.trim().split('\n').at(-1)!);
    assert.equal(result.survived.largeDenied, true);
    assert.equal(result.before.smallAllowed, true);
  } finally { if (child.exitCode === null) child.kill(); await rm(directory, { recursive: true, force: true }); }
});

test('native desktop launcher applies the shared budget before entry and preserves arguments and exit status', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(process.cwd(), '.tmp', 'resource-budget-launcher-'));
  try {
    const probe = path.join(directory, 'NPN-Gamma-Desktop.exe');
    const compiler = path.join(process.env.SystemRoot!, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const env = { ...process.env, TEMP: directory, TMP: directory };
    const compiled = spawnSync(compiler, ['/nologo', '/platform:x64', `/out:${probe}`, path.resolve('tests/fixtures/resource-probe.cs')], { windowsHide: true, env, encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const launcher = path.join(directory, 'NPN-Gamma.exe');
    await copyFile(fileURLToPath(new URL('../native/resource-launcher.exe', import.meta.url)), launcher);
    const args = ['arguments', '', 'a space', '中文', 'quote"inside', 'C:\\path with spaces\\', '--data-dir', 'a\\\\"b'];
    // Match an independently launched desktop, not Node's implicit kill-on-parent job.
    const launched = spawn(launcher, args, { detached: true, windowsHide: true, env, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    launched.stdout.setEncoding('utf8').on('data', (text: string) => { output += text; });
    launched.stderr.setEncoding('utf8').on('data', (text: string) => { errors += text; });
    const status = await new Promise<number | null>((resolve, reject) => { launched.once('error', reject); launched.once('close', resolve); });
    assert.equal(status, 37, errors + output);
    const lines = output.replaceAll('\r', '').split('\n');
    assert.equal(lines.shift(), 'budgeted-before-entry'); lines.pop();
    assert.deepEqual(lines.map(line => Buffer.from(line, 'base64').toString('utf8')), args);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
