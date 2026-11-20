import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { WorkspaceRoots, pathWithin, type WorkspaceRootRecord } from '../app/workspace-roots.js';
import { isForbiddenRelative } from '../tools/policy.js';
import {
  ProductError, invalid, notFound, type Diagnostic, type FileDiff, type FileNode,
  type ProductRuntime, type ProjectView, type SearchHit, type SearchQuery, type SourceControlView, type TerminalResult,
  type WorkspaceCommitResult, type WorkspaceDomain, type WorkspaceWriteResult,
} from './shared.js';

const MAX_TREE_DEPTH = 8;
const MAX_TREE_NODES = 2000;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILES = 2000;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const MAX_SEARCH_DEPTH = 10;
const MAX_DIAGNOSTIC_FILES = 50;
const MAX_DIAGNOSTIC_FILE_BYTES = 512 * 1024;
const MAX_DIAGNOSTICS = 200;
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const MAX_TERMINAL_OUTPUT = 128 * 1024;
const TERMINAL_TIMEOUT_MS = 30_000;
const WALK_FILE_LIMIT = 2000;

/** 仅使用 shared.ts 暴露的 DTO，内部数组元素类型由前端契约推导。 */
type DiffHunk = FileDiff['hunks'][number];
type FileChange = SourceControlView['changes'][number];

interface GitResult { status: number; stdout: string; stderr: string }
interface StatusEntry { path: string; status: 'M' | 'A' | 'D' | 'R' | '?' }
interface DiffDetails { hunks: DiffHunk[]; additions: number; deletions: number }
interface TypeScriptDiagnostic { start?: number; category: number; messageText: unknown }
interface SourceFileLike {
  parseDiagnostics?: readonly TypeScriptDiagnostic[];
  getLineAndCharacterOfPosition(position: number): { line: number; character: number };
}
interface TypeScriptModule {
  ScriptTarget: { Latest: number };
  ScriptKind: { TS: number; TSX: number; JS: number; JSX: number };
  DiagnosticCategory: { Error: number; Warning: number };
  createSourceFile(name: string, text: string, target: number, setParentNodes: boolean, kind: number): SourceFileLike;
  flattenDiagnosticMessageText(messageText: unknown, newLine: string): string;
}

/** 仍在运行的人工终端；撤销项目或退出前必须等待它真正停下。 */
interface RunningTerminal { stop(): Promise<void> }

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function samePath(left: string, right: string): boolean {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function toPosix(value: string): string { return value.split(path.sep).join('/'); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** porcelain v1 -z: 每个条目是 "XY path\0"；重命名/复制条目后面紧跟原始路径。 */
function parsePorcelain(output: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  let cursor = 0;
  while (cursor < output.length) {
    const end = output.indexOf('\0', cursor);
    if (end < 0) break;
    const record = output.slice(cursor, end);
    cursor = end + 1;
    if (record.length < 4) continue;
    const code = record.slice(0, 2), file = record.slice(3);
    if (code[0] === 'R' || code[0] === 'C') {
      const originalEnd = output.indexOf('\0', cursor);
      cursor = originalEnd < 0 ? output.length : originalEnd + 1;
    }
    entries.push({ path: file, status: changeStatus(code) });
  }
  return entries;
}

function changeStatus(code: string): StatusEntry['status'] {
  if (code === '??') return '?';
  if (code.includes('R') || code.includes('C')) return 'R';
  if (code.includes('D')) return 'D';
  if (code.includes('A')) return 'A';
  return 'M';
}

function fileNodeChange(status: StatusEntry['status']): FileNode['change'] | undefined {
  return status === 'M' || status === 'A' || status === 'D' ? status : undefined;
}

function diffStatus(status: StatusEntry['status']): FileDiff['status'] {
  if (status === '?') return 'added';
  if (status === 'A') return 'added';
  if (status === 'D') return 'deleted';
  if (status === 'R') return 'renamed';
  return 'modified';
}

/** 解析统一 diff 的 hunk；行号来自 hunk 头，additions/deletions 是真实行数。 */
function parseUnifiedDiff(text: string): DiffDetails {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined, oldLine = 0, newLine = 0, additions = 0, deletions = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[3]);
        current = { header: line, lines: [] };
        hunks.push(current);
      } else current = undefined;
      continue;
    }
    if (!current) continue;
    const kind = line.charAt(0);
    if (kind === ' ') {
      current.lines.push({ kind: 'ctx', oldNo: oldLine, newNo: newLine, text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
    } else if (kind === '+') {
      current.lines.push({ kind: 'add', newNo: newLine, text: line.slice(1) });
      newLine += 1;
      additions += 1;
    } else if (kind === '-') {
      current.lines.push({ kind: 'del', oldNo: oldLine, text: line.slice(1) });
      oldLine += 1;
      deletions += 1;
    }
  }
  return { hunks, additions, deletions };
}

/** 未跟踪文件的内容来自磁盘（git 还没有它的历史），hunk 从第 1 行开始。 */
function addedFileDiff(content: string): DiffDetails {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const body = lines.map((text, index) => ({ kind: 'add' as const, newNo: index + 1, text }));
  const hunks: DiffHunk[] = lines.length ? [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: body }] : [];
  return { hunks, additions: lines.length, deletions: 0 };
}

/**
 * 有界遍历：只读取允许的普通文件，跳过符号链接与受保护目录。
 * 无法读取的目录在搜索/诊断里只跳过，不让整个项目失败。
 */
function collectCandidateFiles(root: string, options: {
  maxDepth: number; maxFiles: number; maxFileBytes: number; accept: (name: string) => boolean;
}): string[] {
  const accepted: string[] = [];
  let visited = 0;
  const walk = (directory: string, depth: number): void => {
    if (depth > options.maxDepth || visited >= WALK_FILE_LIMIT || accepted.length >= options.maxFiles) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (visited >= WALK_FILE_LIMIT || accepted.length >= options.maxFiles) return;
      if (isForbiddenRelative(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      let info;
      try { info = lstatSync(absolute); } catch { continue; }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (depth < options.maxDepth) walk(absolute, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      visited += 1;
      if (info.size > options.maxFileBytes || !options.accept(entry.name)) continue;
      accepted.push(absolute);
    }
  };
  walk(root, 1);
  return accepted;
}

function isSupportedSource(name: string): boolean { return /\.(ts|tsx|js|jsx)$/i.test(name); }

function isBinary(bytes: Buffer): boolean { return bytes.includes(0); }

function decodeText(bytes: Buffer): string | undefined {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; }
}

/**
 * 人工工作区操作: 明确 operator 动作，不创建 Agent 任务、不消耗模型预算。
 *
 * 所有路径先做 resolve/pathWithin + 逐段 lstat（拒绝符号链接/junction）校验；
 * Git 与终端只通过参数数组启动，绝不经过 shell 或 Agent 工具内核。
 */
export class ProductWorkspace implements WorkspaceDomain {
  private readonly roots: WorkspaceRoots;
  /** 每个项目仍在运行的终端；撤销登记时先停掉它们，晚到的写入不能再落进项目。 */
  private readonly terminals = new Map<string, Set<RunningTerminal>>();
  constructor(readonly rt: ProductRuntime) {
    // 独立实例与服务层共享 dataDir：每次调用重读登记表，removeProject 立即撤销访问。
    this.roots = new WorkspaceRoots(rt.services.dataDir);
  }

  async projects(): Promise<ProjectView[]> {
    const items: ProjectView[] = [];
    for (const record of this.roots.list()) {
      const info = statSync(record.path, { throwIfNoEntry: false });
      if (!info || !info.isDirectory()) continue;
      try { this.rt.services.assertWorkspacePath(record.path); } catch { continue; }
      items.push(await this.view(record));
    }
    items.sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt));
    return items;
  }

  async addProject(value: string): Promise<ProjectView> {
    if (!value || !path.isAbsolute(value)) invalid('Project path must be an explicit absolute path.');
    const info = statSync(value, { throwIfNoEntry: false });
    if (!info) invalid('Project folder does not exist.');
    if (!info.isDirectory()) invalid('Project path must be a directory.');
    let opened: { id: string; path: string };
    try {
      opened = await this.rt.services.openWorkspace(value);
    } catch (error) {
      throw new ProductError('validation', messageOf(error));
    }
    const record = this.roots.get(opened.id) ?? this.roots.add(opened.path);
    return this.view(this.roots.touch(record.id));
  }

  async editProject(id: string | undefined, name: string, folders: string[]): Promise<ProjectView> {
    for (const folder of folders) this.rt.services.workspacePath(folder, false);
    const record = this.roots.edit(id, name, folders);
    if (id) await this.stopTerminals(id);
    return this.view(record);
  }

  async removeProject(projectId: string): Promise<void> {
    const record = this.roots.get(this.projectId(projectId));
    if (!record) notFound('Project was not found.');
    this.roots.remove(record.id);
    // 登记先撤销，再等待该项目仍在运行的终端结束：调用方返回时不能再有晚到的写入。
    await this.stopTerminals(record.id);
    // 会话关联由产品 API 层调用 SessionsDomain.unlinkProject 解除；这里只撤销登记。
  }

  /** 应用退出时停止所有仍在运行的人工终端；调用方必须 await 后进程才真正结束。 */
  async stopAllTerminals(): Promise<void> {
    await Promise.all([...this.terminals.keys()].map(projectId => this.stopTerminals(projectId)));
  }

  async files(projectId: string): Promise<FileNode[]> {
    const { root } = this.project(projectId);
    const changes = await this.changeMap(root);
    let nodes = 0;
    const walk = (directory: string, depth: number, relative: string): FileNode[] => {
      if (depth > MAX_TREE_DEPTH || nodes >= MAX_TREE_NODES) return [];
      const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
      const children: FileNode[] = [];
      for (const entry of entries) {
        if (nodes >= MAX_TREE_NODES) break;
        if (isForbiddenRelative(entry.name)) continue;
        const absolute = path.join(directory, entry.name), childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const info = lstatSync(absolute, { throwIfNoEntry: false });
        if (!info || info.isSymbolicLink()) continue;
        const node: FileNode = { path: childRelative, name: entry.name, kind: info.isDirectory() ? 'dir' : 'file' };
        nodes += 1;
        if (info.isDirectory()) {
          node.children = depth < MAX_TREE_DEPTH ? walk(absolute, depth + 1, childRelative) : [];
        } else if (info.isFile()) {
          const change = changes.get(childRelative);
          if (change) node.change = change;
        }
        children.push(node);
      }
      return children;
    };
    return walk(root, 1, '');
  }

  async readFile(projectId: string, filePath: string): Promise<string> {
    const { root } = this.project(projectId);
    const target = this.resolveInside(root, filePath, 'File path');
    const linked = lstatSync(target, { throwIfNoEntry: false });
    if (!linked) notFound('File was not found.');
    if (linked.isSymbolicLink()) this.deniedLink();
    this.assertNoLinks(root, target);
    const info = statSync(target, { throwIfNoEntry: false });
    if (!info) notFound('File was not found.');
    if (info.isDirectory()) invalid('File path points to a directory.');
    if (!info.isFile()) invalid('File path is not a regular file.');
    if (info.size > MAX_READ_BYTES) invalid('File is larger than 1 MiB and cannot be opened as text.');
    const bytes = readFileSync(target);
    if (isBinary(bytes)) invalid('Binary files cannot be read as text.');
    return decodeText(bytes) ?? invalid('File is not valid UTF-8 text.');
  }

  async writeFile(projectId: string, filePath: string, content: string): Promise<WorkspaceWriteResult> {
    const { root } = this.project(projectId);
    if (typeof content !== 'string') invalid('File content must be a string.');
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.byteLength > MAX_WRITE_BYTES) invalid('File content is larger than 2 MiB.');
    if (decodeText(bytes) !== content) invalid('File content is not valid UTF-8 text.');
    const target = this.resolveInside(root, filePath, 'File path');
    this.assertWritableTarget(root, target);
    const temporary = path.join(path.dirname(target), `.npn-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    return { path: toPosix(path.relative(root, target)), bytes: bytes.byteLength, savedAt: new Date().toISOString() };
  }

  async search(projectId: string, query: SearchQuery): Promise<SearchHit[]> {
    const { root } = this.project(projectId);
    if (!query || typeof query !== 'object' || Array.isArray(query)) invalid('Search query must be an object.');
    const unknown = Object.keys(query).filter(key => !['text', 'regex', 'caseSensitive'].includes(key));
    if (unknown.length) invalid(`Unknown field: ${unknown.slice(0, 5).join(', ')}`);
    if (typeof query.text !== 'string' || !query.text.trim() || query.text.length > 200) invalid('Search text must be 1-200 characters.');
    if (query.regex !== undefined && typeof query.regex !== 'boolean') invalid('Search regex must be a boolean.');
    if (query.caseSensitive !== undefined && typeof query.caseSensitive !== 'boolean') invalid('Search caseSensitive must be a boolean.');
    const flags = query.caseSensitive ? 'g' : 'gi';
    let expression: RegExp;
    try {
      expression = new RegExp(query.regex ? query.text : escapeRegExp(query.text), flags);
    } catch (error) {
      throw new ProductError('validation', `Search pattern is not a valid regular expression: ${messageOf(error)}`);
    }
    const hits: SearchHit[] = [];
    const files = collectCandidateFiles(root, {
      maxDepth: MAX_SEARCH_DEPTH, maxFiles: MAX_SEARCH_FILES, maxFileBytes: MAX_SEARCH_FILE_BYTES, accept: () => true,
    });
    for (const absolute of files) {
      if (hits.length >= MAX_SEARCH_MATCHES) break;
      const bytes = readFileSync(absolute);
      if (isBinary(bytes)) continue;
      const text = decodeText(bytes);
      if (text === undefined) continue;
      const relative = toPosix(path.relative(root, absolute));
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && hits.length < MAX_SEARCH_MATCHES; index += 1) {
        const line = lines[index]!;
        expression.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = expression.exec(line)) !== null) {
          if (match[0].length === 0) { expression.lastIndex += 1; continue; }
          const column = match.index + 1, matchLength = match[0].length;
          const previewEnd = Math.min(line.length, Math.max(column + matchLength + 119, 240));
          hits.push({ path: relative, line: index + 1, column, preview: line.slice(0, previewEnd), matchLength });
          if (hits.length >= MAX_SEARCH_MATCHES || match.index + matchLength >= line.length) break;
        }
      }
    }
    return hits;
  }

  async sourceControl(projectId: string): Promise<SourceControlView> {
    const { root } = this.project(projectId);
    await this.requireRepositoryRoot(root);
    const status = await this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (status.status !== 0) this.gitUnavailable();
    const entries = parsePorcelain(status.stdout);
    const branch = await this.currentBranch(root);
    const aheadBehind = await this.aheadBehind(root);
    const lineCounts = await this.lineCounts(root);
    const changes: FileChange[] = entries.map(entry => {
      const counted = lineCounts.get(entry.path);
      return { path: entry.path, status: entry.status, additions: counted?.[0] ?? 0, deletions: counted?.[1] ?? 0 };
    }).sort((left, right) => left.path.localeCompare(right.path));
    return { branch, ahead: aheadBehind.ahead, behind: aheadBehind.behind, changes };
  }

  async fileDiff(projectId: string, filePath: string): Promise<FileDiff> {
    const { root } = this.project(projectId);
    const relative = this.resolveInside(root, filePath, 'File path');
    // 未跟踪文件的内容直接从磁盘读取；先逐段确认路径没有链接，已删除的文件仍允许查看 diff。
    this.assertNoLinkSegments(root, relative);
    const posix = toPosix(path.relative(root, relative));
    await this.requireRepositoryRoot(root);
    const status = await this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (status.status !== 0) this.gitUnavailable();
    const entry = parsePorcelain(status.stdout).find(item => item.path === posix);
    const target = relative;
    if (!entry && !existsSync(target)) notFound('File was not found in the project.');
    if (entry?.status === '?') {
      const bytes = readFileSync(target);
      if (bytes.byteLength > MAX_READ_BYTES) invalid('File is larger than 1 MiB and has no diff preview.');
      const text = decodeText(bytes);
      if (text === undefined) invalid('Binary files have no text diff.');
      const details = addedFileDiff(text);
      return { path: posix, status: 'added', additions: details.additions, deletions: 0, hunks: details.hunks, applied: false };
    }
    const diff = await this.git(root, ['diff', 'HEAD', '--no-color', '--unified=3', '--', posix]);
    if (diff.status !== 0) this.gitUnavailable();
    const details = parseUnifiedDiff(diff.stdout);
    const fileStatus: FileDiff['status'] = entry ? diffStatus(entry.status) : existsSync(target) ? 'modified' : 'deleted';
    return { path: posix, status: fileStatus, additions: details.additions, deletions: details.deletions, hunks: details.hunks, applied: false };
  }

  async commit(projectId: string, message: string, paths: string[]): Promise<WorkspaceCommitResult> {
    const { root } = this.project(projectId);
    if (typeof message !== 'string' || !message.trim() || message.length > 2000) invalid('Commit message must be 1-2000 characters.');
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 200) invalid('Select 1-200 changed files to commit.');
    const selected: string[] = [];
    for (const value of paths) {
      if (typeof value !== 'string' || !value.trim()) invalid('Commit paths must be non-empty strings.');
      if (value.split(/[\\/]/).includes('..')) invalid('Commit paths must stay inside the project.');
      const relative = this.resolveInside(root, value, 'Commit path');
      const posix = toPosix(path.relative(root, relative));
      if (!selected.includes(posix)) selected.push(posix);
    }
    await this.requireRepositoryRoot(root);
    if (this.isMainRepository(root)) {
      throw new ProductError('denied', 'The main project repository cannot be modified through the product API.', 403);
    }
    const status = await this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (status.status !== 0) this.gitUnavailable();
    const entries = parsePorcelain(status.stdout);
    const byPath = new Map(entries.map(entry => [entry.path, entry]));
    const unknown = selected.filter(item => !byPath.has(item));
    if (unknown.length) invalid(`These selected paths have no changes: ${unknown.slice(0, 5).join(', ')}`);
    const untracked = selected.filter(item => byPath.get(item)?.status === '?');
    if (untracked.length) {
      const added = await this.git(root, ['add', '--', ...untracked]);
      if (added.status !== 0) this.gitFailure('stage the selected files', added);
    }
    const committed = await this.git(root, ['commit', '--only', '-m', message, '--', ...selected]);
    if (committed.status !== 0) this.gitFailure('create the commit', committed);
    const head = await this.git(root, ['rev-parse', 'HEAD']);
    if (head.status !== 0) this.gitFailure('read the new commit', head);
    return { commit: head.stdout.trim() };
  }

  async terminal(projectId: string, command: string): Promise<TerminalResult> {
    const { record, root } = this.project(projectId);
    if (typeof command !== 'string' || !command.trim() || command.length > 4000) invalid('Terminal command must be 1-4000 characters.');
    if (/[\u0000-\u001f\u007f]/.test(command)) invalid('Terminal command must not contain control characters.');
    const tempDir = path.join(root, '.tmp', 'terminal');
    // 先逐段确认 .tmp/terminal 不是链接，再创建临时目录；否则 mkdir 会把目录建到项目外。
    this.assertNoLinkSegments(root, tempDir);
    mkdirSync(tempDir, { recursive: true });
    const startedAt = Date.now();
    const windows = process.platform === 'win32';
    const executable = windows ? 'powershell.exe' : '/bin/sh';
    const args = windows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command];
    return new Promise<TerminalResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TEMP: tempDir, TMP: tempDir },
      });
      const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); });
      const chunks: Buffer[] = [];
      let received = 0, truncated = false;
      const collect = (chunk: Buffer): void => {
        if (received >= MAX_TERMINAL_OUTPUT) { truncated = true; return; }
        const remaining = MAX_TERMINAL_OUTPUT - received;
        if (chunk.byteLength > remaining) { chunks.push(chunk.subarray(0, remaining)); received = MAX_TERMINAL_OUTPUT; truncated = true; }
        else { chunks.push(chunk); received += chunk.byteLength; }
      };
      child.stdout?.on('data', (chunk: Buffer) => collect(chunk));
      child.stderr?.on('data', (chunk: Buffer) => collect(chunk));
      let settled = false;
      const finish = (): void => { settled = true; clearTimeout(timer); };
      const timer = setTimeout(() => {
        if (settled) return;
        finish();
        void killProcess(child).then(() => reject(new ProductError('unavailable', 'Terminal command timed out.', 504)));
      }, TERMINAL_TIMEOUT_MS);
      const runs = this.terminalRuns(record.id);
      const run: RunningTerminal = {
        // removeProject 等待整个进程树结束，并让调用方看到撤销错误，而不是假装命令正常完成。
        stop: async () => {
          if (settled) return;
          finish();
          await killProcess(child);
          await waitForClose(closed);
          reject(new ProductError('not_found', 'Project was removed; the terminal command was stopped.', 404));
        },
      };
      runs.add(run);
      const release = (): void => {
        runs.delete(run);
        if (runs.size === 0 && this.terminals.get(record.id) === runs) this.terminals.delete(record.id);
      };
      child.on('error', error => {
        release();
        if (settled) return;
        finish();
        reject(error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new ProductError('unavailable', 'A terminal shell is not available on this machine.', 501)
          : new ProductError('unavailable', `Terminal command could not start: ${messageOf(error)}`, 501));
      });
      child.on('close', exitCode => {
        release();
        if (settled) return;
        finish();
        const output = Buffer.concat(chunks).toString('utf8') + (truncated ? `\n[output truncated at ${MAX_TERMINAL_OUTPUT} bytes]` : '');
        resolve({ command, output, exitCode: exitCode ?? -1, durationMs: Date.now() - startedAt, cwd: root });
      });
    });
  }

  async diagnostics(projectId: string): Promise<Diagnostic[]> {
    const { root } = this.project(projectId);
    let ts: TypeScriptModule;
    try {
      const loaded = await import('typescript') as unknown as TypeScriptModule & { default?: TypeScriptModule };
      ts = loaded.default ?? loaded;
    } catch {
      throw new ProductError('unavailable', "TypeScript diagnostics unavailable: the project's typescript module could not be loaded.", 501);
    }
    const files = collectCandidateFiles(root, {
      maxDepth: MAX_SEARCH_DEPTH, maxFiles: MAX_DIAGNOSTIC_FILES, maxFileBytes: MAX_DIAGNOSTIC_FILE_BYTES, accept: isSupportedSource,
    });
    const diagnostics: Diagnostic[] = [];
    for (const absolute of files) {
      if (diagnostics.length >= MAX_DIAGNOSTICS) break;
      const text = decodeText(readFileSync(absolute));
      if (text === undefined) continue;
      const kind = absolute.toLowerCase().endsWith('.tsx') ? ts.ScriptKind.TSX
        : absolute.toLowerCase().endsWith('.jsx') ? ts.ScriptKind.JSX
          : absolute.toLowerCase().endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, kind);
      const relative = toPosix(path.relative(root, absolute));
      for (const parsed of source.parseDiagnostics ?? []) {
        if (diagnostics.length >= MAX_DIAGNOSTICS) break;
        const position = source.getLineAndCharacterOfPosition(parsed.start ?? 0);
        diagnostics.push({
          path: relative, line: position.line + 1, column: position.character + 1,
          severity: parsed.category === ts.DiagnosticCategory.Error ? 'error' : parsed.category === ts.DiagnosticCategory.Warning ? 'warning' : 'info',
          message: ts.flattenDiagnosticMessageText(parsed.messageText, ' '), source: 'typescript',
        });
      }
    }
    return diagnostics;
  }

  private projectId(value: string): string {
    if (typeof value !== 'string' || !value.trim()) invalid('Project id is required.');
    return value;
  }

  /** 已登记 + 仍被服务授权 + 目录存在；撤销登记后立即拒绝。 */
  private project(projectId: string): { record: WorkspaceRootRecord; root: string } {
    const record = this.roots.get(this.projectId(projectId));
    if (!record) notFound('Project was not found.');
    const info = statSync(record.path, { throwIfNoEntry: false });
    if (!info || !info.isDirectory()) notFound('Project folder is no longer available.');
    try {
      this.rt.services.assertWorkspacePath(record.path);
    } catch (error) {
      throw new ProductError('denied', messageOf(error), 403);
    }
    return { record, root: record.path };
  }

  /** 停止并等待一个项目登记的所有终端；撤销登记后调用方才能真正返回。 */
  private async stopTerminals(projectId: string): Promise<void> {
    const runs = this.terminals.get(projectId);
    if (!runs) return;
    this.terminals.delete(projectId);
    await Promise.all([...runs].map(run => run.stop()));
  }

  /** 每个项目一个终端集合：同一项目可以同时运行多条命令。 */
  private terminalRuns(projectId: string): Set<RunningTerminal> {
    let runs = this.terminals.get(projectId);
    if (!runs) { runs = new Set(); this.terminals.set(projectId, runs); }
    return runs;
  }

  private async view(record: WorkspaceRootRecord): Promise<ProjectView> {
    const view: ProjectView = {
      id: record.id, name: record.name, path: record.path, lastOpenedAt: record.lastOpenedAt,
      sessions: this.rt.store.projectSessionCount(record.id), sourceFolders: record.sourceFolders ?? [record.path],
    };
    const summary = await this.gitSummary(record.path);
    if (summary.branch) view.branch = summary.branch;
    if (summary.changedFiles !== undefined) view.changedFiles = summary.changedFiles;
    return view;
  }

  private async gitSummary(root: string): Promise<{ branch?: string; changedFiles?: number }> {
    const top = await this.repositoryRoot(root);
    if (!top || !samePath(top, root)) return {};
    const status = await this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (status.status !== 0) return {};
    const branch = await this.currentBranch(root);
    return { ...(branch ? { branch } : {}), changedFiles: parsePorcelain(status.stdout).length };
  }

  private async currentBranch(root: string): Promise<string> {
    const current = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const name = current.status === 0 ? current.stdout.trim() : '';
    if (name && name !== 'HEAD') return name;
    const symbolic = await this.git(root, ['symbolic-ref', '--short', 'HEAD']);
    return symbolic.status === 0 ? symbolic.stdout.trim() : '';
  }

  private async aheadBehind(root: string): Promise<{ ahead: number; behind: number }> {
    const result = await this.git(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    if (result.status !== 0) return { ahead: 0, behind: 0 };
    const [behind, ahead] = result.stdout.trim().split(/\s+/).map(Number);
    return { ahead: Number.isSafeInteger(ahead) ? ahead! : 0, behind: Number.isSafeInteger(behind) ? behind! : 0 };
  }

  private async lineCounts(root: string): Promise<Map<string, [number, number]>> {
    const counts = new Map<string, [number, number]>();
    for (const args of [['diff', '--numstat'], ['diff', '--cached', '--numstat']]) {
      const result = await this.git(root, args);
      if (result.status !== 0) continue;
      for (const line of result.stdout.split('\n')) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const additions = Number(parts[0]), deletions = Number(parts[1]), file = parts.slice(2).join('\t');
        const current = counts.get(file) ?? [0, 0];
        counts.set(file, [
          current[0] + (Number.isSafeInteger(additions) ? additions : 0),
          current[1] + (Number.isSafeInteger(deletions) ? deletions : 0),
        ]);
      }
    }
    return counts;
  }

  /** 获取 eol 归一化后的相对路径；拒绝越界、受保护路径与根目录本身。 */
  private resolveInside(root: string, value: string, label: string): string {
    if (typeof value !== 'string' || !value.trim()) invalid(`${label} is required.`);
    if (value.includes('\u0000')) invalid(`${label} contains invalid characters.`);
    const target = path.resolve(root, value);
    if (!pathWithin(root, target) || target === root) invalid(`${label} must stay inside the project.`);
    if (isForbiddenRelative(path.relative(root, target))) {
      throw new ProductError('denied', 'Credential and protected runtime files cannot be accessed through the project API.', 403);
    }
    return target;
  }

  /** 逐段 lstat + realpath 复核：读写已存在的目标时使用最严格的形式。 */
  private assertNoLinks(root: string, target: string): void {
    this.assertNoLinkSegments(root, target);
    const real = realpathSync(target);
    if (!pathWithin(realpathSync(root), real)) this.deniedLink();
  }

  /** 逐段 lstat；目标本身可以不存在（已删除的文件仍允许查看 diff），但任何已有的链接段都拒绝。 */
  private assertNoLinkSegments(root: string, target: string): void {
    let cursor = root;
    for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const info = lstatSync(cursor, { throwIfNoEntry: false });
      if (!info) return;
      if (info.isSymbolicLink()) this.deniedLink();
    }
  }

  private deniedLink(): never {
    throw new ProductError('denied', 'Symbolic links and junctions cannot be accessed through the project API.', 403);
  }

  private assertWritableTarget(root: string, target: string): void {
    const parent = path.dirname(target);
    const parentInfo = statSync(parent, { throwIfNoEntry: false });
    if (!parentInfo || !parentInfo.isDirectory()) invalid('Parent folder does not exist.');
    if (parent !== root) this.assertNoLinks(root, parent);
    try { accessSync(parent, constants.W_OK); } catch { invalid('Parent folder is not writable.'); }
    const info = lstatSync(target, { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) this.deniedLink();
    if (info.isDirectory()) invalid('A folder cannot be overwritten with a file.');
    if (!info.isFile()) invalid('Target is not a regular file.');
  }

  private async changeMap(root: string): Promise<Map<string, FileNode['change']>> {
    const map = new Map<string, FileNode['change']>();
    const top = await this.repositoryRoot(root);
    if (!top || !samePath(top, root)) return map;
    const result = await this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (result.status !== 0) return map;
    for (const entry of parsePorcelain(result.stdout)) {
      const change = fileNodeChange(entry.status);
      if (change) map.set(entry.path, change);
    }
    return map;
  }

  /** 项目根必须自己拥有仓库；嵌在别的仓库（尤其主项目）里的目录不暴露该仓库状态。 */
  private async repositoryRoot(root: string): Promise<string | undefined> {
    const result = await this.git(root, ['rev-parse', '--show-toplevel']);
    if (result.status !== 0) return undefined;
    const top = result.stdout.trim();
    return top ? path.resolve(top) : undefined;
  }

  private async requireRepositoryRoot(root: string): Promise<void> {
    const top = await this.repositoryRoot(root);
    if (!top || !samePath(top, root)) this.gitUnavailable();
  }

  private isMainRepository(repositoryRoot: string): boolean {
    const candidate = path.resolve(repositoryRoot).toLowerCase();
    return candidate === path.resolve(this.rt.services.projectRoot).toLowerCase()
      || candidate === path.resolve(process.cwd()).toLowerCase();
  }

  private gitFailure(action: string, result: GitResult): never {
    const detail = result.stderr.trim().split(/\r?\n/)[0] || result.stdout.trim().split(/\r?\n/)[0] || 'Git rejected the operation.';
    throw new ProductError('conflict', `Git could not ${action}: ${detail}`, 409);
  }

  private gitUnavailable(): never {
    throw new ProductError('unavailable', 'Git is not available in this project.', 501);
  }

  /** 只用参数数组启动 git；永不经过 shell，抑制交互式凭据提示。 */
  private git(root: string, args: readonly string[]): Promise<GitResult> {
    return new Promise<GitResult>(resolve => {
      const child = spawn('git', [...args], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let outBytes = 0, errBytes = 0, overflow = false, settled = false;
      const collect = (target: Buffer[], chunk: Buffer, current: number): number => {
        if (current >= MAX_GIT_OUTPUT) { overflow = true; return current; }
        const remaining = MAX_GIT_OUTPUT - current;
        target.push(chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk);
        if (chunk.byteLength > remaining) overflow = true;
        return current + Math.min(chunk.byteLength, remaining);
      };
      child.stdout?.on('data', (chunk: Buffer) => { outBytes = collect(stdout, chunk, outBytes); });
      child.stderr?.on('data', (chunk: Buffer) => { errBytes = collect(stderr, chunk, errBytes); });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve({ status: 124, stdout: Buffer.concat(stdout).toString('utf8'), stderr: 'Git timed out.' });
      }, GIT_TIMEOUT_MS);
      child.on('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: 127, stdout: '', stderr: `Git is not available: ${messageOf(error)}` });
      });
      child.on('close', status => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const output = Buffer.concat(stdout).toString('utf8'), errorOutput = Buffer.concat(stderr).toString('utf8');
        resolve({ status: overflow ? 125 : status ?? 1, stdout: output, stderr: overflow ? 'Git output exceeded the safety limit.' : errorOutput });
      });
    });
  }
}

/** 超时后结束整个子进程树；Windows 上 powershell 可能再派生子进程。 */
function killProcess(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise<void>(resolve => {
    if (process.platform !== 'win32' || !child.pid) { child.kill(); resolve(); return; }
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('close', () => resolve());
    killer.on('error', () => { child.kill(); resolve(); });
  });
}

/** 终止后等待 close 确认；进程树已被强制结束，超时只用于避免调用方无限等待。 */
function waitForClose(closed: Promise<void>, timeoutMs = 2000): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    void closed.then(() => { clearTimeout(timer); resolve(); });
  });
}
