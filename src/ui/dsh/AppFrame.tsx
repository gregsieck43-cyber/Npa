/* Adapted from DeepSeek Harness (MIT), ui-layout/AppFrame.tsx.
 * NPN supplies DOM-owned product panels instead of Cordis slots. */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { DomSeat } from './DomSeat.js';
import { clampWidth, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX } from './columns.js';
import css from './AppFrame.module.css';

function DragHandle({ left, onWidth }: { left: number; onWidth: (value: number) => void }) {
  const drag = useRef<{ origin: number; width: number }>();
  return <div className={css.handle} style={{ left }} role="separator" tabIndex={0} aria-label="调整侧栏宽度" aria-orientation="vertical" aria-valuenow={left} aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { origin: event.clientX, width: left }; }}
    onPointerMove={event => { if (drag.current) onWidth(drag.current.width + event.clientX - drag.current.origin); }}
    onPointerUp={event => { drag.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId); }}
    onLostPointerCapture={() => { drag.current = undefined; }}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onWidth(left + (event.key === 'ArrowRight' ? 16 : -16)); } }} />;
}
export interface AppFrameProps {
  sidebar: HTMLElement; main: HTMLElement; right: HTMLElement;
  collapsed: boolean; drawerOpen: boolean; ide: boolean;
}
export function AppFrame({ sidebar, main, right, collapsed, drawerOpen, ide }: AppFrameProps) {
  const frame = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(window.innerWidth);
  const [width, setWidth] = useState(clampWidth(Number(localStorage.getItem('npn.dsh.sidebar.width')) || SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX));
  const [animating, setAnimating] = useState(false);
  const narrow = viewport <= 760;
  const track = narrow ? 0 : ide ? (drawerOpen ? width : 56) : collapsed ? 0 : width;
  const prior = useRef(track);
  useEffect(() => { const node = frame.current!; const observer = new ResizeObserver(([entry]) => setViewport(entry.contentRect.width)); observer.observe(node); return () => observer.disconnect(); }, []);
  useEffect(() => { if (prior.current === track) return; prior.current = track; setAnimating(true); const timer = setTimeout(() => setAnimating(false), 300); return () => clearTimeout(timer); }, [track]);
  const onWidth = (value: number) => { const next = clampWidth(value, SIDEBAR_MIN, SIDEBAR_MAX); setWidth(next); localStorage.setItem('npn.dsh.sidebar.width', String(next)); setAnimating(false); };
  return <div ref={frame} className={`${css.frame} npn-dsh-frame`} style={{ gridTemplateColumns: `${track}px minmax(0,1fr) auto` }} data-animating={animating || undefined} data-sidebar-collapsed={track === 0 || undefined}>
    {narrow && drawerOpen && <button className="npn-dsh-backdrop" aria-label="收起导航" onClick={() => document.querySelector<HTMLButtonElement>('[data-testid="toggle-sessions"]')?.click()} />}
    <div className={`${css.sidebarCol} npn-dsh-sidebar-col${narrow && drawerOpen ? ' drawer-visible' : ''}`} style={narrow && drawerOpen ? { width } : undefined}><DomSeat node={sidebar} className="npn-dsh-sidebar-seat" /></div>
    <div className={css.centerCol}><DomSeat node={main} className="npn-dsh-main-seat" /></div>
    <div className={`${css.rightbarCol} npn-dsh-right-col`}><DomSeat node={right} className="npn-dsh-right-seat" /></div>
    {!narrow && track > 56 && <DragHandle left={track} onWidth={onWidth} />}
  </div>;
}
