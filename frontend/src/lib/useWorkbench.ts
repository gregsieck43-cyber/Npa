import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest, createTaskRun, getRunEvents, loadBootstrap, postContextAction, postRunAction, streamRun } from "./api";
import { emptyBootstrap } from "./utils";
import type { BootstrapData, ContextAction, ContextRange, KnowledgeTab, SettingsTab, TimelineEvent, ViewId, WorkTask, WorkspaceTab } from "./types";

export function useWorkbench() {
  const [data, setData] = useState<BootstrapData>(() => emptyBootstrap());
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string>();
  const [view, setView] = useState<ViewId>("today");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("Data");
  const [knowledgeTab, setKnowledgeTab] = useState<KnowledgeTab>("Web");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("模型");
  const [toast, setToast] = useState<string>();

  const refresh = useCallback(async () => {
    const result = await loadBootstrap();
    setData(result.data);
    setOnline(result.online);
    setError(result.error);
    setSelectedProjectId((current) => current || result.data.projects[0]?.id || null);
    if (result.error) setToast("本地服务未连接，已切换到安全离线模式");
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const contextRunId = useMemo(() => data.runs.find((run) => !["completed", "failed", "canceled"].includes(run.status))?.id, [data.runs]);
  const activeRunId = useMemo(() => data.runs.find((run) => ["running", "waiting_approval", "reconciling"].includes(run.status))?.id, [data.runs]);
  useEffect(() => {
    if (!online || !activeRunId) return;
    return streamRun(activeRunId, (event) => setData((current) => ({ ...current, timeline: [...current.timeline, event], runs: current.runs.map((run) => run.id === activeRunId ? { ...run, updatedAt: event.timestamp || new Date().toISOString() } : run) })), () => setToast("实时流已断开，仍可查看已加载的状态"));
  }, [activeRunId, online]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 4800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const createTask = useCallback(async (title = "") => {
    if (!online) {
      setToast("服务未连接；为了安全，离线模式不会伪造任务运行");
      return;
    }
    try {
      await apiRequest<unknown>("/tasks", { method: "POST", body: { title: title || "未命名任务", projectId: selectedProjectId } });
      setToast("任务已创建");
      await refresh();
      setView("tasks");
    } catch (requestError) {
      setToast(requestError instanceof Error ? requestError.message : "创建任务失败");
    }
  }, [online, refresh, selectedProjectId]);

  const startTaskRun = useCallback(async (taskId: string) => {
    if (!online) {
      setToast("服务未连接；离线模式不会伪造运行");
      return;
    }
    try {
      await createTaskRun(taskId);
      setToast("运行已排队");
      await refresh();
      setView("tasks");
    } catch (requestError) {
      setToast(requestError instanceof Error ? requestError.message : "启动运行失败");
    }
  }, [online, refresh]);

  const runAction = useCallback(async (runId: string, action: "pause" | "resume" | "cancel" | "wake") => {
    const targetRunId = runId || activeRunId;
    if (!online || !targetRunId) {
      setToast("当前没有可操作的在线运行");
      return;
    }
    try {
      await postRunAction(targetRunId, action);
      await refresh();
    } catch (requestError) {
      setToast(requestError instanceof Error ? requestError.message : "运行操作失败");
    }
  }, [activeRunId, online, refresh]);

  const viewRun = useCallback(async (runId: string) => {
    if (!online) {
      setToast("服务未连接；无法读取运行时间线");
      return;
    }
    try {
      const result = await getRunEvents(runId);
      setData((current) => ({ ...current, timeline: result.events || current.timeline }));
      setView("today");
    } catch (requestError) {
      setToast(requestError instanceof Error ? requestError.message : "运行事件读取失败");
    }
  }, [online]);

  const appendTimeline = useCallback((event: TimelineEvent) => setData((current) => ({ ...current, timeline: [...current.timeline, event] })), []);

  const pinToggle = useCallback((blockId: string, pinned: boolean) => {
    setData((current) => ({ ...current, vista: { ...current.vista, blocks: current.vista.blocks.map((block) => block.id === blockId ? { ...block, pinned } : block) } }));
    if (online && contextRunId) {
      void postContextAction(contextRunId, pinned ? "pin" : "unpin", { blockIds: [blockId] }).then(() => refresh()).catch((requestError) => {
        setToast(requestError instanceof Error ? requestError.message : "上下文固定状态未保存");
        void refresh();
      });
    }
  }, [contextRunId, online, refresh]);

  const contextAction = useCallback(async (action: ContextAction, blockId: string, range?: ContextRange) => {
    if (!online || !contextRunId) {
      setToast("当前没有可操作的在线上下文");
      return;
    }
    try {
      await postContextAction(contextRunId, action, { blockIds: [blockId], ...(range ? { range } : {}) });
      await refresh();
      setToast(action === "archive" ? "上下文块已归档" : action === "recover" ? "上下文块已恢复" : action === "restore" ? "范围内容已恢复" : "上下文块已更新");
    } catch (requestError) {
      setToast(requestError instanceof Error ? requestError.message : "上下文操作失败");
      await refresh();
    }
  }, [contextRunId, online, refresh]);

  const archiveBlock = useCallback((blockId: string) => void contextAction("archive", blockId), [contextAction]);
  const recoverBlock = useCallback((blockId: string) => void contextAction("recover", blockId), [contextAction]);
  const restoreBlockRange = useCallback((blockId: string, range: ContextRange) => void contextAction("restore", blockId, range), [contextAction]);

  const resolveApproval = useCallback(async (approvalId: string, decision: "allow" | "deny") => {
    const approval = data.vista.approvals.find((item) => item.id === approvalId);
    const runId = approval?.runId || contextRunId;
    if (!online || !runId) { setToast("当前审批不可用"); return; }
    try {
      await apiRequest(`/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`, { method: "POST", body: { decision } });
      await refresh();
      setToast(decision === "allow" ? "已批准该范围授权" : "已拒绝该操作");
    } catch (requestError) {
      setToast(requestError instanceof Error ? requestError.message : "审批处理失败");
    }
  }, [contextRunId, data.vista.approvals, online, refresh]);

  return {
    ...data,
    online,
    error,
    view,
    selectedProjectId,
    workspaceTab,
    knowledgeTab,
    settingsTab,
    toast,
    setView,
    setSelectedProjectId,
    setWorkspaceTab,
    setKnowledgeTab,
    setSettingsTab,
    refresh,
    createTask,
    startTaskRun,
    runAction,
    viewRun,
    appendTimeline,
    pinToggle,
    archiveBlock,
    recoverBlock,
    restoreBlockRange,
    resolveApproval,
    setToast,
  };
}

export type WorkbenchState = ReturnType<typeof useWorkbench>;
