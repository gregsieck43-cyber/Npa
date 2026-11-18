import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeAtomicJson } from '../app/atomic-json.js';
import { isLocalPath } from '../app/local-paths.js';
import { discoverSkills, readBoundedText, type DiscoveredSkill } from './instructions.js';

/** One discovered skill as the Settings page sees it. \`source\` is the resolved configured root it came from. */
export interface SkillListing { id: string; name: string; description: string; source: string; enabled: boolean }

/** One instruction file as the Settings page sees it, in the order the loader injects it. */
export interface InstructionFileListing {
  id: string;
  scope: 'global' | 'project';
  path: string;
  projectId?: string;
  status: 'loaded' | 'missing' | 'error';
  bytes?: number;
  order: number;
  error?: string;
  sha256?: string;
}

const SETTINGS_FILE = 'instruction-settings.json';
const STORAGE_VERSION = 1;
const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_DISABLED_SKILLS = 2_000;
const MAX_SKILL_ID_LENGTH = 200;

function corrupt(file: string, reason: string): Error {
  return new Error('Skill settings ' + file + ' are corrupt: ' + reason + '. Repair or delete the file; this build refuses to guess which skills are enabled.');
}

function loadDisabledSkillIds(file: string): Set<string> {
  let size: number;
  try { size = statSync(file).size; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return new Set();
    throw corrupt(file, 'it cannot be inspected: ' + (error instanceof Error ? error.message : String(error)));
  }
  if (size > MAX_SETTINGS_BYTES) throw corrupt(file, 'it is ' + size + ' bytes, larger than the ' + MAX_SETTINGS_BYTES + ' byte skill switch file');
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error: unknown) { throw corrupt(file, 'it cannot be read: ' + (error instanceof Error ? error.message : String(error))); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw corrupt(file, 'it is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw corrupt(file, 'the root value must be an object');
  const record = parsed as Record<string, unknown>;
  if (record.version !== STORAGE_VERSION) throw corrupt(file, 'unsupported version ' + JSON.stringify(record.version));
  const ids = record.disabledSkillIds;
  if (!Array.isArray(ids)) throw corrupt(file, 'disabledSkillIds must be an array of skill ids');
  if (ids.length > MAX_DISABLED_SKILLS) throw corrupt(file, 'it lists more than ' + MAX_DISABLED_SKILLS + ' disabled skill ids');
  const disabled = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !id || id.length > MAX_SKILL_ID_LENGTH) {
      throw corrupt(file, 'every disabled skill id must be a string of at most ' + MAX_SKILL_ID_LENGTH + ' characters');
    }
    disabled.add(id);
  }
  return disabled;
}

function instructionFileId(scope: 'global' | 'project', projectId: string | undefined, identity: string): string {
  return 'instruction-' + createHash('sha256').update(scope + ':' + (projectId ?? '') + ':' + identity).digest('hex').slice(0, 32);
}

/**
 * Persisted Instructions/Skills settings.
 *
 * Invariants: the disabled set is the single source of truth shared by Settings, Chat and Work loaders,
 * so a switch changes what the next model request contains and not just what the page shows. Writes are
 * atomic (temporary file + rename) and the file is an explicit versioned JSON document; a corrupt file is
 * reported instead of being reset, because silently re-enabling disabled skills is worse than a clear
 * failure. An unknown id is rejected, never remembered.
 */
export class InstructionSettings {
  private readonly file: string;
  private readonly disabled: Set<string>;

  constructor(options: { dataDir: string }) {
    if (typeof options?.dataDir !== 'string' || !options.dataDir) throw new Error('InstructionSettings requires a data directory.');
    const dataDir = path.resolve(options.dataDir);
    if (!isLocalPath(dataDir)) throw new Error('Instruction settings data must live on the volume that hosts this installation.');
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, SETTINGS_FILE);
    this.disabled = loadDisabledSkillIds(this.file);
  }

  /** Sorted ids currently switched off; the loader receives exactly this list. */
  disabledSkillIds(): string[] { return [...this.disabled].sort(); }

  async listSkills(options: { skillRoots: readonly string[] }): Promise<SkillListing[]> {
    const discovered = await discoverSkills({ skillRoots: options?.skillRoots ?? [] });
    return discovered.map(skill => this.listing(skill));
  }

  async toggleSkill(id: string, enabled: boolean, options: { skillRoots: readonly string[] }): Promise<SkillListing> {
    if (typeof id !== 'string' || !id || id.length > MAX_SKILL_ID_LENGTH) {
      throw new Error('A skill id must be a non-empty string of at most ' + MAX_SKILL_ID_LENGTH + ' characters.');
    }
    if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false.');
    const discovered = await discoverSkills({ skillRoots: options?.skillRoots ?? [] });
    const skill = discovered.find(candidate => candidate.id === id);
    if (!skill) throw new Error('Unknown skill id ' + id + ': it is not under the configured skill roots. Reload Settings before toggling.');
    if (enabled) this.disabled.delete(id);
    else {
      if (!this.disabled.has(id) && this.disabled.size >= MAX_DISABLED_SKILLS) {
        throw new Error('At most ' + MAX_DISABLED_SKILLS + ' skills can be disabled.');
      }
      this.disabled.add(id);
    }
    this.persist();
    return this.listing(skill);
  }

  /**
   * Lists exactly the files the loader considers: configured global paths (listed even when missing, so a
   * typo or a foreign-volume path is visible) followed by each registered project root's AGENTS.md and
   * agent.md (only when present). Ancestor directories and system locations are never scanned here.
   */
  async listInstructionFiles(options: { globalPaths: readonly string[]; projects: readonly { id: string; path: string }[] }): Promise<InstructionFileListing[]> {
    const listings: InstructionFileListing[] = [], seen = new Set<string>();
    const add = async (requested: string, scope: 'global' | 'project', projectId?: string): Promise<void> => {
      const absolute = path.resolve(String(requested));
      if (seen.has(absolute.toLowerCase())) return;
      const result = await readBoundedText(absolute);
      if (result.status === 'missing' && scope === 'project') return;
      const identity = (result.status === 'loaded' ? path.resolve(result.path) : absolute).toLowerCase();
      if (seen.has(identity)) return;
      seen.add(absolute.toLowerCase()); seen.add(identity);
      const listing: InstructionFileListing = {
        id: instructionFileId(scope, projectId, identity),
        scope,
        ...(projectId === undefined ? {} : { projectId }),
        path: result.status === 'loaded' ? result.path : absolute,
        status: result.status,
        order: listings.length + 1,
      };
      if (result.status === 'loaded') { listing.bytes = result.bytes; listing.sha256 = result.sha256; }
      if (result.status === 'error') listing.error = result.error;
      listings.push(listing);
    };
    for (const globalPath of options?.globalPaths ?? []) await add(globalPath, 'global');
    for (const project of options?.projects ?? []) {
      await add(path.join(String(project.path), 'AGENTS.md'), 'project', project.id);
      await add(path.join(String(project.path), 'agent.md'), 'project', project.id);
    }
    return listings;
  }

  private listing(skill: DiscoveredSkill): SkillListing {
    return { id: skill.id, name: skill.name, description: skill.description, source: skill.root, enabled: !this.disabled.has(skill.id) };
  }

  private persist(): void {
    writeAtomicJson(this.file, { version: STORAGE_VERSION, disabledSkillIds: this.disabledSkillIds() });
  }
}
