---
description: "DSH 浏览器端到端验证插件：15 个 browser_e2e_* 工具用系统 Edge 驱动 Playwright 完成导航、快照、点击、填表、截图与取证，并在 Web UI 右侧提供实时浏览器画面面板，供安装、配置、排障或改这个 profile bundle 的人阅读。"
kind: "package-bundle"
---

# dsh-plugin-browser-e2e

## Summary

装进 DSH profile 后，模型获得 15 个 `browser_e2e_*` 工具，用本机系统 Edge 完成页面导航、DOM 快照、点击、填表、滚动、截图、控制台与网络取证、条件等待和页面脚本求值。DSH Web UI 右侧另有一个实时浏览器画面，人可以在对话旁边直接看到模型正在操作的页面，而不必读对话里的一句转述。浏览器按会话隔离、同会话复用，并以空闲、会话销毁、插件卸载三道回收释放进程。主要边界：所有页面操作只能由工具发起，面板是只读视图；CDP 模式只接管已用远程调试端口启动的浏览器，不启动新进程。

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

### 工具一览

15 个工具统一带 `browser_e2e_` 前缀，可与提供 `browser_*` 的插件（如 `@linxin666/dsh-client-ui-browser-view`）共存而不冲突。作用于页面的工具都可带可选的 `tab_id`，不给时作用于当前 active tab。

| 工具 | 作用 |
|---|---|
| `browser_e2e_start` | 启动或复用浏览器；`mode` 选择 isolated / cdp，`cdpEndpoint` 指定接管端点，支持 `headless`、`proxy`、视口尺寸 |
| `browser_e2e_navigate` | 导航到 URL；`waitUntil` 支持 load / domcontentloaded / networkidle（长连接页面不要用 networkidle），`new_tab: true` 新建页并设为当前页，`tab_id` 指定目标页 |
| `browser_e2e_tabs` | 列出本会话标签页：`tab_id` / url / title / active / `loading` / `origin`（`created` 本会话新建 / `adopted` CDP 接管） |
| `browser_e2e_close_tab` | 关闭指定标签页；最后一个标签页不允许关闭，结束整个浏览器用 `browser_e2e_close` |
| `browser_e2e_snapshot` | 全 DOM 结构化快照：每个可见节点带 `tag` / `id` / `classes` / `role` / `name` / `text` / `box` / `depth`，分配 ref（`@N`）；上限 4000 条，超限标记 `truncated` 并给出实际节点数 |
| `browser_e2e_click` | 点击：`ref`（点击前复验可见性，失效报错）/ `selector`（先等可见）/ `x`+`y`（真实鼠标事件）三选一 |
| `browser_e2e_fill` | 向 input / textarea / contenteditable 填入文本：`ref` / `selector` / `x`+`y` 三选一，`value` 必填 |
| `browser_e2e_scroll` | 滚动页面：`delta_x` / `delta_y` 至少一个非 0；给 `x`+`y` 时先移动鼠标到该视口坐标再滚 |
| `browser_e2e_press` | 按下键盘按键（如 Enter、Tab、Escape、Control+A），作用于当前焦点元素 |
| `browser_e2e_screenshot` | 截图：支持 `clip` / `format`(png\|jpeg) / `quality` / `fullPage` / `scale`（`css`、`device` 或整数倍率 1/2/3）/ `name`；落盘返回路径，宿主有附件服务时一并返回图片 |
| `browser_e2e_console` | 读取控制台记录（log/info/warn/error/debug 与未捕获异常），环形 500 条，`limit` 取尾部（默认 100） |
| `browser_e2e_network` | 读取网络记录（url/method/status/mimeType/failure），环形 500 条，`limit` 取尾部；`status` 为 0 表示没有响应，此时看 `failure` |
| `browser_e2e_wait` | 等待条件：`selector`（配合 `state`：attached / visible / hidden / detached）或 `expression`（页面内 JS 表达式，返回真值即满足）二选一，`timeoutMs` 默认 10000，超时报实际等待时长 |
| `browser_e2e_evaluate` | 在页面上下文执行 JavaScript 表达式并返回 JSON 结果；多行逻辑用 IIFE 包装 |
| `browser_e2e_close` | 关闭本会话的浏览器实例；CDP 模式只断开连接，不结束浏览器进程、不关标签页 |

### 多标签页

一个会话仍只起一个浏览器，但可以有多个标签页：

- 每个页面分配稳定 `tab_id`（`t1`、`t2` …），`browser_e2e_tabs` 列出，`browser_e2e_close_tab` 关闭，最后一个不允许关。
- `browser_e2e_navigate` 传 `new_tab: true` 新建页面并设为 active；传 `tab_id` 指定目标页。
- ref 表、控制台与网络记录都按页隔离：切 tab 后旧 ref 失效，不会串到另一个页面。
- 面板的 tab 条按页展示，tab id 是 `会话key#tab_id` 的组合 id。

### 事件环重置

每个标签页各有一份控制台记录、网络记录（环形 500 条，按发生顺序，`limit` 取尾部）和 ref 表。页面换文档后旧记录必须失效，实际判据如下：

- 在 Playwright 的 `request` 事件里判断：`request.isNavigationRequest()` 为真且 `request.frame() === page.mainFrame()` 时，视为该页主框架的新文档请求，在登记本次请求之前清空该页的 console / network 记录与 ref 表。
- Playwright 的 Page 事件不暴露 `loaderId`，因此用「主框架导航请求」作为等价判据：`goto` 同一地址、`reload` 都会发出主框架 document 请求，所以同 URL 重新加载同样会重置；hash 变化与 SPA 路由不产生新文档请求，保留原有记录。
- `browser_e2e_navigate` 在调用 `page.goto` 之前还会主动清一次，保证导航失败时旧记录不会挂在本次导航结果上；新文档自身的请求会在 `request` 事件里重新登记，不会被这次清空误删。
- 主框架开始导航时该页 `loading` 置为 true，`domcontentloaded` / `load` 后置 false，面板 tab 上显示「加载中」。

### 截图

`browser_e2e_screenshot` 落盘到产物目录并返回路径与元数据，截图前完成全部参数与输出尺寸校验：

- `format` 只接受 png / jpeg；`quality` 只对 jpeg 有效，必须是 1-100 整数；`clip` 与 `fullPage` 互斥，`clip` 四值必须是整数、非负、宽高 >= 1，且不能越出视口；输出单边不超过 8192、总像素不超过 4194304，按基准尺寸乘倍率后校验。
- `scale` 三种形态：`css` / `device` 透传 Playwright 的 `page.screenshot`；整数 `1` / `2` / `3` 是倍率，改走 CDP `Page.captureScreenshot` 的 `clip.scale`。
- `fullPage` + 数值倍率：显式给出 `{x: 0, y: 0, width: 整页宽, height: 整页高, scale: 倍率}` 的 clip，并置 `captureBeyondViewport: true`；不整页的数值倍率用 `captureBeyondViewport: false`，有 clip 按 clip 截、无 clip 只截视口。
- 截图的 `meta.scale` 原样回传请求的形态：`css` / `device` 为字符串，数值倍率为该整数；未传 `scale` 时 meta 里没有该字段。
- 整页宽高取 `document.documentElement.scrollWidth/scrollHeight` 与 `document.body` 的较大值；CDP 接管模式没有固定视口，非整页截图按 `window.innerWidth/innerHeight` 兜底。
- `name` 是文件名前缀，只允许字母、数字、`.`、`_`、`-`，不能含 `..` 或路径分隔符（`/`、`\`、`:`）；落盘时追加「时间戳 + 自增序号」的唯一后缀，实际文件名形如 `<name>-<后缀>.png`。缺省用 `shot-<时间戳+序号>`，同样带唯一后缀。
- 宿主挂载 `attachments` 服务时截图存为附件，工具结果里追加一个图片内容块；附件服务不可用或存图失败时退回纯文本路径，文件此时已经落盘。

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
- **工具条**：连接状态灯、模式 chip（「隔离」/「CDP 接管」，CDP 时右侧附带端点，均取自当前选中 tab 所属会话的实际 mode / endpoint）、只读地址栏（`readOnly`，聚焦时自动全选，无页面时显示「无页面」）、刷新按钮。
- **刷新按钮**：静态页面不会产生新帧，点刷新由宿主直接截一帧 JPEG，保证「按一下就有画面」。
- **设置卡片**：`quality`(10-100)、`maxWidth`(100-4096)、`maxHeight`(100-4096)、`everyNthFrame`(1-10)，输入后客户端按区间取整 clamp，再经 socket `configure` 推给宿主（宿主 `mergeConfig` 再校验一次，非整数或越界报错）；只改宿主进程内的 `PanelHub` 配置，不写回 profile，插件重载后回到插件 Config 的值。
- **动作提示**：每次 `browser_e2e_*` 工具调用后，面板收到一条 `action` 事件（工具名 + 一句话摘要），面板保留最近 5 条，新的在前。
- **设置页**：Plugins 页的插件行由宿主按本插件导出的 `Config`（6 项）自动渲染「配置」入口，保存经宿主 `form.mutate` 写 profile，不重载插件；客户端不注册 `plugins.row.config` 座位。
- 面板是只读视图：它不启动浏览器、不操作页面，所有行为仍然只能由 `browser_e2e_*` 工具发起。唯一例外是协议命令 `close-tab`（用户主动关页，宿主调用 `session.closeTab`）；刷新按钮的 `request-frame` 只触发一次 `captureJpeg` 截图，不改变页面状态。

### 面板协议与路由

协议契约的单一来源是 `lib/protocol.js`：路由路径、版本、关闭码、命令表、事件表、投屏设置区间与默认值、`panelTabId` 组合规则都在那里；host 与 client 的校验从表派生。客户端所需常量（含命令 / 事件表）由 `scripts/build-client.mjs` 在构建时注入到 `lib/client.js`。

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

截图落在 `~/.dsh/browser-e2e/artifacts/<时间戳>/`。

### 使用示例

一次典型验证流程（模型侧看到的工具调用序列）：

```text
browser_e2e_start { headless: true }
browser_e2e_navigate { url: "http://127.0.0.1:53334" }
browser_e2e_snapshot
browser_e2e_click { ref: "@12" }
browser_e2e_fill { selector: "input[name=q]", value: "DSH" }
browser_e2e_press { key: "Enter" }
browser_e2e_wait { selector: ".result", state: "visible", timeoutMs: 5000 }
browser_e2e_console { limit: 50 }
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

# 鉴权补票：挑战页识别、loopback 限制、失败静默跳过
node tests/auth.mjs

# CDP 接管：真起带远程调试端口的 Edge，接管后 close 只断开连接
node tests/cdp.mjs

# 回收行为：真起无头 Edge，断言会话状态清空且进程回落到运行前基线（脚本自设 8 秒空闲）
node tests/reclaim.mjs

# 工具能力：console / network / 全 DOM 快照与 4000 截断 / 三种点击 / fill 三种目标 / scroll / 截图倍率 / wait
node tests/tools.mjs

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
接口层   tools.js（15 个工具的表）        protocol.js（面板协议表）
编排层   index.js（注册/生命周期）        panel.js（面板状态与命令分发）
实现层   session.js  page.js  capture.js  auth.js  screencast.js
公共     invariants.js（跨调用不变量）    fence.js（安全围栏）  defaults.js（全局默认值）
```

- `invariants.js` 只放「违反 = 跨调用状态损坏」的断言，且全部是纯函数；单次入参校验留在各能力函数入口。完整不变量清单、状态机与回收口径见 `specs/项目规格/0001-architecture-invariants.md`。
- `session.js` 用显式状态机（`idle / launching / ready / closing / closed`）管理会话与进程回收；`page.js` 持标签页、事件环与 ref 表；`capture.js` 持截图与产物目录；`auth.js` 可整体删除。
- `protocol.js` 是面板协议 v1 的单一契约来源，host 与 client 的校验从表派生；客户端常量由 `scripts/build-client.mjs` 经 `scripts/protocol-inject.mjs` 注入 `lib/client.js`，源码↔产物一致由 `tests/invariants.mjs` 守护。细节见 `specs/项目规格/0002-panel-protocol-v1.md`。
- 投屏链路：工具执行 → `PanelHub.broadcastAction` 与 `scheduleSync` → WebSocket 广播 `state` / `action`；`Screencast` 适配器对当前页开 CDP 投屏，帧经 socket 推给面板，面板回 ack 后取下一帧。
- 新增工具只改 `lib/tools.js`；改协议只改 `lib/protocol.js` 并重新构建客户端。宿主半区是纯 JS，客户端 bundle 手写（不引入打包器）。
- `package.json` 的 `files` 只含 `lib` 与 `cordis.patch.yml`，`client/`、`scripts/`、`tests/` 不会被安装进 profile。改了 `client/index.js` 必须重新跑 `node scripts/build-client.mjs`。

源码入口：`lib/tools.js`（工具表）、`lib/session.js`（状态机）、`lib/page.js`（页面能力）、`lib/capture.js`（截图）、`lib/panel.js`（面板）、`lib/protocol.js`（协议）、`client/index.js`（面板 UI）。

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

模型侧只看到工具，不看到面板。15 个 `browser_e2e_*` 工具的 `name` / `description` / `parameters` 进入工具表；`browser_e2e_` 前缀避免与 `browser_*` 工具冲突。

- **每次调用的可见文本**：首行是本次结果的一句话摘要；导航追加标题、当前标签页与「导航后请重新快照」提示；截图追加落盘路径、媒体类型与字节数，附件可用时再追加一个图片内容块；`console` / `network` 返回尾部若干条并在截断时注明缓冲总数；失败时抛错，文本为具体原因（如缺少必填参数、ref 失效、最后一个标签页不可关）。
- **状态可见性**：模型只能经 `browser_e2e_tabs` 与各工具返回值推断会话状态，插件不向模型注入额外系统提示或上下文段落。
- **KV cache 影响**：工具结果以普通工具结果追加进会话日志（append-only），不替换系统提示与既有历史；快照、console / network 输出体积较大，会持续增长上下文，大页面建议直接用 `selector` 操作而不做全量快照。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **同一会话的并发启动** —— 同一会话同时只允许一次 launch，后到的调用等前一次落定后按复用返回同一实例，不会并行拉起第二个浏览器；若等待期间会话被 close，后到者收到「浏览器已关闭（启动与关闭并发）」并提示重新启动。
- **快照 4000 上限的体积** —— 全 DOM 逐节点返回并附一行缩进文本，上限 4000 条。实测 4100 个简单 div 的页面返回 4000 条，模型可见文本 193,317 字节（约 189 KB）；DOM 更复杂时体积更大，会明显占用上下文。
- **多标签页测试的进程计数是观察项** —— `tests/multitab.mjs` 收尾只打印剩余 msedge 主进程数与启动前基线，不据此断言；`tests/reclaim.mjs` 末尾打印的「应为 0」同样只是观察，真正的断言是「回落到 before 基线」——本机若已开着 Edge，基线不是 0，绝对值不可比。
- **profile 里的版本是 git 快照** —— `dsh plugin add` 装的是指定 commit 的快照，改完源码必须 commit + push，再在 profile 里重新解析，否则跑的还是旧提交。
- **插件卡片座位不注册** —— 客户端暂不注册 `web-ui.plugin.item` / `plugins.bundle.config`；在当前桌面宿主上注册会让客户端 entry 激活失败（`web boot: 1 entry did not activate`），插件行改由宿主按 `Config` 自动渲染。
- **静态页面没有新帧** —— 投屏只在实际产生帧时推送，静态页要看到画面需点面板刷新按钮，这是 CDP 投屏协议本身的行为。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文</summary>

None.

</details>
