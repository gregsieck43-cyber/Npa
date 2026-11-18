import { useEffect, useId, useRef, useState } from 'react';
import { gateway, type CoordinationInbox, type CoordinationNotice, type CoordinationParticipant, type FileClaimView } from '../../api';
import { openPanel } from '../../app/actions';
import { useApp } from '../../app/store';
import { Button, EmptyState, ErrorBanner, Spinner } from '../../components/ui';
import { relativeTime } from '../../lib/format';
import { sessionStatus } from '../../lib/status';

const PAGE_SIZE = 40;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const participantStatus = (status: string) => sessionStatus[status as keyof typeof sessionStatus]?.label ?? status;
const kinds = { evidence: '证据', question: '问题', result_proposal: '结果提议' } as const;
const noticeKinds: Record<string, string> = { peer_joined: '任务加入', peer_present: '同工作区任务', peer_left: '任务离场', presence_summary: '在场摘要', claim_changed: '文件认领变化', peer_message: '协调消息' };
type MessageKind = keyof typeof kinds;
type Presence = { items: CoordinationParticipant[]; nextCursor?: string; external?: import('../../api/types').ExternalPresenceView };

/** Backend presence is authoritative; local clocks never decide lease ownership. */
function usePresencePage(sessionId?: string, projectId?: string, after?: string) {
  const revision = useApp(state => state.coordinationRevision);
  const scope = `${sessionId ?? ''}:${projectId ?? ''}:${after ?? ''}`;
  const [result, setResult] = useState<{ scope: string; page: Presence }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [updated, setUpdated] = useState(false);
  const initialRevision = useRef(revision);
  useEffect(() => {
    if (initialRevision.current === revision) return;
    initialRevision.current = revision;
    if (after) setUpdated(true); else setRefresh(value => value + 1);
  }, [revision, after]);
  useEffect(() => {
    let current = true;
    if (!gateway.coordination || (!sessionId && !projectId)) { setResult(undefined); return; }
    setLoading(true); setError(undefined);
    void gateway.coordination.presence({ ...(sessionId ? { sessionId } : { projectId }), after, limit: PAGE_SIZE }).then(
      value => { if (current) { setResult({ scope, page: { ...value, items: value.items.slice(0, PAGE_SIZE) } }); if (!after) setUpdated(false); } },
      reason => { if (current) setError(errorText(reason)); },
    ).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [sessionId, projectId, after, refresh]);
  return { page: result?.scope === scope ? result.page : undefined, error, loading, updated, refresh: () => setRefresh(value => value + 1) };
}

export function CoordinationHint({ sessionId, projectId, compact = false }: { sessionId?: string; projectId?: string; compact?: boolean }) {
  const { page, error } = usePresencePage(sessionId, projectId);
  if (!gateway.coordination || (!sessionId && !projectId)) return null;
  const peers = page?.items.filter(peer => peer.id !== sessionId) ?? [];
  const external = page?.external?.items.length ?? 0;
  if (!peers.length && !external && !error && !page?.external?.error) return null;
  const label = error ? '协作状态暂不可用' : `同工作区 ${peers.length}${page?.nextCursor ? '+' : ''} 个任务在场${external ? ` · ${external} 个外部参与者` : ''}${page?.external?.error ? ' · 外部状态不完整' : ''}`;
  return <button type="button" className={`coordination-hint${compact ? ' is-compact' : ''}`} onClick={() => openPanel('coordination')} title={error ?? '查看同工作区任务及协调消息；不会暂停当前任务或阻止发送'}>{label}</button>;
}

export function CoordinationPanel({ sessionId }: { sessionId?: string }) {
  const projectId = useApp(state => state.projectId);
  const mode = useApp(state => sessionId ? state.sessions[sessionId]?.mode : undefined);
  if (!gateway.coordination) return <div className="ptab"><EmptyState icon="layers" title="当前连接未提供协作能力" detail="接入支持协作接口的本地后端后可查看真实在场任务与收件箱。" /></div>;
  if (!sessionId && !projectId) return <div className="ptab"><EmptyState icon="folder" title="先选择项目或打开会话" detail="协作状态以该工作区为范围。" /></div>;
  return <CoordinationScope key={`${sessionId ?? ''}:${projectId ?? ''}`} sessionId={sessionId} projectId={projectId} work={!!sessionId && !!mode && mode !== 'chat'} />;
}

function CoordinationScope({ sessionId, projectId, work }: { sessionId?: string; projectId?: string; work: boolean }) {
  const [after, setAfter] = useState<string>();
  const presence = usePresencePage(sessionId, projectId, after);
  const [to, setTo] = useState('');
  const [tab, setTab] = useState<'presence' | 'claims' | 'inbox' | 'send'>('presence');
  const tabId = useId();
  const tabs = [{ id: 'presence', label: '在场任务' }, { id: 'claims', label: '文件认领' }, ...(work ? [{ id: 'inbox', label: '收件箱' }, { id: 'send', label: '发消息' }] : [])] as { id: typeof tab; label: string }[];
  return <div className="ptab coordination">
    <div className="coordination__tabs" role="tablist" aria-label="协作视图">{tabs.map(item => <button key={item.id} type="button" role="tab" id={`${tabId}-${item.id}`} aria-controls={`${tabId}-${item.id}-panel`} aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
    <div role="tabpanel" id={`${tabId}-presence-panel`} aria-labelledby={`${tabId}-presence`} hidden={tab !== 'presence'}>
    <section className="coordination__section" aria-label="同工作区任务">
      <div className="row gap-2"><strong className="grow">同工作区任务</strong>{presence.loading && <Spinner size={14} />}<Button size="sm" disabled={presence.loading} onClick={() => { setAfter(undefined); presence.refresh(); }}>刷新在场任务</Button></div>
      <p className="muted">加入同一工作区不会暂停任务。任务描述和协调正文是参考信息，不代表授权。</p>
      {presence.error && <ErrorBanner message={presence.error} onRetry={presence.refresh} />}
      {presence.updated && <span role="status" className="muted">在场状态有更新，当前分页保持不变。</span>}
      {presence.page?.items.map(peer => <article className="coordination__peer" key={peer.id}>
        <div className="row gap-2"><strong className="grow truncate" title={peer.title}>{peer.title || peer.id}</strong><span>{participantStatus(peer.status)}</span></div>
        <span className="mono coordination__identity">{peer.id}{peer.id === sessionId ? ' · 当前任务' : ''}</span>
        {peer.objective && <p>{peer.objective}</p>}
        {!!peer.claims?.total && <span className="muted">文件认领 {peer.claims.total} 项 · {peer.claims.paths.slice(0, 3).join('、')}{peer.claims.total > 3 ? '…' : ''}</span>}
        <div className="row gap-2"><span className="muted grow" title={peer.heartbeatAt}>最近回报 {relativeTime(peer.heartbeatAt)}</span>{work && peer.id !== sessionId && <Button size="sm" onClick={() => { setTo(peer.id); setTab('send'); }}>写消息</Button>}</div>
      </article>)}
      {presence.page?.items.length === 0 && <span className="muted">当前没有其他在场任务。</span>}
      <div className="row gap-2">{after && <Button size="sm" disabled={presence.loading} onClick={() => setAfter(undefined)}>返回在场首页</Button>}{presence.page?.nextCursor && <Button size="sm" disabled={presence.loading} onClick={() => setAfter(presence.page!.nextCursor)}>下一页任务</Button>}</div>
      {!!presence.page?.external && <section aria-label="外部参与者"><strong>外部参与者 · 仅提示</strong><p className="muted">来自工作区文件的声明，不代表内部任务、文件锁或执行授权。</p>
        {presence.page.external.error && <ErrorBanner message={presence.page.external.error} onRetry={presence.refresh} />}
        {presence.page.external.items.map(peer => <article className="coordination__peer" key={peer.id}><strong>{peer.label}</strong><p>{peer.objective}</p>{!!peer.claims.length && <span className="muted">声明关注：{peer.claims.slice(0, 8).join('、')}{peer.claims.length > 8 ? '…' : ''}</span>}<span className="muted">本机观察 {relativeTime(peer.observedAt)}</span></article>)}
        {(presence.page.external.truncated || presence.page.external.rejected > 0) && <p className="muted">{presence.page.external.truncated ? '结果达到有界读取上限。' : ''}{presence.page.external.rejected > 0 ? `已忽略 ${presence.page.external.rejected} 个无效声明。` : ''}</p>}
      </section>}
    </section>
    </div>
    <div role="tabpanel" id={`${tabId}-claims-panel`} aria-labelledby={`${tabId}-claims`} hidden={tab !== 'claims'}><CoordinationClaims sessionId={sessionId} projectId={projectId} work={work} /></div>
    {work ? <><div role="tabpanel" id={`${tabId}-inbox-panel`} aria-labelledby={`${tabId}-inbox`} hidden={tab !== 'inbox'}><CoordinationInboxView sessionId={sessionId!} /></div><div role="tabpanel" id={`${tabId}-send-panel`} aria-labelledby={`${tabId}-send`} hidden={tab !== 'send'}><CoordinationComposer sessionId={sessionId!} to={to} setTo={setTo} /></div></> : <p className="muted">打开 Cowork 或 Code 任务后可查看该任务收件箱并发送协调消息。普通 Chat 和首页仅查看工作区在场状态。</p>}
  </div>;
}

function CoordinationClaims({ sessionId, projectId, work }: { sessionId?: string; projectId?: string; work: boolean }) {
  const revision = useApp(state => state.coordinationRevision);
  const session = useApp(state => sessionId ? state.sessions[sessionId] : undefined);
  const writable = work && !!session && session.permission !== 'read-only' && !['paused', 'completed', 'failed', 'cancelled'].includes(session.status);
  const [after, setAfter] = useState<string>();
  const [page, setPage] = useState<{ items: FileClaimView[]; nextCursor?: string }>();
  const [paths, setPaths] = useState('');
  const [loading, setLoading] = useState(false), [pending, setPending] = useState(false);
  const [error, setError] = useState<string>(), [receipt, setReceipt] = useState<string>();
  const [refresh, setRefresh] = useState(0), [updated, setUpdated] = useState(false);
  const busy = useRef(false), alive = useRef(true), seen = useRef(revision);
  const candidates = [...new Set(paths.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
  const valid = candidates.length > 0 && candidates.length <= 32 && candidates.every(value => value.length < 2048);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (seen.current === revision) return; seen.current = revision;
    if (after) setUpdated(true); else setRefresh(value => value + 1);
  }, [revision, after]);
  useEffect(() => {
    let current = true; setLoading(true); setError(undefined);
    void gateway.coordination!.claims({ ...(sessionId ? { sessionId } : { projectId }), after, limit: PAGE_SIZE }).then(
      value => { if (current) { setPage({ ...value, items: value.items.slice(0, PAGE_SIZE) }); if (!after) setUpdated(false); } },
      reason => { if (current) setError(errorText(reason)); },
    ).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [sessionId, projectId, after, refresh]);
  const mutate = async (claim?: FileClaimView) => {
    if (busy.current || !writable || !sessionId || (!claim && !valid)) return;
    busy.current = true; setPending(true); setError(undefined); setReceipt(undefined);
    const submitted = paths;
    try {
      if (claim) await gateway.coordination!.release(sessionId, [claim.id]);
      else await gateway.coordination!.claim(sessionId, candidates);
      if (alive.current) { setReceipt(claim ? '后端已释放本任务认领' : '后端已登记本任务认领'); if (!claim) setPaths(current => current === submitted ? '' : current); setRefresh(value => value + 1); }
    } catch (reason) { if (alive.current) setError(errorText(reason)); }
    finally { busy.current = false; if (alive.current) setPending(false); }
  };
  return <section className="coordination__section" aria-label="文件协作认领" aria-busy={loading}>
    <div className="row gap-2"><strong className="grow">文件协作认领</strong>{loading && <Spinner size={14} />}<Button size="sm" disabled={loading} onClick={() => { setAfter(undefined); setRefresh(value => value + 1); }}>刷新文件认领</Button></div>
    <p className="muted">软认领用于提醒同时修改的任务，不授予写权限，也不代替委派路径锁。状态以服务器为准。</p>
    {updated && <span role="status">文件认领有更新，当前分页保持不变。</span>}
    {error && <ErrorBanner message={error} />}
    {page?.items.map(claim => <article key={claim.id} className="coordination__claim">
      <span className="mono coordination__identity">{claim.taskId}{claim.taskId === sessionId ? ' · 当前任务' : ''}</span><span className="mono">{claim.path}</span>
      <div className="row gap-2"><span className="grow">{claim.mode === 'editing' ? '正在编辑' : '近期修改'}</span>{writable && claim.taskId === sessionId && <Button size="sm" disabled={pending} onClick={() => void mutate(claim)}>释放本任务认领</Button>}</div>
    </article>)}
    {page?.items.length === 0 && <span className="muted">没有有效的文件认领。</span>}
    <div className="row gap-2">{after && <Button size="sm" disabled={loading} onClick={() => setAfter(undefined)}>返回认领首页</Button>}{page?.nextCursor && <Button size="sm" disabled={loading} onClick={() => setAfter(page.nextCursor)}>下一页认领</Button>}</div>
    {writable ? <><label className="coordination__field">本任务准备编辑的路径<textarea aria-label="准备编辑的路径" rows={2} value={paths} onChange={event => setPaths(event.target.value)} placeholder="每行一个项目内路径，最多 32 项" /></label><Button size="sm" disabled={pending || !valid} aria-busy={pending} onClick={() => void mutate()}>{pending ? '提交中…' : '认领这些文件'}</Button></> : <span className="muted">只有可写且运行中的 Work 任务可登记或释放自己的认领。</span>}
    {receipt && <span role="status">{receipt}</span>}
  </section>;
}

function noticeBody(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object' && 'body' in payload && typeof payload.body === 'string') return payload.body;
  return JSON.stringify(payload, null, 2) ?? '';
}

function noticeTitle(notice: CoordinationNotice): string {
  const payload = notice.payload;
  const kind = notice.kind === 'peer_message' && payload && typeof payload === 'object' && 'kind' in payload && typeof payload.kind === 'string' ? payload.kind : notice.kind;
  return kinds[kind as MessageKind] ?? noticeKinds[kind] ?? kind;
}

function CoordinationInboxView({ sessionId }: { sessionId: string }) {
  const revision = useApp(state => state.coordinationRevision);
  const [query, setQuery] = useState<{ after?: number; through?: number }>({});
  const [page, setPage] = useState<CoordinationInbox>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [acknowledging, setAcknowledging] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [updated, setUpdated] = useState(false);
  const seenRevision = useRef(revision), ackBusy = useRef(false), alive = useRef(true);
  const currentPage = useRef(page); currentPage.current = page;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    if (query.after) setUpdated(true); else { setQuery({}); setRefresh(value => value + 1); }
  }, [revision, query.after]);
  useEffect(() => {
    let current = true;
    setLoading(true); setError(undefined);
    void gateway.coordination!.inbox(sessionId, { ...query, limit: PAGE_SIZE }).then(
      result => { if (current) { setPage({ ...result, items: result.items.slice(0, PAGE_SIZE) }); if (!query.after) setUpdated(false); } },
      reason => { if (current) setError(errorText(reason)); },
    ).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [sessionId, query, refresh]);
  const acknowledge = async (id: string) => {
    if (ackBusy.current) return;
    ackBusy.current = true; setAcknowledging(id); setError(undefined);
    const snapshot = page;
    try {
      await gateway.coordination!.ack(sessionId, [id]);
      if (alive.current && currentPage.current === snapshot) { setQuery(current => ({ ...current, through: snapshot?.through })); setRefresh(value => value + 1); }
    } catch (reason) { if (alive.current) setError(errorText(reason)); }
    finally { ackBusy.current = false; if (alive.current) setAcknowledging(undefined); }
  };
  return <section className="coordination__section" aria-label="协作收件箱" aria-busy={loading}>
    <div className="row gap-2"><strong className="grow">协作收件箱</strong>{loading && <Spinner size={14} />}<Button size="sm" disabled={loading} onClick={() => { setQuery({}); setRefresh(value => value + 1); }}>刷新快照</Button></div>
    <p className="muted">按接收顺序分批查看。打开页面不会自动确认；“我已读”与 Agent 确认分别记录。</p>
    {updated && <span role="status">有新的协作状态；当前历史页保持不变。</span>}
    {error && <ErrorBanner message={error} onRetry={() => setRefresh(value => value + 1)} />}
    {page?.items.map(notice => <article key={notice.id} className="coordination__notice">
      <div className="row gap-2"><strong>{noticeTitle(notice)}</strong><span className="muted">{notice.senderKind === 'operator' ? '用户' : notice.senderKind === 'work' ? 'Agent' : notice.senderKind === 'runtime' ? '运行状态通知' : notice.senderKind} · {relativeTime(notice.createdAt)}</span></div>
      <span className="mono coordination__identity">来源 {notice.senderId}</span>
      <pre className="coordination__body">{noticeBody(notice.payload)}</pre>
      <div className="row gap-2"><span className="muted grow">{notice.ackedAt ? 'Agent 已确认' : 'Agent 尚未确认'} · {notice.operatorSeenAt ? '我已读' : '我未读'}</span>{!notice.operatorSeenAt && <Button size="sm" disabled={!!acknowledging} onClick={() => void acknowledge(notice.id)}>{acknowledging === notice.id ? '记录中…' : '标记我已读'}</Button>}</div>
    </article>)}
    {page?.items.length === 0 && <span className="muted">这份快照没有协调通知。</span>}
    <div className="row gap-2">{query.after !== undefined && <Button size="sm" disabled={loading} onClick={() => { setQuery({}); setRefresh(value => value + 1); }}>返回当前快照</Button>}{page?.nextCursor !== undefined && <Button size="sm" disabled={loading} onClick={() => setQuery({ after: page.nextCursor, through: page.through })}>下一页通知</Button>}</div>
  </section>;
}

function CoordinationComposer({ sessionId, to, setTo }: { sessionId: string; to: string; setTo: (value: string) => void }) {
  const [kind, setKind] = useState<MessageKind>('question');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [receipt, setReceipt] = useState<string>();
  const bodyBytes = new TextEncoder().encode(body.trim()).length;
  const busy = useRef(false), retry = useRef<{ signature: string; id: string }>(), revision = useRef(0), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const currentDraft = useRef(''); currentDraft.current = JSON.stringify({ sessionId, to: to.trim(), kind, body: body.trim() });
  const send = async () => {
    if (busy.current || !to.trim() || !body.trim() || bodyBytes > 3000) return;
    const snapshot = { sessionId, to: to.trim(), kind, body: body.trim() }, signature = JSON.stringify(snapshot), sentRevision = revision.current;
    if (retry.current?.signature !== signature) retry.current = { signature, id: crypto.randomUUID() };
    busy.current = true; setPending(true); setError(undefined); setReceipt(undefined);
    try {
      const result = await gateway.coordination!.send({ ...snapshot, clientMessageId: retry.current.id });
      if (alive.current) { setReceipt(result.id); if (revision.current === sentRevision && currentDraft.current === signature) setBody(''); retry.current = undefined; }
    } catch (reason) { if (alive.current) setError(errorText(reason)); }
    finally { busy.current = false; if (alive.current) setPending(false); }
  };
  return <section className="coordination__section" aria-label="发送协调消息">
    <strong>发送协调消息</strong>
    <label className="coordination__field">接收任务<input aria-label="接收任务" value={to} onChange={event => { revision.current++; setTo(event.target.value); }} placeholder="任务 ID，或点击上方“写消息”" /></label>
    <label className="coordination__field">消息类型<select aria-label="协调消息类型" value={kind} onChange={event => { revision.current++; setKind(event.target.value as MessageKind); }}>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label className="coordination__field">正文<textarea aria-label="协调消息正文" rows={4} maxLength={3000} value={body} onChange={event => { revision.current++; setBody(event.target.value); }} /></label>
    <span className="muted">{bodyBytes} / 3000 字节{bodyBytes > 3000 ? ' · 正文过长，请缩短后发送' : ''}</span>
    <p className="muted">以用户身份发送参考消息，不会改变目标任务的权限、预算或执行状态。</p>
    {error && <ErrorBanner message={error} />}{receipt && <span role="status">后端已接收 · <span className="mono">{receipt}</span></span>}
    <Button size="sm" disabled={pending || !to.trim() || !body.trim() || bodyBytes > 3000} aria-busy={pending} onClick={() => void send()}>{pending ? '发送中…' : error ? '重试发送' : '发送协调消息'}</Button>
  </section>;
}
