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
  downloadShaderpacks: () => invoke('packs:downloadShaderpacks'),
  downloadResourcepacks: () => invoke('packs:downloadResourcepacks'),
  fetchServerStatus: (serverId) => invoke('server:status', serverId),
  launch: (payload) => invoke('mc:launch', payload),
  refreshUpdate: () => invoke('app:update:refresh'),
  startUpdateDownload: () => invoke('app:update:start'),
  onUpdate: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('app:update:event', handler);
    return () => ipcRenderer.removeListener('app:update:event', handler);
  },
  onLog: (cb) => ipcRenderer.on('mc:log', (_, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on('mc:progress', (_, p) => cb(p))
});
