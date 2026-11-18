import '../message-window-dom/entry';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { TaskDetail, ToolCallView } from '../../api/types';

void (async () => {
  while (!(window as unknown as { __window?: unknown }).__window) await new Promise(resolve => setTimeout(resolve, 0));
  const { gateway } = await import('../../api');
  const { getState, setState, setLayout, useApp } = await import('../../app/store');
  const { SidePanel } = await import('../../features/panel/SidePanel');
  const { Sidebar } = await import('../../features/shell/Sidebar');
  const { ToolCard } = await import('../../features/session/ToolCard');
  const { SideChatTab } = await import('../../features/panel/PanelTabs');
  const extra = document.createElement('div'); extra.id = 'extra'; document.body.append(extra);
  const root = createRoot(extra);
  let resolveSend: ((value: { sessionId: string; messageId: string }) => void) | undefined;
  let rejectSend: ((reason: Error) => void) | undefined;
  let sends = 0, picks = 0, copied = '', copyFailure = false;
  let rejectApproval: (() => void) | undefined, resolveApproval: (() => void) | undefined;
  let sideReads = 0;
  Object.defineProperty(navigator.clipboard, 'writeText', { value: async (text: string) => { if (copyFailure) throw new Error('clipboard unavailable'); copied = text; } });
  gateway.desktop.pickFiles = async () => [{ id: `file-${++picks}`, name: `file-${picks}.txt`, bytes: 1, kind: 'file' }];
  const call: ToolCallView = { id: 'tool', name: 'read_file', title: '读取文件', source: 'builtin', capability: 'read', risk: 'low', args: { path: 'full.txt' }, status: 'succeeded', result: { kind: 'text', text: '完整工具结果' } };
  function PanelFixture() { const layout = useApp(state => state.layout); return createElement('div', { className: `app${layout.inspectorOpen && layout.panelMaximized ? ' is-panel-max' : ''}` }, createElement('main', { className: 'stage' }, '主内容'), createElement(SidePanel, { open: layout.inspectorOpen })); }
  const showPanel = (open: boolean) => { setLayout({ inspectorOpen: open }); root.render(createElement(PanelFixture)); };
  let pauseRequests = 0;
  let finishPause: ((succeed: boolean) => void) | undefined;
  Object.assign(window, { __interaction: {
    deferPause() {
      const task: TaskDetail = { id: 'a', title: '暂停反馈用例', status: 'running', phase: '执行中', revision: 1,
        goal: { objective: '等待暂停', constraints: [], acceptance: [], mode: 'collaborative' }, plan: [], checkpoints: [], subagents: [],
        verification: { status: 'pending', items: [] }, budget: { modelCalls: 0, maxModelCalls: 1, toolCalls: 0, maxToolCalls: 1, tokens: 0 }, startedAt: '', updatedAt: '' };
      setState(state => ({ details: { ...state.details, a: { ...state.details.a!, task } } }));
      pauseRequests = 0;
      gateway.tasks.control = (id, action) => {
        if (id !== task.id || action !== 'pause') throw new Error('Unexpected control in the pause fixture');
        pauseRequests++;
        return new Promise((resolve, reject) => { finishPause = succeed => succeed ? resolve({ ...task, status: 'paused', revision: 2 }) : reject(new Error('fixture pause failure')); });
      };
    },
    finishPause(succeed: boolean) { finishPause?.(succeed); },
    pauseRequests: () => pauseRequests,
    deferSend() { sends = 0; gateway.chat.send = async () => { sends++; return new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; }); }; },
    finishSend(ok: boolean) { if (ok) resolveSend?.({ sessionId: 'a', messageId: 'sent' }); else rejectSend?.(new Error('fixture send failure')); },
    clipboard(fail: boolean) { copyFailure = fail; },
    state: () => ({ sends, picks, copied, sideReads, drafts: getState().drafts, width: getState().layout.inspectorWidth }),
    approval(ok: boolean) { if (ok) resolveApproval?.(); else rejectApproval?.(); },
    approvalEvent() { setState({ approvals: {} }); },
    show(kind: 'panel' | 'sidebar' | 'tool' | 'approval' | 'sidechat') {
      document.getElementById('root')!.hidden = true; extra.hidden = false;
      if (kind === 'panel') { setState({ panel: { active: 't0', tabs: Array.from({ length: 12 }, (_, n) => ({ id: `t${n}`, kind: 'launcher', history: [], index: 0 })) } }); setLayout({ inspectorWidth: 420, panelMaximized: false }); showPanel(true); }
      if (kind === 'sidebar') root.render(createElement(Sidebar));
      if (kind === 'tool') root.render(createElement(ToolCard, { call }));
      if (kind === 'approval') {
        gateway.approvals.decide = async () => new Promise<void>((resolve, reject) => { resolveApproval = resolve; rejectApproval = () => reject(new Error('fixture stale approval')); });
        setState({ approvals: { approval: { id: 'approval', sessionId: 'a', toolCallId: 'tool', title: '读取文件', reason: '需要批准', capability: 'read', risk: 'low', preview: 'full.txt', previewKind: 'text', digest: 'current-digest', createdAt: '' } } });
        root.render(createElement(ToolCard, { call: { ...call, status: 'awaiting_approval', approvalId: 'approval' } }));
      }
      if (kind === 'sidechat') {
        sideReads = 0;
        gateway.chat.sideHistory = async input => { sideReads++; return { sideSessionId: 'side', items: Array.from({ length: 40 }, (_, n) => ({ id: `s${(input.before ? 0 : 40) + n}`, question: `问题 ${n}`, answer: '完整回答。'.repeat(20), status: 'completed' as const, createdAt: '' })), nextCursor: input.before ? undefined : 'older' }; };
        setState({ sideChats: {}, sideChatMeta: undefined }); root.render(createElement(SideChatTab, { sessionId: 'a' }));
      }
    },
    panel: showPanel,
    activateTab() { setState({ panel: { ...getState().panel, active: 't11' } }); },
    sideAppend() { const rows = getState().sideChats.a ?? []; setState({ sideChats: { a: [...rows, { id: 'new', question: '新问题', answer: '新回答', status: 'completed', createdAt: '' }] } }); },
    sidePending() { const meta = getState().sideChatMeta!; setState({ sideChatMeta: { ...meta, pending: { id: 'pending', question: '待处理', answer: '', status: 'running', createdAt: '' } } }); },
    session() { extra.hidden = true; document.getElementById('root')!.hidden = false; },
    reduced(value: boolean) { document.documentElement.dataset.motion = value ? 'reduced' : 'full'; },
  } });
})();
