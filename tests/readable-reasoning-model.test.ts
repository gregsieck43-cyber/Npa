import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import type { Message, ModelResult, WireMessage } from '../src/contracts.js';
import { ModelClient, ModelDiagnosticError, type ModelDelta } from '../src/runtime/model.js';

const user: WireMessage[] = [{ role: 'user', content: 'Explain the approved file result.' }];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

interface LocalProvider { url: string; requests: any[] }

async function provider(t: TestContext, handler: (body: any, response: ServerResponse) => void | Promise<void>): Promise<LocalProvider> {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    request.setEncoding('utf8');
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    await handler(body, response);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/provider/v1`, requests };
}

const event = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
const replyJson = (response: ServerResponse, body: unknown): void => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};

test('Chat Completions JSON keeps reasoning_content beside content, tool calls, usage and finish reason', async t => {
  const { url } = await provider(t, (_body, response) => replyJson(response, {
    choices: [{ index: 0, message: {
      role: 'assistant', content: 'Wrote result.txt.',
      reasoning_content: 'The receipt exists, so answer and keep the tool call.',
      tool_calls: [{ id: 'call_json', type: 'function', function: { name: 'write_file', arguments: '{"path":"result.txt","content":"ok"}' } }],
    }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, completion_tokens_details: { reasoning_tokens: 4 } },
  }));
  const deltas: ModelDelta[] = [];
  const result = await new ModelClient({ mode: 'mock', baseUrl: url }).complete(user, [], undefined, delta => deltas.push(delta));
  assert.equal(result.content, 'Wrote result.txt.');
  assert.equal(result.reasoningContent, 'The receipt exists, so answer and keep the tool call.');
  assert.equal(result.toolCalls[0]?.name, 'write_file');
  assert.deepEqual(result.toolCalls[0]?.arguments, { path: 'result.txt', content: 'ok' });
  assert.deepEqual(result.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, completion_tokens_details: { reasoning_tokens: 4 } });
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0]?.reasoningContent, result.reasoningContent);
  assert.equal(deltas[0]?.content, result.content);
  assert.equal(deltas[0]?.toolCalls?.[0]?.name, 'write_file');
});

test('SSE reasoning-only deltas are observable before the answer and aggregate without duplication', { timeout: 10_000 }, async t => {
  const release = deferred();
  const { url } = await provider(t, async (_body, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(event({ reasoning_content: 'Compare both options. ' }));
    await release.promise;
    if (response.destroyed) return;
    response.write(event({ reasoning_content: 'Choose the bounded one.' }));
    response.write(event({ content: 'Bounded answer.' }));
    response.write(event({}, 'stop'));
    response.write('data: [DONE]\n\n');
    response.end();
  });
  const deltas: ModelDelta[] = [];
  let observed!: () => void;
  const firstDelta = new Promise<void>(resolve => { observed = resolve; });
  const pending = new ModelClient({ mode: 'mock', baseUrl: url }).complete(user, [], undefined, delta => {
    deltas.push(delta);
    observed();
  });
  await Promise.race([firstDelta, pending.then(() => assert.fail('Stream completed before its first reasoning delta'))]);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0]?.reasoningContent, 'Compare both options. ');
  assert.equal('content' in deltas[0]!, false);
  assert.equal('toolCalls' in deltas[0]!, false);
  release.resolve();
  const result = await pending;
  assert.equal(result.reasoningContent, 'Compare both options. Choose the bounded one.');
  assert.equal(result.content, 'Bounded answer.');
  assert.equal(result.finishReason, 'stop');
  assert.equal(deltas.length, 3);
  assert.equal(deltas[1]?.reasoningContent, 'Choose the bounded one.');
  assert.equal(deltas[1]?.content, undefined);
  assert.equal(deltas[2]?.content, 'Bounded answer.');
});

test('SSE tool calls stay reconstructible when reasoning arrives first', async t => {
  const { url } = await provider(t, (_body, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(event({ reasoning_content: 'Plan: one write_file call.' }));
    response.write(event({ tool_calls: [{ index: 0, id: 'call_stream', type: 'function', function: { name: 'write_file', arguments: '{"path":"result.txt",' } }] }));
    response.write(event({ tool_calls: [{ index: 0, function: { arguments: '"content":"ok"}' } }] }, 'tool_calls'));
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 } })}\n\n`);
    response.write('data: [DONE]\n\n');
    response.end();
  });
  const deltas: ModelDelta[] = [];
  const result = await new ModelClient({ mode: 'mock', baseUrl: url }).complete(user, [], undefined, delta => deltas.push(delta));
  assert.equal(result.reasoningContent, 'Plan: one write_file call.');
  assert.equal(result.content, '');
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.toolCalls, [{ id: 'call_stream', name: 'write_file', arguments: { path: 'result.txt', content: 'ok' } }]);
  assert.deepEqual(result.usage, { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 });
  assert.deepEqual(deltas[0], { reasoningContent: 'Plan: one write_file call.' });
  assert.equal(deltas[1]?.toolCalls?.[0]?.name, 'write_file');
  assert.equal(deltas[2]?.toolCalls?.[0]?.arguments, '"content":"ok"}');
});

test('old responses without reasoning keep their previous shape and never guess from <think> text', async t => {
  const jsonProvider = await provider(t, (_body, response) => replyJson(response, {
    choices: [{ index: 0, message: { role: 'assistant', content: '<think>literal answer text</think>', reasoning_content: null }, finish_reason: 'stop' }],
    usage: { total_tokens: 3 },
  }));
  const jsonDeltas: ModelDelta[] = [];
  const jsonResult = await new ModelClient({ mode: 'mock', baseUrl: jsonProvider.url }).complete(user, [], undefined, delta => jsonDeltas.push(delta));
  assert.equal(jsonResult.content, '<think>literal answer text</think>');
  assert.equal(jsonResult.reasoningContent, undefined);
  assert.equal('reasoningContent' in jsonResult, false);
  assert.equal(jsonDeltas.length, 1);
  assert.equal('reasoningContent' in jsonDeltas[0]!, false);

  const streamProvider = await provider(t, (_body, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(event({ reasoning_content: null }));
    response.write(event({ reasoning_content: '' }));
    response.write(event({ content: '<think>literal answer text</think>' }));
    response.write(event({}, 'stop'));
    response.write('data: [DONE]\n\n');
    response.end();
  });
  const streamDeltas: ModelDelta[] = [];
  const streamResult = await new ModelClient({ mode: 'mock', baseUrl: streamProvider.url }).complete(user, [], undefined, delta => streamDeltas.push(delta));
  assert.equal(streamResult.content, '<think>literal answer text</think>');
  assert.equal(streamResult.reasoningContent, undefined);
  assert.equal('reasoningContent' in streamResult, false);
  assert.deepEqual(streamDeltas, [{ content: '<think>literal answer text</think>' }]);
});

test('malformed reasoning values are diagnosed instead of inferred', async t => {
  const jsonProvider = await provider(t, (_body, response) => replyJson(response, {
    choices: [{ index: 0, message: { role: 'assistant', content: 'x', reasoning_content: { text: 'hidden' } }, finish_reason: 'stop' }],
  }));
  await assert.rejects(new ModelClient({ mode: 'mock', baseUrl: jsonProvider.url }).complete(user),
    error => error instanceof ModelDiagnosticError && error.code === 'invalid_response' && /reasoning_content/.test(error.message));

  const streamProvider = await provider(t, (_body, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(event({ reasoning_content: 42 }));
    response.write(event({}, 'stop'));
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await assert.rejects(new ModelClient({ mode: 'mock', baseUrl: streamProvider.url }).complete(user),
    error => error instanceof ModelDiagnosticError && error.code === 'invalid_response' && /reasoning/.test(error.message));
});

test('the 4 MB response cap covers reasoning-only streams', { timeout: 15_000 }, async t => {
  const { url } = await provider(t, (_body, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(event({ reasoning_content: 'Start of a very long thought. ' }));
    const filler = 'x'.repeat(64_000);
    for (let index = 0; index < 70; index++) {
      if (response.destroyed) return;
      response.write(event({ reasoning_content: filler }));
    }
  });
  await assert.rejects(new ModelClient({ mode: 'mock', baseUrl: url, timeoutMs: 10_000 }).complete(user),
    error => error instanceof ModelDiagnosticError && error.code === 'invalid_response' && /size limit/.test(error.message));
});

test('cancelling after a reasoning-only delta rejects the partial result', { timeout: 10_000 }, async t => {
  const { url } = await provider(t, (_body, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(event({ reasoning_content: 'Partial thought before cancel.' }));
  });
  const controller = new AbortController();
  const deltas: ModelDelta[] = [];
  let observed!: () => void;
  const firstDelta = new Promise<void>(resolve => { observed = resolve; });
  const pending = new ModelClient({ mode: 'mock', baseUrl: url }).complete(user, [], controller.signal, delta => {
    deltas.push(delta);
    observed();
  });
  await Promise.race([firstDelta, pending.then(() => assert.fail('Stream completed before cancellation'))]);
  controller.abort();
  await assert.rejects(pending, error => error instanceof ModelDiagnosticError && error.code === 'cancelled');
  assert.deepEqual(deltas, [{ reasoningContent: 'Partial thought before cancel.' }]);
});

test('assistant reasoning is accepted on the request wire, must be text, and never appears by default', async t => {
  const { url, requests } = await provider(t, (_body, response) => replyJson(response, {
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  }));
  const client = new ModelClient({ mode: 'mock', baseUrl: url, model: 'reasoning/wire-check', maxRequestBytes: 4096 });
  const continuation = client.buildBody([
    { role: 'user', content: 'Continue after the approved tool result.' },
    { role: 'assistant', content: null, reasoning_content: 'The receipt was applied, so continue.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"result.txt"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
  ]);
  await client.completeRaw(continuation);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages[1].reasoning_content, 'The receipt was applied, so continue.');

  const plain = client.buildBody([{ role: 'user', content: 'No prior thought.' }]);
  assert.equal('reasoning_content' in plain.messages[0], false);
  await client.completeRaw(plain);
  assert.equal(requests.length, 2);
  assert.equal('reasoning_content' in requests[1].messages[0], false);

  const rejected: [string, any[]][] = [
    ['system', [{ role: 'system', content: 'Rules', reasoning_content: 'hidden' }]],
    ['user', [{ role: 'user', content: 'Hello', reasoning_content: 'hidden' }]],
    ['tool', [{ role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}', reasoning_content: 'hidden' }]],
    ['non-string assistant', [{ role: 'assistant', content: 'Answer', reasoning_content: { text: 'hidden' } }]],
  ];
  for (const [label, messages] of rejected) {
    await assert.rejects(client.completeRaw(client.buildBody(messages)), error =>
      error instanceof ModelDiagnosticError && error.code === 'invalid_response' && /reasoning_content/.test(error.message),
    `${label} reasoning_content must be rejected`);
  }
  assert.equal(requests.length, 2, 'Rejected request bodies never reach the provider');

  const oversized = client.buildBody([{ role: 'user', content: 'Go' }, { role: 'assistant', content: 'Done', reasoning_content: '长'.repeat(5000) }]);
  await assert.rejects(client.completeRaw(oversized), error => error instanceof ModelDiagnosticError && error.code === 'input_limit');
  assert.equal(requests.length, 2, 'Reasoning text still counts toward the request byte limit');
});

test('the shared contracts expose readable reasoning text without changing existing fields', () => {
  const message: Message = { id: 'm1', taskId: 'task', sessionId: 'main', role: 'assistant', content: 'Answer', reasoningContent: 'Readable thought.', createdAt: 'now' };
  const result: ModelResult = { content: 'Answer', toolCalls: [], finishReason: 'stop', reasoningContent: 'Readable thought.' };
  const wire: WireMessage = { role: 'assistant', content: null, reasoning_content: 'Readable thought.' };
  assert.equal(message.reasoningContent, 'Readable thought.');
  assert.equal(result.reasoningContent, 'Readable thought.');
  assert.equal(wire.reasoning_content, 'Readable thought.');
});
