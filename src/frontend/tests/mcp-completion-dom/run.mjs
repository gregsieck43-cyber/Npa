import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { _electron } from 'playwright';

// An explicit manifest and digest are mandatory. Never select a recent successful run implicitly.
const [sourceArg, manifestArg, manifestSha, label = 'mcp-completion-dom'] = process.argv.slice(2);
assert.ok(sourceArg && manifestArg && /^[a-f0-9]{64}$/.test(manifestSha ?? ''), 'usage: run.mjs sourceRoot frozenManifest manifestSHA [reportLabel]');
assert.match(label, /^[a-z0-9-]+$/);
const root = path.resolve(import.meta.dirname, '../../../..');
const source = path.resolve(sourceArg), manifestPath = path.resolve(manifestArg);
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
assert.equal(sha(manifestPath), manifestSha, 'exact frozen manifest');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const frozenInputs = manifest.inputs ?? manifest.files;
assert.ok(Array.isArray(frozenInputs) && frozenInputs.length > 0);
const verify = () => frozenInputs.map(input => {
  assert.ok(!path.isAbsolute(input.path) && !input.path.split(/[\\/]/).includes('..'));
  const actual = sha(path.join(source, input.path));
  assert.equal(actual, input.sha256, `frozen input ${input.path}`);
  return { path: input.path, sha256: actual };
});
const inputs = verify();
const tmpRoot = path.join(root, '.tmp/mcp-dom-validation-20261104');
mkdirSync(tmpRoot, { recursive: true });
const tmp = mkdtempSync(path.join(tmpRoot, 'run-'));
for (const name of ['tmp', 'home', 'appdata', 'localappdata', 'user', 'renderer', 'fixture']) mkdirSync(path.join(tmp, name));
for (const [key, dir] of Object.entries({ TEMP: 'tmp', TMP: 'tmp', HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata' })) process.env[key] = path.join(tmp, dir);
const reportDir = path.join(root, 'evidence/backend-20261026/mcp-completion-dom');
mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `${label}.json`);
assert.equal(existsSync(reportPath), false, 'preserve prior evidence: select a new explicit report label');
const checks = [], errors = [], requests = [];
let app, page, backend, modelCalls = 0, stable = false, backendClosed = false, processStopped = false;
let serverId, firstDigest, approvedDigest, rendererInputs = [];
const fixture = path.join(tmp, 'fixture');
const starts = () => existsSync(path.join(fixture, 'starts.jsonl')) ? readFileSync(path.join(fixture, 'starts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const check = async (name, fn) => {
  try { await fn(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (failure) { checks.push({ name, passed: false, error: String(failure.stack) }); console.log('FAIL ' + name + ': ' + failure.message); }
};
const readHttp = async route => {
  const response = await fetch(`http://127.0.0.1:${backend.port}/v1/product${route}`, { headers: { Authorization: `Bearer ${backend.token}` } });
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
};
try {
  const compilerLog = execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(source, 'tsconfig.json'), '--outDir', path.join(tmp, 'build')], { cwd: source, env: process.env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  writeFileSync(path.join(tmp, 'compile.txt'), compilerLog);
  writeFileSync(path.join(tmp, 'build/package.json'), '{"type":"module"}');
  const entry = path.join(import.meta.dirname, 'entry.tsx');
  const overrides = {
    '../../styles/index.css': 'src/frontend/styles/index.css', '../../api': 'src/frontend/api/index.ts',
    '../../app/store': 'src/frontend/app/store.ts', '../../features/pages/SettingsView': 'src/frontend/features/pages/SettingsView.tsx',
    '../../features/session/SessionOptions': 'src/frontend/features/session/SessionOptions.tsx',
  };
  const result = await build({ absWorkingDir: source, entryPoints: [entry], outdir: path.join(tmp, 'renderer'), entryNames: 'bundle', bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', metafile: true,
    define: { __NPN_GATEWAY__: '"bridge"', 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning',
    plugins: [{ name: 'explicit-production-inputs', setup(builder) { builder.onResolve({ filter: /^\.\.\/\.\.\// }, args => args.importer === entry && overrides[args.path] ? { path: path.join(source, overrides[args.path]) } : undefined); } }],
  });
  rendererInputs = Object.keys(result.metafile.inputs).map(file => path.resolve(source, file)).filter(file => file.startsWith(source + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`)).map(file => ({ path: path.relative(source, file).split(path.sep).join('/'), sha256: sha(file) }));
  assert.ok(rendererInputs.some(input => input.path === 'src/frontend/features/pages/SettingsView.tsx'));
  assert.ok(rendererInputs.some(input => input.path === 'src/frontend/api/bridge.ts'));
  writeFileSync(path.join(tmp, 'renderer/index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}</style><div id="root"></div><script src="bundle.js"></script>');
  linkSync(process.execPath, path.join(fixture, 'node.exe'));
  copyFileSync(path.join(import.meta.dirname, 'server.mjs'), path.join(fixture, 'server.mjs'));
  const target = `"${path.join(fixture, 'node.exe')}" "${path.join(fixture, 'server.mjs')}"`;
  const { startBackend } = await import(pathToFileURL(path.join(tmp, 'build/src/app/backend.js')).href);
  backend = await startBackend({ projectRoot: fixture, productRoot: fixture, dataDir: path.join(fixture, 'data'), mockOptions: { trace: () => modelCalls++ } });
  const session = backend.services.harness.store.createSession({ title: 'MCP DOM fixture' });
  const env = { ...process.env, NPN_UI_TEST_ROOT: path.join(tmp, 'user'), NPN_UI_TEST_PAGE: path.join(tmp, 'renderer/index.html'), NPN_UI_BACKEND_PORT: String(backend.port), NPN_UI_BACKEND_TOKEN: backend.token };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(import.meta.dirname, 'app.cjs')], cwd: tmp, env });
  page = await app.firstWindow(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.waitForFunction(() => typeof window.__render === 'function');
  const render = async kind => {
    const id = await page.evaluate(([kind, sessionId]) => window.__render(kind, sessionId), [kind, session.id]);
    await page.locator(`[data-render="${id}"]`).waitFor({ state: 'attached' });
  };
  await render('settings');
  await check('save config exposes its exact digest without starting MCP', async () => {
    await page.getByRole('button', { name: '添加服务器', exact: true }).click();
    await page.getByPlaceholder('例如 filesystem').fill('DOM MCP fixture');
    await page.locator('.model-form input').nth(1).fill(target);
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await page.getByRole('button', { name: '批准该配置并连接', exact: true }).waitFor();
    const servers = await readHttp('/settings/mcp'); assert.equal(servers.length, 1);
    serverId = servers[0].id; firstDigest = servers[0].digest;
    assert.match(firstDigest, /^[a-f0-9]{64}$/);
    assert.equal(await page.locator('[role="status"] code').innerText(), firstDigest);
    assert.equal(servers[0].status, 'disconnected'); assert.equal(starts().length, 0);
    const calls = await app.evaluate(() => global.testRequests.filter(call => call.method === 'POST' && call.route === '/v1/product/settings/mcp/save'));
    assert.equal(calls.length, 1); assert.equal(calls[0].body.approvedDigest, undefined);
  });
  await check('editing clears the reviewed digest and only explicit current approval starts MCP', async () => {
    await page.locator('.model-form input').nth(1).fill(target + ' changed-configuration');
    assert.equal(await page.getByRole('button', { name: '批准该配置并连接', exact: true }).count(), 0);
    assert.equal(await page.locator('[role="status"] code').count(), 0);
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await page.getByRole('button', { name: '批准该配置并连接', exact: true }).waitFor();
    const current = (await readHttp('/settings/mcp'))[0]; approvedDigest = current.digest;
    assert.notEqual(approvedDigest, firstDigest); assert.equal(starts().length, 0);
    assert.equal(await page.locator('[role="status"] code').innerText(), approvedDigest);
    await page.getByRole('button', { name: '批准该配置并连接', exact: true }).click();
    await page.getByText('已连接', { exact: true }).waitFor();
    assert.equal((await readHttp('/settings/mcp'))[0].status, 'connected');
    assert.equal(starts().length, 1);
    const calls = await app.evaluate(() => global.testRequests.filter(call => call.method === 'POST' && call.route === '/v1/product/settings/mcp/save'));
    assert.equal(calls.length, 3); assert.equal(calls[1].body.approvedDigest, undefined);
    assert.equal(calls[2].body.approvedDigest, approvedDigest);
  });
  await check('actual MCP catalog replaces forty-item pages and exposes real readonly boundaries', async () => {
    await page.getByRole('button', { name: '查看工具', exact: true }).click();
    await page.getByText('fixture_00 · Chat 可读取', { exact: true }).waitFor();
    assert.equal(await page.locator('details').count(), 40);
    await page.locator('summary').first().click();
    await page.getByText('Actual fixture description 0', { exact: true }).waitFor();
    assert.match(await page.locator('details').first().locator('pre').innerText(), /Query 0/);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.getByText('fixture_41 · 仅 Cowork', { exact: true }).waitFor();
    assert.equal(await page.locator('details').count(), 2);
    assert.equal(await page.getByText('fixture_00 · Chat 可读取', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await page.getByText('fixture_00 · Chat 可读取', { exact: true }).waitFor();
    assert.equal(await page.locator('details').count(), 40);
    const calls = await app.evaluate(() => global.testRequests.filter(call => call.route.includes('/catalog?')));
    assert.deepEqual(calls.map(call => new URL(call.route, 'http://local').searchParams.get('offset')), ['0', '40', '0']);
    await page.getByRole('contentinfo').getByRole('button', { name: '关闭', exact: true }).click();
  });
  await check('Chat MCP switch persists through actual API and a fresh settings mount', async () => {
    await render('session');
    const control = page.getByRole('switch', { name: 'MCP', exact: true }); await control.waitFor();
    assert.equal(await control.isDisabled(), false); assert.equal(await control.getAttribute('aria-checked'), 'false');
    await control.click(); await page.getByRole('button', { name: '保存会话设置', exact: true }).click();
    await page.getByText('已保存；仅影响后续请求，历史请求保持不变。', { exact: true }).waitFor();
    assert.equal(backend.services.harness.store.getSession(session.id).capabilities.mcp, true);
    await render('session'); await control.waitFor(); assert.equal(await control.getAttribute('aria-checked'), 'true');
    const calls = await app.evaluate(() => global.testRequests.filter(call => call.method === 'POST' && call.route.includes('/session-settings')));
    assert.equal(calls.length, 1); assert.equal(calls[0].body.capabilities.mcp, true);
  });
  requests.push(...await app.evaluate(() => global.testRequests));
  assert.equal(modelCalls, 0); assert.equal(existsSync(path.join(fixture, 'calls.jsonl')), false);
  verify();
  for (const input of rendererInputs) assert.equal(sha(path.join(source, input.path)), input.sha256, `renderer input stable ${input.path}`);
  stable = true;
} catch (failure) {
  checks.push({ name: 'harness', passed: false, error: String(failure.stack) });
  if (failure.stdout) writeFileSync(path.join(tmp, 'failure-stdout.txt'), String(failure.stdout));
  if (failure.stderr) writeFileSync(path.join(tmp, 'failure-stderr.txt'), String(failure.stderr));
} finally {
  if (app) { if (!requests.length) requests.push(...await app.evaluate(() => global.testRequests).catch(() => [])); await app.close(); }
  if (backend) { await backend.close(); backendClosed = true; }
  const launched = starts();
  processStopped = launched.every(({ pid }) => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
  const passed = checks.length === 4 && checks.every(check => check.passed) && !errors.length && stable && backendClosed && processStopped && modelCalls === 0 && !existsSync(path.join(fixture, 'calls.jsonl'));
  writeFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), passed, source, manifestPath, manifestSha, inputs, rendererInputs, inputsStable: stable, checks, errors, requests, modelCalls, mcpCalls: existsSync(path.join(fixture, 'calls.jsonl')) ? readFileSync(path.join(fixture, 'calls.jsonl'), 'utf8').trim().split('\n').length : 0, processStarts: launched, backendClosed, processStopped, tempRoot: tmp,
    boundary: 'Hidden Electron component harness with actual production React/Bridge/Backend and synthetic local stdio MCP. No packaged EXE, paid model or public network. No real MCP tool invocation; this validates settings approval, catalog and capability persistence.' }, null, 2));
  console.log(reportPath); process.exitCode = passed ? 0 : 1;
}
