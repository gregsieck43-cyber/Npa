import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { _electron } from 'playwright';
const root = path.resolve(import.meta.dirname, '../../../..'), label = process.argv[2];
assert.match(label ?? '', /^[a-z0-9-]+$/);
const base = path.join(root, '.tmp/mcp-inspector-definition-20261104'); mkdirSync(base, { recursive: true });
const tmp = mkdtempSync(path.join(base, 'dom-'));
for (const name of ['build', 'tmp', 'home', 'appdata', 'localappdata', 'user', 'fixture']) mkdirSync(path.join(tmp, name));
for (const [key, dir] of Object.entries({ TEMP: 'tmp', TMP: 'tmp', HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata' })) process.env[key] = path.join(tmp, dir);
const report = path.join(root, 'evidence/backend-20261026', label + '.json'); assert.equal(existsSync(report), false);
const checks = [], errors = []; let app, backend, page, requests = [], modelCalls = 0, catalogReads = 0, stopped = false;
const check = async (name, fn) => { try { await fn(); checks.push({ name, passed: true }); console.log('PASS ' + name); } catch (error) { checks.push({ name, passed: false, error: String(error.stack) }); console.log('FAIL ' + name + ': ' + error.message); } };
try {
  await build({ absWorkingDir: root, entryPoints: [path.join(import.meta.dirname, 'entry.tsx')], outdir: path.join(tmp, 'build'), entryNames: 'bundle', bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { __NPN_GATEWAY__: '"bridge"', 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });
  writeFileSync(path.join(tmp, 'build/index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>*,*::before,*::after{animation:none!important;transition:none!important}</style><div id="root"></div><script src="bundle.js"></script>');
  const { startBackend } = await import(pathToFileURL(path.join(base, 'build/src/app/backend.js')).href);
  const fixture = path.join(tmp, 'fixture');
  backend = await startBackend({ projectRoot: fixture, productRoot: fixture, dataDir: path.join(fixture, 'data'), mockOptions: { trace: () => modelCalls++ } });
  backend.services.external.tools = async () => { catalogReads++; throw new Error('Do not read current catalog for history'); };
  const store = backend.services.harness.store, session = store.createSession();
  const request = store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'chat', status: 'completed', endpoint: 'fixture', bodyHash: 'fixture', recordContent: true, body: { model: 'mock', messages: [], tools: [{ type: 'function', function: { name: 'mcp_call', parameters: { type: 'object', description: 'Generic wrapper schema' } } }] }, sources: [], draft: '' });
  const definition = { serverId: 'disconnected-historical-server', toolName: 'lookup', digest: 'd'.repeat(64), available: true, description: 'Historical MCP v1', inputSchema: { type: 'object', description: '旧'.repeat(7000), api_key: 'NEVER-DISCLOSE' }, annotations: { readOnlyHint: true } };
  const call = { id: request.id + ':call', requestId: request.id, sessionId: session.id, toolCallId: 'call', name: 'mcp_call', source: 'MCP', arguments: {}, status: 'succeeded', permission: 'approved', retries: 0, createdAt: request.createdAt, updatedAt: request.updatedAt };
  store.saveTool({ ...call, mcpDefinition: definition });
  store.saveTool({ ...call, id: request.id + ':missing', toolCallId: 'missing' });
  store.saveTool({ ...call, id: request.id + ':disabled', toolCallId: 'disabled', mcpDefinition: { serverId: definition.serverId, toolName: definition.toolName, digest: definition.digest, available: false } });
  const env = { ...process.env, NPN_UI_TEST_ROOT: path.join(tmp, 'user'), NPN_UI_TEST_PAGE: path.join(tmp, 'build/index.html'), NPN_UI_BACKEND_PORT: String(backend.port), NPN_UI_BACKEND_TOKEN: backend.token }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(import.meta.dirname, '../mcp-completion-dom/app.cjs')], cwd: tmp, env });
  page = await app.firstWindow(); page.setDefaultTimeout(4000); page.on('pageerror', error => errors.push(String(error)));
  await page.waitForFunction(() => typeof window.__render === 'function');
  const render = async id => { await page.evaluate(([session, call]) => window.__render(session, call), [session.id, id]); await page.getByLabel('调用快照字段').waitFor(); await page.locator('.code-block pre').waitFor(); };
  await check('actual ToolDetail selects and pages the saved MCP definition separately from wrapper schema', async () => {
    await render(call.id); assert.match(await page.locator('.code-block pre').innerText(), /Generic wrapper schema/);
    await page.getByLabel('调用快照字段').selectOption('mcpDefinition');
    await page.waitForFunction(() => document.querySelector('.code-block pre')?.textContent.includes('Historical MCP v1'));
    const first = await page.locator('.code-block pre').innerText(); assert.ok(first.length <= 6000); assert.match(first, /dddddddd/);
    await page.getByRole('button', { name: '下一段', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.code-block pre')?.textContent.includes('credential redacted'));
    const second = await page.locator('.code-block pre').innerText(); assert.ok(second.length < 6000); assert.doesNotMatch(second, /Historical MCP v1/);
    const value = JSON.parse(first + second); assert.equal(value.inputSchema.description, definition.inputSchema.description); assert.equal(value.digest, definition.digest);
    assert.doesNotMatch(first + second, /NEVER-DISCLOSE/);
    await page.getByRole('button', { name: '上一段', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.code-block pre')?.textContent.includes('Historical MCP v1'));
    assert.equal(await page.locator('.code-block pre').innerText(), first);
  });
  await check('missing and disabled historical MCP definitions show explicit unavailable messages', async () => {
    await render(request.id + ':missing'); await page.getByLabel('调用快照字段').selectOption('mcpDefinition');
    await page.getByText('本次调用未保存历史 MCP 工具定义。', { exact: true }).waitFor(); assert.equal(await page.locator('.code-block').count(), 0);
    await render(request.id + ':disabled'); await page.getByLabel('调用快照字段').selectOption('mcpDefinition');
    await page.getByText('本次调用未保存 MCP 定义正文（详细内容记录已关闭）。', { exact: true }).waitFor(); assert.equal(await page.locator('.code-block').count(), 0);
  });
  requests = await app.evaluate(() => global.testRequests); assert.equal(catalogReads, 0); assert.equal(modelCalls, 0);
  assert.equal(requests.some(request => request.route.includes('/catalog')), false);
} catch (error) { checks.push({ name: 'harness', passed: false, error: String(error.stack) }); }
finally {
  if (app) await app.close(); if (backend) { await backend.close(); stopped = true; }
  const files = ['src/product/api.ts', 'src/product/inspector.ts', 'src/frontend/api/types.ts', 'src/frontend/features/inspector/ToolDetail.tsx'];
  const inputs = files.map(file => ({ path: file, sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') }));
  const passed = checks.length === 2 && checks.every(item => item.passed) && !errors.length && stopped;
  writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), passed, checks, errors, requests, modelCalls, catalogReads, backendClosed: stopped, inputs, tempRoot: tmp, boundary: 'Real production component/Bridge/HTTP with public persisted historical fixtures; actual MCP first-prepare capture is independently covered by the backend worker stdio suite.' }, null, 2));
  console.log(report); process.exitCode = passed ? 0 : 1;
}
