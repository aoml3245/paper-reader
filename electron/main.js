const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { startServer } = require("../server");

let mainWindow;
let appServer;

const maxRecentFiles = 10;
const libraryVersion = 1;

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

const topicRules = [
  ["imitation learning", ["imitation", "behavior cloning", "demonstration", "mimic", "aloha"]],
  ["robot foundation model", ["foundation", "generalist", "vla", "vision-language-action", "gr00t", "octo", "pi0", "π0"]],
  ["diffusion policy", ["diffusion", "flow matching", "denoising", "score"]],
  ["latent action", ["latent", "world model", "dream", "imagined", "action pretraining"]],
  ["reinforcement learning", ["reinforcement", "reward", "policy optimization", "rl", "q-learning"]],
  ["bimanual manipulation", ["bimanual", "manipulation", "grasp", "teleoperation"]],
  ["vision-language model", ["vision-language", "vlm", "multimodal", "siglip", "flamingo"]],
  ["humanoid", ["humanoid", "bipedal", "locomotion", "walking"]],
  ["planning/control", ["trajectory", "planning", "control", "mpc", "optimization"]],
];

function getRecentFilesPath() {
  return path.join(app.getPath("userData"), "recent-files.json");
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function getLibraryPath() {
  return path.join(app.getPath("userData"), "paper-library.json");
}

function getManagedPaperDir() {
  return path.join(app.getPath("userData"), "Papers");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function emitLibraryProgress(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("library:scan-progress", {
    at: Date.now(),
    ...payload,
  });
}

function readLibrary() {
  try {
    const raw = fs.readFileSync(getLibraryPath(), "utf8");
    const library = JSON.parse(raw);

    if (library && typeof library === "object") {
      return {
        version: libraryVersion,
        roots: Array.isArray(library.roots) ? library.roots : [],
        papers: Array.isArray(library.papers) ? library.papers : [],
        updatedAt: library.updatedAt || null,
      };
    }
  } catch {
    // Fall through to an empty library.
  }

  return { version: libraryVersion, roots: [], papers: [], updatedAt: null };
}

function writeLibrary(library) {
  fs.writeFileSync(getLibraryPath(), JSON.stringify(library, null, 2));
}

function comparePapers(a, b) {
  if (Boolean(a.important) !== Boolean(b.important)) {
    return a.important ? -1 : 1;
  }

  if (a.important && b.important) {
    return (b.importanceUpdatedAt || 0) - (a.importanceUpdatedAt || 0);
  }

  return (a.title || "").localeCompare(b.title || "");
}

function updateLibraryPaper(paperId, updates) {
  const library = readLibrary();
  const paper = library.papers.find((entry) => entry.id === paperId || entry.hash === paperId);

  if (!paper) {
    throw new Error("논문을 찾을 수 없습니다.");
  }

  const allowedUpdates = {};

  if (typeof updates?.title === "string" && normalizeText(updates.title).length >= 4) {
    allowedUpdates.title = normalizeText(updates.title);
  }

  if (typeof updates?.titleSource === "string") {
    allowedUpdates.titleSource = normalizeText(updates.titleSource);
  }

  if (typeof updates?.arxivId === "string") {
    allowedUpdates.arxivId = getArxivId(updates.arxivId) || normalizeText(updates.arxivId);
  }

  if (typeof updates?.notes === "string") {
    allowedUpdates.notes = normalizeText(updates.notes).slice(0, 2000);
  }

  if (typeof updates?.publishedAt === "string") {
    const normalizedDate = normalizePublishedDate(updates.publishedAt);

    allowedUpdates.publishedAt = normalizedDate;
    allowedUpdates.publishedYear = normalizedDate ? Number(normalizedDate.slice(0, 4)) : 0;
  }

  if (Number.isFinite(updates?.publishedYear)) {
    const year = Number(updates.publishedYear);

    if (year >= 1900 && year <= 2100) {
      allowedUpdates.publishedYear = year;
      allowedUpdates.publishedAt = allowedUpdates.publishedAt || `${year}-01-01`;
    }
  }

  if (typeof updates?.publicationSource === "string") {
    allowedUpdates.publicationSource = normalizeText(updates.publicationSource);
  }

  if (Array.isArray(updates?.tags)) {
    const tags = updates.tags
      .map((tag) => normalizeText(tag).toLowerCase())
      .filter((tag) => tag.length >= 2 && tag.length <= 48);

    allowedUpdates.tags = Array.from(new Set(tags)).slice(0, 10);
  }

  if (typeof updates?.tagSource === "string") {
    allowedUpdates.tagSource = normalizeText(updates.tagSource);
  }

  if (typeof updates?.important === "boolean") {
    allowedUpdates.important = updates.important;
    allowedUpdates.importanceUpdatedAt = updates.important ? Date.now() : 0;
  }

  if (!Object.keys(allowedUpdates).length) return library;

  Object.assign(paper, allowedUpdates, { updatedAt: Date.now() });
  library.papers.sort(comparePapers);
  library.updatedAt = Date.now();
  writeLibrary(library);
  return library;
}

function deleteLibraryPaper(paperId) {
  const library = readLibrary();
  const paperIndex = library.papers.findIndex((entry) => entry.id === paperId || entry.hash === paperId);

  if (paperIndex < 0) {
    throw new Error("논문을 찾을 수 없습니다.");
  }

  const [deletedPaper] = library.papers.splice(paperIndex, 1);

  library.updatedAt = Date.now();
  writeLibrary(library);

  return {
    library,
    deletedPaper,
  };
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizePublishedDate(value) {
  const text = normalizeText(value);
  const fullDate = text.match(/\b(19\d{2}|20\d{2}|2100)[./-](0?[1-9]|1[0-2])[./-](0?[1-9]|[12]\d|3[01])\b/);

  if (fullDate) {
    return `${fullDate[1]}-${fullDate[2].padStart(2, "0")}-${fullDate[3].padStart(2, "0")}`;
  }

  const yearMonth = text.match(/\b(19\d{2}|20\d{2}|2100)[./-](0?[1-9]|1[0-2])\b/);
  if (yearMonth) return `${yearMonth[1]}-${yearMonth[2].padStart(2, "0")}-01`;

  const yearOnly = text.match(/\b(19\d{2}|20\d{2}|2100)\b/);
  if (yearOnly) return `${yearOnly[1]}-01-01`;

  return "";
}

function inferPublicationFromArxivId(arxivId) {
  const modern = String(arxivId || "").match(/\b(\d{2})(\d{2})\.\d{4,5}\b/);

  if (!modern) return {};

  const yy = Number(modern[1]);
  const month = Number(modern[2]);
  const year = 2000 + yy;

  if (year < 2007 || month < 1 || month > 12) return {};

  return {
    publishedAt: `${year}-${String(month).padStart(2, "0")}-01`,
    publishedYear: year,
    publicationSource: "arxiv-id",
  };
}

function getFileHash(filePath) {
  const hash = crypto.createHash("sha256");
  const buffer = fs.readFileSync(filePath);

  hash.update(buffer);
  return hash.digest("hex");
}

function getFileHashAsync(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function findPdfFiles(dirPath) {
  const results = [];
  const stack = [dirPath];
  let scannedDirs = 0;

  while (stack.length) {
    const current = stack.pop();
    let entries = [];

    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    scannedDirs += 1;
    if (scannedDirs % 12 === 0) {
      emitLibraryProgress({
        phase: "discovering",
        message: `${results.length}개 PDF 후보 찾는 중`,
        current: results.length,
      });
      await yieldToEventLoop();
    }

    entries.forEach((entry) => {
      const entryPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) stack.push(entryPath);
        return;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
        results.push(entryPath);
      }
    });
  }

  return results.sort((a, b) => a.localeCompare(b));
}

function getArxivId(value) {
  const text = String(value || "");
  const modern = text.match(/\b(\d{4}\.\d{4,5})(?:v\d+)?\b/i);
  const legacy = text.match(/\b([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?\b/i);

  return modern?.[1] || legacy?.[1] || "";
}

function guessTitle(filePath) {
  const baseName = path.basename(filePath, path.extname(filePath));
  const withoutVersion = baseName.replace(/[-_ ]?v\d+$/i, "");
  const withoutArxiv = withoutVersion.replace(/\b\d{4}\.\d{4,5}\b/g, "").trim();
  const cleaned = withoutArxiv
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bmain\b$/i, "")
    .trim();

  return cleaned || baseName;
}

function inferTags(filePath) {
  const searchable = normalizeText(filePath).toLowerCase();
  const tags = topicRules
    .filter(([, terms]) => terms.some((term) => searchable.includes(term)))
    .map(([tag]) => tag);
  const parent = path.basename(path.dirname(filePath)).replace(/^\d{2}-\d{2}-\d{2}\s*/, "").trim();

  if (parent && !["졸업", "읽을 것들"].includes(parent)) {
    tags.push(parent);
  }

  return Array.from(new Set(tags)).slice(0, 6);
}

function buildManagedFileName({ hash, sourcePath, arxivId }) {
  const extension = path.extname(sourcePath) || ".pdf";
  const titleSlug = guessTitle(sourcePath)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const prefix = arxivId ? arxivId.replace(/[/.]/g, "_") : hash.slice(0, 12);

  return `${prefix}${titleSlug ? `-${titleSlug}` : ""}${extension}`;
}

function copyToManagedStore(sourcePath, hash, arxivId) {
  const managedDir = getManagedPaperDir();
  ensureDir(managedDir);

  const destination = path.join(
    managedDir,
    buildManagedFileName({ hash, sourcePath, arxivId }),
  );

  if (!fs.existsSync(destination)) {
    fs.copyFileSync(sourcePath, destination);
  }

  return destination;
}

async function copyToManagedStoreAsync(sourcePath, hash, arxivId) {
  const managedDir = getManagedPaperDir();
  ensureDir(managedDir);

  const destination = path.join(
    managedDir,
    buildManagedFileName({ hash, sourcePath, arxivId }),
  );

  if (!fs.existsSync(destination)) {
    await fs.promises.copyFile(sourcePath, destination);
  }

  return destination;
}

function createFileSlug(value, fallback = "paper") {
  const slug = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);

  return slug || fallback;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

async function fetchPdfBuffer(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "PaperReader/0.1 (+local research reader)",
    },
  });

  if (!response.ok) {
    throw new Error(`PDF 다운로드 실패: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("pdf") && buffer.subarray(0, 4).toString() !== "%PDF") {
    throw new Error("다운로드한 파일이 PDF가 아닙니다.");
  }

  return buffer;
}

function addDownloadedPaper({ filePath, title, arxivId = "", sourceUrl = "", tags = [], publication = {} }) {
  const hash = getFileHash(filePath);
  const stat = fs.statSync(filePath);
  const library = readLibrary();
  const inferredPublication = publication.publishedAt
    ? publication
    : inferPublicationFromArxivId(arxivId || filePath);
  const existing = library.papers.find(
    (paper) => paper.hash === hash || (arxivId && paper.arxivId === arxivId),
  );

  if (!existing) {
    library.papers.push({
      id: hash,
      hash,
      title: title || (arxivId ? `arXiv ${arxivId}` : path.basename(filePath, ".pdf")),
      fileName: path.basename(filePath),
      sourcePath: filePath,
      managedPath: filePath,
      relativePath: path.basename(filePath),
      size: stat.size,
      arxivId,
      ...inferredPublication,
      sourceUrl,
      tags: Array.from(new Set([...tags, ...inferTags(filePath)])).slice(0, 8),
      tagSource: tags.length ? "reference" : "path",
      sources: [filePath],
      addedAt: Date.now(),
      updatedAt: Date.now(),
    });
    library.papers.sort(comparePapers);
    library.updatedAt = Date.now();
    writeLibrary(library);
  }

  return readLibrary();
}

async function addDownloadedPaperAsync({
  filePath,
  title,
  arxivId = "",
  sourceUrl = "",
  tags = [],
  publication = {},
}) {
  const hash = await getFileHashAsync(filePath);
  const stat = await fs.promises.stat(filePath);
  const library = readLibrary();
  const inferredPublication = publication.publishedAt
    ? publication
    : inferPublicationFromArxivId(arxivId || filePath);
  const existing = library.papers.find(
    (paper) => paper.hash === hash || (arxivId && paper.arxivId === arxivId),
  );

  if (!existing) {
    library.papers.push({
      id: hash,
      hash,
      title: title || (arxivId ? `arXiv ${arxivId}` : path.basename(filePath, ".pdf")),
      fileName: path.basename(filePath),
      sourcePath: filePath,
      managedPath: filePath,
      relativePath: path.basename(filePath),
      size: stat.size,
      arxivId,
      ...inferredPublication,
      sourceUrl,
      tags: Array.from(new Set([...tags, ...inferTags(filePath)])).slice(0, 8),
      tagSource: tags.length ? "reference" : "path",
      sources: [filePath],
      addedAt: Date.now(),
      updatedAt: Date.now(),
    });
    library.papers.sort(comparePapers);
    library.updatedAt = Date.now();
    writeLibrary(library);
  }

  return readLibrary();
}

async function downloadArxivPaper(arxivId, title = "", publicationHint = {}) {
  const normalizedId = getArxivId(arxivId);

  if (!normalizedId) {
    throw new Error("arXiv ID를 찾을 수 없습니다.");
  }

  ensureDir(getManagedPaperDir());

  const destination = path.join(getManagedPaperDir(), `${normalizedId.replace(/[/.]/g, "_")}.pdf`);

  if (!fs.existsSync(destination)) {
    const buffer = await fetchPdfBuffer(`https://arxiv.org/pdf/${normalizedId}`);
    await fs.promises.writeFile(destination, buffer);
  }

  const arxivMetadata = await fetchArxivMetadata(normalizedId).catch(() => null);
  const publication = publicationHint?.publishedAt
    ? {
        publishedAt: publicationHint.publishedAt,
        publishedYear: publicationHint.publishedYear || Number(publicationHint.publishedAt.slice(0, 4)),
        publicationSource: "arxiv-api",
      }
    : arxivMetadata?.publishedAt
    ? {
        publishedAt: arxivMetadata.publishedAt,
        publishedYear: arxivMetadata.publishedYear,
        publicationSource: "arxiv-api",
      }
    : inferPublicationFromArxivId(normalizedId);
  const library = await addDownloadedPaperAsync({
    filePath: destination,
    title: title || arxivMetadata?.title || `arXiv ${normalizedId}`,
    arxivId: normalizedId,
    sourceUrl: `https://arxiv.org/abs/${normalizedId}`,
    publication,
  });

  return {
    ...(await readPdfPayloadAsync(destination)),
    library,
  };
}

async function fetchArxivMetadata(arxivId) {
  const response = await fetch(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`,
  );

  if (!response.ok) return null;

  const xml = await response.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/i)?.[1];

  if (!entry) return null;

  const title = normalizeText(decodeXml(entry.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || ""));
  const published = normalizePublishedDate(
    decodeXml(entry.match(/<published>([\s\S]*?)<\/published>/i)?.[1] || ""),
  );

  return {
    title,
    publishedAt: published,
    publishedYear: published ? Number(published.slice(0, 4)) : 0,
  };
}

async function searchArxivByTitle(title) {
  const cleanedTitle = normalizeText(title)
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 180);

  if (cleanedTitle.length < 12) return null;

  const query = encodeURIComponent(`ti:"${cleanedTitle}"`);
  const response = await fetch(
    `https://export.arxiv.org/api/query?search_query=${query}&start=0&max_results=1`,
  );

  if (!response.ok) {
    throw new Error(`arXiv 검색 실패: ${response.status}`);
  }

  const xml = await response.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/i)?.[1];

  if (!entry) return null;

  const idUrl = decodeXml(entry.match(/<id>([\s\S]*?)<\/id>/i)?.[1] || "");
  const arxivId = getArxivId(idUrl);
  const foundTitle = normalizeText(decodeXml(entry.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || ""));
  const publishedAt = normalizePublishedDate(
    decodeXml(entry.match(/<published>([\s\S]*?)<\/published>/i)?.[1] || ""),
  );

  return arxivId
    ? {
        arxivId,
        title: foundTitle || cleanedTitle,
        publishedAt,
        publishedYear: publishedAt ? Number(publishedAt.slice(0, 4)) : 0,
      }
    : null;
}

function normalizeReferencePayload(reference) {
  if (typeof reference === "string") {
    return { arxivId: getArxivId(reference), title: "", url: reference, doi: "", snippet: reference };
  }

  return {
    arxivId: getArxivId(reference?.arxivId || reference?.id || reference?.url || reference?.snippet || ""),
    title: normalizeText(reference?.title || ""),
    url: normalizeText(reference?.url || ""),
    doi: normalizeText(reference?.doi || ""),
    snippet: normalizeText(reference?.snippet || ""),
    tags: Array.isArray(reference?.tags) ? reference.tags : [],
  };
}

function getDirectPdfUrl(url) {
  if (!/^https?:\/\//i.test(url)) return "";

  const arxivId = getArxivId(url);
  if (arxivId) return `https://arxiv.org/pdf/${arxivId}`;
  if (/\.pdf(?:[?#].*)?$/i.test(url)) return url;
  return "";
}

async function downloadReference(reference) {
  const payload = normalizeReferencePayload(reference);

  if (payload.arxivId) {
    return downloadArxivPaper(payload.arxivId, payload.title);
  }

  const pdfUrl = getDirectPdfUrl(payload.url);
  if (pdfUrl) {
    ensureDir(getManagedPaperDir());
    const title = payload.title || path.basename(new URL(pdfUrl).pathname, ".pdf") || "reference";
    const destination = path.join(getManagedPaperDir(), `${createFileSlug(title)}.pdf`);

    if (!fs.existsSync(destination)) {
      await fs.promises.writeFile(destination, await fetchPdfBuffer(pdfUrl));
    }

    return {
      ...(await readPdfPayloadAsync(destination)),
      library: await addDownloadedPaperAsync({
        filePath: destination,
        title,
        sourceUrl: pdfUrl,
        tags: payload.tags,
      }),
    };
  }

  const titleQuery = payload.title || guessReferenceTitle(payload.snippet);
  const arxivMatch = await searchArxivByTitle(titleQuery);

  if (arxivMatch) {
    return downloadArxivPaper(arxivMatch.arxivId, arxivMatch.title || titleQuery, arxivMatch);
  }

  throw new Error("다운로드 가능한 arXiv/PDF 링크를 찾지 못했습니다.");
}

function guessReferenceTitle(snippet) {
  const text = normalizeText(snippet)
    .replace(/^\s*(?:\[\d+\]|\d+\.|\(\d+\))\s*/, "")
    .replace(/\barXiv preprint arXiv:\d{4}\.\d{4,5}(?:v\d+)?\b.*$/i, "")
    .replace(/\bdoi:\s*10\.\S+.*$/i, "");
  const quoted = text.match(/[“"]([^”"]{12,180})[”"]/);

  if (quoted) return quoted[1];

  const sentences = text.split(/\.\s+/).map((part) => part.trim()).filter(Boolean);
  const candidate = sentences.find((part) => /[a-z]/i.test(part) && part.length > 18 && part.length < 180);

  return candidate || text.slice(0, 160);
}

function createPaperRecord(sourcePath, rootPath, hash) {
  const stat = fs.statSync(sourcePath);
  const arxivId = getArxivId(sourcePath);
  const managedPath = copyToManagedStore(sourcePath, hash, arxivId);
  const publication = inferPublicationFromArxivId(arxivId || sourcePath);

  return {
    id: hash,
    hash,
    title: guessTitle(sourcePath),
    fileName: path.basename(sourcePath),
    sourcePath,
    managedPath,
    relativePath: path.relative(rootPath, sourcePath),
    size: stat.size,
    arxivId,
    ...publication,
    tags: inferTags(sourcePath),
    tagSource: "path",
    addedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function createPaperRecordAsync(sourcePath, rootPath, hash) {
  const stat = await fs.promises.stat(sourcePath);
  const arxivId = getArxivId(sourcePath);
  const managedPath = await copyToManagedStoreAsync(sourcePath, hash, arxivId);
  const publication = inferPublicationFromArxivId(arxivId || sourcePath);

  return {
    id: hash,
    hash,
    title: guessTitle(sourcePath),
    fileName: path.basename(sourcePath),
    sourcePath,
    managedPath,
    relativePath: path.relative(rootPath, sourcePath),
    size: stat.size,
    arxivId,
    ...publication,
    tags: inferTags(sourcePath),
    tagSource: "path",
    addedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function scanLibraryRoot(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    throw new Error("폴더를 찾을 수 없습니다.");
  }

  emitLibraryProgress({
    phase: "discovering",
    message: "하위 폴더에서 PDF 찾는 중",
    current: 0,
  });

  const library = readLibrary();
  const byHash = new Map(library.papers.map((paper) => [paper.hash, paper]));
  const pdfFiles = await findPdfFiles(rootPath);
  let added = 0;
  let duplicates = 0;

  emitLibraryProgress({
    phase: "hashing",
    message: `${pdfFiles.length}개 PDF 해시 확인 중`,
    current: 0,
    total: pdfFiles.length,
  });

  for (let index = 0; index < pdfFiles.length; index += 1) {
    const filePath = pdfFiles[index];
    const current = index + 1;

    emitLibraryProgress({
      phase: "hashing",
      message: `${current}/${pdfFiles.length} 해시 확인 중`,
      current,
      total: pdfFiles.length,
      fileName: path.basename(filePath),
    });

    const hash = await getFileHashAsync(filePath);
    const existing = byHash.get(hash);

    if (existing) {
      duplicates += 1;
      existing.sourcePath = existing.sourcePath || filePath;
      existing.sources = Array.from(new Set([...(existing.sources || []), filePath]));
      existing.updatedAt = Date.now();
      await yieldToEventLoop();
      continue;
    }

    emitLibraryProgress({
      phase: "copying",
      message: `${current}/${pdfFiles.length} 보관함에 복사 중`,
      current,
      total: pdfFiles.length,
      fileName: path.basename(filePath),
    });

    const paper = await createPaperRecordAsync(filePath, rootPath, hash);

    paper.sources = [filePath];
    byHash.set(hash, paper);
    added += 1;
    await yieldToEventLoop();
  }

  const nextLibrary = {
    version: libraryVersion,
    roots: Array.from(new Set([rootPath, ...library.roots])),
    papers: Array.from(byHash.values()).sort(comparePapers),
    updatedAt: Date.now(),
  };

  writeLibrary(nextLibrary);
  emitLibraryProgress({
    phase: "done",
    message: `${pdfFiles.length}개 스캔 완료`,
    current: pdfFiles.length,
    total: pdfFiles.length,
  });

  return {
    ...nextLibrary,
    stats: {
      scanned: pdfFiles.length,
      added,
      duplicates,
      total: nextLibrary.papers.length,
    },
  };
}

function readPdfPayload(filePath) {
  const recentFile = addRecentFile(filePath);
  const buffer = fs.readFileSync(filePath);

  return {
    ...recentFile,
    data: buffer.toString("base64"),
  };
}

async function readPdfPayloadAsync(filePath) {
  const recentFile = addRecentFile(filePath);
  const buffer = await fs.promises.readFile(filePath);

  return {
    ...recentFile,
    data: buffer.toString("base64"),
  };
}

function readPdfDataPayload(filePath) {
  const stat = fs.statSync(filePath);
  const buffer = fs.readFileSync(filePath);

  return {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    data: buffer.toString("base64"),
  };
}

async function readPdfDataPayloadAsync(filePath) {
  const stat = await fs.promises.stat(filePath);
  const buffer = await fs.promises.readFile(filePath);

  return {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    data: buffer.toString("base64"),
  };
}

function readSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), "utf8");
    const settings = JSON.parse(raw);

    return settings && typeof settings === "object" ? settings : {};
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
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

function registerIpcHandlers() {
  ipcMain.handle("recent-files:list", () => readRecentFiles());
  ipcMain.handle("library:get", () => readLibrary());

  ipcMain.handle("library:choose-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "논문 폴더 선택",
      defaultPath: path.join(app.getPath("desktop"), "연구실", "졸업"),
      properties: ["openDirectory"],
    });

    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    return scanLibraryRoot(result.filePaths[0]);
  });

  ipcMain.handle("library:scan-folder", (_event, folderPath) => scanLibraryRoot(folderPath));

  ipcMain.handle("library:open-paper", async (_event, paperId) => {
    const library = readLibrary();
    const paper = library.papers.find((entry) => entry.id === paperId || entry.hash === paperId);
    const filePath = paper?.managedPath || paper?.sourcePath;

    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error("논문 PDF를 찾을 수 없습니다.");
    }

    return {
      ...(await readPdfPayloadAsync(filePath)),
      paper,
    };
  });

  ipcMain.handle("library:read-paper-data", async (_event, paperId) => {
    const library = readLibrary();
    const paper = library.papers.find((entry) => entry.id === paperId || entry.hash === paperId);
    const filePath = paper?.managedPath || paper?.sourcePath;

    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error("논문 PDF를 찾을 수 없습니다.");
    }

    return {
      ...(await readPdfDataPayloadAsync(filePath)),
      paper,
    };
  });

  ipcMain.handle("library:update-paper", (_event, paperId, updates) =>
    updateLibraryPaper(paperId, updates),
  );

  ipcMain.handle("library:delete-paper", (_event, paperId) => deleteLibraryPaper(paperId));

  ipcMain.handle("library:reveal-paper", (_event, paperId) => {
    const library = readLibrary();
    const paper = library.papers.find((entry) => entry.id === paperId || entry.hash === paperId);
    const filePath = paper?.managedPath || paper?.sourcePath;

    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error("논문 PDF를 찾을 수 없습니다.");
    }

    shell.showItemInFolder(filePath);
  });

  ipcMain.handle("reference:download", (_event, reference) => downloadReference(reference));
  ipcMain.handle("reference:download-arxiv", (_event, arxivId) => downloadArxivPaper(arxivId));

  ipcMain.handle("settings:get-zoom", () => {
    const settings = readSettings();

    return typeof settings.zoom === "string" ? settings.zoom : null;
  });

  ipcMain.handle("settings:set-zoom", (_event, zoom) => {
    const settings = readSettings();

    settings.zoom = String(zoom);
    writeSettings(settings);
  });

  ipcMain.handle("history:get", () => {
    const settings = readSettings();

    return settings.history && typeof settings.history === "object" ? settings.history : {};
  });

  ipcMain.handle("history:set", (_event, history) => {
    const settings = readSettings();

    settings.history = history && typeof history === "object" ? history : {};
    writeSettings(settings);
  });

  ipcMain.handle("summaries:get", () => {
    const settings = readSettings();

    return settings.summaryCache && typeof settings.summaryCache === "object"
      ? settings.summaryCache
      : {};
  });

  ipcMain.handle("summaries:set", (_event, summaryCache) => {
    const settings = readSettings();

    settings.summaryCache = summaryCache && typeof summaryCache === "object" ? summaryCache : {};
    writeSettings(settings);
  });

  ipcMain.handle("recent-files:open", async (_event, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error("PDF 파일을 찾을 수 없습니다.");
    }

    return readPdfPayloadAsync(filePath);
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

    return readPdfPayloadAsync(result.filePaths[0]);
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
      backgroundThrottling: false,
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
