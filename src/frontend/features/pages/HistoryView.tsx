import { useMemo, useState } from 'react';
import type { AppMode, SessionStatus } from '../../api';
import { loadOlderHistory, openSession, removeSession, showRecentHistory, updateSession } from '../../app/actions';
import { useApp } from '../../app/store';
import { Icon } from '../../components/Icon';
import { Button, EmptyState, IconButton, StatusDot } from '../../components/ui';
import { dateGroup, relativeTime, type DateGroup } from '../../lib/format';
import { fuzzy } from '../../lib/fuzzy';
import { modeMeta, sessionStatus } from '../../lib/status';

const groups: DateGroup[] = ['今天', '昨天', '本周', '本月', '更早'];

export function HistoryView() {
  const sessions = useApp(s => s.sessions);
  const recentCursor = useApp(s => s.historyNextCursor), page = useApp(s => s.historyPage);
  const nextCursor = page?.items ? page.nextCursor : recentCursor;
  const [query, setQuery] = useState('');
  const [modes, setModes] = useState<Set<AppMode>>(new Set());
  const [status, setStatus] = useState<SessionStatus | 'all'>('all');

  const grouped = useMemo(() => {
    const rows = page?.items?.map(item => {
      const live = sessions[item.id];
      return live && live.updatedAt >= item.updatedAt ? live : item;
    }) ?? Object.values(sessions);
    const list = rows
      .filter(s => !modes.size || modes.has(s.mode))
      .filter(s => status === 'all' || s.status === status)
      .map(s => ({ s, match: fuzzy(query, `${s.title} ${s.preview ?? ''}`) }))
      .filter(r => r.match)
      .sort((a, b) => (query ? b.match!.score - a.match!.score : b.s.updatedAt.localeCompare(a.s.updatedAt)))
      .map(r => r.s);
    const map = new Map<DateGroup, typeof list>();
    for (const item of list) { const g = dateGroup(item.updatedAt); map.set(g, [...(map.get(g) ?? []), item]); }
    return groups.filter(g => map.has(g)).map(g => ({ group: g, items: map.get(g)! }));
  }, [sessions, page?.items, query, modes, status]);

  const toggleMode = (mode: AppMode) => setModes(current => { const next = new Set(current); if (next.has(mode)) next.delete(mode); else next.add(mode); return next; });

  return (
    <div className="page">
      <div className="page__head"><div><h2>历史</h2><p className="muted">{page?.items ? '更早的会话' : '最近会话'} · 在当前页模糊搜索标题与摘要。</p></div></div>
      <div className="history-tools">
        <label className="search-field search-field--lg"><Icon name="search" size={15} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索标题与摘要…" /></label>
        <div className="chips">
          {(Object.keys(modeMeta) as AppMode[]).map(mode => <button key={mode} type="button" className={`chip${modes.has(mode) ? ' is-on' : ''}`} onClick={() => toggleMode(mode)}><Icon name={modeMeta[mode].icon} size={12} />{modeMeta[mode].label}</button>)}
          <span className="chips__sep" />
          {(['all', 'completed', 'waiting_approval', 'waiting_input', 'failed'] as const).map(value => <button key={value} type="button" className={`chip${status === value ? ' is-on' : ''}`} onClick={() => setStatus(value)}>{value === 'all' ? '全部状态' : sessionStatus[value].label}</button>)}
        </div>
        {(page || nextCursor) && <div className="row gap-2" aria-busy={Boolean(page?.pending)}>
          {page && <Button size="sm" onClick={showRecentHistory}>返回最近会话</Button>}
          {nextCursor && <Button size="sm" disabled={Boolean(page?.pending)} onClick={() => void loadOlderHistory()}>{page?.pending ? '正在读取…' : page?.error ? '重试下一页' : '下一页会话'}</Button>}
          {page?.error && <span role="alert">读取历史失败：{page.error}</span>}
        </div>}
      </div>
      {grouped.length === 0 ? <EmptyState icon="search" title="没有匹配的会话" detail="换个关键词或清除筛选条件试试。" /> : grouped.map(({ group, items }) => (
        <section key={group} className="history-group">
          <div className="section-title">{group}<span className="muted num"> {items.length}</span></div>
          <div className="history-list stagger">
            {items.map(item => {
              const st = sessionStatus[item.status];
              return (
                <div key={item.id} className="history-row" onClick={() => void openSession(item.id)}>
                  <span className={`history-row__mode history-row__mode--${item.mode}`}><Icon name={modeMeta[item.mode].icon} size={14} /></span>
                  <button type="button" className="grow history-row__open" aria-label={`打开会话 ${item.title}`}><span className="history-row__title">{item.pinned && <Icon name="pin" size={12} className="muted" />}{item.title}</span><span className="history-row__preview truncate">{item.preview ?? '—'}</span></button>
                  <span className="history-row__status"><StatusDot tone={st.tone} pulse={st.live} />{st.label}</span>
                  <span className="muted history-row__time">{relativeTime(item.updatedAt)}</span>
                  <span className="history-row__actions" onClick={event => event.stopPropagation()}>
                    <IconButton icon="pin" label={item.pinned ? '取消置顶' : '置顶'} size={14} onClick={() => void updateSession(item.id, { pinned: !item.pinned })} />
                    <IconButton icon="trash" label="删除" size={14} onClick={() => void removeSession(item.id)} />
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
