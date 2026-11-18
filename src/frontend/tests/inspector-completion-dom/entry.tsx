import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '../../styles/index.css';

void (async () => {
  const probe = { calls: [] as any[], error: false, renders: 0 };
  Object.assign(window, { __probe: probe, npn: { request: async () => { throw new Error('Unexpected request'); }, desktop: async () => undefined } });
  const { gateway } = await import('../../api');
  const { TracePanel } = await import('../../features/inspector/TracePanel');
  const { ToolsPanel } = await import('../../features/inspector/ToolsPanel');
  const { setState } = await import('../../app/store');
  gateway.inspector.trace = async (id, query = {}) => {
    probe.calls.push({ id, ...query });
    if ((query.text?.length ?? 0) > 300) throw new Error('text must be at most 300 characters');
    if (probe.error) throw new Error('temporary fixture error');
    const offset = Number(query.cursor ?? 0);
    return { startedAt: '2026-11-04T00:00:00Z', hasMore: offset < 2000, nextCursor: String(offset + 200), spans: Array.from({ length: 200 }, (_, i) => ({ id: `trace-${offset+i}`, type: 'model' as const, label: `事件 ${offset+i}`, status: 'ok' as const, startMs: offset+i, durationMs: 1, ...(i > 0 && i < 3 ? { parentId: `trace-${offset+i-1}` } : {}), ...(i === 0 && id === 's1' ? { childSessionId: 'child1' } : {}) })) };
  };
  gateway.inspector.tools = async () => ({ registered: [], allowed: [], exposed: [], calls: [{ id: 'r1:call', sessionId: 's1', requestId: 'r1', toolCallId: 'call', name: 'mcp_call', title: 'actual wrapper', source: 'mcp', capability: 'mcp', risk: 'low', args: { long: 'summary' }, status: 'succeeded', children: [{ id: 'r2:child', sessionId: 's1', requestId: 'r2', parentRequestId: 'r1', name: 'read_file', title: 'child call', source: 'builtin', capability: 'read', risk: 'low', args: {}, status: 'succeeded' }] }] });
  gateway.inspector.toolDetail = async (sessionId, callId, section, offset = 0) => {
    probe.calls.push({ name: 'toolDetail', sessionId, callId, section, offset });
    const content = section === 'schema' ? '{"description":"historic-schema"}' : section === 'description' ? 'historic description' : '甲'.repeat(6000) + 'LAST';
    return { callId, section, available: true, text: content.slice(offset, offset + 6000), offset, totalChars: content.length, sha256: 'stable-sha', ...(offset + 6000 < content.length ? { nextOffset: offset + 6000 } : {}) };
  };
  setState({ inspectorRevision: {} });
  const root = createRoot(document.getElementById('root')!);
  Object.assign(window, { __render: (kind?: string) => { probe.calls = []; probe.error = false; probe.renders++; setState({ inspectorFocus: undefined }); root.render(createElement('div', { 'data-render': probe.renders }, createElement(kind === 'tools' ? ToolsPanel : TracePanel, { sessionId: 's1', key: probe.renders }))); return probe.renders; }, __focus: (id: string) => setState({ inspectorFocus: { toolCallId: id } }), __invalidate: () => setState(s => ({ inspectorRevision: { s1: (s.inspectorRevision.s1 ?? 0)+1 } })) });
})();
