/**
 * BridgeGateway 接线契约测试：定义真实网关必须做到的 HTTP 映射、错误映射与事件轮询语义。
 * 不弱化、不跳过：新行为先在这里以公开断言固定下来，再改实现。
 *
 * 修正轮（2026-10-30）——真实 HTTP 启动探针发现前端以 limit=500 调 /v1/product/sessions，
 * 而后台只接受 1..100，于是 BridgeGateway 抛出「limit must be an integer from 1 to 100」。本文件据此新增：
 *   1. sessions.list 有界串行聚合：limit > 100 时按每页 ≤100 分页取满，保留调用方过滤条件、游标与 nextCursor 语义；
 *      只有缺少 nextCursor 才是终止信号（产品刷新会话列表会删掉过期行，空页但不是末页属于正常现象）；
 *      游标不前进判 invalid_response 而不是无限循环；后续页错误原样抛出，不吞错、不自动重试。
 *   2. 事件流健康可见：轮询失败/恢复各只发一次 connection.changed（offline / online）；历史截断除回调
 *      onStreamError(events_reset) 外，还必须给用户一条 warn 通知「事件历史已截断」（同一订阅内去重），
 *      说明缺口后需要按快照重新同步，重置本身不得伪装成连接恢复。
 *   3. onStreamError 抛错不得让轮询永久停摆，也不得漏成未处理的 Promise 拒绝。
 *   4. desktop.pickFiles：原生 IPC 已实现并通过 15/15 原生测试，但主树验收仍在外部，保留「待原生验收」标记。
 *
 * 约束：只用 node:test + node:assert/strict，确定性时钟与本地传输桩；不触网、不写盘、不依赖真实后台。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BridgeGateway } from '../api/bridge';
import type { BridgeGatewayOptions, BridgeTimers } from '../api/bridge';
import { GatewayError } from '../api/contract';
import type { GatewayEvent, ModelProfileInput, SendInput } from '../api/types';

const PREFIX = '/v1/product';

test('waiting-input session status survives bridge list/detail/event boundaries and has its own label', async () => {
  const row = { id: 'input-task', mode: 'cowork', title: 'Clarify', status: 'waiting_input' };
  const { gateway } = setup({ request: ({ path }) => path.includes('/sessions/') ? row : { items: [row] } });
  assert.equal((await gateway.sessions.list({})).items[0]!.status, 'waiting_input');
  assert.equal((await gateway.sessions.get('input-task')).status, 'waiting_input');
  const { sessionStatus } = await import('../lib/status');
  assert.equal(sessionStatus.waiting_input.label, '等待输入');
  assert.equal(sessionStatus.waiting_input.live, false);
});

interface RequestCall { method: string; path: string; body: unknown }
interface DesktopCall { action: string; payload: unknown }

interface TransportOptions {
  request?: (call: RequestCall) => unknown;
  desktop?: (call: DesktopCall) => unknown;
}

interface Fallback {
  npn: {
    request(method: string, path: string, body?: unknown): Promise<unknown>;
    desktop(action: string, payload?: unknown): Promise<unknown>;
  };
  requests: RequestCall[];
  desktops: DesktopCall[];
}

function setup(options: TransportOptions = {}): { server: Fallback; gateway: BridgeGateway } {
  const server = transport(options);
  const gatewayOptions: BridgeGatewayOptions = {};
  return { server, gateway: new BridgeGateway(server.npn, gatewayOptions) };
}

function transport(options: TransportOptions = {}): Fallback {
  const requests: RequestCall[] = [];
  const desktops: DesktopCall[] = [];
  const npn = {
    async request(method: string, path: string, body?: unknown): Promise<unknown> {
      const call: RequestCall = { method, path, body };
      requests.push(call);
      return options.request ? options.request(call) : undefined;
    },
    async desktop(action: string, payload?: unknown): Promise<unknown> {
      const call: DesktopCall = { action, payload };
      desktops.push(call);
      return options.desktop ? options.desktop(call) : undefined;
    },
  };
  return { npn, requests, desktops };
}

function splitPath(path: string): { pathname: string; query: URLSearchParams } {
  const at = path.indexOf('?');
  return { pathname: at < 0 ? path : path.slice(0, at), query: new URLSearchParams(at < 0 ? '' : path.slice(at + 1)) };
}

async function gatewayError(run: () => Promise<unknown>): Promise<GatewayError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof GatewayError) return error;
    assert.fail('预期 GatewayError，实际：' + String(error));
  }
  return assert.fail('预期抛出 GatewayError');
}

// ---------- 事件断言辅助：区分夹具事件与产品自身的通知 ----------

type NotifyEvent = Extract<GatewayEvent, { type: 'notify' }>;
type ConnectionEvent = Extract<GatewayEvent, { type: 'connection.changed' }>;

/**
 * 夹具事件标题固定为 e<id>。产品自身的通知（如「事件历史已截断」）不参与夹具计数，
 * 否则本轮新增的可见提示会污染既有的事件序号断言。
 */
function fixtureNumber(event: GatewayEvent): number | null {
  if (event.type !== 'notify') return null;
  const match = /^e(\d+)$/.exec(event.title);
  return match === null ? null : Number(match[1]);
}

function recordFixture(target: number[]): (event: GatewayEvent) => void {
  return event => {
    const id = fixtureNumber(event);
    if (id !== null) target.push(id);
  };
}

function fixtureIds(events: GatewayEvent[]): number[] {
  const ids: number[] = [];
  for (const event of events) {
    const id = fixtureNumber(event);
    if (id !== null) ids.push(id);
  }
  return ids;
}

function connectionEvents(events: GatewayEvent[]): ConnectionEvent[] {
  return events.filter((event): event is ConnectionEvent => event.type === 'connection.changed');
}

function resetToasts(events: GatewayEvent[]): NotifyEvent[] {
  return events.filter((event): event is NotifyEvent => event.type === 'notify' && event.title === '事件历史已截断');
}

/** 捕获未处理的 Promise 拒绝：onStreamError 抛错时既不能静默停掉轮询，也不能漏成进程级拒绝。 */
function watchUnhandledRejections(): { rejections: unknown[]; stop: () => void } {
  const rejections: unknown[] = [];
  const handler = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', handler);
  return {
    rejections,
    stop: () => {
      process.off('unhandledRejection', handler);
    },
  };
}

// ---------- 确定性时钟：订阅测试不得使用真实计时器 ----------

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await new Promise<void>(resolve => { setImmediate(() => resolve()); });
  }
}

class FakeTimers implements BridgeTimers {
  private now = 0;
  private nextId = 1;
  private readonly queue = new Map<number, { at: number; order: number; handler: () => void }>();

  setTimeout(handler: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.queue.set(id, { at: this.now + Math.max(0, delayMs), order: id, handler });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.queue.delete(handle as number);
  }

  size(): number {
    return this.queue.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + Math.max(0, ms);
    for (;;) {
      await flush();
      let next: { id: number; at: number; order: number; handler: () => void } | undefined;
      for (const [id, timer] of this.queue) {
        if (timer.at > target) continue;
        if (!next || timer.at < next.at || (timer.at === next.at && timer.order < next.order)) {
          next = { id, at: timer.at, order: timer.order, handler: timer.handler };
        }
      }
      if (!next) break;
      this.queue.delete(next.id);
      this.now = next.at;
      next.handler();
    }
    this.now = target;
    await flush();
  }
}

async function settle(timers: FakeTimers): Promise<void> {
  await flush();
  await timers.advance(0);
  await flush();
}

// ---------- 订阅测试夹具 ----------

interface EventPage {
  events: { id: number; event: unknown }[];
  nextCursor: number;
  earliest: number;
  reset: boolean;
}

function pageOf(ids: number[], nextCursor: number, extra: { earliest?: number; reset?: boolean } = {}): EventPage {
  return {
    events: ids.map(id => ({ id, event: { type: 'notify', tone: 'info', title: 'e' + String(id) } })),
    nextCursor,
    earliest: extra.earliest ?? 1,
    reset: extra.reset ?? false,
  };
}

interface EventsHarnessOptions { pollIntervalMs?: number; eventPageSize?: number; onStreamError?: (error: GatewayError) => void }

function eventsHarness(
  timers: FakeTimers,
  handler: (input: { index: number; cursor: string | null; limit: string | null }) => unknown,
  options: EventsHarnessOptions = {},
): { gateway: BridgeGateway; requests: RequestCall[] } {
  const requests: RequestCall[] = [];
  let index = 0;
  const npn = {
    async request(method: string, path: string, body?: unknown): Promise<unknown> {
      const call: RequestCall = { method, path, body };
      requests.push(call);
      const current = index;
      index += 1;
      const parsed = splitPath(path);
      return handler({ index: current, cursor: parsed.query.get('cursor'), limit: parsed.query.get('limit') });
    },
    async desktop(): Promise<unknown> {
      return undefined;
    },
  };
  const gateway = new BridgeGateway(npn, {
    timers,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.eventPageSize === undefined ? {} : { eventPageSize: options.eventPageSize }),
    ...(options.onStreamError === undefined ? {} : { onStreamError: options.onStreamError }),
  });
  return { gateway, requests };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

// ---------- 基础映射 ----------

describe('BridgeGateway 会话与聊天映射', () => {
  test('connection：GET /v1/product/connection 并原样返回 ConnectionInfo', async () => {
    const connection = { status: 'online', demo: false, backendVersion: '0.6.1', latencyMs: 7 };
    const { gateway, server } = setup({ request: () => connection });
    assert.deepEqual(await gateway.connection(), connection);
    assert.deepEqual(server.requests, [{ method: 'GET', path: PREFIX + '/connection', body: undefined }]);
  });

  test('sessions.list：只发送已定义的查询字段，全空时不带问号', async () => {
    const page = { items: [{ id: 's1' }], nextCursor: 'next' };
    const { gateway, server } = setup({ request: () => page });
    assert.deepEqual(await gateway.sessions.list({}), page);
    assert.equal(server.requests[0].method, 'GET');
    assert.equal(server.requests[0].path, PREFIX + '/sessions');
    await gateway.sessions.list({ text: undefined });
    assert.equal(server.requests[1].path, PREFIX + '/sessions', 'undefined 字段不产生查询参数，也不带问号');
    assert.deepEqual(await gateway.sessions.list({ mode: 'code', text: '修复 登录', projectId: 'p/1', cursor: 'c==', limit: 20 }), page);
    const parsed = splitPath(server.requests[2].path);
    assert.equal(parsed.pathname, PREFIX + '/sessions');
    assert.equal(parsed.query.get('mode'), 'code');
    assert.equal(parsed.query.get('text'), '修复 登录');
    assert.equal(parsed.query.get('projectId'), 'p/1');
    assert.equal(parsed.query.get('cursor'), 'c==');
    assert.equal(parsed.query.get('limit'), '20');
    assert.deepEqual([...parsed.query.keys()].sort(), ['cursor', 'limit', 'mode', 'projectId', 'text']);
  });

  test('sessions.get：路径段 encodeURIComponent，before 仅在定义时发送', async () => {
    const id = 's 1/2?x';
    const detail = { id, messages: [], hasMoreBefore: false };
    const { gateway, server } = setup({ request: () => detail });
    assert.deepEqual(await gateway.sessions.get(id), detail);
    assert.equal(server.requests[0].path, PREFIX + '/sessions/' + encodeURIComponent(id));
    await gateway.sessions.get(id, 'msg-9');
    const parsed = splitPath(server.requests[1].path);
    assert.equal(parsed.pathname, PREFIX + '/sessions/' + encodeURIComponent(id));
    assert.equal(parsed.query.get('before'), 'msg-9');
    assert.deepEqual([...parsed.query.keys()], ['before']);
  });

  test('sessions.update：只发送存在且已定义的字段，reasoningEffort 为 undefined 时发送空串', async () => {
    const updated = { id: 's1', title: '改过' };
    const { gateway, server } = setup({ request: () => updated });
    await gateway.sessions.update('s/1', { title: '', pinned: false, permission: undefined });
    assert.equal(server.requests[0].method, 'POST');
    assert.equal(server.requests[0].path, PREFIX + '/sessions/' + encodeURIComponent('s/1') + '/update');
    assert.deepEqual(server.requests[0].body, { title: '', pinned: false }, '空标题与取消置顶必须发送，undefined 不发送');
    await gateway.sessions.update('s1', { reasoningEffort: undefined });
    assert.deepEqual(server.requests[1].body, { reasoningEffort: '' }, 'undefined 表示恢复模型默认档');
    assert.deepEqual(await gateway.sessions.update('s1', { reasoningEffort: 'max', modelId: 'm1' }), updated);
    assert.deepEqual(server.requests[2].body, { reasoningEffort: 'max', modelId: 'm1' });
    await gateway.sessions.update('s1', { permission: 'ask' });
    assert.deepEqual(server.requests[3].body, { permission: 'ask' });
  });

  test('sessions.remove/branch/promote：无 body 与显式 body 的传输', async () => {
    const removed = setup({ request: () => ({ removed: true }) });
    assert.equal(await removed.gateway.sessions.remove('s1'), undefined);
    assert.deepEqual(removed.server.requests, [{ method: 'POST', path: PREFIX + '/sessions/s1/remove', body: undefined }]);

    const created = { id: 's2' };
    const branched = setup({ request: () => created });
    assert.deepEqual(await branched.gateway.sessions.branch('s1', 'm1'), created);
    assert.deepEqual(branched.server.requests, [{ method: 'POST', path: PREFIX + '/sessions/s1/branch', body: { messageId: 'm1' } }]);

    const promoted = { id: 's3', mode: 'cowork' };
    const promotedGateway = setup({ request: () => promoted });
    assert.deepEqual(await promotedGateway.gateway.sessions.promote('s1', { objective: '完成接线', acceptance: ['测试通过'] }), promoted);
    assert.deepEqual(promotedGateway.server.requests, [{ method: 'POST', path: PREFIX + '/sessions/s1/promote', body: { objective: '完成接线', acceptance: ['测试通过'] } }]);
  });

  test('chat.send：Body 原样传输并返回 sessionId/messageId', async () => {
    const reply = { sessionId: 's1', messageId: 'm2' };
    const input: SendInput = {
      mode: 'code', permission: 'ask', text: '修复登录', modelId: 'm1', reasoningEffort: 'high', projectId: 'p1', planFirst: true,
      attachments: [{ id: 'a1', name: 'a.log', kind: 'file', bytes: 12 }],
    };
    const { gateway, server } = setup({ request: () => reply });
    assert.deepEqual(await gateway.chat.send(input), reply);
    assert.equal(server.requests[0].method, 'POST');
    assert.equal(server.requests[0].path, PREFIX + '/chat/send');
    assert.deepEqual(server.requests[0].body, input);
  });

  test('chat.cancel/regenerate/edit：Body 字段与路径', async () => {
    const { gateway, server } = setup({ request: () => ({}) });
    assert.equal(await gateway.chat.cancel('s1'), undefined);
    assert.deepEqual(server.requests[0], { method: 'POST', path: PREFIX + '/chat/cancel', body: { sessionId: 's1' } });
    assert.equal(await gateway.chat.regenerate('s1', 'm2'), undefined);
    assert.deepEqual(server.requests[1], { method: 'POST', path: PREFIX + '/chat/regenerate', body: { sessionId: 's1', messageId: 'm2' } });
    assert.equal(await gateway.chat.edit('s1', 'm2', '改过的内容'), undefined);
    assert.deepEqual(server.requests[2], { method: 'POST', path: PREFIX + '/chat/edit', body: { sessionId: 's1', messageId: 'm2', text: '改过的内容' } });
  });

  test('approvals：pending 仅在给出 sessionId 时带查询，decide 合并 decision 字段', async () => {
    const pending = [{ id: 'a1' }];
    const { gateway, server } = setup({ request: () => pending });
    assert.deepEqual(await gateway.approvals.pending(), pending);
    assert.equal(server.requests[0].path, PREFIX + '/approvals');
    assert.deepEqual(await gateway.approvals.pending('s1'), pending);
    const parsed = splitPath(server.requests[1].path);
    assert.equal(parsed.pathname, PREFIX + '/approvals');
    assert.equal(parsed.query.get('sessionId'), 's1');
    assert.deepEqual([...parsed.query.keys()], ['sessionId']);
    assert.equal(await gateway.approvals.decide('a1', { approved: false, scope: 'session', note: '不信任' }), undefined);
    assert.equal(server.requests[2].path, PREFIX + '/approvals/decide');
    assert.deepEqual(server.requests[2].body, { approvalId: 'a1', approved: false, scope: 'session', note: '不信任' });
  });

  test('tasks.get/control：null 转 undefined，路径段编码，control 发送 action', async () => {
    const id = 't 1/2';
    const missing = setup({ request: () => null });
    assert.equal(await missing.gateway.tasks.get(id), undefined);
    assert.equal(missing.server.requests[0].path, PREFIX + '/tasks/' + encodeURIComponent(id));

    const detail = { id: 't1', status: 'running' };
    const found = setup({ request: () => detail });
    assert.deepEqual(await found.gateway.tasks.get('t1'), detail);

    const controlled = setup({ request: () => detail });
    assert.deepEqual(await controlled.gateway.tasks.control(id, 'pause'), detail);
    assert.equal(controlled.server.requests[0].path, PREFIX + '/tasks/' + encodeURIComponent(id) + '/control');
    assert.deepEqual(controlled.server.requests[0].body, { action: 'pause' });
  });

  test('metrics：session 查询 sessionId，activity 查询天数', async () => {
    const metrics = {
      rounds: 3, modelSteps: 2, tokens: { input: 10, output: 20, cached: 4 }, toolCalls: 1, activeTools: 0, cacheHitRate: 0.4,
      usageCoverage: {
        requests: 2,
        input: { reportedRequests: 2, totalRequests: 2, state: 'known' },
        output: { reportedRequests: 2, totalRequests: 2, state: 'known' },
        total: { reportedRequests: 2, totalRequests: 2, state: 'known' },
        cached: { reportedRequests: 2, totalRequests: 2, state: 'known' },
        cacheRatio: { reportedRequests: 1, totalRequests: 2, state: 'partial' },
      },
    };
    const activity = [{ date: '2026-10-29', events: 2, modelCalls: 1, toolEffects: 0, tasksCreated: 0, tasksCompleted: 0 }];
    const { gateway, server } = setup({
      request: call => (splitPath(call.path).pathname === PREFIX + '/metrics/activity' ? activity : metrics),
    });
    assert.deepEqual(await gateway.metrics.session('s 1'), metrics);
    const sessionQuery = splitPath(server.requests[0].path).query;
    assert.equal(splitPath(server.requests[0].path).pathname, PREFIX + '/metrics/session');
    assert.equal(sessionQuery.get('sessionId'), 's 1');
    assert.deepEqual(await gateway.metrics.activity(7), activity);
    const activityPath = splitPath(server.requests[1].path);
    assert.equal(activityPath.pathname, PREFIX + '/metrics/activity');
    assert.equal(activityPath.query.get('days'), '7');
  });
});

// ---------- 会话列表有界聚合（后台 /v1/product/sessions 只接受 limit 1..100） ----------

interface SessionsFixturePage {
  items: { id: string }[];
  nextCursor?: string;
}

function sessionItems(from: number, count: number): { id: string }[] {
  return Array.from({ length: count }, (_, offset) => ({ id: 's' + String(from + offset) }));
}

/** 按请求顺序返回夹具页；多发的请求直接抛错，让聚合缺陷以测试失败暴露而不是空转。 */
function pagesTransport(pages: unknown[]): (call: RequestCall) => unknown {
  let index = 0;
  return () => {
    if (index >= pages.length) throw new Error('unexpected extra /sessions request #' + String(index + 1));
    const page = pages[index];
    index += 1;
    return page;
  };
}

describe('BridgeGateway 会话列表聚合', () => {
  test('sessions.list 聚合：limit=500 在空库上只发一次 limit=100，返回空页且无 nextCursor', async () => {
    const { gateway, server } = setup({ request: pagesTransport([{ items: [] }]) });
    const page = await gateway.sessions.list({ limit: 500 });
    assert.deepEqual(page, { items: [] }, '没有下一页时不得带 nextCursor 字段');
    assert.equal(server.requests.length, 1, '空库只需要一次请求');
    const call = server.requests[0];
    assert.equal(call.method, 'GET');
    assert.equal(call.body, undefined);
    const parsed = splitPath(call.path);
    assert.equal(parsed.pathname, PREFIX + '/sessions');
    assert.equal(parsed.query.get('limit'), '100', '超过后台上限时必须收敛为 100');
    assert.deepEqual([...parsed.query.keys()], ['limit']);
  });

  test('sessions.list 聚合：500 条跨 5 页串行取满，每页都带调用方过滤条件', async () => {
    const fixture: SessionsFixturePage[] = [
      { items: sessionItems(0, 100), nextCursor: 'c1' },
      { items: sessionItems(100, 100), nextCursor: 'c2' },
      { items: sessionItems(200, 100), nextCursor: 'c3' },
      { items: sessionItems(300, 100), nextCursor: 'c4' },
      { items: sessionItems(400, 100) },
    ];
    const pending = fixture.map(() => deferred<unknown>());
    let served = 0;
    const { gateway, server } = setup({
      request: () => {
        if (served < pending.length) {
          const current = pending[served];
          served += 1;
          return current.promise;
        }
        served += 1;
        return { items: [] }; // 多发的请求给空页，让断言而不是未处理拒绝来报错
      },
    });
    const result = gateway.sessions.list({ mode: 'code', text: '登录', projectId: 'p/1', cursor: 'start', limit: 500 });
    await flush();
    assert.equal(server.requests.length, 1, '聚合必须串行：第一页返回前不得发第二页');
    for (let step = 0; step < fixture.length - 1; step += 1) {
      pending[step].resolve(fixture[step]);
      await flush();
      assert.equal(server.requests.length, step + 2, '第 ' + String(step + 1) + ' 页返回后才发第 ' + String(step + 2) + ' 页');
    }
    pending[fixture.length - 1].resolve(fixture[fixture.length - 1]);
    await flush();
    const page = await result;
    assert.deepEqual(page, { items: sessionItems(0, 500) }, '五页按顺序拼接，且没有更多页时不带 nextCursor');
    assert.equal(server.requests.length, 5);
    for (const call of server.requests) {
      assert.equal(call.method, 'GET');
      assert.equal(call.body, undefined);
      const parsed = splitPath(call.path);
      assert.equal(parsed.pathname, PREFIX + '/sessions');
      assert.equal(parsed.query.get('limit'), '100', '聚合的每一页都不得超过后台上限');
      assert.equal(parsed.query.get('mode'), 'code', '分页必须携带同一组过滤条件，否则后续页会变成另一组查询');
      assert.equal(parsed.query.get('text'), '登录');
      assert.equal(parsed.query.get('projectId'), 'p/1');
      assert.deepEqual([...parsed.query.keys()].sort(), ['cursor', 'limit', 'mode', 'projectId', 'text']);
    }
    assert.deepEqual(server.requests.map(call => splitPath(call.path).query.get('cursor')), ['start', 'c1', 'c2', 'c3', 'c4']);
  });

  test('sessions.list 聚合：后端不足量（100 + 20）时返回 120 条且无 nextCursor', async () => {
    const { gateway, server } = setup({
      request: pagesTransport([
        { items: sessionItems(0, 100), nextCursor: 'c1' },
        { items: sessionItems(100, 20) },
      ]),
    });
    assert.deepEqual(await gateway.sessions.list({ limit: 500 }), { items: sessionItems(0, 120) });
    assert.equal(server.requests.length, 2);
    assert.deepEqual(server.requests.map(call => splitPath(call.path).query.get('limit')), ['100', '100']);
    assert.deepEqual(server.requests.map(call => splitPath(call.path).query.get('cursor')), [null, 'c1']);
  });

  test('sessions.list 聚合：limit=250 按 100/100/50 取满并保留最后一页的 nextCursor', async () => {
    const { gateway, server } = setup({
      request: pagesTransport([
        { items: sessionItems(0, 100), nextCursor: 'c1' },
        { items: sessionItems(100, 100), nextCursor: 'c2' },
        { items: sessionItems(200, 50), nextCursor: 'c3' },
      ]),
    });
    const page = await gateway.sessions.list({ limit: 250, cursor: 'start', mode: 'cowork' });
    assert.deepEqual(page, { items: sessionItems(0, 250), nextCursor: 'c3' }, '取满 250 条但还有更多时保留最后一页游标');
    assert.equal(server.requests.length, 3);
    assert.deepEqual(server.requests.map(call => splitPath(call.path).query.get('limit')), ['100', '100', '50']);
    assert.deepEqual(server.requests.map(call => splitPath(call.path).query.get('cursor')), ['start', 'c1', 'c2']);
  });

  test('sessions.list 聚合：空页但有 nextCursor 不是终止信号（产品会刷新掉过期行）', async () => {
    // 产品刷新会话列表时会删掉过期行，所以某页可能为空但仍有下一页；只有缺少 nextCursor 才代表结束。
    const { gateway, server } = setup({
      request: pagesTransport([
        { items: [], nextCursor: 'c1' },
        { items: sessionItems(0, 5) },
      ]),
    });
    assert.deepEqual(await gateway.sessions.list({ limit: 500 }), { items: sessionItems(0, 5) });
    assert.equal(server.requests.length, 2, '空页不等于末页，必须继续按游标取下一页');
    assert.deepEqual(server.requests.map(call => splitPath(call.path).query.get('cursor')), [null, 'c1']);
  });

  test('sessions.list 聚合：游标不前进（重复 nextCursor）判 invalid_response，不无限循环', async () => {
    const { gateway, server } = setup({
      request: pagesTransport([
        { items: sessionItems(0, 10), nextCursor: 'c1' },
        { items: sessionItems(10, 10), nextCursor: 'c1' },
      ]),
    });
    const error = await gatewayError(() => gateway.sessions.list({ limit: 500 }));
    assert.equal(error.code, 'invalid_response');
    assert.equal(server.requests.length, 2, '发现游标不前进必须立即停止，不得继续发请求');
    assert.deepEqual(server.requests.map(call => splitPath(call.path).query.get('cursor')), [null, 'c1']);
  });

  test('sessions.list 聚合：后续页失败原样传播（HTTP 500 / 传输拒绝），不吞错不重试', async () => {
    const httpFailure = setup({
      request: pagesTransport([
        { items: sessionItems(0, 100), nextCursor: 'c1' },
        { httpStatus: 500, code: 'internal', error: 'boom' },
      ]),
    });
    const httpFailureError = await gatewayError(() => httpFailure.gateway.sessions.list({ limit: 500 }));
    assert.equal(httpFailureError.code, 'internal');
    assert.equal(httpFailureError.message, 'boom');
    assert.equal(httpFailureError.retryable, true);
    assert.equal(httpFailure.server.requests.length, 2, '失败后不得自动重试，交给调用方决定');

    let served = 0;
    const transportFailure = setup({
      request: () => {
        served += 1;
        if (served === 1) return { items: sessionItems(0, 100), nextCursor: 'c1' };
        throw new Error('socket closed');
      },
    });
    const transportFailureError = await gatewayError(() => transportFailure.gateway.sessions.list({ limit: 500 }));
    assert.equal(transportFailureError.code, 'transport_error');
    assert.match(transportFailureError.message, /socket closed/);
    assert.equal(transportFailureError.retryable, true);
    assert.equal(transportFailure.server.requests.length, 2);
  });

  test('sessions.list：limit<=100 维持单次请求，不聚合', async () => {
    const page = { items: sessionItems(0, 10), nextCursor: 'c1' };
    const forty = setup({ request: pagesTransport([page]) });
    assert.deepEqual(await forty.gateway.sessions.list({ limit: 40 }), page, '未超过后台上限时原样返回单页');
    assert.equal(forty.server.requests.length, 1);
    const parsed = splitPath(forty.server.requests[0].path);
    assert.equal(parsed.pathname, PREFIX + '/sessions');
    assert.equal(parsed.query.get('limit'), '40');
    assert.equal(parsed.query.get('cursor'), null);
    assert.deepEqual([...parsed.query.keys()], ['limit']);

    const boundary = setup({ request: pagesTransport([page]) });
    await boundary.gateway.sessions.list({ limit: 100 });
    assert.equal(boundary.server.requests.length, 1, 'limit=100 恰好是后台上限，不需要聚合');
    assert.equal(splitPath(boundary.server.requests[0].path).query.get('limit'), '100');
  });
});

// ---------- 工作区、设置与桌面 ----------

describe('BridgeGateway 工作区、设置与桌面映射', () => {
  test('workspace.addProject：原生选择器返回路径后才登记，匹配忽略大小写与分隔符', async () => {
    const none = setup({ desktop: () => null });
    assert.equal(await none.gateway.workspace.addProject(), undefined);
    assert.deepEqual(none.server.desktops, [{ action: 'select-workspace', payload: undefined }]);
    assert.equal(none.server.requests.length, 0);

    const invalid = setup({ desktop: () => 42 });
    const invalidError = await gatewayError(() => invalid.gateway.workspace.addProject());
    assert.equal(invalidError.code, 'invalid_response');
    assert.equal(invalid.server.requests.length, 0);

    const project = { id: 'p1', name: 'Alpha', path: 'c:/work/alpha/', lastOpenedAt: '2026-10-29T00:00:00.000Z', sessions: 1 };
    const matched = setup({
      desktop: () => 'C:\\Work\\Alpha\\',
      request: () => [
        { id: 'p0', name: 'Other', path: 'D:/other', lastOpenedAt: '2026-10-29T00:00:00.000Z', sessions: 0 },
        project,
      ],
    });
    assert.deepEqual(await matched.gateway.workspace.addProject(), project);
    assert.equal(matched.server.requests[0].method, 'GET');
    assert.equal(splitPath(matched.server.requests[0].path).pathname, PREFIX + '/workspace/projects');

    const absent = setup({ desktop: () => 'C:\\Nowhere', request: () => [project] });
    const absentError = await gatewayError(() => absent.gateway.workspace.addProject());
    assert.equal(absentError.code, 'not_found');
    assert.equal(absent.server.requests.length, 1);

    for (const server of [none.server, invalid.server, matched.server, absent.server]) {
      assert.ok(!server.requests.some(call => call.method === 'POST' && splitPath(call.path).pathname === PREFIX + '/workspace/projects'), '渲染进程不得自行登记项目');
    }
  });

  test('workspace：项目、文件、检索、源代码管理、提交与终端的传输和返回值', async () => {
    const project = { id: 'p1', name: 'Alpha', path: 'C:/Work/Alpha', lastOpenedAt: '2026-10-29T00:00:00.000Z', sessions: 0 };
    const node = { path: 'src', name: 'src', kind: 'dir' };
    const hit = { path: 'src/a.ts', line: 2, column: 3, preview: 'const a = 1;', matchLength: 1 };
    const controlView = { branch: 'main', ahead: 0, behind: 0, changes: [] };
    const diff = { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, hunks: [], applied: false };
    const terminal = { command: 'git status', output: 'clean', exitCode: 0, durationMs: 3, cwd: 'C:/Work/Alpha' };
    const saved = { path: 'src/a.ts', bytes: 2, savedAt: '2026-10-29T00:00:00.000Z' };
    const { gateway, server } = setup({
      request: call => {
        const { pathname } = splitPath(call.path);
        if (pathname === PREFIX + '/workspace/projects') return [project];
        if (pathname === PREFIX + '/workspace/files') return [node];
        if (pathname === PREFIX + '/workspace/file' && call.method === 'GET') return 'line1\nline2';
        if (pathname === PREFIX + '/workspace/file') return saved;
        if (pathname === PREFIX + '/workspace/search') return [hit];
        if (pathname === PREFIX + '/workspace/source-control') return controlView;
        if (pathname === PREFIX + '/workspace/diff') return diff;
        if (pathname === PREFIX + '/workspace/commit') return { commit: 'abc123' };
        if (pathname === PREFIX + '/workspace/terminal') return terminal;
        if (pathname === PREFIX + '/workspace/diagnostics') return [];
        throw new Error('unexpected route ' + pathname);
      },
    });

    assert.deepEqual(await gateway.workspace.projects(), [project]);
    assert.deepEqual(await gateway.workspace.files('p1'), [node]);
    assert.equal(splitPath(server.requests[1].path).pathname, PREFIX + '/workspace/files');
    assert.equal(splitPath(server.requests[1].path).query.get('projectId'), 'p1');

    assert.equal(await gateway.workspace.readFile('p1', 'src/a.ts'), 'line1\nline2');
    const readQuery = splitPath(server.requests[2].path).query;
    assert.equal(splitPath(server.requests[2].path).pathname, PREFIX + '/workspace/file');
    assert.equal(readQuery.get('projectId'), 'p1');
    assert.equal(readQuery.get('path'), 'src/a.ts');

    assert.deepEqual(await gateway.workspace.writeFile('p1', 'src/a.ts', 'x'), saved);
    assert.deepEqual(server.requests[3], { method: 'POST', path: PREFIX + '/workspace/file', body: { projectId: 'p1', path: 'src/a.ts', content: 'x' } });

    assert.deepEqual(await gateway.workspace.search('p1', { text: 'a' }), [hit]);
    const basic = splitPath(server.requests[4].path).query;
    assert.equal(splitPath(server.requests[4].path).pathname, PREFIX + '/workspace/search');
    assert.equal(basic.get('projectId'), 'p1');
    assert.equal(basic.get('text'), 'a');
    assert.equal(basic.get('regex'), null);
    assert.equal(basic.get('caseSensitive'), null);

    assert.deepEqual(await gateway.workspace.search('p1', { text: 'a(', regex: true, caseSensitive: true }), [hit]);
    const rich = splitPath(server.requests[5].path).query;
    assert.equal(rich.get('regex'), 'true');
    assert.equal(rich.get('caseSensitive'), 'true');

    await gateway.workspace.search('p1', { text: 'B', regex: false, caseSensitive: false });
    const off = splitPath(server.requests[6].path).query;
    assert.equal(off.get('regex'), null, 'false 不发送');
    assert.equal(off.get('caseSensitive'), null, 'false 不发送');

    assert.deepEqual(await gateway.workspace.sourceControl('p1'), controlView);
    assert.equal(splitPath(server.requests[7].path).pathname, PREFIX + '/workspace/source-control');
    assert.equal(splitPath(server.requests[7].path).query.get('projectId'), 'p1');

    assert.deepEqual(await gateway.workspace.fileDiff('p1', 'src/a.ts'), diff);
    const diffQuery = splitPath(server.requests[8].path).query;
    assert.equal(splitPath(server.requests[8].path).pathname, PREFIX + '/workspace/diff');
    assert.equal(diffQuery.get('projectId'), 'p1');
    assert.equal(diffQuery.get('path'), 'src/a.ts');

    assert.deepEqual(await gateway.workspace.commit('p1', 'docs: readme', ['src/a.ts']), { commit: 'abc123' });
    assert.deepEqual(server.requests[9], { method: 'POST', path: PREFIX + '/workspace/commit', body: { projectId: 'p1', message: 'docs: readme', paths: ['src/a.ts'] } });

    assert.deepEqual(await gateway.workspace.terminal('p1', 'git status'), terminal);
    assert.deepEqual(server.requests[10], { method: 'POST', path: PREFIX + '/workspace/terminal', body: { projectId: 'p1', command: 'git status' } });

    assert.deepEqual(await gateway.workspace.diagnostics('p1'), []);
    assert.equal(splitPath(server.requests[11].path).pathname, PREFIX + '/workspace/diagnostics');
    assert.equal(splitPath(server.requests[11].path).query.get('projectId'), 'p1');
  });

  test('workspace.removeProject：只发送取消登记路由，无 body', async () => {
    const { gateway, server } = setup({ request: () => ({ removed: true }) });
    assert.equal(await gateway.workspace.removeProject('p 1/2'), undefined);
    assert.deepEqual(server.requests, [{ method: 'POST', path: PREFIX + '/workspace/projects/' + encodeURIComponent('p 1/2') + '/remove', body: undefined }]);
  });

  test('settings.models/saveModel/removeModel：模型配置的传输', async () => {
    const model = { id: 'm1', name: 'GLM 5.3', provider: 'Commandcode', model: 'z-ai/glm-5.3-flash', mode: 'live', credentialPresent: false };
    const listed = setup({ request: () => [model] });
    assert.deepEqual(await listed.gateway.settings.models(), [model]);
    assert.deepEqual(listed.server.requests, [{ method: 'GET', path: PREFIX + '/models', body: undefined }]);

    const input: ModelProfileInput = {
      name: 'GLM 5.3', provider: 'Commandcode', model: 'z-ai/glm-5.3-flash', mode: 'live',
      contextWindow: 500_000, maxOutputTokens: 128_000, autoConfig: true,
      inputTypes: ['text', 'image'], capabilities: ['structuredOutput', 'nativeWebSearch'],
      reasoningLevels: ['low', 'high', 'max'],
      reasoningMapping: { thinking: { type: 'enabled', effort: '{{level}}' } },
    };
    const savedSetup = setup({ request: () => model });
    assert.deepEqual(await savedSetup.gateway.settings.saveModel(input), model);
    assert.deepEqual(savedSetup.server.requests, [{ method: 'POST', path: PREFIX + '/models/save', body: input }]);

    const removal = setup({ request: () => ({ removed: true }) });
    assert.equal(await removal.gateway.settings.removeModel('m 1/2'), undefined);
    assert.deepEqual(removal.server.requests, [{ method: 'POST', path: PREFIX + '/models/' + encodeURIComponent('m 1/2') + '/remove', body: undefined }]);
  });

  test('settings.testModel：ok:false 正常 resolve，不抛错', async () => {
    const reply = { ok: false, message: '缺少凭据' };
    const { gateway, server } = setup({ request: () => reply });
    assert.deepEqual(await gateway.settings.testModel('m 1/2'), reply);
    assert.deepEqual(server.requests, [{ method: 'POST', path: PREFIX + '/models/' + encodeURIComponent('m 1/2') + '/test', body: undefined }]);
  });

  test('[待原生验收] desktop.pickFiles：无选择返回空数组，非数组判为无效响应', async () => {
    const none = setup({ desktop: () => null });
    assert.deepEqual(await none.gateway.desktop.pickFiles(), []);
    assert.deepEqual(none.server.desktops, [{ action: 'pick-files', payload: undefined }]);
    assert.equal(none.server.requests.length, 0);

    const attachment = { id: 'a1', name: 'a.txt', kind: 'file', path: 'C:/Work/Alpha/a.txt' };
    const picked = setup({ desktop: () => [attachment] });
    assert.deepEqual(await picked.gateway.desktop.pickFiles(), [attachment]);

    const invalid = setup({ desktop: () => 'a.txt' });
    assert.equal((await gatewayError(() => invalid.gateway.desktop.pickFiles())).code, 'invalid_response');

    const failed = setup({ desktop: () => { throw new Error('dialog crashed'); } });
    const failedError = await gatewayError(() => failed.gateway.desktop.pickFiles());
    assert.equal(failedError.code, 'desktop_error');
    assert.equal(failedError.retryable, false);
  });

  test('desktop.openIde：无项目走原生选择器，有项目先查工作区再传 workspace', async () => {
    const cancelled = setup({ desktop: () => ({ cancelled: true }) });
    assert.equal(await cancelled.gateway.desktop.openIde(), undefined);
    assert.deepEqual(cancelled.server.desktops, [{ action: 'open-ide', payload: undefined }]);
    assert.equal(cancelled.server.requests.length, 0);

    const project = { id: 'p1', name: 'Alpha', path: 'C:/Work/Alpha', lastOpenedAt: '2026-10-29T00:00:00.000Z', sessions: 0 };
    const opened = setup({ request: () => [project], desktop: () => undefined });
    assert.equal(await opened.gateway.desktop.openIde('p1'), undefined);
    assert.deepEqual(opened.server.desktops, [{ action: 'open-ide', payload: { workspace: 'C:/Work/Alpha' } }]);

    const missing = setup({ request: () => [project] });
    const missingError = await gatewayError(() => missing.gateway.desktop.openIde('p9'));
    assert.equal(missingError.code, 'not_found');
    assert.equal(missing.server.desktops.length, 0);
  });

  test('desktop.copyText/openDataFolder/version：动作与返回值', async () => {
    const copy = setup({ desktop: () => ({ copied: true }) });
    assert.equal(await copy.gateway.desktop.copyText('hello'), undefined);
    assert.deepEqual(copy.server.desktops, [{ action: 'copy-text', payload: { text: 'hello' } }]);

    const data = setup({ desktop: () => '' });
    assert.equal(await data.gateway.desktop.openDataFolder(), undefined);
    assert.deepEqual(data.server.desktops, [{ action: 'open-data', payload: undefined }]);

    const version = setup({ desktop: () => ({ version: '0.6.1', dataDir: 'C:/data' }) });
    assert.equal(await version.gateway.desktop.version(), '0.6.1');

    for (const value of ['0.6.1', {}, { version: 42 }, null]) {
      const bad = setup({ desktop: () => value });
      assert.equal((await gatewayError(() => bad.gateway.desktop.version())).code, 'invalid_response');
    }
  });
});

// ---------- 错误映射 ----------

describe('BridgeGateway 错误映射', () => {
  test('HTTP >= 400：code/message/retryable 按响应体映射', async () => {
    const cases = [
      { status: 404, body: { code: 'not_found', error: '没有该会话' }, code: 'not_found', message: '没有该会话', retryable: false },
      { status: 409, body: { code: 'busy', error: '会话运行中' }, code: 'busy', message: '会话运行中', retryable: false },
      { status: 500, body: { code: 'internal', error: '内核错误' }, code: 'internal', message: '内核错误', retryable: true },
      { status: 503, body: { code: 'unavailable' }, code: 'unavailable', message: 'Request failed with HTTP 503.', retryable: true },
      { status: 408, body: { code: 'timeout' }, code: 'timeout', message: 'Request failed with HTTP 408.', retryable: true },
      { status: 429, body: { code: 'rate_limited' }, code: 'rate_limited', message: 'Request failed with HTTP 429.', retryable: true },
      { status: 400, body: {}, code: 'http_error', message: 'Request failed with HTTP 400.', retryable: false },
      { status: 502, body: { code: 42, error: 17 }, code: 'http_error', message: 'Request failed with HTTP 502.', retryable: true },
    ];
    for (const item of cases) {
      const { gateway } = setup({ request: () => ({ httpStatus: item.status, ...item.body }) });
      const error = await gatewayError(() => gateway.connection());
      assert.equal(error.code, item.code, 'HTTP ' + item.status);
      assert.equal(error.message, item.message, 'HTTP ' + item.status);
      assert.equal(error.retryable, item.retryable, 'HTTP ' + item.status);
    }
  });

  test('传输层拒绝：普通错误映射 transport_error，GatewayError 原样重抛', async () => {
    const failing = setup({ request: () => { throw new Error('socket closed'); } });
    const transportError = await gatewayError(() => failing.gateway.connection());
    assert.equal(transportError.code, 'transport_error');
    assert.match(transportError.message, /socket closed/);
    assert.equal(transportError.retryable, true);

    const original = new GatewayError('busy', '已有运行中的请求', false);
    const rethrown = setup({ request: () => { throw original; } });
    const again = await gatewayError(() => rethrown.gateway.connection());
    assert.equal(again, original, 'GatewayError 必须原样重抛');
  });

  test('desktop 拒绝：映射 desktop_error 且 retryable 为 false', async () => {
    const failing = setup({ desktop: () => { throw new Error('dialog failed'); } });
    const error = await gatewayError(() => failing.gateway.desktop.copyText('x'));
    assert.equal(error.code, 'desktop_error');
    assert.match(error.message, /dialog failed/);
    assert.equal(error.retryable, false);
  });
});

// ---------- 联网检索/抓取：真实产品路由 ----------

describe('BridgeGateway 联网检索/抓取接线', () => {
  test('web.fetch/search 直连真实产品路由，来源状态、来源标签与 DTO 不得被改写', async () => {
    const { gateway, server } = setup({
      request: call => call.path === PREFIX + '/web/fetch'
        ? {
            url: 'https://example.com/page',
            title: 'Example',
            text: '# Example',
            fetchedAt: '2026-10-30T00:00:00.000Z',
            status: 206,
            requestedUrl: 'https://example.com/page',
            contentType: 'text/html',
            trust: 'untrusted',
          }
        : [{ title: 'electron', url: 'https://example.com/e', snippet: 'snippet', source: 'fixture-provider' }],
    });
    const page = await gateway.web.fetch('https://example.com/page');
    assert.deepEqual(server.requests[0], { method: 'POST', path: PREFIX + '/web/fetch', body: { url: 'https://example.com/page' } });
    assert.equal(page.status, 206, '来源页 206 不得被改写成后台请求的 200');
    assert.equal(page.requestedUrl, 'https://example.com/page');
    assert.equal(page.contentType, 'text/html');
    assert.equal(page.trust, 'untrusted');
    const results = await gateway.web.search('electron');
    assert.deepEqual(server.requests[1], { method: 'POST', path: PREFIX + '/web/search', body: { query: 'electron' } });
    assert.equal(results[0]?.source, 'fixture-provider');
    assert.equal(server.desktops.length, 0);
  });

  test('web 错误沿用现有 request() 的映射，原样保留后台 code/message', async () => {
    const { gateway } = setup({ request: () => ({ httpStatus: 409, code: 'NETWORK_DISABLED', error: 'Web search is disabled in Settings.' }) });
    const error = await gatewayError(() => gateway.web.search('electron'));
    assert.equal(error.code, 'NETWORK_DISABLED');
    assert.equal(error.message, 'Web search is disabled in Settings.');
    assert.equal(error.retryable, false);
  });
});

// ---------- 尚未接线的方法 ----------

describe('BridgeGateway 未接线方法', () => {
  test('组合接线后 Web、Inspector、Settings 均到达真实产品路由', async () => {
    const { gateway, server } = setup();
    await gateway.web.fetch('https://example.com');
    await gateway.web.search('electron');
    await gateway.inspector.prompt('s1');
    await gateway.settings.get();
    assert.deepEqual(server.requests.map(call => splitPath(call.path).pathname), [
      PREFIX + '/web/fetch', PREFIX + '/web/search', PREFIX + '/inspector/prompt', PREFIX + '/settings',
    ]);
    assert.equal(server.desktops.length, 0);
  });

  // The former not_wired inventory is covered by positive Inspector, Settings and Web route suites.

  test('公开分组与方法清单保持契约：完整产品接线，不新增方法', () => {
    const { gateway } = setup();
    const groups: { name: string; keys: string[] }[] = [
      { name: 'sessions', keys: ['branch', 'get', 'list', 'promote', 'remove', 'update'] },
      { name: 'chat', keys: ['cancel', 'edit', 'regenerate', 'send', 'sideAsk', 'sideCancel', 'sideClear', 'sideHistory'] },
      { name: 'web', keys: ['fetch', 'search'] },
      { name: 'approvals', keys: ['decide', 'pending'] },
      { name: 'tasks', keys: ['control', 'get'] },
      { name: 'inspector', keys: ['context', 'diffs', 'prompt', 'recall', 'replay', 'requests', 'savePrompt', 'toolDetail', 'tools', 'trace'] },
      { name: 'metrics', keys: ['activity', 'session'] },
      { name: 'workspace', keys: ['addProject', 'commit', 'diagnostics', 'editProject', 'fileDiff', 'files', 'pickSourceFolder', 'projects', 'readFile', 'removeProject', 'search', 'sourceControl', 'terminal', 'writeFile'] },
      { name: 'settings', keys: ['clearHistory', 'discoverModels', 'get', 'instructions', 'mcp', 'mcpCatalog', 'models', 'plugins', 'reconnectMcp', 'removeMcp', 'removeModel', 'saveMcp', 'saveModel', 'skills', 'testModel', 'toggleSkill', 'update'] },
      { name: 'desktop', keys: ['copyText', 'droppedFiles', 'officeFile', 'openDataFolder', 'openIde', 'pickFiles', 'version'] },
    ];
    const surface = gateway as unknown as Record<string, Record<string, unknown>>;
    for (const group of groups) {
      const members = surface[group.name];
      assert.ok(members !== null && typeof members === 'object', group.name + ' 分组必须存在');
      assert.deepEqual(Object.keys(members).sort(), group.keys, group.name + ' 的方法清单必须与 contract 一致，不得新增方法');
      for (const key of group.keys) assert.equal(typeof members[key], 'function', group.name + '.' + key + ' 必须是方法');
    }
    assert.equal(typeof gateway.connection, 'function');
    assert.equal(typeof gateway.subscribe, 'function');
    assert.equal(gateway.kind, 'bridge');
  });
});

// ---------- 事件订阅（使用确定性时钟） ----------

describe('BridgeGateway 事件订阅', () => {
  test('默认 eventPageSize=200、pollIntervalMs=1000，每个间隔只轮询一次', async () => {
    const timers = new FakeTimers();
    const { gateway, requests } = eventsHarness(timers, () => pageOf([], 0));
    const delivered: number[] = [];
    const off = gateway.subscribe(recordFixture(delivered));
    assert.equal(typeof off, 'function');
    await settle(timers);
    assert.equal(requests.length, 1);
    const first = splitPath(requests[0].path);
    assert.equal(first.pathname, PREFIX + '/events');
    assert.equal(first.query.get('cursor'), '0');
    assert.equal(first.query.get('limit'), '200');
    await timers.advance(999);
    assert.equal(requests.length, 1, '未到间隔不得轮询');
    await timers.advance(1);
    assert.equal(requests.length, 2);
    await timers.advance(3000);
    assert.equal(requests.length, 5);
    assert.ok(requests.every(call => call.method === 'GET' && call.body === undefined));
    assert.deepEqual(delivered, []);
    off();
    assert.equal(timers.size(), 0, '最后一个监听退订后清除定时器');
  });

  test('连续满页立即续拉；多个监听共享一次请求且每个事件只投递一次', async () => {
    const timers = new FakeTimers();
    const { gateway, requests } = eventsHarness(timers, ({ index }) => {
      if (index === 0) return pageOf([1, 2], 2);
      if (index === 1) return pageOf([3], 3);
      return pageOf([4], 4);
    }, { pollIntervalMs: 1000, eventPageSize: 2 });
    const seenA: number[] = [];
    const seenB: number[] = [];
    const offA = gateway.subscribe(recordFixture(seenA));
    const offB = gateway.subscribe(recordFixture(seenB));
    await settle(timers);
    assert.deepEqual(seenA, [1, 2, 3]);
    assert.deepEqual(seenB, [1, 2, 3]);
    assert.equal(requests.length, 2, '满页立即续拉且两个监听共享同一请求');
    assert.deepEqual(requests.map(call => splitPath(call.path).query.get('cursor')), ['0', '2']);
    assert.deepEqual(requests.map(call => splitPath(call.path).query.get('limit')), ['2', '2']);
    offA();
    await timers.advance(1000);
    assert.deepEqual(seenA, [1, 2, 3], '已退订的监听不再收到事件');
    assert.deepEqual(seenB, [1, 2, 3, 4]);
    offB();
    offB();
    assert.equal(timers.size(), 0);
  });

  test('重复 id 不重复投递（跨页与后续轮询）', async () => {
    const timers = new FakeTimers();
    const { gateway, requests } = eventsHarness(timers, ({ index }) => {
      if (index === 0) return pageOf([1, 2], 2);
      if (index === 1) return pageOf([2, 3], 3);
      if (index === 2) return pageOf([], 3);
      if (index === 3) return pageOf([3, 4], 4);
      return pageOf([], 4);
    }, { pollIntervalMs: 1000, eventPageSize: 2 });
    const delivered: number[] = [];
    gateway.subscribe(recordFixture(delivered));
    await settle(timers);
    assert.deepEqual(delivered, [1, 2, 3]);
    await timers.advance(1000);
    await settle(timers);
    assert.deepEqual(delivered, [1, 2, 3, 4]);
    assert.deepEqual(requests.map(call => splitPath(call.path).query.get('cursor')), ['0', '2', '3', '3', '4']);
  });

  test('最后退订后重新订阅：从已存游标续拉，不重放历史', async () => {
    const timers = new FakeTimers();
    const { gateway, requests } = eventsHarness(timers, ({ index }) => (index === 0 ? pageOf([1, 2], 2) : pageOf([], 2)), { pollIntervalMs: 1000, eventPageSize: 2 });
    const first: number[] = [];
    const off = gateway.subscribe(recordFixture(first));
    await settle(timers);
    assert.deepEqual(first, [1, 2]);
    assert.equal(requests.length, 2);
    off();
    await timers.advance(10_000);
    assert.equal(requests.length, 2, '最后退订后停止轮询');
    const resumed: number[] = [];
    gateway.subscribe(recordFixture(resumed));
    await settle(timers);
    assert.equal(requests.length, 3);
    const cursor = splitPath(requests[2].path).query.get('cursor');
    assert.equal(cursor, '2', '重新订阅从已存游标开始');
    assert.deepEqual(resumed, [], '不重放已投递历史');
  });

  test('reset：通知 onStreamError，重置去重基线并按 earliest-1 立即重拉', async () => {
    const timers = new FakeTimers();
    const errors: GatewayError[] = [];
    const { gateway, requests } = eventsHarness(timers, ({ index }) => {
      if (index === 0) return pageOf([5, 6], 6, { earliest: 5 });
      if (index === 1) return pageOf([7], 7, { earliest: 5 });
      if (index === 2) return pageOf([50], 50, { earliest: 1, reset: true });
      if (index === 3) return pageOf([1, 2], 2, { earliest: 1 });
      return pageOf([3], 3, { earliest: 1 });
    }, { pollIntervalMs: 1000, eventPageSize: 2, onStreamError: error => errors.push(error) });
    const delivered: number[] = [];
    gateway.subscribe(recordFixture(delivered));
    await settle(timers);
    assert.deepEqual(delivered, [5, 6, 7]);
    await timers.advance(1000);
    await settle(timers);
    assert.deepEqual(delivered, [5, 6, 7, 1, 2, 3], '重置基线后 earliest 起的事件重新投递一次');
    assert.ok(!delivered.includes(50), 'reset 响应中的事件不直接投递');
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, 'events_reset');
    assert.deepEqual(requests.map(call => splitPath(call.path).query.get('cursor')), ['0', '6', '7', '0', '2']);
  });

  test('轮询失败：保留游标，按 pollIntervalMs 起步并翻倍退避，成功后重置', async () => {
    const timers = new FakeTimers();
    const errors: GatewayError[] = [];
    const { gateway, requests } = eventsHarness(timers, ({ index }) => {
      if (index === 1 || index === 2) throw new Error('offline');
      return pageOf([], 0);
    }, { pollIntervalMs: 1000, eventPageSize: 2, onStreamError: error => errors.push(error) });
    gateway.subscribe(() => undefined);
    await settle(timers);
    assert.equal(requests.length, 1);
    await timers.advance(1000);
    assert.equal(requests.length, 2);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, 'transport_error');
    assert.match(errors[0]?.message ?? '', /offline/);
    await timers.advance(999);
    assert.equal(requests.length, 2, '第一次失败后等待 pollIntervalMs');
    await timers.advance(1);
    assert.equal(requests.length, 3);
    assert.equal(errors.length, 2);
    await timers.advance(1999);
    assert.equal(requests.length, 3, '连续失败间隔翻倍');
    await timers.advance(1);
    assert.equal(requests.length, 4);
    await timers.advance(999);
    assert.equal(requests.length, 4);
    await timers.advance(1);
    assert.equal(requests.length, 5, '成功后退避重置为 pollIntervalMs');
    assert.ok(requests.every(call => splitPath(call.path).query.get('cursor') === '0'), '失败不推进游标');
  });

  test('退订后忽略迟到结果；在途请求期间不重入，也不重新排程', async () => {
    const timers = new FakeTimers();
    const pending = deferred<EventPage>();
    const { gateway, requests } = eventsHarness(timers, ({ index }) => (index === 0 ? pageOf([], 0) : pending.promise), { pollIntervalMs: 1000, eventPageSize: 2 });
    const delivered: number[] = [];
    const off = gateway.subscribe(recordFixture(delivered));
    await settle(timers);
    assert.equal(requests.length, 1);
    await timers.advance(1000);
    assert.equal(requests.length, 2);
    await timers.advance(1000);
    await timers.advance(1000);
    assert.equal(requests.length, 2, '在途请求未完成时不得发起第二个请求');
    off();
    off();
    pending.resolve(pageOf([9], 9));
    await settle(timers);
    assert.deepEqual(delivered, [], '退订后的迟到结果不投递');
    assert.equal(requests.length, 2);
    assert.equal(timers.size(), 0);
    await timers.advance(10_000);
    assert.equal(requests.length, 2, '退订后不再排程');
  });

  test('连续满页最多追赶 50 页，之后等待 pollIntervalMs 而不是热循环', async () => {
    const timers = new FakeTimers();
    const errors: GatewayError[] = [];
    const { gateway, requests } = eventsHarness(timers, ({ index }) => {
      if (index >= 56) throw new Error('burst runaway');
      return pageOf([index + 1], index + 1);
    }, { pollIntervalMs: 1000, eventPageSize: 1, onStreamError: error => errors.push(error) });
    gateway.subscribe(() => undefined);
    await settle(timers);
    assert.equal(errors.length, 0, '未达到上限前不应报错');
    assert.ok(requests.length >= 50 && requests.length <= 51, '连续追赶页数应受 50 页上限约束，实际 ' + requests.length);
    assert.ok(timers.size() >= 1, '达到上限后应等待 pollIntervalMs 再继续');
  });
});

// ---------- 事件流健康与历史重置可见性（修正轮新增） ----------

describe('BridgeGateway 事件流健康与历史重置', () => {
  test('轮询失败与恢复：每个监听恰好一次 offline / online，重复失败不重复通知', async () => {
    const timers = new FakeTimers();
    const errors: GatewayError[] = [];
    const { gateway, requests } = eventsHarness(timers, ({ index }) => {
      if (index === 0) return pageOf([1], 1);
      if (index === 1) throw new Error('link down');
      if (index === 2) return { httpStatus: 503, code: 'unavailable', error: 'backend busy' };
      if (index === 3) return pageOf([2], 2);
      if (index === 4) return { httpStatus: 503, code: 'unavailable', error: 'backend busy' };
      if (index === 5) return pageOf([3], 3);
      return pageOf([], 3);
    }, { pollIntervalMs: 1000, eventPageSize: 2, onStreamError: error => errors.push(error) });
    const eventsA: GatewayEvent[] = [];
    const eventsB: GatewayEvent[] = [];
    const offA = gateway.subscribe(event => eventsA.push(event));
    const offB = gateway.subscribe(event => eventsB.push(event));

    await settle(timers);
    assert.deepEqual(fixtureIds(eventsA), [1]);
    assert.equal(connectionEvents(eventsA).length, 0, '初次成功轮询只是常态，不得发 connection.changed');

    await timers.advance(1000);
    assert.equal(requests.length, 2);
    assert.equal(errors.length, 1);
    const firstOffline = connectionEvents(eventsA);
    assert.equal(firstOffline.length, 1, '第一次失败必须向每个监听各发一次 offline');
    assert.equal(firstOffline[0].connection.status, 'offline');
    assert.equal(firstOffline[0].connection.demo, false);
    assert.match(firstOffline[0].connection.message ?? '', /link down/, '离线通知必须带上真实传输错误文本');
    assert.equal(connectionEvents(eventsB).length, 1, '在线监听都要收到，不能只发给第一个');

    await timers.advance(1000);
    assert.equal(requests.length, 3);
    assert.equal(errors.length, 2);
    assert.equal(connectionEvents(eventsA).length, 1, '恢复前的重复失败不得重复发 offline');

    await timers.advance(2000);
    assert.equal(requests.length, 4);
    const recovered = connectionEvents(eventsA);
    assert.equal(recovered.length, 2, '恢复必须发且只发一次 connection.changed');
    assert.equal(recovered[1].connection.status, 'online');
    assert.equal(recovered[1].connection.demo, false);
    assert.deepEqual(fixtureIds(eventsA), [1, 2], '恢复后既有流事件投递照常');
    assert.deepEqual(fixtureIds(eventsB), [1, 2]);

    await timers.advance(1000);
    assert.equal(requests.length, 5);
    assert.equal(errors.length, 3);
    const secondOffline = connectionEvents(eventsA);
    assert.equal(secondOffline.length, 3);
    assert.equal(secondOffline[2].connection.status, 'offline');
    assert.match(secondOffline[2].connection.message ?? '', /backend busy/, 'HTTP 错误的文本同样必须可见');

    await timers.advance(1000);
    assert.equal(requests.length, 6);
    const finalChanges = connectionEvents(eventsA);
    assert.equal(finalChanges.length, 4);
    assert.equal(finalChanges[3].connection.status, 'online');
    assert.deepEqual(fixtureIds(eventsA), [1, 2, 3], '每次恢复后既有流事件继续投递');
    assert.deepEqual(
      connectionEvents(eventsB).map(event => event.connection.status),
      ['offline', 'online', 'offline', 'online'],
      '每个监听收到同样的连接变化序列',
    );

    offA();
    offB();
    assert.equal(timers.size(), 0, '最后退订后不残留计时器');
  });

  test('历史重置：可见且去重的 warn 通知，按 earliest-1 重拉，不谎报恢复', async () => {
    const timers = new FakeTimers();
    const errors: GatewayError[] = [];
    const { gateway, requests } = eventsHarness(timers, ({ index }) => {
      if (index === 0) return pageOf([5], 5, { earliest: 5 });
      if (index === 1) return pageOf([50], 50, { earliest: 1, reset: true });
      if (index === 2) return pageOf([1], 1, { earliest: 1 });
      if (index === 3) return pageOf([60], 60, { earliest: 1, reset: true });
      if (index === 4) return pageOf([2], 2, { earliest: 1 });
      if (index === 5) return pageOf([70], 70, { earliest: 1, reset: true });
      if (index === 6) return pageOf([3], 3, { earliest: 1 });
      return pageOf([], 3, { earliest: 1 });
    }, { pollIntervalMs: 1000, eventPageSize: 2, onStreamError: error => errors.push(error) });
    const events: GatewayEvent[] = [];
    const off = gateway.subscribe(event => events.push(event));
    const cursors = (): (string | null)[] => requests.map(call => splitPath(call.path).query.get('cursor'));

    await settle(timers);
    assert.deepEqual(fixtureIds(events), [5]);

    await timers.advance(1000);
    assert.deepEqual(cursors(), ['0', '5', '0'], '重置响应的事件不得投递，必须按 earliest-1 立即重拉');
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, 'events_reset');

    const toasts = resetToasts(events);
    assert.equal(toasts.length, 1, '历史截断必须对用户可见，不能只回调 onStreamError');
    assert.equal(toasts[0].tone, 'warn');
    assert.equal(toasts[0].title, '事件历史已截断');
    const detail = toasts[0].detail;
    assert.equal(typeof detail, 'string', '通知必须带 detail 说明缺口后果');
    assert.ok((detail ?? '').length > 0);
    assert.match(detail ?? '', /不完整|缺失|incomplete/i, 'detail 必须说明当前状态可能不完整');
    assert.match(detail ?? '', /快照|重新同步|重新拉取|resync|snapshot/i, 'detail 必须说明需要快照/重新同步');
    assert.match(detail ?? '', /会话|审批|session|approval/i, 'detail 必须点明受影响的是会话/审批状态');
    assert.deepEqual(fixtureIds(events), [5, 1], '重置响应中的替换事件不投递，重拉后的事件才投递');
    assert.ok(!fixtureIds(events).includes(50));
    assert.equal(connectionEvents(events).length, 0, '重置不是连接恢复，不得发 online 谎报已恢复');

    await timers.advance(1000);
    assert.deepEqual(cursors(), ['0', '5', '0', '1', '0']);
    assert.deepEqual(fixtureIds(events), [5, 1, 2]);
    assert.equal(resetToasts(events).length, 1, '同一订阅内再次截断不得重复弹通知（去重）');
    assert.ok(!fixtureIds(events).includes(60));

    off();
    assert.equal(timers.size(), 0);
    await timers.advance(10_000);
    assert.equal(requests.length, 5, '退订后不再轮询');

    const fresh: GatewayEvent[] = [];
    const offFresh = gateway.subscribe(event => fresh.push(event));
    await settle(timers);
    assert.deepEqual(cursors(), ['0', '5', '0', '1', '0', '2', '0'], '新订阅从已存游标续拉，截断后仍按 earliest-1 重拉');
    assert.equal(resetToasts(fresh).length, 1, '完整退订后的新订阅可以再次看到截断通知（去重只作用于单次订阅）');
    assert.equal(resetToasts(events).length, 1, '旧监听不再收到通知');
    assert.deepEqual(fixtureIds(fresh), [3]);
    assert.ok(!fixtureIds(fresh).includes(70));
    offFresh();
    assert.equal(timers.size(), 0);
  });

  test('onStreamError 抛错：首次失败后轮询仍继续并投递正常事件', async () => {
    const timers = new FakeTimers();
    const errors: GatewayError[] = [];
    const watch = watchUnhandledRejections();
    try {
      const { gateway, requests } = eventsHarness(timers, ({ index }) => {
        if (index === 0) throw new Error('link down');
        if (index === 1) return pageOf([1], 1);
        return pageOf([], 1);
      }, { pollIntervalMs: 1000, eventPageSize: 2, onStreamError: error => { errors.push(error); throw new Error('callback exploded'); } });
      const delivered: number[] = [];
      const off = gateway.subscribe(recordFixture(delivered));

      await settle(timers);
      assert.equal(requests.length, 1);
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.code, 'transport_error');
      assert.deepEqual(watch.rejections, [], 'onStreamError 抛错不得漏成未处理的 Promise 拒绝');
      assert.ok(timers.size() >= 1, 'onStreamError 抛错后仍必须排下一次轮询');

      await timers.advance(1000);
      assert.equal(requests.length, 2, '回调抛错不得永久停止轮询');
      assert.deepEqual(delivered, [1], '恢复后的正常事件照常投递');

      await timers.advance(1000);
      assert.equal(requests.length, 3, '后续轮询照常进行');
      off();
      assert.equal(timers.size(), 0, '最后退订后不残留计时器');
      await timers.advance(10_000);
      assert.equal(requests.length, 3);
    } finally {
      watch.stop();
    }
  });

  test('onStreamError 在 reset 路径抛错：立即重拉与正常投递继续，不热循环', async () => {
    const timers = new FakeTimers();
    const errors: GatewayError[] = [];
    const watch = watchUnhandledRejections();
    try {
      const { gateway, requests } = eventsHarness(timers, ({ index }) => {
        if (index === 0) return pageOf([5], 5, { earliest: 5 });
        if (index === 1) return pageOf([50], 50, { earliest: 1, reset: true });
        return pageOf([1], 1, { earliest: 1 });
      }, { pollIntervalMs: 1000, eventPageSize: 2, onStreamError: error => { errors.push(error); throw new Error('callback exploded'); } });
      const events: GatewayEvent[] = [];
      const off = gateway.subscribe(event => events.push(event));

      await settle(timers);
      await timers.advance(1000);
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.code, 'events_reset');
      assert.equal(requests.length, 3, '回调抛错后仍必须按 earliest-1 立即重拉');
      assert.deepEqual(requests.map(call => splitPath(call.path).query.get('cursor')), ['0', '5', '0']);
      assert.deepEqual(fixtureIds(events), [5, 1], '重置响应事件不投递，重拉后正常投递');
      assert.equal(resetToasts(events).length, 1);
      assert.deepEqual(watch.rejections, [], 'onStreamError 抛错不得漏成未处理的 Promise 拒绝');
      assert.equal(timers.size(), 1, '重拉后必须回到正常间隔，不能变成无间隔热循环');

      await timers.advance(999);
      assert.equal(requests.length, 3, '不得无间隔连续重拉');
      await timers.advance(1);
      assert.equal(requests.length, 4);
      assert.deepEqual(fixtureIds(events), [5, 1], '重复 id 不重复投递的规则照旧');
      off();
      assert.equal(timers.size(), 0);
    } finally {
      watch.stop();
    }
  });
});
