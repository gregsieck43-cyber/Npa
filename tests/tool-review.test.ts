import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelResult, ToolDefinition, WireMessage } from '../src/contracts.js';
import {
  createToolReviewer,
  type ReviewRisk,
  type ToolReviewClient,
  type ToolReviewOptions,
  type ToolReviewRequest,
} from '../src/runtime/tool-review.js';

interface CapturedCall { messages: WireMessage[]; tools: ToolDefinition[]; signal?: AbortSignal }
type Complete = (messages: WireMessage[], tools: ToolDefinition[], signal?: AbortSignal) => Promise<ModelResult>;

/** Fake ModelClient that records the exact review request and never touches the network. */
function stub(complete: Complete) {
  const calls: CapturedCall[] = [];
  const client: ToolReviewClient = {
    complete: (messages: WireMessage[], tools: ToolDefinition[] = [], signal?: AbortSignal): Promise<ModelResult> => {
      calls.push({ messages, tools, signal });
      return complete(messages, tools, signal);
    },
  };
  return { client, calls };
}

const modelResult = (content: string, extra: Partial<ModelResult> = {}): ModelResult =>
  ({ content, toolCalls: [], finishReason: 'stop', ...extra });

const verdictJson = (verdict: string, reason = 'bounded', checks: unknown[] = []): string =>
  JSON.stringify({ verdict, reason, checks });

const reviewRequest = (overrides: Partial<ToolReviewRequest> = {}): ToolReviewRequest => ({
  taskId: 'task-1',
  goal: { objective: 'Add the bounded reviewer', constraints: ['stay inside the workspace'], acceptance: ['tests pass'], mode: 'collaborative' },
  intent: { name: 'write_file', arguments: { path: 'src/a.ts', content: 'export {};' }, digest: 'digest-1', generation: 2, policyEpoch: 3 },
  capability: 'workspace.write',
  risk: 'low',
  resources: ['src/a.ts'],
  ...overrides,
});

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

test('a valid low-risk pass keeps the trusted reviewer, risk and duration', async () => {
  const { client, calls } = stub(async () => modelResult(verdictJson('pass', 'bounded write', [{ label: 'scope', ok: true }])));
  const reviewer = createToolReviewer({ client, reviewer: 'reviewer-model', escalateAt: 'high' });
  const outcome = await reviewer.review(reviewRequest());

  assert.equal(outcome.verdict, 'pass');
  assert.equal(outcome.degraded, undefined);
  assert.equal(outcome.reviewer, 'reviewer-model');
  assert.equal(outcome.risk, 'low');
  assert.ok(Number.isFinite(outcome.durationMs));
  assert.ok(outcome.durationMs >= 0);
  assert.deepEqual(outcome.checks, [{ label: 'scope', ok: true }]);

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.deepEqual(call.tools, []);
  assert.equal(call.messages.length, 2);
  assert.equal(call.messages[0]!.role, 'system');
  assert.match(String(call.messages[0]!.content), /REVIEWER ROLE/);
  assert.equal(call.messages[1]!.role, 'user');
  const payload = JSON.parse(String(call.messages[1]!.content));
  assert.equal(payload.intent.name, 'write_file');
  assert.equal(payload.intent.digest, 'digest-1');
  assert.equal(payload.capability, 'workspace.write');
  assert.equal(payload.risk, 'low');
  assert.deepEqual(payload.arguments, { path: 'src/a.ts', content: 'export {};' });
  assert.deepEqual(payload.resources, ['src/a.ts']);
  assert.equal(payload.escalationThreshold, 'high');
});

test('consume runs exactly once, after preflight checks and before the model call', async () => {
  const events: string[] = [];
  let consumptions = 0;
  const { client } = stub(async () => {
    events.push('complete after ' + consumptions + ' consumption(s)');
    return modelResult(verdictJson('pass'));
  });
  const outcome = await createToolReviewer({
    client, reviewer: 'reviewer-model', escalateAt: 'high',
    consume: () => { consumptions += 1; events.push('consume'); },
  }).review(reviewRequest());

  assert.equal(outcome.verdict, 'pass');
  assert.equal(consumptions, 1);
  assert.deepEqual(events, ['consume', 'complete after 1 consumption(s)']);
});

test('a throwing consume escalates with budget, is attempted once and never reaches the model', async () => {
  let consumptions = 0;
  const { client, calls } = stub(async () => modelResult(verdictJson('pass')));
  const outcome = await createToolReviewer({
    client, reviewer: 'reviewer-model', escalateAt: 'high',
    consume: () => { consumptions += 1; throw new Error('model budget exhausted'); },
  }).review(reviewRequest());

  assert.equal(outcome.verdict, 'escalate');
  assert.equal(outcome.degraded, 'budget');
  assert.match(outcome.reason, /model budget exhausted/);
  assert.equal(consumptions, 1);
  assert.equal(calls.length, 0);
});

test('escalate and block verdicts pass through unchanged and are never rewritten by the threshold', async () => {
  for (const verdict of ['escalate', 'block'] as const) {
    const { client } = stub(async () => modelResult(verdictJson(verdict, verdict + ' because policy')));
    const outcome = await createToolReviewer({ client, reviewer: 'reviewer-model', escalateAt: 'high' })
      .review(reviewRequest({ risk: 'critical' }));
    assert.equal(outcome.verdict, verdict);
    assert.equal(outcome.reason, verdict + ' because policy');
    assert.equal(outcome.degraded, undefined);
  }
});

test('invalid JSON escalates with invalid_response instead of a pass', async () => {
  const { client } = stub(async () => modelResult('This tool call looks perfectly fine to me.'));
  const outcome = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'high' }).review(reviewRequest());
  assert.equal(outcome.verdict, 'escalate');
  assert.equal(outcome.degraded, 'invalid_response');
  assert.match(outcome.reason, /not valid JSON/);
});

test('a malformed verdict, reason or checks shape escalates with invalid_response', async () => {
  const malformed = [
    '[{"verdict":"pass","reason":"ok","checks":[]}]',
    verdictJson('maybe', 'ok'),
    JSON.stringify({ verdict: 'pass', reason: '   ', checks: [] }),
    JSON.stringify({ verdict: 'pass', reason: 5, checks: [] }),
    JSON.stringify({ verdict: 'pass', reason: 'ok', checks: 'nope' }),
    JSON.stringify({ verdict: 'pass', reason: 'ok', checks: [{ label: 7, ok: true }] }),
    JSON.stringify({ verdict: 'pass', reason: 'ok', checks: [{ label: 'scope', ok: 'yes' }] }),
    JSON.stringify({ verdict: 'pass', reason: 'ok', checks: [1] }),
  ];
  for (const content of malformed) {
    const { client } = stub(async () => modelResult(content));
    const outcome = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'high' }).review(reviewRequest());
    assert.equal(outcome.verdict, 'escalate', content);
    assert.equal(outcome.degraded, 'invalid_response', content);
  }
});

test('a thrown reviewer call escalates with a sanitized model_error', async () => {
  const { client } = stub(async () => {
    throw Object.assign(new Error('provider exploded'), { name: 'ModelDiagnosticError' });
  });
  const outcome = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'high' }).review(reviewRequest());
  assert.equal(outcome.verdict, 'escalate');
  assert.equal(outcome.degraded, 'model_error');
  assert.match(outcome.reason, /ModelDiagnosticError/);
  assert.match(outcome.reason, /provider exploded/);
});

test('a reviewer that ignores cancellation and never settles returns on timeoutMs without hanging', async () => {
  const { client } = stub(() => new Promise<ModelResult>(() => {}));
  const started = performance.now();
  const outcome = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'high', timeoutMs: 25 })
    .review(reviewRequest());
  const elapsed = performance.now() - started;
  assert.equal(outcome.verdict, 'escalate');
  assert.equal(outcome.degraded, 'timeout');
  assert.ok(elapsed >= 20, 'the local deadline actually elapsed');
  assert.ok(elapsed < 500, 'the reviewer returned on its own deadline instead of hanging');
});

test('a reviewer that ignores its signal is cut off by the local timeout', async () => {
  const { client } = stub(async () => {
    await delay(200);
    return modelResult(verdictJson('pass'));
  });
  const outcome = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'high', timeoutMs: 10 })
    .review(reviewRequest());
  assert.equal(outcome.verdict, 'escalate');
  assert.equal(outcome.degraded, 'timeout');
  assert.ok(outcome.durationMs < 100, 'the reviewer returned on its own deadline');
});

test('a late rejection from an abandoned reviewer request surfaces no unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    const { client } = stub(() => new Promise<ModelResult>((_, reject) => {
      setTimeout(() => reject(new Error('late provider failure')), 60);
    }));
    const outcome = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'high', timeoutMs: 20 })
      .review(reviewRequest());
    assert.equal(outcome.verdict, 'escalate');
    assert.equal(outcome.degraded, 'timeout');
    await delay(80);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('caller cancellation escalates with cancelled and stops the review', async () => {
  const { client, calls } = stub(() => new Promise<ModelResult>(() => {}));
  const controller = new AbortController();
  const pending = createToolReviewer({ client, reviewer: 'r', escalateAt: 'high' })
    .review(reviewRequest({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 10);
  const outcome = await pending;
  assert.equal(outcome.verdict, 'escalate');
  assert.equal(outcome.degraded, 'cancelled');
  assert.equal(calls.length, 1);
});

test('an already-aborted caller signal never consumes the budget or reaches the model', async () => {
  const { client, calls } = stub(async () => modelResult(verdictJson('pass')));
  let consumptions = 0;
  const controller = new AbortController();
  controller.abort();
  const outcome = await createToolReviewer({
    client, reviewer: 'r', escalateAt: 'high', consume: () => { consumptions += 1; },
  }).review(reviewRequest({ signal: controller.signal }));
  assert.equal(outcome.verdict, 'escalate');
  assert.equal(outcome.degraded, 'cancelled');
  assert.equal(consumptions, 0);
  assert.equal(calls.length, 0);
});

test('a large artifact below the input limit reaches the reviewer in full', async () => {
  const { client, calls } = stub(async () => modelResult(verdictJson('pass')));
  const payload = 'x'.repeat(8_000);
  const request = reviewRequest();
  request.intent.arguments = { payload };
  const outcome = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'high' }).review(request);
  assert.equal(outcome.verdict, 'pass');
  const sent = JSON.parse(String(calls[0]!.messages[1]!.content));
  assert.equal(sent.arguments.payload, payload);
});

test('an oversized artifact escalates with artifact_too_large, is never truncated into a pass and consumes no budget', async () => {
  const { client, calls } = stub(async () => modelResult(verdictJson('pass')));
  let consumptions = 0;
  const oversized = reviewRequest();
  oversized.intent.arguments = { payload: 'x'.repeat(1_000_000) };
  const outcome = await createToolReviewer({
    client, reviewer: 'r', escalateAt: 'high', consume: () => { consumptions += 1; },
  }).review(oversized);
  assert.equal(outcome.verdict, 'escalate');
  assert.equal(outcome.degraded, 'artifact_too_large');
  assert.equal(consumptions, 0);
  assert.equal(calls.length, 0);
});

test('an unserializable artifact escalates without consuming the budget or reaching the model', async () => {
  const { client, calls } = stub(async () => modelResult(verdictJson('pass')));
  let consumptions = 0;
  const circular: Record<string, unknown> = { name: 'loop' };
  circular.self = circular;
  const request = reviewRequest();
  request.intent.arguments = circular;
  const outcome = await createToolReviewer({
    client, reviewer: 'r', escalateAt: 'high', consume: () => { consumptions += 1; },
  }).review(request);
  assert.equal(outcome.verdict, 'escalate');
  assert.equal(outcome.degraded, 'invalid_response');
  assert.match(outcome.reason, /could not be serialized/);
  assert.equal(consumptions, 0);
  assert.equal(calls.length, 0);
});

test('a pass at or above the escalation threshold becomes an escalate with the threshold reason', async () => {
  const { client } = stub(async () => modelResult(verdictJson('pass', 'all checks passed')));
  const outcome = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'high' })
    .review(reviewRequest({ risk: 'high' }));
  assert.equal(outcome.verdict, 'escalate');
  assert.equal(outcome.degraded, undefined);
  assert.match(outcome.reason, /at or above the configured escalation threshold high/);
  assert.match(outcome.reason, /all checks passed/);
});

test('a pass below the escalation threshold stays a pass', async () => {
  const { client } = stub(async () => modelResult(verdictJson('pass')));
  const outcome = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'critical' })
    .review(reviewRequest({ risk: 'high' }));
  assert.equal(outcome.verdict, 'pass');
  assert.equal(outcome.degraded, undefined);
});

test('an over-long reviewer output is rejected before parsing and cannot pass', async () => {
  const content = verdictJson('pass', 'ok') + ' '.repeat(300);
  const { client } = stub(async () => modelResult(content));
  const outcome = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'high', maxOutputChars: 100 })
    .review(reviewRequest());
  assert.equal(outcome.verdict, 'escalate');
  assert.equal(outcome.degraded, 'invalid_response');
  assert.match(outcome.reason, /truncated/);
});

test('reviewer tool calls are never accepted as a verdict', async () => {
  const { client } = stub(async () => modelResult(verdictJson('pass'), {
    toolCalls: [{ id: 'call-1', name: 'write_file', arguments: { path: 'src/a.ts', content: 'export {};' } }],
  }));
  const outcome = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'high' }).review(reviewRequest());
  assert.equal(outcome.verdict, 'escalate');
  assert.equal(outcome.degraded, 'invalid_response');
  assert.match(outcome.reason, /tool calls/);
});

test('a blank reviewer response escalates instead of passing', async () => {
  const { client } = stub(async () => modelResult('   \n  '));
  const outcome = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'high' }).review(reviewRequest());
  assert.equal(outcome.verdict, 'escalate');
  assert.equal(outcome.degraded, 'invalid_response');
  assert.match(outcome.reason, /empty response/);
});

test('reason and checks are bounded to the contract limits', async () => {
  const checks = Array.from({ length: 25 }, (_, index) => ({ label: 'c'.repeat(500) + index, ok: true }));
  const { client } = stub(async () => modelResult(verdictJson('escalate', 'r'.repeat(5_000), checks)));
  const outcome = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'high', maxOutputChars: 20_000 }).review(reviewRequest());
  assert.equal(outcome.reason.length, 1_000);
  assert.equal(outcome.checks.length, 20);
  for (const check of outcome.checks) assert.equal(check.label.length, 200);
});

test('missing checks normalize to an empty list', async () => {
  const { client } = stub(async () => modelResult(JSON.stringify({ verdict: 'pass', reason: 'ok' })));
  const outcome = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'high' }).review(reviewRequest());
  assert.equal(outcome.verdict, 'pass');
  assert.deepEqual(outcome.checks, []);
});

test('a missing client or reviewer escalates with missing_configuration, consumes no budget and makes no model call', async () => {
  const { client, calls } = stub(async () => modelResult(verdictJson('pass')));
  let consumptions = 0;
  const noClient = await createToolReviewer({
    client: undefined as unknown as ToolReviewClient, reviewer: 'r', escalateAt: 'high',
    consume: () => { consumptions += 1; },
  }).review(reviewRequest());
  assert.equal(noClient.verdict, 'escalate');
  assert.equal(noClient.degraded, 'missing_configuration');

  const noReviewer = await createToolReviewer({
    client, reviewer: '   ', escalateAt: 'high',
    consume: () => { consumptions += 1; },
  }).review(reviewRequest());
  assert.equal(noReviewer.verdict, 'escalate');
  assert.equal(noReviewer.degraded, 'missing_configuration');

  assert.equal(consumptions, 0);
  assert.equal(calls.length, 0);
});

test('invalid reviewer configuration escalates with missing_configuration and consumes no budget', async () => {
  const invalid: { name: string; options: Partial<ToolReviewOptions> }[] = [
    { name: 'invalid escalation threshold', options: { escalateAt: 'severe' as ReviewRisk } },
    { name: 'zero timeout', options: { timeoutMs: 0 } },
    { name: 'negative timeout', options: { timeoutMs: -25 } },
    { name: 'NaN timeout', options: { timeoutMs: Number.NaN } },
    { name: 'non-numeric timeout', options: { timeoutMs: '100' as unknown as number } },
    { name: 'timeout beyond the timer limit', options: { timeoutMs: 2_147_483_648 } },
    { name: 'zero input limit', options: { maxInputChars: 0 } },
    { name: 'negative input limit', options: { maxInputChars: -1 } },
    { name: 'zero output limit', options: { maxOutputChars: 0 } },
    { name: 'NaN output limit', options: { maxOutputChars: Number.NaN } },
    { name: 'infinite output limit', options: { maxOutputChars: Number.POSITIVE_INFINITY } },
    { name: 'unreasonable output limit', options: { maxOutputChars: 1_000_000 } },
  ];
  for (const { name, options } of invalid) {
    let consumptions = 0;
    const { client, calls } = stub(async () => modelResult(verdictJson('pass')));
    const outcome = await createToolReviewer({
      client, reviewer: 'reviewer-model', escalateAt: 'high',
      consume: () => { consumptions += 1; },
      ...options,
    }).review(reviewRequest());
    assert.equal(outcome.verdict, 'escalate', name);
    assert.equal(outcome.degraded, 'missing_configuration', name);
    assert.equal(consumptions, 0, name);
    assert.equal(calls.length, 0, name);
  }
});

test('an invalid trusted risk escalates with missing_configuration instead of passing', async () => {
  let consumptions = 0;
  const { client, calls } = stub(async () => modelResult(verdictJson('pass')));
  const outcome = await createToolReviewer({
    client, reviewer: 'r', escalateAt: 'high', consume: () => { consumptions += 1; },
  }).review(reviewRequest({ risk: 'severe' as ReviewRisk }));
  assert.equal(outcome.verdict, 'escalate');
  assert.equal(outcome.degraded, 'missing_configuration');
  assert.equal(outcome.risk, 'critical');
  assert.equal(consumptions, 0);
  assert.equal(calls.length, 0);
});

test('a malformed model result escalates instead of throwing or passing', async () => {
  const missing = stub(async () => undefined as unknown as ModelResult);
  const missingOutcome = await createToolReviewer({ client: missing.client, reviewer: 'r', escalateAt: 'high' }).review(reviewRequest());
  assert.equal(missingOutcome.verdict, 'escalate');
  assert.equal(missingOutcome.degraded, 'invalid_response');
  assert.equal(missing.calls.length, 1);

  const nonText = stub(async () => ({ content: 42, toolCalls: [], finishReason: 'stop' }) as unknown as ModelResult);
  const nonTextOutcome = await createToolReviewer({ client: nonText.client, reviewer: 'r', escalateAt: 'high' }).review(reviewRequest());
  assert.equal(nonTextOutcome.verdict, 'escalate');
  assert.equal(nonTextOutcome.degraded, 'invalid_response');
});

test('the outcome carries the actual review model request id, never a proposal echo', async () => {
  const { client } = stub(async () => modelResult(verdictJson('pass'), { requestId: 'review-request-9' }));
  const passed = await createToolReviewer({ client, reviewer: 'r', escalateAt: 'high' }).review(reviewRequest());
  assert.equal(passed.verdict, 'pass');
  assert.equal(passed.requestId, 'review-request-9');

  // A malformed response from the same actual request still identifies that request.
  const malformed = stub(async () => modelResult('not json', { requestId: 'review-request-10' }));
  const invalid = await createToolReviewer({ client: malformed.client, reviewer: 'r', escalateAt: 'high' }).review(reviewRequest());
  assert.equal(invalid.verdict, 'escalate');
  assert.equal(invalid.degraded, 'invalid_response');
  assert.equal(invalid.requestId, 'review-request-10');

  // No model call happened, so there is no actual review request to claim.
  const unavailable = createToolReviewer({ client: undefined as unknown as ToolReviewClient, reviewer: 'r', escalateAt: 'high' });
  const missing = await unavailable.review(reviewRequest());
  assert.equal(missing.verdict, 'escalate');
  assert.equal(missing.requestId, undefined);
});
