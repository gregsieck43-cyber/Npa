import * as vscode from 'vscode';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { BackendClient } from '../../../src/extensions/client.js';
import type { IdeAgentView } from '../../../src/ide/types.js';
import type { IdeControl } from '../../../src/ide/controller.js';
import { selectionObjective } from '../../../src/ide/controller.js';
import { resolveProjectPath } from '../../../src/tools/policy.js';
import { assertLocalPath } from '../../../src/app/local-paths.js';
import { agentHtml, homeHtml } from './panel-html.js';

export interface AgentWorkbenchHost {
  client(): BackendClient;
  dataDirectory(): string;
  createTask(input: Record<string, unknown>): Promise<unknown>;
  control(taskId: string, type: IdeControl): Promise<unknown>;
  connect(): Promise<unknown>;
}

/** NPN workflow UI; every task, model request and tool effect still belongs to the shared backend. */
export class AgentWorkbench implements vscode.Disposable, vscode.WebviewViewProvider {
  private panel?: vscode.WebviewView;
  private home?: vscode.WebviewPanel;
  private folder?: vscode.WorkspaceFolder;
  private mode: 'chat' | 'work' = 'chat';
  private taskId?: string;
  private chatId?: string;
  private data?: IdeAgentView;
  private sourceEditor?: vscode.TextEditor;
  private refreshing = false;
  private generation = 0;
  private changed(): void { this.generation++; this.data = undefined; }
  private readonly owner = randomUUID();
  private editorSequence = 0;
  private readonly virtual = new Map<string, string>();
  private readonly replies = new Map<string, Promise<unknown>>();
  private readonly resources: vscode.Disposable[] = [];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly context: vscode.ExtensionContext, private readonly host: AgentWorkbenchHost) {
    this.resources.push(vscode.window.registerWebviewViewProvider('npn.agentView', this, { webviewOptions: { retainContextWhenHidden: true } }));
    this.resources.push(vscode.workspace.registerTextDocumentContentProvider('npn-preview', { provideTextDocumentContent: uri => this.virtual.get(uri.toString()) ?? 'This inspection snapshot expired. Reopen it from NPN.' }));
    this.resources.push(vscode.workspace.onDidChangeTextDocument(() => { void this.reportEditors().catch(() => undefined); this.pushContext(); }),
      vscode.workspace.onDidSaveTextDocument(() => { void this.reportEditors().catch(() => undefined); }),
      vscode.window.onDidChangeTextEditorSelection(event => { if (event.textEditor.document.uri.scheme === 'file') this.sourceEditor = event.textEditor; this.pushContext(); }),
      vscode.window.onDidChangeActiveTextEditor(() => this.pushContext()),
      vscode.workspace.onDidCloseTextDocument(document => this.virtual.delete(document.uri.toString())));
    this.timer = setInterval(() => { void this.reportEditors().catch(() => undefined); if (this.panel?.visible) void this.refresh(); }, 1000);
  }
  dispose(): void {
    clearInterval(this.timer); this.home?.dispose(); this.resources.forEach(resource => resource.dispose());
    void this.host.client().editorState({ owner: this.owner, remove: true }).catch(() => undefined);
  }
  reset(): void { this.taskId = undefined; this.chatId = undefined; this.changed(); void this.refresh(); }
  private currentFolder(): vscode.WorkspaceFolder | undefined {
    return this.folder ?? vscode.workspace.workspaceFolders?.[0];
  }
  private editorContext() {
    const active = vscode.window.activeTextEditor;
    if (active?.document.uri.scheme === 'file') this.sourceEditor = active;
    const editor = this.sourceEditor, folder = this.currentFolder();
    if (!editor || editor.document.isClosed || !folder) return undefined;
    const relative = path.relative(folder.uri.fsPath, editor.document.uri.fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    return { path: relative.replaceAll('\\', '/'), dirty: editor.document.isDirty,
      line: editor.selection.start.line + 1, selectedChars: editor.document.getText(editor.selection).length };
  }
  private pushContext() { void this.panel?.webview.postMessage({ type: 'context', context: this.editorContext() }); }
  async show(welcome = false): Promise<void> {
    const folder = this.currentFolder(); this.folder = folder;
    if (welcome && !vscode.window.visibleTextEditors.length && !this.home) {
      this.home = vscode.window.createWebviewPanel('npn.home', 'NPN 工作台', vscode.ViewColumn.One, { enableCommandUris: ['npn.openAgent', 'npn.openProject'], localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
      const version = String(this.context.extension.packageJSON.version);
      this.home.webview.html = homeHtml(this.home.webview, this.context.extensionUri, folder?.name ?? '', version);
      this.home.onDidDispose(() => { this.home = undefined; });
    }
    await vscode.commands.executeCommand('npn.agentView.focus');
    this.panel?.show(true);
    if (welcome) { await vscode.commands.executeCommand('workbench.view.explorer'); await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'); }
    await this.refresh();
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.panel = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = agentHtml(view.webview, this.context.extensionUri);
    view.webview.onDidReceiveMessage(message => { void this.receive(message); });
    view.onDidDispose(() => { if (this.panel === view) this.panel = undefined; });
    view.onDidChangeVisibility(() => { if (view.visible) void this.refresh(); });
    void this.refresh();
  }
  async selectTask(id: string): Promise<void> {
    const snapshot = await this.host.client().taskView(id), task = snapshot.selectedTask;
    const folder = vscode.workspace.workspaceFolders?.find(folder => task && path.resolve(folder.uri.fsPath).toLowerCase() === path.resolve(task.workspace).toLowerCase());
    if (!task || !folder) throw new Error('Task is not attached to an open project.');
    this.folder = folder; this.mode = 'work'; this.taskId = id; this.changed();
    await this.show();
  }
  async addSelection(): Promise<void> {
    this.editorContext();
    const editor = this.sourceEditor, folder = this.currentFolder();
    if (!editor || editor.document.isClosed || !folder || editor.selection.isEmpty) throw new Error('先在真实项目文件中选择代码。');
    const text = selectionObjective('请参考以下选区', path.relative(folder.uri.fsPath, editor.document.uri.fsPath), editor.document.getText(editor.selection), editor.selection.start.line + 1);
    await this.show();
    void this.panel!.webview.postMessage({ type: 'attach', text });
  }
  private async reportEditors(): Promise<void> {
    if (!this.host.dataDirectory()) return;
    assertLocalPath(this.host.dataDirectory(), 'IDE data directory');
    const sequence = ++this.editorSequence;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') continue;
      const dirtyPaths = vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file' && document.isDirty)
        .map(document => path.relative(folder.uri.fsPath, document.uri.fsPath)).filter(relative => relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      await this.host.client().editorState({ owner: this.owner, workspace: folder.uri.fsPath, dirtyPaths, sequence });
    }
  }
  private async refresh(): Promise<void> {
    const panel = this.panel, generation = this.generation, mode = this.mode;
    if (!panel || this.refreshing) return;
    this.refreshing = true;
    try {
      const folder = this.currentFolder();
      if (!folder) throw new Error('先打开一个项目。编辑文件不需要创建 Agent 任务。');
      if (!this.host.dataDirectory()) throw new Error('请连接 NPN 后台，或从 NPN-IDE 启动器打开。');
      assertLocalPath(this.host.dataDirectory(), 'IDE data directory');
      await this.reportEditors();
      const data = await this.host.client().agentView(folder.uri.fsPath, mode === 'work' ? { taskId: this.taskId } : { chatId: this.chatId });
      if (generation !== this.generation || this.panel !== panel) return;
      this.data = data;
      void panel.webview.postMessage({ type: 'state', connected: true, mode, viewVersion: generation, data, context: this.editorContext(), trusted: vscode.workspace.isTrusted,
        logo: panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'npn-logo.png')).toString() });
    } catch (error) {
      if (generation !== this.generation || this.panel !== panel) return;
      void panel.webview.postMessage({ type: 'state', connected: false, mode, viewVersion: generation, data: this.data, context: this.editorContext(), trusted: vscode.workspace.isTrusted,
        error: error instanceof Error ? error.message : String(error) });
    } finally { this.refreshing = false; }
  }
  private async fresh(): Promise<IdeAgentView> {
    const folder = this.currentFolder();
    if (!folder) throw new Error('Open a project first.');
    if (!this.host.dataDirectory()) throw new Error('请先连接 NPN 后台数据目录。');
    assertLocalPath(this.host.dataDirectory(), 'IDE data directory');
    return this.host.client().agentView(folder.uri.fsPath, this.mode === 'work' ? { taskId: this.taskId } : { chatId: this.chatId });
  }
  private draftKey(): string { return `npn-drafts:${this.host.dataDirectory()}:${this.currentFolder()?.uri.fsPath ?? 'empty'}`; }
  private drafts(): Record<string, string> {
    const saved = this.context.workspaceState.get<Record<string, string>>(this.draftKey(), {});
    return Object.fromEntries(Object.entries(saved).filter(([key, value]) => /^(chat|work):[A-Za-z0-9-]{1,150}$/.test(key) && typeof value === 'string' && value.length <= 100000));
  }
  private async receive(message: Record<string, any>): Promise<void> {
    if (!message || typeof message.id !== 'string' || typeof message.op !== 'string' || JSON.stringify(message).length > 180000) return;
    const panel = this.panel;
    const operation = this.replies.get(message.id) ?? this.act(message);
    this.replies.set(message.id, operation);
    if (this.replies.size > 64) this.replies.delete(this.replies.keys().next().value!);
    try { const result = await operation; void panel?.webview.postMessage({ type: 'reply', id: message.id, ok: true, result }); }
    catch (error) { void panel?.webview.postMessage({ type: 'reply', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
    if (message.op !== 'draft') await this.refresh();
  }
  private async act(message: Record<string, any>): Promise<unknown> {
    const client = this.host.client(), folder = this.currentFolder();
    if (message.op === 'ready') return { ready: true, drafts: this.drafts() };
    if (message.op === 'refresh') return { ready: true };
    if (message.op === 'draft') {
      if (typeof message.key !== 'string' || !/^(chat|work):[A-Za-z0-9-]{1,150}$/.test(message.key) || typeof message.content !== 'string' || message.content.length > 100000) throw new Error('Invalid composer draft.');
      if (message.workspacePath && path.resolve(message.workspacePath).toLowerCase() !== path.resolve(folder?.uri.fsPath ?? '').toLowerCase()) throw new Error('Project changed; the original draft remains in its view.');
      const drafts = this.drafts();
      if (message.content) drafts[message.key] = message.content; else delete drafts[message.key];
      if (Object.keys(drafts).length > 64) throw new Error('未发送草稿超过64项，请先整理；当前文字仍在输入框中。');
      await this.context.workspaceState.update(this.draftKey(), drafts); return { saved: true };
    }
    if (message.op === 'connect') return this.host.connect();
    if (message.op === 'openProject') return vscode.commands.executeCommand('npn.openProject');
    if (message.op === 'addSelection') return this.addSelection();
    if (message.op === 'terminal') return vscode.commands.executeCommand('npn.openTerminal');
    if (message.op === 'copy') {
      if (typeof message.text !== 'string' || message.text.length > 100000) throw new Error('Copy text exceeds the allowed size.');
      await vscode.env.clipboard.writeText(message.text); return { copied: true };
    }
    if (message.op === 'theme') {
      const settings = vscode.workspace.getConfiguration('workbench');
      const theme = settings.get('colorTheme') === 'NPN Dark' ? 'NPN Warm' : 'NPN Dark';
      await settings.update('colorTheme', theme, vscode.ConfigurationTarget.Global); return { theme };
    }
    if (message.op === 'openDesktop') {
      const root = process.env.NPN_IDE_PRODUCT_ROOT, executable = root && path.join(root, 'NPN-Gamma.exe');
      if (!root || !executable || !existsSync(executable)) throw new Error('开发宿主中请直接打开 NPN 桌面；发行版提供同后台桌面入口。');
      const child = spawn(executable, ['--data-dir', this.host.dataDirectory()], { cwd: root, detached: true, windowsHide: false, stdio: 'ignore' }); child.unref(); return { opened: true };
    }
    if (message.op === 'mode') { this.mode = message.mode === 'work' ? 'work' : 'chat'; this.changed(); return { mode: this.mode }; }
    if (message.op === 'new') { if (this.mode === 'work') this.taskId = undefined; else this.chatId = undefined; this.changed(); return { selected: 'new' }; }
    if (!folder) throw new Error('请先打开项目。');
    const generation = this.generation, mode = this.mode;
    const frame = await this.fresh();
    if (generation !== this.generation || message.viewVersion !== generation || message.workspaceId !== frame.workspace.id) throw new Error('工作区或会话已切换，请在当前视图重新操作。');
    if (message.op === 'select') {
      if (this.mode === 'work') { if (!frame.tasks.some(task => task.id === message.value)) throw new Error('Task is outside this project.'); this.taskId = message.value; }
      else { if (!frame.chats.some(chat => chat.id === message.value)) throw new Error('Conversation is outside this project.'); this.chatId = message.value; }
      this.changed(); return { selected: message.value };
    }
    if (message.op === 'send') {
      if (typeof message.content !== 'string' || !message.content.trim() || message.content.length > 100000) throw new Error('请输入有效内容（不超过100000字符）。');
      if (mode === 'work') {
        if (!vscode.workspace.isTrusted) throw new Error('请先信任项目，再开始 Agent 执行。');
        if (!frame.task) {
          const ack = await this.host.createTask({ workspace: folder.uri.fsPath, objective: message.content, goal: message.goal }) as { taskId: string };
          if (generation === this.generation) { this.taskId = ack.taskId; this.changed(); } return ack;
        }
        return client.command({ commandId: `ide-${message.id}`, type: frame.task.status === 'waiting_input' ? 'answer' : 'send_message', taskId: frame.task.id,
          expectedRevision: frame.task.revision, parameters: { content: message.content } });
      }
      const enabled = message.tools === true;
      if (enabled && !vscode.workspace.isTrusted) throw new Error('请先信任项目，再启用 Agent 文件/终端工具。');
      let chatId = frame.chat?.id;
      if (!chatId) {
        const chat = await client.createChat({ title: message.content.split('\n')[0].slice(0, 60), workspace: folder.uri.fsPath, profileId: String(message.profileId ?? frame.profiles[0]?.id ?? 'default'), capabilities: { tools: enabled, projectInstructions: vscode.workspace.isTrusted, skills: vscode.workspace.isTrusted } });
        chatId = chat.id;
        if (generation === this.generation) { this.chatId = chat.id; this.changed(); }
      } else await client.updateChat(chatId, { profileId: String(message.profileId ?? frame.chat?.profileId ?? 'default'), capabilities: { ...frame.chat!.capabilities, tools: enabled } });
      return client.sendChat({ sessionId: chatId, content: message.content });
    }
    if (message.op === 'control') {
      if (this.mode === 'chat') { if (!frame.request?.id) throw new Error('没有正在生成的请求。'); return client.cancelRequest(frame.request.id); }
      if (!frame.task) throw new Error('没有选中的 Work 任务。');
      if (!['pause', 'resume', 'retry', 'cancel'].includes(message.control)) throw new Error('Unsupported task control.');
      return this.host.control(frame.task.id, message.control as IdeControl);
    }
    if (message.op === 'promote') {
      if (!frame.chat || !vscode.workspace.isTrusted) throw new Error('选择一个对话并信任当前项目后再转为 Work。');
      const answer = await vscode.window.showInformationMessage('将此对话及原始档案升级为长期 Work 任务？采用100次模型/500次工具有限额度，工具仍单独审批。', { modal: true }, '升级为 Work');
      if (!answer) return { cancelled: true };
      const result = await client.promoteChat(frame.chat.id, { workspace: folder.uri.fsPath });
      if (generation === this.generation) { this.taskId = result.taskId; this.mode = 'work'; this.changed(); } return result;
    }
    if (message.op === 'approve' || message.op === 'diff' || message.op === 'openArtifact') {
      const tool = frame.tools.find(tool => tool.id === message.toolId);
      if (!tool || !tool.digest || tool.digest !== message.digest) throw new Error('工具提议已变化，请重新查看当前内容和摘要。');
      const target = tool.name === 'write_file' ? await resolveProjectPath(folder.uri.fsPath, String(tool.arguments.path), true) : undefined;
      if (message.op === 'openArtifact') {
        if (!target) throw new Error('该工具没有工作区文件。');
        await vscode.window.showTextDocument(vscode.Uri.file(target), { viewColumn: vscode.ViewColumn.One, preview: false }); return { opened: true };
      }
      if (message.op === 'diff') {
        if (!target) throw new Error('该工具没有文件 Diff。');
        const before = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
        const left = this.document(`before-${tool.id}`, before, path.basename(target));
        const right = this.document(`proposal-${tool.id}`, String(tool.arguments.content), path.basename(target));
        await vscode.commands.executeCommand('vscode.diff', left, right, `NPN 提议 · ${path.basename(target)}`, { viewColumn: vscode.ViewColumn.One });
        return { opened: true };
      }
      if (!vscode.workspace.isTrusted) throw new Error('信任项目后才能批准执行。');
      if (message.approved === true) {
        await this.reportEditors();
        if (target && vscode.workspace.textDocuments.some(document => document.isDirty && path.resolve(document.uri.fsPath).toLowerCase() === target.toLowerCase())) throw new Error('该文件有未保存编辑。请先保存或撤销，Agent 不会覆盖你的缓冲。');
        if (['run_command', 'run_shell', 'mcp_call'].includes(tool.name) && vscode.workspace.textDocuments.some(document => {
          const relative = path.relative(folder.uri.fsPath, document.uri.fsPath);
          return document.uri.scheme === 'file' && document.isDirty && !relative.startsWith('..') && !path.isAbsolute(relative);
        })) throw new Error('工作区中有未保存编辑，请先保存或撤销后再批准命令/外部工具。');
        if (target && tool.taskId && tool.intentId) {
          const snapshot = await client.taskView(tool.taskId), intent = snapshot.intents.find(intent => intent.id === tool.intentId);
          const current = await readFile(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
          const hash = current ? createHash('sha256').update(current).digest('hex') : null;
          if (intent?.arguments.expectedSha256 !== hash) throw new Error('文件已在提议后改变。请拒绝旧提议，让 Agent 按新版本重新生成。');
        }
        // For a file proposal the digest-bound card button is the explicit confirmation; Diff and version checks precede dispatch.
        // Process/remote effects retain an additional native confirmation with their concrete parameters.
        if (!target) {
          const confirmation = await vscode.window.showWarningMessage(`批准 ${tool.name}？`, { modal: true, detail: `批准绑定当前具体参数和摘要 ${tool.digest}。\n${JSON.stringify(tool.arguments).slice(0, 1600)}${JSON.stringify(tool.arguments).length > 1600 ? '\n（弹窗仅预览前1600字符；完整参数请在工具/请求中核对。）' : ''}` }, '批准此操作');
          if (!confirmation) return { cancelled: true };
        }
      }
      if (message.approved === true && tool.fileConflicts?.conflicts.length && message.expectedConflictFingerprint !== tool.fileConflicts.fingerprint) throw new Error('文件认领冲突已变化，请刷新并重新核对审批卡。');
      return client.approveTool(tool.id, tool.digest, message.approved === true, typeof message.expectedConflictFingerprint === 'string' ? message.expectedConflictFingerprint : undefined);
    }
    if (message.op === 'inspect') {
      let value: unknown, title: string;
      if (message.kind === 'request') { if (!frame.request) throw new Error('尚无实际模型请求。'); value = await client.requestRecord(frame.request.id); title = 'NPN 实际请求与提示来源'; }
      else if (frame.task) { value = message.kind === 'trace' ? await client.events(frame.task.id, { limit: 100 }) : await client.taskView(frame.task.id); title = 'NPN 任务状态与轨迹'; }
      else { if (!frame.request) throw new Error('尚无请求轨迹。'); value = await client.requestRecord(frame.request.id); title = 'NPN 对话请求'; }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(this.document(title, JSON.stringify(value, null, 2), 'inspection.json')), { viewColumn: vscode.ViewColumn.One, preview: false });
      return { opened: true };
    }
    throw new Error('Unsupported NPN workbench operation.');
  }
  private document(id: string, value: string, filename: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: 'npn-preview', path: `/${encodeURIComponent(id)}/${filename}`, query: randomUUID() });
    this.virtual.set(uri.toString(), value);
    if (this.virtual.size > 128) this.virtual.delete(this.virtual.keys().next().value!);
    return uri;
  }
}
