import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Intent, Task } from '../contracts.js';
import { isForbiddenRelative } from '../tools/policy.js';
import { digest, fail, KernelError } from './types.js';

export interface FileVersionChange { taskId: string; path: string; sourceIntentId: string | null; before: string | null; after: string | null; }
/** Created only after provenance and disk bytes are checked; not a model-supplied error string. */
export class FileVersionChangedError extends KernelError {
    readonly observation: Readonly<FileVersionChange>;
    notificationError?: string;
    constructor(observation: FileVersionChange) {
        super('READ_VERSION_STALE', 'File changed since the bound read. Read it again and prepare a new write; approval cannot refresh the baseline.');
        this.observation = Object.freeze({ ...observation });
    }
}
/** A worker read receipt, or an explicit observation that a new target is absent. */
export interface ReadVersion { path: string; sha256: string | null; sourceIntentId: string | null; }
export const filePathIdentity = (filename: string): string => {
    const normalized = path.normalize(filename).replaceAll('\\', '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

/** Synchronous counterpart of the gateway boundary, used inside the dispatch transaction. */
export function resolveFileTarget(workspace: string, requested: string, allowRoot = false): string {
    // New tasks may not have materialized their private workspace yet. Canonicalize its
    // nearest existing ancestor without creating directories as an approval side effect.
    let ancestor = path.resolve(workspace);
    const missing: string[] = [];
    let root: string;
    for (;;) {
        try { root = path.join(realpathSync(ancestor), ...missing.reverse()); break; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
            missing.push(path.basename(ancestor)); ancestor = path.dirname(ancestor);
        }
    }
    const target = path.resolve(root, requested);
    const relative = path.relative(root, target);
    if (!relative && !allowRoot || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative && isForbiddenRelative(relative))
        fail('PERMISSION_DENIED', 'File target is outside the workspace or protected');
    let current = root;
    for (const part of relative.split(path.sep)) {
        current = path.join(current, part);
        try {
            if (lstatSync(current).isSymbolicLink()) fail('PERMISSION_DENIED', 'File targets cannot traverse links or junctions');
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
    }
    return target;
}
const targetPath = resolveFileTarget;

function diskVersion(target: string): string | null {
    try {
        const info = lstatSync(target);
        if (!info.isFile() || info.size > 1_048_576) fail('READ_VERSION_STALE', 'File is no longer a regular file below 1 MiB');
        return createHash('sha256').update(readFileSync(target)).digest('hex');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Uses the Kernel transaction: receipt, read set and effect settlement commit together. */
export class FileReadSet {
    constructor(private readonly db: DatabaseSync) {}

    /** Upgrade only unresolved old effects in bounded batches; never discard their reservation. */
    migratePending(): void {
        let cursor = 0;
        for (;;) {
            const rows = this.db.prepare("SELECT i.rowid AS seq,i.id,i.body AS intent,t.body AS task FROM intents i JOIN tasks t ON t.id=i.task_id WHERE i.rowid>? AND i.state IN ('sent','unknown') AND json_extract(i.body,'$.name') IN ('read_file','write_file') AND NOT EXISTS (SELECT 1 FROM intent_file_targets f WHERE f.intent_id=i.id) ORDER BY i.rowid LIMIT 128").all(cursor);
            if (!rows.length) return;
            for (const row of rows) {
                const intent = JSON.parse(String(row.intent)) as Intent, task = JSON.parse(String(row.task)) as Task;
                const target = filePathIdentity(targetPath(task.workspace, String(intent.arguments.path)));
                this.db.prepare('INSERT INTO intent_file_targets(intent_id,path) VALUES(?,?)').run(intent.id, target);
            }
            cursor = Number(rows.at(-1)!.seq);
        }
    }
    settle(intentId: string): void { this.db.prepare('DELETE FROM intent_file_targets WHERE intent_id=?').run(intentId); }

    get(task: Task, requested: string): ReadVersion | undefined {
        const target = filePathIdentity(targetPath(task.workspace, requested));
        const row = this.db.prepare('SELECT source_intent_id,sha256 FROM file_read_versions WHERE task_id=? AND path=? ORDER BY seq DESC LIMIT 1').get(task.id, target);
        return row ? { path: target, sha256: row.sha256 === null ? null : String(row.sha256), sourceIntentId: String(row.source_intent_id) } : undefined;
    }

    bind(task: Task, args: Record<string, unknown>): Record<string, unknown> {
        const target = targetPath(task.workspace, String(args.path));
        const observed = this.get(task, target);
        // A previously read file disappearing is stale, not implicit permission to recreate it.
        const version = observed ?? { path: filePathIdentity(target), sha256: null, sourceIntentId: null };
        if (!observed && diskVersion(target) !== null) fail('READ_REQUIRED', 'Read the existing file before proposing a write');
        // Prepared gateway artifacts retain their original read, including across approval/rebind.
        const bound = args.readVersion === undefined ? version : args.readVersion;
        const next = { ...args, expectedSha256: args.readVersion === undefined ? version.sha256 : args.expectedSha256, readVersion: bound };
        this.assert(task, next);
        return next;
    }

    assert(task: Task, args: Record<string, unknown>): void {
        const target = targetPath(task.workspace, String(args.path));
        const version = args.readVersion as ReadVersion | undefined;
        if (!version || typeof version !== 'object' || version.path !== filePathIdentity(target) || version.sha256 !== args.expectedSha256)
            fail('READ_REQUIRED', 'Write has no trusted read-version binding; prepare a new proposal');
        if (version.sourceIntentId === null) {
            if (version.sha256 !== null || this.get(task, target)) fail('READ_VERSION_STALE', 'An absence proposal cannot replace an existing task read');
        } else {
            if (typeof version.sourceIntentId !== 'string') fail('READ_REQUIRED', 'Write source must be a recorded task read');
            const source = this.db.prepare('SELECT sha256 FROM file_read_versions WHERE source_intent_id=? AND task_id=? AND path=?').get(version.sourceIntentId, task.id, version.path);
            if (!source || source.sha256 !== version.sha256) fail('READ_REQUIRED', 'Write source does not match a trusted read of this task and path');
        }
        const actual = diskVersion(target);
        if (actual !== version.sha256) throw new FileVersionChangedError({ taskId: task.id, path: version.path, sourceIntentId: version.sourceIntentId, before: version.sha256, after: actual });
    }

    record(task: Task, intent: Intent, receipt: Record<string, unknown>): void {
        const target = targetPath(task.workspace, String(intent.arguments.path));
        // The worker digest deliberately excludes Kernel capability, generation and policy metadata.
        if (receipt.effectKey !== intent.effectKey || receipt.digest !== digest({ name: intent.name, arguments: intent.arguments })
            || typeof receipt.path !== 'string' || filePathIdentity(targetPath(task.workspace, receipt.path)) !== filePathIdentity(target)
            || !(typeof receipt.sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.sha256) || receipt.sha256 === null && receipt.exists === false && receipt.bytes === 0)
            || !Number.isSafeInteger(receipt.bytes) || Number(receipt.bytes) < 0 || Number(receipt.bytes) > 1_048_576
            || typeof receipt.output !== 'string') fail('READ_RECEIPT_INVALID', 'Read receipt does not bind the dispatched worker effect and file');
        this.db.prepare('INSERT INTO file_read_versions(source_intent_id,task_id,path,sha256,bytes,observed_at) VALUES(?,?,?,?,?,?)')
            .run(intent.id, task.id, filePathIdentity(target), receipt.sha256 as string | null, Number(receipt.bytes), new Date().toISOString());
    }

    assertAvailable(task: Task, intent: Intent): void {
        const target = filePathIdentity(targetPath(task.workspace, String(intent.arguments.path)));
        // Sent/UNKNOWN intents are the durable reservation itself. Reopen/recovery/cancellation
        // cannot drop it. The target lookup is a derived index, committed with dispatch/settlement;
        // it has no lease or independently authorizing state.
        const active = this.db.prepare("SELECT f.intent_id AS id FROM intent_file_targets f JOIN intents i ON i.id=f.intent_id WHERE f.path=? AND f.intent_id<>? AND i.state IN ('sent','unknown') LIMIT 1").get(target, intent.id);
        if (active) fail('FILE_OPERATION_PENDING', `File has an unsettled operation ${active.id}; wait for its receipt or reconciliation before dispatching`);
        this.db.prepare('INSERT INTO intent_file_targets(intent_id,path) VALUES(?,?) ON CONFLICT(intent_id) DO UPDATE SET path=excluded.path').run(intent.id, target);
    }
}
