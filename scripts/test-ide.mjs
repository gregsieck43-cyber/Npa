import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertGeneratedPath } from './project-paths.mjs';
import { chromium } from 'playwright';
import { verifyAgentWorkbench } from './ide-ui-checks.mjs';
import { startBackend } from '../build/src/app/backend.js';
import { ideAssets, prepareIde } from '../build/src/ide/launcher.js';

const project = process.cwd(), version = JSON.parse(readFileSync('package.json', 'utf8')).version, root = mkdtempSync(path.resolve('.tmp', 'ide-native-'));
const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
mkdirSync(workspace); mkdirSync(dataDir);
const evidence = path.resolve(`build/ide-checks/ide-${version.split('.').slice(0, 2).join('.')}`, 'native-' + new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(evidence, { recursive: true });
writeFileSync(path.join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2020', module: 'commonjs' }, include: ['*.ts'] }));
writeFileSync(path.join(workspace, 'math.ts'), 'export function add(a:number,b:number){return a+b;}\n');
writeFileSync(path.join(workspace, 'main.ts'), "import { add } from './math';\nconst total = add(2, 3);\nconst broken: string = 7;\nconsole.log(total, broken);\n");
writeFileSync(path.join(workspace, 'notes.txt'), 'first\r\nsecond\r\n');
writeFileSync(path.join(workspace, 'conflict.txt'), 'ORIGINAL_DISK\n');
writeFileSync(path.join(workspace, 'offline.txt'), 'offline document\n');
writeFileSync(path.join(workspace, 'ide-ui-approved.txt'), 'BASELINE_NATIVE_FILE\n');
let backend, child, browser, cleaned = false, failure;
const outputs = [];
const saveLogs = () => writeFileSync(path.join(evidence, 'host-output.txt'), outputs.join(''));
try {
  await build({ entryPoints: ['tests/ide-host.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: path.join(root, 'native-tests.cjs'), external: ['vscode'] });
  const assets = ideAssets(project, path.join(project, 'build'), false);
  const spec = prepareIde({ productRoot: project, dataDir, workspace, workspaceBoundary: project, ...assets });
  const settingsFile = path.join(spec.userData, 'User', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8')); settings['npn.openWorkbenchOnStartup'] = false; settings['window.dialogStyle'] = 'custom';
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  const vsix = path.join(root, 'npn-ide.vsix');
  const packed = spawnSync('python', ['-I', '-B', path.resolve('scripts/package-ide-extension.py'), '--source', assets.extensionDirectory, '--output', vsix], { cwd: project, env: { ...process.env, TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), PYTHONIOENCODING: 'utf-8' }, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const install = spawnSync(spec.executable, [path.join(assets.hostDirectory, 'resources', 'app', 'out', 'cli.js'), '--install-extension', vsix, '--extensions-dir', path.join(root, 'vsix-install'), '--user-data-dir', path.join(root, 'vsix-data'), '--force'],
    { cwd: project, env: { ...spec.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000 });
  writeFileSync(path.join(evidence, 'vsix-install.txt'), String(install.stdout) + String(install.stderr));
  assert.equal(install.status, 0, `Actual host VSIX install failed: ${install.stderr}`);
  assert.ok(existsSync(path.join(root, 'vsix-install', `npn-gamma.npn-ide-${version}`, 'package.json')));
  // The UI scenario intentionally overwrites an existing file. Model the required real
  // read before proposing its write; no receipt or approval is injected by this fixture.
  const deepWorkResponder = (body, index) => {
    const messages = body.messages ?? [];
    const system = messages.filter(row => row.role === 'system').map(row => String(row.content)).join('\n');
    const user = messages.findLast(row => row.role === 'user')?.content ?? '';
    if (system.includes('REVIEWER ROLE') || !String(user).includes('IDE_DEEP_WORK_MARKER')) return undefined;
    const lastResult = name => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'tool') continue;
        const call = messages.slice(0, i).flatMap(row => row.tool_calls ?? []).findLast(row => row.id === messages[i].tool_call_id && row.function?.name === name);
        if (call) {
          try { return JSON.parse(messages[i].content); }
          catch { return String(messages[i].content); }
        }
      }
    };
    if (lastResult('write_file')) return undefined;
    const read = lastResult('read_file');
    const call = (name, args) => ({ content: '', toolCalls: [{ id: `ide-deep-${index}-${name}`, name, arguments: args }] });
    if (!read) return call('read_file', { path: 'ide-ui-approved.txt' });
    assert.equal(read.error, undefined, 'DEEP_WORK requires a successful real read_file result.');
    assert.equal(typeof read === 'string' ? read : read.output, 'BASELINE_NATIVE_FILE\n', 'Read result must contain the actual existing fixture baseline.');
    return call('write_file', { path: 'ide-ui-approved.txt', content: `NPN-Gamma mock output\nGoal: ${user}\n` });
  };
  backend = await startBackend({ dataDir, projectRoot: project, mockOptions: { delayMs: 1000, responder: deepWorkResponder } });
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const probe = path.join(root, 'probe-extension'); mkdirSync(probe);
  writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ publisher: 'npn-gamma', name: 'acceptance-driver', version: '0.0.1', engines: { vscode: '^1.135.0' }, main: './driver.cjs' }));
  writeFileSync(path.join(probe, 'driver.cjs'), 'exports.activate = () => {};');
  child = spawn(spec.executable, [...spec.args.slice(0, -1), '--extensionDevelopmentPath=' + probe,
    '--extensionTestsPath=' + path.join(root, 'native-tests.cjs'), '--disable-workspace-trust', '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1', workspace],
    { cwd: project, env: { ...spec.env, NPN_IDE_TEST_ROOT: root }, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  for (const stream of [child.stdout, child.stderr]) { stream.setEncoding('utf8'); stream.on('data', value => { outputs.push(value); saveLogs(); process.stdout.write(value); }); }
  // Playwright only walks a target's frame tree for the main frame, so a webview OOPIF whose nested
  // active-frame already exists at attach time never exposes that inner frame. Attach before the
  // extension creates the workbench webviews; Page.frameAttached then registers them normally.
  for (let attempt = 0; ; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; }
    catch (error) {
      if (attempt >= 300) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const context = browser.contexts()[0];
  const pageDeadline = Date.now() + 60000;
  let page;
  while (!page) {
    page = context.pages().find(candidate => candidate.url().includes('workbench.html'));
    if (!page && Date.now() > pageDeadline) throw new Error('IDE workbench page did not appear.');
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  const deadline = Date.now() + 240000;
  let deepChecked = false;
  while (!existsSync(path.join(root, 'capture-ready.json'))) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('IDE exited or timed out before completing native editor tests.');
    if (!deepChecked && existsSync(path.join(root, 'deep-ready.json'))) {
      const checked = await verifyAgentWorkbench(page, workspace, evidence);
      writeFileSync(path.join(root, 'deep-done.json'), JSON.stringify(checked)); deepChecked = true;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  await page.locator('.monaco-workbench').waitFor({ timeout: 15000 });
  await page.screenshot({ path: path.join(evidence, 'native-workbench.png') });
  writeFileSync(path.join(evidence, 'workbench.json'), JSON.stringify({ title: await page.title(), url: page.url(), nativeWorkbench: await page.locator('.monaco-workbench').count() }, null, 2));
  writeFileSync(path.join(root, 'capture-done'), 'captured');
  const result = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('IDE test host did not exit.')), 90000).unref())]);
  assert.equal(result.code, 0, `IDE test exit ${result.code}, signal ${result.signal}`);
  const native = JSON.parse(readFileSync(path.join(root, 'native-results.json'), 'utf8'));
  assert.ok(native.checks.length >= 9 && native.checks.every(check => check.passed), JSON.stringify(native));
  await backend.close();
  const stopped = Date.now() + 10000;
  while (existsSync(path.join(dataDir, 'backend.json')) && Date.now() < stopped) await new Promise(resolve => setTimeout(resolve, 100));
  backend = await startBackend({ dataDir, projectRoot: project });
  assert.equal(backend.services.kernel.listTasks().length, 2);
  assert.ok(backend.services.kernel.listTasks().some(task => task.status === 'paused'));
  assert.ok(backend.services.kernel.listTasks().some(task => task.status === 'completed' && task.goal.objective.includes('IDE_DEEP_WORK_MARKER')));
  assert.match(readFileSync(path.join(workspace, 'offline.txt'), 'utf8'), /OFFLINE_NATIVE_SAVE/);
  writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ ...native, vsixInstalledByActualHost: true, coldRestartSameTask: true, noUnapprovedAgentWrite: !existsSync(path.join(workspace, 'native-task-result.txt')), hostArchive: JSON.parse(readFileSync('.deps/ide-host/npn-host.json', 'utf8')),
    screenshotSha256: createHash('sha256').update(readFileSync(path.join(evidence, 'native-workbench.png'))).digest('hex') }, null, 2));
  console.log(`Native IDE acceptance passed: ${native.checks.length} checks. ${evidence}`);
} catch (error) {
  failure = error; console.error(error);
  if (existsSync(path.join(root, 'native-results.json'))) writeFileSync(path.join(evidence, 'results.json'), readFileSync(path.join(root, 'native-results.json')));
  writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({ error: String(error), fixture: root }, null, 2));
} finally {
  if (child && child.exitCode === null) {
    spawnSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { cwd: project, env: process.env, windowsHide: true });
    await new Promise(resolve => child.once('exit', resolve));
  }
  if (browser) await browser.close().catch(error => { console.warn(String(error)); });
  if (backend) await backend.close();
  saveLogs();
  if (!failure) {
    if (!path.basename(root).startsWith('ide-native-')) throw new Error(`Unexpected IDE test fixture directory: ${root}`);
    assertGeneratedPath(root, ['.tmp', path.basename(root)]);
    rmSync(root, { recursive: true, force: true });
    cleaned = true;
  }
  writeFileSync(path.join(evidence, 'cleanup.json'), JSON.stringify({ fixture: root, removed: cleaned, keptForFailureDiagnosis: Boolean(failure) }, null, 2));
}
if (failure) process.exitCode = 1;
