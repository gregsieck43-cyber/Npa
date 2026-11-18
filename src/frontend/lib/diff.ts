import type { DiffLine } from '../api/types';

/** 基于 LCS 的行级 Diff，用于提示词版本对比与请求 Body 对比（输入规模为单个提示词/请求，O(n·m) 可接受）。 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n'), b = after.split('\n');
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: 'ctx', oldNo: i + 1, newNo: j + 1, text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { out.push({ kind: 'del', oldNo: i + 1, text: a[i] }); i++; }
    else { out.push({ kind: 'add', newNo: j + 1, text: b[j] }); j++; }
  }
  while (i < a.length) { out.push({ kind: 'del', oldNo: i + 1, text: a[i] }); i++; }
  while (j < b.length) { out.push({ kind: 'add', newNo: j + 1, text: b[j] }); j++; }
  return out;
}

export function diffStats(lines: DiffLine[]) {
  return { additions: lines.filter(line => line.kind === 'add').length, deletions: lines.filter(line => line.kind === 'del').length };
}
