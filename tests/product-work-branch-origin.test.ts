import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';

/**
 * Work 会话分叉的不可变来源（origin）契约（executor B）。
 *
 * 分叉后的新会话必须能通过真实 HTTP 的 Inspector recall 找回分叉点及其祖先的原始记录，
 * 且 sha 与分叉前捕获的 canonical 记录 SHA 一致；源被追加消息、被隐藏、后端重启、
 * 多级分叉以及 Chat -> Work 提升之后都不变。分叉点是不可变前缀：分叉点之后的源记录
 * 不属于该分叉，必须不可回查。
 */

type Backend = Awaited<ReturnType<typeof startBackend>>;
type Reply = { status: number; json: any; text: string; headers: Headers };

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const SETTLED = ['waiting_approval', 'waiting_input', 'completed', 'failed', 'cancelled'];

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
const DATA_ROOT = path.join(TREE, '.tmp', 'history-lifecycle', 'b', 'data', 'work-branch-origin');
mkdirSync(DATA_ROOT, { recursive: true });
let run = 0;

/** 等一个可读快照连续两次一致，避免把重启后的恢复过程当成稳定状态。 */
async function stableValue<T>(read: () => T, label: string): Promise<T> {
  const deadline = performance.now() + 30_000;
  let serialized = JSON.stringify(read());
  for (;;) {
    await sleep(300);
    const next = JSON.stringify(read());
    if (next === serialized) return JSON.parse(next) as T;
    assert.ok(performance.now() < deadline, 'Did not stabilise: ' + label);
    serialized = next;
  }
}

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

  const request = async (method: string, route: string, options: { body?: unknown } = {}): Promise<Reply> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + backend.token };
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
    const reply = await request(method, route, body === undefined ? {} : { body });
    const statuses = Array.isArray(status) ? status : [status];
    assert.ok(statuses.includes(reply.status), method + ' ' + route + ' -> ' + reply.status + ': ' + reply.text.slice(0, 400));
    assert.equal(reply.json?.code, code, method + ' ' + route + ' -> ' + reply.text.slice(0, 400));
    return reply.json;
  };
  const until = async <T>(read: () => Promise<T | undefined> | T | undefined, label: string): Promise<T> => {
    const deadline = performance.now() + 45_000;
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

const branchOk = async (f: Fixture, sessionId: string, messageId: string): Promise<any> => {
  const reply = await f.request('POST', '/v1/product/sessions/' + sessionId + '/branch', { body: { messageId } });
  assert.equal(reply.status, 200, 'branch ' + sessionId + ' at ' + messageId + ' -> ' + reply.status + ': ' + reply.text.slice(0, 500));
  assert.match(String(reply.headers.get('content-type') ?? ''), /application\/json/);
  return reply.json;
};

const recallRoute = (sessionId: string, sourceId: string): string =>
  '/v1/product/inspector/recall?sessionId=' + encodeURIComponent(sessionId) + '&sourceId=' + encodeURIComponent(sourceId);

type Memory = ReturnType<Fixture['kernel']['memory']>;
interface Canonical { sha: string; text: string }

/** 分叉前捕获的 canonical 原始记录：sha 是整条记录 JSON 的 SHA-256，text 是字段内容。 */
const canonicalOf = (memory: Memory, messageId: string): Canonical => {
  const record = memory.read({ id: messageId, field: 'record' });
  const content = memory.read({ id: messageId });
  assert.equal(typeof record.sha256, 'string');
  assert.equal(record.sha256.length, 64);
  assert.equal(typeof content.text, 'string');
  return { sha: record.sha256, text: content.text };
};

/** recall 必须逐字返回原始记录，且 sha 等于分叉前的 canonical 记录 SHA。 */
const assertRecall = async (f: Fixture, sessionId: string, sourceId: string, expected: Canonical): Promise<void> => {
  const page = await f.ok('GET', recallRoute(sessionId, sourceId));
  assert.equal(page.sourceId, sourceId);
  assert.equal(page.sha, expected.sha, 'recall must return the canonical origin record SHA for ' + sourceId);
  assert.equal(page.offset, 0);
  assert.equal(page.text, expected.text, 'recall must return the original field content for ' + sourceId);
};

test('branch origin recall is frozen at the branch point and survives later rows, removal and restart', { timeout: 180_000 }, async t => {
  const f = await newFixture(t);
  const projectId = await registerProject(f);

  const source = await sendWork(f, 'Draft the migration checklist', { projectId });
  await waitTask(f, source.sessionId, ['waiting_approval']);

  const kernel = f.kernel;
  const sourceRows = kernel.getMessages(source.sessionId, 'main');
  assert.ok(sourceRows.length >= 2, 'the source must hold rows newer than the branch point');
  const first = sourceRows[0]!;
  const second = sourceRows[1]!;
  assert.equal(first.role, 'user');
  assert.equal(second.role, 'assistant');
  const firstCanonical = canonicalOf(kernel.memory(source.sessionId), first.id);
  const secondCanonical = canonicalOf(kernel.memory(source.sessionId), second.id);
  assert.equal(firstCanonical.text, first.content);

  const wireBefore = f.wire.length;
  // 在非最新消息处创建分叉：更新的源记录已经存在，但不属于不可变前缀。
  const created = await branchOk(f, source.sessionId, first.id);
  assert.equal(f.wire.length, wireBefore, 'branching must not dispatch a model request');
  const branchId = String(created.id);
  assert.equal(created.status, 'paused');
  assert.equal(created.parentSessionId, source.sessionId);

  await assertRecall(f, branchId, first.id, firstCanonical);
  await f.fails('GET', recallRoute(branchId, second.id), undefined, 404, 'not_found');

  // (a) 源在快照之后追加了新的用户消息。
  const appended = await f.ok('POST', '/v1/product/chat/send', {
    sessionId: source.sessionId, mode: 'cowork', text: 'Add the rollback checklist', attachments: [], permission: 'ask', modelId: 'default',
  });
  assert.equal(typeof appended.messageId, 'string');
  const appendedId = String(appended.messageId);
  assert.ok(f.kernel.getMessages(source.sessionId, 'main').length > sourceRows.length);
  const appendedCanonical = canonicalOf(f.kernel.memory(source.sessionId), appendedId);
  await assertRecall(f, branchId, first.id, firstCanonical);
  await f.fails('GET', recallRoute(branchId, second.id), undefined, 404, 'not_found');
  await f.fails('GET', recallRoute(branchId, appendedId), undefined, 404, 'not_found');

  // 在最新消息处创建的分叉拥有完整的前缀。
  const latest = await branchOk(f, source.sessionId, appendedId);
  const latestId = String(latest.id);
  assert.equal(latest.status, 'paused');
  assert.equal(latest.parentSessionId, source.sessionId);
  await assertRecall(f, latestId, first.id, firstCanonical);
  await assertRecall(f, latestId, second.id, secondCanonical);
  await assertRecall(f, latestId, appendedId, appendedCanonical);

  // (b) 源被隐藏（cancel + dismiss）后，两个分叉仍然保有来源。
  const removed = await f.ok('POST', '/v1/product/sessions/' + source.sessionId + '/remove');
  assert.deepEqual(removed, { removed: true });
  assert.ok(f.kernel.getTask(source.sessionId), 'the hidden task stays an audit record in the Kernel');
  await assertRecall(f, branchId, first.id, firstCanonical);
  await assertRecall(f, latestId, appendedId, appendedCanonical);
  const branchDetail = await f.ok('GET', '/v1/product/sessions/' + branchId);
  assert.equal(branchDetail.status, 'paused');

  // (c) 后端重启后来源仍可读，且 paused 分叉不会被调度。
  const wireAtRestart = f.wire.length;
  await f.restart();
  await sleep(350);
  assert.equal(f.wire.length, wireAtRestart, 'restart must not dispatch work for a paused branch');
  const restartedTask = f.kernel.getTask(branchId);
  assert.ok(restartedTask);
  assert.equal(restartedTask!.status, 'paused');
  assert.deepEqual(f.kernel.pendingCalls(branchId), []);
  await assertRecall(f, branchId, first.id, firstCanonical);
  await f.fails('GET', recallRoute(branchId, second.id), undefined, 404, 'not_found');
  await assertRecall(f, latestId, second.id, secondCanonical);

  const detail = await f.ok('GET', '/v1/product/sessions/' + branchId);
  assert.equal(detail.status, 'paused');
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0].role, 'user');
  assert.ok((detail.messages[0].parts as any[]).some(part => part.kind === 'text'
    && part.text === restartedTask!.goal.objective));
});

test('restart keeps a paused branch and one resume runs a single Work request plus its review', { timeout: 180_000 }, async t => {
  const branchAnswer = 'BRANCH_RESUME_MOCK_ANSWER';
  let plainAnswer = false;
  const responder = ((() => (plainAnswer ? { content: branchAnswer } : undefined)) as unknown) as MockProviderOptions['responder'];
  const f = await newFixture(t, { responder });
  const projectId = await registerProject(f);

  const source = await sendWork(f, 'Draft the rollback procedure', { projectId });
  await waitTask(f, source.sessionId, ['waiting_approval']);
  const sourceMessageIds = f.kernel.getMessages(source.sessionId, 'main').map(message => message.id);
  assert.ok(sourceMessageIds.length >= 2);
  assert.ok(f.kernel.pendingCalls(source.sessionId).length >= 1);
  const objective = f.kernel.getTask(source.sessionId)!.goal.objective;

  const created = await branchOk(f, source.sessionId, sourceMessageIds[0]!);
  const branchId = String(created.id);
  assert.equal(created.status, 'paused');
  assert.equal(f.kernel.getTask(branchId)!.goal.objective, objective);
  assert.equal(f.kernel.getMessages(branchId, 'main').length, 1);
  const branchRequests = () => {
    const page = f.harness.store.listRequests({ taskId: branchId, limit: 100 });
    assert.equal(page.nextCursor, null, 'this branch fixture must fit in one explicit request page');
    return page.requests;
  };
  assert.deepEqual(branchRequests(), []);

  // 崩溃安全：关闭后端并重开同一 dataDir，等待超过一个调度周期。
  await f.restart();
  await sleep(350);
  assert.deepEqual(branchRequests(), [], 'a paused branch must not dispatch; source recovery has its own request identity');
  const restarted = f.kernel.getTask(branchId);
  assert.ok(restarted);
  assert.equal(restarted!.status, 'paused');
  assert.equal(restarted!.modelCalls, 0);
  assert.deepEqual(f.kernel.pendingCalls(branchId), []);
  assert.deepEqual(f.kernel.intents(branchId), []);
  assert.deepEqual(f.kernel.getRuns(branchId), []);
  assert.equal(f.kernel.getMessages(branchId, 'main').length, 1);

  // 重启后恢复流程会重新驱动源任务；先让它稳定，再验证 resume 分叉不改变源。
  await waitTask(f, source.sessionId, SETTLED);
  const sourceAfterRestart = await stableValue(() => ({
    task: f.kernel.getTask(source.sessionId),
    events: f.kernel.events(source.sessionId),
    messages: f.kernel.getMessages(source.sessionId, 'main'),
    pendingCalls: f.kernel.pendingCalls(source.sessionId),
    intents: f.kernel.intents(source.sessionId),
  }), 'the source settles after restart');

  // resume 后：恰好一次 work 模型请求，历史只有目标 + 助手文本。
  plainAnswer = true;
  const wireAtResume = f.wire.length;
  const resumed = await f.request('POST', '/v1/product/tasks/' + branchId + '/control', { body: { action: 'resume' } });
  assert.equal(resumed.status, 200, 'resume -> ' + resumed.status + ': ' + resumed.text.slice(0, 400));
  assert.equal(resumed.json.id, branchId);
  assert.ok(['queued', 'running'].includes(String(resumed.json.status)), 'resume returned ' + resumed.json.status);

  const settled = await f.until(async () => {
    const task = await f.ok('GET', '/v1/product/tasks/' + branchId);
    return task && ['waiting_input', 'completed', 'failed'].includes(String(task.status)) ? task : undefined;
  }, 'the resumed branch settles');
  assert.ok(['waiting_input', 'completed'].includes(String(settled.status)),
    'the mock cannot pass effect verification, so the branch must not complete: ' + settled.status);

  const requests = branchRequests();
  const workRequests = requests.filter(request => request.kind === 'work');
  assert.equal(workRequests.length, 1, 'resuming a branch must run exactly one task-owned work request');
  assert.equal(workRequests[0]!.status, 'completed');
  const branchWire = f.wire.slice(wireAtResume).filter(body => createHash('sha256').update(JSON.stringify(body)).digest('hex') === workRequests[0]!.bodyHash);
  assert.equal(branchWire.length, 1, 'the one branch request must reach the real provider exactly once');
  const reviews = requests.filter(request => request.kind === 'review');
  assert.equal(reviews.length, 1, 'the proposed answer receives exactly one independent verification request');
  assert.equal(reviews[0]!.parentId, workRequests[0]!.id);
  assert.equal(reviews[0]!.status, 'completed');
  const reviewWire = f.wire.slice(wireAtResume).filter(body => createHash('sha256').update(JSON.stringify(body)).digest('hex') === reviews[0]!.bodyHash);
  assert.equal(reviewWire.length, 1, 'the independent verification reaches the real provider exactly once');
  assert.equal(requests.length, workRequests.length + reviews.length, 'no other model request is charged to the branch');
  assert.equal(f.kernel.getTask(branchId)!.modelCalls, requests.length, 'the task accounts for both actual model calls exactly once');
  assert.equal(f.kernel.getBudgets(branchId).modelCalls, requests.length);

  const messages = f.kernel.getMessages(branchId, 'main');
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(messages[0]!.content, objective);
  assert.deepEqual(messages[0]!.toolCalls ?? [], []);
  assert.deepEqual((messages[0] as unknown as { attachments?: unknown[] }).attachments ?? [], []);
  assert.equal(messages[1]!.content, branchAnswer);
  assert.deepEqual(messages[1]!.toolCalls ?? [], []);
  const copied = messages.filter(message => sourceMessageIds.includes(message.id));
  assert.deepEqual(copied, [], 'no source message may be copied into the branch');

  // 源任务在分叉 + 重启 + resume 之后与重启后的稳定状态逐字段一致。
  assert.deepEqual(f.kernel.getTask(source.sessionId), sourceAfterRestart.task);
  assert.deepEqual(f.kernel.events(source.sessionId), sourceAfterRestart.events);
  assert.deepEqual(f.kernel.getMessages(source.sessionId, 'main'), sourceAfterRestart.messages);
  assert.deepEqual(f.kernel.pendingCalls(source.sessionId), sourceAfterRestart.pendingCalls);
  assert.deepEqual(f.kernel.intents(source.sessionId), sourceAfterRestart.intents);
});

test('a branch of a branch keeps the first source messages recallable', { timeout: 180_000 }, async t => {
  const f = await newFixture(t);
  const projectId = await registerProject(f);

  const source = await sendWork(f, 'Track the origin lineage probe', { projectId });
  await waitTask(f, source.sessionId, ['waiting_approval']);
  const kernel = f.kernel;
  const sourceRows = kernel.getMessages(source.sessionId, 'main');
  assert.ok(sourceRows.length >= 2);
  const first = sourceRows[0]!;
  const second = sourceRows[1]!;
  const firstCanonical = canonicalOf(kernel.memory(source.sessionId), first.id);
  const secondCanonical = canonicalOf(kernel.memory(source.sessionId), second.id);

  // 第一级分叉在最新记录处，因此它的不可变前缀包含两条源记录。
  const branch1 = await branchOk(f, source.sessionId, second.id);
  const branch1Id = String(branch1.id);
  assert.equal(branch1.status, 'paused');
  assert.equal(branch1.parentSessionId, source.sessionId);
  const branch1Rows = kernel.getMessages(branch1Id, 'main');
  assert.equal(branch1Rows.length, 1);
  const branch1Row = branch1Rows[0]!;
  assert.equal(branch1Row.content, firstCanonical.text);
  const branch1Canonical = canonicalOf(kernel.memory(branch1Id), branch1Row.id);
  await assertRecall(f, branch1Id, first.id, firstCanonical);
  await assertRecall(f, branch1Id, second.id, secondCanonical);

  // 第二级分叉必须再回溯一层链接才能看到第一级分叉的 origin。
  const branch2 = await branchOk(f, branch1Id, branch1Row.id);
  const branch2Id = String(branch2.id);
  assert.equal(branch2.status, 'paused');
  assert.equal(branch2.parentSessionId, branch1Id);
  assert.notEqual(branch2Id, branch1Id);
  assert.equal(branch2.title, String(branch1.title) + ' · 分支');
  assert.equal(branch2.permission, branch1.permission);
  const branch2Rows = kernel.getMessages(branch2Id, 'main');
  assert.equal(branch2Rows.length, 1);
  assert.equal(branch2Rows[0]!.content, branch1Row.content);

  await assertRecall(f, branch2Id, branch1Row.id, branch1Canonical);
  await assertRecall(f, branch2Id, second.id, secondCanonical);
  await assertRecall(f, branch2Id, first.id, firstCanonical);

  // 源在两级分叉之后追加一行：任何一级前缀都不会变。
  const appended = await f.ok('POST', '/v1/product/chat/send', {
    sessionId: source.sessionId, mode: 'cowork', text: 'Later unrelated row', attachments: [], permission: 'ask', modelId: 'default',
  });
  const appendedId = String(appended.messageId);
  await f.fails('GET', recallRoute(branch2Id, appendedId), undefined, 404, 'not_found');
  await f.fails('GET', recallRoute(branch1Id, appendedId), undefined, 404, 'not_found');

  // send_message 会将源任务重新排队；HTTP 接受输入不代表新提案已进入审批。
  await waitTask(f, source.sessionId, ['waiting_approval']);
  assert.equal(kernel.getTask(source.sessionId)!.status, 'waiting_approval');
  assert.ok(kernel.getMessages(source.sessionId, 'main').length > sourceRows.length);
});

test('a branch of a promoted work task keeps the original chat record recallable', { timeout: 180_000 }, async t => {
  const f = await newFixture(t);
  const chat = await f.ok('POST', '/v1/harness/sessions', { title: 'Promotion origin chat', workspace: f.workspace });
  assert.equal(typeof chat.id, 'string');
  const chatId = String(chat.id);
  const chatSent = await f.ok('POST', '/v1/product/chat/send', {
    sessionId: chatId, mode: 'chat', text: 'Discuss the promotion origin', attachments: [], permission: 'read-only', modelId: 'default',
  });
  await f.until(async () => {
    const detail = await f.ok('GET', '/v1/product/sessions/' + chatId);
    return detail.status === 'idle' ? detail : undefined;
  }, 'the chat settles');
  const chatMessageId = String(chatSent.messageId);
  const chatCanonical = canonicalOf(f.harness.store.memory(chatId), chatMessageId);

  const promoted = await f.ok('POST', '/v1/product/sessions/' + chatId + '/promote', {
    objective: 'Implement the promoted origin goal', acceptance: [],
  });
  const promotedId = String(promoted.id);
  assert.equal(promoted.mode, 'cowork');
  assert.equal(promoted.parentSessionId, chatId);
  await pauseTask(f, promotedId);
  const promotedTask = f.kernel.getTask(promotedId)!;
  assert.equal(promotedTask.status, 'paused');
  assert.equal(promotedTask.permissionMode, 'read-only');
  assert.equal(promotedTask.goal.objective, 'Implement the promoted origin goal');
  const promotedSnapshot = {
    task: promotedTask,
    events: f.kernel.events(promotedId),
    messages: f.kernel.getMessages(promotedId, 'main'),
  };
  const originRow = promotedSnapshot.messages[0]!;
  assert.equal(originRow.role, 'user');
  // 既有能力：提升后的任务能通过 Inspector 找回原 Chat 记录。
  await assertRecall(f, promotedId, chatMessageId, chatCanonical);

  const created = await branchOk(f, promotedId, originRow.id);
  const branchId = String(created.id);
  assert.equal(created.status, 'paused');
  assert.equal(created.parentSessionId, promotedId);
  assert.equal(created.mode, 'cowork');
  assert.equal(created.permission, 'read-only');

  const branchTask = f.kernel.getTask(branchId)!;
  assert.equal(branchTask.appMode, 'work');
  assert.equal(branchTask.status, 'paused');
  assert.equal(branchTask.permissionMode, 'read-only', 'a chat origin must never widen Work authority');
  assert.equal(branchTask.goal.objective, promotedTask.goal.objective);
  assert.deepEqual(f.kernel.getMessages(branchId, 'main').map(message => message.role), ['user']);

  // 新分叉必须同时找回（1）父 Work 任务的行和（2）更早的 Chat 原始记录。
  const parentRowCanonical = canonicalOf(f.kernel.memory(promotedId), originRow.id);
  await assertRecall(f, branchId, originRow.id, parentRowCanonical);
  await assertRecall(f, branchId, chatMessageId, chatCanonical);

  // 隐藏原 Chat 会话后，不可变来源仍然可读。
  await f.ok('POST', '/v1/product/sessions/' + chatId + '/remove');
  await assertRecall(f, branchId, chatMessageId, chatCanonical);
  await assertRecall(f, branchId, originRow.id, parentRowCanonical);

  // 分叉不改变被提升的任务本身。
  assert.deepEqual(f.kernel.getTask(promotedId), promotedSnapshot.task);
  assert.deepEqual(f.kernel.events(promotedId), promotedSnapshot.events);
  assert.deepEqual(f.kernel.getMessages(promotedId, 'main'), promotedSnapshot.messages);
});
