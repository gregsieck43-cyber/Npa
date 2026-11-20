import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { ModelClient, ModelDiagnosticError, type ModelDelta } from '../src/runtime/model.js';
import { startMockProvider, type MockFault } from '../src/fixtures/mock-provider.js';
import { TOOL_DEFINITIONS, rolePrompt, toWireMessages } from '../src/runtime/prompts.js';
import { buildContext } from '../src/runtime/context.js';
import { workingContextBudget } from '../src/runtime/context-budget.js';
import { EXTERNAL_TOOL_DEFINITIONS } from '../src/app/external-tools.js';
import type { GoalContract, Message } from '../src/contracts.js';

const goal: GoalContract = { objective: 'Write result.txt', constraints: [], acceptance: ['file exists'], maxModelCalls: 5, mode: 'collaborative' };
const user = [{ role: 'system' as const, content: rolePrompt('main', goal) }, { role: 'user' as const, content: 'Write result.txt' }];
test('working context reserves configured output and tool schemas and keeps Chinese requests within the byte cap', () => {
  const tools = [...TOOL_DEFINITIONS, ...EXTERNAL_TOOL_DEFINITIONS];
  const client = new ModelClient({ maxRequestBytes: 65536, maxOutputTokens: 2048, contextWindowTokens: 65536 });
  const budget = workingContextBudget(client.config, tools);
  const messages: Message[] = [{ id: 'large-user', taskId: 'task', sessionId: 'main', role: 'user', content: '中文证据'.repeat(20000), createdAt: 'now' }];
  const context = buildContext({ messages, goal, role: 'main', maxChars: budget });
  assert.ok(Buffer.byteLength(JSON.stringify(client.buildBody(context.messages, tools))) <= 65536);
  assert.ok(context.sourceManifest[0]!.truncated);
  assert.ok(workingContextBudget({ contextWindowTokens: 20000, maxOutputTokens: 1024 }) > workingContextBudget({ contextWindowTokens: 20000, maxOutputTokens: 8192 }));
  assert.throws(() => workingContextBudget({ contextWindowTokens: 4096, maxOutputTokens: 4096 }, tools), /cannot fit/);
});
async function streamServer(t: TestContext, send: (response: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer(async (request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    await send(response);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/provider/v1`;
}
const event = (delta: unknown, finishReason: string | null = null): string =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
test('HTTP SSE wire reconstructs tool arguments, usage and tool-result continuation', async () => {
  const provider = await startMockProvider();
  try {
    const client = new ModelClient({ mode: 'mock', baseUrl: provider.url });
    const result = await client.complete(user, TOOL_DEFINITIONS);
    assert.equal(result.finishReason, 'tool_calls'); assert.equal(result.toolCalls[0]?.name, 'write_file');
    assert.equal(result.toolCalls[0]?.arguments.path, 'result.txt'); assert.ok(result.usage?.total_tokens);
    const next = await client.complete([...user, { role: 'assistant', content: null, tool_calls: result.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) },
      { role: 'tool', tool_call_id: result.toolCalls[0]!.id, content: '{"receipt":"applied"}' }], TOOL_DEFINITIONS);
    assert.equal(next.finishReason, 'stop'); assert.equal(next.toolCalls.length, 0); assert.equal(provider.requests(), 2);
  } finally { await provider.close(); }
});
test('JSON provider response is supported through the same wire', async () => {
  const provider = await startMockProvider({ stream: false });
  try {
    const deltas: ModelDelta[] = [];
    const result = await new ModelClient({ mode: 'mock', baseUrl: provider.url }).complete(user, TOOL_DEFINITIONS, undefined, delta => deltas.push(delta));
    assert.equal(result.toolCalls[0]?.name, 'write_file');
    assert.equal(deltas.length, 1); assert.equal(deltas[0]?.toolCalls?.[0]?.name, 'write_file');
  }
  finally { await provider.close(); }
});
test('JSON responses exceeding the byte cap are cancelled before EOF instead of buffering until timeout', { timeout: 10000 }, async t => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++; request.resume(); response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write(' '.repeat(4_000_001)); // Deliberately leave the response open after exceeding the cap.
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const client = new ModelClient({ mode: 'mock', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, timeoutMs: 2000 });
  await assert.rejects(client.complete(user), error => error instanceof ModelDiagnosticError && error.code === 'invalid_response' && /size limit/.test(error.message));
  assert.equal(requests, 1, 'Oversized results must not trigger an implicit retry');
});

test('real HTTP chunks deliver parsed Unicode content and tool fragments before the stream completes', { timeout: 10_000 }, async t => {
  let firstBytesSent!: () => void, releaseFirstTail!: () => void, releaseFinal!: () => void;
  const bytesSent = new Promise<void>(resolve => { firstBytesSent = resolve; });
  const firstTail = new Promise<void>(resolve => { releaseFirstTail = resolve; });
  const final = new Promise<void>(resolve => { releaseFinal = resolve; });
  t.after(() => { releaseFirstTail(); releaseFinal(); });
  const first = Buffer.from(event({ content: '中文🙂', tool_calls: [{ index: 0, id: 'stream-call', function: { name: 'read_file', arguments: '{"path":' } }] }));
  const split = first.findIndex(byte => byte > 127) + 1;
  const baseUrl = await streamServer(t, async response => {
    response.write(first.subarray(0, split)); firstBytesSent();
    await firstTail;
    if (response.destroyed) return;
    response.write(first.subarray(split));
    await final;
    if (response.destroyed) return;
    response.end(event({ content: ' 完整', tool_calls: [{ index: 0, function: { arguments: '"alpha.txt"}' } }] }, 'tool_calls') + 'data: [DONE]\n\n');
  });
  const deltas: ModelDelta[] = [];
  let firstDelta!: () => void, completed = false;
  const received = new Promise<void>(resolve => { firstDelta = resolve; });
  const pending = new ModelClient({ mode: 'mock', baseUrl }).complete(user, TOOL_DEFINITIONS, AbortSignal.timeout(5000), delta => {
    deltas.push(delta); firstDelta();
  }).then(result => { completed = true; return result; });
  await bytesSent;
  assert.equal(deltas.length, 0, 'An incomplete UTF-8/JSON event must not produce a delta');
  releaseFirstTail();
  await Promise.race([received, pending.then(() => assert.fail('Stream completed before delivering its first delta'))]);
  assert.equal(completed, false);
  assert.deepEqual(deltas[0], { content: '中文🙂', toolCalls: [{ index: 0, id: 'stream-call', name: 'read_file', arguments: '{"path":' }] });
  releaseFinal();
  const result = await pending;
  assert.equal(result.content, '中文🙂 完整');
  assert.equal(result.toolCalls[0]?.arguments.path, 'alpha.txt');
  assert.equal(deltas.length, 2); assert.equal(deltas[1]?.toolCalls?.[0]?.arguments, '"alpha.txt"}');
});
test('cancelling after an actual streamed delta rejects the partial result', { timeout: 10_000 }, async t => {
  const baseUrl = await streamServer(t, response => { response.write(event({ content: 'Partial 中文🙂' })); });
  const controller = new AbortController();
  const deltas: ModelDelta[] = [];
  let firstDelta!: () => void;
  const received = new Promise<void>(resolve => { firstDelta = resolve; });
  const pending = new ModelClient({ mode: 'mock', baseUrl }).complete(user, TOOL_DEFINITIONS, controller.signal, delta => {
    deltas.push(delta); firstDelta();
  });
  await Promise.race([received, pending.then(() => assert.fail('An unfinished provider stream cannot complete'))]);
  controller.abort();
  await assert.rejects(pending, error => error instanceof ModelDiagnosticError && error.code === 'cancelled');
  assert.deepEqual(deltas, [{ content: 'Partial 中文🙂' }]);
});
test('cancellation from a final JSON delta still prevents accepting the result', async () => {
  const provider = await startMockProvider({ stream: false });
  const controller = new AbortController();
  try {
    await assert.rejects(new ModelClient({ mode: 'mock', baseUrl: provider.url }).complete(user, TOOL_DEFINITIONS, controller.signal, () => controller.abort()),
      error => error instanceof ModelDiagnosticError && error.code === 'cancelled');
  } finally { await provider.close(); }
});
for (const [fault, code] of [
  ['unauthorized', 'unauthorized'], ['rate_limit', 'rate_limited'], ['server_error', 'provider_unavailable'],
  ['bad_json', 'invalid_response'], ['bad_tool_json', 'invalid_response'], ['truncated_stream', 'truncated_stream'], ['disconnect', 'connection_failed'], ['timeout', 'timeout'],
] as [MockFault, string][]) {
  test(`provider fault ${fault} is diagnosed without transparent retries`, async () => {
    const provider = await startMockProvider({ fault });
    try {
      const client = new ModelClient({ mode: 'mock', baseUrl: provider.url, timeoutMs: fault === 'timeout' ? 30 : 1000 });
      await assert.rejects(client.complete(user, TOOL_DEFINITIONS), error => {
        assert.ok(error instanceof ModelDiagnosticError); assert.equal(error.code, code);
        if (fault === 'rate_limit') assert.equal(error.retryAfterMs, 2000); return true;
      });
      assert.equal(provider.requests(), 1);
    } finally { await provider.close(); }
  });
}
test('cancellation aborts in-flight HTTP and never accepts partial response', async () => {
  const provider = await startMockProvider({ fault: 'timeout' });
  const abort = new AbortController();
  try {
    const pending = new ModelClient({ mode: 'mock', baseUrl: provider.url }).complete(user, TOOL_DEFINITIONS, abort.signal);
    setTimeout(() => abort.abort(), 25);
    await assert.rejects(pending, error => error instanceof ModelDiagnosticError && error.code === 'cancelled');
  } finally { await provider.close(); }
});
test('live mode requires session credential before making a request', async () => {
  await assert.rejects(new ModelClient().complete(user), error => error instanceof ModelDiagnosticError && error.code === 'credential_required');
});
test('request limits count Chinese UTF-8 bytes and reject oversized input without HTTP dispatch', async () => {
  const provider = await startMockProvider();
  try {
    const client = new ModelClient({ mode: 'mock', baseUrl: provider.url, maxRequestBytes: 4096 });
    const content = '汉'.repeat(3000);
    assert.ok(content.length < 4096 && Buffer.byteLength(content, 'utf8') > 4096);
    await assert.rejects(client.complete([{ role: 'user', content }]), error => {
      assert.ok(error instanceof ModelDiagnosticError); assert.equal(error.code, 'input_limit');
      assert.equal(error.retryable, false); return true;
    });
    await assert.rejects(client.complete([{ role: 'user', content: 'Small message; full tool schemas still consume input bytes.' }], [...TOOL_DEFINITIONS, ...EXTERNAL_TOOL_DEFINITIONS]),
      error => error instanceof ModelDiagnosticError && error.code === 'input_limit');
    assert.equal(provider.requests(), 0);
  } finally { await provider.close(); }
});
test('actual HTTP request includes every tool schema and the configured output token bound', async () => {
  const requests: any[] = [];
  const provider = await startMockProvider({ trace: body => requests.push(body), responder: () => ({ content: 'Bounded response.' }) });
  try {
    const tools = [...TOOL_DEFINITIONS, ...EXTERNAL_TOOL_DEFINITIONS];
    const client = new ModelClient({ mode: 'mock', baseUrl: provider.url, maxOutputTokens: 64, maxRequestBytes: 262_144 });
    assert.equal((await client.complete(user, tools)).content, 'Bounded response.');
    assert.equal(requests.length, 1); assert.deepEqual(requests[0].tools, tools);
    assert.equal(requests[0].max_tokens, 64); assert.equal(requests[0].tool_choice, 'auto');
    for (const name of ['delegate', 'ask_user', 'list_delegations', 'wait_for_children', 'accept_child_result', 'cancel_child', 'dismiss_child', 'list_mcp_tools', 'list_plugins', 'plugin_transform', 'web_search', 'mcp_call']) {
      assert.ok(requests[0].tools.some((tool: any) => tool.function.name === name), `${name} must reach the provider`);
    }
  } finally { await provider.close(); }
});
test('raw model requests cannot exceed or remove the profile output allowance or substitute a model', async () => {
  const provider = await startMockProvider();
  try {
    const client = new ModelClient({ mode: 'mock', baseUrl: provider.url, model: 'authorized-model', maxOutputTokens: 512 });
    const base = client.buildBody(user);
    for (const body of [
      { ...base, max_tokens: 131072 },
      { ...base, max_tokens: undefined, max_completion_tokens: 513 },
      { ...base, max_tokens: undefined },
      { ...base, model: 'different-unapproved-model' },
    ]) await assert.rejects(client.completeRaw(body), error => error instanceof ModelDiagnosticError && !error.retryable && /profile/.test(error.message));
    assert.equal(provider.requests(), 0, 'Rejected edits must never reach the transport');
    await client.completeRaw({ ...base, max_tokens: undefined, max_completion_tokens: 512 });
    await client.completeRaw({ ...base, max_tokens: 128 });
    assert.equal(provider.requests(), 2, 'A smaller explicit cap and the alternative output field remain supported');
  } finally { await provider.close(); }
});

test('model configuration validates input and output limits before any request', () => {
  assert.equal(new ModelClient().config.maxRequestBytes, 131_072);
  assert.equal(new ModelClient().config.maxOutputTokens, 4096);
  for (const maxOutputTokens of [63, 131073, 64.5, NaN]) {
    assert.throws(() => new ModelClient({ maxOutputTokens }), /maxOutputTokens/);
  }
  for (const maxRequestBytes of [4095, 262_145, 5000.5, NaN]) {
    assert.throws(() => new ModelClient({ maxRequestBytes }), /maxRequestBytes/);
  }
  assert.equal(new ModelClient({ maxOutputTokens: 131072, maxRequestBytes: 4096 }).config.maxOutputTokens, 131072);
});
test('role prompts enforce side ownership and wire tool call relationships', () => {
  assert.match(rolePrompt('side', goal), /no ownership/); assert.match(rolePrompt('reviewer', goal), /Missing, stale/);
  assert.match(rolePrompt('main', { ...goal, mode: 'autonomous' }), /at most three.*initial_clarification/);
  assert.match(rolePrompt('main', goal), /COLLABORATIVE MODE:.*each important stage/);
  const messages: Message[] = [{ id: '1', taskId: 'task', sessionId: 'main', role: 'assistant', content: '', createdAt: 'now', toolCalls: [{ id: 'call', name: 'read_file', arguments: { path: 'x' } }] },
    { id: '2', taskId: 'task', sessionId: 'main', role: 'tool', content: 'data', createdAt: 'now', toolCallId: 'call' }];
  const wire = toWireMessages(messages); assert.equal(wire[0]?.tool_calls?.[0]?.id, wire[1]?.tool_call_id);
});
test('bounded context preserves raw history and contains source manifest', () => {
  const messages: Message[] = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, taskId: 'task', sessionId: 'main', role: i % 2 ? 'assistant' : 'user', content: `Raw ${i} `.repeat(140), createdAt: 'now' }));
  const raw = JSON.stringify(messages);
  const result = buildContext({ messages, goal, role: 'main', maxChars: 4500, retrieve: [messages[0]!] });
  assert.equal(JSON.stringify(messages), raw); assert.equal(result.sourceManifest.length, 12); assert.ok(result.omittedIds.length);
  assert.ok(JSON.stringify(result.messages).length <= 4500); assert.equal(result.sourceManifest[0]?.sha256.length, 64);
  assert.throws(() => buildContext({ messages, goal: { ...goal, objective: 'x'.repeat(10_000) }, role: 'main', maxChars: 2048 }), /budget/);
});
test('working summaries are source-bound, separate from raw messages, and cannot replace the goal', () => {
  const message: Message = { id: 'raw', taskId: 'task', sessionId: 'main', role: 'user', content: 'original evidence', createdAt: 'now' };
  const summary = { text: 'A disposable memory projection', sourceIds: ['raw'], createdAt: 'now' };
  const context = buildContext({ messages: [message], goal, role: 'main', summary });
  assert.match(context.messages[0]!.content!, /Write result.txt/); assert.ok(context.messages.some(item => item.content?.includes('Untrusted working memory')));
  assert.equal(message.content, 'original evidence');
  const stale = buildContext({ messages: [message], goal, role: 'main', summary: { ...summary, sourceIds: ['missing'] } });
  assert.equal(stale.summary, undefined);
});
