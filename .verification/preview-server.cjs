// 仅供本地验证：把真正的 content.js / popup.js 接到模拟后台，不加载真实扩展或 API 密钥。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { harness } = require('./verify-background.cjs');
const root = path.resolve(__dirname, '..');
const localStorage = {};
let background = harness({ delay: 500, localStorage });
let messages = 0;

const bridge = `<script>
  const storageListeners = [];
  let lastEnabled;
  window.chrome = { storage: { onChanged: { addListener: (handler) => storageListeners.push(handler) } }, runtime: { getURL: (resource) => location.origin + '/' + resource, sendMessage: async (message) => {
    const response = await fetch('/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
    if (!response.ok) throw new Error('Simulated communication failure');
    return response.json();
  } } };
  async function control(mode) {
    await fetch('/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
    document.getElementById('mode').textContent = mode;
  }
  // 验证用剪贴板不会改动用户的系统剪贴板，只展示复制结果。
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text) => {
      if (document.getElementById('mode')?.textContent === 'copy-failure') throw new Error('Mock clipboard rejected');
      document.getElementById('copied').textContent = '已复制内容：' + text;
    }
  } });
  function selectOriginal() {
    document.activeElement?.blur();
    const selection = window.getSelection(); selection.removeAllRanges();
    const range = document.createRange(); range.selectNodeContents(document.getElementById('original')); selection.addRange(range);
  }
  function selectLong() {
    document.activeElement?.blur();
    const selection = window.getSelection(); selection.removeAllRanges();
    const range = document.createRange(); range.selectNodeContents(document.getElementById('long')); selection.addRange(range);
  }
  function clearSelection() { document.activeElement?.blur(); window.getSelection().removeAllRanges(); }
  window.addEventListener('DOMContentLoaded', () => {
    document.querySelector('#shadow-input').attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="Shadow 输入框" placeholder="Shadow 输入框">';
    const closed = document.querySelector('#closed-input').attachShadow({ mode: 'closed' });
    closed.innerHTML = '<input aria-label="闭合 Shadow 输入框" placeholder="闭合 Shadow 输入框">';
    document.querySelector('#focus-closed').onclick = () => closed.querySelector('input').focus();
  });
  setInterval(async () => {
    const response = await fetch('/stats'); const stats = await response.json();
    const statsElement = document.getElementById('stats');
    if (statsElement) statsElement.textContent = 'API 请求次数：' + stats.apiCalls + '；翻译消息次数：' + stats.messages;
    if (lastEnabled !== stats.enabled) {
      lastEnabled = stats.enabled;
      for (const handler of storageListeners) handler({ literaturePluginEnabledV1: { newValue: stats.enabled } }, 'local');
    }
  }, 300);
</script>`;

const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>paper-parrot 本地验证</title>
<style>body { margin: 48px; background: #f5f8fb; color: #24334a; font: 15px/1.7 'Segoe UI','Microsoft YaHei',sans-serif; max-width: 750px; } button { padding: 7px 12px; margin: 5px; } input,textarea,[contenteditable] { display:block; margin:10px 0; padding:8px; } #long { height:48px; overflow:auto; overflow-wrap:anywhere; } .controls { margin:20px 0; } </style>
${bridge}<script src="/content.js" defer></script></head><body>
<h1>paper-parrot · 本地模拟验证</h1><p>此页面只使用模拟模型响应，不发送真实 API 请求。</p>
<p id="original">Scientific translation preserves terminology, citations, and mathematical notation.</p>
<button onclick="selectOriginal()">选择示例原文</button><button onclick="selectLong()">选择超长原文</button><button onclick="clearSelection()">清除选区</button>
<div class="controls"><button onclick="control('success')">正常响应</button><button onclick="control('slow')">模拟慢响应</button><button onclick="control(429)">模拟限流</button><button onclick="control('network')">模拟断网</button><button onclick="control('communication')">模拟通信失效</button><button onclick="control('incomplete')">模拟截断</button><button onclick="control('markup')">模拟 HTML 译文</button><button onclick="control('copy-failure')">模拟复制失败</button><button onclick="control('reset')">重置缓存</button></div>
<p>当前模拟状态：<span id="mode">success</span></p><p id="stats" role="status">API 请求次数：0；翻译消息次数：0</p><p id="copied">尚未复制</p>
<label>普通输入框<input aria-label="普通输入框"></label><label>多行输入框<textarea aria-label="多行输入框"></textarea></label>
<div role="textbox" aria-label="可编辑区域" contenteditable="true">可编辑区域</div>
<div id="shadow-input"></div><closed-editor id="closed-input"></closed-editor><button id="focus-closed">聚焦闭合输入框</button>
<p id="long" aria-hidden="true">${'A'.repeat(5001)}</p><a href="/popup">查看 popup</a>
</body></html>`;

async function readBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'POST' && url.pathname === '/message') {
      const message = await readBody(request);
      if (background.controls.mode === 'communication') { response.writeHead(503); response.end('Unavailable'); return; }
      if (message.type === 'TRANSLATE') messages++;
      const result = await background.send(message, 1, message.type === 'SET_PLUGIN_ENABLED' ? { url: 'chrome-extension://test-extension/popup.html' } : {});
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result)); return;
    }
    if (request.method === 'POST' && url.pathname === '/control') {
      const { mode } = await readBody(request);
      if (mode === 'reset') { background = harness({ delay: 500, localStorage }); messages = 0; }
      else { background = harness({ mode: ['markup', 'copy-failure', 'slow'].includes(mode) ? 'success' : mode, delay: mode === 'slow' ? 3000 : 500, translation: mode === 'markup' ? '<img src=x onerror="alert(1)">科研译文' : '科研译文', localStorage }); messages = 0; }
      response.end('ok'); return;
    }
    if (url.pathname === '/stats') {
      const state = await background.send({ type: 'GET_PLUGIN_STATE' });
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ apiCalls: background.stats.apiCalls, messages, enabled: state.enabled })); return;
    }
    if (['/content.js', '/popup.js', '/plugin-control.js'].includes(url.pathname)) {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(fs.readFileSync(path.join(root, url.pathname.slice(1)))); return;
    }
    if (url.pathname === '/ui.css') {
      response.setHeader('Content-Type', 'text/css; charset=utf-8'); response.end(fs.readFileSync(path.join(root, 'ui.css'))); return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/popup') {
      response.end(fs.readFileSync(path.join(root, 'popup.html'), 'utf8').replace('<script src="popup.js" defer></script>', bridge + '<script src="/popup.js" defer></script>'));
    } else response.end(page);
  } catch {
    response.writeHead(500); response.end('Mock server error');
  }
});
server.listen(8765, '127.0.0.1', () => console.log('Mock preview ready: http://127.0.0.1:8765'));
