/** Real loopback HTTP/events regression for a sidebar cache that never polls session details. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import type { GatewayEvent, SessionSummary, ChatMessage } from '../src/frontend/api/types.js';

interface Entry { id: number; event: GatewayEvent }
interface Cache {
  cursor: number;
  entries: Entry[];
  sessions: Map<string, SessionSummary>;
  messages: Map<string, ChatMessage>;
}
const cache = (): Cache => ({ cursor: 0, entries: [], sessions: new Map(), messages: new Map() });
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

for (const scenario of ['server_error', 'truncated_stream', 'native_cancel', 'product_cancel', 'success'] as const) {
  test(`Chat ${scenario}: public events settle the sidebar and survive history replay`, { timeout: 30000 }, async t => {
    const tempRoot = path.resolve(process.env.TEMP ?? '.tmp');
    mkdirSync(tempRoot, { recursive: true });
    const dir = mkdtempSync(path.join(tempRoot, 'chat-terminal-index-'));
    const backend = await startBackend({
      dataDir: path.join(dir, 'data'), projectRoot: process.cwd(),
      ...(scenario === 'server_error' || scenario === 'truncated_stream' ? { mockFault: scenario } : {}),
      mockOptions: { streamChunkChars: 4, streamDelayMs: 15, responder: () => ({ content: 'terminal-index '.repeat(12) }) },
    });
    t.after(async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); });
    const request = async (method: string, route: string, input?: unknown): Promise<any> => {
      const response = await fetch(`http://127.0.0.1:${backend.port}${route}`, {
        method, headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(10000),
      });
      const body: any = await response.json();
      assert.equal(response.status, 200, `${method} ${route}: ${JSON.stringify(body)}`);
      return body;
    };
    // Same independent reducers as the UI: a message event does not invent a session status.
    const poll = async (view: Cache): Promise<number> => {
      const page = await request('GET', `/v1/product/events?cursor=${view.cursor}&limit=200`);
      assert.equal(page.reset, false);
      for (const entry of page.events as Entry[]) {
        assert.ok(entry.id > view.cursor, 'the public event cursor must move forward');
        view.entries.push(entry);
        if (entry.event.type === 'session.upsert') view.sessions.set(entry.event.session.id, entry.event.session);
        if (entry.event.type === 'message.upsert') view.messages.set(entry.event.message.id, entry.event.message);
      }
      view.cursor = page.nextCursor;
      return page.events.length;
    };
    const until = async (view: Cache, ready: () => boolean, label: string) => {
      const deadline = Date.now() + 10000;
      do {
        await poll(view);
        if (ready()) return;
        await pause(20);
      } while (Date.now() < deadline);
      assert.fail(`Timed out waiting for ${label}`);
    };
    const sent = await request('POST', '/v1/product/chat/send', {
      mode: 'chat', text: `Terminal sidebar ${scenario}`, attachments: [], permission: 'read-only', modelId: 'default',
    });
    const live = cache();
    const assistant = () => [...live.messages.values()].find(message => message.role === 'assistant');
    if (scenario !== 'server_error') {
      await until(live, () => assistant()?.status === 'streaming', 'a live assistant projection');
      assert.equal(live.sessions.get(sent.sessionId)?.status, 'streaming', 'live output must keep the sidebar running');
      if (scenario === 'native_cancel') {
        assert.ok(assistant()?.requestId);
        const cancelled = await request('POST', `/v1/harness/requests/${encodeURIComponent(assistant()!.requestId!)}/cancel`, {});
        assert.equal(cancelled.cancelled, true);
      } else if (scenario === 'product_cancel') {
        const cancelled = await request('POST', '/v1/product/chat/cancel', { sessionId: sent.sessionId });
        assert.equal(cancelled.cancelled, true);
      }
    }
    const terminal = scenario === 'success' ? 'done' : scenario.endsWith('cancel') ? 'cancelled' : 'error';
    await until(live, () => assistant()?.status === terminal, 'the exact assistant terminal state');
    // Allow the terminal callback to finish; no sessions/get or list call may repair this cache.
    for (let round = 0; round < 3; round++) { await pause(25); await poll(live); }
    assert.ok(live.entries.some(({ event }) => event.type === 'session.upsert'
      && event.session.id === sent.sessionId && event.session.status === 'streaming'), 'the cache must have observed a running session');
    assert.equal(live.sessions.get(sent.sessionId)?.status, 'idle', 'terminal public events must clear the existing sidebar streaming state');
    const assistantEvents = live.entries.flatMap(({ event }) => event.type === 'message.upsert' && event.message.role === 'assistant' ? [event.message] : []);
    assert.equal(new Set(assistantEvents.map(message => message.id)).size, 1, 'terminal state must keep the live message identity');
    assert.equal(assistantEvents.filter(message => message.status !== 'streaming').length, 1, 'exactly one terminal message event');
    assert.equal(assistant()?.status, terminal);
    if (terminal === 'error') assert.ok(assistant()?.error?.code, 'the real provider error must remain visible');

    // A fresh renderer can receive the current list and then replay from cursor zero.
    const reopened = cache();
    const current = await request('GET', '/v1/product/sessions?limit=100');
    for (const session of current.items as SessionSummary[]) reopened.sessions.set(session.id, session);
    assert.equal(reopened.sessions.get(sent.sessionId)?.status, 'idle');
    while (await poll(reopened)) { /* consume the bounded historical event pages */ }
    assert.equal(reopened.sessions.get(sent.sessionId)?.status, 'idle', 'history replay must not resurrect the stale streaming index');
    assert.equal([...reopened.messages.values()].find(message => message.role === 'assistant')?.status, terminal);

    for (let round = 0; round < 3; round++) {
      await pause(25);
      assert.equal(await poll(live), 0, 'idle polling must not append duplicate terminal/session events');
    }
    assert.equal(backend.mock.requests(), 1, 'each scenario must dispatch exactly one local mock request');
  });
}
