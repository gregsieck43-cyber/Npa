/**
 * NpnGateway —— 前端访问后端的唯一入口。组件只依赖本接口，不直接调用 window.npn。
 * 两个实现：
 *   mock/   演示网关（预览与设计验收，界面常驻“演示数据”标记）
 *   bridge.ts 真实网关（后续后端 Agent 负责实现，映射到 window.npn.request 的 /v1 路由）
 * 约定：
 *   - 所有方法失败时抛出 GatewayError；界面负责呈现，网关不要吞错或返回假成功。
 *   - 写操作返回最新的服务端状态；流式与后台变化一律通过 subscribe 推送 GatewayEvent。
 *   - message.upsert 每次推送完整消息（含已累积文本），前端按 id 替换，无需增量合并协议。
 */
import type {
  ActivityDay, AppMode, ApprovalDecision, Attachment, ApprovalRequest, ConnectionInfo, ContextView, Diagnostic, FileDiff, FileNode, SearchHit, SearchQuery, SourceControlView, TerminalResult,
  GatewayEvent, InstructionFileView, McpServerInput, McpServerView, MetricsView, ModelProfile, ModelProfileInput, Page, PermissionMode, PluginView, ProjectView, PromptView,
  RecallPage, RequestRecordView, SendInput, SideAnswer, SideAskInput, SideHistory, WebPage, WebSearchResult, SessionDetail, SessionSummary, Settings, SkillView, TaskControl, TaskDetail,
  ToolInventory, ToolDetailPage, ToolDetailSection, TraceView,
} from './types';
import type { LibraryGateway } from './library-types';

export class GatewayError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface NpnGateway {
  readonly kind: 'mock' | 'bridge';
  library: LibraryGateway;
  coordination?: {
    claims(query: { sessionId?: string; projectId?: string; after?: string; limit?: number }): Promise<{ items: import('./types').FileClaimView[]; nextCursor?: string }>;
    claim(sessionId: string, paths: string[]): Promise<import('./types').FileClaimView[]>;
    release(sessionId: string, ids: string[]): Promise<void>;
    presence(query: { sessionId?: string; projectId?: string; after?: string; limit?: number }): Promise<{ items: import('./types').CoordinationParticipant[]; nextCursor?: string; external?: import('./types').ExternalPresenceView }>;
    inbox(sessionId: string, query?: { after?: number; through?: number; limit?: number }): Promise<import('./types').CoordinationInbox>;
    send(input: { sessionId: string; to: string; kind: 'evidence' | 'question' | 'result_proposal'; body: string; clientMessageId: string }): Promise<{ id: string }>;
    ack(sessionId: string, noticeIds: string[]): Promise<void>;
  };

  connection(): Promise<ConnectionInfo>;
  subscribe(listener: (event: GatewayEvent) => void): () => void;
  /** 聚焦某个会话：快照恢复时只重取该会话详情与指标；undefined 表示当前没有聚焦会话。可选，网关按需实现。 */
  focusSession?(sessionId?: string): void;

  sessions: {
    list(query: { mode?: AppMode; text?: string; projectId?: string; cursor?: string; limit?: number }): Promise<Page<SessionSummary>>;
    get(id: string, before?: string): Promise<SessionDetail>;
    update(id: string, patch: Partial<Pick<SessionSummary, 'title' | 'pinned' | 'permission' | 'modelId' | 'reasoningEffort'>>): Promise<SessionSummary>;
    remove(id: string): Promise<void>;
    /** 从某条消息分叉出新会话。 */
    branch(id: string, messageId: string): Promise<SessionSummary>;
    /** Chat 升级为 Cowork 长任务。 */
    promote(id: string, goal: { objective: string; acceptance: string[] }): Promise<SessionSummary>;
  };

  chat: {
    /** 创建或续写会话；流式输出通过 message.upsert 事件到达。 */
    send(input: SendInput): Promise<{ sessionId: string; messageId: string }>;
    cancel(sessionId: string): Promise<void>;
    regenerate(sessionId: string, messageId: string): Promise<void>;
    /** 修改一条用户消息并重新发送：丢弃其后的消息，按新内容重新生成。运行中抛 busy。 */
    edit(sessionId: string, messageId: string, text: string): Promise<void>;
    /** 侧边聊天独立持久化，通过主任务 owner 接受操作并返回真实回执。 */
    sideAsk(input: SideAskInput): Promise<SideAnswer>;
    sideHistory(input: { sessionId?: string; sideSessionId?: string; before?: string }): Promise<SideHistory>;
    sideCancel(input: { sessionId?: string; sideSessionId: string }): Promise<void>;
    sideClear(input: { sessionId?: string; sideSessionId: string }): Promise<void>;
  };

  web: {
    /** 抓取网页为阅读模式文本；非 http(s) 地址抛 validation。 */
    fetch(url: string): Promise<WebPage>;
    search(query: string): Promise<WebSearchResult[]>;
  };

  approvals: {
    pending(sessionId?: string): Promise<ApprovalRequest[]>;
    decide(approvalId: string, decision: ApprovalDecision): Promise<void>;
  };

  tasks: {
    get(sessionId: string): Promise<TaskDetail | undefined>;
    control(taskId: string, action: TaskControl, input?: { expectedRevision?: number; plan?: TaskDetail['planReference'] }): Promise<TaskDetail>;
  };

  inspector: {
    prompt(sessionId: string, requestId?: string): Promise<PromptView>;
    savePrompt(sessionId: string, partId: string, content: string, scope: 'global' | 'project' | 'session' | 'request'): Promise<PromptView>;
    requests(sessionId: string): Promise<RequestRecordView[]>;
    /** send=按编辑后的 Body 发送一次有界测试；branch=另存为分叉。默认不重放有副作用的工具。 */
    replay(requestId: string, body: unknown, mode: 'send' | 'branch'): Promise<RequestRecordView>;
    tools(sessionId: string): Promise<ToolInventory>;
    toolDetail(sessionId: string, callId: string, section: ToolDetailSection, offset?: number): Promise<ToolDetailPage>;
    trace(sessionId: string, query?: { text?: string; type?: string; cursor?: string }): Promise<TraceView>;
    context(sessionId: string): Promise<ContextView>;
    /** 按稳定来源 ID 分页回查被省略的原始记录（可回溯上下文）。 */
    recall(sessionId: string, sourceId: string, offset?: number): Promise<RecallPage>;
    diffs(sessionId: string): Promise<FileDiff[]>;
  };

  metrics: {
    session(sessionId: string): Promise<MetricsView>;
    activity(days: number): Promise<ActivityDay[]>;
  };

  workspace: {
    projects(): Promise<ProjectView[]>;
    /** 打开系统目录选择器并登记项目；用户取消返回 undefined。 */
    addProject(): Promise<ProjectView | undefined>;
    /** 取消登记：只移除登记记录，不删除磁盘上的任何文件；已有会话保留但不再关联该项目。 */
    removeProject(projectId: string): Promise<void>;
    files(projectId: string): Promise<FileNode[]>;
    readFile(projectId: string, path: string): Promise<string>;
    /** IDE 人工保存：不创建 Agent 任务、不调用模型；路径越界由后端拒绝。 */
    writeFile(projectId: string, path: string, content: string): Promise<{ path: string; bytes: number; savedAt: string }>;
    search(projectId: string, query: SearchQuery): Promise<SearchHit[]>;
    sourceControl(projectId: string): Promise<SourceControlView>;
    fileDiff(projectId: string, path: string): Promise<FileDiff>;
    commit(projectId: string, message: string, paths: string[]): Promise<{ commit: string }>;
    /** IDE 人工终端，cwd 固定为项目根。 */
    terminal(projectId: string, command: string): Promise<TerminalResult>;
    diagnostics(projectId: string): Promise<Diagnostic[]>;
  };

  settings: {
    get(): Promise<Settings>;
    update(patch: DeepPartial<Settings>): Promise<Settings>;
    models(): Promise<ModelProfile[]>;
    /** 新建（无 id）或更新模型配置，返回保存后的完整配置。 */
    saveModel(input: ModelProfileInput): Promise<ModelProfile>;
    removeModel(modelId: string): Promise<void>;
    testModel(modelId: string): Promise<{ ok: boolean; latencyMs?: number; message: string }>;
    mcp(): Promise<McpServerView[]>;
    /** 新建（无 id）或更新 MCP 服务器配置；保存后后台尝试连接，返回最新状态。 */
    saveMcp(input: McpServerInput): Promise<McpServerView>;
    removeMcp(id: string): Promise<void>;
    reconnectMcp(id: string): Promise<McpServerView>;
    mcpCatalog(id: string, offset?: number): Promise<import('./types').McpReadCatalog>;
    /** 全局与各项目的指令文件及加载结果。 */
    instructions(): Promise<InstructionFileView[]>;
    plugins(): Promise<PluginView[]>;
    skills(): Promise<SkillView[]>;
    toggleSkill(id: string, enabled: boolean): Promise<SkillView>;
    clearHistory(): Promise<void>;
  };

  desktop: {
    /** 打开系统文件选择器，返回可附加到消息的附件；用户取消返回空数组。 */
    pickFiles(): Promise<Attachment[]>;
    openIde(projectId?: string): Promise<void>;
    copyText(text: string): Promise<void>;
    openDataFolder(): Promise<void>;
    version(): Promise<string>;
  };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export const permissionOrder: PermissionMode[] = ['read-only', 'ask', 'auto-review', 'full-access'];
