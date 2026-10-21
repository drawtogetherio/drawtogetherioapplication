// Doodlehive desktop: a window on doodlehive.net with canvases kept as files on this computer.
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const { CanvasStore } = require('./store.cjs');

const APP_URL = process.env.DOODLEHIVE_URL || 'https://doodlehive.net/app';
const origin = new URL(APP_URL).origin;
// Discord login happens inside the window; everything else opens in the browser.
const inWindow = (url) => { try { const u = new URL(url); return u.origin === origin || /(^|\.)discord\.com$/.test(u.hostname); } catch { return false; } };

const store = new CanvasStore(path.join(app.getPath('userData'), 'canvases'));
for (const name of ['list', 'get', 'put', 'loadOps', 'appendOps', 'replaceOps', 'delete']) {
  ipcMain.handle('canvases:' + name, (e, ...args) => {
    if (new URL(e.senderFrame.url).origin !== origin) throw new Error('not allowed');
    return store[name](...args);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 720, minHeight: 480,
    backgroundColor: '#1b1b1f', title: 'Doodlehive', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!inWindow(url)) { e.preventDefault(); shell.openExternal(url); } });
  win.loadURL(APP_URL);
  return win;
}

app.whenReady().then(() => {
  process.env.DOODLEHIVE_VERSION = app.getVersion();
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  if (app.isPackaged) {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 6 * 60 * 60 * 1000);
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
