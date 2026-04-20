const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("paperReaderNative", {
  choosePdf: () => ipcRenderer.invoke("pdf:choose"),
  getRecentFiles: () => ipcRenderer.invoke("recent-files:list"),
  openRecentFile: (filePath) => ipcRenderer.invoke("recent-files:open", filePath),
  getZoom: () => ipcRenderer.invoke("settings:get-zoom"),
  setZoom: (zoom) => ipcRenderer.invoke("settings:set-zoom", zoom),
  getHistory: () => ipcRenderer.invoke("history:get"),
  setHistory: (history) => ipcRenderer.invoke("history:set", history),
});
