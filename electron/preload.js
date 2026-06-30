const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("paperReaderNative", {
  choosePdf: () => ipcRenderer.invoke("pdf:choose"),
  getRecentFiles: () => ipcRenderer.invoke("recent-files:list"),
  openRecentFile: (filePath) => ipcRenderer.invoke("recent-files:open", filePath),
  getLibrary: () => ipcRenderer.invoke("library:get"),
  chooseLibraryFolder: () => ipcRenderer.invoke("library:choose-folder"),
  scanLibraryFolder: (folderPath) => ipcRenderer.invoke("library:scan-folder", folderPath),
  onLibraryScanProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);

    ipcRenderer.on("library:scan-progress", listener);
    return () => ipcRenderer.removeListener("library:scan-progress", listener);
  },
  openLibraryPaper: (paperId) => ipcRenderer.invoke("library:open-paper", paperId),
  readLibraryPaperData: (paperId) => ipcRenderer.invoke("library:read-paper-data", paperId),
  updateLibraryPaper: (paperId, updates) => ipcRenderer.invoke("library:update-paper", paperId, updates),
  deleteLibraryPaper: (paperId) => ipcRenderer.invoke("library:delete-paper", paperId),
  revealLibraryPaper: (paperId) => ipcRenderer.invoke("library:reveal-paper", paperId),
  downloadReference: (reference) => ipcRenderer.invoke("reference:download", reference),
  downloadArxivReference: (arxivId) => ipcRenderer.invoke("reference:download-arxiv", arxivId),
  getZoom: () => ipcRenderer.invoke("settings:get-zoom"),
  setZoom: (zoom) => ipcRenderer.invoke("settings:set-zoom", zoom),
  getHistory: () => ipcRenderer.invoke("history:get"),
  setHistory: (history) => ipcRenderer.invoke("history:set", history),
  getSummaryCache: () => ipcRenderer.invoke("summaries:get"),
  setSummaryCache: (summaryCache) => ipcRenderer.invoke("summaries:set", summaryCache),
});
