import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { HistoryArchive } from '../src/memory/archive.js';
import { memoryTool } from '../src/memory/tools.js';

function fixture(t: import('node:test').TestContext) {
  const root = path.resolve('.tmp/memory-retrieval'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'archive-'));
  let db: DatabaseSync, archive: HistoryArchive;
  const open = () => {
    db = new DatabaseSync(path.join(dir, 'archive.sqlite'));
    db.exec('CREATE TABLE IF NOT EXISTS chat_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,session_id TEXT,record TEXT)');
    archive = new HistoryArchive(db, 'chat');
  };
  open();
  t.after(() => { db.close(); assert.equal(path.dirname(dir), root); rmSync(dir, { recursive: true, force: true }); });
  return {
    get memory() { return archive.scope('session'); }, get db() { return db; },
    restart() { db.close(); open(); },
    add(id: string, content: string, session = 'session', extra = {}) {
      const record = { id, sessionId: session, role: 'user', content, createdAt: '2026-10-01T00:00:00Z', ...extra };
      db.prepare('INSERT INTO chat_messages(id,session_id,record) VALUES(?,?,?)').run(id, session, JSON.stringify(record)); return record;
    },
  };
}

test('old facts beyond previews and tool arguments are searchable; source pages reconstruct exact original', t => {
  const f = fixture(t), content = '前置材料'.repeat(4000) + '航标校验值 QX-2749-Z' + '🧭尾部'.repeat(4000);
  f.add('early', content); f.add('tool', '', 'session', { role: 'assistant', toolCalls: [{ id: 'call', name: 'write_file', arguments: { path: 'rare-ledger.txt', content: 'evidence' } }] });
  f.add('other', '航标校验值 forbidden', 'another-session');
  f.add('query-echo', '', 'session', { role: 'assistant', toolCalls: [{ id: 'search', name: 'search_history', arguments: { query: '航标校验值' } }] });
  f.add('result-echo', '航标校验值', 'session', { role: 'tool', toolCallId: 'search', archiveRecall: true });
  assert.deepEqual(f.memory.search({ query: '航标校验值' }).results.map(hit => hit.id), ['early']);
  assert.match(f.memory.search({ query: '航标校验值' }).results[0]!.excerpt, /航标校验值/);
  assert.equal(f.memory.search({ query: 'rare-ledger' }).results[0]?.id, 'tool');
  let rebuilt = '', offset = 0, sha256 = '';
  do { const page = f.memory.read({ id: 'early', offset, length: 997 }); rebuilt += page.text; sha256 ||= page.sha256; assert.equal(page.sha256, sha256); offset = page.nextOffset ?? -1; } while (offset >= 0);
  assert.equal(rebuilt, content); assert.equal(sha256.length, 64);
  assert.throws(() => f.memory.read({ id: 'other' }), /scope|not found/i);
  assert.throws(() => f.memory.read({ id: 'early', offset: -1 }), /offset/i);
});

test('source-backed topic revisions are idempotent, survive restart, and never silently overwrite a newer decision', t => {
  const f = fixture(t); f.add('a', 'Use blue'); f.add('b', 'Correction: use amber'); f.add('foreign', 'private', 'another-session');
  const first = f.memory.remember({ key: 'appearance', kind: 'decision', text: 'Use blue', sourceIds: ['a'], expectedRevision: 0 }, 'op-a');
  const next = f.memory.remember({ key: 'appearance', kind: 'decision', text: 'Use amber', sourceIds: ['b'], expectedRevision: 1 }, 'op-b');
  assert.equal(first.revision, 1); assert.equal(next.revision, 2);
  f.restart();
  assert.equal(f.memory.remember({ key: 'appearance', kind: 'decision', text: 'Use blue', sourceIds: ['a'], expectedRevision: 0 }, 'op-a').revision, 1);
  assert.throws(() => f.memory.remember({ key: 'appearance', kind: 'decision', text: 'stale', sourceIds: ['a'], expectedRevision: 1 }, 'op-c'), /revision/i);
  assert.throws(() => f.memory.remember({ key: 'foreign', kind: 'fact', text: 'private', sourceIds: ['foreign'], expectedRevision: 0 }, 'op-d'), /scope|not found/i);
  assert.deepEqual(f.memory.notes().notes.map(note => note.text), ['Use amber']);
  assert.equal(f.memory.notes({ key: 'appearance', revisions: true }).notes.length, 2);
  f.db.prepare("UPDATE chat_messages SET record=json_set(record,'$.content','tampered') WHERE id='b'").run();
  assert.equal(f.memory.notes().notes[0]!.sourcesValid, false);
  assert.doesNotMatch(f.memory.context('appearance'), /Use amber/);
});

test('21 working-day cycles retain a rare first-day requirement across window compaction and restart', t => {
  const f = fixture(t); f.add('day-zero', 'The migration exception is retained: ledger QX-2749-Z must use UTF-8 with BOM.');
  f.memory.remember({ key: 'migration-encoding', kind: 'constraint', text: 'QX-2749-Z uses UTF-8 with BOM', sourceIds: ['day-zero'], expectedRevision: 0 }, 'initial');
  for (let day = 1; day <= 21; day++) {
    f.db.exec('BEGIN');
    for (let step = 0; step < 170; step++) f.add(`day-${day}-${step}`, `Day ${day} step ${step}. Current unrelated working detail. ` + 'x'.repeat(200));
    f.db.exec('COMMIT'); f.restart();
    const recalled = f.memory.search({ query: 'QX-2749-Z' });
    assert.equal(recalled.results[0]?.id, 'day-zero');
    assert.match(f.memory.context('migration QX-2749-Z'), /UTF-8 with BOM/);
    assert.match(f.memory.read({ id: 'day-zero' }).text, /UTF-8 with BOM/);
  }
  assert.equal(f.memory.manifest().messages, 3571);
});

test('search pagination uses a stable archive horizon, including short Chinese queries and FTS punctuation', t => {
  const f = fixture(t);
  for (let i = 0; i < 9; i++) f.add(`m-${i}`, `校验 milestone ${i}`);
  const first = f.memory.search({ query: '校验', limit: 4 });
  f.add('new', '校验 late addition');
  const second = f.memory.search({ query: '校验', limit: 4, offset: first.nextOffset!, snapshot: first.snapshot });
  assert.equal(new Set([...first.results, ...second.results].map(hit => hit.id)).size, 8);
  assert.ok(!second.results.some(hit => hit.id === 'new'));
  assert.doesNotThrow(() => f.memory.search({ query: '" OR * ( : )' }));
  assert.equal(f.memory.search({ query: 'unfindable' }).results.length, 0);
});

test('origin archive routing requires an explicit bound source and cannot write through a snapshot', t => {
  const f = fixture(t); f.add('old', 'Original approved design', 'origin');
  const archive = new HistoryArchive(f.db, 'chat'), origin = archive.scope('origin', 1);
  assert.throws(() => memoryTool(f.memory, { name: 'read_history', arguments: { id: 'old', source: 'origin_chat' } }, 'read'), /no readable/);
  const result = JSON.parse(memoryTool(f.memory, { name: 'read_history', arguments: { id: 'old', source: 'origin_chat' } }, 'read', origin)!);
  assert.equal(result.text, 'Original approved design');
  assert.throws(() => memoryTool(f.memory, { name: 'read_history', arguments: { id: 'old' } }, 'wrong-scope', origin), /scope/);
  assert.throws(() => memoryTool(f.memory, { name: 'remember', arguments: { source: 'origin_chat' } }, 'write', origin), /no readable/);
});

test('old chat archives migrate the scope index repeatably and replace a mismatched same-name index', t => {
  const root = path.resolve('.tmp/memory-retrieval'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'migration-'));
  const file = path.join(dir, 'archive.sqlite');
  let db = new DatabaseSync(file);
  t.after(() => { try { db.close(); } catch {} assert.equal(path.dirname(dir), root); rmSync(dir, { recursive: true, force: true }); });
  db.exec('CREATE TABLE chat_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,session_id TEXT,record TEXT)');
  const insert = db.prepare('INSERT INTO chat_messages(id,session_id,record) VALUES(?,?,?)');
  insert.run('m1', 'session', JSON.stringify({ role: 'user', content: 'migrationmarker one' }));
  insert.run('m2', 'session', JSON.stringify({ role: 'user', content: 'migrationmarker two' }));
  insert.run('f1', 'other', JSON.stringify({ role: 'user', content: 'migrationmarker foreign' }));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='history_chat_scope_seq'").get() as { n: number }).n, 0);
  let archive = new HistoryArchive(db, 'chat');
  const created = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='history_chat_scope_seq'").get() as { sql: string };
  assert.match(created.sql, /session_id,\s*seq/i);
  const before = archive.scope('session').search({ query: 'migrationmarker', limit: 20 }).results.map(hit => [hit.id, hit.seq]);
  assert.deepEqual(before, [['m2', 2], ['m1', 1]]);
  db.close();
  db = new DatabaseSync(file);
  archive = new HistoryArchive(db, 'chat');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='history_chat_scope_seq'").get() as { n: number }).n, 1, 'reopening must not duplicate the migration index');
  assert.deepEqual(archive.scope('session').search({ query: 'migrationmarker', limit: 20 }).results.map(hit => [hit.id, hit.seq]), before);
  db.exec('DROP INDEX history_chat_scope_seq; CREATE INDEX history_chat_scope_seq ON chat_messages(record)');
  archive = new HistoryArchive(db, 'chat');
  const repaired = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='history_chat_scope_seq'").get() as { sql: string };
  assert.match(repaired.sql, /session_id,\s*seq/i, 'a stale same-name index must be replaced with the scope index');
  assert.equal(archive.scope('session').search({ query: 'migrationmarker', limit: 20 }).results.length, 2);
  db.exec('DROP INDEX history_chat_scope_seq; CREATE INDEX chat_messages_session ON chat_messages(session_id,seq); CREATE INDEX history_chat_scope_seq ON chat_messages(record)');
  archive = new HistoryArchive(db, 'chat');
  const stale = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='history_chat_scope_seq'").get() as { sql: string } | undefined;
  assert.ok(stale === undefined || /session_id,\s*seq/i.test(stale.sql), 'a wrong same-name index must not survive beside a valid scope index');
  assert.equal(archive.scope('session').search({ query: 'migrationmarker', limit: 20 }).results.length, 2);
});

test('scope index migration failure rolls back schema additions and can be retried', t => {
  const root = path.resolve('.tmp/memory-retrieval'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'atomic-'));
  const db = new DatabaseSync(path.join(dir, 'archive.sqlite'));
  t.after(() => { db.close(); assert.equal(path.dirname(dir), root); rmSync(dir, { recursive: true, force: true }); });
  db.exec("CREATE TABLE chat_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,session_id TEXT,record TEXT); CREATE VIEW history_chat_scope_seq AS SELECT 1 AS occupied");
  assert.throws(() => new HistoryArchive(db, 'chat'), /already/i);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('history_documents','history_fts','memory_notes') ORDER BY name").all(), []);
  db.exec('DROP VIEW history_chat_scope_seq');
  assert.doesNotThrow(() => new HistoryArchive(db, 'chat'));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='history_chat_scope_seq'").get() as { n: number }).n, 1);
});

test('work archives create the scope expression index and keep task/session scopes separate', t => {
  const root = path.resolve('.tmp/memory-retrieval'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'work-'));
  const db = new DatabaseSync(path.join(dir, 'archive.sqlite'));
  t.after(() => { db.close(); assert.equal(path.dirname(dir), root); rmSync(dir, { recursive: true, force: true }); });
  db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,task_id TEXT,session_id TEXT,body TEXT,created_at TEXT)');
  const insert = db.prepare('INSERT INTO messages(id,task_id,session_id,body,created_at) VALUES(?,?,?,?,?)');
  for (let i = 0; i < 4; i++) insert.run('t1-' + i, 't1', 's1', JSON.stringify({ role: 'user', content: 'workmigrationmarker ' + i }), '2026-10-01');
  for (let i = 0; i < 3; i++) insert.run('t2-' + i, 't2', 's2', JSON.stringify({ role: 'user', content: 'workmigrationmarker ' + i }), '2026-10-01');
  const archive = new HistoryArchive(db, 'work');
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='history_scope'").get() as { sql: string };
  assert.match(index.sql, /json_array\(task_id,session_id\)/i);
  const results = archive.scope(JSON.stringify(['t1', 's1'])).search({ query: 'workmigrationmarker', limit: 20 }).results;
  assert.equal(results.length, 4);
  assert.ok(results.every(hit => hit.id.startsWith('t1-')));
});
