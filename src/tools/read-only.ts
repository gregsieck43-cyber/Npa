import { createReadStream } from 'node:fs';
import { lstat, opendir, readFile, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { isForbiddenRelative, resolveProjectPath, ToolPolicyError } from './policy.js';

const OUTPUT_BYTES = 32768;
function limit(value: unknown, fallback: number, maximum: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new ToolPolicyError(`Limit must be an integer from 1 to ${maximum}.`);
  return result;
}
const inside = (root: string, value: string) => { const relative = path.relative(root, value); return !relative.startsWith('..') && !path.isAbsolute(relative); };

export async function prepareReadOnly(workspace: string, name: string, input: Record<string, unknown>) {
  if (name === 'search_text') {
    if (typeof input.query !== 'string' || !input.query.length || input.query.length > 512 || /[\r\n\0]/.test(input.query)) throw new ToolPolicyError('Search requires a literal single-line query of 1 to 512 characters.');
    const paths = input.paths ?? ['.'];
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 16 || paths.some(value => typeof value !== 'string')) throw new ToolPolicyError('Search accepts 1 to 16 explicit workspace paths.');
    const resolved = await Promise.all((paths as string[]).map(value => resolveProjectPath(workspace, value)));
    return { arguments: { query: input.query, paths: resolved.map(value => path.relative(workspace, value) || '.'), caseSensitive: input.caseSensitive !== false, limit: limit(input.limit, 40, 100) }, resources: resolved };
  }
  if (!['status', 'diff', 'log', 'show'].includes(String(input.operation))) throw new ToolPolicyError('Git query operation must be status, diff, log or show.');
  if (input.revision !== undefined && (typeof input.revision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/@~^{}-]{0,127}$/.test(input.revision))) throw new ToolPolicyError('Git revision must be a fixed revision expression, not an option or object path.');
  if (['diff', 'show'].includes(String(input.operation)) && (typeof input.path !== 'string' || !input.path)) throw new ToolPolicyError('Git diff/show requires an explicit workspace file path.');
  const target = await resolveProjectPath(workspace, typeof input.path === 'string' ? input.path : '.', true);
  if (['diff', 'show'].includes(String(input.operation))) {
    const info = await stat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (info && !info.isFile()) throw new ToolPolicyError('Git diff/show requires one workspace file, not a directory.');
  }
  return { arguments: { operation: input.operation, path: (path.relative(workspace, target) || '.').replace(/\\/g, '/'),
    ...(input.revision === undefined ? {} : { revision: input.revision }), limit: limit(input.limit, 100, 500) }, resources: [target] };
}

/** Literal search: bounded directory traversal and streaming fragments even for a giant single line. */
export async function searchText(workspace: string, args: Record<string, unknown>) {
  const query = String(args.query), needle = args.caseSensitive ? query : query.toLowerCase();
  const matches: { path: string; line: number; text: string; truncated: boolean }[] = [];
  let scannedBytes = 0, scannedFiles = 0, outputBytes = 256, truncated = false;
  const maximum = Number(args.limit);
  async function scan(filename: string) {
    if (++scannedFiles > 2000) { truncated = true; return; }
    let buffer = '', line = 1, found = false;
    const inspect = (text: string, partial: boolean) => {
      if (found) return;
      const index = (args.caseSensitive ? text : text.toLowerCase()).indexOf(needle);
      if (index < 0) return;
      const excerpt = text.slice(Math.max(0, index - 100), index + query.length + 200);
      const match = { path: path.relative(workspace, filename), line, text: excerpt, truncated: partial || excerpt.length < text.length };
      const bytes = Buffer.byteLength(JSON.stringify(match)) + 1;
      if (outputBytes + bytes > OUTPUT_BYTES - 512) { truncated = true; return; }
      outputBytes += bytes; matches.push(match); found = true;
      if (matches.length >= maximum) truncated = true;
    };
    for await (const chunk of createReadStream(filename, { encoding: 'utf8', highWaterMark: 16384 })) {
      scannedBytes += Buffer.byteLength(chunk as string);
      if (scannedBytes > 32 * 1024 * 1024) { truncated = true; break; }
      if ((chunk as string).includes('\0')) break;
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        inspect(buffer.slice(0, newline).replace(/\r$/, ''), false);
        buffer = buffer.slice(newline + 1); line++; found = false;
        if (truncated) break;
      }
      if (truncated) break;
      if (buffer.length > 4096) { inspect(buffer, true); buffer = buffer.slice(-Math.max(query.length - 1, 1)); }
      if (truncated) break;
    }
    if (!truncated && buffer) inspect(buffer, false);
  }
  async function walk(requested: string, depth = 0): Promise<void> {
    if (truncated) return;
    if (depth > 64) { truncated = true; return; }
    const filename = await resolveProjectPath(workspace, requested);
    const info = await lstat(filename);
    if (info.isFile()) { await scan(filename); return; }
    if (!info.isDirectory()) return;
    for await (const entry of await opendir(filename)) {
      const relative = path.relative(workspace, path.join(filename, entry.name));
      if (!entry.isSymbolicLink() && !isForbiddenRelative(relative)) await walk(relative, depth + 1);
      if (truncated) break;
    }
  }
  for (const requested of args.paths as string[]) { await walk(requested); if (truncated) break; }
  return { matches, scannedFiles, scannedBytes, truncated, ...(truncated ? { continuation: 'Narrow paths/query or increase the result limit to inspect additional matches.' } : {}) };
}

async function gitExecutable(workspace: string) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory || inside(workspace, path.resolve(directory))) continue;
    const candidate = path.join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'git.exe' : 'git');
    try { const resolved = await realpath(candidate); if (!inside(workspace, resolved) && (await stat(resolved)).isFile()) return resolved; }
    catch (error: any) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new ToolPolicyError('Git is not available on the trusted runtime search path.');
}
async function localRepository(workspace: string) {
  const root = await realpath(workspace), marker = path.join(root, '.git');
  const info = await lstat(marker).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    // Only an absent marker in a still-existing workspace is a non-repository result.
    // Missing/damaged gitdir targets and other I/O failures remain errors below.
    if (!(await stat(root)).isDirectory()) throw error;
    return undefined;
  });
  if (!info) return undefined;
  if (info.isSymbolicLink()) throw new ToolPolicyError('Git metadata links outside the workspace are not available.');
  let directory = marker;
  if (info.isFile()) {
    if (info.size > 4096) throw new ToolPolicyError('Invalid Git directory marker.');
    const match = /^gitdir:\s*(.+)\s*$/i.exec((await readFile(marker, 'utf8')).trim());
    if (!match) throw new ToolPolicyError('Invalid Git directory marker.');
    directory = path.resolve(root, match[1]!);
  }
  directory = await realpath(directory);
  if (!inside(root, directory)) throw new ToolPolicyError('Git metadata must stay inside the selected workspace. Select its repository root.');
  const common = await readFile(path.join(directory, 'commondir'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (common && !inside(root, await realpath(path.resolve(directory, common.trim())))) throw new ToolPolicyError('Git common metadata is outside the workspace.');
  return { root, directory };
}

/** Fixed argv only; no shell, Git aliases, hooks, external diff, textconv, filters or network fetches. */
export async function gitQuery(workspace: string, args: Record<string, unknown>) {
  const repository = await localRepository(workspace);
  if (!repository) return { output: 'Not a Git repository: the selected workspace has no .git metadata.', exitCode: 128, truncated: false };
  const { root, directory } = repository, executable = await gitExecutable(root);
  const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env = { ...process.env, GIT_DIR: directory, GIT_WORK_TREE: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullPath,
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1' };
  const base = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', `core.hooksPath=${nullPath}`,
    '-c', 'diff.external=', '-c', `core.attributesFile=${nullPath}`, '-c', 'credential.helper=', '-c', 'core.preloadIndex=false'];
  const capture = (argv: string[], maxLines: number) => new Promise<{ output: string; exitCode: number | null; truncated: boolean }>((resolve, reject) => {
    const child = spawn(executable, [...base, ...argv], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, lines = 0, truncated = false;
    const append = (chunk: string) => {
      if (truncated) return;
      for (const segment of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        const remaining = OUTPUT_BYTES - bytes;
        if (remaining <= 0 || lines >= maxLines) { truncated = true; child.kill(); return; }
        let piece = segment;
        if (Buffer.byteLength(piece) > remaining) {
          let low = 0, high = piece.length;
          while (low < high) { const mid = Math.ceil((low + high) / 2); if (Buffer.byteLength(piece.slice(0, mid)) <= remaining) low = mid; else high = mid - 1; }
          piece = piece.slice(0, low); truncated = true;
        }
        output += piece; bytes += Buffer.byteLength(piece); if (piece.endsWith('\n')) lines++;
        if (truncated) { child.kill(); return; }
      }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.once('error', reject); child.once('close', exitCode => resolve({ output, exitCode, truncated }));
  });
  // Git's read commands can invoke configured clean/process filters while refreshing a dirty index.
  const filters = await capture(['config', '--includes', '--name-only', '--get-regexp', '^filter\\.'], 256);
  if (filters.truncated) throw new ToolPolicyError('Repository filter configuration exceeds the bounded read-query allowance.');
  const names = new Set(filters.output.split(/\r?\n/).map(key => /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(key)?.[1]).filter((value): value is string => Boolean(value)));
  for (const name of names) for (const [key, value] of [['clean', ''], ['smudge', ''], ['process', ''], ['required', 'false']]) base.push('-c', `filter.${name}.${key}=${value}`);
  const file = String(args.path), revision = String(args.revision ?? 'HEAD'), count = Number(args.limit);
  const argv = args.operation === 'status' ? ['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all', '--', file]
    : args.operation === 'log' ? ['log', '--no-decorate', '--date=iso-strict', '--format=%h %ad %s', `--max-count=${count}`, revision, '--', file]
    : args.operation === 'diff' ? ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', ...(args.revision ? [revision] : []), '--', file]
    : ['show', '--no-ext-diff', '--no-textconv', '--no-color', `${revision}:${file}`];
  return capture(argv, count);
}
