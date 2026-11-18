import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Kernel, digest } from '../src/kernel/index.js';
import { HarnessStore } from '../src/harness/store.js';
import { WorkTrace } from '../src/harness/work-trace.js';
import type { Services } from '../src/app/services.js';
import type { IntentFailure, ToolCall } from '../src/contracts.js';

/**
 * Inspector projection of the terminal network failure. The tool record is what a person reads after
 * the task settles, so an effect that the Kernel records as failed must not stay "unknown" there, and
 * a catch-up after a restart must project the diagnosis from the event rather than from the intent's
 * later state.
 */
const FIXTURE_ROOT = path.join(process.cwd(), '.tmp', 'network-integration', 'root', 'work-trace-failure');
const FAILURE: IntentFailure = { code: 'HTTP_FAILED', message: 'HTTP 503: request failed.', tool: 'web_fetch', source: 'network' };
const TOOL_MESSAGE = JSON.stringify({ error: { code: FAILURE.code, message: FAILURE.message, tool: FAILURE.tool, source: FAILURE.source }, executed: true, effect: 'failed', recovery: 'The effect was already dispatched and failed; it is not retried automatically.' });

interface Fixture {
  readonly root: string;
  readonly harnessDir: string;
  readonly taskId: string;
  readonly runId: string;
  readonly intentId: string;
  readonly call: ToolCall;
  readonly effectKey: string;
  kernel: Kernel;
  store: HarnessStore;
  trace(): WorkTrace;
  reopenStore(): HarnessStore;
  close(): void;
}

function fixture(t: import('node:test').TestContext, label: string): Fixture {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const root = mkdtempSync(path.join(FIXTURE_ROOT, label + '-'));
  const stateDir = path.join(root, 'state'), harnessDir = path.join(root, 'harness'), workspace = path.join(root, 'workspace');
  for (const directory of [stateDir, harnessDir, workspace]) mkdirSync(directory);
  let kernel = new Kernel(stateDir), store = new HarnessStore(harnessDir);
  const projections: WorkTrace[] = [];
  const taskId = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    workspace, objective: 'Project the persisted network failure', permission: { mode: 'full-access', app: 'work' }, maxModelCalls: 3,
  } }).taskId!;
  kernel.transition(taskId, 'running');
  const run = kernel.createRun(taskId);
  const call: ToolCall = { id: 'fetch-one', name: 'web_fetch', arguments: { url: 'https://example.com/page' } };
  const request = store.createRequest({ sessionId: taskId, taskId, runId: run.id, profileId: 'default', kind: 'work', status: 'completed', endpoint: 'fixture', bodyHash: 'fixture', recordContent: true, draft: '', sources: [] });
  store.saveTool({ id: request.id + ':' + call.id, requestId: request.id, sessionId: taskId, taskId, runId: run.id, toolCallId: call.id, name: call.name, arguments: call.arguments, source: 'network', permission: 'unassessed', status: 'proposed', retries: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const message = kernel.addMessage(taskId, 'assistant', '', 'main', { toolCalls: [call], requestId: request.id });
  const effectKey = digest({ taskId, messageId: message.id, toolCallId: call.id });
  const intent = kernel.prepareIntent(taskId, run.id, { ...call }, { effectKey, capability: 'network.read', paths: [], resources: [String(call.arguments.url)] });
  kernel.approve(intent.id, { source: 'policy' });
  kernel.dispatch(intent.id);
  const f: Fixture = {
    root, harnessDir, taskId, runId: run.id, intentId: intent.id, call, effectKey,
    get kernel() { return kernel; },
    set kernel(next: Kernel) { kernel = next; },
    get store() { return store; },
    set store(next: HarnessStore) { store = next; },
    trace() { const trace = new WorkTrace({ kernel } as unknown as Services, store, value => value); projections.push(trace); return trace; },
    reopenStore() { projections.forEach(trace => trace.close()); store.close(); store = new HarnessStore(harnessDir); return store; },
    close() { projections.forEach(trace => trace.close()); store.close(); kernel.close(); },
  };
  t.after(() => { f.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return f;
}

const toolOf = (f: Fixture) => f.store.findTool(f.taskId, f.call.id)!;
const statusOf = (f: Fixture, type: string) => f.store.traces({ taskId: f.taskId }).events.filter(event => event.type === type).at(-1)?.status;
const sync = async (f: Fixture, trace = f.trace()) => {
  trace.sync();
  for (let attempt = 0; attempt < 100 && f.store.getSetting('kernelCursor', 0) < f.kernel.latestEventSequence(); attempt++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.store.getSetting('kernelCursor', 0), f.kernel.latestEventSequence());
};

test('a dispatched terminal failure is projected as failed with the execution diagnostic, and the tool message keeps it failed', async t => {
  const f = fixture(t, 'dispatch');
  const trace = f.trace();
  await sync(f, trace);
  assert.equal(toolOf(f).status, 'running');

  // The runner records the structured execution diagnostic, then the Kernel terminally fails the effect.
  f.kernel.appendEvent(f.taskId, 'tool.execution', { toolCallId: f.call.id, runId: f.runId, intentId: f.intentId, patch: {
    status: 'failed', failureStage: 'execution', outcomeStatus: 'failed', code: FAILURE.code, tool: FAILURE.tool, source: FAILURE.source, message: FAILURE.message,
  } });
  f.kernel.failIntent(f.intentId, FAILURE);
  await sync(f, trace);

  const failed = toolOf(f);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureStage, 'execution');
  assert.equal(failed.error, 'HTTP_FAILED: HTTP 503: request failed.', 'the tool record carries the real code and message');
  assert.equal(failed.intentId, f.intentId);
  assert.equal(failed.result, undefined, 'no result is invented before the tool message');
  assert.equal(statusOf(f, 'effect.failed'), 'failed');

  // The honest tool result arrives afterwards; it adds the result but must never reset the failed status.
  f.kernel.addMessage(f.taskId, 'tool', TOOL_MESSAGE, 'main', { toolCallId: f.call.id });
  await sync(f, trace);
  const settled = toolOf(f);
  assert.equal(settled.status, 'failed');
  assert.equal(settled.result, TOOL_MESSAGE);
  assert.equal(statusOf(f, 'message.appended'), 'failed');
});

test('a reconciliation failure is projected as failed, history keeps its own statuses, and a restart catch-up is idempotent', async t => {
  const f = fixture(t, 'reconcile');
  f.kernel.unknown(f.intentId, 'Simulated crash before terminal settlement');
  f.kernel.reconcileFailure(f.intentId, FAILURE);
  f.kernel.addMessage(f.taskId, 'tool', TOOL_MESSAGE, 'main', { toolCallId: f.call.id });

  // A fresh projection starts at sequence zero while the intent already holds its terminal state.
  // Every historical event must still be projected from itself, never from that later state.
  const trace = f.trace();
  await sync(f, trace);
  const failed = toolOf(f);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureStage, 'reconciliation', 'a recovered failure is attributed to reconciliation');
  assert.equal(failed.error, 'HTTP_FAILED: HTTP 503: request failed.');
  assert.equal(failed.result, TOOL_MESSAGE);
  assert.equal(statusOf(f, 'intent.sent'), 'running', 'a historical dispatch event is not rewritten as failed');
  assert.equal(statusOf(f, 'effect.unknown'), 'unknown', 'the unknown event keeps its own status');
  assert.equal(statusOf(f, 'effect.failed'), 'failed');
  assert.equal(f.store.toolCalls({ taskId: f.taskId }).length, 1);

  // Re-importing the same kernel events must not duplicate or rewrite the projection.
  const before = JSON.stringify(toolOf(f));
  const traceCount = f.store.traces({ taskId: f.taskId }).events.length;
  f.store.setSetting('kernelCursor', 0);
  await sync(f, trace);
  assert.equal(JSON.stringify(toolOf(f)), before);
  assert.equal(f.store.traces({ taskId: f.taskId }).events.length, traceCount);
  assert.equal(f.store.toolCalls({ taskId: f.taskId }).length, 1);

  // A reopened HarnessStore resumes from the saved cursor and reads the same failed record.
  f.reopenStore();
  await sync(f);
  assert.equal(toolOf(f).status, 'failed');
  assert.equal(toolOf(f).failureStage, 'reconciliation');
  assert.equal(toolOf(f).error, 'HTTP_FAILED: HTTP 503: request failed.');
  assert.equal(f.store.traces({ taskId: f.taskId }).events.length, traceCount);
});

test('a reconciled failure with a code but no message keeps the code in the Inspector', async t => {
  const f = fixture(t, 'code-only');
  f.kernel.unknown(f.intentId, 'Simulated crash before terminal settlement');
  // A valid IntentFailure may omit its message; the Inspector must still show the real code,
  // and the projection must never emit a leading separator for a message-only diagnosis.
  f.kernel.reconcileFailure(f.intentId, { code: 'HTTP_FAILED', tool: 'web_fetch', source: 'network' });
  await sync(f);
  const failed = toolOf(f);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureStage, 'reconciliation');
  assert.equal(failed.error, 'HTTP_FAILED', 'the code-only diagnosis is not swallowed');
});
