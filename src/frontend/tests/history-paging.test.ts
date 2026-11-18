import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayEvent, Page, SessionSummary } from '../api/types';

const rows: SessionSummary[] = Array.from({ length: 605 }, (_, index) => ({
  id: 's' + (index + 1), title: '会话 ' + (index + 1), mode: index === 500 ? 'code' : 'chat', status: 'idle',
  permission: 'ask', modelId: 'fixture', createdAt: '', updatedAt: new Date((900 - index) * 1000).toISOString(),
}));
const cursors: string[] = [];
let event: (value: GatewayEvent) => void;
let intercept: ((page: Page<SessionSummary>) => Promise<Page<SessionSummary>>) | undefined;
let promote: SessionSummary | undefined, clearFailure = false;
let delayHead: ((page: Page<SessionSummary>) => Promise<Page<SessionSummary>>) | undefined;
const npn = {async request(_method: string, route: string) {
  const url = new URL(route, 'http://fixture');
  if (url.pathname === '/v1/product/sessions') {
    const cursor = url.searchParams.get('cursor') ?? '';
    const offset = cursor ? Number(cursor.split(':')[1]) : 0;
    const limit = Number(url.searchParams.get('limit'));
    assert.ok(limit > 0 && limit <= 100);
    cursors.push(cursor);
    const all = promote ? [promote, ...rows.filter(row => row.id !== promote!.id)] : rows;
    const next = offset + limit, page = {items: all.slice(offset, next), nextCursor: next < all.length ? (promote ? 'moved:' : 'boundary:') + next : undefined};
    if (delayHead && offset === 0) return delayHead(page);
    return intercept && offset >= 500 ? intercept(page) : page;
  }
  if (url.pathname === '/v1/product/connection') return {status:'online',demo:false};
  if (url.pathname === '/v1/product/settings') return {appearance:{theme:'light'},defaults:{mode:'chat'}};
  if (url.pathname === '/v1/product/settings/clear-history') return clearFailure ? { httpStatus:409, error:{code:'busy',message:'active request'} } : {cleared:true};
  if (/\/(models|approvals|projects)$/.test(url.pathname)) return [];
  if (url.pathname === '/v1/product/sessions/s501') return {...rows[500], messages:[],hasMoreBefore:false};
  if (url.pathname === '/v1/product/metrics/s501') return {};
  if (url.pathname === '/v1/product/tasks/s501') return null;
  throw new Error('Unexpected fixture route: ' + route);
}, async desktop() {}};
Object.assign(globalThis, {localStorage:{getItem:()=>null,setItem(){}},window:{npn,matchMedia:()=>({matches:false,addEventListener(){}})},document:{documentElement:{dataset:{},style:{setProperty(){}}}}});
const {gateway} = await import('../api');
gateway.subscribe = callback => {event=callback;return ()=>{};};
const actions = await import('../app/actions'), {getState} = await import('../app/store');
async function start() { intercept = undefined; delayHead=undefined; promote=undefined; actions.goHome(); cursors.length = 0; await actions.boot(); actions.go('history'); }

test('History reaches row 501 and the last page through the real bridge without expanding the sidebar cache', async () => {
  await start();
  assert.deepEqual(cursors, ['', 'boundary:100', 'boundary:200', 'boundary:300', 'boundary:400']);
  assert.equal(Object.keys(getState().sessions).length, 500);
  assert.equal(getState().historyNextCursor, 'boundary:500', 'History must retain the actual boundary after 500 session summaries');
  await actions.loadOlderHistory();
  assert.equal(getState().historyPage?.items?.[0]?.id, 's501');
  assert.equal(getState().historyPage?.items?.length, 100);
  await actions.loadOlderHistory();
  assert.deepEqual(getState().historyPage?.items?.map(row => row.id), rows.slice(600).map(row=>row.id));
  await actions.loadOlderHistory();
  assert.deepEqual(cursors.slice(5), ['boundary:500','boundary:600']);
  assert.equal(Object.keys(getState().sessions).length, 500);
  actions.showRecentHistory();
  assert.equal(getState().historyPage, undefined);
});

test('failed pages keep their displayed rows and cursor for one explicit retry', async () => {
  await start(); await actions.loadOlderHistory();
  intercept = async () => {throw new Error('offline fixture');};
  await actions.loadOlderHistory();
  assert.match(getState().historyPage?.error ?? '', /offline fixture/);
  assert.equal(getState().historyPage?.items?.[0]?.id, 's501');
  intercept = undefined;
  await actions.loadOlderHistory();
  assert.equal(getState().historyPage?.items?.[0]?.id, 's601');
  assert.equal(getState().historyPage?.error, undefined);
  assert.deepEqual(cursors.slice(5), ['boundary:500','boundary:600','boundary:600']);
});

test('late list responses cannot restore a deleted session, a discarded window or a replaced snapshot', async () => {
  for (const change of ['remove','recent','leave','snapshot']) {
    await start(); let finish!: () => void;
    intercept = page => new Promise(resolve => {finish=()=>resolve(page);});
    const pending = actions.loadOlderHistory();
    await actions.loadOlderHistory(); // a second click cannot dispatch again
    assert.equal(cursors.filter(c=>c==='boundary:500').length,1);
    if (change === 'remove') event({type:'session.removed',sessionId:'s501'});
    if (change === 'recent') actions.showRecentHistory();
    if (change === 'leave') {actions.goHome();actions.go('history');}
    if (change === 'snapshot') event({type:'state.snapshot',snapshot:{cursor:5,epoch:'new',sessions:{items:[rows[1]!],nextCursor:'replacement'},approvals:[]}});
    finish(); await pending;
    if (change === 'remove') {
      assert.equal(getState().historyPage?.items?.[0]?.id,'s502');
      event({type:'session.removed',sessionId:'s502'});
      assert.equal(getState().historyPage?.items?.[0]?.id,'s503');
    } else assert.equal(getState().historyPage, undefined);
    if (change === 'snapshot') assert.equal(getState().historyNextCursor,'replacement');
  }
});

test('opening an older Code session selects its real mode and reads its detail', async () => {
  await start();await actions.loadOlderHistory();await actions.openSession('s501');
  assert.deepEqual(getState().view,{kind:'session',id:'s501'});
  assert.equal(getState().mode,'code');
  assert.equal(getState().details.s501?.id,'s501');
  assert.equal(getState().historyPage,undefined);
  assert.equal(getState().sessions.s501?.mode,'code', 'composer and session controls must see the active older summary');
  actions.go('history');
  assert.equal(getState().sessions.s501,undefined, 'leaving a historical session releases its temporary summary');
});

test('an older session update acknowledged after deletion or replacement cannot put it back', async () => {
  for (const change of ['remove', 'snapshot']) {
    await start(); await actions.loadOlderHistory();
    const original = gateway.sessions.update;
    let finish!: () => void;
    gateway.sessions.update = () => new Promise(resolve => { finish = () => resolve({...rows[500]!,pinned:true}); });
    try {
      const pending = actions.updateSession('s501',{pinned:true});
      if (change === 'remove') event({type:'session.removed',sessionId:'s501'});
      else event({type:'state.snapshot',snapshot:{cursor:10,epoch:'new',sessions:{items:[]},approvals:[]}});
      finish();await pending;
      assert.equal(getState().sessions.s501,undefined);
    } finally {gateway.sessions.update = original;}
  }
});

test('demo session pagination reaches the next row even when the cursor row was deleted', async () => {
  const {MockGateway} = await import('../api/mock/gateway');
  const mock = new MockGateway();
  const initial = (await mock.sessions.list({limit:100})).items;
  assert.ok(initial.length > 1);
  const first = await mock.sessions.list({limit:1});
  assert.ok(first.nextCursor);
  await mock.sessions.remove(first.items[0]!.id);
  const next = await mock.sessions.list({limit:1,cursor:first.nextCursor});
  assert.equal(next.items[0]?.id, initial[1]!.id);
});

test('edits of older rows update only their visible page or temporary active summary', async () => {
  await start(); await actions.loadOlderHistory();
  const original = gateway.sessions.update;
  gateway.sessions.update = async (id, patch) => ({...rows.find(r => r.id===id)!, ...patch});
  try {
    for (let index = 501; index < 516; index++) {
      await actions.updateSession('s'+index,{pinned:true,title:'edited '+index});
      assert.equal(getState().historyPage?.items?.find(r=>r.id==='s'+index)?.title, 'edited '+index);
      assert.equal(Object.keys(getState().sessions).length,500,'editing an older page leaks into recent sessions');
    }
    await actions.openSession('s501'); await actions.updateSession('s501',{title:'changed while active'});
    assert.equal(getState().sessions.s501?.title,'changed while active');
    actions.go('history');
    assert.equal(getState().sessions.s501,undefined);
    assert.equal(Object.keys(getState().sessions).length,500);
  } finally {gateway.sessions.update = original;}
});

test('a server promotion keeps an older session in the bounded recent page after the user leaves it', async () => {
  await start(); await actions.loadOlderHistory(); await actions.openSession('s501');
  promote = {...rows[500]!,title:'authoritative promotion',pinned:true,updatedAt:new Date().toISOString()};
  event({type:'session.upsert',session:promote});
  await new Promise(resolve => setImmediate(resolve));
  actions.go('history');
  assert.equal(getState().sessions.s501?.title,'authoritative promotion');
  assert.equal(Object.keys(getState().sessions).length,500);
  assert.equal(getState().sessions.s500,undefined);
  await actions.loadOlderHistory();
  assert.equal(getState().historyPage?.items?.[0]?.id,'s500','the displaced boundary row remains reachable');
  assert.equal(cursors.at(-1),'moved:500');
});

test('pagination waits for an in-flight head refresh before using its new opaque cursor', async () => {
  await start();
  let release!: () => void;
  delayHead = page => new Promise(resolve => {release=()=>resolve(page);});
  promote = {...rows[500]!, title:'moved to recent'};
  event({type:'session.upsert', session:promote});
  const pending = actions.loadOlderHistory();
  assert.equal(cursors.includes('boundary:500'),false);
  release();await pending;
  assert.equal(cursors.at(-1),'moved:500');
  assert.equal(getState().historyPage?.items?.[0]?.id,'s500');
});

test('clear history reports a backend rejection once and success only after acknowledgement', async () => {
  await start();
  const {setState} = await import('../app/store');
  try {
    for (const rejected of [true,false]) {
      clearFailure = rejected;
      setState({toasts:[]});
      await actions.clearSessionHistory();
      assert.deepEqual(getState().toasts.map(t=>t.tone),[rejected ? 'error' : 'success']);
    }
  } finally { clearFailure=false; }
});
