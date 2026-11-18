import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Kernel, KernelError, digest } from '../src/kernel/index.js';
import { ExternalTools } from '../src/app/external-tools.js';
import type { Intent, IntentFailure, ToolCall } from '../src/contracts.js';
import type { WebClientOptions } from '../src/network/index.js';
import type { ToolOutcome } from '../src/tools/gateway.js';

/**
 * Acceptance slice for the determinate read-only web failure: a dispatched web effect whose own
 * executor persisted a failed record becomes one durable terminal intent, never a receipt and never
 * a reconciling task. The Kernel, SQLite store and ExternalTools ledger are the real ones; every
 * transport is an injected deterministic fixture, so no test can reach the public network.
 */
const FIXTURE_ROOT = path.join(process.cwd(), '.tmp', 'network-integration', 'a', 'kernel-determinate-failure');
const PAGE_URL = 'https://www.example.org/page';
const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];
const isCode = (code: string) => (error: unknown): boolean => error instanceof KernelError && error.code === code;

type FetchHandler = (url: URL) => Response;

interface Fixture {
  readonly kernel: Kernel;
  readonly external: ExternalTools;
  readonly taskId: string;
  readonly runId: string;
  readonly workspace: string;
  readonly stateDir: string;
  liveTask(): { taskId: string; runId: string };
  dispatch(call: ToolCall, preparedFrom?: ToolCall): Promise<{ intent: Intent; outcome: ToolOutcome; digest: string }>;
  close(): Promise<void>;
}

function fixture(t: import('node:test').TestContext, label: string, options: { fetch?: FetchHandler; searchProvider?: string } = {}): Fixture {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const owned = mkdtempSync(path.join(FIXTURE_ROOT, label + '-'));
  const stateDir = path.join(owned, 'state');
  const workspace = path.join(owned, 'workspace');
  mkdirSync(stateDir);
  mkdirSync(workspace);
  const kernel = new Kernel(stateDir);
  const webOptions: WebClientOptions = {
    resolveDns: PUBLIC_DNS,
    fetch: ((async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (!options.fetch) throw new Error('Unexpected fixture network request: ' + url.href);
      return options.fetch(url);
    }) as typeof fetch),
    ...(options.searchProvider ? { searchProvider: options.searchProvider as never } : {}),
  };
  const external = new ExternalTools({ dataDir: path.join(owned, 'network'), projectRoot: process.cwd(), webOptions });
  const createRun = (): { taskId: string; runId: string } => {
    const taskId = kernel.command({ commandId: randomUUID(), type: 'create_task', parameters: {
      workspace, objective: 'Determinate network failure acceptance ' + label, permission: { mode: 'full-access', app: 'work' }, maxModelCalls: 20,
    } }).taskId!;
    kernel.transition(taskId, 'running');
    return { taskId, runId: kernel.createRun(taskId).id };
  };
  const live = createRun();
  const dispatch = async (call: ToolCall): Promise<{ intent: Intent; outcome: ToolOutcome; digest: string }> => {
    const message = kernel.addMessage(live.taskId, 'assistant', '', 'main', { toolCalls: [call] });
    const effectKey = digest({ taskId: live.taskId, messageId: message.id, toolCallId: call.id });
    const prepared = external.prepare(call)!;
    const intent = kernel.prepareIntent(live.taskId, live.runId, { ...call, arguments: prepared.arguments }, {
      effectKey, capability: prepared.capability, paths: [], resources: prepared.resources,
    });
    kernel.approve(intent.id, { source: 'policy' });
    kernel.dispatch(intent.id);
    const outcome = await external.execute(prepared, { effectKey, approvedDigest: prepared.digest });
    return { intent: kernel.getIntent(intent.id)!, outcome, digest: prepared.digest };
  };
  t.after(async () => {
    await external.close();
    kernel.close();
    rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return {
    kernel, external, workspace, stateDir, ...live, liveTask: createRun, dispatch,
    close: async () => { await external.close(); kernel.close(); },
  };
}

/** Shape one determinate failure exactly as the Runner derives it from the persisted outcome. */
function failureOf(outcome: ToolOutcome): IntentFailure {
  const error = (JSON.parse(outcome.output) as { error: Record<string, unknown> }).error;
  return {
    code: String(error.code), ...(typeof error.message === 'string' ? { message: error.message } : {}),
    tool: String(error.tool), source: 'network',
    ...(Array.isArray(error.attempts) ? { attempts: error.attempts } : {}),
    ...(typeof error.at === 'string' ? { at: error.at } : {}),
  };
}

function ledger(f: Fixture, intent: Intent): { effect: Record<string, unknown>; outbox: Record<string, unknown>; attempt: Record<string, unknown> } {
  const db = new DatabaseSync(path.join(f.stateDir, 'kernel.sqlite'));
  try {
    return {
      effect: db.prepare('SELECT state,receipt FROM effects WHERE effect_key=?').get(intent.effectKey) as Record<string, unknown>,
      outbox: db.prepare('SELECT state FROM outbox WHERE intent_id=?').get(intent.id) as Record<string, unknown>,
      attempt: db.prepare('SELECT state FROM attempts WHERE intent_id=? ORDER BY rowid DESC LIMIT 1').get(intent.id) as Record<string, unknown>,
    };
  } finally { db.close(); }
}

test('a determinate web_fetch failure becomes one durable terminal intent without a receipt', { timeout: 40000 }, async t => {
  const f = fixture(t, 'terminal-fetch', { fetch: url => url.pathname === '/robots.txt' ? new Response('', { status: 404 }) : new Response('', { status: 503 }) });
  const { intent, outcome } = await f.dispatch({ id: 'fetch-one', name: 'web_fetch', arguments: { url: PAGE_URL } });
  assert.equal(outcome.status, 'failed');
  assert.equal(intent.state, 'sent', 'the effect is dispatched before its outcome is known');
  const failure = failureOf(outcome);
  assert.equal(failure.code, 'HTTP_FAILED');

  const failed = f.kernel.failIntent(intent.id, failure);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.receipt, undefined, 'a failed effect never fabricates a receipt');
  assert.equal(failed.failure?.code, 'HTTP_FAILED');
  assert.equal(failed.failure?.tool, 'web_fetch');
  assert.equal(failed.failure?.source, 'network');
  assert.match(String(failed.error), /^HTTP_FAILED: /);
  assert.equal(typeof failed.failedAt, 'string');
  assert.equal(f.kernel.getTask(f.taskId)!.status, 'running', 'a resolved failed effect must not park the task in reconciliation');

  const events = f.kernel.events(f.taskId).filter(event => event.type === 'effect.failed');
  assert.equal(events.length, 1, 'the terminal transition is audited exactly once');
  assert.deepEqual({ intentId: events[0]!.payload.intentId, code: events[0]!.payload.code, tool: events[0]!.payload.tool, source: events[0]!.payload.source }, { intentId: intent.id, code: 'HTTP_FAILED', tool: 'web_fetch', source: 'network' });
  assert.equal(events[0]!.payload.effectKey, intent.effectKey);
  assert.equal(events[0]!.payload.message, failure.message);
  assert.equal(f.kernel.events(f.taskId).filter(event => event.type === 'effect.receipted').length, 0);

  const rows = ledger(f, intent);
  assert.equal(rows.effect.state, 'failed');
  assert.equal(rows.effect.receipt, null, 'the effects table holds no receipt for a failure');
  assert.equal(rows.outbox.state, 'failed');
  assert.equal(rows.attempt.state, 'failed');

  // The terminal record is idempotent for the identical diagnostic and refuses a different one.
  assert.equal(f.kernel.failIntent(intent.id, failure).state, 'failed');
  assert.equal(f.kernel.events(f.taskId).filter(event => event.type === 'effect.failed').length, 1, 'a repeated callback adds no second failure');
  assert.throws(() => f.kernel.failIntent(intent.id, { ...failure, code: 'TIMEOUT' }), isCode('FAILURE_CONFLICT'));

  // A failed effect is terminal: no replay, no receipt, and no second unknown conversion.
  assert.throws(() => f.kernel.dispatch(intent.id), isCode('INVALID_INTENT_STATE'));
  assert.throws(() => f.kernel.unknown(intent.id, 'retry'), isCode('INVALID_INTENT_STATE'));
  assert.throws(() => f.kernel.reconcile(intent.id, { output: 'invented' }), isCode('INVALID_INTENT_STATE'));
  assert.throws(() => f.kernel.receipt(intent.id, { output: 'invented' }), isCode('INVALID_INTENT_STATE'));
  assert.throws(() => f.kernel.approve(intent.id), isCode('INVALID_INTENT_STATE'));
  assert.equal(f.kernel.getIntent(intent.id)!.receipt, undefined);
});

test('a determinate search failure keeps every provider attempt in the terminal record', { timeout: 40000 }, async t => {
  const f = fixture(t, 'terminal-search', { searchProvider: 'auto', fetch: url => {
    if (url.hostname === 'mcp.exa.ai' || url.hostname === 'api.mwmbl.org') return new Response('', { status: 429 });
    throw new Error('Unexpected fixture network request: ' + url.href);
  } });
  const { intent, outcome } = await f.dispatch({ id: 'search-one', name: 'web_search', arguments: { query: 'fixture search failure' } });
  assert.equal(outcome.status, 'failed');
  const failure = failureOf(outcome);
  assert.equal(failure.code, 'SEARCH_UNAVAILABLE');
  const failed = f.kernel.failIntent(intent.id, failure);
  assert.equal(failed.state, 'failed');
  assert.deepEqual((failed.failure!.attempts as { provider: string; status: string }[]).map(attempt => [attempt.provider, attempt.status]), [['exa', 'error'], ['mwmbl', 'error']]);
  assert.equal((f.kernel.events(f.taskId).find(event => event.type === 'effect.failed')!.payload.attempts as unknown[]).length, 2);
});

test('only a dispatched read-only web effect may become a terminal failure', { timeout: 40000 }, async t => {
  const f = fixture(t, 'not-determinate', { fetch: url => url.pathname === '/robots.txt' ? new Response('', { status: 404 }) : new Response('', { status: 503 }) });
  const webFailure = (tool: string): IntentFailure => ({ code: 'HTTP_FAILED', message: 'fixture failure', tool, source: 'network' });

  // A prepared proposal that never dispatched is not an effect at all.
  const preparedCall: ToolCall = { id: 'pending-fetch', name: 'web_fetch', arguments: { url: PAGE_URL } };
  const prepared = f.external.prepare(preparedCall)!;
  const preparedIntent = f.kernel.prepareIntent(f.taskId, f.runId, { ...preparedCall, arguments: prepared.arguments }, { capability: prepared.capability, paths: [], resources: prepared.resources });
  assert.throws(() => f.kernel.failIntent(preparedIntent.id, webFailure('web_fetch')), isCode('INVALID_INTENT_STATE'));
  assert.equal(f.kernel.getIntent(preparedIntent.id)!.state, 'prepared');

  // A dispatched local read is dispatched but is not a network effect.
  const readIntent = f.kernel.prepareIntent(f.taskId, f.runId, { id: 'read-one', name: 'read_file', arguments: { path: 'notes.txt' } }, { paths: ['notes.txt'] });
  f.kernel.approve(readIntent.id, { source: 'policy' });
  f.kernel.dispatch(readIntent.id);
  assert.throws(() => f.kernel.failIntent(readIntent.id, webFailure('read_file')), isCode('NOT_DETERMINATE_FAILURE'));
  assert.equal(f.kernel.getIntent(readIntent.id)!.state, 'sent');

  // MCP effects stay non-terminal even when their own record says failed: the result may be a real side effect.
  const mcpIntent = f.kernel.prepareIntent(f.taskId, f.runId, { id: 'mcp-one', name: 'mcp_call', arguments: { serverId: 'fixture', toolName: 'tool', arguments: {} } }, { resources: ['mcp://fixture/tool'] });
  f.kernel.approve(mcpIntent.id, { source: 'policy' });
  f.kernel.dispatch(mcpIntent.id);
  assert.throws(() => f.kernel.failIntent(mcpIntent.id, webFailure('mcp_call')), isCode('NOT_DETERMINATE_FAILURE'));
  assert.throws(() => f.kernel.failIntent(mcpIntent.id, { code: 'MCP_FAILED', message: 'x', tool: 'mcp_call', source: 'mcp' } as unknown as IntentFailure), isCode('INVALID_FAILURE'));
  assert.equal(f.kernel.getIntent(mcpIntent.id)!.state, 'sent');

  // The diagnostic itself is validated: no free-form error can be turned into a terminal state.
  const { intent } = await f.dispatch({ id: 'fetch-shape', name: 'web_fetch', arguments: { url: PAGE_URL } });
  const invalid: [string, IntentFailure][] = [
    ['missing code', { code: '', message: 'x', tool: 'web_fetch', source: 'network' }],
    ['wrong tool', { code: 'HTTP_FAILED', message: 'x', tool: 'web_search', source: 'network' }],
    ['wrong source', { code: 'HTTP_FAILED', message: 'x', tool: 'web_fetch', source: 'mcp' } as unknown as IntentFailure],
    ['non-object attempt', { code: 'HTTP_FAILED', message: 'x', tool: 'web_fetch', source: 'network', attempts: ['not-an-object'] }],
  ];
  for (const [label, failure] of invalid) {
    assert.throws(() => f.kernel.failIntent(intent.id, failure), isCode('INVALID_FAILURE'), label);
    assert.equal(f.kernel.getIntent(intent.id)!.state, 'sent', label + ' must not mutate the intent');
    assert.equal(ledger(f, intent).effect.state, 'unknown', label + ' must not rewrite the effect');
  }
  assert.equal(f.kernel.failIntent(intent.id, webFailure('web_fetch')).state, 'failed');
});

test('a stale run, finished run or revoked generation cannot record a terminal failure', { timeout: 40000 }, async t => {
  const f = fixture(t, 'stale-fence', { fetch: url => url.pathname === '/robots.txt' ? new Response('', { status: 404 }) : new Response('', { status: 503 }) });
  const paused = f.liveTask();
  const prepared = f.external.prepare({ name: 'web_fetch', arguments: { url: PAGE_URL } })!;
  const message = f.kernel.addMessage(paused.taskId, 'assistant', '', 'main', { toolCalls: [{ id: 'paused-fetch', name: 'web_fetch', arguments: prepared.arguments }] });
  const effectKey = digest({ taskId: paused.taskId, messageId: message.id, toolCallId: 'paused-fetch' });
  const intent = f.kernel.prepareIntent(paused.taskId, paused.runId, { id: 'paused-fetch', name: 'web_fetch', arguments: prepared.arguments }, { effectKey, capability: prepared.capability, paths: [], resources: prepared.resources });
  f.kernel.approve(intent.id, { source: 'policy' });
  f.kernel.dispatch(intent.id);
  const outcome = await f.external.execute(prepared, { effectKey, approvedDigest: prepared.digest });
  const failure = failureOf(outcome);
  f.kernel.transition(paused.taskId, 'paused');
  assert.throws(() => f.kernel.failIntent(intent.id, failure), isCode('STALE_GENERATION'));
  assert.equal(f.kernel.getIntent(intent.id)!.state, 'sent', 'a stale run must not complete the effect as failed');

  const ended = f.liveTask();
  const preparedEnded = f.external.prepare({ name: 'web_fetch', arguments: { url: PAGE_URL } })!;
  const endedMessage = f.kernel.addMessage(ended.taskId, 'assistant', '', 'main', { toolCalls: [{ id: 'ended-fetch', name: 'web_fetch', arguments: preparedEnded.arguments }] });
  const endedKey = digest({ taskId: ended.taskId, messageId: endedMessage.id, toolCallId: 'ended-fetch' });
  const endedIntent = f.kernel.prepareIntent(ended.taskId, ended.runId, { id: 'ended-fetch', name: 'web_fetch', arguments: preparedEnded.arguments }, { effectKey: endedKey, capability: 'network.read', paths: [], resources: preparedEnded.resources });
  f.kernel.approve(endedIntent.id, { source: 'policy' });
  f.kernel.dispatch(endedIntent.id);
  f.kernel.finishRun(ended.runId, 'failed');
  assert.throws(() => f.kernel.failIntent(endedIntent.id, failure), isCode('STALE_GENERATION'));

  const revoked = f.liveTask();
  const preparedRevoked = f.external.prepare({ name: 'web_fetch', arguments: { url: PAGE_URL } })!;
  const revokedMessage = f.kernel.addMessage(revoked.taskId, 'assistant', '', 'main', { toolCalls: [{ id: 'revoked-fetch', name: 'web_fetch', arguments: preparedRevoked.arguments }] });
  const revokedKey = digest({ taskId: revoked.taskId, messageId: revokedMessage.id, toolCallId: 'revoked-fetch' });
  const revokedIntent = f.kernel.prepareIntent(revoked.taskId, revoked.runId, { id: 'revoked-fetch', name: 'web_fetch', arguments: preparedRevoked.arguments }, { effectKey: revokedKey, capability: 'network.read', paths: [], resources: preparedRevoked.resources });
  f.kernel.approve(revokedIntent.id, { source: 'policy' });
  f.kernel.dispatch(revokedIntent.id);
  f.kernel.command({ commandId: randomUUID(), type: 'revoke', taskId: revoked.taskId });
  assert.throws(() => f.kernel.failIntent(revokedIntent.id, failure), (error: unknown) => error instanceof KernelError && ['INVALID_INTENT_STATE', 'STALE_GENERATION'].includes(error.code));
  assert.equal(f.kernel.getIntent(revokedIntent.id)!.state, 'unknown', 'the revoked effect keeps its unknown reconciliation record');
});

test('unknown and applied effects are never convertible to a fabricated failure', { timeout: 40000 }, async t => {
  const failing = fixture(t, 'unknown-effect', { fetch: url => url.pathname === '/robots.txt' ? new Response('', { status: 404 }) : new Response('', { status: 503 }) });
  const { intent, outcome } = await failing.dispatch({ id: 'unknown-fetch', name: 'web_fetch', arguments: { url: PAGE_URL } });
  const failure = failureOf(outcome);
  failing.kernel.unknown(intent.id, 'Dispatch outcome is unknown');
  assert.equal(failing.kernel.getIntent(intent.id)!.state, 'unknown');
  assert.equal(failing.kernel.getTask(failing.taskId)!.status, 'reconciling');
  assert.throws(() => failing.kernel.failIntent(intent.id, failure), isCode('INVALID_INTENT_STATE'), 'the same path may not silently resolve an unknown effect');
  assert.equal(failing.kernel.getIntent(intent.id)!.state, 'unknown');
  assert.equal(failing.kernel.events(failing.taskId).filter(event => event.type === 'effect.failed').length, 0);

  // Reconciliation itself still demands its own observation before an unknown effect can settle.
  assert.equal(failing.kernel.reconcile(intent.id).state, 'unknown');
  assert.equal(failing.kernel.events(failing.taskId).filter(event => event.type === 'effect.reconciliation_required').length, 1);
  assert.throws(() => failing.kernel.reconcileFailure(intent.id, { ...failure, tool: 'web_fetch', code: '' }), isCode('INVALID_FAILURE'));
  const resolved = failing.kernel.reconcileFailure(intent.id, failure);
  assert.equal(resolved.state, 'failed');
  assert.equal(resolved.failure?.code, 'HTTP_FAILED');
  assert.equal(failing.kernel.getTask(failing.taskId)!.status, 'queued', 'a resolved observed failure releases the task instead of parking it forever');
  assert.doesNotThrow(() => failing.kernel.createRun(failing.taskId));
  assert.equal(failing.kernel.reconcileFailure(intent.id, failure).state, 'failed', 'repeated reconciliation is idempotent');

  const applied = fixture(t, 'applied-effect', { fetch: url => url.pathname === '/robots.txt' ? new Response('', { status: 404 }) : new Response('<title>ok</title><main>Applied evidence</main>', { headers: { 'content-type': 'text/html' } }) });
  const success = await applied.dispatch({ id: 'applied-fetch', name: 'web_fetch', arguments: { url: PAGE_URL } });
  assert.equal(success.outcome.status, 'applied');
  const receipt = applied.kernel.receipt(success.intent.id, success.outcome.receipt!);
  assert.equal(receipt.state, 'applied');
  assert.throws(() => applied.kernel.failIntent(success.intent.id, failure), isCode('INVALID_INTENT_STATE'), 'an applied effect keeps its real receipt');
  assert.deepEqual(applied.kernel.getIntent(success.intent.id)!.receipt, success.outcome.receipt);
});

test('a reconciled failure path refuses a sent intent and a non-web unknown effect', { timeout: 40000 }, async t => {
  const f = fixture(t, 'reconcile-guards', { fetch: url => url.pathname === '/robots.txt' ? new Response('', { status: 404 }) : new Response('', { status: 503 }) });
  const { intent, outcome } = await f.dispatch({ id: 'sent-fetch', name: 'web_fetch', arguments: { url: PAGE_URL } });
  const failure = failureOf(outcome);
  assert.throws(() => f.kernel.reconcileFailure(intent.id, failure), isCode('INVALID_INTENT_STATE'), 'a disposable sent effect must go through the fenced terminal transition');

  const read = f.kernel.prepareIntent(f.taskId, f.runId, { id: 'read-unknown', name: 'read_file', arguments: { path: 'notes.txt' } }, { paths: ['notes.txt'] });
  f.kernel.approve(read.id, { source: 'policy' });
  f.kernel.dispatch(read.id);
  f.kernel.unknown(read.id, 'Dispatch outcome is unknown');
  assert.throws(() => f.kernel.reconcileFailure(read.id, { code: 'HTTP_FAILED', message: 'x', tool: 'read_file', source: 'network' }), isCode('NOT_DETERMINATE_FAILURE'));
  assert.equal(f.kernel.getIntent(read.id)!.state, 'unknown');
});
