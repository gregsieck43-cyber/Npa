/**
 * NPN-Gamma 前端领域类型 —— 前端与后端接线的唯一数据契约。
 * 前端改动需经用户同意（见 ../AGENTS.md）：后端接线时把后台数据转换成这些形状，不要改动这里去迁就后端。
 * 确需新增字段时只允许“追加可选字段”，并同步 ../WIRING.md。
 */

export type AppMode = 'chat' | 'cowork' | 'code';

/**
 * 会话级权限模式。语义（后端必须在执行器层强制，不能只靠提示词）：
 * - read-only   只读：只允许读文件/检索；写入、命令、联网写、MCP 有副作用调用一律拒绝（不弹审批）。
 * - ask         询问：读取自动放行，其余每个有副作用的调用都需人工审批。
 * - auto-review 自动审查：低风险调用自动放行；其余先交给独立审查器给出 pass/escalate/block，escalate 再转人工。
 * - full-access 完全访问：工作区范围内全部放行，不审批；凭据区、工作区外路径、产品数据仍由内核拒绝。
 * 权限模式只作用于 Cowork / Code。Chat 是聊天模式，只暴露读取与联网检索等无副作用工具，不显示权限模式。
 * 关键（critical）操作：ask / full-access 下必须人工确认；auto-review 下交审查器，可直接 block。
 * 完整判定表见 ./policy.ts 的 decide()，后端执行器结果必须与之一致。
 */
export type PermissionMode = 'read-only' | 'ask' | 'auto-review' | 'full-access';
export type Capability = 'read' | 'write' | 'exec' | 'network' | 'mcp';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ConnectionInfo {
  status: 'online' | 'degraded' | 'offline' | 'connecting';
  /** true 表示当前是前端演示网关，界面会常驻“演示数据”标记。 */
  demo: boolean;
  backendVersion?: string;
  latencyMs?: number;
  message?: string;
}

export type ModelInputType = 'text' | 'image' | 'video' | 'pdf';
export type ModelCapability = 'structuredOutput' | 'nativeWebSearch' | 'systemMessageInChat';

export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  /** 发给服务商的模型 ID，例如 z-ai/glm-5.3-flash。 */
  model: string;
  mode: 'mock' | 'live';
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsReasoning?: boolean;
  credentialPresent: boolean;
  remainingLiveRequests?: number;
  /** 智能配置：由后端按模型 ID 推断上下文与输出上限，界面上对应字段只读显示推断值。 */
  autoConfig?: boolean;
  inputTypes?: ModelInputType[];
  capabilities?: ModelCapability[];
  /** 推理等级，按从低到高排列；空数组或缺省表示不支持调节推理强度。 */
  reasoningLevels?: string[];
  /** 推理参数映射模板，{{level}} 会被替换为所选等级，合并进请求 Body。 */
  reasoningMapping?: unknown;
}

/** 新建或编辑模型配置时提交的字段（凭据不经过前端）。 */
export type ModelProfileInput = Omit<ModelProfile, 'id' | 'credentialPresent' | 'remainingLiveRequests'> & { id?: string };

export type SessionStatus = 'idle' | 'streaming' | 'waiting_approval' | 'waiting_input' | 'running' | 'paused' | 'failed' | 'completed';

export interface SessionSummary {
  id: string;
  mode: AppMode;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  /** Chat 模式不使用权限模式：只暴露无副作用的读取/检索工具。 */
  permission: PermissionMode;
  modelId: string;
  /** 所选推理等级，取值来自模型的 reasoningLevels；缺省为模型默认。 */
  reasoningEffort?: string;
  projectId?: string;
  pinned?: boolean;
  preview?: string;
  unread?: boolean;
  /** Chat 升级为 Cowork 时指向原会话。 */
  parentSessionId?: string;
  peers?: { count: number; labels: string[] };
}

export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  /** Exclusive persisted-message cursor for the preceding page. */
  beforeCursor?: string;
  task?: TaskDetail;
}

export interface TokenUsage {
  input: number;
  output: number;
  cached?: number;
  reasoning?: number;
}

export interface Attachment {
  id: string;
  name: string;
  kind: 'file' | 'image' | 'folder' | 'selection';
  bytes?: number;
  path?: string;
}

export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; durationMs?: number }
  | { kind: 'tool'; call: ToolCallView }
  | { kind: 'notice'; tone: 'info' | 'warn' | 'error' | 'success'; text: string };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  createdAt: string;
  status: 'streaming' | 'done' | 'error' | 'cancelled';
  parts: MessagePart[];
  requestId?: string;
  model?: string;
  usage?: TokenUsage;
  durationMs?: number;
  attachments?: Attachment[];
  error?: { code: string; message: string };
}

export type ToolStatus =
  | 'pending' | 'awaiting_approval' | 'reviewing' | 'running'
  | 'succeeded' | 'failed' | 'denied' | 'blocked' | 'cancelled' | 'unknown';

/** 失败阶段必须分开呈现，不能统一成“工具失败”。 */
export type FailureStage = 'unknown_tool' | 'permission' | 'validation' | 'execution' | 'reconciliation' | 'context';

export type ToolResult =
  | { kind: 'text'; text: string }
  | { kind: 'json'; value: unknown }
  | { kind: 'terminal'; command: string; exitCode: number; output: string }
  | { kind: 'files'; files: { path: string; detail?: string }[] }
  | { kind: 'diff'; diff: FileDiff };

export interface ReviewVerdict {
  reviewer: string;
  verdict: 'pass' | 'escalate' | 'block';
  risk: RiskLevel;
  reason: string;
  checks: { label: string; ok: boolean }[];
  durationMs: number;
}

export interface ToolCallView {
  id: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  toolCallId?: string;
  /** Persisted parent request; not a guessed parent tool call. */
  parentRequestId?: string;
  name: string;
  /** 给人看的一句话，例如“读取 src/app.ts”。 */
  title: string;
  source: 'builtin' | 'mcp' | 'plugin' | 'subagent';
  capability: Capability;
  risk: RiskLevel;
  args: Record<string, unknown>;
  status: ToolStatus;
  requestId?: string;
  startedAt?: string;
  durationMs?: number;
  retries?: number;
  result?: ToolResult;
  error?: { stage: FailureStage; message: string };
  approvalId?: string;
  review?: ReviewVerdict;
  /** 结果进入了哪一次后续模型请求；缺失且已成功即“结果未进入后续请求”。 */
  receivedByRequestId?: string;
  children?: ToolCallView[];
}

export type ToolDetailSection = 'schema' | 'description' | 'arguments' | 'result' | 'mcpDefinition';
/** One redacted slice of one persisted call; lists never inline the full payload. */
export interface ToolDetailPage {
  callId: string;
  section: ToolDetailSection;
  available: boolean;
  reason?: string;
  text: string;
  offset: number;
  totalChars: number;
  sha256: string;
  nextOffset?: number;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolCallId: string;
  title: string;
  reason: string;
  capability: Capability;
  risk: RiskLevel;
  /** 将要执行的内容：命令、补丁或参数摘要。 */
  preview: string;
  previewKind: 'command' | 'diff' | 'json' | 'text';
  /** 审批绑定的意图摘要；后端用它拒绝过期审批。 */
  digest: string;
  /** Empty when the historical prepared event is missing; createdAtKnown then reports false. */
  createdAt: string;
  /** False when createdAt is unknown (legacy event-missing row); absent fields keep old behavior. */
  createdAtKnown?: boolean;
  review?: ReviewVerdict;
  conflict?: { fingerprint: string; participants: { taskId: string; path: string; mode: 'editing' | 'recent' }[] };
}

export type ApprovalDecision = { approved: boolean; scope: 'once' | 'session'; note?: string; expectedIntentDigest?: string; expectedConflictFingerprint?: string };

export interface CoordinationParticipant { id: string; workspace: string; title: string; objective: string; status: string; activation: number; generation: number; policyEpoch: number; heartbeatAt: string; claims?: { paths: string[]; total: number } }
export interface ExternalPresenceView { items: { id: string; source: 'external'; advisory: true; label: string; objective: string; claims: string[]; observedAt: string }[]; truncated: boolean; rejected: number; error?: string }
export interface FileClaimView { id: string; taskId: string; path: string; mode: 'editing' | 'recent'; ownerEpoch: string; incarnation: string; revision: number }
export interface CoordinationNotice { id: string; seq: number; kind: string; senderId: string; senderKind: string; payload: unknown; sha256: string; createdAt: string; ackedAt: string | null; operatorSeenAt: string | null }
export interface CoordinationInbox { items: CoordinationNotice[]; through: number; nextCursor?: number }

export type TaskStatus =
  | 'queued' | 'running' | 'waiting_approval' | 'waiting_input' | 'waiting_children'
  | 'paused' | 'reconciling' | 'completed' | 'failed' | 'cancelled';

export interface PlanStep {
  id: string;
  title: string;
  status: 'todo' | 'active' | 'done' | 'blocked' | 'skipped';
  detail?: string;
}

export interface SubagentView {
  id: string;
  role: 'worker' | 'reviewer' | 'side';
  title: string;
  status: TaskStatus;
  model: string;
  progress?: number;
  sessionId?: string;
}

export interface CheckpointView {
  id: string;
  label: string;
  createdAt: string;
  messageCount: number;
  digest: string;
}

export interface TaskDetail {
  id: string;
  title: string;
  status: TaskStatus;
  phase: string;
  revision?: number;
  executionPhase?: 'planning' | 'awaiting_plan_confirmation' | 'executing';
  planReference?: { id: string; revision: number; digest: string; goalVersion: number };
  goal: { objective: string; constraints: string[]; acceptance: string[]; mode: 'collaborative' | 'autonomous' };
  plan: PlanStep[];
  budget: { modelCalls: number; maxModelCalls: number; toolCalls: number; maxToolCalls: number; tokens: number };
  checkpoints: CheckpointView[];
  subagents: SubagentView[];
  verification: { status: 'pending' | 'pass' | 'fail' | 'unknown'; items: { label: string; status: 'pending' | 'pass' | 'fail' | 'unknown' }[] };
  startedAt: string;
  updatedAt: string;
  waitingReason?: string;
  retryAt?: string;
}

export type TaskControl = 'pause' | 'resume' | 'cancel' | 'retry' | 'checkpoint' | 'enter_plan' | 'approve_plan';

export interface PromptPart {
  id: string;
  label: string;
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  scope: 'harness' | 'global' | 'project' | 'session' | 'request';
  source: string;
  content: string;
  tokens: number;
  /** false 表示 tokens 是估算值。 */
  tokensExact: boolean;
  effective: boolean;
  /** locked = Harness 执行约束，不可覆盖。 */
  merge: 'append' | 'override' | 'locked';
  editable: boolean;
  overriddenBy?: string;
  version?: number;
}

export interface PromptView {
  requestId?: string;
  parts: PromptPart[];
  totalTokens: number;
  /** true=provider usage, false=estimate; absent=unknown legacy provenance. */
  totalTokensExact?: boolean;
  /** 当前编辑是否已应用到下一次请求。 */
  pendingEdits: number;
}

export interface RequestRecordView {
  id: string;
  /** Immutable saved request identity for historical version comparison. */
  bodyHash?: string;
  profileId?: string;
  recordContent?: boolean;
  kind: 'chat' | 'work' | 'studio' | 'review' | 'side';
  status: 'draft' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  model: string;
  endpoint: string;
  /** 服务商适配后、发送前的真实 Body（已脱敏）。 */
  body: unknown;
  redactions: string[];
  durationMs?: number;
  firstTokenMs?: number;
  usage?: TokenUsage;
  response?: { content: string; finishReason: string; toolCalls?: { name: string; arguments: string }[] };
  error?: { code: string; message: string };
  parentId?: string;
  branchLabel?: string;
}

export interface ToolDefinitionView {
  name: string;
  source: ToolCallView['source'];
  description: string;
  capability: Capability;
  schema: unknown;
}

export interface ToolInventory {
  registered: ToolDefinitionView[];
  allowed: string[];
  exposed: string[];
  calls: ToolCallView[];
}

export type TraceSpanType = 'turn' | 'prompt' | 'context' | 'model' | 'tool' | 'review' | 'approval' | 'checkpoint' | 'task' | 'subagent';

export interface TraceSpan {
  id: string;
  parentId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  sourceParentId?: string;
  childSessionId?: string;
  type: TraceSpanType;
  label: string;
  status: 'ok' | 'error' | 'running' | 'waiting' | 'cancelled';
  /** 相对 TraceView.startedAt 的毫秒偏移。 */
  startMs: number;
  durationMs: number;
  requestId?: string;
  payloadRef?: string;
  attrs?: Record<string, string | number>;
}

export interface TraceView {
  startedAt: string;
  spans: TraceSpan[];
  hasMore: boolean;
  /** 后端原生 trace 游标（不透明）；hasMore 为 true 时返回，下一页严格从该游标之后开始。 */
  nextCursor?: string;
}

export interface ContextSegment {
  id: string;
  label: string;
  kind: 'system' | 'tools' | 'memory' | 'history' | 'files' | 'user' | 'reserve';
  tokens: number;
  items?: { label: string; tokens: number; sourceId?: string; sha?: string }[];
}

export interface ContextView {
  windowTokens: number;
  usedTokens: number;
  segments: ContextSegment[];
  /** 被省略但可回查的原始记录：稳定来源 ID + SHA。 */
  omitted: { sourceId: string; label: string; tokens: number; sha: string }[];
  /**
   * 窗口上限是否可信。false 表示 windowTokens 只是 0 占位、真实窗口未知；
   * 缺省按 true 处理（旧后端兼容）。界面在 false 时显示“未知”，绝不除以 0。
   */
  windowTokensKnown?: boolean;
  /** true 表示 usedTokens 是 token 估算而非服务商真实用量；界面显示时加 ≈ 前缀。 */
  usedTokensEstimated?: boolean;
}

export interface RecallPage {
  sourceId: string;
  sha: string;
  offset: number;
  text: string;
  nextOffset?: number;
}

export interface DiffLine { kind: 'ctx' | 'add' | 'del'; oldNo?: number; newNo?: number; text: string }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface FileDiff {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  toolCallId?: string;
  applied: boolean;
}

export interface ActivityDay {
  date: string;
  events: number;
  modelCalls: number;
  toolEffects: number;
  tasksCreated: number;
  tasksCompleted: number;
}

/** 指标字段的覆盖状态：known=范围内请求都报告；partial=部分报告；unknown=已请求但无任何报告。 */
export type MetricsCoverageState = 'known' | 'partial' | 'unknown';

export interface MetricsFieldCoverage {
  reportedRequests: number;
  totalRequests: number;
  state: MetricsCoverageState;
}

/** 逐字段覆盖：total 的报告数不代表 input/output/cached 也已报告。 */
export interface MetricsUsageCoverage {
  requests: number;
  input: MetricsFieldCoverage;
  output: MetricsFieldCoverage;
  total: MetricsFieldCoverage;
  cached: MetricsFieldCoverage;
  /** 仅同时有可用 prompt 与 cached 的匹配行覆盖；旧后端缺失时回退 cached。 */
  cacheRatio?: MetricsFieldCoverage;
}

export interface MetricsView {
  rounds: number;
  modelSteps: number;
  tokens: TokenUsage;
  toolCalls: number;
  activeTools: number;
  /** 可选：旧后端/演示网关不提供；缺失时界面保持原有显示，tokens 数值按旧契约理解。 */
  usageCoverage?: MetricsUsageCoverage;
  cacheHitRate?: number;
  lastLatencyMs?: number;
  tokensPerSecond?: number;
  contextUsed?: number;
  contextWindow?: number;
}

export interface ProjectView {
  id: string;
  name: string;
  path: string;
  branch?: string;
  lastOpenedAt: string;
  sessions: number;
  changedFiles?: number;
  languages?: { name: string; share: number }[];
}

export interface FileNode {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  children?: FileNode[];
  change?: 'M' | 'A' | 'D';
}

/** IDE：全文搜索命中。line/column 从 1 开始。 */
export interface SearchHit { path: string; line: number; column: number; preview: string; matchLength: number }
export interface SearchQuery { text: string; regex?: boolean; caseSensitive?: boolean }

/** IDE：源代码管理中的一项变更（相对上次提交）。 */
export interface FileChange { path: string; status: 'M' | 'A' | 'D' | 'R' | '?'; additions: number; deletions: number }
export interface SourceControlView { branch: string; ahead: number; behind: number; changes: FileChange[] }

/** IDE：人工终端执行结果。人工终端不经过 Agent 任务与模型，但仍限定在已登记工作区内。 */
export interface TerminalResult { command: string; output: string; exitCode: number; durationMs: number; cwd: string }

export interface Diagnostic { path: string; line: number; column: number; severity: 'error' | 'warning' | 'info'; message: string; source: string }

/** 侧边面板浏览器：后台抓取后的阅读模式页面（含来源与时间）。 */
export interface WebPage {
  url: string; title: string; text: string; fetchedAt: string;
  /** 来源页自身的 HTTP 状态（例如 200/201/206），不是本后台请求的状态。 */
  status: number;
  /** 后台实际请求的 URL；重定向后可能与 url 不同。 */
  requestedUrl?: string;
  /** 来源响应的 Content-Type，便于确认是 HTML/纯文本阅读模式。 */
  contentType?: string;
  /** 抓取内容永远是不可信输入，界面不得当作指令执行。 */
  trust?: 'untrusted';
}
export interface WebSearchResult {
  title: string; url: string; snippet: string;
  /** 搜索来源标签（后台 provider 标签）；旧响应可能没有。 */
  source?: string;
}

/**
 * 侧边聊天有独立的持久历史，可通过后端控制绑定主任务。主任务仍由原执行器运行。
 * messageId 是一次用户输入的幂等标识。history 仅兼容旧调用；新客户端从服务端分页读取。
 */
export interface SideAskInput {
  sessionId?: string;
  sideSessionId?: string;
  messageId?: string;
  question: string;
  attachments: Attachment[];
  modelId: string;
  reasoningEffort?: string;
  history?: { question: string; answer: string }[];
}
export interface SideAnswer { id: string; question: string; answer: string; createdAt: string; attachments?: Attachment[]; modelId?: string; requestId?: string; sideSessionId?: string; targetTaskId?: string; status?: 'running' | 'completed' | 'cancelled' | 'failed'; operations?: { commandId: string; action: string; taskId: string; status: string; revision?: number }[] }
export interface SideHistory { sideSessionId: string; targetTaskId?: string; items: SideAnswer[]; nextCursor?: string }

/** 已加载的指令文件（AGENTS.md 等）。order 为注入顺序，后加载的同作用域内容追加在后。 */
export interface InstructionFileView {
  id: string;
  scope: 'global' | 'project';
  path: string;
  projectId?: string;
  status: 'loaded' | 'missing' | 'error';
  bytes?: number;
  /** 内容摘要；仅 loaded 时存在，用于判断指令是否真的变化。 */
  sha256?: string;
  order: number;
  error?: string;
}

export interface McpServerInput {
  id?: string;
  name: string;
  transport: McpServerView['transport'];
  /** stdio：启动命令（含参数）；http/sse：服务地址。 */
  target: string;
  enabled: boolean;
  /** 仅在操作者已审查并显式批准该精确启动配置（digest）时提供；服务端绝不信任保存动作本身。 */
  approvedDigest?: string;
}

export interface McpReadCatalog {
  serverId: string;
  serverDigest: string;
  offset: number;
  total: number;
  tools: { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; digest: string; chatAllowed: boolean }[];
}

export type ThemePreference = 'light' | 'dark' | 'system';
export type AccentName = 'ember' | 'indigo' | 'jade' | 'violet' | 'ocean';

export interface PermissionRule {
  id: string;
  pattern: string;
  capability: Capability;
  decision: 'allow' | 'ask' | 'deny';
}

export interface Settings {
  appearance: { theme: ThemePreference; accent: AccentName; density: 'comfortable' | 'compact'; motion: 'full' | 'reduced'; fontScale: number; ambient: boolean };
  defaults: { mode: AppMode; permission: PermissionMode; modelId: string; sendKey: 'enter' | 'mod-enter' };
  autoReview: { reviewerModelId: string; escalateAt: RiskLevel; explain: boolean };
  rules: PermissionRule[];
  privacy: { recordContent: boolean; redactSecrets: boolean };
  network: { webSearch: boolean; fetch: boolean; proxy: string };
}

export interface McpServerView {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  status: 'connected' | 'disconnected' | 'error';
  tools: number;
  error?: string;
  /** 启动命令或服务地址；不含凭据。 */
  target?: string;
  enabled?: boolean;
  /** 当前配置的精确启动摘要；连接/重连需要该摘要对应的操作者批准。 */
  digest?: string;
}

export interface PluginView {
  id: string;
  name: string;
  version: string;
  status: 'active' | 'pending_approval' | 'disabled';
  capabilities: Capability[];
  description: string;
}

export interface SkillView {
  id: string;
  name: string;
  description: string;
  source: string;
  enabled: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * 事件日志被截断、后端数据被替换或长时间断线后，前端重建当前状态所需的有界快照。
 * cursor 是快照投影前读到的水位：之后只接受 id>cursor 的增量事件，避免把快照前的旧状态再回放一遍。
 * sessions 只包含第一页（<=100）；nextCursor 存在表示还有更多会话页，前端按原分页契约继续取。
 */
export interface StateSnapshot {
  cursor: number;
  /** 事件日志代际：同一份 product.sqlite 内稳定，数据库被替换/重建后变化。 */
  epoch: string;
  sessions: { items: SessionSummary[]; nextCursor?: string };
  approvals: ApprovalRequest[];
  /** 仅在请求携带聚焦会话时回显；此时 session 是该会话的最新详情（null 表示已被删除）。 */
  sessionId?: string;
  session?: SessionDetail | null;
  task?: TaskDetail;
  metrics?: MetricsView;
}

export interface SendInput {
  sessionId?: string;
  mode: AppMode;
  text: string;
  attachments: Attachment[];
  permission: PermissionMode;
  modelId: string;
  reasoningEffort?: string;
  projectId?: string;
  /** Cowork：先产出计划并等待确认。 */
  planFirst?: boolean;
}

export type GatewayEvent =
  | { type: 'coordination.changed'; sessionId: string; revision: number }
  | { type: 'session.upsert'; session: SessionSummary }
  | { type: 'session.removed'; sessionId: string }
  | { type: 'message.upsert'; sessionId: string; message: ChatMessage }
  | { type: 'approval.requested'; approval: ApprovalRequest }
  | { type: 'approval.resolved'; approvalId: string; approved: boolean }
  | { type: 'task.updated'; sessionId: string; task: TaskDetail }
  | { type: 'metrics.updated'; sessionId: string; metrics: MetricsView }
  | { type: 'state.snapshot'; snapshot: StateSnapshot }
  | { type: 'connection.changed'; connection: ConnectionInfo }
  | { type: 'inspector.invalidated'; sessionId: string }
  | { type: 'notify'; tone: 'info' | 'success' | 'warn' | 'error'; title: string; detail?: string };
