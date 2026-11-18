import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

const open = async (directory?: string) => {
  const dir = directory ?? mkdtempSync(path.join(root, 'restart-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const trace: Record<string, any>[] = [];
  const backend = await startBackend({ dataDir: path.join(dir, 'data'), projectRoot: process.cwd(),
    mockOptions: { trace: (body: Record<string, any>) => { trace.push(body); } } });
  const store = new ProductStore(path.join(dir, 'data'));
  const events: GatewayEvent[] = [];
  const runtime: ProductRuntime = {
    services: backend.services, harness: backend.services.harness!, store,
    append: (event, sessionId) => { events.push(event); store.append([{ event, ...(sessionId ? { sessionId } : {}) }]); },
    resolveProject: projectId => projectId,
  };
  const sessions = new ProductSessions(runtime);
  const chat = new ProductChat(runtime, sessions);
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; store.close(); await backend.close(); };
  return { backend, store, sessions, chat, events, trace, dir, workspace, stop };
};
type Env = Awaited<ReturnType<typeof open>>;

const sendChat = (env: Env, text: string) =>
  env.chat.send({ mode: 'chat', text, attachments: [], permission: 'ask', modelId: 'default' });
const settle = (env: Env, sessionId: string) =>
  until(() => env.backend.services.harness!.chat.busy(sessionId) ? undefined : true);

const isProductError = (code: string) => (error: unknown): boolean =>
  error instanceof ProductError && error.code === code;

test('session pages resume with the same cursor after a backend restart', async t => {
  const first = await open();
  let running = first;
  t.after(async () => { await running.stop(); rmSync(first.dir, { recursive: true, force: true }); });
  try {
    const created: string[] = [];
    for (let index = 1; index <= 8; index++) {
      const sent = await sendChat(first, `Restart session ${index}`);
      created.push(sent.sessionId);
      await settle(first, sent.sessionId);
    }
    const deleted = created.pop()!;
    await first.sessions.remove(deleted);
    assert.equal(first.store.getSession(deleted), undefined);

    const page1 = await first.sessions.list({ limit: 3 });
    assert.equal(page1.items.length, 3);
    assert.ok(page1.nextCursor);
    const page2 = await first.sessions.list({ limit: 3, cursor: page1.nextCursor });
    assert.equal(page2.items.length, 3);
    assert.ok(page2.nextCursor);
    const page3 = await first.sessions.list({ limit: 3, cursor: page2.nextCursor });
    assert.equal(page3.items.length, 1);
    assert.equal(page3.nextCursor, undefined);
    const pagedBefore = [...page1.items, ...page2.items, ...page3.items].map(item => item.id);
    assert.equal(new Set(pagedBefore).size, 7);
    assert.ok(!pagedBefore.includes(deleted));

    const work = await first.chat.send({ mode: 'cowork', text: 'Restart work task', attachments: [], permission: 'ask', modelId: 'default', projectId: first.workspace });
    await first.sessions.remove(work.sessionId);
    assert.ok(first.backend.services.kernel.getTask(work.sessionId));

    await first.stop();
    running = await open(first.dir);
    const second = running;

    const page1After = await second.sessions.list({ limit: 3 });
    assert.deepEqual(page1After.items.map(item => item.id), page1.items.map(item => item.id));
    const page2After = await second.sessions.list({ limit: 3, cursor: page1.nextCursor });
    assert.deepEqual(page2After.items.map(item => item.id), page2.items.map(item => item.id));
    const page3After = await second.sessions.list({ limit: 3, cursor: page2.nextCursor });
    assert.deepEqual(page3After.items.map(item => item.id), page3.items.map(item => item.id));

    await assert.rejects(second.sessions.list({ cursor: 'not-a-valid-cursor' }), isProductError('validation'));
    await assert.rejects(second.sessions.list({ cursor: Buffer.from('{}', 'utf8').toString('base64url') }), isProductError('validation'));

    await assert.rejects(second.sessions.get(deleted), isProductError('not_found'));
    const deletedPage = await second.sessions.list({ text: `Restart session 8` });
    assert.equal(deletedPage.items.length, 0);

    assert.equal(second.store.getSession(work.sessionId), undefined);
    assert.ok(second.backend.services.kernel.getTask(work.sessionId));
    assert.ok(second.store.isSessionDismissed(work.sessionId));
    const workPage = await second.sessions.list({ text: 'Restart work task' });
    assert.equal(workPage.items.length, 0);
  } finally {
    await running.stop();
  }
});
