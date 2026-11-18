import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

const CELL = 3, STEP = 5, PAD = 4, THUMB = 24;

/** 稳定伪随机：同一格子每次布局得到相同的种子与相位。 */
function hash(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function accentRgb(element: Element): [number, number, number] {
  const match = /(\d+)\D+(\d+)\D+(\d+)/.exec(getComputedStyle(element).getPropertyValue('--accent'));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [215, 119, 87];
}

/**
 * 点阵粒子滑轨：滑块左侧的粒子越靠近滑块越密越亮并闪烁，档位越高闪烁越快；
 * 最高档在滑块附近迸发火花。动效减弱时只绘制静态点阵。
 */
export function ParticleSlider({ count, index, onChange, label }: { count: number; index: number; onChange: (index: number) => void; label: string }) {
  const track = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = Math.max(0, count - 1), fraction = last ? index / last : 1, isMax = last > 0 && index === last;
  const target = useRef({ fraction, isMax });
  target.current = { fraction, isMax };

  useEffect(() => {
    const element = canvas.current!, context = element.getContext('2d')!;
    let frame = 0, raf = 0, width = 0, height = 0, shown = target.current.fraction, color = accentRgb(element);
    let cells: { x: number; y: number; seed: number; phase: number }[] = [];
    const reduced = () => document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;
    const layout = () => {
      const rect = element.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      width = rect.width; height = rect.height;
      element.width = Math.round(width * dpr); element.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cols = Math.floor((width - PAD * 2) / STEP), rows = Math.floor((height - PAD * 2) / STEP);
      const offsetX = (width - cols * STEP) / 2, offsetY = (height - rows * STEP) / 2;
      cells = [];
      for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) cells.push({ x: offsetX + c * STEP, y: offsetY + r * STEP, seed: hash(c * 31 + r), phase: hash(c * 7 + r * 13) * Math.PI * 2 });
    };
    const draw = (time: number) => {
      const { fraction: goal, isMax: max } = target.current, still = reduced();
      shown += (goal - shown) * (still ? 1 : 0.16);
      if (++frame % 30 === 0) color = accentRgb(element);
      context.clearRect(0, 0, width, height);
      const thumbCenter = PAD + THUMB / 2 + (width - PAD * 2 - THUMB) * shown;
      const speed = 0.0015 + goal * 0.0045 + (max ? 0.003 : 0);
      for (const cell of cells) {
        const rel = cell.x / Math.max(1, thumbCenter - THUMB / 2);
        let alpha: number;
        if (rel > 1) alpha = 0.05;
        else if (cell.seed > 0.22 + 0.78 * Math.pow(rel, 1.1)) alpha = 0.06;
        else {
          const twinkle = still ? 0.8 : 0.55 + 0.45 * Math.sin(time * speed + cell.phase);
          alpha = (0.16 + 0.84 * Math.pow(rel, 1.7)) * twinkle;
          if (max && !still && rel > 0.82 && Math.sin(time * 0.02 + cell.phase * 3) > 0.92) alpha = 1;
        }
        context.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha.toFixed(3)})`;
        context.fillRect(cell.x, cell.y, CELL, CELL);
      }
      if (max && !still) {
        // 火花：从滑块左缘向外飘散的亮点
        for (let i = 0; i < 10; i++) {
          const life = ((time * 0.0012 + i / 10) % 1), angle = hash(i) * Math.PI - Math.PI / 2;
          const x = thumbCenter - THUMB / 2 - life * 26 * (0.6 + hash(i + 3)), y = height / 2 + Math.sin(angle) * life * height * 0.45;
          context.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${(1 - life).toFixed(3)})`;
          context.fillRect(x, y, 2, 2);
        }
      }
      if (!still || Math.abs(goal - shown) > 0.001) raf = requestAnimationFrame(draw);
    };
    const redraw = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); };
    const observer = new ResizeObserver(() => { layout(); redraw(); });
    observer.observe(element);
    element.addEventListener('npn-redraw', redraw);
    layout();
    raf = requestAnimationFrame(draw);
    return () => { observer.disconnect(); element.removeEventListener('npn-redraw', redraw); cancelAnimationFrame(raf); };
  }, []);

  // 静态模式下档位变化需要重绘一次
  useEffect(() => { canvas.current?.dispatchEvent(new Event('npn-redraw')); }, [fraction]);

  const pick = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left - PAD - THUMB / 2) / (rect.width - PAD * 2 - THUMB)));
    onChange(Math.round(ratio * last));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => { event.currentTarget.setPointerCapture(event.pointerId); pick(event.clientX); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); onChange(Math.min(last, index + 1)); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); onChange(Math.max(0, index - 1)); }
    if (event.key === 'Home') onChange(0);
    if (event.key === 'End') onChange(last);
  };
  return (
    <div ref={track} className={`pslider${isMax ? ' is-max' : ''}`} style={{ ['--frac' as string]: fraction } as CSSProperties}
      role="slider" tabIndex={0} aria-label="推理强度" aria-valuemin={0} aria-valuemax={last} aria-valuenow={index} aria-valuetext={label}
      onPointerDown={onPointerDown} onPointerMove={event => { if (event.buttons) pick(event.clientX); }} onKeyDown={onKeyDown}>
      <canvas ref={canvas} className="pslider__canvas" aria-hidden="true" />
      <span className="pslider__thumb" />
    </div>
  );
}
