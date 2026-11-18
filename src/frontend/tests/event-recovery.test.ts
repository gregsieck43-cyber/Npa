/**
 * 事件快照重同步的纯函数契约测试。
 *
 * 只加载 ../app/event-recovery（仅类型导入 AppState，不加载 React/store/DOM），不使用网络、
 * 计时器或真实后台。它固定以下公开语义：
 *   1. session.removed 必须同时清理 details / metrics / inspectorRevision / approvals，并把选中的会话视图退回首页。
 *   2. 完整快照（无 nextCursor）按权威状态重建：未出现的旧会话被删除，审批集合被替换，
 *      焦点会话的 Inspector 版本 +1、指标与任务详情被替换，其他无法确认的缓存一律丢弃。
 *   3. 部分快照（有 nextCursor）绝不把"未取到的会话"当成已删除；但 session:null 是明确的删除证据。
 *   4. 被编辑截断的消息尾部由快照详情整体替换，旧尾部消息、旧指标、旧 Inspector 版本都不得残留。
 *   5. GenerationGuard/fetchIfCurrent 丢弃重置前发起、重置后完成的旧请求，防止旧详情把陈旧消息写回。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applySessionRemoved, applySnapshot, createGenerationGuard, createRecoveryFence, fetchIfCurrent } from '../app/event-recovery';
import type { AppState, View } from '../app/store';
import type {
  ApprovalRequest, ChatMessage, MetricsView, SessionDetail, SessionSummary, StateSnapshot, TaskDetail,
} from '../api/types';

type Slice = Pick<AppState, 'sessions' | 'details' | 'approvals' | 'metrics' | 'inspectorRevision' | 'view'>;

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 30, 3, minute)).toISOString();

const summary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id, mode: 'chat', title: '会话 ' + id, createdAt: at(0), updatedAt: at(1),
  status: 'idle', permission: 'ask', modelId: 'default', ...overrides,
});

const message = (id: string, text: string, role: 'user' | 'assistant' = 'user'): ChatMessage => ({
  id, role, createdAt: at(2), status: 'done', parts: [{ kind: 'text', text }],
});

const detail = (id: string, messages: ChatMessage[] = [], overrides: Partial<SessionDetail> = {}): SessionDetail => ({
  ...summary(id), messages, hasMoreBefore: false, ...overrides,
});

const approval = (id: string, sessionId: string): ApprovalRequest => ({
  id, sessionId, toolCallId: 'call-' + id, title: '写入工作区文件前确认', reason: '测试审批',
  capability: 'write', risk: 'high', preview: '{}', previewKind: 'json', digest: 'digest-' + id, createdAt: at(3),
});

const metrics = (rounds: number): MetricsView => ({
  rounds, modelSteps: rounds, tokens: { input: rounds * 10, output: rounds * 5 }, toolCalls: rounds, activeTools: 0,
});

const task = (id: string): TaskDetail => ({
  id, title: '任务 ' + id, status: 'running', phase: 'running',
  goal: { objective: '目标', constraints: [], acceptance: ['验收'], mode: 'autonomous' },
  plan: [], budget: { modelCalls: 1, maxModelCalls: 10, toolCalls: 1, maxToolCalls: 100, tokens: 100 },
  checkpoints: [], subagents: [], verification: { status: 'pending', items: [] },
  startedAt: at(0), updatedAt: at(1),
});

const slice = (input: Partial<Slice> & { view?: View } = {}): Slice => ({
  sessions: {}, details: {}, approvals: {}, metrics: {}, inspectorRevision: {}, view: { kind: 'home' }, ...input,
});

const snapshot = (input: Partial<StateSnapshot> = {}): StateSnapshot => ({
  cursor: 41, epoch: 'epoch-1', sessions: { items: [] }, approvals: [], ...input,
});

const sorted = (values: string[]): string[] => [...values].sort();

function deferredOf<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

describe('session.removed 的本地清理', () => {
  test('删除会话时清理详情、指标、Inspector 版本与审批，并把选中的会话视图退回首页', () => {
    const state = slice({
      sessions: { a: summary('a'), b: summary('b') },
      details: { a: detail('a', [message('a-1', 'a 的消息')]), b: detail('b') },
      metrics: { a: metrics(2), b: metrics(1) },
      inspectorRevision: { a: 3, b: 1 },
      approvals: { pA: approval('pA', 'a'), pB: approval('pB', 'b'), pOther: approval('pOther', 'other') },
      view: { kind: 'session', id: 'a' },
    });

    const patch = applySessionRemoved(state, 'a');

    assert.deepEqual(patch.state.sessions, { b: summary('b') });
    assert.deepEqual(patch.state.details, { b: detail('b') });
    assert.deepEqual(patch.state.metrics, { b: metrics(1) });
    assert.deepEqual(patch.state.inspectorRevision, { b: 1 });
    assert.deepEqual(patch.state.approvals, { pB: approval('pB', 'b'), pOther: approval('pOther', 'other') },
      '只有 deleted sessionId 的审批被移除，其他会话的审批必须保留');
    assert.deepEqual(patch.state.view, { kind: 'home' });
    assert.deepEqual(patch.removedSessionIds, ['a']);
    assert.equal(patch.focusRemoved, true);
    assert.equal(patch.reloadSessionId, undefined);
  });

  test('删除非选中的会话不改变视图，也不影响其他会话的缓存', () => {
    const state = slice({
      sessions: { a: summary('a'), b: summary('b') },
      details: { a: detail('a'), b: detail('b') },
      metrics: { a: metrics(2), b: metrics(1) },
      inspectorRevision: { a: 3, b: 1 },
      approvals: { pA: approval('pA', 'a'), pB: approval('pB', 'b') },
      view: { kind: 'session', id: 'a' },
    });

    const patch = applySessionRemoved(state, 'b');

    assert.deepEqual(patch.state.sessions, { a: summary('a') });
    assert.deepEqual(patch.state.details, { a: detail('a') });
    assert.deepEqual(patch.state.metrics, { a: metrics(2) });
    assert.deepEqual(patch.state.inspectorRevision, { a: 3 });
    assert.deepEqual(patch.state.approvals, { pA: approval('pA', 'a') });
    assert.deepEqual(patch.state.view ?? state.view, { kind: 'session', id: 'a' });
    assert.deepEqual(patch.removedSessionIds, ['b']);
    assert.equal(patch.focusRemoved, false);
  });
});

describe('完整快照重建权威状态', () => {
  test('删除陈旧会话、替换审批、替换指标与任务详情，并给焦点会话的 Inspector 版本 +1', () => {
    const staleTail = [message('old-user', '旧问题'), message('old-answer', '旧回答', 'assistant')];
    const state = slice({
      sessions: { a: summary('a'), b: summary('b'), c: summary('c') },
      details: { a: detail('a', staleTail), b: detail('b', [message('b-1', 'b 的消息')]) },
      metrics: { a: metrics(7), b: metrics(1) },
      inspectorRevision: { a: 3, b: 1 },
      approvals: { p1: approval('p1', 'a'), p2: approval('p2', 'b'), p3: approval('p3', 'c') },
      view: { kind: 'session', id: 'a' },
    });
    const fresh = detail('a', [message('user-1', '编辑后的问题'), message('assistant-1', '新的回答', 'assistant')]);
    const taskA = task('task-a');

    const patch = applySnapshot(state, snapshot({
      cursor: 88, epoch: 'epoch-2',
      sessions: { items: [summary('a'), summary('c')] },
      approvals: [approval('p9', 'a')],
      sessionId: 'a', session: fresh, task: taskA, metrics: metrics(2),
    }));

    assert.deepEqual(patch.state.sessions, { a: summary('a'), c: summary('c') },
      '完整快照必须删除未出现且无法确认的旧会话 b');
    assert.deepEqual(patch.state.details, { a: { ...fresh, task: taskA } },
      '只保留焦点会话详情，并把 task 作为 detail.task 合并');
    assert.deepEqual(patch.state.metrics, { a: metrics(2) }, '只保留焦点会话的最新指标');
    assert.deepEqual(patch.state.inspectorRevision, { a: 4 }, '焦点会话的 Inspector 版本从 3 增加到 4，其他版本全部丢弃');
    assert.deepEqual(patch.state.approvals, { p9: approval('p9', 'a') }, '审批集合必须被快照替换，已解决/消失的审批不得残留');
    assert.deepEqual(patch.state.view ?? state.view, { kind: 'session', id: 'a' });
    assert.deepEqual(sorted(patch.removedSessionIds), ['b']);
    assert.equal(patch.focusRemoved, false);
    assert.equal(patch.reloadSessionId, undefined, '焦点会话的详情已由快照提供，不需要再次加载');
  });

  test('快照确认焦点会话已删除时退回首页并标记 focusRemoved', () => {
    const state = slice({
      sessions: { a: summary('a'), b: summary('b'), c: summary('c') },
      details: { a: detail('a'), b: detail('b') },
      metrics: { a: metrics(2), b: metrics(1) },
      inspectorRevision: { a: 2, b: 1 },
      approvals: { pB: approval('pB', 'b') },
      view: { kind: 'session', id: 'b' },
    });

    const patch = applySnapshot(state, snapshot({
      cursor: 9, epoch: 'epoch-1',
      sessions: { items: [summary('a')] },
      approvals: [],
      sessionId: 'b', session: null,
    }));

    assert.deepEqual(patch.state.sessions, { a: summary('a') });
    assert.deepEqual(patch.state.details, {}, '焦点会话已不存在，任何旧详情都不得保留');
    assert.deepEqual(patch.state.metrics, {});
    assert.deepEqual(patch.state.approvals, {});
    assert.deepEqual(patch.state.view, { kind: 'home' });
    assert.deepEqual(patch.state.inspectorRevision, {}, '快照没有带回任何详情，就没有需要强制刷新的 Inspector 版本');
    assert.deepEqual(sorted(patch.removedSessionIds), ['b', 'c']);
    assert.equal(patch.focusRemoved, true);
    assert.equal(patch.reloadSessionId, undefined);
  });

  test('视图指向仍存在但快照未提供详情的会话时给出 reloadSessionId', () => {
    const state = slice({
      sessions: { a: summary('a'), c: summary('c') },
      details: { c: detail('c', [message('c-1', '旧详情')]) },
      metrics: { c: metrics(4) },
      inspectorRevision: { c: 1 },
      view: { kind: 'session', id: 'c' },
    });

    const patch = applySnapshot(state, snapshot({
      sessions: { items: [summary('a'), summary('c')] },
      approvals: [],
    }));

    assert.deepEqual(patch.state.sessions, { a: summary('a'), c: summary('c') });
    assert.deepEqual(patch.state.details, {}, '没有焦点会话时不保留任何无法确认的详情缓存');
    assert.deepEqual(patch.state.metrics, {});
    assert.deepEqual(patch.state.inspectorRevision, {});
    assert.deepEqual(patch.state.view ?? state.view, { kind: 'session', id: 'c' });
    assert.deepEqual(patch.removedSessionIds, []);
    assert.equal(patch.focusRemoved, false);
    assert.equal(patch.reloadSessionId, 'c');
  });
});

describe('部分快照不误删未确认会话', () => {
  test('nextCursor 存在时保留所有旧会话，取回项优先，审批仍按快照替换', () => {
    const state = slice({
      sessions: { a: summary('a'), b: summary('b'), c: summary('c'), d: summary('d') },
      details: { d: detail('d', [message('d-1', 'd 的消息')]) },
      metrics: { d: metrics(1) },
      inspectorRevision: { d: 1 },
      approvals: { pD: approval('pD', 'd') },
      view: { kind: 'session', id: 'd' },
    });

    const patch = applySnapshot(state, snapshot({
      cursor: 12, epoch: 'epoch-1',
      sessions: { items: [summary('b', { title: '取回的新标题' }), summary('x')], nextCursor: 'cursor-page-2' },
      approvals: [approval('pX', 'x')],
    }));

    assert.deepEqual(patch.state.sessions, {
      a: summary('a'), b: summary('b', { title: '取回的新标题' }), c: summary('c'), d: summary('d'), x: summary('x'),
    }, '部分快照不能把尚未取到的 a/c/d 当成已删除；取回项必须覆盖旧值');
    assert.deepEqual(patch.state.details, {}, '没有焦点会话时旧详情全部丢弃');
    assert.deepEqual(patch.state.metrics, {});
    assert.deepEqual(patch.state.inspectorRevision, {});
    assert.deepEqual(patch.state.approvals, { pX: approval('pX', 'x') });
    assert.deepEqual(patch.state.view ?? state.view, { kind: 'session', id: 'd' });
    assert.deepEqual(patch.removedSessionIds, []);
    assert.equal(patch.focusRemoved, false);
    assert.equal(patch.reloadSessionId, 'd', '视图会话仍在但快照未提供详情，需要按原分页契约重新加载');
  });

  test('部分快照中的 session:null 仍是明确的删除证据', () => {
    const state = slice({
      sessions: { a: summary('a'), b: summary('b'), c: summary('c') },
      details: { c: detail('c') },
      metrics: { c: metrics(1) },
      inspectorRevision: { c: 2 },
      approvals: { pC: approval('pC', 'c') },
      view: { kind: 'session', id: 'c' },
    });

    const patch = applySnapshot(state, snapshot({
      cursor: 7, epoch: 'epoch-1',
      sessions: { items: [summary('a')], nextCursor: 'cursor-page-2' },
      approvals: [],
      sessionId: 'c', session: null,
    }));

    assert.deepEqual(patch.state.sessions, { a: summary('a'), b: summary('b') },
      '只有 session:null 的 c 被删除，未取到的 b 必须保留');
    assert.deepEqual(sorted(patch.removedSessionIds), ['c']);
    assert.deepEqual(patch.state.details, {});
    assert.deepEqual(patch.state.metrics, {});
    assert.deepEqual(patch.state.approvals, {});
    assert.deepEqual(patch.state.inspectorRevision, {}, '聚焦会话已被确认删除，不保留旧的 Inspector 版本');
    assert.deepEqual(patch.state.view, { kind: 'home' });
    assert.equal(patch.focusRemoved, true);
  });
});

describe('消息尾部截断由快照整体替换', () => {
  test('旧尾部消息、旧指标与旧 Inspector 版本不得残留', () => {
    const state = slice({
      sessions: { a: summary('a') },
      details: { a: detail('a', [message('u1', '原始问题'), message('a-old', '被截断的旧回答', 'assistant')]) },
      metrics: { a: metrics(5) },
      inspectorRevision: { a: 2 },
      approvals: {},
      view: { kind: 'session', id: 'a' },
    });
    const edited = detail('a', [message('u1', '编辑后的问题'), message('a-new', '重新生成的新回答', 'assistant')]);

    const patch = applySnapshot(state, snapshot({
      cursor: 21, epoch: 'epoch-1',
      sessions: { items: [summary('a')] },
      approvals: [],
      sessionId: 'a', session: edited, metrics: metrics(6),
    }));

    const stored = patch.state.details!.a!;
    assert.deepEqual(stored.messages, edited.messages, '详情必须与快照消息完全一致');
    assert.equal(stored.messages.some(item => item.id === 'a-old'), false, '被截断的旧回答不得保留');
    assert.equal(stored.messages.some(item => JSON.stringify(item.parts).includes('被截断的旧回答')), false);
    assert.deepEqual(patch.state.metrics, { a: metrics(6) });
    assert.deepEqual(patch.state.inspectorRevision, { a: 3 });
    assert.deepEqual(patch.state.approvals, {});
    assert.equal(patch.focusRemoved, false);
  });
});

describe('GenerationGuard 丢弃重置前的旧请求', () => {
  test('bump/current/isCurrent 语义', () => {
    const guard = createGenerationGuard();
    assert.equal(guard.current(), 0);
    const first = guard.bump();
    assert.equal(first, 1);
    assert.equal(guard.current(), 1);
    assert.equal(guard.isCurrent(first), true);
    assert.equal(guard.isCurrent(0), false);
    const second = guard.bump();
    assert.equal(second, 2);
    assert.equal(guard.isCurrent(first), false);
    assert.equal(guard.isCurrent(second), true);
  });

  test('重置前完成的结果正常返回', async () => {
    const guard = createGenerationGuard();
    const token = guard.current();
    assert.equal(await fetchIfCurrent(guard, token, async () => '详情'), '详情');
  });

  test('重置后才完成的旧结果被丢弃为 undefined', async () => {
    const guard = createGenerationGuard();
    const token = guard.current();
    const pending = deferredOf<string>();
    const load = fetchIfCurrent(guard, token, () => pending.promise);
    guard.bump();
    pending.resolve('旧消息');
    assert.equal(await load, undefined);
  });

  test('重置期间并发的旧详情加载不会覆盖新请求的结果', async () => {
    const guard = createGenerationGuard();
    const staleToken = guard.current();
    const staleLoad = deferredOf<string>();
    const stale = fetchIfCurrent(guard, staleToken, () => staleLoad.promise);

    const freshToken = guard.bump();
    assert.equal(await fetchIfCurrent(guard, freshToken, async () => '当前详情'), '当前详情');

    staleLoad.resolve('旧消息');
    assert.equal(await stale, undefined, '先发起的旧详情即使后完成也不得写回');
  });

  test('读取失败原样向上传播', async () => {
    const guard = createGenerationGuard();
    await assert.rejects(fetchIfCurrent(guard, guard.current(), async () => { throw new Error('boom'); }), /boom/);
  });
});

describe('RecoveryFence 只在读取期间保留短期删除/结算标记', () => {
  test('没有在途读取时，长期的删除与审批结算不留下任何历史 id', () => {
    const fence = createRecoveryFence();
    for (let index = 0; index < 5000; index += 1) {
      fence.removed('deleted-history-' + index);
      fence.resolved('resolved-history-' + index);
    }
    assert.deepEqual(fence.stats(), { reads: 0, removed: 0, resolved: 0 },
      '没有读取需要校验时，事件标记应在处理完立即释放，而不是等下一次快照 reset');
  });

  test('读取期间发生的删除否决这次读取；读取结束立即释放标记', () => {
    const fence = createRecoveryFence();
    const read = fence.beginRead();
    assert.equal(read.revision > 0, true);
    fence.removed('a');
    assert.equal(fence.wasRemoved(read, 'a'), true, '删除晚于读取开始：旧响应不得写回');
    assert.equal(fence.wasRemoved(read, 'b'), false);
    assert.deepEqual(fence.stats(), { reads: 1, removed: 1, resolved: 0 });
    fence.endRead(read);
    assert.deepEqual(fence.stats(), { reads: 0, removed: 0, resolved: 0 });
    const fresh = fence.beginRead();
    assert.equal(fence.wasRemoved(fresh, 'a'), false, '新读取开始于删除之后，旧标记不再影响它');
    fence.endRead(fresh);
  });

  test('并发读取按最早的窗口保留标记，最旧读取结束后才释放', () => {
    const fence = createRecoveryFence();
    const older = fence.beginRead();
    fence.removed('a');
    const newer = fence.beginRead();
    assert.equal(fence.wasRemoved(older, 'a'), true);
    assert.equal(fence.wasRemoved(newer, 'a'), false, '后开始的读取不需要更早的删除标记');
    assert.deepEqual(fence.stats(), { reads: 2, removed: 1, resolved: 0 });
    fence.endRead(older);
    assert.deepEqual(fence.stats(), { reads: 1, removed: 0, resolved: 0 },
      '最旧读取结束后，剩下的读取都开始于删除之后，标记可以释放');
    fence.endRead(newer);
    assert.deepEqual(fence.stats(), { reads: 0, removed: 0, resolved: 0 });
  });

  test('重复结束或结束未知读取不会破坏剩余窗口', () => {
    const fence = createRecoveryFence();
    const read = fence.beginRead();
    fence.removed('a');
    fence.endRead(read);
    fence.endRead(read);
    assert.deepEqual(fence.stats(), { reads: 0, removed: 0, resolved: 0 });
    const later = fence.beginRead();
    fence.removed('b');
    assert.equal(fence.wasRemoved(later, 'b'), true);
    fence.endRead(later);
  });

  test('remove→upsert：删除前开始的读取仍被否决，重新创建后的新读取正常', () => {
    const fence = createRecoveryFence();
    const read = fence.beginRead();
    fence.removed('recreated');
    // session.upsert 不清除删除标记：旧响应可能来自已被删除的那一代，重新打开会重新读取。
    assert.equal(fence.wasRemoved(read, 'recreated'), true, 'upsert 不能把删除前的旧读取重新变成有效');
    fence.endRead(read);
    const reopened = fence.beginRead();
    assert.equal(fence.wasRemoved(reopened, 'recreated'), false, 'upsert 之后开始的读取不受旧删除影响');
    fence.endRead(reopened);
  });

  test('审批结算只否决结算前开始的读取；重新请求会撤销结算标记', () => {
    const fence = createRecoveryFence();
    const boot = fence.beginRead();
    fence.resolved('p1');
    fence.resolved('p2');
    assert.equal(fence.wasResolved(boot, 'p1'), true, '旧待审批列表不得把已结算项灌回来');
    assert.equal(fence.wasResolved(boot, 'missing'), false);
    fence.requested('p1');
    assert.equal(fence.wasResolved(boot, 'p1'), false, '重新请求后同一 id 又是真实待审批，旧的结算标记必须撤销');
    assert.deepEqual(fence.stats(), { reads: 1, removed: 0, resolved: 1 });
    fence.endRead(boot);
    assert.deepEqual(fence.stats(), { reads: 0, removed: 0, resolved: 0 });
  });

  test('快照 reset 丢弃整代窗口与标记，之后的新读取不受旧事件影响', () => {
    const fence = createRecoveryFence();
    const stale = fence.beginRead();
    fence.removed('old-session');
    fence.resolved('old-approval');
    fence.reset();
    assert.deepEqual(fence.stats(), { reads: 0, removed: 0, resolved: 0 });
    fence.endRead(stale);
    assert.deepEqual(fence.stats(), { reads: 0, removed: 0, resolved: 0 }, 'reset 后迟到的旧窗口结束不能再操作任何标记');
    const next = fence.beginRead();
    assert.equal(fence.wasRemoved(next, 'old-session'), false);
    assert.equal(fence.wasResolved(next, 'old-approval'), false);
    fence.endRead(next);
  });

  test('标记数量只随在途读取窗口与窗口期间的事件增长', () => {
    const fence = createRecoveryFence();
    const read = fence.beginRead();
    for (let index = 0; index < 100; index += 1) fence.removed('burst-' + index);
    assert.equal(fence.stats().removed, 100, '窗口期间仍必须保留所有可能影响该读取的标记');
    fence.endRead(read);
    assert.equal(fence.stats().removed, 0, '窗口一结束就释放，不依赖快照 reset');
    const next = fence.beginRead();
    assert.equal(fence.stats().removed, 0);
    fence.endRead(next);
  });
});

describe('快照应用的边界约束', () => {
  test('applySnapshot 同步且只依赖快照载荷：部分快照 500 条不会触发批量删除', () => {
    const sessions: Record<string, SessionSummary> = {};
    for (let index = 0; index < 1200; index += 1) sessions['s' + index] = summary('s' + index);
    const state = slice({ sessions });
    const items = Array.from({ length: 500 }, (_, index) => summary('s' + index));

    const patch = applySnapshot(state, snapshot({ sessions: { items, nextCursor: 'page-2' } }));

    assert.equal(typeof (patch as unknown as { then?: unknown }).then, 'undefined', 'applySnapshot 必须是同步纯函数');
    assert.equal(Object.keys(patch.state.sessions ?? {}).length, 1200, '部分快照不得删除任何未确认会话');
    assert.ok(patch.state.sessions?.['s1199'], '未出现在快照页里的会话必须保留');
    assert.deepEqual(patch.removedSessionIds, []);
  });

  test('重复 id 与未知 sessionId 不抛错，且按 key 去重', () => {
    const state = slice({
      sessions: { dup: summary('dup'), ghost: summary('ghost') },
      details: { ghost: detail('ghost') },
      metrics: { ghost: metrics(1) },
      approvals: { pGhost: approval('pGhost', 'ghost') },
      view: { kind: 'session', id: 'ghost' },
    });

    const patch = applySnapshot(state, snapshot({
      sessions: { items: [summary('dup'), summary('dup', { title: '第二次出现' })] },
      approvals: [approval('pa', 'dup'), approval('pa', 'dup', )],
      sessionId: 'never-seen', session: null,
    }));

    assert.equal(Object.keys(patch.state.sessions ?? {}).length, 1);
    assert.equal(Object.keys(patch.state.approvals ?? {}).length, 1);
    assert.deepEqual(patch.state.view, { kind: 'home' }, '完整快照中 ghost 未出现，视图退回首页');
    assert.deepEqual(sorted(patch.removedSessionIds), ['ghost', 'never-seen'], '未知的聚焦会话 id 也被确认为不存在');
    assert.equal(patch.focusRemoved, true);
    assert.equal(patch.reloadSessionId, undefined);
  });
});
