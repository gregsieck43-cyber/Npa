import { useMemo, useState } from 'react';
import { gateway, type FileNode, type SearchHit, type SourceControlView } from '../../api';
import { guard } from '../../app/actions';
import { Icon } from '../../components/Icon';
import { Button, EmptyState, IconButton, Skeleton, Spinner } from '../../components/ui';

export type Activity = 'explorer' | 'search' | 'scm';

function TreeNode({ node, depth, active, onOpen, expanded, toggle }: { node: FileNode; depth: number; active?: string; onOpen: (path: string) => void; expanded: Set<string>; toggle: (path: string) => void }) {
  if (node.kind === 'dir') {
    const open = expanded.has(node.path);
    return (
      <>
        <button type="button" className="ide-tree__row" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(node.path)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="muted" />
          <Icon name={open ? 'folderOpen' : 'folder'} size={14} className="ide-tree__folder" />
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children?.map(child => <TreeNode key={child.path} node={child} depth={depth + 1} active={active} onOpen={onOpen} expanded={expanded} toggle={toggle} />)}
      </>
    );
  }
  return (
    <button type="button" className={`ide-tree__row${active === node.path ? ' is-active' : ''}${node.change ? ` is-${node.change}` : ''}`} style={{ paddingLeft: 22 + depth * 12 }} onClick={() => onOpen(node.path)} title={node.path}>
      <Icon name="file" size={13} className="muted" />
      <span className="truncate grow">{node.name}</span>
      {node.change && <span className={`ide-tree__change ide-tree__change--${node.change}`}>{node.change === 'A' ? 'U' : node.change}</span>}
    </button>
  );
}

export function Explorer({ projectName, tree, active, onOpen, onRefresh, onCreate }: { projectName: string; tree?: FileNode[]; active?: string; onOpen: (path: string) => void; onRefresh: () => void; onCreate: (path: string) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['src', 'src/kernel', 'src/memory', 'tests']));
  const [creating, setCreating] = useState(false);
  const toggle = (path: string) => setExpanded(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  return (
    <div className="ide-panel">
      <div className="ide-panel__head">
        <span className="grow truncate">{projectName}</span>
        <IconButton icon="plus" label="新建文件" size={14} onClick={() => setCreating(true)} />
        <IconButton icon="refresh" label="刷新" size={14} onClick={onRefresh} />
        <IconButton icon="chevronLeft" label="全部折叠" size={14} onClick={() => setExpanded(new Set())} />
      </div>
      {creating && (
        <input className="ide-input" autoFocus placeholder="相对路径，例如 src/new.ts，回车创建"
          onKeyDown={event => {
            if (event.key === 'Escape') setCreating(false);
            if (event.key === 'Enter' && event.currentTarget.value.trim()) { onCreate(event.currentTarget.value.trim().replace(/\\/g, '/')); setCreating(false); }
          }} onBlur={() => setCreating(false)} />
      )}
      <div className="ide-tree">
        {!tree ? <Skeleton lines={8} /> : tree.map(node => <TreeNode key={node.path} node={node} depth={0} active={active} onOpen={onOpen} expanded={expanded} toggle={toggle} />)}
      </div>
    </div>
  );
}

export function SearchPanel({ projectId, onOpen }: { projectId: string; onOpen: (path: string, line: number, column: number) => void }) {
  const [text, setText] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCase] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!text.trim()) { setHits(undefined); return; }
    setBusy(true);
    const result = await guard('搜索失败', () => gateway.workspace.search(projectId, { text, regex, caseSensitive }));
    setBusy(false);
    setHits(result ?? []);
  };
  const grouped = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const hit of hits ?? []) map.set(hit.path, [...(map.get(hit.path) ?? []), hit]);
    return [...map];
  }, [hits]);
  return (
    <div className="ide-panel">
      <div className="ide-panel__head"><span className="grow">搜索</span>{busy && <Spinner size={12} />}</div>
      <div className="ide-search">
        <input className="ide-input" value={text} placeholder="在项目中搜索，回车执行" onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void run(); }} autoFocus />
        <button type="button" className={`ide-toggle${caseSensitive ? ' is-on' : ''}`} title="区分大小写" onClick={() => setCase(!caseSensitive)}>Aa</button>
        <button type="button" className={`ide-toggle${regex ? ' is-on' : ''}`} title="正则表达式" onClick={() => setRegex(!regex)}>.*</button>
      </div>
      <div className="ide-results">
        {hits && <div className="ide-results__summary">{hits.length ? `${grouped.length} 个文件中 ${hits.length} 处结果` : '没有结果'}</div>}
        {grouped.map(([path, list]) => (
          <div key={path} className="ide-results__file">
            <div className="ide-results__path"><Icon name="file" size={12} /><span className="truncate">{path}</span><span className="muted num">{list.length}</span></div>
            {list.map(hit => (
              <button key={`${hit.line}:${hit.column}`} type="button" className="ide-results__hit" onClick={() => onOpen(hit.path, hit.line, hit.column)}>
                <span className="muted num">{hit.line}</span>
                <span className="mono truncate">{hit.preview.slice(0, hit.column - 1).trimStart()}<mark>{hit.preview.slice(hit.column - 1, hit.column - 1 + hit.matchLength)}</mark>{hit.preview.slice(hit.column - 1 + hit.matchLength)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const statusLabel = { M: '已修改', A: '新增', D: '已删除', R: '重命名', '?': '未跟踪' } as const;

export function ScmPanel({ scm, onOpenDiff, onCommit, onRefresh }: { scm?: SourceControlView; onOpenDiff: (path: string) => void; onCommit: (message: string, paths: string[]) => Promise<boolean>; onRefresh: () => void }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const commit = async () => {
    if (!scm) return;
    setBusy(true);
    if (await onCommit(message, scm.changes.map(c => c.path))) setMessage('');
    setBusy(false);
  };
  return (
    <div className="ide-panel">
      <div className="ide-panel__head"><span className="grow">源代码管理</span><IconButton icon="refresh" label="刷新" size={14} onClick={onRefresh} /></div>
      {!scm ? <Skeleton lines={5} /> : (
        <>
          <div className="ide-scm__branch"><Icon name="branch" size={13} /><span className="mono">{scm.branch}</span>{scm.ahead > 0 && <span className="muted">↑{scm.ahead}</span>}</div>
          <textarea className="ide-scm__message" rows={3} value={message} placeholder="提交说明（Ctrl+Enter 提交）" onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void commit(); }} />
          <Button size="sm" variant="primary" icon="check" disabled={busy || !message.trim() || !scm.changes.length} onClick={() => void commit()}>{busy ? '提交中…' : `提交 ${scm.changes.length} 项变更`}</Button>
          <div className="ide-scm__label">变更 <span className="num">{scm.changes.length}</span></div>
          {scm.changes.length === 0 ? <EmptyState icon="gitCommit" title="工作区很干净" detail="没有相对上次提交的变更。" /> : scm.changes.map(change => (
            <button key={change.path} type="button" className="ide-scm__change" onClick={() => onOpenDiff(change.path)} title={`${statusLabel[change.status]} · ${change.path}`}>
              <Icon name="file" size={13} className="muted" />
              <span className="grow truncate">{change.path.split('/').pop()}<span className="muted"> {change.path.split('/').slice(0, -1).join('/')}</span></span>
              <span className="diff-stat"><span className="diff-stat__add">+{change.additions}</span>{change.deletions > 0 && <span className="diff-stat__del">−{change.deletions}</span>}</span>
              <span className={`ide-tree__change ide-tree__change--${change.status}`}>{change.status === 'A' ? 'U' : change.status}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
