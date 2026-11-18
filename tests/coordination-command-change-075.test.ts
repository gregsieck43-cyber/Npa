import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Kernel, KernelError } from '../src/kernel/index.js';
import { ToolGateway } from '../src/tools/gateway.js';
import { observationCoverage } from '../src/app/command-observation.js';
import { startBackend } from '../src/app/backend.js';

function fixture(t: TestContext) {
  const root = path.resolve(process.env.TEMP ?? '.tmp'), dir = mkdtempSync(path.join(root, 'peer-fix-'));
  const workspace = path.join(dir, 'workspace'); mkdirSync(workspace);
  const kernel = new Kernel(path.join(dir, 'data'));
  t.after(() => { kernel.close(); assert.equal(path.dirname(dir), root); rmSync(dir, { recursive: true, force: true }); });
  const actor = (other = false) => {
    const own = other ? path.join(dir, 'other') : workspace; mkdirSync(own, { recursive: true });
    const id = kernel.command({ commandId: crypto.randomUUID(), type: 'create_task', parameters: { title: 'Peer fixture', workspace: own, permissionMode: 'full-access' } }).taskId!;
    const run = kernel.createRun(id); kernel.transition(id, 'running'); kernel.coordination.join(id);
    const gateway = new ToolGateway({ workspace: own, receiptDirectory: path.join(dir, 'receipts', id), workerPath: fileURLToPath(new URL('../src/tools/worker.js', import.meta.url)), getReadVersion: target => kernel.getWriteReadVersion(id, target) });
    return { id, runId: run.id, gateway };
  };
  const read = async (who: ReturnType<typeof actor>) => {
    const prepared = await who.gateway.prepare({ name: 'read_file', arguments: { path: 'shared.txt' } });
    const intent = kernel.prepareIntent(who.id, who.runId, { id: crypto.randomUUID(), name: 'read_file', arguments: prepared.arguments });
    kernel.approve(intent.id); kernel.dispatch(intent.id);
    const result = await who.gateway.execute(prepared, { effectKey: intent.effectKey }); assert.equal(result.status, 'applied'); kernel.receipt(intent.id, result.receipt!);
  };
  const notices = (id: string) => kernel.coordination.inbox(id).items.filter(item => item.kind === 'external_change');
  return { root, dir, workspace, kernel, actor, read, notices };
}
const stale = (error: unknown) => error instanceof KernelError && error.code === 'READ_VERSION_STALE';

function commandDiagnostic(t: TestContext, dir: string) {
  const start = performance.now(), phases: { phase: string; at: string; elapsedMs: number; status?: number }[] = [];
  let retained = false;
  const mark = (phase: string, status?: number) => { phases.push({ phase, at: new Date().toISOString(), elapsedMs: performance.now() - start, ...(status === undefined ? {} : { status }) }); if (phases.length > 64) phases.shift(); };
  const log = (value: unknown) => { try { t.diagnostic(JSON.stringify(value)); } catch { /* Preserve the original test failure. */ } };
  const errorFields = (error: unknown) => {
    try {
    const value = error as { name?: unknown; code?: unknown; cause?: { name?: unknown; code?: unknown } } | undefined;
    const safe = (part: unknown) => typeof part === 'number' && Number.isFinite(part) ? part : typeof part === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(part) ? part : undefined;
    return { name: safe(value?.name), code: safe(value?.code), causeName: safe(value?.cause?.name), causeCode: safe(value?.cause?.code) };
    } catch { return { unreadableError: true }; }
  };
  const fail = (error?: unknown) => {
    if (retained) return;
    retained = true;
    try {
      if (lstatSync(dir).isSymbolicLink()) { log({ retainedFixture: dir, diagnosticError: 'Fixture is now a link' }); return; }
      const metadata: Record<string, unknown> = { fixture: dir, at: new Date().toISOString(), durationMs: performance.now() - start, phases: [...phases], error: errorFields(error) };
      const read = (name: string, queries: Record<string, string>) => {
        let db: DatabaseSync | undefined;
        try {
          db = new DatabaseSync(path.join(dir, 'data', name + '.sqlite'), { readOnly: true }); db.exec('PRAGMA busy_timeout=0');
          for (const [key, sql] of Object.entries(queries)) {
            try { metadata[key] = db.prepare(sql).all(); } catch (cause) { metadata[key] = { diagnosticError: errorFields(cause) }; }
          }
        } catch (cause) { metadata[name] = { diagnosticError: errorFields(cause) }; }
        finally { try { db?.close(); } catch (cause) { metadata[name + 'Close'] = { diagnosticError: errorFields(cause) }; } }
      };
      // Selected bounded metadata only, never request bodies, credentials, goals or receipt output.
      read('kernel', {
        tasks: `SELECT id,status,revision,json_extract(body,'$.updatedAt') updatedAt FROM tasks LIMIT 4`,
        runs: `SELECT id,task_id,generation,policy_epoch,status,json_extract(body,'$.startedAt') startedAt,json_extract(body,'$.endedAt') endedAt FROM runs ORDER BY rowid DESC LIMIT 8`,
        intents: `SELECT id,task_id,run_id,state,prepared_at,json_extract(body,'$.name') name FROM intents ORDER BY rowid DESC LIMIT 8`,
        events: `SELECT seq,task_id,type,created_at,json_extract(payload,'$.modelCalls') modelCalls,json_extract(payload,'$.intentId') intentId,json_extract(payload,'$.code') errorCode FROM events ORDER BY seq DESC LIMIT 32`,
      });
      read('harness', { requests: `SELECT id,task_id,status,created_at,json_extract(record,'$.kind') kind,json_extract(record,'$.startedAt') startedAt,json_extract(record,'$.updatedAt') updatedAt,json_extract(record,'$.error.code') errorCode FROM requests ORDER BY seq DESC LIMIT 8` });
      writeFileSync(path.join(dir, 'command-failure.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
      log({ retainedFixture: dir, diagnostic: path.join(dir, 'command-failure.json') });
    } catch (cause) { log({ retainedFixture: dir, diagnosticError: errorFields(cause) }); }
  };
  return { mark, fail, retained: () => retained, finish() {
    const summary = { fixture: dir, retained, phases: phases.slice(-4) }; log(summary);
    if (retained) try { if (!lstatSync(dir).isSymbolicLink()) writeFileSync(path.join(dir, 'command-cleanup.json'), JSON.stringify(summary, null, 2) + '\n'); } catch (error) { log({ retainedFixture: dir, diagnosticError: errorFields(error) }); }
  } };
}

test('nested command approval rejects before persistent change notice, deduplicates and isolates workspace', async t => {
  const f = fixture(t), a = f.actor(), b = f.actor(), unrelated = f.actor(true);
  writeFileSync(path.join(f.workspace, 'shared.txt'), 'read v1'); await f.read(a);
  const proposed = await a.gateway.prepare({ name: 'write_file', arguments: { path: 'shared.txt', content: 'proposed v2' } });
  const intent = f.kernel.prepareIntent(a.id, a.runId, { id: crypto.randomUUID(), name: 'write_file', arguments: proposed.arguments });
  writeFileSync(path.join(f.workspace, 'shared.txt'), 'external v3');
  const before = f.kernel.getBudgets(a.id).toolCalls;
  for (let i = 0; i < 2; i++) assert.throws(() => f.kernel.command({ commandId: crypto.randomUUID(), type: 'grant', taskId: a.id, expectedRevision: f.kernel.getTask(a.id)!.revision, parameters: { intentId: intent.id } }), stale);
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'prepared'); assert.equal(f.kernel.getBudgets(a.id).toolCalls, before);
  assert.equal(f.notices(a.id).length, 1); assert.equal(f.notices(b.id).length, 1); assert.equal(f.notices(unrelated.id).length, 0);
  assert.equal((f.notices(a.id)[0]!.payload as any).attribution, 'unknown');
  assert.equal(readFileSync(path.join(f.workspace, 'shared.txt'), 'utf8'), 'external v3');
  await assert.rejects(a.gateway.prepare({ name: 'write_file', arguments: { path: 'shared.txt', content: 'do not overwrite' } }), stale);
  assert.equal(f.notices(a.id).length, 1, 'gateway provenance check does not duplicate same observed change');
});

test('notification failure preserves original stale refusal and cannot recursively authorize dispatch', async t => {
  const f = fixture(t), a = f.actor(); writeFileSync(path.join(f.workspace, 'shared.txt'), 'old'); await f.read(a);
  const prepared = await a.gateway.prepare({ name: 'write_file', arguments: { path: 'shared.txt', content: 'new' } });
  const intent = f.kernel.prepareIntent(a.id, a.runId, { id: crypto.randomUUID(), name: 'write_file', arguments: prepared.arguments });
  f.kernel.approve(intent.id); writeFileSync(path.join(f.workspace, 'shared.txt'), 'changed');
  const original = f.kernel.coordination.fileVersionChanged; let calls = 0;
  f.kernel.coordination.fileVersionChanged = () => { calls++; throw new Error('notification storage unavailable'); };
  try { assert.throws(() => f.kernel.dispatch(intent.id), error => stale(error) && (error as any).notificationError === 'notification storage unavailable'); }
  finally { f.kernel.coordination.fileVersionChanged = original; }
  assert.equal(calls, 1); assert.equal(f.kernel.getIntent(intent.id)!.state, 'approved');
  assert.equal(readFileSync(path.join(f.workspace, 'shared.txt'), 'utf8'), 'changed');
  assert.throws(() => f.kernel.dispatch(intent.id), stale); assert.equal(f.notices(a.id).length, 1);
});

test('candidate selection deduplicates before bound, prioritizes peers and reports missing comparison', t => {
  const f = fixture(t), a = f.actor(), b = f.actor(), c = f.actor();
  for (const owner of [a, b, c]) f.kernel.fileClaims.claimFiles(owner.id, ['shared.txt']);
  for (let i = 0; i < 40; i++) f.kernel.fileClaims.claimFiles(b.id, [`peer-${i}.txt`]);
  f.kernel.fileClaims.claimFiles(a.id, ['own-only.txt']);
  const selected = f.kernel.fileClaims.commandCandidates(a.id);
  assert.equal(selected.total, 42); assert.equal(selected.paths.length, 32); assert.equal(selected.omitted, 10); assert.equal(selected.truncated, true);
  assert.equal(new Set(selected.paths).size, 32); assert.ok(selected.paths.every(item => !item.endsWith('own-only.txt')));
  assert.deepEqual(observationCoverage([{ path: 'a', status: 'unavailable' }, { path: 'b', status: 'known', sha256: null }], [{ path: 'a', status: 'known', sha256: null }, { path: 'b', status: 'known', sha256: null }]),
    { observed: 2, comparable: 1, unavailable: 1, beforeUnavailable: 1, afterUnavailable: 0 });
});

for (const name of ['run_command', 'run_shell'] as const) test(`${name} real Runner displays peer warning and persists candidate changes`, { timeout: 90_000 }, async t => {
  const root = path.resolve(process.env.TEMP ?? '.tmp'), dir = mkdtempSync(path.join(root, 'peer-command-')), workspace = path.join(dir, 'workspace'); mkdirSync(workspace);
  const diagnostic = commandDiagnostic(t, dir); let completed = false;
  const bodies: any[] = [];
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  t.after(async () => {
    try {
      if (!completed || t.signal.aborted) diagnostic.fail(t.signal.reason);
      diagnostic.mark('backend-close-start');
      try { await backend?.close(); } finally { diagnostic.mark('backend-close-end'); }
      assert.equal(path.dirname(dir), root);
      if (!diagnostic.retained()) {
        if (lstatSync(root).isSymbolicLink() || lstatSync(dir).isSymbolicLink()) throw new Error('Command fixture ownership changed.');
        diagnostic.mark('fixture-remove-start');
        try { rmSync(dir, { recursive: true, force: true }); } finally { diagnostic.mark('fixture-remove-end'); }
      }
    } catch (error) { diagnostic.fail(error); throw error; } finally { diagnostic.finish(); }
  });
  try {
  diagnostic.mark('fixture-files');
  writeFileSync(path.join(workspace, 'shared.txt'), 'before'); writeFileSync(path.join(workspace, 'change.cjs'), "require('node:fs').writeFileSync('shared.txt','after')");
  diagnostic.mark('backend-start');
  backend = await startBackend({ projectRoot: process.cwd(), dataDir: path.join(dir, 'data'), mockOptions: { trace: body => bodies.push(body), responder: body => {
    const messages = body.messages as any[];
    if (messages.some(item => item.role === 'tool')) return { content: '', toolCalls: [{ id: crypto.randomUUID(), name: 'ask_user', arguments: { reason: 'blocker', question: 'Fixture awaits acceptance' } }] };
    return { content: '', toolCalls: [{ id: 'change-once', name, arguments: name === 'run_command' ? { executable: 'node', args: ['change.cjs'] } : { command: "Set-Content -LiteralPath shared.txt -Value 'after' -NoNewline" } }] };
  } } });
  diagnostic.mark('backend-ready');
  const kernel = backend.services.kernel;
  const peer = kernel.command({ commandId: crypto.randomUUID(), type: 'create_task', parameters: { title: 'Present peer', workspace, permissionMode: 'full-access' } }).taskId!;
  kernel.createRun(peer); kernel.transition(peer, 'running'); kernel.transition(peer, 'waiting_input'); kernel.coordination.join(peer);
  // run_command exercises no claim at warning/approval; run_shell exercises real changed peer candidate.
  if (name === 'run_shell') kernel.fileClaims.claimFiles(peer, ['shared.txt']);
  const id = backend.services.command({ commandId: crypto.randomUUID(), type: 'create_task', parameters: { title: 'Run command with peer', workspace, permissionMode: 'ask' } }).taskId!;
  const until = async <T>(read: () => T | Promise<T>, ready: (value: T) => boolean) => {
    const end = performance.now() + 30_000; for (;;) { const value = await read(); if (ready(value)) return value; if (performance.now() >= end) assert.fail('Timed out awaiting real Runner behavior'); await new Promise(resolve => setTimeout(resolve, 25)); }
  };
  const headers = { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' };
  const approvals = await until(async () => {
    diagnostic.mark('GET-approvals-headers');
    const response = await fetch(`http://127.0.0.1:${backend!.port}/v1/product/approvals?sessionId=${id}`, { headers, signal: AbortSignal.timeout(5000) });
    diagnostic.mark('GET-approvals-body', response.status);
    const value = await response.json(); diagnostic.mark('GET-approvals-settled', response.status); return value as any;
  }, value => Array.isArray(value) && value.length > 0);
  const shown = approvals[0]; assert.match(shown.reason, /可能修改共享文件/);
  assert.ok(bodies.some(body => body.messages.some((message: any) => message.role === 'system' && String(message.content).includes('run_command/run_shell'))));
  diagnostic.mark('POST-approval-headers');
  const result = await fetch(`http://127.0.0.1:${backend.port}/v1/product/approvals/decide`, { method: 'POST', headers, signal: AbortSignal.timeout(5000), body: JSON.stringify({ approvalId: shown.id, approved: true, scope: 'once', expectedIntentDigest: shown.digest, ...(shown.conflict ? { expectedConflictFingerprint: shown.conflict.fingerprint } : {}) }) });
  diagnostic.mark('POST-approval-body', result.status);
  assert.equal(result.status, 200, await result.text());
  diagnostic.mark('wait-intent-applied');
  await until(() => kernel.getIntent(shown.id)?.state, value => value === 'applied');
  diagnostic.mark('intent-applied');
  assert.equal(readFileSync(path.join(workspace, 'shared.txt'), 'utf8'), 'after');
  assert.ok(kernel.events(id).some(event => event.type === 'tool.execution' && String((event.payload.patch as any)?.description).includes('可能修改共享文件')));
  if (name === 'run_shell') {
    const notice = kernel.coordination.inbox(peer).items.find(item => item.kind === 'command_files_changed'); assert.ok(notice);
    assert.match(kernel.coordination.select(peer)!.text, /command_files_changed/);
    assert.equal((notice.payload as any).attribution, 'unknown');
  }
  completed = true;
  } catch (error) { diagnostic.fail(error); throw error; }
});

test('existing new-file proposal keeps its absence baseline before gateway re-preparation', t => {
  const f = fixture(t), a = f.actor(), b = f.actor();
  const intent = f.kernel.prepareIntent(a.id, a.runId, { id: crypto.randomUUID(), name: 'write_file', arguments: { path: 'created-later.txt', content: 'proposal' } });
  writeFileSync(path.join(f.workspace, 'created-later.txt'), 'external creation');
  assert.throws(() => f.kernel.assertWriteReadVersion(intent.id), stale);
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'prepared');
  assert.equal((f.notices(b.id)[0]!.payload as any).before, null);
  assert.equal(readFileSync(path.join(f.workspace, 'created-later.txt'), 'utf8'), 'external creation');
});

test('real Runner invalidates approved absence proposal after external creation without dispatching', { timeout: 90_000 }, async t => {
  const root = path.resolve(process.env.TEMP ?? '.tmp'), dir = mkdtempSync(path.join(root, 'peer-absence-resume-')), workspace = path.join(dir, 'workspace'); mkdirSync(workspace);
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  t.after(async () => { await backend?.close(); assert.equal(path.dirname(dir), root); rmSync(dir, { recursive: true, force: true }); });
  backend = await startBackend({ projectRoot: process.cwd(), dataDir: path.join(dir, 'data'), mockOptions: { responder: body => {
    if ((body.messages as any[]).some(item => item.role === 'tool')) return { content: '', toolCalls: [{ id: crypto.randomUUID(), name: 'ask_user', arguments: { reason: 'blocker', question: 'Do not repeat stale fixture write' } }] };
    return { content: '', toolCalls: [{ id: 'absence-proposal', name: 'write_file', arguments: { path: 'new.txt', content: 'agent proposal' } }] };
  } } });
  const { kernel, runner } = backend.services;
  const id = backend.services.command({ commandId: crypto.randomUUID(), type: 'create_task', parameters: { title: 'Write once after approval', workspace, permissionMode: 'ask' } }).taskId!;
  const until = async <T>(read: () => T, ready: (value: T) => boolean) => {
    const end = performance.now() + 30_000; for (;;) { const value = read(); if (ready(value)) return value; if (performance.now() >= end) assert.fail('Timed out awaiting old absence recovery'); await new Promise(resolve => setTimeout(resolve, 25)); }
  };
  const pending = await until(() => kernel.pendingApprovals({ taskId: id }), items => items.length === 1);
  const old = pending[0]!.intent;
  assert.equal((old.arguments.readVersion as any).sha256, null); assert.equal(kernel.getTask(id)!.status, 'waiting_approval');
  // Stop scheduling, not the backend or its database, so approval and external change are deterministic.
  await runner.stop();
  kernel.command({ commandId: crypto.randomUUID(), type: 'grant', taskId: id, expectedRevision: kernel.getTask(id)!.revision, parameters: { intentId: old.id, scope: 'once' } });
  assert.equal(kernel.getIntent(old.id)!.state, 'approved');
  const dispatches = kernel.eventCount(id, 'intent.sent'), budget = kernel.getBudgets(id).toolCalls;
  writeFileSync(path.join(workspace, 'new.txt'), 'external creation');
  runner.start();
  await until(() => kernel.getTask(id)!.status, state => state === 'waiting_input');
  assert.equal(kernel.getIntent(old.id)!.state, 'denied');
  assert.equal(kernel.eventCount(id, 'intent.sent'), dispatches, 'old proposal never reaches a new dispatch');
  assert.equal(kernel.getBudgets(id).toolCalls, budget);
  assert.equal(kernel.pendingApprovals({ taskId: id }).length, 0, 'stale approval must not remain actionable');
  assert.match(kernel.getTask(id)!.waitingReason!, /Prepared operation is no longer valid/);
  assert.equal(readFileSync(path.join(workspace, 'new.txt'), 'utf8'), 'external creation');
  const notices = kernel.coordination.inbox(id).items.filter(item => item.kind === 'external_change');
  assert.equal(notices.length, 1); assert.equal((notices[0]!.payload as any).before, null);
  assert.throws(() => kernel.dispatch(old.id), error => error instanceof KernelError);
  assert.equal(kernel.eventCount(id, 'intent.sent'), dispatches);
  assert.equal(kernel.getBudgets(id).toolCalls, budget);
});
