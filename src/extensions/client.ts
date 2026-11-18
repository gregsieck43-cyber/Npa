import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Command, CommandAck, Event, Message, Snapshot, Task, WorkspaceInfo } from '../contracts.js';
import type { ChatSession, RequestRecord } from '../harness/types.js';
import type { IdeAgentSelection, IdeAgentView } from '../ide/types.js';

export interface ClientOptions { dataDir: string; baseUrl?: string; token?: string; timeoutMs?: number; maxResponseBytes?: number; }
export interface HistoryOptions { afterSeq?: number; cursor?: number; limit?: number; throughSeq?: number; }
export interface HistoryPage { afterSeq: number; limit: number; nextCursor: number | null; hasMore: boolean; throughSeq?: number; }
export interface EventHistory { events: Event[]; page?: HistoryPage; historyWindow?: true; }
export interface MessageHistory { messages: Message[]; page: HistoryPage; historyWindow: true; }
export interface BackendAccess {
  health(signal?: AbortSignal): Promise<Record<string, unknown>>;
  snapshot(taskId?: string, signal?: AbortSignal): Promise<Snapshot>;
  events(taskId: string, options?: HistoryOptions, signal?: AbortSignal): Promise<EventHistory>;
  messages?(taskId: string, options?: HistoryOptions, signal?: AbortSignal): Promise<MessageHistory>;
  command(command: Command, signal?: AbortSignal): Promise<CommandAck>;
}

export class BackendError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'BackendError'; }
}

/** A client of the desktop's single authoritative backend; it never opens the database. */
export class BackendClient implements BackendAccess {
  constructor(private readonly options: ClientOptions) {}
  /** Report only this NPN proxy, without joining or reparenting its caller's Windows Job. */
  async observeOwnResources(kind: 'cli' | 'mcp'): Promise<() => Promise<void>> {
    const id = `${kind}-${randomUUID()}`, controller = new AbortController();
    let pending: Promise<unknown> | undefined;
    const report = () => {
      if (pending || controller.signal.aborted) return;
      pending = this.request('POST', '/v1/resources/proxy', { id, kind, pid: process.pid, workingSetBytes: process.memoryUsage().rss }, controller.signal)
        .catch(() => undefined).finally(() => { pending = undefined; });
    };
    report(); await pending;
    const timer = setInterval(report, 5000); timer.unref();
    let stopping: Promise<void> | undefined;
    return () => stopping ??= (async () => {
      clearInterval(timer); controller.abort(); await pending;
      await this.request('POST', '/v1/resources/proxy', { id, kind, pid: process.pid, remove: true }, AbortSignal.timeout(1000)).catch(() => undefined);
    })();
  }

  private async connection(): Promise<{ baseUrl: string; token: string }> {
    if (this.options.baseUrl) {
      const url = new URL(this.options.baseUrl);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || !this.options.token) {
        throw new BackendError('Backend access requires an authenticated HTTP endpoint on 127.0.0.1.');
      }
      return { baseUrl: url.origin, token: this.options.token };
    }
    let discovery: { port: number; token: string };
    try {
      discovery = JSON.parse(await readFile(join(this.options.dataDir, 'backend.json'), 'utf8')) as typeof discovery;
    } catch {
      throw new BackendError('Backend discovery is unavailable. Start NPN-Gamma.exe with this data directory.');
    }
    if (!Number.isInteger(discovery.port) || discovery.port < 1 || discovery.port > 65535 || typeof discovery.token !== 'string' || !discovery.token) {
      throw new BackendError('Backend discovery is invalid. Restart NPN-Gamma.exe.');
    }
    return { baseUrl: `http://127.0.0.1:${discovery.port}`, token: discovery.token };
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const { baseUrl, token } = await this.connection();
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw new BackendError('Request cancelled.');
      if (timeout.aborted) throw new BackendError('Backend request timed out; query the command ID before retrying a mutation.');
      throw new BackendError(`Cannot reach the local backend. Start or restart NPN-Gamma.exe. ${error instanceof Error ? error.name : 'NetworkError'}`);
    }
    let value: { error?: string; message?: string };
    if (response.body) {
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > (this.options.maxResponseBytes ?? 16 * 1024 * 1024)) {
            await reader.cancel();
            throw new BackendError('Backend response exceeds the transport byte limit. Use paged history or a narrower task query.');
          }
          chunks.push(part.value);
        }
        value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      } finally { reader.releaseLock(); }
    } else value = await response.json() as { error?: string; message?: string };
    if (!response.ok) throw new BackendError(value.message ?? value.error ?? `Backend returned HTTP ${response.status}.`, response.status);
    return value as T;
  }

  health(signal?: AbortSignal): Promise<Record<string, unknown>> { return this.request('GET', '/health', undefined, signal); }
  snapshot(taskId?: string, signal?: AbortSignal): Promise<Snapshot> {
    return this.request('GET', `/v1/snapshot${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`, undefined, signal);
  }
  async events(taskId: string, options: HistoryOptions = {}, signal?: AbortSignal): Promise<EventHistory> {
    const response = await this.historyPage<Event>(taskId, 'events', options, signal);
    return { events: response.items, page: response.page, historyWindow: true };
  }
  async messages(taskId: string, options: HistoryOptions = {}, signal?: AbortSignal): Promise<MessageHistory> {
    const response = await this.historyPage<Message>(taskId, 'messages', options, signal);
    return { messages: response.items, page: response.page, historyWindow: true };
  }
  private async historyPage<T>(taskId: string, kind: 'events' | 'messages', options: HistoryOptions, signal?: AbortSignal) {
    if (options.afterSeq !== undefined && options.cursor !== undefined) throw new BackendError('Specify afterSeq or cursor, not both.');
    const afterSeq = options.cursor ?? options.afterSeq ?? 0;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new BackendError('History sequence must be a nonnegative safe integer.');
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new BackendError('History limit must be an integer from 1 to 1000.');
    if (options.throughSeq !== undefined && (!Number.isSafeInteger(options.throughSeq) || options.throughSeq < 0)) throw new BackendError('History watermark must be a nonnegative safe integer.');
    const query = new URLSearchParams({ kind, after: String(afterSeq), limit: String(limit), ...(options.throughSeq === undefined ? {} : { through: String(options.throughSeq) }) });
    return this.request<{ items: T[]; page: HistoryPage }>('GET', `/v1/tasks/${encodeURIComponent(taskId)}/history-page?${query}`, undefined, signal);
  }
  agentView(workspace: string, selected: IdeAgentSelection): Promise<IdeAgentView> {
    return this.request('GET', `/v1/ide/agent?${new URLSearchParams({ workspace, ...(selected.taskId ? { taskId: selected.taskId } : {}), ...(selected.chatId ? { chatId: selected.chatId } : {}) })}`);
  }
  createChat(input: Partial<Omit<ChatSession, 'capabilities'>> & { capabilities?: Partial<ChatSession['capabilities']> }): Promise<ChatSession> { return this.request('POST', '/v1/harness/sessions', input); }
  updateChat(id: string, input: Partial<ChatSession>): Promise<ChatSession> { return this.request('POST', `/v1/harness/sessions/${encodeURIComponent(id)}`, input); }
  sendChat(input: { sessionId: string; content: string }): Promise<{ requestId: string; status: 'running' }> { return this.request('POST', '/v1/harness/chat', input); }
  promoteChat(id: string, input: { workspace: string; objective?: string }): Promise<{ taskId: string }> { return this.request('POST', `/v1/harness/sessions/${encodeURIComponent(id)}/promote`, input); }
  cancelRequest(id: string): Promise<{ cancelled: boolean }> { return this.request('POST', `/v1/harness/requests/${encodeURIComponent(id)}/cancel`, {}); }
  requestRecord(id: string): Promise<RequestRecord> { return this.request('GET', `/v1/harness/requests/${encodeURIComponent(id)}`); }
  approveTool(id: string, digest: string, approved: boolean, expectedConflictFingerprint?: string): Promise<unknown> { return this.request('POST', `/v1/harness/tools/${encodeURIComponent(id)}/approve`, { digest, approved, ...(expectedConflictFingerprint ? { expectedConflictFingerprint } : {}) }); }
  editorState(input: { owner: string; workspace?: string; dirtyPaths?: string[]; remove?: boolean; sequence?: number }): Promise<{ recorded: boolean }> { return this.request('POST', '/v1/ide/editors', input); }
  taskView(taskId: string): Promise<Snapshot> { return this.request('GET', `/v1/snapshot?compact=true&taskId=${encodeURIComponent(taskId)}`); }
  openWorkspace(value: string): Promise<WorkspaceInfo> { return this.request('POST', '/v1/workspaces/open', { path: value }); }
  workspace(value: string): Promise<WorkspaceInfo> { return this.request('GET', `/v1/ide/workspace?path=${encodeURIComponent(value)}`); }
  tasks(workspace: string): Promise<Task[]> { return this.request('GET', `/v1/ide/tasks?workspace=${encodeURIComponent(workspace)}`); }
  command(command: Command, signal?: AbortSignal): Promise<CommandAck> { return this.request('POST', '/v1/commands', command, signal); }
}
