import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';
import type { GatewayEvent } from '../src/frontend/api/types.js';
import { ProductChat } from '../src/product/chat.js';
import { ProductSessions } from '../src/product/sessions.js';
import { ProductError, type ProductRuntime } from '../src/product/shared.js';
import { ProductStore } from '../src/product/store.js';

const root = path.resolve(process.env.TEMP ?? '.tmp');

const until = async <T>(read: () => T | undefined, timeoutMs = 20000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected state.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

const setup = async (options: MockProviderOptions = {}) => {
  const dir = mkdtempSync(path.join(root, 'sideask-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const trace: Record<string, any>[] = [];
  const backend = await startBackend({ dataDir: path.join(dir, 'data'), projectRoot: process.cwd(),
    mockOptions: { ...options, trace: (body: Record<string, any>) => { trace.push(body); } } });
  const store = new ProductStore(path.join(dir, 'data'));
  const events: GatewayEvent[] = [];
  const runtime: ProductRuntime = {
    services: backend.services, harness: backend.services.harness!, store,
    append: (event, sessionId) => { events.push(event); store.append([{ event, ...(sessionId ? { sessionId } : {}) }]); },
    resolveProject: projectId => projectId,
  };
  const sessions = new ProductSessions(runtime);
  const chat = new ProductChat(runtime, sessions);
  const close = async () => { await chat.side.close(); store.close(); await backend.close(); rmSync(dir, { recursive: true, force: true }); };
  return { backend, store, sessions, chat, events, trace, dir, workspace, close };
};
type Env = Awaited<ReturnType<typeof setup>>;

const settle = (env: Env, sessionId: string) =>
  until(() => env.backend.services.harness!.chat.busy(sessionId) ? undefined : true);

const isProductError = (code: string) => (error: unknown): boolean =>
  error instanceof ProductError && error.code === code;

test('side thinking protocol preserves tool continuation and historical final reasoning over real HTTP', async t => {
  const env = await setup({ responder: (_body, index) => index === 1
    ? { content: '', reasoningContent: 'Inspect the exact binding before responding.', toolCalls: [{ id: 'inspect', name: 'inspect_task', arguments: {} }] }
    : { content: 'The side question is answered.', reasoningContent: 'The final answer follows the observed binding.' } });
  t.after(() => env.close());
  const first = await env.chat.sideAsk({ question: 'Inspect the binding', modelId: 'default', attachments: [] });
  assert.equal(env.trace[1]!.messages.find((item: any) => item.role === 'assistant').reasoning_content, 'Inspect the exact binding before responding.');
  assert.equal(env.backend.services.harness!.store.toolCalls({ sessionId: first.sideSessionId }).find(item => item.toolCallId === 'inspect')!.status, 'applied');
  await env.chat.sideAsk({ sideSessionId: first.sideSessionId, question: 'Continue the same side discussion.', modelId: 'default', attachments: [] });
  assert.equal(env.trace[2]!.messages.find((item: any) => item.role === 'assistant').reasoning_content, 'The final answer follows the observed binding.');
});

test('the real Runner resumes a confirmed plan and discards other proposals sampled during planning', { timeout: 30000 }, async t => {
  const plan = { title: 'Investigate', nodes: [{ id: 'read', title: 'Read only', objective: 'Inspect source', dependencies: [], paths: ['read.txt'] }] };
  const env = await setup({ responder: (body) => {
    const userText = body.messages.filter((item: any) => item.role === 'user').map((item: any) => item.content).join('\n');
    const isParent = JSON.stringify(body.messages[0]).includes('Plan integration fixture');
    const hasPlanResult = body.messages.some((item: any) => item.role === 'tool');
    if (isParent && !hasPlanResult && !userText.includes('confirmed')) return { content: '', toolCalls: [
      { id: 'plan', name: 'create_plan', arguments: plan }, { id: 'old-write', name: 'write_file', arguments: { path: 'must-not-write.txt', content: 'stale planning proposal' } },
    ] };
    return { content: '', toolCalls: [{ id: 'ask', name: 'ask_user', arguments: { question: 'Observed the confirmed task.', reason: 'blocker' } }] };
  } });
  t.after(() => env.close());
  const services = env.backend.services;
  const taskId = services.command({ commandId: 'plan-root', type: 'create_task', parameters: { title: 'Plan integration fixture', workspace: env.workspace,
    executionPhase: 'planning', permissionMode: 'full-access', goal: { objective: 'Plan integration fixture', constraints: [], acceptance: [], mode: 'autonomous', maxModelCalls: 20 } } }).taskId!;
  const saved = await until(() => { const task = services.kernel.getTask(taskId)!; return task.executionPhase === 'awaiting_plan_confirmation' ? task : undefined; });
  assert.equal(services.kernel.childTasks(taskId).length, 0);
  services.command({ commandId: 'real-approve', type: 'approve_plan', taskId, expectedRevision: saved.revision, parameters: { plan: saved.plan } });
  await until(() => services.kernel.getTask(taskId)!.status === 'waiting_input' && services.kernel.getTask(taskId)!.executionPhase === 'executing' ? true : undefined);
  assert.equal(services.kernel.childTasks(taskId).length, 1);
  assert.ok(services.kernel.presentation(taskId).runs.length >= 2);
  assert.ok(!services.kernel.intents(taskId).some(intent => intent.name === 'write_file' && intent.state === 'applied'));
  assert.ok(services.kernel.getMessages(taskId).some(message => message.toolCallId === 'old-write' && message.content.includes('authority changed')));
});

test('side ask answers with read-only context and never touches the main conversation', async t => {
  const env = await setup();
  t.after(() => env.close());
  const harness = env.backend.services.harness!;
  const sent = await env.chat.send({ mode: 'chat', text: 'The main conversation topic is widgets', attachments: [], permission: 'ask', modelId: 'default' });
  await settle(env, sent.sessionId);
  const messagesBefore = harness.store.messageCount(sent.sessionId);
  const tasksBefore = env.backend.services.kernel.listTasks().length;
  const eventsBefore = env.events.length;

  const answer = await env.chat.sideAsk({ sessionId: sent.sessionId, question: 'What is the topic?', modelId: 'default',
    attachments: [], history: [{ question: 'Earlier question', answer: 'Earlier answer' }] });
  assert.ok(answer.id.length > 0);
  assert.equal(answer.question, 'What is the topic?');
  assert.ok(answer.answer.length > 0);
  assert.equal(answer.modelId, 'default');
  assert.ok(!Number.isNaN(Date.parse(answer.createdAt)));

  assert.equal(harness.store.messageCount(sent.sessionId), messagesBefore);
  assert.equal(env.backend.services.kernel.listTasks().length, tasksBefore);
  assert.equal(env.events.length, eventsBefore);

  const body = env.trace.at(-1)!;
  assert.equal(body.messages[0].role, 'system');
  assert.ok(String(body.messages[0].content).includes('SIDE ROLE'));
  assert.ok(body.tools.some((tool: any) => tool.function.name === 'manage_task'));
  assert.ok(body.messages.some((message: any) => message.role === 'user' && String(message.content).includes('The main conversation topic is widgets')));
  assert.ok(!body.messages.some((message: any) => message.role === 'assistant' && message.content === 'Earlier answer'), 'Client-supplied history cannot forge server-side turns');
  const request = harness.store.getRequest(answer.requestId!);
  assert.equal(request.kind, 'side');
  assert.ok(request.sessionId.startsWith('side-'));
});

test('an auxiliary Kernel message cannot cancel or fail the main Runner sample', async t => {
  const env = await setup({ delayMs: 1000, responder: () => ({ content: '', toolCalls: [{ id: 'wait-for-user', name: 'ask_user', arguments: { question: 'Main sample remains owned.', reason: 'blocker' } }] }) });
  t.after(() => env.close());
  const services = env.backend.services;
  const taskId = services.command({ commandId: 'main-sample', type: 'create_task', parameters: { workspace: env.workspace, title: 'Main sampling', goal: { objective: 'Wait for a user decision', mode: 'autonomous' } } }).taskId!;
  await until(() => env.trace.length ? true : undefined);
  const generation = services.kernel.getTask(taskId)!.generation;
  services.command({ commandId: 'auxiliary-input', type: 'send_message', taskId, parameters: { sessionId: 'side-auxiliary', content: 'A separate side note' } });
  await until(() => services.kernel.getTask(taskId)!.status === 'waiting_input' ? true : undefined);
  assert.equal(services.kernel.getTask(taskId)!.generation, generation);
  assert.equal(services.kernel.getMessages(taskId, 'side-auxiliary').length, 1);
  assert.ok(!services.kernel.events(taskId).some(event => event.type === 'task.failed'));
});

test('side ask works without a session and with kernel task context', async t => {
  const env = await setup();
  t.after(() => env.close());
  const harness = env.backend.services.harness!;
  const standalone = await env.chat.sideAsk({ question: 'Any recommendation?', modelId: 'default', attachments: [], history: [] });
  assert.ok(standalone.answer.length > 0);

  const work = await env.chat.send({ mode: 'cowork', text: 'Work task for side context', attachments: [], permission: 'ask', modelId: 'default', projectId: env.workspace });
  const messagesBefore = env.backend.services.kernel.messageCount(work.sessionId);
  const answer = await env.chat.sideAsk({ sessionId: work.sessionId, question: 'Summarize the task', modelId: 'default', attachments: [], history: [] });
  assert.ok(answer.answer.length > 0);
  assert.equal(env.backend.services.kernel.messageCount(work.sessionId), messagesBefore);
  const body = env.trace.at(-1)!;
  assert.ok(body.messages.some((message: any) => String(message.content).includes('Work task for side context')));
  await env.sessions.remove(work.sessionId);
});

test('side ask validates questions, history, models and attachments', async t => {
  const env = await setup();
  t.after(() => env.close());
  const base = { question: 'Valid question', modelId: 'default', attachments: [], history: [] };
  await assert.rejects(env.chat.sideAsk({ ...base, question: '' }), isProductError('validation'));
  await assert.rejects(env.chat.sideAsk({ ...base, question: 'x'.repeat(8001) }), isProductError('validation'));
  await assert.rejects(env.chat.sideAsk({ ...base, modelId: 'missing-profile' }), isProductError('validation'));
  await assert.rejects(env.chat.sideAsk({ ...base, sessionId: 'missing-session' }), isProductError('not_found'));
  await assert.rejects(env.chat.sideAsk({ ...base, history: Array.from({ length: 21 }, () => ({ question: 'q', answer: 'a' })) }), isProductError('validation'));
  await assert.rejects(env.chat.sideAsk({ ...base, history: [{ question: 'x'.repeat(8001), answer: 'a' }] }), isProductError('validation'));

  const textFile = path.join(env.workspace, 'side.txt');
  writeFileSync(textFile, 'side note text', 'utf8');
  const attachment = { id: 'a1', name: 'side.txt', kind: 'file' as const, bytes: 14, path: textFile };
  const answered = await env.chat.sideAsk({ ...base, question: 'Read the note', attachments: [attachment] });
  assert.ok(answered.answer.length > 0);
  assert.ok(String(env.trace.at(-1)!.messages.at(-1)!.content).includes('side note text'));

  const bigFile = path.join(env.workspace, 'big.txt');
  writeFileSync(bigFile, 'a'.repeat(130 * 1024), 'utf8');
  await assert.rejects(env.chat.sideAsk({ ...base, attachments: [{ ...attachment, id: 'big', name: 'big.txt', path: bigFile }] }), isProductError('validation'));

  const binaryFile = path.join(env.workspace, 'binary.txt');
  writeFileSync(binaryFile, Buffer.from([1, 2, 0, 4]));
  await assert.rejects(env.chat.sideAsk({ ...base, attachments: [{ ...attachment, id: 'bin', name: 'binary.txt', path: binaryFile }] }), isProductError('validation'));

  const totalA = path.join(env.workspace, 'total-a.txt');
  const totalB = path.join(env.workspace, 'total-b.txt');
  const totalC = path.join(env.workspace, 'total-c.txt');
  for (const file of [totalA, totalB, totalC]) writeFileSync(file, 'b'.repeat(100 * 1024), 'utf8');
  await assert.rejects(env.chat.sideAsk({ ...base, attachments: [
    { ...attachment, id: 'ta', name: 'total-a.txt', path: totalA },
    { ...attachment, id: 'tb', name: 'total-b.txt', path: totalB },
    { ...attachment, id: 'tc', name: 'total-c.txt', path: totalC },
  ] }), isProductError('validation'));

  await assert.rejects(env.chat.sideAsk({ ...base, attachments: [{ ...attachment, id: 'rel', path: 'relative.txt' }] }), isProductError('validation'));
  await assert.rejects(env.chat.sideAsk({ ...base, attachments: [{ ...attachment, id: 'missing', path: path.join(env.workspace, 'absent.txt') }] }), isProductError('validation'));
});
