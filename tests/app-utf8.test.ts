import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import { startMockProvider } from '../src/fixtures/mock-provider.js';

async function splitPost(url: string, value: unknown, token?: string): Promise<any> {
    const bytes = Buffer.from(JSON.stringify(value));
    const split = bytes.findIndex(byte => byte > 127) + 1;
    assert.ok(split > 1);
    return new Promise((resolve, reject) => {
        const outgoing = request(url, { method: 'POST', agent: false, headers: {
            'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        } }, response => {
            response.setEncoding('utf8');
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        });
        outgoing.on('error', reject);
        outgoing.write(bytes.subarray(0, split));
        setTimeout(() => outgoing.end(bytes.subarray(split)), 20);
    });
}

test('public commands preserve Chinese text when HTTP splits a UTF-8 character', async t => {
    const temp = path.resolve('.tmp');
    mkdirSync(temp, { recursive: true });
    const owned = mkdtempSync(path.join(temp, 'utf8-test-'));
    const backend = await startBackend({ dataDir: path.join(owned, 'data'), projectRoot: path.resolve('.') });
    t.after(async () => { await backend.close(); rmSync(owned, { recursive: true, force: true }); });
    const objective = '目标：保留原始中文与表情 🛠️';
    const ack = await splitPost(`http://127.0.0.1:${backend.port}/v1/commands`, {
        commandId: randomUUID(), type: 'create_task', parameters: { title: 'UTF-8', goal: { objective } },
    }, backend.token);
    assert.equal(backend.services.task(ack.taskId).goal.objective, objective);
    assert.equal(backend.services.kernel.getMessages(ack.taskId)[0]!.content, objective);
});

test('mock Chat Completions wire preserves split Chinese request bytes', async t => {
    const mock = await startMockProvider();
    t.after(() => mock.close());
    const content = '目标：保留中文协议输入';
    const response = await splitPost(`${mock.url}/chat/completions`, {
        model: 'mock', stream: false, messages: [{ role: 'user', content }], tools: [],
    });
    assert.equal(response.choices[0].message.content, `Mock response: ${content}`);
});
