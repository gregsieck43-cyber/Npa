export type TaskStatus = 'queued' | 'running' | 'waiting_approval' | 'waiting_input' | 'waiting_children' | 'paused' | 'reconciling' | 'completed' | 'failed' | 'cancelled';
export type AgentRole = 'main' | 'side' | 'worker' | 'reviewer';
/** Four operator-selected Work permission modes. The kernel decision table must equal src/frontend/api/policy.ts. */
export type PermissionMode = 'read-only' | 'ask' | 'auto-review' | 'full-access';
/** Chat is a read-only retrieval surface; work may execute according to its mode. */
export type AppMode = 'chat' | 'work';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type PolicyCapability = 'read' | 'write' | 'exec' | 'network' | 'mcp';
export type PolicyOutcome = 'allow' | 'ask' | 'review' | 'deny';
/** Actual MCP catalog entry frozen at preparation; unavailable content retains identity only. */
export interface McpDefinitionSnapshot {
    serverId: string; toolName: string; digest: string; available: boolean;
    inputSchema?: Record<string, unknown>; description?: string; annotations?: Record<string, unknown>;
}
/** Structured independent-review verdict for one exact tool effect. */
export interface ToolReviewRecord {
    verdict: 'pass' | 'escalate' | 'block';
    reviewer: string;
    reviewerModelId: string;
    requestId?: string;
    risk: RiskLevel;
    reason: string;
    checks: { label: string; ok: boolean }[];
    durationMs: number;
}
export interface GoalContract { objective: string; constraints: string[]; acceptance: string[]; maxModelCalls: number; maxToolCalls?: number; mode: 'collaborative' | 'autonomous'; }
export type ExecutionPhase = 'planning' | 'awaiting_plan_confirmation' | 'executing';
export interface PlanReference { id: string; revision: number; digest: string; goalVersion: number; }
export interface Task { id: string; parentId?: string; title: string; goal: GoalContract; status: TaskStatus; revision: number; goalVersion: number; policyEpoch: number; generation: number; createdAt: string; updatedAt: string; workspace: string; owner: string; result?: string; error?: string; waitingReason?: string; modelCalls: number; permissionMode?: PermissionMode; appMode?: AppMode; executionPhase?: ExecutionPhase; plan?: PlanReference; }
export interface Message { id: string; taskId: string; sessionId: string; role: 'system' | 'user' | 'assistant' | 'tool'; content: string; reasoningContent?: string; displayContent?: string; createdAt: string; toolCallId?: string; toolCalls?: ToolCall[]; requestId?: string; archiveRecall?: boolean;
  /** Latest main user row included in the normal Work request that produced this assistant message. */
  sampledUserCursor?: number;
  /** Last fully presented user row, and the UTF-16 offset into its next user message. */
  sampledUserInput?: { cursor: number; offset: number };
  sampledAuthority?: { generation: number; goalVersion: number };
  /** Runtime feedback can be carried as conversational data but is never fresh operator input. */
  inputOrigin?: 'runtime';
}
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface Event { seq: number; taskId: string; type: string; payload: Record<string, unknown>; createdAt: string; }
export interface Command { commandId: string; type: string; taskId?: string; expectedRevision?: number; origin?: 'operator' | 'model' | 'side'; parameters?: Record<string, unknown>; source?: { surface: 'side'; sessionId: string; userMessageId: string }; }
export interface CommandAck { commandId: string; status: 'accepted' | 'duplicate'; taskId?: string; revision?: number; childTaskId?: string; }
/** The policy snapshot bound to one prepared effect; later approvals must match it. */
export interface IntentAuthorization {
    tool: string;
    mode: PermissionMode;
    appMode: AppMode;
    capability: PolicyCapability;
    risk: RiskLevel;
    decision: PolicyOutcome;
    reason: string;
    workspace: string;
    grantId?: string;
    requiresOperator?: boolean;
    review?: ToolReviewRecord;
}
/**
 * The structured diagnostic of a determinately failed external effect. Only a read-only network
 * tool whose own executor persisted a 'failed' record can ever carry one; unknown outcomes never do.
 */
export interface IntentFailure { code: string; message?: string; tool: string; source: 'network' | 'mcp'; attempts?: unknown[]; at?: string; }
export interface FileClaimConflict { id: string; taskId: string; path: string; mode: 'editing' | 'recent'; ownerEpoch: string; incarnation: string; revision: number }
export interface FileConflictSnapshot { version: 1; paths: string[]; fingerprint: string; conflicts: FileClaimConflict[] }
export interface Intent { id: string; taskId: string; runId: string; toolCallId: string; name: string; arguments: Record<string, unknown>; digest: string; effectKey: string; state: 'prepared' | 'approved' | 'sent' | 'applied' | 'unknown' | 'denied' | 'failed'; generation: number; policyEpoch: number; receipt?: Record<string, unknown>; error?: string; authorization?: IntentAuthorization; resources?: string[]; failure?: IntentFailure; failedAt?: string; fileConflicts?: FileConflictSnapshot; }
export interface Snapshot { tasks: Task[]; selectedTask?: Task; messages: Message[]; events: Event[]; intents: Intent[]; plugins?: unknown[]; health: Record<string, unknown>; }
export interface ProviderConfig { wire?: import("./runtime/provider-wire.js").WireSettings; baseUrl: string; model: string; mode: 'mock' | 'live'; timeoutMs: number; maxOutputTokens: number; maxRequestBytes?: number; supportsDeveloper?: boolean; contextWindowTokens?: number; }
export interface WireMessage { role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'; content: string | null; reasoning_content?: string; tool_call_id?: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; }
export interface ModelUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } }
export interface ModelResult { content: string; reasoningContent?: string; toolCalls: ToolCall[]; usage?: ModelUsage; finishReason: string; requestId?: string; }
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> }; }
export interface WorkspaceInfo { id: string; path: string; }
export interface NpnBridge { request(method: string, path: string, body?: unknown): Promise<any>; desktop(action: string, payload?: unknown): Promise<any>; }
