import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { startBackend } from '../src/app/backend.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';
import type { ApprovalDecision, ApprovalRequest, FileClaimView } from '../src/frontend/api/types.js';
import type { Task } from '../src/contracts.js';

const root = path.resolve('.tmp/continuation-20261117-product-coordination');
mkdirSync(root, { recursive: true });
const isError = (code: string) => (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
const shownDecision = (item: ApprovalRequest) => ({ approved: true, scope: 'once' as const, expectedIntentDigest: item.digest, expectedConflictFingerprint: item.conflict!.fingerprint });
// The browser contract uses bundler-only import resolution. Keep this Node test's type surface
// local while executing the exact production BridgeGateway bundle below.
interface Gateway {
    approvals: { pending(sessionId?: string): Promise<ApprovalRequest[]>; decide(id: string, decision: ApprovalDecision): Promise<void> };
    coordination: {
        claim(id: string, paths: string[]): Promise<FileClaimView[]>;
        release(id: string, ids: string[]): Promise<void>;
        claims(query: { sessionId: string }): Promise<{ items: FileClaimView[] }>;
        inbox(id: string): Promise<unknown>;
        send(input: { sessionId: string; to: string; kind: 'result_proposal'; body: string; clientMessageId: string }): Promise<unknown>;
        ack(id: string, ids: string[]): Promise<void>;
    };
}

async function fixture(t: TestContext, responder?: MockProviderOptions['responder']) {
    const directory = mkdtempSync(path.join(root, 'http-')), workspace = path.join(directory, 'workspace');
    mkdirSync(workspace); writeFileSync(path.join(workspace, 'shared.txt'), 'original source');
    let ownedBackend: Awaited<ReturnType<typeof startBackend>> | undefined;
    t.after(async () => {
        await ownedBackend?.close();
        assert.ok(directory.startsWith(root + path.sep)); rmSync(directory, { recursive: true, force: true });
    });
    const backend = await startBackend({ projectRoot: process.cwd(), dataDir: path.join(directory, 'data'), ...(responder ? { mockOptions: { responder } } : {}) });
    ownedBackend = backend;
    const calls: { method: string; route: string; input?: unknown; status: number }[] = [];
    const request = async (method: string, route: string, input?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${backend.port}${route}`, { method,
            headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(10_000) });
        const value = await response.json() as Record<string, any>;
        calls.push({ method, route, input: structuredClone(input), status: response.status });
        return { status: response.status, value };
    };
    const bundle = await build({ entryPoints: [path.resolve('src/frontend/api/bridge.ts')], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24', logLevel: 'silent' });
    const { BridgeGateway } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles![0]!.text).toString('base64'));
    const gateway = new BridgeGateway({ request: async (method: string, route: string, input?: unknown) => {
        const result = await request(method, route, input);
        return result.status >= 200 && result.status < 300 ? result.value : { ...result.value, httpStatus: result.status };
    }, desktop: async () => assert.fail('Coordination must not invoke native desktop actions.') }) as Gateway;
    const registered = await request('POST', '/v1/product/workspace/projects', { path: workspace });
    assert.equal(registered.status, 200, JSON.stringify(registered.value));
    const kernel = backend.services.kernel;
    const actor = (title = 'Manual Work actor') => {
        const id = kernel.command({ commandId: crypto.randomUUID(), type: 'create_task', parameters: { title, workspace, permissionMode: 'full-access' } }).taskId!;
        const run = kernel.createRun(id); kernel.transition(id, 'running');
        // Waiting for input is a real non-runnable Work state, while its edit lease can remain active.
        kernel.transition(id, 'waiting_input', { waitingReason: 'Fixture holds an active edit while awaiting user input' });
        return { task: kernel.getTask(id)!, runId: run.id };
    };
    const until = async <T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string) => {
        const deadline = performance.now() + 25_000;
        for (;;) {
            const value = await read();
            if (ready(value)) return value;
            if (performance.now() >= deadline) assert.fail(`Timeout waiting for ${label}: ${JSON.stringify(value).slice(0, 1200)}`);
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    };
    const read = async (owner: { task: Task; runId: string }) => {
        kernel.transition(owner.task.id, 'queued');
        kernel.transition(owner.task.id, 'running');
        const worker = backend.services.runner.gateway(owner.task);
        const prepared = await worker.prepare({ name: 'read_file', arguments: { path: 'shared.txt' } });
        const intent = kernel.prepareIntent(owner.task.id, owner.runId, { id: crypto.randomUUID(), name: 'read_file', arguments: prepared.arguments });
        kernel.approve(intent.id); kernel.dispatch(intent.id);
        const outcome = await worker.execute(prepared, { effectKey: intent.effectKey });
        assert.equal(outcome.status, 'applied', outcome.error); kernel.receipt(intent.id, outcome.receipt!);
        return worker;
    };
    const propose = async (owner: { task: Task; runId: string }) => {
        const worker = await read(owner);
        const prepared = await worker.prepare({ name: 'write_file', arguments: { path: 'shared.txt', content: 'approved edit' } });
        const intent = kernel.prepareIntent(owner.task.id, owner.runId, { id: crypto.randomUUID(), name: 'write_file', arguments: prepared.arguments });
        kernel.transition(owner.task.id, 'waiting_approval');
        const items = await gateway.approvals.pending(owner.task.id);
        const shown = items.find(item => item.id === intent.id); assert.ok(shown);
        return { prepared, intent, shown, worker };
    };
    return { backend, kernel, gateway, calls, request, actor, until, propose, workspace, projectId: String(registered.value.id) };
}

test('real full-access Work pauses for peer conflict and displayed digest/fingerprint round-trip through Bridge and Product HTTP', { timeout: 90_000 }, async t => {
    let proposedWrites = 0;
    const f = await fixture(t, body => {
        const messages = body.messages as { role: string; content?: unknown; tool_call_id?: string }[];
        if (messages.some(item => item.role === 'system' && String(item.content).includes('REVIEWER ROLE')))
            return { content: JSON.stringify({ verdict: 'pass', reason: 'Fixture independent review', findings: [] }) };
        const last = messages.findLast(item => item.role === 'tool');
        if (!last) return { content: '', toolCalls: [{ id: 'actual-read', name: 'read_file', arguments: { path: 'shared.txt' } }] };
        if (last.tool_call_id === 'actual-read') {
            proposedWrites++;
            return { content: '', toolCalls: [{ id: 'actual-write', name: 'write_file', arguments: { path: 'shared.txt', content: 'approved edit' } }] };
        }
        return { content: 'The actual file operation is recorded.' };
    });
    const peer = f.actor('Peer editing shared file');
    const claims = await f.gateway.coordination!.claim(peer.task.id, ['shared.txt']); assert.equal(claims.length, 1);
    const sent = await f.request('POST', '/v1/product/chat/send', { mode: 'cowork', text: 'Read shared.txt and update it once.', attachments: [], permission: 'full-access', modelId: 'default', projectId: f.projectId });
    assert.equal(sent.status, 200, JSON.stringify(sent.value)); const taskId = String(sent.value.sessionId);
    const items = await f.until(() => f.gateway.approvals.pending(taskId), value => value.length === 1, 'full-access conflict approval');
    const shown = items[0]!, intent = f.kernel.getIntent(shown.id)!;
    assert.equal(f.kernel.permissionMode(taskId), 'full-access'); assert.equal(intent.state, 'prepared');
    assert.equal(intent.authorization!.decision, 'ask'); assert.equal(intent.authorization!.requiresOperator, true);
    assert.equal(shown.digest, intent.digest); assert.equal(shown.conflict!.fingerprint, intent.fileConflicts!.fingerprint);
    assert.ok(shown.conflict!.participants.some(item => item.taskId === peer.task.id));
    assert.equal(readFileSync(path.join(f.workspace, 'shared.txt'), 'utf8'), 'original source');
    assert.equal(f.kernel.eventCount(taskId, 'intent.approved'), 1, 'only the real read has automatic approval');
    assert.equal(proposedWrites, 1);
    await f.gateway.approvals.decide(shown.id, shownDecision(shown));
    const posted = f.calls.findLast(item => item.route.endsWith('/approvals/decide'))!;
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.input, { approvalId: shown.id, ...shownDecision(shown) });
    await f.until(async () => f.kernel.getIntent(shown.id)!.state, value => value === 'applied', 'approved worker effect');
    assert.equal(readFileSync(path.join(f.workspace, 'shared.txt'), 'utf8'), 'approved edit');
    assert.equal(f.kernel.events(taskId).filter(item => item.type === 'intent.sent' && item.payload.intentId === shown.id).length, 1);
});

test('Product rejects missing bindings and stale displayed conflict sets without silently reapproving', { timeout: 90_000 }, async t => {
    const f = await fixture(t); await f.backend.services.runner.stop();
    const actor = f.actor(), peer = f.actor('First peer');
    await f.gateway.coordination!.claim(peer.task.id, ['shared.txt']);
    const operation = await f.propose(actor);
    await assert.rejects(f.gateway.approvals.decide(operation.shown.id, { approved: true, scope: 'once' }), isError('conflict'));
    await assert.rejects(f.gateway.approvals.decide(operation.shown.id, { ...shownDecision(operation.shown), scope: 'session' }), isError('denied'));
    assert.equal(f.kernel.getIntent(operation.intent.id)!.state, 'prepared');
    const later = f.actor('Later peer'); await f.gateway.coordination!.claim(later.task.id, ['shared.txt']);
    await assert.rejects(f.gateway.approvals.decide(operation.shown.id, shownDecision(operation.shown)), isError('stale'));
    const stale = (await f.gateway.approvals.pending(actor.task.id)).find(item => item.id === operation.shown.id)!;
    assert.equal(stale.digest, operation.shown.digest); assert.equal(stale.conflict!.fingerprint, operation.shown.conflict!.fingerprint);
    assert.match(stale.reason, /FILE_CONFLICT_STALE/);
    assert.equal(f.kernel.getIntent(operation.intent.id)!.state, 'prepared');
    assert.equal(f.kernel.events(actor.task.id).filter(item => item.type === 'intent.approved' && item.payload.intentId === operation.intent.id).length, 0);
    assert.equal(readFileSync(path.join(f.workspace, 'shared.txt'), 'utf8'), 'original source');
});

test('a new peer after Product approval still blocks dispatch before any additional tool budget or file effect', { timeout: 90_000 }, async t => {
    const f = await fixture(t); await f.backend.services.runner.stop();
    const actor = f.actor(), peer = f.actor('Original peer'); await f.gateway.coordination!.claim(peer.task.id, ['shared.txt']);
    const operation = await f.propose(actor);
    await f.gateway.approvals.decide(operation.shown.id, shownDecision(operation.shown));
    assert.equal(f.kernel.getIntent(operation.intent.id)!.state, 'approved');
    const before = f.kernel.getBudgets(actor.task.id).toolCalls;
    const later = f.actor('Peer arriving after approval'); await f.gateway.coordination!.claim(later.task.id, ['shared.txt']);
    assert.throws(() => f.kernel.dispatch(operation.intent.id), isError('FILE_CONFLICT_STALE'));
    assert.equal(f.kernel.getBudgets(actor.task.id).toolCalls, before);
    assert.equal(f.kernel.getIntent(operation.intent.id)!.state, 'approved');
    assert.equal(readFileSync(path.join(f.workspace, 'shared.txt'), 'utf8'), 'original source');
});

test('Product conflict approval cannot refresh a stale read version even with exactly displayed bindings', { timeout: 90_000 }, async t => {
    const f = await fixture(t); await f.backend.services.runner.stop();
    const actor = f.actor(), peer = f.actor('Peer'); await f.gateway.coordination!.claim(peer.task.id, ['shared.txt']);
    const operation = await f.propose(actor);
    writeFileSync(path.join(f.workspace, 'shared.txt'), 'external update');
    await assert.rejects(f.gateway.approvals.decide(operation.shown.id, shownDecision(operation.shown)), isError('stale'));
    assert.equal(f.kernel.getIntent(operation.intent.id)!.state, 'prepared');
    assert.equal(readFileSync(path.join(f.workspace, 'shared.txt'), 'utf8'), 'external update');
    assert.equal(f.kernel.events(actor.task.id).filter(item => item.type === 'intent.sent' && item.payload.intentId === operation.intent.id).length, 0);
});

test('Chat remains an observer and cannot claim, release, read, send or acknowledge a Work inbox through Bridge HTTP', { timeout: 90_000 }, async t => {
    const f = await fixture(t); await f.backend.services.runner.stop();
    const work = f.actor(), claims = await f.gateway.coordination!.claim(work.task.id, ['shared.txt']);
    const chat = f.backend.services.harness!.store.createSession({ workspace: f.workspace });
    const operations = [
        () => f.gateway.coordination!.claim(chat.id, ['shared.txt']),
        () => f.gateway.coordination!.release(chat.id, [claims[0]!.id]),
        () => f.gateway.coordination!.inbox(chat.id),
        () => f.gateway.coordination!.send({ sessionId: chat.id, to: work.task.id, kind: 'result_proposal', body: 'Do not grant authority', clientMessageId: 'chat-denied' }),
        () => f.gateway.coordination!.ack(chat.id, ['fabricated-notice']),
    ];
    for (const operation of operations) await assert.rejects(operation, isError('validation'));
    const observed = await f.gateway.coordination!.claims({ sessionId: chat.id });
    assert.equal(observed.items.length, 1); assert.equal(observed.items[0]!.taskId, work.task.id);
    assert.equal(f.kernel.getTask(chat.id), undefined);
    assert.equal(f.kernel.fileClaims.claimedPaths(work.task.id).total, 1);
});

test('unbound Chat has empty coordination pages and scoped Chats keep their authorized workspace', async t => {
    const f = await fixture(t, () => ({ content: 'Fixture reply.' }));
    await f.backend.services.runner.stop();
    const routes = ['presence', 'claims'];
    const pages = (id: string) => Promise.all(routes.map(route =>
        f.request('GET', '/v1/product/coordination/' + route + '?sessionId=' + encodeURIComponent(id))));
    const sent = await f.request('POST', '/v1/product/chat/send', {
        mode: 'chat', text: 'Unbound Chat', attachments: [], permission: 'read-only', modelId: 'default',
    });
    assert.equal(sent.status, 200);
    const store = f.backend.services.harness!.store;
    const unbound = store.getSession(sent.value.sessionId);
    assert.equal(unbound.workspace, f.backend.services.projectRoot);
    const empty = await pages(unbound.id);
    assert.deepEqual(empty.map(page => page.status), [200, 200], JSON.stringify(empty));
    assert.deepEqual(empty.map(page => page.value), [{ items: [] }, { items: [] }]);

    const peer = f.actor('Scoped peer');
    await f.gateway.coordination!.claim(peer.task.id, ['shared.txt']);
    const legacy = store.createSession({ workspace: f.workspace });
    const registered = store.createSession({ workspace: f.backend.services.projectRoot });
    f.backend.services.product!.sessions.indexChatSession(registered, {projectId: f.projectId});
    for (const id of [legacy.id, registered.id]) {
        const [presence, claims] = await pages(id);
        assert.equal(presence!.status, 200);
        assert.ok(Array.isArray(presence!.value.external.items));
        assert.equal(claims!.status, 200);
        assert.deepEqual(claims!.value.items.map((row: FileClaimView) => row.taskId), [peer.task.id]);
    }
    const protectedChat = store.createSession({ workspace: f.backend.services.dataDir });
    assert.deepEqual((await pages(protectedChat.id)).map(page => page.status), [400, 400]);
    assert.deepEqual((await pages('missing-chat-id')).map(page => page.status), [404, 404]);
});
