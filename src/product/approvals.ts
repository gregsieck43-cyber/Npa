import { randomUUID } from 'node:crypto';
import type { Intent, Task } from '../contracts.js';
import type { ApprovalRequest, Capability, ReviewVerdict, RiskLevel } from '../frontend/api/types.js';
import type { ProductRuntime, ApprovalDecision } from './shared.js';
import { notFound, ProductError } from './shared.js';

const PREVIEW_LIMIT = 4000;

/**
 * Operator-facing approval projection. Only a prepared intent whose policy outcome is exactly "ask"
 * is actionable by a human; review outcomes stay with the independent reviewer. The preview is a
 * redacted argument summary, never the internal authorization record.
 */
export class ProductApprovals {
  constructor(private readonly rt: ProductRuntime) {}

  pending(sessionId?: string): ApprovalRequest[] {
    this.rt.harness.workTrace.sync();
    // The Kernel query selects actionable intents first and bounds them; an empty session id keeps
    // the legacy meaning of "no filter" instead of becoming a task id.
    const taskId = sessionId || undefined;
    const pending = this.rt.services.kernel.pendingApprovals(taskId === undefined ? { limit: 200 } : { taskId, limit: 200 });
    return pending.map(item => this.view(item.intent, item.task, item.preparedAt));
  }

  view(intent: Intent, task?: Task, preparedAt?: string | null): ApprovalRequest {
    const authorization = intent.authorization;
    if (!authorization) notFound('The approval has no policy record.');
    const capability: Capability = authorization.capability;
    const risk: RiskLevel = authorization.risk;
    const command = typeof intent.arguments.command === 'string' ? intent.arguments.command
      : typeof intent.arguments.cmd === 'string' ? intent.arguments.cmd as string : undefined;
    const patch = ['patch', 'diff'].map(key => intent.arguments[key]).find(value => typeof value === 'string') as string | undefined;
    const raw = command ?? patch ?? JSON.stringify(intent.arguments);
    const preview = this.rt.harness.sanitize(raw.length > PREVIEW_LIMIT ? raw.slice(0, PREVIEW_LIMIT) + '\n… (truncated)' : raw);
    const review = authorization.review ? this.review(authorization.review) : undefined;
    // undefined means this caller did not load the joined row; fetch the exact column. null means the
    // prepared event is genuinely missing, so the API reports an empty time plus known=false instead
    // of inventing task.updatedAt.
    const origin = preparedAt === undefined ? this.rt.services.kernel.preparedAt(intent.id) : preparedAt ?? undefined;
    return {
      id: intent.id, sessionId: intent.taskId, toolCallId: intent.toolCallId,
      title: this.title(intent.name), reason: this.rt.harness.sanitize([authorization.reason, ...(['run_command', 'run_shell'].includes(intent.name) ? [this.rt.services.kernel.coordination.commandWarning(intent.taskId)] : [])].filter(Boolean).join(' ')),
      capability, risk, preview, previewKind: command ? 'command' : patch ? 'diff' : 'json',
      digest: intent.digest, createdAt: origin ?? '', createdAtKnown: origin !== undefined,
      ...(review ? { review } : {}),
      ...(intent.fileConflicts?.conflicts.length ? { conflict: { fingerprint: intent.fileConflicts.fingerprint,
        participants: intent.fileConflicts.conflicts.map(claim => ({ taskId: claim.taskId, path: claim.path, mode: claim.mode })) } } : {}),
    };
  }

  decide(approvalId: string, decision: ApprovalDecision): void {
    const intent = this.rt.services.kernel.getIntent(approvalId);
    if (!intent) notFound('Approval not found: ' + approvalId);
    const task = this.rt.services.kernel.getTask(intent.taskId);
    if (!task) notFound('The task behind this approval no longer exists.');
    if (intent.state !== 'prepared') throw new ProductError('stale', 'This approval is no longer pending; refresh the approval list.', 409);
    if (intent.generation !== task.generation || intent.policyEpoch !== task.policyEpoch)
      throw new ProductError('stale', 'This approval was prepared for an older policy generation; refresh the approval list.', 409);
    if (decision.approved && intent.authorization?.decision === 'review')
      throw new ProductError('conflict', 'This effect requires an independent review before it can be approved.', 409);
    if (decision.approved && intent.authorization?.decision === 'deny')
      throw new ProductError('denied', 'The safety policy denies this effect.', 403);
    try {
      if (decision.approved) {
        this.rt.services.command({ commandId: randomUUID(), type: 'grant', taskId: task.id, expectedRevision: task.revision,
          parameters: { intentId: intent.id, scope: decision.scope, expectedIntentDigest: decision.expectedIntentDigest, expectedConflictFingerprint: decision.expectedConflictFingerprint } });
      } else {
        this.rt.services.command({ commandId: randomUUID(), type: 'deny', taskId: task.id, expectedRevision: task.revision,
          parameters: { intentId: intent.id, reason: decision.note?.trim() || 'Operator denied this effect' } });
      }
    } catch (error) { throw this.error(error); }
    this.rt.harness.workTrace.sync();
  }

  private error(error: unknown): ProductError {
    const message = this.rt.harness.sanitize(error instanceof Error ? error.message : String(error));
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
    if (/STALE|REVISION|ALREADY_DISPATCHED|EFFECT_ALREADY/.test(code + ' ' + message)) return new ProductError('stale', message, 409);
    if (/DENIED|FORBIDDEN|POLICY/.test(code + ' ' + message)) return new ProductError('denied', message, 403);
    return new ProductError('conflict', message, 409);
  }

  private title(name: string): string {
    if (/^(run_shell|run_command|terminal)/.test(name)) return '执行终端命令前确认';
    if (/^(write_file|apply_patch|edit)/.test(name)) return '写入工作区文件前确认';
    return '执行工具前确认：' + name;
  }

  private review(record: NonNullable<NonNullable<Intent['authorization']>['review']>): ReviewVerdict {
    const checks = Array.isArray(record.checks) ? record.checks.map(check => ({ label: check.label, ok: check.ok })) : [];
    return { reviewer: record.reviewer, verdict: record.verdict, risk: record.risk, reason: this.rt.harness.sanitize(record.reason), checks, durationMs: record.durationMs };
  }
}
