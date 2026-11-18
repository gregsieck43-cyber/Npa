import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ToolGateway } from '../src/tools/gateway.js';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

async function fixture() {
  const directory = await mkdtemp(path.join(process.cwd(), '.tmp', 'runtime-test-'));
  const workspace = path.join(directory, 'workspace'); await mkdir(workspace);
  const gateway = new ToolGateway({ workspace, receiptDirectory: path.join(directory, 'receipts') });
  return { directory, workspace, gateway, close: () => rm(directory, { recursive: true, force: true }) };
}

test('cancelling during async worker setup does not dispatch an approved write', async () => {
  const f = await fixture();
  try {
    const prepared = await f.gateway.prepare({ name: 'write_file', arguments: { path: 'cancelled.txt', content: 'must not be written' } });
    const controller = new AbortController();
    const pending = f.gateway.execute(prepared, { effectKey: 'setup-cancel', approvedDigest: prepared.digest, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /cancelled before dispatch/);
    await assert.rejects(readFile(path.join(f.workspace, 'cancelled.txt')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('overflowing worker output requests only one termination while shutdown is pending', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  const originalSpawn = childProcess.spawn;
  let terminations = 0;
  try {
    const worker = path.join(f.directory, 'flood-worker.mjs');
    await writeFile(worker, "process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('x'.repeat(8000000)); });");
    // Model an asynchronous OS termination: keep consuming the finite real worker's pipe,
    // without spawning scores of taskkill processes just to demonstrate the regression.
    childProcess.spawn = ((executable: string, ...args: any[]) => {
      if (path.basename(executable).toLowerCase() === 'taskkill.exe') { terminations++; return new EventEmitter(); }
      return (originalSpawn as any)(executable, ...args);
    }) as typeof originalSpawn;
    syncBuiltinESMExports();
    const gateway = new ToolGateway({ workspace: f.workspace, receiptDirectory: path.join(f.directory, 'receipts'), workerPath: worker });
    const outcome = await gateway.queryOutcome('flood');
    assert.equal(outcome.status, 'unknown');
    assert.equal(terminations, 1, 'one overflowing pipe must not spawn a terminator per chunk');
  } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); await f.close(); }
});
test('worker write receipt is idempotent and digest approval binds exact content', async () => {
  const f = await fixture();
  try {
    const prepared = await f.gateway.prepare({ name: 'write_file', arguments: { path: 'output/result.txt', content: 'hello' } });
    await assert.rejects(f.gateway.execute(prepared, { effectKey: 'write' }), /approval/);
    await assert.rejects(f.gateway.execute({ ...prepared, mutating: false }, { effectKey: 'changed-metadata' }), /approval/);
    const first = await f.gateway.execute(prepared, { effectKey: 'write', approvedDigest: prepared.digest });
    assert.equal(first.status, 'applied'); assert.equal(await readFile(path.join(f.workspace, 'output/result.txt'), 'utf8'), 'hello');
    const repeated = await f.gateway.execute(prepared, { effectKey: 'write', approvedDigest: prepared.digest });
    assert.deepEqual(repeated.receipt, first.receipt);
    assert.equal((await f.gateway.queryOutcome('write', prepared.digest)).status, 'applied');
    const baseline = await f.gateway.prepare({ name: 'read_file', arguments: { path: 'output/result.txt' } });
    assert.equal((await f.gateway.execute(baseline, { effectKey: 'read-before-changed-proposal' })).status, 'applied');
    const changed = await f.gateway.prepare({ name: 'write_file', arguments: { path: 'output/result.txt', content: 'different' } });
    assert.equal((await f.gateway.execute(changed, { effectKey: 'write', approvedDigest: changed.digest })).status, 'failed');
  } finally { await f.close(); }
});
test('large Chinese and emoji text survives the worker request and response streams unchanged', async () => {
  const f = await fixture();
  try {
    const content = '原始历史完整保留：中文🙂🚀\n'.repeat(8_000);
    const bytes = Buffer.from(content, 'utf8');
    assert.ok(bytes.length > 128 * 1024);
    const write = await f.gateway.prepare({ name: 'write_file', arguments: { path: 'unicode.txt', content } });
    const written = await f.gateway.execute(write, { effectKey: 'unicode-write', approvedDigest: write.digest });
    assert.equal(written.status, 'applied', written.error);
    assert.deepEqual(await readFile(path.join(f.workspace, 'unicode.txt')), bytes);
    const read = await f.gateway.prepare({ name: 'read_file', arguments: { path: 'unicode.txt' } });
    const returned = await f.gateway.execute(read, { effectKey: 'unicode-read' });
    assert.equal(returned.status, 'applied', returned.error);
    assert.equal(returned.output, content);
    assert.deepEqual(Buffer.from(returned.output, 'utf8'), bytes);
  } finally { await f.close(); }
});
test('crash after file effect is reconciled by artifact hash instead of repeated write', async () => {
  const f = await fixture();
  try {
    const prepared = await f.gateway.prepare({ name: 'write_file', arguments: { path: 'result.txt', content: 'persisted before receipt' } });
    const crashed = await f.gateway.execute(prepared, { effectKey: 'crash', approvedDigest: prepared.digest, fault: 'after_effect_before_receipt' });
    assert.equal(crashed.status, 'unknown');
    const reconciled = await f.gateway.queryOutcome('crash', prepared.digest);
    assert.equal(reconciled.status, 'applied'); assert.equal(reconciled.receipt?.reconciled, true);
  } finally { await f.close(); }
});
test('increment fixture owns a separate durable transaction and deduplicates keys', async () => {
  const f = await fixture();
  try {
    const prepared = await f.gateway.prepare({ name: 'fixture_increment', arguments: { amount: 1 } });
    const first = await f.gateway.execute(prepared, { effectKey: 'increment', approvedDigest: prepared.digest });
    const second = await f.gateway.execute(prepared, { effectKey: 'increment', approvedDigest: prepared.digest });
    assert.equal(first.receipt?.fixtureValue, 1); assert.equal(second.receipt?.fixtureValue, 1);
    assert.equal((await f.gateway.execute(prepared, { effectKey: 'increment-2', approvedDigest: prepared.digest })).receipt?.fixtureValue, 2);
  } finally { await f.close(); }
});
test('path boundary rejects escape, credentials, ADS and junctions', async () => {
  const f = await fixture();
  try {
    for (const requested of ['../escape.txt', 'API.txt', '.env', '.env.local', 'API.txt:stream', 'API.txt.', 'data/credentials.json']) {
      await assert.rejects(f.gateway.prepare({ name: 'write_file', arguments: { path: requested, content: 'no' } }), /protected|outside/);
    }
    const outside = path.join(f.directory, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(f.workspace, 'link'), 'junction');
    await assert.rejects(f.gateway.prepare({ name: 'write_file', arguments: { path: 'link/escape.txt', content: 'no' } }), /links|junctions/);
  } finally { await f.close(); }
});
test('trusted Node command runs real project script with scoped writes and no network/child process', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.workspace, 'script.mjs'), `import {writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {connect} from 'node:net';writeFileSync('effect.txt','ok');let denied=0;try{writeFileSync('../outside.txt','no')}catch(e){if(e.code==='ERR_ACCESS_DENIED')denied++}try{spawnSync(process.execPath,['--version'])}catch(e){if(e.code==='ERR_ACCESS_DENIED')denied++}try{connect(9,'127.0.0.1')}catch(e){if(e.message.includes('NPN_NETWORK_DENIED'))denied++}console.log(JSON.stringify({denied,temp:process.env.TEMP}));`);
    const prepared = await f.gateway.prepare({ name: 'run_command', arguments: { executable: 'node', args: ['script.mjs'] } });
    const result = await f.gateway.execute(prepared, { effectKey: 'command', approvedDigest: prepared.digest });
    assert.equal(result.status, 'applied'); assert.equal(result.receipt?.exitCode, 0, result.output);
    const output = JSON.parse(result.output.trim()); assert.equal(output.denied, 3); assert.ok(output.temp.startsWith(f.directory));
    assert.equal(await readFile(path.join(f.workspace, 'effect.txt'), 'utf8'), 'ok');
    await assert.rejects(f.gateway.prepare({ name: 'run_command', arguments: { executable: 'node', args: ['--allow-fs-write=*', 'script.mjs'] } }), /unsupported/);
  } finally { await f.close(); }
});
test('approved Node test runner executes actual project tests without child process isolation', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.workspace, 'sample.test.mjs'), `import test from 'node:test';import assert from 'node:assert/strict';test('real assertion',()=>assert.equal(2+2,4));`);
    const prepared = await f.gateway.prepare({ name: 'run_command', arguments: { executable: 'node', args: ['--test', 'sample.test.mjs'] } });
    const result = await f.gateway.execute(prepared, { effectKey: 'test-command', approvedDigest: prepared.digest });
    assert.equal(result.receipt?.exitCode, 0, result.output); assert.match(result.output, /real assertion/);
  } finally { await f.close(); }
});
test('an approved Node script cannot execute changed bytes', async () => {
  const f = await fixture();
  try {
    const script = path.join(f.workspace, 'approved.mjs');
    await writeFile(script, `import {writeFileSync} from 'node:fs';writeFileSync('effect.txt','approved');`);
    const prepared = await f.gateway.prepare({ name: 'run_command', arguments: { executable: 'node', args: ['approved.mjs'] } });
    await writeFile(script, `import {writeFileSync} from 'node:fs';writeFileSync('effect.txt','changed after approval');`);
    const changed = await f.gateway.prepare({ name: 'run_command', arguments: { executable: 'node', args: ['approved.mjs'] } });
    assert.notEqual(changed.digest, prepared.digest, 'Approval must bind exact script bytes, not just argv');
    const result = await f.gateway.execute(prepared, { effectKey: 'changed-script', approvedDigest: prepared.digest });
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /Approved command artifact changed/);
    await assert.rejects(readFile(path.join(f.workspace, 'effect.txt')), { code: 'ENOENT' });
  } finally { await f.close(); }
});
test('cancelling an approved script stops its owned process tree and leaves an unknown receipt', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.workspace, 'wait.mjs'), `import {writeFileSync} from 'node:fs';writeFileSync('started.txt','yes');setTimeout(()=>{writeFileSync('late-effect.txt','must not happen');},1500);`);
    const prepared = await f.gateway.prepare({ name: 'run_command', arguments: { executable: 'node', args: ['wait.mjs'] } });
    const controller = new AbortController();
    const pending = f.gateway.execute(prepared, { effectKey: 'cancel-command', approvedDigest: prepared.digest, signal: controller.signal });
    for (let i = 0; i < 50; i++) {
      try { await readFile(path.join(f.workspace, 'started.txt')); break; } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    controller.abort(); const result = await pending;
    assert.equal(result.status, 'unknown'); assert.equal((await f.gateway.queryOutcome('cancel-command', prepared.digest)).status, 'unknown');
    await new Promise(resolve => setTimeout(resolve, 1600));
    await assert.rejects(readFile(path.join(f.workspace, 'late-effect.txt')), { code: 'ENOENT' });
  } finally { await f.close(); }
});
