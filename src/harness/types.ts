import type { ModelResult, ProviderConfig, ToolCall, ToolReviewRecord, McpDefinitionSnapshot } from '../contracts.js';

export type RequestBody = Record<string, any>;
export interface ChatCapabilities { web: boolean; tools: boolean; mcp: boolean; skills: boolean; projectInstructions: boolean }
export interface ChatSession {
  id: string; title: string; createdAt: string; updatedAt: string; workspace?: string; profileId: string;
  systemPrompt: string; developerPrompt: string; parameters: RequestBody; capabilities: ChatCapabilities;
  parentSessionId?: string; branchMessageId?: string; workTaskId?: string; requestTemplate?: RequestBody;
}
export interface Attachment { name: string; path: string; bytes: number; sha256: string; content: string }
export interface ChatMessage {
  id: string; sessionId: string; role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'; content: string;
  /** Readable provider reasoning for this assistant turn; display-only and never treated as instructions. */
  reasoningContent?: string;
  createdAt: string; requestId?: string; attachments?: Attachment[]; toolCalls?: ToolCall[]; toolCallId?: string; archiveRecall?: boolean;
  /** Conversation branch provenance: the original message this copy was forked from. */
  sourceMessageId?: string;
  sampledUserInput?: { cursor: number; offset: number };
}
export interface PromptPart {
  id: string; label: string; role: string; content: string; source: string; scope: 'harness' | 'global' | 'project' | 'session' | 'request';
  estimatedTokens: number; version?: number; effective?: boolean; merge?: 'append' | 'override'; overriddenBy?: string;
}
export interface RequestRecord {
  sideBudgetSessionId?: string;
  /** Kernel-resolved task plus ancestors at preparation; immutable accounting scope, not caller authority. */
  budgetTaskIds?: string[];
  id: string; sessionId: string; taskId?: string; runId?: string; parentId?: string; profileId: string;
  kind: 'chat' | 'work' | 'studio' | 'review' | 'side'; createdAt: string; updatedAt: string;
  status: 'draft' | 'running' | 'completed' | 'failed' | 'cancelled'; endpoint: string;
  body?: RequestBody; bodyHash: string; sources: PromptPart[]; recordContent: boolean;
  draft: string; response?: ModelResult; error?: { code: string; message: string }; usage?: ModelResult['usage']; durationMs?: number;
  assistantMessageId?: string; exposedToolNames?: string[];
  /** Operator stopped this tool batch; receipts remain authoritative but it must not auto-continue. */
  toolsCancelledAt?: string;
  model?: string; startedAt?: string; contextWindowTokens?: number;
}
export interface TraceEvent {
  id: number; requestId?: string; sessionId: string; taskId?: string; runId?: string; parentId?: string;
  type: string; timestamp: string; status: string; durationMs?: number; payloadReference?: string; payload?: unknown;
}
export interface TraceQuery { sessionId?: string; taskId?: string; requestId?: string; after?: number; limit?: number; q?: string; type?: string; order?: 'desc' }
export interface Preset {
  id: string; name: string; kind: 'prompt' | 'request' | 'model'; scope: 'global' | 'project' | 'session'; scopeId: string;
  version: number; createdAt: string; value: RequestBody;
}
export interface ProviderProfile { id: string; name: string; provider: ProviderConfig; supportsDeveloper: boolean; credentialPresent: boolean; credentialFile: string; remainingLiveRequests: number; authorizationExpiresAt: string | null }
export interface RequestContext {
  /** Legacy transport's local auxiliary session; record sessionId may include the owning task namespace. */
  sideBudgetSessionId?: string;
  sessionId: string; taskId?: string; runId?: string; parentId?: string; kind: RequestRecord['kind']; profileId?: string; sources?: PromptPart[]; requestId?: string;
  /** Selected reasoning level; the Requests adapter applies the profile's reasoningMapping. */
  reasoningEffort?: string;
  /** Internal mutable holder: selected after async context assembly, never accepted from model/HTTP input. */
  coordination?: { selection?: import('../kernel/coordination.js').CoordinationSelection };
}
/**
 * Live projection of one Chat request. The durable assistant message is still written exactly once
 * at settlement and reuses the same messageId, so the client replaces its bubble instead of appending.
 */
export interface ChatStreamError { code: string; message: string }
export interface ChatStreamState {
  sessionId: string; requestId: string; messageId: string; content: string;
  /** Reasoning received so far; a reasoning-only turn streams with an empty content field. */
  reasoningContent?: string;
  status: 'streaming' | 'done' | 'cancelled' | 'error'; error?: ChatStreamError; toolCalls?: ToolCall[];
}
export interface ToolRecord {
  fileConflicts?: import('../contracts.js').FileConflictSnapshot;
  id: string; toolCallId: string; name: string; arguments: Record<string, unknown>; requestId: string; sessionId: string;
  taskId?: string; runId?: string; parentId?: string; source: string; schema?: unknown; description?: string;
  mcpDefinition?: McpDefinitionSnapshot;
  permission: string; status: string; result?: unknown; error?: string; durationMs?: number; retries: number;
  receivedByRequestId?: string; intentId?: string; digest?: string; review?: ToolReviewRecord; createdAt: string; updatedAt: string;
  failureStage?: 'unknown_tool' | 'permission' | 'validation' | 'execution' | 'reconciliation';
}
