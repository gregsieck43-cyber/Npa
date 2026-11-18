import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import { Kernel } from '../src/kernel/index.js';
import { ProductApprovals } from '../src/product/approvals.js';
import { ProductStore } from '../src/product/store.js';
import type { ProductRuntime } from '../src/product/shared.js';

/**
 * Product-level acceptance for the bounded approval-history query.
 *
 * Every value comes from a real startBackend (real SQLite Kernel/Harness/ProductApi and the local mock
 * provider); no Kernel method is stubbed. The 201-task and deep-history cases are the two shapes the old
 * listTasks/intents scan could not answer truthfully.
 */

const root = path.resolve(process.env.TEMP ?? '.tmp');
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t: import('node:test').TestContext) {
  mkdirSync(root, { recursive: true });
  const owned = mkdtempSync(path.join(root, 'product-approval-history-'));
  const relative = path.relative(process.cwd(), owned);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'fixture must stay inside the project tree');
  const dataDir = path.join(owned, 'data');
  const backend = await startBackend({ dataDir, projectRoot: process.cwd(), mockOptions: {} });
  // The projection under test is the operator approval query, not autonomous execution. Stop the
  // task runner so a queued task cannot race the manually prepared run in the mock provider.
  await backend.services.runner.stop();
  const store = new ProductStore(dataDir);
  const runtime: ProductRuntime = {
    services: backend.services,
    harness: backend.services.harness!,
    store,
    append: () => undefined,
  };
  const approvals = new ProductApprovals(runtime);
  const kernel = backend.services.kernel;
  const createAskTask = (objective: string): string => {
    const ack = backend.services.command({ commandId: randomUUID(), type: 'create_task',
      parameters: { objective, title: objective.slice(0, 60), permissionMode: 'ask', appMode: 'work' } });
    assert.ok(ack.taskId, 'create_task must answer with a task id');
    return ack.taskId!;
  };
  t.after(async () => { await backend.close(); store.close(); rmSync(owned, { recursive: true, force: true }); });
  return { backend, kernel, store, approvals, createAskTask };
}

test('old actionable approval survives 1000 old events and 200 newer cancelled tasks', { timeout: 120000 }, async t => {
  const { kernel, approvals, createAskTask } = await fixture(t);
  const taskId = createAskTask('An old approval that must stay visible');
  const taskUpdatedAt = kernel.getTask(taskId)!.updatedAt;
  const run = kernel.createRun(taskId);
  for (let index = 0; index < 1000; index++) kernel.appendEvent(taskId, 'history.noise', { index });
  await sleep(5);
  const intent = kernel.prepareIntent(taskId, run.id, { id: 'old-write', name: 'write_file', arguments: { path: 'old.txt', content: 'old' } });
  assert.equal(intent.authorization?.decision, 'ask');
  const prepared = kernel.events(taskId).find(event => event.type === 'intent.prepared' && String(event.payload.intentId ?? '') === intent.id);
  assert.ok(prepared, 'the prepared event must exist');
  assert.notEqual(prepared.createdAt, taskUpdatedAt, 'the fixture needs a prepared time distinct from the task update time');

  const inactive: string[] = [];
  for (let index = 0; index < 200; index++) {
    const newer = createAskTask('Inactive newer task ' + index);
    kernel.transition(newer, 'cancelled');
    inactive.push(newer);
  }

  const pending = approvals.pending();
  assert.equal(pending.length, 1, 'only the old actionable approval remains pending');
  assert.equal(pending[0]!.id, intent.id);
  assert.equal(pending[0]!.sessionId, taskId);
  assert.equal(pending[0]!.createdAt, prepared.createdAt, 'createdAt must be the real prepared event time, not task.updatedAt');
  assert.deepEqual(approvals.pending(taskId).map(item => item.id), [intent.id]);
  assert.deepEqual(approvals.pending(inactive[199]!), []);
  assert.deepEqual(kernel.pendingApprovals({ taskId: inactive[199]! }), []);
});

test('a legacy database without the prepared event reports an unknown approval time', { timeout: 120000 }, async t => {
  mkdirSync(root, { recursive: true });
  const owned = mkdtempSync(path.join(root, 'product-approval-legacy-'));
  const relative = path.relative(process.cwd(), owned);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'fixture must stay inside the project tree');
  const dataDir = path.join(owned, 'data');
  let kernel = new Kernel(dataDir);
  t.after(() => { kernel.close(); rmSync(owned, { recursive: true, force: true }); });

  const createAskTask = (objective: string) => {
    const ack = kernel.command({ commandId: randomUUID(), type: 'create_task',
      parameters: { objective, title: objective.slice(0, 60), permissionMode: 'ask', appMode: 'work' } });
    assert.ok(ack.taskId);
    return ack.taskId!;
  };
  const prepare = (taskId: string, id: string) => {
    const run = kernel.createRun(taskId);
    return kernel.prepareIntent(taskId, run.id, { id, name: 'write_file', arguments: { path: id + '.txt', content: 'x' } });
  };

  const legacyTaskId = createAskTask('Legacy event-missing approval');
  const legacyIntent = prepare(legacyTaskId, 'legacy-unknown');
  const legacyEvent = kernel.events(legacyTaskId).find(event => event.type === 'intent.prepared' && String(event.payload.intentId ?? '') === legacyIntent.id);
  assert.ok(legacyEvent, 'the fixture starts with a real prepared event');
  const knownTaskId = createAskTask('Known approval time');
  const knownIntent = prepare(knownTaskId, 'known-time');
  const knownEvent = kernel.events(knownTaskId).find(event => event.type === 'intent.prepared' && String(event.payload.intentId ?? '') === knownIntent.id);
  assert.ok(knownEvent);

  kernel.close();
  const raw = new DatabaseSync(path.join(dataDir, 'kernel.sqlite'));
  try {
    raw.exec('DROP INDEX IF EXISTS intents_actionable_prepared; DROP INDEX IF EXISTS intents_actionable_task; ALTER TABLE intents DROP COLUMN prepared_at;');
    raw.prepare("DELETE FROM events WHERE type='intent.prepared' AND json_extract(payload,'$.intentId')=?").run(legacyIntent.id);
  } finally { raw.close(); }

  kernel = new Kernel(dataDir);
  await sleep(5);
  const moved = kernel.transition(legacyTaskId, 'running');
  assert.notEqual(moved.updatedAt, legacyEvent.createdAt, 'the task update time is not the prepared time');

  const pending = kernel.pendingApprovals();
  const legacy = pending.find(item => item.intent.id === legacyIntent.id);
  assert.ok(legacy, 'the event-missing intent stays actionable');
  assert.equal(legacy.preparedAt, null);
  assert.equal(kernel.preparedAt(legacyIntent.id), undefined);

  const runtime = {
    services: { kernel },
    harness: { workTrace: { sync: () => undefined }, sanitize: (value: unknown) => value },
    store: {},
    append: () => undefined,
  } as unknown as ProductRuntime;
  const approvals = new ProductApprovals(runtime);
  const legacyView = approvals.pending().find(item => item.id === legacyIntent.id);
  assert.ok(legacyView, 'the product projection keeps the legacy approval');
  assert.equal(legacyView.createdAt, '', 'unknown must not reuse task.updatedAt');
  assert.equal(legacyView.createdAtKnown, false);

  const knownView = approvals.view(knownIntent, kernel.getTask(knownTaskId)!);
  assert.equal(knownView.createdAt, knownEvent.createdAt, 'a real event still supplies the exact time');
  assert.equal(knownView.createdAtKnown, true);
});

test('pending approvals are capped at 200 with a stable newest-first order', { timeout: 120000 }, async t => {
  const { kernel, approvals, createAskTask } = await fixture(t);
  const taskId = createAskTask('Many pending approvals');
  const run = kernel.createRun(taskId);
  const ids: string[] = [];
  for (let index = 0; index < 201; index++) {
    const intent = kernel.prepareIntent(taskId, run.id, { id: 'call-' + index, name: 'write_file', arguments: { path: 'f' + index + '.txt', content: 'x' } });
    assert.equal(intent.authorization?.decision, 'ask');
    ids.push(intent.id);
  }
  const pending = approvals.pending();
  assert.equal(pending.length, 200);
  assert.deepEqual(pending.map(item => item.id), ids.slice(1).reverse(), 'rowid DESC breaks prepared_at ties and the oldest entry is excluded');
  assert.deepEqual(approvals.pending().map(item => item.id), pending.map(item => item.id), 'repeated reads keep the same order');
  assert.equal(kernel.pendingApprovals({ limit: 200 }).length, 200);
  assert.equal(kernel.pendingApprovals({ taskId }).length, 200);
});

test('operator decisions still remove approvals and stale decisions are rejected', { timeout: 120000 }, async t => {
  const { kernel, approvals, createAskTask } = await fixture(t);
  const taskId = createAskTask('Decide the pending approvals');
  const run = kernel.createRun(taskId);
  const first = kernel.prepareIntent(taskId, run.id, { id: 'decide-1', name: 'write_file', arguments: { path: 'one.txt', content: '1' } });
  const second = kernel.prepareIntent(taskId, run.id, { id: 'decide-2', name: 'write_file', arguments: { path: 'two.txt', content: '2' } });
  assert.deepEqual(approvals.pending(taskId).map(item => item.id).sort(), [first.id, second.id].sort());

  approvals.decide(first.id, { approved: true, scope: 'once' });
  assert.equal(kernel.getIntent(first.id)?.state, 'approved');
  assert.deepEqual(approvals.pending(taskId).map(item => item.id), [second.id]);
  approvals.decide(second.id, { approved: false, scope: 'once' });
  assert.equal(kernel.getIntent(second.id)?.state, 'denied');
  assert.deepEqual(approvals.pending(taskId), []);
  assert.throws(() => approvals.decide(second.id, { approved: false, scope: 'once' }), (error: any) => error.code === 'stale' && error.status === 409);
});

test('cancelling the task fences the approval out of the pending list and decisions become stale', { timeout: 120000 }, async t => {
  const { backend, kernel, approvals, createAskTask } = await fixture(t);
  const taskId = createAskTask('Cancel fences the approval');
  const run = kernel.createRun(taskId);
  const intent = kernel.prepareIntent(taskId, run.id, { id: 'fenced', name: 'write_file', arguments: { path: 'fenced.txt', content: 'x' } });
  assert.deepEqual(approvals.pending(taskId).map(item => item.id), [intent.id]);
  backend.services.command({ commandId: randomUUID(), type: 'cancel', taskId, parameters: {} });
  assert.equal(kernel.getTask(taskId)?.status, 'cancelled');
  assert.deepEqual(approvals.pending(taskId), []);
  assert.throws(() => approvals.decide(intent.id, { approved: true, scope: 'once' }), (error: any) => error.code === 'stale' && error.status === 409);
});
