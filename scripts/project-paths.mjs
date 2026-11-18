// Shared project-location rules for the build, packaging and test scripts.
// The checkout has moved between drives, so the project root is derived from this file's own
// location instead of a hard-coded volume. Every recursive delete must also prove that it
// targets one exact generated directory below that root before the removal runs.
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const GENERATED_ROOTS = ['build', 'release', '.tmp'];

export function projectRoot() {
  const root = path.resolve(import.meta.dirname, '..');
  const manifest = path.join(root, 'package.json');
  if (!existsSync(manifest)) throw new Error(`Project root ${root} has no package.json.`);
  const name = JSON.parse(readFileSync(manifest, 'utf8')).name;
  if (name !== 'npn-gamma-agent') throw new Error(`Project root ${root} is not npn-gamma-agent (found ${JSON.stringify(name)}).`);
  return root;
}

function samePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The root plus every existing ancestor up to the target; stops at the first missing entry.
 * A dangling junction counts as existing (existsSync would report it missing), so it stays in the
 * chain for the lstat check in assertProjectPath instead of being mistaken for a future path.
 */
function existingPathChain(root, target) {
  const chain = [root];
  let cursor = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (lstatSync(cursor, { throwIfNoEntry: false }) === undefined) break;
    chain.push(cursor);
  }
  return chain;
}

/** Absolute path inside the project root; rejects volume roots, UNC/device paths and the root itself. */
export function assertProjectPath(target) {
  if (typeof target !== 'string' || target.length === 0) throw new Error('Project paths must be non-empty strings.');
  if (/^[\\/]{2}/.test(target)) throw new Error(`Project path cannot be a UNC or device path: ${target}`);
  if (!path.isAbsolute(target)) throw new Error(`Project path must be absolute: ${target}`);
  const resolved = path.resolve(target);
  if (path.parse(resolved).root === resolved) throw new Error(`Project path cannot be a volume root: ${resolved}`);
  const root = projectRoot();
  if (samePath(resolved, root)) throw new Error(`Project path must be inside ${root}, not the project root itself.`);
  if (!isInside(root, resolved)) throw new Error(`Project path must stay inside ${root}: ${resolved}`);
  for (const cursor of existingPathChain(root, resolved)) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Project path must not use junctions or symbolic links: ${cursor}`);
  }
  return resolved;
}

/**
 * Exact generated directory below the project root, with no junction or symbolic link anywhere
 * on the path. `segments` is the relative directory list, for example ['build', 'ide-extension'].
 */
export function assertGeneratedPath(target, segments) {
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('Generated paths require at least one segment.');
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment.length === 0 || segment === '.' || segment === '..' || /[\\/:]/.test(segment)) {
      throw new Error(`Invalid generated path segment: ${JSON.stringify(segment)}`);
    }
  }
  if (!GENERATED_ROOTS.includes(segments[0])) throw new Error(`Generated paths must start with build, release or .tmp, not ${JSON.stringify(segments[0])}.`);
  const root = projectRoot();
  const expected = path.join(root, ...segments);
  const resolved = assertProjectPath(target);
  if (!samePath(resolved, expected)) throw new Error(`Refusing ${resolved}: expected the exact generated path ${expected}.`);
  let cursor = root;
  if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing ${resolved}: ${cursor} is a junction or symbolic link.`);
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing ${resolved}: ${cursor} is a junction or symbolic link.`);
  }
  return resolved;
}

/** Validated recursive delete of one generated directory. */
export function removeGeneratedPath(target, segments) {
  const resolved = assertGeneratedPath(target, segments);
  rmSync(resolved, { recursive: true, force: true });
  return resolved;
}
