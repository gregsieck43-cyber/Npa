import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ProgressGuard } from '../src/kernel/progress.js';
import type { Task } from '../src/contracts.js';

test('no-progress count survives restart and generation changes; only new content or operator input resets it', () => {
  const db = new DatabaseSync(':memory:');
  const task = { id: 'task', status: 'running', generation: 1, goalVersion: 1 } as Task;
  let waits = 0;
  const port = { db, tx: <T>(run: () => T) => run(), task: () => task, fence: () => {}, wait: () => { waits++; task.status = 'waiting_input'; }, event: () => {} };
  let guard = new ProgressGuard(port);
  const input = { cursor: 1, offset: 0 };
  assert.equal(guard.beforeRequest(task.id, 'run', input), true);
  guard.evidence(task.id, { path: 'x', sha256: 'a' });
  assert.equal(guard.beforeRequest(task.id, 'run', input), true);
  for (let i = 0; i < 6; i++) { guard.evidence(task.id, { path: 'x', sha256: 'a' }); assert.equal(guard.beforeRequest(task.id, 'run', input), true); }
  task.generation++; guard = new ProgressGuard(port);
  for (let i = 0; i < 5; i++) assert.equal(guard.beforeRequest(task.id, 'new-run', input), true);
  assert.equal(guard.beforeRequest(task.id, 'new-run', input), false); assert.equal(waits, 1);
  assert.equal(guard.beforeRequest(task.id, 'new-run', input), false); assert.equal(waits, 1);
  task.status = 'running'; input.cursor++;
  assert.equal(guard.beforeRequest(task.id, 'new-run', input), true);
  for (let i = 0; i < 40; i++) { input.offset++; assert.equal(guard.beforeRequest(task.id, 'new-run', input), true); }
  guard.evidence(task.id, { path: 'x', sha256: 'b' });
  assert.equal(guard.beforeRequest(task.id, 'new-run', input), true);
  db.close();
});
