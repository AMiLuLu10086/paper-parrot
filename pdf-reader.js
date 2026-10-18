/**
 * Chrome / Edge 共用 chrome.* API，无 webextension-polyfill，不兼容 Firefox。
 * PDF.js、worker 和解码资源均随扩展打包；本地文件只在本机解析，不上传 PDF。
 * 仅主动选中文字按自定义快捷键时调用现有后台翻译；扫描版 OCR 和 PDF 脚本不执行。
 */
const elements = Object.fromEntries([
  "open-file", "file-input", "document-name",
  "previous-page", "next-page", "page-number", "page-count", "zoom-out", "zoom-in",
  "zoom-value", "fit-width", "reader-status", "empty-state", "viewer-container", "pdf-viewer", "drop-overlay",
].map((id) => [id, document.getElementById(id)]));

let viewer;
let linkService;
let loadingTask = null;
let pdfDocument = null;
let documentEpoch = 0;
let pdfjs;
const pageTextStates = new Map();
const navigationIds = ["previous-page", "next-page", "page-number", "zoom-out", "zoom-in", "fit-width"];

function showStatus(message, state = "ready") {
  elements["reader-status"].textContent = message;
  elements["reader-status"].dataset.state = state;
}

function updateNavigation() {
  const ready = Boolean(pdfDocument && viewer?.pagesCount);
  for (const id of navigationIds) elements[id].disabled = !ready;
  const page = ready ? viewer.currentPageNumber : 1;
  elements["page-number"].value = String(page);
  elements["page-number"].max = String(pdfDocument?.numPages ?? 1);
  elements["page-count"].textContent = `/ ${pdfDocument?.numPages ?? 0}`;
  elements["previous-page"].disabled = !ready || page <= 1;
  elements["next-page"].disabled = !ready || page >= pdfDocument.numPages;
  elements["zoom-value"].textContent = `${Math.round((viewer?.currentScale || 1) * 100)}%`;
}

function showPageHint() {
  if (!pdfDocument) return;
  const textState = pageTextStates.get(viewer.currentPageNumber);
  if (textState === "error") {
    showStatus("当前页文字层加载失败，请重新打开文件或尝试其他 PDF。", "error");
  } else if (textState === "empty") {
    showStatus("当前页未检测到文字层，可能是扫描页，需要 OCR；本次暂不支持。", "warning");
  } else {
    showStatus(textState === "text" ? `选中英文，按 ${globalThis.PaperParrotShortcuts.label()} 翻译。` : "正在准备当前页文字层…", textState === "text" ? "ready" : "loading");
  }
}

function resetSelection() {
  window.getSelection()?.removeAllRanges();
}

function pdfErrorMessage(error) {
  if (error?.name === "PasswordException") return "此 PDF 需要密码，本次暂不支持。请打开不带密码保护的文献。";
  if (error?.name === "InvalidPDFException") return "文件无法解析为 PDF，可能已损坏或格式不正确。请重新选择 PDF 文件。";
  return "PDF 文件加载失败，请检查文件是否完整，然后重新选择。";
}

async function openDocument(makeSource, label) {
  const epoch = ++documentEpoch;
  const previousTask = loadingTask;
  loadingTask = null;
  pdfDocument = null;
  pageTextStates.clear();
  resetSelection();
  // 只有切换文献才关闭译文；缩放只清空失效的原文选区，保留浮窗与进行中的请求。
  document.dispatchEvent(new Event("literature-document-reset"));
  viewer.setDocument(null);
  linkService.setDocument(null);
  updateNavigation();
  elements["empty-state"].hidden = true;
  elements["document-name"].textContent = label;
  elements["document-name"].title = label;
  showStatus("正在加载 PDF，请稍候…", "loading");
  let task;
  let timedOut = false;
  let timer;
  try {
    // destroy 同时释放旧 worker、网络和页面缓存。新选择优先于旧文件的异步读取。
    if (previousTask) await previousTask.destroy();
    if (epoch !== documentEpoch) return;
    const source = await makeSource();
    if (epoch !== documentEpoch) return;
    task = pdfjs.getDocument({
      ...source,
      cMapUrl: chrome.runtime.getURL("vendor/pdfjs/cmaps/"), cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL("vendor/pdfjs/standard_fonts/"),
      wasmUrl: chrome.runtime.getURL("vendor/pdfjs/wasm/"),
      iccUrl: chrome.runtime.getURL("vendor/pdfjs/iccs/"),
      useWorkerFetch: true, withCredentials: false, enableXfa: false,
    });
    loadingTask = task;
    // 限制文件解析的等待时间，损坏文献也能恢复到选择文件状态。
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("PDF load timed out"));
      }, 60000);
    });
    const loaded = await Promise.race([task.promise, timeout]);
    clearTimeout(timer);
    if (epoch !== documentEpoch) { await task.destroy(); return; }
    await loaded.getPage(1); // 在绑定阅读器前捕获首页面解析错误，避免组件等待不结束。
    if (epoch !== documentEpoch) { await task.destroy(); return; }
    pdfDocument = loaded;
    linkService.setDocument(loaded);
    viewer.setDocument(loaded);
    await viewer.firstPagePromise;
    if (epoch === documentEpoch) updateNavigation();
  } catch (error) {
    if (epoch !== documentEpoch) return;
    pdfDocument = null;
    loadingTask = null;
    viewer.setDocument(null);
    linkService.setDocument(null);
    updateNavigation();
    elements["empty-state"].hidden = false;
    showStatus(timedOut ? "PDF 加载等待超过 60 秒，请检查文件后重新打开。" : pdfErrorMessage(error), "error");
    // 捕获清理异常，不向界面或控制台输出原始错误。
    if (task) await task.destroy().catch(() => undefined);
  } finally { clearTimeout(timer); }
}

function openFile(file) {
  if (!file) return;
  // 扩展名和 MIME 仅用于文件选择提示，最终由 PDF.js 验证实际内容。
  void openDocument(async () => ({ data: new Uint8Array(await file.arrayBuffer()) }), file.name || "本地 PDF");
}

function bindControls() {
  elements["open-file"].addEventListener("click", () => elements["file-input"].click());
  elements["file-input"].addEventListener("change", () => {
    openFile(elements["file-input"].files[0]);
    elements["file-input"].value = ""; // 同一个文件修复后可重新选择。
  });
  elements["previous-page"].addEventListener("click", () => { viewer.currentPageNumber--; });
  elements["next-page"].addEventListener("click", () => { viewer.currentPageNumber++; });
  elements["page-number"].addEventListener("change", () => {
    const requested = Number(elements["page-number"].value);
    if (pdfDocument && Number.isInteger(requested)) viewer.currentPageNumber = Math.max(1, Math.min(pdfDocument.numPages, requested));
    updateNavigation();
  });
  for (const [id, direction] of [["zoom-in", 1], ["zoom-out", -1]]) {
    elements[id].addEventListener("click", () => {
      resetSelection();
      viewer.currentScale = Math.max(0.25, Math.min(4, viewer.currentScale * (direction > 0 ? 1.2 : 1 / 1.2)));
    });
  }
  elements["fit-width"].addEventListener("click", () => { resetSelection(); viewer.currentScaleValue = "page-width"; });
  let dragDepth = 0;
  document.addEventListener("dragenter", (event) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault(); dragDepth++; elements["drop-overlay"].hidden = false;
  });
  document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; elements["drop-overlay"].hidden = true; } });
  document.addEventListener("dragover", (event) => {
    if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }
  });
  document.addEventListener("drop", (event) => {
    event.preventDefault(); dragDepth = 0; elements["drop-overlay"].hidden = true;
    openFile(event.dataTransfer?.files[0]);
  });
  // unload 不再开启网络。浏览器销毁页面时也会销毁 worker；这里尽力主动释放资源。
  window.addEventListener("pagehide", () => { documentEpoch++; void loadingTask?.destroy().catch(() => undefined); });
}

async function initialize() {
  const versionMatch = navigator.userAgent.match(/(?:Chrome|Chromium|Edg)\/(\d+)/u);
  if (!versionMatch || Number(versionMatch[1]) < 125) {
    showStatus("PDF 阅读功能需要 Chrome / Edge 125 或更新版本，请升级浏览器。", "error");
    return;
  }
  try {
    pdfjs = await import("./vendor/pdfjs/build/pdf.mjs");
    // 阅读器模块使用官方全局导出；动态顺序加载避免依赖尚未初始化。
    globalThis.pdfjsLib = pdfjs;
    const { EventBus, PDFViewer, PDFLinkService, ScrollMode } = await import("./vendor/pdfjs/web/pdf_viewer.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/build/pdf.worker.mjs");
    const eventBus = new EventBus();
    linkService = new PDFLinkService({ eventBus });
    viewer = new PDFViewer({
      container: elements["viewer-container"], viewer: elements["pdf-viewer"], eventBus, linkService,
      textLayerMode: 1, annotationMode: pdfjs.AnnotationMode.DISABLE,
      annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
      enableAutoLinking: false, maxCanvasPixels: 16777216,
      // 不创建 PDFScriptingManager，不渲染交互表单或执行嵌入脚本。
    });
    linkService.setViewer(viewer);
    eventBus.on("pagesinit", () => {
      // 原生换行模式随页面尺寸自动增加列数，并保留 PDF.js 的可见页渲染与文字层定位。
      viewer.scrollMode = ScrollMode.WRAPPED;
      viewer.currentScale = 1;
      updateNavigation();
    });
    const resizeObserver = new ResizeObserver(() => {
      if (!pdfDocument) return;
      if (viewer.currentScaleValue === "page-width") viewer.currentScaleValue = "page-width";
      viewer.update();
    });
    resizeObserver.observe(elements["viewer-container"]);
    window.addEventListener("pagehide", () => resizeObserver.disconnect(), { once: true });
    eventBus.on("pagechanging", () => { updateNavigation(); showPageHint(); });
    eventBus.on("scalechanging", updateNavigation);
    eventBus.on("textlayerrendered", async ({ source, pageNumber, error }) => {
      const epoch = documentEpoch;
      if (!pdfDocument || source !== viewer.getPageView(pageNumber - 1)) return;
      try {
        if (error) throw error;
        const content = await source.pdfPage.getTextContent();
        if (epoch !== documentEpoch) return;
        pageTextStates.set(pageNumber, content.items.some((item) => typeof item.str === "string" && item.str.trim()) ? "text" : "empty");
      } catch {
        if (epoch !== documentEpoch) return;
        pageTextStates.set(pageNumber, "error");
      }
      if (pageNumber === viewer.currentPageNumber) showPageHint();
    });
    eventBus.on("pagerendered", ({ source, pageNumber, error }) => {
      if (pdfDocument && source === viewer.getPageView(pageNumber - 1) && error) {
        showStatus("当前页显示失败，请尝试重新打开文件。", "error");
      }
    });
    bindControls();
    elements["open-file"].disabled = false;
    document.documentElement.dataset.readerReady = "true";
    showStatus("打开或拖入本地 PDF · 选中文字即可翻译");
    globalThis.PaperParrotShortcuts.subscribe(showPageHint);
  } catch {
    showStatus("PDF 阅读器初始化失败，请检查 vendor/pdfjs 文件是否完整，并重新加载扩展。", "error");
  }
}

void initialize();
