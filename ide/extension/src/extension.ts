import * as vscode from 'vscode';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import type { GoalContract, Task } from '../../../src/contracts.js';
import { AgentWorkbench } from './agent.js';
import { BackendClient } from '../../../src/extensions/client.js';
import { IdeController, selectionObjective, type IdeControl } from '../../../src/ide/controller.js';
import { assertLocalPath } from '../../../src/app/local-paths.js';

class TaskTree implements vscode.TreeDataProvider<Task> {
  readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  tasks: Task[] = [];
  getChildren(): Task[] { return this.tasks; }
  getTreeItem(task: Task): vscode.TreeItem {
    const item = new vscode.TreeItem(task.title);
    item.id = task.id; item.description = task.status; item.contextValue = `npnTask:${task.status}`;
    item.tooltip = `${task.workspace}\n${task.goal.objective}\n${task.status} · revision ${task.revision}`;
    item.iconPath = new vscode.ThemeIcon(task.status === 'running' ? 'sync~spin' : task.status === 'completed' ? 'pass' : task.status === 'paused' ? 'debug-pause' : task.status === 'failed' ? 'error' : 'circle-outline');
    item.command = { command: 'npn.selectTask', title: 'Open in NPN Agent', arguments: [task.id] };
    return item;
  }
}

/** Stable VS Code contributions only. No model loop, database writer or save interception. */
export function activate(context: vscode.ExtensionContext) {
  const tree = new TaskTree(), log = vscode.window.createOutputChannel('NPN Gamma');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'npn.openAgent'; status.text = '$(plug) NPN'; status.tooltip = 'Connect the independent NPN backend. Native editing is always available.'; status.show();
  const view = vscode.window.createTreeView('npn.tasks', { treeDataProvider: tree, showCollapseAll: false });
  const documents = new Map<string, string>();
  let client: BackendClient, controller: IdeController, connectionDirectory = '', pendingRefresh: Promise<Task[]> | undefined;
  let workbench: AgentWorkbench | undefined;

  function connectClient() {
    connectionDirectory = vscode.workspace.getConfiguration('npn').get<string>('dataDirectory') || process.env.NPN_IDE_DATA_DIR || '';
    client = new BackendClient({ dataDir: connectionDirectory, timeoutMs: 5000 });
    controller = new IdeController(client);
    workbench?.reset();
    tree.tasks = []; tree.changes.fire();
  }
  function folders(): string[] {
    if (vscode.env.remoteName) throw new Error('This NPN release supports local Windows workspaces only, not SSH/WSL/containers.');
    return (vscode.workspace.workspaceFolders ?? []).map(folder => {
      if (folder.uri.scheme !== 'file') throw new Error('NPN tasks require a local file workspace.');
      return folder.uri.fsPath;
    });
  }
  async function refresh(): Promise<Task[]> {
    if (pendingRefresh) return pendingRefresh;
    const current = controller;
    const operation = (async () => {
      if (!connectionDirectory) throw new Error('Select the NPN data folder to connect. Editing does not require a backend.');
      assertLocalPath(connectionDirectory, 'IDE connection directory');
      await client.health();
      const tasks = await current.refresh(folders());
      if (current === controller) {
        tree.tasks = tasks; tree.changes.fire(); view.message = tasks.length ? undefined : 'No Agent tasks in the open workspace. Native editing is independent.';
        status.text = '$(check) NPN'; status.tooltip = `Connected · ${tasks.length} workspace tasks`;
      }
      return tasks;
    })();
    pendingRefresh = operation;
    try { return await operation; }
    catch (error) {
      if (current === controller) { tree.tasks = []; tree.changes.fire(); status.text = '$(debug-disconnect) NPN offline'; view.message = 'Backend offline. Files, search and editing remain available.'; }
      throw error;
    } finally { if (pendingRefresh === operation) pendingRefresh = undefined; }
  }
  async function workspaceFolder(explicit?: string): Promise<vscode.WorkspaceFolder> {
    const available = vscode.workspace.workspaceFolders ?? [];
    let chosen = explicit ? available.find(folder => path.resolve(folder.uri.fsPath).toLowerCase() === path.resolve(explicit).toLowerCase())
      : vscode.window.activeTextEditor ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri) : undefined;
    if (!chosen && !explicit && available.length === 1) chosen = available[0];
    if (!chosen && !explicit && available.length) chosen = (await vscode.window.showQuickPick(available.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { title: 'NPN task workspace' }))?.folder;
    if (!chosen || chosen.uri.scheme !== 'file') throw new Error('Open/select a local project folder first. No Agent task is required to open a project.');
    assertLocalPath(chosen.uri.fsPath, 'IDE workspace folder');
    return chosen;
  }
  async function taskId(value?: Task | string): Promise<string> {
    if (typeof value === 'string') return value;
    if (value?.id) return value.id;
    const chosen = await vscode.window.showQuickPick(tree.tasks.map(task => ({ label: task.title, description: task.status, task })), { title: 'NPN task' });
    if (!chosen) throw new Error('No task selected.');
    return chosen.task.id;
  }
  const register = (id: string, action: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
    try { return await action(...args); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); log.appendLine(`${id}: ${message}`); void vscode.window.showErrorMessage(`NPN: ${message}`); throw error; }
  }));

  register('npn.connect', async () => {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: 'Select the NPN data folder (backend.json)' });
    if (!picked?.[0]) return;
    assertLocalPath(picked[0].fsPath, 'IDE data folder');
    await vscode.workspace.getConfiguration('npn').update('dataDirectory', picked[0].fsPath, vscode.ConfigurationTarget.Global);
    connectClient(); return refresh();
  });
  register('npn.openProject', async () => {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: 'Open and authorize an NPN project on F:' });
    if (!picked?.[0]) return;
    const project = await client.openWorkspace(picked[0].fsPath);
    return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(project.path), false);
  });
  register('npn.authorizeProject', async () => {
    const folder = await workspaceFolder();
    if (await vscode.window.showWarningMessage(`Allow NPN to use this project?\n${folder.uri.fsPath}\nTool effects still require approval.`, { modal: true }, 'Allow project') !== 'Allow project') return;
    await client.openWorkspace(folder.uri.fsPath);
    await refresh(); workbench?.reset();
  });
  register('npn.refresh', refresh);
  register('npn.createTask', async (input?: { objective: string; workspace?: string; goal?: Partial<GoalContract> }) => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this project before explicitly starting an Agent task. Native editing is available in Restricted Mode.');
    const folder = await workspaceFolder(input?.workspace);
    const objective = input?.objective ?? await vscode.window.showInputBox({ title: 'Create and start NPN Work task', prompt: 'This explicitly starts an Agent task (20 model / 100 tool call limit). Tool effects retain backend approval.', validateInput: value => value.trim() ? undefined : 'Enter an objective.' });
    if (!objective) return;
    await refresh();
    const ack = await controller.createTask(folder.uri.fsPath, objective, input?.goal);
    // The mutation is confirmed even if a later status read fails; never invite a duplicate task.
    await refresh().catch(() => undefined);
    if (!input?.objective) void vscode.window.showInformationMessage(`NPN task accepted: ${ack.taskId}`);
    else log.appendLine(`Task accepted: ${ack.taskId}`);
    return ack;
  });
  register('npn.taskFromSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) throw new Error('Select project text first.');
    const folder = await workspaceFolder(), selected = editor.document.getText(editor.selection);
    const objective = await vscode.window.showInputBox({ title: 'Create NPN task from selection', prompt: 'What should the Agent do with the selected source?' });
    if (!objective) return;
    return vscode.commands.executeCommand('npn.createTask', { workspace: folder.uri.fsPath,
      objective: selectionObjective(objective, path.relative(folder.uri.fsPath, editor.document.uri.fsPath), selected, editor.selection.start.line + 1) });
  });
  for (const type of ['pause', 'resume', 'cancel', 'retry'] as IdeControl[]) register(`npn.${type}`, async (value?: Task | string) => {
    const id = await taskId(value);
    if (['resume', 'retry'].includes(type) && !vscode.workspace.isTrusted) throw new Error('Trust this project before resuming Agent execution.');
    if (type === 'cancel' && await vscode.window.showWarningMessage('Cancel this NPN task? Sent effects still require reconciliation.', { modal: true }, 'Cancel task') !== 'Cancel task') return;
    const result = await controller.control(id, type);
    await refresh().catch(() => undefined); return result;
  });
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('npn-task', { provideTextDocumentContent: uri => documents.get(uri.toString()) ?? 'Task view is no longer loaded. Reopen it from NPN.' }));
  async function inspect(value: Task | string | undefined, trace: boolean) {
    const id = await taskId(value);
    if (!tree.tasks.some(task => task.id === id)) throw new Error('Task is outside the open workspace.');
    const content = trace ? await client.events(id, { limit: 100 }) : await client.taskView(id);
    const uri = vscode.Uri.from({ scheme: 'npn-task', path: `/${id}/${trace ? 'trace' : 'snapshot'}.json`, query: String(Date.now()) });
    documents.set(uri.toString(), JSON.stringify(content, null, 2));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    return { taskId: id, uri: uri.toString() };
  }
  register('npn.openTask', (value?: Task | string) => inspect(value, false));
  register('npn.openTrace', (value?: Task | string) => inspect(value, true));
  register('npn.compareSaved', () => vscode.commands.executeCommand('workbench.files.action.compareWithSaved'));
  register('npn.openTerminal', async () => {
    const folder = await workspaceFolder();
    const root = path.join(connectionDirectory || context.globalStorageUri.fsPath, 'ide', 'terminal');
    assertLocalPath(root, 'IDE terminal directory');
    const env: Record<string, string | null> = {};
    const keep = new Set(['SystemRoot', 'WINDIR', 'PATH', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']);
    for (const key of Object.keys(process.env)) if (!keep.has(key)) env[key] = null;
    for (const [key, name] of Object.entries({ TEMP: 'tmp', TMP: 'tmp', HOME: 'home', USERPROFILE: 'home', APPDATA: 'roaming', LOCALAPPDATA: 'local', npm_config_cache: 'cache/npm', PIP_CACHE_DIR: 'cache/pip', UV_CACHE_DIR: 'cache/uv', CARGO_HOME: 'cache/cargo', PSModuleAnalysisCachePath: 'cache/powershell' })) {
      const directory = path.join(root, name);
      mkdirSync(key === 'PSModuleAnalysisCachePath' ? path.dirname(directory) : directory, { recursive: true }); env[key] = directory;
    }
    const terminal = vscode.window.createTerminal({ name: 'NPN Project', cwd: folder.uri, env,
      shellPath: path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), shellArgs: ['-NoLogo', '-NoProfile'] });
    terminal.show(); return terminal.name;
  });
  context.subscriptions.push(tree.changes, log, status, view,
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh().catch(() => undefined); }),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('npn.dataDirectory')) { connectClient(); void refresh().catch(() => undefined); } }),
    vscode.workspace.onDidCloseTextDocument(document => { if (document.uri.scheme === 'npn-task') documents.delete(document.uri.toString()); }));
  connectClient();
  workbench = new AgentWorkbench(context, { client: () => client, dataDirectory: () => connectionDirectory,
    createTask: async input => vscode.commands.executeCommand('npn.createTask', input),
    control: async (id, type) => { await refresh(); return vscode.commands.executeCommand(`npn.${type}`, id); },
    connect: async () => vscode.commands.executeCommand('npn.connect') });
  context.subscriptions.push(workbench);
  register('npn.openAgent', () => workbench!.show());
  register('npn.openWorkbench', () => workbench!.show(true));
  register('npn.selectTask', (id: string) => workbench!.selectTask(id));
  register('npn.addSelection', () => workbench!.addSelection());
  if (vscode.workspace.getConfiguration('npn').get('openWorkbenchOnStartup', true)) void workbench.show(true).catch(error => log.appendLine(`Workbench: ${String(error)}`));
  const timer = setInterval(() => { if (vscode.window.state.active) void refresh().catch(() => undefined); }, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void refresh().catch(() => undefined);
  return { host: 'native-vscode-api', savesIntercepted: false };
}
