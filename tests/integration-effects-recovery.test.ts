import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { inspectEffects } from '../src/app/verification.js';
import { Kernel } from '../src/kernel/index.js';
import { ToolGateway } from '../src/tools/gateway.js';
import { assertProjectFixtureRoot } from './project-boundary.js';

function effectFixture(t: TestContext, acceptance = ['fixture:count=1']) {
  const tempRoot = path.resolve('.tmp');
  assertProjectFixtureRoot(tempRoot);
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(path.join(tempRoot, 'audit-effects-'));
  const workspace = path.join(root, 'workspace');
  const taskDirectory = path.join(root, 'task-state');
  const externalDirectory = path.join(root, 'external-effect-state');
  mkdirSync(workspace);
  let kernel: Kernel | undefined;
  t.after(() => {
    kernel?.close();
    assert.ok(path.relative(tempRoot, root).startsWith('audit-effects-'));
    rmSync(root, { recursive: true, force: true });
  });
  kernel = new Kernel(taskDirectory);
  const taskId = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    workspace, goal: { objective: 'Approved effect exactly once, then independently read back', constraints: [],
      acceptance, maxModelCalls: 5, mode: 'autonomous' },
  } }).taskId!;
  const gateway = new ToolGateway({ workspace, receiptDirectory: externalDirectory, timeoutMs: 10_000 });
  return { workspace, taskId, gateway, get kernel() { return kernel!; },
    restart() { kernel!.close(); kernel = undefined; kernel = new Kernel(taskDirectory); return kernel.recover(); } };
}

test('independent: changed trusted script bytes cannot execute under an earlier prepared approval', async t => {
  const fixture = effectFixture(t, []);
  const script = path.join(fixture.workspace, 'approved-script.mjs');
  const marker = path.join(fixture.workspace, 'script-effect.txt');
  writeFileSync(script, "import {writeFileSync} from 'node:fs'; writeFileSync('script-effect.txt','approved version');\n");
  const prepared = await fixture.gateway.prepare({ name: 'run_command', arguments: { executable: 'node', args: ['approved-script.mjs'] } });
  const run = fixture.kernel.createRun(fixture.taskId);
  fixture.kernel.transition(fixture.taskId, 'running');
  const intent = fixture.kernel.prepareIntent(fixture.taskId, run.id, { id: 'audited-script', name: prepared.name, arguments: prepared.arguments },
    { capability: 'process.exec', paths: ['approved-script.mjs'] });
  fixture.kernel.approve(intent.id);
  fixture.kernel.dispatch(intent.id);
  writeFileSync(script, "import {writeFileSync} from 'node:fs'; writeFileSync('script-effect.txt','changed version');\n");
  const changed = await fixture.gateway.prepare({ name: 'run_command', arguments: { executable: 'node', args: ['approved-script.mjs'] } });
  assert.notEqual(changed.digest, prepared.digest, 'Script bytes belong to the exact operation approved by the operator');
  const outcome = await fixture.gateway.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
  assert.notEqual(outcome.status, 'applied');
  assert.equal(existsSync(marker), false, 'The unapproved changed script must produce no effect');
});

test('independent: durable external counter survives task crash before receipt and reconciles without another increment', async t => {
  const fixture = effectFixture(t);
  const run = fixture.kernel.createRun(fixture.taskId);
  fixture.kernel.transition(fixture.taskId, 'running');
  const prepared = await fixture.gateway.prepare({ name: 'fixture_increment', arguments: { amount: 1 } });
  const intent = fixture.kernel.prepareIntent(fixture.taskId, run.id, { id: 'increment-once', name: prepared.name, arguments: prepared.arguments }, { effectKey: 'audit-stable-operation', capability: 'fixture.write' });
  fixture.kernel.approve(intent.id);
  fixture.kernel.dispatch(intent.id);
  const external = await fixture.gateway.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
  assert.equal(external.status, 'applied');
  assert.equal(external.receipt!.fixtureValue, 1);
  // Deliberately do not commit this receipt to the task ledger: the external DB cannot roll back with it.
  const recovery = fixture.restart();
  assert.ok(recovery.unknownIntents.includes(intent.id));
  assert.equal(fixture.kernel.getTask(fixture.taskId)!.status, 'reconciling');
  assert.throws(() => fixture.kernel.createRun(fixture.taskId));
  const observed = await fixture.gateway.queryOutcome(intent.effectKey, prepared.digest);
  assert.equal(observed.status, 'applied');
  fixture.kernel.reconcile(intent.id, observed.receipt);
  assert.equal(fixture.kernel.getIntent(intent.id)!.state, 'applied');
  const duplicate = await fixture.gateway.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
  assert.equal(duplicate.receipt!.fixtureValue, 1, 'Same logical key must return the original receipt');
  const changed = await fixture.gateway.prepare({ name: 'fixture_increment', arguments: { amount: 2 } });
  const conflict = await fixture.gateway.execute(changed, { effectKey: intent.effectKey, approvedDigest: changed.digest });
  assert.notEqual(conflict.status, 'applied', 'Same key with changed operation must not apply');
  assert.equal((await fixture.gateway.queryOutcome(intent.effectKey, prepared.digest)).receipt!.fixtureValue, 1);
});

test('independent: actual worker exit after file effect and before receipt is reconciled by current bytes', async t => {
  const fixture = effectFixture(t, ['file:verified.txt', 'contains:verified.txt:Durable approved content']);
  const run = fixture.kernel.createRun(fixture.taskId);
  fixture.kernel.transition(fixture.taskId, 'running');
  const prepared = await fixture.gateway.prepare({ name: 'write_file', arguments: { path: 'verified.txt', content: 'Durable approved content\n' } });
  const intent = fixture.kernel.prepareIntent(fixture.taskId, run.id, { id: 'write-once', name: prepared.name, arguments: prepared.arguments }, { capability: 'workspace.write', paths: ['verified.txt'] });
  fixture.kernel.approve(intent.id);
  fixture.kernel.dispatch(intent.id);
  const interrupted = await fixture.gateway.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest, fault: 'after_effect_before_receipt' });
  assert.equal(interrupted.status, 'unknown');
  assert.equal(readFileSync(path.join(fixture.workspace, 'verified.txt'), 'utf8'), 'Durable approved content\n');
  fixture.restart();
  const observed = await fixture.gateway.queryOutcome(intent.effectKey, prepared.digest);
  assert.equal(observed.status, 'applied');
  assert.equal(observed.receipt!.reconciled, true);
  fixture.kernel.reconcile(intent.id, observed.receipt);
  const initialReview = await inspectEffects(fixture.kernel.getTask(fixture.taskId)!, fixture.kernel.intents(fixture.taskId), fixture.gateway);
  assert.equal(initialReview.passed, true);
  writeFileSync(path.join(fixture.workspace, 'verified.txt'), 'Changed after effect');
  const tampered = await inspectEffects(fixture.kernel.getTask(fixture.taskId)!, fixture.kernel.intents(fixture.taskId), fixture.gateway);
  assert.equal(tampered.passed, false, 'Receipt alone cannot conceal changed artifact bytes');
  assert.ok(tampered.findings.some(finding => finding.includes('Artifact changed')));
});

test('independent: a dispatched effect with no external evidence stays unknown through cancel and late observation', async t => {
  const fixture = effectFixture(t);
  const originalMessages = fixture.kernel.getMessages(fixture.taskId);
  const run = fixture.kernel.createRun(fixture.taskId);
  const prepared = await fixture.gateway.prepare({ name: 'fixture_increment', arguments: { amount: 1 } });
  const intent = fixture.kernel.prepareIntent(fixture.taskId, run.id, { id: 'claim-before-send', name: prepared.name, arguments: prepared.arguments });
  fixture.kernel.approve(intent.id);
  fixture.kernel.dispatch(intent.id);
  fixture.restart();
  const missing = await fixture.gateway.queryOutcome(intent.effectKey, prepared.digest);
  assert.equal(missing.status, 'unknown');
  fixture.kernel.reconcile(intent.id);
  const retry = { commandId: randomUUID(), type: 'retry', taskId: fixture.taskId };
  fixture.kernel.command(retry);
  fixture.kernel.command(retry);
  assert.equal(fixture.kernel.getTask(fixture.taskId)!.status, 'reconciling');
  assert.equal(fixture.kernel.getIntent(intent.id)!.state, 'unknown');
  fixture.kernel.command({ commandId: randomUUID(), type: 'cancel', taskId: fixture.taskId });
  fixture.kernel.reconcile(intent.id, { effectKey: intent.effectKey, digest: prepared.digest, fixtureValue: 1 });
  assert.equal(fixture.kernel.getTask(fixture.taskId)!.status, 'cancelled', 'Late effect facts must not resurrect the cancelled goal');
  assert.deepEqual(fixture.kernel.getMessages(fixture.taskId), originalMessages, 'Retry and recovery are typed controls, not user messages');
});
