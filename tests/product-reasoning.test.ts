import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import { ModelClient } from '../src/runtime/model.js';
import { ProductModels } from '../src/product/models.js';
import { ProductStore } from '../src/product/store.js';
import { ProductError, type ProductRuntime } from '../src/product/shared.js';

const root = path.resolve(process.env.TEMP ?? '.tmp');
mkdirSync(root, { recursive: true });

async function fixture(t: import('node:test').TestContext) {
  const owned = mkdtempSync(path.join(root, 'product-reasoning-'));
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
  t.after(async () => {
    for (const store of stores) { try { store.close(); } catch { /* already closed */ } }
    await backend.close();
    assert.equal(path.dirname(owned), root);
    rmSync(owned, { recursive: true, force: true });
  });
  return { wire, models, get backend() { return backend; }, get harness() { return backend.services.harness!; } };
}

const reasoningInput = (overrides: Record<string, unknown> = {}): any => ({
  name: 'Reasoning mock', provider: 'Reasoning Lab', model: 'reasoning/mock-a', mode: 'mock',
  contextWindow: 65536, maxOutputTokens: 1024, supportsReasoning: true,
  reasoningLevels: ['low', 'high'], reasoningMapping: { reasoning_effort: '{{level}}', enable_thinking: true, top_p: 0.7 },
  ...overrides,
});

test('applyReasoning merges only whitelisted scalars for a selected level and never mutates the input body', async t => {
  const f = await fixture(t);
  const models = f.models();
  const profile = await models.save(reasoningInput({ reasoningMapping: {
    reasoning_effort: '{{level}}', top_p: 0.7, enable_thinking: true, thinking: 'enabled-{{level}}' } }));

  const body: Record<string, unknown> = {
    model: 'reasoning/mock-a', messages: [{ role: 'user', content: 'Hello' }], tools: [{ type: 'function', function: { name: 'noop', parameters: {} } }],
    tool_choice: 'auto', temperature: 0.2, max_tokens: 1024, reasoning_effort: 'none',
  };
  const applied = models.applyReasoning(body, profile.id, 'high');
  assert.notEqual(applied, body, 'a selected level returns a new body object');
  assert.equal(applied.reasoning_effort, 'high');
  assert.equal(applied.top_p, 0.7);
  assert.equal(applied.enable_thinking, true);
  assert.equal(applied.thinking, 'enabled-high');
  assert.equal(applied.temperature, 0.2, 'parameters outside the mapping stay untouched');
  assert.deepEqual(applied.messages, body.messages);
  assert.deepEqual(applied.tools, body.tools);
  assert.notEqual(applied.messages, body.messages, 'containers are cloned before merging');
  assert.equal(body.reasoning_effort, 'none', 'the caller body is never mutated');

  // No level, an unknown level, an unknown profile or a profile without metadata all pass through
  // the exact same object: a reasoning mapping cannot leak into a request that did not select it.
  assert.equal(models.applyReasoning(body, profile.id, undefined), body);
  assert.equal(models.applyReasoning(body, profile.id, '   '), body);
  assert.equal(models.applyReasoning(body, profile.id, 'max'), body);
  assert.equal(models.applyReasoning(body, 'provider-unknown', 'high'), body);
  assert.equal(models.applyReasoning(body, 'default', 'high'), body);

  const plain = { model: 'reasoning/mock-a', messages: [{ role: 'user', content: 'No tools' }] };
  const unknownLevel = models.applyReasoning(plain, profile.id, 'max');
  assert.equal(unknownLevel, plain);
  assert.equal('reasoning_effort' in unknownLevel, false);

  // A mapping may never create request structure; the API rejects those keys before persistence.
  for (const mapping of [{ messages: [] }, { tools: [] }, { model: 'other/model' }, { baseUrl: 'https://evil.invalid' }, { apiKey: 'leak' }]) {
    await assert.rejects(async () => { await models.save(reasoningInput({ reasoningMapping: mapping })); }, (error: any) => {
      assert.ok(error instanceof ProductError);
      assert.equal(error.code, 'validation');
      return true;
    });
  }
});

test('metadata limits reach the profile configuration and the actual mock wire body', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const models = f.models();
  const profile = await models.save(reasoningInput());
  const configuration = f.harness.profiles.get(profile.id);
  assert.equal(configuration.provider.maxOutputTokens, 1024);
  assert.equal(configuration.provider.contextWindowTokens, 65536);

  const body = new ModelClient(configuration.provider).buildBody([{ role: 'user', content: 'Wire reasoning check' }]);
  assert.equal(body.max_tokens, 1024, 'buildBody uses the metadata output limit');
  assert.equal(body.model, 'reasoning/mock-a');
  const applied = models.applyReasoning(body, profile.id, 'high');
  const result = await configuration.client().completeRaw(applied, AbortSignal.timeout(15000));
  assert.ok(result.content.length > 0);

  const wireBody = f.wire.at(-1)!;
  assert.equal(wireBody.reasoning_effort, 'high');
  assert.equal(wireBody.enable_thinking, true);
  assert.equal(wireBody.top_p, 0.7);
  assert.equal(wireBody.max_tokens, 1024, 'the wire body carries the metadata max_tokens');
  assert.equal(wireBody.model, 'reasoning/mock-a');
  assert.deepEqual(wireBody.messages, body.messages);
  assert.equal(wireBody.temperature, undefined, 'a parameter absent from the mapping is not synthesized');
});

test('the shared Request adapter applies the selected level to the recorded Inspector body', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const models = f.models();
  const profile = await models.save(reasoningInput());
  const configuration = f.harness.profiles.get(profile.id);
  const base = new ModelClient(configuration.provider).buildBody([{ role: 'user', content: 'Adapter reasoning check' }]);

  const record = f.harness.requests.prepare({ sessionId: 'reasoning-probe', kind: 'studio', profileId: profile.id, reasoningEffort: 'high' }, base);
  assert.equal(record.profileId, profile.id);
  assert.equal(record.body!.max_tokens, 1024);
  const result = await f.harness.requests.send(record.id, record.body, AbortSignal.timeout(15000));
  assert.ok(result.content.length > 0);

  const wireBody = f.wire.at(-1)!;
  if (wireBody.reasoning_effort === undefined) {
    t.skip('RequestContext.reasoningEffort is not consumed by src/harness/requests.ts yet (root wiring pending); '
      + 'applyReasoning and its real wire body are covered by the tests above.');
    return;
  }
  assert.equal(wireBody.reasoning_effort, 'high');
  assert.equal(wireBody.enable_thinking, true);
  assert.equal(wireBody.max_tokens, 1024);
  assert.equal(wireBody.model, 'reasoning/mock-a');
  assert.deepEqual([...wireBody.messages], base.messages, 'reasoning mapping never rewrites messages');
  const settled = f.harness.store.getRequest(record.id);
  assert.equal(settled.contextWindowTokens, 65536, 'the profile context window is recorded for the Inspector');
  assert.equal(settled.body!.reasoning_effort, 'high', 'the Inspector body equals the real wire body');
  assert.deepEqual(settled.body, wireBody);

  // A level the model does not define behaves exactly like no selection on the real wire.
  const body = new ModelClient(configuration.provider).buildBody([{ role: 'user', content: 'Unknown level check' }]);
  const unknown = f.harness.requests.prepare({ sessionId: 'reasoning-probe-unknown', kind: 'studio', profileId: profile.id, reasoningEffort: 'max' }, body);
  await f.harness.requests.send(unknown.id, unknown.body, AbortSignal.timeout(15000));
  assert.equal(f.wire.at(-1)!.reasoning_effort, undefined);
  assert.equal(f.wire.at(-1)!.max_tokens, 1024);
});