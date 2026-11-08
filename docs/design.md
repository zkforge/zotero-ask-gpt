# Zotero AI Chat — 设计

Zotero 10 阅读界面右侧的轻量 AI 侧栏：当前论文全文自动进入模型上下文，选中文字即可追问。后端复用本机 `codex app-server`，用 ChatGPT 账号登录，不需要 API key，也不嵌入网页。

## 目标与非目标

做：
- 阅读标签页右侧常驻侧栏，可拖宽、可收起，切换论文时会话跟着切换。
- 每篇论文一个会话，打开时自动把全文放进上下文，重启 Zotero 后可以接着聊。
- 选中文字后，浮窗出现「问 AI」按钮；选区以引用卡片的形式附在下一条消息上，带页码。
- 流式输出，Markdown 渲染（含代码块、表格、公式）。
- 预设动作：解释选文、翻译选文、总结全文。

不做（至少第一版不做）：文献库级检索、多模型配置界面、图表/图片理解、写入笔记或批注、Windows/Linux 适配。

## 架构

```
Zotero 进程（插件，特权 JS）
 ├─ bootstrap.js        生命周期、注册阅读器事件、窗口挂载
 ├─ sidebar             XUL 面板 + HTML 聊天界面（挂在 #browser 右侧）
 ├─ paper context       Zotero.PDFWorker.getFullText → 全文 / 选区 / 页码
 └─ codex client        Subprocess 启动 `codex app-server`，stdio 上收发 JSON-RPC
                              │
                              ▼
                     codex app-server（本机子进程）
                     使用 ~/.codex 登录与配置，走 HTTPS_PROXY 联网
```

### 后端：codex app-server

已在本机验证可用（codex-cli 0.167.0，通过 127.0.0.1:1082 代理）。每行一条 JSON-RPC 消息：

1. `initialize` { clientInfo } → 发送 `initialized` 通知。
2. `thread/start` { ephemeral: true, sandbox: "read-only", approvalPolicy: "never", baseInstructions: <阅读助手提示词>, developerInstructions: <论文元数据 + 全文> } → 得到 threadId。
3. 有历史消息时：`thread/inject_items` 把之前的问答作为 Responses API message 写入会话。
4. `turn/start` { threadId, input: [{ type: "text", text, text_elements: [] }] }，按偏好设置附带 `model` / `effort`。
5. 接收通知：`item/agentMessage/delta`（流式文本）、`turn/completed`、`error`；停止生成用 `turn/interrupt`。
6. 模型列表：`model/list`。

所有参数类型都可以用 `codex app-server generate-ts --out <dir>` 生成后对照；协议标注为 experimental，codex 升级后需要回归测试。

会话用 ephemeral：非 ephemeral 会话会出现在 Codex 应用的历史里，而归档后的会话无法 resume，所以由插件自己保存对话（见「会话持久化」）。

进程管理：整个 Zotero 只保留一个 app-server 子进程，按需启动，插件 shutdown 时结束；进程异常退出后，下次发消息时重启，并新建会话、回放历史。

### 环境（GUI 启动的 Zotero 没有 shell 环境）

- codex 路径：依次尝试偏好设置 `extensions.zoteroaichat.codexPath`、`/opt/homebrew/bin/codex`、`/usr/local/bin/codex`、`~/.local/bin/codex`。codex 是 node 脚本，PATH 里要带上它所在目录和 Homebrew。
- 代理：用 `nsIProtocolProxyService` 解析 `https://chatgpt.com/` 得到系统代理，显式传入 `HTTPS_PROXY` / `HTTP_PROXY`；偏好设置 `extensions.zoteroaichat.proxy` 可以覆盖。
- 子进程用 Firefox 自带的 `Subprocess.sys.mjs`，通过 `/bin/sh -c` 启动 codex，并把 stderr 重定向到 `<Zotero 数据目录>/ai-chat/codex-stderr.log`。stderr 作为 Subprocess 管道时，codex 启动约 50ms 就会被 SIGKILL，且没有任何输出。
- PathUtils.join 的每个参数只能是单段路径，不能带 `/`。

### 论文上下文

- 全文：打开论文时就用 `Zotero.PDFWorker.getFullText(attachmentID, null)` 提取。页之间用 `\f` 分隔，据此给每页加 `[p.N]` 标记（PDF 页码），和标题、作者、日期、摘要一起写入 `developerInstructions`。
- 长度：超过 48 万字符时截断，在上下文和侧栏里都写明读到了第几页。
- 选区：`renderTextSelectionPopup` 加「问 AI」按钮，`createViewContextMenu` 加菜单项，`⌘⇧G` 在有选区时也会引用。选区取自 `annotation.text` 和 `annotation.position.pageIndex`，显示成引用卡片；发送时拼成 `Quoted passage from the paper (p. N): """…"""` 加上用户问题。
- 扫描版 PDF 提取不到文字时，在侧栏显示提示，仍然可以对话。

### 会话持久化

- 每篇论文一个 JSON 文件：`<Zotero 数据目录>/ai-chat/conversations/<libraryID>-<itemKey>.json`，内容为 `{ version: 1, messages: [{ role, text, quote, error }] }`。每轮回复结束后写入。
- 打开论文时读回消息并显示。之后第一次发送时新建 ephemeral 会话，用 `thread/inject_items` 回放历史。
- 「新对话」按钮清空消息并删除文件，已提取的全文继续复用。

### 界面

- 挂载方式沿用已验证的做法：XUL `splitter` + `vbox` 追加到主窗口 `#browser`，只在阅读标签页显示，宽度存入偏好设置。
- 面板内是一个 HTML 文档（`chrome://` 下的 `chat.html`），用 CSS 变量跟随 Zotero 的明暗主题。
- 聊天页通过 `frameElement.aiChatSidebar.attach(window)` 主动向侧栏登记，拿到 `host` 动作对象；不依赖 iframe 的 load 事件。
- 顶栏：论文标题（截断显示）、新对话、收起；标题下一行显示全文读取状态。
- 消息区：AI 回复用 vendored 的 marked 15 + KaTeX 0.16 渲染，悬停时显示「复制」。空对话时给出三个常用问题。
- 页码跳转与高亮：系统提示词要求模型把每处引用写成 `[(p. 3)](page:3 "该页原文中连续 4–12 个词")`，短语保持原文语言、不翻译。渲染时 `page:N` 链接显示为 (p. 3)，短语放在 `data-quote` 里。点击后先 `reader.navigate({ pageIndex })` 跳到该页，再写入阅读器的 `primaryViewFindState`（通过 `_internalReader._updateState`，对象用 `cloneInto` 放进阅读器 iframe），触发 pdf.js 短语查找：滚到匹配处并高亮，同时打开查找栏，按 Esc 关闭。约 1.5 秒后若 `result.total === 0`，就关掉查找栏，只停在该页。用户自己的引用保存了选区的 `position`（页码 + 矩形），点击时用 `reader.navigate({ position })` 精确高亮。普通文字里的 (p. 3)、pp. 23–25、第 3 页（跳过代码和公式）只跳页。页码与上下文中的 `[p.N]` 一致，范围跳到起始页。
- 安全：聊天页是 chrome 特权页面，模型输出不能变成可执行的标记。原始 HTML 一律转义；链接只保留 http(s)，并用 `Zotero.launchURL` 在系统浏览器打开；图片只显示替代文字。
- 输入区：引用卡片（解释 / 翻译 / 移除）、多行输入框（Enter 发送，Shift+Enter 换行，输入法组字时不发送），下方是模型和推理强度选择（存在偏好设置里，「默认」表示跟随 `~/.codex/config.toml`）。
- 快捷键：`⌘⇧G` 开关侧栏；有选区时改为引用选区。

## 文件布局

```
manifest.json
bootstrap.js            生命周期，加载 content/ 脚本
content/
  rpc.js                换行分隔的 JSON-RPC（Node 可测）
  codex.js              app-server 子进程、会话、模型列表
  addon.js              窗口、阅读器事件、论文上下文、对话与持久化
  sidebar.js            XUL 面板挂载与显隐、聊天页桥接
  chat.html / chat.css / chat.js   聊天界面
  vendor/               marked、KaTeX（含 woff2 字体与许可证）
test/rpc.test.cjs       node --test test/rpc.test.cjs
build.sh                打包 dist/zotero-ai-chat-<version>.xpi
```

不引入 npm 构建链；纯 JS，用 zip 打包。

## 开发与验证

- 开发安装：在 Zotero 配置目录的 `extensions/` 下放一个文本文件，文件名为插件 ID `zotero-ai-chat@local`，内容为源码目录的绝对路径；从 `prefs.js` 删掉 `extensions.lastAppBuildId` / `extensions.lastAppVersion` 以触发重新扫描。改完代码后用 `-purgecaches` 重启 Zotero。
- Zotero 要求清单里有 `applications.zotero.update_url`，否则会静默跳过插件。侧载的插件默认禁用，需要在插件管理里启用（或在 Zotero 退出时把 `extensions.json` 里对应条目改为 `userDisabled: false`）。
- 用 `-ZoteroDebugText` 启动 Zotero，可以在 stdout 看到 `[zoteroaichat]` 日志。
- 偏好设置 `extensions.zoteroaichat.devSelfTest = true` 时，启动后对当前打开的论文做自测：先跳到第 5 页并记录阅读器所在页，再问一个需要引用的问题，检查回复里的 `page:N` 引用数量，依次点开前两处并记录查找结果，最后删掉这轮问答再保存。设为 `"nav"` 时只测页码跳转，不会调用模型。日常使用请关闭。
