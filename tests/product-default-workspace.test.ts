import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import type { MockCompletion } from '../src/fixtures/mock-provider.js';

/**
 * Default (no project selected) Work and Chat promotion must use the Kernel's per-task workspace
 * data/workspaces/<taskId>. The installation root contains the running product and its data, so it
 * is never a mutable task workspace and must never be forwarded as an implicit workspace.
 */
const PROJECT_ROOT = process.cwd();
const root = path.resolve('.tmp', 'product-default-workspace');
const RUNNING = new Set(['queued', 'running', 'reconciling', 'waiting_children']);
const REVIEWER_PASS = '{"verdict":"pass","reason":"default workspace fixture","findings":[]}';

const json = (value: unknown): string => JSON.stringify(value);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const systemText = (body: any): string => (Array.isArray(body?.messages) ? body.messages : [])
  .filter((message: any) => message?.role === 'system' && typeof message.content === 'string')
  .map((message: any) => message.content as string).join('\n');
const isReviewerCall = (body: any): boolean => systemText(body).includes('REVIEWER ROLE');
const mainAnswer = (content: string) => (body: any): MockCompletion => isReviewerCall(body)
  ? { content: REVIEWER_PASS } : { content };

const until = async <T>(read: () => Promise<T | undefined> | T | undefined, label: string, timeoutMs = 40000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail('Timed out waiting for ' + label);
    await sleep(25);
  }
};

const setup = async (responder: (body: any) => MockCompletion = mainAnswer('Default workspace answer.')) => {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'case-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const dataDir = path.join(dir, 'data');
  const settings = { dataDir, projectRoot: PROJECT_ROOT, mockOptions: { responder } };
  let backend = await startBackend(settings);
  const requestRaw = async (method: string, route: string, input?: unknown) => {
    const response = await fetch('http://127.0.0.1:' + backend.port + route, { method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const request = (method: string, route: string, input?: unknown) => requestRaw(method, '/v1/product' + route, input);
  const restart = async () => { await backend.close(); backend = await startBackend(settings); };
  const close = async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); };
  return {
    dir, workspace, dataDir, settings, request, requestRaw, restart, close,
    kernel: () => backend.services.kernel,
    harness: () => { const harness = backend.services.harness; assert.ok(harness); return harness; },
  };
};
type Env = Awaited<ReturnType<typeof setup>>;

const sendCowork = (env: Env, text: string, extra: Record<string, unknown> = {}) =>
  env.request('POST', '/chat/send', { mode: 'cowork', text, attachments: [], permission: 'ask', modelId: 'default', ...extra });
const sendChatHttp = (env: Env, text: string, extra: Record<string, unknown> = {}) =>
  env.request('POST', '/chat/send', { mode: 'chat', text, attachments: [], permission: 'ask', modelId: 'default', ...extra });
const waitChatIdle = (env: Env, sessionId: string) => until(async () => {
  const result = await env.request('GET', '/sessions/' + encodeURIComponent(sessionId));
  return result.status === 200 && result.body.status === 'idle' ? result.body : undefined;
}, 'the Chat session to settle');
const workRequests = (env: Env, taskId: string) =>
  env.harness().store.listRequests({ taskId, limit: 100 }).requests.filter(record => record.kind === 'work');
const settleWork = async (env: Env, taskId: string, expectedRequests: number, expectedAssistants = expectedRequests) => until(() => {
  const task = env.kernel().getTask(taskId);
  assert.ok(task, 'the Work task must exist');
  if (['failed', 'cancelled'].includes(task.status)) assert.fail('the Work task settled as ' + task.status + ': ' + String(task.error ?? ''));
  const requests = workRequests(env, taskId).length;
  const assistants = env.kernel().getMessages(taskId).filter(message => message.role === 'assistant' && !message.toolCalls?.length).length;
  return !RUNNING.has(task.status) && requests >= expectedRequests && assistants >= expectedAssistants ? task : undefined;
}, 'the Work task to settle');
const assertTaskWorkspace = (workspace: string, taskId: string, dataDir: string): void => {
  assert.equal(path.resolve(workspace), path.resolve(path.join(dataDir, 'workspaces', taskId)));
  assert.ok(existsSync(workspace), 'the task workspace directory must exist: ' + workspace);
  assert.notEqual(path.resolve(workspace), path.resolve(PROJECT_ROOT), 'the installation root must never be a task workspace');
  assert.notEqual(path.resolve(workspace), path.resolve(dataDir), 'the data directory itself must never be a task workspace');
};

test('default Cowork creates one task-specific Kernel workspace per task, not the installation root', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const dataBefore = new Set(readdirSync(env.dataDir));

  const first = await sendCowork(env, 'First default Cowork task');
  assert.equal(first.status, 200, json(first.body));
  const firstTaskId = first.body.sessionId as string;
  assertTaskWorkspace(env.kernel().getTask(firstTaskId)!.workspace, firstTaskId, env.dataDir);
  await settleWork(env, firstTaskId, 1);

  const second = await sendCowork(env, 'Second default Cowork task');
  assert.equal(second.status, 200, json(second.body));
  const secondTaskId = second.body.sessionId as string;
  const secondTask = env.kernel().getTask(secondTaskId)!;
  assertTaskWorkspace(secondTask.workspace, secondTaskId, env.dataDir);
  assert.notEqual(path.resolve(secondTask.workspace), path.resolve(env.kernel().getTask(firstTaskId)!.workspace), 'two default tasks must get different workspaces');
  await settleWork(env, secondTaskId, 1);

  // Task effects stay in workspaces; independent verification may archive its own JSONL evidence.
  const added = readdirSync(env.dataDir).filter(name => !dataBefore.has(name));
  assert.deepEqual(added.sort(), ['artifacts', 'workspaces']);
  const artifactRoot = path.join(env.dataDir, 'artifacts');
  assert.deepEqual(readdirSync(artifactRoot), ['verification'], 'the fixture must create only independent verification evidence outside task workspaces');
  const evidence = readdirSync(path.join(artifactRoot, 'verification'));
  assert.ok(evidence.length >= 2);
  assert.ok(evidence.every(name => /^[a-f0-9-]+\.jsonl$/.test(name)), 'verification files must have generated identities');
  for (const name of dataBefore) assert.ok(existsSync(path.join(env.dataDir, name)), 'existing data entry disappeared: ' + name);
  assert.equal(existsSync(path.join(env.dataDir, 'default-task.txt')), false);

  const detail = await env.request('GET', '/sessions/' + encodeURIComponent(firstTaskId));
  assert.equal(detail.status, 200, json(detail.body));
  assert.equal(detail.body.projectId, undefined, 'a default task must not claim a project it was not given');
});

test('default Cowork tool effects are written inside its task workspace only', { timeout: 120000 }, async t => {
  const env = await setup(body => {
    if (isReviewerCall(body)) return { content: REVIEWER_PASS };
    // The follow-up round is the one that already carries a tool result; only the first round proposes the write.
    if (Array.isArray(body.messages) && body.messages.some((message: any) => message.role === 'tool')) return { content: 'Wrote the requested file.' };
    return { content: '', toolCalls: [{ id: 'write-default-1', name: 'write_file', arguments: { path: 'default-task.txt', content: 'inside the task workspace\n' } }] };
  });
  t.after(() => env.close());

  const sent = await sendCowork(env, 'Write default-task.txt in the task workspace');
  assert.equal(sent.status, 200, json(sent.body));
  const taskId = sent.body.sessionId as string;
  const task = env.kernel().getTask(taskId)!;
  assertTaskWorkspace(task.workspace, taskId, env.dataDir);
  const file = path.join(task.workspace, 'default-task.txt');

  const approval = await until(async () => {
    const pending = await env.request('GET', '/approvals?sessionId=' + encodeURIComponent(taskId));
    const list = Array.isArray(pending.body) ? pending.body : [];
    return list.length ? list[0] : undefined;
  }, 'the default task write approval');
  assert.equal(approval.capability, 'write');
  assert.equal(existsSync(file), false, 'no file may exist before the operator approves the write');
  assert.equal(existsSync(path.join(env.dataDir, 'default-task.txt')), false);

  const decided = await env.request('POST', '/approvals/decide', { approvalId: approval.id, approved: true, scope: 'once' });
  assert.equal(decided.status, 200, json(decided.body));
  // The first assistant message carries the tool call; only the follow-up answer is a plain assistant turn.
  await settleWork(env, taskId, 2, 1);

  assert.equal(readFileSync(file, 'utf8'), 'inside the task workspace\n');
  assert.equal(existsSync(path.join(env.dataDir, 'default-task.txt')), false, 'a task write must never land in the data directory');
  assert.ok(readdirSync(task.workspace).includes('default-task.txt'));
  assert.equal(env.kernel().getTask(taskId)!.workspace, task.workspace, 'the task workspace must stay stable across its rounds');
  assert.ok(env.kernel().getMessages(taskId).some(message => message.role === 'tool' && message.toolCallId === 'write-default-1'));
});

test('a default Cowork task survives restart and keeps its workspace for follow-ups', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const sent = await sendCowork(env, 'Default task before restart');
  assert.equal(sent.status, 200, json(sent.body));
  const taskId = sent.body.sessionId as string;
  const workspace = env.kernel().getTask(taskId)!.workspace;
  assertTaskWorkspace(workspace, taskId, env.dataDir);
  await settleWork(env, taskId, 1);

  await env.restart();
  const restored = env.kernel().getTask(taskId);
  assert.ok(restored, 'the default task must survive a backend restart');
  assert.equal(restored!.workspace, workspace, 'restart must preserve the task-specific workspace');
  assert.ok(existsSync(workspace));
  const detail = await env.request('GET', '/sessions/' + encodeURIComponent(taskId));
  assert.equal(detail.status, 200, json(detail.body));

  const followUp = await env.request('POST', '/chat/send', { sessionId: taskId, mode: 'cowork', text: 'Continue the default task', attachments: [], permission: 'ask', modelId: 'default' });
  assert.equal(followUp.status, 200, json(followUp.body));
  await settleWork(env, taskId, 2);
  assert.equal(env.kernel().getTask(taskId)!.workspace, workspace, 'a follow-up must inherit the existing task workspace');
});

test('an unknown project id is rejected instead of silently falling back to the root', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const missing = await sendCowork(env, 'Unknown project task', { projectId: 'project-does-not-exist' });
  assert.equal(missing.status, 400, json(missing.body));
  assert.equal(missing.body.code, 'validation');
  assert.match(missing.body.error, /project/i, 'the error must name the project selection problem');
  assert.doesNotMatch(missing.body.error, /audit, approval and task data/, 'an unknown project must not be reported as an implicit-root collision');

  const missingChat = await sendChatHttp(env, 'Unknown project chat', { projectId: 'project-does-not-exist' });
  assert.equal(missingChat.status, 400, json(missingChat.body));
  assert.equal(missingChat.body.code, 'validation');

  const sessions = await env.request('GET', '/sessions?mode=cowork&limit=20');
  assert.equal(sessions.status, 200);
  assert.deepEqual(sessions.body.items, [], 'a rejected default task must not create a session row');

  // The safety boundary itself is unchanged: these roots are still refused as projects.
  for (const candidate of [PROJECT_ROOT, env.dataDir, path.join(PROJECT_ROOT, 'src'), path.join(PROJECT_ROOT, 'node_modules')]) {
    const rejected = await env.request('POST', '/workspace/projects', { path: candidate });
    assert.equal(rejected.status, 400, 'project registration must reject ' + candidate + ': ' + json(rejected.body));
    assert.equal(rejected.body.code, 'validation');
  }
});

test('an explicitly selected project is still the task workspace', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const project = await env.request('POST', '/workspace/projects', { path: env.workspace });
  assert.equal(project.status, 200, json(project.body));
  const projectId = project.body.id as string;

  const sent = await sendCowork(env, 'Project-scoped Cowork task', { projectId });
  assert.equal(sent.status, 200, json(sent.body));
  const taskId = sent.body.sessionId as string;
  const task = env.kernel().getTask(taskId)!;
  assert.equal(path.resolve(task.workspace).toLowerCase(), realpathSync(env.workspace).toLowerCase(), 'an explicit project must stay the task workspace');
  await settleWork(env, taskId, 1);

  const detail = await env.request('GET', '/sessions/' + encodeURIComponent(taskId));
  assert.equal(detail.body.projectId, projectId, 'the selected project association must be preserved');

  const followUp = await env.request('POST', '/chat/send', { sessionId: taskId, mode: 'cowork', text: 'Continue in the same project', attachments: [], permission: 'ask', modelId: 'default', projectId });
  assert.equal(followUp.status, 200, json(followUp.body));
  await settleWork(env, taskId, 2);
  assert.equal(path.resolve(env.kernel().getTask(taskId)!.workspace).toLowerCase(), realpathSync(env.workspace).toLowerCase());
});

test('default Chat promotion uses a task workspace; a project chosen later stays authoritative', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());

  const chat = await sendChatHttp(env, 'Discuss promoting this default conversation');
  assert.equal(chat.status, 200, json(chat.body));
  const chatId = chat.body.sessionId as string;
  const settledChat = await waitChatIdle(env, chatId);
  assert.equal(settledChat.messages.length, 2);

  const promoted = await env.request('POST', '/sessions/' + encodeURIComponent(chatId) + '/promote', { objective: 'Ship the default promotion', acceptance: [] });
  assert.equal(promoted.status, 200, json(promoted.body));
  const taskId = promoted.body.id as string;
  assert.equal(promoted.body.parentSessionId, chatId);
  assert.equal(promoted.body.permission, 'read-only', 'promotion must inherit the Chat read-only origin');
  const task = env.kernel().getTask(taskId)!;
  assertTaskWorkspace(task.workspace, taskId, env.dataDir);
  await settleWork(env, taskId, 1);
  const origin = await env.request('GET', '/sessions/' + encodeURIComponent(chatId));
  assert.equal(origin.body.messages.length, 2, 'the Chat origin must keep its original messages');
  assert.equal(env.harness().store.getSession(chatId).workTaskId, taskId, 'the Chat origin must remember its promoted task');
  const inherited = env.harness().store.getSetting<Record<string, any>>('promotedChat:' + taskId, {});
  assert.equal(inherited.originalSessionId, chatId, 'the promoted task must keep the Chat origin link');
  assert.deepEqual(inherited.sourceMessageIds, settledChat.messages.map((message: any) => message.id), 'promotion must preserve the exact Chat source messages');

  // A project selected after this Chat started must govern the promoted workspace, not the old root scope.
  const project = await env.request('POST', '/workspace/projects', { path: env.workspace });
  assert.equal(project.status, 200, json(project.body));
  const projectId = project.body.id as string;
  const secondChat = await sendChatHttp(env, 'Chat that receives a project later');
  assert.equal(secondChat.status, 200, json(secondChat.body));
  const secondChatId = secondChat.body.sessionId as string;
  await waitChatIdle(env, secondChatId);
  const tagged = await sendChatHttp(env, 'Now select the project', { sessionId: secondChatId, projectId });
  assert.equal(tagged.status, 200, json(tagged.body));
  await waitChatIdle(env, secondChatId);

  const secondPromoted = await env.request('POST', '/sessions/' + encodeURIComponent(secondChatId) + '/promote', { objective: 'Promote into the selected project', acceptance: [] });
  assert.equal(secondPromoted.status, 200, json(secondPromoted.body));
  const secondTask = env.kernel().getTask(secondPromoted.body.id as string)!;
  assert.equal(path.resolve(secondTask.workspace).toLowerCase(), realpathSync(env.workspace).toLowerCase(), 'a project selected before promotion must be preserved');
  await settleWork(env, secondTask.id, 1);
  const secondOrigin = await env.request('GET', '/sessions/' + encodeURIComponent(secondChatId));
  assert.equal(secondOrigin.body.projectId, projectId, 'the Chat origin keeps its project association');
});

test('an explicitly forwarded dangerous workspace is rejected instead of being replaced', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const source = await env.requestRaw('POST', '/v1/harness/sessions', { title: 'Explicit workspace safety boundary', workspace: env.workspace });
  assert.equal(source.status, 200, json(source.body));
  const chatId = source.body.id as string;
  const before = env.kernel().listTasks().length;

  // Exactly the caller-provided workspace must reach the Services boundary; it may not be swapped
  // for the Kernel default when it is dangerous.
  for (const candidate of [PROJECT_ROOT, env.dataDir, path.join(PROJECT_ROOT, 'src')]) {
    const rejected = await env.requestRaw('POST', '/v1/harness/sessions/' + encodeURIComponent(chatId) + '/promote', {
      objective: 'Explicitly use a dangerous workspace', acceptance: [], workspace: candidate,
    });
    assert.equal(rejected.status, 400, 'explicit workspace ' + candidate + ' must be rejected: ' + json(rejected.body));
    assert.match(rejected.body.error, /workspace|project|audit/i);
    assert.equal(env.kernel().listTasks().length, before, 'a rejected promotion must not create a task');
    assert.equal(env.harness().store.getSession(chatId).workTaskId, undefined, 'a rejected promotion must not link the Chat session');
  }

  const promoted = await env.requestRaw('POST', '/v1/harness/sessions/' + encodeURIComponent(chatId) + '/promote', { objective: 'Promote without an explicit workspace', acceptance: [] });
  assert.equal(promoted.status, 200, json(promoted.body));
  const task = env.kernel().getTask(promoted.body.taskId)!;
  assert.equal(path.resolve(task.workspace).toLowerCase(), path.resolve(env.workspace).toLowerCase(), 'a normal promotion must still use the stored session workspace');
  await settleWork(env, task.id, 1);
});

