import { useRef, useState } from 'react';
import { gateway } from '../../api';
import { go, openIdeView, openSettings, promote, toggleTheme } from '../../app/actions';
import { panelViews, setLayout, useApp } from '../../app/store';
import { Icon } from '../../components/Icon';
import { Button, IconButton, Menu, Popover, StatusDot } from '../../components/ui';
import { modeMeta, sessionStatus } from '../../lib/status';
import { PermissionPicker } from '../session/Pickers';
import { ApprovalChip } from './Overlays';
import { CoordinationHint } from '../panel/CoordinationPanel';

const viewTitle: Record<string, string> = { home: '首页', projects: '项目', history: '历史', settings: '设置', session: '会话' };

function ProjectSwitcher({ projectId }: { projectId?: string }) {
  const projects = useApp(s => s.projects);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const current = projects.find(p => p.id === projectId);
  return (
    <>
      <button ref={anchor} type="button" className="crumb crumb--switch" onClick={() => setOpen(true)}>
        <Icon name="folder" size={14} /><span className="truncate">{current?.name ?? '选择项目'}</span><Icon name="chevronDown" size={12} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={280}>
        <Menu onClose={() => setOpen(false)} items={[
          ...projects.map(p => ({ id: p.id, label: p.name, icon: 'folder' as const, hint: p.branch, onSelect: () => openIdeView(p.id) })),
          'divider' as const,
          { id: 'add', label: '登记新项目…', icon: 'plus', onSelect: () => go('projects') },
        ]} />
      </Popover>
    </>
  );
}

export function TopBar() {
  const view = useApp(s => s.view), mode = useApp(s => s.mode), layout = useApp(s => s.layout);
  const session = useApp(s => (s.view.kind === 'session' ? s.sessions[s.view.id] : undefined));
  const project = useApp(s => s.projectId);
  const theme = useApp(s => s.settings?.appearance.theme);
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const status = session ? sessionStatus[session.status] : undefined;
  const ideProject = view.kind === 'ide' ? view.projectId : undefined;

  return (
    <header className="topbar">
      <div className="topbar__crumbs">
        {session ? (
          <>
            <span className="crumb crumb--mode"><Icon name={modeMeta[session.mode].icon} size={14} />{modeMeta[session.mode].label}</span>
            <Icon name="chevronRight" size={12} className="muted" />
            <span className="crumb crumb--title truncate">{session.title}</span>
            {status && <span className={`state-pill state-pill--${status.tone}`}><StatusDot tone={status.tone} pulse={status.live} />{status.label}</span>}
          </>
        ) : view.kind === 'ide' ? (
          <>
            <span className="crumb crumb--mode"><Icon name="terminal" size={14} />IDE</span>
            <Icon name="chevronRight" size={12} className="muted" />
            <ProjectSwitcher projectId={ideProject} />
          </>
        ) : <span className="crumb crumb--title">{view.kind === 'home' ? `${modeMeta[mode].label} · ${modeMeta[mode].tagline}` : viewTitle[view.kind]}</span>}
      </div>
      <div className="topbar__actions">
        {session && <CoordinationHint sessionId={session.id} compact />}
        <ApprovalChip />
        {session && session.mode !== 'chat' && <PermissionPicker />}
        {session?.mode === 'code' && <IconButton icon="folder" label="文件树" active={layout.fileTreeOpen} onClick={() => setLayout({ fileTreeOpen: !layout.fileTreeOpen })} />}
        {(session?.mode === 'code' || (view.kind === 'home' && mode === 'code')) && <Button size="sm" variant="secondary" icon="terminal" onClick={() => openIdeView(session?.projectId ?? project)}>IDE</Button>}
        {view.kind === 'ide' && <Button size="sm" variant="ghost" iconRight="external" onClick={() => void gateway.desktop.openIde(ideProject)}>原生 IDE</Button>}
        <IconButton icon={theme === 'dark' ? 'moon' : 'sun'} label="切换主题" onClick={event => toggleTheme({ x: event.clientX, y: event.clientY })} />
        <IconButton ref={more} icon="more" label="更多" onClick={() => setMenu(true)} />
        <Popover anchor={more} open={menu} onClose={() => setMenu(false)} align="end" width={220}>
          <Menu onClose={() => setMenu(false)} items={[
            ...(session?.mode === 'chat' ? [{ id: 'promote', label: '升级为 Cowork 长任务', icon: 'layers' as const, onSelect: () => void promote(session.id, session.title, ['目标完成且有可验证证据']) }, 'divider' as const] : []),
            { id: 'ide', label: '打开 IDE 工作台', icon: 'terminal', onSelect: () => openIdeView() },
            { id: 'projects', label: '项目', icon: 'folder', onSelect: () => go('projects') },
            { id: 'history', label: '历史', icon: 'clock', onSelect: () => go('history') },
            { id: 'settings', label: '设置', icon: 'sliders', hint: 'Ctrl+,', onSelect: () => openSettings() },
            { id: 'shortcuts', label: '快捷键', icon: 'keyboard', onSelect: () => openSettings('shortcuts') },
          ]} />
        </Popover>
        {panelViews.has(view.kind) && !layout.inspectorOpen && (
          <>
            <span className="topbar__sep" aria-hidden="true" />
            <IconButton icon="panelRight" label="打开侧边面板  Ctrl+I" tipSide="bottom-end" onClick={() => setLayout({ inspectorOpen: true })} />
          </>
        )}
      </div>
    </header>
  );
}
