import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import { listenLoopback } from '../src/app/loopback.js';
import type { ChatMessage, SessionDetail, StateSnapshot } from '../src/frontend/api/types.js';
import type { ProductApi } from '../src/product/api.js';

const ROOT = path.resolve('.tmp/product-live-session-tests');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const text = (message: ChatMessage) => message.parts.filter(part => part.kind === 'text').map(part => part.text).join('');
const reasoning = (message: ChatMessage) => message.parts.filter(part => part.kind === 'reasoning').map(part => part.text).join('');
async function until<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { const value = await read(); if (value !== undefined) return value; await sleep(15); }
  throw new Error('Timed out waiting for the controlled loopback state');
}

/** Real SSE pauses indefinitely after two chunks, until the test explicitly finishes or interrupts it. */
async function provider() {
  const sockets = new Set<Socket>(), blocked: ServerResponse[] = [];
  let requests = 0, chunks = 0;
  const send = (response: ServerResponse, delta: Record<string, unknown>, finish: string | null = null) => {
    chunks++; response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
  };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) { response.writeHead(404); response.end(); return; }
    let raw = ''; for await (const data of request) raw += data;
    const body = JSON.parse(raw) as { messages: { role: string; content?: string }[] };
    requests++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    if (body.messages.some(message => message.role === 'system' && message.content?.includes('REVIEWER ROLE'))) {
      send(response, { content: JSON.stringify({ verdict: 'pass', reason: 'Local fixture verification.', findings: [] }) }, 'stop');
      response.end('data: [DONE]\n\n'); return;
    }
    send(response, { content: 'Visible partial ', reasoning_content: 'Reasoning prefix ' });
    await sleep(250); // Cross the existing Chat/Work projection throttle before holding a fixed prefix.
    if (response.destroyed) return;
    send(response, { content: 'second chunk ', reasoning_content: 'reasoning suffix ' });
    blocked.push(response);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const port = await listenLoopback(server);
  return {
    url: `http://127.0.0.1:${port}/provider/v1`, blocked, requests: () => requests, chunks: () => chunks,
    finish() { for (const response of blocked.splice(0)) if (!response.destroyed) { send(response, { content: 'finished' }, 'stop'); response.end('data: [DONE]\n\n'); } },
    fail() { for (const response of blocked.splice(0)) if (!response.destroyed) response.end(); },
    close: () => new Promise<void>((resolve, reject) => { for (const socket of sockets) socket.destroy(); server.close(error => error ? reject(error) : resolve()); }),
  };
}

function activeCounts(api: ProductApi) {
  const state = api as unknown as { chatStreams?: Map<string, unknown>; workStreams: Map<string, unknown> };
  return { chat: state.chatStreams?.size ?? 0, work: state.workStreams.size };
}

async function fixture(t: TestContext) {
  mkdirSync(ROOT, { recursive: true }); const owned = mkdtempSync(path.join(ROOT, 'live-'));
  const sse = await provider(), settings = { dataDir: path.join(owned, 'data'), projectRoot: process.cwd(), mockOptions: {} };
  let backend = await startBackend(settings);
  // Keep the production transport in mock mode and route it only to this fixture's loopback endpoint.
  const configure = () => { backend.services.configuration.provider.baseUrl = sse.url; };
  configure();
  const request = async <T>(route: string, input?: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${backend.port}/v1/product${route}`, {
      method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `${route}: ${response.status}`);
    return await response.json() as T;
  };
  const latest = (id: string) => request<SessionDetail>(`/sessions/${id}`);
  const snapshot = (id: string) => request<StateSnapshot>(`/snapshot?sessionId=${id}`);
  const start = async (mode: 'chat' | 'cowork') => {
    const sent = await request<{ sessionId: string }>('/chat/send', { mode, text: 'Produce a streamed answer.', attachments: [], permission: 'read-only', modelId: 'default' });
    await until(() => sse.blocked.length ? true : undefined);
    return sent.sessionId;
  };
  const partial = async (mode: 'chat' | 'cowork', id: string): Promise<ChatMessage> => {
    if (mode === 'cowork') {
      // Do not poll Product events first: GET/snapshot must import the real Work delta themselves.
      const event = await until(() => {
        const current = backend.services.kernel.latestEvent(id, 'model.stream.delta');
        return String(current?.payload.text ?? '').includes('second chunk') ? current : undefined;
      });
      return { id: String(event.payload.messageId), role: 'assistant', status: 'streaming', createdAt: event.createdAt,
        parts: [{ kind: 'text', text: String(event.payload.text) }, { kind: 'reasoning', text: String(event.payload.reasoningText) }] };
    }
    return until(async () => {
      const page = await request<{ events: { event: { type: string; sessionId?: string; message?: ChatMessage } }[] }>(`/events?cursor=0&limit=200&sessionId=${id}`);
      return page.events.map(entry => entry.event).findLast(event => event.type === 'message.upsert' && event.sessionId === id && event.message?.status === 'streaming')?.message;
    });
  };
  const cancel = (id: string) => request('/chat/cancel', { sessionId: id });
  t.after(async () => { await backend.close(); await sse.close(); assert.equal(path.dirname(owned), ROOT); rmSync(owned, { recursive: true, force: true }); });
  return { current: () => backend, request, latest, snapshot, start, partial, cancel, sse,
    restart: async () => { const previous = backend.services.product!; await backend.close(); backend = await startBackend(settings); configure(); return previous; } };
}

for (const mode of ['chat', 'cowork'] as const) {
  test(`${mode}: latest HTTP detail and recovery snapshot reopen the fixed in-flight prefix without another SSE chunk`, async t => {
    const f = await fixture(t), id = await f.start(mode), partial = await f.partial(mode, id);
    const chunks = f.sse.chunks(), requests = f.sse.requests();
    // Snapshot is deliberately first for Work: it has a distinct capture path from GET detail.
    const recovery = await f.snapshot(id);
    const reopened = recovery.session?.messages.find(message => message.id === partial.id);
    assert.ok(reopened, 'snapshot must include current in-flight output, even if no new token arrives');
    assert.equal(reopened.status, 'streaming'); assert.equal(text(reopened), text(partial)); assert.equal(reasoning(reopened), reasoning(partial));
    for (let attempt = 0; attempt < 3; attempt++) {
      const view = await f.latest(id), found = view.messages.filter(message => message.id === partial.id);
      assert.equal(found.length, 1); assert.equal(text(found[0]!), text(partial)); assert.equal(reasoning(found[0]!), reasoning(partial));
      assert.equal(found[0]!.status, 'streaming');
    }
    const historical = await f.request<SessionDetail>(`/sessions/${id}?before=${Number.MAX_SAFE_INTEGER}`);
    assert.ok(historical.messages.every(message => message.status !== 'streaming' && message.id !== partial.id), 'historical pages contain durable records only');
    assert.equal(f.sse.chunks(), chunks); assert.equal(f.sse.requests(), requests, 'opening views does not dispatch a model request');
    f.sse.finish();
    const settled = await until(async () => {
      const value = await f.latest(id); return value.messages.some(message => message.id === partial.id && message.status === 'done') ? value : undefined;
    });
    assert.equal(settled.messages.filter(message => message.id === partial.id).length, 1, 'durable identity replaces, never duplicates, the live message');
    assert.equal(text(settled.messages.find(message => message.id === partial.id)!), 'Visible partial second chunk finished');
    assert.deepEqual(activeCounts(f.current().services.product!), { chat: 0, work: 0 });
    const old = await f.restart(); assert.deepEqual(activeCounts(old), { chat: 0, work: 0 });
    const restored = await f.latest(id);
    assert.equal(restored.messages.filter(message => message.id === partial.id).length, 1);
    assert.ok(restored.messages.every(message => message.status !== 'streaming'));
    assert.equal(f.current().mock.requests(), 0);
  });

  for (const terminal of ['cancel', 'error', 'restart'] as const) {
    test(`${mode}: ${terminal} clears the live item; a subsequent latest/snapshot cannot resurrect it`, async t => {
      const f = await fixture(t), id = await f.start(mode), partial = await f.partial(mode, id);
      await f.snapshot(id); // Populate Work projection without relying on frontend event polling.
      if (terminal === 'restart') {
        const old = await f.restart(); assert.deepEqual(activeCounts(old), { chat: 0, work: 0 });
        assert.deepEqual(activeCounts(f.current().services.product!), { chat: 0, work: 0 }, 'recovery starts without active in-memory items');
      } else {
        if (terminal === 'cancel') await f.cancel(id); else f.sse.fail();
        await until(async () => {
          const page = await f.request<{ events: { event: { type: string; message?: ChatMessage } }[] }>(`/events?cursor=0&limit=200&sessionId=${id}`);
          return page.events.some(entry => entry.event.message?.id === partial.id && entry.event.message.status === (terminal === 'cancel' ? 'cancelled' : 'error')) ? true : undefined;
        });
      }
      const latest = await f.latest(id), recovery = await f.snapshot(id);
      assert.ok(latest.messages.every(message => message.status !== 'streaming'));
      assert.ok(recovery.session?.messages.every(message => message.status !== 'streaming'));
      assert.deepEqual(activeCounts(f.current().services.product!), { chat: 0, work: 0 });
      assert.ok(!latest.messages.some(message => message.id === partial.id), 'an interrupted prefix is not invented as durable history');
      if (mode === 'chat') {
        f.current().services.product!.chatStream({ sessionId: id, requestId: partial.requestId!, messageId: partial.id,
          content: 'late old request', status: 'streaming' });
        assert.ok(!(await f.latest(id)).messages.some(message => message.id === partial.id));
        assert.deepEqual(activeCounts(f.current().services.product!), { chat: 0, work: 0 });
      }
    });
  }
}

test('Chat durable message wins id deduplication, and removing a live conversation releases its cache', async t => {
  const f = await fixture(t), id = await f.start('chat'), partial = await f.partial('chat', id);
  f.current().services.harness!.store.addMessage(id, { role: 'assistant', content: 'Canonical stored record', requestId: partial.requestId }, partial.id);
  const detail = await f.latest(id), same = detail.messages.filter(message => message.id === partial.id);
  assert.equal(same.length, 1); assert.equal(same[0]!.status, 'done'); assert.equal(text(same[0]!), 'Canonical stored record');
  await f.request(`/sessions/${id}/remove`, {});
  assert.deepEqual(activeCounts(f.current().services.product!), { chat: 0, work: 0 });
  assert.equal((await f.snapshot(id)).session, null);
});

test('concurrent Chat latest views stay scoped and cancelling one releases only its active item', async t => {
  const f = await fixture(t), first = await f.start('chat'), firstPartial = await f.partial('chat', first);
  const second = await f.start('chat'), secondPartial = await f.partial('chat', second);
  for (const [id, own, foreign] of [[first, firstPartial, secondPartial], [second, secondPartial, firstPartial]] as const) {
    const view = await f.latest(id);
    assert.ok(view.messages.some(message => message.id === own.id && message.status === 'streaming'));
    assert.ok(!view.messages.some(message => message.id === foreign.id));
  }
  assert.deepEqual(activeCounts(f.current().services.product!), { chat: 2, work: 0 });
  await f.cancel(first);
  assert.deepEqual(activeCounts(f.current().services.product!), { chat: 1, work: 0 });
  assert.ok((await f.snapshot(second)).session?.messages.some(message => message.id === secondPartial.id && message.status === 'streaming'));
  await f.cancel(second);
  assert.deepEqual(activeCounts(f.current().services.product!), { chat: 0, work: 0 });
});
