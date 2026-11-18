import type { Event as KernelEvent, Message as KernelMessage } from '../contracts.js';
import type { ChatMessage, GatewayEvent, SessionDetail } from '../frontend/api/types.js';
import type { ChatMessage as HarnessChatMessage, ChatStreamState, RequestRecord } from '../harness/types.js';
import type { Services } from '../app/services.js';
import type { ApprovalDecision, ProductRuntime } from './shared.js';
import { ProductError, boundedInteger, invalid, optionalString, pickFields, requiredString } from './shared.js';
import { ProductStore } from './store.js';
import { ProductSessions, messageView } from './sessions.js';
import { ProductChat } from './chat.js';
import { ProductModels } from './models.js';
import { ProductWorkspace } from './workspace.js';
import { ProductTasks } from './tasks.js';
import { ProductApprovals } from './approvals.js';
import { ProductObservability } from './observability.js';
import { ProductInspector, type InspectorDomain } from './inspector.js';
import { ProductEventSnapshot } from './event-snapshot.js';
import { ProductSettings } from './settings.js';
import { ProductLibrary } from './library.js';
import { ProductCoordination } from './coordination.js';
import { fetchWebPage, searchWeb } from './web.js';
import { resourceBudget } from '../app/resource-budget.js';

const PREFIX = '/v1/product';
const WORK_STREAM_END = new Set(['completed', 'failed', 'cancelled', 'paused']);
const WORK_INTERRUPTED = { code: 'work_interrupted', message: '任务结束前没有收到完整回复。' } as const;

/** One live Work answer inside the product event log; the Kernel message remains the durable authority. */
interface WorkProjection { id: string; createdAt: string; text: string; reasoning: string; requestId?: string }

/**
 * The product HTTP layer: one small facade over the native Chat/Kernel execution authorities.
 * It owns the display index, bounded event log, HTTP input validation and route-to-frontend mapping;
 * it never executes tools, models or tasks on its own.
 */
export class ProductApi {
  readonly store: ProductStore;
  readonly runtime: ProductRuntime;
  readonly sessions: ProductSessions;
  readonly chat: ProductChat;
  readonly models: ProductModels;
  readonly workspace: ProductWorkspace;
  readonly tasks: ProductTasks;
  readonly approvals: ProductApprovals;
  readonly observability: ProductObservability;
  readonly inspector: InspectorDomain;
  readonly snapshot: ProductEventSnapshot;
  readonly settings: ProductSettings;
  readonly library: ProductLibrary;
  readonly coordination: ProductCoordination;
  private closed = false;
  /** Assistant ids whose terminal projection was already emitted; the durable duplicate is suppressed. */
  private readonly streamedMessages = new Set<string>();
  /** Chat conversations inside the removal pipeline: their projections are dropped, never written back. */
  private readonly removingSessions = new Set<string>();
  private readonly workStreams = new Map<string, WorkProjection>();
  /** One already-bounded, sanitized projection per active Chat request; terminal items are removed. */
  private readonly chatStreams = new Map<string, ChatMessage>();
  /** Stream ids already terminated: a late delta/start must not resurrect a finished or deleted bubble. */
  private readonly closedWorkStreams = new Set<string>();
  private readonly closedWorkOrder: string[] = [];
  private workStreamSeq = 0;
  private readonly stopKernelObserver: () => void;
  private readonly stopResourceObserver: () => void;

  constructor(private readonly services: Services) {
    const harness = services.harness;
    if (!harness) throw new Error('The product API requires an initialized harness.');
    this.store = new ProductStore(services.dataDir);
    const append = (event: GatewayEvent, sessionId?: string): void => this.append(event, sessionId);
    this.runtime = { services, harness, store: this.store, append, resolveProject: id => services.projectPath(id),
      markRemoving: (sessionId, removing) => {
        if (removing) { this.removingSessions.add(sessionId); this.chatStreams.delete(sessionId); this.workStreams.delete(sessionId); }
        else this.removingSessions.delete(sessionId);
      } };
    this.sessions = new ProductSessions(this.runtime);
    this.chat = new ProductChat(this.runtime, this.sessions);
    this.models = new ProductModels(this.runtime);
    this.workspace = new ProductWorkspace(this.runtime);
    this.tasks = new ProductTasks(this.runtime, this.sessions);
    this.approvals = new ProductApprovals(this.runtime);
    this.observability = new ProductObservability(this.runtime);
    this.inspector = ProductInspector(this.runtime);
    this.snapshot = new ProductEventSnapshot(this.runtime, this.sessions, this.approvals, this.tasks, this.observability);
    this.settings = new ProductSettings(this.runtime, () => this.workspace.projects());
    this.library = new ProductLibrary(this.runtime);
    this.coordination = new ProductCoordination(this.runtime, this.sessions);
    harness.workTrace.setObserver(event => this.kernelEvent(event));
    services.runner.selection = taskId => {
      const selection = this.sessions.selectionFor(taskId);
      return selection ? { ...(selection.profileId ? { profileId: selection.profileId } : {}), ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) } : undefined;
    };
    this.bootstrap();
    harness.workTrace.sync();
    // The commit microtask only schedules a bounded macrotask. Historical catch-up cannot block send replies.
    this.stopKernelObserver = services.kernel.onCommitted(() => harness.workTrace.sync());
    this.stopResourceObserver = resourceBudget.onPressureChanged(() => this.publishConnectionChanged());
  }

  /** One-time projection of existing native sessions into the display index (never per poll). */
  private bootstrap(): void {
    let chatCursor = 0;
    for (;;) {
      const page = this.services.harness!.store.sessionPage(chatCursor, 100);
      for (const session of page.items) {
        if (this.store.isSessionDismissed(session.id) || this.store.getSession(session.id)) continue;
        this.sessions.indexChatSession(session);
      }
      if (page.nextCursor === null) break;
      chatCursor = page.nextCursor;
    }
    let taskCursor = 0;
    for (;;) {
      const page = this.services.kernel.taskPage(taskCursor, 100, true);
      for (const task of page.items) {
        if (this.store.isSessionDismissed(task.id) || this.store.getSession(task.id)) continue;
        // A recovered branch keeps its durable source relation instead of appearing as a rootless duplicate.
        const origin = this.services.harness?.workOriginLink(task.id);
        const source = origin ? this.store.getSession(origin.sourceTaskId) : undefined;
        this.sessions.indexWorkTask(task, origin ? {
          parentSessionId: origin.sourceTaskId,
          ...(source?.mode ? { mode: source.mode } : {}),
          ...(source?.modelId ? { modelId: source.modelId } : {}),
        } : undefined);
      }
      if (page.nextCursor === null) break;
      taskCursor = page.nextCursor;
    }
  }

  async route(method: string, url: URL, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname;
    const route = path.replace(/\/+$/, '') || '/';
    if (route.startsWith('/approvals') || route.startsWith('/events') || route.startsWith('/tasks')) {
      const scope = url.searchParams.get('sessionId') ?? route.match(/^\/tasks\/([^/]+)/)?.[1];
      this.services.harness!.workTrace.sync(scope && this.services.kernel.getTask(scope) ? scope : undefined);
    }
    const query = (name: string): string | undefined => url.searchParams.get(name) ?? undefined;
    const segment = (value: string): string => { try { return decodeURIComponent(value); } catch { return value; } };
    const body = input ?? {};
    if (route.startsWith('/library/')) return this.library.route(method, route.slice('/library'.length), Object.fromEntries(url.searchParams), body);
    if (route.startsWith('/coordination/')) return this.coordination.route(method, route.slice('/coordination'.length), Object.fromEntries(url.searchParams), body);
    if (method === 'GET' && route === '/snapshot') {
      const rawLimit = query('limit');
      const limit = rawLimit === undefined ? 100 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit must be an integer between 1 and 100.');
      const rawSession = query('sessionId');
      const sessionId = rawSession === undefined ? undefined : requiredString(rawSession, 'sessionId', 200);
      this.services.harness!.workTrace.sync(sessionId && this.services.kernel.getTask(sessionId) ? sessionId : undefined);
      const snapshot = await this.snapshot.capture({ limit, ...(sessionId ? { sessionId } : {}) });
      if (snapshot.session) snapshot.session = this.withLiveMessage(snapshot.session);
      return snapshot;
    }
    if (method === 'GET' && route === '/sessions') {
      return this.sessions.list({ mode: query('mode') as never, text: query('text'), projectId: query('projectId'),
        cursor: query('cursor'), limit: query('limit') === undefined ? undefined : Number(query('limit')) });
    }
    let match: RegExpExecArray | null;
    if (method === 'GET' && (match = /^\/sessions\/([^/]+)$/.exec(route))) {
      const before = query('before');
      if (before === undefined) { const id = segment(match[1]!); this.services.harness!.workTrace.sync(this.services.kernel.getTask(id) ? id : undefined); }
      const session = await this.sessions.get(segment(match[1]!), before);
      return before === undefined ? this.withLiveMessage(session) : session;
    }
    if (method === 'POST' && (match = /^\/sessions\/([^/]+)\/update$/.exec(route))) return this.sessions.update(segment(match[1]!), body as never);
    if (method === 'POST' && (match = /^\/sessions\/([^/]+)\/remove$/.exec(route))) {
      await this.sessions.remove(segment(match[1]!));
      return { removed: true };
    }
    if (method === 'POST' && (match = /^\/sessions\/([^/]+)\/branch$/.exec(route))) {
      const value = pickFields(body, ['messageId'], 'Branch input');
      const messageId = requiredString(value.messageId, 'messageId', 200);
      const created = await this.sessions.branch(segment(match[1]!), messageId);
      return created;
    }
    if (method === 'POST' && (match = /^\/sessions\/([^/]+)\/promote$/.exec(route))) return this.sessions.promote(segment(match[1]!), body as never);
    if (method === 'POST' && route === '/chat/send') return this.chat.send(body as never);
    if (method === 'POST' && route === '/chat/cancel') {
      const value = pickFields(body, ['sessionId'], 'Cancel input');
      await this.chat.cancel(requiredString(value.sessionId, 'sessionId', 200));
      return { cancelled: true };
    }
    if (method === 'POST' && route === '/chat/edit') {
      const value = pickFields(body, ['sessionId', 'messageId', 'text'], 'Edit input');
      await this.chat.edit(requiredString(value.sessionId, 'sessionId', 200), requiredString(value.messageId, 'messageId', 200), requiredString(value.text, 'text', 100000));
      return { edited: true };
    }
    if (method === 'POST' && route === '/chat/regenerate') {
      const value = pickFields(body, ['sessionId', 'messageId'], 'Regenerate input');
      await this.chat.regenerate(requiredString(value.sessionId, 'sessionId', 200), requiredString(value.messageId, 'messageId', 200));
      return { regenerated: true };
    }
    if (method === 'POST' && route === '/chat/side-ask') return this.chat.sideAsk(body as never);
    if (method === 'GET' && route === '/chat/side-history') return this.chat.side.history(url.searchParams.get('sessionId') || undefined, url.searchParams.get('sideSessionId') || undefined, url.searchParams.get('before') || undefined);
    if (method === 'POST' && (route === '/chat/side-cancel' || route === '/chat/side-clear')) {
      const value = pickFields(body, ['sessionId', 'sideSessionId'], 'Side control');
      const parent = optionalString(value.sessionId, 'sessionId', 200);
      const side = requiredString(value.sideSessionId, 'sideSessionId', 200);
      if (route === '/chat/side-cancel') await this.chat.side.cancel(parent, side); else await this.chat.side.clear(parent, side);
      return { ok: true };
    }
    // Manual browsing is not an Agent effect: these routes call the shared operator transport
    // directly and deliberately never create a task, run, intent, approval or model request.
    if (method === 'POST' && route === '/web/search') return searchWeb(this.runtime, body, signal);
    if (method === 'POST' && route === '/web/fetch') return fetchWebPage(this.runtime, body, signal);
    if (method === 'GET' && route === '/approvals') return this.approvals.pending(query('sessionId'));
    if (method === 'POST' && route === '/approvals/decide') return this.decide(body);
    if (method === 'GET' && (match = /^\/tasks\/([^/]+)$/.exec(route))) return this.tasks.get(segment(match[1]!)) ?? null;
    if (method === 'POST' && (match = /^\/tasks\/([^/]+)\/control$/.exec(route))) {
      const value = pickFields(body, ['action', 'expectedRevision', 'plan'], 'Task control');
      const action = requiredString(value.action, 'action', 32) as never;
      return this.tasks.control(segment(match[1]!), action, { expectedRevision: value.expectedRevision as number | undefined, plan: value.plan as never });
    }
    if (method === 'GET' && route === '/models') return this.models.list();
    if (method === 'POST' && route === '/models/save') return this.models.save(body as never);
    if (method === 'POST' && (match = /^\/models\/([^/]+)\/remove$/.exec(route))) {
      await this.models.remove(segment(match[1]!));
      return { removed: true };
    }
    if (method === 'POST' && (match = /^\/models\/([^/]+)\/test$/.exec(route))) return this.models.test(segment(match[1]!));
    if (method === 'GET' && route === '/settings') return this.settings.get();
    if (method === 'POST' && route === '/settings/update') return this.settings.update(body);
    if (method === 'GET' && route === '/settings/mcp') return this.settings.mcpServers();
    if (method === 'POST' && route === '/settings/mcp/save') return this.settings.saveMcp(body as never);
    if (method === 'GET' && (match = /^\/settings\/mcp\/([^/]+)\/catalog$/.exec(route))) return this.settings.mcp.catalog(segment(match[1]!), boundedInteger(Number(url.searchParams.get('offset') ?? 0), 'offset', 0, 1000));
    if (method === 'POST' && (match = /^\/settings\/mcp\/([^/]+)\/remove$/.exec(route))) {
      await this.settings.removeMcp(segment(match[1]!));
      return { removed: true };
    }
    if (method === 'POST' && (match = /^\/settings\/mcp\/([^/]+)\/reconnect$/.exec(route))) return this.settings.reconnectMcp(segment(match[1]!));
    if (method === 'GET' && route === '/settings/instructions') return this.settings.instructions();
    if (method === 'GET' && route === '/settings/plugins') return this.settings.plugins();
    if (method === 'GET' && route === '/settings/skills') return this.settings.skills();
    if (method === 'POST' && (match = /^\/settings\/skills\/([^/]+)\/toggle$/.exec(route))) {
      const value = pickFields(body, ['enabled'], 'Skill toggle');
      if (typeof value.enabled !== 'boolean') invalid('enabled must be a boolean.');
      return this.settings.toggleSkill(segment(match[1]!), value.enabled);
    }
    if (method === 'POST' && route === '/settings/clear-history') {
      pickFields(body, [], 'Clear history input');
      await this.settings.clearHistory();
      return { cleared: true };
    }
    if (method === 'GET' && (route === '/workspace/projects' || route === '/projects')) return this.workspace.projects();
    if (method === 'POST' && route === '/workspace/projects') {
      const value = pickFields(body, ['path'], 'Project input');
      return this.workspace.addProject(requiredString(value.path, 'path', 4096));
    }
    if (method === 'POST' && (match = /^\/workspace\/projects\/([^/]+)\/remove$/.exec(route))) {
      const projectId = segment(match[1]!);
      await this.workspace.removeProject(projectId);
      this.sessions.unlinkProject(projectId);
      return { removed: true };
    }
    if (method === 'GET' && route === '/workspace/files') return this.workspace.files(requiredString(query('projectId'), 'projectId', 200));
    if (method === 'GET' && route === '/workspace/file') {
      return this.workspace.readFile(requiredString(query('projectId'), 'projectId', 200), requiredString(query('path'), 'path', 4096));
    }
    if (method === 'POST' && route === '/workspace/file') {
      const value = pickFields(body, ['projectId', 'path', 'content'], 'Write file input');
      if (typeof value.content !== 'string' || value.content.length > 2 * 1024 * 1024) invalid('content must be a string of at most 2097152 characters.');
      return this.workspace.writeFile(requiredString(value.projectId, 'projectId', 200), requiredString(value.path, 'path', 4096), value.content);
    }
    if (method === 'GET' && route === '/workspace/search') {
      const projectId = requiredString(query('projectId'), 'projectId', 200);
      const text = requiredString(query('text') ?? query('q'), 'text', 500);
      return this.workspace.search(projectId, { text, ...(query('regex') === 'true' ? { regex: true } : {}), ...(query('caseSensitive') === 'true' ? { caseSensitive: true } : {}) });
    }
    if (method === 'GET' && route === '/workspace/source-control') return this.workspace.sourceControl(requiredString(query('projectId'), 'projectId', 200));
    if (method === 'GET' && route === '/workspace/diff') {
      return this.workspace.fileDiff(requiredString(query('projectId'), 'projectId', 200), requiredString(query('path'), 'path', 4096));
    }
    if (method === 'POST' && route === '/workspace/commit') {
      const value = pickFields(body, ['projectId', 'message', 'paths'], 'Commit input');
      const projectId = requiredString(value.projectId, 'projectId', 200);
      const message = requiredString(value.message, 'message', 500);
      if (!Array.isArray(value.paths) || !value.paths.length || value.paths.length > 200) invalid('paths must contain 1-200 paths.');
      const paths = value.paths.map((item, index) => requiredString(item, 'paths[' + index + ']', 4096));
      return this.workspace.commit(projectId, message, paths);
    }
    if (method === 'POST' && route === '/workspace/terminal') {
      const value = pickFields(body, ['projectId', 'command'], 'Terminal input');
      return this.workspace.terminal(requiredString(value.projectId, 'projectId', 200), requiredString(value.command, 'command', 4000));
    }
    if (method === 'GET' && route === '/workspace/diagnostics') return this.workspace.diagnostics(requiredString(query('projectId'), 'projectId', 200));
    if (route === '/inspector' || route.startsWith('/inspector/')) return this.inspectorRoute(method, route, query, body);
    if (method === 'GET' && route === '/connection') return this.observability.connection();
    if (method === 'GET' && route === '/metrics/session') return this.observability.metrics(requiredString(query('sessionId'), 'sessionId', 200));
    if (method === 'GET' && route === '/metrics/activity') {
      const days = query('days');
      return this.observability.activity(days === undefined ? undefined : Number(days));
    }
    if (method === 'GET' && route === '/events') {
      const rawCursor = query('cursor') ?? '0';
      if (!/^\d+$/.test(rawCursor)) invalid('cursor must be a non-negative integer.');
      const cursor = Number(rawCursor);
      if (!Number.isSafeInteger(cursor)) invalid('cursor must be a safe non-negative integer.');
      const limit = query('limit') === undefined ? 100 : Number(query('limit'));
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('limit must be an integer between 1 and 200.');
      // Same shared domain as GET /snapshot: an absent sessionId keeps the global subscription, while a
      // provided one must be a non-blank 1-200 character id. An empty value must not silently fall back
      // to the global log (ProductStore treats a falsy sessionId as "all sessions").
      const rawSession = query('sessionId');
      const sessionId = rawSession === undefined ? undefined : requiredString(rawSession, 'sessionId', 200);
      const waitMs = query('waitMs') === undefined ? 0 : Number(query('waitMs'));
      if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25000) invalid('waitMs must be an integer between 0 and 25000.');
      return waitMs ? this.store.waitEvents(cursor, limit, sessionId, waitMs, signal) : this.store.eventsAfter(cursor, limit, sessionId);
    }
    throw new ProductError('not_found', 'Unknown product route: ' + route, 404);
  }

  publishConnectionChanged(): void { this.append({ type: 'connection.changed', connection: this.observability.connection() }); }

  /** Latest views may include the current request; historical pages remain durable records only. */
  private withLiveMessage(session: SessionDetail): SessionDetail {
    let live = this.chatStreams.get(session.id);
    if (live && this.services.harness!.chat.activeRequestId(session.id) !== live.requestId) {
      this.chatStreams.delete(session.id); live = undefined;
    }
    const work = this.workStreams.get(session.id);
    if (work && session.status !== 'running') this.workStreams.delete(session.id);
    else if (work && (work.text || work.reasoning)) live = messageView({
      id: work.id, role: 'assistant', content: work.text, createdAt: work.createdAt,
      ...(work.reasoning ? { reasoningContent: work.reasoning } : {}),
      ...(work.requestId ? { requestId: work.requestId } : {}),
    }, { status: 'streaming' });
    // A durable row always wins when settlement raced this view; never duplicate its reserved id.
    if (!live || session.messages.some(message => message.id === live.id)) return session;
    return { ...session, messages: [...session.messages, live] };
  }

  /** Tool batches outlive the model stream and must keep the existing stop control available. */
  chatToolsChanged(sessionId: string): void {
    if (this.closed || this.removingSessions.has(sessionId)) return;
    this.refreshChat(sessionId);
    this.append({ type: 'inspector.invalidated', sessionId }, sessionId);
  }

  /** Chat messages persisted by ChatService: emit complete accumulated messages for the front end. */
  chatMessage(sessionId: string, message: HarnessChatMessage): void {
    try {
      // The live projection already reported this message under the same id; never append it twice.
      if (!this.streamedMessages.delete(message.id))
        this.append({ type: 'message.upsert', sessionId, message: messageView(message) }, sessionId);
      this.refreshChat(sessionId);
      if (message.role === 'assistant') {
        this.observability.publishMetrics(sessionId);
        this.append({ type: 'inspector.invalidated', sessionId }, sessionId);
      }
    } catch { /* A removed session must not fail the ChatService callback. */ }
  }

  /**
   * Live Chat projection driven by ChatService. One stable message id covers every partial and the
   * terminal state; the projection is never persisted, so session history gains exactly one assistant
   * message at settlement. A removed session or a stale request is dropped instead of written back.
   */
  chatStream(update: ChatStreamState): void {
    if (update.status !== 'streaming' && this.chatStreams.get(update.sessionId)?.requestId === update.requestId)
      this.chatStreams.delete(update.sessionId);
    try {
      // A conversation being removed must not gain even a terminal projection: removal settles the
      // request first, so the cancellation event would otherwise land after the delete decision.
      if (this.closed || this.removingSessions.has(update.sessionId)) return;
      this.services.harness!.store.getSession(update.sessionId);
      const createdAt = this.streamCreatedAt(update.requestId);
      if (update.status === 'streaming') {
        if (this.services.harness!.chat.activeRequestId(update.sessionId) !== update.requestId) return;
        // A reasoning-only turn is real live output: it must not be dropped for having no answer text.
        if (!update.content && !update.reasoningContent) return;
        const message = messageView({
          id: update.messageId, role: 'assistant', content: update.content, createdAt, requestId: update.requestId,
          ...(update.reasoningContent ? { reasoningContent: update.reasoningContent } : {}),
        }, { status: 'streaming' });
        this.chatStreams.set(update.sessionId, message);
        this.append({ type: 'message.upsert', sessionId: update.sessionId, message }, update.sessionId);
        return;
      }
      if (update.status === 'done') this.rememberStreamed(update.messageId);
      const error = update.status === 'error' ? update.error : undefined;
      this.append({ type: 'message.upsert', sessionId: update.sessionId, message: messageView({
        id: update.messageId, role: 'assistant', content: update.content, createdAt, requestId: update.requestId,
        ...(update.reasoningContent ? { reasoningContent: update.reasoningContent } : {}),
        ...(update.toolCalls?.length ? { toolCalls: update.toolCalls } : {}),
      }, { status: update.status, ...(error ? { error } : {}) }) }, update.sessionId);
      // Failed/cancelled turns have no durable onMessage callback to refresh the session index.
      // Let ChatService finish its synchronous cleanup first, then publish the actual live state.
      if (update.status !== 'done') queueMicrotask(() => {
        try {
          if (!this.closed && !this.removingSessions.has(update.sessionId)) this.refreshChat(update.sessionId);
        } catch { /* Keep deferred display refresh best-effort, like the synchronous projection. */ }
      });
    } catch { /* A removed session must not accept late deltas. */ }
  }

  private streamCreatedAt(requestId: string): string {
    try { return this.services.harness!.store.getRequest(requestId).createdAt; } catch { return new Date().toISOString(); }
  }

  private rememberStreamed(messageId: string): void {
    this.streamedMessages.add(messageId);
    if (this.streamedMessages.size <= 1024) return;
    const oldest = this.streamedMessages.values().next().value;
    if (oldest) this.streamedMessages.delete(oldest);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopKernelObserver();
    this.stopResourceObserver();
    this.chatStreams.clear(); this.workStreams.clear();
    await this.chat.side.close();
    await this.workspace.stopAllTerminals();
    this.store.close();
  }

  private decide(body: Record<string, unknown>): { resolved: boolean } {
    const value = pickFields(body, ['approvalId', 'approved', 'scope', 'note', 'expectedIntentDigest', 'expectedConflictFingerprint'], 'Approval decision');
    const approvalId = requiredString(value.approvalId, 'approvalId', 200);
    if (typeof value.approved !== 'boolean') invalid('approved must be a boolean.');
    const scope = value.scope === 'once' || value.scope === 'session' ? value.scope : invalid('scope must be once or session.');
    const note = optionalString(value.note, 'note', 500);
    const decision: ApprovalDecision = { approved: value.approved, scope, ...(note ? { note } : {}), expectedIntentDigest: optionalString(value.expectedIntentDigest, 'expectedIntentDigest', 128), expectedConflictFingerprint: optionalString(value.expectedConflictFingerprint, 'expectedConflictFingerprint', 128) };
    this.approvals.decide(approvalId, decision);
    return { resolved: true };
  }

  /** Inspector routes: strict method/path/body validation; the domain maps native facts and never fakes them. */
  private async inspectorRoute(method: string, route: string, query: (name: string) => string | undefined, body: Record<string, unknown>): Promise<unknown> {
    const sessionId = (): string => requiredString(query('sessionId'), 'sessionId', 200);
    const only = (expected: 'GET' | 'POST'): void => {
      if (method !== expected) throw new ProductError('validation', expected + ' is required for ' + route + '.', 405);
    };
    if (route === '/inspector/prompt') {
      if (method === 'POST') {
        const value = pickFields(body, ['sessionId', 'partId', 'content', 'scope'], 'Inspector prompt input');
        if (typeof value.content !== 'string' || value.content.length > 64_000) invalid('content must be a string of at most 64000 characters.');
        const scope = value.scope;
        if (scope !== 'global' && scope !== 'project' && scope !== 'session' && scope !== 'request') invalid('scope must be global, project, session or request.');
        return this.inspector.savePrompt(requiredString(value.sessionId, 'sessionId', 200), requiredString(value.partId, 'partId', 200), value.content, scope);
      }
      only('GET');
      return this.inspector.prompt(sessionId(), optionalString(query('requestId'), 'requestId', 200));
    }
    if (route === '/inspector/requests') { only('GET'); return this.inspector.requests(sessionId()); }
    if (route === '/inspector/replay') {
      only('POST');
      const value = pickFields(body, ['requestId', 'body', 'mode'], 'Inspector replay input');
      const mode = value.mode;
      if (mode !== 'send' && mode !== 'branch') invalid("mode must be 'send' or 'branch'.");
      const requestId = requiredString(value.requestId, 'requestId', 200);
      return this.inspector.replay(requestId, this.library.validateReplay(requestId, value.body), mode);
    }
    if (route === '/inspector/tools') { only('GET'); return this.inspector.tools(sessionId()); }
    if (route === '/inspector/tool-detail') {
      only('GET');
      const section = query('section');
      if (section !== 'schema' && section !== 'description' && section !== 'arguments' && section !== 'result' && section !== 'mcpDefinition') invalid('Invalid tool detail section.');
      return this.inspector.toolDetail(sessionId(), requiredString(query('callId'), 'callId', 500), section, query('offset') === undefined ? undefined : Number(query('offset')));
    }
    if (route === '/inspector/trace') {
      only('GET');
      return this.inspector.trace(sessionId(), { text: optionalString(query('text'), 'text', 300), type: optionalString(query('type'), 'type', 32), cursor: optionalString(query('cursor'), 'cursor', 16) });
    }
    if (route === '/inspector/context') { only('GET'); return this.inspector.context(sessionId()); }
    if (route === '/inspector/recall') {
      only('GET');
      return this.inspector.recall(sessionId(), requiredString(query('sourceId'), 'sourceId', 200), query('offset') === undefined ? undefined : Number(query('offset')));
    }
    if (route === '/inspector/diffs') { only('GET'); return this.inspector.diffs(sessionId()); }
    throw new ProductError('not_found', 'Unknown inspector route: ' + route, 404);
  }

  /** Adapter lifecycle callback, after dispatch accounting or terminal request persistence; never per delta. */
  sideRequestChanged(request: Pick<RequestRecord, 'kind' | 'sessionId' | 'taskId' | 'budgetTaskIds'>, phase: 'dispatched' | 'settled'): void {
    if (this.closed || request.kind !== 'side') return;
    // Use the same durable scope as request_metrics, including delegated ancestors.
    const ids = new Set([request.sessionId, ...(request.taskId ? [request.taskId] : []), ...request.budgetTaskIds ?? []]);
    for (const sessionId of ids) {
      if (this.removingSessions.has(sessionId) || this.store.isSessionDismissed(sessionId)) continue;
      const existing = this.store.getSession(sessionId);
      if (!existing) continue;
      try {
        // The task card also contains usage-derived tokens. Refresh only existing Work projections
        // after terminal persistence; the adapter's captured record still has its prepared status.
        if (phase === 'settled' && existing.kind === 'work') this.refreshTask(sessionId);
        this.observability.publishMetrics(sessionId);
        this.append({ type: 'inspector.invalidated', sessionId }, sessionId);
      } catch { /* A removed session or failed display projection cannot affect the request. */ }
    }
  }

  private kernelEvent(event: KernelEvent): void {
    try {
      const task = this.services.kernel.getTask(event.taskId);
      if (!task || this.services.runner.managedExternally.has(task.id)) return;
      // A dismissed conversation is hidden for good: late Kernel events must not resurrect a bubble.
      if (this.closed || this.removingSessions.has(task.id) || this.store.isSessionDismissed(task.id)) { this.workStreams.delete(task.id); return; }
      // WorkTrace has already imported this event. Mounted Inspector panels need the same
      // invalidation contract as Chat; approval/task updates alone only refresh their own stores.
      // Stream deltas do not change durable requests or tool state and must not cause reloads.
      if (event.type === 'message.appended' || event.type === 'tool.execution'
        || event.type.startsWith('intent.') || event.type.startsWith('effect.')
        || ['task.transitioned', 'task.paused', 'task.resumed', 'task.cancelled', 'diagnostic.error'].includes(event.type))
        this.append({ type: 'inspector.invalidated', sessionId: task.id }, task.id);
      switch (event.type) {
        case 'coordination.changed':
        case 'coordination.presence':
        case 'coordination.claim_changed':
          this.append({ type: 'coordination.changed', sessionId: task.id, revision: event.seq }, task.id);
          this.refreshTask(task.id);
          return;
        case 'model.stream.started': {
          const messageId = typeof event.payload.messageId === 'string' ? event.payload.messageId : '';
          // A previous round that never produced a message must not leave a bubble streaming forever.
          this.terminalWorkStream(task.id, 'error', WORK_INTERRUPTED);
          // A fast failure can be caught up after the task already settled: the started event still
          // owns this round, so create the projection and let the later diagnostic/transition close it.
          if (!messageId || this.closedWorkStreams.has(messageId)) {
            if (messageId) this.rememberClosed(messageId);
            return;
          }
          // The runner reserves the durable Kernel message id before the first token; keep it.
          this.workStreams.set(task.id, { id: messageId, createdAt: event.createdAt, text: '', reasoning: '' });
          return;
        }
        case 'model.stream.delta': {
          const text = typeof event.payload.text === 'string' ? event.payload.text : '';
          const reasoning = typeof event.payload.reasoningText === 'string' ? event.payload.reasoningText : '';
          const messageId = typeof event.payload.messageId === 'string' ? event.payload.messageId : '';
          // A reasoning-only delta is live output and must create or update the bubble on its own.
          if (!text && !reasoning) return;
          let projection = this.workStreams.get(task.id);
          if (!projection) {
            if ((messageId && this.closedWorkStreams.has(messageId)) || WORK_STREAM_END.has(task.status)) {
              if (messageId) this.rememberClosed(messageId);
              return;
            }
            projection = { id: messageId || `stream-${task.id}-${++this.workStreamSeq}`, createdAt: event.createdAt, text: '', reasoning: '' };
            this.workStreams.set(task.id, projection);
          }
          // A delta from a superseded round must never write into the current bubble.
          if (messageId && projection.id !== messageId) return;
          if (text === projection.text && reasoning === projection.reasoning) return;
          projection.text = text; projection.reasoning = reasoning;
          this.append({ type: 'message.upsert', sessionId: task.id, message: messageView({
            id: projection.id, role: 'assistant', content: text, createdAt: projection.createdAt,
            ...(reasoning ? { reasoningContent: reasoning } : {}),
            ...(projection.requestId ? { requestId: projection.requestId } : {}),
          }, { status: 'streaming' }) }, task.id);
          return;
        }
        case 'model.stream.completed': {
          const projection = this.workStreams.get(task.id);
          const messageId = typeof event.payload.messageId === 'string' ? event.payload.messageId : '';
          if (projection && (!messageId || projection.id === messageId) && typeof event.payload.requestId === 'string')
            projection.requestId = event.payload.requestId;
          return;
        }
        case 'message.appended': {
          const message = this.services.kernel.getMessage(String(event.payload.messageId ?? ''));
          if (!message) return;
          const projection = this.workStreams.get(task.id);
          // The one durable Kernel row reserved by the runner ends the live bubble with the same id.
          if (projection && message.role === 'assistant' && projection.id === message.id) {
            this.finishWorkStream(task.id, message, projection);
            return;
          }
          // Explicit replacement contract for a mismatched durable row of the same request: end the
          // stale projection honestly, then show the canonical message instead of leaving a ghost.
          if (projection && message.role === 'assistant' && projection.requestId && message.requestId
            && projection.requestId === message.requestId) {
            this.terminalWorkStream(task.id, 'error', { code: 'work_identity_replaced', message: '流式回答已替换为最终记录。' });
          }
          this.append({ type: 'message.upsert', sessionId: task.id, message: messageView(message) }, task.id);
          this.refreshTask(task.id);
          if (message.role === 'assistant') this.observability.publishMetrics(task.id);
          return;
        }
        case 'intent.prepared': {
          const intent = this.services.kernel.getIntent(String(event.payload.intentId ?? ''));
          if (intent && intent.state === 'prepared' && intent.authorization?.decision === 'ask')
            this.append({ type: 'approval.requested', approval: this.approvals.view(intent, task) }, task.id);
          this.refreshTask(task.id);
          return;
        }
        case 'intent.approved':
        case 'intent.denied':
          this.append({ type: 'approval.resolved', approvalId: String(event.payload.intentId ?? ''), approved: event.type === 'intent.approved' }, task.id);
          this.refreshTask(task.id);
          return;
        case 'task.transitioned':
        case 'task.paused':
        case 'task.cancelled': {
          // A genuine operator pause/cancel keeps the streamed text; any other terminal transition is
          // an interrupted answer and must stay an error, never a fake cancel.
          if (task.status === 'paused' || task.status === 'cancelled') this.terminalWorkStream(task.id, 'cancelled');
          else if (WORK_STREAM_END.has(task.status)) this.terminalWorkStream(task.id, 'error', WORK_INTERRUPTED);
          this.refreshTask(task.id);
          return;
        }
        case 'diagnostic.error': {
          // The Kernel records the real provider/model diagnostic; surface it as an error terminal
          // instead of waiting for a task transition to mislabel the bubble as cancelled.
          const code = typeof event.payload.code === 'string' && event.payload.code ? event.payload.code : 'work_failed';
          const raw = typeof event.payload.message === 'string' ? event.payload.message : '';
          const message = this.services.configuration.redact(raw || 'The model request failed before it produced an answer.').slice(0, 2000);
          this.terminalWorkStream(task.id, 'error', { code, message });
          this.refreshTask(task.id);
          return;
        }
        case 'verification.saved':
        case 'budget.consumed':
        case 'checkpoint.saved':
        case 'permission.changed':
        case 'delegation.created':
        case 'delegation.settled':
          this.refreshTask(task.id);
          return;
        default:
          return;
      }
    } catch { /* The projection is best-effort; Kernel event import must never fail because of display work. */ }
  }

  /** Replace a live Work projection with the one durable assistant message; Kernel records stay authoritative. */
  private finishWorkStream(taskId: string, message: KernelMessage, projection: WorkProjection): void {
    this.workStreams.delete(taskId);
    this.rememberClosed(projection.id);
    // The durable Kernel row carries the same id/createdAt as the live projection, so the client
    // replaces the bubble in place and the completed answer resolves through Kernel/Inspector/history.
    this.append({ type: 'message.upsert', sessionId: taskId, message: messageView(message, { status: 'done' }) }, taskId);
    this.refreshTask(taskId);
    this.observability.publishMetrics(taskId);
  }

  /** End an unfinished Work projection exactly once; late deltas for that stream are ignored. */
  private terminalWorkStream(taskId: string, status: 'cancelled' | 'error', error?: { code: string; message: string }): void {
    const projection = this.workStreams.get(taskId);
    if (!projection) return;
    this.workStreams.delete(taskId);
    this.rememberClosed(projection.id);
    this.append({ type: 'message.upsert', sessionId: taskId, message: messageView({
      id: projection.id, role: 'assistant', content: projection.text, createdAt: projection.createdAt,
      ...(projection.reasoning ? { reasoningContent: projection.reasoning } : {}),
      ...(projection.requestId ? { requestId: projection.requestId } : {}),
    }, status === 'cancelled' ? { status: 'cancelled' } : { status: 'error', error: error ?? WORK_INTERRUPTED }) }, taskId);
    this.refreshTask(taskId);
  }

  private rememberClosed(messageId: string): void {
    if (!messageId || this.closedWorkStreams.has(messageId)) return;
    this.closedWorkStreams.add(messageId);
    this.closedWorkOrder.push(messageId);
    while (this.closedWorkOrder.length > 1024) this.closedWorkStreams.delete(this.closedWorkOrder.shift()!);
  }

  private refreshTask(taskId: string): void {
    const task = this.services.kernel.getTask(taskId);
    if (!task) return;
    if (this.store.isSessionDismissed(taskId)) return;
    const existing = this.store.getSession(taskId);
    const record = this.sessions.indexWorkTask(task, existing ? {} : { pinned: false });
    const row = this.sessions.refresh(record) ?? this.sessions.summary(record);
    this.append({ type: 'session.upsert', session: row }, taskId);
    this.append({ type: 'task.updated', sessionId: taskId, task: this.tasks.detail(task) }, taskId);
  }

  private refreshChat(sessionId: string): void {
    let session;
    try { session = this.services.harness!.store.getSession(sessionId); }
    catch { return; }
    const record = this.sessions.indexChatSession(session);
    const row = this.sessions.refresh(record) ?? this.sessions.summary(record);
    this.append({ type: 'session.upsert', session: row }, sessionId);
  }

  private append(event: GatewayEvent, sessionId?: string): void {
    if (this.closed) return;
    this.store.append([{ event, ...(sessionId !== undefined ? { sessionId } : {}) }]);
  }
}
