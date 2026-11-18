import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import { BackendClient } from '../src/extensions/client.js';
import type { BackendAccess } from '../src/extensions/client.js';
import { runCli } from '../src/extensions/cli.js';
import { runMcp, MCP_PROTOCOL_VERSION } from '../src/extensions/mcp.js';

test('actual HTTP, CLI and MCP page messages/events past the snapshot window with a fixed watermark', async t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp/hardening-011-transports'); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'history-'));
  const backend = await startBackend({ dataDir: path.join(directory, 'data'), projectRoot: directory });
  t.after(async () => { await backend.close(); rmSync(directory, { recursive: true }); });
  await backend.services.runner.stop();
  const kernel = backend.services.kernel;
  const taskId = kernel.command({ commandId: 'create-history', type: 'create_task', parameters: { title: 'Bounded original history', initialStatus: 'paused' } }).taskId!;
  for (let index = 0; index < 230; index++) kernel.addMessage(taskId, 'user', `消息 ${index} 😀` + '中'.repeat(6000));
  const expectedMessages = kernel.getMessages(taskId), expectedEvents = kernel.events(taskId);
  const client = new BackendClient({ dataDir: path.join(directory, 'data') });
  const first = await client.events(taskId);
  assert.ok(first.events.length <= 100, 'default history must never materialize every event');
  assert.equal((first as any).historyWindow, true);
  const through = (first.page as any).throughSeq;
  kernel.appendEvent(taskId, 'after.export.watermark', { retained: true });
  const collected = [...first.events]; let cursor = first.page!.nextCursor;
  while (cursor !== null) {
    const page = await client.events(taskId, { cursor, throughSeq: through } as any);
    collected.push(...page.events); cursor = page.page!.nextCursor;
  }
  assert.deepEqual(collected, expectedEvents, 'an append after the watermark cannot prolong or pollute the export');
  let output = '', diagnostic = '';
  const io = { dataDir: directory, client, stdout: async (text: string) => { output += text; }, stderr: (text: string) => { diagnostic += text; } };
  assert.equal(await runCli(['history', taskId, '--kind', 'messages', '--limit', '100'], io), 0, diagnostic);
  const window = JSON.parse(output);
  assert.equal(window.historyWindow, true); assert.ok(window.messages.length < 100, 'UTF8 byte budget can shorten a count-limited page');
  assert.ok(window.page.nextCursor); assert.deepEqual(window.messages, expectedMessages.slice(0, window.messages.length));
  output = '';
  assert.equal(await runCli(['export-history', taskId, '--kind', 'messages', '--limit', '37'], io), 0, diagnostic);
  const lines = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.at(-1).type, 'complete');
  assert.deepEqual(lines.filter(line => line.type === 'page').flatMap(line => line.messages), expectedMessages);
  assert.ok(lines.filter(line => line.type === 'page').every(line => Buffer.byteLength(JSON.stringify(line.messages)) <= 1024 * 1024));
  const response = new PassThrough(); let wire = ''; response.on('data', chunk => { wire += chunk; });
  await runMcp({ dataDir: directory, client, output: response, diagnostics: new PassThrough(), input: Readable.from([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'history-fixture', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'npn_history', arguments: { taskId, kind: 'messages', limit: 7 } } },
  ].map(item => JSON.stringify(item) + '\n')) });
  const mcp = wire.trim().split('\n').map(line => JSON.parse(line)).find(reply => reply.id === 2);
  assert.equal(mcp.result.isError, undefined);
  assert.equal(mcp.result.structuredContent.historyWindow, true);
  assert.deepEqual(mcp.result.structuredContent.messages, expectedMessages.slice(0, 7));
  assert.equal(diagnostic, '');
  const giantEvent = kernel.appendEvent(taskId, 'oversized.original', { text: 'x'.repeat(1100 * 1024) });
  await assert.rejects(client.events(taskId, { cursor: giantEvent.seq - 1 }), /exceeds.*page budget/);
  const giantMessage = kernel.addMessage(taskId, 'assistant', 'x'.repeat(1100 * 1024));
  await assert.rejects(client.messages(taskId, { cursor: kernel.messageCursor(taskId, expectedMessages.at(-1)!.id) }), /exceeds.*page budget/);
  assert.equal(kernel.memory(taskId).read({ id: giantMessage.id, offset: 0, length: 100 }).totalChars, giantMessage.content.length);
});

test('NDJSON export waits for its sink before fetching the next page and reports no false completion', async () => {
  let reads = 0, release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const output: string[] = [];
  const controller = new AbortController();
  const client: BackendAccess = {
    health: async () => ({}), snapshot: async () => { throw new Error('Export must not load a snapshot'); }, command: async () => { throw new Error('Export must not mutate tasks'); },
    events: async (_taskId, query) => {
      reads++;
      return { events: [], historyWindow: true, page: { afterSeq: query?.cursor ?? 0, limit: 1, nextCursor: reads === 1 ? 1 : null, hasMore: reads === 1, throughSeq: 2 } };
    },
  };
  const running = runCli(['export-history', 'task', '--kind', 'events', '--limit', '1'], { dataDir: '.', client, signal: controller.signal,
    stdout: async text => { output.push(text); if (output.length === 1) { entered(); await blocked; } }, stderr: () => {} });
  await writing;
  assert.equal(reads, 1);
  controller.abort(); release();
  assert.equal(await running, 1);
  assert.equal(reads, 1);
  assert.equal(output.some(line => JSON.parse(line).type === 'complete'), false);
  const lastPageController = new AbortController(), lastOutput: string[] = [];
  const lastCode = await runCli(['export-history', 'task', '--kind', 'events'], { dataDir: '.', client, signal: lastPageController.signal,
    stdout: async text => { lastOutput.push(text); lastPageController.abort(); }, stderr: () => {} });
  assert.equal(lastCode, 1, 'cancellation while writing the final page cannot certify a complete export');
  assert.equal(lastOutput.some(line => JSON.parse(line).type === 'complete'), false);
});
