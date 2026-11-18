import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ToolGateway, type ToolOutcome } from '../src/tools/gateway.js';

test('approved PowerShell writes a real workspace artifact, returns UTF-8 and deduplicates its receipt', async t => {
  const parent = path.resolve('.tmp'); mkdirSync(parent, { recursive: true });
  const owned = mkdtempSync(path.join(parent, 'shell-test-')), workspace = path.join(owned, 'workspace'); mkdirSync(workspace);
  const start = performance.now(), phases: { phase: string; at: string; elapsedMs: number }[] = [], outcomes: Record<string, unknown>[] = [];
  let completed = false, retained = false;
  const mark = (phase: string) => { phases.push({ phase, at: new Date().toISOString(), elapsedMs: performance.now() - start }); if (phases.length > 32) phases.shift(); };
  const log = (value: unknown) => { try { t.diagnostic(JSON.stringify(value)); } catch { /* Do not replace the original failure. */ } };
  const errorFields = (error: unknown) => {
    try {
    const value = error as { name?: unknown; code?: unknown; cause?: { name?: unknown; code?: unknown } } | undefined;
    const safe = (part: unknown) => typeof part === 'number' && Number.isFinite(part) ? part : typeof part === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(part) ? part : undefined;
    return { name: safe(value?.name), code: safe(value?.code), causeName: safe(value?.cause?.name), causeCode: safe(value?.cause?.code) };
    } catch { return { unreadableError: true }; }
  };
  const observe = (phase: string, result: ToolOutcome) => {
    try {
    outcomes.push({ phase, status: result.status, outputChars: result.output.length, errorPresent: typeof result.error === 'string', receiptPresent: result.receipt !== undefined,
      ...(typeof result.receipt?.exitCode === 'number' ? { exitCode: result.receipt.exitCode } : {}) });
    } catch (cause) { log({ diagnosticError: errorFields(cause) }); }
  };
  const fail = (error?: unknown) => {
    if (retained) return;
    retained = true;
    try {
      if (lstatSync(owned).isSymbolicLink()) { log({ retainedFixture: owned, diagnosticError: 'Fixture is now a link' }); return; }
      // Keep the original receipt/artifact in place. Never execute/query again to diagnose unknown.
      writeFileSync(path.join(owned, 'shell-failure.json'), JSON.stringify({ fixture: owned, at: new Date().toISOString(), durationMs: performance.now() - start, error: errorFields(error), phases, outcomes }, null, 2) + '\n', { flag: 'wx' });
      log({ retainedFixture: owned, diagnostic: path.join(owned, 'shell-failure.json') });
    } catch (cause) { log({ retainedFixture: owned, diagnosticError: errorFields(cause) }); }
  };
  t.after(() => {
    try {
      if (!completed || t.signal.aborted) fail(t.signal.reason);
      assert.equal(path.dirname(owned), parent);
      if (!retained) {
        if (lstatSync(parent).isSymbolicLink() || lstatSync(owned).isSymbolicLink()) throw new Error('Shell fixture ownership changed.');
        mark('fixture-remove-start'); try { rmSync(owned, { recursive: true }); } finally { mark('fixture-remove-end'); }
      }
    } catch (error) { fail(error); throw error; } finally { log({ fixture: owned, retained, phases: phases.slice(-4) }); }
  });
  try {
  mark('prepare-shell');
  const gateway = new ToolGateway({ workspace, receiptDirectory: path.join(owned, 'receipts') });
  const prepared = await gateway.prepare({ name: 'run_shell', arguments: { command: "[IO.File]::AppendAllText((Join-Path (Get-Location) 'result.txt'), '一次'); Write-Output '中文终端🙂'", timeoutMs: 10000 } });
  mark('reject-unapproved-execute');
  await assert.rejects(gateway.execute(prepared, { effectKey: 'shell-write' }), /approval/i);
  mark('approved-execute');
  const outcome = await gateway.execute(prepared, { effectKey: 'shell-write', approvedDigest: prepared.digest });
  mark('approved-execute-returned'); observe('approved', outcome);
  assert.equal(outcome.status, 'applied', outcome.error);
  assert.equal(outcome.receipt?.exitCode, 0);
  assert.match(outcome.output, /中文终端🙂/);
  mark('repeated-execute');
  const repeated = await gateway.execute(prepared, { effectKey: 'shell-write', approvedDigest: prepared.digest });
  mark('repeated-execute-returned'); observe('repeated', repeated);
  assert.deepEqual(repeated, outcome);
  assert.equal(readFileSync(path.join(workspace, 'result.txt'), 'utf8'), '一次');
  mark('query-receipt');
  assert.equal((await gateway.queryOutcome('shell-write', prepared.digest)).status, 'applied');
  mark('all-original-assertions-passed'); completed = true;
  } catch (error) { fail(error); throw error; }
});

test('shell process failure is returned as a real exit code and output stays bounded', async t => {
  const parent = path.resolve('.tmp'); mkdirSync(parent, { recursive: true });
  const owned = mkdtempSync(path.join(parent, 'shell-output-test-')), workspace = path.join(owned, 'workspace'); mkdirSync(workspace);
  t.after(() => { assert.equal(path.dirname(owned), parent); rmSync(owned, { recursive: true }); });
  const gateway = new ToolGateway({ workspace, receiptDirectory: path.join(owned, 'receipts') });
  const prepared = await gateway.prepare({ name: 'run_shell', arguments: { command: "Write-Output ('x' * 300000); exit 7" } });
  const result = await gateway.execute(prepared, { effectKey: 'shell-error', approvedDigest: prepared.digest });
  assert.equal(result.status, 'applied', result.error);
  assert.equal(result.receipt?.exitCode, 7);
  assert.equal(result.receipt?.truncated, true);
  assert.ok(result.output.length <= 262144);
});

test('ordinary project kernel and resources directories are editable, credentials remain protected', async t => {
  const parent = path.resolve('.tmp'); mkdirSync(parent, { recursive: true });
  const owned = mkdtempSync(path.join(parent, 'project-path-test-')), workspace = path.join(owned, 'workspace'); mkdirSync(workspace);
  t.after(() => { assert.equal(path.dirname(owned), parent); rmSync(owned, { recursive: true }); });
  const gateway = new ToolGateway({ workspace, receiptDirectory: path.join(owned, 'receipts') });
  for (const target of ['src/kernel/domain.ts', 'src/tools/helpers.ts', 'resources/schema.json', 'data/fixture.json']) {
    const prepared = await gateway.prepare({ name: 'write_file', arguments: { path: target, content: '{}' } });
    const result = await gateway.execute(prepared, { effectKey: target, approvedDigest: prepared.digest });
    assert.equal(result.status, 'applied', result.error);
    assert.equal(readFileSync(path.join(workspace, target), 'utf8'), '{}');
  }
  await assert.rejects(gateway.prepare({ name: 'read_file', arguments: { path: 'API.txt' } }), /protected/);
});
