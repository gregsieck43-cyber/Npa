import { useEffect, useState } from 'react';
import { gateway } from '../../api';
import { useApp } from '../../app/store';
import type { LibraryKind, LibraryPreset, LibraryScope } from '../../api/library-types';
import { Button, ErrorBanner, Modal } from '../../components/ui';
import { Field } from '../pages/ModelEditor';

export function ScopeOptions({ project }: { project: boolean }) { return <><option value="session">此会话</option><option value="project" disabled={!project}>{project ? '此项目' : '此项目（请先关联项目）'}</option><option value="global">全局</option></>; }

export function PresetDialog({ sessionId, kind, value, sourceRequestId, onLoad, onClose }: { sessionId: string; kind: LibraryKind; value: Record<string, unknown>; sourceRequestId?: string; onLoad: (preset: LibraryPreset) => Promise<void>; onClose: () => void }) {
  const project = useApp(state => state.sessions[sessionId]?.projectId);
  const [scope, setScope] = useState<LibraryScope>('session');
  const [cursor, setCursor] = useState<string>();
  const [next, setNext] = useState<string>();
  const [items, setItems] = useState<LibraryPreset[]>([]);
  const [selected, setSelected] = useState<LibraryPreset>();
  const [versions, setVersions] = useState<LibraryPreset[]>([]);
  const [versionNext, setVersionNext] = useState<string>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true; setLoading(true); setSelected(undefined); setVersions([]); setError(undefined);
    gateway.library.presets({ sessionId, kind, scope, cursor, limit: 10 }).then(page => { if (alive) { setItems(page.items); setNext(page.nextCursor); } }, failure => { if (alive) setError(String(failure.message ?? failure)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sessionId, kind, scope, cursor, revision]);
  const choose = async (id: string) => {
    setBusy(true); setError(undefined);
    try {
      const preset = items.find(item => item.id === id);
      setSelected(preset); setVersions([]); setVersionNext(undefined);
      if (preset) { setName(preset.name); const page = await gateway.library.presetVersions({ sessionId, id, limit: 10 }); setVersions(page.items); setVersionNext(page.nextCursor); }
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  const save = async (update: boolean) => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const preset = await gateway.library.savePreset({ sessionId, kind, scope, name: name.trim(), value, sourceRequestId, ...(update && selected ? { id: selected.id, expectedVersion: selected.version } : {}) });
      setNotice(`已保存「${preset.name}」v${preset.version} · ${preset.scope}；历史请求未修改`); setRevision(current => current + 1);
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  const load = async () => {
    if (!selected) return; setBusy(true); setError(undefined);
    try { await onLoad(await gateway.library.preset({ sessionId, id: selected.id, version: selected.version })); onClose(); }
    catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  return <Modal open onClose={() => { if (!busy) onClose(); }} title={kind === 'request' ? '请求预设' : '提示词预设'} width={620} footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>关闭</Button><span className="grow" /><Button disabled={!selected || busy || loading} onClick={() => void load()}>加载到草稿</Button></>}>
    <div className="model-form">
      <div className="set-note">加载只更新可预览的草稿，不发送模型请求。保存范围由下方作用域决定；更新预设会创建新版本。</div>
      {error && <ErrorBanner message={error} />}{notice && <div className="set-note" role="status">{notice}</div>}
      <Field label="预设作用域"><select className="input" aria-label="预设作用域" value={scope} disabled={busy} onChange={event => { setScope(event.target.value as LibraryScope); setCursor(undefined); setNotice(undefined); }}><ScopeOptions project={!!project} /></select></Field>
      <Field label="已保存预设"><select className="input" aria-label="已保存预设" disabled={busy || loading} value={selected?.id ?? ''} onChange={event => void choose(event.target.value)}><option value="">{loading ? '读取中…' : '选择预设'}</option>{items.map(item => <option key={item.id} value={item.id}>{item.name} · v{item.version} · {item.scope}</option>)}</select></Field>
      <div className="raw__actions"><Button size="sm" disabled={!cursor || busy} onClick={() => setCursor(undefined)}>首页</Button><Button size="sm" disabled={!next || busy} onClick={() => setCursor(next)}>下一页预设</Button></div>
      {selected && <><Field label="预设版本"><select className="input" aria-label="预设版本" value={selected.version} disabled={busy} onChange={event => { const version = versions.find(item => item.version === Number(event.target.value)); if (version) setSelected(version); }}>{!versions.some(item => item.version === selected.version) && <option value={selected.version}>v{selected.version}</option>}{versions.map(item => <option key={item.version} value={item.version}>v{item.version} · {item.createdAt}</option>)}</select></Field>
        {versionNext && <Button size="sm" disabled={busy} onClick={() => { setBusy(true); void gateway.library.presetVersions({ sessionId, id: selected.id, cursor: versionNext, limit: 10 }).then(page => { setVersions(page.items); setVersionNext(page.nextCursor); }, failure => setError((failure as Error).message)).finally(() => setBusy(false)); }}>更早预设版本</Button>}
        <pre className="response-text" aria-label="预设预览">{JSON.stringify(selected.value, null, 2)}</pre></>}
      <Field label="预设名称"><input className="input" maxLength={100} value={name} onChange={event => setName(event.target.value)} /></Field>
      <div className="raw__actions"><Button disabled={!name.trim() || busy || loading} onClick={() => void save(false)}>当前草稿另存预设</Button><Button disabled={!name.trim() || !selected || busy || loading} onClick={() => void save(true)}>当前草稿保存为新版本</Button></div>
    </div>
  </Modal>;
}
