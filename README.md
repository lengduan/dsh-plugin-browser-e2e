---
description: "DSH 浏览器端到端验证插件：32 个 browser_e2e_* 工具用系统 Edge 驱动 Playwright 完成导航、快照、结构化读取、点击、填表、文件上传、下载、浏览器内抓取、原始 HTTP 请求（仅页面上下文）、剪贴板读写、悬停、拖拽、断言、声明式多步步骤（recipe）、人机验证检测与人工等待、截图与取证、动作历史落盘与脱敏读回，并在 Web UI 右侧提供实时浏览器画面面板，供安装、配置、排障或改这个 profile bundle 的人阅读。"
kind: "package-bundle"
---

# dsh-plugin-browser-e2e

## Summary

装进 DSH profile 后，模型获得 32 个 `browser_e2e_*` 工具，用本机系统 Edge 完成页面导航、DOM 快照、结构化读取、点击、填表、文件上传、下载与完整性校验、浏览器内抓取、原始 HTTP 请求（仅页面上下文）、剪贴板写入与粘贴投递、悬停、拖拽、滚动、截图、控制台与网络取证（含按 request_id 读取响应体）、条件等待、断言、声明式多步步骤（recipe）、人机验证检测与人工等待、页面脚本求值，以及动作历史读回（宿主落盘、写入前脱敏）。DSH Web UI 右侧另有一个实时浏览器画面，人可以在对话旁边直接看到模型正在操作的页面，而不必读对话里的一句转述。浏览器按会话隔离、同会话复用，并以空闲、会话销毁、插件卸载三道回收释放进程。主要边界：所有页面操作只能由工具发起，面板是只读视图；CDP 模式只接管已用远程调试端口启动的浏览器，不启动新进程。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

本插件是一个 profile bundle：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 向 profile 配置层插入一行 `browser-e2e`。装进 profile 后，该 profile 的所有会话与工作区都能直接调用工具，目标项目不需要安装 Playwright、浏览器或任何依赖。

### 安装到 profile

```sh
# <sha> 取本仓当前 HEAD：git rev-parse --short HEAD
# pwsh / bash 下 # 与 & 是保留字符，spec 必须整体加引号
dsh plugin --profile desktop add 'github:lengduan/dsh-plugin-browser-e2e#<sha>'

# 卸载
dsh plugin --profile desktop remove dsh-browser-e2e
```

`dsh plugin add` 把包写进 profile 的 `package.json` 依赖与 `dsh.profile.bundles` 层列表，reconcile 时因 `dsh.bundle` 声明激活这一层；没有该声明的包只会成为普通依赖，不激活任何层。git 依赖是**快照**，锁在指定 commit：改完源码要 commit + push，再在 profile 目录重新解析（`pnpm update dsh-browser-e2e`，或重新 `add` 新 sha），否则 profile 里跑的仍是旧提交。安装或解析完成后重启该 profile 的宿主进程，插件才会加载。

### 浏览器启动与模式

`browser_e2e_start` 统一管理启动，两种模式：

- **isolated（默认）**：自己拉起系统 Edge（Playwright `channel: 'msedge'`，不触发 360 进程防护弹窗），一次性 profile，用完关闭。可传 `headless`（默认 true）、`proxy`、`viewportWidth` / `viewportHeight`（默认 1600×900）。
- **cdp**：经 `chromium.connectOverCDP` 接管已用远程调试端口启动的浏览器，只接受 loopback 端点（默认 `http://127.0.0.1:9222`），不启动新进程、不新建页面、不设置视口。需要先自己启动浏览器：`msedge.exe --remote-debugging-port=9222 --user-data-dir="C:\edge-cdp-profile"`（Chrome 136+ 对默认数据目录忽略该开关，必须用非默认 `--user-data-dir`）。

同一会话复用同一实例，`browser_e2e_start` 可重复调用。未显式传 `mode` / `cdpEndpoint` 时，首次启动使用插件配置里的默认值，工具参数优先。已启动后要切换 `mode`（isolated ↔ cdp）或改 `cdpEndpoint`，必须先 `browser_e2e_close` 再重新启动；已启动时传入与当前不一致的值会直接报错，不会静默复用。同一会话同时只允许一次 launch，后到的调用等前一次落定后按复用返回同一实例。

### 环境诊断

`browser_e2e_doctor` 一次给出六项只读检查，用来回答「为什么浏览器起不来」，本身不启动浏览器：

| 检查 | 内容 | 何时不通过 |
|---|---|---|
| `runtime` | Node / 平台 / 插件版本 / `playwright-core` 版本 | `playwright-core` 解析失败为 `FAIL`；插件版本读取失败为 `WARN` |
| `edge` | 系统 Edge 可执行文件（与 Playwright `channel: 'msedge'` 同一批候选前缀） | 全部候选不存在 `FAIL`；平台不在 win32 / darwin / linux `SKIP` |
| `cdp` | 端点归一、TCP 可达、`GET /json/version` 是否为 CDP 端点 | `isolated` 模式 `SKIP`；端点非法或连不上 `FAIL`；端口通但不是 CDP `WARN` |
| `session` | 本会话只读视图（模式、标签页数、连接状态） | `launching` / `closing` 为 `WARN`；连接失效为 `FAIL` |
| `paths` | 产物根目录可写性、下载目录合法性 | 根目录不可写、下载目录不是绝对路径为 `FAIL` |
| `env` | `DSH_BROWSER_IDLE_MS` / `DSH_BROWSER_CLOSE_TIMEOUT_MS` / `DSH_BROWSER_PROXY` | 空闲回收非法 `FAIL`；关闭兜底或代理非法 `WARN` |

报告首行是统计行，其后每项一行 `[OK|WARN|FAIL|SKIP] <id>：<证据>`，非 `OK` 项各带一行 `修复：`，末行按最严重项给结论。工具只读：不启动浏览器、不接管 CDP、不改会话状态；唯一的写操作是在已存在的产物根目录里写一个探针文件并立即删除。`mode` 缺省取插件设置；`cdpEndpoint` 非法只报 `cdp` 项 `FAIL`，不抛错——诊断工具不能因为被诊断对象坏了就失败。

### 工具一览

32 个工具统一带 `browser_e2e_` 前缀，可与提供 `browser_*` 的插件（如 `@linxin666/dsh-client-ui-browser-view`）共存而不冲突。作用于页面的工具都可带可选的 `tab_id`，不给时作用于当前 active tab。

| 工具 | 作用 |
|---|---|
| `browser_e2e_start` | 启动或复用浏览器；`mode` 选择 isolated / cdp，`cdpEndpoint` 指定接管端点，支持 `headless`、`proxy`、视口尺寸 |
| `browser_e2e_navigate` | 导航到 URL；`waitUntil` 支持 load / domcontentloaded / networkidle（长连接页面不要用 networkidle），`new_tab: true` 新建页并设为当前页，`tab_id` 指定目标页 |
| `browser_e2e_tabs` | 列出本会话标签页：`tab_id` / url / title / active / `loading` / `origin`（`created` 本会话新建 / `adopted` CDP 接管） |
| `browser_e2e_close_tab` | 关闭指定标签页；最后一个标签页不允许关闭，结束整个浏览器用 `browser_e2e_close` |
| `browser_e2e_follow_tab` | 绑定后续页面工具的默认标签页：`tab_id` 指定目标页（`browser_e2e_tabs` 得到），不给时自动判定用户当前正在看的页（窗口焦点页优先，其次唯一可见页，无法唯一判定时保持当前）；`activate: true` 把该页带到前台；绑定后不传 `tab_id` 的工具都默认作用到该页 |
| `browser_e2e_snapshot` | 全 DOM 结构化快照：每个可见节点带 `tag` / `id` / `classes` / `role` / `name` / `text` / `box` / `depth`，分配 ref（`@N`）；上限 4000 条，超限标记 `truncated` 并给出实际节点数。`delta: true` 只返回自上次快照以来的新增 / 变化 / 移除（与 `query` 互斥，默认 ref 继续有效）；`query`（`text` / `selector` / `role`，可加 `limit` 与 `includeHidden`）定位元素并返回可直接点击的 `selector`，不写快照基线；`frame` 读取指定同源 iframe（整数索引或 name / url 子串），子 frame 只读、不分配 ref |
| `browser_e2e_read` | 结构化读取：按 `controls` / `links` / `tables` / `forms` 四节返回记录（控件带 `role` / `name` / `type` / `value` / `checked` / `options` / 所属表单，链接带绝对 `href`，表格带表头 / 行矩阵 / `totalRows`，表单带 `action` / `fieldCount`）；每条记录带页内校验过的 CSS `selector`，`unique: true` 时可直接传给 `click` / `fill`；`maxItems` 默认 50（1-100），`includeValues` 默认 false（`password` / `file` 永不返回值），`selector` 收窄范围；只读主文档，不写快照 ref |
| `browser_e2e_click` | 点击：`ref`（点击前复验可见性，失效报错）/ `selector`（先等可见）/ `x`+`y`（真实鼠标事件）三选一；`clickCount` 1-3（缺省 1，2 双击、3 三击），`button` 选 `left` / `right` / `middle`（缺省 `left`），`modifiers` 在点击期间额外按住 `Alt` / `Control` / `Meta` / `Shift` |
| `browser_e2e_fill` | 向 input / textarea / contenteditable 填入文本：`ref` / `selector` / `x`+`y` 三选一，`value` 必填；`mode` 缺省 `insert`（一次写入并替换）或 `keystrokes`（先清空再逐键，`delayMs` 0-1000，仅 ref / selector） |
| `browser_e2e_hover` | 悬停：`ref` / `selector` / `x`+`y` 三选一，用真实鼠标移动触发 CSS `:hover` 与 mouseover / mouseenter；`settleMs`（0-5000，默认 300）是悬停后等待页面反应的时长，`0` 表示不等待 |
| `browser_e2e_drag` | 拖拽：`from` / `to` 各是一个三选一目标（`ref` / `selector` / `x`+`y`）；两侧都是元素时走 Playwright `dragTo`（覆盖 HTML5 draggable 与 pointer 事件），任一侧是坐标时手写鼠标序列；`steps`（1-60，默认 12）控制按下与松开之间的插值 mousemove 次数，`settleMs`（0-5000，默认 300）是释放后的等待 |
| `browser_e2e_upload` | 把宿主本地文件附加到 `input[type=file]`（真实文件选择路径，不是页面内合成 `File`）：`ref` / `selector` / `x`+`y` 三选一；`files` 必填（绝对路径或数组，最多 20 个，总大小默认 <= 20 MiB，`maxBytes` 可调到 512 MiB）；`clear` 默认 true 覆盖（不追加），`clear: false` 只在没有选择时设置；只接受 `input[type=file]`，不做 label 下钻、不校验 `accept` |
| `browser_e2e_scroll` | 滚动页面：`delta_x` / `delta_y` 至少一个非 0；给 `x`+`y` 时先移动鼠标到该视口坐标再滚 |
| `browser_e2e_press` | 键盘按键，作用于当前焦点元素：`action=press`（缺省）按下并抬起一次，`repeat` 1-100 重复；`action=down` 只按下并保持按住，`action=up` 只释放；按住的键按标签页记账，会影响随后的 click / fill，`navigate` 前自动释放 |
| `browser_e2e_clipboard` | 剪贴板读写：`action=write` 把 `text` 与可选富文本 `html` 写进浏览器剪贴板（isolated 自动授予 `clipboard-write`，cdp 不授权）；`action=paste` 把带 `text/plain` / `text/html` 的 paste 事件投递到 `ref` / `selector` / 当前焦点元素，页面未消费且目标是 input / textarea 时在选区处插入文本。`html` 缺省在页内按白名单净化，`sanitize: false` 只在 isolated 模式允许；不做真实快捷键粘贴，也不回读剪贴板内容 |
| `browser_e2e_screenshot` | 截图：支持 `clip` / `format`(png\|jpeg) / `quality` / `fullPage` / `scale`（`css`、`device` 或整数倍率 1/2/3）/ `name`；落盘返回路径，宿主有附件服务时一并返回图片 |
| `browser_e2e_download` | 下载并校验完整性：`url`（HTTP(S) 直接经当前浏览器上下文取回，共享 Cookie / 登录态）或 `ref` / `selector` / `x`+`y`（点击触发 download 事件）二选一；`filename` 覆盖服务器建议名，`maxBytes` 默认 100 MiB（上限 1 GiB），`expectedSha256` 可选强校验，`timeoutMs` 默认 60000；落盘到产物目录的 `downloads/` 子目录（`DSH_BROWSER_DOWNLOAD_DIR` 覆盖），返回路径、字节数与 SHA-256，同名不覆盖 |
| `browser_e2e_fetch` | 浏览器内抓取正文：CDP 下在 `tab_id` 所属上下文开临时页（共享用户浏览器登录态），isolated 下另开一页（该模式每页独立 context，不共享 Cookie）→ domcontentloaded → 等 `settleMs`（默认 400，0-5000）→ 取 `article` / `main` / `[role=main]`（缺省 `body`）的 `innerText` 与标题；返回 `tabId` / `url` / `statusCode` / `title` / `text` / `truncated` / `empty` / `elapsedMs` / `mode`。不导航当前页、不改 ref 表与事件环；`maxChars` 默认 16000（上限 180000），`timeoutMs` 默认 25000（1000-60000，只约束导航）；非 2xx 与空正文是结果不是错误；临时页用完即关、不登记为标签页；不返回 HTML、不落盘 |
| `browser_e2e_http` | 原始 HTTP（仅 `mode=context`）：用当前标签页所属浏览器上下文发任意 `method` / `headers` / `body`，不导航当前页、共享 Cookie、不受页面 CORS 限制（不是页面内 `fetch`）；返回状态码、响应头（敏感头脱敏）与正文（文本按 `max_chars` 截断，二进制只给字节数与 SHA-256），非 2xx 是结果不是错误（`ok=false`）；不落盘；方法限 GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS，`timeout_ms` 默认 30000（1000-120000） |
| `browser_e2e_dialog` | 读取页面弹出的 alert / confirm / prompt 记录（类型、文案、prompt 默认值、实际应答），并按 `tab_id` 设置后续对话框的应答策略：`policy`（`dismiss` 默认 / `accept`，不传表示只读）、`prompt_text`（仅 accept 时可用，缺省用页面默认值）、`limit`（默认 20，最多 50）；对话框在打开时立即按策略应答并记录，策略必须在触发动作前设好 |
| `browser_e2e_console` | 读取控制台记录（log/info/warn/error/debug 与未捕获异常），环形 500 条，`limit` 取尾部（默认 100）；`level` 只看不低于该严重级别的记录（`debug` < `log` < `info` < `warning` < `error`，`warn` 等同 `warning`），不可判级的记录类型（`table` / `assert` 等）始终保留 |
| `browser_e2e_network` | 读取网络记录（url/method/status/mimeType/failure），每条带 `request_id`（`n1`、`n2`…），环形 500 条，`limit` 取尾部；`status` 为 0 表示没有响应，此时看 `failure` |
| `browser_e2e_network_detail` | 按 `request_id` 读取单条请求的详情：请求头、请求体、响应头、响应体（JSON 自动格式化）；`max_chars`（1-65536，默认 65536）限制文本字符数，`timeout_ms`（100-30000，默认 5000）限制正文读取，`include_sensitive` 默认 false 隐藏敏感头；二进制只回大小与 sha256，不返回 base64 |
| `browser_e2e_wait` | 等待页面条件：`selector`（配合 `state`）、`expression`（页面内 JS 表达式，返回真值即满足）、`url`、`response` 四选一；`url` / `response` 用 `urlMatch`（includes / glob / regex）匹配 URL；response 还支持 `responseMethod` / `statusMin` / `statusMax` / `includeBuffered`（默认 true）/ `failOnRequestFailed`（默认 true）；`timeoutMs` 默认 10000，超时报实际等待并带诊断 |
| `browser_e2e_captcha_check` | 非阻塞探测当前页有没有人机验证：结构选择器优先（reCAPTCHA / hCaptcha / Turnstile / Cloudflare 挑战 / 通用 captcha），未命中且 `textScan` 为 true 时读页面文本兜底；返回 `detected` / `kind` / `evidence`；loopback 主机名跳过文本检测；`detected:false` 只表示未检测到 |
| `browser_e2e_wait_for_human` | 把页面交给用户完成人机验证并轮询等待：`reason`（自由文本，默认 confirm，保留前 200 字符）、`timeoutMs`（5000-300000，默认 60000）、`pollMs`（250-10000，默认 1500）、可选完成信号 `selector`、`textScan`；超时**不抛错**，返回 `resolved:false` 与 `hint`；结果带 `headless` 供判断用户能否看到窗口 |
| `browser_e2e_assert` | 一次判定多条断言并逐条给证据：`checks`（1-20 条）每项给 `selector`（配合 `state`，默认 visible）/ `text`（页面可见文本子串，区分大小写）/ `url`（配合 `urlMatch`）/ `expression`（同步表达式）之一；任一条未通过仍成功返回，`pass=false`，`checks[]` 给 index / kind / expected / pass / actual；不等待、不重试；只作用于主文档 |
| `browser_e2e_recipe` | 一次按顺序执行 1-20 个声明式步骤（`navigate` / `wait` / `click` / `fill` / `press` / `hover` / `scroll` / `extract`）：首个失败即停、已执行步骤不回滚，返回逐步 PASS / FAIL、失败步号与 `extract` 输出；步骤字段与对应工具同名，`wait` 步不接受 `expression`、没有 `evaluate` 步骤（不执行调用方脚本）；总预算 `timeoutMs` 默认 60000（1000-120000），只在步骤之间检查；全部输出合计上限 20000 字符 |
| `browser_e2e_evaluate` | 在页面上下文执行 JavaScript 表达式并返回 JSON 结果；多行逻辑用 IIFE 包装。`timeoutMs` 是执行上限（默认 30000，允许 1000-120000），到点中断页面内正在执行的脚本并报错，页面与标签页保持打开 |
| `browser_e2e_doctor` | 环境诊断（只读，不启动浏览器）：一次给 `runtime` / `edge` / `cdp` / `session` / `paths` / `env` 六项检查，每项 `OK` / `WARN` / `FAIL` / `SKIP` + 证据，非 `OK` 项附修法；`mode` 缺省取插件设置，检查 CDP 接管环境传 `mode: "cdp"`；`probeTimeoutMs` 100-10000（默认 1500）；`cdpEndpoint` 非法只报 `cdp` 项 FAIL，不抛错 |
| `browser_e2e_history` | 读取本机动作历史（宿主落盘、已脱敏）：每次 `browser_e2e_*` 调用结束写一条，按时间倒序返回 `#seq` / UTC 时间 / 工具名 / 摘要；`limit` 1-200（默认 20）、`tool` 精确过滤、`ok` 只取成功 / 失败、`scope=self`（默认，只看本会话）/ `all`（含同机其它会话）；不依赖浏览器，读历史本身不写入历史 |
| `browser_e2e_close` | 关闭本会话的浏览器实例；CDP 模式只断开连接，不结束浏览器进程、不关标签页 |

### 逐键输入（mode=keystrokes）

`browser_e2e_fill` 默认 `mode=insert`，一次写入并替换原值。受控组件（React / Vue）、掩码输入、防抖输入以及只监听 keydown / keypress / keyup 的输入框，需要真人逐键路径时传 `mode=keystrokes`：先 `fill('')` 清空（产生 1 次 Delete），再 `pressSequentially` 逐字符按键；`delayMs`（0-1000，默认 0）控制相邻按键之间的等待。

- 只支持 `ref` / `selector`，坐标目标在点击前报错；目标限文本 input / textarea / contenteditable，`select` 与非文本 input（file / date / color / range 等）报错。
- 一次最多 2000 个字符（按码点计），且 `delayMs × 字符数` 不超过 30000 ms。
- 中文与 emoji 走 `Input.insertText`，每个码点只产生一次 input、不产生 keydown；`\t` 不是 Tab 键，移动焦点请用 `browser_e2e_press`。
- 不回读最终值：受控 / 掩码 / `maxlength` 可能改写值，需要断言时用 `browser_e2e_evaluate`。

### 点击选项与按住按键

`browser_e2e_click` 的三个指针参数缺省时与单击完全一致，事件都来自 Playwright 的真实输入（`isTrusted=true`）：

- `clickCount`（1-3，缺省 1）：`2` 为双击、`3` 为三击；`clickCount=N` 产生 N 组 mousedown / mouseup，`detail` 依次为 1..N，浏览器在第二组派发 `dblclick`。三击是否选中整行由页面决定。
- `button`（`left` / `right` / `middle`，缺省 `left`）：右键触发页面 `contextmenu`，中键触发 `auxclick`。原生右键菜单与中键开新标签是浏览器行为，工具不负责关闭，也不保证新页进入标签页注册表；验证链接行为优先用左键。
- `modifiers`（`Alt` / `Control` / `Meta` / `Shift` 数组，缺省不额外按）：在已按住的键之上再按住，点击后只释放本次按下的键。元素路径在 scrollIntoView 与 actionability 期间就已按住，依赖 hover 状态选择器的页面可能因此改变命中；需要严格先定位后按键时拆成 `press action=down` + 不带 `modifiers` 的 `click` + `press action=up`。
- 摘要：缺省与旧版逐字一致（`点击 @3 (...)`）；双击 / 三击换动作词，右键 / 中键与修饰键在尾部追加括号，如 `双击 @3 (button "Submit")（右键，按住 Shift）`。

`browser_e2e_press` 增加 `action`（`press` / `down` / `up`，缺省 `press`）与 `repeat`（1-100，缺省 1，只对 `action=press` 生效）：

- `action=down` 只发 keydown 并保持按住，`action=up` 只发 keyup；`down` / `up` 只接受单个按键名（含 `Shift` / `Control` / `Alt` / `Meta` 本身），组合键字符串与 `repeat` 一律报错，组合键请用 `action=press`。
- 按住的键按标签页记账（`heldKeys`），不跨 tab；`navigate` 在 `goto` 前逐个释放并清空。没有自动释放计时：忘记 `action=up` 时该键会一直影响后续 click / fill，直到释放、导航或关页。`action=up` 未按住的键仍发 keyup，返回 `held: false`。
- 按住状态是真实浏览器行为，不是另一套状态机：随后不带 `modifiers` 的 `click` 会带上该修饰键，`fill` 的 `mode=keystrokes` 会输入被修饰键转换后的字符，`mode=insert` 不受影响。要排除已按住的键，先 `action=up` 释放。

### 剪贴板

`browser_e2e_clipboard` 把「复制按钮 → 剪贴板」与「剪贴板 → 富文本编辑器」两条链路做成可验证动作：

- `action=write`：把 `text` 与可选 `html` 写进浏览器剪贴板；两者都为空报错。只给 `html` 时纯文本口味由净化后 HTML 的 `innerText` 推导（摘要标「由 HTML 推导」）。isolated 模式每次写入前对所属浏览器上下文授予 `clipboard-write`；cdp 模式不授权，写入被拒绝时报错并提示手动允许该站点或改用 `paste`。
- `action=paste`：把 `text/plain`（必有）与 `text/html`（给了才有）组装进 `DataTransfer`，派发到 `ref` / `selector` 目标或当前焦点元素（`body` / `html` / 无焦点报错）。`selector` 只要求 attached，不要求可见；页面调用了 `preventDefault` 即 `accepted: true`。目标是文本 input / textarea 且页面未消费时，用原生 value setter 在选区处插入文本并派发 `input`（`inserted: true`）。
- `html` 缺省在页内用 `DOMParser` 按白名单净化：移除 `script` / `style` / iframe / 表单控件 / `svg` / `math` 等元素与 `on*`、`srcdoc`、`formaction`、`action` 属性，并去掉 `javascript:` / `data:` / `vbscript:` 的 `href` / `src`。这不是完整 XSS 过滤器；要原样投递（例如验证被测应用自己的净化）用 `sanitize: false`，仅 isolated 模式允许。
- 量：`text` 上限 100000 字符、`html` 上限 200000 字符（按 UTF-16 码元计）。工具在派发后立即返回，不等渲染与防抖；未消费不是失败，由调用方接 `browser_e2e_wait` 或断言页面状态。
- 不做 `method=system` 真实快捷键粘贴（Playwright 没有系统剪贴板 API，快捷键依赖窗口焦点且 cdp 会改写用户真实剪贴板）；需要时可 `action=write` 后自行 `browser_e2e_press("Control+V")`，工具不保证投递。也不回读剪贴板内容；摘要与错误只出现长度、目标与状态，不出现 payload 内容。
- 只作用主 frame；权限副作用：`grantPermissions` 是整表授予，测试若要读回剪贴板，需在每次读回前自行授予 `clipboard-read`。

### 结构化读取

`browser_e2e_read` 把页面按 `controls` / `links` / `tables` / `forms` 四节压成固定形状的记录，默认只读前三节；每节先全量计数，再按 `maxItems`（默认 50，1-100）列出，`omitted` 给出「命中数 − 列出数」。

- 每条记录带 `selector`：候选顺序为 `#id` → `[data-testid]` → 表单控件 `[name]` → 链接 `[href]` → 从 `html` 起的 `nth-of-type` 链，每个候选都在整文档校验唯一。`unique: true` 的 selector 可直接传给 `browser_e2e_click` / `browser_e2e_fill`；`unique: false`（不唯一，或选择器超过 500 字符被省略）不要直接用于操作。
- 控件记录：`role`（显式 ARIA 优先，否则按标签与 `type` 推导）、`name`、`type`、`hasValue`、`checked` / `disabled` / `readonly` / `required`（只在为真时出现）、`options` / `optionsTotal`、所属表单 `form`；`includeValues: true` 时追加 `value`，`password` / `file` 永不返回值。
- 表格记录：`headers` 取最后一个 `thead` 行的单元格，无 `thead` 且首行全是 `th` 时取首行；`rows` 是表体行矩阵，每格压成一行并截断；`totalRows` 是 DOM 行数，`omittedRows` 表示未列出的行。ARIA 表格（`role=table|grid|treegrid`）按 `role=row` / `columnheader` / `cell` / `gridcell` 读取。
- 文本预算 16000 字符，按请求节数均分；某节超出时从末尾整条丢弃（表格先丢行再丢整表），被丢的条目计入 `omitted`，文末追加截断提示。要读更多就只请求一节，或用 `selector` 收窄范围。
- 只读主文档：不进入 iframe 与 shadow root；不可见元素（`display:none`、`input[type=hidden]`、折叠菜单）不列出；不写快照 ref 表与 delta 基线，可与快照在同一页面交替调用。

### 多标签页

一个会话仍只起一个浏览器，但可以有多个标签页：

- 每个页面分配稳定 `tab_id`（`t1`、`t2` …），`browser_e2e_tabs` 列出，`browser_e2e_close_tab` 关闭，最后一个不允许关。
- `browser_e2e_navigate` 传 `new_tab: true` 新建页面并设为 active；传 `tab_id` 指定目标页。
- ref 表、控制台与网络记录都按页隔离：切 tab 后旧 ref 失效，不会串到另一个页面。
- 面板的 tab 条按页展示，tab id 是 `会话key#tab_id` 的组合 id。

### 跟随用户当前标签页

`browser_e2e_follow_tab` 把后续页面工具的默认目标绑定到某一页，只做一次显式绑定：

- 显式传 `tab_id`（`browser_e2e_tabs` 得到的 `t1`、`t2`…）时直接绑定到该页。
- 不传 `tab_id` 时并行探测会话已登记页的主文档，按「唯一聚焦页 → 唯一可见页 → 保持当前 active tab」判定用户正在看的页；无法唯一判定且当前页不在候选时报错，不猜。
- `activate: true` 把目标页带到前台（`page.bringToFront()`）；来源是「保持当前」时不切前台，避免抢用户焦点。隔离模式默认无头，没有可见窗口，`activate` 只在 CDP 接管 / 有头隔离模式有可见效果。
- 绑定后不传 `tab_id` 的工具都作用于该页；用户随后切页不会静默改绑，需要再显式调用本工具。旧页的 ref 与事件环按页隔离，跟随不清理、不重建。

### 事件环重置

每个标签页各有一份控制台记录、网络记录（环形 500 条，按发生顺序，`limit` 取尾部）、ref 表与快照增量基线。页面换文档后旧记录必须失效，实际判据如下：

- 在 Playwright 的 `request` 事件里判断：`request.isNavigationRequest()` 为真且 `request.frame() === page.mainFrame()` 时，视为该页主框架的新文档请求，在登记本次请求之前清空该页的 console / network 记录、ref 表，并把快照增量基线标记失效（丢弃 key 与 ref，保留 `delta` 报 `reset` 的判定依据）。
- Playwright 的 Page 事件不暴露 `loaderId`，因此用「主框架导航请求」作为等价判据：`goto` 同一地址、`reload` 都会发出主框架 document 请求，所以同 URL 重新加载同样会重置；hash 变化与 SPA 路由不产生新文档请求，保留原有记录与增量基线。
- `browser_e2e_navigate` 在调用 `page.goto` 之前还会主动清一次，保证导航失败时旧记录不会挂在本次导航结果上；新文档自身的请求会在 `request` 事件里重新登记，不会被这次清空误删。
- 网络记录的 `request_id`（`n1`、`n2`…）按标签页自增，重置与环形淘汰都不复用；`networkContext`（`request_id` → 请求 / 响应引用）随重置清空、随环形淘汰同步删除，旧 id 不会被新文档的记录冒名顶替。
- 子 frame 导航只把该 frame 的增量基线标记失效（页面脚本注册表 epoch 变化时 delta 退化为全量），主文档基线不动。
- 主框架开始导航时该页 `loading` 置为 true，`domcontentloaded` / `load` 后置 false，面板 tab 上显示「加载中」。

### 重置会话（清登录态 / 换登录态）

不另设 reset 工具，重置由既有调用组合承担：

- **清 cookie / storage、换登录态（isolated，默认模式）**：先 `browser_e2e_close`，再 `browser_e2e_start`。isolated 模式每次启动都是一次性 profile（`chromium.launch`，不带 `userDataDir` / `storageState`），关闭即丢弃 cookie、localStorage、sessionStorage、IndexedDB 与缓存；重新启动得到一张新的空白 `t1`。`browser_e2e_close` 不保留上一会话的 `mode` / `cdpEndpoint`，非默认模式要在 `start` 时重新显式传。
- **只重置 ref 表与事件环**：`browser_e2e_navigate` 到任意新文档即可，同 URL reload 也算（判据见「事件环重置」）；不必关浏览器。
- **回到空白页**：`browser_e2e_navigate` 的 `url: "about:blank"`。
- **不影响其它会话**：`browser_e2e_close` 只关闭本 agent 会话的浏览器；其它会话的浏览器与登录态不受影响。
- **CDP 接管模式**：`browser_e2e_close` 只断开连接，不清用户浏览器的 cookie / storage，也不关用户标签页；需要干净上下文请改用 isolated 会话。
- 两步之间没有浏览器，页面工具会报「浏览器尚未启动」；这是两步组合，不是原子操作。

### 等待 URL 与网络响应

`browser_e2e_wait` 在 `selector` / `expression` 之外支持两类条件。四个条件必须且只能给一个；`state` 只对 selector、`urlMatch` 只对 url / response、response 专属参数只对 response 生效，错配直接报错：

- `url`：等待主框架地址命中。匹配对象是 `page.url()`（含 hash；`pushState` / `replaceState` 也会更新）。调用开始先同步比对一次，命中则立即返回 `matchedCurrent: true`；未命中按约 100ms 轮询，命中时 `matchedCurrent: false`。只看地址，不等文档加载完成——文档生命周期留给 `browser_e2e_navigate` 的 `waitUntil`。超时错误带当前地址；等待期间关页立即报错。
- `response`：等待匹配的响应。条件为 URL 匹配 + 可选 `responseMethod`（比较时两边转大写）+ `statusMin`~`statusMax`（100-599 整数，默认全区间）。`includeBuffered` 默认 true，会先按发生顺序回放该标签页 `networkRing` 里 `status > 0` 的记录并立即返回 `buffered: true`；缓冲窗口是「当前文档」，与「事件环重置」同一判据，上限 `RING_LIMIT` 条（500），CDP 接管模式只覆盖接管后挂上监听的记录。等待未来响应时临时监听 `response` / `requestfailed` / `close` / `crash`，结束即移除。`failOnRequestFailed` 默认 true，匹配 URL 与 method 的请求失败会立即报错；设为 false 则继续等待并把失败请求写进超时诊断。超时错误带条件、已缓冲条数、状态不符的响应与失败请求（各最多 3 条），并提示缓存 / Service Worker 响应可能不产生 `response` 事件。

`url` 与 `response` 共用 `urlMatch`，匹配对象都是完整 URL 字符串、区分大小写：

- `includes`（默认）：`url.includes(pattern)` 子串命中；
- `glob`：整串匹配，`*` 匹配非 `/` 的任意个字符，`**` 匹配任意字符（含 `/`），`?` 匹配单个非 `/` 字符；
- `regex`：`pattern` 当 JS 正则源（子串语义，不自动加 `^` / `$`），编译失败直接报错。

边界与风险：

- `includeBuffered: true` 会让等待前已完成的同 URL 响应立即命中。对同一 URL 周期性轮询的页面，等「点击后新发起的那一次」要传 `includeBuffered: false`，或用更精确的 URL / method / status 条件。
- `response` 是页面级事件，子 frame 的请求也可能命中，不提供按 frame 过滤；`url` 只看主框架。
- `url` 每约 100ms 轮询一次，短于轮询间隔的中间地址可能被跳过；`timeoutMs` 精度同样约 ±100ms。调用中没有取消入口，只能靠 `timeoutMs` 兜底。
- 单次等待超过 `DSH_BROWSER_IDLE_MS` 时浏览器可能在等待期间被空闲回收（见「进程回收」），长等待前把该值设 0 或调到大于单次等待。

### 人机协同等待与验证码检测

扫码登录、2FA、滑块 / reCAPTCHA 这类步骤只能由真人完成。`browser_e2e_captcha_check` 只探测、不阻塞；`browser_e2e_wait_for_human` 把页面交给用户并轮询到人工步骤结束。调用前先告诉用户「去哪个窗口做什么」，等待期间面板不显示额外状态。

- **检测规则**：页内探针按顺序匹配结构选择器——hCaptcha → Turnstile → Cloudflare（`#challenge-form` / `.challenge-form`）→ reCAPTCHA → 通用 `#captcha` / `.captcha`，命中第一组即返回该 `kind`，`evidence` 是命中的单个选择器。结构未命中且 `textScan` 为 true 时读 `document.body.innerText` 前 120000 字符做大小写不敏感短语匹配，命中返回 `kind:'captcha'`、`evidence:'text: <原文前 40 字>'`。只读主 frame：iframe 子文档与 shadow root 内部不遍历；跨源挑战以主文档里的 iframe 元素形态被结构检测命中。
- **loopback 文本豁免**：`localhost`、`127.0.0.1`、`::1`、`[::1]` 与 `*.localhost` 跳过文本检测，避免本机工具界面正文引用验证码字样时自指误报；结构检测不受此限。主机名为空（`data:` / `about:blank`）不跳过。
- **等待判定**：`browser_e2e_wait_for_human` 先做纯参数校验（`timeoutMs` 5000-300000、`pollMs` 250-10000、`reason` 空白折叠后保留前 200 字符、`textScan` 布尔），再解析标签页、校验 `selector` 语法，然后按 `pollMs` 轮询：每轮先查会话 / 标签页是否已关闭，再跑探针；探针失败只记 `probeErrors` 与 `lastProbeError`，本轮不参与判定（登录提交后的导航会让页面脚本短暂不可读）。只有「本轮观测成功、未检测到验证、且 `selector` 为空或已出现」才返回 `resolved:true`。
- **完成信号**：`selector` 是 AND 条件，验证仍在时即使元素出现也不会提前返回。`selector` 只在该标签页主文档内匹配，入口只校验一次语法。
- **超时不是错误**：到点返回 `resolved:false`、`needed` / `kind` / `waitedMs` / `polls` / `probeErrors`、`hint` 与固定摘要，可确认用户完成后再次调用。`resolved:true` 只表示「未检测到验证」（`needed:false` 时同理），不是「页面一定没有验证」；纯图片验证码、无已知 class 的自绘组件、iframe / shadow DOM 内部文本会漏报，可配合 `selector` 或 `browser_e2e_snapshot` / `browser_e2e_read` 兜底。误报（正文讨论验证码的页面）会让等待不结束，可传 `textScan:false` 或用 `selector` 收窄。
- **可见性与 headless**：isolated 模式默认 `headless: true`，用户看不到窗口，本工具除页面自解外只能等出超时；结果的 `headless` 与 `hint` 用于提示「先 close 再以 `headless=false` 重启，或改用 cdp 模式接管可见浏览器」。cdp 模式按可见处理（`headless:false`），不探测用户浏览器本身是否 headless。面板是只读视图，不能代替用户在窗口内操作。
- **边界**：只作用于调用开始时解析的标签页，等待期间不跟随 active tab 切换；同页导航 / 重定向不影响；用户登录若打开新标签页，需 `browser_e2e_tabs` 后在新标签页重新调用。探针是一次 `page.evaluate`，**不可被 `timeoutMs` 中断**：页面主线程死循环或不返回时整次调用会挂住（与 `browser_e2e_evaluate` 同一既有边界）。不做 OCR / 自动解题、面板输入或直控、跨 tab 等待、审批流、重试与截图证据。等待期间不刷新空闲计时，单次等待超过 `DSH_BROWSER_IDLE_MS` 时浏览器可能被空闲回收（见「进程回收」）；默认上限 300000 低于默认空闲 600000，改小该值时需自行保证大于单次等待。

### 断言（browser_e2e_assert）

`browser_e2e_assert` 判定「此刻」是否满足，不等待；需要「直到满足」用 `browser_e2e_wait`（超时仍抛运行时错误，两者是不同工具的不同口径）。一次调用按 `checks` 数组顺序判定 1-20 条，**不短路**：任一条未通过也继续执行，全部完成后统一返回。

- 每条断言必须且只能给 `selector` / `text` / `url` / `expression` 之一（空串按未给处理）。`selector` 配合 `state`（`attached` / `visible` / `hidden` / `detached`，默认 `visible`；可见性口径与快照的 `visibleEnough` 一致，`opacity: 0` 算可见，不做遮挡检测）；`text` 匹配 `document.body.innerText`，区分大小写，`display: none` 的内容不匹配；`url` 匹配主框架完整地址，`urlMatch` 与 `browser_e2e_wait` 同一套 `includes` / `glob` / `regex`；`expression` 是页面内同步表达式，返回 Promise 视为真值、不 await。
- 未通过不抛错：返回值 `pass=false`，`checks[]` 逐条给 `index` / `kind` / `expected` / `pass` / `actual`（`selector` 条目另带 `state`，`url` 条目另带 `urlMatch`），`summary` 单行列未通过条目号。入参非法（含 `selector` 语法非法）、浏览器未启动、`tab_id` 不存在、执行期间页面关闭才抛错；`expression` 的页面求值异常只让该条失败。
- 只读：不写 ref 表、不写快照基线、不动事件环；只作用主文档，不穿透 shadow DOM、不含 iframe 子文档。无 `timeoutMs`、不重试、无取消入口；`expression` 在页面内死循环会挂住整次调用（与 `browser_e2e_evaluate` 的既有边界同源，evaluate 的超时上限不作用于本工具）。

### 多步步骤（recipe）

`browser_e2e_recipe` 把「登录 → 填表 → 提交」这类固定动作串成一次调用：`steps` 是 1-20 个声明式步骤，按数组顺序执行；首个失败即停，**已执行步骤不回滚**，返回值给出逐步 PASS / FAIL、失败步号与 `extract` 输出。整次调用只产生一条面板 `action` 事件，摘要取报告首行。

- **步骤类型**：`navigate`（`url` / `waitUntil`）、`wait`（`selector` / `url` / `response` 三选一及其专属参数）、`click` / `fill` / `hover`（`ref` / `selector` / `x`+`y` 三选一）、`press`（`key`）、`scroll`（`delta_x` / `delta_y`）、`extract`（`selector` / `mode` / `attribute` / `limit`）。字段名与对应工具的顶层参数同名，参数语义与错误文案沿用该工具，不另立一套。
- **不执行调用方脚本**：没有 `evaluate` 步骤，`wait` 步不接受 `expression` 条件；步骤是数据不是代码。需要页面内脚本请单独调用 `browser_e2e_evaluate`。
- **校验先行**：条数、步骤对象、`type`、每类可用字段白名单、必填与枚举 / 区间、三选一、`wait` 条件与专属参数、`extract` 的 `mode` / `attribute` / `limit` 都在任何页面动作之前完成；不合法直接抛错，一个动作都不执行。`fill` 的 `mode` ↔ `delayMs` 耦合、坐标越界、selector 语法与 ref 失效等仍由被复用的能力函数在步骤执行时判定，表现为该步失败。
- **总预算**：`timeoutMs` 默认 60000，允许 1000-120000，只在步骤之间检查；正在执行的 Playwright 动作无法中断，末步之后补一次检查并如实报超预算。`wait` 步的实际等待上限取「步 `timeoutMs`（1000-60000，默认 10000）」与剩余预算的较小值。
- **结果形状**：全部完成 `recipe 完成：n/m 步…`；某步失败 `recipe 在第 i 步（type）失败…` 并附 `FAIL [i]` 行；超预算与标签页中途关闭各有专门摘要。步骤失败**不抛错**，由 `ok:false` 与失败步表达；只有一级校验、浏览器未启动、`tab_id` 不存在、入口时页面已关闭才抛错。
- **`extract`**：`selector` 缺省 `body`，`mode` 为 `text` / `html` / `links` / `attribute`（默认 `text`；`attribute` 模式必填 `attribute`；`links` 取前 `limit` 条 `a[href]`，默认 100、上限 200）。只读主文档，不穿透 iframe 与 shadow DOM；所有输出合计上限 20000 字符，超出截断并标注。
- **边界**：一个 recipe 只作用于一个标签页（`tab_id` 或 active tab），没有 `new_tab`、跨 tab 与嵌套；`navigate` 步沿用既有语义清空 ref 表，因此其后的 `ref` 步必然报 ref 不存在，改用 `selector` / `x`+`y`。没有分支 / 循环 / 变量 / 步骤间取值传递、失败重试、并行步骤与步骤级截图。

### 截图

`browser_e2e_screenshot` 落盘到产物目录并返回路径与元数据，截图前完成全部参数与输出尺寸校验：

- `format` 只接受 png / jpeg；`quality` 只对 jpeg 有效，必须是 1-100 整数；`clip` 与 `fullPage` 互斥，`clip` 四值必须是整数、非负、宽高 >= 1，且不能越出视口；输出单边不超过 8192、总像素不超过 4194304，按基准尺寸乘倍率后校验。
- `scale` 三种形态：`css` / `device` 透传 Playwright 的 `page.screenshot`；整数 `1` / `2` / `3` 是倍率，改走 CDP `Page.captureScreenshot` 的 `clip.scale`。
- `fullPage` + 数值倍率：显式给出 `{x: 0, y: 0, width: 整页宽, height: 整页高, scale: 倍率}` 的 clip，并置 `captureBeyondViewport: true`；不整页的数值倍率用 `captureBeyondViewport: false`，有 clip 按 clip 截、无 clip 只截视口。
- 截图的 `meta.scale` 原样回传请求的形态：`css` / `device` 为字符串，数值倍率为该整数；未传 `scale` 时 meta 里没有该字段。
- 整页宽高取 `document.documentElement.scrollWidth/scrollHeight` 与 `document.body` 的较大值；CDP 接管模式没有固定视口，非整页截图按 `window.innerWidth/innerHeight` 兜底。
- `name` 是文件名前缀，只允许字母、数字、`.`、`_`、`-`，不能含 `..` 或路径分隔符（`/`、`\`、`:`）；落盘时追加「时间戳 + 自增序号」的唯一后缀，实际文件名形如 `<name>-<后缀>.png`。缺省用 `shot-<时间戳+序号>`，同样带唯一后缀。
- 宿主挂载 `attachments` 服务时截图存为附件，工具结果里追加一个图片内容块；附件服务不可用或存图失败时退回纯文本路径，文件此时已经落盘。

### 下载

`browser_e2e_download` 把文件落到下载目录并返回完整性信息，两种来源必须且只能给一种：

- `url`：HTTP(S) 地址经当前标签页所属浏览器上下文的请求客户端取回（`context.request`），与页面共享 Cookie / 登录态，**不导航当前页**。整包读入内存后写盘，因此先按 `Content-Length` 预检，分块传输的超大响应会在读入后才按 `maxBytes` 拒绝。请求失败直接报错，不做「新开临时页导航捕获附件」的回退。
- `ref` / `selector` / `x` + `y`：先登记 `page.waitForEvent('download')`，再按 `browser_e2e_click` 的语义点击一次，等浏览器产生下载事件后流式落盘。点击目标只在主 frame，iframe 内元素不支持；页面自行导航或开新页不回滚。点击没有触发下载时等到 `timeoutMs` 报超时。

落盘与校验口径：

- 目录：默认 `<产物目录>/downloads/`，即 `~/.dsh/browser-e2e/artifacts/<时间戳>/downloads/`；唯一覆盖项是环境变量 `DSH_BROWSER_DOWNLOAD_DIR`（绝对路径），相对路径直接报错。不提供按次 `savePath`。
- 文件名：显式 `filename` 必须是不含目录路径的纯文件名（拒绝路径分隔符、控制字符、Windows 非法字符、`.` / `..`、以点或空格结尾、Windows 保留设备名，最长 180 字符）；未给时按 `Content-Disposition` 的 `filename*` → `filename` → URL 末段 → `download` 取服务器建议名并做宽松清洗（只取 basename、非法字符替换、保留名加前缀、超长保留扩展名）。同名不覆盖，按 `name-1.ext`、`name-2.ext` 递增。
- 大小：`maxBytes` 默认 104857600（100 MiB），取值 1..1073741824（1 GiB）。0 字节一律按失败处理；超限销毁下载流、删除半成品。
- 完整性：成功必返回 SHA-256（64 位小写十六进制）；传了 `expectedSha256` 就强校验，不匹配时报错并删除文件。文件名、字节数与摘要都返回，调用方不要只看文件存在。
- 超时：`timeoutMs` 是总预算（默认 60000，1000..300000），URL 模式传给 `context.request.get`，点击模式用于等事件与写盘；不支持取消、断点续传或重试。
- 模式：isolated 与 cdp 走同一套链路；点击模式统一用 `download.createReadStream()`，不依赖 `download.path()`（远程连接下会抛错）。CDP 模式下用户浏览器策略拒绝下载时按失败处理。

### 浏览器内抓取

`browser_e2e_fetch` 解决「只要正文、不想动当前页」：导航 + `browser_e2e_read` 的组合会把当前标签页导走并重置 ref 表与事件环，抓取则在 `tab_id` 所属浏览器上下文里开一个临时页，取完正文就关掉。

- **取页链路**：`currentTab` 解析目标页 → 建临时页 → `goto`（`waitUntil=domcontentloaded`，`timeoutMs` 只约束这一步）→ 等 `settleMs`（默认 400，`0` 表示不等）→ 页内取 `article` / `main` / `[role=main]`，没有则退回 `body` 的 `innerText`，标题取 `document.title`。
- **临时页不登记**：临时页不写进 `session.pages`，CDP 分支的 `context.on('page')` 也会跳过它，因此 `browser_e2e_tabs`、面板 tab 条与 `state` 都不变；抓取不向 console / network 环形缓冲新增记录。
- **isolated 与 cdp 的差异**：isolated 下临时页是无头、不可见的，且走 `browser.newPage` 另开 context（`browser.newPage` 建出的 context 不接受再 `newPage`；该模式本来每页一个 context，没有跨页登录态可共享，关闭临时页会一并关闭它的 context）。cdp 下临时页建在当前页所属 context（共享用户浏览器整体登录态），是用户浏览器里真实新开又关闭的标签页（会一闪），但不进本会话的标签页列表。
- **返回**：`{ tabId, url, statusCode, title, text, truncated, empty, elapsedMs, mode, summary }`。非 2xx 照常返回结果（以 `statusCode` 为准），`empty` 表示正文提取到 0 字符（非文本响应如 PDF / 图片会落到这里）；正文超过 `maxChars`（默认 16000，上限 180000）时截断并置 `truncated: true`。
- **边界**：只支持 http / https；`innerText` 只含渲染后的可见文本，不返回 HTML，表格按行文本流出、不保留结构，不进入 iframe 与 shadow root；不做 UA / 指纹伪装、不点击、不等特定元素；不落盘（要文件用 `browser_e2e_download`），不缓存、不去重。

### 原始 HTTP

`browser_e2e_http` 是「Playwright 抽象之外的 HTTP 断言」入口，只提供 `mode=context`：

- **出口**：用当前标签页所属浏览器上下文的请求客户端（`context.request.fetch`），不导航当前页；共享该页 Cookie / 登录态，走 `browser_e2e_start` 的 `proxy`。它不是页面内 `fetch`，因此**不受页面 CORS 限制**——e2e 断言接口时 CORS 不是被测对象，登录态才是。
- **参数**：`method` 限 GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS（默认 GET，拒绝 CONNECT / TRACE 与扩展方法）；`headers` 最多 50 项、单项值最长 8192 字符；`body` 最长 262144 字符，GET / HEAD 带 body 报错；`timeout_ms` 默认 30000（1000-120000）；`max_chars` 默认 65536（1-65536）；`tab_id` 缺省当前 active tab。
- **返回**：状态码、`ok`（200-299）、响应头对象、正文视图与重定向信息（`finalUrl` / 是否发生过重定向，最多跟随 20 次；Playwright 1.63 不暴露逐跳请求链，所以 `count` 只有 0 / 1）。文本类正文按 `max_chars` 截断并置 `truncated`；二进制只给字节数与 SHA-256，不返回 base64。非 2xx 是结果不是错误，`ok=false`，不抛错。
- **敏感头**：`authorization` / `cookie` / `set-cookie` 等响应头替换为 `[已隐藏]`（与 `browser_e2e_network_detail` 同口径，没有「显示原值」开关）。
- **不落盘**：只把正文回给模型。需要落盘文件或校验完整性用 `browser_e2e_download`；需要请求上下文（请求头、post data、重定向链）用 `browser_e2e_network_detail`。
- **不做**：原始 CDP（`mode=cdp` 之类）与服务端直连（`mode=server`，不带 Cookie、不走代理）均未实现，记入 `specs/项目规格/0003-未处理项.md` #9；也不支持上传流式 body / multipart / 文件上传、`CONNECT` / `TRACE`、WebSocket 帧操作、Cookie 读写。

### 鉴权补票（本机 DSH GUI）

导航后如果页面落在登录挑战（标题或正文含 `authentication required`）且目标为 loopback http(s)，插件会向宿主的 `connection` 服务要一条 `authenticatedUrl(url)`（带 launch-token 的地址）并重试一次；每个 tab 每次导航只重试一次。

- `connection` 服务不存在、拿不到地址、重试失败或返回同一地址时静默跳过，保持原导航结果，不抛错。
- 非 loopback 目标（`data:`、外部站点）不补票，token 不会交给其它服务。
- 该服务不写进插件 `inject`，因此没有它的宿主照常加载。

### CDP 接管细节

- 只接受 loopback 的 http 端点（默认 `http://127.0.0.1:9222`），其它主机/协议直接报错。
- 不启动新进程、接管时不新建页面、不设置视口；tab 列表取 `context.pages()`，用户新开的页面也会纳入。`browser_e2e_navigate` 传 `new_tab: true` 时会新建一个标签页（`session.context.newPage()`）。
- `browser_e2e_close` 只断开连接，不结束你的浏览器进程，也不关闭标签页。

### 右侧实时浏览器面板

右栏新增 tab 类型 `browser-e2e`（`sidebarRightTabs.register` + `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` 两个 keyed 席位），打开后看到 agent 正在操作的网页本身：

- **实时画面**：宿主半区对当前 tab 走 CDP `Page.startScreencast`，`Page.screencastFrame` 的 JPEG 帧经 WebSocket 推给面板，面板用 `<img src="data:image/jpeg;base64,...">` 逐帧替换；每帧都回 `Page.screencastFrameAck`，否则浏览器不再推下一帧。页面不变时没有新帧，这是协议本身的行为。
- **tab 条**：仅当页面数大于 1 时显示；每个页面一个 tab，id 是「会话 key#tab_id」的组合 id（`example-session#t1`），可切换、可点 × 关闭（只剩一个页面时协议返回 `last-tab`）；tab 文字取页面标题，取不到回退「浏览器画面」，加载中的 tab 附带「加载中」标记。
- **右栏 chip**：右侧栏 `browser-e2e` tab 的标题跟着当前页面标题走。面板 body 从 `state.tabs` 里取当前选中 tab 的 `title`，写进按 `sessionId` 分槽的 liveTitle 通道，chip 用 `useSyncExternalStore` 订阅读出；导航、切 tab、标题变化都会更新，取不到标题时回退「浏览器画面」。
- **工具条**：连接状态灯、模式 chip（「隔离」/「CDP 接管」，CDP 时右侧附带端点，均取自当前选中 tab 所属会话的实际 mode / endpoint）、只读地址栏（`readOnly`，聚焦时自动全选，无页面时显示「无页面」）、刷新按钮、历史按钮。
- **刷新按钮**：静态页面不会产生新帧，点刷新由宿主直接截一帧 JPEG，保证「按一下就有画面」。
- **设置卡片**：`quality`(10-100)、`maxWidth`(100-4096)、`maxHeight`(100-4096)、`everyNthFrame`(1-10)，输入后客户端按区间取整 clamp，再经 socket `configure` 推给宿主（宿主 `mergeConfig` 再校验一次，非整数或越界报错）；只改宿主进程内的 `PanelHub` 配置，不写回 profile，插件重载后回到插件 Config 的值。
- **动作提示**：每次 `browser_e2e_*` 工具调用后，面板收到一条 `action` 事件（工具名 + 一句话摘要），动作提示里显示最近 5 条，新的在前。同一份摘要还会由宿主追加到动作历史文件（写入前脱敏），可用 `browser_e2e_history` 读回，见「动作历史落盘」。
- **历史抽屉**：点工具条的「历史」按钮把画面区换成操作历史抽屉，可回看本次面板会话内最近 50 条动作（时间 + 工具名 + 摘要，新的在前，行内 ellipsis 截断、`title` 给全文）；再点抽屉里的「关闭」回画面。历史只在前端内存，刷新面板或卸载组件后清空；无动作时打开显示「还没有动作」。宿主侧的持久副本由 `browser_e2e_history` 读回，抽屉不读它。
- **设置页**：Plugins 页的插件行由宿主按本插件导出的 `Config`（6 项）自动渲染「配置」入口，保存经宿主 `form.mutate` 写 profile，不重载插件；客户端不注册 `plugins.row.config` 座位。
- 面板是只读视图：它不启动浏览器、不操作页面，所有行为仍然只能由 `browser_e2e_*` 工具发起。唯一例外是协议命令 `close-tab`（用户主动关页，宿主调用 `session.closeTab`）；刷新按钮的 `request-frame` 只触发一次 `captureJpeg` 截图，不改变页面状态。

### 面板协议与路由

协议契约的单一来源是 `lib/protocol.js`：路由路径、版本、关闭码、命令表、事件表、投屏设置区间与默认值、`panelTabId` 组合规则都在那里；host 与 client 的校验从表派生。客户端所需常量（含命令 / 事件表）由 `scripts/build-client.mjs` 在构建时注入到 `lib/client.js`。

下面的路由、命令与错误码是速览；契约文本以 `specs/项目规格/0002-panel-protocol-v1.md` 为准，两处不一致时以规格与 `lib/protocol.js` 为准。

| 路径 | 作用 |
|---|---|
| `GET /api/dsh-browser-e2e/state` | 只读状态快照（socket 连不上时的兜底探测） |
| `WS /api/dsh-browser-e2e/socket` | 面板协议 v1 |

两条路由都做 loopback 围栏：socket 远端地址与 Host 头都必须是 loopback，拒绝 `sec-fetch-site: cross-site`，采信同源 Origin。非 loopback 在升级之前就被拒绝（403）。

- 客户端命令：`attach{sessionId?}`、`select-tab{tabId}`、`close-tab{tabId}`、`request-frame`、`configure{config}`。
- 服务端事件：`hello{state}`、`state{state}`、`frame{tabId,seq,width,height,data}`、`action{trace}`、`error{code,message}`。
- 错误码表共 13 项：`invalid-payload`、`protocol-mismatch`、`unknown-tab`、`last-tab`、`close-tab-failed`、`no-active-tab`、`capture-failed`、`invalid-command`、`invalid-config`、`state-failed`、`config-sync-failed`、`command-failed`、`screencast-failed`。
- 协议版本不一致时按关闭码 `1002` 断开。
- `state` 形状：`{tabs, activeTabId, running, mode, endpoint, config}`；`tabs` 项为 `{id, url, title, loading, origin, sessionId, mode, endpoint}`。`mode` / `endpoint` 由当前 tab 列表推导，列表未带模式时按隔离模式回退（`mode: 'isolated'`、`endpoint: ''`）。
- 面板路由只在宿主提供 `webServer` 服务时挂载；CLI 等没有 webServer 的场景，工具照常可用，只是没有面板。

### 配置

插件级 Config 共 6 个字段，全部声明为即时字段（`.volatile()`）：设置页保存时宿主只替换配置引用并广播 `loader/volatile-update`，不重载插件，因此 `apply` 里读到的是 `{ get() }` 引用，每次取值都取当前快照。

| 字段 | 区间 / 默认值 | 生效路径 |
|---|---|---|
| `defaultMode` | `isolated` / `cdp`，默认 `isolated` | 仅作 `browser_e2e_start` 未显式传 `mode` 时的首次启动缺省值 |
| `cdpEndpoint` | 非空字符串，默认 `http://127.0.0.1:9222`，只接受 loopback | 仅作未显式传 `cdpEndpoint` 时的首次启动缺省值 |
| `quality` | 整数 10-100，默认 70 | 面板投屏初始参数 |
| `maxWidth` | 整数 100-4096，默认 1280 | 面板投屏初始参数 |
| `maxHeight` | 整数 100-4096，默认 800 | 面板投屏初始参数 |
| `everyNthFrame` | 整数 1-10，默认 1 | 面板投屏初始参数 |

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖（patch 是整行替换、不深合并，必须重述该行全部键）：

```yaml
- id: browser-e2e
  config:
    defaultMode: cdp
    cdpEndpoint: http://127.0.0.1:9222
    quality: 70
    maxWidth: 1280
    maxHeight: 800
    everyNthFrame: 1
```

- **首次启动默认值**：`apply` 把 `defaultMode` / `cdpEndpoint` 整理成 `launchDefaults` 交给 `launch`。工具显式传参优先；已启动会话的一致性校验只看工具显式参数，配置默认值不会让运行中的会话报「mode 不一致」。`mode` 只认 `isolated` / `cdp`，端点必须非空，非法值当作未配置。
- **面板投屏初始参数**：插件加载时 `new PanelHub({ config: screencastConfigOf(config) })`，`PanelHub` 构造里用 `initialConfigOf` 按 `PANEL_CONFIG_LIMITS` 逐字段校验，缺失或越界回退 `DEFAULT_SCREENCAST_CONFIG`（70 / 1280 / 800 / 1），一处脏值不会把面板整个卡死。投屏四项在 Config schema 里不设默认值，区间与默认值只在 `lib/protocol.js` 一处定义，客户端构建时从同一份注入。
- **运行中保存**：设置页保存触发 `loader/volatile-update` 后，`lib/index.js` 重读配置并调用 `hub.applyConfig`；与当前设置比较后，有变化先按新参数重开投屏再广播 `state`，无变化直接返回。

### 进程回收

浏览器进程挂在 DSH 服务上，对话结束、会话切走、子代理结束都不会自动回收，因此本插件有三道回收：

1. **空闲回收**：超过 10 分钟没有任何 `browser_e2e_*` 调用，自动关闭该会话的浏览器；`DSH_BROWSER_IDLE_MS` 可改（设 0 关闭该行为）。
2. **会话回收**：`session/disposed` 时按 `session.id` 精确关闭对应浏览器。
3. **卸载回收**：插件卸载或热替换时关闭全部浏览器。

关闭本身也有兜底：Edge 偶发在 graceful close 阶段卡住（进程已退出但 Playwright 等不到退出事件），`DSH_BROWSER_CLOSE_TIMEOUT_MS`（默认 5000）到点后直接结束主进程，避免关闭调用永久挂起。空闲回收计时由 launch 接管（启动过程不装计时器），启动耗时长于 `DSH_BROWSER_IDLE_MS` 时不会被当成闲置在启动中回收。

### 环境变量与产物目录

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_BROWSER_PROXY` | 空 | `browser_e2e_start` 未传 `proxy` 时使用的 HTTP 代理地址 |
| `DSH_BROWSER_IDLE_MS` | `600000`（10 分钟） | 无调用多久后关闭该会话浏览器；`0` 关闭空闲回收 |
| `DSH_BROWSER_CLOSE_TIMEOUT_MS` | `5000` | 关闭浏览器时等待 graceful close 的毫秒上限 |
| `DSH_BROWSER_DOWNLOAD_DIR` | 空 | `browser_e2e_download` 的下载目录（绝对路径）；空表示用 `<产物目录>/downloads/`，相对路径报错 |
| `DSH_BROWSER_HISTORY` | 空 | 设 `0`（或 `false`）时不写动作历史，也不建目录；读回不受影响 |
| `DSH_BROWSER_HISTORY_MAX` | `2000` | 动作历史保留条数上限；只接受正整数，非法值回退默认 |
| `DSH_BROWSER_HISTORY_FILE` | 空 | 动作历史文件路径（绝对路径）；空表示用默认路径，相对路径按默认处理 |

截图落在 `~/.dsh/browser-e2e/artifacts/<时间戳>/`；下载落在该目录的 `downloads/` 子目录（可用 `DSH_BROWSER_DOWNLOAD_DIR` 覆盖）；动作历史落在同根的独立子目录 `~/.dsh/browser-e2e/history/actions.jsonl`。

### 动作历史落盘

每次 `browser_e2e_*` 工具调用结束（成功或失败）由宿主向一个 append-only JSONL 追加一条记录：`seq` / `at` / `tool` / `ok` / `summary` / `session`。工具入参与返回值不落盘；`browser_e2e_history` 自身不记录，避免「读历史」这个动作反复进入历史。

- **目录**：`~/.dsh/browser-e2e/history/actions.jsonl`，与截图产物同根、另立 `history` 子目录；`DSH_BROWSER_HISTORY_FILE` 给绝对路径时以它为准（测试与多实例隔离用）。
- **脱敏**：只在写入前执行一次，按字段表覆盖 `browser_e2e_fill` 的 `value` 与 `browser_e2e_dialog` 的 `prompt_text`，把摘要里所有出现替换成 `[已脱敏 N 个字符]`（N 按码点计）。`action` 事件载荷、面板显示与工具返回值都不变。`navigate` / `wait` 摘要里的 URL 查询参数不脱敏。
- **上限与轮转**：默认保留最近 2000 条（`DSH_BROWSER_HISTORY_MAX` 覆盖）；追加后超过「上限 + 200 条余量」时整份重写为最后 `上限` 条（同目录临时文件 + `rename`），重写失败保留原文件、下次追加再试。不按天过期、不压缩、不导出。
- **截断**：单条摘要落盘前截到 500 个 UTF-16 码元，超出追加 `...(已截断)`。
- **开关**：`DSH_BROWSER_HISTORY=0` 时不写、不建目录；既有文件仍可读。
- **读回**：`browser_e2e_history` 不需要浏览器已启动，默认 `scope=self` 只看本会话（`session` 字段等于本次调用的会话 key），`scope=all` 含同机其它会话；`limit` 非正整数回退 20、超过 200 截到 200，不抛错；文件不存在按空历史返回。

### 使用示例

一次典型验证流程（模型侧看到的工具调用序列）：

```text
browser_e2e_start { headless: true }
browser_e2e_navigate { url: "http://127.0.0.1:53334" }
browser_e2e_snapshot
browser_e2e_click { ref: "@12" }
browser_e2e_fill { selector: "input[name=q]", value: "DSH" }
browser_e2e_hover { selector: ".menu-trigger", settleMs: 300 }
browser_e2e_drag { from: { ref: "@3" }, to: { ref: "@6" }, steps: 12 }
browser_e2e_press { key: "Enter" }
browser_e2e_upload { selector: "input[type=file]", files: "C:\\tmp\\report.pdf" }
browser_e2e_download { url: "http://127.0.0.1:19387/files/report.pdf" }
browser_e2e_download { selector: "#export", expectedSha256: "<64 位十六进制>" }
browser_e2e_dialog { policy: "accept" }
browser_e2e_dialog { limit: 20 }
browser_e2e_wait { selector: ".result", state: "visible", timeoutMs: 5000 }
browser_e2e_wait { url: "**/dashboard", urlMatch: "glob", timeoutMs: 5000 }
browser_e2e_wait { response: "/api/order", responseMethod: "POST", statusMin: 200, statusMax: 299 }
browser_e2e_captcha_check { textScan: true }
browser_e2e_wait_for_human { reason: "login", selector: "#dashboard", timeoutMs: 120000, pollMs: 1500 }
browser_e2e_assert { checks: [{ selector: "#ok", state: "visible" }, { text: "已提交" }, { url: "**/result", urlMatch: "glob" }] }
browser_e2e_recipe { steps: [{ type: "wait", selector: "#user" }, { type: "fill", selector: "#user", value: "demo" }, { type: "fill", selector: "#pass", value: "secret" }, { type: "click", selector: "#submit" }, { type: "wait", selector: "#result" }, { type: "extract", selector: "#result" }] }
browser_e2e_console { limit: 50 }
browser_e2e_console { level: "error" }
browser_e2e_network { limit: 20 }
browser_e2e_screenshot { name: "result", fullPage: true }
browser_e2e_close
```

需要认证的本地服务可在 URL 里带 token 查询参数；导航后要重新 `browser_e2e_snapshot` 获取元素 ref。页面含长连接 / SSE 时不要用 `networkidle`，否则会挂起。

### 验证

以下命令都在本仓根目录执行，按需自跑；**本次 README 重写没有重跑集成测试**，行为描述来自源码与既有测试脚本。

```sh
# 客户端 bundle：client/index.js -> lib/client.js（node --check 校验 + 协议常量注入）
node scripts/build-client.mjs

# 跨调用不变量、会话状态机、协议常量与 client 注入一致性（纯函数，不启动浏览器）
node tests/invariants.mjs

# 客户端注册面与协议纯函数冒烟（Node VM 桩，不启动浏览器）
node tests/client-bundle.mjs

# 投屏串行队列与面板命令串行队列（假 CDP，不启动浏览器）
node tests/screencast.mjs

# 面板宿主半区：围栏 / 设置 / 工具参数契约 / 真实 Edge + WebSocket 端到端协议（含 close-tab）
node tests/panel.mjs

# 多标签页：new_tab / tabs / close_tab / ref 按页隔离
node tests/multitab.mjs

# 跟随当前标签页：焦点 / 可见性判定、显式绑定、并发关页（假页面组不启动浏览器，其余真起无头 Edge）
node tests/follow.mjs

# 鉴权补票：挑战页识别、loopback 限制、失败静默跳过
node tests/auth.mjs

# CDP 接管：真起带远程调试端口的 Edge，接管后 close 只断开连接
node tests/cdp.mjs

# 回收行为：真起无头 Edge，断言会话状态清空且进程回落到运行前基线（脚本自设 8 秒空闲）
node tests/reclaim.mjs

# 工具能力：console / network 列表与网络正文详情 / 全 DOM 快照与 4000 截断 / 三种点击 / fill 三种目标 / 悬停 / 拖拽 / scroll / 截图倍率 / wait
node tests/tools.mjs

# 下载：URL 直接取回 / 点击触发 / 文件名与目录 / 大小上限 / SHA-256（真起无头 Edge + 本地 HTTP 夹具）
node tests/download.mjs

# 原始 HTTP（仅 context 模式）：方法 / 请求头 / body / 响应头 / 重定向 / Cookie / 截断与错误（真起无头 Edge + 本地 HTTP 夹具）
node tests/raw-http.mjs

# 浏览器内抓取：正常抓取 / 参数错误 / 登录态共享 / 不污染既有状态 / 截断与空正文 / 超时（真起无头 Edge + 本地 HTTP 夹具）
node tests/fetch.mjs

# wait 的 url / response 条件：真起无头 Edge + 本地 HTTP 夹具（不在 test:integration 聚合里，单独跑）
node tests/wait.mjs

# 断言工具：真起无头 Edge + 本地 HTTP 夹具（在 test:integration 聚合里，串行真起无头 Edge）
node tests/assert.mjs

# 声明式多步步骤：纯校验 / 渲染组（不启动浏览器）+ 执行组（真起无头 Edge + 本地 HTTP 夹具）
node tests/recipe.mjs

# 人机验证检测与人工等待：检测组 / 等待组 / 校验组（真起无头 Edge + 本地 HTTP 夹具）
node tests/human.mjs

# 文件上传：宿主侧路径校验 / ref、selector、坐标三条下发路径 / 覆盖与清空（真起无头 Edge）
node tests/upload.mjs

# 环境诊断：报告骨架 / 六项检查 / CDP 探测与超时 / 入参与工具表（不启动浏览器）
node tests/doctor.mjs

# 动作历史落盘路径（默认 ~/.dsh/browser-e2e/history/actions.jsonl；设了 DSH_BROWSER_HISTORY_FILE 时等于该值）
node -e "import('./lib/history.js').then(m=>console.log(m.actionHistoryPath()))"

# 分层聚合
npm run test:unit
npm run test:integration
```

集成测试会真起无头 Edge：进程数断言以「回落到运行前基线」为准，不看绝对值；跑前避免本机其它自动化同时操作 Edge。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内部：分层、协议单一来源、状态机、事件环、投屏链路、构建与测试</summary>

按「接口契约分层 + 按变化原因拆分」，依赖单向不回流：

```
接口层   tools.js（32 个工具的表）        protocol.js（面板协议表）
编排层   index.js（注册/生命周期）        panel.js（面板状态与命令分发）
实现层   session.js  page.js  snapshot.js  observation.js  read.js  capture.js  download.js  fetch.js  raw.js  auth.js  human.js  history.js  screencast.js
公共     invariants.js（跨调用不变量）    fence.js（安全围栏）  defaults.js（全局默认值）
         errors.js（超时判定）  hash.js（SHA-256）  viewport.js（视口基准尺寸）
```

- `invariants.js` 只放「违反 = 跨调用状态损坏」的断言，且全部是纯函数；单次入参校验留在各能力函数入口。完整不变量清单、状态机与回收口径见 `specs/项目规格/0001-architecture-invariants.md`。
- `session.js` 用显式状态机（`idle / launching / ready / closing / closed`）管理会话与进程回收；`page.js` 持标签页、事件环写入与 ref 表；`snapshot.js` 持快照引擎（页内扫描脚本、ref 分配、delta / query / frame 分支与基线比较），只依赖 `page.js` 的 `currentTab` / `withTimeout`；`observation.js` 持事件环的只读视图与网络正文（console / network / dialog 读取、网络详情与正文解码、敏感头脱敏），只依赖 `page.js` 的环字段与展示纯函数；`read.js` 持结构化读取的页内扫描与唯一 selector 生成，只依赖 `page.js` 的 `currentTab`；`capture.js` 持截图与产物目录；`download.js` 持下载落盘与完整性校验，复用 `page.js` 的 `currentTab` / `click` 与 `capture.js` 的 `ensureArtifactsDir`，不 import 会话层；`fetch.js` 持浏览器内抓取（临时页 + 正文提取），只依赖 `page.js` 的 `currentTab` / `createTransientPage` 与 `read.js` 的正文预算常量，不 import 会话层、不落盘；`raw.js` 持原始 HTTP（仅 `mode=context`），只依赖 `page.js` 的 `currentTab` / `settleWithin` 与 `observation.js` 的正文 / 脱敏纯函数，不 import 会话层、不落盘；`history.js` 持动作历史的 JSONL 追加、有界裁剪、写前脱敏与读回，只从 `page.js` 借 `timeOf` / `oneLine` 两个展示纯函数；`human.js` 持人机验证探测与人工等待轮询，只依赖 `page.js` 的 `currentTab`；`auth.js` 可整体删除。
- `protocol.js` 是面板协议 v1 的单一契约来源，host 与 client 的校验从表派生；客户端常量由 `scripts/build-client.mjs` 经 `scripts/protocol-inject.mjs` 注入 `lib/client.js`，源码↔产物一致由 `tests/invariants.mjs` 守护。细节见 `specs/项目规格/0002-panel-protocol-v1.md`。
- 投屏链路：工具执行 → `PanelHub.broadcastAction` 与 `scheduleSync` → WebSocket 广播 `state` / `action`；`Screencast` 适配器对当前页开 CDP 投屏，帧经 socket 推给面板，面板回 ack 后取下一帧。
- 新增工具只改 `lib/tools.js`；改协议只改 `lib/protocol.js` 并重新构建客户端。宿主半区是纯 JS，客户端 bundle 手写（不引入打包器）。
- `package.json` 的 `files` 只含 `lib` 与 `cordis.patch.yml`，`client/`、`scripts/`、`tests/` 不会被安装进 profile。改了 `client/index.js` 必须重新跑 `node scripts/build-client.mjs`。

源码入口：`lib/tools.js`（工具表）、`lib/session.js`（状态机）、`lib/page.js`（页面能力）、`lib/snapshot.js`（快照引擎）、`lib/observation.js`（事件环只读视图与网络正文）、`lib/read.js`（结构化读取）、`lib/capture.js`（截图）、`lib/download.js`（下载）、`lib/fetch.js`（浏览器内抓取）、`lib/raw.js`（原始 HTTP）、`lib/history.js`（动作历史落盘与脱敏）、`lib/human.js`（人机验证与人工等待）、`lib/panel.js`（面板）、`lib/protocol.js`（协议）、`lib/errors.js`（Playwright 超时判定）、`lib/hash.js`（SHA-256 摘要）、`lib/viewport.js`（视口基准尺寸）、`client/index.js`（面板 UI）。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- `specs/项目规格/0001-architecture-invariants.md` —— 分层边界、全部不变量、会话状态机与回收口径。
- `specs/项目规格/0002-panel-protocol-v1.md` —— 面板协议 v1 的路由、命令、事件、错误码与版本规则。
- `specs/功能规格/0001-client-entry-activation-failure.md` —— 客户端 entry 激活失败的已知限制与处理。
- `AGENTS.md` —— 本仓开发流程、规格优先规则与测试约定。
- DSH 源码仓库的 `.agents/skills/dsh-doc/templates/package-bundle.md` —— 本 README 采用的 `package-bundle` 模板来源。
- DSH 源码仓库的 `docs/user/develop/basic/publish.md`（bundle / profile / 安装语义）与 `docs/user/develop/basic/index.md`（插件入门）。

-----

<a id="model-experience"></a>
## Model Experience

模型侧只看到工具，不看到面板。32 个 `browser_e2e_*` 工具的 `name` / `description` / `parameters` 进入工具表；`browser_e2e_` 前缀避免与 `browser_*` 工具冲突。

- **每次调用的可见文本**：首行是本次结果的一句话摘要；导航追加标题、当前标签页与「导航后请重新快照」提示；截图追加落盘路径、媒体类型与字节数，附件可用时再追加一个图片内容块；`console` / `network` 返回尾部若干条并在截断时注明缓冲总数，`console` 传 `level` 时只读不低于该级别的记录、摘要写明命中与缓冲；`network_detail` 把请求头 / 请求体 / 响应头 / 响应体分行返回，JSON 两空格缩进，二进制只给字节数与 sha256；失败时抛错，文本为具体原因（如缺少必填参数、ref 失效、最后一个标签页不可关）。
- **状态可见性**：模型只能经 `browser_e2e_tabs` 与各工具返回值推断会话状态，插件不向模型注入额外系统提示或上下文段落。
- **KV cache 影响**：工具结果以普通工具结果追加进会话日志（append-only），不替换系统提示与既有历史；快照、console / network 输出体积较大，会持续增长上下文，大页面建议直接用 `selector` 操作而不做全量快照。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **同一会话的并发启动** —— 同一会话同时只允许一次 launch，后到的调用等前一次落定后按复用返回同一实例，不会并行拉起第二个浏览器；若等待期间会话被 close，后到者收到「浏览器已关闭（启动与关闭并发）」并提示重新启动。
- **快照 4000 上限的体积** —— 全 DOM 逐节点返回并附一行缩进文本，上限 4000 条。实测 4100 个简单 div 的页面返回 4000 条，模型可见文本 193,317 字节（约 189 KB）；DOM 更复杂时体积更大，会明显占用上下文。`delta: true` 与 `query` 可压缩模型可见文本，但 delta 只对比前 4000 个可见节点，4000 条以外的节点不参与对比也不进基线；delta 与 query 的正文各 20000 字符上限，delta 的 removed 列表最多逐条列 200 个。
- **快照脚本 15 秒超时不可终止** —— 单次快照的页面脚本在宿主侧有 15000ms 超时，超时后本次调用报错，但页面脚本本身无法被终止，可能继续占用页面线程并让后续 `evaluate` 排队；遇到同步死循环页面请稍后重试或改用 `browser_e2e_evaluate` 小范围读取。扫描上限 20000 个元素，超过时 `scanTruncated` 为真且 `total` 表示已扫描到的可见元素数。
- **快照只读同源 iframe** —— `frame` 参数只接受同源 iframe（空 url / `about:blank` / `about:srcdoc` 视为同源），跨源 iframe 直接报错；子 frame 只读，节点不分配 ref、不写主文档 ref 表，子 frame 内的元素操作（`f<N>@M` 之类）留给 P1-9。快照增量基线保存在会话内存中，不持久化、不跨会话复用。
- **结构化读取的边界** —— `browser_e2e_read` 只读主文档，不进入任何 iframe（同源也不进）与 shadow root；不可见元素不列出，读隐藏表单需先让页面显示；表格不识别分页与虚拟滚动，`totalRows` 只是 DOM 行数；`input[type=file]` 只给 `hasValue`、不返回文件名；`href` 超过 500 字符时截断并置 `hrefTruncated: true`，截断值不可用于导航；`unique: false` 的 selector 在页面上不唯一，直接交给 click / fill 会因 Playwright strict 模式报错。页面脚本无超时与取消（与快照一致），耗时由 20000 元素扫描上限与 `maxItems` 限住；文本按 16000 字符预算分节截断，大页面请只请求一节或用 `selector` 收窄。
- **跟随不做静默自动跟随** —— `browser_e2e_follow_tab` 只在显式调用时改绑默认标签页；用户随后切页，不传 `tab_id` 的工具仍作用在旧绑定页，需要再调一次。无参判定靠每页主文档的 `document.visibilityState` / `document.hasFocus()`（单页 2000ms 并行超时），无头模式与后台窗口区分度不稳，可能落到「保持当前」（`source=current`、`ambiguous=true`）；isolated 模式下用户自己新开的标签页不登记，只在会话已有页里选；受保护页面（`edge://` 等）与主线程卡死的页会被剔除出候选。确定性绑定请显式传 `tab_id`。
- **多标签页测试的进程计数是观察项** —— `tests/multitab.mjs` 收尾只打印剩余 msedge 主进程数与启动前基线，不据此断言；`tests/reclaim.mjs` 末尾打印的「应为 0」同样只是观察，真正的断言是「回落到 before 基线」——本机若已开着 Edge，基线不是 0，绝对值不可比。
- **profile 里的版本是 git 快照** —— `dsh plugin add` 装的是指定 commit 的快照，改完源码必须 commit + push，再在 profile 里重新解析，否则跑的还是旧提交。
- **插件卡片座位不注册** —— 客户端暂不注册 `web-ui.plugin.item` / `plugins.bundle.config`；在当前桌面宿主上注册会让客户端 entry 激活失败（`web boot: 1 entry did not activate`），插件行改由宿主按 `Config` 自动渲染。
- **静态页面没有新帧** —— 投屏只在实际产生帧时推送，静态页要看到画面需点面板刷新按钮，这是 CDP 投屏协议本身的行为。
- **网络正文读取的边界** —— `browser_e2e_network_detail` 在调用时才回取正文，导航、浏览器内存回收或 Service Worker 响应可能让正文不再可读，此时报「响应体不可读」并提示在同一文档内重读；流式响应（SSE / 长轮询）在 `timeout_ms` 到点报超时，底层读取无法取消；正文在浏览器侧整块缓冲后才按 `max_chars` 截断，超大文件的内存开销不受该参数限制，也不提供 base64 正文与按 URL 猜测式脱敏（默认只隐藏敏感头）。
- **文件上传的边界** —— `browser_e2e_upload` 只处理主 frame（iframe 内的文件控件匹配不到），不支持 `webkitdirectory` 目录上传（目录按「路径不是文件」拒绝），不校验 `accept`、不按扩展名改写文件名或 MIME；`clear: false` 不支持追加（Playwright 无法把已选 `File` 还原成宿主路径），也不能与 `x`+`y` 组合（要先点击才读得到当前选择）。上传完成后不自动点提交、不等待上传请求。
- **下载的边界** —— URL 模式把响应体整体读入内存（`APIResponse` 只有 `body()`），默认 100 MiB、硬上限 1 GiB 是内存风险边界，超大文件改用点击触发模式；URL 请求失败直接报错，不做导航捕获附件的回退；不支持取消、断点续传与重试；点击触发只接本次调用期间的第一个下载事件，`navigate` / `evaluate` 在工具调用之外触发的下载无法追溯；一次只处理一个文件；`Content-Disposition` 缺失且 URL 末段为空时文件名回退 `download`；不按扩展名过滤，也不解析 PDF / 压缩包。
- **浏览器内抓取的边界** —— `browser_e2e_fetch` 用临时页抓取：isolated 下临时页在独立 context（无该页 Cookie，抓完连 context 一起关）、不可见；CDP 下临时页建在当前页所属 context，会在用户浏览器里新开又关闭一个标签页（一闪），但不进 `browser_e2e_tabs` 与面板；临时页不挂事件钩子，抓取不产生 console / network 记录。只取 `article` / `main` / `[role=main]` 或 `body` 的 `innerText`：隐藏节点与 `<script>` / `<style>` 天然剔除，表格按行文本流出、不保留结构，不进入 iframe 与 shadow root；iframe 内正文、`outerHTML`、PDF / 图片等非文本响应都取不到（后者返回 `empty: true` 与状态码，不解析、不落盘，要文件用 `browser_e2e_download`）。`timeoutMs` 只约束导航，`settleMs` 是固定等待，`evaluate` 无超时，整次调用不接取消；不做 UA / 指纹伪装、不点击、不等特定元素，反爬强校验站点仍会失败。单次抓取超过 `DSH_BROWSER_IDLE_MS` 时浏览器可能被空闲回收（与等待类工具的同一已知边界）。
- **原始 HTTP 只有页面上下文模式** —— `browser_e2e_http` 的 `mode` 只接受 `context`；原始 CDP 与服务端直连（`mode=server`，不带 Cookie、不走 `browser_e2e_start` 的代理）均未实现，已记入 `specs/项目规格/0003-未处理项.md` #9。`context` 模式共享当前页 Cookie 与登录态、不受页面 CORS 限制，但不执行页面脚本、不共享页面 localStorage / sessionStorage，也不是「页面内 fetch」语义；CDP 接管模式下请求走同一个用户浏览器的网络栈，但不在用户页面上发起、不占标签页。正文整体读入内存后再按 `max_chars` 截断，大响应请调小该值或改用 `browser_e2e_network_detail`；二进制只回字节数与 SHA-256、不返回 base64；不落盘（要文件与完整性校验用 `browser_e2e_download`）；不支持取消、重试、上传流式 body / multipart、`CONNECT` / `TRACE` 与 WebSocket。敏感响应头恒隐藏且没有「显示原值」开关；重定向最多跟随 20 次，超出按请求失败报错，`redirect.count` 只能给 0（未重定向）/ 1（重定向过），不是逐跳计数（Playwright 1.63 的 `APIResponse` 不提供请求链）。单次调用超过 `DSH_BROWSER_IDLE_MS` 时浏览器可能被空闲回收，随后报「浏览器尚未启动」。
- **悬停与拖拽只作用于主 frame** —— `browser_e2e_hover` / `browser_e2e_drag` 与 `browser_e2e_click` 一致，只查主框架、不进入 iframe；坐标目标按视口 CSS 像素校验，元素目标不暴露 `force` / `sourcePosition` / `targetPosition`，被遮挡时报 Playwright 超时。拖拽中途页面导航会由 Playwright 报执行上下文销毁；HTML5 目标若不在 `dragover` 里 `preventDefault()`，浏览器会拒绝 drop，这是页面行为，不是工具失败。
- **逐键输入（`mode=keystrokes`）的边界** —— 不支持坐标目标（无法可靠清空与校验可编辑性）；不支持真实 IME 与组合键，中文 / emoji 走 `Input.insertText`、不产生 keydown / keyup，`\t` 不会移动焦点；`\n` / `\r` 映射为 Enter，单行 input 里可能触发表单提交。工具在最后一个按键后立即返回，不等防抖落定；掩码与受控组件可能改写最终值，工具不回读。后台标签页里 `document.hasFocus()` 为 false 的编辑器可能忽略按键（不做 focus emulation）。
- **按住键会残留** —— `browser_e2e_press action=down` 按住的键没有自动释放计时，忘记 `action=up` 时它会一直影响后续 click / fill；`navigate` 前会自动释放，但页面自行导航（页面脚本跳转、链接点击）工具感知不到，需要显式 `action=up`。跨 tab 不自动释放，按住状态只属于按下时的标签页。
- **右键与中键的浏览器行为** —— 右键会触发页面 `contextmenu`，但原生右键菜单是否弹出取决于模式与浏览器，工具不负责关闭，菜单可能遮挡后续输入（建议随后点击页面空白处）；中键在 isolated 下打开的新页不在本工具标签页注册表里，在 cdp 下会操作用户真实浏览器。验证链接行为优先用左键配页面事件。
- **对话框处理是「先设策略、后触发」** —— `browser_e2e_dialog` 在对话框打开的事件回调里立即应答（不立即应答页面会冻结），所以无法「先读文案、再按文案决定接受 / 取消」：要验证文案用默认 `dismiss`（记录照写），要走确认分支必须先把 `policy` 设为 `accept` 再触发。策略与记录按标签页隔离，新标签页从 `dismiss` 开始；`beforeunload` 一律接受（与浏览器默认一致）；HTTP 认证、权限请求、`window.print()` 与页面自绘的 `<dialog>` 元素不在覆盖范围；跨源 iframe（OOPIF）里的对话框是否上报未验证。CDP 接管模式下设 `accept` 等于替用户在真实浏览器里点确定。
- **evaluate 超时只中断当前脚本** —— `browser_e2e_evaluate` 的 `timeoutMs` 到点用 CDP 的 `Runtime.terminateExecution` 中断目标页主线程正在执行的脚本：只中断「正在执行」的那段，表达式返回永不 resolve 的 Promise 时页内等待仍会继续；Worker、跨源 iframe 与同源子 frame 内的死循环是否被中断未验证。中断可能打断页面自己的事件处理或框架渲染，DOM 会停在半完成状态，需要时重新 `browser_e2e_snapshot`。CDP 接管模式下这会打断用户浏览器里该页正在执行的脚本。若把 `DSH_BROWSER_IDLE_MS` 设得小于 `timeoutMs`，浏览器可能先被空闲回收，该次调用报「浏览器尚未启动」。
- **人机验证检测是启发式且可能漏报** —— `browser_e2e_captcha_check` / `browser_e2e_wait_for_human` 只匹配已知结构选择器与一组文本短语，且只读主 frame：纯图片验证码、无已知 class 的自绘组件、跨源 iframe 子文档内部与 shadow DOM 内部文本会漏报，等待可能立即返回 `resolved:true`（`needed:false`）。`resolved:true` 只表示「未检测到」，不是「页面一定没有验证」，调用方需自行用 `browser_e2e_snapshot` / `browser_e2e_read` 或 `selector` 兜底。隔离模式默认 headless，用户看不到窗口，除页面自解外只能等出超时；`headless` 与 `hint` 用于改走 `headless=false` 或 cdp。探针是一次页面求值，不可被 `timeoutMs` 中断，页面主线程死锁时整次调用会挂住。
- **剪贴板的边界** —— 只作用主 frame，iframe 内可编辑元素不支持；不提供真实快捷键粘贴（`method=system`）与剪贴板读回，验证复制按钮的推荐路径是「点击复制 → `action=paste` 回填 → 断言页面内容」；`sanitize: false` 只在 isolated 模式允许，且 `isolated` headed 下 `write` 改写的是用户真实系统剪贴板；`grantPermissions` 是整表授予，isolated 写入授予会替换此前的 `clipboard-read`，测试每次读回前需重新授予；非 https / localhost / file 的页面没有 `navigator.clipboard`，`write` 报固定错误而 `paste` 不受影响；后台标签页里 `document.hasFocus()` 为 false 的编辑器可能忽略兜底插入。
- **面板历史不持久** —— 历史抽屉只保留本面板连接内存里的最近 50 条动作，不落盘、不脱敏，重连保留但刷新面板或关闭 tab 后清空；打开面板之前的动作、其它面板连接收到的动作都不在抽屉里。宿主侧的持久副本（已脱敏）由 `browser_e2e_history` 读回，抽屉不读它；宿主侧动作环、跨连接回放属待决策项，面板直控判影响大 → 待决策，未实现。
- **动作历史的边界** —— 落盘在 `~/.dsh/browser-e2e/history/actions.jsonl`（`DSH_BROWSER_HISTORY_FILE` 可覆盖），只记录工具名 / 时间 / 成功失败 / 已脱敏摘要 / 会话，不记录入参原文、返回值、页面访问轨迹、tab 归属与耗时。脱敏只覆盖 `browser_e2e_fill` 的 `value` 与 `browser_e2e_dialog` 的 `prompt_text`：新增工具若在摘要里回显输入，必须同步扩 `SENSITIVE_ARGS`；`navigate` / `wait` 摘要里的 URL 查询参数不脱敏，默认 `scope=self` 只限制可见范围。上限只按条数（默认 2000，`DSH_BROWSER_HISTORY_MAX` 可改），不做按天过期；同一台机器两个实例写同一文件时追加按行不互相撕裂，但裁剪重写可能互相覆盖、丢记录（单实例假设，按实例区分请设 `DSH_BROWSER_HISTORY_FILE`）。`scope=all` 会读到同一台机器上其它会话（含其它 profile）的记录；手工改坏的历史文件按行跳过坏行，不逐行修复。
- **doctor 只体检不修复** —— `browser_e2e_doctor` 不启动浏览器、不安装 Edge、不清理残留进程，也不探测 profile 占用：`edge` 项按 Playwright 的同一条候选路径规则判断可执行文件是否存在，因此不能证明「Edge 一定起得来」；CDP 探测只做一次 TCP 连接与 `GET /json/version`，不建立 CDP 会话、不占用浏览器。代理只校验格式不探活；产物根目录不存在时用最近祖先的 `fs.access(W_OK)` 判可写，Windows 上该 API 对目录 ACL 判定不精确。环境变量在模块加载时求值，进程运行中改值不会反映到报告的生效值上。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文</summary>

None.

</details>
