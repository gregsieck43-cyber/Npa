import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  WorkbenchDatabase,
  createDatabase,
  decodeJson,
  encodeJson
} from '../core/database.js';
import { PayloadStore, createPayloadStore } from '../core/payload-store.js';

async function tempDirectory(t) {
  const root = join(process.cwd(), '.tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'workbench-persistence-'));
  return directory;
}

test('database enables WAL, foreign keys, busy timeout, and required tables', async (t) => {
  const directory = await tempDirectory(t);
  const database = createDatabase(join(directory, 'state.sqlite'));
  t.after(() => { database.close(); return rm(directory, { recursive: true, force: true }); });

  assert.ok(database instanceof WorkbenchDatabase);
  assert.match(String(database.get('PRAGMA journal_mode').journal_mode).toLowerCase(), /wal/);
  assert.equal(Number(database.get('PRAGMA foreign_keys').foreign_keys), 1);
  assert.ok(Number(database.get('PRAGMA busy_timeout').timeout) >= 1);

  const names = new Set(database.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));
  for (const name of [
    'projects', 'tasks', 'runs', 'steps', 'events', 'idempotency', 'context_workspaces',
    'context_blocks', 'effects', 'approvals', 'grants', 'usage', 'audit', 'schema_migrations'
  ]) {
    assert.ok(names.has(name), `missing table ${name}`);
  }
  assert.equal(Number(database.get('SELECT max(version) AS version FROM schema_migrations').version), 4);
  const runColumns = new Set(database.all('PRAGMA table_info(runs)').map((row) => row.name));
  for (const column of ['next_wake_at', 'heartbeat_at', 'attempt', 'model_calls', 'input_tokens', 'output_tokens', 'estimated_cost', 'checkpoint_seq', 'worktree_path', 'branch']) {
    assert.ok(runColumns.has(column), `missing runs.${column}`);
  }
});

test('database transactions commit and rollback atomically', async (t) => {
  const directory = await tempDirectory(t);
  const database = createDatabase(join(directory, 'state.sqlite'));
  t.after(() => { database.close(); return rm(directory, { recursive: true, force: true }); });

  database.transaction(() => {
    database.run('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', 'p1', 'Project', new Date().toISOString(), new Date().toISOString());
  });
  assert.equal(database.get('SELECT count(*) AS count FROM projects').count, 1);

  assert.throws(() => database.transaction(() => {
    database.run('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', 'p2', 'Project 2', new Date().toISOString(), new Date().toISOString());
    throw new Error('abort');
  }), /abort/);
  assert.equal(database.get('SELECT count(*) AS count FROM projects').count, 1);
});

test('JSON codecs preserve common structured values', () => {
  const encoded = encodeJson({ nested: ['value', 4], nullable: null });
  assert.equal(typeof encoded, 'string');
  assert.deepEqual(decodeJson(encoded), { nested: ['value', 4], nullable: null });
  assert.deepEqual(decodeJson('{bad json', { fallback: true }), { fallback: true });
  assert.equal(decodeJson(null, 'fallback'), 'fallback');
});

test('payload store is encrypted, content addressed, range readable, and checksum verified', async (t) => {
  const directory = await tempDirectory(t);
  const key = Buffer.alloc(32, 7);
  const store = createPayloadStore(directory, { key });
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.ok(store instanceof PayloadStore);

  const payload = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'utf8');
  const descriptor = await store.put(payload, { mimeType: 'text/plain' });
  assert.match(descriptor.hash, /^[a-f0-9]{64}$/);
  assert.equal(descriptor.sha256, descriptor.hash);
  assert.equal(await store.exists(descriptor.hash), true);
  assert.deepEqual(await store.get(descriptor.hash), payload);
  assert.deepEqual(await store.readRange(descriptor.hash, 10, 20), payload.subarray(10, 20));
  await assert.rejects(store.get(descriptor.hash, { range: 'bytes=-' }), /invalid byte range/i);
  assert.equal(await store.verify(descriptor.hash), true);

  const encrypted = await readFile(descriptor.path);
  assert.equal(encrypted.includes(payload), false, 'plaintext payload leaked into encrypted blob');

  await assert.rejects(store.get('f'.repeat(64)), /not found/i);
  await store.remove(descriptor.hash);
  assert.equal(await store.exists(descriptor.hash), false);
});
