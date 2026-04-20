const fileInput = document.querySelector("#fileInput");
const toolbar = document.querySelector(".toolbar");
const openButton = document.querySelector("#openButton");
const clearButton = document.querySelector("#clearButton");
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
const closePopoverButton = document.querySelector("#closePopoverButton");
const popoverSelection = document.querySelector("#popoverSelection");
const popoverBody = document.querySelector("#popoverBody");
const recentFilesPanel = document.querySelector("#recentFilesPanel");
const recentFilesList = document.querySelector("#recentFilesList");

const pdfjs = window.pdfjsLib;
const zoomStorageKey = "paperReader.zoom";
const nativeApi = window.paperReaderNative;

if (pdfjs) {
  pdfjs.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
} else {
  viewState.textContent = "PDF.js를 불러올 수 없습니다.";
}

let currentPdf = null;
let currentFileName = "";
let documentText = "";
let renderTaskId = 0;
let lastSelection = "";
let selectedWordElements = [];
let activeTranslationId = 0;
let suppressNextSelectionCapture = false;
let activeTranslationController = null;
let lastSingleWordElement = null;

restoreZoom();
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

function setPopoverState(selectionText, message, state = "loading") {
  popoverSelection.textContent = selectionText;
  popoverBody.textContent = message;
  translationPopover.dataset.state = state;
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

function restoreZoom() {
  const savedZoom = localStorage.getItem(zoomStorageKey);

  if (!savedZoom) return;

  const hasOption = Array.from(zoomSelect.options).some((option) => option.value === savedZoom);

  if (hasOption) {
    zoomSelect.value = savedZoom;
  }
}

function persistZoom() {
  localStorage.setItem(zoomStorageKey, zoomSelect.value);
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
  hidePopover();
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

function getAllWordTokens() {
  return Array.from(pdfPages.querySelectorAll(".word-token"));
}

function assignSentenceIndices() {
  let sentenceIndex = 0;

  getAllWordTokens().forEach((word) => {
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

async function renderPdf() {
  if (!currentPdf) return;

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
  restoreZoom();
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
  restoreZoom();
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
  const page = pdfPages.querySelector(`[data-page-number="${requestedPage}"]`);

  pageInput.value = String(requestedPage);
  page?.scrollIntoView({ block: "start", behavior: "smooth" });
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

    setPopoverState(text, translatedText || "번역 결과가 비어 있습니다.", "done");
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

function captureSelection() {
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
  const limitedWords = limitWordsToOneSentence(words, getFocusedWord(selection));
  const text = getWordsText(limitedWords);

  if (!text || text === lastSelection) return;

  selection.removeAllRanges();
  selectWordGroup(limitedWords, text);
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
  if (!words.length || !text) return;

  activeTranslationId += 1;
  clearWordMarkers();
  selectedWordElements = words;
  selectedWordElements.forEach((selectedWord) => selectedWord.classList.add("is-selected"));
  lastSingleWordElement = selectedWordElements.length === 1 ? selectedWordElements[0] : null;
  window.getSelection()?.removeAllRanges();
  lastSelection = text;
  showPopoverForWords(selectedWordElements, text);
  requestTranslation(text);
}

function getWordsText(words) {
  return words.map((word) => word.dataset.word).join(" ").trim();
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

function getWordsInRange(range) {
  const selectionRects = Array.from(range.getClientRects());

  if (!selectionRects.length) return [];

  return getAllWordTokens().filter((word) => {
    const wordRect = word.getBoundingClientRect();

    return selectionRects.some((selectionRect) => rectsOverlap(wordRect, selectionRect));
  });
}

function rectsOverlap(a, b) {
  const verticalOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const horizontalOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);

  return verticalOverlap > 1 && horizontalOverlap > 1;
}

openButton.addEventListener("click", choosePdf);

fileInput.addEventListener("change", (event) => {
  openPdf(event.target.files[0]);
});

clearButton.addEventListener("click", () => clearViewer());

goPageButton.addEventListener("click", scrollToPage);
zoomSelect.addEventListener("change", () => {
  persistZoom();
  renderPdf();
});

pageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    scrollToPage();
  }
});

closePopoverButton.addEventListener("click", hidePopover);
docInfoButton.addEventListener("click", toggleDocInfo);

pdfPages.addEventListener("mousedown", (event) => {
  const word = event.target.closest(".word-token");

  if (word) {
    clearActiveSelection({ rememberSingleWord: word === lastSingleWordElement });
  }

  if (event.detail >= 2 && word) {
    suppressNextSelectionCapture = true;
    event.preventDefault();
  }
});

pdfPages.addEventListener("dblclick", (event) => {
  const word = event.target.closest(".word-token");

  if (!word) return;

  event.preventDefault();
  event.stopPropagation();
  suppressNextSelectionCapture = false;

  if (lastSingleWordElement === word) {
    selectSentenceForWord(word);
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
