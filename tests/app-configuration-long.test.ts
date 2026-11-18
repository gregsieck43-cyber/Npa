import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Configuration } from '../src/app/configuration.js';

function fixture(t: TestContext) {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'local fixture' }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } }));
  const parent = path.resolve(process.env.TEMP ?? '.tmp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'configuration-long-'));
  t.after(() => { assert.equal(path.dirname(directory), parent); rmSync(directory, { recursive: true }); });
  const keyFile = path.join(directory, 'credentials.txt');
  writeFileSync(keyFile, 'harmless-local-file-credential\n');
  return { directory, keyFile, configuration: () => new Configuration('http://127.0.0.1:1234', directory) };
}

const messages = [{ role: 'user' as const, content: 'Local transport fixture only.' }];

test('external credential and remaining request allowance survive restart without serializing a secret', async t => {
  const f = fixture(t), config = f.configuration();
  config.set({ mode: 'live', credentialFile: f.keyFile, authorizePaid: true, maxRequests: 2, authorizeDays: 20 });
  assert.equal(config.view().credentialPresent, true);
  await config.client().complete(messages);
  const restarted = f.configuration();
  assert.equal(restarted.view().remainingLiveRequests, 1);
  assert.equal(restarted.view().credentialPresent, true);
  await restarted.client().complete(messages);
  await assert.rejects(f.configuration().client().complete(messages), /Paid requests are blocked/);
  assert.equal(readFileSync(path.join(f.directory, 'configuration.json'), 'utf8').includes('harmless-local-file-credential'), false);
  assert.equal(JSON.stringify(config.view()).includes('harmless-local-file-credential'), false);
});

test('a 20-day authorization remains valid on day 19 and expires on day 21 after restart', async t => {
  const f = fixture(t), start = Date.now();
  t.mock.method(Date, 'now', () => start);
  const config = f.configuration();
  config.set({ mode: 'live', credentialFile: f.keyFile, authorizePaid: true, maxRequests: 1000, authorizeDays: 20 });
  t.mock.method(Date, 'now', () => start + 19 * 86400000);
  await f.configuration().client().complete(messages);
  t.mock.method(Date, 'now', () => start + 21 * 86400000);
  await assert.rejects(f.configuration().client().complete(messages), /expired|过期/i);
});

test('missing credentials do not consume an allowance and switching provider revokes it', async t => {
  const f = fixture(t), config = f.configuration();
  config.set({ mode: 'live', authorizePaid: true, maxRequests: 5 });
  await assert.rejects(config.client().complete(messages), /credential/i);
  assert.equal(config.view().remainingLiveRequests, 5);
  config.set({ mode: 'live', apiKey: 'harmless-session-credential' });
  await config.client().complete(messages);
  config.set({ mode: 'live', baseUrl: 'https://different.example/v1' });
  await assert.rejects(config.client().complete(messages), /Paid requests are blocked/);
});

test('invalid credential file or allowance leaves the prior configuration untouched', t => {
  const f = fixture(t), config = f.configuration();
  config.set({ mode: 'live', credentialFile: f.keyFile, authorizePaid: true, maxRequests: 12 });
  const before = JSON.stringify(config.view());
  assert.throws(() => config.set({ mode: 'live', credentialFile: path.join(f.directory, 'missing.key') }), /credential file/i);
  assert.equal(JSON.stringify(config.view()), before);
  assert.throws(() => config.set({ mode: 'live', authorizePaid: true, maxRequests: 1000001 }), /request/i);
  assert.equal(JSON.stringify(config.view()), before);
  config.set({ mode: 'live', credentialFile: '' });
  assert.equal(config.view().credentialPresent, false);
});
