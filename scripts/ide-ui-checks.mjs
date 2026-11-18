import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Drive the real NPN webview and native editor; no synthetic backend tool results or approvals. */
export async function verifyAgentWorkbench(page, workspace, evidence) {
  const checks = [], screenshots = [];
  const save = () => writeFileSync(path.join(evidence, 'agent-ui-results.json'), JSON.stringify({ checks, screenshots, kind: 'actual Code - OSS webview and native editor interactions' }, null, 2));
  async function until(read, ready, label, timeout = 40000) {
    const deadline = Date.now() + timeout;
    do { const value = await read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 120)); } while (Date.now() < deadline);
    throw new Error('Agent UI timeout: ' + label);
  }
  async function findAgent() {
    return until(async () => {
      for (const frame of page.frames()) {
        try { if (await frame.locator('[data-testid="agent-input"]').count()) return frame; } catch { /* Ignore a detached loading frame. */ }
      }
      return undefined;
    }, Boolean, 'NPN Agent webview', 60000);
  }
  const agent = await findAgent();
  const ui = id => agent.locator(`[data-testid="${id}"]`);
  const capture = async name => { const file = path.join(evidence, name + '.png'); await page.screenshot({ path: file }); screenshots.push(file); save(); };
  const check = async (name, action) => { console.log('AGENT_UI_CHECK ' + name); try { await action(); checks.push({ name, passed: true }); } catch (error) { checks.push({ name, passed: false, error: String(error) }); throw error; } finally { save(); } };
  async function quickOpen(filename) {
    await page.keyboard.press('Control+p'); const picker = page.locator('.quick-input-widget input').first(); await picker.waitFor(); await picker.fill(filename);
    await until(() => page.locator('.quick-input-widget .label-name').allTextContents(), names => names.some(name => name === filename), 'native quick-open result');
    await page.locator('.quick-input-widget .label-name').filter({ hasText: filename }).first().click();
    await until(() => page.locator('.view-lines').allTextContents(), values => values.join('\n').replace(/ /g, ' ').includes(filename === 'main.ts' ? 'const total' : 'BASELINE_NATIVE_FILE'), 'native editor file');
  }
  async function palette(command) {
    await page.keyboard.press('Control+Shift+p'); const picker = page.locator('.quick-input-widget input').first(); await picker.waitFor(); await picker.fill('>' + command); await page.keyboard.press('Enter');
  }
  await check('NPN product identity, custom welcome, connected Agent and warm theme', async () => {
    assert.match(await page.title(), /NPN/);
    await until(() => ui('agent-connection').innerText(), text => text.includes('已连接'), 'shared backend connection');
    assert.equal((await agent.locator('.brand strong').innerText()), 'NPN Gamma');
    await capture('npn-welcome-initial');
    const assets = await Promise.all(page.frames().map(async frame => {
      try { return await frame.evaluate(() => ({ url: location.href, classes: document.body?.className, theme: document.body?.dataset.vscodeThemeName,
        links: [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => ({ href: link.href, loaded: Boolean(link.sheet) })),
        images: [...document.images].map(image => ({ src: image.src, width: image.naturalWidth })) })); }
      catch (error) { return { error: String(error) }; }
    }));
    writeFileSync(path.join(evidence, 'theme-resource-diagnostics.json'), JSON.stringify(assets, null, 2));
    const color = await until(() => agent.evaluate(() => getComputedStyle(document.body).backgroundColor), color => color === 'rgb(250, 248, 242)', 'registered NPN Warm theme', 15000);
    assert.equal(color, 'rgb(250, 248, 242)');
    await capture('npn-welcome-agent-warm');
  });
  await check('native selection joins a real Chat request instead of a separate demo conversation', async () => {
    await quickOpen('main.ts'); await page.keyboard.press('Control+a');
    await until(() => ui('agent-context').innerText(), text => text.includes('选中'), 'native selection context');
    await ui('agent-add-selection').click();
    const attached = await until(() => ui('agent-input').inputValue(), text => text.includes('main.ts:1'), 'attached source');
    assert.ok(attached.includes('const total'));
    await ui('agent-input').fill(attached + '\n\n请回应 IDE_DEEP_CHAT_MARKER。'); await ui('agent-send').click();
    await until(() => ui('agent-conversation').innerText(), text => text.includes('Mock response:') && text.includes('IDE_DEEP_CHAT_MARKER'), 'actual model response');
    await until(() => ui('agent-metrics').innerText(), text => text.includes('1 模型步') && text.includes('tokens'), 'real Chat usage');
    await capture('npn-chat-code-context');
  });
  await check('Work saves a real goal and renders the exact pending write approval', async () => {
    await ui('agent-mode-work').click();
    await until(() => ui('agent-send').innerText(), text => text.includes('创建目标'), 'Work composer');
    await agent.locator('.goal-options summary').click();
    await agent.getByRole('textbox', { name: '验收条件', exact: true }).fill('file:ide-ui-approved.txt');
    await ui('agent-input').fill('Write ide-ui-approved.txt for IDE_DEEP_WORK_MARKER'); await ui('agent-send').click();
    await ui('agent-tool-approve').first().waitFor({ timeout: 40000 });
    assert.equal(readFileSync(path.join(workspace, 'ide-ui-approved.txt'), 'utf8'), 'BASELINE_NATIVE_FILE\n');
    assert.match(await ui('agent-status').innerText(), /批准/);
    await capture('npn-work-exact-approval');
  });
  await check('file proposal opens the native Diff beside the NPN approval panel', async () => {
    await ui('agent-tool-diff').first().click();
    await page.locator('.monaco-diff-editor').first().waitFor({ timeout: 15000 });
    await capture('npn-native-diff-approval');
  });
  await check('unsaved native document blocks approval and preserves the human buffer', async () => {
    await quickOpen('ide-ui-approved.txt'); await page.keyboard.press('Control+End'); await page.keyboard.insertText('LOCAL_UNSAVED_MARKER');
    await until(() => ui('agent-context').innerText(), text => text.includes('未保存'), 'dirty context state');
    await ui('agent-tool-approve').first().click();
    await until(() => ui('agent-error').innerText(), text => text.includes('未保存'), 'dirty approval refusal');
    assert.equal(readFileSync(path.join(workspace, 'ide-ui-approved.txt'), 'utf8'), 'BASELINE_NATIVE_FILE\n');
    await capture('npn-dirty-document-blocked');
    await page.locator('.view-lines').filter({ hasText: 'BASELINE_NATIVE_FILE' }).first().click();
    await palette('File: Revert File');
    await until(() => ui('agent-context').innerText(), text => !text.includes('未保存'), 'native revert');
  });
  await check('digest-bound card confirmation dispatches once and independent backend verification completes Work', async () => {
    await ui('agent-tool-approve').first().click();
    await until(async () => readFileSync(path.join(workspace, 'ide-ui-approved.txt'), 'utf8'), text => text.includes('NPN-Gamma mock output'), 'approved physical write');
    await until(() => ui('agent-status').innerText(), text => text.includes('已验证完成'), 'verified Work completion');
    await capture('npn-work-verified');
  });
  await check('Inspector opens the retained actual request rather than a reconstructed UI mock', async () => {
    await ui('agent-inspect-request').click();
    await until(() => page.locator('.tabs-container .tab.active .label-name').allTextContents(), values => values.some(value => value === 'inspection.json'), 'actual request inspection tab');
    await capture('npn-real-request-inspector');
  });
  await check('NPN dark theme applies to both native workbench and Agent UI', async () => {
    await ui('agent-theme').click();
    await until(() => agent.evaluate(() => getComputedStyle(document.body).backgroundColor), color => color === 'rgb(32, 33, 35)', 'Agent dark theme');
    const native = await page.locator('.monaco-workbench').evaluate(element => getComputedStyle(element).getPropertyValue('--vscode-editor-background').trim());
    assert.equal(native.toLowerCase(), '#1b1c1e');
    await capture('npn-workbench-dark');
    await ui('agent-theme').click();
    await until(() => agent.evaluate(() => getComputedStyle(document.body).backgroundColor), color => color === 'rgb(250, 248, 242)', 'Agent warm theme restored');
  });
  save(); return { checks: checks.length, passed: checks.every(check => check.passed) };
}
