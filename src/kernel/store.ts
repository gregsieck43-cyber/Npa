import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { HistoryArchive } from '../memory/archive.js';
export const writePathIdentity = (value: string): string => {
    const normalized = path.normalize(value).replaceAll('\\', '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
/** SQLite schema and transaction boundary shared by domain operations. */
export class SQLiteStore {
    readonly dbPath: string;
    protected readonly db: DatabaseSync;
    protected readonly archive: HistoryArchive;
    private transactionDepth = 0;
    private readonly commitListeners = new Set<() => void>();
    private notificationPending = false;
    onCommitted(listener: () => void): () => void {
        this.commitListeners.add(listener);
        return () => { this.commitListeners.delete(listener); };
    }
    private notifyCommitted(): void {
        if (this.notificationPending || !this.commitListeners.size) return;
        this.notificationPending = true;
        queueMicrotask(() => {
            this.notificationPending = false;
            for (const listener of this.commitListeners) listener();
        });
    }
    constructor(readonly dataDir: string) {
        mkdirSync(dataDir, { recursive: true });
        this.dbPath = path.join(dataDir, 'kernel.sqlite');
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
        // Schema creation and migrations are one durable commit, including a first launch on a slow disk.
        this.tx(() => {
            this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_version VALUES(1);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES tasks(id), status TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL, contract TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(task_id, version));
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, digest TEXT NOT NULL, ack TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS derived_memories(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT NOT NULL, source_digest TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(task_id,session_id,kind,source_digest));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), generation INTEGER NOT NULL, policy_epoch INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id), effect_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, body TEXT NOT NULL, capability TEXT NOT NULL, paths TEXT NOT NULL, prepared_at TEXT);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), intent_id TEXT NOT NULL REFERENCES intents(id), state TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), intent_id TEXT NOT NULL REFERENCES intents(id), digest TEXT NOT NULL, generation INTEGER NOT NULL, policy_epoch INTEGER NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(intent_id TEXT PRIMARY KEY REFERENCES intents(id), task_id TEXT NOT NULL REFERENCES tasks(id), state TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS effects(effect_key TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES intents(id), task_id TEXT NOT NULL REFERENCES tasks(id), state TEXT NOT NULL, receipt TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS file_read_versions(seq INTEGER PRIMARY KEY AUTOINCREMENT, source_intent_id TEXT NOT NULL UNIQUE REFERENCES intents(id), task_id TEXT NOT NULL REFERENCES tasks(id), path TEXT NOT NULL, sha256 TEXT, bytes INTEGER NOT NULL, observed_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_operator_input ON messages(task_id,session_id) WHERE json_extract(body,'$.role')='user' AND json_extract(body,'$.inputOrigin') IS NOT 'runtime';
      CREATE INDEX IF NOT EXISTS file_read_versions_head ON file_read_versions(task_id,path,seq DESC);
      CREATE TABLE IF NOT EXISTS intent_file_targets(intent_id TEXT PRIMARY KEY REFERENCES intents(id),path TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS intent_file_targets_path ON intent_file_targets(path,intent_id);
      CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS verifications(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS verification_file_snapshots(verification_id TEXT PRIMARY KEY REFERENCES verifications(id),version INTEGER NOT NULL,file_count INTEGER NOT NULL,sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS verification_file_versions(verification_id TEXT NOT NULL REFERENCES verifications(id),path TEXT NOT NULL,kind TEXT NOT NULL,source_intent_id TEXT NOT NULL REFERENCES intents(id),sha256 TEXT,bytes INTEGER NOT NULL,PRIMARY KEY(verification_id,path));
      CREATE TABLE IF NOT EXISTS budgets(task_id TEXT PRIMARY KEY REFERENCES tasks(id), max_model_calls INTEGER NOT NULL, model_calls INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS side_budgets(task_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT NOT NULL, max_model_calls INTEGER NOT NULL, model_calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_id,session_id));
      CREATE TABLE IF NOT EXISTS policies(task_id TEXT PRIMARY KEY REFERENCES tasks(id), ceiling TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegations(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), child_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS path_locks(path TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), owner TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);
      CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, session_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(task_id,session_id);
      CREATE INDEX IF NOT EXISTS messages_session_role ON messages(task_id,session_id,json_extract(body,'$.role'));
      CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
      CREATE INDEX IF NOT EXISTS runs_task_status ON runs(task_id,status);
      CREATE INDEX IF NOT EXISTS checkpoints_task ON checkpoints(task_id);
      CREATE INDEX IF NOT EXISTS verifications_task ON verifications(task_id);
      CREATE INDEX IF NOT EXISTS intents_task ON intents(task_id);
      CREATE INDEX IF NOT EXISTS intents_task_state ON intents(task_id,state);
      CREATE INDEX IF NOT EXISTS events_task_type ON events(task_id,type,seq);
      CREATE INDEX IF NOT EXISTS events_time ON events(created_at);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS tasks_workspace ON tasks(lower(json_extract(body,'$.workspace')));
      CREATE INDEX IF NOT EXISTS events_command_lookup ON events(task_id,type,json_extract(payload,'$.commandId'));
      CREATE TABLE IF NOT EXISTS task_execution_owners(task_id TEXT PRIMARY KEY REFERENCES tasks(id),owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS side_control_turns(message_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id));
      CREATE TABLE IF NOT EXISTS side_binding_turns(message_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,objective TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS delegations_parent ON delegations(task_id);
      CREATE TABLE IF NOT EXISTS task_dependencies(task_id TEXT NOT NULL REFERENCES tasks(id), dependency_id TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(task_id,dependency_id), CHECK(task_id<>dependency_id));
      CREATE INDEX IF NOT EXISTS dependencies_predecessor ON task_dependencies(dependency_id);
      CREATE INDEX IF NOT EXISTS decisions_task ON decisions(task_id);
      CREATE INDEX IF NOT EXISTS memories_task ON derived_memories(task_id,session_id);
      CREATE TABLE IF NOT EXISTS task_schedule(task_id TEXT PRIMARY KEY REFERENCES tasks(id), due INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0, reason TEXT);
      CREATE TABLE IF NOT EXISTS pending_calls(task_id TEXT NOT NULL REFERENCES tasks(id), message_id TEXT NOT NULL REFERENCES messages(id), tool_call_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task_id,message_id,tool_call_id));
      CREATE INDEX IF NOT EXISTS pending_calls_task ON pending_calls(task_id,tool_call_id);
      CREATE TABLE IF NOT EXISTS task_permissions(task_id TEXT PRIMARY KEY REFERENCES tasks(id), mode TEXT NOT NULL, app TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_grants(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), workspace TEXT NOT NULL, tool TEXT NOT NULL, capability TEXT NOT NULL, resources_digest TEXT NOT NULL, policy_epoch INTEGER NOT NULL, goal_version INTEGER NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, resources TEXT NOT NULL DEFAULT '[]');
      CREATE INDEX IF NOT EXISTS session_grants_task ON session_grants(task_id, revoked);
      CREATE TABLE IF NOT EXISTS intent_reviews(intent_id TEXT PRIMARY KEY REFERENCES intents(id), task_id TEXT NOT NULL REFERENCES tasks(id), digest TEXT NOT NULL, generation INTEGER NOT NULL, policy_epoch INTEGER NOT NULL, verdict TEXT NOT NULL, reviewer TEXT NOT NULL, risk TEXT NOT NULL, reason TEXT NOT NULL, checks TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kernel_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_origins(task_id TEXT PRIMARY KEY REFERENCES tasks(id), source_task_id TEXT NOT NULL REFERENCES tasks(id), source_message_id TEXT NOT NULL, snapshot INTEGER NOT NULL, expected_count INTEGER NOT NULL, state TEXT NOT NULL, actual_count INTEGER, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_origins_state ON task_origins(state, updated_at);
    `);
            if (!this.rows('PRAGMA table_info(budgets)').some(column => column.name === 'tool_calls')) {
                this.db.exec(`ALTER TABLE budgets ADD COLUMN max_tool_calls INTEGER NOT NULL DEFAULT 100;
                    ALTER TABLE budgets ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0;
                    WITH RECURSIVE descendants(root_id,task_id) AS (
                        SELECT id,id FROM tasks
                        UNION ALL SELECT descendants.root_id,tasks.id FROM tasks JOIN descendants ON tasks.parent_id=descendants.task_id
                    )
                    UPDATE budgets SET tool_calls=(SELECT COUNT(*) FROM attempts JOIN descendants ON attempts.task_id=descendants.task_id WHERE descendants.root_id=budgets.task_id);
                    UPDATE budgets SET max_tool_calls=MAX(max_tool_calls,tool_calls);`);
            }
            this.db.exec('INSERT OR IGNORE INTO schema_version VALUES(2)');
            if (!this.row('SELECT version FROM schema_version WHERE version=3')) {
                // Rebuild the small execution projection once. Raw messages remain immutable.
                this.db.exec(`INSERT INTO pending_calls(task_id,message_id,tool_call_id,body)
                    SELECT m.task_id,m.id,json_extract(c.value,'$.id'),c.value
                    FROM messages m,json_each(m.body,'$.toolCalls') c WHERE m.session_id='main'
                    AND NOT EXISTS (SELECT 1 FROM messages answer WHERE answer.task_id=m.task_id AND answer.session_id='main'
                        AND answer.rowid>m.rowid AND json_extract(answer.body,'$.role')='tool'
                        AND json_extract(answer.body,'$.toolCallId')=json_extract(c.value,'$.id')
                        AND NOT EXISTS (SELECT 1 FROM messages newer,json_each(newer.body,'$.toolCalls') next_call
                            WHERE newer.task_id=m.task_id AND newer.session_id='main' AND newer.rowid>m.rowid AND newer.rowid<answer.rowid
                            AND json_extract(next_call.value,'$.id')=json_extract(c.value,'$.id')));
                    INSERT INTO task_schedule(task_id,due,consecutive_failures,reason)
                    SELECT t.id,COALESCE(json_extract(e.payload,'$.due'),0),0,'legacy-retry'
                    FROM tasks t JOIN events e ON e.seq=(SELECT MAX(seq) FROM events WHERE task_id=t.id AND type='model.retry_scheduled')
                    WHERE t.status='queued';
                    INSERT INTO schema_version VALUES(3);`);
            }
            // Permission state arrived in v4. approvals.source records which authority granted every effect
            // and session grants remember the exact resources the operator approved.
            if (!this.rows('PRAGMA table_info(approvals)').some(column => column.name === 'source')) {
                this.db.exec("ALTER TABLE approvals ADD COLUMN source TEXT NOT NULL DEFAULT 'operator'");
            }
            if (!this.rows('PRAGMA table_info(session_grants)').some(column => column.name === 'resources')) {
                this.db.exec("ALTER TABLE session_grants ADD COLUMN resources TEXT NOT NULL DEFAULT '[]'");
            }
            this.db.exec('INSERT OR IGNORE INTO schema_version VALUES(4)');
            const scheduleColumns = this.rows('PRAGMA table_info(task_schedule)');
            if (!scheduleColumns.some(column => column.name === 'scheduled_at')) this.db.exec('ALTER TABLE task_schedule ADD COLUMN scheduled_at INTEGER');
            if (!scheduleColumns.some(column => column.name === 'delay_ms')) this.db.exec('ALTER TABLE task_schedule ADD COLUMN delay_ms INTEGER');
            if (!this.rows('PRAGMA table_info(intents)').some(column => column.name === 'write_target')) {
                this.db.exec('ALTER TABLE intents ADD COLUMN write_target TEXT');
                let after = 0;
                for (;;) {
                    const rows = this.rows("SELECT rowid AS cursor,id,json_extract(body,'$.arguments.path') AS path FROM intents WHERE rowid>? AND json_extract(body,'$.name')='write_file' ORDER BY rowid LIMIT 100", after);
                    if (!rows.length) break;
                    const update = this.db.prepare('UPDATE intents SET write_target=? WHERE id=?');
                    for (const row of rows) update.run(writePathIdentity(String(row.path)), String(row.id));
                    after = Number(rows.at(-1)!.cursor);
                }
            }
            this.db.exec("CREATE INDEX IF NOT EXISTS intents_latest_write ON intents(task_id,write_target) WHERE state='applied' AND write_target IS NOT NULL");
            // The prepared event time is durable intent state: the approval projection must never date an
            // approval from the newest events or the task's mutable update timestamp. This structural
            // migration is detected from the column, so it stays atomic in this transaction and does not
            // claim a new schema version for what is purely additive intent state.
            const hasPreparedAt = this.rows('PRAGMA table_info(intents)').some(column => column.name === 'prepared_at');
            if (!hasPreparedAt) this.db.exec('ALTER TABLE intents ADD COLUMN prepared_at TEXT');
            const preparedMigration = 'intents.prepared_at.v1';
            // A missing column means the marker cannot prove the data is already backfilled (a legacy
            // database or an out-of-band structural restore), so rerun; an intact column + marker skips.
            if (!hasPreparedAt || !this.row('SELECT 1 AS present FROM kernel_migrations WHERE name=?', preparedMigration)) {
                // One-time repair, never repeated on reopen. Earlier builds dated an intent whose prepared
                // event was gone from the task's mutable updatedAt; that was a guess, not history. Clear
                // those guesses first, then copy only the real prepared event time. A missing event stays
                // NULL (unknown) and is never overwritten with task state. Bodies and events are untouched.
                this.db.exec(`UPDATE intents SET prepared_at=NULL WHERE prepared_at IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id=intents.task_id AND e.type='intent.prepared'
                        AND json_extract(e.payload,'$.intentId')=intents.id);`);
                this.db.exec(`UPDATE intents SET prepared_at=(
                    SELECT e.created_at FROM events e WHERE e.task_id=intents.task_id AND e.type='intent.prepared'
                        AND json_extract(e.payload,'$.intentId')=intents.id ORDER BY e.created_at,e.seq LIMIT 1)
                    WHERE prepared_at IS NULL AND EXISTS (SELECT 1 FROM events e WHERE e.task_id=intents.task_id AND e.type='intent.prepared'
                        AND json_extract(e.payload,'$.intentId')=intents.id);`);
                this.db.prepare('INSERT OR IGNORE INTO kernel_migrations(name,applied_at) VALUES(?,?)')
                    .run(preparedMigration, new Date().toISOString());
            }
            // Partial indexes: the operator projection only reads prepared ask intents, globally or by task.
            this.db.exec(`CREATE INDEX IF NOT EXISTS intents_actionable_prepared ON intents(prepared_at DESC)
                    WHERE state='prepared' AND json_extract(body,'$.authorization.decision')='ask';
                CREATE INDEX IF NOT EXISTS intents_actionable_task ON intents(task_id, prepared_at DESC)
                    WHERE state='prepared' AND json_extract(body,'$.authorization.decision')='ask';`);
        });
        this.archive = new HistoryArchive(this.db, 'work');
    }
    close(): void { this.db.close(); }
    storageInfo(): { driver: string; sqliteVersion: string; journalMode: string; synchronous: number; schemaVersion: number } {
        return {
            driver: 'node:sqlite',
            sqliteVersion: String(this.row('SELECT sqlite_version() AS version')!.version),
            journalMode: String(this.row('PRAGMA journal_mode')!.journal_mode),
            synchronous: Number(this.row('PRAGMA synchronous')!.synchronous),
            schemaVersion: Number(this.row('SELECT MAX(version) AS version FROM schema_version')!.version),
        };
    }
    /** Called only after the outermost rollback and depth reset. Must never replace the original rejection. */
    protected afterRollback(_error: unknown): void {}
    protected tx<T>(body: () => T): T {
        if (this.transactionDepth)
            return body();
        this.db.exec('BEGIN IMMEDIATE');
        this.transactionDepth++;
        let rejected: { error: unknown } | undefined;
        try {
            const result = body();
            this.db.exec('COMMIT');
            this.notifyCommitted();
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            rejected = { error };
            throw error;
        }
        finally {
            this.transactionDepth--;
            if (rejected) {
                // Advisory failure cannot alter the original operation's refusal.
                try { this.afterRollback(rejected.error); } catch { /* preserve original error */ }
            }
        }
    }
    protected row(sql: string, ...args: (string | number | null)[]): Record<string, unknown> | undefined { return this.db.prepare(sql).get(...args) as Record<string, unknown> | undefined; }
    protected rows(sql: string, ...args: (string | number | null)[]): Record<string, unknown>[] { return this.db.prepare(sql).all(...args) as Record<string, unknown>[]; }
}
