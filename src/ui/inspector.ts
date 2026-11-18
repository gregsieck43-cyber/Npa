import type { RequestRecord, PromptPart, TraceEvent, ToolRecord, Preset } from '../harness/types.js';
import { append, badge, button, element, empty, field, input, select, textarea, testId } from './dom.js';
import { harnessPath, jsonEditor, requestStatus, type HarnessUiHost } from './harness-ui.js';
import { mergeRequestPages, parseRequestBody, requestDifferences, requestMetrics } from './harness-model.js';
import { errorText, pretty, shortTime } from './view-model.js';
import { inspectorWidth } from './workspace-model.js';
import { mountTaskIntegrations } from './integration-views.js';

export interface InspectorContext { sessionId?: string; taskId?: string; workspace?: string; }
interface InspectorHost extends HarnessUiHost {
  showConfirm(title: string, caption: string, label: string, action: () => void): void;
  changed(): void;
}
type Tab = 'Prompt' | 'Request' | 'Tools' | 'Trace' | 'Context' | 'Diff';
type ToolData = { registered: any[]; allowed: any[]; exposed: any[]; calls: ToolRecord[] };

export function createInspector(host: InspectorHost) {
  let context: InspectorContext = {}, contextKey = '', generation = 0;
  let root: HTMLElement, content: HTMLElement, picker: HTMLSelectElement, meta: HTMLElement;
  let visible = false, tab: Tab = 'Prompt', record: RequestRecord | undefined;
  let records: RequestRecord[] = [], nextCursor: number | null = null;
  let editor: ReturnType<typeof jsonEditor> | undefined;
  let trace: TraceEvent[] = [], traceCursor: number | null = null, traceQuery = '', traceType = '';
  let tools: ToolData | undefined, compare: RequestRecord | undefined, compareId = '';
  let requestMode: 'raw' | 'structured' = 'raw', promptMode = 'segments';
  let loading = false, loadError = '', followLive = true;
  let returnFocus: HTMLElement | null = null;
  const drafts = new Map<string, string>(), dirty = new Set<string>();
  const disclosed = new Map<string, boolean>();
  const call = <T = any>(method: string, path: string, body?: unknown) => host.request<T>(method, harnessPath(path), body);
  const query = (extra: Record<string, string | number | undefined> = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ sessionId: context.sessionId, taskId: context.taskId, ...extra })) if (value !== undefined && value !== '') params.set(key, String(value));
    return params.toString();
  };
  const saveDraft = (text: string) => { if (record) { drafts.set(record.id, text); dirty.add(record.id); followLive = false; } };
  const raw = () => record ? drafts.get(record.id) ?? JSON.stringify(record.body, null, 2) : '';
  const destroyEditor = () => { editor?.destroy(); editor = undefined; };
  function disclosure(label: string, key: string, child: HTMLElement) {
    const node = element('details', 'inspector-disclosure'); node.open = disclosed.has(key);
    node.append(element('summary', '', label), child);
    node.addEventListener('toggle', () => node.open ? disclosed.set(key, true) : disclosed.delete(key));
    return node;
  }
  function setWidth(value: number) {
    const width = inspectorWidth(value, window.innerWidth); root.style.width = `${width}px`;
    root.querySelector('[role="separator"]')?.setAttribute('aria-valuenow', String(Math.round(width)));
    root.style.setProperty('--inspector-width', `${width}px`); localStorage.setItem('npn.inspector.width', String(width));
  }
  function mount(target: HTMLElement) {
    root = testId(element('aside', 'harness-inspector'), 'harness-inspector'); root.hidden = true;
    root.setAttribute('aria-label', '请求与执行检查器');
    const resize = testId(element('div', 'inspector-resize'), 'inspector-resize'); resize.tabIndex = 0; resize.setAttribute('role', 'separator'); resize.setAttribute('aria-label', '调整 Inspector 宽度'); resize.setAttribute('aria-orientation', 'vertical');
    resize.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); resize.setPointerCapture(event.pointerId); root.classList.add('resizing'); });
    resize.addEventListener('pointermove', event => { if (resize.hasPointerCapture(event.pointerId)) setWidth(root.getBoundingClientRect().right - event.clientX); });
    resize.addEventListener('pointerup', event => { if (resize.hasPointerCapture(event.pointerId)) resize.releasePointerCapture(event.pointerId); root.classList.remove('resizing'); });
    resize.addEventListener('lostpointercapture', () => root.classList.remove('resizing'));
    resize.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); setWidth(root.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 24 : -24)); } });
    const title = append(element('div', 'inspector-heading'), append(element('div'), element('strong', '', 'Inspector'), element('span', 'tiny muted', '每次请求，都有来路')),
      button('关闭', () => toggle(false), 'small ghost', 'close-inspector'));
    const tabs = element('div', 'inspector-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '检查视图');
    const names: Tab[] = ['Prompt', 'Request', 'Tools', 'Trace', 'Context', 'Diff'];
    const descriptions = ['提示词与来源', '实际请求与编辑', '工具与审批', '持久执行时间线', '上下文与记忆', '请求差异'];
    for (const [index, name] of names.entries()) {
      const node = button(name, () => openTab(name), '', `inspector-${name.toLowerCase()}`); node.id = `inspector-tab-${name}`; node.title = descriptions[index]; node.setAttribute('role', 'tab'); node.setAttribute('aria-controls', 'inspector-panel'); node.setAttribute('aria-selected', String(name === tab)); node.tabIndex = name === tab ? 0 : -1;
      node.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? names[0] : event.key === 'End' ? names.at(-1)! : names[(index + (event.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length]; openTab(next); document.getElementById(`inspector-tab-${next}`)?.focus(); }); tabs.append(node);
    }
    picker = select([], '', 'inspector-request-select'); picker.setAttribute('aria-label', '选择已记录请求'); picker.addEventListener('change', () => host.run(async () => selectRecord(picker.value)));
    const reload = button('刷新', () => host.run(async () => refresh()), 'small ghost', 'inspector-refresh');
    const preview = button('构造预览', () => host.run(async () => { const value = await call<RequestRecord>('POST', '/preview', context); await selectRecord(value.id); host.toast('已构造最终请求预览，尚未发送。'); }), 'small', 'inspector-preview');
    meta = element('div', 'inspector-meta'); content = testId(element('div', 'inspector-content'), 'inspector-content'); content.id = 'inspector-panel'; content.setAttribute('role', 'tabpanel'); content.tabIndex = 0;
    root.append(resize, title, tabs, append(element('div', 'inspector-picker'), picker, reload), append(element('div', 'inspector-actions'), preview,
      button('加载更多请求', () => host.run(async () => loadRequests(true)), 'small ghost', 'inspector-more-requests')), meta, content);
    target.append(root); setWidth(Number(localStorage.getItem('npn.inspector.width')) || 420); paint();
    window.addEventListener('resize', () => setWidth(Number(root.style.width.replace('px', ''))));
  }
  function toggle(value = !visible) {
    if (value && !visible) returnFocus = document.activeElement as HTMLElement | null;
    visible = value; root.hidden = !visible; root.inert = !visible; host.changed();
    if (visible) { root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus(); host.run(async () => refresh()); }
    else if (returnFocus?.isConnected) returnFocus.focus();
  }
  function openTab(value: Tab) { tab = value; if (!visible) { returnFocus = document.activeElement as HTMLElement | null; visible = true; root.hidden = false; root.inert = false; host.changed(); } paint(); host.run(async () => loadTab()); }
  function paintMeta() {
    picker.replaceChildren(...records.map(item => { const option = element('option', '', `${shortTime(item.createdAt)} · ${item.kind} · ${requestStatus[item.status] ?? item.status} · ${item.id.slice(-7)}`); option.value = item.id; return option; }));
    picker.value = record?.id ?? ''; picker.disabled = !records.length;
    root.querySelector<HTMLButtonElement>('[data-testid="inspector-more-requests"]')!.disabled = nextCursor === null;
    meta.replaceChildren();
    if (!record) return;
    meta.append(badge(requestStatus[record.status] ?? record.status, record.status === 'failed' ? 'failed' : record.status === 'running' ? 'live' : ''), element('span', 'tiny', requestMetrics(record)), element('code', 'request-identity', record.id));
    if (record.parentId) meta.append(element('span', 'tiny muted', `父请求 ${record.parentId}`));
    if (record.error) meta.append(element('div', 'inspector-error', `${record.error.code}: ${record.error.message}`));
  }
  function paint() {
    if (!root) return; destroyEditor(); paintMeta();
    for (const button of root.querySelectorAll<HTMLElement>('[role=tab]')) { const active = button.textContent === tab; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }
    content.setAttribute('aria-labelledby', `inspector-tab-${tab}`); content.setAttribute('aria-busy', String(loading));
    content.replaceChildren();
    if (loadError) { const error = append(element('div', 'inspector-error'), element('p', '', loadError), button('重试读取', () => host.run(refresh), 'small', 'inspector-retry')); error.setAttribute('role', 'alert'); content.append(error); }
    if (!record && tab !== 'Trace' && tab !== 'Tools') { content.append(empty(loading ? '正在读取实际请求…' : '尚无模型请求。发送消息，或构造一次预览。')); return; }
    if (record && !record.recordContent && ['Prompt', 'Request', 'Context', 'Diff'].includes(tab)) { content.append(empty('该请求关闭了详细内容记录；仅保留状态、关联标识与用量。无法重建被省略的实际 Body。')); return; }
    if (tab === 'Prompt') paintPrompt();
    if (tab === 'Request') paintRequest();
    if (tab === 'Tools') paintTools();
    if (tab === 'Trace') paintTrace();
    if (tab === 'Context') paintContext();
    if (tab === 'Diff') paintDiff();
  }
  async function loadRequests(more = false) {
    const epoch = generation;
    const page = await call<{ requests: RequestRecord[]; nextCursor: number | null }>('GET', `/requests?${query({ order: 'desc', limit: 50, after: more ? nextCursor ?? undefined : undefined })}`);
    if (epoch !== generation) return;
    records = mergeRequestPages(more ? records : record ? [record] : [], page.requests); nextCursor = page.nextCursor;
    paintMeta();
    if (!record && records.length) await selectRecord(records[0].id, false);
  }
  async function selectRecord(id: string, manual = true) {
    const epoch = generation;
    const value = await call<RequestRecord>('GET', `/requests/${encodeURIComponent(id)}`);
    if (epoch !== generation) return;
    record = value; if (manual) followLive = false;
    records = mergeRequestPages(records, [value]); tools = undefined; trace = []; traceCursor = null;
    compare = undefined; compareId = record.parentId ?? records.find(item => item.id !== id)?.id ?? '';
    paint(); await loadTab();
  }
  async function loadTab(more = false) {
    const epoch = generation, id = record?.id, currentTab = tab;
    try {
      if (currentTab === 'Tools') {
        const value = await call<ToolData>('GET', `/tools?${query({ requestId: id })}`);
        if (epoch === generation && id === record?.id) tools = value;
      } else if (currentTab === 'Trace') {
        const page = await call<{ events: TraceEvent[]; nextCursor: number | null }>('GET', `/trace?${query({ limit: 50, q: traceQuery, type: traceType, after: more ? traceCursor ?? undefined : undefined })}`);
        if (epoch === generation) { trace = more ? [...trace, ...page.events] : page.events; traceCursor = page.nextCursor; }
      } else if (currentTab === 'Diff' && compareId) {
        const value = await call<RequestRecord>('GET', `/requests/${encodeURIComponent(compareId)}`);
        if (epoch === generation) compare = value;
      }
      if (epoch === generation && currentTab === tab && id === record?.id && ['Tools', 'Trace', 'Diff'].includes(currentTab)) paint();
    } catch (error) { if (epoch === generation) { loadError = errorText(error); paint(); } }
  }
  async function refresh() {
    loading = true; loadError = ''; content.setAttribute('aria-busy', 'true');
    try { await loadRequests(); if (record) { const epoch = generation, id = record.id; const value = await call<RequestRecord>('GET', `/requests/${encodeURIComponent(id)}`); if (epoch === generation && record?.id === id) record = value; } await loadTab(); if (tab === 'Request' && content.querySelector('[data-testid="request-editor-mode"]')) paintMeta(); else paint(); }
    catch (error) { loadError = errorText(error); paint(); }
    finally { loading = false; content.setAttribute('aria-busy', 'false'); }
  }
  function setContext(value: InspectorContext) {
    const key = JSON.stringify(value); if (key === contextKey) return;
    contextKey = key; context = value; generation++; records = []; record = undefined; nextCursor = null; tools = undefined; trace = []; compare = undefined; followLive = true; loadError = '';
    if (root) paint(); if (visible) host.run(async () => refresh());
  }
  function observe(value: RequestRecord) {
    if (!(context.sessionId && context.sessionId === value.sessionId || context.taskId && context.taskId === value.taskId)) return;
    records = mergeRequestPages(records, [value]);
    if (!record || followLive && value.createdAt >= record.createdAt || value.id === record.id) {
      const changedId = record?.id !== value.id; record = value; paintMeta();
      if (changedId) { tools = undefined; if (visible) { paint(); host.run(async () => loadTab()); } }
      else if (visible && tab === 'Request') {
        const response = content.querySelector('.inspector-response'); if (response) response.textContent = pretty(value.response ?? (value.draft ? { content: value.draft } : value.error ?? { status: value.status }));
      }
    }
  }
  function renderPart(part: PromptPart) {
    const body = element('div', 'prompt-part-body'); body.append(element('code', 'source-path', part.source), element('pre', '', part.content || '(空)'));
    return disclosure(`${part.label} · ${part.scope}${part.version !== undefined ? ` v${part.version}` : ''} · 估算 ${part.estimatedTokens} tokens${part.effective === false ? ' · 未生效' : ''}`, `prompt:${record!.id}:${part.id}`, body);
  }
  function paintPrompt() {
    content.append(element('p', 'inspector-note', '这里只展示 NPN-Gamma 构造与发送的内容。System / Developer 按单次 > 会话 > 项目 > 全局覆盖；动态上下文依序追加，Harness 执行约束始终保留。'));
    const mode = select([['segments', '分段与来源'], ['full', '最终有效消息'], ['tokens', 'Token 估算']], promptMode, 'prompt-view'); mode.addEventListener('change', () => { promptMode = mode.value; paint(); });
    content.append(append(element('div', 'inspector-toolbar'), mode, button('编辑作用域', editPrompts, 'small', 'edit-prompt-scopes')));
    const parts = record!.sources ?? [];
    if (promptMode === 'full') { content.append(element('pre', 'inspector-json', pretty(record!.body?.messages))); return; }
    const listed = parts.filter(part => !part.id.startsWith('effective:'));
    if (!listed.length) content.append(empty('没有独立来源分段；请在最终有效消息中检查发送内容。'));
    if (promptMode === 'tokens') {
      const total = listed.reduce((sum, part) => sum + part.estimatedTokens, 0);
      content.append(element('p', 'inspector-note', `本地分段估算合计 ${total.toLocaleString()} tokens；不是服务商计费值，工具 Schema 与消息边界可能产生额外用量。`));
      for (const part of listed) { const bar = element('progress'); bar.max = Math.max(total, 1); bar.value = part.estimatedTokens; bar.setAttribute('aria-label', `${part.label} 估算 Token`); content.append(append(element('div', 'token-row'), element('span', '', part.label), bar, element('code', '', String(part.estimatedTokens)))); }
    } else for (const part of listed) content.append(renderPart(part));
  }
  function editPrompts() {
    const dialog = host.showModal('提示词作用域', '修改影响后续构造的请求；已发送的请求及其快照保持原样。');
    const scope = select([['global', '全局'], ...(context.workspace ? [['project', '当前项目']] : []), ...(context.sessionId ? [['session', '当前会话']] : [])] as [string, string][], context.sessionId ? 'session' : context.workspace ? 'project' : 'global', 'prompt-scope');
    const system = textarea('', '覆盖较低作用域的自定义 System 指令', 'scope-system-prompt'), developer = textarea('', '仅支持 Developer 的提供方可发送', 'scope-developer-prompt'), dynamic = textarea('', '追加动态 User 上下文', 'scope-dynamic-prompt');
    const version = element('p', 'tiny muted'), versions = select([], '', 'prompt-version-select');
    const scopeId = () => scope.value === 'project' ? context.workspace! : scope.value === 'session' ? context.sessionId! : '';
    const apply = (value: any) => { system.value = value.systemPrompt; developer.value = value.developerPrompt; dynamic.value = value.dynamic; version.textContent = `载入版本 v${value.version} · System / Developer 覆盖低级作用域；动态内容追加，保存后对下一次请求生效`; };
    const load = async () => { const current = scope.value, value = await call('GET', `/prompts?scope=${scope.value}&scopeId=${encodeURIComponent(scopeId())}`); if (current !== scope.value) return; apply(value); versions.replaceChildren(...Array.from({ length: Math.min(value.version, 50) }, (_, i) => { const option = element('option', '', `v${value.version - i}${i === 0 ? ' · 当前' : ''}`); option.value = String(value.version - i); return option; })); versions.disabled = !value.version; };
    versions.addEventListener('change', () => host.run(async () => { const value = await call('GET', `/prompts?scope=${scope.value}&scopeId=${encodeURIComponent(scopeId())}&version=${versions.value}`); apply(value); }));
    scope.addEventListener('change', () => host.run(load));
    dialog.body.append(field('保存范围', scope), field('查看或恢复版本（最近 50 个）', versions), version, field('System Prompt', system), field('Developer Prompt', developer), field('动态上下文', dynamic),
      append(element('div', 'form-actions'), button('取消', dialog.close, 'ghost'), button('保存到此范围', () => host.run(async () => { await call('POST', '/prompts', { scope: scope.value, scopeId: scopeId(), systemPrompt: system.value, developerPrompt: developer.value, dynamic: dynamic.value }); dialog.close(); host.toast('提示词已保存，后续新请求生效。'); }), 'primary', 'save-scoped-prompts')));
    host.run(load);
  }
  function setRaw(value: unknown) { saveDraft(JSON.stringify(value, null, 2)); paint(); }
  function paintRequest() {
    if (!record!.body) { content.append(empty('未保存有效请求 Body。')); return; }
    const mode = select([['raw', 'Raw JSON'], ['structured', '结构化编辑']], requestMode, 'request-editor-mode'); mode.addEventListener('change', () => { requestMode = mode.value as typeof requestMode; paint(); });
    content.append(element('p', 'inspector-note', '最终提供方 Body；凭据已脱敏。测试重发创建新请求与父子关联，仅调用模型，返回的工具提议不会自动执行。'), element('code', 'source-path', record!.endpoint));
    content.append(append(element('div', 'inspector-toolbar'), mode,
      button('格式化 / 校验', () => { try { setRaw(parseRequestBody(raw())); host.toast('JSON 结构有效；接口兼容性将在发送时校验。'); } catch (error) { host.toast(errorText(error), true); } }, 'small', 'validate-request'),
      button('复制', () => host.run(async () => { await window.npn.desktop('copy-text', { text: raw() }); host.toast('当前编辑内容已复制。'); }), 'small ghost', 'copy-request')));
    if (requestMode === 'raw') { editor = jsonEditor(raw(), saveDraft); content.append(editor.container); }
    else paintStructured();
    const save = input(); save.type = 'checkbox'; save.dataset.testid = 'save-request-to-session'; save.disabled = !context.sessionId;
    content.append(append(element('label', 'toggle-label inspector-note'), save, '同时保存支持的参数 / 指令到当前会话（否则仅测试一次）'));
    content.append(append(element('div', 'inspector-toolbar wrap'),
      button('发送一次测试', () => host.run(async () => { const body = parseRequestBody(raw()); const next = await call<RequestRecord>('POST', `/requests/${record!.id}/send`, { body, saveToSession: save.checked }); await selectRecord(next.id); host.toast('已创建新测试请求；工具不会自动重放。'); }), 'primary', 'send-studio-request'),
      button('分叉请求', () => host.run(async () => { const body = parseRequestBody(raw()); const next = await call<RequestRecord>('POST', `/requests/${record!.id}/branch`, { body }); await selectRecord(next.id); host.toast('已建立未发送的分叉。'); }), '', 'branch-request'),
      button('导入', importRequest, 'small ghost', 'import-request'),
      button('导出记录', () => host.run(exportRequest), 'small ghost', 'export-request'),
      button('保存预设', savePreset, 'small ghost', 'save-request-preset'),
      button('加载预设', () => host.run(loadPreset), 'small ghost', 'load-request-preset')));
    content.append(element('h4', '', '响应 / 错误'), element('pre', 'inspector-json inspector-response', pretty(record!.response ?? (record!.draft ? { content: record!.draft } : record!.error ?? { status: record!.status }))));
    if (record!.status === 'running') content.append(button('停止此请求', () => host.run(async () => { await call('POST', `/requests/${record!.id}/cancel`); await refresh(); }), 'small danger', 'cancel-studio-request'));
  }
  function paintStructured() {
    let body: Record<string, any>;
    try { body = parseRequestBody(raw()); } catch (error) { content.append(element('div', 'inspector-error', errorText(error)), button('返回 Raw 修正', () => { requestMode = 'raw'; paint(); }, 'small')); return; }
    const model = input(body.model, '', 'studio-model'), temperature = input(body.temperature === undefined ? '' : String(body.temperature), '省略使用服务商默认', 'studio-temperature'), tokens = input(body.max_tokens === undefined ? '' : String(body.max_tokens), '省略使用服务商默认', 'studio-max-tokens');
    temperature.type = 'number'; temperature.step = '0.1'; tokens.type = 'number'; tokens.min = '1';
    const update = () => { body.model = model.value; if (temperature.value) body.temperature = Number(temperature.value); else delete body.temperature; if (tokens.value) body.max_tokens = Number(tokens.value); else delete body.max_tokens; saveDraft(JSON.stringify(body, null, 2)); };
    for (const node of [model, temperature, tokens]) node.addEventListener('input', update);
    content.append(append(element('div', 'form-grid'), field('模型', model, 'full'), field('Temperature', temperature), field('Max Tokens', tokens)));
    body.messages.forEach((message: any, index: number) => {
      const role = select(['system', 'developer', 'user', 'assistant', 'tool'].map(value => [value, value]), message.role, `studio-role-${index}`);
      const text = textarea(typeof message.content === 'string' ? message.content : pretty(message.content), '', `studio-message-${index}`);
      const complex = typeof message.content !== 'string';
      text.readOnly = complex;
      if (complex) text.title = '结构化内容数组、null 与工具字段请在 Raw JSON 中编辑。';
      role.addEventListener('change', () => { message.role = role.value; update(); }); text.addEventListener('input', () => { message.content = text.value; update(); });
      const up = button('↑', () => { [body.messages[index - 1], body.messages[index]] = [body.messages[index], body.messages[index - 1]]; setRaw(body); }, 'small ghost'); up.disabled = index === 0; up.setAttribute('aria-label', `上移消息 ${index + 1}`);
      const down = button('↓', () => { [body.messages[index + 1], body.messages[index]] = [body.messages[index], body.messages[index + 1]]; setRaw(body); }, 'small ghost'); down.disabled = index === body.messages.length - 1; down.setAttribute('aria-label', `下移消息 ${index + 1}`);
      content.append(append(element('div', 'studio-message'), append(element('div', 'row'), element('span', 'tiny muted', String(index + 1)), role, up, down, button('删除', () => { body.messages.splice(index, 1); setRaw(body); }, 'small ghost')), text));
    });
    content.append(button('添加 User 消息', () => { body.messages.push({ role: 'user', content: '' }); setRaw(body); }, 'small', 'studio-add-message'));
    const toolChoice = textarea(body.tool_choice === undefined ? '' : JSON.stringify(body.tool_choice), '例如 "auto" 或 "none"', 'studio-tool-choice');
    const toolList = textarea(JSON.stringify(body.tools ?? [], null, 2), '本次工具 Schema', 'studio-tools');
    const applyTools = button('应用工具字段', () => { try { const value = JSON.parse(toolList.value); if (!Array.isArray(value)) throw new Error('工具定义必须为数组'); if (value.length) body.tools = value; else delete body.tools; if (toolChoice.value.trim()) body.tool_choice = JSON.parse(toolChoice.value); else delete body.tool_choice; setRaw(body); } catch (error) { host.toast(errorText(error), true); } }, 'small');
    content.append(disclosure('工具定义与 Tool Choice', 'structured-tools', append(element('div'), field('Tools', toolList), field('Tool Choice', toolChoice), applyTools)), element('p', 'tiny muted', '其他提供方扩展字段保留在 Raw JSON 中。编辑工具 Schema 不会增加执行权限。'));
  }
  function importRequest() {
    const dialog = host.showModal('导入请求 Body', '粘贴或选择 JSON 文件。导入仅更新编辑草稿，不会立即发送。');
    const text = textarea('', '完整服务商请求 JSON', 'import-request-text'); text.className = 'request-import';
    const file = input(); file.type = 'file'; file.accept = '.json,application/json';
    file.addEventListener('change', () => host.run(async () => { if (file.files?.[0]) { if (file.files[0].size > 262144) throw new Error('导入文件上限 256 KiB。'); text.value = await file.files[0].text(); } }));
    dialog.body.append(file, text, append(element('div', 'form-actions'), button('取消', dialog.close, 'ghost'), button('导入到草稿', () => { try { setRaw(parseRequestBody(text.value)); dialog.close(); } catch (error) { host.toast(errorText(error), true); } }, 'primary', 'apply-import-request')));
  }
  async function exportRequest() {
    const data = await call('GET', `/export?requestId=${record!.id}`);
    const result = await window.npn.desktop('save-export', { filename: `npn-${record!.id}.json`, content: JSON.stringify(data, null, 2) });
    if (result) host.toast('请求记录已导出。');
  }
  function savePreset() {
    const dialog = host.showModal('保存请求预设', '保存当前有效草稿。选择已有预设将保存新版本，原版本保留。');
    const name = input('', '例如：低温度代码审查', 'preset-name');
    const scope = select([['global', '全局'], ...(context.sessionId ? [['session', '当前会话']] : []), ...(context.workspace ? [['project', '当前项目']] : [])] as [string, string][], 'global', 'preset-scope');
    const existing = select([['', '新建预设']], '', 'preset-existing');
    host.run(async () => {
      const { presets } = await call<{ presets: Preset[] }>('GET', '/presets?kind=request');
      for (const preset of presets) { const option = element('option', '', `${preset.name} · v${preset.version}`); option.value = preset.id; existing.append(option); }
      existing.addEventListener('change', () => { const preset = presets.find(item => item.id === existing.value); if (preset) { name.value = preset.name; scope.value = preset.scope; } });
    });
    dialog.body.append(field('版本目标', existing), field('预设名称', name), field('作用域', scope), append(element('div', 'form-actions'), button('取消', dialog.close, 'ghost'), button('保存', () => host.run(async () => {
      if (!name.value.trim()) throw new Error('请输入预设名称。');
      await call('POST', '/presets', { ...(existing.value ? { id: existing.value } : {}), name: name.value.trim(), kind: 'request', scope: scope.value, scopeId: scope.value === 'session' ? context.sessionId : scope.value === 'project' ? context.workspace : '', value: parseRequestBody(raw()) });
      dialog.close(); host.toast('请求预设已保存。');
    }), 'primary', 'confirm-save-preset')));
  }
  async function loadPreset() {
    const { presets } = await call<{ presets: Preset[] }>('GET', '/presets?kind=request&history=true');
    const dialog = host.showModal('请求预设', '加载到当前编辑草稿，不会立即发送。');
    if (!presets.length) dialog.body.append(empty('还没有请求预设。'));
    for (const preset of presets) dialog.body.append(button(`${preset.name} · v${preset.version} · ${preset.scope}`, () => { setRaw(preset.value); dialog.close(); }, 'preset-choice'));
  }
  function paintTools() {
    if (!tools) { content.append(empty('正在读取工具定义与实际调用…')); return; }
    const summaries = [['注册', tools.registered], ['当前权限', tools.allowed], ['本次暴露', tools.exposed], ['实际调用', tools.calls]] as const;
    content.append(append(element('div', 'tool-counts'), ...summaries.map(([label, list]) => append(element('div'), element('strong', '', String(list.length)), element('span', '', label)))));
    for (const [label, list] of summaries.slice(0, 3)) content.append(disclosure(`${label}工具 · ${list.length}`, `tools:${label}`, element('pre', 'inspector-json', pretty(list))));
    if (!tools.calls.length) content.append(empty('该范围内尚未记录工具调用。工具暴露给模型不代表模型已选择或执行。'));
    for (const callRecord of tools.calls) {
      const detail = element('div', 'tool-call-detail');
      detail.append(element('p', 'tiny muted', `来源 ${callRecord.source} · 权限 ${callRecord.permission} · 重试 ${callRecord.retries} · ${callRecord.durationMs === undefined ? '耗时未知' : `${callRecord.durationMs} ms`}`), element('code', 'source-path', `call ${callRecord.toolCallId}\nrequest ${callRecord.requestId}${callRecord.parentId ? `\nparent ${callRecord.parentId}` : ''}`));
      if (callRecord.failureStage) detail.append(element('div', 'inspector-error', `失败阶段：${({ unknown_tool: '未知工具', permission: '权限检查', validation: '参数 / Schema 校验', execution: '实际执行', reconciliation: '未知效果对账' })[callRecord.failureStage]}`));
      detail.append(element('h4', '', '实际参数'), element('pre', 'inspector-json', pretty(callRecord.arguments)), element('h4', '', 'Description 与 Schema'), element('pre', 'inspector-json', pretty({ description: callRecord.description, schema: callRecord.schema })), element('h4', '', '返回 / 错误'), element('pre', 'inspector-json', pretty(callRecord.error ?? callRecord.result ?? '尚无返回')));
      detail.append(element('p', 'tiny', callRecord.receivedByRequestId ? `结果进入请求 ${callRecord.receivedByRequestId}` : '尚未记录结果进入后续请求。'));
      if (callRecord.status === 'awaiting_approval') detail.append(append(element('div', 'row'),
        button('批准这次调用', () => host.showConfirm('批准工具调用', `${callRecord.name}\n${pretty(callRecord.arguments)}\n仅批准此处显示的准确动作。`, '批准调用', () => host.run(async () => { await call('POST', `/tools/${callRecord.id}/approve`, { approved: true, digest: callRecord.digest }); await loadTab(); })), 'small primary', `approve-chat-tool-${callRecord.id}`),
        button('拒绝', () => host.run(async () => { await call('POST', `/tools/${callRecord.id}/approve`, { approved: false, digest: callRecord.digest }); await loadTab(); }), 'small danger', `deny-chat-tool-${callRecord.id}`)));
      const callNode = disclosure(`${callRecord.parentId ? '↳ ' : ''}${callRecord.name} · ${callRecord.status}`, `call:${callRecord.id}`, detail);
      if (callRecord.parentId) callNode.classList.add('nested-call');
      content.append(callNode);
    }
  }
  function paintTrace() {
    const search = input(traceQuery, '搜索事件 / 内容', 'trace-search'), type = input(traceType, '事件类型（精确）', 'trace-type');
    const form = element('form', 'trace-filter'); form.append(search, type, button('筛选', () => form.requestSubmit(), 'small', 'trace-filter'));
    form.addEventListener('submit', event => { event.preventDefault(); traceQuery = search.value; traceType = type.value; host.run(async () => loadTab()); }); content.append(form);
    if (!trace.length) content.append(empty('没有匹配的持久化事件。'));
    const timeline = element('div', 'trace-timeline');
    for (const event of trace) {
      const body = append(element('div'), element('code', 'source-path', pretty({ eventId: event.id, sessionId: event.sessionId, taskId: event.taskId, runId: event.runId, requestId: event.requestId, parentId: event.parentId, payloadReference: event.payloadReference })), element('pre', 'inspector-json', pretty(event.payload ?? {})));
      if (event.requestId) body.append(button('查看关联请求', () => host.run(async () => { await selectRecord(event.requestId!); openTab('Request'); }), 'small ghost'));
      timeline.append(disclosure(`${shortTime(event.timestamp)} · ${event.type} · ${event.status}${event.durationMs === undefined ? '' : ` · ${event.durationMs} ms`}`, `trace:${event.id}`, body));
    }
    content.append(timeline); const more = button('加载下一页事件', () => host.run(async () => loadTab(true)), 'small', 'trace-more'); more.disabled = traceCursor === null; content.append(more);
  }
  function paintContext() {
    const parts = record!.sources ?? [], contextParts = parts.filter(part => !part.id.startsWith('effective:') && (part.scope === 'session' || part.scope === 'project' || /context|memory|history|instruction/i.test(`${part.id} ${part.source}`)));
    const messages = record!.body?.messages ?? [];
    content.append(element('p', 'inspector-note', `${messages.length} 条有效消息 · ${new TextEncoder().encode(JSON.stringify(record!.body ?? {})).length.toLocaleString()} 字节（脱敏快照） · Token 见服务商实际用量。上下文窗口上限未声明时不显示占用百分比。`));
    content.append(element('p', 'tiny muted', '此处只列本次保留内容与来源。未记录的检索或压缩决策不会被推断为已发生。附件文本与网页均按不可信来源处理。'));
    for (const part of contextParts) content.append(renderPart(part));
    if (!contextParts.length) content.append(empty('本次没有单独记录上下文来源。可在 Request 中检查完整消息。'));
    content.append(disclosure('请求上下文原文', `context:${record!.id}`, element('pre', 'inspector-json', pretty(messages))));
    if (context.taskId) mountTaskIntegrations(content, context.taskId, host, () => undefined, 'evidence');
  }
  function paintDiff() {
    const options = [['', '与当前编辑草稿比较'], ...records.filter(item => item.id !== record!.id).map(item => [item.id, `${shortTime(item.createdAt)} · ${item.id.slice(-8)}`])] as [string, string][];
    if (compareId && !options.some(option => option[0] === compareId)) options.push([compareId, `父请求 ${compareId.slice(-8)}`]);
    const choice = select(options, compareId, 'diff-request-select'); choice.addEventListener('change', () => { compareId = choice.value; compare = undefined; if (compareId) host.run(async () => loadTab()); else paint(); });
    content.append(field('比较基准（左）→ 当前请求 / 草稿（右）', choice));
    if (compareId && !compare) { content.append(empty('正在读取比较版本…')); return; }
    if (compareId && !compare!.body) { content.append(empty('基准请求没有记录 Body，无法比较。')); return; }
    try {
      const before = compareId ? compare!.body : record!.body, after = parseRequestBody(raw());
      const differences = requestDifferences(before, after);
      if (!differences.length) content.append(empty('两个请求没有字段差异。'));
      for (const difference of differences) content.append(append(element('div', 'request-difference'), element('code', '', difference.path), append(element('div', 'difference-columns'), element('pre', 'removed', difference.before === undefined ? '(不存在)' : pretty(difference.before)), element('pre', 'added', difference.after === undefined ? '(已移除)' : pretty(difference.after)))));
    } catch (error) { content.append(element('div', 'inspector-error', `当前草稿无法比较：${errorText(error)}`)); }
  }
  async function poll() {
    if (!visible || loading) return;
    const epoch = generation;
    if (followLive && context.taskId) {
      const page = await call<{ requests: RequestRecord[] }>('GET', `/requests?${query({ order: 'desc', limit: 1 })}`);
      const latest = page.requests[0];
      if (epoch === generation && latest && latest.id !== record?.id) await selectRecord(latest.id, false);
    }
    if (record?.status === 'running') { const epoch = generation, id = record.id; const value = await call<RequestRecord>('GET', `/requests/${id}`); if (epoch === generation && id === record?.id) observe(value); }
    if (tab === 'Tools') {
      const id = record?.id, value = await call<ToolData>('GET', `/tools?${query({ requestId: id })}`);
      if (epoch === generation && id === record?.id && JSON.stringify(value) !== JSON.stringify(tools)) { tools = value; paint(); }
    }
  }
  return { mount, toggle, openTab, setContext, observe, selectRecord, refresh, poll, get visible() { return visible; }, get hasDrafts() { return dirty.size > 0; } };
}
