import { useEffect, useState } from 'react';
import { gateway, type ProjectView } from '../../api';
import { goHome, guard, removeProject } from '../../app/actions';
import { setState } from '../../app/store';
import { Icon } from '../../components/Icon';
import { Button, IconButton, Modal, Skeleton, spotlight } from '../../components/ui';
import { relativeTime } from '../../lib/format';

const langColors = ['var(--accent)', 'var(--info)', 'var(--ok)', 'var(--accent-2)', 'var(--text-3)'];

export function ProjectsView() {
  const [projects, setProjects] = useState<ProjectView[]>();
  useEffect(() => { void guard('读取项目失败', () => gateway.workspace.projects()).then(result => setProjects(result ?? [])); }, []);
  const add = async () => {
    const project = await guard('登记项目失败', () => gateway.workspace.addProject());
    if (project) setProjects(current => [project, ...(current ?? [])]);
  };
  const open = (project: ProjectView) => { setState({ projectId: project.id }); goHome('code'); };
  const [removing, setRemoving] = useState<ProjectView>();
  const unregister = async () => {
    const target = removing;
    setRemoving(undefined);
    if (target && await removeProject(target.id)) setProjects(current => current?.filter(p => p.id !== target.id));
  };
  return (
    <div className="page">
      <div className="page__head">
        <div><h2>项目</h2><p className="muted">Agent 只能在你明确登记的工作区内读写。</p></div>
        <Button variant="primary" icon="plus" onClick={() => void add()}>登记项目</Button>
      </div>
      {!projects ? <div className="project-grid"><Skeleton lines={4} /><Skeleton lines={4} /></div> : (
        <div className="project-grid stagger">
          {projects.map(project => (
            <div key={project.id} className="project-card spotlight" onMouseMove={spotlight}>
              <div className="project-card__head">
                <span className="project-card__icon"><Icon name="folder" size={18} /></span>
                <div className="grow"><div className="project-card__name">{project.name}</div><div className="mono muted truncate" title={project.path}>{project.path}</div></div>
              </div>
              {project.languages?.length ? (
                <>
                  <div className="lang-bar">{project.languages.map((lang, i) => <span key={lang.name} style={{ width: `${lang.share * 100}%`, background: langColors[i % langColors.length] }} />)}</div>
                  <div className="lang-legend">{project.languages.map((lang, i) => <span key={lang.name}><i style={{ background: langColors[i % langColors.length] }} />{lang.name} {(lang.share * 100).toFixed(0)}%</span>)}</div>
                </>
              ) : <div className="muted">尚未分析语言构成</div>}
              <div className="project-card__meta">
                {project.branch && <span><Icon name="branch" size={12} />{project.branch}</span>}
                <span><Icon name="chat" size={12} />{project.sessions} 个会话</span>
                {project.changedFiles ? <span className="warn"><Icon name="diff" size={12} />{project.changedFiles} 处变更</span> : null}
                <span className="grow" />
                <span className="muted">{relativeTime(project.lastOpenedAt)}</span>
              </div>
              <div className="project-card__actions">
                <Button size="sm" variant="secondary" icon="code" onClick={() => open(project)}>在 Code 中开始</Button>
                <Button size="sm" variant="ghost" icon="external" onClick={() => void gateway.desktop.openIde(project.id)}>IDE</Button>
                <span className="grow" />
                <IconButton icon="trash" label="取消登记" size={14} tipSide="top" onClick={() => setRemoving(project)} />
              </div>
            </div>
          ))}
          <button type="button" className="project-card project-card--add" onClick={() => void add()}><Icon name="plus" size={22} /><span>登记新的工作区</span><span className="muted">选择一个具体的项目目录</span></button>
        </div>
      )}
      <Modal open={!!removing} onClose={() => setRemoving(undefined)} title={`取消登记「${removing?.name ?? ''}」？`} width={440}
        footer={<><Button variant="ghost" onClick={() => setRemoving(undefined)}>取消</Button><Button variant="danger" icon="trash" onClick={() => void unregister()}>取消登记</Button></>}>
        <p>只移除登记记录，<strong>不会删除磁盘上的任何文件</strong>。Agent 之后不能再读写 <span className="mono">{removing?.path}</span>；已有会话会保留，但不再关联该项目。</p>
      </Modal>
    </div>
  );
}
