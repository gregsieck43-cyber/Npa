import type { Message, Task, WorkspaceInfo } from '../contracts.js';
import type { ChatMessage, ChatSession, RequestRecord, ToolRecord } from '../harness/types.js';
import type { AgentMetrics } from '../harness/metrics.js';

export interface IdeAgentSelection { taskId?: string; chatId?: string; }
export interface IdeAgentView {
  workspace: WorkspaceInfo;
  providerMode: string;
  tasks: Task[];
  chats: Pick<ChatSession, 'id' | 'title' | 'workspace' | 'profileId' | 'updatedAt'>[];
  profiles: { id: string; name: string; model: string; mode: string }[];
  task?: Task;
  chat?: ChatSession;
  messages: ((Message | ChatMessage) & { previewTruncated?: boolean })[];
  request?: Pick<RequestRecord, 'id' | 'kind' | 'status' | 'draft' | 'usage' | 'durationMs' | 'error' | 'model' | 'contextWindowTokens'>;
  tools: ToolRecord[];
  metrics?: AgentMetrics;
  totalMessages: number;
}
