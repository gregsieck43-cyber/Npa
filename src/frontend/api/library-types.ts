import type { Page, RequestRecordView } from './types.js';

export type LibraryScope = 'global' | 'project' | 'session';
export type LibraryKind = 'prompt' | 'request';
export interface LibraryPageQuery { cursor?: string; limit?: number }
export interface LibraryPreset {
  id: string; name: string; kind: LibraryKind; scope: LibraryScope; scopeId: string;
  version: number; createdAt: string; value: Record<string, unknown>;
}
export interface PresetQuery extends LibraryPageQuery { sessionId: string; kind: LibraryKind; scope: LibraryScope }
export interface SavePresetInput {
  sessionId: string; id?: string; name: string; kind: LibraryKind; scope: LibraryScope;
  value: Record<string, unknown>; expectedVersion?: number;
  sourceRequestId?: string;
}
export interface PresetVersionQuery extends LibraryPageQuery { sessionId: string; id: string }
export interface PromptVersion {
  scope: LibraryScope; scopeId: string; version: number;
  systemPrompt: string; developerPrompt: string; dynamic: string; defined?: string[];
}
export interface SessionCapabilities { web: boolean; tools: boolean; mcp: boolean; skills: boolean; projectInstructions: boolean }
export interface SessionSettingsView {
  sessionId: string; parameters: Record<string, unknown>; capabilities: SessionCapabilities;
  supported: SessionCapabilities; unsupportedReasons: Partial<Record<keyof SessionCapabilities, string>>;
  model: string; supportsDeveloper: boolean; maxOutputTokens: number;
}
export interface SessionSettingsPatch { parameters?: Record<string, unknown>; capabilities?: Partial<SessionCapabilities> }
/** Each file is a bounded part of one fixed snapshot; nextCursor continues the same snapshot. */
export interface ConversationExportPage {
  format: 'npn-conversation-v1'; sessionId: string; session: unknown; snapshot: string;
  scope: 'current-session'; originArchiveIncluded: false;
  origin?: { kind: 'work' | 'chat'; sessionId: string; messageId?: string; through?: number };
  messages: unknown[]; requests: unknown[];
  /** Oversized records are JSON text slices; concatenate by section/id/offset before JSON.parse. */
  fragments: { section: 'messages' | 'requests'; id: string; offset: number; totalChars: number; json: string }[];
  nextCursor?: string;
}
export interface LibraryGateway {
  exportConversation(sessionId: string, query?: LibraryPageQuery): Promise<ConversationExportPage>;
  presets(query: PresetQuery): Promise<Page<LibraryPreset>>;
  savePreset(input: SavePresetInput): Promise<LibraryPreset>;
  preset(query: { sessionId: string; id: string; version?: number }): Promise<LibraryPreset>;
  presetVersions(query: PresetVersionQuery): Promise<Page<LibraryPreset>>;
  promptVersions(sessionId: string, query: LibraryPageQuery & { scope: LibraryScope }): Promise<Page<PromptVersion>>;
  requestVersions(sessionId: string, query?: LibraryPageQuery): Promise<Page<RequestRecordView>>;
  sessionSettings(sessionId: string): Promise<SessionSettingsView>;
  saveSessionSettings(sessionId: string, input: SessionSettingsPatch): Promise<SessionSettingsView>;
  /** Import/edit validation only: creates no request, task, approval or tool dispatch. */
  validateRequest(sessionId: string, body: unknown, requestId?: string): Promise<{ body: Record<string, unknown> }>;
}
