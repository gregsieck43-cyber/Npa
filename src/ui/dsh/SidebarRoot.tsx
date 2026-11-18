/* DeepSeek Harness SidebarRoot (MIT), adapted to NPN routes and sessions.
 * Retains the source's logo/new-session/panels/region/footer composition. */
import { useEffect, useRef, useState } from 'react';
import { DomSeat } from './DomSeat.js';
import css from './SidebarRoot.module.css';
export interface SidebarRoute { id: string; label: string; caption: string; icon: Element; active: boolean; onClick: () => void }
export interface SidebarRootProps {
  collapsed: boolean; brand: HTMLElement; region: HTMLElement; footer: HTMLElement;
  routes: SidebarRoute[]; newLabel: string; newSession: () => void; toggle: () => void;
}
export function SidebarRoot({ collapsed, brand, region, footer, routes, newLabel, newSession, toggle }: SidebarRootProps) {
  const [settled, setSettled] = useState(collapsed);
  const everWide = useRef(!collapsed);
  if (!collapsed) everWide.current = true;
  useEffect(() => { if (!collapsed) { setSettled(false); return; } const timer = setTimeout(() => setSettled(true), 150); return () => clearTimeout(timer); }, [collapsed]);
  const wide = !collapsed || !settled;
  return <div className={[css.root, !wide && css.collapsed, !wide && everWide.current && css.railIn, collapsed && wide && css.fading].filter(Boolean).join(' ')}>
    <div className={css.logoRow}>
      {wide && <button className={`${css.brand} ${css.wide}`} aria-label={newLabel} onClick={newSession}><DomSeat node={brand} className={css.brandIdentity} /></button>}
      <button className={`${css.iconButton} npn-sidebar-toggle`} title={collapsed ? '展开导航' : '收起导航'} aria-label={collapsed ? '展开导航' : '收起导航'} data-testid="close-sessions" onClick={toggle}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>
      </button>
    </div>
    <button className={css.newSession} title={newLabel} data-testid="sidebar-new-task" onClick={newSession}>
      <span className={css.newSessionLabelMask}><span className={css.newSessionContent}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 5v14M5 12h14"/></svg>{wide && <span className={`${css.newSessionLabel} ${css.wide}`}>{newLabel}</span>}</span></span>
      {wide && <span className={css.newSessionShortcut}><kbd>Ctrl N</kbd></span>}
    </button>
    <nav className={css.panelList} aria-label="产品导航">{routes.map(route => <button key={route.id} className={`${css.panelRow} ${route.active ? css.panelActive : ''}`} title={route.label} aria-label={route.label} aria-current={route.active ? 'page' : undefined} data-testid={route.id} onClick={route.onClick}><DomSeat node={route.icon} className={css.panelGlyph}/>{wide && <><span className={`${css.panelTitle} ${css.wide}`}>{route.label}</span><span className="navigation-caption">{route.caption}</span></>}</button>)}</nav>
    <div className={css.regionArea}>{wide && <DomSeat node={region} className="npn-sidebar-region" />}</div>
    <div className={css.footArea}><DomSeat node={footer} className={css.settingsArea} /></div>
  </div>;
}

