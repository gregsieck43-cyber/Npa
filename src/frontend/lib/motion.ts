import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

export type MotionToken = 'fast' | 'base' | 'slow';
export function motionDuration(token: MotionToken): number {
  if (typeof document === 'undefined') return 0;
  if (document.documentElement.dataset.motion === 'reduced' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--t-${token}`).trim();
  const duration = Number.parseFloat(value) * (value.endsWith('ms') ? 1 : 1000);
  return Number.isFinite(duration) ? Math.min(100, Math.max(0, duration)) : 0;
}

export function usePresence(open: boolean, token: MotionToken = 'base') {
  const [duration, setDuration] = useState(() => motionDuration(token));
  const [mounted, setMounted] = useState(open);
  const [phase, setPhase] = useState<'entering' | 'entered' | 'exiting'>(open ? 'entering' : 'exiting');
  useLayoutEffect(() => {
    const update = () => setDuration(motionDuration(token));
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    media.addEventListener('change', update); update();
    return () => { observer.disconnect(); media.removeEventListener('change', update); };
  }, [token]);
  useLayoutEffect(() => {
    let frame = 0, timer: ReturnType<typeof setTimeout> | undefined;
    if (open) {
      setMounted(true);
      if (!duration) setPhase('entered');
      else { setPhase('entering'); frame = requestAnimationFrame(() => setPhase('entered')); }
    } else {
      setPhase('exiting');
      if (!duration) setMounted(false);
      else timer = setTimeout(() => setMounted(false), duration);
    }
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [open, duration]);
  return { mounted: open || mounted, phase: open ? phase : 'exiting' as const, style: { '--presence-duration': `${duration}ms` } as CSSProperties };
}

/** Keep the last open content while a parent clears its selection during exit. */
export function useRetainedContent<T>(open: boolean, content: T): T {
  const retained = useRef(content);
  if (open) retained.current = content;
  return open ? content : retained.current;
}

export interface CountdownDriver { now(): number; request(tick: () => void): number; cancel(id: number): void }
/** One monotonic elapsed-time source owns both expiry and the visible remaining fraction. */
export function createCountdown(duration: number, update: (remaining: number) => void, expire: () => void, driver: CountdownDriver) {
  let remaining = duration, started = driver.now(), handle = 0, paused = true, disposed = false, finished = false;
  const sample = () => {
    const now = driver.now(); remaining = Math.max(0, remaining - Math.max(0, now - started)); started = now;
    update(remaining);
    if (!remaining && !finished) { finished = true; expire(); }
  };
  const tick = () => { if (disposed || paused || finished) return; sample(); if (!finished) handle = driver.request(tick); };
  return {
    pause(value: boolean) {
      if (disposed || finished || value === paused) return;
      if (value) { sample(); driver.cancel(handle); paused = true; }
      else { paused = false; started = driver.now(); handle = driver.request(tick); }
    },
    dispose() { disposed = true; driver.cancel(handle); },
  };
}

export function useCountdown(duration: number, paused: boolean, expire: () => void): number {
  const [remaining, setRemaining] = useState(duration);
  const callback = useRef(expire); callback.current = expire;
  const clock = useRef<ReturnType<typeof createCountdown>>();
  useEffect(() => {
    const value = createCountdown(duration, setRemaining, () => callback.current(), {
      now: () => performance.now(), request: tick => requestAnimationFrame(tick), cancel: id => cancelAnimationFrame(id),
    });
    clock.current = value; setRemaining(duration); value.pause(paused);
    return () => { value.dispose(); clock.current = undefined; };
  }, [duration]);
  useEffect(() => { clock.current?.pause(paused); }, [paused]);
  return duration > 0 ? remaining / duration : 0;
}
