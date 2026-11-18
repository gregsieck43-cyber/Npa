import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockProvider } from '../src/fixtures/mock-provider.js';

test('the owned mock emits real delayed SSE fragments before completion', async () => {
    const content = 'Persistent streaming response with independently observable fragments.';
    const provider = await startMockProvider({ responder: () => ({ content }), ...{ streamChunkChars: 8, streamDelayMs: 30 } });
    try {
        const response = await fetch(provider.url + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'Stream fixture' }] }) });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let text = '', partialObserved = false;
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            text += decoder.decode(next.value, { stream: true });
            if (text.includes('"content"') && !text.includes('[DONE]')) partialObserved = true;
        }
        const events = text.split(/\r?\n/).filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
        const fragments = events.flatMap(event => event.choices).map(choice => choice.delta?.content).filter((value): value is string => typeof value === 'string');
        assert.ok(fragments.length > 2, 'multiple content events are required, not one delayed full answer');
        assert.equal(partialObserved, true);
        assert.equal(fragments.join(''), content);
        assert.match(text, /data: \[DONE\]/);
    } finally { await provider.close(); }
});
