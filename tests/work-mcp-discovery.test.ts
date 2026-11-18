import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T, ready: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) { const value = read(); if (ready(value)) return value; assert.ok(Date.now() < deadline, label); await sleep(15); }
}
const catalog = (version = 1) => Array.from({ length: 81 }, (_, index) => ({ name: `tool_${String(index).padStart(2, '0')}`, description: `Tool ${index}`,
  inputSchema: { type: 'object', description: `SCHEMA_ONLY_${String(index).padStart(2, '0')}_V${version}:` + 'x'.repeat(3500), properties: { value: { type: 'string' } } },
  annotations: { readOnlyHint: index !== 80 } }));

async function fixture(t: import('node:test').TestContext, discoveryArgs: Record<string, unknown> = {}) {
  const root = path.resolve(process.env.TEMP ?? '.tmp/work-mcp-discovery-20261104'); mkdirSync(root, { recursive: true });
  const owned = mkdtempSync(path.join(root, 'discovery-')), runtime = path.join(owned, 'node.exe'), server = path.join(owned, 'server.mjs');
  linkSync(process.execPath, runtime); writeFileSync(path.join(owned, 'catalog.json'), JSON.stringify(catalog()));
  writeFileSync(server, `import {createInterface} from 'node:readline';import{readFileSync,writeFileSync,appendFileSync,existsSync}from'node:fs';
    const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');let lists=0,notified=false;
    const timer=setInterval(()=>{if(!notified&&existsSync('notify')){notified=true;send({jsonrpc:'2.0',method:'notifications/tools/list_changed'});writeFileSync('notified','yes');}},10);
    createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
      if(r.method==='notifications/cancelled'){appendFileSync('cancelled',String(r.params.requestId)+'\\n');return;}
      if(r.id===undefined)return;const reply=result=>send({jsonrpc:'2.0',id:r.id,result});
      if(r.method==='initialize')return reply({protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'discovery-fixture',version:'1'}});
      if(r.method==='tools/list'){writeFileSync('lists',String(++lists));if(lists>1&&existsSync('hang-refresh')){writeFileSync('pending-list',String(r.id));return;}return reply({tools:JSON.parse(readFileSync('catalog.json','utf8'))});}
      if(r.method==='tools/call'){appendFileSync('calls',r.params.name+'\\n');return reply({content:[{type:'text',text:'fixture called'}]});}
    }).on('close',()=>{clearInterval(timer);process.exit(0)});`);
  const wire: any[] = [];
  const backend = await startBackend({ projectRoot: process.cwd(), dataDir: path.join(owned, 'data'), mockOptions: { responder: body => {
    wire.push(structuredClone(body));
    if (!body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'discover'))
      return { content: '', toolCalls: [{ id: 'discover', name: 'list_mcp_tools', arguments: discoveryArgs }] };
    return { content: '', toolCalls: [{ id: 'stop', name: 'ask_user', arguments: { question: 'Fixture complete', reason: 'blocker' } }] };
  } } });
  const external = backend.services.external;
  const config = { id: 'discovery', name: 'Discovery fixture', command: runtime, args: [server], cwd: owned };
  const pending = await external.connect(config); await external.connect({ ...config, approvedDigest: pending.digest });
  t.after(async () => { await backend.close(); assert.equal(path.dirname(owned), root); rmSync(owned, { recursive: true, force: true }); });
  const count = (name: string) => existsSync(path.join(owned, name)) ? readFileSync(path.join(owned, name), 'utf8').trim() : '';
  const notify = async () => {
    writeFileSync(path.join(owned, 'notify'), 'yes');
    await until(() => { try { external.chatMcpCatalog('discovery'); return false; } catch { return true; } }, Boolean, 'catalog notification was not received');
  };
  const start = () => backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: {
    objective: 'Discover only the requested MCP metadata', workspace: path.join(owned, 'workspace'), permission: { app: 'work', mode: 'full-access' }, maxModelCalls: 4,
  } }).taskId!;
  const responseOnWire = async () => {
    const taskId = start();
    const body = await until<any>(() => wire.find(value => value.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'discover')), Boolean, 'discovery result never reached the actual model wire');
    await until(() => backend.services.kernel.getTask(taskId)?.status, status => status === 'waiting_input', 'fixture did not settle');
    return String(body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'discover').content);
  };
  return { owned, external, backend, config, digest: pending.digest, count, notify, start, responseOnWire };
}

test('Work server discovery reaches actual model wire without materializing tool schemas', { timeout: 20000 }, async t => {
  const f = await fixture(t), text = await f.responseOnWire();
  t.diagnostic(JSON.stringify({ responseBytes: Buffer.byteLength(text), containsSchema: text.includes('SCHEMA_ONLY_') }));
  assert.ok(Buffer.byteLength(text) < 4096, 'server discovery must be metadata-only and bounded');
  assert.match(text, /discovery/); assert.doesNotMatch(text, /SCHEMA_ONLY_/); assert.equal(f.count('calls'), '');
});

test('Work offset discovery returns only selected names and includes non-readonly tools', { timeout: 20000 }, async t => {
  const f = await fixture(t, { serverId: 'discovery', offset: 80 }), text = await f.responseOnWire();
  t.diagnostic(JSON.stringify({ responseBytes: Buffer.byteLength(text), containsSchema: text.includes('SCHEMA_ONLY_') }));
  assert.ok(Buffer.byteLength(text) < 4096); assert.match(text, /tool_80/); assert.doesNotMatch(text, /tool_00|SCHEMA_ONLY_/);
});

test('Work selected tool schema reaches model wire without any other tool schema', { timeout: 20000 }, async t => {
  const f = await fixture(t, { serverId: 'discovery', toolName: 'tool_80' }), text = await f.responseOnWire();
  t.diagnostic(JSON.stringify({ responseBytes: Buffer.byteLength(text), containsSelected: text.includes('SCHEMA_ONLY_80_V1') }));
  assert.ok(Buffer.byteLength(text) < 7000); assert.match(text, /SCHEMA_ONLY_80_V1/); assert.doesNotMatch(text, /SCHEMA_ONLY_00|SCHEMA_ONLY_79/);
});

test('Work discovery refresh forwards cancellation to actual pending MCP tools/list', { timeout: 20000 }, async t => {
  const f = await fixture(t, { serverId: 'discovery' });
  writeFileSync(path.join(f.owned, 'hang-refresh'), 'yes'); await f.notify();
  const taskId = f.start();
  await until(() => f.count('pending-list'), Boolean, 'Work never refreshed the invalidated catalog');
  f.backend.services.command({ commandId: randomUUID(), type: 'cancel', taskId });
  await until(() => f.count('cancelled'), text => text.split('\n').includes(f.count('pending-list')), 'run cancellation never reached MCP discovery');
  assert.equal(f.count('calls'), '', 'discovery must never execute tools/call');
});

test('generic mcp_call rejects preparation from an invalidated unrefreshed catalog', async t => {
  const f = await fixture(t); await f.notify();
  assert.throws(() => f.external.prepare({ name: 'mcp_call', arguments: { serverId: 'discovery', toolName: 'tool_80', arguments: {} } }), /catalog changed/i);
  assert.equal(f.count('calls'), '');
});

test('generic mcp_call binds the selected definition before dispatch without weakening permissions', async t => {
  const f = await fixture(t);
  const prepared = f.external.prepare({ name: 'mcp_call', arguments: { serverId: 'discovery', toolName: 'tool_80', arguments: {} } })!;
  writeFileSync(path.join(f.owned, 'catalog.json'), JSON.stringify(catalog(2))); await f.notify(); await f.external.tools('discovery');
  const result = await f.external.execute(prepared, { effectKey: 'old-definition', approvedDigest: prepared.digest });
  t.diagnostic(JSON.stringify({ status: result.status, actualCalls: f.count('calls') }));
  assert.equal(result.status, 'failed'); assert.equal(f.count('calls'), '', 'changed schema must not use an old prepared approval');
});

test('generic mcp_call binds connection identity even when server configuration is unchanged', async t => {
  const f = await fixture(t);
  const prepared = f.external.prepare({ name: 'mcp_call', arguments: { serverId: 'discovery', toolName: 'tool_80', arguments: {} } })!;
  await f.external.disconnect('discovery'); await f.external.connect({ ...f.config, approvedDigest: f.digest });
  const result = await f.external.execute(prepared, { effectKey: 'old-connection', approvedDigest: prepared.digest });
  assert.equal(result.status, 'failed'); assert.equal(f.count('calls'), '', 'reconnected process must require a newly prepared call');
});

test('an existing generic MCP receipt remains authoritative after catalog change', async t => {
  const f = await fixture(t);
  const prepared = f.external.prepare({ name: 'mcp_call', arguments: { serverId: 'discovery', toolName: 'tool_80', arguments: {} } })!;
  const options = { effectKey: 'completed-once', approvedDigest: prepared.digest };
  const first = await f.external.execute(prepared, options); assert.equal(first.status, 'applied');
  writeFileSync(path.join(f.owned, 'catalog.json'), JSON.stringify(catalog(2))); await f.notify(); await f.external.tools('discovery');
  assert.deepEqual(await f.external.execute(prepared, options), first); assert.equal(f.count('calls'), 'tool_80');
});

test('shared discovery keeps Chat readonly filtering and does not grant execution permission', async t => {
  const f = await fixture(t);
  await assert.rejects(f.external.chatMcpTools({ serverId: 'discovery', toolName: 'tool_80' }), /read-only/);
  const page = await f.external.chatMcpTools({ serverId: 'discovery', offset: 40 });
  assert.equal(Array.isArray(page), false);
  assert.equal('tools' in page ? page.tools.length : -1, 40);
  assert.doesNotMatch(JSON.stringify(page), /tool_80|SCHEMA_ONLY_/);
  assert.throws(() => f.external.prepare({ name: 'mcp_read', arguments: { serverId: 'discovery', toolName: 'tool_80', arguments: {} } }), /read-only/);
  assert.equal(f.count('calls'), '');
});
