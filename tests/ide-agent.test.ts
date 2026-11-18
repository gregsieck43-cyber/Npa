import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startBackend } from '../src/app/backend.js';
import { BackendClient } from '../src/extensions/client.js';

test('IDE Agent view uses the real shared Chat request, metrics and workspace scope', { timeout: 30000 }, async t => {
  const root = mkdtempSync(path.resolve('.tmp', 'ide-agent-view-')), dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace'), other = path.join(root, 'other'); mkdirSync(workspace); mkdirSync(other);
  const backend = await startBackend({ dataDir, projectRoot: process.cwd(), mockOptions: { delayMs: 100 } });
  t.after(async () => { await backend.close(); rmSync(root, { recursive: true, force: true }); });
  const client = new BackendClient({ dataDir });
  const empty = await client.agentView(workspace, {});
  assert.deepEqual(empty.tasks, []); assert.deepEqual(empty.chats, []);
  assert.ok(empty.profiles.every(profile => !('credentialFile' in profile)));
  const chat = await client.createChat({ workspace, title: 'IDE shared chat', profileId: 'default', capabilities: { tools: false } });
  const sent = await client.sendChat({ sessionId: chat.id, content: 'IDE_CHAT_MARKER' });
  assert.equal(sent.status, 'running');
  const deadline = Date.now() + 10000;
  let view = await client.agentView(workspace, { chatId: chat.id });
  while (view.request?.status !== 'completed' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); view = await client.agentView(workspace, { chatId: chat.id }); }
  assert.equal(view.request!.id, sent.requestId);
  assert.equal(view.request!.status, 'completed');
  assert.match(view.messages.at(-1)!.content, /IDE_CHAT_MARKER/);
  assert.equal(view.metrics!.steps, 1);
  assert.ok(view.metrics!.totalTokens! > 0);
  assert.equal(backend.services.kernel.listTasks().length, 0, 'Chat without tools does not start Work.');
  const foreign = await client.createChat({ workspace: other, title: 'other', profileId: 'default' });
  await assert.rejects(client.agentView(workspace, { chatId: foreign.id }), /workspace/i);
  const all = JSON.stringify(view);
  assert.doesNotMatch(all, /"token"\s*:|"apiKey"\s*:/);
});
