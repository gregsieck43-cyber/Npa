import test from 'node:test';
import assert from 'node:assert/strict';
import { Configuration } from '../src/app/configuration.js';

const messages = [{ role: 'user' as const, content: 'Local transport fixture only.' }];
function transport(t: import('node:test').TestContext) {
  let sent = 0;
  t.mock.method(globalThis, 'fetch', async () => { sent++; return new Response(JSON.stringify({ choices: [{ message: { content: 'fixture' }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } }); });
  return () => sent;
}

test('unused and rejected model adapters spend no allowance; each reuse spends exactly one dispatched attempt', async t => {
  const sent = transport(t), config = new Configuration('http://127.0.0.1:1');
  config.set({ mode: 'live', apiKey: 'local-fixture-only', authorizePaid: true, maxRequests: 2 });
  const unusedSummary = config.client(), reviewer = config.client();
  assert.equal(config.view().remainingLiveRequests, 2, 'Constructing a summary client with no retired sources sends nothing');
  await assert.rejects(unusedSummary.completeRaw({ ...unusedSummary.buildBody(messages), model: 'wrong-profile' }), /match the selected/);
  await assert.rejects(reviewer.complete(messages, [], AbortSignal.abort()), /cancelled|aborted/i);
  assert.equal(config.view().remainingLiveRequests, 2); assert.equal(sent(), 0);
  await reviewer.complete(messages); assert.equal(config.view().remainingLiveRequests, 1);
  await reviewer.complete(messages); assert.equal(config.view().remainingLiveRequests, 0);
  await assert.rejects(reviewer.complete(messages), /Paid requests are blocked/);
  assert.equal(sent(), 2);
});

test('an adapter created before a provider change cannot spend the new provider allowance or send its credential', async t => {
  const sent = transport(t), config = new Configuration('http://127.0.0.1:1');
  config.set({ mode: 'live', apiKey: 'old-local-fixture', authorizePaid: true, maxRequests: 2 });
  const stale = config.client();
  config.set({ mode: 'live', baseUrl: 'https://new.example.invalid/v1', apiKey: 'new-local-fixture', authorizePaid: true, maxRequests: 5 });
  await assert.rejects(stale.complete(messages), /provider.*changed/i);
  assert.equal(config.view().remainingLiveRequests, 5); assert.equal(sent(), 0);
});
