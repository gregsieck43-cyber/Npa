import type { ReactNode } from 'react';
import { setState, useApp, type InspectorTab } from '../../app/store';
import { EmptyState, Segmented } from '../../components/ui';
import { ContextPanel } from './ContextPanel';
import { DiffPanel } from './DiffPanel';
import { PromptPanel } from './PromptPanel';
import { RequestPanel } from './RequestPanel';
import { ToolsPanel } from './ToolsPanel';
import { TracePanel } from './TracePanel';

const tabs: { value: InspectorTab; label: string; render: (id: string) => ReactNode }[] = [
  { value: 'prompt', label: 'Prompt', render: id => <PromptPanel sessionId={id} /> },
  { value: 'request', label: 'Request', render: id => <RequestPanel sessionId={id} /> },
  { value: 'tools', label: 'Tools', render: id => <ToolsPanel sessionId={id} /> },
  { value: 'trace', label: 'Trace', render: id => <TracePanel sessionId={id} /> },
  { value: 'context', label: 'Context', render: id => <ContextPanel sessionId={id} /> },
  { value: 'diff', label: 'Diff', render: id => <DiffPanel sessionId={id} /> },
];

/** 检查器内容（侧边面板中的一个标签页）：Prompt / Request / Tools / Trace / Context / Diff。 */
export function InspectorBody({ sessionId }: { sessionId?: string }) {
  const tab = useApp(s => s.inspectorTab);
  const active = tabs.find(t => t.value === tab)!;
  return (
    <div className="inspector-body">
      <Segmented className="inspector__tabs" size="sm" value={tab} onChange={value => setState({ inspectorTab: value })} options={tabs.map(t => ({ value: t.value, label: t.label }))} />
      <div className="inspector__body" key={`${sessionId}-${tab}`}>
        {sessionId ? active.render(sessionId) : <EmptyState icon="eye" title="选择一个会话" detail="检查器同时适用于 Chat、Cowork 与 Code：打开会话后可查看提示词、真实请求、工具、轨迹、上下文与 Diff。" />}
      </div>
    </div>
  );
}
