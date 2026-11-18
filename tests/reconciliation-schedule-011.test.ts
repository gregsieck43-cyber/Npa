import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Kernel } from '../src/kernel/index.js';
import { ToolGateway } from '../src/tools/gateway.js';

async function fixture(t: TestContext) {
  const base = path.resolve(process.env.TEMP ?? '.tmp/hardening-011-reconciliation');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'schedule-'));
  const kernel = new Kernel(directory);
  t.after(() => { kernel.close(); rmSync(directory, { recursive: true }); });
  const taskId = kernel.command({ commandId: 'create', type: 'create_task', parameters: { title: 'Unknown effect schedule' } }).taskId!;
  const run = kernel.createRun(taskId); kernel.transition(taskId, 'running');
  const workspace = kernel.getTask(taskId)!.workspace;
  mkdirSync(workspace, { recursive: true }); writeFileSync(path.join(workspace, 'sample.txt'), 'read-only original result');
  const gateway = new ToolGateway({ workspace, receiptDirectory: path.join(directory, 'receipts'), getReadVersion: filename => kernel.getReadVersion(taskId, filename) });
  const prepared = await gateway.prepare({ name: 'read_file', arguments: { path: 'sample.txt' } });
  const intent = kernel.prepareIntent(taskId, run.id, { id: 'read', name: 'read_file', arguments: prepared.arguments });
  kernel.approve(intent.id); kernel.dispatch(intent.id);
  const observed = await gateway.execute(prepared, { effectKey: intent.effectKey });
  assert.equal(observed.status, 'applied', observed.error); assert.ok(observed.receipt);
  // The worker persisted the original receipt, but its delivery to the Kernel was lost.
  kernel.unknown(intent.id, 'fixture lost receipt delivery');
  assert.equal(kernel.getReadVersion(taskId, path.join(workspace, 'sample.txt')), undefined);
  return { kernel, taskId, directory, intent, gateway, prepared, workspace };
}

test('reconciliation delay persists across reopen and filters both active and paused unknown tasks', async t => {
  const { kernel, taskId, directory } = await fixture(t);
  const schedule = kernel as Kernel & { setReconciliationDue(id: string, due: number): void; reconciliationDue(id: string): number };
  const due = Date.now() + 30_000;
  schedule.setReconciliationDue(taskId, due);
  assert.equal(schedule.reconciliationDue(taskId), due);
  assert.equal(kernel.taskRunnable(taskId, due - 1), false);
  assert.equal(kernel.taskRunnable(taskId, due), true);
  kernel.command({ commandId: 'pause', type: 'pause', taskId });
  assert.equal(kernel.taskRunnable(taskId, due - 1), false);
  assert.equal(kernel.taskRunnable(taskId, due), true);
  const reopened = new Kernel(directory) as typeof schedule;
  try {
    assert.equal(reopened.reconciliationDue(taskId), due);
    assert.equal(reopened.taskRunnable(taskId, due - 1), false);
  } finally { reopened.close(); }
});

test('settled-only cleanup keeps unknown backoff and explicit interrupt clears its persisted wait', async t => {
  const { kernel, taskId, intent, gateway, prepared, workspace } = await fixture(t);
  const schedule = kernel as Kernel & { setReconciliationDue(id: string, due: number): void; reconciliationDue(id: string): number; clearReconciliationDue(id: string, onlyIfSettled?: boolean): void };
  schedule.setReconciliationDue(taskId, Number.MAX_SAFE_INTEGER);
  schedule.clearReconciliationDue(taskId, true);
  assert.equal(schedule.reconciliationDue(taskId), Number.MAX_SAFE_INTEGER);
  assert.equal(kernel.taskRunnable(taskId), false);
  schedule.clearReconciliationDue(taskId);
  assert.equal(schedule.reconciliationDue(taskId), 0);
  assert.equal(kernel.taskRunnable(taskId), true);
  schedule.setReconciliationDue(taskId, Date.now() + 30_000);
  assert.equal(kernel.getIntent(intent.id)!.state, 'unknown');
  const persisted = await gateway.queryOutcome(intent.effectKey, prepared.digest);
  assert.equal(persisted.status, 'applied', persisted.error); assert.ok(persisted.receipt);
  assert.equal(persisted.receipt.output, 'read-only original result');
  assert.equal(kernel.getReadVersion(taskId, path.join(workspace, 'sample.txt')), undefined);
  kernel.reconcile(intent.id, persisted.receipt);
  assert.equal(kernel.getIntent(intent.id)!.state, 'applied');
  assert.equal(kernel.getReadVersion(taskId, path.join(workspace, 'sample.txt'))!.sourceIntentId, intent.id);
  assert.equal(kernel.eventCount(taskId, 'intent.sent'), 1, 'Reconciliation queries the existing receipt; it never re-executes the unknown read.');
  schedule.clearReconciliationDue(taskId, true);
  assert.equal(schedule.reconciliationDue(taskId), 0);
});
