import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { COORDINATION_TOOLS } from '../runtime/coordination-tools.js';
import type { Task, ToolCall, ToolDefinition, Intent, IntentFailure, ModelResult, WireMessage, ProviderConfig, RiskLevel, ToolReviewRecord, McpDefinitionSnapshot } from '../contracts.js';
import { Kernel, KernelError, digest } from '../kernel/index.js';
import { ToolGateway, type PreparedTool, type ToolOutcome } from '../tools/gateway.js';
import { buildContext, projectInputBatch } from '../runtime/context.js';
import { workingContextBudget } from '../runtime/context-budget.js';
import { compactPhase } from '../runtime/phase-summary.js';
import { memoryTool, MEMORY_TOOL_NAMES } from '../memory/tools.js';
import { skillTool, SKILL_TOOL_NAMES } from '../runtime/skill-tools.js';
import type { ScopedMemoryPort } from '../memory/tools.js';
import { TOOL_DEFINITIONS, rolePrompt } from '../runtime/prompts.js';
import { ModelDiagnosticError } from '../runtime/model.js';
import { CandidateManager } from '../adaptation/index.js';
import { loadInstructions } from '../runtime/instructions.js';
import { Configuration } from './configuration.js';
import { inspectEffects, readReviewEvidence } from './verification.js';
import { archiveArtifact } from './artifacts.js';
import { ExternalTools, EXTERNAL_TOOL_DEFINITIONS } from './external-tools.js';
import { digestValue, ToolPolicyError } from '../tools/policy.js';
import { FileVersionChangedError } from '../kernel/read-set.js';
import { PluginManager } from '../extensions/plugins.js';
import type { ModelClient } from '../runtime/model.js';
import type { RequestContext } from '../harness/types.js';
import { workSources } from '../harness/work-trace.js';
import type { IdeEditors } from '../ide/editors.js';
import type { IntegrationTools } from '../integrations/tools.js';
import { COLLABORATION_TOOL_DEFINITIONS, type IntegrationService, type PlanNodeInput } from '../integrations/index.js';
import { createToolReviewer, type ReviewRisk } from '../runtime/tool-review.js';
import { resourceBudget } from './resource-budget.js';
import { observeCommandFiles, observedChanges, observationCoverage } from './command-observation.js';
const capability: Record<string, string> = { 'fs.read': 'workspace.read', 'fs.write': 'workspace.write', 'process.run': 'process.exec', 'fixture.write': 'fixture.write' };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** A review either produced a record or degraded before a verdict could be recorded. */
type ReviewAttempt = { kind: 'record'; record: ToolReviewRecord } | { kind: 'degraded'; reason: string };
/** The structured failure diagnostic ExternalTools serializes into outcome.output. */
type ToolFailureDiagnostic = { code: string; message?: string; tool?: string; source?: string; attempts?: unknown[] };
/** Tools whose failure is determinate for an intent: read-only, no side effect beyond the request. */
const READ_ONLY_NETWORK_TOOLS = new Set(['web_search', 'web_fetch', 'web_crawl']);
/** Reads the structured diagnostic ExternalTools serializes into ToolOutcome.output. */
function diagnosticOf(outcome: ToolOutcome): ToolFailureDiagnostic | undefined {
    if (!outcome.output) return undefined;
    try {
        const error = (JSON.parse(outcome.output) as { error?: unknown } | null)?.error;
        if (error && typeof error === 'object' && !Array.isArray(error) && typeof (error as { code?: unknown }).code === 'string')
            return error as ToolFailureDiagnostic;
    } catch {
        // Not every executor returns JSON; a non-diagnostic payload keeps the legacy reason.
    }
    return undefined;
}
/** Copies only the diagnostic fields a terminal network failure may carry; the kernel revalidates them. */
function networkFailure(intent: Intent, diagnostic: ToolFailureDiagnostic, redact: (value: string) => string): IntentFailure | undefined {
    if (diagnostic.source !== 'network' || diagnostic.tool !== intent.name) return undefined;
    const attempts = Array.isArray(diagnostic.attempts) && diagnostic.attempts.every(attempt => attempt && typeof attempt === 'object' && !Array.isArray(attempt)) ? diagnostic.attempts : undefined;
    return {
        code: diagnostic.code,
        ...(typeof diagnostic.message === 'string' ? { message: redact(diagnostic.message) } : {}),
        tool: intent.name,
        source: 'network',
        ...(attempts ? { attempts } : {}),
    };
}
/**
 * The one honest tool result for a terminal network failure. `executed` is true because the effect
 * was dispatched and the request may already have reached the network; no output is implied.
 */
function failureToolContent(failure: IntentFailure): string {
    const error: Record<string, unknown> = { code: failure.code };
    if (failure.message) error.message = failure.message;
    error.tool = failure.tool;
    error.source = failure.source;
    if (failure.attempts) error.attempts = failure.attempts;
    return JSON.stringify({ error, executed: true, effect: 'failed', recovery: 'The effect was already dispatched and failed; it is not retried automatically. Continue with a different allowed action or stop with what you have.' });
}
export class Runner {
    readonly managedExternally = ((runner: Runner) => ({
        add: (taskId: string) => runner.kernel.manageExternally(taskId),
        has: (taskId: string) => runner.kernel.isManagedExternally(taskId),
        get size() { return runner.kernel.externallyManagedTaskCount(); },
    }))(this);
    modelClient?: (context: RequestContext) => ModelClient;
    /** Harness records the first actual preparation, applying that request's content policy. */
    mcpDefinitionPrepared?: (taskId: string, requestId: string, toolCallId: string, definition: McpDefinitionSnapshot) => void;
    /** Display-selected profile/reasoning for a Work task; read-only projection of the product index. */
    selection?: (taskId: string) => { profileId?: string; reasoningEffort?: string } | undefined;
    maintainPresence?: () => Promise<void>;
    private presenceMaintenance?: Promise<void>;
    originMemory?: (taskId: string) => ScopedMemoryPort | undefined;
    integrations?: IntegrationTools;
    collaboration?: IntegrationService;
    /** Persistent Settings.autoReview; absent means an independent reviewer cannot run. */
    reviewSettings?: () => { reviewerModelId: string; profileId: string; escalateAt: RiskLevel } | undefined;
    /** Settings-owned persistent skill switches; the two instruction loads below must share them. */
    skillSettings?: { disabledSkillIds(): string[] };
    /** Hands a review that could not be evaluated to human approval, without inventing a verdict. */
    reviewBridge?: { escalate(intentId: string, reason: string): void };
    private readonly active = new Map<string, AbortController>();
    private timer?: NodeJS.Timeout;
    private wakeTimer?: NodeJS.Timeout;
    private unsubscribe?: () => void;
    private stopping = false;
    private dispatchCursor = 0;
    private claimMaintenanceAt = -Infinity;
    constructor(readonly kernel: Kernel, readonly configuration: Configuration, readonly candidates: CandidateManager, readonly dataDir: string, readonly external?: ExternalTools, readonly plugins?: PluginManager, readonly editors?: IdeEditors) {
    }
    gateway(task: Task): ToolGateway {
        mkdirSync(task.workspace, { recursive: true });
        return new ToolGateway({ workspace: task.workspace, receiptDirectory: path.join(this.dataDir, 'receipts', task.id), getReadVersion: filename => this.kernel.getWriteReadVersion(task.id, filename), assertWritable: filename => this.editors?.assertWritable(filename), assertWorkspaceClean: workspace => this.editors?.assertWorkspaceClean(workspace) });
    }
    start() {
        if (this.timer) return;
        this.stopping = false;
        this.kernel.coordination.start();
        this.unsubscribe = this.kernel.onCommitted(() => this.wake());
        // Durable retry deadlines and unknown-effect reconciliation also need a timed wakeup.
        this.timer = setInterval(() => this.tick(), 1000);
        this.tick();
    }
    private wake() {
        if (this.stopping || this.wakeTimer) return;
        this.wakeTimer = setTimeout(() => { this.wakeTimer = undefined; this.tick(); }, 0);
    }
    async stop() {
        this.stopping = true;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        clearTimeout(this.wakeTimer);
        this.wakeTimer = undefined;
        clearInterval(this.timer);
        this.timer = undefined;
        for (const signal of this.active.values())
            signal.abort();
        while (this.active.size)
            await sleep(25);
        await this.presenceMaintenance;
        this.kernel.coordination.stop();
    }
    interrupt(taskId: string, recursive = true) {
        this.active.get(taskId)?.abort();
        this.kernel.clearReconciliationDue(taskId);
        for (const task of recursive ? this.kernel.childTasks(taskId) : [])
            this.interrupt(task.id);
    }
    private tick() {
        if (!this.stopping) { this.kernel.coordination.restorePage(); this.kernel.coordination.maintain(); }
        if (!this.stopping && performance.now() - this.claimMaintenanceAt >= 15000) {
            this.claimMaintenanceAt = performance.now(); this.kernel.fileClaims.maintain();
            if (!this.presenceMaintenance && this.maintainPresence) this.presenceMaintenance = this.maintainPresence().finally(() => { this.presenceMaintenance = undefined; });
        }
        const capacity = resourceBudget.concurrency();
        if (this.stopping || this.active.size >= capacity) return;
        const page = this.kernel.runnableTaskPage(this.dispatchCursor, 100);
        this.dispatchCursor = page.nextCursor ?? 0;
        for (let task of page.items) {
            if (this.managedExternally.has(task.id)) continue;
            if (task.status === 'waiting_children' && !this.active.has(task.id)) {
                if (this.kernel.delegationTasksTerminal(task.id))
                    task = this.kernel.transition(task.id, 'queued');
            }
            if (this.active.size >= capacity)
                break;
            const terminalReconciliation = ['paused', 'cancelled', 'failed', 'completed'].includes(task.status);
            if (!this.active.has(task.id) && (['queued', 'reconciling', 'waiting_approval'].includes(task.status) || terminalReconciliation)) {
                const controller = new AbortController();
                this.active.set(task.id, controller);
                void this.execute(task.id, controller.signal).catch(error => this.recordFailure(task.id, error, task.generation)).finally(() => { this.active.delete(task.id); this.wake(); });
            }
        }
    }
    private recordFailure(taskId: string, error: unknown, generation: number) {
        const task = this.kernel.getTask(taskId)!;
        if (task.generation !== generation)
            return;
        if (['paused', 'cancelled'].includes(task.status))
            return;
        if (error instanceof Error && 'code' in error && ['STALE_GENERATION', 'STALE_RUN'].includes(String(error.code)))
            return;
        const message = this.configuration.redact(error instanceof Error ? error.message : String(error));
        if (this.stopping) {
            this.kernel.appendEvent(taskId, 'runtime.shutdown_interrupted', { message, recovery: 'Resume or reconcile from the persisted checkpoint on restart.' });
            return;
        }
        this.kernel.appendEvent(taskId, 'diagnostic.error', { message, ...(error instanceof ModelDiagnosticError ? { code: error.code, retryable: error.retryable, retryAfterMs: error.retryAfterMs } : {}) });
        if (error instanceof Error && 'code' in error && error.code === 'EDITOR_DIRTY') {
            this.kernel.transition(taskId, 'waiting_input', { waitingReason: message });
            return;
        }
        if (task.status !== 'reconciling') {
            if (error instanceof ModelDiagnosticError && error.retryable) this.kernel.scheduleModelRetry(taskId, generation, error.code, message, error.retryAfterMs);
            else this.kernel.transition(taskId, 'failed', { error: message });
        }
    }
    async assembleWork(taskId: string, config: ProviderConfig, adaptation = this.candidates.snapshotFor(taskId)) {
        const task = this.kernel.getTask(taskId);
        if (!task) throw new Error('Task not found.');
        let raw = this.kernel.tailMessages(taskId);
        while (raw[0]?.role === 'tool') raw.shift();
        // Keep the latest operator constraint even after more than 160 intervening tool/history rows.
        const latestUser = this.kernel.tailMessages(taskId, 1, 'main', 'user')[0];
        if (latestUser && !raw.some(message => message.id === latestUser.id)) raw.unshift(latestUser);
        const tools = [...TOOL_DEFINITIONS, ...COORDINATION_TOOLS, ...EXTERNAL_TOOL_DEFINITIONS, ...(this.collaboration ? COLLABORATION_TOOL_DEFINITIONS : []), ...(this.integrations?.definitions() ?? [])], maxChars = workingContextBudget(config, tools);
        const pending = this.kernel.userMessagesAfter(taskId, this.kernel.consumedUserInput(taskId).cursor, 32);
        const batch = projectInputBatch(pending, this.kernel.consumedUserInput(taskId), Math.max(512, Math.floor(maxChars / 4)));
        const selected = new Map(batch.messages.map(message => [message.id, message]));
        raw = [...batch.messages.filter(message => !raw.some(item => item.id === message.id)), ...raw.map(message => selected.get(message.id) ?? message)];
        const sampledUserInput = batch.progress, sampledUserCursor = sampledUserInput.cursor;
        const pendingInput = sampledUserInput.offset > 0 || sampledUserCursor < this.kernel.latestUserCursor(taskId);
        const targetPath = this.kernel.latestEvent(taskId, 'instruction.scope.loaded')?.payload.path as string | undefined;
        const instructions = await loadInstructions({ workspace: task.workspace, targetPath, globalPaths: this.configuration.globalPaths, skillRoots: this.configuration.skillRoots, ...(this.skillSettings ? { disabledSkillIds: this.skillSettings.disabledSkillIds() } : {}), query: `${task.goal.objective}\n${raw.filter(message => message.role === 'user').slice(-3).map(message => message.content).join('\n')}` });
        const archivedCount = this.kernel.messageCount(taskId) - raw.length;
        const runtimeMessages: WireMessage[] = [];
        const coordination = this.kernel.coordination.select(taskId);
        if (coordination) runtimeMessages.push({ role: 'system', content: coordination.text });
        if (adaptation.promptSuffix) runtimeMessages.push({ role: 'user', content: `Task-local adaptation (untrusted preference): ${adaptation.promptSuffix}` });
        if (pendingInput) runtimeMessages.push({ role: 'user', content: 'Input ingestion is incomplete. Read the source fragments in this request and retain their constraints with source IDs. Do not perform operations or claim completion; another ordinary request will present the next ordered fragment.' });
        runtimeMessages.push({ role: 'user', content: `Current saved goal and progress (program snapshot): ${JSON.stringify({ goalVersion: task.goalVersion, mode: task.goal.mode, executionPhase: task.executionPhase, goal: task.goal, budget: this.kernel.getBudgets(taskId),
            ...(this.collaboration ? { plan: this.collaboration.planHeader(taskId) } : {}),
            delegations: this.kernel.delegationProgress(taskId), predecessors: this.kernel.dependencyProgress(taskId) })}` });
        const origin = this.originMemory?.(taskId);
        const memory = this.kernel.memory(taskId).context(`${task.goal.objective}\n${raw.filter(message => message.role === 'user').slice(-2).map(message => message.content).join('\n')}`, Math.min(6000, Math.floor(maxChars / 5)), task.goalVersion)
            + (origin ? `\nRead-only origin Chat snapshot: ${JSON.stringify(origin.manifest())}. Use search_history/read_history with source=origin_chat for the complete original conversation, not just the promotion preview.` : '');
        // A tools-carrying Work request must replay every selected assistant reasoning per the official
        // thinking-mode contract; the shared projection counts it and keeps each exchange whole.
        const context = buildContext({ messages: raw, archivedCount, runtimeMessages, memory, maxChars, goal: task.goal,
            role: task.parentId ? 'worker' : 'main', instructions, includeReasoning: tools.length > 0,
            requiredMessageIds: [...batch.messages.map(message => message.id), ...(latestUser ? [latestUser.id] : [])],
            exactMessageIds: batch.messages.map(message => message.id), inputRanges: batch.ranges,
            originalSourceHashes: Object.fromEntries(pending.map(({ message }) => [message.id, createHash('sha256').update(JSON.stringify(message)).digest('hex')])) });
        const sources = workSources(context, instructions);
        if (coordination) sources.push({ id: 'coordination-manifest', label: '工作区运行时通知', role: 'system', content: coordination.text, source: 'kernel:coordination', scope: 'request', estimatedTokens: Math.ceil(coordination.text.length / 4), effective: true });
        return { context, tools: pendingInput ? [] : tools, sources, coordination, adaptation, archivedCount, sampledUserCursor, sampledUserInput, pendingInput };
    }
    private async execute(taskId: string, signal: AbortSignal) {
        let task = this.kernel.getTask(taskId)!;
        this.collaboration?.activateApprovedPlan(taskId);
        task = this.kernel.getTask(taskId)!;
        if (task.status === 'reconciling' || ['paused', 'cancelled', 'failed', 'completed'].includes(task.status)) {
            await this.reconcile(task);
            return;
        }
        const run = task.status === 'waiting_approval' ? this.kernel.currentRunningRun(taskId) : this.kernel.createRun(taskId);
        if (!run) throw new Error('The approval continuation has no current durable execution owner.');
        this.kernel.coordination.join(taskId);
        await this.maintainPresence?.();
        const adaptation = this.candidates.snapshotFor(taskId);
        this.kernel.appendEvent(taskId, 'runtime.pinned', { adaptation });
        this.kernel.transition(taskId, 'running');
        const gateway = this.gateway(task);
        while (!signal.aborted) {
            await resourceBudget.wait(signal);
            this.kernel.assertFence(taskId, run.id);
            task = this.kernel.getTask(taskId)!;
            const pending = this.pendingCalls(taskId);
            if (pending.length) {
                for (const { call, messageId } of pending) {
                    await resourceBudget.wait(signal);
                    if (signal.aborted)
                        return;
                    await resourceBudget.withLease(signal, () => this.perform(task, run.id, call, messageId, gateway, signal));
                    if (this.kernel.getTask(taskId)!.status !== 'running')
                        return;
                }
                this.kernel.checkpoint(taskId, run.id, { source: 'tool-results', messages: this.kernel.messageCount(taskId) });
                continue;
            }
            await resourceBudget.withLease(signal, async () => {
            const selection = this.selection?.(taskId);
            const requestContext: RequestContext = { sessionId: taskId, taskId, runId: run.id, kind: 'work', parentId: task.parentId, sources: [], coordination: {},
                ...(selection?.profileId ? { profileId: selection.profileId } : {}), ...(selection?.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) };
            const client = this.modelClient?.(requestContext) ?? this.configuration.client(requestContext);
            const consumed = this.kernel.consumedUserInput(taskId), latestInput = this.kernel.latestUserCursor(taskId), budget = this.kernel.getBudgets(taskId);
            if (!this.kernel.progress.beforeRequest(taskId, run.id, this.kernel.progressInput(taskId, consumed))) return;
            if (!consumed.offset && consumed.cursor >= latestInput && budget.maxModelCalls - budget.modelCalls >= 3 && !this.kernel.hasUnsettledDelegations(taskId, task.goalVersion)) {
                const summaryContext: RequestContext = { ...requestContext, kind: 'review', sources: [] };
                const summaryClient = this.modelClient?.(summaryContext) ?? this.configuration.client(summaryContext);
                const summary = await compactPhase(this.kernel.memory(taskId), { goalVersion: task.goalVersion, config: summaryClient.config, signal,
                    stillCurrent: () => { const current = this.kernel.getTask(taskId)!; return current.status === 'running' && current.goalVersion === task.goalVersion && current.generation === task.generation && this.kernel.latestUserCursor(taskId) === latestInput; },
                    complete: async messages => { this.kernel.consumeModelCall(taskId, run.id); return summaryClient.complete(messages, [], signal); } });
                if (summary.reason !== 'no_retired_sources') this.kernel.appendEvent(taskId, 'context.phase_summary', summary);
            }
            this.kernel.assertFence(taskId, run.id);
            this.kernel.consumeModelCall(taskId, run.id);
            const { context, tools, sources, coordination, archivedCount, sampledUserCursor, sampledUserInput } = await this.assembleWork(taskId, client.config, adaptation);
            requestContext.coordination!.selection = coordination;
            requestContext.sources!.push(...sources);
            // Reserve the durable assistant identity before the first token. The product projection and
            // the Kernel row share this id, so a completed bubble resolves through Kernel/Inspector/history.
            const assistantMessageId = `msg-${randomUUID()}`;
            const started = this.kernel.appendEvent(taskId, 'model.stream.started', { runId: run.id, messageId: assistantMessageId });
            let streamed = '', streamedReasoning = '', lastFlush = 0;
            const result = this.configuration.sanitize(await client.complete(context.messages, tools, signal, delta => {
                streamed += delta.content ?? '';
                streamedReasoning += delta.reasoningContent ?? '';
                if (Date.now() - lastFlush > 200) {
                    this.kernel.assertFence(taskId, run.id);
                    // Only a bounded tail is projected per delta: a long answer or reasoning trace must not
                    // persist a full snapshot on every event, and the durable Kernel message is the authority.
                    this.kernel.appendEvent(taskId, 'model.stream.delta', { runId: run.id, messageId: assistantMessageId,
                        text: this.configuration.redact(streamed.slice(-16000)),
                        ...(streamedReasoning.trim() ? { reasoningText: this.configuration.redact(streamedReasoning.slice(-16000)) } : {}),
                        toolNames: delta.toolCalls?.map(call => call.name).filter(Boolean) });
                    lastFlush = Date.now();
                }
            }));
            this.kernel.appendEvent(taskId, 'model.stream.completed', { runId: run.id, messageId: assistantMessageId, requestId: result.requestId });
            this.kernel.assertFence(taskId, run.id);
            this.kernel.modelSucceeded(taskId, run.id);
            const inputIncomplete = sampledUserInput.offset > 0 || sampledUserCursor < this.kernel.latestUserCursor(taskId);
            if (inputIncomplete) {
                this.kernel.appendEvent(taskId, 'verification.stale', { phase: 'input', sampledUserCursor, sampledUserInput,
                    latestUserCursor: this.kernel.latestUserCursor(taskId), discardedToolCalls: result.toolCalls.length });
                result.toolCalls = [];
            }
            this.kernel.saveDecision(taskId, run.id, { providerSnapshot: client.config, contextManifest: context.sourceManifest, instructionSources: context.instructionSources, adaptation, omittedIds: context.omittedIds, archivedCount, result });
            const content = this.configuration.redact(result.content);
            const displayContent = this.configuration.redact(await this.candidates.applySnapshot(adaptation, content, signal));
            // Blank provider reasoning is absent, never an empty thinking block in the durable message.
            const reasoningContent = result.reasoningContent?.trim() ? this.configuration.redact(result.reasoningContent) : undefined;
            this.kernel.addMessage(taskId, 'assistant', content, 'main', { id: assistantMessageId, createdAt: started.createdAt, toolCalls: result.toolCalls,
                displayContent, requestId: result.requestId, sampledUserCursor, sampledUserInput, sampledAuthority: { generation: task.generation, goalVersion: task.goalVersion }, ...(reasoningContent ? { reasoningContent } : {}) });
            if (!result.toolCalls.length && !inputIncomplete) {
                await this.finish(taskId, run.id, { ...result, content }, gateway, signal, sampledUserCursor);
            }
            });
            if (this.kernel.getTask(taskId)!.status !== 'running') return;
        }
    }
    private pendingCalls(taskId: string) {
        return this.kernel.pendingCalls(taskId);
    }
    private async perform(task: Task, runId: string, call: ToolCall, messageId: string, gateway: ToolGateway, signal: AbortSignal) {
        const requestId = this.kernel.getMessage(messageId)?.requestId;
        const started = performance.now();
        try { await this.performEffect(task, runId, call, messageId, gateway, signal); }
        catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
            const stage = /DENIED|FORBIDDEN|SCOPE|WORKSPACE|OWNERSHIP/.test(code) ? 'permission' : /UNKNOWN|UNSUPPORTED/.test(code) ? 'unknown_tool' : 'validation';
            this.kernel.appendEvent(task.id, 'tool.execution', { requestId, toolCallId: call.id, runId, patch: { status: 'failed', failureStage: stage, error: this.configuration.redact(String(error)), durationMs: Math.round(performance.now() - started) } });
            // An operator-policy denial is a tool result with no approvable intent, not a crash: the
            // proposal was rejected before any effect existed, so the agent may choose another tool.
            if (['READ_REQUIRED', 'READ_VERSION_STALE', 'FILE_OPERATION_PENDING', 'FILE_CONFLICT_STALE', 'CONFLICT_APPROVAL_REQUIRED', 'CONFLICT_SCOPE_FORBIDDEN'].includes(code))
                this.toolMessage(task.id, call, JSON.stringify({ code, error: this.configuration.redact(error instanceof Error ? error.message : String(error)), executed: false,
                    recovery: code === 'FILE_OPERATION_PENDING' ? 'Another file operation is not yet settled. Coordinate or wait before proposing another write; do not replay unknown effects.' : 'Read the current file again, incorporate its contents, then propose a fresh change.' }));
            else if (stage === 'permission')
                this.toolMessage(task.id, call, JSON.stringify({ error: this.configuration.redact(error instanceof Error ? error.message : String(error)), executed: false, recovery: 'The current permission mode does not allow this effect. No approval is available; choose an allowed tool.' }));
            else throw error;
        }
    }
    private async performEffect(task: Task, runId: string, call: ToolCall, messageId: string, gateway: ToolGateway, signal: AbortSignal) {
        const effectKey = digest({ taskId: task.id, messageId, toolCallId: call.id });
        if (this.discardStaleProposal(task.id, call, messageId, effectKey)) return;
        const requestId = this.kernel.getMessage(messageId)?.requestId;
        const localStarted = performance.now();
        let local: string | undefined;
        try { local = await this.localTool(task, call, effectKey, signal, runId); }
        catch (error) {
            const message = this.configuration.redact(error instanceof Error ? error.message : String(error));
            this.kernel.appendEvent(task.id, 'tool.execution', { toolCallId: call.id, runId, patch: { status: 'failed', failureStage: 'permission', error: message } });
            this.toolMessage(task.id, call, JSON.stringify({ error: message }));
            return;
        }
        if (local !== undefined) {
            this.kernel.appendEvent(task.id, 'tool.execution', { toolCallId: call.id, runId, patch: { status: 'completed', permission: 'kernel_control', durationMs: Math.round(performance.now() - localStarted) } });
            this.toolMessage(task.id, call, local);
            if (call.name === 'finish') {
                const content = String(call.arguments.result ?? '');
                this.kernel.addMessage(task.id, 'assistant', content);
                await this.finish(task.id, runId, { content, toolCalls: [], finishReason: 'stop' }, gateway, signal, this.kernel.getMessage(messageId)?.sampledUserCursor);
            }
            return;
        }
        let intent = this.kernel.intentForEffect(effectKey);
        if (intent?.state === 'applied') {
            this.toolMessage(task.id, call, JSON.stringify(intent.receipt));
            return;
        }
        // A restarted process must deliver the failure it already recorded instead of dispatching
        // the effect again; the reply is the same one honest tool error, exactly once.
        if (intent?.state === 'failed') {
            if (!intent.failure) throw new Error('A terminally failed effect is missing its failure record.');
            this.toolMessage(task.id, call, failureToolContent(intent.failure));
            return;
        }
        if (intent?.state === 'denied' && !(intent as Intent & { recoveryRebindable?: boolean }).recoveryRebindable) {
            this.toolMessage(task.id, call, `Tool was denied: ${intent.error ?? 'not authorized'}`);
            return;
        }
        let external: PreparedTool | undefined, integration: PreparedTool | undefined, prepared: PreparedTool;
        try {
            if (intent?.name === 'write_file' && ['prepared', 'approved'].includes(intent.state))
                this.kernel.assertWriteReadVersion(intent.id);
            integration = await this.integrations?.prepare(task.workspace, call);
            external = integration ? undefined : this.external?.prepare(call);
            prepared = integration ?? external ?? await gateway.prepare(call);
            if (!intent && requestId && prepared.mcpDefinition)
                this.mcpDefinitionPrepared?.(task.id, requestId, call.id, prepared.mcpDefinition);
        } catch (error) {
            if (!signal.aborted && intent && ['prepared', 'approved', 'denied'].includes(intent.state) && (error instanceof ToolPolicyError || error instanceof FileVersionChangedError)) {
                this.rejectPreparedChange(task.id, runId, call, intent, error.message);
                return;
            }
            // Dispatched effects retain their reconciliation path. The IDE dirty-buffer guard
            // also keeps its existing approval while waiting for the operator to save or revert.
            if (intent || signal.aborted) throw error;
            this.kernel.assertFence(task.id, runId);
            const message = this.configuration.redact(error instanceof Error ? error.message : String(error));
            this.kernel.appendEvent(task.id, 'tool.execution', { toolCallId: call.id, runId, patch: { status: 'failed', failureStage: 'validation', error: message } });
            this.toolMessage(task.id, call, JSON.stringify({ error: message, executed: false, recovery: 'Correct the proposal or choose an allowed tool. Permissions have not changed.' }));
            return;
        }
        if (!intent && !external && typeof call.arguments.path === 'string') {
            const scoped = await loadInstructions({ workspace: task.workspace, targetPath: String(call.arguments.path), globalPaths: this.configuration.globalPaths, skillRoots: this.configuration.skillRoots, ...(this.skillSettings ? { disabledSkillIds: this.skillSettings.disabledSkillIds() } : {}), query: `${task.goal.objective}\n${this.kernel.tailMessages(task.id).filter(message => message.role === 'user').slice(-3).map(message => message.content).join('\n')}` });
            const known = this.kernel.latestDecision(task.id)?.record.instructionSources as { path: string; sha256: string }[] | undefined;
            const added = scoped.sources.filter(source => !known?.some(item => item.path === source.path && item.sha256 === source.sha256));
            if (added.length) {
                this.kernel.appendEvent(task.id, 'instruction.scope.loaded', { path: String(call.arguments.path), sources: added });
                const explicitProposal = this.kernel.hasToolProposal(task.id, call.id);
                if (!explicitProposal) {
                    this.toolMessage(task.id, call, `Scoped instructions must be considered before this operation. No effect was executed. Propose it again after reading:\n${scoped.text}`);
                    return;
                }
            }
        }
        if (intent && ['prepared', 'approved', 'denied'].includes(intent.state) && prepared.digest !== digestValue({ name: intent.name, arguments: intent.arguments })) {
            this.rejectPreparedChange(task.id, runId, call, intent, 'The tool artifact, file contents or connected tool definition changed since preparation.');
            return;
        }
        if (intent && intent.runId !== runId && ['prepared', 'approved'].includes(intent.state))
            intent = this.kernel.rebindIntent(intent.id, runId);
        if (intent && intent.runId !== runId && intent.state === 'denied' && (intent as Intent & {
            recoveryRebindable?: boolean;
        }).recoveryRebindable)
            intent = this.kernel.rebindIntent(intent.id, runId);
        if (intent?.state === 'denied') {
            this.toolMessage(task.id, call, `Tool was denied: ${intent.error ?? 'not authorized'}`);
            return;
        }
        if (!intent) {
            const paths = integration
                ? (prepared.arguments.manifest as { path: string }[]).map(file => path.resolve(task.workspace, file.path))
                : external ? [] : prepared.resources.filter(resource => !resource.startsWith('fixture:'));
            // paths describe file ownership; resources are the trusted artifact identities (for
            // example the exact network URL) that a session grant must match. Both are needed.
            intent = this.kernel.prepareIntent(task.id, runId, { ...call, arguments: prepared.arguments }, { effectKey, capability: capability[prepared.capability] ?? prepared.capability, paths, resources: prepared.resources });
        }
        if (intent.state === 'prepared') {
            if (['run_command', 'run_shell'].includes(call.name)) {
                const warning = this.kernel.coordination.commandWarning(task.id);
                if (warning) this.kernel.appendEvent(task.id, 'tool.execution', { toolCallId: call.id, runId, intentId: intent.id, patch: { description: warning } });
            }
            intent = await this.routeIntent(task, runId, intent, prepared, messageId, signal);
        }
        if (intent.state === 'denied') {
            this.kernel.transition(task.id, 'running');
            this.toolMessage(task.id, call, `Tool was denied: ${intent.error ?? 'not authorized'}`);
            return;
        }
        if (intent.state === 'prepared') {
            this.kernel.transition(task.id, 'waiting_approval', { waitingReason: `${call.name} requires approval of ${intent.digest}` });
            // The saved run and pending proposal retain authority while the operator thinks.
            // Grant/deny wakes the indexed scheduler; there is no retained polling owner or lease.
            return;
        }
        if (signal.aborted)
            return;
        if (this.discardStaleProposal(task.id, call, messageId, effectKey)) return;
        if (this.kernel.getTask(task.id)!.status === 'waiting_approval')
            this.kernel.transition(task.id, 'running');
        if (!external && !integration) gateway.assertWritable(prepared);
        const commandCandidates = ['run_command', 'run_shell'].includes(call.name) ? this.kernel.fileClaims.commandCandidates(task.id) : undefined;
        const commandBefore = commandCandidates ? await observeCommandFiles(task.workspace, commandCandidates.paths) : undefined;
        this.kernel.dispatch(intent.id);
        const executor = integration ? this.integrations! : external ? this.external! : gateway;
        const started = performance.now();
        const outcome = await executor.execute(prepared, { effectKey, approvedDigest: prepared.digest, signal });
        if (commandBefore && commandCandidates) {
            const after = await observeCommandFiles(task.workspace, commandCandidates.paths);
            this.kernel.coordination.commandObservation(task.id, intent.id, observedChanges(commandBefore, after), { ...observationCoverage(commandBefore, after), total: commandCandidates.total, omitted: commandCandidates.omitted, truncated: commandCandidates.truncated });
        }
        // The provider diagnostic must survive on the dispatch event: the free-text error alone drops
        // the machine-readable code and the attempted providers.
        const failure = outcome.status !== 'applied' || !outcome.receipt ? this.failureDiagnostic(outcome, external !== undefined) : undefined;
        const durationMs = Math.round(performance.now() - started);
        this.kernel.appendEvent(task.id, 'tool.execution', failure
            ? { ...(requestId ? { requestId } : {}), toolCallId: call.id, runId, intentId: intent.id, patch: { ...failure.patch, durationMs } }
            : { toolCallId: call.id, runId, intentId: intent.id, patch: { durationMs } });
        if (failure) {
            if (external) {
                // Trust the persisted ledger, not the in-flight return value: only a re-read that still
                // reports a failed record for this exact digest may end the intent as failed.
                let persisted: ToolOutcome | undefined;
                try { persisted = await this.external!.queryOutcome(effectKey, prepared.digest); }
                catch { persisted = undefined; }
                const diagnostic = persisted && persisted.status === 'failed' && !persisted.receipt ? diagnosticOf(persisted) : undefined;
                const terminal = diagnostic ? networkFailure(intent, diagnostic, value => this.configuration.redact(value)) : undefined;
                if (terminal) {
                    try {
                        this.kernel.failIntent(intent.id, terminal);
                    } catch (error) {
                        if (!(error instanceof KernelError)) throw error;
                        // The effect changed owner or state while the request was in flight. Keep its
                        // truthful unknown record for reconciliation instead of forcing a terminal state.
                        if (this.kernel.getIntent(intent.id)!.state !== 'sent') return;
                        this.kernel.unknown(intent.id, failure.reason);
                        return;
                    }
                    this.toolMessage(task.id, call, failureToolContent(terminal));
                    return;
                }
            }
            this.kernel.unknown(intent.id, failure.reason);
            return;
        }
        // failure covers every outcome without a receipt, so the receipt is present here.
        this.kernel.receipt(intent.id, outcome.receipt!);
        this.toolMessage(task.id, call, this.configuration.redact(outcome.output));
    }
    private discardStaleProposal(taskId: string, call: ToolCall, messageId: string, effectKey: string): boolean {
        const proposal = this.kernel.getMessage(messageId);
        const cursor = proposal?.sampledUserInput?.cursor ?? proposal?.sampledUserCursor;
        const current = this.kernel.getTask(taskId)!;
        const authorityChanged = !!proposal?.sampledAuthority && (proposal.sampledAuthority.generation !== current.generation || proposal.sampledAuthority.goalVersion !== current.goalVersion);
        if (!authorityChanged && (cursor === undefined || !proposal?.sampledUserInput?.offset && cursor >= this.kernel.latestUserCursor(taskId))) return false;
        const intent = this.kernel.intentForEffect(effectKey);
        // Effects already sent retain their reconciliation path; new instructions cannot erase reality.
        if (intent && ['sent', 'unknown', 'applied', 'failed'].includes(intent.state)) return false;
        if (intent && ['prepared', 'approved'].includes(intent.state)) this.kernel.deny(intent.id, 'User input or task authority superseded the sampled proposal before dispatch.');
        this.kernel.appendEvent(taskId, 'verification.stale', { phase: call.name === 'finish' ? 'input' : 'tool', toolCallId: call.id, sampledUserCursor: cursor, sampledAuthority: proposal?.sampledAuthority, latestUserCursor: this.kernel.latestUserCursor(taskId) });
        this.toolMessage(taskId, call, JSON.stringify({ executed: false, error: 'User input or task authority changed after this proposal was sampled. Read the current task and inputs before proposing further operations.' }));
        return true;
    }
    /**
     * Describes why an executed effect could not be receipted. Only the external executor emits a
     * JSON diagnostic ({ error: { code, message, tool, source, attempts? } }); any other payload or a
     * malformed one keeps the previous generic reason so the state machine is untouched.
     */
    private failureDiagnostic(outcome: ToolOutcome, external: boolean): { patch: Record<string, unknown>; reason: string } {
        const patch: Record<string, unknown> = { status: outcome.status === 'failed' ? 'failed' : 'unknown', failureStage: 'execution', outcomeStatus: outcome.status };
        const diagnostic = external ? diagnosticOf(outcome) : undefined;
        if (diagnostic) {
            patch.code = diagnostic.code;
            patch.tool = diagnostic.tool;
            patch.source = diagnostic.source;
            if (typeof diagnostic.message === 'string') patch.message = this.configuration.redact(diagnostic.message);
            if (Array.isArray(diagnostic.attempts)) patch.attempts = diagnostic.attempts;
        }
        const reason = diagnostic && typeof diagnostic.message === 'string'
            ? `${diagnostic.code}: ${this.configuration.redact(diagnostic.message)}`
            : outcome.error ?? 'Tool outcome unknown';
        return { patch, reason };
    }
    /** No dispatch occurred: invalidate only this approval and await review of the changed source. */
    private rejectPreparedChange(taskId: string, runId: string, call: ToolCall, intent: Intent, detail: string) {
        this.kernel.assertFence(taskId, runId);
        const reason = this.configuration.redact(`Prepared operation is no longer valid: ${detail}`);
        this.kernel.deny(intent.id, reason);
        this.kernel.appendEvent(taskId, 'tool.execution', { runId, toolCallId: call.id, intentId: intent.id, patch: { status: 'failed', failureStage: 'validation', error: reason } });
        this.toolMessage(taskId, call, JSON.stringify({ error: reason, executed: false, recovery: 'Review the changed source or tool definition, then submit a new proposal for a new approval. The previous approval cannot dispatch.' }));
        this.kernel.transition(taskId, 'waiting_input', { waitingReason: reason });
    }
    /**
     * Resolves one prepared intent through the operator's policy. Automatic review runs only for
     * its own decision, and an unavailable or degraded reviewer escalates to a human instead of pass.
     */
    private async routeIntent(task: Task, runId: string, intent: Intent, prepared: PreparedTool, messageId: string, signal: AbortSignal): Promise<Intent> {
        const decision = this.kernel.decideIntent(intent.id);
        if (decision.outcome === 'allow')
            return this.kernel.approve(intent.id, { source: 'policy' });
        if (decision.outcome === 'deny')
            return this.kernel.deny(intent.id, decision.reason);
        if (decision.outcome !== 'review')
            return intent;
        const config = this.reviewSettings?.();
        if (!config) {
            this.escalateReview(intent.id, 'Automatic review is unavailable because Settings.autoReview.reviewerModelId does not name an existing reviewer profile.');
            return this.kernel.getIntent(intent.id)!;
        }
        const attempt = await this.attemptReview(task, runId, intent, prepared, config, messageId, signal);
        // The reviewer is a slow, untrusted dependency: the operator may deny this effect, or the
        // task may be cancelled, revoked or paused while it runs. Re-read the authoritative intent
        // and re-assert the run fence before writing any review state. A denial must stay a denial,
        // and a superseded run must never record or escalate a verdict for the old generation.
        this.kernel.assertFence(task.id, runId);
        const current = this.kernel.getIntent(intent.id)!;
        if (current.state !== 'prepared' || current.authorization?.decision !== 'review')
            return current;
        if (!attempt)
            return current;
        if (attempt.kind === 'degraded') {
            this.escalateReview(intent.id, attempt.reason);
            return this.kernel.getIntent(intent.id)!;
        }
        this.kernel.recordToolReview(intent.id, attempt.record);
        if (attempt.record.verdict === 'pass')
            return this.kernel.approve(intent.id, { source: 'review' });
        // block already denied the intent; escalate switched the stored decision to a human ask.
        return this.kernel.getIntent(intent.id)!;
    }
    private escalateReview(intentId: string, reason: string): void {
        if (!this.reviewBridge) throw new Error('Automatic review is unavailable and no escalation bridge is configured.');
        this.reviewBridge.escalate(intentId, reason);
    }
    /** Runs the bounded independent reviewer; a missing verdict must escalate, never pass. */
    private async attemptReview(task: Task, runId: string, intent: Intent, prepared: PreparedTool, config: { reviewerModelId: string; profileId: string; escalateAt: RiskLevel }, messageId: string, signal: AbortSignal): Promise<ReviewAttempt | undefined> {
        const authorization = intent.authorization;
        if (!authorization) return undefined;
        // The proposing Work Request is the cause of this review; it is the review Request's
        // parent, never its identity. The review Request id comes back from the actual model call.
        const proposed = this.kernel.getMessage(messageId)?.requestId;
        const reviewer = createToolReviewer({
            client: {
                complete: (messages, tools, callSignal) => {
                    // The real Harness request, profile allowance, Request/Tool/Trace records and the
                    // configured reviewer model are created only when the reviewer reaches the model.
                    const context: RequestContext = { sessionId: task.id, taskId: task.id, runId, kind: 'review', profileId: config.profileId, ...(proposed ? { parentId: proposed } : {}) };
                    const client = this.modelClient?.(context) ?? this.configuration.client(context);
                    return client.complete(messages, tools, callSignal);
                },
            },
            reviewer: 'independent-reviewer',
            escalateAt: config.escalateAt,
            consume: () => { this.kernel.consumeModelCall(task.id, runId); },
        });
        const outcome = await reviewer.review({
            taskId: task.id,
            goal: { objective: task.goal.objective, constraints: task.goal.constraints, acceptance: task.goal.acceptance, mode: task.goal.mode },
            intent: { name: intent.name, arguments: intent.arguments, digest: intent.digest, generation: intent.generation, policyEpoch: intent.policyEpoch },
            capability: authorization.capability,
            risk: authorization.risk as ReviewRisk,
            resources: prepared.resources,
            signal,
        });
        if (outcome.degraded)
            return { kind: 'degraded', reason: `Automatic review could not complete (${outcome.degraded}): ${outcome.reason}` };
        return {
            kind: 'record',
            record: {
                verdict: outcome.verdict,
                reviewer: outcome.reviewer,
                reviewerModelId: config.reviewerModelId,
                ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
                risk: outcome.risk,
                reason: outcome.reason,
                checks: outcome.checks,
                durationMs: outcome.durationMs,
            },
        };
    }
    private async localTool(task: Task, call: ToolCall, effectKey: string, signal: AbortSignal, runId: string): Promise<string | undefined> {
        if (call.name === 'claim_files') { this.kernel.assertFence(task.id, runId); return JSON.stringify(this.kernel.fileClaims.claimFiles(task.id, call.arguments.paths as string[])); }
        if (call.name === 'release_files') { this.kernel.assertFence(task.id, runId); this.kernel.fileClaims.releaseClaims(task.id, call.arguments.ids as string[]); return JSON.stringify({ released: true }); }
        if (call.name === 'coordination_presence') { this.kernel.assertFence(task.id, runId); return JSON.stringify({ ...this.kernel.coordination.presence(task.workspace, call.arguments.after as string | undefined, call.arguments.limit as number | undefined), external: this.kernel.coordination.externalSnapshot?.(task.workspace) }); }
        if (call.name === 'coordination_send') return JSON.stringify(this.kernel.coordination.send(task.id, call.arguments.to as string, call.arguments.kind as string, call.arguments.body as string, effectKey, 'work', runId));
        if (call.name === 'coordination_inbox') {
            if (call.arguments.ackIds !== undefined) this.kernel.coordination.ack(task.id, call.arguments.ackIds as string[], 'work', runId);
            return JSON.stringify(this.kernel.coordination.inbox(task.id, call.arguments, 'work', runId));
        }
        if (MEMORY_TOOL_NAMES.has(call.name)) return memoryTool(this.kernel.memory(task.id), call, effectKey, this.originMemory?.(task.id));
        if (SKILL_TOOL_NAMES.has(call.name)) return skillTool({ workspace: task.workspace, skillRoots: this.configuration.skillRoots,
            disabledSkillIds: this.skillSettings?.disabledSkillIds() ?? [], signal }, call);
        const control = (type: string, parameters: Record<string, unknown>) => this.kernel.command({ commandId: `model-${effectKey}`, origin: 'model', type, taskId: task.id, parameters });
        if (this.collaboration) {
            const scope = task.parentId ?? task.id;
            if (call.name === 'create_plan') return JSON.stringify(this.collaboration.createPlan(task.id, {
                id: this.collaboration.plan(task.id)?.id ?? `plan-${effectKey}`, title: String(call.arguments.title ?? ''), nodes: call.arguments.nodes as PlanNodeInput[],
            }));
            if (call.name === 'search_collaboration') return JSON.stringify(this.collaboration.searchProcesses(scope, {
                query: String(call.arguments.query ?? ''), offset: Number(call.arguments.offset ?? 0), limit: Number(call.arguments.limit ?? 20), excludeTaskId: task.id,
            }));
            if (call.name === 'read_collaboration') return JSON.stringify(this.collaboration.readProcess(scope, String(call.arguments.sourceTaskId ?? ''), String(call.arguments.messageId ?? ''), Number(call.arguments.offset ?? 0), Number(call.arguments.length ?? 6000)));
        }
        switch (call.name) {
            case 'read_events': return JSON.stringify(this.kernel.events(task.id, Number(call.arguments.afterSeq ?? call.arguments.after ?? 0), 100));
            case 'ask_user':
                control('ask_question', { question: String(call.arguments.question ?? ''), reason: String(call.arguments.reason ?? 'blocker') });
                return 'Awaiting user answer; task paused for clarification.';
            case 'delegate': {
                const ack = control('delegate', { title: call.arguments.title, paths: call.arguments.ownedPaths, dependsOn: call.arguments.dependsOn, goal: { ...task.goal, acceptance: Array.isArray(call.arguments.acceptance) ? call.arguments.acceptance.map(String) : [], objective: String(call.arguments.objective ?? call.arguments.title) } });
                return JSON.stringify(this.kernel.delegationPage(task.id, 0, 1, ack.childTaskId));
            }
            case 'list_delegations': return JSON.stringify(this.kernel.delegationPage(task.id, Number(call.arguments.cursor ?? 0), Number(call.arguments.limit ?? 16)));
            case 'wait_for_children': {
                if (this.kernel.activeChildCount(task.id))
                    this.kernel.transition(task.id, 'waiting_children', { waitingReason: 'Waiting for direct delegated tasks to settle.' });
                return JSON.stringify(this.kernel.delegationProgress(task.id));
            }
            case 'accept_child_result': control('accept_result', { childTaskId: String(call.arguments.childTaskId), evidence: String(call.arguments.evidence ?? '') }); return JSON.stringify(this.kernel.delegationPage(task.id, 0, 1, String(call.arguments.childTaskId)));
            case 'cancel_child':
                control('cancel_child', { childTaskId: String(call.arguments.childTaskId), reason: String(call.arguments.reason ?? '') });
                this.interrupt(String(call.arguments.childTaskId));
                return JSON.stringify(this.kernel.delegationPage(task.id, 0, 1, String(call.arguments.childTaskId)));
            case 'dismiss_child': control('dismiss_child', { childTaskId: String(call.arguments.childTaskId), reason: String(call.arguments.reason ?? '') }); return JSON.stringify(this.kernel.delegationPage(task.id, 0, 1, String(call.arguments.childTaskId)));
            case 'list_mcp_tools': return JSON.stringify(await this.external?.mcpTools(call.arguments, { readOnlyOnly: false }, signal) ?? []);
            case 'list_plugins': return JSON.stringify(this.plugins?.list() ?? []);
            case 'plugin_transform': return JSON.stringify(await this.plugins?.execute(String(call.arguments.pluginId), String(call.arguments.operationId), String(call.arguments.input ?? '')));
            case 'finish': return 'Completion proposal received; independent verification is required.';
            default: return undefined;
        }
    }
    private toolMessage(taskId: string, call: ToolCall, content: string) {
        const pending = this.kernel.pendingCalls(taskId).find(item => item.call.id === call.id);
        const requestId = pending ? this.kernel.getMessage(pending.messageId)?.requestId : undefined;
        this.kernel.addMessage(taskId, 'tool', content, 'main', { toolCallId: call.id, requestId, ...(MEMORY_TOOL_NAMES.has(call.name) ? { archiveRecall: true } : {}) });
    }
    private async reconcile(task: Task) {
        this.kernel.setReconciliationDue(task.id, Date.now() + 30000);
        const gateway = this.gateway(task);
        const retryCursor = this.kernel.latestEvent(task.id, 'task.retry_requested')?.seq ?? 0;
        for (const intent of this.kernel.intentsByState(task.id, ['unknown'])) {
            const attempts = this.kernel.eventCount(task.id, 'effect.reconciliation_required', retryCursor, intent.id);
            if (attempts >= 3) {
                this.kernel.setReconciliationDue(task.id, Number.MAX_SAFE_INTEGER);
                continue;
            }
            const call = { id: intent.toolCallId, name: intent.name, arguments: intent.arguments };
            const remote = Boolean(this.external && ['web_search', 'web_fetch', 'web_crawl', 'mcp_call'].includes(intent.name));
            const actionDigest = digestValue({ name: call.name, arguments: call.arguments });
            const observer = intent.name === 'rea_analyze_local' && this.integrations ? this.integrations : remote ? this.external! : gateway;
            const outcome = await observer.queryOutcome(intent.effectKey, actionDigest);
            if (outcome.status !== 'applied' || !outcome.receipt) {
                // A recovery re-read can settle the effect only when the executor itself persisted the
                // failure for this same artifact. An explicitly unknown status stays unknown: a structured
                // error payload is not evidence that the request conclusively failed, and the kernel
                // revalidates the tool and the persisted network capability before accepting the failure.
                const persistedFailure = outcome.status === 'failed' && !outcome.receipt;
                const diagnostic = persistedFailure && remote && READ_ONLY_NETWORK_TOOLS.has(intent.name) ? diagnosticOf(outcome) : undefined;
                const terminal = diagnostic ? networkFailure(intent, diagnostic, value => this.configuration.redact(value)) : undefined;
                if (terminal) {
                    this.kernel.reconcileFailure(intent.id, terminal);
                    const failed = this.pendingCalls(task.id).find(item => digest({ taskId: task.id, messageId: item.messageId, toolCallId: item.call.id }) === intent.effectKey);
                    if (failed) this.toolMessage(task.id, failed.call, failureToolContent(terminal));
                    continue;
                }
                this.kernel.reconcile(intent.id);
                continue;
            }
            this.kernel.reconcile(intent.id, outcome.receipt);
            const pending = this.pendingCalls(task.id).find(item => digest({ taskId: task.id, messageId: item.messageId, toolCallId: item.call.id }) === intent.effectKey);
            if (pending)
                this.toolMessage(task.id, pending.call, outcome.output);
        }
        // Only an unresolved task needs the 30s reconciliation throttle; a settled task continues now.
        this.kernel.clearReconciliationDue(task.id, true);
    }
    private async finish(taskId: string, runId: string, result: ModelResult, gateway: ToolGateway, signal: AbortSignal, sampledUserCursor = 0) {
        const latestUserCursor = this.kernel.latestUserCursor(taskId);
        if (latestUserCursor > sampledUserCursor) {
            // Evidence/reviewer calls do not consume new operator input. A persisted tool proposal
            // from an old version without sampling metadata conservatively requests a fresh turn.
            this.kernel.appendEvent(taskId, 'verification.stale', { phase: 'input', sampledUserCursor, latestUserCursor });
            return;
        }
        const task = this.kernel.getTask(taskId)!;
        if (task.executionPhase && task.executionPhase !== 'executing') {
            this.kernel.transition(taskId, 'waiting_input', { waitingReason: 'Planning does not execute or complete the goal. Save a plan and wait for its explicit confirmation, or ask the operator for missing information.' });
            return;
        }
        if (this.kernel.hasUnsettledDelegations(taskId, task.goalVersion)) {
            this.kernel.addMessage(taskId, 'user', 'Completion is not ready: use list_delegations to inspect direct children; wait for active children, accept current independently passing results or dismiss failed/cancelled children with a reason. Re-review settlements after a saved goal change.', 'main', { inputOrigin: 'runtime' });
            return;
        }
        const evidenceRevision = task.revision;
        const evidence = { ...await inspectEffects(task, {
            page: (after, limit) => this.kernel.intentPage(taskId, after, limit),
            isLatestWrite: intent => this.kernel.isLatestAppliedWrite(taskId, intent.id, String(intent.arguments.path)),
            relatedPage: (after, limit) => this.kernel.delegationReviewPage(taskId, after, limit),
        }, gateway, this.external, path.join(this.dataDir, 'artifacts'), this.integrations, signal),
            children: { ...this.kernel.delegationProgress(taskId), source: { taskId, collection: 'delegations', goalVersion: task.goalVersion } } };
        this.kernel.assertFence(taskId, runId);
        if (this.kernel.getTask(taskId)!.revision !== evidenceRevision) {
            this.kernel.appendEvent(taskId, 'verification.stale', { phase: 'evidence', expectedRevision: evidenceRevision, actualRevision: this.kernel.getTask(taskId)!.revision });
            return;
        }
        this.kernel.consumeModelCall(taskId);
        let reviewTask = this.kernel.getTask(taskId)!;
        const selection = this.selection?.(taskId);
        const context: RequestContext = { sessionId: taskId, taskId, runId, kind: 'review', parentId: result.requestId,
            ...(selection?.profileId ? { profileId: selection.profileId } : {}), ...(selection?.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) };
        const proposedResult = result.content.length <= 12000 ? result.content : {
            preview: result.content.slice(0, 12000), truncated: true,
            ...archiveArtifact(path.join(this.dataDir, 'artifacts'), Buffer.from(result.content)),
        };
        const reviewClient = this.modelClient?.(context) ?? this.configuration.client(context);
        const reviewTools: ToolDefinition[] = [{ type: 'function', function: {
            name: 'read_review_evidence', description: 'Read this verification attempt\'s immutable evidence or archived proposed result. Cursor is a UTF-8 byte offset; follow nextCursor for continuation. A single large JSONL record may span pages. No workspace or external files are accessible.',
            parameters: { type: 'object', properties: { source: { type: 'string', enum: ['effects', 'proposed_result'] }, cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['source'], additionalProperties: false },
        } }];
        const reviewSystem = { role: 'system' as const, content: rolePrompt('reviewer', task.goal) + '\nThe evidence summary is bounded. read_review_evidence can inspect the complete receipt, finding, artifact and child-verification JSONL archive (source effects), or a long archived proposed result. Start at cursor 0; follow nextCursor. Prior raw pages are not retained in the working request: retain only necessary observations in your next tool-call content and reread exact evidence when needed. The deterministic check covers every receipt; you need not reread every passing record. Return the final JSON verdict only when the evidence supports it.' };
        const reviewEvidence = { ...evidence, receipts: [...evidence.receipts], artifacts: [...evidence.artifacts], findings: [...evidence.findings] };
        const payload = { goal: task.goal, proposedResult, evidence: reviewEvidence };
        const reviewWindow = workingContextBudget(reviewClient.config, reviewTools);
        const reviewBudget = Math.floor(reviewWindow * 0.6) - JSON.stringify(reviewSystem).length - 256;
        while (JSON.stringify(payload).length > reviewBudget) {
            if (reviewEvidence.receipts.length) reviewEvidence.receipts.pop();
            else if (reviewEvidence.artifacts.length) reviewEvidence.artifacts.pop();
            else if (reviewEvidence.findings.length > 1) reviewEvidence.findings.pop();
            else throw new RangeError('The saved goal and verification summary exceed the reviewer input budget.');
        }
        const baseMessages: WireMessage[] = [reviewSystem, { role: 'user', content: JSON.stringify(payload) }];
        let reviewMessages = baseMessages, review: ModelResult;
        for (;;) {
            review = await resourceBudget.withLease(signal, () => reviewClient.complete(reviewMessages, reviewTools, signal));
            this.kernel.assertFence(taskId, runId);
            if (this.kernel.getTask(taskId)!.revision !== reviewTask.revision) {
                this.kernel.appendEvent(taskId, 'verification.stale', { phase: 'review', expectedRevision: reviewTask.revision, actualRevision: this.kernel.getTask(taskId)!.revision });
                return;
            }
            if (!review.toolCalls.length) break;
            if (review.toolCalls.length > 4 || review.toolCalls.some(call => call.name !== 'read_review_evidence')) {
                review = { ...review, content: JSON.stringify({ verdict: 'unknown', reason: 'Reviewer requested an unavailable tool or more than four evidence pages in one turn.' }), toolCalls: [] };
                break;
            }
            const proposal: WireMessage = { role: 'assistant', content: review.content,
                ...(review.reasoningContent ? { reasoning_content: review.reasoningContent } : {}),
                tool_calls: review.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
            const pageBytes = Math.min(12000, Math.floor((reviewWindow - JSON.stringify([...baseMessages, proposal]).length - 2048) / (6 * review.toolCalls.length)));
            if (pageBytes < 256) {
                review = { ...review, content: JSON.stringify({ verdict: 'unknown', reason: 'Reviewer reasoning and tool proposal leave no bounded space for the requested evidence page.' }), toolCalls: [] };
                break;
            }
            const replies: WireMessage[] = [];
            for (const call of review.toolCalls) {
                let response: unknown;
                try {
                    const source = call.arguments.source;
                    const filename = source === 'effects' ? evidence.detail?.path
                        : source === 'proposed_result' && typeof proposedResult !== 'string' ? proposedResult.archivePath : undefined;
                    if (!filename || Object.keys(call.arguments).some(key => !['source', 'cursor', 'limit'].includes(key))) throw new Error('Only the current immutable evidence or archived result is available.');
                    const page = await readReviewEvidence(filename, call.arguments.cursor === undefined ? 0 : Number(call.arguments.cursor), call.arguments.limit === undefined ? 20 : Number(call.arguments.limit), pageBytes, signal);
                    response = { source, ...page };
                    this.kernel.appendEvent(taskId, 'verification.evidence_read', { source, cursor: page.cursor, nextCursor: page.nextCursor, bytes: page.bytes });
                } catch (error) {
                    if (signal.aborted) throw error;
                    response = { error: error instanceof Error ? error.message : String(error) };
                }
                replies.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(response) });
            }
            reviewMessages = [...baseMessages, proposal, ...replies];
            if (this.kernel.getTask(taskId)!.revision !== reviewTask.revision) {
                this.kernel.appendEvent(taskId, 'verification.stale', { phase: 'review_evidence', expectedRevision: reviewTask.revision, actualRevision: this.kernel.getTask(taskId)!.revision });
                return;
            }
            this.kernel.consumeModelCall(taskId, runId);
            reviewTask = this.kernel.getTask(taskId)!;
        }
        let verdict: {
            verdict?: string;
            reason?: string;
        };
        try {
            verdict = JSON.parse(review.content);
        }
        catch {
            verdict = { verdict: 'unknown', reason: 'Reviewer response was not valid JSON.' };
        }
        this.kernel.assertFence(taskId, runId);
        this.kernel.modelSucceeded(taskId, runId);
        const current = this.kernel.getTask(taskId)!;
        if (current.revision !== reviewTask.revision) {
            this.kernel.appendEvent(taskId, 'verification.stale', { phase: 'review', expectedRevision: reviewTask.revision, actualRevision: current.revision });
            return;
        }
        const passed = evidence.passed && verdict.verdict === 'pass';
        this.kernel.verify(taskId, runId, { passed, reviewer: 'independent-verifier', expectedRevision: reviewTask.revision, goalVersion: reviewTask.goalVersion, generation: reviewTask.generation, evidence, modelReview: verdict, requiresManual: !evidence.passed });
        this.kernel.checkpoint(taskId, runId, { evidence, proposedResult: result.content });
        if (!passed) {
            const repairs = this.kernel.eventCount(taskId, 'verification.repair_requested');
            if (verdict.verdict === 'fail' && repairs < 2 && !evidence.manualAcceptance) {
                this.kernel.appendEvent(taskId, 'verification.repair_requested', { attempt: repairs + 1, evidence, modelReview: verdict });
                this.kernel.addMessage(taskId, 'user', `Independent verification failed. Repair the recorded findings within the saved goal, approvals and remaining budget: ${JSON.stringify({ findings: evidence.findings, review: verdict })}`, 'main', { inputOrigin: 'runtime' });
                return;
            }
            this.kernel.transition(taskId, 'waiting_input', { waitingReason: verdict.reason ?? (evidence.findings.join('; ') || 'Review did not pass. Supply clarification or retry.') });
            return;
        }
        this.kernel.transition(taskId, 'completed', { result: result.content });
        this.kernel.finishRun(runId, 'completed');
    }
}
