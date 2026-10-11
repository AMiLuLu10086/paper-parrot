"use strict";

/**
 * 展示模型状态并打开 PDF 阅读页，不输入或保存密钥。全部使用 chrome.* API，Edge 原生支持。
 * 通过后台读取 config.json 的同一份快照，避免 popup 展示刚编辑的新文件、
 * 后台仍使用旧配置的不同步情况；不把密钥传给 popup 或网页。
 *
 * Chrome 本地加载：chrome://extensions → 开发者模式 → 加载已解压的扩展程序。
 * Edge 本地加载：edge://extensions → 开发者模式 → 加载解压缩的扩展。
 * 两边选择同一个项目文件夹即可，不需要 Firefox 或 webextension-polyfill 适配。
 * 修改 config.json 后先在扩展管理页重新加载扩展，再刷新目标网页，无热更新。
 */

// activeTab 只用于用户主动打开插件时读取当前网址；不需要 tabs / 历史权限。
for (const [id, useCurrent] of [["open-pdf", false], ["open-current-pdf", true]]) {
  const button = document.getElementById(id);
  button.addEventListener("click", async (event) => {
    if (!event.isTrusted || button.disabled) return;
    button.disabled = true;
    const notice = document.getElementById("pdf-status");
    notice.textContent = "";
    try {
      const reader = new URL(chrome.runtime.getURL("pdf-reader.html"));
      if (useCurrent) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url || !/^https?:\/\//u.test(tab.url)) {
          notice.textContent = "当前地址不能直接加载。请点“打开 PDF 阅读器”，选择本地文件或粘贴在线链接。";
          return;
        }
        // 使用 URLSearchParams 编码，包括没有 .pdf 后缀及含签名参数的在线地址。
        reader.searchParams.set("url", tab.url);
      }
      await chrome.tabs.create({ url: reader.href });
      window.close();
    } catch {
      notice.textContent = "无法打开阅读器，请在扩展管理页重新加载插件后重试。";
    } finally { button.disabled = false; }
  });
}

(async () => {
  const modelName = document.getElementById("model-name");
  const status = document.getElementById("status");
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_CONFIG_STATUS" });
    if (!response || typeof response.ok !== "boolean") throw new Error("Invalid extension response");
    if (!response.ok) {
      modelName.textContent = "配置未加载";
      status.dataset.state = "error";
      status.textContent = response.error?.message ?? "配置加载失败，请检查 config.json 后重新加载扩展。";
      return;
    }
    modelName.textContent = response.model === "YOUR_MODEL_NAME" ? "尚未配置" : response.model;
    status.textContent = response.ready
      ? `每次最多 ${response.maxTextLength} 字符；成功译文保存在本次浏览器会话缓存中。`
      : "请在 config.json 填写实际模型、接口根地址和 API 密钥，再重新加载扩展。";
  } catch {
    modelName.textContent = "读取失败";
    status.dataset.state = "error";
    status.textContent = "无法与扩展后台通信，请在扩展管理页重新加载插件。";
  }
})();
