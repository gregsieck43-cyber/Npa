import { useEffect, useRef, useState } from 'react';
import { gateway } from '../../api';
import { capabilityLabels } from '../../api/policy';
import { useApp } from '../../app/store';
import { Icon } from '../../components/Icon';
import { JsonBlock } from '../../components/rich';
import { Badge, EmptyState, ErrorBanner, Segmented, Skeleton } from '../../components/ui';
import { failureStage } from '../../lib/status';
import { ToolCard } from '../session/ToolCard';
import { useInspectorData } from './useInspectorData';

const load = (id: string) => gateway.inspector.tools(id);

export function ToolsPanel({ sessionId }: { sessionId: string }) {
  const { data, error, loading, reload } = useInspectorData(sessionId, load);
  const focus = useApp(s => s.inspectorFocus?.toolCallId);
  const [tab, setTab] = useState<'calls' | 'defs'>('calls');
  const [openDef, setOpenDef] = useState<string>();
  const focused = useRef<HTMLDivElement>(null);

  useEffect(() => { if (focus) setTab('calls'); }, [focus]);
  useEffect(() => { focused.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [focus, data]);

  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return loading ? <Skeleton lines={8} /> : null;

  const allCalls = data.calls.flatMap(function flatten(call): typeof data.calls { return [call, ...(call.children ?? []).flatMap(flatten)]; });
  const called = new Set(allCalls.map(c => c.name));
  const funnel = [
    { label: '已注册', value: data.registered.length, hint: '工具注册表中的全部工具' },
    { label: '权限允许', value: data.allowed.length, hint: '当前权限模式下可调用' },
    { label: '暴露给模型', value: data.exposed.length, hint: '本次请求 tools 字段实际包含' },
    { label: '本次调用', value: called.size, hint: '模型实际发起调用的工具' },
  ];
  const max = Math.max(1, funnel[0].value);

  return (
    <div className="panel">
      <div className="funnel">
        {funnel.map((step, i) => (
          <div key={step.label} className="funnel__step" title={step.hint}>
            <div className="funnel__bar" style={{ width: `${Math.max(8, (step.value / max) * 100)}%`, animationDelay: `${i * 80}ms` }}><strong className="num">{step.value}</strong></div>
            <span>{step.label}</span>
          </div>
        ))}
      </div>
      <Segmented size="sm" value={tab} onChange={setTab} options={[{ value: 'calls', label: `调用记录 ${allCalls.length}` }, { value: 'defs', label: `工具定义 ${data.registered.length}` }]} />
      {tab === 'calls' && (data.calls.length === 0
        ? <EmptyState icon="wrench" title="模型本次没有选择工具" detail="“没有调用”与“调用失败”是两种状态：这里为空说明模型未请求任何工具。" />
        : <div className="col">{data.calls.map(call => <div key={call.id} ref={call.id === focus ? focused : undefined} className={call.id === focus ? 'is-focused' : undefined}><ToolCard call={call} /></div>)}</div>)}
      {tab === 'defs' && (
        <div className="col">
          {data.registered.map(def => {
            const allowed = data.allowed.includes(def.name), exposed = data.exposed.includes(def.name);
            return (
              <div key={def.name} className={`tool-def${openDef === def.name ? ' is-open' : ''}`}>
                <button type="button" className="tool-def__head" onClick={() => setOpenDef(openDef === def.name ? undefined : def.name)}>
                  <span className="mono tool-def__name">{def.name}</span>
                  <Badge>{capabilityLabels[def.capability]}</Badge>
                  {def.source !== 'builtin' && <Badge tone="info">{def.source}</Badge>}
                  <span className="grow" />
                  <span className={`tool-def__flag${allowed ? ' is-on' : ''}`}>{allowed ? '允许' : '禁止'}</span>
                  <span className={`tool-def__flag${exposed ? ' is-on' : ''}`}>{exposed ? '已暴露' : '未暴露'}</span>
                  {called.has(def.name) && <span className="tool-def__flag is-called">已调用</span>}
                </button>
                {openDef === def.name && <div className="tool-def__body"><p>{def.description}</p><JsonBlock value={def.schema} title="parameters schema" /></div>}
              </div>
            );
          })}
        </div>
      )}
      <details className="stage-legend">
        <summary><Icon name="info" size={12} />失败阶段说明</summary>
        <ul>{Object.entries(failureStage).map(([key, label]) => <li key={key}><code className="inline-code">{key}</code>{label}</li>)}</ul>
      </details>
    </div>
  );
}
