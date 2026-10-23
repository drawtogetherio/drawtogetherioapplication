// Doodlehive desktop: a window on doodlehive.net with canvases kept as files on this computer.
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
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

// .hivecanvas and .hivelapse files opened from the system wait here until the page takes them.
const HIVE_FILE = /\.(hivecanvas|hivelapse)$/i;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
let pendingFiles = [];
function queueFiles(paths) {
  const add = paths.filter((p) => typeof p === 'string' && HIVE_FILE.test(p));
  if (!add.length) return;
  pendingFiles.push(...add);
  const win = BrowserWindow.getAllWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); win.webContents.send('files:open'); }
}
ipcMain.handle('files:take', async (e) => {
  if (new URL(e.senderFrame.url).origin !== origin) throw new Error('not allowed');
  const paths = pendingFiles;
  pendingFiles = [];
  const out = [];
  for (const p of paths) {
    try {
      const st = await fs.stat(p);
      if (st.isFile() && st.size <= MAX_FILE_BYTES) out.push({ name: path.basename(p), bytes: new Uint8Array(await fs.readFile(p)) });
    } catch { /* moved or unreadable */ }
  }
  return out;
});
app.on('open-file', (e, p) => { e.preventDefault(); queueFiles([p]); });
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', (e, argv) => {
  queueFiles(argv.slice(1));
  const win = BrowserWindow.getAllWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
queueFiles(process.argv.slice(1));

function createWindow() {
  const mac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 720, minHeight: 480,
    backgroundColor: '#1b1b1f', title: 'Doodlehive', show: false,
    // No system title bar: the page draws the window buttons on Windows; Mac keeps its traffic lights.
    frame: mac, titleBarStyle: mac ? 'hiddenInset' : 'default', trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!inWindow(url)) { e.preventDefault(); shell.openExternal(url); } });
  win.loadURL(APP_URL);
  return win;
}

const fromApp = (e) => new URL(e.senderFrame.url).origin === origin;
ipcMain.on('win:minimize', (e) => { if (fromApp(e)) BrowserWindow.fromWebContents(e.sender)?.minimize(); });
ipcMain.on('win:maximize', (e) => { const w = fromApp(e) && BrowserWindow.fromWebContents(e.sender); if (w) w.isMaximized() ? w.unmaximize() : w.maximize(); });
ipcMain.on('win:close', (e) => { if (fromApp(e)) BrowserWindow.fromWebContents(e.sender)?.close(); });

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
