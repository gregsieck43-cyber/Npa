import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Intent, Task } from '../contracts.js';
import { append, button, element, input, select, textarea } from './dom.js';
import { pretty } from './view-model.js';

export interface EditorHost {
  request<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  run(action: () => Promise<void>): void | Promise<void>;
  toast(text: string, error?: boolean): void;
  showConfirm(title: string, content: string, label: string, action: () => void): unknown;
  proposeTool(path: string, body: Record<string, unknown>): Promise<any>;
  showApprovals(): void;
  chooseWorkspace(): void;
}
interface BufferTab { path: string; text: string; saved: string; exists: boolean; state?: EditorState; proposal?: { content: string; requestId: string }; pending?: { content: string; toolCallId: string; requestId: string }; }
interface Workbench { node: HTMLElement; task: Task; tabs: Map<string, BufferTab>; active: string; expanded: Set<string>; directory: Map<string, any[]>; view?: EditorView; tree: HTMLElement; tabbar: HTMLElement; canvas: HTMLElement; footer: HTMLElement; output: HTMLElement; search: string; terminal: HTMLTextAreaElement; terminalMode: HTMLSelectElement; }

/** Editor state belongs to each task; layout remounts do not discard text or undo history. */
export function createEditor(host: EditorHost) {
  const workbenches = new Map<string, Workbench>();
  const codeColors = syntaxHighlighting(HighlightStyle.define([{ tag: tags.keyword, color: 'var(--syntax-keyword)' }, { tag: tags.string, color: 'var(--syntax-string)' }, { tag: tags.number, color: 'var(--syntax-number)' }, { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' }, { tag: tags.function(tags.variableName), color: 'var(--syntax-function)' }, { tag: tags.typeName, color: 'var(--syntax-type)' }, { tag: tags.operator, color: 'var(--syntax-operator)' }]));
  let visible: Workbench | undefined;
  const theme = EditorView.theme({
    '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--editor-bg)', fontSize: '13px' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', lineHeight: '1.8' },
    '.cm-content': { padding: '18px 0' }, '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--muted)', border: 'none', paddingRight: '8px' },
    '.cm-activeLine,.cm-activeLineGutter': { backgroundColor: 'var(--hover)' }, '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground': { backgroundColor: 'var(--selection) !important' }, '.cm-focused': { outline: 'none' },
    '.cm-panels,.cm-tooltip': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--border)' },
    '.cm-searchMatch': { backgroundColor: 'var(--warning-soft)' }, '.cm-searchMatch-selected': { outline: '1px solid var(--gold)' },
  });
  function remember(w: Workbench) {
    if (!w) return;
    const tab = w.tabs.get(w.active);
    if (tab && w.view) { tab.state = w.view.state; tab.text = w.view.state.sliceDoc(); }
  }
  function language(filename: string) {
    return /\.[cm]?[jt]sx?$/.test(filename) ? javascript({ typescript: /\.tsx?$/.test(filename), jsx: /\.[jt]sx$/.test(filename) })
      : /\.json$/.test(filename) ? json() : /\.md$/.test(filename) ? markdown() : [];
  }
  function hasUnwrittenChanges(tab: BufferTab): boolean {
    return !tab.exists || tab.text !== tab.saved || Boolean(tab.proposal || tab.pending);
  }
  function tabs(w: Workbench) {
    w.tabbar.replaceChildren();
    for (const tab of w.tabs.values()) {
      const wrap = element('div', `editor-tab${tab.path === w.active ? ' active' : ''}${hasUnwrittenChanges(tab) ? ' dirty' : ''}`);
      const label = button(`${tab.path.split('/').at(-1)}${hasUnwrittenChanges(tab) ? ' ●' : ''}`, () => activate(w, tab.path), 'ghost', `editor-tab-${tab.path}`);
      label.title = tab.path; label.setAttribute('role', 'tab'); label.setAttribute('aria-selected', String(tab.path === w.active));
      wrap.append(label, button('×', () => {
        const close = () => { remember(w); w.tabs.delete(tab.path); if (w.active === tab.path) { w.active = ''; const next = [...w.tabs.keys()].at(-1); if (next) activate(w, next); else { w.view?.destroy(); w.view = undefined; paintCanvas(w); } } tabs(w); };
        if (hasUnwrittenChanges(tab)) host.showConfirm('关闭未保存的文件', `${tab.path} 的编辑尚未确认写入。关闭将丢弃本地编辑草稿，已提交的后台写入申请仍保留，不会撤回审批。`, '丢弃草稿并关闭文件', close); else close();
      }, 'ghost', `close-tab-${tab.path}`));
      w.tabbar.append(wrap);
    }
    const current = w.tabs.get(w.active);
    w.footer.textContent = current ? `${current.path}  ·  UTF-8  ·  ${current.text.split('\n').length} 行${current.pending ? '  ·  等待写入审批' : current.proposal ? '  ·  写入申请尚未确认' : hasUnwrittenChanges(current) ? '  ·  未保存' : '  ·  已保存'}` : 'Ctrl+S 保存 · Ctrl+F 文件内搜索 · Ctrl+Z 撤销';
  }
  function paintCanvas(w: Workbench) {
    w.canvas.replaceChildren();
    w.canvas.append(append(element('div', 'editor-empty'), element('h2', '', '打开一个文件，开始工作'), element('p', '', '从文件树选择文件，或新建文件。编辑内容会在切换模式后保留。')));
  }
  function activate(w: Workbench, filename: string) {
    remember(w); w.view?.destroy(); w.active = filename; w.canvas.replaceChildren();
    const tab = w.tabs.get(filename)!;
    if (!tab.state) tab.state = EditorState.create({ doc: tab.text, extensions: [basicSetup, EditorView.cspNonce.of('npn-gamma-editor'), theme, codeColors, language(filename), EditorState.lineSeparator.of(tab.text.includes('\r\n') ? '\r\n' : '\n'), keymap.of([{ key: 'Mod-s', run: () => { host.run(() => save(w)); return true; } }]), EditorView.updateListener.of(update => {
      if (update.docChanged) { const current = w.tabs.get(w.active); if (current) { current.text = update.state.sliceDoc(); tabs(w); } }
    })] });
    w.view = new EditorView({ state: tab.state, parent: w.canvas });
    w.view.contentDOM.dataset.testid = 'code-editor'; w.view.contentDOM.setAttribute('aria-label', `编辑 ${filename}`);
    tabs(w); w.view.focus();
  }
  async function open(w: Workbench, filename: string, reload = false) {
    if (w.tabs.has(filename) && !reload) { activate(w, filename); return; }
    const result = await host.request('GET', `/v1/files?taskId=${encodeURIComponent(w.task.id)}&path=${encodeURIComponent(filename)}`);
    if (typeof result.content !== 'string') throw new Error('请选择可读取的 UTF-8 文件。');
    w.tabs.set(filename, { path: filename, text: result.content, saved: result.content, exists: true }); activate(w, filename);
  }
  async function directory(w: Workbench, dirname: string) {
    const result = await host.request('GET', `/v1/files?taskId=${encodeURIComponent(w.task.id)}&path=${encodeURIComponent(dirname || '.')}`);
    w.directory.set(dirname, result.entries ?? []); paintTree(w);
  }
  function paintTree(w: Workbench) {
    w.tree.replaceChildren();
    function branch(dirname: string, depth: number) {
      for (const row of [...(w.directory.get(dirname) ?? [])].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))) {
        if (w.search && row.type !== 'directory' && !row.path.toLowerCase().includes(w.search.toLowerCase())) continue;
        const item = button(`${row.type === 'directory' ? w.expanded.has(row.path) ? '▾' : '▸' : '▤'}  ${row.name}`, () => {
          if (row.type === 'directory') { if (w.expanded.has(row.path)) w.expanded.delete(row.path); else { w.expanded.add(row.path); host.run(() => directory(w, row.path)); } paintTree(w); }
          else host.run(() => open(w, row.path));
        }, 'ghost editor-tree-item', `file-${row.path}`);
        item.style.paddingLeft = `${12 + depth * 14}px`; item.title = row.path; w.tree.append(item);
        if (row.type === 'directory' && w.expanded.has(row.path)) branch(row.path, depth + 1);
      }
    }
    branch('', 0);
    if (!w.tree.childNodes.length) w.tree.append(element('p', 'editor-empty-hint', w.search ? '当前已加载目录没有匹配文件。' : '目录为空，可以新建文件。'));
  }
  async function save(w: Workbench) {
    remember(w); const tab = w.tabs.get(w.active); if (!tab) return;
    if (tab.pending?.content === tab.text) { if (visible === w) host.showApprovals(); return; }
    const submitted = tab.text;
    const requestId = tab.proposal?.content === submitted ? tab.proposal.requestId : crypto.randomUUID();
    tab.proposal = { content: submitted, requestId }; tabs(w);
    const proposal = await host.proposeTool('/v1/files', { taskId: w.task.id, path: tab.path, content: submitted, requestId });
    if (typeof proposal.toolCallId !== 'string') throw new Error('Save proposal has no tool-call provenance. Refresh its approval before retrying.');
    tab.proposal = undefined;
    tab.pending = { content: submitted, toolCallId: proposal.toolCallId, requestId }; tabs(w); host.toast('保存已提交，请批准本次文件写入。');
    if (visible === w) host.showApprovals(); else host.toast(`${w.task.title} 的保存审批已保留在原任务。`);
  }
  function make(task: Task): Workbench {
    const node = element('div', 'editor-workbench');
    const explorer = element('aside', 'editor-explorer'); explorer.setAttribute('aria-label', '文件与搜索');
    const tree = element('div', 'editor-tree');
    const search = input('', '搜索文件或内容', 'editor-search'); search.setAttribute('aria-label', '工作区搜索');
    const searchResults = element('div', 'editor-search-results');
    const center = element('div', 'editor-center'), tabbar = element('div', 'editor-tabs'); tabbar.setAttribute('role', 'tablist');
    const canvas = element('div', 'editor-canvas'), footer = element('div', 'editor-footer');
    const output = element('pre', 'editor-terminal-output'); output.dataset.testid = 'terminal-output';
    const terminal = textarea('', 'node --version 或 JSON 参数数组', 'terminal-command'); terminal.rows = 2;
    const terminalMode = select([['powershell', 'PowerShell'], ['version', 'Node 快捷命令'], ['argv', 'Node 参数数组']], 'powershell', 'terminal-mode');
    terminal.placeholder = '输入命令，例如 git status 或 npm test';
    terminalMode.addEventListener('change', () => { terminal.placeholder = terminalMode.value === 'powershell' ? '输入命令，例如 git status 或 npm test' : terminalMode.value === 'argv' ? '["--version"]' : 'node --version'; });
    const w: Workbench = { node, task, tabs: new Map(), active: '', expanded: new Set(), directory: new Map(), tree, tabbar, canvas, footer, output, search: '', terminal, terminalMode };
    explorer.append(append(element('div', 'editor-toolbar'), element('strong', '', '文件'), button('+', () => {
      const dialog = element('dialog', 'editor-file-dialog') as HTMLDialogElement;
      const filename = input('', 'src/main.ts', 'new-file-path'); filename.setAttribute('aria-label', '新文件相对路径');
      const create = () => host.run(async () => {
        if (!filename.value.trim()) return;
        if (/^(?:[\\/]|[A-Za-z]:)|(?:^|[\\/])\.\.(?:[\\/]|$)/.test(filename.value)) { host.toast('请输入工作区内的相对文件路径。', true); return; }
        const relative = filename.value.trim().replaceAll('\\', '/').split('/').filter(part => part && part !== '.').join('/');
        if (!relative) return;
        if (!w.tabs.has(relative)) {
          const result = await host.request('GET', `/v1/files?taskId=${encodeURIComponent(task.id)}&path=${encodeURIComponent(relative)}&allowMissing=true`);
          if (result.entries) throw new Error('此路径是目录，请选择文件名。');
          w.tabs.set(relative, { path: relative, text: result.content ?? '', saved: result.content ?? '', exists: result.exists !== false });
          if (result.exists !== false) host.toast('文件已存在，已读取原内容。');
        }
        activate(w, relative); dialog.close();
      });
      const form = element('form'); form.append(element('h3', '', '新建文件'), filename, append(element('div', 'row'), button('取消', () => dialog.close(), 'ghost'), button('打开编辑', create, 'primary', 'create-file-buffer')));
      form.addEventListener('submit', event => { event.preventDefault(); create(); }); dialog.append(form); document.body.append(dialog);
      dialog.addEventListener('close', () => dialog.remove()); dialog.showModal(); filename.focus();
    }, 'ghost', 'new-file'), button('↻', () => host.run(() => directory(w, '')), 'ghost', 'refresh-files')), search,
    button('搜索内容', () => host.run(async () => {
      const result = await host.request('GET', `/v1/file-search?taskId=${encodeURIComponent(task.id)}&q=${encodeURIComponent(search.value)}`);
      searchResults.replaceChildren();
      searchResults.append(element('p', 'editor-empty-hint', `${result.matches.length} 条结果${result.truncated ? ' · 已达搜索上限' : ''}`));
      for (const hit of result.matches) searchResults.append(button(`${hit.path}:${hit.line}  ${hit.text}`, () => host.run(async () => { await open(w, hit.path); const line = w.view!.state.doc.line(Math.min(hit.line, w.view!.state.doc.lines)); w.view!.dispatch({ selection: { anchor: line.from }, scrollIntoView: true }); }), 'ghost editor-search-hit'));
    }), 'ghost small', 'search-files'), searchResults, tree);
    search.addEventListener('input', () => { w.search = search.value; paintTree(w); });
    center.append(append(element('div', 'editor-toolbar'), element('span', 'editor-workspace-path', task.workspace), button('保存', () => host.run(() => save(w)), 'primary small', 'save-file'), button('重新读取', () => {
      const tab = w.tabs.get(w.active); if (!tab) return;
      const reload = () => host.run(() => open(w, tab.path, true));
      if (hasUnwrittenChanges(tab)) host.showConfirm('重新读取文件', '重新读取将丢弃本地编辑草稿，已提交的后台写入申请仍保留，不会撤回审批。', '重新读取', reload); else reload();
    }, 'ghost small', 'reload-file')), tabbar, canvas, footer);
    const term = element('section', 'editor-terminal');
    term.append(append(element('div', 'editor-toolbar'), element('strong', '', '终端 / 工具输出'), button('清空显示', () => { output.textContent = ''; }, 'ghost small')));
    const form = element('form', 'editor-terminal-form');
    const execute = () => host.run(async () => {
      const command = terminal.value.trim(); if (!command) return;
      const parameters = terminalMode.value === 'powershell' ? { shell: 'powershell', command, timeoutMs: 120000 } : terminalMode.value === 'argv' ? { args: JSON.parse(command) } : { command };
      const result = await host.proposeTool('/v1/terminal', { taskId: task.id, ...parameters }); output.textContent += `\n> ${command}\n${pretty(result)}\n`;
      if (terminal.value.trim() === command) terminal.value = ''; if (visible === w) host.showApprovals(); else host.toast(`${w.task.title} 的终端审批已保留在原任务。`);
    });
    form.append(terminalMode, terminal, button('申请执行', execute, 'small', 'run-terminal')); form.addEventListener('submit', event => { event.preventDefault(); execute(); });
    term.append(output, form, element('p', 'terminal-approval-note', '每次执行均需批准，将在当前任务工作区运行。PowerShell 单次上限 120 秒。')); center.append(term); node.append(explorer, center); paintCanvas(w); host.run(() => directory(w, '')); return w;
  }
  return {
    render(container: HTMLElement, task?: Task) {
      if (!task) {
        visible = undefined;
        const node = element('div', 'editor-workbench');
        const explorer = append(element('aside', 'editor-explorer'), append(element('div', 'editor-toolbar'), element('strong', '', '文件')), element('p', 'editor-empty-hint', '尚未打开工作区'), button('选择项目目录', host.chooseWorkspace, 'ghost small'));
        const center = element('div', 'editor-center');
        center.append(append(element('div', 'editor-tabs'), element('span', 'editor-empty-hint', '欢迎')), append(element('div', 'editor-canvas'), append(element('div', 'editor-empty'), element('h2', '', '打开工作区'), element('p', '', '选择现有项目或创建任务，使用文件、代码编辑器和集成 Agent。'), button('选择工作区', host.chooseWorkspace, 'primary', 'editor-open-workspace'))), append(element('section', 'editor-terminal'), append(element('div', 'editor-toolbar'), element('strong', '', '终端 / 工具输出')), element('p', 'editor-empty-hint', '打开工作区后，可提交命令并查看真实执行结果。')));
        node.append(explorer, center); container.append(node); return;
      }
      const w = workbenches.get(task.id) ?? make(task); workbenches.set(task.id, w); w.task = task; visible = w;
      container.append(w.node); w.view?.requestMeasure();
    },
    sync(task?: Task, intents: Intent[] = []) {
      if (!task) return; const w = workbenches.get(task.id); if (!w) return; w.task = task;
      let saved = false;
      for (const tab of w.tabs.values()) {
        const operation = tab.pending && intents.find(intent => intent.toolCallId === tab.pending!.toolCallId);
        if (operation?.state === 'applied' && tab.pending) { tab.saved = tab.pending.content; tab.exists = true; tab.pending = undefined; saved = true; }
        else if (tab.pending && (operation?.state === 'denied' || ['failed', 'cancelled'].includes(task.status))) { tab.pending = undefined; tabs(w); }
      }
      if (saved) { tabs(w); host.run(() => directory(w, '')); }
      const receipts = intents.filter(intent => intent.receipt).slice(-20).map(intent => `${intent.name} · ${intent.state}${intent.receipt?.exitCode !== undefined ? ` · exit ${intent.receipt.exitCode}` : ''}\n${String(intent.receipt?.output ?? pretty(intent.receipt))}`);
      if (receipts.length) w.output.textContent = receipts.join('\n\n').slice(-64000);
    },
    canSwitchTask(_nextTaskId: string, _continueSwitch: () => void) { remember(visible!); return true; },
    hasUnsavedChanges(): boolean {
      for (const w of workbenches.values()) {
        remember(w);
        if ([...w.tabs.values()].some(hasUnwrittenChanges)) return true;
      }
      return false;
    },
  };
}
