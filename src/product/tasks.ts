import { randomUUID } from 'node:crypto';
import type { Task } from '../contracts.js';
import type { Checkpoint, Verification } from '../kernel/types.js';
import type {
  CheckpointView, PlanStep, SubagentView, TaskControl, TaskDetail, TaskStatus,
} from '../frontend/api/types.js';
import { invalid, notFound, ProductError, type ProductRuntime } from './shared.js';
import { kernelError, type ProductSessions } from './sessions.js';

const CONTROLS: readonly TaskControl[] = ['pause', 'resume', 'cancel', 'retry', 'checkpoint', 'enter_plan', 'approve_plan'];
const PLAN_TERMINAL = new Set(['completed', 'failed', 'cancelled']);

interface VerificationRecord {
  passed?: unknown;
  requiresManual?: unknown;
  checks?: unknown;
  evidence?: unknown;
}

/**
 * Task display projections. Status, budgets and verdicts are read from Kernel records on every call;
 * this module never keeps a second task state or invents progress.
 */
export class ProductTasks {
  constructor(private readonly rt: ProductRuntime, private readonly sessions: ProductSessions) {}

  get(sessionId: string): TaskDetail | undefined {
    const task = this.rt.services.kernel.getTask(sessionId);
    return task ? this.detail(task) : undefined;
  }

  control(taskId: string, action: TaskControl, input?: { expectedRevision?: number; plan?: Task['plan'] }): TaskDetail {
    if (!CONTROLS.includes(action)) invalid('action must be pause, resume, cancel, retry or checkpoint.');
    const task = this.rt.services.kernel.getTask(taskId);
    if (!task) notFound('Task not found: ' + taskId);
    if (action === 'checkpoint') {
      const run = this.rt.services.kernel.currentRunningRun(task.id) ?? this.rt.services.kernel.presentation(task.id).runs[0];
      if (!run) throw new ProductError('conflict', 'The task has no run to bind a checkpoint to.', 409);
      this.rt.services.kernel.checkpoint(task.id, run.id, { source: 'product-manual-checkpoint' });
      this.rt.harness.workTrace.sync();
      const current = this.rt.services.kernel.getTask(task.id);
      if (!current) notFound('Task not found: ' + taskId);
      return this.detail(current);
    }
    try {
      if (action === 'approve_plan' && (!input?.plan || !Number.isSafeInteger(input.expectedRevision))) invalid('Approval requires the displayed plan and task revision.');
      this.rt.services.command({ commandId: randomUUID(), type: action, taskId: task.id, expectedRevision: input?.expectedRevision ?? task.revision, origin: 'operator', parameters: input?.plan ? { plan: input.plan } : undefined });
    } catch (error) { throw kernelError(error); }
    this.rt.harness.workTrace.sync();
    const current = this.rt.services.kernel.getTask(task.id);
    if (!current) notFound('Task not found: ' + taskId);
    return this.detail(current);
  }

  detail(task: Task): TaskDetail {
    const budget = this.budget(task);
    const schedule = this.rt.services.kernel.getSchedule(task.id);
    return {
      id: task.id, title: task.title, status: task.status as TaskStatus, phase: task.executionPhase === 'planning' ? '规划中' : task.executionPhase === 'awaiting_plan_confirmation' ? '等待确认计划' : task.status,
      revision: task.revision, executionPhase: task.executionPhase ?? 'executing', ...(task.plan ? { planReference: task.plan } : {}),
      goal: { objective: task.goal.objective, constraints: [...task.goal.constraints], acceptance: [...task.goal.acceptance], mode: task.goal.mode },
      plan: this.plan(task), budget, checkpoints: this.checkpoints(task.id), subagents: this.subagents(task.id),
      verification: this.verification(task.id), startedAt: task.createdAt, updatedAt: task.updatedAt,
      ...((task.waitingReason || schedule.clockDiagnostic) ? { waitingReason: [task.waitingReason, schedule.clockDiagnostic].filter(Boolean).join(' · ') } : {}),
    };
  }

  private budget(task: Task): TaskDetail['budget'] {
    let modelCalls = task.modelCalls;
    let maxModelCalls = task.goal.maxModelCalls;
    let toolCalls = 0;
    let maxToolCalls = task.goal.maxToolCalls ?? 500;
    try {
      const stored = this.rt.services.kernel.getBudgets(task.id);
      modelCalls = stored.modelCalls; maxModelCalls = stored.maxModelCalls; toolCalls = stored.toolCalls; maxToolCalls = stored.maxToolCalls;
    } catch { /* A missing budget row is reported through the goal maxima rather than invented usage. */ }
    let tokens = 0;
    try { tokens = this.rt.harness.store.metrics({ taskId: task.id }).totalTokens ?? 0; }
    catch { /* Metrics remain unavailable until the harness has observed a request. */ }
    return { modelCalls, maxModelCalls, toolCalls, maxToolCalls, tokens };
  }

  /** One honest lifecycle step derived from the Kernel status, not a second plan authority. */
  private plan(task: Task): PlanStep[] {
    const plan = this.rt.services.integrations.plan(task.id);
    if (plan) return plan.nodes.map(node => ({ id: node.id, title: node.title,
      status: node.status === 'completed' ? 'done' : ['failed', 'cancelled', 'paused'].includes(node.status) ? 'blocked' : node.status === 'not_delegated' || node.status === 'queued' ? 'todo' : 'active',
      detail: [node.objective, node.dependencies.length ? `依赖：${node.dependencies.join('、')}` : '', node.blockedReason ?? ''].filter(Boolean).join(' · ') }));
    const status: PlanStep['status'] = task.status === 'queued' ? 'todo'
      : PLAN_TERMINAL.has(task.status) ? (task.status === 'completed' ? 'done' : 'blocked') : 'active';
    const detail = task.waitingReason ?? (task.status === 'waiting_approval' ? 'Waiting for operator approval' : undefined);
    return [{ id: 'execute', title: '执行并验证目标', status, ...(detail ? { detail } : {}) }];
  }

  private checkpoints(taskId: string): CheckpointView[] {
    return this.rt.services.kernel.recentCheckpoints(taskId, 20).map((checkpoint: Checkpoint) => {
      const label = typeof checkpoint.context.label === 'string' && checkpoint.context.label ? checkpoint.context.label : '检查点 · ' + checkpoint.createdAt;
      return { id: checkpoint.id, label, createdAt: checkpoint.createdAt, messageCount: checkpoint.messageCount, digest: checkpoint.digest };
    });
  }

  private subagents(taskId: string): SubagentView[] {
    return this.rt.services.kernel.subagentSummaries(taskId).map(child => ({
      id: child.id, role: 'worker', title: child.title, status: child.status as TaskStatus,
      model: this.sessions.rt.store.getSession(child.taskId)?.modelId ?? 'unknown', sessionId: child.taskId,
    }));
  }

  private verification(taskId: string): TaskDetail['verification'] {
    const latest: Verification | undefined = this.rt.services.kernel.latestVerification(taskId);
    if (!latest) return { status: 'pending', items: [] };
    const record = (latest.record ?? {}) as VerificationRecord;
    const items: TaskDetail['verification']['items'] = [];
    if (Array.isArray(record.checks)) {
      for (const [index, raw] of record.checks.slice(0, 50).entries()) {
        const check = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
        const label = typeof check.label === 'string' ? check.label : typeof check.name === 'string' ? check.name : '检查 ' + (index + 1);
        const status = check.ok === true || check.passed === true || check.status === 'pass' ? 'pass'
          : check.status === 'unknown' ? 'unknown' : 'fail';
        items.push({ label, status });
      }
    }
    const passed = record.passed === true || (items.length > 0 && items.every(item => item.status === 'pass'));
    if (!items.length) items.push({ label: '独立验证结论', status: record.passed === true ? 'pass' : record.passed === false ? 'fail' : 'unknown' });
    const status = record.requiresManual === true ? 'unknown' : passed ? 'pass' : items.some(item => item.status === 'fail') ? 'fail' : 'unknown';
    return { status, items };
  }
}
