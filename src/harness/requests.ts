import { createHash } from 'node:crypto';
import type { ModelResult, ProviderConfig } from '../contracts.js';
import type { Services } from '../app/services.js';
import { ModelClient, ModelDiagnosticError, validateRequestBody, type ModelObserver, type ModelDelta } from '../runtime/model.js';
import { TOOL_DEFINITIONS } from '../runtime/prompts.js';
import { COORDINATION_TOOLS } from '../runtime/coordination-tools.js';
import { EXTERNAL_TOOL_DEFINITIONS, CHAT_MCP_TOOL_DEFINITIONS } from '../app/external-tools.js';
import { INTEGRATION_TOOL_DEFINITIONS } from '../integrations/tools.js';
import { COLLABORATION_TOOL_DEFINITIONS } from '../integrations/definitions.js';
import { customParts, effectiveParts, type PromptOverrides } from './prompts.js';
import { HarnessStore } from './store.js';
import { Profiles } from './profiles.js';
import type { PromptPart, RequestBody, RequestContext, RequestRecord, ToolRecord } from './types.js';

export const registeredTools = [...TOOL_DEFINITIONS, ...COORDINATION_TOOLS, ...EXTERNAL_TOOL_DEFINITIONS, ...CHAT_MCP_TOOL_DEFINITIONS, ...INTEGRATION_TOOL_DEFINITIONS, ...COLLABORATION_TOOL_DEFINITIONS];
export const toolSource = (name: string) => COLLABORATION_TOOL_DEFINITIONS.some(tool => tool.function.name === name) ? 'collaboration' : INTEGRATION_TOOL_DEFINITIONS.some(tool => tool.function.name === name) ? 'integration' : name === 'mcp_call' || name === 'mcp_read' || name === 'list_mcp_tools' ? 'MCP' : name.startsWith('web_') ? 'web' : name === 'delegate' ? 'subagent' : 'builtin';

/** Records at the adapter boundary. Studio bodies are sent as edited, never reassembled. */
export class Requests {
  constructor(readonly store: HarnessStore, readonly profiles: Profiles, private readonly services: Services) {}
  /** Upgrade historical request scopes in fixed pages, yielding between commits; never decode model bodies. */
  async recoverAccountingScopes(): Promise<void> {
    let cursor = this.store.getSetting<number>('metricScope075Cursor', 0);
    for (;;) {
      const rows = this.store.accountingRequestPage(cursor);
      if (!rows.length) return;
      const cache = new Map<string, string[]>();
      this.store.transaction(() => {
        for (const row of rows) if (row.task_id) {
          const key = JSON.stringify([row.task_id, row.parent]);
          let ancestors = cache.get(key);
          if (!ancestors) { ancestors = this.services.kernel.accountingAncestors(row.task_id, row.parent ?? undefined); cache.set(key, ancestors); }
          this.store.saveAccountingScopes(row.id, ancestors);
        }
        cursor = Number(rows.at(-1)!.seq); this.store.setSetting('metricScope075Cursor', cursor);
      });
      if (rows.length < 256) return;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  recordContent(): boolean { return this.store.getSetting('recordContent', true); }
  profileId(context: Pick<RequestContext, 'profileId' | 'taskId'>): string {
    const promoted = context.taskId ? this.store.getSetting<any>(`promotedChat:${context.taskId}`, {}) : {};
    return context.profileId ?? promoted.profileId ?? 'default';
  }
  client(context: RequestContext): ModelClient {
    const selected = this.profileId(context);
    return this.profiles.get(selected).client({ ...context, profileId: selected });
  }
  /** Reasoning mapping is display configuration; it may only shape provider parameters, never authority fields. */
  private reasoningBody(context: RequestContext, body: RequestBody): RequestBody {
    const product = this.services.product;
    return product ? product.models.applyReasoning(body, this.profileId(context), context.reasoningEffort) : body;
  }
  prepare(context: RequestContext, body: RequestBody, sources: PromptPart[] = [], reasoningApplied = false): RequestRecord {
    const applied = reasoningApplied ? body : this.reasoningBody(context, body);
    const profileId = this.profileId(context), config = this.profiles.get(profileId).provider;
    validateRequestBody(applied, config);
    const clean = this.profiles.sanitize(applied), recordContent = this.recordContent();
    const { coordination: _coordination, ...recordContext } = context;
    const budgetTaskIds = context.taskId ? this.services.kernel.accountingAncestors(context.taskId) : [];
    return this.store.createRequest({ ...recordContext, ...(budgetTaskIds.length ? { budgetTaskIds } : {}), profileId, status: 'draft', endpoint: new URL('chat/completions', config.baseUrl.replace(/\/?$/, '/')).href,
      body: recordContent ? clean : undefined, bodyHash: createHash('sha256').update(JSON.stringify(clean)).digest('hex'),
      sources: recordContent ? this.profiles.sanitize(effectiveParts(clean, sources)) : [], recordContent, draft: '',
      exposedToolNames: clean.tools?.map((tool: any) => tool.function.name) ?? [] });
  }
  assembleWorkBody(context: RequestContext, body: RequestBody, overrides?: PromptOverrides): { body: RequestBody; sources: PromptPart[] } {
    const task = this.services.task(context.taskId), promoted = this.store.getSetting<any>(`promotedChat:${task.id}`, {});
    const scoped = customParts(this.store, { id: task.id, workspace: task.workspace, systemPrompt: promoted.systemPrompt ?? '', developerPrompt: promoted.developerPrompt ?? '' }, overrides);
    const messages = [...body.messages], additions = scoped.filter(p => p.effective && p.content).map(p => ({ role: p.role, content: p.content }));
    messages.splice(1, 0, ...additions);
    const compiled = { ...promoted.requestTemplate, ...body, ...promoted.parameters, messages, tools: body.tools, model: body.model };
    if (compiled.stream === false) delete compiled.stream_options;
    return { body: compiled, sources: [...context.sources ?? [], ...scoped] };
  }
  observer(context: RequestContext, config: ProviderConfig): ModelObserver {
    let record: RequestRecord | undefined, text = '', lastFlush = 0;
    const publishSideAccounting = (phase: 'dispatched' | 'settled') => {
      if (context.kind !== 'side' || !record) return;
      // Display work follows committed accounting/request records and cannot replace a provider result.
      try { this.services.product?.sideRequestChanged(record, phase); } catch { /* Projection is best-effort. */ }
    };
    const event = (type: string, status: string, extra: Record<string, unknown> = {}) => {
      if (record) this.store.trace({ sessionId: record.sessionId, taskId: record.taskId, runId: record.runId, requestId: record.id, parentId: record.parentId, type, status, ...extra });
    };
    return {
      dispatching: () => {
        if (context.kind === 'side' && context.taskId && record) this.services.kernel.sideRequests.dispatch(record.id, context.taskId, context.sideBudgetSessionId ?? context.sessionId);
        const selection = context.kind === 'work' ? context.coordination?.selection : undefined;
        if (selection && record && context.runId) this.services.kernel.coordination.dispatch(selection, context.runId, record.id, record.bodyHash);
        publishSideAccounting('dispatched');
      },
      responseObserved: () => {
        if (context.kind === 'side' && context.taskId && record) this.services.kernel.sideRequests.settle(record.id, 'response_observed');
        if (context.kind === 'work' && context.coordination?.selection && record) this.services.kernel.coordination.settle(record.id, 'response_observed');
      },
      prepare: raw => this.store.transaction(() => {
        record = undefined; text = ''; lastFlush = 0;
        // Claim this promoted Work task's request-scope edits inside the same transaction that creates
        // the request, so they apply to exactly one real next request. A throw rolls the claim back.
        const claim = context.kind === 'work' && context.taskId ? this.store.takeRequestOverrides(context.taskId) : undefined;
        const compiled = context.kind === 'work' && context.taskId ? this.assembleWorkBody(context, raw, claim?.overrides) : { body: raw, sources: context.sources ?? [] };
        const body = this.profiles.sanitize(this.reasoningBody(context, compiled.body));
        record = context.requestId ? this.store.getRequest(context.requestId) : this.prepare(context, body, compiled.sources, true);
        if (claim) this.store.confirmRequestOverrides(claim.token, record.id);
        const recordContent = record.recordContent;
        record = this.store.updateRequest(record.id, { status: 'running', body: recordContent ? body : undefined,
          model: body.model, startedAt: new Date().toISOString(), contextWindowTokens: body.model === config.model ? config.contextWindowTokens : undefined,
          bodyHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'), sources: recordContent ? effectiveParts(body, compiled.sources.length ? compiled.sources : record.sources.filter(p => !p.id.startsWith('effective:'))) : [],
          exposedToolNames: body.tools?.map((tool: any) => tool.function.name) ?? [] });
        // The wire protocol drops source request ids. Work's context manifest preserves the
        // selected raw message identities, including truncated results and reused call ids.
        const manifest = context.kind === 'work' ? context.sources?.find(source => source.id === 'context-manifest') : undefined;
        if (manifest && context.taskId) for (const source of JSON.parse(manifest.content).sources as { id: string; included: boolean }[]) {
          if (!source.included) continue;
          const message = this.services.kernel.getMessage(source.id);
          if (message?.taskId !== context.taskId || message.role !== 'tool' || !message.requestId || !message.toolCallId) continue;
          const tool = this.store.findTool(context.taskId, message.toolCallId, { requestId: message.requestId });
          if (tool) this.store.saveTool({ ...tool, receivedByRequestId: record.id });
        }
        event('prompt.assembled', 'completed', { payload: { bodyHash: record.bodyHash, sourceCount: record.sources.length, recordContent } });
        event('context.selected', 'completed', { payload: { messageCount: body.messages.length, bytes: Buffer.byteLength(JSON.stringify(body)) } });
        event('request.started', 'running', { payload: { model: body.model, exposedTools: record.exposedToolNames } });
        return { body, requestId: record.id };
      }),
      delta: delta => {
        if (!record?.recordContent) return;
        text += delta.content ?? '';
        if (Date.now() - lastFlush >= 180) { this.store.updateRequest(record.id, { draft: this.profiles.sanitize(text) }); lastFlush = Date.now(); }
      },
      completed: (raw, durationMs) => { this.store.transaction(() => {
        if (!record) return;
        if (context.kind === 'work' && context.coordination?.selection) this.services.kernel.coordination.settle(record.id, 'completed');
        const result = this.profiles.sanitize(raw);
        if (context.kind === 'side' && context.taskId) this.services.kernel.sideRequests.settle(record.id, 'completed', result.usage);
        this.store.updateRequest(record.id, { status: 'completed', response: record.recordContent ? result : undefined, draft: record.recordContent ? result.content : '', usage: result.usage, durationMs });
        for (const call of result.toolCalls) {
          const definition = record.body?.tools?.find((tool: any) => tool.function.name === call.name)?.function ?? registeredTools.find(tool => tool.function.name === call.name)?.function;
          const stamp = new Date().toISOString(), studio = record.kind === 'studio';
          const tool: ToolRecord = { id: `${record.id}:${call.id}`, requestId: record.id, sessionId: record.sessionId, taskId: record.taskId, runId: record.runId, parentId: record.parentId,
            toolCallId: call.id, name: call.name, arguments: call.arguments, source: toolSource(call.name), schema: definition?.parameters, description: definition?.description,
            permission: studio ? 'model_only' : 'unassessed', status: studio ? 'not_executed' : 'proposed', retries: 0, createdAt: stamp, updatedAt: stamp };
          this.store.saveTool(tool);
        }
        event('request.completed', 'completed', { durationMs, payload: { usage: result.usage, toolCalls: result.toolCalls.length, finishReason: result.finishReason } });
      }); publishSideAccounting('settled'); },
      failed: (error, durationMs) => { this.store.transaction(() => {
        if (!record) return;
        const code = error instanceof ModelDiagnosticError ? error.code : 'request_failed', status = code === 'cancelled' ? 'cancelled' : 'failed';
        if (context.kind === 'side' && context.taskId) this.services.kernel.sideRequests.settle(record.id, status);
        if (context.kind === 'work' && context.coordination?.selection) this.services.kernel.coordination.settle(record.id, status);
        const message = this.profiles.sanitize(error instanceof Error ? error.message : String(error));
        this.store.updateRequest(record.id, { status, error: { code, message }, durationMs }); event('request.failed', status, { durationMs, payload: { code, message } });
      }); publishSideAccounting('settled'); },
    };
  }
  async send(requestId: string, body: RequestBody | undefined, signal: AbortSignal, onDelta?: (delta: ModelDelta) => void): Promise<ModelResult> {
    const record = this.store.getRequest(requestId);
    if (record.status !== 'draft') throw new Error('Only a draft can be sent. Replay creates a new request.');
    const selected = body ?? record.body;
    if (!selected) throw new Error('This request did not retain its Body. Construct a new preview to send.');
    validateRequestBody(selected, this.profiles.get(record.profileId).provider);
    try { return await this.client({ ...record, requestId }).completeRaw(selected, signal, onDelta); }
    catch (error) {
      if (this.store.getRequest(requestId).status === 'draft') this.store.updateRequest(requestId, { status: 'failed', error: { code: 'dispatch_rejected', message: this.profiles.sanitize(String(error)) } });
      throw error;
    }
  }
}
