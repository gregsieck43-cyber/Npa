import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { assertProjectFixtureRoot, projectRoot } from './project-boundary.js';

interface ProjectPaths {
  assertProjectPath(target: string): string;
  assertGeneratedPath(target: string, segments: string[]): string;
}

const project = projectRoot(), tempRoot = path.join(project, '.tmp');
// scripts/project-paths.mjs is plain ESM outside the TypeScript program, so it is imported at run time.
const script = pathToFileURL(path.join(project, 'scripts', 'project-paths.mjs')).href;
const { assertProjectPath, assertGeneratedPath } = (await import(script)) as ProjectPaths;

function fixture(t: TestContext): string {
  mkdirSync(tempRoot, { recursive: true });
  const owned = mkdtempSync(path.join(tempRoot, 'project-paths-'));
  assertProjectFixtureRoot(owned);
  t.after(() => {
    const relative = path.relative(tempRoot, owned);
    assert.ok(relative.startsWith('project-paths-') && !relative.includes(path.sep) && !path.isAbsolute(relative),
      'Only the owned project-paths fixture may be removed.');
    assert.equal(lstatSync(owned, { throwIfNoEntry: false })?.isSymbolicLink(), false, 'The fixture root itself must not be a link.');
    rmSync(owned, { recursive: true, force: true });
    assert.equal(existsSync(owned), false);
  });
  return owned;
}

test('project paths reject a dangling junction and accept missing paths inside the checkout', t => {
  const owned = fixture(t), missing = path.join(owned, 'missing-target'), link = path.join(owned, 'dangling');
  symlinkSync(missing, link, 'junction');
  try {
    assert.equal(existsSync(link), false, 'A dangling junction is reported as missing by existsSync');
    assert.throws(() => assertProjectPath(link), /junctions or symbolic links/i);
    assert.throws(() => assertProjectPath(path.join(link, 'child.txt')), /junctions or symbolic links/i);
  } finally {
    if (lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link);
  }
  assert.equal(existsSync(link), false, 'The dangling junction itself is gone');
  const existing = path.join(project, 'scripts', 'project-paths.mjs');
  assert.equal(assertProjectPath(existing), path.resolve(existing));
  const future = path.join(owned, 'future', 'child.txt');
  assert.equal(assertProjectPath(future), path.resolve(future));
  assert.throws(() => assertProjectPath(path.join(path.dirname(project), 'outside-' + path.basename(owned))), /inside/i);
});

test('generated paths refuse a dangling junction at the exact generated directory and accept a missing one', () => {
  const name = 'project-paths-generated-' + randomUUID();
  const generated = path.join(tempRoot, name), missing = path.join(tempRoot, name + '-missing');
  assertProjectFixtureRoot(generated);
  mkdirSync(tempRoot, { recursive: true });
  symlinkSync(missing, generated, 'junction');
  try {
    assert.equal(existsSync(generated), false, 'A dangling junction is reported as missing by existsSync');
    assert.throws(() => assertGeneratedPath(generated, ['.tmp', name]), /junctions or symbolic links/i);
  } finally {
    if (lstatSync(generated, { throwIfNoEntry: false })) unlinkSync(generated);
  }
  assert.equal(existsSync(generated), false, 'The dangling junction itself is gone');
  const future = 'project-paths-future-' + randomUUID();
  assert.equal(assertGeneratedPath(path.join(tempRoot, future), ['.tmp', future]), path.resolve(tempRoot, future));
});
