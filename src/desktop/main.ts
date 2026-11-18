import { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, type IpcMainInvokeEvent } from 'electron';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertLocalPath } from '../app/local-paths.js';
import { initializeDataDirectory } from '../app/data-directory.js';
import { ensureLocalBackend } from '../app/launch-backend.js';
import { attachResourceBudget } from '../app/resource-budget.js';
import { ideAssets, launchIde } from '../ide/launcher.js';
import { createRequestHandler, describePickedFiles, frameTrust, requireTrustedSender, type FrameIdentity, type FrameTrust } from './ipc-policy.js';
import { BackendGateway } from './backend-connection.js';
import { PROVIDER_IMPORT_MAX_BYTES } from './provider-connection.js';
import { formatProviderImportCompletion, formatProviderImportConfirmation, performProviderImport } from './provider-import.js';
const argument = (name: string) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
};
const packageRoot = app.isPackaged ? path.dirname(process.execPath) : process.cwd();
const appRoot = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(packageRoot, 'build');
const packageMetadata = app.isPackaged ? JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')) : { workspaceBoundary: packageRoot, productRoot: packageRoot, version: JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version };
const workspaceBoundary = path.resolve(packageMetadata.workspaceBoundary ?? packageRoot);
const dataDir = path.resolve(argument('--data-dir') ?? path.join(packageRoot, 'data'));
assertLocalPath(dataDir, 'Data directory'); assertLocalPath(workspaceBoundary, 'Workspace boundary');
const dataRelative = path.relative(packageRoot, dataDir);
if (dataRelative.startsWith('..') || path.isAbsolute(dataRelative))
    throw new Error('Data directory must be inside the product project folder.');
const dataDirectoryAccess = initializeDataDirectory(dataDir);
const cacheDir = path.join(dataDir, 'desktop-cache');
for (const directory of [dataDir, cacheDir, path.join(dataDir, 'tmp'), path.join(dataDir, 'logs'), path.join(dataDir, 'crash')])
    mkdirSync(directory, { recursive: true });
process.env.TEMP = path.join(dataDir, 'tmp');
process.env.TMP = process.env.TEMP;
app.setPath('appData', cacheDir);
app.setPath('userData', cacheDir);
app.setPath('sessionData', cacheDir);
app.setPath('temp', process.env.TEMP);
app.setPath('logs', path.join(dataDir, 'logs'));
app.setPath('crashDumps', path.join(dataDir, 'crash'));
app.setAppUserModelId('NPN.Gamma.CodeAgent');
// Let Chromium select GPU compositing; forcing software rasterization stalls the whole
// window on the shared blurred surfaces. --disable-gpu remains available for driver faults.
app.commandLine.appendSwitch('disk-cache-dir', path.join(cacheDir, 'disk'));
const gateway = new BackendGateway({ dataDir, launch: () => launchBackend() });
/** The window this shell created; undefined until it is ready and after it closes. */
let appWindow: BrowserWindow | undefined;
/**
 * The facts the IPC guard needs, read defensively: every Electron accessor here can throw once a
 * frame or window is torn down, and a torn-down caller must be refused rather than crash the shell.
 */
function senderIdentity(event: IpcMainInvokeEvent): FrameIdentity {
    let senderContentsId = -1, senderFrameId: number | undefined;
    try { senderContentsId = event.sender.id; } catch { /* the renderer process is already gone */ }
    try { senderFrameId = event.senderFrame?.frameTreeNodeId; } catch { senderFrameId = undefined; }
    const window = appWindow;
    let windowContentsId: number | undefined, mainFrameId: number | undefined;
    try {
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
            windowContentsId = window.webContents.id;
            mainFrameId = window.webContents.mainFrame.frameTreeNodeId;
        }
    } catch { /* the window is being torn down */ }
    return { windowContentsId, senderContentsId, senderFrameId, mainFrameId };
}
function senderTrust(event: IpcMainInvokeEvent): FrameTrust { return frameTrust(senderIdentity(event)); }
let stopBackendOnClose = false;
function launchBackend() {
    const runtime = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'node.exe') : process.env.NPN_NODE_EXE ?? path.join(packageRoot, '.deps', 'runtime', 'node.exe');
    return ensureLocalBackend({ dataDir, dataDirectoryAccess, projectRoot: workspaceBoundary, productRoot: packageMetadata.productRoot ?? packageRoot, cwd: packageRoot, runtime, entry: path.join(appRoot, 'src', 'entry.js') });
}
async function ensureBackend() {
    await gateway.ensure();
}
function request(method: string, route: string, body?: unknown, timeoutMs = 65000): Promise<Record<string, any>> {
    // The backend returns real JSON: lists (models, activity, projects) must stay arrays, so the
    // generic parameter only shapes this native helper's own object reads.
    return gateway.request<Record<string, any>>(method, route, body, timeoutMs);
}
async function pickWorkspace(): Promise<string | undefined> {
    const picked = await dialog.showOpenDialog({ title: '选择项目文件夹（仅授权选中的项目）', defaultPath: workspaceBoundary, properties: ['openDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return;
    await ensureBackend();
    const workspace = await request('POST', '/v1/workspaces/open', { path: picked.filePaths[0] });
    if (workspace.httpStatus >= 400 || workspace.error) throw new Error(workspace.error ?? 'Project authorization was rejected.');
    return workspace.path;
}
async function importProviderProfile() {
    const window = appWindow;
    if (!window || window.isDestroyed()) return { status: 'cancelled' };
    const picked = await dialog.showOpenDialog(window, {
        title: '导入模型配置',
        defaultPath: packageRoot,
        properties: ['openFile'],
        filters: [{ name: 'JSON 配置', extensions: ['json'] }],
    });
    const filename = picked.filePaths[0];
    if (picked.canceled || !filename) return { status: 'cancelled' };
    assertLocalPath(filename, 'Model provider import file');
    const information = statSync(filename);
    if (!information.isFile() || information.size > PROVIDER_IMPORT_MAX_BYTES)
        throw new Error('Provider import file must be a regular JSON file of at most ' + PROVIDER_IMPORT_MAX_BYTES + ' bytes.');
    const text = readFileSync(filename, 'utf8');
    const outcome = await performProviderImport({
        text,
        confirm: async settings => {
            const confirmation = formatProviderImportConfirmation(settings);
            const choice = await dialog.showMessageBox(window, {
                type: 'question', title: confirmation.message, message: confirmation.message, detail: confirmation.detail,
                buttons: ['取消', '导入'], defaultId: 0, cancelId: 0, noLink: true,
            });
            return choice.response === 1;
        },
        save: async body => {
            await ensureBackend();
            const saved = await request('POST', '/v1/harness/profiles', body);
            if (saved.httpStatus >= 400 || saved.error)
                throw new Error(String(saved.error ?? 'The backend rejected the model configuration (HTTP ' + saved.httpStatus + ').'));
            return saved;
        },
    });
    if (outcome.status === 'cancelled') {
        await dialog.showMessageBox(window, { type: 'info', title: '已取消导入', message: '没有修改任何模型配置。', buttons: ['好'], noLink: true });
        return outcome;
    }
    const id = (outcome.profile as { id?: unknown } | undefined)?.id;
    const completion = formatProviderImportCompletion(typeof id === 'string' ? id : undefined);
    await dialog.showMessageBox(window, {
        type: 'info', title: completion.message, message: completion.message, detail: completion.detail,
        buttons: ['好'], noLink: true,
    });
    return outcome;
}
function createWindow() {
    const window = new BrowserWindow({ width: 1440, height: 960, minWidth: 800, minHeight: 600, backgroundColor: '#faf9f6', title: `NPN-Gamma Code Agent ${packageMetadata.version}`, icon: path.join(appRoot, 'assets', 'brand', 'app.ico'), webPreferences: { preload: path.join(appRoot, 'desktop', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    appWindow = window;
    window.on('closed', () => { if (appWindow === window) appWindow = undefined; });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-prevent-unload', event => {
        const choice = dialog.showMessageBoxSync(window, {
            type: 'warning', title: '关闭前检查草稿', message: '仍有未保存或未提交的草稿。',
            detail: '尚未提交的聊天、目标、回答和验收说明只在当前窗口内。文件编辑需批准并实际写入后才算已保存。\n\n选择“继续编辑”返回窗口，或选择“丢弃草稿并关闭”丢弃本地草稿。已提交的任务、消息和后台审批仍保留；关闭不会撤回审批。\n\n' + (stopBackendOnClose ? '窗口关闭后才会停止后台；下次启动可恢复任务。' : '关闭窗口后后台继续运行。'),
            buttons: ['继续编辑', '丢弃草稿并关闭'], defaultId: 0, cancelId: 0, noLink: true,
        });
        if (choice === 1) event.preventDefault();
        else stopBackendOnClose = false;
    });
    void window.loadFile(path.join(appRoot, 'frontend', 'index.html'));
    return window;
}
function closeWindow(stopBackend: boolean) {
    stopBackendOnClose = stopBackend;
    const window = BrowserWindow.getAllWindows()[0];
    if (window) window.close();
    else app.quit();
}
if (!app.requestSingleInstanceLock())
    app.quit();
else {
    const resourceReady = attachResourceBudget(path.join(appRoot, 'native', 'resource-budget.exe'));
    ipcMain.handle('npn:request', createRequestHandler({ senderTrust, forward: (method, route, body) => request(method, route, body) }));
    ipcMain.handle('npn:desktop', async (event, action: string, payload?: unknown) => {
        requireTrustedSender(senderTrust(event));
        if (action === 'open-ide') {
            let workspace = typeof (payload as { workspace?: unknown })?.workspace === 'string' ? (payload as { workspace: string }).workspace : undefined;
            if (!workspace) {
                workspace = await pickWorkspace();
                if (!workspace) return { cancelled: true };
            }
            await ensureBackend();
            const validated = await request('GET', `/v1/ide/workspace?path=${encodeURIComponent(workspace)}`);
            if (validated.httpStatus >= 400 || validated.error) throw new Error(validated.error ?? 'IDE workspace was rejected.');
            return launchIde({ productRoot: packageRoot, dataDir, workspace: validated.path, workspaceBoundary: validated.path, inspectPort: argument('--ide-inspect-port') ? Number(argument('--ide-inspect-port')) : undefined, ...ideAssets(packageRoot, appRoot, app.isPackaged) });
        }
        if (action === 'select-workspace') return (await pickWorkspace()) ?? null;
        if (action === 'open-data')
            return shell.openPath(dataDir);
        if (action === 'select-file' || action === 'select-folder') {
            const result = await dialog.showOpenDialog({ defaultPath: packageRoot, properties: action === 'select-file' ? ['openFile'] : ['openDirectory'] });
            const selected = result.filePaths[0];
            if (selected) assertLocalPath(selected, 'Selected file or folder');
            return selected ?? null;
        }
        if (action === 'pick-files') {
            // The only place a file becomes an attachment: a native multi-select whose result is
            // described by ipc-policy before the renderer sees it. Cancelling attaches nothing.
            const picked = await dialog.showOpenDialog({ title: '选择要附加的文件（最多 5 个，文本或图片）', defaultPath: packageRoot, properties: ['openFile', 'multiSelections'] });
            return picked.canceled ? [] : describePickedFiles(picked.filePaths, { protectedRoots: [dataDir] });
        }
        if (action === 'quit-backend') {
            closeWindow(true);
            return true;
        }
        if (action === 'version')
            return { version: packageMetadata.version, dataDir, packageRoot, workspaceBoundary };
        if (action === 'copy-text') {
            const text = String((payload as { text?: string })?.text ?? '');
            if (text.length > 1048576) throw new Error('Clipboard text exceeds 1 MiB.');
            await clipboard.writeText(text);
            return { copied: true };
        }
        if (action === 'save-export') {
            const value = payload as { filename?: string; content?: string };
            if (typeof value.content !== 'string' || Buffer.byteLength(value.content) > 4_194_304) throw new Error('Export content must be text of at most 4 MiB.');
            const directory = path.join(dataDir, 'exports'); mkdirSync(directory, { recursive: true });
            const result = await dialog.showSaveDialog({ defaultPath: path.join(directory, path.basename(value.filename ?? 'npn-export.json')), filters: [{ name: 'JSON', extensions: ['json'] }] });
            if (result.canceled || !result.filePath) return null;
            assertLocalPath(result.filePath, 'Export file');
            if (/^(?:API\.txt|configuration\.json|backend\.json)$/i.test(path.basename(result.filePath))) throw new Error('Choose an export filename instead of a credential or runtime configuration file.');
            writeFileSync(result.filePath, value.content, 'utf8');
            return { path: result.filePath };
        }
        if (action === 'copy-source') {
            const url = new URL(String((payload as {
                url?: string;
            })?.url));
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
                throw new Error('Source must be a public web URL.');
            await clipboard.writeText(url.href);
            return { copied: true };
        }
        throw new Error('Unsupported desktop action.');
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'NPN-Gamma', submenu: [{ label: '数据与诊断目录', click: () => {
                        void shell.openPath(dataDir);
                    } }, { label: '导入模型配置…', click: () => {
                        void importProviderProfile().catch(error => {
                            dialog.showErrorBox('导入模型配置失败', error instanceof Error ? error.message : String(error));
                        });
                    } }, { label: '关闭窗口（后台继续）', role: 'close' }, { label: '退出并停止后台', click: () => {
                        closeWindow(true);
                    } }] }]));
    app.on('second-instance', () => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window) {
            if (window.isMinimized())
                window.restore();
            window.focus();
        }
    });
    void resourceReady.then(() => app.whenReady()).then(async () => {
        await ensureBackend();
        createWindow();
    }).catch(error => {
        console.error(error);
        dialog.showErrorBox('NPN-Gamma 启动失败', error instanceof Error ? error.message : String(error));
        app.quit();
    });
    app.on('window-all-closed', () => {
        if (!stopBackendOnClose) { app.quit(); return; }
        void gateway.shutdown(5000).then(result => {
            if (result.attempted && !result.stopped) throw new Error('停止请求没有成功完成。');
        }).catch(error => {
            dialog.showErrorBox('后台停止失败', `窗口已关闭，但后台可能仍在运行。${error instanceof Error ? error.message : String(error)}`);
        }).finally(() => app.quit());
    });
}
