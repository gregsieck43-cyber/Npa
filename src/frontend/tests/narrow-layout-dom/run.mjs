import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron } from 'playwright';
import ts from 'typescript';

const [mainArg, label, workArg, reportArg, sourceMode = 'candidate'] = process.argv.slice(2), root = path.resolve(import.meta.dirname, '../../../..'), main = path.resolve(mainArg ?? root);
assert.ok(/^[a-z0-9-]+$/.test(label ?? ''), 'Explicit evidence label required');
assert.ok(['candidate', 'production'].includes(sourceMode));
const source = path.join(main, 'src/frontend'), entry = path.join(import.meta.dirname, 'entry.tsx');
const relative = ['src/frontend/styles/session.css', 'src/frontend/styles/shell.css', 'src/frontend/styles/inspector.css', 'src/frontend/features/session/TaskBoard.tsx'];
const overrides = new Map(relative.map(file => [path.join(main, file).toLowerCase(), path.join(sourceMode === 'production' ? main : root, file)]));
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const base = path.resolve(workArg ?? path.join(root, '.tmp/narrow-layout-20261104')), reportDir = path.resolve(reportArg ?? path.join(root, 'evidence/backend-20261026/narrow-layout-20261104'));
mkdirSync(base, { recursive: true }); mkdirSync(reportDir, { recursive: true });
const tmp = mkdtempSync(path.join(base, 'dom-')), reportFile = path.join(reportDir, label + '.json'); assert.equal(existsSync(reportFile), false);
for (const dir of ['build', 'temp', 'home', 'appdata', 'localappdata', 'user']) mkdirSync(path.join(tmp, dir));
for (const [key, dir] of Object.entries({ TEMP: 'temp', TMP: 'temp', HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata' })) process.env[key] = path.join(tmp, dir);
const inputs = new Map(), checks = [], pageErrors = [], measurements = {}; let app, page, stable = false, closed = false;
const track = file => { inputs.set(file, sha(file)); return readFileSync(file, 'utf8'); };
const check = async (name, fn) => { try { await fn(); checks.push({ name, passed: true }); console.log('PASS ' + name); } catch (error) { checks.push({ name, passed: false, error: String(error.stack) }); console.log('FAIL ' + name + ': ' + error.message); } };
try {
  // Compile actual current production components; only the four candidate files are overlaid.
  const config = ts.readConfigFile(path.join(source, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, source), host = ts.createCompilerHost(parsed.options), read = host.readFile.bind(host), exists = host.fileExists.bind(host);
  const virtualEntry = path.join(source, 'tests/narrow-layout-dom/entry.tsx');
  host.readFile = file => path.resolve(file) === virtualEntry ? readFileSync(entry, 'utf8') : read(overrides.get(path.resolve(file).toLowerCase()) ?? file);
  host.fileExists = file => path.resolve(file) === virtualEntry || exists(file);
  host.getSourceFile = (file, version) => { const text = host.readFile(file); return text === undefined ? undefined : ts.createSourceFile(file, text, version, true); };
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([...parsed.fileNames, virtualEntry], parsed.options, host));
  writeFileSync(path.join(reportDir, label + '-typecheck.txt'), ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: () => main, getNewLine: () => '\n' }) + `\ndiagnostics=${diagnostics.length}\n`);
  assert.equal(diagnostics.length, 0, 'strict compile failed');
  await build({ absWorkingDir: root, entryPoints: [entry], outdir: path.join(tmp, 'build'), entryNames: 'bundle', bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { __NPN_GATEWAY__: '"bridge"', 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning', plugins: [{ name: 'read-only-production', setup(build) {
      build.onResolve({ filter: /^\.\.\// }, args => args.importer === entry ? build.resolve(path.resolve(source, 'tests/narrow-layout-dom', args.path), { resolveDir: source, kind: args.kind }) : undefined);
      // Resolve extensionless entry imports through esbuild after redirecting to the production tree.
      build.onLoad({ filter: /\.(tsx?|css)$/ }, args => {
        const actual = overrides.get(args.path.toLowerCase()) ?? args.path;
        return { contents: track(actual), loader: args.path.endsWith('.css') ? 'css' : args.path.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: path.dirname(args.path) };
      });
    } }] });
  writeFileSync(path.join(tmp, 'build/index.html'), '<!doctype html><html data-theme="light" data-accent="ember"><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}</style><div id="root"></div><script src="bundle.js"></script></html>');
  const env = { ...process.env, NPN_LAYOUT_USER: path.join(tmp, 'user'), NPN_LAYOUT_PAGE: path.join(tmp, 'build/index.html') }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(import.meta.dirname, 'app.cjs')], cwd: tmp, env });
  page = await app.firstWindow(); page.on('pageerror', error => pageErrors.push(String(error))); page.setDefaultTimeout(5000);
  await page.waitForFunction(() => typeof window.__render === 'function');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()), '#fbfaf7');
  const capture = async name => {
    await page.mouse.move(970, 600);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    writeFileSync(path.join(reportDir, label + '-' + name + '.png'), Buffer.from(png, 'base64'));
  };
  const render = async (width, kind) => { const id = await page.evaluate(([width, kind]) => window.__render(width, kind), [width, kind]); await page.locator(`[data-render="${id}"]`).waitFor(); };
  await check('narrow task badge and controls do not overlap; complete title and existing details remain available', async () => {
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await render(260, 'task');
    measurements.narrow = await page.locator('.taskboard').evaluate(element => {
      const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const badge = element.querySelector('.badge'), title = element.querySelector('strong'), buttons = [...element.querySelectorAll('.taskboard__controls button')];
      return { viewport: { width: innerWidth, height: innerHeight }, card: rect(element), badge: rect(badge), title: rect(title), titleAttribute: title.title, expectedTitle: window.__fixture.title, buttons: buttons.map(rect) };
    });
    await capture('narrow-task');
    const m = measurements.narrow;
    for (const button of m.buttons) { assert.ok(button.x >= m.card.x && button.right <= m.card.right + 1); assert.ok(button.right <= m.badge.x || button.x >= m.badge.right || button.bottom <= m.badge.y || button.y >= m.badge.bottom, 'badge overlaps task control'); }
    assert.equal(m.titleAttribute, m.expectedTitle); assert.ok(m.title.width >= 30, 'task title has no readable space');
    await page.getByRole('button', { name: '展开任务详情', exact: true }).click(); await page.getByText('完整任务目标', { exact: true }).waitFor();
  });
  await check('narrow status bar can scroll to its complete last control without vertical clipping', async () => {
    await render(260, 'task');
    measurements.status = await page.locator('.statusbar').evaluate(element => {
      const r = element.getBoundingClientRect(), before = element.scrollLeft; element.scrollLeft = element.scrollWidth;
      const last = element.lastElementChild.getBoundingClientRect(), css = getComputedStyle(element);
      return { overflowX: css.overflowX, before, after: element.scrollLeft, left: r.left, right: r.right, top: r.top, bottom: r.bottom, clientHeight: element.clientHeight, last: { left: last.left, right: last.right, top: last.top, bottom: last.bottom } };
    });
    const m = measurements.status; assert.ok(['auto', 'scroll'].includes(m.overflowX), 'status bar must allow horizontal scrolling'); assert.ok(m.after > 0);
    assert.ok(m.last.left >= m.left && m.last.right <= m.right + 1); assert.ok(m.last.top >= m.top && m.last.bottom <= m.top + m.clientHeight + 1, 'status controls clipped vertically');
    await capture('status-end');
  });
  await check('long Request endpoint wraps completely and remains selectable within the Inspector', async () => {
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await render(390, 'request'); await page.locator('.kv-grid').waitFor();
    measurements.endpoint = await page.locator('.kv-grid > [title]').evaluate(element => {
      const r = element.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(element);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return { text: element.textContent, selected: selection.toString(), expected: window.__fixture.endpoint, whiteSpace: getComputedStyle(element).whiteSpace, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, bounds: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, lines: [...range.getClientRects()].map(line => ({ left: line.left, right: line.right, top: line.top, bottom: line.bottom })) };
    });
    await capture('long-endpoint');
    const m = measurements.endpoint; assert.equal(m.text, m.expected); assert.equal(m.selected, m.expected); assert.equal(m.whiteSpace, 'normal'); assert.ok(m.lines.length > 1); assert.ok(m.scrollWidth <= m.clientWidth + 1);
    for (const line of m.lines) assert.ok(line.left >= m.bounds.left - 1 && line.right <= m.bounds.right + 1 && line.bottom <= m.bounds.bottom + 1);
  });
  await check('wide task bar keeps the existing single-row presentation', async () => {
    await render(860, 'task');
    measurements.wide = await page.locator('.taskboard__bar').evaluate(element => [...element.children].filter(child => getComputedStyle(child).display !== 'none').map(child => { const r = child.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
    assert.ok(Math.max(...measurements.wide.map(r => r.top)) < Math.min(...measurements.wide.map(r => r.bottom)));
    await capture('wide-task');
  });
  for (const [file, expected] of inputs) assert.equal(sha(file), expected); stable = true;
} catch (error) { checks.push({ name: 'harness', passed: false, error: String(error.stack) }); }
finally {
  if (app) { await app.close(); closed = true; }
  const passed = checks.length === 4 && checks.every(item => item.passed) && !pageErrors.length && stable && closed;
  writeFileSync(reportFile, JSON.stringify({ at: new Date().toISOString(), passed, sourceMode, checks, measurements, pageErrors, inputs: [...inputs].map(([file, sha256]) => ({ path: file, sha256 })), inputsStable: stable, closed, tempRoot: tmp,
    boundary: 'Actual current React components and CSS in isolated Electron DOM; fixture data only, no backend/model/public calls. Does not replace packaged EXE verification.' }, null, 2));
  console.log(reportFile); process.exitCode = passed ? 0 : 1;
}
