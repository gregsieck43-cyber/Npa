/**
 * Work 流式身份与终态回归（真实 HTTP + 真实 loopback mock SSE，不经 GUI/公网）。
 *
 * Codex 复核缺陷（本文件先红后绿）：
 *  - 完成气泡使用投影 id（stream-<task>-<seq>），Kernel 持久消息是另一个 id，
 *    导致 done 事件 id 无法经 Kernel/Inspector/branch 解析，GET session 刷新后身份改变；
 *  - closeWorkStream 把失败也标成 cancelled，真实 provider 错误与操作者取消不可区分。
 *
 * 契约：同一 Work 回答从 partial 到 done 到持久历史只有一个稳定 id，且该 id 就是
 * kernel.getMessage(id) 的 canonical assistant；重启后详情 id 不变；provider 失败终态
 * status:'error' 且带真实错误码；真实取消终态 status:'cancelled'；隐藏（dismissed）会话
 * 的迟到事件不得回写成新的产品消息。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import type { MockCompletion } from '../src/fixtures/mock-provider.js';
import type { ChatMessage, GatewayEvent } from '../src/frontend/api/types.js';

const root = path.resolve(process.env.TEMP ?? '.tmp');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const json = (value: unknown) => JSON.stringify(value);
const systemText = (body: any): string => (Array.isArray(body?.messages) ? body.messages : [])
  .filter((message: any) => message?.role === 'system' && typeof message.content === 'string')
  .map((message: any) => message.content as string).join('\n');
const isReviewerCall = (body: any): boolean => systemText(body).includes('REVIEWER ROLE');
const reviewPass = (reason: string): MockCompletion => ({ content: JSON.stringify({ verdict: 'pass', reason, findings: [] }) });

interface EventEntry { id: number; event: GatewayEvent }
interface EventPage { events: EventEntry[]; nextCursor: number }

interface Env {
  backend: Awaited<ReturnType<typeof startBackend>>;
  dir: string;
  workspace: string;
  request(method: string, route: string, input?: unknown): Promise<{ status: number; body: any }>;
}

const setup = async (responder: (body: any) => MockCompletion, stream: { streamChunkChars?: number; streamDelayMs?: number } = {}, dir?: string): Promise<Env> => {
  const target = dir ?? mkdtempSync(path.join(root, 'work-identity-'));
  const workspace = path.join(target, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const backend = await startBackend({ dataDir: path.join(target, 'data'), projectRoot: process.cwd(),
    mockOptions: { ...stream, responder } });
  const request = async (method: string, route: string, input?: unknown) => {
    const response = await fetch('http://127.0.0.1:' + backend.port + '/v1/product' + route, {
      method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  return { backend, dir: target, workspace, request };
};

const createProject = async (env: Env): Promise<string> => {
  const created = await env.request('POST', '/workspace/projects', { path: env.workspace });
  assert.equal(created.status, 200, json(created.body));
  return created.body.id;
};

const sendWork = async (env: Env, text: string, projectId: string): Promise<string> => {
  const sent = await env.request('POST', '/chat/send', { mode: 'cowork', text, attachments: [], permission: 'ask', modelId: 'default', projectId });
  assert.equal(sent.status, 200, json(sent.body));
  return sent.body.sessionId;
};

const readEvents = async (env: Env, cursor: number, sessionId: string): Promise<EventPage> => {
  const page = await env.request('GET', '/events?cursor=' + cursor + '&limit=200&sessionId=' + encodeURIComponent(sessionId));
  assert.equal(page.status, 200, json(page.body));
  return page.body;
};

const assistantMessages = (entries: EventEntry[], sessionId: string): ChatMessage[] => entries.flatMap(entry =>
  entry.event.type === 'message.upsert' && entry.event.sessionId === sessionId && entry.event.message.role === 'assistant'
    ? [entry.event.message] : []);
const textOf = (message: ChatMessage): string => message.parts.map(part => part.kind === 'text' ? part.text : '').join('');

const poll = async (env: Env, sessionId: string, entries: EventEntry[], state: { cursor: number },
  predicate: () => boolean, label: string, timeoutMs = 40000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = await readEvents(env, state.cursor, sessionId);
    state.cursor = page.nextCursor;
    entries.push(...page.events);
    if (predicate()) return;
    if (Date.now() > deadline) assert.fail('Timed out waiting for ' + label);
    await sleep(25);
  }
};

const terminal = (entries: EventEntry[], sessionId: string) => assistantMessages(entries, sessionId).filter(message =>
  ['done', 'error', 'cancelled'].includes(message.status)).at(-1);

test('Work stream keeps one durable identity through partial, done, Kernel and restart', { timeout: 120000 }, async t => {
  const content = 'Work identity ' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(8);
  const responder = (body: any): MockCompletion => isReviewerCall(body) ? reviewPass('Identity fixture.') : { content };
  const env = await setup(responder, { streamChunkChars: 12, streamDelayMs: 60 });
  let active = env.backend;
  t.after(async () => { await active.close(); rmSync(env.dir, { recursive: true, force: true }); });
  const projectId = await createProject(env);
  const taskId = await sendWork(env, 'Stream one answer with a durable identity', projectId);
  const entries: EventEntry[] = [];
  const state = { cursor: 0 };
  // The mock main answer settles the turn without proposing completion, so the task may rest in a
  // waiting state; what this test pins is the stream identity and its terminal projection.
  const settledStates = new Set(['completed', 'failed', 'paused', 'cancelled', 'waiting_input', 'waiting_approval']);
  await poll(env, taskId, entries, state, () => {
    const task = env.backend.services.kernel.getTask(taskId);
    return Boolean(terminal(entries, taskId)) && Boolean(task && settledStates.has(task.status));
  }, 'settled Work stream');

  const messages = assistantMessages(entries, taskId);
  const streaming = messages.filter(message => message.status === 'streaming');
  const done = terminal(entries, taskId);
  assert.ok(streaming.length > 0, 'a non-empty partial must be observable before completion');
  assert.ok(streaming.every(message => message.id === done!.id), 'every partial must use the final identity');
  assert.equal(done!.status, 'done');
  assert.equal(textOf(done!), content);

  const kernelMessages = env.backend.services.kernel.getMessages(taskId);
  const kernelAssistant = kernelMessages.filter(message => message.role === 'assistant');
  assert.equal(kernelMessages.length, 2, 'the Kernel must persist exactly the user and one assistant message');
  assert.equal(kernelAssistant.length, 1);
  assert.equal(done!.id, kernelAssistant[0]!.id, 'the done event id must be the durable Kernel assistant id');
  const resolved = env.backend.services.kernel.getMessage(done!.id);
  assert.ok(resolved, 'kernel.getMessage(done.id) must resolve the canonical assistant message');
  assert.equal(resolved!.content, content);
  assert.equal(resolved!.createdAt, done!.createdAt, 'the projection and durable message must share createdAt');

  const detail = await env.request('GET', '/sessions/' + encodeURIComponent(taskId));
  const detailAssistant = detail.body.messages.filter((message: ChatMessage) => message.role === 'assistant');
  assert.equal(detail.body.messages.length, 2);
  assert.deepEqual(detailAssistant.map((message: ChatMessage) => message.id), [done!.id]);
  assert.equal(textOf(detailAssistant[0]!), content);

  // A restart must expose the same visible identity, not a regenerated one.
  await env.backend.close();
  const restarted = await setup(responder, { streamChunkChars: 12, streamDelayMs: 60 }, env.dir);
  active = restarted.backend;
  const afterRestart = await restarted.request('GET', '/sessions/' + encodeURIComponent(taskId));
  const restartedAssistant = afterRestart.body.messages.filter((message: ChatMessage) => message.role === 'assistant');
  assert.notEqual(afterRestart.body.status, 'streaming');
  assert.deepEqual(restartedAssistant.map((message: ChatMessage) => message.id), [done!.id]);
  assert.equal(restartedAssistant[0]!.createdAt, done!.createdAt);

  // Settled events are stable: no additional assistant bubble and no duplicate Kernel message.
  const settledCursor = state.cursor;
  await sleep(300);
  const settled = await readEvents(restarted, settledCursor, taskId);
  assert.equal(assistantMessages(settled.events, taskId).length, 0);
  assert.equal(restarted.backend.services.kernel.getMessages(taskId).length, 2);
});

test('A real provider failure ends as an error terminal, never as cancelled', { timeout: 60000 }, async t => {
  const env = await setup(() => ({ content: 'unused' }), {});
  t.after(async () => { await env.backend.close(); rmSync(env.dir, { recursive: true, force: true }); });
  await env.backend.mock.setFault('unauthorized');
  const projectId = await createProject(env);
  const taskId = await sendWork(env, 'Trigger a real provider failure', projectId);
  // Let the Kernel settle before the first product poll: this forces the projection through the
  // started -> diagnostic.error -> transitioned catch-up path (a fast 401 can be fully persisted
  // before any GET /events happens), which must still surface an error terminal.
  for (let i = 0; i < 400 && !['failed', 'cancelled'].includes(env.backend.services.kernel.getTask(taskId)!.status); i++) await sleep(25);
  const entries: EventEntry[] = [];
  const state = { cursor: 0 };
  await poll(env, taskId, entries, state, () => Boolean(terminal(entries, taskId)), 'error terminal bubble');
  assert.ok(['failed', 'cancelled'].includes(env.backend.services.kernel.getTask(taskId)!.status));
  const messages = assistantMessages(entries, taskId);
  const done = terminal(entries, taskId);
  assert.equal(env.backend.services.kernel.getTask(taskId)!.status, 'failed');
  assert.equal(done!.status, 'error', 'a provider failure must not be displayed as a cancel');
  assert.equal(done!.error?.code, 'unauthorized');
  assert.ok(done!.error!.message.length > 0);
  assert.equal(messages.some(message => message.status === 'streaming'), false, 'no bubble may stay streaming');
  const kernelMessages = env.backend.services.kernel.getMessages(taskId);
  assert.equal(kernelMessages.filter(message => message.role === 'assistant').length, 0);
  const detail = await env.request('GET', '/sessions/' + encodeURIComponent(taskId));
  assert.equal(detail.body.status, 'failed');
  assert.equal(detail.body.messages.filter((message: ChatMessage) => message.role === 'assistant').length, 0);
});

test('A genuine operator cancel ends as cancelled and keeps the streamed text', { timeout: 60000 }, async t => {
  const content = 'Cancelled Work identity ' + 'Z'.repeat(240);
  const env = await setup(() => ({ content }), { streamChunkChars: 6, streamDelayMs: 80 });
  t.after(async () => { await env.backend.close(); rmSync(env.dir, { recursive: true, force: true }); });
  const projectId = await createProject(env);
  const taskId = await sendWork(env, 'Cancel this Work stream', projectId);
  const entries: EventEntry[] = [];
  const state = { cursor: 0 };
  await poll(env, taskId, entries, state, () => assistantMessages(entries, taskId).some(message =>
    message.status === 'streaming' && textOf(message).length > 0), 'Work partial before cancel');
  const cancelled = await env.request('POST', '/chat/cancel', { sessionId: taskId });
  assert.equal(cancelled.status, 200, json(cancelled.body));
  await poll(env, taskId, entries, state, () => {
    const task = env.backend.services.kernel.getTask(taskId);
    return Boolean(terminal(entries, taskId)) && Boolean(task && ['paused', 'cancelled'].includes(task.status));
  }, 'cancelled Work stream');
  const messages = assistantMessages(entries, taskId);
  const done = terminal(entries, taskId);
  assert.equal(done!.status, 'cancelled');
  assert.equal(messages.at(-1)!.status, 'cancelled');
  assert.ok(messages.every(message => message.id === done!.id));
  assert.equal(env.backend.services.kernel.getMessages(taskId).filter(message => message.role === 'assistant').length, 0);
  const detail = await env.request('GET', '/sessions/' + encodeURIComponent(taskId));
  assert.notEqual(detail.body.status, 'streaming');
  assert.equal(detail.body.messages.filter((message: ChatMessage) => message.role === 'assistant').length, 0);
});

test('A dismissed Work session receives no late stream writes and no resurrected history', { timeout: 60000 }, async t => {
  const content = 'Dismissed Work identity ' + 'Q'.repeat(240);
  const env = await setup(() => ({ content }), { streamChunkChars: 6, streamDelayMs: 80 });
  t.after(async () => { await env.backend.close(); rmSync(env.dir, { recursive: true, force: true }); });
  const projectId = await createProject(env);
  const taskId = await sendWork(env, 'Dismiss this streaming Work session', projectId);
  const entries: EventEntry[] = [];
  const state = { cursor: 0 };
  await poll(env, taskId, entries, state, () => assistantMessages(entries, taskId).some(message =>
    message.status === 'streaming' && textOf(message).length > 0), 'Work partial before removal');
  const removed = await env.request('POST', '/sessions/' + encodeURIComponent(taskId) + '/remove');
  assert.equal(removed.status, 200, json(removed.body));
  const late: EventEntry[] = [];
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const page = await readEvents(env, state.cursor, taskId);
    state.cursor = page.nextCursor;
    late.push(...page.events);
    await sleep(40);
  }
  assert.equal(late.filter(entry => entry.event.type === 'message.upsert').length, 0, 'a dismissed Work session must not receive late message writes');
  const detail = await env.request('GET', '/sessions/' + encodeURIComponent(taskId));
  assert.equal(detail.status, 404);
  const kernelAssistant = env.backend.services.kernel.getMessages(taskId).filter(message => message.role === 'assistant');
  assert.equal(kernelAssistant.length, 0);
});