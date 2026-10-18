"use strict";

/**
 * 全部扩展 API 均为 chrome.*，Chrome / Edge 共用，不使用 polyfill。
 * 支持普通 HTML 及本扩展 PDF 阅读页；不注入浏览器内置 PDF 阅读器或 iframe。
 * Canvas PDF 没有文字层时，window.getSelection() 无法读取原文；扫描 OCR 暂不支持。
 * PDF 阅读页显式加载本脚本，复用网页的可信按键、并发锁及翻译浮窗。
 * 密钥和配置由后台读取，content script 不 fetch 配置，也不直接请求 LLM 接口。
 */

(() => {
  let inProgress = false;
  let currentPanel = null;
  let panelBounds;
  let pluginEnabled = false;
  let stateRevision = 0;
  let requestEpoch = 0;
  let activeRequest;
  let configStatusPromise;
  const PLUGIN_STORAGE_KEY = "literaturePluginEnabledV1";
  const isPdfReader = location.protocol === "chrome-extension:" &&
    location.href.split(/[?#]/u)[0] === chrome.runtime.getURL("pdf-reader.html");

  const COMMUNICATION_ERROR = {
    code: "COMMUNICATION_ERROR",
    message: "扩展通信失效，请刷新当前网页后重试；如仍失败，请重新加载扩展。",
    retryable: false,
  };

  async function sendMessage(message) {
    let response;
    try {
      response = await chrome.runtime.sendMessage(message);
    } catch {
      throw COMMUNICATION_ERROR;
    }
    if (!response || typeof response.ok !== "boolean") throw COMMUNICATION_ERROR;
    if (!response.ok) {
      const error = response.error;
      if (!error || typeof error.message !== "string") throw COMMUNICATION_ERROR;
      throw { code: error.code, message: error.message, retryable: error.retryable === true };
    }
    return response;
  }

  function closePanel() {
    currentPanel?.cleanup();
    currentPanel?.host.remove();
    currentPanel = null;
  }

  function enablePanelMovement(panel, header, shadow) {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const margin = 12;
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
    let gesture;

    function applyBounds(bounds) {
      const maxWidth = Math.max(1, window.innerWidth - margin * 2);
      const maxHeight = Math.max(1, window.innerHeight - margin * 2);
      const width = clamp(bounds.width, Math.min(260, maxWidth), maxWidth);
      const height = clamp(bounds.height, Math.min(200, maxHeight), maxHeight);
      panelBounds = { width, height, left: clamp(bounds.left, margin, window.innerWidth - width - margin),
        top: clamp(bounds.top, margin, window.innerHeight - height - margin) };
      for (const [name, value] of Object.entries(panelBounds)) panel.host.style.setProperty(name, `${value}px`, "important");
    }

    function start(event, direction) {
      if (!event.isTrusted || event.button !== 0 || event.target.closest("button")) return;
      event.preventDefault();
      event.stopPropagation();
      gesture = { direction, x: event.clientX, y: event.clientY, bounds: { ...panelBounds }, pointerId: event.pointerId };
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    header.title = "拖动标题栏移动；拖动边缘或四角调整大小";
    header.addEventListener("pointerdown", (event) => start(event, "move"), options);
    for (const direction of ["n", "ne", "e", "se", "s", "sw", "w", "nw"]) {
      const handle = document.createElement("span");
      handle.className = `resize-handle ${direction}`;
      handle.dataset.direction = direction;
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", (event) => start(event, direction), options);
      shadow.append(handle);
    }
    shadow.addEventListener("pointermove", (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      event.preventDefault();
      const { direction, bounds } = gesture;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      const next = { ...bounds };
      const minWidth = Math.min(260, window.innerWidth - margin * 2);
      const minHeight = Math.min(200, window.innerHeight - margin * 2);
      if (direction === "move") {
        next.left += dx;
        next.top += dy;
      } else {
        if (direction.includes("w")) {
          next.left = clamp(bounds.left + dx, margin, bounds.left + bounds.width - minWidth);
          next.width = bounds.width + bounds.left - next.left;
        }
        if (direction.includes("e")) next.width = clamp(bounds.width + dx, minWidth, window.innerWidth - margin - bounds.left);
        if (direction.includes("n")) {
          next.top = clamp(bounds.top + dy, margin, bounds.top + bounds.height - minHeight);
          next.height = bounds.height + bounds.top - next.top;
        }
        if (direction.includes("s")) next.height = clamp(bounds.height + dy, minHeight, window.innerHeight - margin - bounds.top);
      }
      applyBounds(next);
    }, options);
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      shadow.addEventListener(type, (event) => {
        if (gesture?.pointerId === event.pointerId) gesture = undefined;
      }, options);
    }
    window.addEventListener("resize", () => applyBounds(panelBounds), options);
    applyBounds(panelBounds || { left: window.innerWidth - 436, top: window.innerHeight - 376, width: 420, height: 360 });
    panel.cleanup = () => controller.abort();
  }

  // 仅在本扩展阅读页监听换文档事件；普通网页不能借此隐藏或重置翻译状态。
  // 保持请求锁到原请求结束，关闭浮窗后旧结果不会出现在新文献上。
  if (isPdfReader) document.addEventListener("literature-document-reset", closePanel);

  function makeButton(label, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    // 网页脚本不能通过合成点击偷偷重试付费请求。
    button.addEventListener("click", (event) => {
      if (event.isTrusted) onClick(event);
    });
    return button;
  }

  function createPanel() {
    closePanel();
    const host = document.createElement("div");
    host.id = "literature-translator-panel";
    // 提高普通网页上的叠放层级；浏览器的 top layer 全屏 / modal 不由 z-index 控制。
    host.style.cssText = "all: initial !important; position: fixed !important; z-index: 2147483647 !important; display: block !important;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { color-scheme: light; }
      *, *::before, *::after { box-sizing: border-box; }
      .panel { width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden; background: #ffffff;
        color: #1c1c1e; border: 1px solid rgba(60,60,67,.12);
        border-radius: 20px; box-shadow: 0 16px 48px rgba(0,0,0,.16);
        font: 14px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; text-align: left; }
      .header { display: flex; align-items: center; justify-content: space-between;
        padding: 12px 20px 10px; gap: 12px; flex-shrink: 0; cursor: grab; user-select: none; touch-action: none; }
      .header:active { cursor: grabbing; }
      .title { font-weight: 650; font-size: 16px; letter-spacing: -.02em; }
      button { font: inherit; cursor: pointer; border-radius: 10px; min-height: 36px; }
      button:focus-visible { outline: 2px solid #007aff; outline-offset: 3px; }
      button:disabled { cursor: wait; opacity: .65; }
      .close { border: none; background: #f2f2f7; color: #636366; font-size: 12px; padding: 4px 10px; }
      .close:hover { background: #e5e5ea; }
      .text { padding: 0 20px 14px; min-height: 0; flex: 1; overflow-y: auto;
        white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; cursor: text; }
      .text[data-state="error"] { color: #b42318; }
      .footer { padding: 10px 20px 14px; border-top: 1px solid #e5e5ea; flex-shrink: 0; max-height: 48%; overflow-y: auto; }
      .note { color: #636366; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
      .actions:empty { display: none; }
      .action { padding: 6px 14px; color: #007aff; background: #eef5ff; border: none; }
      .action:hover { background: #dcecff; }
      .resize-handle { position: absolute; z-index: 2; touch-action: none; }
      .n, .s { left: 14px; right: 14px; height: 8px; cursor: ns-resize; }
      .n { top: -3px; } .s { bottom: -3px; }
      .e, .w { top: 14px; bottom: 14px; width: 8px; cursor: ew-resize; }
      .e { right: -3px; } .w { left: -3px; }
      .ne, .nw, .se, .sw { width: 17px; height: 17px; }
      .ne, .nw { top: -3px; } .se, .sw { bottom: -3px; }
      .ne, .se { right: -3px; } .nw, .sw { left: -3px; }
      .nw, .se { cursor: nwse-resize; } .ne, .sw { cursor: nesw-resize; }
      .se::after { content: ""; position: absolute; width: 7px; height: 7px; right: 7px; bottom: 7px;
        border-right: 2px solid #aeaeb2; border-bottom: 2px solid #aeaeb2; border-radius: 0 0 2px 0; }
    `;
    const section = document.createElement("section");
    section.className = "panel";
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", "文献翻译");
    const header = document.createElement("div");
    header.className = "header";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "paper-parrot";
    const closeButton = makeButton("关闭 ×", "close", () => closePanel());
    closeButton.setAttribute("aria-label", "关闭翻译窗口");
    header.append(title, closeButton);
    const text = document.createElement("div");
    text.className = "text";
    text.setAttribute("aria-live", "polite");
    text.setAttribute("aria-atomic", "true");
    const footer = document.createElement("div");
    footer.className = "footer";
    const note = document.createElement("div");
    note.className = "note";
    const actions = document.createElement("div");
    actions.className = "actions";
    footer.append(note, actions);
    section.append(header, text, footer);
    shadow.append(style, section);
    document.documentElement.append(host);
    const panel = { host, section, text, note, actions };
    enablePanelMovement(panel, header, shadow);
    currentPanel = panel;
    return panel;
  }

  function panelVisible(panel) {
    return currentPanel === panel && panel.host.isConnected;
  }

  function showError(panel, error, originalText) {
    panel.text.dataset.state = "error";
    panel.text.textContent = typeof error?.message === "string" ? error.message : "翻译失败，请重新加载扩展并刷新网页。";
    panel.note.textContent = "修改配置后，请先重新加载扩展，再刷新网页。";
    panel.actions.replaceChildren();
    if (error?.retryable && originalText) {
      panel.actions.append(makeButton("重试", "action", () => { void runTranslation(originalText); }));
    }
  }

  function showResult(panel, result) {
    panel.text.dataset.state = "success";
    panel.text.textContent = result.translation;
    panel.note.textContent = result.incomplete
      ? "译文可能不完整：接口达到输出长度上限。本次结果未缓存，请缩短选区后重试。"
      : result.cached ? "来自缓存 · 可选中正文复制 · Esc 关闭" : "可选中正文复制 · Esc 关闭";
    panel.actions.replaceChildren();
    const copyButton = makeButton("复制译文", "action", async () => {
      copyButton.disabled = true;
      try {
        // 安全剪贴板在 HTTP 页面可能不可用，不额外请求权限，不使用废弃复制 API。
        if (!window.isSecureContext || !navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(result.translation);
        if (panelVisible(panel)) copyButton.textContent = "已复制";
      } catch {
        if (panelVisible(panel)) {
          panel.note.textContent = `${result.incomplete ? "译文可能不完整。" : ""}自动复制失败，请选中上方译文手动复制。`;
        }
      } finally {
        copyButton.disabled = false;
      }
    });
    panel.actions.append(copyButton);
  }

  function getConfigStatus() {
    configStatusPromise ??= sendMessage({ type: "GET_CONFIG_STATUS" });
    return configStatusPromise;
  }

  function applyPluginState(enabled) {
    if (pluginEnabled === enabled) return;
    pluginEnabled = enabled;
    requestEpoch++;
    if (!enabled) {
      closePanel();
      activeRequest = undefined;
      inProgress = false;
    } else {
      const epoch = requestEpoch;
      // Configuration failures must never open a panel while disabled or after a stale read.
      void getConfigStatus().catch((error) => {
        if (pluginEnabled && epoch === requestEpoch && !inProgress) showError(createPanel(), error);
      });
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(PLUGIN_STORAGE_KEY in changes)) return;
    stateRevision++;
    applyPluginState(changes[PLUGIN_STORAGE_KEY].newValue !== false);
  });

  const initialRevision = stateRevision;
  void sendMessage({ type: "GET_PLUGIN_STATE" }).then((state) => {
    if (typeof state.enabled !== "boolean") throw COMMUNICATION_ERROR;
    if (initialRevision === stateRevision) applyPluginState(state.enabled);
  }).catch(() => {
    // Keep shortcuts untouched if the initial state cannot be read; the popup explains recovery.
  });

  async function runTranslation(text) {
    if (!pluginEnabled || inProgress) return;
    inProgress = true; // 在首次 await 前同步加锁，长按与快速重复按键均不会重发。
    const token = {};
    const epoch = requestEpoch;
    activeRequest = token;
    const stillCurrent = () => pluginEnabled && epoch === requestEpoch && activeRequest === token;
    let panel;
    try {
      panel = createPanel();
      panel.text.dataset.state = "loading";
      panel.text.textContent = "翻译请求中，请稍候...";
      panel.note.textContent = "Esc 隐藏译文；关闭全局翻译开关可取消请求。";
      const state = await sendMessage({ type: "GET_PLUGIN_STATE" });
      if (!state.enabled || !stillCurrent()) { closePanelIfCurrent(); return; }
      const status = await getConfigStatus();
      if (!stillCurrent()) return;
      if (text.length > status.maxTextLength) {
        throw { code: "TEXT_TOO_LONG", message: `选中文字共 ${text.length} 字符，超过上限 ${status.maxTextLength}。请分段选择，不会自动截断或发送请求。`, retryable: false };
      }
      const result = await sendMessage({ type: "TRANSLATE", text });
      if (!stillCurrent()) return;
      if (typeof result.translation !== "string") throw COMMUNICATION_ERROR;
      const latest = await sendMessage({ type: "GET_PLUGIN_STATE" });
      if (!latest.enabled || !stillCurrent()) { closePanelIfCurrent(); return; }
      if (panelVisible(panel)) showResult(panel, result);
    } catch (error) {
      if (error?.code === "PLUGIN_DISABLED") closePanelIfCurrent();
      else if (stillCurrent() && panel && panelVisible(panel)) showError(panel, error, text);
    } finally {
      if (activeRequest === token) { activeRequest = undefined; inProgress = false; }
    }
    function closePanelIfCurrent() { if (panel && currentPanel === panel) closePanel(); }
  }

  function isEditableElement(element) {
    return element instanceof HTMLElement && (
      element.matches("input, textarea, [role='textbox'], [role='combobox']") || element.isContentEditable
    );
  }

  function editingTarget(event) {
    if (event.composedPath().some(isEditableElement)) return true;
    let active = document.activeElement;
    // composedPath 和深层焦点共同处理开放 Shadow DOM 中的输入框。
    while (active) {
      if (isEditableElement(active)) return true;
      if (active.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      } else {
        // 闭合 Shadow DOM 隐藏真实输入框，保守保留已聚焦自定义元素中的按键。
        return active.tagName?.includes("-") === true;
      }
    }
    return false;
  }

  document.addEventListener("keydown", (event) => {
    // 只接受真实用户按键，阻止网页伪造快捷键来触发模型调用。
    if (!event.isTrusted || event.isComposing || editingTarget(event)) return;
    if (!pluginEnabled) return;
    if (event.key === "Escape" && currentPanel?.host.isConnected) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closePanel();
      return;
    }
    if (!globalThis.PaperParrotShortcuts.matches(event) || event.repeat) return;
    // 浮窗里的按键和选区不作为待翻译网页原文。
    if (currentPanel && event.composedPath().includes(currentPanel.host)) return;
    const selection = window.getSelection();
    if (isPdfReader) {
      const viewer = document.getElementById("pdf-viewer");
      const inTextLayer = (node) => {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        return Boolean(element?.closest(".textLayer") && viewer?.contains(element));
      };
      // 阅读器标题、状态栏和译文都不是待翻译原文；仅接受 PDF 文字层选区。
      if (!inTextLayer(selection?.anchorNode) || !inTextLayer(selection?.focusNode)) return;
    }
    if (currentPanel && selection?.anchorNode?.getRootNode() === currentPanel.host.shadowRoot) return;
    const text = selection?.toString().trim() ?? "";
    if (!text) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (inProgress) return;
    void runTranslation(text);
  }, true);
})();
