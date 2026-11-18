import { useSyncExternalStore } from 'react';
import type { MessageWindow } from './message-window';
import type {
  AppMode, ApprovalRequest, ConnectionInfo, MetricsView, ModelProfile, PermissionMode, ProjectView, SessionDetail, SessionSummary, Settings, SideAnswer, SideAskInput,
} from '../api';

export type InspectorTab = 'prompt' | 'request' | 'tools' | 'trace' | 'context' | 'diff';

/** 右侧边面板的标签类型。launcher = 新标签页（工具入口 + 地址栏）。 */
export type PanelKind = 'launcher' | 'changes' | 'inspector' | 'browser' | 'terminal' | 'sidechat' | 'files' | 'coordination';
/** browser 标签的 history 中，以 search: 开头的条目表示搜索结果页。 */
export interface PanelTab { id: string; kind: PanelKind; history: string[]; index: number }
export type SettingsSection = 'appearance' | 'models' | 'permissions' | 'tools' | 'extensions' | 'instructions' | 'network' | 'privacy' | 'shortcuts' | 'about';

export type View =
  | { kind: 'home' }
  | { kind: 'session'; id: string }
  | { kind: 'projects' }
  | { kind: 'history' }
  | { kind: 'ide'; projectId?: string }
  | { kind: 'settings'; section: SettingsSection };

/** 可以打开右侧边面板的视图。 */
export const panelViews: ReadonlySet<View['kind']> = new Set(['home', 'session']);

export interface Toast {
  id: string;
  tone: 'info' | 'success' | 'warn' | 'error';
  title: string;
  detail?: string;
}

export interface AppState {
  booted: boolean;
  bootError?: string;
  mode: AppMode;
  view: View;
  /** sidebarOpen=false 时侧栏收成图标栏（rail），不会完全消失。 */
  layout: { sidebarOpen: boolean; sidebarWidth: number; sidebarGroup: 'time' | 'project'; inspectorOpen: boolean; inspectorWidth: number; panelMaximized: boolean; fileTreeOpen: boolean };
  inspectorTab: InspectorTab;
  panel: { tabs: PanelTab[]; active: string };
  sideChats: Record<string, SideAnswer[]>;
  /** One visible side history window; other conversations remain on the server. */
  sideChatMeta?: { key: string; generation: number; sideSessionId?: string; targetTaskId?: string; nextCursor?: string; loading?: boolean; latest: boolean; pending?: SideAnswer; retryInput?: SideAskInput };
  recentUrls: string[];
  /** Inspector 聚焦的请求或工具调用（从消息“检查”跳转）。 */
  inspectorFocus?: { requestId?: string; toolCallId?: string };
  paletteOpen: boolean;
  projectId?: string;
  connection?: ConnectionInfo;
  settings?: Settings;
  models: ModelProfile[];
  projects: ProjectView[];
  sessions: Record<string, SessionSummary>;
  historyNextCursor?: string;
  /** Older pages replace each other and are never added to the sidebar list. */
  historyPage?: { items?: SessionSummary[]; nextCursor?: string; pending?: number; error?: string };
  /** Only the opened older row is available to the composer and other session controls. */
  historyFocusId?: string;
  details: Record<string, SessionDetail>;
  pendingTaskPauses: Record<string, symbol>;
  /** Only the visible conversation owns body/metrics caches; drafts have an independent lifetime. */
  detailSessionId?: string;
  detailEpoch?: number;
  messageWindow?: MessageWindow;
  approvals: Record<string, ApprovalRequest>;
  metrics: Record<string, MetricsView>;
  /** 每次 inspector.invalidated 自增，Inspector 面板据此重新拉取。 */
  inspectorRevision: Record<string, number>;
  /** 新会话（尚无 id）使用的权限与模型。 */
  draftPermission?: PermissionMode;
  draftModelId?: string;
  draftReasoning?: string;
  drafts: Record<string, string>;
  toasts: Toast[];
  coordinationRevision?: number;
}

const layoutKey = 'npn.frontend.layout';

function savedLayout(): AppState['layout'] {
  const fallback: AppState['layout'] = { sidebarOpen: true, sidebarWidth: 272, sidebarGroup: 'time', inspectorOpen: true, inspectorWidth: 420, panelMaximized: false, fileTreeOpen: true };
  const raw = localStorage.getItem(layoutKey);
  const saved = raw ? { ...fallback, ...(JSON.parse(raw) as Partial<AppState['layout']>) } : fallback;
  return { ...saved, inspectorOpen: false, panelMaximized: false };
}

let state: AppState = {
  booted: false,
  mode: 'chat',
  view: { kind: 'home' },
  layout: savedLayout(),
  inspectorTab: 'trace',
  panel: { tabs: [{ id: 'changes', kind: 'changes', history: [], index: 0 }, { id: 'inspector', kind: 'inspector', history: [], index: 0 }], active: 'changes' },
  sideChats: {},
  recentUrls: [],
  paletteOpen: false,
  models: [],
  projects: [],
  sessions: {},
  details: {},
  pendingTaskPauses: {},
  approvals: {},
  metrics: {},
  inspectorRevision: {},
  drafts: {},
  toasts: [],
};

const listeners = new Set<() => void>();

export function getState() {
  return state;
}

export function setState(update: Partial<AppState> | ((current: AppState) => Partial<AppState>)) {
  const patch = typeof update === 'function' ? update(state) : update;
  const next = { ...state, ...patch };
  const routeChanged = patch.view && JSON.stringify(patch.view) !== JSON.stringify(state.view);
  const active = routeChanged ? (next.view.kind === 'session' ? next.view.id : undefined) : next.detailSessionId;
  if (routeChanged) {
    next.historyPage = undefined;
    const previous = state.historyFocusId;
    if (previous && previous !== active) {
      next.sessions = { ...next.sessions };
      delete next.sessions[previous];
      if (next.historyFocusId === previous) next.historyFocusId = undefined;
    }
  }
  if (routeChanged || active !== state.detailSessionId) {
    next.detailSessionId = active;
    next.detailEpoch = (state.detailEpoch ?? 0) + 1;
    next.details = {}; next.metrics = {}; next.inspectorRevision = {}; next.messageWindow = undefined;
  }
  if (patch.layout && patch.layout !== state.layout) localStorage.setItem(layoutKey, JSON.stringify(next.layout));
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** selector 必须返回 state 中已有的引用或原始值；派生集合请在组件内 useMemo。 */
export function useApp<T>(selector: (current: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export const setLayout = (patch: Partial<AppState['layout']>) => setState(current => ({ layout: { ...current.layout, ...patch } }));
