import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '../../../..');
const backendBuild = process.env.NPN_LIBRARY_BACKEND_BUILD ?? path.join(root, 'build');
const { startBackend } = await import(pathToFileURL(path.join(backendBuild, 'src/app/backend.js')).href);
const owned = path.join(root, '.tmp/product-completion-ui/real-api');
const evidence = path.join(root, 'evidence/backend-20261026/product-completion-ui-20261030');
mkdirSync(owned, { recursive: true }); mkdirSync(evidence, { recursive: true });
const bundle = await build({ entryPoints: [path.join(root, 'src/frontend/api/bridge.ts')], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24', logLevel: 'silent' });
const { BridgeGateway } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const requests = []; let modelCalls = 0, backend;
const startedAt = new Date().toISOString();
let failure;
try {
  backend = await startBackend({ projectRoot: root, dataDir: path.join(owned, 'data'), mockOptions: { trace: () => modelCalls++ } });
  const gateway = new BridgeGateway({
    request: async (method, route, body) => {
      const response = await fetch(`http://127.0.0.1:${backend.port}${route}`, { method, headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      requests.push({ method, route, status: response.status });
      const result = await response.json(); return response.ok ? result : { ...result, httpStatus: response.status };
    }, desktop: async () => assert.fail('Unexpected desktop action'),
  });
  const h = backend.services.harness, session = h.store.createSession();
  const body = { model: h.profiles.get('default').provider.model, messages: [{ role: 'user', content: 'Local import preview' }], max_tokens: 64, vendor_extra: { retained: true } };
  const captured = h.store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'chat', status: 'completed', endpoint: 'mock', bodyHash: 'fixture-body', recordContent: true, body, sources: [], draft: '' });
  await h.route('POST', new URL('http://local/v1/harness/prompts'), { scope: 'session', scopeId: session.id, systemPrompt: 'first' });
  await h.route('POST', new URL('http://local/v1/harness/prompts'), { scope: 'session', scopeId: session.id, systemPrompt: 'second' });
  h.store.addMessage(session.id, { role: 'assistant', content: 'Fixture response' });
  const checked = await gateway.library.validateRequest(session.id, body, captured.id); assert.deepEqual(checked.body, body);
  const saved = await gateway.library.savePreset({ sessionId: session.id, kind: 'request', scope: 'session', name: 'UI preset', value: body, sourceRequestId: captured.id });
  const newVersion = await gateway.library.savePreset({ sessionId: session.id, id: saved.id, expectedVersion: 1, kind: 'request', scope: 'session', name: 'UI preset', value: { ...body, temperature: 0.2 }, sourceRequestId: captured.id });
  assert.equal(newVersion.version, 2);
  // Exact UI page sizes, checked against real ProductLibrary bounds (requests max 10; presets/prompt max 20).
  assert.equal((await gateway.library.presets({ sessionId: session.id, kind: 'request', scope: 'session', limit: 10 })).items[0].id, saved.id);
  assert.equal((await gateway.library.presetVersions({ sessionId: session.id, id: saved.id, limit: 10 })).items.length, 2);
  assert.equal((await gateway.library.promptVersions(session.id, { scope: 'session', limit: 10 })).items.length, 2);
  assert.equal((await gateway.library.requestVersions(session.id, { limit: 10 })).items[0].id, captured.id);
  assert.equal((await gateway.library.preset({ sessionId: session.id, id: saved.id, version: 1 })).value.temperature, undefined);
  await assert.rejects(gateway.library.presets({ sessionId: session.id, kind: 'request', scope: 'session', limit: 30 }), error => error.code === 'validation');
  await assert.rejects(gateway.library.requestVersions(session.id, { limit: 30 }), error => error.code === 'validation');
  assert.equal((await gateway.library.sessionSettings(session.id)).supported.mcp, false);
  const settings = await gateway.library.saveSessionSettings(session.id, { parameters: { temperature: 0.3, max_tokens: 64 }, capabilities: { web: false, tools: false, skills: true, projectInstructions: false, mcp: false } });
  assert.equal(settings.parameters.temperature, 0.3); assert.equal(settings.capabilities.skills, true);
  const page = await gateway.library.exportConversation(session.id, { limit: 30 }); assert.equal(page.messages.length, 1); assert.equal(page.requests.length, 1); assert.equal(page.scope, 'current-session');
  assert.equal(modelCalls, 0); assert.equal(h.store.listRequests({ sessionId: session.id }).requests.length, 1);
  assert.equal(requests.filter(request => request.status === 400).length, 2); assert.equal(requests.filter(request => request.status === 200).length, 11);
} catch (error) { failure = String(error.stack ?? error); }
finally {
  if (backend) await backend.close();
  writeFileSync(path.join(evidence, 'bridge-api-results.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), backendBuild, passed: !failure, requests, modelCalls, failure }, null, 2));
  console.log(failure ?? `PASS real Bridge → authenticated HTTP library queries (${requests.length} calls, 0 model calls)`);
  process.exitCode = failure ? 1 : 0;
}
