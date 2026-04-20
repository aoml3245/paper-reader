const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("paperReaderNative", {
  choosePdf: () => ipcRenderer.invoke("pdf:choose"),
  getRecentFiles: () => ipcRenderer.invoke("recent-files:list"),
  openRecentFile: (filePath) => ipcRenderer.invoke("recent-files:open", filePath),
});
