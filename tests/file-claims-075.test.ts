import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Kernel, KernelError } from '../src/kernel/index.js';
import { FileClaims } from '../src/kernel/file-claims.js';
import { ToolGateway } from '../src/tools/gateway.js';
import { fileURLToPath } from 'node:url';
import type { Intent, PermissionMode } from '../src/contracts.js';

const root = path.resolve('.tmp/continuation-20261117-fileclaims'); mkdirSync(root, { recursive: true });
function fixture() {
    const directory = mkdtempSync(path.join(root, 'flow-'));
    const workspace = path.join(directory, 'workspace'); mkdirSync(workspace);
    const kernel = new Kernel(path.join(directory, 'data'));
    const actor = (mode: PermissionMode = 'full-access') => {
        const ack = kernel.command({ commandId: crypto.randomUUID(), type: 'create_task', parameters: { title: mode, workspace, permissionMode: mode } });
        const task = kernel.getTask(ack.taskId!)!; const run = kernel.createRun(task.id); kernel.transition(task.id, 'running');
        return { task, runId: run.id };
    };
    return { kernel, workspace, actor, directory, close() { kernel.close(); assert.ok(directory.startsWith(root + path.sep)); rmSync(directory, { recursive: true, force: true }); } };
}
const code = (expected: string) => (error: unknown) => error instanceof KernelError && error.code === expected;
const approval = (intent: Intent) => ({ expectedIntentDigest: intent.digest, expectedConflictFingerprint: intent.fileConflicts!.fingerprint, source: 'operator' as const, scope: 'once' as const });
function write(f: ReturnType<typeof fixture>, actor: ReturnType<ReturnType<typeof fixture>['actor']>, filename = 'shared.txt') {
    return f.kernel.prepareIntent(actor.task.id, actor.runId, { id: crypto.randomUUID(), name: 'write_file', arguments: { path: filename, content: 'new' } });
}

test('a peer editing claim forces human approval even in full-access mode', () => {
    const f = fixture();
    try {
        const a = f.actor(), peer = f.actor();
        f.kernel.fileClaims.claimFiles(peer.task.id, ['shared.txt']);
        const intent = f.kernel.prepareIntent(a.task.id, a.runId, { id: crypto.randomUUID(), name: 'write_file', arguments: { path: 'shared.txt', content: 'new' } });
        assert.equal(f.kernel.decideIntent(intent.id).outcome, 'ask');
    } finally { f.close(); }
});

test('four permission modes keep hard denials and every allowed conflict requires operator once with displayed bindings', () => {
    const f = fixture();
    try {
        const peer = f.actor(); f.kernel.fileClaims.claimFiles(peer.task.id, ['shared.txt']);
        for (const mode of ['read-only', 'ask', 'auto-review', 'full-access'] as const) {
            const actor = f.actor(mode);
            if (mode === 'read-only') { assert.throws(() => write(f, actor), code('PERMISSION_DENIED')); continue; }
            const intent = write(f, actor);
            assert.equal(intent.authorization!.requiresOperator, true, mode);
            assert.equal(f.kernel.decideIntent(intent.id).outcome, 'ask', mode);
            for (const source of ['policy', 'review', 'session'] as const)
                assert.throws(() => f.kernel.approve(intent.id, { ...approval(intent), source }), code('CONFLICT_APPROVAL_REQUIRED'));
            assert.throws(() => f.kernel.approve(intent.id, { ...approval(intent), scope: 'session' }), code('CONFLICT_SCOPE_FORBIDDEN'));
            assert.throws(() => f.kernel.approve(intent.id), code('CONFLICT_APPROVAL_REQUIRED'));
            assert.throws(() => f.kernel.approve(intent.id, { ...approval(intent), expectedIntentDigest: 'stale' }), code('CONFLICT_APPROVAL_REQUIRED'));
            f.kernel.approve(intent.id, approval(intent));
            assert.equal(f.kernel.getIntent(intent.id)!.state, 'approved');
            assert.throws(() => f.kernel.approve(intent.id), code('CONFLICT_APPROVAL_REQUIRED'), 'idempotent approval cannot bypass binding');
        }
    } finally { f.close(); }
});

test('allow rules and existing session grants cannot answer a new editing conflict', () => {
    const f = fixture();
    try {
        const actor = f.actor('ask'), peer = f.actor();
        const grant = write(f, actor); f.kernel.approve(grant.id, { scope: 'session', source: 'operator' });
        assert.equal(f.kernel.sessionGrants(actor.task.id).length, 1);
        f.kernel.fileClaims.claimFiles(peer.task.id, ['shared.txt']);
        const intent = write(f, actor);
        assert.equal(f.kernel.decideIntent(intent.id).outcome, 'ask');
        assert.equal(intent.authorization!.grantId, undefined);
        f.kernel.setPermissionRules([{ id: 'allow-write', pattern: '*', capability: 'write', decision: 'allow' }]);
        assert.equal(f.kernel.decideIntent(intent.id).outcome, 'ask');
        const refreshed = f.actor('ask'), allowed = write(f, refreshed);
        assert.equal(f.kernel.decideIntent(allowed.id).outcome, 'ask');
        assert.throws(() => f.kernel.approve(allowed.id, { source: 'policy' }), code('CONFLICT_APPROVAL_REQUIRED'));
        f.kernel.approve(allowed.id, approval(allowed));
        assert.equal(f.kernel.getIntent(allowed.id)!.authorization!.requiresOperator, true);
        f.kernel.setPermissionRules([{ id: 'deny-write', pattern: '*', capability: 'write', decision: 'deny' }]);
        assert.equal(f.kernel.decideIntent(allowed.id).outcome, 'deny');
        assert.throws(() => f.kernel.approve(allowed.id, approval(allowed)), code('STALE_GENERATION'));
        assert.throws(() => f.kernel.dispatch(allowed.id), code('POLICY_DENY'));
        assert.throws(() => write(f, f.actor()), code('PERMISSION_DENIED'));
    } finally { f.close(); }
});

test('an independent review pass cannot authorize conflicts appearing after review', () => {
    const f = fixture();
    try {
        const actor = f.actor('auto-review'), peer = f.actor(); const intent = write(f, actor);
        f.kernel.recordToolReview(intent.id, { verdict: 'pass', reviewer: 'tool-reviewer:separate', reviewerModelId: 'separate-model', risk: 'high', reason: 'bounded file', checks: [{ label: 'scope', ok: true }], durationMs: 1 });
        f.kernel.fileClaims.claimFiles(peer.task.id, ['shared.txt']);
        assert.throws(() => f.kernel.approve(intent.id, { source: 'review' }), code('FILE_CONFLICT_STALE'));
        assert.equal(f.kernel.getBudgets(actor.task.id).toolCalls, 0);
        const next = write(f, actor);
        assert.equal(next.authorization!.decision, 'ask');
        assert.throws(() => f.kernel.recordToolReview(next.id, { verdict: 'pass', reviewer: 'tool-reviewer:separate', reviewerModelId: 'separate-model', risk: 'high', reason: 'pass', checks: [], durationMs: 1 }), code('INVALID_INTENT_STATE'));
    } finally { f.close(); }
});

test('real read establishes editing, operator conflict approval cannot bypass stale bytes, and a real write becomes recent', async () => {
    const f = fixture();
    try {
        const actor = f.actor(), peer = f.actor(), filename = path.join(f.workspace, 'shared.txt'); writeFileSync(filename, 'v1');
        const gateway = new ToolGateway({ workspace: f.workspace, receiptDirectory: path.join(f.directory, 'receipts'), workerPath: fileURLToPath(new URL('../src/tools/worker.js', import.meta.url)), getReadVersion: target => f.kernel.getReadVersion(actor.task.id, target) });
        const readPrepared = await gateway.prepare({ name: 'read_file', arguments: { path: 'shared.txt' } });
        const read = f.kernel.prepareIntent(actor.task.id, actor.runId, { id: crypto.randomUUID(), name: 'read_file', arguments: readPrepared.arguments });
        f.kernel.approve(read.id); f.kernel.dispatch(read.id);
        const readResult = await gateway.execute(readPrepared, { effectKey: read.effectKey }); f.kernel.receipt(read.id, readResult.receipt!);
        assert.equal(f.kernel.fileClaims.claims(f.workspace).items.find(item => item.taskId === actor.task.id)!.mode, 'editing');
        f.kernel.fileClaims.claimFiles(peer.task.id, ['shared.txt']);
        const prepared = await gateway.prepare({ name: 'write_file', arguments: { path: 'shared.txt', content: 'agent' } });
        const intent = f.kernel.prepareIntent(actor.task.id, actor.runId, { id: crypto.randomUUID(), name: 'write_file', arguments: prepared.arguments });
        writeFileSync(filename, 'user changed');
        assert.throws(() => f.kernel.approve(intent.id, approval(intent)), code('READ_VERSION_STALE'));
        writeFileSync(filename, 'v1');
        assert.throws(() => f.kernel.command({ commandId: crypto.randomUUID(), taskId: actor.task.id, type: 'grant', parameters: { intentId: intent.id } }), code('CONFLICT_APPROVAL_REQUIRED'));
        f.kernel.command({ commandId: crypto.randomUUID(), taskId: actor.task.id, type: 'grant', parameters: { intentId: intent.id, ...approval(intent) } });
        f.kernel.dispatch(intent.id);
        const result = await gateway.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest });
        assert.equal(result.status, 'applied', result.error); f.kernel.receipt(intent.id, result.receipt!);
        assert.equal(f.kernel.fileClaims.claims(f.workspace).items.find(item => item.taskId === actor.task.id)!.mode, 'recent');
        assert.equal(f.kernel.getReadVersion(actor.task.id, filename)!.sourceIntentId, read.id, 'claim state never advances the read baseline');
    } finally { f.close(); }
});

test('approval binds the complete conflict set including empty and a late peer cannot consume budget or dispatch', () => {
    const f = fixture();
    try {
        const actor = f.actor(), peer = f.actor();
        const empty = write(f, actor); f.kernel.approve(empty.id, { source: 'policy' });
        const claims = f.kernel.fileClaims.claimFiles(peer.task.id, ['shared.txt']);
        assert.throws(() => f.kernel.dispatch(empty.id), code('FILE_CONFLICT_STALE'));
        assert.equal(f.kernel.getBudgets(actor.task.id).toolCalls, 0);
        const intent = write(f, actor); f.kernel.approve(intent.id, approval(intent));
        f.kernel.fileClaims.claimFiles(peer.task.id, ['unrelated.txt']);
        f.kernel.fileClaims.maintain();
        assert.equal(f.kernel.decideIntent(intent.id).outcome, 'ask');
        const again = f.kernel.fileClaims.claimFiles(peer.task.id, ['shared.txt']);
        assert.deepEqual(again[0], claims[0], 'ordinary renew preserves semantic fingerprint');
        const newcomer = f.actor(); f.kernel.fileClaims.claimFiles(newcomer.task.id, ['shared.txt']);
        assert.throws(() => f.kernel.approve(intent.id, approval(intent)), code('FILE_CONFLICT_STALE'));
        assert.throws(() => f.kernel.dispatch(intent.id), code('FILE_CONFLICT_STALE'));
        assert.equal(f.kernel.eventCount(actor.task.id, 'intent.sent'), 0);
    } finally { f.close(); }
});

test('pause/reacquisition and owner authority changes invalidate approval while hard ownership remains a denial', () => {
    const f = fixture();
    try {
        const actor = f.actor(), peer = f.actor();
        f.kernel.fileClaims.claimFiles(peer.task.id, ['shared.txt']);
        const first = write(f, actor); f.kernel.approve(first.id, approval(first));
        f.kernel.command({ commandId: crypto.randomUUID(), taskId: peer.task.id, type: 'retry' });
        assert.throws(() => f.kernel.dispatch(first.id), code('FILE_CONFLICT_STALE'));
        const next = write(f, actor); f.kernel.approve(next.id, approval(next));
        f.kernel.command({ commandId: crypto.randomUUID(), taskId: peer.task.id, type: 'pause' });
        assert.equal(f.kernel.fileClaims.claims(f.workspace).items.filter(item => item.taskId === peer.task.id).length, 0);
        assert.throws(() => f.kernel.dispatch(next.id), code('FILE_CONFLICT_STALE'));
        f.kernel.claimPaths(peer.task.id, ['shared.txt']);
        assert.throws(() => write(f, actor), code('OWNERSHIP_CONFLICT'));
        assert.throws(() => f.kernel.dispatch(first.id), code('OWNERSHIP_CONFLICT'));
    } finally { f.close(); }
});

test('claims use path boundaries and all matching peers, not a display page; command workspace scope is conservative', () => {
    const f = fixture();
    try {
        const actor = f.actor();
        for (let n = 0; n < 3; n++) {
            const peer = f.actor(); f.kernel.fileClaims.claimFiles(peer.task.id, Array.from({ length: 32 }, (_, index) => `dir/f-${n}-${index}.txt`));
        }
        assert.equal(f.kernel.fileClaims.claims(f.workspace, '', 10).items.length, 10);
        const command = f.kernel.prepareIntent(actor.task.id, actor.runId, { id: crypto.randomUUID(), name: 'run_command', arguments: { argv: ['--version'] } }, { paths: [f.workspace] });
        assert.equal(command.fileConflicts!.conflicts.length, 96);
        assert.equal(f.kernel.decideIntent(command.id).outcome, 'ask');
        const unrelated = write(f, actor, 'directory/file.txt');
        assert.equal(unrelated.fileConflicts!.conflicts.length, 0, 'substring prefixes are not directory overlap');
        const nestedWorkspace = path.join(f.workspace, 'dir'); mkdirSync(nestedWorkspace);
        const nestedId = f.kernel.command({ commandId: crypto.randomUUID(), type: 'create_task', parameters: { title: 'nested', workspace: nestedWorkspace, permissionMode: 'full-access' } }).taskId!;
        const nested = f.kernel.fileClaims.snapshot(nestedId, ['.']);
        assert.equal(nested.conflicts.length, 96, 'nested workspace cannot hide absolute path overlap');
    } finally { f.close(); }
});

test('monotonic expiry does not revive old incarnations, recent is advisory, and restart expires prior claims', () => {
    const f = fixture(); const database = new DatabaseSync(f.kernel.dbPath); let tick = 100;
    try {
        const actor = f.actor(), peer = f.actor();
        const port = { db: database, epoch: 'test-epoch', tx: <T>(run: () => T) => run(), task: (id: string) => f.kernel.getTask(id), changed: () => {} };
        const claims = new FileClaims(port, () => tick);
        const original = claims.claimFiles(peer.task.id, ['shared.txt'])[0]!;
        const snapshot = claims.snapshot(actor.task.id, ['shared.txt']);
        tick += 15_000; claims.maintain(); assert.equal(claims.snapshot(actor.task.id, ['shared.txt']).fingerprint, snapshot.fingerprint);
        tick += 60_001; assert.equal(claims.snapshot(actor.task.id, ['shared.txt']).conflicts.length, 0);
        claims.maintain(); assert.equal(claims.claims(f.workspace).items.length, 0);
        const regained = claims.claimFiles(peer.task.id, ['shared.txt'])[0]!; assert.notEqual(regained.incarnation, original.incarnation);
        claims.afterWrite(peer.task.id, 'shared.txt');
        assert.equal(claims.snapshot(actor.task.id, ['shared.txt']).conflicts.length, 0);
        assert.equal(claims.claims(f.workspace).items[0]!.mode, 'recent');
        tick += 599_999; assert.equal(claims.claims(f.workspace).items.length, 1);
        tick += 2; assert.equal(claims.claims(f.workspace).items.length, 0);
        claims.claimFiles(peer.task.id, ['shared.txt']);
        const restarted = new FileClaims({ ...port, epoch: 'new-epoch' }, () => tick);
        assert.equal(restarted.claims(f.workspace).items.length, 0);
    } finally { database.close(); f.close(); }
});

test('automatic claim capacity preserves a truthful read and exposes bounded summaries; explicit overflow is refused', async () => {
    const f = fixture();
    try {
        const actor = f.actor();
        for (let batch = 0; batch < 8; batch++) f.kernel.fileClaims.claimFiles(actor.task.id, Array.from({ length: 32 }, (_, n) => `held/${batch}-${n}.txt`));
        const summary = f.kernel.fileClaims.claimedPaths(actor.task.id, 3);
        assert.equal(summary.paths.length, 3); assert.equal(summary.total, 256);
        assert.throws(() => f.kernel.fileClaims.claimFiles(actor.task.id, ['overflow.txt']), code('FILE_CLAIM_CAPACITY'));
        writeFileSync(path.join(f.workspace, 'overflow.txt'), 'still readable');
        const gateway = new ToolGateway({ workspace: f.workspace, receiptDirectory: path.join(f.directory, 'receipts'), workerPath: fileURLToPath(new URL('../src/tools/worker.js', import.meta.url)), getReadVersion: target => f.kernel.getReadVersion(actor.task.id, target) });
        const prepared = await gateway.prepare({ name: 'read_file', arguments: { path: 'overflow.txt' } });
        const intent = f.kernel.prepareIntent(actor.task.id, actor.runId, { id: crypto.randomUUID(), name: 'read_file', arguments: prepared.arguments });
        f.kernel.approve(intent.id); f.kernel.dispatch(intent.id);
        const outcome = await gateway.execute(prepared, { effectKey: intent.effectKey }); f.kernel.receipt(intent.id, outcome.receipt!);
        assert.equal(f.kernel.getIntent(intent.id)!.state, 'applied');
        assert.equal(f.kernel.getReadVersion(actor.task.id, path.join(f.workspace, 'overflow.txt'))!.sourceIntentId, intent.id);
        assert.equal(f.kernel.eventCount(actor.task.id, 'coordination.claim_capacity'), 1);
        assert.equal(f.kernel.fileClaims.claimedPaths(actor.task.id).total, 256);
    } finally { f.close(); }
});
