import { randomUUID } from 'node:crypto';
import type { Services } from '../app/services.js';
import type { RequestContext, RequestRecord, ChatSession, TraceQuery, RequestBody, PromptPart } from './types.js';
import { HarnessStore } from './store.js';
import { Profiles } from './profiles.js';
import { Requests, registeredTools } from './requests.js';
import { ChatService } from './chat.js';
import { ChatTools } from './chat-tools.js';
import { customParts, promptSettings } from './prompts.js';
import { WorkTrace } from './work-trace.js';
import { ModelClient, validateRequestBody } from '../runtime/model.js';
import { MEMORY_TOOL_NAMES } from '../memory/tools.js';
import { SKILL_TOOL_NAMES } from '../runtime/skill-tools.js';
import type { ScopedMemoryPort } from '../memory/tools.js';
import { ChainedOriginMemory, WorkOriginMemory, copyWorkOrigin, discardWorkOrigin, verifyWorkOrigin, workOriginFile } from './origin.js';
import type { WorkBranchLink, WorkMessageRow, WorkOriginLayer } from './origin.js';
import { INTEGRATION_TOOL_DEFINITIONS } from '../integrations/tools.js';
import { COLLABORATION_TOOL_DEFINITIONS } from '../integrations/definitions.js';
import { isRiskLevel } from '../kernel/permissions.js';
import type { RiskLevel } from '../contracts.js';

const originLayerKey = (layer: WorkOriginLayer): string => layer.kind === 'work' ? 'work:' + layer.taskId : 'promoted:' + layer.taskId;
/** Small startup batches keep crash recovery bounded while still amortizing the SQL round trip. */
const ORIGIN_RECOVERY_PAGE = 50;

const queryOf = (url: URL): TraceQuery => {
  const query: TraceQuery = {};
  if (url.searchParams.get('order') === 'desc') query.order = 'desc';
  for (const key of ['sessionId', 'taskId', 'requestId', 'q', 'type'] as const) if (url.searchParams.has(key)) query[key] = url.searchParams.get(key)!;
  for (const key of ['after', 'limit'] as const) if (url.searchParams.has(key)) {
    const value = Number(url.searchParams.get(key)); if (!Number.isSafeInteger(value) || value < (key === 'limit' ? 1 : 0)) throw new Error(`Invalid ${key} cursor.`); query[key] = value;
  }
  return query;
};

/** Thin product routes; model transport, permissions and Work state remain shared. */
export class Harness {
  readonly store: HarnessStore;
  readonly profiles: Profiles;
  readonly requests: Requests;
  readonly chat: ChatService;
  readonly tools: ChatTools;
  readonly workTrace: WorkTrace;
  private readonly studio = new Map<string, { controller: AbortController; completion: Promise<void> }>();
  constructor(private readonly services: Services) {
    this.store = new HarnessStore(services.dataDir);
    this.profiles = new Profiles(this.store, services.configuration, services.dataDir);
    this.requests = new Requests(this.store, this.profiles, services);
    services.configuration.modelObserver = (context, config) => this.requests.observer(context, config);
    this.profiles.setObservers();
    services.runner.modelClient = context => { this.workTrace.sync(context.taskId); return this.requests.client(context); };
    services.runner.originMemory = taskId => this.originMemory(taskId);
    services.runner.reviewSettings = () => this.autoReview();
    services.runner.reviewBridge = { escalate: (intentId, reason) => this.services.kernel.escalateReview(intentId, reason) };
    this.workTrace = new WorkTrace(services, this.store, value => this.sanitize(value));
    services.runner.mcpDefinitionPrepared = (...args) => this.workTrace.captureMcpDefinition(...args);
    this.chat = new ChatService({ store: this.store, configuration: services.configuration, services,
      profileConfig: id => this.profiles.get(id).provider,
      disabledSkillIds: () => this.services.instructionSettings.disabledSkillIds(),
      getPromptParts: (session, overrides) => customParts(this.store, session, overrides),
      prepareModel: (context, body, sources) => this.requests.prepare(context, body, sources),
      sendPrepared: (id, body, signal, delta) => this.requests.send(id, body, signal, delta),
      onResponse: (session, requestId, result) => this.tools.accept(session, requestId, result), sanitize: value => this.sanitize(value),
      onMessage: (sessionId, message) => services.product?.chatMessage(sessionId, message),
      onStream: update => services.product?.chatStream(update) });
    this.tools = new ChatTools(services, this.store, this.chat, value => this.sanitize(value));
    // Startup runs before ProductApi indexes tasks. Pending preparations therefore either recover their exact
    // durable origin (and become ready) or are truthfully fenced before any index can expose them as usable.
    this.reconcileWorkOrigins();
  }
  /**
   * Recover or fence every crash-left pending origin preparation in bounded keyset pages. The Kernel query
   * filters state='pending' through the task_origins_state index, so startup cost follows the pending
   * backlog instead of all settled branch history. Recovery is allowed only when the paused Kernel task,
   * its persisted link, and the copied file all describe the exact prepared source prefix; a partial file,
   * missing link or mismatch cancels the branch instead of pretending the branch is complete.
   */
  private reconcileWorkOrigins(): void {
    let after: { updatedAt: string; taskId: string } | undefined;
    for (;;) {
      const page = this.services.kernel.pendingWorkOriginPreparations(after, ORIGIN_RECOVERY_PAGE);
      if (!page.length) return;
      for (const preparation of page) {
        const task = this.services.kernel.getTask(preparation.taskId);
        try {
          if (!task) throw new Error('The branch task row is missing.');
          if (task.status !== 'paused') throw new Error(`The branch task is ${task.status}, not paused.`);
          const link = this.workOriginLink(preparation.taskId);
          if (!link) throw new Error('The immutable branch origin link was never committed.');
          if (link.sourceTaskId !== preparation.sourceTaskId || link.sourceMessageId !== preparation.sourceMessageId || link.snapshot !== preparation.snapshot)
            throw new Error('The immutable branch origin link does not match the Kernel preparation.');
          const count = verifyWorkOrigin(workOriginFile(this.services.dataDir, preparation.taskId), link.sourceTaskId, link.sourceMessageId, link.snapshot, preparation.expectedCount);
          if (link.messageCount !== count) throw new Error('The immutable branch origin count does not match its link.');
          this.services.kernel.markWorkOriginReady(preparation.taskId, count);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.services.kernel.fenceIncompleteWorkOrigin(preparation.taskId, `The immutable branch origin could not be verified: ${reason}`);
          this.removeWorkOrigin(preparation.taskId);
        }
      }
      const last = page[page.length - 1]!;
      after = { updatedAt: last.updatedAt, taskId: last.taskId };
      if (page.length < ORIGIN_RECOVERY_PAGE) return;
    }
  }
  sanitize<T>(value: T): T { return this.profiles.sanitize(value); }
  /** Persisted link of a Work branch to its immutable origin; absent for normal and merely promoted tasks. */
  workOriginLink(taskId: string): WorkBranchLink | undefined {
    return this.store.getSetting<WorkBranchLink | null>('workOrigin:' + taskId, null) ?? undefined;
  }
  /** Validate one persisted ancestry entry before it can become part of a readable origin chain. */
  private originLayer(value: unknown, owner: string): WorkOriginLayer {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Work origin ancestry of ${owner} contains an invalid layer.`);
    const layer = value as Record<string, unknown>;
    if (layer.kind === 'work' && typeof layer.taskId === 'string' && layer.taskId
      && typeof layer.scopeTaskId === 'string' && layer.scopeTaskId
      && Number.isSafeInteger(layer.through) && (layer.through as number) >= 0) {
      return { kind: 'work', taskId: layer.taskId, scopeTaskId: layer.scopeTaskId, through: layer.through as number };
    }
    if (layer.kind === 'promoted' && typeof layer.taskId === 'string' && layer.taskId) return { kind: 'promoted', taskId: layer.taskId };
    throw new Error(`Work origin ancestry of ${owner} contains an invalid layer.`);
  }
  /**
   * Flattened immutable origin layers, nearest first. New links store the complete flattened ancestry, so depth
   * is metadata length, not a fixed hop limit. Old links without ancestry are walked once with a visited set;
   * self references, cycles, duplicate layers, incomplete ancestry and malformed snapshots fail truthfully rather
   * than dropping the older source. No raw history is copied here.
   */
  private originLayers(taskId: string, visiting = new Set<string>()): WorkOriginLayer[] {
    if (visiting.has(taskId)) throw new Error(`Work origin ancestry contains a cycle at ${taskId}.`);
    const link = this.workOriginLink(taskId);
    if (!link) return this.store.getSetting<{ sessionId?: string } | null>('promotedChat:' + taskId, null) ? [{ kind: 'promoted', taskId }] : [];
    if (typeof link.sourceTaskId !== 'string' || !link.sourceTaskId) throw new Error(`Work origin link of ${taskId} has no source task.`);
    if (link.sourceTaskId === taskId) throw new Error(`Work origin link of ${taskId} points to itself.`);
    if (!Number.isSafeInteger(link.snapshot) || link.snapshot < 0) throw new Error(`Work origin link of ${taskId} has an invalid snapshot.`);
    const layers: WorkOriginLayer[] = [{ kind: 'work', taskId, scopeTaskId: link.sourceTaskId, through: link.snapshot }];
    const keys = new Set([originLayerKey(layers[0]!)]);
    if (link.ancestry !== undefined) {
      if (!Array.isArray(link.ancestry)) throw new Error(`Work origin ancestry of ${taskId} is invalid.`);
      for (const raw of link.ancestry) {
        const layer = this.originLayer(raw, taskId), key = originLayerKey(layer);
        if (keys.has(key)) throw new Error(`Work origin ancestry of ${taskId} repeats ${key}.`);
        keys.add(key); layers.push(layer);
      }
      const first = layers[1];
      if (first && first.taskId !== link.sourceTaskId) throw new Error(`Work origin ancestry of ${taskId} does not start at ${link.sourceTaskId}.`);
      const sourceHasOrigin = Boolean(this.workOriginLink(link.sourceTaskId) || this.store.getSetting('promotedChat:' + link.sourceTaskId, null));
      if (!first && sourceHasOrigin) throw new Error(`Work origin ancestry of ${taskId} omits ${link.sourceTaskId}.`);
      return layers;
    }
    visiting.add(taskId);
    try { layers.push(...this.originLayers(link.sourceTaskId, visiting)); }
    finally { visiting.delete(taskId); }
    for (const layer of layers.slice(1)) {
      const key = originLayerKey(layer);
      if (keys.has(key)) throw new Error(`Work origin ancestry of ${taskId} repeats ${key}.`);
      keys.add(key);
    }
    return layers;
  }
  /**
   * Read-only origin archive of a branched Work task. A branch, a branch of a branch and a branch of a promoted
   * Chat task each contribute one immutable layer; the full flattened chain is read newest-first with no fixed cap.
   */
  originMemory(taskId: string): ScopedMemoryPort | undefined {
    const layers = this.originLayers(taskId);
    if (!layers.length) return undefined;
    const ports = layers.map(layer => {
      if (layer.kind === 'work') return new WorkOriginMemory(workOriginFile(this.services.dataDir, layer.taskId), layer.scopeTaskId, layer.through);
      const promoted = this.store.promotedMemory(layer.taskId);
      if (!promoted) throw new Error(`The preserved Chat origin of ${layer.taskId} is unavailable.`);
      return promoted;
    });
    return ports.length === 1 ? ports[0]! : new ChainedOriginMemory(ports);
  }
  /**
   * Copy the source prefix into this task's own origin file and persist the link plus the source's flattened
   * ancestry. Called only right after the paused task row exists; a failure here is cleaned up by the caller
   * together with that task.
   */
  createWorkOrigin(taskId: string, sourceTaskId: string, sourceMessageId: string, snapshot: number, readPage: (after: number, limit: number) => WorkMessageRow[]): WorkBranchLink {
    const ancestry = this.originLayers(sourceTaskId);
    const file = workOriginFile(this.services.dataDir, taskId);
    const messageCount = copyWorkOrigin(file, sourceTaskId, snapshot, readPage);
    const link: WorkBranchLink = { sourceTaskId, sourceMessageId, snapshot, messageCount, createdAt: new Date().toISOString(), ancestry };
    this.store.setSetting('workOrigin:' + taskId, link);
    return link;
  }
  /** Remove an abandoned branch origin file; the caller has already cancelled the matching paused task. */
  removeWorkOrigin(taskId: string): void {
    discardWorkOrigin(workOriginFile(this.services.dataDir, taskId));
    this.store.setSetting('workOrigin:' + taskId, null);
  }
  /**
   * Raw persistent Settings.autoReview values. Despite the legacy field name, the frontend stores
   * the selected ModelProfile.id here (SettingsView renders options with value={model.id}), so it
   * is an exact profile identity, not a provider.model display name.
   */
  autoReviewSettings(): { reviewerModelId: string; escalateAt: RiskLevel; explain: boolean } {
    const saved = this.store.getSetting<{ reviewerModelId?: unknown; escalateAt?: unknown; explain?: unknown }>('autoReview', {});
    return {
      reviewerModelId: typeof saved.reviewerModelId === 'string' ? saved.reviewerModelId.trim() : '',
      escalateAt: isRiskLevel(saved.escalateAt) ? saved.escalateAt : 'high',
      explain: saved.explain === true,
    };
  }
  /**
   * Resolve the saved selection by exact profile ID. A model-name or display-name match is never a
   * substitute: two profiles may share one provider.model, and a stale name must fail closed so the
   * runner escalates to a human instead of choosing an unintended reviewer.
   */
  autoReview(): { reviewerModelId: string; profileId: string; escalateAt: RiskLevel } | undefined {
    const settings = this.autoReviewSettings();
    if (!settings.reviewerModelId) return undefined;
    const profile = this.profiles.list().find(item => item.id === settings.reviewerModelId);
    return profile ? { reviewerModelId: profile.provider.model, profileId: profile.id, escalateAt: settings.escalateAt } : undefined;
  }
  private sessionInput(input: Record<string, any>, original?: ChatSession): Partial<ChatSession> {
    const patch: Partial<ChatSession> = {};
    for (const key of ['title', 'systemPrompt', 'developerPrompt', 'profileId'] as const) if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || input[key].length > 64000) throw new Error(`Invalid ${key}.`); patch[key] = input[key];
    }
    if (input.workspace !== undefined) patch.workspace = input.workspace ? this.services.assertWorkspacePath(String(input.workspace)) : undefined;
    if (input.parameters !== undefined) {
      if (!input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters)) throw new Error('parameters must be an object.');
      for (const key of ['messages', 'tools', 'apiKey', 'authorization', 'baseUrl']) if (key in input.parameters) throw new Error(`${key} is not a session parameter. Use the matching configuration control.`);
      patch.parameters = input.parameters;
    }
    if (input.capabilities !== undefined) {
      patch.capabilities = { web: false, tools: false, mcp: false, skills: false, projectInstructions: false, ...original?.capabilities };
      for (const key of Object.keys(patch.capabilities) as (keyof ChatSession['capabilities'])[]) if (input.capabilities[key] !== undefined) {
        if (typeof input.capabilities[key] !== 'boolean') throw new Error(`Capability ${key} must be boolean.`); patch.capabilities[key] = input.capabilities[key];
      }
    }
    const config = this.profiles.get(patch.profileId ?? original?.profileId ?? 'default').provider;
    const parameters = patch.parameters ?? original?.parameters ?? {};
    validateRequestBody({ ...new ModelClient(config).buildBody([{ role: 'user', content: 'validation' }]), ...parameters }, config);
    return this.sanitize(patch);
  }
  async preview(input: Record<string, any>): Promise<RequestRecord> {
    let context: RequestContext, body: RequestBody, sources: PromptPart[];
    if (input.sessionId) {
      const session = this.store.getSession(String(input.sessionId));
      context = { sessionId: session.id, kind: 'studio', profileId: session.profileId };
      ({ body, sources } = await this.chat.preview(session.id, input.overrides));
      if (!body.messages.length) throw new Error('Add a message before previewing.');
    } else if (input.taskId) {
      const task = this.services.task(input.taskId);
      const profileId = this.requests.profileId({ taskId: task.id, profileId: input.profileId });
      const config = this.profiles.get(profileId).provider;
      const compiled = await this.services.runner.assembleWork(task.id, config);
      context = { sessionId: task.id, taskId: task.id, kind: 'studio', profileId, sources: compiled.sources };
      ({ body, sources } = this.requests.assembleWorkBody(context, new ModelClient(config).buildBody(compiled.context.messages, compiled.tools), input.overrides));
    } else {
      context = { sessionId: `studio-${randomUUID()}`, kind: 'studio', profileId: input.profileId ?? 'default' }; body = input.body; sources = [];
    }
    return this.requests.prepare(context, input.body ?? body, sources);
  }
  private replay(id: string, input: Record<string, any>, send: boolean): RequestRecord {
    const original = this.store.getRequest(id), body = input.body ?? original.body;
    if (!body) throw new Error('This record has no saved Body. Construct a new request.');
    const next = this.requests.prepare({ sessionId: original.sessionId, taskId: original.taskId, kind: 'studio', parentId: original.id, profileId: original.profileId }, body);
    if (input.saveToSession) {
      const session = this.store.getSession(original.sessionId);
      const { messages, tools: _tools, tool_choice: _choice, model: _model, ...parameters } = body;
      const systemPrompt = messages.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n\n');
      const developerPrompt = messages.filter((m: any) => m.role === 'developer').map((m: any) => m.content).join('\n\n');
      if (body.model !== this.profiles.get(session.profileId).provider.model) throw new Error('Save a matching model profile before saving this model to the session.');
      this.store.updateSession(session.id, { systemPrompt, developerPrompt, parameters });
    }
    if (send) {
      const controller = new AbortController();
      const completion = this.requests.send(next.id, body, controller.signal).then(() => {}, () => {}).finally(() => this.studio.delete(next.id));
      this.studio.set(next.id, { controller, completion });
    }
    return this.store.getRequest(next.id);
  }
  private inspectTools(query: TraceQuery) {
    const request = query.requestId ? this.store.getRequest(query.requestId) : undefined;
    const taskId = request?.taskId ?? query.taskId;
    this.workTrace.sync(taskId);
    const session = !taskId && (query.sessionId ?? request?.sessionId)?.startsWith('chat-') ? this.store.getSession((query.sessionId ?? request?.sessionId)!) : undefined;
    const ceiling = taskId ? this.services.kernel.getCapabilityCeiling(taskId) : [];
    const integrationNames = new Set(INTEGRATION_TOOL_DEFINITIONS.map(tool => tool.function.name));
    const enabledIntegrations = new Set(this.services.integrations?.tools.definitions().map(tool => tool.function.name) ?? []);
    const permitted = (name: string) => {
      if (name === 'mcp_read') return session?.capabilities.mcp === true;
      if (session && name === 'list_mcp_tools') return session.capabilities.mcp;
      if (session && name === 'mcp_call') return false;
      if (integrationNames.has(name)) return enabledIntegrations.has(name) && (session ? session.capabilities.tools : Boolean(taskId && ceiling.includes('process.exec')));
      if (MEMORY_TOOL_NAMES.has(name)) return Boolean(session || taskId);
      if (SKILL_TOOL_NAMES.has(name)) return session ? session.capabilities.skills : Boolean(taskId && ceiling.includes('workspace.read'));
      if (session) return name.startsWith('web_') ? session.capabilities.web : name === 'mcp_call' ? session.capabilities.mcp : ['read_file', 'list_files', 'write_file', 'run_command', 'run_shell'].includes(name) && session.capabilities.tools;
      const capability = name.startsWith('web_') ? 'network.read' : name === 'mcp_call' ? 'mcp.call' : name === 'write_file' ? 'workspace.write' : ['run_shell', 'run_command'].includes(name) ? 'process.exec' : 'workspace.read';
      return Boolean(taskId && ceiling.includes(capability));
    };
    const registered = [...registeredTools, ...this.services.external.listMcp().flatMap((server: any) => (server.tools ?? []).map((tool: any) => ({ ...tool, source: 'MCP', serverId: server.id })))];
    const calls = this.store.toolCalls(query).map(record => {
      if (record.taskId && record.intentId) {
        const intent = this.services.kernel.getIntent(record.intentId);
        if (intent?.state === 'prepared' && this.services.task(record.taskId).status === 'waiting_approval') return { ...record, status: 'awaiting_approval' };
      }
      return record;
    });
    return { registered, allowed: registeredTools.filter(tool => permitted(tool.function.name)), exposed: request?.body?.tools ?? request?.exposedToolNames ?? [], calls };
  }
  async route(method: string, url: URL, input: Record<string, any>): Promise<unknown> {
    const route = url.pathname.slice('/v1/harness'.length), parts = route.split('/').filter(Boolean).map(decodeURIComponent), id = parts[1];
    const query = queryOf(url);
    if (route === '/sessions') return method === 'GET' ? { sessions: this.store.listSessions() } : this.store.createSession(this.sessionInput(input));
    if (parts[0] === 'sessions' && id) {
      if (parts[2] === 'branch' && method === 'POST') return this.chat.branch(id, input as any);
      if (parts[2] === 'promote' && method === 'POST') return this.chat.promote(id, input);
      if (parts.length === 2) return method === 'GET' ? this.chat.sessionView(id, url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined, query.limit ?? 200) : this.store.updateSession(id, this.sessionInput(input, this.store.getSession(id)));
    }
    if (route === '/chat' && method === 'POST') return this.chat.send(input as any);
    if (route === '/preview' && method === 'POST') return this.preview(input);
    if (route === '/requests' && method === 'GET') return this.store.listRequests(query);
    if (route === '/metrics' && method === 'GET') {
      this.workTrace.sync(query.taskId);
      const metrics = this.store.metrics(query);
      if (query.taskId) {
        const task = this.services.task(query.taskId);
        const schedule = this.services.kernel.getSchedule(task.id);
        metrics.rounds = this.services.kernel.userTurnCount(task.id);
        metrics.task = { status: task.status, reason: task.waitingReason ?? task.error, children: this.services.kernel.activeChildCount(task.id) };
        if (schedule.due) metrics.task.retryAt = new Date(schedule.due).toISOString();
        if (task.status === 'waiting_approval') metrics.activeTools = metrics.activeTools.map(tool => tool.status === 'prepared' ? { ...tool, status: 'awaiting_approval' } : tool);
      }
      return metrics;
    }
    if (parts[0] === 'requests' && id) {
      if (parts.length === 2 && method === 'GET') return this.store.getRequest(id);
      if (method === 'POST') {
        if (parts[2] === 'send' || parts[2] === 'branch') return this.replay(id, input, parts[2] === 'send');
        if (parts[2] === 'cancel') { const running = this.studio.get(id); running?.controller.abort(); return { cancelled: this.chat.cancel(id) || Boolean(running) }; }
      }
    }
    if (route === '/tools' && method === 'GET') return this.inspectTools(query);
    if (parts[0] === 'tools' && parts[2] === 'approve' && method === 'POST') {
      const tool = this.store.getTool(id!);
      if (this.store.getRequest(tool.requestId).kind === 'chat') return this.tools.approve(id!, input);
      if (!tool.taskId || !tool.intentId) throw new Error('This call has no approvable intent.');
      const task = this.services.task(tool.taskId), intent = this.services.kernel.getIntent(tool.intentId)!;
      if (input.digest !== intent.digest || intent.state !== 'prepared') throw new Error('Tool approval is stale; refresh the Inspector.');
      const scope = input.scope === undefined ? undefined : input.scope === 'session' ? 'session' : input.scope === 'once' ? 'once' : undefined;
      if (input.scope !== undefined && !scope) throw new Error("Approval scope must be 'once' or 'session'.");
      return this.services.command({ commandId: randomUUID(), type: input.approved === true ? 'grant' : 'deny', taskId: task.id, expectedRevision: task.revision, parameters: { intentId: intent.id, digest: intent.digest, generation: intent.generation, policyEpoch: intent.policyEpoch, expectedIntentDigest: input.digest, expectedConflictFingerprint: input.expectedConflictFingerprint, ...(scope ? { scope } : {}) } });
    }
    if (route === '/trace' && method === 'GET') { this.workTrace.sync(query.taskId); return this.store.traces(query); }
    if (route === '/profiles') return method === 'GET' ? { profiles: this.profiles.list() } : this.profiles.save(input);
    if (route === '/prompts') return promptSettings(this.store, method === 'GET' ? Object.fromEntries(url.searchParams) : this.sanitize(input), method === 'POST');
    if (route === '/presets') {
      if (method === 'GET') return { presets: this.store.presets(url.searchParams.get('kind') ?? undefined, url.searchParams.get('history') === 'true') };
      if (!['prompt', 'request', 'model'].includes(input.kind) || !['global', 'project', 'session'].includes(input.scope) || typeof input.name !== 'string' || !input.value || typeof input.value !== 'object') throw new Error('Invalid preset name, kind, scope or value.');
      return this.store.savePreset(this.sanitize(input) as any);
    }
    if (route === '/settings') {
      if (method === 'POST') {
        if (input.recordContent !== undefined) {
          if (typeof input.recordContent !== 'boolean') throw new Error('recordContent must be boolean.');
          this.store.setSetting('recordContent', input.recordContent);
        }
        if (input.autoReview !== undefined) {
          const autoReview = input.autoReview;
          if (!autoReview || typeof autoReview !== 'object' || Array.isArray(autoReview)) throw new Error('autoReview must be an object.');
          const { reviewerModelId, escalateAt, explain } = autoReview as Record<string, unknown>;
          if (typeof reviewerModelId !== 'string' || reviewerModelId.length > 200) throw new Error('autoReview.reviewerModelId must be a string; use an empty string to disable automatic review.');
          if (!isRiskLevel(escalateAt)) throw new Error('autoReview.escalateAt must be a risk level.');
          if (explain !== undefined && typeof explain !== 'boolean') throw new Error('autoReview.explain must be boolean.');
          // Legacy Harness route: an omitted explain keeps the current preference instead of erasing it.
          this.store.setSetting('autoReview', { reviewerModelId: reviewerModelId.trim(), escalateAt,
            explain: explain === undefined ? this.autoReviewSettings().explain : explain });
        }
      }
      return { recordContent: this.requests.recordContent(), autoReview: { ...this.autoReviewSettings(), profileId: this.autoReview()?.profileId ?? null } };
    }
    if (route === '/history/clear' && method === 'POST') { this.workTrace.sync(); return this.store.clearHistory(input.sessionId); }
    if (route === '/export' && method === 'GET') return query.requestId ? this.store.getRequest(query.requestId) : { session: this.store.getSession(query.sessionId!), messages: this.store.allMessages(query.sessionId!) };
    throw new Error('Unknown Harness route.');
  }
  async stop(): Promise<void> {
    for (const item of this.studio.values()) item.controller.abort();
    await this.tools.stop(); await this.chat.stop(); await Promise.all([...this.studio.values()].map(item => item.completion));
  }
  close(): void { this.workTrace.close(); this.store.close(); }
}
