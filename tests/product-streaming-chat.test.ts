/**
 * RED-first contract tests for the product Chat streaming slice (C1–C6 of the
 * product-streaming implementation contract). Everything runs over real HTTP
 * against a real backend and local HTTP SSE providers: no in-process
 * shortcut for the product routes, no public network.
 *
 * The tests are written to the contract, not to the current HEAD behaviour:
 * C1/C2/C3 fail until the partial projection, cancellation settlement and
 * error terminal events exist. C4/C5 exercise restart/removal recovery around
 * that projection; C6 is the cross-session isolation + SideAsk regression pin.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import { listenLoopback } from '../src/app/loopback.js';

const tempRoot = path.resolve(process.env.TEMP ?? '.tmp');
/** Deadlines remain bounded; C1/C6 release their streams after observing real partials. */
const PARTIAL_WAIT_MS = 7000;
const TERMINAL_WAIT_MS = 9000;

interface EventEntry { id: number; event: any }
interface Feed { cursor: number; entries: EventEntry[] }

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const until = async <T>(read: () => Promise<T | undefined> | T | undefined, what: string, timeoutMs: number): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + what + ' after ' + timeoutMs + ' ms.');
    await pause(20);
  }
};

interface SetupOptions {
  streamChunkChars?: number;
  streamDelayMs?: number;
  delayMs?: number;
  responder?: (body: any, index: number) => { content: string };
  fault?: string;
  gatedRequests?: 1 | 2;
  observeTruncatedFinish?: boolean;
}

/** Test-only HTTP provider: C1/C6 gate partials; C3 retains its original timed frames and observes real finish. */
const startGatedProvider = async (options: SetupOptions, trace: any[]) => {
  const sockets = new Set<import('node:net').Socket>();
  const requests: { frames: number; expectedFrames: number; ended: boolean; closed: boolean; release(): void;
    usageFrames: number; endCalled: boolean; doneSent: boolean; finishedAt?: number }[] = [];
  let recordFirstFinish!: (at: number) => void;
  const firstFinish = new Promise<number>(resolve => { recordFirstFinish = resolve; });
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/provider/v1/chat/completions') { response.writeHead(404); response.end(); return; }
      request.setEncoding('utf8');
      let raw = '';
      for await (const chunk of request) { raw += String(chunk); if (raw.length > 2_000_000) { response.writeHead(413); response.end(); return; } }
      const body = JSON.parse(raw);
      trace.push(body);
      const index = requests.length + 1;
      const content = options.responder!(body, index).content;
      const size = options.streamChunkChars!;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const state: typeof requests[number] = { frames: 0, expectedFrames: Math.ceil(content.length / size), ended: false, closed: false, release,
        usageFrames: 0, endCalled: false, doneSent: false };
      requests.push(state);
      response.once('close', () => { state.closed = true; release(); });
      response.once('finish', () => { state.ended = true; state.finishedAt = performance.now(); if (index === 1) recordFirstFinish(state.finishedAt); });
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const event = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\r\n\r\n`);
      for (let offset = 0; offset < content.length; offset += size) {
        if (response.destroyed) return;
        event({ choices: [{ index: 0, delta: { content: content.slice(offset, offset + size) }, finish_reason: offset + size >= content.length ? 'stop' : null }] });
        state.frames++;
        // Chat projects the preceding delta, so two real frames produce the first nonempty partial.
        if (state.frames === 2 && index <= options.gatedRequests!) await gate;
        if (options.observeTruncatedFinish && offset + size < content.length) await pause(options.streamDelayMs!);
      }
      event({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      state.usageFrames++;
      state.endCalled = true;
      if (options.observeTruncatedFinish) response.end();
      else { state.doneSent = true; response.end('data: [DONE]\r\n\r\n'); }
    })().catch(error => { response.destroy(error instanceof Error ? error : new Error('Gated provider failed')); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const port = await listenLoopback(server);
  return {
    url: `http://127.0.0.1:${port}/provider/v1`,
    count: () => requests.length,
    release(index: number) { assert.ok(requests[index - 1], 'only release an observed provider request'); requests[index - 1]!.release(); },
    stats: () => requests.map(({ frames, expectedFrames, ended, closed }) => ({ frames, expectedFrames, ended, closed })),
    firstFinish,
    completion: () => { const state = requests[0]; return state ? {
      frames: state.frames, expectedFrames: state.expectedFrames, usageFrames: state.usageFrames,
      endCalled: state.endCalled, doneSent: state.doneSent, ended: state.ended, closed: state.closed, finishedAt: state.finishedAt,
    } : undefined; },
    close: async () => {
      for (const state of requests) state.release();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
};

/** One isolated backend per test: own data directory, own mock provider, own event log. */
const setup = async (options: SetupOptions = {}) => {
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(path.join(tempRoot, 'product-streaming-chat-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const trace: any[] = [];
  const settings = {
    dataDir: path.join(dir, 'data'),
    projectRoot: process.cwd(),
    mockOptions: {
      ...(options.delayMs ? { delayMs: options.delayMs } : {}),
      ...(options.streamChunkChars ? { streamChunkChars: options.streamChunkChars } : {}),
      ...(options.streamDelayMs !== undefined ? { streamDelayMs: options.streamDelayMs } : {}),
      ...(options.responder ? { responder: options.responder } : {}),
      trace: (body: any) => { trace.push(body); },
    },
    ...(options.fault ? { mockFault: options.fault } : {}),
  };
  let backend = await startBackend(settings);
  const gated = options.gatedRequests || options.observeTruncatedFinish ? await startGatedProvider(options, trace) : undefined;
  // Only the test provider endpoint changes; Product, Chat, Requests and SSE parsing stay real.
  if (gated) backend.services.configuration.provider.baseUrl = gated.url;
  const current = () => backend;
  const request = async (method: string, route: string, input?: unknown, signal?: AbortSignal): Promise<{ status: number; body: any }> => {
    const response = await fetch('http://127.0.0.1:' + backend.port + route, {
      method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      ...(signal ? { signal } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const restart = async (): Promise<void> => { await backend.close(); backend = await startBackend(settings); };
  const close = async (retention?: { retain: boolean; metadata(): unknown }): Promise<void> => {
    if (!retention) {
      try { await backend.close(); }
      finally { await gated?.close(); rmSync(dir, { recursive: true, force: true }); }
      return;
    }
    let preserve = retention.retain;
    const capture = () => {
      try { writeFileSync(path.join(dir, 'c3-failure.json'), JSON.stringify(retention.metadata(), null, 2) + '\n', { flag: 'wx' }); }
      catch { /* Diagnostic reads/writes must never replace the original test or close error. */ }
    };
    if (preserve) capture();
    try { await backend.close(); }
    catch (error) { preserve = true; capture(); throw error; }
    finally {
      try { await gated?.close(); }
      catch (error) { preserve = true; capture(); throw error; }
      finally { if (!preserve) rmSync(dir, { recursive: true, force: true }); }
    }
  };
  return { current, dir, workspace, request, restart, close, trace, settings, gated };
};
type Env = Awaited<ReturnType<typeof setup>>;

const harnessOf = (env: Env) => {
  const harness = env.current().services.harness;
  assert.ok(harness, 'the backend must expose its initialized harness');
  return harness;
};

const lastUserText = (body: any): string => {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  return String([...messages].reverse().find(message => message?.role === 'user')?.content ?? '');
};

const textOf = (message: any): string => {
  const parts: any[] = Array.isArray(message?.parts) ? message.parts : [];
  return parts.filter(part => part?.kind === 'text').map(part => String(part.text ?? '')).join('');
};

const assistantMessages = (feed: Feed, sessionId: string): any[] => feed.entries
  .filter(entry => entry.event?.type === 'message.upsert' && entry.event.sessionId === sessionId && entry.event.message?.role === 'assistant')
  .map(entry => entry.event.message);

const pollFeed = async (env: Env, feed: Feed, signal?: AbortSignal): Promise<void> => {
  const value = await env.request('GET', '/v1/product/events?cursor=' + feed.cursor + '&limit=200', undefined, signal);
  assert.equal(value.status, 200, 'event polling must succeed: ' + JSON.stringify(value.body));
  assert.equal(value.body.reset, false, 'the bounded event cursor must not reset');
  for (const entry of value.body.events as EventEntry[]) feed.entries.push(entry);
  feed.cursor = Number(value.body.nextCursor);
};

const untilFeed = async <T>(env: Env, feed: Feed, pick: () => T | undefined, what: string, timeoutMs: number): Promise<T> =>
  until(async () => { await pollFeed(env, feed); return pick(); }, what, timeoutMs);

/** Keep collecting real partials while the provider runs. Only real HTTP finish starts the terminal window. */
const waitTruncatedTerminal = async (env: Env, feed: Feed, sessionId: string, signal: AbortSignal): Promise<void> => {
  const provider = env.gated!;
  const terminal = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
  const timeout = () => new Error('Timed out waiting for the terminal error projection event after ' + TERMINAL_WAIT_MS + ' ms from provider finish.');
  void provider.firstFinish.then(at => {
    if (stopped) return;
    timer = setTimeout(() => terminal.abort(timeout()), Math.max(0, at + TERMINAL_WAIT_MS - performance.now()));
  });
  const combined = AbortSignal.any([signal, terminal.signal]);
  try {
    for (;;) {
      combined.throwIfAborted();
      await pollFeed(env, feed, combined);
      const completion = provider.completion();
      if (completion?.closed && !completion.ended) throw new Error('Truncated fixture closed before a complete HTTP finish.');
      if (completion?.ended) {
        assert.equal(completion.frames, 40, 'the fixture must write every original content frame');
        assert.equal(completion.expectedFrames, 40);
        assert.equal(completion.usageFrames, 1);
        assert.equal(completion.endCalled, true);
        assert.equal(completion.doneSent, false, 'the fixture must omit DONE');
        assert.equal(typeof completion.finishedAt, 'number');
        if (performance.now() >= completion.finishedAt! + TERMINAL_WAIT_MS) throw timeout();
        const last = assistantMessages(feed, sessionId).at(-1);
        if (last?.status === 'error') return;
      }
      await pause(20);
    }
  } catch (error) {
    if (terminal.signal.aborted) throw terminal.signal.reason;
    throw error;
  } finally { stopped = true; clearTimeout(timer); }
};

interface C3State { phase: string; passed: boolean; sessionId?: string; error?: unknown }
const closeTruncatedFixture = (env: Env, feed: Feed, state: C3State, signal: AbortSignal): Promise<void> => env.close({
  retain: !state.passed || signal.aborted,
  metadata: () => {
    const error = state.error as { name?: string; code?: string } | undefined;
    let requests: unknown;
    try { requests = state.sessionId ? env.current().services.harness!.store.listRequests({ sessionId: state.sessionId, limit: 8 }).requests.map(request => ({
      id: request.id, status: request.status, code: request.error?.code, startedAt: request.startedAt, durationMs: request.durationMs,
    })) : []; } catch { requests = { unavailable: true }; }
    return { capturedAt: new Date().toISOString(), monotonicMs: performance.now(), phase: state.phase,
      error: { name: error?.name, code: error?.code }, aborted: signal.aborted, sessionId: state.sessionId,
      provider: env.gated?.completion(), providerRequests: env.gated?.count(), requests,
      feed: { cursor: feed.cursor, count: feed.entries.length, tail: feed.entries.slice(-16).map(entry => ({
        id: entry.id, type: entry.event?.type, role: entry.event?.message?.role, status: entry.event?.message?.status,
        requestId: entry.event?.message?.requestId, code: entry.event?.message?.error?.code,
      })) } };
  },
});

/** Bounded trailing read: captures any event appended immediately after settlement. */
const drain = async (env: Env, feed: Feed, rounds = 4): Promise<void> => {
  for (let index = 0; index < rounds; index++) { await pause(40); await pollFeed(env, feed); }
};

const sendChat = async (env: Env, text: string, sessionId?: string) => {
  const sent = await env.request('POST', '/v1/product/chat/send', {
    mode: 'chat', text, attachments: [], permission: 'ask', modelId: 'default', ...(sessionId ? { sessionId } : {}),
  });
  assert.equal(sent.status, 200, 'chat send must succeed: ' + JSON.stringify(sent.body));
  assert.ok(typeof sent.body.sessionId === 'string' && sent.body.sessionId, 'chat send must return a session id');
  return sent.body as { sessionId: string; messageId: string };
};

const detail = async (env: Env, sessionId: string): Promise<any> => {
  const value = await env.request('GET', '/v1/product/sessions/' + encodeURIComponent(sessionId));
  assert.equal(value.status, 200, 'session detail must be readable: ' + JSON.stringify(value.body));
  return value.body;
};

const waitInactive = (env: Env, sessionId: string, timeoutMs = 10000): Promise<boolean> =>
  until(() => harnessOf(env).chat.activeRequestId(sessionId) === undefined ? true : undefined,
    'the chat request of ' + sessionId + ' to settle', timeoutMs);

test('C1 partial projection: one stable id, monotone prefixes, final done, no per-delta history', { timeout: 60000 }, async t => {
  // All 200 content frames remain real SSE; the test controls when the stream may finish.
  const finalText = 'ABCDE'.repeat(80);
  const userText = 'Stream the product projection';
  const env = await setup({ streamChunkChars: 2, gatedRequests: 1, responder: () => ({ content: finalText }) });
  t.after(() => env.close());
  const feed: Feed = { cursor: 0, entries: [] };

  const sent = await sendChat(env, userText);
  const sessionId = sent.sessionId;

  const firstPartial = await untilFeed(env, feed, () => {
    const partial = assistantMessages(feed, sessionId).find(message => message.status === 'streaming' && textOf(message).length > 0);
    return partial && textOf(partial).length < finalText.length ? partial : undefined;
  }, 'the first non-empty streaming partial event', PARTIAL_WAIT_MS);
  assert.ok(textOf(firstPartial).length > 0, 'the first partial must carry projected text');
  assert.ok(harnessOf(env).chat.activeRequestId(sessionId), 'the partial must be observed while the provider stream is still active');
  // Durable history stays the user turn only; latest detail also carries the current live projection.
  assert.equal(harnessOf(env).store.messagePage(sessionId, 100).messages.length, 1, 'streaming must not persist per-delta history rows');
  const during = await detail(env, sessionId);
  assert.equal(during.messages.length, 2, 'latest detail includes the user and one real streaming message');
  assert.equal(during.messages[0].role, 'user');
  assert.equal(during.messages[1].id, firstPartial.id);
  assert.equal(during.messages[1].status, 'streaming');

  assert.deepEqual(env.gated!.stats(), [{ frames: 2, expectedFrames: 200, ended: false, closed: false }]);
  env.gated!.release(1);

  await untilFeed(env, feed, () => assistantMessages(feed, sessionId).find(message => message.status === 'done'),
    'the terminal done assistant event', TERMINAL_WAIT_MS);
  await waitInactive(env, sessionId);
  await drain(env, feed);

  const messages = assistantMessages(feed, sessionId);
  assert.ok(messages.length >= 2, 'at least one partial and one terminal event must be projected');
  const ids = new Set(messages.map(message => message.id));
  assert.equal(ids.size, 1, 'every partial and the final event of one request must share one stable assistant id');
  const last = messages.at(-1);
  assert.equal(last.status, 'done', 'the last assistant event must be terminal done');
  assert.equal(textOf(last), finalText, 'the terminal event must carry the complete assistant content');
  assert.equal(textOf(last).length, finalText.length);
  assert.equal(typeof last.createdAt, 'string');

  let previousLength = 0;
  for (const message of messages) {
    const text = textOf(message);
    assert.ok(text.length >= previousLength, 'projected text must be non-decreasing');
    assert.ok(finalText.startsWith(text), 'every projected text must be a prefix of the final content');
    if (message !== last) {
      assert.equal(message.status, 'streaming', 'every event before the terminal one must be streaming');
      assert.ok(text.length > 0 && text.length < finalText.length, 'a non-terminal partial must be a strict, non-empty prefix');
      assert.equal(typeof message.requestId, 'string');
    }
    previousLength = text.length;
  }
  const requestIds = new Set(messages.filter(message => message !== last).map(message => message.requestId));
  assert.equal(requestIds.size, 1, 'all partials of one request must carry the same requestId');
  // Bounds: the observed partial stream stays far inside the per-request budget.
  const partials = messages.filter(message => message !== last);
  assert.ok(partials.length <= 64, 'a 200-frame stream must not project one partial per delta');
  const projected = partials.reduce((sum, message) => sum + textOf(message).length, 0);
  assert.ok(projected <= 256 * 1024, 'projected partial text must stay under the per-request budget');

  // No other assistant message id represents this request.
  for (const entry of feed.entries) {
    if (entry.event?.type === 'message.upsert' && entry.event.message?.role === 'assistant') assert.equal(entry.event.sessionId, sessionId);
  }

  const settled = await detail(env, sessionId);
  assert.equal(settled.status, 'idle');
  assert.equal(settled.messages.length, 2, 'exactly one user and one assistant message must be persisted');
  assert.equal(settled.messages[1].role, 'assistant');
  assert.equal(textOf(settled.messages[1]), finalText);
  assert.equal(settled.messages[1].status, 'done');
  assert.equal(typeof settled.messages[1].requestId, 'string');
  assert.equal(settled.messages[1].requestId, [...requestIds][0], 'the persisted assistant message must belong to the projected request');

  // Exactly one provider dispatch, really streaming.
  assert.equal(env.gated!.count(), 1, 'one chat turn must dispatch exactly one provider request');
  assert.deepEqual(env.gated!.stats(), [{ frames: 200, expectedFrames: 200, ended: true, closed: true }]);
  t.diagnostic('C1 provider frames: ' + JSON.stringify(env.gated!.stats()));
  assert.equal(env.current().mock.requests(), 0, 'the private provider must own the actual HTTP dispatch');
  assert.equal(env.trace.length, 1, 'no duplicated provider dispatch');
  assert.equal(env.trace[0].stream, true, 'the chat request body must use stream:true');
});

test('C2 cancel settles the projection as cancelled, persists nothing and never resumes', { timeout: 60000 }, async t => {
  const finalText = 'K'.repeat(600);
  const env = await setup({ streamChunkChars: 2, streamDelayMs: 20, responder: () => ({ content: finalText }) });
  t.after(() => env.close());
  const feed: Feed = { cursor: 0, entries: [] };

  const sent = await sendChat(env, 'Cancel this slow streaming answer');
  const sessionId = sent.sessionId;
  await untilFeed(env, feed, () => assistantMessages(feed, sessionId).find(message => message.status === 'streaming' && textOf(message).length > 0),
    'a streaming partial before cancellation', PARTIAL_WAIT_MS);
  assert.ok(harnessOf(env).chat.activeRequestId(sessionId), 'the cancellation must happen while the request is active');

  const cancelled = await env.request('POST', '/v1/product/chat/cancel', { sessionId });
  assert.equal(cancelled.status, 200, 'cancel must answer 200: ' + JSON.stringify(cancelled.body));
  assert.deepEqual(cancelled.body, { cancelled: true });
  await waitInactive(env, sessionId);
  await untilFeed(env, feed, () => {
    const last = assistantMessages(feed, sessionId).at(-1);
    return last && last.status === 'cancelled' ? last : undefined;
  }, 'the terminal cancelled projection event', TERMINAL_WAIT_MS);
  await drain(env, feed);

  const messages = assistantMessages(feed, sessionId);
  assert.ok(messages.length >= 2, 'a cancelled request must expose its partials plus the terminal event');
  assert.equal(new Set(messages.map(message => message.id)).size, 1, 'cancel must keep the stable projection id');
  assert.equal(messages.at(-1)!.status, 'cancelled', 'the last event for the projection id must be cancelled');
  assert.ok(!messages.some(message => message.status === 'done'), 'a cancelled request must never project done');
  assert.ok(messages.some(message => message.status === 'streaming' && textOf(message).length > 0), 'the cancelled request must have streamed first');

  const settled = await detail(env, sessionId);
  assert.equal(settled.status, 'idle', 'a cancelled chat session must settle to idle');
  assert.equal(settled.messages.length, 1, 'a cancelled request must not persist an assistant message');
  assert.equal(settled.messages[0].role, 'user');
  assert.equal(harnessOf(env).chat.activeRequestId(sessionId), undefined);

  const again = await env.request('POST', '/v1/product/chat/cancel', { sessionId });
  assert.equal(again.status, 200, 'cancel must be idempotent');
  assert.deepEqual(again.body, { cancelled: true });
  const before = assistantMessages(feed, sessionId).length;
  await pause(250);
  await pollFeed(env, feed);
  assert.equal(assistantMessages(feed, sessionId).length, before, 'a second cancel must not resume streaming');
  assert.equal(harnessOf(env).chat.activeRequestId(sessionId), undefined);
  assert.equal((await detail(env, sessionId)).messages.length, 1);
});

test('C3 a real truncated provider stream ends the projection in error without persisting', { timeout: 60000 }, async t => {
  const finalText = 'E'.repeat(160);
  const env = await setup({ fault: 'truncated_stream', observeTruncatedFinish: true, streamChunkChars: 4, streamDelayMs: 20, responder: () => ({ content: finalText }) });
  const feed: Feed = { cursor: 0, entries: [] };
  const state: C3State = { phase: 'send', passed: false };
  t.after(() => closeTruncatedFixture(env, feed, state, t.signal));
  try {
  const sent = await sendChat(env, 'This provider stream will be truncated');
  const sessionId = sent.sessionId;
  state.sessionId = sessionId; state.phase = 'provider-and-terminal';
  await waitTruncatedTerminal(env, feed, sessionId, t.signal);
  state.phase = 'settlement';
  await waitInactive(env, sessionId);
  await drain(env, feed);

  const messages = assistantMessages(feed, sessionId);
  assert.ok(messages.length >= 2, 'the failed request must expose its partials plus the terminal event');
  assert.equal(new Set(messages.map(message => message.id)).size, 1, 'an error must keep the stable projection id');
  const last = messages.at(-1);
  assert.equal(last.status, 'error', 'a truncated provider stream must project a terminal error');
  assert.ok(!messages.some(message => message.status === 'done'), 'a failed request must never project done');
  assert.ok(messages.some(message => message.status === 'streaming' && textOf(message).length > 0), 'the failure must happen mid-stream');
  assert.equal(last.error?.code, 'truncated_stream', 'the error terminal event must carry the provider failure code');
  assert.ok(typeof last.error?.message === 'string' && last.error.message.length > 0, 'the error terminal event must carry a message');

  const settled = await detail(env, sessionId);
  assert.equal(settled.status, 'idle', 'a failed chat session must settle to idle');
  assert.equal(settled.messages.length, 1, 'a failed request must not persist an assistant message');
  assert.equal(settled.messages[0].role, 'user');

  state.phase = 'inspector';
  const failed = await until(async () => {
    const response = await env.request('GET', '/v1/product/inspector/requests?sessionId=' + encodeURIComponent(sessionId));
    if (response.status !== 200) return undefined;
    const records: any[] = Array.isArray(response.body) ? response.body : [];
    const chatRequest = records.find(record => record.kind === 'chat');
    return chatRequest && chatRequest.status === 'failed' ? chatRequest : undefined;
  }, 'the failed request record in the inspector', 5000);
  assert.equal(failed.error?.code, 'truncated_stream');
  assert.equal(env.gated!.count(), 1, 'a real failure must not dispatch a duplicate provider request');
  assert.equal(env.current().mock.requests(), 0, 'C3 uses only its observed HTTP provider');
  state.phase = 'passed'; state.passed = true;
  } catch (error) { state.error = error; throw error; }
});

test('C4 a restart mid-stream settles the session and the next turn completes with one assistant', { timeout: 60000 }, async t => {
  const answer = (text: string): string => 'Replied: ' + text + '|' + 'R'.repeat(360);
  const firstText = 'First turn before restart';
  const secondText = 'Second turn after restart';
  const env = await setup({ streamChunkChars: 4, streamDelayMs: 20, responder: body => ({ content: answer(lastUserText(body)) }) });
  t.after(() => env.close());
  const feed: Feed = { cursor: 0, entries: [] };

  const sent = await sendChat(env, firstText);
  const sessionId = sent.sessionId;
  await untilFeed(env, feed, () => assistantMessages(feed, sessionId).find(message => message.status === 'streaming' && textOf(message).length > 0),
    'a streaming partial before the restart', PARTIAL_WAIT_MS);
  assert.ok(harnessOf(env).chat.activeRequestId(sessionId), 'the restart must happen while the request is active');

  await env.restart();
  const afterRestart = await detail(env, sessionId);
  assert.equal(afterRestart.status, 'idle', 'a restart must not leave the session streaming');
  assert.equal(afterRestart.messages.length, 1, 'a restart must not persist an assistant message');
  assert.equal(afterRestart.messages[0].role, 'user');
  assert.equal(textOf(afterRestart.messages[0]), firstText);
  assert.equal(harnessOf(env).chat.activeRequestId(sessionId), undefined);

  const feed2: Feed = { cursor: 0, entries: [] };
  const second = await sendChat(env, secondText, sessionId);
  assert.equal(second.sessionId, sessionId);
  await untilFeed(env, feed2, () => assistantMessages(feed2, sessionId).find(message => message.status === 'done'),
    'the post-restart turn to finish', TERMINAL_WAIT_MS);
  await waitInactive(env, sessionId);
  await drain(env, feed2);

  const finished = await detail(env, sessionId);
  const assistants = finished.messages.filter((message: any) => message.role === 'assistant');
  assert.equal(assistants.length, 1, 'the post-restart turn must persist exactly one assistant message');
  assert.equal(textOf(assistants[0]), answer(secondText));
  assert.equal(finished.messages.length, 3, 'the two user turns plus the single assistant turn');
  assert.equal(env.current().mock.requests(), 1, 'the restarted backend must dispatch the new turn once');
});

test('C5 removing a streaming chat cancels the projection and no later event carries the session id', { timeout: 60000 }, async t => {
  const finalText = 'D'.repeat(600);
  const env = await setup({ streamChunkChars: 2, streamDelayMs: 20, responder: () => ({ content: finalText }) });
  t.after(() => env.close());
  const feed: Feed = { cursor: 0, entries: [] };

  const sent = await sendChat(env, 'Delete this streaming conversation');
  const sessionId = sent.sessionId;
  await untilFeed(env, feed, () => assistantMessages(feed, sessionId).find(message => message.status === 'streaming' && textOf(message).length > 0),
    'a streaming partial before removal', PARTIAL_WAIT_MS);

  const removed = await env.request('POST', '/v1/product/sessions/' + encodeURIComponent(sessionId) + '/remove');
  assert.equal(removed.status, 200, 'removing a streaming chat must succeed: ' + JSON.stringify(removed.body));
  assert.deepEqual(removed.body, { removed: true });
  assert.equal((await env.request('GET', '/v1/product/sessions/' + encodeURIComponent(sessionId))).status, 404);

  const removalIndex = await untilFeed(env, feed, () => {
    const index = feed.entries.findIndex(entry => entry.event?.type === 'session.removed' && entry.event.sessionId === sessionId);
    return index >= 0 ? index : undefined;
  }, 'the session.removed event', TERMINAL_WAIT_MS);
  for (let round = 0; round < 10; round++) { await pause(50); await pollFeed(env, feed); }
  const lateWrites = feed.entries.slice(removalIndex + 1).filter(entry => JSON.stringify(entry.event).includes(sessionId));
  assert.deepEqual(lateWrites, [], 'no product event after removal may carry the removed session id');

  assert.equal((await env.request('GET', '/v1/product/sessions/' + encodeURIComponent(sessionId))).status, 404, 'a late write must not resurrect the removed session');
  assert.throws(() => harnessOf(env).store.getSession(sessionId), /Chat session not found/);
  const listed = await env.request('GET', '/v1/product/sessions?limit=100');
  assert.ok(!(listed.body.items as any[]).some(item => item.id === sessionId), 'the removed session must stay out of the list');
});

test('C6 concurrent chats stay isolated and SideAsk never mutates the conversation', { timeout: 60000 }, async t => {
  const alpha = 'ALPHA:' + 'A'.repeat(300);
  const bravo = 'BRAVO:' + 'B'.repeat(300);
  const env = await setup({
    streamChunkChars: 4, gatedRequests: 2,
    responder: body => ({ content: lastUserText(body).includes('ALPHA') ? alpha : bravo }),
  });
  t.after(() => env.close());
  const feed: Feed = { cursor: 0, entries: [] };

  const [first, second] = await Promise.all([sendChat(env, 'ALPHA concurrent question'), sendChat(env, 'BRAVO concurrent question')]);
  const sessionA = first.sessionId;
  const sessionB = second.sessionId;
  assert.notEqual(sessionA, sessionB, 'the two concurrent chats must be different sessions');

  await untilFeed(env, feed, () => [sessionA, sessionB].every(sessionId => assistantMessages(feed, sessionId)
    .some(message => message.status === 'streaming' && textOf(message).length > 0)) ? true : undefined,
  'both concurrent chats to project a real partial', PARTIAL_WAIT_MS);
  assert.ok(harnessOf(env).chat.activeRequestId(sessionA));
  assert.ok(harnessOf(env).chat.activeRequestId(sessionB), 'both provider requests must remain active before either gate opens');
  assert.deepEqual(env.gated!.stats(), [1, 2].map(() => ({ frames: 2, expectedFrames: 77, ended: false, closed: false })));
  env.gated!.release(1);
  env.gated!.release(2);

  await untilFeed(env, feed, () => {
    const doneA = assistantMessages(feed, sessionA).find(message => message.status === 'done');
    const doneB = assistantMessages(feed, sessionB).find(message => message.status === 'done');
    return doneA && doneB ? true : undefined;
  }, 'both concurrent chats to finish', TERMINAL_WAIT_MS);
  await waitInactive(env, sessionA);
  await waitInactive(env, sessionB);
  await drain(env, feed);

  for (const [sessionId, expected] of [[sessionA, alpha], [sessionB, bravo]] as [string, string][]) {
    const messages = assistantMessages(feed, sessionId);
    assert.ok(messages.some(message => message.status === 'streaming' && textOf(message).length > 0), 'each concurrent chat must project streaming partials');
    assert.equal(new Set(messages.map(message => message.id)).size, 1, 'each chat must keep its own stable projection id');
    assert.equal(messages.at(-1)!.status, 'done');
    assert.equal(textOf(messages.at(-1)!), expected, 'each chat must finish with its own complete content');
    for (const message of messages) assert.ok(expected.startsWith(textOf(message)), 'an event for a session must carry only that session text');
  }

  // Cross-contamination check over every assistant event of the run.
  for (const entry of feed.entries) {
    if (entry.event?.type !== 'message.upsert' || entry.event.message?.role !== 'assistant') continue;
    const expected = entry.event.sessionId === sessionA ? alpha : entry.event.sessionId === sessionB ? bravo : undefined;
    assert.ok(expected, 'an assistant event must belong to one of the two sessions');
    assert.ok(expected!.startsWith(textOf(entry.event.message)), 'no assistant event may carry another session text');
  }
  assert.equal(env.gated!.count(), 2, 'each concurrent chat must dispatch exactly one provider request');
  assert.deepEqual(env.gated!.stats(), [1, 2].map(() => ({ frames: 77, expectedFrames: 77, ended: true, closed: true })));

  const detailA = await detail(env, sessionA);
  const detailB = await detail(env, sessionB);
  assert.equal(detailA.messages.length, 2);
  assert.equal(detailB.messages.length, 2);
  assert.equal(textOf(detailA.messages[1]), alpha);
  assert.equal(textOf(detailB.messages[1]), bravo);
  assert.notEqual(detailA.messages[1].id, detailB.messages[1].id);

  // SideAsk: transient by contract, never appends a message event, detail unchanged.
  const before = JSON.stringify(detailA.messages);
  const sideCursor = feed.cursor;
  const side = await env.request('POST', '/v1/product/chat/side-ask', {
    sessionId: sessionA, question: 'What should happen next?', attachments: [], modelId: 'default', history: [],
  });
  assert.equal(side.status, 200, 'SideAsk must answer: ' + JSON.stringify(side.body));
  assert.ok(typeof side.body.answer === 'string' && side.body.answer.length > 0);
  for (let round = 0; round < 5; round++) { await pause(40); await pollFeed(env, feed); }
  const sideWrites = feed.entries.filter(entry => entry.id > sideCursor && entry.event?.type === 'message.upsert');
  assert.deepEqual(sideWrites, [], 'SideAsk must never append a message.upsert event');
  assert.equal(JSON.stringify((await detail(env, sessionA)).messages), before, 'SideAsk must not change the session detail');
  const sessions = await env.request('GET', '/v1/product/sessions?limit=100');
  assert.equal((sessions.body.items as any[]).length, 2, 'SideAsk must not create a session');
  assert.equal(env.gated!.count(), 3, 'SideAsk dispatches its own single transients request');
  assert.deepEqual(env.gated!.stats(), [1, 2, 3].map(() => ({ frames: 77, expectedFrames: 77, ended: true, closed: true })));
  t.diagnostic('C6 provider frames (two chats, then SideAsk): ' + JSON.stringify(env.gated!.stats()));
  assert.equal(env.current().mock.requests(), 0, 'all three requests must reach the private HTTP provider');
});
