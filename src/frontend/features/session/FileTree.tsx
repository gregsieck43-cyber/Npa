import { useEffect, useState } from 'react';
import { gateway, type FileNode } from '../../api';
import { guard } from '../../app/actions';
import { setLayout } from '../../app/store';
import { Icon } from '../../components/Icon';
import { CodeBlock } from '../../components/rich';
import { Button, IconButton, Skeleton } from '../../components/ui';

function Node({ node, depth, onOpen, active }: { node: FileNode; depth: number; onOpen: (path: string) => void; active?: string }) {
  const [open, setOpen] = useState(depth < 2);
  if (node.kind === 'dir') {
    return (
      <div>
        <button type="button" className="tree__row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="muted" />
          <Icon name={open ? 'folderOpen' : 'folder'} size={14} className="tree__folder" />
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children?.map(child => <Node key={child.path} node={child} depth={depth + 1} onOpen={onOpen} active={active} />)}
      </div>
    );
  }
  return (
    <button type="button" className={`tree__row${active === node.path ? ' is-active' : ''}`} style={{ paddingLeft: 26 + depth * 14 }} onClick={() => onOpen(node.path)}>
      <Icon name="file" size={13} className="muted" />
      <span className="truncate grow">{node.name}</span>
      {node.change && <span className={`tree__change tree__change--${node.change}`}>{node.change}</span>}
    </button>
  );
}

export function FileTree({ projectId }: { projectId?: string }) {
  const [nodes, setNodes] = useState<FileNode[]>();
  const [peek, setPeek] = useState<{ path: string; text?: string }>();

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    void guard('读取文件树失败', () => gateway.workspace.files(projectId)).then(result => { if (alive) setNodes(result ?? []); });
    return () => { alive = false; };
  }, [projectId]);

  const open = async (path: string) => {
    setPeek({ path });
    const text = await guard('读取文件失败', () => gateway.workspace.readFile(projectId!, path));
    setPeek(current => (current?.path === path ? { path, text: text ?? '' } : current));
  };

  return (
    <>
      <aside className="tree">
        <div className="tree__head">
          <span className="grow">文件</span>
          <IconButton icon="external" label="在 IDE 中打开" size={14} onClick={() => void gateway.desktop.openIde(projectId)} />
          <IconButton icon="panelLeft" label="收起文件树" size={14} onClick={() => setLayout({ fileTreeOpen: false })} />
        </div>
        <div className="tree__body">
          {!projectId && <div className="muted tree__empty">该会话未绑定项目</div>}
          {projectId && !nodes && <Skeleton lines={6} />}
          {nodes?.map(node => <Node key={node.path} node={node} depth={0} onOpen={path => void open(path)} active={peek?.path} />)}
        </div>
      </aside>
      {peek && (
        <div className="peek">
          <div className="peek__head">
            <Icon name="file" size={14} /><span className="mono truncate grow">{peek.path}</span>
            <Button size="sm" variant="ghost" icon="external" onClick={() => void gateway.desktop.openIde(projectId)}>IDE</Button>
            <IconButton icon="x" label="关闭预览" onClick={() => setPeek(undefined)} />
          </div>
          <div className="peek__body">{peek.text === undefined ? <Skeleton lines={10} /> : <CodeBlock code={peek.text} lang={peek.path.split('.').pop()} title={peek.path.split('/').pop()} numbered />}</div>
        </div>
      )}
    </>
  );
}
