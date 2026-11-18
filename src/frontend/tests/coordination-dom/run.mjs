import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { _electron } from 'playwright';
const root = path.resolve(import.meta.dirname, '../../../..'), label = process.argv[2] ?? new Date().toISOString().replaceAll(':', '-');
assert.match(label, /^[\w.-]+$/);
const work = path.join(root, '.tmp/continuation-20261117-u23', `coord-${label}`), evidence = path.join(root, 'evidence/continuation-20261117/coordination-ui', label);
assert.equal(fs.existsSync(evidence), false); fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
for (const key of ['TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = work;
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex'), inputs = new Map(), checks = [], errors = []; let app, stable = false;
try {
  await build({ absWorkingDir: root, entryPoints: [path.join(import.meta.dirname, 'entry.tsx')], outdir: work, entryNames: 'bundle', bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { __NPN_GATEWAY__: '"bridge"', 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'fingerprints', setup(b) { b.onLoad({ filter: /\.(tsx?|css)$/ }, args => { inputs.set(args.path, sha(args.path)); return undefined; }); } }] });
  fs.writeFileSync(path.join(work, 'index.html'), '<!doctype html><html data-theme="light" data-accent="ember" data-motion="full"><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>#coord-fixture{height:100vh;width:min(100vw,600px);margin:auto;overflow:auto}#coord-fixture>.ptab{height:100%}#root[hidden],#extra[hidden]{display:none}</style><div id="root"></div><script src="bundle.js"></script></html>');
  const env = { ...process.env, NPN_LAYOUT_USER: path.join(work, 'profile'), NPN_LAYOUT_PAGE: path.join(work, 'index.html') }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'src/frontend/tests/narrow-layout-dom/app.cjs')], cwd: work, env });
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus(); });
  const page = await app.firstWindow(); page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(String(error))); await page.waitForFunction(() => Boolean(window.__coord));
  const check = async (name, fn) => { try { await fn(); checks.push({ name, passed: true }); console.log('PASS ' + name); } catch (error) { checks.push({ name, passed: false, error: String(error.stack) }); console.log('FAIL ' + name + ': ' + error.message); } };
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const setup = async () => { await page.evaluate(() => window.__coord.setup()); await page.locator('.coordination__peer').first().waitFor(); };
  const tab = name => page.getByRole('tab', { name, exact: true }).click();
  const calls = method => page.evaluate(method => window.__coord.calls().filter(call => call.method === method).map(call => call.value), method);
  await check('optional capability is honest; workspace hint uses real returned peers and does not block a composer', async () => {
    await page.evaluate(() => window.__coord.unavailable()); await page.getByText('当前连接未提供协作能力', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '发送协调消息', exact: true }).count(), 0);
    await page.evaluate(() => window.__coord.hint()); await page.getByRole('button', { name: '同工作区 40+ 个任务在场', exact: true }).waitFor();
    assert.equal(await page.locator('.modal').count(), 0);
  });
  await check('presence and inbox stay bounded; untrusted title/body are text and opening never acknowledges', async () => {
    await setup(); assert.equal(await page.locator('.coordination__peer').count(), 40); assert.equal(await page.locator('.coordination__notice').count(), 40);
    await page.getByText('<img src=x onerror=alert(1)>', { exact: true }).waitFor(); await tab('收件箱'); await page.getByText('<script>window.__untrusted = true</script>', { exact: true }).waitFor();
    assert.equal(await page.locator('.coordination img,.coordination script').count(), 0); assert.equal(await page.evaluate(() => window.__untrusted), undefined);
    assert.equal((await calls('ack')).length, 0); assert.ok((await calls('presence')).every(value => value.limit === 40));
    await tab('在场任务'); await page.getByRole('button', { name: '下一页任务', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.coordination__peer').length === 5);
    const reads = (await calls('presence')).length; await page.evaluate(() => window.__coord.change()); await frame(); assert.equal((await calls('presence')).length, reads);
    await page.getByText('在场状态有更新，当前分页保持不变。', { exact: true }).waitFor();
  });
  await check('inbox freezes through across later events and resumes only after explicit refresh', async () => {
    await setup(); await tab('收件箱'); await page.getByRole('button', { name: '下一页通知', exact: true }).click(); await page.getByText('协调正文 41', { exact: true }).waitFor();
    const before = await page.locator('.coordination__notice').allTextContents(), reads = (await calls('inbox')).length;
    await page.evaluate(() => window.__coord.change()); await frame(); assert.deepEqual(await page.locator('.coordination__notice').allTextContents(), before); assert.equal((await calls('inbox')).length, reads);
    await page.getByRole('button', { name: '下一页通知', exact: true }).click(); await page.getByText('协调正文 85', { exact: true }).waitFor(); assert.equal(await page.locator('.coordination__notice').count(), 5);
    const latestQuery = (await calls('inbox')).at(-1); assert.equal(latestQuery.after, 80); assert.equal(latestQuery.through, 85);
    await page.getByRole('button', { name: '刷新快照', exact: true }).click(); await page.locator('.coordination__notice').first().getByText('Agent 已确认 · 我未读', { exact: true }).waitFor(); assert.equal((await calls('inbox')).at(-1).through, undefined);
  });
  await check('operator acknowledgement is explicit, independent of agent acknowledgement, and failure remains unread', async () => {
    await setup(); await tab('收件箱'); await page.evaluate(() => window.__coord.ackFailure(true));
    await page.locator('.coordination__notice').first().getByRole('button', { name: '标记我已读', exact: true }).click(); await page.getByText('已读保存失败', { exact: true }).waitFor();
    await page.locator('.coordination__notice').first().getByText('Agent 已确认 · 我未读', { exact: true }).waitFor();
    await page.evaluate(() => window.__coord.ackFailure(false)); await page.locator('.coordination__notice').first().getByRole('button', { name: '标记我已读', exact: true }).click();
    await page.locator('.coordination__notice').first().getByText('Agent 已确认 · 我已读', { exact: true }).waitFor(); assert.deepEqual((await calls('ack')).at(-1), { sessionId: 'work-a', noticeIds: ['notice-1'] });
  });
  await check('retry preserves client id, altered content gets new id, successful late result preserves a newer draft', async () => {
    await setup(); await tab('发消息'); await page.getByLabel('接收任务', { exact: true }).fill('peer-1'); await page.getByLabel('协调消息正文', { exact: true }).fill('参考证据');
    await page.evaluate(() => window.__coord.sending(true)); await page.getByRole('button', { name: '发送协调消息', exact: true }).click(); await page.getByText('暂未取得发送回执', { exact: true }).waitFor();
    assert.equal(await page.getByText('后端已接收', { exact: false }).count(), 0);
    await page.getByRole('button', { name: '重试发送', exact: true }).click(); await frame(); let sent = await calls('send'); assert.equal(sent[0].clientMessageId, sent[1].clientMessageId);
    await page.getByLabel('协调消息正文', { exact: true }).fill('新的参考正文'); await page.evaluate(() => window.__coord.sending(false, true)); await page.getByRole('button', { name: '重试发送', exact: true }).click();
    await page.getByRole('button', { name: '发送中…', exact: true }).waitFor(); await page.getByLabel('协调消息正文', { exact: true }).fill('后来编辑的草稿'); await page.evaluate(() => window.__coord.finish());
    await page.getByText('后端已接收', { exact: false }).waitFor(); assert.equal(await page.getByLabel('协调消息正文', { exact: true }).inputValue(), '后来编辑的草稿');
    sent = await calls('send'); assert.notEqual(sent[1].clientMessageId, sent[2].clientMessageId); assert.deepEqual(Object.keys(sent[2]).sort(), ['body', 'clientMessageId', 'kind', 'sessionId', 'to']);
  });
  await check('file claims are bounded, releases target only this task, and read-only sessions cannot claim', async () => {
    await setup(); await tab('文件认领'); assert.equal(await page.locator('.coordination__claim').count(), 40); assert.equal(await page.getByRole('button', { name: '释放本任务认领', exact: true }).count(), 1);
    await page.getByRole('button', { name: '释放本任务认领', exact: true }).click(); await page.getByText('后端已释放本任务认领', { exact: true }).waitFor();
    assert.deepEqual((await calls('release')).at(-1), { sessionId: 'work-a', ids: ['claim-0'] });
    await page.getByLabel('准备编辑的路径', { exact: true }).fill('src/new.ts\nsrc/new.ts\nsrc/second.ts'); await page.getByRole('button', { name: '认领这些文件', exact: true }).click();
    await page.getByText('后端已登记本任务认领', { exact: true }).waitFor(); assert.deepEqual((await calls('claim')).at(-1), { sessionId: 'work-a', paths: ['src/new.ts', 'src/second.ts'] });
    await page.getByRole('button', { name: '下一页认领', exact: true }).click(); await page.getByText('src/new.ts', { exact: true }).waitFor();
    const count = (await calls('claims')).length; await page.evaluate(() => window.__coord.change()); await frame(); assert.equal((await calls('claims')).length, count);
    await page.evaluate(() => window.__coord.readOnly()); await frame(); assert.equal(await page.getByRole('button', { name: '认领这些文件', exact: true }).count(), 0); assert.equal(await page.getByRole('button', { name: '释放本任务认领', exact: true }).count(), 0);
  });
  await check('conflict approval sends displayed digest and fingerprint only once; no session grant and no silent retry', async () => {
    await page.evaluate(() => window.__coord.approval()); await page.getByText('src/shared.ts', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: '本会话始终允许', exact: true }).count(), 0);
    await page.getByRole('button', { name: '批准一次', exact: true }).evaluate(el => { el.click(); el.click(); }); await frame();
    const sent = await calls('approval'); assert.equal(sent.length, 1); assert.deepEqual(sent[0].decision, { approved: true, scope: 'once', expectedIntentDigest: 'displayed-intent-sha', expectedConflictFingerprint: 'displayed-conflict-sha' });
    assert.equal(await page.getByRole('button', { name: '批准一次', exact: true }).isEnabled(), true); assert.equal(await page.getByText('src/shared.ts', { exact: true }).count(), 1);
    await page.screenshot({ path: path.join(evidence, 'conflict-approval.png') });
  });
  await check('external participants remain text-only advisory without internal send or release controls', async () => {
    await page.evaluate(() => window.__coord.external());
    const section = page.getByRole('region', { name: '外部参与者' });
    await section.getByText('<script>external writer</script>', { exact: true }).waitFor();
    assert.equal(await section.locator('script').count(), 0);
    assert.equal(await section.getByRole('button').count(), 0);
    await section.getByText(/已忽略 2 个无效声明/).waitFor();
    await page.screenshot({ path: path.join(evidence, 'external-presence.png') });
  });
  for (const [file, expected] of inputs) assert.equal(sha(file), expected, 'Input changed: ' + file); stable = true;
} catch (error) { checks.push({ name: 'harness', passed: false, error: String(error.stack) }); }
finally {
  if (app) await app.close(); const passed = checks.length === 8 && checks.every(item => item.passed) && !errors.length && stable;
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed, checks, errors, stable, inputs: Object.fromEntries(inputs), work }, null, 2)); console.log(JSON.stringify({ passed, checks: checks.length, errors, evidence })); process.exitCode = passed ? 0 : 1;
}
