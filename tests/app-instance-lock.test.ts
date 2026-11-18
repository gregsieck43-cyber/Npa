import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { acquireInstanceLock, AlreadyRunning } from '../src/app/instance-lock.js';

function directory(t: TestContext): string {
  const root = path.resolve('.tmp');
  const value = mkdtempSync(path.join(root, 'instance-lock-test-'));
  t.after(() => {
    assert.ok(value.startsWith(root + path.sep));
    rmSync(value, { recursive: true, force: true });
  });
  return value;
}

test('one data directory has one authority and release allows a new owner', t => {
  const dataDir = directory(t);
  const first = acquireInstanceLock(dataDir);
  try { assert.throws(() => acquireInstanceLock(dataDir), AlreadyRunning); }
  finally { first.release(); }
  const next = acquireInstanceLock(dataDir);
  next.release();
  next.release();
});

test('an abrupt owner process exit releases the native instance lock', async t => {
  const dataDir = directory(t);
  const moduleUrl = new URL('../src/app/instance-lock.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireInstanceLock } from ${JSON.stringify(moduleUrl)};
    acquireInstanceLock(process.argv[1]);
    console.log('locked');
    process.stdin.once('data', () => process.exit(23));
    process.stdin.resume();
  `, dataDir], { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', data => { stderr += String(data); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
  const output = createInterface({ input: child.stdout });
  const ready = new Promise<void>((resolve, reject) => {
    output.once('line', line => line === 'locked' ? resolve() : reject(new Error(`Unexpected child response: ${line}`)));
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Owner exited before locking: ${stderr}`)));
  });
  try {
    await ready;
    assert.throws(() => acquireInstanceLock(dataDir), AlreadyRunning);
  } finally {
    // The test fixture exits itself; the parent never signals or kills a process.
    child.stdin.end('exit');
    assert.equal(await exited, 23, stderr);
    output.close();
  }
  const recovered = acquireInstanceLock(dataDir);
  recovered.release();
});
