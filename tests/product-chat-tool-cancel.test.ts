import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, linkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check() && Date.now() < end) await pause(10);
  assert.ok(check(), what);
}
async function fixture(t: import('node:test').TestContext, hanging: boolean, discovery = false) {
  const owned = mkdtempSync(path.join(process.env.TEMP!, 'chat-mcp-cancel-'));
  const runtime = path.join(owned, 'node.exe'), server = path.join(owned, 'server.mjs');
  linkSync(process.execPath, runtime);
  writeFileSync(server, `import { createInterface } from 'node:readline';
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    const pending = new Map();
    const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
    const changed = setInterval(() => { if(existsSync('invalidate-catalog')){clearInterval(changed); send({jsonrpc:'2.0',method:'notifications/tools/list_changed'});} }, 10);
    createInterface({ input: process.stdin }).on('line', line => {
      const r = JSON.parse(line);
      if (r.method === 'notifications/cancelled') { const key = pending.get(r.params.requestId); if(key) writeFileSync('cancel-' + key, 'cancelled'); return; }
      if (r.id === undefined) return;
      const reply = result => send({jsonrpc:'2.0', id:r.id, result});
      if (r.method === 'initialize') return reply({protocolVersion:'2025-11-25', capabilities:{tools:{}}, serverInfo:{name:'cancel-fixture',version:'1'}});
      if (r.method === 'tools/list') {
        if(existsSync('hold-list')) { pending.set(r.id, 'discovery'); writeFileSync('started-discovery','started'); return; }
        return reply({tools:[{name:'read',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]});
      }
      if (r.method === 'tools/call') {
        const a = r.params.arguments; appendFileSync('calls', a.key + ':' + a.step + '\\n');
        const result = {content:[{type:'text',text:'receipt-' + a.key + '-' + a.step}]};
        if (!a.hang) return reply(result);
        pending.set(r.id, a.key); writeFileSync('started-' + a.key, 'started');
        const timer = setInterval(() => { if(existsSync('release-' + a.key)){clearInterval(timer); pending.delete(r.id); reply(result);} }, 10);
      }
    });`);
  const wire: string[] = [];
  const options = { projectRoot: process.cwd(), dataDir: path.join(owned, 'data'), mockOptions: { responder: (body: any) => {
    const key = [...body.messages].reverse().find((m: any) => m.role === 'user')?.content as string;
    wire.push(key);
    if (body.messages.some((m: any) => m.role === 'tool')) return { content: 'finished ' + key };
    if (discovery) return { content: '', toolCalls: [{ id: 'discover', name: 'list_mcp_tools', arguments: { serverId: 'cancel-test' } }] };
    return { content: '', toolCalls: [
      { id: 'read-fast', name: 'mcp_read', arguments: { serverId: 'cancel-test', toolName: 'read', arguments: { key, step: 'fast', hang: false } } },
      ...(hanging ? [{ id: 'read-wait', name: 'mcp_read', arguments: { serverId: 'cancel-test', toolName: 'read', arguments: { key, step: 'wait', hang: true } } }] : []),
    ] };
  } } };
  let backend = await startBackend(options);
  const config = { id: 'cancel-test', name: 'Cancel fixture', command: runtime, args: [server], cwd: owned };
  const pending = await backend.services.external.connect(config);
  await backend.services.external.connect({ ...config, approvedDigest: pending.digest });
  const call = async (method: string, route: string, body?: unknown) => {
    const r = await fetch('http://127.0.0.1:' + backend.port + '/v1/product' + route, { method,
      headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await r.json() as any; assert.equal(r.status, 200, JSON.stringify(value)); return value;
  };
  const start = async (key: string) => {
    const session = backend.services.harness!.store.createSession({ capabilities: { mcp: true, web: false, tools: false, skills: false, projectInstructions: false } });
    await call('POST', '/chat/send', { mode: 'chat', sessionId: session.id, text: key, attachments: [], permission: 'ask', modelId: 'default' });
    return session.id;
  };
  t.after(async () => {
    await backend.close();
    assert.equal(path.dirname(owned), path.resolve(process.env.TEMP!));
    rmSync(owned, { recursive: true, force: true });
  });
  return { owned, wire, call, start, get backend() { return backend; },
    tools: (sessionId: string) => backend.services.harness!.store.toolCalls({ sessionId }),
    calls: () => existsSync(path.join(owned, 'calls')) ? readFileSync(path.join(owned, 'calls'), 'utf8') : '',
    restart: async () => { await backend.close(); backend = await startBackend(options); await backend.services.harness!.tools.ready; } };
}

test('HTTP Chat cancel aborts only its active MCP batch, exposes running UI state, and never replays unknown after restart', { timeout: 25000 }, async t => {
  const f = await fixture(t, true), a = await f.start('session-a'), b = await f.start('session-b');
  await until(() => existsSync(path.join(f.owned, 'started-session-a')) && existsSync(path.join(f.owned, 'started-session-b')), 'both MCP calls dispatched');
  const before = await f.call('GET', '/sessions/' + a);
  t.diagnostic('tool-stage session status=' + before.status);
  const events = await f.call('GET', '/events?cursor=0&limit=200&sessionId=' + a);
  await f.call('POST', '/chat/cancel', { sessionId: a });
  await until(() => existsSync(path.join(f.owned, 'cancel-session-a')), 'HTTP cancel reaches the pending MCP request', 1500);
  assert.equal(before.status, 'running', 'Composer stop button uses actual tool-stage running status');
  assert.ok(events.events.some((e: any) => e.event.type === 'session.upsert' && e.event.session.status === 'running'), 'live UI receives running session upsert');
  assert.equal(existsSync(path.join(f.owned, 'cancel-session-b')), false);
  assert.equal((await f.call('GET', '/sessions/' + b)).status, 'running');
  assert.equal((await f.call('GET', '/sessions/' + a)).status, 'idle');
  assert.equal(f.tools(a).find(tool => tool.toolCallId === 'read-fast')!.status, 'completed');
  const uncertain = f.tools(a).find(tool => tool.toolCallId === 'read-wait')!;
  assert.equal(uncertain.status, 'unknown');
  assert.equal(f.backend.services.kernel.getIntent(uncertain.intentId!)!.state, 'unknown');
  writeFileSync(path.join(f.owned, 'release-session-b'), 'release');
  await until(() => f.wire.filter(key => key === 'session-b').length === 2, 'uncancelled session continues normally');
  assert.equal(f.wire.filter(key => key === 'session-a').length, 1);
  const calls = f.calls(); await f.restart(); await pause(80);
  assert.equal(f.calls(), calls); assert.equal(f.wire.filter(key => key === 'session-a').length, 1);
  assert.equal(f.tools(a).find(tool => tool.toolCallId === 'read-wait')!.status, 'unknown');
});

test('HTTP cancellation after a durable MCP receipt preserves it and suppresses continuation across restart', { timeout: 20000 }, async t => {
  const f = await fixture(t, false), external = f.backend.services.external;
  const execute = external.execute.bind(external); let durable = false;
  external.execute = async (prepared, options) => {
    const result = await execute(prepared, options); durable = true;
    if (!options.signal!.aborted) await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }));
    return result;
  };
  const sessionId = await f.start('receipt-race');
  await until(() => durable, 'executor has persisted the real receipt');
  await f.call('POST', '/chat/cancel', { sessionId });
  await until(() => f.tools(sessionId)[0]?.status === 'completed', 'cancellation preserves an already completed receipt', 1500);
  const tool = f.tools(sessionId)[0]!;
  assert.equal(f.backend.services.kernel.getIntent(tool.intentId!)!.state, 'applied');
  assert.equal(f.wire.length, 1); assert.equal((await f.call('GET', '/sessions/' + sessionId)).status, 'idle');
  await f.restart(); await pause(80);
  assert.equal(f.wire.length, 1, 'cancelled receipt-only batch must not continue at startup');
  assert.equal(f.calls().trim().split('\n').length, 1); assert.equal(f.tools(sessionId)[0]!.status, 'completed');
});

test('HTTP cancellation before external dispatch settles the known failure and denies the untouched batch tail', { timeout: 20000 }, async t => {
  const f = await fixture(t, true), external = f.backend.services.external;
  const execute = external.execute.bind(external); let prepared = false;
  external.execute = async (tool, options) => {
    prepared = true;
    if (!options.signal!.aborted) await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }));
    return execute(tool, options);
  };
  const sessionId = await f.start('not-dispatched');
  await until(() => prepared, 'Chat has prepared the external call');
  await f.call('POST', '/chat/cancel', { sessionId });
  const first = f.tools(sessionId).find(tool => tool.toolCallId === 'read-fast')!;
  assert.equal(first.status, 'failed'); assert.equal(f.backend.services.kernel.getIntent(first.intentId!)!.state, 'failed');
  assert.equal(f.tools(sessionId).find(tool => tool.toolCallId === 'read-wait')!.status, 'denied');
  assert.equal(f.calls(), ''); assert.equal(f.wire.length, 1);
  await f.restart(); await pause(80);
  assert.equal(f.calls(), ''); assert.equal(f.wire.length, 1);
  assert.equal(f.tools(sessionId).find(tool => tool.toolCallId === 'read-wait')!.status, 'denied');
});

test('HTTP Chat cancel aborts an MCP catalog refresh before any tools/call dispatch', { timeout: 20000 }, async t => {
  const f = await fixture(t, false, true);
  writeFileSync(path.join(f.owned, 'hold-list'), 'hold'); writeFileSync(path.join(f.owned, 'invalidate-catalog'), 'changed');
  await until(() => { try { f.backend.services.external.chatMcpCatalog('cancel-test'); return false; } catch { return true; } }, 'catalog notification invalidates the cached list');
  const sessionId = await f.start('discovery');
  await until(() => existsSync(path.join(f.owned, 'started-discovery')), 'catalog refresh is in flight');
  assert.equal((await f.call('GET', '/sessions/' + sessionId)).status, 'running');
  await f.call('POST', '/chat/cancel', { sessionId });
  await until(() => existsSync(path.join(f.owned, 'cancel-discovery')), 'cancel signal reaches tools/list');
  assert.equal(f.tools(sessionId)[0]!.status, 'failed');
  assert.equal(f.calls(), ''); assert.equal(f.wire.length, 1);
  assert.equal((await f.call('GET', '/sessions/' + sessionId)).status, 'idle');
  await f.restart(); await pause(80); assert.equal(f.wire.length, 1);
});
