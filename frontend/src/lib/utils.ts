import type { BootstrapData, RunStatus, TimelineEvent, VistaState } from "./types";

export const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "排队中",
  running: "运行中",
  sleeping: "休眠",
  waiting_approval: "等待审批",
  paused: "已暂停",
  reconciling: "对账中",
  blocked: "受阻",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
};

const TASK_STATUS_LABELS: Record<string, string> = {
  done: "已完成",
  in_progress: "进行中",
  todo: "待开始",
};

export function statusLabel(status: RunStatus | string | undefined): string {
  if (!status) return "未开始";
  return STATUS_LABELS[status as RunStatus] ?? TASK_STATUS_LABELS[status] ?? status.replaceAll("_", " ");
}

export function formatTokens(value: number | undefined): string {
  const amount = Math.max(0, Number(value) || 0);
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1)}k`;
  return String(amount);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function formatRelativeTime(timestamp: string | undefined, now = Date.now()): string {
  if (!timestamp) return "刚刚";
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return "刚刚";
  const delta = Math.max(0, now - then);
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function percent(value: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  return clamp((value / max) * 100, 0, 100);
}

export function defaultVista(): VistaState {
  return {
    blocks: [
      { id: "goal", type: "goal", title: "完成今天的工作计划", summary: "保持可验证的步骤与清晰的交付物。", pinned: true, status: "active", tokens: 420 },
      { id: "acceptance", type: "acceptance", title: "验收标准", summary: "测试、检查点和产物都应记录在时间线上。", pinned: true, status: "active", tokens: 310 },
      { id: "constraint", type: "constraint", title: "运行约束", summary: "本地优先；高风险动作需审批。", pinned: true, status: "verified", tokens: 180 },
      { id: "context", type: "context", title: "最近上下文", summary: "暂无服务端上下文，使用本地安全默认值。", status: "stale", tokens: 90, source: "local" },
    ],
    tokenPressure: 17,
    tokenUsed: 920,
    tokenLimit: 12_000,
    budgetUsed: 0,
    budgetLimit: 25,
    budgetCurrency: "USD",
    permission: "本地审阅",
    approvals: [],
  };
}

export function defaultTimeline(): TimelineEvent[] {
  return [
    { id: "welcome", type: "message", title: "工作台已就绪", detail: "连接服务后，运行、工具请求和产物会持续出现在这里。", actor: "system", status: "success" },
    { id: "checkpoint", type: "checkpoint", title: "恢复点已创建", detail: "本地会话安全地保留在当前浏览器。", actor: "system", status: "success" },
  ];
}

export function emptyBootstrap(): BootstrapData {
  return {
    projects: [],
    tasks: [],
    runs: [],
    timeline: defaultTimeline(),
    vista: defaultVista(),
    connected: false,
    fetchedAt: new Date().toISOString(),
  };
}

export function normalizeBootstrap(payload: unknown): BootstrapData {
  const source = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const data = (source.data && typeof source.data === "object" ? source.data : source) as Record<string, unknown>;
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const runs = Array.isArray(data.runs) ? data.runs : data.activeRun && typeof data.activeRun === "object" ? [data.activeRun] : [];
  const timeline = Array.isArray(data.timeline) ? data.timeline : [];
  const context = data.context && typeof data.context === "object" ? (data.context as Record<string, unknown>) : undefined;
  const contextWorkspace = context?.workspace && typeof context.workspace === "object" ? (context.workspace as Record<string, unknown>) : undefined;
  const contextBlocks = context && Array.isArray(context.blocks) ? context.blocks : contextWorkspace && Array.isArray(contextWorkspace.blocks) ? contextWorkspace.blocks : [];
  const vista = data.vista && typeof data.vista === "object" ? (data.vista as VistaState) : contextBlocks.length ? { ...defaultVista(), blocks: contextBlocks as VistaState["blocks"] } : defaultVista();
  return {
    ...emptyBootstrap(),
    ...data,
    projects: projects as BootstrapData["projects"],
    tasks: tasks as BootstrapData["tasks"],
    runs: runs as BootstrapData["runs"],
    timeline: timeline.length ? (timeline as TimelineEvent[]) : defaultTimeline(),
    vista: { ...defaultVista(), ...vista, blocks: Array.isArray(vista.blocks) && vista.blocks.length ? vista.blocks : defaultVista().blocks },
    settings: data.settings && typeof data.settings === "object" ? data.settings as BootstrapData["settings"] : undefined,
    connected: true,
    fetchedAt: new Date().toISOString(),
  };
}
