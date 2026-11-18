import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FileClaimConflict, FileConflictSnapshot, Task } from '../contracts.js';
import { filePathIdentity, resolveFileTarget } from './read-set.js';
import { digest, fail } from './types.js';

interface ClaimsPort {
    db: DatabaseSync;
    epoch: string;
    tx<T>(run: () => T): T;
    task(id: string): Task | undefined;
    changed(taskId: string, action: string, claim: FileClaimConflict): void;
    capacity?(taskId: string, target: string): void;
}
type StoredClaim = FileClaimConflict & { deadline: number; authority: string };
const EDITING_MS = 60_000, RECENT_MS = 600_000, MAX_ACTIVE = 4096;
const activeTask = (task: Task) => !['paused', 'completed', 'failed', 'cancelled'].includes(task.status);
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const authorityOf = (task: Task) => digest({ generation: task.generation, policyEpoch: task.policyEpoch, goalVersion: task.goalVersion });

/** Advisory edit leases. They never replace hard delegation ownership or UNKNOWN reservations. */
export class FileClaims {
    constructor(private readonly port: ClaimsPort, private readonly clock = () => performance.now()) {
        port.tx(() => {
            port.db.exec(`CREATE TABLE IF NOT EXISTS file_claims(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),path TEXT NOT NULL,mode TEXT NOT NULL,owner_epoch TEXT NOT NULL,incarnation TEXT NOT NULL,revision INTEGER NOT NULL,deadline REAL NOT NULL,state TEXT NOT NULL,authority TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS file_claims_active ON file_claims(state,owner_epoch,deadline);
                CREATE INDEX IF NOT EXISTS file_claims_owner ON file_claims(task_id,path,state);`);
            port.db.exec('CREATE INDEX IF NOT EXISTS file_claims_owned_active ON file_claims(task_id,state,owner_epoch,mode,deadline,id)');
            // Persisted wall-clock timestamps cannot attest a prior backend's ownership.
            port.db.prepare("UPDATE file_claims SET state='expired' WHERE state='active' AND owner_epoch<>?").run(port.epoch);
        });
    }
    private task(id: string): Task { return this.port.task(id) ?? fail('NOT_FOUND', 'File claim task not found'); }
    private active(): StoredClaim[] {
        const rows = this.port.db.prepare("SELECT id,task_id AS taskId,path,mode,owner_epoch AS ownerEpoch,incarnation,revision,deadline,authority FROM file_claims WHERE state='active' AND owner_epoch=? AND deadline>? ORDER BY id LIMIT ?")
            .all(this.port.epoch, this.clock(), MAX_ACTIVE + 1) as unknown as StoredClaim[];
        if (rows.length > MAX_ACTIVE) fail('FILE_CLAIM_CAPACITY', 'Active file claim capacity exceeded; conflict checking is incomplete');
        return rows;
    }
    private public(claim: StoredClaim): FileClaimConflict { const { deadline: _, authority: __, ...value } = claim; return value; }
    private paths(task: Task, paths: string[]): string[] {
        if (!Array.isArray(paths) || !paths.length || paths.length > 32 || paths.some(item => typeof item !== 'string' || !item || item.length > 2048))
            fail('FILE_CLAIM_INPUT', 'Provide 1 to 32 project paths, each below 2048 characters');
        return [...new Set(paths.map(item => filePathIdentity(resolveFileTarget(task.workspace, item, true))))].sort();
    }
    claimFiles(taskId: string, paths: string[]): FileClaimConflict[] { return this.claim(taskId, paths, 'editing'); }
    private claim(taskId: string, paths: string[], mode: 'editing' | 'recent'): FileClaimConflict[] {
        return this.port.tx(() => {
            const task = this.task(taskId);
            if (!activeTask(task) || task.appMode === 'chat' || task.permissionMode === 'read-only') fail('FILE_CLAIM_DENIED', 'Only active writable Work tasks may claim files');
            const targets = this.paths(task, paths), active = this.active();
            const owned = active.filter(item => item.taskId === taskId);
            const additions = targets.filter(target => !owned.some(item => item.path === target)).length;
            if (owned.length + additions > 256 || active.length + additions > MAX_ACTIVE) fail('FILE_CLAIM_CAPACITY', 'Too many active file claims');
            return targets.map(target => {
                const previous = owned.find(item => item.path === target);
                const authority = authorityOf(task), changed = !previous || previous.mode !== mode || previous.authority !== authority;
                const claim: StoredClaim = previous ? { ...previous, mode, authority, revision: previous.revision + (changed ? 1 : 0), deadline: this.clock() + (mode === 'editing' ? EDITING_MS : RECENT_MS) }
                    : { id: randomUUID(), taskId, path: target, mode, ownerEpoch: this.port.epoch, incarnation: randomUUID(), revision: 1, deadline: this.clock() + (mode === 'editing' ? EDITING_MS : RECENT_MS), authority };
                this.port.db.prepare('INSERT INTO file_claims VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,revision=excluded.revision,deadline=excluded.deadline,authority=excluded.authority')
                    .run(claim.id, taskId, target, mode, claim.ownerEpoch, claim.incarnation, claim.revision, claim.deadline, 'active', authority);
                const value = this.public(claim);
                if (changed) this.port.changed(taskId, previous ? 'mode_changed' : 'claimed', value);
                return value;
            });
        });
    }
    releaseClaims(taskId: string, ids: string[]): void {
        if (!Array.isArray(ids) || ids.length > 256 || ids.some(id => typeof id !== 'string')) fail('FILE_CLAIM_INPUT', 'Release at most 256 claim ids');
        this.port.tx(() => {
            this.task(taskId);
            for (const claim of this.active().filter(item => ids.includes(item.id))) {
                if (claim.taskId !== taskId) fail('WRONG_TASK', 'File claim belongs to another task');
                this.port.db.prepare("UPDATE file_claims SET state='released' WHERE id=?").run(claim.id);
                this.port.changed(taskId, 'released', this.public(claim));
            }
        });
    }
    taskChanged(task: Task): void {
        if (activeTask(task) && task.appMode !== 'chat' && task.permissionMode !== 'read-only') {
            const authority = authorityOf(task);
            for (const claim of this.active().filter(item => item.taskId === task.id && item.authority !== authority)) {
                this.port.db.prepare('UPDATE file_claims SET authority=?,revision=revision+1 WHERE id=?').run(authority, claim.id);
                this.port.changed(task.id, 'owner_changed', { ...this.public(claim), revision: claim.revision + 1 });
            }
            return;
        }
        this.releaseClaims(task.id, this.active().filter(item => item.taskId === task.id).map(item => item.id));
    }
    afterRead(taskId: string, target: string): void {
        this.automaticClaim(taskId, target, 'editing');
    }
    private automaticClaim(taskId: string, target: string, mode: 'editing' | 'recent'): void {
        const task = this.task(taskId);
        if (activeTask(task) && task.appMode !== 'chat' && task.permissionMode !== 'read-only') {
            const canonical = this.paths(task, [target])[0]!, active = this.active(), owned = active.filter(item => item.taskId === taskId);
            if (!owned.some(item => item.path === canonical) && (owned.length >= 256 || active.length >= MAX_ACTIVE)) {
                // A real read already happened. Capacity cannot turn its truthful receipt into
                // UNKNOWN, and this explicit warning must not be mistaken for a successful claim.
                this.port.capacity?.(taskId, canonical); return;
            }
            this.claim(taskId, [target], mode);
        }
    }
    afterWrite(taskId: string, target: string): void {
        this.automaticClaim(taskId, target, 'recent');
    }
    maintain(): void {
        this.port.tx(() => {
            const tick = this.clock();
            // Expiration takes effect in every active query, even if this maintenance never ran.
            const expired = this.port.db.prepare("SELECT id,task_id AS taskId,path,mode,owner_epoch AS ownerEpoch,incarnation,revision,deadline,authority FROM file_claims WHERE state='active' AND owner_epoch=? AND deadline<=? ORDER BY deadline,id LIMIT 128").all(this.port.epoch, tick) as unknown as StoredClaim[];
            for (const claim of expired) {
                this.port.db.prepare("UPDATE file_claims SET state='expired' WHERE id=?").run(claim.id);
                this.port.changed(claim.taskId, 'expired', this.public(claim));
            }
            for (const claim of this.active()) {
                const task = this.port.task(claim.taskId);
                if (!task || !activeTask(task) || task.appMode === 'chat' || task.permissionMode === 'read-only') {
                    this.port.db.prepare("UPDATE file_claims SET state='released' WHERE id=?").run(claim.id);
                    if (task) this.port.changed(task.id, 'released', this.public(claim));
                } else if (claim.mode === 'editing') this.port.db.prepare('UPDATE file_claims SET deadline=? WHERE id=?').run(tick + EDITING_MS, claim.id);
            }
        });
    }
    claims(workspace: string, after = '', limit = 40): { items: FileClaimConflict[]; nextCursor?: string } {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('FILE_CLAIM_INPUT', 'Claim page limit must be 1 to 100');
        const root = filePathIdentity(resolveFileTarget(workspace, '.', true));
        const matches = this.active().filter(item => item.id > after && overlaps(root, item.path));
        const items = matches.slice(0, limit).map(item => this.public(item));
        return { items, ...(matches.length > limit ? { nextCursor: items.at(-1)!.id } : {}) };
    }
    commandCandidates(taskId: string, limit = 32): { paths: string[]; total: number; omitted: number; truncated: boolean } {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) fail('FILE_CLAIM_INPUT', 'Candidate limit must be 1 to 32');
        const root = filePathIdentity(resolveFileTarget(this.task(taskId).workspace, '.', true));
        // active() is capped at 4096 globally and fails closed if the cap is violated.
        const priorities = new Map<string, number>();
        for (const claim of this.active()) if (overlaps(root, claim.path)) {
            const priority = claim.taskId !== taskId && claim.mode === 'editing' ? 0 : claim.taskId !== taskId ? 1 : 2;
            priorities.set(claim.path, Math.min(priorities.get(claim.path) ?? 3, priority));
        }
        const all = [...priorities].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
        const paths = all.slice(0, limit).map(([target]) => target);
        return { paths, total: all.length, omitted: all.length - paths.length, truncated: all.length > paths.length };
    }
    snapshot(taskId: string, paths: string[]): FileConflictSnapshot {
        const targets = this.paths(this.task(taskId), paths);
        const conflicts = this.active().filter(item => item.taskId !== taskId && item.mode === 'editing' && targets.some(target => overlaps(target, item.path))).map(item => this.public(item));
        return { version: 1, paths: targets, fingerprint: digest(conflicts), conflicts };
    }
    claimedPaths(taskId: string, limit = 3): { paths: string[]; total: number } {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) fail('FILE_CLAIM_INPUT', 'Claim summary limit must be 1 to 32');
        const tick = this.clock();
        const where = "task_id=? AND state='active' AND owner_epoch=? AND mode='editing' AND deadline>?";
        const total = Number(this.port.db.prepare(`SELECT COUNT(*) AS count FROM file_claims WHERE ${where}`).get(taskId, this.port.epoch, tick)!.count);
        const rows = this.port.db.prepare(`SELECT path FROM file_claims WHERE ${where} ORDER BY deadline,id LIMIT ?`).all(taskId, this.port.epoch, tick, limit);
        return { paths: rows.map(row => String(row.path)), total };
    }
    assertSnapshot(taskId: string, snapshot: FileConflictSnapshot): void {
        if (this.snapshot(taskId, snapshot.paths).fingerprint !== snapshot.fingerprint)
            fail('FILE_CONFLICT_STALE', 'The editing conflict set changed. Review a new proposal; the previous approval cannot be reused.');
    }
}
