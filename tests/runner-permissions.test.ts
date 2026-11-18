import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBackend } from '../src/app/backend.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';

const systemOf = (body: any): string => String(body.messages?.find((message: any) => message.role === 'system')?.content ?? '');
const userOf = (body: any): string => String([...(body.messages ?? [])].reverse().find((message: any) => message.role === 'user')?.content ?? '');
const reviewerCall = (body: any): boolean => systemOf(body).includes('REVIEWER ROLE');
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const URL_A = 'https://example.com/review-resource-a';
const URL_B = 'https://example.com/review-resource-b';
const PASS_REVIEW = JSON.stringify({ verdict: 'pass', reason: 'Mock independent review passed.', checks: [{ label: 'artifact_matches_request', ok: true }] });

function scripted(): MockProviderOptions['responder'] {
  return async (body: any) => {
    const user = userOf(body);
    if (reviewerCall(body)) {
      if (user.includes('BLOCK_ME'))
        return { content: JSON.stringify({ verdict: 'block', reason: 'Blocked by the independent reviewer in this fixture.' }) };
      if (user.includes('BAD_REVIEW')) return { content: 'this is not the reviewer JSON contract' };
      // A terminated stream after the review request was recorded: a real provider/model error,
      // not a malformed verdict.
      if (user.includes('REVIEW_ERROR')) return { content: '', finishReason: 'length' };
      if (user.includes('CANCEL_REVIEW')) { await sleep(800); return { content: PASS_REVIEW }; }
      return { content: PASS_REVIEW };
    }
    const toolResults = (body.messages ?? []).filter((message: any) => message.role === 'tool').length;
    if (user.includes('SESSION_GRANT')) {
      if (toolResults === 0) return { content: '', toolCalls: [{ id: 'grant-one', name: 'write_file', arguments: { path: 'grant.txt', content: 'FIRST' } }] };
      // The first write creates an absent file. A repeated write needs a fresh real read,
      // even when permission comes from an otherwise matching session grant.
      if (toolResults === 1) return { content: '', toolCalls: [{ id: 'grant-reread', name: 'read_file', arguments: { path: 'grant.txt' } }] };
      if (toolResults === 2) return { content: '', toolCalls: [{ id: 'grant-two', name: 'write_file', arguments: { path: 'grant.txt', content: 'SECOND' } }] };
      return { content: 'Both session-granted writes were observed.' };
    }
    if (user.includes('BLOCK_ME')) {
      // This task reuses auto.txt created by the preceding task, so it must obtain
      // its own trusted read before the write can reach the independent reviewer.
      if (toolResults === 0) return { content: '', toolCalls: [{ id: 'blocked-read', name: 'read_file', arguments: { path: 'auto.txt' } }] };
      if (toolResults === 1) return { content: '', toolCalls: [{ id: 'blocked-write', name: 'write_file', arguments: { path: 'auto.txt', content: 'BLOCKED_OVERWRITE' } }] };
      return { content: 'Observed the real receipt.' };
    }
    if (user.includes('RESOURCE_GRANT')) {
      if (toolResults === 0) return { content: '', toolCalls: [{ id: 'web-one', name: 'web_fetch', arguments: { url: URL_A } }] };
      if (toolResults === 1) return { content: '', toolCalls: [{ id: 'web-two', name: 'web_fetch', arguments: { url: URL_A } }] };
      if (toolResults === 2) return { content: '', toolCalls: [{ id: 'web-three', name: 'web_fetch', arguments: { url: URL_B } }] };
      return { content: 'All resource grants were observed.' };
    }
    if (toolResults > 0) return { content: 'Observed the real receipt.' };
    return { content: '', toolCalls: [{ id: `write-${Math.random().toString(16).slice(2, 8)}`, name: 'write_file', arguments: { path: 'auto.txt', content: 'AUTO_REVIEW_EFFECT' } }] };
  };
}

async function fixture(t: import('node:test').TestContext, options: MockProviderOptions = {}) {
  const root = path.resolve(process.env.TEMP ?? '.tmp/module-02-integration/runner-permissions');
  mkdirSync(root, { recursive: true });
  const owned = mkdtempSync(path.join(root, 'runner-permissions-'));
  const workspace = path.join(owned, 'workspace');
  mkdirSync(workspace);
  const wire: any[] = [];
  const settings = { dataDir: path.join(owned, 'data'), projectRoot: process.cwd(), mockOptions: { ...options, trace: (body: any) => wire.push(body) } };
  const backend = await startBackend(settings);
  t.after(async () => { await backend.close(); rmSync(owned, { recursive: true, force: true }); });
  const call = async (method: string, route: string, input?: unknown, status = 200): Promise<any> => {
    const response = await fetch(`http://127.0.0.1:${backend.port}${route.startsWith('/v1') ? route : '/v1/harness' + route}`, {
      method, headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const until = async (read: () => Promise<any>, ready: (value: any) => boolean) => {
    const deadline = performance.now() + 20000; let value;
    do { value = await read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 25)); } while (performance.now() < deadline);
    assert.fail(`Did not settle: ${JSON.stringify(value)}`);
  };
  return {
    call, until, workspace, wire,
    get services() { return backend.services; },
    async createTask(parameters: Record<string, unknown>) {
      const created = await call('POST', '/v1/commands', { commandId: randomUUID(), type: 'create_task', parameters: { workspace, objective: 'Permission integration fixture', maxModelCalls: 20, ...parameters } });
      return created.taskId as string;
    },
    async snapshot(taskId: string) { return call('GET', `/v1/snapshot?taskId=${taskId}`); },
  };
}

const profile = (f: Awaited<ReturnType<typeof fixture>>, name: string) =>
  f.call('POST', '/profiles', { name, provider: { mode: 'mock', model: 'shared-reviewer-model', maxOutputTokens: 1024 } });
const configure = (f: Awaited<ReturnType<typeof fixture>>, reviewerModelId: string, escalateAt = 'critical') =>
  f.call('POST', '/settings', { autoReview: { reviewerModelId, escalateAt } });

test('auto-review resolves the exact profile id and records the actual review request as the tool review', { timeout: 40000 }, async t => {
  const f = await fixture(t, { responder: scripted() });
  const first = await profile(f, 'First shared model');
  const selected = await profile(f, 'Selected shared model');
  assert.notEqual(first.id, selected.id);
  assert.equal(first.provider.model, selected.provider.model, 'both profiles serve the same provider model name');
  await configure(f, selected.id);

  const configured = await f.call('GET', '/settings');
  assert.equal(configured.autoReview.reviewerModelId, selected.id, 'the saved frontend input is the exact profile id');
  assert.equal(configured.autoReview.profileId, selected.id, 'the profile id resolves only by exact identity');
  assert.equal(f.services.harness!.autoReview()?.reviewerModelId, 'shared-reviewer-model', 'reviewerModelId is the resolved provider model name used on the record');

  const taskId = await f.createTask({ objective: 'Write auto.txt under automatic review', permission: { mode: 'auto-review', app: 'work' } });
  const settled = await f.until(() => f.snapshot(taskId), value => value.selectedTask.status === 'completed');
  assert.equal(settled.intents[0].state, 'applied');
  assert.equal(existsSync(path.join(f.workspace, 'auto.txt')), true);

  const requests = await f.call('GET', `/requests?taskId=${taskId}`);
  const work = requests.requests.find((record: any) => record.kind === 'work');
  // The result verifier is also a review-kind model call on the executor profile; the tool review
  // is the request served by the exact selected reviewer profile.
  const toolReviews = requests.requests.filter((record: any) => record.kind === 'review' && record.profileId === selected.id);
  assert.ok(work, 'the work request is recorded');
  assert.equal(toolReviews.length, 1, 'exactly one tool review request ran on the selected profile');
  const review = toolReviews[0]!;
  assert.notEqual(review.id, work.id, 'the review request is a distinct identity from the proposing work request');
  assert.equal(review.parentId, work.id, 'the proposing work request is the review parent/cause');
  assert.equal(review.profileId, selected.id, 'the review request used the exact selected profile');
  assert.equal(review.status, 'completed');

  const detail = await f.call('GET', `/requests/${review.id}`);
  assert.deepEqual(detail.body.tools ?? [], [], 'the actual post-adapter review request exposes no tools');
  const reviewerWire = f.wire.find((body: any) => reviewerCall(body) && userOf(body).includes('"intent"') && !userOf(body).includes('proposedResult'));
  assert.ok(reviewerWire, 'the reviewer call is part of the real wire');
  assert.deepEqual(detail.body.messages, reviewerWire.messages, 'the recorded review request body is the exact reviewer wire body');
  assert.deepEqual(detail.body.tools ?? [], [], 'the reviewer wire body sends no tools');

  const tools = await f.call('GET', `/tools?taskId=${taskId}`);
  const write = tools.calls.find((record: any) => record.name === 'write_file');
  assert.equal(write.status, 'completed');
  assert.equal(write.review.verdict, 'pass');
  assert.equal(write.review.reviewerModelId, 'shared-reviewer-model');
  assert.equal(write.review.requestId, review.id, 'the tool record binds the actual review request');
  assert.notEqual(write.review.requestId, work.id, 'the tool record never binds the work request as its review');
  assert.equal(write.review.checks[0].ok, true);

  const trace = await f.call('GET', `/trace?taskId=${taskId}`);
  assert.ok(trace.events.some((event: any) => event.type === 'intent.reviewed' && event.payload?.verdict === 'pass'));
  assert.ok(trace.events.some((event: any) => event.requestId === review.id && event.type === 'request.started'), 'the actual review request is first-class in Trace');
  assert.ok(f.services.kernel.getBudgets(taskId).modelCalls > 0);
});

test('auto-review escalates at the threshold and blocks on a reviewer block', { timeout: 60000 }, async t => {
  const f = await fixture(t, { responder: scripted() });
  const selected = await profile(f, 'Selected shared model');
  await configure(f, selected.id, 'high');

  // At or above the escalation threshold a passing reviewer still waits for a human.
  const escalatedId = await f.createTask({ objective: 'Escalated write', permission: { mode: 'auto-review', app: 'work' } });
  const waiting = await f.until(() => f.snapshot(escalatedId), value => value.selectedTask.status === 'waiting_approval');
  const workRequest = (await f.call('GET', `/requests?taskId=${escalatedId}`)).requests.find((record: any) => record.kind === 'work');
  const pending = await f.call('GET', `/tools?requestId=${workRequest.id}`);
  assert.equal(pending.calls[0].review.verdict, 'escalate');
  assert.notEqual(pending.calls[0].review.requestId, workRequest.id, 'an escalated review still binds its own review request');
  const escalatedReview = (await f.call('GET', `/requests?taskId=${escalatedId}`)).requests.find((record: any) => record.kind === 'review');
  assert.equal(pending.calls[0].review.requestId, escalatedReview.id);
  assert.equal(existsSync(path.join(f.workspace, 'auto.txt')), false, 'nothing executes before human approval');
  await f.call('POST', `/tools/${pending.calls[0].id}/approve`, { digest: pending.calls[0].digest, approved: true });
  await f.until(() => f.snapshot(escalatedId), value => value.selectedTask.status === 'completed');
  assert.equal(existsSync(path.join(f.workspace, 'auto.txt')), true);
  assert.equal(f.services.kernel.getIntent(waiting.intents[0].id)!.authorization!.decision, 'ask', 'the escalated effect returned to the human ask path');

  // A reviewer block denies the effect and never writes.
  await configure(f, selected.id, 'critical');
  const blockedId = await f.createTask({ objective: 'BLOCK_ME then finish', permission: { mode: 'auto-review', app: 'work' } });
  await f.until(() => f.snapshot(blockedId), value => value.intents.some((intent: any) => intent.state === 'denied'));
  const blockedTools = await f.call('GET', `/tools?taskId=${blockedId}`);
  const blockedWrite = blockedTools.calls.find((record: any) => record.name === 'write_file');
  assert.equal(blockedWrite.review.verdict, 'block');
  const blockedTrace = await f.call('GET', `/trace?taskId=${blockedId}`);
  assert.ok(blockedTrace.events.some((event: any) => event.type === 'intent.review_blocked'));
  const blockedIntent = f.services.kernel.intents(blockedId).find(intent => intent.name === 'write_file')!;
  const readIntent = f.services.kernel.intents(blockedId).find(intent => intent.name === 'read_file')!;
  assert.equal(readIntent.state, 'applied', 'the second task obtained its own real read before review');
  assert.equal(blockedIntent.state, 'denied');
  assert.equal((blockedIntent.arguments.readVersion as { sourceIntentId: string }).sourceIntentId, readIntent.id);
  assert.ok(!blockedTrace.events.some((event: any) => event.payload?.intentId === blockedIntent.id && (event.type === 'intent.sent' || event.type === 'effect.receipted')), 'a reviewer block never dispatches the write effect');
  assert.equal(readFileSync(path.join(f.workspace, 'auto.txt'), 'utf8'), 'AUTO_REVIEW_EFFECT', 'reviewer refusal preserves the prior task output');
});

test('a model-name, unknown or empty selection never falls back to a different reviewer profile', { timeout: 60000 }, async t => {
  const f = await fixture(t, { responder: scripted() });
  await profile(f, 'First shared model');
  const selected = await profile(f, 'Selected shared model');
  assert.equal(selected.provider.model, 'shared-reviewer-model');
  for (const [label, reviewerModelId] of [['model name', 'shared-reviewer-model'], ['unknown profile', 'provider-00000000-0000-0000-0000-000000000000'], ['empty', '']]) {
    await configure(f, reviewerModelId);
    const taskId = await f.createTask({ objective: `${label} selection write`, permission: { mode: 'auto-review', app: 'work' } });
    const waiting = await f.until(() => f.snapshot(taskId), value => value.selectedTask.status === 'waiting_approval');
    assert.equal(waiting.intents[0].state, 'prepared', label);
    const requests = await f.call('GET', `/requests?taskId=${taskId}`);
    assert.equal(requests.requests.filter((record: any) => record.kind === 'review').length, 0, `${label}: no model request may fake a review`);
    const trace = await f.call('GET', `/trace?taskId=${taskId}`);
    const escalation = trace.events.find((event: any) => event.type === 'intent.review_escalated');
    assert.ok(escalation, label);
    assert.equal(escalation.payload.source, 'bridge');
    assert.match(escalation.payload.reason, /reviewer profile/, label);
    assert.ok(!trace.events.some((event: any) => event.type === 'intent.reviewed'), label);
  }
});

test('malformed reviewer output and a real provider failure both keep their review request associable', { timeout: 60000 }, async t => {
  const f = await fixture(t, { responder: scripted() });
  const selected = await profile(f, 'Selected shared model');
  await configure(f, selected.id);

  const badId = await f.createTask({ objective: 'BAD_REVIEW write', permission: { mode: 'auto-review', app: 'work' } });
  await f.until(() => f.snapshot(badId), value => value.selectedTask.status === 'waiting_approval');
  const badRequests = await f.call('GET', `/requests?taskId=${badId}`);
  const badWork = badRequests.requests.find((record: any) => record.kind === 'work');
  const badReviews = badRequests.requests.filter((record: any) => record.kind === 'review');
  assert.equal(badReviews.length, 1, 'the malformed verdict still came from one real review request');
  assert.equal(badReviews[0].status, 'completed');
  assert.equal(badReviews[0].parentId, badWork.id);
  assert.equal(badReviews[0].profileId, selected.id);
  const badTrace = await f.call('GET', `/trace?taskId=${badId}`);
  const badEscalations = badTrace.events.filter((event: any) => event.type === 'intent.review_escalated');
  assert.equal(badEscalations.length, 1, 'a degraded review escalates exactly once');
  assert.match(badEscalations[0].payload.reason, /invalid_response/);
  assert.ok(!badTrace.events.some((event: any) => event.type === 'intent.reviewed'));

  const errorId = await f.createTask({ objective: 'REVIEW_ERROR write', permission: { mode: 'auto-review', app: 'work' } });
  await f.until(() => f.snapshot(errorId), value => value.selectedTask.status === 'waiting_approval');
  const errorRequests = await f.call('GET', `/requests?taskId=${errorId}`);
  const errorWork = errorRequests.requests.find((record: any) => record.kind === 'work');
  const errorReviews = errorRequests.requests.filter((record: any) => record.kind === 'review');
  assert.equal(errorReviews.length, 1, 'the failed model call created a review request record');
  assert.equal(errorReviews[0].status, 'failed');
  assert.equal(errorReviews[0].kind, 'review');
  assert.equal(errorReviews[0].parentId, errorWork.id, 'the failed review request is still causally bound to the work request');
  assert.equal(errorReviews[0].profileId, selected.id);
  const errorTrace = await f.call('GET', `/trace?taskId=${errorId}`);
  const errorEscalation = errorTrace.events.find((event: any) => event.type === 'intent.review_escalated');
  assert.ok(errorEscalation);
  assert.match(errorEscalation.payload.reason, /model_error/);
  assert.ok(!errorTrace.events.some((event: any) => event.type === 'intent.reviewed'), 'a provider failure never becomes a verdict');
  assert.equal(existsSync(path.join(f.workspace, 'auto.txt')), false);
});

test('a review that cannot be paid for escalates with no reviewer request', { timeout: 40000 }, async t => {
  const f = await fixture(t, { responder: scripted() });
  const selected = await profile(f, 'Selected shared model');
  await configure(f, selected.id);
  const budgetId = await f.createTask({ objective: 'Budget-limited write', maxModelCalls: 1, permission: { mode: 'auto-review', app: 'work' } });
  await f.until(() => f.snapshot(budgetId), value => value.selectedTask.status === 'waiting_approval');
  const budgetTrace = await f.call('GET', `/trace?taskId=${budgetId}`);
  const budgetEscalation = budgetTrace.events.find((event: any) => event.type === 'intent.review_escalated');
  assert.ok(budgetEscalation);
  assert.match(budgetEscalation.payload.reason, /budget/);
  const budgetRequests = await f.call('GET', `/requests?taskId=${budgetId}`);
  assert.equal(budgetRequests.requests.filter((record: any) => record.kind === 'review').length, 0);
});

test('cancelling during review leaves no escalation, approval or execution for the old generation', { timeout: 40000 }, async t => {
  const f = await fixture(t, { responder: scripted() });
  const selected = await profile(f, 'Selected shared model');
  await configure(f, selected.id);
  const taskId = await f.createTask({ objective: 'CANCEL_REVIEW write', permission: { mode: 'auto-review', app: 'work' } });
  const running = await f.until(() => f.call('GET', `/requests?taskId=${taskId}`), value => value.requests.some((record: any) => record.kind === 'review' && record.status === 'running'));
  const review = running.requests.find((record: any) => record.kind === 'review' && record.status === 'running');
  const before = await f.snapshot(taskId);
  const pendingIntent = before.intents[0];
  await f.call('POST', '/v1/commands', { commandId: randomUUID(), type: 'cancel', taskId, expectedRevision: before.selectedTask.revision });
  await f.until(() => f.snapshot(taskId), value => value.selectedTask.status === 'cancelled');

  const trace = await f.call('GET', `/trace?taskId=${taskId}`);
  assert.ok(trace.events.some((event: any) => event.type === 'task.cancelled'));
  assert.ok(!trace.events.some((event: any) => event.type === 'intent.reviewed' || event.type === 'intent.approved' || event.type === 'effect.receipted'), 'cancellation never revives the old generation review');
  assert.ok(!trace.events.some((event: any) => event.type === 'intent.review_escalated'), 'a cancelled review is not escalated after the fact');
  assert.equal(existsSync(path.join(f.workspace, 'auto.txt')), false);
  const after = await f.snapshot(taskId);
  assert.equal(f.services.kernel.getIntent(pendingIntent.id)!.state, 'denied', 'cancellation fences the prepared intent of the old generation');
  let refusal: any;
  try { f.services.kernel.approve(pendingIntent.id, { source: 'operator' }); } catch (error) { refusal = error; }
  assert.equal(refusal?.code, 'STALE_GENERATION', 'the old generation can no longer be approved');
  const reviewAfter = (await f.call('GET', `/requests?taskId=${taskId}`)).requests.find((record: any) => record.id === review.id);
  assert.notEqual(reviewAfter.status, 'completed');
});

test('network approval carries the exact URL resource and a session grant covers only the same URL', { timeout: 60000 }, async t => {
  const f = await fixture(t, { responder: scripted() });
  // The external executor is stubbed: this test checks kernel resource identity and grants only,
  // and never dispatches a network request.
  (f.services.external as unknown as { execute: () => Promise<unknown> }).execute = async () => ({ status: 'applied', output: 'stub web result', receipt: { stub: true } });

  const taskId = await f.createTask({ objective: 'RESOURCE_GRANT reads', permission: { mode: 'ask', app: 'work' } });
  const first = await f.until(() => f.snapshot(taskId), value => value.selectedTask.status === 'waiting_approval');
  assert.deepEqual(first.intents[0].resources, [URL_A], 'the waiting intent retains the exact prepared URL');
  const firstIntent = f.services.kernel.getIntent(first.intents[0].id)!;
  assert.equal(firstIntent.authorization!.capability, 'network');

  const work = (await f.call('GET', `/requests?taskId=${taskId}`)).requests.find((record: any) => record.kind === 'work');
  const pending = await f.call('GET', `/tools?requestId=${work.id}`);
  const firstTool = pending.calls.find((record: any) => record.intentId === first.intents[0].id);
  await f.call('POST', `/tools/${firstTool.id}/approve`, { digest: firstTool.digest, approved: true, scope: 'session' });

  const granted = await f.until(() => f.snapshot(taskId), value => value.intents.length === 3 && value.intents[2].state === 'prepared');
  const grants = f.services.kernel.sessionGrants(taskId);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].tool, 'web_fetch');
  assert.deepEqual(grants[0].resources, [URL_A], 'the session grant is bound to the exact URL');
  assert.deepEqual(granted.intents[0].resources, [URL_A]);
  assert.deepEqual(granted.intents[1].resources, [URL_A]);
  assert.deepEqual(granted.intents[2].resources, [URL_B], 'a different URL keeps its own resource identity');
  assert.equal(granted.intents[1].state, 'applied', 'the same tool and URL reused the session grant');
  assert.equal(f.services.kernel.getIntent(granted.intents[1].id)!.authorization!.grantId, grants[0].id);
  assert.equal(granted.intents[2].state, 'prepared');
  const thirdIntent = f.services.kernel.getIntent(granted.intents[2].id)!;
  assert.equal(thirdIntent.authorization!.decision, 'ask');
  assert.equal(thirdIntent.authorization!.grantId, undefined, 'a different URL cannot reuse the grant');
  assert.equal(granted.selectedTask.status, 'waiting_approval');
});

test('read-only denies a registered write with a permission-stage result and no approvable intent', { timeout: 40000 }, async t => {
  const f = await fixture(t, { responder: scripted() });
  const taskId = await f.createTask({ objective: 'Read-only write attempt', permission: { mode: 'read-only', app: 'work' } });
  const finished = await f.until(() => f.snapshot(taskId), value => ['completed', 'waiting_input', 'failed'].includes(value.selectedTask.status));
  assert.notEqual(finished.selectedTask.status, 'failed', 'a policy denial is a tool result, not a task crash');
  assert.equal(finished.intents.length, 0, 'read-only denials never create an approvable intent');
  assert.equal(existsSync(path.join(f.workspace, 'auto.txt')), false);
  const work = (await f.call('GET', `/requests?taskId=${taskId}`)).requests.find((record: any) => record.kind === 'work');
  const tools = await f.call('GET', `/tools?requestId=${work.id}`);
  assert.equal(tools.calls[0].status, 'failed');
  assert.equal(tools.calls[0].failureStage, 'permission');
  const trace = await f.call('GET', `/trace?taskId=${taskId}`);
  assert.ok(trace.events.some((event: any) => event.type === 'tool.execution' && event.payload?.patch?.failureStage === 'permission'));
  assert.ok(!trace.events.some((event: any) => event.type === 'intent.prepared'));
});

test('operator mode switches fence the subtree, invalidate pending approvals and interrupt the active run', { timeout: 40000 }, async t => {
  const f = await fixture(t, { responder: scripted() });
  const taskId = await f.createTask({ objective: 'Ask then tighten', permission: { mode: 'ask', app: 'work' } });
  const waiting = await f.until(() => f.snapshot(taskId), value => value.selectedTask.status === 'waiting_approval');
  const staleIntent = waiting.intents[0];
  assert.equal(staleIntent.state, 'prepared');
  await f.call('POST', '/v1/commands', { commandId: randomUUID(), type: 'set_permission', taskId, expectedRevision: waiting.selectedTask.revision, parameters: { permissionMode: 'read-only' } });
  // The old approval can no longer authorize the pending effect.
  const stale = await f.call('POST', '/v1/commands', { commandId: randomUUID(), type: 'grant', taskId, expectedRevision: (await f.snapshot(taskId)).selectedTask.revision, parameters: { intentId: staleIntent.id, digest: staleIntent.digest, generation: staleIntent.generation, policyEpoch: staleIntent.policyEpoch } }, 409);
  assert.match(String(stale.code ?? stale.error), /STALE|DENIED|NOT|INVALID|REVISION_CONFLICT/i);
  const settled = await f.until(() => f.snapshot(taskId), value => ['completed', 'waiting_input', 'failed'].includes(value.selectedTask.status));
  assert.equal(settled.selectedTask.permissionMode, 'read-only');
  assert.equal(existsSync(path.join(f.workspace, 'auto.txt')), false, 'the downgraded tree never executes the write');
  assert.equal(f.services.kernel.sessionGrants(taskId).length, 0);
  const trace = await f.call('GET', `/trace?taskId=${taskId}`);
  assert.ok(trace.events.some((event: any) => event.type === 'permission.changed' && event.payload?.permissionMode === 'read-only'));
});

test('session approval is scoped to the exact tool, resources and mode and covers only repeated matching effects', { timeout: 40000 }, async t => {
  const f = await fixture(t, { responder: scripted() });
  const taskId = await f.createTask({ objective: 'SESSION_GRANT writes', permission: { mode: 'ask', app: 'work' } });
  const waiting = await f.until(() => f.snapshot(taskId), value => value.selectedTask.status === 'waiting_approval');
  const work = (await f.call('GET', `/requests?taskId=${taskId}`)).requests.find((record: any) => record.kind === 'work');
  const pending = await f.call('GET', `/tools?requestId=${work.id}`);
  const first = pending.calls.find((record: any) => record.status === 'awaiting_approval');
  await f.call('POST', `/tools/${first.id}/approve`, { digest: first.digest, approved: true, scope: 'session' });
  await f.until(() => f.snapshot(taskId), value => value.selectedTask.status === 'completed');
  const grants = f.services.kernel.sessionGrants(taskId);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].tool, 'write_file');
  assert.equal(grants[0].mode, 'ask');
  const tools = await f.call('GET', `/tools?taskId=${taskId}`);
  const writes = tools.calls.filter((record: any) => record.name === 'write_file');
  assert.equal(writes.length, 2, 'the second matching write ran under the session grant');
  assert.ok(writes.every((record: any) => record.status === 'completed'));
  const intents = f.services.kernel.intents(taskId), writeIntents = intents.filter(intent => intent.name === 'write_file');
  const reread = intents.find(intent => intent.name === 'read_file')!;
  assert.equal(reread.state, 'applied');
  assert.equal(reread.receipt?.output, 'FIRST', 'the reread consumed the actual first write, not the original absence');
  assert.equal((writeIntents[1]!.arguments.readVersion as { sourceIntentId: string }).sourceIntentId, reread.id);
  assert.equal(writeIntents[1]!.authorization?.grantId, grants[0].id, 'the second write uses the same real session grant');
  assert.deepEqual(grants[0].resources, writeIntents[0]!.resources, 'the grant keeps the exact prepared file resource');
  assert.deepEqual(writeIntents[1]!.resources, writeIntents[0]!.resources);
  assert.equal(readFileSync(path.join(f.workspace, 'grant.txt'), 'utf8'), 'SECOND');
  assert.equal((await f.call('POST', '/settings', { autoReview: { reviewerModelId: 'x', escalateAt: 'nope' } }, 400)).code !== undefined, true);
  const trace = await f.call('GET', `/trace?taskId=${taskId}`);
  assert.equal(trace.events.filter((event: any) => event.type === 'permission.granted').length, 1, 'a session grant is recorded once');
});


/**
 * A gated reviewer proves the operator-decision race: the tool review is held open until the test
 * denies the intent through the real operator command, then the reviewer finishes late.
 */
function gatedReview(outcome: 'pass' | 'malformed' | 'model_error'): { responder: MockProviderOptions['responder']; release: () => void; started: () => boolean } {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  const responder: MockProviderOptions['responder'] = async (body: any) => {
    if (reviewerCall(body)) {
      // The tool review is the request that carries the proposed intent; the final task
      // verification only carries proposedResult and must not be gated here.
      if (userOf(body).includes('"intent"')) {
        started = true;
        await gate;
        if (outcome === 'model_error') return { content: '', finishReason: 'length' };
        return { content: outcome === 'pass' ? PASS_REVIEW : 'not the reviewer JSON contract' };
      }
      return { content: PASS_REVIEW };
    }
    if ((body.messages ?? []).some((message: any) => message.role === 'tool')) {
      return { content: '', toolCalls: [{ id: 'ask-after-denial', name: 'ask_user', arguments: { question: 'Operator rejected that write; what next?' } }] };
    }
    return { content: '', toolCalls: [{ id: 'race-write', name: 'write_file', arguments: { path: 'never-created.txt', content: 'forbidden after denial' } }] };
  };
  return { responder, release: () => release(), started: () => started };
}

for (const outcome of ['pass', 'malformed', 'model_error'] as const) {
  test(`an operator denial during a ${outcome} review remains a tool result and the task continues`, { timeout: 30000 }, async t => {
    const gated = gatedReview(outcome);
    const f = await fixture(t, { responder: gated.responder });
    const selected = await profile(f, 'Selected shared model');
    await configure(f, selected.id);
    const taskId = await f.createTask({ objective: `Operator denial race ${outcome}`, permission: { mode: 'auto-review', app: 'work' } });

    const before = await f.until(async () => {
      const state = await f.snapshot(taskId);
      return gated.started() && state.intents.length ? state : undefined;
    }, value => Boolean(value));
    const intent = before.intents[0];
    assert.equal(intent.state, 'prepared', 'the review starts while the intent is still awaiting authority');
    await f.call('POST', '/v1/commands', {
      commandId: randomUUID(), type: 'deny', taskId, expectedRevision: before.selectedTask.revision,
      parameters: { intentId: intent.id, digest: intent.digest, generation: intent.generation, policyEpoch: intent.policyEpoch },
    });
    gated.release();

    const after = await f.until(() => f.snapshot(taskId), value => ['waiting_input', 'failed'].includes(value.selectedTask.status));
    assert.equal(after.selectedTask.status, 'waiting_input', 'a legitimate operator denial must become a tool result, never a failed task');
    assert.equal(after.intents[0].state, 'denied', 'the operator denial stands');
    assert.equal(existsSync(path.join(f.workspace, 'never-created.txt')), false, 'the denied effect never executes');

    const trace = await f.call('GET', `/trace?taskId=${taskId}`);
    assert.ok(trace.events.some((event: any) => event.type === 'intent.denied'));
    for (const rejected of ['intent.approved', 'intent.reviewed', 'intent.review_escalated', 'effect.receipted', 'diagnostic.error'])
      assert.ok(!trace.events.some((event: any) => event.type === rejected), `${rejected} must not be recorded after the denial`);

    const tools = await f.call('GET', `/tools?taskId=${taskId}`);
    const write = tools.calls.find((record: any) => record.name === 'write_file');
    assert.equal(write.status, 'denied');
    assert.match(String(write.result), /denied/i, 'the model receives the denial as its tool result');
    const reviewRequest = (await f.call('GET', `/requests?taskId=${taskId}`)).requests.find((record: any) => record.kind === 'review' && record.profileId === selected.id);
    assert.ok(reviewRequest, 'the late review request remains auditable');
    assert.ok(['completed', 'failed'].includes(reviewRequest.status), 'the reviewer finished after the denial');
  });
}
