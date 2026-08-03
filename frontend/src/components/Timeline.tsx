import { useState } from "react";
import type { Run, TimelineEvent, WorkTask } from "../lib/types";
import { formatRelativeTime, formatTokens, statusLabel } from "../lib/utils";
import { Icon, type IconName } from "./Icon";

interface TimelineProps {
  events: TimelineEvent[];
  tasks: WorkTask[];
  runs: Run[];
  online: boolean;
  onNewTask: (title: string) => void;
  onRefresh: () => void;
}
const eventIcons: Record<TimelineEvent["type"], IconName> = {
  message: "spark",
  plan: "check",
  tool: "terminal",
  approval: "shield",
  diff: "code",
  test: "checkCircle",
  checkpoint: "refresh",
  error: "alert",
  commit: "git",
  artifact: "folder",
};

function EventRow({ event }: { event: TimelineEvent }) {
  return (
    <article className={`timeline-event event-${event.type} event-${event.status || "pending"}`}>
      <div className="timeline-rail"><span className="timeline-icon"><Icon name={eventIcons[event.type] || "dot"} size={16} /></span></div>
      <div className="timeline-event-body">
        <div className="timeline-event-top"><strong>{event.title}</strong><time>{formatRelativeTime(event.timestamp)}</time></div>
        {event.detail ? <p>{event.detail}</p> : null}
        <div className="timeline-event-meta"><span>{event.actor === "user" ? "你" : event.actor === "agent" ? "Agent" : "系统"}</span>{event.meta ? <span>{event.meta}</span> : null}{event.status === "running" ? <span className="event-live"><Icon name="loader" size={13} />处理中</span> : null}</div>
      </div>
    </article>
  );
}

export function Timeline({ events, tasks, runs, online, onNewTask, onRefresh }: TimelineProps) {
  const [draft, setDraft] = useState("");
  const activeRun = runs.find((run) => ["running", "waiting_approval", "reconciling"].includes(run.status));
  const activeTask = activeRun ? tasks.find((task) => task.id === activeRun.taskId) : tasks.find((task) => task.status === "in_progress");
  const submit = () => {
    const title = draft.trim();
    if (!title) return;
    onNewTask(title);
    setDraft("");
  };
  return (
    <section aria-labelledby="timeline-title" className="timeline-panel">
      <header className="content-heading timeline-heading">
        <div><p className="eyebrow">{online ? "本地服务已连接" : "本地安全模式"}</p><h1 id="timeline-title">今天</h1><p className="heading-subtitle">把下一步做小，保持每一个结果都可追溯。</p></div>
        <div className="heading-actions"><span className={`connection-pill ${online ? "is-online" : "is-offline"}`}><span className="status-dot" />{online ? "已连接" : "未连接"}</span><button aria-label="刷新时间线" className="icon-button" onClick={onRefresh} type="button"><Icon name="refresh" size={17} /></button></div>
      </header>

      <div className="today-summary">
        <div className="summary-copy"><span className="summary-label">当前焦点</span><strong>{activeTask?.title || "准备一个清晰的下一步"}</strong><small>{activeRun ? `${activeRun.model || "默认模型"} · ${statusLabel(activeRun.status)}` : "从一个任务开始，运行状态会显示在这里"}</small></div>
        <div className="summary-metrics"><span><strong>{tasks.filter((task) => task.status === "done" || task.status === "completed").length}</strong><small>已完成</small></span><span><strong>{runs.length}</strong><small>运行</small></span><span><strong>{formatTokens(activeRun?.tokens?.total)}</strong><small>tokens</small></span></div>
      </div>

      <div className="timeline-toolbar"><span className="timeline-label">活动时间线</span><span className="timeline-count">{events.length} 条记录</span></div>
      <div className="timeline-list" role="feed" aria-label="任务活动时间线">
        {events.length ? events.map((event) => <EventRow event={event} key={event.id} />) : <div className="timeline-empty"><Icon name="clock" size={22} /><p>还没有活动记录</p><small>创建任务后，计划、工具和检查点会出现在这里。</small></div>}
      </div>

      <div className="quick-task-card">
        <div className="quick-task-icon"><Icon name="plus" size={18} /></div>
        <div className="quick-task-main"><label htmlFor="quick-task">接下来要做什么？</label><div className="quick-task-row"><input id="quick-task" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} placeholder="描述一个可以验证的任务…" value={draft} /><button className="primary-button" disabled={!draft.trim()} onClick={submit} type="button"><Icon name="arrow" size={16} />开始</button></div><small>任务会先进入排队状态，高风险动作仍需你的确认。</small></div>
      </div>
    </section>
  );
}
