import type { Task } from '../contracts.js';
import type { UiState } from './index.js';
import { append, badge, button, element, empty, field, input, select, sectionTitle, statusBadge, testId, textarea } from './dom.js';
import { arrayValue, lines, pretty, shortTime } from './view-model.js';
import { themePicker } from './theme.js';
import { activityHeatmap } from './activity.js';
import { activitySummary, type ActivityReport } from './activity-model.js';
import { mountIntegrationSettings } from './integration-views.js';

interface PanelHost {
  state: UiState;
  getMain(): HTMLElement;
  request<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  run(action: () => Promise<void>): void;
  toast(message: string, error?: boolean): void;
  showModal(title: string, caption: string): { body: HTMLElement; close(): void };
  showConfirm(title: string, content: string, label: string, action: () => void): void;
  refresh(force: boolean): Promise<void>;
  selectedTask(): Task | undefined;
  selectTask(id: string): void;
  paintEvents(target: HTMLElement): void;
  paintMain(): void;
  paintSidebar(): void;
  appendHarnessSettings(page: HTMLElement): void;
}
type RecordData = Record<string, any>;

/** Secondary screens share only the explicit renderer host and narrow backend bridge. */
export function createPanels(host: PanelHost) {
  const { state, request, run, toast, showModal, showConfirm, refresh, selectedTask, selectTask, paintEvents, paintMain, paintSidebar } = host;
  let settingsSection = 'appearance';
function pageHeader(eyebrow: string, title: string, caption: string): HTMLElement {
  return append(element('header', 'page-header'), element('div', 'eyebrow', eyebrow), element('h1', '', title), element('p', '', caption));
}
function paintSettings(): void {
  if (state.screen !== 'settings') return;
  host.getMain().replaceChildren(); const page = element('div', 'page-scroll');
  page.classList.add('settings-page');
  page.append(pageHeader('', 'Settings', '外观、模型与工作规则。修改只在明确保存后生效。'));
  const layout = element('div', 'settings-layout'), navigation = element('nav', 'settings-navigation'), detail = element('div', 'settings-detail');
  navigation.setAttribute('aria-label', '设置分组');
  const sections = new Map<string, HTMLElement>();
  const labels = [['appearance', '外观与快捷键'], ['model', '模型连接'], ['instructions', '指令与 Skills'], ['search', '网页检索'], ['privacy', '请求记录'], ['integrations', '协作与 REA'], ['system', '本机与恢复']];
  const selectSection = (id: string) => { settingsSection = id; for (const [key, node] of sections) node.hidden = key !== id; for (const node of navigation.querySelectorAll<HTMLElement>('button')) node.setAttribute('aria-current', node.dataset.section === id ? 'page' : 'false'); };
  for (const [id, label] of labels) { const section = element('section', 'settings-section'); section.id = `settings-section-${id}`; section.setAttribute('aria-label', label); section.append(element('h2', '', label)); sections.set(id, section); detail.append(section); const node = button(label, () => selectSection(id), 'ghost', `settings-tab-${id}`); node.dataset.section = id; navigation.append(node); }
  layout.append(navigation, detail); page.append(layout); selectSection(settingsSection);
  const area = (id: string) => sections.get(id)!;
  const identity = element('div', 'runtime-summary'); identity.dataset.testid = 'runtime-details';
  identity.append(element('strong', '', state.runtimeInfo ? `NPN Gamma ${state.runtimeInfo.version}` : 'NPN Gamma · 正在读取版本'), element('div', 'mono', state.runtimeInfo?.packageRoot ?? '等待桌面宿主返回安装位置')); area('system').append(identity);
  area('appearance').append(themePicker(), element('p', 'muted', '默认暖白，深色覆盖消息、编辑器、检查器与对话框。系统减少动态效果偏好会自动生效。'));
  const shortcuts = element('dl', 'keyboard-reference');
  for (const [key, label] of [['Ctrl K', '搜索与操作'], ['Ctrl B', '展开 / 收起侧栏'], ['Ctrl 1 / 2 / 3', 'Chat / Work / Code'], ['Ctrl Shift I', '展开 / 收起 Inspector'], ['Ctrl ,', '打开设置'], ['Shift Enter', '消息换行'], ['Esc', '关闭面板或当前对话框']]) shortcuts.append(append(element('div'), element('dt', '', label), element('dd', '', key)));
  area('appearance').append(sectionTitle('键盘操作'), shortcuts);
  host.appendHarnessSettings(area('privacy'));
  mountIntegrationSettings(area('integrations'), host);
  const provider = state.config?.provider ?? { mode: 'mock', baseUrl: '', model: 'deepseek/deepseek-v4.1-flash' };
  const card = element('section', 'card'); card.append(element('h3', '', 'Chat Completions 接口'));
  const form = element('form'); const grid = element('div', 'form-grid');
  const mode = select([['mock', '本地演示 · Mock'], ['live', '真实模型 · Chat Completions']], provider.mode, 'provider-mode');
  const baseUrl = input(provider.baseUrl, 'https://api.commandcode.ai/provider/v1', 'provider-url');
  const model = input(provider.model, 'deepseek/deepseek-v4.1-flash', 'provider-model');
  const credential = input('', '输入密钥，仅发送给本地后台会话', 'provider-key'); credential.type = 'password'; credential.autocomplete = 'off'; credential.spellcheck = false;
  const credentialFile = input(state.config?.credentialFile ?? '', 'D:\\…\\api-key.txt · 仅包含密钥的文本文件', 'provider-credential-file');
  const filePicker = append(element('div', 'workspace-picker'), credentialFile, button('选择文件', () => run(async () => { const chosen = await window.npn.desktop('select-file'); if (chosen) credentialFile.value = chosen; }), 'small', 'pick-credential-file'), button('清空', () => { credentialFile.value = ''; }, 'small ghost', 'clear-credential-file'));
  const maxOutputTokens = input(String(provider.maxOutputTokens ?? 4096), '', 'provider-max-output-tokens'); maxOutputTokens.type = 'number'; maxOutputTokens.min = '64'; maxOutputTokens.max = '8192'; maxOutputTokens.step = '1'; maxOutputTokens.required = true;
  const maxRequestBytes = input(String(provider.maxRequestBytes ?? 131072), '', 'provider-max-request-bytes'); maxRequestBytes.type = 'number'; maxRequestBytes.min = '4096'; maxRequestBytes.max = '262144'; maxRequestBytes.step = '1'; maxRequestBytes.required = true;
  const maxRequests = input(String(state.config?.remainingLiveRequests || 1000), '', 'paid-request-limit'); maxRequests.type = 'number'; maxRequests.min = '1'; maxRequests.max = '1000000'; maxRequests.step = '1'; maxRequests.required = true;
  const authorizeDays = input('20', '', 'paid-authorization-days'); authorizeDays.type = 'number'; authorizeDays.min = '1'; authorizeDays.max = '30'; authorizeDays.step = '1'; authorizeDays.required = true;
  const authorized = input('', '', 'authorize-paid'); authorized.type = 'checkbox'; authorized.checked = false;
  mode.addEventListener('change', () => {
    if (mode.value === 'live' && provider.mode !== 'live') baseUrl.value = state.config?.liveDefaults?.baseUrl ?? 'https://api.commandcode.ai/provider/v1';
    else if (mode.value === 'mock') baseUrl.value = state.config?.provider?.mode === 'mock' ? state.config.provider.baseUrl : '';
    credential.disabled = mode.value === 'mock'; credentialFile.disabled = mode.value === 'mock'; maxRequests.disabled = mode.value === 'mock'; authorizeDays.disabled = mode.value === 'mock'; authorized.disabled = mode.value === 'mock';
  });
  credential.disabled = mode.value === 'mock'; credentialFile.disabled = mode.value === 'mock'; maxRequests.disabled = mode.value === 'mock'; authorizeDays.disabled = mode.value === 'mock'; authorized.disabled = mode.value === 'mock';
  grid.append(field('模型模式', mode), field('模型标识', model), field('接口地址 · 自动使用 /chat/completions', baseUrl, 'full'), field('会话密钥 · 后台退出后清除', credential, 'full'), field('外部密钥文件 · 重启后可继续读取', filePicker, 'full'));
  grid.append(element('p', 'full tiny muted', '可选择 安装卷纯密钥文本文件，设置只保存文件路径；也可以临时输入会话密钥。输入新密钥时会移除文件引用。'));
  grid.append(field('单次输出上限（64–8192 tokens）', maxOutputTokens), field('单次请求上限（4096–262144 字节）', maxRequestBytes));
  grid.append(element('p', 'full tiny muted', '请求大小包含工具定义，按最终 UTF-8 字节计数。应用配置后，可单独测试一次连接。'));
  const billing = append(element('div', 'full allowance-box stack'), element('h3', '', '持续运行授权'), append(element('div', 'form-grid'), field('新授权请求额度 · 1–1,000,000 次', maxRequests), field('授权有效期 · 1–30 天', authorizeDays)), append(element('label', 'toggle-label'), authorized, '授权以上额度与有效期，供后台持续执行任务'), element('p', 'tiny muted', '未勾选时保留已有额度。已用请求在重启后仍计入额度；重新授权会开始新一轮计数。你也可以在服务商账户设置费用上限。'));
  grid.append(billing); form.append(grid);
  const configure = button('保存连接配置', () => { form.requestSubmit(); }, 'primary', 'configure-provider');
  if (state.config?.configurationError) {
    const issue = testId(element('div', 'configuration-error'), 'configuration-error'); issue.setAttribute('role', 'alert');
    issue.append(element('strong', '', '已保存的配置无法读取'), element('p', '', String(state.config.configurationError)), element('p', '', '请核对下面的参数，再应用表单配置修复。连接测试仍需单独点击。'), button('应用表单配置以修复', () => { form.requestSubmit(); }, 'small', 'repair-configuration'));
    card.append(issue);
  }
  const test = button('测试已应用的连接（1 次）', () => run(async () => {
    const result = await request('POST', '/v1/connection-test', {}); state.settingsResult = `连接测试返回\n${pretty(result)}`; state.settingsError = false;
    state.config = await request('GET', '/v1/config'); paintSettings(); toast('连接测试已完成。');
  }), '', 'test-connection');
  form.append(append(element('div', 'form-actions'), test, configure));
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    const settings: RecordData = { mode: mode.value, baseUrl: baseUrl.value.trim(), model: model.value.trim(), maxOutputTokens: Number(maxOutputTokens.value), maxRequestBytes: Number(maxRequestBytes.value), authorizePaid: authorized.checked, maxRequests: Number(maxRequests.value), authorizeDays: Number(authorizeDays.value) };
    if (credentialFile.value.trim() !== (state.config?.credentialFile ?? '')) settings.credentialFile = credentialFile.value.trim();
    if (credential.value) settings.apiKey = credential.value;
    run(async () => { state.config = await request('POST', '/v1/config', settings); credential.value = ''; state.settingsResult = '当前会话配置已应用。连接测试只会在你点击按钮后发起。'; state.settingsError = false; paintSettings(); await refresh(false); });
  });
  card.append(form, element('div', 'connection-summary', `凭据${state.config?.credentialPresent ? '已就绪' : '未配置'}${state.config?.credentialFile ? ' · 外部文件' : ''} · 可用请求 ${(state.config?.remainingLiveRequests ?? 0).toLocaleString()}${state.config?.authorizationExpiresAt ? ` · 授权至 ${new Date(state.config.authorizationExpiresAt).toLocaleString()}` : ''}`));
  if (state.settingsResult) card.append(element('div', `connection-result${state.settingsError ? ' error' : ''}`, state.settingsResult));
  area('model').append(card);
  const instructionCard = element('section', 'card');
  instructionCard.append(element('p', '', '全局指令文件与 Skill 根目录需要明确填写 F: 路径。运行时还会读取工作区祖先和适用子目录中的 AGENTS.md / agent.md，并显示实际来源和摘要。'));
  const globalPaths = textarea(arrayValue<string>(state.config?.globalPaths).join('\n'), 'D:\\…\\AGENTS.md\nD:\\…\\agent.md', 'global-instruction-paths');
  const skillRoots = textarea(arrayValue<string>(state.config?.skillRoots).join('\n'), 'D:\\…\\skills', 'skill-roots');
  const pickInstruction = button('选择指令文件', () => run(async () => { const chosen = await window.npn.desktop('select-file'); if (chosen) globalPaths.value = [...lines(globalPaths.value), chosen].join('\n'); }), 'small', 'pick-instruction-file');
  const pickSkill = button('选择 Skill 目录', () => run(async () => { const chosen = await window.npn.desktop('select-folder'); if (chosen) skillRoots.value = [...lines(skillRoots.value), chosen].join('\n'); }), 'small', 'pick-skill-folder');
  const instructionForm = element('div', 'form-grid');
  instructionForm.append(field('全局指令路径（每行一个）', globalPaths), field('Skill 根目录（每行一个）', skillRoots));
  instructionCard.append(instructionForm, append(element('div', 'form-actions'), pickInstruction, pickSkill, button('保存指令来源', () => run(async () => {
    state.config = await request('POST', '/v1/config', { mode: provider.mode, baseUrl: provider.baseUrl, model: provider.model, globalPaths: lines(globalPaths.value), skillRoots: lines(skillRoots.value) });
    state.instructions = state.selectedId ? await request('GET', `/v1/instructions?taskId=${encodeURIComponent(state.selectedId)}`) : undefined; paintSettings(); toast('指令来源已保存并重新加载。');
  }), 'primary small', 'save-instruction-paths')));
  paintInstructions(instructionCard); area('instructions').append(instructionCard);
  const searchCard = element('section', 'card');
  if (state.config?.searchConfigurationError) { const error = element('div', 'configuration-error', `检索配置无法读取：${state.config.searchConfigurationError}。核对下方参数并保存以修复；普通对话不受影响。`); error.setAttribute('role', 'alert'); searchCard.append(error); }
  const searchProvider = select([['mwmbl', 'Mwmbl · 免费通用网页搜索'], ['wikipedia', 'Wikipedia · 百科检索'], ['searxng', 'SearXNG · 自选搜索实例']], state.config?.searchProvider ?? 'mwmbl', 'search-provider');
  const searxUrl = input(state.config?.searxUrl ?? '', 'https://你的实例（需启用 JSON 搜索）', 'searx-url');
  searxUrl.disabled = searchProvider.value !== 'searxng'; searchProvider.addEventListener('change', () => { searxUrl.disabled = searchProvider.value !== 'searxng'; });
  const searchGrid = element('div', 'form-grid'); searchGrid.append(field('检索服务', searchProvider), field('SearXNG 基础 URL', searxUrl)); searchCard.append(searchGrid, element('p', 'tiny muted', 'Mwmbl 无需密钥，适合一般网页检索，索引覆盖可能有限。百科查询可选择 Wikipedia。'));
  searchCard.append(append(element('div', 'form-actions'), button('应用检索设置', () => run(async () => {
    state.config = await request('POST', '/v1/config', { mode: provider.mode, baseUrl: provider.baseUrl, model: provider.model, searchProvider: searchProvider.value, searxUrl: searxUrl.value.trim() }); paintSettings(); toast('检索服务设置已应用。');
  }), 'primary small', 'configure-search'))); area('search').append(searchCard);
  area('system').append(sectionTitle('后台健康与诊断', button('刷新状态', () => run(async () => { await refresh(true); paintSettings(); }), 'small', 'refresh-health')));
  const health = element('div', 'card'), diagnostic = element('details', 'diagnostic-details'); diagnostic.append(element('summary', '', '查看后台运行详情'), element('pre', 'subtle-box', pretty(state.health)));
  health.append(diagnostic, append(element('div', 'form-actions'), button('打开本地数据与日志', () => run(async () => { await window.npn.desktop('open-data'); }), 'small', 'open-data'), button('退出并停止后台', () => showConfirm('停止持久后台', '任务状态会保留，下次启动会恢复并对账。未提交文字或未保存编辑在关闭前会提示继续编辑或明确丢弃。文件保存需单独批准并实际写入。待审批动作保留，未批准的动作不会自动执行。普通关窗会让后台继续工作。', '停止后台并退出', () => run(async () => { await window.npn.desktop('quit-backend'); })), 'small danger', 'quit-backend')));
  area('system').append(health); host.getMain().append(page);
}
function paintInstructions(target: HTMLElement): void {
  if (!state.instructions) { target.append(empty('选择任务后显示它实际读取的指令与 Skill 来源。')); return; }
  const sources = arrayValue(state.instructions.sources), skills = arrayValue(state.instructions.skills);
  target.append(sectionTitle(`生效来源 · ${sources.length}`));
  for (const source of sources) target.append(append(element('div', 'subtle-box'), element('div', 'row spread'), element('div', 'mono tiny', `${source.kind} · precedence ${source.precedence}\n${source.path}\nSHA-256 ${source.sha256}`)));
  if (!sources.length) target.append(empty('当前没有读取到配置的指令文件。'));
  target.append(sectionTitle(`发现的 Skill · ${skills.length}`));
  for (const skill of skills) {
    const card = element('div', 'subtle-box'); card.append(append(element('div', 'row spread'), element('strong', '', skill.name), badge(skill.selected ? '当前选用' : '可用', skill.selected ? 'live' : '')), element('div', '', skill.description), element('div', 'mono tiny muted', skill.path)); target.append(card);
  }
  if (state.instructions.text) { const details = element('details'); details.append(element('summary', 'tiny muted', '查看已拼装指令'), element('pre', 'subtle-box', state.instructions.text)); target.append(details); }
}

async function loadExtensions(): Promise<void> {
  state.plugins = arrayValue(await request('GET', '/v1/plugins'));
  state.mcp = arrayValue(await request('GET', '/v1/mcp'));
  paintExtensions();
}
function paintExtensions(): void {
  if (state.screen !== 'extensions') return;
  host.getMain().replaceChildren(); const page = element('div', 'page-scroll');
  page.append(pageHeader('扩展能力', '插件与外部工具', '稳定内核保留审批与审计。插件按清单和工件摘要加载，外部 MCP 工具调用沿用任务授权。'));
  page.append(append(element('div', 'row spread'), element('h3', '', '已安装插件'), append(element('div', 'row'), button('刷新', () => run(loadExtensions), 'small', 'refresh-plugins'), button('＋ 安装本地插件', () => showInstallPlugin(), 'primary small', 'install-plugin'))));
  page.append(element('div', 'subtle-box', '支持原生 npn-plugin/1 与受限 DSH 清单适配 dsh-manifest/1。当前仅支持声明式纯文本变换；任意 JavaScript、原生二进制、安装钩子与未声明依赖不会执行。'));
  if (!state.plugins.length) page.append(empty('尚未安装插件。可选择产品自带的无害示例目录进行安装测试。'));
  for (const plugin of state.plugins) {
    const card = element('article', 'card tool-card'); card.append(append(element('div', 'row spread'), element('h3', '', plugin.name), badge(plugin.enabled ? '已启用' : '已禁用', plugin.enabled ? 'live' : '')));
    card.append(element('div', 'tiny muted', `${plugin.id} · ${plugin.version} · ${plugin.manifest?.api ?? 'npn-plugin/1'} · ${plugin.adapter}`), element('div', 'subtle-box mono tiny', `工件摘要 ${plugin.digest}\n当前摘要 ${plugin.currentDigest}\n权限 ${arrayValue<string>(plugin.manifest?.permissions).join(', ') || '无'}\n批准状态 ${plugin.approvalValid ? '摘要批准有效' : '待批准或内容已变化'}`));
    const actions = element('div', 'approval-actions');
    actions.append(button('批准当前工件', () => showConfirm(`批准插件 ${plugin.name}`, `请核对当前内容与权限。批准只绑定工件摘要：\n${plugin.currentDigest ?? plugin.digest}`, '批准此摘要', () => run(async () => { await request('POST', '/v1/plugins/approve', { id: plugin.id, digest: plugin.currentDigest ?? plugin.digest }); await loadExtensions(); })), 'small', `approve-plugin-${plugin.id}`));
    const toggle = button(plugin.enabled ? '禁用' : '启用', () => run(async () => { await request('POST', `/v1/plugins/${plugin.enabled ? 'disable' : 'enable'}`, { id: plugin.id }); await loadExtensions(); }), 'small', `toggle-plugin-${plugin.id}`); toggle.disabled = !plugin.enabled && !plugin.approvalValid; actions.append(toggle);
    const test = button('运行纯文本示例', () => showPluginRun(plugin), 'primary small', `test-plugin-${plugin.id}`); test.disabled = !plugin.enabled; actions.append(test); card.append(actions); page.append(card);
  }
  page.append(sectionTitle('MCP 客户端', button('＋ 连接 stdio 服务', () => showMcpConnect(), 'primary small', 'connect-mcp')));
  page.append(element('p', 'muted tiny', '这是连接外部 MCP 服务的客户端。NPN 本身也提供 stdio MCP 服务与 CLI，均读取同一个后台任务状态。'));
  if (!state.mcp.length) page.append(empty('暂无已配置的外部 MCP 服务。连接时需明确项目内可执行文件和参数。'));
  for (const server of state.mcp) {
    const id = server.config.id;
    const card = element('article', 'card tool-card'); card.append(append(element('div', 'row spread'), element('h3', '', server.config.name ?? id), badge(server.status === 'connected' ? '已连接' : (server.status ?? '已配置'), server.status === 'connected' ? 'live' : '')));
    card.append(element('pre', 'subtle-box', pretty(server.config ?? { command: server.command, args: server.args, cwd: server.cwd })));
    if (server.error) card.append(element('div', 'issue-message', String(server.error)));
    const actions = element('div', 'approval-actions');
    if (server.status === 'disconnected') actions.append(button('核对并重新连接', () => run(async () => {
      const result = await request('POST', '/v1/mcp/connect', server.config);
      showConfirm('批准重新连接 MCP 服务', `请核对启动工件摘要与配置：\n${result.digest}\n${pretty(server.config)}`, '批准启动', () => run(async () => { await request('POST', '/v1/mcp/connect', { ...server.config, approvedDigest: result.digest }); await loadExtensions(); toast('MCP 服务已重新连接。'); }));
    }), 'primary small', `reconnect-mcp-${id}`));
    const listTools = button('列出工具', () => run(async () => { const result = await request('POST', '/v1/mcp/tools', { id }); showMcpTools(id, arrayValue(result.tools ?? result)); }), 'small', `list-mcp-tools-${id}`); listTools.disabled = server.status !== 'connected';
    actions.append(listTools, button('断开连接', () => run(async () => { await request('POST', '/v1/mcp/disconnect', { id }); await loadExtensions(); }), 'small danger', `disconnect-mcp-${id}`));
    card.append(actions); page.append(card);
  }
  page.append(sectionTitle('共享后台的自动化入口'), element('div', 'card mono tiny', 'npn.cmd submit / status / cancel / retry / result\nnpn-mcp.cmd：newline-delimited JSON-RPC 2.0 / MCP stdio\n工具调用在任务中生成审批，效果未知时不会自动重复执行。'));
  host.getMain().append(page);
}
function showInstallPlugin(): void {
  const dialog = showModal('安装本地插件', '安装只读取清单与声明式资源，启用前还需工件摘要批准'); const path = input('', 'D:\\…\\plugin-directory', 'plugin-path');
  dialog.body.append(field('插件目录', path));
  dialog.body.append(append(element('div', 'form-actions'), button('选择目录', () => run(async () => { const chosen = await window.npn.desktop('select-folder'); if (chosen) path.value = chosen; }), '', 'choose-plugin-folder'), button('安装清单', () => run(async () => { const result = await request('POST', '/v1/plugins/install', { path: path.value.trim() }); dialog.close(); await loadExtensions(); toast(`插件已安装，等待批准：${result.name ?? result.id}`); }), 'primary', 'submit-plugin-install')));
  path.focus();
}
function showPluginRun(plugin: RecordData): void {
  const dialog = showModal('纯文本插件测试', `${plugin.name} · 执行已经声明并批准的操作`);
  const operations = arrayValue(plugin.manifest?.operations).map(operation => [operation.id, operation.title ?? operation.id] as [string, string]);
  const operation = select(operations, operations[0]?.[0] ?? '', 'plugin-operation'); const value = textarea('  Hello NPN  ', '输入纯文本', 'plugin-input');
  const output = element('pre', 'subtle-box'); output.dataset.testid = 'plugin-output';
  dialog.body.append(field('操作', operation), field('输入', value), output, append(element('div', 'form-actions'), button('运行', () => run(async () => { output.textContent = pretty(await request('POST', '/v1/plugins/execute', { id: plugin.id, operation: operation.value, input: value.value })); }), 'primary', 'run-plugin')));
}
function showMcpConnect(): void {
  const dialog = showModal('连接 MCP stdio 服务', '选择项目内可执行文件，核对启动参数。服务启动与工具调用分别批准。');
  const id = input('', '例如：local-docs', 'mcp-id'); const command = input('', 'D:\\…\\node.exe', 'mcp-command'); const args = textarea('[]', 'JSON 字符串数组，例如：["D:\\\\…\\\\server.js"]', 'mcp-args'); const cwd = input('', 'D:\\…\\server-project', 'mcp-cwd');
  const grid = element('div', 'form-grid'); grid.append(field('服务标识', id), field('工作目录', cwd), field('可执行文件', command, 'full'), field('参数（JSON 数组）', args, 'full'));
  dialog.body.append(grid, append(element('div', 'form-actions'), button('选择程序', () => run(async () => { const chosen = await window.npn.desktop('select-file'); if (chosen) command.value = chosen; }), 'small', 'choose-mcp-command'), button('选择工作目录', () => run(async () => { const chosen = await window.npn.desktop('select-folder'); if (chosen) cwd.value = chosen; }), 'small', 'choose-mcp-cwd'), button('核对并连接', () => run(async () => {
    const config = { id: id.value.trim(), name: id.value.trim(), command: command.value.trim(), args: JSON.parse(args.value), cwd: cwd.value.trim() };
    const result = await request('POST', '/v1/mcp/connect', config);
    if (result.status === 'approval_required' || result.approvalRequired) {
      showConfirm('批准 MCP 服务启动', `启动配置与本地工件绑定摘要：\n${result.digest}\n\n${pretty(config)}`, '批准启动', () => run(async () => { await request('POST', '/v1/mcp/connect', { ...config, approvedDigest: result.digest }); dialog.close(); await loadExtensions(); toast('MCP 服务已连接。'); }));
    } else { dialog.close(); await loadExtensions(); toast('MCP 服务已连接。'); }
  }), 'primary', 'submit-mcp-connect')));
}
function showMcpTools(id: string, tools: RecordData[]): void {
  const dialog = showModal('MCP 工具列表', `${id} · 工具执行需要当前任务的具体动作批准`);
  if (!tools.length) dialog.body.append(empty('服务没有提供工具。'));
  for (const tool of tools) {
    const card = element('div', 'card tool-card'); card.append(element('h3', '', tool.name), element('p', '', tool.description ?? ''));
    const schema = element('details'); schema.append(element('summary', 'tiny muted', '参数结构'), element('pre', 'subtle-box', pretty(tool.inputSchema))); card.append(schema);
    const args = textarea('{}', 'JSON 参数对象', `mcp-tool-args-${tool.name}`); card.append(args);
    const call = button('为当前任务申请调用', () => run(async () => { const result = await request('POST', '/v1/mcp/call', { taskId: state.selectedId, id, name: tool.name, arguments: JSON.parse(args.value) }); dialog.close(); toast(`MCP 调用已提交审批：${pretty(result)}`); state.screen = 'tasks'; state.view = 'tools'; await refresh(true); paintMain(); paintSidebar(); }), 'primary small', `call-mcp-${tool.name}`); call.disabled = !state.selectedId; card.append(append(element('div', 'approval-actions'), call)); dialog.body.append(card);
  }
}

function paintRecovery(): void {
  if (state.screen !== 'recovery') return;
  host.getMain().replaceChildren(); const page = element('div', 'page-scroll');
  page.append(pageHeader('任务恢复', '持久恢复与任务适配', '任务状态、原始历史与工件回执保留在本地。重启会核对未知效果；重复控制请求按独立 ID 去重。'));
  const health = state.health; const cards = element('div', 'cards');
  cards.append(append(element('div', 'card'), element('div', 'metric', state.snapshot.tasks.filter(task => task.status === 'reconciling').length.toString()), element('div', 'metric-label', '任务正在对账')), append(element('div', 'card'), element('div', 'metric', state.snapshot.tasks.filter(task => task.status === 'paused').length.toString()), element('div', 'metric-label', '暂停并保留上下文')));
  page.append(cards, sectionTitle('恢复诊断'));
  const diagnostics = element('div', 'card'); diagnostics.append(element('pre', '', pretty(health.recovery ?? {})));
  if (state.backendError) diagnostics.append(element('div', 'issue-message', state.backendError));
  diagnostics.append(append(element('div', 'form-actions'), button('刷新并对账', () => run(async () => { await refresh(true); paintRecovery(); }), 'small', 'refresh-recovery'), button('打开数据与离线恢复文件', () => run(async () => { await window.npn.desktop('open-data'); }), 'small', 'open-recovery-data')));
  page.append(diagnostics);
  const actionable = state.snapshot.tasks.filter(task => ['failed', 'reconciling', 'paused', 'waiting_input'].includes(task.status));
  for (const task of actionable) {
    const card = element('div', 'card tool-card'); card.append(append(element('div', 'row spread'), element('h3', '', task.title), statusBadge(task)), element('p', '', task.error ?? task.waitingReason ?? '状态已持久保存。'));
    card.append(append(element('div', 'approval-actions'), button('查看任务证据', () => selectTask(task.id), 'small', `recovery-task-${task.id}`))); page.append(card);
  }
  page.append(sectionTitle('任务局部配置适配', button('＋ 创建候选', () => showCandidateCreate(), 'primary small', 'create-candidate')));
  page.append(element('div', 'subtle-box', '候选保存在独立工件中，可改变任务提示后缀和受限纯文本变换。先测试，再按工件摘要批准；暂停任务后激活。批准、权限和审计内核不属于候选修改范围。'));
  if (!state.candidates.length) page.append(empty('尚未创建任务适配候选。选择任务后可创建、测试、批准、激活与回滚。'));
  for (const candidate of state.candidates) {
    const task = state.snapshot.tasks.find(item => item.id === candidate.taskId);
    const card = element('article', 'card tool-card'); card.dataset.candidateId = candidate.id;
    card.append(append(element('div', 'row spread'), element('h3', '', candidate.name), badge(candidate.status, candidate.status === 'active' ? 'live' : candidate.status === 'failed' ? 'failed' : '')));
    card.append(element('div', 'subtle-box mono tiny', `任务 ${task?.title ?? candidate.taskId}\n工件 ${candidate.artifactDigest}\n基础版本 ${candidate.baseVersion} · 工件版本 ${candidate.artifactVersion}\n权限变化 ${pretty(candidate.capabilityDiff)}`));
    if (candidate.testReport) {
      const details = element('details'); details.append(element('summary', 'tiny muted', '查看候选测试报告'), element('pre', 'subtle-box', pretty(candidate.testReport))); card.append(details);
    }
    const actions = element('div', 'approval-actions wrap');
    actions.append(button('测试候选', () => run(async () => { await request('POST', '/v1/candidates/test', { id: candidate.id }); await loadCandidates(); }), 'small', `test-candidate-${candidate.id}`));
    const approve = button('批准此工件', () => showConfirm('批准任务适配候选', `批准绑定以下工件、任务和基础版本：\n${candidate.artifactDigest}\n${candidate.taskId} · version ${candidate.baseVersion}\n权限变化 ${pretty(candidate.capabilityDiff)}`, '批准此工件', () => run(async () => {
      await request('POST', '/v1/candidates/approve', { id: candidate.id, artifactDigest: candidate.artifactDigest, taskId: candidate.taskId, expectedVersion: candidate.baseVersion, capabilityDiff: candidate.capabilityDiff }); await loadCandidates();
    })), 'small', `approve-candidate-${candidate.id}`); approve.disabled = candidate.status !== 'tested'; actions.append(approve);
    const activate = button('激活', () => run(async () => { await request('POST', '/v1/candidates/activate', { id: candidate.id }); await loadCandidates(); toast('候选已激活到任务的新版本。'); }), 'primary small', `activate-candidate-${candidate.id}`);
    activate.disabled = candidate.status !== 'approved' || Boolean(task && ['running', 'queued', 'waiting_approval', 'reconciling'].includes(task.status));
    activate.title = '先暂停任务，然后激活已经批准的工件'; actions.append(activate);
    if (candidate.status === 'active') {
      const rollback = button('回滚到上一版本', () => showConfirm('回滚任务适配', '回滚会恢复已知的上一版配置或基线，任务必须先暂停。', '执行回滚', () => run(async () => { await request('POST', '/v1/candidates/rollback', { taskId: candidate.taskId }); await loadCandidates(); toast('任务适配已回滚。'); })), 'small danger', `rollback-candidate-${candidate.id}`);
      rollback.disabled = Boolean(task && ['running', 'queued', 'waiting_approval', 'reconciling'].includes(task.status)); actions.append(rollback);
    }
    actions.append(button('查看所属任务', () => selectTask(candidate.taskId), 'small ghost')); card.append(actions); page.append(card);
  }
  page.append(sectionTitle('离线恢复边界'), element('div', 'card', '应用分发保留已知良好版本和本地恢复入口。恢复时保留原始状态与证据，并核对内容摘要。模型密钥不写入分发工件。长期可靠性需要独立持续实测，当前未完成 20 天实验。'));
  host.getMain().append(page);
}
function syncRecoveryControls(): void {
  if (state.screen !== 'recovery') return;
  for (const candidate of state.candidates) {
    const task = state.snapshot.tasks.find(item => item.id === candidate.taskId);
    const blocked = Boolean(task && ['running', 'queued', 'waiting_approval', 'reconciling'].includes(task.status));
    const activate = host.getMain().querySelector<HTMLButtonElement>(`[data-testid="${CSS.escape(`activate-candidate-${candidate.id}`)}"]`);
    const rollback = host.getMain().querySelector<HTMLButtonElement>(`[data-testid="${CSS.escape(`rollback-candidate-${candidate.id}`)}"]`);
    if (activate) activate.disabled = candidate.status !== 'approved' || blocked;
    if (rollback) rollback.disabled = candidate.status !== 'active' || blocked;
  }
}
async function loadCandidates(): Promise<void> { state.candidates = arrayValue(await request('GET', '/v1/candidates')); await refresh(false); paintRecovery(); }
function showCandidateCreate(): void {
  if (!selectedTask()) { toast('先选择一个任务，再创建专属适配。', true); return; }
  const task = selectedTask()!; const dialog = showModal('创建任务适配候选', `只作用于“${task.title}”，候选将在独立工件中保存`);
  const name = input('', '例如：简洁交付说明', 'candidate-name'); const suffix = textarea('', '补充任务的提示要求', 'candidate-prompt-suffix');
  const transform = select([['identity', '保持文本'], ['trim', '去除两端空白'], ['prefix', '添加前缀'], ['suffix', '添加后缀']], 'identity', 'candidate-transform'); const value = input('', '前缀或后缀内容', 'candidate-transform-value');
  const grid = element('div', 'form-grid'); grid.append(field('候选名称', name, 'full'), field('提示后缀', suffix, 'full'), field('纯文本变换', transform), field('变换参数', value)); dialog.body.append(grid);
  dialog.body.append(append(element('div', 'form-actions'), button('取消', dialog.close, 'ghost'), button('保存独立候选', () => run(async () => {
    await request('POST', '/v1/candidates/create', { taskId: task.id, name: name.value.trim(), promptSuffix: suffix.value, transform: { kind: transform.value, value: value.value } }); dialog.close(); await loadCandidates(); toast('候选已保存；先测试，再批准激活。');
  }), 'primary', 'submit-candidate-create')));
}
async function loadActivity(): Promise<void> {
  if (state.activityLoading) return;
  state.activityLoading = true; state.activityError = ''; paintActivity();
  try { state.activity = await request<ActivityReport>('GET', '/v1/activity?days=90'); }
  catch (error) { state.activityError = error instanceof Error ? error.message : String(error); }
  finally { state.activityLoading = false; paintActivity(); }
}
function paintActivity(): void {
  if (state.screen !== 'activity') return;
  host.getMain().replaceChildren(); const page = element('div', 'page-scroll activity-page'); page.append(pageHeader('活动记录', '看见工作的每一步。', '从桌面、IDE 到 CLI，所有任务的真实进展汇集在这里。'));
  const total = state.activity ? activitySummary(state.activity.days) : undefined, cards = element('div', 'activity-metrics');
  for (const [value, label, caption] of [[state.snapshot.tasks.filter(task => task.status === 'running').length, '正在推进', '当前任务'], [state.snapshot.tasks.filter(task => task.status === 'waiting_approval').length, '等待批准', '需要你的判断'], [total?.modelCalls, '模型调用', '近 90 天'], [total?.tasksCompleted, '完成任务', '近 90 天']] as const) cards.append(append(element('div', 'metric-card'), element('div', 'metric', value === undefined ? '—' : value.toLocaleString()), element('div', 'metric-label', label), element('div', 'metric-caption', caption)));
  page.append(cards, sectionTitle('活动日历', button(state.activityLoading ? '正在读取…' : '刷新活动', () => run(async () => { await refresh(true); await loadActivity(); }), 'small ghost', 'refresh-activity')));
  if (state.activity) page.append(activityHeatmap(state.activity));
  else page.append(testId(element('div', 'card activity-loading muted', state.activityLoading ? '正在读取持久活动记录…' : '尚未载入活动数据'), 'activity-loading'));
  if (state.activityError) page.append(element('p', 'issue-message', `活动读取失败：${state.activityError}`));
  page.append(sectionTitle('任务一览'));
  const table = element('table', 'table'); const head = element('thead'); const hr = element('tr'); ['任务', '状态', '模型预算', '所有者', '最近更新', ''].forEach(label => hr.append(element('th', '', label))); head.append(hr); table.append(head);
  const body = element('tbody');
  for (const task of [...state.snapshot.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const row = element('tr'); row.append(element('td', '', task.title), append(element('td'), statusBadge(task)), element('td', 'mono tiny', `${task.modelCalls}/${task.goal.maxModelCalls}`), element('td', 'mono tiny', task.owner), element('td', 'tiny muted', shortTime(task.updatedAt)), append(element('td'), button('查看', () => selectTask(task.id), 'small', `activity-task-${task.id}`))); body.append(row);
  }
  table.append(body); page.append(append(element('div', 'table-wrap'), table));
  if (!state.snapshot.tasks.length) page.append(empty('还没有任务。新建会话，开始积累你的工作轨迹。'));
  const task = selectedTask();
  if (task) { page.append(sectionTitle(`已选任务的时间线 · ${task.title}`)); const events = element('div'); paintEvents(events); page.append(events); }
  host.getMain().append(page);
}

function paintWeb(): void {
  if (state.screen !== 'web') return;
  host.getMain().replaceChildren(); const page = element('div', 'page-scroll');
  page.append(pageHeader('联网研究', '网页搜索与正文抓取', '检索资料，查看网页正文，并保留来源与获取时间。'));
  const searchCard = element('section', 'card'); searchCard.append(element('h3', '', '搜索'));
  const query = input(state.webQuery, '输入检索词', 'web-query'); query.addEventListener('input', () => { state.webQuery = query.value; });
  const search = () => run(async () => { state.webResults = await request('POST', '/v1/web/search', { query: query.value.trim() }); paintWeb(); });
  const searchForm = append(element('form', 'search-row'), query, button('搜索', search, 'primary', 'web-search')); searchForm.addEventListener('submit', event => { event.preventDefault(); search(); }); searchCard.append(searchForm);
  searchCard.append(element('p', 'tiny muted', state.config?.searchProvider === 'searxng' ? `当前搜索实例：${state.config.searxUrl}` : state.config?.searchProvider === 'wikipedia' ? '当前使用 Wikipedia 百科检索。可在设置中切换通用网页搜索。' : '当前使用 Mwmbl 免费通用网页搜索，无需密钥。索引覆盖有限，可在设置中选择其他来源。')); page.append(searchCard);
  const fetchCard = element('section', 'card'); fetchCard.append(element('h3', '', '页面抓取 / 站点爬取'));
  const url = input(state.webUrl, 'https://example.com/page', 'web-url'); url.addEventListener('input', () => { state.webUrl = url.value; });
  const maxPages = input('3', '', 'crawl-max-pages'); maxPages.type = 'number'; maxPages.min = '1'; maxPages.max = '5';
  const maxDepth = input('1', '', 'crawl-max-depth'); maxDepth.type = 'number'; maxDepth.min = '0'; maxDepth.max = '2';
  const grid = element('div', 'form-grid'); grid.append(field('页面 URL', url, 'full'), field('最多页面（1–5）', maxPages), field('同站深度（0–2）', maxDepth)); fetchCard.append(grid);
  fetchCard.append(append(element('div', 'form-actions'), button('抓取单页', () => run(async () => { state.webResults = await request('POST', '/v1/web/fetch', { url: url.value.trim() }); paintWeb(); }), '', 'web-fetch'), button('按上限爬取', () => run(async () => { state.webResults = await request('POST', '/v1/web/crawl', { url: url.value.trim(), maxPages: Number(maxPages.value), maxDepth: Number(maxDepth.value) }); paintWeb(); }), 'primary', 'web-crawl')));
  page.append(fetchCard);
  if (state.webResults) paintWebResults(page, state.webResults);
  host.getMain().append(page);
}
function sourceButton(url: string): HTMLElement { const source = button(`复制来源 · ${url}`, () => run(async () => { await window.npn.desktop('copy-source', { url }); toast('来源链接已复制。'); }), 'small ghost mono'); source.title = '复制来源 URL'; return source; }
function paintWebResults(target: HTMLElement, result: RecordData): void {
  target.append(sectionTitle('检索与抓取结果', badge('外部资料')));
  if (result.results) {
    target.append(element('div', 'subtle-box', `${result.provider}\n范围 ${result.scope === 'encyclopedia' ? '百科检索' : '通用网页'} · 获取时间 ${result.fetchedAt}`));
    if (!result.results.length) target.append(empty('检索没有返回结果。'));
    for (const row of result.results) {
      const card = element('article', 'card tool-card'); card.append(element('h3', '', row.title), sourceButton(row.url), element('p', '', row.snippet));
      if (row.source) card.append(element('div', 'tiny muted', `检索来源 · ${row.source}`));
      card.append(append(element('div', 'approval-actions'), button('抓取此页', () => run(async () => { state.webUrl = row.url; state.webResults = await request('POST', '/v1/web/fetch', { url: row.url }); paintWeb(); }), 'small'))); target.append(card);
    }
  } else {
    const pages = result.pages ?? [result];
    for (const page of pages) {
      const card = element('article', 'card tool-card'); card.append(element('h3', '', page.title), sourceButton(page.url), element('div', 'tiny muted', `获取时间 ${page.fetchedAt} · ${page.contentType}`), element('pre', 'subtle-box', page.text));
      if (page.links?.length) { const details = element('details'); details.append(element('summary', 'tiny muted', `${page.links.length} 个页面链接`), element('pre', 'subtle-box', page.links.join('\n'))); card.append(details); } target.append(card);
    }
    if (result.errors?.length) target.append(element('pre', 'issue-message', pretty(result.errors)));
    if (result.maxPages) target.append(element('div', 'tiny muted', `已按 ${result.maxPages} 页 / 深度 ${result.maxDepth} 的上限完成当前抓取。`));
  }
}


  return { paintSettings, paintExtensions, loadExtensions, paintRecovery, syncRecoveryControls, loadCandidates, paintActivity, loadActivity, paintWeb };
}
