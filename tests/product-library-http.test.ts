import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import type { MockProviderOptions } from '../src/fixtures/mock-provider.js';

const root = path.join(process.cwd(), '.tmp', 'product-library');
mkdirSync(root, { recursive: true });
async function fixture(t: import('node:test').TestContext, mockOptions: MockProviderOptions = {}) {
  const owned = mkdtempSync(path.join(root, 'http-'));
  const workspace = path.join(owned, 'workspace'); mkdirSync(workspace);
  const wire: any[] = [];
  const options = { projectRoot: process.cwd(), dataDir: path.join(owned, 'data'), mockOptions: { ...mockOptions, trace: (body: any) => wire.push(body) } };
  let backend = await startBackend(options);
  async function call(method: string, route: string, body?: unknown, auth = true) {
    const response = await fetch(`http://127.0.0.1:${backend.port}${route.startsWith('/v1/') ? route : '/v1/product/library' + route}`, {
      method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${backend.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  }
  async function ok(method: string, route: string, body?: unknown) {
    const result = await call(method, route, body); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  const session = () => backend.services.harness!.store.createSession({ workspace, capabilities: { web: false, tools: false, skills: false, projectInstructions: false, mcp: false } });
  const restart = async () => { await backend.close(); backend = await startBackend(options); };
  t.after(async () => { await backend.close(); assert.ok(path.relative(root, owned) && !path.relative(root, owned).startsWith('..')); rmSync(owned, { recursive: true, force: true }); });
  return { get backend() { return backend; }, call, ok, session, restart, workspace, wire };
}

test('library HTTP: auth, immutable preset scopes, version conflicts and restart', async t => {
  const f = await fixture(t), session = f.session(), other = f.session();
  assert.equal((await f.call('GET', `/presets?sessionId=${session.id}&kind=prompt&scope=session`, undefined, false)).status, 401);
  const input = { sessionId: session.id, name: 'Writing', kind: 'prompt', scope: 'session', value: { systemPrompt: 'v1' } };
  const saved = await f.ok('POST', '/presets/save', input);
  assert.equal(saved.version, 1);
  const newer = await f.ok('POST', '/presets/save', { ...input, id: saved.id, expectedVersion: 1, value: { systemPrompt: 'v2' } });
  assert.equal(newer.version, 2);
  assert.equal((await f.call('POST', '/presets/save', { ...input, id: saved.id, expectedVersion: 1 })).status, 409);
  assert.equal((await f.call('POST', '/presets/save', { ...input, id: saved.id, scope: 'global' })).status, 400);
  assert.equal((await f.call('GET', `/preset?sessionId=${other.id}&id=${saved.id}`)).status, 404);
  await f.restart();
  const history = await f.ok('GET', `/preset-versions?sessionId=${session.id}&id=${saved.id}&limit=1`);
  assert.equal(history.items[0].value.systemPrompt, 'v2'); assert.ok(history.nextCursor);
  const previous = await f.ok('GET', `/preset-versions?sessionId=${session.id}&id=${saved.id}&cursor=${encodeURIComponent(history.nextCursor)}`);
  assert.equal(previous.items[0].value.systemPrompt, 'v1');
  assert.deepEqual(f.wire, []);
});

test('library HTTP: request imports reject secret-like fields recursively without dispatch', async t => {
  const f = await fixture(t), session = f.session();
  const profile = f.backend.services.harness!.profiles.get('default').provider;
  const body = { model: profile.model, max_tokens: 64, messages: [{ role: 'user', content: 'Hello' }], temperature: 0.2, safe_extra: { enabled: true } };
  assert.deepEqual((await f.ok('POST', `/validate-request?sessionId=${session.id}`, { body })).body, body);
  for (const extra of [{ api_key: 'synthetic-secret' }, { nested: { clientSecret: 'synthetic-secret' } }, { nested: { refresh_token: 'synthetic-secret' } }, { vendorSecret: 'synthetic-secret' }, { nested: { token: 'synthetic-secret' } }, { baseUrl: 'https://untrusted.invalid' }]) {
    const reply = await f.call('POST', `/validate-request?sessionId=${session.id}`, { body: { ...body, ...extra } });
    assert.equal(reply.status, 400); assert.equal(reply.body.code, 'validation');
    assert.ok(!JSON.stringify(reply.body).includes('synthetic-secret'));
  }
  assert.equal((await f.call('POST', '/presets/save', { sessionId: session.id, name: 'invalid', kind: 'request', scope: 'session', value: { ...body, nested: { password: 'x' } } })).status, 400);
  assert.equal((await f.call('POST', `/validate-request?sessionId=${session.id}`, { body: { ...body, messages: [{ role: 'developer', content: 'x' }] } })).status, 400);
  assert.equal(f.backend.services.harness!.store.listRequests({ sessionId: session.id }).requests.length, 0);
  assert.deepEqual(f.wire, []);
});

test('library HTTP: bounded full export preserves reasoning and request data with stable snapshot', async t => {
  const f = await fixture(t), session = f.session(), other = f.session(), store = f.backend.services.harness!.store;
  for (let i = 0; i < 127; i++) store.addMessage(session.id, { role: 'assistant', content: `message-${i}`, reasoningContent: `reason-${i}` });
  const request = store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'chat', status: 'completed', endpoint: 'mock', bodyHash: 'hash', sources: [], recordContent: true, draft: '', body: { model: 'mock', messages: [{ role: 'user', content: 'request-body' }], api_key: 'synthetic-secret' } });
  store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'chat', status: 'completed', endpoint: 'mock', bodyHash: 'no-content', sources: [], recordContent: false, draft: '' });
  // Export must not reach legacy unbounded materialization.
  store.allMessages = () => { throw new Error('Unbounded export'); };
  let page = await f.ok('GET', `/export?sessionId=${session.id}&limit=7`), snapshot = page.snapshot;
  assert.equal(page.messages.length, 7); assert.ok(page.nextCursor);
  assert.equal((await f.call('GET', `/export?sessionId=${other.id}&cursor=${encodeURIComponent(page.nextCursor)}`)).status, 400);
  store.addMessage(session.id, { role: 'user', content: 'after-snapshot' });
  const messages: any[] = [], requests: any[] = [];
  for (let n = 0; ; n++) {
    assert.ok(n < 30); assert.equal(page.snapshot, snapshot); assert.ok(page.messages.length + page.requests.length <= 7);
    messages.push(...page.messages); requests.push(...page.requests);
    if (!page.nextCursor) break;
    page = await f.ok('GET', `/export?sessionId=${session.id}&limit=7&cursor=${encodeURIComponent(page.nextCursor)}`);
  }
  assert.equal(messages.length, 127); assert.equal(messages[126].reasoningContent, 'reason-126');
  assert.equal(requests.length, 2); assert.equal(requests[0].id, request.id); assert.equal(requests[0].body.api_key, '[credential redacted]');
  assert.equal(requests[1].recordContent, false); assert.equal(requests[1].body, undefined);
  assert.ok(!JSON.stringify(requests).includes('synthetic-secret'));
});

test('library HTTP: prompt and request versions are paginated and exactly scoped', async t => {
  const f = await fixture(t), session = f.session(), store = f.backend.services.harness!.store;
  for (let i = 1; i <= 4; i++) await f.backend.services.harness!.route('POST', new URL('http://local/v1/harness/prompts'), { scope: 'session', scopeId: session.id, systemPrompt: `v${i}` });
  const page = await f.ok('GET', `/prompt-versions?sessionId=${session.id}&scope=session&limit=2`);
  assert.deepEqual(page.items.map((v: any) => v.version), [4, 3]);
  const old = await f.ok('GET', `/prompt-versions?sessionId=${session.id}&scope=session&cursor=${encodeURIComponent(page.nextCursor)}`);
  assert.deepEqual(old.items.map((v: any) => v.systemPrompt), ['v2', 'v1']);
  const other = f.session();
  assert.equal((await f.call('GET', `/prompt-versions?sessionId=${other.id}&scope=session&cursor=${encodeURIComponent(page.nextCursor)}`)).status, 400);
  for (let i = 0; i < 4; i++) store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'studio', status: 'draft', endpoint: 'mock', bodyHash: String(i), sources: [], recordContent: true, draft: '', body: { version: i } });
  const requests = await f.ok('GET', `/request-versions?sessionId=${session.id}&limit=2`);
  assert.deepEqual(requests.items.map((v: any) => v.body.version), [3, 2]);
  assert.equal((await f.ok('GET', `/request-versions?sessionId=${other.id}`)).items.length, 0);
});

test('library HTTP: saved settings affect only future wire, survive restart and enforce Chat capabilities', async t => {
  const f = await fixture(t), session = f.session(), harness = f.backend.services.harness!;
  writeFileSync(path.join(f.workspace, 'AGENTS.md'), 'LIBRARY_PROJECT_MARKER');
  const skills = path.join(f.workspace, 'skills'), skill = path.join(skills, 'library-proof'); mkdirSync(skill, { recursive: true });
  writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: library-proof\ndescription: libraryproof verification\n---\nLIBRARY_SKILL_MARKER');
  f.backend.services.configuration.set({ mode: 'mock', skillRoots: [skills] });
  const send = async (content: string) => {
    const h = f.backend.services.harness!;
    await f.ok('POST', '/v1/product/chat/send', { sessionId: session.id, text: content, modelId: 'default', mode: 'chat', permission: 'read-only' });
    for (let i = 0; i < 300 && h.chat.busy(session.id); i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(h.chat.busy(session.id), false); return h.store.latestRequest(session.id, 'chat')!;
  };
  const first = await send('before settings');
  const saved = await f.ok('POST', `/session-settings?sessionId=${session.id}`, { parameters: { temperature: 0.3, max_tokens: 64 }, capabilities: { tools: true, web: true, skills: true, projectInstructions: true } });
  assert.equal(saved.supported.mcp, true); assert.equal(saved.unsupportedReasons.mcp, undefined);
  assert.equal((await f.ok('POST', `/session-settings?sessionId=${session.id}`, { capabilities: { mcp: true } })).capabilities.mcp, true);
  assert.equal((await f.call('POST', `/session-settings?sessionId=${session.id}`, { parameters: { model: 'other' } })).status, 400);
  assert.equal((await f.call('POST', `/session-settings?sessionId=${session.id}`, { capabilities: { bogus: true } })).status, 400);
  await f.restart();
  assert.equal((await f.ok('GET', `/session-settings?sessionId=${session.id}`)).parameters.temperature, 0.3);
  const second = await send('libraryproof after settings');
  assert.equal(second.body?.temperature, 0.3); assert.equal(second.body?.max_tokens, 64);
  const names = second.body?.tools.map((tool: any) => tool.function.name);
  assert.ok(names.includes('mcp_read')); assert.ok(names.includes('list_mcp_tools'));
  assert.ok(names.includes('read_file')); assert.ok(names.includes('web_search')); assert.ok(!names.includes('mcp_call'));
  assert.ok(JSON.stringify(second.body?.messages).includes('LIBRARY_PROJECT_MARKER'));
  assert.ok(JSON.stringify(second.body?.messages).includes('LIBRARY_SKILL_MARKER'));
  assert.equal(f.backend.services.harness!.store.getRequest(first.id).body?.temperature, first.body?.temperature);
  assert.equal(harness === f.backend.services.harness, false);
});

test('library HTTP: oversized records export losslessly in bounded fragments; clear history invalidates cursors but preserves presets', async t => {
  const f = await fixture(t), session = f.session(), h = f.backend.services.harness!;
  h.profiles.get('default').set({ mode: 'mock', apiKey: 'LOCAL_SYNTHETIC_CREDENTIAL_7F' }, false);
  const content = '字'.repeat(610_000) + 'LOCAL_SYNTHETIC_CREDENTIAL_7F';
  h.store.addMessage(session.id, { role: 'assistant', content, reasoningContent: 'LOCAL_SYNTHETIC_CREDENTIAL_7F' });
  const preset = await f.ok('POST', '/presets/save', { sessionId: session.id, name: 'remain', kind: 'prompt', scope: 'session', value: { systemPrompt: 'LOCAL_SYNTHETIC_CREDENTIAL_7F' } });
  assert.equal(preset.value.systemPrompt, '[credential redacted]');
  let page = await f.ok('GET', `/export?sessionId=${session.id}`), text = '', next: string | undefined;
  do {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1_600_000);
    for (const fragment of page.fragments) { assert.equal(fragment.offset, text.length); text += fragment.json; }
    next = page.nextCursor;
    if (next) page = await f.ok('GET', `/export?sessionId=${session.id}&cursor=${encodeURIComponent(next)}`);
  } while (next);
  const exported = JSON.parse(text); assert.equal(exported.content, '字'.repeat(610_000) + '[credential redacted]');
  assert.equal(exported.reasoningContent, '[credential redacted]');
  for (let i = 0; i < 2; i++) h.store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'chat', status: 'completed', endpoint: 'mock', bodyHash: String(i), sources: [], recordContent: false, draft: '' });
  page = await f.ok('GET', `/export?sessionId=${session.id}&limit=1`);
  await f.ok('POST', '/v1/harness/history/clear', { sessionId: session.id });
  assert.equal((await f.call('GET', `/export?sessionId=${session.id}&cursor=${encodeURIComponent(page.nextCursor)}`)).status, 409);
  assert.equal((await f.ok('GET', `/preset?sessionId=${session.id}&id=${preset.id}`)).version, 1);
});

test('library HTTP: busy and malformed session settings leave the saved configuration untouched', async t => {
  const f = await fixture(t, { delayMs: 300 }), session = f.session();
  await f.ok('POST', '/v1/product/chat/send', { sessionId: session.id, text: 'busy guard', mode: 'chat', modelId: 'default', permission: 'read-only' });
  const reply = await f.call('POST', `/session-settings?sessionId=${session.id}`, { parameters: { temperature: 0.7 } });
  assert.equal(reply.status, 409); assert.equal(reply.body.code, 'busy');
  assert.equal((await f.call('GET', `/export?sessionId=${session.id}`)).status, 409);
  assert.deepEqual(f.backend.services.harness!.store.getSession(session.id).parameters, {});
  await f.backend.services.harness!.chat.cancelAndSettle(session.id);
  for (const parameters of [null, [], 'text', { temperature: 9 }, { max_completion_tokens: 64 }, { nested: { vendor_secret: 'x' } }]) {
    assert.equal((await f.call('POST', `/session-settings?sessionId=${session.id}`, { parameters })).status, 400);
  }
  const prompt = { sessionId: session.id, name: 'empty developer reset', kind: 'prompt', scope: 'global', value: { developerPrompt: '' } };
  assert.equal((await f.call('POST', '/presets/save', prompt)).status, 200);
  assert.equal((await f.call('POST', '/presets/save', { ...prompt, value: { developerPrompt: 'unsupported' } })).status, 400);
});

test('library HTTP: historical request profile is explicit and foreign request IDs never supply validation authority', async t => {
  const f = await fixture(t), session = f.session(), other = f.session(), h = f.backend.services.harness!;
  const historical = h.profiles.save({ name: 'historical', model: 'historical-model', mode: 'mock', supportsDeveloper: true, maxOutputTokens: 64 });
  const body = { model: 'historical-model', max_tokens: 64, messages: [{ role: 'developer', content: 'historical developer instruction' }, { role: 'user', content: 'draft' }] };
  const record = h.store.createRequest({ sessionId: session.id, profileId: historical.id, kind: 'chat', status: 'completed', endpoint: 'mock', bodyHash: 'old', sources: [], recordContent: true, draft: '', body });
  assert.equal((await f.call('POST', `/validate-request?sessionId=${session.id}`, { body })).status, 400);
  assert.deepEqual((await f.ok('POST', `/validate-request?sessionId=${session.id}&requestId=${record.id}`, { body })).body, body);
  assert.equal((await f.call('POST', `/validate-request?sessionId=${other.id}&requestId=${record.id}`, { body })).status, 404);
  const preset = await f.ok('POST', '/presets/save', { sessionId: session.id, sourceRequestId: record.id, name: 'historical body', kind: 'request', scope: 'session', value: body });
  assert.deepEqual(preset.value, body);
  const count = h.store.listRequests({ sessionId: session.id }).requests.length;
  assert.equal((await f.call('POST', '/v1/product/inspector/replay', { requestId: record.id, mode: 'branch', body: { ...body, vendorSecret: 'synthetic-hidden' } })).status, 400);
  assert.equal(h.store.listRequests({ sessionId: session.id }).requests.length, count);
  assert.deepEqual(f.wire, []);
});

test('library HTTP: project presets require selected registered project and never cross workspaces', async t => {
  const f = await fixture(t), session = f.session(), other = f.session();
  const value = { sessionId: session.id, name: 'project prompt', kind: 'prompt', scope: 'project', value: { systemPrompt: 'project one' } };
  assert.equal((await f.call('POST', '/presets/save', value)).status, 400);
  const project = await f.ok('POST', '/v1/product/workspace/projects', { path: f.workspace });
  await f.ok('POST', '/v1/product/chat/send', { sessionId: session.id, text: 'project one', modelId: 'default', mode: 'chat', permission: 'read-only', projectId: project.id });
  const saved = await f.ok('POST', '/presets/save', value);
  assert.equal(saved.scopeId, f.workspace);
  const otherWorkspace = path.join(f.workspace, '..', 'other-workspace'); mkdirSync(otherWorkspace);
  const otherProject = await f.ok('POST', '/v1/product/workspace/projects', { path: otherWorkspace });
  await f.ok('POST', '/v1/product/chat/send', { sessionId: other.id, text: 'project two', modelId: 'default', mode: 'chat', permission: 'read-only', projectId: otherProject.id });
  assert.equal((await f.call('GET', `/preset?sessionId=${other.id}&id=${saved.id}`)).status, 404);
  assert.deepEqual((await f.ok('GET', `/presets?sessionId=${other.id}&scope=project&kind=prompt`)).items, []);
});

test('library HTTP: request version DTO reports the paths of redacted credentials', async t => {
  const f = await fixture(t), session = f.session(), h = f.backend.services.harness!;
  const secret = 'SYNTHETIC_LIBRARY_REDACTION_73';
  h.profiles.get('default').set({ mode: 'mock', apiKey: secret }, false);
  h.store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'chat', status: 'completed', endpoint: 'mock', bodyHash: 'redacted-body', sources: [], recordContent: true, draft: '', body: {
    messages: [{ role: 'user', content: 'Known credential: ' + secret }], nested: { vendorSecret: 'synthetic-import-value' },
  } });
  const page = await f.ok('GET', `/request-versions?sessionId=${session.id}`);
  assert.equal(page.items[0].body.messages[0].content, 'Known credential: [credential redacted]');
  assert.equal(page.items[0].body.nested.vendorSecret, '[credential redacted]');
  assert.deepEqual(page.items[0].redactions, ['$.messages[0].content', '$.nested.vendorSecret']);
  assert.ok(!JSON.stringify(page).includes(secret));
  h.store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'chat', status: 'completed', endpoint: 'mock', bodyHash: 'hidden-body', sources: [], recordContent: false, draft: '' });
  const hidden = await f.ok('GET', `/request-versions?sessionId=${session.id}&limit=1`);
  assert.equal(hidden.items[0].body, null); assert.deepEqual(hidden.items[0].redactions, []);
});

test('library HTTP: rejected prompt overrides preserve pending state and allow the next ordinary send', async t => {
  const f = await fixture(t), session = f.session(), h = f.backend.services.harness!;
  const endpoint = '/v1/product/inspector/prompt';
  await f.ok('POST', '/v1/product/chat/send', { sessionId: session.id, text: 'first turn', modelId: 'default', mode: 'chat', permission: 'read-only' });
  for (let i = 0; i < 300 && h.chat.busy(session.id); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(h.chat.busy(session.id), false);
  for (const scope of ['request', 'session', 'project', 'global']) {
    const rejected = await f.call('POST', endpoint, { sessionId: session.id, partId: 'session:developerPrompt', content: 'unsupported developer', scope });
    assert.equal(rejected.status, 400); assert.equal(rejected.body.code, 'validation');
    assert.deepEqual(h.store.pendingRequestOverrides(session.id), []);
  }
  await f.ok('POST', endpoint, { sessionId: session.id, partId: 'session:systemPrompt', content: 'preserved safe override', scope: 'request' });
  const previous = h.store.pendingRequestOverrides(session.id);
  const originalLimit = h.profiles.get('default').provider.maxRequestBytes;
  h.profiles.get('default').set({ mode: 'mock', maxRequestBytes: 4096 });
  const failed = await f.call('POST', endpoint, { sessionId: session.id, partId: 'session:systemPrompt', content: 'oversized '.repeat(1000), scope: 'request' });
  assert.equal(failed.status, 400); assert.deepEqual(h.store.pendingRequestOverrides(session.id), previous);
  h.profiles.get('default').set({ mode: 'mock', maxRequestBytes: originalLimit });
  await f.ok('POST', '/v1/product/chat/send', { sessionId: session.id, text: 'ordinary next turn', modelId: 'default', mode: 'chat', permission: 'read-only' });
  for (let i = 0; i < 300 && h.chat.busy(session.id); i++) await new Promise(r => setTimeout(r, 10));
  const next = h.store.latestRequest(session.id, 'chat')!;
  assert.equal(next.status, 'completed', JSON.stringify(next.error));
  assert.ok(JSON.stringify(next.body).includes('preserved safe override'));
  assert.ok(!JSON.stringify(next.body).includes('unsupported developer'));
  assert.deepEqual(h.store.pendingRequestOverrides(session.id), []);
});
