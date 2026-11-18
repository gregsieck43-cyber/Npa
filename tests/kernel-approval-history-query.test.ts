import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Kernel, KernelError } from '../src/kernel/index.js';
import type { PendingApproval } from '../src/kernel/index.js';
import type { Intent, Task, ToolCall } from '../src/contracts.js';

/**
 * Product approval history: the prepared timestamp is durable intent state, not a scan of the
 * newest events. These tests keep an old actionable approval visible behind deep history, prove
 * the projection is bounded and index-driven, and migrate databases created before the column.
 */

const GLOBAL_PENDING_SQL = `SELECT i.body AS intent_body, i.prepared_at AS prepared_at, t.body AS task_body
    FROM intents i JOIN tasks t ON t.id=i.task_id
    WHERE i.state='prepared' AND json_extract(i.body,'$.authorization.decision')='ask'
    ORDER BY i.prepared_at DESC, i.rowid DESC LIMIT 200`;
const TASK_PENDING_SQL = `SELECT i.body AS intent_body, i.prepared_at AS prepared_at, t.body AS task_body
    FROM intents i JOIN tasks t ON t.id=i.task_id
    WHERE i.state='prepared' AND json_extract(i.body,'$.authorization.decision')='ask' AND i.task_id=?
    ORDER BY i.prepared_at DESC, i.rowid DESC LIMIT 200`;

class Fixture {
    kernel: Kernel;
    private closed = false;
    constructor(readonly directory: string) { this.kernel = new Kernel(directory); }
    close(): void { if (this.closed) return; this.kernel.close(); this.closed = true; }
    reopen(): Kernel { this.close(); this.kernel = new Kernel(this.directory); this.closed = false; return this.kernel; }
}

function fixture(t: TestContext): Fixture {
    assert.ok(process.env.TEMP, 'TEMP must point at the project-local temp directory');
    const root = path.resolve(process.env.TEMP);
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(path.join(root, 'kernel-approval-query-'));
    assert.ok(directory.startsWith(root + path.sep), 'fixture data stays inside TEMP');
    const created = new Fixture(directory);
    t.after(() => {
        try { created.close(); }
        finally {
            assert.ok(path.resolve(directory).startsWith(root + path.sep), 'fixture data stays inside TEMP');
            rmSync(directory, { recursive: true, force: true });
        }
    });
    return created;
}

function create(kernel: Kernel, parameters: Record<string, unknown> = {}): Task {
    const ack = kernel.command({ commandId: crypto.randomUUID(), type: 'create_task', parameters: { title: 'Approval query fixture', permissionMode: 'ask', appMode: 'work', ...parameters } });
    return kernel.getTask(ack.taskId!)!;
}

function running(kernel: Kernel, parameters: Record<string, unknown> = {}): { task: Task; runId: string } {
    const task = create(kernel, parameters);
    const run = kernel.createRun(task.id);
    kernel.transition(task.id, 'running');
    return { task, runId: run.id };
}

function prepare(kernel: Kernel, taskId: string, runId: string, suffix: string): Intent {
    const toolCall: ToolCall = { id: crypto.randomUUID(), name: 'write_file', arguments: { path: `${suffix}.txt`, content: 'not executed' } };
    return kernel.prepareIntent(taskId, runId, toolCall);
}

function preparedEventAt(kernel: Kernel, taskId: string, intentId: string): string {
    const event = kernel.events(taskId).find(item => item.type === 'intent.prepared' && String(item.payload.intentId) === intentId);
    assert.ok(event, 'the intent.prepared event exists');
    return event.createdAt;
}

function preparedUnder(kernel: Kernel, mode: 'ask' | 'auto-review' | 'full-access', suffix: string): { task: Task; intent: Intent } {
    const { task, runId } = running(kernel, { title: `Approval ${mode}`, permissionMode: mode });
    return { task, intent: prepare(kernel, task.id, runId, suffix) };
}

/** Independent expectation from the raw rows: prepared_at DESC, rowid DESC. */
function expectedActionableOrder(directory: string, taskId?: string): { id: string; rowid: number; preparedAt: string }[] {
    const db = new DatabaseSync(path.join(directory, 'kernel.sqlite'));
    try {
        const rows = taskId === undefined
            ? db.prepare("SELECT rowid,id,prepared_at FROM intents WHERE state='prepared' AND json_extract(body,'$.authorization.decision')='ask'").all()
            : db.prepare("SELECT rowid,id,prepared_at FROM intents WHERE state='prepared' AND json_extract(body,'$.authorization.decision')='ask' AND task_id=?").all(taskId);
        return rows.map(row => ({ rowid: Number(row.rowid), id: String(row.id), preparedAt: String(row.prepared_at) }))
            .sort((left, right) => left.preparedAt === right.preparedAt ? right.rowid - left.rowid : (left.preparedAt < right.preparedAt ? 1 : -1));
    } finally { db.close(); }
}

function planDetails(db: DatabaseSync, sql: string, ...args: (string | number)[]): string[] {
    return db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(row => String(row.detail));
}

function scansTasks(plan: string[]): boolean {
    return plan.some(line => /^SCAN (?:t|tasks?)(?:\s|$)/.test(line));
}

const isInvalidLimit = (error: unknown) => error instanceof KernelError && error.code === 'INVALID_PAGE_LIMIT';

test('deep intent history preserves the exact prepared event time across reopen', async t => {
    const f = fixture(t);
    const { task, runId } = running(f.kernel);
    for (let index = 0; index < 1005; index++) f.kernel.appendEvent(task.id, 'history.noise', { index });
    const intent = prepare(f.kernel, task.id, runId, 'deep-history');
    const eventAt = preparedEventAt(f.kernel, task.id, intent.id);
    await delay(5);
    const waiting = f.kernel.transition(task.id, 'waiting_approval');
    assert.notEqual(waiting.updatedAt, eventAt, 'the task update time moved after preparation');
    for (let index = 0; index < 10; index++) f.kernel.appendEvent(task.id, 'history.later', { index });
    const pending: PendingApproval[] = f.kernel.pendingApprovals();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.intent.id, intent.id);
    assert.equal(pending[0]!.task.id, task.id);
    assert.equal(pending[0]!.preparedAt, eventAt);
    assert.notEqual(pending[0]!.preparedAt, waiting.updatedAt);
    assert.equal(f.kernel.preparedAt(intent.id), eventAt);
    assert.equal(f.kernel.preparedAt('missing-intent'), undefined);

    const reopened = f.reopen();
    assert.equal(reopened.preparedAt(intent.id), eventAt);
    assert.equal(preparedEventAt(reopened, task.id, intent.id), eventAt);
    const afterReopen = reopened.pendingApprovals();
    assert.equal(afterReopen.length, 1);
    assert.equal(afterReopen[0]!.preparedAt, eventAt);
    assert.equal(reopened.getTask(task.id)!.updatedAt, waiting.updatedAt);
});

test('an older pending approval survives 200 newer cancelled tasks', t => {
    const f = fixture(t);
    const older = running(f.kernel, { title: 'Only pending effect' });
    const intent = prepare(f.kernel, older.task.id, older.runId, 'survivor');
    assert.equal(intent.authorization?.decision, 'ask');
    const deniedLater: string[] = [];
    for (let index = 0; index < 200; index++) {
        if (index < 3) {
            const later = running(f.kernel, { title: `Later cancelled ${index}` });
            const laterIntent = prepare(f.kernel, later.task.id, later.runId, `cancelled-${index}`);
            deniedLater.push(laterIntent.id);
            f.kernel.command({ commandId: crypto.randomUUID(), taskId: later.task.id, type: 'cancel' });
        } else {
            const later = create(f.kernel, { title: `Later cancelled ${index}` });
            f.kernel.command({ commandId: crypto.randomUUID(), taskId: later.id, type: 'cancel' });
        }
    }
    assert.deepEqual(f.kernel.pendingApprovals().map(item => item.intent.id), [intent.id]);
    assert.deepEqual(f.kernel.pendingApprovals({ taskId: older.task.id }).map(item => item.intent.id), [intent.id]);
    assert.deepEqual(f.kernel.pendingApprovals({ taskId: 'missing-task' }), []);
    for (const laterId of deniedLater) {
        assert.equal(f.kernel.getIntent(laterId)?.state, 'denied');
        assert.ok(!f.kernel.pendingApprovals().some(item => item.intent.id === laterId));
    }
});

test('pending approvals are capped at 200, stably ordered and task-filtered', t => {
    const f = fixture(t);
    const many = running(f.kernel, { title: 'Many prepared approvals' });
    for (let index = 0; index < 205; index++) prepare(f.kernel, many.task.id, many.runId, `many-${index}`);
    const other = running(f.kernel, { title: 'Filtered prepared approvals' });
    const otherIds = [0, 1, 2].map(index => prepare(f.kernel, other.task.id, other.runId, `other-${index}`).id);
    const expected = expectedActionableOrder(f.directory);
    assert.equal(expected.length, 208);
    const pending = f.kernel.pendingApprovals();
    assert.equal(pending.length, 200);
    assert.deepEqual(pending.map(item => item.intent.id), expected.slice(0, 200).map(row => row.id));
    assert.deepEqual(f.kernel.pendingApprovals().map(item => item.intent.id), pending.map(item => item.intent.id));
    assert.deepEqual(f.kernel.pendingApprovals({ limit: 1 }).map(item => item.intent.id), expected.slice(0, 1).map(row => row.id));
    const otherPending = f.kernel.pendingApprovals({ taskId: other.task.id });
    assert.deepEqual(new Set(otherPending.map(item => item.intent.id)), new Set(otherIds));
    assert.equal(f.kernel.pendingApprovals({ taskId: many.task.id }).length, 200);
    assert.equal(f.kernel.pendingApprovals({ limit: 200 }).length, 200);
    for (const limit of [0, 201, 1.5, -1, Number.NaN]) {
        assert.throws(() => f.kernel.pendingApprovals({ limit }), isInvalidLimit, `limit ${limit} must fail`);
    }
});

test('only a prepared ask decision is actionable in the pending projection', t => {
    const f = fixture(t);
    const ask = preparedUnder(f.kernel, 'ask', 'ask');
    const review = preparedUnder(f.kernel, 'auto-review', 'review');
    const allow = preparedUnder(f.kernel, 'full-access', 'allow');
    assert.equal(review.intent.authorization?.decision, 'review');
    assert.equal(allow.intent.authorization?.decision, 'allow');
    assert.equal(f.kernel.getIntent(review.intent.id)?.state, 'prepared');
    assert.equal(f.kernel.getIntent(allow.intent.id)?.state, 'prepared');
    const denied = preparedUnder(f.kernel, 'ask', 'denied');
    f.kernel.deny(denied.intent.id, 'Operator denied this effect');
    const approved = preparedUnder(f.kernel, 'ask', 'approved');
    f.kernel.approve(approved.intent.id);
    const revoked = preparedUnder(f.kernel, 'ask', 'revoked');
    f.kernel.revoke(revoked.task.id, revoked.intent.id);
    const cancelled = preparedUnder(f.kernel, 'ask', 'cancelled');
    f.kernel.command({ commandId: crypto.randomUUID(), taskId: cancelled.task.id, type: 'cancel' });
    const sent = preparedUnder(f.kernel, 'ask', 'sent');
    f.kernel.approve(sent.intent.id);
    f.kernel.dispatch(sent.intent.id);
    assert.equal(f.kernel.getIntent(sent.intent.id)?.state, 'sent');
    assert.deepEqual(f.kernel.pendingApprovals().map(item => item.intent.id), [ask.intent.id]);
    for (const gone of [denied, approved, revoked, cancelled]) assert.notEqual(f.kernel.getIntent(gone.intent.id)?.state, 'prepared');
});

test('pendingApprovals never enumerates tasks, intents or events', t => {
    const f = fixture(t);
    const first = running(f.kernel);
    prepare(f.kernel, first.task.id, first.runId, 'bounded-a');
    const second = running(f.kernel);
    prepare(f.kernel, second.task.id, second.runId, 'bounded-b');
    const blocked = (name: string) => () => { throw new Error(`${name} must not be enumerated by the approval query`); };
    Object.assign(f.kernel, { listTasks: blocked('listTasks'), intents: blocked('intents'), events: blocked('events') });
    const pending: PendingApproval[] = f.kernel.pendingApprovals();
    assert.equal(pending.length, 2);
    assert.equal(f.kernel.pendingApprovals({ taskId: second.task.id }).length, 1);
    assert.equal(f.kernel.preparedAt(pending[0]!.intent.id), pending[0]!.preparedAt);
});

test('a large unrelated history neither hides nor invents approvals and the query uses partial indexes', t => {
    const f = fixture(t);
    const targets = running(f.kernel, { title: 'Target approvals' });
    for (let index = 0; index < 3; index++) prepare(f.kernel, targets.task.id, targets.runId, `target-${index}`);
    for (let index = 0; index < 500; index++) {
        const noise = running(f.kernel, { title: `Unrelated ${index}`, permissionMode: index % 2 === 0 ? 'full-access' : 'auto-review' });
        prepare(f.kernel, noise.task.id, noise.runId, `noise-${index}`);
    }
    const expected = expectedActionableOrder(f.directory);
    assert.equal(expected.length, 3);
    const pending = f.kernel.pendingApprovals();
    assert.deepEqual(pending.map(item => item.intent.id), expected.map(row => row.id));
    assert.ok(pending.every(item => item.task.id === targets.task.id));
    assert.equal(f.kernel.pendingApprovals({ taskId: targets.task.id }).length, 3);
    f.close();
    const db = new DatabaseSync(path.join(f.directory, 'kernel.sqlite'));
    try {
        const globalPlan = planDetails(db, GLOBAL_PENDING_SQL);
        t.diagnostic('global pending plan: ' + globalPlan.join(' | '));
        assert.ok(globalPlan.some(line => line.includes('intents_actionable_prepared')), 'global query uses the partial prepared index');
        assert.ok(globalPlan.some(line => /SEARCH t USING (?:COVERING )?INDEX/.test(line)), 'the task join is an index lookup');
        assert.ok(!scansTasks(globalPlan), 'tasks are never scanned end to end');
        const taskPlan = planDetails(db, TASK_PENDING_SQL, targets.task.id);
        t.diagnostic('task pending plan: ' + taskPlan.join(' | '));
        assert.ok(taskPlan.some(line => line.includes('intents_actionable_task')), 'scoped query uses the partial task index');
        assert.ok(taskPlan.some(line => /SEARCH t USING (?:COVERING )?INDEX/.test(line)), 'the scoped task join is an index lookup');
        assert.ok(!scansTasks(taskPlan), 'scoped queries never scan tasks');
    } finally { db.close(); }
});

test('an old database without prepared_at migrates once and leaves missing event time unknown', async t => {
    const f = fixture(t);
    const primary = running(f.kernel, { title: 'Legacy prepared event' });
    for (let index = 0; index < 3; index++) f.kernel.appendEvent(primary.task.id, 'history.noise', { index });
    const intent = prepare(f.kernel, primary.task.id, primary.runId, 'legacy-event');
    const eventAt = preparedEventAt(f.kernel, primary.task.id, intent.id);
    await delay(5);
    const updated = f.kernel.transition(primary.task.id, 'waiting_approval');
    assert.notEqual(updated.updatedAt, eventAt);
    const fallback = running(f.kernel, { title: 'Legacy event-missing intent' });
    const fallbackIntent = prepare(f.kernel, fallback.task.id, fallback.runId, 'legacy-missing');
    const fallbackUpdatedAt = f.kernel.getTask(fallback.task.id)!.updatedAt;
    assert.notEqual(fallbackUpdatedAt, eventAt);

    f.close();
    let legacy: { intents: unknown[]; tasks: unknown[]; events: unknown[] };
    const raw = new DatabaseSync(path.join(f.directory, 'kernel.sqlite'));
    try {
        raw.exec("DROP INDEX IF EXISTS intents_actionable_prepared; DROP INDEX IF EXISTS intents_actionable_task; ALTER TABLE intents DROP COLUMN prepared_at;");
        raw.prepare("DELETE FROM events WHERE type='intent.prepared' AND json_extract(payload,'$.intentId')=?").run(fallbackIntent.id);
        legacy = {
            intents: raw.prepare('SELECT id,task_id,run_id,effect_key,state,body,capability,paths FROM intents ORDER BY rowid').all(),
            tasks: raw.prepare('SELECT id,status,revision,body FROM tasks ORDER BY rowid').all(),
            events: raw.prepare('SELECT seq,task_id,type,payload,created_at FROM events ORDER BY seq').all(),
        };
    } finally { raw.close(); }

    f.reopen();
    assert.equal(f.kernel.preparedAt(intent.id), eventAt, 'a real prepared event remains the exact timestamp');
    assert.equal(f.kernel.preparedAt(fallbackIntent.id), undefined, 'a missing event is unknown, never task.updatedAt');
    const pending = f.kernel.pendingApprovals();
    assert.deepEqual(pending.map(item => item.intent.id).sort(), [intent.id, fallbackIntent.id].sort());
    assert.equal(pending.find(item => item.intent.id === intent.id)?.preparedAt, eventAt);
    assert.equal(pending.find(item => item.intent.id === fallbackIntent.id)?.preparedAt, null);

    const migrated = new DatabaseSync(path.join(f.directory, 'kernel.sqlite'));
    try {
        assert.deepEqual({
            intents: migrated.prepare('SELECT id,task_id,run_id,effect_key,state,body,capability,paths FROM intents ORDER BY rowid').all(),
            tasks: migrated.prepare('SELECT id,status,revision,body FROM tasks ORDER BY rowid').all(),
            events: migrated.prepare('SELECT seq,task_id,type,payload,created_at FROM events ORDER BY seq').all(),
        }, legacy, 'migration only adds the nullable column; task/intent bodies and events are not rewritten');
        assert.equal(Number(migrated.prepare("SELECT COUNT(*) AS count FROM kernel_migrations WHERE name='intents.prepared_at.v1'").get()!.count), 1);
    } finally { migrated.close(); }

    await delay(5);
    const moved = f.kernel.transition(fallback.task.id, 'running');
    assert.notEqual(moved.updatedAt, fallbackUpdatedAt, 'the task update time moved after migration');
    assert.equal(f.kernel.preparedAt(fallbackIntent.id), undefined, 'task updates never become prepared time');

    f.reopen();
    assert.equal(f.kernel.preparedAt(intent.id), eventAt);
    assert.equal(f.kernel.preparedAt(fallbackIntent.id), undefined, 'a second reopen keeps the unknown value');
    const marker = new DatabaseSync(path.join(f.directory, 'kernel.sqlite'));
    try {
        assert.equal(Number(marker.prepare("SELECT COUNT(*) AS count FROM kernel_migrations WHERE name='intents.prepared_at.v1'").get()!.count), 1);
        marker.prepare("INSERT INTO events(task_id,type,payload,created_at) VALUES(?, 'intent.prepared', json_object('intentId', ?), '2030-01-01T00:00:00.000Z')").run(fallback.task.id, fallbackIntent.id);
    } finally { marker.close(); }

    f.reopen();
    assert.equal(f.kernel.preparedAt(fallbackIntent.id), undefined, 'the one-time migration never rescans nulls after reopening');
});

test('rebinding an interrupted intent keeps its original prepared time', t => {
    const f = fixture(t);
    const { task, runId } = running(f.kernel);
    const intent = prepare(f.kernel, task.id, runId, 'rebound');
    const eventAt = preparedEventAt(f.kernel, task.id, intent.id);
    f.kernel.approve(intent.id);
    f.kernel.recover();
    const rebound = f.kernel.rebindIntent(intent.id, f.kernel.createRun(task.id).id);
    assert.equal(rebound.state, 'prepared');
    assert.equal(f.kernel.preparedAt(intent.id), eventAt);
    assert.equal(f.kernel.getIntent(intent.id)?.state, 'prepared');
    const pending = f.kernel.pendingApprovals({ taskId: task.id });
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.preparedAt, eventAt);
});
