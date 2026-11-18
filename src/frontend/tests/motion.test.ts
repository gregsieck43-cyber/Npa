import assert from 'node:assert/strict';
import test from 'node:test';
import { createCountdown } from '../lib/motion';

test('countdown pauses elapsed monotonic time, resumes once and shares progress with expiry', () => {
  let now = 0, id = 0, expired = 0;
  const scheduled = new Map<number, () => void>(), values: number[] = [];
  const clock = createCountdown(100, value => values.push(value), () => expired++, {
    now: () => now, request: tick => { scheduled.set(++id, tick); return id; }, cancel: key => { scheduled.delete(key); },
  });
  const advance = (ms: number) => { now += ms; const ticks = [...scheduled.values()]; scheduled.clear(); ticks.forEach(tick => tick()); };
  clock.pause(false); advance(30); assert.equal(values.at(-1), 70);
  now += 10; clock.pause(true); assert.equal(values.at(-1), 60); assert.equal(scheduled.size, 0);
  advance(9000); assert.equal(expired, 0);
  clock.pause(false); clock.pause(false); assert.equal(scheduled.size, 1);
  advance(59); assert.equal(values.at(-1), 1); assert.equal(expired, 0);
  advance(1); assert.equal(values.at(-1), 0); assert.equal(expired, 1); assert.equal(scheduled.size, 0);
  clock.pause(false); advance(100); assert.equal(expired, 1);
});

test('countdown disposal cancels its scheduled owner and ignores late callbacks', () => {
  let now = 0, tick = () => {}, cancelled = 0, expired = 0;
  const clock = createCountdown(20, () => {}, () => expired++, { now: () => now, request: value => { tick = value; return 7; }, cancel: id => { assert.equal(id, 7); cancelled++; } });
  clock.pause(false); clock.dispose(); now = 100; tick();
  assert.equal(cancelled, 1); assert.equal(expired, 0);
});
