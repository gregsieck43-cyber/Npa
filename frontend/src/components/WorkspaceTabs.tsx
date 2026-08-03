import type { KnowledgeTab, SettingsTab, WorkspaceTab } from "../lib/types";
import { Icon, type IconName } from "./Icon";

const workspaceTabs: Array<{ id: WorkspaceTab; icon: IconName; hint: string }> = [
  { id: "Data", icon: "database", hint: "数据" },
  { id: "Canvas", icon: "canvas", hint: "画布" },
  { id: "Code", icon: "code", hint: "代码" },
  { id: "Terminal", icon: "terminal", hint: "终端" },
  { id: "Git", icon: "git", hint: "版本" },
];

const knowledgeTabs: Array<{ id: KnowledgeTab; icon: IconName; hint: string }> = [
  { id: "Web", icon: "globe", hint: "网页" },
  { id: "Research", icon: "research", hint: "研究" },
  { id: "Memory", icon: "memory", hint: "记忆" },
];

const settingsTabs: Array<{ id: SettingsTab; icon: IconName; hint: string }> = [
  { id: "模型", icon: "spark", hint: "Models" },
  { id: "连接器", icon: "bolt", hint: "Connectors" },
  { id: "安全", icon: "shield", hint: "Security" },
  { id: "诊断", icon: "activity", hint: "Diagnostics" },
];

interface WorkspaceTabsProps {
  kind: "workspace" | "knowledge" | "settings";
  active: WorkspaceTab | KnowledgeTab | SettingsTab;
  onChange: (value: WorkspaceTab | KnowledgeTab | SettingsTab) => void;
}
export function WorkspaceTabs({ kind, active, onChange }: WorkspaceTabsProps) {
  const tabs = kind === "workspace" ? workspaceTabs : kind === "knowledge" ? knowledgeTabs : settingsTabs;
  return <div aria-label={kind === "workspace" ? "项目工作区" : kind === "knowledge" ? "知识区" : "设置区"} className="workspace-tabs" role="tablist">{tabs.map((tab) => <button aria-selected={active === tab.id} className={`workspace-tab ${active === tab.id ? "is-active" : ""}`} key={tab.id} onClick={() => onChange(tab.id)} role="tab" type="button"><Icon name={tab.icon} size={16} /><span>{tab.id}</span><small>{tab.hint}</small></button>)}</div>;
}
