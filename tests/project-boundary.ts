import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { installationVolume, isLocalPath } from '../src/app/local-paths.js';

/** The real project boundary is this checkout, not a drive letter from the original workstation. */
export function projectRoot(): string {
  const root = path.resolve(process.cwd());
  assert.ok(existsSync(path.join(root, 'tsconfig.json')), 'Tests must run from the NPN-Gamma source checkout.');
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name, 'npn-gamma-agent',
    'Tests must run from the NPN-Gamma Agent project root.');
  return root;
}

/** Paths under test must stay inside the checkout instead of any hard-coded volume. */
export function assertInsideProject(value: string, label: string): string {
  const root = projectRoot(), absolute = path.resolve(value), relative = path.relative(root, absolute);
  assert.ok(relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `${label} must stay inside the project checkout: ${absolute}`);
  return absolute;
}

/** Real path of an existing fixture ancestor; a dangling junction is an assertion failure, not a skip. */
function realFixtureAncestor(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    // lstat found the entry but realpath cannot follow it: a dangling junction or symbolic link.
    assert.fail(`Test fixture root must not use junctions or symbolic links: ${candidate}`);
  }
}

/**
 * Temporary fixtures stay inside the checkout, on the volume that actually hosts this installation.
 * The fixture root itself may not exist yet (a fresh checkout has no .tmp), so only the deepest
 * existing ancestor is canonicalized; the missing remainder stays lexically inside the checkout.
 */
export function assertProjectFixtureRoot(fixtureRoot: string): void {
  const absolute = assertInsideProject(fixtureRoot, 'Test fixture root');
  let ancestor = absolute;
  while (lstatSync(ancestor, { throwIfNoEntry: false }) === undefined) {
    const parent = path.dirname(ancestor);
    assert.notEqual(parent, ancestor, `Test fixture root has no existing ancestor inside the project checkout: ${absolute}`);
    ancestor = parent;
  }
  const real = realFixtureAncestor(ancestor);
  assert.equal(path.parse(real).root.toLowerCase(), installationVolume().toLowerCase(),
    'Test fixtures must stay on the volume that hosts this installation.');
  assert.equal(isLocalPath(real), true, 'Test fixtures must be real absolute paths on the installation volume.');
  const resolved = path.relative(projectRoot(), real);
  // The deepest existing ancestor can be the project root itself when every fixture segment below
  // it is still missing (a fresh checkout has no .tmp); those missing segments are lexically inside.
  assert.ok(resolved === '' || (resolved !== '..' && !resolved.startsWith(`..${path.sep}`) && !path.isAbsolute(resolved)),
    `Test fixture root must resolve inside the project checkout: ${real}`);
}
