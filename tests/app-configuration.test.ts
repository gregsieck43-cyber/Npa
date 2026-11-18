import test from 'node:test';
import assert from 'node:assert/strict';
import { Configuration } from '../src/app/configuration.js';

test('provider configuration keeps credentials in memory and blocks paid requests by default', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'local fixture' }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } }));
    const messages = [{ role: 'user' as const, content: 'fixture' }];
    const config = new Configuration('http://127.0.0.1:1234');
    config.set({ mode: 'live', apiKey: 'harmless-fixture-credential' });
    assert.equal(config.view().credentialPresent, true);
    assert.equal(JSON.stringify(config.view()).includes('harmless-fixture-credential'), false);
    assert.equal(config.redact('reply harmless-fixture-credential'), 'reply [credential redacted]');
    await assert.rejects(config.client().complete(messages), /Paid requests are blocked/);
    config.set({ mode: 'live', authorizePaid: true, maxRequests: 1 });
    await config.client().complete(messages); // Local intercepted transport; no real API call.
    await assert.rejects(config.client().complete(messages), /Paid requests are blocked/);
});

test('provider rejects credential-bearing or ambiguous base URLs before saving configuration', () => {
    const config = new Configuration('http://127.0.0.1:1234');
    for (const baseUrl of ['http://example.test/v1', 'https://TEST_ONLY_USER:TEST_ONLY_PASSWORD@example.test/v1', 'https://example.test/v1?api_key=fixture', 'https://example.test/v1#fixture']) {
        assert.throws(() => config.set({ mode: 'live', baseUrl }), /HTTPS base URL/);
        assert.equal(config.provider.mode, 'mock');
    }
});
