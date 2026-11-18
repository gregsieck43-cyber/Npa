import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, GatewayEvent, SessionDetail } from '../api/types';

let deliver: (event: GatewayEvent) => void;
const histories = new Map<string, ChatMessage[]>(), live = new Map<string, ChatMessage>(), calls: string[] = [];
let delayed: string | undefined, finishRead: ((value: SessionDetail) => void) | undefined;
let finishSend: ((value: { sessionId: string; messageId: string }) => void) | undefined;
const summary = (id: string) => ({ id, title: id, mode: id.startsWith('code') ? 'code' as const : 'chat' as const, status: 'idle' as const, permission: 'ask' as const, modelId: 'fixture', createdAt: '', updatedAt: '' });
const message = (n: number, text = 'row-' + n): ChatMessage => ({ id: 'm' + n, role: 'assistant', status: 'done', createdAt: new Date(n * 1000).toISOString(), parts: [{ kind: 'text', text }] });
function detail(id: string, before?: string): SessionDetail {
  const all = histories.get(id) ?? [], cursor = before?.startsWith('message:') ? Number(before.slice(9)) : before ? Number(before) : Infinity;
  const rows = all.filter(value => Number(value.id.slice(1)) < cursor).slice(-100);
  return { ...summary(id), messages: !before && live.has(id) ? [...rows, live.get(id)!] : rows, hasMoreBefore: rows.length === 100, ...(rows.length === 100 ? { beforeCursor: rows[0]!.id.slice(1) } : {}) };
}
const npn = { async request(method: string, path: string) {
  calls.push(method + ' ' + path); const url = new URL(path, 'http://fixture');
  if (url.pathname === '/v1/product/connection') return { status: 'online', demo: false };
  if (url.pathname === '/v1/product/settings') return { appearance: { theme: 'light', accent: 'ember', density: 'comfortable', motion: 'full', ambient: false, fontScale: 1 }, defaults: { mode: 'chat' } };
  if (url.pathname === '/v1/product/models' || url.pathname === '/v1/product/approvals' || url.pathname === '/v1/product/workspace/projects') return [];
  if (url.pathname === '/v1/product/sessions') return { items: [] };
  if (url.pathname === '/v1/product/chat/send') return new Promise(resolve => { finishSend = resolve; });
  if (url.pathname.startsWith('/v1/product/sessions/')) {
    const id = decodeURIComponent(url.pathname.split('/')[4]!); if (delayed === id) return new Promise<SessionDetail>(resolve => { finishRead = resolve; });
    return detail(id, url.searchParams.get('before') ?? undefined);
  }
  if (url.pathname.startsWith('/v1/product/metrics/')) return { rounds: 1, modelSteps: 1, tokens: { input: 1, output: 1 }, toolCalls: 0, activeTools: 0 };
  if (url.pathname.startsWith('/v1/product/tasks/')) return null;
  throw new Error('Unexpected fixture route: ' + path);
}, async desktop() {} };
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem() {} }, window: { npn, matchMedia: () => ({ matches: false, addEventListener() {} }) }, document: { documentElement: { dataset: {}, style: { setProperty() {} } } } });
const { gateway } = await import('../api');
gateway.subscribe = listener => { deliver = listener; return () => {}; };
const actions = await import('../app/actions'), store = await import('../app/store');
await actions.boot();
const next = actions as typeof actions & { loadOlderMessages(id: string): Promise<void>; loadLatestMessages(id: string): Promise<void>; releaseSession(id?: string): void };
function reset(id = 'a', count = 240, text?: string) {
  delayed = undefined; finishRead = undefined; actions.goHome(); histories.clear(); live.clear(); calls.length = 0;
  histories.set(id, Array.from({ length: count }, (_, index) => message(index + 1, text)));
  store.setState({ sessions: { [id]: summary(id) }, details: {}, metrics: {}, inspectorRevision: {}, drafts: { a: 'keep unsent draft' } });
}
function publish(id: string, value: ChatMessage) {
  if (value.status === 'streaming') live.set(id, value); else live.delete(id);
  if (value.status !== 'streaming') { const rows = histories.get(id) ?? [], index = rows.findIndex(row => row.id === value.id); if (index < 0) rows.push(value); else rows[index] = value; histories.set(id, rows); }
  deliver({ type: 'message.upsert', sessionId: id, message: value });
}

test('thousands of live messages stay bounded and streaming terminal state retains the same message', async () => {
  reset(); await actions.openSession('a');
  for (let i = 241; i <= 2240; i++) publish('a', message(i));
  assert.ok(store.getState().details.a!.messages.length <= 200, 'live window grows past 200 messages');
  for (let i = 1; i <= 100; i++) publish('a', { ...message(2241, 'stream-' + i), status: 'streaming' });
  assert.equal(store.getState().details.a!.messages.filter(row => row.id === 'm2241').length, 1);
  publish('a', message(2241, 'complete'));
  assert.equal(store.getState().details.a!.messages.at(-1)?.status, 'done');
  assert.equal(store.getState().details.a!.messages.at(-1)?.parts[0]?.kind, 'text');
  assert.equal(store.getState().details.a!.messages.at(-1)?.id, 'm2241');
});

test('switching forty sessions evicts inactive details, metrics and revisions without dropping drafts', async () => {
  reset();
  for (let i = 0; i < 40; i++) { const id = 'visit-' + i; histories.set(id, [message(i + 1)]); await actions.openSession(id); deliver({ type: 'inspector.invalidated', sessionId: id }); }
  assert.deepEqual(Object.keys(store.getState().details), ['visit-39']);
  assert.deepEqual(Object.keys(store.getState().metrics), ['visit-39']);
  assert.deepEqual(Object.keys(store.getState().inspectorRevision), ['visit-39']);
  publish('visit-0', message(400)); deliver({ type: 'inspector.invalidated', sessionId: 'visit-0' });
  assert.equal(store.getState().details['visit-0'], undefined); assert.equal(store.getState().inspectorRevision['visit-0'], undefined);
  actions.goHome(); assert.deepEqual(store.getState().details, {}); assert.deepEqual(store.getState().metrics, {}); assert.deepEqual(store.getState().inspectorRevision, {});
  assert.equal(store.getState().drafts.a, 'keep unsent draft');
});

test('old pages remain fixed during new events and returning latest preserves the unfinished stream', async () => {
  reset(); await actions.openSession('a'); await next.loadOlderMessages('a');
  const old = store.getState().details.a!.messages.map(row => row.id);
  for (let i = 241; i <= 500; i++) publish('a', message(i));
  publish('a', { ...message(501, 'stream-current'), status: 'streaming' });
  assert.deepEqual(store.getState().details.a!.messages.map(row => row.id), old, 'new messages must not displace a history page');
  await next.loadLatestMessages('a');
  assert.equal(store.getState().details.a!.messages.at(-1)?.id, 'm501');
  assert.equal(store.getState().details.a!.messages.at(-1)?.status, 'streaming');
  publish('a', message(501, 'settled'));
  assert.equal(store.getState().details.a!.messages.at(-1)?.status, 'done');
});

test('character trimming preserves complete messages and all stored history remains reachable without gaps', async () => {
  reset('a', 260, '正文'.repeat(40000)); await actions.openSession('a');
  const seen = new Set<string>(); let pages = 0;
  for (;;) {
    const page = store.getState().details.a!; for (const row of page.messages) { seen.add(row.id); assert.equal((row.parts[0] as { text: string }).text.length, 80000); }
    assert.ok(JSON.stringify(page.messages).length <= 2 * 1024 * 1024, 'settled history exceeds its character window');
    if (!page.hasMoreBefore) break;
    assert.ok(++pages < 30, 'cursor failed to progress'); await next.loadOlderMessages('a');
  }
  assert.equal(seen.size, 260); assert.ok(seen.has('m1') && seen.has('m260'));
  histories.set('a', [message(1, 'x'.repeat(3 * 1024 * 1024))]); await next.loadLatestMessages('a');
  assert.equal(store.getState().details.a!.messages.length, 1); assert.equal((store.getState().details.a!.messages[0]!.parts[0] as { text: string }).text.length, 3 * 1024 * 1024);
});

test('late detail reads cannot restore switched, deleted or recovered session caches', async () => {
  reset(); histories.set('b', [message(300)]); delayed = 'a'; const stale = actions.openSession('a');
  await actions.openSession('b'); finishRead!(detail('a')); await stale;
  assert.deepEqual(Object.keys(store.getState().details), ['b']);
  delayed = 'a'; const removed = actions.openSession('a'); deliver({ type: 'session.removed', sessionId: 'a' }); finishRead!(detail('a')); await removed;
  assert.equal(store.getState().details.a, undefined);
  const recovered = actions.openSession('a');
  deliver({ type: 'state.snapshot', snapshot: { cursor: 5, epoch: 'new', sessions: { items: [summary('a')] }, approvals: [], sessionId: 'a', session: { ...summary('a'), messages: [message(900)], hasMoreBefore: false } } });
  finishRead!(detail('a')); await recovered; assert.deepEqual(store.getState().details.a!.messages.map(row => row.id), ['m900']);
});

test('IDE active detail is released when its embedded conversation closes', async () => {
  reset('code-a'); actions.openIdeView(); await actions.loadSession('code-a');
  publish('code-a', { ...message(241, 'code-stream'), status: 'streaming' }); assert.equal(store.getState().details['code-a']!.messages.at(-1)?.id, 'm241');
  next.releaseSession('code-a'); publish('code-a', message(242));
  assert.deepEqual(store.getState().details, {}); assert.deepEqual(store.getState().metrics, {});
  await actions.loadSession('code-a');
  deliver({ type: 'state.snapshot', snapshot: { cursor: 6, epoch: 'new', sessions: { items: [] }, approvals: [], sessionId: 'code-a', session: null } });
  assert.equal(store.getState().detailSessionId, undefined); assert.deepEqual(store.getState().details, {});
});

test('an in-flight tool is retained beyond the tail budget and releases its exception on settlement', async () => {
  reset(); await actions.openSession('a');
  const tool: ChatMessage = { ...message(241), parts: [{ kind: 'tool', call: { id: 'tool', name: 'read', title: 'Read', source: 'builtin', capability: 'read', risk: 'low', args: { path: 'fixture' }, status: 'running' } }] };
  publish('a', tool);
  for (let n = 242; n < 1242; n++) publish('a', message(n));
  const active = store.getState().details.a!.messages;
  assert.equal(active[0], tool); assert.ok(active.length <= 201);
  publish('a', { ...tool, parts: [{ ...tool.parts[0] as Extract<ChatMessage['parts'][number], { kind: 'tool' }>, call: { ...(tool.parts[0] as Extract<ChatMessage['parts'][number], { kind: 'tool' }>).call, status: 'succeeded', result: { kind: 'text', text: 'complete' } } }] });
  assert.ok(store.getState().details.a!.messages.length <= 200);
  assert.equal(store.getState().details.a!.messages.some(value => value.id === tool.id), false);
});

test('live projections during a latest read win over its older persisted response', async () => {
  reset(); await actions.openSession('a'); delayed = 'a';
  const pending = next.loadLatestMessages('a');
  publish('a', { ...message(241, 'accumulated complete stream'), status: 'streaming' });
  finishRead!(detail('a')); await pending;
  assert.equal(store.getState().details.a!.messages.at(-1)?.id, 'm241');
  assert.equal(store.getState().details.a!.messages.at(-1)?.status, 'streaming');
  publish('a', message(241, 'complete'));
  assert.equal(store.getState().details.a!.messages.at(-1)?.status, 'done');
});

test('late embedded send cannot reclaim a closed IDE or replace a newly opened conversation', async () => {
  reset(); actions.openIdeView(); store.setState({ draftPermission: 'ask', draftModelId: 'fixture' });
  const closed = actions.send('fixture', [], { mode: 'code', embedded: true });
  next.releaseSession(); finishSend!({ sessionId: 'code-late', messageId: 'late' });
  assert.equal(await closed, undefined); assert.equal(store.getState().detailSessionId, undefined); assert.deepEqual(store.getState().details, {});
  actions.openIdeView(); const switched = actions.send('fixture', [], { mode: 'code', embedded: true });
  await actions.openSession('a'); finishSend!({ sessionId: 'code-late', messageId: 'late' });
  assert.equal(await switched, undefined); assert.equal(store.getState().detailSessionId, 'a'); assert.deepEqual(Object.keys(store.getState().details), ['a']);
  actions.openIdeView(); delayed = 'code-late';
  const loading = actions.send('fixture', [], { mode: 'code', embedded: true });
  finishSend!({ sessionId: 'code-late', messageId: 'late' }); await new Promise(resolve => setImmediate(resolve));
  next.releaseSession(); finishRead!(detail('code-late'));
  assert.equal(await loading, undefined); assert.equal(store.getState().detailSessionId, undefined); assert.deepEqual(store.getState().details, {});
});

test('late new-session acknowledgement cannot leave the newly selected home mode or project', async () => {
  for (const change of [() => actions.setMode('cowork'), () => store.setState({ projectId: 'different-project' })]) {
    reset(); actions.goHome('chat'); store.setState({ projectId: undefined, draftPermission: 'ask', draftModelId: 'fixture' });
    const pending = actions.send('fixture', [], { mode: 'chat' });
    change();
    finishSend!({ sessionId: 'late-chat', messageId: 'late' });
    assert.equal(await pending, undefined);
    assert.equal(store.getState().view.kind, 'home');
  }
});

test('an oversized persisted active tool keeps an exact anchor and preceding history advances', async () => {
  reset(); await actions.openSession('a');
  publish('a', { ...message(241), parts: [{ kind: 'tool', call: { id: 'large-tool', name: 'read', title: 'Read', source: 'builtin', capability: 'read', risk: 'low', args: {}, status: 'running', result: { kind: 'text', text: 'x'.repeat(3 * 1024 * 1024) } } }] });
  assert.equal(store.getState().details.a!.beforeCursor, 'message:m241');
  await next.loadOlderMessages('a'); assert.equal(store.getState().details.a!.messages.at(-1)?.id, 'm240');
});

test('an active-only oversized tail enters stored history with explicit before and never repeats the live latest', async () => {
  for (const status of ['streaming', 'error', 'cancelled'] as const) {
    reset(); await actions.openSession('a');
    const projection = { ...message(241, 'x'.repeat(3 * 1024 * 1024)), status };
    if (status === 'streaming') live.set('a', projection);
    // Failed/cancelled Chat projections are also non-persistent in the real backend.
    deliver({ type: 'message.upsert', sessionId: 'a', message: projection });
    await next.loadOlderMessages('a');
    assert.equal(store.getState().details.a!.messages.at(-1)?.id, 'm240');
    assert.ok(calls.some(call => call.endsWith('before=9007199254740991')));
  }
});
