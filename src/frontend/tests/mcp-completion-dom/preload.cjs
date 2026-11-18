const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('npn', {
  request: (method, route, body) => ipcRenderer.invoke('test-product-request', method, route, body),
  desktop: () => Promise.reject(new Error('Native actions are outside the MCP component fixture.')),
});
