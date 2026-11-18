import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Event } from '../src/contracts.js';
import { startBackend } from '../src/app/backend.js';
import { Kernel } from '../src/kernel/index.js';
import { BackendClient, type EventHistory } from '../src/extensions/client.js';
import { assertProjectFixtureRoot } from './project-boundary.js';

class HistoryFixtureKernel extends Kernel {
  seedEvents(taskId: string, otherId: string) {
    this.tx(() => {
      for (let index = 0; index < 257; index++) {
        this.appendEvent(taskId, 'audit.history', { index, text: `中文事件 ${index} 🚀` });
        if (index % 41 === 0) this.appendEvent(otherId, 'audit.other', { index });
      }
    });
  }
}

async function fixture(t: TestContext) {
  const tempRoot = path.resolve('.tmp');
  assertProjectFixtureRoot(tempRoot);
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(path.join(tempRoot, 'audit-history-'));
  const dataDir = path.join(root, 'data');
  const children: ChildProcess[] = [];
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      child.stdin?.end();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(() => { child.kill(); resolve(); }, 2000); })]);
        if (child.exitCode === null && child.signalCode === null) await exited;
      } finally { clearTimeout(timer); }
    }
    await backend?.close();
    assert.ok(path.relative(tempRoot, root).startsWith('audit-history-'));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  // One authority seeds a durable fixture in a transaction, then closes before
  // the actual backend opens it. Paused tasks admit no model or tool work.
  const seed = new HistoryFixtureKernel(dataDir);
  let taskId: string, expected: Event[];
  try {
    taskId = seed.command({ commandId: 'history-create', type: 'create_task', parameters: { title: '完整历史', goal: { objective: '保留原始历史与顺序', maxModelCalls: 3 } } }).taskId!;
    const otherId = seed.command({ commandId: 'history-other', type: 'create_task', parameters: { title: 'Other task' } }).taskId!;
    seed.command({ commandId: 'history-pause', type: 'pause', taskId });
    seed.command({ commandId: 'history-other-pause', type: 'pause', taskId: otherId });
    seed.seedEvents(taskId, otherId);
    expected = seed.events(taskId);
  } finally { seed.close(); }
  backend = await startBackend({ dataDir, projectRoot: path.resolve('.') });
  await backend.services.runner.stop();
  const client = new BackendClient({ dataDir });
  assert.ok(expected.length > 200);
  assert.ok(expected.some((event, index) => index > 0 && event.seq > expected[index - 1]!.seq + 1), 'fixture includes other-task sequence gaps');
  const env = { ...process.env, NPN_HISTORY_DATA: dataDir, TEMP: root, TMP: root, APPDATA: root, LOCALAPPDATA: root, NODE_NO_WARNINGS: '1' };
  function launch(entry: string, args: string[] = []) {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', entry, ...args], { cwd: path.resolve('.'), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    return child;
  }
  return { client, taskId, expected, launch, backend };
}

function assertPage(page: EventHistory, expectedAfter: number, limit: number) {
  assert.ok(page.page);
  assert.equal(page.page.afterSeq, expectedAfter);
  assert.equal(page.page.limit, limit);
  assert.ok(page.events.length <= limit);
  assert.ok(page.events.every(event => event.seq > expectedAfter));
  assert.equal(page.page.nextCursor, page.page.hasMore ? page.events.at(-1)!.seq : null);
}

test('history client reads retained database events beyond the snapshot tail and traverses sequence gaps', { timeout: 25_000 }, async t => {
  const { client, taskId, expected, backend } = await fixture(t);
  assert.equal((await client.snapshot(taskId)).events.length, 200);
  assert.deepEqual((await client.events(taskId)).events, expected.slice(0, 100));
  const bounded = await fetch(`http://127.0.0.1:${backend.port}/v1/tasks/${taskId}/events?after=0&limit=4`, { headers: { Authorization: `Bearer ${backend.token}` }, signal: AbortSignal.timeout(5000) });
  assert.equal(bounded.status, 200);
  assert.deepEqual(await bounded.json(), expected.slice(0, 4), 'the actual server limits events before HTTP serialization');
  const defaultPage = await client.events(taskId, { cursor: 0 });
  assertPage(defaultPage, 0, 100);
  assert.equal(defaultPage.events.length, 100);
  const middle = expected[19]!.seq;
  assert.deepEqual((await client.events(taskId, { afterSeq: middle })).events, expected.filter(event => event.seq > middle).slice(0, 100));
  const collected: Event[] = [];
  let cursor = 0;
  do {
    const page = await client.events(taskId, { cursor, limit: 73 });
    assertPage(page, cursor, 73);
    collected.push(...page.events);
    if (!page.page!.hasMore) break;
    assert.ok(page.page!.nextCursor! > cursor);
    cursor = page.page!.nextCursor!;
  } while (true);
  assert.deepEqual(collected, expected);
  assert.equal(new Set(collected.map(event => event.seq)).size, expected.length);
  const empty = await client.events(taskId, { cursor: expected.at(-1)!.seq, limit: 73 });
  assert.deepEqual(empty.events, []);
  assertPage(empty, expected.at(-1)!.seq, 73);
});

test('real CLI process defaults to bounded history and streams a complete NDJSON export', { timeout: 25_000 }, async t => {
  const { taskId, expected, launch } = await fixture(t);
  const moduleUrl = new URL('../src/extensions/cli.js', import.meta.url).href;
  const entry = `import { runCli } from ${JSON.stringify(moduleUrl)}; process.exitCode = await runCli(process.argv.slice(1), { dataDir: process.env.NPN_HISTORY_DATA });`;
  async function cli(args: string[]) {
    const child = launch(entry, args);
    let output = '', diagnostic = '';
    child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { diagnostic += chunk; });
    child.stdin!.end();
    const [code] = await once(child, 'close');
    return { code, value: output ? args[0] === 'export-history' ? output.trim().split('\n').map(line => JSON.parse(line)) : JSON.parse(output) as any : undefined, diagnostic };
  }
  const all = await cli(['events', taskId]);
  assert.equal(all.code, 0, all.diagnostic);
  assert.equal(all.value.historyWindow, true);
  assert.deepEqual(all.value.events, expected.slice(0, 100));
  const exported = await cli(['export-history', taskId, '--kind', 'events', '--limit', '73']);
  assert.equal(exported.code, 0, exported.diagnostic);
  assert.equal(exported.value.at(-1).type, 'complete');
  assert.deepEqual(exported.value.filter((line: any) => line.type === 'page').flatMap((line: any) => line.events), expected);
  const after = expected[11]!.seq;
  assert.deepEqual((await cli(['events', taskId, '--after-seq', String(after)])).value.events, expected.filter(event => event.seq > after).slice(0, 100));
  const history = await cli(['history', taskId]);
  assert.equal(history.code, 0, history.diagnostic);
  assert.equal(history.value.kind, 'messages');
  assert.ok(history.value.messages.some((message: any) => message.content === '保留原始历史与顺序'));
  const collected: Event[] = [];
  let cursor = 0;
  do {
    const output = await cli(['history', taskId, '--kind', 'events', '--cursor', String(cursor), '--limit', '71']);
    assert.equal(output.code, 0, output.diagnostic);
    assertPage(output.value, cursor, 71);
    collected.push(...output.value.events);
    if (!output.value.page.hasMore) break;
    cursor = output.value.page.nextCursor;
  } while (true);
  assert.deepEqual(collected, expected);
  assert.equal((await cli(['events', taskId, '--cursor', '0', '--after-seq', '0'])).code, 1);
  assert.equal((await cli(['events', taskId, '--limit', '1001'])).code, 1);
});

test('real MCP stdio pages original messages and events separately from query/result', { timeout: 25_000 }, async t => {
  const { taskId, expected, launch } = await fixture(t);
  const moduleUrl = new URL('../src/extensions/mcp.js', import.meta.url).href;
  const child = launch(`import { runMcp } from ${JSON.stringify(moduleUrl)}; await runMcp({ dataDir: process.env.NPN_HISTORY_DATA });`);
  const pending = new Map<number, (response: any) => void>();
  let buffer = '', diagnostic = '', id = 0;
  child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      const response = JSON.parse(line);
      assert.equal(response.jsonrpc, '2.0');
      pending.get(response.id)?.(response);
    }
  });
  child.stderr!.on('data', chunk => { diagnostic += chunk; });
  async function rpc(method: string, params?: unknown) {
    const requestId = ++id;
    let timer: NodeJS.Timeout | undefined;
    const reply = new Promise<any>((resolve, reject) => {
      pending.set(requestId, resolve);
      timer = setTimeout(() => reject(new Error(`MCP ${method} timed out: ${diagnostic}`)), 5000);
    });
    const line = `${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`;
    child.stdin!.write(line.slice(0, 17)); child.stdin!.write(line.slice(17));
    try { return await reply; } finally { clearTimeout(timer); pending.delete(requestId); }
  }
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'history-audit', version: '1' } });
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = (await rpc('tools/list')).result.tools;
  const schema = tools.find((tool: any) => tool.name === 'npn_history').inputSchema;
  assert.equal(schema.properties.limit.maximum, 1000);
  assert.ok(schema.properties.cursor);
  assert.match(tools.find((tool: any) => tool.name === 'npn_query').description, /bounded.*window/);
  const call = async (name: string, args: unknown) => (await rpc('tools/call', { name, arguments: args })).result;
  assert.equal((await call('npn_query', { taskId })).structuredContent.events.length, 200);
  const all = await call('npn_history', { taskId });
  assert.deepEqual(all.structuredContent.events, expected.slice(0, 100));
  assert.equal(all.structuredContent.historyWindow, true);
  const messages = await call('npn_history', { taskId, kind: 'messages' });
  assert.ok(messages.structuredContent.messages.some((message: any) => message.content === '保留原始历史与顺序'));
  const collected: Event[] = [];
  let cursor = 0;
  do {
    const result = await call('npn_history', { taskId, cursor, limit: 61 });
    assert.equal(result.isError, undefined);
    const page = result.structuredContent;
    assertPage(page, cursor, 61);
    collected.push(...page.events);
    if (!page.page.hasMore) break;
    cursor = page.page.nextCursor;
  } while (true);
  assert.deepEqual(collected, expected);
  const result = (await call('npn_result', { taskId })).structuredContent;
  assert.equal(result.result, null);
  assert.equal(Object.hasOwn(result, 'events'), false);
  const invalid = await rpc('tools/call', { name: 'npn_history', arguments: { taskId, limit: 1001 } });
  assert.equal(invalid.error.code, -32602);
  assert.equal((await call('npn_history', { taskId, cursor: 0, afterSeq: 0 })).isError, true);
  const closed = once(child, 'close'); child.stdin!.end();
  assert.equal((await closed)[0], 0, diagnostic);
  assert.equal(buffer, ''); assert.equal(diagnostic, '');
});

test('history client rejects invalid bounds before requesting a backend', async () => {
  const client = new BackendClient({ dataDir: path.resolve('.tmp') });
  await assert.rejects(client.events('task', { cursor: -1 }), /nonnegative/);
  await assert.rejects(client.events('task', { afterSeq: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/);
  await assert.rejects(client.events('task', { limit: 0 }), /1 to 1000/);
  await assert.rejects(client.events('task', { limit: 1001 }), /1 to 1000/);
  await assert.rejects(client.events('task', { afterSeq: 0, cursor: 0 }), /not both/);
});
