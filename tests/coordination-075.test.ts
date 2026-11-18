import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Task } from '../src/contracts.js';
import { Coordination, type CoordinationPort } from '../src/kernel/coordination.js';

function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE tasks(id TEXT PRIMARY KEY); CREATE TABLE task_execution_owners(task_id TEXT PRIMARY KEY);');
  const tasks = new Map<string, Task>(), events: { taskId: string; type: string; payload: unknown }[] = [];
  let depth = 0, time = 0;
  const port: CoordinationPort = { db,
    tx: run => { if (depth) return run(); db.exec('BEGIN IMMEDIATE'); depth++; try { const result = run(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } finally { depth--; } },
    task: id => tasks.get(id), event: (taskId, type, payload) => events.push({ taskId, type, payload }),
    fence: (id, runId) => { if (runId !== 'run-' + id || tasks.get(id)?.status !== 'running') throw new Error('STALE_RUN'); },
  };
  const service = new Coordination(port, () => time);
  const create = (id: string, workspace = 'J:/shared') => {
    const task = { id, workspace, title: id, goal: { objective: 'Do ' + id }, status: 'running', generation: 1, policyEpoch: 1 } as Task;
    tasks.set(id, task); db.prepare('INSERT INTO tasks VALUES(?)').run(id); return task;
  };
  return { db, tasks, events, service, port, create, advance: (ms: number) => { time += ms; } };
}

test('CO-01/02/09 peers receive durable bidirectional notices without state or workspace leakage', t => {
  const f = fixture(t), a = f.create('a'), b = f.create('b'), other = f.create('c', 'J:/other');
  f.service.join(a.id); f.service.join(other.id); const before = JSON.stringify([...f.tasks]); f.service.join(b.id);
  assert.equal(JSON.stringify([...f.tasks]), before);
  assert.equal(f.service.inbox(a.id).items[0]!.kind, 'peer_joined');
  assert.equal(f.service.inbox(b.id).items[0]!.kind, 'peer_present');
  assert.equal(f.service.inbox(other.id).items.length, 0);
  assert.deepEqual(f.service.presence(a.workspace).items.map(item => item.id), ['a', 'b']);
  const selection = f.service.select(b.id)!;
  assert.match(selection.text, /untrusted peer reference data/);
  assert.match(selection.text, /Do a/);
  f.service.dispatch(selection, 'run-b', 'request1', 'bodyhash');
  f.service.settle('request1', 'completed');
  assert.equal(f.service.inbox(b.id).items[0]!.ackedAt, null, 'dispatch and response are not read acknowledgements');
  assert.equal((f.db.prepare('SELECT stage FROM coordination_attempts').get() as any).stage, 'completed');
});

test('CO-05 leases expire before renewal after a long pause, and late leave cannot remove a new activation', t => {
  const f = fixture(t); f.create('a'); f.create('b'); f.service.join('a'); f.service.join('b');
  f.advance(61000); f.service.maintain();
  assert.equal(f.service.presence('J:/shared').items.length, 0);
  const renewed = f.service.join('a')!; assert.equal(renewed.activation, 2);
  f.service.leave('a', 'late finally', 1);
  assert.equal(f.service.presence('J:/shared').items.length, 1);
  f.tasks.get('a')!.status = 'waiting_approval'; f.advance(15000); f.service.maintain();
  assert.equal(f.service.presence('J:/shared').items[0]!.status, 'waiting_approval');
  f.tasks.get('a')!.status = 'paused'; f.service.taskChanged(f.tasks.get('a')!);
  assert.equal(f.service.presence('J:/shared').items.length, 0);
});

test('CO-06 frozen inbox pages, idempotent sends and separate operator/agent acknowledgements', t => {
  const f = fixture(t); f.create('a'); f.create('b'); f.create('foreign', 'J:/foreign');
  f.service.join('a'); f.service.join('b');
  const original = JSON.stringify([...f.tasks]);
  for (let i = 0; i < 103; i++) f.service.send('a', 'b', 'question', 'reference ' + i, 'effect' + i, 'work', 'run-a');
  const first = f.service.inbox('b', { limit: 40 }, 'work', 'run-b');
  const same = f.service.send('a', 'b', 'question', 'reference 1', 'effect1', 'work', 'run-a');
  assert.throws(() => f.service.send('a', 'b', 'question', 'different', 'effect1', 'work', 'run-a'), /different content/);
  f.service.send('a', 'b', 'evidence', 'new arrival', 'late', 'work', 'run-a');
  const second = f.service.inbox('b', { after: first.nextCursor, through: first.through, limit: 100 }, 'work', 'run-b');
  assert.equal(first.items.length + second.items.length, 104);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 104);
  f.service.ack('b', [same.id], 'operator');
  let row = f.service.inbox('b').items.find(item => item.id === same.id)!;
  assert.ok(row.operatorSeenAt); assert.equal(row.ackedAt, null);
  assert.throws(() => f.service.ack('b', [same.id, 'foreign-id'], 'work', 'run-b'));
  assert.equal(f.service.inbox('b').items.find(item => item.id === same.id)!.ackedAt, null, 'batch scope failure rolls back all updates');
  f.service.ack('b', [same.id], 'work', 'run-b');
  row = f.service.inbox('b').items.find(item => item.id === same.id)!; assert.ok(row.ackedAt);
  assert.throws(() => f.service.send('a', 'foreign', 'question', 'x', 'scope', 'work', 'run-a'));
  assert.equal(JSON.stringify([...f.tasks]), original);
});

test('unknown dispatch survives process epoch change, while stale owner cannot send or acknowledge unseen data', t => {
  const f = fixture(t); f.create('a'); f.create('b'); f.service.join('a'); f.service.join('b');
  const selection = f.service.select('b')!;
  assert.throws(() => f.service.ack('b', selection.notices.map(item => item.id), 'work', 'run-b'));
  f.service.dispatch(selection, 'run-b', 'in-flight', 'hash');
  const restarted = new Coordination(f.port);
  assert.equal((f.db.prepare('SELECT stage FROM coordination_attempts').get() as any).stage, 'unknown');
  assert.equal(restarted.presence('J:/shared').items.length, 0);
  restarted.join('b');
  assert.throws(() => restarted.dispatch(selection, 'run-b', 'stale', 'hash'));
  assert.equal(restarted.inbox('b').items[0]!.ackedAt, null);
});
