import { useEffect, useMemo, useRef, useState } from "react";
import type { ViewId } from "../lib/types";
import { Icon, type IconName } from "./Icon";

interface CommandItem {
  id: string;
  label: string;
  hint: string;
  icon: IconName;
  view?: ViewId;
  action?: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (view: ViewId) => void;
  onNewTask: () => void;
  onToggleTheme: () => void;
}

export function CommandPalette({ open, onClose, onNavigate, onNewTask, onToggleTheme }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const commands = useMemo<CommandItem[]>(() => [
    { id: "today", label: "打开今天", hint: "查看任务时间线", icon: "calendar", view: "today" },
    { id: "projects", label: "打开项目", hint: "管理工作区", icon: "folder", view: "projects" },
    { id: "tasks", label: "查看任务", hint: "追踪待办与运行", icon: "check", view: "tasks" },
    { id: "knowledge", label: "打开知识库", hint: "Web / Research / Memory", icon: "book", view: "knowledge" },
    { id: "automation", label: "打开自动化", hint: "管理后台运行", icon: "automation", view: "automation" },
    { id: "settings", label: "打开设置", hint: "模型、连接器与安全", icon: "settings", view: "settings" },
    { id: "new-task", label: "新建任务", hint: "创建一个可验证的运行", icon: "plus", action: onNewTask },
    { id: "theme", label: "切换主题", hint: "亮色 / 暗色", icon: "sun", action: onToggleTheme },
  ], [onNewTask, onToggleTheme]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return commands;
    return commands.filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(normalized));
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowDown") { event.preventDefault(); setSelected((value) => Math.min(value + 1, Math.max(0, filtered.length - 1))); }
      if (event.key === "ArrowUp") { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)); }
      if (event.key === "Enter") {
        event.preventDefault();
        const command = filtered[selected];
        if (!command) return;
        onClose();
        if (command.view) onNavigate(command.view); else command.action?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filtered, filtered.length, onClose, onNavigate, open, selected]);

  if (!open) return null;
  return (
    <div aria-label="命令面板" aria-modal="true" className="command-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="dialog">
      <div className="command-dialog">
        <div className="command-search-row"><Icon name="search" size={18} /><input aria-label="搜索命令" onChange={(event) => { setQuery(event.target.value); setSelected(0); }} placeholder="输入命令或页面…" ref={inputRef} value={query} /><kbd>Esc</kbd></div>
        <div aria-label="命令列表" className="command-list" role="listbox">
          {filtered.length ? filtered.map((command, index) => (
            <button aria-selected={selected === index} className={`command-row ${selected === index ? "is-selected" : ""}`} key={command.id} onClick={() => { onClose(); if (command.view) onNavigate(command.view); else command.action?.(); }} onMouseEnter={() => setSelected(index)} role="option" type="button">
              <span className="command-icon"><Icon name={command.icon} size={17} /></span><span className="command-copy"><strong>{command.label}</strong><small>{command.hint}</small></span>{command.view ? <span className="command-enter">↵</span> : null}
            </button>
          )) : <p className="command-empty">没有匹配的命令</p>}
        </div>
        <div className="command-hint"><span><kbd>↑↓</kbd>选择</span><span><kbd>Enter</kbd>执行</span><span><kbd>Esc</kbd>关闭</span></div>
      </div>
    </div>
  );
}
