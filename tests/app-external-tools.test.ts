import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ExternalTools } from '../src/app/external-tools.js';
import type { McpServerConfig } from '../src/extensions/mcp-client.js';
import { digestValue } from '../src/tools/policy.js';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
async function directory() { return mkdtemp(path.join(process.cwd(), '.tmp', 'app-external-tools-')); }
test('web calls require approval, preserve independent receipts, and deduplicate across restart', async () => {
  const temp = await directory(); const dataDir = path.join(temp, 'data'); let requests = 0;
  const external = new ExternalTools({ dataDir, projectRoot: process.cwd(), webOptions: { searchProvider: 'wikipedia', resolveDns: publicDns, fetch: async input => {
    requests++;
    const url = new URL(String(input));
    if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
    if (url.pathname === '/w/api.php') return Response.json({ query: { search: [{ title: 'Fixture', snippet: 'Original fixture evidence' }] } });
    return new Response('<title>Fixture</title><main>Page evidence</main>', { headers: { 'content-type': 'text/html' } });
  } } });
  try {
    assert.equal(external.prepare({ name: 'read_file', arguments: { path: 'x' } }), undefined);
    for (const [name, args] of [
      ['web_search', { query: 'fixture' }], ['web_fetch', { url: 'https://www.example.org/page' }], ['web_crawl', { url: 'https://www.example.org/page', maxPages: 1, maxDepth: 0 }],
    ] as [string, Record<string, unknown>][]) {
      const prepared = external.prepare({ name, arguments: args })!;
      assert.equal(prepared.capability, 'network.read'); assert.equal(prepared.mutating, true);
      await assert.rejects(external.execute(prepared, { effectKey: name }), /approval/);
      const result = await external.execute(prepared, { effectKey: name, approvedDigest: prepared.digest });
      assert.equal(result.status, 'applied'); assert.equal(result.receipt?.trust, 'untrusted');
      const independent = JSON.parse(await readFile(path.join(dataDir, 'external-receipts', `${digestValue(name)}.json`), 'utf8'));
      assert.equal(independent.status, 'applied'); assert.deepEqual(independent.receipt, result.receipt);
      const previous = requests;
      assert.deepEqual(await external.execute(prepared, { effectKey: name, approvedDigest: prepared.digest }), result);
      const restarted = new ExternalTools({ dataDir, projectRoot: process.cwd() });
      assert.deepEqual(await restarted.queryOutcome(name, prepared.digest), result); assert.equal(requests, previous);
    }
  } finally { await external.close(); await rm(temp, { recursive: true, force: true }); }
});
test('search approval pins provider configuration and rejects private web targets', async () => {
  const temp = await directory(); const targets: string[] = [];
  const external = new ExternalTools({ dataDir: path.join(temp, 'data'), projectRoot: process.cwd(), webOptions: { searchProvider: 'wikipedia', resolveDns: publicDns, fetch: async input => {
    targets.push(String(input)); return Response.json({ query: { search: [] } });
  } } });
  try {
    const prepared = external.prepare({ name: 'web_search', arguments: { query: 'pinned' } })!;
    external.configureWeb({ searchProvider: 'searxng', searxUrl: 'https://search.example.org' });
    assert.equal((await external.execute(prepared, { effectKey: 'pinned', approvedDigest: prepared.digest })).status, 'applied');
    assert.equal(new URL(targets[0]!).origin, 'https://en.wikipedia.org');
    assert.throws(() => external.prepare({ name: 'web_fetch', arguments: { url: 'http://127.0.0.1/private' } }), /private|local|IP/);
    assert.throws(() => external.prepare({ name: 'web_crawl', arguments: { url: 'https://www.example.org', maxPages: 9 } }), /Crawl/);
    assert.throws(() => external.configureWeb({ searchProvider: 'searxng', searxUrl: 'http://search.example.org' }), /HTTPS/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('private DNS fails without issuing requests and never creates a successful receipt', async () => {
  const temp = await directory(); let requests = 0;
  const external = new ExternalTools({ dataDir: path.join(temp, 'data'), projectRoot: process.cwd(), webOptions: { resolveDns: async () => [{ address: '192.168.1.1', family: 4 }], fetch: async () => { requests++; return new Response('unsafe'); } } });
  try {
    const prepared = external.prepare({ name: 'web_fetch', arguments: { url: 'https://private.example.org' } })!;
    const result = await external.execute(prepared, { effectKey: 'private-dns', approvedDigest: prepared.digest });
    assert.equal(result.status, 'failed'); assert.match(result.error!, /DNS_BLOCKED/); assert.equal(requests, 0);
    assert.equal((await external.queryOutcome('private-dns', prepared.digest)).status, 'failed');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

const serverSource = `
import {createInterface} from 'node:readline';
import {writeFileSync, readFileSync, existsSync} from 'node:fs';
writeFileSync('launched.txt', 'yes');
const input = createInterface({input: process.stdin});
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const reply = result => send({jsonrpc: '2.0', id: request.id, result});
  if (request.method === 'initialize') return reply({protocolVersion: '2025-11-25', capabilities: {tools: {}}, serverInfo: {name: 'original-external-fixture', version: '1.0.0'}});
  if (request.method === 'tools/list') return reply({tools: [{name: 'echo', inputSchema: {type: 'object'}}, {name: 'wait', inputSchema: {type: 'object'}}]});
  if (request.method === 'tools/call') {
    const count = existsSync('calls.txt') ? Number(readFileSync('calls.txt', 'utf8')) : 0;
    writeFileSync('calls.txt', String(count + 1));
    if (request.params.name === 'wait') return;
    return reply({content: [{type: 'text', text: JSON.stringify(request.params.arguments)}]});
  }
});
`;
async function mcpFixture() {
  const temp = await directory();
  const runtime = path.join(temp, 'node.exe'); await copyFile(process.execPath, runtime);
  const server = path.join(temp, 'server.mjs'); await writeFile(server, serverSource);
  const dataDir = path.join(temp, 'data'); await mkdir(dataDir);
  const config: McpServerConfig = { id: 'fixture', name: 'Original harmless fixture', command: runtime, args: [server], cwd: temp };
  const external = new ExternalTools({ dataDir, projectRoot: process.cwd() });
  return { temp, dataDir, config, external, close: async () => { await external.close(); await rm(temp, { recursive: true, force: true }); } };
}
test('MCP launch and tool calls have separate exact approvals and durable returned-result receipts', async () => {
  const f = await mcpFixture();
  try {
    const proposed = await f.external.connect(f.config); assert.equal(proposed.status, 'approval_required');
    await assert.rejects(readFile(path.join(f.temp, 'launched.txt')), { code: 'ENOENT' });
    const connected = await f.external.connect({ ...f.config, approvedDigest: proposed.digest });
    assert.equal(connected.status, 'connected'); assert.equal((await f.external.tools('fixture')).length, 2);
    const prepared = f.external.prepare({ name: 'mcp_call', arguments: { serverId: 'fixture', toolName: 'echo', arguments: { text: 'hello' } } })!;
    assert.equal(prepared.capability, 'mcp.call');
    await assert.rejects(f.external.execute(prepared, { effectKey: 'echo' }), /approval/);
    const result = await f.external.execute(prepared, { effectKey: 'echo', approvedDigest: prepared.digest });
    assert.equal(result.status, 'applied'); assert.match(result.output, /hello/);
    assert.deepEqual(await f.external.queryOutcome('echo', prepared.digest), result);
    assert.deepEqual(await f.external.execute(prepared, { effectKey: 'echo', approvedDigest: prepared.digest }), result);
    assert.equal(await readFile(path.join(f.temp, 'calls.txt'), 'utf8'), '1');
    await f.external.disconnect('fixture');
    const restarted = new ExternalTools({ dataDir: f.dataDir, projectRoot: process.cwd() });
    assert.equal(restarted.listMcp()[0]!.status, 'disconnected');
    assert.equal((await restarted.connect(f.config)).status, 'approval_required');
    await restarted.close();
  } finally { await f.close(); }
});
test('cancelled MCP effect remains unknown across receipt lookup and repeated execution, with no replay', async () => {
  const f = await mcpFixture();
  try {
    const proposed = await f.external.connect(f.config); await f.external.connect({ ...f.config, approvedDigest: proposed.digest });
    const prepared = f.external.prepare({ name: 'mcp_call', arguments: { serverId: 'fixture', toolName: 'wait', arguments: {} } })!;
    const controller = new AbortController();
    const pending = f.external.execute(prepared, { effectKey: 'uncertain', approvedDigest: prepared.digest, signal: controller.signal });
    for (let i = 0; i < 100; i++) {
      try { await readFile(path.join(f.temp, 'calls.txt')); break; } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    controller.abort(); const result = await pending;
    assert.equal(result.status, 'unknown'); assert.equal(result.receipt, undefined);
    assert.equal((await f.external.queryOutcome('uncertain', prepared.digest)).status, 'unknown');
    assert.equal((await f.external.execute(prepared, { effectKey: 'uncertain', approvedDigest: prepared.digest })).status, 'unknown');
    assert.equal(await readFile(path.join(f.temp, 'calls.txt'), 'utf8'), '1');
    const restarted = new ExternalTools({ dataDir: f.dataDir, projectRoot: process.cwd() });
    assert.equal((await restarted.queryOutcome('uncertain', prepared.digest)).status, 'unknown');
    await restarted.close();
  } finally { await f.close(); }
});
