import { useEffect, useRef, useState } from 'react';
import { activatePanelTab, closePanelTab, newPanelTab } from '../../app/actions';
import { getState, setLayout, useApp, type PanelTab } from '../../app/store';
import { Icon } from '../../components/Icon';
import { Button, EmptyState, IconButton, ResizeHandle } from '../../components/ui';
import { InspectorBody } from '../inspector/Inspector';
import { hostOf } from '../../lib/panel';
import { usePresence } from '../../lib/motion';
import { CoordinationPanel } from './CoordinationPanel';
import { BrowserTab, ChangesTab, FilesTab, LauncherTab, panelMeta, SideChatTab, TerminalTab } from './PanelTabs';

const sessionOnly: Partial<Record<PanelTab['kind'], string>> = {
  changes: '这里汇总当前会话中 Agent 修改的文件。',
  inspector: '打开会话后可查看提示词、真实请求、工具、轨迹、上下文与 Diff。',
};

function TabBody({ tab, sessionId }: { tab: PanelTab; sessionId?: string }) {
  const hint = sessionOnly[tab.kind];
  if (!sessionId && hint) {
    return <div className="ptab"><EmptyState icon={panelMeta[tab.kind].icon} title="打开一个会话后可用" detail={hint} action={<Button size="sm" variant="secondary" icon="globe" onClick={newPanelTab}>终端、文件与网页</Button>} /></div>;
  }
  switch (tab.kind) {
    case 'launcher': return <LauncherTab />;
    case 'changes': return <ChangesTab sessionId={sessionId} />;
    case 'inspector': return <div className="ptab ptab--inspector"><InspectorBody sessionId={sessionId} /></div>;
    case 'browser': return <BrowserTab tab={tab} />;
    case 'terminal': return <TerminalTab sessionId={sessionId} />;
    case 'sidechat': return <SideChatTab sessionId={sessionId} />;
    case 'files': return <FilesTab sessionId={sessionId} />;
    case 'coordination': return <CoordinationPanel sessionId={sessionId} />;
  }
}

/** 右侧边面板：多标签（变更 / 检查器 / 网页 / 终端 / 侧边聊天 / 文件）。所有标签保持挂载，切换时不丢失状态。 */
export function SidePanel({ open = true }: { open?: boolean }) {
  const panel = useApp(s => s.panel), width = useApp(s => s.layout.inspectorWidth), maximized = useApp(s => s.layout.panelMaximized);
  const sessionId = useApp(s => (s.view.kind === 'session' ? s.view.id : undefined));
  const strip = useRef<HTMLDivElement>(null);
  const presence = usePresence(open, 'slow');
  const [viewport, setViewport] = useState(window.innerWidth);
  useEffect(() => { const resize = () => setViewport(window.innerWidth); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  useEffect(() => {
    const container = strip.current, tab = container?.querySelector<HTMLElement>('.sptab.is-active');
    if (!container || !tab) return;
    const bounds = container.getBoundingClientRect(), target = tab.getBoundingClientRect();
    if (target.left < bounds.left) container.scrollLeft += target.left - bounds.left;
    else if (target.right > bounds.right) container.scrollLeft += target.right - bounds.right;
  }, [panel.active, panel.tabs.length, presence.mounted]);
  if (!presence.mounted) return null;
  const boundedWidth = Math.min(width, Math.max(0, viewport - 16));
  return (
    <aside className={`sidepanel${maximized ? ' is-maximized' : ''}`} data-presence={presence.phase} {...(!open ? { inert: '' } : {})} aria-hidden={!open || undefined} style={{ ...presence.style, ...(!maximized ? { width: open ? boundedWidth : 0 } : {}) }}>
      {!maximized && <ResizeHandle side="left" onResize={delta => { const maximum = Math.min(window.innerWidth - 16, Math.max(320, Math.round(window.innerWidth * 0.6))); setLayout({ inspectorWidth: Math.max(Math.min(320, maximum), Math.min(getState().layout.inspectorWidth + delta, maximum)) }); }} onDoubleClick={() => setLayout({ inspectorWidth: 420 })} />}
      <div className="sidepanel__tabs" role="tablist">
        <div className="sidepanel__scroll" ref={strip}>
          {panel.tabs.map(tab => {
            const label = tab.kind === 'browser' && tab.history[tab.index] ? hostOf(tab.history[tab.index]) : panelMeta[tab.kind].label;
            return (
              <div key={tab.id} role="tab" aria-selected={tab.id === panel.active} className={`sptab${tab.id === panel.active ? ' is-active' : ''}`} onClick={() => activatePanelTab(tab.id)} onAuxClick={e => { if (e.button === 1) closePanelTab(tab.id); }} title={label}>
                <Icon name={panelMeta[tab.kind].icon} size={13} />
                <span className="truncate">{label}</span>
                <button type="button" className="sptab__close" aria-label="关闭标签" onClick={e => { e.stopPropagation(); closePanelTab(tab.id); }}><Icon name="x" size={11} /></button>
              </div>
            );
          })}
        </div>
        <IconButton icon="plus" label="新标签页" size={14} onClick={newPanelTab} />
        <span className="sidepanel__sep" aria-hidden="true" />
        <IconButton icon={maximized ? 'minimize' : 'maximize'} label={maximized ? '还原面板' : '最大化面板'} size={13} tipSide="bottom-end" onClick={() => setLayout({ panelMaximized: !maximized })} />
        <IconButton icon="panelRight" label="收起侧边面板  Ctrl+I" size={15} tipSide="bottom-end" onClick={() => setLayout({ inspectorOpen: false, panelMaximized: false })} />
      </div>
      <div className="sidepanel__body">
        {panel.tabs.map(tab => <div key={tab.id} className="sidepanel__pane" hidden={tab.id !== panel.active}><TabBody tab={tab} sessionId={sessionId} /></div>)}
      </div>
    </aside>
  );
}
