// Edge 引擎兼容性验证：同一阅读页通过本地 HTTP 服务运行，模拟 chrome.runtime。
// 这不是 Edge 的真实扩展加载测试；使用临时浏览器配置，不接触日常浏览器和用户密钥。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const playwrightPath = process.argv[2] || 'playwright';
const { chromium } = require(playwrightPath);
const { PDFDocument, StandardFonts } = require(process.argv[3] || path.join(path.dirname(playwrightPath), 'pdf-lib'));
const root = path.resolve(__dirname, '..');
const checks = [];
function check(condition, label) { assert.ok(condition, label); checks.push(label); }
async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-edge-pdf-'));
  const document = await PDFDocument.create(); const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText('Edge reads scientific PDF text.', { x: 50, y: 720, font, size: 16 });
  document.addPage().drawText('Second scientific page.', { x: 50, y: 720, font, size: 16 });
  const filePath = path.join(fixture, 'edge-research.pdf'); fs.writeFileSync(filePath, await document.save());
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const target = path.resolve(root, '.' + pathname);
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile() || pathname === '/config.json') { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Security-Policy', "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';");
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
    response.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
    response.end(fs.readFileSync(target));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((origin) => {
      globalThis.chrome = { runtime: {
        getURL: (resource) => origin + '/' + resource,
        sendMessage: async (message) => message.type === 'GET_CONFIG_STATUS'
          ? { ok: true, model: 'edge-mock', ready: true, maxTextLength: 5000 }
          : { ok: true, translation: 'Edge 模拟译文：' + message.text, cached: false, incomplete: false },
      } };
    }, origin);
    await page.goto(origin + '/pdf-reader.html');
    await page.locator('html[data-reader-ready="true"]').waitFor();
    await page.locator('#file-input').setInputFiles(filePath);
    await page.waitForFunction(() => document.querySelector('#reader-status').dataset.state === 'ready' && document.querySelector('#page-count').textContent === '/ 2');
    check(await page.locator('.textLayer span').filter({ hasText: 'Edge reads' }).count() === 1, 'Edge renders PDF text layer');
    await page.locator('.textLayer span').filter({ hasText: 'Edge reads' }).evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element); window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    });
    await page.keyboard.press('y'); await page.getByRole('button', { name: '复制译文', exact: true }).waitFor();
    check((await page.locator('#literature-translator-panel .text').textContent()).includes('Edge reads scientific PDF text.'), 'Edge Y selection translation UI works with mock backend');
    await page.keyboard.press('Escape');
    check(await page.locator('#literature-translator-panel').count() === 0, 'Edge closes translation panel');
    const scale = await page.locator('#zoom-value').textContent(); await page.locator('#zoom-in').click();
    check((await page.locator('#zoom-value').textContent()) !== scale, 'Edge zoom works');
    await page.locator('#next-page').click();
    await page.waitForFunction(() => document.querySelector('#page-number').value === '2' && document.querySelector('#reader-status').dataset.state === 'ready');
    check(await page.locator('.page[data-page-number="2"] .textLayer span').filter({ hasText: 'Second scientific page' }).count() === 1, 'Edge second page renders');
    await page.screenshot({ path: path.join(__dirname, 'edge-pdf-reader.png') });
    check(errors.length === 0, `Edge has no uncaught exceptions: ${errors.join('; ')}`);
    const report = { suite: 'edge-reader-runtime', status: 'passed', assertions: checks.length, checks, edgeVersion: browser.version(), usesRealApi: false, notes: 'Real Microsoft Edge engine, HTTP-hosted reader, mocked chrome.runtime. NOT a native Edge extension installation test.' };
    fs.writeFileSync(path.join(__dirname, 'edge-reader-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
