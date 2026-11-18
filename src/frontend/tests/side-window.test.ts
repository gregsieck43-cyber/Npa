import assert from 'node:assert/strict';
import test from 'node:test';
import type { SideAnswer, SideAskInput, SideHistory } from '../api/types';

const calls: { method: string; path: string; body?: SideAskInput }[] = [];
const histories = new Map<string, SideAnswer[]>();
let holdAsk = false, failAsk = false, finishAsk: ((value: SideAnswer) => void) | undefined, rejectAsk: ((error: Error) => void) | undefined;
const ids = new Map<string, string>();
const row = (key: string, index: number): SideAnswer => ({ id: `${key}-${index}`, question: `q${index}`, answer: `a${index}`, createdAt: new Date(index * 1000).toISOString(), sideSessionId: ids.get(key) ?? `side-${key}`, status: 'completed' });
const npn = { async request(method: string, path: string, body?: SideAskInput) {
  calls.push({ method, path, body });
  const url = new URL(path, 'http://fixture');
  const key = url.searchParams.get('sessionId') ?? body?.sessionId ?? 'temp';
  if (!ids.has(key)) ids.set(key, `side-${key}`);
  if (url.pathname.endsWith('/chat/side-history')) {
    const before = Number(url.searchParams.get('before') ?? Infinity), all = histories.get(key) ?? [];
    const end = Math.min(all.length, before), start = Math.max(0, end - 40);
    return { sideSessionId: ids.get(key)!, items: all.slice(start, end), nextCursor: start ? String(start) : undefined } satisfies SideHistory;
  }
  if (url.pathname.endsWith('/chat/side-ask')) {
    if (failAsk) { failAsk = false; throw new Error('temporary disconnect'); }
    if (holdAsk) return new Promise<SideAnswer>((resolve, reject) => { finishAsk = resolve; rejectAsk = reject; });
    const value = { ...row(key, 999), id: body!.messageId!, question: body!.question, sideSessionId: ids.get(key)!, operations: [{ commandId: 'c1', action: 'pause', taskId: key, status: 'applied', revision: 3 }] } satisfies SideAnswer;
    histories.set(key, [...(histories.get(key) ?? []), value]);
    return value;
  }
  if (url.pathname.endsWith('/chat/side-clear')) { histories.set(key, []); ids.set(key, `new-side-${key}`); return; }
  if (url.pathname.endsWith('/chat/side-cancel')) return;
  throw new Error('Unexpected route ' + path);
}, async desktop() {} };
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem() {} }, window: { npn, matchMedia: () => ({ matches: false, addEventListener() {} }) } });
const actions = await import('../app/actions'), store = await import('../app/store');
const side = actions as typeof actions & { loadSideChat(sessionId?: string, older?: boolean): Promise<unknown>; cancelSideChat(sessionId?: string): Promise<unknown> };

function reset() {
  calls.length = 0; histories.clear(); ids.clear(); holdAsk = false; failAsk = false; finishAsk = undefined;
  store.setState({ sideChats: {} });
}

test('side history reads 40 per page, retains at most 80 and only one conversation window', async () => {
  reset(); histories.set('a', Array.from({ length: 160 }, (_, index) => row('a', index)));
  await side.loadSideChat('a');
  assert.equal(store.getState().sideChats.a!.length, 40);
  await side.loadSideChat('a', true); assert.equal(store.getState().sideChats.a!.length, 80);
  await side.loadSideChat('a', true);
  assert.equal(store.getState().sideChats.a!.length, 80);
  assert.equal(store.getState().sideChats.a![0]!.id, 'a-40');
  await side.loadSideChat('a'); assert.equal(store.getState().sideChats.a!.at(-1)?.id, 'a-159');
  for (let index = 0; index < 30; index++) await side.loadSideChat(`other-${index}`);
  assert.equal(Object.keys(store.getState().sideChats).length, 1);
});

test('side input has a stable message id, omits client history and preserves operation receipts', async () => {
  reset(); await side.loadSideChat('b');
  const input = { sessionId: 'b', question: 'pause', attachments: [], modelId: 'model' };
  failAsk = true; assert.equal(await side.askSide(input), undefined);
  const first = calls.find(call => call.path.endsWith('/side-ask'))!.body!;
  const answer = await side.askSide(input);
  const second = calls.filter(call => call.path.endsWith('/side-ask')).at(-1)!.body!;
  assert.ok(first.messageId); assert.equal(first.messageId, second.messageId);
  assert.equal('history' in second, false);
  assert.equal(answer?.operations?.[0]?.revision, 3);
});

test('a completed side request cannot repopulate a different conversation window', async () => {
  reset(); await side.loadSideChat('c'); holdAsk = true;
  const pending = side.askSide({ sessionId: 'c', question: 'work', attachments: [], modelId: 'model' });
  await new Promise(resolve => setTimeout(resolve, 0));
  await side.loadSideChat('d');
  finishAsk!({ ...row('c', 1), id: calls.find(call => call.path.endsWith('/side-ask'))!.body!.messageId! });
  await pending;
  assert.deepEqual(Object.keys(store.getState().sideChats), ['d']);
});

test('cancel targets only the side request; clear reaches the server and rehydrates a new side session', async () => {
  reset(); histories.set('e', [row('e', 0)]); await side.loadSideChat('e');
  await side.cancelSideChat('e');
  assert.ok(calls.some(call => call.path.endsWith('/chat/side-cancel') && call.body?.sideSessionId === 'side-e'));
  assert.ok(!calls.some(call => call.path.endsWith('/chat/cancel') || call.path.includes('/tasks/')));
  await side.clearSideChat('e'); assert.deepEqual(store.getState().sideChats.e, []);
  assert.ok(calls.some(call => call.path.endsWith('/chat/side-clear')));
  const answer = await side.askSide({ sessionId: 'e', question: 'new', attachments: [], modelId: 'model' });
  assert.equal(answer?.sideSessionId, 'new-side-e');
});

test('late side success or failure leaves the opened historical window unchanged', async () => {
  for (const fail of [false, true]) {
    reset(); histories.set('history', Array.from({ length: 120 }, (_, index) => row('history', index)));
    await side.loadSideChat('history'); holdAsk = true;
    const pending = side.askSide({ sessionId: 'history', question: 'pending', attachments: [], modelId: 'model' });
    await side.loadSideChat('history', true);
    const original = JSON.stringify(store.getState().sideChats.history);
    if (fail) rejectAsk!(new Error('delayed failure'));
    else finishAsk!({ ...row('history', 999), id: calls.find(call => call.path.endsWith('/side-ask'))!.body!.messageId! });
    await pending;
    assert.equal(JSON.stringify(store.getState().sideChats.history), original);
    assert.equal(store.getState().sideChatMeta?.latest, false);
    assert.equal(store.getState().sideChatMeta?.pending, undefined);
    assert.equal(Boolean(store.getState().sideChatMeta?.retryInput), fail);
    await side.cancelSideChat('history');
    assert.equal(JSON.stringify(store.getState().sideChats.history), original);
  }
});
