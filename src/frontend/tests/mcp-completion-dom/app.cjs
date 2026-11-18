const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const required = ['NPN_UI_TEST_ROOT', 'NPN_UI_TEST_PAGE', 'NPN_UI_BACKEND_PORT', 'NPN_UI_BACKEND_TOKEN'];
for (const name of required) if (!process.env[name]) throw new Error(`${name} is required`);
app.setPath('userData', process.env.NPN_UI_TEST_ROOT);
app.disableHardwareAcceleration();
global.testRequests = [];
ipcMain.handle('test-product-request', async (_event, method, route, body) => {
  if (!['GET', 'POST', 'DELETE'].includes(method) || !/^\/v1\/product\/[a-z0-9/?=&%_.-]+$/i.test(route)) throw new Error('Unexpected fixture route');
  const response = await fetch(`http://127.0.0.1:${process.env.NPN_UI_BACKEND_PORT}${route}`, {
    method, headers: { Authorization: `Bearer ${process.env.NPN_UI_BACKEND_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  global.testRequests.push({ method, route, body, status: response.status });
  return response.ok ? data : { ...data, httpStatus: response.status };
});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 900, show: false, webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
  } });
  await win.loadFile(process.env.NPN_UI_TEST_PAGE);
});
app.on('window-all-closed', () => app.quit());
