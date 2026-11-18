import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { observeCommandFiles, observedChanges } from '../src/app/command-observation.js';

test('command observation compares bounded claimed candidates, including absence, and rejects links/large files', async t => {
  const root = path.resolve(process.env.TEMP ?? '.tmp'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'command-observe-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'a.txt'), 'before'); writeFileSync(path.join(dir, 'large'), Buffer.alloc(1048577));
  mkdirSync(path.join(dir, 'target')); symlinkSync(path.join(dir, 'target'), path.join(dir, 'junction'), 'junction');
  const paths = ['a.txt', 'new.txt', 'large', 'junction/file', '../outside'];
  const before = await observeCommandFiles(dir, paths);
  assert.equal(before[1]!.sha256, null); assert.equal(before[2]!.status, 'too_large');
  assert.equal(before[3]!.status, 'unavailable'); assert.equal(before[4]!.status, 'unavailable');
  writeFileSync(path.join(dir, 'a.txt'), 'after'); writeFileSync(path.join(dir, 'new.txt'), 'created');
  const changes = observedChanges(before, await observeCommandFiles(dir, paths));
  assert.deepEqual(changes.map(change => change.path), ['a.txt', 'new.txt']);
  assert.equal((await observeCommandFiles(dir, Array.from({ length: 100 }, (_, i) => `absent-${i}`))).length, 32);
});
