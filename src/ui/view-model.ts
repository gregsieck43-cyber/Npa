import type { Task } from '../contracts.js';

export const statusText: Record<string, string> = {
  queued: '等待调度', running: '正在推进', waiting_approval: '等待批准', waiting_input: '等待回答', waiting_children: '等待子任务',
  paused: '已暂停', reconciling: '效果对账', completed: '验收完成', failed: '运行失败', cancelled: '已取消',
};

export function displayStatus(status: string): string { return statusText[status] ?? status; }
export function displayQuestionReason(reason: string): string {
  const labels: Record<string, string> = { initial_clarification: '目标开始前的关键澄清', choice: '协作关键选择或阶段对齐', risk: '风险需要判断', blocker: '任务遇到阻塞', authorization: '需要明确授权' };
  return labels[reason] ?? reason;
}
export function taskIsTerminal(task: Pick<Task, 'status'>): boolean { return ['completed', 'cancelled'].includes(task.status); }
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': (?:Error:\s*)?/, '');
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return String(record.message ?? record.error ?? record.code ?? '请求失败');
  }
  return '请求失败';
}
export function arrayValue<T = Record<string, any>>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}
export function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? {}, null, 2);
}
export function shortTime(value: unknown): string {
  if (!value) return '';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function lines(value: string): string[] { return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
export function safePath(parent: string, child: string): string { return [parent.replace(/[/\\]+$/, ''), child].filter(Boolean).join('/'); }
