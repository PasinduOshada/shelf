const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit surface: native pickers and the desktop-only settings.
contextBridge.exposeInMainWorld('shelf', {
  isDesktop: true,
  pickFolder: (title) => ipcRenderer.invoke('shelf:pickFolder', title),
  pickPlayer: () => ipcRenderer.invoke('shelf:pickPlayer'),
  getDesktop: () => ipcRenderer.invoke('shelf:getDesktop'),
  setDesktop: (patch) => ipcRenderer.invoke('shelf:setDesktop', patch),
  updates: () => ipcRenderer.invoke('shelf:updates'),
  checkUpdates: () => ipcRenderer.invoke('shelf:checkUpdates'),
  setAutoUpdate: (on) => ipcRenderer.invoke('shelf:setAutoUpdate', on),
  installUpdate: () => ipcRenderer.invoke('shelf:installUpdate'),
});
