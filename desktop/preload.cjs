// The only bridge between the page and the desktop app: a canvas store and the app's version.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke('canvases:' + name, ...args);

contextBridge.exposeInMainWorld('doodlehiveNative', {
  platform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
  version: process.env.DOODLEHIVE_VERSION ?? '',
  frameless: true,
  window: { minimize: () => ipcRenderer.send('win:minimize'), maximize: () => ipcRenderer.send('win:maximize'), close: () => ipcRenderer.send('win:close') },
  canvases: { list: call('list'), get: call('get'), put: call('put'), loadOps: call('loadOps'), appendOps: call('appendOps'), replaceOps: call('replaceOps'), delete: call('delete') },
});
