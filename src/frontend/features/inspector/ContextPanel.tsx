import { useRef, useState } from 'react';
import { gateway, type ContextSegment, type RecallPage } from '../../api';
import { guard } from '../../app/actions';
import { Donut } from '../../components/charts';
import { Icon } from '../../components/Icon';
import { Button, ErrorBanner, IconButton, Modal, Skeleton } from '../../components/ui';
import { compactNumber, percent } from '../../lib/format';
import { contextMeter, contextShare, recallNextOffset, recallTrailPop, recallTrailPrevious, recallTrailPush } from './context-page';
import { useInspectorData } from './useInspectorData';

const kindColor: Record<ContextSegment['kind'], string> = {
  system: 'var(--accent)', tools: 'var(--accent-2)', memory: 'var(--accent-3)', files: 'var(--info)', history: 'var(--ok)', user: 'var(--warn)', reserve: 'var(--text-3)',
};
const load = (id: string) => gateway.inspector.context(id);

type RecallDirection = 'open' | 'next' | 'previous';
interface RecallState { label: string; page?: RecallPage; trail: number[]; loading: boolean }

export function ContextPanel({ sessionId }: { sessionId: string }) {
  const { data, error, loading, reload } = useInspectorData(sessionId, load);
  const [hover, setHover] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [recall, setRecall] = useState<RecallState>();
  const recallRequest = useRef(0);

  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return loading ? <Skeleton lines={8} /> : null;

  const meter = contextMeter(data);
  const share = meter.share;
  const usedText = `${meter.usedPrefix}${compactNumber(data.usedTokens)}`;
  const windowText = meter.windowKnown ? compactNumber(data.windowTokens) : '未知';
  const active = data.segments.find(s => s.id === hover);
  const previousOffset = recall ? recallTrailPrevious(recall.trail) : undefined;
  const nextOffset = recall?.page ? recallNextOffset(recall.page) : undefined;

  // 回查分页只按后端返回的 nextOffset 前进，并按真实加载过的 offset 历史后退，不猜固定步长。
  const loadPage = async (sourceId: string, label: string, offset: number, direction: RecallDirection) => {
    const request = ++recallRequest.current;
    setRecall(current => current && current.page?.sourceId === sourceId ? { ...current, loading: true } : { label, trail: [], loading: true });
    const page = await guard('回查原始记录失败', () => gateway.inspector.recall(sessionId, sourceId, offset));
    if (request !== recallRequest.current) return;
    if (!page) {
      setRecall(current => current ? { ...current, loading: false } : current);
      return;
    }
    setRecall(current => {
      const trail = current && current.page?.sourceId === sourceId ? current.trail : [];
      return {
        label,
        page,
        loading: false,
        trail: direction === 'open' ? [page.offset] : direction === 'next' ? recallTrailPush(trail, page.offset) : recallTrailPop(trail),
      };
    });
  };

  return (
    <div className="panel">
      <div className="ctx-hero">
        <Donut segments={data.segments.map(s => ({ id: s.id, value: s.tokens, color: kindColor[s.kind], label: s.label }))} active={hover} onHover={setHover}
          center={active ? <><strong className="num">{compactNumber(active.tokens)}</strong><span>{active.label}</span></> : share !== undefined
            ? <><strong className="num">{percent(share)}</strong><span>{usedText} / {windowText}</span></>
            : <><strong className="num">{usedText}</strong><span>tokens · 窗口未知</span></>} />
        <div className="ctx-legend">
          {data.segments.map(s => (
            <button key={s.id} type="button" className={`ctx-legend__row${hover === s.id ? ' is-hover' : ''}`} onMouseEnter={() => setHover(s.id)} onMouseLeave={() => setHover(undefined)} onClick={() => setOpen(open === s.id ? undefined : s.id)}>
              <i style={{ background: kindColor[s.kind] }} /><span className="grow">{s.label}</span><span className="num">{compactNumber(s.tokens)}</span><span className="muted num">{percent(contextShare(s.tokens, data.windowTokens, data.windowTokensKnown), 1)}</span>
            </button>
          ))}
        </div>
      </div>
      {share !== undefined && <div className={`ctx-meter${share > 0.85 ? ' is-danger' : share > 0.6 ? ' is-warn' : ''}`}><span style={{ width: `${Math.min(100, share * 100)}%` }} /></div>}
      <div className="muted ctx-note"><Icon name="info" size={12} />工作上下文有界；被省略的原始记录不会丢失，可凭稳定来源 ID 与 SHA 分页回查。</div>

      {data.segments.filter(s => s.items?.length).map(segment => (
        <div key={segment.id} className={`ctx-seg${open === segment.id ? ' is-open' : ''}`}>
          <button type="button" className="ctx-seg__head" onClick={() => setOpen(open === segment.id ? undefined : segment.id)}>
            <i style={{ background: kindColor[segment.kind] }} /><strong className="grow">{segment.label}</strong><span className="muted">{segment.items!.length} 项</span><Icon name="chevronRight" size={13} className="ctx-seg__chevron" />
          </button>
          {open === segment.id && segment.items!.map(item => (
            <div key={item.label + item.sourceId} className="ctx-item">
              <span className="grow truncate">{item.label}</span>
              {item.sourceId && <span className="mono muted">{item.sourceId}</span>}
              {item.sha && <span className="mono muted">#{item.sha}</span>}
              <span className="num">{compactNumber(item.tokens)}</span>
            </div>
          ))}
        </div>
      ))}

      <div className="tool__label">已省略、可回查 · {data.omitted.length}</div>
      {data.omitted.length === 0 ? <div className="muted">当前上下文未省略任何原始记录。</div> : data.omitted.map(item => (
        <div key={item.sourceId} className="omitted">
          <Icon name="database" size={14} />
          <span className="grow"><span>{item.label}</span><span className="mono muted">{item.sourceId} · sha {item.sha} · {compactNumber(item.tokens)} tokens</span></span>
          <Button size="sm" variant="secondary" icon="eye" onClick={() => void loadPage(item.sourceId, item.label, 0, 'open')}>回查</Button>
        </div>
      ))}

      <Modal open={!!recall} onClose={() => { recallRequest.current += 1; setRecall(undefined); }} title={<>回查原始记录 <span className="muted">· {recall?.label}</span></>} width={720}
        footer={recall?.page && <>
          <span className="mono muted grow">{recall.page.sourceId} · {recall.page.sha} · offset {recall.page.offset}</span>
          <IconButton icon="chevronLeft" label="上一页" disabled={previousOffset === undefined || recall.loading} onClick={() => void loadPage(recall.page!.sourceId, recall.label, previousOffset!, 'previous')} />
          <IconButton icon="chevronRight" label="下一页" disabled={nextOffset === undefined || recall.loading} onClick={() => void loadPage(recall.page!.sourceId, recall.label, nextOffset!, 'next')} />
        </>}>
        {recall?.page ? <pre className="recall-text">{recall.page.text}</pre> : <Skeleton lines={8} />}
      </Modal>
    </div>
  );
}
