"use strict";

// Shared control for the popup and PDF reader. No model configuration or keys are read here.
(() => {
  const key = "literaturePluginEnabledV1";
  const button = document.getElementById("plugin-toggle");
  const label = document.getElementById("plugin-state-label");
  const notice = document.getElementById("plugin-status");
  let enabled = false;
  let revision = 0;
  let saving = false;
  let ready = false;

  function render(value) {
    enabled = value;
    button.setAttribute("aria-checked", String(value));
    label.textContent = value ? "已开启" : "已关闭";
    document.documentElement.dataset.translationEnabled = String(value);
    button.disabled = saving || !ready;
  }

  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok || typeof response.enabled !== "boolean") {
      throw new Error(response?.error?.message || "无法读取翻译开关，请重新打开插件或刷新阅读器。");
    }
    return response.enabled;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(key in changes)) return;
    revision++;
    ready = true;
    render(changes[key].newValue !== false);
  });

  button.addEventListener("click", async (event) => {
    if (!event.isTrusted || saving || !ready) return;
    saving = true;
    const restoreKeyboardFocus = event.detail === 0 && document.activeElement === button;
    notice.textContent = "";
    const requested = !enabled;
    const startRevision = revision;
    render(enabled);
    try {
      const result = await request({ type: "SET_PLUGIN_ENABLED", enabled: requested });
      // A newer change from another control takes precedence over a delayed response.
      if (revision === startRevision) render(result);
    } catch (error) {
      notice.textContent = error.message || "开关保存失败，已保留原状态，请重试。";
    } finally {
      saving = false;
      render(enabled);
      // Disabling a focused button during persistence drops focus. Restore keyboard continuity.
      if (restoreKeyboardFocus && document.activeElement === document.body) button.focus({ preventScroll: true });
    }
  });

  const initialRevision = revision;
  void request({ type: "GET_PLUGIN_STATE" }).then((value) => {
    ready = true;
    if (revision === initialRevision) render(value);
    else render(enabled);
  }).catch((error) => {
    notice.textContent = error.message || "无法读取开关，请重新打开插件或刷新阅读器。";
  });
})();
