export type Theme = "light" | "dark";

export type ViewId = "today" | "projects" | "tasks" | "knowledge" | "automation" | "settings";

export type WorkspaceTab = "Data" | "Canvas" | "Code" | "Terminal" | "Git";
export type KnowledgeTab = "Web" | "Research" | "Memory";
export type SettingsTab = "模型" | "连接器" | "安全" | "诊断";

export type RunStatus =
  | "queued"
  | "running"
  | "sleeping"
  | "waiting_approval"
  | "paused"
  | "reconciling"
  | "blocked"
  | "completed"
  | "failed"
  | "canceled";

export interface Project {
  id: string;
  name: string;
  path?: string;
  description?: string;
  color?: string;
  active?: boolean;
  updatedAt?: string;
}

export interface WorkTask {
  id: string;
  title: string;
  summary?: string;
  projectId?: string;
  status?: RunStatus | "todo" | "in_progress" | "done";
  priority?: "low" | "normal" | "high" | "urgent";
  dueAt?: string;
  updatedAt?: string;
}

export interface Run {
  id: string;
  taskId?: string;
  projectId?: string;
  title?: string;
  status: RunStatus;
  model?: string;
  startedAt?: string;
  updatedAt?: string;
  tokens?: { input?: number; output?: number; total?: number; limit?: number };
  budget?: { used?: number; limit?: number; currency?: string };
}

export type TimelineEventType =
  | "message"
  | "plan"
  | "tool"
  | "approval"
  | "diff"
  | "test"
  | "checkpoint"
  | "error"
  | "commit"
  | "artifact";

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  title: string;
  detail?: string;
  timestamp?: string;
  status?: "pending" | "running" | "success" | "warning" | "error";
  actor?: "user" | "agent" | "system";
  meta?: string;
}

export type ContextAction = "archive" | "recover" | "restore" | "pin" | "unpin" | "delete";

export interface ContextRange {
  start?: number;
  end?: number;
  length?: number;
}

export interface VistaBlock {
  id: string;
  type: "goal" | "acceptance" | "constraint" | "context" | "tool" | "result" | "memory";
  title: string;
  summary?: string;
  pinned?: boolean;
  status?: "active" | "verified" | "stale" | "blocked";
  tokens?: number;
  source?: string;
  archived?: boolean;
  payloadRef?: string | null;
  checksum?: string | null;
  integrity?: string;
  permanentPinned?: boolean;
}

export interface VistaApproval {
  id: string;
  title: string;
  risk: "low" | "medium" | "high";
  runId?: string;
  effectId?: string | null;
  status?: string;
  request?: Record<string, unknown> | null;
  decision?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface VistaState {
  blocks: VistaBlock[];
  runId?: string;
  tokenPressure: number;
  tokenUsed: number;
  tokenLimit: number;
  budgetUsed: number;
  budgetLimit: number;
  budgetCurrency?: string;
  permission: string;
  approvals: VistaApproval[];
}

export interface BootstrapData {
  projects: Project[];
  tasks: WorkTask[];
  runs: Run[];
  timeline: TimelineEvent[];
  vista: VistaState;
  settings?: WorkbenchSettings;
  connected: boolean;
  serverVersion?: string;
  fetchedAt?: string;
}

export interface WorkbenchSettings {
  theme?: Theme;
  modelProvider?: string;
  apiProtocol?: string;
  model?: string;
  effort?: string;
  apiBaseUrl?: string;
  contextWindowHint?: number;
  capabilities?: Record<string, boolean>;
  runBudget?: { durationHours?: number; maxModelCalls?: number; maxEstimatedUsd?: number; enforced?: boolean };
  analysis?: { javascriptTimeoutMs?: number; pythonTimeoutMs?: number; packageManager?: string };
  web?: { provider?: string; rateLimitPerMinute?: number; searchContextSize?: number; customEndpoint?: string };
  rag?: { embeddingProvider?: string; vectorStore?: string };
}

export interface DataSet {
  id: string;
  name: string;
  rows: Array<Record<string, unknown>>;
  columns: string[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface DataAnalysisRun {
  id: string;
  datasetId: string;
  language: string;
  status: string;
  table?: Array<Record<string, unknown>>;
  chart?: Record<string, unknown>;
  input?: Record<string, unknown>;
  createdAt?: string;
}

export interface KnowledgeDocument {
  id?: string;
  projectId?: string;
  title: string;
  content: string;
  source?: string;
  tags?: string[];
  updatedAt?: string;
}

export interface CodeEntry {
  path: string;
  name: string;
  type: "file" | "directory";
}

export interface GitState {
  status: string;
  diff: string;
  log: string;
}

export interface BootstrapResult {
  data: BootstrapData;
  online: boolean;
  error?: string;
}
