# CDP 接管

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表、进程内对象契约、不变量清单、会话状态机、进程回收、边界）；specs/项目规格/0002-panel-protocol-v1.md（事件表、`state` 形状与 `tabs` 项字段）
代码: lib/session.js / lib/invariants.js / lib/tools.js / lib/defaults.js / lib/capture.js / tests/cdp.mjs / tests/invariants.mjs / tests/panel.mjs

## 需求

`browser_e2e_start` 的 `mode: 'cdp'` 分支让插件接管一个已经用远程调试端口启动的浏览器：复用用户现有页面与登录态，而不是另起一个无头实例。收益是能对真实浏览器里的页面做导航、求值、截图，同时结束时不会误关用户浏览器。

## 行为

- **入口与端点校验**：`browser_e2e_start` 的 `run` 调 `launch`；`mode` 只接受 `isolated` / `cdp`，其它值报 `mode 只支持 isolated / cdp，收到 {值}`。`cdp` 分支用 `normalizeCdpEndpoint` 归一端点：缺省或空串取 `DEFAULT_CDP_ENDPOINT`（`http://127.0.0.1:9222`，插件配置的 `cdpEndpoint` 也参与缺省）；不是合法 URL 报 `cdpEndpoint 不是合法 URL：{文本}`；协议不是 `http:` 报 `cdpEndpoint 只支持 http，收到 {protocol}`（`https:` 同样被拒绝）；主机不是 loopback（`localhost` / `127/8` / `[::1]`，判定在 `lib/fence.js` 的 `isLoopbackHostname`）报 `cdpEndpoint 只允许 loopback 主机（localhost / 127.0.0.1 / ::1），收到 {hostname}`。启动 / 复用 / 并发语义的通用部分见 `0002-browser-launch-and-reuse.md`，本文件只写 CDP 特有的接管与断连。
- **接管**：用 `chromium.connectOverCDP(endpoint)` 只建立连接，不调 `chromium.launch` 启动新进程；取 `browser.contexts()[0]`，先用 `assertCdpContext` 要求至少一个 context（否则 `CDP 浏览器没有可用的 context`），再用 `context.pages()` 与 `assertCdpHasPages` 要求至少一个已打开页面（否则 `CDP 浏览器没有已打开的标签页，无法接管`）。任一断言失败都走 `launch` 的 `finally` 清理：断开已建立的连接、清空 `session.pages`、会话回 `idle`，不留半初始化会话。
- **页面 adopt**：对 `context.pages()` 返回的每个页面调 `addPage(session, page, 'adopted')`，标签页条目的 `origin` 为 `adopted`；`activeTabId` 取第一个页；`attachPageHooks` 对 `adopted` 页用 `document.readyState` 校正初始 `loading`，`tabs` 输出的 `loading` 是布尔值。
- **增量接管**：接管后注册 `context.on('page')`，用户在浏览器里新开的标签页也以 `adopted` 加入本会话（`addPage` 按页对象去重，已在列表里的跳过）。例外：本插件自己创建的临时页（`page.js` 的 `isTransientPage`，如 `browser_e2e_fetch` 的抓取页）不登记；用户新开的页照旧登记。
- **不新建页面**：`cdp` 分支不调 `newPage`；CDP 下唯一新建页面的入口是 `browser_e2e_navigate` 的 `new_tab: true`，它经 `page.js` 的 `createPage` 调 `session.context.newPage()`。
- **不改视口**：`cdp` 分支不设置 `session.viewport`、不调 `setViewportSize`；`browser_e2e_start` 的 `viewportWidth` / `viewportHeight` 参数描述为「仅隔离模式有效」。截图在 `page.viewportSize()` 为空时按 `window.innerWidth/innerHeight` 兜底（`capture.js` 的 `viewportBounds` / `shotBaseSize`，截图口径见 `0003-screenshot-output.md`）。
- **启动返回**：新接管时 `summary` 为 `接管 CDP 浏览器 {endpoint}（{N} 个标签页，系统 Edge {version}）`，工具层追加 `接管端点：{endpoint}` 与 `CDP 模式不会关闭你的浏览器，browser_e2e_close 只断开连接。`；复用路径 `summary` 为 `浏览器已启动（CDP 接管模式，系统 Edge {version}，{N} 个标签页）`。
- **生命周期**：`session.js` 的 `close` 在 `mode === 'cdp'` 时只调 `session.browser.close()` 断开这条 CDP 连接，不走 `closeBrowser`（不强行结束进程）、不关闭用户标签页；返回 `{ closed: true, mode: 'cdp', summary: '已断开 CDP 连接（用户浏览器保持运行）' }`，并把会话从 `sessions` 注册表摘除。
- **面板面**：`listPanelTabs` 对 CDP 会话输出 `mode: 'cdp'` 与 `endpoint: session.cdpEndpoint`，面板 `state` 的 `tabs` 项沿用这两个字段（协议形状见 `specs/项目规格/0002-panel-protocol-v1.md`）。
- **零页可诊断**：已接管会话的 `pages` 为 0 时，`launch` 的复用分支报 `CDP 浏览器已没有打开的标签页，请在浏览器里新建标签页，或先 browser_e2e_close 再重新 browser_e2e_start`，不返回「已启动（0 个标签页）」。

## 边界

- 端点非法（非 loopback、非 `http`、非法 URL）：`launch` 抛错，会话回到 `idle`，不建立连接；已接管会话要换 `mode` / `cdpEndpoint` 必须先 `browser_e2e_close`，否则由 `assertModeNotHotSwitched` / `assertEndpointNotHotSwitched` 报错（规则见 `specs/项目规格/0001-architecture-invariants.md`）。
- 无 context、无已打开页面：报上面对应错误并断开连接、清空会话，浏览器进程不受影响（CDP 清理同样只调 `browser.close()`）。
- 接管后用户关闭页面：`page.on('close')` 只调 `removePage`，`activeTabId` 落到剩余第一个；页面工具随 `assertBrowserRunning` / `assertCurrentTabAvailable` 报「浏览器尚未启动…」。关到 0 页时面板 tab 列表为空、会话仍在 `ready`；此时 `browser_e2e_navigate` 传 `new_tab: true` 经 `createPage` 可以补建一页。
- `close` 后再用：会话已摘除，再次 `browser_e2e_close` 返回 `浏览器未启动，无需关闭`；页面工具报 `浏览器尚未启动，请先调用 browser_e2e_start`；再次 `browser_e2e_start` 会重新 `connectOverCDP` 接管同一个浏览器。启动途中被 `close` 时，连接由 `launch` 的 `finally` 断开，该次 `close` 返回通用摘要 `浏览器已关闭`。
- CDP 下的启动参数：`headless`、`proxy`、`viewportWidth`、`viewportHeight` 都不参与接管（代码只把它们用在隔离分支；工具描述里只有 `headless` 与视口标了「仅隔离模式有效」）。
- 连接失效：`createPage` 先 `assertCdpConnected`，浏览器 `isConnected() === false` 或 `session.context` 为空时报 `CDP 浏览器连接已失效，请重新 browser_e2e_start`，不落到 Playwright 的 `Target closed`。
- 面板是只读视图，不会触发启动或接管（协议边界见 `specs/项目规格/0002-panel-protocol-v1.md`）；CDP 会话 0 页时面板只显示空 tab 列表。

## 验收

- `node tests/cdp.mjs`：exit 0、无 FAIL。覆盖「非 loopback 端点被拒绝」（`非 loopback 端点报错`、`非 http 端点报错`）、「CDP 接管」（`接管成功且 mode 为 cdp`、`摘要包含接管端点`、`tab 列表取 context.pages()（至少 1 个）`、`tab 列表 mode 为 cdp`、`接管页 origin 为 adopted、loading 为布尔`、`接管不杀浏览器进程`、`面板 tab 带 mode=cdp 与实际接管端点`）、「接管后导航 / 求值 / 截图」（`导航成功`、`求值成功`、`截图成功（无固定视口时按内尺寸兜底）`、`导航没有新建 page`）、「close 只断开连接」（`close 返回 cdp 模式`、`浏览器进程仍然存活`、`DevTools 端点仍可访问`）。
- `node tests/panel.mjs`：exit 0、无 FAIL。用例 `browser_e2e_start 的 mode 参数声明枚举`、`tab 带 mode / endpoint 字段（isolated 时 endpoint 为空串）`、`状态含 mode / endpoint 字段` 断言面板 `state` 的 `mode` / `endpoint` 字段；CDP 取值由 `tests/cdp.mjs` 的 `面板 tab 带 mode=cdp 与实际接管端点` 断言。
- `node tests/invariants.mjs`：exit 0、无 FAIL。用例 `CDP 三条不变量各自报原文案`、`CDP 模式没有 context：报错、回 idle 并断开连接`、`CDP 模式没有已打开标签页：报错、回 idle 并断开连接`、`复用路径 0 标签页（cdp）：抛可诊断错误而不是静默成功`、`createPage：CDP 断连时抛友好错误而不是 Target closed`。
