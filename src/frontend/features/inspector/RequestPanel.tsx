import { useEffect, useMemo, useRef, useState } from 'react';
import { gateway, type RequestRecordView } from '../../api';
import { guard, openInspector } from '../../app/actions';
import { useApp } from '../../app/store';
import { Icon } from '../../components/Icon';
import { JsonEditor } from '../../components/JsonEditor';
import { CopyButton, DiffLines } from '../../components/rich';
import { Badge, Button, EmptyState, ErrorBanner, Segmented, Skeleton } from '../../components/ui';
import { diffStats } from '../../lib/diff';
import { clockTime, compactNumber, duration } from '../../lib/format';
import { useInspectorData } from './useInspectorData';
import { StructuredRequestEditor } from './StructuredRequestEditor';
import { PresetDialog } from './PresetDialog';
import { SavedVersionCompare } from './SavedVersionCompare';
import { downloadJson, readRequestFile, requestObject } from './request-draft';
import { versionDiff } from './version-diff';

const load = (id: string) => gateway.inspector.requests(id);
const statusTone = { completed: 'ok', running: 'accent', failed: 'danger', cancelled: 'neutral', draft: 'info' } as const;
const statusLabel = { completed: '完成', running: '进行中', failed: '失败', cancelled: '已取消', draft: '草稿' } as const;

function parseBody(text: string): { value?: unknown; error?: string } {
  try { return { value: requestObject(text) }; } catch (error) { return { error: (error as Error).message }; }
}

export function RequestPanel({ sessionId }: { sessionId: string }) {
  const { data, error, loading, reload } = useInspectorData(sessionId, load);
  const focus = useApp(s => s.inspectorFocus?.requestId);
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState<'overview' | 'structured' | 'raw' | 'response' | 'compare'>('overview');
  const [extra, setExtra] = useState<RequestRecordView[]>([]);
  const records = useMemo(() => [...extra.filter(e => !data?.some(d => d.id === e.id)), ...(data ?? [])], [data, extra]);
  const record = records.find(r => r.id === (selected ?? focus)) ?? records[0];
  const original = useMemo(() => (record ? JSON.stringify(record.body, null, 2) : ''), [record]);
  const [draft, setDraft] = useState(original);
  const [sending, setSending] = useState<'send' | 'branch'>();
  const [structuredInvalid, setStructuredInvalid] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [operationError, setOperationError] = useState<string>();
  const [working, setWorking] = useState(false);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const identity = `${sessionId}:${record?.id ?? ''}`;
  const activeIdentity = useRef(identity);
  activeIdentity.current = identity;
  const replaceDraft = (value: string) => { setDraft(value); setStructuredInvalid(false); setDraftEpoch(current => current + 1); };

  useEffect(() => { if (focus) { setSelected(focus); setTab('overview'); } }, [focus]);
  useEffect(() => { replaceDraft(original); setOperationError(undefined); }, [original, record?.id]);

  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return loading ? <Skeleton lines={8} /> : null;
  if (!record) return <EmptyState icon="network" title="还没有模型请求" detail="发送消息后，这里会显示服务商适配后、发送前的真实请求 Body。" />;

  const parsed = parseBody(draft), dirty = draft !== original;
  const parent = records.find(r => r.id === record.parentId);
  const compareBase = dirty ? original : parent ? JSON.stringify(parent.body, null, 2) : undefined;
  const compareTarget = dirty ? draft : original;
  const compareLines = tab === 'compare' && compareBase !== undefined ? versionDiff(compareBase, compareTarget) : [];

  const replay = async (mode: 'send' | 'branch') => {
    if (parsed.error || structuredInvalid) return;
    setSending(mode);
    const result = await guard(mode === 'send' ? '测试请求失败' : '保存分叉失败', async () => {
      const validated = await gateway.library.validateRequest(sessionId, parsed.value, record.id);
      return gateway.inspector.replay(record.id, validated.body, mode);
    });
    setSending(undefined);
    if (result) { setExtra(current => [result, ...current]); if (activeIdentity.current === identity) { setSelected(result.id); setTab(mode === 'send' ? 'response' : 'overview'); } }
  };

  const draftOperation = async (operation: () => Promise<void>) => {
    setWorking(true); setOperationError(undefined);
    try { await operation(); } catch (failure) { setOperationError((failure as Error).message); } finally { setWorking(false); }
  };
  const invalid = !!parsed.error || structuredInvalid;

  return (
    <div className="panel">
      <div className="req-list">
        {records.map(item => (
          <button key={item.id} type="button" disabled={working || !!sending || presetOpen} className={`req-item${item.id === record.id ? ' is-active' : ''}`} onClick={() => setSelected(item.id)}>
            <span className={`req-item__dot req-item__dot--${statusTone[item.status]}`} />
            <span className="mono">{item.id}</span>
            <span className="muted">{item.kind}{item.branchLabel ? ` · ${item.branchLabel}` : ''}</span>
            <span className="grow" />
            <span className="muted num">{clockTime(item.createdAt)}</span>
          </button>
        ))}
      </div>
      <Segmented size="sm" value={tab} onChange={setTab} options={[{ value: 'overview', label: '概览' }, { value: 'structured', label: '结构化' }, { value: 'raw', label: `Raw Body${dirty ? ' •' : ''}` }, { value: 'response', label: '响应' }, { value: 'compare', label: '对比' }]} />
      {operationError && <ErrorBanner message={operationError} />}

      {tab === 'overview' && (
        <div className="kv-grid">
          <span>状态</span><span><Badge tone={statusTone[record.status]}>{statusLabel[record.status]}</Badge></span>
          <span>模型</span><span className="mono">{record.model}</span>
          <span>端点</span><span className="mono truncate" title={record.endpoint}>{record.endpoint}</span>
          <span>耗时</span><span className="num">{duration(record.durationMs)}{record.firstTokenMs ? ` · 首字 ${duration(record.firstTokenMs)}` : ''}</span>
          <span>Tokens</span><span className="num">{record.usage ? `${compactNumber(record.usage.input)} 输入 · ${compactNumber(record.usage.output)} 输出${record.usage.cached ? ` · ${compactNumber(record.usage.cached)} 缓存` : ''}` : '服务商未返回'}</span>
          <span>父请求</span><span className="mono">{record.parentId ?? '—'}</span>
          <span>提示词快照</span><Button size="sm" onClick={() => openInspector('prompt', { requestId: record.id })}>查看此请求的提示词</Button>
          <span>脱敏</span><span>{record.redactions.length ? record.redactions.map(r => <code key={r} className="inline-code">{r}</code>) : '无'}</span>
          {record.error && <><span>错误</span><span className="danger">{record.error.code}: {record.error.message}</span></>}
        </div>
      )}

      {
        <div className="raw" hidden={tab !== 'raw' && tab !== 'structured'}>
          <div className="raw__note"><Icon name="info" size={12} />服务商适配后、网络发送前采集。凭据已脱敏，编辑 Body 不会授予任何工具执行权限。</div>
          <div hidden={tab !== 'structured'}><StructuredRequestEditor key={`${record.id}-${draftEpoch}`} value={draft} onChange={setDraft} onInvalid={setStructuredInvalid} /></div>
          <div hidden={tab !== 'raw'} className="raw__editor"><JsonEditor value={draft} onChange={value => { if (value !== draft) replaceDraft(value); }} /></div>
          {structuredInvalid && tab === 'raw' && <ErrorBanner message="结构化编辑有尚未应用的无效字段；返回修正，或修改 Raw Body 以替换草稿。" />}
          <div className={`raw__status${parsed.error ? ' is-error' : ''}`}>{parsed.error ? <><Icon name="alert" size={12} />{parsed.error}</> : <><Icon name="check" size={12} />JSON 有效{dirty ? ' · 已修改（一次性，不影响会话配置）' : ''}</>}</div>
          <div className="raw__actions">
            <Button size="sm" variant="ghost" icon="sparkles" disabled={invalid} onClick={() => setDraft(JSON.stringify(parsed.value, null, 2))}>格式化</Button>
            <CopyButton text={draft} label="复制 Body" successLabel="Body 已复制" />
            <Button size="sm" variant="ghost" icon="download" disabled={invalid || working} onClick={() => void draftOperation(async () => { const validated = await gateway.library.validateRequest(sessionId, parsed.value, record.id); downloadJson(`${record.id}.json`, validated.body); })}>导出</Button>
            <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="导入请求文件" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void draftOperation(async () => { const validated = await gateway.library.validateRequest(sessionId, await readRequestFile(file), record.id); if (activeIdentity.current === identity) replaceDraft(JSON.stringify(validated.body, null, 2)); }); }} />
            <Button size="sm" variant="ghost" icon="upload" disabled={working || !!sending} onClick={() => fileInput.current?.click()}>导入</Button>
            <Button size="sm" variant="ghost" disabled={invalid || working} onClick={() => setPresetOpen(true)}>请求预设</Button>
            {(dirty || structuredInvalid) && <Button size="sm" variant="ghost" icon="refresh" onClick={() => replaceDraft(original)}>还原</Button>}
            <span className="grow" />
            <Button size="sm" variant="secondary" icon="branch" disabled={invalid || !!sending || working} onClick={() => void replay('branch')}>{sending === 'branch' ? '保存中…' : '另存分叉'}</Button>
            <Button size="sm" variant="glow" icon="play" disabled={invalid || !!sending || working} onClick={() => void replay('send')}>{sending === 'send' ? '发送中…' : '有界测试发送'}</Button>
          </div>
          <div className="raw__note raw__note--warn"><Icon name="shield" size={12} />重发只调用模型，不会重放有副作用的工具；需要重新执行工具时会按当前权限模式重新审批。</div>
        </div>
      }

      {tab === 'response' && (record.response ? (
        <div className="col">
          <div className="kv-grid"><span>结束原因</span><span className="mono">{record.response.finishReason}</span></div>
          <pre className="response-text">{record.response.content || '（无文本内容）'}</pre>
          {record.response.toolCalls?.length ? <div className="col">{record.response.toolCalls.map((call, i) => <div key={i} className="full-msg"><div className="full-msg__role">tool_call · {call.name}</div><pre>{call.arguments}</pre></div>)}</div> : null}
        </div>
      ) : <EmptyState icon="clock" title="暂无响应" detail={record.status === 'draft' ? '这是一个分叉草稿，发送后会记录响应。' : '请求仍在进行或未返回内容。'} />)}

      {tab === 'compare' && (compareBase === undefined
        ? <EmptyState icon="diff" title="没有可对比的版本" detail="修改 Raw Body，或选择一个由分叉/重发产生的请求，即可与其父版本对比。" />
        : compareLines ? <div className="file-diff"><div className="file-diff__head"><span className="grow">{dirty ? '原始 Body → 当前编辑' : `父请求 ${parent!.id} → ${record.id}`}</span><span className="diff-stat"><span className="diff-stat__add">+{diffStats(compareLines).additions}</span><span className="diff-stat__del">−{diffStats(compareLines).deletions}</span></span></div><DiffLines lines={compareLines} lang="json" mode="unified" /></div> : <ErrorBanner message="正文超过页面差异计算上限，请导出后比较。" />)}
      {tab === 'compare' && <SavedVersionCompare sessionId={sessionId} kind="request" />}
      {presetOpen && <PresetDialog sessionId={sessionId} kind="request" sourceRequestId={record.id} value={parsed.value as Record<string, unknown>} onClose={() => setPresetOpen(false)} onLoad={async preset => { const validated = await gateway.library.validateRequest(sessionId, preset.value, record.id); if (activeIdentity.current === identity) { replaceDraft(JSON.stringify(validated.body, null, 2)); setTab('structured'); } }} />}
    </div>
  );
}
