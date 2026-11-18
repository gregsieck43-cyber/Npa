import { useState } from 'react';
import { gateway } from '../../api';
import { FileDiffView } from '../../components/rich';
import { EmptyState, ErrorBanner, Segmented, Skeleton } from '../../components/ui';
import { useInspectorData } from './useInspectorData';

const load = (id: string) => gateway.inspector.diffs(id);

export function DiffPanel({ sessionId }: { sessionId: string }) {
  const { data, error, loading, reload } = useInspectorData(sessionId, load);
  const [mode, setMode] = useState<'unified' | 'split'>('unified');
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return loading ? <Skeleton lines={8} /> : null;
  if (!data.length) return <EmptyState icon="diff" title="没有文件变更" detail="Agent 通过 apply_patch 修改的文件会在这里逐行展示，包括已应用与待批准的修改。" />;
  const additions = data.reduce((n, d) => n + d.additions, 0), deletions = data.reduce((n, d) => n + d.deletions, 0);
  return (
    <div className="panel">
      <div className="panel__summary">
        <div className="panel__stat"><strong className="num">{data.length}</strong><span>个文件</span></div>
        <div className="panel__stat"><strong className="num diff-stat__add">+{additions}</strong><span>新增行</span></div>
        <div className="panel__stat"><strong className="num diff-stat__del">−{deletions}</strong><span>删除行</span></div>
        <span className="grow" />
        <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'unified', label: '统一' }, { value: 'split', label: '并排' }]} />
      </div>
      <div className="col stagger">{data.map(diff => <FileDiffView key={`${diff.path}-${diff.toolCallId}-${mode}`} diff={diff} defaultMode={mode} />)}</div>
    </div>
  );
}
