/**
 * FBR-02 regression: GET /v1/product/events must validate sessionId exactly like /snapshot.
 *
 * Red on HEAD 7f738f4 (src/product/api.ts unchanged): the events route forwards the raw query
 * value to ProductStore.eventsAfter, so `?sessionId=` (empty) is falsy and the store silently
 * serves the GLOBAL log instead of rejecting the request; blank and 201+ character ids are
 * accepted too. /snapshot already rejects the same inputs through requiredString(..., 200).
 *
 * The fix is the shared 1-200 non-blank contract at the HTTP boundary. It must not change the
 * protocol: no parameter keeps the global subscription; a valid id keeps filtering; cursor,
 * epoch, reset and earliest stay global; reads never append events. Rejected requests are pure
 * reads: they must not append events, move the append watermark or create sessions/tasks.
 *
 * This suite uses the real authenticated loopback backend and the real ProductStore; no model,
 * provider, public network or GUI is used. Temp data stays under this worktree's .tmp.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import type { GatewayEvent, StateSnapshot } from '../src/frontend/api/types.js';

const tempRoot = path.resolve(process.env.TEMP ?? '.tmp');

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const until = async <T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs = 30000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected state.');
    await pause(20);
  }
};
const removeTree = (target: string): void => rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

interface HttpResult { status: number; body: any }
interface EventEntry { id: number; event: GatewayEvent }
interface EventPage { events: EventEntry[]; nextCursor: number; earliest: number; reset: boolean; epoch: string }

const setup = async () => {
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(path.join(tempRoot, 'product-event-session-filter-'));
  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const settings = { dataDir, projectRoot: process.cwd(), mockOptions: { delayMs: 0 } };
  const backend = await startBackend(settings);
  const http = async (method: string, route: string, input?: unknown): Promise<HttpResult> => {
    const response = await fetch('http://127.0.0.1:' + backend.port + route, {
      method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const close = async (): Promise<void> => { await backend.close(); await pause(50); removeTree(dir); };
  return { dir, dataDir, settings, http, close, current: () => backend };
};
type Env = Awaited<ReturnType<typeof setup>>;

const sendChat = async (env: Env, text: string): Promise<{ sessionId: string; messageId: string }> => {
  const sent = await env.http('POST', '/v1/product/chat/send', { mode: 'chat', text, attachments: [], permission: 'ask', modelId: 'default' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return sent.body as { sessionId: string; messageId: string };
};
const waitIdle = (env: Env, sessionId: string): Promise<HttpResult> => until(async () => {
  const value = await env.http('GET', '/v1/product/sessions/' + encodeURIComponent(sessionId));
  return value.status === 200 && ['idle', 'completed', 'failed', 'cancelled'].includes(value.body.status) ? value : undefined;
});
const eventPage = async (env: Env, query = ''): Promise<EventPage> => {
  const value = await env.http('GET', '/v1/product/events' + query);
  assert.equal(value.status, 200, JSON.stringify(value.body));
  return value.body as EventPage;
};
const snapshotOf = async (env: Env, query = ''): Promise<StateSnapshot> => {
  const value = await env.http('GET', '/v1/product/snapshot' + query);
  assert.equal(value.status, 200, JSON.stringify(value.body));
  return value.body as StateSnapshot;
};
const ids = (events: EventEntry[]): number[] => events.map(entry => entry.id);
const sameIds = (left: number[], right: number[]): boolean => JSON.stringify(left) === JSON.stringify(right);
const messageIdsFor = (events: EventEntry[], sessionId: string): string[] => events
  .filter((entry): entry is EventEntry & { event: Extract<GatewayEvent, { type: 'message.upsert' }> } => entry.event.type === 'message.upsert' && entry.event.sessionId === sessionId)
  .map(entry => entry.event.message.id);

/** Session id embedded in a stored event; undefined means the event is global (no session owner). */
const ownerOf = (event: GatewayEvent): string | undefined => {
  switch (event.type) {
    case 'session.upsert': return event.session.id;
    case 'session.removed': return event.sessionId;
    case 'message.upsert': return event.sessionId;
    case 'task.updated': return event.sessionId;
    case 'metrics.updated': return event.sessionId;
    case 'inspector.invalidated': return event.sessionId;
    default: return undefined;
  }
};

test('GET /v1/product/events rejects empty, blank and overlong sessionId like /snapshot', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());

  // The route is authenticated; the anonymous probe must stay 401 before any validation runs.
  const anonymous = await fetch('http://127.0.0.1:' + env.current().port + '/v1/product/events?sessionId=');
  await anonymous.text();
  assert.equal(anonymous.status, 401, 'events must stay behind the bearer-token boundary');

  // Seed one real chat session so the empty-parameter downgrade is observable as the global page.
  const seeded = await sendChat(env, 'SESSION-FILTER-SEED');
  await waitIdle(env, seeded.sessionId);
  const global = await eventPage(env, '?cursor=0&limit=200');
  assert.ok(global.events.length > 0, 'the seeded chat must write projections');
  const globalIds = ids(global.events);

  // /snapshot already enforces requiredString(sessionId, 200); /events must match it.
  const snapshotEmpty = await env.http('GET', '/v1/product/snapshot?sessionId=');
  assert.equal(snapshotEmpty.status, 400, '/snapshot already rejects an empty sessionId');
  assert.equal(snapshotEmpty.body.code, 'validation');

  const cases: { label: string; query: string }[] = [
    { label: 'empty string', query: '?sessionId=' },
    { label: 'parameter without a value', query: '?sessionId' },
    { label: 'blank string', query: '?sessionId=%20%20' },
    { label: 'overlong id (201 chars)', query: '?sessionId=' + 'x'.repeat(201) },
    { label: 'blank id with cursor', query: '?cursor=0&sessionId=%20' },
  ];
  const observations: { label: string; status: number; code: string | undefined; servedEvents: number | undefined; servedGlobalPage: boolean }[] = [];
  for (const item of cases) {
    const result = await env.http('GET', '/v1/product/events' + item.query);
    const servedIds = result.status === 200 ? ids((result.body as EventPage).events ?? []) : [];
    observations.push({
      label: item.label,
      status: result.status,
      code: result.body?.code,
      servedEvents: result.status === 200 ? servedIds.length : undefined,
      // Red: `?sessionId=` is falsy in ProductStore.eventsAfter and answers with the GLOBAL page.
      servedGlobalPage: result.status === 200 && sameIds(servedIds, globalIds),
    });
  }
  console.log('event sessionId observations: ' + JSON.stringify(observations));
  for (const [index, item] of cases.entries()) {
    const observed = observations[index]!;
    assert.equal(observed.status, 400, item.label + ' must be rejected with 400 (observed ' + observed.status + ', body ' + JSON.stringify((await env.http('GET', '/v1/product/events' + item.query)).body) + ')');
    assert.equal(observed.code, 'validation', item.label + ' must fail as validation');
  }

  // The upper boundary is exactly the shared one: 200 characters is still accepted, 201 is not.
  const max = await env.http('GET', '/v1/product/events?cursor=0&limit=10&sessionId=' + 'x'.repeat(200));
  assert.equal(max.status, 200, 'a 200-character sessionId remains inside the shared domain');
  assert.deepEqual(max.body.events, []);
  assert.equal(max.body.reset, false);

  // No parameter still means the global subscription; it is not turned into an error.
  const unfiltered = await env.http('GET', '/v1/product/events?cursor=0&limit=200');
  assert.equal(unfiltered.status, 200);
  assert.ok(sameIds(ids(unfiltered.body.events), globalIds), 'omitting sessionId keeps the global page');
});

test('a valid sessionId narrows the page without changing cursor, epoch, reset or the watermark', { timeout: 180000 }, async t => {
  const env = await setup();
  t.after(() => env.close());

  const first = await sendChat(env, 'SESSION-FILTER-A');
  await waitIdle(env, first.sessionId);
  const second = await sendChat(env, 'SESSION-FILTER-B');
  await waitIdle(env, second.sessionId);

  const before = await snapshotOf(env, '?limit=100');
  const watermark = before.cursor;
  const epoch = before.epoch;

  const global = await eventPage(env, '?cursor=0&limit=200');
  assert.equal(global.reset, false, 'a first subscribe from 0 must not reset');
  assert.equal(global.epoch, epoch);
  assert.ok(messageIdsFor(global.events, first.sessionId).length > 0, 'global page carries session A projections');
  assert.ok(messageIdsFor(global.events, second.sessionId).length > 0, 'global page carries session B projections');

  const filtered = await eventPage(env, '?cursor=0&limit=200&sessionId=' + encodeURIComponent(first.sessionId));
  assert.equal(filtered.reset, false, 'a valid filter must not invent a reset');
  assert.equal(filtered.epoch, epoch, 'filtering must not alter the epoch');
  assert.equal(filtered.earliest, global.earliest, 'the retained floor is global, not per-session');
  assert.ok(filtered.events.length > 0, 'a valid session id must keep filtering, not widen to global');
  assert.ok(messageIdsFor(filtered.events, first.sessionId).length > 0);
  assert.equal(messageIdsFor(filtered.events, second.sessionId).length, 0, 'session B projections must not leak into session A');
  for (const entry of filtered.events) {
    const owner = ownerOf(entry.event);
    assert.ok(owner === undefined || owner === first.sessionId, 'filtered page contained an event owned by ' + String(owner));
  }

  // Continuing from the filtered page cursor keeps the same protocol envelope.
  const next = await eventPage(env, '?cursor=' + filtered.nextCursor + '&limit=200&sessionId=' + encodeURIComponent(first.sessionId));
  assert.equal(next.reset, false);
  assert.ok(next.events.every(entry => entry.id > filtered.nextCursor), 'a filtered page must advance strictly by id');

  // At the global watermark a filtered read is empty and does not move the cursor.
  const atWatermark = await eventPage(env, '?cursor=' + watermark + '&limit=200&sessionId=' + encodeURIComponent(first.sessionId));
  assert.deepEqual(atWatermark.events, []);
  assert.equal(atWatermark.nextCursor, watermark);
  assert.equal(atWatermark.reset, false);

  const after = await snapshotOf(env, '?limit=100');
  assert.equal(after.cursor, watermark, 'valid reads never append events');
  assert.equal(after.epoch, epoch);
});

test('rejected sessionId requests never write events, advance the watermark or create sessions', { timeout: 180000 }, async t => {
  const env = await setup();
  t.after(() => env.close());

  const seeded = await sendChat(env, 'SESSION-FILTER-REJECT');
  await waitIdle(env, seeded.sessionId);
  // Drain any lazy projection once so the measurement window is quiet.
  await eventPage(env, '?cursor=0&limit=200');
  const before = await snapshotOf(env, '?limit=100');
  const watermark = before.cursor;
  const epoch = before.epoch;
  const sessions = before.sessions.items.length;

  const rejectedQueries = ['?cursor=0&sessionId=', '?cursor=0&sessionId', '?cursor=0&sessionId=%20%20', '?cursor=0&sessionId=' + 'x'.repeat(201)];
  for (const query of rejectedQueries) {
    const rejected = await env.http('GET', '/v1/product/events' + query);
    assert.equal(rejected.status, 400, query + ' must be rejected: ' + JSON.stringify(rejected.body));
    assert.equal(rejected.body.code, 'validation');
  }

  const after = await snapshotOf(env, '?limit=100');
  assert.equal(after.cursor, watermark, 'rejected reads must not append events');
  assert.equal(after.epoch, epoch, 'rejected reads must not rotate the epoch');
  assert.equal(after.sessions.items.length, sessions, 'rejected reads must not create sessions/tasks');

  const tail = await eventPage(env, '?cursor=' + watermark + '&limit=200');
  assert.deepEqual(tail.events, [], 'no event may follow the frozen watermark');
  assert.equal(tail.nextCursor, watermark);
  assert.equal(tail.reset, false);

  // An out-of-range cursor reports the current latest id as nextCursor; it must still be the frozen one.
  const beyond = await eventPage(env, '?cursor=9007199254740991&limit=1');
  assert.equal(beyond.reset, true);
  assert.equal(beyond.nextCursor, watermark, 'the append watermark is unchanged after rejected requests');

  const listed = await env.http('GET', '/v1/product/sessions?limit=100');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.length, sessions, 'the session index is unchanged');
});
