import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SideRequestLedger } from '../src/kernel/side-requests.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE budget(id TEXT PRIMARY KEY, used INTEGER, maximum INTEGER); INSERT INTO budget VALUES(\'parent\',0,2),(\'child\',0,2)');
  const tx = <T>(run: () => T): T => { db.exec('BEGIN'); try { const value = run(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const charge = () => { assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM budget WHERE used>=maximum').get()!.n), 0, 'exhausted'); db.exec('UPDATE budget SET used=used+1'); };
  return { db, ledger: new SideRequestLedger({ db, tx, charge }), tx, charge };
}
test('side dispatch charges its bound task and ancestors once; replay never sends again', () => {
  const f = fixture();
  f.ledger.dispatch('r1', 'child', 'side-a');
  assert.throws(() => f.ledger.dispatch('r1', 'child', 'side-a'), /already dispatched/);
  assert.throws(() => f.ledger.dispatch('r1', 'parent', 'side-a'), /identity/);
  assert.deepEqual(f.db.prepare('SELECT used FROM budget').all().map(row => row.used), [1, 1]);
  f.ledger.settle('r1', 'completed', { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.equal(f.ledger.get('r1')!.usageState, 'known');
  f.ledger.settle('r1', 'failed');
  assert.equal(f.ledger.get('r1')!.usageState, 'known', 'local projection failure cannot erase observed provider usage');
  assert.equal(f.ledger.get('r1')!.status, 'completed', 'network completion is not undone by a local projection failure');
  f.ledger.dispatch('r2', 'child', 'side-a');
  assert.throws(() => f.ledger.dispatch('r3', 'child', 'side-a'), /exhausted/);
  assert.equal(f.ledger.get('r3'), undefined);
  f.db.close();
});
test('failed and restarted attempts retain unknown usage, without replay or double charge', () => {
  const f = fixture();
  f.ledger.dispatch('r1', 'child', 'side-a'); f.ledger.settle('r1', 'cancelled');
  assert.equal(f.ledger.get('r1')!.usageState, 'unknown');
  f.ledger.dispatch('r2', 'child', 'side-a');
  const reopened = new SideRequestLedger({ db: f.db, tx: f.tx, charge: f.charge });
  assert.equal(reopened.get('r2')!.status, 'unknown');
  assert.throws(() => reopened.dispatch('r2', 'child', 'side-a'), /already dispatched/);
  assert.deepEqual(f.db.prepare('SELECT used FROM budget').all().map(row => row.used), [2, 2]);
  reopened.settle('never-dispatched', 'failed');
  assert.equal(reopened.get('never-dispatched'), undefined);
  f.db.close();
});
test('partial or invalid token reporting is never presented as complete known usage', () => {
  const f = fixture();
  f.ledger.dispatch('r1', 'child', 'side-a'); f.ledger.settle('r1', 'completed', { prompt_tokens: 3 });
  assert.equal(f.ledger.get('r1')!.usageState, 'partial');
  f.ledger.dispatch('r2', 'child', 'side-a'); f.ledger.settle('r2', 'completed', { total_tokens: -1 });
  assert.equal(f.ledger.get('r2')!.usageState, 'unknown'); f.db.close();
});
