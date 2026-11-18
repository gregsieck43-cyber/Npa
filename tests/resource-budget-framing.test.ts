import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { attachResourceBudget, ResourceBudget } from '../src/app/resource-budget.js';

const options = { skip: process.platform !== 'win32' };
const sample = (sequence: number) => ({ physicalBytes: 10000, availableBytes: 5000, limitBytes: 6000,
  commitBytes: 1000, peakCommitBytes: 1000, workingSetBytes: sequence, processes: 1, hardLimited: true });
const line = (sequence: number) => JSON.stringify(sample(sequence)) + '\n';

class FakePipe extends EventEmitter {
  setEncoding() { return this; }
  unref() {}
  destroy() {}
  end() { this.emit('finish'); }
}

class FakeHelper extends EventEmitter {
  readonly stdin = new FakePipe();
  readonly stdout = new FakePipe();
  readonly stderr = new FakePipe();
  kills = 0;
  closed = false;
  constructor() { super(); this.stdin.once('finish', () => this.finish(0)); }
  unref() { return this; }
  kill() { this.kills++; this.finish(1); return true; }
  private finish(code: number) {
    queueMicrotask(() => { if (!this.closed) { this.closed = true; this.emit('close', code); } });
  }
}

async function withHelpers(action: (children: FakeHelper[]) => Promise<void>) {
  const originalSpawn = childProcess.spawn, children: FakeHelper[] = [];
  childProcess.spawn = (() => { const child = new FakeHelper(); children.push(child); return child; }) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try { await action(children); }
  finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    for (const child of children) { child.stdin.end(); child.stdout.destroy(); child.stderr.destroy(); }
    await Promise.resolve();
    assert.equal(childProcess.spawn, originalSpawn);
    assert.ok(children.every(child => child.closed), 'Every fake helper must close; no real process or Job is created.');
  }
}

async function watchChunks(chunks: string[], check: (budget: ResourceBudget, helper: FakeHelper) => void) {
  await withHelpers(async children => {
    const budget = new ResourceBudget();
    const pending = attachResourceBudget('fake-resource-helper', true, budget);
    const helper = children[0]!;
    helper.stdout.emit('data', line(0));
    const stop = await pending;
    try { for (const chunk of chunks) helper.stdout.emit('data', chunk); check(budget, helper); }
    finally { stop(); await Promise.resolve(); }
    assert.equal(children.length, 1, 'Explicit close cancels any failure restart.');
  });
}

function sizedLine(length: number, ending = '\n') {
  const base = JSON.stringify({ ...sample(42), padding: '😀' });
  return base.slice(0, -2) + ' '.repeat(length - ending.length - base.length) + base.slice(-2) + ending;
}

test('watch JSONL accepts identical samples per line, coalesced and split across chunks', options, async () => {
  const lines = Array.from({ length: 64 }, (_, index) => line(index + 1)), joined = lines.join('');
  assert.ok(joined.length > 8192 && lines.every(value => value.length < 8192));
  for (const chunks of [lines, [joined], [joined.slice(0, 7), joined.slice(7, 8190), joined.slice(8190)]]) {
    assert.equal(chunks.join(''), joined);
    await watchChunks(chunks, (budget, helper) => {
      assert.equal(budget.status().workingSetBytes, 64);
      assert.equal(budget.status().pressure, 'normal');
      assert.equal(budget.status().error, undefined);
      assert.equal(helper.kills, 0);
    });
  }
});

for (const ending of ['\n', '\r\n']) {
  test(`watch complete ${JSON.stringify(ending)} frame accepts exactly 8192 UTF-16 code units including terminator`, options, async () => {
    const value = sizedLine(8192, ending);
    assert.equal(value.length, 8192);
    assert.ok(Buffer.byteLength(value, 'utf8') > 8192, 'The existing string-length limit is not changed to a byte limit.');
    await watchChunks([value.slice(0, 3000), value.slice(3000)], (budget, helper) => {
      assert.equal(budget.status().workingSetBytes, 42); assert.equal(budget.status().error, undefined); assert.equal(helper.kills, 0);
    });
  });

  test(`watch complete ${JSON.stringify(ending)} frame rejects 8193 code units including terminator`, options, async () => {
    const value = sizedLine(8193, ending);
    assert.equal(value.length, 8193);
    await watchChunks([value], (budget, helper) => {
      assert.match(budget.status().error ?? '', /response too large/); assert.equal(budget.status().workingSetBytes, 0); assert.equal(helper.kills, 1);
    });
  });
}

test('watch rejects an unterminated tail over 8192 code units, including after complete frames', options, async () => {
  for (const chunks of [['x'.repeat(8193)], [line(1) + 'x'.repeat(8193)]]) {
    await watchChunks(chunks, (budget, helper) => {
      assert.match(budget.status().error ?? '', /response too large/); assert.equal(helper.kills, 1);
    });
  }
});

test('watch retains an exact 8192-code-unit tail but rejects its later newline', options, async () => {
  await withHelpers(async children => {
    const budget = new ResourceBudget(), pending = attachResourceBudget('fake-resource-helper', true, budget), helper = children[0]!;
    helper.stdout.emit('data', line(0)); const stop = await pending;
    try {
      helper.stdout.emit('data', sizedLine(8193).slice(0, -1));
      assert.equal(helper.kills, 0); assert.equal(budget.status().workingSetBytes, 0);
      helper.stdout.emit('data', '\n');
      assert.equal(helper.kills, 1); assert.match(budget.status().error ?? '', /response too large/);
    } finally { stop(); await Promise.resolve(); }
  });
});

test('watch oversized startup frames retain the existing finite restart budget', options, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await withHelpers(async children => {
      const budget = new ResourceBudget();
      const outcome = attachResourceBudget('fake-resource-helper', true, budget).then(() => undefined, error => error as Error);
      for (let attempt = 0; attempt < 4; attempt++) {
        assert.equal(children.length, attempt + 1);
        children[attempt]!.stdout.emit('data', 'x'.repeat(8193));
        assert.equal(children[attempt]!.kills, 1);
        await Promise.resolve();
        if (attempt < 3) t.mock.timers.tick([250, 1000, 4000][attempt]!);
      }
      assert.match((await outcome)?.message ?? '', /response too large.*restart limit reached/);
      assert.equal(budget.concurrency(), 0);
      t.mock.timers.tick(100000);
      assert.equal(children.length, 4, 'No restart beyond the original three delays.');
    });
  } finally { t.mock.timers.reset(); }
});
