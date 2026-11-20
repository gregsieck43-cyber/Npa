import { randomUUID } from 'node:crypto';
import type { Message as KernelMessage, Task, ToolCall } from '../contracts.js';
import type { Attachment as FrontendAttachment, MessagePart, SessionStatus } from '../frontend/api/types.js';
import type { ChatMessage as HarnessChatMessage, ChatSession } from '../harness/types.js';
import {
  ProductError, boundedInteger, busy, invalid, notFound, optionalString, pickFields, requiredString,
  type AppMode, type ChatMessage, type PermissionMode, type ProductRuntime, type PromoteGoal, type SessionDetail,
  type SessionIndexRecord, type SessionListQuery, type SessionSelection, type SessionSummary, type SessionsDomain,
  type SessionUpdatePatch,
} from './shared.js';

const MODES: readonly AppMode[] = ['chat', 'cowork', 'code'];
const PERMISSIONS: readonly PermissionMode[] = ['read-only', 'ask', 'auto-review', 'full-access'];
const SESSION_STATUSES: readonly SessionStatus[] = ['idle', 'streaming', 'waiting_approval', 'waiting_input', 'running', 'paused', 'failed', 'completed'];
const TERMINAL_TASKS = new Set(['completed', 'failed', 'cancelled']);
const EFFORT = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
export type SettleableChat = ProductRuntime['harness']['chat'] & { cancelAndSettle?(sessionId: string): Promise<boolean> };

/** Kernel task state is displayed through the front-end's smaller status vocabulary. */
const sessionStatusOf = (task: Task): SessionStatus => {
  switch (task.status) {
    case 'queued': return 'idle';
    case 'running': return 'running';
    case 'waiting_approval': return 'waiting_approval';
    case 'waiting_input': return 'waiting_input';
    case 'waiting_children': return 'running';
    case 'paused': return 'paused';
    case 'reconciling': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'idle';
  }
};
const isSessionStatus = (value: string): value is SessionStatus => SESSION_STATUSES.includes(value as SessionStatus);
const preview = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 120);

/** The raw stored message shape shared by HarnessStore records and Kernel messages. */
export interface StoredMessage {
  id: string; role: string; content: string; reasoningContent?: string; createdAt: string; requestId?: string;
  attachments?: { name: string; path: string; bytes: number; sha256: string; content: string }[];
  toolCalls?: ToolCall[];
}

/**
 * Map one persisted message to the front-end view. Tool proposals become an explicit notice: their
 * execution status belongs to the ToolCall records, and this projection never invents a status.
 */
export interface MessageViewOptions { status?: ChatMessage['status']; error?: NonNullable<ChatMessage['error']> }

/**
 * Map one persisted or live-projected message to the front-end view. The status is only what the
 * caller actually knows: persisted history is done, live deltas are streaming, and cancelled/error
 * turns carry their terminal state instead of pretending to be finished.
 */
export function messageView(message: StoredMessage, options: MessageViewOptions = {}): ChatMessage {
  const role: ChatMessage['role'] = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system';
  const parts: MessagePart[] = [];
  // Thinking is readable context beside the answer, not part of it: keep a separate part and never
  // synthesize an empty one for a turn that produced no reasoning.
  if (message.reasoningContent?.trim()) parts.push({ kind: 'reasoning', text: message.reasoningContent });
  if (message.content) parts.push({ kind: 'text', text: message.content });
  if (message.toolCalls?.length) parts.push({ kind: 'notice', tone: 'info', text: `工具提议：${message.toolCalls.map(call => call.name).join('、')}（执行状态见 Inspector）` });
  if (!parts.length) parts.push({ kind: 'text', text: '' });
  const status = options.status ?? 'done';
  return {
    id: message.id, role, createdAt: message.createdAt, status, parts,
    ...(message.requestId ? { requestId: message.requestId } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments.map(attachmentView) } : {}),
    ...(status === 'error' && options.error ? { error: options.error } : {}),
  };
}
const attachmentView = (attachment: { name: string; path: string; bytes: number }): FrontendAttachment =>
  ({ id: attachment.path, name: attachment.name, kind: 'file', bytes: attachment.bytes, path: attachment.path });

/**
 * 会话领域: Chat(HarnessStore) 与 Work(Kernel) 共用一个展示索引，原生 ID 不重写。
 * 执行状态每次从 ChatService/Kernel 实时读取，索引只缓存上次观察到的状态与展示字段。
 */
export class ProductSessions implements SessionsDomain {
  constructor(readonly rt: ProductRuntime) {}

  async list(query: SessionListQuery): Promise<{ items: SessionSummary[]; nextCursor?: string }> {
    const value = pickFields(query ?? {}, ['mode', 'text', 'projectId', 'cursor', 'limit'], 'Session query');
    const mode = value.mode === undefined ? undefined
      : MODES.includes(value.mode as AppMode) ? value.mode as AppMode : invalid('mode must be chat, cowork or code.');
    const text = optionalString(value.text, 'text', 200);
    const projectId = optionalString(value.projectId, 'projectId', 200);
    const cursor = value.cursor === undefined ? undefined : requiredString(value.cursor, 'cursor', 4096);
    const limit = value.limit === undefined ? 40 : boundedInteger(value.limit, 'limit', 1, 100);
    const page = this.page({
      ...(mode ? { mode } : {}), ...(text?.trim() ? { text: text.trim() } : {}),
      ...(projectId ? { projectId } : {}), ...(cursor ? { cursor } : {}), limit,
    });
    const items: SessionSummary[] = [];
    for (const record of page.items) {
      const row = this.refresh(record);
      if (row) items.push(row);
    }
    return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async get(id: string, before?: string): Promise<SessionDetail> {
    const sessionId = requiredString(id, 'Session id', 200);
    const chat = this.chatSession(sessionId);
    const cursor = before === undefined ? undefined : this.messageCursor(before, sessionId, Boolean(chat));
    if (chat) {
      const record = this.rt.store.getSession(sessionId) ?? this.indexChatSession(chat);
      const page = this.rt.harness.store.messagePage(sessionId, 100, cursor ?? Number.MAX_SAFE_INTEGER);
      const row = this.refresh(record) ?? this.summary(record, 'idle');
      return { ...row, messages: page.messages.map(message => messageView(message)), hasMoreBefore: Boolean(page.nextMessageCursor), ...(page.nextMessageCursor ? { beforeCursor: String(page.nextMessageCursor) } : {}) };
    }
    if (this.rt.store.isSessionDismissed(sessionId)) notFound(`Session not found: ${sessionId}`);
    const task = this.rt.services.kernel.getTask(sessionId);
    if (task) {
      const record = this.rt.store.getSession(sessionId) ?? this.indexWorkTask(task);
      const page = this.rt.services.kernel.messagePage(sessionId, cursor ?? Number.MAX_SAFE_INTEGER, 100);
      const row = this.refresh(record) ?? this.summary(record, sessionStatusOf(task));
      return { ...row, messages: page.messages.map(message => messageView(message)), hasMoreBefore: Boolean(page.nextCursor), ...(page.nextCursor ? { beforeCursor: String(page.nextCursor) } : {}) };
    }
    notFound(`Session not found: ${sessionId}`);
  }

  async update(id: string, patch: SessionUpdatePatch): Promise<SessionSummary> {
    const sessionId = requiredString(id, 'Session id', 200);
    const value = pickFields(patch, ['title', 'pinned', 'permission', 'modelId', 'reasoningEffort'], 'Session update');
    const title = value.title === undefined ? undefined : requiredString(value.title, 'title', 200);
    if (value.pinned !== undefined && typeof value.pinned !== 'boolean') invalid('pinned must be a boolean.');
    const pinned = value.pinned as boolean | undefined;
    const permission = value.permission === undefined ? undefined
      : PERMISSIONS.includes(value.permission as PermissionMode) ? value.permission as PermissionMode
        : invalid('permission must be read-only, ask, auto-review or full-access.');
    const modelId = value.modelId === undefined ? undefined : this.profileId(value.modelId);
    const reasoningEffort = value.reasoningEffort === undefined ? undefined : this.effort(value.reasoningEffort);
    const chat = this.chatSession(sessionId);
    if (!chat && this.rt.store.isSessionDismissed(sessionId)) notFound(`Session not found: ${sessionId}`);
    const task = chat ? undefined : this.rt.services.kernel.getTask(sessionId);
    if (!chat && !task) notFound(`Session not found: ${sessionId}`);
    if (chat) {
      const sessionPatch: Partial<ChatSession> = {};
      if (title !== undefined) sessionPatch.title = title;
      if (modelId !== undefined) sessionPatch.profileId = modelId;
      const session = Object.keys(sessionPatch).length ? this.rt.harness.store.updateSession(sessionId, sessionPatch) : this.rt.harness.store.getSession(sessionId);
      const record = this.indexChatSession(session, {
        ...(pinned !== undefined ? { pinned } : {}), ...(permission !== undefined ? { permission } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}), updatedAt: session.updatedAt,
      });
      return this.refresh(record) ?? this.summary(record, 'idle');
    }
    if (permission !== undefined) {
      try {
        // Operator-only authority: the Kernel fences the subtree, bumps the policy epoch and the
        // service interrupts any in-flight run; the index only mirrors the resulting display row.
        this.rt.services.command({ commandId: randomUUID(), type: 'set_permission', taskId: sessionId,
          parameters: { permissionMode: permission, reason: 'Operator changed the session permission' } });
      } catch (error) { throw kernelError(error); }
    }
    const current = this.rt.services.kernel.getTask(sessionId);
    if (!current) notFound(`Session not found: ${sessionId}`);
    const record = this.indexWorkTask(current, {
      ...(title !== undefined ? { title } : {}), ...(pinned !== undefined ? { pinned } : {}),
      ...(modelId !== undefined ? { modelId } : {}), ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    });
    return this.refresh(record) ?? this.summary(record, sessionStatusOf(current));
  }

  async remove(id: string): Promise<void> {
    const sessionId = requiredString(id, 'Session id', 200);
    const chat = this.chatSession(sessionId);
    if (chat) {
      const service = this.rt.harness.chat as SettleableChat;
      const activeRequestId = service.activeRequestId(sessionId);
      // From here until the delete finishes, the product layer must not project this conversation:
      // settling the request is part of removal, not an observable answer.
      this.rt.markRemoving?.(sessionId, true);
      try {
        if (activeRequestId) {
          if (typeof service.cancelAndSettle === 'function') {
            if (!await service.cancelAndSettle(sessionId)) busy('Chat request is still settling; try again after it stops.');
          } else service.cancel(activeRequestId);
          if (service.activeRequestId(sessionId)) busy('Chat request is still running; stop it before removing the conversation.');
        }
        // Promoted origins are copied before the live records disappear.
        this.rt.harness.store.deleteSession(sessionId);
        this.rt.store.removeSession(sessionId);
        this.rt.append({ type: 'session.removed', sessionId }, sessionId);
      } finally { this.rt.markRemoving?.(sessionId, false); }
      return;
    }
    const task = this.rt.services.kernel.getTask(sessionId);
    if (!task) notFound(`Session not found: ${sessionId}`);
    // A Work session is a Kernel audit record: stop non-terminal work, then hide the row only.
    if (!TERMINAL_TASKS.has(task.status)) {
      try { this.rt.services.command({ commandId: randomUUID(), type: 'cancel', taskId: sessionId }); }
      catch (error) { throw kernelError(error); }
    }
    this.rt.store.dismissSession(sessionId);
    this.rt.store.removeSession(sessionId);
    this.rt.append({ type: 'session.removed', sessionId }, sessionId);
  }

  async branch(id: string, messageId: string): Promise<SessionSummary> {
    const sessionId = requiredString(id, 'Session id', 200);
    const selected = requiredString(messageId, 'Message id', 200);
    if (!this.chatSession(sessionId)) {
      if (this.rt.store.isSessionDismissed(sessionId)) notFound(`Session not found: ${sessionId}`);
      const task = this.rt.services.kernel.getTask(sessionId);
      if (!task) notFound(`Session not found: ${sessionId}`);
      return this.branchWork(task, selected);
    }
    const created = await this.branchSession(sessionId, selected);
    const record = this.indexChatSession(created, { parentSessionId: sessionId, mode: this.rt.store.getSession(sessionId)?.mode });
    const row = this.refresh(record) ?? this.summary(record, 'idle');
    this.rt.append({ type: 'session.upsert', session: row }, record.id);
    return row;
  }

  /**
   * Fork a Work task at one of its main-session messages. The Kernel inserts the new paused task and its durable
   * origin preparation marker in one transaction, so a crash can never expose a queued branch a restart would
   * dispatch. Only after that row exists do we copy and verify the immutable prefix and mark it ready; any later
   * failure fences the paused row and removes the partial origin, leaving no executable task and no success event.
   */
  private branchWork(source: Task, messageId: string): SessionSummary {
    const kernel = this.rt.services.kernel;
    const message = kernel.getMessage(messageId);
    if (!message || message.taskId !== source.id || message.sessionId !== 'main')
      notFound('The selected message is not in this task conversation.');
    let snapshot: number;
    try { snapshot = kernel.messageCursor(source.id, messageId, 'main'); }
    catch (error) { notFound(this.message(error)); }
    const previous = this.rt.store.getSession(source.id);
    const title = `${previous?.title ?? source.title} · 分支`;
    let taskId: string | undefined;
    try {
      const ack = this.rt.services.command({ commandId: randomUUID(), type: 'create_task', parameters: {
        title, workspace: source.workspace, appMode: 'work', initialStatus: 'paused',
        permissionMode: kernel.permissionMode(source.id),
        branchOrigin: { sourceTaskId: source.id, sourceMessageId: messageId, snapshot },
        goal: { objective: source.goal.objective, constraints: source.goal.constraints, acceptance: source.goal.acceptance, mode: source.goal.mode },
      } });
      if (!ack.taskId) throw new Error('The Kernel did not return the new task id.');
      taskId = ack.taskId;
      // Paged raw-row copy: the origin holds exactly the records through the selected message, byte for byte.
      const link = this.rt.harness.createWorkOrigin(taskId, source.id, messageId, snapshot,
        (after, limit) => kernel.messageRows(source.id, after, limit, 'main', snapshot));
      // The branch becomes executable only after the complete origin exists and its count matches the Kernel marker.
      kernel.markWorkOriginReady(taskId, link.messageCount);
      const task = this.rt.services.task(taskId);
      const record = this.indexWorkTask(task, { mode: previous?.mode ?? 'cowork', title, parentSessionId: source.id, modelId: previous?.modelId });
      const row = this.refresh(record) ?? this.summary(record, sessionStatusOf(task));
      this.rt.append({ type: 'session.upsert', session: row }, record.id);
      return row;
    } catch (error) {
      if (taskId) {
        try { kernel.fenceIncompleteWorkOrigin(taskId, 'Branch creation stopped before the immutable origin was committed.'); }
        catch { /* the row is already paused; fall back to operator cancellation for cleanup */ try { this.rt.services.command({ commandId: randomUUID(), type: 'cancel', taskId }); } catch { /* nothing else can be done here */ } }
        try { this.rt.harness.removeWorkOrigin(taskId); }
        catch { /* the origin file may not have been created yet */ }
      }
      if (error instanceof ProductError) throw error;
      throw kernelError(error);
    }
  }

  async promote(id: string, goal: PromoteGoal): Promise<SessionSummary> {
    const sessionId = requiredString(id, 'Session id', 200);
    const chat = this.chatSession(sessionId);
    if (!chat) {
      if (this.rt.services.kernel.getTask(sessionId)) throw new ProductError('unsupported', '只有 Chat 会话可以升级为 Cowork 长任务。', 501);
      notFound(`Session not found: ${sessionId}`);
    }
    const value = pickFields(goal, ['objective', 'acceptance'], 'Promote goal');
    const objective = requiredString(value.objective, 'goal.objective', 4000);
    const acceptance = this.acceptance(value.acceptance);
    // The origin chat keeps its read-only display authority; the promoted task starts as Work.
    const origin = this.rt.store.getSession(sessionId) ?? this.indexChatSession(chat);
    // A project chosen after this Chat began is the governed workspace of the promoted task; the chat
    // session scope may still be the read-only installation default used for Chat instructions.
    const projectWorkspace = origin.projectId ? this.rt.resolveProject?.(origin.projectId) : undefined;
    if (origin.projectId && !projectWorkspace) invalid('The selected project is unavailable. 请重新选择项目文件夹。');
    let promoted: { taskId: string };
    try {
      promoted = this.rt.harness.chat.promote(sessionId, { objective, acceptance, appMode: 'work', permissionMode: origin.permission,
        ...(projectWorkspace ? { workspace: projectWorkspace } : {}),
        ...(origin.projectId ? { projectId: origin.projectId } : {}) });
    } catch (error) { throw kernelError(error, 'validation'); }
    const task = this.rt.services.task(promoted.taskId);
    const record = this.indexWorkTask(task, { mode: 'cowork', title: task.title, parentSessionId: sessionId, modelId: chat.profileId,
      ...(origin.projectId ? { projectId: origin.projectId } : {}), pinned: false });
    const updatedChat = this.chatSession(sessionId);
    if (updatedChat) this.indexChatSession(updatedChat, { ...(origin.projectId ? { projectId: origin.projectId } : {}) });
    const row = this.refresh(record) ?? this.summary(record, sessionStatusOf(task));
    this.rt.append({ type: 'session.upsert', session: row }, record.id);
    return row;
  }

  selectionFor(sessionId: string): SessionSelection | undefined {
    if (typeof sessionId !== 'string' || !sessionId) return undefined;
    const record = this.rt.store.getSession(sessionId);
    if (!record) return undefined;
    return { profileId: record.modelId, mode: record.mode, permission: record.permission,
      ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}), ...(record.projectId ? { projectId: record.projectId } : {}) };
  }

  unlinkProject(projectId: string): number {
    return this.rt.store.unlinkProject(requiredString(projectId, 'Project id', 200));
  }

  /** Index or refresh one Harness chat session; native ID and timestamps stay authoritative. */
  indexChatSession(session: ChatSession, patch: Partial<SessionIndexRecord> = {}): SessionIndexRecord {
    const existing = this.rt.store.getSession(session.id);
    const recent = this.chatPreview(session.id);
    const effort = patch.reasoningEffort !== undefined ? patch.reasoningEffort || undefined : existing?.reasoningEffort;
    const projectId = patch.projectId !== undefined ? patch.projectId || undefined : existing?.projectId;
    const previewText = recent ?? existing?.preview;
    const record: SessionIndexRecord = {
      id: session.id, kind: 'chat', mode: patch.mode ?? existing?.mode ?? 'chat', title: patch.title ?? session.title, status: 'idle',
      permission: patch.permission ?? existing?.permission ?? 'read-only', modelId: patch.modelId ?? session.profileId ?? 'default',
      ...(effort ? { reasoningEffort: effort } : {}), ...(projectId ? { projectId } : {}),
      pinned: patch.pinned ?? existing?.pinned ?? false, ...(previewText ? { preview: previewText } : {}),
      ...(patch.unread ?? existing?.unread ? { unread: patch.unread ?? existing?.unread } : {}),
      ...(patch.parentSessionId ?? session.parentSessionId ?? existing?.parentSessionId ? { parentSessionId: patch.parentSessionId ?? session.parentSessionId ?? existing?.parentSessionId } : {}),
      ...(session.workTaskId ?? existing?.workTaskId ? { workTaskId: session.workTaskId ?? existing?.workTaskId } : {}),
      createdAt: session.createdAt, updatedAt: patch.updatedAt ?? session.updatedAt,
    };
    this.rt.store.upsertSession(record);
    return record;
  }

  /** Index or refresh one Kernel task; execution state and workspace remain the Kernel's. */
  indexWorkTask(task: Task, patch: Partial<SessionIndexRecord> = {}): SessionIndexRecord {
    const existing = this.rt.store.getSession(task.id);
    const recent = this.workPreview(task.id);
    const effort = patch.reasoningEffort !== undefined ? patch.reasoningEffort || undefined : existing?.reasoningEffort;
    const projectId = patch.projectId !== undefined ? patch.projectId || undefined : existing?.projectId;
    const parentSessionId = patch.parentSessionId !== undefined ? patch.parentSessionId || undefined : existing?.parentSessionId;
    const previewText = recent ?? existing?.preview;
    const record: SessionIndexRecord = {
      id: task.id, kind: 'work', mode: patch.mode ?? existing?.mode ?? 'cowork',
      title: patch.title ?? existing?.title ?? task.title, status: task.status,
      permission: task.permissionMode ?? patch.permission ?? existing?.permission ?? 'ask',
      modelId: patch.modelId ?? existing?.modelId ?? this.rt.harness.requests.profileId({ taskId: task.id }),
      ...(effort ? { reasoningEffort: effort } : {}), ...(projectId ? { projectId } : {}),
      pinned: patch.pinned ?? existing?.pinned ?? false, ...(previewText ? { preview: previewText } : {}),
      ...(patch.unread ?? existing?.unread ? { unread: patch.unread ?? existing?.unread } : {}),
      ...(parentSessionId ? { parentSessionId } : {}), workTaskId: task.id,
      createdAt: task.createdAt, updatedAt: task.updatedAt,
    };
    this.rt.store.upsertSession(record);
    return record;
  }

  listIndex(): SessionIndexRecord[] {
    return [...this.rt.store.chatSessions(2000), ...this.rt.store.workSessions(2000)].sort((left, right) =>
      Number(right.pinned) - Number(left.pinned) || right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  }

  /** Re-read live execution state, persist a changed status, and return the display row. */
  refresh(record: SessionIndexRecord): SessionSummary | undefined {
    if (record.kind === 'chat') {
      const status = this.chatStatus(record);
      const current = record.status === status ? record : this.rt.store.patchSession(record.id, { status });
      return this.summary(current, status);
    }
    const task = this.rt.services.kernel.getTask(record.id);
    if (!task) { this.rt.store.removeSession(record.id); return undefined; }
    const current = record.status === task.status ? record : this.rt.store.patchSession(record.id, { status: task.status });
    return this.summary(current, sessionStatusOf(task));
  }

  summary(record: SessionIndexRecord, status?: SessionStatus): SessionSummary {
    const resolved = status ?? (record.kind === 'chat' ? this.chatStatus(record) : this.workStatus(record));
    const task = record.kind === 'work' ? this.rt.services.kernel.getTask(record.id) : undefined;
    const peers = task ? this.rt.services.kernel.coordination?.summary(task.workspace, task.id) : undefined;
    return {
      id: record.id, mode: record.mode, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt,
      status: resolved, permission: record.permission, modelId: record.modelId,
      ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
      ...(record.projectId ? { projectId: record.projectId } : {}),
      pinned: record.pinned, ...(record.preview ? { preview: record.preview } : {}),
      ...(record.unread !== undefined ? { unread: record.unread } : {}),
      ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
      ...(peers?.count ? { peers } : {}),
    };
  }

  private chatStatus(record: SessionIndexRecord): SessionStatus {
    if (this.rt.harness.chat.activeRequestId(record.id)) return 'streaming';
    if (this.rt.harness.tools.busy(record.id)) return 'running';
    // A remembered "streaming" without a live request settled while the app was away.
    if (record.status === 'streaming') return 'idle';
    return isSessionStatus(record.status) ? record.status : 'idle';
  }
  private workStatus(record: SessionIndexRecord): SessionStatus {
    const task = this.rt.services.kernel.getTask(record.id);
    return task ? sessionStatusOf(task) : 'idle';
  }
  private page(query: { mode?: string; projectId?: string; text?: string; cursor?: string; limit?: number }): { items: SessionIndexRecord[]; nextCursor?: string } {
    try { return this.rt.store.listSessions(query); }
    catch (error) { invalid(error instanceof Error ? error.message : 'Invalid session cursor.'); }
  }
  private messageCursor(value: string, sessionId: string, chat: boolean): number {
    if (typeof value === 'string' && value.startsWith('message:')) {
      const id = requiredString(value.slice(8), 'Message anchor', 200);
      if (chat) {
        const ref = this.rt.harness.store.messageRef(sessionId, id);
        if (!ref) invalid('Message anchor is not in this conversation.');
        return ref.seq;
      }
      try { return this.rt.services.kernel.messageCursor(sessionId, id, 'main'); }
      catch { invalid('Message anchor is not in this conversation.'); }
    }
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) invalid('Message cursor must be a positive integer.');
    const cursor = Number(value);
    if (!Number.isSafeInteger(cursor)) invalid('Message cursor must be a positive integer.');
    return cursor;
  }
  private chatSession(id: string): ChatSession | undefined {
    try { return this.rt.harness.store.getSession(id); }
    catch { return undefined; } // HarnessStore throws a single "Chat session not found." error.
  }
  private async branchSession(sessionId: string, messageId: string): Promise<ChatSession> {
    try { return await this.rt.harness.chat.branch(sessionId, { messageId }); }
    catch (error) { notFound(this.message(error)); }
  }
  private chatPreview(sessionId: string): string | undefined {
    const page = this.rt.harness.store.messagePage(sessionId, 20);
    const message = page.messages.findLast(item => item.role === 'user' || item.role === 'assistant');
    return message && preview(message.content) ? preview(message.content) : undefined;
  }
  private workPreview(taskId: string): string | undefined {
    const messages = this.rt.services.kernel.tailMessages(taskId, 20);
    const message = messages.findLast(item => item.role === 'user' || item.role === 'assistant');
    return message && preview(message.content) ? preview(message.content) : undefined;
  }
  private profileId(value: unknown): string {
    const id = requiredString(value, 'modelId', 200);
    if (!this.rt.harness.profiles.list().some(profile => profile.id === id)) invalid(`Unknown model profile: ${id}`);
    return id;
  }
  private effort(value: unknown): string {
    if (value === '') return '';
    const effort = requiredString(value, 'reasoningEffort', 64);
    if (!EFFORT.test(effort)) invalid('reasoningEffort must contain letters, digits, spaces, dots, underscores or hyphens.');
    return effort;
  }
  private acceptance(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 20) invalid('goal.acceptance must be an array of at most 20 items.');
    return value.map((item, index) => requiredString(item, `goal.acceptance[${index}]`, 500));
  }
  private message(error: unknown): string {
    return this.rt.harness.sanitize(error instanceof Error ? error.message : String(error));
  }
}

/** Kernel failures keep their honest category; only unknown codes fall back to conflict. */
export function kernelError(error: unknown, fallback: 'conflict' | 'validation' = 'conflict'): ProductError {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (/^INVALID_|^OUTSIDE_WORKSPACE$|^WRONG_TASK$|^TASK_REQUIRED$/.test(code)) return new ProductError('validation', message, 400);
  return new ProductError(fallback, message, fallback === 'conflict' ? 409 : 400);
}
