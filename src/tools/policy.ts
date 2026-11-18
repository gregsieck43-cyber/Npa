import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const forbiddenNames = /^(?:api\.txt|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i;
const protectedParts = new Set(['.git', '.aws', '.codex', '.agents', '.tools', '.deps', '.cache', '.tmp', 'node_modules']);
export class ToolPolicyError extends Error { constructor(message: string) { super(message); this.name = 'ToolPolicyError'; } }
export function isForbiddenRelative(relative: string): boolean {
  return relative.split(/[\\/]/).some(part => forbiddenNames.test(part) || protectedParts.has(part.toLowerCase()) || /[:]|[. ]$/.test(part) || /^(?:con|nul|prn|aux|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function digestValue(value: unknown): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function inside(root: string, target: string): boolean { const relative = path.relative(root, target); return !relative.startsWith('..') && !path.isAbsolute(relative); }
/** One path boundary: lexical containment + forbidden names + every ancestor's real path. */
export async function resolveProjectPath(workspace: string, requested = '.', allowMissing = false): Promise<string> {
  const root = await realpath(workspace);
  const target = path.resolve(root, requested);
  const relative = path.relative(root, target);
  if (!inside(root, target) || isForbiddenRelative(relative)) throw new ToolPolicyError('Path is outside the workspace or belongs to a protected credential/kernel area.');
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !inside(root, await realpath(cursor))) throw new ToolPolicyError('Symbolic links and junctions are not tool-accessible.');
    } catch (error: any) { if (allowMissing && error.code === 'ENOENT') break; throw error; }
  }
  return target;
}
