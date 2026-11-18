import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gateway, type TraceSpan, type TraceSpanType } from '../../api';
import { openInspector } from '../../app/actions';
import { Icon, type IconName } from '../../components/Icon';
import { Button, EmptyState, ErrorBanner, Skeleton } from '../../components/ui';
import { duration } from '../../lib/format';
import { idleCompressor } from '../../lib/trace';
import { nextTraceCursor, traceQueryOf } from './trace-page';
import { useInspectorData } from './useInspectorData';

const typeMeta: Record<TraceSpanType, { label: string; icon: IconName; color: string }> = {
  turn: { label: '回合', icon: 'user', color: 'var(--text-3)' },
  prompt: { label: '提示词', icon: 'sparkles', color: 'var(--accent-2)' },
  context: { label: '上下文', icon: 'database', color: 'var(--info)' },
  model: { label: '模型', icon: 'cpu', color: 'var(--accent)' },
  tool: { label: '工具', icon: 'wrench', color: 'var(--ok)' },
  review: { label: '审查', icon: 'shield', color: 'var(--accent-3)' },
  approval: { label: '审批', icon: 'shieldAlert', color: 'var(--warn)' },
  checkpoint: { label: '检查点', icon: 'bookmark', color: 'var(--text-2)' },
  task: { label: '任务', icon: 'target', color: 'var(--accent)' },
  subagent: { label: '子代理', icon: 'bot', color: 'var(--info)' },
};
const TRACE_TYPES = Object.keys(typeMeta) as TraceSpanType[];

export function TracePanel({ sessionId }: { sessionId: string }) {
  const [query, setQuery] = useState('');
  const [appliedText, setAppliedText] = useState('');
  const [filter, setFilter] = useState<Set<TraceSpanType>>(new Set());
  const [selected, setSelected] = useState<TraceSpan>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [compress, setCompress] = useState(true);
  // Keep one server page and only a bounded trail of cursors, never the entire visited history.
  const [pageCursor, setPageCursor] = useState<string>();
  const [trail, setTrail] = useState<(string | undefined)[]>([]);
  const [scopeId, setScopeId] = useState(sessionId);
  const [knownTypes, setKnownTypes] = useState<TraceSpanType[]>([]);

  // 后端查询跟随“已应用的搜索词 + 单选类型”；输入防抖，分页用后端不透明游标。
  const queryRef = useRef<{ text?: string; type?: string; cursor?: string }>({});
  queryRef.current = { ...traceQueryOf(appliedText, filter), ...(pageCursor ? { cursor: pageCursor } : {}) };
  const load = useCallback((id: string) => gateway.inspector.trace(id, queryRef.current), []);
  const { data, error, loading, reload } = useInspectorData(scopeId, load);
  const queryError = query.length > 300 ? '搜索最多 300 个字符，请缩短后重试。' : undefined;

  // 过滤条件变化时重新从第一页开始，绝不把不同查询的页拼在一起。
  const appliedRef = useRef('');
  useEffect(() => {
    if (query.length > 300 || query === appliedRef.current) return;
    const timer = setTimeout(() => {
      appliedRef.current = query;
      setAppliedText(query);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const signature = appliedText + '\u0000' + [...filter].sort().join(',');
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    setPageCursor(undefined);
    setTrail([]);
    if (!pageCursor) reload();
  }, [signature, reload]);

  const previousCursor = useRef(pageCursor);
  useEffect(() => {
    if (previousCursor.current === pageCursor) return;
    previousCursor.current = pageCursor;
    reload();
  }, [pageCursor, reload]);
  useEffect(() => { setSelected(undefined); setCollapsed(new Set()); }, [data]);
  const spans = data?.spans ?? [];

  useEffect(() => {
    setKnownTypes(current => {
      if (!spans.length) return current;
      const present = new Set(current);
      let changed = false;
      for (const span of spans) if (!present.has(span.type)) { present.add(span.type); changed = true; }
      return changed ? TRACE_TYPES.filter(type => present.has(type)) : current;
    });
  }, [spans]);

  const { rows, range, start, map, folded } = useMemo(() => {
    const parents = new Map(spans.map(span => [span.id, span.parentId]));
    const hidden = (span: TraceSpan) => {
      let parent = span.parentId;
      const visited = new Set<string>();
      while (parent && !visited.has(parent)) {
        if (collapsed.has(parent)) return true;
        visited.add(parent); parent = parents.get(parent);
      }
      return false;
    };
    const visible = spans.filter(span => (!filter.size || filter.has(span.type)) && !hidden(span));
    const { map, folded } = idleCompressor(spans, compress);
    if (!spans.length) return { rows: visible, range: 1, start: 0, map, folded };
    const start = map(Math.min(...spans.map(s => s.startMs))), end = map(Math.max(...spans.map(s => s.startMs + s.durationMs), 1));
    return { rows: visible, range: Math.max(1, end - start), start, map, folded };
  }, [spans, filter, collapsed, compress]);

  const toggleType = (type: TraceSpanType) => setFilter(current => { const next = new Set(current); if (next.has(type)) next.delete(type); else next.add(type); return next; });
  const cursor = data ? nextTraceCursor(data) : undefined;
  const parentIds = new Set(spans.flatMap(span => span.parentId ? [span.parentId] : []));
  const ticks = [0, 0.5, 1];

  return (
    <div className="panel">
      <div className="trace-tools">
        <label className="search-field"><Icon name="search" size={13} /><input aria-invalid={Boolean(queryError)} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索事件…" /></label>
        <div className="chips">
          {knownTypes.map(type => <button key={type} type="button" className={`chip${filter.has(type) ? ' is-on' : ''}`} onClick={() => toggleType(type)} style={{ ['--chip' as string]: typeMeta[type].color }}><i />{typeMeta[type].label}</button>)}
          <span className="chips__sep" />
          <button type="button" className={`chip${compress ? ' is-on' : ''}`} onClick={() => setCompress(!compress)} title="把回合之间的长时间空闲折叠为短间隔">压缩空闲{compress && folded ? ` · ${folded}` : ''}</button>
        </div>
      </div>
      {queryError && <div role="alert" className="muted">{queryError}</div>}
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {loading && <Skeleton lines={3} />}
      {scopeId !== sessionId && <Button size="sm" onClick={() => { setScopeId(sessionId); setPageCursor(undefined); setTrail([]); }}>返回当前会话轨迹</Button>}
      {!loading && !error && !spans.length && !appliedText && !filter.size && <EmptyState icon="activity" title="尚无执行轨迹" detail="用户输入 → 提示词组装 → 上下文选择 → 模型请求 → 工具调用 → 下一次请求，会按时间线记录在这里。" />}
      {spans.length > 0 && (
        <div className="waterfall">
          <div className="waterfall__axis">{ticks.map(t => <span key={t} style={{ left: `${t * 100}%` }}>{compress && folded ? `活跃 ${duration(t * range)}` : duration(t * range)}</span>)}</div>
          {rows.map((span, i) => {
            const from = map(span.startMs), to = map(span.startMs + span.durationMs);
            const left = ((from - start) / range) * 100, width = Math.max(0.6, ((to - from) / range) * 100), meta = typeMeta[span.type];
            const hasChildren = parentIds.has(span.id);
            return (
              <button key={span.id} type="button" className={`wf-row wf-row--${span.status}${selected?.id === span.id ? ' is-selected' : ''}${span.parentId ? ' is-child' : ''}`} onClick={() => setSelected(span)} style={{ animationDelay: `${Math.min(i, 30) * 18}ms` }}>
                <span className="wf-row__label">
                  {hasChildren ? <span className="wf-row__toggle" onClick={event => { event.stopPropagation(); setCollapsed(c => { const n = new Set(c); if (n.has(span.id)) n.delete(span.id); else n.add(span.id); return n; }); }}><Icon name={collapsed.has(span.id) ? 'chevronRight' : 'chevronDown'} size={12} /></span> : <span className="wf-row__spacer" />}
                  <Icon name={meta.icon} size={12} style={{ color: meta.color }} />
                  <span className="truncate">{span.label}</span>
                </span>
                <span className="wf-row__track">
                  {span.durationMs === 0 ? <span className="wf-row__marker" style={{ left: `${left}%`, background: meta.color }} /> : <span className="wf-row__bar" style={{ left: `${left}%`, width: `${width}%`, background: meta.color }} />}
                </span>
                <span className="wf-row__time num">{span.durationMs ? duration(span.durationMs) : '·'}</span>
              </button>
            );
          })}
        </div>
      )}
      {rows.length === 0 && <div className="muted">没有匹配的轨迹事件。</div>}
      {(cursor || pageCursor) && (
        <div className="row">
          {pageCursor && <Button size="sm" disabled={loading} onClick={() => { setPageCursor(undefined); setTrail([]); }}>从头查看</Button>}
          {trail.length > 0 && <Button size="sm" disabled={loading} onClick={() => { setPageCursor(trail.at(-1)); setTrail(current => current.slice(0, -1)); }}>上一页</Button>}
          {cursor && <Button size="sm" variant="secondary" icon="chevronDown" disabled={loading || Boolean(queryError)} onClick={() => { setTrail(current => [...current, pageCursor].slice(-50)); setPageCursor(cursor); }}>下一页</Button>}
          <span className="muted">按页查看，保留最近 50 页的返回位置。</span>
        </div>
      )}
      {selected && (
        <div className="span-detail rise-in">
          <div className="span-detail__head"><Icon name={typeMeta[selected.type].icon} size={14} /><strong className="grow truncate">{selected.label}</strong><span className={`span-status span-status--${selected.status}`}>{selected.status}</span></div>
          <div className="kv-grid">
            <span>span_id</span><span className="mono">{selected.id}</span>
            <span>parent_id</span><span className="mono">{selected.parentId ?? '—'}</span>
            {selected.sessionId && <><span>session_id</span><span className="mono">{selected.sessionId}</span></>}
            {selected.taskId && <><span>task_id</span><span className="mono">{selected.taskId}</span></>}
            {selected.runId && <><span>run_id</span><span className="mono">{selected.runId}</span></>}
            {selected.sourceParentId && <><span>source_parent_id</span><span className="mono">{selected.sourceParentId}</span></>}
            <span>开始</span><span className="num">会话开始后 {duration(selected.startMs)}</span>
            <span>耗时</span><span className="num">{duration(selected.durationMs)}</span>
            {selected.requestId && <><span>request_id</span><button type="button" className="link-btn mono" onClick={() => openInspector('request', { requestId: selected.requestId })}>{selected.requestId}</button></>}
            {selected.payloadRef && <><span>payload</span><span className="mono">{selected.payloadRef}</span></>}
            {selected.childSessionId && <><span>子任务</span><Button size="sm" onClick={() => { setScopeId(selected.childSessionId!); setPageCursor(undefined); setTrail([]); setQuery(''); setAppliedText(''); appliedRef.current = ''; setFilter(new Set()); }}>查看子任务轨迹</Button></>}
            {Object.entries(selected.attrs ?? {}).map(([k, v]) => <Fragment key={k}><span>{k}</span><span className="mono">{String(v)}</span></Fragment>)}
          </div>
        </div>
      )}
    </div>
  );
}
