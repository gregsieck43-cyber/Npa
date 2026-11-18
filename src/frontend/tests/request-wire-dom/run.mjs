import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { _electron } from 'playwright';

const [backendEntry, expectedBackendSha, label] = process.argv.slice(2);
assert.ok(backendEntry && /^[a-f0-9]{64}$/.test(expectedBackendSha ?? '') && /^[a-z0-9-]+$/.test(label ?? ''), 'Explicit backend entry, SHA and evidence label required');
const root = path.resolve(import.meta.dirname, '../../../..');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
assert.equal(sha(backendEntry), expectedBackendSha);
const tmpRoot = path.join(root, '.tmp/request-wire-ui-20261104'); mkdirSync(tmpRoot, { recursive: true });
const tmp = mkdtempSync(path.join(tmpRoot, 'dom-'));
for (const name of ['build', 'tmp', 'home', 'appdata', 'localappdata', 'user', 'fixture']) mkdirSync(path.join(tmp, name));
for (const [key, dir] of Object.entries({ TEMP: 'tmp', TMP: 'tmp', HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata' })) process.env[key] = path.join(tmp, dir);
const reportDir = path.join(root, 'evidence/backend-20261026/request-wire-ui-20261104'); mkdirSync(reportDir, { recursive: true });
const reportFile = path.join(reportDir, `${label}.json`); assert.equal(existsSync(reportFile), false);
const checks = [], errors = [], wireBodies = []; let app, page, backend, requests = [], inputs = [], expectedBody, replayBody;
const check = async (name, fn) => { try { await fn(); checks.push({ name, passed: true }); console.log('PASS ' + name); } catch (error) { checks.push({ name, passed: false, error: String(error.stack) }); console.log('FAIL ' + name + ': ' + error.message); } };
let stable = false, closed = false;
try {
  const result = await build({ absWorkingDir: root, entryPoints: [path.join(import.meta.dirname, 'entry.tsx')], outdir: path.join(tmp, 'build'), entryNames: 'bundle', bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', metafile: true, define: { __NPN_GATEWAY__: '"bridge"', 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });
  inputs = Object.keys(result.metafile.inputs).filter(file => !file.replaceAll('\\', '/').includes('node_modules/')).map(file => ({ path: file, sha256: sha(path.resolve(root, file)) }));
  writeFileSync(path.join(tmp, 'build/index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}</style><div id="root"></div><script src="bundle.js"></script>');
  const { startBackend } = await import(pathToFileURL(path.resolve(backendEntry)).href);
  const fixture = path.join(tmp, 'fixture');
  backend = await startBackend({ projectRoot: fixture, productRoot: fixture, dataDir: path.join(fixture, 'data'), mockOptions: { trace: body => wireBodies.push(structuredClone(body)) } });
  assert.equal(backend.services.configuration.provider.mode, 'mock');
  assert.equal(new URL(backend.services.configuration.provider.baseUrl).hostname, '127.0.0.1');
  const h = backend.services.harness, session = h.store.createSession({ title: 'Request wire DOM fixture' });
  const original = { model: h.profiles.get('default').provider.model, messages: [{ role: 'system', content: 'Wire fixture system' }, { role: 'user', content: 'Wire fixture user', vendor_message: 'preserved' }], temperature: 0.2, max_tokens: 64, tools: [], tool_choice: 'none', context: { selected: ['fixture'] }, vendor_extra: { retained: true } };
  const record = h.store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'chat', status: 'completed', endpoint: 'mock', bodyHash: createHash('sha256').update(JSON.stringify(original)).digest('hex'), recordContent: true, body: original, sources: [], draft: '' });
  const env = { ...process.env, NPN_UI_TEST_ROOT: path.join(tmp, 'user'), NPN_UI_TEST_PAGE: path.join(tmp, 'build/index.html'), NPN_UI_BACKEND_PORT: String(backend.port), NPN_UI_BACKEND_TOKEN: backend.token }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(import.meta.dirname, '../mcp-completion-dom/app.cjs')], cwd: tmp, env });
  page = await app.firstWindow(); page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(String(error)));
  await page.waitForFunction(() => typeof window.__render === 'function');
  const render = async kind => { const id = await page.evaluate(([kind, id]) => window.__render(kind, id), [kind, session.id]); await page.locator(`[data-render="${id}"]`).waitFor({ state: 'attached' }); };
  await check('privacy UI explains retained local recovery data when detailed request capture is disabled', async () => {
    await render('privacy');
    await page.getByText('关闭后 Inspector 仅保留请求元数据与哈希，不保存详细 Body；用于任务恢复的 Kernel 消息、工具效果记录与检查点仍保存在本地数据目录。', { exact: true }).waitFor();
    assert.equal(wireBodies.length, 0);
  });
  await check('structured request edits require explicit send and match the actual local provider wire exactly', async () => {
    await render('request'); await page.locator('.req-item').waitFor();
    await page.getByRole('tab', { name: '结构化', exact: true }).click();
    await page.getByLabel('temperature', { exact: true }).fill('0.73');
    await page.getByLabel('max_tokens', { exact: true }).fill('96');
    await page.getByRole('button', { name: '下移消息 1', exact: true }).click();
    await page.getByRole('tab', { name: /Raw Body/ }).click();
    expectedBody = JSON.parse(await page.locator('.cm-content').innerText());
    assert.equal(expectedBody.temperature, 0.73); assert.equal(expectedBody.max_tokens, 96); assert.equal(expectedBody.messages[0].role, 'user');
    assert.equal(expectedBody.messages[0].vendor_message, 'preserved'); assert.deepEqual(expectedBody.vendor_extra, { retained: true });
    assert.equal(wireBodies.length, 0); assert.equal(h.store.listRequests({ sessionId: session.id }).requests.length, 1);
    assert.deepEqual(h.store.getRequest(record.id).body, original);
    await page.getByRole('button', { name: '有界测试发送', exact: true }).click();
    await page.locator('.response-text').waitFor();
    assert.deepEqual(wireBodies, [expectedBody]);
    const records = h.store.listRequests({ sessionId: session.id }).requests;
    assert.equal(records.length, 2); const replay = records.find(value => value.id !== record.id);
    assert.equal(replay.status, 'completed'); assert.equal(replay.kind, 'studio'); assert.equal(replay.parentId, record.id);
    replayBody = h.store.getRequest(replay.id).body; assert.deepEqual(replayBody, expectedBody); assert.deepEqual(h.store.getRequest(record.id).body, original);
    requests = await app.evaluate(() => global.testRequests);
    assert.equal(requests.filter(call => call.method === 'POST' && call.route === '/v1/product/inspector/replay').length, 1);
  });
  for (const input of inputs) assert.equal(sha(path.resolve(root, input.path)), input.sha256);
  assert.equal(sha(backendEntry), expectedBackendSha); stable = true;
} catch (error) { checks.push({ name: 'harness', passed: false, error: String(error.stack) }); }
finally {
  if (app) { if (!requests.length) requests = await app.evaluate(() => global.testRequests).catch(() => []); await app.close(); }
  if (backend) { await backend.close(); closed = true; }
  const passed = checks.length === 2 && checks.every(item => item.passed) && !errors.length && stable && closed;
  writeFileSync(reportFile, JSON.stringify({ at: new Date().toISOString(), passed, checks, errors, inputs, inputsStable: stable, backendEntry, backendSha: expectedBackendSha, requests, expectedBody, replayBody, wireBodies, modelCalls: wireBodies.length, paidCalls: 0, backendClosed: closed, tempRoot: tmp,
    boundary: 'Actual component DOM, Bridge, local backend and mock HTTP provider; one explicit model dispatch. No packaged product GUI/EXE or public service executed. Packaged library GUI extension remains authored/typechecked pending parent run.' }, null, 2));
  console.log(reportFile); process.exitCode = passed ? 0 : 1;
}
