import { useEffect } from 'react';
import type { AppMode } from '../api';
import { ErrorBanner, ResizeHandle } from '../components/ui';
import { HomeView } from '../features/home/HomeView';
import { IdeView } from '../features/ide/IdeView';
import { SidePanel } from '../features/panel/SidePanel';
import { HistoryView } from '../features/pages/HistoryView';
import { ProjectsView } from '../features/pages/ProjectsView';
import { SettingsView } from '../features/pages/SettingsView';
import { SessionView } from '../features/session/SessionView';
import { CommandPalette } from '../features/shell/CommandPalette';
import { Toasts } from '../features/shell/Overlays';
import { Sidebar } from '../features/shell/Sidebar';
import { StatusBar } from '../features/shell/StatusBar';
import { TopBar } from '../features/shell/TopBar';
import { boot, cancel, currentSessionId, goHome, openPanel, openSettings, setMode, togglePalette } from './actions';
import { getState, panelViews, setLayout, useApp } from './store';

const modeKeys: Record<string, AppMode> = { '1': 'chat', '2': 'cowork', '3': 'code' };

function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey, state = getState();
      if (mod && event.key.toLowerCase() === 'k') { event.preventDefault(); togglePalette(); return; }
      if (mod && event.key.toLowerCase() === 'n') { event.preventDefault(); goHome(state.mode); return; }
      if (mod && event.key.toLowerCase() === 'b') { event.preventDefault(); setLayout({ sidebarOpen: !state.layout.sidebarOpen }); return; }
      if (mod && event.key.toLowerCase() === 'i') { event.preventDefault(); setLayout({ inspectorOpen: !state.layout.inspectorOpen, panelMaximized: false }); return; }
      if (mod && event.key === ',') { event.preventDefault(); openSettings(); return; }
      if (panelViews.has(state.view.kind)) {
        if (mod && event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); openPanel('sidechat'); return; }
        if (mod && !event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); openPanel('files'); return; }
        if (mod && event.key === '`') { event.preventDefault(); openPanel('terminal'); return; }
      }
      if (mod && modeKeys[event.key]) { event.preventDefault(); setMode(modeKeys[event.key]); goHome(modeKeys[event.key]); return; }
      if (event.key === 'Escape' && !state.paletteOpen && !document.querySelector('.modal, .popover')) {
        const id = currentSessionId(), session = id ? state.sessions[id] : undefined;
        if (session && ['streaming', 'running'].includes(session.status)) void cancel(session.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function Splash({ error }: { error?: string }) {
  return (
    <div className="splash">
      <div className="splash__mark"><span className="wordmark wordmark--xl"><span className="wordmark__npn">NPN</span><span className="wordmark__gamma gradient-text">Gamma</span></span></div>
      {error ? <div className="splash__error"><ErrorBanner message={`无法连接后台：${error}`} onRetry={() => void boot()} /></div> : <div className="splash__bar"><span /></div>}
    </div>
  );
}

function Stage() {
  const view = useApp(s => s.view);
  switch (view.kind) {
    case 'home': return <HomeView />;
    case 'session': return <SessionView key={view.id} id={view.id} />;
    case 'projects': return <ProjectsView />;
    case 'history': return <HistoryView />;
    case 'settings': return <SettingsView section={view.section} />;
    case 'ide': return <IdeView projectId={view.projectId} />;
  }
}

export function App() {
  const booted = useApp(s => s.booted), bootError = useApp(s => s.bootError), layout = useApp(s => s.layout);
  const viewKey = useApp(s => (s.view.kind === 'session' ? `s:${s.view.id}` : s.view.kind === 'ide' ? `ide:${s.view.projectId}` : s.view.kind));
  const hasPanel = useApp(s => panelViews.has(s.view.kind));
  useShortcuts();
  useEffect(() => { void boot(); }, []);

  return (
    <>
      <div className="ambient" aria-hidden="true"><div className="ambient__blob ambient__blob--a" /><div className="ambient__blob ambient__blob--b" /><div className="ambient__blob ambient__blob--c" /><div className="ambient__grain" /></div>
      {!booted || bootError ? <Splash error={bootError} /> : (
        <div className={`app${layout.sidebarOpen ? '' : ' is-sidebar-closed'}${layout.inspectorOpen ? '' : ' is-inspector-closed'}${layout.inspectorOpen && layout.panelMaximized && hasPanel ? ' is-panel-max' : ''}`}>
          <div className="app__sidebar" style={{ width: layout.sidebarOpen ? layout.sidebarWidth : 56 }}>
            <Sidebar />
            {layout.sidebarOpen && <ResizeHandle side="right" onResize={delta => setLayout({ sidebarWidth: Math.min(380, Math.max(220, getState().layout.sidebarWidth + delta)) })} onDoubleClick={() => setLayout({ sidebarWidth: 272 })} />}
          </div>
          <main className="stage">
            <TopBar />
            <div className="stage__view" key={viewKey}><Stage /></div>
            <StatusBar />
          </main>
          <SidePanel open={layout.inspectorOpen && hasPanel} />
        </div>
      )}
      <CommandPalette />
      <Toasts />
    </>
  );
}
