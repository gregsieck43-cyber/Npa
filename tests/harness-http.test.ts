import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startBackend } from '../src/app/backend.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';

async function fixture(t: import('node:test').TestContext, options: MockProviderOptions = {}) {
  const root = path.resolve(process.env.TEMP ?? '.tmp'), owned = mkdtempSync(path.join(root, 'harness-http-'));
  const workspace = path.join(owned, 'workspace'); mkdirSync(workspace);
  const wire: any[] = [];
  const settings = { dataDir: path.join(owned, 'data'), projectRoot: process.cwd(), mockOptions: { ...options, trace: (body: any) => wire.push(body) } };
  let backend = await startBackend(settings);
  t.after(async () => { await backend.close(); assert.equal(path.dirname(owned), root); rmSync(owned, { recursive: true, force: true }); });
  const call = async (method: string, route: string, input?: unknown, status = 200): Promise<any> => {
    const response = await fetch(`http://127.0.0.1:${backend.port}${route.startsWith('/v1') ? route : '/v1/harness' + route}`, {
      method, headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const until = async (read: () => Promise<any>, ready: (value: any) => boolean) => {
    const deadline = performance.now() + 18000; let value;
    do { value = await read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 30)); } while (performance.now() < deadline);
    assert.fail(`Did not settle: ${JSON.stringify(value)}`);
  };
  return { call, until, workspace, wire, get backend() { return backend; }, async restart() { await backend.close(); backend = await startBackend(settings); } };
}

test('HTTP Chat and Studio capture the actual wire, preserve branches, scopes and restart history', { timeout: 30000 }, async t => {
  const f = await fixture(t, { delayMs: 60 });
  const session = await f.call('POST', '/sessions', { title: 'HTTP chat', workspace: f.workspace });
  const inspection = await f.call('GET', `/tools?sessionId=${session.id}`);
  for (const name of ['search_history', 'read_history', 'recall_memory', 'remember']) assert.ok(inspection.allowed.some((tool: any) => tool.function.name === name), `${name} is available without workspace permission`);
  assert.ok(!inspection.allowed.some((tool: any) => tool.function.name === 'write_file'));
  await f.call('POST', '/prompts', { scope: 'global', systemPrompt: 'Global instruction' });
  await f.call('POST', '/prompts', { scope: 'session', scopeId: session.id, systemPrompt: 'Session override' });
  const first = await f.call('POST', '/chat', { sessionId: session.id, content: 'First user question' });
  const done = await f.until(() => f.call('GET', `/requests/${first.requestId}`), value => value.status === 'completed');
  assert.deepEqual(done.body, f.wire[0]); assert.ok(done.usage.total_tokens > 0); assert.ok(done.durationMs >= 0);
  assert.ok(done.body.messages.some((m: any) => m.content === 'Session override'));
  assert.ok(!done.body.messages.some((m: any) => m.content === 'Global instruction'));
  assert.equal(done.sources.find((p: any) => p.id === 'global:systemPrompt').effective, false);
  const preview = await f.call('POST', '/preview', { sessionId: session.id, overrides: { systemPrompt: 'Once only' } });
  assert.ok(preview.body.messages.some((m: any) => m.content === 'Once only'));
  assert.ok(!preview.body.messages.some((m: any) => m.content === 'Session override'));
  assert.equal((await f.call('GET', `/prompts?scope=session&scopeId=${session.id}`)).systemPrompt, 'Session override');
  const view = await f.until(() => f.call('GET', `/sessions/${session.id}`), value => value.messages.length === 2);
  const branched = await f.call('POST', `/sessions/${session.id}/branch`, { messageId: view.messages[0].id, content: 'Edited branch' });
  await f.until(() => f.call('GET', `/sessions/${branched.id}`), value => !value.activeRequestId && value.messages.length === 2);
  assert.equal((await f.call('GET', `/sessions/${session.id}`)).messages[0].content, 'First user question');
  const body = { ...done.body, temperature: 0.17, seed: 33, stream: false }; delete body.stream_options;
  const replay = await f.call('POST', `/requests/${done.id}/send`, { body });
  const replayed = await f.until(() => f.call('GET', `/requests/${replay.id}`), value => value.status === 'completed');
  assert.equal(replayed.parentId, done.id); assert.deepEqual(f.wire.at(-1), body);
  await f.call('POST', `/requests/${done.id}/send`, { body: { ...body, temperature: 10 } }, 400);
  await f.restart(); assert.equal((await f.call('GET', `/requests/${replay.id}`)).status, 'completed');
  assert.equal((await f.call('GET', `/sessions/${session.id}`)).messages.length, 2);
  const trace = await f.call('GET', `/trace?sessionId=${session.id}`); assert.ok(trace.events.some((e: any) => e.requestId === first.requestId && e.type === 'request.completed'));
});

test('HTTP Chat refuses a forged write proposal without an approval or effect, and Studio never executes tool proposals', { timeout: 30000 }, async t => {
  const f = await fixture(t, { responder: body => body.messages.some((message: any) => message.role === 'tool')
    ? { content: 'Observed the real receipt.' }
    : { content: '', toolCalls: [{ id: 'forged-write', name: 'write_file', arguments: { path: 'approved.txt', content: 'FORGED' } }] } });
  const session = await f.call('POST', '/sessions', { workspace: f.workspace, capabilities: { tools: true } });
  const request = await f.call('POST', '/chat', { sessionId: session.id, content: 'Write approved.txt' });
  const rejected = await f.until(() => f.call('GET', `/tools?requestId=${request.requestId}`), value => value.calls.some((c: any) => c.name === 'write_file' && c.failureStage === 'permission'));
  const tool = rejected.calls.find((c: any) => c.name === 'write_file');
  assert.equal(tool.status, 'failed'); assert.equal(tool.intentId, undefined, 'a read-only Chat refusal never creates an approvable intent');
  assert.match(tool.error, /not both enabled/);
  assert.equal(existsSync(path.join(f.workspace, 'approved.txt')), false);
  assert.ok(rejected.calls.every((c: any) => c.status !== 'awaiting_approval'), 'Chat never offers an approval for a side effect');
  const inspectionDraft = await f.call('POST', '/preview', { sessionId: session.id });
  assert.equal(inspectionDraft.kind, 'studio', 'Inspecting the request must not take over Chat continuation');
  const metrics = await f.call('GET', `/metrics?sessionId=${session.id}`);
  assert.equal(metrics.rounds, 1); assert.equal(metrics.steps, 2); assert.equal(metrics.toolCalls, 1); assert.equal(metrics.activeTools.length, 0);
  assert.ok(metrics.totalTokens > 0); assert.equal(metrics.cachedTokens, null);
  assert.equal((await f.call('GET', `/requests/${request.requestId}`)).id, request.requestId, 'the settled Chat request remains inspectable');
  const settled = await f.until(() => f.call('GET', `/tools?requestId=${request.requestId}`), value => value.calls[0]?.receivedByRequestId);
  const continuation = await f.call('GET', `/requests/${settled.calls[0].receivedByRequestId}`);
  const result = continuation.body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === tool.toolCallId);
  assert.ok(result); assert.equal(JSON.parse(result.content).executed, false, 'the model receives an explicit denial result, not an effect');
  const source = await f.call('GET', `/requests/${request.requestId}`);
  const studio = await f.call('POST', `/requests/${source.id}/send`, { body: source.body });
  await f.until(() => f.call('GET', `/requests/${studio.id}`), value => value.status === 'completed');
  const studioTools = await f.call('GET', `/tools?requestId=${studio.id}`);
  assert.equal(studioTools.calls[0].status, 'not_executed');
  await f.restart(); assert.equal((await f.call('GET', `/tools?requestId=${request.requestId}`)).calls[0].status, 'failed');
});

test('Work requests, real approval receipts, instructions, Trace and activity share persistent identities', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const task = await f.call('POST', '/v1/commands', { commandId: randomUUID(), type: 'create_task', parameters: { workspace: f.workspace, objective: 'Write work.txt', maxModelCalls: 10 } });
  const snapshot = await f.until(() => f.call('GET', `/v1/snapshot?taskId=${task.taskId}`), value => value.selectedTask.status === 'waiting_approval');
  const requests = await f.call('GET', `/requests?taskId=${task.taskId}`); assert.equal(requests.requests.length, 1);
  const actual = await f.call('GET', `/requests/${requests.requests[0].id}`); assert.deepEqual(actual.body, f.wire[0]); assert.ok(actual.runId);
  const intent = snapshot.intents[0];
  const waiting = await f.call('GET', `/metrics?taskId=${task.taskId}`); assert.equal(waiting.task.status, 'waiting_approval'); assert.equal(waiting.activeTools[0].status, 'awaiting_approval');
  await f.call('POST', '/v1/commands', { commandId: randomUUID(), type: 'grant', taskId: task.taskId, expectedRevision: snapshot.selectedTask.revision, parameters: { intentId: intent.id, digest: intent.digest, generation: intent.generation, policyEpoch: intent.policyEpoch } });
  await f.until(() => f.call('GET', `/v1/snapshot?taskId=${task.taskId}`), value => value.selectedTask.status === 'completed');
  const tools = await f.call('GET', `/tools?requestId=${actual.id}`);
  const finished = await f.call('GET', `/metrics?taskId=${task.taskId}`); assert.equal(finished.task.status, 'completed'); assert.equal(finished.toolsCompleted, 1); assert.equal(finished.activeTools.length, 0);
  assert.equal(tools.calls[0].status, 'completed'); assert.ok(tools.calls[0].receivedByRequestId); assert.ok(tools.calls[0].durationMs >= 0);
  const trace = await f.call('GET', `/trace?taskId=${task.taskId}`); assert.ok(trace.events.some((e: any) => e.type === 'effect.receipted' && e.requestId === actual.id));
  const activity = await f.call('GET', '/v1/activity?days=21'); assert.equal(activity.days.length, 21); assert.ok(activity.days.at(-1).toolEffects >= 1);
  // Bulk seed an owned history fixture; this test measures public paging, not 165 durable commits.
  const historyDb = new DatabaseSync(f.backend.services.kernel.dbPath);
  historyDb.exec('BEGIN IMMEDIATE');
  const insert = historyDb.prepare('INSERT INTO messages VALUES(?,?,?,?,?)');
  for (let i = 0; i < 165; i++) {
    const message = { id: randomUUID(), taskId: task.taskId, sessionId: 'main', role: 'user', content: `Retained history ${i}`, createdAt: new Date().toISOString() };
    insert.run(message.id, task.taskId, 'main', JSON.stringify(message), message.createdAt);
  }
  historyDb.exec('COMMIT'); historyDb.close();
  const compact = await f.call('GET', `/v1/snapshot?compact=true&taskId=${task.taskId}`);
  assert.equal(compact.messages.length, 160); assert.ok(compact.totalMessages > 165);
  const tail = await f.call('GET', `/v1/tasks/${task.taskId}/messages?limit=100`);
  const earlier = await f.call('GET', `/v1/tasks/${task.taskId}/messages?limit=100&before=${tail.nextCursor}`);
  assert.equal(new Set([...earlier.messages, ...tail.messages].map((m: any) => m.id)).size, compact.totalMessages);
  assert.ok((await f.call('GET', `/v1/recall?taskId=${task.taskId}&q=Retained`)).results.length > 0);
});

test('promoted Work preview uses the same profile, context, tools and prompt assembly as dispatch without charging a model call', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.backend.services.runner.stop();
  const profile = await f.call('POST', '/profiles', { name: 'Scoped mock', provider: { mode: 'mock', maxOutputTokens: 512, contextWindowTokens: 65536 } });
  const session = await f.call('POST', '/sessions', { workspace: f.workspace, profileId: profile.id, systemPrompt: 'INHERITED_WORK_PROMPT', parameters: { temperature: 0.23 } });
  const started = await f.call('POST', '/chat', { sessionId: session.id, content: 'Write preview.txt' });
  await f.until(() => f.call('GET', `/sessions/${session.id}`), value => !value.activeRequestId && value.messages.length === 2);
  assert.equal((await f.call('GET', `/requests/${started.requestId}`)).status, 'completed');
  const { taskId } = await f.call('POST', `/sessions/${session.id}/promote`, {});
  assert.equal((await f.call('GET', `/v1/product/sessions/${taskId}`)).modelId, profile.id, 'event-driven indexing must inherit the promoted profile before dispatch');
  const callsBefore = f.wire.length, budgetBefore = f.backend.services.kernel.getBudgets(taskId).modelCalls;
  const preview = await f.call('POST', '/preview', { taskId });
  const override = await f.call('POST', '/preview', { taskId, overrides: { systemPrompt: 'ONE_PREVIEW_ONLY' } });
  assert.equal(preview.profileId, profile.id);
  assert.ok(override.body.messages.some((message: any) => message.content === 'ONE_PREVIEW_ONLY'));
  assert.ok(!override.body.messages.some((message: any) => message.content === 'INHERITED_WORK_PROMPT'));
  assert.equal(f.wire.length, callsBefore); assert.equal(f.backend.services.kernel.getBudgets(taskId).modelCalls, budgetBefore);
  f.backend.services.runner.start();
  const actual = await f.until(async () => {
    const records = await f.call('GET', `/requests?taskId=${taskId}`);
    const record = records.requests.find((item: any) => item.kind === 'work');
    return record ? f.call('GET', `/requests/${record.id}`) : undefined;
  }, value => value?.status === 'completed');
  // Preview does not reserve a call; actual dispatch advances only the program budget snapshot.
  const projected = structuredClone(preview.body);
  const snapshotPrefix = 'Current saved goal and progress (program snapshot): ';
  const snapshotMessage = projected.messages.find((message: any) => message.content.startsWith(snapshotPrefix));
  const program = JSON.parse(snapshotMessage.content.slice(snapshotPrefix.length));
  assert.equal(program.budget.modelCalls, budgetBefore);
  program.budget.modelCalls++;
  snapshotMessage.content = snapshotPrefix + JSON.stringify(program);
  assert.deepEqual(projected, actual.body);
  assert.deepEqual(actual.body, f.wire.at(-1));
  assert.equal(actual.body.max_tokens, 512); assert.equal(actual.body.temperature, 0.23);
  assert.match(JSON.stringify(actual.body), /Read-only origin Chat snapshot/);
  assert.ok(actual.sources.some((source: any) => source.content === 'INHERITED_WORK_PROMPT' && source.effective));
});

test('disabled trace details omit tool arguments while a denied Chat proposal stays denied across restart', { timeout: 30000 }, async t => {
  const marker = 'TRACE_PRIVATE_ARGUMENT';
  const f = await fixture(t, { responder: body => body.messages.some((message: any) => message.role === 'tool')
    ? { content: 'Observed the real receipt.' }
    : { content: '', toolCalls: [{ id: 'private-write', name: 'write_file', arguments: { path: 'private.txt', content: marker } }] } });
  await f.call('POST', '/settings', { recordContent: false });
  const session = await f.call('POST', '/sessions', { workspace: f.workspace, capabilities: { tools: true } });
  const started = await f.call('POST', '/chat', { sessionId: session.id, content: 'Propose a file write' });
  const denied = await f.until(() => f.call('GET', `/tools?requestId=${started.requestId}`), value => value.calls.some((tool: any) => tool.name === 'write_file' && tool.failureStage === 'permission'));
  const tool = denied.calls.find((item: any) => item.name === 'write_file');
  assert.equal(tool.status, 'failed'); assert.equal(tool.intentId, undefined);
  assert.ok(!JSON.stringify(await f.call('GET', `/trace?sessionId=${session.id}`)).includes(marker));
  await f.restart();
  const restored = await f.call('GET', `/tools?requestId=${started.requestId}`);
  const kept = restored.calls.find((item: any) => item.id === tool.id);
  assert.equal(kept.status, 'failed'); assert.equal(kept.failureStage, 'permission');
  assert.equal(kept.arguments.content, marker, 'the durable tool record keeps the exact arguments');
  assert.equal(existsSync(path.join(f.workspace, 'private.txt')), false, 'restart never replays a denied Chat proposal');
});

test('disabled snapshots omit request/response content, redact secrets and preserve kernel authority', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.call('POST', '/profiles', { id: 'default', mode: 'mock', apiKey: 'fixture-secret-DO-NOT-LOG', name: 'Local' });
  const session = await f.call('POST', '/sessions', { title: 'fixture-secret-DO-NOT-LOG' });
  assert.ok(!JSON.stringify(session).includes('fixture-secret-DO-NOT-LOG'));
  await f.call('POST', '/settings', { recordContent: false });
  const started = await f.call('POST', '/chat', { sessionId: session.id, content: 'Sensitive conversation' });
  const record = await f.until(() => f.call('GET', `/requests/${started.requestId}`), value => value.status === 'completed');
  assert.equal(record.body, undefined); assert.equal(record.response, undefined); assert.equal(record.draft, ''); assert.deepEqual(record.sources, []);
  const trace = await f.call('GET', `/trace?sessionId=${session.id}`); assert.ok(!JSON.stringify(trace).includes('Sensitive conversation'));
  assert.equal((await f.call('GET', `/sessions/${session.id}`)).messages[0].content, 'Sensitive conversation', 'Chat history remains distinct from optional request snapshots');
  await f.call('POST', `/requests/${record.id}/send`, {}, 400);
});
