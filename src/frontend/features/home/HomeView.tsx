import { useEffect, useMemo, useState } from 'react';
import { gateway, type ActivityDay, type AppMode } from '../../api';
import { guard, openSession, setDraft } from '../../app/actions';
import { useApp } from '../../app/store';
import { Heatmap, Sparkline } from '../../components/charts';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, Segmented, Skeleton, spotlight, StatusDot } from '../../components/ui';
import { compactNumber, greeting, relativeTime } from '../../lib/format';
import { modeMeta, sessionStatus } from '../../lib/status';
import { Composer } from '../session/Composer';
import { CoordinationHint } from '../panel/CoordinationPanel';

const suggestions: Record<AppMode, { icon: IconName; title: string; prompt: string }[]> = {
  chat: [
    { icon: 'sparkles', title: '解释一个概念', prompt: '用直观的方式解释 CRDT 与 OT 的区别，并给出适用场景。' },
    { icon: 'pencil', title: '润色一段文字', prompt: '帮我把下面这段话改得更简洁专业：' },
    { icon: 'globe', title: '联网检索', prompt: '搜索最新的 Electron 安全最佳实践并总结要点。' },
    { icon: 'brain', title: '做一个决策', prompt: '我在 SQLite 与 PostgreSQL 之间犹豫，帮我按单机桌面应用的场景做取舍。' },
  ],
  cowork: [
    { icon: 'target', title: '迁移一个模块', prompt: '把审批流迁移到 effect outbox：先落盘意图再发送，崩溃后对账未知效果。' },
    { icon: 'listChecks', title: '整理研究结论', prompt: '整理 reports 目录下关于长期记忆的结论，输出一份带来源的综述。' },
    { icon: 'shieldCheck', title: '全面回归验收', prompt: '运行整套回归并汇总失败项，逐项给出根因假设与验证计划。' },
    { icon: 'clock', title: '长期值守任务', prompt: '每完成一个阶段就创建检查点，持续推进直到所有验收项通过。' },
  ],
  code: [
    { icon: 'alert', title: '修一个 Bug', prompt: '修复 read_history 第 2 页随全库新增文档漂移的问题，并补回归测试。' },
    { icon: 'wrench', title: '重构函数', prompt: '把 src/harness/chat.ts 里过长的 send 函数拆成职责清晰的小函数。' },
    { icon: 'terminal', title: '跑测试并修复', prompt: '运行 npm test，修复失败用例。' },
    { icon: 'eye', title: '代码审查', prompt: '审查当前分支相对 master 的改动，指出正确性与可读性问题。' },
  ],
};

function useActivity() {
  const [days, setDays] = useState<ActivityDay[]>();
  useEffect(() => { void guard('读取活动记录失败', () => gateway.metrics.activity(140)).then(result => setDays(result ?? [])); }, []);
  return days;
}

export function HomeView() {
  const projectId = useApp(state => state.projectId);
  const mode = useApp(s => s.mode), sessions = useApp(s => s.sessions), approvals = useApp(s => s.approvals);
  const activity = useActivity();
  const [metric, setMetric] = useState<'events' | 'modelCalls' | 'toolEffects'>('events');
  const meta = modeMeta[mode];
  const recent = useMemo(() => Object.values(sessions).filter(s => s.mode === mode).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6), [sessions, mode]);
  const live = useMemo(() => Object.values(sessions).filter(s => sessionStatus[s.status].live), [sessions]);
  const week = activity?.slice(-7) ?? [];

  return (
    <div className="home">
      <div className="home__inner">
        <section className="hero">
          <div className="hero__orb" aria-hidden="true"><span /><span /><span /></div>
          <h1 className="hero__title">{greeting()}，想{mode === 'chat' ? '聊点什么' : mode === 'cowork' ? '推进哪个长任务' : '改哪段代码'}？</h1>
          <p className="hero__sub"><Icon name={meta.icon} size={15} />{meta.label} · {meta.tagline}</p>
          <Composer variant="hero" />
          <CoordinationHint projectId={projectId} />
          <div className="suggestions stagger" key={mode}>
            {suggestions[mode].map(item => (
              <button key={item.title} type="button" className="suggestion spotlight" onMouseMove={spotlight} onClick={() => setDraft(`new:${mode}`, item.prompt)}>
                <span className="suggestion__icon"><Icon name={item.icon} size={16} /></span>
                <span className="suggestion__title">{item.title}</span>
                <span className="suggestion__prompt">{item.prompt}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="home__grid">
          <div className="card card--heat spotlight" onMouseMove={spotlight}>
            <div className="card__head">
              <span className="card__title"><Icon name="activity" size={15} />活动</span>
              <span className="grow" />
              <Segmented size="sm" value={metric} onChange={setMetric} options={[{ value: 'events', label: '事件' }, { value: 'modelCalls', label: '模型' }, { value: 'toolEffects', label: '工具' }]} />
            </div>
            {!activity ? <Skeleton lines={5} /> : activity.every(d => d.events === 0) ? <EmptyState icon="activity" title="还没有活动记录" detail="开始对话或任务后，这里会按天显示真实的运行记录。" /> : <Heatmap days={activity} metric={metric} />}
          </div>

          <div className="stat-stack">
            <div className="stat spotlight" onMouseMove={spotlight}>
              <span className="stat__label"><StatusDot tone="accent" pulse={live.length > 0} />运行中</span>
              <strong className="stat__value num">{live.length}</strong>
              <span className="stat__hint">{live.length ? live.map(s => s.title).slice(0, 2).join('、') : '没有正在运行的会话'}</span>
            </div>
            <div className="stat spotlight" onMouseMove={spotlight}>
              <span className="stat__label"><Icon name="shieldAlert" size={13} />待审批</span>
              <strong className="stat__value num">{Object.keys(approvals).length}</strong>
              <span className="stat__hint">{Object.keys(approvals).length ? '有操作在等你决定' : '一切顺畅'}</span>
            </div>
            <div className="stat spotlight" onMouseMove={spotlight}>
              <span className="stat__label"><Icon name="cpu" size={13} />近 7 天模型调用</span>
              <strong className="stat__value num">{compactNumber(week.reduce((n, d) => n + d.modelCalls, 0))}</strong>
              <Sparkline values={week.map(d => d.modelCalls)} />
            </div>
          </div>
        </section>

        <section className="home__recent">
          <div className="section-title">最近{meta.noun}</div>
          {recent.length === 0 ? <div className="muted">还没有{meta.noun}。</div> : (
            <div className="recent-grid stagger">
              {recent.map(session => {
                const status = sessionStatus[session.status];
                return (
                  <button key={session.id} type="button" className="recent-card spotlight" onMouseMove={spotlight} onClick={() => void openSession(session.id)}>
                    <span className="recent-card__top"><StatusDot tone={status.tone} pulse={status.live} /><span className="muted">{status.label}</span><span className="grow" /><span className="muted">{relativeTime(session.updatedAt)}</span></span>
                    <span className="recent-card__title">{session.title}</span>
                    <span className="recent-card__preview">{session.preview ?? '—'}</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
