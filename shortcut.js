"use strict";

// Shared by isolated content scripts and extension pages. No model credentials are accessed.
globalThis.PaperParrotShortcuts = (() => {
  const storageKey = "literatureTranslationShortcutV1";
  const defaultShortcut = { key: "y", ctrl: false, alt: false, shift: false, meta: false };
  let value = defaultShortcut;
  let loaded = false;
  let revision = 0;
  let recording = false;
  let saving = false;
  const listeners = new Set();
  const isControlPage = ["popup.html", "pdf-reader.html"].some((page) =>
    location.href.split(/[?#]/u)[0] === chrome.runtime.getURL(page));
  const button = isControlPage ? document.getElementById("shortcut-button") : null;
  const resetButton = isControlPage ? document.getElementById("shortcut-reset") : null;
  const notice = isControlPage ? document.getElementById("shortcut-status") : null;

  function normalize(shortcut) {
    const key = typeof shortcut?.key === "string" ? shortcut.key.toLowerCase() : "";
    if (!/^(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/u.test(key)) return { ...defaultShortcut };
    return { key, ctrl: shortcut.ctrl === true, alt: shortcut.alt === true,
      shift: shortcut.shift === true, meta: shortcut.meta === true };
  }

  function label(shortcut = value) {
    return [shortcut.ctrl && "Ctrl", shortcut.alt && "Alt", shortcut.shift && "Shift",
      shortcut.meta && "Meta", shortcut.key.toUpperCase()].filter(Boolean).join("+");
  }

  function render() {
    if (isControlPage) for (const element of document.querySelectorAll("[data-translation-shortcut]")) element.textContent = label();
    if (!button) return;
    button.textContent = recording ? "请按快捷键…" : `${button.dataset.prefix || ""}${label()}`;
    button.disabled = !loaded || saving;
    button.setAttribute("aria-pressed", String(recording));
    if (resetButton) resetButton.disabled = !loaded || saving || label() === "Y";
  }

  function update(shortcut) {
    value = normalize(shortcut);
    render();
    for (const listener of listeners) listener();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(storageKey in changes)) return;
    revision++;
    loaded = true;
    update(changes[storageKey].newValue);
  });
  const initialRevision = revision;
  const ready = chrome.storage.local.get(storageKey).then((stored) => {
    loaded = true;
    if (revision === initialRevision) update(stored[storageKey]);
    else render();
  }).catch(() => {
    if (notice) notice.textContent = "快捷键读取失败，请刷新页面重试。";
  });

  async function save(shortcut) {
    const next = normalize(shortcut);
    recording = false;
    saving = true;
    const saveRevision = revision;
    render();
    try {
      await chrome.storage.local.set({ [storageKey]: next });
      if (revision === saveRevision) update(next);
      if (notice) notice.textContent = "";
    } catch {
      if (notice) notice.textContent = "快捷键保存失败，已保留原设置，请重试。";
    } finally {
      saving = false;
      render();
      button?.focus({ preventScroll: true });
    }
  }

  button?.addEventListener("click", (event) => {
    if (!event.isTrusted || !loaded || saving) return;
    recording = !recording;
    notice.textContent = recording ? "按字母、数字、F1–F12 或组合键；Esc 取消。" : "";
    render();
  });
  resetButton?.addEventListener("click", (event) => {
    if (event.isTrusted && loaded && !saving) void save(defaultShortcut);
  });
  button?.addEventListener("blur", () => {
    if (!recording) return;
    recording = false;
    notice.textContent = "";
    render();
  });
  // Register before content.js so recording never triggers a translation.
  document.addEventListener("keydown", (event) => {
    if (!recording || !event.isTrusted || event.isComposing) return;
    if (event.key === "Tab") { recording = false; notice.textContent = ""; render(); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape") { recording = false; notice.textContent = ""; render(); return; }
    if (["Control", "Alt", "Shift", "Meta"].includes(event.key) || event.repeat) return;
    const key = event.key.toLowerCase();
    if (!/^(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/u.test(key)) return;
    void save({ key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey });
  }, true);

  return {
    ready, label,
    matches: (event) => loaded && !recording && event.key?.toLowerCase() === value.key &&
      event.ctrlKey === value.ctrl && event.altKey === value.alt &&
      event.shiftKey === value.shift && event.metaKey === value.meta,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
})();
