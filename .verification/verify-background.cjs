// 独立模拟验证：只运行项目源码，不连接任何真实 LLM，不使用真实密钥。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const CONFIG_KEY = 'literatureConfigSnapshotV1';
const CACHE_KEY = 'literatureTranslationsV1';
const PLUGIN_KEY = 'literaturePluginEnabledV1';
const defaultConfig = { model: 'test-model', baseUrl: 'https://mock.invalid/v1', apiKey: 'test-secret-key', temperature: 0.3, maxTextLength: 5000, cacheMaxEntries: 100 };

function harness(options = {}) {
  const storage = options.storage ?? {};
  const localStorage = options.localStorage ?? {};
  const storageListeners = [];
  const stats = { configLoads: 0, apiCalls: 0, requests: [], timers: [], aborted: 0 };
  let listener;
  const handlers = {};
  const response = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  const controls = { mode: options.mode ?? 'success', delay: options.delay ?? 0, translation: options.translation ?? '科研译文', failCache: options.failCache ?? false, config: options.config ?? defaultConfig, ignoreAbort: false, failStateRead: false, failStateWrite: false, cacheReadGate: null, configGate: null };
  const chrome = {
    runtime: {
      id: 'test-extension',
      getURL: (resource) => `chrome-extension://test-extension/${resource}`,
      onMessage: { addListener: (handler) => { listener = handler; } },
      onInstalled: { addListener: (handler) => { handlers.installed = handler; } },
      onStartup: { addListener: (handler) => { handlers.startup = handler; } },
    },
    storage: {
      onChanged: { addListener: (handler) => storageListeners.push(handler) },
      local: {
        async get(key) {
          if (controls.failStateRead) throw Error('Simulated state read failure');
          return { [key]: localStorage[key] };
        },
        async set(values) {
          if (controls.failStateWrite) throw Error('Simulated state write failure');
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            if (localStorage[key] !== value) changes[key] = { oldValue: localStorage[key], newValue: value };
            localStorage[key] = value;
          }
          if (Object.keys(changes).length) for (const handler of storageListeners) handler(changes, 'local');
        },
      }, session: {
      async get(key) {
        if (key === CACHE_KEY && controls.cacheReadGate) await controls.cacheReadGate;
        if (key === CACHE_KEY && controls.failCache) throw Error('Simulated cache failure');
        return { [key]: structuredClone(storage[key]) };
      },
      async set(values) {
        if (CACHE_KEY in values && controls.failCache) throw Error('Simulated cache failure');
        for (const [key, value] of Object.entries(values)) storage[key] = structuredClone(value);
      },
    } },
  };
  const context = vm.createContext({ chrome, URL, TextEncoder, crypto: webcrypto, AbortController,
    setTimeout(callback, milliseconds) {
      stats.timers.push(milliseconds);
      return setTimeout(callback, options.accelerateTimeout ? 25 : milliseconds);
    }, clearTimeout,
    async fetch(url, request) {
      if (url.endsWith('/config.json')) {
        stats.configLoads++;
        if (controls.configGate) await controls.configGate;
        if (controls.mode === 'missing-config') return response('missing', 404);
        if (controls.mode === 'invalid-json-config') return response('{bad');
        return response(controls.config);
      }
      stats.apiCalls++;
      stats.requests.push({ url, ...request, parsed: JSON.parse(request.body) });
      request.signal.addEventListener('abort', () => stats.aborted++, { once: true });
      if (controls.mode === 'timeout') {
        return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
      }
      if (controls.delay) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { request.signal.removeEventListener('abort', abort); resolve(); }, controls.delay);
        function abort() {
          if (controls.ignoreAbort) return;
          clearTimeout(timer);
          reject(Error('aborted'));
        }
        request.signal.addEventListener('abort', abort, { once: true });
      });
      if (controls.mode === 'network') throw Error('Network unavailable');
      if (typeof controls.mode === 'number') return response({ error: { message: `API rejected ${defaultConfig.apiKey} Bearer another-secret-key` } }, controls.mode);
      if (controls.mode === 'html-error') return response('<html>Error</html>', 404);
      if (controls.mode === 'invalid-json') return response('invalid');
      if (controls.mode === 'empty') return response({ choices: [] });
      if (controls.mode === 'api-error') return response({ error: { message: defaultConfig.apiKey } });
      return response({ choices: [{ message: { content: controls.translation }, finish_reason: controls.mode === 'incomplete' ? 'length' : 'stop' }] });
    },
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  function send(message, tabId = 1, overrides = {}) {
    return new Promise((resolve, reject) => {
      const guard = setTimeout(() => reject(Error('Message did not settle')), 2000);
      const result = listener(message, { id: chrome.runtime.id, tab: { id: tabId }, frameId: 0, url: 'https://paper.invalid/article', ...overrides }, (value) => {
        clearTimeout(guard);
        resolve(structuredClone(value));
      });
      if (result !== true) { clearTimeout(guard); resolve(undefined); }
    });
  }
  return { send, storage, localStorage, stats, controls, handlers };
}

let assertions = 0;
function check(condition, label) { assert.ok(condition, label); assertions++; }
async function run() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  check(manifest.manifest_version === 3, 'Manifest V3');
  check(!manifest.web_accessible_resources && !manifest.externally_connectable, 'Configuration is private');
  check(manifest.content_scripts[0].all_frames === false, 'Only top frames');
  check(typeof config.apiKey === 'string', 'API key configuration is a string');
  for (const name of ['manifest.json', 'config.json', 'background.js', 'content.js', 'popup.html', 'popup.js']) check(fs.existsSync(path.join(root, name)), name);
  check(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(fs.readFileSync(path.join(root, 'popup.html'), 'utf8')), 'No inline scripts');

  const h = harness();
  const statuses = await Promise.all([h.send({ type: 'GET_CONFIG_STATUS' }), h.send({ type: 'GET_CONFIG_STATUS' })]);
  check(h.stats.configLoads === 1, 'Single configuration fetch');
  check(statuses.every((s) => s.ok && s.model === defaultConfig.model), 'Configuration status');
  check(!JSON.stringify(statuses).includes(defaultConfig.apiKey), 'Status contains no key');
  const restarted = harness({ storage: h.storage, config: { ...defaultConfig, model: 'edited-model' } });
  check((await restarted.send({ type: 'GET_CONFIG_STATUS' })).model === defaultConfig.model && restarted.stats.configLoads === 0, 'Snapshot survives worker restart');
  check((await harness({ config: { ...defaultConfig, model: 'edited-model' } }).send({ type: 'GET_CONFIG_STATUS' })).model === 'edited-model', 'New session reads new config');
  for (const mode of ['missing-config', 'invalid-json-config']) {
    const bad = harness({ mode });
    const result = await bad.send({ type: 'GET_CONFIG_STATUS' });
    check(result.error.code === 'CONFIG_LOAD', mode);
    check(result.error.message.includes('无法加载本地配置文件，请检查项目根目录config.json是否存在。'), 'Required load message');
    await bad.send({ type: 'GET_CONFIG_STATUS' });
    check(bad.stats.configLoads === 1, 'Configuration failure is cached');
  }
  for (const override of [{ temperature: '0.3' }, { maxTextLength: 0 }, { cacheMaxEntries: -1 }, { baseUrl: 'https://mock.invalid/v1/chat/completions' }, { baseUrl: 'ftp://mock.invalid' }, { apiKey: 'secret\nkey' }]) {
    const bad = harness({ config: { ...defaultConfig, ...override } });
    check((await bad.send({ type: 'GET_CONFIG_STATUS' })).error.code === 'CONFIG_INVALID', 'Invalid field rejected');
    check(bad.stats.apiCalls === 0, 'Bad config never sent');
  }
  const placeholder = harness({ config: { ...defaultConfig, model: 'YOUR_MODEL_NAME', apiKey: 'YOUR_API_KEY' } });
  check((await placeholder.send({ type: 'TRANSLATE', text: 'sample' })).error.code === 'CONFIG_REQUIRED', 'Placeholder never called');
  check(placeholder.stats.apiCalls === 0, 'No actual network calls for placeholder');
  const blankKey = harness({ config: { ...defaultConfig, apiKey: '' } });
  const blankStatus = await blankKey.send({ type: 'GET_CONFIG_STATUS' });
  check(blankStatus.ok && !blankStatus.ready && blankStatus.model === defaultConfig.model, 'Blank key still displays configured model');
  check((await blankKey.send({ type: 'TRANSLATE', text: 'sample' })).error.code === 'CONFIG_REQUIRED' && blankKey.stats.apiCalls === 0, 'Blank key never calls API');
  const thinking = harness({ config: { ...defaultConfig, thinking: { type: 'disabled' } } });
  check((await thinking.send({ type: 'TRANSLATE', text: 'sample' })).ok && thinking.stats.requests[0].parsed.thinking.type === 'disabled', 'Configured thinking mode passed to API');
  const otherThinkingStorage = structuredClone(thinking.storage);
  otherThinkingStorage[CONFIG_KEY].config.thinking.type = 'enabled';
  const otherThinking = harness({ storage: otherThinkingStorage });
  check(!(await otherThinking.send({ type: 'TRANSLATE', text: 'sample' })).cached && otherThinking.stats.apiCalls === 1, 'Thinking mode change does not reuse translation');
  for (const value of [{ type: 'unknown' }, 'disabled', null]) {
    check((await harness({ config: { ...defaultConfig, thinking: value } }).send({ type: 'GET_CONFIG_STATUS' })).error.code === 'CONFIG_INVALID', 'Invalid thinking configuration rejected');
  }
  check((await h.send({ type: 'TRANSLATE', text: ' ' })).error.code === 'EMPTY_SELECTION', 'Empty text');
  check((await h.send({ type: 'TRANSLATE', text: 'sample' }, 1, { frameId: 1 })).error.code === 'INVALID_SENDER', 'Iframe blocked');
  const pdfHarness = harness();
  check((await pdfHarness.send({ type: 'TRANSLATE', text: 'PDF text' }, 2, { url: 'chrome-extension://test-extension/pdf-reader.html?url=https%3A%2F%2Fpaper.invalid' })).ok, 'Own PDF reader allowed');
  for (const url of ['chrome-extension://other/pdf-reader.html', 'chrome-extension://test-extension/popup.html', 'chrome-extension://test-extension/pdf-reader.html.fake', 'file:///D:/paper.pdf', 'not a URL']) {
    check((await pdfHarness.send({ type: 'TRANSLATE', text: 'PDF text' }, 2, { url })).error.code === 'INVALID_SENDER', 'Untrusted PDF sender blocked');
  }
  check((await pdfHarness.send({ type: 'TRANSLATE', text: 'PDF text' }, 2, { url: 'chrome-extension://test-extension/pdf-reader.html', frameId: 1 })).error.code === 'INVALID_SENDER', 'Embedded own PDF reader blocked');
  check(await h.send({ type: 'GET_CONFIG_STATUS' }, 1, { id: 'another-extension' }) === undefined, 'Other extension ignored');
  const bounded = harness({ config: { ...defaultConfig, maxTextLength: 10 } });
  check((await bounded.send({ type: 'TRANSLATE', text: '0123456789' })).ok, 'Length at boundary');
  check((await bounded.send({ type: 'TRANSLATE', text: '01234567890' })).error.code === 'TEXT_TOO_LONG', 'Above length boundary');
  check(bounded.stats.apiCalls === 1, 'Overlong text not sent');

  const first = await h.send({ type: 'TRANSLATE', text: '  Sample paragraph  ', url: 'https://evil.invalid' });
  check(first.ok && !first.cached && first.translation === '科研译文', 'Translation succeeds');
  const request = h.stats.requests[0];
  check(request.url === 'https://mock.invalid/v1/chat/completions', 'URL controlled by config');
  check(request.headers.Authorization === `Bearer ${defaultConfig.apiKey}` && request.credentials === 'omit', 'Authentication and cookies');
  check(request.parsed.messages[1].content === 'Sample paragraph', 'Trim original selection');
  check(!('maxTextLength' in request.parsed) && !('apiKey' in request.parsed), 'Only request parameters sent');
  check(!('thinking' in request.parsed), 'No provider-specific option sent when absent');
  check((await h.send({ type: 'TRANSLATE', text: 'Sample paragraph' })).cached && h.stats.apiCalls === 1, 'Cache hit');
  check((await restarted.send({ type: 'TRANSLATE', text: 'Sample paragraph' })).cached && restarted.stats.apiCalls === 0, 'Cache survives worker sleep');
  const changed = structuredClone(h.storage);
  changed[CONFIG_KEY].config.temperature = 0.7;
  const changedHarness = harness({ storage: changed });
  check(!(await changedHarness.send({ type: 'TRANSLATE', text: 'Sample paragraph' })).cached && changedHarness.stats.apiCalls === 1, 'Parameter change causes cache miss');

  const lru = harness({ config: { ...defaultConfig, cacheMaxEntries: 2 } });
  for (const text of ['a', 'b', 'a', 'c', 'b']) await lru.send({ type: 'TRANSLATE', text });
  check(lru.stats.apiCalls === 4 && lru.storage[CACHE_KEY].length === 2, 'LRU eviction');
  const cacheFailure = harness({ failCache: true });
  check((await cacheFailure.send({ type: 'TRANSLATE', text: 'sample' })).ok, 'Cache failure leaves successful translation');
  check((await cacheFailure.send({ type: 'TRANSLATE', text: 'sample' })).ok && cacheFailure.stats.apiCalls === 2, 'No false cache hits');
  const large = harness({ translation: '译'.repeat(300000) });
  for (const text of ['a', 'b']) await large.send({ type: 'TRANSLATE', text });
  check(large.storage[CACHE_KEY].length === 1, 'Cache character limit');
  const oversized = harness({ translation: '译'.repeat(500001) });
  for (let i = 0; i < 2; i++) check((await oversized.send({ type: 'TRANSLATE', text: 'a' })).ok, 'Oversized result still succeeds');
  check(oversized.stats.apiCalls === 2 && !oversized.storage[CACHE_KEY], 'Oversized result not cached');

  const shared = harness({ delay: 40 });
  const parallel = await Promise.all([shared.send({ type: 'TRANSLATE', text: 'same' }, 1), shared.send({ type: 'TRANSLATE', text: 'same' }, 2)]);
  check(parallel.every((r) => r.ok) && shared.stats.apiCalls === 1, 'Cross-tab in-flight deduplication');
  const locked = harness({ delay: 40 });
  const duplicate = await Promise.all([locked.send({ type: 'TRANSLATE', text: 'a' }), locked.send({ type: 'TRANSLATE', text: 'b' })]);
  check(duplicate[0].ok && duplicate[1].error.code === 'BUSY' && locked.stats.apiCalls === 1, 'Per-tab lock');
  const writes = harness({ delay: 20 });
  await Promise.all([writes.send({ type: 'TRANSLATE', text: 'a' }, 1), writes.send({ type: 'TRANSLATE', text: 'b' }, 2)]);
  check(writes.storage[CACHE_KEY].length === 2, 'Concurrent writes retain both results');

  for (const status of [400, 401, 403, 404, 429, 500]) {
    const failing = harness({ mode: status });
    const result = await failing.send({ type: 'TRANSLATE', text: 'sample' });
    check(!result.ok && result.error.code === `HTTP_${status}`, `HTTP ${status}`);
    check(!JSON.stringify(result).includes(defaultConfig.apiKey) && !JSON.stringify(result).includes('another-secret-key'), 'Redacted error details');
    check(result.error.retryable === [429, 500].includes(status), 'Retry policy');
    check(failing.stats.apiCalls === 1 && !failing.storage[CACHE_KEY], 'No retry and no failed-result cache');
    failing.controls.mode = 'success';
    check((await failing.send({ type: 'TRANSLATE', text: 'sample' })).ok, 'Lock released after failure');
  }
  for (const [mode, code] of [['network', 'NETWORK_ERROR'], ['timeout', 'TIMEOUT'], ['html-error', 'HTTP_404'], ['invalid-json', 'INVALID_RESPONSE'], ['empty', 'EMPTY_TRANSLATION'], ['api-error', 'API_ERROR']]) {
    const failing = harness({ mode, accelerateTimeout: mode === 'timeout' });
    const result = await failing.send({ type: 'TRANSLATE', text: 'sample' });
    check(result.error.code === code, mode);
    check(!JSON.stringify(result).includes(defaultConfig.apiKey), 'No secret in result');
    check(failing.stats.apiCalls === 1 && failing.stats.timers.includes(25000), 'One request and correct timeout');
    failing.controls.mode = 'success';
    check((await failing.send({ type: 'TRANSLATE', text: 'sample' })).ok, 'Lock released');
  }
  const incomplete = harness({ mode: 'incomplete' });
  for (let i = 0; i < 2; i++) check((await incomplete.send({ type: 'TRANSLATE', text: 'sample' })).incomplete, 'Truncation signaled');
  check(incomplete.stats.apiCalls === 2 && !incomplete.storage[CACHE_KEY], 'Truncation not cached');

  const setEnabled = (target, enabled, url = 'chrome-extension://test-extension/popup.html') => target.send({ type: 'SET_PLUGIN_ENABLED', enabled }, 1, { url });
  async function waitFor(predicate) {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw Error('Fixture condition did not become ready');
  }
  const state = harness();
  check((await state.send({ type: 'GET_PLUGIN_STATE' })).enabled === true && state.stats.configLoads === 0, 'Default state is independent of config');
  check((await setEnabled(state, false)).enabled === false && state.localStorage[PLUGIN_KEY] === false, 'Off state persisted');
  check((await state.send({ type: 'TRANSLATE', text: 'sample' })).error.code === 'PLUGIN_DISABLED' && state.stats.apiCalls === 0 && state.stats.configLoads === 0, 'Disabled translation never loads config or calls API');
  const workerRestart = harness({ storage: state.storage, localStorage: state.localStorage });
  check((await workerRestart.send({ type: 'GET_PLUGIN_STATE' })).enabled === false, 'State survives worker restart');
  const browserRestart = harness({ localStorage: state.localStorage });
  check((await browserRestart.send({ type: 'GET_PLUGIN_STATE' })).enabled === false, 'State survives fresh browser session');
  check((await setEnabled(state, true, 'chrome-extension://test-extension/pdf-reader.html?url=fixture')).enabled === true, 'Reader can enable global translation');
  for (const url of ['https://paper.invalid', 'chrome-extension://other/popup.html', 'chrome-extension://test-extension/popup.html.fake', 'chrome-extension://test-extension/unknown.html', 'not-a-url']) {
    check((await setEnabled(state, false, url)).error.code === 'INVALID_SENDER', 'Untrusted state writer rejected');
  }
  check((await state.send({ type: 'SET_PLUGIN_ENABLED', enabled: false }, 1, { url: 'chrome-extension://test-extension/popup.html', frameId: 1 })).error.code === 'INVALID_SENDER', 'Embedded writer rejected');
  check((await setEnabled(state, 'false')).error.code === 'INVALID_STATE', 'Boolean state required');
  check((await state.send({ type: 'GET_PLUGIN_STATE' })).enabled, 'Invalid writes preserve state');
  state.controls.failStateWrite = true;
  check((await setEnabled(state, false)).error.code === 'STATE_STORAGE', 'Persistence failure reported');
  check((await state.send({ type: 'GET_PLUGIN_STATE' })).enabled && state.localStorage[PLUGIN_KEY], 'Failed save preserves enabled state');
  state.controls.failStateWrite = false;
  const unreadable = harness(); unreadable.controls.failStateRead = true;
  check((await unreadable.send({ type: 'GET_PLUGIN_STATE' })).error.code === 'STATE_STORAGE', 'State read fails safely');
  unreadable.controls.failStateRead = false;
  check((await unreadable.send({ type: 'GET_PLUGIN_STATE' })).enabled, 'State read can recover');
  const badConfigState = harness({ mode: 'missing-config' });
  check(!(await badConfigState.send({ type: 'GET_CONFIG_STATUS' })).ok && (await setEnabled(badConfigState, false)).ok && (await setEnabled(badConfigState, true)).ok, 'Config error does not block switch');
  await state.send({ type: 'TRANSLATE', text: 'cached' });
  await setEnabled(state, false);
  check((await state.send({ type: 'TRANSLATE', text: 'cached' })).error.code === 'PLUGIN_DISABLED', 'Cached translation blocked while off');
  await setEnabled(state, true);
  check((await state.send({ type: 'TRANSLATE', text: 'cached' })).cached, 'Existing cache retained after enabling');

  const cancelled = harness({ delay: 150 });
  const requests = [cancelled.send({ type: 'TRANSLATE', text: 'same' }, 1), cancelled.send({ type: 'TRANSLATE', text: 'same' }, 2), cancelled.send({ type: 'TRANSLATE', text: 'other' }, 3)];
  await waitFor(() => cancelled.stats.apiCalls === 2);
  await setEnabled(cancelled, false);
  const results = await Promise.all(requests);
  check(results.every((r) => r.error?.code === 'PLUGIN_DISABLED'), 'Shared and independent requests cancelled');
  check(cancelled.stats.aborted === 2 && !cancelled.storage[CACHE_KEY], 'All controllers aborted without caching cancelled results');
  await setEnabled(cancelled, true); cancelled.controls.delay = 0;
  check((await cancelled.send({ type: 'TRANSLATE', text: 'same' }, 1)).ok, 'Cancellation releases locks');

  const late = harness({ delay: 120 }); late.controls.ignoreAbort = true;
  const old = late.send({ type: 'TRANSLATE', text: 'late' });
  await waitFor(() => late.stats.apiCalls === 1);
  await setEnabled(late, false); await setEnabled(late, true);
  late.controls.delay = 180;
  const fresh = late.send({ type: 'TRANSLATE', text: 'late' });
  check((await old).error.code === 'PLUGIN_DISABLED', 'Late response rejected after off/on');
  check((await late.send({ type: 'TRANSLATE', text: 'different' })).error.code === 'BUSY', 'Old finalizer does not release new request lock');
  check((await fresh).ok && late.stats.apiCalls === 2, 'New request never reuses old pending task');

  const configPending = harness();
  let releaseConfig;
  configPending.controls.configGate = new Promise((resolve) => { releaseConfig = resolve; });
  const beforeConfig = configPending.send({ type: 'TRANSLATE', text: 'pending-config' });
  await waitFor(() => configPending.stats.configLoads === 1);
  await setEnabled(configPending, false); releaseConfig();
  check((await beforeConfig).error.code === 'PLUGIN_DISABLED' && configPending.stats.apiCalls === 0, 'No API call if switched off during config load');

  const cachePending = harness();
  await cachePending.send({ type: 'TRANSLATE', text: 'pending-cache' });
  let releaseCache;
  cachePending.controls.cacheReadGate = new Promise((resolve) => { releaseCache = resolve; });
  const beforeCache = cachePending.send({ type: 'TRANSLATE', text: 'pending-cache' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setEnabled(cachePending, false); releaseCache();
  check((await beforeCache).error.code === 'PLUGIN_DISABLED' && cachePending.stats.apiCalls === 1, 'Cache response suppressed after disabling');
  const report = { suite: 'background-mocked', assertions, status: 'passed', usesRealApi: false };
  fs.writeFileSync(path.join(__dirname, 'background-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { harness };
