import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Kernel, digest } from '../src/kernel/index.js';
import { Runner } from '../src/app/runner.js';
import { ExternalTools } from '../src/app/external-tools.js';
import type { Intent, ModelResult, ToolCall, WireMessage } from '../src/contracts.js';
import type { Configuration } from '../src/app/configuration.js';
import type { CandidateManager } from '../src/adaptation/index.js';
import type { ToolOutcome } from '../src/tools/gateway.js';

/**
 * Restart acceptance for the determinate read-only web failure. Phase A reproduces a process death
 * at a chosen crash window with the real Kernel, real SQLite rows and the real ExternalTools receipt
 * ledger (never by editing tables); phase B reopens the database, recovers and runs the real Runner.
 * The only injected network is a deterministic fixture transport, so a re-dispatch would be visible.
 */
const FIXTURE_ROOT = path.join(process.cwd(), '.tmp', 'network-integration', 'a', 'runner-network-recovery');
const PAGE_URL = 'https://www.example.org/page';
const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];
const PASS_REVIEW = JSON.stringify({ verdict: 'pass', reason: 'Mock independent review passed.', checks: [{ label: 'network_read', ok: true }] });
const RECOVERY = /not retried automatically/;
const providerConfig = {
  baseUrl: 'http://127.0.0.1:9/mock', model: 'recovery-test-model', mode: 'mock' as const,
  maxOutputTokens: 4096, maxRequestBytes: 131072, contextWindowTokens: 262144,
};

function candidates(): CandidateManager {
  return { snapshotFor: () => ({}), applySnapshot: async (_snapshot: unknown, value: string) => value } as unknown as CandidateManager;
}

/** Records each Work turn; an independent-reviewer system prompt is answered with a pass. */
function configuration(turns: WireMessage[][], reply?: (messages: WireMessage[]) => ModelResult): Configuration {
  return {
    globalPaths: [], skillRoots: [], redact: (value: string) => value, sanitize: (value: unknown) => value,
    client: () => ({ config: providerConfig, complete: async (messages: WireMessage[]) => {
      if (messages.some(message => message.role === 'system' && String(message.content).includes('REVIEWER ROLE')))
        return { content: PASS_REVIEW, toolCalls: [], finishReason: 'stop' } as ModelResult;
      turns.push(messages);
      return reply?.(messages) ?? { content: 'The page could not be read; finishing without claiming a result.', toolCalls: [], finishReason: 'stop' } as ModelResult;
    } }),
  } as unknown as Configuration;
}

interface Fixture {
  readonly root: string;
  readonly stateDir: string;
  readonly workspace: string;
  readonly counts: { robots: number; pages: number };
  kernel: Kernel;
  external: ExternalTools;
  openKernel(): Kernel;
  restartExternal(): Promise<ExternalTools>;
  close(): Promise<void>;
}

function fixture(t: import('node:test').TestContext, label: string): Fixture {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const root = mkdtempSync(path.join(FIXTURE_ROOT, label + '-'));
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  for (const directory of [stateDir, workspace]) mkdirSync(directory);
  const counts = { robots: 0, pages: 0 };
  const transport = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/robots.txt') { counts.robots++; return new Response('', { status: 404 }); }
    counts.pages++;
    return new Response('', { status: 503 });
  }) as typeof fetch;
  const makeExternal = (): ExternalTools => new ExternalTools({ dataDir: path.join(root, 'network'), projectRoot: process.cwd(), webOptions: { resolveDns: PUBLIC_DNS, fetch: transport } });
  let kernel = new Kernel(stateDir);
  let external = makeExternal();
  const f: Fixture = {
    root, stateDir, workspace, counts,
    get kernel() { return kernel; },
    set kernel(next: Kernel) { kernel = next; },
    get external() { return external; },
    set external(next: ExternalTools) { external = next; },
    openKernel() { kernel.close(); kernel = new Kernel(stateDir); return kernel; },
    async restartExternal() { await external.close(); external = makeExternal(); return external; },
    async close() { await external.close(); kernel.close(); },
  };
  t.after(async () => { await f.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return f;
}

function providerConfigOf(): void { /* provider shape is module-level for readability */ }

function createTask(f: Fixture, objective: string): string {
  return f.kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    workspace: f.workspace, objective, permission: { mode: 'full-access', app: 'work' }, maxModelCalls: 8,
  } }).taskId!;
}

function failureOf(outcome: ToolOutcome): ReturnType<typeof failureShape> {
  return failureShape(outcome);
}
function failureShape(outcome: ToolOutcome) {
  const error = (JSON.parse(outcome.output) as { error: Record<string, unknown> }).error;
  return { code: String(error.code), message: String(error.message), tool: String(error.tool), source: 'network' as const };
}

/**
 * Phase A: a real task, run, assistant tool call, prepared/approved/sent intent, and — when asked —
 * a real executed web fetch whose failed outcome is persisted by ExternalTools. Reproduces the exact
 * Runner ledger event; never edits kernel tables directly.
 */
async function crashWindow(f: Fixture, options: { execute: boolean; terminal: boolean }) {
  const taskId = createTask(f, 'Fetch a page that crashes at the selected window');
  f.kernel.transition(taskId, 'running');
  const run = f.kernel.createRun(taskId);
  const call: ToolCall = { id: 'fetch-one', name: 'web_fetch', arguments: { url: PAGE_URL } };
  const message = f.kernel.addMessage(taskId, 'assistant', '', 'main', { toolCalls: [call] });
  const effectKey = digest({ taskId, messageId: message.id, toolCallId: call.id });
  const prepared = f.external.prepare(call)!;
  const intent = f.kernel.prepareIntent(taskId, run.id, { ...call, arguments: prepared.arguments }, {
    effectKey, capability: prepared.capability, paths: [], resources: prepared.resources,
  });
  f.kernel.approve(intent.id, { source: 'policy' });
  f.kernel.dispatch(intent.id);
  let outcome: ToolOutcome | undefined;
  if (options.execute) {
    outcome = await f.external.execute(prepared, { effectKey, approvedDigest: prepared.digest });
    const diagnostic = (JSON.parse(outcome.output) as { error: Record<string, unknown> }).error;
    f.kernel.appendEvent(taskId, 'tool.execution', { toolCallId: call.id, runId: run.id, intentId: intent.id, patch: {
      status: 'failed', failureStage: 'execution', outcomeStatus: 'failed', durationMs: 3,
      code: diagnostic.code, tool: diagnostic.tool, source: diagnostic.source, message: diagnostic.message,
    } });
  }
  if (outcome && options.terminal) f.kernel.failIntent(intent.id, failureOf(outcome));
  return { taskId, runId: run.id, call, message, effectKey, prepared, intent: f.kernel.getIntent(intent.id)!, outcome };
}

async function until(predicate: () => boolean, label: string, timeoutMs = 12000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(predicate(), label);
}

function toolMessages(kernel: Kernel, taskId: string, toolCallId: string): ReturnType<Kernel['getMessages']> {
  return kernel.getMessages(taskId).filter(message => message.role === 'tool' && message.toolCallId === toolCallId);
}
function dispatchEvents(kernel: Kernel, taskId: string, toolCallId: string) {
  return kernel.events(taskId).filter(event => event.type === 'tool.execution' && event.payload.toolCallId === toolCallId);
}

test('a terminal failure persisted before the crash is delivered once after restart without re-dispatch', { timeout: 60000 }, async t => {
  const f = fixture(t, 'terminal-replay');
  const crashed = await crashWindow(f, { execute: true, terminal: true });
  assert.equal(crashed.intent.state, 'failed');
  assert.equal(f.kernel.pendingCalls(crashed.taskId).length, 1, 'the tool call is still unanswered when the process dies');
  assert.deepEqual(toolMessages(f.kernel, crashed.taskId, 'fetch-one'), []);
  f.kernel.close();

  const recovered = new Kernel(f.stateDir);
  f.kernel = recovered;
  const summary = recovered.recover();
  assert.deepEqual(summary.unknownIntents, [], 'a terminal failed effect is not an unknown effect');
  assert.equal(recovered.getTask(crashed.taskId)!.status, 'queued');
  await f.restartExternal();
  assert.deepEqual(f.counts, { robots: 1, pages: 1 }, 'the restart itself reaches no network');

  const turns: WireMessage[][] = [];
  const runner = new Runner(f.kernel, configuration(turns), candidates(), f.root, f.external);
  t.after(async () => { await runner.stop(); });
  runner.start();
  await until(() => f.kernel.getTask(crashed.taskId)!.status === 'waiting_input', 'the recovered task did not settle after delivering the stored failure');

  const messages = toolMessages(f.kernel, crashed.taskId, 'fetch-one');
  assert.equal(messages.length, 1, 'the persisted failure is delivered exactly once');
  const content = JSON.parse(String(messages[0]!.content));
  assert.equal(content.executed, true, 'a dispatched request may already have reached the network');
  assert.equal(content.effect, 'failed');
  assert.match(String(content.recovery), RECOVERY);
  assert.deepEqual({ code: content.error.code, tool: content.error.tool, source: content.error.source, message: content.error.message }, { code: 'HTTP_FAILED', tool: 'web_fetch', source: 'network', message: 'HTTP 503: request failed.' });
  assert.equal(f.kernel.getIntent(crashed.intent.id)!.state, 'failed');
  assert.equal(f.kernel.getIntent(crashed.intent.id)!.receipt, undefined);
  assert.equal(dispatchEvents(f.kernel, crashed.taskId, 'fetch-one').length, 1, 'the replay records no second dispatch event');
  assert.deepEqual(f.counts, { robots: 1, pages: 1 }, 'the failed effect is never re-dispatched');
  assert.equal(turns.length, 1, 'the model is asked once after receiving the failure');
  assert.equal(turns[0]!.filter(message => message.role === 'tool').length, 1);
  assert.equal(JSON.parse(String(turns[0]!.find(message => message.role === 'tool')!.content)).effect, 'failed');
  assert.equal(f.kernel.events(crashed.taskId).filter(event => event.type === 'effect.receipted').length, 0);
  assert.equal(f.kernel.events(crashed.taskId).filter(event => event.type === 'effect.failed').length, 1);

  // A second restart after the honest tool message must not duplicate the result.
  await runner.stop();
  const reopened = f.openKernel();
  reopened.recover();
  const replayTurns: WireMessage[][] = [];
  const replay = new Runner(reopened, configuration(replayTurns), candidates(), f.root, f.external);
  t.after(async () => { await replay.stop(); });
  replay.start();
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(toolMessages(reopened, crashed.taskId, 'fetch-one').length, 1, 'no duplicate tool result after a second restart');
  assert.equal(dispatchEvents(reopened, crashed.taskId, 'fetch-one').length, 1);
  assert.equal(replayTurns.length, 0, 'a settled waiting task makes no new model request');
  assert.deepEqual(f.counts, { robots: 1, pages: 1 });
});

test('a crash after the failed network record reconciles it into one terminal failure and continues', { timeout: 60000 }, async t => {
  const f = fixture(t, 'observed-reconcile');
  const crashed = await crashWindow(f, { execute: true, terminal: false });
  assert.equal(crashed.intent.state, 'sent', 'the process died before the terminal transition');
  assert.equal(f.kernel.getIntent(crashed.intent.id)!.state, 'sent');
  f.kernel.close();

  const recovered = new Kernel(f.stateDir);
  f.kernel = recovered;
  const summary = recovered.recover();
  assert.deepEqual(summary.unknownIntents, [crashed.intent.id], 'a dispatched effect without a ledger outcome must be recovered as unknown');
  assert.deepEqual(summary.reconciling, [crashed.taskId]);
  assert.equal(recovered.getIntent(crashed.intent.id)!.state, 'unknown');
  assert.equal(recovered.getTask(crashed.taskId)!.status, 'reconciling');
  await f.restartExternal();

  const turns: WireMessage[][] = [];
  const runner = new Runner(f.kernel, configuration(turns), candidates(), f.root, f.external);
  t.after(async () => { await runner.stop(); });
  runner.start();
  await until(() => f.kernel.getTask(crashed.taskId)!.status === 'waiting_input', 'the observed failed record did not resolve into a continuing task');

  const intent = f.kernel.getIntent(crashed.intent.id)!;
  assert.equal(intent.state, 'failed', 'an independently observed failed record is a terminal outcome, not a missing receipt');
  assert.equal(intent.receipt, undefined);
  assert.equal(f.kernel.events(crashed.taskId).filter(event => event.type === 'effect.reconciliation_required').length, 0, 'the determinate record never parks the task for reconciliation');
  assert.equal(f.kernel.events(crashed.taskId).some(event => event.type === 'effect.failed' && event.payload.origin === 'reconciliation'), true);
  const messages = toolMessages(f.kernel, crashed.taskId, 'fetch-one');
  assert.equal(messages.length, 1);
  const content = JSON.parse(String(messages[0]!.content));
  assert.equal(content.effect, 'failed');
  assert.equal(content.error.code, 'HTTP_FAILED');
  assert.equal(dispatchEvents(f.kernel, crashed.taskId, 'fetch-one').length, 1, 'reconciliation adds no second dispatch event');
  assert.deepEqual(f.counts, { robots: 1, pages: 1 }, 'reconciliation observes the persisted record instead of re-running the request');
  assert.equal(turns.length, 1);
});

test('a dispatched web effect without any observed record stays unknown and is never replayed', { timeout: 60000 }, async t => {
  const f = fixture(t, 'unobserved');
  const crashed = await crashWindow(f, { execute: false, terminal: false });
  assert.equal(crashed.intent.state, 'sent');
  assert.equal(f.counts.pages, 0);
  f.kernel.close();

  const recovered = new Kernel(f.stateDir);
  f.kernel = recovered;
  const summary = recovered.recover();
  assert.deepEqual(summary.unknownIntents, [crashed.intent.id]);
  assert.equal(recovered.getTask(crashed.taskId)!.status, 'reconciling');
  await f.restartExternal();

  const turns: WireMessage[][] = [];
  const runner = new Runner(f.kernel, configuration(turns), candidates(), f.root, f.external);
  t.after(async () => { await runner.stop(); });
  runner.start();
  await until(() => f.kernel.events(crashed.taskId).filter(event => event.type === 'effect.reconciliation_required').length >= 1, 'reconciliation was never recorded');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(f.kernel.getIntent(crashed.intent.id)!.state, 'unknown', 'an effect with no observed outcome stays unknown');
  assert.equal(f.kernel.getTask(crashed.taskId)!.status, 'reconciling');
  assert.deepEqual(toolMessages(f.kernel, crashed.taskId, 'fetch-one'), [], 'no tool result is fabricated for an unknown effect');
  assert.deepEqual(f.counts, { robots: 0, pages: 0 }, 'an unknown effect is never replayed automatically');
  assert.equal(dispatchEvents(f.kernel, crashed.taskId, 'fetch-one').length, 0);
  assert.equal(f.kernel.events(crashed.taskId).filter(event => event.type === 'effect.failed').length, 0);
  assert.equal(turns.length, 0, 'the model is never told a result for an unknown effect');
});

test('a recovered MCP-style unknown effect is reconciled, not converted to a network failure', { timeout: 60000 }, async t => {
  const f = fixture(t, 'mcp-unknown');
  const taskId = createTask(f, 'Call an MCP tool whose outcome is unknown');
  f.kernel.transition(taskId, 'running');
  const run = f.kernel.createRun(taskId);
  const call: ToolCall = { id: 'mcp-one', name: 'mcp_call', arguments: { serverId: 'fixture', toolName: 'tool', arguments: {} } };
  const message = f.kernel.addMessage(taskId, 'assistant', '', 'main', { toolCalls: [call] });
  const effectKey = digest({ taskId, messageId: message.id, toolCallId: call.id });
  const intent = f.kernel.prepareIntent(taskId, run.id, { ...call, arguments: call.arguments }, { effectKey, resources: ['mcp://fixture/tool'] });
  f.kernel.approve(intent.id, { source: 'policy' });
  f.kernel.dispatch(intent.id);
  f.kernel.unknown(intent.id, 'MCP server returned no conclusive result; reconcile before retry');
  assert.equal(f.kernel.getTask(taskId)!.status, 'reconciling');
  f.kernel.close();

  const recovered = new Kernel(f.stateDir);
  f.kernel = recovered;
  const summary = recovered.recover();
  assert.deepEqual(summary.unknownIntents, [], 'an already-unknown effect is not rewritten by recovery');
  assert.equal(recovered.getTask(taskId)!.status, 'reconciling');
  await f.restartExternal();

  const turns: WireMessage[][] = [];
  const runner = new Runner(f.kernel, configuration(turns), candidates(), f.root, f.external);
  t.after(async () => { await runner.stop(); });
  runner.start();
  await until(() => f.kernel.events(taskId).filter(event => event.type === 'effect.reconciliation_required').length >= 1, 'MCP reconciliation was never recorded');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'unknown');
  assert.equal(f.kernel.getTask(taskId)!.status, 'reconciling');
  assert.deepEqual(f.counts, { robots: 0, pages: 0 }, 'an MCP effect never reaches the web transport');
  assert.deepEqual(toolMessages(f.kernel, taskId, 'mcp-one'), []);
  assert.equal(f.kernel.events(taskId).filter(event => event.type === 'effect.failed').length, 0);
  assert.equal(turns.length, 0);
});

test('after the honest failure the model can call a safe local tool, checkpoint and reopen without replay', { timeout: 60000 }, async t => {
  const f = fixture(t, 'safe-followup');
  const crashed = await crashWindow(f, { execute: true, terminal: true });
  assert.equal(crashed.intent.state, 'failed');
  f.kernel.close();

  const recovered = new Kernel(f.stateDir);
  f.kernel = recovered;
  recovered.recover();
  await f.restartExternal();
  writeFileSync(path.join(f.workspace, 'notes.txt'), 'Local notes after the failed network read.\n');

  const turns: WireMessage[][] = [];
  const runner = new Runner(f.kernel, configuration(turns, messages => {
    const toolResults = messages.filter(message => message.role === 'tool').length;
    if (toolResults >= 2)
      return { content: 'The local notes were read; finishing without claiming the failed page.', toolCalls: [], finishReason: 'stop' } as ModelResult;
    return { content: 'Reading a local file instead of retrying the failed page.', toolCalls: [{ id: 'read-one', name: 'read_file', arguments: { path: 'notes.txt' } }], finishReason: 'tool_calls' } as ModelResult;
  }), candidates(), f.root, f.external);
  t.after(async () => { await runner.stop(); });
  runner.start();
  // The independent verifier passes: the terminal failed effect is not an unresolved effect and the
  // local read kept a real receipt, so the designed passing-review path completes the task.
  await until(() => f.kernel.getTask(crashed.taskId)!.status === 'completed', 'the safe follow-up did not settle');

  const read = f.kernel.intents(crashed.taskId).find(intent => intent.name === 'read_file' && intent.toolCallId === 'read-one');
  assert.ok(read, 'the model chose a safe local tool after the honest failure');
  assert.equal(read.state, 'applied');
  assert.ok(read.receipt, 'the local read keeps its real receipt');
  const readMessages = toolMessages(f.kernel, crashed.taskId, 'read-one');
  assert.equal(readMessages.length, 1);
  assert.match(String(readMessages[0]!.content), /Local notes after the failed network read/);
  assert.equal(f.kernel.getIntent(crashed.intent.id)!.state, 'failed');
  assert.equal(toolMessages(f.kernel, crashed.taskId, 'fetch-one').length, 1);
  assert.deepEqual(f.counts, { robots: 1, pages: 1 }, 'the failed network effect is never retried after the safe tool');
  assert.equal(f.kernel.events(crashed.taskId).filter(event => event.type === 'effect.failed').length, 1);
  assert.ok(f.kernel.getCheckpoints(crashed.taskId).length >= 1, 'the safe tool round persisted a checkpoint');
  assert.equal(turns.length, 2, 'one model turn for the failure, one for the safe tool result');

  await runner.stop();
  const reopened = f.openKernel();
  reopened.recover();
  assert.equal(reopened.getIntent(crashed.intent.id)!.state, 'failed');
  assert.equal(reopened.getTask(crashed.taskId)!.status, 'completed');
  assert.ok(reopened.getCheckpoints(crashed.taskId).length >= 1);
  assert.equal(toolMessages(reopened, crashed.taskId, 'fetch-one').length, 1);
  assert.deepEqual(f.counts, { robots: 1, pages: 1 });
});

test('an explicitly unknown observer status is never upgraded to a terminal failure from a structured error', { timeout: 60000 }, async t => {
  const f = fixture(t, 'unknown-observer');
  const crashed = await crashWindow(f, { execute: true, terminal: false });
  f.kernel.close();

  const recovered = new Kernel(f.stateDir);
  f.kernel = recovered;
  const summary = recovered.recover();
  assert.deepEqual(summary.unknownIntents, [crashed.intent.id]);
  assert.equal(recovered.getTask(crashed.taskId)!.status, 'reconciling');
  await f.restartExternal();
  // The observer explicitly reports unknown for the very record that carries a structured failure
  // payload. That payload is not proof the request failed, so the effect must stay unknown.
  const original = f.external.queryOutcome.bind(f.external);
  f.external.queryOutcome = async (effectKey: string, actionDigest?: string) => ({ ...await original(effectKey, actionDigest), status: 'unknown' as const, receipt: undefined });

  const turns: WireMessage[][] = [];
  const runner = new Runner(f.kernel, configuration(turns), candidates(), f.root, f.external);
  t.after(async () => { await runner.stop(); });
  runner.start();
  await until(() => f.kernel.events(crashed.taskId).filter(event => event.type === 'effect.reconciliation_required').length >= 1, 'the unknown observer status was never reconciled');
  await new Promise(resolve => setTimeout(resolve, 300));

  assert.equal(f.kernel.getIntent(crashed.intent.id)!.state, 'unknown', 'an unknown status is not convertible from an error payload');
  assert.equal(f.kernel.getTask(crashed.taskId)!.status, 'reconciling');
  assert.equal(f.kernel.events(crashed.taskId).filter(event => event.type === 'effect.failed').length, 0, 'no terminal failure is invented for an unknown status');
  assert.deepEqual(toolMessages(f.kernel, crashed.taskId, 'fetch-one'), [], 'no tool result is fabricated for an unknown status');
  assert.equal(dispatchEvents(f.kernel, crashed.taskId, 'fetch-one').length, 1);
  assert.deepEqual(f.counts, { robots: 1, pages: 1 }, 'reconciliation observes the persisted record without replaying the request');
  assert.equal(turns.length, 0, 'the model is never told a result for an unknown status');
});

