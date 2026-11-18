import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '../../styles/index.css';
import { gateway } from '../../api';
import { setState } from '../../app/store';
import { RequestPanel } from '../../features/inspector/RequestPanel';
import { SettingsView } from '../../features/pages/SettingsView';

const root = createRoot(document.getElementById('root')!);
let count = 0;
Object.assign(window, {
  __render: async (kind: 'request' | 'privacy', sessionId: string) => {
    const settings = await gateway.settings.get();
    setState({ settings, inspectorFocus: undefined, inspectorRevision: {} });
    const id = ++count;
    root.render(createElement('div', { 'data-render': id }, kind === 'request'
      ? createElement(RequestPanel, { key: id, sessionId })
      : createElement(SettingsView, { key: id, section: 'privacy' })));
    return id;
  },
});
