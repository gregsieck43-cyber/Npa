/**
 * Work Inspector approval wiring — real Backend + Product HTTP + controlled Work tool proposal.
 *
 * Regression under test: GET /v1/product/approvals returned the genuine prepared "ask" intent,
 * while GET /v1/product/inspector/tools reported that same tool call as pending and omitted
 * approvalId. The existing ToolCard only renders ApprovalCard when call.approvalId resolves in
 * store.approvals, so the operator could not approve the real pending intent from the Inspector.
 *
 * Every assertion goes through the real listener (Bearer auth + /v1/product), a real
 * SQLite Harness/Kernel/ProductApi and the loopback mock provider. The approvalId assertions can
 * only be satisfied by the current Kernel intent: a fabricated string, a non-ask decision, a
 * fenced/denied intent, a dispatched effect or an auto-reviewed effect must not produce one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import type { MockCompletion, MockProviderOptions } from '../src/fixtures/mock-provider.js';

const TREE = process.cwd();
const DATA_ROOT = path.join(TREE, '.tmp', 'approval-inspector', 'b', 'data', 'http');
mkdirSync(DATA_ROOT, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const RUNNING = new Set(['queued', 'running', 'reconciling']);
const INSPECTOR = '/v1/product/inspector';
const CALL_ID = 'inspector-approval-write';
const FILE_NAME = 'inspector-approval.txt';
const FILE_TEXT = 'approved exactly once\n';
let run = 0;

type Backend = Awaited<ReturnType<typeof startBackend>>;
type Responder = NonNullable<MockProviderOptions['responder']>;
type ToolCallView = { id: string; requestId: string; name: string; status: string; approvalId?: string; result?: unknown; args: Record<string, any> };

interface Fixture {
  readonly backend: Backend;
  readonly harness: NonNullable<Backend['services']['harness']>;
  readonly kernel: Backend['services']['kernel'];
  readonly workspace: string;
  readonly wire: any[];
  request(method: string, route: string, options?: { body?: unknown; auth?: boolean }): Promise<{ status: number; json: any; text: string; headers: Headers }>;
  ok(method: string, route: string, body?: unknown): Promise<any>;
  until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, timeoutMs?: number): Promise<T>;
  startWork(permission: 'ask' | 'auto-review'): Promise<string>;
  approvals(taskId: string): Promise<any[]>;
  inspectorCall(taskId: string, toolCallId?: string): Promise<ToolCallView | undefined>;
  task(taskId: string): Promise<any>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

async function fixture(t: import('node:test').TestContext, responder: Responder): Promise<Fixture> {
  const owned = path.join(DATA_ROOT, 'approval-' + process.pid + '-' + Date.now() + '-' + run++);
  const workspace = path.join(owned, 'workspace');
  const dataDir = path.join(owned, 'data');
  mkdirSync(workspace, { recursive: true });
  const relative = path.relative(TREE, dataDir);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'dataDir must stay inside the project root');
  const wire: any[] = [];
  const settings = { dataDir, projectRoot: TREE, mockOptions: { responder, trace: (body: any) => wire.push(body) } };
  let backend: Backend = await startBackend(settings);
  let closed = false;
  let projectId: string | undefined;

  const request = async (method: string, route: string, options: { body?: unknown; auth?: boolean } = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.auth !== false) headers.Authorization = 'Bearer ' + backend.token;
    const response = await fetch('http://127.0.0.1:' + backend.port + route, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }).catch(error => {
      const cause = error instanceof Error ? error.cause : undefined;
      const detail = cause instanceof Error ? `${cause.message} (${(cause as NodeJS.ErrnoException).code ?? cause.name})` : String(cause);
      throw new Error(`${method} ${route} failed: ${detail}`, { cause: error });
    });
    const text = await response.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: response.status, json, text, headers: response.headers };
  };
  const ok = async (method: string, route: string, body?: unknown): Promise<any> => {
    const reply = await request(method, route, { body });
    assert.equal(reply.status, 200, method + ' ' + route + ' -> ' + reply.status + ': ' + reply.text.slice(0, 500));
    return reply.json;
  };
  const until = async <T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, timeoutMs = 60_000): Promise<T> => {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (ready(value)) return value;
      if (performance.now() > deadline) assert.fail('Timed out waiting for ' + label + ': ' + JSON.stringify(value)?.slice(0, 1200));
      await sleep(25);
    }
  };
  const approvals = async (taskId: string): Promise<any[]> => {
    const value = await ok('GET', '/v1/product/approvals?sessionId=' + encodeURIComponent(taskId));
    assert.ok(Array.isArray(value));
    return value;
  };
  const inspectorCall = async (taskId: string, toolCallId?: string): Promise<ToolCallView | undefined> => {
    const value = await ok('GET', INSPECTOR + '/tools?sessionId=' + encodeURIComponent(taskId));
    assert.ok(Array.isArray(value.calls));
    return value.calls.find((call: ToolCallView) => call.name === 'write_file' && (toolCallId === undefined || call.id === call.requestId + ':' + toolCallId));
  };
  const task = async (taskId: string): Promise<any> => ok('GET', '/v1/product/tasks/' + encodeURIComponent(taskId));
  const startWork = async (permission: 'ask' | 'auto-review'): Promise<string> => {
    if (!projectId) projectId = (await ok('POST', '/v1/product/workspace/projects', { path: workspace })).id as string;
    const sent = await ok('POST', '/v1/product/chat/send', {
      mode: 'cowork', text: 'Write ' + FILE_NAME + ' once for the Inspector approval fixture.',
      attachments: [], permission, modelId: 'default', projectId,
    });
    assert.equal(typeof sent.sessionId, 'string');
    return sent.sessionId as string;
  };
  const restart = async (): Promise<void> => {
    await backend.close();
    backend = await startBackend(settings);
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await backend.close();
  };
  t.after(async () => {
    await close();
    rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  return {
    get backend() { return backend; },
    get harness() { return backend.services.harness!; },
    get kernel() { return backend.services.kernel; },
    workspace, wire, request, ok, until, startWork, approvals, inspectorCall, task, restart, close,
  };
}

/** Controlled Work proposal: one write_file in ask mode, deterministic follow-up, JSON reviewer verdicts. */
const writeOnce: Responder = (body: any): MockCompletion => {
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const system = String(messages.find((message: any) => message.role === 'system')?.content ?? '');
  if (system.includes('REVIEWER ROLE')) return { content: JSON.stringify({ verdict: 'pass', reason: 'Inspector approval fixture reviewer.', findings: [] }) };
  const latestTool = messages.findLast((message: any) => message.role === 'tool');
  let superseded = false;
  if (latestTool) {
    try {
      const result = JSON.parse(String(latestTool.content));
      superseded = result.executed === false && String(result.error).includes('User input or task authority changed');
    } catch { /* Ordinary successful tool output does not need to be JSON. */ }
    if (!superseded) return { content: 'The tool outcome was recorded.' };
  }
  return { content: '', toolCalls: [{ id: superseded ? CALL_ID + '-recovered' : CALL_ID, name: 'write_file', arguments: { path: FILE_NAME, content: FILE_TEXT } }] };
};

/** Main Work rounds only: every provider call for the Work task except the independent reviewer request. The follow-up that carries the tool result is still a main Work round. */
const isMainWorkRound = (body: any): boolean => {
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  return !String(messages.find((message: any) => message.role === 'system')?.content ?? '').includes('REVIEWER ROLE');
};

const TERMINAL_WORK = new Set(['completed', 'waiting_input', 'failed', 'cancelled']);

test('Work Inspector links the real pending ask intent and one approval executes the effect exactly once', { timeout: 120_000 }, async t => {
  const f = await fixture(t, writeOnce);
  const taskId = await f.startWork('ask');

  // RED evidence target: the approvals endpoint already returns the real ask intent, but the
  // Inspector tools projection must expose the same Kernel state and intent id.
  const pending = await f.until(() => f.approvals(taskId), value => value.length === 1, 'the Work task exposes exactly one pending approval');
  const approval = pending[0];
  const call = (await f.until(() => f.inspectorCall(taskId), value => Boolean(value), 'the Inspector lists the proposed write'))!;
  const observed = {
    approvals: pending.map(item => ({ id: item.id, toolCallId: item.toolCallId })),
    call: { id: call.id, name: call.name, status: call.status, approvalId: call.approvalId ?? null },
  };
  assert.equal(call.status, 'awaiting_approval', 'the real Kernel waiting state must reach the Inspector call: ' + JSON.stringify(observed));
  assert.equal(call.approvalId, approval.id, 'the call must point at the one real pending intent id, never a fabricated string: ' + JSON.stringify(observed));
  assert.equal(call.id, call.requestId + ':' + approval.toolCallId);

  const taskBefore = f.kernel.getTask(taskId)!;
  const intentBefore = f.kernel.getIntent(approval.id)!;
  assert.equal(intentBefore.state, 'prepared');
  assert.equal(intentBefore.authorization?.decision, 'ask');
  assert.equal(intentBefore.toolCallId, CALL_ID, 'the linked approval retains the original provider tool call id');
  assert.equal(intentBefore.generation, taskBefore.generation, 'the linked approval is from the current generation');
  assert.equal(intentBefore.policyEpoch, taskBefore.policyEpoch, 'the linked approval is from the current policy epoch');
  assert.equal(taskBefore.status, 'waiting_approval');
  assert.equal(existsSync(path.join(f.workspace, FILE_NAME)), false, 'nothing may execute before the operator decision');
  assert.equal(f.wire.filter(isMainWorkRound).length, 1, 'the proposal must not auto-execute or add a follow-up model round');

  const messagesBefore = f.kernel.getMessages(taskId);
  // Restart invalidates the sampled authority. The mock must sample a new proposal, and the
  // Inspector must link its current ask intent while retaining the denied old call as history.
  await f.restart();
  const recovered = await f.until(() => f.approvals(taskId), value => value.length === 1 && value[0].id !== approval.id, 'recovery prepares a fresh approval', 90_000);
  assert.equal(f.kernel.getIntent(approval.id)!.state, 'denied', 'the pre-restart sampled proposal cannot be reused');
  const fresh = f.kernel.getIntent(recovered[0].id)!;
  assert.equal(fresh.state, 'prepared');
  assert.equal(fresh.authorization?.decision, 'ask');
  assert.equal(fresh.generation, f.kernel.getTask(taskId)!.generation);
  assert.ok(fresh.generation > intentBefore.generation);
  assert.notEqual(fresh.digest, intentBefore.digest);
  assert.equal(fresh.toolCallId, CALL_ID + '-recovered');
  assert.deepEqual(f.kernel.getMessages(taskId).slice(0, messagesBefore.length), messagesBefore, 'recovery preserves the exact prior conversation');
  const recoveredCall = (await f.until(
    () => f.inspectorCall(taskId, fresh.toolCallId),
    value => Boolean(value && value.status === 'awaiting_approval' && value.approvalId === recovered[0].id),
    'the recovered Inspector call links the restored approval',
    90_000,
  ))!;
  assert.equal(recoveredCall.approvalId, recovered[0].id);
  assert.notEqual(recoveredCall.id, call.id, 'the new Inspector call is not the historical proposal');
  assert.equal((await f.inspectorCall(taskId, intentBefore.toolCallId))!.approvalId, undefined);
  const staleGrant = await f.request('POST', '/v1/product/approvals/decide', { body: { approvalId: approval.id, approved: true, scope: 'once' } });
  assert.equal(staleGrant.status, 409, 'the previous process approval is no longer usable');
  assert.equal(f.kernel.getIntent(fresh.id)!.state, 'prepared');
  assert.equal(f.kernel.events(taskId).filter(event => event.type === 'intent.sent').length, 0);
  assert.equal(existsSync(path.join(f.workspace, FILE_NAME)), false, 'restart must never execute the pending effect');
  assert.equal(f.wire.filter(isMainWorkRound).length, 2, 'recovery samples exactly one new proposal under the current authority');

  const decided = await f.ok('POST', '/v1/product/approvals/decide', { approvalId: recovered[0].id, approved: true, scope: 'once' });
  assert.equal(decided.resolved, true);

  const settled = await f.until(() => f.task(taskId), value => Boolean(value) && !RUNNING.has(value.status) && value.status !== 'waiting_approval', 'the approved Work task settles', 90_000);
  assert.ok(TERMINAL_WORK.has(settled.status), 'the approved Work task must settle truthfully; got ' + settled.status);
  assert.equal(settled.status, 'completed', 'the deterministic fixture completes after the approved write');

  const finalCall = await f.until(() => f.inspectorCall(taskId, fresh.toolCallId), value => Boolean(value && value.status === 'succeeded'), 'the executed call reaches its final Inspector state');
  assert.equal(finalCall!.approvalId, undefined, 'a dispatched effect must not keep a clickable approval id');
  assert.ok(finalCall!.result, 'the Inspector exposes the real receipt/result');
  assert.deepEqual(await f.approvals(taskId), [], 'no pending approval remains after the decision');

  assert.equal(readFileSync(path.join(f.workspace, FILE_NAME), 'utf8'), FILE_TEXT, 'the approved write happened with the exact content');
  const toolMessages = f.kernel.getMessages(taskId).filter((message: any) => message.role === 'tool');
  assert.equal(toolMessages.length, 2, 'one explicit stale-proposal result plus one executed result');
  const staleResult = toolMessages.find(message => message.toolCallId === intentBefore.toolCallId)!;
  assert.equal(JSON.parse(staleResult.content).executed, false, 'the old proposal records no execution');
  assert.equal(toolMessages.filter(message => message.toolCallId === fresh.toolCallId).length, 1);
  const events = f.kernel.events(taskId);
  assert.equal(events.filter(event => event.type === 'intent.sent').length, 1, 'only the freshly approved effect can dispatch');
  assert.equal(events.filter((event: any) => event.type === 'intent.sent' && event.payload.intentId === recovered[0].id).length, 1, 'the intent was dispatched exactly once');
  assert.equal(events.filter((event: any) => event.type === 'effect.receipted' && event.payload.intentId === recovered[0].id).length, 1, 'exactly one effect receipt');
  const applied = f.kernel.getIntent(recovered[0].id)!;
  assert.equal(applied.state, 'applied');
  assert.ok(applied.receipt, 'the final intent carries its real receipt');
  assert.equal(f.wire.filter(isMainWorkRound).length, 3, 'initial proposal, recovery proposal, then exactly one follow-up after approval');

  const replay = await f.request('POST', '/v1/product/approvals/decide', { body: { approvalId: recovered[0].id, approved: true, scope: 'once' } });
  assert.equal(replay.status, 409, 'a second decision against the dispatched intent must be refused as stale');
});

test('Inspector never links an approval id to a denied, revoked or auto-reviewed effect', { timeout: 180_000 }, async t => {
  const f = await fixture(t, writeOnce);
  const file = path.join(f.workspace, FILE_NAME);

  // 1) Operator denial: the real pending id exists while prepared, then must disappear.
  const deniedTask = await f.startWork('ask');
  const deniedPending = await f.until(() => f.approvals(deniedTask), value => value.length === 1, 'denied fixture exposes one pending approval');
  const deniedBefore = await f.until(() => f.inspectorCall(deniedTask), value => Boolean(value), 'denied fixture lists the write');
  assert.equal(deniedBefore!.status, 'awaiting_approval');
  assert.equal(deniedBefore!.approvalId, deniedPending[0].id);
  await f.ok('POST', '/v1/product/approvals/decide', { approvalId: deniedPending[0].id, approved: false, scope: 'once' });
  const deniedCall = await f.until(() => f.inspectorCall(deniedTask), value => Boolean(value && value.status === 'denied'), 'the denied call reaches its Inspector state');
  assert.equal(deniedCall!.approvalId, undefined, 'a denied intent must not keep a clickable approval id');
  assert.deepEqual(await f.approvals(deniedTask), [], 'a denied intent is not pending');
  await f.until(() => f.task(deniedTask), value => Boolean(value) && !RUNNING.has(value.status) && value.status !== 'waiting_approval', 'the denied Work task settles');
  assert.equal(existsSync(file), false, 'the denied effect must never execute');

  // 2) Pause fences the prepared intent, bumps the generation and revokes the approval.
  const pausedTask = await f.startWork('ask');
  const pausedPending = await f.until(() => f.approvals(pausedTask), value => value.length === 1, 'pause fixture exposes one pending approval');
  const pausedBefore = await f.until(() => f.inspectorCall(pausedTask), value => Boolean(value), 'pause fixture lists the write');
  assert.equal(pausedBefore!.status, 'awaiting_approval');
  assert.equal(pausedBefore!.approvalId, pausedPending[0].id);
  const generationBefore = f.kernel.getTask(pausedTask)!.generation;
  assert.equal(f.kernel.getIntent(pausedPending[0].id)!.generation, generationBefore);
  const paused = await f.ok('POST', '/v1/product/tasks/' + encodeURIComponent(pausedTask) + '/control', { action: 'pause' });
  assert.equal(paused.status, 'paused');
  const pausedAfter = f.kernel.getTask(pausedTask)!;
  assert.ok(pausedAfter.generation > generationBefore, 'pause fences the old generation');
  assert.equal(f.kernel.getIntent(pausedPending[0].id)!.state, 'denied', 'the prepared approval was revoked by the fence');
  const pausedCall = await f.until(() => f.inspectorCall(pausedTask), value => Boolean(value && value.approvalId === undefined), 'the revoked call drops its approval id');
  assert.notEqual(pausedCall!.status, 'awaiting_approval');
  assert.deepEqual(await f.approvals(pausedTask), [], 'a revoked approval is not pending');
  assert.equal(existsSync(file), false, 'the revoked effect must never execute');

  // 3) Automatic review passes without a human: the effect executes, but no clickable approval exists.
  const settings = await f.ok('POST', '/v1/harness/settings', { autoReview: { reviewerModelId: 'default', escalateAt: 'critical' } });
  assert.equal(settings.autoReview.reviewerModelId, 'default');
  const autoTask = await f.startWork('auto-review');
  const autoSettled = await f.until(() => f.task(autoTask), value => Boolean(value) && TERMINAL_WORK.has(value.status), 'the auto-reviewed Work task settles', 90_000);
  assert.equal(autoSettled.status, 'completed');
  const autoCall = await f.until(() => f.inspectorCall(autoTask), value => Boolean(value && value.status === 'succeeded'), 'the auto-reviewed call succeeds');
  assert.equal(autoCall!.approvalId, undefined, 'an auto-reviewed decision must not expose a clickable approval id');
  assert.deepEqual(await f.approvals(autoTask), [], 'an auto-reviewed effect is never a pending approval');
  assert.equal(readFileSync(file, 'utf8'), FILE_TEXT, 'the auto-reviewed effect executed exactly once after its reviewer passed');
  const autoIntent = f.kernel.intents(autoTask).find((intent: any) => intent.toolCallId === CALL_ID)!;
  assert.equal(autoIntent.state, 'applied');
  assert.equal(autoIntent.authorization?.decision, 'review');
  assert.equal(autoIntent.authorization?.review?.verdict, 'pass');
  assert.equal(f.kernel.events(autoTask).filter((event: any) => event.type === 'intent.approved' && event.payload.source === 'operator').length, 0, 'no operator approval exists for an auto-reviewed effect');
});
