import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '../../styles/index.css';

void (async () => {
  const state = { calls: [] as { name: string; args: unknown[] }[], fail: '', delay: '', resume: undefined as undefined | (() => void), supportsDeveloper: true, downloads: [] as unknown[], renders: 0 };
  Object.assign(window, { __probe: state, npn: { request: async () => { throw new Error('Unexpected bridge request'); }, desktop: async () => { throw new Error('Unexpected desktop request'); } } });
  const { gateway } = await import('../../api');
  const { setState } = await import('../../app/store');
  const { RequestPanel } = await import('../../features/inspector/RequestPanel');
  const { PromptPanel } = await import('../../features/inspector/PromptPanel');
  const { SessionOptions } = await import('../../features/session/SessionOptions');
  const { Composer } = await import('../../features/session/Composer');
  const body = { model: 'test-model', temperature: 0.5, max_tokens: 100, messages: [{ role: 'system', content: 'Policy', cache_control: { type: 'ephemeral' } }, { role: 'user', content: 'Question' }], tools: [], tool_choice: 'none', context: { selected: ['doc'] }, vendor_extra: { keep: true } };
  const record = (id: string, text: string) => ({ id, kind: 'chat' as const, model: 'test-model', endpoint: '/chat/completions', createdAt: '2026-10-30T00:00:00Z', status: 'completed' as const, redactions: [], body: { ...body, model: text } });
  const prompt = { parts: ['systemPrompt', 'developerPrompt', 'dynamic'].map((id, i) => ({ id: `session:${id}`, label: id, role: i === 1 ? 'developer' : 'system', source: 'session', scope: 'session', merge: 'override', content: `Current ${id}`, tokens: 3, effective: true, editable: true, version: 2 })), totalTokens: 9, pendingEdits: 0 };
  const requestPreset = { id: 'preset-r', name: 'Request sample', kind: 'request', scope: 'session', scopeId: 's1', version: 2, createdAt: '2026-10-30', value: { ...body, model: 'preset-model' } };
  const promptPreset = { id: 'preset-p', name: 'Prompt sample', kind: 'prompt', scope: 'session', scopeId: 's1', version: 2, createdAt: '2026-10-30', value: { systemPrompt: 'Preset system', developerPrompt: '', dynamic: 'Preset dynamic' } };
  const settings = { sessionId: 's1', parameters: { temperature: 0.5 }, capabilities: { web: true, tools: true, mcp: false, skills: false, projectInstructions: true }, supported: { web: true, tools: true, mcp: false, skills: true, projectInstructions: true }, unsupportedReasons: { mcp: 'Chat 只读模式不支持 MCP；请升级为 Cowork。' }, model: 'test-model', supportsDeveloper: true, maxOutputTokens: 1000 };
  const call = (name: string, result: (...args: any[]) => unknown) => async (...args: unknown[]) => {
    state.calls.push({ name, args: structuredClone(args) });
    if (state.fail === name) throw new Error(`fixture ${name} rejected`);
    if (state.delay === name) await new Promise<void>(resolve => { state.resume = resolve; });
    const query = ['presets', 'presetVersions'].includes(name) ? args[0] : args[1];
    if (['presets', 'presetVersions', 'promptVersions', 'requestVersions'].includes(name)) {
      const limit = (query as { limit?: number })?.limit;
      const maximum = name === 'requestVersions' ? 10 : 20;
      if (limit !== undefined && limit > maximum) throw new Error(`limit must not exceed ${maximum}`);
    }
    return structuredClone(await result(...args));
  };
  Object.assign(gateway.inspector, {
    requests: call('requests', () => [record('r1', 'original-model'), record('r2', 'sibling-model')]), prompt: call('prompt', () => prompt),
    savePrompt: call('savePrompt', () => prompt), replay: call('replay', (_id, value, mode) => ({ ...record('r-sent', value.model), body: value, status: mode === 'branch' ? 'draft' : 'completed' })),
  });
  Object.assign(gateway.library, {
    validateRequest: call('validateRequest', (_session, body) => { if (JSON.stringify(body).includes('forbidden-secret')) throw new Error('Secret rejected'); return { body }; }),
    presets: call('presets', query => ({ items: [query.kind === 'prompt' ? promptPreset : requestPreset] })),
    presetVersions: call('presetVersions', query => ({ items: [query.id === 'preset-p' ? promptPreset : requestPreset].map(p => ({ ...p, version: 1, value: { ...p.value, model: 'old-preset' } })) })),
    preset: call('preset', query => ({ ...(query.id === 'preset-p' ? promptPreset : requestPreset), version: query.version })),
    savePreset: call('savePreset', input => ({ ...input, id: input.id ?? 'new-preset', scopeId: 's1', version: (input.expectedVersion ?? 0) + 1, createdAt: '2026-10-30' })),
    requestVersions: call('requestVersions', (_id, query) => ({ items: query.cursor ? [record('r0', 'older-version')] : [record('r1', 'first-version'), record('r2', 'second-version')], nextCursor: query.cursor ? undefined : 'older' })),
    promptVersions: call('promptVersions', (_id, query) => ({ items: (query.cursor ? [0] : [1, 2]).map(version => ({ scope: query.scope, scopeId: 's1', version, systemPrompt: `System version ${version}`, developerPrompt: '', dynamic: '' })), nextCursor: query.cursor ? undefined : 'older' })),
    sessionSettings: call('sessionSettings', () => ({ ...settings, supportsDeveloper: state.supportsDeveloper })), saveSessionSettings: call('saveSessionSettings', (_id, input) => ({ ...settings, ...input })),
    exportConversation: call('exportConversation', (_id, query) => ({ format: 'npn-conversation-v1', sessionId: 's1', session: { title: 'Session' }, snapshot: 'snapshot-1', messages: query.cursor ? [] : [{ id: 'm1', content: 'Message' }], requests: query.cursor ? [record('r1', 'exported')] : [], fragments: [], ...(query.cursor ? {} : { nextCursor: 'export-2' }) })),
  });
  const originalUrl = URL.createObjectURL;
  URL.createObjectURL = blob => { void blob.text().then(value => state.downloads.push(JSON.parse(value))); return originalUrl(blob); };
  HTMLAnchorElement.prototype.click = function () {};
  const session = { id: 's1', mode: 'chat', title: 'Session', status: 'idle', createdAt: '', updatedAt: '', permission: 'ask', modelId: 'model-1' };
  setState({ view: { kind: 'session', id: 's1' }, sessions: { s1: session } as any, models: [], details: {} });
  const root = createRoot(document.getElementById('root')!);
  Object.assign(window, { __sessionMode: (mode: 'chat' | 'cowork') => setState({ sessions: { s1: { ...session, mode } } as any }), __focusRequest: (id: string) => setState({ inspectorFocus: { requestId: id } }), __render: (kind: string) => {
    state.calls = []; state.fail = ''; state.delay = ''; state.resume = undefined; state.downloads = []; state.renders++;
    setState({ inspectorFocus: undefined });
    const props = { key: `${kind}-${state.renders}`, sessionId: 's1', onClose: () => {} };
    root.render(createElement('div', { 'data-render': state.renders }, createElement(kind === 'request' ? RequestPanel : kind === 'prompt' ? PromptPanel : kind === 'composer' ? Composer : SessionOptions, props)));
    return state.renders;
  } });
})();
