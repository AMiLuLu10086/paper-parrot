// Isolated MV3 UI checks with long mock content and controlled failure responses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.resolve(__dirname, '..');
const checks = [];
function check(condition, label) { assert.ok(condition, label); checks.push(label); }

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-ui-'));
  const extension = path.join(fixture, 'extension'); fs.mkdirSync(extension);
  for (const name of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js', 'pdf-reader.html', 'pdf-reader.js', 'pdf-reader.css', 'plugin-control.js', 'ui.css']) {
    fs.copyFileSync(path.join(root, name), path.join(extension, name));
  }
  fs.cpSync(path.join(root, 'vendor'), path.join(extension, 'vendor'), { recursive: true });
  let mode = 'success';
  const server = http.createServer(async (request, response) => {
    if (request.url === '/v1/chat/completions') {
      for await (const _ of request) { /* Discard the fixture request body. */ }
      response.setHeader('Content-Type', 'application/json');
      if (mode === 'error') {
        response.writeHead(429); response.end(JSON.stringify({ error: { message: 'Fixture rate limit' } }));
      } else response.end(JSON.stringify({ choices: [{ message: { content: '这是一段用于验证长译文滚动、科学术语与复制功能的模拟译文。\n'.repeat(120) }, finish_reason: 'stop' }] }));
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><body><p id="source">Long translation UI fixture.</p><p id="error-source">Error UI fixture.</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const configPath = path.join(extension, 'config.json');
  const mockConfig = { model: 'mock-scientific-translation-model-with-an-extremely-long-version-name-2026-10-11', baseUrl: origin + '/v1', apiKey: 'ui-test-only-key', temperature: .3 };
  fs.writeFileSync(configPath, JSON.stringify(mockConfig));
  let context;
  const pageErrors = [];
  const profile = path.join(fixture, 'profile');
  const launch = async () => {
    const browserContext = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    browserContext.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
    return browserContext;
  };
  try {
    context = await launch();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const base = worker.url().replace('/background.js', '');
    const popup = await context.newPage(); await popup.setViewportSize({ width: 360, height: 600 });
    await popup.goto(base + '/popup.html'); await popup.waitForLoadState('networkidle');
    await popup.waitForFunction(() => !document.getElementById('plugin-toggle').disabled);
    check((await popup.locator('#model-name').textContent()) === mockConfig.model, 'Long model name fully preserved');
    check(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.getElementById('model-name').scrollWidth <= document.getElementById('model-name').clientWidth), 'Long model wraps without horizontal overflow');
    await popup.screenshot({ path: path.join(__dirname, 'ios-popup-long-model.png'), fullPage: true });

    // Fault injection affects only this temporary extension page, never the project config.
    await popup.evaluate(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message) => message.type === 'SET_PLUGIN_ENABLED'
        ? Promise.resolve({ ok: false, error: { message: '开关保存失败，已保留原状态，请重试。' } }) : send(message);
    });
    await popup.locator('#plugin-toggle').click();
    await popup.getByText('开关保存失败，已保留原状态，请重试。', { exact: true }).waitFor();
    check(await popup.locator('#plugin-toggle').getAttribute('aria-checked') === 'true' && await popup.locator('#plugin-toggle').isEnabled(), 'Save failure preserves state and allows retry');
    await popup.screenshot({ path: path.join(__dirname, 'ios-popup-save-error.png'), fullPage: true });
    await popup.reload(); await popup.waitForFunction(() => !document.getElementById('plugin-toggle').disabled);
    await popup.emulateMedia({ reducedMotion: 'reduce' });
    check(await popup.locator('#plugin-toggle').evaluate((element) => getComputedStyle(element).transitionDuration === '0s'), 'Reduced motion disables switch animation');
    await popup.locator('#plugin-toggle').focus();
    check(await popup.locator('#plugin-toggle').evaluate((element) => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle !== 'none'), 'Switch has visible keyboard focus');
    await popup.keyboard.press('Space');
    await popup.waitForFunction(() => document.getElementById('plugin-toggle').getAttribute('aria-checked') === 'false' && !document.getElementById('plugin-toggle').disabled);
    check(await popup.locator('#plugin-toggle').getAttribute('aria-checked') === 'false', 'Space toggles off');
    check(await popup.locator('#plugin-toggle').evaluate((element) => document.activeElement === element), 'Keyboard focus survives asynchronous persistence');
    await popup.screenshot({ path: path.join(__dirname, 'ios-popup-off.png'), fullPage: true });
    await popup.keyboard.press('Enter');
    await popup.waitForFunction(() => document.getElementById('plugin-toggle').getAttribute('aria-checked') === 'true' && !document.getElementById('plugin-toggle').disabled);
    check(await popup.locator('#plugin-toggle').getAttribute('aria-checked') === 'true', 'Enter toggles on');

    const page = await context.newPage(); await page.goto(origin); await page.waitForLoadState('networkidle');
    async function select(id) {
      await page.locator(id).evaluate((element) => {
        document.activeElement?.blur(); const range = document.createRange(); range.selectNodeContents(element);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      });
    }
    await select('#source'); await page.keyboard.press('y');
    const panel = page.locator('#literature-translator-panel');
    await page.getByRole('button', { name: '复制译文', exact: true }).waitFor();
    check(await panel.locator('.text').evaluate((element) => element.scrollHeight > element.clientHeight), 'Long translation scrolls inside panel');
    check(await panel.locator('.panel').evaluate((element) => getComputedStyle(element).borderRadius === '20px'), 'Result uses iOS rounded card');
    await page.screenshot({ path: path.join(__dirname, 'ios-long-translation.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await panel.locator('.panel').boundingBox();
    check(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, 'Long translation stays within narrow viewport');
    await page.getByRole('button', { name: '复制译文', exact: true }).click();
    const copied = (await panel.locator('.actions').textContent()).includes('已复制');
    check(copied || (await panel.locator('.note').textContent()).includes('手动复制'), 'Copy succeeds or gives manual-copy recovery');
    await page.keyboard.press('Escape'); mode = 'error';
    await select('#error-source'); await page.keyboard.press('y');
    await page.getByRole('button', { name: '重试', exact: true }).waitFor();
    check((await panel.locator('.text').textContent()).includes('429'), 'Error panel retains retry and readable error');
    await page.screenshot({ path: path.join(__dirname, 'ios-translation-error.png') });

    // Both controls remain usable when configuration is missing on next browser startup.
    await popup.locator('#plugin-toggle').click();
    await popup.waitForFunction(() => document.getElementById('plugin-toggle').getAttribute('aria-checked') === 'false' && !document.getElementById('plugin-toggle').disabled);
    await context.close(); context = null;
    fs.writeFileSync(configPath, '{invalid-fixture-json');
    context = await launch();
    const disabledWeb = await context.newPage(); await disabledWeb.goto(origin); await disabledWeb.waitForLoadState('networkidle');
    check(await disabledWeb.locator('#literature-translator-panel').count() === 0, 'Disabled initialization suppresses broken-config panel');
    const badPopup = await context.newPage(); await badPopup.setViewportSize({ width: 360, height: 600 });
    await badPopup.goto(base + '/popup.html');
    await badPopup.waitForFunction(() => document.getElementById('status').dataset.state === 'error' && !document.getElementById('plugin-toggle').disabled);
    check(await badPopup.locator('#plugin-toggle').getAttribute('aria-checked') === 'false', 'Broken config does not block reading switch state');
    await badPopup.screenshot({ path: path.join(__dirname, 'ios-popup-config-error.png'), fullPage: true });
    await badPopup.locator('#plugin-toggle').click();
    await badPopup.waitForFunction(() => document.getElementById('plugin-toggle').getAttribute('aria-checked') === 'true' && !document.getElementById('plugin-toggle').disabled);
    check(await badPopup.locator('#plugin-toggle').getAttribute('aria-checked') === 'true', 'Broken config does not block enabling');
    await badPopup.locator('#plugin-toggle').click();
    await badPopup.waitForFunction(() => document.getElementById('plugin-toggle').getAttribute('aria-checked') === 'false' && !document.getElementById('plugin-toggle').disabled);
    await disabledWeb.locator('#literature-translator-panel').waitFor({ state: 'detached' });
    check(await badPopup.locator('#plugin-toggle').getAttribute('aria-checked') === 'false', 'Broken config does not block disabling and hiding errors');
    const badReader = await context.newPage(); await badReader.goto(base + '/pdf-reader.html');
    await badReader.locator('html[data-reader-ready="true"]').waitFor();
    check(await badReader.locator('#open-file').isEnabled(), 'Broken translation config leaves reader functional');
    check(pageErrors.length === 0, 'All UI scenarios have no uncaught exceptions');

    const report = { suite: 'ios-ui-native-mv3', status: 'passed', assertions: checks.length, checks, usesRealApi: false };
    fs.writeFileSync(path.join(__dirname, 'ui-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally {
    if (context) await context.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
