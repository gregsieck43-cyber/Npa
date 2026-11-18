import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '../../styles/index.css';
import { gateway } from '../../api';
import { setState } from '../../app/store';
import { SettingsView } from '../../features/pages/SettingsView';
import { SessionOptions } from '../../features/session/SessionOptions';

// run.mjs resolves these imports to the explicitly selected production source tree.
// There are no gateway replacements: every read/write uses the real preload + HTTP API.
const root = createRoot(document.getElementById('root')!);
let generation = 0;
Object.assign(window, {
  __render: async (kind: 'settings' | 'session', sessionId: string) => {
    const [settings, session] = await Promise.all([gateway.settings.get(), gateway.sessions.get(sessionId)]);
    setState({ settings, sessions: { [sessionId]: session }, view: { kind: 'settings', section: 'tools' } });
    const id = ++generation;
    root.render(createElement('div', { 'data-render': id }, kind === 'settings'
      ? createElement(SettingsView, { key: id, section: 'tools' })
      : createElement(SessionOptions, { key: id, sessionId, onClose: () => root.render(null) })));
    return id;
  },
});
