import type { Event, McpDefinitionSnapshot } from '../contracts.js';
import type { Services } from '../app/services.js';
import { digest } from '../kernel/index.js';
import type { BuiltContext } from '../runtime/context.js';
import type { LoadedInstructions } from '../runtime/instructions.js';
import { part } from './prompts.js';
import type { HarnessStore } from './store.js';
import type { PromptPart, ToolRecord } from './types.js';

export function workSources(context: BuiltContext, instructions: LoadedInstructions): PromptPart[] {
  const sources = [part('work-harness', 'Work · 角色、目标与执行约束', 'system', String(context.messages[0]?.content ?? '').split('\n\nActive project directives:')[0]!, 'runtime/prompts.ts / rolePrompt', 'harness')];
  if (context.memory) sources.push(part('archive-navigation', '历史回查与持久记忆', 'user', context.memory, 'memory/archive', 'session'));
  const blocks = instructions.text.split(/(?=Source \d+: )/);
  for (const [index, source] of instructions.sources.entries()) sources.push(part(`instruction:${source.sha256}`, source.kind === 'skill' ? 'Skill 指令' : '工作区指令', 'system', blocks.find(block => block.startsWith(`Source ${index + 1}: `))?.trim() ?? '', source.path, source.kind === 'global' ? 'global' : 'project'));
  sources.push(part('context-manifest', '上下文选择与原始来源', 'context', JSON.stringify({ sources: context.sourceManifest, omittedIds: context.omittedIds, summary: context.summary }, null, 2), 'runtime/context.ts / buildContext', 'harness'));
  return sources;
}

/** Honor the original request's content policy before writing a dynamic server definition. */
export function recordedMcpDefinition(definition: McpDefinitionSnapshot, recordContent: boolean): McpDefinitionSnapshot {
  return recordContent ? structuredClone(definition)
    : { serverId: definition.serverId, toolName: definition.toolName, digest: definition.digest, available: false };
}

/** Incremental, restartable projection of the authoritative kernel event log. */
export class WorkTrace {
  private observer?: (event: Event) => void;
  private pending?: NodeJS.Immediate;
  private closed = false;
  private readonly liveStart: number;
  private liveCursor: number;
  constructor(private readonly services: Services, private readonly store: HarnessStore, private readonly sanitize: <T>(value: T) => T) {
    this.liveCursor = this.liveStart = services.kernel.latestEventSequence();
  }
  /** Display projections subscribe here; they must never change Kernel event import semantics. */
  setObserver(observer: (event: Event) => void): void { this.observer = observer; }
  captureMcpDefinition(taskId: string, requestId: string, toolCallId: string, definition: McpDefinitionSnapshot): void {
    const tool = this.store.findTool(taskId, toolCallId, { requestId });
    if (!tool || tool.mcpDefinition) return;
    const mcpDefinition = recordedMcpDefinition(definition, this.store.getRequest(requestId).recordContent);
    this.store.saveTool(this.sanitize({ ...tool, mcpDefinition }));
  }
  sync(taskId?: string): void {
    if (this.closed) return;
    if (taskId) {
      const after = Math.max(this.liveStart, this.store.getSetting('kernelCursor', 0), this.store.workProjectionVersion('task', taskId));
      // A long-lived task can itself have a cold backlog. Its newest display window must not wait for it.
      this.project(this.services.kernel.recentEvents(taskId, 16).filter(event => event.seq > after));
    }
    this.schedule();
  }
  private schedule(): void {
    if (this.closed || this.pending) return;
    this.pending = setImmediate(() => {
      this.pending = undefined;
      try { this.catchUp(); }
      catch (error) {
        // Keep the durable cursor at the last successful batch and expose the failure; do not busy-retry it.
        this.store.setSetting('workTraceError', { message: String(error), cursor: this.store.getSetting('kernelCursor', 0) });
      }
    });
    this.pending.unref();
  }
  private catchUp(): void {
    if (this.closed) return;
    const { kernel } = this.services;
    const latest = kernel.latestEventSequence();
    const live = kernel.traceEventsSince(Math.max(this.liveCursor, latest - 16), 16);
    if (live.length) { this.project(live); this.liveCursor = live.at(-1)!.seq; }
    const events = kernel.traceEventsSince(this.store.getSetting('kernelCursor', 0), 16);
    if (events.length) this.store.transaction(() => { this.project(events); this.store.advanceKernelCursor(events.at(-1)!.seq); });
    if (this.store.getSetting('workTraceError', null)) this.store.setSetting('workTraceError', null);
    if (this.store.getSetting('kernelCursor', 0) < latest) this.schedule();
  }
  close(): void { this.closed = true; if (this.pending) clearImmediate(this.pending); this.pending = undefined; this.observer = undefined; }
  private project(events: Event[]): void {
    const { kernel } = this.services;
    this.store.transaction(() => { for (const event of events) { const imported = this.store.importEvent(event.seq, () => {
      const payload = event.payload, task = kernel.getTask(event.taskId)!;
      const message = event.type === 'message.appended' ? kernel.getMessage(String(payload.messageId)) : undefined;
      const intent = typeof payload.intentId === 'string' ? kernel.getIntent(payload.intentId) : undefined;
      const callId = String(payload.toolCallId ?? intent?.toolCallId ?? message?.toolCallId ?? '');
      // A catch-up can see several saved requests with the same provider call id. Bind each
      // assistant proposal by its immutable effect key before importing its intent events.
      // This assigns identity only; historical status still comes from each event below.
      if (message?.role === 'assistant' && message.requestId) for (const call of message.toolCalls ?? []) {
        const proposal = this.store.findTool(event.taskId, call.id, { requestId: message.requestId });
        const prepared = kernel.intentForEffect(digest({ taskId: event.taskId, messageId: message.id, toolCallId: call.id }));
        if (proposal && prepared) this.store.saveTool({ ...proposal, intentId: prepared.id });
      }
      const sourceRequest = String(payload.requestId ?? message?.requestId ?? '') || undefined;
      const sourceRun = String(payload.runId ?? intent?.runId ?? '') || undefined;
      let tool = callId ? (intent ? this.store.findTool(event.taskId, callId, { intentId: intent.id }) : undefined)
        ?? this.store.findTool(event.taskId, callId, sourceRequest ? { requestId: sourceRequest } : sourceRun ? { runId: sourceRun } : {}) : undefined;
      // A fallback may locate a proposal awaiting its first intent event, but must not rebind
      // an already-associated historical call to another effect with a reused provider id.
      if (intent && tool?.intentId && tool.intentId !== intent.id) tool = undefined;
      const requestId = sourceRequest ?? tool?.requestId;
      if (tool && this.store.getRequest(tool.requestId).kind !== 'chat') {
        const patch: Partial<ToolRecord> = {};
        if (intent) {
          patch.intentId = intent.id; patch.digest = intent.digest; patch.runId = intent.runId; patch.arguments = intent.arguments;
          patch.fileConflicts = intent.fileConflicts;
          // Evaluate the historical event, not a future intent state read during a catch-up.
          if (event.type === 'intent.prepared') { patch.status = 'prepared'; patch.permission = 'approval_required'; }
          if (event.type === 'intent.approved') { patch.status = 'approved'; patch.permission = 'approved'; }
          if (event.type === 'intent.denied') { patch.status = 'denied'; patch.permission = 'denied'; patch.failureStage = 'permission'; patch.error = intent.error; }
          if (event.type === 'intent.sent') patch.status = 'running';
          if (event.type === 'intent.reviewed' || event.type === 'intent.review_escalated' || event.type === 'intent.review_blocked') {
            // Review conclusions are display evidence only; they never replace the kernel's own authorization state.
            patch.review = intent?.authorization?.review;
            patch.status = 'prepared'; patch.permission = 'approval_required';
          }
          if (event.type === 'effect.receipted' || event.type === 'effect.reconciled') {
            const businessError = ['mcp_call', 'mcp_read'].includes(intent.name) && (intent.receipt?.result as { isError?: unknown } | undefined)?.isError === true;
            patch.status = businessError ? 'failed' : 'completed'; patch.permission = 'approved'; patch.result = intent.receipt;
            if (businessError) { patch.error = 'MCP tool returned isError=true.'; patch.failureStage = 'execution'; }
          }
          if (event.type === 'effect.unknown') { patch.status = 'unknown'; patch.failureStage = 'reconciliation'; patch.error = intent.error; }
          if (event.type === 'effect.failed') {
            // Project the failure from this event's own payload. During a catch-up the intent already
            // holds its terminal state; reading that future state here would misattribute the diagnosis
            // (and when it happened) to this historical event. A later tool message only adds the result.
            patch.status = 'failed'; patch.permission = 'approved';
            patch.failureStage = payload.origin === 'reconciliation' ? 'reconciliation' : 'execution';
            const code = typeof payload.code === 'string' ? payload.code : '', detail = typeof payload.message === 'string' ? payload.message : '';
            // A valid IntentFailure may omit its message; keep the code alone and never emit a bare separator.
            if (code || detail) patch.error = code && detail ? `${code}: ${detail}` : code || detail;
          }
        }
        if (event.type === 'tool.execution') Object.assign(patch, payload.patch);
        if (message?.role === 'tool') {
          patch.result = message.content;
          if (!['denied', 'failed', 'unknown'].includes(tool.status)) patch.status = 'completed';
        }
        if (Object.keys(patch).length) {
          // Historical trace keeps this event's status; only a newer event may change the live tool row.
          const projected = this.sanitize({ ...tool, ...patch });
          tool = this.store.advanceWorkProjection('tool', tool.id, event.seq) ? this.store.saveTool(projected) : projected;
        }
      }
      const recordContent = this.store.getSetting('recordContent', true);
      this.store.trace({ sessionId: tool?.sessionId ?? event.taskId, taskId: event.taskId, requestId, runId: String(payload.runId ?? tool?.runId ?? '') || undefined,
        parentId: task.parentId, type: event.type, timestamp: event.createdAt, status: String(payload.to ?? tool?.status ?? 'recorded'),
        payloadReference: `kernel:${event.seq}`, payload: recordContent ? this.sanitize(payload) : { kernelSequence: event.seq } });
    });
      try { if (imported && this.store.advanceWorkProjection('task', event.taskId, event.seq)) this.observer?.(event); }
      catch { /* Display projection failures must never fail Kernel event import. */ }
    } });
  }
}
