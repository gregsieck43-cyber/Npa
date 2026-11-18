import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import { usePresence, useRetainedContent } from '../lib/motion';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'glow';

export function Button({ variant = 'secondary', icon, iconRight, size = 'md', children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; icon?: IconName; iconRight?: IconName; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button type="button" className={`btn btn--${variant} btn--${size}${className ? ` ${className}` : ''}`} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children && <span className="btn__label">{children}</span>}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 14 : 16} />}
    </button>
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; size?: number; active?: boolean; tipSide?: 'bottom' | 'bottom-end' | 'top' | 'right' | 'left' };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ icon, label, size = 16, active, className, tipSide = 'bottom', ...rest }, ref) {
  return (
    <button ref={ref} type="button" aria-label={label} data-tip={label} data-tip-side={tipSide} className={`icon-btn${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
});

export function Kbd({ keys }: { keys: string }) {
  return <span className="kbd-group">{keys.split('+').map(key => <kbd key={key} className="kbd">{key}</kbd>)}</span>;
}

export function Badge({ tone = 'neutral', children, icon, pulse }: { tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info'; children: ReactNode; icon?: IconName; pulse?: boolean }) {
  return <span className={`badge badge--${tone}${pulse ? ' badge--pulse' : ''}`}>{icon && <Icon name={icon} size={12} />}{children}</span>;
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="加载中" />;
}

export function StatusDot({ tone, pulse }: { tone: 'ok' | 'warn' | 'danger' | 'info' | 'idle' | 'accent'; pulse?: boolean }) {
  return <span className={`status-dot status-dot--${tone}${pulse ? ' status-dot--pulse' : ''}`} />;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="switch__thumb" />
    </button>
  );
}

export interface SegmentOption<T extends string> { value: T; label: ReactNode; icon?: IconName; title?: string }

/** 带滑动指示器的分段控件。 */
export function Segmented<T extends string>({ value, options, onChange, size = 'md', className }: { value: T; options: SegmentOption<T>[]; onChange: (value: T) => void; size?: 'sm' | 'md'; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<CSSProperties>({ opacity: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const active = ref.current?.querySelector<HTMLElement>('[data-active="true"]');
      if (active) setIndicator({ width: active.offsetWidth, transform: `translateX(${active.offsetLeft}px)`, opacity: 1 });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [value, options.length]);
  return (
    <div ref={ref} className={`segmented segmented--${size}${className ? ` ${className}` : ''}`} role="tablist">
      <span className="segmented__indicator" style={indicator} />
      {options.map(option => (
        <button key={option.value} type="button" role="tab" title={option.title} aria-selected={option.value === value} data-active={option.value === value} className="segmented__item" onClick={() => onChange(option.value)}>
          {option.icon && <Icon name={option.icon} size={size === 'sm' ? 13 : 15} />}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function useDismiss(open: boolean, onClose: () => void, refs: RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (refs.every(ref => !ref.current?.contains(event.target as Node))) onClose();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onPointer, true); window.removeEventListener('keydown', onKey); };
  }, [open, onClose, refs]);
}

/** 锚定到触发元素的浮层（Portal 到 body，避免被滚动容器裁剪）。 */
export function Popover({ anchor, open, onClose, children, placement = 'bottom', align = 'start', className, width }: { anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void; children: ReactNode; placement?: 'top' | 'bottom'; align?: 'start' | 'end'; className?: string; width?: number }) {
  const presence = usePresence(open);
  const content = useRetainedContent(open, children);
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const refs = useRef([anchor, panel]).current;
  useDismiss(open, onClose, refs);
  useLayoutEffect(() => {
    if (!open || style.visibility === 'hidden') return;
    panel.current?.querySelector<HTMLButtonElement>('[role="menu"] button:not(:disabled)')?.focus({ preventScroll: true });
    return () => { if (panel.current?.contains(document.activeElement)) anchor.current?.focus({ preventScroll: true }); };
  }, [open, anchor, style.visibility]);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const rect = anchor.current!.getBoundingClientRect(), panelHeight = panel.current?.offsetHeight ?? 0, panelWidth = width ?? panel.current?.offsetWidth ?? 0;
      const top = placement === 'top' || rect.bottom + panelHeight + 12 > window.innerHeight ? Math.max(8, rect.top - panelHeight - 8) : rect.bottom + 8;
      const left = align === 'end' ? Math.max(8, rect.right - panelWidth) : Math.min(rect.left, window.innerWidth - panelWidth - 8);
      setStyle({ top, left, width, visibility: 'visible' });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, anchor, placement, align, width]);
  if (!presence.mounted) return null;
  return createPortal(<div ref={panel} className={`popover${className ? ` ${className}` : ''}`} style={{ ...style, ...presence.style }} data-presence={presence.phase} data-placement={placement} aria-hidden={!open || undefined} {...(!open ? { inert: '' } : {})}>{content}</div>, document.body);
}

export interface MenuItem { id: string; label: string; icon?: IconName; hint?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }

export function Menu({ items, onClose }: { items: (MenuItem | 'divider')[]; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true }); }, []);
  return (
    <div ref={menu} className="menu" role="menu" onKeyDown={event => {
      const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let next: number | undefined;
      if (event.key === 'ArrowDown') next = (current + 1) % buttons.length;
      if (event.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = buttons.length - 1;
      if (next !== undefined) { event.preventDefault(); buttons[next]?.focus({ preventScroll: true }); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') onClose();
    }}>
      {items.map((item, index) => item === 'divider' ? <div key={`d${index}`} className="menu__divider" /> : (
        <button key={item.id} type="button" role="menuitem" disabled={item.disabled} className={`menu__item${item.danger ? ' is-danger' : ''}`} onClick={() => { item.onSelect(); onClose(); }}>
          {item.icon && <Icon name={item.icon} size={15} />}
          <span className="grow">{item.label}</span>
          {item.hint && <span className="menu__hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 520, tone }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; tone?: 'danger' }) {
  const presence = usePresence(open, 'slow');
  const content = useRetainedContent(open, { title, children, footer });
  const panel = useRef<HTMLDivElement>(null), titleId = useId();
  useOverlayFocus(open, panel);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!presence.mounted) return null;
  return createPortal(
    <div className="modal-backdrop" data-presence={presence.phase} style={presence.style} aria-hidden={!open || undefined} {...(!open ? { inert: '' } : {})} onPointerDown={event => { if (open && event.target === event.currentTarget) onClose(); }}>
      <div ref={panel} tabIndex={-1} className={`modal${tone ? ` modal--${tone}` : ''}`} style={{ width }} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal__head"><h3 id={titleId}>{content.title}</h3><IconButton icon="x" label="关闭" onClick={onClose} /></header>
        <div className="modal__body">{content.children}</div>
        {content.footer && <footer className="modal__foot">{content.footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** Dialog focus is restored only while still owned, never over a newly opened surface. */
export function useOverlayFocus(open: boolean, panel: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]') ?? [])].filter(node => node.getClientRects().length > 0);
    (focusable()[0] ?? panel.current)?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panel.current?.contains(document.activeElement)) return;
      const nodes = focusable(), first = nodes[0], last = nodes.at(-1);
      if (!first) { event.preventDefault(); panel.current.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      if (previous?.isConnected && (panel.current?.contains(document.activeElement) || document.activeElement === document.body)) previous.focus({ preventScroll: true });
    };
  }, [open, panel]);
}

export function Collapse({ open, children, className, id }: { open: boolean; children: ReactNode; className?: string; id?: string }) {
  const presence = usePresence(open);
  const content = useRetainedContent(open, children);
  if (!presence.mounted) return null;
  return <div id={id} className={`collapse${className ? ` ${className}` : ''}`} data-presence={presence.phase} style={presence.style} aria-hidden={!open || undefined} {...(!open ? { inert: '' } : {})}><div className="collapse__inner">{content}</div></div>;
}

export function EmptyState({ icon, title, detail, action }: { icon: IconName; title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__icon"><Icon name={icon} size={22} /></div>
      <div className="empty__title">{title}</div>
      {detail && <div className="empty__detail">{detail}</div>}
      {action}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return <div className="skeleton">{Array.from({ length: lines }, (_, i) => <span key={i} style={{ width: `${92 - ((i * 17) % 40)}%` }} />)}</div>;
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <Icon name="alert" size={16} />
      <span className="grow">{message}</span>
      {onRetry && <Button size="sm" variant="ghost" icon="refresh" onClick={onRetry}>重试</Button>}
    </div>
  );
}

/** 跟随指针的聚光高亮：给卡片加 spotlight 类后调用。 */
export function spotlight(event: MouseEvent<HTMLElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty('--mx', `${event.clientX - rect.left}px`);
  event.currentTarget.style.setProperty('--my', `${event.clientY - rect.top}px`);
}

/** 拖拽调整尺寸的分隔条。 */
export function ResizeHandle({ side, onResize, onDoubleClick }: { side: 'left' | 'right'; onResize: (delta: number) => void; onDoubleClick?: () => void }) {
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    let last = event.clientX;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing');
    const move = (e: PointerEvent) => { onResize(side === 'right' ? e.clientX - last : last - e.clientX); last = e.clientX; };
    const up = () => { document.body.classList.remove('is-resizing'); target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  return <div className={`resize-handle resize-handle--${side}`} onPointerDown={start} onDoubleClick={onDoubleClick} role="separator" aria-orientation="vertical" />;
}
