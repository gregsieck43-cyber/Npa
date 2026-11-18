/**
 * Work 流式切片契约测试（真实 HTTP + 真实 loopback mock SSE，不经 GUI/Electron/公网）。
 *
 * 覆盖 root 的 NPN-Gamma product-streaming 合同 C7–C10：
 *  - C7   Work 模型请求真实 stream:true；慢速 SSE 期间产品事件出现 >=1 个稳定 id 的
 *        status:'streaming' assistant 气泡，settle 后同一 id 只有一个 status:'done' 终态且文本完整；
 *        每轮恰好一个 assistant 气泡事件流（不得再额外发一次裸 Kernel-id 事件）；
 *        Kernel 仍只持久化 user + final assistant，流式投影绝不写入 Kernel；会话详情读回 Kernel 消息。
 *  - C8   settle 后反复轮询 /events 不得新增 assistant message.upsert、不得重复 provider 请求、
 *        不得重放 Kernel 消息或再次执行工具（workTrace.sync 幂等）。
 *  - C9   tool-only + permission 'ask'：approval.requested 出现前不执行工具、不发 follow-up 请求；
 *        批准一次（scope once）后工具恰好执行一次、follow-up 模型请求恰好一次、一个最终 assistant；
 *        产品层不新增 permission/grant；重复轮询不重复执行。
 *  - C10  Inspector request-scope 一次性提示词只进入下一次 Work 请求，之后不再出现；
 *        已记录的 request body/hash 与 Kernel 历史逐字节不变。
 *
 * 确定性约束：全部使用 startBackend + mockOptions（responder/trace/streamChunkChars/streamDelayMs），
 * 轮询以事件/状态为准并有超时上限；不 sleep 等待固定时长来猜结果；临时目录在 t.after 清理。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import type { MockCompletion, MockProviderOptions } from '../src/fixtures/mock-provider.js';
import type { ChatMessage, GatewayEvent } from '../src/frontend/api/types.js';

const root = path.resolve(process.env.TEMP ?? '.tmp');
const RUNNING_STATES = new Set(['queued', 'running', 'reconciling', 'waiting_children']);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const json = (value: unknown) => JSON.stringify(value);

const systemText = (body: any): string => (Array.isArray(body?.messages) ? body.messages : [])
  .filter((message: any) => message?.role === 'system' && typeof message.content === 'string')
  .map((message: any) => message.content as string)
  .join('\n');
const isReviewerCall = (body: any): boolean => systemText(body).includes('REVIEWER ROLE');
const isMainCall = (body: any): boolean => systemText(body).includes('MAIN ROLE');
const reviewPass = (reason: string): MockCompletion => ({ content: JSON.stringify({ verdict: 'pass', reason, findings: [] }) });
const textOf = (message: ChatMessage): string => message.parts.map(part => part.kind === 'text' ? part.text : '').join('');

interface EventEntry { id: number; event: GatewayEvent }
interface EventPage { events: EventEntry[]; nextCursor: number; earliest: number; reset: boolean }

interface Env {
  backend: Awaited<ReturnType<typeof startBackend>>;
  dir: string;
  workspace: string;
  wire: any[];
  request(method: string, route: string, input?: unknown): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

type Harness = NonNullable<Env['backend']['services']['harness']>;
/** 真实 startBackend 一定装配 Harness；这里显式收敛类型并断言存在，避免测试里散落非空断言。 */
const harnessOf = (env: Env): Harness => {
  const harness = env.backend.services.harness;
  assert.ok(harness, 'startBackend must assemble the harness');
  return harness;
};

/** 每个测试独立的 data/workspace 目录，全部位于本进程 TEMP（= .tmp/product-streaming/child-b）之下。 */
const setup = async (responder: (body: any) => MockCompletion, stream: Pick<MockProviderOptions, 'streamChunkChars' | 'streamDelayMs'> = {}): Promise<Env> => {
  const dir = mkdtempSync(path.join(root, 'work-stream-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const wire: any[] = [];
  const backend = await startBackend({
    dataDir: path.join(dir, 'data'),
    projectRoot: process.cwd(),
    mockOptions: { ...stream, responder, trace: (body: any) => { wire.push(body); } },
  });
  const request = async (method: string, route: string, input?: unknown) => {
    const response = await fetch('http://127.0.0.1:' + backend.port + '/v1/product' + route, {
      method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const close = async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); };
  return { backend, dir, workspace, wire, request, close };
};

const createProject = async (env: Env): Promise<string> => {
  const created = await env.request('POST', '/workspace/projects', { path: env.workspace });
  assert.equal(created.status, 200, json(created.body));
  return created.body.id as string;
};

const readEvents = async (env: Env, cursor: number, sessionId?: string): Promise<EventPage> => {
  const page = await env.request('GET', '/events?cursor=' + cursor + '&limit=200' + (sessionId ? '&sessionId=' + encodeURIComponent(sessionId) : ''));
  assert.equal(page.status, 200, json(page.body));
  return page.body as EventPage;
};

const assistantMessages = (entries: EventEntry[], sessionId: string): ChatMessage[] =>
  entries.flatMap(entry => entry.event.type === 'message.upsert' && entry.event.sessionId === sessionId && entry.event.message.role === 'assistant'
    ? [entry.event.message] : []);

/** 轮询产品事件直到 predicate 成立；每次读取都驱动 workTrace.sync（产品投影的真实入口）。 */
const pollEventsUntil = async (
  env: Env,
  sessionId: string,
  entries: EventEntry[],
  state: { cursor: number; maxId: number },
  predicate: () => boolean,
  label: string,
  timeoutMs = 40000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = await readEvents(env, state.cursor, sessionId);
    state.cursor = page.nextCursor;
    for (const entry of page.events) {
      assert.ok(entry.id > state.maxId, 'product event ids must increase monotonically');
      state.maxId = entry.id;
      entries.push(entry);
    }
    if (predicate()) return;
    if (Date.now() > deadline) assert.fail('Timed out waiting for ' + label);
    await sleep(25);
  }
};

const workRequests = (env: Env, taskId: string) =>
  harnessOf(env).store.listRequests({ taskId, limit: 100 }).requests.filter(record => record.kind === 'work');

/** 等待 Work 轮次 settle：Kernel 状态离开运行态、请求记账到账、assistant 消息已持久化。 */
const settleWork = async (env: Env, taskId: string, expectedWorkRequests: number): Promise<void> => {
  const deadline = Date.now() + 40000;
  for (;;) {
    const task = env.backend.services.kernel.getTask(taskId);
    assert.ok(task, 'the Work task must exist');
    if (['failed', 'cancelled'].includes(task.status)) assert.fail('the Work task settled as ' + task.status + ': ' + String(task.error ?? ''));
    const requests = workRequests(env, taskId).length;
    const assistants = env.backend.services.kernel.getMessages(taskId).filter(message => message.role === 'assistant').length;
    if (!RUNNING_STATES.has(task.status) && requests >= expectedWorkRequests && assistants >= expectedWorkRequests) return;
    if (Date.now() > deadline) assert.fail('the Work task did not settle turn ' + expectedWorkRequests + '; status=' + task.status + ' requests=' + requests + ' assistants=' + assistants);
    await sleep(30);
  }
};

test('Work streaming keeps one stable projection bubble while the Kernel stays authoritative (C7) and never replays it later (C8)', { timeout: 120000 }, async t => {
  // 3.9s provider stream (41 chunks x 60ms) so a partial bubble must be observable before completion.
  const content = 'Work streaming projection ' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(13);
  const env = await setup(
    body => isReviewerCall(body) ? reviewPass('Mock reviewer: Work stream fixture.') : { content },
    { streamChunkChars: 12, streamDelayMs: 60 },
  );
  t.after(() => env.close());
  const projectId = await createProject(env);
  const startedAt = Date.now();
  const sent = await env.request('POST', '/chat/send', {
    mode: 'cowork', text: 'Stream the Work answer', attachments: [], permission: 'ask', modelId: 'default', projectId,
  });
  assert.equal(sent.status, 200, json(sent.body));
  const taskId = sent.body.sessionId as string;

  const entries: EventEntry[] = [];
  const state = { cursor: 0, maxId: 0 };
  let firstStreaming: { kernelMessages: number; doneSeen: boolean; mainRequests: number } | undefined;
  await pollEventsUntil(env, taskId, entries, state, () => {
    const assistants = assistantMessages(entries, taskId);
    if (!firstStreaming) {
      const partial = assistants.find(message => message.status === 'streaming' && textOf(message).length > 0);
      if (partial) firstStreaming = {
        kernelMessages: env.backend.services.kernel.getMessages(taskId).length,
        doneSeen: assistants.some(message => message.status === 'done'),
        mainRequests: env.wire.filter(isMainCall).length,
      };
    }
    const task = env.backend.services.kernel.getTask(taskId)!;
    return assistants.some(message => message.status === 'done') && !RUNNING_STATES.has(task.status);
  }, 'the slow Work stream to settle');

  const assistant = assistantMessages(entries, taskId);
  const streaming = assistant.filter(message => message.status === 'streaming');
  assert.ok(streaming.length > 0, 'Product events expose no streaming Work assistant bubble even though the real provider stream was slow');
  assert.ok(firstStreaming, 'a streaming bubble must be observed before the stream settled');
  assert.equal(firstStreaming!.kernelMessages, 1, 'the first streaming bubble must precede the persisted assistant message (Kernel must hold only the user message then)');
  assert.equal(firstStreaming!.doneSeen, false, 'no done bubble may exist while the first streaming bubble is observed');
  assert.equal(firstStreaming!.mainRequests, 1, 'exactly one Work model request must be in flight for the round');

  const ids = [...new Set(assistant.map(message => message.id))];
  assert.equal(ids.length, 1, 'exactly one assistant bubble event stream may represent the Work round; got ' + ids.join(','));
  const projectionId = ids[0]!;
  const partialTexts = streaming.map(textOf);
  for (let index = 1; index < partialTexts.length; index += 1) {
    assert.ok(partialTexts[index]!.length >= partialTexts[index - 1]!.length, 'partial text must be non-decreasing');
    assert.ok(partialTexts[index]!.startsWith(partialTexts[index - 1]!), 'partial text must extend, never rewrite, the previous text');
  }
  assert.ok(partialTexts.some(text => text.length < content.length), 'at least one partial bubble must be a strict prefix of the final content');
  for (const text of partialTexts) assert.ok(content.startsWith(text), 'every partial bubble must be a prefix of the final content');
  const terminal = assistant.filter(message => message.status === 'done');
  assert.equal(terminal.length, 1, 'exactly one terminal done bubble is allowed for the round');
  assert.equal(textOf(terminal[0]!), content, 'the terminal bubble must carry the complete assistant content');
  assert.equal([...assistant].reverse().find(message => message.id === projectionId)!.status, 'done', 'the last bubble for the projection id must be done');
  assert.ok(assistant.slice(assistant.indexOf(terminal[0]!) + 1).every(message => message.status !== 'streaming'), 'no streaming bubble may follow done');

  const kernelMessages = env.backend.services.kernel.getMessages(taskId);
  assert.equal(kernelMessages.length, 2, 'Kernel must persist exactly user + final assistant; streaming projections must never be Kernel messages');
  assert.equal(kernelMessages[0]!.role, 'user');
  assert.equal(kernelMessages[0]!.content, 'Stream the Work answer');
  assert.equal(kernelMessages[1]!.role, 'assistant');
  assert.equal(kernelMessages[1]!.content, content, 'Kernel assistant content must equal the provider content');
  if (projectionId !== kernelMessages[1]!.id) assert.ok(!kernelMessages.some(message => message.id === projectionId), 'a synthetic projection id must never be persisted as a Kernel message id');

  const detail = await env.request('GET', '/sessions/' + encodeURIComponent(taskId));
  assert.equal(detail.status, 200, json(detail.body));
  assert.deepEqual(detail.body.messages.map((message: any) => message.id), kernelMessages.map(message => message.id), 'session detail must return the Kernel messages');
  assert.equal(textOf(detail.body.messages[1] as ChatMessage), content);

  const mainRequests = env.wire.filter(isMainCall);
  assert.equal(mainRequests.length, 1, 'exactly one provider request per Work model round');
  assert.equal(mainRequests[0]!.stream, true, 'the Work request body must really use stream:true');

  const settled = {
    assistant: assistantMessages(entries, taskId).length,
    kernel: env.backend.services.kernel.getMessages(taskId).length,
    main: env.wire.filter(isMainCall).length,
    intents: env.backend.services.kernel.intents(taskId).length,
  };
  for (let round = 0; round < 4; round += 1) {
    const page = await readEvents(env, state.cursor, taskId);
    state.cursor = page.nextCursor;
    for (const entry of page.events) {
      assert.ok(entry.id > state.maxId, 'product event ids must increase monotonically after settlement');
      state.maxId = entry.id;
      entries.push(entry);
    }
    await sleep(30);
  }
  assert.equal(assistantMessages(entries, taskId).length, settled.assistant, 'polling after settlement must not append new assistant message.upsert events');
  assert.equal(env.backend.services.kernel.getMessages(taskId).length, settled.kernel, 'polling must not re-import or duplicate Kernel messages');
  assert.equal(env.wire.filter(isMainCall).length, settled.main, 'polling must not repeat a provider request');
  assert.equal(env.backend.services.kernel.intents(taskId).length, settled.intents, 'polling must not re-execute a tool');

  t.diagnostic(json({
    elapsedMs: Date.now() - startedAt,
    streamingBubbles: streaming.length,
    maxPartialChars: Math.max(...partialTexts.map(text => text.length)),
    finalChars: content.length,
    mainRequests: mainRequests.length,
    providerRequestsTotal: env.wire.length,
    kernelMessages: kernelMessages.length,
    productEvents: entries.length,
    taskStatus: env.backend.services.kernel.getTask(taskId)!.status,
  }));
});

test('tool-only Work approval executes the write exactly once and adds no permission (C9)', { timeout: 120000 }, async t => {
  const followUp = 'The approved write is recorded.';
  const env = await setup(body => {
    if (isReviewerCall(body)) return reviewPass('Mock reviewer: approval fixture.');
    if (Array.isArray(body.messages) && body.messages.some((message: any) => message.role === 'tool')) return { content: followUp };
    return { content: '', toolCalls: [{ id: 'write-1', name: 'write_file', arguments: { path: 'streaming-approval.txt', content: 'approved once\n' } }] };
  });
  t.after(() => env.close());
  const projectId = await createProject(env);
  const startedAt = Date.now();
  const started = await env.request('POST', '/chat/send', {
    mode: 'cowork', text: 'Write the approval fixture file', attachments: [], permission: 'ask', modelId: 'default', projectId,
  });
  assert.equal(started.status, 200, json(started.body));
  const taskId = started.body.sessionId as string;
  const file = path.join(env.workspace, 'streaming-approval.txt');

  const entries: EventEntry[] = [];
  const state = { cursor: 0, maxId: 0 };
  let approval: any;
  const approvalDeadline = Date.now() + 40000;
  for (;;) {
    const page = await readEvents(env, state.cursor, taskId);
    state.cursor = page.nextCursor;
    for (const entry of page.events) {
      assert.ok(entry.id > state.maxId, 'product event ids must increase monotonically');
      state.maxId = entry.id;
      entries.push(entry);
    }
    const pending = await env.request('GET', '/approvals?sessionId=' + encodeURIComponent(taskId));
    assert.equal(pending.status, 200, json(pending.body));
    if (Array.isArray(pending.body) && pending.body.length) approval = pending.body[0];
    if (approval && entries.some(entry => entry.event.type === 'approval.requested')) break;
    if (Date.now() > approvalDeadline) assert.fail('the write_file approval request never appeared');
    await sleep(30);
  }

  const approvalEvents = entries.filter(entry => entry.event.type === 'approval.requested');
  assert.equal(approvalEvents.length, 1, 'exactly one approval.requested event for the tool-only round');
  assert.equal((approvalEvents[0]!.event as any).approval.sessionId, taskId);
  assert.equal((approvalEvents[0]!.event as any).approval.toolCallId, 'write-1');
  assert.equal(approval.toolCallId, 'write-1');
  assert.equal(approval.capability, 'write');
  assert.equal(existsSync(file), false, 'nothing may be executed before the operator decision');
  assert.equal(env.wire.filter(isMainCall).length, 1, 'no follow-up model request may happen before the decision');
  const beforeDecision = env.backend.services.kernel.getTask(taskId)!;
  assert.equal(beforeDecision.status, 'waiting_approval');
  assert.equal(env.backend.services.kernel.getMessages(taskId).some(message => message.role === 'tool'), false, 'no tool result may exist before the decision');
  const prepared = env.backend.services.kernel.intents(taskId);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0]!.state, 'prepared');
  assert.equal(prepared[0]!.authorization?.decision, 'ask');

  const decided = await env.request('POST', '/approvals/decide', { approvalId: approval.id, approved: true, scope: 'once' });
  assert.equal(decided.status, 200, json(decided.body));
  assert.equal(decided.body.resolved, true);

  await pollEventsUntil(env, taskId, entries, state, () => {
    const task = env.backend.services.kernel.getTask(taskId)!;
    const messages = env.backend.services.kernel.getMessages(taskId);
    return !RUNNING_STATES.has(task.status) && task.status !== 'waiting_approval'
      && env.wire.filter(isMainCall).length === 2
      && messages.filter(message => message.role === 'assistant' && !message.toolCalls?.length).length >= 1;
  }, 'the approved tool round to settle');

  const task = env.backend.services.kernel.getTask(taskId)!;
  assert.ok(['completed', 'waiting_input'].includes(task.status), 'the approved tool round must settle; got ' + task.status);
  assert.equal(readFileSync(file, 'utf8'), 'approved once\n', 'the approved write must happen exactly once with the exact content');
  const kernelMessages = env.backend.services.kernel.getMessages(taskId);
  const toolMessages = kernelMessages.filter(message => message.role === 'tool');
  assert.equal(toolMessages.length, 1, 'exactly one tool result Kernel message');
  assert.equal(toolMessages[0]!.toolCallId, 'write-1');
  const finalAssistant = kernelMessages.filter(message => message.role === 'assistant' && !message.toolCalls?.length);
  assert.equal(finalAssistant.length, 1, 'exactly one final assistant message');
  assert.equal(finalAssistant[0]!.content, followUp);
  const mainRequests = env.wire.filter(isMainCall);
  assert.equal(mainRequests.length, 2, 'exactly two Work model-round provider requests: initial and one follow-up');
  assert.ok(mainRequests.every(body => body.stream === true), 'both Work requests must use stream:true');
  assert.equal(env.wire.filter(body => !isMainCall(body) && !isReviewerCall(body)).length, 0, 'no extra provider dispatch may exist');
  assert.equal(env.backend.services.kernel.sessionGrants(taskId).length, 0, 'a once approval must not add a session grant');
  assert.equal(env.backend.services.kernel.permissionMode(taskId), 'ask', 'the product layer must not change the permission mode');
  const detail = await env.request('GET', '/sessions/' + encodeURIComponent(taskId));
  assert.equal(detail.status, 200, json(detail.body));
  assert.equal(detail.body.permission, 'ask');
  assert.equal(detail.body.messages.length, kernelMessages.length);

  const settled = {
    assistant: assistantMessages(entries, taskId).length,
    main: env.wire.filter(isMainCall).length,
    kernel: env.backend.services.kernel.getMessages(taskId).length,
    intents: env.backend.services.kernel.intents(taskId).length,
  };
  for (let round = 0; round < 4; round += 1) {
    const page = await readEvents(env, state.cursor, taskId);
    state.cursor = page.nextCursor;
    for (const entry of page.events) {
      assert.ok(entry.id > state.maxId, 'product event ids must increase monotonically after settlement');
      state.maxId = entry.id;
      entries.push(entry);
    }
    await sleep(30);
  }
  assert.equal(assistantMessages(entries, taskId).length, settled.assistant, 'polling must not append new assistant message.upsert events');
  assert.equal(env.wire.filter(isMainCall).length, settled.main, 'polling must not repeat the approved provider requests');
  assert.equal(env.backend.services.kernel.getMessages(taskId).length, settled.kernel, 'polling must not duplicate Kernel messages');
  assert.equal(env.backend.services.kernel.intents(taskId).length, settled.intents, 'polling must not re-execute the approved tool');
  assert.equal(readFileSync(file, 'utf8'), 'approved once\n');

  t.diagnostic(json({
    elapsedMs: Date.now() - startedAt,
    taskStatus: task.status,
    mainRequests: mainRequests.length,
    providerRequestsTotal: env.wire.length,
    kernelMessages: kernelMessages.length,
    toolMessages: toolMessages.length,
    intents: env.backend.services.kernel.intents(taskId).length,
  }));
});

test('a request-scope prompt edit reaches exactly the next Work request and leaves history byte-identical (C10)', { timeout: 120000 }, async t => {
  const marker = 'ONE-SHOT-WORK-MARKER-' + Date.now();
  const env = await setup(body => isReviewerCall(body) ? reviewPass('Mock reviewer: one-shot fixture.') : { content: 'Work response for the one-shot fixture.' });
  t.after(() => env.close());
  const projectId = await createProject(env);
  const startedAt = Date.now();
  const first = await env.request('POST', '/chat/send', { mode: 'cowork', text: 'First Work turn', attachments: [], permission: 'ask', modelId: 'default', projectId });
  assert.equal(first.status, 200, json(first.body));
  const taskId = first.body.sessionId as string;
  await settleWork(env, taskId, 1);

  const firstRequestId = workRequests(env, taskId)[0]!.id;
  const recorded = harnessOf(env).store.getRequest(firstRequestId);
  const recordedBody = JSON.stringify(recorded.body);
  const recordedHash = recorded.bodyHash;
  const kernelBefore = JSON.stringify(env.backend.services.kernel.getMessages(taskId));

  const saved = await env.request('POST', '/inspector/prompt', { sessionId: taskId, partId: 'request:systemPrompt', content: marker, scope: 'request' });
  assert.equal(saved.status, 200, json(saved.body));
  const afterEdit = harnessOf(env).store.getRequest(firstRequestId);
  assert.equal(JSON.stringify(afterEdit.body), recordedBody, 'a one-shot edit must not rewrite an already recorded request body');
  assert.equal(afterEdit.bodyHash, recordedHash, 'a one-shot edit must not change an already recorded request hash');
  assert.equal(JSON.stringify(env.backend.services.kernel.getMessages(taskId)), kernelBefore, 'a one-shot edit must not rewrite Kernel history');

  const second = await env.request('POST', '/chat/send', { sessionId: taskId, mode: 'cowork', text: 'Second Work turn', permission: 'ask', modelId: 'default' });
  assert.equal(second.status, 200, json(second.body));
  await settleWork(env, taskId, 2);
  const markerCount = (body: any) => systemText(body).split(marker).length - 1;
  const mainRequests = env.wire.filter(isMainCall);
  assert.equal(mainRequests.length, 2, 'the second Work turn must add exactly one model request');
  assert.equal(markerCount(mainRequests[0]), 0, 'the first Work request must not contain the one-shot marker');
  assert.equal(markerCount(mainRequests[1]), 1, 'the one-shot marker must apply to exactly the next Work request');

  const third = await env.request('POST', '/chat/send', { sessionId: taskId, mode: 'cowork', text: 'Third Work turn', permission: 'ask', modelId: 'default' });
  assert.equal(third.status, 200, json(third.body));
  await settleWork(env, taskId, 3);
  assert.equal(markerCount(env.wire.filter(isMainCall)[2]), 0, 'the one-shot marker must not leak into the following Work request');
  assert.equal(workRequests(env, taskId).length, 3, 'three Work turns must record exactly three Work requests');

  const finalRecord = harnessOf(env).store.getRequest(firstRequestId);
  assert.equal(JSON.stringify(finalRecord.body), recordedBody, 'recorded request bodies must stay byte-identical after later turns');
  assert.equal(finalRecord.bodyHash, recordedHash);
  assert.equal(env.backend.services.kernel.getMessages(taskId).length, 6, 'three Work turns must persist exactly three user + three assistant messages');

  t.diagnostic(json({
    elapsedMs: Date.now() - startedAt,
    markerChars: marker.length,
    workRequests: 3,
    providerRequestsTotal: env.wire.length,
    kernelMessages: 6,
  }));
});
