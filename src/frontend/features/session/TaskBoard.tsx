import { useState } from 'react';
import type { TaskDetail } from '../../api';
import { controlTask } from '../../app/actions';
import { Ring } from '../../components/charts';
import { Icon } from '../../components/Icon';
import { Badge, Button, IconButton } from '../../components/ui';
import { compactNumber, relativeTime } from '../../lib/format';
import { taskStatus } from '../../lib/status';

const stepIcon = { done: 'circleCheck', active: 'activity', todo: 'clock', blocked: 'lock', skipped: 'x' } as const;
const verdictIcon = { pass: 'circleCheck', fail: 'circleX', pending: 'clock', unknown: 'alert' } as const;

export function TaskBoard({ task, pausing = false, office = false }: { task: TaskDetail; pausing?: boolean; office?: boolean }) {
  const [open, setOpen] = useState(false);
  const status = taskStatus[task.status];
  const done = task.plan.filter(step => step.status === 'done').length;
  const live = ['running', 'waiting_approval', 'reconciling', 'waiting_children'].includes(task.status);
  const terminal = ['completed', 'cancelled'].includes(task.status);
  const canResume = task.status === 'paused' || task.status === 'waiting_input' || task.status === 'failed';
  const pausePending = pausing && !canResume && !terminal;
  return (
    <section className={`taskboard taskboard--${status.tone}${open ? ' is-open' : ''}`}>
      <div className="taskboard__bar">
        <span className={`task-orb task-orb--${status.tone}`} data-live={live}><span /></span>
        <div className="taskboard__title">
          <div className="row"><strong className="truncate" title={task.title}>{task.title}</strong><Badge tone={status.tone === 'idle' ? 'neutral' : status.tone === 'accent' ? 'accent' : status.tone} pulse={live}>{status.label}</Badge></div>
          <div className="taskboard__phase"><span role="status">{pausePending ? '正在暂停…' : ''}</span>{!pausePending && <>{task.phase}{task.waitingReason ? ` · ${task.waitingReason}` : ''}{task.retryAt ? ` · ${relativeTime(task.retryAt)}重试` : ''}</>}</div>
        </div>
        <div className="plan-track" title={`计划 ${done}/${task.plan.length}`}>
          {task.plan.map(step => <span key={step.id} className={`plan-track__seg is-${step.status}`} />)}
        </div>
        <span className="taskboard__count num">{done}/{task.plan.length}</span>
        <div className="taskboard__controls">
          {task.executionPhase === 'awaiting_plan_confirmation' && task.planReference && <Button size="sm" icon="play" onClick={() => void controlTask(task.id, 'approve_plan', { expectedRevision: task.revision, plan: task.planReference })}>确认计划</Button>}
          {canResume
            ? <IconButton icon="play" label="继续" disabled={terminal || task.executionPhase === 'awaiting_plan_confirmation'} onClick={() => void controlTask(task.id, task.status === 'failed' ? 'retry' : 'resume')} />
            : <IconButton icon="pause" label={pausePending ? '正在暂停' : '暂停'} aria-busy={pausePending || undefined} aria-disabled={pausePending || undefined} disabled={terminal} onClick={() => { if (!pausePending) void controlTask(task.id, 'pause'); }} />}
          {!office && <IconButton icon="bookmark" label="创建检查点" onClick={() => void controlTask(task.id, 'checkpoint')} />}
          <IconButton icon="listChecks" label="重新规划" disabled={terminal || task.executionPhase === 'planning'} onClick={() => void controlTask(task.id, 'enter_plan')} />
          <IconButton icon="stop" label="终止任务" disabled={terminal} onClick={() => void controlTask(task.id, 'cancel')} />
          {!office && <IconButton icon={open ? 'chevronDown' : 'chevronRight'} label={open ? '收起' : '展开任务详情'} onClick={() => setOpen(!open)} />}
        </div>
      </div>
      {open && (
        <div className="taskboard__grid">
          <div className="tb-card tb-card--goal">
            <div className="tb-card__title"><Icon name="target" size={14} />目标契约<Badge>{task.goal.mode === 'autonomous' ? '自主' : '协作'}</Badge></div>
            <p className="tb-goal">{task.goal.objective}</p>
            <div className="tb-columns">
              <div><div className="tb-sub">约束</div><ul>{task.goal.constraints.map(item => <li key={item}>{item}</li>)}</ul></div>
              <div><div className="tb-sub">验收</div><ul>{task.goal.acceptance.map(item => <li key={item}>{item}</li>)}</ul></div>
            </div>
          </div>
          <div className="tb-card">
            <div className="tb-card__title"><Icon name="listChecks" size={14} />计划</div>
            <ol className="stepper">
              {task.plan.map(step => (
                <li key={step.id} className={`stepper__step is-${step.status}`}>
                  <span className="stepper__icon"><Icon name={stepIcon[step.status]} size={14} /></span>
                  <span className="stepper__text">{step.title}{step.detail && <span className="muted">{step.detail}</span>}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="tb-card">
            <div className="tb-card__title"><Icon name="gauge" size={14} />预算</div>
            <div className="budget">
              <div className="budget__item"><Ring value={task.budget.modelCalls / task.budget.maxModelCalls} size={58} stroke={6} label={String(task.budget.modelCalls)} /><span>模型调用<br /><span className="muted num">上限 {task.budget.maxModelCalls}</span></span></div>
              <div className="budget__item"><Ring value={task.budget.toolCalls / task.budget.maxToolCalls} size={58} stroke={6} tone="ok" label={String(task.budget.toolCalls)} /><span>工具调用<br /><span className="muted num">上限 {task.budget.maxToolCalls}</span></span></div>
              <div className="budget__item budget__item--tokens"><strong className="num">{compactNumber(task.budget.tokens)}</strong><span>累计 tokens</span></div>
            </div>
          </div>
          <div className="tb-card">
            <div className="tb-card__title"><Icon name="bot" size={14} />子代理</div>
            {task.subagents.length === 0 ? <div className="muted tb-empty">没有派生子代理</div> : task.subagents.map(agent => (
              <div key={agent.id} className="subagent">
                <span className={`subagent__role subagent__role--${agent.role}`}>{({ worker: '执行', reviewer: '审查', side: '侧聊' })[agent.role]}</span>
                <span className="grow truncate">{agent.title}</span>
                <span className="muted">{taskStatus[agent.status].label}</span>
                <span className="subagent__bar"><span style={{ width: `${(agent.progress ?? 0) * 100}%` }} /></span>
              </div>
            ))}
          </div>
          <div className="tb-card">
            <div className="tb-card__title"><Icon name="bookmark" size={14} />检查点</div>
            {task.checkpoints.length === 0 ? <div className="muted tb-empty">尚无检查点</div> : (
              <div className="checkpoints">{task.checkpoints.map(cp => <div key={cp.id} className="checkpoint"><span className="checkpoint__dot" /><span className="grow">{cp.label}</span><span className="mono muted">{cp.digest}</span><span className="muted">{relativeTime(cp.createdAt)}</span></div>)}</div>
            )}
          </div>
          <div className="tb-card">
            <div className="tb-card__title"><Icon name="shieldCheck" size={14} />独立验收<Badge tone={task.verification.status === 'pass' ? 'ok' : task.verification.status === 'fail' ? 'danger' : 'neutral'}>{({ pass: '通过', fail: '未通过', pending: '待验收', unknown: '未知' })[task.verification.status]}</Badge></div>
            {task.verification.items.map(item => <div key={item.label} className={`verdict verdict--${item.status}`}><Icon name={verdictIcon[item.status]} size={14} />{item.label}</div>)}
            {task.status === 'waiting_input' && task.executionPhase !== 'awaiting_plan_confirmation' && <Button size="sm" variant="secondary" icon="play" onClick={() => void controlTask(task.id, 'resume')}>提供指示后继续</Button>}
          </div>
        </div>
      )}
    </section>
  );
}
