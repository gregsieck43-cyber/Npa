import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Kernel } from '../src/kernel/index.js';
import { HarnessStore } from '../src/harness/store.js';

test('delegation control pages keep large historical child results out of model memory', t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'operation-pages-')), kernel = new Kernel(dir);
  t.after(() => { kernel.close(); rmSync(dir, { recursive: true, force: true }); });
  const parent = kernel.command({ commandId: 'parent', type: 'create_task', parameters: { workspace: dir, title: 'Parent' } }).taskId!;
  const children: string[] = [];
  for (let i = 0; i < 65; i++) {
    const ack = kernel.command({ commandId: `child-${i}`, type: 'delegate', taskId: parent, parameters: { title: `Child ${i}`, paths: [`file-${i}.txt`] } });
    assert.ok(ack.childTaskId); children.push(ack.childTaskId);
    kernel.addMessage(ack.childTaskId, 'assistant', 'Original child evidence '.repeat(5000));
  }
  kernel.delegations = () => { throw new Error('Unbounded delegation materialization'); };
  kernel.queryDelegations = () => { throw new Error('Unbounded child results'); };
  const seen: string[] = []; let cursor = 0;
  for (;;) {
    const page = kernel.delegationPage(parent, cursor, 16);
    assert.ok(page.items.length <= 16 && Buffer.byteLength(JSON.stringify(page)) < 32 * 1024);
    for (const item of page.items) { seen.push(item.childTaskId); assert.ok(item.resultMessageId); }
    if (page.nextCursor === null) break; cursor = page.nextCursor;
  }
  assert.deepEqual(seen, children);
  assert.equal(kernel.activeChildCount(parent), 65);
  assert.deepEqual(kernel.delegationPage(parent, 0, 1, children.at(-1)).items.map(item => item.childTaskId), [children.at(-1)]);
  const duplicate = kernel.command({ commandId: 'child-64', type: 'delegate', taskId: parent, parameters: { title: 'Child 64', paths: ['file-64.txt'] } });
  assert.equal(duplicate.childTaskId, children.at(-1)); assert.equal(duplicate.status, 'duplicate');
});

test('workspace task and Chat navigation use bounded indexed projections and stable cursors', t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'workspace-pages-')), kernel = new Kernel(dir), store = new HarnessStore(dir);
  t.after(() => { store.close(); kernel.close(); rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 125; i++) {
    kernel.command({ commandId: `task-${i}`, type: 'create_task', parameters: { workspace: dir, title: `Task ${i}`, initialStatus: 'paused' } });
    store.createSession({ title: `Chat ${i}`, workspace: dir, profileId: 'default' });
  }
  kernel.listTasks = () => { throw new Error('Full task scan'); }; store.listSessions = () => { throw new Error('Full session scan'); };
  const first = kernel.workspaceTaskPage(dir), second = kernel.workspaceTaskPage(dir, first.nextCursor!);
  assert.equal(first.items.length, 100); assert.equal(second.items.length, 25); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 125);
  assert.equal(store.workspaceSessions(dir).length, 60); assert.equal(store.workspaceSessions(path.join(dir, 'elsewhere')).length, 0);
});
