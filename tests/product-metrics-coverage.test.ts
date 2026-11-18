import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HarnessStore } from '../src/harness/store.js';
import { ProductObservability } from '../src/product/observability.js';
import type { ProductRuntime } from '../src/product/shared.js';

function fixture(t: import('node:test').TestContext) {
  const root = path.resolve(process.env.TEMP ?? '.tmp'), owned = mkdtempSync(path.join(root, 'metrics-coverage-'));
  let store = new HarnessStore(owned);
  t.after(() => { store.close(); assert.equal(path.dirname(owned), root); rmSync(owned, { recursive: true, force: true }); });
  return { owned, get store() { return store; }, restart() { store.close(); store = new HarnessStore(owned); } };
}

const request = { profileId: 'default', kind: 'chat' as const, status: 'completed' as const, endpoint: 'fixture', bodyHash: 'hash', sources: [], recordContent: false, draft: '' };

/** ProductObservability only needs a session lookup and the real harness store for the Chat path. */
const observabilityFor = (store: HarnessStore) => new ProductObservability({
  store: { getSession: (id: string) => ({ id, kind: 'chat' }) },
  services: { kernel: { getTask: () => undefined, userTurnCount: () => 0 } },
  harness: { store },
  append: () => undefined,
} as unknown as ProductRuntime);

const known = (reported: number, total: number) => ({ reportedRequests: reported, totalRequests: total, state: 'known' as const });
const partial = (reported: number, total: number) => ({ reportedRequests: reported, totalRequests: total, state: 'partial' as const });
const unknown = (total: number) => ({ reportedRequests: 0, totalRequests: total, state: 'unknown' as const });

test('empty history exposes known zero coverage instead of unknown', t => {
  const f = fixture(t), session = f.store.createSession(), view = observabilityFor(f.store).metrics(session.id);
  assert.equal(view.tokens.input, 0);
  assert.equal(view.tokens.output, 0);
  assert.equal('cached' in view.tokens, false);
  assert.equal(view.cacheHitRate, undefined);
  assert.deepEqual(view.usageCoverage, {
    requests: 0, input: known(0, 0), output: known(0, 0), total: known(0, 0), cached: known(0, 0), cacheRatio: known(0, 0),
  });
  const metrics = f.store.metrics({ sessionId: session.id });
  assert.equal(metrics.totalTokens, null);
  assert.deepEqual(metrics.usageCoverage, {
    requests: 0, input: known(0, 0), output: known(0, 0), total: known(0, 0), cached: known(0, 0), cacheRatio: known(0, 0),
  });
  for (const value of [view.tokens.input, view.tokens.output, view.tokens.cached ?? 0, metrics.requests]) assert.ok(Number.isFinite(value));
});

test('a request without usage stays unknown while the contract keeps numeric zeros', t => {
  const f = fixture(t), session = f.store.createSession();
  f.store.createRequest({ ...request, sessionId: session.id, model: 'fixture' });
  const metrics = f.store.metrics({ sessionId: session.id });
  assert.equal(metrics.requests, 1);
  assert.equal(metrics.totalTokens, null);
  assert.equal(metrics.promptTokens, null);
  assert.equal(metrics.outputTokens, null);
  assert.equal(metrics.cachedTokens, null);
  assert.equal(metrics.reportedRequests, 0);
  assert.equal(metrics.unreportedRequests, 1);
  assert.deepEqual(metrics.usageCoverage, {
    requests: 1, input: unknown(1), output: unknown(1), total: unknown(1), cached: unknown(1), cacheRatio: unknown(1),
  });
  const view = observabilityFor(f.store).metrics(session.id);
  assert.equal(typeof view.tokens.input, 'number');
  assert.equal(view.tokens.input, 0);
  assert.equal(view.tokens.output, 0);
  assert.equal('cached' in view.tokens, false);
  assert.equal(view.cacheHitRate, undefined);
  assert.deepEqual(view.usageCoverage, {
    requests: 1, input: unknown(1), output: unknown(1), total: unknown(1), cached: unknown(1), cacheRatio: unknown(1),
  });
  for (const field of ['input', 'output', 'total', 'cached'] as const) assert.equal(view.usageCoverage![field].reportedRequests, 0);
});

test('mixed coverage tracks input, output, total and cached independently with known sums only', t => {
  const f = fixture(t), session = f.store.createSession();
  f.store.createRequest({ ...request, sessionId: session.id, usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } });
  f.store.createRequest({ ...request, sessionId: session.id, usage: { total_tokens: 300 } });
  f.store.createRequest({ ...request, sessionId: session.id });
  f.store.createRequest({ ...request, sessionId: session.id, usage: { prompt_tokens: 50 } });
  const metrics = f.store.metrics({ sessionId: session.id });
  assert.equal(metrics.requests, 4);
  assert.equal(metrics.promptTokens, 150);
  assert.equal(metrics.outputTokens, 20);
  assert.equal(metrics.totalTokens, 420);
  assert.equal(metrics.cachedTokens, 40);
  assert.equal(metrics.cachePromptTokens, 100);
  assert.deepEqual(metrics.usageCoverage, {
    requests: 4, input: partial(2, 4), output: partial(1, 4), total: partial(2, 4), cached: partial(1, 4), cacheRatio: partial(1, 4),
  });
  const view = observabilityFor(f.store).metrics(session.id);
  assert.equal(view.tokens.input, 150);
  assert.equal(view.tokens.output, 20);
  assert.equal(view.tokens.cached, 40);
  assert.equal(view.cacheHitRate, 0.4);
  assert.deepEqual(view.usageCoverage, metrics.usageCoverage);
});

test('cache coverage counts cache-reported requests and the hit rate only sums their prompts', t => {
  const f = fixture(t), session = f.store.createSession();
  f.store.createRequest({ ...request, sessionId: session.id, usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } });
  f.store.createRequest({ ...request, sessionId: session.id, usage: { prompt_tokens: 60, completion_tokens: 10 } });
  const metrics = f.store.metrics({ sessionId: session.id });
  assert.deepEqual(metrics.usageCoverage.input, known(2, 2));
  assert.deepEqual(metrics.usageCoverage.output, known(2, 2));
  assert.deepEqual(metrics.usageCoverage.total, known(2, 2));
  assert.deepEqual(metrics.usageCoverage.cached, partial(1, 2));
  assert.equal(metrics.cachedTokens, 40);
  assert.equal(metrics.cachePromptTokens, 100);
  assert.equal(metrics.cacheReportedRequests, 1);
  const view = observabilityFor(f.store).metrics(session.id);
  assert.equal(view.tokens.cached, 40);
  assert.equal(view.cacheHitRate, 0.4);

  const noCache = f.store.createSession();
  f.store.createRequest({ ...request, sessionId: noCache.id, usage: { prompt_tokens: 70 } });
  const uncached = observabilityFor(f.store).metrics(noCache.id);
  assert.deepEqual(uncached.usageCoverage?.input, known(1, 1));
  assert.deepEqual(uncached.usageCoverage?.cached, unknown(1));
  assert.equal('cached' in uncached.tokens, false);
  assert.equal(uncached.cacheHitRate, undefined);
});

test('cache hit rate only counts rows where both prompt and cache are usable', t => {
  const f = fixture(t), session = f.store.createSession();
  f.store.createRequest({ ...request, sessionId: session.id, usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } });
  f.store.createRequest({ ...request, sessionId: session.id, usage: { prompt_cache_hit_tokens: 60 } });
  const metrics = f.store.metrics({ sessionId: session.id });
  const view = observabilityFor(f.store).metrics(session.id);
  assert.equal(view.cacheHitRate, 0.4, '60 cached tokens without a prompt cannot inflate the ratio');
  assert.equal(metrics.cachedTokens, 100, 'the real cached-token sum is preserved');
  assert.equal(metrics.cachePromptTokens, 100);
  assert.deepEqual(metrics.usageCoverage.cached, known(2, 2), 'both rows did report a cached-token field');
  assert.equal((metrics as any).cacheMatchedTokens, 40);
  assert.equal((metrics as any).cacheMatchedPromptTokens, 100);
  assert.equal((metrics as any).cacheMatchedRequests, 1);
});

test('the cache ratio has its own matched-row coverage instead of reusing cached-token coverage', t => {
  const f = fixture(t), session = f.store.createSession();
  f.store.createRequest({ ...request, sessionId: session.id, usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } });
  f.store.createRequest({ ...request, sessionId: session.id, usage: { prompt_cache_hit_tokens: 60 } });
  const metrics = f.store.metrics({ sessionId: session.id });
  const view = observabilityFor(f.store).metrics(session.id);
  const ratio = (metrics.usageCoverage as any).cacheRatio;
  assert.deepEqual(ratio, partial(1, 2), 'only one of two requests has both a prompt and a cache value');
  assert.deepEqual((view.usageCoverage as any).cacheRatio, partial(1, 2));
});

test('cache-only and zero denominators stay unknown without NaN', t => {
  const f = fixture(t), session = f.store.createSession();
  f.store.createRequest({ ...request, sessionId: session.id, usage: { prompt_cache_hit_tokens: 60 } });
  const cacheOnly = f.store.metrics({ sessionId: session.id });
  assert.equal(cacheOnly.cachedTokens, 60, 'cache-only requests still contribute their real cached-token sum');
  assert.equal(cacheOnly.cachePromptTokens, null);
  assert.equal((cacheOnly as any).cacheMatchedTokens, null);
  assert.equal((cacheOnly as any).cacheMatchedRequests, 0);
  assert.deepEqual((cacheOnly.usageCoverage as any).cacheRatio, unknown(1));
  const cacheOnlyView = observabilityFor(f.store).metrics(session.id);
  assert.equal(cacheOnlyView.cacheHitRate, undefined);
  assert.equal(cacheOnlyView.tokens.cached, 60);

  const zero = f.store.createSession();
  f.store.createRequest({ ...request, sessionId: zero.id, usage: { prompt_tokens: 0, prompt_cache_hit_tokens: 0 } });
  const zeroMetrics = f.store.metrics({ sessionId: zero.id });
  assert.equal(zeroMetrics.cachedTokens, 0);
  assert.equal((zeroMetrics as any).cacheMatchedRequests, 0);
  assert.deepEqual((zeroMetrics.usageCoverage as any).cacheRatio, unknown(1));
  const zeroView = observabilityFor(f.store).metrics(zero.id);
  assert.equal(zeroView.cacheHitRate, undefined);
  assert.ok(!Number.isNaN(zeroView.tokens.cached));
  assert.ok(Number.isFinite(zeroView.tokens.cached ?? 0));

  const invalid = f.store.createSession();
  f.store.createRequest({ ...request, sessionId: invalid.id, usage: { prompt_tokens: -5, prompt_cache_hit_tokens: 5 } });
  const invalidMetrics = f.store.metrics({ sessionId: invalid.id });
  assert.equal(invalidMetrics.cachedTokens, null);
  assert.equal((invalidMetrics as any).cacheMatchedRequests, 0);
  assert.deepEqual((invalidMetrics.usageCoverage as any).cacheRatio, unknown(1));
  assert.equal(observabilityFor(f.store).metrics(invalid.id).cacheHitRate, undefined);
});

test('fully reported usage keeps known coverage and legacy values', t => {
  const f = fixture(t), session = f.store.createSession();
  f.store.createRequest({ ...request, sessionId: session.id, usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } });
  f.store.createRequest({ ...request, sessionId: session.id, usage: { prompt_tokens: 60, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 30 } } });
  const metrics = f.store.metrics({ sessionId: session.id });
  assert.equal(metrics.totalTokens, 190);
  assert.equal(metrics.promptTokens, 160);
  assert.equal(metrics.outputTokens, 30);
  assert.equal(metrics.cachedTokens, 70);
  assert.equal(metrics.cachePromptTokens, 160);
  assert.equal(metrics.cacheReportedRequests, 2);
  assert.equal(metrics.reportedRequests, 2);
  assert.equal(metrics.unreportedRequests, 0);
  assert.deepEqual(metrics.usageCoverage, {
    requests: 2, input: known(2, 2), output: known(2, 2), total: known(2, 2), cached: known(2, 2), cacheRatio: known(2, 2),
  });
  const view = observabilityFor(f.store).metrics(session.id);
  assert.equal(view.tokens.input, 160);
  assert.equal(view.tokens.output, 30);
  assert.equal(view.tokens.cached, 70);
  assert.equal(view.cacheHitRate, 0.4375);
  assert.deepEqual(view.usageCoverage, metrics.usageCoverage);
});

test('legacy fields keep meaning and coverage survives a store restart', t => {
  const f = fixture(t), session = f.store.createSession();
  f.store.createRequest({ ...request, sessionId: session.id, usage: { prompt_tokens: 100, completion_tokens: 20 } });
  f.store.createRequest({ ...request, sessionId: session.id, usage: { total_tokens: 300 } });
  f.store.createRequest({ ...request, sessionId: session.id });
  const before = observabilityFor(f.store).metrics(session.id);
  const raw = f.store.metrics({ sessionId: session.id });
  assert.equal(raw.reportedRequests, 2);
  assert.equal(raw.unreportedRequests, 1);
  assert.equal(raw.totalTokens, 420);
  assert.equal(raw.cachePromptTokens, null);
  assert.equal(raw.cacheReportedRequests, 0);
  assert.deepEqual(raw.usageCoverage, {
    requests: 3, input: partial(1, 3), output: partial(1, 3), total: partial(2, 3), cached: unknown(3), cacheRatio: unknown(3),
  });
  assert.equal(typeof before.tokens.input, 'number');
  assert.equal(typeof before.tokens.output, 'number');
  assert.deepEqual(before.usageCoverage?.input, partial(1, 3));

  f.restart();
  assert.deepEqual(f.store.metrics({ sessionId: session.id }), raw);
  assert.deepEqual(observabilityFor(f.store).metrics(session.id), before);
});
