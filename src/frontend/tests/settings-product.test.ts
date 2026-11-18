/**
 * Settings 产品接线的真实 HTTP 验收。
 *
 * 这里用真实的 BridgeGateway 打本机 HTTP，后端也不是桩：每个用例都启动真实的 src/app/backend
 * （真实 ProductApi、Settings/MCP/Skills 服务与 mock provider），断言据此覆盖真实路由、真实持久化
 * 文件和真实 MCP stdio 子进程。
 *
 * 为什么不直接 `import { startBackend } from '../../app/backend'`：前端 tests 工程继承
 * src/frontend/tsconfig.json 的 noUnusedLocals，TypeScript 会连带检查被引入的后端源码，而后端树中
 * 存在若干未使用局部变量（例如 src/product/api.ts 的 boundedInteger），那会让整个前端类型检查失败。
 * 因此这里用仓库已安装的 esbuild 把后端真实源码打包成 .tmp 下的临时 ESM 再动态 import；运行的是同一份
 * 后端代码，不是等价桩。修改后端源码不在本任务允许范围内。
 */
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { BridgeGateway, type NpnBridge } from '../api/bridge';
import { GatewayError } from '../api/contract';
import type { McpServerInput, Settings } from '../api/types';

interface PermissionRuleState { id: string; pattern: string; capability: string; decision: string }
interface Backend {
  port: number;
  token: string;
  services: { kernel: { permissionRules(): PermissionRuleState[] } };
  close(): Promise<void>;
}
interface StartBackendOptions {
  dataDir: string;
  projectRoot: string;
  mockOptions?: { responder?: (body: unknown, index: number) => { content: string } | Promise<{ content: string }> };
}
interface BackendModule {
  startBackend(options: StartBackendOptions): Promise<Backend>;
}

const suiteRoot = path.join(process.cwd(), '.tmp', 'settings-integration', 'a', 'settings-product-tests');
mkdirSync(suiteRoot, { recursive: true });
const backendBundle = path.join(suiteRoot, 'backend-' + process.pid + '.mjs');
let backendModule: Promise<BackendModule> | undefined;

/** 把真实后端源码打包成临时 ESM（只写 .tmp），同一测试进程内复用一次。 */
const loadBackendModule = (): Promise<BackendModule> => {
  backendModule ??= (async () => {
    const loadFromRepo = createRequire(import.meta.url);
    const esbuild = loadFromRepo('esbuild') as { buildSync(options: Record<string, unknown>): void };
    esbuild.buildSync({
      entryPoints: [path.join(process.cwd(), 'src', 'app', 'backend.ts')],
      bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent', outfile: backendBundle,
    });
    return await import(pathToFileURL(backendBundle).href) as unknown as BackendModule;
  })();
  return backendModule;
};

after(() => { rmSync(backendBundle, { force: true }); });

/** 真实 stdio MCP server：启动即写 launched.txt，支持 initialize / tools/list / tools/call。 */
const MCP_SERVER = [
  "import { createInterface } from 'node:readline';",
  "import { writeFileSync } from 'node:fs';",
  "writeFileSync('launched.txt', new Date().toISOString());",
  "const send = value => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));",
  "const reply = (id, result) => send({ jsonrpc: '2.0', id, result });",
  "createInterface({ input: process.stdin }).on('line', line => {",
  "  const request = JSON.parse(line);",
  "  if (request.id === undefined) return;",
  "  if (request.method === 'initialize') return reply(request.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'bridge-settings-fixture', version: '1.0.0' } });",
  "  if (request.method === 'tools/list') return reply(request.id, { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] });",
  "  if (request.method === 'tools/call') return reply(request.id, { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] });",
  "});",
].join('\n');

interface McpFixture { target: string; launched: string }
const createMcpFixture = (dir: string): McpFixture => {
  const runtime = path.join(dir, 'node.exe');
  linkSync(process.execPath, runtime);
  const server = path.join(dir, 'mcp-server.mjs');
  writeFileSync(server, MCP_SERVER, 'utf8');
  return { target: '"' + runtime + '" "' + server + '"', launched: path.join(dir, 'launched.txt') };
};

interface SetupOptions {
  responder?: (body: unknown, index: number) => { content: string } | Promise<{ content: string }>;
  configure?: (dir: string, workspace: string) => void;
}
interface WireCall { method: string; path: string; body: unknown }
interface Harness {
  dir: string;
  workspace: string;
  backend: Backend;
  gateway: BridgeGateway;
  calls: WireCall[];
  restart(): Promise<void>;
  close(): Promise<void>;
}

const until = async <T>(read: () => Promise<T | undefined>, timeoutMs = 30000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected state.');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
};

const setup = async (options: SetupOptions = {}): Promise<Harness> => {
  const module = await loadBackendModule();
  const dir = mkdtempSync(path.join(suiteRoot, 'case-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  options.configure?.(dir, workspace);
  const startOptions = (): StartBackendOptions => ({
    dataDir: path.join(dir, 'data'), projectRoot: process.cwd(),
    ...(options.responder ? { mockOptions: { responder: options.responder } } : {}),
  });
  let backend = await module.startBackend(startOptions());
  const calls: WireCall[] = [];
  const transport: NpnBridge = {
    request: async (method, route, body) => {
      calls.push({ method, path: route, body });
      const response = await fetch('http://127.0.0.1:' + backend.port + route, {
        method,
        headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json() as Record<string, unknown>;
      return response.ok ? payload : { ...payload, httpStatus: response.status };
    },
    desktop: async () => { throw new Error('Settings 接线测试不使用桌面动作。'); },
  };
  return {
    dir, workspace, calls,
    get backend() { return backend; },
    gateway: new BridgeGateway(transport),
    restart: async () => { await backend.close(); backend = await module.startBackend(startOptions()); },
    close: async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); },
  } as Harness;
};

/** 捕获 GatewayError；调用意外成功时直接失败，避免把普通异常误当成网关错误。 */
const gatewayError = async (run: () => Promise<unknown>): Promise<GatewayError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error('Expected the gateway call to reject with GatewayError, but it succeeded.');
};

const waitIdle = (harness: Harness, sessionId: string): Promise<unknown> => until(async () => {
  const session = await harness.gateway.sessions.get(sessionId);
  return ['idle', 'completed', 'failed', 'cancelled'].includes(session.status) ? session : undefined;
});

test('settings.get 走真实 HTTP 返回默认值，update 合并 appearance 并过滤空规则', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const initial = await env.gateway.settings.get();
  assert.deepEqual(initial.appearance, { theme: 'light', accent: 'ember', density: 'comfortable', motion: 'full', fontScale: 1, ambient: true });
  assert.deepEqual(initial.defaults, { mode: 'chat', permission: 'ask', modelId: 'default', sendKey: 'enter' });
  assert.deepEqual(initial.rules, []);
  assert.deepEqual(initial.privacy, { recordContent: true, redactSecrets: true });
  assert.deepEqual(initial.network, { webSearch: true, fetch: true, proxy: '' });
  assert.equal(initial.autoReview.reviewerModelId, '');
  assert.equal(initial.autoReview.explain, false);
  const read = env.calls.at(-1)!;
  assert.equal(read.method, 'GET');
  assert.equal(read.path, '/v1/product/settings');

  // 只改 theme 时，其它 appearance 字段必须保留（后端 deep partial 合并，Bridge 不得补默认值）。
  const full = { theme: 'dark', accent: 'jade', density: 'compact', motion: 'reduced', fontScale: 1.1, ambient: false } as const;
  const first = await env.gateway.settings.update({ appearance: full });
  assert.deepEqual(first.appearance, full);
  const second = await env.gateway.settings.update({ appearance: { theme: 'light' } });
  assert.deepEqual(second.appearance, { ...full, theme: 'light' });
  assert.deepEqual(env.calls.at(-1)!.body, { appearance: { theme: 'light' } });
  const reread = await env.gateway.settings.get();
  assert.deepEqual(reread.appearance, { ...full, theme: 'light' });

  // 空 pattern（界面新建但未填写的规则行）必须被 Bridge 过滤；后端收到空数组而不是 400。
  const emptied: Settings = await env.gateway.settings.update({ rules: [
    { id: 'r-empty', pattern: '', capability: 'exec', decision: 'ask' },
    { id: 'r-blank', pattern: '   ', capability: 'read', decision: 'allow' },
  ] });
  assert.deepEqual(emptied.rules, []);
  assert.deepEqual(env.calls.at(-1)!.body, { rules: [] });

  const saved = await env.gateway.settings.update({
    rules: [
      { id: 'r-empty', pattern: '', capability: 'exec', decision: 'ask' },
      { id: 'r-md', pattern: '**/*.md', capability: 'read', decision: 'allow' },
      { id: 'r-secret', pattern: '*.secret', capability: 'write', decision: 'deny' },
    ],
    privacy: { recordContent: false },
  });
  assert.deepEqual(saved.rules.map(rule => rule.id), ['r-md', 'r-secret']);
  assert.equal(saved.privacy.recordContent, false);
  assert.equal(saved.privacy.redactSecrets, true);
  const wire = env.calls.at(-1)!.body as { rules: unknown[]; privacy: unknown };
  assert.equal(wire.rules.length, 2);
  assert.deepEqual(wire.privacy, { recordContent: false });
  // 真实后端内核看到的就是过滤后的两条规则（不是只在响应里改形状）。
  assert.deepEqual(env.backend.services.kernel.permissionRules(), [
    { id: 'r-md', pattern: '**/*.md', capability: 'read', decision: 'allow' },
    { id: 'r-secret', pattern: '*.secret', capability: 'write', decision: 'deny' },
  ]);

  // 联网接线后，设置中的禁用状态必须由真实后端执行，且在访问公网前拒绝。
  await env.gateway.settings.update({ network: { fetch: false } });
  const beforeWeb = env.calls.length;
  const web = await gatewayError(() => env.gateway.web.fetch('https://example.com'));
  assert.equal(web.code, 'NETWORK_DISABLED');
  assert.equal(env.calls.length, beforeWeb + 1);
  assert.equal(env.calls.at(-1)!.path, '/v1/product/web/fetch');
});

test('settings.update 的后端校验错误经 Bridge 保留 code=validation，不改写也不吞掉', { timeout: 120000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  const error = await gatewayError(() => env.gateway.settings.update({ defaults: { modelId: 'missing-model' } }));
  assert.equal(error.code, 'validation');
  assert.equal(error.retryable, false);
  assert.ok(error.message.length > 0);
  const read = env.calls.at(-1)!;
  assert.equal(read.method, 'POST');
  assert.equal(read.path, '/v1/product/settings/update');
  assert.deepEqual(read.body, { defaults: { modelId: 'missing-model' } });
  const settings = await env.gateway.settings.get();
  assert.equal(settings.defaults.modelId, 'default', '被拒绝的 patch 不得留下部分修改');
});

test('MCP 批准：未批准保存返回 disconnected 且不启动，显式 digest 才连接，reconnect 只用持久化批准', { timeout: 180000 }, async t => {
  const env = await setup();
  t.after(() => env.close());
  assert.deepEqual(await env.gateway.settings.mcp(), []);

  const unsupported = await gatewayError(() => env.gateway.settings.saveMcp({
    name: 'remote', transport: 'http', target: 'https://example.invalid/mcp', enabled: true,
  }));
  assert.equal(unsupported.code, 'unsupported');

  const fixture = createMcpFixture(env.dir);
  const input: McpServerInput = { name: 'Bridge fixture', transport: 'stdio', target: fixture.target, enabled: true };
  const savesBefore = env.calls.filter(call => call.path === '/v1/product/settings/mcp/save').length;
  const unapproved = await env.gateway.settings.saveMcp(input);
  assert.equal(unapproved.status, 'disconnected');
  assert.equal(unapproved.tools, 0);
  assert.match(unapproved.digest ?? '', /^[a-f0-9]{64}$/);
  assert.match(unapproved.error ?? '', /approv/i);
  assert.equal(existsSync(fixture.launched), false, '没有精确 digest 批准时不得启动进程');
  const unapprovedWire = env.calls.at(-1)!;
  assert.equal(unapprovedWire.path, '/v1/product/settings/mcp/save');
  assert.equal('approvedDigest' in (unapprovedWire.body as Record<string, unknown>), false, 'Bridge 不得回填 approvedDigest');
  assert.equal(env.calls.filter(call => call.path === '/v1/product/settings/mcp/save').length - savesBefore, 1, '未批准时 Bridge 不得拿返回的 digest 自动重发');

  const approved = await env.gateway.settings.saveMcp({ ...input, id: unapproved.id, approvedDigest: unapproved.digest });
  assert.equal(approved.status, 'connected');
  assert.ok(approved.tools >= 1);
  assert.ok(existsSync(fixture.launched), '显式批准后真实 stdio 进程必须启动');
  const approvedWire = env.calls.at(-1)!;
  assert.equal((approvedWire.body as Record<string, unknown>).approvedDigest, unapproved.digest);
  const listed = await env.gateway.settings.mcp();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.status, 'connected');
  const catalog = await env.gateway.settings.mcpCatalog(approved.id);
  assert.equal(catalog.serverId, approved.id); assert.equal(catalog.total, 1);
  assert.equal(catalog.tools[0]!.chatAllowed, false, 'unannotated tools stay unavailable in Chat');
  assert.equal(catalog.tools[0]!.name, 'echo');
  assert.deepEqual((await env.gateway.settings.mcpCatalog(approved.id, 40)).tools, []);

  // 重启后连接断开，但批准已持久化；reconnect 不带参数，后台只复用持久化批准。
  await env.restart();
  const offline = await env.gateway.settings.mcp();
  assert.equal(offline[0]!.status, 'disconnected');
  const reconnected = await env.gateway.settings.reconnectMcp(approved.id);
  assert.equal(reconnected.status, 'connected');
  assert.ok(reconnected.tools >= 1);
  const reconnectCall = env.calls.at(-1)!;
  assert.equal(reconnectCall.path, '/v1/product/settings/mcp/' + approved.id + '/reconnect');
  assert.equal(reconnectCall.body, undefined);

  const missing = await gatewayError(() => env.gateway.settings.removeMcp('missing-server'));
  assert.equal(missing.code, 'not_found');
});

test('instructions、skills、toggleSkill、plugins 走真实发现与真实开关状态', { timeout: 120000 }, async t => {
  const env = await setup({ configure: (dir, _workspace) => {
    const dataDir = path.join(dir, 'data');
    const globalDir = path.join(dir, 'global');
    const skillRoot = path.join(dir, 'skills');
    const skillDir = path.join(skillRoot, 'marker-skill');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    const globalFile = path.join(globalDir, 'AGENTS.md');
    writeFileSync(globalFile, 'Global marker: bridge-settings-marker.', 'utf8');
    writeFileSync(path.join(skillDir, 'SKILL.md'),
      ['---', 'name: bridge-marker-skill', 'description: Unique bridge toggle marker skill.', '---', 'Mention bridge-skill-body-marker.'].join('\n'), 'utf8');
    writeFileSync(path.join(dataDir, 'configuration.json'), JSON.stringify({
      provider: { mode: 'mock', model: 'mock' }, globalPaths: [globalFile], skillRoots: [skillRoot],
    }), 'utf8');
  } });
  t.after(() => env.close());

  const instructions = await env.gateway.settings.instructions();
  assert.equal(env.calls.at(-1)!.path, '/v1/product/settings/instructions');
  const globalEntry = instructions.find(entry => entry.scope === 'global');
  assert.ok(globalEntry, '配置的全局 instructions 文件必须出现在真实发现结果里');
  assert.equal(globalEntry.status, 'loaded');
  assert.ok(globalEntry.sha256);

  const skills = await env.gateway.settings.skills();
  assert.equal(env.calls.at(-1)!.path, '/v1/product/settings/skills');
  const skill = skills.find(item => item.name === 'bridge-marker-skill');
  assert.ok(skill, '真实 SKILL.md 必须被发现');
  assert.equal(skill.enabled, true);

  const toggled = await env.gateway.settings.toggleSkill(skill.id, false);
  assert.equal(toggled.enabled, false);
  const toggleCall = env.calls.at(-1)!;
  assert.equal(toggleCall.method, 'POST');
  assert.equal(toggleCall.path, '/v1/product/settings/skills/' + encodeURIComponent(skill.id) + '/toggle');
  assert.deepEqual(toggleCall.body, { enabled: false });
  const refreshed = await env.gateway.settings.skills();
  assert.equal(refreshed.find(item => item.id === skill.id)?.enabled, false);

  const plugins = await env.gateway.settings.plugins();
  assert.equal(env.calls.at(-1)!.path, '/v1/product/settings/plugins');
  assert.ok(Array.isArray(plugins));
});

test('clearHistory 真实清除非 pinned 会话并保留 pinned', { timeout: 180000 }, async t => {
  const env = await setup({ responder: (_body, index) => ({ content: 'reply ' + index }) });
  t.after(() => env.close());
  const pinned = await env.gateway.chat.send({ mode: 'chat', text: 'pinned conversation', attachments: [], permission: 'ask', modelId: 'default' });
  await waitIdle(env, pinned.sessionId);
  const updated = await env.gateway.sessions.update(pinned.sessionId, { pinned: true });
  assert.equal(updated.pinned, true);
  const unpinned = await env.gateway.chat.send({ mode: 'chat', text: 'ephemeral conversation', attachments: [], permission: 'ask', modelId: 'default' });
  await waitIdle(env, unpinned.sessionId);
  const before = await env.gateway.sessions.list({ limit: 100 });
  assert.deepEqual(before.items.map(item => item.id).sort(), [pinned.sessionId, unpinned.sessionId].sort());

  await env.gateway.settings.clearHistory();
  const clearCall = env.calls.at(-1)!;
  assert.equal(clearCall.method, 'POST');
  assert.equal(clearCall.path, '/v1/product/settings/clear-history');
  assert.deepEqual(clearCall.body, {});

  const afterClear = await env.gateway.sessions.list({ limit: 100 });
  assert.deepEqual(afterClear.items.map(item => item.id), [pinned.sessionId]);
});
