import type { Task } from '../contracts.js';
import { append, button, element, empty, icon } from './dom.js';
import { displayStatus, shortTime } from './view-model.js';

export interface ProjectSessions { key: string; name: string; path: string; tasks: Task[]; }

export function groupProjectSessions(tasks: Task[], query = ''): ProjectSessions[] {
  const projects = new Map<string, ProjectSessions>(), needle = query.trim().toLocaleLowerCase();
  for (const task of [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (needle && !`${task.title} ${task.goal.objective} ${task.workspace}`.toLocaleLowerCase().includes(needle)) continue;
    const path = task.workspace.replaceAll('\\', '/').replace(/\/$/, ''), name = path.split('/').at(-1) || '工作空间';
    const independent = name === task.id || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(name);
    const key = independent ? 'independent' : path.toLocaleLowerCase();
    const group = projects.get(key) ?? { key, name: independent ? '独立任务' : name, path: independent ? '独立任务工作区' : task.workspace, tasks: [] };
    group.tasks.push(task); projects.set(key, group);
  }
  return [...projects.values()];
}

export function sessionDateGroup(iso: string, now = new Date()): string {
  const date = new Date(iso), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (date >= today) return '今天';
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  return date >= yesterday ? '昨天' : '更早';
}

interface SessionListOptions {
  tasks: Task[]; query: string; selectedId: string; active: boolean; collapsed: Set<string>;
  selectTask(id: string): void;
}

export function renderSessionList(target: HTMLElement, options: SessionListOptions): void {
  target.replaceChildren();
  const groups = groupProjectSessions(options.tasks, options.query);
  if (!groups.length) { target.append(empty(options.query ? '没有匹配的项目或会话' : '新建会话，开始第一个项目')); return; }
  for (const group of groups) {
    const closed = !options.query && options.collapsed.has(group.key);
    const section = element('section', `project-group${closed ? ' collapsed' : ''}`); section.dataset.project = group.key;
    const content = element('div', 'project-sessions'), list = element('div', 'project-session-list'); content.inert = closed;
    const heading = button('', () => {
      const collapsed = section.classList.toggle('collapsed');
      if (collapsed) options.collapsed.add(group.key); else options.collapsed.delete(group.key);
      heading.setAttribute('aria-expanded', String(!collapsed)); content.inert = collapsed;
    }, 'project-heading ghost');
    heading.title = group.path; heading.setAttribute('aria-label', `项目 ${group.name}`); heading.setAttribute('aria-expanded', String(!closed));
    heading.append(icon('chevron'), icon('folder'), element('span', 'grow', group.name), element('span', 'project-count', String(group.tasks.length)));
    let lastDate = '';
    for (const task of group.tasks) {
      const dateGroup = sessionDateGroup(task.updatedAt);
      if (dateGroup !== lastDate) { list.append(element('div', 'session-date', dateGroup)); lastDate = dateGroup; }
      const selected = options.active && options.selectedId === task.id;
      const item = button('', () => options.selectTask(task.id), `task-item${selected ? ' selected' : ''}`, `task-${task.id}`);
      item.title = task.goal.objective; item.setAttribute('aria-current', String(selected));
      const dot = element('span', `task-state-dot state-${task.status}`); dot.setAttribute('aria-hidden', 'true');
      item.append(append(element('div', 'task-name'), dot, element('span', '', task.title)), append(element('div', 'task-meta'), element('span', `status-${task.status}`, `${task.parentId ? '子任务 · ' : ''}${displayStatus(task.status)}`), element('time', '', shortTime(task.updatedAt))));
      list.append(item);
    }
    content.append(list); section.append(heading, content); target.append(section);
  }
}
