import { createHash, randomUUID } from 'node:crypto';
import type { Intent, Task, TaskStatus } from '../contracts.js';
export type Capability = 'workspace.read' | 'workspace.write' | 'process.exec' | 'plugin.execute' | 'fixture.write' | 'network.read' | 'mcp.call';
export interface Run {
    id: string;
    taskId: string;
    generation: number;
    policyEpoch: number;
    status: string;
    startedAt: string;
    endedAt?: string;
}
export interface Decision {
    id: string;
    taskId: string;
    runId: string;
    record: Record<string, unknown>;
    createdAt: string;
}
export interface Verification {
    id: string;
    taskId: string;
    runId: string;
    record: Record<string, unknown>;
    snapshot: {
        revision: number;
        goalVersion: number;
        generation: number;
        policyEpoch: number;
    };
    createdAt: string;
}
export interface Checkpoint {
    id: string;
    taskId: string;
    runId: string;
    context: Record<string, unknown>;
    digest: string;
    eventSeq: number;
    messageCount: number;
    createdAt: string;
}
export interface Budget {
    taskId: string;
    maxModelCalls: number;
    modelCalls: number;
    maxToolCalls: number;
    toolCalls: number;
}
export interface SideBudget {
    taskId: string;
    sessionId: string;
    maxModelCalls: number;
    modelCalls: number;
}
export interface Delegation {
    id: string;
    taskId: string;
    childTaskId: string;
    owner: string;
    state: string;
    result?: string;
    createdAt: string;
    settledSnapshot?: Verification['snapshot'];
    verificationId?: string;
    reason?: string;
    parentGoalVersion?: number;
}
export interface RecoverySummary {
    requeued: string[];
    unknownIntents: string[];
    reconciling: string[];
    waitingChildren: string[];
}
export type WorkOriginState = 'pending' | 'ready' | 'failed';
/** Durable preparation record for a paused Work branch whose immutable origin may cross a crash. */
export interface WorkOriginPreparation {
    taskId: string;
    sourceTaskId: string;
    sourceMessageId: string;
    snapshot: number;
    expectedCount: number;
    state: WorkOriginState;
    actualCount?: number;
    reason?: string;
    createdAt: string;
    updatedAt: string;
}
/** Keyset position in the pending preparation page; matches the task_origins_state(state, updated_at) index. */
export interface WorkOriginCursor {
    updatedAt: string;
    taskId: string;
}
export interface ApproveOptions {
    expectedIntentDigest?: string;
    expectedConflictFingerprint?: string;
    scope?: 'once' | 'session';
    /** Which authority approves: a human operator, the policy table, or an independent reviewer. */
    source?: 'operator' | 'policy' | 'review' | 'session';
}
export interface PrepareOptions {
    effectKey?: string;
    capability?: string;
    paths?: string[];
    /** Exact external resources this effect touches (URL, mcp://server/tool, workspace root). Defaults to the resolved paths. */
    resources?: string[];
}
export interface DerivedMemory {
    id: string;
    taskId: string;
    sessionId: string;
    kind: 'episode-summary';
    text: string;
    sourceIds: string[];
    sources: { id: string; hash: string }[];
    sourceDigest: string;
    createdAt: string;
}
export interface MemoryInput {
    sourceIds: string[];
    text: string;
    kind: 'episode-summary';
    sessionId?: string;
}
export interface TaskSchedule { taskId: string; due: number; consecutiveFailures: number; reason?: string; }
export interface ActivityDay { date: string; events: number; modelCalls: number; toolEffects: number; tasksCreated: number; tasksCompleted: number; }
export interface Activity { timezone: 'UTC'; startDate: string; endDate: string; days: ActivityDay[]; }
/**
 * One actionable prepared intent joined with its task. preparedAt is the exact historical
 * intent.prepared event time, or null when that event is missing (unknown). Null must never be
 * replaced with the task's mutable updatedAt; that would invent a history the store cannot prove.
 */
export interface PendingApproval {
    intent: Intent;
    task: Task;
    preparedAt: string | null;
}
export class KernelError extends Error {
    constructor(public readonly code: string, message: string) { super(message); this.name = 'KernelError'; }
}
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const capabilities: Capability[] = ['workspace.read', 'workspace.write', 'process.exec', 'plugin.execute', 'fixture.write', 'network.read', 'mcp.call'];
function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    return `{${Object.keys(value as object).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
export function fail(code: string, message: string): never { throw new KernelError(code, message); }
export const terminal = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);
export const transitions: Record<TaskStatus, TaskStatus[]> = {
    queued: ['running', 'paused', 'failed', 'cancelled', 'reconciling'],
    running: ['queued', 'waiting_approval', 'waiting_input', 'waiting_children', 'paused', 'reconciling', 'completed', 'failed', 'cancelled'],
    // A changed file or tool definition can invalidate approval before dispatch and require new input.
    waiting_approval: ['running', 'queued', 'waiting_input', 'paused', 'reconciling', 'failed', 'cancelled'],
    waiting_input: ['queued', 'paused', 'completed', 'failed', 'cancelled'],
    waiting_children: ['queued', 'paused', 'reconciling', 'failed', 'cancelled'],
    paused: ['queued', 'reconciling', 'cancelled'],
    reconciling: ['queued', 'paused', 'completed', 'failed', 'cancelled'],
    completed: [], failed: ['cancelled'], cancelled: [],
};
