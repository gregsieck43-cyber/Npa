import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '../../styles/index.css';

void (async () => {
  const probe = { calls: [] as any[], content: 'Current system', pending: 0, revision: 0, renders: 0 };
  Object.assign(window, { __probe: probe, npn: { request: async () => { throw new Error('Unexpected request'); }, desktop: async () => undefined } });
  const { gateway } = await import('../../api');
  const { setState } = await import('../../app/store');
  const { PromptPanel } = await import('../../features/inspector/PromptPanel');
  const { InspectorBody } = await import('../../features/inspector/Inspector');
  const view = (id?: string) => {
    const part = { id: 'session:systemPrompt', label: 'System', role: 'system' as const, scope: 'session' as const, source: 'session fixture', content: id ? 'Old request system v1' : probe.content, tokens: 3, tokensExact: false, effective: true, merge: 'override' as const, editable: true, version: id ? 1 : 2 };
    return { ...(id ? { requestId: id } : {}), totalTokens: 3, totalTokensExact: Boolean(id), pendingEdits: id ? 0 : probe.pending, parts: [part, { ...part, id: 'effective:0', label: '有效消息 1', source: 'provider body / messages/0', scope: 'request' as const, editable: false }] };
  };
  gateway.inspector.prompt = async (sessionId, requestId) => { probe.calls.push({ name: 'prompt', sessionId, requestId }); return view(requestId); };
  gateway.inspector.savePrompt = async (sessionId, partId, content, scope) => { probe.calls.push({ name: 'save', sessionId, partId, content, scope }); probe.content = content; probe.pending = scope === 'request' ? 1 : 0; return view(); };
  gateway.inspector.requests = async () => [{ id: 'r-old', kind: 'chat', status: 'completed', createdAt: '2026-11-04T00:00:00Z', model: 'mock', endpoint: 'mock', body: { model: 'mock', messages: [] }, redactions: [] }];
  const root = createRoot(document.getElementById('root')!);
  Object.assign(window, {
    __render: (kind: string) => { probe.calls = []; probe.content = 'Current system'; probe.pending = 0; probe.renders++; setState({ inspectorFocus: undefined, inspectorTab: kind === 'inspector' ? 'request' : 'prompt', inspectorRevision: {} }); root.render(createElement('div', { 'data-render': probe.renders }, createElement(kind === 'inspector' ? InspectorBody : PromptPanel, { sessionId: 's1', key: probe.renders }))); return probe.renders; },
    __focus: (requestId?: string) => setState({ inspectorFocus: requestId ? { requestId } : undefined }),
    __consume: () => { probe.content = 'Fresh system after consumption'; probe.pending = 0; probe.revision++; setState({ inspectorRevision: { s1: probe.revision } }); },
  });
})();
