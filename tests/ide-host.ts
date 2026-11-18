import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BackendClient } from '../src/extensions/client.js';
import { assertLocalPath } from '../src/app/local-paths.js';

/** Runs inside the actual Code - OSS extension host, not a vscode mock. */
export async function run() {
  const root = process.env.NPN_IDE_TEST_ROOT!, workspace = path.join(root, 'workspace'), dataDir = process.env.NPN_IDE_DATA_DIR!;
  assertLocalPath(root, 'IDE test root');
  // Direct verification reads use BackendClient's default budget (15s), not a test-only 2s cap.
  // Commands still exercise the installed IDE extension's own client and its 5s timeout.
  const client = new BackendClient({ dataDir });
  const checks: { name: string; passed: boolean; error?: string }[] = [];
  const report = path.join(root, 'native-results.json');
  const save = () => writeFileSync(report, JSON.stringify({ hostVersion: vscode.version, hostName: vscode.env.appName, checks, fixture: root }, null, 2));
  const check = async (name: string, action: () => Promise<void>) => {
    console.log(`IDE_CHECK ${name}`);
    try { await action(); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: String(error) }); throw error; }
    finally { save(); }
  };
  async function until<T>(read: () => PromiseLike<T>, ready: (value: T) => boolean, label: string, timeout = 30000): Promise<T> {
    const deadline = Date.now() + timeout;
    do { const value = await read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
    throw new Error(`Native IDE timeout: ${label}`);
  }
  const mainUri = vscode.Uri.file(path.join(workspace, 'main.ts'));
  let terminal: vscode.Terminal | undefined;
  try {
    await check('actual extension activation and independent empty workspace', async () => {
      const extension = vscode.extensions.getExtension('npn-gamma.npn-ide');
      assert.ok(extension, 'Our real extension must be installed in the host.');
      assert.ok(path.resolve(extension.extensionPath).toLowerCase().startsWith(path.join(dataDir, 'ide', 'extensions').toLowerCase()), 'NPN must be loaded as the installed production extension, not the theme-preview development extension.');
      const api = await extension.activate();
      assert.equal(api.savesIntercepted, false);
      assert.deepEqual(await vscode.commands.executeCommand('npn.refresh'), []);
      assert.equal((await client.tasks(workspace)).length, 0);
    });
    await check('native edit/save and CRLF do not create tasks or consume model calls', async () => {
      const uri = vscode.Uri.file(path.join(workspace, 'notes.txt'));
      const document = await vscode.workspace.openTextDocument(uri), editor = await vscode.window.showTextDocument(document);
      assert.equal(document.eol, vscode.EndOfLine.CRLF);
      assert.ok(await editor.edit(edit => edit.insert(new vscode.Position(1, 0), '原生编辑 · native save\r\n')));
      assert.equal(document.isDirty, true);
      assert.equal(await document.save(), true);
      assert.equal(readFileSync(uri.fsPath, 'utf8'), 'first\r\n原生编辑 · native save\r\nsecond\r\n');
      assert.equal((await client.tasks(workspace)).length, 0);
    });
    await check('multiple native documents retain undo/redo and independent buffers', async () => {
      const main = await vscode.workspace.openTextDocument(mainUri);
      const editor = await vscode.window.showTextDocument(main, { viewColumn: vscode.ViewColumn.One, preview: false });
      const original = main.getText();
      await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '// native undo marker\n'));
      await vscode.commands.executeCommand('undo'); assert.equal(main.getText(), original);
      await vscode.commands.executeCommand('redo'); assert.match(main.getText(), /native undo marker/);
      await main.save();
      const other = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, 'math.ts')));
      await vscode.window.showTextDocument(other, { viewColumn: vscode.ViewColumn.Beside, preview: false });
      assert.ok(vscode.window.visibleTextEditors.length >= 2);
      assert.match(main.getText(), /native undo marker/);
      assert.equal((await client.tasks(workspace)).length, 0);
    });
    await check('real TypeScript definition, diagnostics and formatting providers', async () => {
      const main = await vscode.workspace.openTextDocument(mainUri);
      await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
      const position = main.positionAt(main.getText().indexOf('add(2'));
      const definitions = await until(() => vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', mainUri, position), value => !!value?.length, 'definition provider');
      assert.ok(definitions.some(item => ('uri' in item ? item.uri : item.targetUri).fsPath.endsWith('math.ts')));
      await until(async () => vscode.languages.getDiagnostics(mainUri), diagnostics => diagnostics.some(item => item.code === 2322), 'TypeScript diagnostic 2322');
      const math = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, 'math.ts')));
      const edits = await until(() => vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', math.uri, { tabSize: 2, insertSpaces: true }), value => !!value?.length, 'TypeScript formatter');
      const change = new vscode.WorkspaceEdit(); change.set(math.uri, edits); assert.ok(await vscode.workspace.applyEdit(change)); assert.ok(await math.save());
    });
    await check('native file discovery and dirty buffer protection against external edits', async () => {
      assert.equal((await vscode.workspace.findFiles('**/*.ts', '**/node_modules/**')).length, 2);
      const uri = vscode.Uri.file(path.join(workspace, 'conflict.txt'));
      const doc = await vscode.workspace.openTextDocument(uri), editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'UNSAVED_BUFFER\n'));
      writeFileSync(uri.fsPath, 'EXTERNAL_DISK_CHANGE\n');
      await new Promise(resolve => setTimeout(resolve, 700));
      assert.match(doc.getText(), /UNSAVED_BUFFER/); assert.equal(doc.isDirty, true);
      assert.equal(readFileSync(uri.fsPath, 'utf8'), 'EXTERNAL_DISK_CHANGE\n');
      await vscode.commands.executeCommand('npn.compareSaved');
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    });
    await check('actual native PTY terminal accepts interactive stdin in the project', async () => {
      await vscode.commands.executeCommand('npn.openTerminal');
      terminal = vscode.window.terminals.find(item => item.name === 'NPN Project'); assert.ok(terminal);
      assert.ok(await terminal.processId);
      await new Promise(resolve => setTimeout(resolve, 1800));
      const receipt = path.join(workspace, 'pty-receipt.txt').replaceAll("'", "''");
      terminal.sendText(`$answer = Read-Host 'NPN interactive input'; [IO.File]::WriteAllText('${receipt}', $answer); Write-Output ('PTY_RECEIPT:' + $answer)`);
      await new Promise(resolve => setTimeout(resolve, 700));
      terminal.sendText('native-input-42');
      await until(async () => existsSync(receipt), Boolean, 'PTY input receipt', 20000);
      assert.equal(readFileSync(receipt, 'utf8'), 'native-input-42');
      assert.equal((await client.tasks(workspace)).length, 0);
    });
    await check('extension explicit task creation/controls/trace share the real backend', async () => {
      const ack = await vscode.commands.executeCommand<{ taskId: string }>('npn.createTask', { objective: 'Write native-task-result.txt after exact approval', workspace });
      assert.ok(ack?.taskId);
      await until(() => client.taskView(ack.taskId), snapshot => snapshot.selectedTask?.status === 'waiting_approval', 'actual tool approval');
      await vscode.commands.executeCommand('npn.refresh');
      await vscode.commands.executeCommand('npn.pause', ack.taskId);
      assert.equal((await client.taskView(ack.taskId)).selectedTask!.status, 'paused');
      await vscode.commands.executeCommand('npn.resume', ack.taskId);
      await until(() => client.taskView(ack.taskId), snapshot => snapshot.selectedTask?.status === 'waiting_approval', 'resumed approval');
      await vscode.commands.executeCommand('npn.refresh');
      await vscode.commands.executeCommand('npn.pause', ack.taskId);
      assert.equal((await client.taskView(ack.taskId)).selectedTask!.status, 'paused');
      assert.equal(existsSync(path.join(workspace, 'native-task-result.txt')), false, 'No unapproved Agent write may occur.');
      const trace = await vscode.commands.executeCommand<{ uri: string }>('npn.openTrace', ack.taskId);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(trace!.uri));
      assert.match(document.getText(), /task\.paused/);
      assert.equal((await client.taskView(ack.taskId)).messages.some(message => message.role === 'user' && message.content === 'continue'), false);
    });
    await check('NPN Agent webview drives shared Chat, goal, Diff and real approval', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('npn.openWorkbench');
      writeFileSync(path.join(root, 'deep-ready.json'), JSON.stringify({ ready: true, configuredTheme: vscode.workspace.getConfiguration('workbench').get('colorTheme'), activeThemeKind: vscode.window.activeColorTheme.kind }));
      await until(async () => existsSync(path.join(root, 'deep-done.json')), Boolean, 'Agent webview acceptance', 150000);
      const browser = JSON.parse(readFileSync(path.join(root, 'deep-done.json'), 'utf8')); assert.equal(browser.passed, true);
      const frame = await client.agentView(workspace, {});
      assert.equal(frame.chats.length, 1);
      const conversation = await client.agentView(workspace, { chatId: frame.chats[0]!.id });
      assert.ok(conversation.messages.some(message => message.content.includes('IDE_DEEP_CHAT_MARKER')));
      const actual = await client.requestRecord(conversation.request!.id);
      assert.ok(actual.body!.messages.some((message: any) => String(message.content).includes('main.ts:1')));
      const task = frame.tasks.find(task => task.goal.objective.includes('IDE_DEEP_WORK_MARKER'))!;
      assert.equal(task.status, 'completed'); assert.deepEqual(task.goal.acceptance, ['file:ide-ui-approved.txt']);
      const workView = await client.agentView(workspace, { taskId: task.id });
      assert.deepEqual(workView.tools.map(tool => [tool.name, tool.status]).sort(), [['read_file', 'completed'], ['write_file', 'completed']]);
      const read = workView.tools.find(tool => tool.name === 'read_file')!;
      const write = workView.tools.find(tool => tool.name === 'write_file')!;
      for (const tool of [read, write]) {
        assert.equal(tool.taskId, task.id); assert.ok(tool.intentId);
      }
      assert.notEqual(read.intentId, write.intentId);
      assert.equal((write.arguments.readVersion as { sourceIntentId: string }).sourceIntentId, read.intentId);
      assert.equal(workView.metrics!.toolsCompleted, 2);
      const inspected = vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'npn-preview' && document.uri.path.endsWith('/inspection.json'))
        .map(document => JSON.parse(document.getText())).find(record => record.id === workView.request!.id);
      assert.ok(inspected, 'The actual native document must contain the selected retained request, not just a tab label.');
      assert.equal(inspected.bodyHash, (await client.requestRecord(workView.request!.id)).bodyHash);
      assert.match(readFileSync(path.join(workspace, 'ide-ui-approved.txt'), 'utf8'), /NPN-Gamma mock output/);
    });
    await check('native workbench screenshot handoff', async () => {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mainUri), vscode.ViewColumn.One);
      await vscode.commands.executeCommand('workbench.view.extension.npn');
      terminal?.show(true);
      writeFileSync(path.join(root, 'capture-ready.json'), JSON.stringify({ ready: true }));
      await until(async () => existsSync(path.join(root, 'capture-done')), Boolean, 'native screenshot', 60000);
    });
    await check('offline backend does not disable native editing or saving', async () => {
      const discovery = JSON.parse(readFileSync(path.join(dataDir, 'backend.json'), 'utf8'));
      await fetch(`http://127.0.0.1:${discovery.port}/v1/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${discovery.token}` } });
      await until(async () => { try { await client.health(); return false; } catch { return true; } }, Boolean, 'backend shutdown');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, 'offline.txt')));
      const editor = await vscode.window.showTextDocument(document);
      await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'OFFLINE_NATIVE_SAVE\n'));
      assert.ok(await document.save()); assert.match(readFileSync(document.uri.fsPath, 'utf8'), /OFFLINE_NATIVE_SAVE/);
      assert.equal(vscode.extensions.getExtension('npn-gamma.npn-ide')!.isActive, true);
    });
  } finally { terminal?.dispose(); save(); }
}
