import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { gateway, type Attachment, type FileNode, type SideAnswer, type WebPage, type WebSearchResult } from '../../api';
import { askSide, cancelSideChat, clearSideChat, loadSideChat, guard, navigateTab, openIdeView, openInspector, openPanel, openSession, sideChatKey } from '../../app/actions';
import { useApp, type PanelKind, type PanelTab } from '../../app/store';
import { Icon, type IconName } from '../../components/Icon';
import { CodeBlock, FileDiffView, Markdown } from '../../components/rich';
import { Button, EmptyState, ErrorBanner, IconButton, Kbd, Skeleton, Spinner } from '../../components/ui';
import { compactNumber, clockTime, relativeTime } from '../../lib/format';
import { hostOf, readableUrl, toTarget } from '../../lib/panel';
import { Terminal } from '../ide/IdeBottom';
import { Explorer } from '../ide/IdeSide';
import { ModelPicker, ReasoningPicker, useActiveModel } from '../session/Pickers';
import { useInspectorData } from '../inspector/useInspectorData';

/** 会话关联的项目；Chat 会话没有项目时退回当前项目或第一个已登记项目。 */
export function usePanelProject(sessionId?: string) {
  const sessionProject = useApp(s => (sessionId ? s.sessions[sessionId]?.projectId : undefined));
  const fallback = useApp(s => s.projectId), projects = useApp(s => s.projects);
  return projects.find(p => p.id === (sessionProject ?? fallback)) ?? projects[0];
}

export const panelMeta: Record<PanelKind, { label: string; icon: IconName }> = {
  launcher: { label: '新标签页', icon: 'globe' }, changes: { label: '变更', icon: 'diff' }, inspector: { label: '检查器', icon: 'eye' },
  browser: { label: '网页', icon: 'globe' }, terminal: { label: '终端', icon: 'terminal' }, sidechat: { label: '侧边聊天', icon: 'chatPlus' }, files: { label: '文件', icon: 'files' },
  coordination: { label: '工作区协作', icon: 'layers' },
};

const tools: { kind: PanelKind; keys?: string }[] = [{ kind: 'terminal', keys: 'Ctrl+`' }, { kind: 'sidechat', keys: 'Ctrl+Alt+S' }, { kind: 'files', keys: 'Ctrl+P' }, { kind: 'changes' }, { kind: 'coordination' }, { kind: 'inspector', keys: 'Ctrl+I' }];

export function LauncherTab() {
  const recent = useApp(s => s.recentUrls);
  const [address, setAddress] = useState('');
  return (
    <div className="ptab ptab--launcher">
      <label className="addr addr--big"><Icon name="search" size={14} /><input value={address} placeholder="搜索或输入网址" autoFocus onChange={e => setAddress(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && address.trim()) openPanel('browser', toTarget(address)); }} /></label>
      <div className="launcher__section">工具</div>
      <div className="launcher__tools">
        {tools.map(tool => (
          <button key={tool.kind} type="button" className="launcher__tool" onClick={() => openPanel(tool.kind)}>
            <Icon name={panelMeta[tool.kind].icon} size={15} /><span className="grow">{panelMeta[tool.kind].label}</span>{tool.keys && <Kbd keys={tool.keys} />}
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <>
          <div className="launcher__section">最近访问</div>
          <div className="launcher__recent">
            {recent.map(url => (
              <button key={url} type="button" className="launcher__site" onClick={() => openPanel('browser', url)} title={url}>
                <span className="launcher__favicon">{hostOf(url).slice(0, 1).toUpperCase()}</span><span className="truncate">{hostOf(url)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function BrowserTab({ tab }: { tab: PanelTab }) {
  const url = tab.history[tab.index] ?? '';
  const [address, setAddress] = useState(url);
  const [page, setPage] = useState<{ url: string; page?: WebPage; results?: WebSearchResult[]; error?: string }>();
  const [reload, setReload] = useState(0);
  useEffect(() => { setAddress(url.startsWith('search:') ? url.slice(7) : url); }, [url]);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    setPage({ url });
    const load = url.startsWith('search:') ? gateway.web.search(url.slice(7)).then(results => ({ url, results })) : gateway.web.fetch(url).then(result => ({ url, page: result }));
    load.then(result => { if (alive) setPage(result); }, (error: unknown) => { if (alive) setPage({ url, error: error instanceof Error ? error.message : String(error) }); });
    return () => { alive = false; };
  }, [url, reload]);
  const go = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter' && address.trim()) navigateTab(tab.id, toTarget(address)); };
  return (
    <div className="ptab ptab--browser">
      <div className="browser__bar">
        <IconButton icon="chevronLeft" label="后退" size={14} disabled={tab.index === 0} onClick={() => navigateTab(tab.id, -1)} />
        <IconButton icon="chevronRight" label="前进" size={14} disabled={tab.index >= tab.history.length - 1} onClick={() => navigateTab(tab.id, 1)} />
        <IconButton icon="refresh" label="重新加载" size={14} disabled={!url} onClick={() => setReload(n => n + 1)} />
        <label className="addr"><Icon name={url.startsWith('search:') ? 'search' : 'globe'} size={13} /><input value={address} placeholder="搜索或输入网址" onChange={e => setAddress(e.target.value)} onKeyDown={go} onFocus={e => e.currentTarget.select()} /></label>
      </div>
      <div className="browser__page">
        {!url && <EmptyState icon="globe" title="输入网址或搜索词" detail="网页以阅读模式在侧边打开，正文由后台抓取并附带来源与时间；页面脚本不会在这里执行。" />}
        {url && page?.url === url && !page.page && !page.results && !page.error && <Skeleton lines={10} />}
        {page?.error && <ErrorBanner message={page.error} onRetry={() => setReload(n => n + 1)} />}
        {page?.results && (
          <div className="serp">
            <div className="serp__count muted">“{url.slice(7)}” 的 {page.results.length} 条结果</div>
            {page.results.map(result => (
              <button key={result.url} type="button" className="serp__item" onClick={() => navigateTab(tab.id, result.url)}>
                <span className="serp__url truncate">{readableUrl(result.url)}</span>
                <span className="serp__title">{result.title}</span>
                <span className="serp__snippet">{result.snippet}</span>
              </button>
            ))}
          </div>
        )}
        {page?.page && (
          <article className="reader">
            <div className="reader__meta"><Icon name="globe" size={12} /><span className="truncate">{page.page.url}</span><span className="muted">· {clockTime(page.page.fetchedAt)} 抓取 · HTTP {page.page.status}</span></div>
            <h2 className="reader__title">{page.page.title}</h2>
            <Markdown text={page.page.text} />
          </article>
        )}
      </div>
    </div>
  );
}

export function ChangesTab({ sessionId }: { sessionId?: string }) {
  const project = usePanelProject(sessionId);
  const { data, error, loading, reload } = useInspectorData(sessionId ?? '', id => (id ? gateway.inspector.diffs(id) : Promise.resolve([])));
  const [open, setOpen] = useState<string>();
  if (!sessionId) return <div className="ptab"><EmptyState icon="diff" title="打开一个会话" detail="这里汇总当前会话中 Agent 修改的文件。" /></div>;
  if (error) return <div className="ptab"><ErrorBanner message={error} onRetry={reload} /></div>;
  if (!data) return <div className="ptab">{loading && <Skeleton lines={6} />}</div>;
  const additions = data.reduce((n, d) => n + d.additions, 0), deletions = data.reduce((n, d) => n + d.deletions, 0);
  return (
    <div className="ptab">
      {data.length === 0 ? <EmptyState icon="diff" title="还没有文件变更" detail="Agent 修改文件后，会在这里逐个列出并可展开查看 Diff。" /> : (
        <div className="changes">
          <div className="changes__head">
            <span className="changes__icon"><Icon name="diff" size={15} /></span>
            <div className="grow"><strong>已编辑 {data.length} 个文件</strong><span className="diff-stat"><span className="diff-stat__add">+{compactNumber(additions)}</span><span className="diff-stat__del">−{compactNumber(deletions)}</span></span></div>
            {project && <Button size="sm" variant="ghost" icon="terminal" onClick={() => openIdeView(project.id)}>在 IDE 中查看</Button>}
          </div>
          {data.map(diff => {
            const key = `${diff.path}-${diff.toolCallId}`;
            return (
              <div key={key} className={`changes__row${open === key ? ' is-open' : ''}`}>
                <button type="button" className="changes__file" onClick={() => setOpen(open === key ? undefined : key)}>
                  <Icon name="chevronRight" size={12} className="changes__chevron" />
                  <span className="grow truncate">{diff.path.split('/').pop()}<span className="muted"> {diff.path.split('/').slice(0, -1).join('/')}</span></span>
                  {!diff.applied && <span className="changes__pending">待应用</span>}
                  <span className="diff-stat"><span className="diff-stat__add">+{diff.additions}</span><span className="diff-stat__del">−{diff.deletions}</span></span>
                </button>
                {open === key && <div className="changes__diff"><FileDiffView diff={diff} collapsible={false} /></div>}
              </div>
            );
          })}
          <button type="button" className="link-btn changes__more" onClick={() => openInspector('diff')}><Icon name="eye" size={12} />在检查器中对比全部 Diff</button>
        </div>
      )}
    </div>
  );
}

export function TerminalTab({ sessionId }: { sessionId?: string }) {
  const project = usePanelProject(sessionId);
  if (!project) return <div className="ptab"><EmptyState icon="terminal" title="没有可用的项目" detail="终端只在已登记的工作区内运行。" /></div>;
  return <div className="ptab ptab--flush"><Terminal projectId={project.id} cwd={project.path} /></div>;
}

export function FilesTab({ sessionId }: { sessionId?: string }) {
  const project = usePanelProject(sessionId);
  const [tree, setTree] = useState<FileNode[]>();
  const [preview, setPreview] = useState<{ path: string; text?: string }>();
  const load = () => { if (project) void guard('读取文件树失败', () => gateway.workspace.files(project.id)).then(r => setTree(r ?? [])); };
  useEffect(load, [project?.id]);
  if (!project) return <div className="ptab"><EmptyState icon="files" title="没有可用的项目" /></div>;
  const open = async (path: string) => {
    setPreview({ path });
    const text = await guard('读取文件失败', () => gateway.workspace.readFile(project.id, path));
    setPreview(current => (current?.path === path ? { path, text: text ?? '' } : current));
  };
  return (
    <div className="ptab ptab--files">
      <div className="files__tree"><Explorer projectName={project.name} tree={tree} active={preview?.path} onOpen={path => void open(path)} onRefresh={load} onCreate={() => openIdeView(project.id)} /></div>
      {preview && (
        <div className="files__preview">
          <div className="files__bar"><Icon name="file" size={13} /><span className="mono truncate grow">{preview.path}</span><Button size="sm" variant="ghost" icon="terminal" onClick={() => openIdeView(project.id)}>在 IDE 中编辑</Button><IconButton icon="x" label="关闭预览" size={13} onClick={() => setPreview(undefined)} /></div>
          {preview.text === undefined ? <Skeleton lines={8} /> : <CodeBlock code={preview.text} lang={preview.path.split('.').pop()} title={preview.path.split('/').pop()} numbered maxHeight={9999} />}
        </div>
      )}
    </div>
  );
}

/** 侧边聊天（参照 Codex）：临时聊天，可带会话只读上下文；有自己的模型、推理档与附件，不打断主任务。 */
export function SideChatTab({ sessionId }: { sessionId?: string }) {
  const answers = useApp(s => s.sideChats[sideChatKey(sessionId)]);
  const meta = useApp(s => s.sideChatMeta?.key === sideChatKey(sessionId) ? s.sideChatMeta : undefined);
  const title = useApp(s => (sessionId ? s.sessions[sessionId]?.title : undefined));
  const sendKey = useApp(s => s.settings?.defaults.sendKey ?? 'enter');
  const defaultModel = useActiveModel();
  const [modelId, setModelId] = useState<string>();
  const [level, setLevel] = useState<string>();
  const [question, setQuestion] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef<object>();
  const revision = useRef(0);
  const activeScope = useRef(sessionId);
  activeScope.current = sessionId;
  useEffect(() => { submission.current = undefined; setSubmitting(false); }, [sessionId]);
  useEffect(() => () => { submission.current = undefined; }, []);
  const list = useMemo(() => answers ?? [], [answers]);
  const pending = submitting || !!meta?.pending || list.some(item => item.status === 'running');
  const area = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const previous = useRef({ list, latest: meta?.latest, last: list.at(-1) });
  const model = modelId ?? defaultModel;
  useEffect(() => { void loadSideChat(sessionId); }, [sessionId]);
  useEffect(() => {
    // A live request must not replace the page the user deliberately opened.
    if (!pending || meta?.latest === false) return;
    const timer = setInterval(() => { void loadSideChat(sessionId); }, 2000);
    return () => clearInterval(timer);
  }, [pending, sessionId, meta?.latest]);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [question]);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const before = previous.current;
    if (meta?.latest === false && list !== before.list) { el.scrollTop = 0; pinned.current = false; }
    else if (meta?.latest !== false && (pinned.current || before.latest === false)) { el.scrollTop = el.scrollHeight; pinned.current = true; setUnseen(false); }
    else {
      const last = list.at(-1);
      if (last?.id !== before.last?.id || last?.answer !== before.last?.answer || last?.status !== before.last?.status) setUnseen(true);
    }
    setAway(el.scrollHeight - el.scrollTop - el.clientHeight >= 80);
    previous.current = { list, latest: meta?.latest, last: list.at(-1) };
  }, [list, pending, meta?.latest]);

  const ask = async () => {
    const value = question.trim();
    if (!value || pending || submission.current) return;
    const token = {}, sentRevision = revision.current;
    submission.current = token;
    const files = attachments;
    setSubmitting(true); setQuestion(''); setAttachments([]);
    try {
      const answer = await askSide({ sessionId, question: value, attachments: files, modelId: model, reasoningEffort: level });
      if (!answer && submission.current === token && activeScope.current === sessionId) {
        if (revision.current === sentRevision) setQuestion(current => current || value);
        setAttachments(current => [...current, ...files.filter(file => !current.some(item => item.id === file.id))]);
      }
    } finally {
      if (submission.current === token) { submission.current = undefined; setSubmitting(false); }
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    if (sendKey === 'enter' ? !event.shiftKey : event.ctrlKey || event.metaKey) { event.preventDefault(); void ask(); }
  };
  const pickFiles = async () => {
    const picked = await guard('选择文件失败', () => gateway.desktop.pickFiles());
    if (picked?.length) setAttachments(current => [...current, ...picked.filter(file => !current.some(item => item.id === file.id))]);
  };
  const scope = meta?.targetTaskId ? `共同管理${title ? `「${title}」` : '绑定任务'}；操作遵循主任务权限` : '独立侧聊；首次操作时绑定一个任务';

  return (
    <div className="ptab ptab--chat">
      {list.length > 0 || pending ? (
        <div className="sidechat__list" ref={scroll} onScroll={() => { const el = scroll.current!; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; setAway(!pinned.current); if (pinned.current) setUnseen(false); }}>
          <div className="sidechat__bar">
            <Icon name={title ? 'eye' : 'clock'} size={12} /><span className="grow truncate">{scope}</span>
            {meta?.targetTaskId && <Button size="sm" variant="ghost" onClick={() => void openSession(meta.targetTaskId!)}>查看任务</Button>}
            <IconButton icon="trash" label="清空侧边聊天" size={13} tipSide="bottom-end" disabled={!!pending} onClick={() => clearSideChat(sessionId)} />
          </div>
          <div className="sidechat__bar">
            {meta?.nextCursor && <Button size="sm" variant="ghost" disabled={meta.loading} onClick={() => void loadSideChat(sessionId, true)}>更早记录</Button>}
            {meta && !meta.latest && <Button size="sm" variant="ghost" onClick={() => void loadSideChat(sessionId)}>回到最新</Button>}
          </div>
          {list.map(item => <SideTurn key={item.id} question={item.question} attachments={item.attachments} at={item.createdAt} answer={item.status === 'running' ? undefined : item.answer} operations={item.operations} status={item.status} />)}
        </div>
      ) : (
        <div className="sidechat__empty">
          <span className="sidechat__empty-icon"><Icon name="chatPlus" size={22} /></span>
          <strong>侧边聊天</strong>
          <span className="muted">{scope}。可以补充指令、修改目标与计划、暂停或继续任务。计划执行仍需点击确认。聊天记录保存在本机。</span>
        </div>
      )}
      {away && <button type="button" className="sidechat__jump" onClick={() => { const el = scroll.current; if (el) el.scrollTop = el.scrollHeight; pinned.current = true; setAway(false); setUnseen(false); }}>{unseen ? '有新内容 · ' : ''}{meta?.latest === false ? '本页底部' : '回到底部'}</button>}
      <div className="composer composer--side">
        {attachments.length > 0 && (
          <div className="composer__attachments">
            {attachments.map(item => (
              <span key={item.id} className="attachment-chip">
                <Icon name={item.kind === 'image' ? 'image' : 'file'} size={13} /><span className="truncate">{item.name}</span>
                <button type="button" aria-label="移除附件" onClick={() => setAttachments(current => current.filter(a => a.id !== item.id))}><Icon name="x" size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <textarea ref={area} className="composer__input" rows={1} value={question} placeholder="和 NPN Gamma 聊点别的…" onChange={e => { revision.current++; setQuestion(e.target.value); }} onKeyDown={onKeyDown} />
        <div className="composer__bar">
          <button type="button" className="composer__tool" aria-label="添加附件" data-tip="添加附件" data-tip-side="top" onClick={() => void pickFiles()}><Icon name="plus" size={16} /></button>
          <span className="sidechat__scope" data-tip={scope} data-tip-side="top"><Icon name="lock" size={13} /></span>
          <span className="grow" />
          <ModelPicker value={model} onChange={id => { setModelId(id); setLevel(undefined); }} />
          <ReasoningPicker modelId={model} value={level} onChange={setLevel} />
          {submitting && !meta?.pending ? <button type="button" className="icon-btn send-btn" aria-label="正在发送" aria-busy="true" disabled><Spinner size={16} /></button> : pending ? <Button size="sm" variant="secondary" onClick={() => void cancelSideChat(sessionId)}>停止侧聊</Button> : <IconButton icon="arrowUp" label={sendKey === 'enter' ? '发送  Enter' : '发送  Ctrl+Enter'} tipSide="top" className={`send-btn${question.trim() ? ' is-ready' : ''}`} disabled={!question.trim()} onClick={() => void ask()} />}
        </div>
      </div>
    </div>
  );
}

function SideTurn({ question, attachments, at, answer, operations, status }: { question: string; attachments?: Attachment[]; at?: string; answer?: string; operations?: SideAnswer['operations']; status?: SideAnswer['status'] }) {
  return (
    <div className="sidechat__item">
      <div className="sidechat__q">
        {attachments?.length ? <div className="msg__attachments">{attachments.map(a => <span key={a.id} className="attachment-chip"><Icon name={a.kind === 'image' ? 'image' : 'file'} size={12} />{a.name}</span>)}</div> : null}
        {question}
      </div>
      <div className="sidechat__a">
        {answer === undefined ? <span className="sidechat__thinking"><Spinner size={13} /><span className="shimmer-text">正在思考…</span></span> : <><Markdown text={answer} />{at && <span className="sidechat__time muted">{relativeTime(at)}</span>}</>}
      </div>
      {status === 'failed' || status === 'cancelled' ? <span className="muted">{status === 'cancelled' ? '侧聊请求已停止' : '侧聊请求未完成'}</span> : null}
      {operations?.map(operation => <div className="muted" key={operation.commandId} title={operation.commandId}>
        主任务回执：{({ send_message: '补充指令', revise_goal: '修订目标', enter_plan: '重新规划', save_plan: '保存计划', pause: '暂停', resume: '继续', cancel: '取消', retry: '重试', propose_tool: '提交工具提议' } as Record<string, string>)[operation.action] ?? operation.action} · {operation.status === 'duplicate' ? '已接收（重复命令）' : '已接收'}{operation.revision === undefined ? '' : ` · 版本 ${operation.revision}`}
      </div>)}
    </div>
  );
}
