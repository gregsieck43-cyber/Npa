/** 演示网关的 IDE 工作区：内存文件系统 + 变更计算 + 模拟终端。仅 mock 使用。 */
import { GatewayError } from '../contract';
import type { Diagnostic, FileChange, FileDiff, FileNode, SearchHit, SearchQuery, SourceControlView, TerminalResult } from '../types';
import { lineDiff } from '../../lib/diff';
import { demoFiles, type DemoFile } from './files';

const now = () => new Date().toISOString();

export class MockWorkspace {
  private files = new Map<string, Map<string, DemoFile>>();
  private commits = 0;

  constructor(private readonly projectPath: (projectId: string) => string) {}

  private project(projectId: string) {
    let files = this.files.get(projectId);
    if (!files) { files = new Map(Object.entries(demoFiles())); this.files.set(projectId, files); }
    return files;
  }

  private file(projectId: string, path: string) {
    const file = this.project(projectId).get(path);
    if (!file) throw new GatewayError('not_found', `文件不存在：${path}`);
    return file;
  }

  private status(file: DemoFile): FileChange['status'] | undefined {
    if (file.original === undefined) return 'A';
    return file.original === file.content ? undefined : 'M';
  }

  tree(projectId: string): FileNode[] {
    const root: FileNode[] = [];
    for (const [path, file] of [...this.project(projectId)].sort(([a], [b]) => a.localeCompare(b))) {
      const parts = path.split('/');
      let level = root;
      parts.forEach((name, i) => {
        const nodePath = parts.slice(0, i + 1).join('/');
        const isFile = i === parts.length - 1;
        let node = level.find(n => n.name === name);
        if (!node) { node = isFile ? { path: nodePath, name, kind: 'file', change: this.status(file) as FileNode['change'] } : { path: nodePath, name, kind: 'dir', children: [] }; level.push(node); }
        level = node.children ?? [];
      });
    }
    const sort = (nodes: FileNode[]) => { nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1)); nodes.forEach(n => n.children && sort(n.children)); return nodes; };
    return sort(root);
  }

  read(projectId: string, path: string) { return this.file(projectId, path).content; }

  write(projectId: string, path: string, content: string) {
    if (path.includes('..') || /^[a-z]:|^\//i.test(path)) throw new GatewayError('permission', '只能写入当前项目内的相对路径');
    const files = this.project(projectId), existing = files.get(path);
    files.set(path, existing ? { ...existing, content } : { content });
    return { path, bytes: new TextEncoder().encode(content).length, savedAt: now() };
  }

  search(projectId: string, query: SearchQuery): SearchHit[] {
    if (!query.text) return [];
    let pattern: RegExp;
    try { pattern = new RegExp(query.regex ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), query.caseSensitive ? 'g' : 'gi'); }
    catch (error) { throw new GatewayError('validation', `正则无效：${(error as Error).message}`); }
    const hits: SearchHit[] = [];
    for (const [path, file] of this.project(projectId)) {
      file.content.split('\n').forEach((line, i) => {
        for (const match of line.matchAll(pattern)) if (match[0]) hits.push({ path, line: i + 1, column: match.index + 1, preview: line, matchLength: match[0].length });
      });
    }
    return hits.slice(0, 500);
  }

  sourceControl(projectId: string): SourceControlView {
    const changes: FileChange[] = [];
    for (const [path, file] of this.project(projectId)) {
      const status = this.status(file);
      if (!status) continue;
      const lines = lineDiff(file.original ?? '', file.content);
      changes.push({ path, status, additions: lines.filter(l => l.kind === 'add').length, deletions: file.original === undefined ? 0 : lines.filter(l => l.kind === 'del').length });
    }
    return { branch: 'main', ahead: this.commits, behind: 0, changes: changes.sort((a, b) => a.path.localeCompare(b.path)) };
  }

  diff(projectId: string, path: string): FileDiff {
    const file = this.file(projectId, path);
    const lines = file.original === undefined ? file.content.split('\n').map((text, i) => ({ kind: 'add' as const, newNo: i + 1, text })) : lineDiff(file.original, file.content);
    return {
      path, status: file.original === undefined ? 'added' : 'modified', applied: true,
      additions: lines.filter(l => l.kind === 'add').length, deletions: lines.filter(l => l.kind === 'del').length,
      hunks: [{ header: `@@ ${path} @@`, lines }],
    };
  }

  commit(projectId: string, message: string, paths: string[]) {
    if (!message.trim()) throw new GatewayError('validation', '提交说明不能为空');
    if (!paths.length) throw new GatewayError('validation', '没有可提交的变更');
    for (const path of paths) { const file = this.file(projectId, path); file.original = file.content; }
    this.commits++;
    return { commit: Math.random().toString(16).slice(2, 9) };
  }

  terminal(projectId: string, command: string): TerminalResult {
    const cwd = this.projectPath(projectId), trimmed = command.trim(), started = performance.now();
    const done = (output: string, exitCode = 0): TerminalResult => ({ command: trimmed, output, exitCode, cwd, durationMs: Math.round(performance.now() - started) + 40 });
    const [head, ...rest] = trimmed.split(/\s+/);
    switch (head.toLowerCase()) {
      case 'pwd': case 'cd': return done(cwd);
      case 'echo': case 'write-output': return done(rest.join(' '));
      case 'ls': case 'dir': case 'get-childitem': return done(this.tree(projectId).map(n => `${n.kind === 'dir' ? 'd----' : '-a---'}  ${n.name}`).join('\n'));
      case 'cat': case 'type': case 'get-content': return rest[0] ? done(this.read(projectId, rest[0].replace(/\\/g, '/'))) : done('缺少路径参数', 1);
      case 'git': {
        const scm = this.sourceControl(projectId);
        if (rest[0] === 'status') return done(`On branch ${scm.branch}\n${scm.changes.length ? `Changes not staged for commit:\n${scm.changes.map(c => `  ${c.status === 'A' ? 'new file:' : 'modified:'}   ${c.path}`).join('\n')}` : 'nothing to commit, working tree clean'}`);
        if (rest[0] === 'branch') return done(`* ${scm.branch}\n  master`);
        if (rest[0] === 'log') return done('0c92230 Finish 0.2.11 draft guards and real packaged recovery follow-up\n7a76a5e Finish 0.2.8 desktop and IDE redesign');
        return done(`演示终端未模拟 git ${rest[0] ?? ''}`, 1);
      }
      case 'npm': case 'node':
        return done('▶ archive paging\n  ✔ page 2 stable after inserts (31ms)\n  ✔ sha256 binds original digest (4ms)\n✔ archive paging (52ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0');
      default: return done(`演示终端未模拟该命令：${head}\n（接入后台后由 POST /v1/terminal 在项目根目录执行）`, 1);
    }
  }

  diagnostics(projectId: string): Diagnostic[] {
    const result: Diagnostic[] = [];
    for (const [path, file] of this.project(projectId)) {
      file.content.split('\n').forEach((line, i) => {
        const todo = line.indexOf('TODO');
        if (todo >= 0) result.push({ path, line: i + 1, column: todo + 1, severity: 'info', message: line.slice(todo).trim(), source: 'todo' });
        if (/\bStore\b/.test(line) && path.endsWith('outbox.ts') && i < 12) result.push({ path, line: i + 1, column: line.indexOf('Store') + 1, severity: 'error', message: "找不到名称“Store”。", source: 'ts(2304)' });
      });
    }
    if (this.project(projectId).get('src/kernel/index.ts')?.content.includes('KernelError')) result.push({ path: 'src/kernel/index.ts', line: 17, column: 41, severity: 'warning', message: '“KernelError”未从 ./types 导入。', source: 'ts(2552)' });
    return result;
  }
}
