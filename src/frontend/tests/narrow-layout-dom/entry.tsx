import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { RequestRecordView, TaskDetail } from '../../api';
import '../../styles/index.css';

void (async () => {
  Object.assign(window, { npn: { request: async () => { throw new Error('Unexpected request in layout fixture'); }, desktop: async () => { throw new Error('Unexpected desktop call'); } } });
  const { gateway } = await import('../../api');
  const { setState } = await import('../../app/store');
  const { TaskBoard } = await import('../../features/session/TaskBoard');
  const { StatusBar } = await import('../../features/shell/StatusBar');
  const { RequestPanel } = await import('../../features/inspector/RequestPanel');
  const task: TaskDetail = { id: 'layout-task', title: '递增验收计数器 increment counter 一次与完整任务标题', status: 'completed', phase: 'completed',
    goal: { objective: '完整任务目标', constraints: [], acceptance: [], mode: 'autonomous' },
    plan: [{ id: 'step', title: 'Complete', status: 'done' }], budget: { modelCalls: 3, maxModelCalls: 12, toolCalls: 1, maxToolCalls: 20, tokens: 18000 },
    checkpoints: [], subagents: [], verification: { status: 'pass', items: [] }, startedAt: '', updatedAt: '' };
  const endpoint = 'http://127.0.0.1:61115/provider/' + 'very-long-provider-route-'.repeat(12) + '/v1/chat/completions?fixture=complete';
  const record: RequestRecordView = { id: 'layout-request', kind: 'work', status: 'completed', createdAt: '2026-11-04', model: 'fixture-model', endpoint,
    body: { model: 'fixture-model', messages: [{ role: 'user', content: 'fixture' }] }, redactions: [] };
  gateway.inspector.requests = async () => [record];
  setState({ connection: { status: 'online', demo: false }, view: { kind: 'session', id: 'layout' },
    sessions: { layout: { id: 'layout', title: task.title, mode: 'cowork', status: 'completed', permission: 'ask', modelId: 'fixture', createdAt: '', updatedAt: '' } },
    models: [{ id: 'fixture', name: '默认提供方', model: 'fixture', provider: 'fixture', mode: 'mock', credentialPresent: false }],
    metrics: { layout: { rounds: 1, modelSteps: 3, tokens: { input: 18000, output: 196 }, toolCalls: 2, activeTools: 0, lastLatencyMs: 7100, tokensPerSecond: 5, contextUsed: 1000, contextWindow: 64000 } },
    inspectorRevision: {}, inspectorFocus: undefined });
  const root = createRoot(document.getElementById('root')!); let sequence = 0;
  Object.assign(window, { __fixture: { endpoint, title: task.title }, __render: (width: number, kind: 'task' | 'request') => {
    const id = ++sequence;
    root.render(createElement('div', { 'data-render': id, style: { width, height: 580, margin: 12 }, className: 'stage' }, kind === 'task'
      ? createElement('div', { className: 'stage__view' }, createElement('div', { className: 'session' }, createElement('div', { className: 'session__main' },
        createElement('div', { className: 'thread' }, createElement('div', { className: 'thread__column' }, createElement(TaskBoard, { key: id, task }))))), createElement(StatusBar))
      : createElement(RequestPanel, { key: id, sessionId: 'layout' })));
    return id;
  } });
})();
