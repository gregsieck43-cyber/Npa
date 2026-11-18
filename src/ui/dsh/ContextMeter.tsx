/* DeepSeek Harness ContextMeter (MIT), adapted to NPN request observations.
 * Uses the original ring geometry/CSS; an unavailable reading stays explicit. */
import css from './ContextMeter.module.css';
const RADIUS = 5.5, CIRCUMFERENCE = 2 * Math.PI * RADIUS;
export function ContextMeter({ percent, configured, onClick }: { percent: number | null; configured: boolean; onClick(): void }) {
  const label = percent === null ? configured ? '上下文未报告' : '上下文未配置' : `上下文 ${Number(percent.toFixed(1))}%`;
  return <span className={css.root}><button type="button" className={css.trigger} onClick={onClick} data-testid="agent-context" title="最近一次请求的输入 Token / 为该模型配置的容量；点击查看精确值">
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r={RADIUS} className={css.track}/>{percent !== null && <circle cx="7" cy="7" r={RADIUS} className={css.fill} strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - Math.min(100, percent) / 100)} transform="rotate(-90 7 7)"/>}</svg>{label}
  </button></span>;
}
