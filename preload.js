const { contextBridge, ipcRenderer, webUtils } = require('electron');

let initialConfig = {};
try {
  const arg = process.argv.find((a) => a.startsWith('--t2cfg='));
  if (arg) initialConfig = JSON.parse(arg.slice(8));
} catch {}

contextBridge.exposeInMainWorld('api', {
  config: initialConfig,
  dev: process.argv.includes('--t2dev'),
  saveConfig: (patch) => ipcRenderer.send('app:saveConfig', patch),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  refreshFolder: (root) => ipcRenderer.invoke('folder:refresh', root),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  saveFile: (opts) => ipcRenderer.invoke('file:save', opts),
  exportHtml: (opts) => ipcRenderer.invoke('export:html', opts),
  exportPdf: (opts) => ipcRenderer.invoke('export:pdf', opts),
  printHtml: (opts) => ipcRenderer.invoke('print:html', opts),
  confirmDiscard: () => ipcRenderer.invoke('app:confirmDiscard'),
  setDirty: (d) => ipcRenderer.send('app:setDirty', d),
  setFile: (p) => ipcRenderer.send('app:setFile', p),
  closeNow: () => ipcRenderer.send('app:closeNow'),
  rendererReady: () => ipcRenderer.send('app:rendererReady'),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  newWindow: () => ipcRenderer.send('window:new'),
  watchFile: (p) => ipcRenderer.send('file:watch', p),
  unwatchFile: () => ipcRenderer.send('file:unwatch'),
  onFileChange: (cb) => ipcRenderer.on('file:change', (e, msg) => cb(msg)),
  windowCount: () => ipcRenderer.invoke('window:count'),
  onMenu: (cb) => ipcRenderer.on('menu', (e, action, arg) => cb(action, arg)),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (e, p) => cb(p))
});
