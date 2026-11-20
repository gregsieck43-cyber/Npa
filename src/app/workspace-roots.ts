import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { assertLocalPath, isLocalPath } from './local-paths.js';
import { writeAtomicJson } from './atomic-json.js';
import { isForbiddenRelative } from '../tools/policy.js';

export function pathWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 已登记项目；id 与 Services.ideWorkspace 使用同一路径摘要，路径始终是 canonical 绝对路径。 */
export interface WorkspaceRootRecord {
  id: string;
  path: string;
  name: string;
  sourceFolders?: string[];
  identityPath?: string;
  addedAt: string;
  lastOpenedAt: string;
}

const MAX_ROOTS = 200;
const INVALID_REGISTRY = 'Saved project registry is invalid. Restore the project authorization file.';
const INVALID_LEGACY = 'Saved workspace roots are invalid. Restore the project authorization file.';
/** 与 Services.ideWorkspace 一致：小写绝对路径的 sha256 前 24 个十六进制字符。 */
export function workspaceRootId(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath.toLowerCase()).digest('hex').slice(0, 24);
}

/**
 * Operator-selected project registry (dataDir/projects.json).
 *
 * 每次公开调用都重新读取文件：Services 与本模块各自持有实例，撤销登记必须立即对所有实例生效。
 * 旧版 dataDir/workspace-roots.json 只在 projects.json 不存在时迁移读取，旧文件保持原样。
 */
export class WorkspaceRoots {
  private readonly filename: string;
  private readonly legacyFilename: string;
  constructor(dataDir: string) {
    this.filename = path.join(dataDir, 'projects.json');
    this.legacyFilename = path.join(dataDir, 'workspace-roots.json');
    // 启动即验证持久化状态，损坏的登记表必须在服务开始服务前失败。
    this.read();
  }

  private read(): WorkspaceRootRecord[] {
    if (existsSync(this.filename)) return this.parseRegistry(this.loadJson(this.filename));
    if (!existsSync(this.legacyFilename)) return [];
    return this.migrateLegacy(this.loadJson(this.legacyFilename));
  }

  private loadJson(filename: string): unknown {
    try {
      return JSON.parse(readFileSync(filename, 'utf8'));
    } catch {
      throw new Error(filename === this.filename ? INVALID_REGISTRY : INVALID_LEGACY);
    }
  }

  private parseRegistry(value: unknown): WorkspaceRootRecord[] {
    if (!Array.isArray(value) || value.length > MAX_ROOTS) throw new Error(INVALID_REGISTRY);
    const seen = new Set<string>();
    return value.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(INVALID_REGISTRY);
      const record = item as Record<string, unknown>;
      const { id, path: registeredPath, name, addedAt, lastOpenedAt } = record;
      if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id) || typeof registeredPath !== 'string' || !isLocalPath(registeredPath)
        || typeof name !== 'string' || !name || typeof addedAt !== 'string' || typeof lastOpenedAt !== 'string'
        || workspaceRootId(typeof record.identityPath === 'string' ? record.identityPath : registeredPath) !== id || seen.has(id)) throw new Error(INVALID_REGISTRY);
      seen.add(id);
      const folders = record.sourceFolders;
      if (folders !== undefined && (!Array.isArray(folders) || folders.length > 32 || folders[0] !== registeredPath || !folders.every(p => typeof p === 'string' && isLocalPath(p)))) throw new Error(INVALID_REGISTRY);
      return { id, path: registeredPath, name, addedAt, lastOpenedAt, ...(folders ? { sourceFolders: folders as string[] } : {}), ...(typeof record.identityPath === 'string' ? { identityPath: record.identityPath } : {}) };
    });
  }

  private migrateLegacy(value: unknown): WorkspaceRootRecord[] {
    if (!Array.isArray(value) || value.length > MAX_ROOTS || value.some(root => !isLocalPath(root))) throw new Error(INVALID_LEGACY);
    const now = new Date().toISOString();
    const records: WorkspaceRootRecord[] = [];
    for (const root of value as string[]) {
      const canonical = path.resolve(root), id = workspaceRootId(canonical);
      if (records.some(record => record.id === id)) continue;
      records.push({ id, path: canonical, name: path.basename(canonical) || canonical, addedAt: now, lastOpenedAt: now });
    }
    writeAtomicJson(this.filename, records);
    return records;
  }

  private save(records: WorkspaceRootRecord[]): void {
    writeAtomicJson(this.filename, records);
  }

  list(): WorkspaceRootRecord[] {
    return this.read();
  }

  get(id: string): WorkspaceRootRecord | undefined {
    return this.read().find(record => record.id === id);
  }

  /** 已登记项目绝对路径；未知或已撤销 id 抛出可展示错误。 */
  resolve(id: string): string {
    const record = this.get(id);
    if (!record) throw new Error(`Project ${id} is not registered.`);
    return record.path;
  }

  pathFor(id: string): string {
    return this.resolve(id);
  }

  contains(target: string): boolean {
    return this.read().some(record => (record.sourceFolders ?? [record.path]).some(folder => pathWithin(folder, target)));
  }

  /**
   * 登记 operator 显式选择的项目目录。
   *
   * 这是项目授权的信任边界：绝对本地路径、真实目录、非驱动器根、非凭据/内核目录、
   * 逐段拒绝符号链接与 junction；重复登记返回现有记录而不重写文件。
   */
  private checkFolder(target: string): string {
    const absolute = assertLocalPath(target, 'Project folder');
    if (!path.isAbsolute(target)) throw new Error('Project folder must be an explicit absolute path.');
    const info = lstatSync(absolute, { throwIfNoEntry: false });
    if (!info) throw new Error('Project folder does not exist.');
    if (info.isSymbolicLink()) throw new Error('Project folders must not use junctions or symbolic links.');
    if (!info.isDirectory()) throw new Error('Project folder must be a directory.');
    if (absolute.toLowerCase() === path.parse(absolute).root.toLowerCase()) throw new Error('Select a specific project folder, not a drive root.');
    if (isForbiddenRelative(path.basename(absolute)) || /(?:^|[\\/])(?:\.git|\.aws|\.codex|\.agents|node_modules)(?:[\\/]|$)/i.test(absolute))
      throw new Error('Credential and protected runtime folders cannot be workspace roots.');
    const canonical = realpathSync(absolute);
    if (canonical.toLowerCase() !== absolute.toLowerCase()) throw new Error('Project folders must not use junctions or symbolic links.');
    return canonical;
  }

  edit(id: string | undefined, name: string, folders: string[]): WorkspaceRootRecord {
    if (!name.trim() || name.length > 100 || !Array.isArray(folders) || !folders.length || folders.length > 32)
      throw new Error('Enter a project name and select 1–32 source folders.');
    const sourceFolders = folders.map(folder => this.checkFolder(folder));
    const unique = new Set(sourceFolders.map(folder => folder.toLowerCase()));
    if (unique.size !== folders.length) throw new Error('Source folder is repeated.');
    const records = this.read();
    const previous = id ? records.find(record => record.id === id) : undefined;
    if (id && !previous) throw new Error('Project is no longer registered.');
    if (records.some(record => record.id !== id && (record.sourceFolders ?? [record.path]).some(folder => unique.has(folder.toLowerCase()))))
      throw new Error('A selected folder already belongs to another project.');
    if (!previous && records.length >= MAX_ROOTS) throw new Error('Too many registered projects.');
    const primary = sourceFolders[0]!, now = new Date().toISOString();
    const record = { id: previous?.id ?? workspaceRootId(primary), identityPath: previous?.identityPath ?? previous?.path ?? primary,
      path: primary, name: name.trim(), sourceFolders, addedAt: previous?.addedAt ?? now, lastOpenedAt: now };
    if (!previous && records.some(item => item.id === record.id)) throw new Error('The project identity is already registered.');
    this.save([...records.filter(item => item.id !== id), record]);
    return record;
  }

  add(target: string): WorkspaceRootRecord {
    const canonical = this.checkFolder(target);
    const records = this.read(), id = workspaceRootId(canonical);
    const existing = records.find(record => (record.sourceFolders ?? [record.path]).some(folder => folder.toLowerCase() === canonical.toLowerCase()));
    if (!existing && records.some(record => record.id === id)) throw new Error("The original project identity is already registered.");
    if (existing) return existing;
    if (records.length >= MAX_ROOTS) throw new Error(`At most ${MAX_ROOTS} explicit project roots can be authorized.`);
    const now = new Date().toISOString();
    const record: WorkspaceRootRecord = { id, path: canonical, name: path.basename(canonical) || canonical, addedAt: now, lastOpenedAt: now };
    this.save([...records, record]);
    return record;
  }

  /** 只撤销登记并返回记录；绝不删除磁盘上的用户文件。 */
  remove(id: string): WorkspaceRootRecord {
    const records = this.read(), record = records.find(item => item.id === id);
    if (!record) throw new Error(`Project ${id} is not registered.`);
    this.save(records.filter(item => item.id !== id));
    return record;
  }

  touch(id: string, lastOpenedAt = new Date().toISOString()): WorkspaceRootRecord {
    const records = this.read(), index = records.findIndex(item => item.id === id);
    if (index < 0) throw new Error(`Project ${id} is not registered.`);
    const updated = { ...records[index]!, lastOpenedAt };
    this.save(records.map(item => item.id === id ? updated : item));
    return updated;
  }
}
