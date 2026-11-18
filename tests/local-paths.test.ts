import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { startBackend } from '../src/app/backend.js';
import { Configuration } from '../src/app/configuration.js';
import { assertLocalPath, installationVolume, isLocalPath } from '../src/app/local-paths.js';
import { WorkspaceRoots } from '../src/app/workspace-roots.js';
import { loadInstructions } from '../src/runtime/instructions.js';
import { assertProjectFixtureRoot, projectRoot } from './project-boundary.js';

const project = projectRoot(), tempRoot = path.join(project, '.tmp');
const LOCAL_VOLUME = /volume that hosts this installation|installation volume|local path/i;
const UNC = '\\\\server\\share\\x';

/** A leaf on a drive that is not the installation volume; the test never writes there. */
function offVolume(leaf: string): string {
  const installed = installationVolume().slice(0, 2).toUpperCase();
  const other = ['C:', 'D:', 'E:', 'F:', 'G:', 'H:'].find(candidate => candidate !== installed);
  assert.ok(other, 'An off-volume fixture drive is required to test path rejection.');
  return other + '\\npn-local-paths-' + leaf;
}

function fixture(t: TestContext): string {
  mkdirSync(tempRoot, { recursive: true });
  const owned = mkdtempSync(path.join(tempRoot, 'local-paths-'));
  assertProjectFixtureRoot(owned);
  t.after(() => {
    const relative = path.relative(tempRoot, owned);
    assert.ok(relative.startsWith('local-paths-') && !relative.includes(path.sep) && !path.isAbsolute(relative),
      'Only the owned local-paths fixture may be removed.');
    rmSync(owned, { recursive: true, force: true });
    assert.equal(existsSync(owned), false);
  });
  return owned;
}

test('installation volume is the volume that hosts this checkout', () => {
  assert.match(installationVolume(), /^[A-Za-z]:\\$/);
  assert.equal(path.parse(project).root.toLowerCase(), installationVolume().toLowerCase(), 'The checkout lives on the installation volume');
});

test('accepts real fixture directories and their children', t => {
  const owned = fixture(t), nested = path.join(owned, 'nested');
  mkdirSync(nested);
  writeFileSync(path.join(nested, 'file.txt'), 'fixture');
  assert.equal(isLocalPath(owned), true);
  assert.equal(assertLocalPath(owned), path.resolve(owned));
  assert.equal(assertLocalPath(path.join(nested, 'file.txt')), path.resolve(nested, 'file.txt'));
  assert.equal(assertLocalPath(path.join(owned, 'future', 'child.txt')), path.resolve(owned, 'future', 'child.txt'));
});

test('rejects off-volume, UNC, volume-root, relative and empty paths', () => {
  const foreign = offVolume('outside');
  assert.equal(isLocalPath(foreign), false);
  assert.throws(() => assertLocalPath(foreign), LOCAL_VOLUME);
  assert.equal(isLocalPath(UNC), false);
  assert.throws(() => assertLocalPath(UNC), LOCAL_VOLUME);
  assert.equal(isLocalPath(installationVolume()), false, 'The volume root itself is not an owned path');
  assert.throws(() => assertLocalPath(installationVolume()), LOCAL_VOLUME);
  assert.equal(isLocalPath('relative\\path'), false);
  assert.equal(isLocalPath(''), false);
  assert.equal(isLocalPath(undefined), false);
  assert.throws(() => assertLocalPath('relative\\path'), LOCAL_VOLUME);
});

test('rejects paths below a junction ancestor without following it', t => {
  const owned = fixture(t), target = path.join(owned, 'target'), link = path.join(owned, 'linked');
  mkdirSync(target);
  writeFileSync(path.join(target, 'owned.txt'), 'target');
  symlinkSync(target, link, 'junction');
  try {
    assert.equal(isLocalPath(path.join(link, 'child.txt')), true, 'Volume checks alone cannot see a link ancestor');
    assert.throws(() => assertLocalPath(link), /junctions or symbolic links/i);
    assert.throws(() => assertLocalPath(path.join(link, 'child.txt')), /junctions or symbolic links/i);
  } finally {
    unlinkSync(link);
  }
  assert.equal(assertLocalPath(path.join(target, 'owned.txt')), path.resolve(target, 'owned.txt'));
});

test('rejects a dangling junction ancestor instead of treating it as a missing path', t => {
  const owned = fixture(t), missing = path.join(owned, 'missing-target'), link = path.join(owned, 'dangling');
  symlinkSync(missing, link, 'junction');
  try {
    assert.equal(existsSync(link), false, 'A dangling junction is reported as missing by existsSync');
    assert.equal(isLocalPath(link), true, 'Volume checks alone cannot see a junction');
    assert.equal(isLocalPath(path.join(link, 'child.txt')), true);
    assert.throws(() => assertLocalPath(link), /junctions or symbolic links/i);
    assert.throws(() => assertLocalPath(path.join(link, 'child.txt')), /junctions or symbolic links/i);
  } finally {
    if (lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link);
  }
  assert.equal(existsSync(link), false, 'The dangling junction itself is gone');
  assert.equal(assertLocalPath(path.join(owned, 'future', 'child.txt')), path.resolve(owned, 'future', 'child.txt'));
});

test('accepts a fixture root that does not exist yet so a fresh checkout needs no .tmp', () => {
  const future = path.join(project, '.tmp', 'future-fixture-' + randomUUID());
  assert.equal(existsSync(future), false);
  assertProjectFixtureRoot(future);
  assertProjectFixtureRoot(path.join(future, 'nested', 'deeper'));
  // A fresh checkout has no .tmp at all, so the deepest existing ancestor is the project root itself.
  assertProjectFixtureRoot(path.join(project, 'future-fixture-' + randomUUID(), 'nested'));
  assert.throws(() => assertProjectFixtureRoot(path.join(path.dirname(project), 'future-fixture-' + randomUUID())),
    /inside the project checkout/i);
});

test('workspace roots reject saved off-volume and volume-root entries but authorize a real project directory', t => {
  const owned = fixture(t), dataDir = path.join(owned, 'roots-data');
  mkdirSync(dataDir);
  const filename = path.join(dataDir, 'workspace-roots.json');
  for (const saved of [[offVolume('workspace')], [installationVolume()], ['relative\\workspace']]) {
    writeFileSync(filename, JSON.stringify(saved));
    assert.throws(() => new WorkspaceRoots(dataDir), /invalid/i);
  }
  const authorized = path.join(owned, 'authorized');
  mkdirSync(authorized);
  writeFileSync(filename, JSON.stringify([authorized]));
  const roots = new WorkspaceRoots(dataDir);
  assert.equal(roots.contains(path.join(authorized, 'src', 'main.ts')), true);
  assert.equal(roots.contains(path.join(authorized, '..', 'neighbor', 'file.ts')), false);
  assert.equal(roots.contains(offVolume('workspace')), false);
});

test('configuration rejects off-volume instruction paths but saves real project paths', t => {
  const owned = fixture(t), dataDir = path.join(owned, 'configuration-data');
  mkdirSync(dataDir);
  const configuration = new Configuration('http://127.0.0.1:1/provider/v1', dataDir);
  assert.throws(() => configuration.set({ mode: 'mock', globalPaths: [offVolume('global.md')] }), LOCAL_VOLUME);
  assert.throws(() => configuration.set({ mode: 'mock', skillRoots: [installationVolume()] }), LOCAL_VOLUME);
  assert.equal(existsSync(path.join(dataDir, 'configuration.json')), false, 'Rejected settings must not persist');
  const authorized = path.join(owned, 'authorized'), global = path.join(owned, 'global.md');
  mkdirSync(authorized);
  writeFileSync(global, 'Global instruction fixture.');
  const view = configuration.set({ mode: 'mock', globalPaths: [global], skillRoots: [authorized] });
  assert.deepEqual(view.globalPaths, [global]);
  assert.deepEqual(view.skillRoots, [authorized]);
});

test('backend startup rejects an off-volume project root and data outside the project before creating state', async t => {
  const owned = fixture(t), root = path.join(owned, 'project');
  mkdirSync(root);
  await assert.rejects(startBackend({ projectRoot: root, dataDir: offVolume('data') }), LOCAL_VOLUME);
  const uncreated = path.join(root, 'uncreated-data');
  await assert.rejects(startBackend({ projectRoot: offVolume('project'), dataDir: uncreated }), LOCAL_VOLUME);
  assert.equal(existsSync(uncreated), false);
  const outside = path.join(owned, 'outside-project-data');
  await assert.rejects(startBackend({ projectRoot: root, dataDir: outside }), /inside the configured project/);
  assert.equal(existsSync(outside), false);
  assert.deepEqual(readdirSync(root), [], 'Rejected startup must not create state');
});

test('instruction loading rejects off-volume configuration and loads real project paths', async t => {
  const owned = fixture(t), workspace = path.join(owned, 'workspace');
  mkdirSync(workspace);
  await assert.rejects(loadInstructions({ workspace, globalPaths: [offVolume('global.md')], skillRoots: [], query: '' }), LOCAL_VOLUME);
  const global = path.join(owned, 'global.md');
  writeFileSync(global, 'Local instruction fixture text.');
  const loaded = await loadInstructions({ workspace, globalPaths: [global], skillRoots: [], query: '' });
  assert.ok(loaded.sources.some(source => source.kind === 'global' && source.path.toLowerCase() === realpathSync(global).toLowerCase()));
  assert.ok(loaded.text.includes('Local instruction fixture text.'));
});
