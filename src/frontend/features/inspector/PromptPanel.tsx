import { useCallback, useEffect, useMemo, useState } from 'react';
import { gateway, type PromptPart, type PromptView } from '../../api';
import { guard, openInspector } from '../../app/actions';
import { useApp } from '../../app/store';
import { StackBar } from '../../components/charts';
import { Icon } from '../../components/Icon';
import { CodeBlock, DiffLines } from '../../components/rich';
import { Badge, Button, EmptyState, ErrorBanner, Segmented, Skeleton } from '../../components/ui';
import { diffStats, lineDiff } from '../../lib/diff';
import { compactNumber } from '../../lib/format';
import { useInspectorData } from './useInspectorData';
import { PromptPresetEditor } from './PromptPresetEditor';
import { SavedVersionCompare } from './SavedVersionCompare';

const scopeMeta: Record<PromptPart['scope'], { label: string; color: string }> = {
  harness: { label: 'Harness', color: 'var(--accent)' },
  global: { label: '全局', color: 'var(--accent-2)' },
  project: { label: '项目', color: 'var(--info)' },
  session: { label: '会话', color: 'var(--ok)' },
  request: { label: '单次请求', color: 'var(--accent-3)' },
};
const mergeMeta = { locked: { label: '锁定', icon: 'lock' }, override: { label: '覆盖', icon: 'refresh' }, append: { label: '追加', icon: 'plus' } } as const;
type EditScope = 'global' | 'project' | 'session' | 'request';
function PartCard({ part, sessionId, original, readOnly, onSaved }: { part: PromptPart; sessionId: string; original?: string; readOnly?: boolean; onSaved: (view: PromptView, before: string) => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(part.content);
  const [scope, setScope] = useState<EditScope>(part.scope === 'harness' ? 'session' : part.scope as EditScope);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!editing) setDraft(part.content); }, [part.content, editing]);
  const save = async () => {
    setSaving(true);
    const view = await guard('保存提示词失败', () => gateway.inspector.savePrompt(sessionId, part.id, draft, scope));
    setSaving(false);
    if (view) { onSaved(view, part.content); setEditing(false); }
  };
  return (
    <div className={`prompt-part${part.effective ? '' : ' is-inactive'}${open ? ' is-open' : ''}`} style={{ ['--scope' as string]: scopeMeta[part.scope].color }}>
      <button type="button" className="prompt-part__head" onClick={() => setOpen(!open)}>
        <span className="prompt-part__bar" />
        <span className="grow">
          <span className="prompt-part__label">{part.label}{part.version ? <span className="muted mono"> v{part.version}</span> : null}</span>
          <span className="prompt-part__source mono truncate">{part.source}</span>
        </span>
        <Badge>{part.role}</Badge>
        <span className="prompt-part__scope">{scopeMeta[part.scope].label}</span>
        <span className="prompt-part__merge" title={part.merge === 'locked' ? 'Harness 执行约束，不可覆盖' : part.merge === 'append' ? '追加到同角色内容之后' : '按优先级覆盖低层同名设置'}><Icon name={mergeMeta[part.merge].icon} size={11} />{mergeMeta[part.merge].label}</span>
        <span className="prompt-part__tokens num" title={part.tokensExact ? '实际 token' : '估算 token'}>{part.tokensExact ? '' : '≈'}{compactNumber(part.tokens)}</span>
        <Icon name="chevronRight" size={13} className="prompt-part__chevron" />
      </button>
      {open && (
        <div className="prompt-part__body">
          {!part.effective && <div className="prompt-part__note"><Icon name="info" size={12} />{part.overriddenBy ? `已被 ${part.overriddenBy} 覆盖` : '当前未进入请求（内容为空或模式不适用）'}</div>}
          {editing && !readOnly ? (
            <div className="prompt-edit">
              <textarea value={draft} onChange={event => setDraft(event.target.value)} rows={Math.min(14, Math.max(4, draft.split('\n').length + 1))} />
              <div className="prompt-edit__bar">
                <span className="muted">作用于</span>
                <Segmented size="sm" value={scope} onChange={setScope} options={[{ value: 'request', label: '仅下次请求' }, { value: 'session', label: '会话' }, { value: 'project', label: '项目' }, { value: 'global', label: '全局' }]} />
                <span className="grow" />
                <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(part.content); }}>取消</Button>
                <Button size="sm" variant="primary" icon="check" disabled={saving || draft === part.content} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</Button>
              </div>
            </div>
          ) : (
            <>
              {part.content ? <CodeBlock code={part.content} lang={part.id === 'tools' ? 'json' : 'text'} title={part.role} maxHeight={260} wrap={part.id !== 'tools'} /> : <div className="muted prompt-part__empty">（空）</div>}
              {original !== undefined && original !== part.content && <div className="prompt-part__diff"><div className="tool__label">本次修改</div><DiffLines lines={lineDiff(original, part.content)} lang="text" mode="unified" /></div>}
              <div className="prompt-part__actions">
                {part.editable && !readOnly ? <Button size="sm" variant="secondary" icon="pencil" onClick={() => setEditing(true)}>编辑</Button> : <span className="muted"><Icon name="lock" size={12} /> {readOnly ? '历史请求快照，只读' : part.merge === 'locked' ? 'Harness 执行约束不可编辑' : '来源于文件或运行时，请在源头修改'}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PromptContent({ sessionId, requestId }: { sessionId: string; requestId?: string }) {
  const load = useCallback((id: string) => gateway.inspector.prompt(id, requestId), [requestId]);
  const { data, error, loading, reload } = useInspectorData(sessionId, load);
  const [view, setView] = useState<'parts' | 'sources' | 'full' | 'diff' | 'versions'>('parts');
  const [presets, setPresets] = useState(false);
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const prompt = data;
  const effective = useMemo(() => {
    const parts = prompt?.parts.filter(part => part.effective) ?? [];
    const assembled = parts.filter(part => part.id.startsWith('effective:'));
    // Sources explain provenance; effective:* contains the actual adapted body. They overlap.
    return assembled.length ? assembled : parts;
  }, [prompt]);
  const segments = useMemo(() => {
    const by = new Map<PromptPart['scope'], number>();
    for (const part of effective) by.set(part.scope, (by.get(part.scope) ?? 0) + part.tokens);
    return [...by].map(([scope, value]) => ({ id: scope, value, color: scopeMeta[scope].color, label: scopeMeta[scope].label }));
  }, [effective]);

  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!prompt) return loading ? <Skeleton lines={8} /> : null;
  const edited = prompt.parts.filter(part => originals[part.id] !== undefined && originals[part.id] !== part.content);

  return (
    <div className="panel">
      <div className="panel__summary">
        <div className="panel__stat"><strong className="num">{compactNumber(prompt.totalTokens)}</strong><span>有效提示 tokens（{prompt.totalTokensExact === true ? '实测' : prompt.totalTokensExact === false ? '≈ 估算' : '类型未知'}）</span></div>
        <div className="panel__stat"><strong className="num">{prompt.parts.filter(p => p.effective).length}/{prompt.parts.length}</strong><span>进入请求的组成部分</span></div>
        {prompt.pendingEdits > 0 && <Badge tone="accent" icon="pencil">{prompt.pendingEdits} 处修改将用于下次请求</Badge>}
      </div>
      <StackBar segments={segments} total={prompt.totalTokens} />
      <div className="legend">{segments.map(s => <span key={s.id}><i style={{ background: s.color }} />{s.label} {compactNumber(s.value)}</span>)}</div>
      <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'parts', label: '分段' }, { value: 'sources', label: '来源' }, { value: 'full', label: '完整' }, { value: 'diff', label: `差异${edited.length ? ` ${edited.length}` : ''}` }, { value: 'versions', label: '历史版本' }]} />
      {!requestId && <div className="raw__actions"><Button size="sm" onClick={() => setPresets(true)}>提示词预设与覆盖</Button></div>}
      <div className="precedence"><Icon name="info" size={12} />覆盖优先级：单次请求 › 会话 › 项目 › 全局；<Icon name="lock" size={11} />锁定项为 Harness 执行约束不可覆盖；<Icon name="plus" size={11} />追加项按顺序拼接。</div>
      {view === 'parts' && <div className="stagger col">{prompt.parts.map(part => <PartCard key={part.id} part={part} sessionId={sessionId} original={originals[part.id]} readOnly={Boolean(requestId)} onSaved={(_next, before) => { setOriginals(o => ({ [part.id]: o[part.id] ?? before, ...o })); reload(); }} />)}</div>}
      {view === 'sources' && (
        <table className="data-table">
          <thead><tr><th>组成部分</th><th>来源</th><th>作用域</th><th>规则</th><th>生效</th></tr></thead>
          <tbody>{prompt.parts.map(part => <tr key={part.id}><td>{part.label}</td><td className="mono truncate" title={part.source}>{part.source}</td><td>{scopeMeta[part.scope].label}</td><td>{mergeMeta[part.merge].label}</td><td>{part.effective ? <Icon name="check" size={13} className="ok" /> : <span className="muted">—</span>}</td></tr>)}</tbody>
        </table>
      )}
      {view === 'full' && <div className="col">{effective.map(part => <div key={part.id} className="full-msg"><div className="full-msg__role">{part.role}<span className="muted"> · {part.label}</span></div><pre>{part.content}</pre></div>)}</div>}
      {view === 'diff' && (edited.length === 0
        ? <EmptyState icon="diff" title="还没有修改" detail="在“分段”视图中编辑可自定义的部分后，这里会显示修改前后的差异。" />
        : edited.map(part => { const lines = lineDiff(originals[part.id], part.content), stats = diffStats(lines); return <div key={part.id} className="file-diff"><div className="file-diff__head"><span className="grow">{part.label}</span><span className="diff-stat"><span className="diff-stat__add">+{stats.additions}</span><span className="diff-stat__del">−{stats.deletions}</span></span></div><DiffLines lines={lines} lang="text" mode="split" /></div>; }))}
      {view === 'versions' && <SavedVersionCompare sessionId={sessionId} kind="prompt" />}
      {presets && <PromptPresetEditor sessionId={sessionId} prompt={prompt} onSaved={() => reload()} onClose={() => setPresets(false)} />}
    </div>
  );
}

export function PromptPanel({ sessionId }: { sessionId: string }) {
  const requestId = useApp(state => state.inspectorFocus?.requestId);
  return <>
    {requestId && <div className="raw__note">历史请求 {requestId} 的提示词快照，只读。<Button size="sm" onClick={() => openInspector('prompt')}>查看当前有效提示词</Button></div>}
    {/* Keep the current editor mounted so viewing a saved request cannot discard its draft. */}
    <div hidden={Boolean(requestId)}><PromptContent key={`current:${sessionId}`} sessionId={sessionId} /></div>
    {requestId && <PromptContent key={`${sessionId}:${requestId}`} sessionId={sessionId} requestId={requestId} />}
  </>;
}
