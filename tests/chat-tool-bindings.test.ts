import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { HarnessStore, type PendingChatToolBinding as Pending } from '../src/harness/store.js';
import { ChatTools } from '../src/harness/chat-tools.js';
import { Kernel } from '../src/kernel/index.js';
import type { Command } from '../src/contracts.js';
import type { Services } from '../src/app/services.js';
import type { ChatService } from '../src/harness/chat.js';

function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(path.join(process.env.TEMP!, 'bindings-')), data = path.join(root, 'data'); mkdirSync(data);
  const store = new HarnessStore(data);
  t.after(() => { store.close(); assert.equal(path.dirname(root), process.env.TEMP); rmSync(root, { recursive: true, force: true }); });
  return { root, data, store };
}

test('legacy large bindings migrate without decoding settings and retain indexed scope order and backup', t => {
  const { store } = fixture(t), legacy: Record<string, unknown> = {};
  for (let i = 0; i < 5000; i++) legacy[`session-${i}`] = [`task-${i}-a`, null, '', `task-${i}-b`];
  legacy.single = 'task-single';
  store.setSetting('chatToolTasks', legacy);
  const original = store.getSetting.bind(store);
  store.getSetting = () => { throw new Error('Full legacy settings must not be decoded'); };
  store.migrateChatToolBindings();
  assert.deepEqual(store.latestChatToolBinding('session-4999'), { index: 1, taskId: 'task-4999-b' });
  assert.equal(store.chatToolBinding('session-4999', 0), 'task-4999-a');
  assert.equal(store.latestChatToolBinding('single')?.index, 0);
  let cursor = 0, total = 0;
  while (true) {
    const page = store.unregisteredChatToolBindings(cursor, 100); if (!page.length) break;
    assert.ok(page.length <= 100); total += page.length; cursor = page.at(-1)!.cursor;
    store.transaction(() => { for (const row of page) store.markChatToolBindingRegistered(row.sessionId, row.index); });
  }
  assert.equal(total, 10001); assert.equal(store.unregisteredChatToolBindings().length, 0);
  store.migrateChatToolBindings(); assert.equal(store.unregisteredChatToolBindings().length, 0);
  assert.deepEqual(original('chatToolTasks', null), legacy, 'legacy settings remain an immutable migration backup');
});

test('pending binding uses exact command identity and atomically retires only its marker', t => {
  const { store } = fixture(t); store.migrateChatToolBindings();
  const pending: Pending = { index: 0, command: { commandId: 'create-bound', type: 'create_task', parameters: {} } };
  store.setPendingChatToolBinding('session', pending);
  assert.throws(() => store.completeChatToolBinding('session', { ...pending, command: { ...pending.command, commandId: 'stale' } }, 'wrong'), /binding/i);
  assert.equal(store.latestChatToolBinding('session'), undefined);
  store.completeChatToolBinding('session', pending, 'task');
  assert.equal(store.chatToolBinding('session', 0), 'task');
  assert.equal(store.pendingChatToolBindings().length, 0);
  assert.equal(store.unregisteredChatToolBindings().length, 0);
});

test('paged pending recovery preserves legacy ownership and replays a crashed cross-database binding once', async t => {
  let kernel!: Kernel; t.after(() => kernel?.close());
  const { store, data } = fixture(t); kernel = new Kernel(data);
  const pending: Record<string, Pending> = {}, tasks: Record<string, string> = {};
  for (let i = 0; i < 205; i++) {
    const id = `session-${i.toString().padStart(3, '0')}`;
    const command: Command = { commandId: `bind-${i}`, type: 'create_task', parameters: {
      title: 'Chat fixture', goal: { objective: 'Read only', constraints: [], acceptance: [], maxModelCalls: 1, maxToolCalls: 1, mode: 'collaborative' } } };
    pending[id] = { index: 0, command };
    if (i === 0) tasks.legacy = kernel.command({ ...command, commandId: 'legacy' }).taskId!;
  }
  store.setSetting('chatToolTasks', tasks); store.setSetting('chatToolPending', pending);
  const services = { kernel, runner: { managedExternally: { add: (id: string) => kernel.manageExternally(id) } },
    configuration: { sanitize: (value: unknown) => value }, command: (command: Command) => kernel.command(command) } as unknown as Services;
  const complete = store.completeChatToolBinding?.bind(store); let crashed = false;
  store.completeChatToolBinding = (sessionId, marker, taskId) => {
    if (!crashed) { crashed = true; throw new Error('Crash after Kernel committed'); }
    complete!(sessionId, marker, taskId);
  };
  store.getSetting = () => { throw new Error('Bindings recovery must not load settings objects'); };
  let bridge = new ChatTools(services, store, {} as ChatService); await bridge.ready; await bridge.stop();
  assert.equal(kernel.isManagedExternally(tasks.legacy!), true);
  assert.equal(store.pendingChatToolBindings().length, 1);
  assert.equal(kernel.listTasks().length, 206);
  store.completeChatToolBinding = complete!;
  bridge = new ChatTools(services, store, {} as ChatService); await bridge.ready; await bridge.stop();
  assert.equal(store.pendingChatToolBindings().length, 0);
  assert.equal(kernel.listTasks().length, 206, 'recovery must return the same committed task');
  assert.ok(kernel.listTasks().every(task => kernel.isManagedExternally(task.id)));
  assert.equal(Object.hasOwn(bridge, 'tasks'), false); assert.equal(Object.hasOwn(bridge, 'pending'), false);
});
