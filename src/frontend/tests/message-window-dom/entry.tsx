import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatMessage, GatewayEvent, SessionDetail } from '../../api/types';
import '../../styles/index.css';

void (async () => {
  let event: (value: GatewayEvent) => void;
  let finishSend: ((value: { sessionId: string; messageId: string }) => void) | undefined;
  let delayDetail = false, finishDetail: ((value: SessionDetail) => void) | undefined;
  const selections: (string | undefined)[] = [];
  const histories = new Map<string, ChatMessage[]>(), calls: string[] = [];
  const summary = (id: string) => ({ id, title: id, mode: id.startsWith('code') ? 'code' as const : 'chat' as const, projectId: 'fixture', status: 'idle' as const, permission: 'ask' as const, modelId: 'fixture', createdAt: '', updatedAt: '' });
  const row = (n: number, text = '完整消息 ' + n): ChatMessage => ({ id: 'm' + n, role: 'assistant', status: 'done', parts: [{ kind: 'text', text }], createdAt: new Date(n * 1000).toISOString() });
  Object.assign(window, { npn: { request: async (_method: string, address: string) => {
    calls.push(address); const url = new URL(address, 'http://fixture');
    if (url.pathname === '/v1/product/connection') return { status: 'online', demo: false };
    if (url.pathname === '/v1/product/settings') return { appearance: { theme: 'light', accent: 'ember', density: 'comfortable', motion: 'full', ambient: false, fontScale: 1 }, defaults: { mode: 'chat', permission: 'ask', modelId: 'fixture' } };
    if (url.pathname === '/v1/product/models' || url.pathname === '/v1/product/approvals' || url.pathname === '/v1/product/workspace/projects') return [];
    if (url.pathname === '/v1/product/sessions') return { items: [] };
    if (url.pathname === '/v1/product/chat/send') return new Promise(resolve => { finishSend = resolve; });
    if (url.pathname.startsWith('/v1/product/metrics/')) return { rounds: 1, modelSteps: 1, tokens: { input: 1, output: 1 }, toolCalls: 0, activeTools: 0 };
    if (url.pathname.startsWith('/v1/product/tasks/')) return null;
    if (url.pathname.startsWith('/v1/product/sessions/')) {
      const id = url.pathname.split('/')[4]!, before = url.searchParams.get('before'), cursor = before?.startsWith('message:') ? Number(before.slice(9)) : before ? Number(before) : Infinity;
      if (id === 'code-late' && delayDetail) return new Promise<SessionDetail>(resolve => { finishDetail = resolve; });
      const messages = (histories.get(id) ?? []).filter(message => Number(message.id.slice(1)) < cursor).slice(-100);
      return { ...summary(id), messages, hasMoreBefore: messages.length === 100, ...(messages.length === 100 ? { beforeCursor: messages[0]!.id.slice(1) } : {}) } satisfies SessionDetail;
    }
    throw new Error('Unexpected fixture route: ' + address);
  }, desktop: async () => {} } });
  const { gateway } = await import('../../api'); gateway.subscribe = listener => { event = listener; return () => {}; };
  const actions = await import('../../app/actions'), { getState, setState } = await import('../../app/store');
  const { SessionView } = await import('../../features/session/SessionView'), { IdeAgent } = await import('../../features/ide/IdeAgent');
  await actions.boot(); const root = createRoot(document.getElementById('root')!);
  function IdeFixture({ fresh = false }: { fresh?: boolean }) {
    const [id, setId] = useState<string | undefined>(fresh ? undefined : 'code-a'), [open, setOpen] = useState(true);
    return open ? createElement(IdeAgent, { projectId: 'fixture', sessionId: id, setSessionId: value => { selections.push(value); setId(value); }, onClose: () => setOpen(false) }) : createElement('div', null, 'Agent 已关闭');
  }
  const emit = (id: string, n: number, status: ChatMessage['status'] = 'done', text?: string) => {
    const message = { ...row(n, text), status };
    if (status !== 'streaming') { const rows = histories.get(id) ?? [], index = rows.findIndex(value => value.id === message.id); if (index < 0) rows.push(message); else rows[index] = message; histories.set(id, rows); }
    event({ type: 'message.upsert', sessionId: id, message });
  };
  Object.assign(window, { __window: {
    async setup(kind: 'session' | 'ide' | 'ide-new', chars = 0) {
      actions.goHome(); histories.clear(); calls.length = 0; selections.length = 0; finishSend = undefined; delayDetail = false; finishDetail = undefined; const id = kind.startsWith('ide') ? 'code-a' : 'a';
      histories.set(id, Array.from({ length: 240 }, (_, n) => row(n + 1, chars ? '字'.repeat(chars) : undefined)));
      setState({ sessions: { [id]: summary(id) }, layout: { ...getState().layout, fileTreeOpen: false }, drafts: { [id]: '未发送草稿' } });
      if (kind.startsWith('ide')) { actions.openIdeView('fixture'); root.render(createElement(IdeFixture, { key: Date.now(), fresh: kind === 'ide-new' })); }
      else { await actions.openSession(id); root.render(createElement(SessionView, { id })); }
    }, emit, finishSend: (holdDetail = false) => { delayDetail = holdDetail; finishSend!({ sessionId: 'code-late', messageId: 'late' }); }, finishDetail: () => finishDetail!({ ...summary('code-late'), messages: [], hasMoreBefore: false }), burst: (from: number, through: number) => { for (let n = from; n <= through; n++) emit('a', n); },
    state: () => { const s = getState(), id = s.detailSessionId, detail = id ? s.details[id] : undefined; return { id, ids: detail?.messages.map(m => m.id), count: detail?.messages.length ?? 0, chars: JSON.stringify(detail?.messages ?? []).length, details: Object.keys(s.details), metrics: Object.keys(s.metrics), history: s.messageWindow?.history, hasMoreBefore: detail?.hasMoreBefore, calls, last: detail?.messages.at(-1), drafts: s.drafts, selections, pendingSend: Boolean(finishSend), pendingDetail: Boolean(finishDetail) }; },
  } });
})();
