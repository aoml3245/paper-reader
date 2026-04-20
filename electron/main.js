const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { startServer } = require("../server");

let mainWindow;
let appServer;

const maxRecentFiles = 10;

function getRecentFilesPath() {
  return path.join(app.getPath("userData"), "recent-files.json");
}

function readRecentFiles() {
  try {
    const raw = fs.readFileSync(getRecentFilesPath(), "utf8");
    const files = JSON.parse(raw);

    return Array.isArray(files) ? files.filter((file) => fs.existsSync(file.path)) : [];
  } catch {
    return [];
  }
}

function writeRecentFiles(files) {
  fs.writeFileSync(getRecentFilesPath(), JSON.stringify(files.slice(0, maxRecentFiles), null, 2));
}

function addRecentFile(filePath) {
  const stat = fs.statSync(filePath);
  const recentFile = {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    openedAt: Date.now(),
  };
  const files = readRecentFiles().filter((file) => file.path !== filePath);

  writeRecentFiles([recentFile, ...files]);
  return recentFile;
}

function readPdfPayload(filePath) {
  const recentFile = addRecentFile(filePath);
  const buffer = fs.readFileSync(filePath);

  return {
    ...recentFile,
    data: buffer.toString("base64"),
  };
}

function registerIpcHandlers() {
  ipcMain.handle("recent-files:list", () => readRecentFiles());

  ipcMain.handle("recent-files:open", (_event, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error("PDF 파일을 찾을 수 없습니다.");
    }

    return readPdfPayload(filePath);
  });

  ipcMain.handle("pdf:choose", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "PDF 선택",
      properties: ["openFile"],
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });

    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    return readPdfPayload(result.filePaths[0]);
  });
}

async function createMainWindow() {
  const startedServer = await startServer({ port: 0, host: "127.0.0.1" });
  appServer = startedServer.server;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Paper Reader",
    backgroundColor: "#f5f7f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${startedServer.port}`);
}

app.whenReady().then(() => {
  registerIpcHandlers();
  return createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on("before-quit", () => {
  if (appServer) {
    appServer.close();
    appServer = null;
  }
});
