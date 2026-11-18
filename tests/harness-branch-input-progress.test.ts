import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { HarnessStore } from '../src/harness/store.js';

test('branching remaps consumed input, preserves partial input and survives another branch', t => {
  const root = path.resolve(process.env.TEMP ?? '.tmp');
  const dir = mkdtempSync(path.join(root, 'branch-progress-'));
  const store = new HarnessStore(dir);
  t.after(() => { store.close(); assert.equal(path.dirname(dir), root); rmSync(dir, { recursive: true, force: true }); });
  const source = store.createSession({ title: 'source' });
  const user = store.addMessage(source.id, { role: 'user', content: 'consumed' });
  const cursor = store.messageRef(source.id, user.id)!.seq;
  const pending = store.addMessage(source.id, { role: 'user', content: 'partially read input' });
  const assistant = store.addMessage(source.id, { role: 'assistant', content: 'notes', sampledUserInput: { cursor, offset: 5 } });
  const original = store.allMessages(source.id);
  let parent = source;
  let through = store.messageRef(source.id, assistant.id)!.seq;
  for (let generation = 0; generation < 2; generation++) {
    const branch = store.createSession({ title: 'branch' });
    store.transaction(() => store.copyMessagesThrough(parent.id, branch.id, through, { pageSize: 1 }));
    const rows = store.allMessages(branch.id);
    const progress = store.consumedUserInput(branch.id);
    assert.deepEqual(progress, { cursor: store.messageRef(branch.id, rows[0]!.id)!.seq, offset: 5 });
    assert.equal(store.userMessagesAfter(branch.id, progress.cursor)[0]!.message.content, pending.content);
    parent = branch; through = store.messageRef(branch.id, rows.at(-1)!.id)!.seq;
  }
  assert.deepEqual(store.allMessages(source.id), original);
  const sanitized = store.createSession({ title: 'sanitized branch' });
  store.transaction(() => store.copyMessagesThrough(source.id, sanitized.id, store.messageRef(source.id, assistant.id)!.seq,
    { sanitizeContent: content => content.replace('partially ', '') }));
  const sanitizedRows = store.allMessages(sanitized.id);
  assert.deepEqual(store.consumedUserInput(sanitized.id), { cursor: store.messageRef(sanitized.id, sanitizedRows[0]!.id)!.seq, offset: 0 },
    'changed source bytes must be reread rather than reusing an offset from the unsanitized source');
  assert.equal(store.userMessagesAfter(sanitized.id, store.consumedUserInput(sanitized.id).cursor)[0]!.message.content, 'read input');
});
