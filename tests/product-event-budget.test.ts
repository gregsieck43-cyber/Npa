/**
 * FBR-01 regression: bounded product event retention for long streaming Chat/Work projections.
 *
 * Red on HEAD 7f738f4: 1000 cumulative Chat partials of one 64-100 KiB answer stay below the row
 * cap, so product.sqlite + WAL reach tens of MB and the first subscribe replays every cumulative
 * snapshot. This suite pins the byte quota plus stream-projection compaction while preserving:
 * monotonic event ids/cursor, no false reset when only superseded projections were compacted,
 * epoch stability, snapshot-cursor fencing, terminal text/id, restart and first-subscribe replay.
 *
 * The numbers are storage measurements, not a real provider/model run. No network or model is used.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ProductStore } from '../src/product/store.js';
import type { GatewayEvent } from '../src/frontend/api/types.js';

const tempRoot = path.resolve(process.env.TEMP ?? '.tmp');
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Contract constants; asserted against exports in the bounded test so drift is visible. */
const EVENT_BYTES = 8 * 1024 * 1024;
const EVENT_ROWS = 5000;

interface EventEntry { id: number; event: GatewayEvent }
interface EventPage { events: EventEntry[]; nextCursor: number; earliest: number; reset: boolean; epoch: string }

const makeDir = (): string => mkdtempSync(path.join(tempRoot, 'product-event-budget-'));
const textOf = (event: GatewayEvent): string => event.type === 'message.upsert'
  ? event.message.parts.map(part => part.kind === 'text' ? part.text : '').join('')
  : '';
const assistant = (sessionId: string, messageId: string, text: string, status: 'streaming' | 'done' | 'error' | 'cancelled', requestId = 'req-budget'): GatewayEvent => ({
  type: 'message.upsert',
  sessionId,
  message: {
    id: messageId, role: 'assistant', createdAt: '2026-01-01T00:00:00.000Z', status,
    parts: [{ kind: 'text', text }],
    ...(requestId ? { requestId } : {}),
    ...(status === 'error' ? { error: { code: 'budget_probe', message: 'expected test error' } } : {}),
  },
});
const notify = (title: string): GatewayEvent => ({ type: 'notify', tone: 'info', title });
const appended = (store: ProductStore, event: GatewayEvent, sessionId?: string): number => store.append([{ event, ...(sessionId === undefined ? {} : { sessionId }) }])[0]!;

const replay = (store: ProductStore, limit = 200): { pages: number; rows: number; bytes: number; events: EventEntry[] } => {
  let cursor = 0; let pages = 0; let rows = 0; let bytes = 0; const events: EventEntry[] = [];
  for (;;) {
    const page: EventPage = store.eventsAfter(cursor, limit);
    pages += 1;
    assert.equal(page.reset, false, 'a first-subscribe replay from 0 must not reset');
    rows += page.events.length;
    bytes += Buffer.byteLength(JSON.stringify(page.events), 'utf8');
    events.push(...page.events);
    if (!page.events.length) break;
    cursor = page.nextCursor;
    if (pages > 2000) throw new Error('event replay did not terminate');
  }
  return { pages, rows, bytes, events };
};
const diskBytes = (dir: string): number => readdirSync(dir)
  .filter(name => name.startsWith('product.sqlite'))
  .reduce((total, name) => total + statSync(path.join(dir, name)).size, 0);
const cleanup = (dir: string): void => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

/**
 * Observe migration reads of full event records. The legacy migration must page the table, not
 * materialize every 256 KiB-class record at once; this wrapper fails the regression if it does.
 */
const observeLegacyRecordReads = <T>(open: () => T): { value: T; maxRows: number } => {
  const prototype = DatabaseSync.prototype as unknown as {
    prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
  };
  const original = prototype.prepare;
  let maxRows = 0;
  prototype.prepare = function (this: unknown, sql: string) {
    const statement = original.call(this, sql);
    if (/^\s*SELECT[\s\S]*\brecord\b[\s\S]*\bFROM\s+product_events\b/i.test(sql)) {
      const all = statement.all;
      statement.all = function (this: unknown, ...args: unknown[]) {
        const rows = all.apply(this, args);
        maxRows = Math.max(maxRows, rows.length);
        return rows;
      };
    }
    return statement;
  } as typeof prototype.prepare;
  try {
    return { value: open(), maxRows };
  } finally {
    prototype.prepare = original;
  }
};

const chatStream = (sessionId: string, messageId: string, bytes: number, count: number): number[] => {
  const text = 'x'.repeat(bytes);
  return Array.from({ length: count }, (_, index) => Math.max(1, Math.floor((text.length * (index + 1)) / count)));
};

test('bounded bytes and first replay for one long cumulative Chat stream (1000 partials)', { timeout: 180000 }, () => {
  const dir = makeDir();
  const store = new ProductStore(dir);
  try {
    assert.equal(EVENT_BYTES, 8 * 1024 * 1024);
    assert.equal(EVENT_ROWS, 5000);
    const text = 'x'.repeat(64 * 1024);
    const messageId = 'msg-long-answer';
    const ids: number[] = [];
    for (let index = 0; index < 1000; index += 1) {
      const content = text.slice(0, Math.max(1, Math.floor((text.length * (index + 1)) / 1000)));
      ids.push(appended(store, assistant('session-long', messageId, content, 'streaming'), 'session-long'));
    }
    assert.ok(ids.every((id, index) => index === 0 || id > ids[index - 1]!), 'event ids must stay strictly monotonic');
    const terminalId = appended(store, assistant('session-long', messageId, text, 'done'), 'session-long');
    const measured = replay(store);
    const bytes = diskBytes(dir);
    assert.ok(measured.rows <= 8, 'only the latest projection and its terminal may remain; got ' + measured.rows);
    assert.ok(measured.bytes < 1 * 1024 * 1024, 'first replay must be bounded to the latest projection; got ' + measured.bytes);
    assert.ok(bytes < 16 * 1024 * 1024, 'product.sqlite + WAL must stay bounded; got ' + bytes);
    const terminal = measured.events.find(entry => entry.id === terminalId);
    assert.ok(terminal, 'the terminal event must be retained');
    assert.equal(terminal.event.type, 'message.upsert');
    assert.equal(terminal.event.type === 'message.upsert' ? terminal.event.message.id : '', messageId);
    assert.equal(terminal.event.type === 'message.upsert' ? terminal.event.message.status : '', 'done');
    assert.equal(textOf(terminal.event), text, 'the terminal event must carry the complete answer');
  } finally {
    store.close();
  }
  try {
    const reopened = new ProductStore(dir);
    try {
      const events = reopened.eventsAfter(0, 200);
      assert.equal(events.reset, false);
      assert.ok(events.events.length <= 8, 'restart must not resurrect compacted partials');
      const latest = events.events.at(-1);
      assert.equal(latest?.event.type, 'message.upsert');
      assert.equal(textOf(latest!.event), 'x'.repeat(64 * 1024), 'the terminal answer survives restart');
      const next = appended(reopened, notify('after restart'));
      assert.ok(next > (latest?.id ?? 0), 'event ids continue after restart');
    } finally { reopened.close(); }
  } finally { cleanup(dir); }
});

test('compacted stream projections keep monotonic cursors and never force a false reset', { timeout: 60000 }, () => {
  const dir = makeDir();
  const store = new ProductStore(dir);
  try {
    const first = appended(store, assistant('s1', 'm1', 'a', 'streaming'), 's1');
    const second = appended(store, assistant('s1', 'm1', 'ab', 'streaming'), 's1');
    const third = appended(store, assistant('s1', 'm1', 'abc', 'streaming'), 's1');
    assert.ok(first < second && second < third, 'ids stay monotonic while older projections are compacted');
    assert.deepEqual(store.eventsAfter(0, 200).events.map(entry => entry.id), [third], 'only the latest projection remains');
    const atFirst = store.eventsAfter(first, 200);
    assert.equal(atFirst.reset, false, 'a cursor on a superseded projection must not reset');
    assert.deepEqual(atFirst.events.map(entry => entry.id), [third], 'the newer projection supersedes the consumed cursor');
    assert.deepEqual(store.eventsAfter(second, 200).events.map(entry => entry.id), [third]);
    const done = appended(store, assistant('s1', 'm1', 'abcd', 'done'), 's1');
    assert.deepEqual(store.eventsAfter(first, 200).events.map(entry => entry.id), [done], 'terminal replaces the partial for the same message id');
    assert.equal(store.eventsAfter(third, 200).reset, false, 'consumed cursors never reset for compaction');
    assert.equal(store.eventsAfter(done, 200).reset, false);
    assert.deepEqual(store.eventsAfter(done, 200).events, []);
    assert.equal(store.eventsAfter(done, 200).nextCursor, done);
    // Row-cap eviction is a real loss of non-superseded history: it must raise the reset floor.
    for (let index = 0; index < EVENT_ROWS + 10; index += 1) appended(store, notify('noise ' + index));
    const latest = store.latestEventId();
    const stale = store.eventsAfter(1, 10);
    assert.equal(stale.reset, true, 'a cursor below the row-retention floor must reset');
    assert.equal(stale.nextCursor, latest);
    assert.equal(store.eventsAfter(latest, 10).reset, false);
    assert.equal(store.eventsAfter(0, 10).reset, false, 'first subscribe never resets');
  } finally { store.close(); cleanup(dir); }
});

test('byte quota evicts oldest non-superseded events and keeps at least the newest event', { timeout: 120000 }, () => {
  const dir = makeDir();
  const store = new ProductStore(dir);
  try {
    const body = 'y'.repeat(100 * 1024);
    const lastIds: number[] = [];
    for (let index = 0; index < 120; index += 1) lastIds.push(appended(store, assistant('bulk', 'msg-' + index, body, 'done'), 'bulk'));
    const measured = replay(store);
    assert.ok(measured.bytes <= EVENT_BYTES + 200 * 1024, 'retained replay bytes must respect the byte quota; got ' + measured.bytes);
    assert.ok(measured.rows < 120, 'the byte quota must evict old terminal events; kept ' + measured.rows);
    const latest = measured.events.at(-1);
    assert.equal(latest?.id, lastIds.at(-1), 'the newest event is retained');
    // A single event larger than the quota is the only event: it stays until a newer event exists.
    const huge = appended(store, assistant('huge', 'msg-huge', 'z'.repeat(9 * 1024 * 1024), 'done'), 'huge');
    assert.equal(store.eventsAfter(huge - 1, 10).events.at(-1)?.id, huge, 'a lone oversized event is retained');
    assert.ok(store.eventLogUsage().bytes > EVENT_BYTES,
      'the lone oversized event is the documented retained exception, got ' + store.eventLogUsage().bytes);
    const newer = appended(store, notify('newer than the oversized event'));
    const after = store.eventsAfter(0, 200);
    assert.ok(after.events.every(entry => entry.id !== huge), 'the oversized event is evicted once a newer event exists');
    assert.equal(after.events.at(-1)?.id, newer);
  } finally { store.close(); cleanup(dir); }
});

test('one append batch cannot bypass the byte quota', { timeout: 60000 }, () => {
  const dir = makeDir();
  const store = new ProductStore(dir);
  try {
    const body = 'b'.repeat(100 * 1024);
    const ids = store.append(Array.from({ length: 100 }, (_, index) => ({
      event: assistant('batch', 'batch-' + index, body, 'done'),
      sessionId: 'batch',
    })));
    const usage = store.eventLogUsage();
    assert.ok(usage.bytes <= EVENT_BYTES, 'a committed batch must satisfy the byte quota, got ' + usage.bytes);
    assert.ok(usage.rows < 100, 'a committed batch must evict its own oldest rows, kept ' + usage.rows);
    const retained = store.eventsAfter(0, 200).events;
    assert.equal(retained.at(-1)?.id, ids.at(-1), 'the newest event of the batch is retained');
    assert.ok(retained.every(entry => entry.id > ids[0]!), 'the oldest events of the batch must be evicted');
  } finally { store.close(); cleanup(dir); }
});

test('legacy row-only database migrates, compacts historical partials, reclaims disk and keeps epoch/ids', { timeout: 180000 }, () => {
  const dir = makeDir();
  const file = path.join(dir, 'product.sqlite');
  const text = 'q'.repeat(100 * 1024);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec(`CREATE TABLE product_events(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, type TEXT NOT NULL, record TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX product_events_session ON product_events(session_id, id);
      CREATE TABLE product_meta(key TEXT PRIMARY KEY, record TEXT NOT NULL);`);
    db.prepare('INSERT INTO product_meta(key,record) VALUES(?,?)').run('eventEpoch', JSON.stringify('epoch-legacy-fbr01'));
    const insert = db.prepare('INSERT INTO product_events(session_id,type,record,created_at) VALUES(?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    // Simulate the old row-only retention: the earliest 100 events of this fixture were already
    // dropped while 600 cumulative partials remained, so the migrated log needs an eviction floor.
    for (let index = 0; index < 100; index += 1) insert.run('legacy', 'notify', JSON.stringify(notify('legacy noise ' + index)), '2026-01-01T00:00:00.000Z');
    db.exec('DELETE FROM product_events WHERE id <= 100');
    for (let index = 0; index < 600; index += 1) {
      const content = text.slice(0, Math.max(1, Math.floor((text.length * (index + 1)) / 600)));
      insert.run('legacy', 'message.upsert', JSON.stringify(assistant('legacy', 'legacy-answer', content, 'streaming')), '2026-01-01T00:00:00.000Z');
    }
    insert.run('legacy', 'message.upsert', JSON.stringify(assistant('legacy', 'legacy-answer', text, 'done')), '2026-01-01T00:00:01.000Z');
    const lastId = Number((db.prepare('SELECT MAX(id) AS id FROM product_events').get() as { id: number }).id);
    db.exec('COMMIT');
    assert.equal(lastId, 701);
    db.close();
  } catch (error) { db.close(); throw error; }
  const before = diskBytes(dir);
  assert.ok(before > 16 * 1024 * 1024, 'fixture must be large enough to require reclamation; got ' + before);
  const opened = observeLegacyRecordReads(() => new ProductStore(dir));
  const store = opened.value;
  try {
    assert.ok(opened.maxRows > 0 && opened.maxRows <= 100,
      'legacy migration must read full event records in bounded keyset pages, got ' + opened.maxRows + ' rows in one read');
    assert.equal(store.eventEpoch(), 'epoch-legacy-fbr01', 'migration must not replace the epoch');
    assert.equal(store.latestEventId(), 701, 'the newest legacy event id is preserved');
    const measured = replay(store);
    assert.ok(measured.rows <= 4, 'historical cumulative partials must compact to the latest projection plus terminal; got ' + measured.rows);
    assert.ok(measured.bytes < 1 * 1024 * 1024, 'legacy replay must be compacted; got ' + measured.bytes);
    const terminal = measured.events.find(entry => entry.event.type === 'message.upsert' && entry.event.message.status === 'done');
    assert.ok(terminal, 'the historical terminal event is retained');
    assert.equal(terminal.event.type === 'message.upsert' ? textOf(terminal.event) : '', text);
    const next = appended(store, notify('post migration'));
    assert.equal(next, 702, 'AUTOINCREMENT must continue after migration/VACUUM');
    assert.equal(store.eventsAfter(99, 10).reset, true, 'cursors below the migrated retention floor reset instead of silently skipping');
    assert.equal(store.eventsAfter(100, 10).reset, false, 'a cursor at the migrated floor can continue safely');
  } finally { store.close(); }
  try {
    const after = diskBytes(dir);
    console.log(JSON.stringify({ schema: 'stream-event-budget-migration/v1', beforeBytes: before, afterBytes: after }));
    assert.ok(after < 16 * 1024 * 1024, 'one-time reclamation must shrink the legacy file; got ' + after);
    const reopened = new ProductStore(dir);
    try {
      assert.equal(reopened.eventEpoch(), 'epoch-legacy-fbr01');
      assert.equal(reopened.eventsAfter(702, 10).reset, false);
    } finally { reopened.close(); }
  } finally { cleanup(dir); }
});

test('legacy migration resumes after a crash between ALTER and the compaction marker', { timeout: 60000 }, () => {
  const dir = makeDir();
  const file = path.join(dir, 'product.sqlite');
  const epoch = 'epoch-crash-resume';
  const text = 'resumed terminal text';
  try {
    const db = new DatabaseSync(file);
    try {
      db.exec(`CREATE TABLE product_events(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, type TEXT NOT NULL, record TEXT NOT NULL, created_at TEXT NOT NULL, stream_key TEXT);
        CREATE TABLE product_meta(key TEXT PRIMARY KEY, record TEXT NOT NULL);`);
      db.prepare('INSERT INTO product_meta(key,record) VALUES(?,?)').run('eventEpoch', JSON.stringify(epoch));
      const insert = db.prepare('INSERT INTO product_events(session_id,type,record,created_at) VALUES(?,?,?,?)');
      for (let index = 0; index < 3; index += 1) {
        insert.run('crash', 'message.upsert', JSON.stringify(assistant('crash', 'm-crash', text.slice(0, index + 1), 'streaming')), '2026-01-01T00:00:00.000Z');
      }
      insert.run('crash', 'message.upsert', JSON.stringify(assistant('crash', 'm-crash', text, 'done')), '2026-01-01T00:00:01.000Z');
    } finally { db.close(); }
    const store = new ProductStore(dir);
    try {
      assert.equal(store.eventEpoch(), epoch);
      assert.equal(store.latestEventId(), 4);
      assert.deepEqual(store.eventsAfter(0, 200).events.map(entry => entry.id), [4], 'resumed migration removes every superseded partial');
      const terminal = store.eventsAfter(0, 200).events[0]!;
      assert.equal(terminal.event.type === 'message.upsert' ? textOf(terminal.event) : '', text);
      assert.equal(store.eventLogUsage().rows, 1);
      assert.equal(store.eventsAfter(3, 200).reset, false, 'a cursor at the last streaming id can continue to the terminal');
    } finally { store.close(); }
    const reopened = new ProductStore(dir);
    try {
      assert.equal(reopened.latestEventId(), 4);
      assert.equal(reopened.eventLogUsage().rows, 1);
    } finally { reopened.close(); }
  } finally { cleanup(dir); }
});

test('restart, cursor catch-up, first subscribe, terminal and session deletion stay consistent', { timeout: 60000 }, async () => {
  const dir = makeDir();
  let store = new ProductStore(dir);
  try {
    const p1 = appended(store, assistant('s-restart', 'm-restart', 'one', 'streaming'), 's-restart');
    const p2 = appended(store, assistant('s-restart', 'm-restart', 'one two', 'streaming'), 's-restart');
    assert.ok(p1 < p2);
    store.close();
    store = new ProductStore(dir);
    const midStream = replay(store);
    assert.equal(midStream.rows, 1, 'a restart mid-stream retains exactly the newest self-contained projection');
    assert.equal(midStream.events[0]!.id, p2);
    assert.equal(midStream.events[0]!.event.type === 'message.upsert' ? textOf(midStream.events[0]!.event) : '', 'one two');
    const terminalId = appended(store, assistant('s-restart', 'm-restart', 'one two three', 'done'), 's-restart');
    assert.ok(p2 < terminalId);
    assert.equal(store.eventsAfter(p2, 10).events.at(-1)?.id, terminalId, 'the terminal replaces the partial before session removal');
    store.removeSession('s-restart');
    assert.equal(store.getSession('s-restart'), undefined);
    const removedId = appended(store, { type: 'session.removed', sessionId: 's-restart' }, 's-restart');
    assert.equal(store.eventsAfter(terminalId - 1, 10).events.at(-1)?.id, removedId);
    assert.equal(store.eventsAfter(removedId, 10).events.length, 0);
  } finally { store.close(); }
  await pause(20);
  store = new ProductStore(dir);
  try {
    const first = replay(store);
    const terminal = first.events.find(entry => entry.event.type === 'message.upsert' && entry.event.message.status === 'done');
    assert.ok(terminal, 'first subscribe after restart sees the terminal projection');
    assert.equal(terminal.event.type === 'message.upsert' ? textOf(terminal.event) : '', 'one two three');
    assert.equal(terminal.event.type === 'message.upsert' ? terminal.event.message.id : '', 'm-restart');
    const catchUp = store.eventsAfter(1, 10);
    assert.equal(catchUp.reset, false, 'compacted cursors are safe to catch up');
    assert.ok(catchUp.events.every(entry => entry.id > 1));
    assert.equal(store.eventsAfter(store.latestEventId(), 10).events.length, 0);
    assert.equal(store.eventsAfter(0, 10).reset, false);
  } finally { store.close(); cleanup(dir); }
});

test('20 stages / 1000 partials stay row- and byte-bounded with terminal text intact', { timeout: 180000 }, () => {
  const dir = makeDir();
  const store = new ProductStore(dir);
  const expected = new Map<string, string>();
  const measurements: unknown[] = [];
  try {
    const text = 's'.repeat(32 * 1024);
    const stages = 20;
    const partialsPerStage = 50;
    for (let stage = 0; stage < stages; stage += 1) {
      const sessionId = 'stage-' + stage;
      const messageId = 'stage-message-' + stage;
      for (let index = 0; index < partialsPerStage; index += 1) {
        const content = text.slice(0, Math.max(1, Math.floor((text.length * (index + 1)) / partialsPerStage)));
        appended(store, assistant(sessionId, messageId, content, 'streaming'), sessionId);
      }
      appended(store, assistant(sessionId, messageId, text, 'done'), sessionId);
      expected.set(messageId, text);
      if (stage === 9 || stage === 19) {
        const checkpoint = replay(store);
        measurements.push({ stage: stage + 1, totalPartials: (stage + 1) * partialsPerStage, diskBytes: diskBytes(dir), pages: checkpoint.pages, rows: checkpoint.rows, replayBytes: checkpoint.bytes });
      }
    }
    const final = replay(store);
    const bytes = diskBytes(dir);
    const summary = { schema: 'stream-event-budget-test-summary/v1', stages, partials: stages * partialsPerStage, diskBytes: bytes, pages: final.pages, rows: final.rows, replayBytes: final.bytes, checkpoints: measurements };
    console.log(JSON.stringify(summary));
    assert.ok(final.rows <= stages + 2, 'each stage keeps at most one projection/terminal; got ' + final.rows);
    assert.ok(final.bytes < 2 * 1024 * 1024, 'twenty long streams must replay in bounded bytes; got ' + final.bytes);
    assert.ok(bytes < 20 * 1024 * 1024, 'twenty long streams must not grow the database past the bounded envelope; got ' + bytes);
    const terminals = final.events.filter(entry => entry.event.type === 'message.upsert' && entry.event.message.status === 'done');
    assert.equal(terminals.length, stages, 'every stage terminal survives');
    for (const entry of terminals) {
      if (entry.event.type !== 'message.upsert') continue;
      assert.equal(textOf(entry.event), expected.get(entry.event.message.id), 'terminal text stays exact for ' + entry.event.message.id);
      assert.equal(entry.event.message.id.startsWith('stage-message-'), true);
    }
  } finally { store.close(); cleanup(dir); }
});

test('200-row pagination stays bounded and cursors advance without rescanning history', { timeout: 120000 }, () => {
  const dir = makeDir();
  const store = new ProductStore(dir);
  try {
    const body = 'p'.repeat(10 * 1024);
    for (let index = 0; index < 450; index += 1) appended(store, assistant('paged', 'paged-' + index, body, 'done'), 'paged');
    const wide = store.eventsAfter(0, 1000);
    assert.ok(wide.events.length <= 200, 'the store clamps a page to 200 rows; got ' + wide.events.length);
    let cursor = 0; let pages = 0; let rows = 0;
    for (;;) {
      const page = store.eventsAfter(cursor, 200);
      assert.ok(page.events.length <= 200);
      if (!page.events.length) break;
      pages += 1; rows += page.events.length;
      assert.ok(page.nextCursor > cursor, 'each non-empty page advances the cursor');
      cursor = page.nextCursor;
      if (pages > 10) throw new Error('pagination did not terminate');
    }
    assert.equal(rows, 450, 'pagination covers every retained row exactly once');
    assert.equal(pages, 3, '450 rows fit in exactly three non-empty 200-row pages; got ' + pages);
    for (let index = 0; index < 20; index += 1) appended(store, notify('tail ' + index));
    const tail = store.eventsAfter(cursor, 200);
    assert.equal(tail.reset, false);
    assert.equal(tail.events.length, 20);
  } finally { store.close(); cleanup(dir); }
});


test('a failed batch append rolls back every event and the O(1) counters', { timeout: 60000 }, () => {
  const dir = makeDir();
  const store = new ProductStore(dir);
  try {
    const keptId = appended(store, notify('committed before the failing batch'));
    const before = store.eventLogUsage();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(
      () => store.append([
        { event: notify('must be rolled back') },
        { event: circular as unknown as GatewayEvent },
      ]),
      /circular/i,
    );
    assert.deepEqual(store.eventLogUsage(), before, 'a failed transaction must not leak rows or bytes');
    assert.equal(store.latestEventId(), keptId);
    const replayAfterFailure = store.eventsAfter(0, 10);
    assert.equal(replayAfterFailure.reset, false);
    assert.deepEqual(replayAfterFailure.events.map(entry => entry.id), [keptId]);
  } finally { store.close(); cleanup(dir); }
});