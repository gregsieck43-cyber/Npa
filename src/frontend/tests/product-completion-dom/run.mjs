import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '../../../..');
const tmp = path.resolve(root, process.env.NPN_UI_TMP_ROOT ?? '.tmp/product-completion-ui');
if (!tmp.startsWith(path.join(root, '.tmp') + path.sep)) throw new Error('Test temporary root must stay inside project .tmp');
const evidence = path.join(root, 'evidence/backend-20261026/product-completion-ui-20261030');
const dirs = Object.fromEntries(['build', 'tmp', 'home', 'appdata', 'localappdata', 'cache', 'userdata'].map(key => [key, path.join(tmp, key)]));
for (const dir of [...Object.values(dirs), evidence]) mkdirSync(dir, { recursive: true });
await build({ absWorkingDir: root, entryPoints: [path.join(import.meta.dirname, 'entry.tsx')], outdir: dirs.build, entryNames: 'bundle', bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', define: { __NPN_GATEWAY__: '"bridge"', 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });
writeFileSync(path.join(dirs.build, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><div id="root" class="panel"></div><script src="bundle.js"></script>');
const env = { ...process.env, TEMP: dirs.tmp, TMP: dirs.tmp, HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: dirs.appdata, LOCALAPPDATA: dirs.localappdata, NODE_COMPILE_CACHE: dirs.cache, NPN_UI_TEST_ROOT: dirs.userdata, NPN_UI_TEST_PAGE: path.join(dirs.build, 'index.html') };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
let app, page;
const checks = [], errors = [];
const startedAt = new Date().toISOString();
const caseFilter = process.env.NPN_UI_CASE_FILTER;
const check = async (name, work) => { if (caseFilter && !name.includes(caseFilter)) return; try { await work(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); } catch (error) { checks.push({ name, passed: false, error: String(error.stack ?? error) }); console.log(`FAIL ${name}: ${error.message}`); } };
const render = async kind => { const index = await page.evaluate(value => window.__render(value), kind); await page.locator(`[data-render="${index}"]`).waitFor({ state: 'attached' }); };
const calls = name => page.evaluate(name => window.__probe.calls.filter(call => call.name === name), name);
const click = name => page.getByRole('button', { name, exact: true }).click();
try {
  app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(import.meta.dirname, 'app.cjs')], cwd: dirs.build, env });
  page = await app.firstWindow(); page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(String(error)));
  await page.waitForFunction(() => typeof window.__render === 'function');
  await check('structured roles/order/parameters preserve unknown extras and sync Raw Body', async () => {
    await render('request'); await page.getByRole('tab', { name: '结构化', exact: true }).click();
    await page.getByLabel('model', { exact: true }).fill('edited-model');
    await page.getByLabel('消息 1 角色', { exact: true }).selectOption('developer');
    await page.getByLabel('消息 1 内容', { exact: true }).fill('Edited policy');
    await click('下移消息 1');
    await page.getByLabel('temperature', { exact: true }).fill('0.7');
    await page.getByLabel('max_tokens', { exact: true }).fill('250');
    await page.getByLabel('tools JSON', { exact: true }).fill('[{"type":"function","function":{"name":"lookup"}}]');
    await page.getByLabel('tool_choice JSON', { exact: true }).fill('"auto"');
    await page.getByLabel('context JSON', { exact: true }).fill('{"selected":["other"]}');
    await page.getByRole('tab', { name: /Raw Body/ }).click();
    const text = await page.locator('.cm-content').innerText();
    const body = JSON.parse(text); assert.equal(body.model, 'edited-model'); assert.equal(body.messages[1].role, 'developer'); assert.equal(body.messages[1].content, 'Edited policy'); assert.deepEqual(body.messages[1].cache_control, { type: 'ephemeral' }); assert.deepEqual(body.vendor_extra, { keep: true }); assert.equal(body.temperature, 0.7); assert.equal(body.max_tokens, 250); assert.equal(body.tools[0].function.name, 'lookup'); assert.equal(body.tool_choice, 'auto'); assert.deepEqual(body.context, { selected: ['other'] }); assert.equal((await calls('replay')).length, 0);
  });
  await check('malformed structured and Raw JSON stay visible and prevent sends', async () => {
    await render('request'); await page.getByRole('tab', { name: '结构化', exact: true }).click();
    await page.getByLabel('tools JSON', { exact: true }).fill('[broken');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '有界测试发送' && button.disabled));
    assert.equal(await page.getByRole('button', { name: '有界测试发送', exact: true }).isDisabled(), true);
    assert.match(await page.locator('#root').innerText(), /无效 JSON/);
    await page.getByRole('tab', { name: '概览', exact: true }).click(); await page.getByRole('tab', { name: '结构化', exact: true }).click();
    assert.equal(await page.getByLabel('tools JSON', { exact: true }).inputValue(), '[broken');
    assert.equal(await page.getByRole('button', { name: '有界测试发送', exact: true }).isDisabled(), true);
    await click('还原'); assert.equal(await page.getByLabel('tools JSON', { exact: true }).inputValue(), '[]');
    assert.equal(await page.getByRole('button', { name: '有界测试发送', exact: true }).isDisabled(), false);
    await page.getByLabel('tools JSON', { exact: true }).fill('[]');
    await page.getByRole('tab', { name: /Raw Body/ }).click();
    await page.locator('.cm-content').fill('{bad');
    assert.equal(await page.getByRole('button', { name: '有界测试发送', exact: true }).isDisabled(), true);
    assert.equal((await calls('replay')).length, 0);
  });
  await check('file import validates first, keeps historical record intact, never sends', async () => {
    await render('request'); await page.getByRole('tab', { name: /Raw Body/ }).click();
    await page.locator('input[type=file]').setInputFiles({ name: 'input.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ model: 'imported', messages: [{ role: 'user', content: 'Imported' }], custom: 7 })) });
    await page.waitForFunction(() => window.__probe.calls.some(call => call.name === 'validateRequest'));
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('imported'));
    assert.equal((await calls('replay')).length, 0);
    await click('还原'); assert.match(await page.locator('.cm-content').innerText(), /original-model/);
    await page.locator('input[type=file]').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{oops') });
    await page.getByRole('alert').waitFor(); assert.equal((await calls('validateRequest')).length, 1);
  });
  await check('explicit bounded send alone invokes replay, preserving extras', async () => {
    await render('request'); await page.getByRole('tab', { name: '结构化', exact: true }).click();
    await page.getByLabel('model', { exact: true }).fill('explicit-send'); await click('有界测试发送');
    await page.waitForFunction(() => window.__probe.calls.some(call => call.name === 'replay'));
    const sent = (await calls('replay'))[0]; assert.equal(sent.args[2], 'send'); assert.deepEqual(sent.args[1].vendor_extra, { keep: true }); assert.equal((await calls('validateRequest')).length, 1); assert.equal((await calls('validateRequest'))[0].args[2], 'r1');
  });
  await check('late import cannot overwrite another selected request draft', async () => {
    await render('request'); await page.getByRole('tab', { name: /Raw Body/ }).click();
    await page.evaluate(() => { window.__probe.delay = 'validateRequest'; });
    await page.locator('input[type=file]').setInputFiles({ name: 'slow.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ model: 'late-import', messages: [{ role: 'user', content: 'Late' }] })) });
    await page.waitForFunction(() => typeof window.__probe.resume === 'function');
    assert.equal(await page.locator('.req-item').nth(1).isDisabled(), true);
    await page.evaluate(() => window.__focusRequest('r2'));
    await page.waitForFunction(() => document.querySelector('.req-item.is-active')?.textContent?.includes('r2'));
    await page.evaluate(() => window.__probe.resume()); await page.getByRole('tab', { name: /Raw Body/ }).click();
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('sibling-model'));
    assert.doesNotMatch(await page.locator('.cm-content').innerText(), /late-import/); assert.equal((await calls('replay')).length, 0);
  });
  await check('request export validates before download; rejected secret import never replaces draft', async () => {
    await render('request'); await page.getByRole('tab', { name: /Raw Body/ }).click(); await click('导出');
    await page.waitForFunction(() => window.__probe.downloads.length === 1); assert.equal((await calls('validateRequest'))[0].args[2], 'r1');
    await page.locator('input[type=file]').setInputFiles({ name: 'secret.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ model: 'forbidden-secret', messages: [] })) });
    await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').innerText(), /Secret rejected/);
    assert.match(await page.locator('.cm-content').innerText(), /original-model/); assert.equal((await calls('replay')).length, 0);
  });
  await check('request preset preview/version/load changes only draft; save carries scope/version', async () => {
    await render('request'); await page.getByRole('tab', { name: /Raw Body/ }).click(); await click('请求预设');
    const projectOption = page.locator('select[aria-label="预设作用域"] option[value="project"]');
    assert.equal(await projectOption.evaluate(option => option.disabled), true);
    assert.equal(await projectOption.getAttribute('disabled'), '');
    await page.getByLabel('已保存预设', { exact: true }).selectOption('preset-r');
    await page.getByLabel('预设版本', { exact: true }).selectOption('1');
    assert.match(await page.getByLabel('预设预览').innerText(), /old-preset/);
    await click('当前草稿保存为新版本');
    await page.waitForFunction(() => window.__probe.calls.some(call => call.name === 'savePreset'));
    const input = (await calls('savePreset'))[0].args[0]; assert.equal(input.scope, 'session'); assert.equal(input.expectedVersion, 1); assert.equal(input.sourceRequestId, 'r1'); assert.equal(input.value.model, 'original-model');
    await page.getByLabel('已保存预设', { exact: true }).selectOption('preset-r'); await click('加载到草稿');
    await page.getByLabel('model', { exact: true }).waitFor(); assert.equal(await page.getByLabel('model', { exact: true }).inputValue(), 'preset-model'); assert.equal((await calls('replay')).length, 0);
  });
  await check('persisted request comparison supports arbitrary selections across separate pages', async () => {
    await render('request'); await page.getByRole('tab', { name: '对比', exact: true }).click();
    await page.getByLabel('比较基准版本', { exact: true }).selectOption('r2');
    await page.getByRole('button', { name: '更早版本', exact: true }).nth(1).click();
    await page.getByLabel('比较目标版本', { exact: true }).selectOption('r0');
    const text = await page.locator('.file-diff').innerText(); assert.match(text, /second-version/); assert.match(text, /older-version/); assert.equal((await calls('replay')).length, 0);
  });
  await check('prompt stored versions compare and preset preview never applies until explicit action', async () => {
    await render('prompt'); await page.getByRole('tab', { name: '历史版本', exact: true }).click();
    await page.getByLabel('比较基准版本', { exact: true }).selectOption('1'); await page.getByLabel('比较目标版本', { exact: true }).selectOption('2');
    assert.match(await page.locator('.file-diff').innerText(), /System version 1/); assert.match(await page.locator('.file-diff').innerText(), /System version 2/);
    await click('提示词预设与覆盖'); await click('提示词预设库'); await page.getByLabel('已保存预设', { exact: true }).selectOption('preset-p'); await click('加载到草稿');
    assert.equal(await page.getByLabel('systemPrompt', { exact: true }).inputValue(), 'Preset system'); assert.equal((await calls('savePrompt')).length, 0);
    await page.getByLabel('应用作用域', { exact: true }).selectOption('session'); await click('应用提示词草稿');
    await page.waitForFunction(() => window.__probe.calls.filter(call => call.name === 'savePrompt').length === 3);
    assert.deepEqual((await calls('savePrompt')).map(call => call.args[3]), ['session', 'session', 'session']); assert.equal((await calls('replay')).length, 0);
  });
  await check('session capabilities, unsupported MCP and parameter overrides use truthful responses', async () => {
    await render('session'); await page.getByRole('switch', { name: 'MCP', exact: true }).waitFor();
    assert.equal(await page.getByRole('switch', { name: 'MCP', exact: true }).isDisabled(), true);
    assert.match(await page.locator('.modal').innerText(), /Chat 只读模式不支持 MCP/);
    await page.getByRole('switch', { name: 'Skills', exact: true }).click(); await page.getByRole('switch', { name: '联网搜索', exact: true }).click();
    await page.getByLabel('会话参数覆盖 JSON', { exact: true }).fill('{bad'); assert.equal(await page.getByRole('button', { name: '保存会话设置', exact: true }).isDisabled(), true); assert.equal((await calls('saveSessionSettings')).length, 0);
    await page.getByLabel('会话参数覆盖 JSON', { exact: true }).fill('{"temperature":0.2,"max_tokens":50}');
    await click('保存会话设置'); await page.getByRole('status').waitFor();
    const input = (await calls('saveSessionSettings'))[0].args[1]; assert.equal(input.capabilities.skills, true); assert.equal(input.capabilities.web, false); assert.equal(input.capabilities.mcp, false); assert.deepEqual(input.parameters, { temperature: 0.2, max_tokens: 50 });
    await page.evaluate(() => { window.__probe.fail = 'saveSessionSettings'; }); await click('保存会话设置'); await page.getByRole('alert').waitFor(); assert.equal(await page.getByRole('status').count(), 0);
  });
  await check('nested prompt preset Escape preserves unsaved parent draft', async () => {
    await render('prompt'); await click('提示词预设与覆盖');
    await page.getByLabel('systemPrompt', { exact: true }).fill('Unsaved parent draft');
    await click('提示词预设库'); await page.getByLabel('已保存预设', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1);
    await page.keyboard.press('Escape');
    await page.getByLabel('systemPrompt', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('systemPrompt', { exact: true }).inputValue(), 'Unsaved parent draft');
    assert.equal(await page.getByRole('dialog').count(), 1); assert.equal((await calls('savePrompt')).length, 0);
  });
  await check('unsupported Developer Prompt is blocked before any prompt persistence', async () => {
    await page.evaluate(() => { window.__probe.supportsDeveloper = false; });
    await render('prompt'); await click('提示词预设与覆盖');
    await page.getByLabel('developerPrompt', { exact: true }).fill('must not persist');
    await page.waitForFunction(() => document.querySelector('.error-banner')?.textContent?.includes('不支持 Developer'));
    assert.equal(await page.getByRole('button', { name: '应用提示词草稿', exact: true }).isDisabled(), true); assert.equal((await calls('savePrompt')).length, 0);
    await page.evaluate(() => { window.__probe.supportsDeveloper = true; });
  });
  await check('Work developer draft uses authoritative prompt API without Chat-only capability query', async () => {
    await page.evaluate(() => window.__sessionMode('cowork'));
    await render('prompt'); await click('提示词预设与覆盖');
    await page.getByLabel('developerPrompt', { exact: true }).fill('Supported Work developer');
    assert.equal((await calls('sessionSettings')).length, 0);
    assert.equal(await page.getByRole('button', { name: '应用提示词草稿', exact: true }).isDisabled(), false);
    await click('应用提示词草稿'); await page.waitForFunction(() => window.__probe.calls.filter(call => call.name === 'savePrompt').length === 3);
    assert.equal((await calls('savePrompt'))[1].args[2], 'Supported Work developer');
    await page.evaluate(() => window.__sessionMode('chat'));
  });
  await check('conversation exports advance bounded pages with fixed snapshot only on user action', async () => {
    await render('session'); await click('导出第 1 页');
    await page.waitForFunction(() => window.__probe.downloads.length === 1); assert.equal((await calls('exportConversation')).length, 1);
    await click('继续导出第 2 页'); await page.waitForFunction(() => window.__probe.downloads.length === 2);
    const exported = await page.evaluate(() => window.__probe.downloads); assert.equal(exported[0].snapshot, exported[1].snapshot); assert.equal(exported[0].part, 1); assert.equal(exported[1].part, 2); assert.equal(exported[0].messages.length, 1); assert.equal(exported[1].requests.length, 1);
    assert.equal((await calls('exportConversation'))[1].args[1].cursor, 'export-2'); assert.equal((await calls('replay')).length, 0);
  });
  await check('Composer menu exposes advanced settings on an existing session', async () => {
    await render('composer'); await page.getByRole('button', { name: '添加附件', exact: true }).click();
    await page.getByRole('menuitem', { name: '会话高级设置与导出', exact: true }).click(); await page.getByRole('switch', { name: 'MCP', exact: true }).waitFor();
    assert.equal((await calls('sessionSettings')).length, 1);
  });
  // Hidden Electron does not guarantee compositor frames; behavior assertions above are authoritative.
} catch (error) { checks.push({ name: 'harness', passed: false, error: String(error.stack ?? error) }); }
finally {
  if (app) await app.close().catch(() => {});
  const files = ['features/inspector/RequestPanel.tsx', 'features/inspector/PromptPanel.tsx', 'features/inspector/StructuredRequestEditor.tsx', 'features/inspector/PresetDialog.tsx', 'features/inspector/SavedVersionCompare.tsx', 'features/inspector/PromptPresetEditor.tsx', 'features/inspector/request-draft.ts', 'features/session/SessionOptions.tsx', 'features/session/Composer.tsx'];
  const sourceHashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, 'src/frontend', file))).digest('hex')]));
  const reportName = process.env.NPN_UI_REPORT_NAME ?? 'dom-results.json';
  if (path.basename(reportName) !== reportName) throw new Error('Report name must be a filename');
  writeFileSync(path.join(evidence, reportName), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), caseFilter, mode: 'real React components in isolated hidden Electron; gateway fixtures; no product EXE/backend/provider calls', checks, errors, sourceHashes }, null, 2));
  console.log(`${checks.filter(value => value.passed).length}/${checks.length} passed; ${errors.length} page errors`);
  process.exitCode = checks.some(value => !value.passed) || errors.length ? 1 : 0;
}
