import type { GoalContract, ModelResult, WireMessage } from '../contracts.js';
import { isRiskLevel, reviewEscalates } from '../kernel/permission.js';
import type { ModelClient } from './model.js';
import { rolePrompt } from './prompts.js';

/**
 * Bounded, independent reviewer for one proposed tool call in auto-review mode.
 *
 * The reviewer is a model call, so it is an untrusted, failure-prone dependency: missing
 * configuration, oversized artifacts, timeouts, caller cancellation, provider errors and
 * malformed output all escalate to human approval. A "pass" is only returned for a valid
 * parsed pass whose trusted kernel risk is below the configured escalation threshold.
 *
 * This module never touches the kernel, the workspace or any tool; the caller records the
 * outcome and decides delivery.
 */
export type ReviewRisk = 'low' | 'medium' | 'high' | 'critical';
export type ReviewVerdict = 'pass' | 'escalate' | 'block';
export type ReviewDegraded =
  | 'missing_configuration'
  | 'timeout'
  | 'cancelled'
  | 'invalid_response'
  | 'model_error'
  | 'budget'
  | 'artifact_too_large';
export interface ReviewCheck { label: string; ok: boolean }

export interface ToolReviewRequest {
  taskId: string;
  goal: { objective: string; constraints: string[]; acceptance: string[]; mode: string };
  intent: { name: string; arguments: Record<string, unknown>; digest: string; generation: number; policyEpoch: number };
  /** Trusted kernel capability such as workspace.write, process.exec, mcp.call or network.read. */
  capability: string;
  /** Trusted kernel risk; the model's own risk claims are never used. */
  risk: ReviewRisk;
  resources?: string[];
  signal?: AbortSignal;
}

export interface ToolReviewOutcome {
  verdict: ReviewVerdict;
  reason: string;
  checks: ReviewCheck[];
  reviewer: string;
  risk: ReviewRisk;
  durationMs: number;
  degraded?: ReviewDegraded;
  /**
   * Identity of the actual review model Request that produced this outcome, taken from the
   * adapter's ModelResult. It is never the request that proposed the effect: that proposal is the
   * review Request's parent/cause and is wired by the caller, not echoed here.
   */
  requestId?: string;
}

/**
 * Structural model dependency. The reviewer only needs complete(); a lazily loaded adapter
 * without ModelClient's configuration, credentials and observers is enough.
 */
export type ToolReviewClient = Pick<ModelClient, 'complete'>;

export interface ToolReviewOptions {
  client: ToolReviewClient;
  reviewer: string;
  escalateAt: ReviewRisk;
  timeoutMs?: number;
  maxInputChars?: number;
  maxOutputChars?: number;
  /** Consume the task model budget / assert configuration; a throw means no model call is allowed. */
  consume?: () => void;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_INPUT_CHARS = 12_000;
const DEFAULT_MAX_OUTPUT_CHARS = 4_000;
const MAX_REASON_CHARS = 1_000;
const MAX_CHECKS = 20;
const MAX_CHECK_LABEL_CHARS = 200;
/** setTimeout silently fires immediately above this value, so a larger deadline is invalid. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** A verdict is bounded JSON; a huge configured cap would let an untrusted response consume memory. */
const MAX_OUTPUT_CHARS_LIMIT = 100_000;

const failureLabel: Record<ReviewDegraded, string> = {
  missing_configuration: 'reviewer_configured',
  timeout: 'completed_in_time',
  cancelled: 'caller_active',
  invalid_response: 'valid_response',
  model_error: 'reviewer_available',
  budget: 'budget_available',
  artifact_too_large: 'input_within_limit',
};

type ParsedReview = { verdict: ReviewVerdict; reason: string; checks: ReviewCheck[] } | { problem: string };
type ReviewInput = { messages: WireMessage[] } | { problem: string; degraded: ReviewDegraded };
type ReviewerCall = { model: ModelResult } | { problem: string; degraded: ReviewDegraded };

function errorSummary(error: unknown): string {
  if (error instanceof Error) return error.name + ': ' + error.message.slice(0, 200);
  return 'Error: ' + String(error).slice(0, 200);
}

function isPositiveLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Validate the static reviewer configuration once. Invalid values fail closed with
 * missing_configuration instead of throwing or reaching reviewEscalates with undefined ranks.
 */
function configurationProblem(
  client: ToolReviewClient | undefined,
  reviewer: string,
  escalateAt: unknown,
  timeoutMs: unknown,
  maxInputChars: unknown,
  maxOutputChars: unknown,
): string | undefined {
  if (!client || typeof client.complete !== 'function') {
    return 'No reviewer model client is configured for automatic tool review.';
  }
  if (!reviewer) return 'No reviewer identity is configured for automatic tool review.';
  if (!isRiskLevel(escalateAt)) {
    return 'The configured escalation threshold is not a valid risk level: ' + String(escalateAt) + '.';
  }
  if (!isPositiveLimit(timeoutMs) || timeoutMs > MAX_TIMEOUT_MS) {
    return 'The configured review timeout must be a positive number of milliseconds no greater than ' + MAX_TIMEOUT_MS + '.';
  }
  if (!isPositiveLimit(maxInputChars)) {
    return 'The configured review input limit must be a positive number of characters.';
  }
  if (!isPositiveLimit(maxOutputChars) || maxOutputChars > MAX_OUTPUT_CHARS_LIMIT) {
    return 'The configured review output limit must be a positive number of characters no greater than ' + MAX_OUTPUT_CHARS_LIMIT + '.';
  }
  return undefined;
}

function abortRejection(signal: AbortSignal): Promise<never> {
  const rejection = new Promise<never>((_, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  // A settled race must not leave an unhandled rejection behind.
  rejection.catch(() => undefined);
  return rejection;
}

/**
 * Build the bounded, data-only review request. The artifact is either reviewed in full or not at
 * all: truncating it could hide the exact bytes that make the call unsafe, so an oversized input
 * escalates instead of being trimmed and passed.
 */
function reviewInput(request: ToolReviewRequest, escalateAt: ReviewRisk, maxInputChars: number): ReviewInput {
  // rolePrompt() takes the kernel GoalContract; the reviewer role reads only the goal text, and
  // this request already carries the same objective, constraints and acceptance.
  const system = rolePrompt('reviewer', request.goal as GoalContract);
  let user: string;
  try {
    user = JSON.stringify({
      goal: request.goal,
      intent: {
        name: request.intent.name,
        digest: request.intent.digest,
        generation: request.intent.generation,
        policyEpoch: request.intent.policyEpoch,
      },
      arguments: request.intent.arguments,
      capability: request.capability,
      risk: request.risk,
      resources: request.resources ?? [],
      escalationThreshold: escalateAt,
    });
  } catch (error) {
    return { problem: 'Tool review input could not be serialized: ' + errorSummary(error), degraded: 'invalid_response' };
  }
  const inputChars = system.length + user.length;
  if (inputChars > maxInputChars) {
    return {
      problem: 'Tool review input is ' + inputChars + ' characters and the limit is ' + maxInputChars
        + '; the reviewer must see the complete artifact, so it is not truncated.',
      degraded: 'artifact_too_large',
    };
  }
  return { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
}

/**
 * Call the reviewer with a local deadline that is independent of the provider's own timeout. The
 * caller's signal cancels too, and the two reasons stay distinguishable for the caller. The budget
 * gate runs last, immediately before the request: preflight failures must not spend a model call.
 */
async function callReviewer(
  client: ToolReviewClient,
  messages: WireMessage[],
  timeoutMs: number,
  external: AbortSignal | undefined,
  consume: (() => void) | undefined,
): Promise<ReviewerCall> {
  if (external?.aborted) return { problem: 'Tool review was cancelled before the reviewer request was sent.', degraded: 'cancelled' };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const forwardAbort = () => controller.abort();
  const canMerge = external !== undefined && typeof AbortSignal.any === 'function';
  const signal = canMerge ? AbortSignal.any([controller.signal, external]) : controller.signal;
  try {
    if (!canMerge) {
      external?.addEventListener('abort', forwardAbort, { once: true });
      // Do not miss an abort that raced the listener registration above.
      if (external?.aborted) controller.abort();
    }
    // Exactly once, after configuration/input/cancellation checks and before the request.
    try {
      consume?.();
    } catch (error) {
      return { problem: 'Tool review was not authorized to spend a model call: ' + errorSummary(error), degraded: 'budget' };
    }
    const call = Promise.resolve(client.complete(messages, [], signal));
    // A provider that ignores cancellation must not keep the reviewer waiting: the race settles on
    // our own deadline, and late rejections are consumed here instead of surfacing unhandled.
    call.catch(() => undefined);
    const model = await Promise.race([call, abortRejection(signal)]);
    if (timedOut) return { problem: 'Tool review did not finish within ' + timeoutMs + ' ms.', degraded: 'timeout' };
    if (external?.aborted) return { problem: 'Tool review was cancelled by its caller.', degraded: 'cancelled' };
    return { model };
  } catch (error) {
    if (timedOut) return { problem: 'Tool review did not finish within ' + timeoutMs + ' ms.', degraded: 'timeout' };
    if (external?.aborted) return { problem: 'Tool review was cancelled by its caller.', degraded: 'cancelled' };
    return { problem: 'Tool reviewer request failed: ' + errorSummary(error), degraded: 'model_error' };
  } finally {
    clearTimeout(timer);
    if (!canMerge) external?.removeEventListener('abort', forwardAbort);
  }
}

/** The reviewer output is untrusted data: one strict JSON object or no verdict at all. */
function parseReview(text: string): ParsedReview {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { problem: 'not valid JSON (' + (error instanceof Error ? error.message : String(error)) + ')' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { problem: 'the response must be one JSON object' };
  const record = value as Record<string, unknown>;
  if (record.verdict !== 'pass' && record.verdict !== 'escalate' && record.verdict !== 'block') {
    return { problem: 'verdict must be one of pass, escalate or block' };
  }
  if (typeof record.reason !== 'string' || !record.reason.trim()) return { problem: 'reason must be a non-empty string' };
  if (record.checks !== undefined && !Array.isArray(record.checks)) return { problem: 'checks must be an array when present' };
  const checks: ReviewCheck[] = [];
  for (const item of (record.checks ?? []).slice(0, MAX_CHECKS)) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { problem: 'each check must be an object' };
    const check = item as Record<string, unknown>;
    if (typeof check.label !== 'string' || typeof check.ok !== 'boolean') return { problem: 'each check needs a string label and a boolean ok' };
    checks.push({ label: check.label.slice(0, MAX_CHECK_LABEL_CHARS), ok: check.ok });
  }
  return { verdict: record.verdict, reason: record.reason.trim().slice(0, MAX_REASON_CHARS), checks };
}

export function createToolReviewer(options: ToolReviewOptions): { review(request: ToolReviewRequest): Promise<ToolReviewOutcome> } {
  const reviewer = typeof options.reviewer === 'string' ? options.reviewer.trim() : '';
  const client = options.client;
  const escalateAt = options.escalateAt;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const consume = options.consume;
  const configuration = configurationProblem(client, reviewer, escalateAt, timeoutMs, maxInputChars, maxOutputChars);

  return {
    async review(request: ToolReviewRequest): Promise<ToolReviewOutcome> {
      const started = performance.now();
      // An invalid trusted risk is recorded as critical so every outcome still carries a valid
      // RiskLevel for the caller's record; the reason keeps the original value for diagnosis.
      const trustedRisk: ReviewRisk = isRiskLevel(request.risk) ? request.risk : 'critical';
      // requestId is the actual review Request that served this outcome. It is only known once the
      // adapter has produced a ModelResult, so a failure before the call leaves it undefined and
      // the caller can still find that failed Request by its review kind/parent.
      const finish = (verdict: ReviewVerdict, reason: string, checks: ReviewCheck[] = [], degraded?: ReviewDegraded, requestId?: string): ToolReviewOutcome => ({
        verdict,
        reason: reason.trim().slice(0, MAX_REASON_CHARS),
        checks: checks.slice(0, MAX_CHECKS),
        reviewer: reviewer || 'unconfigured',
        risk: trustedRisk,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        ...(degraded ? { degraded } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      });
      const fail = (problem: string, degraded: ReviewDegraded, requestId?: string): ToolReviewOutcome =>
        finish('escalate', problem, [{ label: failureLabel[degraded], ok: false }], degraded, requestId);

      // Configuration and trusted input are checked before anything may spend a model call.
      if (configuration !== undefined) return fail(configuration, 'missing_configuration');
      if (!isRiskLevel(request.risk)) {
        return fail('The trusted tool risk is not a valid risk level: ' + String(request.risk) + '; it is recorded as critical.', 'missing_configuration');
      }
      if (request.signal?.aborted) return fail('Tool review was cancelled before the reviewer request was sent.', 'cancelled');

      const input = reviewInput(request, escalateAt, maxInputChars);
      if (!('messages' in input)) return fail(input.problem, input.degraded);

      const call = await callReviewer(client, input.messages, timeoutMs, request.signal, consume);
      if (!('model' in call)) return fail(call.problem, call.degraded);

      const model = call.model;
      const actualRequestId = model && typeof model === 'object' && typeof model.requestId === 'string' && model.requestId ? model.requestId : undefined;
      // A broken adapter can resolve with nothing usable; that is an invalid review, not a crash.
      if (!model || typeof model !== 'object' || typeof model.content !== 'string') {
        return fail('Tool reviewer returned no usable text response.', 'invalid_response', actualRequestId);
      }
      const raw = model.content;
      if (raw.length > maxOutputChars) {
        return fail('Tool reviewer response exceeded ' + maxOutputChars
          + ' characters; the over-limit output was rejected instead of truncated into a pass.', 'invalid_response', actualRequestId);
      }
      if (!raw.trim()) return fail('Tool reviewer returned an empty response.', 'invalid_response', actualRequestId);
      if (model.toolCalls?.length) return fail('Tool reviewer returned tool calls; a review must be a plain JSON verdict.', 'invalid_response', actualRequestId);
      const parsed = parseReview(raw);
      if ('problem' in parsed) return fail('Tool reviewer response is invalid: ' + parsed.problem, 'invalid_response', actualRequestId);

      // The trusted kernel risk decides escalation, never a risk level claimed by the model.
      if (parsed.verdict === 'pass' && reviewEscalates(request.risk, escalateAt)) {
        return finish('escalate', 'Risk ' + request.risk + ' is at or above the configured escalation threshold ' + escalateAt + '; human approval is required. ' + parsed.reason, parsed.checks, undefined, actualRequestId);
      }
      return finish(parsed.verdict, parsed.reason, parsed.checks, undefined, actualRequestId);
    },
  };
}
