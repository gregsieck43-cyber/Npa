import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { AppMode, PermissionMode } from '../../api';
import { permissionModes } from '../../api/policy';
import { currentSessionId, go, goHome, newPanelTab, openIdeView, openInspector, openPanel, openSession, openSettings, setPermission, toggleTheme, togglePalette } from '../../app/actions';
import { setLayout, useApp, type InspectorTab } from '../../app/store';
import { Icon, type IconName } from '../../components/Icon';
import { Kbd, useOverlayFocus } from '../../components/ui';
import { usePresence } from '../../lib/motion';
import { relativeTime } from '../../lib/format';
import { fuzzy } from '../../lib/fuzzy';
import { modeMeta } from '../../lib/status';

interface Command { id: string; group: string; label: string; icon: IconName; hint?: string; keys?: string; run: () => void }

function Highlighted({ text, hits }: { text: string; hits: number[] }) {
  const set = new Set(hits);
  return <>{[...text].map((char, i) => set.has(i) ? <mark key={i}>{char}</mark> : <Fragment key={i}>{char}</Fragment>)}</>;
}

export function CommandPalette() {
  const open = useApp(s => s.paletteOpen), sessions = useApp(s => s.sessions), layout = useApp(s => s.layout);
  const currentMode = useApp(s => (s.view.kind === 'session' ? s.sessions[s.view.id]?.mode : undefined) ?? s.mode);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const presence = usePresence(open, 'slow');
  useOverlayFocus(open, dialog);

  useEffect(() => { if (open) { setQuery(''); setIndex(0); } }, [open]);

  const commands = useMemo<Command[]>(() => {
    const items: Command[] = [];
    for (const mode of Object.keys(modeMeta) as AppMode[]) items.push({ id: `new-${mode}`, group: '新建', label: `新建 ${modeMeta[mode].label} ${modeMeta[mode].noun}`, icon: modeMeta[mode].icon, keys: mode === 'chat' ? 'Ctrl+N' : undefined, run: () => goHome(mode) });
    items.push(
      { id: 'go-projects', group: '导航', label: '打开项目', icon: 'folder', run: () => go('projects') },
      { id: 'go-history', group: '导航', label: '打开历史', icon: 'clock', run: () => go('history') },
      { id: 'go-ide', group: '导航', label: '打开 IDE 工作台', icon: 'terminal', run: () => openIdeView() },
      { id: 'go-settings', group: '导航', label: '打开设置', icon: 'sliders', keys: 'Ctrl+,', run: () => openSettings() },
      { id: 'toggle-theme', group: '界面', label: '切换明暗主题', icon: 'moon', run: () => toggleTheme() },
      { id: 'toggle-sidebar', group: '界面', label: layout.sidebarOpen ? '收起侧栏' : '展开侧栏', icon: 'panelLeft', keys: 'Ctrl+B', run: () => setLayout({ sidebarOpen: !layout.sidebarOpen }) },
      { id: 'toggle-inspector', group: '界面', label: layout.inspectorOpen ? '收起侧边面板' : '打开侧边面板', icon: 'panelRight', keys: 'Ctrl+I', run: () => setLayout({ inspectorOpen: !layout.inspectorOpen }) },
    );
    items.push(
      { id: 'panel-sidechat', group: '侧边面板', label: '侧边聊天', icon: 'chat', keys: 'Ctrl+Alt+S', run: () => openPanel('sidechat') },
      { id: 'panel-terminal', group: '侧边面板', label: '终端', icon: 'terminal', keys: 'Ctrl+`', run: () => openPanel('terminal') },
      { id: 'panel-files', group: '侧边面板', label: '文件', icon: 'files', keys: 'Ctrl+P', run: () => openPanel('files') },
      { id: 'panel-changes', group: '侧边面板', label: '变更', icon: 'diff', run: () => openPanel('changes') },
      { id: 'panel-new', group: '侧边面板', label: '新标签页（网页）', icon: 'globe', run: () => newPanelTab() },
    );
    for (const tab of ['prompt', 'request', 'tools', 'trace', 'context', 'diff'] as InspectorTab[]) items.push({ id: `inspect-${tab}`, group: 'Inspector', label: `查看 ${tab[0].toUpperCase()}${tab.slice(1)}`, icon: 'eye', run: () => openInspector(tab) });
    if (currentMode !== 'chat') for (const mode of permissionModes) items.push({ id: `perm-${mode.id}`, group: '权限模式', label: `切换为「${mode.label}」`, icon: ({ 'read-only': 'lock', ask: 'shield', 'auto-review': 'shieldCheck', 'full-access': 'zap' } as Record<PermissionMode, IconName>)[mode.id], hint: mode.id === 'full-access' ? '工作区内无需审批' : undefined, run: () => setPermission(mode.id, currentSessionId()) });
    for (const session of Object.values(sessions).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) items.push({ id: `s-${session.id}`, group: '会话', label: session.title, icon: modeMeta[session.mode].icon, hint: relativeTime(session.updatedAt), run: () => void openSession(session.id) });
    return items;
  }, [sessions, layout, currentMode]);

  const results = useMemo(() => {
    if (!query.trim()) {
      const recent = commands.filter(c => c.group === '会话').slice(0, 6);
      return [...recent, ...commands.filter(c => c.group !== '会话')].map(c => ({ command: c, hits: [] as number[] }));
    }
    return commands.map(c => ({ command: c, match: fuzzy(query, c.label) ?? fuzzy(query, `${c.label} ${c.group} ${c.hint ?? ''}`) })).filter(r => r.match).sort((a, b) => b.match!.score - a.match!.score).slice(0, 40).map(r => ({ command: r.command, hits: r.match!.hits }));
  }, [commands, query]);

  useEffect(() => {
    const container = list.current, active = container?.querySelector<HTMLElement>('.is-active');
    if (!container || !active) return;
    const row = active.getBoundingClientRect(), viewport = container.getBoundingClientRect();
    if (row.top < viewport.top) container.scrollTop -= viewport.top - row.top;
    else if (row.bottom > viewport.bottom) container.scrollTop += row.bottom - viewport.bottom;
  }, [index, open]);

  if (!presence.mounted) return null;
  const run = (command: Command) => { togglePalette(false); command.run(); };
  let lastGroup = '';

  return (
    <div className="palette-backdrop" data-presence={presence.phase} style={presence.style} aria-hidden={!open || undefined} {...(!open ? { inert: '' } : {})} onPointerDown={event => { if (open && event.target === event.currentTarget) togglePalette(false); }}>
      <div ref={dialog} className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="palette__input">
          <Icon name="search" size={17} />
          <input role="combobox" aria-label="搜索命令" aria-expanded={open} aria-controls="palette-results" aria-activedescendant={results[index] ? `palette-option-${index}` : undefined} value={query} placeholder="搜索会话、命令、设置…" onChange={event => { setQuery(event.target.value); setIndex(0); }}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(i => Math.max(0, Math.min(results.length - 1, i + 1))); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(i => Math.max(0, i - 1)); }
              if (event.key === 'Home') { event.preventDefault(); setIndex(0); }
              if (event.key === 'End') { event.preventDefault(); setIndex(Math.max(0, results.length - 1)); }
              if (event.key === 'Enter' && results[index]) run(results[index].command);
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); togglePalette(false); }
            }} />
          <Kbd keys="Esc" />
        </div>
        <div ref={list} className="palette__list" id="palette-results" role="listbox">
          {results.length === 0 && <div className="palette__empty">没有匹配“{query}”的结果</div>}
          {results.map(({ command, hits }, i) => {
            const header = command.group !== lastGroup ? command.group : undefined;
            lastGroup = command.group;
            return (
              <Fragment key={command.id}>
                {header && <div className="palette__group">{header}</div>}
                <button type="button" role="option" tabIndex={-1} id={`palette-option-${i}`} aria-selected={i === index} className={`palette__item${i === index ? ' is-active' : ''}`} onMouseMove={() => setIndex(i)} onClick={() => run(command)}>
                  <Icon name={command.icon} size={15} />
                  <span className="grow truncate"><Highlighted text={command.label} hits={hits} /></span>
                  {command.hint && <span className="muted">{command.hint}</span>}
                  {command.keys && <Kbd keys={command.keys} />}
                </button>
              </Fragment>
            );
          })}
        </div>
        <div className="palette__foot"><span><Kbd keys="↑" /><Kbd keys="↓" /> 选择</span><span><Kbd keys="Enter" /> 执行</span><span className="grow" /><span className="muted">{results.length} 项</span></div>
      </div>
    </div>
  );
}
