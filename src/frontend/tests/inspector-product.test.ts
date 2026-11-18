/**
 * Inspector 前端接线契约测试（2026-10-30）。
 *
 * 固定九条 /v1/product/inspector/* 路由的请求形状、查询参数编码与省略规则；
 * 固定 TracePanel 的游标翻页去重语义、ContextPanel 的未知窗口/估算用量显示决策，
 * 以及回查分页的偏移历史。只通过公开网关与纯函数断言，不使用私有实现或快照。
 *
 * 约束：node:test + node:assert/strict，本地传输桩；不触网、不写盘。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { BridgeGateway } from '../api/bridge';
import { GatewayError } from '../api/contract';
import type {
  ContextView, FileDiff, PromptView, RecallPage, RequestRecordView, ToolInventory, TraceSpan, TraceSpanType, TraceView,
} from '../api/types';
import { appendTracePage, nextTraceCursor, traceQueryOf } from '../features/inspector/trace-page';
import { contextMeter, contextShare, recallNextOffset, recallTrailPop, recallTrailPrevious, recallTrailPush } from '../features/inspector/context-page';

const PREFIX = '/v1/product';

interface RequestCall { method: string; path: string; body: unknown }

function setup(options: { request?: (call: RequestCall) => unknown } = {}): { calls: RequestCall[]; gateway: BridgeGateway } {
  const calls: RequestCall[] = [];
  const npn = {
    async request(method: string, path: string, body?: unknown): Promise<unknown> {
      const call: RequestCall = { method, path, body };
      calls.push(call);
      return options.request ? options.request(call) : undefined;
    },
    async desktop(): Promise<unknown> {
      return undefined;
    },
  };
  return { calls, gateway: new BridgeGateway(npn) };
}

function splitPath(value: string): { pathname: string; query: URLSearchParams } {
  const at = value.indexOf('?');
  return { pathname: at < 0 ? value : value.slice(0, at), query: new URLSearchParams(at < 0 ? '' : value.slice(at + 1)) };
}

function span(id: string): TraceSpan {
  return { id, type: 'model', label: id, status: 'ok', startMs: 0, durationMs: 1 };
}

const promptView: PromptView = { parts: [], totalTokens: 0, pendingEdits: 0 };
const requestRecord: RequestRecordView = {
  id: 'r1', kind: 'chat', status: 'completed', createdAt: '2026-10-30T00:00:00.000Z',
  model: 'model', endpoint: 'https://example.test', body: {}, redactions: [],
};
const toolInventory: ToolInventory = { registered: [], allowed: [], exposed: [], calls: [] };
const traceView: TraceView = { startedAt: '2026-10-30T00:00:00.000Z', spans: [], hasMore: false };
const contextView: ContextView = { windowTokens: 0, usedTokens: 0, segments: [], omitted: [] };
const recallPage: RecallPage = { sourceId: 'src', sha: 'abc', offset: 0, text: 'first' };
const fileDiffs: FileDiff[] = [];

describe('Inspector 九条路由映射', () => {
  test('GET /inspector/prompt 转发 sessionId 与可选 requestId（URL 编码）', async () => {
    const { calls, gateway } = setup({ request: () => promptView });
    const view = await gateway.inspector.prompt('s/1', 'r 2');
    assert.equal(view, promptView);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    const parsed = splitPath(calls[0].path);
    assert.equal(parsed.pathname, PREFIX + '/inspector/prompt');
    assert.equal(parsed.query.get('sessionId'), 's/1');
    assert.equal(parsed.query.get('requestId'), 'r 2');
  });

  test('GET /inspector/prompt 缺省 requestId 时不发送该参数', async () => {
    const { calls, gateway } = setup({ request: () => promptView });
    await gateway.inspector.prompt('s1');
    assert.equal(calls[0].path, PREFIX + '/inspector/prompt?sessionId=s1');
    assert.equal(splitPath(calls[0].path).query.has('requestId'), false);
  });

  test('POST /inspector/prompt 只发送严格四字段 body', async () => {
    const { calls, gateway } = setup({ request: () => promptView });
    await gateway.inspector.savePrompt('s/1', 'p 1', '内容 & =', 'project');
    assert.deepEqual(calls[0], {
      method: 'POST',
      path: PREFIX + '/inspector/prompt',
      body: { sessionId: 's/1', partId: 'p 1', content: '内容 & =', scope: 'project' },
    });
  });

  test('GET /inspector/requests 只发送 sessionId', async () => {
    const { calls, gateway } = setup({ request: () => [requestRecord] });
    const records = await gateway.inspector.requests('s1');
    assert.deepEqual(records, [requestRecord]);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].path, PREFIX + '/inspector/requests?sessionId=s1');
  });

  test('POST /inspector/replay 原样发送 requestId、编辑后的 body 与 mode', async () => {
    const body = { model: 'model', messages: [{ role: 'user', content: 'hi' }] };
    const { calls, gateway } = setup({ request: () => requestRecord });
    await gateway.inspector.replay('r/1', body, 'branch');
    assert.deepEqual(calls[0], {
      method: 'POST',
      path: PREFIX + '/inspector/replay',
      body: { requestId: 'r/1', body, mode: 'branch' },
    });
  });

  test('GET /inspector/tools 只发送 sessionId', async () => {
    const { calls, gateway } = setup({ request: () => toolInventory });
    const inventory = await gateway.inspector.tools('s1');
    assert.equal(inventory, toolInventory);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].path, PREFIX + '/inspector/tools?sessionId=s1');
  });

  test('GET /inspector/trace 转发 text/type/cursor 并保持编码', async () => {
    const { calls, gateway } = setup({ request: () => traceView });
    await gateway.inspector.trace('s 1', { text: 'a b&c', type: 'tool', cursor: 'c/1+=' });
    assert.equal(calls[0].method, 'GET');
    const parsed = splitPath(calls[0].path);
    assert.equal(parsed.pathname, PREFIX + '/inspector/trace');
    assert.equal(parsed.query.get('sessionId'), 's 1');
    assert.equal(parsed.query.get('text'), 'a b&c');
    assert.equal(parsed.query.get('type'), 'tool');
    assert.equal(parsed.query.get('cursor'), 'c/1+=');
  });

  test('GET /inspector/trace 无查询时只发送 sessionId', async () => {
    const { calls, gateway } = setup({ request: () => traceView });
    await gateway.inspector.trace('s1');
    assert.equal(calls[0].path, PREFIX + '/inspector/trace?sessionId=s1');
  });

  test('GET /inspector/context 只发送 sessionId', async () => {
    const { calls, gateway } = setup({ request: () => contextView });
    const view = await gateway.inspector.context('s1');
    assert.equal(view, contextView);
    assert.equal(calls[0].path, PREFIX + '/inspector/context?sessionId=s1');
  });

  test('GET /inspector/recall 转发 offset（含 0），无 offset 时省略', async () => {
    const { calls, gateway } = setup({ request: () => recallPage });
    await gateway.inspector.recall('s 1', 'src 1', 0);
    const parsed = splitPath(calls[0].path);
    assert.equal(parsed.pathname, PREFIX + '/inspector/recall');
    assert.equal(parsed.query.get('sessionId'), 's 1');
    assert.equal(parsed.query.get('sourceId'), 'src 1');
    assert.equal(parsed.query.get('offset'), '0');

    await gateway.inspector.recall('s1', 'src');
    assert.equal(calls[1].path, PREFIX + '/inspector/recall?sessionId=s1&sourceId=src');
    assert.equal(splitPath(calls[1].path).query.has('offset'), false);
  });

  test('GET /inspector/diffs 只发送 sessionId', async () => {
    const { calls, gateway } = setup({ request: () => fileDiffs });
    const diffs = await gateway.inspector.diffs('s1');
    assert.equal(diffs, fileDiffs);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].path, PREFIX + '/inspector/diffs?sessionId=s1');
  });

  test('传输错误不被吞掉或改写成成功结果', async () => {
    const { gateway } = setup({ request: () => { throw new Error('offline'); } });
    await assert.rejects(gateway.inspector.diffs('s1'), (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.code, 'transport_error');
      assert.equal(error.retryable, true);
      assert.match(error.message, /offline/);
      return true;
    });
  });
});

describe('Trace 分页与过滤纯函数', () => {
  test('appendTracePage 按 id 去重、保持加载顺序且不修改入参', () => {
    const first = span('a'), second = span('b');
    const loaded = [first, second];
    const merged = appendTracePage(loaded, [second, span('c'), span('c')]);
    assert.deepEqual(merged.map(item => item.id), ['a', 'b', 'c']);
    assert.equal(merged[0], first);
    assert.deepEqual(loaded.map(item => item.id), ['a', 'b']);
    assert.deepEqual(appendTracePage(loaded, []).map(item => item.id), ['a', 'b']);
  });

  test('nextTraceCursor 只在 hasMore 且游标有效时允许继续', () => {
    assert.equal(nextTraceCursor({ hasMore: true, nextCursor: 'c1' }), 'c1');
    assert.equal(nextTraceCursor({ hasMore: false, nextCursor: 'c1' }), undefined);
    assert.equal(nextTraceCursor({ hasMore: true }), undefined);
    assert.equal(nextTraceCursor({ hasMore: true, nextCursor: '' }), undefined);
  });

  test('traceQueryOf 去空白、只转发单选类型', () => {
    const tool: TraceSpanType = 'tool';
    const model: TraceSpanType = 'model';
    assert.deepEqual(traceQueryOf('', []), {});
    assert.deepEqual(traceQueryOf('  a b  ', []), { text: 'a b' });
    assert.deepEqual(traceQueryOf('x', [tool]), { text: 'x', type: 'tool' });
    assert.deepEqual(traceQueryOf('x', [tool, model]), { text: 'x' });
    assert.deepEqual(traceQueryOf('  ', [tool]), { type: 'tool' });
  });

  test('游标翻页逐页追加、跨页去重，nextCursor 终止', async () => {
    const pages: Record<string, TraceView> = {
      '': { startedAt: '2026-10-30T00:00:00.000Z', spans: [span('a'), span('b')], hasMore: true, nextCursor: 'c1' },
      'c1': { startedAt: '2026-10-30T00:00:00.000Z', spans: [span('b'), span('c')], hasMore: true, nextCursor: 'c2' },
      'c2': { startedAt: '2026-10-30T00:00:00.000Z', spans: [span('d')], hasMore: false },
    };
    const { calls, gateway } = setup({ request: call => pages[splitPath(call.path).query.get('cursor') ?? ''] });
    let page = await gateway.inspector.trace('s1');
    let merged = appendTracePage([], page.spans);
    let cursor = nextTraceCursor(page);
    while (cursor !== undefined) {
      page = await gateway.inspector.trace('s1', { cursor });
      merged = appendTracePage(merged, page.spans);
      cursor = nextTraceCursor(page);
    }
    assert.deepEqual(merged.map(item => item.id), ['a', 'b', 'c', 'd']);
    assert.deepEqual(calls.map(call => splitPath(call.path).query.get('cursor')), [null, 'c1', 'c2']);
  });
});

describe('Context 显示决策与回查偏移历史', () => {
  test('contextShare 只在窗口可信且为正数时计算，绝不产生 NaN/Infinity', () => {
    assert.equal(contextShare(250, 1000), 0.25);
    assert.equal(contextShare(250, 1000, true), 0.25);
    assert.equal(contextShare(250, 0), undefined);
    assert.equal(contextShare(250, 0, false), undefined);
    assert.equal(contextShare(250, 1000, false), undefined);
    assert.equal(contextShare(Number.NaN, 1000), undefined);
    assert.equal(contextShare(250, Number.POSITIVE_INFINITY), undefined);
  });

  test('contextMeter 对未知窗口不显示伪造百分比，估算用量加 ≈', () => {
    const known = contextMeter({ usedTokens: 250, windowTokens: 1000 });
    assert.deepEqual(known, { share: 0.25, usedPrefix: '', windowKnown: true });
    const estimated = contextMeter({ usedTokens: 250, windowTokens: 1000, usedTokensEstimated: true });
    assert.equal(estimated.usedPrefix, '≈');
    assert.equal(estimated.share, 0.25);
    const unknown = contextMeter({ usedTokens: 250, windowTokens: 0, windowTokensKnown: false });
    assert.equal(unknown.share, undefined);
    assert.equal(unknown.windowKnown, false);
    assert.equal(unknown.usedPrefix, '');
    const unknownEstimated = contextMeter({ usedTokens: 250, windowTokens: 0, windowTokensKnown: false, usedTokensEstimated: true });
    assert.equal(unknownEstimated.share, undefined);
    assert.equal(unknownEstimated.windowKnown, false);
    assert.equal(unknownEstimated.usedPrefix, '≈');
    for (const meter of [known, estimated, unknown, unknownEstimated]) {
      assert.ok(meter.share === undefined || Number.isFinite(meter.share), '界面可渲染的比例必须是有限数');
    }
  });

  test('回查偏移历史只记录真实加载过的页，上一页回到实际 offset', () => {
    let trail = [0];
    assert.equal(recallTrailPrevious(trail), undefined);
    trail = recallTrailPush(trail, 6000);
    assert.deepEqual(trail, [0, 6000]);
    assert.equal(recallTrailPrevious(trail), 0);
    assert.deepEqual(recallTrailPush(trail, 6000), [0, 6000]);
    assert.deepEqual(recallTrailPush(trail, Number.NaN), [0, 6000]);
    assert.deepEqual(recallTrailPop(trail), [0]);
    assert.deepEqual(recallTrailPop([0]), [0]);
    assert.equal(recallTrailPrevious([0]), undefined);
  });

  test('下一回查页只用后端 nextOffset，缺省即禁用', () => {
    const first: RecallPage = { sourceId: 'src', sha: 'a', offset: 0, text: 'first', nextOffset: 6000 };
    const last: RecallPage = { sourceId: 'src', sha: 'a', offset: 6000, text: 'last' };
    assert.equal(recallNextOffset(first), 6000);
    assert.equal(recallNextOffset(last), undefined);
    assert.equal(recallNextOffset({ nextOffset: 0 }), 0);
    assert.equal(recallNextOffset({ nextOffset: Number.NaN }), undefined);
  });
});

describe('构建边界', () => {
  test('bridge 源码不引用 api/mock，且保留九条 inspector 路由', () => {
    const candidates = [
      fileURLToPath(new URL('../../src/frontend/api/bridge.ts', import.meta.url)),
      path.join(process.cwd(), 'src', 'frontend', 'api', 'bridge.ts'),
    ];
    let source: string | undefined;
    for (const candidate of candidates) {
      try {
        source = readFileSync(candidate, 'utf8');
        break;
      } catch {
        // 换下一个候选路径
      }
    }
    assert.ok(source, '找不到 bridge.ts 源码');
    assert.doesNotMatch(source, /from\s*['"][^'"]*mock[^'"]*['"]/, '真实网关不得静态引用 mock');
    assert.doesNotMatch(source, /import\s*\(\s*['"][^'"]*mock[^'"]*['"]\s*\)/, '真实网关不得动态引用 mock');
    for (const route of [
      '/inspector/prompt', '/inspector/requests', '/inspector/replay', '/inspector/tools',
      '/inspector/trace', '/inspector/context', '/inspector/recall', '/inspector/diffs',
    ]) {
      assert.ok(source.includes(route), '缺少路由 ' + route);
    }
  });
});
