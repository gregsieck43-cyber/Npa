import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('npn', {
    request: (method: string, path: string, body?: unknown) => ipcRenderer.invoke('npn:request', method, path, body),
    desktop: (action: string, payload?: unknown) => ipcRenderer.invoke('npn:desktop', action, payload),
});
