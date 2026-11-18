import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';
import { startBackend } from '../src/app/backend.js';

// Projection fixtures use public persistence APIs. They are not claims of executed tool effects.
async function fixture(t: import('node:test').TestContext) {
  const root = path.resolve(process.env.TEMP ?? '.tmp/inspector-completion-20261104');
  mkdirSync(root, { recursive: true });
  const owned = mkdtempSync(path.join(root, 'inspector-details-'));
  let modelCalls = 0;
  const backend = await startBackend({ projectRoot: process.cwd(), dataDir: path.join(owned, 'data'), mockOptions: { trace: () => modelCalls++ } });
  t.after(async () => { await backend.close(); assert.equal(path.dirname(owned), root); rmSync(owned, { recursive: true, force: true }); });
  const bundle = await build({ entryPoints: ['src/frontend/api/bridge.ts'], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' });
  const bridgePath = path.join(owned, 'bridge.mjs');
  writeFileSync(bridgePath, bundle.outputFiles![0]!.text);
  const { BridgeGateway } = await import(pathToFileURL(bridgePath).href);
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${backend.port}${route}`, { method, headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value: any = await response.json(); return response.ok ? value : { ...value, httpStatus: response.status };
  };
  const gateway = new BridgeGateway({ request: call, desktop: async () => assert.fail('No native effects') });
  const store = backend.services.harness!.store, session = store.createSession(), other = store.createSession();
  const schema = { type: 'object', description: 'historical schema', properties: { value: { type: 'string' } } };
  const request = store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'studio', status: 'completed', endpoint: 'mock', bodyHash: 'fixture', recordContent: true, body: { model: 'mock', messages: [], tools: [{ type: 'function', function: { name: 'fixture_tool', description: 'historical description', parameters: schema } }] }, sources: [], draft: '' });
  const args = { value: '深层😀'.repeat(7000), array: Array.from({ length: 125 }, (_, i) => ({ i })), auth_token: 'NEVER-DISCLOSE' };
  const tool = store.saveTool({ id: request.id + ':same-provider-id', toolCallId: 'same-provider-id', name: 'fixture_tool', arguments: args, requestId: request.id, sessionId: session.id, source: 'builtin', schema, description: 'historical description', permission: 'model_only', status: 'not_executed', retries: 0, result: { content: 'result'.repeat(7000) }, createdAt: request.createdAt, updatedAt: request.updatedAt });
  return { backend, store, session, other, request, tool, args, schema, gateway, call, modelCalls: () => modelCalls };
}

test('Inspector detail uses actual Bridge/HTTP, keeps historical schema and reads all redacted arguments in bounded pages', async t => {
  const f = await fixture(t);
  const schema = await f.gateway.inspector.toolDetail(f.session.id, f.tool.id, 'schema');
  assert.deepEqual(JSON.parse(schema.text), f.schema); assert.equal(schema.available, true);
  assert.equal((await f.gateway.inspector.toolDetail(f.session.id, f.tool.id, 'description')).text, 'historical description');
  let offset = 0, text = '', pages = 0;
  do { const page = await f.gateway.inspector.toolDetail(f.session.id, f.tool.id, 'arguments', offset); assert.equal(page.offset, offset); assert.ok(page.text.length <= 6000); text += page.text; pages++; if (page.nextOffset === undefined) break; assert.ok(page.nextOffset > offset); offset = page.nextOffset; } while (pages < 100);
  assert.ok(pages > 5); const actual = JSON.parse(text); assert.equal(actual.value, f.args.value); assert.deepEqual(actual.array, f.args.array); assert.doesNotMatch(text, /NEVER-DISCLOSE/); assert.equal(f.modelCalls(), 0);
  assert.deepEqual(f.store.getTool(f.tool.id).arguments, f.args, 'read does not mutate source');
});

test('Inspector detail rejects foreign sessions, invalid sections/offsets and hidden recording without executing anything', async t => {
  const f = await fixture(t);
  await assert.rejects(f.gateway.inspector.toolDetail(f.other.id, f.tool.id, 'arguments'), (e: any) => e.code === 'not_found');
  await assert.rejects(f.gateway.inspector.toolDetail(f.session.id, f.tool.id, 'invalid'), (e: any) => e.code === 'validation');
  await assert.rejects(f.gateway.inspector.toolDetail(f.session.id, f.tool.id, 'arguments', -1), (e: any) => e.code === 'validation');
  f.store.saveTool({ ...f.tool, name: 'not_exposed' });
  assert.equal((await f.gateway.inspector.toolDetail(f.session.id, f.tool.id, 'schema')).available, false, 'registry fallback is not evidence of a schema sent in this request');
  f.store.updateRequest(f.request.id, { recordContent: false });
  const hidden = await f.gateway.inspector.toolDetail(f.session.id, f.tool.id, 'arguments');
  assert.equal(hidden.available, false); assert.equal(hidden.text, ''); assert.match(hidden.reason, /记录/); assert.equal(f.modelCalls(), 0);
});

test('Inspector real trace DTO correlates request children and keeps native session/run identifiers', async t => {
  const f = await fixture(t);
  const first = f.store.trace({ sessionId: f.session.id, requestId: f.request.id, runId: 'run-exact', type: 'prompt.assembled', status: 'completed' });
  const second = f.store.trace({ sessionId: f.session.id, requestId: f.request.id, runId: 'run-exact', type: 'request.completed', status: 'completed' });
  const child = f.store.createRequest({ ...f.request, id: undefined, parentId: f.request.id, bodyHash: 'child' } as any);
  const third = f.store.trace({ sessionId: f.session.id, requestId: child.id, parentId: f.request.id, type: 'prompt.assembled', status: 'completed' });
  const view = await f.gateway.inspector.trace(f.session.id);
  assert.equal(view.spans.find((s: any) => s.id === `trace-${second.id}`).parentId, `trace-${first.id}`);
  assert.equal(view.spans.find((s: any) => s.id === `trace-${third.id}`).parentId, `trace-${first.id}`);
  assert.equal(view.spans.find((s: any) => s.id === `trace-${second.id}`).runId, 'run-exact');
  assert.equal(view.spans.find((s: any) => s.id === `trace-${second.id}`).sessionId, f.session.id);
  assert.equal(f.modelCalls(), 0);
});

test('Inspector trace enforces the 300-character boundary through authenticated HTTP', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('GET', `/v1/product/inspector/trace?sessionId=${f.session.id}&text=${'a'.repeat(301)}`)).httpStatus, 400);
  assert.equal((await f.gateway.inspector.trace(f.session.id, { text: 'a'.repeat(300) })).hasMore, false);
});

test('Inspector nests only recorded unambiguous tool continuations and keeps page-orphans visible', async t => {
  const f = await fixture(t);
  const childRequest = f.store.createRequest({ ...f.request, id: undefined, parentId: f.request.id, bodyHash: 'child' } as any);
  f.store.saveTool({ ...f.tool, receivedByRequestId: childRequest.id });
  const child = f.store.saveTool({ ...f.tool, id: childRequest.id + ':child', requestId: childRequest.id, parentId: f.request.id, name: 'mcp_call', source: 'MCP' });
  let view = await f.gateway.inspector.tools(f.session.id);
  assert.equal(view.calls.length, 1); assert.equal(view.calls[0].children[0].id, child.id);
  f.store.saveTool({ ...f.tool, id: f.request.id + ':another', receivedByRequestId: childRequest.id });
  view = await f.gateway.inspector.tools(f.session.id);
  assert.ok(view.calls.some((call: any) => call.id === child.id), 'two contributing calls do not imply a single parent');
});

test('Inspector offers a real delegated child trace on demand without scanning all tasks or dispatching a model', async t => {
  const f = await fixture(t);
  const parentId = f.backend.services.command({ commandId: randomUUID(), type: 'create_task', parameters: { objective: 'Paused parent', initialStatus: 'paused' } }).taskId!;
  const childId = f.backend.services.command({ commandId: randomUUID(), type: 'create_task', taskId: parentId, origin: 'model', parameters: { objective: 'Paused child' } }).taskId!;
  assert.equal(f.backend.services.kernel.getTask(childId)!.parentId, parentId);
  assert.equal(f.backend.services.kernel.getTask(childId)!.status, 'paused');
  let view: any;
  for (let i = 0; i < 60; i++) { view = await f.gateway.inspector.trace(parentId); if (view.spans.some((s: any) => s.childSessionId === childId)) break; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.ok(view.spans.some((s: any) => s.childSessionId === childId));
  const child = await f.gateway.inspector.trace(childId);
  assert.ok(child.spans.some((s: any) => s.sourceParentId === parentId));
  assert.equal(f.modelCalls(), 0);
});
