import { createHash, randomUUID } from 'node:crypto';
import { resourceBudget } from '../app/resource-budget.js';
import path from 'node:path';
import type { Command, ModelResult, Intent, IntentFailure } from '../contracts.js';
import type { Services } from '../app/services.js';
import { KernelError, digest } from '../kernel/index.js';
import type { ToolOutcome } from '../tools/gateway.js';
import { digestValue } from '../tools/policy.js';
import { TOOL_DEFINITIONS } from '../runtime/prompts.js';
import { MEMORY_TOOL_NAMES, memoryTool } from '../memory/tools.js';
import { SKILL_TOOL_NAMES, skillTool } from '../runtime/skill-tools.js';
import { EXTERNAL_TOOL_DEFINITIONS, CHAT_MCP_TOOL_DEFINITIONS } from '../app/external-tools.js';
import { INTEGRATION_TOOL_DEFINITIONS } from '../integrations/tools.js';
import type { ChatService } from './chat.js';
import type { HarnessStore, PendingChatToolBinding } from './store.js';
import { recordedMcpDefinition } from './work-trace.js';
import type { ChatSession, ToolRecord } from './types.js';

const terminal = new Set(['completed', 'failed', 'denied']);
const capability: Record<string, string> = { 'fs.read': 'workspace.read', 'fs.write': 'workspace.write', 'process.run': 'process.exec' };
// Chat executes reads only: every other registered tool is denied here, before any intent or
// approval can exist, so a forged write/exec/MCP proposal cannot reach the kernel.
const workspaceReadTools = new Set(['read_file', 'list_files', 'search_text', 'git_query']);
const webReadTools = new Set(['web_search', 'web_fetch', 'web_crawl']);
const mcpReadTools = new Set(['list_mcp_tools', 'mcp_read']);
const definitions = [...TOOL_DEFINITIONS, ...EXTERNAL_TOOL_DEFINITIONS, ...CHAT_MCP_TOOL_DEFINITIONS, ...INTEGRATION_TOOL_DEFINITIONS];
const integrationNames = new Set(INTEGRATION_TOOL_DEFINITIONS.map(tool => tool.function.name));
// A kernel refusal carrying one of these codes is the permission boundary, not a validation slip.
const permissionCodes = new Set(['POLICY_DENY', 'CAPABILITY_DENIED', 'CAPABILITY_MISMATCH', 'OWNERSHIP_CONFLICT', 'INVALID_PERMISSION', 'APPROVAL_STALE', 'OPERATOR_REQUIRED']);

class ToolStageError extends Error {
  constructor(readonly stage: NonNullable<ToolRecord['failureStage']>, message: string) { super(message); }
}

/** Windows path identity is case-insensitive; path.relative matches the Services boundary for that. */
function samePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

/** Validate the small schema vocabulary of registered built-ins, not the editable model copy. */
function validateArguments(value: unknown, schema: any, location = 'arguments'): void {
  const valid = schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : schema.type === 'array' ? Array.isArray(value) : schema.type === 'integer' ? Number.isSafeInteger(value)
    : schema.type === undefined || typeof value === schema.type;
  if (!valid) throw new ToolStageError('validation', `${location} must have type ${schema.type}.`);
  if (schema.enum && !schema.enum.includes(value)) throw new ToolStageError('validation', `${location} must match a registered enum value.`);
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) throw new ToolStageError('validation', `${location} is outside its registered range.`);
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => validateArguments(item, schema.items, `${location}[${index}]`));
  if (schema.type === 'object') {
    const object = value as Record<string, unknown>, properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in object)) throw new ToolStageError('validation', `${location}.${key} is required.`);
    for (const [key, item] of Object.entries(object)) {
      if (properties[key]) validateArguments(item, properties[key], `${location}.${key}`);
      else if (schema.additionalProperties === false) throw new ToolStageError('validation', `${location}.${key} is not a registered parameter.`);
    }
  }
}

/** Chat owns orchestration; the existing kernel remains the sole effect/approval authority. */
export class ChatTools {
  private readonly active = new Map<string, { sessionId: string; controller: AbortController; promise: Promise<void> }>();
  private stopping = false;
  readonly ready: Promise<void>;
  constructor(private readonly services: Services, private readonly store: HarnessStore, private readonly chat: ChatService,
    private readonly sanitize: <T>(value: T) => T = value => services.configuration.sanitize(value)) {
    // Older installations stored one task id per session; every recorded id stays externally managed
    // so a replaced scope can never become autonomous work after a restart.
    store.migrateChatToolBindings();
    let cursor = 0;
    while (true) {
      const page = store.unregisteredChatToolBindings(cursor); if (!page.length) break;
      const registered = new Set(services.kernel.manageExternallyBatch(page.map(binding => binding.taskId)));
      store.transaction(() => { for (const binding of page) {
        if (registered.has(binding.taskId)) store.markChatToolBindingRegistered(binding.sessionId, binding.index);
        else {
          store.trace({ sessionId: binding.sessionId, type: 'chat.binding_unsettled', status: 'failed',
            payload: { taskId: binding.taskId, message: 'Bound task is missing; its ownership registration remains pending.' } });
        }
      } });
      cursor = page.at(-1)!.cursor;
    }
    // An interrupted binding is settled here, synchronously, before the Runner starts: the Kernel
    // may already own that task, and an unrecorded Kernel task would otherwise be free to run itself.
    let after = '';
    while (true) {
      const page = store.pendingChatToolBindings(after); if (!page.length) break;
      for (const { sessionId, pending } of page) try { this.settleBinding(sessionId, pending); }
      catch (error) {
        // Keep the marker: the next Chat tool attempt retries the same identity and reports the same
        // failure instead of allocating a second task. An uncommitted command created no task at all.
        this.store.trace({ sessionId, type: 'chat.binding_unsettled', status: 'failed',
          payload: { index: pending.index, message: this.sanitize(String(error)) } });
      }
      after = page.at(-1)!.sessionId;
    }
    this.ready = this.recover();
  }
  async accept(session: ChatSession, requestId: string, result: ModelResult): Promise<void> {
    if (!result.toolCalls.length || this.stopping) return;
    const request = this.store.getRequest(requestId);
    if (request.kind !== 'chat' || request.sessionId !== session.id) throw new Error('Only the matching Chat request may schedule Chat tools.');
    await this.ready;
    void this.enqueue(requestId);
  }
  async approve(id: string, input: { digest?: string; approved?: boolean }): Promise<ToolRecord> {
    await this.ready;
    const record = this.store.getTool(id);
    if (record.status !== 'awaiting_approval' || !record.intentId) throw new Error('This tool is not awaiting approval.');
    if (input.digest !== record.digest) throw new Error('Approval must match the exact prepared tool digest.');
    // A record left awaiting approval by an older version is settled, never executed: Chat has no
    // side-effecting tool, and granting one here would bypass the read-only boundary. An intent
    // that somehow already dispatched is only ever reconciled from its original receipt.
    const intent = this.services.kernel.getIntent(record.intentId);
    if (intent?.state === 'sent' || intent?.state === 'unknown' || intent?.state === 'applied') {
      await this.enqueue(record.requestId);
      throw new Error('This Chat tool is already dispatched; only its original receipt may be reconciled.');
    }
    const reason = input.approved === true ? 'Chat tools cannot execute side effects.' : 'Operator denied this Chat tool.';
    this.services.kernel.deny(record.intentId, reason);
    this.save(record, { status: 'denied', permission: 'denied', failureStage: 'permission', error: reason }, 'tool.denied');
    await this.enqueue(record.requestId);
    if (input.approved === true) throw new Error(reason);
    return this.store.getTool(id);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const request of this.active.values()) request.controller.abort();
    await this.ready;
    await Promise.all([...this.active.values()].map(request => request.promise));
  }
  busy(sessionId: string): boolean { return [...this.active.values()].some(request => request.sessionId === sessionId); }
  /** Stop only this conversation; persisted cancellation also suppresses startup continuation. */
  async cancelAndSettle(sessionId: string): Promise<void> {
    const requests = [...this.active.entries()].filter(([, request]) => request.sessionId === sessionId);
    for (const [requestId, request] of requests) {
      this.store.updateRequest(requestId, { toolsCancelledAt: new Date().toISOString() });
      request.controller.abort();
    }
    await Promise.all(requests.map(([, request]) => request.promise));
    for (const [requestId] of requests) this.cancelUndispatched(requestId);
  }
  private cancelUndispatched(requestId: string): void {
    for (const record of this.store.toolCalls({ requestId, limit: 500 })) {
      if (terminal.has(record.status)) continue;
      const intent = record.intentId ? this.services.kernel.getIntent(record.intentId) : undefined;
      if (!intent && record.status !== 'proposed' && record.status !== 'awaiting_approval') continue;
      if (intent && !['prepared', 'approved', 'denied'].includes(intent.state)) continue;
      const error = 'Operator cancelled this Chat tool batch before dispatch.';
      if (intent && intent.state !== 'denied') this.services.kernel.deny(intent.id, error);
      this.appendResult(this.save(record, { status: 'denied', permission: 'denied', error }, 'tool.cancelled'));
    }
  }
  private enqueue(requestId: string): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const existing = this.active.get(requestId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const sessionId = this.store.getRequest(requestId).sessionId;
    // Register the batch before its first state event, so the UI observes real tool activity.
    const promise = Promise.resolve().then(() => this.process(requestId, controller.signal)).catch(error => {
      const request = this.store.getRequest(requestId);
      this.store.trace({ sessionId: request.sessionId, requestId, type: 'chat.tools_blocked', status: 'failed', payload: { message: this.sanitize(String(error)) } });
    }).finally(() => { this.active.delete(requestId); this.services.product?.chatToolsChanged(sessionId); });
    this.active.set(requestId, { sessionId, controller, promise });
    this.services.product?.chatToolsChanged(sessionId);
    return promise;
  }
  private save(record: ToolRecord, patch: Partial<ToolRecord>, type: string): ToolRecord {
    const next = this.store.saveTool(this.sanitize({ ...record, ...patch }));
    this.store.trace({ sessionId: next.sessionId, requestId: next.requestId, taskId: next.taskId, runId: next.runId, type, status: next.status,
      payload: { toolId: next.id, intentId: next.intentId, name: next.name, digest: next.digest, permission: next.permission, error: next.error, failureStage: next.failureStage } });
    return next;
  }
  private allowed(record: ToolRecord): void {
    const session = this.store.getSession(record.sessionId), request = this.store.getRequest(record.requestId);
    if (!definitions.some(tool => tool.function.name === record.name)) throw new ToolStageError('unknown_tool', 'The model requested an unregistered tool.');
    const exposed: string[] = request.exposedToolNames ?? request.body?.tools?.map((tool: any) => tool.function?.name) ?? [];
    // Registered side-effect tools (write_file, run_shell, mcp_call, integrations) fall through
    // to the permission error: Chat never executes them, whatever the session capabilities say.
    const enabled = MEMORY_TOOL_NAMES.has(record.name)
      || SKILL_TOOL_NAMES.has(record.name) && session.capabilities.skills
      || workspaceReadTools.has(record.name) && session.capabilities.tools
      || webReadTools.has(record.name) && session.capabilities.web
      || mcpReadTools.has(record.name) && session.capabilities.mcp;
    if (request.kind !== 'chat' || request.sessionId !== session.id || !enabled || !exposed.includes(record.name)) throw new ToolStageError('permission', 'This tool was not both enabled for the Chat session and exposed in its actual request.');
  }
  private taskFor(sessionId: string): string {
    const session = this.store.getSession(sessionId);
    const current = this.store.latestChatToolBinding(sessionId)?.taskId;
    // A cached task is only the authority for the scope it was created in. A changed project gets a
    // new read-only task; the replaced one keeps its workspace, records and receipts untouched.
    if (current && this.inScope(current, session)) return current;
    // An interrupted binding must settle before a new one starts: replaying its recorded command
    // returns the task the earlier attempt may already own instead of allocating a second one.
    const pending = this.store.pendingChatToolBinding(sessionId);
    if (pending) {
      const settled = this.settleBinding(sessionId, pending);
      if (this.inScope(settled, session)) return settled;
    }
    // A default Chat session stores the installation root as its read-only scope. That implicit root
    // (or no scope at all) must let the Kernel allocate data/workspaces/<taskId>: forwarding it would
    // make Services reject the running installation as a mutable workspace. Any other explicitly
    // stored scope is forwarded unchanged so the Services boundary still rejects dangerous roots.
    const scope = this.explicitScope(session);
    const index = (this.store.latestChatToolBinding(sessionId)?.index ?? -1) + 1;
    const command = this.bindingCommand(session, index, scope);
    // Record the identity before the Kernel can commit it: a crash in between replays to one task.
    const marker: PendingChatToolBinding = { index, ...(scope ? { scope } : {}), command };
    this.store.setPendingChatToolBinding(sessionId, marker);
    return this.settleBinding(sessionId, marker);
  }
  /**
   * Settles one binding marker. Replaying the recorded command either creates the intended task or
   * returns its original task when the command already committed, so one identity can never allocate
   * two tasks. The task becomes externally managed before anything can run it, and the bound list is
   * written before the marker is cleared, so a crash after either step is still recoverable.
   */
  private settleBinding(sessionId: string, pending: PendingChatToolBinding): string {
    // A crash after the bound list was written leaves only the marker: that binding is already done.
    const recorded = this.store.chatToolBinding(sessionId, pending.index);
    const taskId = recorded ?? this.services.command(pending.command).taskId;
    if (!taskId) throw new Error('The Chat tool task command returned no task.');
    this.services.runner.managedExternally.add(taskId);
    this.store.completeChatToolBinding(sessionId, pending, taskId);
    return taskId;
  }
  /**
   * The Kernel command identity of one new scope binding. It derives from durable state only, so a
   * retried or replayed binding reconstructs the same id and a genuinely new scope gets its own,
   * while the first binding keeps the id earlier versions shipped so an existing installation
   * replays its original task instead of allocating a second one.
   */
  private bindingCommand(session: ChatSession, index: number, scope: string | undefined): Command {
    const canonical = scope ? path.resolve(scope).toLowerCase() : 'default';
    const commandId = index === 0 ? `chat-tools-${session.id}`
      : `chat-tools-${session.id}-${index}-${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
    return { commandId, type: 'create_task', parameters: {
      title: `Chat tools · ${session.title}`, ...(scope ? { workspace: scope } : {}),
      permission: { app: 'chat', mode: 'read-only' },
      goal: { objective: `Execute only approved tool proposals from Chat ${session.id}`, constraints: [], acceptance: [], maxModelCalls: 1, maxToolCalls: 1000, mode: 'collaborative' },
    } };
  }
  /** The explicit mutable scope of a Chat session; the installation root means "Kernel default". */
  private explicitScope(session: ChatSession): string | undefined {
    return session.workspace && !samePath(session.workspace, this.services.projectRoot) ? session.workspace : undefined;
  }
  /** True when a recorded task still represents the session's present scope. */
  private inScope(taskId: string, session: ChatSession): boolean {
    const task = this.services.kernel.getTask(taskId);
    if (!task) return false;
    const scope = this.explicitScope(session);
    return scope ? samePath(task.workspace, scope) : samePath(task.workspace, path.join(this.services.dataDir, 'workspaces', task.id));
  }
  private runFor(taskId: string): string {
    const { kernel } = this.services, task = kernel.getTask(taskId)!;
    if (['paused', 'cancelled', 'failed', 'completed', 'reconciling'].includes(task.status)) throw new Error('Chat tool task is stopped or has an unresolved effect.');
    const run = kernel.getRuns(taskId).at(-1);
    if (run?.status === 'running' && run.generation === task.generation) {
      if (task.status === 'waiting_approval') kernel.transition(taskId, 'running');
      return run.id;
    }
    if (task.status === 'waiting_input') kernel.command({ commandId: randomUUID(), type: 'retry', taskId });
    const next = kernel.createRun(taskId); kernel.transition(taskId, 'running'); return next.id;
  }
  private async prepared(record: ToolRecord, taskId: string) {
    const task = this.services.kernel.getTask(taskId)!, gateway = this.services.runner.gateway(task);
    const integration = await this.services.integrations?.tools.prepare(task.workspace, record);
    const external = integration ? undefined : this.services.external.prepare({ name: record.name, arguments: record.arguments });
    const prepared = integration ?? external ?? await gateway.prepare(record);
    return { prepared, executor: integration ? this.services.integrations.tools : external ? this.services.external : gateway };
  }
  /**
   * The only authority that may read a dispatched effect's original receipt. A missing optional
   * integration store makes the receipt unavailable; it never authorizes a second execution.
   */
  private receiptReader(intent: Intent) {
    if (integrationNames.has(intent.name)) return this.services.integrations?.tools;
    return ['web_search', 'web_fetch', 'web_crawl', 'mcp_call', 'mcp_read'].includes(intent.name) ? this.services.external : this.services.runner.gateway(this.services.kernel.getTask(intent.taskId)!);
  }
  /** Settle an applied effect from its original receipt, preferring the independent observer. */
  private async settleApplied(record: ToolRecord, intent: Intent): Promise<void> {
    const reader = this.receiptReader(intent);
    let unavailable: string | undefined;
    if (reader) {
      try {
        const outcome = await reader.queryOutcome(intent.effectKey, digestValue({ name: intent.name, arguments: intent.arguments }));
        if (outcome.status === 'applied') return this.settled(record, intent, outcome);
        unavailable = outcome.error;
      } catch (error) { unavailable = this.sanitize(error instanceof Error ? error.message : String(error)); }
    }
    // The Kernel reaches "applied" only through a recorded receipt, so this is the original outcome,
    // never an invented one. Without any receipt the effect stays unknown for an operator.
    if (!intent.receipt) {
      this.save(record, { status: 'unknown', failureStage: 'reconciliation', error: unavailable ?? 'No original receipt is available; this effect will not be replayed.' }, 'tool.reconciliation_required');
      return;
    }
    this.settled(record, intent, { status: 'applied', output: JSON.stringify(intent.receipt), receipt: intent.receipt });
  }
  private async process(requestId: string, signal: AbortSignal): Promise<void> {
    if (this.store.getRequest(requestId).toolsCancelledAt) this.cancelUndispatched(requestId);
    const records = this.store.toolCalls({ requestId, limit: 500 }).reverse();
    for (const item of records) {
      if (signal.aborted || this.stopping) return;
      try { await resourceBudget.wait(signal); }
      catch (error) { if (signal.aborted || this.stopping) return; throw error; }
      let record = this.store.getTool(item.id);
      if (terminal.has(record.status)) { this.appendResult(record); continue; }
      if (record.status === 'unknown') return;
      let intent: Intent | undefined;
      let stage: NonNullable<ToolRecord['failureStage']> = 'validation';
      try {
        intent = record.intentId ? this.services.kernel.getIntent(record.intentId) : undefined;
        if (intent?.state === 'unknown' || intent?.state === 'sent') { await this.reconcile(record, intent); if (terminal.has(this.store.getTool(record.id).status)) continue; return; }
        if (intent?.state === 'applied') { await this.settleApplied(record, intent); continue; }
        if (intent?.state === 'failed') {
          this.appendResult(this.save(record, { status: 'failed', result: JSON.stringify({ error: intent.failure }), failureStage: 'execution', error: intent.error }, 'tool.failed'));
          continue;
        }
        this.allowed(record);
        validateArguments(record.arguments, definitions.find(tool => tool.function.name === record.name)!.function.parameters);
        if (MEMORY_TOOL_NAMES.has(record.name)) {
          const result = memoryTool(this.store.memory(record.sessionId, undefined, value => this.sanitize(value)), record, record.id);
          this.appendResult(this.save(record, { status: 'completed', permission: 'session_memory', result }, 'tool.completed'));
          continue;
        }
        if (SKILL_TOOL_NAMES.has(record.name)) {
          const session = this.store.getSession(record.sessionId);
          const result = await skillTool({ workspace: session.workspace ?? this.services.projectRoot, skillRoots: this.services.configuration.skillRoots,
            disabledSkillIds: this.services.instructionSettings.disabledSkillIds(), enabled: session.capabilities.skills, signal }, record);
          if (signal.aborted || this.stopping) return;
          this.appendResult(this.save(record, { status: 'completed', permission: 'read_only', result }, 'tool.completed'));
          continue;
        }
        if (record.name === 'list_mcp_tools') {
          const result = JSON.stringify(await this.services.external.chatMcpTools(record.arguments, signal));
          this.appendResult(this.save(record, { status: 'completed', permission: 'read_only', result }, 'tool.completed'));
          continue;
        }
        const taskId = record.taskId ?? this.taskFor(record.sessionId);
        const { prepared, executor } = await this.prepared(record, taskId);
        if (!intent && prepared.mcpDefinition && !record.mcpDefinition)
          record = this.save(record, { mcpDefinition: recordedMcpDefinition(prepared.mcpDefinition, this.store.getRequest(requestId).recordContent) }, 'tool.definition_captured');
        if (signal.aborted) return;
        const runId = this.runFor(taskId);
        if (intent && intent.runId !== runId) intent = this.services.kernel.rebindIntent(intent.id, runId);
        if (intent?.state === 'denied') {
          record = this.save(record, { status: 'denied', error: intent.error }, 'tool.denied'); this.appendResult(record); continue;
        }
        if (intent && prepared.digest !== digestValue({ name: intent.name, arguments: intent.arguments })) throw new Error('Prepared tool artifact changed. A new tool proposal is required.');
        if (!intent) intent = this.services.kernel.prepareIntent(taskId, runId, { id: record.toolCallId, name: record.name, arguments: prepared.arguments }, {
          effectKey: digest({ chatToolId: record.id, taskId }), capability: capability[prepared.capability] ?? prepared.capability,
          resources: prepared.resources,
          paths: integrationNames.has(record.name)
            ? (prepared.arguments.manifest as { path: string }[]).map(file => path.join(this.services.kernel.getTask(taskId)!.workspace, file.path))
            : ['network.read', 'mcp.call'].includes(prepared.capability) ? [] : prepared.resources.filter(resource => !resource.startsWith('fixture:')),
        });
        record = this.save(record, { taskId, runId, intentId: intent.id, digest: prepared.digest, permission: 'read_only' }, 'tool.prepared');
        // Chat never asks: the kernel's trusted policy is the only authority, and only an outright
        // allow may turn an intent into a dispatch. ask/review/deny all settle here as permission
        // failures, so a Chat tool can never wait for an approval it is not allowed to receive.
        const decision = this.services.kernel.decideIntent(intent.id);
        if (intent.state === 'prepared' && decision.outcome === 'allow') intent = this.services.kernel.approve(intent.id, { source: 'policy' });
        if (intent.state !== 'approved') {
          const reason = `Chat tools cannot execute this effect: ${decision.reason}`;
          this.services.kernel.deny(intent.id, reason);
          record = this.save(record, { status: 'failed', failureStage: 'permission', error: reason }, 'tool.rejected');
          this.appendResult(record);
          continue;
        }
        this.services.kernel.dispatch(intent.id);
        stage = 'execution';
        record = this.save(record, { status: 'running', permission: 'approved' }, 'tool.started');
        const started = performance.now();
        const outcome = await executor.execute(prepared, { effectKey: intent.effectKey, approvedDigest: prepared.digest, signal });
        record = this.save(record, { durationMs: Math.round(performance.now() - started) }, 'tool.execution_finished');
        if (this.settleFailure(record, intent, outcome)) continue;
        if (outcome.status !== 'applied' || !outcome.receipt) {
          this.services.kernel.unknown(intent.id, outcome.error ?? 'Tool outcome is unknown.');
          this.save(record, { status: 'unknown', failureStage: 'execution', error: outcome.error ?? 'Tool outcome is unknown; reconcile before continuing.' }, 'tool.unknown'); return;
        }
        this.services.kernel.receipt(intent.id, outcome.receipt);
        this.settled(record, intent, outcome);
      } catch (error) {
        const message = this.sanitize(error instanceof Error ? error.message : String(error));
        const latestIntent = intent ? this.services.kernel.getIntent(intent.id) : undefined;
        if (latestIntent && ['sent', 'unknown'].includes(latestIntent.state)) {
          if (latestIntent.state === 'sent') this.services.kernel.unknown(latestIntent.id, message);
          this.save(record, { status: 'unknown', failureStage: stage, error: message }, 'tool.unknown'); return;
        }
        if (latestIntent && ['prepared', 'approved'].includes(latestIntent.state)) this.services.kernel.deny(latestIntent.id, message);
        const failureStage = error instanceof ToolStageError ? error.stage : error instanceof KernelError && permissionCodes.has(error.code) ? 'permission' : stage;
        record = this.save(record, { status: 'failed', failureStage, error: message }, 'tool.rejected'); this.appendResult(record);
      }
    }
    await this.continue(records, signal);
  }
  private settled(record: ToolRecord, intent: Intent, outcome: ToolOutcome): void {
    const businessError = record.name === 'mcp_read' && (outcome.receipt?.result as { isError?: unknown } | undefined)?.isError === true;
    this.appendResult(this.save(record, { taskId: intent.taskId, runId: intent.runId, intentId: intent.id,
      status: businessError ? 'failed' : 'completed', result: outcome.output,
      error: businessError ? 'MCP tool returned isError=true.' : undefined, failureStage: businessError ? 'execution' : undefined }, businessError ? 'tool.failed' : 'tool.completed'));
  }
  /** Only an executor's persisted known failure can settle a read adapter without a receipt. */
  private settleFailure(record: ToolRecord, intent: Intent, outcome: ToolOutcome): boolean {
    if (outcome.status !== 'failed' || record.name !== 'mcp_read') return false;
    const diagnostic = JSON.parse(outcome.output).error as IntentFailure;
    if (diagnostic?.source !== 'mcp' || diagnostic.tool !== intent.name) throw new Error('MCP failure diagnostic does not match its dispatch.');
    const failure: IntentFailure = { code: diagnostic.code, source: 'mcp', tool: intent.name,
      ...(diagnostic.message ? { message: this.sanitize(diagnostic.message).slice(0, 2000) } : {}) };
    if (intent.state === 'unknown') this.services.kernel.reconcileFailure(intent.id, failure);
    else this.services.kernel.failIntent(intent.id, failure);
    this.appendResult(this.save(record, { status: 'failed', result: outcome.output, failureStage: 'execution', error: outcome.error }, 'tool.failed'));
    return true;
  }
  private appendResult(record: ToolRecord): void {
    if (this.store.toolResultExists(record.sessionId, record.requestId, record.toolCallId)) return;
    // A legal MCP error result was observed, so forward it without claiming the tool never ran.
    const observedFailure = record.name === 'mcp_read' && record.status === 'failed' && record.intentId
      && this.services.kernel.getIntent(record.intentId)?.state === 'applied';
    this.store.addMessage(record.sessionId, { role: 'tool', requestId: record.requestId, toolCallId: record.toolCallId,
      ...(MEMORY_TOOL_NAMES.has(record.name) ? { archiveRecall: true } : {}),
      content: this.sanitize(record.status === 'completed' || observedFailure ? typeof record.result === 'string' ? record.result : JSON.stringify(record.result) : JSON.stringify({ error: record.error ?? 'Tool was not executed.', executed: false })) });
  }
  private async continue(records: ToolRecord[], signal?: AbortSignal): Promise<void> {
    if (!records.length || signal?.aborted || this.stopping) return;
    const first = records[0]!, current = records.map(record => this.store.getTool(record.id));
    if (this.store.getRequest(first.requestId).toolsCancelledAt) return;
    if (!current.every(record => terminal.has(record.status)) || current.some(record => record.receivedByRequestId)) return;
    // Settle the task that actually owns this batch; with a changed scope the session mapping may
    // already point at a newer task whose receipts must not be touched by this batch.
    const taskId = current.findLast(record => record.taskId)?.taskId ?? this.store.latestChatToolBinding(first.sessionId)?.taskId;
    if (taskId) {
      const task = this.services.kernel.getTask(taskId)!;
      if (task.status === 'waiting_approval') this.services.kernel.transition(taskId, 'running');
      if (this.services.kernel.getTask(taskId)!.status === 'running') this.services.kernel.transition(taskId, 'waiting_input', { waitingReason: 'Chat tool batch settled; awaiting the next Chat request.' });
      const run = this.services.kernel.latestRun(taskId);
      if (run?.status === 'running') this.services.kernel.finishRun(run.id, 'completed');
    }
    const latest = this.store.latestRequest(first.sessionId, 'chat');
    if (latest?.id !== first.requestId) {
      if (latest?.parentId === first.requestId) for (const record of current) this.store.saveTool({ ...record, receivedByRequestId: latest.id });
      return;
    }
    const next = await this.chat.continue(first.sessionId, first.requestId);
    for (const record of current) this.store.saveTool({ ...record, receivedByRequestId: next.requestId });
  }
  private async reconcile(record: ToolRecord, intent: Intent): Promise<void> {
    // Only a dispatched intent is reconciled, and only from its original receipt. When that receipt
    // source is gone the effect settles as unknown: it must never be executed a second time.
    const reader = this.receiptReader(intent);
    if (!reader) {
      const reason = 'The receipt store for this dispatched effect is unavailable; it will not be replayed.';
      if (intent.state === 'sent') this.services.kernel.unknown(intent.id, reason);
      this.save(record, { status: 'unknown', failureStage: 'reconciliation', error: reason }, 'tool.reconciliation_required');
      return;
    }
    const outcome = await reader.queryOutcome(intent.effectKey, digestValue({ name: intent.name, arguments: intent.arguments }));
    if (this.settleFailure(record, intent, outcome)) return;
    if (outcome.status !== 'applied' || !outcome.receipt) { this.save(record, { status: 'unknown', failureStage: 'reconciliation', error: 'No conclusive receipt; this effect will not be replayed.' }, 'tool.reconciliation_required'); return; }
    if (intent.state === 'sent') this.services.kernel.unknown(intent.id, 'Reconcile recovered dispatch.');
    this.services.kernel.reconcile(intent.id, outcome.receipt);
    this.settled(record, intent, outcome);
  }
  private async recover(): Promise<void> {
    let page = this.store.recoveryRequests();
    while (!this.stopping) {
      for (const requestId of page.requestIds) {
        if (this.stopping) return;
        for (const record of this.store.toolCalls({ requestId, limit: 500 }).reverse()) {
          if (record.receivedByRequestId || terminal.has(record.status)) continue;
          if (!record.intentId) {
            // Proposed means no dispatch occurred. An unlinked in-flight record, however,
            // must never be treated as permission to repeat a possibly applied effect.
            if (record.status !== 'proposed') this.save(record, { status: 'unknown', failureStage: 'reconciliation', error: 'Missing dispatch identity; this effect will not be replayed.' }, 'tool.reconciliation_required');
            continue;
          }
          const intent = this.services.kernel.getIntent(record.intentId);
          if (!intent) {
            this.save(record, { status: 'unknown', failureStage: 'reconciliation', error: 'Dispatch intent not found; this effect will not be replayed.' }, 'tool.reconciliation_required');
            continue;
          }
          if (intent.state === 'sent' || intent.state === 'unknown') {
            try { await this.reconcile(record, intent); }
            catch (error) { this.save(record, { status: 'unknown', failureStage: 'reconciliation', error: this.sanitize(String(error)) }, 'tool.reconciliation_required'); }
          } else if (intent.state === 'applied') {
            await this.settleApplied(record, intent);
          }
        }
        if (!this.stopping) await this.enqueue(requestId);
      }
      if (page.nextCursor === null) return;
      page = this.store.recoveryRequests(page.nextCursor, page.snapshot);
    }
  }
}
