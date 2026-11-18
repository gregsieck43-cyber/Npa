import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { Task } from '../contracts.js';
import { filePathIdentity, resolveFileTarget } from './read-set.js';
import { digest, fail } from './types.js';

interface FileVersion { path: string; kind: 'artifact' | 'input'; sourceIntentId: string; sha256: string | null; bytes: number; }
type Snapshot = { version: 1; count: number; sha256: string };

function *versions(db: DatabaseSync, verificationId: string): Generator<FileVersion> {
    let after = '';
    for (;;) {
        const rows = db.prepare('SELECT path,kind,source_intent_id AS sourceIntentId,sha256,bytes FROM verification_file_versions WHERE verification_id=? AND path>? ORDER BY path LIMIT 64').all(verificationId, after) as unknown as FileVersion[];
        for (const row of rows) yield row;
        if (rows.length < 64) return;
        after = rows.at(-1)!.path;
    }
}

/** File content is bounded by its original tool observation; unexpected growth fails before reading. */
function assertObserved(task: Task, version: FileVersion): void {
    let descriptor: number | undefined;
    try {
        const target = resolveFileTarget(task.workspace, version.path);
        if (version.sha256 === null) {
            try { lstatSync(target); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
            fail('STALE_VERIFICATION', 'A verified absent input now exists');
        }
        descriptor = openSync(target, 'r');
        const info = fstatSync(descriptor);
        if (!info.isFile() || info.size !== version.bytes) fail('STALE_VERIFICATION', 'Verified file size or type changed');
        const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
        let position = 0;
        while (position < version.bytes) {
            const read = readSync(descriptor, buffer, 0, Math.min(buffer.length, version.bytes - position), position);
            if (!read) fail('STALE_VERIFICATION', 'Verified file was truncated');
            hash.update(buffer.subarray(0, read)); position += read;
        }
        if (fstatSync(descriptor).size !== version.bytes || hash.digest('hex') !== version.sha256)
            fail('STALE_VERIFICATION', 'Verified file contents changed');
    } catch (error) {
        fail('STALE_VERIFICATION', `File version is no longer verified: ${path.relative(task.workspace, version.path)} (${error instanceof Error ? error.message : String(error)}). Run independent verification again.`);
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Capture trusted read heads and applied outputs, never the model's claimed file hashes. */
export function captureFileVerification(db: DatabaseSync, task: Task, verificationId: string): Snapshot {
    const insert = db.prepare('INSERT INTO verification_file_versions(verification_id,path,kind,source_intent_id,sha256,bytes) VALUES(?,?,?,?,?,?) ON CONFLICT(verification_id,path) DO UPDATE SET kind=excluded.kind,source_intent_id=excluded.source_intent_id,sha256=excluded.sha256,bytes=excluded.bytes');
    let cursor = 0;
    for (;;) {
        // One bounded write body at a time; content can be as large as the tool's UTF-16 limit.
        const row = db.prepare("SELECT i.rowid AS seq,i.id,json_extract(i.body,'$.arguments.path') AS path,json_extract(i.body,'$.arguments.content') AS content FROM intents i WHERE i.task_id=? AND i.state='applied' AND i.write_target IS NOT NULL AND i.rowid>? AND NOT EXISTS (SELECT 1 FROM intents newer WHERE newer.task_id=i.task_id AND newer.state='applied' AND newer.write_target=i.write_target AND newer.rowid>i.rowid) ORDER BY i.rowid LIMIT 1").get(task.id, cursor);
        if (!row) break;
        const target = filePathIdentity(resolveFileTarget(task.workspace, String(row.path))), content = String(row.content);
        insert.run(verificationId, target, 'artifact', String(row.id), createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content));
        cursor = Number(row.seq);
    }
    cursor = 0;
    for (;;) {
        const rows = db.prepare('SELECT r.seq,r.path,r.source_intent_id,r.sha256,r.bytes FROM file_read_versions r WHERE r.task_id=? AND r.seq>? AND NOT EXISTS (SELECT 1 FROM file_read_versions newer WHERE newer.task_id=r.task_id AND newer.path=r.path AND newer.seq>r.seq) ORDER BY r.seq LIMIT 64').all(task.id, cursor);
        for (const row of rows) {
            // A task's own verified output supersedes its earlier input baseline on that path.
            if (!db.prepare('SELECT 1 FROM verification_file_versions WHERE verification_id=? AND path=?').get(verificationId, String(row.path)))
                insert.run(verificationId, String(row.path), 'input', String(row.source_intent_id), row.sha256 === null ? null : String(row.sha256), Number(row.bytes));
        }
        if (rows.length < 64) break;
        cursor = Number(rows.at(-1)!.seq);
    }
    const hash = createHash('sha256'); let count = 0;
    for (const version of versions(db, verificationId)) { assertObserved(task, version); hash.update(digest(version) + '\n'); count++; }
    const snapshot: Snapshot = { version: 1, count, sha256: hash.digest('hex') };
    db.prepare('INSERT INTO verification_file_snapshots(verification_id,version,file_count,sha256) VALUES(?,?,?,?)').run(verificationId, snapshot.version, snapshot.count, snapshot.sha256);
    return snapshot;
}

/** Completion, delegated acceptance and final parent acceptance all recheck the frozen versions. */
export function assertFileVerification(db: DatabaseSync, task: Task, verificationId: string): void {
    const snapshot = db.prepare('SELECT version,file_count,sha256 FROM verification_file_snapshots WHERE verification_id=?').get(verificationId);
    if (!snapshot) {
        const fileEvidence = db.prepare("SELECT 1 FROM intents WHERE task_id=? AND state='applied' AND (write_target IS NOT NULL OR json_extract(body,'$.name')='read_file') LIMIT 1").get(task.id);
        if (fileEvidence) fail('STALE_VERIFICATION', 'This old verification has no attested file-version snapshot. Verify the files again before accepting.');
        return;
    }
    if (snapshot.version !== 1) fail('STALE_VERIFICATION', 'Unsupported file verification snapshot');
    const hash = createHash('sha256'); let count = 0;
    for (const version of versions(db, verificationId)) { assertObserved(task, version); hash.update(digest(version) + '\n'); count++; }
    if (count !== snapshot.file_count || hash.digest('hex') !== snapshot.sha256) fail('STALE_VERIFICATION', 'File verification evidence is incomplete or changed');
}
