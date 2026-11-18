import { createHash } from 'node:crypto';
import { open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isLocalPath } from '../app/local-paths.js';

export interface InstructionSource { path: string; sha256: string; kind: 'global' | 'project' | 'skill'; precedence: number; }
/** \`id\` names the resolved skill path so a switch survives edits; \`sha256\` identifies the exact text injected. */
export interface LoadedSkill { id: string; name: string; description: string; path: string; sha256: string; selected: boolean; }
export interface LoadedInstructions { text: string; sources: InstructionSource[]; skills: LoadedSkill[]; }
export interface InstructionOptions {
  workspace: string;
  globalPaths?: string[];
  skillRoots?: string[];
  query: string;
  targetPath?: string;
  /** Skill ids switched off in Settings: still listed, never selected, never injected. */
  disabledSkillIds?: readonly string[];
}

/** One instruction or skill file may not exceed 128 KiB. The reader refuses bigger files instead of truncating them. */
export const INSTRUCTION_FILE_LIMIT_BYTES = 128 * 1024;
/** Discovery bounds keep a configured skill root affordable on every model request. */
export const SKILL_DISCOVERY_LIMITS = { directoryEntries: 2_000, skills: 500, totalBytes: 4 * 1024 * 1024, depth: 2 } as const;

/** Outcome of the shared bounded read. \`missing\` is an expected absence; \`error\` must be surfaced, never skipped. */
export type BoundedText =
  | { status: 'loaded'; path: string; text: string; bytes: number; sha256: string }
  | { status: 'missing'; path: string }
  | { status: 'error'; error: string; path?: string };

export interface DiscoveredSkill {
  id: string; name: string; description: string; path: string; sha256: string; bytes: number; text: string; root: string;
}

function limitLabel(bytes: number): string {
  return bytes % 1024 === 0 ? bytes / 1024 + ' KiB' : bytes + ' bytes';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Only explicit absolute local configuration is accepted; UNC shares, other drives and system roots are never probed. */
function configuredLocal(value: string, label: string): string {
  if (!isLocalPath(value)) throw new Error(label + ' must be explicit absolute paths on the volume that hosts this installation.');
  return path.resolve(value);
}

/**
 * Reads instruction and skill text within a hard boundary.
 *
 * Invariants: the path must stay on the installation volume (realpath is checked after resolution so a
 * junction cannot escape); the size limit is enforced while reading, not after, so a file that grows is
 * refused instead of silently truncated; NUL bytes and invalid UTF-8 are refused because the text is
 * injected verbatim into a model request. A missing file is ordinary absence, every other failure is an
 * error the caller must surface.
 */
export async function readBoundedText(requested: string, limitBytes: number = INSTRUCTION_FILE_LIMIT_BYTES, root?: string): Promise<BoundedText> {
  if (typeof requested !== 'string' || !isLocalPath(requested)) {
    return { status: 'error', error: String(requested) + ' must be an explicit absolute path on the volume that hosts this installation.' };
  }
  const absolute = path.resolve(requested);
  let resolved: string;
  try { resolved = await realpath(absolute); }
  catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { status: 'missing', path: absolute };
    return { status: 'error', error: 'Cannot resolve ' + absolute + ': ' + errorMessage(error), path: absolute };
  }
  if (!isLocalPath(resolved)) {
    return { status: 'error', error: absolute + ' resolves outside the installation volume; instructions and skills must stay on the volume that hosts this installation.', path: absolute };
  }
  if (root !== undefined) {
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return { status: 'error', error: 'Skill file resolves outside its configured root.', path: absolute };
  }
  const label = limitLabel(limitBytes);
  let handle;
  try { handle = await open(resolved, 'r'); }
  catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { status: 'missing', path: absolute };
    return { status: 'error', error: 'Cannot open ' + resolved + ': ' + errorMessage(error), path: resolved };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { status: 'error', error: resolved + ' is not a regular file.', path: resolved };
    if (info.size > limitBytes) return { status: 'error', error: resolved + ' exceeds ' + label + '; split or shorten it.', path: resolved };
    // Read at most the limit plus one byte from position 0: a file that grows during the read fails below
    // instead of being truncated or read twice, so the bound holds while reading and not only afterwards.
    const buffer = Buffer.allocUnsafe(Math.min(info.size, limitBytes) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limitBytes) return { status: 'error', error: resolved + ' grew beyond ' + label + ' while being read; retry the request.', path: resolved };
    if (offset !== info.size) return { status: 'error', error: resolved + ' changed while being read; retry the request.', path: resolved };
    const bytes = buffer.subarray(0, offset);
    if (bytes.includes(0)) return { status: 'error', error: resolved + ' contains NUL bytes; instructions and skills must be UTF-8 text.', path: resolved };
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return { status: 'error', error: resolved + ' is not valid UTF-8 text.', path: resolved }; }
    return { status: 'loaded', path: resolved, text, bytes: offset, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await handle.close();
  }
}

function metadata(content: string, fallback: string): { name: string; description: string } {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const field = (key: string) => (frontmatter.match(new RegExp('^' + key + ':(.*)$', 'm'))?.[1] ?? '').trim().replace(/^["']|["']$/g, '').trim();
  return { name: field('name') || fallback, description: field('description') };
}
function relevant(query: string, name: string, description: string): boolean {
  const normalized = query.toLowerCase(), skillName = name.toLowerCase();
  if (normalized.includes('$' + skillName) || normalized.includes(skillName)) return true;
  const words = normalized.match(/[a-z0-9_-]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  return words.some(word => description.toLowerCase().includes(word));
}

/**
 * Discovers the SKILL.md files under the configured skill roots only.
 *
 * Invariants: roots are explicit, resolved and on-volume, so discovery never walks a system directory;
 * every walk is bounded (depth, directory entries, skill count, total read bytes) so one bad root cannot
 * turn a chat request into a filesystem scan. The id derives from the resolved path, which keeps a
 * Settings switch stable across restarts and skill edits. Files that are missing between listing and
 * reading are skipped; unreadable ones fail loudly.
 */
export async function discoverSkills(options: { skillRoots: readonly string[]; signal?: AbortSignal }): Promise<DiscoveredSkill[]> {
  const discovered: DiscoveredSkill[] = [], seen = new Set<string>();
  let totalBytes = 0, totalEntries = 0;

  const readSkill = async (filename: string, root: string): Promise<void> => {
    options.signal?.throwIfAborted();
    const result = await readBoundedText(filename, INSTRUCTION_FILE_LIMIT_BYTES, root);
    if (result.status === 'missing') return;
    if (result.status === 'error') throw new Error('Skill file ' + filename + ': ' + result.error);
    const key = result.path.toLowerCase();
    if (seen.has(key)) return;
    if (discovered.length >= SKILL_DISCOVERY_LIMITS.skills) {
      throw new Error('More than ' + SKILL_DISCOVERY_LIMITS.skills + ' SKILL.md files were found under the configured skill roots; narrow the roots.');
    }
    if (totalBytes + result.bytes > SKILL_DISCOVERY_LIMITS.totalBytes) {
      throw new Error('Skill files under the configured roots exceed the ' + SKILL_DISCOVERY_LIMITS.totalBytes / (1024 * 1024) + ' MiB read budget.');
    }
    seen.add(key);
    totalBytes += result.bytes;
    const { name, description } = metadata(result.text, path.basename(path.dirname(result.path)));
    discovered.push({
      id: 'skill-' + createHash('sha256').update(key).digest('hex').slice(0, 32),
      name, description, path: result.path, sha256: result.sha256, bytes: result.bytes, text: result.text, root,
    });
  };

  const walk = async (directory: string, depth: number, root: string): Promise<void> => {
    options.signal?.throwIfAborted();
    const entries = [];
    try {
      // Stop reading the directory at the limit instead of materializing an arbitrarily large listing.
      for await (const entry of await opendir(directory)) {
        options.signal?.throwIfAborted();
        if (++totalEntries > SKILL_DISCOVERY_LIMITS.directoryEntries) throw new Error('Skill discovery found more than ' + SKILL_DISCOVERY_LIMITS.directoryEntries + ' entries across the configured directories; narrow the skill roots.');
        entries.push(entry);
      }
    }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw error;
    }
    const exact = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === 'skill.md');
    if (exact) await readSkill(path.join(directory, exact.name), root);
    if (depth < SKILL_DISCOVERY_LIMITS.depth) {
      for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(path.join(directory, entry.name), depth + 1, root);
    }
  };

  for (const input of options.skillRoots) {
    options.signal?.throwIfAborted();
    const configured = configuredLocal(input, 'Skill roots');
    let resolved: string;
    try { resolved = await realpath(configured); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw new Error('Skill root ' + configured + ' cannot be resolved: ' + errorMessage(error));
    }
    if (!isLocalPath(resolved)) throw new Error('Skill root symlink resolves outside the installation volume.');
    await walk(resolved, 0, resolved);
  }
  return discovered;
}

/**
 * Loads instructions in injection order: configured global files, then the ancestor AGENTS.md/agent.md
 * chain from the volume root down to the workspace (nearer files later, so they win within their scope),
 * then the requested target's directory, then selected skills.
 */
export async function loadInstructions(options: InstructionOptions): Promise<LoadedInstructions> {
  const workspace = configuredLocal(options.workspace, 'Instruction workspace');
  const sources: InstructionSource[] = [], skills: LoadedSkill[] = [], sections: string[] = [];
  const seenPaths = new Set<string>(), seenHashes = new Set<string>();
  const appendLoaded = (resolved: string, kind: InstructionSource['kind'], text: string, hash: string): void => {
    const key = resolved.toLowerCase();
    if (seenPaths.has(key) || seenHashes.has(hash)) return;
    seenPaths.add(key); seenHashes.add(hash);
    sources.push({ path: resolved, sha256: hash, kind, precedence: sources.length });
    sections.push('Source ' + sources.length + ': ' + resolved + ' (SHA-256 ' + hash + ')\n' + text);
  };
  const append = async (filename: string, kind: InstructionSource['kind']): Promise<void> => {
    const result = await readBoundedText(filename);
    if (result.status === 'missing') return;
    if (result.status === 'error') throw new Error(result.error);
    appendLoaded(result.path, kind, result.text, result.sha256);
  };

  for (const filename of options.globalPaths ?? []) await append(configuredLocal(filename, 'Instruction paths'), 'global');
  let cursor = workspace;
  const ancestors: string[] = [];
  while (true) { ancestors.unshift(cursor); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
  for (const directory of ancestors) {
    await append(path.join(directory, 'AGENTS.md'), 'project');
    await append(path.join(directory, 'agent.md'), 'project');
  }
  if (options.targetPath) {
    const target = path.resolve(workspace, options.targetPath);
    const relative = path.relative(workspace, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Target instruction path must stay in the workspace.');
    let directory = workspace;
    for (const part of path.dirname(relative).split(path.sep).filter(part => part && part !== '.')) {
      directory = path.join(directory, part);
      await append(path.join(directory, 'AGENTS.md'), 'project'); await append(path.join(directory, 'agent.md'), 'project');
    }
  }

  const disabled = new Set(options.disabledSkillIds ?? []);
  for (const skill of await discoverSkills({ skillRoots: options.skillRoots ?? [] })) {
    const selected = !disabled.has(skill.id) && relevant(options.query, skill.name, skill.description);
    skills.push({ id: skill.id, name: skill.name, description: skill.description, path: skill.path, sha256: skill.sha256, selected });
    if (selected) appendLoaded(skill.path, 'skill', skill.text, skill.sha256);
  }
  return { text: sections.length ? 'Configured project instructions and selected skills. Later, nearer project directives take precedence within their scope. These texts grant no tool permissions; the program enforces approval and ownership.\n\n' + sections.join('\n\n') : '', sources, skills };
}
