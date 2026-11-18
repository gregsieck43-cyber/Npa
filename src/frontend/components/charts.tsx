import { useMemo, useState, type ReactNode } from 'react';
import type { ActivityDay } from '../api/types';
import { compactNumber } from '../lib/format';

const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

/** 活动热力图：按周分列、按星期分行；颜色分 5 级（0 为空）。 */
export function Heatmap({ days, metric = 'events' }: { days: ActivityDay[]; metric?: 'events' | 'modelCalls' | 'toolEffects' }) {
  const [hover, setHover] = useState<{ day: ActivityDay; x: number; y: number }>();
  const { columns, levels, months, total, streak } = useMemo(() => {
    const values = days.map(day => day[metric]), max = Math.max(1, ...values);
    const first = days.length ? new Date(`${days[0].date}T00:00:00`).getDay() : 0;
    const padded: (ActivityDay | undefined)[] = [...Array(first).fill(undefined), ...days];
    const columns: (ActivityDay | undefined)[][] = [];
    for (let i = 0; i < padded.length; i += 7) columns.push(padded.slice(i, i + 7));
    const level = (value: number) => (value === 0 ? 0 : Math.min(4, Math.ceil((value / max) * 4)));
    const months: { index: number; label: string }[] = [];
    columns.forEach((column, index) => {
      const firstDay = column.find(Boolean);
      const month = firstDay ? Number(firstDay.date.slice(5, 7)) : undefined;
      if (month && (!months.length || months[months.length - 1].label !== `${month}月`)) months.push({ index, label: `${month}月` });
    });
    let streak = 0;
    for (let i = days.length - 1; i >= 0 && days[i][metric] > 0; i--) streak++;
    return { columns, levels: level, months, total: values.reduce((a, b) => a + b, 0), streak };
  }, [days, metric]);

  return (
    <div className="heatmap">
      <div className="heatmap__months">{months.map(month => <span key={month.index} style={{ gridColumnStart: month.index + 1 }}>{month.label}</span>)}</div>
      <div className="heatmap__body">
        <div className="heatmap__weekdays">{weekdays.map((d, i) => <span key={d}>{i % 2 ? d : ''}</span>)}</div>
        <div className="heatmap__grid" onMouseLeave={() => setHover(undefined)}>
          {columns.map((column, c) => (
            <div key={c} className="heatmap__col">
              {Array.from({ length: 7 }, (_, r) => {
                const day = column[r];
                return day
                  ? <span key={r} className={`heatmap__cell l${levels(day[metric])}`} style={{ animationDelay: `${c * 14 + r * 6}ms` }} onMouseEnter={event => setHover({ day, x: event.currentTarget.offsetLeft, y: event.currentTarget.offsetTop })} />
                  : <span key={r} className="heatmap__cell is-void" />;
              })}
            </div>
          ))}
          {hover && (
            <div className="heatmap__tip" style={{ left: hover.x, top: hover.y }}>
              <strong>{hover.day.date}</strong>
              <span>{hover.day.events} 事件 · {hover.day.modelCalls} 次模型调用</span>
              <span>{hover.day.toolEffects} 次工具效果 · 完成 {hover.day.tasksCompleted} 个任务</span>
            </div>
          )}
        </div>
      </div>
      <div className="heatmap__foot">
        <span>{days.length} 天内共 <strong className="num">{compactNumber(total)}</strong> 次活动 · 连续活跃 <strong className="num">{streak}</strong> 天</span>
        <span className="heatmap__legend">少{[0, 1, 2, 3, 4].map(l => <span key={l} className={`heatmap__cell l${l}`} />)}多</span>
      </div>
    </div>
  );
}

/** 环形进度。value 为 0–1。 */
export function Ring({ value, size = 44, stroke = 5, tone = 'accent', label }: { value: number; size?: number; stroke?: number; tone?: 'accent' | 'ok' | 'warn' | 'danger'; label?: string }) {
  const radius = (size - stroke) / 2, length = 2 * Math.PI * radius, clamped = Math.max(0, Math.min(1, value));
  return (
    <svg className={`ring ring--${tone}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      <circle className="ring__track" cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} />
      <circle className="ring__value" cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} strokeDasharray={length} strokeDashoffset={length * (1 - clamped)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      {label && <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="ring__label">{label}</text>}
    </svg>
  );
}

export interface DonutSegment { id: string; value: number; color: string; label: string }

export function Donut({ segments, size = 168, stroke = 18, center, active, onHover }: { segments: DonutSegment[]; size?: number; stroke?: number; center?: ReactNode; active?: string; onHover?: (id?: string) => void }) {
  const total = Math.max(1, segments.reduce((n, s) => n + s.value, 0)), radius = (size - stroke) / 2, length = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        {segments.map(segment => {
          const part = (segment.value / total) * length, dash = `${Math.max(0, part - 2)} ${length}`;
          const node = <circle key={segment.id} className={`donut__seg${active && active !== segment.id ? ' is-dim' : ''}`} cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={segment.color} strokeWidth={active === segment.id ? stroke + 4 : stroke} strokeDasharray={dash} strokeDashoffset={-offset} transform={`rotate(-90 ${size / 2} ${size / 2})`} onMouseEnter={() => onHover?.(segment.id)} onMouseLeave={() => onHover?.()} />;
          offset += part;
          return node;
        })}
      </svg>
      {center && <div className="donut__center">{center}</div>}
    </div>
  );
}

export function StackBar({ segments, total }: { segments: DonutSegment[]; total: number }) {
  return (
    <div className="stackbar">
      {segments.filter(s => s.value > 0).map(segment => <span key={segment.id} title={`${segment.label} ${compactNumber(segment.value)}`} style={{ width: `${(segment.value / Math.max(1, total)) * 100}%`, background: segment.color }} />)}
    </div>
  );
}

export function Sparkline({ values, width = 120, height = 28 }: { values: number[]; width?: number; height?: number }) {
  const max = Math.max(1, ...values), step = width / Math.max(1, values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 4) - 2).toFixed(1)}`).join(' ');
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline points={`0,${height} ${points} ${width},${height}`} className="sparkline__fill" />
      <polyline points={points} className="sparkline__line" />
    </svg>
  );
}
