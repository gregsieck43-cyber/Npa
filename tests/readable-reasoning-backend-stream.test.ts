/**
 * Readable provider reasoning: Chat/Work stream -> separate MessagePart -> durable history/restart.
 *
 * Local loopback HTTP/SSE provider only (no real model, no public network). Pins the public product
 * and Harness behavior: pure-reasoning turns project as a reasoning part with no fabricated answer
 * text, the live bubble and the durable message share one id/createdAt, cancellation/failure never
 * become a completed answer, blank provider reasoning is treated as absent, and the existing 256 KiB
 * partial budget and 4 MB provider response cap still apply when reasoning is present.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Services } from '../src/app/services.js';
import { Harness } from '../src/harness/service.js';
import { ProductApi } from '../src/product/api.js';
import { listenLoopback } from '../src/app/loopback.js';

const root = path.resolve(process.env.TEMP ?? '.tmp');
mkdirSync(root, { recursive: true });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const json = (value: unknown) => JSON.stringify(value);

interface Completion { reasoning?: string; content?: string; chunkChars?: number; delayMs?: number; fault?: 'unauthorized' | 'truncated_stream'; }
interface ReasoningProvider { url: string; requests(): number; close(): Promise<void>; }

/** A streaming Chat-Completions stand-in that emits reasoning_content before content. */
async function startReasoningProvider(responder: (body: any) => Completion): Promise<ReasoningProvider> {
  let count = 0;
  const sockets = new Set<Socket>();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) { response.writeHead(404); response.end(); return; }
    count += 1;
    request.setEncoding('utf8');
    let text = '';
    for await (const chunk of request) text += String(chunk);
    let body: any;
    try { body = JSON.parse(text); } catch { response.writeHead(400); response.end(); return; }
    const completion = responder(body);
    if (completion.fault === 'unauthorized') { response.writeHead(401); response.end('Unauthorized'); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const event = (value: unknown) => response.write('data: ' + JSON.stringify(value) + '\r\n\r\n');
    const chunks = async (field: 'reasoning_content' | 'content', value: string | undefined) => {
      if (!value) return;
      const size = completion.chunkChars ?? 32;
      for (let offset = 0; offset < value.length; offset += size) {
        if (response.destroyed) return;
        event({ choices: [{ index: 0, delta: { [field]: value.slice(offset, offset + size) }, finish_reason: null }] });
        if (completion.delayMs) await sleep(completion.delayMs);
      }
    };
    await chunks('reasoning_content', completion.reasoning);
    await chunks('content', completion.content);
    event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    event({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
    if (completion.fault !== 'truncated_stream') response.write('data: [DONE]\r\n\r\n');
    response.end();
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const port = await listenLoopback(server);
  return { url: 'http://127.0.0.1:' + port + '/provider/v1', requests: () => count,
    close: () => new Promise<void>((resolve, reject) => { sockets.forEach(socket => socket.destroy()); server.close(error => error ? reject(error) : resolve()); }) };
}

interface Entry { id: number; event: any }
interface Feed { cursor: number; entries: Entry[] }

const reviewPass = () => ({ content: JSON.stringify({ verdict: 'pass', reason: 'Mock reviewer: recorded answer and effects evaluated.', findings: [] }) });

async function fixture(t: import('node:test').TestContext, responder: (body: any) => Completion) {
  const owned = mkdtempSync(path.join(root, 'readable-reasoning-stream-'));
  const sse = await startReasoningProvider(responder);
  const projectRoot = path.resolve('.');
  const open = (): Services => {
    const services = new Services(path.join(owned, 'data'), projectRoot, sse.url, projectRoot);
    services.harness = new Harness(services);
    services.product = new ProductApi(services);
    services.runner.start();
    return services;
  };
  let services = open();
  const route = (method: string, location: string, input?: unknown): Promise<any> =>
    services.product!.route(method, new URL('/v1/product' + location, 'http://127.0.0.1'), (input ?? {}) as Record<string, unknown>) as Promise<any>;
  const feed: Feed = { cursor: 0, entries: [] };
  const poll = async (): Promise<Feed> => {
    const page: any = await route('GET', '/events?cursor=' + feed.cursor + '&limit=200');
    feed.cursor = Number(page.nextCursor);
    feed.entries.push(...page.events);
    return feed;
  };
  const untilFeed = async (predicate: () => boolean, label: string, timeoutMs = 40000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await poll();
      if (predicate()) return;
      if (Date.now() > deadline) assert.fail('Timed out waiting for ' + label);
      await sleep(20);
    }
  };
  const waitFor = async (read: () => boolean, label: string, timeoutMs = 40000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (read()) return;
      if (Date.now() > deadline) assert.fail('Timed out waiting for ' + label);
      await sleep(25);
    }
  };
  const assistants = (sessionId: string) => feed.entries
    .filter(entry => entry.event?.type === 'message.upsert' && entry.event.sessionId === sessionId && entry.event.message?.role === 'assistant')
    .map(entry => entry.event.message);
  const partsOf = (message: any, kind: string) => (Array.isArray(message?.parts) ? message.parts : []).filter((part: any) => part.kind === kind);
  const close = async (): Promise<void> => {
    await services.stop();
    await services.external.close();
    await services.product?.close();
    services.harness!.close();
    services.integrations.close();
    services.kernel.close();
  };
  t.after(async () => {
    await close();
    await sse.close();
    assert.equal(path.dirname(owned), root);
    rmSync(owned, { recursive: true, force: true });
  });
  const restart = async (): Promise<void> => { await close(); services = open(); feed.cursor = 0; feed.entries.length = 0; };
  const chatSession = (title: string) => services.harness!.store.createSession({ title,
    capabilities: { web: false, tools: false, mcp: false, skills: false, projectInstructions: false } });
  const sendChat = (sessionId: string, content: string) => services.harness!.chat.send({ sessionId, content });
  return { owned, sse, get services() { return services; }, get harness() { return services.harness!; },
    route, feed, poll, untilFeed, waitFor, restart, assistants, partsOf, chatSession, sendChat };
}

const settleTask = async (f: Awaited<ReturnType<typeof fixture>>, taskId: string) => {
  await f.waitFor(() => {
    const task = f.services.kernel.getTask(taskId);
    return Boolean(task && !['queued', 'running', 'reconciling'].includes(task.status)
      && f.services.kernel.getMessages(taskId).some(message => message.role === 'assistant'));
  }, 'Work task to persist its assistant message');
  return f.services.kernel.getTask(taskId)!;
};

test('Chat streams reasoning as a separate part and keeps one durable identity across restart', { timeout: 60000 }, async t => {
  const reasoning = 'Read the visible question, then answer it without tools.';
  const content = 'Visible answer for the reasoning stream.';
  const f = await fixture(t, body => ({ reasoning, content, chunkChars: 8, delayMs: 12 }));
  const session = f.chatSession('reasoning chat');
  const started = await f.sendChat(session.id, 'Explain the readable reasoning contract.');
  assert.equal(started.status, 'running');
  await f.untilFeed(() => f.assistants(session.id).some((message: any) => message.status === 'done'), 'Chat reasoning terminal done');
  const messages = f.assistants(session.id);
  const streaming = messages.filter((message: any) => message.status === 'streaming');
  assert.ok(streaming.length > 0, 'a slow reasoning stream must produce live projections');
  const done = messages.filter((message: any) => message.status === 'done');
  assert.equal(done.length, 1, 'exactly one terminal done bubble for the turn');
  assert.equal(new Set(messages.map((message: any) => message.id)).size, 1, 'all projections share one message id');
  assert.equal(done[0].createdAt, streaming[0].createdAt, 'createdAt stays stable from the first projection');
  assert.equal(f.partsOf(done[0], 'reasoning')[0]?.text, reasoning);
  assert.equal(f.partsOf(done[0], 'text')[0]?.text, content);
  assert.equal(f.partsOf(done[0], 'text')[0]?.text.includes(reasoning), false, 'reasoning is never merged into the answer text');
  for (const partial of streaming) {
    assert.equal(partial.status, 'streaming');
    const live = f.partsOf(partial, 'reasoning')[0];
    if (live) assert.ok(reasoning.startsWith(live.text), 'live reasoning must be a prefix of the settled reasoning');
  }
  const stored = f.harness.store.messages(session.id).find(message => message.role === 'assistant');
  assert.equal(stored?.id, done[0].id);
  assert.equal(stored?.createdAt, done[0].createdAt);
  assert.equal(stored?.reasoningContent, reasoning);
  assert.equal(stored?.content, content);
  const detail: any = await f.route('GET', '/sessions/' + encodeURIComponent(session.id));
  const detailAssistant = detail.messages.find((message: any) => message.role === 'assistant');
  assert.equal(detailAssistant.id, stored?.id);
  await f.restart();
  const restored: any = await f.route('GET', '/sessions/' + encodeURIComponent(session.id));
  const restoredAssistant = restored.messages.find((message: any) => message.role === 'assistant');
  assert.equal(restoredAssistant.id, stored?.id);
  assert.equal(restoredAssistant.createdAt, stored?.createdAt);
  assert.equal(restoredAssistant.status, 'done');
  assert.equal(f.partsOf(restoredAssistant, 'reasoning')[0]?.text, reasoning);
  assert.equal(f.partsOf(restoredAssistant, 'text')[0]?.text, content);
});

test('a pure-reasoning Chat turn keeps a reasoning part and never fabricates answer text', { timeout: 60000 }, async t => {
  const reasoning = 'Reasoning only: the provider returned no answer text for this turn.';
  const f = await fixture(t, () => ({ reasoning, content: '', chunkChars: 6, delayMs: 10 }));
  const session = f.chatSession('reasoning only chat');
  await f.sendChat(session.id, 'Think without answering.');
  await f.untilFeed(() => f.assistants(session.id).some((message: any) => message.status === 'done'), 'pure reasoning terminal done');
  const done = f.assistants(session.id).filter((message: any) => message.status === 'done');
  assert.equal(done.length, 1);
  assert.deepEqual(done[0].parts.map((part: any) => part.kind), ['reasoning']);
  assert.equal(f.partsOf(done[0], 'reasoning')[0]?.text, reasoning);
  const stored = f.harness.store.messages(session.id).find(message => message.role === 'assistant');
  assert.equal(stored?.content, '');
  assert.equal(stored?.reasoningContent, reasoning);
  await f.restart();
  const detail: any = await f.route('GET', '/sessions/' + encodeURIComponent(session.id));
  const restored = detail.messages.find((message: any) => message.role === 'assistant');
  assert.deepEqual(restored.parts.map((part: any) => part.kind), ['reasoning']);
  assert.equal(restored.parts[0].text, reasoning);
});

test('blank provider reasoning is absent for Chat and Work instead of a failure or empty block', { timeout: 90000 }, async t => {
  const f = await fixture(t, body => {
    const system = (Array.isArray(body.messages) ? body.messages : []).filter((message: any) => message?.role === 'system').map((message: any) => String(message.content)).join('\n');
    if (system.includes('REVIEWER ROLE')) return reviewPass();
    return { reasoning: '   \n\t  ', content: 'Answer after blank thinking.', chunkChars: 6, delayMs: 5 };
  });
  const session = f.chatSession('blank reasoning chat');
  await f.sendChat(session.id, 'Answer despite blank provider thinking.');
  await f.untilFeed(() => f.assistants(session.id).some((message: any) => message.status === 'done'), 'blank reasoning Chat done');
  const chatDone = f.assistants(session.id).filter((message: any) => message.status === 'done');
  assert.equal(chatDone.length, 1);
  assert.equal(f.partsOf(chatDone[0], 'reasoning').length, 0, 'blank reasoning must not become a thinking block');
  assert.equal(f.partsOf(chatDone[0], 'text')[0]?.text, 'Answer after blank thinking.');
  const chatStored = f.harness.store.messages(session.id).find(message => message.role === 'assistant');
  assert.equal(chatStored?.reasoningContent, undefined);

  const sent: any = await f.route('POST', '/chat/send', { mode: 'cowork', text: 'Work answer despite blank provider thinking.', attachments: [], permission: 'ask', modelId: 'default' });
  assert.ok(sent.sessionId, json(sent));
  const taskId = sent.sessionId as string;
  const task = await settleTask(f, taskId);
  assert.notEqual(task.status, 'failed', 'legal blank provider reasoning must not fail the whole Work task: ' + String(task.error ?? ''));
  const assistant = f.services.kernel.getMessages(taskId).find(message => message.role === 'assistant');
  assert.ok(assistant, 'Work must persist its assistant answer');
  assert.equal(assistant.reasoningContent, undefined);
  assert.equal(assistant.content, 'Answer after blank thinking.');
  await f.untilFeed(() => f.assistants(taskId).some((message: any) => message.status === 'done'), 'blank reasoning Work done');
  const workDone = f.assistants(taskId).filter((message: any) => message.status === 'done');
  assert.equal(workDone.length, 1);
  assert.equal(f.partsOf(workDone[0], 'reasoning').length, 0);
  assert.equal(f.partsOf(workDone[0], 'text')[0]?.text, 'Answer after blank thinking.');
});

test('Work streams reasoning with a stable id/createdAt and persists it across restart', { timeout: 90000 }, async t => {
  const reasoning = 'Work planning: inspect the goal, then produce the complete answer.';
  const content = 'Work answer produced from the streamed reasoning.';
  const f = await fixture(t, body => {
    const system = (Array.isArray(body.messages) ? body.messages : []).filter((message: any) => message?.role === 'system').map((message: any) => String(message.content)).join('\n');
    return system.includes('REVIEWER ROLE') ? reviewPass() : { reasoning, content, chunkChars: 8, delayMs: 12 };
  });
  const sent: any = await f.route('POST', '/chat/send', { mode: 'cowork', text: 'Stream Work reasoning.', attachments: [], permission: 'ask', modelId: 'default' });
  assert.ok(sent.sessionId, json(sent));
  const taskId = sent.sessionId as string;
  await f.untilFeed(() => f.assistants(taskId).some((message: any) => message.status === 'streaming' && f.partsOf(message, 'reasoning').length > 0), 'Work reasoning live projection');
  const task = await settleTask(f, taskId);
  await f.untilFeed(() => f.assistants(taskId).some((message: any) => message.status === 'done'), 'Work reasoning terminal done');
  const messages = f.assistants(taskId);
  const done = messages.filter((message: any) => message.status === 'done');
  assert.equal(done.length, 1);
  const assistant = f.services.kernel.getMessages(taskId).find(message => message.role === 'assistant')!;
  assert.equal(assistant.reasoningContent, reasoning);
  assert.equal(assistant.content, content);
  assert.equal(done[0].id, assistant.id, 'the live Work bubble and the durable Kernel message share one id');
  assert.equal(done[0].createdAt, assistant.createdAt, 'createdAt stays stable into the durable Work message');
  assert.equal(f.partsOf(done[0], 'reasoning')[0]?.text, reasoning);
  assert.equal(f.partsOf(done[0], 'text')[0]?.text, content);
  assert.notEqual(task.status, 'failed');
  await f.restart();
  const detail: any = await f.route('GET', '/sessions/' + encodeURIComponent(taskId));
  const restored = detail.messages.find((message: any) => message.role === 'assistant');
  assert.equal(restored.id, assistant.id);
  assert.equal(restored.createdAt, assistant.createdAt);
  assert.equal(f.partsOf(restored, 'reasoning')[0]?.text, reasoning);
  assert.equal(f.partsOf(restored, 'text')[0]?.text, content);
});

test('cancelling a Chat reasoning stream ends cancelled with the received reasoning and no completed answer', { timeout: 60000 }, async t => {
  const reasoning = 'Cancelled reasoning must stay partial and honest. '.repeat(8);
  const f = await fixture(t, () => ({ reasoning, content: 'This answer must never be completed.', chunkChars: 4, delayMs: 25 }));
  const session = f.chatSession('cancel reasoning chat');
  const started = await f.sendChat(session.id, 'Cancel this reasoning stream.');
  assert.equal(started.status, 'running');
  await f.untilFeed(() => f.assistants(session.id).some((message: any) => message.status === 'streaming' && f.partsOf(message, 'reasoning').length > 0), 'Chat reasoning partial before cancel');
  await f.route('POST', '/chat/cancel', { sessionId: session.id });
  await f.untilFeed(() => f.assistants(session.id).some((message: any) => message.status === 'cancelled'), 'Chat reasoning cancelled terminal');
  const messages = f.assistants(session.id);
  assert.equal(messages.some((message: any) => message.status === 'done'), false, 'a cancelled turn must never be completed');
  const terminal = messages.filter((message: any) => message.status === 'cancelled').at(-1);
  const liveReasoning = f.partsOf(terminal, 'reasoning')[0]?.text ?? '';
  assert.ok(reasoning.startsWith(liveReasoning), 'the cancelled terminal keeps only the reasoning actually received');
  assert.equal(f.harness.store.messages(session.id).filter(message => message.role === 'assistant').length, 0);
});

test('a provider failure during a Chat reasoning stream ends as error, never done', { timeout: 60000 }, async t => {
  const f = await fixture(t, () => ({ fault: 'unauthorized' }));
  const session = f.chatSession('error reasoning chat');
  await f.sendChat(session.id, 'Fail this reasoning stream.');
  await f.untilFeed(() => f.assistants(session.id).some((message: any) => message.status === 'error'), 'Chat reasoning error terminal');
  const messages = f.assistants(session.id);
  assert.equal(messages.some((message: any) => message.status === 'done'), false);
  const error = messages.filter((message: any) => message.status === 'error').at(-1);
  assert.equal(error.error?.code, 'unauthorized');
  assert.equal(f.harness.store.messages(session.id).filter(message => message.role === 'assistant').length, 0);
});

test('a long reasoning stream stays inside the 256 KiB live partial budget while the terminal keeps everything', { timeout: 120000 }, async t => {
  const reasoning = 'r'.repeat(300_000);
  const f = await fixture(t, () => ({ reasoning, content: 'Bounded terminal answer.', chunkChars: 16384, delayMs: 30 }));
  const session = f.chatSession('partial budget chat');
  await f.sendChat(session.id, 'Stream a bounded reasoning trace.');
  await f.untilFeed(() => f.assistants(session.id).some((message: any) => message.status === 'done'), 'bounded reasoning terminal done');
  const messages = f.assistants(session.id);
  const streaming = messages.filter((message: any) => message.status === 'streaming');
  assert.ok(streaming.length > 0 && streaming.length < 4096, 'live partials stay bounded');
  for (const partial of streaming) {
    const live = f.partsOf(partial, 'reasoning')[0]?.text ?? '';
    assert.ok(live.length <= 256 * 1024, 'the Chat partial budget must count reasoning too');
  }
  const done = messages.filter((message: any) => message.status === 'done').at(-1);
  assert.equal(f.partsOf(done, 'reasoning')[0]?.text.length, 300_000, 'the terminal event owns the complete reasoning');
  const stored = f.harness.store.messages(session.id).find(message => message.role === 'assistant');
  assert.equal(stored?.reasoningContent?.length, 300_000);
});

test('the 4 MB provider transport cap rejects an oversized reasoning stream without a durable answer', { timeout: 150000 }, async t => {
  const f = await fixture(t, () => ({ reasoning: 'x'.repeat(4_050_000), content: '', chunkChars: 8192 }));
  const session = f.chatSession('4mb reasoning chat');
  await f.sendChat(session.id, 'Exceed the provider response cap.');
  await f.untilFeed(() => f.assistants(session.id).some((message: any) => message.status === 'error'), 'oversized reasoning error terminal');
  const messages = f.assistants(session.id);
  assert.equal(messages.some((message: any) => message.status === 'done'), false);
  const error = messages.filter((message: any) => message.status === 'error').at(-1);
  assert.equal(error.error?.code, 'invalid_response');
  assert.match(String(error.error?.message ?? ''), /exceeds the size limit/);
  assert.equal(f.harness.store.messages(session.id).filter(message => message.role === 'assistant').length, 0);
});

test('cancelling a Work reasoning stream ends the projection as cancelled, not done', { timeout: 90000 }, async t => {
  const reasoning = 'Work reasoning that will be interrupted. '.repeat(12);
  const f = await fixture(t, body => {
    const system = (Array.isArray(body.messages) ? body.messages : []).filter((message: any) => message?.role === 'system').map((message: any) => String(message.content)).join('\n');
    return system.includes('REVIEWER ROLE') ? reviewPass() : { reasoning, content: 'Interrupted Work answer.', chunkChars: 4, delayMs: 25 };
  });
  const sent: any = await f.route('POST', '/chat/send', { mode: 'cowork', text: 'Cancel this Work reasoning stream.', attachments: [], permission: 'ask', modelId: 'default' });
  assert.ok(sent.sessionId, json(sent));
  const taskId = sent.sessionId as string;
  await f.untilFeed(() => f.assistants(taskId).some((message: any) => message.status === 'streaming' && f.partsOf(message, 'reasoning').length > 0), 'Work reasoning partial before cancel');
  await f.route('POST', '/chat/cancel', { sessionId: taskId });
  await f.untilFeed(() => f.assistants(taskId).some((message: any) => message.status === 'cancelled'), 'Work reasoning cancelled terminal');
  const messages = f.assistants(taskId);
  assert.equal(messages.some((message: any) => message.status === 'done'), false, 'a paused/cancelled Work stream must not display as done');
  assert.equal(f.services.kernel.getMessages(taskId).filter(message => message.role === 'assistant').length, 0, 'an interrupted turn has no durable answer');
  const task = f.services.kernel.getTask(taskId)!;
  assert.ok(['paused', 'cancelled'].includes(task.status), 'operator cancel pauses or cancels the Work task; got ' + task.status);
});
