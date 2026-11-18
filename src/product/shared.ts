/**
 * 共享产品 API 的公共契约。
 *
 * 前端 DTO 只以 src/frontend/api/types.ts 为准（仅 type import，绝不修改前端）。
 * 领域模块之间只通过本文件交换类型与错误；HTTP 路由、事件和跨域接线由 api.ts 负责。
 */
import type {
  AppMode, ApprovalRequest, ChatMessage, ConnectionInfo, Diagnostic, FileDiff, FileNode, GatewayEvent,
  MetricsView, ModelProfile, ModelProfileInput, PermissionMode, ProjectView, SearchHit, SearchQuery,
  SessionDetail, SessionSummary, SideAnswer, SideAskInput, SourceControlView, TaskControl, TaskDetail,
  TerminalResult, Attachment, SendInput,
} from '../frontend/api/types.js';
import type { ApprovalDecision } from '../frontend/api/types.js';
import type { Services } from '../app/services.js';
import type { Harness } from '../harness/service.js';
import type { ChatSession, ChatMessage as HarnessChatMessage } from '../harness/types.js';
import type { Task } from '../contracts.js';
import type { ProductStore } from './store.js';

export type {
  AppMode, ApprovalRequest, ChatMessage, ConnectionInfo, Diagnostic, FileDiff, FileNode, GatewayEvent,
  MetricsView, ModelProfile, ModelProfileInput, PermissionMode, ProjectView, SearchHit, SearchQuery,
  SessionDetail, SessionSummary, SideAnswer, SideAskInput, SourceControlView, TaskControl, TaskDetail,
  TerminalResult, Attachment, SendInput, ApprovalDecision,
};

export type ProductErrorCode =
  | 'validation' | 'not_found' | 'busy' | 'conflict' | 'stale'
  | 'denied' | 'scope' | 'unsupported' | 'unavailable' | 'internal';

/** HTTP 层与前端 GatewayError.code 的稳定错误码；message 只包含可展示的脱敏文本。 */
export class ProductError extends Error {
  constructor(readonly code: ProductErrorCode, message: string, readonly status = 400, readonly retryable = false) {
    super(message);
    this.name = 'ProductError';
  }
}

export function invalid(message: string): never { throw new ProductError('validation', message); }
export function notFound(message: string): never { throw new ProductError('not_found', message, 404); }
export function busy(message: string): never { throw new ProductError('busy', message, 409); }

/** HTTP 输入校验: 拒绝未知字段，避免把内部对象或拼写错误静默带入执行路径。 */
export function pickFields(input: unknown, allowed: readonly string[], label = 'Request body'): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid(`${label} must be an object.`);
  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) invalid(`Unknown field: ${unknown.slice(0, 5).join(', ')}`);
  return value;
}

export function requiredString(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${label} must be 1-${max} characters.`);
  return value;
}

export function optionalString(value: unknown, label: string, max = 200): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) invalid(`${label} must be a string of at most ${max} characters.`);
  return value;
}

export function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    invalid(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return value as number;
}

/** 领域运行时: 共享后台服务 + 产品索引/事件存储 + 事件追加。 */
export interface ProductRuntime {
  readonly services: Services;
  readonly harness: Harness;
  readonly store: ProductStore;
  append(event: GatewayEvent, sessionId?: string): void;
  /** 已登记项目 ID -> 绝对路径；由 API 层接线，领域模块不自行维护登记表。 */
  resolveProject?(projectId: string): string | undefined;
  /** 会话删除守卫：删除流程内不得再为该会话写入实时投影（迟到 delta 也不得复活已删会话）。 */
  markRemoving?(sessionId: string, removing: boolean): void;
}

export interface SessionListQuery {
  mode?: AppMode;
  text?: string;
  projectId?: string;
  cursor?: string;
  limit?: number;
}

export interface SessionUpdatePatch {
  title?: string;
  pinned?: boolean;
  permission?: PermissionMode;
  modelId?: string;
  reasoningEffort?: string;
}

/** Work 模型请求所需的会话级选择（原生 task ID 作为 key）。 */
export interface SessionSelection {
  profileId?: string;
  reasoningEffort?: string;
  mode: AppMode;
  permission: PermissionMode;
  projectId?: string;
}

export interface PromoteGoal { objective: string; acceptance: string[] }
export interface ChatSendResult { sessionId: string; messageId: string }
export interface ModelTestResult { ok: boolean; latencyMs?: number; message: string }
export interface WorkspaceWriteResult { path: string; bytes: number; savedAt: string }
export interface WorkspaceCommitResult { commit: string }

/**
 * 会话领域。索引行是产品列表/分页的唯一来源；Chat 使用 HarnessStore 原生 chat ID，
 * Work 使用 Kernel 原生 task ID，不复制执行状态。
 */
export interface SessionsDomain {
  list(query: SessionListQuery): Promise<{ items: SessionSummary[]; nextCursor?: string }>;
  get(id: string, before?: string): Promise<SessionDetail>;
  update(id: string, patch: SessionUpdatePatch): Promise<SessionSummary>;
  remove(id: string): Promise<void>;
  branch(id: string, messageId: string): Promise<SessionSummary>;
  promote(id: string, goal: PromoteGoal): Promise<SessionSummary>;
  /** Work 执行器读取模型选择；chat 会话返回其展示元数据。 */
  selectionFor(sessionId: string): SessionSelection | undefined;
  /** 取消项目登记后解除会话关联，不删除会话。 */
  unlinkProject(projectId: string): number;
}

export interface ChatDomain {
  send(input: SendInput): Promise<ChatSendResult>;
  cancel(sessionId: string): Promise<void>;
  regenerate(sessionId: string, messageId: string): Promise<void>;
  edit(sessionId: string, messageId: string, text: string): Promise<void>;
  sideAsk(input: SideAskInput): Promise<SideAnswer>;
}

export interface ModelsDomain {
  list(): Promise<ModelProfile[]>;
  save(input: ModelProfileInput): Promise<ModelProfile>;
  remove(modelId: string): Promise<void>;
  test(modelId: string): Promise<ModelTestResult>;
}

export interface WorkspaceDomain {
  projects(): Promise<ProjectView[]>;
  addProject(path: string): Promise<ProjectView>;
  removeProject(projectId: string): Promise<void>;
  files(projectId: string): Promise<FileNode[]>;
  readFile(projectId: string, path: string): Promise<string>;
  writeFile(projectId: string, path: string, content: string): Promise<WorkspaceWriteResult>;
  search(projectId: string, query: SearchQuery): Promise<SearchHit[]>;
  sourceControl(projectId: string): Promise<SourceControlView>;
  fileDiff(projectId: string, path: string): Promise<FileDiff>;
  commit(projectId: string, message: string, paths: string[]): Promise<WorkspaceCommitResult>;
  terminal(projectId: string, command: string): Promise<TerminalResult>;
  diagnostics(projectId: string): Promise<Diagnostic[]>;
}

/** 产品索引行; 仅展示元数据，执行状态始终实时读 Kernel/Chat。 */
export interface SessionIndexRecord {
  id: string;
  kind: 'chat' | 'work';
  mode: AppMode;
  title: string;
  status: string;
  permission: PermissionMode;
  modelId: string;
  reasoningEffort?: string;
  projectId?: string;
  pinned: boolean;
  preview?: string;
  unread?: boolean;
  parentSessionId?: string;
  workTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredEvent { id: number; event: GatewayEvent; createdAt: string }
export interface ArchivedHistory {
  id: string;
  sessionId: string;
  kind: 'branch' | 'edit' | 'regenerate';
  sourceIds: string[];
  createdAt: string;
  record: unknown;
}

// 领域模块共用的 Harness 原生类型（避免各自定义漂移）。
export type NativeChatSession = ChatSession;
export type NativeChatMessage = HarnessChatMessage;
export type NativeTask = Task;
