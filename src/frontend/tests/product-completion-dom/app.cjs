const { app, BrowserWindow } = require('electron');
if (!process.env.NPN_UI_TEST_ROOT || !process.env.NPN_UI_TEST_PAGE) throw new Error('Test paths required');
app.setPath('userData', process.env.NPN_UI_TEST_ROOT);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 900, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await win.loadFile(process.env.NPN_UI_TEST_PAGE);
});
app.on('window-all-closed', () => app.quit());
