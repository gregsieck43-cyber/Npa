import test from 'node:test';
import assert from 'node:assert/strict';
import type { GatewayEvent, SessionSummary } from '../api/types';

const rows: SessionSummary[] = Array.from({ length: 501 }, (_, i) => ({
  id: 'row-' + (i + 1), title: 'Session ' + (i + 1), mode: i === 500 ? 'code' : 'chat',
  status: i === 500 ? 'paused' : 'idle', createdAt: '', updatedAt: new Date((1000 - i) * 1000).toISOString(),
  permission: 'ask', modelId: 'fixture',
}));
const older = rows[500]!;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let live = rows, boundary = 'original', epoch = 'first', eventId = 0;
let eventRead = deferred<(value: unknown) => void>();
let lastBootPage: { seen: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;
let focusedDeleted = false;
const listRequests: string[] = [];
const page = (start: number) => ({ items: live.slice(start, start + 100), ...(start + 100 < live.length ? { nextCursor: boundary + ':' + (start + 100) } : {}) });
const npn = { async request(_method: string, route: string) {
  const url = new URL(route, 'http://fixture'), suffix = url.pathname.slice('/v1/product'.length);
  if (suffix === '/events') {
    const read = deferred<unknown>(); eventRead.resolve(read.resolve); return read.promise;
  }
  if (suffix === '/snapshot') {
    const id = url.searchParams.get('sessionId');
    return { epoch, cursor: eventId, sessions: page(0), approvals: [],
      ...(id ? { sessionId: id, session: focusedDeleted ? null : { ...older, messages: [], hasMoreBefore: false } } : {}) };
  }
  if (suffix === '/sessions') {
    assert.equal(url.searchParams.get('limit'), '100');
    const cursor = url.searchParams.get('cursor') ?? '';
    listRequests.push(cursor);
    const start = cursor ? Number(cursor.split(':')[1]) : 0, result = page(start);
    if (start === 400 && lastBootPage) {
      const gate = lastBootPage; lastBootPage = undefined;
      gate.seen.resolve(); await gate.release.promise;
    }
    return result;
  }
  if (suffix === '/sessions/' + older.id) return { ...older, messages: [], hasMoreBefore: false };
  if (suffix === '/metrics/' + older.id) return {};
  if (suffix === '/tasks/' + older.id) return null;
  if (suffix === '/connection') return { status: 'online', demo: false };
  if (suffix === '/settings') return { appearance: { theme: 'light' }, defaults: { mode: 'chat' } };
  if (['/models','/approvals','/workspace/projects'].includes(suffix)) return [];
  throw new Error('Unexpected IPC route: ' + route);
}, async desktop() {} };
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem() {} },
  window: { npn, matchMedia: () => ({ matches: false, addEventListener() {} }) },
  document: { documentElement: { dataset: {}, style: { setProperty() {} } } } });
const actions = await import('../app/actions');
const { getState, setState } = await import('../app/store');

async function deliver(events: GatewayEvent[], reset = false) {
  const respond = await eventRead.promise;
  eventRead = deferred<(value: unknown) => void>();
  if (reset) epoch += '-reset';
  const entries = events.map(event => ({ id: ++eventId, event }));
  respond({ events: entries, nextCursor: eventId, earliest: 1, epoch, reset, longPoll: true });
  // The next real BridgeGateway poll starts only after applying the event or recovering the snapshot.
  await eventRead.promise;
}
async function duringBoot(act: () => Promise<void>) {
  actions.goHome(); setState({ sessions: {}, historyNextCursor: undefined, historyFocusId: undefined });
  live = rows; boundary = 'original'; focusedDeleted = false; listRequests.length = 0;
  const gate = { seen: deferred<void>(), release: deferred<void>() };
  lastBootPage = gate;
  const boot = actions.boot(); await gate.seen.promise;
  try { await act(); } finally { gate.release.resolve(); await boot; }
  assert.equal(getState().bootError, undefined); actions.go('history');
}

test('cold boot replays a rank-501 Code upsert before the fifth page returns; it opens only on the older page', async () => {
  await duringBoot(() => deliver([{ type: 'session.upsert', session: older }]));
  assert.equal(Object.keys(getState().sessions).length, 500);
  assert.equal(getState().sessions[older.id], undefined);
  await actions.loadOlderHistory();
  assert.deepEqual(getState().historyPage?.items?.map(row => row.id), [older.id]);
  await actions.openSession(older.id);
  assert.equal(getState().mode, 'code'); assert.equal(getState().details[older.id]?.status, 'paused');
  actions.go('history'); assert.equal(Object.keys(getState().sessions).length, 500);
});

test('a real concurrent promotion displaces the last row and supplies its new opaque continuation cursor', async () => {
  const promoted = { ...older, pinned: true, title: 'Confirmed promotion' };
  const edited = { ...rows[0]!, title: 'Updated during boot' };
  await duringBoot(async () => {
    live = [promoted, edited, ...rows.slice(1, 500)]; boundary = 'moved';
    await deliver([{ type: 'session.upsert', session: promoted }, { type: 'session.upsert', session: edited }]);
  });
  assert.equal(Object.keys(getState().sessions).length, 500);
  assert.equal(getState().sessions[older.id]?.title, promoted.title); assert.equal(getState().sessions[edited.id]?.title, edited.title);
  assert.equal(getState().sessions[rows[499]!.id], undefined);
  await actions.loadOlderHistory();
  assert.equal(listRequests.at(-1), 'moved:500'); assert.deepEqual(getState().historyPage?.items?.map(row => row.id), [rows[499]!.id]);
});

test('a partial recovery snapshot during boot supplies its own head and cursor; old reads cannot revive an evicted row', async () => {
  await duringBoot(async () => {
    await deliver([{ type: 'session.upsert', session: older }]); boundary = 'recovered';
    await deliver([], true);
  });
  assert.equal(Object.keys(getState().sessions).length, 500); assert.equal(getState().sessions[older.id], undefined);
  assert.equal(getState().historyNextCursor, 'recovered:500');
  await actions.loadOlderHistory(); assert.equal(getState().historyPage?.items?.[0]?.id, older.id);
  await actions.openSession(older.id); await deliver([], true);
  assert.equal(getState().detailSessionId, older.id); assert.equal(getState().sessions[older.id]?.mode, 'code');
  assert.deepEqual(getState().view, { kind: 'session', id: older.id });
  actions.go('history'); assert.equal(Object.keys(getState().sessions).length, 500);
  await actions.loadOlderHistory(); await actions.openSession(older.id);
  focusedDeleted = true; await deliver([], true);
  assert.deepEqual(getState().view, { kind: 'home' }); assert.equal(getState().sessions[older.id], undefined);
});
