import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Kernel } from '../src/kernel/index.js';
import { IntegrationService } from '../src/integrations/index.js';

const project = path.resolve('.'), base = path.join(project, '.tmp/final-integrations');
async function fixture(run: (kernel: Kernel, service: IntegrationService, workspace: string, directory: string) => Promise<void>) {
  await mkdir(base, { recursive: true }); const directory = await mkdtemp(path.join(base, 'rea-'));
  const kernel = new Kernel(path.join(directory, 'kernel'));
  const workspace = path.join(directory, 'sample'); await mkdir(workspace);
  const service = new IntegrationService({ kernel, dataDir: path.join(directory, 'integrations'), projectRoot: project });
  try { await run(kernel, service, workspace, directory); } finally { service.close(); kernel.close(); await rm(directory, { recursive: true, force: true }); }
}
const installed = existsSync(path.join(project, '.deps/rea-6.4.0/node_modules/rea-agents/scripts/rea.mjs'));
test('a missing pinned runtime is reported unavailable rather than silently substituted', async () => fixture(async (kernel, _service, _workspace, directory) => {
  const unavailable = new IntegrationService({ kernel, dataDir: path.join(directory, 'missing-data'), projectRoot: project, dependencyRoot: path.join(directory, 'missing-dependency') });
  try {
    unavailable.tools.configure({ enabled: true });
    assert.equal(unavailable.tools.status().rea.available, false);
    assert.match(unavailable.tools.status().rea.reason!, /not installed/i);
    assert.deepEqual(unavailable.tools.definitions(), []);
  } finally { unavailable.close(); }
}));

test('REA is opt-in, declares native unavailability, blocks remote/credential targets and pins sample content', { skip: !installed }, async () => fixture(async (_kernel, service, workspace) => {
  assert.equal(service.tools.status().rea.enabled, false); assert.equal(service.tools.status().rea.available, true);
  assert.equal(service.tools.status().rea.native.available, false); assert.equal(service.tools.definitions().length, 0);
  await writeFile(path.join(workspace, 'main.js'), 'export const owned = true;');
  await assert.rejects(service.tools.prepare(workspace, { name: 'rea_analyze_local', arguments: { paths: ['main.js'] } }), /disabled/i);
  service.tools.configure({ enabled: true });
  for (const file of ['https://example.org/file.js', '../outside.js', 'API.txt', '.env', 'native.exe']) {
    await assert.rejects(service.tools.prepare(workspace, { name: 'rea_analyze_local', arguments: { paths: [file] } }));
  }
  const prepared = (await service.tools.prepare(workspace, { name: 'rea_analyze_local', arguments: { paths: ['main.js'] } }))!;
  assert.equal(prepared.mutating, true);
  assert.deepEqual(await service.tools.prepare(workspace, prepared), prepared);
  await assert.rejects(service.tools.execute(prepared, { effectKey: 'no-approval' }), /approval/i);
  await writeFile(path.join(workspace, 'main.js'), 'export const owned = false;');
  await assert.rejects(service.tools.prepare(workspace, prepared), /changed/i);
  const failed = await service.tools.execute(prepared, { effectKey: 'changed', approvedDigest: prepared.digest });
  assert.equal(failed.status, 'failed'); assert.match(failed.error!, /changed after approval/i);
}));

test('cancelled REA execution persists a distinct failure and never replays the effect', { skip: !installed, timeout: 20000 }, async () => fixture(async (_kernel, service, workspace) => {
  await writeFile(path.join(workspace, 'main.js'), 'export const owned = true;');
  service.tools.configure({ enabled: true });
  const prepared = (await service.tools.prepare(workspace, { name: 'rea_analyze_local', arguments: { paths: ['main.js'] } }))!;
  const controller = new AbortController();
  const execution = service.tools.execute(prepared, { effectKey: 'cancelled-analysis', approvedDigest: prepared.digest, signal: controller.signal });
  controller.abort();
  const outcome = await execution;
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error!, /REA cancelled;/);
  assert.match(outcome.error!, /CLI diagnostics/);
  assert.deepEqual(await service.tools.queryOutcome('cancelled-analysis', prepared.digest), outcome);
  assert.deepEqual(await service.tools.execute(prepared, { effectKey: 'cancelled-analysis', approvedDigest: prepared.digest }), outcome);
}));

test('real pinned REA CLI analyzes inert owned Electron sources through Kernel approval and retains restart-queryable evidence', { skip: !installed, timeout: 90000 }, async () => fixture(async (kernel, service, workspace, directory) => {
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'owned-rea-fixture', version: '1.0.0', main: 'main.js' }));
  await writeFile(path.join(workspace, 'main.js'), `require('node:fs').writeFileSync(${JSON.stringify(path.join(workspace, 'MUST-NOT-EXECUTE'))}, 'never');
const { BrowserWindow, ipcMain } = require('electron');
const window = new BrowserWindow({ webPreferences: { preload: './preload.js', contextIsolation: true, nodeIntegration: false } });
ipcMain.handle('owned:read', () => 'owned result');`);
  await writeFile(path.join(workspace, 'preload.js'), `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ownedApi', { read: () => ipcRenderer.invoke('owned:read') });`);
  service.tools.configure({ enabled: true });
  const taskId = kernel.command({ commandId: 'create-rea-task', type: 'create_task', parameters: { title: 'Inspect own Electron fixture', workspace } }).taskId!;
  const run = kernel.createRun(taskId); kernel.transition(taskId, 'running');
  const prepared = (await service.tools.prepare(workspace, { name: 'rea_analyze_local', arguments: { paths: ['package.json', 'main.js', 'preload.js'] } }))!;
  const intent = kernel.prepareIntent(taskId, run.id, { id: 'real-cli', name: prepared.name, arguments: prepared.arguments }, { capability: prepared.capability, paths: [] });
  assert.throws(() => kernel.dispatch(intent.id)); kernel.approve(intent.id); kernel.dispatch(intent.id);
  const outcome = await service.tools.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
  assert.equal(outcome.status, 'applied', outcome.error);
  kernel.receipt(intent.id, outcome.receipt!);
  assert.equal(existsSync(path.join(workspace, 'MUST-NOT-EXECUTE')), false);
  assert.equal(outcome.receipt!.engine, 'rea-cli'); assert.equal(outcome.receipt!.version, '6.4.0');
  const read = service.tools.readResult(intent.effectKey, 0, 12000);
  assert.match(read.text, /javascript|artifact|electron/i);
  assert.ok(Number((outcome.receipt!.statistics as { parsed_javascript_files: number })?.parsed_javascript_files) >= 2, JSON.stringify(outcome.receipt));
  assert.ok(Number((outcome.receipt!.summary as { browser_windows: number })?.browser_windows) >= 1, JSON.stringify(outcome.receipt));
  const captured = service.captureEvidence(taskId, { sourceTaskId: taskId, kind: 'receipt', sourceId: intent.id });
  assert.match(captured.content, /rea-cli/);
  const restarted = new IntegrationService({ kernel, dataDir: path.join(directory, 'integrations'), projectRoot: project });
  try { assert.deepEqual(await restarted.tools.queryOutcome(intent.effectKey, prepared.digest), outcome); assert.equal(restarted.tools.readResult(intent.effectKey).sha256, read.sha256); }
  finally { restarted.close(); }
  assert.deepEqual(await service.tools.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest }), outcome);
  assert.equal(await readFile(path.join(workspace, 'preload.js'), 'utf8').then(text => text.includes('ownedApi')), true);
  if (process.env.NPN_INTEGRATION_EVIDENCE_DIR) {
    const evidenceDir = process.env.NPN_INTEGRATION_EVIDENCE_DIR;
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, 'real-rea-cli.json'), JSON.stringify({ engine: 'actual-installed-rea-cli', version: '6.4.0', approvalIntent: intent.id, receipt: outcome.receipt, capturedEvidenceSha256: captured.sha256, sampleExecuted: false }, null, 2));
    let raw = '', offset = 0;
    do {
      const page = service.tools.readResult(intent.effectKey, offset, 12000); raw += page.text;
      if (page.nextOffset === null) break; offset = page.nextOffset;
    } while (true);
    assert.equal(raw.length, read.totalChars);
    await writeFile(path.join(evidenceDir, 'real-rea-output.json'), raw);
  }
}));
