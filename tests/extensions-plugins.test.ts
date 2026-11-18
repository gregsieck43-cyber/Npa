import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { PluginManager, PluginError, DSH_COMPATIBLE_VERSION, type PluginManifest } from '../src/extensions/plugins.js';

function temp(): string { const root = resolve('.tmp'); mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, 'extensions-plugins-')); }
function clean(directory: string): void { assert.ok(directory.startsWith(resolve('.tmp') + sep)); rmSync(directory, { recursive: true, force: true }); }
const fixture = (): PluginManifest => ({ api: 'npn-plugin/1', id: 'own_formatter', name: 'Our harmless fixture', version: '1.0.0', permissions: ['text.transform'], operations: [{ id: 'clean', title: 'Clean text', steps: ['normalize_newlines', 'trim'] }] });
function source(root: string, manifest: unknown, name = 'source'): string { const dir = join(root, name); mkdirSync(dir); writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest)); return dir; }
const code = (wanted: string) => (error: unknown) => error instanceof PluginError && error.code === wanted;
test('native example installs disabled, requires digest approval and retains lifecycle across restart', async () => {
  const directory = temp();
  try {
    const manager = new PluginManager(join(directory, 'data'));
    const installed = manager.install(resolve('examples/plugins/formatter'));
    assert.equal(installed.enabled, false); assert.equal(installed.approvalValid, false);
    assert.throws(() => manager.execute(installed.id, 'clean', ' a\r\nb '), code('PLUGIN_DISABLED'));
    assert.throws(() => manager.enable(installed.id), code('APPROVAL_REQUIRED'));
    assert.throws(() => manager.approve(installed.id, 'wrong-digest'), code('ARTIFACT_CHANGED'));
    manager.approve(installed.id, installed.digest); await manager.enable(installed.id);
    const reopened = new PluginManager(join(directory, 'data'));
    assert.deepEqual(await reopened.execute(installed.id, 'clean', ' a\r\nb '), { output: 'a\nb', digest: installed.digest });
    assert.equal((await reopened.execute(installed.id, 'shout', ' hi ' )).output, 'HI');
    assert.throws(() => reopened.remove(installed.id), code('PLUGIN_ENABLED'));
    reopened.disable(installed.id); reopened.remove(installed.id); assert.deepEqual(reopened.list(), []);
  } finally { clean(directory); }
});
test('changed artifacts revoke execution and cannot be approved using an old digest', () => {
  const directory = temp();
  try {
    const dataDir = join(directory, 'data'); const manager = new PluginManager(dataDir); const installed = manager.install(source(directory, fixture()));
    manager.approve(installed.id, installed.digest); manager.enable(installed.id);
    const path = join(dataDir, 'plugins', installed.id, 'plugin.json'); const stored = JSON.parse(readFileSync(path, 'utf8'));
    stored.manifest.operations[0].steps = ['uppercase']; writeFileSync(path, JSON.stringify(stored));
    assert.equal(manager.list()[0]!.approvalValid, false);
    assert.throws(() => manager.execute(installed.id, 'clean', 'hello'), code('APPROVAL_REQUIRED'));
    assert.throws(() => manager.approve(installed.id, installed.digest), code('ARTIFACT_CHANGED'));
    manager.disable(installed.id); manager.remove(installed.id);
  } finally { clean(directory); }
});
test('plugin kernel, approval, executable hooks and unsupported versions are rejected at install', () => {
  const directory = temp();
  try {
    const manager = new PluginManager(join(directory, 'data'));
    assert.throws(() => manager.install(source(directory, { ...fixture(), permissions: ['kernel.write'] }, 'kernel')), code('DENIED_PERMISSION'));
    assert.throws(() => manager.install(source(directory, { ...fixture(), permissions: ['approval.grant'] }, 'approval')), code('DENIED_PERMISSION'));
    assert.throws(() => manager.install(source(directory, { ...fixture(), api: 'npn-plugin/2' }, 'version')), code('UNSUPPORTED_API'));
    assert.throws(() => manager.install(source(directory, { ...fixture(), entrypoint: 'index.js' }, 'executable')), code('UNSUPPORTED_API'));
    assert.throws(() => manager.install(source(directory, { ...fixture(), operations: [{ id: 'x', title: 'Execute code', steps: ['eval'] }] }, 'eval')), code('UNSUPPORTED_API'));
    assert.deepEqual(manager.list(), []);
  } finally { clean(directory); }
});
test('exact plugin dependencies are approved and enabled explicitly, never installed automatically', async () => {
  const directory = temp();
  try {
    const manager = new PluginManager(join(directory, 'data'));
    const dependent = manager.install(source(directory, { ...fixture(), id: 'dependent', dependencies: [{ id: 'own_formatter', version: '1.0.0' }] }, 'dependent'));
    manager.approve(dependent.id, dependent.digest); assert.throws(() => manager.enable(dependent.id), code('NOT_INSTALLED'));
    const dependency = manager.install(source(directory, fixture(), 'dependency')); manager.approve(dependency.id, dependency.digest);
    assert.throws(() => manager.enable(dependent.id), code('DEPENDENCY_UNAVAILABLE'));
    await manager.enable(dependency.id); await manager.enable(dependent.id);
    assert.equal((await manager.execute(dependent.id, 'clean', ' hello ')).output, 'hello');
    assert.throws(() => manager.disable(dependency.id), code('DEPENDENCY_IN_USE'));
    manager.disable(dependent.id); assert.throws(() => manager.remove(dependency.id), code('PLUGIN_ENABLED'));
    manager.disable(dependency.id); assert.throws(() => manager.remove(dependency.id), code('DEPENDENCY_IN_USE'));
    manager.remove(dependent.id); manager.remove(dependency.id);
  } finally { clean(directory); }
});
test('DSH manifest v1 metadata bridge works for the declared version and rejects Cordis and client packages', async () => {
  const directory = temp();
  try {
    const manager = new PluginManager(join(directory, 'data'));
    const valid = manager.install(resolve('examples/plugins/dsh-metadata-formatter'));
    assert.equal(valid.adapter, 'dsh-manifest/1'); manager.approve(valid.id, valid.digest); await manager.enable(valid.id);
    assert.equal((await manager.execute(valid.id, 'clean', ' X\r\nY ')).output, 'X\nY');
    const pkg = { name: '@own/test', version: '1.0.0', engines: { dsh: DSH_COMPATIBLE_VERSION }, dsh: { manifestVersion: 1 }, npn: fixture() };
    const invalids = [
      { ...pkg, engines: { dsh: '0.3.0' } }, { ...pkg, dsh: { manifestVersion: 2 } },
      { ...pkg, dsh: { manifestVersion: 1, client: { platform: 'web' } } },
      { ...pkg, main: 'lib/index.js' }, { ...pkg, dependencies: { '@deepseek-ai/cordis': '0.2.0-rc.2' } },
    ];
    invalids.forEach((value, index) => { const dir = join(directory, `dsh-invalid-${index}`); mkdirSync(dir); writeFileSync(join(dir, 'package.json'), JSON.stringify(value)); assert.throws(() => manager.install(dir), PluginError); });
  } finally { clean(directory); }
});
