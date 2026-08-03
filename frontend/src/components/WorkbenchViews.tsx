import type { ReactNode } from "react";
import type { KnowledgeTab, Project, Run, SettingsTab, ViewId, WorkTask, WorkbenchSettings, WorkspaceTab } from "../lib/types";
import { formatRelativeTime, statusLabel } from "../lib/utils";
import { CodePanel, DataPanel, GitPanel, KnowledgePanel, SettingsPanel, TerminalPanel } from "./FeaturePanels";
import { Icon } from "./Icon";
import { WorkspaceTabs } from "./WorkspaceTabs";

interface WorkbenchViewsProps {
  view: Exclude<ViewId, "today">;
  online: boolean;
  projects: Project[];
  tasks: WorkTask[];
  runs: Run[];
  selectedProjectId: string | null;
  workspaceTab: WorkspaceTab;
  knowledgeTab: KnowledgeTab;
  settingsTab: SettingsTab;
  settings?: WorkbenchSettings;
  onProjectSelect: (projectId: string) => void;
  onWorkspaceTab: (tab: WorkspaceTab) => void;
  onKnowledgeTab: (tab: KnowledgeTab) => void;
  onSettingsTab: (tab: SettingsTab) => void;
  onNewTask: (title?: string) => void;
  onStartRun: (taskId: string) => void;
  onRunAction: (runId: string, action: "pause" | "resume" | "cancel" | "wake") => void;
  onViewRun: (runId: string) => void;
  notify?: (message: string) => void;
}

export function WorkbenchViews(props: WorkbenchViewsProps) {
  if (props.view === "projects") return <ProjectsView {...props} />;
  if (props.view === "tasks") return <TasksView {...props} />;
  if (props.view === "knowledge") return <KnowledgeView {...props} />;
  if (props.view === "automation") return <AutomationView online={props.online} runs={props.runs} />;
  return <SettingsView {...props} />;
}

function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="content-heading page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="heading-subtitle">{description}</p></div>{actions ? <div className="heading-actions">{actions}</div> : null}</header>;
}

function ProjectsView({ online, projects, selectedProjectId, workspaceTab, onProjectSelect, onWorkspaceTab, onNewTask, notify }: WorkbenchViewsProps) {
  const selectedProject = projects.find((project) => project.id === selectedProjectId) || projects[0];
  return <section className="view-content">
    <PageHeader description="把 Data、Canvas、Code、Terminal 和 Git 放在同一条工作路径上。" eyebrow="Workspace" title="项目" actions={<button className="primary-button" onClick={() => onNewTask()} type="button"><Icon name="plus" size={16} />新建任务</button>} />
    <div className="workspace-layout">
      <div className="project-list-card"><div className="card-heading"><span>项目列表</span><span className="subtle">{projects.length}</span></div>{projects.length ? projects.map((project) => <button className={`project-select-row ${selectedProject?.id === project.id ? "is-active" : ""}`} key={project.id} onClick={() => onProjectSelect(project.id)} type="button"><span className="project-avatar" style={{ background: project.color || "var(--accent)" }}>{project.name.slice(0, 1).toUpperCase()}</span><span><strong>{project.name}</strong><small>{project.path || "本地项目"}</small></span><Icon name="chevron" size={14} /></button>) : <OfflineNotice online={online} noun="项目" />}</div>
      <div className="workspace-main"><div className="workspace-context"><div><p className="eyebrow">当前项目</p><h2>{selectedProject?.name || "选择一个项目"}</h2><p>{selectedProject?.description || (online ? "选择项目以打开工作区。" : "服务未连接，项目数据会在连接后同步。")}</p></div>{selectedProject ? <span className="path-chip"><Icon name="folder" size={14} />{selectedProject.path || "local"}</span> : null}</div><WorkspaceTabs active={workspaceTab} kind="workspace" onChange={(tab) => onWorkspaceTab(tab as WorkspaceTab)} /><WorkspaceTabContent active={workspaceTab} online={online} project={selectedProject} projectId={selectedProject?.id} notify={notify} /></div>
    </div>
  </section>;
}

function WorkspaceTabContent({ active, online, project, projectId, notify }: { active: WorkspaceTab; online: boolean; project?: Project; projectId?: string; notify?: (message: string) => void }) {
  if (active === "Data") return <DataPanel online={online} notify={notify} projectId={projectId} />;
  if (active === "Code") return <CodePanel online={online} notify={notify} projectId={projectId} />;
  if (active === "Git") return <GitPanel online={online} notify={notify} projectId={projectId} />;
  if (active === "Terminal") return <TerminalPanel online={online} notify={notify} projectId={projectId} />;
  return <div className="workspace-empty"><span className="workspace-empty-icon"><Icon name="canvas" size={24} /></span><h3>Canvas 工作区</h3><p>将想法和产物组织成可检查的画布。</p><small>{online ? `等待 ${project?.name || "项目"} 的画布数据。` : "离线模式下不会执行命令或写入文件。"}</small><button className="ghost-button" type="button"><Icon name="arrow" size={15} />打开工作区</button></div>;
}

function TasksView({ online, tasks, runs, onNewTask, onStartRun, onRunAction, onViewRun }: WorkbenchViewsProps) {
  return <section className="view-content"><PageHeader description="每个任务都有明确状态、运行记录和下一步。" eyebrow="Execution" title="任务" actions={<button className="primary-button" onClick={() => onNewTask()} type="button"><Icon name="plus" size={16} />新建任务</button>} /><div className="task-board"><div className="task-board-header"><span>所有任务</span><span className="subtle">{online ? "实时同步" : "离线快照"}</span></div>{tasks.length ? tasks.map((task) => <TaskRow key={task.id} onRunAction={onRunAction} onStartRun={onStartRun} onViewRun={onViewRun} run={runs.find((run) => run.taskId === task.id)} task={task} />) : <OfflineNotice online={online} noun="任务" />}</div></section>;
}

function TaskRow({ task, run, onStartRun, onRunAction, onViewRun }: { task: WorkTask; run?: Run; onStartRun: (taskId: string) => void; onRunAction: (runId: string, action: "pause" | "resume" | "cancel" | "wake") => void; onViewRun: (runId: string) => void }) {
  const status = run?.status || task.status;
  const active = Boolean(run && ["queued", "running", "sleeping", "reconciling", "waiting_approval", "paused"].includes(run.status));
  return <article className="task-list-row"><span className={`status-marker marker-${status || "todo"}`}><Icon name={status === "completed" || status === "done" ? "check" : status === "running" ? "loader" : "dot"} size={15} /></span><div className="task-row-main"><strong>{task.title}</strong><p>{task.summary || "暂无摘要"}</p><small>{task.updatedAt ? formatRelativeTime(task.updatedAt) : "尚未更新"}{task.priority ? ` · ${task.priority}` : ""}</small></div><div className="task-row-status"><span className={`status-chip status-${status || "todo"}`}>{statusLabel(status)}</span>{run?.model ? <small>{run.model}</small> : null}<div className="task-row-actions">{run ? <button aria-label={`查看 ${task.title}`} className="icon-button tiny" data-run-view="true" onClick={() => onViewRun(run.id)} type="button"><Icon name="external" size={13} /></button> : null}{active && run ? <button aria-label={run.status === "paused" ? `恢复 ${task.title}` : `暂停 ${task.title}`} className="icon-button tiny" data-run-action={run.status === "paused" ? "resume" : "pause"} onClick={() => onRunAction(run.id, run.status === "paused" ? "resume" : "pause")} type="button"><Icon name={run.status === "paused" ? "play" : "pause"} size={14} /></button> : <button className="ghost-button compact" onClick={() => onStartRun(task.id)} type="button"><Icon name="play" size={13} />运行</button>}</div></div></article>;
}

function KnowledgeView({ online, knowledgeTab, onKnowledgeTab, selectedProjectId, notify }: WorkbenchViewsProps) {
  return <section className="view-content"><PageHeader description="让来源、研究和记忆都可回看、可撤回。" eyebrow="Knowledge" title="知识库" /><WorkspaceTabs active={knowledgeTab} kind="knowledge" onChange={(tab) => onKnowledgeTab(tab as KnowledgeTab)} /><KnowledgePanel mode={knowledgeTab} online={online} projectId={selectedProjectId} notify={notify} /></section>;
}

function AutomationView({ online, runs }: { online: boolean; runs: Run[] }) {
  const running = runs.filter((run) => ["running", "queued", "sleeping", "reconciling"].includes(run.status));
  return <section className="view-content"><PageHeader description="观察长任务、定时运行和需要你介入的工作。" eyebrow="Automation" title="自动化" actions={<button className="ghost-button" type="button"><Icon name="plus" size={16} />新建自动化</button>} /><div className="automation-grid"><article className="stat-card"><span className="stat-card-icon"><Icon name="activity" size={18} /></span><strong>{running.length}</strong><small>进行中的运行</small></article><article className="stat-card"><span className="stat-card-icon"><Icon name="clock" size={18} /></span><strong>0</strong><small>等待调度</small></article><article className="stat-card"><span className="stat-card-icon"><Icon name="shield" size={18} /></span><strong>0</strong><small>待审批</small></article></div><div className="automation-empty"><Icon name="automation" size={26} /><h2>{online ? "还没有自动化运行" : "离线模式已暂停自动化"}</h2><p>{online ? "创建一个自动化任务后，运行日志会出现在这里。" : "连接本地服务后，调度器才会开始工作。"}</p></div></section>;
}

function SettingsView({ online, settingsTab, onSettingsTab, settings, notify }: WorkbenchViewsProps) {
  return <section className="view-content"><PageHeader description="保持默认安全，所有高风险动作都需要明确确认。" eyebrow="Preferences" title="设置" /><WorkspaceTabs active={settingsTab} kind="settings" onChange={(tab) => onSettingsTab(tab as SettingsTab)} /><SettingsPanel online={online} tab={settingsTab} initialSettings={settings} notify={notify} /></section>;
}

function OfflineNotice({ online, noun }: { online: boolean; noun: string }) {
  return <div className="offline-notice"><Icon name={online ? "folder" : "refresh"} size={19} /><div><strong>{online ? `还没有${noun}` : "本地服务暂不可用"}</strong><p>{online ? `创建一个${noun}后，它会出现在这里。` : `连接服务后，${noun}会自动加载。当前不会假装执行任何操作。`}</p></div></div>;
}
