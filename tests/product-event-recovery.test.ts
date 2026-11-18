/**
 * 产品事件快照 / 重同步契约测试 —— 真实后端 + 真实 HTTP + 真实 ProductStore + 真实 BridgeGateway + 真实 reducer。
 *
 * 覆盖：
 *   1. /events 的 epoch 在同一 product.sqlite 内稳定，数据库被替换后变化；高游标对空库必须 reset，快照为空。
 *   2. 替换后的库事件更多、游标仍重叠时 /events 不报 reset，但 epoch 仍必须变化。
 *   3. GET /snapshot 的字段形状、与既有路由的 deepEqual、焦点会话投影、校验/鉴权/未知路由。
 *   4. 会话首页有界（<=100）且与 /sessions 分页契约一致，不扫描全部会话。
 *   5. 保留窗口外的游标必须 reset；快照反映删除会话、已解决审批与被编辑截断的消息尾部。
 *   6. 快照 cursor 是回放栅栏：之后的事件 id 更大，从该 cursor 轮询不重放旧结算。
 *   7. 500 个会话只需 1 次快照 + 4 次补页，所有会话请求 limit<=100。
 *   A-F. BridgeGateway 在真实 HTTP 下的重同步、替换、恢复期间新事件、多页有界、正常增量、失败重试与退订语义。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import test, { after, afterEach } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startBackend } from '../src/app/backend.js';
import { ProductStore } from '../src/product/store.js';
import { HarnessStore } from '../src/harness/store.js';
import type { SessionIndexRecord } from '../src/product/shared.js';
import type { ConnectionInfo, GatewayEvent, SessionDetail, SessionSummary, StateSnapshot } from '../src/frontend/api/types.js';

const tempRoot = path.resolve(process.env.TEMP ?? '.tmp');
const repoRoot = process.cwd();
const bundleDir = path.join(tempRoot, 'event-recovery-bundles');
const removeTree = (target: string): void => rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

interface HttpResult { status: number; body: any }
type Responder = (body: any, index: number) => { content: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] };

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const until = async <T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs = 15000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected state.');
    await pause(20);
  }
};
const sorted = (values: string[]): string[] => [...values].sort();
const retentionEvents = (from: number, count: number): { event: GatewayEvent }[] =>
  Array.from({ length: count }, (_, index) => ({ event: { type: 'notify', tone: 'info', title: 'retention fixture ' + (from + index) } as GatewayEvent }));

const seedRow = (id: string, index: number): SessionIndexRecord => ({
  id, kind: 'chat', mode: 'chat', title: '种子会话 ' + id, status: 'idle', permission: 'ask', modelId: 'default', pinned: false,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - index * 1000).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - index * 1000).toISOString(),
});

const deleteProductStores = (dataDir: string): void => {
  for (const name of readdirSync(dataDir)) if (name.startsWith('product.sqlite')) rmSync(path.join(dataDir, name), { force: true });
};

const seedStore = (dataDir: string, sessions: number, prefix: string, events: number): void => {
  const store = new ProductStore(dataDir);
  try {
    if (events > 0) store.append(retentionEvents(0, events));
    for (let index = 0; index < sessions; index += 1) store.upsertSession(seedRow(prefix + index, index));
  } finally {
    store.close();
  }
};

const setup = async (options: { responder?: Responder; seed?: (dataDir: string) => void } = {}) => {
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(path.join(tempRoot, 'product-event-recovery-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const settings = { dataDir, projectRoot: process.cwd(), mockOptions: { ...(options.responder ? { responder: options.responder } : {}) } };
  options.seed?.(dataDir);
  let backend = await startBackend(settings);
  const http = async (method: string, route: string, input?: unknown): Promise<HttpResult> => {
    const response = await fetch('http://127.0.0.1:' + backend.port + route, {
      method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const stop = async (): Promise<void> => { await backend.close(); };
  const start = async (): Promise<void> => { backend = await startBackend(settings); };
  const close = async (): Promise<void> => { await backend.close(); await pause(50); removeTree(dir); };
  return { dir, dataDir, workspace, settings, http, stop, start, close, current: () => backend };
};
type Env = Awaited<ReturnType<typeof setup>>;

const addProject = async (env: Env, projectPath: string): Promise<string> => {
  const added = await env.http('POST', '/v1/product/workspace/projects', { path: projectPath });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  return added.body.id as string;
};
const sendChat = async (env: Env, text: string, extra: Record<string, unknown> = {}): Promise<{ sessionId: string; messageId: string }> => {
  const sent = await env.http('POST', '/v1/product/chat/send', { mode: 'chat', text, attachments: [], permission: 'ask', modelId: 'default', ...extra });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return sent.body as { sessionId: string; messageId: string };
};
const waitIdle = (env: Env, sessionId: string): Promise<HttpResult> =>
  until(async () => {
    const value = await env.http('GET', '/v1/product/sessions/' + encodeURIComponent(sessionId));
    return value.status === 200 && ['idle', 'completed', 'failed', 'cancelled'].includes(value.body.status) ? value : undefined;
  });
const detailOf = async (env: Env, id: string): Promise<SessionDetail> => {
  const value = await env.http('GET', '/v1/product/sessions/' + encodeURIComponent(id));
  assert.equal(value.status, 200, JSON.stringify(value.body));
  return value.body as SessionDetail;
};
const snapshotOf = async (env: Env, query = ''): Promise<StateSnapshot> => {
  const value = await env.http('GET', '/v1/product/snapshot' + query);
  assert.equal(value.status, 200, JSON.stringify(value.body));
  return value.body as StateSnapshot;
};
interface ProductEventPage { events: { id: number; event: GatewayEvent }[]; nextCursor: number; earliest: number; reset: boolean; epoch?: string }
const eventPage = async (env: Env, query = ''): Promise<ProductEventPage> => {
  const value = await env.http('GET', '/v1/product/events' + query);
  assert.equal(value.status, 200, JSON.stringify(value.body));
  return value.body as ProductEventPage;
};
const metricsOf = async (env: Env, sessionId: string): Promise<any> => {
  const value = await env.http('GET', '/v1/product/metrics/session?sessionId=' + encodeURIComponent(sessionId));
  assert.equal(value.status, 200, JSON.stringify(value.body));
  return value.body;
};
// 用越界游标触发 reset：reset 页的 nextCursor 就是当前最新事件 id（非 reset 页只是该页最后一条）。
const latestEventId = async (env: Env): Promise<number> => {
  const page = await eventPage(env, '?cursor=9007199254740991&limit=1');
  assert.equal(page.reset, true, '越界游标必须返回 reset:true');
  return page.nextCursor;
};
const waitTaskSettled = (env: Env, taskId: string): Promise<HttpResult> =>
  until(async () => {
    const value = await env.http('GET', '/v1/product/tasks/' + encodeURIComponent(taskId));
    return value.status === 200 && value.body && !['running', 'waiting_approval', 'pending'].includes(value.body.status) ? value : undefined;
  }, 30000);

const queryValue = (requestPath: string, name: string): string | null => {
  const index = requestPath.indexOf('?');
  return index < 0 ? null : new URLSearchParams(requestPath.slice(index + 1)).get(name);
};

interface RecordedCall { method: string; path: string; body?: unknown }
interface NpnLike { request(method: string, requestPath: string, body?: unknown): Promise<any>; desktop(action: string, payload?: unknown): Promise<any> }
interface BridgeHandle { focusSession(sessionId?: string): void; subscribe(listener: (event: GatewayEvent) => void): () => void; connection(): Promise<ConnectionInfo> }
interface StreamError { code: string; message: string; retryable: boolean }
interface RecoveryPatchLike { state: Record<string, any>; removedSessionIds: string[]; focusRemoved: boolean; reloadSessionId?: string }
interface BridgeModules {
  BridgeGateway: new (npn: NpnLike, options?: { pollIntervalMs?: number; onStreamError?: (error: StreamError) => void }) => BridgeHandle;
  applySnapshot: (state: any, snapshot: StateSnapshot) => RecoveryPatchLike;
  applySessionRemoved: (state: any, sessionId: string) => RecoveryPatchLike;
}
let modulesPromise: Promise<BridgeModules> | undefined;
const loadModules = (): Promise<BridgeModules> => {
  modulesPromise ??= (async () => {
    removeTree(bundleDir);
    mkdirSync(bundleDir, { recursive: true });
    await build({
      absWorkingDir: repoRoot,
      entryPoints: [
        { in: 'src/frontend/api/bridge.ts', out: 'bridge' },
        { in: 'src/frontend/app/event-recovery.ts', out: 'event-recovery' },
      ],
      outdir: bundleDir, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
    });
    const bridgeModule = await import(pathToFileURL(path.join(bundleDir, 'bridge.js')).href);
    const recoveryModule = await import(pathToFileURL(path.join(bundleDir, 'event-recovery.js')).href);
    return {
      BridgeGateway: bridgeModule.BridgeGateway as BridgeModules['BridgeGateway'],
      applySnapshot: recoveryModule.applySnapshot as BridgeModules['applySnapshot'],
      applySessionRemoved: recoveryModule.applySessionRemoved as BridgeModules['applySessionRemoved'],
    };
  })();
  return modulesPromise;
};
after(() => { removeTree(bundleDir); });

type SnapshotHook = (call: RecordedCall, response: unknown) => unknown;
interface Transport { npn: NpnLike; calls: RecordedCall[] }
const realTransport = (env: Env, hook?: SnapshotHook): Transport => {
  const calls: RecordedCall[] = [];
  const npn: NpnLike = {
    async request(method: string, requestPath: string, body?: unknown): Promise<any> {
      const call: RecordedCall = { method, path: requestPath, body };
      calls.push(call);
      const response = await fetch('http://127.0.0.1:' + env.current().port + requestPath, {
        method,
        headers: { Authorization: 'Bearer ' + env.current().token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      const parsed: any = text ? JSON.parse(text) : undefined;
      const result: unknown = response.ok ? parsed : { ...(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}), httpStatus: response.status };
      const replaced = call.path.startsWith('/v1/product/snapshot') && hook ? await hook(call, result) : undefined;
      return replaced === undefined ? result : replaced;
    },
    async desktop(): Promise<unknown> { return undefined; },
  };
  return { npn, calls };
};
const pendingStops: Array<() => void> = [];
afterEach(() => { while (pendingStops.length > 0) pendingStops.pop()!(); });
const bridgeFor = async (env: Env, options: { pollIntervalMs?: number; hook?: SnapshotHook } = {}) => {
  const { BridgeGateway } = await loadModules();
  const transport = realTransport(env, options.hook);
  const streamErrors: StreamError[] = [];
  const gateway = new BridgeGateway(transport.npn, {
    pollIntervalMs: options.pollIntervalMs ?? 10,
    onStreamError: error => streamErrors.push({ code: error.code, message: error.message, retryable: Boolean(error.retryable) }),
  });
  const subscribe = gateway.subscribe.bind(gateway);
  gateway.subscribe = listener => {
    const stop = subscribe(listener);
    pendingStops.push(stop);
    return stop;
  };
  return { gateway, calls: transport.calls, streamErrors };
};
type Bridge = Awaited<ReturnType<typeof bridgeFor>>;

const record = (bucket: GatewayEvent[]) => (event: GatewayEvent): void => { bucket.push(event); };
const findSnapshot = (events: GatewayEvent[]): { index: number; snapshot: StateSnapshot } | undefined => {
  const index = events.findIndex(event => event.type === 'state.snapshot');
  return index < 0 ? undefined : { index, snapshot: (events[index] as Extract<GatewayEvent, { type: 'state.snapshot' }>).snapshot };
};
const findNotify = (events: GatewayEvent[], title: string): { index: number; event: Extract<GatewayEvent, { type: 'notify' }> } | undefined => {
  const index = events.findIndex(event => event.type === 'notify' && event.title === title);
  return index < 0 ? undefined : { index, event: events[index] as Extract<GatewayEvent, { type: 'notify' }> };
};
const connectionChanges = (events: GatewayEvent[]): Extract<GatewayEvent, { type: 'connection.changed' }>[] =>
  events.filter((event): event is Extract<GatewayEvent, { type: 'connection.changed' }> => event.type === 'connection.changed');
const referencesSession = (event: GatewayEvent, sessionId: string): boolean => {
  switch (event.type) {
    case 'session.upsert': return event.session.id === sessionId;
    case 'session.removed': return event.sessionId === sessionId;
    case 'message.upsert': return event.sessionId === sessionId;
    case 'task.updated': return event.sessionId === sessionId;
    case 'metrics.updated': return event.sessionId === sessionId;
    case 'inspector.invalidated': return event.sessionId === sessionId;
    case 'approval.requested': return event.approval.sessionId === sessionId;
    case 'approval.resolved': return false;
    default: return false;
  }
};
const requestsTo = (calls: RecordedCall[], suffix: string): RecordedCall[] => calls.filter(call => call.path.split('?')[0] === '/v1/product' + suffix);
const waitCaughtUp = async (env: Env, bridge: Bridge): Promise<number> => {
  const latest = await latestEventId(env);
  await until(() => bridge.calls.some(call => call.path.startsWith('/v1/product/events') && queryValue(call.path, 'cursor') === String(latest)), 15000);
  await pause(60);
  return latest;
};

test('1 GET /events 的 epoch 同库重启稳定、替换后变化；高游标对空库 reset 且快照为空', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const first = await eventPage(env, '?cursor=0');
  assert.equal(typeof first.epoch, 'string', '/events 必须返回 epoch 字符串');
  assert.ok(first.epoch && first.epoch.length > 0);
  const epoch1 = first.epoch;
  await env.stop();
  await env.start();
  const resumed = await eventPage(env, '?cursor=0');
  assert.equal(resumed.epoch, epoch1, '同一 product.sqlite 重启后 epoch 必须稳定');

  await env.stop();
  deleteProductStores(env.dataDir);
  await env.start();
  const replaced = await eventPage(env, '?cursor=1');
  assert.equal(replaced.reset, true, '空库 + 高游标必须返回 reset:true');
  assert.equal(typeof replaced.epoch, 'string');
  assert.notEqual(replaced.epoch, epoch1, '替换 product.sqlite 后 epoch 必须变化');

  const snapshot = await snapshotOf(env, '?sessionId=' + encodeURIComponent('deleted-session'));
  assert.equal(snapshot.cursor, 0);
  assert.equal(snapshot.epoch, replaced.epoch);
  assert.deepEqual(snapshot.sessions, { items: [] });
  assert.deepEqual(snapshot.approvals, []);
  assert.equal(snapshot.sessionId, 'deleted-session');
  assert.equal(snapshot.session, null);
  assert.equal('task' in snapshot, false);
  assert.equal('metrics' in snapshot, false);
});

test('2 替换后的库事件更多且游标重叠时 /events 不报 reset，但 epoch 仍变化', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const first = await eventPage(env, '?cursor=0');
  assert.ok(first.epoch);
  const epoch1 = first.epoch;
  const sent = await sendChat(env, '重叠游标替换前的会话');
  await waitIdle(env, sent.sessionId);
  const before = await eventPage(env, '?cursor=0&limit=200');
  const remembered = Math.max(1, before.nextCursor);
  assert.ok(remembered >= 1);

  await env.stop();
  deleteProductStores(env.dataDir);
  seedStore(env.dataDir, 0, 'unused-', remembered + 3);
  await env.start();

  const page = await eventPage(env, '?cursor=' + remembered + '&limit=50');
  assert.equal(page.reset, false, '旧游标既未越界也未低于保留窗口时不应报 reset');
  assert.equal(typeof page.epoch, 'string');
  assert.notEqual(page.epoch, epoch1, '库被替换后即使游标重叠，epoch 也必须变化');
  const snapshot = await snapshotOf(env);
  assert.equal(snapshot.epoch, page.epoch);
  assert.equal(snapshot.cursor, remembered + 3, '快照水位必须是替换后库的最新事件 id');
});

test('3 GET /snapshot 形状、与既有路由 deepEqual、焦点投影、校验与鉴权', { timeout: 120000 }, async t => {
  const responder: Responder = body => body.messages.some((message: any) => message.role === 'tool')
    ? { content: '写入完成' }
    : JSON.stringify(body.messages ?? []).includes('SNAPSHOT-COWORK')
      ? { content: '', toolCalls: [{ id: 'write-snapshot', name: 'write_file', arguments: { path: 'snapshot.txt', content: 'snapshot approval' } }] }
      : { content: '快照测试回答' };
  const env = await setup({ responder });
  t.after(() => env.close());
  const anonymous = await fetch('http://127.0.0.1:' + env.current().port + '/v1/product/snapshot');
  assert.equal(anonymous.status, 401);

  const projectId = await addProject(env, env.workspace);
  const chatA = await sendChat(env, '快照焦点会话 A');
  await waitIdle(env, chatA.sessionId);
  const chatB = await sendChat(env, '快照列表会话 B');
  await waitIdle(env, chatB.sessionId);
  const work = await env.http('POST', '/v1/product/chat/send', { mode: 'cowork', text: 'SNAPSHOT-COWORK 写入快照审批文件', attachments: [], permission: 'ask', modelId: 'default', projectId });
  assert.equal(work.status, 200, JSON.stringify(work.body));
  const taskId = work.body.sessionId as string;
  await until(async () => {
    const value = await env.http('GET', '/v1/product/sessions/' + encodeURIComponent(taskId));
    return value.status === 200 ? value : undefined;
  });
  const approval = await until(async () => {
    const value = await env.http('GET', '/v1/product/approvals?sessionId=' + encodeURIComponent(taskId));
    return value.status === 200 && value.body.length ? value.body[0] : undefined;
  });
  assert.ok(approval.id);

  const list = await env.http('GET', '/v1/product/sessions?limit=100');
  const pending = await env.http('GET', '/v1/product/approvals');
  const snapshot = await snapshotOf(env);
  assert.deepEqual(Object.keys(snapshot).sort(), ['approvals', 'cursor', 'epoch', 'sessions'], '无焦点时不得多出 session/task/metrics 包装字段');
  assert.equal(Number.isSafeInteger(snapshot.cursor) && snapshot.cursor >= 0, true);
  assert.equal(typeof snapshot.epoch, 'string');
  assert.deepEqual(snapshot.sessions, { items: list.body.items, ...(list.body.nextCursor ? { nextCursor: list.body.nextCursor } : {}) });
  assert.deepEqual(snapshot.approvals, pending.body);
  assert.ok(snapshot.approvals.length <= 200);

  const narrow = await snapshotOf(env, '?limit=50');
  const narrowList = await env.http('GET', '/v1/product/sessions?limit=50');
  assert.deepEqual(narrow.sessions, { items: narrowList.body.items, ...(narrowList.body.nextCursor ? { nextCursor: narrowList.body.nextCursor } : {}) });

  const chatFocus = await snapshotOf(env, '?sessionId=' + encodeURIComponent(chatA.sessionId) + '&limit=100');
  assert.equal(chatFocus.sessionId, chatA.sessionId);
  assert.deepEqual(chatFocus.session, await detailOf(env, chatA.sessionId));
  assert.equal('task' in chatFocus, false, 'Chat 焦点不得带 task 字段');
  assert.deepEqual(chatFocus.metrics, await metricsOf(env, chatA.sessionId));

  const workDetail = await env.http('GET', '/v1/product/sessions/' + encodeURIComponent(taskId));
  const workTask = await env.http('GET', '/v1/product/tasks/' + encodeURIComponent(taskId));
  const workFocus = await snapshotOf(env, '?sessionId=' + encodeURIComponent(taskId));
  assert.equal(workFocus.sessionId, taskId);
  assert.deepEqual(workFocus.session, workDetail.body);
  assert.deepEqual(workFocus.task, workTask.body);
  assert.deepEqual(workFocus.metrics, await metricsOf(env, taskId));

  const unknown = await snapshotOf(env, '?sessionId=' + encodeURIComponent('missing-session-id'));
  assert.equal(unknown.sessionId, 'missing-session-id');
  assert.equal(unknown.session, null);
  assert.equal('task' in unknown, false);
  assert.equal('metrics' in unknown, false);

  for (const [route, label] of [
    ['/v1/product/snapshot?limit=0', 'limit 0'],
    ['/v1/product/snapshot?limit=101', 'limit 101'],
    ['/v1/product/snapshot?limit=abc', 'limit abc'],
    ['/v1/product/snapshot?limit=1.5', 'limit 1.5'],
    ['/v1/product/snapshot?sessionId=', '空 sessionId'],
    ['/v1/product/snapshot?sessionId=' + 'x'.repeat(201), '超长 sessionId'],
  ] as const) {
    const rejected = await env.http('GET', route);
    assert.equal(rejected.status, 400, label + ' 必须返回 400：' + JSON.stringify(rejected.body));
    assert.equal(rejected.body.code, 'validation', label + ' 必须返回 validation code');
  }
  const unknownRoute = await env.http('GET', '/v1/product/snapshot-unknown-route');
  assert.equal(unknownRoute.status, 404);
  assert.equal(unknownRoute.body.code, 'not_found');
});

test('4 会话首页有界（<=100）且 nextCursor 与 /sessions 分页一致，不返回全部会话', { timeout: 120000 }, async t => {
  const total = 125;
  const env = await setup({ seed: dataDir => seedStore(dataDir, total, 'seed-', 0) });
  t.after(() => env.close());
  const snapshot = await snapshotOf(env);
  assert.equal(snapshot.sessions.items.length, 100, '快照只返回第一页，不能扫描全部会话');
  assert.equal(typeof snapshot.sessions.nextCursor, 'string');
  const list = await env.http('GET', '/v1/product/sessions?limit=100');
  assert.deepEqual(snapshot.sessions, { items: list.body.items, nextCursor: list.body.nextCursor });

  const seen = list.body.items.map((item: SessionSummary) => item.id);
  const second = await env.http('GET', '/v1/product/sessions?cursor=' + encodeURIComponent(list.body.nextCursor) + '&limit=100');
  assert.equal(second.status, 200);
  seen.push(...second.body.items.map((item: SessionSummary) => item.id));
  assert.equal(new Set(seen).size, total, '同一个 nextCursor 必须能继续取到全部会话');
  assert.equal(second.body.nextCursor, undefined);
  assert.ok(snapshot.sessions.items.length < total);
});

test('5 保留窗口外游标 reset；快照反映删除会话、已解决审批与编辑截断的消息尾部', { timeout: 180000 }, async t => {
  const responder: Responder = body => body.messages.some((message: any) => message.role === 'tool')
    ? { content: '审批文件已写入' }
    : JSON.stringify(body.messages ?? []).includes('RETENTION-COWORK')
      ? { content: '', toolCalls: [{ id: 'write-retention', name: 'write_file', arguments: { path: 'retention.txt', content: 'retention approved' } }] }
      : { content: '保留窗口回答' };
  const env = await setup({ responder });
  t.after(() => env.close());
  const projectId = await addProject(env, env.workspace);
  const sentA = await sendChat(env, 'Retention A 第一条消息');
  await waitIdle(env, sentA.sessionId);
  const secondA = await env.http('POST', '/v1/product/chat/send', { mode: 'chat', sessionId: sentA.sessionId, text: 'Retention A 第二条消息', attachments: [], permission: 'ask', modelId: 'default' });
  assert.equal(secondA.status, 200, JSON.stringify(secondA.body));
  const detailBeforeEdit = await waitIdle(env, sentA.sessionId);
  assert.equal(detailBeforeEdit.body.messages.length, 4, JSON.stringify(detailBeforeEdit.body.messages.map((message: any) => message.id)));
  const oldAssistantIds: string[] = detailBeforeEdit.body.messages.filter((message: any) => message.role === 'assistant').map((message: any) => message.id);
  const sentB = await sendChat(env, 'Retention B 稍后删除的会话');
  await waitIdle(env, sentB.sessionId);
  const work = await env.http('POST', '/v1/product/chat/send', { mode: 'cowork', text: 'RETENTION-COWORK 写入保留窗口审批文件', attachments: [], permission: 'ask', modelId: 'default', projectId });
  assert.equal(work.status, 200, JSON.stringify(work.body));
  const taskId = work.body.sessionId as string;
  const approval = await until(async () => {
    const value = await env.http('GET', '/v1/product/approvals?sessionId=' + encodeURIComponent(taskId));
    return value.status === 200 && value.body.length ? value.body[0] : undefined;
  });

  const decided = await env.http('POST', '/v1/product/approvals/decide', { approvalId: approval.id, approved: true, scope: 'once' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  await until(async () => {
    const value = await env.http('GET', '/v1/product/approvals?sessionId=' + encodeURIComponent(taskId));
    return value.status === 200 && value.body.length === 0 ? true : undefined;
  });
  await waitTaskSettled(env, taskId);
  const removed = await env.http('POST', '/v1/product/sessions/' + encodeURIComponent(sentB.sessionId) + '/remove');
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const edited = await env.http('POST', '/v1/product/chat/edit', { sessionId: sentA.sessionId, messageId: sentA.messageId, text: 'Retention A 编辑后的第一条消息' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const editedDetail = await until(async () => {
    const value = await env.http('GET', '/v1/product/sessions/' + encodeURIComponent(sentA.sessionId));
    return value.status === 200 && value.body.status === 'idle' && value.body.messages.length === 2
      && JSON.stringify(value.body.messages).includes('Retention A 编辑后的第一条消息') ? value.body as SessionDetail : undefined;
  });
  assert.equal(editedDetail.messages.some(message => oldAssistantIds.includes(message.id)), false);

  const store = new ProductStore(env.dataDir);
  try {
    for (let batch = 0; batch < 5; batch += 1) store.append(retentionEvents(batch * 1000, 1000));
    store.append(retentionEvents(5000, 100));
  } finally {
    store.close();
  }
  const reset = await eventPage(env, '?cursor=1&limit=1');
  assert.equal(reset.reset, true, '旧游标低于保留窗口时必须 reset');
  assert.ok(reset.earliest > 1, '保留窗口必须已经前移');

  const snapshot = await snapshotOf(env, '?sessionId=' + encodeURIComponent(sentA.sessionId));
  assert.equal(snapshot.cursor, reset.nextCursor, '快照水位必须是当前最新事件 id');
  assert.equal(snapshot.epoch, (await eventPage(env, '?cursor=0&limit=1')).epoch);
  assert.equal(snapshot.sessions.items.some(item => item.id === sentB.sessionId), false, '已删除会话不得出现在快照里');
  assert.equal(snapshot.sessions.items.some(item => item.id === sentA.sessionId), true);
  assert.deepEqual(snapshot.approvals, [], '已解决审批不得出现在快照里');
  const current = await detailOf(env, sentA.sessionId);
  assert.deepEqual(snapshot.session, current);
  assert.equal(current.messages.length, 2);
  assert.equal(current.messages.some(message => oldAssistantIds.includes(message.id)), false, '被编辑截断的旧尾部不得出现在最新详情里');
  assert.deepEqual(snapshot.metrics, await metricsOf(env, sentA.sessionId));
  assert.equal('task' in snapshot, false);
});

test('6 快照 cursor 是回放栅栏：之后事件 id 更大，从该游标轮询不重放旧结算', { timeout: 180000 }, async t => {
  const responder: Responder = body => body.messages.some((message: any) => message.role === 'tool')
    ? { content: '审批文件已写入' }
    : JSON.stringify(body.messages ?? []).includes('FENCE-COWORK')
      ? { content: '', toolCalls: [{ id: 'write-fence', name: 'write_file', arguments: { path: 'fence.txt', content: 'fence approved' } }] }
      : { content: '栅栏回答' };
  const env = await setup({ responder });
  t.after(() => env.close());
  const projectId = await addProject(env, env.workspace);
  const first = await sendChat(env, 'Fence 第一会话');
  await waitIdle(env, first.sessionId);
  const second = await sendChat(env, 'Fence 第二会话');
  await waitIdle(env, second.sessionId);
  const secondDetail = await detailOf(env, second.sessionId);
  const oldMessageIds = new Set(secondDetail.messages.map(message => message.id));
  const work = await env.http('POST', '/v1/product/chat/send', { mode: 'cowork', text: 'FENCE-COWORK 审批结算', attachments: [], permission: 'ask', modelId: 'default', projectId });
  assert.equal(work.status, 200, JSON.stringify(work.body));
  const taskId = work.body.sessionId as string;
  const approval = await until(async () => {
    const value = await env.http('GET', '/v1/product/approvals?sessionId=' + encodeURIComponent(taskId));
    return value.status === 200 && value.body.length ? value.body[0] : undefined;
  });
  const decided = await env.http('POST', '/v1/product/approvals/decide', { approvalId: approval.id, approved: true, scope: 'once' });
  assert.equal(decided.status, 200);
  await until(async () => {
    const value = await env.http('GET', '/v1/product/approvals?sessionId=' + encodeURIComponent(taskId));
    return value.status === 200 && value.body.length === 0 ? true : undefined;
  });
  await waitTaskSettled(env, taskId);
  const preSnapshot = await eventPage(env, '?cursor=0&limit=200');
  const snapshot = await snapshotOf(env);
  assert.equal(snapshot.cursor, preSnapshot.nextCursor);

  const after = await sendChat(env, '快照之后的新消息');
  await waitIdle(env, after.sessionId);
  const page = await eventPage(env, '?cursor=' + snapshot.cursor + '&limit=200');
  assert.equal(page.reset, false);
  const ids = page.events.map(entry => entry.id);
  assert.ok(ids.length > 0);
  assert.ok(ids.every(id => id > snapshot.cursor), '从快照游标轮询只能得到更大的事件 id');
  assert.equal(page.events.some(entry => entry.id <= snapshot.cursor), false);
  assert.equal(page.events.some(entry => entry.event.type === 'message.upsert' && oldMessageIds.has(entry.event.message.id)), false, '旧消息不得被重放');
  assert.equal(page.events.some(entry => entry.event.type === 'approval.resolved'), false, '快照前已结算的审批不得被重放');
  assert.ok(page.events.some(entry => entry.event.type === 'message.upsert' && entry.event.sessionId === after.sessionId));
});

test('7 500 个会话只需 1 次快照 + 4 次补页，所有会话请求 limit<=100', { timeout: 180000 }, async t => {
  const env = await setup({ seed: dataDir => seedStore(dataDir, 500, 'bounded-', 0) });
  t.after(() => env.close());
  const snapshot = await snapshotOf(env);
  assert.equal(snapshot.sessions.items.length, 100);
  assert.equal(typeof snapshot.sessions.nextCursor, 'string');
  const seen = snapshot.sessions.items.map(item => item.id);
  let cursor: string | undefined = snapshot.sessions.nextCursor;
  let pages = 0;
  while (cursor && pages < 5) {
    const page = await env.http('GET', '/v1/product/sessions?cursor=' + encodeURIComponent(cursor) + '&limit=100');
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.ok(page.body.items.length <= 100);
    seen.push(...page.body.items.map((item: SessionSummary) => item.id));
    cursor = page.body.nextCursor;
    pages += 1;
    if (!cursor) break;
  }
  assert.equal(pages, 4, '首页之外最多 4 页补页足以覆盖 500 个会话');
  assert.equal(cursor, undefined);
  assert.equal(new Set(seen).size, 500);
});

test('A · 断线期间的删除/审批结算/消息截断由真实快照恢复，不再保留旧界面状态', { timeout: 180000 }, async t => {
  const responder: Responder = body => body.messages.some((message: any) => message.role === 'tool')
    ? { content: 'A 审批文件已写入' }
    : JSON.stringify(body.messages ?? []).includes('A-RECOVERY-COWORK')
      ? { content: '', toolCalls: [{ id: 'write-a', name: 'write_file', arguments: { path: 'a.txt', content: 'a approved' } }] }
      : { content: 'A 恢复回答' };
  const env = await setup({ responder });
  t.after(() => env.close());
  const projectId = await addProject(env, env.workspace);
  const { applySnapshot } = await loadModules();
  const bridge = await bridgeFor(env);

  const firstA = await sendChat(env, 'A 第一条消息');
  await waitIdle(env, firstA.sessionId);
  const secondA = await env.http('POST', '/v1/product/chat/send', { mode: 'chat', sessionId: firstA.sessionId, text: 'A 第二条消息', attachments: [], permission: 'ask', modelId: 'default' });
  assert.equal(secondA.status, 200, JSON.stringify(secondA.body));
  await waitIdle(env, firstA.sessionId);
  const staleDetail = await detailOf(env, firstA.sessionId);
  assert.equal(staleDetail.messages.length, 4, '编辑前的会话必须有两条问答，才能验证尾部截断');
  const oldAssistantIds = staleDetail.messages.filter(message => message.role === 'assistant').map(message => message.id);

  const sentB = await sendChat(env, 'A 稍后删除的会话');
  await waitIdle(env, sentB.sessionId);

  const work = await env.http('POST', '/v1/product/chat/send', { mode: 'cowork', text: 'A-RECOVERY-COWORK 写入审批文件', attachments: [], permission: 'ask', modelId: 'default', projectId });
  assert.equal(work.status, 200, JSON.stringify(work.body));
  const workId = work.body.sessionId as string;
  const approval = await until(async () => {
    const value = await env.http('GET', '/v1/product/approvals?sessionId=' + encodeURIComponent(workId));
    return value.status === 200 && value.body.length ? value.body[0] : undefined;
  });

  bridge.gateway.focusSession(firstA.sessionId);
  const delivered: GatewayEvent[] = [];
  const off = bridge.gateway.subscribe(record(delivered));
  await until(() => delivered.find(event => event.type === 'approval.requested' && event.approval.sessionId === workId), 20000);
  await waitCaughtUp(env, bridge);
  off();
  await pause(40);

  const sessionsBefore = (await env.http('GET', '/v1/product/sessions?limit=100')).body.items as SessionSummary[];
  const approvalsBefore = (await env.http('GET', '/v1/product/approvals')).body as any[];
  const metricsBefore = await metricsOf(env, firstA.sessionId);
  const preState = {
    sessions: Object.fromEntries(sessionsBefore.map(item => [item.id, item])),
    details: { [firstA.sessionId]: staleDetail, [sentB.sessionId]: await detailOf(env, sentB.sessionId) },
    approvals: Object.fromEntries(approvalsBefore.map(item => [item.id, item])),
    metrics: { [firstA.sessionId]: metricsBefore },
    inspectorRevision: { [firstA.sessionId]: 2 },
    view: { kind: 'session', id: firstA.sessionId },
  };

  // 断线期间（bridge 已退订，后台仍在运行）发生的三件事：审批结算、删除会话、编辑截断消息尾部。
  const decided = await env.http('POST', '/v1/product/approvals/decide', { approvalId: approval.id, approved: true, scope: 'once' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  await until(async () => {
    const value = await env.http('GET', '/v1/product/approvals?sessionId=' + encodeURIComponent(workId));
    return value.status === 200 && value.body.length === 0 ? true : undefined;
  });
  await waitTaskSettled(env, workId);
  const removed = await env.http('POST', '/v1/product/sessions/' + encodeURIComponent(sentB.sessionId) + '/remove');
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const edited = await env.http('POST', '/v1/product/chat/edit', { sessionId: firstA.sessionId, messageId: staleDetail.messages[0]!.id, text: 'A 编辑后的第一条消息' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  await until(async () => {
    const value = await env.http('GET', '/v1/product/sessions/' + encodeURIComponent(firstA.sessionId));
    return value.status === 200 && value.body.status === 'idle' && value.body.messages.length === 2
      && JSON.stringify(value.body.messages).includes('A 编辑后的第一条消息') ? true : undefined;
  });
  const store = new ProductStore(env.dataDir);
  try {
    for (let batch = 0; batch < 5; batch += 1) store.append(retentionEvents(batch * 1000, 1000));
    store.append(retentionEvents(5000, 100));
  } finally {
    store.close();
  }

  const recoveryEvents: GatewayEvent[] = [];
  const off2 = bridge.gateway.subscribe(record(recoveryEvents));
  const found = await until(() => findSnapshot(recoveryEvents), 30000);
  const notify = await until(() => findNotify(recoveryEvents, '状态已重新同步'), 15000);
  assert.equal(found.index, 0, '重同步快照必须是恢复后的第一条事件');
  assert.equal(notify.index, found.index + 1, '快照之后必须紧跟“状态已重新同步”提示');
  assert.equal(findNotify(recoveryEvents, '事件历史已截断'), undefined, 'epoch 恢复路径不得再走 legacy 截断提示');
  assert.equal(connectionChanges(recoveryEvents).some(event => event.connection.status === 'online'), false, '从未断线时不得谎报 online');

  const snapshot = found.snapshot;
  const currentDetail = await detailOf(env, firstA.sessionId);
  const currentMetrics = await metricsOf(env, firstA.sessionId);
  assert.equal(snapshot.sessionId, firstA.sessionId);
  assert.deepEqual(snapshot.session, currentDetail, '快照详情必须与真实 HTTP 详情一致');
  assert.equal(currentDetail.messages.length, 2);
  assert.equal(currentDetail.messages.some(message => oldAssistantIds.includes(message.id)), false, '编辑截断的旧尾部不得出现在快照里');
  assert.deepEqual(snapshot.approvals, [], '已解决审批不得出现在快照里');
  assert.equal(snapshot.sessions.items.some(item => item.id === sentB.sessionId), false, '已删除会话不得出现在快照里');
  assert.ok(snapshot.sessions.items.some(item => item.id === firstA.sessionId));
  assert.deepEqual(snapshot.metrics, currentMetrics);

  const patch = applySnapshot(preState, snapshot);
  assert.equal(patch.state.sessions[sentB.sessionId], undefined, '本地 reducer 必须移除已删除会话');
  assert.ok(patch.state.sessions[firstA.sessionId]);
  assert.ok(patch.state.sessions[workId]);
  assert.deepEqual(patch.state.details, { [firstA.sessionId]: currentDetail }, '除快照带的详情外，旧详情缓存必须清空');
  assert.deepEqual(patch.state.metrics, { [firstA.sessionId]: currentMetrics }, '指标必须刷新且旧指标清除');
  assert.deepEqual(patch.state.approvals, {}, '审批必须按快照替换，已解决的不得残留');
  assert.deepEqual(patch.state.view, { kind: 'session', id: firstA.sessionId });
  assert.equal(patch.focusRemoved, false);
  assert.deepEqual(sorted(patch.removedSessionIds), [sentB.sessionId]);
  assert.equal(patch.state.inspectorRevision[firstA.sessionId], 3, '焦点会话 Inspector 需要强制刷新一次');

  const snapshotCallIndex = bridge.calls.map(call => call.path.startsWith('/v1/product/snapshot')).lastIndexOf(true);
  assert.ok(snapshotCallIndex >= 0);
  const snapshotCall = bridge.calls[snapshotCallIndex]!;
  assert.equal(queryValue(snapshotCall.path, 'sessionId'), firstA.sessionId, '恢复必须带上聚焦会话');
  assert.equal(queryValue(snapshotCall.path, 'limit'), '100');
  const eventCallAfter = bridge.calls.slice(snapshotCallIndex + 1).find(call => call.path.startsWith('/v1/product/events'));
  assert.ok(eventCallAfter, '快照成功后必须立即继续轮询 /events');
  assert.equal(queryValue(eventCallAfter.path, 'cursor'), String(snapshot.cursor), '恢复后必须从 snapshot.cursor 继续');

  const continuation = await env.http('POST', '/v1/product/chat/send', { mode: 'chat', sessionId: firstA.sessionId, text: 'A 恢复后继续', attachments: [], permission: 'ask', modelId: 'default' });
  assert.equal(continuation.status, 200, JSON.stringify(continuation.body));
  await until(() => recoveryEvents.find(event => event.type === 'message.upsert' && event.sessionId === firstA.sessionId && JSON.stringify(event.message).includes('A 恢复后继续')), 20000);
  off2();
});

test('B · 记忆高游标但 product.sqlite 被替换：恢复空快照、退回首页，online 在快照之后', { timeout: 180000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const { applySnapshot } = await loadModules();
  const bridge = await bridgeFor(env);
  const first = await sendChat(env, 'B 替换前存在的会话');
  await waitIdle(env, first.sessionId);
  bridge.gateway.focusSession(first.sessionId);
  const delivered: GatewayEvent[] = [];
  const off = bridge.gateway.subscribe(record(delivered));
  await until(() => delivered.find(event => event.type === 'message.upsert' && event.sessionId === first.sessionId), 20000);
  await waitCaughtUp(env, bridge);
  const stale = await detailOf(env, first.sessionId);
  const preState = {
    sessions: { [first.sessionId]: stale },
    details: { [first.sessionId]: stale },
    approvals: {},
    metrics: { [first.sessionId]: await metricsOf(env, first.sessionId) },
    inspectorRevision: { [first.sessionId]: 1 },
    view: { kind: 'session', id: first.sessionId },
  };

  await env.stop();
  // 断线期间焦点会话被删除（原生 harness 行一并删除，避免重启 bootstrap 把它重新登记）。
  const harness = new HarnessStore(env.dataDir);
  try { harness.deleteSession(first.sessionId); } finally { harness.close(); }
  deleteProductStores(env.dataDir);
  const offline = await until(() => connectionChanges(delivered).find(event => event.connection.status === 'offline'), 15000);
  assert.ok(offline.connection.message, '断线通知必须带真实错误消息');
  await env.start();

  const found = await until(() => findSnapshot(delivered), 30000);
  await until(() => findNotify(delivered, '状态已重新同步'), 15000);
  const snapshot = found.snapshot;
  assert.equal(snapshot.cursor, 0, '新库没有任何事件');
  assert.equal(snapshot.sessionId, first.sessionId);
  assert.equal(snapshot.session, null, '聚焦会话已不存在时必须是 null 而不是省略字段');
  assert.deepEqual(snapshot.sessions.items, []);
  assert.deepEqual(snapshot.approvals, []);
  const patch = applySnapshot(preState, snapshot);
  assert.deepEqual(patch.state.view, { kind: 'home' });
  assert.equal(patch.focusRemoved, true);
  assert.deepEqual(patch.state.sessions, {});
  assert.deepEqual(patch.state.details, {});
  assert.deepEqual(patch.state.metrics, {});

  const connections = connectionChanges(delivered);
  const onlineEvents = connections.filter(event => event.connection.status === 'online');
  assert.equal(connections.filter(event => event.connection.status === 'offline').length, 1, '同一段断线只报告一次 offline');
  assert.equal(onlineEvents.length, 1, '恢复成功后只报告一次 online');
  assert.ok(delivered.indexOf(onlineEvents[0]!) > found.index, 'online 必须在成功的 state.snapshot 之后（契约 d）');
  off();
});

test('C · 恢复期间到达的新事件在快照之后送达，下一次 /events 从 snapshot.cursor 继续', { timeout: 180000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  let newSessionId = '';
  let armed = false;
  const bridge = await bridgeFor(env, {
    hook: async () => {
      if (!armed) return undefined;
      const created = await sendChat(env, 'C 恢复期间的新会话');
      newSessionId = created.sessionId;
      return undefined;
    },
  });
  const first = await sendChat(env, 'C 截断前的会话');
  await waitIdle(env, first.sessionId);
  const delivered: GatewayEvent[] = [];
  const off = bridge.gateway.subscribe(record(delivered));
  await until(() => delivered.find(event => event.type === 'message.upsert' && event.sessionId === first.sessionId), 20000);
  await waitCaughtUp(env, bridge);
  off();
  await pause(30);

  const store = new ProductStore(env.dataDir);
  try {
    for (let batch = 0; batch < 5; batch += 1) store.append(retentionEvents(batch * 1000, 1000));
    store.append(retentionEvents(5000, 100));
  } finally {
    store.close();
  }
  const latestBefore = await latestEventId(env);
  armed = true;
  const recovery: GatewayEvent[] = [];
  const off2 = bridge.gateway.subscribe(record(recovery));
  const found = await until(() => findSnapshot(recovery), 30000);
  const snapshot = found.snapshot;
  assert.equal(snapshot.cursor, latestBefore, '快照水位必须在恢复期间新事件之前');
  assert.ok(newSessionId, '快照请求返回后、快照派发前必须已经创建新会话');
  assert.equal(snapshot.sessions.items.some(item => item.id === newSessionId), false, '快照不包含创建于快照之后的新会话');

  const createdEvent = await until(() => recovery.find(event => event.type === 'session.upsert' && event.session.id === newSessionId), 20000);
  assert.ok(recovery.indexOf(createdEvent) > found.index, '新会话事件必须在快照之后送达');
  const afterSnapshot = recovery.slice(found.index + 1).filter(event => event.type !== 'notify' && event.type !== 'connection.changed');
  assert.ok(afterSnapshot.length > 0);
  assert.ok(afterSnapshot.every(event => referencesSession(event, newSessionId)), '快照之后只能出现快照水位之后的新事件，旧结算不得重放');

  const snapshotCallIndex = bridge.calls.map(call => call.path.startsWith('/v1/product/snapshot')).lastIndexOf(true);
  const firstEventCall = bridge.calls.slice(snapshotCallIndex + 1).find(call => call.path.startsWith('/v1/product/events'));
  assert.ok(firstEventCall, '快照成功后必须立即继续轮询');
  assert.equal(queryValue(firstEventCall.path, 'cursor'), String(snapshot.cursor), '下一次 /events 必须使用 snapshot.cursor');
  off2();
});

test('D · 多页有界快照：>500 会话聚合 500 条并保留 nextCursor，250 会话页集完整', { timeout: 240000 }, async t => {
  const env = await setup({ seed: dataDir => seedStore(dataDir, 0, 'unused-', 20) });
  t.after(() => env.close());
  const { applySnapshot } = await loadModules();
  const bridge = await bridgeFor(env);
  const initial: GatewayEvent[] = [];
  const off = bridge.gateway.subscribe(record(initial));
  await until(() => initial.filter(event => event.type === 'notify').length === 20, 20000);
  const epochBefore = (await eventPage(env, '?cursor=0&limit=1')).epoch;
  const latestBefore = await waitCaughtUp(env, bridge);
  off();
  await pause(30);

  await env.stop();
  deleteProductStores(env.dataDir);
  seedStore(env.dataDir, 600, 'big-', latestBefore + 3);
  await env.start();
  const mark = bridge.calls.length;
  const recovery: GatewayEvent[] = [];
  const off2 = bridge.gateway.subscribe(record(recovery));
  const found = await until(() => findSnapshot(recovery), 30000);
  off2();
  const snapshot = found.snapshot;
  assert.equal(snapshot.cursor, latestBefore + 3);
  assert.equal(snapshot.sessions.items.length, 500, '首页 + 4 页补页最多聚合 500 条摘要');
  assert.equal(typeof snapshot.sessions.nextCursor, 'string', '达到预算上限后必须保留剩余 nextCursor');
  assert.notEqual(snapshot.epoch, epochBefore, '替换库后 epoch 必须变化');
  const calls = bridge.calls.slice(mark);
  assert.equal(requestsTo(calls, '/snapshot').length, 1, '一次恢复只允许一个快照请求');
  const pages = requestsTo(calls, '/sessions');
  assert.equal(pages.length, 4, '>500 会话只允许 4 次补页');
  for (const call of [...requestsTo(calls, '/snapshot'), ...pages]) {
    const limit = queryValue(call.path, 'limit');
    assert.ok(limit === null || Number(limit) <= 100, '快照/会话分页请求 limit 必须 <=100：' + call.path);
  }

  const preSessions: Record<string, any> = {};
  for (let index = 0; index < 600; index += 1) preSessions['big-' + index] = { id: 'big-' + index, title: '旧标题' };
  preSessions['beyond-page-1'] = { id: 'beyond-page-1', title: '超出页' };
  preSessions['beyond-page-2'] = { id: 'beyond-page-2', title: '超出页' };
  const partial = applySnapshot({ sessions: preSessions, details: { 'beyond-page-1': { id: 'beyond-page-1' } }, approvals: {}, metrics: {}, inspectorRevision: { 'beyond-page-1': 4 }, view: { kind: 'home' } }, snapshot);
  assert.equal(Object.keys(partial.state.sessions).length, 602, '部分快照不得删除任何未确认会话');
  assert.ok(partial.state.sessions['big-599'], '第 500 条之后的真实会话不能被当成删除');
  assert.ok(partial.state.sessions['beyond-page-1']);
  assert.deepEqual(partial.removedSessionIds, []);
  assert.deepEqual(partial.state.details, {}, '没有焦点会话时旧详情全部丢弃');

  const afterFirst = snapshot.cursor;
  await env.stop();
  deleteProductStores(env.dataDir);
  seedStore(env.dataDir, 250, 'small-', afterFirst + 3);
  await env.start();
  const mark2 = bridge.calls.length;
  const recovery2: GatewayEvent[] = [];
  const off3 = bridge.gateway.subscribe(record(recovery2));
  const found2 = await until(() => findSnapshot(recovery2), 30000);
  off3();
  const snapshot2 = found2.snapshot;
  assert.equal(snapshot2.sessions.items.length, 250);
  assert.equal(snapshot2.sessions.nextCursor, undefined, '完整页集不得残留 nextCursor');
  assert.equal(requestsTo(bridge.calls.slice(mark2), '/sessions').length, 2, '250 条只需 2 次补页');
  assert.equal(requestsTo(bridge.calls.slice(mark2), '/snapshot').length, 1);
  const pre2: Record<string, any> = {};
  for (let index = 0; index < 250; index += 1) pre2['small-' + index] = { id: 'small-' + index, title: '旧标题' };
  pre2['stale-1'] = { id: 'stale-1' };
  pre2['stale-2'] = { id: 'stale-2' };
  const complete = applySnapshot({ sessions: pre2, details: {}, approvals: {}, metrics: {}, inspectorRevision: {}, view: { kind: 'home' } }, snapshot2);
  assert.equal(Object.keys(complete.state.sessions).length, 250, '完整快照必须删除未出现且无法确认的旧会话');
  assert.equal(complete.state.sessions['stale-1'], undefined);
});

test('E · 正常增量只轮询 /events，不触发快照或会话重列', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const bridge = await bridgeFor(env);
  const delivered: GatewayEvent[] = [];
  const off = bridge.gateway.subscribe(record(delivered));
  await waitCaughtUp(env, bridge);
  const sent = await sendChat(env, 'E 正常增量消息');
  await until(() => delivered.find(event => event.type === 'message.upsert' && event.sessionId === sent.sessionId && event.message.role === 'user'), 20000);
  await waitIdle(env, sent.sessionId);
  off();
  assert.equal(requestsTo(bridge.calls, '/snapshot').length, 0, '正常增量不得请求快照');
  assert.equal(requestsTo(bridge.calls, '/sessions').length, 0, '正常增量不得重新列会话');
});

test('F1 · 快照失败可见、有界重试、成功后 online；退订冻结请求，重订继续同步', { timeout: 180000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  let failing = true;
  const bridge = await bridgeFor(env, { hook: () => failing ? { httpStatus: 500, code: 'internal', error: 'snapshot unavailable' } : undefined });
  const first = await sendChat(env, 'F1 会话');
  await waitIdle(env, first.sessionId);
  const initial: GatewayEvent[] = [];
  const off = bridge.gateway.subscribe(record(initial));
  await waitCaughtUp(env, bridge);
  off();
  await pause(30);
  const store = new ProductStore(env.dataDir);
  try {
    for (let batch = 0; batch < 5; batch += 1) store.append(retentionEvents(batch * 1000, 1000));
    store.append(retentionEvents(5000, 100));
  } finally {
    store.close();
  }

  const failingEvents: GatewayEvent[] = [];
  const off2 = bridge.gateway.subscribe(record(failingEvents));
  const failure = await until(() => bridge.streamErrors.find(error => error.code === 'state_snapshot_failed'), 20000);
  assert.equal(failure.retryable, true);
  assert.ok(failure.message.includes('snapshot unavailable'), '失败消息必须包含真实错误：' + failure.message);
  const offline = await until(() => connectionChanges(failingEvents).find(event => event.connection.status === 'offline'), 15000);
  assert.ok(offline.connection.message && offline.connection.message.includes('snapshot unavailable'), 'offline 通知必须带真实错误消息');
  assert.equal(findSnapshot(failingEvents), undefined, '失败时不得派发部分快照');
  const attemptsDuringFailure = requestsTo(bridge.calls, '/snapshot').length;
  assert.ok(attemptsDuringFailure <= 8, '失败重试必须有界，不能热循环（实际 ' + attemptsDuringFailure + ' 次）');

  failing = false;
  const found = await until(() => findSnapshot(failingEvents), 30000);
  assert.ok(found);
  const online = await until(() => connectionChanges(failingEvents).filter(event => event.connection.status === 'online').at(-1), 15000);
  assert.equal(online.connection.status, 'online');
  assert.ok(requestsTo(bridge.calls, '/snapshot').length <= attemptsDuringFailure + 3);
  off2();

  const frozen = bridge.calls.length;
  await pause(120);
  assert.equal(bridge.calls.length, frozen, '退订后不得再发请求或重开定时器');

  const resumed: GatewayEvent[] = [];
  const off3 = bridge.gateway.subscribe(record(resumed));
  const sent = await env.http('POST', '/v1/product/chat/send', { mode: 'chat', sessionId: first.sessionId, text: 'F1 恢复后继续', attachments: [], permission: 'ask', modelId: 'default' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await until(() => resumed.find(event => event.type === 'message.upsert' && event.sessionId === first.sessionId && JSON.stringify(event.message).includes('F1 恢复后继续')), 20000);
  const connection = await bridge.gateway.connection();
  assert.equal(connection.status, 'online', '重订后不能永久停在 offline');
  off3();
});

test('F2 · 快照请求在途时退订：不派发、不重排、迟到响应不重开定时器', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  let hold = false;
  let releaseHook!: () => void;
  const gate = new Promise<void>(resolve => { releaseHook = resolve; });
  const bridge = await bridgeFor(env, {
    hook: (_call, response) => (hold ? gate.then(() => response) : undefined),
  });
  const first = await sendChat(env, 'F2 会话');
  await waitIdle(env, first.sessionId);
  const initial: GatewayEvent[] = [];
  const off = bridge.gateway.subscribe(record(initial));
  await waitCaughtUp(env, bridge);
  off();
  await pause(30);
  const store = new ProductStore(env.dataDir);
  try {
    for (let batch = 0; batch < 5; batch += 1) store.append(retentionEvents(batch * 1000, 1000));
    store.append(retentionEvents(5000, 100));
  } finally {
    store.close();
  }

  hold = true;
  const callsBefore = bridge.calls.length;
  const recovery: GatewayEvent[] = [];
  const off2 = bridge.gateway.subscribe(record(recovery));
  await until(() => bridge.calls.slice(callsBefore).some(call => call.path.startsWith('/v1/product/snapshot')), 20000);
  off2();
  const frozenAfterUnsubscribe = bridge.calls.length;
  releaseHook();
  await pause(150);
  assert.equal(findSnapshot(recovery), undefined, '退订后不得派发快照');
  assert.equal(bridge.calls.length, frozenAfterUnsubscribe, '迟到的快照响应不得重开轮询/定时器');
  assert.equal(connectionChanges(recovery).some(event => event.connection.status === 'online'), false);
});

// 契约 f：页面带 epoch 但 /snapshot 路由不存在（旧后端 HTTP 404 且响应没有 code 字段）时，
// 必须完全退回 legacy 行为，而不是把 404 当成恢复失败、永久停在 state_snapshot_failed。
test('F3 · epoch 页面遇到 /snapshot 的 HTTP 404 时退回 legacy 截断提示', { timeout: 60000 }, async () => {
  const { BridgeGateway } = await loadModules();
  const calls: RecordedCall[] = [];
  let eventCalls = 0;
  const npn: NpnLike = {
    async request(_method: string, requestPath: string): Promise<any> {
      calls.push({ method: _method, path: requestPath });
      if (requestPath.startsWith("/v1/product/snapshot")) return { httpStatus: 404, error: "Unknown product route: /snapshot" };
      if (requestPath.startsWith("/v1/product/events")) {
        eventCalls += 1;
        // 第一页带 epoch 且 reset：必须走快照恢复；快照 404 后只能退回 legacy。
        if (eventCalls === 1) return { events: [], nextCursor: 5, earliest: 6, reset: true, epoch: "epoch-without-snapshot-route" };
        return { events: [], nextCursor: Number(queryValue(requestPath, "cursor") ?? "5"), earliest: 6, reset: false, epoch: "epoch-without-snapshot-route" };
      }
      throw new Error("F3 不应发起其他请求：" + requestPath);
    },
    async desktop(): Promise<unknown> { return undefined; },
  };
  const events: GatewayEvent[] = [];
  const streamErrors: StreamError[] = [];
  const gateway = new BridgeGateway(npn, {
    pollIntervalMs: 10,
    onStreamError: error => streamErrors.push({ code: error.code, message: error.message, retryable: Boolean(error.retryable) }),
  });
  const stop = gateway.subscribe(record(events));
  pendingStops.push(stop);

  const outcome = await until(() => {
    const found = findNotify(events, "事件历史已截断");
    if (found) return { kind: "legacy" as const, found };
    if (streamErrors.length > 0) return { kind: "error" as const };
    return undefined;
  }, 5000);
  assert.equal(outcome.kind, "legacy", "HTTP 404 应退回 legacy 截断提示，实际错误：" + JSON.stringify(streamErrors));
  const warn = findNotify(events, "事件历史已截断");
  assert.ok(warn, "HTTP 404 应退回 legacy 截断提示");
  assert.equal(warn.event.tone, "warn");
  assert.equal(findSnapshot(events), undefined, "旧后端路径不得派发快照");
  assert.equal(findNotify(events, "状态已重新同步"), undefined, "旧后端路径不得声称重新同步");
  assert.equal(streamErrors.some(error => error.code === "state_snapshot_failed"), false, "404 不是恢复失败，不得报 state_snapshot_failed");
  assert.equal(streamErrors.some(error => error.code === "events_reset"), true, "legacy 回退仍需报告 events_reset");
  assert.equal(requestsTo(calls, "/snapshot").length, 1, "只允许一次快照探测");
  assert.equal(requestsTo(calls, "/sessions").length, 0, "legacy 回退不得重列会话");
  await until(() => calls.some(call => call.path.startsWith("/v1/product/events") && queryValue(call.path, "cursor") === "5"), 3000);
  assert.equal(connectionChanges(events).length, 0, "从未断线的普通 reset 不得声称 online 或 offline");
});

