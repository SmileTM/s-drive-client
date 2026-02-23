const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  startDrag: (files, driveId) => ipcRenderer.send('ondragstart', files, driveId),
  selectSavePath: (defaultName) => ipcRenderer.invoke('select-save-path', defaultName),
  downloadFile: (url, targetPath) => ipcRenderer.invoke('download-file', url, targetPath)
});