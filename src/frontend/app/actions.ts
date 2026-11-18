import { gateway, GatewayError, type DeepPartial } from '../api';
import type { ApprovalDecision, AppMode, Attachment, ChatMessage, GatewayEvent, ModelProfileInput, PermissionMode, SessionSummary, Settings, SideAnswer, SideAskInput, TaskControl } from '../api';
import { getState, setState, type AppState, type InspectorTab, type PanelKind, type PanelTab, type SettingsSection, type Toast } from './store';
import { applySessionRemoved, applySnapshot, createGenerationGuard, createRecoveryFence } from './event-recovery';
import { activeMessage, boundMessages, upsertMessage } from './message-window';

/** 状态重建会作废此前所有异步读取；打开会话与快照恢复共享同一代数。 */
const recoveryGeneration = createGenerationGuard();

/**
 * 删除/审批结算只否决“开始于该事件之前”的异步读取。标记随读取窗口释放，
 * 不再像永久 tombstone 那样让 20 天的历史 id 一直留在内存里。
 */
const recoveryFence = createRecoveryFence();

/** 事件序号：启动读取返回时据此判断期间是否已有事件改写了会话/审批。 */
let eventRevision = 0;

let toastSeq = 0;

export function notify(tone: Toast['tone'], title: string, detail?: string) {
  const toast: Toast = { id: `toast-${++toastSeq}`, tone, title, detail };
  setState(current => ({ toasts: [...current.toasts.slice(-4), toast] }));
}

export function dismissToast(id: string) {
  setState(current => ({ toasts: current.toasts.filter(toast => toast.id !== id) }));
}

/** 网关错误统一以 Toast 呈现；返回 undefined 表示操作失败。 */
async function guard<T>(title: string, run: () => Promise<T>, reportError = () => true): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof GatewayError ? error.message : error instanceof Error ? error.message : String(error);
    if (reportError()) notify('error', title, message);
    return undefined;
  }
}

function applyEvent(event: GatewayEvent) {
  eventRevision += 1;
  switch (event.type) {
    case 'coordination.changed':
      setState(current => ({ coordinationRevision: (current.coordinationRevision ?? 0) + 1 }));
      break;
    case 'session.upsert': {
      // 不撤销删除标记：删除前发出的旧详情可能来自旧一代，重新打开会重新读取。
      const current = getState(), row = event.session;
      if (refreshingRecent && !current.sessions[row.id]) recentDirty = true;
      const historical = !current.sessions[row.id] || current.historyFocusId === row.id;
      const checkMembership = historical && (current.historyNextCursor !== undefined || Object.keys(current.sessions).length >= 500);
      setState({ ...patchKnownSession(current, row, !checkMembership),
        ...(!checkMembership && current.historyFocusId === row.id ? { historyFocusId: undefined } : {}) });
      if (checkMembership) void refreshRecentSessions();
      break;
    }
    case 'session.removed': {
      recoveryFence.removed(event.sessionId);
      const patch = applySessionRemoved(getState(), event.sessionId);
      const page = getState().historyPage;
      setState({ ...patch.state, ...(page?.items ? { historyPage: { ...page, items: page.items.filter(item => item.id !== event.sessionId) } } : {}) });
      if (getState().detailSessionId === event.sessionId) setState({ detailSessionId: undefined });
      if (patch.focusRemoved) {
        gateway.focusSession?.(undefined);
        notify('warn', '会话已删除', '当前会话已在后台删除，已返回首页。');
      }
      break;
    }
    case 'message.upsert':
      setState(current => {
        if (current.detailSessionId !== event.sessionId) return {};
        const detail = current.details[event.sessionId];
        const window = current.messageWindow ?? { history: false, loading: true, tail: { messages: [], hasMoreBefore: false } };
        const tail = boundMessages({ ...window.tail, messages: upsertMessage(window.tail.messages, event.message) }, true);
        return { messageWindow: { ...window, tail }, ...(detail && !window.history ? { details: { [detail.id]: { ...detail, ...tail } } } : {}) };
      });
      break;
    case 'approval.requested':
      recoveryFence.requested(event.approval.id);
      setState(current => ({ approvals: { ...current.approvals, [event.approval.id]: event.approval } }));
      break;
    case 'approval.resolved':
      recoveryFence.resolved(event.approvalId);
      setState(current => {
        const { [event.approvalId]: _resolved, ...approvals } = current.approvals;
        return { approvals };
      });
      break;
    case 'task.updated':
      setState(current => {
        const detail = current.details[event.sessionId];
        const settled = current.pendingTaskPauses[event.task.id] && ['paused', 'waiting_input', 'failed', 'completed', 'cancelled'].includes(event.task.status);
        return {
          ...(settled ? { pendingTaskPauses: withoutTaskPause(current, event.task.id) } : {}),
          ...(detail ? { details: { ...current.details, [detail.id]: { ...detail, task: event.task } } } : {}),
        };
      });
      break;
    case 'metrics.updated':
      setState(current => current.detailSessionId === event.sessionId ? { metrics: { [event.sessionId]: event.metrics } } : {});
      break;
    case 'connection.changed':
      setState({ connection: event.connection });
      break;
    case 'inspector.invalidated':
      setState(current => current.detailSessionId === event.sessionId ? { inspectorRevision: { [event.sessionId]: (current.inspectorRevision[event.sessionId] ?? 0) + 1 } } : {});
      break;
    case 'state.snapshot': {
      setState(current => ({ coordinationRevision: (current.coordinationRevision ?? 0) + 1 }));
      // 快照是新一代状态：先作废旧请求与旧一代标记，再整体替换可确认的缓存。
      recoveryGeneration.bump();
      recoveryFence.reset();
      const before = getState();
      const patch = applySnapshot(before, event.snapshot);
      const page = event.snapshot.sessions;
      const head = Object.fromEntries(page.items.filter(item => patch.state.sessions?.[item.id]).map(item => [item.id, item]));
      const active = before.detailSessionId ? patch.state.sessions?.[before.detailSessionId] : undefined;
      setState({ ...patch.state, ...recentWindow(head, page.nextCursor, active), historyPage: undefined });
      if (before.detailSessionId && patch.removedSessionIds.includes(before.detailSessionId)) setState({ detailSessionId: undefined });
      const activeId = getState().detailSessionId;
      const detail = activeId ? getState().details[activeId] : undefined;
      const tail = detail ? boundMessages({ messages: detail.messages, hasMoreBefore: detail.hasMoreBefore, beforeCursor: detail.beforeCursor }, true) : undefined;
      setState({
        details: detail && tail ? { [detail.id]: { ...detail, ...tail } } : {},
        metrics: activeId && patch.state.metrics?.[activeId] ? { [activeId]: patch.state.metrics[activeId] } : {},
        inspectorRevision: activeId && patch.state.inspectorRevision?.[activeId] ? { [activeId]: patch.state.inspectorRevision[activeId] } : {},
        messageWindow: tail ? { tail, history: false, loading: false } : undefined,
      });
      if (patch.focusRemoved && before.view.kind === 'session') notify('warn', '会话已删除', '当前会话已在后台删除，已返回首页。');
      const view = getState().view;
      gateway.focusSession?.(activeId);
      if (patch.reloadSessionId) void loadSession(patch.reloadSessionId);
      else if (view.kind === 'ide' && activeId && !detail) void loadSession(activeId);
      break;
    }
    case 'notify':
      notify(event.tone, event.title, event.detail);
      break;
  }
}

let subscribed = false;

export async function boot() {
  const beforeSessions = getState().sessions, revisionAtStart = eventRevision;
  if (!subscribed) { gateway.subscribe(applyEvent); subscribed = true; }
  const token = recoveryGeneration.current();
  const modelsRead = beginModelsRead();
  // 启动读取窗口：删除/结算标记只在响应可能迟到期间保留，启动完成即释放。
  const read = recoveryFence.beginRead();
  setState({ bootError: undefined, booted: false });
  try {
    const [connection, settings, models, sessions, approvals, projects] = await Promise.all([
      gateway.connection(), gateway.settings.get(), gateway.settings.models(), gateway.sessions.list({ limit: 500 }), gateway.approvals.pending(), gateway.workspace.projects(),
    ]);
    applyAppearance(settings);
    if (!recoveryGeneration.isCurrent(token)) {
      // 启动读取期间已发生快照恢复：会话/审批以快照为准，旧响应不能把被清理的状态灌回来。
      setState({ booted: true, connection, settings, models: modelsReadIsCurrent(modelsRead) ? models : getState().models, projects, mode: settings.defaults.mode });
      return;
    }
    const current = getState();
    const bootSessions = Object.fromEntries(sessions.items.filter(item => !recoveryFence.wasRemoved(read, item.id)).map(item => {
      const live = current.sessions[item.id];
      return [item.id, live && live !== beforeSessions[item.id] && live.updatedAt >= item.updatedAt ? live : item];
    }));
    const bootApprovals = Object.fromEntries(approvals.filter(item => !recoveryFence.wasResolved(read, item.id)).map(item => [item.id, item]));
    const eventsDuringBoot = eventRevision !== revisionAtStart;
    // A replay and a genuine new arrival can both be absent from an in-flight list.
    // Recheck membership and its opaque cursor together instead of appending either row.
    const unlistedChange = Object.values(current.sessions).some(item => item !== beforeSessions[item.id] && !bootSessions[item.id]);
    const active = current.detailSessionId ? current.sessions[current.detailSessionId] : undefined;
    setState({
      booted: true, connection, settings, models: modelsReadIsCurrent(modelsRead) ? models : current.models, projects, mode: settings.defaults.mode,
      ...recentWindow(bootSessions, sessions.nextCursor, active), historyPage: undefined,
      approvals: eventsDuringBoot ? { ...bootApprovals, ...current.approvals } : bootApprovals,
    });
    if (unlistedChange) await refreshRecentSessions();
  } catch (error) {
    setState({ booted: true, bootError: error instanceof Error ? error.message : String(error), connection: { status: 'offline', demo: gateway.kind === 'mock' } });
  } finally {
    recoveryFence.endRead(read);
  }
}

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

export function applyAppearance(settings: Settings) {
  const root = document.documentElement, { appearance } = settings;
  root.dataset.theme = appearance.theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : appearance.theme;
  root.dataset.accent = appearance.accent;
  root.dataset.density = appearance.density;
  root.dataset.motion = appearance.motion;
  root.dataset.ambient = String(appearance.ambient);
  root.style.setProperty('--font-scale', String(appearance.fontScale));
}

systemDark.addEventListener('change', () => {
  const settings = getState().settings;
  if (settings?.appearance.theme === 'system') applyAppearance(settings);
});

export async function updateSettings(patch: DeepPartial<Settings>, origin?: { x: number; y: number }) {
  const settings = await guard('保存设置失败', () => gateway.settings.update(patch));
  if (!settings) return;
  const themeChanged = patch.appearance?.theme !== undefined;
  const apply = () => { applyAppearance(settings); setState({ settings }); };
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (themeChanged && origin && doc.startViewTransition && settings.appearance.motion === 'full') {
    document.documentElement.style.setProperty('--reveal-x', `${origin.x}px`);
    document.documentElement.style.setProperty('--reveal-y', `${origin.y}px`);
    document.documentElement.classList.add('theme-reveal');
    const transition = doc.startViewTransition(apply);
    void transition.ready.finally(() => setTimeout(() => document.documentElement.classList.remove('theme-reveal'), 700));
  } else apply();
}

export function toggleTheme(origin?: { x: number; y: number }) {
  const current = document.documentElement.dataset.theme;
  void updateSettings({ appearance: { theme: current === 'dark' ? 'light' : 'dark' } }, origin);
}

// ---------- 导航 ----------
export function setMode(mode: AppMode) {
  setState(current => ({ mode, view: current.view.kind === 'session' && current.sessions[current.view.id]?.mode !== mode ? { kind: 'home' } : current.view }));
}

export function goHome(mode?: AppMode) {
  gateway.focusSession?.(undefined);
  setState(current => ({ view: { kind: 'home' }, mode: mode ?? current.mode }));
}

export function go(view: 'projects' | 'history') {
  setState({ view: { kind: view } });
  if (view === 'history' && recentDirty) void refreshRecentSessions();
}

export function showRecentHistory() {
  setState({ historyPage: undefined });
  if (recentDirty) void refreshRecentSessions();
}

function patchKnownSession(state: AppState, row: SessionSummary, addToRecent = false): Partial<AppState> {
  const page = state.historyPage, detail = state.details[row.id];
  return {
    ...(addToRecent || state.sessions[row.id] ? { sessions: { ...state.sessions, [row.id]: row } } : {}),
    ...(page?.items?.some(item => item.id === row.id) ? { historyPage: { ...page, items: page.items.map(item => item.id === row.id ? row : item) } } : {}),
    ...(detail ? { details: { ...state.details, [row.id]: { ...detail, ...row } } } : {}),
  };
}

// Only a server listing can confirm that an older row moved into the first 500 and supply its new cursor.
function recentWindow(sessions: AppState['sessions'], cursor: string | undefined, active?: SessionSummary) {
  // A partial page cannot confirm deletion. Keep an off-page active summary only until navigation.
  const focus = cursor && active && !sessions[active.id] ? active : undefined;
  if (focus) sessions[focus.id] = focus;
  return { sessions, historyNextCursor: cursor, historyFocusId: focus?.id };
}

let recentDirty = false, refreshingRecent: Promise<void> | undefined;
function refreshRecentSessions() {
  recentDirty = true;
  if (refreshingRecent) return refreshingRecent;
  refreshingRecent = (async () => {
    do {
      recentDirty = false;
      const before = getState().sessions, token = recoveryGeneration.current(), read = recoveryFence.beginRead();
      try {
        const result = await guard('刷新最近会话失败', () => gateway.sessions.list({ limit: 500 }));
        if (!recoveryGeneration.isCurrent(token) || recentDirty) continue;
        if (!result) { recentDirty = true; break; }
        const current = getState();
        const sessions = Object.fromEntries(result.items.filter(item => !recoveryFence.wasRemoved(read, item.id)).map(item => {
          const newer = current.sessions[item.id];
          return [item.id, newer && newer !== before[item.id] ? newer : item];
        }));
        const active = current.detailSessionId ? current.sessions[current.detailSessionId] : undefined;
        setState(recentWindow(sessions, result.nextCursor, active));
        if (active && !result.nextCursor && !sessions[active.id]) applyEvent({ type: 'session.removed', sessionId: active.id });
      } finally { recoveryFence.endRead(read); }
    } while (recentDirty);
  })().finally(() => { refreshingRecent = undefined; });
  return refreshingRecent;
}

let historyRequest = 0;
export async function loadOlderHistory() {
  const start = getState(), page = start.historyPage;
  const refreshHead = !page?.items && Boolean(refreshingRecent || recentDirty);
  let cursor = page?.items ? page.nextCursor : start.historyNextCursor;
  if (start.view.kind !== 'history' || page?.pending || (!cursor && !refreshHead)) return;
  const pending = ++historyRequest, read = recoveryFence.beginRead();
  setState({ historyPage: { ...page, pending, error: undefined } });
  try {
    if (refreshHead) {
      await (refreshingRecent ?? refreshRecentSessions());
      if (getState().historyPage?.pending !== pending) return;
      if (recentDirty) throw new Error('最近会话尚未刷新，请重试。');
      cursor = getState().historyNextCursor;
      if (!cursor) { showRecentHistory(); return; }
    }
    const result = await gateway.sessions.list({ cursor, limit: 100 });
    if (getState().historyPage?.pending !== pending) return;
    if (!Array.isArray(result?.items) || result.items.length > 100 || (result.nextCursor !== undefined &&
      (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor === cursor))) {
      throw new Error('后台返回的历史分页无效，请重试。');
    }
    const items = result.items.filter(item => !recoveryFence.wasRemoved(read, item.id));
    setState({ historyPage: { items, nextCursor: result.nextCursor } });
  } catch (error) {
    const current = getState().historyPage;
    if (current?.pending === pending) setState({ historyPage: { ...current, pending: undefined, error: error instanceof Error ? error.message : String(error) } });
  } finally { recoveryFence.endRead(read); }
}

/** 打开内置 IDE 工作台；未指定项目时沿用当前项目，再退回第一个已登记项目。 */
export function openIdeView(projectId?: string) {
  setState(current => ({ view: { kind: 'ide', projectId: projectId ?? current.projectId ?? current.projects[0]?.id }, mode: 'code' }));
}

/**
 * 模型读取代数：保存/删除成功会作废此前发出的列表读取；每次读取再领取一个递增序号，
 * 因此并发读取时只有最新一次可以写入，迟到的旧响应不会覆盖更新的列表。
 * 草稿与编辑态不在这个读取里，因此刷新只替换 models 数据。
 */
let modelsRevision = 0;
let modelsReadGeneration = 0;

interface ModelsRead {
  generation: number;
  revision: number;
}

function beginModelsRead(): ModelsRead {
  return { generation: ++modelsReadGeneration, revision: modelsRevision };
}

function modelsReadIsCurrent(read: ModelsRead): boolean {
  return read.generation === modelsReadGeneration && read.revision === modelsRevision;
}

/**
 * 重新读取真实模型列表（打开“设置 → 模型”时触发）。导入或外部保存后无需重启应用即可看到
 * 新配置；读取期间发生的保存/删除或更新的读取会让本次迟到结果被丢弃。
 */
export async function refreshModels() {
  const read = beginModelsRead();
  const models = await guard('读取模型列表失败', () => gateway.settings.models());
  if (!models || !modelsReadIsCurrent(read)) return;
  setState({ models });
}

export function openSettings(section: SettingsSection = 'appearance') {
  setState({ view: { kind: 'settings', section } });
  if (section === 'models') void refreshModels();
}

export async function openSession(id: string) {
  const state = getState();
  const older = !state.sessions[id] ? state.historyPage?.items?.find(item => item.id === id) : undefined;
  const summary = state.sessions[id] ?? older;
  gateway.focusSession?.(id);
  setState({ view: { kind: 'session', id }, mode: summary?.mode ?? state.mode, inspectorFocus: undefined,
    ...(older ? { sessions: { ...state.sessions, [id]: older }, historyFocusId: id } : {}) });
  await loadSession(id);
}

export function openInspector(tab: InspectorTab, focus?: { requestId?: string; toolCallId?: string }) {
  setState({ inspectorTab: tab, inspectorFocus: focus });
  openPanel('inspector');
}

// ---------- 右侧边面板 ----------
const singletonKinds: PanelKind[] = ['changes', 'inspector', 'terminal', 'sidechat', 'files', 'coordination'];
let panelSeq = 0;

/** 打开某类标签：单例类型复用已有标签；browser 总是新开（若当前是新标签页则原地变为浏览器）。 */
export function openPanel(kind: PanelKind, url?: string) {
  setState(current => {
    const { tabs, active } = current.panel, layout = { ...current.layout, inspectorOpen: true };
    const existing = singletonKinds.includes(kind) ? tabs.find(t => t.kind === kind) : undefined;
    if (existing) return { panel: { tabs, active: existing.id }, layout };
    const launcher = tabs.find(t => t.id === active && t.kind === 'launcher');
    const tab: PanelTab = { id: launcher?.id ?? `tab-${++panelSeq}`, kind, history: url ? [url] : [], index: 0 };
    const next = launcher ? tabs.map(t => (t.id === launcher.id ? tab : t)) : [...tabs, tab];
    return { panel: { tabs: next, active: tab.id }, layout };
  });
  if (url && !url.startsWith('search:')) rememberUrl(url);
}

export function newPanelTab() {
  setState(current => {
    const tab: PanelTab = { id: `tab-${++panelSeq}`, kind: 'launcher', history: [], index: 0 };
    return { panel: { tabs: [...current.panel.tabs, tab], active: tab.id }, layout: { ...current.layout, inspectorOpen: true } };
  });
}

export function activatePanelTab(id: string) {
  setState(current => ({ panel: { ...current.panel, active: id } }));
}

export function closePanelTab(id: string) {
  setState(current => {
    const { tabs, active } = current.panel, index = tabs.findIndex(t => t.id === id), next = tabs.filter(t => t.id !== id);
    if (!next.length) return { panel: { tabs: [{ id: `tab-${++panelSeq}`, kind: 'launcher', history: [], index: 0 }], active: `tab-${panelSeq}` } };
    return { panel: { tabs: next, active: active === id ? next[Math.max(0, index - 1)].id : active } };
  });
}

/** 浏览器标签导航：push 新地址（截断前进历史）或按 delta 前进/后退。 */
export function navigateTab(id: string, target: string | number) {
  setState(current => ({
    panel: {
      ...current.panel,
      tabs: current.panel.tabs.map(t => {
        if (t.id !== id) return t;
        if (typeof target === 'number') return { ...t, index: Math.max(0, Math.min(t.history.length - 1, t.index + target)) };
        const history = [...t.history.slice(0, t.index + 1), target];
        return { ...t, history, index: history.length - 1 };
      }),
    },
  }));
  if (typeof target === 'string' && !target.startsWith('search:')) rememberUrl(target);
}

function rememberUrl(url: string) {
  setState(current => ({ recentUrls: [url, ...current.recentUrls.filter(u => u !== url)].slice(0, 8) }));
}

/** History belongs to the backend; retain at most one 80-turn presentation window. */
export const sideChatKey = (sessionId?: string) => sessionId ?? 'temp';
let sideGeneration = 0, sideRead = 0;

export async function loadSideChat(sessionId?: string, older = false) {
  const key = sideChatKey(sessionId);
  if (getState().sideChatMeta?.key !== key) setState({ sideChats: { [key]: [] }, sideChatMeta: { key, generation: ++sideGeneration, latest: true } });
  const meta = getState().sideChatMeta!;
  if (older && (!meta.nextCursor || meta.loading)) return;
  const read = ++sideRead, generation = meta.generation;
  setState({ sideChatMeta: { ...meta, loading: true } });
  const page = await guard('读取侧边历史失败', () => gateway.chat.sideHistory({ sessionId, sideSessionId: meta.sideSessionId, before: older ? meta.nextCursor : undefined }));
  const current = getState().sideChatMeta;
  if (read !== sideRead || current?.key !== key || current.generation !== generation) return;
  if (!page) { setState({ sideChatMeta: { ...current, loading: false } }); return; }
  const rows = older ? [...page.items, ...(getState().sideChats[key] ?? [])] : [...page.items];
  if (!older && current.pending && !rows.some(item => item.id === current.pending!.id)) rows.push(current.pending);
  const unique = [...new Map(rows.map(item => [item.id, item])).values()];
  setState({ sideChats: { [key]: older ? unique.slice(0, 80) : unique.slice(-80) }, sideChatMeta: {
    ...current, sideSessionId: page.sideSessionId, targetTaskId: page.targetTaskId, nextCursor: page.nextCursor, loading: false, latest: !older,
  } });
  return page;
}

export async function askSide(input: Omit<SideAskInput, 'history'>) {
  const key = sideChatKey(input.sessionId);
  if (getState().sideChatMeta?.key !== key || !getState().sideChatMeta?.sideSessionId) await loadSideChat(input.sessionId);
  const meta = getState().sideChatMeta;
  if (meta?.key !== key || !meta.sideSessionId || meta.pending) return;
  const retry = meta.retryInput;
  const sameInput = retry && retry.question === input.question && retry.modelId === input.modelId && retry.reasoningEffort === input.reasoningEffort && JSON.stringify(retry.attachments) === JSON.stringify(input.attachments);
  const request = { ...input, sideSessionId: meta.sideSessionId, messageId: input.messageId ?? (sameInput ? retry.messageId : undefined) ?? crypto.randomUUID() };
  const pending: SideAnswer = { id: request.messageId, sideSessionId: meta.sideSessionId, question: input.question, answer: '', attachments: input.attachments, modelId: input.modelId, createdAt: new Date().toISOString(), status: 'running' };
  const generation = meta.generation;
  setState({ sideChats: { [key]: [...(getState().sideChats[key] ?? []).filter(item => item.id !== pending.id), pending].slice(-80) }, sideChatMeta: { ...meta, pending, retryInput: request, latest: true } });
  const answer = await guard('侧边聊天失败', () => gateway.chat.sideAsk(request));
  const current = getState().sideChatMeta;
  if (current?.key === key && current.generation === generation && current.sideSessionId === meta.sideSessionId) {
    const rows = (getState().sideChats[key] ?? []).filter(item => item.id !== pending.id);
    setState({ ...(current.latest ? { sideChats: { [key]: answer ? [...rows, answer].slice(-80) : rows } } : {}), sideChatMeta: { ...current, pending: undefined, retryInput: answer ? undefined : request, targetTaskId: answer?.targetTaskId ?? current.targetTaskId } });
    if (!answer && current.latest) await loadSideChat(input.sessionId);
  }
  return answer;
}

export async function cancelSideChat(sessionId?: string) {
  const meta = getState().sideChatMeta;
  if (meta?.key !== sideChatKey(sessionId) || !meta.sideSessionId) return;
  await guard('停止侧边请求失败', () => gateway.chat.sideCancel({ sessionId, sideSessionId: meta.sideSessionId! }));
  if (getState().sideChatMeta?.key === meta.key && getState().sideChatMeta?.generation === meta.generation && getState().sideChatMeta?.latest) await loadSideChat(sessionId);
}

export async function clearSideChat(sessionId?: string) {
  const meta = getState().sideChatMeta;
  if (meta?.key !== sideChatKey(sessionId) || !meta.sideSessionId) return;
  const cleared = await guard('清空侧边聊天失败', async () => { await gateway.chat.sideClear({ sessionId, sideSessionId: meta.sideSessionId! }); return true; });
  if (cleared && getState().sideChatMeta?.key === meta.key && getState().sideChatMeta?.generation === meta.generation) {
    setState({ sideChats: { [meta.key]: [] }, sideChatMeta: { key: meta.key, generation: ++sideGeneration, latest: true } });
    await loadSideChat(sessionId);
  }
}

export function togglePalette(open?: boolean) {
  setState(current => ({ paletteOpen: open ?? !current.paletteOpen }));
}

// ---------- 会话 ----------
export function currentSessionId() {
  const view = getState().view;
  return view.kind === 'session' ? view.id : undefined;
}

export function setDraft(key: string, text: string) {
  setState(current => ({ drafts: { ...current.drafts, [key]: text } }));
}

/**
 * 发送到目标会话（缺省为新会话草稿）。embedded=true 时（IDE Agent 面板）不跳转路由，
 * 只加载会话详情并返回新会话 id。
 */
export async function send(text: string, attachments: Attachment[], target: { sessionId?: string; mode: AppMode; embedded?: boolean; projectId?: string; planFirst?: boolean }) {
  const state = getState(), sessionId = target.sessionId;
  const session = sessionId ? state.sessions[sessionId] : undefined;
  const permission = session?.permission ?? state.draftPermission ?? state.settings!.defaults.permission;
  const modelId = session?.modelId ?? state.draftModelId ?? state.settings!.defaults.modelId;
  const reasoningEffort = session ? session.reasoningEffort : state.draftReasoning;
  const result = await guard('发送失败', () => gateway.chat.send({ sessionId, mode: session?.mode ?? target.mode, text, attachments, permission, modelId, reasoningEffort, projectId: target.projectId ?? state.projectId, planFirst: target.planFirst }));
  if (!result) return undefined;
  // A late send acknowledgement must not reopen a closed embedded panel or steal a newer route.
  if (getState().detailEpoch !== state.detailEpoch || getState().detailSessionId !== state.detailSessionId
    || getState().mode !== state.mode || getState().projectId !== state.projectId) return undefined;
  if (!sessionId) {
    if (target.embedded) await loadSession(result.sessionId);
    else await openSession(result.sessionId);
    if (getState().detailSessionId !== result.sessionId) return undefined;
  }
  return result.sessionId;
}

/** 只加载会话详情与指标，不改变当前视图。 */
export async function loadSession(id: string) {
  setState({ detailSessionId: id });
  gateway.focusSession?.(id);
  await readMessages(id, false, true);
}

export function releaseSession(id?: string) {
  // A new Composer may already be loading its acknowledged id before onSent selects it.
  if (getState().view.kind === 'ide' && (id === undefined || getState().detailSessionId === id)) {
    setState({ detailSessionId: undefined, detailEpoch: (getState().detailEpoch ?? 0) + 1 }); gateway.focusSession?.(undefined);
  }
}

export async function loadOlderMessages(id: string) {
  const state = getState();
  if (state.detailSessionId === id && state.details[id]?.hasMoreBefore && !state.messageWindow?.loading) await readMessages(id, true);
}

export async function loadLatestMessages(id: string) {
  if (getState().detailSessionId === id && !getState().messageWindow?.loading) await readMessages(id, false);
}

let detailRead = 0;
async function readMessages(id: string, history: boolean, withMetrics = false) {
  const sequence = ++detailRead, start = getState(), epoch = start.detailEpoch;
  const original = new Map(start.messageWindow?.tail.messages.map(message => [message.id, message]) ?? []);
  const token = recoveryGeneration.current();
  const read = recoveryFence.beginRead();
  const current = () => sequence === detailRead && getState().detailSessionId === id && getState().detailEpoch === epoch && recoveryGeneration.isCurrent(token) && !recoveryFence.wasRemoved(read, id);
  setState({ messageWindow: { ...(start.messageWindow ?? { history: false, tail: { messages: [], hasMoreBefore: false } }), loading: true } });
  try {
    const detail = await guard('读取会话失败', () => gateway.sessions.get(id, history ? start.details[id]?.beforeCursor ?? String(Number.MAX_SAFE_INTEGER) : undefined));
    if (!detail || !current()) return;
    const window = getState().messageWindow!;
    // A full streaming projection received during the read wins over the stored page.
    let messages = detail.messages;
    if (!history) for (const message of window.tail.messages) {
      if (original.get(message.id) !== message || (activeMessage(message) && !messages.some(row => row.id === message.id))) messages = upsertMessage(messages, message);
    }
    const page = boundMessages({ messages, hasMoreBefore: detail.hasMoreBefore, beforeCursor: detail.beforeCursor }, !history);
    setState({ details: { [id]: { ...detail, ...page, task: getState().details[id]?.task ?? detail.task } }, messageWindow: { history, loading: false, tail: history ? window.tail : page } });
    if (withMetrics) {
      const metrics = await guard('读取运行指标失败', () => gateway.metrics.session(id));
      if (metrics && current()) setState({ metrics: { [id]: metrics } });
      if (detail.mode !== 'chat' && current()) {
        const previousTask = getState().details[id]?.task;
        const task = await guard('读取任务失败', () => gateway.tasks.get(id));
        if (task && current() && getState().details[id]?.task === previousTask) setState({ details: { [id]: { ...getState().details[id]!, task } } });
      }
    }
  } finally {
    if (current() && getState().messageWindow) setState({ messageWindow: { ...getState().messageWindow!, loading: false } });
    recoveryFence.endRead(read);
  }
}

export const cancel = (sessionId: string) => guard('停止失败', () => gateway.chat.cancel(sessionId));
/** 后台会丢弃被替换的消息，但事件流只推送新增/更新，所以先在本地截断，失败时恢复。 */
async function rewrite(title: string, sessionId: string, keep: (messages: ChatMessage[]) => ChatMessage[], call: () => Promise<void>) {
  const initial = getState(), before = initial.details[sessionId], window = initial.messageWindow;
  const optimistic = before ? { ...before, messages: keep(before.messages) } : undefined;
  if (optimistic) setState({ details: { [sessionId]: optimistic }, ...(window && !window.history ? { messageWindow: { ...window, tail: { ...window.tail, messages: optimistic.messages } } } : {}) });
  const ok = await guard(title, async () => { await call(); return true; });
  if (getState().detailSessionId === sessionId && getState().detailEpoch === initial.detailEpoch) {
    if (!ok && before && getState().details[sessionId] === optimistic) setState({ details: { [sessionId]: before }, messageWindow: window });
    // A rewrite from history can replace messages outside the displayed page; reload the authority.
    if (ok && window?.history) await loadLatestMessages(sessionId);
  }
  return Boolean(ok);
}

export const regenerate = (sessionId: string, messageId: string) =>
  rewrite('重新生成失败', sessionId, messages => messages.filter(m => m.id !== messageId), () => gateway.chat.regenerate(sessionId, messageId));

export const editMessage = (sessionId: string, messageId: string, text: string) =>
  rewrite('重新发送失败', sessionId, messages => {
    const index = messages.findIndex(m => m.id === messageId);
    return index < 0 ? messages : [...messages.slice(0, index), { ...messages[index], parts: [{ kind: 'text', text }] }];
  }, () => gateway.chat.edit(sessionId, messageId, text));

export async function branch(sessionId: string, messageId: string) {
  const created = await guard('分叉失败', () => gateway.sessions.branch(sessionId, messageId));
  if (created) { notify('success', '已创建分叉会话', created.title); await openSession(created.id); }
}

export async function promote(sessionId: string, objective: string, acceptance: string[]) {
  const created = await guard('升级为长任务失败', () => gateway.sessions.promote(sessionId, { objective, acceptance }));
  if (created) { notify('success', '已升级为 Cowork 长任务'); await openSession(created.id); }
}

export async function updateSession(id: string, patch: Partial<Pick<SessionSummary, 'title' | 'pinned' | 'permission' | 'modelId' | 'reasoningEffort'>>) {
  const generation = recoveryGeneration.current(), read = recoveryFence.beginRead();
  try {
    const updated = await guard('更新会话失败', () => gateway.sessions.update(id, patch));
    if (updated && recoveryGeneration.isCurrent(generation) && !recoveryFence.wasRemoved(read, id)) {
      const current = getState();
      if (!current.sessions[id] || current.historyFocusId === id) recentDirty = true;
      setState(patchKnownSession(current, updated));
      if (recentDirty && current.view.kind === 'history' && !current.historyPage?.items) void refreshRecentSessions();
    }
  } finally { recoveryFence.endRead(read); }
}

export async function removeProject(id: string) {
  const ok = await guard('取消登记失败', async () => { await gateway.workspace.removeProject(id); return true; });
  if (ok) setState(current => ({ projects: current.projects.filter(p => p.id !== id), projectId: current.projectId === id ? undefined : current.projectId }));
  return Boolean(ok);
}

export async function removeSession(id: string) {
  await guard('删除会话失败', () => gateway.sessions.remove(id));
}

export async function clearSessionHistory() {
  await guard('清除历史失败', async () => {
    await gateway.settings.clearHistory();
    notify('success', '历史已清除');
    setState({ historyPage: undefined });
    await refreshRecentSessions();
  });
}

/** 以下三个设置作用于指定会话；sessionId 缺省时写入新会话草稿。 */
export function setPermission(mode: PermissionMode, sessionId?: string) {
  if (sessionId) void updateSession(sessionId, { permission: mode });
  else setState({ draftPermission: mode });
}

/** 切换模型时推理等级回到该模型的默认值，避免沿用另一模型不存在的等级。 */
export function setModel(modelId: string, sessionId?: string) {
  if (sessionId) void updateSession(sessionId, { modelId, reasoningEffort: undefined });
  else setState({ draftModelId: modelId, draftReasoning: undefined });
}

export function setReasoning(level: string | undefined, sessionId?: string) {
  if (sessionId) void updateSession(sessionId, { reasoningEffort: level });
  else setState({ draftReasoning: level });
}

export async function saveModel(input: ModelProfileInput) {
  const saved = await guard('保存模型配置失败', () => gateway.settings.saveModel(input));
  if (saved) {
    modelsRevision += 1;
    setState(current => ({ models: current.models.some(m => m.id === saved.id) ? current.models.map(m => (m.id === saved.id ? saved : m)) : [...current.models, saved] }));
  }
  return saved;
}

export async function removeModel(modelId: string) {
  const ok = await guard('删除模型配置失败', async () => { await gateway.settings.removeModel(modelId); return true; });
  if (ok) {
    modelsRevision += 1;
    setState(current => ({ models: current.models.filter(m => m.id !== modelId) }));
  }
}

export const decideApproval = (approvalId: string, decision: ApprovalDecision) => guard('提交审批失败', () => gateway.approvals.decide(approvalId, decision));

function withoutTaskPause(state: AppState, taskId: string) {
  const { [taskId]: _settled, ...pending } = state.pendingTaskPauses;
  return pending;
}

export async function controlTask(taskId: string, action: TaskControl, input?: Parameters<typeof gateway.tasks.control>[2]) {
  if (action === 'pause') {
    const state = getState();
    if (state.pendingTaskPauses[taskId]) return;
    const initial = state.details[taskId]?.task;
    const token = Symbol();
    setState({ pendingTaskPauses: { ...state.pendingTaskPauses, [taskId]: token } });
    const task = await guard(initial ? `暂停失败 · ${initial.title}` : '暂停任务失败', () => gateway.tasks.control(taskId, action, input), () => getState().pendingTaskPauses[taskId] === token);
    if (getState().pendingTaskPauses[taskId] !== token) return;
    setState(current => {
      const detail = current.details[taskId];
      const previous = detail?.task;
      // An event can settle this pause first. A late reply must also respect newer task revisions and navigation.
      const authoritative = task?.id === taskId && previous && (previous === initial || (task.revision !== undefined && previous.revision !== undefined && task.revision > previous.revision));
      return { pendingTaskPauses: withoutTaskPause(current, taskId), ...(authoritative ? { details: { ...current.details, [taskId]: { ...detail, task } } } : {}) };
    });
    return;
  }
  const task = await guard('任务控制失败', () => gateway.tasks.control(taskId, action, input));
  if (task && action === 'checkpoint') notify('success', '已创建检查点');
}

export { guard };
