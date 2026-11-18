import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Command, CommandAck, GoalContract, Task, WorkspaceInfo } from '../contracts.js';
import { isForbiddenRelative } from '../tools/policy.js';

export interface IdeAccess {
  workspace(value: string): Promise<WorkspaceInfo>;
  tasks(workspace: string): Promise<Task[]>;
  command(command: Command): Promise<CommandAck>;
}
export type IdeControl = 'pause' | 'resume' | 'cancel' | 'retry';
const workspaceKey = (value: string) => path.resolve(value).toLowerCase();

/** Native documents belong to the IDE; only explicit Agent commands cross this boundary. */
export class IdeController {
  tasks: Task[] = [];
  private workspaces = new Map<string, WorkspaceInfo>();
  private pending = new Map<string, Command>();
  constructor(private readonly access: IdeAccess) {}

  async refresh(folders: string[]): Promise<Task[]> {
    const workspaces = await Promise.all(folders.map(folder => this.access.workspace(folder)));
    const tasks = (await Promise.all(workspaces.map(workspace => this.access.tasks(workspace.path)))).flat();
    this.workspaces = new Map(workspaces.map(workspace => [workspaceKey(workspace.path), workspace]));
    this.tasks = tasks.filter(task => this.workspaces.has(workspaceKey(task.workspace)));
    return this.tasks;
  }
  async createTask(workspace: string, objective: string, goal: Partial<GoalContract> = {}): Promise<CommandAck> {
    const attached = this.workspaces.get(workspaceKey(workspace));
    if (!attached) throw new Error('Attach this workspace to the NPN backend before creating a task.');
    if (!objective.trim() || objective.length > 40000) throw new Error('A task objective requires 1–40000 characters.');
    const parameters = { title: objective.split('\n')[0]!.slice(0, 80), workspace: attached.path,
      goal: { objective, constraints: goal.constraints ?? [], acceptance: goal.acceptance ?? [], maxModelCalls: goal.maxModelCalls ?? 20, maxToolCalls: goal.maxToolCalls ?? 100, mode: goal.mode ?? 'collaborative' } };
    return this.submit(`create:${attached.id}:${JSON.stringify(parameters)}`, { type: 'create_task', parameters });
  }
  async control(taskId: string, type: IdeControl): Promise<CommandAck> {
    const task = this.tasks.find(task => task.id === taskId);
    if (!task) throw new Error('This task is not attached to an open IDE workspace.');
    if (!['pause', 'resume', 'cancel', 'retry'].includes(type)) throw new Error('Unsupported IDE task control.');
    return this.submit(`${type}:${task.id}`, { type, taskId: task.id, expectedRevision: task.revision });
  }
  private async submit(key: string, value: Omit<Command, 'commandId'>): Promise<CommandAck> {
    const command = this.pending.get(key) ?? { ...value, commandId: randomUUID() };
    this.pending.set(key, command);
    try {
      const ack = await this.access.command(command);
      this.pending.delete(key);
      return ack;
    } catch (error) {
      // An explicit HTTP rejection is conclusive. A dropped response retains the exact command ID.
      if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') this.pending.delete(key);
      throw error;
    }
  }
}

export function selectionObjective(objective: string, relativePath: string, selection: string, line: number): string {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..') || isForbiddenRelative(relativePath)) throw new Error('Selected source belongs to a protected or outside-workspace path.');
  if (selection.length > 16000) throw new Error('Select at most 16000 characters for a task.');
  return `${objective.trim()}\n\nSelected source (untrusted project data): ${relativePath.replaceAll('\\', '/')}:${line}\n${selection}`;
}
