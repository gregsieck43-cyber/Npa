import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startBackend } from '../src/app/backend.js';
import type { GatewayEvent } from '../src/frontend/api/types.js';
import { ProductChat } from '../src/product/chat.js';
import { ProductSessions } from '../src/product/sessions.js';
import { ProductError, type ProductRuntime } from '../src/product/shared.js';
import { ProductStore } from '../src/product/store.js';

const root = path.resolve(process.env.TEMP ?? '.tmp');

const until = async <T>(read: () => T | undefined, timeoutMs = 20000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected state.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

const setup = async (delayMs = 0) => {
  const dir = mkdtempSync(path.join(root, 'chat-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const trace: Record<string, any>[] = [];
  const backend = await startBackend({ dataDir: path.join(dir, 'data'), projectRoot: process.cwd(),
    mockOptions: { ...(delayMs ? { delayMs } : {}), trace: (body: Record<string, any>) => { trace.push(body); } } });
  const store = new ProductStore(path.join(dir, 'data'));
  const events: GatewayEvent[] = [];
  const runtime: ProductRuntime = {
    services: backend.services, harness: backend.services.harness!, store,
    append: (event, sessionId) => { events.push(event); store.append([{ event, ...(sessionId ? { sessionId } : {}) }]); },
    resolveProject: projectId => projectId,
  };
  const sessions = new ProductSessions(runtime);
  const chat = new ProductChat(runtime, sessions);
  const close = async () => { store.close(); await backend.close(); rmSync(dir, { recursive: true, force: true }); };
  return { backend, store, sessions, chat, events, trace, dir, workspace, close };
};
type Env = Awaited<ReturnType<typeof setup>>;

const sendChat = (env: Env, text: string) =>
  env.chat.send({ mode: 'chat', text, attachments: [], permission: 'ask', modelId: 'default' });
const settle = (env: Env, sessionId: string) =>
  until(() => env.backend.services.harness!.chat.busy(sessionId) ? undefined : true);

const isProductError = (code: string, status?: number) => (error: unknown): boolean =>
  error instanceof ProductError && error.code === code && (status === undefined || error.status === status);

test('edit of a streaming conversation is busy, and succeeds after settlement with archived history', async t => {
  const env = await setup(120);
  t.after(() => env.close());
  const sent = await sendChat(env, 'Original question about widgets');
  assert.ok(env.backend.services.harness!.chat.activeRequestId(sent.sessionId));
  await assert.rejects(env.chat.edit(sent.sessionId, sent.messageId, 'Replacement question about widgets'), isProductError('busy', 409));
  await assert.rejects(env.chat.regenerate(sent.sessionId, sent.messageId), isProductError('busy', 409));
  await settle(env, sent.sessionId);

  const before = await env.sessions.get(sent.sessionId);
  assert.equal(before.messages.length, 2);
  const assistantId = before.messages[1]!.id;
  await env.chat.edit(sent.sessionId, sent.messageId, 'Replacement question about widgets');
  await settle(env, sent.sessionId);

  const after = await env.sessions.get(sent.sessionId);
  assert.equal(after.messages.length, 2);
  assert.equal(after.messages[0]!.id, sent.messageId);
  const text = after.messages[0]!.parts.find(part => part.kind === 'text');
  assert.equal(text?.kind === 'text' ? text.text : undefined, 'Replacement question about widgets');
  assert.notEqual(after.messages[1]!.id, assistantId);

  const archives = env.store.archives(sent.sessionId);
  assert.equal(archives.length, 1);
  assert.equal(archives[0]!.kind, 'edit');
  assert.deepEqual(archives[0]!.sourceIds, [sent.messageId, assistantId]);
  const record = archives[0]!.record as { requestIds: string[]; modelProfileId: string; messages: { id: string; role: string; content: string; requestId?: string }[] };
  assert.equal(record.modelProfileId, 'default');
  assert.equal(record.messages[0]!.id, sent.messageId);
  assert.equal(record.messages[0]!.content, 'Original question about widgets');
  assert.equal(record.messages[1]!.id, assistantId);
  assert.ok(record.requestIds.length >= 1);

  const lastBody = env.trace.at(-1)!;
  assert.ok(lastBody.messages.some((message: any) => message.content.includes('Replacement question about widgets')));
});

test('regenerate replaces the selected assistant or later messages and archives originals', async t => {
  const env = await setup(120);
  t.after(() => env.close());
  const sent = await sendChat(env, 'Regenerate this conversation');
  await settle(env, sent.sessionId);
  const first = await env.sessions.get(sent.sessionId);
  assert.equal(first.messages.length, 2);
  const assistantId = first.messages[1]!.id;

  await env.chat.regenerate(sent.sessionId, assistantId);
  await settle(env, sent.sessionId);
  const second = await env.sessions.get(sent.sessionId);
  assert.equal(second.messages.length, 2);
  assert.equal(second.messages[0]!.id, sent.messageId);
  assert.notEqual(second.messages[1]!.id, assistantId);
  assert.equal(env.store.archives(sent.sessionId)[0]!.kind, 'regenerate');
  assert.deepEqual(env.store.archives(sent.sessionId)[0]!.sourceIds, [assistantId]);

  const replacement = second.messages[1]!.id;
  await env.chat.regenerate(sent.sessionId, sent.messageId);
  await settle(env, sent.sessionId);
  const third = await env.sessions.get(sent.sessionId);
  assert.equal(third.messages.length, 2);
  assert.equal(third.messages[0]!.id, sent.messageId);
  assert.notEqual(third.messages[1]!.id, replacement);
  assert.equal(env.store.archives(sent.sessionId).length, 2);

  await assert.rejects(env.chat.regenerate(sent.sessionId, 'missing-message'), isProductError('not_found'));
  await assert.rejects(env.chat.edit(sent.sessionId, 'missing-message', 'text'), isProductError('not_found'));
  await assert.rejects(env.chat.edit(sent.sessionId, third.messages[1]!.id, 'assistant text'), isProductError('not_found'));
  await assert.rejects(env.chat.regenerate('missing-session', sent.messageId), isProductError('not_found'));
});

test('cancel aborts the active chat request idempotently', async t => {
  const env = await setup(120);
  t.after(() => env.close());
  const sent = await sendChat(env, 'Cancel this request');
  assert.ok(env.backend.services.harness!.chat.activeRequestId(sent.sessionId));
  await env.chat.cancel(sent.sessionId);
  await settle(env, sent.sessionId);
  assert.equal(env.backend.services.harness!.chat.activeRequestId(sent.sessionId), undefined);
  await env.chat.cancel(sent.sessionId);
  const page = await env.sessions.list({ text: 'Cancel this request' });
  assert.equal(page.items[0]!.status, 'idle');
});

test('send validates input and rejects mismatched session kinds', async t => {
  const env = await setup();
  t.after(() => env.close());
  const base = { mode: 'chat' as const, text: 'Valid text', attachments: [], permission: 'ask' as const, modelId: 'default' };
  await assert.rejects(env.chat.send({ ...base, text: '' }), isProductError('validation'));
  await assert.rejects(env.chat.send({ ...base, text: 'x'.repeat(100001) }), isProductError('validation'));
  await assert.rejects(env.chat.send({ ...base, mode: 'cowork', text: 'x'.repeat(64001) }), isProductError('validation'));
  await assert.rejects(env.chat.send({ ...base, mode: 'bogus' as never }), isProductError('validation'));
  await assert.rejects(env.chat.send({ ...base, permission: 'sometimes' as never }), isProductError('validation'));
  await assert.rejects(env.chat.send({ ...base, modelId: 'missing-profile' }), isProductError('validation'));
  await assert.rejects(env.chat.send({ ...base, unexpected: true } as never), isProductError('validation'));
  await assert.rejects(env.chat.send({ ...base, attachments: Array.from({ length: 6 }, (_, index) => ({ id: `a${index}`, name: `a${index}.txt`, kind: 'file' as const, path: path.join(env.workspace, `a${index}.txt`) })) }), isProductError('validation'));
  await assert.rejects(env.chat.send({ ...base, attachments: [{ id: 'a', name: 'note.txt', kind: 'file' as const }] }), isProductError('validation'));
  await assert.rejects(env.chat.send({ sessionId: 'missing-session', ...base }), isProductError('not_found'));

  const chatSent = await sendChat(env, 'A chat session');
  await settle(env, chatSent.sessionId);
  await assert.rejects(env.chat.send({ ...base, sessionId: chatSent.sessionId, mode: 'cowork' }), isProductError('validation'));

  const work = await env.chat.send({ ...base, mode: 'cowork', text: 'A work session', projectId: env.workspace });
  await assert.rejects(env.chat.send({ ...base, sessionId: work.sessionId }), isProductError('validation'));
  await env.sessions.remove(work.sessionId);
});

test('chat send maps readable text attachments onto the stored message', async t => {
  const env = await setup();
  t.after(() => env.close());
  const file = path.join(env.workspace, 'note.txt');
  writeFileSync(file, 'attachment text', 'utf8');
  const sent = await env.chat.send({ mode: 'chat', text: 'Read the attachment', attachments: [{ id: 'a1', name: 'note.txt', kind: 'file', bytes: 15, path: file }],
    permission: 'ask', modelId: 'default', projectId: env.workspace });
  await settle(env, sent.sessionId);
  const stored = env.backend.services.harness!.store.allMessages(sent.sessionId).find(message => message.id === sent.messageId);
  assert.ok(stored);
  assert.equal(stored!.attachments?.length, 1);
  assert.equal(stored!.attachments![0]!.name, 'note.txt');
  assert.equal(stored!.attachments![0]!.content, 'attachment text');
  assert.ok(env.events.some(event => event.type === 'message.upsert' && event.sessionId === sent.sessionId && event.message.id === sent.messageId));
});
