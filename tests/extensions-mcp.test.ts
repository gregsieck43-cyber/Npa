import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runMcp, MCP_PROTOCOL_VERSION } from '../src/extensions/mcp.js';
import type { BackendAccess } from '../src/extensions/client.js';
import type { Command, Snapshot } from '../src/contracts.js';

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'our-fixture', version: '1.0.0' } } };
const ready = { jsonrpc: '2.0', method: 'notifications/initialized' };
function mock(): { client: BackendAccess; commands: Command[] } {
  const commands: Command[] = [];
  const snapshot = { tasks: [{ id: 'task-1', status: 'paused', revision: 2 }], messages: [{ content: 'original user goal' }], events: [{ seq: 1, type: 'task.created' }, { seq: 2, type: 'task.paused' }], intents: [], health: {} } as unknown as Snapshot;
  return { commands, client: { health: async () => ({}), events: async (_taskId, options) => ({ events: snapshot.events.filter(event => event.seq > (options?.cursor ?? options?.afterSeq ?? 0)) }), snapshot: async () => snapshot, command: async command => { const duplicate = commands.some(item => item.commandId === command.commandId); commands.push(command); return { commandId: command.commandId, status: duplicate ? 'duplicate' : 'accepted', taskId: 'task-1' }; } } };
}
async function exchange(messages: unknown[], client: BackendAccess): Promise<{ replies: any[]; diagnostics: string }> {
  const output = new PassThrough(); const diagnostics = new PassThrough(); let raw = ''; let errors = '';
  output.on('data', chunk => { raw += String(chunk); }); diagnostics.on('data', chunk => { errors += String(chunk); });
  await runMcp({ dataDir: process.cwd(), client, input: Readable.from(messages.map(message => `${typeof message === 'string' ? message : JSON.stringify(message)}\n`)), output, diagnostics });
  return { replies: raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), diagnostics: errors };
}
test('MCP negotiates initialization, lists real schemas, calls tools and leaves stdout protocol-only', async () => {
  const { client, commands } = mock();
  const { replies, diagnostics } = await exchange([initialize, ready, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 'submit', method: 'tools/call', params: { name: 'npn_submit', arguments: { objective: 'Retain a goal', mode: 'autonomous', commandId: 'submit-stable' } } }, { jsonrpc: '2.0', id: 'history', method: 'tools/call', params: { name: 'npn_history', arguments: { taskId: 'task-1', afterSeq: 1 } } }, { jsonrpc: '2.0', id: 'ping', method: 'ping' }], client);
  assert.equal(replies.find(reply => reply.id === 1).result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(replies.find(reply => reply.id === 1).result.serverInfo.version, JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version);
  assert.equal(replies.find(reply => reply.id === 2).result.tools.length, 7);
  assert.equal(replies.find(reply => reply.id === 'submit').result.structuredContent.taskId, 'task-1');
  assert.deepEqual(replies.find(reply => reply.id === 'history').result.structuredContent.events.map((event: any) => event.seq), [2]);
  assert.equal(commands[0]!.type, 'submit'); assert.equal(commands[0]!.parameters!.goal && (commands[0]!.parameters!.goal as any).mode, 'autonomous');
  assert.equal(diagnostics, ''); assert.ok(replies.every(reply => reply.jsonrpc === '2.0'));
});
test('MCP rejects invalid protocol/arguments and does not respond to notifications', async () => {
  const { client, commands } = mock();
  const { replies } = await exchange(['{bad', [], { jsonrpc: '2.0', id: 'early', method: 'tools/list' }, initialize, ready, { jsonrpc: '2.0', method: 'notifications/unknown' }, { jsonrpc: '2.0', id: 'method', method: 'execute_arbitrary' }, { jsonrpc: '2.0', id: 'tool', method: 'tools/call', params: { name: 'arbitrary', arguments: {} } }, { jsonrpc: '2.0', id: 'args', method: 'tools/call', params: { name: 'npn_submit', arguments: { objective: 'goal', mode: 'unlimited', grantAll: true } } }], client);
  assert.equal(replies[0].error.code, -32700); assert.equal(replies[1].error.code, -32600);
  assert.equal(replies.find(reply => reply.id === 'early').error.code, -32002);
  assert.equal(replies.find(reply => reply.id === 'method').error.code, -32601);
  assert.equal(replies.find(reply => reply.id === 'tool').error.code, -32602);
  assert.equal(replies.find(reply => reply.id === 'args').error.code, -32602);
  assert.equal(replies.length, 7); assert.equal(commands.length, 0);
});
test('MCP repeated controls preserve command content and backend failures are tool errors', async () => {
  const { client, commands } = mock();
  const call = (id: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'npn_retry', arguments: { taskId: 'task-1', commandId: 'stable-control' } } });
  const { replies } = await exchange([initialize, ready, call('first'), call('repeat')], client);
  assert.deepEqual(commands[0], commands[1]); assert.equal(commands[0]!.expectedRevision, undefined);
  assert.equal(replies.find(reply => reply.id === 'repeat').result.structuredContent.status, 'duplicate');
  client.snapshot = async () => { throw new Error('Backend is unavailable. Restart desktop.'); };
  const failure = await exchange([initialize, ready, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'npn_result', arguments: { taskId: 'task-1' } } }], client);
  assert.equal(failure.replies.find(reply => reply.id === 2).result.isError, true);
  assert.match(failure.replies.find(reply => reply.id === 2).result.content[0].text, /Restart desktop/);
});
test('MCP cancellation notification aborts a pending query without producing a duplicate response', async () => {
  const { client } = mock(); let cancelled = false;
  client.snapshot = async (_taskId, signal) => new Promise((_resolve, reject) => { signal!.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true }); });
  const { replies } = await exchange([initialize, ready, { jsonrpc: '2.0', id: 'pending', method: 'tools/call', params: { name: 'npn_query', arguments: { taskId: 'task-1' } } }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'pending' } }], client);
  assert.equal(cancelled, true); assert.equal(replies.filter(reply => reply.id === 'pending').length, 0);
});

test('MCP bounds outstanding backend calls while still accepting cancellation notifications', async () => {
  const { client } = mock(); let started = 0, aborted = 0;
  client.snapshot = async (_taskId, signal) => new Promise((_resolve, reject) => {
    started++;
    signal!.addEventListener('abort', () => { aborted++; reject(new Error('cancelled')); }, { once: true });
  });
  const requests = Array.from({ length: 100 }, (_, i) => ({ jsonrpc: '2.0', id: `q-${i}`, method: 'tools/call', params: { name: 'npn_query', arguments: {} } }));
  const cancellations = requests.map(request => ({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: request.id } }));
  const { replies } = await exchange([initialize, ready, ...requests, ...cancellations], client);
  assert.equal(started, 8); assert.equal(aborted, 8);
  assert.equal(replies.filter(reply => reply.error?.code === -32000).length, 92);
  assert.equal(replies.filter(reply => reply.id?.startsWith?.('q-') && reply.result).length, 0);
});

test('MCP stops reading more requests while its output pipe is full', async () => {
  const { client } = mock(); let started = 0;
  client.snapshot = async () => { started++; return {} as Snapshot; };
  const input = new PassThrough(), output = new PassThrough({ highWaterMark: 64 });
  const running = runMcp({ dataDir: process.cwd(), client, input, output, diagnostics: new PassThrough() });
  input.end([initialize, ready, ...Array.from({ length: 100 }, (_, i) => ({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name: 'npn_query', arguments: {} } }))].map(row => JSON.stringify(row)).join('\n') + '\n');
  await new Promise(resolve => setImmediate(resolve));
  const beforeDrain = started;
  let raw = ''; output.on('data', chunk => { raw += chunk; });
  await running;
  assert.equal(beforeDrain, 0, 'the initialization response must drain before reading the following request batch');
  assert.equal(started, 100); assert.equal(raw.trim().split('\n').length, 101);
});

test('closing the MCP reply pipe cancels its pending HTTP read and releases transport listeners', async () => {
  const { client } = mock(); let aborted = false;
  let started!: () => void; const reading = new Promise<void>(resolve => { started = resolve; });
  client.snapshot = async (_taskId, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, { once: true }); started();
  });
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  const before = { close: output.listenerCount('close'), error: output.listenerCount('error') };
  const running = runMcp({ dataDir: process.cwd(), client, input, output, diagnostics: new PassThrough() });
  input.write([initialize, ready, { jsonrpc: '2.0', id: 'read', method: 'tools/call', params: { name: 'npn_query', arguments: {} } }].map(row => JSON.stringify(row)).join('\n') + '\n');
  await reading; output.destroy(); await running;
  assert.equal(aborted, true); assert.equal(input.destroyed, true);
  assert.equal(output.listenerCount('close'), before.close); assert.equal(output.listenerCount('error'), before.error);
});
