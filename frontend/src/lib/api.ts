import { emptyBootstrap, normalizeBootstrap } from "./utils";
import type { BootstrapResult, CodeEntry, ContextAction, ContextRange, DataAnalysisRun, DataSet, GitState, KnowledgeDocument, TimelineEvent, WorkbenchSettings } from "./types";

export const API_ROOT = "/api/v1";

export interface ApiOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
}

function sessionHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? window.localStorage.getItem("workbench-session-token") : null;
  const csrf = typeof window !== "undefined" ? window.localStorage.getItem("workbench-csrf-token") : null;
  return { ...(token ? { "X-Local-Session-Token": token } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}) };
}

export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const method = String(options.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("Idempotency-Key")) {
    headers.set("Idempotency-Key", crypto.randomUUID());
  }
  Object.entries(sessionHeaders()).forEach(([key, value]) => headers.set(key, value));
  const url = path.startsWith("/api/") ? path : `${API_ROOT}${path.startsWith("/") ? path : `/${path}`}`;
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "include",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload ? String((payload as { error: unknown }).error) : `请求失败（${response.status}）`;
    throw new Error(message);
  }
  return payload as T;
}

export async function loadBootstrap(): Promise<BootstrapResult> {
  try {
    const payload = await apiRequest<unknown>("/bootstrap");
    if (typeof window !== "undefined" && payload && typeof payload === "object" && "csrfToken" in payload) {
      const csrfToken = String((payload as { csrfToken?: unknown }).csrfToken || "");
      if (csrfToken) window.localStorage.setItem("workbench-csrf-token", csrfToken);
    }
    const data = normalizeBootstrap(payload);
    return { data: { ...data, timeline: data.timeline.map(normalizeRunEvent) }, online: true };
  } catch (error) {
    return {
      data: emptyBootstrap(),
      online: false,
      error: error instanceof Error ? error.message : "本地服务暂不可用",
    };
  }
}

export async function requestRiskConfirmation(action: string, detail: Record<string, unknown> = {}) {
  const payload = await apiRequest<{ confirmation?: { token?: string } }>("/api/security/confirmations", {
    method: "POST",
    body: { action, detail, confirmed: true },
  });
  return payload.confirmation?.token || "";
}

export function importDataset(file: { name: string; content: string; mimeType?: string }) {
  return apiRequest<{ datasets: DataSet[]; state?: { datasets?: DataSet[]; analysisRuns?: DataAnalysisRun[] } }>("/api/data/import-upload", {
    method: "POST",
    body: { files: [{ ...file, encoding: "utf8" }] },
  });
}

export function runDataAnalysis(datasetId: string, language: "pivot" | "clean" | "javascript" | "sql", input: Record<string, unknown> = {}) {
  const path = language === "pivot" ? "/api/data/pivot" : language === "clean" ? "/api/data/clean" : "/api/data/run";
  return apiRequest<{ run: DataAnalysisRun; state?: { datasets?: DataSet[]; analysisRuns?: DataAnalysisRun[] } }>(path, {
    method: "POST",
    body: { datasetId, language, ...input },
  });
}

export function readCodeTree(path = ".") {
  return apiRequest<{ root: string; entries: CodeEntry[] }>(`/tools/code/tree?path=${encodeURIComponent(path)}`);
}

export function readCodeFile(path: string) {
  return apiRequest<{ path: string; content: string; size: number; updatedAt: string }>(`/tools/code/read?path=${encodeURIComponent(path)}`);
}

export function searchCode(query: string, path = ".") {
  return apiRequest<{ query: string; matches: Array<{ path: string; line: number; preview: string }> }>("/tools/code/search", { method: "POST", body: { query, path } });
}

export async function loadGitState(): Promise<GitState> {
  const [status, diff, log] = await Promise.all([
    apiRequest<{ status: string }>("/tools/git/status"),
    apiRequest<{ diff: string }>("/tools/git/diff"),
    apiRequest<{ log: string }>("/tools/git/log"),
  ]);
  return { status: status.status || "", diff: diff.diff || "", log: log.log || "" };
}

export function loadKnowledgeDocuments(projectId = "") {
  return apiRequest<{ documents: KnowledgeDocument[] }>(`/knowledge/documents${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
}

export function saveKnowledgeDocument(document: KnowledgeDocument) {
  return apiRequest<{ document: KnowledgeDocument }>("/knowledge/documents", { method: "POST", body: document });
}

export function searchKnowledge(query: string, projectId = "") {
  return apiRequest<{ results: Array<{ title?: string; snippet?: string; url?: string; source?: string }>; status?: Record<string, unknown> }>("/knowledge/search", { method: "POST", body: { query, projectId } });
}

export function searchWeb(query: string, settings: Record<string, unknown> = {}) {
  return apiRequest<{ query: string; provider?: string; results: Array<{ title?: string; snippet?: string; url?: string; source?: string }> }>("/tools/web/search", { method: "POST", body: { query, settings } });
}

export function loadSettings() {
  return apiRequest<{ settings: WorkbenchSettings; profile?: Record<string, unknown> }>("/settings");
}

export function saveSettings(settings: WorkbenchSettings) {
  return apiRequest<{ settings: WorkbenchSettings }>("/settings", { method: "PUT", body: settings });
}

export function testProvider(settings: WorkbenchSettings, token: string) {
  return apiRequest<{ ok: boolean; provider?: string; model?: string; usage?: Record<string, unknown> }>("/providers/test", { method: "POST", body: { settings, token } });
}

export function loadConnectors() {
  return apiRequest<{ connectors: Array<Record<string, unknown>> }>("/connectors");
}

export function saveConnector(connector: Record<string, unknown>) {
  return apiRequest<{ connector: Record<string, unknown> }>("/connectors", { method: "PUT", body: connector });
}

export function loadDiagnostics() {
  return apiRequest<Record<string, unknown>>("/diagnostics");
}

const timelineTypes = new Set<TimelineEvent["type"]>(["message", "plan", "tool", "approval", "diff", "test", "checkpoint", "error", "commit", "artifact"]);

function normalizedTimelineType(rawType: string, payload: Record<string, unknown>): TimelineEvent["type"] {
  if (timelineTypes.has(rawType as TimelineEvent["type"])) return rawType as TimelineEvent["type"];
  if (rawType === "run.error" || rawType === "error") return "error";
  if (rawType.startsWith("tool.")) return "tool";
  if (rawType.startsWith("approval.")) return "approval";
  if (rawType.startsWith("artifact.")) return payload.kind === "commit" ? "commit" : "artifact";
  if (rawType.startsWith("plan.")) return "plan";
  if (rawType.startsWith("run.") || rawType === "context.updated" || rawType === "usage.updated") return "checkpoint";
  if (rawType === "step.updated") {
    const stepType = String((payload.step as { type?: unknown } | undefined)?.type || "").toLowerCase();
    if (stepType === "test") return "test";
    if (stepType === "commit") return "commit";
    if (stepType === "diff") return "diff";
    return "checkpoint";
  }
  if (rawType === "test.updated" || rawType === "test.completed") return "test";
  if (rawType === "diff.updated") return "diff";
  if (rawType === "commit.created") return "commit";
  return "message";
}

function timelineTitle(rawType: string, payload: Record<string, unknown>, type: TimelineEvent["type"]) {
  if (typeof payload.title === "string" && payload.title.trim()) return payload.title;
  if (rawType === "run.status") return `运行状态：${String(payload.status || "已更新")}`;
  if (rawType === "message.delta") return "模型响应";
  if (rawType === "run.snapshot") return "恢复点已创建";
  if (rawType === "tool.requested") return `请求工具：${String(payload.kind || "tool")}`;
  if (rawType === "tool.completed") return `工具完成：${String(payload.kind || "tool")}`;
  if (rawType === "context.updated") return "上下文工作区已更新";
  if (rawType === "usage.updated") return "模型预算已更新";
  if (rawType === "run.error" || rawType === "error") return "运行错误";
  if (rawType === "approval.requested" || rawType === "approval.updated") return "待审批动作";
  if (rawType === "step.updated") return String((payload.step as { title?: unknown } | undefined)?.title || type);
  if (rawType === "artifact.updated" || rawType === "artifact.created") return `产物${type === "commit" ? "提交" : "已更新"}`;
  return type === "message" ? rawType : type[0].toUpperCase() + type.slice(1);
}

function timelineStatus(payload: Record<string, unknown>, rawType = ""): TimelineEvent["status"] | undefined {
  const nestedStatus = payload.step && typeof payload.step === "object" ? (payload.step as { status?: unknown }).status : undefined;
  const value = String(payload.status || payload.state || nestedStatus || "").toLowerCase();
  if (rawType.startsWith("approval.") && (!value || value === "pending")) return "warning";
  if (["failed", "error"].includes(value)) return "error";
  if (["paused", "waiting_approval", "blocked", "reconciling"].includes(value)) return "warning";
  if (["running", "queued", "sleeping"].includes(value)) return "running";
  if (["completed", "success", "done", "passed"].includes(value)) return "success";
  return undefined;
}

export function normalizeRunEvent(input: unknown): TimelineEvent {
  const event = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rawType = String(event.type || "message");
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  const type = normalizedTimelineType(rawType, payload);
  const detailValue = payload.reason ?? payload.detail ?? payload.message ?? payload.text ?? payload.delta ?? event.detail;
  return {
    id: String(event.id || `event-${Date.now()}`),
    type,
    title: String(event.title || timelineTitle(rawType, payload, type)),
    detail: detailValue === undefined ? undefined : typeof detailValue === "string" ? detailValue : JSON.stringify(detailValue),
    timestamp: String(event.timestamp || event.createdAt || new Date().toISOString()),
    status: (event.status as TimelineEvent["status"] | undefined) || timelineStatus(payload, rawType),
    actor: event.actor === "user" || event.actor === "agent" || event.actor === "system" ? event.actor : rawType.startsWith("tool") ? "agent" : "system",
    meta: event.meta ? String(event.meta) : undefined,
  };
}

export function streamRun(runId: string, onEvent: (event: TimelineEvent) => void, onError?: (error: Event) => void): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return () => undefined;
  const source = new EventSource(`${API_ROOT}/runs/${encodeURIComponent(runId)}/stream`, { withCredentials: true });
  const handleMessage = (event: MessageEvent<string>) => {
    try {
      const value = JSON.parse(event.data) as TimelineEvent;
      if (value && typeof value === "object") onEvent(normalizeRunEvent(value));
    } catch {
      onEvent({ id: `stream-${Date.now()}`, type: "message", title: event.data, actor: "system" });
    }
  };
  source.addEventListener("message", handleMessage);
  source.addEventListener("timeline", handleMessage);
  source.addEventListener("run", handleMessage);
  source.addEventListener("context", handleMessage);
  [
    "run.snapshot", "run.status", "run.completed", "step.updated", "plan.updated",
    "message.delta", "tool.requested", "tool.completed", "context.updated",
    "approval.requested", "approval.updated", "artifact.created", "artifact.updated",
    "usage.updated", "error",
  ].forEach((eventName) => source.addEventListener(eventName, handleMessage));
  source.onerror = (event) => onError?.(event);
  return () => source.close();
}

export function getRunContext(runId: string) {
  return apiRequest<unknown>(`/runs/${encodeURIComponent(runId)}/context`);
}

export function getRunEvents(runId: string) {
  return apiRequest<{ events: unknown[] }>(`/runs/${encodeURIComponent(runId)}/events`).then((result) => ({ ...result, events: (result.events || []).map(normalizeRunEvent) }));
}

export function listProjects() {
  return apiRequest<unknown>("/projects");
}

export function listTasks() {
  return apiRequest<unknown>("/tasks");
}

export function listRuns() {
  return apiRequest<unknown>("/runs");
}

export function postRunAction(runId: string, action: string, payload: Record<string, unknown> = {}) {
  return apiRequest<unknown>(`/runs/${encodeURIComponent(runId)}/${action}`, { method: "POST", body: payload });
}

export function createTaskRun(taskId: string, payload: Record<string, unknown> = {}) {
  return apiRequest<unknown>(`/tasks/${encodeURIComponent(taskId)}/runs`, { method: "POST", body: payload });
}

export function postContextAction(runId: string, action: ContextAction, payload: { blockIds?: string[]; blockId?: string; range?: ContextRange; confirmed?: boolean } = {}) {
  return apiRequest<unknown>(`/runs/${encodeURIComponent(runId)}/context/actions`, { method: "POST", body: { action, ...payload } });
}

export function pauseRun(runId: string) { return postRunAction(runId, "pause"); }
export function resumeRun(runId: string) { return postRunAction(runId, "resume"); }
export function cancelRun(runId: string) { return postRunAction(runId, "cancel"); }
export function wakeRun(runId: string) { return postRunAction(runId, "wake"); }

export const endpoints = {
  bootstrap: "/bootstrap",
  projects: "/projects",
  tasks: "/tasks",
  runs: "/runs",
  stream: (runId: string) => `/runs/${encodeURIComponent(runId)}/stream`,
  context: (runId: string) => `/runs/${encodeURIComponent(runId)}/context`,
  actions: (runId: string) => `/runs/${encodeURIComponent(runId)}/context/actions`,
};
