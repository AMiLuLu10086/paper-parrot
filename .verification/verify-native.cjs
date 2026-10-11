// 使用独立 Chromium 测试配置加载真实 MV3 扩展。运行文件复制到临时目录，
// 只有临时 config.json 使用本地模拟接口；项目根目录的配置和用户浏览器不改动。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.resolve(__dirname, '..');
let checks = 0;
function check(condition, label) { assert.ok(condition, label); checks++; }
async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-mv3-'));
  const extension = path.join(fixture, 'extension');
  fs.mkdirSync(extension);
  // 不复制用户 config.json，避免将未来填写的真实密钥带入临时测试目录。
  for (const name of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js', 'pdf-reader.html', 'pdf-reader.js', 'pdf-reader.css']) fs.copyFileSync(path.join(root, name), path.join(extension, name));
  fs.cpSync(path.join(root, 'vendor'), path.join(extension, 'vendor'), { recursive: true });
  let apiCalls = 0;
  let apiMode = 'success';
  let apiDelay = 0;
  let lastBody;
  const mockKey = 'verification-only-secret';
  const server = http.createServer(async (request, response) => {
    if (request.url === '/v1/chat/completions') {
      apiCalls++;
      let body = '';
      for await (const chunk of request) body += chunk;
      lastBody = JSON.parse(body);
      // 特意不设置 Access-Control-Allow-Origin，验证后台主机权限与 CORS 的区别。
      if (apiDelay) await new Promise((resolve) => setTimeout(resolve, apiDelay));
      response.setHeader('Content-Type', 'application/json');
      if (apiMode === '429') { response.writeHead(429); response.end(JSON.stringify({ error: { message: `Rejected ${mockKey}` } })); return; }
      response.end(JSON.stringify({ choices: [{ message: { content: '<img src=x onerror="alert(1)">科研文献译文。' }, finish_reason: 'stop' }] }));
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>原生 MV3 验证</title></head><body><h1>原生扩展验证</h1><p id="original">Scientific translation preserves terminology and mathematical notation.</p><p id="other">Another paragraph for concurrency verification.</p><p id="long">' + 'A'.repeat(101) + '</p><input aria-label="输入框"><textarea aria-label="多行输入框"></textarea><div contenteditable="true" aria-label="编辑区域">Editor</div></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(extension, 'config.json'), JSON.stringify({ model: 'verification-model', baseUrl: `${origin}/v1`, apiKey: mockKey, temperature: 0.3, maxTextLength: 100, cacheMaxEntries: 2 }, null, 2));
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(fixture, 'profile'), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extensionId = worker.url().split('/')[2];
    check(Boolean(extensionId), 'Service worker loaded');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.getByText('verification-model', { exact: true }).waitFor();
    check((await popup.locator('#model-name').textContent()) === 'verification-model', 'Popup reads backend snapshot');
    check(!(await popup.content()).includes(mockKey), 'Popup has no secret');

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(origin);
    await page.waitForLoadState('networkidle');
    async function select(selector) {
      await page.evaluate((selector) => {
        document.activeElement?.blur();
        const range = document.createRange(); range.selectNodeContents(document.querySelector(selector));
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }, selector);
    }
    const panel = page.locator('#literature-translator-panel');
    await page.keyboard.press('y');
    check(await panel.count() === 0, 'Empty selection ignored');
    await select('#original');
    await page.keyboard.press('Control+y');
    check(await panel.count() === 0 && apiCalls === 0, 'Modifier ignored');
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true })));
    check(await panel.count() === 0 && apiCalls === 0, 'Untrusted key ignored');
    await page.keyboard.press('y');
    await page.getByRole('button', { name: '复制译文', exact: true }).waitFor();
    check(apiCalls === 1, 'Cross-origin backend request succeeds without CORS headers');
    check(lastBody.model === 'verification-model' && lastBody.messages[1].content.startsWith('Scientific'), 'Actual message reaches API');
    check((await panel.locator('.text').textContent()).includes('<img'), 'HTML rendered as text');
    check(await panel.locator('img').count() === 0 && !pageErrors.length, 'No execution of response HTML');
    await page.keyboard.press('Escape');
    check(await panel.count() === 0, 'Esc closes actual extension panel');
    await select('#original');
    await page.keyboard.press('Y');
    await page.getByRole('button', { name: '复制译文', exact: true }).waitFor();
    check((await panel.locator('.note').textContent()).includes('来自缓存') && apiCalls === 1, 'Native session cache hit');
    await page.getByRole('button', { name: '关闭翻译窗口', exact: true }).click();
    await select('#long');
    await page.keyboard.press('y');
    await panel.locator('.text[data-state="error"]').waitFor();
    check((await panel.locator('.text').textContent()).includes('101') && apiCalls === 1, 'Native length limit');
    await page.keyboard.press('Escape');
    await select('#original');
    await page.getByLabel('输入框', { exact: true }).press('y');
    check(await page.getByLabel('输入框', { exact: true }).inputValue() === 'y' && await panel.count() === 0, 'Native input preserved');
    await page.getByLabel('多行输入框', { exact: true }).press('y');
    check(await page.getByLabel('多行输入框', { exact: true }).inputValue() === 'y', 'Native textarea preserved');
    await page.getByLabel('编辑区域', { exact: true }).press('y');
    check((await page.getByLabel('编辑区域', { exact: true }).textContent()).includes('y') && apiCalls === 1, 'Native editor preserved');
    await select('#other');
    apiDelay = 500;
    await page.keyboard.press('y');
    await page.keyboard.press('y');
    await page.getByRole('button', { name: '复制译文', exact: true }).waitFor();
    check(apiCalls === 2, 'Native concurrent key lock');
    await page.keyboard.press('Escape');
    const secondPage = await context.newPage();
    await secondPage.goto(origin);
    await secondPage.waitForLoadState('networkidle');
    await secondPage.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.getElementById('original'));
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    });
    await secondPage.keyboard.press('y');
    await secondPage.getByRole('button', { name: '复制译文', exact: true }).waitFor();
    check((await secondPage.locator('#literature-translator-panel .note').textContent()).includes('来自缓存') && apiCalls === 2, 'Cross-tab native cache');

    // 直接由网页尝试 fetch 配置必须失败，不通过生产代码绕过权限。
    const configBlocked = await page.evaluate(async (url) => {
      try { const response = await fetch(url); return !response.ok; } catch { return true; }
    }, `chrome-extension://${extensionId}/config.json`);
    check(configBlocked, 'Web page cannot fetch packaged configuration');

    await page.evaluate(() => { document.getElementById('original').textContent = 'Fresh text for retry verification.'; });
    await select('#original');
    apiMode = '429'; apiDelay = 0;
    await page.keyboard.press('y');
    await page.getByRole('button', { name: '重试', exact: true }).waitFor();
    check((await panel.locator('.text').textContent()).includes('429') && !(await panel.locator('.text').textContent()).includes(mockKey), 'Native error redaction and retry');
    const beforeFakeClick = apiCalls;
    await page.getByRole('button', { name: '重试', exact: true }).evaluate((button) => button.click());
    check(apiCalls === beforeFakeClick, 'Untrusted retry click ignored');
    apiMode = 'success';
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByRole('button', { name: '复制译文', exact: true }).waitFor();
    check(apiCalls === beforeFakeClick + 1, 'Native retry uses saved selection');

    await page.screenshot({ path: path.join(__dirname, 'native-extension.png') });
    await popup.screenshot({ path: path.join(__dirname, 'native-popup.png') });
    check(!pageErrors.length, 'No page exceptions');
    const report = { suite: 'native-chromium-mv3', status: 'passed', assertions: checks, chromiumVersion: context.browser().version(), usesRealApi: false, notes: 'Tested unpacked MV3 in isolated Chromium. Branded Chrome and Edge developer-mode loading remains manual.' };
    fs.writeFileSync(path.join(__dirname, 'native-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally {
    if (context) await context.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    // 不自动删除临时目录，遵守用户的文件删除确认规则。
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
