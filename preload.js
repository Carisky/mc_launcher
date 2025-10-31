const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('launcher', {
  bootstrap: () => invoke('app:bootstrap'),
  authStatus: () => invoke('auth:status'),
  authLogin: (payload) => invoke('auth:login', payload),
  authRegister: (payload) => invoke('auth:register', payload),
  authLogout: () => invoke('auth:logout'),
  authRefresh: () => invoke('auth:refresh'),
  updateSettings: (payload) => invoke('settings:update', payload),
  selectModpack: (modpackId) => invoke('modpack:set', modpackId),
  openModsFolder: (modpackId) => invoke('fs:openModsDir', modpackId),
  syncMods: () => invoke('mods:sync'),
  fetchServerStatus: (serverId) => invoke('server:status', serverId),
  launch: (payload) => invoke('mc:launch', payload),
  onLog: (cb) => ipcRenderer.on('mc:log', (_, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on('mc:progress', (_, p) => cb(p))
});
