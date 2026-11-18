import { useMemo, useRef, useState } from 'react';
import type { AppMode, SessionSummary } from '../../api';
import { go, goHome, openIdeView, openSession, openSettings, removeSession, setMode, toggleTheme, togglePalette, updateSession } from '../../app/actions';
import { setLayout, useApp } from '../../app/store';
import { Icon, type IconName } from '../../components/Icon';
import { Collapse, IconButton, Kbd, Menu, Popover, Segmented, StatusDot } from '../../components/ui';
import { dateGroup, relativeTime, type DateGroup } from '../../lib/format';
import { fuzzy } from '../../lib/fuzzy';
import { modeMeta, sessionStatus } from '../../lib/status';

const timeGroups: DateGroup[] = ['今天', '昨天', '本周', '本月', '更早'];

function NavItem({ icon, label, active, onClick, count }: { icon: IconName; label: string; active: boolean; onClick: () => void; count?: number }) {
  return (
    <button type="button" className={`nav-item${active ? ' is-active' : ''}`} onClick={onClick}>
      <Icon name={icon} size={16} />
      <span className="grow truncate">{label}</span>
      {count !== undefined && count > 0 && <span className="nav-item__count num">{count}</span>}
    </button>
  );
}

function SessionRow({ session, active }: { session: SessionSummary; active: boolean }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const status = sessionStatus[session.status];
  return (
    <div className={`session-row${active ? ' is-active' : ''}${menu ? ' is-menu' : ''}`}>
      <button type="button" className="session-row__main" onClick={() => void openSession(session.id)} onDoubleClick={() => setEditing(true)} title={session.title}>
        {status.live || status.tone === 'danger' ? <StatusDot tone={status.tone} pulse={status.live} /> : <span className="session-row__bullet" />}
        {editing ? (
          <input
            className="session-row__input" autoFocus defaultValue={session.title}
            onClick={event => event.stopPropagation()}
            onBlur={event => { setEditing(false); if (event.target.value.trim() && event.target.value !== session.title) void updateSession(session.id, { title: event.target.value.trim() }); }}
            onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setEditing(false); }}
          />
        ) : <span className="session-row__title truncate">{session.title}</span>}
        <span className="session-row__time">{status.live ? status.label : relativeTime(session.updatedAt)}</span>
      </button>
      <button ref={more} type="button" className="session-row__more" aria-label="会话操作" onClick={() => setMenu(true)}><Icon name="more" size={15} /></button>
      <Popover anchor={more} open={menu} onClose={() => setMenu(false)} align="end" width={188}>
        <Menu onClose={() => setMenu(false)} items={[
          { id: 'pin', label: session.pinned ? '取消置顶' : '置顶', icon: 'pin', onSelect: () => void updateSession(session.id, { pinned: !session.pinned }) },
          { id: 'rename', label: '重命名', icon: 'pencil', hint: '双击', onSelect: () => setEditing(true) },
          'divider',
          { id: 'delete', label: '删除会话', icon: 'trash', danger: true, onSelect: () => void removeSession(session.id) },
        ]} />
      </Popover>
    </div>
  );
}

function Group({ id, label, icon, count, children }: { id: string; label: string; icon?: IconName; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className={`side-group${open ? ' is-open' : ''}`} data-group={id}>
      <button type="button" className="side-group__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevronRight" size={11} className="side-group__chevron" />
        {icon && <Icon name={icon} size={13} />}
        <span className="grow truncate">{label}</span>
        <span className="side-group__count num">{count}</span>
      </button>
      <Collapse open={open}><div className="side-group__body">{children}</div></Collapse>
    </section>
  );
}

function NewButton({ mode }: { mode: AppMode }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div className="new-split">
      <button type="button" className="new-btn" onClick={() => goHome(mode)}>
        <Icon name="plus" size={16} className="new-btn__icon" />
        <span className="grow">新建{modeMeta[mode].noun}</span>
        <Kbd keys="Ctrl+N" />
      </button>
      <button ref={anchor} type="button" className="new-split__more" aria-label="更多新建选项" onClick={() => setOpen(true)}><Icon name="chevronDown" size={14} /></button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="end" width={220}>
        <Menu onClose={() => setOpen(false)} items={[
          ...(Object.keys(modeMeta) as AppMode[]).map(key => ({ id: key, label: `新建${modeMeta[key].noun}`, icon: modeMeta[key].icon, hint: modeMeta[key].label, onSelect: () => { setMode(key); goHome(key); } })),
          'divider',
          { id: 'ide', label: '在 IDE 中打开项目', icon: 'terminal', onSelect: () => openIdeView() },
          { id: 'projects', label: '登记新项目…', icon: 'folder', onSelect: () => go('projects') },
        ]} />
      </Popover>
    </div>
  );
}

function Rail() {
  const mode = useApp(s => s.mode), view = useApp(s => s.view), approvals = useApp(s => s.approvals), theme = useApp(s => s.settings?.appearance.theme);
  const pending = Object.keys(approvals).length;
  const item = (icon: IconName, label: string, active: boolean, onClick: () => void, badge?: number) => (
    <button key={label} type="button" className={`rail__btn${active ? ' is-active' : ''}`} aria-label={label} data-tip={label} data-tip-side="right" onClick={onClick}>
      <Icon name={icon} size={18} />
      {badge ? <span className="rail__badge num">{badge}</span> : null}
    </button>
  );
  return (
    <aside className="rail">
      <button type="button" className="rail__brand" aria-label="展开侧栏  Ctrl+B" data-tip="展开侧栏  Ctrl+B" data-tip-side="right" onClick={() => setLayout({ sidebarOpen: true })}><Icon name="panelLeft" size={18} /></button>
      <div className="rail__modes">
        {(Object.keys(modeMeta) as AppMode[]).map(key => item(modeMeta[key].icon, modeMeta[key].label, mode === key && view.kind !== 'ide', () => { setMode(key); goHome(key); }))}
      </div>
      <div className="rail__divider" />
      {item('plus', `新建${modeMeta[mode].noun}  Ctrl+N`, false, () => goHome(mode))}
      {item('search', '搜索与命令  Ctrl+K', false, () => togglePalette(true))}
      {item('folder', '项目', view.kind === 'projects', () => go('projects'))}
      {item('clock', '历史', view.kind === 'history', () => go('history'))}
      {item('terminal', 'IDE', view.kind === 'ide', () => openIdeView())}
      {pending > 0 && item('shieldAlert', '待审批', false, () => { const first = Object.values(approvals)[0]; if (first) void openSession(first.sessionId); }, pending)}
      <span className="grow" />
      {item(theme === 'dark' ? 'moon' : 'sun', '切换主题', false, () => toggleTheme())}
      {item('sliders', '设置', view.kind === 'settings', () => openSettings())}
    </aside>
  );
}

export function Sidebar() {
  const open = useApp(s => s.layout.sidebarOpen);
  return open ? <ExpandedSidebar /> : <Rail />;
}

function ExpandedSidebar() {
  const mode = useApp(s => s.mode), view = useApp(s => s.view), sessions = useApp(s => s.sessions), approvals = useApp(s => s.approvals);
  const projects = useApp(s => s.projects), grouping = useApp(s => s.layout.sidebarGroup), connection = useApp(s => s.connection), theme = useApp(s => s.settings?.appearance.theme);
  const [filter, setFilter] = useState('');
  const activeId = view.kind === 'session' ? view.id : undefined;

  const counts = useMemo(() => {
    const result: Record<AppMode, number> = { chat: 0, cowork: 0, code: 0 };
    for (const item of Object.values(sessions)) if (sessionStatus[item.status].live) result[item.mode]++;
    return result;
  }, [sessions]);

  const { pinned, groups, total } = useMemo(() => {
    const list = Object.values(sessions)
      .filter(item => item.mode === mode)
      .filter(item => !filter.trim() || fuzzy(filter, `${item.title} ${item.preview ?? ''}`))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const rest = list.filter(item => !item.pinned);
    const map = new Map<string, { label: string; icon?: IconName; items: SessionSummary[] }>();
    for (const item of rest) {
      const key = grouping === 'time' ? dateGroup(item.updatedAt) : item.projectId ?? '__none';
      const label = grouping === 'time' ? key : projects.find(p => p.id === key)?.name ?? '未关联项目';
      const entry = map.get(key) ?? { label, icon: grouping === 'project' ? (key === '__none' ? 'chat' : 'folder') : undefined, items: [] };
      entry.items.push(item);
      map.set(key, entry);
    }
    const ordered = grouping === 'time' ? timeGroups.filter(g => map.has(g)).map(g => [g, map.get(g)!] as const) : [...map.entries()].sort((a, b) => (a[0] === '__none' ? 1 : b[0] === '__none' ? -1 : 0));
    return { pinned: list.filter(item => item.pinned), groups: ordered, total: list.length };
  }, [sessions, mode, filter, grouping, projects]);

  const pendingApprovals = Object.keys(approvals).length;

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="wordmark"><span className="wordmark__npn">NPN</span><span className="wordmark__gamma">Gamma</span></span>
        <span className="grow" />
        <IconButton icon="panelLeft" label="收成图标栏  Ctrl+B" onClick={() => setLayout({ sidebarOpen: false })} />
      </div>

      <Segmented
        className="sidebar__modes"
        value={mode}
        onChange={value => { setMode(value); goHome(value); }}
        options={(Object.keys(modeMeta) as AppMode[]).map(key => ({ value: key, icon: modeMeta[key].icon, title: modeMeta[key].tagline, label: <>{modeMeta[key].label}{counts[key] > 0 && <span className="mode-live" />}</> }))}
      />

      <NewButton mode={mode} />

      <nav className="sidebar__nav">
        <NavItem icon="home" label="首页" active={view.kind === 'home'} onClick={() => goHome()} />
        <NavItem icon="folder" label="项目" active={view.kind === 'projects'} onClick={() => go('projects')} />
        <NavItem icon="terminal" label="IDE" active={view.kind === 'ide'} onClick={() => openIdeView()} />
        <NavItem icon="clock" label="历史" active={view.kind === 'history'} onClick={() => go('history')} />
        {pendingApprovals > 0 && <NavItem icon="shieldAlert" label="待审批" active={false} count={pendingApprovals} onClick={() => { const first = Object.values(approvals)[0]; if (first) void openSession(first.sessionId); }} />}
      </nav>

      <div className="sidebar__tools">
        <label className="side-filter"><Icon name="search" size={13} /><input value={filter} onChange={event => setFilter(event.target.value)} placeholder={`筛选${modeMeta[mode].noun}`} />{filter && <button type="button" aria-label="清除筛选" onClick={() => setFilter('')}><Icon name="x" size={12} /></button>}</label>
        <div className="side-switch" role="tablist" aria-label="分组方式">
          <button type="button" role="tab" aria-selected={grouping === 'time'} className={grouping === 'time' ? 'is-on' : ''} data-tip="按时间分组" onClick={() => setLayout({ sidebarGroup: 'time' })}><Icon name="clock" size={13} /></button>
          <button type="button" role="tab" aria-selected={grouping === 'project'} className={grouping === 'project' ? 'is-on' : ''} data-tip="按项目分组" onClick={() => setLayout({ sidebarGroup: 'project' })}><Icon name="folder" size={13} /></button>
        </div>
      </div>

      <div className="sidebar__sessions">
        {pinned.length > 0 && <Group id="pinned" label="置顶" icon="pin" count={pinned.length}>{pinned.map(item => <SessionRow key={item.id} session={item} active={item.id === activeId} />)}</Group>}
        {groups.map(([key, group]) => <Group key={`${grouping}-${key}`} id={key} label={group.label} icon={group.icon} count={group.items.length}>{group.items.map(item => <SessionRow key={item.id} session={item} active={item.id === activeId} />)}</Group>)}
        {total === 0 && <div className="sidebar__empty">{filter ? `没有匹配“${filter}”的${modeMeta[mode].noun}` : `还没有${modeMeta[mode].noun}，从上方新建一个。`}</div>}
      </div>

      <div className="sidebar__foot">
        <button type="button" className={`nav-item${view.kind === 'settings' ? ' is-active' : ''}`} onClick={() => openSettings()}>
          <Icon name="sliders" size={16} /><span className="grow">设置</span>
        </button>
        <IconButton icon={theme === 'dark' ? 'moon' : 'sun'} className="theme-toggle" label="切换主题" tipSide="top" onClick={event => toggleTheme({ x: event.clientX, y: event.clientY })} />
        <span className={`conn-chip conn-chip--${connection?.status ?? 'connecting'}`} data-tip={connection?.demo ? '前端演示网关：所有数据均为演示数据' : connection?.message ?? '后台连接'} data-tip-side="top">
          <StatusDot tone={connection?.status === 'online' ? 'ok' : connection?.status === 'offline' ? 'danger' : 'warn'} pulse={connection?.status === 'connecting'} />
          {connection?.demo ? '演示' : connection?.status === 'online' ? '在线' : '离线'}
        </span>
      </div>
    </aside>
  );
}
