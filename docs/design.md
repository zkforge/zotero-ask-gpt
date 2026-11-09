# Zotero Ask GPT — 设计

Zotero 10 阅读界面右侧的轻量 AI 侧栏：当前论文全文自动进入模型上下文，选中文字即可追问。后端复用本机 `codex app-server`，用 ChatGPT 账号登录，不需要 API key，也不嵌入网页。

## 目标与非目标

做：
- 阅读标签页右侧常驻侧栏，可拖宽、可收起，切换论文时会话跟着切换。
- 打开论文时自动把全文放进上下文，重启 Zotero 后可以接着聊；每篇论文保留历史对话，可以切回去继续。
- 选中文字后，浮窗出现「问 AI」按钮；选区以引用卡片的形式附在下一条消息上，带页码。
- 截图提问（图表、公式），从文库添加其他论文一起提问。
- 流式输出，Markdown 渲染（含代码块、表格、公式），页码引用可跳转并高亮原句。
- 回答存为 Zotero 笔记；最后一轮可编辑问题或重新生成；常用问题可在设置里自定义。

不做：Codex 以外的模型服务（API key）、写入 PDF 批注、整个文库的语义检索、Windows/Linux 适配。

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
7. 登录：`account/read` 返回当前账号；`account` 为空且 `requiresOpenaiAuth` 时需要登录（不需要 OpenAI 认证的自定义 provider 视为已登录）。`account/login/start` { type: "chatgpt" } 返回 `authUrl`，用系统浏览器打开；codex 在本机端口等待回调，完成后发 `account/login/completed` { success, error }，账号变化时发 `account/updated`。登录保存在 `~/.codex`，和终端里的 codex 共用。

所有参数类型都可以用 `codex app-server generate-ts --out <dir>` 生成后对照。协议标注为 experimental，因此：启动时检查 codex 版本，低于 `CodexService.MIN_VERSION`（0.167.0，已验证的最低版本）就提示升级；codex 用 -32600「Invalid request: unknown variant / missing field …」拒绝请求时（接口改了），改报「当前 codex 不接受 Ask GPT 的 X 请求」。codex 对未知参数会静默接受。codex 升级后跑一遍自测。

会话用 ephemeral：非 ephemeral 会话会出现在 Codex 应用的历史里，而归档后的会话无法 resume，所以由插件自己保存对话（见「会话持久化」）。

进程管理：整个 Zotero 只保留一个 app-server 子进程，按需启动，插件 shutdown 时结束；进程异常退出后，下次发消息时重启，并新建会话、回放历史。

### 环境（GUI 启动的 Zotero 没有 shell 环境）

- codex 路径：设置里填写的路径优先（不存在时直接报错），否则依次尝试 `/opt/homebrew/bin/codex`、`/usr/local/bin/codex`、`~/.local/bin/codex`。codex 是 node 脚本，PATH 里要带上它所在目录和 Homebrew。
- 代理：用 `nsIProtocolProxyService` 解析 `https://chatgpt.com/` 得到系统代理，显式传入 `HTTPS_PROXY` / `HTTP_PROXY`；设置里填写的代理优先。
- 子进程用 Firefox 自带的 `Subprocess.sys.mjs`，通过 `/bin/sh -c` 启动 codex，并把 stderr 重定向到 `<Zotero 数据目录>/ai-chat/codex-stderr.log`。stderr 作为 Subprocess 管道时，codex 启动约 50ms 就会被 SIGKILL，且没有任何输出。
- PathUtils.join 的每个参数只能是单段路径，不能带 `/`。

### 论文上下文

- 全文：打开论文时就用 `Zotero.PDFWorker.getFullText(attachmentID, null)` 提取。页之间用 `\f` 分隔，据此给每页加 `[p.N]` 标记（PDF 页码），和标题、作者、日期、摘要一起写入 `developerInstructions`。
- 长度：超过 48 万字符时截断，在上下文和侧栏里都写明读到了第几页。
- 附加论文：输入框旁的「+」可以按标题、作者或年份搜索个人和群组文库中带 PDF 的条目。打开菜单时优先显示当前论文的相关条目。选中的论文随下一条消息发送，每篇正文最多 20 万字符，并带页码标记。同一篇论文在对话里再次附加时不重复放正文（会话或回放的历史里已经有了），只附一句说明和引用格式。PDF 用条目在内存里的子附件查找，不逐条查数据库。状态栏显示已附加篇数，悬停可查看每篇的读取结果。
- 选区：`renderTextSelectionPopup` 加「问 AI」按钮，`createViewContextMenu` 加菜单项，`⌘⇧G` 在有选区时也会引用。选区取自 `annotation.text` 和 `annotation.position.pageIndex`，显示成引用卡片；发送时拼成 `Quoted passage from the paper (p. N): """…"""` 加上用户问题。
- 扫描版 PDF 提取不到文字时，在侧栏显示提示，仍然可以对话。

### 会话持久化

- 每篇论文一个 JSON 文件：`<Zotero 数据目录>/ai-chat/conversations/<libraryID>-<itemKey>.json`，内容是 `{ version: 2, current: { id, created, updated, messages }, archived: [{ id, created, updated, messages }] }`，`updated` 是最后一次回复结束的时间，`archived` 按移入历史的先后从新到旧。版本 1 的文件只有 `messages`，读入时当作当前对话，时间取文件的修改时间。每轮回复结束后写入，附加论文只保存条目和附件信息，正文留在内存缓存中。
- 打开论文时读回消息并显示。之后第一次发送时重新提取历史消息中附加的论文正文，再新建 ephemeral 会话，用 `thread/inject_items` 回放历史。
- 「新对话」按钮把当前对话（有消息时）移到历史，再开一个空对话；输入区里还没发出的截图连文件一起删除。已提取的全文继续复用。
- 历史对话：顶栏的时钟按钮（有历史时才显示）列出这篇论文的历史对话，显示第一个问题、最后一次回复的时间和轮数。点击切换过去，当前对话移到历史；切换会丢弃 codex 会话，下次发送时新建会话并回放。生成回答时不能切换。删除要点两次，会永久删除这段对话和其中的截图（笔记里只有页码链接，不引用截图文件）。
- 关闭阅读标签页后，没有打开阅读器的论文会释放内存里的全文和会话（正在生成、或输入框里还有引用、截图、附加论文的除外），不再被任何对话引用的附加论文正文也一并释放。下次打开时重新提取。

### 界面

- 挂载方式沿用已验证的做法：XUL `splitter` + `vbox` 追加到主窗口 `#browser`，只在阅读标签页显示，宽度存入偏好设置。
- 面板内是一个 HTML 文档（`chrome://` 下的 `chat.html`），用 CSS 变量跟随 Zotero 的明暗主题。
- 聊天页通过 `frameElement.aiChatSidebar.attach(window)` 主动向侧栏登记，拿到 `host` 动作对象；不依赖 iframe 的 load 事件。
- 增量渲染：每条消息的 DOM 节点按「显示内容签名」缓存（WeakMap，键是消息对象），只重建签名变化的消息，并就地替换节点；流式输出时只重建正在生成的那条。30 条带公式的消息下，每次更新从约 16 ms 降到约 4 ms，且不再随对话长度增长。
- 顶栏：论文标题（截断显示）、设置（打开 Zotero 设置里的 Ask GPT 面板）、新对话、收起。标题下一行是状态短条目：页数（截断时为「已读 N/M 页」，扫描件或读取失败时为警示），以及上下文用量。用量来自 codex 的 `thread/tokenUsage/updated`：`last.totalTokens / modelContextWindow`，即上一次请求的占用，80% 起标黄。发送前用同样的粗算估计这次请求的大小（已有会话：上次占用加新问题；新会话：论文、回放历史和新问题），超过模型上下文的 90% 就不发送：问题文字、引用、截图和附加论文退回输入区，并提示去掉一些论文或开新对话；重新生成或编辑时则显示为失败的回答。上下文大小取自 codex 报过的最近一次用量，本次启动还没有用量时不检查；codex 返回 `contextWindowExceeded` 时也改报同样的提示。还没提问时显示论文放进上下文后的估计大小（CJK 字符按 1 token、其他文字按 4 字符 1 token 粗算）。
- 重新生成和编辑：最后一个回答有「重新生成」（失败的回答也有），最后一个问题有「编辑」，在消息里原地改，Enter 发送、Esc 取消。两者都会截掉最后一个问题及其回答，丢弃当前 threadId，新建会话并只回放之前的历史，再重新提问（编辑时用新文字，引用和截图保留）。这样模型看不到被替换掉的旧回答。生成过程中不显示这两个操作。
- 消息区：AI 回复用 vendored 的 marked 15 + KaTeX 0.16 渲染，悬停时显示「复制」。空对话时显示快捷提问的前三个。
- 页码跳转与高亮：系统提示词要求模型把每处引用写成 `[(p. 3)](page:3 "该页原文中连续 4–12 个词")`，短语保持原文语言、不翻译。渲染时 `page:N` 链接显示为 (p. 3)，短语放在 `data-quote` 里。点击后先 `reader.navigate({ pageIndex })` 跳到该页，再写入阅读器的 `primaryViewFindState`（通过 `_internalReader._updateState`，对象用 `cloneInto` 放进阅读器 iframe），触发 pdf.js 短语查找：滚到匹配处并高亮，同时打开查找栏，按 Esc 关闭。约 1.5 秒后若 `result.total === 0`，就关掉查找栏，只停在该页。用户自己的引用保存了选区的 `position`（页码 + 矩形），点击时用 `reader.navigate({ position })` 精确高亮。普通文字里的 (p. 3)、pp. 23–25、第 3 页（跳过代码和公式）只跳页。页码与上下文中的 `[p.N]` 一致，范围跳到起始页。
- 截图提问：输入框左下角的截图按钮会在 pdf.js 文档里盖一层遮罩，拖动框选区域，滚轮照常滚动 PDF，Esc 取消。框选结束后按几何位置找到中心点所在的 `.page`（Zotero 禁用了页面的 pointer events，`elementsFromPoint` 取不到），从页面已渲染的 canvas 上按 canvas 像素比例裁剪，存为 `<Zotero 数据目录>/ai-chat/images/*.png`。每次截图追加到输入框上方的缩略图行（每张带页码角标和单独的 ×，移除时删除截图文件），一条消息最多 6 张。发送时按顺序作为多个 `localImage` 和文字一起传给 codex，提示词里注明每张图来自第几页。空输入时，一张图默认「解释这张图」，多张默认「比较并解释这几张图」。消息里保存 `images` 数组（旧存档的单个 `image` 读入时会转换），缩略图点击可跳到对应页。回放历史时，截图文件还在的就读成 data URL，作为 `input_image` 放进回放的用户消息里，所以重启或切换对话后模型仍能看到旧截图；文件已不在的只留一句说明。上下文估算按每张截图 1500 tokens 计。截图清晰度取决于当前缩放：屏幕上越大，图越清楚。
- 附加论文的引用使用 `paper:<libraryID>/<attachmentKey>/<page>`。点击会打开或切换到目标 PDF，在对应页查找原文短语。存为笔记时，跨论文引用也会转换为 `zotero://open-pdf` 链接。
- 存为笔记：每条回答下有「存为笔记」。聊天页把这一轮问答渲染成笔记 HTML：标题是问题，引用放进 blockquote，正文由第二个 marked 实例生成，公式写成笔记编辑器的 `<span class="math">$…$</span>` 和 `<pre class="math">$$…$$</pre>`，页码引用写成 `page:N` 链接，末尾注明模型和时间。插件把 `page:N` 换成 `zotero://open-pdf/<库前缀>/items/<附件 key>?page=N`，作为论文父条目的子笔记保存（PDF 没有父条目时存为独立笔记），并把笔记 key 记在这条消息上。之后按钮变成「查看笔记」，用 `ZoteroPane.openNoteWindow` 在新窗口打开；笔记已被删除时恢复成「存为笔记」。
- 安全：聊天页是 chrome 特权页面，模型输出不能变成可执行的标记。原始 HTML 一律转义；链接只保留 http(s)，并用 `Zotero.launchURL` 在系统浏览器打开；图片只显示替代文字。
- 登录：codex 启动时（侧栏加载模型列表时）和每次展开侧栏时读一次 `account/read`，在所有侧栏共享。需要登录时输入区上方显示卡片（「登录 ChatGPT 后才能提问」）和「登录」按钮，发送和快捷提问都不可用；点「登录」后卡片改为「正在浏览器中登录」（按钮变成「重新打开」，再次发起登录），收到 `account/login/completed` 后重新读账号，成功则卡片消失，失败则显示 codex 给的原因。提问时 codex 报 401（`unauthorized`，或连接错误带 `httpStatusCode: 401`）时，不等 codex 重试五次，立即停止这轮回答，回答显示「没有登录 ChatGPT，或登录已过期」，并把账号标为未登录，显示登录卡片。
- 输入区：引用卡片（解释 / 翻译 / 移除）、多行输入框（Enter 发送，Shift+Enter 换行，输入法组字时不发送），下方是模型和推理强度选择（存在偏好设置里，「默认」表示跟随 `~/.codex/config.toml`）。
- 快捷键：`⌘⇧G` 开关侧栏；有选区时改为引用选区。

## 设置

用 `Zotero.PreferencePanes.register` 在 Zotero 设置窗口里注册「Ask GPT」面板（`content/prefs.xhtml` / `prefs.js` / `prefs.css`）。

- 连接：ChatGPT 账号（邮箱和套餐；未登录时显示「登录」，登录中显示「重新打开」，面板打开期间随登录状态更新，通过 `addon.accountWatchers` 和侧栏一起刷新）。已登录时有「退出登录…」：确认后调 `account/logout`，因为登录保存在 `~/.codex`，终端里的 codex 也会一起退出，确认框里写明这一点。codex 路径、代理（留空则自动检测，占位符显示检测结果），「测试连接」会重启 codex，报告 codex 版本和可用模型数，没有登录时标红。
- 回答：回答语言（跟随提问 / 中文 / English，作为一行 developer instruction 加在新会话上），阅读助手提示词（默认内容可编辑，「恢复默认」清空偏好）。
- 快捷提问：常用问题，每行一个（偏好 `prompts`，为空时用内置列表，同样有「恢复默认」）。输入栏的闪电按钮打开列表，点一项直接发送，连同输入区里的引用、截图和附加论文；输入框里已经打的字保留。列表里也能直接编辑：悬停一项点 × 移除（只剩一条时不能移除，因为空列表表示内置列表），底部一行输入回车添加，新加的排在最前（重复的移到最前），改动写回同一个偏好，所有侧栏的空对话建议随之更新。
- 阅读器：打开 PDF 时显示侧栏（即侧栏开关状态 `open`），选中文字时显示「问 AI」按钮。
- 数据：存储位置与占用（对话数、截图数、大小），打开文件夹，清除所有对话和截图（确认后永久删除，Zotero 笔记不受影响）。

实现要点：
- Zotero 对插件面板强制 `defaultXUL: true`，片段按 XUL 解析：控件用 XUL 的 `checkbox` / `menulist` / `button`，HTML 元素必须加 `html:` 前缀。XUL 按钮用 `command` 事件。
- 面板脚本在沙箱里、片段插入之前加载；在 document 上以捕获方式监听面板根元素收到的 `load` 再接线。脚本通过 `Zotero.AIChat`（启动时挂上，关闭时删掉）调用插件。
- `preference` 属性自动双向绑定，读取的是原始偏好值，所以每个被绑定的偏好都在默认分支设了默认值，否则复选框显示未勾选、文本框显示 "undefined"。
- 偏好观察者：改 codex 路径或代理会重启 codex；改提示词或回答语言只会清掉各对话的 threadId，下次发送时新建会话并回放历史。

## 文件布局

```
manifest.json
bootstrap.js            生命周期，加载 content/ 脚本
content/
  rpc.js                换行分隔的 JSON-RPC（Node 可测）
  codex.js              app-server 子进程、会话、模型列表
  addon.js              窗口、阅读器事件、论文上下文、对话与持久化
  sidebar.js            XUL 面板挂载与显隐、聊天页桥接
  prefs.xhtml / prefs.js / prefs.css   Zotero 设置窗口里的「Ask GPT」面板
  chat.html / chat.css / chat.js   聊天界面
  render.js             Markdown/公式渲染、页码链接、笔记 HTML（聊天页和浏览器测试共用）
  selftest.js           开发自测，只在设置了 devSelfTest 时加载
  vendor/               marked、KaTeX（含 woff2 字体与许可证）
test/rpc.test.cjs       node --test test/rpc.test.cjs
test/render.test.html   渲染测试页；CHROME=<chrome-headless-shell> node test/browser-test.mjs
build.sh                打包 dist/zotero-ask-gpt.xpi，生成 dist/updates.json
.github/workflows/ci.yml  推送和 PR 时跑测试；推送 vX.Y.Z 标签时发布 Release
```

不引入 npm 构建链；纯 JS，用 zip 打包。

## 开发与验证

- 开发安装：在 Zotero 配置目录的 `extensions/` 下放一个文本文件，文件名为插件 ID `zotero-ask-gpt@zkforge`，内容为源码目录的绝对路径；从 `prefs.js` 删掉 `extensions.lastAppBuildId` / `extensions.lastAppVersion` 以触发重新扫描。改完代码后用 `-purgecaches` 重启 Zotero。
- Zotero 要求清单里有 `applications.zotero.update_url`，否则会静默跳过插件。侧载的插件默认禁用，需要在插件管理里启用（或在 Zotero 退出时把 `extensions.json` 里对应条目改为 `userDisabled: false`）。
- 测试：`node --test test/rpc.test.cjs`（JSON-RPC），`CHROME=… node test/browser-test.mjs`（在无头 Chrome 里跑 render.js 的测试，覆盖页码识别、公式提取、HTML 转义和笔记 HTML）。改 render.js 后两组都要跑。
- 发布：改 `manifest.json` 的 `version`，提交后推送同名标签 `vX.Y.Z`。CI 校验标签与版本一致，跑测试，然后创建 Release 并上传 `zotero-ask-gpt.xpi` 和 `updates.json`。`manifest.json` 的 `update_url` 指向最新 Release 的 `updates.json`，README 的下载链接指向最新 Release 的 xpi，所以这两个文件名不能改。插件 ID 发布后不能再改，否则 Zotero 会当成另一个插件。
- 用 `-ZoteroDebugText` 启动 Zotero，可以在 stdout 看到 `[zoteroaichat]` 日志。
- 偏好设置 `extensions.zoteroaichat.devSelfTest` 有值时，bootstrap 额外加载 `content/selftest.js`，启动后对当前打开的论文做自测。值为 `true` 时：先跳到第 5 页并记录阅读器所在页，再问一个需要引用的问题，检查回复里的 `page:N` 引用数量，依次点开前两处并记录查找结果，最后删掉这轮问答再保存。设为 `"nav"` 时只测页码跳转，不会调用模型；设为 `"history"` 时先暂存这篇论文的对话，依次测试新对话归档、切换到历史对话、删除历史对话（每步记录内存和文件里的数量），读一次自定义快捷提问，再在一段带截图的历史上提问，让模型说出之前是否收到过图片（调用一次模型），最后恢复原来的对话；设为 `"limits"` 时也不调用模型：把上下文上限临时设为 1000，检查超限的问题和引用退回输入区，检查重复附加的论文不再带正文，记录论文选择器的耗时，然后关闭标签页，检查对话已释放，重新打开后能恢复；设为 `"rerun"` 时依次提问、重新生成、编辑问题，检查每次都替换最后一轮问答、codex 回报了用量、状态条显示上下文占比，最后删掉这轮测试；设为 `"prefs"` 时打开设置面板，记录各字段、占位符和存储占用，记录账号一行和按钮，并按一次「测试连接」；设为 `"image"` 时用模拟鼠标事件在当前页框选上下两块区域，记录裁剪结果，在一次性会话里让模型说出收到几张图并分别描述，然后删除这两张测试截图；设为 `"note"` 时用示例内容走一遍存为笔记，记录笔记位置和 HTML，然后永久删除这条测试笔记。没有打开的 PDF 时，若设置了 `extensions.zoteroaichat.devSelfTestItem`（`<libraryID>/<key>`），会先打开该附件。日常使用请关闭。
