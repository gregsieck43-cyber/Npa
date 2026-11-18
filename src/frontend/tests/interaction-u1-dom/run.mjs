import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { _electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '../../../..'), baseline = process.argv.includes('--baseline');
const label = baseline ? 'red' : 'green', work = path.join(root, '.tmp/continuation-20261117-u1', label);
const evidence = path.join(root, 'evidence/continuation-20261117/u1');
fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
for (const key of ['TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'NODE_COMPILE_CACHE', 'npm_config_cache']) process.env[key] = work;
const hash = value => createHash('sha256').update(value).digest('hex'), inputs = [];
const original = baseline ? execFileSync('git', ['show', 'HEAD:src/frontend/components/ui.tsx'], { cwd: root, encoding: 'utf8' }) : undefined;
const checks = [], pageErrors = []; let app, closed = false;
try {
  await build({ absWorkingDir: root, entryPoints: [path.join(import.meta.dirname, baseline ? 'baseline.tsx' : 'entry.tsx')], outdir: work, entryNames: 'bundle', bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { __NPN_GATEWAY__: '"bridge"', 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning', plugins: [{ name: 'record-inputs', setup(builder) {
    builder.onLoad({ filter: /\.(tsx?|css)$/ }, ({ path: file }) => {
      const contents = original !== undefined && file.replaceAll('\\', '/').endsWith('/src/frontend/components/ui.tsx') ? original : fs.readFileSync(file, 'utf8');
      inputs.push({ path: file, sha256: hash(contents), baseline: contents === original });
      return { contents, loader: file.endsWith('.css') ? 'css' : file.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: path.dirname(file) };
    });
  } }] });
  fs.writeFileSync(path.join(work, 'index.html'), '<!doctype html><html data-theme="light" data-motion="full"><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><div id="root"></div><script>window.npn={request:async()=>{throw new Error("Unexpected U1 gateway request")},desktop:async()=>{throw new Error("Unexpected U1 desktop request")}};window.__earlyErrors=[];window.addEventListener("error",e=>window.__earlyErrors.push(e.message));</script><script src="bundle.js"></script></html>');
  const env = { ...process.env, NPN_U1_USER: path.join(work, 'profile'), NPN_U1_PAGE: path.join(work, 'index.html') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(import.meta.dirname, 'app.cjs')], env, cwd: work });
  const page = await app.firstWindow(); page.on('pageerror', error => pageErrors.push(String(error))); page.setDefaultTimeout(5000);
  const check = async (name, action) => { try { await action(); checks.push({ name, passed: true }); console.log('PASS ' + name); } catch (error) { checks.push({ name, passed: false, error: String(error.stack) }); console.log('FAIL ' + name + ': ' + error.message); await page.screenshot({ path: path.join(evidence, label + '-failure-' + checks.length + '.png') }); } };
  await check('menu focuses its first item and arrows skip disabled rows', async () => {
    await page.getByRole('button', { name: '菜单', exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '第一项');
    await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement?.textContent), '最后一项');
    await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => document.activeElement?.textContent), '第一项');
    await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement?.textContent), '最后一项');
    await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => document.activeElement?.textContent), '菜单');
  });
  if (!baseline) {
    await check('popover retains disabled exit content and a rapid reopen cancels unmount', async () => {
      await page.evaluate(() => { window.__u1.menu(true); window.__u1.menu(false); });
      assert.equal(await page.locator('.popover').getAttribute('inert'), '');
      await page.evaluate(() => window.__u1.menu(true)); await page.waitForTimeout(150);
      assert.equal(await page.locator('.popover').count(), 1); assert.equal(await page.locator('.popover').getAttribute('inert'), null);
      await page.keyboard.press('Escape'); await page.locator('.popover').waitFor({ state: 'detached' });
    });
    await check('modal retains cleared content on exit, traps Tab and restores focus', async () => {
      await page.locator('#modal-trigger').click(); await page.getByRole('textbox', { name: '对话框输入' }).fill('修改的输入');
      await page.getByRole('button', { name: '确认', exact: true }).focus(); await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '关闭');
      await page.screenshot({ path: path.join(evidence, 'green-modal.png') });
      const exit = await page.evaluate(() => { window.__u1.modal(false); const element = document.querySelector('.modal-backdrop'); return { inert: element?.hasAttribute('inert'), text: element?.textContent }; });
      assert.equal(exit.inert, true); assert.match(exit.text, /保留标题/);
      await page.locator('.modal-backdrop').waitFor({ state: 'detached' }); assert.equal(await page.evaluate(() => document.activeElement?.id), 'modal-trigger');
    });
    await check('collapse reverses without losing mounted input, then unloads after close', async () => {
      await page.getByRole('textbox', { name: '折叠内容' }).fill('编辑内容');
      const exit = await page.evaluate(() => { window.__u1.collapse(false); return document.querySelector('#collapse-test .collapse')?.hasAttribute('inert'); }); assert.equal(exit, true);
      await page.evaluate(() => window.__u1.collapse(true)); await page.waitForTimeout(150);
      assert.equal(await page.getByRole('textbox', { name: '折叠内容' }).inputValue(), '编辑内容');
      await page.evaluate(() => window.__u1.collapse(false)); await page.locator('#collapse-test input').waitFor({ state: 'detached' });
    });
    await check('copy waits for clipboard, exposes rejection and copies the complete source on retry', async () => {
      await page.evaluate(() => window.__u1.copyMode('pending')); await page.getByRole('button', { name: '复制完整正文', exact: true }).click();
      assert.equal(await page.locator('.copy-control').getAttribute('data-copy-state'), 'pending'); assert.equal(await page.getByRole('button', { name: '正在复制' }).isDisabled(), true);
      await page.evaluate(() => window.__u1.reject()); await page.getByRole('button', { name: '复制失败，请重试' }).waitFor();
      await page.evaluate(() => window.__u1.copyMode('success')); await page.getByRole('button', { name: '复制失败，请重试' }).click(); await page.getByRole('button', { name: '已复制', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__u1.copied().length), await page.evaluate(() => window.__u1.sourceLength));
    });
    await check('toast progress pauses on hover and focus, manual close retains only inert exit', async () => {
      await page.evaluate(() => window.__u1.toast()); const toast = page.locator('.toast'); await toast.waitFor(); await toast.hover();
      const progress = () => toast.locator('.toast__timer').getAttribute('style'); const hovered = await progress(); await page.waitForTimeout(180); assert.equal(await progress(), hovered);
      await toast.getByRole('button', { name: '关闭' }).focus(); await page.mouse.move(10, 10); const focused = await progress(); await page.waitForTimeout(180); assert.equal(await progress(), focused);
      await page.screenshot({ path: path.join(evidence, 'green-toast-paused.png') });
      await page.evaluate(() => document.querySelector('.toast__close').click()); await toast.waitFor({ state: 'detached' }); assert.equal(await page.evaluate(() => window.__u1.toastCount()), 0);
    });
    await check('command palette keyboard selection stays in its container and restores launcher focus', async () => {
      await page.locator('#palette-trigger').click(); const input = page.getByRole('combobox', { name: '搜索命令' }); await input.waitFor();
      assert.equal(await input.evaluate(node => node === document.activeElement), true); await input.press('End');
      assert.equal(await page.evaluate(() => window.scrollY), 0); await input.press('Home'); assert.equal(await input.getAttribute('aria-activedescendant'), 'palette-option-0');
      await input.press('Escape'); await page.locator('.palette-backdrop').waitFor({ state: 'detached' }); assert.equal(await page.evaluate(() => document.activeElement?.id), 'palette-trigger');
    });
    await check('reduced motion shares zero duration and removes closed content immediately', async () => {
      await page.evaluate(() => { document.documentElement.dataset.motion = 'reduced'; window.__u1.collapse(true); });
      await page.waitForFunction(() => document.querySelector('.collapse')?.style.getPropertyValue('--presence-duration') === '0ms');
      assert.equal(await page.evaluate(() => { window.__u1.collapse(false); return document.querySelector('#collapse-test input') === null; }), true);
      await page.evaluate(() => { window.__u1.modal(true); });
      assert.equal(await page.evaluate(() => { window.__u1.modal(false); return document.querySelector('.modal-backdrop') === null; }), true);
    });
    await page.screenshot({ path: path.join(evidence, 'green-visible.png') });
  }
  pageErrors.push(...await page.evaluate(() => window.__earlyErrors));
} finally {
  if (app) { await app.close(); closed = true; }
  const passed = checks.length > 0 && checks.every(check => check.passed) && !pageErrors.length && closed;
  fs.writeFileSync(path.join(evidence, label + '-dom.json'), JSON.stringify({ passed, checks, pageErrors, closed, inputs, bundleSha256: fs.existsSync(path.join(work, 'bundle.js')) ? hash(fs.readFileSync(path.join(work, 'bundle.js'))) : null, work, boundary: 'Visible Electron renders real React components; clipboard completion/rejection is a controlled DOM fixture. Not packaged EXE acceptance.' }, null, 2));
  process.exitCode = passed ? 0 : 1;
}
