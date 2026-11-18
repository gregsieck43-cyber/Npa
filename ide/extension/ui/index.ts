import './styles.css';
import type { IdeAgentView } from '../../../src/ide/types.js';
import { richText } from '../../../src/ui/dom.js';

declare function acquireVsCodeApi(): { postMessage(value: unknown): void; getState(): any; setState(value: unknown): void };
const api = acquireVsCodeApi();
const app = document.getElementById('app')!;
const saved = api.getState() ?? {}, drafts: Record<string, string> = saved.drafts ?? {};
let mode: 'chat' | 'work' = 'chat', data: IdeAgentView | undefined, connected = false, trusted = false, busy = false, scope = 'chat:unbound-new', messageFingerprint = '', context: any, viewVersion = 0, configurationDirty = false;
const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: number }>();

// ---------- DOM 工具 ----------
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => { const element = document.createElement(tag); element.className = className; element.textContent = text; return element; };
/** 描边图标（与桌面前端同一套路径），用于替代字符图标。 */
const iconPaths: Record<string, string[]> = {
  chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  theme: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  plus: ['M5 12h14', 'M12 5v14'],
  arrow: ['m5 12 7-7 7 7', 'M12 19V5'],
  tool: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'],
  shield: ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z', 'M12 8v4', 'M12 16h.01'],
  code: ['m16 18 6-6-6-6', 'm8 6-6 6 6 6'],
  eye: ['M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  activity: ['M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2'],
  terminal: ['m4 17 6-6-6-6', 'M12 19h8'],
};
const svg = (name: string, size = 14) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  element.setAttribute('viewBox', '0 0 24 24'); element.setAttribute('width', String(size)); element.setAttribute('height', String(size)); element.setAttribute('aria-hidden', 'true');
  element.setAttribute('fill', 'none'); element.setAttribute('stroke', 'currentColor'); element.setAttribute('stroke-width', '1.8'); element.setAttribute('stroke-linecap', 'round'); element.setAttribute('stroke-linejoin', 'round');
  element.classList.add('ico');
  for (const d of iconPaths[name]) { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); element.append(path); }
  return element;
};
const button = (label: string, action: () => void, className = '', id = '', icon?: string) => {
  const element = node('button', className); element.type = 'button';
  if (icon) element.append(svg(icon));
  if (label) element.append(node('span', 'label', label));
  element.addEventListener('click', action);
  if (id) element.dataset.testid = id;
  return element;
};
const setLabel = (element: HTMLElement, text: string) => { const label = element.querySelector<HTMLElement>('.label'); if (label) label.textContent = text; else element.textContent = text; };

// ---------- 与扩展宿主的消息协议（保持不变） ----------
const call = (op: string, values: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
  const id = crypto.randomUUID(), timer = window.setTimeout(() => { pending.delete(id); reject(new Error('响应尚未确认，请核对当前状态，勿重复发送。')); }, 120000);
  pending.set(id, { resolve, reject, timer }); api.postMessage({ id, op, viewVersion, workspaceId: data?.workspace.id, workspacePath: data?.workspace.path, ...values });
});
const error = node('div', 'error-banner'); error.hidden = true; error.dataset.testid = 'agent-error';
async function run(op: string, values: Record<string, unknown> = {}) { try { error.hidden = true; return await call(op, values); } catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); error.hidden = false; throw reason; } }
const fire = (op: string, values: Record<string, unknown> = {}) => { void run(op, values).catch(() => undefined); };
const persist = () => { api.setState({ drafts, tools: tools.checked, profile: profile.value }); };
function saveDraft() { drafts[scope] = input.value; persist(); fire('draft', { key: scope, content: input.value }); }

// ---------- 结构 ----------
const shell = node('div', 'agent-shell');
const header = node('header', 'agent-header');
const logo = node('img', 'agent-logo'); logo.alt = 'NPN'; logo.hidden = true;
const brand = node('div', 'brand'); brand.append(node('strong', '', 'NPN Gamma'), node('span', '', 'Agent 工作台'));
const themeButton = button('', () => fire('theme'), 'icon', 'agent-theme', 'theme'); themeButton.title = '切换明暗主题';
const connection = button('连接中', () => fire('connect'), 'connection', 'agent-connection');
header.append(logo, brand, themeButton, connection);

const nav = node('nav', 'mode-bar');
const segment = node('div', 'segment');
const chat = button('Chat', () => fire('mode', { mode: 'chat' }), 'mode active', 'agent-mode-chat');
const work = button('Work', () => fire('mode', { mode: 'work' }), 'mode', 'agent-mode-work');
segment.append(chat, work);
nav.append(segment, node('span', 'grow'), button('新建', () => fire('new'), 'quiet chip', 'agent-new', 'plus'));

const contextCard = node('section', 'context-card');
const projectRow = node('div', 'project-row'), projectName = node('span', 'project-name', '选择项目');
const projectIcon = node('span', 'project-symbol'); projectIcon.append(svg('folder'));
const projectButton = button('', () => fire('openProject'), 'icon', 'agent-project', 'external'); projectButton.title = '打开项目';
projectRow.append(projectIcon, projectName, node('span', 'grow'), projectButton);
const picker = node('select', 'scope-picker'); picker.setAttribute('aria-label', '当前任务或对话'); picker.dataset.testid = 'agent-scope'; picker.addEventListener('change', () => { if (picker.value) fire('select', { value: picker.value }); else fire('new'); });
const statusRow = node('div', 'runtime-row'), statusDot = node('span', 'runtime-dot'), statusText = node('span', 'runtime-label', '尚未运行'); statusText.dataset.testid = 'agent-status';
const taskActions = node('div', 'runtime-actions');
statusRow.append(statusDot, statusText, node('span', 'grow'), taskActions);
contextCard.append(projectRow, picker, statusRow);

const conversation = node('section', 'conversation'); conversation.setAttribute('aria-label', 'Agent 对话与执行'); conversation.dataset.testid = 'agent-conversation';

const footer = node('footer', 'composer');
const composerCard = node('div', 'composer-card');
const contextRow = node('div', 'context-row');
const contextLabel = node('span', 'context-label', '从编辑器添加代码上下文'); contextLabel.dataset.testid = 'agent-context';
const contextIcon = node('span', 'context-icon'); contextIcon.append(svg('code', 12));
contextRow.append(contextIcon, contextLabel, node('span', 'grow'), button('选区', () => fire('addSelection'), 'quiet chip', 'agent-add-selection', 'plus'));
const input = node('textarea', 'composer-input'); input.placeholder = '描述你的问题，或添加选区让 Agent 参与…'; input.setAttribute('aria-label', '发送给 NPN Agent'); input.dataset.testid = 'agent-input'; input.maxLength = 100000;
let draftTimer: number | undefined;
input.addEventListener('input', () => { const key = scope, content = input.value; drafts[key] = content; persist(); clearTimeout(draftTimer); draftTimer = window.setTimeout(() => fire('draft', { key, content }), 300); });
input.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } });
const goalOptions = node('details', 'goal-options');
goalOptions.append(node('summary', '', '目标约束、验收与预算'));
const constraints = node('textarea', 'goal-field'); constraints.placeholder = '执行约束，每行一项'; constraints.setAttribute('aria-label', '执行约束');
const acceptance = node('textarea', 'goal-field'); acceptance.placeholder = '验收条件，例如 file:result.txt'; acceptance.setAttribute('aria-label', '验收条件');
const limits = node('div', 'limits');
const modelLimit = node('input'), toolLimit = node('input'); modelLimit.type = toolLimit.type = 'number'; modelLimit.value = '20'; toolLimit.value = '100'; modelLimit.min = toolLimit.min = '1'; modelLimit.max = toolLimit.max = '10000';
for (const [label, element] of [['模型调用上限', modelLimit], ['工具调用上限', toolLimit]] as const) { const field = node('label'); field.append(node('span', '', label), element); limits.append(field); }
goalOptions.append(constraints, acceptance, limits);
const composerBar = node('div', 'composer-bar');
const toolsLabel = node('label', 'tools-toggle'), tools = node('input'); tools.type = 'checkbox'; tools.checked = Boolean(saved.tools); tools.dataset.testid = 'agent-tools-toggle';
toolsLabel.append(tools, node('span', 'switch'), node('span', '', '启用工具 · 执行前审批'));
const profile = node('select', 'profile-select'); profile.setAttribute('aria-label', '模型配置'); profile.dataset.testid = 'agent-model';
tools.addEventListener('change', () => { configurationDirty = true; persist(); });
profile.addEventListener('change', () => { configurationDirty = true; persist(); });
const sendButton = button('发送', () => { void send(); }, 'send-button', 'agent-send', 'arrow');
composerBar.append(toolsLabel, node('span', 'grow'), profile, sendButton);
composerCard.append(contextRow, input, goalOptions, composerBar);
const metrics = node('div', 'metrics-line', '暂无模型调用 · 原生编辑不消耗模型额度'); metrics.dataset.testid = 'agent-metrics';
const inspection = node('div', 'inspection-bar');
inspection.append(button('实际请求', () => fire('inspect', { kind: 'request' }), 'quiet chip', 'agent-inspect-request', 'eye'), button('任务 / 轨迹', () => fire('inspect', { kind: 'trace' }), 'quiet chip', 'agent-inspect-trace', 'activity'), button('原生终端', () => fire('terminal'), 'quiet chip', 'agent-terminal', 'terminal'), button('Harness', () => fire('openDesktop'), 'quiet chip', 'agent-desktop', 'external'));
footer.append(composerCard, metrics, inspection);
shell.append(header, nav, contextCard, error, conversation, footer); app.append(shell);

// ---------- 状态渲染 ----------
const statusName = (status?: string) => ({ running: '正在执行', queued: '已排队', waiting_approval: '等待具体操作批准', awaiting_approval: '待批准', waiting_input: '需要你的补充', waiting_children: '等待子任务', paused: '已暂停', completed: '已验证完成', failed: '执行失败', cancelled: '已取消', reconciling: '效果待对账', prepared: '已准备', approved: '已批准', unknown: '结果未知', proposed: '工具提议' } as Record<string, string>)[status ?? ''] ?? status ?? '尚未运行';
const statusTone = (status?: string) => (['running', 'queued', 'waiting_children'].includes(status ?? '') ? 'live' : ['waiting_approval', 'awaiting_approval', 'waiting_input', 'reconciling', 'prepared'].includes(status ?? '') ? 'warn' : ['completed', 'applied', 'approved'].includes(status ?? '') ? 'ok' : ['failed', 'unknown', 'denied', 'cancelled'].includes(status ?? '') ? 'bad' : 'idle');
function updateContext() {
  contextLabel.textContent = context ? `${context.path}${context.dirty ? ' · 未保存' : ''}${context.selectedChars ? ` · 选中 ${context.selectedChars} 字符` : ''}` : '从编辑器添加代码上下文';
  contextLabel.title = contextLabel.textContent;
  contextRow.classList.toggle('has-context', Boolean(context));
}
function updateState(message: any) {
  connected = message.connected; trusted = message.trusted; mode = message.mode; data = message.data; context = message.context; viewVersion = message.viewVersion ?? viewVersion;
  input.disabled = busy; chat.disabled = work.disabled = busy;
  if (message.logo) { logo.src = message.logo; }
  setLabel(connection, connected ? data?.providerMode === 'live' ? 'Live · 已连接' : 'Mock · 已连接' : '未连接 · 点击配置');
  connection.classList.toggle('online', connected);
  if (!connected && message.error) { error.textContent = message.error; error.hidden = false; }
  projectName.textContent = data?.workspace.path.split(/[\\/]/).at(-1) || '选择项目'; projectName.title = data?.workspace.path ?? '';
  chat.classList.toggle('active', mode === 'chat'); work.classList.toggle('active', mode === 'work'); segment.dataset.mode = mode;
  const nextScope = `${mode}:${data?.workspace.id ?? 'unbound'}-${mode === 'work' ? data?.task?.id ?? 'new' : data?.chat?.id ?? 'new'}`;
  if (scope !== nextScope) { drafts[scope] = input.value; scope = nextScope; input.value = drafts[scope] ?? ''; configurationDirty = false; messageFingerprint = ''; }
  const items = mode === 'work' ? data?.tasks ?? [] : data?.chats ?? [];
  const options = [{ id: '', title: mode === 'work' ? '新目标 · 明确范围后开始' : '新对话 · 自由讨论' }, ...items.map(item => ({ id: item.id, title: item.title }))];
  const fingerprint = JSON.stringify(options);
  if (picker.dataset.options !== fingerprint) { picker.replaceChildren(); for (const item of options) { const option = node('option', '', item.title); option.value = item.id; picker.append(option); } picker.dataset.options = fingerprint; }
  picker.value = mode === 'work' ? data?.task?.id ?? '' : data?.chat?.id ?? '';
  statusText.textContent = mode === 'work' && data?.task ? statusName(data.task.status) : data?.request?.status === 'running' ? '正在生成 · 使用实际请求流' : mode === 'work' ? '目标保存后由独立后台推进' : '自由对话 · 可升级为 Work';
  statusText.title = data?.task?.waitingReason ?? data?.task?.error ?? '';
  statusDot.dataset.tone = mode === 'work' && data?.task ? statusTone(data.task.status) : data?.request?.status === 'running' ? 'live' : 'idle';
  const actionKey = `${mode}:${data?.task?.status}:${data?.request?.status}:${connected}`;
  if (taskActions.dataset.key !== actionKey) {
    taskActions.replaceChildren();
    if (mode === 'work' && data?.task) {
      const status = data.task.status;
      if (['running', 'queued', 'waiting_approval', 'waiting_children'].includes(status)) taskActions.append(button('暂停', () => fire('control', { control: 'pause' }), 'quiet chip', 'agent-pause'));
      if (status === 'paused') taskActions.append(button('恢复', () => fire('control', { control: 'resume' }), 'quiet chip', 'agent-resume'));
      if (['failed', 'waiting_input'].includes(status)) taskActions.append(button('重试', () => fire('control', { control: 'retry' }), 'quiet chip'));
      if (!['completed', 'cancelled', 'failed'].includes(status)) taskActions.append(button('取消', () => fire('control', { control: 'cancel' }), 'quiet chip danger'));
    } else if (data?.request?.status === 'running') taskActions.append(button('停止生成', () => fire('control'), 'quiet chip danger', 'agent-stop'));
    else if (data?.chat) taskActions.append(button('转 Work', () => fire('promote'), 'quiet chip', 'agent-promote'));
    taskActions.dataset.key = actionKey;
  }
  profile.disabled = mode === 'work';
  const profiles = JSON.stringify(data?.profiles ?? []);
  if (profile.dataset.options !== profiles) { const value = profile.value || saved.profile; profile.replaceChildren(); for (const item of data?.profiles ?? []) { const option = node('option', '', `${item.name} · ${item.model}`); option.value = item.id; profile.append(option); } if (value && [...profile.options].some(item => item.value === value)) profile.value = value; profile.dataset.options = profiles; }
  if (mode === 'chat' && data?.chat && !busy && !configurationDirty) { profile.value = data.chat.profileId; tools.checked = data.chat.capabilities.tools; }
  goalOptions.hidden = mode !== 'work' || Boolean(data?.task); toolsLabel.hidden = mode !== 'chat';
  input.placeholder = mode === 'work' ? data?.task ? '补充当前任务的消息；不会偷偷改写已保存目标…' : '描述要达成的具体结果，保存目标后开始…' : '与 Agent 对话，或把代码选区加到上下文…';
  setLabel(sendButton, busy ? '提交中…' : mode === 'work' && !data?.task ? '创建目标' : '发送');
  sendButton.disabled = busy || !connected || mode === 'chat' && data?.request?.status === 'running';
  const measured = data?.metrics;
  metrics.textContent = measured ? `${measured.rounds} 轮 · ${measured.steps} 模型步 · ${measured.totalTokens === null ? 'Token 未返回' : measured.totalTokens.toLocaleString() + ' tokens'} · ${measured.toolCalls} 工具` : '暂无模型调用 · 原生编辑不消耗模型额度';
  if (!trusted) metrics.textContent += ' · 受限模式：执行需先信任项目';
  updateContext(); paintConversation();
}
function paintConversation() {
  const fingerprint = JSON.stringify({ mode, scope, messages: data?.messages, tools: data?.tools, request: data?.request });
  if (fingerprint === messageFingerprint) return; messageFingerprint = fingerprint;
  const nearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80, top = conversation.scrollTop;
  conversation.replaceChildren();
  if (!data?.messages.length) {
    const empty = node('div', 'agent-empty');
    const glyph = node('div', 'empty-glyph'); glyph.append(svg('chat', 26));
    empty.append(glyph, node('h2', '', mode === 'work' ? '从清晰的目标开始' : '你的项目，持续的协作'), node('p', '', mode === 'work' ? '目标、预算和验收保存在后台。\n暂停或关闭 IDE，任务身份不会丢失。' : '选中代码加入上下文，或直接提出问题。\n需要持续推进时，再切换到 Work。'));
    conversation.append(empty);
  }
  for (const message of data?.messages ?? []) {
    if (message.role === 'tool' || message.role === 'assistant' && message.toolCalls?.length && !message.content) continue;
    const item = node('article', `message ${message.role === 'user' ? 'user' : 'assistant'}`);
    item.dataset.messageId = message.id;
    const role = node('div', 'message-role');
    if (message.role === 'assistant') role.append(node('span', 'role-dot'));
    role.append(node('span', '', message.role === 'user' ? '你' : message.role === 'assistant' ? 'NPN' : message.role));
    item.append(role);
    const body = node('div', 'message-content');
    if (message.role === 'assistant') body.append(richText(message.content, { copyText: text => fire('copy', { text }), copySource: text => fire('copy', { text }) }));
    else body.textContent = message.content;
    item.append(body);
    if (message.previewTruncated) item.append(node('p', 'preview-note', '显示部分原文；完整来源保留在请求/档案中。'));
    conversation.append(item);
  }
  if (data?.request?.status === 'running' && data.request.draft) {
    const stream = node('article', 'message assistant streaming'); stream.dataset.testid = 'agent-stream';
    const role = node('div', 'message-role'); role.append(node('span', 'role-dot'), node('span', '', 'NPN · 正在生成'));
    stream.append(role, node('div', 'message-content', data.request.draft)); conversation.append(stream);
  }
  for (const tool of [...data?.tools ?? []].reverse()) {
    const awaiting = tool.status === 'awaiting_approval' && Boolean(tool.digest);
    const card = node('article', `tool-card${awaiting ? ' is-awaiting' : ''}`); card.dataset.toolId = tool.id;
    const head = node('div', 'tool-head');
    const symbol = node('span', 'tool-symbol'); symbol.append(svg(awaiting ? 'shield' : 'tool'));
    head.append(symbol, node('strong', '', tool.name), node('span', 'grow'), node('span', `tool-state ${tool.status} tone-${statusTone(tool.status)}`, ['completed', 'applied'].includes(tool.status) ? '已执行' : statusName(tool.status)));
    const details = node('details', 'tool-details'); details.append(node('summary', '', tool.arguments.path ? String(tool.arguments.path) : tool.description?.slice(0, 80) || '查看具体参数'), node('pre', '', JSON.stringify(tool.arguments, null, 2)));
    card.append(head, details);
    if (tool.result !== undefined) {
      const result = node('details', 'tool-details'); result.append(node('summary', '', '执行回执 / 输出'), node('pre', '', typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2))); card.append(result);
    }
    if (tool.error) card.append(node('p', 'tool-error', tool.error));
    if (tool.fileConflicts?.conflicts.length) card.append(node('p', 'approval-note', '其他任务正在编辑：' + tool.fileConflicts.conflicts.map(claim => `${claim.taskId} · ${claim.path}`).join('；') + '。仅可批准此次具体写入，读取版本仍须有效。'));
    const actions = node('div', 'tool-actions');
    if (tool.name === 'write_file' && tool.digest) actions.append(button(tool.status === 'completed' ? '打开文件' : '查看 Diff', () => fire(tool.status === 'completed' ? 'openArtifact' : 'diff', { toolId: tool.id, digest: tool.digest }), 'quiet chip', 'agent-tool-diff', 'code'));
    if (awaiting) {
      const approve = button(tool.fileConflicts?.conflicts.length ? '仍然写入此次操作' : '批准此操作', () => fire('approve', { toolId: tool.id, digest: tool.digest, expectedConflictFingerprint: tool.fileConflicts?.fingerprint, approved: true }), 'approve', 'agent-tool-approve'); approve.disabled = !connected || !trusted;
      actions.append(button('拒绝', () => fire('approve', { toolId: tool.id, digest: tool.digest, approved: false }), 'quiet chip danger', 'agent-tool-deny'), approve);
      card.append(node('p', 'approval-note', '仅批准当前参数与版本。未保存缓冲和过期文件版本会阻止写入。'));
    }
    card.append(actions); conversation.append(card);
  }
  if (!data?.messages.length) conversation.scrollTop = 0;
  else if (nearBottom) conversation.scrollTop = conversation.scrollHeight; else conversation.scrollTop = top;
}
async function send() {
  if (busy || !input.value.trim()) return;
  const text = input.value, key = scope; busy = true; input.disabled = true; chat.disabled = work.disabled = true; sendButton.disabled = true; setLabel(sendButton, '提交中…');
  try {
    const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);
    await run('send', { content: text, tools: tools.checked, profileId: profile.value,
      goal: { constraints: lines(constraints.value), acceptance: lines(acceptance.value), maxModelCalls: Number(modelLimit.value), maxToolCalls: Number(toolLimit.value), mode: 'collaborative' } });
    configurationDirty = false;
    if (drafts[key] === text || key === scope && input.value === text) { drafts[key] = ''; if (key === scope) input.value = ''; persist(); fire('draft', { key, content: '' }); }
  } catch { /* 接受结果未知前保留原草稿，避免重复发送 */ }
  finally { busy = false; input.disabled = false; chat.disabled = work.disabled = false; sendButton.disabled = !connected || mode === 'chat' && data?.request?.status === 'running'; setLabel(sendButton, mode === 'work' && !data?.task ? '创建目标' : '发送'); }
}
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'reply') { const request = pending.get(message.id); if (!request) return; clearTimeout(request.timer); pending.delete(message.id); if (message.ok) request.resolve(message.result); else request.reject(new Error(message.error)); }
  if (message.type === 'state') updateState(message);
  if (message.type === 'context') { context = message.context; updateContext(); }
  if (message.type === 'attach') { input.value += `${input.value ? '\n\n' : ''}${message.text}`; saveDraft(); input.focus(); }
});
void run('ready').then(result => { const current = { ...drafts }; Object.assign(drafts, result.drafts ?? {}, saved.drafts ?? {}, current); if (!input.value) input.value = drafts[scope] ?? ''; }).catch(() => undefined);
