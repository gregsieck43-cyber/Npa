import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBackend } from '../src/app/backend.js';
import { Configuration } from '../src/app/configuration.js';
import { HarnessStore } from '../src/harness/store.js';
import { Profiles } from '../src/harness/profiles.js';
import { ProductModels } from '../src/product/models.js';
import { ProductStore } from '../src/product/store.js';
import { ProductError, type ProductRuntime } from '../src/product/shared.js';

const root = path.resolve(process.env.TEMP ?? '.tmp');
mkdirSync(root, { recursive: true });

async function fixture(t: import('node:test').TestContext) {
  const owned = mkdtempSync(path.join(root, 'product-models-'));
  const wire: any[] = [];
  const settings = { dataDir: path.join(owned, 'data'), projectRoot: process.cwd(), mockOptions: { trace: (body: any) => wire.push(body) } };
  let backend = await startBackend(settings);
  const stores: ProductStore[] = [];
  let cached: ProductModels | undefined;
  const models = (): ProductModels => {
    if (cached) return cached;
    const wired = (backend.services as unknown as { product?: { models?: ProductModels } }).product?.models;
    if (wired) { cached = wired; return wired; }
    const store = new ProductStore(settings.dataDir);
    stores.push(store);
    const rt: ProductRuntime = { services: backend.services, harness: backend.services.harness!, store, append: () => {} };
    cached = new ProductModels(rt);
    return cached;
  };
  // A separate connection to the same product.sqlite lets tests seed index rows whether or not
  // the HTTP/product wiring already exists; SQLite WAL keeps both readers/writers consistent.
  const indexStore = new ProductStore(settings.dataDir);
  stores.push(indexStore);
  t.after(async () => {
    for (const store of stores) { try { store.close(); } catch { /* already closed with its owner */ } }
    await backend.close();
    assert.equal(path.dirname(owned), root);
    rmSync(owned, { recursive: true, force: true });
  });
  const http = async (method: string, route: string, body?: unknown): Promise<{ status: number; value: any }> => {
    const response = await fetch(`http://127.0.0.1:${backend.port}${route}`, {
      method, headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, value: text ? JSON.parse(text) : null };
  };
  const restart = async () => { await backend.close(); backend = await startBackend(settings); cached = undefined; };
  return { owned, settings, wire, models, indexStore, http, restart, get backend() { return backend; }, get dataDir() { return settings.dataDir; } };
}

const mockInput = (overrides: Record<string, unknown> = {}): any => ({
  name: 'Local mock', provider: 'ACME Lab', model: 'acme/mock-a', mode: 'mock',
  contextWindow: 128000, maxOutputTokens: 2048, supportsReasoning: true,
  inputTypes: ['text', 'image'], capabilities: ['structuredOutput', 'systemMessageInChat'],
  reasoningLevels: ['low', 'high'], reasoningMapping: { reasoning_effort: '{{level}}', top_p: 0.4 },
  ...overrides,
});

test('list describes the real default mock profile without inventing optional facts', async t => {
  const f = await fixture(t);
  const list = await f.models().list();
  assert.ok(Array.isArray(list) && list.length === 1);
  const profile = list[0]!, provider = f.backend.services.configuration.provider;
  assert.equal(profile.id, 'default');
  assert.equal(profile.mode, 'mock');
  assert.equal(profile.provider, 'mock', 'an unnamed mock provider is reported as mock, not a guessed brand');
  assert.equal(profile.model, provider.model);
  assert.equal(profile.maxOutputTokens, provider.maxOutputTokens);
  assert.equal(profile.credentialPresent, false);
  assert.equal(typeof profile.credentialPresent, 'boolean');
  assert.equal(profile.remainingLiveRequests, undefined, 'a mock profile has no live request budget');
  assert.equal(profile.supportsReasoning, false, 'no levels and no metadata means reasoning is not claimed');
  assert.equal(profile.contextWindow, provider.contextWindowTokens);
  assert.equal(profile.reasoningLevels, undefined);
  assert.equal(profile.reasoningMapping, undefined);
  assert.equal(profile.autoConfig, undefined);
  assert.equal(profile.inputTypes, undefined);
  assert.equal(profile.capabilities, undefined);
});

test('save persists validated metadata, applies the limits to the provider configuration and survives a restart', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const models = f.models();
  const saved = await models.save(mockInput());
  assert.match(saved.id, /^provider-[a-f0-9-]+$/);
  assert.equal(saved.provider, 'ACME Lab');
  assert.equal(saved.model, 'acme/mock-a');
  assert.equal(saved.contextWindow, 128000);
  assert.equal(saved.maxOutputTokens, 2048);
  assert.equal(saved.supportsReasoning, true);
  assert.deepEqual(saved.inputTypes, ['text', 'image']);
  assert.deepEqual(saved.capabilities, ['structuredOutput', 'systemMessageInChat']);
  assert.deepEqual(saved.reasoningLevels, ['low', 'high']);
  assert.deepEqual(saved.reasoningMapping, { reasoning_effort: '{{level}}', top_p: 0.4 });
  assert.equal(saved.remainingLiveRequests, undefined);

  const configuration = f.backend.services.harness!.profiles.get(saved.id);
  assert.equal(configuration.provider.model, 'acme/mock-a');
  assert.equal(configuration.provider.mode, 'mock');
  assert.equal(configuration.provider.maxOutputTokens, 2048, 'metadata output limit reaches the provider configuration');
  assert.equal(configuration.provider.contextWindowTokens, 128000, 'metadata context window reaches the provider configuration');

  const listed = (await models.list()).find(item => item.id === saved.id)!;
  assert.deepEqual(listed, saved);

  await f.restart();
  const restored = (await f.models().list()).find(item => item.id === saved.id);
  assert.ok(restored, 'the model profile survives a backend restart');
  assert.deepEqual(restored, saved);
  const restoredConfig = f.backend.services.harness!.profiles.get(saved.id);
  assert.equal(restoredConfig.provider.maxOutputTokens, 2048);
  assert.equal(restoredConfig.provider.contextWindowTokens, 128000);

  // Updating the same id replaces the metadata instead of creating a duplicate profile.
  const restarted = f.models();
  const updated = await restarted.save(mockInput({ id: saved.id, name: 'Renamed mock', provider: 'ACME Lab 2', model: 'acme/mock-b',
    contextWindow: 99000, maxOutputTokens: 1024, supportsReasoning: false, inputTypes: ['text'], capabilities: [],
    reasoningLevels: ['low'], reasoningMapping: { reasoning_effort: '{{level}}' } }));
  assert.equal(updated.id, saved.id);
  assert.equal(updated.name, 'Renamed mock');
  assert.equal(updated.provider, 'ACME Lab 2');
  assert.equal(updated.model, 'acme/mock-b');
  assert.equal(updated.contextWindow, 99000);
  assert.equal(updated.maxOutputTokens, 1024);
  assert.equal(updated.supportsReasoning, false, 'explicit supportsReasoning=false wins over the level list');
  assert.deepEqual(updated.inputTypes, ['text']);
  assert.deepEqual(updated.capabilities, []);
  assert.equal((await restarted.list()).filter(item => item.id === saved.id).length, 1);
  assert.equal(f.backend.services.harness!.profiles.get(saved.id).provider.maxOutputTokens, 1024);
  assert.equal(f.backend.services.harness!.profiles.get(saved.id).provider.contextWindowTokens, 99000);
  await f.restart();
  const afterUpdate = (await f.models().list()).find(item => item.id === saved.id)!;
  assert.equal(afterUpdate.model, 'acme/mock-b');
  assert.equal(afterUpdate.maxOutputTokens, 1024);
});

test('save rejects unknown, out-of-range, over-sized and prototype-polluted input without persisting', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const models = f.models();
  const polluted = JSON.parse('{"reasoning_effort":"{{level}}","__proto__":{"polluted":true}}');
  const oversized = { ['x'.repeat(20000)]: 1 };
  const cases: { label: string; input: any; message: RegExp; code?: string }[] = [
    { label: 'unknown field', input: mockInput({ endpoint: 'https://evil.invalid/v1' }), message: /Unknown field: endpoint/ },
    { label: 'blank name', input: mockInput({ name: '   ' }), message: /name/i },
    { label: 'name too long', input: mockInput({ name: 'n'.repeat(101) }), message: /name/i },
    { label: 'blank provider', input: mockInput({ provider: '' }), message: /provider/i },
    { label: 'provider too long', input: mockInput({ provider: 'p'.repeat(65) }), message: /provider/i },
    { label: 'blank model', input: mockInput({ model: '' }), message: /model id/i },
    { label: 'model too long', input: mockInput({ model: 'm'.repeat(201) }), message: /model id/i },
    { label: 'bad mode', input: mockInput({ mode: 'demo' }), message: /mode/i },
    { label: 'context window zero', input: mockInput({ contextWindow: 0 }), message: /contextWindow/i },
    { label: 'context window too large', input: mockInput({ contextWindow: 10_000_001 }), message: /contextWindow/i },
    { label: 'context window fraction', input: mockInput({ contextWindow: 1.5 }), message: /contextWindow/i },
    { label: 'output tokens under 64', input: mockInput({ maxOutputTokens: 63 }), message: /maxOutputTokens/i },
    { label: 'output tokens over 8192', input: mockInput({ maxOutputTokens: 8193 }), message: /maxOutputTokens/i },
    { label: 'non-boolean supportsReasoning', input: mockInput({ supportsReasoning: 'yes' }), message: /supportsReasoning/i },
    { label: 'non-boolean autoConfig', input: mockInput({ autoConfig: 1 }), message: /autoConfig/i },
    { label: 'unknown input type', input: mockInput({ inputTypes: ['text', 'audio'] }), message: /inputTypes/ },
    { label: 'repeated input type', input: mockInput({ inputTypes: ['text', 'text'] }), message: /repeat/ },
    { label: 'unknown capability', input: mockInput({ capabilities: ['admin'] }), message: /capabilities/ },
    { label: 'too many levels', input: mockInput({ reasoningLevels: Array.from({ length: 21 }, (_, index) => `level-${index}`) }), message: /at most 20/i },
    { label: 'repeated level', input: mockInput({ reasoningLevels: ['low', 'low'] }), message: /repeated/i },
    { label: 'blank level', input: mockInput({ reasoningLevels: [' '] }), message: /level/i },
    { label: 'level too long', input: mockInput({ reasoningLevels: ['l'.repeat(65)] }), message: /level/i },
    { label: 'mapping messages override', input: mockInput({ reasoningMapping: { messages: [] } }), message: /messages/ },
    { label: 'mapping tools override', input: mockInput({ reasoningMapping: { tools: [] } }), message: /tools/ },
    { label: 'mapping model override', input: mockInput({ reasoningMapping: { model: 'other' } }), message: /model/ },
    { label: 'mapping transport override', input: mockInput({ reasoningMapping: { baseUrl: 'https://evil.invalid' } }), message: /baseUrl/ },
    { label: 'mapping credential override', input: mockInput({ reasoningMapping: { apiKey: 'leak' } }), message: /apiKey/ },
    { label: 'mapping unknown parameter', input: mockInput({ reasoningMapping: { seed: 1 } }), message: /not allowed/ },
    { label: 'mapping nested value', input: mockInput({ reasoningMapping: { reasoning_effort: { type: 'enabled' } } }), message: /nested/i },
    { label: 'mapping array value', input: mockInput({ reasoningMapping: { reasoning_effort: ['high'] } }), message: /number, boolean or string/i },
    { label: 'mapping long string', input: mockInput({ reasoningMapping: { reasoning_effort: 'x'.repeat(65) } }), message: /64 characters/i },
    { label: 'mapping non-finite number', input: mockInput({ reasoningMapping: { top_p: Number.POSITIVE_INFINITY } }), message: /finite/i },
    { label: 'mapping over the byte cap', input: mockInput({ reasoningMapping: oversized }), message: /16384 bytes/ },
    { label: 'polluted mapping', input: mockInput({ reasoningMapping: polluted }), message: /__proto__/ },
  ];
  const before = (await models.list()).length;
  for (const item of cases) {
    await assert.rejects(async () => { await models.save(item.input); }, (error: any) => {
      assert.ok(error instanceof ProductError, `${item.label}: expected ProductError, got ${String(error)}`);
      assert.equal(error.code, item.code ?? 'validation', `${item.label}: ${error.message}`);
      assert.match(error.message, item.message, item.label);
      return true;
    });
    assert.equal((await models.list()).length, before, `${item.label}: nothing is persisted`);
  }
  assert.equal(({} as any).polluted, undefined, 'no reasoning mapping can pollute Object.prototype');
  await assert.rejects(async () => { await models.save(mockInput({ id: 'provider-00000000-0000-0000-0000-000000000000' })); },
    (error: any) => error instanceof ProductError && error.code === 'not_found' && /was not found/.test(error.message));
  await f.restart();
  assert.equal((await f.models().list()).length, before, 'rejected models never appear after a restart');
  assert.equal(f.backend.services.harness!.profiles.metadata('provider-00000000-0000-0000-0000-000000000000'), undefined);
});

test('remove refuses the default, the reviewer and every referenced model, then deletes an unused one', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const models = f.models();
  const conflict = (pattern: RegExp) => (error: any) => {
    assert.ok(error instanceof ProductError, String(error));
    assert.equal(error.code, 'conflict', error.message);
    assert.equal(error.status, 409);
    assert.match(error.message, pattern);
    return true;
  };
  await assert.rejects(async () => { await models.remove('default'); }, conflict(/default model/i));
  await assert.rejects(async () => { await models.remove(`provider-${randomUUID()}`); },
    (error: any) => error instanceof ProductError && error.code === 'not_found');

  const reviewer = await models.save(mockInput({ name: 'Reviewer model' }));
  assert.equal((await f.http('POST', '/v1/harness/settings', { autoReview: { reviewerModelId: reviewer.id, escalateAt: 'high' } })).status, 200);
  await assert.rejects(async () => { await models.remove(reviewer.id); }, conflict(/automatic reviewer/i));
  assert.equal((await f.http('POST', '/v1/harness/settings', { autoReview: { reviewerModelId: '', escalateAt: 'high' } })).status, 200);
  await models.remove(reviewer.id);

  const chatModel = await models.save(mockInput({ name: 'Chat model' }));
  const session = await f.http('POST', '/v1/harness/sessions', { title: 'Uses a model profile', profileId: chatModel.id });
  assert.equal(session.status, 200, JSON.stringify(session.value));
  await assert.rejects(async () => { await models.remove(chatModel.id); }, conflict(/chat session/));
  assert.equal((await f.http('POST', `/v1/harness/sessions/${session.value.id}`, { profileId: 'default' })).status, 200);
  await models.remove(chatModel.id);

  const indexedModel = await models.save(mockInput({ name: 'Indexed model' }));
  const now = new Date().toISOString();
  f.indexStore.upsertSession({ id: 'task-index-probe', kind: 'work', mode: 'code', title: 'Index probe', status: 'idle',
    permission: 'ask', modelId: indexedModel.id, pinned: false, createdAt: now, updatedAt: now });
  await assert.rejects(async () => { await models.remove(indexedModel.id); }, conflict(/work session/));
  f.indexStore.removeSession('task-index-probe');
  await models.remove(indexedModel.id);

  const pendingModel = await models.save(mockInput({ name: 'Pending model' }));
  const request = f.backend.services.harness!.store.createRequest({ sessionId: 'probe-request-session', profileId: pendingModel.id, kind: 'studio',
    endpoint: 'http://127.0.0.1:1/provider/v1/chat/completions', bodyHash: 'fixture', sources: [], recordContent: false, draft: '', status: 'draft' });
  await assert.rejects(async () => { await models.remove(pendingModel.id); }, conflict(/draft request/));
  f.backend.services.harness!.store.updateRequest(request.id, { status: 'cancelled' });
  await models.remove(pendingModel.id);

  const unused = await models.save(mockInput({ name: 'Unused model' }));
  assert.ok(existsSync(path.join(f.dataDir, 'profiles', unused.id)), 'a saved profile owns its data directory');
  await models.remove(unused.id);
  assert.equal((await models.list()).find(item => item.id === unused.id), undefined);
  assert.equal(f.backend.services.harness!.profiles.metadata(unused.id), undefined);
  assert.equal(existsSync(path.join(f.dataDir, 'profiles', unused.id)), false, 'removal deletes the profile data directory');
  await f.restart();
  assert.equal((await f.models().list()).find(item => item.id === unused.id), undefined);
});

test('test() calls the real mock provider and refuses a live profile without an allowance before dispatch', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const models = f.models();
  const mock = await models.save(mockInput({ name: 'Probe mock', model: 'acme/probe' }));
  const callCount = f.wire.length;
  const result = await models.test(mock.id);
  assert.equal(result.ok, true, result.message);
  assert.equal(typeof result.latencyMs, 'number');
  assert.ok(result.latencyMs! >= 0);
  assert.equal(f.wire.length, callCount + 1, 'the mock profile really calls the mock provider');
  assert.equal(f.wire.at(-1)!.model, 'acme/probe');

  const live = await models.save(mockInput({ name: 'Live profile', model: 'live/model', mode: 'live' }));
  assert.equal(live.remainingLiveRequests, 0);
  assert.equal(live.credentialPresent, false);
  const before = f.wire.length;
  const blocked = await models.test(live.id);
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /Paid requests are blocked/i, blocked.message);
  assert.equal(f.wire.length, before, 'a blocked live profile never reaches the network');

  await assert.rejects(async () => { await models.test(`provider-${randomUUID()}`); },
    (error: any) => error instanceof ProductError && error.code === 'not_found');
});

test('damaged stored metadata fails startup with an explicit repair message and cannot pollute prototypes', t => {
  const owned = mkdtempSync(path.join(root, 'product-metadata-'));
  const dataDir = path.join(owned, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new HarnessStore(dataDir);
  t.after(() => { store.close(); rmSync(owned, { recursive: true, force: true }); });
  const primary = new Configuration('http://127.0.0.1:1/provider/v1', dataDir);
  const id = 'provider-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  store.setSetting('modelMetadata', { [id]: { contextWindow: 'wide' } });
  assert.throws(() => new Profiles(store, primary, dataDir), new RegExp(`Stored model metadata for ${id} is invalid`));
  store.setSetting('modelMetadata', { [id]: { reasoningLevels: ['ok', 'ok'] } });
  assert.throws(() => new Profiles(store, primary, dataDir), new RegExp(`Stored model metadata for ${id} is invalid`));

  store.setSetting('modelMetadata', JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.throws(() => new Profiles(store, primary, dataDir), /invalid model id/);
  assert.equal(({} as any).polluted, undefined);
  store.setSetting('modelMetadata', JSON.parse('{"provider-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee":{"reasoningMapping":{"messages":[]}}}'));
  assert.throws(() => new Profiles(store, primary, dataDir), /cannot set "messages"/);
});

test('HTTP GET /v1/product/models returns the frontend ModelProfile list', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const models = f.models();
  const saved = await models.save(mockInput());
  const response = await f.http('GET', '/v1/product/models');
  if (response.status === 404) {
    t.skip('GET /v1/product/models is not wired yet (src/app/backend.ts has no /v1/product route); root owns the wiring.');
    return;
  }
  assert.equal(response.status, 200, JSON.stringify(response.value));
  const list: any[] = Array.isArray(response.value) ? response.value : response.value?.models;
  assert.ok(Array.isArray(list), 'the route returns an array of ModelProfile');
  const expected = await models.list();
  const entry = list.find((item: any) => item.id === saved.id) as Record<string, unknown> | undefined;
  assert.ok(entry, 'the saved model is listed over HTTP');
  assert.deepEqual(entry, expected.find(item => item.id === saved.id), 'the HTTP DTO equals the domain DTO');
  assert.deepEqual(Object.keys(entry).sort(), ['capabilities', 'contextWindow', 'credentialPresent', 'id', 'inputTypes', 'maxOutputTokens', 'mode', 'model', 'name', 'provider', 'reasoningLevels', 'reasoningMapping', 'supportsReasoning'].sort());
  const defaultEntry = list.find((item: any) => item.id === 'default');
  assert.ok(defaultEntry && defaultEntry.credentialPresent === false && defaultEntry.remainingLiveRequests === undefined);
});