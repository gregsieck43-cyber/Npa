import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { HarnessStore } from '../src/harness/store.js';
import { promotedOriginFile } from '../src/harness/promoted-memory.js';

const base = path.resolve(process.env.TEMP ?? '.tmp', 'module-02b-followup-promoted-memory');
const fixture = (t: TestContext): string => {
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'pm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const link = (store: HarnessStore, taskId: string, sessionId: string, ids: string[]): void => {
  store.setSetting('promotedChat:' + taskId, { sessionId, sourceMessageIds: ids, archiveSnapshot: store.memory(sessionId).manifest().snapshot });
};

test('a promoted origin copies every source row once and keeps exact record bytes', { timeout: 120000 }, t => {
  const dataDir = fixture(t);
  const store = new HarnessStore(dataDir);
  try {
    const session = store.createSession({ title: 'large origin' });
    const ids: string[] = [];
    for (let index = 0; index < 1300; index++) {
      const message = store.addMessage(session.id, { role: index % 2 ? 'assistant' : 'user', content: 'row ' + index + ' ' + 'x'.repeat(400) });
      ids.push(message.id);
    }
    const large = store.addMessage(session.id, { role: 'user', content: 'LARGE-LEDGER ' + 'y'.repeat(200000) });
    ids.push(large.id);
    link(store, 'work-large', session.id, [ids[0]!, large.id]);
    const expected = store.recordHashes(session.id, [large.id])[large.id]!;
    const origin = store.promotedMemory('work-large');
    assert.ok(origin, 'a promoted Work must expose its origin archive');
    assert.equal(origin!.manifest().messages, ids.length, 'the copy must contain every row at the snapshot, not a capped prefix');
    const record = origin!.read({ id: large.id, field: 'record', length: 12000 });
    assert.equal(record.sha256, expected, 'the copied raw record must keep the original SHA-256');
    let text = record.text;
    let offset = record.nextOffset;
    let pages = 1;
    while (offset !== null) {
      const page = origin!.read({ id: large.id, field: 'record', offset, length: 12000 });
      assert.equal(page.sha256, expected);
      text += page.text;
      offset = page.nextOffset;
      pages++;
    }
    assert.equal(pages, Math.ceil(record.totalChars / 12000));
    assert.equal(text.length, record.totalChars);
    assert.match(text, /LARGE-LEDGER/);
    const found = origin!.search({ query: 'LARGE-LEDGER', limit: 5 });
    assert.ok(found.results.some(hit => hit.id === large.id), 'origin search must index the copied rows');
    assert.ok(existsSync(promotedOriginFile(dataDir, 'work-large')));
  } finally { store.close(); }
});

test('repeated origin reads open a fresh handle and survive a removed copy file', { timeout: 60000 }, t => {
  const dataDir = fixture(t);
  const store = new HarnessStore(dataDir);
  try {
    const session = store.createSession({ title: 'handles' });
    const first = store.addMessage(session.id, { role: 'user', content: 'first row' });
    // A legacy link keeps only source IDs; the store must derive and persist its snapshot once.
    store.setSetting('promotedChat:work-handles', { sessionId: session.id, sourceMessageIds: [first.id] });
    const held = store.promotedMemory('work-handles');
    assert.ok(held);
    const persisted = store.getSetting<{ archiveSnapshot?: number } | null>('promotedChat:work-handles', null);
    assert.equal(typeof persisted?.archiveSnapshot, 'number');
    const file = promotedOriginFile(dataDir, 'work-handles');
    assert.ok(existsSync(file));
    for (let round = 0; round < 25; round++) {
      const next = store.promotedMemory('work-handles');
      assert.ok(next);
      assert.notEqual(next, held, 'each call must return its own handle-owning reader');
      assert.equal(next!.read({ id: first.id }).text, 'first row');
    }
    assert.equal(held!.read({ id: first.id }).text, 'first row', 'a retained reader must not point at a closed shared handle');
    unlinkSync(file);
    const recreated = store.promotedMemory('work-handles');
    assert.ok(recreated);
    assert.ok(existsSync(file), 'a missing durable copy is recreated from the live source');
    assert.equal(recreated!.read({ id: first.id }).text, 'first row');
    assert.equal(held!.read({ id: first.id }).text, 'first row');
  } finally { store.close(); }
});

test('promoted origin survives source edit, delete and restart while the live Chat keeps working', { timeout: 60000 }, t => {
  const dataDir = fixture(t);
  const store = new HarnessStore(dataDir);
  let closed = false;
  let reopened: HarnessStore | undefined;
  try {
    const session = store.createSession({ title: 'lifecycle' });
    const keep = store.addMessage(session.id, { role: 'user', content: 'Original immutable requirement' });
    const target = store.addMessage(session.id, { role: 'assistant', content: 'Original answer bytes' });
    link(store, 'work-lifecycle', session.id, [keep.id, target.id]);
    const origin = store.promotedMemory('work-lifecycle');
    assert.ok(origin);
    const rawSha = origin!.read({ id: target.id, field: 'record' }).sha256;
    store.updateMessageContent(session.id, keep.id, 'Edited later requirement');
    store.deleteMessagesAfter(session.id, keep.id);
    assert.equal(store.getSession(session.id).title, 'lifecycle', 'ordinary Chat mutation must keep working');
    assert.equal(origin!.read({ id: target.id, field: 'record' }).sha256, rawSha, 'editing the source must not rewrite origin bytes');
    assert.equal(origin!.read({ id: keep.id }).text, 'Original immutable requirement');
    store.deleteSession(session.id);
    assert.throws(() => store.getSession(session.id), /Chat session not found/);
    assert.equal(origin!.read({ id: target.id, field: 'record' }).sha256, rawSha, 'deleting the source must not remove origin bytes');
    store.close();
    closed = true;
    assert.equal(origin!.read({ id: target.id, field: 'record' }).sha256, rawSha, 'a retained reader must outlive the owner store');
    reopened = new HarnessStore(dataDir);
    const restarted = reopened.promotedMemory('work-lifecycle');
    assert.ok(restarted);
    assert.equal(restarted!.read({ id: target.id, field: 'record' }).sha256, rawSha);
  } finally {
    if (!closed) store.close();
    reopened?.close();
  }
});

test('one promotion preserves only its own origin and multiple Works stay isolated', { timeout: 60000 }, t => {
  const dataDir = fixture(t);
  const store = new HarnessStore(dataDir);
  try {
    const alpha = store.createSession({ title: 'A' });
    const alphaMessage = store.addMessage(alpha.id, { role: 'user', content: 'alpha-only fact' });
    const beta = store.createSession({ title: 'B' });
    const betaMessage = store.addMessage(beta.id, { role: 'user', content: 'beta-only fact' });
    link(store, 'work-a', alpha.id, [alphaMessage.id]);
    link(store, 'work-b', beta.id, [betaMessage.id]);
    const originA = store.promotedMemory('work-a');
    assert.ok(originA);
    assert.ok(existsSync(promotedOriginFile(dataDir, 'work-a')));
    store.deleteSession(alpha.id);
    assert.ok(existsSync(promotedOriginFile(dataDir, 'work-a')));
    assert.ok(!existsSync(promotedOriginFile(dataDir, 'work-b')), 'unrelated promotions must not be materialized by another Chat delete');
    const originB = store.promotedMemory('work-b');
    assert.ok(originB);
    assert.equal(originB!.read({ id: betaMessage.id }).text, 'beta-only fact');
    assert.throws(() => originB!.read({ id: alphaMessage.id }), /Source not found/);
    assert.equal(originA!.read({ id: alphaMessage.id }).text, 'alpha-only fact');
  } finally { store.close(); }
});
