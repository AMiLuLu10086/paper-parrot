"use strict";

/**
 * Chrome / Edge Manifest V3 后台。全部使用 chrome.* API，Edge 原生支持，
 * 不需要 webextension-polyfill，不兼容 Firefox。
 *
 * 安全：config.json 的密钥在本地扩展包中明文保存，仅供个人使用，不要打包分享。
 * 不要将 config.json 加入 web_accessible_resources，否则匹配网页也能读取密钥。
 * 网页仅通过扩展内部消息发送原文，后台不接收网页提供的 URL、密钥或模型参数。
 *
 * CORS：content script 直接 fetch LLM 接口仍受网页源的 CORS 限制，
 * host_permissions 不能消除这种限制。前端直连的两种替代方案是：
 * 1. 临时 CORS 插件，仅用于本地测试，测试后关闭；
 * 2. 后端中转，由中转服务处理密钥及允许的跨域来源。
 * 本版本改用扩展后台 fetch，并声明主机权限，无需临时 CORS 插件或中转服务。
 * 广泛 HTTP/HTTPS 权限用于仅编辑 config.json 切换服务；分享版应收缩权限。
 *
 * JSON 不支持注释：manifest.json 的 storage 用于会话快照、缓存和本地开关状态，
 * minimum_chrome_version 为 storage.session 的最低版本，content script 只注入顶层 HTML。
 */

const SYSTEM_PROMPT = "你是科研文献专业中英翻译助手，只输出译文，不要多余说明。保留领域专业术语，译文通顺，符合中文科技论文表达习惯。";
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_CACHE_CHARACTERS = 500_000;
const CONFIG_STORAGE_KEY = "literatureConfigSnapshotV1";
const CACHE_STORAGE_KEY = "literatureTranslationsV1";
const PLUGIN_STORAGE_KEY = "literaturePluginEnabledV1";
const CONFIG_LOAD_MESSAGE = "无法加载本地配置文件，请检查项目根目录config.json是否存在。";

let configPromise;
let cacheQueue = Promise.resolve();
const activeTabs = new Map();
const pendingTranslations = new Map();
const requestControllers = new Set();
let pluginEnabled;
let pluginStatePromise;
let stateQueue = Promise.resolve();
let translationEpoch = 0;

function applyPluginState(enabled) {
  if (pluginEnabled === enabled) return;
  pluginEnabled = enabled;
  translationEpoch++;
  if (!enabled) {
    for (const controller of requestControllers) controller.abort();
    // Old tasks release only their own locks; a newly enabled request can start immediately.
    activeTabs.clear();
    pendingTranslations.clear();
  }
}

async function loadPluginState() {
  try {
    const epoch = translationEpoch;
    const stored = await chrome.storage.local.get(PLUGIN_STORAGE_KEY);
    if (epoch === translationEpoch) applyPluginState(stored[PLUGIN_STORAGE_KEY] !== false);
  } catch {
    throw new ExtensionError("STATE_STORAGE", "无法读取翻译开关，请重新打开插件后重试。");
  }
}

async function ensurePluginState() {
  pluginStatePromise ??= loadPluginState().catch((error) => {
    pluginStatePromise = undefined;
    throw error;
  });
  await pluginStatePromise;
}

function queueStateOperation(operation) {
  const task = stateQueue.then(operation);
  stateQueue = task.catch(() => undefined);
  return task;
}

function getPluginState() {
  return queueStateOperation(async () => {
    await ensurePluginState();
    return { enabled: pluginEnabled };
  });
}

function setPluginEnabled(message, sender) {
  return queueStateOperation(async () => {
    let source;
    try { source = new URL(sender.url); } catch { /* Reject missing or malformed senders. */ }
    const allowed = ["popup.html", "pdf-reader.html"].some((page) => {
      const target = new URL(chrome.runtime.getURL(page));
      return source?.origin === target.origin && source?.protocol === target.protocol &&
        source?.host === target.host && source?.pathname === target.pathname;
    });
    if (!allowed || (sender.frameId !== undefined && sender.frameId !== 0)) {
      throw new ExtensionError("INVALID_SENDER", "只能在插件控制面板或 PDF 阅读器中修改翻译开关。");
    }
    if (typeof message.enabled !== "boolean") {
      throw new ExtensionError("INVALID_STATE", "翻译开关必须为开启或关闭。");
    }
    await ensurePluginState();
    try {
      await chrome.storage.local.set({ [PLUGIN_STORAGE_KEY]: message.enabled });
    } catch {
      throw new ExtensionError("STATE_STORAGE", "开关保存失败，已保留原状态，请重试。");
    }
    applyPluginState(message.enabled);
    return { enabled: pluginEnabled };
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && PLUGIN_STORAGE_KEY in changes) {
    applyPluginState(changes[PLUGIN_STORAGE_KEY].newValue !== false);
  }
});

function assertTranslationEnabled(epoch) {
  if (!pluginEnabled || epoch !== translationEpoch) {
    throw new ExtensionError("PLUGIN_DISABLED", "翻译已停用，本次请求已取消。");
  }
}

class ExtensionError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "ExtensionError";
    this.code = code;
    this.retryable = retryable;
  }
}

function configFieldError(field, requirement) {
  return new ExtensionError("CONFIG_INVALID", `配置字段 ${field} ${requirement}。修改 config.json 后重新加载扩展，并刷新网页。`);
}

function validateConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw configFieldError("config.json", "必须是 JSON 对象");
  }
  for (const field of ["model", "baseUrl"]) {
    if (typeof raw[field] !== "string" || !raw[field].trim()) {
      throw configFieldError(field, "必须是非空字符串");
    }
  }
  // 允许预先填写模型而把密钥留空；是否可请求在 isConfigured 中判断。
  if (typeof raw.apiKey !== "string") {
    throw configFieldError("apiKey", "必须是字符串，尚未配置时可留空");
  }
  if (/[\r\n]/u.test(raw.apiKey)) {
    throw configFieldError("apiKey", "不能包含换行符");
  }
  let baseUrl;
  try {
    baseUrl = new URL(raw.baseUrl.trim());
  } catch {
    throw configFieldError("baseUrl", "必须是有效的 HTTP/HTTPS 根地址，例如 https://api.example.com/v1");
  }
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw configFieldError("baseUrl", "必须使用 HTTP/HTTPS，不能包含账号、密码、查询参数或片段");
  }
  if (/\/chat\/completions\/?$/u.test(baseUrl.pathname)) {
    throw configFieldError("baseUrl", "应填写接口根地址，不要包含 /chat/completions");
  }
  if (typeof raw.temperature !== "number" || !Number.isFinite(raw.temperature)) {
    throw configFieldError("temperature", "必须是有限数值，是否支持该值由接口决定");
  }
  const maxTextLength = raw.maxTextLength ?? 5000;
  const cacheMaxEntries = raw.cacheMaxEntries ?? 100;
  for (const [field, value] of Object.entries({ maxTextLength, cacheMaxEntries })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw configFieldError(field, "必须是正整数");
    }
  }
  let thinking;
  if (raw.thinking !== undefined) {
    if (!raw.thinking || typeof raw.thinking !== "object" || Array.isArray(raw.thinking) || !["enabled", "disabled"].includes(raw.thinking.type)) {
      throw configFieldError("thinking", "必须是包含 type: enabled 或 disabled 的对象；不支持该参数的服务请省略此字段");
    }
    thinking = { type: raw.thinking.type };
  }
  // 只取允许的字段，不把多余的本地参数发送到接口。
  return {
    model: raw.model.trim(),
    baseUrl: baseUrl.href.replace(/\/+$/u, ""),
    apiKey: raw.apiKey.trim(),
    temperature: raw.temperature,
    maxTextLength,
    cacheMaxEntries,
    ...(thinking ? { thinking } : {}),
  };
}

function publicError(error) {
  // 未知异常可能包含请求或密钥，不直接把 error.message 返回到网页或控制台。
  if (error instanceof ExtensionError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: "INTERNAL_ERROR", message: "扩展处理请求失败，请重新加载扩展并刷新网页。", retryable: false };
}

async function loadConfigSnapshot() {
  let stored;
  try {
    stored = (await chrome.storage.session.get(CONFIG_STORAGE_KEY))[CONFIG_STORAGE_KEY];
  } catch {
    throw new ExtensionError("CONFIG_STORAGE", "无法读取扩展会话存储，请检查扩展权限并重新加载扩展。");
  }
  if (stored?.config) return validateConfig(stored.config);
  if (stored?.error) {
    throw new ExtensionError(stored.error.code, stored.error.message);
  }

  let snapshot;
  try {
    let raw;
    try {
      const response = await fetch(chrome.runtime.getURL("config.json"));
      if (!response.ok) throw new Error("Config resource unavailable");
      raw = await response.json();
    } catch {
      throw new ExtensionError("CONFIG_LOAD", `${CONFIG_LOAD_MESSAGE}检查 JSON 格式后重新加载扩展。`);
    }
    snapshot = { config: validateConfig(raw) };
  } catch (error) {
    snapshot = { error: publicError(error) };
  }
  try {
    // session 仅在内存中，默认不向 content script 开放。后台休眠不丢失快照；
    // 扩展重新加载、禁用或浏览器重启会清空它。没有轮询文件或热更新。
    await chrome.storage.session.set({ [CONFIG_STORAGE_KEY]: snapshot });
  } catch {
    throw new ExtensionError("CONFIG_STORAGE", "无法保存扩展配置快照，请检查扩展权限并重新加载扩展。");
  }
  if (snapshot.error) throw new ExtensionError(snapshot.error.code, snapshot.error.message);
  return snapshot.config;
}

function getConfig() {
  // 同一后台实例的并发消息只读取一次配置；错误也缓存，修复后需要刷新扩展。
  configPromise ??= loadConfigSnapshot();
  return configPromise;
}

function isConfigured(config) {
  return config.apiKey.length > 0 && config.model !== "YOUR_MODEL_NAME" && config.apiKey !== "YOUR_API_KEY" && new URL(config.baseUrl).hostname !== "api.example.com";
}

function queueCacheOperation(operation) {
  const task = cacheQueue.then(operation);
  cacheQueue = task.catch(() => undefined);
  return task;
}

function trimCache(entries, config) {
  const valid = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry.key === "string" && typeof entry.text === "string" && typeof entry.translation === "string") : [];
  let total = valid.reduce((count, entry) => count + entry.text.length + entry.translation.length, 0);
  while (valid.length > config.cacheMaxEntries || total > MAX_CACHE_CHARACTERS) {
    const removed = valid.shift();
    total -= removed.text.length + removed.translation.length;
  }
  return valid;
}

async function readCachedTranslation(key, config) {
  return queueCacheOperation(async () => {
    try {
      const stored = await chrome.storage.session.get(CACHE_STORAGE_KEY);
      const entries = trimCache(stored[CACHE_STORAGE_KEY], config);
      const index = entries.findIndex((entry) => entry.key === key);
      if (index < 0) return null;
      const [entry] = entries.splice(index, 1);
      entries.push(entry); // 最近使用的条目排在末尾。
      try {
        await chrome.storage.session.set({ [CACHE_STORAGE_KEY]: entries });
      } catch { /* 更新 LRU 失败不影响已经读取的译文。 */ }
      return entry.translation;
    } catch {
      return null; // 缓存故障退回普通请求，不丢失翻译能力。
    }
  });
}

async function saveCachedTranslation(key, text, translation, config, epoch) {
  if (text.length + translation.length > MAX_CACHE_CHARACTERS) return;
  await queueCacheOperation(async () => {
    try {
      assertTranslationEnabled(epoch);
      const stored = await chrome.storage.session.get(CACHE_STORAGE_KEY);
      assertTranslationEnabled(epoch);
      const entries = trimCache(stored[CACHE_STORAGE_KEY], config).filter((entry) => entry.key !== key);
      entries.push({ key, text, translation });
      await chrome.storage.session.set({ [CACHE_STORAGE_KEY]: trimCache(entries, config) });
    } catch { /* 不把缓存异常传播为翻译失败，也不记录密钥或原文。 */ }
  });
}

async function translationKey(text, config) {
  const input = JSON.stringify([config.baseUrl, config.model, config.temperature, config.thinking ?? null, SYSTEM_PROMPT, text]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeApiDetail(payload, apiKey) {
  const detail = payload?.error?.message;
  if (typeof detail !== "string") return "";
  // 先脱敏再截断，防止 API 错误回显完整或部分密钥。
  return detail.replaceAll(apiKey, "[密钥已隐藏]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [密钥已隐藏]")
    .replace(/sk-[A-Za-z0-9_-]+/gu, "[密钥已隐藏]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 300);
}

function httpError(status, payload, config) {
  const detail = safeApiDetail(payload, config.apiKey);
  const suffix = detail ? ` 接口说明：${detail}` : "";
  if (status === 401 || status === 403) {
    return new ExtensionError(`HTTP_${status}`, `接口拒绝访问（${status}），请检查 API 密钥、模型权限和账号状态。${suffix}`);
  }
  if (status === 404) {
    return new ExtensionError("HTTP_404", `接口或模型不存在（404），请检查 baseUrl、/chat/completions 路径和模型名称。${suffix}`);
  }
  if (status === 429) {
    return new ExtensionError("HTTP_429", `接口限流或额度不足（429），请检查额度，稍后手动重试。${suffix}`, true);
  }
  if (status >= 500) {
    return new ExtensionError(`HTTP_${status}`, `接口服务异常（${status}），请稍后手动重试。${suffix}`, true);
  }
  return new ExtensionError(`HTTP_${status}`, `接口请求失败（${status}），请检查模型和参数。${suffix}`);
}

async function requestTranslation(text, config, epoch) {
  assertTranslationEnabled(epoch);
  const controller = new AbortController();
  requestControllers.add(controller);
  // 非流式请求采用保守的 25 秒总时限。不要直接改成大于 30 秒：
  // MV3 后台还有 fetch 等待及空闲终止规则，后续需配合流式和消息生命周期设计。
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        // 仅当本地配置明确设置时发送，切换到不支持 thinking 的服务可移除此字段。
        ...(config.thinking ? { thinking: config.thinking } : {}),
        stream: false,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
    });
    // 先读正文再解析：非 JSON 错误页仍按 HTTP 状态给出正确建议。
    const body = await response.text();
    assertTranslationEnabled(epoch);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      if (!response.ok) throw httpError(response.status, null, config);
      throw new ExtensionError("INVALID_RESPONSE", "接口返回的内容不是 JSON，请检查 Chat Completions 兼容性。");
    }
    if (!response.ok) throw httpError(response.status, payload, config);
    if (payload?.error) {
      throw new ExtensionError("API_ERROR", `接口报告错误，请检查模型和参数。${safeApiDetail(payload, config.apiKey)}`);
    }
    const choice = payload?.choices?.[0];
    if (typeof choice?.message?.content !== "string" || !choice.message.content.trim()) {
      throw new ExtensionError("EMPTY_TRANSLATION", "接口未返回有效译文，请检查 choices[0].message.content 及 Chat Completions 兼容性。");
    }
    return { translation: choice.message.content.trim(), cached: false, incomplete: choice.finish_reason === "length" };
  } catch (error) {
    assertTranslationEnabled(epoch);
    if (controller.signal.aborted) {
      throw new ExtensionError("TIMEOUT", "翻译请求超过 25 秒，请缩短选区或稍后手动重试。中止本地等待不保证服务端停止生成或计费。", true);
    }
    if (error instanceof ExtensionError) throw error;
    throw new ExtensionError("NETWORK_ERROR", "网络请求失败，请检查网络、接口地址和扩展主机权限，然后手动重试。", true);
  } finally {
    clearTimeout(timer);
    requestControllers.delete(controller);
  }
}

async function translate(message, sender) {
  // 只允许顶层网页和本扩展指定阅读页，不允许其他扩展页面或任意 URL 代理。
  let allowedSource = false;
  try {
    const source = new URL(sender.url);
    const reader = new URL(chrome.runtime.getURL("pdf-reader.html"));
    allowedSource = ["http:", "https:"].includes(source.protocol) || (
      source.protocol === reader.protocol && source.host === reader.host && source.pathname === reader.pathname
    );
  } catch { /* 非法或缺失来源一律拒绝。 */ }
  if (!sender.tab || sender.frameId !== 0 || !allowedSource) {
    throw new ExtensionError("INVALID_SENDER", "该页面不支持选区翻译。");
  }
  if (typeof message.text !== "string" || !message.text.trim()) {
    throw new ExtensionError("EMPTY_SELECTION", "请先选择需要翻译的文字。");
  }
  await getPluginState();
  const epoch = translationEpoch;
  assertTranslationEnabled(epoch);
  const tabId = sender.tab.id;
  if (activeTabs.has(tabId)) throw new ExtensionError("BUSY", "当前网页已有翻译请求，请等待完成。");
  const token = {};
  activeTabs.set(tabId, token);
  try {
    const config = await getConfig();
    assertTranslationEnabled(epoch);
    const text = message.text.trim();
    if (text.length > config.maxTextLength) {
      throw new ExtensionError("TEXT_TOO_LONG", `选中文字共 ${text.length} 字符，超过上限 ${config.maxTextLength}。请分段选择，不会自动截断或发送请求。`);
    }
    if (!isConfigured(config)) {
      throw new ExtensionError("CONFIG_REQUIRED", "请先在项目根目录 config.json 填写实际 model、baseUrl 和 apiKey，再重新加载扩展并刷新网页。");
    }
    const key = await translationKey(text, config);
    assertTranslationEnabled(epoch);
    const cached = await readCachedTranslation(key, config);
    assertTranslationEnabled(epoch);
    if (cached !== null) return { translation: cached, cached: true, incomplete: false };

    // 不同标签页同时翻译完全相同的原文时共享正在执行的请求，避免重复付费。
    if (pendingTranslations.has(key)) {
      const result = await pendingTranslations.get(key);
      assertTranslationEnabled(epoch);
      return result;
    }
    const task = (async () => {
      const result = await requestTranslation(text, config, epoch);
      assertTranslationEnabled(epoch);
      if (!result.incomplete) await saveCachedTranslation(key, text, result.translation, config, epoch);
      assertTranslationEnabled(epoch);
      return result;
    })();
    pendingTranslations.set(key, task);
    try {
      return await task;
    } finally {
      if (pendingTranslations.get(key) === task) pendingTranslations.delete(key);
    }
  } finally {
    if (activeTabs.get(tabId) === token) activeTabs.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || !["GET_CONFIG_STATUS", "TRANSLATE", "GET_PLUGIN_STATE", "SET_PLUGIN_ENABLED"].includes(message.type)) return false;
  let task;
  switch (message.type) {
    case "GET_PLUGIN_STATE": task = getPluginState(); break;
    case "SET_PLUGIN_ENABLED": task = setPluginEnabled(message, sender); break;
    case "GET_CONFIG_STATUS":
      task = getConfig().then((config) => ({ model: config.model, maxTextLength: config.maxTextLength, ready: isConfigured(config) }));
      break;
    default: task = translate(message, sender);
  }
  void task.then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: publicError(error) }),
  ).catch(() => undefined); // 页面导航或关闭导致响应通道失效时，不产生未捕获异常。
  // 使用传统异步响应方式，而非 async 消息监听函数，以兼容 Chrome 和 Edge。
  return true;
});

// 在安装、重新加载以及浏览器启动时尽早建立快照；失败由 popup / 页面友好提示。
chrome.runtime.onInstalled.addListener(() => { void getConfig().catch(() => undefined); });
chrome.runtime.onStartup.addListener(() => { void getConfig().catch(() => undefined); });
