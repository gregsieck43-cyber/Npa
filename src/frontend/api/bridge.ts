/**
 * 真实网关 —— 后端接线 Agent 的唯一工作文件（前端其余部分未经用户同意不要改动）。
 *
 * 实现方式：通过 Electron preload 暴露的 window.npn.request(method, path, body) / window.npn.desktop(action, payload)
 * 调用现有后台 /v1/product 路由与桌面动作，把返回值转换为 ./types.ts 中的形状。
 *
 * 规则：
 *   - 不要修改 ./types.ts、./contract.ts 的既有字段语义；只允许追加可选字段并同步 ../WIRING.md。
 *   - 不要在这里伪造数据或吞错；后台不支持时保持抛出 notWired，界面会如实显示"尚未接线"。
 *   - 流式/后台变化通过 subscribe 轮询 /v1/product/events 推送 GatewayEvent。
 *   - 后台非 2xx 由 desktop 主进程返回 {...body, httpStatus}（不抛）；传输层 reject 也统一转成 GatewayError。
 */
import { GatewayError, type DeepPartial, type NpnGateway } from './contract';
import type { LibraryGateway } from './library-types';
import type {
  ActivityDay, AppMode, ApprovalDecision, ApprovalRequest, Attachment, ConnectionInfo, ContextView, Diagnostic,
  FileDiff, FileNode, GatewayEvent, InstructionFileView, McpServerInput, McpServerView, MetricsView, ModelProfile,
  ModelProfileInput, Page, PluginView, ProjectView, PromptView, RecallPage, RequestRecordView, SearchHit,
  SearchQuery, SendInput, SessionDetail, SessionSummary, Settings, SideAnswer, SideAskInput, SideHistory, SkillView,
  SourceControlView, StateSnapshot, TaskControl, TaskDetail, TerminalResult, ToolInventory, ToolDetailPage, ToolDetailSection, TraceView, WebPage, WebSearchResult,
} from './types';

export interface NpnBridge {
  droppedFiles?(files: File[]): Promise<Attachment[]>;
  request(method: string, path: string, body?: unknown): Promise<any>;
  desktop(action: string, payload?: unknown): Promise<any>;
}

/** 可注入的计时器：测试用确定性时钟替换真实 setTimeout。 */
export interface BridgeTimers {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BridgeGatewayOptions {
  /** 追平历史事件后再次轮询的间隔。默认 1000ms。 */
  pollIntervalMs?: number;
  /** 单页事件数（后台限制 1..200）。默认 200。 */
  eventPageSize?: number;
  timers?: BridgeTimers;
  /** 事件轮询失败、历史被重置或监听器抛错时调用；不提供时写入 console.error。 */
  onStreamError?: (error: GatewayError) => void;
}

const PREFIX = '/v1/product';
const MAX_CATCH_UP_PAGES = 50;
const MAX_RETRY_DELAY_MS = 10000;
/** 大 limit 聚合的硬上限，避免异常游标让串行分页无界运行；正常 500 条只需 5 页。 */
const MAX_SESSION_PAGES = 100;
/** 快照恢复的会话分页预算：首页 + 最多 4 页补页 = 最多 500 个会话。 */
const MAX_SNAPSHOT_SESSION_PAGES = 5;
const SNAPSHOT_PAGE_LIMIT = 100;
/** 与后端审批列表上限一致；快照不会把无界审批缓存带进前端。 */
const MAX_SNAPSHOT_APPROVALS = 200;

const defaultTimers: BridgeTimers = {
  setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
  clearTimeout: handle => globalThis.clearTimeout(handle as never),
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transportError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError('transport_error', messageOf(error), true);
}

function desktopError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError('desktop_error', messageOf(error), false);
}

function httpError(body: Record<string, unknown>, status: number): GatewayError {
  // 旧后端没有 /snapshot 时返回 HTTP 404 且响应没有 code：这是"路由不存在"，不是恢复失败，
  // 映射为 not_found 让快照恢复退回 legacy 回放提示，而不是无限重试 state_snapshot_failed。
  const code = typeof body.code === 'string' && body.code ? body.code : status === 404 ? 'not_found' : 'http_error';
  const message = typeof body.error === 'string' && body.error ? body.error : `Request failed with HTTP ${status}.`;
  return new GatewayError(code, message, status >= 500 || status === 408 || status === 429);
}

function queryString(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? '?' + text : '';
}

/** 比较登记路径：Windows 不区分大小写，且选择器/登记表可能混用斜杠。 */
function comparablePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

interface EventPage {
  events: { id: number; event: GatewayEvent }[];
  nextCursor: number;
  earliest: number;
  reset: boolean;
  /** 后端事件日志代际；旧后端没有该字段。 */
  epoch?: string;
  /** Server held the read until a committed event or timeout; immediately renew the subscription. */
  longPoll?: boolean;
}

export class BridgeGateway implements NpnGateway {
  readonly kind = 'bridge' as const;
  coordination: NonNullable<NpnGateway['coordination']> = {
    claims: query => this.request('GET', '/coordination/claims' + queryString({ ...query })),
    claim: (sessionId, paths) => this.request('POST', '/coordination/claims', { sessionId, paths }),
    release: async (sessionId, ids) => { await this.request('POST', '/coordination/release', { sessionId, ids }); },
    presence: query => this.request('GET', '/coordination/presence' + queryString({ ...query })),
    inbox: (sessionId, query = {}) => this.request('GET', '/coordination/inbox' + queryString({ sessionId, ...query })),
    send: input => this.request('POST', '/coordination/send', input),
    ack: async (sessionId, noticeIds) => { await this.request('POST', '/coordination/ack', { sessionId, noticeIds }); },
  };
  library: LibraryGateway = {
    exportConversation: (sessionId, query = {}) => this.request('GET', '/library/export' + queryString({ sessionId, ...query })),
    presets: query => this.request('GET', '/library/presets' + queryString({ ...query })),
    savePreset: input => this.request('POST', '/library/presets/save', input),
    preset: query => this.request('GET', '/library/preset' + queryString({ ...query })),
    presetVersions: query => this.request('GET', '/library/preset-versions' + queryString({ ...query })),
    promptVersions: (sessionId, query) => this.request('GET', '/library/prompt-versions' + queryString({ sessionId, ...query })),
    requestVersions: (sessionId, query = {}) => this.request('GET', '/library/request-versions' + queryString({ sessionId, ...query })),
    sessionSettings: sessionId => this.request('GET', '/library/session-settings' + queryString({ sessionId })),
    saveSessionSettings: (sessionId, input) => this.request('POST', '/library/session-settings' + queryString({ sessionId }), input),
    validateRequest: (sessionId, body, requestId) => this.request('POST', '/library/validate-request' + queryString({ sessionId, requestId }), { body }),
  };

  private readonly timers: BridgeTimers;
  private readonly pollIntervalMs: number;
  private readonly eventPageSize: number;
  private readonly onStreamError: (error: GatewayError) => void;
  private readonly eventListeners = new Set<(event: GatewayEvent) => void>();
  private pollTimer: unknown = null;
  private pollGeneration = 0;
  private polling = false;
  private eventCursor = 0;
  private lastEventId = 0;
  /** 后端事件日志代际；null 表示还没从任何一页得知（兼容无 epoch 的旧后端）。 */
  private eventEpoch: string | null = null;
  /** 快照恢复时聚焦的会话；由前端 actions 在打开/离开会话时写入。 */
  private focusedSessionId?: string;
  private retryDelayMs: number | null = null;
  /** 最近一次 GET /connection 的真实结果，用于合成断线/恢复事件时保留版本与延迟。 */
  private lastConnection: ConnectionInfo | null = null;
  private streamDown = false;
  private streamDownMessage: string | null = null;
  /** 每次订阅生命周期内只提示一次历史缺口，避免反复打断用户。 */
  private historyGapNotified = false;

  constructor(readonly npn: NpnBridge, options: BridgeGatewayOptions = {}) {
    this.timers = options.timers ?? defaultTimers;
    this.pollIntervalMs = positiveNumber(options.pollIntervalMs, 1000);
    this.eventPageSize = Math.max(1, Math.min(200, Math.floor(positiveNumber(options.eventPageSize, 200))));
    this.onStreamError = options.onStreamError ?? (error => console.error('[bridge] event stream error:', error));
  }

  // GET /v1/product/connection；事件流已确认断开时不能返回看似正常的 online。
  connection = async (): Promise<ConnectionInfo> => {
    const info = await this.request<ConnectionInfo>('GET', '/connection');
    if (info && typeof info === 'object') this.lastConnection = info;
    if (!this.streamDown) return info;
    return {
      ...info,
      status: 'offline',
      demo: false,
      message: this.streamDownMessage ?? '实时事件流已断开。',
    };
  };

  /** 前端导航时更新聚焦会话：恢复只重取这一个会话详情，不扫描全部历史。 */
  focusSession = (sessionId?: string): void => {
    this.focusedSessionId = typeof sessionId === 'string' && sessionId ? sessionId : undefined;
  };

  /** 轮询 /v1/product/events；首个监听器立即从 cursor=0 回放有界历史，之后增量跟随。 */
  subscribe = (listener: (event: GatewayEvent) => void): (() => void) => {
    this.eventListeners.add(listener);
    if (!this.polling) {
      this.polling = true;
      // 新的订阅生命周期可以再次提示历史缺口；同一订阅内不会重复。
      this.historyGapNotified = false;
      const generation = this.pollGeneration + 1;
      this.pollGeneration = generation;
      void this.poll(generation);
    }
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.eventListeners.delete(listener);
      if (this.eventListeners.size === 0) this.stopPolling();
    };
  };

  sessions = {
    // GET /v1/product/sessions?mode=&text=&projectId=&cursor=&limit=
    // 后台单页上限 100，但产品启动/其他调用会请求 500。这里按请求 limit 串行取多页，
    // 保留过滤条件与后端不透明 nextCursor；绝不改写前端的请求，也不放宽后台校验。
    list: async (query: { mode?: AppMode; text?: string; projectId?: string; cursor?: string; limit?: number }): Promise<Page<SessionSummary>> => {
      const direct = (): Promise<Page<SessionSummary>> =>
        this.request('GET', '/sessions' + queryString({ mode: query.mode, text: query.text, projectId: query.projectId, cursor: query.cursor, limit: query.limit }));
      const requested = query.limit;
      if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested <= 100) return direct();

      const items: SessionSummary[] = [];
      let cursor = query.cursor;
      let nextCursor: string | undefined;
      for (let pageNumber = 1; items.length < requested; pageNumber += 1) {
        if (pageNumber > MAX_SESSION_PAGES) {
          throw new GatewayError('invalid_response', `Session pagination exceeded ${MAX_SESSION_PAGES} pages; narrow the requested limit.`);
        }
        const limit = Math.min(100, requested - items.length);
        const page = await this.request<Page<SessionSummary>>('GET', '/sessions' + queryString({
          mode: query.mode, text: query.text, projectId: query.projectId, cursor, limit,
        }));
        if (!page || typeof page !== 'object' || !Array.isArray(page.items)) {
          throw new GatewayError('invalid_response', 'The product session page did not contain an items array.');
        }
        if (page.nextCursor !== undefined && typeof page.nextCursor !== 'string') {
          throw new GatewayError('invalid_response', 'The product session page had an invalid nextCursor.');
        }
        items.push(...page.items);
        const next = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
        if (!next) return { items };
        if (next === cursor) {
          throw new GatewayError('invalid_response', 'The product session cursor did not advance between pages.');
        }
        cursor = next;
        nextCursor = next;
      }
      return nextCursor ? { items, nextCursor } : { items };
    },
    // GET /v1/product/sessions/:id?before=
    get: (id: string, before?: string): Promise<SessionDetail> =>
      this.request('GET', `/sessions/${encodeURIComponent(id)}` + queryString({ before })),
    // POST /v1/product/sessions/:id/update；reasoningEffort: undefined 表示恢复模型默认档，后台用空字符串表达。
    update: async (id: string, patch: Partial<Pick<SessionSummary, 'title' | 'pinned' | 'permission' | 'modelId' | 'reasoningEffort'>>): Promise<SessionSummary> => {
      const body: Record<string, unknown> = {};
      for (const key of ['title', 'pinned', 'permission', 'modelId', 'reasoningEffort'] as const) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        const value = patch[key];
        if (key === 'reasoningEffort' && value === undefined) {
          body.reasoningEffort = '';
          continue;
        }
        if (value !== undefined) body[key] = value;
      }
      return this.request('POST', `/sessions/${encodeURIComponent(id)}/update`, body);
    },
    // POST /v1/product/sessions/:id/remove
    remove: async (id: string): Promise<void> => {
      await this.request('POST', `/sessions/${encodeURIComponent(id)}/remove`);
    },
    // POST /v1/product/sessions/:id/branch
    branch: (id: string, messageId: string): Promise<SessionSummary> =>
      this.request('POST', `/sessions/${encodeURIComponent(id)}/branch`, { messageId }),
    // POST /v1/product/sessions/:id/promote
    promote: (id: string, goal: { objective: string; acceptance: string[] }): Promise<SessionSummary> =>
      this.request('POST', `/sessions/${encodeURIComponent(id)}/promote`, { objective: goal.objective, acceptance: goal.acceptance }),
  };

  chat = {
    // POST /v1/product/chat/send
    send: (input: SendInput): Promise<{ sessionId: string; messageId: string }> => this.request('POST', '/chat/send', input),
    // POST /v1/product/chat/cancel
    cancel: async (sessionId: string): Promise<void> => {
      await this.request('POST', '/chat/cancel', { sessionId });
    },
    // POST /v1/product/chat/regenerate
    regenerate: async (sessionId: string, messageId: string): Promise<void> => {
      await this.request('POST', '/chat/regenerate', { sessionId, messageId });
    },
    // POST /v1/product/chat/edit
    edit: async (sessionId: string, messageId: string, text: string): Promise<void> => {
      await this.request('POST', '/chat/edit', { sessionId, messageId, text });
    },
    // POST /v1/product/chat/side-ask
    sideAsk: (input: SideAskInput): Promise<SideAnswer> => this.request('POST', '/chat/side-ask', input),
    sideHistory: (input: { sessionId?: string; sideSessionId?: string; before?: string }): Promise<SideHistory> => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, value);
      return this.request('GET', '/chat/side-history' + (query.size ? '?' + query.toString() : ''));
    },
    sideCancel: (input: { sessionId?: string; sideSessionId: string }): Promise<void> => this.request('POST', '/chat/side-cancel', input),
    sideClear: (input: { sessionId?: string; sideSessionId: string }): Promise<void> => this.request('POST', '/chat/side-clear', input),
  };

  web = {
    // POST /v1/product/web/fetch —— Page.status 是来源页自身的 HTTP 状态，原样透传，不按后台 200 改写。
    fetch: (url: string): Promise<WebPage> => this.request('POST', '/web/fetch', { url }),
    // POST /v1/product/web/search —— 结果附 provider 的 source 标签，原样透传。
    search: (query: string): Promise<WebSearchResult[]> => this.request('POST', '/web/search', { query }),
  };

  approvals = {
    // GET /v1/product/approvals?sessionId=
    pending: (sessionId?: string): Promise<ApprovalRequest[]> =>
      this.request('GET', '/approvals' + queryString({ sessionId })),
    // POST /v1/product/approvals/decide
    decide: async (approvalId: string, decision: ApprovalDecision): Promise<void> => {
      const body: Record<string, unknown> = { approvalId, approved: decision.approved, scope: decision.scope };
      if (decision.note !== undefined) body.note = decision.note;
      if (decision.expectedIntentDigest !== undefined) body.expectedIntentDigest = decision.expectedIntentDigest;
      if (decision.expectedConflictFingerprint !== undefined) body.expectedConflictFingerprint = decision.expectedConflictFingerprint;
      await this.request('POST', '/approvals/decide', body);
    },
  };

  tasks = {
    // GET /v1/product/tasks/:id；后台用 JSON null 表示不存在。
    get: async (id: string): Promise<TaskDetail | undefined> => {
      const result = await this.request<TaskDetail | null>('GET', `/tasks/${encodeURIComponent(id)}`);
      return result === null ? undefined : result;
    },
    // POST /v1/product/tasks/:id/control
    control: (taskId: string, action: TaskControl, input?: { expectedRevision?: number; plan?: TaskDetail['planReference'] }): Promise<TaskDetail> =>
      this.request('POST', `/tasks/${encodeURIComponent(taskId)}/control`, { action, ...input }),
  };

  inspector = {
    toolDetail: (sessionId: string, callId: string, section: ToolDetailSection, offset?: number): Promise<ToolDetailPage> =>
      this.request('GET', '/inspector/tool-detail' + queryString({ sessionId, callId, section, offset })),
    // GET /v1/product/inspector/prompt?sessionId=&requestId=
    prompt: (sessionId: string, requestId?: string): Promise<PromptView> =>
      this.request('GET', '/inspector/prompt' + queryString({ sessionId, requestId })),
    // POST /v1/product/inspector/prompt：保存提示词层，Body 只含这四个字段。
    savePrompt: (sessionId: string, partId: string, content: string, scope: 'global' | 'project' | 'session' | 'request'): Promise<PromptView> =>
      this.request('POST', '/inspector/prompt', { sessionId, partId, content, scope }),
    // GET /v1/product/inspector/requests?sessionId=
    requests: (sessionId: string): Promise<RequestRecordView[]> =>
      this.request('GET', '/inspector/requests' + queryString({ sessionId })),
    // POST /v1/product/inspector/replay：body 为编辑后的请求 JSON，mode 决定发送还是分叉。
    replay: (requestId: string, body: unknown, mode: 'send' | 'branch'): Promise<RequestRecordView> =>
      this.request('POST', '/inspector/replay', { requestId, body, mode }),
    // GET /v1/product/inspector/tools?sessionId=
    tools: (sessionId: string): Promise<ToolInventory> =>
      this.request('GET', '/inspector/tools' + queryString({ sessionId })),
    // GET /v1/product/inspector/trace?sessionId=&text=&type=&cursor=
    trace: (sessionId: string, query: { text?: string; type?: string; cursor?: string } = {}): Promise<TraceView> =>
      this.request('GET', '/inspector/trace' + queryString({ sessionId, text: query.text, type: query.type, cursor: query.cursor })),
    // GET /v1/product/inspector/context?sessionId=
    context: (sessionId: string): Promise<ContextView> =>
      this.request('GET', '/inspector/context' + queryString({ sessionId })),
    // GET /v1/product/inspector/recall?sessionId=&sourceId=&offset=
    recall: (sessionId: string, sourceId: string, offset?: number): Promise<RecallPage> =>
      this.request('GET', '/inspector/recall' + queryString({ sessionId, sourceId, offset })),
    // GET /v1/product/inspector/diffs?sessionId=
    diffs: (sessionId: string): Promise<FileDiff[]> =>
      this.request('GET', '/inspector/diffs' + queryString({ sessionId })),
  };

  metrics = {
    // GET /v1/product/metrics/session?sessionId=
    session: (sessionId: string): Promise<MetricsView> =>
      this.request('GET', '/metrics/session' + queryString({ sessionId })),
    // GET /v1/product/metrics/activity?days=
    activity: (days: number): Promise<ActivityDay[]> =>
      this.request('GET', '/metrics/activity' + queryString({ days })),
  };

  workspace = {
    // GET /v1/product/workspace/projects
    projects: (): Promise<ProjectView[]> => this.request('GET', '/workspace/projects'),
    // 桌面原生选择器完成授权登记，再从产品项目列表取真实 ProjectView；绝不从渲染进程 POST 任意路径。
    pickSourceFolder: (): Promise<string | null> => this.desktopCall('select-folder'),
    editProject: (id: string | undefined, name: string, folders: string[]): Promise<ProjectView | null> =>
      this.desktopCall('edit-project', { id, name, folders }),
    addProject: async (): Promise<ProjectView | undefined> => {
      const picked = await this.desktopCall('select-workspace');
      if (picked === null || picked === undefined) return undefined;
      if (typeof picked !== 'string' || !picked.trim()) {
        throw new GatewayError('invalid_response', 'The native workspace picker returned an unexpected response.');
      }
      const projects = await this.request<ProjectView[]>('GET', '/workspace/projects');
      if (!Array.isArray(projects)) throw new GatewayError('invalid_response', 'The product workspace list was not an array.');
      const target = comparablePath(picked);
      const project = projects.find(item => typeof item?.path === 'string' && (item.sourceFolders ?? [item.path]).some(folder => comparablePath(folder) === target));
      if (!project) throw new GatewayError('not_found', `The selected workspace was not registered: ${picked}`);
      return project;
    },
    // POST /v1/product/workspace/projects/:id/remove
    removeProject: async (projectId: string): Promise<void> => {
      await this.request('POST', `/workspace/projects/${encodeURIComponent(projectId)}/remove`);
    },
    // GET /v1/product/workspace/files?projectId=
    files: (projectId: string): Promise<FileNode[]> =>
      this.request('GET', '/workspace/files' + queryString({ projectId })),
    // GET /v1/product/workspace/file?projectId=&path=
    readFile: (projectId: string, path: string): Promise<string> =>
      this.request('GET', '/workspace/file' + queryString({ projectId, path })),
    // POST /v1/product/workspace/file
    writeFile: (projectId: string, path: string, content: string): Promise<{ path: string; bytes: number; savedAt: string }> =>
      this.request('POST', '/workspace/file', { projectId, path, content }),
    // GET /v1/product/workspace/search?projectId=&text=&regex=&caseSensitive=
    search: (projectId: string, query: SearchQuery): Promise<SearchHit[]> =>
      this.request('GET', '/workspace/search' + queryString({
        projectId, text: query.text,
        regex: query.regex === true ? 'true' : undefined,
        caseSensitive: query.caseSensitive === true ? 'true' : undefined,
      })),
    // GET /v1/product/workspace/source-control?projectId=
    sourceControl: (projectId: string): Promise<SourceControlView> =>
      this.request('GET', '/workspace/source-control' + queryString({ projectId })),
    // GET /v1/product/workspace/diff?projectId=&path=
    fileDiff: (projectId: string, path: string): Promise<FileDiff> =>
      this.request('GET', '/workspace/diff' + queryString({ projectId, path })),
    // POST /v1/product/workspace/commit
    commit: (projectId: string, message: string, paths: string[]): Promise<{ commit: string }> =>
      this.request('POST', '/workspace/commit', { projectId, message, paths }),
    // POST /v1/product/workspace/terminal
    terminal: (projectId: string, command: string): Promise<TerminalResult> =>
      this.request('POST', '/workspace/terminal', { projectId, command }),
    // GET /v1/product/workspace/diagnostics?projectId=
    diagnostics: (projectId: string): Promise<Diagnostic[]> =>
      this.request('GET', '/workspace/diagnostics' + queryString({ projectId })),
  };

  settings = {
    // GET /v1/product/settings
    get: (): Promise<Settings> => this.request('GET', '/settings'),
    // POST /v1/product/settings/update：body 就是 patch 本身（不是 {patch}）。
    // 设置页“添加规则”会先插入空 pattern 并立即保存（SettingsView.tsx:136 添加、:106 saveRules）；
    // 后台拒绝空 pattern，这里只过滤掉尚未填写的规则行，其余字段与合法规则原样下发。
    // 界面新建未填写的规则不下发，填写后随下一次保存生效；后端其它校验错误照常抛出，不在这里吞掉。
    update: (patch: DeepPartial<Settings>): Promise<Settings> => {
      const next: DeepPartial<Settings> = { ...patch };
      if (patch.rules !== undefined) next.rules = patch.rules.filter(rule => rule.pattern.trim() !== '');
      return this.request('POST', '/settings/update', next);
    },
    // GET /v1/product/models
    models: (): Promise<ModelProfile[]> => this.request('GET', '/models'),
    // POST /v1/product/models/save
    discoverModels: (input: import('./types').DiscoveryInput): Promise<import('./types').DiscoveredModel[]> => this.request('POST', '/models/discover', input),
    saveModel: (input: ModelProfileInput): Promise<ModelProfile> => input.baseUrl || input.wire ? this.desktopCall('configure-model', input) : this.request('POST', '/models/save', input),
    // POST /v1/product/models/:id/remove
    removeModel: async (modelId: string): Promise<void> => {
      await this.request('POST', `/models/${encodeURIComponent(modelId)}/remove`);
    },
    // POST /v1/product/models/:id/test；ok:false 是正常结果，不能抛错。
    testModel: (modelId: string): Promise<{ ok: boolean; latencyMs?: number; message: string }> =>
      this.request('POST', `/models/${encodeURIComponent(modelId)}/test`),
    // GET /v1/product/settings/mcp
    mcp: (): Promise<McpServerView[]> => this.request('GET', '/settings/mcp'),
    mcpCatalog: (id: string, offset = 0): Promise<import('./types').McpReadCatalog> => this.request('GET', `/settings/mcp/${encodeURIComponent(id)}/catalog?offset=${offset}`),
    // POST /v1/product/settings/mcp/save：approvedDigest 只透传调用方显式传入的值，绝不自动生成、回填或
    // 用后台返回的 digest 再保存。未批准时后台返回 200 {status:'disconnected', error, digest} 是正常数据，
    // 原样返回，不抛错、不改写成 connected、不自动重发。
    saveMcp: (input: McpServerInput): Promise<McpServerView> => this.request('POST', '/settings/mcp/save', input),
    // POST /v1/product/settings/mcp/:id/remove
    removeMcp: async (serverId: string): Promise<void> => {
      await this.request('POST', `/settings/mcp/${encodeURIComponent(serverId)}/remove`);
    },
    // POST /v1/product/settings/mcp/:id/reconnect；不带审批参数：后台只使用已持久化的批准。
    reconnectMcp: (serverId: string): Promise<McpServerView> =>
      this.request('POST', `/settings/mcp/${encodeURIComponent(serverId)}/reconnect`),
    // GET /v1/product/settings/instructions
    instructions: (): Promise<InstructionFileView[]> => this.request('GET', '/settings/instructions'),
    // GET /v1/product/settings/plugins
    plugins: (): Promise<PluginView[]> => this.request('GET', '/settings/plugins'),
    // GET /v1/product/settings/skills
    skills: (): Promise<SkillView[]> => this.request('GET', '/settings/skills'),
    // POST /v1/product/settings/skills/:id/toggle
    toggleSkill: (skillId: string, enabled: boolean): Promise<SkillView> =>
      this.request('POST', `/settings/skills/${encodeURIComponent(skillId)}/toggle`, { enabled }),
    // POST /v1/product/settings/clear-history：后台要求对象 body（拒绝未知字段），传空对象。
    clearHistory: async (): Promise<void> => {
      await this.request('POST', '/settings/clear-history', {});
    },
  };

  desktop = {
    // 原生 pick-files（最多 5 项元数据，取消 []）已在主树实现并通过 15/15，仍待主树原生验收。
    droppedFiles: async (files: File[]): Promise<Attachment[]> => {
      if (!this.npn.droppedFiles) throw new Error('桌面桥接不支持拖放，请使用添加附件。');
      return this.npn.droppedFiles(files);
    },
    pickFiles: async (): Promise<Attachment[]> => {
      const result = await this.desktopCall('pick-files');
      if (result === null || result === undefined) return [];
      if (!Array.isArray(result)) throw new GatewayError('invalid_response', 'The native file picker returned an unexpected response.');
      return result as Attachment[];
    },
    // desktop('open-ide')：有 projectId 时先解析登记路径；取消不是错误。
    officeFile: (input: { sessionId: string; messageId: string; format: 'docx' | 'xlsx' | 'pptx' | 'pdf'; text?: string; open?: boolean }): Promise<string> => this.desktopCall('office-file', input),
    openIde: async (projectId?: string): Promise<void> => {
      if (projectId === undefined) {
        await this.desktopCall('open-ide');
        return;
      }
      const projects = await this.request<ProjectView[]>('GET', '/workspace/projects');
      const project = Array.isArray(projects) ? projects.find(item => item.id === projectId) : undefined;
      if (!project) throw new GatewayError('not_found', `Unknown project: ${projectId}`);
      const result = await this.desktopCall('open-ide', { workspace: project.path });
      if (result && typeof result === 'object' && (result as { cancelled?: unknown }).cancelled === true) return;
    },
    // desktop('copy-text')
    copyText: async (text: string): Promise<void> => {
      await this.desktopCall('copy-text', { text });
    },
    // desktop('open-data')
    openDataFolder: async (): Promise<void> => {
      await this.desktopCall('open-data');
    },
    // desktop('version')：原生返回 {version,...}，契约只暴露版本字符串。
    version: async (): Promise<string> => {
      const result = await this.desktopCall('version');
      if (result && typeof result === 'object') {
        const version = (result as { version?: unknown }).version;
        if (typeof version === 'string' && version) return version;
      }
      throw new GatewayError('invalid_response', 'The desktop version response did not contain a version string.');
    },
  };

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: unknown;
    try {
      response = await this.npn.request(method, PREFIX + path, body);
    } catch (error) {
      throw transportError(error);
    }
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      const status = (response as Record<string, unknown>).httpStatus;
      if (typeof status === 'number' && status >= 400) throw httpError(response as Record<string, unknown>, status);
    }
    return response as T;
  }

  private async desktopCall(action: string, payload?: unknown): Promise<any> {
    try {
      return payload === undefined ? await this.npn.desktop(action) : await this.npn.desktop(action, payload);
    } catch (error) {
      throw desktopError(error);
    }
  }

  /** 用户提供的 onStreamError 自己抛错也不能打断轮询；只记录，不改变流状态。 */
  private reportStreamError(error: GatewayError): void {
    try {
      this.onStreamError(error);
    } catch (callbackError) {
      try {
        console.error('[bridge] event stream error handler failed:', callbackError);
      } catch {
        // 日志本身失败也不能让轮询永久停摆。
      }
    }
  }

  /** 只在状态翻转时通知界面，避免每个轮询周期重复弹断线。 */
  private reportStreamDown(message: string): void {
    this.streamDownMessage = message;
    if (this.streamDown) return;
    this.streamDown = true;
    const base: ConnectionInfo = this.lastConnection ?? { status: 'online', demo: false };
    this.dispatch({ type: 'connection.changed', connection: { ...base, status: 'offline', demo: false, message } });
  }

  private reportStreamUp(): void {
    if (!this.streamDown) return;
    this.streamDown = false;
    this.streamDownMessage = null;
    const base: ConnectionInfo = this.lastConnection ?? { status: 'online', demo: false };
    this.dispatch({ type: 'connection.changed', connection: { ...base, status: 'online', demo: false, message: '实时事件流已恢复。' } });
  }

  /**
   * 日志被截断不等于状态恢复：已删除会话、已解决审批等变化可能只存在于被丢弃的历史里。
   * 现有 GatewayEvent 没有快照重同步语义，因此只能明确告知用户状态可能不完整，不能假装追平。
   * 同一次订阅内只提示一次，避免每次重连都弹窗。
   */
  private notifyHistoryGap(): void {
    if (this.historyGapNotified) return;
    this.historyGapNotified = true;
    this.dispatch({
      type: 'notify',
      tone: 'warn',
      title: '事件历史已截断',
      detail: '实时事件历史已被重置，删除的会话、已解决的审批或被截断的消息可能不在剩余日志中；当前界面状态可能不完整，需要快照重同步。',
    });
  }

  private stopPolling(): void {
    this.polling = false;
    this.pollGeneration += 1;
    this.retryDelayMs = null;
    if (this.pollTimer !== null) {
      this.timers.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private active(generation: number): boolean {
    return this.polling && generation === this.pollGeneration && this.eventListeners.size > 0;
  }

  private async poll(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    let delay = this.pollIntervalMs;
    try {
      let immediatePages = 0;
      for (;;) {
        const page = await this.fetchEventPage(this.eventCursor);
        if (!this.active(generation)) return;
        const epochChanged = page.epoch !== undefined && this.eventEpoch !== null && page.epoch !== this.eventEpoch;
        if (page.reset || epochChanged) {
          // 历史被重置或数据源被替换：旧游标不再可信，绝不能按旧游标继续装作追平。
          if (page.epoch === undefined) {
            // 旧后端没有 epoch：保持原有行为（先标记在线再处理重置），只能明确告知状态可能不完整。
            this.retryDelayMs = null;
            this.reportStreamUp();
            this.reportStreamError(new GatewayError('events_reset',
              'The product event history was reset; earlier events may be unavailable.', true));
            this.notifyHistoryGap();
            this.lastEventId = 0;
            this.eventCursor = Math.max(0, page.earliest - 1);
            delay = 0;
            break;
          }
          this.reportStreamError(new GatewayError('events_reset',
            epochChanged ? 'The product event store was replaced; earlier events are not applicable to the new state.' : 'The product event history was reset; earlier events may be unavailable.', true));
          const recovery = await this.recover(generation);
          if (!this.active(generation)) return;
          if (recovery === 'legacy') {
            // 后端没有 /snapshot（旧版本）：退回有界回放并保留明确的缺口提示。
            this.notifyHistoryGap();
            this.lastEventId = 0;
            this.eventCursor = Math.max(0, page.earliest - 1);
            this.retryDelayMs = null;
            this.reportStreamUp();
            delay = 0;
            break;
          }
          if (recovery === 'failed') {
            delay = this.retryDelayMs ?? this.pollIntervalMs;
            break;
          }
          // 快照成功：先重建状态（state.snapshot 已在 recover 内派发），再报告恢复在线。
          this.retryDelayMs = null;
          this.reportStreamUp();
          delay = 0;
          continue;
        }
        this.retryDelayMs = null;
        this.reportStreamUp();
        if (page.epoch !== undefined && this.eventEpoch === null) this.eventEpoch = page.epoch;
        for (const entry of page.events) {
          if (!this.active(generation)) return;
          if (!Number.isSafeInteger(entry.id) || entry.id <= this.lastEventId) continue;
          this.lastEventId = entry.id;
          this.dispatch(entry.event);
        }
        this.eventCursor = page.nextCursor;
        if (page.events.length < this.eventPageSize) {
          // Held reads renew immediately; older backends retain the bounded polling interval.
          delay = page.longPoll ? 0 : this.pollIntervalMs;
          break;
        }
        immediatePages += 1;
        if (immediatePages >= MAX_CATCH_UP_PAGES) {
          // 追平预算用完：回到正常间隔，避免在持续积压时变成无间隔热循环。
          delay = this.pollIntervalMs;
          break;
        }
        delay = 0;
      }
    } catch (error) {
      if (!this.active(generation)) return;
      const failure = error instanceof GatewayError ? error : new GatewayError('transport_error', messageOf(error), true);
      this.reportStreamError(failure);
      this.reportStreamDown(failure.message);
      delay = this.backoffDelay();
    }
    if (!this.active(generation)) return;
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = null;
      void this.poll(generation);
    }, delay);
  }

  private async fetchEventPage(cursor: number): Promise<EventPage> {
    const result = await this.request<unknown>('GET', '/events' + queryString({ cursor, limit: this.eventPageSize, waitMs: 15000 }));
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new GatewayError('invalid_response', 'The product event page was not an object.');
    }
    const record = result as Record<string, unknown>;
    if (!Array.isArray(record.events)) throw new GatewayError('invalid_response', 'The product event page did not contain an events array.');
    const events = record.events.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new GatewayError('invalid_response', `The product event at index ${index} was invalid.`);
      }
      const item = entry as Record<string, unknown>;
      if (!Number.isSafeInteger(item.id) || (item.id as number) < 0) {
        throw new GatewayError('invalid_response', `The product event at index ${index} had an invalid id.`);
      }
      if (!item.event || typeof item.event !== 'object') {
        throw new GatewayError('invalid_response', `The product event at index ${index} had an invalid payload.`);
      }
      return { id: item.id as number, event: item.event as GatewayEvent };
    });
    if (!Number.isSafeInteger(record.nextCursor) || (record.nextCursor as number) < 0) {
      throw new GatewayError('invalid_response', 'The product event page had an invalid nextCursor.');
    }
    if (!Number.isSafeInteger(record.earliest) || (record.earliest as number) < 0) {
      throw new GatewayError('invalid_response', 'The product event page had an invalid earliest id.');
    }
    if (typeof record.reset !== 'boolean') throw new GatewayError('invalid_response', 'The product event page had an invalid reset flag.');
    if (record.epoch !== undefined && (typeof record.epoch !== 'string' || !record.epoch)) {
      throw new GatewayError('invalid_response', 'The product event page had an invalid epoch.');
    }
    return {
      events, nextCursor: record.nextCursor as number, earliest: record.earliest as number, reset: record.reset,
      ...(record.epoch !== undefined ? { epoch: record.epoch as string } : {}),
      ...(record.longPoll === true ? { longPoll: true } : {}),
    };
  }

  private backoffDelay(): number {
    const base = this.pollIntervalMs;
    const next = this.retryDelayMs === null ? base : Math.min(Math.max(base, this.retryDelayMs * 2), MAX_RETRY_DELAY_MS);
    this.retryDelayMs = next;
    return next;
  }

  private reportRecoveryFailure(error: GatewayError): void {
    const message = `状态快照恢复失败：${error.message}`;
    this.reportStreamError(new GatewayError('state_snapshot_failed', message, true));
    this.reportStreamDown(message);
    this.backoffDelay();
  }

  /**
   * 有界快照恢复：用一次完整状态重建代替历史回放。
   * 请求量有固定上限：1 次 /snapshot + 最多 4 次会话补页（最多 500 个会话）。
   * 恢复期间到达的新事件 id 必然大于 snapshot.cursor；本轮恢复后从该水位继续增量，不会丢失也不会重放旧状态。
   */
  private async recover(generation: number): Promise<'snapshot' | 'legacy' | 'failed'> {
    let raw: unknown;
    try {
      raw = await this.request<unknown>('GET', '/snapshot' + queryString({ sessionId: this.focusedSessionId, limit: SNAPSHOT_PAGE_LIMIT }));
    } catch (error) {
      const failure = error instanceof GatewayError ? error : transportError(error);
      // 旧后端没有 /snapshot：保持兼容，退回有界回放并保留明确的缺口提示。
      if (failure.code === 'not_found' || failure.code === 'unsupported' || failure.code === 'not_wired') return 'legacy';
      this.reportRecoveryFailure(failure);
      return 'failed';
    }
    let snapshot: StateSnapshot;
    const items: SessionSummary[] = [];
    let nextCursor: string | undefined;
    try {
      snapshot = this.parseSnapshot(raw);
      items.push(...snapshot.sessions.items);
      nextCursor = snapshot.sessions.nextCursor;
      let pages = 1;
      while (nextCursor && pages < MAX_SNAPSHOT_SESSION_PAGES) {
        const page = await this.request<unknown>('GET', '/sessions' + queryString({ cursor: nextCursor, limit: SNAPSHOT_PAGE_LIMIT }));
        if (!this.active(generation)) return 'failed';
        const parsed = this.parseSessionPage(page, nextCursor);
        items.push(...parsed.items);
        nextCursor = parsed.nextCursor;
        pages += 1;
      }
    } catch (error) {
      this.reportRecoveryFailure(error instanceof GatewayError ? error : transportError(error));
      return 'failed';
    }
    if (!this.active(generation)) return 'failed';
    this.eventEpoch = snapshot.epoch;
    this.eventCursor = snapshot.cursor;
    this.lastEventId = snapshot.cursor;
    const recovered: StateSnapshot = { ...snapshot, sessions: { items, ...(nextCursor ? { nextCursor } : {}) } };
    this.dispatch({ type: 'state.snapshot', snapshot: recovered });
    this.dispatch({ type: 'notify', tone: 'info', title: '状态已重新同步', detail: '事件历史被截断或后端数据已替换；已按当前快照重建会话、审批与聚焦会话，恢复期间的新事件会继续送达。' });
    return 'snapshot';
  }

  private parseSnapshot(result: unknown): StateSnapshot {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new GatewayError('invalid_response', 'The product state snapshot was not an object.');
    const record = result as Record<string, unknown>;
    if (!Number.isSafeInteger(record.cursor) || (record.cursor as number) < 0) throw new GatewayError('invalid_response', 'The product state snapshot had an invalid cursor.');
    if (typeof record.epoch !== 'string' || !record.epoch) throw new GatewayError('invalid_response', 'The product state snapshot had an invalid epoch.');
    if (!record.sessions || typeof record.sessions !== 'object' || Array.isArray(record.sessions)) throw new GatewayError('invalid_response', 'The product state snapshot did not contain sessions.');
    const page = record.sessions as Record<string, unknown>;
    if (!Array.isArray(page.items) || page.items.length > SNAPSHOT_PAGE_LIMIT) throw new GatewayError('invalid_response', 'The product state snapshot had an invalid session page.');
    const items = page.items.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof (entry as Record<string, unknown>).id !== 'string' || !(entry as Record<string, unknown>).id) {
        throw new GatewayError('invalid_response', `The product state snapshot session at index ${index} was invalid.`);
      }
      return entry as SessionSummary;
    });
    if (page.nextCursor !== undefined && (typeof page.nextCursor !== 'string' || !page.nextCursor)) throw new GatewayError('invalid_response', 'The product state snapshot had an invalid session cursor.');
    if (!Array.isArray(record.approvals) || record.approvals.length > MAX_SNAPSHOT_APPROVALS) throw new GatewayError('invalid_response', 'The product state snapshot had an invalid approvals list.');
    const approvals = record.approvals.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof (entry as Record<string, unknown>).id !== 'string' || !(entry as Record<string, unknown>).id) {
        throw new GatewayError('invalid_response', `The product state snapshot approval at index ${index} was invalid.`);
      }
      return entry as ApprovalRequest;
    });
    if (record.sessionId !== undefined && (typeof record.sessionId !== 'string' || !record.sessionId)) throw new GatewayError('invalid_response', 'The product state snapshot had an invalid focused session id.');
    if (record.session !== undefined && record.session !== null) {
      const session = record.session;
      if (typeof session !== 'object' || Array.isArray(session)) throw new GatewayError('invalid_response', 'The product state snapshot had an invalid session detail.');
      const detail = session as Record<string, unknown>;
      if (typeof detail.id !== 'string' || !detail.id || !Array.isArray(detail.messages)) throw new GatewayError('invalid_response', 'The product state snapshot had an invalid session detail.');
    }
    if (record.task !== undefined && (!record.task || typeof record.task !== 'object' || Array.isArray(record.task))) throw new GatewayError('invalid_response', 'The product state snapshot had an invalid task detail.');
    if (record.metrics !== undefined && (!record.metrics || typeof record.metrics !== 'object' || Array.isArray(record.metrics))) throw new GatewayError('invalid_response', 'The product state snapshot had invalid metrics.');
    return {
      cursor: record.cursor as number,
      epoch: record.epoch,
      sessions: { items, ...(page.nextCursor ? { nextCursor: page.nextCursor as string } : {}) },
      approvals,
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId as string } : {}),
      ...(record.session !== undefined ? { session: record.session as SessionDetail | null } : {}),
      ...(record.task !== undefined ? { task: record.task as TaskDetail } : {}),
      ...(record.metrics !== undefined ? { metrics: record.metrics as MetricsView } : {}),
    };
  }

  private parseSessionPage(result: unknown, previousCursor: string): { items: SessionSummary[]; nextCursor?: string } {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new GatewayError('invalid_response', 'The product session page during snapshot recovery was not an object.');
    const record = result as Record<string, unknown>;
    if (!Array.isArray(record.items) || record.items.length > SNAPSHOT_PAGE_LIMIT) throw new GatewayError('invalid_response', 'The product session page during snapshot recovery was invalid.');
    const items = record.items.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof (entry as Record<string, unknown>).id !== 'string' || !(entry as Record<string, unknown>).id) {
        throw new GatewayError('invalid_response', `The product session page during snapshot recovery had an invalid item at index ${index}.`);
      }
      return entry as SessionSummary;
    });
    if (record.nextCursor !== undefined && (typeof record.nextCursor !== 'string' || !record.nextCursor)) throw new GatewayError('invalid_response', 'The product session page during snapshot recovery had an invalid cursor.');
    if (record.nextCursor === previousCursor) throw new GatewayError('invalid_response', 'The product session cursor did not advance during snapshot recovery.');
    return { items, ...(record.nextCursor ? { nextCursor: record.nextCursor as string } : {}) };
  }
  private dispatch(event: GatewayEvent): void {
    for (const listener of [...this.eventListeners]) {
      if (!this.eventListeners.has(listener)) continue;
      try {
        listener(event);
      } catch (error) {
        this.reportStreamError(new GatewayError('listener_error', messageOf(error), false));
      }
    }
  }
}
