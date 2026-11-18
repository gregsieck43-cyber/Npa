import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { startBackend } from '../src/app/backend.js';

// Public persistence fixtures test historical projection. Actual first-prepare capture is covered
// by the separately owned mcp-definition-history.test.ts real stdio execution suite.
async function fixture(t: import('node:test').TestContext) {
  const root = path.resolve(process.env.TEMP!); mkdirSync(root, { recursive: true });
  const owned = mkdtempSync(path.join(root, 'mcp-inspector-'));
  let modelCalls = 0, catalogReads = 0;
  const backend = await startBackend({ projectRoot: process.cwd(), dataDir: path.join(owned, 'data'), mockOptions: { trace: () => modelCalls++ } });
  t.after(async () => { await backend.close(); assert.equal(path.dirname(owned), root); rmSync(owned, { recursive: true, force: true }); });
  // Any attempt to synthesize history from current live discovery must fail this test.
  backend.services.external.tools = async () => { catalogReads++; throw new Error('Current catalog is not historical evidence'); };
  const store = backend.services.harness!.store, session = store.createSession(), other = store.createSession();
  const request = store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'chat', status: 'completed', endpoint: 'fixture', bodyHash: 'fixture', recordContent: true, body: { model: 'mock', messages: [], tools: [{ type: 'function', function: { name: 'mcp_call', description: 'Generic MCP wrapper', parameters: { type: 'object', properties: { serverId: { type: 'string' } } } } }] }, sources: [], draft: '' });
  const definition = { serverId: 'offline-old-server', toolName: 'lookup', digest: 'd'.repeat(64), available: true, description: 'Actual historical lookup v1', inputSchema: { type: 'object', description: '历史'.repeat(4000), properties: { query: { type: 'string' } }, api_key: 'NEVER-DISCLOSE' }, annotations: { readOnlyHint: true } };
  const tool = store.saveTool({ id: request.id + ':call', requestId: request.id, sessionId: session.id, toolCallId: 'call', name: 'mcp_call', source: 'MCP', arguments: { serverId: definition.serverId, toolName: definition.toolName }, status: 'succeeded', permission: 'approved', retries: 0, createdAt: request.createdAt, updatedAt: request.updatedAt, mcpDefinition: definition });
  const bundle = await build({ entryPoints: ['src/frontend/api/bridge.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  const file = path.join(owned, 'bridge.mjs'); writeFileSync(file, bundle.outputFiles![0]!.text);
  const { BridgeGateway } = await import(pathToFileURL(file).href);
  const gateway = new BridgeGateway({ request: async (method: string, route: string) => {
    const response = await fetch(`http://127.0.0.1:${backend.port}${route}`, { method, headers: { Authorization: `Bearer ${backend.token}` } });
    const value = await response.json(); return response.ok ? value : { ...value, httpStatus: response.status };
  }, desktop: async () => assert.fail('No desktop effects') });
  return { store, session, other, request, tool, definition, gateway, counters: () => ({ modelCalls, catalogReads }) };
}

test('historical MCP definition round-trips through Bridge/HTTP in bounded redacted pages independently of wrapper/catalog', async t => {
  const f = await fixture(t); let text = '', offset = 0, pages = 0, digest: string | undefined;
  for (;;) {
    const page = await f.gateway.inspector.toolDetail(f.session.id, f.tool.id, 'mcpDefinition', offset);
    assert.equal(page.available, true); assert.ok(page.text.length <= 6000); assert.equal(page.offset, offset);
    assert.equal(digest ?? page.sha256, page.sha256); digest = page.sha256; text += page.text; pages++;
    if (page.nextOffset === undefined) break; assert.ok(page.nextOffset > offset); offset = page.nextOffset; assert.ok(pages < 10);
  }
  assert.ok(pages > 1); const value = JSON.parse(text);
  assert.equal(value.description, f.definition.description); assert.equal(value.digest, f.definition.digest);
  assert.equal(value.inputSchema.description, f.definition.inputSchema.description); assert.deepEqual(value.annotations, { readOnlyHint: true });
  assert.doesNotMatch(text, /NEVER-DISCLOSE/); assert.equal(value.inputSchema.api_key, '[credential redacted]');
  assert.notEqual(digest, value.digest, 'display-text SHA differs from the immutable prepared-definition digest');
  assert.deepEqual(JSON.parse((await f.gateway.inspector.toolDetail(f.session.id, f.tool.id, 'schema')).text), f.request.body!.tools[0].function.parameters);
  assert.deepEqual(f.store.getTool(f.tool.id).mcpDefinition, f.definition); assert.deepEqual(f.counters(), { modelCalls: 0, catalogReads: 0 });
});

test('missing/disabled MCP history stays unavailable and never consults present server definitions', async t => {
  const f = await fixture(t);
  await assert.rejects(f.gateway.inspector.toolDetail(f.other.id, f.tool.id, 'mcpDefinition'), (error: any) => error.code === 'not_found');
  f.store.saveTool({ ...f.tool, mcpDefinition: undefined });
  const missing = await f.gateway.inspector.toolDetail(f.session.id, f.tool.id, 'mcpDefinition');
  assert.equal(missing.available, false); assert.equal(missing.text, ''); assert.match(missing.reason, /历史 MCP/);
  f.store.saveTool({ ...f.tool, mcpDefinition: { serverId: 'server', toolName: 'lookup', digest: 'f'.repeat(64), available: false } });
  const disabled = await f.gateway.inspector.toolDetail(f.session.id, f.tool.id, 'mcpDefinition');
  assert.equal(disabled.available, false); assert.equal(disabled.text, ''); assert.match(disabled.reason, /详细内容记录/);
  f.store.saveTool(f.tool); f.store.updateRequest(f.request.id, { recordContent: false });
  const hidden = await f.gateway.inspector.toolDetail(f.session.id, f.tool.id, 'mcpDefinition');
  assert.equal(hidden.available, false); assert.equal(hidden.text, '');
  assert.deepEqual(f.counters(), { modelCalls: 0, catalogReads: 0 });
});
