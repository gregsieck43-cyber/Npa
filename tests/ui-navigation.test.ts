import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../src/contracts.js';
import { groupProjectSessions, sessionDateGroup } from '../src/ui/sessions.js';
import { filterCommands, type PaletteCommand } from '../src/ui/command-palette.js';

function task(id: string, workspace: string, updatedAt: string): Task {
  return { id, workspace, updatedAt, createdAt: updatedAt, title: id, goal: { objective: `完成 ${id}`, constraints: [], acceptance: [], maxModelCalls: 20, mode: 'collaborative' }, status: 'paused', owner: 'local', modelCalls: 0, revision: 1, goalVersion: 1, policyEpoch: 1, generation: 1 };
}

test('project navigation normalizes Windows paths, keeps recent work first and searches project names', () => {
  const tasks = [task('older', 'F:\\Projects\\Alpha', '2026-10-07T01:00:00Z'), task('latest', 'f:/projects/alpha/', '2026-10-08T01:00:00Z'), task('other', 'F:\\Projects\\Beta', '2026-10-06T01:00:00Z')];
  const groups = groupProjectSessions(tasks);
  assert.equal(groups.length, 2); assert.deepEqual(groups[0].tasks.map(item => item.id), ['latest', 'older']);
  assert.deepEqual(groupProjectSessions(tasks, 'Beta').flatMap(group => group.tasks.map(item => item.id)), ['other']);
});

test('automatic per-task workspaces are grouped without showing generated IDs as project names', () => {
  const groups = groupProjectSessions([task('task-1', 'F:/data/workspaces/task-1', '2026-10-08T01:00:00Z'), task('task-2', 'F:/data/workspaces/task-2', '2026-10-07T01:00:00Z')]);
  assert.equal(groups.length, 1); assert.equal(groups[0].name, '独立任务');
});

test('date groups follow local calendar boundaries and command search matches every term', () => {
  const now = new Date(2026, 9, 8, 12);
  assert.equal(sessionDateGroup(new Date(2026, 9, 8, 1).toISOString(), now), '今天');
  assert.equal(sessionDateGroup(new Date(2026, 9, 7, 23).toISOString(), now), '昨天');
  assert.equal(sessionDateGroup(new Date(2026, 9, 6, 23).toISOString(), now), '更早');
  const commands: PaletteCommand[] = [{ id: '1', label: '项目 Alpha', detail: '已暂停', group: '会话', glyph: 'chat', keywords: '编译修复', run() {} }, { id: '2', label: '设置', detail: '模型连接', group: '操作', glyph: 'settings', run() {} }];
  assert.deepEqual(filterCommands(commands, 'ALPHA 修复').map(item => item.id), ['1']);
  assert.equal(filterCommands(commands, 'Alpha 模型').length, 0);
});
