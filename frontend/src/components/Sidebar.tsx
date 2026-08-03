import type { ReactNode } from "react";
import type { Project, ViewId } from "../lib/types";
import { Icon, type IconName } from "./Icon";

interface SidebarProps {
  view: ViewId;
  open: boolean;
  projects: Project[];
  onViewChange: (view: ViewId) => void;
  onProjectSelect: (projectId: string) => void;
  onClose: () => void;
  onCommandPalette: () => void;
  onToggleTheme: () => void;
  dark: boolean;
}
const primaryItems: Array<{ id: ViewId; label: string; hint: string; icon: IconName }> = [
  { id: "today", label: "今天", hint: "Today", icon: "calendar" },
  { id: "projects", label: "项目", hint: "Projects", icon: "folder" },
  { id: "tasks", label: "任务", hint: "Tasks", icon: "check" },
  { id: "knowledge", label: "知识库", hint: "Knowledge", icon: "book" },
  { id: "automation", label: "自动化", hint: "Automation", icon: "automation" },
  { id: "settings", label: "设置", hint: "Settings", icon: "settings" },
];

function NavButton({ active, icon, label, hint, onClick, trailing }: { active: boolean; icon: IconName; label: string; hint: string; onClick: () => void; trailing?: ReactNode }) {
  return (
    <button aria-current={active ? "page" : undefined} className={`nav-item ${active ? "is-active" : ""}`} onClick={onClick} type="button">
      <span className="nav-item-icon"><Icon name={icon} size={18} /></span>
      <span className="nav-item-copy"><span>{label}</span><small>{hint}</small></span>
      {trailing}
    </button>
  );
}

export function Sidebar({ view, open, projects, onViewChange, onProjectSelect, onClose, onCommandPalette, onToggleTheme, dark }: SidebarProps) {
  const navigate = (next: ViewId) => {
    onViewChange(next);
    onClose();
  };
  return (
    <aside aria-label="主导航" className={`sidebar ${open ? "is-open" : ""}`}>
      <div className="sidebar-brand">
        <button aria-label="打开今天" className="brand-lockup" onClick={() => navigate("today")} type="button">
          <span className="brand-mark"><Icon name="spark" size={19} /></span>
          <span><strong>静谧任务台</strong><small>Local workbench</small></span>
        </button>
        <button aria-label="关闭导航" className="icon-button mobile-only" onClick={onClose} type="button"><Icon name="close" /></button>
      </div>

      <div className="sidebar-actions">
        <button className="command-trigger" onClick={onCommandPalette} type="button">
          <span><Icon name="search" size={16} />快速查找</span><kbd>Ctrl K</kbd>
        </button>
      </div>

      <nav className="primary-nav">
        <p className="nav-section-label">工作台</p>
        {primaryItems.map((item) => (
          <NavButton key={item.id} active={view === item.id} icon={item.icon} label={item.label} hint={item.hint} onClick={() => navigate(item.id)} />
        ))}
      </nav>

      <div className="sidebar-projects">
        <div className="sidebar-section-heading"><span>最近项目</span><button aria-label="新建项目" className="icon-button tiny" onClick={() => navigate("projects")} type="button"><Icon name="plus" size={15} /></button></div>
        {projects.length ? projects.slice(0, 4).map((project) => (
          <button className="project-link" key={project.id} onClick={() => { onProjectSelect(project.id); navigate("projects"); }} type="button">
            <span className="project-dot" style={{ background: project.color || "var(--accent)" }} />
            <span className="truncate">{project.name}</span>
          </button>
        )) : <p className="sidebar-empty">服务连接后会显示项目</p>}
      </div>

      <div className="sidebar-footer">
        <button aria-label={dark ? "切换亮色主题" : "切换暗色主题"} className="footer-control" onClick={onToggleTheme} type="button"><Icon name={dark ? "sun" : "moon"} size={16} /><span>{dark ? "亮色主题" : "暗色主题"}</span></button>
        <div className="local-status"><span className="status-dot" /> <span>本地模式</span></div>
      </div>
    </aside>
  );
}
