import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Kernel } from '../src/kernel/index.js';
import { Services } from '../src/app/services.js';
import { IntegrationService } from '../src/integrations/index.js';
import { HarnessStore } from '../src/harness/store.js';
import { ProductApi } from '../src/product/api.js';
import { ProductStore } from '../src/product/store.js';

class LegacyFixtureKernel extends Kernel {
  legacyUserMessage(taskId: string, content: string) {
    const message = { ...this.addMessage(taskId, 'user', 'legacy placeholder'), content };
    this.db.prepare('UPDATE messages SET body=? WHERE id=?').run(JSON.stringify(message), message.id);
    return message;
  }
  legacyReceipt(intentId: string, bytes: number) {
    const intent = this.getIntent(intentId)!;
    const body = { ...intent, state: 'applied', receipt: { retained: 'x'.repeat(bytes) } };
    this.db.prepare("UPDATE intents SET state='applied',body=? WHERE id=?").run(JSON.stringify(body), intentId);
  }
}

function fixture(t: TestContext) {
  const base = path.resolve(process.env.TEMP ?? '.tmp/hardening-011-snapshot');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'bounded-'));
  const kernel = new LegacyFixtureKernel(path.join(directory, 'kernel'));
  const integrations = new IntegrationService({ dataDir: path.join(directory, 'integrations'), projectRoot: directory, kernel });
  t.after(() => { integrations.close(); kernel.close(); rmSync(directory, { recursive: true }); });
  const create = (index: number) => kernel.command({ commandId: `create-${index}`, type: 'create_task', parameters: { title: `Task ${index}` } }).taskId!;
  return { kernel, integrations, directory, create };
}

test('legacy snapshot uses a recent task window and bounded presentation for both modes', t => {
  const { kernel, create } = fixture(t);
  let taskId = '';
  for (let index = 0; index < 205; index++) taskId = create(index);
  for (let index = 0; index < 220; index++) kernel.addMessage(taskId, 'user', `message-${index}`);
  for (const key of ['listTasks', 'getMessages', 'intents', 'getRuns', 'getCheckpoints', 'getVerifications', 'getDecisions', 'getMemories', 'events'] as const)
    kernel[key] = (() => { throw new Error(`Full history reader ${key} must not be used`); }) as never;
  const services = Object.assign(Object.create(Services.prototype) as Services, { kernel, runner: { managedExternally: { has: () => false } }, plugins: { list: () => [] }, candidates: { list: () => [] }, health: () => ({ status: 'ready' }) });
  for (const compact of [false, true]) {
    const snapshot = services.snapshot(taskId, compact);
    assert.equal(snapshot.tasks.length, 100);
    assert.equal(snapshot.selectedTask!.id, taskId);
    assert.equal(snapshot.messages.length, 160);
    assert.equal(snapshot.messages.at(-1)!.content, 'message-219');
    assert.ok(snapshot.nextCursor);
  }
});

test('message pages enforce accumulated UTF8 bytes without losing cursor positions', t => {
  const { kernel, create } = fixture(t), taskId = create(1);
  const ids: string[] = kernel.tailMessages(taskId).map(message => message.id);
  for (let index = 0; index < 90; index++) ids.push(kernel.addMessage(taskId, 'user', `${index}:` + '中'.repeat(8000)).id);
  let before = Number.MAX_SAFE_INTEGER;
  const seen: string[] = [];
  for (;;) {
    const page = kernel.messagePage(taskId, before, 100);
    assert.ok(Buffer.byteLength(JSON.stringify(page.messages)) <= 1024 * 1024);
    seen.unshift(...page.messages.map(message => message.id));
    if (page.nextCursor === null) break;
    assert.ok(page.nextCursor < before);
    before = page.nextCursor;
  }
  assert.deepEqual(seen, ids);
  const large = kernel.legacyUserMessage(taskId, '中'.repeat(400_000));
  const pending = kernel.userMessagesAfter(taskId, kernel.messageCursor(taskId, ids.at(-1)!));
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.message.content, large.content, 'input fragments retain their full original hash and offset identity');
  assert.deepEqual(kernel.consumedUserInput(taskId), { cursor: 0, offset: 0 });
  assert.throws(() => kernel.messagePage(taskId), /PAGE_RECORD_TOO_LARGE|exceeds.*page budget/);
  assert.equal(kernel.memory(taskId).read({ id: large.id, offset: 0, length: 200 }).totalChars, large.content.length);
});

test('plan readiness is task-local beyond one hundred unrelated runnable tasks and scope checks walk ancestors', t => {
  const { kernel, integrations, create } = fixture(t);
  for (let index = 0; index < 120; index++) create(index);
  const taskId = create(121);
  const plan = integrations.createPlan(taskId, { id: 'ready', title: 'Ready plan', nodes: [{ id: 'one', title: 'One', objective: 'Inspect', dependencies: [], paths: ['one'] }] });
  assert.equal(plan.nodes[0]!.ready, true);
  const childId = plan.nodes[0]!.childTaskId!, message = kernel.addMessage(childId, 'assistant', 'source evidence');
  kernel.childTasks = () => { throw new Error('Scope authorization must not materialize the descendant tree'); };
  kernel.queryDelegations = () => { throw new Error('Plan presentation must not materialize all historical delegations'); };
  kernel.runnableTasks = () => { throw new Error('Plan presentation must not scan global runnable tasks'); };
  assert.equal(integrations.plan(taskId)!.nodes[0]!.ready, true);
  assert.equal(integrations.readProcess(taskId, childId, message.id).text, message.content);
  assert.throws(() => integrations.readProcess(create(122), childId, message.id), /scope/i);
});

test('cold bootstrap projects every session and task through cursor pages', t => {
  const { kernel, directory, create } = fixture(t);
  const harnessStore = new HarnessStore(path.join(directory, 'harness'));
  const store = new ProductStore(path.join(directory, 'product'));
  const expected = new Set<string>();
  for (let index = 0; index < 205; index++) { expected.add(create(index)); expected.add(harnessStore.createSession({ title: `Chat ${index}` }).id); }
  store.dismissSession(create(205));
  store.dismissSession(harnessStore.createSession({ title: 'Dismissed Chat' }).id);
  kernel.listTasks = () => { throw new Error('Cold bootstrap cannot materialize every task'); };
  harnessStore.listSessions = () => { throw new Error('Cold bootstrap cannot materialize every chat'); };
  const observed = new Set<string>();
  const record = ({ id }: { id: string }) => {
    assert.ok(!observed.has(id), 'Each visible session should be projected once');
    observed.add(id);
  };
  const api = {
    services: { kernel, harness: { store: harnessStore, workOriginLink: () => undefined }, runner: { managedExternally: { has: () => false } } },
    store,
    sessions: { indexChatSession: record, indexWorkTask: record },
  };
  try { (ProductApi.prototype as unknown as { bootstrap(): void }).bootstrap.call(api); }
  finally { store.close(); harnessStore.close(); }
  assert.deepEqual(observed, expected);
});

test('operator acceptance uses paged evidence and indexed current result and run', async t => {
  const { kernel, create, directory } = fixture(t), taskId = create(1);
  const run = kernel.createRun(taskId);
  kernel.transition(taskId, 'running');
  kernel.addMessage(taskId, 'assistant', 'Reviewed result', 'main', { sampledUserInput: { cursor: kernel.latestUserCursor(taskId), offset: 0 } });
  kernel.transition(taskId, 'waiting_input');
  for (const key of ['getMessages', 'intents', 'getRuns'] as const) kernel[key] = (() => { throw new Error(`Acceptance must not use ${key}`); }) as never;
  const services = Object.assign(Object.create(Services.prototype) as Services, { kernel, dataDir: directory, runner: { gateway: () => ({}) }, integrations: { tools: undefined }, configuration: { redact: (value: string) => value } });
  const result = await services.acceptResult({ taskId, expectedRevision: kernel.getTask(taskId)!.revision, accepted: true });
  assert.equal(result.accepted, true);
  assert.equal(kernel.getTask(taskId)!.status, 'completed');
  assert.equal(kernel.latestRun(taskId)!.id, run.id);
  assert.equal(kernel.latestRun(taskId)!.status, 'completed');
});

test('an oversized legacy receipt is explicit and stays archived instead of passing an incomplete review', t => {
  const { kernel, create } = fixture(t), taskId = create(1);
  const run = kernel.createRun(taskId); kernel.transition(taskId, 'running');
  const allowed = kernel.prepareIntent(taskId, run.id, { id: 'valid-large-receipt', name: 'read_file', arguments: { path: 'valid.txt' } });
  kernel.legacyReceipt(allowed.id, 1100 * 1024);
  assert.equal(String(kernel.intentPage(taskId).items[0]!.receipt!.retained).length, 1100 * 1024,
    'valid receipts above 1 MiB remain readable within the current 8 MiB evidence page budget');
  const intent = kernel.prepareIntent(taskId, run.id, { id: 'large-receipt', name: 'read_file', arguments: { path: 'sample.txt' } });
  kernel.legacyReceipt(intent.id, 9 * 1024 * 1024);
  const first = kernel.intentPage(taskId);
  assert.ok(first.nextCursor, 'the valid first receipt remains a complete bounded page');
  assert.throws(() => kernel.intentPage(taskId, first.nextCursor!), /exceeds.*page budget/);
  assert.equal(String(kernel.getIntent(intent.id)!.receipt!.retained).length, 9 * 1024 * 1024);
});
