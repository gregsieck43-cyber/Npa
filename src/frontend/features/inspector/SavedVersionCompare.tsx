import { useEffect, useState } from 'react';
import { gateway, type RequestRecordView } from '../../api';
import { useApp } from '../../app/store';
import type { LibraryScope, PromptVersion } from '../../api/library-types';
import { DiffLines } from '../../components/rich';
import { Button, ErrorBanner } from '../../components/ui';
import { Field } from '../pages/ModelEditor';
import { ScopeOptions } from './PresetDialog';
import { versionDiff } from './version-diff';

type Version = { id: string; label: string; text: string; unavailable?: boolean };
const promptVersion = (value: PromptVersion): Version => ({ id: String(value.version), label: `${value.scope} · v${value.version}`, text: JSON.stringify({ systemPrompt: value.systemPrompt, developerPrompt: value.developerPrompt, dynamic: value.dynamic }, null, 2) });
const requestVersion = (value: RequestRecordView): Version => ({ id: value.id, label: `${value.id} · ${value.createdAt}${value.bodyHash ? ` · ${value.bodyHash.slice(0, 12)}` : ''}`, text: JSON.stringify(value.body, null, 2), unavailable: value.recordContent === false });

/** Each selector pages independently, so users can compare records on different pages without retaining history. */
function VersionPicker({ sessionId, kind, scope, label, selected, onChange }: { sessionId: string; kind: 'prompt' | 'request'; scope: LibraryScope; label: string; selected?: Version; onChange: (value: Version) => void }) {
  const [cursor, setCursor] = useState<string>();
  const [next, setNext] = useState<string>();
  const [items, setItems] = useState<Version[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true; setLoading(true); setError(undefined);
    const page = kind === 'prompt'
      ? gateway.library.promptVersions(sessionId, { scope, cursor, limit: 10 }).then(result => ({ items: result.items.map(promptVersion), nextCursor: result.nextCursor }))
      : gateway.library.requestVersions(sessionId, { cursor, limit: 10 }).then(result => ({ items: result.items.map(requestVersion), nextCursor: result.nextCursor }));
    page.then(result => { if (alive) { setItems(result.items); setNext(result.nextCursor); } }, failure => { if (alive) setError((failure as Error).message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sessionId, kind, scope, cursor]);
  return <div className="col">{error && <ErrorBanner message={error} />}<Field label={label}><select className="input" aria-label={label} value={selected?.id ?? ''} disabled={loading} onChange={event => { const item = items.find(value => value.id === event.target.value); if (item) onChange(item); }}><option value="">{loading ? '读取中…' : '选择已保存版本'}</option>{selected && !items.some(item => item.id === selected.id) && <option value={selected.id}>{selected.label}</option>}{items.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field><div className="raw__actions"><Button size="sm" disabled={!cursor || loading} onClick={() => setCursor(undefined)}>首页</Button><Button size="sm" disabled={!next || loading} onClick={() => setCursor(next)}>更早版本</Button></div></div>;
}

export function SavedVersionCompare({ sessionId, kind }: { sessionId: string; kind: 'prompt' | 'request' }) {
  const project = useApp(state => state.sessions[sessionId]?.projectId);
  const [scope, setScope] = useState<LibraryScope>('session');
  const [before, setBefore] = useState<Version>();
  const [after, setAfter] = useState<Version>();
  const lines = before && after && !before.unavailable && !after.unavailable ? versionDiff(before.text, after.text) : undefined;
  return <div className="col">
    {kind === 'prompt' && <Field label="提示词版本作用域"><select className="input" aria-label="提示词版本作用域" value={scope} onChange={event => { setScope(event.target.value as LibraryScope); setBefore(undefined); setAfter(undefined); }}><ScopeOptions project={!!project} /></select></Field>}
    <div className="model-form__grid"><VersionPicker key={`before-${scope}`} sessionId={sessionId} kind={kind} scope={scope} label="比较基准版本" selected={before} onChange={setBefore} /><VersionPicker key={`after-${scope}`} sessionId={sessionId} kind={kind} scope={scope} label="比较目标版本" selected={after} onChange={setAfter} /></div>
    {before && after ? before.unavailable || after.unavailable ? <ErrorBanner message="所选版本未保存请求正文，无法计算内容差异。" /> : lines ? <div className="file-diff"><div className="file-diff__head">{before.label} → {after.label}</div><DiffLines lines={lines} lang="json" mode="unified" /></div> : <ErrorBanner message="所选正文超过页面差异计算上限，请导出后比较。" /> : <div className="set-note">选择任意两个已保存版本。读取和比较不会修改历史或调用模型。</div>}
  </div>;
}
