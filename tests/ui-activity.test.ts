import test from 'node:test';
import assert from 'node:assert/strict';
import { activityLevel, activitySummary, calendarOffset, type ActivityDay } from '../src/ui/activity-model.js';

test('activity summary counts actual records and resets the consecutive-day streak at empty days', () => {
  const days = [4, 2, 0, 8, 5, 1].map((events, index): ActivityDay => ({ date: `2026-10-0${index + 1}`, events, modelCalls: index, toolEffects: 1, tasksCreated: 0, tasksCompleted: index === 5 ? 1 : 0 }));
  assert.deepEqual(activitySummary(days), { events: 20, modelCalls: 15, toolEffects: 6, tasksCreated: 0, tasksCompleted: 1, activeDays: 5, longestStreak: 3 });
  assert.equal(activitySummary([]).events, 0);
});

test('calendar uses UTC Monday-first placement and heat levels do not create activity for zero days', () => {
  assert.equal(calendarOffset('2026-10-05'), 0);
  assert.equal(calendarOffset('2026-10-11'), 6);
  assert.equal(activityLevel(0, 100), 0);
  assert.equal(activityLevel(1, 100), 1);
  assert.equal(activityLevel(25, 100), 2);
  assert.equal(activityLevel(100, 100), 4);
});
