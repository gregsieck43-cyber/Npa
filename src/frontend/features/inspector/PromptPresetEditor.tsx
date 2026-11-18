import { useEffect, useState } from 'react';
import { gateway, type PromptView } from '../../api';
import { useApp } from '../../app/store';
import { Button, ErrorBanner, Modal } from '../../components/ui';
import { Field } from '../pages/ModelEditor';
import { PresetDialog, ScopeOptions } from './PresetDialog';

const fields = ['systemPrompt', 'developerPrompt', 'dynamic'] as const;
type FieldName = typeof fields[number];
type Draft = Record<FieldName, string>;

export function PromptPresetEditor({ sessionId, prompt, onSaved, onClose }: { sessionId: string; prompt: PromptView; onSaved: (view: PromptView) => void; onClose: () => void }) {
  const project = useApp(state => state.sessions[sessionId]?.projectId);
  const chat = useApp(state => state.sessions[sessionId]?.mode === 'chat');
  const [draft, setDraft] = useState<Draft>(() => Object.fromEntries(fields.map(field => [field, prompt.parts.filter(part => part.editable && part.effective && part.id.includes(`:${field}`)).at(-1)?.content ?? ''])) as Draft);
  const [library, setLibrary] = useState(false);
  const [source, setSource] = useState('当前有效的可编辑提示词');
  const [scope, setScope] = useState<'request' | 'session' | 'project' | 'global'>('request');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [supportsDeveloper, setSupportsDeveloper] = useState<boolean>();
  useEffect(() => {
    if (!chat) { setSupportsDeveloper(undefined); setError(undefined); return; }
    let alive = true;
    gateway.library.sessionSettings(sessionId).then(settings => { if (alive) setSupportsDeveloper(settings.supportsDeveloper); }, failure => { if (alive) setError((failure as Error).message); });
    return () => { alive = false; };
  }, [sessionId, chat]);
  const developerInvalid = chat && !!draft.developerPrompt.trim() && supportsDeveloper !== true;
  const apply = async () => {
    if (developerInvalid) return;
    setBusy(true); setError(undefined); let saved = 0;
    try {
      for (const field of fields) { const next = await gateway.inspector.savePrompt(sessionId, `session:${field}`, draft[field], scope); onSaved(next); saved++; }
      onClose();
    } catch (failure) { setError(`${saved ? `已有 ${saved} 个字段保存成功；` : ''}${(failure as Error).message}`); } finally { setBusy(false); }
  };
  return <>
    <Modal open={!library} onClose={() => { if (!busy) onClose(); }} title="提示词预设与覆盖" width={620} footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button><span className="grow" /><Button disabled={busy} onClick={() => setLibrary(true)}>提示词预设库</Button><Button variant="primary" disabled={busy || developerInvalid} onClick={() => void apply()}>{busy ? '应用中…' : '应用提示词草稿'}</Button></>}>
      <div className="model-form"><div className="set-note">{source}。加载预设只预览；应用后影响后续请求，不改写历史。Harness 锁定提示词保持有效。</div>{error && <ErrorBanner message={error} />}
        <Field label="应用作用域"><select className="input" aria-label="应用作用域" value={scope} disabled={busy} onChange={event => setScope(event.target.value as typeof scope)}><option value="request">仅下次请求</option><ScopeOptions project={!!project} /></select></Field>
        {fields.map(field => <Field key={field} label={field}><span className="prompt-edit"><textarea aria-label={field} rows={5} disabled={busy} value={draft[field]} onChange={event => setDraft(current => ({ ...current, [field]: event.target.value }))} /></span></Field>)}
        {developerInvalid && <ErrorBanner message={supportsDeveloper === false ? '当前模型不支持 Developer Prompt；请清空此字段后应用。' : '尚未确认模型支持 Developer Prompt；请等待读取或清空此字段。'} />}
        <div className="set-note">Developer Prompt 仅在接口支持时生效；不支持时后台会明确拒绝。</div>
      </div>
    </Modal>
    {library && <PresetDialog sessionId={sessionId} kind="prompt" value={draft} onClose={() => setLibrary(false)} onLoad={async preset => { setDraft(Object.fromEntries(fields.map(field => [field, typeof preset.value[field] === 'string' ? preset.value[field] : ''])) as Draft); setSource(`已加载「${preset.name}」v${preset.version} · ${preset.scope}`); }} />}
  </>;
}
