import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { assertLocalPath } from './local-paths.js';

const REFRESH_MS = 15000, LEASE_MS = 30000, MAX_BYTES = 16384, MAX_FILES = 64, MAX_ENTRIES = 128;
export interface PresenceParticipantSummary { label: string; objective?: string; status?: string }
export interface PresencePublication { workspace: string; label: string; objective: string; claims?: string[]; participants?: PresenceParticipantSummary[] }
export interface ExternalPresence {
  id: string; source: 'external'; advisory: true; label: string; objective: string; claims: string[];
  participants: PresenceParticipantSummary[]; reportedHeartbeatAt: string; observedAt: string;
}
export interface ExternalPresenceSnapshot { items: ExternalPresence[]; truncated: boolean; rejected: number }
export interface WorkspacePresenceChange { workspace: string; joined: ExternalPresence[]; changed: ExternalPresence[]; left: string[] }
export interface WorkspacePresenceResult { changes: WorkspacePresenceChange[]; errors: { workspace: string; code: string }[] }
interface Document { schema: 1; label: string; objective: string; claims: string[]; participants: PresenceParticipantSummary[]; heartbeatAt: string; sequence: number }
interface Observation { fingerprint: string; semantic: string; touched: number; value: ExternalPresence }
interface WorkspaceState {
  workspace: string; ownedHash?: string; sequence: number; observations: Map<string, Observation>;
  published: Map<string, Observation>; truncated: boolean; rejected: number;
}
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const identity = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
function problem(code: string): never { throw Object.assign(new Error(code), { code }); }
const errorCode = (error: unknown) => typeof (error as NodeJS.ErrnoException)?.code === 'string' ? (error as NodeJS.ErrnoException).code! : 'PRESENCE_IO';
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) problem('PRESENCE_SCHEMA');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\x00-\x1f\x7f]/.test(value)) problem('PRESENCE_FIELD');
  return value;
}
function summaries(value: unknown): PresenceParticipantSummary[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) problem('PRESENCE_PARTICIPANTS');
  return value.map(item => {
    const row = record(item, ['label', 'objective', 'status']);
    return { label: text(row.label, 160), ...(row.objective === undefined ? {} : { objective: text(row.objective, 240, true) }), ...(row.status === undefined ? {} : { status: text(row.status, 40) }) };
  });
}
function claims(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) problem('PRESENCE_CLAIMS');
  return [...new Set(value.map(item => {
    const claim = text(item, 240).replaceAll('\\', '/');
    if (path.posix.isAbsolute(claim) || path.win32.isAbsolute(claim) || /[<>:"|?*]/.test(claim) || claim.split('/').some(part => !part || part === '..' || part === '.')) problem('PRESENCE_CLAIM_PATH');
    return claim;
  }))];
}
function parse(value: unknown): Document {
  const row = record(value, ['schema', 'label', 'objective', 'claims', 'participants', 'heartbeatAt', 'sequence']);
  if (row.schema !== 1 || !Number.isSafeInteger(row.sequence) || (row.sequence as number) < 0) problem('PRESENCE_SCHEMA');
  const heartbeatAt = text(row.heartbeatAt, 40);
  if (!Number.isFinite(Date.parse(heartbeatAt))) problem('PRESENCE_HEARTBEAT');
  return { schema: 1, label: text(row.label, 160), objective: text(row.objective, 400, true), claims: claims(row.claims), participants: summaries(row.participants), heartbeatAt, sequence: row.sequence as number };
}
const semantic = (value: Document) => digest(JSON.stringify({ label: value.label, objective: value.objective, claims: value.claims, participants: value.participants }));

/** Advisory file exchange only. It has no Kernel port and cannot create claims, locks or authority. */
export class WorkspacePresence {
  readonly ownerId = `npn-${randomBytes(24).toString('hex')}`;
  private readonly states = new Map<string, WorkspaceState>();
  private readonly clock: () => number;
  private lastSync = -Infinity;
  private lastPublications = '';
  private running?: Promise<WorkspacePresenceResult>;
  private closed = false;
  constructor(private readonly authorizeWorkspace: (workspace: string) => string, options: { clock?: () => number } = {}) { this.clock = options.clock ?? (() => performance.now()); }

  private async workspace(value: string): Promise<string> {
    const allowed = assertLocalPath(this.authorizeWorkspace(value), 'Presence workspace');
    const info = await lstat(allowed);
    if (!info.isDirectory() || info.isSymbolicLink()) problem('PRESENCE_WORKSPACE');
    const canonical = await realpath(allowed);
    if (identity(canonical) !== identity(allowed)) problem('PRESENCE_LINK');
    return canonical;
  }
  private async directory(workspace: string, create: boolean): Promise<string | undefined> {
    // Reauthorize on every filesystem operation, including cleanup after revocation.
    if (identity(await this.workspace(workspace)) !== identity(workspace)) problem('PRESENCE_WORKSPACE');
    let current = workspace;
    for (const part of ['.npn', 'presence']) {
      current = path.join(current, part); assertLocalPath(current, 'Presence directory');
      let info = await lstat(current).catch(error => { if (errorCode(error) !== 'ENOENT') throw error; });
      if (!info && create) { await mkdir(current, { mode: 0o700 }).catch(error => { if (errorCode(error) !== 'EEXIST') throw error; }); info = await lstat(current); }
      if (!info) return undefined;
      if (!info.isDirectory() || info.isSymbolicLink() || identity(await realpath(current)) !== identity(current)) problem('PRESENCE_LINK');
    }
    return current;
  }
  private async read(workspace: string, name: string): Promise<{ bytes: Buffer; fingerprint: string }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}\.json$/.test(name)) problem('PRESENCE_FILENAME');
    const dir = await this.directory(workspace, false); if (!dir) problem('ENOENT');
    const file = path.join(dir, name), before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) problem('PRESENCE_FILE');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES || stat.dev !== before.dev || stat.ino !== before.ino) problem('PRESENCE_FILE_CHANGED');
      if (identity(await realpath(file)) !== identity(file)) problem('PRESENCE_LINK');
      await this.directory(workspace, false);
      const buffer = Buffer.alloc(MAX_BYTES + 1), result = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat(), current = await lstat(file);
      if (result.bytesRead !== stat.size || result.bytesRead > MAX_BYTES || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || current.dev !== stat.dev || current.ino !== stat.ino || current.isSymbolicLink()) problem('PRESENCE_FILE_CHANGED');
      const bytes = buffer.subarray(0, result.bytesRead);
      return { bytes, fingerprint: `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${digest(bytes)}` };
    } finally { await handle.close(); }
  }
  private async publish(state: WorkspaceState, publication: PresencePublication): Promise<void> {
    const document = parse({ schema: 1, label: publication.label, objective: publication.objective, claims: publication.claims, participants: publication.participants, heartbeatAt: new Date().toISOString(), sequence: ++state.sequence });
    const bytes = Buffer.from(JSON.stringify(document)); if (bytes.length > MAX_BYTES) problem('PRESENCE_SIZE');
    const dir = await this.directory(state.workspace, true); if (!dir) problem('PRESENCE_DIRECTORY');
    const name = `${this.ownerId}.json`;
    const existing = await this.read(state.workspace, name).catch(error => { if (errorCode(error) !== 'ENOENT') throw error; });
    if (existing && (!state.ownedHash || digest(existing.bytes) !== state.ownedHash)) problem('PRESENCE_OWNER_CHANGED');
    const temporary = path.join(dir, `.${this.ownerId}-${randomBytes(12).toString('hex')}.tmp`);
    let created = false;
    try {
      await this.directory(state.workspace, false);
      const handle = await open(temporary, 'wx', 0o600); created = true;
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await this.directory(state.workspace, false);
      const latest = await this.read(state.workspace, name).catch(error => { if (errorCode(error) !== 'ENOENT') throw error; });
      if (latest && (!state.ownedHash || digest(latest.bytes) !== state.ownedHash)) problem('PRESENCE_OWNER_CHANGED');
      await rename(temporary, path.join(dir, name)); created = false;
      state.ownedHash = digest(bytes);
    } finally {
      if (created) { await this.directory(state.workspace, false); await unlink(temporary).catch(error => { if (errorCode(error) !== 'ENOENT') throw error; }); }
    }
  }
  private async removeOwn(state: WorkspaceState): Promise<void> {
    if (!state.ownedHash) return;
    const name = `${this.ownerId}.json`;
    const own = await this.read(state.workspace, name).catch(error => { if (errorCode(error) !== 'ENOENT') throw error; });
    if (!own || digest(own.bytes) !== state.ownedHash) return;
    const dir = await this.directory(state.workspace, false);
    if (dir) await unlink(path.join(dir, name)).catch(error => { if (errorCode(error) !== 'ENOENT') throw error; });
  }
  private async scan(state: WorkspaceState, now: number): Promise<WorkspacePresenceChange> {
    const next = new Map<string, Observation>(), visitedNames = new Set<string>(), dir = await this.directory(state.workspace, false);
    let visited = 0, files = 0, rejected = 0, truncated = false;
    if (dir) for await (const entry of await opendir(dir, { bufferSize: 16 })) {
      if (++visited > MAX_ENTRIES || files >= MAX_FILES) { truncated = true; break; }
      if (!entry.name.endsWith('.json')) continue;
      visitedNames.add(entry.name);
      files++;
      try {
        const file = await this.read(state.workspace, entry.name);
        if (entry.name === `${this.ownerId}.json` && digest(file.bytes) === state.ownedHash) continue;
        const document = parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes))), prior = state.observations.get(entry.name);
        const changed = prior?.fingerprint !== file.fingerprint;
        const value: ExternalPresence = { id: `external-${digest(identity(state.workspace) + '\0' + entry.name).slice(0, 32)}`, source: 'external', advisory: true,
          label: document.label, objective: document.objective, claims: document.claims, participants: document.participants,
          reportedHeartbeatAt: document.heartbeatAt, observedAt: changed ? new Date().toISOString() : prior!.value.observedAt };
        next.set(entry.name, { fingerprint: file.fingerprint, semantic: semantic(document), touched: changed ? now : prior!.touched, value });
      } catch { rejected++; }
    }
    // A truncated directory cannot prove omitted peers departed; their previous lease still expires.
    if (truncated) for (const [name, observation] of state.observations) if (next.size < MAX_FILES && !visitedNames.has(name) && now - observation.touched < LEASE_MS) next.set(name, observation);
    const active = new Map([...next].filter(([, observation]) => now - observation.touched < LEASE_MS));
    const joined: ExternalPresence[] = [], changed: ExternalPresence[] = [];
    for (const [name, observation] of active) {
      if (!state.published.has(name)) joined.push(observation.value);
      else if (state.published.get(name)!.semantic !== observation.semantic) changed.push(observation.value);
    }
    const left = [...state.published].filter(([name]) => !active.has(name)).map(([, observation]) => observation.value.id);
    state.observations = next; state.published = active; state.truncated = truncated; state.rejected = rejected;
    return { workspace: state.workspace, joined, changed, left };
  }
  sync(publications: PresencePublication[]): Promise<WorkspacePresenceResult> {
    if (this.closed) return Promise.reject(new Error('PRESENCE_CLOSED'));
    if (!Array.isArray(publications) || publications.length > 64) return Promise.reject(new Error('PRESENCE_WORKSPACES'));
    if (this.running) return this.running;
    // Copy and bound caller-owned values before async filesystem work or serialization.
    let bounded: PresencePublication[];
    try {
      bounded = publications.map(publication => ({ workspace: text(publication.workspace, 4096), label: text(publication.label, 160), objective: text(publication.objective, 400, true), claims: claims(publication.claims), participants: summaries(publication.participants) }));
    } catch (error) { return Promise.reject(error); }
    const signature = JSON.stringify(bounded), now = this.clock();
    if (signature === this.lastPublications && now - this.lastSync < REFRESH_MS) return Promise.resolve({ changes: [], errors: [] });
    this.running = this.refresh(bounded, now).then(result => { this.lastPublications = signature; this.lastSync = now; return result; }).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async refresh(publications: PresencePublication[], now: number): Promise<WorkspacePresenceResult> {
    const result: WorkspacePresenceResult = { changes: [], errors: [] }, active = new Set<string>();
    for (const publication of publications) {
      try {
        const workspace = await this.workspace(publication.workspace), key = identity(workspace);
        if (active.has(key)) problem('PRESENCE_DUPLICATE_WORKSPACE'); active.add(key);
        let state = this.states.get(key);
        if (!state) { state = { workspace, sequence: 0, observations: new Map(), published: new Map(), truncated: false, rejected: 0 }; this.states.set(key, state); }
        try { await this.publish(state, publication); } catch (error) { result.errors.push({ workspace, code: errorCode(error) }); }
        result.changes.push(await this.scan(state, now));
      } catch (error) { result.errors.push({ workspace: publication.workspace, code: errorCode(error) }); }
    }
    for (const [key, state] of this.states) if (!active.has(key)) {
      try { await this.removeOwn(state); } catch (error) { result.errors.push({ workspace: state.workspace, code: errorCode(error) }); }
      result.changes.push({ workspace: state.workspace, joined: [], changed: [], left: [...state.published.values()].map(item => item.value.id) }); this.states.delete(key);
    }
    return result;
  }
  snapshot(workspace: string): ExternalPresenceSnapshot {
    const key = identity(assertLocalPath(this.authorizeWorkspace(workspace), 'Presence workspace')), state = this.states.get(key), now = this.clock();
    return state ? { items: [...state.observations.values()].filter(value => now - value.touched < LEASE_MS).slice(0, MAX_FILES).map(value => structuredClone(value.value)), truncated: state.truncated, rejected: state.rejected } : { items: [], truncated: false, rejected: 0 };
  }
  async close(): Promise<void> {
    this.closed = true; await this.running;
    const errors: unknown[] = [];
    for (const state of this.states.values()) try { await this.removeOwn(state); } catch (error) { errors.push(error); }
    this.states.clear();
    if (errors.length) throw new AggregateError(errors, 'Presence cleanup failed; owned files were preserved.');
  }
}
