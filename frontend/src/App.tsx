import { useCallback, useEffect, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { Icon } from "./components/Icon";
import { Sidebar } from "./components/Sidebar";
import { Timeline } from "./components/Timeline";
import { VistaInspector } from "./components/VistaInspector";
import { WorkbenchViews } from "./components/WorkbenchViews";
import { useWorkbench } from "./lib/useWorkbench";
import type { Theme } from "./lib/types";

export function App() {
  const workbench = useWorkbench();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "light";
    const saved = window.localStorage.getItem("workbench-theme");
    return saved === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("workbench-theme", theme);
  }, [theme]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const toggleTheme = useCallback(() => setTheme((value) => value === "light" ? "dark" : "light"), []);
  const openView = useCallback((next: Parameters<typeof workbench.setView>[0]) => { workbench.setView(next); setMobileNavOpen(false); }, [workbench]);
  const newTask = useCallback((title?: string) => { if (title === undefined) { openView("tasks"); workbench.setToast("在任务页输入一个新任务"); } else void workbench.createTask(title); }, [openView, workbench]);

  return <div className="app-root" data-online={workbench.online ? "true" : "false"}>
    <Sidebar dark={theme === "dark"} onClose={() => setMobileNavOpen(false)} onCommandPalette={() => setCommandOpen(true)} onProjectSelect={workbench.setSelectedProjectId} onToggleTheme={toggleTheme} onViewChange={openView} open={mobileNavOpen} projects={workbench.projects} view={workbench.view} />
    {mobileNavOpen ? <button aria-label="关闭导航" className="sidebar-scrim" onClick={() => setMobileNavOpen(false)} type="button" /> : null}
    <main className="app-main">
      <div className="mobile-topbar"><button aria-label="打开导航" className="icon-button" onClick={() => setMobileNavOpen(true)} type="button"><Icon name="menu" /></button><span className="mobile-title"><img alt="" aria-hidden="true" src="/npa-mark.png" />NPA</span><button aria-label="打开命令面板" className="icon-button" onClick={() => setCommandOpen(true)} type="button"><Icon name="search" /></button></div>
      <div className="main-grid">
        {workbench.view === "today" ? <Timeline events={workbench.timeline} onNewTask={workbench.createTask} onRefresh={() => void workbench.refresh()} online={workbench.online} runs={workbench.runs} tasks={workbench.tasks} /> : <WorkbenchViews knowledgeTab={workbench.knowledgeTab} notify={workbench.setToast} onKnowledgeTab={workbench.setKnowledgeTab} onNewTask={newTask} onProjectSelect={workbench.setSelectedProjectId} onRunAction={workbench.runAction} onSettingsTab={workbench.setSettingsTab} onStartRun={workbench.startTaskRun} onViewRun={workbench.viewRun} onWorkspaceTab={workbench.setWorkspaceTab} online={workbench.online} projects={workbench.projects} runs={workbench.runs} selectedProjectId={workbench.selectedProjectId} settings={workbench.settings} settingsTab={workbench.settingsTab} tasks={workbench.tasks} view={workbench.view} workspaceTab={workbench.workspaceTab} />}
      <VistaInspector onApproval={workbench.resolveApproval} onArchive={workbench.archiveBlock} onPinToggle={workbench.pinToggle} onRecover={workbench.recoverBlock} onRestoreRange={workbench.restoreBlockRange} vista={workbench.vista} />
      </div>
      {workbench.error ? <div aria-live="polite" className="offline-banner"><Icon name="refresh" size={15} /><span>{workbench.error}</span><button onClick={() => void workbench.refresh()} type="button">重试</button></div> : null}
    </main>
    {workbench.toast ? <div aria-live="polite" className="toast-message"><Icon name={workbench.online ? "checkCircle" : "alert"} size={16} /><span>{workbench.toast}</span></div> : null}
    <CommandPalette onClose={() => setCommandOpen(false)} onNavigate={openView} onNewTask={() => newTask()} onToggleTheme={toggleTheme} open={commandOpen} />
  </div>;
}

export default App;
