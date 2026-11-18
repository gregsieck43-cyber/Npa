import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Collapse, Menu, Modal, Popover } from '../../components/ui';
import { CopyButton } from '../../components/rich';
import { Toasts } from '../../features/shell/Overlays';
import { CommandPalette } from '../../features/shell/CommandPalette';
import { notify, togglePalette } from '../../app/actions';
import { getState } from '../../app/store';
import '../../styles/index.css';

const source = '完整正文😀\n'.repeat(20000);
let write: ((text: string) => Promise<void>) = async () => {};
let copied = '', settle: (() => void) | undefined, fail: (() => void) | undefined;
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => { copied = text; return write(text); } } });
function Fixture() {
  const [menu, setMenu] = useState(false), [modal, setModal] = useState(false), [expanded, setExpanded] = useState(true);
  const anchor = useRef<HTMLButtonElement>(null);
  Object.assign(window, { __u1: {
    menu: (open: boolean) => flushSync(() => setMenu(open)), modal: (open: boolean) => flushSync(() => setModal(open)), collapse: (open: boolean) => flushSync(() => setExpanded(open)),
    copyMode(mode: string) { copied = ''; write = mode === 'pending' ? () => new Promise<void>((resolve, reject) => { settle = resolve; fail = () => reject(new Error('clipboard denied')); }) : mode === 'fail' ? async () => { throw new Error('clipboard denied'); } : async () => {}; },
    resolve: () => settle?.(), reject: () => fail?.(), copied: () => copied, sourceLength: source.length,
    toast: () => notify('success', '可暂停通知', '悬停或键盘聚焦暂停'), toastCount: () => getState().toasts.length,
  } });
  return <main style={{ padding: 32, display: 'grid', gap: 16 }}>
    <button ref={anchor} id="menu-trigger" onClick={() => setMenu(value => !value)}>菜单</button>
    <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)}><Menu onClose={() => setMenu(false)} items={[
      { id: 'first', label: '第一项', onSelect: () => {} }, { id: 'disabled', label: '禁用项', disabled: true, onSelect: () => {} },
      { id: 'last', label: '最后一项', onSelect: () => {} },
    ]} /></Popover>
    <button id="modal-trigger" onClick={() => setModal(true)}>对话框</button>
    <Modal open={modal} title={modal ? '保留标题' : ''} onClose={() => setModal(false)} footer={<button>确认</button>}>{modal ? <input aria-label="对话框输入" defaultValue="保留正文" /> : null}</Modal>
    <section id="collapse-test"><Collapse open={expanded}><input aria-label="折叠内容" defaultValue="保留输入" /></Collapse></section>
    <CopyButton text={source} label="复制完整正文" />
    <button id="palette-trigger" onClick={() => togglePalette(true)}>命令面板</button>
    <CommandPalette /><Toasts />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
