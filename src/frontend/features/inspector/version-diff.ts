import { lineDiff } from '../../lib/diff';

/** LCS allocates O(rows × columns). Refuse excessive work before allocating its table. */
export function versionDiff(before: string, after: string) {
  if (before.length + after.length > 512 * 1024 || (before.split('\n').length + 1) * (after.split('\n').length + 1) > 2_000_000) return undefined;
  return lineDiff(before, after);
}
