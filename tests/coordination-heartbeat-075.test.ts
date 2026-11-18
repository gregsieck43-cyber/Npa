import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Task } from '../src/contracts.js';
import { Coordination, type CoordinationPort } from '../src/kernel/coordination.js';

function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY); CREATE TABLE task_execution_owners(task_id TEXT PRIMARY KEY)');
  const tasks = new Map<string, Task>(); let clock = 0, reads = 0, depth = 0;
  const port: CoordinationPort = { db, tx: run => {
    if (depth) return run(); db.exec('BEGIN'); depth++;
    try { const value = run(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } finally { depth--; }
  }, task: id => { reads++; return tasks.get(id); }, event: () => {}, fence: () => {} };
  const create = (id: string, workspace: string) => {
    const task = { id, workspace, title: id, goal: { objective: 'Wait for operator input' }, status: 'waiting_input', generation: 1, policyEpoch: 1 } as Task;
    tasks.set(id, task); db.prepare('INSERT INTO tasks VALUES(?)').run(id); return task;
  };
  return { db, port, tasks, create, service: new Coordination(port, () => clock), now: () => clock,
    advance: (ms: number) => { clock += ms; }, resetReads: () => { reads = 0; }, reads: () => reads,
    changes: () => Number(db.prepare('SELECT total_changes() AS n').get()!.n) };
}

test('C1 thousands of waiting participants share constant-work heartbeat and shutdown', t => {
  const f = fixture(t);
  for (let i = 0; i < 2000; i++) { const task = f.create('task-' + i, 'J:/workspace-' + i); f.service.join(task.id); }
  f.resetReads(); const before = f.changes(); f.advance(15000); f.service.maintain();
  assert.equal(f.reads(), 0, 'heartbeat must not load every waiting Task body');
  assert.equal(f.changes(), before, 'heartbeat must not rewrite every participant row');
  assert.equal(f.service.presence('J:/workspace-19').items.length, 1);
  f.resetReads(); const beforeStop = f.changes(); f.service.stop();
  assert.equal(f.reads(), 0); assert.equal(f.changes(), beforeStop);
  assert.deepEqual(f.service.presence('J:/workspace-19').items, []);
  assert.deepEqual(f.service.workspaces().items, []);
});

test('C1 recovery is bounded to a page and constructor never rewrites all historical presence', t => {
  const f = fixture(t);
  for (let i = 0; i < 1500; i++) {
    const id = 'task-' + String(i).padStart(6, '0'); f.create(id, 'J:/shared');
    f.db.prepare('INSERT INTO coordination_presence VALUES(?,?,?,?,?,?,?,?)').run(id, 'j:/shared', 'old-owner', 3, 1, 1, 'active', new Date().toISOString());
  }
  f.resetReads(); const before = f.changes(); const restarted = new Coordination(f.port, f.now);
  assert.equal(f.changes(), before, 'startup must not update every presence row');
  assert.deepEqual(restarted.presence('J:/shared').items, []);
  restarted.restorePage(); assert.ok(f.reads() <= 100, 'one restore page must load at most 100 Task bodies');
  assert.equal(restarted.presence('J:/shared', '', 100).items.length, 100);
  f.resetReads(); restarted.restorePage(); assert.ok(f.reads() <= 100);
  assert.equal(Number(f.db.prepare("SELECT COUNT(*) AS n FROM coordination_presence WHERE activation=4").get()!.n), 200);
  const row = restarted.presence('J:/shared', '', 1).items[0]!;
  restarted.leave(row.id, 'old activation cleanup', 3);
  assert.equal(restarted.presence('J:/shared', '', 1).items[0]!.activation, 4);
});

test('C1 owner expiry hides old participants before bounded recovery and rejects stale dispatch', t => {
  const f = fixture(t); f.create('a', 'J:/shared'); f.create('b', 'J:/shared'); f.service.join('a'); f.service.join('b');
  const selection = f.service.select('b')!;
  f.advance(61000); f.resetReads(); f.service.maintain();
  assert.equal(f.reads(), 0); assert.deepEqual(f.service.presence('J:/shared').items, []);
  assert.throws(() => f.service.dispatch(selection, 'old-run', 'old-request', 'hash'), /changed/);
  f.service.restorePage(); assert.equal(f.service.presence('J:/shared').items.length, 2);
  f.service.leave('b', 'late old owner', 1); assert.equal(f.service.presence('J:/shared').items.length, 2);
});

test('C1 stop/start preserves activation guards and restores inactive departures without unbounded Task reads', t => {
  const f = fixture(t); f.create('a', 'J:/shared'); f.create('b', 'J:/shared'); f.service.join('a'); f.service.join('b');
  const old = f.service.select('b')!; f.service.stop();
  f.tasks.get('a')!.status = 'cancelled';
  f.service.start(); f.resetReads(); f.service.restorePage();
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.service.presence('J:/shared').items.map(item => item.id), ['b']);
  const departure = f.service.inbox('b').items.find(item => item.kind === 'peer_left');
  assert.ok(departure, 'a peer recovered later must still receive the departure'); assert.equal((departure.payload as any).participantId, 'a');
  assert.throws(() => f.service.dispatch(old, 'run', 'old', 'hash'), /changed/);
  f.service.leave('b', 'late prior activation', 1);
  assert.equal(f.service.presence('J:/shared').items[0]!.activation, 2);
});
