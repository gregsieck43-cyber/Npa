import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Services } from '../src/app/services.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockProvider } from '../src/fixtures/mock-provider.js';

test('operator task workspaces cannot expose authoritative backend state', async t => {
  const tempRoot = path.resolve('.tmp');
  const owned = mkdtempSync(path.join(tempRoot, 'app-controls-'));
  const dataDir = path.join(owned, 'data');
  const services = new Services(dataDir, path.resolve('.'), 'http://127.0.0.1:1', path.resolve('.'));
  t.after(async () => {
    try { await services.stop(); await services.external.close(); }
    finally {
      services.integrations.close();
      services.kernel.close();
      assert.ok(owned.startsWith(tempRoot + path.sep));
      rmSync(owned, { recursive: true, force: true });
    }
  });
  for (const workspace of [dataDir, path.join(dataDir, 'plugins'), path.join(dataDir, 'candidates')]) {
    assert.throws(() => services.command({ commandId: randomUUID(), type: 'create_task', parameters: {
      workspace, objective: 'Use this folder as an editable project',
    } }), /backend|state|workspace|protected|data|kernel/i, `Backend state became an editable workspace: ${workspace}`);
  }
  assert.equal(services.kernel.listTasks().length, 0);
});

test('normal shutdown leaves an interrupted model request recoverable after reopening the backend state', { timeout: 15000 }, async t => {
  const tempRoot = path.resolve('.tmp');
  const owned = mkdtempSync(path.join(tempRoot, 'app-controls-'));
  let requestStarted = false, firstClosed = false;
  const provider = createServer(request => { requestStarted = true; request.resume(); });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/provider/v1`;
  const dataDir = path.join(owned, 'data');
  const services = new Services(dataDir, path.resolve('.'), url, path.resolve('.'));
  let restored: Services | undefined;
  t.after(async () => {
    try {
      await services.stop(); await services.external.close();
      if (restored) { await restored.stop(); await restored.external.close(); }
    } finally {
      services.integrations.close();
      if (!firstClosed) services.kernel.close();
      restored?.integrations.close(); restored?.kernel.close(); provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      assert.ok(owned.startsWith(tempRoot + path.sep));
      rmSync(owned, { recursive: true, force: true });
    }
  });
  const ack = services.command({ commandId: randomUUID(), type: 'create_task', parameters: { objective: 'Await one local model fixture response', maxModelCalls: 5 } });
  services.runner.start();
  const deadline = Date.now() + 8000;
  while (!requestStarted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(requestStarted, 'Shutdown fixture must stop an actual model request');
  const modelCalls = services.kernel.getBudgets(ack.taskId!).modelCalls;
  await services.stop();
  assert.equal(services.task(ack.taskId).status, 'running');
  assert.equal(services.task(ack.taskId).error, undefined);
  services.kernel.close(); firstClosed = true;
  restored = new Services(dataDir, path.resolve('.'), url, path.resolve('.'));
  assert.equal(restored.task(ack.taskId).status, 'queued');
  assert.ok(restored.recovery.requeued.includes(ack.taskId!));
  assert.equal(restored.kernel.getBudgets(ack.taskId!).modelCalls, modelCalls);
  assert.equal(restored.kernel.getMessages(ack.taskId!).filter(message => message.role === 'user').length, 1);
});

test('a main message arriving during independent review cannot inherit the older passing verdict', { timeout: 40000 }, async t => {
  const tempRoot = path.resolve('.tmp');
  const owned = mkdtempSync(path.join(tempRoot, 'app-controls-'));
  let reviewing = false, reviews = 0, releaseReview!: () => void;
  const reviewGate = new Promise<void>(resolve => { releaseReview = resolve; });
  const provider = await startMockProvider({ responder: async body => {
    if (body.messages[0]?.content.includes('REVIEWER ROLE')) {
      if (++reviews > 1) return { content: JSON.stringify({ verdict: 'unknown', reason: 'Only the original snapshot receives PASS in this fixture.' }) };
      reviewing = true; await reviewGate;
      return { content: JSON.stringify({ verdict: 'pass', reason: 'Reviewed the original request only.' }) };
    }
    return { content: 'Original counter goal completed with independent receipt.' };
  } });
  const services = new Services(path.join(owned, 'data'), path.resolve('.'), provider.url, path.resolve('.'));
  t.after(async () => {
    releaseReview();
    try { await services.stop(); await services.external.close(); await provider.close(); }
    finally {
      services.integrations.close();
      services.kernel.close();
      assert.ok(owned.startsWith(tempRoot + path.sep));
      rmSync(owned, { recursive: true, force: true });
    }
  });
  const ack = services.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    goal: { objective: 'Increment a local fixture once', acceptance: ['fixture:count=1'], maxModelCalls: 8 },
  } });
  const task = services.task(ack.taskId), seedRun = services.kernel.createRun(task.id);
  services.kernel.transition(task.id, 'running');
  const gateway = services.runner.gateway(task);
  const prepared = await gateway.prepare({ name: 'fixture_increment', arguments: { amount: 1 } });
  const intent = services.kernel.prepareIntent(task.id, seedRun.id, { id: 'observed-fixture', name: prepared.name, arguments: prepared.arguments }, { capability: 'fixture.write' });
  services.kernel.approve(intent.id); services.kernel.dispatch(intent.id);
  const outcome = await gateway.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
  assert.equal(outcome.status, 'applied'); services.kernel.receipt(intent.id, outcome.receipt!);
  services.command({ commandId: randomUUID(), type: 'retry', taskId: task.id });
  services.runner.start();
  const deadline = Date.now() + 15000;
  while (!reviewing && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(reviewing, 'The independent model review must be in flight');
  const reviewedRevision = services.task(task.id).revision;
  services.command({ commandId: randomUUID(), type: 'send_message', taskId: task.id, parameters: { content: 'Add a new check before reporting completion.' } });
  assert.ok(services.task(task.id).revision > reviewedRevision);
  releaseReview();
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    if (services.task(task.id).status !== 'running' || services.kernel.getVerifications(task.id).length) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.notEqual(services.task(task.id).status, 'completed', 'The old verdict was rebound to an unreviewed main-message revision');
  assert.ok(services.kernel.getMessages(task.id).some(message => message.content === 'Add a new check before reporting completion.'));
});

test('model 429 retry schedule respects a provider delay longer than thirty seconds', { timeout: 15000 }, async t => {
  const tempRoot = path.resolve('.tmp');
  const owned = mkdtempSync(path.join(tempRoot, 'app-controls-'));
  let requests = 0;
  const provider = createServer((request, response) => {
    requests++; request.resume();
    response.writeHead(429, { 'Retry-After': '120' }); response.end('Controlled rate limit fixture');
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const services = new Services(path.join(owned, 'data'), path.resolve('.'), `http://127.0.0.1:${(provider.address() as AddressInfo).port}/provider/v1`, path.resolve('.'));
  t.after(async () => {
    try { await services.stop(); await services.external.close(); }
    finally {
      services.integrations.close();
      services.kernel.close(); provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      assert.ok(owned.startsWith(tempRoot + path.sep));
      rmSync(owned, { recursive: true, force: true });
    }
  });
  const ack = services.command({ commandId: randomUUID(), type: 'create_task', parameters: { objective: 'Attempt one model request to the local fixture', maxModelCalls: 5 } });
  services.runner.start();
  const deadline = Date.now() + 8000;
  let scheduled;
  while (Date.now() < deadline) {
    scheduled = services.kernel.events(ack.taskId!).find(event => event.type === 'model.retry_scheduled');
    if (scheduled) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(scheduled, 'Model rate limit must produce a durable retry schedule');
  assert.equal(requests, 1);
  assert.equal(scheduled.payload.reason, 'rate_limited');
  assert.ok(Number(scheduled.payload.due) - Date.parse(scheduled.createdAt) >= 119000, 'A 120-second provider delay was shortened before the next request');
});

test('default task workspaces and independent user projects still work while running product sources are protected', async t => {
  const tempRoot = path.resolve('.tmp');
  const owned = mkdtempSync(path.join(tempRoot, 'app-controls-'));
  const dataDir = path.join(owned, 'data');
  const userProject = path.join(owned, 'user-project'); mkdirSync(userProject);
  const services = new Services(dataDir, path.resolve('.'), 'http://127.0.0.1:1', path.resolve('.'));
  t.after(async () => {
    try { await services.stop(); await services.external.close(); }
    finally {
      services.integrations.close();
      services.kernel.close();
      assert.ok(owned.startsWith(tempRoot + path.sep));
      rmSync(owned, { recursive: true, force: true });
    }
  });
  const isolated = services.command({ commandId: randomUUID(), type: 'create_task', parameters: { objective: 'Isolated goal' } });
  assert.equal(services.task(isolated.taskId).workspace, path.join(dataDir, 'workspaces', isolated.taskId!));
  const explicit = services.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace: userProject, objective: 'User project' } });
  assert.equal(services.task(explicit.taskId).workspace, userProject);
  const before = services.kernel.listTasks();
  for (const workspace of [path.resolve('.'), path.resolve('src'), path.resolve('src/kernel'), path.resolve('build')]) {
    assert.throws(() => services.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace, objective: 'Modify product kernel' } }));
    assert.deepEqual(services.kernel.listTasks(), before);
  }
});

test('a packaged named data workspace can be selected explicitly without exposing the package or audit data', async t => {
  const tempRoot = path.resolve('.tmp'), owned = mkdtempSync(path.join(tempRoot, 'packaged-workspace-'));
  const dataDir = path.join(owned, 'release', 'candidate', 'data');
  const services = new Services(dataDir, process.cwd(), 'http://127.0.0.1:1', owned);
  t.after(async () => { await services.stop(); await services.external.close(); services.integrations.close(); services.kernel.close(); assert.equal(path.dirname(owned), tempRoot); rmSync(owned, { recursive: true, force: true }); });
  const workspace = path.join(dataDir, 'workspaces', 'selected-project');
  assert.equal(services.assertWorkspacePath(workspace), workspace);
  const task = services.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace, objective: 'Explicit packaged workspace' } });
  assert.equal(services.task(task.taskId).workspace, workspace);
  for (const target of [dataDir, path.dirname(dataDir), path.join(owned, 'release', 'candidate', 'resources'), path.join(owned, 'src')]) assert.throws(() => services.assertWorkspacePath(target));
});
