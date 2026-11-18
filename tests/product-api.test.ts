import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';

const root = path.resolve(process.env.TEMP ?? '.tmp');
const until = async <T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs = 30000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected state.');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
};

type Responder = (body: any) => { content: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] };

const setup = async (responder?: Responder, wire?: any[]) => {
  const dir = mkdtempSync(path.join(root, 'api-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const settings = { dataDir: path.join(dir, 'data'), projectRoot: process.cwd(),
    mockOptions: { ...(responder ? { responder } : {}), ...(wire ? { trace: (body: any) => wire.push(body) } : {}) } };
  let backend = await startBackend(settings);
  const request = async (method: string, route: string, input?: unknown) => {
    const response = await fetch('http://127.0.0.1:' + backend.port + route, { method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const restart = async () => { await backend.close(); backend = await startBackend(settings); };
  const close = async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); };
  return { backend, dir, workspace, settings, request, restart, close };
};
type Env = Awaited<ReturnType<typeof setup>>;

const sendChat = (env: Env, text: string, extra: Record<string, unknown> = {}) =>
  env.request('POST', '/v1/product/chat/send', { mode: 'chat', text, attachments: [], permission: 'ask', modelId: 'default', ...extra });
const waitIdle = (env: Env, sessionId: string) => until(async () => {
  const value = await env.request('GET', '/v1/product/sessions/' + sessionId);
  return value.status === 200 && ['idle', 'completed', 'failed', 'cancelled'].includes(value.body.status) ? value : undefined;
});

test('product HTTP sessions expose real Chat data, bounded events and metrics', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const anonymous = await fetch('http://127.0.0.1:' + env.backend.port + '/v1/product/sessions');
  assert.equal(anonymous.status, 401);

  const empty = await env.request('GET', '/v1/product/sessions');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.items, []);

  const sent = await sendChat(env, 'HTTP hello product');
  assert.equal(sent.status, 200);
  assert.ok(sent.body.sessionId);
  assert.ok(sent.body.messageId);
  const settled = await waitIdle(env, sent.body.sessionId);
  assert.equal(settled.body.messages.length, 2);
  assert.equal(settled.body.messages[0].role, 'user');
  assert.equal(settled.body.messages[1].role, 'assistant');
  assert.equal(settled.body.hasMoreBefore, false);

  const assistantMessage = settled.body.messages[1];
  const assistantEvents = await env.request('GET', '/v1/product/events?cursor=0&limit=100');
  // Streaming projection: the same assistant id is reported repeatedly (streaming partials, then one done),
  // so the settled view must be the last event for that id rather than the only one.
  const upserts = assistantEvents.body.events.filter((entry: any) => entry.event.type === 'message.upsert' && entry.event.message.id === assistantMessage.id);
  assert.ok(upserts.length > 0, 'message.upsert must carry the accumulated assistant message');
  assert.deepEqual(upserts[upserts.length - 1].event.message, assistantMessage, 'the last projection for one id must be the settled assistant message');

  const unknownField = await env.request('POST', '/v1/product/chat/send', { mode: 'chat', text: 'x', attachments: [], permission: 'ask', modelId: 'default', surprise: true });
  assert.equal(unknownField.status, 400);
  assert.equal(unknownField.body.code, 'validation');

  const missing = await env.request('GET', '/v1/product/sessions/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'not_found');

  const updated = await env.request('POST', '/v1/product/sessions/' + sent.body.sessionId + '/update', { title: 'Renamed over HTTP', pinned: true });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.title, 'Renamed over HTTP');
  assert.equal(updated.body.pinned, true);
  const listed = await env.request('GET', '/v1/product/sessions?text=Renamed');
  assert.equal(listed.body.items.length, 1);
  assert.equal(listed.body.items[0].id, sent.body.sessionId);

  const events = await env.request('GET', '/v1/product/events?cursor=0&limit=50');
  assert.equal(events.status, 200);
  assert.ok(events.body.events.length > 0);
  assert.ok(typeof events.body.nextCursor === 'string' || typeof events.body.nextCursor === 'number');
  for (const entry of events.body.events) assert.ok(entry.event && typeof entry.event.type === 'string' && typeof entry.id === 'number');
  assert.ok(events.body.events.some((entry: any) => entry.event.type === 'message.upsert' && entry.event.message.id === sent.body.messageId));

  const tooMany = await env.request('GET', '/v1/product/events?cursor=0&limit=1000');
  assert.equal(tooMany.status, 400);
  const badCursor = await env.request('GET', '/v1/product/events?cursor=abc');
  assert.equal(badCursor.status, 400);
  const hugeCursor = await env.request('GET', '/v1/product/events?cursor=99999999999999999999');
  assert.equal(hugeCursor.status, 400);
  const badLimit = await env.request('GET', '/v1/product/sessions?limit=0');
  assert.equal(badLimit.status, 400);

  const metrics = await env.request('GET', '/v1/product/metrics/session?sessionId=' + sent.body.sessionId);
  assert.equal(metrics.status, 200);
  assert.equal(metrics.body.rounds, 1);
  assert.equal(typeof metrics.body.tokens.input, 'number');
  assert.ok(metrics.body.usageCoverage && typeof metrics.body.usageCoverage === 'object', 'HTTP metrics expose per-field coverage');
  assert.equal(metrics.body.usageCoverage.requests, 1);
  assert.equal(metrics.body.usageCoverage.input.totalRequests, 1);
  assert.ok(['known', 'partial', 'unknown'].includes(metrics.body.usageCoverage.input.state));
  assert.ok(metrics.body.usageCoverage.cacheRatio && ['known', 'partial', 'unknown'].includes(metrics.body.usageCoverage.cacheRatio.state), 'the cache ratio has its own matched-row coverage');
  const activity = await env.request('GET', '/v1/product/metrics/activity?days=7');
  assert.equal(activity.status, 200);
  assert.equal(activity.body.length, 7);
  const connection = await env.request('GET', '/v1/product/connection');
  assert.equal(connection.status, 200);
  assert.equal(connection.body.status, 'online');
  assert.equal(connection.body.demo, false);

  const removed = await env.request('POST', '/v1/product/sessions/' + sent.body.sessionId + '/remove');
  assert.equal(removed.status, 200);
  assert.equal((await env.request('GET', '/v1/product/sessions/' + sent.body.sessionId)).status, 404);
  assert.equal((await env.request('GET', '/v1/product/sessions')).body.items.length, 0);
  assert.equal((await env.request('GET', '/v1/product/unknown-route')).status, 404);
});

test('work approvals, task control and stale decisions use the native intent fence', { timeout: 120000 }, async t => {
  const responder: Responder = body => body.messages.some((message: any) => message.role === 'tool')
    ? { content: 'The approval file was written.' }
    : { content: '', toolCalls: [{ id: 'write-1', name: 'write_file', arguments: { path: 'approval.txt', content: 'approved over http' } }] };
  const env = await setup(responder);
  t.after(() => env.close());
  const project = await env.request('POST', '/v1/product/workspace/projects', { path: env.workspace });
  assert.equal(project.status, 200, JSON.stringify(project.body));
  const sent = await env.request('POST', '/v1/product/chat/send', { mode: 'cowork', text: 'Write the approval file', attachments: [], permission: 'ask', modelId: 'default', projectId: project.body.id });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const sessionId = sent.body.sessionId, taskId = sessionId;
  const approval = await until(async () => {
    const value = await env.request('GET', '/v1/product/approvals?sessionId=' + taskId);
    return value.status === 200 && value.body.length ? value.body[0] : undefined;
  });
  assert.equal(approval.sessionId, taskId);
  assert.equal(approval.toolCallId, 'write-1');
  assert.equal(approval.capability, 'write');
  assert.equal(approval.risk, 'high');
  assert.ok(approval.digest.length > 0);
  assert.ok(typeof approval.preview === 'string' && approval.preview.length > 0);
  assert.ok(['command', 'diff', 'json', 'text'].includes(approval.previewKind));
  assert.equal(approval.title.length > 0, true);

  const detail = await env.request('GET', '/v1/product/tasks/' + taskId);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.id, taskId);
  assert.equal(detail.body.status, 'waiting_approval');
  assert.ok(Array.isArray(detail.body.plan) && detail.body.plan.length > 0);
  assert.ok(detail.body.goal.objective.includes('approval file'));

  const checkpoint = await env.request('POST', '/v1/product/tasks/' + taskId + '/control', { action: 'checkpoint' });
  assert.equal(checkpoint.status, 200);
  assert.ok(checkpoint.body.checkpoints.length >= 1);
  const invalidControl = await env.request('POST', '/v1/product/tasks/' + taskId + '/control', { action: 'explode' });
  assert.equal(invalidControl.status, 400);
  const unknownTask = await env.request('GET', '/v1/product/tasks/not-a-task');
  assert.equal(unknownTask.status, 200);
  assert.equal(unknownTask.body, null);

  const decided = await env.request('POST', '/v1/product/approvals/decide', { approvalId: approval.id, approved: true, scope: 'once' });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.resolved, true);
  const settled = await until(async () => {
    const value = await env.request('GET', '/v1/product/tasks/' + taskId);
    return value.status === 200 && ['completed', 'failed', 'waiting_approval', 'waiting_input'].includes(value.body.status) && value.body.status !== 'waiting_approval' ? value : undefined;
  });
  assert.ok(['completed', 'waiting_input'].includes(settled.body.status), settled.body.status);
  assert.equal(readFileSync(path.join(env.workspace, 'approval.txt'), 'utf8'), 'approved over http');
  const stale = await env.request('POST', '/v1/product/approvals/decide', { approvalId: approval.id, approved: true, scope: 'once' });
  assert.equal(stale.status, 409);
  const pending = await env.request('GET', '/v1/product/approvals?sessionId=' + taskId);
  assert.deepEqual(pending.body, []);
  const resolvedEvents = await env.request('GET', '/v1/product/events?cursor=0&limit=200&sessionId=' + taskId);
  assert.ok(resolvedEvents.body.events.some((entry: any) => entry.event.type === 'approval.requested'));
  assert.ok(resolvedEvents.body.events.some((entry: any) => entry.event.type === 'approval.resolved'));
  assert.ok(existsSync(path.join(env.workspace, 'approval.txt')));

  // Removing a Work session hides the product row but keeps the Kernel audit accessible by native id.
  const removal = await env.request('POST', '/v1/product/sessions/' + taskId + '/remove');
  assert.equal(removal.status, 200, JSON.stringify(removal.body));
  assert.equal((await env.request('GET', '/v1/product/sessions/' + taskId)).status, 404);
  const audit = await env.request('GET', '/v1/product/tasks/' + taskId);
  assert.equal(audit.status, 200);
  assert.equal(audit.body.id, taskId);
  await env.request('GET', '/v1/product/events?cursor=0&limit=200');
  const remaining = await env.request('GET', '/v1/product/sessions?limit=100');
  assert.equal(remaining.body.items.some((item: any) => item.id === taskId), false);
});

test('side ask stays transient and project removal detaches sessions and revokes access', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const added = await env.request('POST', '/v1/product/workspace/projects', { path: env.workspace });
  assert.equal(added.status, 200);
  const projectId = added.body.id;
  assert.equal(added.body.path.toLowerCase(), env.workspace.toLowerCase());
  const projects = await env.request('GET', '/v1/product/workspace/projects');
  assert.equal(projects.status, 200);
  assert.equal(projects.body.length, 1);

  const sent = await sendChat(env, 'Project conversation', { projectId });
  assert.equal(sent.status, 200);
  await waitIdle(env, sent.body.sessionId);
  const detail = await env.request('GET', '/v1/product/sessions/' + sent.body.sessionId);
  assert.equal(detail.body.projectId, projectId);

  const before = await env.request('GET', '/v1/product/sessions');
  const side = await env.request('POST', '/v1/product/chat/side-ask', { question: 'Summarize the transient question.', attachments: [], history: [], modelId: 'default' });
  assert.equal(side.status, 200);
  assert.ok(typeof side.body.answer === 'string' && side.body.answer.length > 0);
  const after = await env.request('GET', '/v1/product/sessions');
  assert.equal(after.body.items.length, before.body.items.length);
  assert.equal((await env.request('GET', '/v1/product/chat/side-ask')).status, 404);

  const write = await env.request('POST', '/v1/product/workspace/file', { projectId, path: 'note.txt', content: 'hello product workspace' });
  assert.equal(write.status, 200);
  const read = await env.request('GET', '/v1/product/workspace/file?projectId=' + projectId + '&path=note.txt');
  assert.equal(read.status, 200);
  assert.equal(read.body, 'hello product workspace');
  const search = await env.request('GET', '/v1/product/workspace/search?projectId=' + projectId + '&text=product%20workspace');
  assert.equal(search.status, 200);
  assert.equal(search.body.length, 1);
  assert.equal(search.body[0].path, 'note.txt');
  const outside = await env.request('GET', '/v1/product/workspace/file?projectId=' + projectId + '&path=../escape.txt');
  assert.equal(outside.status, 400);
  const sc = await env.request('GET', '/v1/product/workspace/source-control?projectId=' + projectId);
  assert.equal(sc.status, 501);

  const removed = await env.request('POST', '/v1/product/workspace/projects/' + projectId + '/remove');
  assert.equal(removed.status, 200);
  assert.deepEqual((await env.request('GET', '/v1/product/workspace/projects')).body, []);
  const detached = await env.request('GET', '/v1/product/sessions/' + sent.body.sessionId);
  assert.equal(detached.body.projectId, undefined);
  const revoked = await env.request('POST', '/v1/product/workspace/file', { projectId, path: 'note.txt', content: 'again' });
  assert.equal(revoked.status, 404);
  assert.equal(readFileSync(path.join(env.workspace, 'note.txt'), 'utf8'), 'hello product workspace');
});

test('branch, promote and model HTTP routes map to the frontend contract', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const project = await env.request('POST', '/v1/product/workspace/projects', { path: env.workspace });
  assert.equal(project.status, 200, JSON.stringify(project.body));
  const sent = await sendChat(env, 'Branch and promote this conversation', { projectId: project.body.id });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const original = await waitIdle(env, sent.body.sessionId);
  const userMessage = original.body.messages.find((message: any) => message.role === 'user');
  assert.ok(userMessage);

  const branch = await env.request('POST', '/v1/product/sessions/' + sent.body.sessionId + '/branch', { messageId: userMessage.id });
  assert.equal(branch.status, 200, JSON.stringify(branch.body));
  assert.notEqual(branch.body.id, sent.body.sessionId);
  assert.equal(branch.body.parentSessionId, sent.body.sessionId);
  assert.equal(branch.body.mode, 'chat');
  const branchDetail = await env.request('GET', '/v1/product/sessions/' + branch.body.id);
  assert.equal(branchDetail.status, 200);
  assert.equal(branchDetail.body.messages.length, 1);
  assert.equal(branchDetail.body.messages[0].parts[0].text, 'Branch and promote this conversation');

  const promoted = await env.request('POST', '/v1/product/sessions/' + sent.body.sessionId + '/promote', { objective: 'Continue the conversation as Work', acceptance: ['contains:promoted.txt:Work'] });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.equal(promoted.body.parentSessionId, sent.body.sessionId);
  const task = await env.request('GET', '/v1/product/tasks/' + promoted.body.id);
  assert.equal(task.status, 200);
  assert.equal(task.body.id, promoted.body.id);
  assert.equal(task.body.goal.objective, 'Continue the conversation as Work');

  const models = await env.request('GET', '/v1/product/models');
  assert.equal(models.status, 200);
  assert.ok(models.body.some((model: any) => model.id === 'default'));
  const saved = await env.request('POST', '/v1/product/models/save', {
    name: 'HTTP mock profile', provider: 'HTTP mock', model: 'deepseek/deepseek-v4.1-flash', mode: 'mock',
    maxOutputTokens: 1024, supportsReasoning: true, reasoningLevels: ['low', 'high'], reasoningMapping: { temperature: 0.2 },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(saved.body.id.startsWith('provider-'));
  assert.equal(saved.body.mode, 'mock');
  assert.equal(saved.body.credentialPresent, false);
  assert.deepEqual(saved.body.reasoningLevels, ['low', 'high']);
  const afterSave = await env.request('GET', '/v1/product/models');
  assert.ok(afterSave.body.some((model: any) => model.id === saved.body.id));
  const badModel = await env.request('POST', '/v1/product/models/save', { name: 'Bad', provider: 'Bad', model: 'x', mode: 'mock', baseUrl: 'http://injected' });
  assert.equal(badModel.status, 400);
  const tested = await env.request('POST', '/v1/product/models/' + saved.body.id + '/test');
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.ok, true);
  const defaultRemove = await env.request('POST', '/v1/product/models/default/remove');
  assert.equal(defaultRemove.status, 409);
  const removed = await env.request('POST', '/v1/product/models/' + saved.body.id + '/remove');
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.ok(!(await env.request('GET', '/v1/product/models')).body.some((model: any) => model.id === saved.body.id));
});

test('selected model profile and reasoning mapping reach the real mock request and Inspector body', { timeout: 120000 }, async t => {
  const wire: any[] = [];
  const env = await setup(undefined, wire);
  t.after(() => env.close());
  const saved = await env.request('POST', '/v1/product/models/save', {
    name: 'Reasoning HTTP profile', provider: 'Reasoning Lab', model: 'deepseek/deepseek-v4.1-flash', mode: 'mock',
    supportsReasoning: true, reasoningLevels: ['low', 'high'],
    reasoningMapping: { temperature: 0.3, top_p: 0.9, reasoning_effort: '{{level}}' },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const sent = await env.request('POST', '/v1/product/chat/send', {
    mode: 'chat', text: 'Reasoning body over HTTP', attachments: [], permission: 'ask',
    modelId: saved.body.id, reasoningEffort: 'high',
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const settled = await waitIdle(env, sent.body.sessionId);
  const assistant = settled.body.messages.find((message: any) => message.role === 'assistant');
  assert.ok(assistant?.requestId);
  const sentBody = wire.find(body => Array.isArray(body.messages) && body.messages.some((message: any) => message.role === 'user' && message.content === 'Reasoning body over HTTP'));
  assert.ok(sentBody, 'the mock provider must receive the chat request');
  assert.equal(sentBody.model, 'deepseek/deepseek-v4.1-flash');
  assert.equal(sentBody.temperature, 0.3);
  assert.equal(sentBody.top_p, 0.9);
  assert.equal(sentBody.reasoning_effort, 'high');
  assert.ok(Array.isArray(sentBody.messages) && sentBody.messages.length > 0);

  const inspector = await env.request('GET', '/v1/harness/requests/' + assistant.requestId);
  assert.equal(inspector.status, 200);
  const recorded = inspector.body.request ?? inspector.body;
  assert.equal(recorded.body.temperature, 0.3);
  assert.equal(recorded.body.top_p, 0.9);
  assert.equal(recorded.body.reasoning_effort, 'high');
  assert.equal(recorded.body.model, 'deepseek/deepseek-v4.1-flash');

  const project = await env.request('POST', '/v1/product/workspace/projects', { path: env.workspace });
  assert.equal(project.status, 200, JSON.stringify(project.body));
  const work = await env.request('POST', '/v1/product/chat/send', {
    mode: 'cowork', text: 'Work reasoning selection probe', attachments: [], permission: 'ask',
    modelId: saved.body.id, reasoningEffort: 'high', projectId: project.body.id,
  });
  assert.equal(work.status, 200, JSON.stringify(work.body));
  const workBody = await until(() => wire.find(body => Array.isArray(body.messages)
    && body.messages.some((message: any) => message.role === 'user' && String(message.content).includes('Work reasoning selection probe'))));
  assert.equal(workBody.model, 'deepseek/deepseek-v4.1-flash');
  assert.equal(workBody.temperature, 0.3);
  assert.equal(workBody.reasoning_effort, 'high');

  const updated = await env.request('POST', '/v1/product/sessions/' + sent.body.sessionId + '/update', { modelId: saved.body.id, reasoningEffort: 'low' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.modelId, saved.body.id);
  assert.equal(updated.body.reasoningEffort, 'low');
});

test('paged sessions and event cursors survive a backend restart', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const first = await sendChat(env, 'First restart conversation');
  await waitIdle(env, first.body.sessionId);
  const second = await sendChat(env, 'Second restart conversation');
  await waitIdle(env, second.body.sessionId);
  const page = await env.request('GET', '/v1/product/sessions?limit=1');
  assert.equal(page.status, 200);
  assert.equal(page.body.items.length, 1);
  assert.ok(page.body.nextCursor);
  const events = await env.request('GET', '/v1/product/events?cursor=0&limit=20');
  assert.ok(events.body.events.length > 0);
  await env.restart();
  const resumed = await env.request('GET', '/v1/product/sessions?limit=1&cursor=' + encodeURIComponent(page.body.nextCursor));
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.items.length, 1);
  assert.notEqual(resumed.body.items[0].id, page.body.items[0].id);
  const loaded = await env.request('GET', '/v1/product/sessions/' + first.body.sessionId);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.messages.length, 2);
  const resumedEvents = await env.request('GET', '/v1/product/events?cursor=' + events.body.nextCursor + '&limit=20');
  assert.equal(resumedEvents.status, 200);
  assert.equal(resumedEvents.body.reset, false);
});
