import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../src/contracts.js';
import { filterWork, inspectorWidth, messagePreview, primaryDestinations, taskNextStep } from '../src/ui/workspace-model.js';

const task = (status: Task['status'], title = status): Task => ({ id: title, title, status, workspace: 'F:/Projects/Alpha', createdAt: '2026-10-13', updatedAt: '2026-10-13', goal: { objective: '验证工作区', constraints: [], acceptance: [], maxModelCalls: 10, mode: 'collaborative' }, modelCalls: 0, revision: 1, goalVersion: 1, generation: 1, policyEpoch: 1, owner: 'local' });

test('primary navigation has the five requested destinations; Code remains secondary', () => {
  assert.deepEqual(primaryDestinations.map(item => item.label), ['Chat', 'Work', 'Projects', 'History', 'Settings']);
  assert.equal(new Set(primaryDestinations.map(item => item.id)).size, 5);
});
test('Work attention includes approval, input, unknown effects, failure and pause, not completed work', () => {
  const tasks = ['waiting_approval', 'waiting_input', 'reconciling', 'failed', 'paused', 'running', 'waiting_children', 'completed', 'cancelled'].map(status => task(status as Task['status']));
  assert.equal(filterWork(tasks, 'attention', '').length, 5);
  assert.equal(filterWork(tasks, 'active', '').length, 2);
  assert.equal(filterWork(tasks, 'finished', '').length, 2);
  assert.equal(filterWork(tasks, 'all', 'Alpha 验证').length, 9);
  assert.equal(filterWork(tasks, 'all', 'Beta').length, 0);
  assert.match(taskNextStep(task('reconciling')), /不会自动重复执行/);
});
test('long messages fold by size or line count without splitting unicode or losing the original source', () => {
  assert.deepEqual(messagePreview('简短内容'), { preview: '简短内容', folded: false });
  const long = '😀'.repeat(2500);
  const view = messagePreview(long);
  assert.equal(view.folded, true); assert.equal(Array.from(view.preview).length, 900);
  assert.equal(view.preview.includes('\ufffd'), false); assert.equal(long.length, 5000);
  assert.equal(messagePreview('line\n'.repeat(46)).folded, true);
});
test('Inspector width is finite and bounded on narrow and wide windows', () => {
  assert.equal(inspectorWidth(1000, 1440), 720);
  assert.equal(inspectorWidth(100, 1440), 340);
  assert.equal(inspectorWidth(440, 375), 335);
  assert.equal(inspectorWidth(Number.NaN, 1440), 420);
});
