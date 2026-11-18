import '../interaction-feedback-dom/entry';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ApprovalDecision, CoordinationNotice, FileClaimView, NpnGateway } from '../../api';

void (async () => {
  while (!(window as unknown as { __interaction?: unknown }).__interaction) await new Promise(resolve => setTimeout(resolve, 0));
  const { gateway } = await import('../../api');
  const { setState, getState } = await import('../../app/store');
  const { CoordinationPanel, CoordinationHint } = await import('../../features/panel/CoordinationPanel');
  const { ApprovalCard } = await import('../../features/session/ToolCard');
  document.getElementById('root')!.hidden = true; document.getElementById('extra')!.hidden = true;
  const element = document.createElement('div'); element.id = 'coord-fixture'; document.body.append(element); const root = createRoot(element);
  const calls: { method: string; value: unknown }[] = [], notices: CoordinationNotice[] = [];
  const claims: FileClaimView[] = [];
  let sendFails = true, ackFails = false, delayed = false, held: (() => void) | undefined;
  const summary = (id: string) => ({ id, title: id, mode: 'code' as const, status: 'running' as const, permission: 'full-access' as const, modelId: 'fixture', createdAt: '', updatedAt: '' });
  const coordination: NonNullable<NpnGateway['coordination']> = {
    async claims(query) { calls.push({ method: 'claims', value: query }); const start = query.after ? Number(query.after) : 0; return { items: claims.slice(start, start + 40), nextCursor: claims.length > start + 40 ? String(start + 40) : undefined }; },
    async claim(sessionId, paths) { calls.push({ method: 'claim', value: { sessionId, paths } }); const created = paths.map((value, index) => ({ id: `new-${index}`, taskId: sessionId, path: value, mode: 'editing' as const, ownerEpoch: 'epoch', incarnation: 'one', revision: 1 })); claims.push(...created); return created; },
    async release(sessionId, ids) { calls.push({ method: 'release', value: { sessionId, ids } }); for (const id of ids) { const index = claims.findIndex(item => item.id === id && item.taskId === sessionId); if (index >= 0) claims.splice(index, 1); } },
    async presence(query) { calls.push({ method: 'presence', value: query }); const start = query.after ? Number(query.after) : 0; return { items: Array.from({ length: start ? 5 : 40 }, (_, n) => ({ id: `peer-${start + n}`, workspace: 'J:/fixture', title: n === 0 ? '<img src=x onerror=alert(1)>' : `任务 ${start + n}`, objective: '共享工作区内的参考目标', status: 'waiting_input', activation: 1, generation: 2, policyEpoch: 3, heartbeatAt: new Date().toISOString() })), nextCursor: start ? undefined : '40' }; },
    async inbox(sessionId, query = {}) { calls.push({ method: 'inbox', value: { sessionId, ...query } }); const through = query.through ?? notices.length; const rows = notices.filter(item => item.seq > (query.after ?? 0) && item.seq <= through); const items = rows.slice(0, query.limit ?? 40).map(item => ({ ...item })); return { items, through, nextCursor: rows.length > items.length ? items.at(-1)!.seq : undefined }; },
    async ack(sessionId, noticeIds) { calls.push({ method: 'ack', value: { sessionId, noticeIds } }); if (ackFails) throw new Error('已读保存失败'); for (const notice of notices) if (noticeIds.includes(notice.id)) notice.operatorSeenAt = new Date().toISOString(); },
    async send(input) { calls.push({ method: 'send', value: input }); if (delayed) await new Promise<void>(resolve => { held = resolve; }); if (sendFails) throw new Error('暂未取得发送回执'); return { id: 'receipt-1' }; },
  };
  const reset = () => {
    notices.splice(0); calls.splice(0); claims.splice(0); for (let n = 0; n < 45; n++) claims.push({ id: `claim-${n}`, taskId: n === 0 ? 'work-a' : 'peer-1', path: `src/file-${n}.ts`, mode: 'editing', ownerEpoch: 'epoch', incarnation: 'one', revision: 1 }); for (let n = 1; n <= 85; n++) notices.push({ id: `notice-${n}`, seq: n, kind: 'peer_message', senderId: 'peer-1', senderKind: 'work', payload: { kind: 'question', body: n === 1 ? '<script>window.__untrusted = true</script>' : `协调正文 ${n}` }, sha256: `sha-${n}`, createdAt: new Date().toISOString(), ackedAt: n === 1 ? new Date().toISOString() : null, operatorSeenAt: null });
    gateway.coordination = coordination; setState({ sessions: { 'work-a': summary('work-a'), 'work-b': summary('work-b') }, view: { kind: 'session', id: 'work-a' }, projectId: 'fixture' });
  };
  Object.assign(window, { __coord: {
    setup() { reset(); root.render(createElement(CoordinationPanel, { key: Date.now(), sessionId: 'work-a' })); },
    unavailable() { gateway.coordination = undefined; root.render(createElement(CoordinationPanel, { key: 'unsupported', sessionId: 'work-a' })); },
    hint() { gateway.coordination = coordination; root.render(createElement(CoordinationHint, { sessionId: 'work-a' })); },
    external() {
      gateway.coordination = { ...coordination, presence: async query => ({ ...await coordination.presence(query), external: { items: [{ id: 'external-untrusted', source: 'external', advisory: true, label: '<script>external writer</script>', objective: 'External advisory', claims: ['shared.ts'], observedAt: new Date().toISOString() }], truncated: true, rejected: 2 } }) };
      root.render(createElement(CoordinationPanel, { key: 'external', sessionId: 'work-a' }));
    },
    change() { const seq = notices.length + 1; notices.push({ ...notices[1]!, id: `notice-${seq}`, seq }); setState({ coordinationRevision: (getState().coordinationRevision ?? 0) + 1 }); },
    calls: () => calls,
    sending(fail: boolean, hold = false) { sendFails = fail; delayed = hold; }, finish() { held?.(); },
    ackFailure(value: boolean) { ackFails = value; },
    readOnly() { setState({ sessions: { ...getState().sessions, 'work-a': { ...summary('work-a'), permission: 'read-only' } } }); },
    approval() {
      gateway.approvals.decide = async (id: string, decision: ApprovalDecision) => { calls.push({ method: 'approval', value: { id, decision } }); throw new Error('冲突状态已变化，请重新核对'); };
      root.render(createElement(ApprovalCard, { approval: { id: 'approval-conflict', sessionId: 'work-a', toolCallId: 'tool', title: '写入文件', reason: '同一文件正在被其他任务修改', capability: 'write', risk: 'medium', preview: '修改内容', previewKind: 'text', digest: 'displayed-intent-sha', createdAt: '', conflict: { fingerprint: 'displayed-conflict-sha', participants: [{ taskId: 'peer-1', path: 'src/shared.ts', mode: 'editing' }] } } }));
    },
  } });
})();
