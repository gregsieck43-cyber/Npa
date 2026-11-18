import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kernel, KernelError } from '../src/kernel/index.js';
import { ToolGateway } from '../src/tools/gateway.js';
import type { Task } from '../src/contracts.js';
import { filePathIdentity } from '../src/kernel/read-set.js';
import { DatabaseSync } from 'node:sqlite';

const temporaryRoot = path.resolve('.tmp/continuation-20261117-readset');
mkdirSync(temporaryRoot, { recursive: true });
const code = (expected: string) => (error: unknown) => error instanceof KernelError && error.code === expected;

function fixture() {
  const directory = mkdtempSync(path.join(temporaryRoot, 'flow-'));
  const workspace = path.join(directory, 'workspace'); mkdirSync(workspace);
  const data = path.join(directory, 'data');
  const state = {
    directory, workspace, data, kernel: new Kernel(data),
    task() {
      const ack = state.kernel.command({ commandId: crypto.randomUUID(), type: 'create_task', parameters: { title: 'Read-bound edit', workspace } });
      const task = state.kernel.getTask(ack.taskId!)!;
      const run = state.kernel.createRun(task.id); state.kernel.transition(task.id, 'running');
      const gateway = new ToolGateway({ workspace, receiptDirectory: path.join(directory, 'receipts', task.id),
        workerPath: fileURLToPath(new URL('../src/tools/worker.js', import.meta.url)),
        getReadVersion: filename => state.kernel.getReadVersion(task.id, filename) });
      return { task, runId: run.id, gateway };
    },
    close() { state.kernel.close(); assert.ok(directory.startsWith(temporaryRoot + path.sep)); rmSync(directory, { recursive: true, force: true }); },
  };
  return state;
}
type Actor = { task: Task; runId: string; gateway: ToolGateway };
async function prepare(f: ReturnType<typeof fixture>, actor: Actor, name: 'read_file' | 'write_file', filename: string, content?: string) {
  const prepared = await actor.gateway.prepare({ name, arguments: { path: filename, ...(content === undefined ? {} : { content }) } });
  const intent = f.kernel.prepareIntent(actor.task.id, actor.runId, { id: crypto.randomUUID(), name, arguments: prepared.arguments });
  f.kernel.approve(intent.id, intent.fileConflicts?.conflicts.length ? { expectedIntentDigest: intent.digest, expectedConflictFingerprint: intent.fileConflicts.fingerprint, source: 'operator', scope: 'once' } : {});
  return { prepared, intent };
}
async function read(f: ReturnType<typeof fixture>, actor: Actor, filename: string) {
  const operation = await prepare(f, actor, 'read_file', filename);
  f.kernel.dispatch(operation.intent.id);
  const outcome = await actor.gateway.execute(operation.prepared, { effectKey: operation.intent.effectKey });
  assert.equal(outcome.status, 'applied', outcome.error);
  f.kernel.receipt(operation.intent.id, outcome.receipt!);
  return { ...operation, outcome };
}

test('existing files require an actual task read before any write proposal', () => {
  const directory = mkdtempSync(path.join(temporaryRoot, 'unread-'));
  const workspace = path.join(directory, 'workspace'); mkdirSync(workspace);
  const kernel = new Kernel(path.join(directory, 'data'));
  try {
    writeFileSync(path.join(workspace, 'existing.txt'), 'user bytes');
    const ack = kernel.command({ commandId: crypto.randomUUID(), type: 'create_task', parameters: { title: 'Read before writing', workspace } });
    const task = kernel.getTask(ack.taskId!)!;
    const run = kernel.createRun(task.id); kernel.transition(task.id, 'running');
    assert.throws(() => kernel.prepareIntent(task.id, run.id, { id: 'unread', name: 'write_file', arguments: { path: 'existing.txt', content: 'replacement' } }), code('READ_REQUIRED'));
  } finally { kernel.close(); assert.ok(directory.startsWith(temporaryRoot + path.sep)); rmSync(directory, { recursive: true, force: true }); }
});

test('worker reads bind raw bytes and survive reopen, while model hashes cannot create authority', async () => {
  const f = fixture();
  try {
    const actor = f.task(); const filename = path.join(f.workspace, 'source.txt');
    writeFileSync(filename, Buffer.from([0xff, 0x61, 0x0a]));
    await assert.rejects(actor.gateway.prepare({ name: 'write_file', arguments: { path: 'source.txt', content: 'forged', expectedSha256: 'f'.repeat(64), readVersion: { path: filename, sha256: 'f'.repeat(64), sourceIntentId: 'invented' } } }), /READ_REQUIRED/);
    const actual = await read(f, actor, 'source.txt');
    const bound = f.kernel.getReadVersion(actor.task.id, filename)!;
    assert.equal(bound.sourceIntentId, actual.intent.id); assert.equal(bound.sha256, actual.outcome.receipt!.sha256);
    f.kernel.close(); f.kernel = new Kernel(f.data);
    assert.deepEqual(f.kernel.getReadVersion(actor.task.id, filename), bound);
    const proposed = await actor.gateway.prepare({ name: 'write_file', arguments: { path: './source.txt', content: 'replacement', expectedSha256: '0'.repeat(64) } });
    assert.equal(proposed.arguments.expectedSha256, bound.sha256);
    assert.equal((proposed.arguments.readVersion as { sourceIntentId: string }).sourceIntentId, actual.intent.id);
    const other = f.task();
    assert.throws(() => f.kernel.prepareIntent(other.task.id, other.runId, { id: 'stolen', name: 'write_file', arguments: proposed.arguments }), code('READ_REQUIRED'));
  } finally { f.close(); }
});

test('stale reads cannot be refreshed by preparation, operator approval, rebind, or new absence', async () => {
  const f = fixture();
  try {
    const actor = f.task(); const filename = path.join(f.workspace, 'edit.txt'); writeFileSync(filename, 'version 1');
    await read(f, actor, 'edit.txt');
    const approved = await prepare(f, actor, 'write_file', 'edit.txt', 'agent edit');
    writeFileSync(filename, 'user version 2');
    await assert.rejects(actor.gateway.prepare({ name: 'write_file', arguments: { path: 'edit.txt', content: 'again' } }), /READ_VERSION_STALE/);
    assert.throws(() => f.kernel.approve(approved.intent.id), code('READ_VERSION_STALE'));
    assert.throws(() => f.kernel.dispatch(approved.intent.id), code('READ_VERSION_STALE'));
    assert.equal(readFileSync(filename, 'utf8'), 'user version 2');
    const rebound = f.kernel.rebindIntent(approved.intent.id, actor.runId);
    assert.deepEqual(rebound.arguments.readVersion, approved.intent.arguments.readVersion);
    assert.throws(() => f.kernel.approve(rebound.id), code('READ_VERSION_STALE'));
    unlinkSync(filename);
    await assert.rejects(actor.gateway.prepare({ name: 'write_file', arguments: { path: 'edit.txt', content: 'silently recreate' } }), /READ_VERSION_STALE/);
    const absence = await read(f, actor, 'edit.txt');
    assert.equal(absence.outcome.receipt!.exists, false);
    const recreate = await prepare(f, actor, 'write_file', 'edit.txt', 'explicit recreation after absence read');
    assert.equal(recreate.prepared.arguments.expectedSha256, null);
    assert.equal((recreate.prepared.arguments.readVersion as { sourceIntentId: string }).sourceIntentId, absence.intent.id);
    f.kernel.dispatch(recreate.intent.id);
    const recreated = await actor.gateway.execute(recreate.prepared, { effectKey: recreate.intent.effectKey, approvedDigest: recreate.prepared.digest });
    assert.equal(recreated.status, 'applied', recreated.error); f.kernel.receipt(recreate.intent.id, recreated.receipt!);
    assert.equal(readFileSync(filename, 'utf8'), 'explicit recreation after absence read');
  } finally { f.close(); }
});

test('two tasks sharing a file serialize through receipt and the second cannot overwrite the first read version', async () => {
  const f = fixture();
  try {
    const a = f.task(), b = f.task(); const filename = path.join(f.workspace, 'shared.txt'); writeFileSync(filename, 'original');
    await read(f, a, 'shared.txt'); await read(f, b, './shared.txt');
    const first = await prepare(f, a, 'write_file', 'shared.txt', 'first edit');
    const alias = process.platform === 'win32' ? 'SHARED.txt' : './shared.txt';
    const second = await prepare(f, b, 'write_file', alias, 'second edit');
    f.kernel.dispatch(first.intent.id);
    assert.throws(() => f.kernel.dispatch(second.intent.id), code('FILE_OPERATION_PENDING'));
    const secondConnection = new Kernel(f.data);
    try { assert.throws(() => secondConnection.dispatch(second.intent.id), code('FILE_OPERATION_PENDING')); }
    finally { secondConnection.close(); }
    const outcome = await a.gateway.execute(first.prepared, { effectKey: first.intent.effectKey, approvedDigest: first.prepared.digest });
    assert.equal(outcome.status, 'applied', outcome.error);
    // Even after worker completion, the Kernel reservation lasts until durable settlement.
    assert.throws(() => f.kernel.dispatch(second.intent.id), code('FILE_OPERATION_PENDING'));
    f.kernel.receipt(first.intent.id, outcome.receipt!);
    assert.throws(() => f.kernel.dispatch(second.intent.id), code('READ_VERSION_STALE'));
    assert.equal(readFileSync(filename, 'utf8'), 'first edit');
    await read(f, b, alias);
    const refreshed = await prepare(f, b, 'write_file', alias, 'second edit after reread');
    f.kernel.dispatch(refreshed.intent.id);
    const done = await b.gateway.execute(refreshed.prepared, { effectKey: refreshed.intent.effectKey, approvedDigest: refreshed.prepared.digest });
    assert.equal(done.status, 'applied', done.error); f.kernel.receipt(refreshed.intent.id, done.receipt!);
    assert.equal(readFileSync(filename, 'utf8'), 'second edit after reread');
  } finally { f.close(); }
});

test('UNKNOWN keeps its file reservation across restart and reconciliation releases it without repeating a write', async () => {
  const f = fixture();
  try {
    const actor = f.task(); const operation = await prepare(f, actor, 'write_file', 'new.txt', 'committed before crash');
    assert.equal(operation.prepared.arguments.expectedSha256, null);
    f.kernel.dispatch(operation.intent.id);
    const crashed = await actor.gateway.execute(operation.prepared, { effectKey: operation.intent.effectKey, approvedDigest: operation.prepared.digest, fault: 'after_effect_before_receipt' });
    assert.equal(crashed.status, 'unknown'); f.kernel.unknown(operation.intent.id);
    f.kernel.close();
    // Emulate an upgrade from an unresolved intent predating the target lookup index.
    const legacy = new DatabaseSync(path.join(f.data, 'kernel.sqlite'));
    try { legacy.exec('DELETE FROM intent_file_targets'); } finally { legacy.close(); }
    f.kernel = new Kernel(f.data); f.kernel.recover();
    const other = f.task(); const blocked = await prepare(f, other, 'read_file', 'new.txt');
    assert.throws(() => f.kernel.dispatch(blocked.intent.id), code('FILE_OPERATION_PENDING'));
    const recovered = await actor.gateway.queryOutcome(operation.intent.effectKey, operation.prepared.digest);
    assert.equal(recovered.status, 'applied');
    f.kernel.reconcile(operation.intent.id, recovered.receipt!);
    f.kernel.dispatch(blocked.intent.id);
    const readBack = await other.gateway.execute(blocked.prepared, { effectKey: blocked.intent.effectKey });
    f.kernel.receipt(blocked.intent.id, readBack.receipt!);
    assert.equal(readBack.output, 'committed before crash');
  } finally { f.close(); }
});

test('new-file absence is approved explicitly and worker rechecks after dispatch', async () => {
  const f = fixture();
  try {
    const actor = f.task();
    const first = await prepare(f, actor, 'write_file', 'new.txt', 'agent');
    assert.deepEqual(first.intent.arguments.readVersion, { path: filePathIdentity(first.prepared.resources[0]!), sha256: null, sourceIntentId: null });
    f.kernel.dispatch(first.intent.id);
    writeFileSync(path.join(f.workspace, 'new.txt'), 'external creation');
    const outcome = await actor.gateway.execute(first.prepared, { effectKey: first.intent.effectKey, approvedDigest: first.prepared.digest });
    assert.equal(outcome.status, 'failed'); assert.match(outcome.error!, /READ_VERSION_STALE/);
    assert.equal(readFileSync(path.join(f.workspace, 'new.txt'), 'utf8'), 'external creation');
    f.kernel.unknown(first.intent.id, outcome.error);
  } finally { f.close(); }
});

test('malformed or wrong-effect read receipts do not settle or populate the read set', async () => {
  const f = fixture();
  try {
    const actor = f.task(); const filename = path.join(f.workspace, 'read.txt'); writeFileSync(filename, 'authentic');
    const operation = await prepare(f, actor, 'read_file', 'read.txt'); f.kernel.dispatch(operation.intent.id);
    const outcome = await actor.gateway.execute(operation.prepared, { effectKey: operation.intent.effectKey });
    for (const patch of [{ effectKey: 'other' }, { digest: '0'.repeat(64) }, { path: 'elsewhere.txt' }, { sha256: 'model claims read' }, { bytes: -1 }]) {
      assert.throws(() => f.kernel.receipt(operation.intent.id, { ...outcome.receipt!, ...patch }), code('READ_RECEIPT_INVALID'));
      assert.equal(f.kernel.getIntent(operation.intent.id)!.state, 'sent');
      assert.equal(f.kernel.getReadVersion(actor.task.id, filename), undefined);
    }
    f.kernel.receipt(operation.intent.id, outcome.receipt!);
    f.kernel.receipt(operation.intent.id, outcome.receipt!);
    assert.equal(f.kernel.getReadVersion(actor.task.id, filename)!.sourceIntentId, operation.intent.id);
  } finally { f.close(); }
});
