import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PluginManager, type PluginManifest } from '../src/extensions/plugins.js';
import { pluginViews } from '../src/product/plugin-settings.js';

const root = path.resolve(process.env.TEMP ?? '.tmp');
mkdirSync(root, { recursive: true });

function manifest(id: string, name: string, extra: Partial<PluginManifest> = {}): PluginManifest {
  return {
    api: 'npn-plugin/1', id, name, version: '1.0.0', permissions: ['text.transform'],
    operations: [{ id: 'format', title: 'Format', steps: ['trim', 'uppercase'] }], ...extra,
  };
}

function source(dir: string, value: PluginManifest): string {
  const location = path.join(dir, `source-${value.id}`);
  mkdirSync(location);
  writeFileSync(path.join(location, 'plugin.json'), JSON.stringify(value));
  return location;
}

test('pluginViews maps real registry states to the Settings status and capabilities', () => {
  const dir = mkdtempSync(path.join(root, 'product-plugin-settings-'));
  try {
    const manager = new PluginManager(dir);
    assert.deepEqual(pluginViews(manager.list()), []);

    const installed = manager.install(source(dir, manifest('formatter', 'Formatter', { description: 'Trims and uppercases text.' })));
    assert.deepEqual(pluginViews(manager.list()), [{
      id: 'formatter', name: 'Formatter', version: '1.0.0', status: 'disabled',
      capabilities: ['exec'], description: 'Trims and uppercases text.',
    }]);

    // Approval alone does not enable a plugin: the operator switch stays the deciding input.
    manager.approve('formatter', installed.digest);
    assert.equal(pluginViews(manager.list())[0]!.status, 'disabled');

    manager.enable('formatter');
    const active = pluginViews(manager.list())[0]!;
    assert.equal(active.status, 'active');
    assert.deepEqual(active.capabilities, ['exec']);
    assert.equal(active.description, 'Trims and uppercases text.');

    manager.install(source(dir, manifest('plain', 'Plain')));
    assert.deepEqual(pluginViews(manager.list()).map(view => [view.id, view.status, view.description]), [
      ['formatter', 'active', 'Trims and uppercases text.'],
      ['plain', 'disabled', ''],
    ]);

    // Enabled but no longer approved is a real persisted state (registry restored or artifact
    // re-review needed); it must surface as pending_approval instead of active.
    const registryFile = path.join(dir, 'plugins', 'registry.json');
    const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
    assert.equal(registry.length, 2);
    delete registry[0].approvedDigest;
    writeFileSync(registryFile, JSON.stringify(registry));
    const drifted = new PluginManager(dir);
    const record = drifted.list()[0]!;
    assert.equal(record.id, 'formatter');
    assert.equal(record.enabled, true);
    assert.equal(record.approvalValid, false);
    assert.equal(pluginViews(drifted.list())[0]!.status, 'pending_approval');
    assert.equal(pluginViews(drifted.list())[1]!.status, 'disabled');
  } finally {
    assert.equal(path.dirname(dir), root, 'Fixtures stay inside the worker TEMP directory.');
    rmSync(dir, { recursive: true, force: true });
  }
});
