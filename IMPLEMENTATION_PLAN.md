# 英文文献 AI 翻译扩展：Chrome / Edge 实施计划

更新日期：2026-10-11。网页翻译首版及 1.1.0 PDF 阅读升级已实现；PDF 使用方式和验收记录见 `PDF_SUPPORT_PLAN.md`。本文保留首版设计背景，当前支持范围以 PDF 升级说明为准。

## 实现目标

首版按你确认的选择增加 `background.js`，交付六个核心文件：`manifest.json`、`config.json`、`background.js`、`content.js`、`popup.html`、`popup.js`。1.1.0 另增加 PDF 阅读页及随包第三方资源，完整清单见 PDF 升级文档。

采用原生 JavaScript 和 Manifest V3，无构建依赖。全部使用 `chrome.*` API，Chrome、Edge 使用同一份源码，不引入 polyfill，不兼容 Firefox。

首版在原方案上增加四项改进：明确的关闭与复制操作、会话翻译缓存、单次文本长度限制，以及带处理建议的错误提示。1.1.0 已增加独立 PDF 阅读页；流式请求、扫描 OCR 和术语表仍列入后续阶段。

项目根目录保留本文档；“六文件”指网页首版的六个核心源码及配置文件，不包含 PDF 升级文件、计划文档或验证材料。

## 配置与后台接口

- `config.json` 保留 `model`、`baseUrl`、`apiKey`、`temperature` 四个模型字段，支持可选的 `thinking` 模型参数，以及 `maxTextLength` 和 `cacheMaxEntries` 两个本地行为字段。当前预设 DeepSeek Flash，密钥留空，temperature 默认 `0.3`，单次长度默认上限 5000，缓存默认上限 100 条。
- `baseUrl` 是接口根地址，例如 `https://api.example.com/v1`；DeepSeek 官方根地址为 `https://api.deepseek.com`，不要求版本路径。后台去除末尾斜杠后追加 `/chat/completions`。仅支持符合所述 Chat Completions 格式的服务。
- 后台使用 `fetch(chrome.runtime.getURL("config.json"))` 加载配置；通过共享 Promise 避免重复加载，并将配置快照保存在 `chrome.storage.session`。后台休眠后恢复仍使用原快照；重新加载扩展或重启浏览器后重新读取。[缓存行为依据](https://developer.chrome.com/docs/extensions/reference/api/storage)
- manifest 注册后台 service worker、popup 和 HTTP/HTTPS 顶层页面 content script；声明 `storage` 及 HTTP/HTTPS 主机权限，以支持仅编辑配置切换接口地址。配置文件不列入 `web_accessible_resources`。
- 内部消息提供 `GET_CONFIG_STATUS` 和 `TRANSLATE`：前者只返回模型名称、文本长度上限或配置错误；后者只接受选中文字，返回译文、是否命中缓存的标记或错误。错误包含稳定的错误代码和中文处理建议。接口地址、密钥、请求参数全部由后台决定，不接受网页传入。
- 后台消息监听使用 `sendResponse` 配合 `return true`，保持 Chrome、Edge 兼容；不开放网页或其他扩展的外部消息入口。
- 请求使用 Bearer 密钥、JSON 请求体、下述完整 system prompt 和选中文字，采用非流式响应，读取 `choices[0].message.content`。
- 首版请求总超时固定为 25 秒，通过 `AbortController` 中止；不自动重试。这是首版的保守取舍，慢接口或长段落可能超时。不能仅延长计时器来规避后台生命周期限制；后续流式方案另行设计。[生命周期依据](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- 配置文件不存在、JSON 无法解析、字段缺失或类型不正确时不发送模型请求。验证非空模型名称、字符串密钥、HTTP/HTTPS 根地址、有限数值 temperature，以及正整数长度和缓存上限。密钥可暂时留空，popup 仍显示模型名称，但请求会被拦截；接口是否接受指定 temperature 由接口响应判定。

配置示例：

```json
{
  "model": "deepseek-flash",
  "baseUrl": "https://api.deepseek.com",
  "apiKey": "",
  "temperature": 0.3,
  "thinking": { "type": "disabled" },
  "maxTextLength": 5000,
  "cacheMaxEntries": 100
}
```

固定 system prompt：

> 你是科研文献专业中英翻译助手，只输出译文，不要多余说明。保留领域专业术语，译文通顺，符合中文科技论文表达习惯。

模型请求体仅使用模型字段和 messages，不把长度限制、缓存条数发送给接口。当前使用官方推荐的 `deepseek-flash`，并显式关闭思考模式，以用于直接翻译；`thinking` 是可选字段，切换到不支持此参数的接口时需移除。模式也参与缓存键计算，避免不同模式误用同一译文。[DeepSeek 首次调用说明](https://api-docs.deepseek.com/)、[思考开关参数说明](https://api-docs.deepseek.com/api/create-chat-completion/)

## 页面交互与展示

- 页面 `document_idle` 阶段向后台查询配置状态。文件缺失或无法解析时显示：“无法加载本地配置文件，请检查项目根目录config.json是否存在。”字段不合法另行显示具体提示。
- 捕获阶段监听 `keydown`，识别大小写 Y；忽略 Ctrl、Alt、Meta 组合键、输入法组合输入及长按重复事件。
- 只接受真实用户按键及真实浮窗按钮点击，忽略网页脚本合成的事件，防止网页伪造 Y 或重试点击触发付费请求。
- 焦点在 `input`、`textarea` 或 `contenteditable` 区域时保留正常输入，包括 Shadow DOM 内的输入区域。
- 使用 `window.getSelection().toString().trim()` 获取文本；空选区无动作。有效触发时同步阻止默认行为和事件传播，设置当前页面并发锁，再发送消息。
- 超过 `maxTextLength` 时显示实际长度和上限，提示分段选择，不发送请求、不静默截断。前端和后台均验证长度，按 JavaScript 字符串 `length` 计数；该限制不等同于 token 限制。
- 请求期间重复触发直接忽略；所有成功、错误及通信异常路径通过 `finally` 释放锁。不同标签页可以独立请求。
- 创建右下角悬浮窗，加载文字为“翻译请求中，请稍候...”。使用 Shadow DOM 隔离样式，设置高 z-index、换行、最大高度和滚动。
- 译文与错误全部通过 `textContent` 展示。浮窗正文可选择、可复制，点击正文不关闭；使用明确的关闭按钮或 Esc 关闭。弹窗内输入区域的 Esc 行为不强行覆盖。
- 成功后显示“复制译文”按钮。复制失败时提示手动选中复制，不改变译文或关闭浮窗；兼容 HTTP 页面缺少安全剪贴板能力的情况，不额外申请剪贴板权限。
- 请求期间关闭浮窗后，结果返回不会重新打开；并发锁仍保持到请求结束。关闭只是隐藏界面，不等同于取消模型请求。
- 请求失败时提供“重试”按钮，手动重试原始选中文字并再次应用并发锁；不依赖用户重新选择文字，不自动重试。通信失效等必须刷新网页的错误只显示处理建议。
- popup 通过后台读取同一份已加载配置的模型名称，展示编辑 `config.json` 和刷新扩展的提示；不提供密钥输入框或保存表单。
- 注释说明：密钥仍明文存在于本地扩展包，仅供个人使用，不应打包分享；前端直连的 CORS 限制、临时 CORS 插件及后端中转方案也保留说明。本方案采用后台请求及主机权限处理跨域。[跨域行为依据](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- 1.1.0 支持插件 PDF 阅读页中的文字层选区。没有可选择文本层的扫描页无法通过选区 API 获取文字，显示 OCR 提示；浏览器内置 PDF 阅读器仍不直接注入。[PDF 升级说明](PDF_SUPPORT_PLAN.md)

JSON 文件保持合法 JSON，相关说明写在 JavaScript、HTML 注释及文件代码块前的说明中。

## 会话缓存与错误处理

- 翻译缓存由后台维护，放在 `chrome.storage.session`，保留其默认的可信扩展上下文访问限制。缓存跨网页、标签页和后台休眠复用；重新加载扩展、禁用扩展或重启浏览器后清空，不写入磁盘或同步到账号。
- 缓存键使用接口地址、模型名称、temperature、可选 thinking 参数、完整 system prompt 和 trim 后原文计算哈希，不包含密钥。相同文本和翻译配置命中时直接返回，不发送模型请求；不额外折叠原文内部空格或换行。
- 仅缓存成功且完整的结果。错误、空译文及明确被截断的响应不进入缓存；响应 `finish_reason` 为 `length` 时显示已有译文和“译文可能不完整”的提示。
- 使用 LRU 淘汰最近最少使用的条目，数量不超过 `cacheMaxEntries`；原文与译文累计长度不超过 500000。过大的单条结果不缓存。后台串行处理缓存更新，避免不同标签页覆盖彼此的写入；缓存故障不使已成功的翻译变为失败。
- 缓存包含所选原文和译文，仅用于当前浏览器会话。界面标记“来自缓存”，但不增加历史记录浏览、导出或收藏功能。
- 内容脚本、消息通信、配置加载、HTTP 请求和响应解析均捕获异常，保证并发锁释放；界面及日志不输出 Authorization、配置全文或密钥。

| 情况 | 用户提示与处理方式 |
| --- | --- |
| 配置文件不存在或 JSON 无法解析 | 显示原定配置加载提示，并建议检查文件内容后重新加载扩展 |
| 配置字段不合法 | 指出具体字段和要求，不显示字段中的密钥值 |
| HTTP 401 / 403 | 检查 API 密钥、模型访问权限及账号状态 |
| HTTP 404 | 检查 `baseUrl`、接口路径和模型名称 |
| HTTP 429 | 检查额度或调用频率，稍后手动重试 |
| HTTP 400 或其他请求错误 | 检查模型及参数；展示经过长度限制和密钥脱敏的接口说明 |
| HTTP 5xx | 接口服务异常，稍后手动重试 |
| 网络断开或请求失败 | 检查网络、接口地址和扩展主机权限；不一概断言是 CORS |
| 25 秒超时 | 建议缩短选区或稍后手动重试；注明中止本地等待不保证服务端停止生成或计费 |
| 非 JSON、空译文或响应结构异常 | 提示接口响应不符合约定，检查 Chat Completions 兼容性 |
| 扩展重新加载后通信失效 | 提示刷新当前网页，不自动重发请求 |

## 验证与交付

- 检查 JSON 解析、JavaScript 语法、manifest 引用及六文件完整性。
- 使用模拟接口验证正常翻译、400/401/403/404/429/500、网络断开、超时、非 JSON、空译文、截断及异常响应结构；确认错误后锁已释放，手动重试只发送一次请求。
- 验证空选区、大小写 Y、输入区域、组合快捷键、输入法组合输入、连续按键、关闭加载浮窗及多个标签页。
- 验证点击或选择正文不会关闭，关闭按钮和 Esc 可用，复制成功与失败均保留浮窗；请求期间关闭后不因返回结果重新打开。
- 验证长度刚好等于上限时允许请求，超过上限时不产生 API 请求，后台同样拒绝超长文本。
- 验证重复翻译命中缓存，切换接口、模型、temperature 或 prompt 后不会误命中；验证 LRU、累计长度限制、并发写入、错误不缓存以及缓存故障不影响已有译文。
- 验证配置修改后当前会话保持原值；重新加载扩展并刷新目标网页后，popup 与请求使用新配置。确认网页不能直接获取配置文件，消息和界面不返回密钥。
- 在 Chrome、Edge 分别完成本地加载验证；附 `chrome://extensions`、`edge://extensions` 开启开发者模式并加载已解压扩展程序的说明。
- 支持普通 HTTP/HTTPS 顶层 HTML 页面和本扩展指定 PDF 阅读页；浏览器内部页面、扩展商店、内置 PDF 阅读器及 iframe 不直接注入。
- 验证使用模拟数据，不需要真实密钥或实际消耗 token；不提交 Git、不公开发布。

## 后续阶段

- 流式请求：支持 SSE 解析和增量展示，分别设置首次响应、空闲和整体超时；只在请求期间维持必要的消息活动，完成后清理。首响应超过浏览器 fetch 限制的情形仍需单独处理，不能只把超时改大。
- 文献输入：1.1.0 已实现专用 PDF 阅读器和文字层选区翻译；扫描 OCR、粘贴原文入口、iframe 及其他阅读器集成继续单独规划。
- 翻译质量：增加领域、术语映射、原文对照，以及明确保留公式、引用编号、单位、缩写和段落的规则；届时同步更新缓存键。
- 权限收缩：个人本地版保留广泛主机权限，以满足仅编辑配置切换接口的要求；若以后分享，改为按接口域名申请可选主机权限，增加明确的授权操作。[权限设计依据](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- 后续阶段不属于首版验收范围，是否实施由后续需求决定。

## 首版使用说明

扩展运行文件位于项目根目录，不需要安装项目依赖或运行构建命令：

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | Manifest V3 注册、主机权限、后台及 popup 入口 |
| `config.json` | 本地模型、接口根地址、密钥、temperature、长度和缓存上限 |
| `background.js` | 配置快照、后台模型调用、并发控制、错误脱敏及缓存 |
| `content.js` | 选区与 Y 按键监听、浮窗、复制、关闭及手动重试 |
| `popup.html` | 只读模型展示和操作说明 |
| `popup.js` | 从后台读取已加载配置状态 |
| `pdf-reader.html` / `pdf-reader.js` / `pdf-reader.css` | 1.1.0 PDF 阅读、文字层、导航和异常处理 |
| `vendor/pdfjs/` | 固定版本 PDF.js 的本地运行资源和许可证 |

1. 根目录 `config.json` 已预填 DeepSeek 的模型和接口地址，手动将自己的密钥填入空字符串 `"apiKey": ""`。空密钥或占位配置不会发起模型请求。
2. `baseUrl` 填接口根地址，如 `https://你的接口域名/v1`；代码自动追加 `/chat/completions`，不要在配置中重复填写该路径。接口须支持 Chat Completions、Bearer 认证以及请求中的 temperature。
3. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。开启开发者模式，点击“加载已解压的扩展程序”或“加载解压缩的扩展”，选择本项目根目录。
4. 刷新正在阅读的普通 HTML 网页，选中英文文字后按 Y。输入框及编辑区域正常输入 Y，不触发翻译。
5. 浮窗正文可以选中复制，也可以点击“复制译文”。关闭按钮或 Esc 隐藏浮窗；请求失败时按提示处理，需要时手动重试。
6. 每次修改配置后，在扩展管理页重新加载插件，再刷新目标网页。后台休眠期间保持原配置快照，不热更新；浏览器重启也会重新读取配置并清空翻译缓存。

默认每次最多 5000 字符，缓存最多 100 条，原文和译文累计最多 500000 字符。仅完整成功结果缓存；同一原文和配置在不同标签页可复用缓存，同时进行的相同请求也会合并。长段落或慢模型可能达到 25 秒超时，建议缩短选区；不会自动重试或静默截断原文。

密钥仍在本地扩展包中明文保存，不能分享含真实密钥的项目或扩展包。源码使用 chrome.* API，Edge 原生支持，无 polyfill 或 Firefox 分支。PDF 必须通过插件弹窗打开独立阅读页：本地文献选择文件或拖入；在线文献点击“使用当前页面地址打开 PDF”，也可粘贴链接。阅读页选中文字后按 Y。PDF 功能需要 Chrome / Edge 125+，扫描版和密码保护文件暂不支持。

## 已完成验证

所有验证使用合成原文和模拟密钥，未调用真实模型接口，也未修改根目录配置为真实密钥。

| 验证层次 | 结果 | 证据 |
| --- | --- | --- |
| JSON / JavaScript 静态检查 | 两份 JSON 及四份自有 JavaScript 解析通过 | `node --check` 及 JSON 解析 |
| 后台模拟测试 | 132 项断言通过，包含 PDF 来源校验、空密钥保护与 thinking 参数验证 | `.verification/background-report.json` |
| 浏览器页面模拟交互 | 26 项检查通过 | `.verification/ui-report.json` |
| 原生 Manifest V3 扩展加载 | 独立 Chromium 151 中 23 项检查通过 | `.verification/native-report.json` |
| PDF 原生 Manifest V3 扩展 | 独立 Chromium 151 中 48 项检查通过 | `.verification/pdf-report.json` |
| Edge 阅读页引擎验证 | Edge 152 中 6 项检查通过，模拟扩展通信 | `.verification/edge-reader-report.json` |

原生验证复制运行源码和本地 PDF.js 资源，并单独生成临时 config.json，不复制用户根目录配置或真实密钥。使用本地模拟 HTTP 接口，验证了真实 service worker、消息通信、主机权限跨域请求、网页不能读取 config.json、跨标签页缓存、长度限制、输入区域、可信事件、密钥脱敏和原文重试。模拟接口特意不提供 CORS 响应头；后台请求仍成功。Edge 阅读页验证使用真实 Edge 引擎、本地 HTTP 页面和模拟 chrome.runtime，不代替原生 Edge 扩展安装验收。

Chrome / Edge 正式浏览器扩展管理页中的手动加载没有代替用户操作，仍需按上面的步骤分别确认。自动扩展加载使用 Chromium；正式 Chrome / Edge 的自动侧载标志存在限制，不等同于开发者模式的手动加载方式不可用。[Playwright 官方扩展测试说明](https://playwright.dev/docs/chrome-extensions)

`.verification` 包含验证脚本、模拟页面、报告和下载缓存，不是运行依赖，不需要在该目录填写真实密钥。计划文档和验证材料不计入运行文件。

复跑后台验证：

```powershell
node .verification/verify-background.cjs
```

原生加载验证需要 Playwright 与其匹配的 Chromium。验证脚本支持第二个参数传入 Playwright 模块路径；本次使用了环境中已有的模块，浏览器下载至临时目录，没有安装项目依赖、没有修改日常浏览器配置，也没有自动删除临时目录。

```powershell
node .verification/verify-native.cjs
```

本地模拟交互页可用以下命令启动，浏览器打开 `http://127.0.0.1:8765`。该页面使用模拟后台，不会连接真实模型：

```powershell
node .verification/preview-server.cjs
```
