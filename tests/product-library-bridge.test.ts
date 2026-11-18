import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { startBackend } from '../src/app/backend.js';
import type { LibraryGateway } from '../src/frontend/api/library-types.js';

test('library bridge: ten gateway methods round-trip through authenticated product HTTP without execution', async t => {
  const root = path.join(process.cwd(), '.tmp', 'product-library'); mkdirSync(root, { recursive: true });
  const owned = mkdtempSync(path.join(root, 'bridge-'));
  let modelCalls = 0;
  const backend = await startBackend({ projectRoot: process.cwd(), dataDir: path.join(owned, 'data'), mockOptions: { trace: () => modelCalls++ } });
  t.after(async () => { await backend.close(); assert.ok(path.relative(root, owned) && !path.relative(root, owned).startsWith('..')); rmSync(owned, { recursive: true, force: true }); });
  // Build exactly the production adapter in memory; no mock transport or source-copy approximation.
  const bundle = await build({ entryPoints: [path.join(process.cwd(), 'src/frontend/api/bridge.ts')], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24', logLevel: 'silent' });
  const { BridgeGateway } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles![0]!.text).toString('base64'));
  const calls: string[] = [];
  const gateway = new BridgeGateway({
    request: async (method: string, route: string, body?: unknown) => {
      calls.push(method + ' ' + route);
      const response = await fetch(`http://127.0.0.1:${backend.port}${route}`, { method, headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json() as Record<string, unknown>;
      return response.ok ? result : { ...result, httpStatus: response.status };
    },
    desktop: async () => assert.fail('Library must not dispatch native actions.'),
  }) as { library: LibraryGateway };
  const h = backend.services.harness!, session = h.store.createSession();
  h.store.addMessage(session.id, { role: 'assistant', content: 'answer', reasoningContent: 'reason' });
  await h.route('POST', new URL('http://local/v1/harness/prompts'), { scope: 'session', scopeId: session.id, systemPrompt: 'versioned prompt' });
  const body = { model: h.profiles.get('default').provider.model, max_tokens: 64, messages: [{ role: 'user', content: 'validation' }] };
  const captured = h.store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'chat', status: 'completed', endpoint: 'mock', bodyHash: 'captured-sha', recordContent: true, body, sources: [], draft: '' });
  const validated = await gateway.library.validateRequest(session.id, body, captured.id); assert.deepEqual(validated.body, body);
  const saved = await gateway.library.savePreset({ sessionId: session.id, kind: 'request', scope: 'global', name: 'bridge request', value: body, sourceRequestId: captured.id });
  assert.equal((await gateway.library.presets({ sessionId: session.id, kind: 'request', scope: 'global' })).items[0]!.id, saved.id);
  assert.equal((await gateway.library.preset({ sessionId: session.id, id: saved.id, version: 1 })).version, 1);
  assert.equal((await gateway.library.presetVersions({ sessionId: session.id, id: saved.id })).items.length, 1);
  assert.equal((await gateway.library.promptVersions(session.id, { scope: 'session' })).items[0]!.systemPrompt, 'versioned prompt');
  assert.equal((await gateway.library.requestVersions(session.id)).items[0]!.bodyHash, 'captured-sha');
  assert.equal((await gateway.library.sessionSettings(session.id)).supported.mcp, true);
  assert.equal((await gateway.library.saveSessionSettings(session.id, { parameters: { temperature: 0.5 } })).parameters.temperature, 0.5);
  const exported = await gateway.library.exportConversation(session.id, { limit: 1 });
  assert.equal((exported.messages[0] as { reasoningContent: string }).reasoningContent, 'reason');
  assert.ok(exported.nextCursor); assert.equal(exported.scope, 'current-session');
  await assert.rejects(gateway.library.validateRequest(session.id, { ...body, auth_token: 'synthetic' }, captured.id), (error: any) => error.code === 'validation');
  assert.equal(calls.length, 11); assert.equal(modelCalls, 0);
  assert.equal(h.store.listRequests({ sessionId: session.id }).requests.length, 1);
});
