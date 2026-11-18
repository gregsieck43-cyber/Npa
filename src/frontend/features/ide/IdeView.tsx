import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { gateway, type Diagnostic, type FileDiff, type FileNode, type SourceControlView } from '../../api';
import { go, guard, notify, openIdeView } from '../../app/actions';
import { useApp } from '../../app/store';
import { CodeEditor, languageOf } from '../../components/CodeEditor';
import { Icon, type IconName } from '../../components/Icon';
import { FileDiffView } from '../../components/rich';
import { Button, EmptyState, IconButton, Kbd, Modal, ResizeHandle, Skeleton } from '../../components/ui';
import { IdeAgent } from './IdeAgent';
import { IdeBottom, type BottomTab, type OutputLine } from './IdeBottom';
import { Explorer, ScmPanel, SearchPanel, type Activity } from './IdeSide';

interface Tab { id: string; kind: 'file' | 'diff'; path: string; content: string; saved: string; loading: boolean; diff?: FileDiff }
const tabId = (kind: Tab['kind'], path: string) => `${kind}:${path}`;

const activities: { id: Activity; icon: IconName; label: string; keys: string }[] = [
  { id: 'explorer', icon: 'files', label: '资源管理器', keys: 'Ctrl+Shift+E' },
  { id: 'search', icon: 'search', label: '搜索', keys: 'Ctrl+Shift+F' },
  { id: 'scm', icon: 'branch', label: '源代码管理', keys: 'Ctrl+Shift+G' },
];

/** 拖拽调整底部面板高度。 */
function HorizontalHandle({ onResize }: { onResize: (delta: number) => void }) {
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    let last = event.clientY;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing-v');
    const move = (e: PointerEvent) => { onResize(last - e.clientY); last = e.clientY; };
    const up = () => { document.body.classList.remove('is-resizing-v'); target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  return <div className="ide-hhandle" onPointerDown={start} role="separator" aria-orientation="horizontal" />;
}

export function IdeView({ projectId }: { projectId?: string }) {
  const projects = useApp(s => s.projects);
  const project = projects.find(p => p.id === projectId);
  const [activity, setActivity] = useState<Activity | undefined>('explorer');
  const [sideWidth, setSideWidth] = useState(260);
  const [tree, setTree] = useState<FileNode[]>();
  const [scm, setScm] = useState<SourceControlView>();
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [reveal, setReveal] = useState<{ line: number; column?: number; nonce: number }>();
  const [cursor, setCursor] = useState({ line: 1, column: 1, selection: '' });
  const [bottom, setBottom] = useState<{ open: boolean; tab: BottomTab; height: number }>({ open: true, tab: 'terminal', height: 220 });
  const [agent, setAgent] = useState<{ open: boolean; sessionId?: string; width: number }>({ open: true, width: 360 });
  const [output, setOutput] = useState<OutputLine[]>([]);
  const [closing, setClosing] = useState<Tab>();
  const active = tabs.find(t => t.id === activeId);
  const log = (text: string, tone?: OutputLine['tone']) => setOutput(lines => [...lines.slice(-199), { at: new Date().toISOString(), text, tone }]);

  const refreshTree = useCallback(() => { if (projectId) void guard('读取文件树失败', () => gateway.workspace.files(projectId)).then(r => setTree(r ?? [])); }, [projectId]);
  const refreshScm = useCallback(() => { if (projectId) void guard('读取源代码状态失败', () => gateway.workspace.sourceControl(projectId)).then(setScm); }, [projectId]);
  const refreshProblems = useCallback(() => { if (projectId) void guard('读取诊断失败', () => gateway.workspace.diagnostics(projectId)).then(r => setDiagnostics(r ?? [])); }, [projectId]);
  useEffect(() => { setTabs([]); setActiveId(undefined); setTree(undefined); refreshTree(); refreshScm(); refreshProblems(); }, [refreshTree, refreshScm, refreshProblems]);

  const openFile = async (path: string, line?: number, column?: number) => {
    const id = tabId('file', path);
    setActiveId(id);
    if (line) setReveal({ line, column, nonce: Date.now() });
    if (tabs.some(t => t.id === id)) return;
    setTabs(list => [...list, { id, kind: 'file', path, content: '', saved: '', loading: true }]);
    const text = await guard('打开文件失败', () => gateway.workspace.readFile(projectId!, path));
    setTabs(list => list.map(t => (t.id === id ? { ...t, content: text ?? '', saved: text ?? '', loading: false } : t)));
    if (line) setReveal({ line, column, nonce: Date.now() + 1 });
  };

  const openDiff = async (path: string) => {
    const id = tabId('diff', path);
    setActiveId(id);
    if (!tabs.some(t => t.id === id)) setTabs(list => [...list, { id, kind: 'diff', path, content: '', saved: '', loading: true }]);
    const diff = await guard('读取差异失败', () => gateway.workspace.fileDiff(projectId!, path));
    setTabs(list => list.map(t => (t.id === id ? { ...t, diff, loading: false } : t)));
  };

  const save = async (tab: Tab | undefined = active) => {
    if (!tab || tab.kind !== 'file' || tab.content === tab.saved) return true;
    const result = await guard('保存失败', () => gateway.workspace.writeFile(projectId!, tab.path, tab.content));
    if (!result) { log(`保存失败：${tab.path}`, 'danger'); return false; }
    setTabs(list => list.map(t => (t.id === tab.id ? { ...t, saved: tab.content } : t)));
    log(`已保存 ${tab.path}（${result.bytes} 字节）`, 'ok');
    refreshScm(); refreshTree(); refreshProblems();
    return true;
  };

  const closeTab = (tab: Tab, force = false) => {
    if (!force && tab.kind === 'file' && tab.content !== tab.saved) { setClosing(tab); return; }
    setTabs(list => {
      const index = list.findIndex(t => t.id === tab.id), next = list.filter(t => t.id !== tab.id);
      if (tab.id === activeId) setActiveId(next[Math.min(index, next.length - 1)]?.id);
      return next;
    });
  };

  const create = async (path: string) => {
    const result = await guard('新建文件失败', () => gateway.workspace.writeFile(projectId!, path, ''));
    if (!result) return;
    log(`已新建 ${path}`, 'ok');
    refreshTree(); refreshScm();
    void openFile(path);
  };

  const commit = async (message: string, paths: string[]) => {
    const result = await guard('提交失败', () => gateway.workspace.commit(projectId!, message, paths));
    if (!result) return false;
    log(`已提交 ${result.commit}：${message}`, 'ok');
    refreshScm(); refreshTree();
    setTabs(list => list.filter(t => t.kind !== 'diff'));
    return true;
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (event.shiftKey && key === 'e') { event.preventDefault(); setActivity('explorer'); }
      else if (event.shiftKey && key === 'f') { event.preventDefault(); setActivity('search'); }
      else if (event.shiftKey && key === 'g') { event.preventDefault(); setActivity('scm'); }
      else if (key === 'j') { event.preventDefault(); setBottom(b => ({ ...b, open: !b.open })); }
      else if (key === '`') { event.preventDefault(); setBottom(b => ({ ...b, open: true, tab: 'terminal' })); }
      else if (key === 's' && !event.shiftKey) { event.preventDefault(); void save(); }
      else if (key === 'w' && active) { event.preventDefault(); closeTab(active); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const problemCounts = useMemo(() => ({ error: diagnostics?.filter(d => d.severity === 'error').length ?? 0, warning: diagnostics?.filter(d => d.severity === 'warning').length ?? 0 }), [diagnostics]);

  if (!project) {
    return (
      <div className="ide ide--empty">
        <EmptyState icon="folder" title={projects.length ? '选择一个项目' : '还没有登记项目'} detail="IDE 只能打开你明确登记的工作区。"
          action={projects.length ? <div className="ide-pick">{projects.map(p => <Button key={p.id} variant="secondary" icon="folder" onClick={() => openIdeView(p.id)}>{p.name}</Button>)}</div> : <Button variant="primary" icon="plus" onClick={() => go('projects')}>登记项目</Button>} />
      </div>
    );
  }

  const dirtyCount = tabs.filter(t => t.kind === 'file' && t.content !== t.saved).length;
  const selectionInfo = active?.kind === 'file' && cursor.selection ? { path: active.path, text: cursor.selection, line: cursor.line } : undefined;

  return (
    <div className="ide">
      <nav className="ide-activity" aria-label="活动栏">
        {activities.map(item => (
          <button key={item.id} type="button" className={`ide-activity__btn${activity === item.id ? ' is-active' : ''}`} aria-label={item.label} data-tip={`${item.label}  ${item.keys}`} data-tip-side="right" onClick={() => setActivity(activity === item.id ? undefined : item.id)}>
            <Icon name={item.icon} size={19} />
            {item.id === 'scm' && scm?.changes.length ? <span className="ide-activity__badge num">{scm.changes.length}</span> : null}
          </button>
        ))}
        <span className="grow" />
        <button type="button" className={`ide-activity__btn${agent.open ? ' is-active' : ''}`} aria-label="Agent" data-tip="Agent 面板" data-tip-side="right" onClick={() => setAgent(a => ({ ...a, open: !a.open }))}><Icon name="bot" size={19} /></button>
        <button type="button" className={`ide-activity__btn${bottom.open ? ' is-active' : ''}`} aria-label="面板" data-tip="终端与问题  Ctrl+J" data-tip-side="right" onClick={() => setBottom(b => ({ ...b, open: !b.open }))}><Icon name="terminal" size={19} /></button>
      </nav>

      {activity && (
        <div className="ide-side" style={{ width: sideWidth }}>
          {activity === 'explorer' && <Explorer projectName={project.name} tree={tree} active={active?.path} onOpen={path => void openFile(path)} onRefresh={refreshTree} onCreate={path => void create(path)} />}
          {activity === 'search' && <SearchPanel projectId={project.id} onOpen={(path, line, column) => void openFile(path, line, column)} />}
          {activity === 'scm' && <ScmPanel scm={scm} onOpenDiff={path => void openDiff(path)} onCommit={commit} onRefresh={refreshScm} />}
          <ResizeHandle side="right" onResize={delta => setSideWidth(w => Math.min(460, Math.max(200, w + delta)))} onDoubleClick={() => setSideWidth(260)} />
        </div>
      )}

      <div className="ide-main">
        <div className="ide-tabs" role="tablist">
          {tabs.map(tab => {
            const dirty = tab.kind === 'file' && tab.content !== tab.saved;
            return (
              <div key={tab.id} role="tab" aria-selected={tab.id === activeId} className={`ide-tab${tab.id === activeId ? ' is-active' : ''}${dirty ? ' is-dirty' : ''}`} onClick={() => setActiveId(tab.id)} onAuxClick={e => { if (e.button === 1) closeTab(tab); }} title={tab.path}>
                <Icon name={tab.kind === 'diff' ? 'diff' : 'file'} size={13} />
                <span className="truncate">{tab.path.split('/').pop()}{tab.kind === 'diff' && <span className="muted"> (差异)</span>}</span>
                <button type="button" className="ide-tab__close" aria-label="关闭标签" onClick={e => { e.stopPropagation(); closeTab(tab); }}>{dirty ? <span className="ide-tab__dot" /> : <Icon name="x" size={12} />}</button>
              </div>
            );
          })}
          <span className="grow" />
          {active?.kind === 'file' && <IconButton icon="save" label="保存  Ctrl+S" size={14} disabled={active.content === active.saved} onClick={() => void save()} />}
        </div>
        {active && (
          <div className="ide-crumbs">
            {active.path.split('/').map((part, i, all) => <span key={i} className={i === all.length - 1 ? 'is-last' : undefined}>{part}{i < all.length - 1 && <Icon name="chevronRight" size={11} />}</span>)}
          </div>
        )}
        <div className="ide-editor">
          {!active && (
            <div className="ide-welcome">
              <Icon name="code" size={30} className="ide-welcome__icon" />
              <h2>{project.name}</h2>
              <p className="muted mono">{project.path}</p>
              <div className="ide-welcome__keys">
                {([['打开资源管理器', 'Ctrl+Shift+E'], ['全局搜索', 'Ctrl+Shift+F'], ['源代码管理', 'Ctrl+Shift+G'], ['保存', 'Ctrl+S'], ['终端', 'Ctrl+`'], ['切换面板', 'Ctrl+J']] as const).map(([label, keys]) => (
                  <div key={label} className="ide-welcome__key"><span>{label}</span><Kbd keys={keys} /></div>
                ))}
              </div>
              <p className="muted">人工编辑与保存不会创建 Agent 任务；需要 Agent 时在右侧面板描述即可。</p>
            </div>
          )}
          {active?.loading && <div className="ide-editor__loading"><Skeleton lines={12} /></div>}
          {active && !active.loading && active.kind === 'file' && (
            <CodeEditor key={active.id} path={active.path} value={active.content} reveal={reveal}
              onChange={value => setTabs(list => list.map(t => (t.id === active.id ? { ...t, content: value } : t)))}
              onSave={() => void save(tabs.find(t => t.id === active.id))}
              onCursor={(line, column, selection) => setCursor({ line, column, selection })} />
          )}
          {active && !active.loading && active.kind === 'diff' && (active.diff ? <div className="ide-diff"><FileDiffView diff={active.diff} collapsible={false} /></div> : <EmptyState icon="diff" title="没有差异" />)}
        </div>
        {bottom.open && (
          <div className="ide-bottom-wrap" style={{ height: bottom.height }}>
            <HorizontalHandle onResize={delta => setBottom(b => ({ ...b, height: Math.min(560, Math.max(120, b.height + delta)) }))} />
            <IdeBottom projectId={project.id} cwd={project.path} tab={bottom.tab} setTab={tab => setBottom(b => ({ ...b, tab }))} diagnostics={diagnostics} output={output}
              onClose={() => setBottom(b => ({ ...b, open: false }))} onOpen={(path, line, column) => void openFile(path, line, column)} onRefreshProblems={refreshProblems} />
          </div>
        )}
        <div className="ide-status">
          <span><Icon name="branch" size={12} />{scm?.branch ?? '—'}{scm?.changes.length ? ` · ${scm.changes.length} 处变更` : ''}</span>
          <button type="button" onClick={() => setBottom({ ...bottom, open: true, tab: 'problems' })}><Icon name="circleX" size={12} />{problemCounts.error}<Icon name="alert" size={12} />{problemCounts.warning}</button>
          {dirtyCount > 0 && <span className="ide-status__dirty">{dirtyCount} 个未保存</span>}
          <span className="grow" />
          {active?.kind === 'file' && <><span className="num">行 {cursor.line}，列 {cursor.column}{cursor.selection ? `（已选 ${cursor.selection.length}）` : ''}</span><span>UTF-8</span><span>{languageOf(active.path).label}</span></>}
        </div>
      </div>

      {agent.open && (
        <div className="ide-agent-wrap" style={{ width: agent.width }}>
          <ResizeHandle side="left" onResize={delta => setAgent(a => ({ ...a, width: Math.min(560, Math.max(300, a.width + delta)) }))} onDoubleClick={() => setAgent(a => ({ ...a, width: 360 }))} />
          <IdeAgent projectId={project.id} sessionId={agent.sessionId} setSessionId={sessionId => setAgent(a => ({ ...a, sessionId }))} selection={selectionInfo} onClose={() => setAgent(a => ({ ...a, open: false }))} />
        </div>
      )}

      <Modal open={!!closing} onClose={() => setClosing(undefined)} title={`保存对 ${closing?.path.split('/').pop()} 的修改？`} width={420}
        footer={<>
          <Button variant="ghost" onClick={() => { if (closing) closeTab(closing, true); setClosing(undefined); }}>不保存</Button>
          <Button variant="secondary" onClick={() => setClosing(undefined)}>取消</Button>
          <Button variant="primary" icon="save" onClick={() => { const tab = closing; setClosing(undefined); if (tab) void save(tab).then(ok => { if (ok) closeTab({ ...tab, saved: tab.content }, true); else notify('error', '未能保存，标签页保持打开'); }); }}>保存</Button>
        </>}>
        <p>如果不保存，你的修改将会丢失。</p>
      </Modal>
    </div>
  );
}
