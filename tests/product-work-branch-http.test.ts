import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';

/**
 * Work 会话分叉的 HTTP 契约（executor B）。
 *
 * 每个被测行为都走真实 loopback startBackend + Bearer token + mock provider；Kernel/Harness
 * 读取只用于取原生 id、计数和 canonical SHA，行为断言以产品 HTTP 面为准。
 * 这些用例在 root 实现 Work 分叉之前应为 RED（当前返回 501 unsupported）。
 */

type Backend = Awaited<ReturnType<typeof startBackend>>;
type Reply = { status: number; json: any; text: string; headers: Headers };

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const TERMINAL = ['completed', 'failed', 'cancelled'] as const;

/** 私有 out-of-tree build 下也要找到 checkout 根，数据目录必须落在该项目内。 */
function checkoutRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'src', 'app', 'backend.ts'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot locate the project root from ' + start);
    dir = parent;
  }
}

const TREE = checkoutRoot(process.cwd());
const DATA_ROOT = path.join(TREE, '.tmp', 'history-lifecycle', 'b', 'data', 'work-branch-http');
mkdirSync(DATA_ROOT, { recursive: true });
let run = 0;

async function newFixture(t: TestContext, mockOptions: MockProviderOptions = {}) {
  const owned = path.join(DATA_ROOT, 'run-' + process.pid + '-' + Date.now() + '-' + run++);
  const workspace = path.join(owned, 'workspace');
  const dataDir = path.join(owned, 'data');
  mkdirSync(workspace, { recursive: true });
  const relative = path.relative(TREE, dataDir);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'dataDir must stay inside the project root');
  const wire: any[] = [];
  const settings = { dataDir, projectRoot: TREE, mockOptions: { ...mockOptions, trace: (body: any) => wire.push(body) } };
  let backend: Backend = await startBackend(settings);
  let disposed = false;

  const request = async (method: string, route: string, options: { body?: unknown; auth?: boolean } = {}): Promise<Reply> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.auth !== false) headers.Authorization = 'Bearer ' + backend.token;
    const response = await fetch('http://127.0.0.1:' + backend.port + route, {
      method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: response.status, json, text, headers: response.headers };
  };
  const ok = async (method: string, route: string, body?: unknown): Promise<any> => {
    const reply = await request(method, route, body === undefined ? {} : { body });
    assert.equal(reply.status, 200, method + ' ' + route + ' -> ' + reply.status + ': ' + reply.text.slice(0, 400));
    assert.match(String(reply.headers.get('content-type') ?? ''), /application\/json/);
    return reply.json;
  };
  const fails = async (method: string, route: string, body: unknown, status: number | number[], code: string): Promise<any> => {
    const reply = await request(method, route, { body });
    const statuses = Array.isArray(status) ? status : [status];
    assert.ok(statuses.includes(reply.status), method + ' ' + route + ' -> ' + reply.status + ': ' + reply.text.slice(0, 400));
    assert.equal(reply.json?.code, code, method + ' ' + route + ' -> ' + reply.text.slice(0, 400));
    assert.equal(typeof reply.json?.error, 'string');
    return reply.json;
  };
  const until = async <T>(read: () => Promise<T | undefined> | T | undefined, label: string): Promise<T> => {
    const deadline = performance.now() + 40_000;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      assert.ok(performance.now() < deadline, 'Did not settle: ' + label);
      await sleep(25);
    }
  };
  const restart = async (): Promise<void> => { await backend.close(); backend = await startBackend(settings); };
  const close = async (): Promise<void> => { if (disposed) return; disposed = true; await backend.close(); };
  t.after(async () => { await close(); rmSync(owned, { recursive: true, force: true }); });

  return {
    get backend(): Backend { return backend; },
    get kernel() { return backend.services.kernel; },
    get harness() { return backend.services.harness!; },
    wire, workspace, dataDir, request, ok, fails, until, restart, close,
  };
}
type Fixture = Awaited<ReturnType<typeof newFixture>>;

const registerProject = async (f: Fixture): Promise<string> => {
  const created = await f.ok('POST', '/v1/product/workspace/projects', { path: f.workspace });
  assert.equal(typeof created.id, 'string');
  return created.id as string;
};

const sendWork = async (f: Fixture, text: string,
  options: { permission?: string; mode?: 'cowork' | 'code'; projectId?: string } = {}): Promise<{ sessionId: string; messageId: string }> => {
  const sent = await f.ok('POST', '/v1/product/chat/send', {
    mode: options.mode ?? 'cowork', text, attachments: [], permission: options.permission ?? 'ask',
    modelId: 'default', ...(options.projectId ? { projectId: options.projectId } : {}),
  });
  assert.equal(typeof sent.sessionId, 'string');
  assert.equal(typeof sent.messageId, 'string');
  return sent;
};

const waitTask = (f: Fixture, taskId: string, statuses: readonly string[]) => f.until(async () => {
  const task = await f.ok('GET', '/v1/product/tasks/' + taskId);
  return task && statuses.includes(String(task.status)) ? task : undefined;
}, 'task ' + taskId + ' reaches ' + statuses.join('/'));

const pauseTask = async (f: Fixture, taskId: string): Promise<void> => {
  const deadline = performance.now() + 20_000;
  for (;;) {
    const reply = await f.request('POST', '/v1/product/tasks/' + taskId + '/control', { body: { action: 'pause' } });
    if (reply.status === 200) break;
    assert.ok(performance.now() < deadline, 'Pause was never accepted for ' + taskId + ': ' + reply.status + ' ' + reply.text.slice(0, 300));
    assert.equal(reply.status, 409, 'Unexpected pause failure for ' + taskId + ': ' + reply.status + ' ' + reply.text.slice(0, 300));
    await sleep(25);
  }
  await waitTask(f, taskId, ['paused']);
};

const branchReply = (f: Fixture, sessionId: string, messageId: string): Promise<Reply> =>
  f.request('POST', '/v1/product/sessions/' + sessionId + '/branch', { body: { messageId } });

const branchOk = async (f: Fixture, sessionId: string, messageId: string): Promise<any> => {
  const reply = await branchReply(f, sessionId, messageId);
  assert.equal(reply.status, 200, 'branch ' + sessionId + ' at ' + messageId + ' -> ' + reply.status + ': ' + reply.text.slice(0, 500));
  assert.match(String(reply.headers.get('content-type') ?? ''), /application\/json/);
  return reply.json;
};

/** 源任务在分叉前后必须逐字段一致的原生快照。 */
const snapshotSource = (f: Fixture, taskId: string) => ({
  task: f.kernel.getTask(taskId),
  events: f.kernel.events(taskId),
  messages: f.kernel.getMessages(taskId, 'main'),
  intents: f.kernel.intents(taskId),
  runs: f.kernel.getRuns(taskId),
  grants: f.kernel.sessionGrants(taskId),
  pendingCalls: f.kernel.pendingCalls(taskId),
});

test('work branch creates an independent paused task and leaves the source untouched', { timeout: 120_000 }, async t => {
  const f = await newFixture(t);
  const projectId = await registerProject(f);

  const source = await sendWork(f, 'Write the quarterly release notes draft', { projectId });
  await waitTask(f, source.sessionId, ['waiting_approval']);
  const sourceTask = f.kernel.getTask(source.sessionId);
  assert.ok(sourceTask, 'the source Work task must exist');
  assert.equal(sourceTask!.permissionMode, 'ask');
  assert.ok(f.kernel.getMessages(source.sessionId, 'main').length >= 2,
    'the source already stores an assistant proposal row and a pending tool call');
  assert.ok(f.kernel.pendingCalls(source.sessionId).length >= 1);

  const snapshot = snapshotSource(f, source.sessionId);
  const sourceSummary = await f.ok('GET', '/v1/product/sessions/' + source.sessionId);
  const wireBefore = f.wire.length;

  const created = await branchOk(f, source.sessionId, source.messageId);
  assert.equal(f.wire.length, wireBefore, 'branching must not dispatch a model request');

  // --- the 200 SessionSummary contract ---
  assert.equal(typeof created.id, 'string');
  assert.notEqual(created.id, source.sessionId);
  assert.equal(created.parentSessionId, source.sessionId);
  assert.equal(created.status, 'paused');
  assert.equal(created.mode, sourceSummary.mode);
  assert.equal(created.mode, 'cowork');
  assert.equal(created.permission, sourceTask!.permissionMode);
  assert.equal(created.permission, 'ask');
  assert.equal(created.title, String(sourceSummary.title) + ' · 分支');
  assert.equal(typeof created.createdAt, 'string');
  assert.equal(typeof created.updatedAt, 'string');

  // --- the new Kernel task ---
  const kernel = f.kernel;
  const task = kernel.getTask(created.id);
  assert.ok(task, 'the branch must be a real Kernel task');
  assert.equal(task!.status, 'paused');
  assert.equal(task!.parentId, undefined);
  assert.ok(path.isAbsolute(task!.workspace));
  assert.equal(path.resolve(task!.workspace).toLowerCase(), path.resolve(sourceTask!.workspace).toLowerCase());
  assert.equal(task!.goal.objective, sourceTask!.goal.objective);
  assert.equal(task!.appMode, 'work');
  assert.equal(task!.permissionMode, sourceTask!.permissionMode);
  assert.equal(task!.modelCalls, 0);

  // 创建即 paused：不能出现 queued 行或 queued -> paused 的后续转换。
  const createdEvents = kernel.events(created.id);
  assert.ok(createdEvents.some(event => event.type === 'task.created'));
  assert.equal(createdEvents.some(event => event.type === 'task.paused'), false,
    'a branch must be inserted paused, never queued and paused afterwards');
  assert.equal(createdEvents.some(event => event.type === 'task.transitioned'
    && event.payload.from === 'queued' && event.payload.to === 'paused'), false);

  // 唯一一条真实用户消息 = 源目标，不复制源消息、工具调用或附件。
  const messages = kernel.getMessages(created.id, 'main');
  assert.equal(messages.length, 1);
  const only = messages[0]!;
  assert.equal(only.role, 'user');
  assert.equal(only.content, sourceTask!.goal.objective);
  assert.deepEqual(only.toolCalls ?? [], []);
  assert.deepEqual((only as unknown as { attachments?: unknown[] }).attachments ?? [], []);
  assert.deepEqual(kernel.memory(created.id).manifest().messages, 1);

  // 不复制任何授权/副作用/运行/待执行工具调用。
  assert.deepEqual(kernel.pendingCalls(created.id), []);
  assert.deepEqual(kernel.intents(created.id), []);
  assert.deepEqual(kernel.getRuns(created.id), []);
  assert.deepEqual(kernel.sessionGrants(created.id), []);
  assert.deepEqual(kernel.getCheckpoints(created.id), []);
  assert.deepEqual(kernel.getVerifications(created.id), []);

  // --- the source is byte-for-byte unchanged ---
  assert.deepEqual(kernel.getTask(source.sessionId), snapshot.task);
  assert.deepEqual(kernel.events(source.sessionId), snapshot.events);
  assert.deepEqual(kernel.getMessages(source.sessionId, 'main'), snapshot.messages);
  assert.deepEqual(kernel.intents(source.sessionId), snapshot.intents);
  assert.deepEqual(kernel.getRuns(source.sessionId), snapshot.runs);
  assert.deepEqual(kernel.sessionGrants(source.sessionId), snapshot.grants);
  assert.deepEqual(kernel.pendingCalls(source.sessionId), snapshot.pendingCalls);
  assert.equal(snapshot.task!.status, 'waiting_approval', 'the source keeps its own lifecycle');

  // --- the product index and detail surface ---
  const listed = await f.ok('GET', '/v1/product/sessions?limit=100');
  const row = (listed.items as any[]).find(item => item.id === created.id);
  assert.ok(row, 'the branch must appear in GET /v1/product/sessions');
  assert.equal(row.mode, sourceSummary.mode);
  assert.equal(row.parentSessionId, source.sessionId);
  assert.equal(row.status, 'paused');
  assert.equal(row.permission, 'ask');

  const detail = await f.ok('GET', '/v1/product/sessions/' + created.id);
  assert.equal(detail.status, 'paused');
  assert.equal(detail.parentSessionId, source.sessionId);
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0].role, 'user');
  assert.ok((detail.messages[0].parts as any[]).some(part => part.kind === 'text' && part.text === sourceTask!.goal.objective));

  const productEvents = await f.ok('GET', '/v1/product/events?cursor=0&limit=200&sessionId=' + created.id);
  assert.ok((productEvents.events as any[]).some(entry => entry.event?.type === 'session.upsert' && entry.event?.session?.id === created.id),
    'the product event log must carry a session.upsert for the new branch');

  // --- the index mode is preserved for code sessions too ---
  const codeSource = await sendWork(f, 'Review the release branch diff', { mode: 'code', projectId });
  await waitTask(f, codeSource.sessionId, ['waiting_approval']);
  const codeSummary = await f.ok('GET', '/v1/product/sessions/' + codeSource.sessionId);
  assert.equal(codeSummary.mode, 'code');
  const codeBranch = await branchOk(f, codeSource.sessionId, codeSource.messageId);
  assert.equal(codeBranch.mode, 'code');
  assert.equal(codeBranch.status, 'paused');
  assert.equal(f.kernel.getTask(codeBranch.id)?.status, 'paused');
});

test('work branch rejects unknown, foreign, chat, side, hidden and malformed input', { timeout: 120_000 }, async t => {
  const f = await newFixture(t);
  const projectId = await registerProject(f);

  const first = await sendWork(f, 'Prepare the audit trail summary', { projectId });
  const second = await sendWork(f, 'Prepare the deployment checklist', { projectId });
  await waitTask(f, first.sessionId, ['waiting_approval']);
  await waitTask(f, second.sessionId, ['waiting_approval']);
  const firstMessage = f.kernel.getMessages(first.sessionId, 'main')[0]!.id;
  const secondMessage = f.kernel.getMessages(second.sessionId, 'main')[0]!.id;

  // A Chat conversation is a different authority and its messages must never be branch origins.
  const chat = await f.ok('POST', '/v1/harness/sessions', { title: 'Branch boundary chat' });
  const chatSent = await f.ok('POST', '/v1/product/chat/send', {
    sessionId: chat.id, mode: 'chat', text: 'Chat origin message', attachments: [], permission: 'read-only', modelId: 'default',
  });
  await f.until(async () => {
    const detail = await f.ok('GET', '/v1/product/sessions/' + chat.id);
    return detail.status === 'idle' ? detail : undefined;
  }, 'chat settles');
  const chatMessage = String(chatSent.messageId);

  // A side (non-main) Kernel session is not the branchable conversation.
  const side = await f.ok('POST', '/v1/sidechat', { taskId: first.sessionId, sessionId: 'side-branch-probe', message: 'Side question' });
  const sideMessages = (side.messages as any[]).filter(message => message.role === 'user');
  assert.equal(sideMessages.length, 1);
  const sideMessage = String(sideMessages[0].id);

  const tasksBefore = f.kernel.listTasks().length;

  await f.fails('POST', '/v1/product/sessions/does-not-exist/branch', { messageId: firstMessage }, 404, 'not_found');
  await f.fails('POST', '/v1/product/sessions/' + first.sessionId + '/branch', { messageId: 'does-not-exist' }, 404, 'not_found');
  await f.fails('POST', '/v1/product/sessions/' + first.sessionId + '/branch', { messageId: secondMessage }, 404, 'not_found');
  await f.fails('POST', '/v1/product/sessions/' + first.sessionId + '/branch', { messageId: chatMessage }, 404, 'not_found');
  await f.fails('POST', '/v1/product/sessions/' + first.sessionId + '/branch', { messageId: sideMessage }, 404, 'not_found');
  assert.equal(f.kernel.listTasks().length, tasksBefore, 'rejected branch requests must not create a task');

  // Strict body validation: the bridge only sends messageId.
  await f.fails('POST', '/v1/product/sessions/' + first.sessionId + '/branch', {}, 400, 'validation');
  await f.fails('POST', '/v1/product/sessions/' + first.sessionId + '/branch', { messageId: 42 }, 400, 'validation');
  await f.fails('POST', '/v1/product/sessions/' + first.sessionId + '/branch', { messageId: { id: firstMessage } }, 400, 'validation');
  await f.fails('POST', '/v1/product/sessions/' + first.sessionId + '/branch', { messageId: 'x'.repeat(201) }, 400, 'validation');
  await f.fails('POST', '/v1/product/sessions/' + first.sessionId + '/branch', { messageId: firstMessage, workspace: f.workspace }, 400, 'validation');
  await f.fails('POST', '/v1/product/sessions/' + first.sessionId + '/branch', { messageId: firstMessage, permission: 'full-access' }, 400, 'validation');
  await f.fails('POST', '/v1/product/sessions/' + first.sessionId + '/branch', { messageId: firstMessage, mode: 'code' }, 400, 'validation');
  assert.equal(f.kernel.listTasks().length, tasksBefore, 'invalid branch requests must not create a task');

  // A hidden (cancelled + dismissed) source stays an audit record in the Kernel but cannot branch.
  const removed = await f.ok('POST', '/v1/product/sessions/' + first.sessionId + '/remove');
  assert.deepEqual(removed, { removed: true });
  const hidden = f.kernel.getTask(first.sessionId);
  assert.ok(hidden, 'the Kernel keeps the hidden task as an audit record');
  assert.equal(hidden!.status, 'cancelled');
  await f.fails('POST', '/v1/product/sessions/' + first.sessionId + '/branch', { messageId: firstMessage }, 404, 'not_found');
});

test('branching a terminal work task is allowed and leaves it unchanged', { timeout: 120_000 }, async t => {
  const f = await newFixture(t);
  const projectId = await registerProject(f);

  const source = await sendWork(f, 'Write the migration approval file', { projectId });
  const approvals = await f.until(async () => {
    const reply = await f.request('GET', '/v1/product/approvals?sessionId=' + source.sessionId);
    return reply.status === 200 && Array.isArray(reply.json) && reply.json.length ? reply.json : undefined;
  }, 'the source prepares an approval');
  const decided = await f.ok('POST', '/v1/product/approvals/decide', { approvalId: approvals[0].id, approved: true, scope: 'once' });
  assert.equal(decided.resolved, true);
  const settled = await waitTask(f, source.sessionId, TERMINAL);
  assert.ok(TERMINAL.includes(settled.status), 'the source must be terminal, got ' + settled.status);

  const snapshot = snapshotSource(f, source.sessionId);
  const sourceSummary = await f.ok('GET', '/v1/product/sessions/' + source.sessionId);
  const wireBefore = f.wire.length;

  const created = await branchOk(f, source.sessionId, source.messageId);
  assert.equal(f.wire.length, wireBefore, 'branching a terminal source must not dispatch a model request');
  assert.equal(created.status, 'paused');
  assert.notEqual(created.id, source.sessionId);
  assert.equal(created.parentSessionId, source.sessionId);
  assert.equal(created.title, String(sourceSummary.title) + ' · 分支');

  const task = f.kernel.getTask(created.id);
  assert.ok(task);
  assert.equal(task!.status, 'paused');
  assert.equal(task!.goal.objective, snapshot.task!.goal.objective);
  assert.equal(f.kernel.getMessages(created.id, 'main').length, 1);
  assert.deepEqual(f.kernel.intents(created.id), []);
  assert.deepEqual(f.kernel.getRuns(created.id), []);

  // Branching must not touch the already settled source.
  assert.deepEqual(f.kernel.getTask(source.sessionId), snapshot.task);
  assert.deepEqual(f.kernel.events(source.sessionId), snapshot.events);
  assert.deepEqual(f.kernel.getMessages(source.sessionId, 'main'), snapshot.messages);
  assert.deepEqual(f.kernel.intents(source.sessionId), snapshot.intents);
  assert.equal(snapshot.task!.status, settled.status);
});

test('work branch keeps the source permission mode without escalation', { timeout: 120_000 }, async t => {
  const f = await newFixture(t);
  const projectId = await registerProject(f);

  const source = await sendWork(f, 'Audit the read-only workspace snapshot', { permission: 'read-only', projectId });
  await pauseTask(f, source.sessionId);
  const paused = f.kernel.getTask(source.sessionId)!;
  assert.equal(paused.status, 'paused');
  assert.equal(paused.permissionMode, 'read-only');

  const snapshot = snapshotSource(f, source.sessionId);
  const created = await branchOk(f, source.sessionId, source.messageId);
  assert.equal(created.status, 'paused');
  assert.equal(created.permission, 'read-only');

  const task = f.kernel.getTask(created.id);
  assert.ok(task);
  assert.equal(task!.permissionMode, 'read-only', 'a read-only source must never branch into wider authority');
  assert.equal(task!.appMode, 'work');
  assert.equal(task!.status, 'paused');
  assert.deepEqual(f.kernel.sessionGrants(created.id), []);
  assert.deepEqual(f.kernel.intents(created.id), []);
  assert.deepEqual(f.kernel.getTask(source.sessionId), snapshot.task);
  assert.deepEqual(f.kernel.events(source.sessionId), snapshot.events);
});
