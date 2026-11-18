import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '../../styles/index.css';
import { ToolDetail } from '../../features/inspector/ToolDetail';
const root = createRoot(document.getElementById('root')!);
let generation = 0;
Object.assign(window, { __render: (sessionId: string, callId: string) => {
  const id = ++generation;
  root.render(createElement('div', { 'data-render': id }, createElement(ToolDetail, { key: id, sessionId, callId })));
  return id;
} });
