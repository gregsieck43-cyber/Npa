import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Menu, Popover } from '../../components/ui';
import '../../styles/index.css';
function Fixture() {
  const [open, setOpen] = useState(false), anchor = useRef<HTMLButtonElement>(null);
  return <><button ref={anchor} onClick={() => setOpen(true)}>菜单</button><Popover anchor={anchor} open={open} onClose={() => setOpen(false)}><Menu onClose={() => setOpen(false)} items={[
    { id: 'first', label: '第一项', onSelect: () => {} }, { id: 'disabled', label: '禁用项', disabled: true, onSelect: () => {} }, { id: 'last', label: '最后一项', onSelect: () => {} },
  ]} /></Popover></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
