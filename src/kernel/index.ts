import path from 'node:path';
import type { AppMode, Command, CommandAck, Event, GoalContract, Intent, IntentAuthorization, IntentFailure, Message, PermissionMode, PolicyCapability, PolicyOutcome, RiskLevel, Task, TaskStatus, ToolCall, ToolReviewRecord } from '../contracts.js';
import { SQLiteStore, writePathIdentity } from './store.js';
import { FileReadSet, FileVersionChangedError } from './read-set.js';
import type { ReadVersion } from './read-set.js';
import { Coordination } from './coordination.js';
import { FileClaims } from './file-claims.js';
import { assertFileVerification, captureFileVerification } from './verification-files.js';
import { SideRequestLedger } from './side-requests.js';
import { ProgressGuard } from './progress.js';
import { capabilities, digest, fail, id, now, parse, terminal, transitions } from './types.js';
import { classifyTool, decideForMode, isAppMode, isPermissionMode, isProtectedPath, isProtectedTool, modeRank, narrowMode } from './permissions.js';
import { applyPermissionRule, matchPermissionRule, permissionRuleApplied, permissionRuleReason, permissionRuleTargets, samePermissionRules, validatePermissionRules } from './permission-rules.js';
import type { PermissionRule, PermissionRuleDecision } from './permission-rules.js';
import type { IntentDecision, PermissionChange, SessionGrant, TaskPermissionState, ToolSpec } from './permissions.js';
import type { Run, Decision, Verification, Checkpoint, Budget, SideBudget, Delegation, RecoverySummary, PrepareOptions, DerivedMemory, MemoryInput, TaskSchedule, Activity, ApproveOptions, PendingApproval, WorkOriginPreparation, WorkOriginCursor } from './types.js';
export { KernelError, digest } from './types.js';
export type { Capability, Run, Decision, Verification, Checkpoint, Budget, SideBudget, Delegation, RecoverySummary, PrepareOptions, DerivedMemory, MemoryInput, TaskSchedule, Activity, ActivityDay, ApproveOptions, PendingApproval, WorkOriginPreparation, WorkOriginCursor } from './types.js';
export type { IntentDecision, PermissionChange, SessionGrant, TaskPermissionState } from './permissions.js';
export type { PermissionMode, AppMode, PolicyCapability, RiskLevel, PolicyOutcome } from '../contracts.js';
export type { PermissionRule, PermissionRuleDecision } from './permission-rules.js';
export { validatePermissionRules } from './permission-rules.js';
type PausedTask = Task & { pauseState?: { parentTaskId?: string; resumeStatus: TaskStatus; waitingReason?: string } };
/** The legacy product list fetched at most this many approvals; the query keeps that bound. */
const APPROVAL_LIMIT = 200;
type BranchOriginInput = { sourceTaskId: string; sourceMessageId: string; snapshot: number; expectedCount: number };
const executionStatuses = new Set<TaskStatus>(['queued', 'running', 'reconciling', 'waiting_children', 'completed']);
function eventFromPageRow(row: Record<string, unknown>): Event {
    return { seq: Number(row.cursor), taskId: String(row.task_id), type: String(row.type), payload: parse(row.body), createdAt: String(row.created_at) };
}
/** The sole database writer. Commands, approvals and dispatch state commit atomically. */
export class Kernel extends SQLiteStore {
    private readonly fileReads: FileReadSet;
    readonly coordination: Coordination;
    readonly fileClaims: FileClaims;
    readonly sideRequests: SideRequestLedger;
    readonly progress: ProgressGuard;
    private scheduleClockWall = Date.now();
    private scheduleClockReady = false;
    constructor(dataDir: string) {
        super(dataDir);
        this.fileReads = new FileReadSet(this.db);
        this.sideRequests = new SideRequestLedger({ db: this.db, tx: run => this.tx(run), charge: (taskId, sessionId) => { this.consumeSideModelCall(taskId, sessionId); this.chargeModelCall(taskId, undefined, false); } });
        this.progress = new ProgressGuard({ db: this.db, tx: run => this.tx(run), task: id => this.requireTask(id), fence: (id, run) => this.assertFence(id, run), wait: (id, reason) => { this.transition(id, 'waiting_input', { waitingReason: reason }); }, event: (id, payload) => { this.appendEvent(id, 'progress.waiting_input', payload); } });
        this.tx(() => this.fileReads.migratePending());
        // Operator rules are configuration, so they live beside the store's own tables. They are
        // validated again on every read; a damaged row must fail closed, never be ignored.
        this.db.exec('CREATE TABLE IF NOT EXISTS permission_rules(id TEXT PRIMARY KEY, pattern TEXT NOT NULL, capability TEXT NOT NULL, decision TEXT NOT NULL, ordinal INTEGER NOT NULL)');
        this.invalidatePersistedAuthority();
        this.coordination = new Coordination({ db: this.db, tx: run => this.tx(run), task: id => this.getTask(id), event: (id, type, payload) => this.appendEvent(id, type, payload), fence: (id, run) => this.assertFence(id, run), claims: id => this.fileClaims?.claimedPaths(id) ?? { paths: [], total: 0 } });
        this.fileClaims = new FileClaims({ db: this.db, epoch: this.coordination.epoch, tx: run => this.tx(run), task: id => this.getTask(id), changed: (taskId, action, claim) => { this.appendEvent(taskId, 'coordination.claim_changed', { action, claim }); this.coordination.fileClaimChanged(taskId, action, claim); }, capacity: (taskId, target) => { this.appendEvent(taskId, 'coordination.claim_capacity', { path: target, claimed: false, reason: 'The file operation completed, but its automatic claim was not established because capacity is full. Read-version and peer-conflict checks still apply.' }); } });
    }
    /**
     * Task permission modes are durable operator choices; session grants and review verdicts only
     * authorize the process that recorded them. Reopening the database must never revive them.
     * Only prepared and approved effects can still execute, so only they lose the review that made
     * them executable and the review row binding it. Terminal records (applied, denied, sent,
     * unknown) cannot be approved again and keep their review as durable audit evidence.
     * Standalone approvals stay durable so an effect approved before an upgrade can still finish;
     * dispatch revalidates their digest, generation, policy epoch and any bound session grant.
     */
    private invalidatePersistedAuthority(): void {
        this.tx(() => {
            this.db.prepare('UPDATE session_grants SET revoked=1 WHERE revoked=0').run();
            // Review verdicts are executable authority only while their intent can still be approved.
            this.db.prepare("DELETE FROM intent_reviews WHERE intent_id IN (SELECT id FROM intents WHERE state IN ('prepared','approved'))").run();
            // Set-based JSON1 rewrite: the intent history is never loaded into JS.
            this.db.prepare("UPDATE intents SET body=json_remove(body,'$.authorization.review') WHERE state IN ('prepared','approved') AND json_extract(body,'$.authorization.review') IS NOT NULL").run();
        });
    }
    memory(taskId: string, sessionId = 'main') { this.requireTask(taskId); return this.archive.scope(JSON.stringify([taskId, sessionId])); }
    private requireTask(taskId: string): Task { return this.getTask(taskId) ?? fail('NOT_FOUND', `Task ${taskId} does not exist`); }
    accountingAncestors(taskId: string, historicalParent?: string): string[] {
        const result: string[] = [];
        let current: string | undefined = taskId;
        while (current && !result.includes(current)) {
            result.push(current);
            const row = this.row('SELECT parent_id FROM tasks WHERE id=?', current);
            current = row?.parent_id ? String(row.parent_id) : !row && result.length === 1 ? historicalParent : undefined;
        }
        return result;
    }
    private planningAncestor(task: Task): Task | undefined {
        let ancestor = task.parentId ? this.requireTask(task.parentId) : undefined;
        while (ancestor) {
            if (ancestor.executionPhase && ancestor.executionPhase !== 'executing') return ancestor;
            ancestor = ancestor.parentId ? this.requireTask(ancestor.parentId) : undefined;
        }
        return undefined;
    }
    private assertPlanningTool(task: Task, name: string): void {
        if (!task.executionPhase || task.executionPhase === 'executing') return;
        const spec = classifyTool(name);
        if (!spec || !(['read', 'network'].includes(spec.capability) || name === 'mcp_read') || ['delegate', 'accept_child_result', 'cancel_child', 'dismiss_child', 'finish'].includes(name))
            fail('PLAN_MODE', 'Only investigation and saving the plan are allowed before user confirmation');
    }
    private saveTask(task: Task): Task { this.db.prepare('UPDATE tasks SET status=?, revision=?, body=? WHERE id=?').run(task.status, task.revision, JSON.stringify(task), task.id); this.coordination?.taskChanged(task); this.fileClaims?.taskChanged(task); return task; }
    private updateTask(task: Task, patch: Partial<Task>): Task { return this.saveTask({ ...task, ...patch, revision: task.revision + 1, updatedAt: now() }); }
    /** Permission state lives on the task body; a pre-upgrade task reads back as ask/work, never as a grant. */
    private storedPermission(task: Task): { mode: PermissionMode; appMode: AppMode } {
        const appMode: AppMode = task.appMode === 'chat' ? 'chat' : 'work';
        const mode: PermissionMode = appMode === 'chat' ? 'read-only'
            : isPermissionMode(task.permissionMode) ? task.permissionMode : 'ask';
        return { mode, appMode };
    }
    permissionMode(taskId: string): PermissionMode { return this.storedPermission(this.requireTask(taskId)).mode; }
    /** Legacy read shape still used by the Harness tool inspector. */
    getTaskPermission(taskId: string): { taskId: string; mode: PermissionMode; app: AppMode; updatedAt: string } {
        const task = this.requireTask(taskId);
        const stored = this.storedPermission(task);
        return { taskId, mode: stored.mode, app: stored.appMode, updatedAt: task.updatedAt };
    }
    appMode(taskId: string): AppMode { return this.storedPermission(this.requireTask(taskId)).appMode; }
    permissionState(taskId: string): TaskPermissionState {
        const task = this.requireTask(taskId);
        const stored = this.storedPermission(task);
        return { taskId, mode: stored.mode, appMode: stored.appMode, policyEpoch: task.policyEpoch, grants: this.sessionGrants(taskId) };
    }
    /** Durable operator rules, revalidated on every read so damaged authority fails closed. */
    permissionRules(): PermissionRule[] {
        const stored = this.rows('SELECT id,pattern,capability,decision FROM permission_rules ORDER BY ordinal,rowid').map(row => ({
            id: String(row.id), pattern: String(row.pattern),
            capability: String(row.capability) as PolicyCapability,
            decision: String(row.decision) as PermissionRuleDecision,
        }));
        try {
            return validatePermissionRules(stored);
        } catch (error) {
            fail('INVALID_PERMISSION_RULE', `Stored permission rules are invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    validatePermissionRules(input: unknown): PermissionRule[] { return validatePermissionRules(input); }
    /**
     * Replacing the rule set is a policy change: every pending approval loses its authority, and
     * tasks still holding a prepared or approved effect are fenced and requeued exactly like a
     * permission mode change. Tasks without pending effects are not interrupted.
     */
    setPermissionRules(input: unknown): PermissionRule[] {
        const rules = this.validatePermissionRules(input);
        return this.tx(() => {
            const current = this.permissionRules();
            if (samePermissionRules(current, rules)) return current;
            this.db.prepare('DELETE FROM permission_rules').run();
            const insert = this.db.prepare('INSERT INTO permission_rules(id,pattern,capability,decision,ordinal) VALUES(?,?,?,?,?)');
            rules.forEach((rule, ordinal) => insert.run(rule.id, rule.pattern, rule.capability, rule.decision, ordinal));
            this.db.prepare('UPDATE session_grants SET revoked=1 WHERE revoked=0').run();
            const affected = this.rows("SELECT DISTINCT task_id FROM intents WHERE state IN ('prepared','approved') ORDER BY task_id").map(row => String(row.task_id));
            for (const taskId of affected) {
                const task = this.requireTask(taskId);
                this.fence(taskId, 'Permission rules changed');
                this.revokeSessionGrants(taskId);
                const status: TaskStatus = terminal.has(task.status) || task.status === 'paused' ? task.status
                    : this.hasUnknown(taskId) ? 'reconciling' : 'queued';
                this.updateTask(task, {
                    policyEpoch: task.policyEpoch + 1, generation: task.generation + 1, status, error: undefined,
                    waitingReason: status === 'reconciling' ? 'Unknown effects must be reconciled before execution' : undefined,
                });
                this.appendEvent(taskId, 'permission.rules_changed', { rules: rules.length, affected: affected.length, reason: 'Operator changed the permission rules' });
            }
            return rules;
        });
    }
    sessionGrants(taskId: string, includeRevoked = false): SessionGrant[] {
        const rows = includeRevoked
            ? this.rows('SELECT * FROM session_grants WHERE task_id=? ORDER BY rowid', taskId)
            : this.rows('SELECT * FROM session_grants WHERE task_id=? AND revoked=0 ORDER BY rowid', taskId);
        return rows.map(row => {
            const spec = classifyTool(String(row.tool));
            return {
                id: String(row.id), taskId: String(row.task_id), workspace: String(row.workspace), tool: String(row.tool),
                kernelCapability: spec?.kernelCapability ?? 'workspace.read',
                capability: String(row.capability) as PolicyCapability, risk: spec?.risk ?? 'high',
                resources: parse<string[]>(row.resources ?? '[]'),
                policyEpoch: Number(row.policy_epoch), goalVersion: Number(row.goal_version),
                mode: String(row.mode) as PermissionMode, createdAt: String(row.created_at),
            };
        });
    }
    /** Session grants are authority; every subtree fence (revoke, ceiling narrowing, mode change) drops them. */
    revokeSessionGrants(taskId: string): number {
        const result = this.db.prepare(`WITH RECURSIVE subtree(id) AS (
            SELECT ? UNION ALL SELECT tasks.id FROM tasks JOIN subtree ON tasks.parent_id=subtree.id)
            UPDATE session_grants SET revoked=1 WHERE revoked=0 AND task_id IN (SELECT id FROM subtree)`).run(taskId);
        return Number(result.changes);
    }
    listTasks(): Task[] { return this.rows('SELECT body FROM tasks ORDER BY rowid').map(r => parse<Task>(r.body)); }
    /** Read small row headers first, then materialize only the selected UTF-8 byte budget. */
    private boundedBodies(table: string, where: string, parameters: (string | number | null)[], limit: number, descending = false, allowLargeFirst = false, maxBytes = 1024 * 1024, column = 'body') {
        this.validatePageLimit(limit);
        const order = descending ? 'DESC' : 'ASC';
        const headers = this.rows(`SELECT rowid AS cursor,length(CAST(${column} AS BLOB)) AS bytes FROM ${table} WHERE ${where} ORDER BY rowid ${order} LIMIT ?`, ...parameters, limit);
        return this.boundedRecordRows(table, headers, limit, descending, allowLargeFirst, maxBytes, column);
    }
    private boundedRecordRows(table: string, headers: Record<string, unknown>[], limit: number, descending = false, allowLargeFirst = false, maxBytes = 1024 * 1024, column = 'body') {
        const order = descending ? 'DESC' : 'ASC';
        const cursors: number[] = [];
        let bytes = 2;
        for (const header of headers) {
            const size = Number(header.bytes) + 1;
            if (bytes + size > maxBytes) {
                if (cursors.length) break;
                if (!allowLargeFirst) fail('PAGE_RECORD_TOO_LARGE', `${table} record ${header.cursor} exceeds the ${maxBytes}-byte page budget; read its archived source by reference`);
            }
            cursors.push(Number(header.cursor)); bytes += size;
        }
        const eventHeaders = table === 'events' ? ',task_id,type,created_at' : '';
        const rows = cursors.length ? this.rows(`SELECT rowid AS cursor,${column} AS body${eventHeaders} FROM ${table} WHERE rowid IN (${cursors.map(() => '?').join(',')}) ORDER BY rowid ${order}`, ...cursors) : [];
        return { rows, hasMore: cursors.length < headers.length || headers.length === limit };
    }
    manageExternally(taskId: string): void {
        this.requireTask(taskId);
        this.db.prepare("INSERT OR IGNORE INTO task_execution_owners VALUES(?,'external')").run(taskId);
    }
    manageExternallyBatch(taskIds: string[]): string[] {
        if (taskIds.length > 100) fail('INVALID_PAGE_LIMIT', 'Owner registration is limited to 100 tasks per transaction');
        return this.tx(() => {
            const insert = this.db.prepare("INSERT OR IGNORE INTO task_execution_owners SELECT id,'external' FROM tasks WHERE id=?");
            const exists = this.db.prepare('SELECT task_id FROM task_execution_owners WHERE task_id=?');
            return taskIds.filter(taskId => { insert.run(taskId); return !!exists.get(taskId); });
        });
    }
    isManagedExternally(taskId: string): boolean {
        return !!this.row("SELECT 1 FROM task_execution_owners WHERE task_id=? UNION ALL SELECT 1 FROM tasks WHERE id=? AND json_extract(body,'$.appMode')='chat' LIMIT 1", taskId, taskId);
    }
    externallyManagedTaskCount(): number {
        return Number(this.row("SELECT COUNT(*) AS n FROM tasks t WHERE json_extract(t.body,'$.appMode')='chat' OR EXISTS(SELECT 1 FROM task_execution_owners o WHERE o.task_id=t.id)")!.n);
    }
    authorizeSideTurn(taskId: string, sessionId: string, userMessageId: string): void {
        this.requireTask(taskId);
        this.db.prepare('INSERT INTO side_control_turns VALUES(?,?,?) ON CONFLICT(message_id) DO NOTHING').run(userMessageId, sessionId, taskId);
    }
    authorizeSideBinding(sessionId: string, userMessageId: string, objective: string): void {
        if (!objective.trim() || objective.length > 8000) fail('INVALID_GOAL', 'Side binding requires a bounded user objective');
        this.db.prepare('INSERT INTO side_binding_turns VALUES(?,?,?) ON CONFLICT(message_id) DO NOTHING').run(userMessageId, sessionId, objective);
    }
    taskPage(after = 0, limit = 100, excludeExternal = false) {
        const { rows, hasMore } = this.boundedBodies('tasks t', `rowid>? ${excludeExternal ? "AND COALESCE(json_extract(body,'$.appMode'),'work')<>'chat' AND NOT EXISTS(SELECT 1 FROM task_execution_owners o WHERE o.task_id=t.id)" : ''}`, [after], limit);
        return { items: rows.map(row => parse<Task>(row.body)), nextCursor: hasMore ? Number(rows.at(-1)!.cursor) : null };
    }
    recentTasks(limit = 100): Task[] {
        return this.boundedBodies('tasks t', "COALESCE(json_extract(body,'$.appMode'),'work')<>'chat' AND NOT EXISTS(SELECT 1 FROM task_execution_owners o WHERE o.task_id=t.id)", [], limit, true).rows.reverse().map(row => parse<Task>(row.body));
    }
    workspaceTaskPage(workspace: string, before = Number.MAX_SAFE_INTEGER, limit = 100) {
        if (!Number.isSafeInteger(before) || before < 1) fail('INVALID_CURSOR', 'Workspace task cursor must be a positive integer');
        const { rows, hasMore } = this.boundedBodies('tasks t', "lower(json_extract(body,'$.workspace'))=? AND rowid<? AND COALESCE(json_extract(body,'$.appMode'),'work')<>'chat' AND NOT EXISTS(SELECT 1 FROM task_execution_owners o WHERE o.task_id=t.id)", [path.resolve(workspace).toLowerCase(), before], limit, true);
        return { items: rows.map(row => parse<Task>(row.body)), nextCursor: hasMore ? Number(rows.at(-1)!.cursor) : null };
    }
    activeChildCount(taskId: string): number {
        return Number(this.row("SELECT COUNT(*) AS count FROM tasks WHERE parent_id=? AND status NOT IN ('completed','failed','cancelled')", taskId)!.count);
    }
    /** Tree control reads only direct children; unrelated archived task bodies stay in SQLite. */
    childTasks(taskId: string): Task[] { return this.rows('SELECT body FROM tasks WHERE parent_id=? ORDER BY rowid', taskId).map(r => parse<Task>(r.body)); }
    childTaskPage(taskId: string, after = 0, limit = 100) {
        const { rows, hasMore } = this.boundedBodies('tasks', 'parent_id=? AND rowid>?', [taskId, after], limit);
        return { items: rows.map(row => parse<Task>(row.body)), nextCursor: hasMore ? Number(rows.at(-1)!.cursor) : null };
    }
    childByOwner(taskId: string, owner: string): Task | undefined {
        const row = this.row("SELECT body FROM tasks WHERE parent_id=? AND json_extract(body,'$.owner')=? ORDER BY rowid LIMIT 1", taskId, owner);
        return row ? parse<Task>(row.body) : undefined;
    }
    getTask(taskId: string): Task | undefined { const row = this.row('SELECT body FROM tasks WHERE id=?', taskId); return row ? parse<Task>(row.body) : undefined; }
    getMessage(messageId: string): Message | undefined { const row = this.row('SELECT body FROM messages WHERE id=?', messageId); return row ? parse<Message>(row.body) : undefined; }
    latestEventSequence(): number { return Number(this.row('SELECT COALESCE(MAX(seq),0) AS seq FROM events')?.seq ?? 0); }
    traceEventsSince(after = 0, limit = 16): Event[] {
        return this.boundedBodies('events', 'seq>?', [after], limit, false, false, 1024 * 1024, 'payload').rows.map(eventFromPageRow);
    }
    eventsSince(after = 0, limit = 500): Event[] {
        this.validatePageLimit(limit);
        return this.rows('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?', after, limit).map(row => ({ seq: Number(row.seq), taskId: String(row.task_id), type: String(row.type), payload: parse(row.payload), createdAt: String(row.created_at) }));
    }
    getMessages(taskId: string, sessionId = 'main'): Message[] { this.requireTask(taskId); return this.rows('SELECT body FROM messages WHERE task_id=? AND session_id=? ORDER BY rowid', taskId, sessionId).map(r => parse<Message>(r.body)); }
    tailMessages(taskId: string, limit = 160, sessionId = 'main', role?: Message['role']): Message[] {
        this.requireTask(taskId); this.validatePageLimit(limit);
        return this.boundedBodies('messages', `task_id=? AND session_id=?${role ? " AND json_extract(body,'$.role')=?" : ''}`, [taskId, sessionId, ...(role ? [role] : [])], limit, true, true).rows.reverse().map(row => parse<Message>(row.body));
    }
    latestAssistantResult(taskId: string): Message | undefined {
        const row = this.row("SELECT body FROM messages WHERE task_id=? AND session_id='main' AND json_extract(body,'$.role')='assistant' AND COALESCE(json_array_length(body,'$.toolCalls'),0)=0 ORDER BY rowid DESC LIMIT 1", taskId);
        return row ? parse<Message>(row.body) : undefined;
    }
    messageCount(taskId: string, sessionId = 'main'): number {
        return Number(this.row('SELECT COUNT(*) AS n FROM messages WHERE task_id=? AND session_id=?', taskId, sessionId)!.n);
    }
    userTurnCount(taskId: string): number {
        return Number(this.row("SELECT COUNT(*) AS n FROM messages WHERE task_id=? AND session_id='main' AND json_extract(body,'$.role')='user'", taskId)!.n);
    }
    latestUserCursor(taskId: string): number {
        return Number(this.row("SELECT rowid AS cursor FROM messages WHERE task_id=? AND session_id='main' AND json_extract(body,'$.role')='user' ORDER BY rowid DESC LIMIT 1", taskId)?.cursor ?? 0);
    }
    consumedUserInput(taskId: string): { cursor: number; offset: number } {
        const row = this.row("SELECT json_extract(body,'$.sampledUserInput.cursor') AS cursor,json_extract(body,'$.sampledUserInput.offset') AS offset,json_extract(body,'$.sampledUserCursor') AS legacy FROM messages WHERE task_id=? AND session_id='main' AND json_extract(body,'$.role')='assistant' AND (json_type(body,'$.sampledUserInput') IS NOT NULL OR json_type(body,'$.sampledUserCursor') IS NOT NULL) ORDER BY rowid DESC LIMIT 1", taskId);
        return { cursor: Number(row?.cursor ?? row?.legacy ?? 0), offset: Number(row?.offset ?? 0) };
    }
    consumedUserCursor(taskId: string): number { return this.consumedUserInput(taskId).cursor; }
    progressInput(taskId: string, consumed: { cursor: number; offset: number }): { cursor: number; offset: number; consumedCursor: number } {
        const row = this.row("SELECT rowid AS cursor FROM messages WHERE task_id=? AND session_id='main' AND json_extract(body,'$.role')='user' AND json_extract(body,'$.inputOrigin') IS NOT 'runtime' AND rowid<=? ORDER BY rowid DESC LIMIT 1", taskId, consumed.cursor);
        const next = consumed.offset ? this.row("SELECT json_extract(body,'$.inputOrigin') AS origin FROM messages WHERE task_id=? AND session_id='main' AND json_extract(body,'$.role')='user' AND rowid>? ORDER BY rowid LIMIT 1", taskId, consumed.cursor) : undefined;
        const latest = this.row("SELECT rowid AS cursor FROM messages WHERE task_id=? AND session_id='main' AND json_extract(body,'$.role')='user' AND json_extract(body,'$.inputOrigin') IS NOT 'runtime' ORDER BY rowid DESC LIMIT 1", taskId);
        return { cursor: Number(latest?.cursor ?? 0), consumedCursor: Number(row?.cursor ?? 0), offset: next && next.origin !== 'runtime' ? consumed.offset : 0 };
    }
    userMessagesAfter(taskId: string, afterCursor: number, limit = 32): { cursor: number; message: Message }[] {
        this.requireTask(taskId); this.validatePageLimit(limit);
        // One legacy oversized input remains whole: projectInputBatch hashes and consumes its exact original offsets.
        return this.boundedBodies('messages', "task_id=? AND session_id='main' AND json_extract(body,'$.role')='user' AND rowid>?", [taskId, afterCursor], limit, false, true).rows
            .map(row => ({ cursor: Number(row.cursor), message: parse<Message>(row.body) }));
    }
    intentPage(taskId: string, after = 0, limit = 100): { items: Intent[]; nextCursor: number | null } {
        this.requireTask(taskId); this.validatePageLimit(limit);
        // write_file accepts one million UTF-16 code units: its JSON representation can
        // occupy six million bytes (escaped control characters), plus bounded intent metadata.
        const { rows, hasMore } = this.boundedBodies('intents', 'task_id=? AND rowid>?', [taskId, after], limit, false, false, 8 * 1024 * 1024);
        return { items: rows.map(row => parse<Intent>(row.body)), nextCursor: hasMore ? Number(rows.at(-1)!.cursor) : null };
    }
    isLatestAppliedWrite(taskId: string, intentId: string, relativePath: string): boolean {
        const row = this.row("SELECT id FROM intents WHERE task_id=? AND state='applied' AND write_target IS NOT NULL AND write_target=? ORDER BY rowid DESC LIMIT 1", taskId, writePathIdentity(relativePath));
        return row?.id === intentId;
    }
    delegationReviewPage(taskId: string, after = 0, limit = 100) {
        this.requireTask(taskId); this.validatePageLimit(limit);
        const headers = this.rows(`SELECT d.rowid AS cursor,length(CAST(d.body AS BLOB))+length(CAST(t.body AS BLOB))+
            COALESCE((SELECT length(CAST(v.body AS BLOB)) FROM verifications v WHERE v.task_id=t.id ORDER BY v.rowid DESC LIMIT 1),0) AS bytes
            FROM delegations d JOIN tasks t ON t.id=d.child_task_id WHERE d.task_id=? AND d.rowid>? ORDER BY d.rowid LIMIT ?`, taskId, after, limit);
        const { rows, hasMore } = this.boundedRecordRows('delegations', headers, limit);
        return { items: rows.map(row => { const delegation = parse<Delegation>(row.body); return { delegation, task: this.requireTask(delegation.childTaskId), verification: this.latestVerification(delegation.childTaskId) }; }), nextCursor: hasMore ? Number(rows.at(-1)!.cursor) : null };
    }
    hasUnsettledDelegations(taskId: string, goalVersion: number): boolean {
        return !!this.row(`SELECT 1 FROM delegations d JOIN tasks t ON t.id=d.child_task_id WHERE d.task_id=? AND (
            COALESCE(json_extract(d.body,'$.parentGoalVersion'),1)<>? OR json_extract(d.body,'$.settledSnapshot.revision') IS NULL
            OR json_extract(d.body,'$.settledSnapshot.revision')<>t.revision
            OR json_extract(d.body,'$.settledSnapshot.generation')<>json_extract(t.body,'$.generation')
            OR json_extract(d.body,'$.settledSnapshot.goalVersion')<>json_extract(t.body,'$.goalVersion')
            OR json_extract(d.body,'$.settledSnapshot.policyEpoch')<>json_extract(t.body,'$.policyEpoch')
            OR NOT ((json_extract(d.body,'$.state')='accepted' AND t.status='completed') OR (json_extract(d.body,'$.state')='dismissed' AND t.status IN ('failed','cancelled')))
            OR EXISTS(SELECT 1 FROM intents i WHERE i.task_id=t.id AND i.state IN ('sent','unknown'))) LIMIT 1`, taskId, goalVersion);
    }
    messagePage(taskId: string, before = Number.MAX_SAFE_INTEGER, limit = 100, sessionId = 'main') {
        this.requireTask(taskId); this.validatePageLimit(limit);
        if (!Number.isSafeInteger(before) || before < 1) fail('INVALID_CURSOR', 'Message cursor must be a positive integer');
        const page = this.boundedBodies('messages', 'task_id=? AND session_id=? AND rowid<?', [taskId, sessionId, before], limit, true);
        const rows = page.rows.reverse();
        return { messages: rows.map(row => parse<Message>(row.body)), nextCursor: page.hasMore ? Number(rows[0]!.cursor) : null, totalMessages: this.messageCount(taskId, sessionId) };
    }
    historyPage(taskId: string, kind: string, after = 0, limit = 100, through?: number) {
        this.requireTask(taskId);
        if (kind !== 'messages' && kind !== 'events') fail('INVALID_HISTORY_KIND', 'Select messages or events');
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000
            || through !== undefined && (!Number.isSafeInteger(through) || through < 0)) fail('INVALID_HISTORY_PAGE', 'History requires nonnegative cursors and limit 1–1000');
        const main = kind === 'messages' ? " AND session_id='main'" : '';
        const maximum = Number(this.row(`SELECT MAX(rowid) AS cursor FROM ${kind} WHERE task_id=?${main}`, taskId)?.cursor ?? 0);
        const throughSeq = through ?? maximum;
        if (throughSeq > maximum || after > throughSeq) fail('INVALID_HISTORY_PAGE', 'History cursor exceeds the selected retained snapshot');
        const page = this.boundedBodies(kind, `task_id=?${main} AND rowid>? AND rowid<=?`, [taskId, after, throughSeq], limit + 1, false, false, 1024 * 1024, kind === 'events' ? 'payload' : 'body');
        const selected = page.rows.slice(0, limit);
        const items = selected.map(row => kind === 'messages' ? parse<Message>(row.body) : eventFromPageRow(row));
        const hasMore = page.hasMore || page.rows.length > selected.length;
        return { taskId, kind, items, historyWindow: true as const,
            page: { afterSeq: after, limit, nextCursor: hasMore ? Number(selected.at(-1)!.cursor) : null, hasMore, throughSeq } };
    }
    /** Durable rowid of one message; an immutable branch origin ends exactly at this position. */
    messageCursor(taskId: string, messageId: string, sessionId = 'main'): number {
        this.requireTask(taskId);
        const row = this.row('SELECT rowid AS cursor FROM messages WHERE id=? AND task_id=? AND session_id=?', messageId, taskId, sessionId) as { cursor: number | bigint } | undefined;
        if (!row) fail('NOT_FOUND', 'The selected message is not in this task conversation');
        return Number(row.cursor);
    }
    /** Bounded keyset page of raw message records, so an origin copy pages exactly what was stored. */
    messageRows(taskId: string, after = 0, limit = 500, sessionId = 'main', through = Number.MAX_SAFE_INTEGER) {
        this.requireTask(taskId); this.validatePageLimit(limit);
        return this.rows('SELECT rowid,id,body,created_at FROM messages WHERE task_id=? AND session_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?', taskId, sessionId, after, through, limit)
            .map(row => ({ rowid: Number(row.rowid), id: String(row.id), body: String(row.body), createdAt: String(row.created_at) }));
    }
    /** Durable branch-origin preparation. Absence means the task is not a cross-database branch. */
    workOrigin(taskId: string): WorkOriginPreparation | undefined {
        const row = this.row('SELECT * FROM task_origins WHERE task_id=?', taskId);
        return row ? this.workOriginFromRow(row) : undefined;
    }
    /**
     * One bounded keyset page of pending branch-origin preparations, oldest first. The existing
     * task_origins_state(state, updated_at) index restricts the query to pending rows, so settled branch
     * history is never returned no matter how many branches have completed. The (updated_at, task_id)
     * cursor stays stable because a processed row leaves the pending set instead of moving behind it.
     */
    pendingWorkOriginPreparations(after?: WorkOriginCursor, limit = 50): WorkOriginPreparation[] {
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('INVALID_PAGE_LIMIT', 'Origin preparation page limit must be an integer between 1 and 200');
        const cursor = after ?? { updatedAt: '', taskId: '' };
        return this.rows("SELECT * FROM task_origins WHERE state='pending' AND (updated_at>? OR (updated_at=? AND task_id>?)) ORDER BY updated_at,task_id LIMIT ?",
            cursor.updatedAt, cursor.updatedAt, cursor.taskId, limit).map(row => this.workOriginFromRow(row));
    }
    /** Only a completed immutable copy may make a paused branch executable. */
    markWorkOriginReady(taskId: string, actualCount: number): WorkOriginPreparation {
        return this.tx(() => {
            const preparation = this.workOrigin(taskId) ?? fail('NOT_FOUND', `Task ${taskId} has no branch origin preparation`);
            if (preparation.state !== 'pending') fail('INVALID_ORIGIN_STATE', `Branch origin preparation is already ${preparation.state}`);
            const task = this.requireTask(taskId);
            if (task.status !== 'paused') fail('INVALID_ORIGIN_STATE', 'Only a paused branch can complete its origin preparation');
            if (!Number.isSafeInteger(actualCount) || actualCount < 1 || actualCount !== preparation.expectedCount)
                fail('ORIGIN_COUNT_MISMATCH', `The immutable branch origin has ${actualCount} messages; expected ${preparation.expectedCount}`);
            this.db.prepare("UPDATE task_origins SET state='ready',actual_count=?,reason=NULL,updated_at=? WHERE task_id=?").run(actualCount, now(), taskId);
            this.appendEvent(taskId, 'task.origin_ready', { sourceTaskId: preparation.sourceTaskId, snapshot: preparation.snapshot, actualCount });
            return this.workOrigin(taskId)!;
        });
    }
    /** Terminate a branch whose origin never became complete; it is never presented as runnable. */
    fenceIncompleteWorkOrigin(taskId: string, reason: string): Task {
        return this.tx(() => {
            const preparation = this.workOrigin(taskId) ?? fail('NOT_FOUND', `Task ${taskId} has no branch origin preparation`);
            const task = this.requireTask(taskId);
            const detail = String(reason).trim() || 'The immutable branch origin was not completed.';
            let fenced = task;
            if (!terminal.has(task.status)) {
                fenced = this.cancelTree(task);
                fenced = this.updateTask(fenced, { error: detail });
            } else if (task.status === 'failed') {
                fenced = this.updateTask(task, { error: detail });
            }
            this.db.prepare("UPDATE task_origins SET state='failed',actual_count=NULL,reason=?,updated_at=? WHERE task_id=?").run(detail, now(), taskId);
            this.appendEvent(taskId, 'task.origin_fenced', { sourceTaskId: preparation.sourceTaskId, sourceMessageId: preparation.sourceMessageId, snapshot: preparation.snapshot, reason: detail });
            return fenced;
        });
    }
    private workOriginFromRow(row: Record<string, unknown>): WorkOriginPreparation {
        return {
            taskId: String(row.task_id), sourceTaskId: String(row.source_task_id), sourceMessageId: String(row.source_message_id),
            snapshot: Number(row.snapshot), expectedCount: Number(row.expected_count), state: String(row.state) as WorkOriginPreparation['state'],
            ...(row.actual_count === null || row.actual_count === undefined ? {} : { actualCount: Number(row.actual_count) }),
            ...(row.reason === null || row.reason === undefined ? {} : { reason: String(row.reason) }),
            createdAt: String(row.created_at), updatedAt: String(row.updated_at),
        };
    }
    /** Every executable entrypoint shares this same durable boundary. */
    private assertWorkOriginReady(taskId: string): void {
        const preparation = this.workOrigin(taskId);
        if (!preparation || preparation.state === 'ready') return;
        const detail = preparation.reason ? `: ${preparation.reason}` : '';
        fail('ORIGIN_NOT_READY', `The immutable branch origin is ${preparation.state}; this branch cannot execute${detail}`);
    }
    private parseBranchOrigin(value: unknown, initialStatus: 'paused' | undefined): BranchOriginInput | undefined {
        if (value === undefined) return undefined;
        if (initialStatus !== 'paused') fail('INVALID_BRANCH_ORIGIN', "branchOrigin requires initialStatus 'paused'");
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_BRANCH_ORIGIN', 'branchOrigin must be an object');
        const input = value as Record<string, unknown>;
        const sourceTaskId = typeof input.sourceTaskId === 'string' ? input.sourceTaskId.trim() : '';
        const sourceMessageId = typeof input.sourceMessageId === 'string' ? input.sourceMessageId.trim() : '';
        const snapshot = Number(input.snapshot);
        if (!sourceTaskId || sourceTaskId.length > 200 || !sourceMessageId || sourceMessageId.length > 200 || !Number.isSafeInteger(snapshot) || snapshot < 1)
            fail('INVALID_BRANCH_ORIGIN', 'branchOrigin needs a source task id, source message id and positive message cursor');
        if (!this.getTask(sourceTaskId)) fail('INVALID_BRANCH_ORIGIN', 'The branch origin source task does not exist');
        const row = this.row('SELECT rowid AS cursor FROM messages WHERE id=? AND task_id=? AND session_id=?', sourceMessageId, sourceTaskId, 'main') as { cursor: number | bigint } | undefined;
        if (!row || Number(row.cursor) !== snapshot) fail('INVALID_BRANCH_ORIGIN', 'The branch origin message is not at that cursor in the source task main session');
        const expectedCount = Number(this.row('SELECT COUNT(*) AS n FROM messages WHERE task_id=? AND session_id=? AND rowid<=?', sourceTaskId, 'main', snapshot)!.n);
        if (expectedCount < 1) fail('INVALID_BRANCH_ORIGIN', 'The branch origin has no source messages');
        return { sourceTaskId, sourceMessageId, snapshot, expectedCount };
    }
    presentation(taskId: string) {
        const tail = <T>(table: string, limit: number): T[] => this.boundedBodies(table, 'task_id=?', [taskId], limit, true).rows.reverse().map(row => parse<T>(row.body));
        return { ...this.messagePage(taskId, Number.MAX_SAFE_INTEGER, 160), events: this.recentEvents(taskId), intents: tail<Intent>('intents', 100),
            runs: tail<Run>('runs', 30), checkpoints: tail<Checkpoint>('checkpoints', 20), verifications: tail<Verification>('verifications', 20),
            decisions: tail<Decision>('decisions', 10), memories: tail<DerivedMemory>('derived_memories', 20) };
    }
    recall(taskId: string, query: string) {
        this.requireTask(taskId);
        if (!query.trim() || query.length > 300) fail('INVALID_QUERY', 'Enter a history query of 1–300 characters');
        const messages = this.rows("SELECT body FROM messages WHERE task_id=? AND instr(lower(json_extract(body,'$.content')),lower(?))>0 ORDER BY rowid DESC LIMIT 60", taskId, query).map(row => { const message = parse<Message>(row.body); return { kind: 'message', ...message }; });
        const events = this.rows("SELECT seq,type,payload FROM events WHERE task_id=? AND instr(lower(payload),lower(?))>0 ORDER BY seq DESC LIMIT 40", taskId, query).map(row => ({ kind: 'event', seq: Number(row.seq), content: `${row.type}: ${row.payload}`, payload: parse(row.payload) }));
        return { results: [...messages, ...events], rawHistoryRetained: true };
    }
    searchMessages(taskId: string, query: string, limit = 20): Message[] {
        this.requireTask(taskId); this.validatePageLimit(limit);
        return this.rows("SELECT body FROM messages WHERE task_id=? AND session_id='main' AND instr(lower(json_extract(body,'$.content')),lower(?))>0 ORDER BY rowid DESC LIMIT ?", taskId, query, limit).reverse().map(row => parse<Message>(row.body));
    }
    pendingCalls(taskId: string): { call: ToolCall; messageId: string }[] {
        return this.rows('SELECT message_id,body FROM pending_calls WHERE task_id=? ORDER BY rowid', taskId).map(row => ({ messageId: String(row.message_id), call: parse<ToolCall>(row.body) }));
    }
    private validatePageLimit(limit: number): void {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1001) fail('INVALID_PAGE_LIMIT', 'Page limit must be an integer between 1 and 1001');
    }
    recentEvents(taskId: string, limit = 200): Event[] {
        this.requireTask(taskId); this.validatePageLimit(limit);
        return this.boundedBodies('events', 'task_id=?', [taskId], limit, true, false, 1024 * 1024, 'payload').rows.reverse().map(eventFromPageRow);
    }
    latestEvent(taskId: string, type: string): Event | undefined {
        const row = this.row('SELECT * FROM events WHERE task_id=? AND type=? ORDER BY seq DESC LIMIT 1', taskId, type);
        return row ? { seq: Number(row.seq), taskId, type, payload: parse(row.payload), createdAt: String(row.created_at) } : undefined;
    }
    hasToolProposal(taskId: string, toolCallId: string): boolean {
        return !!this.row("SELECT 1 FROM events WHERE task_id=? AND type='tool.proposal_owned' AND json_extract(payload,'$.toolCallId')=? LIMIT 1", taskId, toolCallId);
    }
    eventCount(taskId: string, type: string, after = 0, intentId?: string): number {
        return Number(this.row("SELECT COUNT(*) AS n FROM events WHERE task_id=? AND type=? AND seq>? AND (? IS NULL OR json_extract(payload,'$.intentId')=?)", taskId, type, after, intentId ?? null, intentId ?? null)!.n);
    }
    latestDecision(taskId: string): Decision | undefined {
        const row = this.row('SELECT body FROM decisions WHERE task_id=? ORDER BY rowid DESC LIMIT 1', taskId);
        return row ? parse<Decision>(row.body) : undefined;
    }
    latestMemory(taskId: string, sessionId = 'main'): DerivedMemory | undefined {
        const row = this.row('SELECT body FROM derived_memories WHERE task_id=? AND session_id=? ORDER BY rowid DESC LIMIT 1', taskId, sessionId);
        return row ? parse<DerivedMemory>(row.body) : undefined;
    }
    verifiedMemorySources(taskId: string, memory: DerivedMemory): string[] {
        if (memory.taskId !== taskId || memory.sourceIds.length !== memory.sources.length || digest(memory.sources) !== memory.sourceDigest) return [];
        for (const [index, source] of memory.sources.entries()) {
            const row = this.row('SELECT body FROM messages WHERE id=? AND task_id=? AND session_id=?', source.id, taskId, memory.sessionId);
            if (memory.sourceIds[index] !== source.id || !row || digest(parse<Message>(row.body)) !== source.hash) return [];
        }
        return memory.sourceIds;
    }
    /** Only startup or a backward wall-clock step needs a set-based repair; steady ticks do no schedule scan. */
    private normalizeScheduleClock(): void {
        const at = Date.now(), previous = this.scheduleClockWall, first = !this.scheduleClockReady;
        this.scheduleClockWall = at; this.scheduleClockReady = true;
        if (!first && at >= previous) return;
        this.tx(() => {
            if (!first) this.db.prepare(`UPDATE task_schedule SET due=?+MIN(delay_ms,MAX(0,due-?)),
                delay_ms=MIN(delay_ms,MAX(0,due-?)),scheduled_at=?
                WHERE delay_ms IS NOT NULL AND due>0 AND due<?`).run(at, previous, previous, at, Number.MAX_SAFE_INTEGER);
            this.db.prepare('UPDATE task_schedule SET due=?+delay_ms,scheduled_at=? WHERE scheduled_at>? AND delay_ms IS NOT NULL AND due<?')
                .run(at, at, at, Number.MAX_SAFE_INTEGER);
            // Only this legacy reason has a known internal duration. Provider delays cannot be inferred from due alone.
            this.db.prepare(`UPDATE task_schedule SET due=MIN(due,?+30000),delay_ms=MIN(30000,MAX(0,due-?)),scheduled_at=?
                WHERE reason='effect.reconciliation' AND scheduled_at IS NULL AND due>? AND due<?`).run(at, at, at, at, Number.MAX_SAFE_INTEGER);
        });
    }
    getSchedule(taskId: string): TaskSchedule & { scheduledAt?: number; delayMs?: number; clockDiagnostic?: string } {
        this.requireTask(taskId);
        this.normalizeScheduleClock();
        const row = this.row('SELECT * FROM task_schedule WHERE task_id=?', taskId);
        const clockDiagnostic = row && row.scheduled_at === null && Number(row.due) > Date.now() && Number(row.due) < Number.MAX_SAFE_INTEGER
            ? 'Legacy retry has no clock/duration provenance. Its saved due time is unchanged; confirm the provider delay and explicitly retry if appropriate.' : undefined;
        if (clockDiagnostic && !this.latestEvent(taskId, 'schedule.clock_review_required')) this.appendEvent(taskId, 'schedule.clock_review_required', { due: Number(row!.due), reason: row!.reason, diagnostic: clockDiagnostic });
        return { taskId, due: Number(row?.due ?? 0), consecutiveFailures: Number(row?.consecutive_failures ?? 0), ...(row?.reason ? { reason: String(row.reason) } : {}),
            ...(row?.scheduled_at === null || row?.scheduled_at === undefined ? {} : { scheduledAt: Number(row.scheduled_at) }),
            ...(row?.delay_ms === null || row?.delay_ms === undefined ? {} : { delayMs: Number(row.delay_ms) }), ...(clockDiagnostic ? { clockDiagnostic } : {}) };
    }
    setReconciliationDue(taskId: string, due: number): void {
        this.requireTask(taskId);
        if (!Number.isSafeInteger(due) || due < 0) fail('INVALID_SCHEDULE', 'Reconciliation time must be a nonnegative safe integer');
        this.normalizeScheduleClock();
        const at = Date.now(), delay = due === Number.MAX_SAFE_INTEGER ? null : Math.max(0, due - at);
        this.db.prepare("INSERT INTO task_schedule(task_id,due,consecutive_failures,reason,scheduled_at,delay_ms) VALUES(?,?,0,'effect.reconciliation',?,?) ON CONFLICT(task_id) DO UPDATE SET due=excluded.due,reason=excluded.reason,scheduled_at=excluded.scheduled_at,delay_ms=excluded.delay_ms").run(taskId, due, at, delay);
    }
    reconciliationDue(taskId: string): number {
        this.normalizeScheduleClock();
        return Number(this.row("SELECT due FROM task_schedule WHERE task_id=? AND reason='effect.reconciliation'", taskId)?.due ?? 0);
    }
    clearReconciliationDue(taskId: string, onlyIfSettled = false): void {
        this.db.prepare(`UPDATE task_schedule SET due=0,reason=NULL,scheduled_at=NULL,delay_ms=NULL WHERE task_id=? AND reason='effect.reconciliation'
            ${onlyIfSettled ? "AND NOT EXISTS(SELECT 1 FROM intents WHERE task_id=? AND state IN ('unknown','sent'))" : ''}`).run(taskId, ...(onlyIfSettled ? [taskId] : []));
    }
    dependencies(taskId: string): Task[] {
        this.requireTask(taskId);
        return this.rows('SELECT t.body FROM task_dependencies d JOIN tasks t ON t.id=d.dependency_id WHERE d.task_id=? ORDER BY d.rowid', taskId).map(row => parse<Task>(row.body));
    }
    private dependenciesReady(taskId: string): boolean {
        return this.dependencies(taskId).every(task => {
            if (task.status !== 'completed') return false;
            try { this.requireChildVerification(task); return true; }
            catch (error) {
                if (error instanceof Error && 'code' in error && ['UNVERIFIED_RESULT', 'STALE_VERIFICATION'].includes(String(error.code))) return false;
                throw error;
            }
        });
    }
    runnableTasks(at = Date.now()): Task[] { return this.runnableTaskPage(0, 100, at, false).items; }
    runnableTaskPage(after = 0, limit = 100, at = Date.now(), excludeExternal = true) {
        return this.runnableSelection(after, limit, at, excludeExternal);
    }
    taskRunnable(taskId: string, at = Date.now()): boolean {
        return this.runnableSelection(0, 1, at, false, taskId).items.length > 0;
    }
    private approvalContinuationReady(task: Task): boolean {
        const run = this.currentRunningRun(task.id);
        if (!run) return false;
        for (const pending of this.db.prepare('SELECT message_id,tool_call_id FROM pending_calls WHERE task_id=? ORDER BY rowid').iterate(task.id)) {
            const effectKey = digest({ taskId: task.id, messageId: String(pending.message_id), toolCallId: String(pending.tool_call_id) });
            if (this.row("SELECT 1 FROM intents WHERE effect_key=? AND run_id=? AND state IN ('approved','denied') AND json_extract(body,'$.generation')=? AND json_extract(body,'$.policyEpoch')=?", effectKey, run.id, task.generation, task.policyEpoch)) return true;
        }
        return false;
    }
    private runnableSelection(after: number, limit: number, at: number, excludeExternal: boolean, taskId?: string) {
        this.validatePageLimit(limit);
        this.normalizeScheduleClock();
        const headers = this.rows(`SELECT t.rowid AS cursor,length(CAST(t.body AS BLOB)) AS bytes FROM tasks t LEFT JOIN task_schedule s ON s.task_id=t.id
            WHERE ((t.status='queued' AND COALESCE(s.due,0)<=? AND NOT EXISTS(
                SELECT 1 FROM task_dependencies d JOIN tasks predecessor ON predecessor.id=d.dependency_id
                WHERE d.task_id=t.id AND predecessor.status<>'completed')) OR (t.status='reconciling' AND COALESCE(s.due,0)<=?)
            OR (t.status='waiting_children' AND NOT EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id=t.id AND c.status NOT IN ('completed','failed','cancelled')))
            OR (t.status='waiting_approval' AND EXISTS(SELECT 1 FROM pending_calls p JOIN intents i ON i.task_id=p.task_id AND json_extract(i.body,'$.toolCallId')=p.tool_call_id WHERE p.task_id=t.id AND i.state IN ('approved','denied')))
            OR (t.status IN ('paused','cancelled','failed','completed') AND COALESCE(s.due,0)<=? AND EXISTS(SELECT 1 FROM intents i WHERE i.task_id=t.id AND i.state='unknown')))
            AND NOT EXISTS(SELECT 1 FROM task_origins o WHERE o.task_id=t.id AND o.state<>'ready')
            AND t.rowid>? AND (COALESCE(json_extract(t.body,'$.executionPhase'),'executing')<>'awaiting_plan_confirmation' OR t.status='reconciling' OR EXISTS(SELECT 1 FROM intents i WHERE i.task_id=t.id AND i.state='unknown'))
            ${excludeExternal ? "AND COALESCE(json_extract(t.body,'$.appMode'),'work')<>'chat' AND NOT EXISTS(SELECT 1 FROM task_execution_owners o WHERE o.task_id=t.id)" : ''}
            ${taskId ? 'AND t.id=?' : ''}
            ORDER BY t.rowid LIMIT ?`, at, at, at, after, ...(taskId ? [taskId] : []), limit);
        const { rows, hasMore } = this.boundedRecordRows('tasks', headers, limit);
        return { items: rows.map(row => parse<Task>(row.body)).filter(task => (task.status !== 'queued' || this.dependenciesReady(task.id)) && (task.status !== 'waiting_approval' || this.approvalContinuationReady(task))
            && (task.status === 'reconciling' || task.status === 'paused' || terminal.has(task.status) || !this.planningAncestor(task))), nextCursor: hasMore ? Number(rows.at(-1)!.cursor) : null };
    }
    /** Model transport retries never replay an unknown tool effect or reset a budget. */
    scheduleModelRetry(taskId: string, generation: number, reason: string, message: string, retryAfterMs = 0, at = Date.now()): TaskSchedule {
        return this.tx(() => {
            const task = this.requireTask(taskId);
            if (task.generation !== generation || task.status !== 'running') fail('STALE_GENERATION', 'Only the current running generation may schedule a retry');
            if (this.hasUnknown(taskId)) fail('UNRESOLVED_EFFECT', 'Unknown effects must be reconciled before model retries');
            const consecutiveFailures = this.getSchedule(taskId).consecutiveFailures + 1;
            const exhausted = consecutiveFailures >= 12;
            // The 15-minute cap applies to local backoff; Retry-After remains a provider minimum.
            const delay = Math.max(retryAfterMs, Math.min(15 * 60_000, 500 * 2 ** Math.min(consecutiveFailures - 1, 20))), due = at + delay;
            this.db.prepare('INSERT INTO task_schedule(task_id,due,consecutive_failures,reason,scheduled_at,delay_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET due=excluded.due,consecutive_failures=excluded.consecutive_failures,reason=excluded.reason,scheduled_at=excluded.scheduled_at,delay_ms=excluded.delay_ms').run(taskId, due, consecutiveFailures, reason, at, delay);
            if (exhausted) {
                this.control(task, 'waiting_input', 'model.retry_exhausted');
                this.updateTask(this.requireTask(taskId), { waitingReason: `Model requests failed ${consecutiveFailures} consecutive times (${reason}). Check provider availability or settings, then retry.`, error: message });
                this.appendEvent(taskId, 'model.retry_limit', { consecutiveFailures, limit: 12, due, reason });
            } else {
                this.appendEvent(taskId, 'model.retry_scheduled', { attempt: consecutiveFailures, consecutiveFailures, due, reason, maxConsecutiveFailures: 12 });
                this.control(task, 'queued', 'task.retry_requested');
            }
            return this.getSchedule(taskId);
        });
    }
    modelSucceeded(taskId: string, runId: string): void {
        this.tx(() => {
            this.assertFence(taskId, runId);
            if (!this.row('SELECT task_id FROM task_schedule WHERE task_id=? AND (due!=0 OR consecutive_failures!=0)', taskId)) return;
            this.db.prepare('UPDATE task_schedule SET due=0,consecutive_failures=0,reason=NULL,scheduled_at=NULL,delay_ms=NULL WHERE task_id=?').run(taskId);
            this.appendEvent(taskId, 'model.retry_reset', { runId });
        });
    }
    activity(days = 90, at = Date.now()): Activity {
        if (!Number.isInteger(days) || days < 1 || days > 366 || !Number.isFinite(at)) fail('INVALID_ACTIVITY_RANGE', 'Activity requires 1–366 days and a valid timestamp');
        const end = new Date(at); end.setUTCHours(0, 0, 0, 0);
        const start = new Date(end.getTime() - (days - 1) * 86400_000);
        const rows = this.rows(`SELECT substr(created_at,1,10) AS day,COUNT(*) AS events,
            SUM(CASE WHEN (type='budget.consumed' AND json_extract(payload,'$.sourceTaskId')=task_id) OR type='side_budget.consumed' THEN 1 ELSE 0 END) AS model_calls,
            SUM(CASE WHEN type='effect.receipted' THEN 1 ELSE 0 END) AS tool_effects,
            SUM(CASE WHEN type='task.created' THEN 1 ELSE 0 END) AS tasks_created,
            SUM(CASE WHEN type='task.transitioned' AND json_extract(payload,'$.to')='completed' THEN 1 ELSE 0 END) AS tasks_completed
            FROM events WHERE created_at>=? AND created_at<? GROUP BY substr(created_at,1,10)`, start.toISOString(), new Date(end.getTime() + 86400_000).toISOString());
        const byDate = new Map(rows.map(row => [String(row.day), row]));
        return { timezone: 'UTC', startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), days: Array.from({ length: days }, (_, index) => {
            const date = new Date(start.getTime() + index * 86400_000).toISOString().slice(0, 10), row = byDate.get(date);
            return { date, events: Number(row?.events ?? 0), modelCalls: Number(row?.model_calls ?? 0), toolEffects: Number(row?.tool_effects ?? 0), tasksCreated: Number(row?.tasks_created ?? 0), tasksCompleted: Number(row?.tasks_completed ?? 0) };
        }) };
    }
    listSessions(taskId: string, limit?: number): { id: string; label: string; messages: Message[] }[] {
        this.requireTask(taskId);
        return this.rows("SELECT DISTINCT session_id FROM messages WHERE task_id=? AND session_id!='main' ORDER BY rowid", taskId)
            .map(row => ({ id: String(row.session_id), label: String(row.session_id), messages: limit ? this.tailMessages(taskId, limit, String(row.session_id)) : this.getMessages(taskId, String(row.session_id)) }));
    }
    recentSideSessions(taskId: string, limit = 20): { id: string; label: string; messages: Message[] }[] {
        this.requireTask(taskId); this.validatePageLimit(limit);
        return this.rows("SELECT session_id FROM messages WHERE task_id=? AND session_id<>'main' GROUP BY session_id ORDER BY MAX(rowid) DESC LIMIT ?", taskId, limit)
            .map(row => { const id = String(row.session_id); return { id, label: id, messages: this.boundedBodies('messages', 'task_id=? AND session_id=?', [taskId, id], 20, true, false, 48 * 1024).rows.reverse().map(item => parse<Message>(item.body)) }; });
    }
    getMemories(taskId: string, sessionId = 'main'): DerivedMemory[] {
        this.requireTask(taskId);
        return this.rows('SELECT body FROM derived_memories WHERE task_id=? AND session_id=? ORDER BY rowid', taskId, sessionId).map(row => parse<DerivedMemory>(row.body));
    }
    saveMemory(taskId: string, input: MemoryInput): DerivedMemory {
        return this.tx(() => {
            const sessionId = input.sessionId ?? 'main';
            const requested = new Set(input.sourceIds);
            const sourceMessages = [...requested].flatMap(messageId => {
                const row = this.row('SELECT body FROM messages WHERE id=? AND task_id=? AND session_id=?', messageId, taskId, sessionId);
                return row ? [parse<Message>(row.body)] : [];
            });
            if (!requested.size || sourceMessages.length !== requested.size) fail('INVALID_MEMORY_SOURCE', 'Every memory source must be an original message in the same task session');
            const sources = sourceMessages.map(message => ({ id: message.id, hash: digest(message) }));
            const sourceDigest = digest(sources);
            const previous = this.row('SELECT body FROM derived_memories WHERE task_id=? AND session_id=? AND kind=? AND source_digest=?', taskId, sessionId, input.kind, sourceDigest);
            if (previous) return parse<DerivedMemory>(previous.body);
            const memory: DerivedMemory = { id: id(), taskId, sessionId, kind: input.kind, text: input.text, sourceIds: sources.map(source => source.id), sources, sourceDigest, createdAt: now() };
            this.db.prepare('INSERT INTO derived_memories VALUES(?,?,?,?,?,?)').run(memory.id, taskId, sessionId, sourceDigest, input.kind, JSON.stringify(memory));
            this.appendEvent(taskId, 'memory.derived', { memoryId: memory.id, sessionId, kind: memory.kind, sourceDigest, sourceIds: memory.sourceIds });
            return memory;
        });
    }
    events(taskId: string, after = 0, limit?: number): Event[] {
        this.requireTask(taskId);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1001)) {
            fail('INVALID_EVENT_LIMIT', 'Event page limit must be an integer between 1 and 1001');
        }
        const query = 'SELECT * FROM events WHERE task_id=? AND seq>? ORDER BY seq';
        const rows = limit === undefined ? this.rows(query, taskId, after) : this.rows(`${query} LIMIT ?`, taskId, after, limit);
        return rows.map(row => ({ seq: Number(row.seq), taskId, type: String(row.type), payload: parse(row.payload), createdAt: String(row.created_at) }));
    }
    intents(taskId: string): Intent[] { this.requireTask(taskId); return this.rows('SELECT body FROM intents WHERE task_id=? ORDER BY rowid', taskId).map(r => parse<Intent>(r.body)); }
    /** State changes while iterating cannot skip rows; settled archive bodies never enter JS. */
    *intentsByState(taskId: string, states: readonly Intent['state'][]): Generator<Intent> {
        if (!states.length) return;
        let after = 0;
        // Merge indexed state ranges by rowid instead of scanning the task's full history.
        const sql = states.map(() => 'SELECT rowid AS cursor,body FROM intents WHERE task_id=? AND state=? AND rowid>?').join(' UNION ALL ') + ' ORDER BY cursor LIMIT 100';
        for (;;) {
            const page = this.rows(sql, ...states.flatMap(state => [taskId, state, after]));
            for (const row of page) yield parse<Intent>(row.body);
            if (page.length < 100) return;
            after = Number(page[page.length - 1]!.cursor);
        }
    }
    getIntent(intentId: string): Intent | undefined { const row = this.row('SELECT body FROM intents WHERE id=?', intentId); return row ? parse<Intent>(row.body) : undefined; }
    intentForEffect(effectKey: string): Intent | undefined { const row = this.row('SELECT body FROM intents WHERE effect_key=?', effectKey); return row ? parse<Intent>(row.body) : undefined; }
    /**
     * Actionable approvals for the operator projection. The partial index and the persisted prepared_at
     * column keep this bounded: it never enumerates tasks, intents or events. Only a prepared intent
     * whose policy outcome is exactly "ask" is actionable by a human. An unknown task filter returns []
     * like the legacy product list instead of NOT_FOUND.
     */
    pendingApprovals(options: { taskId?: string; limit?: number } = {}): PendingApproval[] {
        const limit = options.limit ?? APPROVAL_LIMIT;
        if (!Number.isInteger(limit) || limit < 1 || limit > APPROVAL_LIMIT)
            fail('INVALID_PAGE_LIMIT', `Approval limit must be an integer between 1 and ${APPROVAL_LIMIT}`);
        const select = `SELECT i.body AS intent_body,i.prepared_at AS prepared_at,t.body AS task_body
            FROM intents i JOIN tasks t ON t.id=i.task_id
            WHERE i.state='prepared' AND json_extract(i.body,'$.authorization.decision')='ask'`;
        const order = ' ORDER BY i.prepared_at DESC,i.rowid DESC LIMIT ?';
        const rows = options.taskId === undefined
            ? this.rows(select + order, limit)
            : this.rows(select + ' AND i.task_id=?' + order, options.taskId, limit);
        return rows.map(row => {
            const task = parse<Task>(row.task_body);
            let intent = parse<Intent>(row.intent_body);
            if (intent.fileConflicts && intent.authorization) {
                try {
                    const decision = this.decideIntent(intent.id);
                    intent = { ...intent, authorization: { ...intent.authorization, decision: decision.outcome, reason: decision.reason, requiresOperator: decision.requiresOperator } };
                } catch (error) {
                    if (!(error instanceof Error) || !('code' in error) || error.code !== 'FILE_CONFLICT_STALE') throw error;
                    intent = { ...intent, authorization: { ...intent.authorization!, reason: `FILE_CONFLICT_STALE: ${error.message}` } };
                }
            }
            return {
                intent,
                task,
                // Null means the prepared event is genuinely missing; never substitute task.updatedAt.
                preparedAt: typeof row.prepared_at === 'string' ? row.prepared_at : null,
            };
        });
    }
    /** The persisted origin time of one intent; no event scan. */
    preparedAt(intentId: string): string | undefined {
        const value = this.row('SELECT prepared_at FROM intents WHERE id=?', intentId)?.prepared_at;
        return typeof value === 'string' ? value : undefined;
    }
    getRuns(taskId: string): Run[] { return this.rows('SELECT body FROM runs WHERE task_id=? ORDER BY rowid', taskId).map(r => parse<Run>(r.body)); }
    private runningRuns(taskId: string): Run[] { return this.rows("SELECT body FROM runs WHERE task_id=? AND status='running' ORDER BY rowid", taskId).map(r => parse<Run>(r.body)); }
    latestRun(taskId: string): Run | undefined { const row = this.row('SELECT body FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1', taskId); return row ? parse<Run>(row.body) : undefined; }
    currentRunningRun(taskId: string, generation?: number): Run | undefined {
        const task = this.requireTask(taskId);
        const row = this.row("SELECT body FROM runs WHERE task_id=? AND generation=? AND policy_epoch=? AND status='running' ORDER BY rowid DESC LIMIT 1", taskId, generation ?? task.generation, task.policyEpoch);
        return row ? parse<Run>(row.body) : undefined;
    }
    getDecisions(taskId: string): Decision[] { return this.rows('SELECT body FROM decisions WHERE task_id=? ORDER BY rowid', taskId).map(r => parse<Decision>(r.body)); }
    getVerifications(taskId: string): Verification[] { return this.rows('SELECT body FROM verifications WHERE task_id=? ORDER BY rowid', taskId).map(r => parse<Verification>(r.body)); }
    getCheckpoints(taskId: string): Checkpoint[] { return this.rows('SELECT body FROM checkpoints WHERE task_id=? ORDER BY rowid', taskId).map(r => parse<Checkpoint>(r.body)); }
    /** Display tails are bounded in SQLite; the full archive readers above retain their contract. */
    recentCheckpoints(taskId: string, limit = 20): Checkpoint[] {
        this.validatePageLimit(limit);
        return this.rows('SELECT body FROM checkpoints WHERE task_id=? ORDER BY rowid DESC LIMIT ?', taskId, limit)
            .reverse().map(row => parse<Checkpoint>(row.body));
    }
    latestVerification(taskId: string): Verification | undefined {
        const row = this.row('SELECT body FROM verifications WHERE task_id=? ORDER BY rowid DESC LIMIT 1', taskId);
        return row ? parse<Verification>(row.body) : undefined;
    }
    getBudgets(taskId: string): Budget {
        const row = this.row('SELECT * FROM budgets WHERE task_id=?', taskId) ?? fail('NOT_FOUND', 'Budget not found');
        return { taskId, maxModelCalls: Number(row.max_model_calls), modelCalls: Number(row.model_calls), maxToolCalls: Number(row.max_tool_calls), toolCalls: Number(row.tool_calls) };
    }
    getSideBudgets(taskId: string, limit?: number): SideBudget[] {
        this.requireTask(taskId);
        if (limit !== undefined) this.validatePageLimit(limit);
        return this.rows(`SELECT * FROM side_budgets WHERE task_id=? ORDER BY rowid DESC${limit === undefined ? '' : ' LIMIT ?'}`, taskId, ...(limit === undefined ? [] : [limit])).reverse().map(row => ({
            taskId, sessionId: String(row.session_id), maxModelCalls: Number(row.max_model_calls), modelCalls: Number(row.model_calls),
        }));
    }
    delegations(taskId: string): Delegation[] { return this.rows('SELECT body FROM delegations WHERE task_id=? ORDER BY rowid', taskId).map(r => parse<Delegation>(r.body)); }
    recentDelegations(taskId: string, limit = 100): Delegation[] {
        return this.boundedBodies('delegations', 'task_id=?', [taskId], limit, true).rows.reverse().map(row => parse<Delegation>(row.body));
    }
    private requireDelegationTasks(parentTaskId: string): void {
        this.requireTask(parentTaskId);
        // Preserve full-query corruption detection, including references beyond the displayed page.
        const missing = this.row(`SELECT d.child_task_id FROM delegations d LEFT JOIN tasks t ON t.id=d.child_task_id
            WHERE d.task_id=? AND t.id IS NULL ORDER BY d.rowid LIMIT 1`, parentTaskId);
        if (missing) fail('NOT_FOUND', `Task ${String(missing.child_task_id)} does not exist`);
    }
    /** Product's first 50 children in delegation order; archive bodies and verdicts are not display data. */
    subagentSummaries(parentTaskId: string) {
        this.requireDelegationTasks(parentTaskId);
        return this.rows(`SELECT d.id,t.id AS task_id,t.status,json_extract(t.body,'$.title') AS title
            FROM delegations d JOIN tasks t ON t.id=d.child_task_id WHERE d.task_id=? ORDER BY d.rowid LIMIT 50`, parentTaskId)
            .map(row => ({ id: String(row.id), taskId: String(row.task_id), title: String(row.title), status: String(row.status) as Task['status'] }));
    }
    /** Scheduler readiness only. Independent verification and delegation acceptance remain separate. */
    delegationTasksTerminal(parentTaskId: string): boolean {
        this.requireDelegationTasks(parentTaskId);
        return !this.row(`SELECT EXISTS(SELECT 1 FROM delegations d JOIN tasks t ON t.id=d.child_task_id
            WHERE d.task_id=? AND t.status NOT IN ('completed','failed','cancelled')) AS unfinished`, parentTaskId)!.unfinished;
    }
    /** Small current-state projection for every model turn; full results remain in list_delegations. */
    delegationProgress(taskId: string) {
        const parent = this.requireTask(taskId), limit = 8;
        const total = Number(this.row('SELECT COUNT(*) AS total FROM delegations WHERE task_id=?', taskId)!.total);
        const items = this.rows(`SELECT t.id,t.status,substr(json_extract(t.body,'$.title'),1,120) AS title,
            substr(json_extract(t.body,'$.result'),1,400) AS result,
            length(json_extract(t.body,'$.result')) AS result_chars,
            json_extract(d.body,'$.state') AS settlement,
            json_extract(d.body,'$.parentGoalVersion') AS goal_version
            FROM delegations d JOIN tasks t ON t.id=d.child_task_id WHERE d.task_id=?
            ORDER BY CASE WHEN t.status NOT IN ('completed','failed','cancelled') THEN 0
                WHEN json_extract(d.body,'$.state') NOT IN ('accepted','dismissed') THEN 1 ELSE 2 END,d.rowid DESC LIMIT ?`, taskId, limit)
            .map(row => ({ id: String(row.id), title: String(row.title), status: String(row.status), settlement: String(row.settlement),
                needsReaccept: Number(row.goal_version) !== parent.goalVersion,
                ...(row.result !== null ? { resultPreview: String(row.result), resultTruncated: Number(row.result_chars) > 400 } : {}) }));
        return { total, items, omitted: total - items.length,
            hint: 'A bounded progress preview, not acceptance evidence. Use list_delegations for full results and verification before accepting work.' };
    }
    /** Dependencies are limited to 64 by delegation, but their result bodies need not be small. */
    dependencyProgress(taskId: string) {
        this.requireTask(taskId);
        const limit = 8;
        const total = Number(this.row('SELECT COUNT(*) AS total FROM task_dependencies WHERE task_id=?', taskId)!.total);
        const items = this.rows(`SELECT t.id,t.status,substr(json_extract(t.body,'$.result'),1,400) AS result,
            length(json_extract(t.body,'$.result')) AS result_chars
            FROM task_dependencies d JOIN tasks t ON t.id=d.dependency_id WHERE d.task_id=?
            ORDER BY CASE WHEN t.status='completed' THEN 1 ELSE 0 END,d.rowid LIMIT ?`, taskId, limit)
            .map(row => ({ id: String(row.id), status: String(row.status),
                ...(row.result !== null ? { resultPreview: String(row.result), resultTruncated: Number(row.result_chars) > 400 } : {}) }));
        return { total, items, omitted: total - items.length,
            hint: 'Dependency previews do not prove readiness. Kernel scheduling and independent verification remain authoritative.' };
    }
    queryDelegations(parentTaskId: string): { delegation: Delegation; task: Task; verification?: Verification }[] {
        this.requireTask(parentTaskId);
        return this.delegations(parentTaskId).map(delegation => ({
            delegation,
            task: this.requireTask(delegation.childTaskId),
            verification: this.latestVerification(delegation.childTaskId),
        }));
    }
    /** Model control responses carry bounded previews and source identities, never full child archives. */
    delegationPage(taskId: string, after = 0, limit = 16, childTaskId?: string) {
        this.requireTask(taskId);
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 32) fail('INVALID_CURSOR', 'Delegation page requires a nonnegative cursor and limit 1–32');
        const rows = this.rows(`SELECT d.rowid AS cursor,d.child_task_id AS childTaskId,json_extract(d.body,'$.state') AS settlement,t.status,
            substr(json_extract(t.body,'$.title'),1,200) AS title,substr(json_extract(t.body,'$.result'),1,1000) AS resultPreview,
            length(json_extract(t.body,'$.result')) AS resultChars,
            (SELECT m.id FROM messages m WHERE m.task_id=t.id AND m.session_id='main' AND json_extract(m.body,'$.role')='assistant' AND COALESCE(json_array_length(m.body,'$.toolCalls'),0)=0 ORDER BY m.rowid DESC LIMIT 1) AS resultMessageId,
            (SELECT json_object('id',v.id,'passed',json_extract(v.body,'$.record.passed'),'verdict',json_extract(v.body,'$.record.verdict')) FROM verifications v WHERE v.task_id=t.id ORDER BY v.rowid DESC LIMIT 1) AS verification
            FROM delegations d JOIN tasks t ON t.id=d.child_task_id WHERE d.task_id=? AND d.rowid>? ${childTaskId ? 'AND d.child_task_id=?' : ''} ORDER BY d.rowid LIMIT ?`, taskId, after, ...(childTaskId ? [childTaskId] : []), limit + 1);
        const selected = rows.slice(0, limit);
        return { items: selected.map(row => ({ childTaskId: String(row.childTaskId), settlement: String(row.settlement), status: String(row.status), title: String(row.title), resultPreview: row.resultPreview,
            resultTruncated: Number(row.resultChars) > 1000, resultMessageId: row.resultMessageId, verification: row.verification ? parse(row.verification) : null })),
            nextCursor: rows.length > limit ? Number(selected.at(-1)!.cursor) : null,
            hint: 'Previews are not full acceptance evidence. Read resultMessageId via read_collaboration; Kernel independently validates child verification before acceptance.' };
    }
    commandEvent(taskId: string, type: string, commandId: string): Event | undefined {
        const row = this.row("SELECT * FROM events WHERE task_id=? AND type=? AND json_extract(payload,'$.commandId')=? ORDER BY seq DESC LIMIT 1", taskId, type, commandId);
        return row ? { seq: Number(row.seq), taskId, type, payload: parse(row.payload), createdAt: String(row.created_at) } : undefined;
    }
    appendEvent(taskId: string, type: string, payload: Record<string, unknown> = {}): Event {
        this.requireTask(taskId);
        const createdAt = now();
        const result = this.db.prepare('INSERT INTO events(task_id,type,payload,created_at) VALUES(?,?,?,?)').run(taskId, type, JSON.stringify(payload), createdAt);
        return { seq: Number(result.lastInsertRowid), taskId, type, payload, createdAt };
    }
    addMessage(taskId: string, role: Message['role'], content: string, sessionId = 'main', extra: Partial<Message> = {}): Message {
        return this.tx(() => {
            this.requireTask(taskId);
            if (!sessionId || !['system', 'user', 'assistant', 'tool'].includes(role))
                fail('INVALID_MESSAGE', 'Invalid role or session');
            if (role === 'user' && Buffer.byteLength(content, 'utf8') > 1024 * 1024)
                fail('INPUT_LIMIT', 'A user message is limited to 1 MiB; attach or reference larger source material.');
            this.validateToolCalls(extra.toolCalls);
            if (extra.toolCallId !== undefined && (typeof extra.toolCallId !== 'string' || !extra.toolCallId.trim()))
                fail('INVALID_TOOL_CALL', 'A tool result needs a non-empty tool call id');
            // A caller that owns a live display projection may reserve the durable identity before the
            // provider finishes; the Kernel still validates it and remains the only writer.
            if (extra.id !== undefined && (typeof extra.id !== 'string' || !extra.id.trim()))
                fail('INVALID_MESSAGE', 'A reserved message id must be a non-empty string');
            if (extra.createdAt !== undefined && (typeof extra.createdAt !== 'string' || !extra.createdAt.trim()))
                fail('INVALID_MESSAGE', 'A reserved message timestamp must be a non-empty string');
            // Provider reasoning is optional and may legally be blank at the transport boundary. Only an
            // assistant turn may carry it; a blank value is absent rather than an empty thinking block,
            // so a legal provider blank never fails the Work turn.
            const { reasoningContent: rawReasoning, ...rest } = extra;
            if (rawReasoning !== undefined && role !== 'assistant')
                fail('INVALID_MESSAGE', 'Reasoning content belongs to an assistant message');
            if (rawReasoning !== undefined && typeof rawReasoning !== 'string')
                fail('INVALID_MESSAGE', 'Reasoning content must be text');
            const reasoningContent = typeof rawReasoning === 'string' && rawReasoning.trim() ? rawReasoning : undefined;
            const message: Message = { ...rest, ...(reasoningContent ? { reasoningContent } : {}), id: rest.id ?? id(), taskId, role, content, sessionId, createdAt: rest.createdAt ?? now() };
            this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(message.id, taskId, sessionId, JSON.stringify(message), message.createdAt);
            if (sessionId === 'main') {
                for (const call of message.toolCalls ?? []) this.db.prepare('INSERT INTO pending_calls VALUES(?,?,?,?)').run(taskId, message.id, call.id, JSON.stringify(call));
                if (role === 'tool' && message.toolCallId) this.db.prepare('DELETE FROM pending_calls WHERE rowid=(SELECT rowid FROM pending_calls WHERE task_id=? AND tool_call_id=? ORDER BY rowid DESC LIMIT 1)').run(taskId, message.toolCallId);
            }
            this.appendEvent(taskId, 'message.appended', { messageId: message.id, sessionId, role, ...(message.requestId ? { requestId: message.requestId } : {}) });
            return message;
        });
    }
    /**
     * Tool calls arrive from model output and are the identity used to answer them later, so they
     * cross the storage boundary as untrusted input. Provider ids are opaque: require a non-empty
     * string, but no particular syntax. Duplicate ids are rejected here because the pending_calls
     * primary key would otherwise surface a raw SQLite constraint error after part of the message
     * was written; the surrounding transaction then rolls the whole append back.
     */
    private validateToolCalls(calls: unknown): void {
        if (calls === undefined) return;
        if (!Array.isArray(calls)) fail('INVALID_TOOL_CALL', 'Tool calls must be an array');
        const ids = new Set<string>();
        for (const call of calls) {
            if (!call || typeof call !== 'object' || Array.isArray(call)) fail('INVALID_TOOL_CALL', 'Every tool call must be an object');
            const { id: toolCallId, name, arguments: toolArguments } = call as Partial<ToolCall>;
            if (typeof toolCallId !== 'string' || !toolCallId.trim()) fail('INVALID_TOOL_CALL', 'Every tool call needs a non-empty string id');
            if (ids.has(toolCallId)) fail('INVALID_TOOL_CALL', 'Tool call ids must be unique within one message');
            ids.add(toolCallId);
            if (typeof name !== 'string' || !name.trim()) fail('INVALID_TOOL_CALL', 'Every tool call needs a non-empty name');
            if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments)) fail('INVALID_TOOL_CALL', 'Tool call arguments must be an object');
        }
    }
    transition(taskId: string, status: TaskStatus, patch: Partial<Task> = {}): Task {
        return this.tx(() => {
            const task = this.requireTask(taskId);
            if (executionStatuses.has(status)) this.assertWorkOriginReady(taskId);
            if (patch.generation !== undefined && patch.generation !== task.generation)
                fail('STALE_GENERATION', 'Run generation has been superseded');
            if (task.status !== status && !transitions[task.status].includes(status))
                fail('INVALID_TRANSITION', `${task.status} cannot transition to ${status}`);
            if (task.status === 'waiting_children' && status === 'queued') {
                return this.control(task, 'queued', 'task.children_ready');
            }
            if (status === 'completed' && this.row("SELECT 1 FROM intents WHERE task_id=? AND state IN ('prepared','approved','sent','unknown') LIMIT 1", taskId))
                fail('UNRESOLVED_EFFECT', 'Task has unresolved tool effects');
            if (status === 'completed')
                this.requireCompletionVerification(task);
            const next = this.updateTask(task, { status, result: patch.result ?? task.result, error: patch.error, waitingReason: patch.waitingReason });
            this.appendEvent(taskId, 'task.transitioned', { from: task.status, to: status, generation: task.generation, ...('error' in patch ? { error: patch.error } : {}) });
            return next;
        });
    }
    private makeTask(parameters: Record<string, unknown>, parent?: Task, origin?: Command['origin'], initialStatus?: 'paused', branchOrigin?: BranchOriginInput): Task {
        const supplied = (parameters.goal ?? {}) as Partial<GoalContract>;
        const rawObjective = String(supplied.objective ?? parameters.objective ?? parameters.title ?? '');
        const objective = rawObjective.trim();
        if (!objective)
            fail('INVALID_GOAL', 'A nonempty objective is required');
        // A model-originated child inherits the parent's finite budget and workspace; parameters may
        // never grant a bigger allowance or point the child at a different workspace.
        const modelChild = origin === 'model' && parent;
        const maxModelCalls = Number(modelChild ? parent.goal.maxModelCalls
            : supplied.maxModelCalls ?? parameters.maxModelCalls ?? parent?.goal.maxModelCalls ?? 20);
        this.validateBudgetLimit(maxModelCalls, 'Model');
        const inheritedToolCalls = parent?.goal.maxToolCalls ?? Math.min(maxModelCalls * 5, 10000);
        const maxToolCalls = Number(modelChild ? inheritedToolCalls
            : supplied.maxToolCalls ?? parameters.maxToolCalls ?? inheritedToolCalls);
        this.validateBudgetLimit(maxToolCalls, 'Tool');
        const permission = this.newTaskPermission(parameters, parent, origin);
        const taskId = id();
        const timestamp = now();
        const sharedPaths = Array.isArray(parameters.paths) && parameters.paths.length > 0;
        const defaultWorkspace = parent
            ? sharedPaths ? parent.workspace : path.join(parent.workspace, 'subtasks', taskId)
            : path.join(this.dataDir, 'workspaces', taskId);
        const requestedWorkspace = modelChild ? undefined : parameters.workspace;
        const constraints = [...new Set([...(parent?.goal.constraints ?? []), ...(Array.isArray(supplied.constraints) ? supplied.constraints.map(String) : [])])];
        const goal: GoalContract = { objective, constraints, acceptance: Array.isArray(supplied.acceptance) ? supplied.acceptance.map(String) : [], maxModelCalls, maxToolCalls, mode: supplied.mode === 'autonomous' ? 'autonomous' : 'collaborative' };
        const task: Task = { id: taskId, ...(parent ? { parentId: parent.id } : {}), title: String(parameters.title ?? objective.slice(0, 80)), goal, status: initialStatus ?? 'queued', revision: 1, goalVersion: 1, policyEpoch: 1, generation: 1, createdAt: timestamp, updatedAt: timestamp, workspace: path.resolve(String(requestedWorkspace ?? defaultWorkspace)), owner: String(modelChild ? `worker-${taskId}` : parameters.owner ?? (parent ? `worker-${taskId}` : 'main')), modelCalls: 0, permissionMode: permission.mode, appMode: permission.appMode };
        if (parameters.executionPhase !== undefined && !['planning', 'executing'].includes(String(parameters.executionPhase))) fail('INVALID_PHASE', 'New tasks start in planning or executing');
        task.executionPhase = parent?.executionPhase ?? (parameters.executionPhase === 'planning' ? 'planning' : 'executing');
        if (parent && !this.within(parent.workspace, task.workspace))
            fail('OUTSIDE_WORKSPACE', 'A child workspace must stay inside its parent workspace');
        this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(task.id, parent?.id ?? null, task.status, task.revision, JSON.stringify(task));
        this.db.prepare('INSERT INTO goals VALUES(?,?,?,?,?)').run(id(), task.id, 1, JSON.stringify(goal), timestamp);
        this.db.prepare('INSERT INTO budgets(task_id,max_model_calls,max_tool_calls) VALUES(?,?,?)').run(task.id, maxModelCalls, maxToolCalls);
        const ceiling = parent ? this.getCapabilityCeiling(parent.id) : capabilities;
        this.db.prepare('INSERT INTO policies VALUES(?,?)').run(task.id, JSON.stringify(ceiling));
        // The durable marker lives in the same transaction as the paused task row. A crash can therefore
        // never leave a branch that looks normal but has no immutable origin preparation behind it.
        if (branchOrigin) {
            this.db.prepare('INSERT INTO task_origins(task_id,source_task_id,source_message_id,snapshot,expected_count,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
                .run(task.id, branchOrigin.sourceTaskId, branchOrigin.sourceMessageId, branchOrigin.snapshot, branchOrigin.expectedCount, 'pending', timestamp, timestamp);
        }
        this.appendEvent(task.id, 'task.created', { goalVersion: 1, parentId: parent?.id ?? null, owner: task.owner });
        if (branchOrigin) this.appendEvent(task.id, 'task.origin_pending', { sourceTaskId: branchOrigin.sourceTaskId, sourceMessageId: branchOrigin.sourceMessageId, snapshot: branchOrigin.snapshot, expectedCount: branchOrigin.expectedCount });
        // Permission events record an explicit permission request; a plain task keeps its historical event sequence.
        const requestedPermission = parameters.permissionMode ?? parameters.appMode ?? parameters.permission;
        if (requestedPermission !== undefined) {
            if (parent) this.appendEvent(task.id, 'permission.inherited', { permissionMode: permission.mode, appMode: permission.appMode, parentTaskId: parent.id, parentMode: this.storedPermission(parent).mode, requested: requestedPermission });
            else this.appendEvent(task.id, 'permission.assigned', { permissionMode: permission.mode, appMode: permission.appMode, origin: origin ?? 'operator' });
        }
        this.addMessage(task.id, 'user', rawObjective);
        return task;
    }
    /** New tasks start from the operator's request; model-originated tasks and delegated children may only keep or narrow the parent's authority. */
    private newTaskPermission(parameters: Record<string, unknown>, parent: Task | undefined, origin: Command['origin']): { mode: PermissionMode; appMode: AppMode } {
        // Model-originated tasks inherit the parent authority and ignore every requested permission field.
        if (origin === 'model') {
            if (!parent) return { mode: 'ask', appMode: 'work' };
            return this.storedPermission(parent);
        }
        const alias = parameters.permission;
        if (alias !== undefined && (typeof alias !== 'object' || alias === null || Array.isArray(alias)))
            fail('INVALID_PERMISSION', 'permission must be an object with an optional mode and app');
        const shape = alias as { mode?: unknown; app?: unknown } | undefined;
        const requestedMode = parameters.permissionMode ?? shape?.mode;
        const requestedApp = parameters.appMode ?? shape?.app;
        if (requestedMode !== undefined && !isPermissionMode(requestedMode))
            fail('INVALID_PERMISSION', 'permissionMode must be read-only, ask, auto-review or full-access');
        if (requestedApp !== undefined && !isAppMode(requestedApp))
            fail('INVALID_PERMISSION', "appMode must be 'chat' or 'work'");
        if (!parent) {
            const appMode: AppMode = (requestedApp as AppMode | undefined) ?? 'work';
            const mode: PermissionMode = appMode === 'chat' ? 'read-only' : (requestedMode as PermissionMode | undefined) ?? 'ask';
            return { mode, appMode };
        }
        const inherited = this.storedPermission(parent);
        const appMode: AppMode = inherited.appMode === 'chat' || requestedApp === 'chat' ? 'chat' : 'work';
        if (requestedMode !== undefined && modeRank(requestedMode as PermissionMode) > modeRank(inherited.mode))
            fail('PERMISSION_ESCALATION', 'A delegated task may only inherit or narrow the parent permission mode');
        const mode: PermissionMode = appMode === 'chat' ? 'read-only' : (requestedMode as PermissionMode | undefined) ?? inherited.mode;
        return { mode, appMode };
    }
    /** One delegated child with its dependency edges, path claim and delegation record. */
    private delegateTask(parent: Task, parameters: Record<string, unknown>, origin?: Command['origin']): Task {
        if (parent.executionPhase && parent.executionPhase !== 'executing') fail('PLAN_MODE', 'Approve the current plan before starting executable child tasks');
        const dependencies = parameters.dependsOn ?? [];
        if (!Array.isArray(dependencies) || dependencies.length > 64 || dependencies.some(value => typeof value !== 'string' || this.getTask(value)?.parentId !== parent.id))
            fail('INVALID_DEPENDENCY', 'Dependencies must be at most 64 existing siblings of this new child');
        const child = this.makeTask(parameters, parent, origin);
        if (parent.status === 'paused') this.pauseTree(child, parent.id);
        for (const dependency of new Set(dependencies as string[]))
            this.db.prepare('INSERT INTO task_dependencies VALUES(?,?)').run(child.id, dependency);
        if (dependencies.length) this.appendEvent(child.id, 'task.dependencies_assigned', { dependsOn: [...new Set(dependencies)] });
        const delegation: Delegation = { id: id(), taskId: parent.id, childTaskId: child.id, owner: child.owner, state: 'assigned', parentGoalVersion: parent.goalVersion, createdAt: now() };
        this.db.prepare('INSERT INTO delegations VALUES(?,?,?,?)').run(delegation.id, parent.id, child.id, JSON.stringify(delegation));
        if (Array.isArray(parameters.paths) && parameters.paths.length)
            this.claimPaths(child.id, parameters.paths.map(String));
        else this.claimPaths(child.id, ['.']);
        this.updateTask(parent, {});
        this.appendEvent(parent.id, 'task.delegated', { childTaskId: child.id, delegationId: delegation.id });
        return child;
    }
    command(command: Command): CommandAck {
        return this.tx(() => {
            if (!command.commandId || !command.type)
                fail('INVALID_COMMAND', 'A commandId and type are required');
            const commandDigest = digest(command);
            const previous = this.row('SELECT digest, ack FROM commands WHERE id=?', command.commandId);
            if (previous) {
                if (previous.digest !== commandDigest)
                    fail('IDEMPOTENCY_CONFLICT', 'Command ID was reused with different content');
                return { ...parse<CommandAck>(previous.ack), status: 'duplicate' };
            }
            const p = command.parameters ?? {};
            if (command.origin === 'side' && command.type === 'create_task') {
                const source = command.source;
                const binding = source && this.row('SELECT objective FROM side_binding_turns WHERE message_id=? AND session_id=?', source.userMessageId, source.sessionId);
                const goal = p.goal as Partial<GoalContract> | undefined;
                if (!binding || command.taskId || p.initialStatus !== 'paused' || p.permissionMode !== 'ask' || p.appMode !== 'work'
                    || goal?.objective !== binding.objective || goal?.maxModelCalls !== 100 || goal?.maxToolCalls !== undefined
                    || Object.keys(p).some(key => !['title', 'initialStatus', 'permissionMode', 'appMode', 'goal'].includes(key)))
                    fail('SIDE_AUTHORITY', 'Side binding can only create a paused ask-permission task for the registered user input');
            } else if (command.origin === 'side') {
                const source = command.source;
                if (!source || !command.taskId || !Number.isSafeInteger(command.expectedRevision)
                    || !this.row('SELECT 1 FROM side_control_turns WHERE message_id=? AND session_id=? AND task_id=?', source.userMessageId, source.sessionId, command.taskId))
                    fail('SIDE_AUTHORITY', 'Side control requires a server-bound user turn and exact task revision');
                if (!['send_message', 'pause', 'resume', 'cancel', 'retry', 'revise_goal', 'enter_plan', 'propose_tool'].includes(command.type))
                    fail('SIDE_AUTHORITY', 'This operation is outside the side conversation control scope');
                const goal = p.goal as Partial<GoalContract> | undefined;
                if (goal && (goal.maxModelCalls !== undefined || goal.maxToolCalls !== undefined)) fail('OPERATOR_REQUIRED', 'Side control cannot authorize more budget');
                if (this.requireTask(command.taskId).status === 'cancelled') fail('CANCELLED_TASK', 'A cancelled target cannot receive side actions');
            }
            if (command.origin === 'model' && ['revise_goal', 'renew_budget'].includes(command.type)) {
                fail('OPERATOR_REQUIRED', 'Only an operator can revise the objective or authorize a new finite budget');
            }
            if (command.origin === 'model' && ['grant', 'deny', 'set_permission'].includes(command.type)) {
                fail('OPERATOR_REQUIRED', 'Only an operator can grant, deny or change task permissions');
            }
            if (command.origin === 'model' && command.type === 'approve_plan') fail('OPERATOR_REQUIRED', 'Only the user may approve an exact plan version');
            let task = command.taskId ? this.requireTask(command.taskId) : undefined;
            let delegatedChildId: string | undefined;
            if (task && command.expectedRevision !== undefined && task.revision !== command.expectedRevision)
                fail('REVISION_CONFLICT', `Expected revision ${command.expectedRevision}, current revision ${task.revision}`);
            const sessionId = String(p.sessionId ?? 'main');
            if (sessionId !== 'main' && command.type !== 'send_message')
                fail('SIDE_SESSION_CONTROL', 'Auxiliary sessions cannot control the main task');
            if (command.type === 'create_task') {
                // A root task is operator authority. A model may only add a delegated child under
                // the task it already runs, never a new independent root with its own workspace.
                // 'paused' exists for a new operator branch: the row is inserted paused in this same
                // transaction, so a restart can never observe an executable queued window first.
                const initialStatus: 'paused' | undefined = p.initialStatus === undefined ? undefined
                    : p.initialStatus === 'paused' ? 'paused'
                        : fail('INVALID_INITIAL_STATUS', "initialStatus must be 'paused' when present");
                if (command.origin === 'model') {
                    if (!task) fail('OPERATOR_REQUIRED', 'Only an operator can create a root task');
                    if (initialStatus) fail('OPERATOR_REQUIRED', 'Only an operator can create an initially paused task');
                    if (p.branchOrigin !== undefined) fail('OPERATOR_REQUIRED', 'Only an operator can prepare a cross-database branch origin');
                    if (terminal.has(task.status)) fail('TERMINAL_TASK', 'A terminal task cannot delegate');
                    task = this.delegateTask(task, p, 'model');
                } else {
                    const branchOrigin = this.parseBranchOrigin(p.branchOrigin, initialStatus);
                    task = this.makeTask(p, undefined, command.origin, initialStatus, branchOrigin);
                }
            } else {
                if (!task)
                    fail('TASK_REQUIRED', 'This command requires a taskId');
                switch (command.type) {
                    case 'enter_plan': {
                        if (terminal.has(task.status)) fail('TERMINAL_TASK', 'A terminal task cannot enter planning');
                        this.fence(task.id, 'Planning requested');
                        for (const child of this.childTasks(task.id)) if (!terminal.has(child.status)) this.pauseTree(child, task.id);
                        task = this.updateTask(task, { executionPhase: 'planning', generation: task.generation + 1,
                            status: this.hasUnknown(task.id) ? 'reconciling' : 'queued', waitingReason: undefined });
                        this.appendEvent(task.id, 'plan.entered', { generation: task.generation });
                        break;
                    }
                    case 'save_plan': {
                        if (terminal.has(task.status)) fail('TERMINAL_TASK', 'A terminal task cannot save a plan');
                        if (task.executionPhase === 'executing' || !task.executionPhase) fail('PLAN_MODE', 'Enter planning before replacing the current plan');
                        const plan = p.plan as Task['plan'];
                        if (!plan || typeof plan.id !== 'string' || !plan.id || !Number.isSafeInteger(plan.revision) || plan.revision < 1
                            || typeof plan.digest !== 'string' || !/^[a-f0-9]{64}$/.test(plan.digest) || plan.goalVersion !== task.goalVersion) fail('PLAN_CONFLICT', 'A saved plan must identify its current goal and immutable content');
                        if (task.plan && plan.revision <= task.plan.revision && digest(task.plan) !== digest(plan)) fail('PLAN_CONFLICT', 'Plan revision must advance');
                        task = this.updateTask(task, { plan, executionPhase: 'awaiting_plan_confirmation',
                            status: task.status === 'paused' ? 'paused' : this.hasUnknown(task.id) ? 'reconciling' : 'waiting_input', waitingReason: 'Confirm the saved plan before execution' });
                        this.appendEvent(task.id, 'plan.saved', { plan });
                        break;
                    }
                    case 'approve_plan': {
                        if (terminal.has(task.status)) fail('TERMINAL_TASK', 'A terminal task cannot approve a plan');
                        if (task.executionPhase !== 'awaiting_plan_confirmation' || !task.plan || task.plan.goalVersion !== task.goalVersion
                            || digest(p.plan) !== digest(task.plan)) fail('PLAN_CONFLICT', 'Approval must match the exact current plan and goal version');
                        if (this.hasUnknown(task.id)) fail('UNRESOLVED_EFFECT', 'Reconcile unknown effects before approving the plan');
                        this.fence(task.id, 'The confirmed plan starts a new execution generation');
                        task = this.updateTask(task, { executionPhase: 'executing', generation: task.generation + 1, status: task.status === 'paused' ? 'paused' : 'queued', waitingReason: undefined });
                        this.appendEvent(task.id, 'plan.approved', { plan: task.plan });
                        break;
                    }
                    case 'revise_goal':
                        task = this.reviseGoal(task, p);
                        break;
                    case 'renew_budget':
                        task = this.renewBudget(task, p);
                        break;
                    case 'send_message': {
                        const content = String(p.content ?? '').trim();
                        if (!content)
                            fail('INVALID_MESSAGE', 'Message content is empty');
                        this.addMessage(task.id, 'user', content, sessionId);
                        if (sessionId === 'main') {
                            if (task.executionPhase === 'awaiting_plan_confirmation') {
                                this.fence(task.id, 'New user input must be incorporated before plan confirmation');
                                task = this.updateTask(task, { executionPhase: 'planning', generation: task.generation + 1,
                                    status: task.status === 'paused' ? 'paused' : this.hasUnknown(task.id) ? 'reconciling' : 'queued', waitingReason: undefined });
                            } else task = task.status === 'running' || task.status === 'waiting_input' || task.status === 'waiting_approval' || terminal.has(task.status)
                                ? this.control(task, this.hasUnknown(task.id) ? 'reconciling' : 'queued', 'task.input_received')
                                : this.updateTask(task, {});
                        }
                        break;
                    }
                    case 'propose_tool': {
                        if (!['queued', 'paused', 'completed', 'failed', 'waiting_input'].includes(task.status)) {
                            fail('TASK_NOT_EDITABLE', 'Pause the task before proposing an operator tool');
                        }
                        if (this.hasUnknown(task.id)) fail('UNRESOLVED_EFFECT', 'Reconcile pending effects before proposing another tool');
                        const name = typeof p.name === 'string' ? p.name.trim() : '';
                        const argumentsValue = p.arguments;
                        if (!name || !argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
                            fail('INVALID_TOOL_PROPOSAL', 'A tool name and arguments object are required');
                        }
                        task = this.control(task, 'queued', 'tool.operator_proposed');
                        const toolCallId = id();
                        this.addMessage(task.id, 'assistant', command.origin === 'side' ? 'Side conversation proposed a workspace tool; see its source user message and control receipt.' : 'Operator requested a workspace tool.', 'main', {
                            toolCalls: [{ id: toolCallId, name, arguments: argumentsValue as Record<string, unknown> }],
                        });
                        this.appendEvent(task.id, 'tool.proposal_owned', { owner: command.origin === 'side' ? 'side' : 'operator', source: command.source, commandId: command.commandId, toolCallId });
                        break;
                    }
                    case 'pause':
                        if (terminal.has(task.status)) fail('TERMINAL_TASK', 'A terminal task cannot be paused');
                        task = this.pauseTree(task);
                        break;
                    case 'resume':
                        if (task.status !== 'paused')
                            fail('INVALID_TRANSITION', 'Only a paused task can resume');
                        task = this.resumeTree(task);
                        break;
                    case 'retry': {
                        if (task.status === 'cancelled') fail('CANCELLED_TASK', 'A cancelled task remains cancelled; create a new task to start over');
                        if (this.planningAncestor(task)) fail('PLAN_CONFIRMATION_REQUIRED', 'Confirm the parent plan before retrying this child');
                        if (task.executionPhase === 'awaiting_plan_confirmation') fail('PLAN_CONFIRMATION_REQUIRED', 'Confirm the current plan before resuming execution');
                        const pausedParentId = (task as PausedTask).pauseState?.parentTaskId;
                        if (pausedParentId && this.requireTask(pausedParentId).status === 'paused') {
                            fail('PARENT_PAUSED', 'Resume the parent before retrying this child');
                        }
                        task = this.control(task, this.hasUnknown(task.id) ? 'reconciling' : 'queued', 'task.retry_requested');
                        break;
                    }
                    case 'cancel':
                        task = this.cancelTree(task);
                        break;
                    case 'cancel_child': {
                        if (terminal.has(task.status)) fail('TERMINAL_TASK', 'A terminal parent cannot control a delegated task');
                        const childId = String(p.childTaskId ?? '');
                        this.row('SELECT id FROM delegations WHERE task_id=? AND child_task_id=?', task.id, childId)
                            ?? fail('WRONG_TASK', 'Only a child delegated by this parent can be cancelled');
                        this.cancelTree(this.requireTask(childId));
                        task = this.updateTask(task, {});
                        this.appendEvent(task.id, 'delegation.cancel_requested', { childTaskId: childId });
                        break;
                    }
                    case 'grant':
                        if (this.requireIntent(String(p.intentId ?? '')).taskId !== task.id)
                            fail('WRONG_TASK', 'Intent belongs to a different task');
                        this.approve(String(p.intentId ?? ''), { scope: p.scope as 'once' | 'session' | undefined, source: 'operator', expectedIntentDigest: typeof p.expectedIntentDigest === 'string' ? p.expectedIntentDigest : undefined, expectedConflictFingerprint: typeof p.expectedConflictFingerprint === 'string' ? p.expectedConflictFingerprint : undefined });
                        task = this.requireTask(task.id);
                        break;
                    case 'deny':
                        if (this.requireIntent(String(p.intentId ?? '')).taskId !== task.id)
                            fail('WRONG_TASK', 'Intent belongs to a different task');
                        this.deny(String(p.intentId ?? ''), String(p.reason ?? 'User denied this tool effect'));
                        task = this.requireTask(task.id);
                        break;
                    case 'revoke':
                        this.revoke(task.id, String(p.intentId ?? ''));
                        task = this.requireTask(task.id);
                        break;
                    case 'set_permission':
                        task = this.setPermission(task.id, {
                            permissionMode: p.permissionMode as PermissionMode | undefined,
                            appMode: p.appMode as AppMode | undefined,
                            ceiling: p.ceiling as string[] | undefined,
                            reason: typeof p.reason === 'string' ? p.reason : undefined,
                        });
                        break;
                    case 'answer': {
                        if (task.status !== 'waiting_input')
                            fail('INVALID_TRANSITION', 'Task is not waiting for input');
                        const content = String(p.content ?? p.answer ?? '').trim();
                        if (!content)
                            fail('INVALID_MESSAGE', 'An answer is required');
                        this.addMessage(task.id, 'user', content);
                        task = this.control(task, this.hasUnknown(task.id) ? 'reconciling' : 'queued', 'task.answered');
                        break;
                    }
                    case 'ask_question': {
                        if (task.status !== 'running') fail('TASK_NOT_RUNNABLE', 'Only an active task can ask a model question');
                        const question = typeof p.question === 'string' ? p.question.trim() : '';
                        const reason = String(p.reason ?? '');
                        if (!question || !['choice', 'risk', 'blocker', 'authorization', 'initial_clarification'].includes(reason)) {
                            fail('INVALID_QUESTION', 'A question and supported reason are required');
                        }
                        if (task.goal.mode === 'autonomous' && reason === 'choice') fail('AUTONOMOUS_CHOICE', 'An autonomous task must resolve routine choices without asking the user');
                        if (reason === 'initial_clarification') {
                            if (this.events(task.id).filter(event => event.type === 'question.asked' && event.payload.reason === reason).length >= 3) {
                                fail('CLARIFICATION_LIMIT', 'Initial clarification is limited to three questions');
                            }
                            if (this.row("SELECT 1 FROM intents WHERE task_id=? AND state IN ('sent','applied','unknown') LIMIT 1", task.id)) {
                                fail('INITIAL_CLARIFICATION_CLOSED', 'Initial clarification closes after a tool effect is dispatched');
                            }
                        }
                        this.appendEvent(task.id, 'question.asked', { id: id(), question, reason });
                        task = this.transition(task.id, 'waiting_input', { waitingReason: question });
                        break;
                    }
                    case 'delegate': {
                        if (terminal.has(task.status))
                            fail('TERMINAL_TASK', 'A terminal task cannot delegate');
                        delegatedChildId = this.delegateTask(task, p, command.origin).id;
                        task = this.requireTask(task.id);
                        break;
                    }
                    case 'accept_result': {
                        const childId = String(p.childTaskId ?? '');
                        const row = this.row('SELECT * FROM delegations WHERE task_id=? AND child_task_id=?', task.id, childId) ?? fail('NOT_FOUND', 'Delegation not found');
                        const child = this.requireTask(childId);
                        if (child.status !== 'completed')
                            fail('RESULT_NOT_READY', 'Child task has not completed');
                        const verification = this.requireChildVerification(child);
                        const delegation: Delegation = {
                            ...parse<Delegation>(row.body), state: 'accepted', result: child.result,
                            settledSnapshot: { revision: child.revision, generation: child.generation, goalVersion: child.goalVersion, policyEpoch: child.policyEpoch },
                            verificationId: verification.id,
                            parentGoalVersion: task.goalVersion,
                        };
                        this.db.prepare('UPDATE delegations SET body=? WHERE id=?').run(JSON.stringify(delegation), String(row.id));
                        this.releasePaths(childId);
                        task = this.updateTask(task, {});
                        this.appendEvent(task.id, 'delegation.accepted', { childTaskId: childId, result: child.result ?? '' });
                        this.progress.evidence(task.id, { childTaskId: childId, verifiedSnapshot: delegation.settledSnapshot });
                        break;
                    }
                    case 'dismiss_child': {
                        const childId = String(p.childTaskId ?? '');
                        const row = this.row('SELECT id,body FROM delegations WHERE task_id=? AND child_task_id=?', task.id, childId)
                            ?? fail('WRONG_TASK', 'Only a child delegated by this parent can be dismissed');
                        const child = this.requireTask(childId);
                        if (!['failed', 'cancelled'].includes(child.status)) fail('RESULT_NOT_DISMISSIBLE', 'Only a failed or cancelled child can be dismissed');
                        if (this.hasUnknown(childId)) fail('UNRESOLVED_EFFECT', 'Unknown child effects must be reconciled before dismissal');
                        const reason = String(p.reason ?? '').trim();
                        if (!reason) fail('DISMISSAL_REASON_REQUIRED', 'Dismissal must state why the failed child is no longer required');
                        const delegation: Delegation = {
                            ...parse<Delegation>(row.body), state: 'dismissed', reason, result: undefined, verificationId: undefined,
                            parentGoalVersion: task.goalVersion,
                            settledSnapshot: { revision: child.revision, generation: child.generation, goalVersion: child.goalVersion, policyEpoch: child.policyEpoch },
                        };
                        this.db.prepare('UPDATE delegations SET body=? WHERE id=?').run(JSON.stringify(delegation), String(row.id));
                        this.releasePaths(childId);
                        task = this.updateTask(task, {});
                        this.appendEvent(task.id, 'delegation.dismissed', { childTaskId: childId, status: child.status, reason });
                        break;
                    }
                    default: fail('UNKNOWN_COMMAND', `Unsupported command: ${command.type}`);
                }
            }
            const ack: CommandAck = { commandId: command.commandId, status: 'accepted', taskId: task!.id, revision: task!.revision, ...(delegatedChildId ? { childTaskId: delegatedChildId } : {}) };
            if (command.origin === 'side' && command.source) this.appendEvent(task!.id, 'command.side_applied', { commandId: command.commandId, commandType: command.type, source: command.source });
            this.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(command.commandId, commandDigest, JSON.stringify(ack), now());
            return ack;
        });
    }
    private validateBudgetLimit(value: number, label: string, used = 0): void {
        if (!Number.isInteger(value) || value < 1 || value > 1_000_000) {
            fail('INVALID_BUDGET', `${label} budget must be a finite integer between 1 and 1000000`);
        }
        if (value < used) fail('BUDGET_BELOW_USAGE', `${label} budget cannot be lower than its cumulative usage ${used}`);
    }
    private revisedLimits(taskId: string, maxModelCalls: number, maxToolCalls: number): Budget {
        const used = this.getBudgets(taskId);
        this.validateBudgetLimit(maxModelCalls, 'Model', used.modelCalls);
        this.validateBudgetLimit(maxToolCalls, 'Tool', used.toolCalls);
        this.db.prepare('UPDATE budgets SET max_model_calls=?,max_tool_calls=? WHERE task_id=?').run(maxModelCalls, maxToolCalls, taskId);
        return { ...used, maxModelCalls, maxToolCalls };
    }
    private reviseGoal(task: Task, parameters: Record<string, unknown>): Task {
        this.assertWorkOriginReady(task.id);
        if (task.status === 'cancelled') fail('CANCELLED_TASK', 'A cancelled task cannot be reopened by revising its goal');
        const supplied = parameters.goal as Partial<GoalContract> | undefined;
        const objective = typeof supplied?.objective === 'string' ? supplied.objective.trim() : '';
        const reason = typeof parameters.reason === 'string' ? parameters.reason.trim() : '';
        if (!objective || !reason) fail('INVALID_GOAL', 'A revised objective and an operator reason are required');
        if (supplied?.mode !== undefined && !['collaborative', 'autonomous'].includes(supplied.mode)) fail('INVALID_GOAL', 'Invalid goal mode');
        for (const field of ['constraints', 'acceptance'] as const) {
            if (supplied?.[field] !== undefined && (!Array.isArray(supplied[field]) || supplied[field].some(value => typeof value !== 'string'))) {
                fail('INVALID_GOAL', `${field} must be an array of strings`);
            }
        }
        const previousBudget = this.getBudgets(task.id);
        const budget = this.revisedLimits(task.id, supplied!.maxModelCalls ?? previousBudget.maxModelCalls, supplied!.maxToolCalls ?? previousBudget.maxToolCalls);
        const parentConstraints = task.parentId ? this.requireTask(task.parentId).goal.constraints : [];
        const goal: GoalContract = {
            ...task.goal, ...supplied, objective,
            constraints: [...new Set([...parentConstraints, ...(supplied!.constraints ?? task.goal.constraints)])],
            acceptance: supplied!.acceptance ?? task.goal.acceptance,
            maxModelCalls: budget.maxModelCalls, maxToolCalls: budget.maxToolCalls,
        };
        for (const child of this.childTasks(task.id).filter(candidate => !terminal.has(candidate.status))) this.cancelTree(child);
        this.fence(task.id, 'Operator revised the goal');
        this.revokeSessionGrants(task.id);
        const status: TaskStatus = task.status === 'paused' ? 'paused' : this.hasUnknown(task.id) ? 'reconciling' : 'queued';
        const next = this.updateTask(task, {
            goal, goalVersion: task.goalVersion + 1, policyEpoch: task.policyEpoch + 1, generation: task.generation + 1,
            ...(task.plan || task.executionPhase === 'planning' || task.executionPhase === 'awaiting_plan_confirmation' ? { executionPhase: 'planning' as const } : {}),
            status, result: undefined, error: undefined, waitingReason: status === 'reconciling' ? 'Reconcile effects from the previous goal before proceeding' : undefined,
        });
        this.db.prepare('INSERT INTO goals VALUES(?,?,?,?,?)').run(id(), task.id, next.goalVersion, JSON.stringify(goal), now());
        this.addMessage(task.id, 'user', supplied!.objective!);
        this.appendEvent(task.id, 'goal.revised', { reason, previousGoalVersion: task.goalVersion, goalVersion: next.goalVersion, previousGoal: task.goal, goal, previousBudget, budget });
        return next;
    }
    private renewBudget(task: Task, parameters: Record<string, unknown>): Task {
        this.assertWorkOriginReady(task.id);
        if (task.status === 'cancelled') fail('CANCELLED_TASK', 'A cancelled task cannot be reopened by renewing its budget');
        const reason = typeof parameters.reason === 'string' ? parameters.reason.trim() : '';
        if (!reason) fail('BUDGET_REASON_REQUIRED', 'An operator reason is required for a new finite budget');
        const previous = this.getBudgets(task.id);
        const budget = this.revisedLimits(task.id, parameters.maxModelCalls as number, parameters.maxToolCalls as number);
        const renewAuthority = (current: Task): Task => {
            this.fence(current.id, 'Operator renewed the finite budget');
            this.revokeSessionGrants(current.id);
            const status: TaskStatus = current.status === 'completed' || current.status === 'paused' ? current.status
                : this.hasUnknown(current.id) ? 'reconciling' : current.status === 'waiting_children' ? 'waiting_children' : 'queued';
            const next = this.updateTask(current, {
                policyEpoch: current.policyEpoch + 1, generation: current.generation + 1, status, error: undefined,
                waitingReason: status === 'paused' || status === 'waiting_children' ? current.waitingReason
                    : status === 'reconciling' ? 'Unknown effects must be reconciled before execution' : undefined,
                ...(current.id === task.id ? { goal: { ...current.goal, maxModelCalls: budget.maxModelCalls, maxToolCalls: budget.maxToolCalls } } : {}),
            });
            this.appendEvent(current.id, 'budget.authority_renewed', { sourceTaskId: task.id, generation: next.generation, policyEpoch: next.policyEpoch });
            for (const child of this.childTasks(current.id).filter(candidate => !terminal.has(candidate.status))) renewAuthority(child);
            return next;
        };
        const next = renewAuthority(task);
        this.appendEvent(task.id, 'budget.renewed', { reason, previous, budget });
        return next;
    }
    private control(task: Task, status: TaskStatus, eventType: string): Task {
        if (executionStatuses.has(status)) this.assertWorkOriginReady(task.id);
        this.fence(task.id, 'Task control superseded an active run');
        const next = this.updateTask(task, { status, generation: task.generation + 1, waitingReason: status === 'reconciling' ? 'Unknown effects must be reconciled before execution' : undefined, error: undefined });
        this.appendEvent(task.id, eventType, { generation: next.generation });
        return next;
    }
    private pauseTree(task: Task, parentTaskId?: string): Task {
        if (task.status === 'paused' || terminal.has(task.status)) return task;
        for (const child of this.childTasks(task.id)) this.pauseTree(child, task.id);
        const paused = this.control(task, 'paused', 'task.paused') as PausedTask;
        paused.pauseState = { parentTaskId, resumeStatus: task.status, waitingReason: task.waitingReason };
        this.saveTask(paused);
        if (parentTaskId) this.appendEvent(task.id, 'task.paused_by_parent', { parentTaskId, resumeStatus: task.status });
        return paused;
    }
    private resumeTree(task: PausedTask): Task {
        if (this.planningAncestor(task)) fail('PLAN_CONFIRMATION_REQUIRED', 'Confirm the parent plan before resuming this child');
        const parentTaskId = task.pauseState?.parentTaskId;
        if (parentTaskId && this.requireTask(parentTaskId).status === 'paused') fail('PARENT_PAUSED', 'Resume the parent before resuming this child');
        const status: TaskStatus = this.hasUnknown(task.id) ? 'reconciling' : task.executionPhase === 'awaiting_plan_confirmation' ? 'waiting_input' : task.pauseState?.resumeStatus === 'waiting_children' ? 'waiting_children' : 'queued';
        const resumed = this.control(task, status, 'task.resumed') as PausedTask;
        if (status === 'waiting_children') resumed.waitingReason = task.pauseState?.waitingReason;
        if (status === 'waiting_input' && task.executionPhase === 'awaiting_plan_confirmation') resumed.waitingReason = 'Confirm the saved plan before execution';
        delete resumed.pauseState;
        this.saveTask(resumed);
        for (const child of this.childTasks(task.id) as PausedTask[]) {
            if ((!resumed.executionPhase || resumed.executionPhase === 'executing') && child.status === 'paused' && child.pauseState?.parentTaskId === task.id) this.resumeTree(child);
        }
        return resumed;
    }
    private cancelTree(task: Task): Task {
        for (const child of this.childTasks(task.id).filter(t => !terminal.has(t.status)))
            this.cancelTree(child);
        const next = this.control(task, 'cancelled', 'task.cancelled');
        this.releasePaths(task.id);
        return next;
    }
    private fence(taskId: string, reason: string): void {
        for (const intent of this.intentsByState(taskId, ['prepared', 'approved', 'sent'])) {
            if (intent.state === 'sent')
                this.markUnknown(intent, reason);
            else if (intent.state === 'prepared' || intent.state === 'approved')
                this.deny(intent.id, reason);
        }
        for (const run of this.runningRuns(taskId))
            this.saveRun({ ...run, status: 'superseded', endedAt: now() });
        this.db.prepare("UPDATE approvals SET state='revoked' WHERE task_id=? AND state='granted'").run(taskId);
    }
    private saveRun(run: Run): Run { this.db.prepare('UPDATE runs SET status=?, body=? WHERE id=?').run(run.status, JSON.stringify(run), run.id); return run; }
    createRun(taskId: string): Run {
        return this.tx(() => {
            const task = this.requireTask(taskId);
            this.assertWorkOriginReady(taskId);
            if (this.planningAncestor(task)) fail('PLAN_CONFIRMATION_REQUIRED', 'Confirm the parent plan before starting this child');
            if (!['queued', 'running'].includes(task.status))
                fail('TASK_NOT_RUNNABLE', `Task ${task.status} is not runnable`);
            if (this.hasUnknown(taskId))
                fail('UNRESOLVED_EFFECT', 'Unknown effects must be reconciled before running');
            if (!this.dependenciesReady(taskId)) fail('DEPENDENCY_BLOCKED', 'All predecessors need a current independently verified completion before this task can run');
            if (this.row("SELECT 1 FROM runs WHERE task_id=? AND status='running' AND generation=? LIMIT 1", taskId, task.generation))
                fail('RUN_ALREADY_ACTIVE', 'This task generation already has an active run');
            const run: Run = { id: id(), taskId, generation: task.generation, policyEpoch: task.policyEpoch, status: 'running', startedAt: now() };
            this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)').run(run.id, taskId, run.generation, run.policyEpoch, run.status, JSON.stringify(run));
            this.appendEvent(taskId, 'run.created', { runId: run.id, generation: run.generation });
            return run;
        });
    }
    finishRun(runId: string, status: 'completed' | 'failed' | 'cancelled'): Run { return this.tx(() => { const row = this.row('SELECT body FROM runs WHERE id=?', runId) ?? fail('NOT_FOUND', 'Run not found'); return this.saveRun({ ...parse<Run>(row.body), status, endedAt: now() }); }); }
    assertFence(taskId: string, runId: string): Run {
        const task = this.requireTask(taskId);
        const row = this.row('SELECT body FROM runs WHERE id=? AND task_id=?', runId, taskId) ?? fail('NOT_FOUND', 'Run not found');
        const run = parse<Run>(row.body);
        if (run.generation !== task.generation || run.policyEpoch !== task.policyEpoch || run.status !== 'running' || terminal.has(task.status) || task.status === 'paused')
            fail('STALE_GENERATION', 'This run no longer owns the task');
        if (!this.dependenciesReady(taskId)) fail('DEPENDENCY_BLOCKED', 'A predecessor no longer has a current verified result; no further effects may dispatch');
        let ancestor = task.parentId ? this.requireTask(task.parentId) : undefined;
        while (ancestor) {
            if (terminal.has(ancestor.status) || ancestor.status === 'paused')
                fail('STALE_GENERATION', 'The parent task no longer permits this run');
            if (ancestor.executionPhase && ancestor.executionPhase !== 'executing') fail('PLAN_CONFIRMATION_REQUIRED', 'The parent plan no longer permits this run');
            ancestor = ancestor.parentId ? this.requireTask(ancestor.parentId) : undefined;
        }
        return run;
    }
    saveDecision(taskId: string, runId: string, record: Record<string, unknown>): Decision {
        return this.tx(() => { this.assertFence(taskId, runId); const decision: Decision = { id: id(), taskId, runId, record, createdAt: now() }; this.db.prepare('INSERT INTO decisions VALUES(?,?,?,?)').run(decision.id, taskId, runId, JSON.stringify(decision)); this.appendEvent(taskId, 'decision.saved', { decisionId: decision.id, runId }); return decision; });
    }
    consumeModelCall(taskId: string, runId?: string): Budget {
        return this.chargeModelCall(taskId, runId, true);
    }
    private chargeModelCall(taskId: string, runId: string | undefined, advanceControlRevision: boolean): Budget {
        return this.tx(() => {
            if (runId) this.assertFence(taskId, runId);
            const charged: { task: Task; budget: Budget }[] = [];
            let task: Task | undefined = this.requireTask(taskId);
            while (task) {
                const budget = this.getBudgets(task.id);
                if (budget.modelCalls >= budget.maxModelCalls) fail('BUDGET_EXHAUSTED', `The saved model-call budget for ${task.title} is exhausted`);
                charged.push({ task, budget });
                task = task.parentId ? this.requireTask(task.parentId) : undefined;
            }
            for (const { task, budget } of charged) {
                this.db.prepare('UPDATE budgets SET model_calls=model_calls+1 WHERE task_id=?').run(task.id);
                // A side request must not invalidate its preceding inspect_task control snapshot.
                // Accounting still commits atomically for every ancestor; main-run revision semantics stay unchanged.
                if (advanceControlRevision) this.updateTask(task, { modelCalls: budget.modelCalls + 1 });
                else this.saveTask({ ...task, modelCalls: budget.modelCalls + 1, updatedAt: now() });
                this.appendEvent(task.id, 'budget.consumed', { sourceTaskId: taskId, modelCalls: budget.modelCalls + 1, maxModelCalls: budget.maxModelCalls });
            }
            return this.getBudgets(taskId);
        });
    }
    consumeSideModelCall(taskId: string, sessionId: string): SideBudget {
        return this.tx(() => {
            this.requireTask(taskId);
            if (!sessionId || sessionId === 'main') fail('INVALID_SIDE_SESSION', 'A side budget requires an auxiliary session');
            this.db.prepare('INSERT OR IGNORE INTO side_budgets(task_id,session_id,max_model_calls) VALUES(?,?,20)').run(taskId, sessionId);
            const budget = this.getSideBudgets(taskId).find(candidate => candidate.sessionId === sessionId)!;
            if (budget.modelCalls >= budget.maxModelCalls) fail('SIDE_BUDGET_EXHAUSTED', 'The saved 20-call budget for this side session is exhausted');
            this.db.prepare('UPDATE side_budgets SET model_calls=model_calls+1 WHERE task_id=? AND session_id=?').run(taskId, sessionId);
            this.appendEvent(taskId, 'side_budget.consumed', { sessionId, modelCalls: budget.modelCalls + 1, maxModelCalls: budget.maxModelCalls });
            return { ...budget, modelCalls: budget.modelCalls + 1 };
        });
    }
    private consumeToolCall(taskId: string): void {
        const charged: { task: Task; budget: Budget }[] = [];
        let task: Task | undefined = this.requireTask(taskId);
        while (task) {
            const budget = this.getBudgets(task.id);
            if (budget.toolCalls >= budget.maxToolCalls) fail('TOOL_BUDGET_EXHAUSTED', `The saved tool-call budget for ${task.title} is exhausted`);
            charged.push({ task, budget });
            task = task.parentId ? this.requireTask(task.parentId) : undefined;
        }
        for (const { task, budget } of charged) {
            this.db.prepare('UPDATE budgets SET tool_calls=tool_calls+1 WHERE task_id=?').run(task.id);
            this.updateTask(task, {});
            this.appendEvent(task.id, 'budget.tool_consumed', { sourceTaskId: taskId, toolCalls: budget.toolCalls + 1, maxToolCalls: budget.maxToolCalls });
        }
    }
    getCapabilityCeiling(taskId: string): string[] {
        const task = this.requireTask(taskId);
        const row = this.row('SELECT ceiling FROM policies WHERE task_id=?', taskId) ?? fail('NOT_FOUND', 'Policy not found');
        const own = parse<string[]>(row.ceiling);
        if (!task.parentId)
            return own;
        const parent = this.getCapabilityCeiling(task.parentId);
        return own.filter(capability => parent.includes(capability));
    }
    /** Operator-only mode/app change: fence the subtree, drop its authority and requeue non-terminal work. */
    setPermission(taskId: string, change: PermissionChange): Task {
        return this.tx(() => {
            const task = this.requireTask(taskId);
            if (change.permissionMode !== undefined && !isPermissionMode(change.permissionMode))
                fail('INVALID_PERMISSION', 'permissionMode must be read-only, ask, auto-review or full-access');
            if (change.appMode !== undefined && !isAppMode(change.appMode))
                fail('INVALID_PERMISSION', "appMode must be 'chat' or 'work'");
            if (change.permissionMode === undefined && change.appMode === undefined && change.ceiling === undefined)
                fail('INVALID_PERMISSION', 'set_permission requires a permissionMode, an appMode or a ceiling');
            if (change.ceiling !== undefined && (!Array.isArray(change.ceiling) || change.ceiling.some(capability => typeof capability !== 'string')))
                fail('INVALID_PERMISSION', 'ceiling must be an array of capability names');
            const root = this.storedPermission(task);
            const nextApp: AppMode = change.appMode ?? root.appMode;
            const requestedMode: PermissionMode = nextApp === 'chat' ? 'read-only' : change.permissionMode ?? root.mode;
            if (task.parentId && modeRank(requestedMode) > modeRank(root.mode))
                fail('PERMISSION_ESCALATION', 'A child task may only narrow its permission mode');
            if (change.ceiling !== undefined) {
                const existing = this.getCapabilityCeiling(taskId);
                if (change.ceiling.some(capability => !existing.includes(capability)))
                    fail('CAPABILITY_ESCALATION', 'A task may only narrow its capability ceiling');
            }
            const reason = typeof change.reason === 'string' && change.reason.trim() ? change.reason.trim() : 'Operator changed the task permission';
            const apply = (id: string, mode: PermissionMode, appMode: AppMode, isRoot: boolean): Task => {
                const current = this.requireTask(id);
                const stored = this.storedPermission(current);
                // Descendants are clamped: widening one task never widens the subtree it delegated.
                const appliedApp: AppMode = appMode === 'chat' || (!isRoot && stored.appMode === 'chat') ? 'chat' : 'work';
                const appliedMode: PermissionMode = appliedApp === 'chat' ? 'read-only' : isRoot ? mode : narrowMode(mode, stored.mode);
                this.fence(id, 'Task permission changed');
                this.revokeSessionGrants(id);
                const status: TaskStatus = terminal.has(current.status) || current.status === 'paused' ? current.status
                    : this.hasUnknown(id) ? 'reconciling' : 'queued';
                const next = this.updateTask(current, {
                    permissionMode: appliedMode, appMode: appliedApp,
                    policyEpoch: current.policyEpoch + 1, generation: current.generation + 1, status, error: undefined,
                    waitingReason: status === 'reconciling' ? 'Unknown effects must be reconciled before execution' : undefined,
                });
                this.appendEvent(id, 'permission.changed', { permissionMode: appliedMode, appMode: appliedApp, previousMode: stored.mode, previousApp: stored.appMode, reason, sourceTaskId: taskId });
                for (const child of this.childTasks(id)) apply(child.id, appliedMode, appliedApp, false);
                return next;
            };
            const next = apply(taskId, requestedMode, nextApp, true);
            if (change.ceiling !== undefined) {
                this.db.prepare('UPDATE policies SET ceiling=? WHERE task_id=?').run(JSON.stringify([...new Set(change.ceiling)]), taskId);
                this.appendEvent(taskId, 'permission.ceiling_changed', { allowed: [...new Set(change.ceiling)], sourceTaskId: taskId });
            }
            return next;
        });
    }
    setCapabilityCeiling(taskId: string, allowed: string[]): void {
        this.tx(() => {
            const existing = this.getCapabilityCeiling(taskId);
            if (allowed.some(capability => !existing.includes(capability)))
                fail('CAPABILITY_ESCALATION', 'A task may only narrow its capability ceiling');
            const narrow = (id: string, ceiling: string[]): void => {
                const task = this.requireTask(id);
                this.fence(id, 'Capability policy changed');
                this.revokeSessionGrants(id);
                this.db.prepare('UPDATE policies SET ceiling=? WHERE task_id=?').run(JSON.stringify([...new Set(ceiling)]), id);
                this.updateTask(task, {
                    policyEpoch: task.policyEpoch + 1,
                    generation: task.generation + 1,
                    status: terminal.has(task.status) || task.status === 'paused' ? task.status : this.hasUnknown(id) ? 'reconciling' : 'queued',
                });
                this.appendEvent(id, 'policy.narrowed', { allowed: ceiling, sourceTaskId: taskId });
                for (const child of this.childTasks(id)) {
                    const own = parse<string[]>(this.row('SELECT ceiling FROM policies WHERE task_id=?', child.id)!.ceiling);
                    narrow(child.id, own.filter(capability => ceiling.includes(capability)));
                }
            };
            narrow(taskId, allowed);
        });
    }
    private within(root: string, candidate: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
    private resolvePaths(task: Task, paths: string[]): string[] { return paths.map(value => { const full = path.resolve(task.workspace, value); if (!this.within(task.workspace, full))
        fail('OUTSIDE_WORKSPACE', 'Tool paths must stay in the task workspace'); return full; }); }
    private isAncestorTask(ancestorId: string, task: Task): boolean {
        let parentId = task.parentId;
        while (parentId) {
            if (parentId === ancestorId) return true;
            parentId = this.requireTask(parentId).parentId;
        }
        return false;
    }
    claimPaths(taskId: string, paths: string[]): string[] {
        return this.tx(() => {
            const task = this.requireTask(taskId);
            const fullPaths = this.resolvePaths(task, paths);
            const locks = this.rows('SELECT * FROM path_locks');
            for (const full of fullPaths) {
                const key = full.toLocaleLowerCase('en-US');
                for (const lock of locks) {
                    if (lock.task_id !== taskId && !this.isAncestorTask(String(lock.task_id), task)
                        && (this.within(String(lock.path), key) || this.within(key, String(lock.path)))) {
                        fail('OWNERSHIP_CONFLICT', `Path is owned by ${String(lock.owner)}`);
                    }
                }
                this.db.prepare('INSERT OR IGNORE INTO path_locks VALUES(?,?,?)').run(key, taskId, task.owner);
            }
            this.appendEvent(taskId, 'paths.claimed', { paths: fullPaths });
            return fullPaths;
        });
    }
    releasePaths(taskId: string): void {
        this.tx(() => {
            this.requireTask(taskId);
            const paths = this.rows('SELECT path FROM path_locks WHERE task_id=?', taskId).map(row => String(row.path));
            this.db.prepare('DELETE FROM path_locks WHERE task_id=?').run(taskId);
            if (paths.length) this.appendEvent(taskId, 'paths.released', { paths });
        });
    }
    private checkOwnership(task: Task, paths: string[], capability: string): void {
        for (const full of this.resolvePaths(task, paths))
            for (const lock of this.rows('SELECT * FROM path_locks'))
                if (capability !== 'workspace.read' && lock.task_id !== task.id && !this.isAncestorTask(String(lock.task_id), task)
                    && (this.within(String(lock.path), full.toLocaleLowerCase('en-US')) || this.within(full.toLocaleLowerCase('en-US'), String(lock.path))))
                    fail('OWNERSHIP_CONFLICT', `Tool path is owned by ${String(lock.owner)}`);
    }
    private recordingFileChange = false;
    protected override afterRollback(error: unknown): void {
        if (!(error instanceof FileVersionChangedError) || this.recordingFileChange || !this.coordination) return;
        this.recordingFileChange = true;
        try { this.coordination.fileVersionChanged(error.observation); }
        catch (failure) { error.notificationError = failure instanceof Error ? failure.message : String(failure); }
        finally { this.recordingFileChange = false; }
    }
    /** Production gateway provenance check; unlike the query getter this can reject stale disk bytes. */
    getWriteReadVersion(taskId: string, absolutePath: string): ReadVersion | undefined {
        return this.tx(() => {
            const task = this.requireTask(taskId), version = this.fileReads.get(task, absolutePath);
            if (version) this.fileReads.assert(task, { path: absolutePath, readVersion: version, expectedSha256: version.sha256 });
            return version;
        });
    }
    /** Retain an existing proposal's trusted absence/read binding before gateway re-preparation. */
    assertWriteReadVersion(intentId: string): void {
        this.tx(() => {
            const intent = this.requireIntent(intentId);
            if (intent.name === 'write_file' && ['prepared', 'approved'].includes(intent.state))
                this.fileReads.assert(this.requireTask(intent.taskId), intent.arguments);
        });
    }
    getReadVersion(taskId: string, absolutePath: string): ReadVersion | undefined {
        return this.fileReads.get(this.requireTask(taskId), absolutePath);
    }
    prepareIntent(taskId: string, runId: string, toolCall: ToolCall, options: PrepareOptions = {}): Intent {
        return this.tx(() => {
            const run = this.assertFence(taskId, runId);
            const task = this.requireTask(taskId);
            // Capability and risk belong to the installed tool, never to the model's proposal; unknown names fail closed.
            const spec = classifyTool(toolCall.name);
            if (!spec)
                fail('PERMISSION_DENIED', `Tool ${toolCall.name} is not in the trusted capability registry`);
            this.assertPlanningTool(task, toolCall.name);
            if (options.capability !== undefined && options.capability !== spec.kernelCapability)
                fail('PERMISSION_DENIED', `Declared capability ${options.capability} is not the registered ${spec.kernelCapability} capability of ${toolCall.name}`);
            if (!this.getCapabilityCeiling(taskId).includes(spec.kernelCapability))
                fail('CAPABILITY_DENIED', `Capability ${spec.kernelCapability} is outside the task ceiling`);
            const paths = options.paths ?? (typeof toolCall.arguments.path === 'string' ? [toolCall.arguments.path] : []);
            this.checkOwnership(task, paths, spec.kernelCapability);
            const resolvedPaths = this.resolvePaths(task, paths);
            for (const resolved of resolvedPaths)
                if (isProtectedPath(task.workspace, resolved))
                    fail('PERMISSION_DENIED', `Protected path ${path.relative(task.workspace, resolved)} cannot be accessed by a tool`);
            if (toolCall.name === 'write_file') toolCall = { ...toolCall, arguments: this.fileReads.bind(task, toolCall.arguments) };
            const resources = [...new Set(options.resources ?? resolvedPaths)];
            const fileConflicts = resolvedPaths.length && ['write', 'exec'].includes(spec.capability) ? this.fileClaims.snapshot(taskId, resolvedPaths) : undefined;
            const intentDigest = digest({ name: toolCall.name, arguments: toolCall.arguments, capability: spec.kernelCapability, paths: resolvedPaths, generation: run.generation, policyEpoch: run.policyEpoch, ...(fileConflicts ? { fileConflicts } : {}) });
            const effectKey = options.effectKey ?? digest({ taskId, runId, toolCallId: toolCall.id });
            const existing = this.row('SELECT body FROM intents WHERE effect_key=?', effectKey);
            if (existing) {
                const intent = parse<Intent>(existing.body);
                if (intent.digest !== intentDigest)
                    fail('EFFECT_KEY_CONFLICT', 'Effect key was reused with different tool content');
                return intent;
            }
            const stored = this.storedPermission(task);
            // Rules layer on the mode table after every workspace, ownership and ceiling check above.
            const base = decideForMode(stored.appMode, stored.mode, spec.capability, spec.risk);
            const rule = this.permissionRuleMatch(spec.capability, permissionRuleTargets({ workspace: task.workspace, capability: spec.capability, resources, paths: resolvedPaths, arguments: toolCall.arguments }));
            const decision = applyPermissionRule(base, rule, spec);
            const appliedRule = permissionRuleApplied(rule, base, decision) ? rule : undefined;
            // A rule that asks must reach the operator: a session grant may only answer the mode table's ask.
            const grant = decision === 'ask' && rule?.decision !== 'ask' ? this.matchingGrant(task, toolCall.name, spec, resources) : undefined;
            const authorization: IntentAuthorization = {
                tool: toolCall.name, mode: stored.mode, appMode: stored.appMode, capability: spec.capability, risk: spec.risk,
                decision: grant ? 'allow' : decision,
                reason: grant ? 'An active session grant covers this exact effect'
                    : appliedRule ? permissionRuleReason(appliedRule, decision) : this.decisionReason(stored.mode, stored.appMode, spec.capability, spec.risk, base),
                workspace: task.workspace, ...(grant ? { grantId: grant.id } : {}),
            };
            if (authorization.decision === 'deny') fail('PERMISSION_DENIED', authorization.reason);
            if (fileConflicts?.conflicts.length) {
                authorization.decision = 'ask'; authorization.requiresOperator = true;
                authorization.reason = this.fileConflictReason(fileConflicts.conflicts.length);
                delete authorization.grantId;
            }
            const intent: Intent = { id: id(), taskId, runId, toolCallId: toolCall.id, name: toolCall.name, arguments: toolCall.arguments, digest: intentDigest, effectKey, state: 'prepared', generation: run.generation, policyEpoch: run.policyEpoch, authorization, resources, ...(fileConflicts ? { fileConflicts } : {}) };
            // The prepared event is the approval's historical origin. Persist its exact timestamp in the
            // same transaction so the operator projection never has to scan history to date an approval.
            const prepared = this.appendEvent(taskId, 'intent.prepared', { intentId: intent.id, digest: intent.digest, effectKey, capability: spec.capability, risk: spec.risk, decision: authorization.decision, mode: stored.mode, appMode: stored.appMode, ...(grant ? { grantId: grant.id } : {}), ...(appliedRule ? { permissionRuleId: appliedRule.id } : {}) });
            this.db.prepare('INSERT INTO intents(id,task_id,run_id,effect_key,state,body,capability,paths,prepared_at) VALUES(?,?,?,?,?,?,?,?,?)')
                .run(intent.id, taskId, runId, effectKey, intent.state, JSON.stringify(intent), spec.kernelCapability, JSON.stringify(resolvedPaths), prepared.createdAt);
            return intent;
        });
    }
    private requireIntent(intentId: string): Intent { return this.getIntent(intentId) ?? fail('NOT_FOUND', 'Tool intent not found'); }
    private saveIntent(intent: Intent): Intent { this.db.prepare('UPDATE intents SET state=?,body=?,write_target=? WHERE id=?').run(intent.state, JSON.stringify(intent), intent.name === 'write_file' ? writePathIdentity(String(intent.arguments.path)) : null, intent.id); return intent; }
    rebindIntent(intentId: string, newRunId: string): Intent {
        return this.tx(() => {
            const intent = this.requireIntent(intentId) as Intent & {
                recoveryRebindable?: boolean;
            };
            const run = this.assertFence(intent.taskId, newRunId);
            if (!['prepared', 'approved'].includes(intent.state) && !(intent.state === 'denied' && intent.recoveryRebindable)) {
                fail('INTENT_NOT_REBINDABLE', 'Only an unsent intent invalidated by process recovery can be rebound');
            }
            const task = this.requireTask(intent.taskId);
            const row = this.row('SELECT capability,paths FROM intents WHERE id=?', intentId)!;
            const capability = String(row.capability);
            const paths = parse<string[]>(row.paths);
            if (!this.getCapabilityCeiling(task.id).includes(capability))
                fail('CAPABILITY_DENIED', 'Recovered effect exceeds current policy');
            this.checkOwnership(task, paths, capability);
            if (intent.fileConflicts) this.fileClaims.assertSnapshot(task.id, intent.fileConflicts);
            this.db.prepare("UPDATE approvals SET state='revoked' WHERE intent_id=? AND state='granted'").run(intentId);
            this.db.prepare('DELETE FROM intent_reviews WHERE intent_id=?').run(intentId);
            this.db.prepare('DELETE FROM outbox WHERE intent_id=?').run(intentId);
            // The rebound artifact has a new digest/generation, so the old verdict must not travel with it.
            const authorization = intent.authorization ? this.withoutReview(intent.authorization) : undefined;
            const next: Intent = {
                ...intent, ...(authorization ? { authorization } : {}),
                runId: newRunId, generation: run.generation, policyEpoch: run.policyEpoch,
                digest: digest({ name: intent.name, arguments: intent.arguments, capability, paths: this.resolvePaths(task, paths), generation: run.generation, policyEpoch: run.policyEpoch, ...(intent.fileConflicts ? { fileConflicts: intent.fileConflicts } : {}) }),
                state: 'prepared', error: undefined,
            };
            delete (next as Intent & {
                recoveryRebindable?: boolean;
            }).recoveryRebindable;
            // prepared_at deliberately survives rebinding: the operator approval keeps the time it first appeared.
            this.db.prepare('UPDATE intents SET run_id=?,state=?,body=? WHERE id=?').run(newRunId, next.state, JSON.stringify(next), intentId);
            this.appendEvent(task.id, 'intent.rebound', { intentId, effectKey: intent.effectKey, previous: intent, current: next });
            return next;
        });
    }
    private permissionRuleMatch(capability: PolicyCapability, targets: string[]): PermissionRule | undefined {
        const rules = this.permissionRules();
        return rules.length ? matchPermissionRule(rules, capability, targets) : undefined;
    }
    /**
     * Re-reads the operator rules for an effect that already exists. It returns a verdict only when
     * a rule actually supplies it; otherwise the snapshot recorded at prepare time keeps deciding.
     */
    private ruleAuthorityForIntent(intent: Intent): { ruleId: string; outcome: PolicyOutcome; reason: string } | undefined {
        if (!intent.authorization) return undefined;
        const rules = this.permissionRules();
        if (!rules.length) return undefined;
        const task = this.requireTask(intent.taskId);
        const stored = this.storedPermission(task);
        const spec = classifyTool(intent.name);
        const { capability, risk } = intent.authorization;
        const row = this.row('SELECT paths FROM intents WHERE id=?', intent.id);
        const paths = row ? parse<string[]>(row.paths) : [];
        const resources = intent.resources ?? paths;
        const targets = permissionRuleTargets({ workspace: task.workspace, capability, resources, paths, arguments: intent.arguments });
        const rule = matchPermissionRule(rules, capability, targets);
        if (!rule) return undefined;
        const base = decideForMode(stored.appMode, stored.mode, capability, risk);
        const outcome = applyPermissionRule(base, rule, { risk, protected: spec?.protected === true });
        if (!permissionRuleApplied(rule, base, outcome)) return undefined;
        return { ruleId: rule.id, outcome, reason: permissionRuleReason(rule, outcome) };
    }
    /**
     * Approving re-reads the current rules: a rule that now denies turns the approval into a policy
     * denial, any other changed verdict is written onto the authorization (digest unchanged) so the
     * recorded reason and the approval it produces describe the same authority.
     */
    private refreshAuthorizationForRules(intent: Intent): Intent {
        const authority = this.ruleAuthorityForIntent(intent);
        if (!intent.authorization) return intent;
        if (authority?.outcome === 'deny') fail('POLICY_DENY', authority.reason);
        const authorization: IntentAuthorization = { ...intent.authorization, ...(authority ? { decision: authority.outcome, reason: authority.reason } : {}) };
        if (authority && authority.outcome !== 'allow') delete authorization.grantId;
        if (intent.fileConflicts?.conflicts.length && authorization.decision !== 'deny') {
            authorization.decision = 'ask'; authorization.requiresOperator = true;
            authorization.reason = this.fileConflictReason(intent.fileConflicts.conflicts.length);
            delete authorization.grantId;
        }
        return this.saveIntent({ ...intent, authorization });
    }
    /** A session grant only covers the exact tool, resources, workspace, epoch and goal it was granted for. */
    private matchingGrant(task: Task, tool: string, spec: ToolSpec, resources: string[]): SessionGrant | undefined {
        if (spec.risk === 'critical' || spec.protected) return undefined;
        const permission = this.storedPermission(task);
        if (permission.mode === 'read-only') return undefined;
        const resourceKey = digest([...resources].sort());
        return this.sessionGrants(task.id).find(grant =>
            grant.taskId === task.id && grant.workspace === task.workspace && grant.tool === tool
            && grant.kernelCapability === spec.kernelCapability && grant.capability === spec.capability && grant.risk === spec.risk
            && digest([...grant.resources].sort()) === resourceKey && grant.policyEpoch === task.policyEpoch
            && grant.goalVersion === task.goalVersion && grant.mode === permission.mode);
    }
    private withoutReview(authorization: IntentAuthorization): IntentAuthorization {
        const next = { ...authorization };
        delete next.review;
        return next;
    }
    private insertGrant(task: Task, intent: Intent, spec: ToolSpec, resources: string[]): SessionGrant {
        const grant: SessionGrant = {
            id: id(), taskId: task.id, workspace: task.workspace, tool: intent.name,
            kernelCapability: spec.kernelCapability, capability: spec.capability, risk: spec.risk,
            resources: [...resources].sort(), policyEpoch: task.policyEpoch, goalVersion: task.goalVersion,
            mode: this.storedPermission(task).mode, createdAt: now(),
        };
        this.db.prepare('INSERT INTO session_grants(id,task_id,workspace,tool,capability,resources_digest,policy_epoch,goal_version,mode,created_at,revoked,resources) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)')
            .run(grant.id, grant.taskId, grant.workspace, grant.tool, grant.capability, digest(grant.resources), grant.policyEpoch, grant.goalVersion, grant.mode, grant.createdAt, JSON.stringify(grant.resources));
        this.appendEvent(task.id, 'permission.granted', { grantId: grant.id, tool: grant.tool, capability: grant.capability, risk: grant.risk, mode: grant.mode, scope: 'session', policyEpoch: grant.policyEpoch, goalVersion: grant.goalVersion, resources: grant.resources });
        return grant;
    }
    private decisionReason(mode: PermissionMode, appMode: AppMode, capability: PolicyCapability, risk: RiskLevel, outcome: PolicyOutcome): string {
        if (appMode === 'chat' && outcome === 'deny') return 'Chat tasks may only read and search the network';
        if (mode === 'read-only' && outcome === 'deny') return 'Read-only tasks may only read';
        if (outcome === 'review') return `${risk} risk ${capability} effects need independent review`;
        if (outcome === 'ask' && risk === 'critical') return 'Critical effects always need explicit confirmation';
        return `${mode} allows ${capability} effects`;
    }
    /** The policy snapshot recorded at prepare time, with live grant and review binding re-verified. Pure read, no events. */
    private fileConflictReason(count: number): string { return `${count} active editing claim(s) overlap this effect. A human must approve this exact conflict set once.`; }
    private assertFileConflictSnapshot(intent: Intent): void {
        if (intent.fileConflicts) { this.fileClaims.assertSnapshot(intent.taskId, intent.fileConflicts); return; }
        // A pre-upgrade proposal has no attested conflict snapshot. It cannot acquire new
        // conflict authority merely because it predates the soft-claim feature.
        const spec = classifyTool(intent.name), row = this.row('SELECT paths FROM intents WHERE id=?', intent.id);
        const paths = row ? parse<string[]>(row.paths) : [];
        if (spec && ['write', 'exec'].includes(spec.capability) && paths.length && this.fileClaims.snapshot(intent.taskId, paths).conflicts.length)
            fail('FILE_CONFLICT_STALE', 'This old proposal has no editing conflict snapshot. Prepare a new proposal.');
    }
    decideIntent(intentId: string): IntentDecision {
        const decision = this.baseIntentDecision(intentId);
        if (decision.outcome === 'deny') return decision;
        const intent = this.requireIntent(intentId);
        this.assertFileConflictSnapshot(intent);
        if (intent.fileConflicts?.conflicts.length)
            return { ...decision, outcome: 'ask', reason: this.fileConflictReason(intent.fileConflicts.conflicts.length), grantId: undefined, requiresOperator: true };
        return decision;
    }
    private baseIntentDecision(intentId: string): IntentDecision {
        const intent = this.requireIntent(intentId);
        const task = this.requireTask(intent.taskId);
        const stored = this.storedPermission(task);
        const spec = classifyTool(intent.name);
        const capability = intent.authorization?.capability ?? spec?.capability ?? 'exec';
        const risk = intent.authorization?.risk ?? spec?.risk ?? 'high';
        // Rules are re-read here so the reported outcome always matches current operator policy.
        const authority = this.ruleAuthorityForIntent(intent);
        if (authority) return { outcome: authority.outcome, mode: stored.mode, appMode: stored.appMode, capability, risk, reason: authority.reason };
        if (intent.authorization?.grantId) {
            const active = spec ? this.matchingGrant(task, intent.name, spec, this.intentResources(intent)) : undefined;
            if (active?.id === intent.authorization.grantId)
                return { outcome: 'allow', mode: stored.mode, appMode: stored.appMode, capability, risk, reason: 'An active session grant covers this effect', grantId: active.id };
            // A revoked or out-of-scope grant never authorizes; the current table decides instead.
            const outcome = decideForMode(stored.appMode, stored.mode, capability, risk);
            return { outcome, mode: stored.mode, appMode: stored.appMode, capability, risk, reason: 'The session grant that covered this effect is no longer active' };
        }
        const outcome = intent.authorization?.decision ?? decideForMode(stored.appMode, stored.mode, capability, risk);
        const reason = intent.authorization?.reason ?? this.decisionReason(stored.mode, stored.appMode, capability, risk, outcome);
        return { outcome, mode: stored.mode, appMode: stored.appMode, capability, risk, reason };
    }
    private intentResources(intent: Intent): string[] {
        if (intent.resources) return intent.resources;
        const row = this.row('SELECT paths FROM intents WHERE id=?', intent.id);
        return row ? parse<string[]>(row.paths) : [];
    }
    /** The reviewer must be independent and the record binds to the exact artifact it judged. */
    recordToolReview(intentId: string, record: ToolReviewRecord): Intent {
        return this.tx(() => {
            const intent = this.requireIntent(intentId);
            const task = this.requireTask(intent.taskId);
            this.assertFence(intent.taskId, intent.runId);
            const authorization = intent.authorization;
            if (intent.state !== 'prepared' || !authorization || authorization.decision !== 'review')
                fail('INVALID_INTENT_STATE', 'Only a prepared effect awaiting independent review can record a review');
            const review = this.validateReview(task, authorization, record);
            this.recordReview(intent, review);
            const reviewed: Intent = { ...intent, authorization: { ...authorization, review } };
            if (review.verdict === 'escalate') {
                this.saveIntent({ ...reviewed, authorization: { ...reviewed.authorization!, decision: 'ask' } });
                // Audit fields outlive the executable authority: the actual review Request and the
                // model that served it stay identifiable after restart/rebind clears the review.
                this.appendEvent(task.id, 'intent.review_escalated', { intentId, verdict: review.verdict, reviewer: review.reviewer, reviewerModelId: review.reviewerModelId, ...(review.requestId ? { requestId: review.requestId } : {}), reason: review.reason, risk: review.risk, checks: review.checks, durationMs: review.durationMs });
                return this.requireIntent(intentId);
            }
            this.saveIntent(reviewed);
            this.appendEvent(task.id, 'intent.reviewed', { intentId, verdict: review.verdict, reviewer: review.reviewer, reviewerModelId: review.reviewerModelId, ...(review.requestId ? { requestId: review.requestId } : {}), risk: review.risk, reason: review.reason, checks: review.checks, durationMs: review.durationMs });
            if (review.verdict === 'block') {
                this.appendEvent(task.id, 'intent.review_blocked', { intentId, reviewer: review.reviewer, reason: review.reason });
                this.deny(intentId, review.reason);
            }
            return this.requireIntent(intentId);
        });
    }
    /**
     * A failure to obtain an independent verdict is never a pass. The effect returns to the human
     * ask path and the escalation reason is recorded on the authorization and in the event log.
     */
    escalateReview(intentId: string, reason: string): Intent {
        return this.tx(() => {
            const intent = this.requireIntent(intentId);
            const task = this.requireTask(intent.taskId);
            this.assertFence(intent.taskId, intent.runId);
            const authorization = intent.authorization;
            if (intent.state !== 'prepared' || !authorization || authorization.decision !== 'review')
                fail('INVALID_INTENT_STATE', 'Only a prepared effect awaiting independent review can escalate');
            const text = typeof reason === 'string' ? reason.trim() : '';
            if (!text || text.length > 1000) fail('INVALID_REVIEW', 'An escalation needs a reason of at most 1000 characters');
            this.db.prepare('DELETE FROM intent_reviews WHERE intent_id=?').run(intentId);
            const escalated: Intent = { ...intent, authorization: { ...this.withoutReview(authorization), decision: 'ask', reason: text } };
            this.saveIntent(escalated);
            this.appendEvent(task.id, 'intent.review_escalated', { intentId, verdict: 'escalate', source: 'bridge', reason: text, risk: authorization.risk });
            return this.requireIntent(intentId);
        });
    }
    /** Persist the verdict against the exact artifact, generation, epoch and risk it judged. */
    private recordReview(intent: Intent, review: ToolReviewRecord): void {
        this.db.prepare('INSERT OR REPLACE INTO intent_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)')
            .run(intent.id, intent.taskId, intent.digest, intent.generation, intent.policyEpoch, review.verdict, review.reviewer, review.risk, review.reason, JSON.stringify(review.checks), now());
    }
    /** A recorded review only authorizes the identical digest, generation, policy epoch and risk. */
    private matchingReview(intent: Intent): boolean {
        const row = this.row('SELECT digest,generation,policy_epoch,verdict,risk FROM intent_reviews WHERE intent_id=?', intent.id);
        if (!row) return false;
        return String(row.verdict) === 'pass' && String(row.digest) === intent.digest
            && Number(row.generation) === intent.generation && Number(row.policy_epoch) === intent.policyEpoch
            && String(row.risk) === (intent.authorization?.risk ?? '');
    }
    private validateReview(task: Task, authorization: IntentAuthorization, record: ToolReviewRecord): ToolReviewRecord {
        if (!record || typeof record !== 'object' || !['pass', 'escalate', 'block'].includes(record.verdict))
            fail('INVALID_REVIEW', 'A review verdict must be pass, escalate or block');
        const reviewer = typeof record.reviewer === 'string' ? record.reviewer.trim() : '';
        if (!reviewer) fail('INVALID_REVIEW', 'A review needs a named reviewer');
        if (reviewer === task.owner) fail('INVALID_REVIEW', 'A task owner cannot review its own effects');
        const reviewerModelId = typeof record.reviewerModelId === 'string' ? record.reviewerModelId.trim() : '';
        if (!reviewerModelId) fail('INVALID_REVIEW', 'A review must name the model that produced it');
        if (record.risk !== authorization.risk) fail('INVALID_REVIEW', 'A review must judge the risk recorded on the effect');
        const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
        if (!reason || reason.length > 1000) fail('INVALID_REVIEW', 'A review needs a reason of at most 1000 characters');
        if (!Array.isArray(record.checks) || record.checks.length > 20) fail('INVALID_REVIEW', 'A review carries at most 20 checks');
        const checks = record.checks.map(check => {
            if (!check || typeof check.label !== 'string' || !check.label.trim() || check.label.length > 200 || typeof check.ok !== 'boolean')
                fail('INVALID_REVIEW', 'Every check needs a label of at most 200 characters and a boolean result');
            return { label: check.label, ok: check.ok };
        });
        if (typeof record.durationMs !== 'number' || !Number.isFinite(record.durationMs) || record.durationMs < 0)
            fail('INVALID_REVIEW', 'durationMs must be a nonnegative finite number');
        return {
            verdict: record.verdict, reviewer, reviewerModelId,
            ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
            risk: record.risk, reason, checks, durationMs: record.durationMs,
        };
    }
    /** Approving is the only place where policy verdicts become executable authority. */
    approve(intentId: string, options: ApproveOptions = {}): Intent {
        return this.tx(() => {
            const intent = this.requireIntent(intentId);
            this.assertFence(intent.taskId, intent.runId);
            if (intent.state === 'denied' && intent.authorization?.review?.verdict === 'block')
                fail('POLICY_DENY', `Reviewer ${intent.authorization.review.reviewer} blocked this effect: ${intent.authorization.review.reason}`);
            if (intent.state !== 'prepared' && intent.state !== 'approved') fail('INVALID_INTENT_STATE', 'Only a prepared intent can be approved');
            const prior = intent.state === 'approved'
                ? this.row("SELECT digest,generation,policy_epoch,source FROM approvals WHERE intent_id=? AND state='granted' ORDER BY rowid DESC LIMIT 1", intentId)
                : undefined;
            const task = this.requireTask(intent.taskId);
            const row = this.row('SELECT capability,paths FROM intents WHERE id=?', intentId)!;
            if (!this.getCapabilityCeiling(task.id).includes(String(row.capability))) fail('CAPABILITY_DENIED', 'The capability ceiling denies this effect');
            this.checkOwnership(task, parse<string[]>(row.paths), String(row.capability));
            if (intent.name === 'write_file') this.fileReads.assert(task, intent.arguments);
            const source = options.source ?? (prior ? String(prior.source) : 'operator');
            const scope = options.scope ?? 'once';
            // Approval is where a verdict becomes executable authority, so the current rules decide it.
            const current = this.refreshAuthorizationForRules(intent);
            this.assertFileConflictSnapshot(current);
            if (current.fileConflicts?.conflicts.length) {
                if (source !== 'operator') fail('CONFLICT_APPROVAL_REQUIRED', 'Editing conflicts require an explicit human decision');
                if (scope !== 'once') fail('CONFLICT_SCOPE_FORBIDDEN', 'Editing conflicts can only be approved once');
                if (options.expectedIntentDigest !== intent.digest || options.expectedConflictFingerprint !== current.fileConflicts.fingerprint)
                    fail('CONFLICT_APPROVAL_REQUIRED', 'Approval must include the displayed intent digest and complete conflict fingerprint');
            }
            const authorization = current.authorization;
            const resources = current.resources ?? parse<string[]>(row.paths);
            const spec = classifyTool(current.name);
            let grant: SessionGrant | undefined;
            if (!authorization) {
                // Intents prepared before the permission layer existed keep their old approval path.
                if (source !== 'operator') fail('OPERATOR_APPROVAL_REQUIRED', 'This effect needs an operator decision');
                if (scope === 'session') fail('SESSION_GRANT_FORBIDDEN', 'Session grants need a permission decision');
            } else {
                if (authorization.decision === 'deny') fail('POLICY_DENY', authorization.reason);
                if (authorization.decision === 'ask' && source !== 'operator')
                    fail('OPERATOR_APPROVAL_REQUIRED', 'This effect needs an operator decision, not a policy grant');
                if (authorization.decision === 'review') {
                    const review = authorization.review;
                    if (review?.verdict === 'block') fail('POLICY_DENY', `Reviewer ${review.reviewer} blocked this effect: ${review.reason}`);
                    if (source !== 'review' || review?.verdict !== 'pass')
                        fail('REVIEW_REQUIRED', 'An independent reviewer must pass this effect before it can be approved');
                    if (!this.matchingReview(intent))
                        fail('REVIEW_REQUIRED', 'The recorded review does not bind this digest, generation, policy epoch and risk');
                }
                if (authorization.decision === 'allow' && authorization.grantId) {
                    const active = spec ? this.matchingGrant(task, current.name, spec, resources) : undefined;
                    if (!active || active.id !== authorization.grantId) fail('APPROVAL_STALE', 'The session grant that allowed this effect was revoked or expired');
                }
                if (scope === 'session') {
                    if (source !== 'operator') fail('OPERATOR_APPROVAL_REQUIRED', 'Only an operator can grant a session scope');
                    if (!spec || authorization.risk === 'critical' || spec.protected || authorization.mode === 'read-only')
                        fail('SESSION_GRANT_FORBIDDEN', 'Critical or protected effects and read-only tasks cannot be granted for a whole session');
                    if (current.state === 'prepared') grant = this.insertGrant(task, current, spec, resources);
                }
            }
            if (intent.state === 'approved') {
                if (!prior || String(prior.digest) !== intent.digest || Number(prior.generation) !== task.generation || Number(prior.policy_epoch) !== task.policyEpoch)
                    fail('APPROVAL_STALE', 'The previous approval no longer authorizes the current artifact and policy');
                return current;
            }
            this.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,?)').run(id(), intent.taskId, intent.id, intent.digest, intent.generation, intent.policyEpoch, 'granted', now(), source);
            this.db.prepare('INSERT INTO outbox VALUES(?,?,?,?)').run(intent.id, intent.taskId, 'pending', now());
            this.saveIntent({ ...current, state: 'approved' });
            const grantId = grant?.id ?? authorization?.grantId;
            this.appendEvent(intent.taskId, 'intent.approved', { intentId, digest: intent.digest, source, scope, mode: authorization?.mode ?? this.storedPermission(task).mode, risk: authorization?.risk ?? spec?.risk ?? 'high', capability: authorization?.capability ?? spec?.capability ?? 'exec', ...(grantId ? { grantId } : {}) });
            return this.requireIntent(intentId);
        });
    }
    deny(intentId: string, reason = 'Effect denied'): Intent {
        return this.tx(() => {
            const intent = this.requireIntent(intentId);
            if (intent.state === 'sent' || intent.state === 'unknown' || intent.state === 'applied' || intent.state === 'failed') fail('EFFECT_ALREADY_DISPATCHED', 'A dispatched effect must be reconciled or keeps its recorded outcome');
            const next = this.saveIntent({ ...intent, state: 'denied', error: reason });
            this.db.prepare("UPDATE approvals SET state='denied' WHERE intent_id=? AND state='granted'").run(intentId);
            this.db.prepare("UPDATE outbox SET state='done' WHERE intent_id=?").run(intentId);
            this.appendEvent(intent.taskId, 'intent.denied', { intentId, reason });
            return next;
        });
    }
    revoke(taskId: string, intentId?: string): void {
        this.tx(() => {
            const task = this.requireTask(taskId);
            if (intentId) {
                const intent = this.requireIntent(intentId);
                if (intent.taskId !== taskId)
                    fail('WRONG_TASK', 'Intent belongs to a different task');
                if (intent.state === 'sent')
                    this.markUnknown(intent, 'Authorization revoked after dispatch');
                else if (intent.state === 'prepared' || intent.state === 'approved')
                    this.deny(intentId, 'Authorization revoked');
            }
            else
                this.fence(taskId, 'Authorization revoked');
            this.db.prepare("UPDATE approvals SET state='revoked' WHERE task_id=? AND state='granted'").run(taskId);
            this.revokeSessionGrants(taskId);
            this.updateTask(task, { policyEpoch: task.policyEpoch + 1, generation: task.generation + 1, status: terminal.has(task.status) || task.status === 'paused' ? task.status : this.hasUnknown(taskId) ? 'reconciling' : 'queued' });
            this.appendEvent(taskId, 'authorization.revoked', { intentId: intentId ?? null });
            const revokeChild = (childId: string): void => {
                const child = this.requireTask(childId);
                this.fence(childId, 'Parent authorization revoked');
                this.revokeSessionGrants(childId);
                this.updateTask(child, { policyEpoch: child.policyEpoch + 1, generation: child.generation + 1, status: terminal.has(child.status) || child.status === 'paused' ? child.status : this.hasUnknown(childId) ? 'reconciling' : 'queued' });
                this.appendEvent(childId, 'authorization.revoked', { sourceTaskId: taskId });
                for (const descendant of this.childTasks(childId)) revokeChild(descendant.id);
            };
            for (const child of this.childTasks(taskId)) revokeChild(child.id);
        });
    }
    dispatch(intentId: string): Intent {
        return this.tx(() => {
            const intent = this.requireIntent(intentId);
            this.assertPlanningTool(this.requireTask(intent.taskId), intent.name);
            // Rules are re-read here too: an old approval never authorizes an effect the current
            // operator rules deny, and a rule that now asks cannot ride an earlier allow or grant.
            const currentAuthority = this.ruleAuthorityForIntent(intent);
            if (currentAuthority?.outcome === 'deny') fail('POLICY_DENY', currentAuthority.reason);
            if (currentAuthority?.outcome === 'ask' && intent.authorization && (intent.authorization.decision !== 'ask' || intent.authorization.grantId))
                fail('APPROVAL_STALE', 'The permission rules now require a fresh operator decision for this effect');
            this.assertFence(intent.taskId, intent.runId);
            if (intent.state !== 'approved') fail('INVALID_INTENT_STATE', 'Only an approved intent can dispatch, exactly once');
            const task = this.requireTask(intent.taskId);
            const row = this.row('SELECT capability,paths FROM intents WHERE id=?', intentId)!;
            if (!this.getCapabilityCeiling(task.id).includes(String(row.capability))) fail('CAPABILITY_DENIED', 'Capability was revoked');
            this.checkOwnership(task, parse(row.paths), String(row.capability));
            const approval = this.row("SELECT * FROM approvals WHERE intent_id=? AND state='granted' ORDER BY rowid DESC LIMIT 1", intentId);
            if (!approval || approval.digest !== intent.digest || Number(approval.generation) !== task.generation || Number(approval.policy_epoch) !== task.policyEpoch) fail('APPROVAL_STALE', 'Approval does not match the current artifact and policy');
            const authorization = intent.authorization;
            if (authorization) {
                if (authorization.decision === 'deny') fail('POLICY_DENY', authorization.reason);
                if (authorization.decision === 'ask' && String(approval.source) !== 'operator')
                    fail('OPERATOR_APPROVAL_REQUIRED', 'This effect needs an operator decision');
                if (authorization.decision === 'review' && (String(approval.source) !== 'review' || authorization.review?.verdict !== 'pass' || !this.matchingReview(intent)))
                    fail('REVIEW_REQUIRED', 'The approving review no longer matches this effect');
                if (authorization.decision === 'allow' && authorization.grantId) {
                    const spec = classifyTool(intent.name);
                    const resources = intent.resources ?? parse<string[]>(row.paths);
                    const active = spec ? this.matchingGrant(task, intent.name, spec, resources) : undefined;
                    if (!active || active.id !== authorization.grantId) fail('APPROVAL_STALE', 'The session grant that allowed this effect was revoked or expired');
                }
                if (authorization.risk === 'critical' && String(approval.source) !== 'operator')
                    fail('OPERATOR_APPROVAL_REQUIRED', 'Critical effects always need an explicit operator approval');
            }
            if (intent.name === 'read_file' || intent.name === 'write_file') this.fileReads.assertAvailable(task, intent);
            if (intent.name === 'write_file') this.fileReads.assert(task, intent.arguments);
            this.assertFileConflictSnapshot(intent);
            if (intent.fileConflicts?.conflicts.length && String(approval.source) !== 'operator') fail('CONFLICT_APPROVAL_REQUIRED', 'Editing conflicts require an explicit human decision');
            this.consumeToolCall(intent.taskId);
            this.saveIntent({ ...intent, state: 'sent' });
            this.db.prepare("UPDATE outbox SET state='sent' WHERE intent_id=?").run(intentId);
            this.db.prepare('INSERT INTO effects VALUES(?,?,?,?,?,?)').run(intent.effectKey, intent.id, intent.taskId, 'unknown', null, now());
            const attempt = { id: id(), intentId, taskId: intent.taskId, runId: intent.runId, generation: intent.generation, startedAt: now() };
            this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?)').run(attempt.id, intent.taskId, intent.id, 'sent', JSON.stringify(attempt));
            this.appendEvent(intent.taskId, 'intent.sent', { intentId, effectKey: intent.effectKey, attemptId: attempt.id });
            return this.requireIntent(intentId);
        });
    }
    receipt(intentId: string, receipt: Record<string, unknown>): Intent {
        return this.tx(() => {
            const intent = this.requireIntent(intentId);
            if (intent.state === 'applied') {
                if (digest(intent.receipt) !== digest(receipt)) fail('RECEIPT_CONFLICT', 'Applied effect already has a different receipt');
                return intent;
            }
            if (intent.state !== 'sent' && intent.state !== 'unknown') fail('INVALID_INTENT_STATE', 'Only a sent or unknown effect can receive a receipt');
            if (intent.name === 'read_file') this.fileReads.record(this.requireTask(intent.taskId), intent, receipt);
            if (intent.name === 'read_file') this.fileClaims.afterRead(intent.taskId, String(intent.arguments.path));
            if (intent.name === 'write_file') this.fileClaims.afterWrite(intent.taskId, String(intent.arguments.path));
            const next = this.saveIntent({ ...intent, state: 'applied', receipt, error: undefined });
            this.db.prepare("UPDATE effects SET state='applied',receipt=? WHERE effect_key=?").run(JSON.stringify(receipt), intent.effectKey);
            this.db.prepare("UPDATE outbox SET state='done' WHERE intent_id=?").run(intentId);
            this.db.prepare("UPDATE attempts SET state='applied' WHERE intent_id=? AND state='sent'").run(intentId);
            this.fileReads.settle(intentId);
            // Exclude request IDs/timestamps: repeating an identical observed result is not progress.
            this.progress.evidence(intent.taskId, { tool: intent.name, path: receipt.path, sha256: receipt.sha256, output: receipt.output, exitCode: receipt.exitCode });
            this.appendEvent(intent.taskId, 'effect.receipted', { intentId, effectKey: intent.effectKey, receipt });
            return next;
        });
    }
    private markUnknown(intent: Intent, error: string): Intent {
        const next = this.saveIntent({ ...intent, state: 'unknown', error });
        this.db.prepare("UPDATE outbox SET state='unknown' WHERE intent_id=?").run(intent.id);
        this.db.prepare("UPDATE attempts SET state='unknown' WHERE intent_id=? AND state='sent'").run(intent.id);
        this.appendEvent(intent.taskId, 'effect.unknown', { intentId: intent.id, effectKey: intent.effectKey, error });
        return next;
    }
    unknown(intentId: string, error = 'Dispatch outcome is unknown'): Intent {
        return this.tx(() => {
            const intent = this.requireIntent(intentId);
            if (intent.state !== 'sent' && intent.state !== 'unknown') fail('INVALID_INTENT_STATE', 'Only a dispatched effect can become unknown');
            const next = this.markUnknown(intent, error);
            const task = this.requireTask(intent.taskId);
            if (!terminal.has(task.status)) this.updateTask(task, { status: 'reconciling', waitingReason: error });
            return next;
        });
    }
    private hasUnknown(taskId: string): boolean { return Boolean(this.row("SELECT 1 FROM intents WHERE task_id=? AND state IN ('unknown','sent') LIMIT 1", taskId)); }
    reconcile(intentId: string, receipt?: Record<string, unknown>): Intent {
        return this.tx(() => {
            const intent = this.requireIntent(intentId);
            if (intent.state !== 'unknown') fail('INVALID_INTENT_STATE', 'Only unknown effects need reconciliation');
            if (!receipt) {
                this.appendEvent(intent.taskId, 'effect.reconciliation_required', { intentId, effectKey: intent.effectKey });
                return intent;
            }
            const next = this.receipt(intentId, { ...receipt, reconciled: true });
            const task = this.requireTask(intent.taskId);
            if (!this.hasUnknown(task.id) && task.status === 'reconciling') this.updateTask(task, { status: 'queued', waitingReason: undefined });
            this.appendEvent(task.id, 'effect.reconciled', { intentId, effectKey: intent.effectKey });
            return next;
        });
    }
    /**
     * A terminal failure is only credible for a read-only network/MCP adapter whose executor
     * itself persisted a failure. Unknown outcomes, generic MCP calls, writes and other tools keep the
     * reconciliation path and cannot be converted here.
     */
    private determinateFailure(intent: Intent, failure: IntentFailure): IntentFailure {
        if (!failure || typeof failure !== 'object' || Array.isArray(failure))
            fail('INVALID_FAILURE', 'A terminal failure needs a structured error object');
        const record = failure as unknown as Record<string, unknown>;
        const code = typeof record.code === 'string' ? record.code.trim() : '';
        if (!code || code.length > 120) fail('INVALID_FAILURE', 'A failure code of at most 120 characters is required');
        if (typeof record.tool !== 'string' || record.tool !== intent.name)
            fail('INVALID_FAILURE', 'The failure must name the tool of this effect');
        const readMcp = intent.name === 'mcp_read' && record.source === 'mcp';
        if (record.source !== 'network' && !readMcp) fail('INVALID_FAILURE', 'Only a persisted read-only adapter failure can terminate an effect');
        if (record.message !== undefined && (typeof record.message !== 'string' || !record.message.trim() || record.message.length > 2000))
            fail('INVALID_FAILURE', 'A failure message must be a nonempty string of at most 2000 characters');
        let attempts: unknown[] | undefined;
        if (record.attempts !== undefined) {
            if (!Array.isArray(record.attempts) || record.attempts.length > 20) fail('INVALID_FAILURE', 'A failure carries at most 20 attempts');
            attempts = record.attempts.map(attempt => {
                if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) fail('INVALID_FAILURE', 'Every attempt must be an object');
                return attempt;
            });
        }
        const spec = classifyTool(intent.name);
        const capability = readMcp ? 'mcp.call' : 'network.read';
        if (!spec || spec.kernelCapability !== capability || readMcp && spec.risk !== 'low')
            fail('NOT_DETERMINATE_FAILURE', `${intent.name} is not a read-only external tool; its outcome needs reconciliation`);
        const row = this.row('SELECT capability FROM intents WHERE id=?', intent.id);
        if (!row || String(row.capability) !== capability)
            fail('NOT_DETERMINATE_FAILURE', 'This effect was dispatched with a capability that needs reconciliation');
        const message = typeof record.message === 'string' ? record.message.trim() : undefined;
        return {
            code,
            ...(message ? { message } : {}),
            tool: intent.name,
            source: readMcp ? 'mcp' : 'network',
            ...(attempts ? { attempts } : {}),
            ...(typeof record.at === 'string' && record.at ? { at: record.at } : {}),
        };
    }
    /** Records the terminal failure on every effect ledger row; it never writes a receipt. */
    private recordTerminalFailure(intent: Intent, failure: IntentFailure, origin: 'dispatch' | 'reconciliation'): Intent {
        const effects = this.row('SELECT state,receipt FROM effects WHERE effect_key=?', intent.effectKey);
        if (!effects || String(effects.state) !== 'unknown' || effects.receipt !== null)
            fail('INVALID_EFFECT_STATE', 'Only an unresolved dispatched effect can fail terminally');
        const error = failure.message ? `${failure.code}: ${failure.message}` : failure.code;
        const next = this.saveIntent({ ...intent, state: 'failed', failure, failedAt: now(), error });
        this.db.prepare("UPDATE effects SET state='failed' WHERE effect_key=?").run(intent.effectKey);
        this.db.prepare("UPDATE outbox SET state='failed' WHERE intent_id=?").run(intent.id);
        this.db.prepare("UPDATE attempts SET state='failed' WHERE intent_id=? AND state IN ('sent','unknown')").run(intent.id);
        this.appendEvent(intent.taskId, 'effect.failed', {
            intentId: intent.id, effectKey: intent.effectKey, code: failure.code, tool: failure.tool, source: failure.source,
            ...(failure.message ? { message: failure.message } : {}),
            ...(failure.attempts ? { attempts: failure.attempts } : {}),
            origin,
        });
        return next;
    }
    /**
     * The only way a dispatched effect becomes terminally failed instead of unknown. The run fence and
     * the task generation still have to hold at the moment of the transition.
     */
    failIntent(intentId: string, failure: IntentFailure): Intent {
        return this.tx(() => {
            const intent = this.requireIntent(intentId);
            const normalized = this.determinateFailure(intent, failure);
            if (intent.state === 'failed') {
                if (digest(intent.failure) === digest(normalized)) return intent;
                fail('FAILURE_CONFLICT', 'A different failure was already recorded for this effect');
            }
            if (intent.state !== 'sent') fail('INVALID_INTENT_STATE', 'Only a dispatched effect can fail terminally');
            const task = this.requireTask(intent.taskId);
            this.assertFence(task.id, intent.runId);
            if (intent.generation !== task.generation || intent.policyEpoch !== task.policyEpoch)
                fail('STALE_GENERATION', 'The effect no longer matches the current task generation and policy');
            return this.recordTerminalFailure(intent, normalized, 'dispatch');
        });
    }
    /**
     * Settles an already unknown effect when the executor persisted a determinate failure before the
     * process stopped. The recovery path has no live run, so the fence cannot apply; the effect record
     * and the capability are the boundary instead.
     */
    reconcileFailure(intentId: string, failure: IntentFailure): Intent {
        return this.tx(() => {
            const intent = this.requireIntent(intentId);
            const normalized = this.determinateFailure(intent, failure);
            if (intent.state === 'failed') {
                if (digest(intent.failure) === digest(normalized)) return intent;
                fail('FAILURE_CONFLICT', 'A different failure was already recorded for this effect');
            }
            if (intent.state !== 'unknown') fail('INVALID_INTENT_STATE', 'Only an unknown effect can be reconciled to a determinate failure');
            this.recordTerminalFailure(intent, normalized, 'reconciliation');
            const task = this.requireTask(intent.taskId);
            if (!this.hasUnknown(task.id) && task.status === 'reconciling') {
                // The run that dispatched the effect stopped on the unknown outcome; reconciliation ends it
                // so the task can start a fresh run instead of rejecting createRun from its stale predecessor.
                for (const run of this.runningRuns(task.id))
                    this.saveRun({ ...run, status: 'interrupted', endedAt: now() });
                this.updateTask(task, { status: 'queued', waitingReason: undefined });
            }
            return this.requireIntent(intentId);
        });
    }
    verify(taskId: string, runId: string, record: Record<string, unknown>): Verification {
        return this.tx(() => {
            const task = this.requireTask(taskId);
            this.assertFence(taskId, runId);
            if (typeof record.passed !== 'boolean' || typeof record.reviewer !== 'string' || !record.reviewer || record.reviewer === task.owner) {
                fail('INDEPENDENT_REVIEW_REQUIRED', 'Verification must identify an independent reviewer and pass/fail outcome');
            }
            const snapshot = { revision: task.revision, goalVersion: task.goalVersion, generation: task.generation, policyEpoch: task.policyEpoch };
            const expected = { expectedRevision: snapshot.revision, goalVersion: snapshot.goalVersion, generation: snapshot.generation, policyEpoch: snapshot.policyEpoch };
            for (const [key, value] of Object.entries(expected)) {
                if (record[key] !== undefined && record[key] !== value)
                    fail('STALE_VERIFICATION', `Verifier snapshot ${key} is stale`);
            }
            const verification: Verification = { id: id(), taskId, runId, record, snapshot, createdAt: now() };
            this.db.prepare('INSERT INTO verifications VALUES(?,?,?,?)').run(verification.id, taskId, runId, JSON.stringify(verification));
            if (record.passed) {
                verification.record = { ...record, fileVersions: captureFileVerification(this.db, task, verification.id) };
                this.db.prepare('UPDATE verifications SET body=? WHERE id=?').run(JSON.stringify(verification), verification.id);
            }
            this.appendEvent(taskId, 'verification.saved', { verificationId: verification.id, runId, passed: record.passed, reviewer: record.reviewer, snapshot });
            return verification;
        });
    }
    private requireCompletionVerification(task: Task): void {
        const verification = this.latestVerification(task.id);
        if (!verification || verification.record.passed !== true)
            fail('UNVERIFIED_RESULT', 'Completion requires an independent passing verification');
        this.assertFence(task.id, verification.runId);
        const snapshot = verification.snapshot;
        if (!snapshot || snapshot.revision !== task.revision || snapshot.goalVersion !== task.goalVersion || snapshot.generation !== task.generation || snapshot.policyEpoch !== task.policyEpoch) {
            fail('STALE_VERIFICATION', 'Task changed after its independent acceptance check');
        }
        assertFileVerification(this.db, task, verification.id);
        for (const delegation of this.delegationIterator(task.id)) {
            const child = this.requireTask(delegation.childTaskId);
            const snapshot = delegation.settledSnapshot;
            const validStatus = delegation.state === 'accepted' ? child.status === 'completed' : delegation.state === 'dismissed' && ['failed', 'cancelled'].includes(child.status);
            if ((delegation.parentGoalVersion ?? 1) !== task.goalVersion || !validStatus || !snapshot || snapshot.revision !== child.revision || snapshot.generation !== child.generation
                || snapshot.goalVersion !== child.goalVersion || snapshot.policyEpoch !== child.policyEpoch || this.hasUnknown(child.id)) {
                fail('UNACCEPTED_DELEGATION', 'Current delegated results must be accepted before parent completion');
            }
            if (delegation.state === 'accepted') this.requireChildVerification(child);
        }
    }
    private *delegationIterator(taskId: string): Generator<Delegation> {
        let after = 0;
        for (;;) {
            const rows = this.rows('SELECT rowid AS cursor,body FROM delegations WHERE task_id=? AND rowid>? ORDER BY rowid LIMIT 100', taskId, after);
            for (const row of rows) yield parse<Delegation>(row.body);
            if (rows.length < 100) return;
            after = Number(rows.at(-1)!.cursor);
        }
    }
    private *recoveryTasks(): Generator<Task> {
        let after = 0;
        for (;;) {
            const rows = this.rows("SELECT rowid AS cursor,body FROM tasks t WHERE rowid>? AND (status IN ('running','waiting_approval','waiting_children') OR EXISTS(SELECT 1 FROM intents i WHERE i.task_id=t.id AND i.state IN ('sent','unknown'))) ORDER BY rowid LIMIT 100", after);
            for (const row of rows) yield parse<Task>(row.body);
            if (rows.length < 100) return;
            after = Number(rows.at(-1)!.cursor);
        }
    }
    private requireChildVerification(child: Task): Verification {
        const verification = this.latestVerification(child.id);
        if (!verification || verification.record.passed !== true || verification.record.reviewer === child.owner) {
            fail('UNVERIFIED_RESULT', 'A current independent passing verification is required');
        }
        const snapshot = verification.snapshot;
        const runRow = this.row('SELECT body FROM runs WHERE id=? AND task_id=?', verification.runId, child.id);
        const run = runRow ? parse<Run>(runRow.body) : undefined;
        if (snapshot.revision + 1 !== child.revision || snapshot.generation !== child.generation
            || snapshot.goalVersion !== child.goalVersion || snapshot.policyEpoch !== child.policyEpoch
            || !run || run.generation !== child.generation || run.policyEpoch !== child.policyEpoch
            || !['running', 'completed'].includes(run.status)) {
            fail('STALE_VERIFICATION', 'Child result changed after its independent completion check');
        }
        assertFileVerification(this.db, child, verification.id);
        return verification;
    }
    checkpoint(taskId: string, runId: string, context: Record<string, unknown>): Checkpoint {
        return this.tx(() => {
            this.assertFence(taskId, runId);
            const eventSeq = Number(this.row('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE task_id=?', taskId)!.seq);
            const messageCount = Number(this.row('SELECT COUNT(*) AS n FROM messages WHERE task_id=?', taskId)!.n);
            const checkpoint: Checkpoint = { id: id(), taskId, runId, context, digest: digest(context), eventSeq, messageCount, createdAt: now() };
            this.db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?)').run(checkpoint.id, taskId, runId, JSON.stringify(checkpoint));
            this.appendEvent(taskId, 'checkpoint.saved', { checkpointId: checkpoint.id, digest: checkpoint.digest, eventSeq, messageCount });
            return checkpoint;
        });
    }
    recover(): RecoverySummary {
        return this.tx(() => {
            const summary: RecoverySummary = { requeued: [], unknownIntents: [], reconciling: [], waitingChildren: [] };
            for (const task of this.recoveryTasks()) {
                for (const intent of this.intentsByState(task.id, ['sent'])) {
                    this.markUnknown(intent, 'Process stopped after dispatch; effect must be reconciled');
                    summary.unknownIntents.push(intent.id);
                }
                if (task.status === 'running' || task.status === 'waiting_approval' || task.status === 'waiting_children' || this.hasUnknown(task.id)) {
                    for (const run of this.runningRuns(task.id))
                        this.saveRun({ ...run, status: 'interrupted', endedAt: now() });
                    for (const intent of this.intentsByState(task.id, ['prepared', 'approved'])) {
                        const invalidated = this.deny(intent.id, 'Previous process approval was invalidated during recovery');
                        this.saveIntent({ ...invalidated, recoveryRebindable: true } as Intent);
                    }
                    this.db.prepare("UPDATE approvals SET state='revoked' WHERE task_id=? AND state='granted'").run(task.id);
                    if (terminal.has(task.status) || task.status === 'paused') {
                        this.appendEvent(task.id, 'recovery.effects_pending', { unknown: this.hasUnknown(task.id) });
                        continue;
                    }
                    const status: TaskStatus = this.hasUnknown(task.id) ? 'reconciling' : task.status === 'waiting_children' ? 'waiting_children' : 'queued';
                    this.updateTask(task, { status, generation: task.generation + 1, waitingReason: status === 'reconciling' ? 'Recovered an unknown effect; reconcile before retry' : status === 'waiting_children' ? task.waitingReason : undefined });
                    summary[status === 'reconciling' ? 'reconciling' : status === 'waiting_children' ? 'waitingChildren' : 'requeued'].push(task.id);
                    this.appendEvent(task.id, 'task.recovered', { status, generation: task.generation + 1 });
                }
            }
            return summary;
        });
    }
}
