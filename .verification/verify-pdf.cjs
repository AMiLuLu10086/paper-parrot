// 真实 MV3 + 本地合成 PDF + 无 CORS 模拟服务。不读取或复制用户 config.json。
// 使用独立 Chromium 临时配置，不修改日常 Chrome / Edge，不自动删除文件。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const playwrightPath = process.argv[2] || 'playwright';
const { chromium } = require(playwrightPath);
const { PDFDocument, StandardFonts, rgb } = require(process.argv[3] || path.join(path.dirname(playwrightPath), 'pdf-lib'));
const root = path.resolve(__dirname, '..');
let assertions = 0;
const checks = [];
function check(condition, label) { assert.ok(condition, label); assertions++; checks.push(label); }

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-pdf-'));
  const extension = path.join(fixture, 'extension');
  fs.mkdirSync(extension);
  for (const name of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js', 'pdf-reader.html', 'pdf-reader.js', 'pdf-reader.css']) fs.copyFileSync(path.join(root, name), path.join(extension, name));
  fs.cpSync(path.join(root, 'vendor'), path.join(extension, 'vendor'), { recursive: true });
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  function text(page, value, x, y, size = 14) { page.drawText(value, { x, y, size, font }); }
  const first = document.addPage([612, 792]);
  text(first, 'Scientific literature - PDF selection test', 52, 734, 20);
  text(first, 'Scientific evidence improves water treatment.', 52, 682);
  text(first, 'Catalytic reactions preserve scientific terminology.', 52, 654);
  text(first, 'A'.repeat(120), 52, 625, 5);
  const second = document.addPage([612, 792]);
  text(second, 'Two-column research article', 52, 734, 20);
  text(second, 'Left column research findings.', 40, 680, 11);
  text(second, 'Left column chemical evidence.', 40, 660, 11);
  text(second, 'Right column catalytic analysis.', 326, 680, 11);
  text(second, 'Right column independent results.', 326, 660, 11);
  const third = document.addPage([612, 792]);
  // 无文字页模拟扫描文献的文本层缺失；不会声称在做 OCR。
  third.drawRectangle({ x: 50, y: 100, width: 512, height: 580, color: rgb(.85, .86, .88) });
  const bytes = Buffer.from(await document.save());
  const localPdf = path.join(fixture, 'research.pdf');
  fs.writeFileSync(localPdf, bytes);
  const corrupt = path.join(fixture, 'invalid.pdf');
  fs.writeFileSync(corrupt, 'This is not a PDF.');
  const encrypted = path.join(fixture, 'encrypted.pdf');
  const encryption = spawnSync('python', ['-c', 'from pypdf import PdfReader,PdfWriter; import sys; r=PdfReader(sys.argv[1]); w=PdfWriter(); [w.add_page(p) for p in r.pages]; w.encrypt("fixture-password"); w.write(sys.argv[2])', localPdf, encrypted], { encoding: 'utf8' });
  assert.equal(encryption.status, 0, encryption.stderr);
  let apiCalls = 0;
  let apiDelay = 0;
  let apiMode = 'success';
  let lastText = '';
  const server = http.createServer(async (request, response) => {
    if (request.url === '/v1/chat/completions') {
      apiCalls++;
      let raw = '';
      for await (const part of request) raw += part;
      lastText = JSON.parse(raw).messages[1].content;
      const delay = apiDelay;
      const mode = apiMode;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      response.setHeader('Content-Type', 'application/json');
      if (mode === '429') { response.writeHead(429); response.end(JSON.stringify({ error: { message: 'Fixture rate limit' } })); }
      else response.end(JSON.stringify({ choices: [{ message: { content: 'PDF 科研译文：' + lastText }, finish_reason: 'stop' }] }));
      return;
    }
    if (request.url.startsWith('/download') || request.url === '/paper.pdf') {
      // 不设置 CORS 响应头；扩展页通过现有 host_permissions 获取公开在线 PDF。
      response.setHeader('Content-Type', 'application/pdf');
      response.setHeader('Content-Length', bytes.length);
      response.end(bytes); return;
    }
    if (request.url === '/blocked') { response.writeHead(403); response.end('Forbidden'); return; }
    if (request.url === '/not-pdf') { response.end('<html>Login page</html>'); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<html><body><p id="source">Ordinary HTML translation still works.</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(extension, 'config.json'), JSON.stringify({ model: 'pdf-test-model', baseUrl: `${origin}/v1`, apiKey: 'test-only-not-real', temperature: .3, maxTextLength: 100, cacheMaxEntries: 100 }));
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(fixture, 'profile'), { channel: 'chromium', headless: true, viewport: { width: 1365, height: 1000 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = worker.url().split('/')[2];
    const base = `chrome-extension://${extensionId}`;
    const reader = await context.newPage();
    const pageErrors = [];
    reader.on('pageerror', (error) => pageErrors.push(error.message));
    await reader.goto(`${base}/pdf-reader.html`);
    await reader.locator('html[data-reader-ready="true"]').waitFor();
    check(await reader.locator('#empty-state').isVisible(), 'Empty reader explains how to open a file');
    check(await reader.locator('#previous-page').isDisabled(), 'Navigation disabled without PDF');
    async function file(filePath) {
      await reader.locator('#file-input').setInputFiles(filePath);
    }
    async function ready(pageNumber = 1) {
      await reader.waitForFunction((pageNumber) => document.querySelector('#page-number').value === String(pageNumber) && document.querySelector('#reader-status').dataset.state === 'ready', pageNumber);
      await reader.locator(`.page[data-page-number="${pageNumber}"] .textLayer span`).first().waitFor();
    }
    async function selectText(value, pageNumber = 1) {
      const span = reader.locator(`.page[data-page-number="${pageNumber}"] .textLayer span`).filter({ hasText: value }).first();
      await span.scrollIntoViewIfNeeded();
      await span.evaluate((element) => {
        document.activeElement?.blur();
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      });
      return (await span.textContent()).trim();
    }
    const panel = reader.locator('#literature-translator-panel');
    const translationReady = () => reader.getByRole('button', { name: '复制译文', exact: true }).waitFor();
    await file(localPdf); await ready();
    check((await reader.locator('#document-name').textContent()) === 'research.pdf', 'Local file opens without file URL permissions');
    check((await reader.locator('#page-count').textContent()) === '/ 3', 'Multi-page count displayed');
    check(await reader.locator('.page[data-page-number="1"] canvas').count() === 1, 'First page rendered as canvas with selectable text layer');
    check(await reader.locator('.page[data-page-number="3"] canvas').count() === 0, 'Offscreen page not eagerly rendered');
    await reader.keyboard.press('y');
    check(await panel.count() === 0 && apiCalls === 0, 'Empty PDF selection ignored');
    const original = await selectText('Scientific evidence');
    await reader.keyboard.press('Control+y');
    check(apiCalls === 0, 'PDF modifier key ignored');
    await reader.keyboard.press('y'); await reader.keyboard.press('y'); await translationReady();
    check(apiCalls === 1 && lastText === original, 'Real Y translates only selected text once');
    check((await panel.locator('.text').textContent()).includes(original), 'PDF result uses existing floating panel');
    await reader.getByRole('button', { name: '复制译文', exact: true }).click();
    check(await panel.count() === 1, 'Copy keeps PDF result visible');
    await reader.keyboard.press('Escape');
    check(await panel.count() === 0, 'Escape closes PDF result');
    await selectText('Scientific evidence'); await reader.keyboard.press('Y'); await translationReady();
    check(apiCalls === 1 && (await panel.locator('.note').textContent()).includes('来自缓存'), 'PDF cache hit');
    await reader.keyboard.press('Escape');
    await selectText('Scientific evidence');
    await reader.locator('#pdf-url').focus(); await reader.keyboard.press('y');
    check((await reader.locator('#pdf-url').inputValue()) === 'y' && apiCalls === 1, 'URL input accepts Y without translating');
    await reader.locator('#pdf-url').fill('');
    await reader.locator('#document-name').evaluate((element) => {
      document.activeElement?.blur(); const range = document.createRange(); range.selectNodeContents(element);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    });
    await reader.keyboard.press('y');
    check(apiCalls === 1 && await panel.count() === 0, 'Reader title selection is not PDF source text');
    await selectText('A'.repeat(120)); await reader.keyboard.press('y');
    await panel.locator('.text[data-state="error"]').waitFor();
    check(apiCalls === 1 && (await panel.locator('.text').textContent()).includes('超过上限'), 'Long PDF text blocked before API');
    await reader.keyboard.press('Escape');
    const beforeScale = await reader.locator('#zoom-value').textContent();
    await reader.locator('#zoom-in').click();
    check((await reader.locator('#zoom-value').textContent()) !== beforeScale, 'Zoom controls update scale');
    await ready();
    check(await selectText('Scientific evidence') === original, 'Text remains selectable after zoom');
    await reader.locator('#fit-width').click(); await ready();
    check((await reader.locator('#zoom-value').textContent()) === beforeScale, 'Fit width restores initial scale');
    const spanBox = await reader.locator('.page[data-page-number="1"] .textLayer span').filter({ hasText: 'Scientific evidence' }).first().boundingBox();
    const canvasBox = await reader.locator('.page[data-page-number="1"] canvas').boundingBox();
    check(spanBox.x >= canvasBox.x && spanBox.x + spanBox.width <= canvasBox.x + canvasBox.width + 2, 'Text layer aligned within rendered paper');
    await reader.mouse.move(spanBox.x + 1, spanBox.y + spanBox.height / 2);
    await reader.mouse.down();
    await reader.mouse.move(spanBox.x + spanBox.width - 1, spanBox.y + spanBox.height / 2, { steps: 15 });
    await reader.mouse.up();
    check((await reader.evaluate(() => window.getSelection().toString())).includes('Scientific evidence'), 'Real mouse drag selects rendered PDF words');
    await reader.locator('#next-page').click(); await ready(2);
    check(await reader.locator('#previous-page').isEnabled(), 'Page navigation works');
    const left = await selectText('Left column research', 2); await reader.keyboard.press('y'); await translationReady();
    check(lastText === left && !lastText.includes('Right'), 'Left column selection excludes right column');
    await reader.keyboard.press('Escape');
    const right = await selectText('Right column catalytic', 2); await reader.keyboard.press('y'); await translationReady();
    check(lastText === right && !lastText.includes('Left'), 'Right column selection excludes left column');
    await reader.keyboard.press('Escape');
    await reader.locator('#page-number').fill('3'); await reader.locator('#page-number').press('Enter'); await reader.locator('#pdf-url').focus();
    await reader.waitForFunction(() => document.querySelector('#reader-status').textContent.includes('OCR'));
    check(await reader.locator('#next-page').isDisabled(), 'Last-page navigation bounded');
    const beforeScan = apiCalls;
    await reader.locator('#viewer-container').focus(); await reader.keyboard.press('y');
    check(apiCalls === beforeScan && await panel.count() === 0, 'No-text page hints OCR without request');
    await reader.locator('#page-number').fill('1'); await reader.locator('#pdf-url').focus(); await ready();
    apiDelay = 800;
    await selectText('Catalytic reactions'); await reader.keyboard.press('y');
    await panel.locator('.text[data-state="loading"]').waitFor();
    await reader.waitForFunction(() => document.querySelector('#literature-translator-panel') !== null);
    await file(localPdf); await ready();
    check(await panel.count() === 0, 'Changing file clears old translation');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    check(await panel.count() === 0, 'Late translation does not reopen on new PDF');
    apiDelay = 0;
    // 拖入入口使用与真实拖放相同的 File/DataTransfer 数据路径。
    await reader.evaluate((values) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(values)], 'dragged.pdf', { type: 'application/pdf' }));
      document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, [...bytes]); await ready();
    check((await reader.locator('#document-name').textContent()) === 'dragged.pdf', 'Drop file opens PDF');
    await file(corrupt);
    await reader.waitForFunction(() => document.querySelector('#reader-status').dataset.state === 'error');
    check((await reader.locator('#reader-status').textContent()).includes('无法解析'), 'Invalid PDF error is readable');
    check(await reader.locator('#empty-state').isVisible() && await reader.locator('#page-number').isDisabled(), 'Invalid file leaves reader recoverable');
    await file(encrypted);
    await reader.waitForFunction(() => document.querySelector('#reader-status').dataset.state === 'error');
    check((await reader.locator('#reader-status').textContent()).includes('密码'), 'Encrypted PDF rejected clearly');
    await file(localPdf); await ready();
    check((await reader.locator('#document-name').textContent()) === 'research.pdf', 'Reader recovers after invalid and encrypted files');
    await reader.locator('#pdf-url').fill(`${origin}/download?id=fixture&token=not-real`);
    await reader.locator('#load-url').click(); await ready();
    check((await reader.locator('#document-name').textContent()) === 'download', 'Online PDF without extension loads across origin without CORS');
    await reader.locator('#pdf-url').fill(`${origin}/blocked`); await reader.locator('#load-url').click();
    await reader.waitForFunction(() => document.querySelector('#reader-status').dataset.state === 'error');
    check((await reader.locator('#reader-status').textContent()).includes('下载后本地打开'), 'HTTP failure suggests local fallback');
    await reader.locator('#pdf-url').fill(`${origin}/not-pdf`); await reader.locator('#load-url').click();
    await reader.waitForFunction(() => document.querySelector('#reader-status').dataset.state === 'error');
    check((await reader.locator('#reader-status').textContent()).includes('链接返回了网页'), 'HTML response is not accepted as PDF');
    await reader.locator('#pdf-url').fill('file:///D:/paper.pdf'); await reader.locator('#load-url').click();
    check((await reader.locator('#reader-status').textContent()).includes('HTTP / HTTPS'), 'Local file URLs use explicit chooser');
    await reader.route(`${origin}/disconnected`, (route) => route.abort('internetdisconnected'));
    await reader.locator('#pdf-url').fill(`${origin}/disconnected`); await reader.locator('#load-url').click();
    await reader.waitForFunction(() => document.querySelector('#reader-status').dataset.state === 'error');
    check((await reader.locator('#reader-status').textContent()).includes('检查链接和网络'), 'Disconnected PDF request shows recovery hint');
    await reader.locator('#pdf-url').fill(`${origin}/download`); await reader.locator('#load-url').click(); await ready();
    const secondReader = await context.newPage();
    await secondReader.goto(`${base}/pdf-reader.html?url=${encodeURIComponent(origin + '/download?id=second&token=not-real')}`);
    await secondReader.waitForFunction(() => document.querySelector('#reader-status').dataset.state === 'ready' && document.querySelector('#page-count').textContent.includes('3'));
    check(!secondReader.url().includes('token='), 'Initial signed URL removed from reader address');
    const beforeCrossCache = apiCalls;
    await secondReader.locator('.textLayer span').filter({ hasText: 'Scientific evidence' }).first().evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element); window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    });
    await secondReader.keyboard.press('y'); await secondReader.getByRole('button', { name: '复制译文', exact: true }).waitFor();
    check(apiCalls === beforeCrossCache && (await secondReader.locator('#literature-translator-panel .note').textContent()).includes('来自缓存'), 'Cache shared across PDF tabs');
    // 未缓存的新选区验证错误与基于原始文字的重试。
    apiMode = '429';
    await reader.locator('#next-page').click(); await ready(2);
    await selectText('independent results', 2); await reader.keyboard.press('y');
    await reader.getByRole('button', { name: '重试', exact: true }).waitFor();
    check((await panel.locator('.text').textContent()).includes('429'), 'PDF API errors use existing retry panel');
    const retryText = lastText; const beforeRetry = apiCalls; apiMode = 'success';
    await reader.evaluate(() => window.getSelection().removeAllRanges());
    await reader.getByRole('button', { name: '重试', exact: true }).click(); await translationReady();
    check(apiCalls === beforeRetry + 1 && lastText === retryText, 'PDF retry retains original selection');
    const web = await context.newPage(); await web.goto(origin);
    await web.waitForLoadState('networkidle');
    await web.locator('#source').evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element); window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    });
    await web.keyboard.press('y'); await web.getByRole('button', { name: '复制译文', exact: true }).waitFor();
    check(lastText === 'Ordinary HTML translation still works.', 'HTML translation regression passes');
    const popup = await context.newPage(); await popup.goto(`${base}/popup.html`);
    check(await popup.locator('#open-pdf').count() === 1 && await popup.locator('#open-current-pdf').count() === 1, 'Popup exposes both PDF entry buttons');
    const newReaderEvent = context.waitForEvent('page');
    await popup.locator('#open-pdf').click();
    const newReader = await newReaderEvent; await newReader.waitForLoadState();
    check(newReader.url() === `${base}/pdf-reader.html`, 'Popup opens actual extension reader tab');
    const nativePdf = await context.newPage(); await nativePdf.goto(`${origin}/paper.pdf`);
    const currentPopup = await context.newPage(); await currentPopup.goto(`${base}/popup.html`);
    await nativePdf.bringToFront();
    const currentReaderEvent = context.waitForEvent('page');
    await currentPopup.locator('#open-current-pdf').click();
    const currentReader = await currentReaderEvent;
    await currentReader.waitForFunction(() => document.querySelector('#reader-status')?.dataset.state === 'ready' && document.querySelector('#page-count').textContent.includes('3'));
    check((await currentReader.locator('#document-name').textContent()) === 'paper.pdf', 'Popup reopens current native PDF URL in extension reader');
    const oldBrowserReader = await context.newPage();
    await oldBrowserReader.route(`${base}/pdf-reader.html`, (route) => route.continue());
    await oldBrowserReader.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 Chrome/124.0.0.0' }));
    await oldBrowserReader.goto(`${base}/pdf-reader.html`);
    await oldBrowserReader.getByText('PDF 阅读功能需要 Chrome / Edge 125 或更新版本，请升级浏览器。', { exact: true }).waitFor();
    check(await oldBrowserReader.locator('#open-file').isDisabled(), 'Older browser gets upgrade hint rather than broken renderer');
    await reader.screenshot({ path: path.join(__dirname, 'pdf-reader.png') });
    await secondReader.getByRole('button', { name: '关闭翻译窗口', exact: true }).click();
    await secondReader.screenshot({ path: path.join(__dirname, 'pdf-paper.png') });
    check(pageErrors.length === 0, `No uncaught reader exceptions: ${pageErrors.join('; ')}`);
    const report = { suite: 'pdf-native-mv3', status: 'passed', assertions, checks, pdfjsVersion: '6.4.299', chromiumVersion: context.browser().version(), usesRealApi: false, notes: 'Synthetic single-column, double-column, no-text, encrypted and invalid PDFs. Native Chrome/Edge manual loading remains pending.' };
    fs.writeFileSync(path.join(__dirname, 'pdf-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally {
    if (context) await context.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
