import { lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The disk volume that hosts this running copy of the application. It is derived from this
 * module's own location (source checkout, compiled build or packaged app), so the installation
 * can move to another drive without code changes. Nothing can reconfigure it at runtime.
 */
let cachedVolume: string | undefined;
function installationFile(): string {
  // Native ESM (tsc output run directly by Node) exposes import.meta.url. esbuild's CommonJS
  // bundles (desktop main and the IDE extension) empty import.meta and expose __filename instead.
  const meta = import.meta as ImportMeta & { url?: string };
  if (typeof meta.url === 'string' && meta.url.startsWith('file:')) return fileURLToPath(meta.url);
  return typeof __filename === 'string' ? __filename : '';
}
export function installationVolume(): string {
  if (cachedVolume === undefined) {
    const file = installationFile();
    cachedVolume = file ? path.parse(path.resolve(file)).root : '';
    if (!cachedVolume) throw new Error('Cannot determine the volume that hosts this installation.');
  }
  return cachedVolume;
}

/** Explicit absolute path on the installation volume: not another drive, a UNC share, a device path or a volume root. */
export function isLocalPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || value.includes('\0')) return false;
  if (!path.isAbsolute(value) || /^[\\/]{2}/.test(value)) return false;
  const absolute = path.resolve(value), volume = installationVolume();
  if (absolute.toLowerCase() === volume.toLowerCase()) return false;
  return path.parse(absolute).root.toLowerCase() === volume.toLowerCase();
}

/** Validates a path before application writes, discovery reads and workspace authorization follow it. */
export function assertLocalPath(target: string, label = 'Application data and workspace roots'): string {
  if (!isLocalPath(target)) throw new Error(`${label} must be an absolute local path on the volume that hosts this installation.`);
  const absolute = path.resolve(target);
  let cursor = path.parse(absolute).root;
  // existsSync is false for a dangling junction, so every segment is examined with lstat instead:
  // a link whose target is missing must still be rejected rather than treated as a future path.
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stats = lstatSync(cursor, { throwIfNoEntry: false });
    if (!stats) break;
    if (stats.isSymbolicLink()) throw new Error(`${label} must not use junctions or symbolic links.`);
  }
  return absolute;
}
