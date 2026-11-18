import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NoteInput, NotesInput, ReadInput, SearchInput } from '../memory/archive.js';
import { HistoryArchive, ScopedMemory } from '../memory/archive.js';
import type { ScopedMemoryPort } from '../memory/tools.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const COPY_PAGE = 500;

export interface WorkMessageRow { rowid: number; id: string; body: string; createdAt: string }

/** One immutable origin layer. Work layers are prefix files; promoted layers are preserved Chat snapshots. */
export type WorkOriginLayer =
    | { kind: 'work'; taskId: string; scopeTaskId: string; through: number }
    | { kind: 'promoted'; taskId: string };

/**
 * Links one Work branch to the exact source message it forked after. The snapshot is a rowid, so the origin
 * stays a bounded immutable prefix even while the source task keeps appending messages or is removed.
 * New links also carry the source's flattened ancestry so long branch chains remain fully readable without
 * walking (or silently truncating) a fixed number of settings hops.
 */
export interface WorkBranchLink {
    sourceTaskId: string;
    sourceMessageId: string;
    snapshot: number;
    messageCount: number;
    createdAt: string;
    /** Nearest first, excluding this branch's own head layer. Absent only on links written before continuity. */
    ancestry?: WorkOriginLayer[];
}

/** One file per branched task; named by task id hash so a task id never becomes a path fragment. */
export function workOriginFile(dataDir: string, taskId: string): string {
    return path.join(dataDir, 'origins', sha256(taskId) + '.sqlite');
}

/**
 * Copy the source task's stored message rows through the selected rowid into a dedicated SQLite file.
 * The raw body text is preserved byte-for-byte, so Inspector recall hashes match the original records.
 * The whole copy commits or rolls back; callers remove the file when a later branch step fails.
 */
export function copyWorkOrigin(file: string, sourceTaskId: string, through: number, readPage: (after: number, limit: number) => WorkMessageRow[]): number {
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    try {
        db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
        db.exec('CREATE TABLE IF NOT EXISTS messages(rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL, session_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)');
        db.exec('BEGIN IMMEDIATE');
        try {
            const insert = db.prepare('INSERT INTO messages(rowid,id,task_id,session_id,body,created_at) VALUES(?,?,?,?,?,?)');
            let after = 0, count = 0;
            for (;;) {
                const rows = readPage(after, COPY_PAGE);
                for (const row of rows) {
                    if (row.rowid > through) throw new Error('The origin copy crossed the selected message boundary.');
                    insert.run(row.rowid, row.id, sourceTaskId, 'main', row.body, row.createdAt);
                    count++;
                }
                if (rows.length < COPY_PAGE) break;
                after = rows[rows.length - 1]!.rowid;
            }
            if (count === 0) throw new Error('The branch source has no messages through the selected message.');
            // Builds the same history_documents view/FTS/triggers a normal Work archive uses, so recall and search
            // go through one archive implementation rather than a parallel read format.
            new HistoryArchive(db, 'work');
            db.exec('COMMIT');
            return count;
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    } finally {
        db.close();
    }
}

/**
 * Verify that a copied origin is exactly the immutable source prefix the Kernel prepared: same source task and
 * main session, no row past the selected rowid, the selected id at that rowid, and the prepared row count.
 * Returns the verified count. Any mismatch is an error; callers fence the branch rather than use a partial file.
 */
export function verifyWorkOrigin(file: string, sourceTaskId: string, sourceMessageId: string, through: number, expectedCount: number): number {
    if (!existsSync(file)) throw new Error('The immutable branch origin file is missing.');
    const db = new DatabaseSync(file);
    try {
        const range = db.prepare('SELECT COUNT(*) AS count, MAX(rowid) AS last FROM messages WHERE task_id=? AND session_id=? AND rowid<=?')
            .get(sourceTaskId, 'main', through) as { count: number | bigint; last: number | bigint | null } | undefined;
        const count = Number(range?.count ?? 0);
        const outside = Number((db.prepare('SELECT COUNT(*) AS count FROM messages WHERE task_id<>? OR session_id<>? OR rowid>?')
            .get(sourceTaskId, 'main', through) as { count: number | bigint }).count);
        const selected = db.prepare('SELECT id FROM messages WHERE rowid=? AND task_id=? AND session_id=?')
            .get(through, sourceTaskId, 'main') as { id: string } | undefined;
        if (count !== expectedCount) throw new Error(`The immutable branch origin has ${count} messages; expected ${expectedCount}.`);
        if (outside !== 0) throw new Error('The immutable branch origin contains rows outside the selected source prefix.');
        if (Number(range?.last ?? 0) !== through) throw new Error('The immutable branch origin does not end at the selected message cursor.');
        if (!selected || selected.id !== sourceMessageId) throw new Error('The immutable branch origin does not contain the selected message.');
        return count;
    } finally {
        db.close();
    }
}

/** Remove a partially written or abandoned origin file (and its WAL sidecars), ignoring absence. */
export function discardWorkOrigin(file: string): void {
    for (const target of [file, file + '-wal', file + '-shm']) rmSync(target, { force: true });
}

/** Read-only archive view over one copied origin prefix. Opens per call like a promoted origin. */
export class WorkOriginMemory implements ScopedMemoryPort {
    constructor(private readonly file: string, private readonly sourceTaskId: string, private readonly through: number) { }
    private use<T>(action: (memory: ScopedMemory) => T): T {
        const db = new DatabaseSync(this.file);
        try { return action(new ScopedMemory(db, JSON.stringify([this.sourceTaskId, 'main']), this.through)); }
        finally { db.close(); }
    }
    manifest() { return this.use(memory => memory.manifest()); }
    search(input: SearchInput) { return this.use(memory => memory.search(input)); }
    read(input: ReadInput) { return this.use(memory => memory.read(input)); }
    remember(_input: NoteInput, _operationId: string): never { throw new Error('Immutable origin archives are read-only.'); }
    notes(input: NotesInput) { return this.use(memory => memory.notes(input)); }
    context(query: string, maxChars?: number) { return this.use(memory => memory.context(query, maxChars)); }
}

/**
 * A Work branch reads newest-first: its live task archive first, then each preserved origin (a branch of a branch
 * chains again). Reads fall through only when the record is absent from the earlier layer; other IO errors surface.
 */
export class ChainedOriginMemory implements ScopedMemoryPort {
    constructor(private readonly ports: ScopedMemoryPort[]) { }
    manifest() {
        const manifests = this.ports.map(port => port.manifest());
        return { ...manifests[0]!, messages: manifests.reduce((sum, item) => sum + item.messages, 0) };
    }
    /**
     * One stable cursor across independent immutable layers. Each layer is read in SQL pages of at most 20;
     * the global offset is consumed across layers and duplicate ids are removed before counting. A cursor is
     * only ended after every layer is exhausted, so a full first page cannot hide an older match. Origin
     * archives are immutable, so replaying a cursor from offset zero is stable; memory holds the dedupe set
     * through the cursor, not the complete match set.
     */
    search(input: SearchInput) {
        const limit = input.limit ?? 8, offset = input.offset ?? 0;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be an integer from 1 to 20.');
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new Error('offset must be an integer from 0 to 1000000.');
        const results: ReturnType<ScopedMemoryPort['search']>['results'] = [];
        const seen = new Set<string>();
        let skipped = 0, snapshot = 0, hasMore = false;
        outer: for (const port of this.ports) {
            let layerOffset = 0;
            for (;;) {
                const page = port.search({ ...input, limit: 20, offset: layerOffset });
                snapshot = Math.max(snapshot, page.snapshot);
                for (const hit of page.results) {
                    if (seen.has(hit.id)) continue;
                    seen.add(hit.id);
                    if (skipped < offset) { skipped++; continue; }
                    if (results.length === limit) { hasMore = true; break outer; }
                    results.push(hit);
                }
                if (page.nextOffset === null || page.results.length === 0) break;
                layerOffset = page.nextOffset;
            }
        }
        const nextOffset = hasMore ? offset + limit : null;
        return { results, nextOffset, snapshot, ordering: 'archive-seq-desc' as const, rawHistoryRetained: true, hint: 'Linked immutable origins are searched newest-first; read_history with an exact source ID reads any of them.' };
    }
    read(input: ReadInput) {
        let missing: unknown;
        for (const port of this.ports) {
            try { return port.read(input); }
            catch (error) {
                if (!/Source not found/i.test(String((error as Error)?.message))) throw error;
                missing = error;
            }
        }
        throw missing;
    }
    remember(_input: NoteInput, _operationId: string): never { throw new Error('Immutable origin archives are read-only.'); }
    notes(input: NotesInput) { return this.ports[0]!.notes(input); }
    context(query: string, maxChars?: number) { return this.ports[0]!.context(query, maxChars); }
}
