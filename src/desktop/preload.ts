import { contextBridge, ipcRenderer, webUtils } from 'electron';
contextBridge.exposeInMainWorld('npn', {
    droppedFiles: (files: File[]) => ipcRenderer.invoke('npn:drop', files.slice(0, 5).map(file => webUtils.getPathForFile(file))),
    request: (method: string, path: string, body?: unknown) => ipcRenderer.invoke('npn:request', method, path, body),
    desktop: (action: string, payload?: unknown) => ipcRenderer.invoke('npn:desktop', action, payload),
});
