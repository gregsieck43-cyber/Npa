const { app, BrowserWindow } = require('electron');
for (const name of ['NPN_LAYOUT_USER', 'NPN_LAYOUT_PAGE']) if (!process.env[name]) throw new Error(`${name} required`);
app.setPath('userData', process.env.NPN_LAYOUT_USER);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(process.env.NPN_LAYOUT_PAGE);
});
app.on('window-all-closed', () => app.quit());
