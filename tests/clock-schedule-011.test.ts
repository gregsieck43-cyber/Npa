import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Kernel } from '../src/kernel/index.js';

class ClockFixtureKernel extends Kernel {
  seedLegacySchedule(taskId: string, due: number, reason: string) {
    this.db.prepare('INSERT INTO task_schedule(task_id,due,consecutive_failures,reason) VALUES(?,?,0,?) ON CONFLICT(task_id) DO UPDATE SET due=excluded.due,reason=excluded.reason').run(taskId, due, reason);
  }
  useLegacySchema() { this.db.exec('ALTER TABLE task_schedule DROP COLUMN scheduled_at; ALTER TABLE task_schedule DROP COLUMN delay_ms'); }
}

test('model Retry-After survives a ten-year rollback, database reopen and a forward sleep jump', t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp/hardening-011-transports'); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'clock-model-'));
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  let kernel = new ClockFixtureKernel(directory);
  t.after(() => { kernel.close(); rmSync(directory, { recursive: true }); });
  const taskId = kernel.command({ commandId: 'create', type: 'create_task', parameters: { title: 'Clock retry' } }).taskId!;
  kernel.createRun(taskId); kernel.transition(taskId, 'running');
  const providerDelay = 24 * 60 * 60_000;
  kernel.scheduleModelRetry(taskId, kernel.getTask(taskId)!.generation, 'rate_limited', 'wait', providerDelay);
  clock += 60 * 60_000; kernel.getSchedule(taskId);
  const remainingDelay = providerDelay - 60 * 60_000;
  clock -= 10 * 365 * 24 * 60 * 60_000;
  kernel.runnableTaskPage();
  assert.equal(kernel.getSchedule(taskId).due, clock + remainingDelay, 'rollback retains the remaining provider duration instead of waiting ten years');
  kernel.close(); clock -= 365 * 24 * 60 * 60_000; kernel = new ClockFixtureKernel(directory);
  assert.equal(kernel.getSchedule(taskId).due, clock + remainingDelay, 'persisted duration also survives a clock change while stopped');
  clock += remainingDelay + 1;
  assert.equal(kernel.taskRunnable(taskId), true, 'normal sleep/forward time does not add a second wait');
});

test('legacy reconciliation rebases within its known delay while unknown legacy waits remain explicit', t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp/hardening-011-transports'); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'clock-legacy-'));
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  let kernel = new ClockFixtureKernel(directory);
  t.after(() => { kernel.close(); rmSync(directory, { recursive: true }); });
  const create = (id: string) => kernel.command({ commandId: id, type: 'create_task', parameters: { title: id } }).taskId!;
  const known = create('known'), unknown = create('unknown'), sentinel = create('sentinel');
  const future = clock + 10 * 365 * 24 * 60 * 60_000;
  kernel.seedLegacySchedule(known, future, 'effect.reconciliation');
  kernel.seedLegacySchedule(unknown, future, 'legacy-provider');
  kernel.setReconciliationDue(sentinel, Number.MAX_SAFE_INTEGER);
  kernel.useLegacySchema();
  kernel.close(); clock -= 100_000; kernel = new ClockFixtureKernel(directory);
  assert.equal(kernel.getSchedule(known).due, clock + 30_000);
  assert.equal(kernel.getSchedule(sentinel).due, Number.MAX_SAFE_INTEGER, 'manual retry sentinel must never become automatic');
  const legacy = kernel.getSchedule(unknown) as ReturnType<Kernel['getSchedule']> & { clockDiagnostic?: string };
  assert.equal(legacy.due, future);
  assert.match(legacy.clockDiagnostic ?? '', /legacy|clock/i);
  kernel.getSchedule(unknown);
  assert.equal(kernel.eventCount(unknown, 'schedule.clock_review_required'), 1, 'repeated reads cannot fill history with diagnostics');
});

test('a retry already due before rollback stays runnable instead of gaining years of delay', t => {
  const base = path.resolve(process.env.TEMP ?? '.tmp/hardening-011-transports'); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'clock-expired-'));
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const kernel = new ClockFixtureKernel(directory);
  t.after(() => { kernel.close(); rmSync(directory, { recursive: true }); });
  const taskId = kernel.command({ commandId: 'create', type: 'create_task', parameters: { title: 'Expired retry' } }).taskId!;
  kernel.createRun(taskId); kernel.transition(taskId, 'running');
  kernel.scheduleModelRetry(taskId, kernel.getTask(taskId)!.generation, 'network', 'retry');
  clock += 1_000; kernel.getSchedule(taskId);
  clock -= 10 * 365 * 24 * 60 * 60_000;
  assert.equal(kernel.taskRunnable(taskId), true);
  assert.equal(kernel.getSchedule(taskId).due, clock);
});
