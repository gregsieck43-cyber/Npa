import type { Task } from '../contracts.js';

/** UI navigation only. Code remains a secondary workspace, never a second kernel. */
export const primaryDestinations = [
  { screen: 'chat', label: 'Chat', caption: '对话', glyph: 'chat', id: 'nav-chat' },
  { screen: 'work', label: 'Work', caption: '任务', glyph: 'work', id: 'nav-work' },
  { screen: 'projects', label: 'Projects', caption: '项目', glyph: 'folder', id: 'nav-projects' },
  { screen: 'history', label: 'History', caption: '历史', glyph: 'history', id: 'nav-history' },
  { screen: 'settings', label: 'Settings', caption: '设置', glyph: 'settings', id: 'nav-settings' },
] as const;

export type WorkFilter = 'all' | 'attention' | 'active' | 'finished';
export const workFilters: [WorkFilter, string][] = [['all', '全部任务'], ['attention', '需要你'], ['active', '进行中'], ['finished', '已结束']];
const attention = new Set(['waiting_approval', 'waiting_input', 'reconciling', 'failed', 'paused']);
const finished = new Set(['completed', 'cancelled']);
export function filterWork(tasks: Task[], filter: WorkFilter, query: string): Task[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return tasks.filter(task => {
    if (filter === 'attention' && !attention.has(task.status)) return false;
    if (filter === 'finished' && !finished.has(task.status)) return false;
    if (filter === 'active' && (attention.has(task.status) || finished.has(task.status))) return false;
    const text = `${task.title} ${task.goal.objective} ${task.workspace}`.toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function taskNextStep(task: Task): string {
  if (task.error) return task.error;
  if (task.waitingReason) return task.waitingReason;
  const labels: Record<string, string> = {
    waiting_approval: '核对工具动作后，明确批准或拒绝。', waiting_input: '补充信息或提交人工验收证据。',
    reconciling: '正在核对未知效果，不会自动重复执行。', paused: '目标与上下文已保留，可恢复执行。',
    failed: '检查失败原因与执行记录后再重试。', waiting_children: '正在等待独立子任务返回结果。',
    completed: '查看验收结果与工件证据。', cancelled: '已停止后续调度，历史记录保留。',
    queued: '任务已保存，等待后台调度。', running: '后台正在按已保存的目标推进。',
  };
  return labels[task.status] ?? '查看任务的实际状态与记录。';
}

export function messagePreview(content: string, limit = 2400): { preview: string; folded: boolean } {
  const points = Array.from(content);
  if (points.length <= limit && content.split('\n').length <= 45) return { preview: content, folded: false };
  const preview = points.slice(0, Math.min(limit, 900)).join('').split('\n').slice(0, 12).join('\n');
  return { preview, folded: true };
}

export function inspectorWidth(value: number, viewport: number): number {
  const maximum = Math.max(280, Math.min(720, viewport - 40));
  return Math.max(Math.min(340, maximum), Math.min(maximum, Number.isFinite(value) ? value : 420));
}
