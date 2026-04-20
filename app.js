const fileInput = document.querySelector("#fileInput");
const toolbar = document.querySelector(".toolbar");
const openButton = document.querySelector("#openButton");
const clearButton = document.querySelector("#clearButton");
const historyButton = document.querySelector("#historyButton");
const dropZone = document.querySelector("#dropZone");
const viewerFrame = document.querySelector("#viewerFrame");
const pdfPages = document.querySelector("#pdfPages");
const fileName = document.querySelector("#fileName");
const fileSize = document.querySelector("#fileSize");
const viewState = document.querySelector("#viewState");
const pageCount = document.querySelector("#pageCount");
const docTitle = document.querySelector("#docTitle");
const docInfoButton = document.querySelector("#docInfoButton");
const docInfoPopover = document.querySelector("#docInfoPopover");
const pageInput = document.querySelector("#pageInput");
const goPageButton = document.querySelector("#goPageButton");
const zoomSelect = document.querySelector("#zoomSelect");
const translationPopover = document.querySelector("#translationPopover");
const popoverHead = translationPopover.querySelector(".popover-head");
const unpinPopoverButton = document.querySelector("#unpinPopoverButton");
const closePopoverButton = document.querySelector("#closePopoverButton");
const popoverSelection = document.querySelector("#popoverSelection");
const popoverBody = document.querySelector("#popoverBody");
const recentFilesPanel = document.querySelector("#recentFilesPanel");
const recentFilesList = document.querySelector("#recentFilesList");
const historyPanel = document.querySelector("#historyPanel");
const closeHistoryButton = document.querySelector("#closeHistoryButton");
const historyFileSelect = document.querySelector("#historyFileSelect");
const wordHistoryList = document.querySelector("#wordHistoryList");
const sentenceHistoryList = document.querySelector("#sentenceHistoryList");

const pdfjs = window.pdfjsLib;
const zoomStorageKey = "paperReader.zoom";
const historyStorageKey = "paperReader.history";
const nativeApi = window.paperReaderNative;

if (pdfjs) {
  pdfjs.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
} else {
  viewState.textContent = "PDF.js를 불러올 수 없습니다.";
}

let currentPdf = null;
let currentFileName = "";
let currentFileSize = 0;
let documentText = "";
let renderTaskId = 0;
let lastSelection = "";
let selectedWordElements = [];
let selectedWordGroups = [];
let selectionHighlightElements = [];
let activeTranslationId = 0;
let suppressNextSelectionCapture = false;
let activeTranslationController = null;
let lastSingleWordElement = null;
let dragSelection = null;
let lastGestureZoomAt = 0;
let popoverDrag = null;
let isPopoverPinned = false;
let currentHistoryFileKey = "";

restoreZoom();
loadNativeHistory();
loadRecentFiles();
syncToolbarHeight();

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";

  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function setControlsEnabled(isEnabled) {
  clearButton.disabled = !isEnabled;
  pageInput.disabled = !isEnabled;
  goPageButton.disabled = !isEnabled;
  zoomSelect.disabled = !isEnabled;
  requestAnimationFrame(syncToolbarHeight);
}

function getCurrentFileKey() {
  if (!currentFileName) return "";

  return `${currentFileName}::${currentFileSize || 0}`;
}

function readHistoryStore() {
  try {
    const history = JSON.parse(localStorage.getItem(historyStorageKey) || "{}");

    return history && typeof history === "object" ? history : {};
  } catch {
    return {};
  }
}

function writeHistoryStore(history) {
  localStorage.setItem(historyStorageKey, JSON.stringify(history));
  nativeApi?.setHistory?.(history)?.catch?.((error) => console.error(error));
}

async function loadNativeHistory() {
  if (!nativeApi?.getHistory) return;

  try {
    const history = await nativeApi.getHistory();

    if (history && typeof history === "object") {
      localStorage.setItem(historyStorageKey, JSON.stringify(history));
    }
  } catch (error) {
    console.error(error);
  }
}

function getSelectionHistoryType(text) {
  const normalized = normalizeText(text);

  return normalized.split(/\s+/).filter(Boolean).length <= 1 ? "word" : "sentence";
}

function saveHistoryEntry(selectionText, translatedText) {
  const fileKey = getCurrentFileKey();

  if (!fileKey || !selectionText || !translatedText) return;

  const history = readHistoryStore();
  const fileHistory = history[fileKey] || {
    fileName: currentFileName,
    size: currentFileSize,
    entries: [],
  };
  const normalizedText = normalizeText(selectionText);
  const nextEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: getSelectionHistoryType(selectionText),
    text: normalizedText,
    translation: sanitizeTranslationText(translatedText),
    createdAt: Date.now(),
  };

  fileHistory.fileName = currentFileName;
  fileHistory.size = currentFileSize;
  fileHistory.entries = [
    nextEntry,
    ...fileHistory.entries.filter((entry) => normalizeText(entry.text) !== normalizedText),
  ].slice(0, 200);
  history[fileKey] = fileHistory;
  writeHistoryStore(history);

  if (!historyPanel.hidden) {
    renderHistoryPanel(fileKey);
  }
}

function toggleHistoryPanel() {
  if (historyPanel.hidden) {
    renderHistoryPanel(getCurrentFileKey() || currentHistoryFileKey);
    historyPanel.hidden = false;
    return;
  }

  historyPanel.hidden = true;
}

function renderHistoryPanel(preferredFileKey = "") {
  const history = readHistoryStore();
  const fileKeys = Object.keys(history).sort(
    (a, b) => (history[b].entries?.[0]?.createdAt || 0) - (history[a].entries?.[0]?.createdAt || 0),
  );
  const selectedKey = fileKeys.includes(preferredFileKey)
    ? preferredFileKey
    : fileKeys.includes(currentHistoryFileKey)
      ? currentHistoryFileKey
      : fileKeys[0] || "";

  currentHistoryFileKey = selectedKey;
  historyFileSelect.replaceChildren();

  if (!fileKeys.length) {
    const option = document.createElement("option");

    option.textContent = "기록 없음";
    option.value = "";
    historyFileSelect.append(option);
    renderHistoryList(wordHistoryList, []);
    renderHistoryList(sentenceHistoryList, []);
    return;
  }

  fileKeys.forEach((fileKey) => {
    const option = document.createElement("option");

    option.value = fileKey;
    option.textContent = history[fileKey].fileName || "이름 없는 PDF";
    historyFileSelect.append(option);
  });

  historyFileSelect.value = selectedKey;

  const entries = history[selectedKey]?.entries || [];

  renderHistoryList(wordHistoryList, entries.filter((entry) => entry.type === "word"));
  renderHistoryList(sentenceHistoryList, entries.filter((entry) => entry.type === "sentence"));
}

function renderHistoryList(container, entries) {
  container.replaceChildren();

  if (!entries.length) {
    const empty = document.createElement("p");

    empty.className = "history-empty";
    empty.textContent = "아직 기록이 없습니다.";
    container.append(empty);
    return;
  }

  entries.forEach((entry) => {
    const item = document.createElement("article");
    const text = document.createElement("strong");
    const translation = document.createElement("p");
    const time = document.createElement("span");

    item.className = "history-item";
    text.textContent = entry.text;
    translation.textContent = entry.translation;
    time.textContent = formatHistoryTime(entry.createdAt);

    item.append(text, translation, time);
    container.append(item);
  });
}

function formatHistoryTime(timestamp) {
  if (!timestamp) return "";

  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function setPopoverState(selectionText, message, state = "loading") {
  popoverSelection.textContent = selectionText;
  translationPopover.dataset.state = state;

  if (state === "done") {
    renderParsedTranslation(message);
  } else {
    popoverBody.textContent = message;
  }
}

function showPopoverForWords(words, selectionText) {
  if (!words.length) return;

  setPopoverState(selectionText, "번역 중...", "loading");
  translationPopover.classList.add("is-visible");
  positionPopover(words);
  requestAnimationFrame(() => positionPopover(words));
}

function hidePopover() {
  translationPopover.classList.remove("is-visible");
}

function setPopoverPinned(isPinned) {
  isPopoverPinned = isPinned;
  translationPopover.classList.toggle("is-pinned", isPinned);
}

function unpinPopover() {
  setPopoverPinned(false);

  if (selectedWordElements.length) {
    positionPopover(selectedWordElements);
  }
}

function hideDocInfo() {
  docInfoPopover.classList.remove("is-visible");
  docInfoButton.setAttribute("aria-expanded", "false");
}

function toggleDocInfo() {
  if (docInfoButton.disabled) return;

  const isOpen = docInfoPopover.classList.toggle("is-visible");
  docInfoButton.setAttribute("aria-expanded", String(isOpen));
}

function positionPopover(words) {
  if (isPopoverPinned) return;

  const frameRect = viewerFrame.getBoundingClientRect();
  const wordRects = words.map((word) => word.getBoundingClientRect());
  const selectionRect = unionRects(wordRects);
  const popoverRect = translationPopover.getBoundingClientRect();
  const margin = 12;
  const maxLeft = Math.max(frameRect.width - popoverRect.width - margin, margin);
  let left = selectionRect.left - frameRect.left;
  let top = selectionRect.bottom - frameRect.top + margin;

  left = Math.min(Math.max(left, margin), maxLeft);

  if (top + popoverRect.height > frameRect.height - margin) {
    top = selectionRect.top - frameRect.top - popoverRect.height - margin;
  }

  top = Math.max(top, margin);
  translationPopover.style.left = `${left}px`;
  translationPopover.style.top = `${top}px`;
}

function renderParsedTranslation(message) {
  const cleanedMessage = sanitizeTranslationText(message);
  const sections = parseTranslationSections(cleanedMessage);

  popoverBody.replaceChildren();

  if (!sections.length) {
    popoverBody.textContent = cleanedMessage;
    return;
  }

  sections.forEach((section) => {
    const article = document.createElement("article");
    const title = document.createElement("h3");
    const body = document.createElement("p");

    article.className = "translation-section";
    title.textContent = section.title;
    body.textContent = section.body;

    article.append(title, body);
    popoverBody.append(article);
  });
}

function parseTranslationSections(message) {
  const text = sanitizeTranslationText(message);

  if (!text) return [];

  const labelPattern =
    /(?:^|\n)\s*[-*]?\s*(뜻|문맥상 의미|짧은 해석|해석|쉽게 설명하면|부연설명)\s*:\s*/g;
  const matches = Array.from(text.matchAll(labelPattern));

  if (!matches.length) return [];

  return matches
    .map((match, index) => {
      const nextMatch = matches[index + 1];
      const start = match.index + match[0].length;
      const end = nextMatch ? nextMatch.index : text.length;

      return {
        title: normalizeTranslationLabel(match[1]),
        body: sanitizeTranslationText(text.slice(start, end)),
      };
    })
    .filter((section) => section.body);
}

function sanitizeTranslationText(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, (block) =>
      block
        .replace(/^```[^\n]*\n?/, "")
        .replace(/\n?```$/, ""),
    )
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+(?=(?:뜻|문맥상 의미|짧은 해석|해석|쉽게 설명하면|부연설명)\s*:)/gm, "")
    .replace(/\*\*((?:뜻|문맥상 의미|짧은 해석|해석|쉽게 설명하면|부연설명)\s*:)\*\*/g, "$1")
    .replace(/__((?:뜻|문맥상 의미|짧은 해석|해석|쉽게 설명하면|부연설명)\s*:?)__/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTranslationLabel(label) {
  if (label === "쉽게 설명하면") return "부연설명";

  return label;
}

function startPopoverDrag(event) {
  if (event.button !== 0 || event.target.closest("button")) return;

  const popoverRect = translationPopover.getBoundingClientRect();
  const frameRect = viewerFrame.getBoundingClientRect();

  popoverDrag = {
    offsetX: event.clientX - popoverRect.left,
    offsetY: event.clientY - popoverRect.top,
    frameLeft: frameRect.left,
    frameTop: frameRect.top,
  };
  setPopoverPinned(true);
  popoverHead.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function updatePopoverDrag(event) {
  if (!popoverDrag) return;

  movePopoverTo(event.clientX - popoverDrag.frameLeft, event.clientY - popoverDrag.frameTop);
}

function finishPopoverDrag() {
  popoverDrag = null;
}

function movePopoverTo(x, y) {
  const frameRect = viewerFrame.getBoundingClientRect();
  const popoverRect = translationPopover.getBoundingClientRect();
  const margin = 8;
  const maxLeft = Math.max(frameRect.width - popoverRect.width - margin, margin);
  const maxTop = Math.max(frameRect.height - popoverRect.height - margin, margin);
  const left = Math.min(Math.max(x - popoverDrag.offsetX, margin), maxLeft);
  const top = Math.min(Math.max(y - popoverDrag.offsetY, margin), maxTop);

  translationPopover.style.left = `${left}px`;
  translationPopover.style.top = `${top}px`;
}

function unionRects(rects) {
  return rects.reduce(
    (union, rect) => ({
      left: Math.min(union.left, rect.left),
      top: Math.min(union.top, rect.top),
      right: Math.max(union.right, rect.right),
      bottom: Math.max(union.bottom, rect.bottom),
    }),
    {
      left: rects[0].left,
      top: rects[0].top,
      right: rects[0].right,
      bottom: rects[0].bottom,
    },
  );
}

function getScale() {
  return Number(zoomSelect.value) / 100;
}

async function restoreZoom() {
  let savedZoom = localStorage.getItem(zoomStorageKey);

  if (nativeApi?.getZoom) {
    try {
      savedZoom = await nativeApi.getZoom();
    } catch (error) {
      console.error(error);
    }
  }

  if (!savedZoom) return;

  applyZoomValue(savedZoom, { persist: false, render: false });
}

function persistZoom() {
  localStorage.setItem(zoomStorageKey, zoomSelect.value);
  nativeApi?.setZoom?.(zoomSelect.value)?.catch?.((error) => console.error(error));
}

function applyZoomValue(value, { persist = true, render = true } = {}) {
  const normalizedValue = String(value);
  const hasOption = getZoomValues().includes(Number(normalizedValue));

  if (!hasOption || zoomSelect.value === normalizedValue) return false;

  zoomSelect.value = normalizedValue;

  if (persist) {
    persistZoom();
  }

  if (render && currentPdf) {
    renderPdf({ preservePage: true });
  }

  return true;
}

function getZoomValues() {
  return Array.from(zoomSelect.options).map((option) => Number(option.value));
}

function stepZoom(direction) {
  const values = getZoomValues();
  const currentValue = Number(zoomSelect.value);
  const currentIndex = Math.max(values.indexOf(currentValue), 0);
  const nextIndex = Math.min(Math.max(currentIndex + direction, 0), values.length - 1);

  if (nextIndex === currentIndex) return;

  applyZoomValue(values[nextIndex]);
}

function syncToolbarHeight() {
  document.documentElement.style.setProperty("--toolbar-height", `${toolbar.offsetHeight}px`);
}

function clearPages() {
  pdfPages.replaceChildren();
}

function clearWordMarkers() {
  selectedWordElements.forEach((word) => word.classList.remove("is-selected"));
  selectedWordElements = [];
  selectedWordGroups = [];
  clearSelectionHighlights();
  hidePopover();
}

function clearSelectionHighlights() {
  selectionHighlightElements.forEach((highlight) => highlight.remove());
  selectionHighlightElements = [];
}

function cancelActiveTranslation() {
  if (activeTranslationController) {
    activeTranslationController.abort();
    activeTranslationController = null;
  }

  activeTranslationId += 1;
}

function clearActiveSelection({ rememberSingleWord = true } = {}) {
  cancelActiveTranslation();
  lastSelection = "";
  lastSingleWordElement =
    rememberSingleWord && selectedWordElements.length === 1 ? selectedWordElements[0] : null;
  clearWordMarkers();
  window.getSelection()?.removeAllRanges();
}

function startDragSelection(event, word, isExtending) {
  dragSelection = {
    startX: event.clientX,
    startY: event.clientY,
    endX: event.clientX,
    endY: event.clientY,
    points: [{ x: event.clientX, y: event.clientY }],
    word,
    focusWord: word,
    baseGroups: isExtending ? cloneWordGroups(selectedWordGroups) : [],
    isExtending,
    moved: false,
  };
}

function updateDragSelection(event) {
  if (!dragSelection) return;

  dragSelection.endX = event.clientX;
  dragSelection.endY = event.clientY;
  addDragPoint(dragSelection, event.clientX, event.clientY);
  dragSelection.moved =
    Math.abs(dragSelection.endX - dragSelection.startX) > 3 ||
    Math.abs(dragSelection.endY - dragSelection.startY) > 3;

  const hoveredWord = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest?.(".word-token");

  if (hoveredWord) {
    dragSelection.focusWord = hoveredWord;
  }

  if (dragSelection.moved) {
    previewDragSelection(dragSelection);
  }
}

function addDragPoint(drag, x, y) {
  const previousPoint = drag.points.at(-1);

  if (!previousPoint) {
    drag.points.push({ x, y });
    return;
  }

  const distance = Math.hypot(x - previousPoint.x, y - previousPoint.y);

  if (distance < 2) return;

  const steps = Math.max(1, Math.ceil(distance / 6));

  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps;

    drag.points.push({
      x: previousPoint.x + (x - previousPoint.x) * ratio,
      y: previousPoint.y + (y - previousPoint.y) * ratio,
    });
  }
}

function finishDragSelection(event) {
  if (!dragSelection) return false;

  updateDragSelection(event);

  const drag = dragSelection;
  dragSelection = null;

  if (!drag.moved) return false;

  const nextGroup = getDragSelectionWords(drag);
  const nextGroups = drag.isExtending ? [...drag.baseGroups, nextGroup] : [nextGroup];
  const text = getGroupsText(nextGroups);

  window.getSelection()?.removeAllRanges();

  if (!text || text === lastSelection) return true;

  selectWordGroups(nextGroups, text);
  return true;
}

function previewDragSelection(drag) {
  const nextGroup = getDragSelectionWords(drag);
  const nextGroups = drag.isExtending ? [...drag.baseGroups, nextGroup] : [nextGroup];

  if (!nextGroup.length) return;

  applySelectionPreview(nextGroups);
  window.getSelection()?.removeAllRanges();
}

function getDragSelectionWords(drag) {
  const focusedWord = drag.focusWord || getWordsInDragPath(drag).at(-1) || drag.word;
  const rangeWords = getWordRange(drag.word, focusedWord);

  return drag.isExtending ? rangeWords : limitWordsToOneSentence(rangeWords, drag.word);
}

function getAllWordTokens() {
  return Array.from(pdfPages.querySelectorAll(".word-token"));
}

function assignSentenceIndices() {
  let sentenceIndex = 0;

  getAllWordTokens().forEach((word, tokenIndex) => {
    word.dataset.tokenIndex = String(tokenIndex);
    word.dataset.sentenceIndex = String(sentenceIndex);

    if (/[.!?][)"'\]]*$/.test(word.dataset.word || "")) {
      sentenceIndex += 1;
    }
  });
}

function splitSentences(text) {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"([])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalizeText(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

function findSelectionContext(selection) {
  const selected = normalizeText(selection);
  const sentences = splitSentences(documentText);
  const loweredSelected = selected.toLowerCase();
  let currentIndex = sentences.findIndex((sentence) =>
    sentence.toLowerCase().includes(loweredSelected),
  );

  if (currentIndex < 0) {
    currentIndex = sentences.findIndex((sentence) =>
      loweredSelected.includes(sentence.toLowerCase()),
    );
  }

  return {
    previousSentence: currentIndex > 0 ? sentences[currentIndex - 1] : "",
    currentSentence: currentIndex >= 0 ? sentences[currentIndex] : selected,
    nextSentence:
      currentIndex >= 0 && currentIndex < sentences.length - 1
        ? sentences[currentIndex + 1]
        : "",
  };
}

async function extractDocumentText(pdf) {
  const pageTexts = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    pageTexts.push(textContent.items.map((item) => item.str).join(" "));
  }

  return normalizeText(pageTexts.join(" "));
}

function getTextGeometry(item, viewport) {
  const transform = pdfjs.Util.transform(viewport.transform, item.transform);
  const angle = Math.atan2(transform[1], transform[0]);
  const fontHeight = Math.hypot(transform[2], transform[3]);

  return {
    angle,
    fontHeight,
    left: transform[4],
    top: transform[5] - fontHeight,
    width: Math.max(item.width * viewport.scale, 1),
  };
}

function measureWords(itemText, fontSize, fontFamily) {
  const canvas = measureWords.canvas || document.createElement("canvas");
  const context = canvas.getContext("2d");
  const words = [];
  const wordPattern = /\S+/g;
  let match;

  measureWords.canvas = canvas;
  context.font = `${fontSize}px ${fontFamily}`;

  const fullWidth = Math.max(context.measureText(itemText).width, 1);

  while ((match = wordPattern.exec(itemText)) !== null) {
    const word = match[0];
    const prefix = itemText.slice(0, match.index);
    const prefixWidth = context.measureText(prefix).width;
    const wordWidth = context.measureText(word).width;

    words.push({
      text: word,
      startRatio: prefixWidth / fullWidth,
      widthRatio: Math.max(wordWidth / fullWidth, 0.01),
    });
  }

  return words;
}

function renderWordTextLayer(textContent, viewport, container) {
  const fragment = document.createDocumentFragment();

  textContent.items.forEach((item, itemIndex) => {
    const itemText = item.str || "";

    if (!itemText.trim()) return;

    const style = textContent.styles[item.fontName] || {};
    const geometry = getTextGeometry(item, viewport);
    const fontFamily = style.fontFamily || "sans-serif";
    const words = measureWords(itemText, geometry.fontHeight, fontFamily);

    words.forEach((word, wordIndex) => {
      const span = document.createElement("span");
      const left = geometry.left + geometry.width * word.startRatio;
      const width = Math.max(geometry.width * word.widthRatio, 2);

      span.className = "word-token";
      span.textContent = word.text;
      span.dataset.word = word.text;
      span.dataset.itemIndex = String(itemIndex);
      span.dataset.wordIndex = String(wordIndex);
      span.style.left = `${left}px`;
      span.style.top = `${geometry.top}px`;
      span.style.width = `${width}px`;
      span.style.height = `${geometry.fontHeight}px`;
      span.style.fontSize = `${geometry.fontHeight}px`;
      span.style.fontFamily = fontFamily;

      if (geometry.angle) {
        span.style.transform = `rotate(${geometry.angle}rad)`;
      }

      fragment.append(span);
    });
  });

  container.replaceChildren(fragment);
}

async function renderPage(pdf, pageNumber, taskId) {
  const page = await pdf.getPage(pageNumber);
  if (taskId !== renderTaskId) return;

  const viewport = page.getViewport({ scale: getScale() });
  const pageShell = document.createElement("section");
  const canvas = document.createElement("canvas");
  const textLayer = document.createElement("div");
  const context = canvas.getContext("2d");
  const deviceScale = window.devicePixelRatio || 1;

  pageShell.className = "pdf-page";
  pageShell.dataset.pageNumber = String(pageNumber);
  pageShell.style.width = `${viewport.width}px`;
  pageShell.style.height = `${viewport.height}px`;

  canvas.width = Math.floor(viewport.width * deviceScale);
  canvas.height = Math.floor(viewport.height * deviceScale);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  textLayer.className = "textLayer";
  textLayer.dataset.pageNumber = String(pageNumber);
  textLayer.style.setProperty("--scale-factor", viewport.scale);

  pageShell.append(canvas, textLayer);
  pdfPages.append(pageShell);

  await page.render({
    canvasContext: context,
    viewport,
    transform: deviceScale === 1 ? null : [deviceScale, 0, 0, deviceScale, 0, 0],
  }).promise;

  const textContent = await page.getTextContent();
  if (taskId !== renderTaskId) return;

  renderWordTextLayer(textContent, viewport, textLayer);
}

async function renderPdf({ preservePage = false } = {}) {
  if (!currentPdf) return;

  const pageToRestore = preservePage ? getVisiblePageNumber() : null;
  const taskId = ++renderTaskId;
  clearWordMarkers();
  clearPages();
  viewState.textContent = "렌더링 중";

  for (let pageNumber = 1; pageNumber <= currentPdf.numPages; pageNumber += 1) {
    await renderPage(currentPdf, pageNumber, taskId);
  }

  if (taskId === renderTaskId) {
    assignSentenceIndices();
    viewState.textContent = "열림";
    if (pageToRestore) {
      scrollToPageNumber(pageToRestore);
    }
  }
}

async function openPdf(file) {
  if (!file) return;

  if (!pdfjs) {
    viewState.textContent = "PDF.js를 불러올 수 없습니다.";
    return;
  }

  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    viewState.textContent = "PDF 파일만 열 수 있습니다.";
    return;
  }

  clearViewer(false);
  pageInput.value = "1";
  await restoreZoom();
  viewState.textContent = "불러오는 중";

  try {
    const arrayBuffer = await file.arrayBuffer();
    await openPdfData({
      name: file.name,
      size: file.size,
      arrayBuffer,
    });
  } catch (error) {
    console.error(error);
    viewState.textContent = "PDF를 열 수 없습니다.";
    setControlsEnabled(false);
  }
}

async function openPdfData({ name, size, arrayBuffer }) {
  currentPdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  currentFileName = name;
  currentFileSize = size || 0;
  documentText = await extractDocumentText(currentPdf);

  fileName.textContent = name;
  docTitle.textContent = name;
  docInfoButton.disabled = false;
  fileSize.textContent = formatBytes(size);
  pageCount.textContent = `${currentPdf.numPages}쪽`;
  pageInput.max = String(currentPdf.numPages);
  viewerFrame.classList.add("has-file");
  setControlsEnabled(true);
  await renderPdf();
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

async function openNativePdfPayload(payload) {
  if (!payload) return;

  clearViewer(false);
  pageInput.value = "1";
  await restoreZoom();
  viewState.textContent = "불러오는 중";

  try {
    await openPdfData({
      name: payload.name,
      size: payload.size,
      arrayBuffer: base64ToArrayBuffer(payload.data),
    });
    loadRecentFiles();
  } catch (error) {
    console.error(error);
    viewState.textContent = "PDF를 열 수 없습니다.";
    setControlsEnabled(false);
  }
}

async function choosePdf() {
  if (!nativeApi) {
    fileInput.click();
    return;
  }

  const payload = await nativeApi.choosePdf();
  openNativePdfPayload(payload);
}

async function loadRecentFiles() {
  if (!nativeApi) return;

  try {
    const files = await nativeApi.getRecentFiles();
    renderRecentFiles(files);
  } catch (error) {
    console.error(error);
  }
}

function renderRecentFiles(files) {
  recentFilesList.replaceChildren();
  recentFilesPanel.hidden = !files.length;

  files.forEach((file) => {
    const button = document.createElement("button");
    const name = document.createElement("span");
    const meta = document.createElement("span");

    button.type = "button";
    button.className = "recent-file-button";
    name.className = "recent-file-name";
    meta.className = "recent-file-meta";
    name.textContent = file.name;
    meta.textContent = formatBytes(file.size);

    button.append(name, meta);
    button.addEventListener("click", async () => {
      try {
        const payload = await nativeApi.openRecentFile(file.path);
        openNativePdfPayload(payload);
      } catch (error) {
        console.error(error);
        loadRecentFiles();
      }
    });

    recentFilesList.append(button);
  });
}

function clearViewer(resetInput = true) {
  renderTaskId += 1;
  currentPdf = null;
  currentFileName = "";
  currentFileSize = 0;
  documentText = "";
  lastSelection = "";
  clearWordMarkers();
  clearPages();
  if (resetInput) {
    fileInput.value = "";
  }
  fileName.textContent = "아직 열지 않음";
  docTitle.textContent = "문서 없음";
  docInfoButton.disabled = true;
  hideDocInfo();
  fileSize.textContent = "-";
  pageCount.textContent = "-";
  viewState.textContent = "대기 중";
  pageInput.value = "1";
  pageInput.removeAttribute("max");
  setPopoverPinned(false);
  restoreZoom();
  viewerFrame.classList.remove("has-file");
  setControlsEnabled(false);
}

function scrollToPage() {
  if (!currentPdf) return;

  const requestedPage = Math.min(
    Math.max(Number(pageInput.value) || 1, 1),
    currentPdf.numPages,
  );

  scrollToPageNumber(requestedPage);
}

function scrollToPageNumber(pageNumber) {
  const requestedPage = Math.min(Math.max(Number(pageNumber) || 1, 1), currentPdf?.numPages || 1);
  const page = pdfPages.querySelector(`[data-page-number="${requestedPage}"]`);

  pageInput.value = String(requestedPage);
  page?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function getVisiblePageNumber() {
  const pages = Array.from(pdfPages.querySelectorAll(".pdf-page"));
  const frameRect = pdfPages.getBoundingClientRect();
  const targetY = frameRect.top + Math.min(frameRect.height * 0.25, 180);
  let closestPage = pages[0];
  let closestDistance = Number.POSITIVE_INFINITY;

  pages.forEach((page) => {
    const rect = page.getBoundingClientRect();
    const distance = Math.abs(rect.top - targetY);

    if (rect.top <= targetY && rect.bottom >= frameRect.top && distance < closestDistance) {
      closestPage = page;
      closestDistance = distance;
    }
  });

  return Number(closestPage?.dataset.pageNumber || pageInput.value || 1);
}

function handleViewerZoomGesture(event) {
  if (!currentPdf || zoomSelect.disabled || (!event.ctrlKey && !event.metaKey)) return;

  event.preventDefault();

  const now = Date.now();

  if (now - lastGestureZoomAt < 180) return;

  lastGestureZoomAt = now;
  stepZoom(event.deltaY < 0 ? 1 : -1);
}

async function requestTranslation(text) {
  if (!text) return;

  if (activeTranslationController) {
    activeTranslationController.abort();
  }

  const translationId = ++activeTranslationId;
  activeTranslationController = new AbortController();
  const context = findSelectionContext(text);

  try {
    const translatedText = await requestServerTranslation(
      text,
      context,
      activeTranslationController.signal,
    );

    if (translationId !== activeTranslationId) return;

    const resultText = translatedText || "번역 결과가 비어 있습니다.";

    setPopoverState(text, resultText, "done");
    saveHistoryEntry(text, resultText);
  } catch (error) {
    if (error.name === "AbortError") return;

    console.error(error);
    if (translationId !== activeTranslationId) return;

    setPopoverState(text, "번역 서버 요청에 실패했습니다.", "error");
  } finally {
    if (translationId === activeTranslationId) {
      activeTranslationController = null;
    }
  }
}

async function requestServerTranslation(text, context, signal) {
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      fileName: currentFileName,
      ...context,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.translatedText;
}

function captureSelection(event) {
  if (finishDragSelection(event)) return;

  if (suppressNextSelectionCapture) {
    suppressNextSelectionCapture = false;
    window.getSelection()?.removeAllRanges();
    return;
  }

  const selection = window.getSelection();
  const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;

  if (!selection || selection.isCollapsed || !range) return;

  const anchor = selection.anchorNode?.parentElement;
  const focus = selection.focusNode?.parentElement;
  const isPdfSelection = anchor?.closest("#pdfPages") || focus?.closest("#pdfPages");

  if (!isPdfSelection) return;

  const words = getWordsInRange(range);
  const isExtending = Boolean(event?.shiftKey && selectedWordElements.length);
  const currentGroup = isExtending ? words : limitWordsToOneSentence(words, getFocusedWord(selection));
  const nextGroups = isExtending ? [...selectedWordGroups, currentGroup] : [currentGroup];
  const text = getGroupsText(nextGroups);

  if (!text || text === lastSelection) return;

  selection.removeAllRanges();
  selectWordGroups(nextGroups, text);
}

function selectSingleWord(word) {
  if (!word) return;

  const text = word.dataset.word || word.textContent.trim();

  if (!text) return;

  selectWordGroup([word], text);
}

function selectSentenceForWord(word) {
  const sentenceWords = getSentenceWords(word);
  const text = getWordsText(sentenceWords);

  if (!text) return;

  selectWordGroup(sentenceWords, text);
}

function selectWordGroup(words, text = getWordsText(words)) {
  selectWordGroups([words], text);
}

function selectWordGroups(groups, text = getGroupsText(groups)) {
  const normalizedGroups = normalizeWordGroups(groups);
  const flattenedWords = flattenWordGroups(normalizedGroups);

  if (!flattenedWords.length || !text) return;

  activeTranslationId += 1;
  clearWordMarkers();
  selectedWordGroups = normalizedGroups;
  selectedWordElements = flattenedWords;
  selectedWordElements.forEach((selectedWord) => selectedWord.classList.add("is-selected"));
  renderSelectionHighlights(selectedWordGroups);
  lastSingleWordElement = flattenedWords.length === 1 ? flattenedWords[0] : null;
  window.getSelection()?.removeAllRanges();
  lastSelection = text;
  showPopoverForWords(flattenedWords, text);
  requestTranslation(text);
}

function renderSelectionHighlights(groups) {
  clearSelectionHighlights();

  normalizeWordGroups(groups).forEach((words) => renderSelectionGroupHighlight(words));
}

function renderSelectionGroupHighlight(words) {
  const layers = new Map();

  words.forEach((word) => {
    const layer = word.closest(".textLayer");

    if (!layer) return;

    if (!layers.has(layer)) {
      layers.set(layer, []);
    }

    const left = Number.parseFloat(word.style.left) || word.offsetLeft;
    const top = Number.parseFloat(word.style.top) || word.offsetTop;
    const width = Number.parseFloat(word.style.width) || word.offsetWidth;
    const height = Number.parseFloat(word.style.height) || word.offsetHeight;

    layers.get(layer).push({
      left,
      top,
      right: left + width,
      bottom: top + height,
      height,
      centerY: top + height / 2,
      tokenIndex: getTokenIndex(word),
    });
  });

  layers.forEach((boxes, layer) => {
    const lineGroups = groupHighlightBoxes(boxes);
    const layerWidth = layer.clientWidth;
    const layerHeight = layer.clientHeight;

    lineGroups.forEach((group) => {
      const left = Math.max(Math.min(...group.map((box) => box.left)) - 5, 0);
      const right = Math.min(Math.max(...group.map((box) => box.right)) + 5, layerWidth);
      const top = Math.min(...group.map((box) => box.top));
      const height = Math.max(...group.map((box) => box.height));
      const highlight = document.createElement("div");
      const highlightTop = Math.min(top + height * 0.3, layerHeight - 1);
      const highlightHeight = Math.min(Math.max(height * 0.95, 9), layerHeight - highlightTop);

      highlight.className = "selection-highlight";
      highlight.style.left = `${left}px`;
      highlight.style.top = `${highlightTop}px`;
      highlight.style.width = `${Math.max(right - left, 2)}px`;
      highlight.style.height = `${Math.max(highlightHeight, 1)}px`;

      layer.prepend(highlight);
      selectionHighlightElements.push(highlight);
    });
  });
}

function applySelectionPreview(groups) {
  const normalizedGroups = normalizeWordGroups(groups);
  const flattenedWords = flattenWordGroups(normalizedGroups);

  selectedWordElements.forEach((word) => word.classList.remove("is-selected"));
  selectedWordGroups = normalizedGroups;
  selectedWordElements = flattenedWords;
  selectedWordElements.forEach((word) => word.classList.add("is-selected"));
  renderSelectionHighlights(selectedWordGroups);
}

function groupHighlightBoxes(boxes) {
  const sortedBoxes = [...boxes].sort((a, b) => a.tokenIndex - b.tokenIndex);
  const groups = [];

  sortedBoxes.forEach((box) => {
    const previousGroup = groups.at(-1);
    const previousBox = previousGroup?.at(-1);
    const sameLine =
      previousBox &&
      Math.abs(box.centerY - previousBox.centerY) <= Math.max(box.height, previousBox.height) * 0.7;
    const wordGap = previousBox ? box.left - previousBox.right : 0;
    const gapLimit = Math.max(32, Math.max(box.height, previousBox?.height || 0) * 2.2);

    if (!previousGroup || !sameLine || wordGap > gapLimit) {
      groups.push([box]);
      return;
    }

    previousGroup.push(box);
  });

  return groups;
}

function getWordsText(words) {
  return words.map((word) => word.dataset.word).join(" ").trim();
}

function getGroupsText(groups) {
  return normalizeWordGroups(groups).map((group) => getWordsText(group)).filter(Boolean).join(" ");
}

function cloneWordGroups(groups) {
  return groups.map((group) => [...group]);
}

function normalizeWordGroups(groups) {
  return groups
    .map((group) =>
      Array.from(new Set(group)).sort((a, b) => getTokenIndex(a) - getTokenIndex(b)),
    )
    .filter((group) => group.length)
    .sort((a, b) => getTokenIndex(a[0]) - getTokenIndex(b[0]));
}

function flattenWordGroups(groups) {
  return Array.from(new Set(normalizeWordGroups(groups).flat())).sort(
    (a, b) => getTokenIndex(a) - getTokenIndex(b),
  );
}

function getTokenIndex(word) {
  return Number(word.dataset.tokenIndex || 0);
}

function mergeWordGroups(currentWords, newWords) {
  return Array.from(new Set([...currentWords, ...newWords])).sort(
    (a, b) => getTokenIndex(a) - getTokenIndex(b),
  );
}

function getWordRange(startWord, endWord) {
  if (!startWord || !endWord) return startWord ? [startWord] : [];

  const startIndex = getTokenIndex(startWord);
  const endIndex = getTokenIndex(endWord);
  const minIndex = Math.min(startIndex, endIndex);
  const maxIndex = Math.max(startIndex, endIndex);

  return getAllWordTokens().filter((word) => {
    const tokenIndex = getTokenIndex(word);

    return tokenIndex >= minIndex && tokenIndex <= maxIndex;
  });
}

function getSentenceWords(word) {
  const sentenceIndex = word?.dataset.sentenceIndex;

  if (sentenceIndex == null) return word ? [word] : [];

  return getAllWordTokens().filter((token) => token.dataset.sentenceIndex === sentenceIndex);
}

function getFocusedWord(selection) {
  const focusElement = selection.focusNode?.nodeType === Node.TEXT_NODE
    ? selection.focusNode.parentElement
    : selection.focusNode;

  return focusElement?.closest?.(".word-token") || null;
}

function limitWordsToOneSentence(words, preferredWord) {
  if (!words.length) return [];

  const sentenceIndex = preferredWord?.dataset.sentenceIndex || words.at(-1)?.dataset.sentenceIndex;

  if (sentenceIndex == null) return words;

  return words.filter((word) => word.dataset.sentenceIndex === sentenceIndex);
}

function limitWordsToExistingSentence(words) {
  if (!words.length) return [];

  return limitWordsToSentence(words, selectedWordElements[0]);
}

function limitWordsToSentence(words, sentenceWord) {
  if (!words.length) return [];

  const sentenceIndex = sentenceWord?.dataset.sentenceIndex;

  if (sentenceIndex == null) return words;

  return words.filter((word) => word.dataset.sentenceIndex === sentenceIndex);
}

function getWordsInRange(range) {
  const selectionRects = Array.from(range.getClientRects());

  if (!selectionRects.length) return [];

  return getAllWordTokens().filter((word) => {
    const wordRect = word.getBoundingClientRect();

    return selectionRects.some((selectionRect) => rectsOverlap(wordRect, selectionRect));
  });
}

function getWordsInDragPath(drag) {
  const hitPaddingX = 8;
  const hitPaddingY = 9;
  const points = drag.points.length ? drag.points : [{ x: drag.startX, y: drag.startY }];

  return getAllWordTokens().filter((word) => {
    const wordRect = expandRect(word.getBoundingClientRect(), hitPaddingX, hitPaddingY);

    return points.some((point) => pointInRect(point, wordRect));
  });
}

function expandRect(rect, paddingX, paddingY) {
  return {
    left: rect.left - paddingX,
    right: rect.right + paddingX,
    top: rect.top - paddingY,
    bottom: rect.bottom + paddingY,
  };
}

function pointInRect(point, rect) {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

function rectsOverlap(a, b) {
  const verticalOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const horizontalOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);

  return verticalOverlap > 1 && horizontalOverlap > 1;
}

openButton.addEventListener("click", choosePdf);
historyButton.addEventListener("click", toggleHistoryPanel);
closeHistoryButton.addEventListener("click", () => {
  historyPanel.hidden = true;
});
historyFileSelect.addEventListener("change", () => {
  renderHistoryPanel(historyFileSelect.value);
});

fileInput.addEventListener("change", (event) => {
  openPdf(event.target.files[0]);
});

clearButton.addEventListener("click", () => clearViewer());

goPageButton.addEventListener("click", scrollToPage);
zoomSelect.addEventListener("change", () => {
  persistZoom();
  renderPdf({ preservePage: true });
});

pageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    scrollToPage();
  }
});

closePopoverButton.addEventListener("click", hidePopover);
unpinPopoverButton.addEventListener("click", unpinPopover);
docInfoButton.addEventListener("click", toggleDocInfo);
popoverHead.addEventListener("pointerdown", startPopoverDrag);
popoverHead.addEventListener("pointermove", updatePopoverDrag);
popoverHead.addEventListener("pointerup", finishPopoverDrag);
popoverHead.addEventListener("pointercancel", finishPopoverDrag);

pdfPages.addEventListener("mousedown", (event) => {
  const word = event.target.closest(".word-token");
  const isExtending = Boolean(event.shiftKey && selectedWordElements.length);

  if (word && event.detail >= 3) {
    suppressNextSelectionCapture = true;
    event.preventDefault();
    event.stopPropagation();
    dragSelection = null;

    if (isExtending) {
      cancelActiveTranslation();
      selectWordGroups([...selectedWordGroups, getSentenceWords(word)]);
    } else {
      clearActiveSelection({ rememberSingleWord: false });
      selectSentenceForWord(word);
    }
    return;
  }

  if (isExtending) {
    cancelActiveTranslation();
    hidePopover();
  } else if (word || event.target.closest("#pdfPages")) {
    clearActiveSelection({ rememberSingleWord: word === lastSingleWordElement });
  }

  if (event.detail >= 2 && word) {
    suppressNextSelectionCapture = true;
    event.preventDefault();
  }

  if (word) {
    startDragSelection(event, word, isExtending);
    event.preventDefault();
  }
});

pdfPages.addEventListener("mousemove", updateDragSelection);
pdfPages.addEventListener("wheel", handleViewerZoomGesture, { passive: false });

pdfPages.addEventListener("dblclick", (event) => {
  const word = event.target.closest(".word-token");

  if (!word) return;

  event.preventDefault();
  event.stopPropagation();
  suppressNextSelectionCapture = false;

  if (event.shiftKey && selectedWordElements.length) {
    const nextGroups = [...selectedWordGroups, [word]];
    const text = getGroupsText(nextGroups);

    if (text) {
      selectWordGroups(nextGroups, text);
    }

    return;
  }

  selectSingleWord(word);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("click", (event) => {
  if (!nativeApi) return;

  event.preventDefault();
  choosePdf();
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragging");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  openPdf(event.dataTransfer.files[0]);
});

document.addEventListener("mouseup", captureSelection);
document.addEventListener("mousemove", updateDragSelection);
document.addEventListener("keyup", captureSelection);
pdfPages.addEventListener("scroll", () => {
  if (translationPopover.classList.contains("is-visible") && selectedWordElements.length) {
    positionPopover(selectedWordElements);
  }
});
window.addEventListener("resize", () => {
  syncToolbarHeight();

  if (translationPopover.classList.contains("is-visible") && selectedWordElements.length) {
    positionPopover(selectedWordElements);
  }
});

document.addEventListener("click", (event) => {
  const clickedDocInfo =
    docInfoButton.contains(event.target) || docInfoPopover.contains(event.target);

  if (!clickedDocInfo) {
    hideDocInfo();
  }
});
