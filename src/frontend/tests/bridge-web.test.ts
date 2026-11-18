/**
 * BridgeGateway 联网检索/抓取接线测试（2026-10-30）。
 *
 * 真实后台已通过现有 /v1/product 分发器暴露：
 *   POST /v1/product/web/search  { query } -> WebSearchResult[]（附 provider 的 source 标签）
 *   POST /v1/product/web/fetch   { url }   -> WebPage（status 是来源页自身的 HTTP 状态，不是后台请求状态）
 * 失败体 { code, error, attempts? }：INVALID_QUERY/INVALID_URL/URL_BLOCKED/CRAWL_LIMIT=400，
 * NETWORK_DISABLED/PROXY_UNSUPPORTED/SEARCH_CONFIGURATION=409，TIMEOUT=504，CANCELLED=408，CLOSED=503，其余 502。
 * bridge 必须原样保留 code/message（现有 request() 把 {...body, httpStatus>=400} 映射为 GatewayError），
 * 不得伪造成功、吞错或改写错误码。
 *
 * 覆盖：
 *   A. 传输桩：精确路由与 body、source/来源状态 201/206 不被改写、错误码原样保留、失败不伪造成功；
 *   B. 真实端到端：真实 startBackend（仅 127.0.0.1）+ 真实 ExternalTools + 仅注入确定性 fetch 传输，
 *      验证 Bridge -> 真实 HTTP -> 产品 DTO 的字段、零模型调用、零 Kernel 任务。
 *
 * 约束：A 只用本地传输桩；B 的网页来源全部由注入传输提供，不访问公网。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { BridgeGateway } from '../api/bridge';
import { GatewayError } from '../api/contract';
import type { WebPage, WebSearchResult } from '../api/types';

const PREFIX = '/v1/product';
const WORKTREE = process.cwd();
const FIXTURE_ROOT = path.join(WORKTREE, '.tmp', 'network-integration', 'b', 'bridge-web');
/** 主树把真实后台编译到这里后，B 组用例才会运行（可用 NPN_NETWORK_PRODUCT_BUILD 覆盖）。 */
const BUILD_ROOT = path.resolve(process.env.NPN_NETWORK_PRODUCT_BUILD
  ?? (existsSync(path.join(WORKTREE, 'build', 'src', 'app', 'backend.js'))
    ? path.join(WORKTREE, 'build')
    : path.join(WORKTREE, '.tmp', 'network-integration', 'root', 'build')));
const PUBLIC_DNS = async (): Promise<{ address: string; family: number }[]> => [{ address: '93.184.216.34', family: 4 }];

interface NpnCall { method: string; path: string; body: unknown }

interface FixtureTransport {
  npn: {
    request(method: string, path: string, body?: unknown): Promise<unknown>;
    desktop(action: string, payload?: unknown): Promise<unknown>;
  };
  calls: NpnCall[];
}

/** 记录 method/path/body 的传输桩；reply 决定返回的产品 DTO 或错误体。 */
function fixtureTransport(reply: (call: NpnCall) => unknown): FixtureTransport {
  const calls: NpnCall[] = [];
  return {
    calls,
    npn: {
      async request(method: string, path: string, body?: unknown): Promise<unknown> {
        const call: NpnCall = { method, path, body };
        calls.push(call);
        return reply(call);
      },
      async desktop(action: string): Promise<unknown> {
        throw new Error('本组测试不期望桌面动作：' + action);
      },
    },
  };
}

async function gatewayError(run: () => Promise<unknown>): Promise<GatewayError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof GatewayError) return error;
    return assert.fail('预期 GatewayError，实际：' + String(error));
  }
  return assert.fail('预期抛出 GatewayError');
}

describe('BridgeGateway 联网检索/抓取映射（传输桩）', () => {
  test('web.search：POST /v1/product/web/search，body 只含 query，source 原样保留', async () => {
    const fixture: WebSearchResult[] = [{ title: 'Fixture result', url: 'https://www.example.org/result', snippet: 'Deterministic snippet', source: 'fixture-provider' }];
    const { npn, calls } = fixtureTransport(() => fixture);
    const gateway = new BridgeGateway(npn);
    const results: WebSearchResult[] = await gateway.web.search('fixture query');
    assert.deepEqual(calls, [{ method: 'POST', path: PREFIX + '/web/search', body: { query: 'fixture query' } }]);
    assert.deepEqual(results, fixture);
    assert.equal(results[0]?.source, 'fixture-provider', 'provider 来源标签不得被 bridge 抹掉');
  });

  test('web.fetch：POST /v1/product/web/fetch，来源状态 201/206 与页面元数据原样保留', async () => {
    for (const status of [201, 206]) {
      const requestedUrl = `https://www.example.org/page-${status}`;
      const page: WebPage = {
        url: requestedUrl, title: 'Fixture page', text: '# Fixture body', fetchedAt: '2026-10-30T00:00:00.000Z', status,
        requestedUrl, contentType: 'text/html; charset=utf-8', trust: 'untrusted',
      };
      const { npn, calls } = fixtureTransport(() => page);
      const gateway = new BridgeGateway(npn);
      const result: WebPage = await gateway.web.fetch(requestedUrl);
      assert.deepEqual(calls, [{ method: 'POST', path: PREFIX + '/web/fetch', body: { url: requestedUrl } }]);
      assert.equal(result.status, status, '来源页 HTTP 状态必须原样保留，不得按后台 200 改写');
      assert.equal(result.url, requestedUrl);
      assert.equal(result.requestedUrl, requestedUrl);
      assert.equal(result.contentType, 'text/html; charset=utf-8');
      assert.equal(result.trust, 'untrusted');
      assert.equal(result.title, 'Fixture page');
      assert.equal(result.fetchedAt, '2026-10-30T00:00:00.000Z');
    }
  });

  test('错误码原样保留：NETWORK_DISABLED 409、INVALID_URL 400、TIMEOUT 504', async () => {
    const cases: { name: string; status: number; code: string; message: string; retryable: boolean; route: string; run: (gateway: BridgeGateway) => Promise<unknown> }[] = [
      {
        name: 'NETWORK_DISABLED 409', status: 409, code: 'NETWORK_DISABLED', message: 'Web search is disabled in Settings.', retryable: false,
        route: '/web/search', run: gateway => gateway.web.search('fixture query'),
      },
      {
        name: 'INVALID_URL 400', status: 400, code: 'INVALID_URL', message: 'Use an absolute HTTP or HTTPS URL.', retryable: false,
        route: '/web/fetch', run: gateway => gateway.web.fetch('not a url'),
      },
      {
        name: 'TIMEOUT 504', status: 504, code: 'TIMEOUT', message: 'Network request timed out.', retryable: true,
        route: '/web/fetch', run: gateway => gateway.web.fetch('https://www.example.org/slow'),
      },
    ];
    for (const item of cases) {
      const { npn, calls } = fixtureTransport(() => ({ httpStatus: item.status, code: item.code, error: item.message }));
      const gateway = new BridgeGateway(npn);
      const error = await gatewayError(() => item.run(gateway));
      assert.equal(calls.length, 1, item.name);
      assert.equal(calls[0]?.method, 'POST', item.name);
      assert.equal(calls[0]?.path, PREFIX + item.route, item.name);
      assert.equal(error.code, item.code, item.name + ' 的错误码不得被改写');
      assert.equal(error.message, item.message, item.name + ' 的错误消息不得被改写');
      assert.equal(error.retryable, item.retryable, item.name + ' 的 retryable 沿用现有 httpError 规则');
    }
  });

  test('传输失败如实抛出：不伪造页面或搜索结果', async () => {
    const failing = fixtureTransport(() => { throw new Error('socket closed'); });
    const gateway = new BridgeGateway(failing.npn);
    const fetchError = await gatewayError(() => gateway.web.fetch('https://www.example.org/page'));
    assert.equal(fetchError.code, 'transport_error');
    assert.match(fetchError.message, /socket closed/);
    const searchError = await gatewayError(() => gateway.web.search('fixture query'));
    assert.equal(searchError.code, 'transport_error');
    assert.equal(failing.calls.length, 2, '两次失败都真实发起了传输，没有本地假成功');
  });

  test('bridge 源码不引用演示网关，web 直接映射产品路由', () => {
    const source = readFileSync(path.join(WORKTREE, 'src', 'frontend', 'api', 'bridge.ts'), 'utf8');
    assert.equal(/from\s+['"][^'"]*mock/i.test(source), false, '真实网关不得引用 api/mock/**');
    assert.equal(/notWired\(\s*'web\./.test(source), false, 'web.fetch/search 不应再走 notWired');
    assert.match(source, /this\.request(?:<[^>]*>)?\(\s*'POST',\s*'\/web\/search'/, 'web.search 必须直连 /web/search');
    assert.match(source, /this\.request(?:<[^>]*>)?\(\s*'POST',\s*'\/web\/fetch'/, 'web.fetch 必须直连 /web/fetch');
  });
});

// ---------- 真实端到端：Bridge -> 真实 loopback HTTP -> ExternalTools 注入传输 ----------

interface BackendRuntime {
  port: number;
  token: string;
  services: {
    external: ExternalToolsLike;
    kernel: { listTasks(): unknown[] };
  };
  close(): Promise<void>;
}

interface ExternalToolsLike { close(): Promise<void>; configureWeb(input: { webSearch?: boolean }): unknown }

type ExternalToolsConstructor = new (options: {
  dataDir: string;
  projectRoot: string;
  webOptions: { searchProvider: 'wikipedia'; resolveDns: typeof PUBLIC_DNS; fetch: typeof fetch };
}) => ExternalToolsLike;

interface BackendOptions {
  dataDir: string;
  projectRoot: string;
  mockOptions?: { responder?: (body: unknown, index: number) => Promise<{ content: string }> };
}

const PAGE_201 = 'https://www.example.org/bridge/page-201';
const PAGE_206 = 'https://www.example.org/bridge/page-206';
const PAGE_200 = 'https://www.example.org/bridge/page-200';
const SEARCH_ORIGIN = 'en.wikipedia.org';

function htmlPage(title: string, body: string, status: number): Response {
  return new Response(`<title>${title}</title><main>${body}</main>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

describe('BridgeGateway 联网检索/抓取（真实后台 HTTP）', () => {
  test('Bridge -> 真实 loopback HTTP -> ExternalTools 注入传输 -> 真实 DTO', { timeout: 60000 }, async t => {
    const backendFile = path.join(BUILD_ROOT, 'src', 'app', 'backend.js');
    const externalFile = path.join(BUILD_ROOT, 'src', 'app', 'external-tools.js');
    if (!existsSync(backendFile) || !existsSync(externalFile)) {
      throw new Error(`真实后台构建不存在：${backendFile}。请先用主树编译到 ${BUILD_ROOT}（或设置 NPN_NETWORK_PRODUCT_BUILD 指向构建目录），本测试不会自己创建构建。`);
    }
    const backendModule = (await import(pathToFileURL(backendFile).href)) as { startBackend(options: BackendOptions): Promise<BackendRuntime> };
    const externalModule = (await import(pathToFileURL(externalFile).href)) as { ExternalTools: ExternalToolsConstructor };

    mkdirSync(FIXTURE_ROOT, { recursive: true });
    const owned = mkdtempSync(path.join(FIXTURE_ROOT, 'case-'));
    let backend: BackendRuntime | undefined;
    let originalExternal: ExternalToolsLike | undefined;
    t.after(async () => {
      try {
        if (backend) await backend.close();
      } finally {
        if (originalExternal) await originalExternal.close();
        rmSync(owned, { recursive: true, force: true });
      }
    });

    // 确定性传输：只认识固定来源 URL；任何未声明的目标都会抛错，证明没有访问公网。
    let fixtureCalls = 0;
    const fixtureFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      fixtureCalls += 1;
      const url = new URL(String(input));
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.hostname === SEARCH_ORIGIN) {
        return new Response(JSON.stringify({ query: { search: [{ title: 'Fixture result', snippet: 'Deterministic snippet' }] } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.href === PAGE_201) return htmlPage('Fixture 201', 'Deterministic body 201', 201);
      if (url.href === PAGE_206) return htmlPage('Fixture 206', 'Deterministic body 206', 206);
      if (url.href === PAGE_200) return htmlPage('Fixture 200', 'Deterministic body 200', 200);
      throw new Error('Unexpected fixture network request: ' + url.href);
    }) as typeof fetch;

    let modelCalls = 0;
    backend = await backendModule.startBackend({
      dataDir: path.join(owned, 'data'),
      projectRoot: WORKTREE,
      mockOptions: { responder: async () => { modelCalls += 1; return { content: 'model calls are not allowed in this test' }; } },
    });
    const runtime = backend;
    const tasksBefore = runtime.services.kernel.listTasks().length;
    assert.equal(tasksBefore, 0, '全新 dataDir 不应有 Kernel 任务');

    const external = new externalModule.ExternalTools({
      dataDir: path.join(owned, 'network'),
      projectRoot: WORKTREE,
      // 只注入确定性传输；真实 ExternalTools/真实 WebClient/真实校验链路保持不变。
      webOptions: { searchProvider: 'wikipedia', resolveDns: PUBLIC_DNS, fetch: fixtureFetch },
    });
    originalExternal = runtime.services.external;
    runtime.services.external = external;

    let lastHttpStatus = 0;
    const npn = {
      async request(method: string, pathName: string, body?: unknown): Promise<unknown> {
        const response = await fetch(`http://127.0.0.1:${runtime.port}${pathName}`, {
          method,
          headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        lastHttpStatus = response.status;
        const value: unknown = await response.json();
        // 与 desktop 主进程一致：非 2xx 不 reject，而是把 httpStatus 附在 body 上。
        return response.status >= 400 && value !== null && typeof value === 'object' && !Array.isArray(value)
          ? { ...(value as Record<string, unknown>), httpStatus: response.status }
          : value;
      },
      async desktop(): Promise<never> { throw new Error('本测试不使用桌面动作'); },
    };
    const gateway = new BridgeGateway(npn);

    const page201 = await gateway.web.fetch(PAGE_201);
    assert.equal(lastHttpStatus, 200, '后台自身成功响应是 200');
    assert.equal(page201.status, 201, 'DTO.status 必须是来源页的 201，而不是后台的 200');
    assert.equal(page201.url, PAGE_201);
    assert.equal(page201.requestedUrl, PAGE_201);
    assert.equal(page201.contentType, 'text/html; charset=utf-8');
    assert.equal(page201.trust, 'untrusted');
    assert.equal(page201.title, 'Fixture 201');
    assert.match(page201.text, /Deterministic body 201/);
    assert.equal(typeof page201.fetchedAt, 'string');

    const page206 = await gateway.web.fetch(PAGE_206);
    assert.equal(lastHttpStatus, 200);
    assert.equal(page206.status, 206, '206 部分内容状态同样必须原样保留');
    assert.match(page206.text, /Deterministic body 206/);

    const page200 = await gateway.web.fetch(PAGE_200);
    assert.equal(lastHttpStatus, 200);
    assert.equal(page200.status, 200, '200 对照页保持 200');

    const results = await gateway.web.search('fixture query');
    assert.deepEqual(results, [{
      title: 'Fixture result',
      url: 'https://en.wikipedia.org/wiki/Fixture_result',
      snippet: 'Deterministic snippet',
      source: 'wikipedia',
    }], '搜索结果的 provider 来源标签必须来自后台，不能由 bridge 编造');

    const invalid = await gatewayError(() => gateway.web.fetch('not a url'));
    assert.equal(invalid.code, 'INVALID_URL', '真实后台的 400 INVALID_URL 必须原样保留');
    assert.equal(invalid.message, 'Use an absolute HTTP or HTTPS URL.');
    assert.equal(invalid.retryable, false);

    // 通过真实 HTTP 配置关闭 webSearch，验证 409 NETWORK_DISABLED 的端到端保留。
    const configure = await fetch(`http://127.0.0.1:${runtime.port}/v1/config`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ webSearch: false }),
    });
    assert.equal(configure.status, 200);
    const configured = await configure.json() as { webSearch?: boolean };
    assert.equal(configured.webSearch, false, '开关确实写入真实 ExternalTools');
    const disabled = await gatewayError(() => gateway.web.search('fixture query'));
    assert.equal(disabled.code, 'NETWORK_DISABLED');
    assert.equal(disabled.message, 'Web search is disabled in Settings.');
    assert.equal(disabled.retryable, false);

    assert.equal(fixtureCalls, 5, '三次页面抓取（首次 robots + 3 页）+ 一次搜索，且没有额外网络请求');
    assert.equal(modelCalls, 0, '手动浏览不触发任何模型调用');
    assert.equal(runtime.services.kernel.listTasks().length, tasksBefore, '手动浏览不创建 Kernel 任务');
  });
});
