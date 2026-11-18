import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';

test('Prompt historical token provenance distinguishes provider usage, estimate and disabled snapshots over HTTP', async t => {
  const root = path.resolve(process.env.TEMP ?? '.tmp/inspector-completion-20261104'); mkdirSync(root, { recursive: true });
  const owned = mkdtempSync(path.join(root, 'prompt-tokens-'));
  let calls = 0;
  const backend = await startBackend({ projectRoot: process.cwd(), dataDir: path.join(owned, 'data'), mockOptions: { trace: () => calls++ } });
  t.after(async () => { await backend.close(); assert.equal(path.dirname(owned), root); rmSync(owned, { recursive: true, force: true }); });
  const store = backend.services.harness!.store, session = store.createSession();
  const record = store.createRequest({ sessionId: session.id, profileId: 'default', kind: 'chat', status: 'completed', endpoint: 'mock', body: { model: 'mock', messages: [{ role: 'user', content: 'Recorded message' }] }, bodyHash: 'fixture', sources: [], recordContent: true, draft: '', usage: { prompt_tokens: 17 } });
  const read = async () => {
    const response = await fetch(`http://127.0.0.1:${backend.port}/v1/product/inspector/prompt?sessionId=${session.id}&requestId=${record.id}`, { headers: { Authorization: `Bearer ${backend.token}` } });
    assert.equal(response.status, 200); return await response.json() as any;
  };
  let view = await read(); assert.equal(view.totalTokens, 17); assert.equal(view.totalTokensExact, true);
  store.updateRequest(record.id, { usage: undefined }); view = await read(); assert.equal(view.totalTokensExact, false); assert.ok(view.totalTokens > 0);
  store.updateRequest(record.id, { recordContent: false }); view = await read(); assert.deepEqual(view.parts, []); assert.notEqual(view.totalTokensExact, true); assert.equal(calls, 0);
});
