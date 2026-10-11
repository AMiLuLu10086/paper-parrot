# 文献译读 · Literature Translator

适用于 Chrome 和 Microsoft Edge 的 Manifest V3 扩展。选中网页或扩展 PDF 阅读页中的英文文字，按 **Y** 显示中文译文。

## 安装

1. 下载或克隆本仓库。
2. 将 `config.example.json` 复制为项目根目录的 `config.json`，填写自己的 `apiKey`；按需调整模型与接口根地址。
3. 打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式。
4. 点击“加载已解压的扩展”，选择项目根目录。
5. 刷新目标网页，选中文字后按 **Y**。

PowerShell 配置文件复制命令（仅在 `config.json` 不存在时执行）：

```powershell
Copy-Item config.example.json config.json
```

修改 `config.json` 后，在扩展管理页重新加载扩展，再刷新网页。`baseUrl` 填写接口根地址，后台会追加 `/chat/completions`。切换到不支持 `thinking` 参数的服务时，移除该字段。

## 功能与限制

- 扩展控制面板和 PDF 阅读器中的“启用翻译”为同一个全局开关，默认开启，并记住状态；重启浏览器或重新加载扩展后仍保留。
- 关闭后，所有已打开网页与 PDF 阅读页立即收起译文，停止快捷键翻译并中止正在等待的翻译请求；重新开启无需刷新页面，PDF 阅读、翻页与缩放始终可用。
- 中止请求只停止本地等待，不能保证模型服务端停止生成或计费；按 Esc 或关闭译文浮窗仍然只隐藏结果。
- 网页选区翻译、复制译文、手动重试和浏览器会话缓存。
- 点击扩展图标可打开本地或在线 PDF，在扩展阅读页中选中文字并按 **Y**。
- 扫描 PDF 需要 OCR，当前不支持；浏览器内置 PDF 阅读器无法直接使用此快捷键翻译。
- 默认每次最多 5000 字符，请求超时为 25 秒。
- 原生 JavaScript，无需构建；PDF.js 运行资源已包含在 `vendor/pdfjs` 中。

选中文字会发送到 `config.json` 配置的模型服务。API 密钥保存在本地配置文件中，`config.json` 已被 Git 忽略，请勿分享含密钥的扩展目录。

## 开发资料

- [实现说明](IMPLEMENTATION_PLAN.md)
- [PDF 支持与验收记录](PDF_SUPPORT_PLAN.md)
- [PDF.js 来源与许可证](vendor/pdfjs/README.md)

已有后台模拟验证不访问真实模型服务，可在安装 Node.js 后运行：

```powershell
node .verification/verify-background.cjs
```

浏览器验证脚本保留在 `.verification` 中：`verify-native.cjs` 验证真实 Chromium 扩展及开关同步、取消与持久化，`verify-pdf.cjs` 验证 PDF 阅读和停用行为，`verify-ui.cjs` 验证长内容、错误状态与键盘操作。`verify-edge-reader.cjs` 使用真实 Edge 引擎和模拟扩展 API，不等同于 Edge 原生扩展安装测试。

运行前需按脚本要求配置浏览器和 Playwright 环境。验证只使用模拟密钥和本地接口，报告、截图和下载资源不纳入 Git。
