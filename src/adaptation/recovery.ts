import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface RecoveryFile { path: string; sha256: string; size: number }
export interface RecoveryArchive { format: 'zip'; path: 'bundle.zip'; sha256: string; size: number }
export interface RecoveryManifest {
  schemaVersion: 1 | 2;
  releaseVersion: string;
  target: 'resources/app' | 'package';
  units?: string[];
  files: RecoveryFile[];
  archive?: RecoveryArchive;
}
export interface RecoveryVerification { valid: boolean; fileCount: number; errors: string[] }

/** Packaging passes only the clean immutable app payload, never the data directory. */
export function buildRecoveryManifest(appRoot: string, releaseVersion: string, target: RecoveryManifest['target'] = 'resources/app'): RecoveryManifest {
  const files = listPayloadFiles(resolve(appRoot), '', target);
  const units = target === 'package' ? [...new Set(files.map(path => path.startsWith('resources/') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0]))].sort() : undefined;
  return { schemaVersion: 1, releaseVersion, target, ...(units ? { units } : {}), files: files.map(path => {
    assertPayloadPath(path);
    const bytes = readFileSync(join(appRoot, path));
    return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }) };
}

export function verifyRecoveryPayload(appRoot: string, manifest: RecoveryManifest): RecoveryVerification {
  const errors: string[] = [];
  if (![1, 2].includes(manifest.schemaVersion) || !['resources/app', 'package'].includes(manifest.target) || !manifest.releaseVersion ||
      !Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { valid: false, fileCount: 0, errors: ['Unsupported or empty recovery manifest.'] };
  }
  if (manifest.target === 'package') {
    const units = manifest.units;
    if (!Array.isArray(units) || units.length === 0) return { valid: false, fileCount: 0, errors: ['Package recovery requires static swap units.'] };
    for (const unit of units) {
      assertPayloadPath(unit);
      if (unit === 'resources' || unit.toLowerCase().startsWith('resources/recovery') || !manifest.files.some(file => file.path === unit || file.path.startsWith(`${unit}/`))) {
        errors.push(`Invalid package swap unit: ${unit}`);
      }
    }
    if (new Set(units).size !== units.length || units.some(unit => units.some(other => other !== unit && unit.startsWith(`${other}/`)))) errors.push('Package swap units duplicate or overlap.');
    for (const file of manifest.files) if (!units.some(unit => file.path === unit || file.path.startsWith(`${unit}/`))) errors.push(`File has no package swap unit: ${file.path}`);
    if (!manifest.files.some(file => file.path === 'NPN-Gamma.exe') || !manifest.files.some(file => file.path === 'resources/runtime/node.exe') ||
        !manifest.files.some(file => file.path.startsWith('resources/app/'))) errors.push('Package recovery must include the desktop executable, bundled runtime and application.');
  }
  const seen = new Set<string>();
  for (const file of manifest.files) {
    assertPayloadPath(file.path);
    if (seen.has(file.path.toLowerCase())) errors.push(`Duplicate manifest path: ${file.path}`);
    seen.add(file.path.toLowerCase());
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) {
      errors.push(`Invalid file identity: ${file.path}`);
      continue;
    }
    const target = join(appRoot, file.path);
    if (!existsSync(target)) { errors.push(`Missing file: ${file.path}`); continue; }
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink()) { errors.push(`Non-regular file: ${file.path}`); continue; }
    const bytes = readFileSync(target);
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      errors.push(`Hash or size mismatch: ${file.path}`);
    }
  }
  const actual = listPayloadFiles(resolve(appRoot), '', manifest.target);
  for (const path of actual) if (!seen.has(path.toLowerCase())) errors.push(`Unexpected payload file: ${path}`);
  return { valid: errors.length === 0, fileCount: manifest.files.length, errors };
}

/** Bind the compressed container; restore separately verifies every decompressed file before activation. */
export function withRecoveryArchive(manifest: RecoveryManifest, archivePath: string): RecoveryManifest {
  const bytes = readFileSync(archivePath);
  return { ...manifest, schemaVersion: 2, archive: { format: 'zip', path: 'bundle.zip', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') } };
}

export function verifyRecoveryArchive(recoveryRoot: string, manifest: RecoveryManifest): RecoveryVerification {
  const archive = manifest.archive;
  if (manifest.schemaVersion !== 2 || !archive || archive.format !== 'zip' || archive.path !== 'bundle.zip' ||
      !/^[a-f0-9]{64}$/.test(archive.sha256) || !Number.isSafeInteger(archive.size) || archive.size <= 0 ||
      !Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { valid: false, fileCount: 0, errors: ['Unsupported recovery archive identity.'] };
  }
  const filename = join(recoveryRoot, archive.path);
  const info = lstatSync(filename, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.size !== archive.size) {
    return { valid: false, fileCount: 0, errors: ['Missing, non-regular or size-mismatched recovery archive.'] };
  }
  const valid = createHash('sha256').update(readFileSync(filename)).digest('hex') === archive.sha256;
  return { valid, fileCount: manifest.files.length, errors: valid ? [] : ['Recovery archive SHA-256 mismatch.'] };
}

function listPayloadFiles(root: string, relative = '', target: RecoveryManifest['target'] = 'resources/app'): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (target === 'package' && (path === 'data' || path === 'resources/recovery')) continue;
    assertPayloadPath(path);
    if (entry.isSymbolicLink()) throw new Error(`Recovery payload cannot contain links: ${path}`);
    if (entry.isDirectory()) result.push(...listPayloadFiles(root, path, target));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Recovery payload cannot contain special files: ${path}`);
  }
  return result.sort();
}
function assertPayloadPath(path: string): void {
  if (typeof path !== 'string' || !path || /[\\:]/.test(path) || path.startsWith('/') ||
      path.split('/').some(part => !part || /[<>"|?*\x00-\x1f]|[. ]$/.test(part) || /^(?:con|nul|prn|aux|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Recovery manifest path must be relative and stay inside the app payload.');
  }
  if (path.split('/').some(part => /^(?:api\.txt|\.env(?:\..*)?|\.git|\.cache|\.tmp|\.tools|data|credentials(?:\..*)?|secrets(?:\..*)?)$/i.test(part) || /\.(?:pem|key)$/i.test(part))) {
    throw new Error(`Credential, mutable data or build cache is forbidden in recovery payload: ${path}`);
  }
}
