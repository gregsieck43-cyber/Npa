import test from 'node:test';
import assert from 'node:assert/strict';
import { IdeEditors } from '../src/ide/editors.js';
import { brandProduct, npnWatermark } from '../src/ide/branding.js';

test('IDE branding changes visible product identity without dropping upstream licenses or registry', () => {
  const upstream = { nameShort: 'VSCodium', nameLong: 'VSCodium', licenseName: 'MIT', licenseFileName: 'LICENSE.txt', extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery' } };
  const branded = brandProduct(upstream, '0.6.0');
  assert.equal(branded.nameLong, 'NPN Gamma IDE');
  assert.equal(branded.win32AppUserModelId, 'NPN.Gamma.IDE');
  assert.equal(branded.licenseName, 'MIT');
  assert.deepEqual(branded.extensionsGallery, upstream.extensionsGallery);
  assert.equal(upstream.nameLong, 'VSCodium');
  assert.match(npnWatermark(false), /NPN/);
  assert.doesNotMatch(npnWatermark(false), /VSCodium/);
});

test('a live IDE dirty document blocks Agent dispatch without blocking unrelated files', () => {
  const editors = new IdeEditors();
  editors.update('window-a', 'F:\\project', ['src/main.ts'], 1000);
  assert.throws(() => editors.assertWritable('F:\\project\\src\\main.ts', 1001), /unsaved/i);
  assert.throws(() => editors.assertWorkspaceClean('F:\\project', 1001), /unsaved/i);
  assert.doesNotThrow(() => editors.assertWorkspaceClean('F:\\other', 1001));
  assert.doesNotThrow(() => editors.assertWritable('F:\\project\\src\\other.ts', 1001));
  editors.update('window-a', 'F:\\project', [], 1002);
  assert.doesNotThrow(() => editors.assertWritable('F:\\project\\src\\main.ts', 1003));
});

test('multiple IDE windows retain independent dirty ownership and stale sessions expire', () => {
  const editors = new IdeEditors();
  editors.update('window-a', 'F:\\project', ['main.ts'], 1000);
  editors.update('window-b', 'F:\\project', ['main.ts'], 1000);
  editors.update('window-a', 'F:\\project', [], 1002);
  assert.throws(() => editors.assertWritable('F:\\project\\main.ts', 1003), /unsaved/i);
  editors.remove('window-b');
  assert.doesNotThrow(() => editors.assertWritable('F:\\project\\main.ts', 1004));
  editors.update('window-a', 'F:\\project', ['main.ts'], 1005);
  assert.doesNotThrow(() => editors.assertWritable('F:\\project\\main.ts', 40000));
  assert.throws(() => editors.update('window-a', 'F:\\project', ['../escape.txt'], 1000), /outside/i);
});

test('a late clean report cannot erase a newer dirty document report', () => {
  const editors = new IdeEditors();
  editors.update('window-a', 'F:\\project', ['main.ts'], 1000, 4);
  editors.update('window-a', 'F:\\project', [], 1001, 3);
  assert.throws(() => editors.assertWritable('F:\\project\\main.ts', 1002), /unsaved/i);
  editors.update('window-a', 'F:\\project', [], 1003, 5);
  assert.doesNotThrow(() => editors.assertWritable('F:\\project\\main.ts', 1004));
});
