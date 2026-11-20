import { useState } from 'react';
import { gateway, type ProjectView } from '../../api';
import { guard, removeProject } from '../../app/actions';
import { setState, useApp } from '../../app/store';
import { Button, Modal } from '../../components/ui';

export function ComposerProject({ sessionId }: { sessionId?: string }) {
  const projects = useApp(s => s.projects);
  const selected = useApp(s => sessionId ? s.sessions[sessionId]?.projectId : s.projectId);
  const folder = useApp(s => s.projectFolder);
  const project = projects.find(p => p.id === selected);
  const [draft, setDraft] = useState<{ id?: string; name: string; folders: string[] }>();
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const edit = (p?: ProjectView) => setDraft({ id: p?.id, name: p?.name ?? '', folders: p?.sourceFolders ?? (p ? [p.path] : []) });
  const add = async () => {
    setPicking(true);
    const folder = await guard('选择文件夹失败', () => gateway.workspace.pickSourceFolder());
    setPicking(false);
    if (folder) setDraft(d => d && !d.folders.some(f => f.toLowerCase() === folder.toLowerCase()) ? {
      ...d, folders: [...d.folders, folder], name: d.name || folder.split(/[\\\\/]/).pop() || ''
    } : d);
  };
  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const result = await guard('保存项目失败', () => gateway.workspace.editProject(draft.id, draft.name.trim(), draft.folders));
      if (result) {
        setState(s => ({ projects: [result, ...s.projects.filter(p => p.id !== result.id)], projectId: result.id, projectFolder: undefined }));
        setDraft(undefined);
      }
    } finally { setBusy(false); }
  };
  return <div className="composer-project">
    {sessionId ? <span>{project?.name ?? '无项目'}</span> : <>
      <select aria-label="选择项目" value={selected ?? ''} onChange={event => {
        if (event.target.value === '__new') edit(); else setState({ projectId: event.target.value || undefined, projectFolder: undefined });
      }}>
        <option value="">无项目</option>
        {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        <option value="__new">新建项目…</option>
      </select>
      <button type="button" aria-label={project ? '编辑项目' : '新建项目'} onClick={() => edit(project)}>＋</button>
      {project?.sourceFolders && project.sourceFolders.length > 1 && <select aria-label="本次会话的工作文件夹" value={project.sourceFolders.includes(folder ?? '') ? folder : project.path} onChange={e => setState({ projectFolder: e.target.value })}>
        {project.sourceFolders.map(path => <option key={path} value={path}>{path}</option>)}
      </select>}
    </>}
    {draft && <Modal open title={draft.id ? '编辑项目' : '新建项目'} onClose={() => { if (!busy) setDraft(undefined); }} footer={<>
      {draft.id && <Button variant="danger" disabled={busy} onClick={async () => {
        if (window.confirm('解除项目登记？磁盘上的文件会保留。') && await removeProject(draft.id!)) setDraft(undefined);
      }}>删除项目</Button>}<span className="grow" /><Button variant="ghost" disabled={busy} onClick={() => setDraft(undefined)}>取消</Button>
      <Button variant="primary" disabled={busy || picking || !draft.name.trim() || !draft.folders.length} onClick={() => void save()}>保存</Button>
    </>}>
      <label className="form-field">项目名称<input className="input" maxLength={100} value={draft.name} onChange={e => { const name = e.target.value; setDraft(d => d && { ...d, name }); }} /></label>
      <div className="form-field">源文件夹{draft.folders.map((folder, i) => <div className="row" key={folder}>
        <span className="grow truncate" title={folder}>{folder}</span>
        <Button size="sm" disabled={!i} onClick={() => setDraft({ ...draft, folders: [folder, ...draft.folders.filter(f => f !== folder)] })}>{i ? '设为主要' : '主要'}</Button>
        <Button size="sm" onClick={() => setDraft({ ...draft, folders: draft.folders.filter(f => f !== folder) })}>移除</Button>
      </div>)}<Button icon="folder" disabled={picking || busy} onClick={() => void add()}>添加文件夹</Button></div>
    </Modal>}
  </div>;
}
