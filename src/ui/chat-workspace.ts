import { mountHero, mountInput, mountStats, inputClasses, messageClasses, messageActionClasses, conversationClasses, resizeComposer } from './dsh/bridge.js';
import type { AgentMetrics } from '../harness/metrics.js';
import { showMetricsDetails } from './metrics-details.js';
import type { Task } from '../contracts.js';
import type { ChatSession, ChatMessage, ProviderProfile, RequestRecord, Preset } from '../harness/types.js';
import { append, badge, button, element, empty, field, icon, input, progressiveMessage, richText, select, textarea, testId } from './dom.js';
import { ConversationDrafts, mergeRequestPages, requestMetrics } from './harness-model.js';
import { harnessPath, requestStatus, type HarnessUiHost } from './harness-ui.js';
import { createInspector } from './inspector.js';
import { displayStatus, errorText, pretty, shortTime } from './view-model.js';
import { activityLevel, activitySummary, type ActivityReport } from './activity-model.js';

export interface ChatWorkspaceHost extends HarnessUiHost {
  showConfirm(title: string, caption: string, label: string, action: () => void): void;
  showChat(): void;
  selectTask(id: string): void;
  newTask(): void;
  tasks(): Task[];
  inspectorChanged(): void;
  toggleNavigation(): void;
  navigationOpen(): boolean;
  showActivity(): void;
  openProject(workspace?: string): void;
}
type Screen = 'chat' | 'projects' | 'history' | 'other';
const capabilityNames = { web: '联网', tools: '文件与终端', mcp: 'MCP', skills: 'Skills', projectInstructions: '项目指令' };

export function createChatWorkspace(host: ChatWorkspaceHost) {
  const call = <T = any>(method: string, path: string, body?: unknown) => host.request<T>(method, harnessPath(path), body);
  const drafts = new ConversationDrafts();
  const expandedMessages = new Set<string>();
  const inspector = createInspector({ ...host, changed: host.inspectorChanged });
  let screen: Screen = 'other', target: HTMLElement | undefined, session: ChatSession | undefined;
  let sessions: ChatSession[] = [], profiles: ProviderProfile[] = [], messages: ChatMessage[] = [];
  let selectedId = '', epoch = 0, activeRequestId: string | undefined, currentRequest: RequestRecord | undefined;
  let loading = false, loadError = '', sending = false, polling = false, sessionSearch = '', welcomeDraft = '';
  let chatRoot: HTMLElement | undefined, rail: HTMLElement | undefined, conversation: HTMLElement | undefined, messageArea: HTMLElement | undefined, composer: HTMLTextAreaElement | undefined, status: HTMLElement | undefined, controls: HTMLElement | undefined, attachmentsArea: HTMLElement | undefined;
  const views: { destroy(): void }[] = [];
  let metrics: AgentMetrics | undefined, metricsError = '', statsView: ReturnType<typeof mountStats> | undefined;
  const disposeViews = () => { for (const view of views.splice(0)) view.destroy(); };
  let messageFingerprint = '', controlsFingerprint = '', history: RequestRecord[] = [], historyCursor: number | null = null;
  const copy = (text: string) => host.run(async () => { await window.npn.desktop('copy-text', { text }); host.toast('已复制。'); });
  function selectedProfile() { return profiles.find(profile => profile.id === session?.profileId) ?? profiles.find(profile => profile.id === 'default'); }
  async function loadCatalog() {
    const [sessionData, profileData] = await Promise.all([call<{ sessions: ChatSession[] }>('GET', '/sessions'), call<{ profiles: ProviderProfile[] }>('GET', '/profiles')]);
    sessions = sessionData.sessions; profiles = profileData.profiles;
  }
  async function newSession() {
    const created = await call<ChatSession>('POST', '/sessions', { title: '新对话', profileId: profiles[0]?.id ?? 'default' });
    sessions = [created, ...sessions]; await chooseSession(created.id); host.showChat();
  }
  function mountNavigation(container: HTMLElement) { rail = container; rail.classList.add('chat-session-rail'); paintRail(); }
  async function chooseSession(id: string) {
    metrics = undefined; metricsError = '';
    const turn = ++epoch; selectedId = id; loading = true; loadError = ''; session = sessions.find(item => item.id === id); messages = []; currentRequest = undefined; activeRequestId = undefined; messageFingerprint = '';
    inspector.setContext({ sessionId: id, workspace: session?.workspace }); if (screen === 'chat') paintChat();
    try {
      const result = await call<{ session: ChatSession; messages: ChatMessage[]; activeRequestId?: string }>('GET', `/sessions/${encodeURIComponent(id)}`);
      if (turn !== epoch) return;
      session = result.session; messages = result.messages; activeRequestId = result.activeRequestId;
      inspector.setContext({ sessionId: id, workspace: session.workspace });
      const requestId = activeRequestId ?? [...messages].reverse().find(message => message.requestId)?.requestId;
      if (requestId) { const value = await call<RequestRecord>('GET', `/requests/${requestId}`); if (turn !== epoch) return; currentRequest = value; inspector.observe(value); }
      await readMetrics(id, turn);
    } catch (error) { if (turn === epoch) loadError = errorText(error); }
    finally { if (turn === epoch) { loading = false; if (screen === 'chat') paintChat(); } }
  }
  function open(value: Screen, element: HTMLElement) {
    screen = value; target = element;
    if (value === 'chat') { inspector.setContext({ sessionId: selectedId || undefined, workspace: session?.workspace }); paintChat(); }
    if (value === 'projects') paintProjects();
    if (value === 'history') paintHistory();
    const turn = epoch;
    host.run(async () => {
      try {
        await loadCatalog();
        if (screen !== value || turn !== epoch) return;
        if (value === 'chat') { if (!selectedId && sessions.length) await chooseSession(sessions[0].id); else { if (selectedId) await chooseSession(selectedId); else paintChat(); } }
        if (value === 'projects') paintProjects();
        if (value === 'history') await loadHistory();
      } catch (error) { loadError = errorText(error); if (value === 'chat' && screen === value) paintChat(); else throw error; }
    });
  }
  function leave(task?: Task) { disposeViews(); screen = 'other'; target = undefined; epoch++; inspector.setContext(task ? { taskId: task.id, workspace: task.workspace } : {}); }
  function paintRail() {
    if (!rail) return;
    rail.replaceChildren();
    const search = input(sessionSearch, '查找对话', 'chat-session-search'); search.setAttribute('aria-label', '搜索 Chat 会话');
    const list = element('div', 'chat-session-list');
    const paint = () => {
      list.replaceChildren(); const matching = sessions.filter(item => `${item.title} ${item.workspace ?? ''}`.toLocaleLowerCase().includes(sessionSearch.toLocaleLowerCase()));
      if (!matching.length) list.append(empty(sessionSearch ? '没有匹配的对话' : '对话将保存在这里。'));
      for (const item of matching) {
        const node = button('', () => host.run(async () => { await chooseSession(item.id); host.showChat(); }), `chat-session-item${item.id === selectedId ? ' selected' : ''}`, `chat-session-${item.id}`);
        node.setAttribute('aria-current', String(item.id === selectedId));
        node.append(element('strong', '', item.title), element('span', 'tiny muted', `${item.parentSessionId ? '分支 · ' : ''}${shortTime(item.updatedAt)}`)); list.append(node);
      }
    };
    search.addEventListener('input', () => { sessionSearch = search.value; paint(); }); paint();
    rail.append(append(element('div', 'chat-rail-heading'), element('span', 'eyebrow', '最近对话'), button('+', () => host.run(newSession), 'small ghost', 'chat-new-session'), button('收起', host.toggleNavigation, 'small ghost chat-rail-close', 'chat-close-conversations')), search, list);
  }
  function paintChat() {
    if (!target || screen !== 'chat') return;
    disposeViews(); statsView = undefined; target.replaceChildren(); target.classList.add('harness-screen');
    chatRoot = testId(element('div', 'chat-workspace'), 'chat-workspace');
    conversation = element('section', 'chat-conversation ' + conversationClasses.root);
    paintRail(); chatRoot.append(conversation); target.append(chatRoot);
    if (loadError) conversation.append(append(element('div', 'notice error'), element('span', 'grow', loadError), button('重试', () => host.run(async () => { await loadCatalog(); if (selectedId) await chooseSession(selectedId); else { loadError = ''; paintChat(); } }), 'small', 'chat-retry-load')));
    const heading = element('header', 'chat-heading');
    const conversations = button('', host.toggleNavigation, 'icon-button ghost chat-navigation-toggle', 'chat-toggle-conversations'); conversations.append(icon('menu')); conversations.title = '对话列表'; conversations.setAttribute('aria-label', '显示或收起对话列表'); conversations.setAttribute('aria-expanded', String(host.navigationOpen()));
    const profile = selectedProfile();
    if (session) heading.append(badge(activeRequestId ? '运行中' : '已保存', activeRequestId ? 'live' : ''));
    heading.append(conversations, append(element('div', 'grow'), element('h1', '', session?.title ?? '新对话'), element('span', 'tiny muted', session ? `${profile?.name ?? session.profileId}${session.parentSessionId ? ' · 分支会话' : ''}` : '')));
    if (session) heading.append(button('历史', showMessageHistory, 'small ghost', 'chat-message-history'), button('会话配置', () => editSession(), 'small ghost', 'chat-settings'), button('升级 Work', promote, 'small', 'chat-promote'));
    const inspect = button('', () => inspector.toggle(), 'small ghost inspector-trigger', 'chat-inspector'); inspect.append(icon('panel'), '检查器'); inspect.title = '提示词、实际请求与执行轨迹'; heading.append(inspect); conversation.append(heading);
    if (!session) {
      const welcome = element('div', 'npn-hero-mount');
      const text = textarea(welcomeDraft, '输入你的想法，让 Gamma 帮你完成…', 'chat-welcome-message'); text.setAttribute('aria-label', '开始新对话');
      text.addEventListener('input', () => { welcomeDraft = text.value; });
      const start = () => host.run(async () => { const content = text.value.trim(); await newSession(); if (content) { drafts.set(selectedId, { text: content, attachments: [] }); welcomeDraft = ''; await send(); } });
      text.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); start(); } });
      const sendButton = button('', start, inputClasses.primary, 'chat-start'); sendButton.append(icon('arrow')); sendButton.setAttribute('aria-label', '开始对话'); sendButton.title = '开始对话';
      const row = append(element('div'), element('span', 'composer-key-hint', 'Enter 发送 / Shift+Enter 换行'), button(profiles[0]?.provider.model ?? '选择模型', () => host.run(manageProfiles), 'small ghost composer-model'), sendButton);
      const inputMount = element('div'); const inputView = mountInput(inputMount); views.push(inputView);
      inputView.update({ editor: text, attachments: element('div', 'chat-attachments'), controls: row, status: element('div'), hero: true });
      const workspace = button('创建项目任务', host.newTask, 'small ghost'); workspace.prepend(icon('folder')); workspace.title = '创建可持续执行的项目任务';
      const activity = element('div', 'home-activity');
      const heroView = mountHero(welcome); views.push(heroView); heroView.update({ composer: inputMount, activity, workspace });
      conversation.append(welcome); host.run(() => paintHomeActivity(activity)); return;
    }
    messageArea = testId(element('div', 'chat-messages'), 'chat-messages'); messageArea.setAttribute('role', 'log'); messageArea.setAttribute('aria-label', 'Chat 对话内容');
    conversation.append(messageArea); paintMessages(true);
    const footer = element('div', 'chat-composer-area');
    const draft = drafts.get(selectedId); composer = textarea(draft.text, '发送消息… Enter 发送，Shift+Enter 换行', 'chat-message'); composer.setAttribute('aria-label', 'Chat 消息');
    composer.addEventListener('input', () => { drafts.set(selectedId, { ...drafts.get(selectedId), text: composer!.value }); updateComposer(); });
    composer.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!sending && !activeRequestId) host.run(send); } });
    attachmentsArea = element('div', 'chat-attachments');
    controls = element('div', 'chat-composer-controls'); controlsFingerprint = ''; status = testId(element('div', 'chat-status'), 'chat-status');
    statsView = mountStats(status); views.push(statsView);
    const inputView = mountInput(footer); views.push(inputView); inputView.update({ editor: composer, attachments: attachmentsArea, controls, status }); conversation.append(footer);
    paintAttachments(); updateComposer();
  }
  async function paintHomeActivity(target: HTMLElement) {
    try {
      const report = await host.request<ActivityReport>('GET', '/v1/activity?days=90'); if (!target.isConnected) return;
      const summary = activitySummary(report.days), maximum = Math.max(1, ...report.days.map(day => day.events));
      if (!summary.events) { target.append(append(element('div', 'home-activity-heading'), element('span', '', '工作记录'), button('查看活动', host.showActivity, 'small ghost')), element('p', 'tiny muted', '近 90 天还没有任务活动。开始 Work 后，这里只呈现真实执行记录。')); return; }
      const grid = element('div', 'home-heatmap'); grid.setAttribute('aria-label', '最近90天真实任务活动');
      for (const day of report.days) { const cell = button('', host.showActivity, `heatmap-cell level-${activityLevel(day.events, maximum)}`); cell.title = `${day.date} · ${day.events} 条事件 · ${day.toolEffects} 次工具效果`; cell.setAttribute('aria-label', cell.title); grid.append(cell); }
      target.append(append(element('div', 'home-activity-heading'), element('span', '', '最近 90 天的任务活动'), button('查看每日明细', host.showActivity, 'small ghost')), grid, element('p', 'tiny muted', `近 90 天 · ${summary.activeDays} 个活跃日 · ${summary.tasksCompleted} 个已完成任务`));
    } catch (error) { if (target.isConnected) target.append(element('p', 'tiny muted', `活动暂不可用：${errorText(error)}`)); }
  }
  function paintMessages(force = false) {
    if (!messageArea) return;
    const fingerprint = JSON.stringify({ messages, draft: currentRequest?.draft, status: currentRequest?.status, error: currentRequest?.error, loading });
    if (!force && fingerprint === messageFingerprint) return; messageFingerprint = fingerprint;
    const atBottom = messageArea.scrollHeight - messageArea.scrollTop - messageArea.clientHeight < 110, scroll = messageArea.scrollTop;
    const openIds = new Set([...messageArea.querySelectorAll<HTMLDetailsElement>('details[open]')].map(node => node.dataset.messageId));
    messageArea.replaceChildren();
    if (loading) { messageArea.append(empty('正在读取已保存的对话…')); return; }
    if (!messages.length) messageArea.append(append(element('div', 'chat-empty'), element('h2', '', '有什么想一起聊聊？'), element('p', '', '会话配置与工具能力由你决定。右侧可以检查下一轮的完整请求。')));
    for (const message of messages) {
      const node = testId(element('article', `chat-message ${message.role}`), `chat-message-${message.id}`); node.dataset.messageId = message.id;
      const label = ({ user: '你', assistant: 'Gamma', tool: '工具结果', system: '系统', developer: 'Developer' })[message.role];
      const head = append(element('div', 'chat-message-heading'), element('strong', '', label), element('time', '', shortTime(message.createdAt)));
      const content = progressiveMessage(message.content, () => message.role === 'assistant' ? richText(message.content || (message.toolCalls?.length ? '正在请求以下工具…' : ''), { copyText: copy, copySource: copy }) : element('div', 'chat-message-text', message.content), expandedMessages.has(message.id), open => open ? expandedMessages.add(message.id) : expandedMessages.delete(message.id));
      if (message.role === 'tool') { const details = element('details', 'inline-tool-output'); details.dataset.messageId = message.id; details.open = openIds.has(message.id); details.append(element('summary', '', `工具返回 · ${message.toolCallId ?? ''}`), element('pre', '', message.content)); node.append(head, details); }
      else { if (message.role === 'user') { node.classList.add(messageClasses.userRow); content.classList.add(messageClasses.bubble); } node.append(head, content); }
      if (message.attachments?.length) node.append(element('div', 'tiny muted', message.attachments.map(file => `${file.name} · ${file.bytes.toLocaleString()} 字节`).join(' / ')));
      if (message.toolCalls?.length) node.append(append(element('div', 'chat-tool-proposals'), element('span', 'tiny', message.toolCalls.map(call => call.name).join(' · ')), button('查看工具与审批', () => { if (message.requestId) host.run(async () => { await inspector.selectRecord(message.requestId!); inspector.openTab('Tools'); }); else inspector.openTab('Tools'); }, 'small', `chat-tools-${message.id}`)));
      const actions = element('div', `chat-message-actions ${messageActionClasses.actions}`); actions.append(button('复制', () => copy(message.content), 'small ghost'));
      if (message.role === 'user') actions.append(button('编辑并分叉', () => editMessage(message), 'small ghost', `chat-edit-${message.id}`));
      if (message.role === 'assistant') actions.append(button('重新生成', () => host.run(async () => branch(message, true)), 'small ghost', `chat-regenerate-${message.id}`));
      actions.append(button('从此分叉', () => host.run(async () => branch(message)), 'small ghost', `chat-branch-${message.id}`));
      if (message.requestId) actions.append(button('查看请求', () => host.run(async () => { await inspector.selectRecord(message.requestId!); inspector.openTab('Request'); }), 'small ghost'));
      node.append(actions); messageArea.append(node);
    }
    if (currentRequest?.status === 'running' && !messages.some(message => message.id === currentRequest!.assistantMessageId)) {
      const streaming = append(testId(element('article', 'chat-message assistant streaming'), 'chat-streaming'), element('div', 'chat-message-heading', 'Gamma · 正在生成'), richText(currentRequest.draft || '正在等待模型响应…', { copyText: copy, copySource: copy }));
      messageArea.append(streaming);
    }
    if (currentRequest?.error) messageArea.append(append(testId(element('div', 'notice error'), 'chat-request-error'), element('span', '', `${currentRequest.error.code}: ${currentRequest.error.message}`), button('在 Inspector 中检查', () => inspector.openTab('Request'), 'small')));
    messageArea.scrollTop = force || atBottom ? messageArea.scrollHeight : scroll;
  }
  function updateComposer() {
    if (!controls || !session || !composer || !status) return;
    resizeComposer(composer);
    statsView?.update({ data: metrics, error: metricsError, sending, onDetails: () => showMetricsDetails(host, metrics), onInspect: tab => inspector.openTab(tab) });
    const fingerprint = JSON.stringify({ sessionId: session.id, capabilities: session.capabilities, sending, activeRequestId, canSend: Boolean(composer.value.trim() || drafts.get(selectedId).attachments.length) });
    if (fingerprint === controlsFingerprint) return;
    controlsFingerprint = fingerprint;
    controls.replaceChildren();
    const attach = button('', () => host.run(async () => { const sessionId = selectedId, chosen = await window.npn.desktop('select-file'); if (!chosen) return; const draft = drafts.get(sessionId); if (draft.attachments.length >= 5) throw new Error('每次最多附加 5 个 UTF-8 文本文件。'); drafts.set(sessionId, { ...draft, attachments: [...new Set([...draft.attachments, chosen])] }); if (selectedId === sessionId) { paintAttachments(); updateComposer(); } }), inputClasses.add, 'chat-attach'); attach.append(icon('plus')); attach.title = '附加 UTF-8 文本文件 · 每个不超过 128 KB'; attach.setAttribute('aria-label', attach.title);
    const capabilities = element('div', 'chat-capabilities');
    for (const [key, label] of Object.entries(capabilityNames)) {
      const enabled = session.capabilities[key as keyof typeof capabilityNames];
      const toggle = button(label, () => host.run(async () => { const id = selectedId; const result = await call<ChatSession>('POST', `/sessions/${id}`, { capabilities: { ...session!.capabilities, [key]: !enabled } }); if (id === selectedId) { session = result; updateComposer(); } }), `small ghost${enabled ? ' enabled' : ''}`, `chat-capability-${key}`);
      toggle.setAttribute('aria-pressed', String(enabled)); toggle.title = `${enabled ? '关闭' : '启用'}${label}，下一次请求生效`; toggle.disabled = sending || Boolean(activeRequestId); capabilities.append(toggle);
    }
    const sendButton = activeRequestId ? button('停止', () => host.run(async () => { await call('POST', `/requests/${activeRequestId}/cancel`); await poll(); }), inputClasses.primary, 'chat-stop') : button('发送', () => host.run(send), inputClasses.primary, 'chat-send');
    if (!activeRequestId) sendButton.disabled = sending || (!composer.value.trim() && !drafts.get(selectedId).attachments.length);
    const extras = element('details', 'composer-tools-menu'); extras.open = false;
    const summary = element('summary', '', '工具'); summary.append(element('span', '', ` ${Object.values(session.capabilities).filter(Boolean).length || ''}`)); extras.append(summary, capabilities);
    const model = button(selectedProfile()?.provider.model ?? '选择模型', () => editSession(), 'small ghost composer-model'); model.title = '模型与会话设置';
    if (!activeRequestId) { sendButton.replaceChildren(icon('arrow')); sendButton.setAttribute('aria-label', '发送消息'); sendButton.title = '发送消息'; }
    controls.append(attach, extras, model, sendButton);
  }
  function paintAttachments() {
    if (!attachmentsArea) return; attachmentsArea.replaceChildren();
    for (const path of drafts.get(selectedId).attachments) {
      const remove = button('×', () => { const draft = drafts.get(selectedId); drafts.set(selectedId, { ...draft, attachments: draft.attachments.filter(item => item !== path) }); paintAttachments(); updateComposer(); }, 'small ghost'); remove.setAttribute('aria-label', `移除附件 ${path.split(/[/\\]/).at(-1)}`);
      const chip = append(element('div', 'attachment-chip'), element('span', '', path.split(/[/\\]/).at(-1)), remove); chip.title = path; attachmentsArea.append(chip);
    }
  }
  async function send() {
    if (!selectedId || sending || activeRequestId) return;
    const id = selectedId, turn = epoch, draft = drafts.get(id);
    if (!draft.text.trim() && !draft.attachments.length) return;
    sending = true; updateComposer();
    try {
      const result = await call<{ requestId: string; status: string }>('POST', '/chat', { sessionId: id, content: draft.text, attachments: draft.attachments });
      // Only clear the exact submitted text: typing while dispatch is pending must survive.
      const latest = drafts.get(id); if (latest.text === draft.text && JSON.stringify(latest.attachments) === JSON.stringify(draft.attachments)) drafts.clear(id);
      if (turn !== epoch || selectedId !== id) return;
      activeRequestId = result.requestId; if (composer) composer.value = drafts.get(id).text; paintAttachments();
      await readConversation(turn); await loadCatalog(); paintRail();
    } finally { sending = false; updateComposer(); }
  }
  async function readConversation(turn = epoch) {
    if (!selectedId) return;
    const id = selectedId, result = await call<{ session: ChatSession; messages: ChatMessage[]; activeRequestId?: string }>('GET', `/sessions/${id}`);
    if (turn !== epoch || id !== selectedId) return;
    session = result.session; messages = result.messages; activeRequestId = result.activeRequestId;
    const requestId = activeRequestId ?? [...messages].reverse().find(message => message.requestId)?.requestId ?? currentRequest?.id;
    if (requestId) { const value = await call<RequestRecord>('GET', `/requests/${requestId}`); if (turn !== epoch || id !== selectedId) return; currentRequest = value; inspector.observe(value); }
    await readMetrics(id, turn);
    if (turn !== epoch || id !== selectedId) return;
    if (screen === 'chat') { paintMessages(); updateComposer(); }
  }
  async function readMetrics(id: string, turn: number) {
    try {
      const value = await call<AgentMetrics>('GET', `/metrics?sessionId=${encodeURIComponent(id)}`);
      if (turn === epoch && id === selectedId) { metrics = value; metricsError = ''; }
    } catch (error) { if (turn === epoch && id === selectedId) { metrics = undefined; metricsError = errorText(error); } }
  }
  async function poll() {
    if (polling) return; polling = true;
    try { if (screen === 'chat' && selectedId && !loading) await readConversation(); await inspector.poll(); }
    finally { polling = false; }
  }
  async function branch(message: ChatMessage, regenerate = false, content?: string) {
    const created = await call<ChatSession>('POST', `/sessions/${message.sessionId}/branch`, { messageId: message.id, regenerate, ...(content !== undefined ? { content } : {}) });
    sessions = [created, ...sessions]; await chooseSession(created.id); host.showChat(); host.toast('已创建独立分支，原始会话完整保留。');
  }
  function editMessage(message: ChatMessage) {
    const dialog = host.showModal('编辑历史消息', '修改后创建新分支并重新发送；原始会话与后续消息保留。');
    const text = textarea(message.content, '', 'edit-chat-message');
    dialog.body.append(text, append(element('div', 'form-actions'), button('取消', dialog.close, 'ghost'), button('分叉并发送', () => host.run(async () => { if (!text.value.trim()) throw new Error('消息不能为空。'); await branch(message, false, text.value); dialog.close(); }), 'primary', 'submit-edit-chat-message')));
  }
  function showMessageHistory() {
    const id = selectedId, dialog = host.showModal('完整对话历史', '每页显示 100 条原始消息；编辑与重新生成保留原分支。');
    const list = element('div', 'history-messages'); let cursor: number | null = null;
    const load = async (before?: number) => {
      const page = await call<{ messages: ChatMessage[]; nextMessageCursor: number | null }>('GET', `/sessions/${id}?limit=100${before ? `&before=${before}` : ''}`);
      cursor = page.nextMessageCursor; older.disabled = cursor === null; list.replaceChildren();
      for (const message of page.messages) {
        const node = append(element('article', `chat-message ${message.role}`), element('div', 'chat-message-heading', `${message.role} · ${shortTime(message.createdAt)}`), element('pre', '', message.content));
        if (message.role === 'user') node.append(button('编辑并分叉', () => { dialog.close(); editMessage(message); }, 'small ghost'));
        if (message.role === 'assistant') node.append(button('重新生成', () => host.run(async () => { await branch(message, true); dialog.close(); }), 'small ghost'));
        list.append(node);
      }
    };
    const older = button('更早的消息', () => host.run(async () => { if (cursor) await load(cursor); }), 'small');
    dialog.body.append(append(element('div', 'row'), older, button('回到最新', () => host.run(async () => load()), 'small ghost')), list); host.run(async () => load());
  }
  function promote() {
    if (!session) return;
    const id = session.id, dialog = host.showModal('将 Chat 交给 Work', '保留原始会话，建立关联任务。Work 使用明确目标、独立预算与现有工具审批。');
    const objective = textarea([...messages].reverse().find(message => message.role === 'user')?.content ?? session.title, '任务目标', 'promote-objective');
    const workspace = input(session.workspace ?? '', 'D:\\项目路径（可选）', 'promote-workspace');
    const choose = button('选择目录', () => host.run(async () => { const result = await window.npn.desktop('select-folder'); if (result) workspace.value = result; }), 'small');
    dialog.body.append(field('Work 目标', objective), field('项目目录', append(element('div', 'row'), workspace, choose)), append(element('div', 'form-actions'), button('取消', dialog.close, 'ghost'), button('创建 Work 任务', () => host.run(async () => { const result = await call<{ taskId: string }>('POST', `/sessions/${id}/promote`, { objective: objective.value, ...(workspace.value.trim() ? { workspace: workspace.value.trim() } : {}) }); dialog.close(); host.selectTask(result.taskId); }), 'primary', 'confirm-promote')));
  }
  function editSession() {
    if (!session) return;
    const current = session, dialog = host.showModal('会话配置', '这些设置在本机保存，并应用于后续请求。历史请求保持原样。');
    const name = input(current.title, '对话名称', 'chat-session-title'), workspace = input(current.workspace ?? '', 'D:\\项目目录', 'chat-session-workspace');
    const profile = select(profiles.map(item => [item.id, `${item.name} · ${item.provider.model}`]), current.profileId, 'chat-profile');
    const system = textarea(current.systemPrompt, '自定义 System Prompt', 'chat-system-prompt'), developer = textarea(current.developerPrompt, 'Developer Prompt（需要接口支持）', 'chat-developer-prompt');
    const temperature = input(current.parameters.temperature === undefined ? '' : String(current.parameters.temperature), '提供方默认', 'chat-temperature'), maxTokens = input(current.parameters.max_tokens === undefined ? '' : String(current.parameters.max_tokens), '提供方默认', 'chat-max-tokens'); temperature.type = 'number'; temperature.step = '0.1'; maxTokens.type = 'number'; maxTokens.min = '1';
    const compatibility = element('p', 'tiny muted');
    const updateCompatibility = () => { const supported = profiles.find(item => item.id === profile.value)?.supportsDeveloper ?? false; developer.disabled = !supported; compatibility.textContent = supported ? '此提供方声明支持 Developer 角色。' : '此提供方未声明 Developer 支持，不能发送非空 Developer 指令。'; }; updateCompatibility(); profile.addEventListener('change', updateCompatibility);
    const grid = element('div', 'form-grid'); grid.append(field('对话名称', name), field('模型与提供方', profile), field('项目目录', append(element('div', 'row'), workspace, button('选择', () => host.run(async () => { const chosen = await window.npn.desktop('select-folder'); if (chosen) workspace.value = chosen; }), 'small')), 'full'), field('System Prompt', system, 'full'), field('Developer Prompt', developer, 'full'), compatibility, field('Temperature', temperature), field('Max Tokens', maxTokens));
    const exportButton = button('导出对话', () => host.run(async () => { const data = await call('GET', `/export?sessionId=${current.id}`); const saved = await window.npn.desktop('save-export', { filename: `npn-chat-${current.id}.json`, content: JSON.stringify(data, null, 2) }); if (saved) host.toast('对话已导出。'); }), 'small', 'chat-export');
    const presetButton = button('保存提示词预设', () => host.run(async () => { await call('POST', '/presets', { name: name.value.trim() || '会话提示词', kind: 'prompt', scope: 'global', scopeId: '', value: { systemPrompt: system.value, developerPrompt: developer.value } }); host.toast('提示词预设已保存。'); }), 'small');
    const loadPresets = button('加载提示词预设', () => host.run(async () => { const { presets } = await call<{ presets: Preset[] }>('GET', '/presets?kind=prompt'); const choice = host.showModal('提示词预设', '选中后填入当前表单，保存会话后生效。'); if (!presets.length) choice.body.append(empty('尚无提示词预设。')); for (const preset of presets) choice.body.append(button(`${preset.name} · v${preset.version}`, () => { system.value = String(preset.value.systemPrompt ?? ''); developer.value = String(preset.value.developerPrompt ?? ''); choice.close(); }, 'preset-choice')); }), 'small');
    const modelPreset = button('保存模型预设', () => host.run(async () => { await call('POST', '/presets', { name: `${name.value.trim() || '会话'} · 模型`, kind: 'model', scope: 'global', scopeId: '', value: { profileId: profile.value, parameters: { ...current.parameters, ...(temperature.value ? { temperature: Number(temperature.value) } : {}), ...(maxTokens.value ? { max_tokens: Number(maxTokens.value) } : {}) } } }); host.toast('模型与参数预设已保存。'); }), 'small');
    const loadModelPreset = button('加载模型预设', () => host.run(async () => {
      const { presets } = await call<{ presets: Preset[] }>('GET', '/presets?kind=model'); const choice = host.showModal('模型预设', '选中后填入当前会话配置表单。');
      if (!presets.length) choice.body.append(empty('尚无模型预设。'));
      for (const preset of presets) choice.body.append(button(`${preset.name} · v${preset.version}`, () => { const match = profiles.find(item => item.id === preset.value.profileId); if (!match) { host.toast('该预设的服务商配置已不可用。', true); return; } profile.value = match.id; temperature.value = preset.value.parameters?.temperature === undefined ? '' : String(preset.value.parameters.temperature); maxTokens.value = preset.value.parameters?.max_tokens === undefined ? '' : String(preset.value.parameters.max_tokens); updateCompatibility(); choice.close(); }, 'preset-choice'));
    }), 'small');
    dialog.body.append(grid, append(element('div', 'row wrap'), exportButton, presetButton, loadPresets, modelPreset, loadModelPreset), append(element('div', 'form-actions'), button('取消', dialog.close, 'ghost'), button('保存会话配置', () => host.run(async () => {
      const parameters = { ...current.parameters }; if (temperature.value.trim()) parameters.temperature = Number(temperature.value); else delete parameters.temperature; if (maxTokens.value.trim()) parameters.max_tokens = Number(maxTokens.value); else delete parameters.max_tokens;
      if (developer.value.trim() && !profiles.find(item => item.id === profile.value)?.supportsDeveloper) throw new Error('当前提供方不支持 Developer Prompt；请清空该字段或选择支持的提供方。');
      const updated = await call<ChatSession>('POST', `/sessions/${current.id}`, { title: name.value.trim(), profileId: profile.value, workspace: workspace.value.trim(), systemPrompt: system.value, developerPrompt: developer.value, parameters });
      sessions = sessions.map(item => item.id === updated.id ? updated : item); if (selectedId === updated.id) { session = updated; inspector.setContext({ sessionId: updated.id, workspace: updated.workspace }); paintChat(); } dialog.close(); host.toast('配置已保存，下一轮请求生效。');
    }), 'primary', 'save-chat-settings')));
  }
  function paintProjects() {
    if (!target || screen !== 'projects') return;
    target.replaceChildren(); const page = element('div', 'page harness-page'); target.append(page);
    page.append(append(element('div', 'page-heading row spread'), append(element('div'), element('h1', '', 'Projects'), element('p', 'muted', '按真实工作区整理对话与任务。')), append(element('div', 'row'), button('选择项目', () => host.openProject(), '', 'projects-choose'), button('新建 Work', host.newTask, 'primary'))));
    const groups = new Map<string, { path: string; sessions: ChatSession[]; tasks: Task[] }>();
    const group = (workspace?: string) => { const path = workspace || '未绑定项目的会话', key = path.replaceAll('\\', '/').replace(/\/$/, '').toLocaleLowerCase(); const item = groups.get(key) ?? { path, sessions: [], tasks: [] }; groups.set(key, item); return item; };
    for (const item of sessions) group(item.workspace).sessions.push(item);
    for (const item of host.tasks()) group(item.workspace).tasks.push(item);
    if (!groups.size) page.append(empty('还没有项目。创建 Chat 后绑定目录，或创建一个 Work 任务。'));
    const grid = element('div', 'projects-grid');
    for (const item of groups.values()) {
      const card = element('section', 'project-card'); card.append(icon('folder'), element('h2', '', item.path.split(/[/\\]/).at(-1)), element('code', 'source-path', item.path), element('p', 'tiny muted', `${item.sessions.length} 个 Chat · ${item.tasks.length} 个 Work`));
      if (item.path !== '未绑定项目的会话') card.append(button('打开项目工作区', () => host.openProject(item.path), 'small project-open'));
      const entries = element('details', 'project-conversations'); entries.append(element('summary', '', `会话与任务（${item.sessions.length + item.tasks.length}）`));
      for (const chat of item.sessions) entries.append(button(`Chat · ${chat.title}`, () => host.run(async () => { await chooseSession(chat.id); host.showChat(); }), 'project-entry'));
      for (const task of item.tasks) entries.append(button(`${displayStatus(task.status)} · ${task.title}`, () => host.selectTask(task.id), 'project-entry'));
      card.append(entries);
      grid.append(card);
    }
    page.append(grid);
  }
  async function loadHistory(more = false) {
    const data = await call<{ requests: RequestRecord[]; nextCursor: number | null }>('GET', `/requests?order=desc&limit=50${more && historyCursor ? `&after=${historyCursor}` : ''}`);
    history = mergeRequestPages(more ? history : [], data.requests); historyCursor = data.nextCursor; if (screen === 'history') paintHistory();
  }
  function paintHistory() {
    if (!target || screen !== 'history') return;
    target.replaceChildren(); const page = element('div', 'page harness-page'); target.append(page);
    page.append(append(element('div', 'page-heading row spread'), append(element('div'), element('span', 'eyebrow', 'HISTORY'), element('h1', '', '请求与运行历史'), element('p', 'muted', '已持久保存的实际记录，可回到原会话或检查请求。')), button('刷新', () => host.run(async () => loadHistory()), 'small', 'history-refresh')));
    const filter = input('', '筛选已加载的请求、模型与会话', 'history-search'), table = element('div', 'history-list');
    const render = () => {
      table.replaceChildren(); const needle = filter.value.toLocaleLowerCase(), matching = history.filter(item => `${item.id} ${item.sessionId} ${item.kind} ${item.status} ${item.profileId}`.toLocaleLowerCase().includes(needle));
      if (!matching.length) table.append(empty(history.length ? '没有匹配的已加载记录。' : '尚无请求历史。'));
      for (const item of matching) {
        const row = element('article', 'history-row');
        row.append(append(element('div', 'grow'), append(element('div', 'row'), badge(item.kind), element('strong', '', requestStatus[item.status] ?? item.status), element('time', 'tiny muted', new Date(item.createdAt).toLocaleString())), element('code', 'source-path', item.id), element('span', 'tiny muted', requestMetrics(item))));
        row.append(button('检查请求', () => host.run(async () => { inspector.setContext(item.taskId ? { taskId: item.taskId } : { sessionId: item.sessionId }); await inspector.selectRecord(item.id); inspector.openTab('Request'); }), 'small', `history-request-${item.id}`));
        if (item.taskId) row.append(button('打开 Work', () => host.selectTask(item.taskId!), 'small ghost'));
        else if (sessions.some(session => session.id === item.sessionId)) row.append(button('打开 Chat', () => host.run(async () => { await chooseSession(item.sessionId); host.showChat(); }), 'small ghost'));
        table.append(row);
      }
    };
    filter.addEventListener('input', render); render(); page.append(filter, table);
    const more = button('加载下一页', () => host.run(async () => loadHistory(true)), '', 'history-more'); more.disabled = historyCursor === null; page.append(more);
  }
  function appendSettings(page: HTMLElement) {
    const card = testId(element('section', 'card harness-settings'), 'harness-settings'); page.prepend(card);
    card.append(append(element('div', 'row spread'), element('h2', '', 'Chat 与 Harness'), button('管理模型服务商', () => host.run(manageProfiles), 'small', 'manage-profiles')), element('p', 'muted', '独立 Chat 与 Work 共用模型、工具权限和请求记录。请求编辑不会授予工具权限。'));
    host.run(async () => {
      const settings = await call('GET', '/settings'); if (!card.isConnected) return;
      const enabled = input(); enabled.type = 'checkbox'; enabled.checked = settings.recordContent !== false; enabled.dataset.testid = 'record-request-content';
      enabled.addEventListener('change', () => host.run(async () => { try { await call('POST', '/settings', { recordContent: enabled.checked }); host.toast('后续请求记录设置已保存。'); } catch (error) { enabled.checked = !enabled.checked; throw error; } }));
      card.append(append(element('label', 'toggle-label'), enabled, '记录完整提示词、请求 Body 与响应内容'), element('p', 'tiny muted', '关闭后仍保留必要标识、运行状态和用量；已存在的内容需要另行清理。任务恢复与工具授权审计独立保留。'), button('清理详细请求历史', () => host.showConfirm('清理请求调试记录', '将清理 Harness 请求与 Trace 调试记录。不会撤销已发生的工具效果，也不会删除 Work 的内核授权审计。', '清理请求记录', () => host.run(async () => { await call('POST', '/history/clear', { scope: 'requests' }); host.toast('请求调试记录已清理。'); })), 'small danger', 'clear-request-history'));
    });
  }
  async function manageProfiles() {
    await loadCatalog(); const dialog = host.showModal('模型与 API 服务商', '每个服务商保留独立配置。密钥只交给本地后台，普通配置与请求导出不包含密钥。');
    const selected = select([['', '新增服务商'], ...profiles.map(item => [item.id, item.name])] as [string, string][], 'default', 'manage-profile-select');
    const name = input('', '服务商名称', 'profile-name'), url = input('', 'https://api.example.com/v1', 'profile-url'), model = input('', '模型标识', 'profile-model');
    const contextWindow = input('', '可选：填写模型公布的 Token 容量', 'profile-context-window'); contextWindow.type = 'number'; contextWindow.min = '1';
    const mode = select([['mock', 'Mock'], ['live', '真实 API']], 'mock', 'profile-mode'), developer = input(), credential = input('', '留空保留现有配置', 'profile-key'); developer.type = 'checkbox'; credential.type = 'password'; credential.autocomplete = 'off';
    const credentialFile = input('', 'D:\\…\\key.txt（可选）', 'profile-key-file'), allowance = input('100', '', 'profile-allowance'), days = input('20', '', 'profile-days'), authorize = input(); allowance.type = 'number'; allowance.min = '1'; days.type = 'number'; days.min = '1'; days.max = '30'; authorize.type = 'checkbox';
    const load = () => { const item = profiles.find(item => item.id === selected.value); contextWindow.value = item?.provider.contextWindowTokens?.toString() ?? ''; name.value = item?.name ?? ''; url.value = item?.provider.baseUrl ?? ''; model.value = item?.provider.model ?? ''; mode.value = item?.provider.mode ?? 'live'; developer.checked = item?.supportsDeveloper ?? false; credential.value = ''; credentialFile.value = item?.credentialFile ?? ''; authorize.checked = false; }; selected.addEventListener('change', load); load();
    dialog.body.append(field('配置', selected), append(element('div', 'form-grid'), field('名称', name), field('模式', mode), field('Base URL', url, 'full'), field('模型标识', model, 'full'), field('上下文容量（Token；未知留空）', contextWindow, 'full'), field('临时 API Key', credential, 'full'), field('外部密钥文件', credentialFile, 'full'), append(element('label', 'toggle-label full'), developer, '此接口支持 Developer 角色'), field('新授权请求上限', allowance), field('授权天数', days), append(element('label', 'toggle-label full'), authorize, '授权以上有限额度（不勾选则保留已有授权）')),
      append(element('div', 'form-actions'), button('取消', dialog.close, 'ghost'), button('保存服务商', () => host.run(async () => {
        await call('POST', '/profiles', { ...(selected.value ? { id: selected.value } : {}), name: name.value.trim(), mode: mode.value, baseUrl: url.value.trim(), model: model.value.trim(), supportsDeveloper: developer.checked, contextWindowTokens: contextWindow.value ? Number(contextWindow.value) : null, credentialFile: credentialFile.value.trim(), ...(credential.value ? { apiKey: credential.value } : {}), authorizePaid: authorize.checked, maxRequests: Number(allowance.value), authorizeDays: Number(days.value) });
        credential.value = ''; await loadCatalog(); dialog.close(); host.toast('服务商配置已保存。');
      }), 'primary', 'save-profile')));
  }
  return { open, leave, poll, inspector, appendSettings, newSession, mountNavigation, get hasDrafts() { return Boolean(welcomeDraft) || drafts.dirty || inspector.hasDrafts; }, get selectedId() { return selectedId; } };
}


