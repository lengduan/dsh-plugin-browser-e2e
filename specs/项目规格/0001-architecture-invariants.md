# 架构不变量与会话状态机

状态: 已实现
关联: ../功能规格/0001-client-entry-activation-failure.md（客户端注册面）；0002-panel-protocol-v1.md（面板协议契约）
代码: lib/invariants.js / lib/session.js / lib/page.js / lib/capture.js / lib/auth.js / lib/tools.js / lib/protocol.js / lib/panel.js / lib/index.js / tests/invariants.mjs

## 需求

`lib/` 原来是三个大文件：`browser.js`（1727 行，6 类职责）、`index.js`（653 行，15 个工具平铺）、
`panel.js`（526 行，协议 + 状态 + 投屏）。40 多处 `throw` 把「跨调用不变量」和「单次入参校验」
混在一起，违反前者说明跨多次调用积累的状态机 / 注册表 / 资源处在不允许的组合，违反后者只是
本次入参不合法。混写导致不变量不可见、无法用纯函数测试。

本文把三层接口契约、按变化原因拆分的实现边界、全部 `throw` 的分类、不变量清单、`panelTabId`
组合规则、投屏设置单一来源、会话状态机与进程回收口径固定下来；实现必须与此一致。

收益：不变量成为可单独测试的纯函数；改会话逻辑不必跑截图测试；改截图不必跑协议测试。

## 三层与被切分的文件

纵向是接口契约分层，横向是「变化原因」切分；切分只发生在实现层。

```
接口层   tools.js（工具表）              protocol.js（面板协议表）
编排层   index.js（注册/生命周期）        panel.js（面板状态与命令分发）
实现层   session.js  page.js  capture.js  auth.js  screencast.js
公共     invariants.js（不变量断言）       fence.js（安全围栏）
```

| 文件 | 职责 | 明确不含 |
|---|---|---|
| `lib/protocol.js` | 面板协议 v1 的单一契约来源：路由路径、版本、关闭码、命令表、事件表、投屏设置区间与默认值、`panelTabId` 组合规则 | 运行时状态、连接对象 |
| `lib/invariants.js` | 跨调用不变量断言函数；每个函数配「违反后果」注释；全部纯函数 | 入参校验、I/O、读全局 Map |
| `lib/fence.js` | loopback 围栏（既有） | 不变 |
| `lib/session.js` | 会话注册表（`Map`）、显式状态机、`launch/close/closeTab/closeBySessionId/closeAll`、空闲与关闭兜底计时、面板事件总线、`tabs/listPanelTabs/panelPage` | 页面能力、截图落盘、鉴权补票 |
| `lib/page.js` | 标签页条目与生命周期（`addPage/removePage/currentTab/createPage`）、事件环（console/network 环形缓冲、ref 表）、`snapshot/click/fill/scroll/press/waitFor/evaluate/consoleEntries/networkEntries` | 落盘、协议、面板连接 |
| `lib/capture.js` | 截图参数与尺寸校验、clip / 倍率、产物目录、单次 JPEG 帧（`captureJpeg(page, options)`） | 面板连接、会话注册表 |
| `lib/auth.js` | 登录挑战识别与 loopback 补票（可整体删除而不影响其它能力） | 会话状态 |
| `lib/screencast.js` | CDP 投屏适配器（帧源之一） | 面板状态 |
| `lib/tools.js` | 15 个 `browser_e2e_*` 工具的表（name / description / parameters / run / output） | 生命周期、面板挂载 |
| `lib/panel.js` | 面板状态、命令分发、投屏目标同步、设置合并 | 工具定义 |
| `lib/index.js` | 插件 Config、`apply` 注册与生命周期（工具注册、session/disposed、卸载、面板路由挂载） | 工具实现细节 |
| `client/index.js` | 客户端 bundle（单文件，不拆）；协议常量由 `scripts/build-client.mjs` 从 `lib/protocol.js` 注入 | — |

依赖方向（实现层单向，禁止回指）：

```
tools.js → session.js / page.js / capture.js
index.js → tools.js / panel.js / session.js
panel.js → protocol.js / session.js / screencast.js / capture.js / fence.js
session.js → page.js / capture.js / invariants.js / protocol.js
page.js → auth.js / invariants.js
screencast.js → protocol.js / invariants.js
capture.js → （无内部依赖）
protocol.js / invariants.js / fence.js → （无内部依赖）
```

`page.js` 不 import `session.js`：它接收 session 对象，需要广播面板事件时调用 `session.emit`
（由 `session.js` 在 `sessionOf` 里挂上）。这样会话层可以调用页面层，页面层不回指会话层。

### 唯一允许的端口：帧源

CDP 投屏（`screencast.js`）与单次截图（`capture.js` 的 `captureJpeg`）是同一接缝（帧源）上的
两个真实适配器，因此保留为两个模块；其余依赖都是进程内纯计算或本地可替代，不建端口。

### 明确不做

- 不建 abstract class / interface 关键字 / DI 容器 / 工厂，全部是文件边界 + 纯函数 + 数据表。
- 不把 isolated 与 cdp 拆成两个模块（共享 90% 逻辑，差异不是变化原因）。
- 不按业务功能切工具（`navigation.js` / `input.js` 这类）。
- 不给 `playwright-core` 建 `BrowserDriver` 端口（只有一个适配器）。
- 不给 tab 建 class / 值对象。
- 不保留 `browser.js` 的 re-export 转发层；直接改所有 import。
- `client/index.js` 单文件不拆。

## P3：`lib/` 全部 `throw` 的分类

读取时点：HEAD `1694b2c`（2026-11-06），行号为当时的文件行号。分类口径：

- **跨调用**：违反条件来自跨多次调用积累的状态（会话状态机、标签页注册表、ref 表、投屏会话、
  连接生命周期），换一次调用不会自愈，必须修状态或重启。收敛进 `lib/invariants.js`。
- **单次**：只由本次调用参数（以及当前页面的即时度量）决定，改参数重试即可。留在各能力函数入口。
- **运行时**：既不是不变量也不是入参校验，是操作结果（如等待超时），留在能力函数里。

### `lib/browser.js`

| 行 | 类别 | 违反后果 | 目标归属 |
|---|---|---|---|
| 294 | 跨调用 | 对不存在的 tab 取页对象会抛 TypeError 或操作错页 | `invariants.assertTabExists` |
| 300 | 跨调用 | 没有 active tab 时页面工具作用在 `undefined` 上 | `invariants.assertBrowserRunning` |
| 308 | 跨调用 | CDP 连接已失效仍 `newPage`，报 Target closed | `invariants.assertCdpUsable` |
| 480 | 单次 | 端点字符串不是 URL，连接必然失败 | `session.launch`（入参） |
| 483 | 单次 | 只支持 http 端点 | `session.launch` |
| 486 | 单次 | 非 loopback 端点会把 CDP 暴露给外部主机 | `session.launch` |
| 496 | 跨调用 | 运行中热切 mode 会让隔离进程被当成 CDP 连接关闭 | `invariants.assertModeNotHotSwitched` |
| 503 | 跨调用 | 运行中热切端点会连到另一浏览器而旧浏览器泄漏 | `invariants.assertEndpointNotHotSwitched` |
| 521 | 跨调用 | 并发 launch 期间会话被 close，返回已摘除的实例 | `invariants.assertNotClosedDuringLaunch` |
| 524 | 跨调用 | 并发 launch 失败时后到者拿到半初始化会话 | `invariants.assertLaunchSettled` |
| 556 | 跨调用 | 启动过程中继续 newPage，留下半初始化会话与孤儿进程 | `invariants.assertNotClosedDuringLaunch` |
| 572 | 跨调用 | 无 context 时接管后所有页面能力不可用 | `invariants.assertCdpUsable`（接管前置） |
| 579 | 跨调用 | 无标签页时接管得到空会话 | `invariants.assertCdpUsable`（接管前置） |
| 721 | 跨调用 | 未启动就导航：页面不存在 | `invariants.assertBrowserRunning` |
| 994 | 跨调用 | ref 不在本页 ref 表：xpath 可能指向另一页元素 | `invariants.assertRefBelongsToTab` |
| 1018 | 单次 | 负坐标点击落到视口外 | `page.click/fill/scroll`（入参） |
| 1023 | 单次 | x 超出视口宽度，点不到目标 | `page.js`（入参） |
| 1026 | 单次 | y 超出视口高度，点不到目标 | `page.js`（入参） |
| 1048 | 单次 | 三种点击目标一个都没给 | `page.click`（入参） |
| 1051 | 单次 | 同时给多种目标，点错位置 | `page.click`（入参） |
| 1069 | 跨调用 | snapshot 后元素已移除，按旧 xpath 点击会静默点空 | `invariants.assertRefRevalidated` |
| 1072 | 跨调用 | 元素零尺寸（不可见），点击落到别处 | `invariants.assertRefRevalidated` |
| 1109 | 单次 | checkbox/radio 用 fill 会误切勾选状态 | `page.fill`（入参/目标性质） |
| 1137 | 单次 | 三种填写目标一个都没给 | `page.fill`（入参） |
| 1140 | 单次 | 同时给多种目标，填错位置 | `page.fill`（入参） |
| 1191 | 单次 | 非数字滚动量，页面不动 | `page.scroll`（入参） |
| 1194 | 单次 | 全 0 滚动，页面不动 | `page.scroll`（入参） |
| 1252 | 单次 | clip 非对象，后续按属性取值得到 undefined | `capture.js`（入参） |
| 1256 | 单次 | 非整数 clip，输出尺寸不可预期 | `capture.js`（入参） |
| 1260 | 单次 | 负 clip 起点，输出越界 | `capture.js`（入参） |
| 1263 | 单次 | 宽高 < 1 的 clip 无法截图 | `capture.js`（入参） |
| 1300 | 单次 | 不支持的截图格式 | `capture.js`（入参） |
| 1305 | 单次 | png 带 quality 无意义 | `capture.js`（入参） |
| 1308 | 单次 | quality 越界 | `capture.js`（入参） |
| 1315 | 单次 | 不支持的 scale 形态 | `capture.js`（入参） |
| 1321 | 单次 | clip 与 fullPage 互斥 | `capture.js`（入参） |
| 1329 | 单次 | clip 超出当前视口宽，截到空白 | `capture.js`（入参 + 当前页度量） |
| 1332 | 单次 | clip 超出当前视口高 | `capture.js`（入参 + 当前页度量） |
| 1345 | 单次 | 输出单边超上限，内存与上下文开销失控 | `capture.js`（入参 + 当前页度量） |
| 1348 | 单次 | 输出总像素超上限 | `capture.js`（入参 + 当前页度量） |
| 1425 | 跨调用 | 未启动就读取 console/network 记录 | `invariants.assertBrowserRunning` |
| 1480 | 单次 | selector 与 expression 二选一被破坏 | `page.waitFor`（入参） |
| 1484 | 单次 | 非法 state | `page.waitFor`（入参） |
| 1488 | 单次 | timeoutMs 非正整数 | `page.waitFor`（入参） |
| 1501 | 运行时 | 等待超时是操作结果，不是状态损坏 | `page.waitFor`（保留） |
| 1557 | 跨调用 | 未启动就关闭标签页 | `invariants.assertBrowserRunning` |
| 1560 | 单次 | 缺少 tab_id | `session.closeTab`（入参） |
| 1564 | 跨调用 | 关闭不存在的标签页 | `invariants.assertTabExists` |
| 1567 | 跨调用 | 关掉最后一个标签页后会话失去全部页面，所有工具失效 | `invariants.assertCanCloseLastTab` |

### `lib/index.js`

| 行 | 类别 | 违反后果 | 目标归属 |
|---|---|---|---|
| 181 | 单次 | 必填参数缺失，能力函数收到空值后行为不明 | `tools.js`（工具层前置） |
| 413 | 单次 | fill 目标缺失；与能力函数入口重复，是工具层纵深校验 | `tools.js`（工具层前置） |

### `lib/panel.js`

| 行 | 类别 | 违反后果 | 目标归属 |
|---|---|---|---|
| 62 | 单次 | configure 的 config 不是对象，合并结果不可预期 | `panel.mergeConfig`（入参） |
| 70 | 单次 | 设置项越界，投屏参数被浏览器拒绝或画面异常 | `panel.mergeConfig`（入参） |

### 没有 `throw` 但必须写成不变量的两处

| 位置（原） | 不变量 | 违反后果 | 目标归属 |
|---|---|---|---|
| `screencast.js:21-24` 注释「同一时刻最多持有一个 CDP 会话」 | `assertSingleScreencast` | 两个 CDP 会话同时推帧，面板画面在两个页面间串台 | `invariants.js` |
| `browser.js:150-151` 注释「ref 表按页隔离」 | `assertRefBelongsToTab` | 切 tab 后旧 ref 落到另一页，点击位置错误 | `invariants.js`（与 294/994 同源） |

### 协议层的两条契约（不 `throw`，转 `error` 事件）

| 位置（原） | 契约 | 处理 | 目标归属 |
|---|---|---|---|
| `panel.js:333-340` 协议版本不符 | 同一面板 host 只讲一个版本，首帧版本不符即关闭连接（1002） | `protocol.isSupportedProtocol` 判定后回 `protocol-mismatch` 错误事件 | `protocol.js` + `panel.js` |
| `panel.js:369-371` 最后一个标签页不可关 | 与工具层同一条不变量 | `invariants.assertCanCloseLastTab` 判定后回 `last-tab` 错误事件 | `invariants.js` + `panel.js` |

## 不变量清单（`lib/invariants.js`）

全部纯函数：只读传入参数，不读全局 `Map`，不做 I/O。每个函数一句「违反后果」注释。

| 函数 | 判据 | 错误信息（保持原口径） |
|---|---|---|
| `assertBrowserRunning(session)` | 会话存在且至少一个标签页 | 浏览器尚未启动，请先调用 browser_e2e_start |
| `assertTabExists(session, tabId)` | `tabId` 在该会话 `pages` 里 | tab {id} 不存在，请先 browser_e2e_tabs 获取最新 tab_id |
| `assertCanCloseLastTab(session)` | 会话标签页数 > 1 | 这是最后一个标签页，不能关闭；如需结束整个浏览器请用 browser_e2e_close |
| `assertNotClosedDuringLaunch(session)` | 会话状态不是 closing/closed | 浏览器已关闭（启动与关闭并发），请重新调用 browser_e2e_start |
| `assertLaunchSettled(session)` | 并发启动落定后会话有浏览器 | 浏览器启动失败（同一会话的并发启动未成功），请重试 browser_e2e_start |
| `assertModeNotHotSwitched(session, requestedMode)` | 请求 mode 与已运行会话一致 | 浏览器已启动（{当前} 模式）；如需切换为 {请求} 模式请先 browser_e2e_close |
| `assertEndpointNotHotSwitched(session, requestedEndpoint)` | 请求端点与已运行会话一致 | 浏览器已启动（CDP 端点 {当前}）；如需切换为 {请求} 请先 browser_e2e_close |
| `assertCdpConnected(session)` | 会话仍持有 CDP context | CDP 浏览器连接已失效，请重新 browser_e2e_start |
| `assertCdpContext(context)` | 接管前置：至少一个 context | CDP 浏览器没有可用的 context |
| `assertCdpHasPages(pages)` | 接管前置：至少一个已打开标签页 | CDP 浏览器没有已打开的标签页，无法接管 |
| `assertRefBelongsToTab(tab, ref)` | ref 在该 tab 的 ref 表 | ref {ref} 不存在，请先 browser_e2e_snapshot 获取最新 ref |
| `assertRefRevalidated(ref, check)` | 元素仍命中且宽高 > 0 | ref {ref} 已失效…（两条原文案） |
| `assertSingleScreencast(active, next)` | 安装新 CDP 会话前旧的已置空 | 同一时刻只能有一个投屏会话（违反后果：画面串台） |

## `panelTabId` 组合规则（单一实现：`lib/protocol.js`）

- 组合：`panelTabId(key, tabId) = key + "#" + tabId`；分隔符常量 `PANEL_TAB_SEPARATOR = '#'`。
- 拆分：`parsePanelTabId(panelId)` 取**最后一个** `#`；`#` 不在首字符之后或位于末尾时返回 `null`。
  因此会话 key 自身含 `#` 时仍能正确拆分（以最后一个 `#` 为界）；tab_id 固定为 `t<N>`，不含分隔符。
- 不合规输入（非字符串、无 `#`、`#` 在开头/结尾）一律返回 `null`，由调用方转成 `unknown-tab` 错误。
- host 与 client 都不再各写一份：`session.js` 用 `panelTabId/parsePanelTabId`，`panel.js` 用
  `parsePanelTabId`，`protocol.js` 是唯一实现。
- 既有重复：`browser.js:1651-1662` 与 `panel.js:41-51` 两份逐字相同的解析（基线 1694b2c）。

## 投屏设置口径（单一来源：`lib/protocol.js`）

- `PANEL_CONFIG_LIMITS`：`quality [10,100]`、`maxWidth [100,4096]`、`maxHeight [100,4096]`、
  `everyNthFrame [1,10]`；只有这一份。
- `DEFAULT_SCREENCAST_CONFIG`：`70 / 1280 / 800 / 1`；只有这一份（原在 `screencast.js:13-18`）。
- host 侧：`mergeConfig`（用户当场操作，越界回错误）与 `initialConfigOf`（插件配置可能被手改脏，
  逐字段回退默认）都从区间表派生。
- client 侧：`client/index.js` 不手写区间与默认值，由 `scripts/build-client.mjs` 把
  `PANEL_CONFIG_LIMITS` / `DEFAULT_SCREENCAST_CONFIG` / 协议版本 / 路由路径注入成常量块；
  `tests/invariants.mjs` 校验 `lib/client.js` 里的注入块与 `lib/protocol.js` 逐字段相等。
- 漂移禁令：host 上限改小、client 仍按旧上限 clamp 会让面板收到 `invalid-config`（基线四处口径：
  `panel.js:27-32`、`client/index.js:179-181`、`441-446`、`450-457`；默认值另见
  `screencast.js:13-18` 与 `client/index.js:60`）。

## 会话状态机（`lib/session.js`）

显式状态替代原先的 `launching / launchingPromise / launchTask / closed` 四个字段交叉：

```
idle ──launch──▶ launching ──launchSettled──▶ ready
                    │  └────launchFailed────▶ idle
                    └──close──▶ closing ──closeSettled──▶ closed
ready ──close──▶ closing ──closeSettled──▶ closed
idle ──close──▶ closed
closed：终态，任何事件非法
```

- 转移函数 `nextSessionState(state, event)` 纯函数：只读两个参数，不读全局 `Map`，非法转移抛错；
  `tests/invariants.mjs` 覆盖全部合法 / 非法组合。
- `closing` 期间到达的 `launchSettled` 必须走 `closeSettled`：启动中被 close 时，启动收尾负责
  拆掉已建立的浏览器，不留半初始化会话与孤儿进程。
- `ready` 只表示浏览器与至少一个标签页可用；标签页增删不改状态。
- 并发 launch：后到者等待同一个落定 Promise，不另起浏览器；等待期间被 close 走
  `assertNotClosedDuringLaunch`，落定后仍无浏览器走 `assertLaunchSettled`。
- 计时口径：`idle/ready` 才装空闲计时器；`launching/closing/closed` 不装（`touch` 跳过），
  启动落定后重新计时。

## 进程回收三道兜底（与 README「进程回收」一致）

1. **空闲回收**：`DSH_BROWSER_IDLE_MS`（默认 600000，0 关闭）内无任何工具调用则关闭该会话浏览器；
   计时器只回收它所属的会话对象，不碰同 key 后来新建的会话。
2. **会话回收**：`session/disposed` 按 `session.id` 经 `keyBySessionId` 精确关闭。
3. **卸载回收**：插件卸载 / 热替换时 `closeAll()`。

关闭兜底：`DSH_BROWSER_CLOSE_TIMEOUT_MS`（默认 5000）到点强制结束主进程，避免 graceful close 挂死；
CDP 模式只断连，绝不结束用户浏览器进程。

## P4：实现层调用图（切口核对）

读取时点：HEAD `1694b2c`，`Select-String -AllMatches` 计数。

| 函数 | 调用次数 | 调用方（基线） | 切口后归属 |
|---|---|---|---|
| `sessionOf` | 11 | launch / navigate / snapshot / click / fill / scroll / press / screenshot / evaluate / waitFor / closeTab 等公开能力 | `session.js`（只被 session/page 各能力入口使用；page.js 改为接收 session 对象） |
| `currentTab` | 12 | navigate / snapshot / click / fill / scroll / press / screenshot / evaluate / waitFor / console / network / closeTab | `page.js`（高频，留在页面层，避免被会话层包一层转发） |
| `requireSession` | 4 | consoleEntries / networkEntries / tabs / closeTab 之外的只读入口 | `session.js`（收敛为 `assertBrowserRunning` + `requireSession`） |
| `ensureArtifactsDir` | 3 | launch（返回产物目录）/ screenshot / captureJpeg | `capture.js`（session.js 只在 launch 返回值里调用一次） |
| `panelPage` | 6 | screencast.start / panel.ensureScreencast / captureJpeg / panelPage 自身调用点 | `session.js`，screencast 改为接收 page 参数（不回指会话层） |
| `emitPanelEvent` | 10 | addPage/removePage/事件环/navigate/launch/close | `session.js` 定义，page.js 经 `session.emit` 调用 |
| `panelTabId` | 8 | listPanelTabs / panelPage / panel.js 解析 | `protocol.js` |
| `addPage` | 5 | launch（两条路径）/ navigate（new_tab）/ 事件环接管 | `page.js` |
| `removePage` | 4 | 关页 / page close / crash | `page.js` |
| `requireRef` | 3 | click / fill / snapshot 重建后 | `page.js`（内部转 `assertRefBelongsToTab`） |
| `titleOf` | 3 | tabs / listPanelTabs | `page.js`（页面标题属于页面层） |

结论：`page.js` 与 `capture.js` 之间不存在互相依赖（`capture.screenshot` 接收 `(session, tab, options)`，
`session.launch` 单向调用 `capture.ensureArtifactsDir`），不需要合并；`panel.js` 负责把
`panelPage(panelId)` 解析出的 page 传给 `Screencast.start`，因此 `screencast.js` 不回指会话层。

## 边界

- `invariants.js` 的断言只在「违反=状态损坏」处使用；入参校验留在能力函数入口，不搬进来。
- `auth.js` 可整体删除：删除后除导航不再自动补票外，其余能力不受影响（删除测试）。
- `capture.js` 可整体删除：删除后页面只剩交互，不落盘（删除测试）。
- `invariants.js` 删除后约束会散回各能力函数（删除测试的反向判据）。

## 验收

1. `node tests/invariants.mjs` 通过：覆盖全部不变量断言、状态机全部合法/非法转移、
   `panelTabId` 组合与拆分、协议常量与 client 注入块一致性、投屏设置单一来源。
2. 改 `session.js` 只需跑 `tests/invariants.mjs` + `tests/reclaim.mjs` + `tests/multitab.mjs`；
   改 `capture.js` 只需跑 `tests/tools.mjs` 的截图用例 + `tests/invariants.mjs`；
   若必须全量跑才可信，说明边界没切对。
3. `lib/` 内不再有 `browser.js`（无 re-export 转发层），所有 import 直接指向新文件。
4. 三级测试全绿：见任务书第 6 节；进程计数类断言以回落到运行前基线为准。
