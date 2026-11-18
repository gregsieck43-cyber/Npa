import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HarnessStore } from '../src/harness/store.js';
import { promotedOriginFile } from '../src/harness/promoted-memory.js';
import { memoryTool } from '../src/memory/tools.js';

function fixture(t: test.TestContext) {
  const parent = path.resolve(process.env.TEMP ?? '.tmp', 'branch-source-history'); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, 'case-')); let store = new HarnessStore(dir);
  t.after(() => { store.close(); assert.equal(path.dirname(dir), parent); rmSync(dir, { recursive: true, force: true }); });
  return { dir, get store() { return store; }, reopen() { store.close(); store = new HarnessStore(dir); } };
}
const read = (store: HarnessStore, sessionId: string, id: string, through?: number) => JSON.parse(memoryTool(store.memory(sessionId, through), { name: 'read_history', arguments: { id, field: 'record' } }, 'read')!);
const branch = (store: HarnessStore, source: string, through: number, edit?: { messageId: string; content: string }, sanitizeContent?: (content: string) => string) => store.transaction(() => {
  const target = store.createSession({ title: 'Branch' }); store.copyMessagesThrough(source, target.id, through, { edit, sanitizeContent, pageSize: 2 }); return target;
});

test('read_history keeps original IDs and exact source SHA across branch, rebranch, deletion and restart', t => {
  const f = fixture(t), source = f.store.createSession({ title: 'Source' });
  const first = f.store.addMessage(source.id, { role: 'user', content: 'original source', attachments: [{ name: 'proof.txt', path: 'proof.txt', bytes: 5, sha256: 'fixture', content: 'proof' }] });
  const reply = f.store.addMessage(source.id, { role: 'assistant', content: `Read source ${first.id}`, toolCalls: [{ id: 'read-old', name: 'read_history', arguments: { id: first.id } }] });
  const future = f.store.addMessage(source.id, { role: 'user', content: 'outside branch prefix' });
  const original = read(f.store, source.id, first.id);
  const a = branch(f.store, source.id, f.store.messageRef(source.id, reply.id)!.seq, { messageId: first.id, content: 'edited branch text' });
  assert.deepEqual(read(f.store, a.id, first.id), original, 'the old source ID must not silently resolve to edited branch text');
  const aFirst = f.store.messages(a.id, 10)[0]!;
  const aRecord = read(f.store, a.id, aFirst.id);
  const b = branch(f.store, a.id, f.store.memory(a.id).manifest().snapshot);
  assert.deepEqual(read(f.store, b.id, first.id), original);
  assert.deepEqual(read(f.store, b.id, aFirst.id), aRecord);
  assert.throws(() => read(f.store, b.id, future.id), /scope|not found/i);
  const other = f.store.createSession({ title: 'Private other conversation' });
  const secret = f.store.addMessage(other.id, { role: 'user', content: 'unrelated private text' });
  assert.throws(() => read(f.store, b.id, secret.id), /scope|not found/i);
  f.store.deleteSession(source.id); f.store.deleteSession(a.id); f.reopen();
  assert.deepEqual(read(f.store, b.id, first.id), original); assert.deepEqual(read(f.store, b.id, aFirst.id), aRecord);
});

test('ancestor sources obey the copied local prefix and disappear when their local anchor is deleted', t => {
  const f = fixture(t), source = f.store.createSession({ title: 'Source' });
  const one = f.store.addMessage(source.id, { role: 'user', content: 'one' });
  const two = f.store.addMessage(source.id, { role: 'assistant', content: 'two' });
  const a = branch(f.store, source.id, f.store.memory(source.id).manifest().snapshot);
  const copies = f.store.messages(a.id, 10), firstSeq = f.store.messageRef(a.id, copies[0]!.id)!.seq;
  assert.equal(JSON.parse(read(f.store, a.id, one.id, firstSeq).text).content, 'one');
  assert.throws(() => read(f.store, a.id, two.id, firstSeq), /scope|not found/i);
  f.store.deleteMessagesAfter(a.id, copies[0]!.id);
  assert.throws(() => read(f.store, a.id, two.id), /scope|not found/i);
});

test('branch provenance honors current redaction, uses bounded copy pages and rolls back with the branch', t => {
  const f = fixture(t), source = f.store.createSession({ title: 'Source' });
  const original = f.store.addMessage(source.id, { role: 'user', content: 'credential SECRET', reasoningContent: 'SECRET thinking' });
  for (let n = 0; n < 8; n++) f.store.addMessage(source.id, { role: 'assistant', content: `row ${n}` });
  const getPage = f.store.messagePageAfter.bind(f.store); let maximum = 0;
  f.store.messagePageAfter = (...args) => { const page = getPage(...args); maximum = Math.max(maximum, page.messages.length); return page; };
  f.store.allMessages = () => { throw new Error('Unbounded history is forbidden'); };
  const a = branch(f.store, source.id, f.store.memory(source.id).manifest().snapshot, undefined, value => value.replaceAll('SECRET', '[REDACTED]'));
  const result = read(f.store, a.id, original.id);
  assert.ok(!result.text.includes('SECRET')); assert.match(result.text, /REDACTED/); assert.ok(maximum <= 2);
  assert.notEqual(result.sha256, read(f.store, source.id, original.id).sha256, 'changed originals must have their actual changed SHA');
  let rolledBack = '';
  assert.throws(() => f.store.transaction(() => { rolledBack = branch(f.store, a.id, f.store.memory(a.id).manifest().snapshot).id; throw new Error('rollback'); }), /rollback/);
  assert.throws(() => f.store.memory(rolledBack), /not found/i);
  const b = branch(f.store, a.id, f.store.memory(a.id).manifest().snapshot); assert.deepEqual(read(f.store, b.id, original.id), result);
});

/** Reproduce the pre-upgrade shape: bounded branch evidence and copies, with no source snapshot. */
function legacyBranch(store: HarnessStore, sourceId: string, messageId: string, edited = false, content?: string, witness = true) {
  const source = store.messageRef(sourceId, messageId)!.message;
  if (witness) store.createRequest({ sessionId: sourceId, kind: 'chat', profileId: 'default', status: 'completed', endpoint: 'http://fixture', body: {}, bodyHash: 'fixture', recordContent: true, draft: '', sources: [
    { id: 'context-selection', label: 'Original source manifest', role: 'context', source: 'runtime/context / shared projection', scope: 'harness', estimatedTokens: 0, effective: false,
      content: JSON.stringify({ sources: [{ id: messageId, sessionId: sourceId, sha256: store.recordHashes(sourceId, [messageId])[messageId] }] }) },
  ] });
  const session = store.createSession({ title: 'Legacy', parentSessionId: sourceId, branchMessageId: messageId });
  const copy = store.addMessage(session.id, { role: source.role, content: content ?? source.content, sourceMessageId: messageId });
  store.trace({ sessionId: session.id, parentId: sourceId, type: 'chat.branched', status: 'completed', payload: { originalMessageId: messageId, sourceFirstMessageId: messageId, sourceLastMessageId: messageId, sourceMessageCount: 1, edited, regenerated: false } });
  return { session, copy };
}

test('legacy recovery follows proven bounded branch edges; a new branch preserves the recovered chain before deletion', t => {
  const f = fixture(t), source = f.store.createSession({ title: 'Source' });
  const original = f.store.addMessage(source.id, { role: 'user', content: 'unchanged original' });
  const expected = read(f.store, source.id, original.id);
  const a = legacyBranch(f.store, source.id, original.id), b = legacyBranch(f.store, a.session.id, a.copy.id);
  const later = f.store.addMessage(source.id, { role: 'user', content: 'not in the old branch' });
  const c = branch(f.store, b.session.id, f.store.memory(b.session.id).manifest().snapshot);
  assert.deepEqual(read(f.store, c.id, original.id), expected);
  assert.throws(() => read(f.store, c.id, later.id), /scope|not found/i);
  f.store.deleteSession(source.id); f.store.deleteSession(a.session.id); f.store.deleteSession(b.session.id); f.reopen();
  assert.deepEqual(read(f.store, c.id, original.id), expected);
});

test('legacy edited, changed, missing and unproven originals are not fabricated from branch copies', t => {
  const f = fixture(t), source = f.store.createSession({ title: 'Source' });
  const original = f.store.addMessage(source.id, { role: 'user', content: 'before' });
  const edited = legacyBranch(f.store, source.id, original.id, true, 'edited');
  assert.throws(() => read(f.store, edited.session.id, original.id), /edited without an original snapshot/);
  const changed = legacyBranch(f.store, source.id, original.id);
  f.store.updateMessageContent(source.id, original.id, 'changed later');
  assert.throws(() => read(f.store, changed.session.id, original.id), /changed since branching/);
  const missingProof = f.store.createSession({ title: 'Unproven', parentSessionId: source.id, branchMessageId: original.id });
  f.store.addMessage(missingProof.id, { role: 'user', content: 'changed later', sourceMessageId: original.id });
  assert.throws(() => read(f.store, missingProof.id, original.id), /missing bounded branch evidence/);
  f.store.deleteSession(source.id);
  assert.throws(() => read(f.store, changed.session.id, original.id), /prefix anchor was deleted/);
});

test('legacy backfill applies the current sanitizer and keeps real source identity and SHA', t => {
  const f = fixture(t), source = f.store.createSession({ title: 'Source' });
  const original = f.store.addMessage(source.id, { role: 'user', content: 'credential SECRET' });
  const a = legacyBranch(f.store, source.id, original.id, false, 'credential [REDACTED]');
  const result = f.store.memory(a.session.id, undefined, value => value.replaceAll('SECRET', '[REDACTED]')).read({ id: original.id, field: 'record' });
  assert.equal(JSON.parse(result.text).id, original.id); assert.ok(!result.text.includes('SECRET'));
  assert.notEqual(result.sha256, read(f.store, source.id, original.id).sha256);
});

test('matching later edits on both sides and missing pre-branch hashes do not masquerade as old originals', t => {
  const f = fixture(t), source = f.store.createSession({ title: 'Source' });
  const original = f.store.addMessage(source.id, { role: 'user', content: 'original at fork' });
  const a = legacyBranch(f.store, source.id, original.id);
  f.store.updateMessageContent(source.id, original.id, 'same later edit');
  f.store.updateMessageContent(a.session.id, a.copy.id, 'same later edit');
  assert.throws(() => read(f.store, a.session.id, original.id), /no matching original SHA/);
  const other = f.store.createSession({ title: 'No old manifests' }), item = f.store.addMessage(other.id, { role: 'user', content: 'unchanged but unproven' });
  const b = legacyBranch(f.store, other.id, item.id, false, undefined, false);
  assert.throws(() => read(f.store, b.session.id, item.id), /no matching original SHA/);
});

test('promoting a Chat branch keeps ancestor originals within the frozen Work origin after all Chats disappear', t => {
  const f = fixture(t), source = f.store.createSession({ title: 'Source' });
  const first = f.store.addMessage(source.id, { role: 'user', content: 'original promoted evidence' });
  const second = f.store.addMessage(source.id, { role: 'assistant', content: 'outside promoted prefix' });
  const expected = read(f.store, source.id, first.id);
  const a = branch(f.store, source.id, f.store.memory(source.id).manifest().snapshot);
  const b = branch(f.store, a.id, f.store.memory(a.id).manifest().snapshot), copied = f.store.messages(b.id, 10);
  f.store.setSetting('promotedChat:work-old-ids', { sessionId: b.id, archiveSnapshot: f.store.messageRef(b.id, copied[0]!.id)!.seq });
  const origin = f.store.promotedMemory('work-old-ids')!;
  assert.deepEqual(origin.read({ id: first.id, field: 'record' }), expected);
  assert.throws(() => origin.read({ id: second.id }), /scope|not found/i);
  f.store.deleteSession(source.id); f.store.deleteSession(a.id); f.store.deleteSession(b.id); f.reopen();
  assert.deepEqual(f.store.promotedMemory('work-old-ids')!.read({ id: first.id, field: 'record' }), expected);
});

test('legacy promotion and an older preserved origin gain only byte-matching proven ancestor snapshots', t => {
  const f = fixture(t), source = f.store.createSession({ title: 'Source' });
  const original = f.store.addMessage(source.id, { role: 'user', content: 'legacy promotion evidence' });
  const a = legacyBranch(f.store, source.id, original.id);
  const expected = read(f.store, source.id, original.id);
  f.store.setSetting('promotedChat:legacy-work', { sessionId: a.session.id, archiveSnapshot: f.store.memory(a.session.id).manifest().snapshot });
  assert.deepEqual(f.store.promotedMemory('legacy-work')!.read({ id: original.id, field: 'record' }), expected);
  const old = new DatabaseSync(promotedOriginFile(f.dir, 'legacy-work'));
  old.exec('DROP TABLE chat_history_sources; DROP TABLE origin_metadata;'); old.close();
  assert.deepEqual(f.store.promotedMemory('legacy-work')!.read({ id: original.id, field: 'record' }), expected);
  // Recreate an old archive and a source row changed by an old version, before this migration existed.
  const beforeUpgrade = new DatabaseSync(promotedOriginFile(f.dir, 'legacy-work'));
  beforeUpgrade.exec('DROP TABLE chat_history_sources; DROP TABLE origin_metadata;'); beforeUpgrade.close();
  const legacySource = new DatabaseSync(path.join(f.dir, 'harness.sqlite'));
  legacySource.prepare('UPDATE chat_messages SET record=? WHERE id=?').run(JSON.stringify({ ...a.copy, content: 'later edit' }), a.copy.id); legacySource.close();
  assert.throws(() => f.store.promotedMemory('legacy-work')!.read({ id: original.id }), /scope|not found/i);
  assert.equal(JSON.parse(f.store.promotedMemory('legacy-work')!.read({ id: a.copy.id, field: 'record' }).text).content, a.copy.content, 'the old immutable archive itself stays unchanged');
});
