import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { startBackend } from '../src/app/backend.js';
import { Configuration } from '../src/app/configuration.js';
import { installationVolume } from '../src/app/local-paths.js';
import { Services } from '../src/app/services.js';
import { assertProjectFixtureRoot } from './project-boundary.js';

/** A drive that is not the installation volume; rejection must not depend on a fixed workstation drive. */
function offVolume(leaf: string): string {
  const installed = installationVolume().slice(0, 2).toUpperCase();
  const other = ['C:', 'D:', 'E:', 'F:', 'G:', 'H:'].find(candidate => candidate !== installed);
  assert.ok(other, 'An off-volume fixture drive is required to test startup rejection.');
  return other + '\\npn-disallowed-' + leaf;
}

function fixture(t: TestContext) {
  const tempRoot = path.resolve('.tmp');
  assertProjectFixtureRoot(tempRoot);
  mkdirSync(tempRoot, { recursive: true });
  const owned = mkdtempSync(path.join(tempRoot, 'app-configuration-safety-'));
  const closers: (() => Promise<void>)[] = [], junctions: string[] = [];
  t.after(async () => {
    try {
      for (const close of closers.reverse()) await close();
    } finally {
      for (const junction of junctions) if (existsSync(junction)) unlinkSync(junction);
      const relative = path.relative(realpathSync(tempRoot), realpathSync(owned));
      assert.ok(relative.startsWith('app-configuration-safety-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
      rmSync(owned, { recursive: true });
      assert.equal(existsSync(owned), false);
    }
  });
  return { owned, closers, junctions };
}

function servicesFixture(t: TestContext) {
  const f = fixture(t), projectRoot = path.join(f.owned, 'project');
  const dataDir = path.join(projectRoot, 'state-container', 'state'), productRoot = path.join(projectRoot, 'product-container', 'product');
  mkdirSync(productRoot, { recursive: true });
  const services = new Services(dataDir, projectRoot, 'http://127.0.0.1:1/provider/v1', productRoot);
  f.closers.push(async () => { await services.stop(); await services.external.close(); services.integrations.close(); services.kernel.close(); });
  return { ...f, services, projectRoot, productRoot, dataDir };
}

test('corrupt saved configuration preserves its original bytes and exposes repairable mock settings', async t => {
  const f = fixture(t), dataDir = path.join(f.owned, 'data');
  mkdirSync(dataDir);
  const filename = path.join(dataDir, 'configuration.json');
  for (const original of ['{"provider":', JSON.stringify({ provider: { mode: 'live' }, globalPaths: 'wrong shape', skillRoots: [] }),
    JSON.stringify({ provider: { mode: 'mock', maxOutputTokens: 63 }, globalPaths: [], skillRoots: [] })]) {
    writeFileSync(filename, original);
    const configuration = new Configuration('http://127.0.0.1:1/provider/v1', dataDir);
    assert.equal(configuration.view().provider.mode, 'mock');
    assert.match(configuration.view().configurationError!, /invalid.*original file is preserved/i);
    assert.deepEqual(configuration.view().globalPaths, []);
    assert.equal(readFileSync(filename, 'utf8'), original);
  }
  const original = readFileSync(filename, 'utf8');
  const backend = await startBackend({ dataDir, projectRoot: f.owned });
  f.closers.push(backend.close);
  assert.equal(backend.services.health().status, 'ready');
  assert.equal(backend.services.config().provider.mode, 'mock');
  assert.ok(backend.services.config().configurationError);
  assert.equal(readFileSync(filename, 'utf8'), original, 'Startup must retain the damaged settings for repair');
  const globalPath = path.join(f.owned, 'global.md'), skillRoot = path.join(f.owned, 'skills');
  const repaired = backend.services.configure({ mode: 'mock', model: 'original-configuration-fixture', maxOutputTokens: 512, maxRequestBytes: 16_384, globalPaths: [globalPath], skillRoots: [skillRoot] });
  assert.equal(repaired.configurationError, undefined);
  const persisted = JSON.parse(readFileSync(filename, 'utf8'));
  assert.equal(persisted.provider.maxOutputTokens, 512);
  assert.equal(persisted.provider.maxRequestBytes, 16_384);
  assert.deepEqual(persisted.globalPaths, [globalPath]);
  assert.deepEqual(persisted.skillRoots, [skillRoot]);
  assert.equal(Object.hasOwn(persisted, 'credential'), false);
  assert.equal(readdirSync(dataDir).some(name => name.startsWith('.npn-') && name.endsWith('.tmp')), false);
  await backend.close();
  const restarted = await startBackend({ dataDir, projectRoot: f.owned });
  f.closers.push(restarted.close);
  assert.equal(restarted.services.config().provider.model, 'original-configuration-fixture');
  assert.equal(restarted.services.config().provider.baseUrl, restarted.mock.url, 'Persisted mock settings must bind the new local provider after restart');
  assert.equal(restarted.services.config().configurationError, undefined);
  assert.deepEqual(restarted.services.config().globalPaths, [globalPath]);
});

test('a failed configuration replacement reports failure without removing the existing target or leaving staged files', t => {
  const f = fixture(t), dataDir = path.join(f.owned, 'data'), occupied = path.join(dataDir, 'configuration.json');
  mkdirSync(occupied, { recursive: true });
  writeFileSync(path.join(occupied, 'owned-marker.txt'), 'Preserve this occupied configuration target.');
  const configuration = new Configuration('http://127.0.0.1:1/provider/v1', dataDir);
  assert.ok(configuration.view().configurationError);
  assert.throws(() => configuration.set({ mode: 'mock', maxOutputTokens: 512 }));
  assert.equal(lstatSync(occupied).isDirectory(), true);
  assert.equal(readFileSync(path.join(occupied, 'owned-marker.txt'), 'utf8'), 'Preserve this occupied configuration target.');
  assert.deepEqual(readdirSync(dataDir), ['configuration.json']);
});

test('backend rejects off-volume roots, data outside the project, and junction ancestors before creating state', async t => {
  const f = fixture(t), projectRoot = path.join(f.owned, 'project');
  mkdirSync(projectRoot);
  await assert.rejects(startBackend({ projectRoot, dataDir: offVolume('data') }), /volume that hosts this installation|installation volume/i);
  await assert.rejects(startBackend({ projectRoot: offVolume('project-root'), dataDir: path.join(projectRoot, 'uncreated-data') }), /volume that hosts this installation|installation volume/i);
  const outside = path.join(f.owned, 'outside-project-data');
  await assert.rejects(startBackend({ projectRoot, dataDir: outside }), /inside the configured project/);
  assert.equal(existsSync(outside), false);
  assert.equal(existsSync(path.join(projectRoot, 'uncreated-data')), false);
  assert.deepEqual(readdirSync(projectRoot), [], 'Rejected startup must not create state before validation');
  const target = path.join(projectRoot, 'real'), junction = path.join(projectRoot, 'linked');
  mkdirSync(target);
  writeFileSync(path.join(target, 'owned-marker.txt'), 'Original target remains untouched.');
  symlinkSync(target, junction, 'junction'); f.junctions.push(junction);
  await assert.rejects(startBackend({ projectRoot: junction, dataDir: path.join(junction, 'data') }), /junction|symbolic/i);
  await assert.rejects(startBackend({ projectRoot, dataDir: path.join(junction, 'data') }), /junction|symbolic/i);
  assert.deepEqual(readdirSync(target), ['owned-marker.txt']);
});

test('explicit workspaces exclude the running product and state, with only named workspace children allowed inside data', t => {
  const f = servicesFixture(t);
  const create = (workspace: string) => f.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace, objective: 'Use this isolated fixture workspace.' } });
  for (const workspace of [f.projectRoot, path.dirname(f.dataDir), f.dataDir, path.join(f.dataDir, 'plugins'), path.join(f.dataDir, 'workspaces'),
    path.dirname(f.productRoot), f.productRoot, path.join(f.productRoot, 'src'), path.join(f.productRoot, '.deps')]) {
    assert.throws(() => create(workspace), /workspace|running product|kernel/i);
  }
  assert.equal(f.services.kernel.listTasks().length, 0, 'Rejected folders must not create durable tasks');
  for (const workspace of [path.join(f.projectRoot, 'user-project'), path.join(f.dataDir, 'workspaces', 'own-child')]) {
    const ack = create(workspace);
    assert.equal(ack.status, 'accepted');
    assert.equal(f.services.task(ack.taskId).workspace, workspace);
    assert.equal(lstatSync(workspace).isDirectory(), true);
  }
});

test('editor reads preserve valid UTF-8 and distinguish missing files while rejecting binary, invalid UTF-8 and oversized bytes', async t => {
  const f = servicesFixture(t), workspace = path.join(f.projectRoot, 'user-project');
  const ack = f.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { workspace, objective: 'Inspect own text fixtures.' } });
  const read = (filename: string, allowMissing = false) => f.services.files(new URLSearchParams({ taskId: ack.taskId!, path: filename, allowMissing: String(allowMissing) }));
  const valid = 'Exact Chinese 中文 and emoji 🙂 bytes.\r\n';
  writeFileSync(path.join(workspace, 'valid.txt'), valid);
  writeFileSync(path.join(workspace, 'empty.txt'), '');
  assert.deepEqual(await read('valid.txt'), { path: 'valid.txt', exists: true, content: valid });
  assert.deepEqual(await read('empty.txt'), { path: 'empty.txt', exists: true, content: '' });
  assert.deepEqual(await read('missing/new.txt', true), { path: 'missing/new.txt', exists: false, content: '' });
  assert.equal(existsSync(path.join(workspace, 'missing')), false, 'A missing-file preview must not create directories');
  await assert.rejects(read('missing/new.txt'), { code: 'ENOENT' });
  writeFileSync(path.join(workspace, 'binary.txt'), Buffer.from([65, 0, 66]));
  writeFileSync(path.join(workspace, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(read('binary.txt'), /Binary/);
  await assert.rejects(read('invalid.txt'), /not valid UTF-8/);
  writeFileSync(path.join(workspace, 'limit.txt'), Buffer.alloc(1_048_576, 97));
  assert.equal((await read('limit.txt')).content?.length, 1_048_576);
  const oversized = '汉'.repeat(349_526);
  assert.ok(oversized.length < 1_048_576 && Buffer.byteLength(oversized) > 1_048_576);
  writeFileSync(path.join(workspace, 'oversized.txt'), oversized);
  await assert.rejects(read('oversized.txt'), /1 MiB/);
});
