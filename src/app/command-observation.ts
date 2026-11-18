import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveProjectPath } from '../tools/policy.js';

export interface FileObservation { path: string; sha256?: string | null; status: 'known' | 'unavailable' | 'too_large' }
/** Candidate-only advisory comparison: no repository walk, no attribution, no claim of atomic external CAS. */
export async function observeCommandFiles(workspace: string, candidates: string[]): Promise<FileObservation[]> {
  const result: FileObservation[] = [];
  for (const candidate of [...new Set(candidates)].slice(0, 32)) {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const target = await resolveProjectPath(workspace, candidate, true);
      try { file = await open(target, 'r'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { result.push({ path: candidate, sha256: null, status: 'known' }); continue; } throw error; }
      const before = await file.stat();
      if (!before.isFile() || before.nlink > 1) { result.push({ path: candidate, status: 'unavailable' }); continue; }
      if (before.size > 1024 * 1024) { result.push({ path: candidate, status: 'too_large' }); continue; }
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let bytes = 0;
      for (;;) { const read = await file.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; bytes += read.bytesRead; if (bytes > 1024 * 1024) break; hash.update(buffer.subarray(0, read.bytesRead)); }
      const after = await file.stat();
      result.push(bytes === before.size && bytes === after.size && before.mtimeMs === after.mtimeMs ? { path: candidate, sha256: hash.digest('hex'), status: 'known' } : { path: candidate, status: 'unavailable' });
    } catch { result.push({ path: candidate, status: 'unavailable' }); }
    finally { await file?.close().catch(() => undefined); }
  }
  return result;
}
export function observedChanges(before: FileObservation[], after: FileObservation[]) {
  return before.flatMap(left => { const right = after.find(item => item.path === left.path); return left.status === 'known' && right?.status === 'known' && left.sha256 !== right.sha256 ? [{ path: left.path, before: left.sha256, after: right.sha256 }] : []; });
}

/** Unknown in either sample is never reported as a known unchanged file. */
export function observationCoverage(before: FileObservation[], after: FileObservation[]) {
  const comparable = before.filter(left => left.status === 'known' && after.some(right => right.path === left.path && right.status === 'known')).length;
  return { observed: before.length, comparable, unavailable: before.length - comparable,
    beforeUnavailable: before.filter(item => item.status !== 'known').length,
    afterUnavailable: before.filter(left => !after.some(right => right.path === left.path && right.status === 'known')).length };
}
