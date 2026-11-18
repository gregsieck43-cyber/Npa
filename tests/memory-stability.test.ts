import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { HistoryArchive, type ScopedMemory, type SearchInput } from '../src/memory/archive.js';
import { memoryTool } from '../src/memory/tools.js';

const FIXTURES_ROOT = path.resolve('.tmp/memory-stability/child/fixtures');
const SCHEMA = 'CREATE TABLE IF NOT EXISTS chat_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,record TEXT NOT NULL); CREATE INDEX IF NOT EXISTS chat_messages_session ON chat_messages(session_id,seq);';

/** Archive rows are created through the real schema, including the production scope index. */
interface Fixture {
  readonly dir: string;
  readonly db: DatabaseSync;
  readonly archive: HistoryArchive;
  readonly memory: ScopedMemory;
  add(id: string, content: string, session?: string, extra?: Record<string, unknown>): string;
  restart(): void;
}

function fixture(t: TestContext): Fixture {
  mkdirSync(FIXTURES_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(FIXTURES_ROOT, 'archive-'));
  assert.ok(dir.startsWith(FIXTURES_ROOT + path.sep), 'fixture must be created under the child fixtures root');
  const file = path.join(dir, 'archive.sqlite');
  let db!: DatabaseSync;
  let archive!: HistoryArchive;
  const open = () => {
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    archive = new HistoryArchive(db, 'chat');
  };
  open();
  t.after(() => {
    try { db.close(); } catch {}
    assert.ok(dir.startsWith(FIXTURES_ROOT + path.sep), 'fixture cleanup must stay under the child fixtures root');
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    get db() { return db; },
    get archive() { return archive; },
    get memory() { return archive.scope('session'); },
    add(id, content, session = 'session', extra = {}) {
      const record: Record<string, unknown> = { id, sessionId: session, role: 'user', content, createdAt: '2026-10-01T00:00:00.000Z', ...extra };
      const raw = JSON.stringify(record);
      db.prepare('INSERT INTO chat_messages(id,session_id,record) VALUES(?,?,?)').run(id, session, raw);
      return raw;
    },
    restart() { db.close(); open(); },
  };
}

interface Hit { id: string; seq: number; role: string; createdAt: string; excerpt: string }

type FrozenQuery = SearchInput & { snapshot: number };

/** Read one complete frozen-snapshot sequence page by page and fail on any cursor misbehavior. */
function collect(memory: ScopedMemory, query: FrozenQuery, pageSize: number, startOffset = 0): { ids: string[]; rows: Hit[]; pages: number; finalNextOffset: number | null } {
  const ids: string[] = [], rows: Hit[] = [];
  let offset = startOffset, pages = 0;
  for (;;) {
    const response = memory.search({ ...query, limit: pageSize, offset });
    pages += 1;
    assert.ok(response.results.length <= pageSize, 'page must never exceed the requested limit');
    assert.equal(response.snapshot, query.snapshot, 'every frozen page must report the same snapshot');
    ids.push(...response.results.map(hit => hit.id));
    rows.push(...response.results as Hit[]);
    if (response.nextOffset === null) return { ids, rows, pages, finalNextOffset: null };
    assert.ok(response.nextOffset > offset, 'nextOffset must advance');
    assert.equal(response.nextOffset, offset + pageSize, 'nextOffset is offset+limit only while more rows exist');
    offset = response.nextOffset;
    assert.ok(pages <= 10_000, 'pagination must terminate');
  }
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function pageText(memory: ScopedMemory, id: string, field: 'content' | 'record' | 'toolCalls' | 'attachments', length: number): { text: string; hashes: string[]; pages: number } {
  let offset = 0, text = '', pages = 0;
  const hashes: string[] = [];
  for (;;) {
    const page = memory.read({ id, field, offset, length });
    pages += 1;
    hashes.push(page.sha256);
    text += page.text;
    if (page.nextOffset === null) return { text, hashes, pages };
    assert.ok(page.nextOffset > offset, 'read nextOffset must advance');
    offset = page.nextOffset;
    assert.ok(pages <= 10_000, 'read pagination must terminate');
  }
}

test('a frozen FTS horizon keeps page order after foreign appends and after restart', t => {
  const f = fixture(t);
  f.add('m1', 'memorywirealpha memorywirealpha', 'original');
  f.add('m2', 'memorywirebeta memorywirebeta', 'original');
  f.add('m3', 'memorywirealpha', 'original');
  f.add('m4', 'memorywirebeta', 'original');
  for (let i = 0; i < 20; i++) f.add('f' + i, 'unrelated neutral padding', 'original');
  const memory = f.archive.scope('original');
  const query = { query: 'memorywirealpha memorywirebeta', mode: 'any' as const };

  const first = memory.search({ ...query, limit: 2 });
  assert.equal(first.snapshot, 24);
  assert.equal(first.nextOffset, 2);
  const expected = collect(memory, { ...query, snapshot: first.snapshot }, 20).ids;
  assert.equal(new Set(expected).size, 4);
  assert.deepEqual(first.results.map(hit => hit.id), expected.slice(0, 2), 'page one must be a prefix of the frozen sequence');

  for (let i = 0; i < 30; i++) f.add('new' + i, 'memorywirebeta memorywirebeta', 'another-conversation');
  assert.equal(memory.manifest().snapshot, 24, 'foreign appends must not advance the original scope horizon');

  const second = memory.search({ ...query, limit: 2, offset: first.nextOffset!, snapshot: first.snapshot });
  const continued = collect(memory, { ...query, snapshot: first.snapshot }, 2, first.nextOffset!);
  const combined = [...first.results.map(hit => hit.id), ...continued.ids];
  assert.deepEqual(combined, expected, 'a frozen source horizon must preserve pagination order after foreign writes');
  assert.equal(new Set(combined).size, expected.length);
  assert.ok(combined.every(id => expected.includes(id)), 'frozen pages must contain only in-scope ids from the recorded sequence');
  assert.deepEqual(second.results.map(hit => hit.id), expected.slice(2), 'the next frozen page must not duplicate or omit a hit');
  assert.equal(second.nextOffset, null);
  assert.equal(continued.finalNextOffset, null, 'the frozen sequence must terminate with nextOffset null');
  for (const hit of [...first.results, ...second.results, ...continued.rows]) assert.ok(hit.seq <= first.snapshot, 'no hit may come from beyond the frozen snapshot');
  assert.equal(continued.ids[0], expected[2]);

  f.restart();
  const reopened = f.archive.scope('original');
  const againFirst = reopened.search({ ...query, limit: 2 });
  assert.equal(againFirst.snapshot, first.snapshot, 'restart must not move the frozen snapshot');
  const again = collect(reopened, { ...query, snapshot: first.snapshot }, 2);
  assert.deepEqual(again.ids, expected, 'the same frozen pagination must be identical after a database restart');
});

test('same-scope appends after a frozen snapshot are excluded and do not shift frozen pages', t => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) f.add('scope-' + i, 'scopeappendmarker record', 'session');
  const memory = f.memory;
  const first = memory.search({ query: 'scopeappendmarker', limit: 2 });
  const snapshot = first.snapshot;
  const expected = collect(memory, { query: 'scopeappendmarker', snapshot }, 20).ids;
  for (let i = 0; i < 4; i++) f.add('scope-new-' + i, 'scopeappendmarker late record', 'session');
  const frozen = collect(memory, { query: 'scopeappendmarker', snapshot }, 2);
  assert.deepEqual(frozen.ids, expected);
  assert.equal(frozen.finalNextOffset, null);
  assert.ok(!frozen.ids.some(id => id.startsWith('scope-new-')));
  for (const hit of frozen.rows) assert.ok(hit.seq <= snapshot);
  const fresh = memory.search({ query: 'scopeappendmarker', limit: 20 });
  assert.ok(fresh.results.some(hit => hit.id === 'scope-new-0'), 'a fresh search without a snapshot must see post-snapshot same-scope writes');
  assert.equal(fresh.results.length, expected.length + 4);
});

test('large interleaved foreign writes neither leak nor reorder a frozen page set', t => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) f.add('cross-' + i, 'crossscopemarker ' + 'y'.repeat(i * 40), 'session');
  const memory = f.memory;
  const first = memory.search({ query: 'crossscopemarker', limit: 2 });
  const snapshot = first.snapshot;
  const expected = collect(memory, { query: 'crossscopemarker', snapshot }, 20).ids;
  for (let i = 0; i < 100; i++) f.add('foreign-' + i, 'crossscopemarker foreign padding ' + i + ' ' + 'z'.repeat(i % 17), 'another-conversation');
  const mid = memory.search({ query: 'crossscopemarker', limit: 2, offset: first.nextOffset!, snapshot });
  assert.deepEqual(mid.results.map(hit => hit.id), expected.slice(2, 4), 'foreign writes between pages must not reorder the remaining frozen page');
  for (let i = 100; i < 200; i++) f.add('foreign-' + i, 'crossscopemarker foreign padding ' + i + ' ' + 'z'.repeat(i % 17), 'another-conversation');
  const frozen = collect(memory, { query: 'crossscopemarker', snapshot }, 2);
  assert.deepEqual(frozen.ids, expected);
  assert.equal(frozen.finalNextOffset, null);
  assert.equal(new Set(frozen.ids).size, expected.length);
  assert.ok(!frozen.ids.some(id => id.startsWith('foreign-')));
  for (const hit of frozen.rows) assert.ok(hit.seq <= snapshot);
});

test('identical content and timestamps still page deterministically through restart', t => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++) f.add('tie-' + i, 'identicaltiecontent', 'session', { createdAt: '2026-01-01T00:00:00.000Z' });
  const unpaged = f.memory.search({ query: 'identicaltiecontent', limit: 20 });
  const expected = unpaged.results.map(hit => hit.id);
  assert.equal(expected.length, 7);
  assert.equal(unpaged.nextOffset, null);
  const paged = collect(f.memory, { query: 'identicaltiecontent', snapshot: unpaged.snapshot }, 2);
  assert.deepEqual(paged.ids, expected);
  assert.equal(new Set(paged.ids).size, expected.length);
  f.restart();
  const afterRestart = collect(f.memory, { query: 'identicaltiecontent', snapshot: unpaged.snapshot }, 3);
  assert.deepEqual(afterRestart.ids, expected);
});

test('search and read reject invalid inputs at the public boundary', t => {
  const f = fixture(t);
  f.add('valid-1', 'validationmarker one');
  f.add('valid-2', 'validationmarker two');
  f.add('other-scope', 'validationmarker private', 'another-session');
  const memory = f.memory;
  const search = (input: unknown) => memory.search(input as SearchInput);
  assert.throws(() => search({}), /query/i);
  assert.throws(() => search({ query: '' }), /query/i);
  assert.throws(() => search({ query: '   ' }), /query/i);
  assert.throws(() => search({ query: 'q'.repeat(401) }), /query/i);
  for (const limit of [0, 21, 1.5, Number.NaN]) assert.throws(() => search({ query: 'validationmarker', limit }), /limit/i);
  for (const offset of [-1, 1.5]) assert.throws(() => search({ query: 'validationmarker', offset }), /offset/i);
  for (const snapshot of [-1, 1.5]) assert.throws(() => search({ query: 'validationmarker', snapshot }), /snapshot/i);
  assert.throws(() => search({ query: 'validationmarker', mode: 'invalid' }), /mode/i);

  assert.equal(search({ query: 'validationmarker', limit: 1 }).results.length, 1);
  assert.equal(search({ query: 'validationmarker', limit: 20 }).results.length, 2);
  const atEnd = search({ query: 'validationmarker', limit: 2, offset: 2 });
  assert.deepEqual(atEnd.results, []);
  assert.equal(atEnd.nextOffset, null);
  const afterEnd = search({ query: 'validationmarker', limit: 2, offset: 999 });
  assert.deepEqual(afterEnd.results, []);
  assert.equal(afterEnd.nextOffset, null);

  assert.throws(() => memory.read({ id: 'valid-1', field: 'body' as never }), /field/i);
  assert.throws(() => memory.read({ id: 'other-scope' }), /not found/i);
  for (const offset of [-1, 1.5]) assert.throws(() => memory.read({ id: 'valid-1', offset }), /offset/i);
  for (const length of [0, 12001, 1.5]) assert.throws(() => memory.read({ id: 'valid-1', length }), /length/i);
});

test('FTS, short Chinese substring fallback, phrase mode and literal punctuation stay usable', t => {
  const f = fixture(t);
  f.add('fts-cjk', '航标校验值 QX-2749-Z 约束');
  f.add('short-cn', '校验里程碑');
  f.add('short-cn-2', '校验 milestone');
  f.add('punct-star', 'literal alpha*beta term');
  f.add('punct-dash', 'literal alpha-beta term');
  f.add('punct-paren', 'literal (colon) : term');
  f.add('phrase-yes', 'the exact contiguous alpha beta sequence');
  f.add('phrase-no', 'beta separated from alpha');
  const memory = f.memory;

  const cjk = memory.search({ query: '航标校验值' });
  const cjkHit = cjk.results.find(hit => hit.id === 'fts-cjk');
  assert.ok(cjkHit);
  assert.match(cjkHit.excerpt, /航标校验值/);

  const short = memory.search({ query: '校验', limit: 20 });
  const shortIds = short.results.map(hit => hit.id);
  assert.ok(shortIds.includes('short-cn'));
  assert.ok(shortIds.includes('short-cn-2'));
  assert.ok(short.results.every(hit => hit.excerpt.includes('校验')), 'short-term excerpts must contain the matched term');

  const operators = memory.search({ query: '" OR * ( : )' });
  assert.ok(Array.isArray(operators.results));
  assert.ok(!operators.results.some(hit => ['fts-cjk', 'short-cn', 'short-cn-2'].includes(hit.id)));

  assert.ok(memory.search({ query: 'alpha*beta' }).results.some(hit => hit.id === 'punct-star'));
  assert.ok(memory.search({ query: 'alpha-beta' }).results.some(hit => hit.id === 'punct-dash'));
  assert.ok(memory.search({ query: '(colon)' }).results.some(hit => hit.id === 'punct-paren'));
  assert.doesNotThrow(() => memory.search({ query: 'alpha"beta' }));

  const phrase = memory.search({ query: 'alpha beta', mode: 'phrase', limit: 20 }).results.map(hit => hit.id);
  assert.ok(phrase.includes('phrase-yes'));
  assert.ok(!phrase.includes('phrase-no'));
  const any = memory.search({ query: 'alpha beta', mode: 'any', limit: 20 }).results.map(hit => hit.id);
  assert.ok(any.includes('phrase-yes'));
  assert.ok(any.includes('phrase-no'));
});

test('original record pages reassemble exactly and every page reports the record SHA-256', t => {
  const f = fixture(t);
  const content = 'pageable原始内容 ' + 'P'.repeat(450) + ' 航标 QX-2749-Z 结束';
  const toolCalls = [{ id: 'call-1', name: 'write_file', arguments: { path: 'output.txt', content: 'kept' } }];
  const attachments = [{ id: 'att-1', name: 'diagram.png', bytes: 12 }];
  const raw = f.add('source-page', content, 'session', { role: 'assistant', toolCalls, attachments });
  const expectedHash = sha256(raw);
  const memory = f.memory;

  const record = pageText(memory, 'source-page', 'record', 97);
  assert.equal(record.text, raw);
  assert.equal(record.pages > 1, true);
  assert.ok(record.hashes.every(value => value === expectedHash));

  const contentField = pageText(memory, 'source-page', 'content', 89);
  assert.equal(contentField.text, content);
  const toolField = pageText(memory, 'source-page', 'toolCalls', 71);
  assert.deepEqual(JSON.parse(toolField.text), toolCalls);
  const attachmentField = pageText(memory, 'source-page', 'attachments', 53);
  assert.deepEqual(JSON.parse(attachmentField.text), attachments);

  f.add('foreign-source', 'private', 'another-session');
  assert.throws(() => memory.read({ id: 'foreign-source' }), /not found/i);
});

test('archiveRecall and pure recall-tool echoes never pollute search while side-effect tool arguments do', t => {
  const f = fixture(t);
  f.add('hidden-recall', 'exclusionmarker hidden raw recall', 'session', { archiveRecall: true, role: 'tool' });
  f.add('hidden-tools', '', 'session', { role: 'assistant', toolCalls: [
    { id: 'c1', name: 'search_history', arguments: { query: 'exclusionmarker' } },
    { id: 'c2', name: 'read_history', arguments: { id: 'x' } },
  ] });
  f.add('hidden-tools-2', '', 'session', { role: 'assistant', toolCalls: [
    { id: 'c3', name: 'recall_memory', arguments: {} },
    { id: 'c4', name: 'remember', arguments: { key: 'k' } },
  ] });
  f.add('visible-write', '', 'session', { role: 'assistant', toolCalls: [{ id: 'c5', name: 'write_file', arguments: { path: 'exclusionmarker-ledger.txt', content: 'evidence' } }] });
  f.add('visible-normal', 'exclusionmarker visible', 'session');
  const ids = f.memory.search({ query: 'exclusionmarker', limit: 20 }).results.map(hit => hit.id);
  assert.deepEqual(new Set(ids), new Set(['visible-write', 'visible-normal']));
});

test('source-backed notes keep revisions across restart, detect tampering and forbid snapshot writes', t => {
  const f = fixture(t);
  f.add('note-a', 'blue preference source one');
  f.add('note-b', 'amber correction source two');
  const first = f.memory.remember({ key: 'appearance', kind: 'decision', text: 'NOTE-BLUE-1', sourceIds: ['note-a'], expectedRevision: 0 }, 'op-note-1');
  const second = f.memory.remember({ key: 'appearance', kind: 'decision', text: 'NOTE-AMBER-2', sourceIds: ['note-b'], expectedRevision: 1 }, 'op-note-2');
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.deepEqual(f.memory.notes().notes.map(note => note.text), ['NOTE-AMBER-2']);
  assert.deepEqual(f.memory.notes({ revisions: true }).notes.map(note => note.revision), [2, 1]);
  assert.match(f.memory.context('appearance'), /NOTE-AMBER-2/);

  f.restart();
  const replayed = f.memory.remember({ key: 'appearance', kind: 'decision', text: 'NOTE-BLUE-1', sourceIds: ['note-a'], expectedRevision: 0 }, 'op-note-1');
  assert.equal(replayed.revision, 1);
  assert.equal(replayed.id, first.id);
  assert.throws(() => f.memory.remember({ key: 'appearance', kind: 'decision', text: 'stale', sourceIds: ['note-a'], expectedRevision: 1 }, 'op-note-3'), /revision/i);

  f.db.prepare("UPDATE chat_messages SET record=json_set(record,'$.content','tampered source') WHERE id='note-b'").run();
  const latest = f.memory.notes({ key: 'appearance' }).notes;
  assert.equal(latest.length, 1);
  assert.equal(latest[0]!.revision, 2);
  assert.equal(latest[0]!.sourcesValid, false);
  assert.doesNotMatch(f.memory.context('appearance'), /NOTE-AMBER-2/);

  const historical = f.archive.scope('session', 1);
  assert.throws(() => historical.remember({ key: 'snap', kind: 'fact', text: 'no', sourceIds: ['note-a'], expectedRevision: 0 }, 'op-snap'), /historical|read-only/i);
  assert.throws(() => historical.notes(), /historical|snapshot/i);
});

test('origin_chat routing works only through an explicitly bound origin snapshot', t => {
  const f = fixture(t);
  f.add('origin-a', 'ORIGINROUTER unique origin design', 'origin');
  f.add('session-a', 'ORIGINROUTER current session note', 'session');
  const origin = f.archive.scope('origin');
  const call = (name: string, args: Record<string, unknown>) => memoryTool(f.memory, { name, arguments: args }, 'op', origin);
  assert.throws(() => memoryTool(f.memory, { name: 'read_history', arguments: { id: 'origin-a', source: 'origin_chat' } }, 'op'), /no readable/i);
  assert.throws(() => memoryTool(f.memory, { name: 'search_history', arguments: { query: 'ORIGINROUTER', source: 'origin_chat' } }, 'op'), /no readable/i);

  const searched = JSON.parse(call('search_history', { query: 'ORIGINROUTER', source: 'origin_chat' })!) as { results: { id: string }[] };
  assert.ok(searched.results.some(hit => hit.id === 'origin-a'));
  const read = JSON.parse(call('read_history', { id: 'origin-a', source: 'origin_chat' })!) as { text: string };
  assert.equal(read.text, 'ORIGINROUTER unique origin design');
  assert.throws(() => call('read_history', { id: 'origin-a' }), /not found/i);
  assert.throws(() => call('remember', { source: 'origin_chat', key: 'k', kind: 'fact', text: 'x', sourceIds: ['origin-a'], expectedRevision: 0 }), /no readable/i);
  assert.throws(() => call('search_history', { query: 'x', source: 'elsewhere' }), /unknown memory source/i);
  const current = JSON.parse(call('search_history', { query: 'ORIGINROUTER', source: 'current' })!) as { results: { id: string }[] };
  assert.ok(current.results.some(hit => hit.id === 'session-a'));
});

test('search metadata exposes snapshot, ordering and exact nextOffset arithmetic', t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) f.add('meta-' + i, 'metadata-marker record');
  const memory = f.memory;
  const first = memory.search({ query: 'metadata-marker', limit: 2 });
  assert.equal(first.snapshot, 5);
  assert.equal((first as { ordering?: string }).ordering, 'archive-seq-desc');
  assert.ok(first.results.length <= 2);
  assert.equal(first.nextOffset, 2);
  const second = memory.search({ query: 'metadata-marker', limit: 2, offset: first.nextOffset });
  assert.equal(second.snapshot, first.snapshot);
  assert.equal(second.nextOffset, 4);
  const third = memory.search({ query: 'metadata-marker', limit: 2, offset: second.nextOffset });
  assert.equal(third.results.length, 1);
  assert.equal(third.nextOffset, null);
  const frozen = memory.search({ query: 'metadata-marker', limit: 2, snapshot: 3 });
  assert.equal(frozen.snapshot, 3);
  assert.deepEqual(frozen.results.map(hit => hit.id), ['meta-2', 'meta-1']);
  assert.equal(memory.manifest().snapshot, 5);
});
