import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Command, TaskStatus } from '../src/contracts.js';
import { Kernel, KernelError, type Run } from '../src/kernel/index.js';
import { ToolGateway } from '../src/tools/gateway.js';

/**
 * Independent acceptance slice: crash windows between dispatch and receipt, command and effect
 * deduplication, stale generations, permission revocation generations, one real force-terminated
 * child process, and repeated restarts. The kernel and its SQLite database are the real ones; no
 * kernel behaviour is mocked. Everything this file writes lives under
 * ".tmp/agent-endurance/child"; nothing outside tests/kernel-crash-windows.test.ts is modified.
 */

const CHECKOUT = path.resolve(process.cwd());
const CHILD_ROOT = path.join(CHECKOUT, '.tmp', 'agent-endurance', 'child');
const FIXTURE_ROOT = path.join(CHILD_ROOT, 'fixtures');
const isCode = (code: string) => (error: unknown): boolean => error instanceof KernelError && error.code === code;
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const WORKER = fileURLToPath(new URL('../src/kernel/index.js', import.meta.url));

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly stateDir: string;
  readonly receiptDir: string;
  readonly taskId: string;
  readonly gateway: ToolGateway;
  readonly kernel: Kernel;
  openKernel(): Kernel;
  closeKernel(): void;
  createTask(extra?: Record<string, unknown>): string;
  liveTask(taskId?: string): Run;
  file(...segments: string[]): string;
}

function kernelFixture(t: TestContext, label: string): Fixture {
  assert.ok(CHILD_ROOT.startsWith(CHECKOUT + path.sep), 'Delegated fixtures stay inside the checkout temp root');
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const root = mkdtempSync(path.join(FIXTURE_ROOT, label + '-'));
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const receiptDir = path.join(root, 'receipts');
  for (const directory of [workspace, stateDir, receiptDir]) mkdirSync(directory);
  let kernel: Kernel | undefined;
  const openKernel = (): Kernel => { kernel?.close(); kernel = new Kernel(stateDir); return kernel; };
  const closeKernel = (): void => { kernel?.close(); kernel = undefined; };
  openKernel();
  const createTask = (extra: Record<string, unknown> = {}): string => {
    const supplied = (extra.goal ?? {}) as Record<string, unknown>;
    const ack = kernel!.command({ commandId: randomUUID(), type: 'create_task', parameters: {
      ...extra, workspace,
      goal: { objective: 'Crash-window acceptance ' + label, constraints: [], acceptance: [], maxModelCalls: 40, mode: 'autonomous', ...supplied },
    } });
    assert.ok(ack.taskId, 'create_task must return the new task id');
    return ack.taskId;
  };
  const fixture: Fixture = {
    root, workspace, stateDir, receiptDir, taskId: createTask(),
    gateway: new ToolGateway({ workspace, receiptDirectory: receiptDir, timeoutMs: 20_000 }),
    get kernel(): Kernel { return kernel!; },
    openKernel, closeKernel, createTask,
    liveTask(taskId: string = fixture.taskId): Run {
      const run = kernel!.createRun(taskId);
      kernel!.transition(taskId, 'running');
      return run;
    },
    file(...segments: string[]): string { return path.join(root, ...segments); },
  };
  t.after(() => {
    closeKernel();
    assert.ok(root.startsWith(FIXTURE_ROOT + path.sep), 'Fixture cleanup stays inside the delegated temp root');
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return fixture;
}

function scalar(stateDir: string, sql: string, ...args: (string | number | null)[]): unknown {
  const db = new DatabaseSync(path.join(stateDir, 'kernel.sqlite'));
  try {
    const row = db.prepare(sql).get(...args) as Record<string, unknown> | undefined;
    return row ? Object.values(row)[0] : undefined;
  } finally { db.close(); }
}

function rows(stateDir: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path.join(stateDir, 'kernel.sqlite'));
  try { return db.prepare(sql).all() as Record<string, unknown>[]; } finally { db.close(); }
}

function integrity(stateDir: string): string {
  const db = new DatabaseSync(path.join(stateDir, 'kernel.sqlite'));
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
    return String(Object.values(row)[0]);
  } finally { db.close(); }
}

test('window after dispatch before receipt: the effect is an explicit unknown, never a success', { timeout: 60_000 }, async t => {
  const f = kernelFixture(t, 'dispatch-before-receipt');
  const run = f.liveTask();
  const prepared = await f.gateway.prepare({ name: 'fixture_increment', arguments: { amount: 1 } });
  const intent = f.kernel.prepareIntent(f.taskId, run.id, { id: 'crash-increment', name: prepared.name, arguments: prepared.arguments }, { capability: 'fixture.write' });
  f.kernel.approve(intent.id);
  f.kernel.dispatch(intent.id);
  const external = await f.gateway.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
  assert.equal(external.status, 'applied');
  assert.equal(external.receipt!.fixtureValue, 1);
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'sent', 'A dispatched effect without a ledger receipt must not be reported as applied');
  assert.equal(f.kernel.getIntent(intent.id)!.receipt, undefined, 'No receipt may be invented from the external outcome');
  assert.equal(f.kernel.events(f.taskId).filter(event => event.type === 'effect.receipted').length, 0);

  // Clean close plus a fresh process: the durable state still says "sent", not "applied".
  const reopened = f.openKernel();
  assert.equal(reopened.getIntent(intent.id)!.state, 'sent');
  assert.equal(reopened.getTask(f.taskId)!.status, 'running', 'The task must not be marked finished while its receipt is missing');
  const recovery = reopened.recover();
  assert.deepEqual(recovery.unknownIntents, [intent.id], 'Recovery must classify the interrupted dispatch as unknown');
  assert.deepEqual(recovery.reconciling, [f.taskId]);
  assert.equal(reopened.getIntent(intent.id)!.state, 'unknown');
  assert.equal(reopened.getTask(f.taskId)!.status, 'reconciling');
  assert.throws(() => reopened.createRun(f.taskId), isCode('TASK_NOT_RUNNABLE'), 'No new generation may start over an unreconciled effect');
  assert.throws(() => reopened.dispatch(intent.id), isCode('STALE_GENERATION'), 'A recovered effect must never be replayed by dispatch');
  assert.throws(() => reopened.approve(intent.id), isCode('STALE_GENERATION'));

  // Reconciliation reads the external evidence; the effect stays exactly one increment.
  const observed = await f.gateway.queryOutcome(intent.effectKey, prepared.digest);
  assert.equal(observed.status, 'applied');
  assert.equal(observed.receipt!.fixtureValue, 1);
  reopened.reconcile(intent.id, observed.receipt);
  assert.equal(reopened.getIntent(intent.id)!.state, 'applied');
  assert.equal(reopened.getIntent(intent.id)!.receipt!.fixtureValue, 1);
  assert.equal(reopened.getTask(f.taskId)!.status, 'queued');
  // Recorded behaviour: reconcile() stores the receipt with reconciled:true, so re-delivering the
  // same raw external evidence afterwards is rejected as a digest conflict instead of being
  // idempotent. Only the stored (reconciled) receipt can be re-delivered safely.
  assert.throws(() => reopened.receipt(intent.id, observed.receipt!), isCode('RECEIPT_CONFLICT'), 'Replaying the raw pre-reconciliation receipt conflicts with the reconciled receipt');
  assert.equal(reopened.receipt(intent.id, reopened.getIntent(intent.id)!.receipt!).state, 'applied', 'Re-delivering the stored reconciled receipt is idempotent');
  assert.throws(() => reopened.receipt(intent.id, { ...observed.receipt!, fixtureValue: 2 }), isCode('RECEIPT_CONFLICT'));
  assert.equal(reopened.events(f.taskId).filter(event => event.type === 'effect.receipted').length, 1, 'One effect, one receipt event');
  const replay = await f.gateway.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
  assert.equal(replay.receipt!.fixtureValue, 1, 'Replaying the approved operation under the same effect key must not add a second increment');
  const changed = await f.gateway.prepare({ name: 'fixture_increment', arguments: { amount: 2 } });
  const conflict = await f.gateway.execute(changed, { effectKey: intent.effectKey, approvedDigest: changed.digest });
  assert.notEqual(conflict.status, 'applied', 'A different operation under the same effect key must not apply');
  assert.equal(Number(scalar(f.stateDir, 'SELECT COUNT(*) FROM effects WHERE effect_key=?', intent.effectKey)), 1);
  assert.equal(Number(scalar(f.stateDir, 'SELECT COUNT(*) FROM intents')), 1);
});

test('receipt committed before the model continues: one committed effect and consistent history', { timeout: 60_000 }, async t => {
  const f = kernelFixture(t, 'receipt-before-continue');
  const run = f.liveTask();
  const objective = f.kernel.getMessages(f.taskId);
  const prepared = await f.gateway.prepare({ name: 'fixture_increment', arguments: { amount: 1 } });
  const intent = f.kernel.prepareIntent(f.taskId, run.id, { id: 'receipt-once', name: prepared.name, arguments: prepared.arguments }, { capability: 'fixture.write' });
  f.kernel.approve(intent.id);
  f.kernel.dispatch(intent.id);
  const external = await f.gateway.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
  assert.equal(external.status, 'applied');
  f.kernel.addMessage(f.taskId, 'tool', JSON.stringify(external.receipt), 'main', { toolCallId: 'receipt-once' });
  const committed = f.kernel.receipt(intent.id, external.receipt!);
  assert.equal(committed.state, 'applied');
  assert.equal(f.kernel.getMessages(f.taskId).length, objective.length + 1);

  // The receipt is durable while the model step is still owed.
  const reopened = f.openKernel();
  assert.equal(reopened.getIntent(intent.id)!.state, 'applied');
  assert.deepEqual(reopened.getIntent(intent.id)!.receipt, external.receipt);
  assert.equal(reopened.getTask(f.taskId)!.status, 'running', 'The kernel must not pretend the model continued after the receipt');
  assert.deepEqual(reopened.getMessages(f.taskId), f.kernel.getMessages(f.taskId));
  const recovery = reopened.recover();
  assert.deepEqual(recovery.unknownIntents, [], 'An applied effect is never an unknown effect');
  assert.ok(recovery.requeued.includes(f.taskId));
  assert.equal(reopened.getTask(f.taskId)!.status, 'queued');
  assert.equal(reopened.getIntent(intent.id)!.state, 'applied', 'Recovery must not reopen a receipted effect');
  assert.equal(reopened.events(f.taskId).filter(event => event.type === 'effect.receipted').length, 1);
  reopened.receipt(intent.id, external.receipt!);
  assert.equal(reopened.events(f.taskId).filter(event => event.type === 'effect.receipted').length, 1, 'A repeated receipt must not be a second effect');
  const duplicate = await f.gateway.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
  assert.equal(duplicate.receipt!.fixtureValue, 1);
  assert.equal(reopened.getBudgets(f.taskId).toolCalls, 1);
  assert.equal(reopened.getMessages(f.taskId).filter(message => message.role === 'tool').length, 1);
  assert.equal(Number(scalar(f.stateDir, 'SELECT COUNT(*) FROM effects')), 1);
});

test('one command id executes once while fresh ids stay bound by generation and intent guards', t => {
  const f = kernelFixture(t, 'duplicate-commands');
  const initial = f.kernel.getTask(f.taskId)!;
  const pause: Command = { commandId: randomUUID(), taskId: f.taskId, type: 'pause', expectedRevision: initial.revision };
  const first = f.kernel.command(pause);
  assert.equal(first.status, 'accepted');
  assert.equal(first.taskId, f.taskId);
  const duplicate = f.kernel.command(pause);
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.revision, first.revision, 'A duplicate command must return the original acknowledgement');
  assert.equal(duplicate.taskId, first.taskId);
  assert.equal(f.kernel.events(f.taskId).filter(event => event.type === 'task.paused').length, 1, 'A duplicate command must not run the control twice');
  assert.equal(f.kernel.getTask(f.taskId)!.generation, initial.generation + 1, 'The pause fenced exactly one generation');
  assert.throws(() => f.kernel.command({ ...pause, type: 'cancel' }), isCode('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => f.kernel.command({ ...pause, commandId: randomUUID() }), isCode('REVISION_CONFLICT'));

  // A fresh id with equivalent content is a new operation, not a deduplicated replay: it bumps the
  // generation again. Generation fences, not command ids, are what protect effects.
  const paused = f.kernel.getTask(f.taskId)!;
  f.kernel.command({ commandId: randomUUID(), taskId: f.taskId, type: 'resume' });
  const resumed = f.kernel.getTask(f.taskId)!;
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.generation, paused.generation + 1);

  const run = f.liveTask();
  const intent = f.kernel.prepareIntent(f.taskId, run.id, { id: 'granted-once', name: 'fixture_increment', arguments: { amount: 1 } }, { capability: 'fixture.write' });
  const grant: Command = { commandId: randomUUID(), taskId: f.taskId, type: 'grant', parameters: { intentId: intent.id } };
  assert.equal(f.kernel.command(grant).status, 'accepted');
  f.kernel.command({ ...grant, commandId: randomUUID() });
  assert.equal(Number(scalar(f.stateDir, 'SELECT COUNT(*) FROM approvals WHERE intent_id=?', intent.id)), 1, 'An equivalent approval with a fresh command id must not write a second approval row');
  assert.equal(Number(scalar(f.stateDir, 'SELECT COUNT(*) FROM outbox WHERE intent_id=?', intent.id)), 1);
  assert.equal(f.kernel.events(f.taskId).filter(event => event.type === 'intent.approved').length, 1);
  f.kernel.dispatch(intent.id);
  assert.throws(() => f.kernel.command({ ...grant, commandId: randomUUID() }), isCode('INVALID_INTENT_STATE'), 'A granted effect cannot be granted again after dispatch');

  const fenced = f.kernel.getTask(f.taskId)!;
  f.kernel.command({ commandId: randomUUID(), taskId: f.taskId, type: 'pause' });
  assert.equal(f.kernel.getTask(f.taskId)!.generation, fenced.generation + 1);
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'unknown', 'Pause after dispatch must fence the effect into an explicit unknown');
  assert.throws(() => f.kernel.command({ ...grant, commandId: randomUUID() }), isCode('STALE_GENERATION'), 'A fresh command id cannot approve across a generation fence');
});

test('stale generations cannot approve, dispatch, receipt, model-succeed or command after a fence', { timeout: 30_000 }, async t => {
  const f = kernelFixture(t, 'stale-generation');
  const initial = f.kernel.getTask(f.taskId)!;
  const run = f.liveTask();
  const intent = f.kernel.prepareIntent(f.taskId, run.id, { id: 'stale-increment', name: 'fixture_increment', arguments: { amount: 1 } }, { capability: 'fixture.write' });
  f.kernel.approve(intent.id);
  f.kernel.command({ commandId: randomUUID(), taskId: f.taskId, type: 'pause' });
  const paused = f.kernel.getTask(f.taskId)!;
  assert.equal(paused.generation, initial.generation + 1);
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'denied', 'A pause fences an approved but undispatched effect');
  assert.throws(() => f.kernel.approve(intent.id), isCode('STALE_GENERATION'));
  assert.throws(() => f.kernel.dispatch(intent.id), isCode('STALE_GENERATION'));
  assert.throws(() => f.kernel.modelSucceeded(f.taskId, run.id), isCode('STALE_GENERATION'));
  assert.throws(() => f.kernel.consumeModelCall(f.taskId, run.id), isCode('STALE_GENERATION'));
  assert.throws(() => f.kernel.checkpoint(f.taskId, run.id, { stale: true }), isCode('STALE_GENERATION'));
  assert.throws(() => f.kernel.receipt(intent.id, { fixtureValue: 1 }), isCode('INVALID_INTENT_STATE'), 'A denied effect cannot be receipted into existence');
  assert.throws(() => f.kernel.command({ commandId: randomUUID(), taskId: f.taskId, type: 'resume', expectedRevision: initial.revision }), isCode('REVISION_CONFLICT'));

  // Reopening a database alone does not fence the previous process' generation: only recover() does.
  f.kernel.command({ commandId: randomUUID(), taskId: f.taskId, type: 'resume' });
  const run2 = f.liveTask();
  const intent2 = f.kernel.prepareIntent(f.taskId, run2.id, { id: 'stale-increment-2', name: 'fixture_increment', arguments: { amount: 1 } }, { capability: 'fixture.write' });
  f.kernel.approve(intent2.id);
  const bare = f.openKernel();
  assert.equal(bare.getTask(f.taskId)!.generation, run2.generation, 'Reopening keeps the durable generation');
  assert.equal(bare.getIntent(intent2.id)!.state, 'approved');
  assert.equal(bare.dispatch(intent2.id).state, 'sent', 'Recorded behaviour: a process that opens the database without recover() can still dispatch the previous generation, so recover() must be the first call of every new process');
  const recovered = bare.recover();
  assert.deepEqual(recovered.unknownIntents, [intent2.id]);
  assert.equal(bare.getIntent(intent2.id)!.state, 'unknown');
  assert.throws(() => bare.dispatch(intent2.id), isCode('STALE_GENERATION'));
  assert.throws(() => bare.approve(intent2.id), isCode('STALE_GENERATION'));
});

test('revoking or narrowing permission mid-flight fences the approval generation with no effect', { timeout: 60_000 }, async t => {
  const f = kernelFixture(t, 'permission-generation');
  const initial = f.kernel.getTask(f.taskId)!;
  const run = f.liveTask();
  const prepared = await f.gateway.prepare({ name: 'fixture_increment', arguments: { amount: 1 } });
  const intent = f.kernel.prepareIntent(f.taskId, run.id, { id: 'revoked-increment', name: prepared.name, arguments: prepared.arguments }, { capability: 'fixture.write' });
  assert.equal(f.kernel.getIntent(intent.id)!.authorization!.decision, 'ask', 'The default work mode asks the operator for a write');
  f.kernel.approve(intent.id, { source: 'operator' });
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'approved');

  f.kernel.setPermission(f.taskId, { permissionMode: 'read-only', reason: 'acceptance slice revoked write authority' });
  const narrowed = f.kernel.getTask(f.taskId)!;
  assert.equal(narrowed.permissionMode, 'read-only');
  assert.equal(narrowed.generation, initial.generation + 1, 'A permission change raises the generation');
  assert.equal(narrowed.policyEpoch, initial.policyEpoch + 1, 'A permission change raises the policy epoch');
  assert.equal(f.kernel.permissionState(f.taskId).policyEpoch, narrowed.policyEpoch);
  assert.equal(f.kernel.getTaskPermission(f.taskId).mode, 'read-only');
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'denied', 'The standing operator approval must not survive revocation');
  const decision = f.kernel.decideIntent(intent.id);
  assert.equal(decision.mode, 'read-only');
  assert.equal(decision.outcome, 'ask', 'Recorded behaviour: decideIntent replays the decision snapshotted at prepare time and only the live mode field shows the revocation');
  assert.throws(() => f.kernel.dispatch(intent.id), isCode('STALE_GENERATION'));
  assert.throws(() => f.kernel.approve(intent.id), isCode('STALE_GENERATION'));
  assert.throws(() => f.kernel.dispatch(intent.id), isCode('STALE_GENERATION'));
  assert.equal(Number(scalar(f.stateDir, 'SELECT COUNT(*) FROM effects WHERE effect_key=?', intent.effectKey)), 0, 'A revoked approval must not have produced an effect row');
  assert.equal(Number(scalar(f.stateDir, "SELECT COUNT(*) FROM outbox WHERE intent_id=? AND state='sent'", intent.id)), 0);

  // A dispatched effect cannot be un-dispatched by revocation; it becomes an explicit unknown.
  f.kernel.setPermission(f.taskId, { permissionMode: 'ask', reason: 'acceptance slice restored ask mode' });
  const restored = f.kernel.getTask(f.taskId)!;
  assert.equal(restored.permissionMode, 'ask');
  const run2 = f.liveTask();
  const intentB = f.kernel.prepareIntent(f.taskId, run2.id, { id: 'revoked-after-dispatch', name: 'fixture_increment', arguments: { amount: 1 } }, { capability: 'fixture.write' });
  f.kernel.approve(intentB.id, { source: 'operator' });
  f.kernel.dispatch(intentB.id);
  assert.equal(f.kernel.getIntent(intentB.id)!.state, 'sent');
  f.kernel.revoke(f.taskId);
  const revoked = f.kernel.getTask(f.taskId)!;
  assert.equal(f.kernel.getIntent(intentB.id)!.state, 'unknown', 'Revocation after dispatch must record an explicit unknown, not a silent success');
  assert.equal(revoked.status, 'reconciling');
  assert.equal(revoked.generation, restored.generation + 1);
  assert.equal(revoked.policyEpoch, restored.policyEpoch + 1);
  assert.throws(() => f.kernel.dispatch(intentB.id), isCode('STALE_GENERATION'));
  assert.throws(() => f.kernel.approve(intentB.id), isCode('STALE_GENERATION'));
  assert.throws(() => f.kernel.createRun(f.taskId), isCode('TASK_NOT_RUNNABLE'));
  assert.equal(f.kernel.receipt(intentB.id, { observed: 'external provider refused after revocation' }).state, 'applied', 'Recorded behaviour: a post-revocation receipt settles an already-dispatched effect because it is reconciliation, not execution');
  assert.throws(() => f.kernel.reconcile(intentB.id, { observed: 'late' }), isCode('INVALID_INTENT_STATE'), 'Recorded behaviour: receipt() before reconcile() makes reconcile() refuse, so the task stays reconciling until an explicit retry');
  assert.equal(f.kernel.getTask(f.taskId)!.status, 'reconciling');
  f.kernel.command({ commandId: randomUUID(), taskId: f.taskId, type: 'retry' });
  assert.equal(f.kernel.getTask(f.taskId)!.status, 'queued', 'An operator retry is what clears a reconciling task after a receipt-first settlement');
});

function crashWorkerSource(): string {
  return [
    "import { writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    'import { Kernel } from ' + JSON.stringify(pathToFileURL(WORKER).href) + ';',
    'const [stateDir, workspace, markerPath] = process.argv.slice(2);',
    'const kernel = new Kernel(stateDir);',
    "const task = kernel.listTasks().find(candidate => candidate.status === 'running');",
    "if (!task) throw new Error('No running task for the crash window');",
    "const run = kernel.getRuns(task.id).find(candidate => candidate.status === 'running');",
    "if (!run) throw new Error('No running generation for the crash window');",
    "const call = { id: 'child-crash-window', name: 'write_file', arguments: { path: 'child-effect.txt', content: 'applied exactly once' } };",
    "const intent = kernel.prepareIntent(task.id, run.id, call, { capability: 'workspace.write', paths: ['child-effect.txt'] });",
    'kernel.approve(intent.id);',
    'kernel.dispatch(intent.id);',
    "writeFileSync(path.join(workspace, 'child-effect.txt'), 'applied exactly once');",
    'writeFileSync(markerPath, JSON.stringify({ pid: process.pid, taskId: task.id, runId: run.id, intentId: intent.id, effectKey: intent.effectKey, digest: intent.digest }));',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n');
}

test('force-killed child process after its effect stays unknown, unlike a normal close', { timeout: 90_000 }, async t => {
  const processes: { kill(signal?: NodeJS.Signals | number): boolean; exitCode: number | null; signalCode: NodeJS.Signals | null }[] = [];
  t.after(() => { for (const process of processes) if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); });
  const f = kernelFixture(t, 'process-kill');
  f.liveTask();
  const script = f.file('crash-worker.mjs');
  const marker = f.file('child-ready.json');
  writeFileSync(script, crashWorkerSource());
  f.closeKernel();

  const child = spawn(process.execPath, [script, f.stateDir, f.workspace, marker], { cwd: f.workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(child);
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  child.stdout!.resume();
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const exitState: { value?: { code: number | null; signal: NodeJS.Signals | null } } = {};
  void exitPromise.then(value => { exitState.value = value; });

  const deadline = Date.now() + 30_000;
  while (!existsSync(marker)) {
    if (exitState.value) assert.fail('The crash worker exited before reaching the window: ' + JSON.stringify(exitState.value) + ' ' + stderr.slice(0, 400));
    if (Date.now() > deadline) assert.fail('The crash worker never reached the crash window: ' + stderr.slice(0, 400));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const state = JSON.parse(readFileSync(marker, 'utf8')) as { pid: number; taskId: string; runId: string; intentId: string; effectKey: string; digest: string };
  assert.equal(state.taskId, f.taskId, 'The worker must operate on the same task as the supervisor');
  assert.equal(readFileSync(path.join(f.workspace, 'child-effect.txt'), 'utf8'), 'applied exactly once');
  const walPath = path.join(f.stateDir, 'kernel.sqlite-wal');
  assert.equal(existsSync(walPath), true, 'A live writer keeps an unmerged WAL');
  assert.equal(child.exitCode, null, 'The worker must still hold the window between effect and receipt');

  // Process power-loss simulation: SIGKILL terminates the worker without any close(), checkpoint or receipt.
  const killStarted = Date.now();
  const delivered = child.kill('SIGKILL');
  const killed = await exitPromise;
  const killMs = Date.now() - killStarted;
  assert.equal(delivered, true, 'SIGKILL must be delivered to the fixture worker');
  assert.ok(killed.code !== 0 || killed.signal !== null, 'The worker must terminate abnormally, saw code=' + String(killed.code) + ' signal=' + String(killed.signal));
  console.log('[crash-window] runtime=' + process.execPath + ' pid=' + state.pid + ' kill=SIGKILL forced=true code=' + String(killed.code) + ' signal=' + String(killed.signal) + ' after=' + killMs + 'ms');
  assert.equal(existsSync(walPath), true, 'A force-killed writer leaves the WAL without a clean checkpoint');
  assert.equal(integrity(f.stateDir), 'ok', 'A force-killed writer must leave a recoverable SQLite database');

  const recovered = f.openKernel();
  const recovery = recovered.recover();
  assert.deepEqual(recovery.unknownIntents, [state.intentId], 'The killed dispatch must be discovered as unknown');
  assert.equal(recovered.getIntent(state.intentId)!.state, 'unknown');
  assert.equal(recovered.getIntent(state.intentId)!.receipt, undefined, 'No receipt may be reconstructed from the file it wrote');
  assert.equal(recovered.getTask(state.taskId)!.status, 'reconciling');
  assert.throws(() => recovered.dispatch(state.intentId), isCode('STALE_GENERATION'));
  assert.throws(() => recovered.approve(state.intentId), isCode('STALE_GENERATION'));
  const bytes = readFileSync(path.join(f.workspace, 'child-effect.txt'));
  assert.equal(sha256(bytes), sha256('applied exactly once'));
  recovered.reconcile(state.intentId, { path: 'child-effect.txt', sha256: sha256(bytes), bytes: bytes.length, observedBy: 'acceptance-slice' });
  assert.equal(recovered.getIntent(state.intentId)!.state, 'applied');
  assert.equal(readFileSync(path.join(f.workspace, 'child-effect.txt'), 'utf8'), 'applied exactly once', 'Reconciliation must not repeat the effect');
  assert.throws(() => recovered.receipt(state.intentId, { path: 'child-effect.txt', sha256: sha256(bytes), bytes: bytes.length + 1 }), isCode('RECEIPT_CONFLICT'));

  // Control: the identical window with a committed receipt and a normal close is a settled effect.
  const control = kernelFixture(t, 'process-close');
  const controlRun = control.liveTask();
  const controlIntent = control.kernel.prepareIntent(control.taskId, controlRun.id, { id: 'closed-write', name: 'write_file', arguments: { path: 'control-effect.txt', content: 'closed cleanly' } }, { capability: 'workspace.write', paths: ['control-effect.txt'] });
  control.kernel.approve(controlIntent.id, { source: 'operator' });
  control.kernel.dispatch(controlIntent.id);
  writeFileSync(path.join(control.workspace, 'control-effect.txt'), 'closed cleanly');
  const cleanReceipt = { path: 'control-effect.txt', sha256: sha256('closed cleanly'), bytes: Buffer.byteLength('closed cleanly') };
  control.kernel.receipt(controlIntent.id, cleanReceipt);
  control.closeKernel();
  assert.equal(existsSync(path.join(control.stateDir, 'kernel.sqlite-wal')), false, 'A clean close checkpoints and removes the WAL');
  const cleanReopen = control.openKernel();
  assert.equal(cleanReopen.getIntent(controlIntent.id)!.state, 'applied');
  assert.deepEqual(cleanReopen.getIntent(controlIntent.id)!.receipt, cleanReceipt);
  const cleanRecovery = cleanReopen.recover();
  assert.deepEqual(cleanRecovery.unknownIntents, [], 'A clean close keeps a receipted effect settled');
  assert.equal(cleanReopen.getTask(control.taskId)!.status, 'queued');
  assert.equal(cleanReopen.getIntent(controlIntent.id)!.state, 'applied');
  assert.notEqual(recovery.unknownIntents.length, cleanRecovery.unknownIntents.length, 'Forced termination and a normal close must not produce the same recovery semantics');
});

test('three consecutive restarts keep WAL, schema, messages, intents and pending calls consistent', { timeout: 60_000 }, async t => {
  const f = kernelFixture(t, 'restarts');
  const run = f.liveTask();
  const call = { id: 'restart-read', name: 'fixture_increment', arguments: { amount: 1 } };
  f.kernel.addMessage(f.taskId, 'assistant', '', 'main', { toolCalls: [call] });
  assert.deepEqual(f.kernel.pendingCalls(f.taskId).map(pending => pending.call.id), [call.id]);
  const prepared = await f.gateway.prepare({ name: 'fixture_increment', arguments: { amount: 1 } });
  const intent = f.kernel.prepareIntent(f.taskId, run.id, call, { capability: 'fixture.write' });
  f.kernel.approve(intent.id);
  f.kernel.dispatch(intent.id);
  const outcome = await f.gateway.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
  f.kernel.receipt(intent.id, outcome.receipt!);
  f.kernel.addMessage(f.taskId, 'tool', JSON.stringify(outcome.receipt), 'main', { toolCallId: call.id });
  assert.deepEqual(f.kernel.pendingCalls(f.taskId), []);
  const reused = f.kernel.addMessage(f.taskId, 'assistant', '', 'main', { toolCalls: [call] });
  const pending = f.kernel.pendingCalls(f.taskId);
  assert.deepEqual(pending, [{ messageId: reused.id, call }], 'A reused call id belongs to the newer assistant message');
  const messages = f.kernel.getMessages(f.taskId);
  const schema = f.kernel.storageInfo();
  assert.equal(schema.driver, 'node:sqlite');
  assert.equal(schema.journalMode, 'wal');
  assert.equal(schema.synchronous, 2);
  assert.equal(schema.schemaVersion, 4, 'Schema v4 is current at base 8f51ffd');
  assert.equal(existsSync(path.join(f.stateDir, 'kernel.sqlite-wal')), true, 'The database must really be in WAL mode while a writer is open');

  for (let restart = 1; restart <= 3; restart++) {
    const reopened = f.openKernel();
    const recovery = reopened.recover();
    assert.deepEqual(recovery.unknownIntents, [], 'Restart ' + restart + ' must find no interrupted dispatch');
    assert.deepEqual(reopened.getMessages(f.taskId), messages, 'Restart ' + restart + ' must not lose or reorder raw history');
    assert.equal(reopened.messageCount(f.taskId), messages.length);
    assert.deepEqual(reopened.pendingCalls(f.taskId), pending, 'Restart ' + restart + ' must not duplicate pending tool calls');
    assert.equal(reopened.getIntent(intent.id)!.state, 'applied');
    assert.equal(reopened.storageInfo().schemaVersion, 4);
    assert.equal(reopened.storageInfo().journalMode, 'wal');
    const sequences = reopened.events(f.taskId).map(event => event.seq);
    assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right), 'Event sequence must stay ordered across restarts');
    assert.equal(new Set(sequences).size, sequences.length, 'Event sequence must stay unique across restarts');
    const ack = reopened.command({ commandId: 'restart-stable-command', taskId: f.taskId, type: 'pause' });
    assert.equal(ack.status, restart === 1 ? 'accepted' : 'duplicate', 'The command ledger must survive every restart');
    assert.equal(reopened.events(f.taskId).filter(event => event.type === 'task.paused').length, 1);
    assert.equal(reopened.getTask(f.taskId)!.status as TaskStatus, 'paused');
  }
  f.closeKernel();
  assert.equal(integrity(f.stateDir), 'ok');
  assert.deepEqual(rows(f.stateDir, 'SELECT version FROM schema_version ORDER BY version').map(row => Number(row.version)), [1, 2, 3, 4]);
  assert.equal(Number(scalar(f.stateDir, 'SELECT COUNT(*) FROM intents')), 1);
  assert.equal(Number(scalar(f.stateDir, 'SELECT COUNT(*) FROM effects')), 1);
  assert.equal(Number(scalar(f.stateDir, 'SELECT COUNT(*) FROM approvals')), 1);
  assert.equal(Number(scalar(f.stateDir, 'SELECT COUNT(*) FROM pending_calls')), 1);
  assert.equal(Number(scalar(f.stateDir, 'SELECT COUNT(*) FROM messages')), messages.length);
});

test('a message repeating a tool call id is rejected atomically as a typed KernelError', t => {
  const f = kernelFixture(t, 'duplicate-call-ids');
  const before = f.kernel.messageCount(f.taskId);
  const call = { id: 'repeated-call', name: 'fixture_increment', arguments: { amount: 1 } };
  let thrown: unknown;
  try { f.kernel.addMessage(f.taskId, 'assistant', '', 'main', { toolCalls: [call, call] }); }
  catch (error) { thrown = error; }
  const failure = thrown as (Error & { code?: string }) | undefined;
  assert.ok(failure, 'A message with two identical tool call ids must be rejected');
  assert.equal(f.kernel.messageCount(f.taskId), before, 'The rejected message must not persist a partial row');
  assert.deepEqual(f.kernel.pendingCalls(f.taskId), [], 'No half-registered tool call may survive the rejection');
  assert.equal(
    failure instanceof KernelError,
    true,
    'Untrusted model output must surface as a KernelError, actual ' + String(failure!.name) + '[' + String(failure!.code) + ']: ' + String(failure!.message),
  );
});
