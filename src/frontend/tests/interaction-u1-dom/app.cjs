const { app, BrowserWindow } = require('electron');
if (!process.env.NPN_U1_USER || !process.env.NPN_U1_PAGE) throw new Error('Isolated U1 paths required');
app.setPath('userData', process.env.NPN_U1_USER);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 850, show: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(process.env.NPN_U1_PAGE);
});
app.on('window-all-closed', () => app.quit());
