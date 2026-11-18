import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBackend } from '../src/app/backend.js';
import { ExternalTools } from '../src/app/external-tools.js';
import type { WebClientOptions } from '../src/network/index.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';

/**
 * Regression for the lost determinate network diagnostic: ExternalTools returns
 * {status:'failed', receipt:undefined, output:JSON.stringify({error:{...}})} and the Runner used to
 * persist only the free-text error, dropping code/tool/source/attempts from the effect and the task.
 * Every fixture transport is injected, so no test can reach the public network.
 */
const FIXTURE_ROOT = path.join(process.cwd(), '.tmp', 'network-integration', 'a', 'runner-network-diagnostics');
const PAGE_URL = 'https://www.example.org/page';
const PASS_REVIEW = JSON.stringify({ verdict: 'pass', reason: 'Mock independent review passed.', checks: [{ label: 'network_read', ok: true }] });
const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const systemOf = (body: any): string => String(body.messages?.find((message: any) => message.role === 'system')?.content ?? '');
const toolResults = (body: any): number => (body.messages ?? []).filter((message: any) => message.role === 'tool').length;

type Responder = NonNullable<MockProviderOptions['responder']>;

/** Injected transport only: an unexpected destination throws instead of leaving the fixture. */
function fixtureTransport(handler: (url: URL) => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => handler(new URL(String(input)))) as typeof fetch;
}
function unexpected(url: URL): never { throw new Error(`Unexpected fixture network request: ${url.href}`); }

async function fixture(t: import('node:test').TestContext, responder: Responder) {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const owned = mkdtempSync(path.join(FIXTURE_ROOT, 'case-'));
  const workspace = path.join(owned, 'workspace');
  mkdirSync(workspace);
  let modelCalls = 0;
  const backend = await startBackend({
    dataDir: path.join(owned, 'data'), projectRoot: process.cwd(),
    mockOptions: { responder: async (body, index) => { modelCalls++; return responder(body, index); } },
  });
  const instances: ExternalTools[] = [];
  t.after(async () => {
    await backend.close();
    for (const instance of instances) await instance.close();
    rmSync(owned, { recursive: true, force: true });
  });
  const call = async (method: string, route: string, input?: unknown, status = 200): Promise<any> => {
    const response = await fetch(`http://127.0.0.1:${backend.port}${route.startsWith('/v1') ? route : '/v1/harness' + route}`, {
      method, headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const until = async (read: () => Promise<any>, ready: (value: any) => boolean) => {
    const deadline = performance.now() + 20000; let value;
    do { value = await read(); if (ready(value)) return value; await sleep(25); } while (performance.now() < deadline);
    assert.fail(`Did not settle: ${JSON.stringify(value)}`);
  };
  /**
   * The Runner captured its network executor at construction, so the replacement must be installed
   * on both references; otherwise a diagnostic test would dispatch through the real transport.
   */
  const useNetwork = (webOptions: WebClientOptions): ExternalTools => {
    const instance = new ExternalTools({ dataDir: path.join(owned, 'network'), projectRoot: process.cwd(), webOptions });
    const wiring = backend.services as unknown as { external: ExternalTools; runner: { external?: ExternalTools } };
    wiring.external = instance;
    wiring.runner.external = instance;
    instances.push(instance);
    return instance;
  };
  return {
    call, until, workspace, useNetwork,
    modelCalls: () => modelCalls,
    async createTask(parameters: Record<string, unknown>) {
      const created = await call('POST', '/v1/commands', { commandId: randomUUID(), type: 'create_task', parameters: { workspace, objective: 'Network diagnostics fixture', permission: { mode: 'full-access', app: 'work' }, maxModelCalls: 20, ...parameters } });
      return created.taskId as string;
    },
    async snapshot(taskId: string) { return call('GET', `/v1/snapshot?taskId=${taskId}`); },
    async trace(taskId: string) { return call('GET', `/trace?taskId=${taskId}`); },
    async workRequest(taskId: string) { return (await call('GET', `/requests?taskId=${taskId}`)).requests.find((record: any) => record.kind === 'work'); },
  };
}

test('a determinate web_fetch failure persists its diagnostic, terminates the effect and answers the model once', { timeout: 40000 }, async t => {
  const counts = { robots: 0, pages: 0 };
  const f = await fixture(t, body => {
    if (systemOf(body).includes('REVIEWER ROLE')) return { content: PASS_REVIEW };
    if (toolResults(body) === 0) return { content: '', toolCalls: [{ id: 'fetch-one', name: 'web_fetch', arguments: { url: PAGE_URL } }] };
    return { content: 'The page could not be read, so no result was applied.' };
  });
  f.useNetwork({
    resolveDns: PUBLIC_DNS,
    fetch: fixtureTransport(url => {
      if (url.pathname === '/robots.txt') { counts.robots++; return new Response('', { status: 404 }); }
      counts.pages++;
      return new Response('', { status: 503 });
    }),
  });

  const taskId = await f.createTask({ objective: 'Fetch a page that is unavailable' });
  const settled = await f.until(() => f.snapshot(taskId), value => value.selectedTask.status === 'waiting_input');
  const intent = settled.intents[0];
  assert.equal(intent.state, 'failed', 'a determinate failure terminates the effect; it is never applied');
  assert.equal(intent.receipt, undefined, 'no receipt is fabricated for the failed effect');
  assert.equal(intent.failure.code, 'HTTP_FAILED');
  assert.equal(intent.failure.tool, 'web_fetch');
  assert.equal(intent.failure.source, 'network');
  const toolMessages = settled.messages.filter((message: any) => message.role === 'tool');
  assert.equal(toolMessages.length, 1, 'the model receives exactly one honest tool result');
  const toolResult = JSON.parse(String(toolMessages[0].content));
  assert.deepEqual(toolResult.error, { code: 'HTTP_FAILED', message: 'HTTP 503: request failed.', tool: 'web_fetch', source: 'network' });
  assert.equal(toolResult.executed, true, 'a dispatched request may already have reached the network');
  assert.equal(toolResult.effect, 'failed');
  assert.match(String(toolResult.recovery), /not retried automatically/);
  assert.notEqual(settled.selectedTask.status, 'reconciling', 'a determinate web failure does not park the task indefinitely');

  const trace = await f.trace(taskId);
  const dispatched = trace.events.filter((event: any) => event.type === 'tool.execution' && event.payload?.toolCallId === 'fetch-one');
  assert.equal(dispatched.length, 1, 'the dispatch is recorded exactly once');
  const patch = dispatched[0].payload.patch;
  assert.equal(patch.status, 'failed', 'the dispatch event records the failed status');
  assert.equal(patch.failureStage, 'execution', 'a returned failed outcome is an execution failure, not a validation one');
  assert.equal(patch.outcomeStatus, 'failed');
  assert.equal(typeof patch.durationMs, 'number');
  assert.equal(patch.code, 'HTTP_FAILED', 'the structured error code survives into the event');
  assert.equal(patch.tool, 'web_fetch');
  assert.equal(patch.source, 'network');
  assert.equal(patch.message, 'HTTP 503: request failed.');
  assert.equal(patch.attempts, undefined, 'a page fetch has no provider attempts');
  assert.equal(dispatched[0].payload.intentId, intent.id, 'the event is bound to the executed intent');
  assert.equal(dispatched[0].payload.runId, intent.runId);
  const work = await f.workRequest(taskId);
  assert.ok(work, 'the work model request is recorded');
  assert.equal(dispatched[0].payload.requestId, work.id, 'the failure is bound to the exact model request');
  assert.equal(dispatched[0].requestId, work.id, 'the trace row itself carries the request id');
  assert.match(String(intent.error), /^HTTP_FAILED: /, 'the persisted effect error carries the real code');
  assert.ok(!trace.events.some((event: any) => event.type === 'effect.receipted'), 'a determinate failure never records a receipt');
  assert.ok(trace.events.some((event: any) => event.type === 'effect.failed' && event.payload?.intentId === intent.id), 'the terminal transition is audited');

  const before = { ...counts };
  const modelCalls = f.modelCalls();
  await sleep(900);
  assert.deepEqual(counts, before, 'no automatic retry reaches the network');
  assert.equal(f.modelCalls(), modelCalls, 'the settled task makes no extra model request');
  const later = await f.snapshot(taskId);
  assert.equal(later.tasks.length, 1, 'no task is created for the failure');
  assert.equal(later.intents[0].state, 'failed', 'the effect stays terminal while the task waits for a decision');
  assert.equal(later.messages.filter((message: any) => message.role === 'tool').length, 1, 'the honest tool result is delivered exactly once');
  const laterTrace = await f.trace(taskId);
  assert.equal(laterTrace.events.filter((event: any) => event.type === 'tool.execution' && event.payload?.toolCallId === 'fetch-one').length, 1, 'no automatic redispatch');
});

test('an automatic search chain failure keeps every provider attempt and terminates the effect', { timeout: 40000 }, async t => {
  const calls = { exa: 0, mwmbl: 0, other: 0 };
  const f = await fixture(t, body => {
    if (systemOf(body).includes('REVIEWER ROLE')) return { content: PASS_REVIEW };
    if (toolResults(body) === 0) return { content: '', toolCalls: [{ id: 'search-one', name: 'web_search', arguments: { query: 'fixture network diagnostic' } }] };
    return { content: 'Search was unavailable, so no source was applied.' };
  });
  f.useNetwork({
    searchProvider: 'auto',
    resolveDns: PUBLIC_DNS,
    fetch: fixtureTransport(url => {
      if (url.hostname === 'mcp.exa.ai') { calls.exa++; return new Response('', { status: 429 }); }
      if (url.hostname === 'api.mwmbl.org') { calls.mwmbl++; return new Response('', { status: 429 }); }
      calls.other++;
      return unexpected(url);
    }),
  });

  const taskId = await f.createTask({ objective: 'Search the free providers after a rate limit' });
  const settled = await f.until(() => f.snapshot(taskId), value => value.selectedTask.status === 'waiting_input');
  const intent = settled.intents[0];
  assert.equal(intent.state, 'failed', 'the aggregated search failure is terminal, not left unknown');
  assert.equal(intent.receipt, undefined);
  assert.deepEqual(intent.failure.attempts.map((attempt: any) => [attempt.provider, attempt.errorCode]), [['exa', 'RATE_LIMITED'], ['mwmbl', 'RATE_LIMITED']]);
  const toolMessages = settled.messages.filter((message: any) => message.role === 'tool');
  assert.equal(toolMessages.length, 1);
  const toolResult = JSON.parse(String(toolMessages[0].content));
  assert.equal(toolResult.error.code, 'SEARCH_UNAVAILABLE');
  assert.equal(toolResult.effect, 'failed');
  assert.equal(toolResult.executed, true);
  assert.equal(settled.selectedTask.status, 'waiting_input');

  const trace = await f.trace(taskId);
  const dispatched = trace.events.filter((event: any) => event.type === 'tool.execution' && event.payload?.toolCallId === 'search-one');
  assert.equal(dispatched.length, 1);
  const patch = dispatched[0].payload.patch;
  assert.equal(patch.status, 'failed');
  assert.equal(patch.failureStage, 'execution');
  assert.equal(patch.outcomeStatus, 'failed');
  assert.equal(typeof patch.durationMs, 'number');
  assert.equal(patch.code, 'SEARCH_UNAVAILABLE', 'the aggregated search failure keeps its own code');
  assert.equal(patch.tool, 'web_search');
  assert.equal(patch.source, 'network');
  assert.match(String(patch.message), /No free search source returned results/);
  assert.deepEqual(patch.attempts.map((attempt: any) => [attempt.provider, attempt.errorCode]), [['exa', 'RATE_LIMITED'], ['mwmbl', 'RATE_LIMITED']], 'every attempted provider stays visible');
  assert.equal(dispatched[0].payload.intentId, intent.id);
  const work = await f.workRequest(taskId);
  assert.ok(work);
  assert.equal(dispatched[0].payload.requestId, work.id);
  assert.match(String(intent.error), /^SEARCH_UNAVAILABLE: /);
  assert.deepEqual(calls, { exa: 1, mwmbl: 1, other: 0 }, 'each free source is attempted once inside the frozen scope');

  const modelCalls = f.modelCalls();
  await sleep(900);
  assert.deepEqual(calls, { exa: 1, mwmbl: 1, other: 0 }, 'a failed search chain is not retried automatically');
  assert.equal(f.modelCalls(), modelCalls, 'the settled task makes no extra model request');
});

test('an applied web result still records a receipt, a tool message and a clean dispatch event', { timeout: 40000 }, async t => {
  const counts = { robots: 0, pages: 0 };
  const f = await fixture(t, body => {
    if (systemOf(body).includes('REVIEWER ROLE')) return { content: PASS_REVIEW };
    if (toolResults(body) === 0) return { content: '', toolCalls: [{ id: 'fetch-one', name: 'web_fetch', arguments: { url: PAGE_URL } }] };
    return { content: 'Read the page from the applied receipt.' };
  });
  f.useNetwork({
    resolveDns: PUBLIC_DNS,
    fetch: fixtureTransport(url => {
      if (url.pathname === '/robots.txt') { counts.robots++; return new Response('', { status: 404 }); }
      counts.pages++;
      return new Response('<title>Fixture page</title><main>Page evidence</main>', { headers: { 'content-type': 'text/html' } });
    }),
  });

  const taskId = await f.createTask({ objective: 'Fetch a reachable fixture page' });
  const settled = await f.until(() => f.snapshot(taskId), value => value.intents.some((item: any) => item.state === 'applied')
    && value.messages.some((message: any) => message.role === 'tool' && message.toolCallId === 'fetch-one'));
  const intent = settled.intents[0];
  assert.equal(intent.state, 'applied');
  assert.ok(intent.receipt, 'the applied receipt is recorded');
  assert.equal(intent.receipt.tool, 'web_fetch');
  assert.equal(intent.receipt.trust, 'untrusted');
  const message = settled.messages.find((item: any) => item.role === 'tool' && item.toolCallId === 'fetch-one');
  assert.ok(message, 'the applied outcome is delivered as a real tool message');
  const page = JSON.parse(String(message.content));
  assert.match(page.text, /Page evidence/);

  const trace = await f.trace(taskId);
  const dispatched = trace.events.filter((event: any) => event.type === 'tool.execution' && event.payload?.toolCallId === 'fetch-one');
  assert.equal(dispatched.length, 1);
  const patch = dispatched[0].payload.patch;
  assert.equal(typeof patch.durationMs, 'number');
  for (const field of ['status', 'failureStage', 'outcomeStatus', 'code', 'attempts', 'message'])
    assert.equal(patch[field], undefined, `the applied dispatch event must not carry ${field}`);
  assert.equal(dispatched[0].payload.intentId, intent.id);
  assert.ok(trace.events.some((event: any) => event.type === 'effect.receipted' && event.payload?.intentId === intent.id));
  assert.equal(counts.robots, 1);
  assert.equal(counts.pages, 1, 'the successful page is fetched exactly once');
});
