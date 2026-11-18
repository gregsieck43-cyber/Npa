import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Kernel } from '../src/kernel/index.js';
import type { Intent, ToolReviewRecord } from '../src/contracts.js';

/**
 * Review history is audit evidence, not executable authority. These regressions pin the two
 * moments where the authority is deliberately revoked (process restart and rebind) while the
 * durable event log must still identify the actual review Request and reviewer model for each
 * proposed tool, including when one work request proposes several tools.
 */
interface ReviewHistoryFixture {
  owned: string;
  dataDir: string;
  kernel: Kernel;
  reopen(): Kernel;
}

function fixture(t: import('node:test').TestContext): ReviewHistoryFixture {
  const root = path.resolve(process.env.TEMP ?? '.tmp/module-02-final-race/root/tests');
  mkdirSync(root, { recursive: true });
  const owned = mkdtempSync(path.join(root, 'review-history-'));
  const dataDir = path.join(owned, 'data');
  let kernel = new Kernel(dataDir);
  t.after(() => {
    kernel.close();
    rmSync(owned, { recursive: true, force: true });
  });
  return {
    owned, dataDir,
    get kernel() { return kernel; },
    reopen() { kernel.close(); kernel = new Kernel(dataDir); return kernel; },
  };
}

function reviewedIntent(kernel: Kernel, owned: string): { taskId: string; runId: string; intent: Intent } {
  const ack = kernel.command({
    commandId: randomUUID(), origin: 'operator', type: 'create_task',
    parameters: { workspace: path.join(owned, 'workspace'), title: 'Review history fixture', permissionMode: 'auto-review', appMode: 'work' },
  });
  if (!ack.taskId) throw new Error('create_task did not return a task id');
  const taskId = ack.taskId;
  const run = kernel.createRun(taskId);
  kernel.transition(taskId, 'running');
  const intent = kernel.prepareIntent(taskId, run.id, { id: randomUUID(), name: 'write_file', arguments: { path: 'never-written.txt', content: 'fixture' } });
  return { taskId, runId: run.id, intent };
}

function review(requestId: string, verdict: 'pass' | 'escalate'): ToolReviewRecord {
  return {
    verdict, reviewer: 'independent-reviewer', reviewerModelId: 'fixture-reviewer-model', requestId,
    risk: 'high', reason: 'Distinct review Request tied to this exact proposed tool.', checks: [], durationMs: 1,
  };
}

function reviewEvents(kernel: Kernel, taskId: string, intentId: string) {
  return kernel.events(taskId).filter(event =>
    event.payload.intentId === intentId && ['intent.reviewed', 'intent.review_escalated'].includes(event.type));
}

for (const verdict of ['pass', 'escalate'] as const) {
  test(`a ${verdict} review keeps its actual Request and reviewer identity after restart strips its authority`, t => {
    const f = fixture(t);
    const { taskId, intent } = reviewedIntent(f.kernel, f.owned);
    const requestId = `actual-review-request-${randomUUID()}`;
    f.kernel.recordToolReview(intent.id, review(requestId, verdict));

    const recorded = reviewEvents(f.kernel, taskId, intent.id);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.payload.requestId, requestId, 'the durable event names the actual review Request');
    assert.equal(recorded[0]!.payload.reviewerModelId, 'fixture-reviewer-model');

    const reopened = f.reopen();
    assert.equal(reopened.getIntent(intent.id)!.authorization!.review, undefined, 'restart still strips executable review authority');
    // A pass needs a matching REVIEW_REQUIRED rejection; an escalated review already returned the
    // decision to the human ask path, so its operator-only rejection is equally non-executable.
    assert.throws(() => reopened.approve(intent.id, { source: 'review' }), (error: any) => ['REVIEW_REQUIRED', 'OPERATOR_APPROVAL_REQUIRED'].includes(error.code));
    const historical = reviewEvents(reopened, taskId, intent.id);
    assert.equal(historical.length, 1);
    assert.equal(historical[0]!.payload.requestId, requestId, 'history remains associable after the authority row is cleared');
    assert.equal(historical[0]!.payload.reviewerModelId, 'fixture-reviewer-model');
  });
}

test('two tools proposed by one work request keep separate review Request links after restart', t => {
  const f = fixture(t);
  const { taskId, runId, intent } = reviewedIntent(f.kernel, f.owned);
  const second = f.kernel.prepareIntent(taskId, runId, { id: randomUUID(), name: 'write_file', arguments: { path: 'second-never-written.txt', content: 'fixture' } });
  const firstRequest = `actual-review-request-${randomUUID()}`;
  const secondRequest = `actual-review-request-${randomUUID()}`;
  f.kernel.recordToolReview(intent.id, review(firstRequest, 'pass'));
  f.kernel.recordToolReview(second.id, review(secondRequest, 'pass'));

  const reopened = f.reopen();
  const links = [intent.id, second.id].map(intentId => reviewEvents(reopened, taskId, intentId));
  assert.deepEqual(links.map(events => events.length), [1, 1]);
  assert.notEqual(links[0]![0]!.payload.requestId, links[1]![0]!.payload.requestId, 'each proposed tool keeps its own review Request');
  assert.equal(links[0]![0]!.payload.requestId, firstRequest);
  assert.equal(links[1]![0]!.payload.requestId, secondRequest);
});

test('rebinding a reviewed intent drops executable authority without losing the historical Request link', t => {
  const f = fixture(t);
  const { taskId, runId, intent } = reviewedIntent(f.kernel, f.owned);
  const requestId = `actual-review-request-${randomUUID()}`;
  f.kernel.recordToolReview(intent.id, review(requestId, 'pass'));

  f.kernel.finishRun(runId, 'cancelled');
  const reboundRun = f.kernel.createRun(taskId);
  const rebound = f.kernel.rebindIntent(intent.id, reboundRun.id);
  assert.equal(rebound.authorization!.review, undefined, 'a rebound artifact never carries the old review');
  assert.equal(rebound.runId, reboundRun.id);
  assert.throws(() => f.kernel.approve(intent.id, { source: 'review' }), (error: any) => error.code === 'REVIEW_REQUIRED');

  const historical = reviewEvents(f.kernel, taskId, intent.id);
  assert.equal(historical.length, 1);
  assert.equal(historical[0]!.payload.requestId, requestId, 'the pre-rebind review Request stays identifiable');
  const reboundEvent = f.kernel.events(taskId).find(event => event.type === 'intent.rebound' && event.payload.intentId === intent.id);
  assert.ok(reboundEvent);
  assert.equal((reboundEvent.payload.previous as Intent).authorization!.review!.requestId, requestId, 'the rebind audit retains the authority it revoked');
});
