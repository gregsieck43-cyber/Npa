import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { listenLoopback } from '../app/loopback.js';
import type { ToolCall } from '../contracts.js';

export type MockFault = 'none' | 'unauthorized' | 'rate_limit' | 'server_error' | 'bad_json' | 'bad_tool_json' | 'truncated_stream' | 'disconnect' | 'timeout' | 'review_fail' | 'review_unknown';
export interface MockCompletion { content: string; reasoningContent?: string; toolCalls?: ToolCall[]; finishReason?: string; }
export interface MockProviderOptions { fault?: MockFault; delayMs?: number; stream?: boolean; streamChunkChars?: number; streamDelayMs?: number; responder?: (body: any, index: number) => MockCompletion | Promise<MockCompletion>; trace?: (body: any, index: number) => void; }
export async function startMockProvider(options: MockProviderOptions = {}): Promise<{ url: string; close(): Promise<void>; setFault(fault: MockFault): void; requests(): number }> {
  if (options.streamChunkChars !== undefined && (!Number.isInteger(options.streamChunkChars) || options.streamChunkChars < 1 || options.streamChunkChars > 4096)) throw new Error('Mock chunk size must be 1–4096 characters.');
  if (options.streamDelayMs !== undefined && (!Number.isInteger(options.streamDelayMs) || options.streamDelayMs < 0 || options.streamDelayMs > 2000)) throw new Error('Mock stream delay must be 0–2000 ms.');
  let fault: MockFault = options.fault ?? 'none', count = 0;
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST' || request.url !== '/provider/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    count++;
    request.setEncoding('utf8');
    let text = '';
    for await (const chunk of request) { text += String(chunk); if (text.length > 2_000_000) { response.writeHead(413); response.end(); return; } }
    let body: any;
    try { body = JSON.parse(text); } catch { response.writeHead(400); response.end(); return; }
    options.trace?.(body, count);
    const activeFault = fault;
    if (activeFault === 'unauthorized') { response.writeHead(401); response.end('Unauthorized'); return; }
    if (activeFault === 'rate_limit') { response.writeHead(429, { 'Retry-After': '2' }); response.end('Rate limit'); return; }
    if (activeFault === 'server_error') { response.writeHead(503); response.end('Unavailable'); return; }
    if (activeFault === 'disconnect') { request.socket.destroy(); return; }
    if (activeFault === 'timeout') return;
    if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
    if (response.destroyed) return;
    if (activeFault === 'bad_json') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{broken'); return; }
    const messages: any[] = body.messages ?? [];
    const system = messages.find(message => message.role === 'system')?.content ?? '';
    const user = [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
    const toolResult = [...messages].reverse().find(message => message.role === 'tool');
    const supersededTool = toolResult?.content === 'Tool was denied: Task control superseded an active run'
      || String(toolResult?.content ?? '').includes('User input or task authority changed after this proposal was sampled.');
    const toolDefinitions: string[] = (body.tools ?? []).map((tool: any) => tool.function?.name);
    const review = system.includes('REVIEWER ROLE');
    let content = '', toolCall: any;
    if (review) content = JSON.stringify({ verdict: activeFault === 'review_fail' ? 'fail' : activeFault === 'review_unknown' ? 'unknown' : 'pass', reason: 'Mock reviewer: evaluate recorded artifact and effect receipts.', findings: [] });
    else if (system.includes('SIDE ROLE')) content = `辅助讨论建议：${user}。此建议未修改主任务，也未执行工具。`;
    else if (toolResult && !supersededTool) content = 'Completed the approved operation. The tool receipt and workspace artifact are ready for independent verification.';
    else if (toolDefinitions.includes('fixture_increment') && /increment|counter|计数/i.test(user)) toolCall = { id: 'mock_increment_1', type: 'function', function: { name: 'fixture_increment', arguments: JSON.stringify({ amount: 1 }) } };
    else if (toolDefinitions.includes('write_file')) {
      const path = user.match(/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:txt|md|json)/)?.[0] ?? 'result.txt';
      toolCall = { id: 'mock_write_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path, content: `NPN-Gamma mock output\nGoal: ${user}\n` }) } };
    } else content = `Mock response: ${user}`;
    const custom = options.responder ? await options.responder(body, count) : undefined;
    if (custom) content = custom.content;
    const toolCalls = custom ? (custom.toolCalls ?? []).map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) : toolCall ? [toolCall] : [];
    const finish = custom?.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop');
    const usage = { prompt_tokens: Math.ceil(text.length / 4), completion_tokens: 32, total_tokens: Math.ceil(text.length / 4) + 32 };
    if (options.stream === false || body.stream === false) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: content || null, ...(custom?.reasoningContent ? { reasoning_content: custom.reasoningContent } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], usage })); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const event = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\r\n\r\n`);
    if (custom?.reasoningContent) event({ choices: [{ index: 0, delta: { reasoning_content: custom.reasoningContent }, finish_reason: null }] });
    if (toolCalls.length) {
      const parts = toolCalls.map((call, index) => { const args = activeFault === 'bad_tool_json' ? '{broken' : call.function.arguments; const split = Math.floor(args.length / 2); return { call, index, args, split }; });
      event({ choices: [{ index: 0, delta: { tool_calls: parts.map(({ call, index, args, split }) => ({ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: args.slice(0, split) } })) }, finish_reason: null }] });
      event({ choices: [{ index: 0, delta: { tool_calls: parts.map(({ index, args, split }) => ({ index, function: { arguments: args.slice(split) } })) }, finish_reason: finish }] });
    } else {
      const size = options.streamChunkChars ?? Math.max(1, content.length);
      for (let offset = 0; offset < content.length || offset === 0; offset += size) {
        if (response.destroyed) return;
        const last = offset + size >= content.length;
        event({ choices: [{ index: 0, delta: { content: content.slice(offset, offset + size) }, finish_reason: last ? finish : null }] });
        if (!last && options.streamDelayMs) await new Promise(resolve => setTimeout(resolve, options.streamDelayMs));
      }
    }
    event({ choices: [], usage });
    if (activeFault !== 'truncated_stream') response.write('data: [DONE]\r\n\r\n');
    response.end();
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const port = await listenLoopback(server);
  return { url: `http://127.0.0.1:${port}/provider/v1`, setFault(value) { fault = value; }, requests: () => count,
    close: () => new Promise<void>((resolve, reject) => { sockets.forEach(socket => socket.destroy()); server.close(error => error ? reject(error) : resolve()); }) };
}
