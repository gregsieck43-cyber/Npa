import type { Command, Intent, Message, NpnBridge, Snapshot, Task } from '../contracts.js';
import { arrayValue, displayQuestionReason, displayStatus, errorText, lines, pretty, shortTime, taskIsTerminal } from './view-model.js';
import { append, badge, button, element, empty, field, icon, input, progressiveMessage, richText, select, sectionTitle, statusBadge, testId, textarea } from './dom.js';
import { createPanels } from './panels.js';
import { createEditor } from './editor.js';
import { applyTheme, currentTheme, initializeTheme, themeToggle } from './theme.js';
import type { ActivityReport } from './activity-model.js';
import { groupProjectSessions, renderSessionList } from './sessions.js';
import { openCommandPalette, type PaletteCommand } from './command-palette.js';
import { createChatWorkspace } from './chat-workspace.js';
import { mountFrame, mountSidebar, mountInput, mountHero, mountStats, inputClasses } from './dsh/bridge.js';
import type { AgentMetrics } from '../harness/metrics.js';
import { showMetricsDetails } from './metrics-details.js';
import { filterWork, primaryDestinations, taskNextStep, workFilters, type WorkFilter } from './workspace-model.js';
import { mountTaskIntegrations } from './integration-views.js';

declare global { interface Window { npn: NpnBridge; } }
type RecordData = Record<string, any>;
type ExpandedSnapshot = Snapshot & { totalMessages?: number; runs?: RecordData[]; checkpoints?: RecordData[]; verifications?: RecordData[]; delegations?: RecordData[]; questions?: RecordData[]; candidates?: RecordData[]; budget?: RecordData; sideBudgets?: RecordData[] };
type WorkspaceMode = 'chat' | 'cowork' | 'code';
type Screen = 'chat' | 'work' | 'tasks' | 'code' | 'projects' | 'history' | 'activity' | 'extensions' | 'recovery' | 'settings' | 'web';
type TaskView = 'chat' | 'events' | 'recall' | 'tools' | 'results' | 'collaboration';
interface SideSession { id: string; label: string; messages: Message[]; error?: string; }

const state = {
  mode: 'desktop' as 'desktop' | 'ide', workspaceMode: 'chat' as WorkspaceMode, screen: 'chat' as Screen, view: 'chat' as TaskView,
  modeDrafts: { cowork: '', code: '' }, modeProjects: { cowork: '', code: '' }, modeTasks: { cowork: '', code: '' },
  snapshot: { tasks: [], messages: [], events: [], intents: [], health: {} } as ExpandedSnapshot,
  selectedId: '', healthy: false, health: {} as RecordData, backendError: '', busy: false,
  sideVisible: false, sideSessions: new Map<string, SideSession[]>(), sideSelected: new Map<string, string>(),
  sidePending: new Map<string, { taskId: string; sessionId: string; cancelRequested: boolean }>(),
  sideVisibility: { desktop: false, ide: false }, sideDrafts: new Map<string, string>(), sidebarOpen: false, sidebarCollapsed: false, ideAgentOpen: false, sessionQuery: '', workspaceDraft: '', welcomeDraft: '',
  draft: '', sideDraft: '', recallQuery: '', recallResults: [] as RecordData[], recallSearched: false,
  mainDrafts: new Map<string, { text: string; version: number }>(),
  answerDrafts: new Map<string, string>(), acceptanceDrafts: new Map<string, string>(),
  plugins: [] as RecordData[], candidates: [] as RecordData[], config: undefined as RecordData | undefined,
  settingsResult: '', settingsError: false, lastFailedCommand: undefined as Command | undefined,
  lastCommandError: undefined as { taskId: string; message: string } | undefined,
  lastFingerprint: '', pollActive: false, lastSync: '',
  mcp: [] as RecordData[], instructions: undefined as RecordData | undefined,
  webResults: undefined as RecordData | undefined, webQuery: '', webUrl: '',
  runtimeInfo: undefined as RecordData | undefined, openDetails: new Map<string, boolean>(),
  activity: undefined as ActivityReport | undefined, activityLoading: false, activityError: '', openingIde: false,
  collapsedProjects: new Set<string>(), workFilter: 'all' as WorkFilter, workQuery: '',
};

export type UiState = typeof state;

const app = document.getElementById('app')!;
let shell: HTMLElement;
let main: HTMLElement;
let side: HTMLElement;
let sidebar: HTMLElement;
let frameView: ReturnType<typeof mountFrame>;
let sidebarView: ReturnType<typeof mountSidebar>;
let workStatsView: ReturnType<typeof mountStats> | undefined, workMetrics: AgentMetrics | undefined, workMetricsError = '';
const workViews: { destroy(): void }[] = [];
let rightPanels: HTMLElement;
let topHealth: HTMLElement;
let toastArea: HTMLElement;
let statusbar: HTMLElement;
let activeOperations = 0;
const pendingCommands = new Map<string, Command>();
const pendingToolRequests = new Map<string, string>();
const scrollPositions = new Map<string, number>();
let selectionEpoch = 0;
let refreshPromise: Promise<void> | undefined;
let sidebarFingerprint = '';

function selectedTask(): Task | undefined { return state.snapshot.tasks.find(task => task.id === state.selectedId); }
function taskFingerprint(snapshot: ExpandedSnapshot): string {
  const { selectedTask, messages, events, intents, verifications, delegations, checkpoints } = snapshot;
  return JSON.stringify({ selectedTask, messages, events, intents, verifications, delegations, checkpoints });
}
function setSelection(id: string): void {
  if (id !== state.selectedId) state.draft = state.mainDrafts.get(id)?.text ?? '';
  state.selectedId = id; selectionEpoch++;
  const project = groupProjectSessions(state.snapshot.tasks).find(group => group.tasks.some(task => task.id === id));
  if (project) state.collapsedProjects.delete(project.key);
  if (state.snapshot.selectedTask?.id !== id) state.snapshot = { ...state.snapshot, selectedTask: state.snapshot.tasks.find(task => task.id === id), messages: [], events: [], intents: [], runs: [], checkpoints: [], verifications: [], delegations: [], questions: [] };
}
function toast(message: string, error = false): void {
  const node = element('div', `toast${error ? ' error' : ''}`, message); node.setAttribute('role', error ? 'alert' : 'status');
  toastArea.replaceChildren(node); window.setTimeout(() => node.remove(), error ? 11000 : 5500);
}
async function request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const result = await window.npn.request(method, path, body);
  if (result && result.error) throw new RequestRejected(errorText(result.error), result.code ?? `HTTP_${result.httpStatus}`, result.httpStatus);
  return result as T;
}
class RequestRejected extends Error {
  constructor(message: string, readonly code: string, readonly httpStatus: number) { super(`${code}: ${message}`); }
}
async function run(action: () => Promise<void>, failureLabel?: string): Promise<void> {
  activeOperations++; state.busy = true; paintStatus();
  try { await action(); } catch (error) { toast(failureLabel ? `${failureLabel}失败，请重试或手动选择内容复制。原因：${errorText(error)}` : errorText(error), true); }
  finally { activeOperations--; state.busy = activeOperations > 0; paintStatus(); }
}
function currentSide(): SideSession | undefined {
  return state.sideSessions.get(state.selectedId)?.find(session => session.id === state.sideSelected.get(state.selectedId));
}
function createSide(): SideSession {
  const sessions = state.sideSessions.get(state.selectedId) ?? [];
  const session: SideSession = { id: `side-${crypto.randomUUID()}`, label: `辅助会话 ${sessions.length + 1}`, messages: [] };
  sessions.push(session); state.sideSessions.set(state.selectedId, sessions); state.sideSelected.set(state.selectedId, session.id); return session;
}
function taskScreen(): boolean { return state.screen === 'tasks' || state.screen === 'code'; }
function paintModeSwitch(): void {
  for (const mode of ['chat', 'cowork', 'code'] as const) {
    const node = document.querySelector<HTMLButtonElement>(`[data-testid="mode-${mode}"]`);
    node?.classList.toggle('active', state.workspaceMode === mode);
    node?.setAttribute('aria-pressed', String(state.workspaceMode === mode));
  }
}
function switchWorkspace(mode: WorkspaceMode): void {
  if (state.workspaceMode !== 'chat') {
    state.modeDrafts[state.workspaceMode] = state.welcomeDraft;
    state.modeProjects[state.workspaceMode] = state.workspaceDraft;
    state.modeTasks[state.workspaceMode] = state.selectedId;
  }
  if (state.mode === 'ide') switchMode('desktop');
  state.workspaceMode = mode;
  if (mode !== 'chat') {
    state.welcomeDraft = state.modeDrafts[mode]; state.workspaceDraft = state.modeProjects[mode];
    setSelection(state.modeTasks[mode]);
  }
  state.screen = mode === 'cowork' ? 'work' : mode;
  state.sidebarOpen = false; paintModeSwitch(); paintSidebar(); paintMain(); paintSide(); paintStatus();
  if (mode !== 'chat') void run(async () => refresh(true));
}
function showScreen(screen: Screen): void {
  if (screen === 'work') { switchWorkspace('cowork'); return; }
  if (screen === 'chat' || screen === 'tasks' || screen === 'code') { switchWorkspace(screen === 'tasks' ? 'cowork' : screen); return; }
  if (['chat', 'projects', 'history'].includes(screen) && state.mode === 'ide') switchMode('desktop');
  state.screen = screen; state.sidebarOpen = false; paintSidebar(); paintMain();
  animatePanel(main);
  if (screen === 'settings') { const taskId = state.selectedId, epoch = selectionEpoch; void run(async () => { state.config = await request('GET', '/v1/config'); const instructions = taskId ? await request('GET', `/v1/instructions?taskId=${encodeURIComponent(taskId)}`) : undefined; if (state.selectedId !== taskId || selectionEpoch !== epoch) return; state.instructions = instructions; paintSettings(); }); }
  if (screen === 'extensions') run(loadExtensions);
  if (screen === 'activity') run(loadActivity);
  if (screen === 'recovery') { const taskId = state.selectedId, epoch = selectionEpoch; void run(async () => { await refresh(true); const candidates = arrayValue(await request('GET', '/v1/candidates')); if (state.screen !== 'recovery' || state.selectedId !== taskId || selectionEpoch !== epoch) return; state.candidates = candidates; paintRecovery(); }); }
  if (screen === 'web') run(async () => { state.config = await request('GET', '/v1/config'); paintWeb(); });
}
function selectTask(id: string): void {
  if (!editor.canSwitchTask(id, () => selectTaskNow(id))) return;
  selectTaskNow(id);
}
function selectTaskNow(id: string): void {
  setSelection(id); if (state.workspaceMode === 'chat') state.workspaceMode = 'cowork'; state.screen = state.workspaceMode === 'code' ? 'code' : 'tasks'; state.sideDraft = ''; state.recallQuery = ''; state.recallResults = []; state.recallSearched = false;
  if (state.workspaceMode === 'code') state.workspaceDraft = selectedTask()?.workspace ?? state.workspaceDraft;
  paintModeSwitch();
  state.sidebarOpen = false;
  state.lastFingerprint = ''; paintSidebar(); paintMain(); paintSide();
  run(async () => { await refresh(true); });
}

function toggleSide(): void {
  if (!state.sideVisible && harness.inspector.visible) harness.inspector.toggle(false);
  const restoreTrigger = state.sideVisible && side.contains(document.activeElement);
  state.sideVisible = !state.sideVisible; state.sideVisibility[state.mode] = state.sideVisible; paintSide();
  if (state.sideVisible) animatePanel(side);
  document.querySelector('[data-testid="toggle-sidechat"]')?.setAttribute('aria-pressed', String(state.sideVisible));
  if (restoreTrigger) document.querySelector<HTMLElement>('[data-testid="toggle-sidechat"]')?.focus();
}
function buildShell(): void {
  initializeTheme();
  shell = element('div', 'app-shell mode-desktop'); shell.dataset.mode = 'desktop';
  const top = element('header', 'topbar');
  const sessions = button('', toggleSessions, 'icon-button ghost', 'toggle-sessions'); sessions.append(icon('menu')); sessions.title = '显示或收起会话列表'; sessions.setAttribute('aria-label', sessions.title);
  const breadcrumb = testId(element('div', 'breadcrumb grow', '本地工作空间'), 'workspace-label');
  const quickSearch = button('', showCommands, 'quick-search ghost', 'open-command-palette'); quickSearch.append(icon('search'), element('kbd', '', 'Ctrl K')); quickSearch.title = '搜索会话与操作'; quickSearch.setAttribute('aria-label', quickSearch.title);
  const product = element('span', 'topbar-product', 'NPN Gamma');
  const newTask = button('', () => showGoalModal(), 'top-new-task ghost', 'new-task'); newTask.append(icon('plus'), element('span', '', '新任务')); newTask.title = '新建会话 · Ctrl+N';
  topHealth = button('', () => showScreen('settings'), 'health-button ghost', 'header-health'); topHealth.setAttribute('aria-label', '连接配置与后台状态');
  const helper = button('', toggleSide, 'icon-button ghost', 'toggle-sidechat'); helper.append(icon('panel')); helper.title = '辅助侧聊'; helper.setAttribute('aria-label', helper.title); helper.setAttribute('aria-pressed', 'false');
  const agent = button('', toggleAgent, 'top-agent-toggle ghost', 'toggle-ide-agent'); agent.append(icon('sparkle'), element('span', '', 'Agent')); agent.setAttribute('aria-label', '打开或收起项目 Agent'); agent.setAttribute('aria-expanded', 'false');
  const inspect = button('', () => harness.inspector.toggle(), 'icon-button ghost', 'toggle-inspector'); inspect.append(icon('code')); inspect.title = '检查提示词、请求与轨迹'; inspect.setAttribute('aria-label', inspect.title); inspect.setAttribute('aria-expanded', 'false');
  top.append(sessions, product, breadcrumb, quickSearch, newTask, topHealth, agent, inspect, helper);
  const work = element('div', 'work-area dsh-work-area'); sidebar = element('aside', 'npn-sidebar'); sidebar.setAttribute('aria-label', '会话与导航');
  main = element('main', 'main'); main.id = 'workspace-main'; main.tabIndex = -1; main.setAttribute('aria-label', '当前工作区'); side = element('aside', 'side-panel'); side.setAttribute('aria-label', '辅助侧聊');
  const skip = element('a', 'skip-link', '跳转到工作区'); skip.href = '#workspace-main'; shell.append(skip);
  rightPanels = element('div', 'npn-right-panels'); rightPanels.append(side); harness.inspector.mount(rightPanels); statusbar = element('footer', 'statusbar');
  toastArea = element('div', 'toast-area'); toastArea.setAttribute('aria-live', 'polite');
  shell.append(top, work, toastArea, statusbar);
  app.replaceChildren(shell); frameView = mountFrame(work); sidebarView = mountSidebar(sidebar); paintSidebar(); paintMain(); paintSide(); paintStatus();
  void run(async () => { state.runtimeInfo = await window.npn.desktop('version'); paintSidebar(); });
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key.toLowerCase() === 'k') { event.preventDefault(); showCommands(); }
    else if (event.ctrlKey && event.key.toLowerCase() === 'b') { event.preventDefault(); toggleSessions(); }
    else if (event.ctrlKey && !event.altKey && event.key === '1') { event.preventDefault(); switchWorkspace('chat'); }
    else if (event.ctrlKey && !event.altKey && event.key === '2') { event.preventDefault(); switchWorkspace('cowork'); }
    else if (event.ctrlKey && !event.altKey && event.key === '3') { event.preventDefault(); switchWorkspace('code'); }
    else if (event.ctrlKey && event.key.toLowerCase() === 'n') { event.preventDefault(); if (state.workspaceMode === 'chat') void run(harness.newSession); else showGoalModal(); }
    else if (event.ctrlKey && event.key === ',') { event.preventDefault(); showScreen('settings'); }
    else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'i') { event.preventDefault(); harness.inspector.toggle(); }
    else if (event.key === 'Escape' && !document.querySelector('.modal-overlay')) { if (harness.inspector.visible) { harness.inspector.toggle(false); return; } state.sidebarOpen = false; paintSidebar(); if (state.sideVisible && side.contains(document.activeElement)) toggleSide(); else if (state.mode === 'ide' && state.sideVisible) toggleSide(); else if (state.mode === 'ide' && state.ideAgentOpen) setAgentOpen(false); }
  });
  window.matchMedia('(max-width: 760px)').addEventListener('change', () => paintSidebar());
}
function showCommands(): void {
  const actions: PaletteCommand[] = [
    { id: 'chat', label: 'Chat 自由聊天', detail: '多会话、模型配置与透明请求', group: '工作空间', glyph: 'chat', run: () => showScreen('chat') },
    { id: 'projects', label: 'Projects 项目', detail: '查看项目关联的 Chat 与 Work', group: '工作空间', glyph: 'folder', run: () => showScreen('projects') },
    { id: 'history', label: 'History 请求历史', detail: '查看已持久保存的模型调用', group: '工作空间', glyph: 'history', run: () => showScreen('history') },
    { id: 'new', label: '新建会话', detail: '从一个工作目标开始', group: '工作空间', glyph: 'plus', shortcut: 'Ctrl N', run: () => showGoalModal() },
    { id: 'cowork', label: 'Work 任务', detail: '目标、审批与持续推进', group: '工作空间', glyph: 'work', shortcut: 'Ctrl 2', run: () => switchWorkspace('cowork') },
    { id: 'code', label: 'Code', detail: '项目编码；IDE入口位于视图右上角', group: '工作空间', glyph: 'code', shortcut: 'Ctrl 3', run: () => switchWorkspace('code') },
    { id: 'legacy-editor', label: '旧编辑面板', detail: '保留的 CodeMirror 工具面板；不是专业 IDE', group: '工作空间', glyph: 'code', run: () => switchMode('ide', true) },
    { id: 'activity', label: '任务活动', detail: '查看活动日历与任务记录', group: '工作空间', glyph: 'history', run: () => showScreen('activity') },
    { id: 'web', label: '联网搜索', detail: '检索网页与抓取正文', group: '工作空间', glyph: 'globe', run: () => showScreen('web') },
    { id: 'settings', label: '设置', detail: '模型连接、授权与外观', group: '工作空间', glyph: 'settings', shortcut: 'Ctrl ,', run: () => showScreen('settings') },
    { id: 'theme', label: currentTheme() === 'light' ? '切换深色主题' : '切换暖白主题', detail: '记住你的外观偏好', group: '工作空间', glyph: 'moon', run: () => applyTheme(currentTheme() === 'light' ? 'dark' : 'light') },
  ];
  openCommandPalette(() => [...actions, ...[...state.snapshot.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(task => ({ id: task.id, label: task.title, detail: `${displayStatus(task.status)} · ${task.workspace}`, group: '会话', glyph: 'chat', keywords: task.goal.objective, run: () => selectTask(task.id) }))]);
}
function switchMode(mode: 'desktop' | 'ide', _legacyEditor = false): void {
  state.sideVisibility[state.mode] = state.sideVisible; state.mode = mode; state.sideVisible = state.sideVisibility[mode]; state.screen = 'tasks'; state.sidebarOpen = false;
  shell.classList.toggle('mode-desktop', mode === 'desktop'); shell.classList.toggle('mode-ide', mode === 'ide'); shell.dataset.mode = mode;
  paintModeSwitch();
  document.querySelector('[data-testid="toggle-sidechat"]')?.setAttribute('aria-pressed', String(state.sideVisible));
  paintSidebar(); paintMain(); paintSide(); paintStatus();
  animatePanel(main);
}
function animatePanel(target: HTMLElement): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  target.animate([{ transform: 'translateY(5px)' }, { transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' });
}
function toggleSessions(): void {
  const drawer = state.mode === 'ide' || window.matchMedia('(max-width: 760px)').matches;
  shell.classList.add('sidebar-transition'); window.setTimeout(() => shell.classList.remove('sidebar-transition'), 260);
  if (drawer) state.sidebarOpen = !state.sidebarOpen; else state.sidebarCollapsed = !state.sidebarCollapsed;
  paintSidebar();
  if (state.mode === 'desktop' && (drawer ? state.sidebarOpen : !state.sidebarCollapsed)) animatePanel(sidebar);

}
function setAgentOpen(open: boolean): void {
  const panel = main.querySelector<HTMLElement>('.ide-agent-panel'), restoreTrigger = !open && panel?.contains(document.activeElement);
  state.ideAgentOpen = open; main.classList.toggle('agent-drawer-open', open);
  document.querySelector('[data-testid="toggle-ide-agent"]')?.setAttribute('aria-expanded', String(open));
  if (open && panel && window.matchMedia('(max-width: 900px)').matches) animatePanel(panel);
  else if (restoreTrigger) document.querySelector<HTMLElement>('[data-testid="toggle-ide-agent"]')?.focus();
}
function toggleAgent(): void {
  const open = !state.ideAgentOpen || state.screen !== 'tasks' || state.sideVisible;
  if (state.screen !== 'tasks') { state.screen = 'tasks'; paintSidebar(); paintMain(); }
  if (open && state.sideVisible) toggleSide();
  setAgentOpen(open);
}
function showRuntimeIdentity(): void {
  const dialog = showModal('当前运行版本', '用于核对你打开的 EXE 与它保存数据的位置');
  dialog.body.append(element('pre', 'runtime-identity', state.runtimeInfo ? `版本 ${state.runtimeInfo.version}\n安装位置 ${state.runtimeInfo.packageRoot}\n数据目录 ${state.runtimeInfo.dataDir}\n可选工作区边界 ${state.runtimeInfo.workspaceBoundary}` : '尚未取得运行包元数据。'));
}
function paintSidebar(): void {
  const drawer = window.matchMedia('(max-width: 760px)').matches;
  const compact = state.mode === 'ide' && !state.sidebarOpen;
  const fingerprint = JSON.stringify({ tasks: state.snapshot.tasks.map(({ id, title, status, updatedAt }) => [id, title, status, updatedAt]), selectedId: state.selectedId, screen: state.screen, mode: state.mode, open: state.sidebarOpen, collapsed: state.sidebarCollapsed, drawer, version: state.runtimeInfo?.version });
  if (fingerprint === sidebarFingerprint) return;
  sidebarFingerprint = fingerprint;
  sidebar.inert = drawer ? !state.sidebarOpen : state.mode === 'desktop' && state.sidebarCollapsed;
  const expanded = drawer || state.mode === 'ide' ? state.sidebarOpen : !state.sidebarCollapsed;
  for (const id of ['toggle-sessions', 'chat-toggle-conversations']) document.querySelector('[data-testid="' + id + '"]')?.setAttribute('aria-expanded', String(expanded));
  const region = element('div', 'npn-sidebar-content');
  if (state.workspaceMode === 'chat') harness.mountNavigation(region);
  else {
    const search = input(state.sessionQuery, '搜索项目与任务', 'session-search'); search.setAttribute('aria-label', '搜索任务');
    region.append(append(element('div', 'session-search'), icon('search'), search), append(element('div', 'session-list-label'), element('span', '', '项目与任务'), element('span', '', String(state.snapshot.tasks.length))));
    const list = element('div', 'task-list');
    const paintList = () => renderSessionList(list, { tasks: state.snapshot.tasks, query: state.sessionQuery, selectedId: state.selectedId, active: taskScreen(), collapsed: state.collapsedProjects, selectTask });
    search.addEventListener('input', () => { state.sessionQuery = search.value; paintList(); }); paintList(); region.append(list);
  }
  const footer = element('div', 'npn-sidebar-footer');
  const code = button('', () => showScreen('code'), 'ghost secondary-code-entry', 'mode-code'); code.append(icon('code'), 'Code', element('span', 'tiny muted', '项目与 IDE')); code.title = 'Code 项目工作区 · Ctrl+3'; code.setAttribute('aria-current', state.screen === 'code' ? 'page' : 'false'); footer.append(code);
  const more = element('details', 'npn-sidebar-more'); more.append(element('summary', '', compact ? '···' : '工具与维护'));
  for (const [screen, glyph, label] of [['activity', 'history', '真实活动'], ['web', 'globe', '网页检索'], ['extensions', 'plug', '插件与 MCP'], ['recovery', 'shield', '恢复与适配']] as const) {
    const node = button('', () => showScreen(screen), 'ghost', 'nav-' + screen); node.append(icon(glyph), label); more.append(node);
  }
  const version = button(state.runtimeInfo ? 'v' + state.runtimeInfo.version : '本地', showRuntimeIdentity, 'product-version ghost', 'product-version');
  footer.append(more, append(element('div', 'npn-footer-row'), ...(compact ? [] : [version]), themeToggle()));
  const brand = append(element('span', 'npn-dsh-brand'), element('strong', '', 'NPN Gamma'));
  sidebarView.update({ collapsed: compact, brand, region, footer, newLabel: state.workspaceMode === 'chat' ? '新对话' : '新建任务', newSession: () => state.workspaceMode === 'chat' ? void run(harness.newSession) : showGoalModal(), toggle: toggleSessions,
    routes: primaryDestinations.map(({ screen, glyph, label, caption, id }) => ({ id, label, caption, icon: icon(glyph), active: state.screen === screen || screen === 'work' && state.screen === 'tasks', onClick: () => showScreen(screen) })) });
  frameView.update({ sidebar, main, right: rightPanels, collapsed: state.sidebarCollapsed, drawerOpen: state.sidebarOpen, ide: state.mode === 'ide' });
}
function paintStatus(): void {
  const health = state.health;
  topHealth.replaceChildren(badge(state.healthy ? (health.provider === 'live' || health.provider?.mode === 'live' ? 'Live' : 'Mock') : '未连接', state.healthy ? 'live' : 'warning'));
  const task = selectedTask(); const workspace = document.querySelector('[data-testid="workspace-label"]'); if (workspace) { const name = (task?.workspace ?? state.workspaceDraft).split(/[/\\]/).filter(Boolean).at(-1); workspace.textContent = task ? (name && name !== task.id && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(name) ? `${name} / ${task.title}` : task.title) : (name ?? '本地工作空间'); (workspace as HTMLElement).title = task?.workspace ?? state.workspaceDraft; }
  if (workspace && state.screen !== 'tasks') { workspace.textContent = ''; (workspace as HTMLElement).title = ''; }
  const agent = document.querySelector<HTMLElement>('[data-testid="toggle-ide-agent"]'), pending = state.snapshot.intents.filter(intent => intent.state === 'prepared').length;
  if (agent) { agent.querySelector('span')!.textContent = pending ? `Agent · ${pending}` : 'Agent'; agent.classList.toggle('has-approvals', pending > 0); agent.title = pending ? `${pending} 个工具动作待批准 · 打开项目 Agent` : '打开项目 Agent · 聊天与任务进度'; agent.setAttribute('aria-expanded', String(state.ideAgentOpen)); }
  statusbar.replaceChildren();
  statusbar.append(append(element('div', 'statusbar-left'), element('span', 'connection-state', `${state.healthy ? '●' : '○'} ${state.healthy ? '后台在线' : '连接诊断'}`), element('span', '', state.mode === 'ide' ? 'IDE 工作区' : '桌面会话'), element('span', '', state.busy ? '正在提交…' : `${state.snapshot.tasks.length} 个任务`)), append(element('div', 'statusbar-right'), element('span', '', state.lastSync ? `同步 ${state.lastSync}` : '读取状态中'), element('span', '', 'Ctrl+1 Chat · Ctrl+2 Cowork · Ctrl+3 Code')));
}
function paintMain(): void {
  for (const view of workViews.splice(0)) view.destroy(); workStatsView = undefined;
  shell.dataset.screen = state.screen;
  if (taskScreen()) state.lastFingerprint = taskFingerprint(state.snapshot);
  const restoreFocus = rememberFocus(main); const oldContent = main.querySelector<HTMLElement>('.task-content');
  if (oldContent && main.dataset.taskId) scrollPositions.set(`${main.dataset.taskId}:${main.dataset.view}`, oldContent.scrollHeight - oldContent.scrollTop - oldContent.clientHeight < 100 && main.dataset.view === 'chat' ? -1 : oldContent.scrollTop);
  main.replaceChildren(); main.classList.remove('harness-screen'); main.classList.toggle('ide-main', state.mode === 'ide' && taskScreen()); main.classList.toggle('agent-drawer-open', state.ideAgentOpen);
  if (!['chat', 'projects', 'history'].includes(state.screen)) harness.leave(taskScreen() ? selectedTask() : undefined);
  main.dataset.taskId = state.selectedId; main.dataset.view = state.view;
  if (state.screen === 'chat' || state.screen === 'projects' || state.screen === 'history') harness.open(state.screen, main);
  else if (state.screen === 'work') paintWorkOverview();
  else if (state.screen === 'settings') paintSettings();
  else if (state.screen === 'extensions') paintExtensions();
  else if (state.screen === 'recovery') paintRecovery();
  else if (state.screen === 'activity') paintActivity();
  else if (state.screen === 'web') paintWeb();
  else if (state.screen === 'code') paintCodeWorkspace();
  else { const task = selectedTask(); if (state.mode === 'ide') paintIDE(task); else if (task) paintTaskSurface(main, task); else paintWelcome(main); }
  const content = main.querySelector<HTMLElement>('.task-content'); const position = scrollPositions.get(`${state.selectedId}:${state.view}`);
  if (content && position !== undefined) content.scrollTop = position === -1 ? content.scrollHeight : position;
  restoreFocus();
}
function rememberFocus(container: HTMLElement): () => void {
  const focused = document.activeElement as HTMLElement | null; const id = focused?.dataset.testid;
  if (!focused || !id || !container.contains(focused)) return () => undefined;
  const start = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement ? focused.selectionStart : null;
  const end = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement ? focused.selectionEnd : null;
  return () => { const next = container.querySelector<HTMLElement>(`[data-testid="${CSS.escape(id)}"]`); if (!next) return; next.focus({ preventScroll: true }); if (start !== null && end !== null && (next instanceof HTMLTextAreaElement || next instanceof HTMLInputElement)) next.setSelectionRange(start, end); };
}
function paintWorkOverview(): void {
  const page = testId(element('div', 'work-overview page-scroll'), 'work-overview');
  const heading = append(element('header', 'workspace-page-heading'), append(element('div', 'grow'), element('h1', '', 'Work'), element('p', 'muted', '目标、执行与验收。需要你决定的事，留在这里。')), button('新建任务', () => showGoalModal(), 'primary', 'work-create'));
  const query = input(state.workQuery, '查找目标或项目', 'work-search'); query.setAttribute('aria-label', '查找工作任务');
  const filters = element('div', 'work-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '任务状态筛选');
  const list = testId(element('div', 'work-list'), 'work-list');
  const render = () => {
    for (const node of filters.querySelectorAll<HTMLButtonElement>('button')) node.setAttribute('aria-pressed', String(node.dataset.filter === state.workFilter));
    list.replaceChildren(); const tasks = filterWork(state.snapshot.tasks, state.workFilter, state.workQuery);
    if (!tasks.length) {
      list.append(append(element('div', 'work-empty'), icon('work'), element('h2', '', state.snapshot.tasks.length ? '没有匹配的任务' : '从一个明确的目标开始'), element('p', 'muted', state.snapshot.tasks.length ? '尝试其他状态或更短的关键词。任务记录不会因筛选消失。' : '告诉 Gamma 要完成的结果，设置工作区与预算。工具动作会按规则等待你的批准。'), button(state.snapshot.tasks.length ? '清除筛选' : '创建工作目标', () => { if (!state.snapshot.tasks.length) showGoalModal(); else { state.workQuery = ''; query.value = ''; state.workFilter = 'all'; render(); } }, 'small')));
      return;
    }
    for (const task of tasks) {
      const row = button('', () => selectTask(task.id), 'work-row', `work-task-${task.id}`);
      const project = task.workspace.split(/[/\\]/).filter(Boolean).at(-1) ?? '独立任务';
      row.append(append(element('div', 'work-row-title'), element('strong', '', task.title), statusBadge(task)), element('p', 'work-row-next', taskNextStep(task)), append(element('div', 'work-row-meta'), element('span', '', project), element('time', '', new Date(task.updatedAt).toLocaleString()), element('span', 'work-row-open', '打开任务')));
      list.append(row);
    }
  };
  for (const [id, label] of workFilters) { const node = button(label, () => { state.workFilter = id; render(); }, 'small ghost'); node.dataset.filter = id; filters.append(node); }
  query.addEventListener('input', () => { state.workQuery = query.value; render(); });
  page.append(heading, append(element('div', 'work-toolbar'), filters, query));
  if (state.backendError) page.append(notice(state.backendError, 'error', button('重新连接', () => run(async () => refresh(true)), 'small')));
  page.append(list); main.append(page); render();
}
function paintCodeWorkspace(): void {
  const task = selectedTask(), workspace = task?.workspace || state.workspaceDraft;
  const name = workspace.split(/[/\\]/).filter(Boolean).at(-1);
  const heading = element('header', 'code-heading');
  const project = button('', () => void run(async () => {
    const chosen = await window.npn.desktop('select-workspace'); if (!chosen) return;
    state.modeProjects.code = chosen;
    if (state.workspaceMode !== 'code') return;
    state.workspaceDraft = chosen; setSelection(''); state.modeTasks.code = ''; paintMain(); paintSidebar();
  }), 'small ghost code-project', 'code-project');
  project.append(icon('folder'), name || 'Select project'); project.title = workspace || 'Choose a project folder'; project.disabled = state.openingIde;
  const ide = button('IDE ↗', () => {
    if (state.openingIde) return;
    state.openingIde = true; ide.disabled = true; project.disabled = true;
    void run(async () => {
      const result = await window.npn.desktop('open-ide', { workspace: workspace || undefined });
      if (result?.cancelled) return;
      if (!result?.pid) throw new Error('IDE 未返回启动确认。');
      if (!workspace && result.workspace) {
        state.modeProjects.code = result.workspace;
        if (state.workspaceMode === 'code' && !state.workspaceDraft) { state.workspaceDraft = result.workspace; paintMain(); }
      }
      toast('IDE 已启动；编辑保存独立于 Agent，后台保持运行。');
    }).finally(() => {
      state.openingIde = false;
      document.querySelector<HTMLButtonElement>('[data-testid="open-native-ide"]')?.removeAttribute('disabled');
      document.querySelector<HTMLButtonElement>('[data-testid="code-project"]')?.removeAttribute('disabled');
    });
  }, 'small ghost code-ide-entry', 'open-native-ide');
  ide.disabled = state.openingIde; ide.title = 'Open the native IDE for this project';
  heading.append(project, element('span', 'grow'), ide); main.append(heading);
  if (task) { paintTaskSurface(main, task); return; }
  const welcome = element('div', 'npn-hero-mount code-home');
  const text = textarea(state.welcomeDraft, 'Plan, build, or fix something in your project…', 'code-goal');
  text.setAttribute('aria-label', 'Code goal'); text.addEventListener('input', () => { state.welcomeDraft = text.value; state.modeDrafts.code = text.value; });
  const start = () => showGoalModal(text.value.trim());
  text.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); start(); } });
  const send = button('', start, inputClasses.primary, 'code-start'); send.append(icon('arrow')); send.setAttribute('aria-label', 'Create coding task');
  const controls = append(element('div'), button('模型与执行配置', () => showScreen('settings'), 'small ghost composer-model'), send);
  const composer = element('div'); const inputView = mountInput(composer); workViews.push(inputView);
  inputView.update({ editor: text, attachments: element('div'), controls, status: element('div'), hero: true });
  const hint = element('p', 'tiny muted code-home-hint', '选择项目并明确目标后再开始执行。打开 IDE 不创建任务，也不调用模型。');
  const hero = mountHero(welcome); workViews.push(hero); hero.update({ composer, activity: hint, workspace: element('div', 'code-home-project', name || 'Choose a project to get started'), title: 'What will you build?' });
  main.append(welcome);
}
function paintWelcome(target: HTMLElement, compact = false): void {
  const node = element('div', `empty-state${compact ? ' compact' : ''}`);
  node.append(append(element('div', 'welcome-emblem'), icon('sparkle')), element('h2', '', compact ? '为项目创建一个任务' : '把想法，推进到完成。'), element('p', '', compact ? '选择工作区，告诉 Agent 要实现或修复的结果。' : '写下目标，让 Agent 研究、构建与验证。\n长任务，也可以一步一步从容完成。'));
  const draft = textarea(state.welcomeDraft, '你想实现什么？交给 Gamma 一起完成…', 'welcome-message'); draft.setAttribute('aria-label', '新任务目标');
  draft.addEventListener('input', () => { state.welcomeDraft = draft.value; });
  const start = () => showGoalModal(draft.value.trim());
  const composer = element('div', 'welcome-composer'); const create = button('', start, 'primary', 'welcome-create-task'); create.append('开始', icon('arrow'));
  const workspace = button('', () => run(chooseWorkspace), 'workspace-chip ghost small', 'choose-workspace'); workspace.append(icon('folder'), state.workspaceDraft.split(/[/\\]/).at(-1) || '选择项目文件夹'); workspace.title = state.workspaceDraft || '选择项目文件夹';
  composer.append(draft, append(element('div', 'welcome-composer-bottom'), workspace, create)); node.append(composer);
  draft.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); start(); } });
  if (!compact) {
    const examples = element('div', 'start-examples');
    const items = [['code', '打磨一个项目', '读懂代码，再做可靠的改进', '检查当前工作区的项目，说明结构与可以改进的地方。'], ['globe', '深入一个问题', '搜索资料，留下可核对的来源', '围绕当前项目的技术选型进行联网研究，列出可靠来源、主要差异与具体建议。'], ['sparkle', '推进长期目标', '拆解目标，逐步验证结果', '为当前项目制定实施计划，并将可独立验证的部分拆成子任务。']];
    for (const [glyph, title, caption, goal] of items) examples.append(append(button('', () => showGoalModal(goal), 'example-card'), icon(glyph), element('strong', '', title), element('span', '', caption)));
    node.append(examples);
  }
  target.append(node);
  if (state.backendError) target.prepend(notice(state.backendError, 'error', button('重新连接', () => run(async () => refresh(true)), 'small', 'reconnect-backend')));
}
async function chooseWorkspace(): Promise<void> {
  const chosen = await window.npn.desktop('select-workspace'); if (!chosen) return;
  state.workspaceDraft = chosen; showGoalModal(state.welcomeDraft);
}
function taskControls(task: Task): HTMLElement {
  const controls = element('div', 'row wrap');
  const retry = button('↻ 重试', () => run(async () => sendCommand('retry')), 'small ghost', 'task-retry');
  retry.title = '发送带独立 ID 的重试控制事件，不追加“继续”消息'; retry.disabled = task.status === 'running' || task.status === 'completed' || task.status === 'cancelled' || task.status === 'reconciling';
  const pause = task.status === 'paused' ? button('▷ 恢复', () => run(async () => sendCommand('resume')), 'small', 'task-resume') : button('Ⅱ 暂停', () => run(async () => sendCommand('pause')), 'small ghost', 'task-pause');
  pause.disabled = taskIsTerminal(task) || task.status === 'failed';
  const cancel = button('取消', () => showConfirm('取消当前任务', '取消会终止后续调度、撤销未执行授权，并同步取消其子任务。已发送的未知效果仍会保留等待对账。', '确认取消', () => run(async () => sendCommand('cancel'))), 'small danger ghost', 'task-cancel');
  cancel.disabled = taskIsTerminal(task); controls.append(retry, pause, cancel); return controls;
}
function paintTaskHeader(target: HTMLElement, task: Task): void {
  const optionsOpen = target.querySelector<HTMLDetailsElement>('.task-options')?.open ?? false;
  target.replaceChildren();
  const title = append(element('div', 'grow task-title'), button('Work / 全部任务', () => showScreen('work'), 'small ghost task-back', 'work-back'), element('h1', '', task.title)); title.title = task.goal.objective;
  const top = append(element('div', 'row spread'), title, taskControls(task));
  const budget = state.snapshot.budget;
  const sub = append(element('div', 'task-header-sub'), statusBadge(task), element('span', '', task.goal.mode === 'autonomous' ? '自主推进' : '协作'), element('span', 'budget-label', `模型 ${task.modelCalls}/${task.goal.maxModelCalls}${budget ? ` · 工具 ${budget.toolCalls}/${budget.maxToolCalls}` : ''}`));
  const options = element('details', 'task-options'); options.open = optionsOpen; options.append(element('summary', '', '更多操作'), button('调整目标', () => showGoalRevision(task), 'small ghost', 'revise-goal'), button('增加预算', () => showBudgetRenewal(task), 'small ghost', 'renew-budget')); sub.append(button('Inspector', () => harness.inspector.toggle(), 'small ghost', 'work-inspector'), options);
  target.append(top, sub, element('p', 'task-next-step', taskNextStep(task)));
}
function notice(text: string, tone: 'warning' | 'error' | '' = '', action?: HTMLElement): HTMLElement {
  return append(element('div', `notice ${tone}`), element('span', 'notice-icon', tone === 'error' ? '!' : '◇'), element('div', 'grow', text), action);
}
function paintNotices(target: HTMLElement, task: Task): void {
  target.replaceChildren();
  if (state.backendError) target.append(notice(state.backendError, 'error', button('重新连接', () => run(async () => refresh(true)), 'small', 'reconnect-backend')));
  if (state.lastCommandError?.taskId === task.id) target.append(testId(notice(`控制操作未被接受：${state.lastCommandError.message}`, 'error', button('刷新任务状态', () => run(async () => refresh(true)), 'small', 'refresh-command-state')), 'command-error'));
  if (state.lastFailedCommand) target.append(notice('控制请求未取得确认。可重发同一请求 ID，后台将对重复请求去重。', 'warning', button('重发同一请求', () => run(async () => { const command = state.lastFailedCommand!; const result = await sendCommand(command.type, command.parameters, command.taskId); toast(`控制请求已确认：${result.status}`); }), 'small', 'retry-control-request')));
  const pending = state.snapshot.intents.filter(intent => intent.state === 'prepared');
  if (pending.length && state.view !== 'tools') target.append(notice(`${pending.length} 个工具动作等待你的明确批准。批准绑定动作内容和当前任务授权版本。`, 'warning', button('查看审批', () => setTaskView('tools'), 'small', 'view-approvals')));
  if (task.status === 'waiting_input' && state.snapshot.verifications?.some(item => item.record?.requiresManual) && state.view !== 'results') target.append(notice('执行结果等待人工验收。请核对实际工件并记录证据。', 'warning', button('核对验收', () => setTaskView('results'), 'small', 'view-manual-acceptance')));
  if (task.error) target.append(notice(`${displayStatus(task.status)}：${task.error}`, 'error', button('诊断与恢复', () => showScreen('recovery'), 'small', 'open-diagnostics')));
  else if (task.waitingReason && !pending.length) target.append(notice(task.waitingReason, task.status === 'reconciling' ? 'warning' : ''));
}
function paintTaskSurface(target: HTMLElement, task: Task): void {
  const header = element('div', 'task-header task-header-region'); paintTaskHeader(header, task);
  const notices = element('div', 'notices-region'); paintNotices(notices, task);
  const tabs = element('nav', 'tabs'); tabs.setAttribute('aria-label', '任务详情'); tabs.setAttribute('role', 'tablist');
  const views: [TaskView, string][] = [['chat', '对话'], ['tools', '工具'], ['collaboration', '协作'], ['results', '验收'], ['events', '活动'], ['recall', '历史']];
  views.forEach(([view, label], index) => { const node = button(label, () => setTaskView(view), state.view === view ? 'active' : '', `view-${view}`); node.dataset.view = view; node.setAttribute('role', 'tab'); node.setAttribute('aria-selected', String(state.view === view)); node.addEventListener('keydown', event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const next = views[(index + (event.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length][0]; setTaskView(next); main.querySelector<HTMLButtonElement>(`[data-testid="view-${next}"]`)?.focus(); } }); tabs.append(node); });
  const content = element('div', 'content task-content'); content.dataset.testid = 'task-content';
  target.append(header, notices, tabs, content); paintTaskContent(content, task);
  target.append(state.view === 'chat' ? makeComposer(task) : makeWorkStats(task));
}
function setTaskView(view: TaskView): void { state.view = view; if (state.mode === 'ide') { state.ideAgentOpen = true; if (state.sideVisible) toggleSide(); } paintMain(); document.querySelector('[data-testid="toggle-ide-agent"]')?.setAttribute('aria-expanded', String(state.ideAgentOpen)); const content = main.querySelector<HTMLElement>('.task-content'); if (content) animatePanel(content); }
function paintTaskContent(target: HTMLElement, task: Task): void {
  const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 110;
  const oldScroll = target.scrollTop; target.replaceChildren();
  if (state.view === 'chat') paintConversation(target, task);
  else if (state.view === 'events') paintEvents(target);
  else if (state.view === 'recall') paintRecall(target);
  else if (state.view === 'tools') paintTools(target, task);
  else if (state.view === 'results') paintResults(target, task);
  else if (state.view === 'collaboration') paintCollaboration(target, task);
  target.scrollTop = state.view === 'chat' && atBottom ? target.scrollHeight : oldScroll;
}
function messageNode(message: Message): HTMLElement {
  const roleNames = { user: '你', assistant: 'NPN Agent', tool: '工具结果', system: '系统记录' };
  const avatarNames = { user: 'YOU', tool: '↗', system: 'S' };
  const node = element('article', `message ${message.role}`); node.dataset.messageId = message.id;
  const body = element('div', 'message-body');
  body.append(append(element('div', 'message-label'), roleNames[message.role], element('time', '', shortTime(message.createdAt))));
  if (message.role === 'tool') {
    const detail = preservedDisclosure('工具返回 · 查看内容', `message:${message.id}`, 'inline-tool-output'); detail.append(element('pre', '', message.content)); body.append(detail);
  } else {
    const content = (message.displayContent ?? message.content) || (message.toolCalls?.length ? '准备执行以下工具动作' : '');
    body.append(progressiveMessage(content, () => message.role === 'assistant' ? formattedMessage(content) : element('div', 'message-content', content), state.openDetails.get(`long:${message.id}`), open => state.openDetails.set(`long:${message.id}`, open)));
  }
  if (message.role !== 'assistant') node.append(element('div', `avatar ${message.role}`, avatarNames[message.role]));
  node.append(body); return node;
}
function formattedMessage(content: string): HTMLElement {
  const node = element('div', 'message-content'); node.append(richText(content, {
    copyText: text => { void run(async () => { await window.npn.desktop('copy-text', { text }); toast('代码已复制。'); }, '复制代码'); },
    copySource: url => { void run(async () => { await window.npn.desktop('copy-source', { url }); toast('来源地址已复制。'); }, '复制来源地址'); },
  })); return node;
}
function preservedDisclosure(label: string, key: string, className = '', defaultOpen = false): HTMLDetailsElement {
  const detail = element('details', className); detail.open = state.openDetails.get(key) ?? defaultOpen;
  const summary = element('summary', '', label); summary.addEventListener('click', () => { state.openDetails.set(key, !detail.open); }); detail.append(summary); return detail;
}
function paintConversation(target: HTMLElement, task: Task): void {
  const conversation = element('div', 'conversation');
  const messages = state.snapshot.messages.filter(message => message.sessionId === 'main');
  if (!messages.length) {
    const card = element('div', 'card'); card.append(element('h3', '', '目标已保存'), element('p', '', task.goal.objective));
    if (task.goal.acceptance.length) card.append(element('div', 'subtle-box', `验收标准\n${task.goal.acceptance.map((line, i) => `${i + 1}. ${line}`).join('\n')}`));
    conversation.append(card);
  }
  const shown = new Set<string>();
  for (const message of messages) {
    conversation.append(messageNode(message));
    for (const call of message.toolCalls ?? []) { const intent = state.snapshot.intents.find(item => item.toolCallId === call.id); if (intent) { conversation.append(intentCard(intent)); shown.add(intent.id); } }
  }
  for (const intent of state.snapshot.intents.filter(item => item.state === 'prepared' && !shown.has(item.id))) conversation.append(intentCard(intent));
  const startIndex = state.snapshot.events.findLastIndex(event => event.type === 'model.stream.started');
  const stream = startIndex < 0 ? [] : state.snapshot.events.slice(startIndex + 1);
  if (task.status === 'running' && !stream.some(event => event.type === 'model.stream.completed' || event.type === 'model.stream.failed')) {
    const text = String(stream.findLast(event => event.type === 'model.stream.delta')?.payload.text ?? '');
    const bubble = testId(element('article', 'message assistant streaming'), 'model-stream'); const body = element('div', 'message-body'); body.append(element('div', 'message-label', 'NPN Agent'), formattedMessage(text || '正在思考…')); bubble.append(body); conversation.append(bubble);
  } else if (task.status === 'running') conversation.append(append(element('div', 'row muted pending-state tiny'), element('span', 'dot'), '正在推进…'));
  if (task.status === 'waiting_children') conversation.append(testId(notice('主任务正在等待子任务结果。可以在协作页查看进度、结果与取消操作。', '', button('查看协作', () => setTaskView('collaboration'), 'small', 'view-waiting-children')), 'waiting-children'));
  if (task.status === 'waiting_input') conversation.append(questionCard(task));
  if (task.status === 'completed') conversation.append(notice('本轮执行已通过独立验收。你可以在“验收结果”查看证据。', '', button('查看结果', () => setTaskView('results'), 'small')));
  if ((state.snapshot.totalMessages ?? 0) > messages.length) conversation.prepend(button(`查看完整历史 · ${state.snapshot.totalMessages} 条`, () => showWorkHistory(task), 'small ghost', 'work-message-history'));
  target.append(conversation, element('div', 'scroll-anchor'));
}
function showWorkHistory(task: Task) {
  const dialog = showModal('任务消息历史', '原始记录保留在本机，每次载入 100 条。');
  let cursor: number | null = null;
  const list = element('div', 'history-messages'), navigation = element('div', 'row');
  const load = async (before?: number) => {
    const page = await request<{ messages: Message[]; nextCursor: number | null }>('GET', `/v1/tasks/${task.id}/messages?limit=100${before ? `&before=${before}` : ''}`);
    cursor = page.nextCursor; list.replaceChildren(...page.messages.map(messageNode)); older.disabled = cursor === null;
  };
  const older = button('更早的消息', () => run(async () => { if (cursor) await load(cursor); }), 'small');
  navigation.append(older, button('回到最新', () => run(async () => load()), 'small ghost')); dialog.body.append(navigation, list); run(async () => load());
}
function questionCard(task: Task): HTMLElement {
  const questions = arrayValue(state.snapshot.questions);
  const question = [...questions].reverse().find(item => item.state !== 'answered');
  const card = element('div', 'card');
  card.append(element('h3', '', '需要你的判断'), element('p', '', question?.question ?? question?.content ?? task.waitingReason ?? '补充信息后，任务会按已保存目标继续推进。'));
  if (question?.reason) card.append(testId(element('div', 'tiny muted', `提出原因：${displayQuestionReason(question.reason)}`), 'question-reason'));
  const draftKey = `${task.id}:${question?.id ?? 'current'}`;
  const answer = textarea(state.answerDrafts.get(draftKey) ?? '', '填写答案或明确选择', 'question-answer'); answer.dataset.draftKey = draftKey;
  answer.addEventListener('input', () => { state.answerDrafts.set(draftKey, answer.value); });
  card.append(answer, append(element('div', 'form-actions'), button('提交回答', () => {
    const submitted = answer.value; if (!submitted.trim()) return;
    run(async () => {
      await sendCommand('answer', { answer: submitted.trim(), questionId: question?.id }, task.id);
      if (state.answerDrafts.get(draftKey) === submitted) {
        state.answerDrafts.delete(draftKey);
        const current = main.querySelector<HTMLTextAreaElement>('[data-testid="question-answer"]'); if (current?.dataset.draftKey === draftKey) current.value = '';
      }
    });
  }, 'primary small', 'submit-answer')));
  return card;
}
function makeComposer(task: Task): HTMLElement {
  const wrap = element('div', 'composer-wrap');
  const draft = textarea(state.draft, taskIsTerminal(task) ? '任务已结束，可新建目标或查看结果' : '给 Agent 补充信息…', 'main-message');
  draft.disabled = taskIsTerminal(task); draft.setAttribute('aria-label', '主任务消息');
  draft.addEventListener('input', () => { state.draft = draft.value; state.mainDrafts.set(task.id, { text: draft.value, version: (state.mainDrafts.get(task.id)?.version ?? 0) + 1 }); });
  const submit = button('', () => submitMainMessage(draft), inputClasses.primary, 'send-main-message'); submit.append(icon('arrow')); submit.title = '发送 · Enter'; submit.setAttribute('aria-label', '发送主任务消息'); submit.disabled = taskIsTerminal(task);
  const context = append(element('span', 'composer-context'), icon(task.goal.mode === 'autonomous' ? 'sparkle' : 'chat'), task.goal.mode === 'autonomous' ? '自主推进' : '协作模式');
  const controls = append(element('div'), context, element('span', 'grow'), submit);
  draft.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submitMainMessage(draft); } });
  const status = makeWorkStats(task), inputView = mountInput(wrap); workViews.push(inputView);
  inputView.update({ editor: draft, attachments: element('div'), controls, status }); return wrap;
}
function makeWorkStats(task: Task): HTMLElement {
  const target = testId(element('div', 'work-agent-stats'), 'work-agent-stats');
  if (workMetrics?.scopeId !== task.id) { workMetrics = undefined; workMetricsError = ''; }
  workStatsView = mountStats(target); workViews.push(workStatsView); updateWorkStats(); return target;
}
function updateWorkStats(): void {
  workStatsView?.update({ data: workMetrics, error: workMetricsError, onDetails: () => showMetricsDetails({ showModal }, workMetrics), onInspect: tab => harness.inspector.openTab(tab) });
}
function submitMainMessage(draft: HTMLTextAreaElement): void {
  const content = draft.value.trim(); if (!content || taskIsTerminal(selectedTask()!)) return;
  const taskId = state.selectedId, version = state.mainDrafts.get(taskId)?.version;
  void run(async () => {
    await sendCommand('send_message', { content }, taskId);
    const currentDraft = state.mainDrafts.get(taskId); if (!currentDraft || currentDraft.version !== version) return;
    state.mainDrafts.set(taskId, { text: '', version: currentDraft.version + 1 });
    if (state.selectedId !== taskId) return;
    state.draft = ''; const current = main.querySelector<HTMLTextAreaElement>('[data-testid="main-message"]'); if (current) current.value = '';
  });
}
async function sendCommand(type: string, parameters: RecordData = {}, taskId = state.selectedId): Promise<any> {
  const task = state.snapshot.tasks.find(item => item.id === taskId);
  const commandTaskId = type === 'create_task' ? undefined : taskId;
  const key = JSON.stringify({ type, taskId: commandTaskId, parameters });
  const command: Command = pendingCommands.get(key) ?? { commandId: crypto.randomUUID(), type, taskId: commandTaskId, expectedRevision: type === 'create_task' ? undefined : task?.revision, parameters };
  pendingCommands.set(key, command);
  let result: any;
  try { result = await request('POST', '/v1/commands', command); }
  catch (error) {
    if (error instanceof RequestRejected) { pendingCommands.delete(key); if (state.lastFailedCommand?.commandId === command.commandId) state.lastFailedCommand = undefined; }
    else state.lastFailedCommand = command;
    state.lastCommandError = { taskId, message: errorText(error) };
    const notices = main.querySelector('.notices-region') as HTMLElement, selected = selectedTask();
    if (selected && notices) paintNotices(notices, selected);
    throw error;
  }
  pendingCommands.delete(key); if (state.lastFailedCommand?.commandId === command.commandId) state.lastFailedCommand = undefined;
  if (state.lastCommandError?.taskId === taskId) state.lastCommandError = undefined;
  if (type === 'create_task' && result.taskId) setSelection(result.taskId);
  await refresh(true);
  return result;
}

function paintEvents(target: HTMLElement): void {
  target.append(append(element('div', 'row spread'), element('h3', '', '持久事件时间线'), element('span', 'tiny muted', '控制请求与执行效果分别记录')));
  const events = [...state.snapshot.events].reverse();
  if (!events.length) target.append(empty('当前没有事件。'));
  for (const event of events) {
    const body = append(element('div'), element('div', 'event-type', event.type), element('pre', '', pretty(event.payload)));
    target.append(append(element('article', 'event'), element('div', 'event-seq', `#${event.seq}`), element('time', '', shortTime(event.createdAt)), body));
  }
}
function paintRecall(target: HTMLElement): void {
  target.append(element('h3', '', '召回原始历史'), element('p', 'muted tiny', '搜索保留的原始消息与事件；工作上下文压缩独立于这些记录。'));
  const query = input(state.recallQuery, '关键词、文件名、目标或事件类型', 'recall-query');
  query.addEventListener('input', () => { state.recallQuery = query.value; });
  const search = async () => {
    const taskId = state.selectedId, epoch = selectionEpoch;
    state.recallSearched = true;
    const result = await request('GET', `/v1/recall?taskId=${encodeURIComponent(taskId)}&q=${encodeURIComponent(query.value.trim())}`);
    if (state.selectedId !== taskId || selectionEpoch !== epoch) return;
    state.recallResults = arrayValue(result.results); const content = main.querySelector('.task-content') as HTMLElement; if (content) paintRecallResults(content.querySelector('.recall-results') as HTMLElement);
  };
  const searchRow = append(element('form', 'search-row'), query, button('搜索', () => run(search), '', 'recall-search'));
  searchRow.addEventListener('submit', event => { event.preventDefault(); run(search); }); target.append(searchRow);
  const results = element('div', 'recall-results'); paintRecallResults(results); target.append(results);
  target.append(sectionTitle('上下文检查点'));
  for (const checkpoint of arrayValue(state.snapshot.checkpoints).slice().reverse()) {
    const card = element('div', 'card tool-card');
    card.append(append(element('div', 'row spread'), element('span', 'mono tiny', checkpoint.id), element('span', 'tiny muted', shortTime(checkpoint.createdAt))), element('div', 'subtle-box', `原始消息 ${checkpoint.messageCount} 条 · 事件游标 ${checkpoint.eventSeq}`));
    const detail = element('details'); detail.append(element('summary', '', '查看工作上下文清单'), element('pre', '', pretty(checkpoint.context))); card.append(detail); target.append(card);
  }
  if (!state.snapshot.checkpoints?.length) target.append(empty('检查点会在运行过程中持久保存。'));
}
function paintRecallResults(target: HTMLElement): void {
  target.replaceChildren();
  if (!state.recallSearched) { target.append(empty('输入关键词以召回历史。')); return; }
  if (!state.recallResults.length) { target.append(empty('没有匹配记录。原始历史仍然保留。')); return; }
  target.append(element('div', 'muted tiny', `${state.recallResults.length} 条结果`));
  for (const result of state.recallResults) target.append(append(element('article', 'search-result'), element('div', 'row spread tiny muted', `${result.kind ?? result.role ?? result.type ?? 'record'} · ${result.id ?? result.seq ?? ''}`), element('p', '', result.content ?? pretty(result.payload ?? result))));
}
function intentCard(intent: Intent): HTMLElement {
  const pending = intent.state === 'prepared';
  const card = element('article', `card tool-card${pending ? ' approval-card' : ''}`); card.dataset.intentId = intent.id;
  const tones: Record<string, string> = { prepared: 'warning', approved: 'live', applied: 'live', unknown: 'warning', denied: 'failed' };
  const labels: Record<string, string> = { prepared: '待批准', approved: '已批准', sent: '已发送', applied: '效果已确认', unknown: '效果未知', denied: '已拒绝' };
  const toolLabels: Record<string, [string, string]> = { write_file: ['写入文件', 'edit'], read_file: ['读取文件', 'folder'], list_files: ['列出文件', 'folder'], run_command: ['运行 Node 命令', 'terminal'], run_shell: ['运行终端命令', 'terminal'], web_search: ['检索网页', 'search'], web_fetch: ['读取网页', 'globe'], web_crawl: ['抓取网页', 'globe'], mcp_call: ['调用 MCP 工具', 'plug'], plugin_transform: ['插件文本变换', 'plug'], fixture_increment: ['本地计数操作', 'check'] };
  const [title, glyph] = toolLabels[intent.name] ?? [intent.name, 'code'];
  card.append(append(element('div', 'tool-title'), append(element('h3'), icon(glyph), title), badge(labels[intent.state] ?? intent.state, tones[intent.state])));
  const args = intent.arguments;
  const subject = args.path ?? args.url ?? args.query ?? args.command;
  if (subject !== undefined) card.append(element('div', 'tool-subject mono', String(subject)));
  if (intent.name === 'write_file' && typeof args.content === 'string') {
    const preview = preservedDisclosure(`文件内容 · ${args.content.split('\n').length} 行`, `${intent.id}:content`, 'tool-content', pending); preview.append(element('pre', 'tool-preview', args.content)); card.append(preview);
  } else if (!subject || Object.keys(args).length > 1) {
    const preview = preservedDisclosure('查看动作参数', `${intent.id}:parameters`, 'tool-content', pending); preview.append(element('pre', 'tool-preview', pretty(args))); card.append(preview);
  }
  const binding = preservedDisclosure('完整参数与批准绑定', `${intent.id}:binding`, 'tool-details');
  binding.append(element('div', 'tool-api-name mono', intent.name), element('pre', '', pretty(args)), element('div', 'digest mono', `摘要 ${intent.digest}\n授权 epoch ${intent.policyEpoch} · generation ${intent.generation}\n效果键 ${intent.effectKey}`)); card.append(binding);
  if (intent.error) card.append(element('div', 'issue-message', intent.error));
  if (intent.receipt) { const detail = preservedDisclosure('执行回执与证据', `${intent.id}:receipt`); detail.append(element('pre', '', pretty(intent.receipt))); card.append(detail); }
  if (pending) {
    const grant = button('批准本次动作', () => run(async () => {
      const taskId = intent.taskId, epoch = selectionEpoch;
      await refresh(true);
      if (state.selectedId !== taskId || selectionEpoch !== epoch) return;
      const current = state.snapshot.intents.find(item => item.id === intent.id);
      if (!current || current.state !== 'prepared' || current.digest !== intent.digest || current.generation !== intent.generation || current.policyEpoch !== intent.policyEpoch) throw new Error('审批动作或授权版本已变化，请核对刷新后的内容再批准。');
      await sendCommand('grant', { intentId: intent.id, digest: intent.digest }, taskId); toast('动作已批准；后台将重新核验权限后执行。');
    }), 'primary small', `grant-${intent.id}`);
    const deny = button('拒绝', () => run(async () => sendCommand('deny', { intentId: intent.id, digest: intent.digest, reason: '用户在桌面拒绝当前动作' })), 'small danger', `deny-${intent.id}`);
    card.append(append(element('div', 'approval-actions'), deny, grant));
  } else if (intent.state === 'unknown') card.append(element('div', 'subtle-box', '效果未知时禁止盲目重放。后台会以效果键和回执核验进行对账；在“恢复与适配”查看诊断。'));
  return card;
}
function paintTools(target: HTMLElement, task: Task): void {
  target.append(append(element('div', 'row spread'), element('h3', '', '执行意图与授权'), button('撤销当前授权', () => showConfirm('撤销授权', '撤销后，运行版本和授权版本都会更新；已发送的效果仍需对账。', '撤销授权', () => run(async () => sendCommand('revoke'))), 'small danger', 'revoke-authorizations')));
  target.append(element('p', 'muted tiny', '自主推进使用当前权限上限。每次写文件或执行命令都需要绑定具体动作的批准。'));
  target.append(button('REA 本地静态分析', () => {
    const dialog = showModal('申请本地静态分析', '只分析明确指定的路径。请求进入当前任务的工具记录，启用集成不会跳过现有授权规则。原生动态能力不可用。');
    const paths = textarea('', '每行一个当前工作区内的文件路径', 'rea-analysis-paths');
    dialog.body.append(field('待分析文件', paths), append(element('div', 'form-actions'), button('选择文件', () => run(async () => { const chosen = await window.npn.desktop('select-file'); if (chosen) paths.value = [...lines(paths.value), chosen].join('\n'); }), 'small', 'rea-pick-file'), button('提交分析申请', () => run(async () => { if (!lines(paths.value).length) throw new Error('请先明确选择待分析文件。'); await proposeOperatorTool(`/v1/tasks/${encodeURIComponent(task.id)}/integrations/analyze`, { paths: lines(paths.value) }); dialog.close(); await refresh(true); toast('分析申请已记录，请核对工具状态。'); }), 'primary small', 'rea-request-analysis')));
  }, 'small', 'rea-open-analysis'));
  const intents = [...state.snapshot.intents].sort((a, b) => Number(b.state === 'prepared') - Number(a.state === 'prepared'));
  if (!intents.length) target.append(empty('当前没有工具动作。所有动作、拒绝和效果回执会保留在这里。'));
  intents.forEach(intent => target.append(intentCard(intent)));
  target.append(sectionTitle('任务范围'), element('div', 'card mono tiny', `工作区 ${task.workspace}\n程序所有者 ${task.owner}\n策略版本 ${task.policyEpoch}`));
}
function paintResults(target: HTMLElement, task: Task): void {
  const goal = element('div', 'card'); goal.append(element('h3', '', '已保存的目标契约'), element('p', '', task.goal.objective));
  if (task.goal.constraints.length) goal.append(element('div', 'subtle-box', `约束\n${task.goal.constraints.join('\n')}`));
  if (task.goal.acceptance.length) goal.append(element('div', 'subtle-box', `验收\n${task.goal.acceptance.join('\n')}`));
  target.append(goal, sectionTitle('任务结果'));
  const finalMessage = state.snapshot.messages.findLast(message => message.role === 'assistant' && message.content === task.result);
  target.append(append(element('div', 'card result-body'), formattedMessage(finalMessage?.displayContent ?? task.result ?? (task.status === 'completed' ? '任务已完成。' : '尚未生成通过验收的最终结果。'))));
  const verifications = arrayValue(state.snapshot.verifications);
  target.append(sectionTitle('独立验收证据', badge(`${verifications.length} 次审查`)));
  if (!verifications.length) target.append(empty('独立验收记录尚未产生。模型回答与任务完成状态分别判定。'));
  for (const verification of verifications.slice().reverse()) {
    const record = verification.record ?? verification;
    const card = element('div', 'card tool-card'); card.append(append(element('div', 'row spread'), element('h3', '', record.reviewer ? `审查角色 · ${record.reviewer}` : '独立审查'), badge(record.passed ? '通过' : '未通过', record.passed ? 'live' : 'failed')), element('pre', '', pretty(record)));
    target.append(card);
  }
  const manual = verifications.some(item => item.record?.requiresManual);
  if (task.status === 'waiting_input' && manual) {
    const card = element('div', 'card approval-card');
    card.append(element('h3', '', '人工验收'), element('p', '', '这些验收标准需要你核对实际结果。记录你看到的工件和证据；后台仍会拒绝未知效果或损坏工件。'));
    const verification = verifications.findLast(item => item.record?.requiresManual);
    const draftKey = `${task.id}:${verification?.id ?? task.goalVersion}`;
    const evidence = textarea(state.acceptanceDrafts.get(draftKey) ?? '', '例如：已核对 hello.txt 的内容与目标一致，回执和实际文件相符。', 'acceptance-evidence');
    evidence.addEventListener('input', () => { state.acceptanceDrafts.set(draftKey, evidence.value); });
    const decide = (accepted: boolean) => { const submitted = evidence.value; if (!submitted.trim()) { evidence.focus(); return; } run(async () => {
      await request('POST', '/v1/accept-result', { taskId: task.id, expectedRevision: task.revision, accepted, evidence: submitted.trim() });
      if (state.acceptanceDrafts.get(draftKey) === submitted) state.acceptanceDrafts.delete(draftKey);
      await refresh(true); toast(accepted ? '人工验收证据已保存。' : '验收未通过，理由已记录。');
    }); };
    card.append(evidence, append(element('div', 'approval-actions'), button('未通过', () => decide(false), 'small danger', 'reject-result'), button('核对证据并通过', () => decide(true), 'primary small', 'accept-result')));
    target.append(card);
  }
  mountTaskIntegrations(target, task.id, { request, run, toast, showModal }, selectTask, 'evidence');
  target.append(sectionTitle('运行记录')); const table = element('table', 'table');
  const head = element('thead'); const hr = element('tr'); ['运行', '状态', '版本', '开始 / 结束'].forEach(label => hr.append(element('th', '', label))); head.append(hr); table.append(head);
  const body = element('tbody'); for (const run of arrayValue(state.snapshot.runs).slice().reverse()) { const row = element('tr'); [run.id, run.status, `gen ${run.generation} · policy ${run.policyEpoch ?? '—'}`, `${shortTime(run.startedAt)} / ${shortTime(run.endedAt) || '—'}`].forEach(value => row.append(element('td', 'mono tiny', String(value)))); body.append(row); } table.append(body); target.append(table);
}
function paintCollaboration(target: HTMLElement, task: Task): void {
  mountTaskIntegrations(target, task.id, { request, run, toast, showModal }, selectTask, 'collaboration');
  target.append(append(element('div', 'row spread'), element('h3', '', '独立子任务'), button('＋ 分派子任务', () => showGoalModal('', true), 'primary small', 'delegate-task')));
  target.append(element('p', 'muted tiny', '主任务持有目标与结果采纳权。子任务拥有单独预算、运行和工作区，取消主任务会同步取消子任务。'));
  const delegations = arrayValue(state.snapshot.delegations);
  if (!delegations.length) target.append(empty('暂未分派子任务。先明确子目标、验收标准和文件所有权。'));
  for (const delegation of delegations) {
    const child = state.snapshot.tasks.find(item => item.id === delegation.childTaskId);
    const card = element('article', 'card tool-card');
    card.append(append(element('div', 'row spread'), element('h3', '', child?.title ?? delegation.childTaskId), child ? statusBadge(child) : badge(delegation.state)));
    card.append(element('p', '', child?.goal.objective ?? ''), element('div', 'subtle-box mono', `所有者 ${delegation.owner}\n工作区 ${child?.workspace ?? '—'}\n采纳状态 ${delegation.state}`));
    if (child?.result) card.append(element('div', 'result-body', child.result));
    const actions = element('div', 'approval-actions');
    actions.append(button('查看子任务', () => selectTask(delegation.childTaskId), 'small', `open-child-${delegation.childTaskId}`));
    const cancel = button('取消子任务', () => run(async () => sendCommand('cancel', {}, delegation.childTaskId)), 'small danger', `cancel-child-${delegation.childTaskId}`); cancel.disabled = !child || taskIsTerminal(child); actions.append(cancel);
    const accept = button(delegation.state === 'accepted' ? '结果已采纳' : '采纳已验收结果', () => run(async () => { await sendCommand('accept_result', { childTaskId: delegation.childTaskId }, task.id); toast('子任务结果已采纳到主任务的持久记录。'); }), 'primary small', `accept-child-${delegation.childTaskId}`); accept.disabled = child?.status !== 'completed' || delegation.state === 'accepted'; actions.append(accept); card.append(actions); target.append(card);
  }
  target.append(sectionTitle('角色与权限边界'), element('div', 'card', '主角色：持续推进目标与协调子任务。\n辅助侧聊：只读取主任务快照，返回建议；不能批准、取消或改变主任务。\n子代理：在专属任务范围内执行，不能提升主任务权限。\n审查角色：独立核验工件与效果，通过后才能采纳结果。'));
}

function paintSide(): void {
  const restoreFocus = rememberFocus(side); const oldMessages = side.querySelector<HTMLElement>('.side-messages'); const oldScroll = oldMessages?.scrollTop ?? 0; const atBottom = !oldMessages || oldMessages.scrollHeight - oldScroll - oldMessages.clientHeight < 100;
  side.replaceChildren(); side.hidden = !state.sideVisible;
  side.style.display = state.sideVisible ? 'flex' : 'none';
  if (!state.sideVisible) return;
  const head = element('div', 'side-header');
  const close = button('收起侧聊', toggleSide, 'small ghost', 'close-sidechat'); close.prepend(icon('x')); close.title = '收起辅助侧聊，主任务继续运行'; close.setAttribute('aria-label', close.title);
  head.append(append(element('div', 'row spread'), append(element('h3'), icon('chat'), '辅助侧聊'), close), element('p', '', '独立辅助讨论。建议由你采纳，不控制主任务。'));
  side.append(head);
  if (!state.selectedId) { side.append(empty('选择或创建主任务后，可同时开启辅助讨论。')); return; }
  if (!currentSide()) createSide();
  const taskId = state.selectedId, session = currentSide()!;
  const draftKey = `${taskId}:${session.id}`, pending = state.sidePending.get(draftKey);
  const sessions = state.sideSessions.get(state.selectedId)!;
  const picker = select(sessions.map(item => [item.id, `${item.label}${state.sidePending.has(`${taskId}:${item.id}`) ? ' · 回答中' : ''}`]), session.id, 'side-session');
  picker.setAttribute('aria-label', '辅助会话'); picker.addEventListener('change', () => { state.sideSelected.set(state.selectedId, picker.value); paintSide(); });
  const add = button('', () => { createSide(); paintSide(); }, 'small icon-button', 'side-new-session'); add.append(icon('plus')); add.title = '新建独立辅助会话'; add.setAttribute('aria-label', add.title);
  side.append(append(element('div', 'side-sessions'), picker, add));
  const messages = element('div', 'side-messages'); messages.dataset.testid = 'side-messages';
  if (!session.messages.length) messages.append(element('div', 'empty-small', '讨论思路、核对风险或梳理计划。\n主任务可以同时持续运行。'));
  for (const message of session.messages) {
    if (message.role === 'system') continue;
    const node = element('article', `side-message ${message.role}`); node.append(element('div', 'side-message-label', message.role === 'user' ? '你' : '辅助 Agent'), message.role === 'assistant' ? formattedMessage(message.content) : element('div', 'side-message-content', message.content)); messages.append(node);
  }
  if (pending) messages.append(element('div', 'muted tiny pending-state', pending.cancelRequested ? '正在停止这次辅助回答…' : '辅助 Agent 正在回答…'));
  side.append(messages);
  state.sideDraft = state.sideDrafts.get(draftKey) ?? '';
  const composer = element('form', 'side-composer'); const draft = textarea(state.sideDraft, '向辅助 Agent 提问…', 'side-message'); draft.setAttribute('aria-label', '辅助侧聊消息');
  draft.addEventListener('input', () => { state.sideDraft = draft.value; state.sideDrafts.set(draftKey, draft.value); });
  const submit = button('', () => { void submitSide(draft, taskId, session); }, 'primary send-button', 'send-side-message'); submit.append(icon('send')); submit.title = '发送辅助侧聊消息'; submit.setAttribute('aria-label', submit.title); submit.disabled = !!pending;
  const sideBudget = state.snapshot.sideBudgets?.find(item => item.sessionId === session.id);
  const actions = element('div', 'row');
  if (pending) {
    const stop = button(pending.cancelRequested ? '停止中…' : '停止回答', () => run(async () => {
      await request('POST', '/v1/sidechat/cancel', { taskId: pending.taskId, sessionId: pending.sessionId });
      if (state.sidePending.get(draftKey) === pending) pending.cancelRequested = true;
      if (state.selectedId === taskId && currentSide()?.id === session.id) paintSide();
    }), 'small danger', 'stop-side-answer'); stop.disabled = pending.cancelRequested; actions.append(stop);
  }
  actions.append(submit);
  composer.append(draft, append(element('div', 'composer-bottom'), element('span', '', `辅助预算 ${sideBudget?.modelCalls ?? 0}/${sideBudget?.maxModelCalls ?? 20}`), actions));
  if (session.error) composer.append(element('div', 'side-error', session.error));
  composer.addEventListener('submit', event => { event.preventDefault(); void submitSide(draft, taskId, session); });
  draft.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submitSide(draft, taskId, session); } });
  side.append(composer); messages.scrollTop = atBottom ? messages.scrollHeight : oldScroll; restoreFocus();
}
async function submitSide(draft: HTMLTextAreaElement, taskId: string, session: SideSession): Promise<void> {
  const key = `${taskId}:${session.id}`, submitted = draft.value, content = submitted.trim(); if (!content || state.sidePending.has(key)) return;
  const epoch = selectionEpoch; state.sidePending.set(key, { taskId, sessionId: session.id, cancelRequested: false }); session.error = undefined;
  session.messages.push({ id: crypto.randomUUID(), taskId, sessionId: session.id, role: 'user', content, createdAt: new Date().toISOString() });
  state.sideDrafts.set(key, submitted); paintSide();
  try {
    const result = await request('POST', '/v1/sidechat', { taskId, sessionId: session.id, message: content });
    session.messages = arrayValue<Message>(result.messages); session.error = result.error;
    if (state.sideDrafts.get(key) === submitted) {
      state.sideDrafts.set(key, '');
      if (state.selectedId === taskId && currentSide()?.id === session.id) state.sideDraft = '';
    }
    if (state.selectedId === taskId && selectionEpoch === epoch && currentSide()?.id === session.id) await refresh(true);
  } catch (error) { session.error = errorText(error); }
  finally { state.sidePending.delete(key); if (state.selectedId === taskId) paintSide(); }
}

function showModal(title: string, caption: string): { body: HTMLElement; close: () => void } {
  const previous = document.activeElement as HTMLElement | null;
  const overlay = element('div', 'modal-overlay'); const modal = element('section', 'modal'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', title);
  const close = () => { overlay.remove(); previous?.focus(); };
  const heading = append(element('div'), element('h2', '', title), element('p', '', caption));
  modal.append(append(element('div', 'modal-header'), heading, button('×', close, 'ghost icon-button', 'close-dialog')));
  overlay.append(modal); app.append(overlay);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') close();
    if (event.key === 'Tab') {
      const focusable = Array.from(modal.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea'));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  window.setTimeout(() => (modal.querySelector<HTMLElement>('input,textarea,select') ?? modal.querySelector<HTMLElement>('button'))?.focus(), 0);
  return { body: modal, close };
}
function showConfirm(title: string, content: string, confirmLabel: string, action: () => void): void {
  const dialog = showModal(title, '请确认这个具体操作'); dialog.body.append(element('p', 'muted', content));
  dialog.body.append(append(element('div', 'form-actions'), button('返回', dialog.close, 'ghost'), button(confirmLabel, () => { dialog.close(); action(); }, 'primary', 'confirm-action')));
}
function showGoalModal(objective = '', delegated = false): void {
  const parent = selectedTask(); const dialog = showModal(delegated ? '分派独立子任务' : '创建工作目标', delegated ? '明确子代理的交付、预算与文件所有权' : '先定义目标和验收标准，再选择推进方式');
  const form = element('form'); const grid = element('div', 'form-grid');
  const title = input('', '例如：验证工作区文件链路', 'goal-title'); title.required = true;
  const goal = textarea(objective, '描述需要完成的具体结果', 'goal-objective'); goal.required = true;
  const mode = select([['collaborative', '协作模式 · 持续对齐'], ['autonomous', '自主推进 · 按目标执行']], parent?.goal.mode ?? 'collaborative', 'goal-mode');
  const budget = input(String(delegated ? Math.min(8, parent?.goal.maxModelCalls ?? 8) : 12), '', 'goal-budget'); budget.type = 'number'; budget.min = '1'; budget.max = '10000'; budget.required = true;
  const toolBudget = input(String(delegated ? 32 : 48), '', 'goal-tool-budget'); toolBudget.type = 'number'; toolBudget.min = '1'; toolBudget.max = '10000'; toolBudget.required = true;
  const workspace = input(delegated ? '' : state.workspaceDraft, '留空使用独立任务工作区', 'goal-workspace');
  const choose = button('选择文件夹', () => run(async () => { const folder = await window.npn.desktop('select-workspace'); if (folder) { workspace.value = folder; state.workspaceDraft = folder; } }), 'small', 'choose-goal-workspace');
  const constraints = textarea('', '每行一项，例如：只在当前任务工作区修改文件', 'goal-constraints');
  const acceptance = textarea(objective.includes('hello.txt') ? 'file:hello.txt\ncontains:hello.txt:Hello NPN' : '', '每行一项；可使用 file:路径、contains:路径:内容', 'goal-acceptance');
  const paths = textarea('', '每行一个相对路径，例如：docs/plan.md', 'delegation-paths');
  for (const field of [workspace, budget, toolBudget]) field.defaultValue = field.value;
  mode.dataset.initialValue = mode.value;
  if (!delegated) {
    const presets = element('div', 'budget-presets');
    for (const [label, models, tools] of [['轻量任务', 20, 80], ['项目迭代', 200, 1000], ['持续任务', 10000, 10000]] as const) {
      const preset = button(label, () => { budget.value = String(models); toolBudget.value = String(tools); presets.querySelectorAll('button').forEach(node => node.classList.remove('active')); preset.classList.add('active'); }, 'small', `budget-preset-${models}`);
      preset.title = `最多 ${models.toLocaleString()} 次模型调用 · ${tools.toLocaleString()} 次工具调用`; presets.append(preset);
    }
    grid.append(append(element('div', 'full goal-presets'), element('span', 'tiny muted', '执行预算预设'), presets));
  }
  grid.append(field('任务名称', title, 'full'), field('目标', goal, 'full'), field('项目工作区', append(element('div', 'workspace-picker'), workspace, choose), 'full'), field('推进方式', mode), field('模型调用上限', budget), field('工具调用上限', toolBudget), field('执行约束', constraints, 'full'), field('验收标准', acceptance, 'full'));
  if (delegated) grid.append(field('子任务独占文件路径（可选）', paths, 'full'));
  form.append(grid, element('div', 'modal-note', '预算是调用次数上限，可以在任务中追加。持续任务可在设置中配置外部密钥文件与授权有效期；需要批准的工具动作会等待你的决定。'));
  const submit = button(delegated ? '分派子任务' : '保存目标并开始', () => { form.requestSubmit(); }, 'primary', 'create-goal');
  form.append(append(element('div', 'form-actions'), button('取消', dialog.close, 'ghost'), submit));
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!form.reportValidity() || submit.disabled) return;
    const parameters: RecordData = { title: title.value.trim(), goal: { objective: goal.value.trim(), constraints: lines(constraints.value), acceptance: lines(acceptance.value), maxModelCalls: Number(budget.value), maxToolCalls: Number(toolBudget.value), mode: mode.value } };
    if (workspace.value.trim()) parameters.workspace = workspace.value.trim();
    if (delegated && paths.value.trim()) parameters.paths = lines(paths.value);
    submit.disabled = true;
    void run(async () => { const result = await sendCommand(delegated ? 'delegate' : 'create_task', parameters); dialog.close(); state.screen = state.workspaceMode === 'code' ? 'code' : 'tasks'; if (state.workspaceMode === 'chat') state.workspaceMode = 'cowork'; paintModeSwitch(); state.view = delegated ? 'collaboration' : 'chat'; if (!delegated) { setSelection(result.taskId); state.welcomeDraft = ''; state.modeDrafts[state.workspaceMode] = ''; } if (state.mode === 'ide') state.ideAgentOpen = true; paintSidebar(); paintMain(); paintSide(); toast(delegated ? '独立子任务已分派。' : '目标已保存，任务开始推进。'); }).finally(() => { submit.disabled = false; });
  });
  dialog.body.append(form); title.focus();
}

function showGoalRevision(task: Task): void {
  const dialog = showModal('调整已保存目标', '检查新目标、约束和验收标准后提交，变更会记录原因。');
  const form = element('form'), grid = element('div', 'form-grid');
  const objective = textarea(task.goal.objective, '期望完成的结果', 'revise-goal-objective'); objective.required = true;
  const constraints = textarea(task.goal.constraints.join('\n'), '每行一项约束', 'revise-goal-constraints');
  const acceptance = textarea(task.goal.acceptance.join('\n'), '每行一项验收标准', 'revise-goal-acceptance');
  const mode = select([['collaborative', '协作'], ['autonomous', '自主推进']], task.goal.mode, 'revise-goal-mode');
  const reason = textarea('', '说明本次调整的原因', 'revise-goal-reason'); reason.required = true;
  for (const field of [objective, constraints, acceptance, reason]) field.defaultValue = field.value;
  mode.dataset.initialValue = mode.value;
  grid.append(field('目标', objective, 'full'), field('执行约束', constraints), field('验收标准', acceptance), field('推进方式', mode), field('调整原因', reason, 'full'));
  const submit = button('保存目标变更', () => form.requestSubmit(), 'primary', 'submit-revise-goal');
  form.append(grid, append(element('div', 'form-actions'), button('返回', dialog.close, 'ghost'), submit));
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    void run(async () => { await sendCommand('revise_goal', { goal: { objective: objective.value.trim(), constraints: lines(constraints.value), acceptance: lines(acceptance.value), mode: mode.value }, reason: reason.value.trim() }, task.id); dialog.close(); toast('目标变更和原因已保存。'); });
  }); dialog.body.append(form);
}
function showBudgetRenewal(task: Task): void {
  const dialog = showModal('增加有限任务预算', '填写累计总上限。已用次数不会清零，工具动作仍需单独批准。');
  const budget = state.snapshot.budget; const form = element('form'), grid = element('div', 'form-grid');
  const models = input(String(task.goal.maxModelCalls + 5), '', 'renew-model-budget'); models.type = 'number'; models.min = String(task.modelCalls); models.max = '10000'; models.required = true;
  const tools = input(String(Number(budget?.maxToolCalls ?? 48) + 10), '', 'renew-tool-budget'); tools.type = 'number'; tools.min = String(budget?.toolCalls ?? 0); tools.max = '10000'; tools.required = true;
  const reason = textarea('', '说明需要额外预算的原因', 'renew-budget-reason'); reason.required = true;
  for (const field of [models, tools]) field.defaultValue = field.value;
  grid.append(field(`模型调用总上限 · 已用 ${task.modelCalls}`, models), field(`工具调用总上限 · 已用 ${budget?.toolCalls ?? 0}`, tools), field('调整原因', reason, 'full'));
  form.append(grid, append(element('div', 'form-actions'), button('返回', dialog.close, 'ghost'), button('保存预算上限', () => form.requestSubmit(), 'primary', 'submit-renew-budget')));
  form.addEventListener('submit', event => { event.preventDefault(); if (!form.reportValidity()) return; void run(async () => { await sendCommand('renew_budget', { maxModelCalls: Number(models.value), maxToolCalls: Number(tools.value), reason: reason.value.trim() }, task.id); dialog.close(); toast('累计预算上限已更新。'); }); }); dialog.body.append(form);
}

function paintIDE(task?: Task): void {
  const workbench = testId(element('section', 'editor-host'), 'ide-editor-workbench'); workbench.setAttribute('aria-label', '项目编辑器');
  const panel = testId(element('section', 'ide-agent-panel'), 'ide-agent-panel'); panel.setAttribute('aria-label', '项目 Agent');
  const close = button('收起', () => setAgentOpen(false), 'small ghost agent-drawer-close', 'close-ide-agent'); close.prepend(icon('x')); close.title = '收起 Agent，返回项目编辑';
  const panelHead = append(element('header', 'agent-panel-head'), append(element('strong'), icon('sparkle'), 'Agent'), append(element('div', 'row'), button('新任务', () => showGoalModal(), 'small ghost', 'agent-new-task'), close));
  panel.append(panelHead); const surface = element('div', 'agent-panel-surface'); panel.append(surface);
  main.append(workbench, panel); editor.render(workbench, task);
  if (task) paintTaskSurface(surface, task); else paintWelcome(surface, true);
}
async function proposeOperatorTool(route: string, parameters: RecordData): Promise<any> {
  const key = JSON.stringify({ route, parameters });
  const requestId = pendingToolRequests.get(key) ?? (typeof parameters.requestId === 'string' && parameters.requestId ? parameters.requestId : crypto.randomUUID()); pendingToolRequests.set(key, requestId);
  let result: any;
  try { result = await request('POST', route, { ...parameters, requestId }); }
  catch (error) { if (error instanceof RequestRejected) pendingToolRequests.delete(key); throw error; }
  pendingToolRequests.delete(key); return result;
}
async function refresh(force: boolean): Promise<void> {
  while (refreshPromise) { if (!force) return; await refreshPromise; }
  const pending = refreshSnapshot(force); refreshPromise = pending;
  try { await pending; } finally { if (refreshPromise === pending) refreshPromise = undefined; }
}
async function refreshSnapshot(force: boolean): Promise<void> {
  const requestedTaskId = state.selectedId, epoch = selectionEpoch;
  state.pollActive = true;
  try {
    const snapshot = await request<ExpandedSnapshot & { sideSessions?: SideSession[] }>('GET', `/v1/snapshot?compact=true${requestedTaskId ? `&taskId=${encodeURIComponent(requestedTaskId)}` : ''}`);
    if (requestedTaskId !== state.selectedId || selectionEpoch !== epoch) return;
    state.snapshot = snapshot; state.health = snapshot.health; state.healthy = true; state.backendError = ''; state.lastSync = shortTime(new Date().toISOString());
    if (!state.selectedId && snapshot.selectedTask && state.workspaceMode !== 'code') setSelection(snapshot.selectedTask.id);
    if (snapshot.sideSessions?.length && state.selectedId) {
      const existing = state.sideSessions.get(state.selectedId) ?? [];
      for (const restored of snapshot.sideSessions) {
        const session = existing.find(item => item.id === restored.id);
        if (session) { if (!state.sidePending.has(`${state.selectedId}:${session.id}`)) session.messages = restored.messages; }
        else existing.push({ ...restored, label: restored.label && restored.label !== restored.id ? restored.label : `辅助会话 ${existing.length + 1}` });
      }
      state.sideSessions.set(state.selectedId, existing);
      if (!state.sideSelected.has(state.selectedId)) state.sideSelected.set(state.selectedId, existing[0].id);
    }
    const fingerprint = taskFingerprint(snapshot);
    paintSidebar(); paintStatus();
    if (state.screen === 'work' && !main.contains(document.activeElement)) { main.replaceChildren(); paintWorkOverview(); }
    if (force) { state.lastFingerprint = fingerprint; if (taskScreen()) paintMain(); paintSide(); }
    else if (taskScreen() && fingerprint !== state.lastFingerprint) {
      const task = selectedTask();
      if (task) {
        const header = main.querySelector('.task-header-region') as HTMLElement, notices = main.querySelector('.notices-region') as HTMLElement, content = main.querySelector('.task-content') as HTMLElement;
        if (!header || !content) { paintMain(); paintSide(); }
        else {
          paintTaskHeader(header, task); paintNotices(notices, task);
          const editingContent = content.contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement!.tagName);
          if (!editingContent) { paintTaskContent(content, task); state.lastFingerprint = fingerprint; }
          const composer = main.querySelector<HTMLTextAreaElement>('[data-testid="main-message"]'); if (composer) composer.disabled = taskIsTerminal(task);
          const send = main.querySelector<HTMLButtonElement>('[data-testid="send-main-message"]'); if (send) send.disabled = taskIsTerminal(task);
        }
      }
    }
    editor.sync(selectedTask(), state.snapshot.intents);
    if (taskScreen() && state.selectedId && workStatsView) {
      const id = state.selectedId;
      try {
        const metrics = await request<AgentMetrics>('GET', `/v1/harness/metrics?taskId=${encodeURIComponent(id)}`);
        if (state.selectedId === id && selectionEpoch === epoch) { workMetrics = metrics; workMetricsError = ''; updateWorkStats(); }
      } catch (error) { if (state.selectedId === id && selectionEpoch === epoch) { workMetrics = undefined; workMetricsError = errorText(error); updateWorkStats(); } }
    }
    if (state.screen === 'recovery') syncRecoveryControls();
  } catch (error) {
    if (requestedTaskId !== state.selectedId || selectionEpoch !== epoch) return;
    state.healthy = false; state.backendError = errorText(error); paintStatus();
    const task = selectedTask(), notices = main.querySelector('.notices-region') as HTMLElement;
    if (task && notices) paintNotices(notices, task);
    else if (force && taskScreen()) paintMain();
    if (force) throw error;
  } finally { state.pollActive = false; }
}

const { paintSettings, paintExtensions, loadExtensions, paintRecovery, syncRecoveryControls, loadCandidates, paintActivity, loadActivity, paintWeb } = createPanels({ state, getMain: () => main, request, run, toast, showModal, showConfirm, refresh, selectedTask, selectTask, paintEvents, paintMain, paintSidebar, appendHarnessSettings: page => harness.appendSettings(page) });
const editor = createEditor({ request, run, toast, showConfirm, proposeTool: proposeOperatorTool, showApprovals: () => setTaskView('tools'), chooseWorkspace: () => { void run(chooseWorkspace); } });
const harness = createChatWorkspace({ request, run, toast, showModal, showConfirm, showChat: () => showScreen('chat'), selectTask, newTask: () => showGoalModal(), tasks: () => state.snapshot.tasks, toggleNavigation: toggleSessions, navigationOpen: () => state.mode === 'ide' || window.matchMedia('(max-width: 760px)').matches ? state.sidebarOpen : !state.sidebarCollapsed, showActivity: () => showScreen('activity'), openProject: workspace => { void run(async () => { const chosen = workspace || await window.npn.desktop('select-workspace'); if (!chosen) return; switchWorkspace('code'); state.workspaceDraft = chosen; state.modeProjects.code = chosen; state.modeTasks.code = ''; setSelection(''); paintMain(); paintSidebar(); }); }, inspectorChanged: () => { shell?.classList.toggle('inspector-open', harness.inspector.visible); document.querySelector('[data-testid="toggle-inspector"]')?.setAttribute('aria-expanded', String(harness.inspector.visible)); if (harness.inspector.visible && state.sideVisible) toggleSide(); } });

function hasUnsubmittedDrafts(): boolean {
  if (harness.hasDrafts) return true;
  if ([state.draft, state.sideDraft, state.welcomeDraft, ...Object.values(state.modeDrafts)].some(text => text.trim())) return true;
  if ([...state.mainDrafts.values()].some(draft => draft.text.trim())) return true;
  for (const drafts of [state.sideDrafts, state.answerDrafts, state.acceptanceDrafts]) {
    if ([...drafts.values()].some(text => text.trim())) return true;
  }
  const goalFields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.modal-overlay [data-testid="goal-title"], .modal-overlay [data-testid="goal-objective"], .modal-overlay [data-testid="goal-constraints"], .modal-overlay [data-testid="goal-acceptance"], .modal-overlay [data-testid="delegation-paths"], .modal-overlay [data-testid="renew-budget-reason"]');
  const changedFields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.modal-overlay [data-testid="revise-goal-objective"], .modal-overlay [data-testid="revise-goal-constraints"], .modal-overlay [data-testid="revise-goal-acceptance"], .modal-overlay [data-testid="revise-goal-reason"], .modal-overlay [data-testid="renew-model-budget"], .modal-overlay [data-testid="renew-tool-budget"], .modal-overlay [data-testid="goal-workspace"], .modal-overlay [data-testid="goal-budget"], .modal-overlay [data-testid="goal-tool-budget"]');
  const changedModes = document.querySelectorAll<HTMLSelectElement>('.modal-overlay [data-testid="goal-mode"], .modal-overlay [data-testid="revise-goal-mode"]');
  return [...goalFields].some(field => field.value.trim()) || [...changedFields].some(field => field.value !== field.defaultValue) || [...changedModes].some(field => field.value !== field.dataset.initialValue);
}

window.addEventListener('beforeunload', event => {
  if (!editor.hasUnsavedChanges() && !hasUnsubmittedDrafts()) return;
  event.preventDefault();
  event.returnValue = '';
});

buildShell();
void run(async () => { await refresh(true); });
window.setInterval(() => { void refresh(false); void harness.poll().catch(error => { console.warn('Harness refresh:', errorText(error)); }); }, 1400);
