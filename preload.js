const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  syncMods: () => ipcRenderer.invoke('mods:sync'),
  launch: (payload) => ipcRenderer.invoke('mc:launch', payload),
  onLog: (cb) => ipcRenderer.on('mc:log', (_, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on('mc:progress', (_, p) => cb(p))
});
