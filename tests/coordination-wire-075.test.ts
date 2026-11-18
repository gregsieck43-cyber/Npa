import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import { startMockProvider } from '../src/fixtures/mock-provider.js';
import { ModelClient, type ModelObserver } from '../src/runtime/model.js';
import { WorkspacePresence } from '../src/app/workspace-presence.js';
import { resourceBudget } from '../src/app/resource-budget.js';

async function until<T>(read: () => T | undefined, label: string, diagnose?: () => unknown): Promise<T> {
  const end = performance.now() + 15000;
  for (;;) { const value = read(); if (value !== undefined) return value; if (performance.now() > end) throw new Error('Timed out: ' + label + (diagnose ? '\n' + JSON.stringify(diagnose()) : '')); await new Promise(resolve => setTimeout(resolve, 15)); }
}
function workDiagnostic(backend: Awaited<ReturnType<typeof startBackend>>, id: string, started: number, delay: ReturnType<typeof monitorEventLoopDelay>) {
  const task = backend.services.kernel.getTask(id)!, resource = resourceBudget.status();
  return { elapsedMs: Math.round(performance.now() - started), maxEventLoopDelayMs: Math.round(delay.max / 1e6), providerRequests: backend.mock.requests(),
    task: { status: task.status, generation: task.generation, policyEpoch: task.policyEpoch },
    resources: { pressure: resource.pressure, activeLeases: resource.activeLeases, waitingLeases: resource.waitingLeases, monitoring: resource.monitoring },
    presenceIssue: backend.services.workspacePresenceIssue,
    events: backend.services.kernel.recentEvents(id, 12).map(event => ({ type: event.type, code: event.payload.code, message: typeof event.payload.message === 'string' ? backend.services.configuration.redact(event.payload.message).slice(0, 500) : undefined })),
    requests: backend.services.harness!.store.listRequests({ taskId: id, order: 'desc', limit: 3 }).requests.map(request => ({ status: request.status, code: request.error?.code })),
  };
}

test('CO-01/02 actual Work request carries runtime notice IDs and exact dispatch hash, without pausing either task', async t => {
  const dir = mkdtempSync(path.join(path.resolve(process.env.TEMP ?? '.tmp'), 'coord-wire-'));
  const workspace = path.join(dir, 'workspace'); mkdirSync(workspace);
  const bodies: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const backend = await startBackend({ dataDir: path.join(dir, 'data'), projectRoot: process.cwd(), mockOptions: {
    trace: body => bodies.push(body), responder: async body => {
      const a = String(body.messages[0]?.content).includes('COORD_A');
      if (a && !body.messages.some((message: any) => message.role === 'tool')) {
        await gate;
        return { content: '', toolCalls: [{ id: 'read-events-a', name: 'read_events', arguments: {} }] };
      }
      return { content: '', toolCalls: [{ id: randomUUID(), name: 'ask_user', arguments: { question: 'Need a real follow-up choice', reason: 'blocker' } }] };
    },
  } });
  t.after(async () => { release(); await backend.close(); rmSync(dir, { recursive: true, force: true }); });
  const kernel = backend.services.kernel;
  const create = (title: string) => backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { title, workspace, initialStatus: 'paused', permissionMode: 'read-only', goal: { objective: title, constraints: [], acceptance: [], mode: 'autonomous', maxModelCalls: 20, maxToolCalls: 20 } } }).taskId!;
  const a = create('COORD_A'), b = create('COORD_B');
  backend.services.command({ commandId: randomUUID(), type: 'resume', taskId: a });
  await until(() => bodies.length ? true : undefined, 'A dispatch');
  assert.equal(kernel.getTask(a)!.status, 'running');
  backend.services.harness!.store.setSetting('recordContent', false);
  backend.services.command({ commandId: randomUUID(), type: 'resume', taskId: b });
  const bBody = await until(() => bodies.find(body => String(body.messages[0]?.content).includes('COORD_B')), 'B dispatch');
  assert.equal(kernel.getTask(a)!.status, 'running', 'join must not pause A');
  const bRuntime = bBody.messages.find((message: any) => String(message.content).startsWith('Workspace runtime metadata.'));
  assert.equal(bRuntime.role, 'system'); assert.match(bRuntime.content, /COORD_A/); assert.match(bRuntime.content, /notice-/);
  release();
  const aNext = await until(() => bodies.find(body => String(body.messages[0]?.content).includes('COORD_A') && body.messages.some((message: any) => message.role === 'tool')), 'A next ordinary request');
  const aRuntime = aNext.messages.find((message: any) => String(message.content).startsWith('Workspace runtime metadata.'));
  assert.equal(aRuntime.role, 'system'); assert.match(aRuntime.content, /COORD_B/);
  await until(() => kernel.getTask(a)?.status === 'waiting_input' && kernel.getTask(b)?.status === 'waiting_input' ? true : undefined, 'both tasks explicitly ask for user input');
  const db = new DatabaseSync(path.join(dir, 'data', 'kernel.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM coordination_attempts WHERE task_id=?').all(b) as Record<string, any>[];
    assert.ok(rows.length > 0);
    const bodyHash = createHash('sha256').update(JSON.stringify(bBody)).digest('hex');
    assert.equal(rows[0]!.body_hash, bodyHash); assert.equal(rows[0]!.stage, 'completed');
    const request = backend.services.harness!.store.getRequest(rows[0]!.request_id);
    assert.equal(request.recordContent, false); assert.equal(request.body, undefined);
    assert.equal(kernel.coordination.inbox(b).items[0]!.ackedAt, null);
  } finally { db.close(); }
  const response = await fetch(`http://127.0.0.1:${backend.port}/v1/product/coordination/inbox?sessionId=${b}`, { headers: { Authorization: 'Bearer ' + backend.token } });
  assert.equal(response.status, 200); assert.ok((await response.json() as any).items.length > 0);
});

test('dispatch observations follow real credential/abort checks and a local binding failure makes zero provider requests', async t => {
  const provider = await startMockProvider({ responder: () => ({ content: 'observed' }) });
  t.after(() => provider.close());
  const phases: string[] = [];
  const observer: ModelObserver = { prepare: body => ({ body, requestId: 'request-test' }), dispatching: () => { phases.push('dispatch'); }, responseObserved: () => { phases.push('response'); }, completed: () => { phases.push('completed'); }, failed: () => { phases.push('failed'); } };
  const config = { baseUrl: provider.url, model: 'mock', mode: 'mock' as const, timeoutMs: 5000, maxOutputTokens: 64 };
  const messages = [{ role: 'user' as const, content: 'test' }];
  await assert.rejects(new ModelClient(config, undefined, observer).complete(messages, [], AbortSignal.abort()));
  assert.equal(phases.includes('dispatch'), false); assert.equal(provider.requests(), 0); phases.length = 0;
  await assert.rejects(new ModelClient({ ...config, baseUrl: 'https://fixture.invalid/', mode: 'live' }, () => undefined, observer).complete(messages), /credential/);
  assert.equal(phases.includes('dispatch'), false); assert.equal(provider.requests(), 0); phases.length = 0;
  await assert.rejects(new ModelClient(config, undefined, { ...observer, dispatching: () => { throw new Error('binding failed'); } }).complete(messages), /binding failed/);
  assert.equal(provider.requests(), 0); phases.length = 0;
  await new ModelClient(config, undefined, observer).complete(messages);
  assert.deepEqual(phases, ['dispatch', 'response', 'completed']); assert.equal(provider.requests(), 1);
});

test('bound side chat uses real dispatch budget and unknown token coverage without duplicate billing', async t => {
  const dir = mkdtempSync(path.join(path.resolve(process.env.TEMP ?? '.tmp'), 'side-budget-wire-'));
  let calls = 0;
  const backend = await startBackend({ dataDir: path.join(dir, 'data'), projectRoot: process.cwd(), mockOptions: { responder: () => { calls++; return { content: 'side answer' }; } } });
  t.after(async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); });
  const { kernel, product, harness } = backend.services;
  const parent = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace: dir, initialStatus: 'paused', goal: { objective: 'Side accounting', mode: 'autonomous', constraints: [], acceptance: [], maxModelCalls: 1, maxToolCalls: 10 } } }).taskId!;
  const input = { sessionId: parent, messageId: 'side-accounting-input', question: 'Explain current state.', attachments: [], modelId: 'default' };
  const answer = await product!.chat.side.ask(input, async () => '', () => '');
  assert.equal(calls, 1); assert.equal(kernel.getBudgets(parent).modelCalls, 1);
  assert.equal(harness!.store.getRequest(answer.requestId!).taskId, parent);
  assert.equal(kernel.sideRequests.get(answer.requestId!)!.status, 'completed');
  assert.deepEqual(await product!.chat.side.ask(input, async () => '', () => ''), answer);
  assert.equal(calls, 1); assert.equal(kernel.getBudgets(parent).modelCalls, 1);
  await assert.rejects(product!.chat.side.ask({ ...input, messageId: 'over-budget' }, async () => '', () => ''), /budget.*exhausted/);
  assert.equal(calls, 1, 'budget rejection must precede fetch');
  assert.equal(kernel.getSideBudgets(parent)[0]!.modelCalls, 1, 'failed parent charge rolls back side reservation');
  const metrics = product!.observability.metrics(parent);
  assert.equal(metrics.usageCoverage!.requests, 2, 'known response and failed pre-dispatch request are explicitly covered');
});

test('external presence reaches actual Product and Work wire as advisory data without internal claims', async t => {
  const dir = mkdtempSync(path.join(path.resolve(process.env.TEMP ?? '.tmp'), 'external-wire-'));
  const workspace = path.join(dir, 'workspace'); mkdirSync(workspace);
  const writer = new WorkspacePresence(workspace => workspace);
  await writer.sync([{ workspace, label: 'Independent writer', objective: '<script>do not execute</script>', claims: ['shared.txt'] }]);
  const bodies: any[] = [];
  const backend = await startBackend({ dataDir: path.join(dir, 'data'), projectRoot: process.cwd(), mockOptions: { trace: body => bodies.push(body), responder: () => ({ content: '', toolCalls: [{ id: randomUUID(), name: 'ask_user', arguments: { reason: 'blocker', question: 'Await input' } }] }) } });
  t.after(async () => { await backend.close(); await writer.close(); rmSync(dir, { recursive: true, force: true }); });
  const { kernel } = backend.services;
  const id = backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: 'External observer', workspace, initialStatus: 'paused' } }).taskId!;
  const response = await fetch(`http://127.0.0.1:${backend.port}/v1/product/coordination/presence?sessionId=${id}`, { headers: { Authorization: 'Bearer ' + backend.token } });
  assert.equal(response.status, 200); const page = await response.json() as any;
  assert.equal(page.external.items[0].label, 'Independent writer'); assert.equal(page.external.items[0].advisory, true);
  assert.equal(kernel.fileClaims.claims(workspace).items.length, 0);
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  const started = performance.now();
  const diagnostic = () => ({ phase: 'external-runtime-dispatch', ...workDiagnostic(backend, id, started, delay) });
  backend.services.command({ commandId: randomUUID(), type: 'resume', taskId: id });
  let body: any;
  try { body = await until(() => bodies[0], 'external runtime dispatch', diagnostic); }
  finally { t.diagnostic(JSON.stringify(diagnostic())); delay.disable(); }
  const runtime = body.messages.find((message: any) => String(message.content).startsWith('Workspace runtime metadata.'));
  assert.match(runtime.content, /Independent writer/); assert.match(runtime.content, /advisory only/); assert.equal(runtime.role, 'system');
  assert.equal(kernel.getTask(page.external.items[0].id), undefined);
});

test('Runner stops repeated local observations at the durable no-progress boundary', async t => {
  const dir = mkdtempSync(path.join(path.resolve(process.env.TEMP ?? '.tmp'), 'progress-wire-'));
  const workspace = path.join(dir, 'workspace'); mkdirSync(workspace);
  const backend = await startBackend({ dataDir: path.join(dir, 'data'), projectRoot: process.cwd(), mockOptions: { responder: () => ({ content: 'Continue observing', toolCalls: [{ id: randomUUID(), name: 'read_events', arguments: {} }] }) } });
  t.after(async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); });
  const { kernel } = backend.services;
  const id = backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace, goal: { objective: 'Observe forever without new evidence', constraints: [], acceptance: [], mode: 'autonomous', maxModelCalls: 100, maxToolCalls: 100 } } }).taskId!;
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  const started = performance.now();
  const diagnostic = () => ({ phase: 'no-progress-guard', modelCalls: kernel.getBudgets(id).modelCalls, ...workDiagnostic(backend, id, started, delay) });
  try { await until(() => kernel.getTask(id)?.status === 'waiting_input' ? true : undefined, 'no-progress guard', diagnostic); }
  finally { t.diagnostic(JSON.stringify(diagnostic())); delay.disable(); }
  assert.match(kernel.getTask(id)!.waitingReason!, /12/);
  const count = kernel.getBudgets(id).modelCalls;
  assert.ok(count >= 12 && count < 30); assert.equal(kernel.latestEvent(id, 'progress.waiting_input')!.payload.limit, 12);
  await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(kernel.getBudgets(id).modelCalls, count);
});

test('legacy side dispatch has one budget identity and advisory cleanup failure cannot stop backend shutdown', async t => {
  const dir = mkdtempSync(path.join(path.resolve(process.env.TEMP ?? '.tmp'), 'legacy-side-wire-'));
  const workspace = path.join(dir, 'workspace'); mkdirSync(workspace);
  const backend = await startBackend({ dataDir: path.join(dir, 'data'), projectRoot: process.cwd(), mockOptions: { responder: () => ({ content: 'legacy side answer' }) } });
  t.after(async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); });
  const kernel = backend.services.kernel;
  const parent = backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace, title: 'Accounting parent', initialStatus: 'paused' } }).taskId!;
  kernel.command({ commandId: randomUUID(), type: 'delegate', taskId: parent, parameters: { objective: 'Child' } });
  const child = kernel.delegations(parent)[0]!.childTaskId;
  await backend.services.sidechat({ taskId: child, sessionId: 'legacy', message: 'Explain' });
  assert.deepEqual(kernel.getSideBudgets(child).map(row => [row.sessionId, row.modelCalls]), [['legacy', 1]]);
  assert.equal(kernel.getBudgets(child).modelCalls, 1); assert.equal(kernel.getBudgets(parent).modelCalls, 1);
  assert.equal(backend.services.harness!.store.metrics({ taskId: parent }).requests, 1);
  const store = backend.services.harness!.store;
  const legacy = store.createRequest({ sessionId: 'old-child', taskId: child, parentId: parent, profileId: 'default', kind: 'work', status: 'completed', endpoint: 'http://fixture/', bodyHash: 'fixture', recordContent: false, sources: [], draft: '', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  assert.equal(store.metrics({ taskId: parent }).requests, 1);
  await backend.services.harness!.requests.recoverAccountingScopes();
  assert.equal(store.metrics({ taskId: parent }).requests, 2);
  await backend.services.harness!.requests.recoverAccountingScopes();
  assert.equal(store.metrics({ taskId: parent }).requests, 2, legacy.id);
  const closePresence = backend.services.workspacePresence.close.bind(backend.services.workspacePresence);
  backend.services.workspacePresence.close = async () => { await closePresence(); throw new Error('fixture: advisory close rejected'); };
  await backend.close(); assert.match(backend.services.workspacePresenceIssue!, /cleanup incomplete/);
  await assert.rejects(fetch(`http://127.0.0.1:${backend.port}/v1/health`));
});

test('runtime-generated completion prompts cannot reset the no-progress guard', async t => {
  const dir = mkdtempSync(path.join(path.resolve(process.env.TEMP ?? '.tmp'), 'progress-finish-'));
  const workspace = path.join(dir, 'workspace'); mkdirSync(workspace);
  let observedNewInput = false;
  const newInput = 'New operator input: reconsider and continue.';
  const backend = await startBackend({ dataDir: path.join(dir, 'data'), projectRoot: process.cwd(), mockOptions: { responder: body => {
    if (body.messages.some((message: any) => message.role === 'user' && String(message.content).includes(newInput))) observedNewInput = true;
    return { content: 'Done again.' };
  } } });
  t.after(async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); });
  const kernel = backend.services.kernel;
  const id = backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace, initialStatus: 'paused', goal: { objective: 'Do not falsely finish with unsettled children', constraints: [], acceptance: [], mode: 'autonomous', maxModelCalls: 100, maxToolCalls: 100 } } }).taskId!;
  kernel.command({ commandId: randomUUID(), type: 'delegate', taskId: id, parameters: { objective: 'Unsettled child' } });
  const child = kernel.delegations(id)[0]!.childTaskId; kernel.manageExternally(child);
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable(); const started = performance.now();
  const diagnostic = () => ({ phase: 'generated-feedback-guard', ...workDiagnostic(backend, id, started, delay) });
  backend.services.command({ commandId: randomUUID(), type: 'resume', taskId: id });
  try { await until(() => kernel.latestEvent(id, 'progress.waiting_input') ? true : undefined, 'generated feedback loop guard', diagnostic); }
  finally { t.diagnostic(JSON.stringify(diagnostic())); delay.disable(); }
  assert.equal(kernel.getTask(id)!.status, 'waiting_input'); assert.ok(kernel.getBudgets(id).modelCalls < 30);
  assert.ok(kernel.getMessages(id).some(message => message.inputOrigin === 'runtime'));
  const spent = kernel.getBudgets(id).modelCalls;
  backend.services.command({ commandId: randomUUID(), type: 'send_message', taskId: id, parameters: { content: newInput } });
  await until(() => observedNewInput ? true : undefined, 'fresh operator input reaches real provider after reopening the guard');
  assert.ok(kernel.getBudgets(id).modelCalls > spent);
});

test('known side usage survives a real Harness completion projection failure and is not redispatched', async t => {
  const dir = mkdtempSync(path.join(path.resolve(process.env.TEMP ?? '.tmp'), 'side-projection-'));
  const backend = await startBackend({ dataDir: path.join(dir, 'data'), projectRoot: process.cwd(), mockOptions: { responder: () => ({ content: 'known provider answer' }) } });
  t.after(async () => { await backend.close(); assert.equal(path.dirname(dir), path.resolve(process.env.TEMP ?? '.tmp')); rmSync(dir, { recursive: true, force: true }); });
  const { kernel, harness, product } = backend.services;
  const id = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: 'Side projection failure', workspace: dir, initialStatus: 'paused' } }).taskId!;
  const store = harness!.store, update = store.updateRequest.bind(store); let failedRequest = '';
  store.updateRequest = (requestId, patch) => {
    if (patch.status === 'completed') { failedRequest = requestId; throw new Error('fixture: local projection failed after observed response'); }
    return update(requestId, patch);
  };
  const input = { sessionId: id, messageId: 'projection-failure', question: 'Explain current state.', attachments: [], modelId: 'default' };
  await assert.rejects(product!.chat.side.ask(input, async () => '', () => ''), /projection failed/);
  store.updateRequest = update;
  assert.equal(backend.mock.requests(), 1); assert.ok(failedRequest);
  assert.equal(store.getRequest(failedRequest).status, 'failed');
  assert.equal(kernel.sideRequests.get(failedRequest)!.status, 'completed');
  assert.equal(kernel.sideRequests.get(failedRequest)!.usageState, 'known');
  assert.equal(kernel.getBudgets(id).modelCalls, 1);
  const replay = await product!.chat.side.ask(input, async () => '', () => ''); assert.equal(replay.status, 'failed');
  assert.equal(backend.mock.requests(), 1); assert.equal(kernel.getBudgets(id).modelCalls, 1);
});

test('historical ancestor accounting commits bounded pages and resumes an interrupted page without duplicates', async t => {
  const dir = mkdtempSync(path.join(path.resolve(process.env.TEMP ?? '.tmp'), 'accounting-pages-'));
  const backend = await startBackend({ dataDir: path.join(dir, 'data'), projectRoot: process.cwd() });
  t.after(async () => { await backend.close(); assert.equal(path.dirname(dir), path.resolve(process.env.TEMP ?? '.tmp')); rmSync(dir, { recursive: true, force: true }); });
  const { kernel, harness } = backend.services;
  const parent = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: 'Historical accounting parent', workspace: dir, initialStatus: 'paused' } }).taskId!;
  kernel.command({ commandId: randomUUID(), type: 'delegate', taskId: parent, parameters: { objective: 'Historical accounting child' } });
  const child = kernel.delegations(parent)[0]!.childTaskId; kernel.manageExternally(child);
  const store = harness!.store;
  store.transaction(() => { for (let i = 0; i < 513; i++) store.createRequest({ sessionId: 'historic-child', taskId: child, parentId: parent,
    profileId: 'default', kind: 'work', status: 'completed', endpoint: 'http://fixture/', bodyHash: 'fixture', recordContent: false, sources: [], draft: '',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }); });
  const save = store.saveAccountingScopes.bind(store), page = store.accountingRequestPage.bind(store); let writes = 0; const pageSizes: number[] = [];
  store.accountingRequestPage = cursor => { const rows = page(cursor); pageSizes.push(rows.length); return rows; };
  store.saveAccountingScopes = (requestId, taskIds) => { if (++writes === 270) throw new Error('fixture: accounting page interrupted'); save(requestId, taskIds); };
  await assert.rejects(harness!.requests.recoverAccountingScopes(), /page interrupted/);
  assert.equal(store.metrics({ taskId: parent }).requests, 256, 'only the first committed page survives');
  store.saveAccountingScopes = save;
  await harness!.requests.recoverAccountingScopes(); await harness!.requests.recoverAccountingScopes();
  assert.ok(pageSizes.every(size => size <= 256));
  const metrics = store.metrics({ taskId: parent }); assert.equal(metrics.requests, 513); assert.equal(metrics.totalTokens, 513 * 15);
  assert.equal(store.metrics({ taskId: child }).requests, 513); assert.equal(backend.mock.requests(), 0);
});

test('in-flight advisory synchronization failure still closes backend transport and attempts owner cleanup', async t => {
  const dir = mkdtempSync(path.join(path.resolve(process.env.TEMP ?? '.tmp'), 'presence-stop-'));
  const workspace = path.join(dir, 'workspace'); mkdirSync(workspace);
  const backend = await startBackend({ dataDir: path.join(dir, 'data'), projectRoot: process.cwd() });
  t.after(async () => { await backend.close(); assert.equal(path.dirname(dir), path.resolve(process.env.TEMP ?? '.tmp')); rmSync(dir, { recursive: true, force: true }); });
  backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { title: 'Presence shutdown fixture', workspace, initialStatus: 'paused' } });
  await backend.services.runner.stop();
  await backend.services.observeWorkspace(workspace);
  let rejectSync!: (error: Error) => void, entered!: () => void, cleaned = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  backend.services.workspacePresence.sync = async () => { entered(); return new Promise((_resolve, reject) => { rejectSync = reject; }); };
  const close = backend.services.workspacePresence.close.bind(backend.services.workspacePresence);
  backend.services.workspacePresence.close = async () => { cleaned = true; await close(); };
  const observing = backend.services.observeWorkspace(workspace); const rejected = assert.rejects(observing, /synchronization rejected/);
  await started; const stopping = backend.close();
  await new Promise<void>(resolve => setImmediate(resolve));
  rejectSync(new Error('fixture: synchronization rejected'));
  await rejected; await stopping;
  assert.equal(cleaned, true); assert.match(backend.services.workspacePresenceIssue!, /synchronization failed during shutdown/);
  await assert.rejects(fetch(`http://127.0.0.1:${backend.port}/v1/health`));
});
