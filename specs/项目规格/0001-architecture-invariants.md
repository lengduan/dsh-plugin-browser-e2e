# 架构不变量与会话状态机

状态: 已实现
关联: ../功能规格/0001-client-entry-activation-failure.md（客户端注册面）；0002-panel-protocol-v1.md（面板协议契约）
代码: lib/invariants.js / lib/session.js / lib/page.js / lib/capture.js / lib/download.js / lib/auth.js / lib/tools.js / lib/protocol.js / lib/defaults.js / lib/panel.js / lib/index.js / lib/screencast.js / lib/fence.js / client/index.js / lib/client.js（构建产物） / tests/invariants.mjs

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
| `lib/defaults.js` | 插件全局默认值：`DEFAULT_CDP_ENDPOINT`；`session.js` 的启动缺省端点、`index.js` 的 Config 默认值、`tools.js` 的工具描述与 `scripts/protocol-inject.mjs` 的客户端注入共用这一份 | 运行时状态 |
| `lib/session.js` | 会话注册表（`Map`）、显式状态机、`launch/close/closeTab/closeBySessionId/closeAll`、空闲与关闭兜底计时、面板事件总线、`tabs/listPanelTabs/panelPage` | 页面能力、截图落盘、鉴权补票 |
| `lib/page.js` | 标签页条目与生命周期（`addPage/removePage/currentTab/createPage`、`attachPageHooks`）、事件环（console/network 环形缓冲、ref 表）、快照基线（`snapshotBaselines`：delta 的 key / 摘要 / ref / epoch）、`navigate/snapshot`（含 delta / query / frame 分支）`/click/fill/hover/drag/upload/scroll/press/waitFor/evaluate/consoleEntries/networkEntries/networkDetail`、`titleOf` | 落盘、协议、面板连接 |
| `lib/capture.js` | 截图参数与尺寸校验、clip / 倍率、产物目录、单次 JPEG 帧（`captureJpeg(page, options)`） | 面板连接、会话注册表 |
| `lib/download.js` | 下载落盘与完整性校验：URL 直接取回 / 点击触发 download 事件、下载目录与文件名、大小上限、SHA-256 | 会话生命周期、面板连接、页面交互实现 |
| `lib/auth.js` | 登录挑战识别与 loopback 补票（可整体删除而不影响其它能力） | 会话状态 |
| `lib/screencast.js` | CDP 投屏适配器（帧源之一） | 面板状态 |
| `lib/tools.js` | 全部 `browser_e2e_*` 工具的表（name / description / parameters / run / output） | 生命周期、面板挂载 |
| `lib/panel.js` | 面板状态、命令分发、投屏目标同步、设置合并 | 工具定义 |
| `lib/index.js` | 插件 Config、`apply` 注册与生命周期（工具注册、session/disposed、卸载、面板路由挂载） | 工具实现细节 |
| `client/index.js` | 客户端 bundle（单文件，不拆）；协议常量、命令 / 事件表与默认 CDP 端点由 `scripts/build-client.mjs`（经 `scripts/protocol-inject.mjs`）从 `lib/protocol.js` / `lib/defaults.js` 注入 | — |
| `lib/client.js` | `client/index.js` 的构建产物（头注释 + 协议常量注入块 + 源码），包内实际被宿主加载的客户端 bundle；由 `scripts/build-client.mjs` 生成，手改会被下一次构建覆盖 | 手写逻辑（客户端逻辑只改 `client/index.js`） |

依赖方向（实现层单向，禁止回指）：

```
tools.js → session.js / page.js / capture.js / download.js / defaults.js
index.js → tools.js / panel.js / session.js / auth.js / defaults.js
panel.js → protocol.js / session.js / screencast.js / capture.js / fence.js
session.js → page.js / capture.js / invariants.js / protocol.js / fence.js / defaults.js
page.js → auth.js / invariants.js
download.js → page.js / capture.js
auth.js → fence.js
screencast.js → protocol.js
capture.js → protocol.js
protocol.js / invariants.js / fence.js / defaults.js → （无内部依赖）
```

构建脚本 `scripts/protocol-inject.mjs` 从 `lib/protocol.js` / `lib/defaults.js` 取注入值；
这是「构建脚本 → lib」的一次性依赖，不进宿主运行期调用图。

`page.js` 不 import `session.js`：它接收 session 对象，需要广播面板事件时调用 `session.emit`
（由 `session.js` 在 `sessionOf` 里挂上）。这样会话层可以调用页面层，页面层不回指会话层。

### 唯一允许的端口：帧源

CDP 投屏（`screencast.js`）与单次截图（`capture.js` 的 `captureJpeg`）是同一接缝（帧源）上的
两个真实适配器，因此保留为两个模块；其余依赖都是进程内纯计算或本地可替代，不建端口。

### 进程内对象契约（隐式接口）

模块之间不只有函数调用，还通过共享可变对象协作。下面是实际跨模块读写的字段。它们是隐式接口：
没有类型检查，改字段名或形状必须同步改消费方。定位一律用符号名，不写行号（行号会随重构漂移；
需要定位时按符号名在文件里检索）。

#### `session` 对象（`session.js` 的 `sessionOf` 创建，`page.js` 读写）

| 字段 | 读写方（符号） | 用途 |
|---|---|---|
| `key` | `page.js` 的 `addPage` / `removePage` / `attachPageHooks`（`notifyChanged`）/ `navigate` 读 | 面板事件里的会话 key |
| `emit` | 同上四个函数调用 | 页面层广播面板事件（不 import `session.js`） |
| `pages` | `page.js` 的 `addPage` / `removePage` / `currentTab` 读写；`session.js` 的 `tabs` / `listPanelTabs` / `closeTab` 读 | 标签页注册表 |
| `activeTabId` | `page.js` 的 `addPage` / `removePage` / `currentTab` / `navigate` 读写；`session.js` 的 `tabs` / `listPanelTabs` 读 | 当前标签页 |
| `nextTabSeq` | `page.js` 的 `addPage` 读并自增；`session.js` 的 `sessionOf` 初始化 | 分配 `t<N>` |
| `hookedPages` | `page.js` 的 `attachPageHooks` 读 / 写 | 防止同一个 page 重复挂监听 |
| `mode` | `page.js` 的 `createPage` 读 | 选择 `newPage` 路径 |
| `context` | `page.js` 的 `createPage` 读 | CDP 模式新建页面 |
| `browser` | `page.js` 的 `createPage` 读 | 隔离模式新建页面与前置检查 |
| `viewport` | `page.js` 的 `createPage` 读 | 隔离模式新页视口 |
| `touch` | `page.js` 的 `scroll` / `consoleEntries` / `networkEntries` 调用；定义在 `session.js` 的 `sessionOf`（挂 `touchSession`） | 刷新空闲计时 |

#### 标签页条目（`page.js` 的 `addPage` 创建）

| 字段 | 读写方（符号） |
|---|---|
| `id` / `page` / `loading` / `origin` | `session.js` 的 `tabs` / `listPanelTabs` 读；`capture.js` 的 `screenshot` 读 `tab.page` |
| `refs` / `consoleRing` / `networkRing` / `networkByRequest` / `networkContext` / `nextNetworkSeq` / `snapshotBaselines` | `page.js` 内部读写（`addPage` / `attachPageHooks` / `clearRings` / `snapshot` / `click` / `fill` / `navigate` / `consoleEntries` / `networkEntries` / `networkDetail`），不跨模块读取 |

#### 其他跨模块字段

- `capture.js` 的 `ensureArtifactsDir` 写 `session.artifactsDir`。
- `panel.js` 的 `ensureScreencast` 读 `screencast.tabId` / `screencast.page`，据此判断「同一个 tab
  但页面对象已经换了」；`Screencast` 的 `cdp` 字段只在 `screencast.js` 内部读写。
- 能力函数返回值被 `tools.js` 各工具 `run` 读的字段（按工具名）：
  - `browser_e2e_start`：`reused` / `summary` / `url` / `mode` / `endpoint` / `artifactsDir`；
  - `browser_e2e_navigate`：`summary` / `title` / `tabId`；
  - `browser_e2e_tabs`：`summary` / `mode` / `text`；
  - `browser_e2e_close_tab`：`summary` / `activeTabId`；
  - `browser_e2e_snapshot`：`summary` / `url` / `tabId` / `text` / `mode` / `frame` / `baseline` / `added` / `changed` / `removed` / `matches` / `truncated` / `scanTruncated`（`mode` / `frame` / `scanTruncated` 各模式都返回；`baseline` / `added` / `changed` / `removed` 只在 delta，`matches` 只在 query）；
  - `browser_e2e_screenshot`：`file` / `data` / `meta`（`summary`、`mediaType`、`name`、`bytes` 等）；
  - `browser_e2e_console` / `browser_e2e_network`：`summary` / `count` / `total` / `text`；
  - `browser_e2e_network_detail`：`summary` / `text`；
  - `browser_e2e_wait`：`summary` / `mode` / `timeoutMs` / `elapsedMs`；
    selector 条件另读 `state`；url 条件另读 `urlMatch` / `matchedUrl` / `matchedCurrent`；
    response 条件另读 `urlMatch` / `responseMethod` / `statusMin` / `statusMax` / `includeBuffered` /
    `matchedResponse`（`url` / `method` / `status` / `mimeType` / `at` / `buffered`）；
  - `browser_e2e_evaluate`：`summary` / `value`；
  - `browser_e2e_click` / `fill` / `hover` / `drag` / `scroll` / `press` / `close`：只读 `summary`；
  - `browser_e2e_upload`：`summary` / `multiple` / `accept` / `totalBytes` / `visible` / `replaced` / `selected`；
  - `browser_e2e_download`：`summary` / `file` / `filename` / `bytes` / `sha256` / `source` / `url` / `suggestedFilename` / `finalUrl`；

### 明确不做

- 不建 abstract class / interface 关键字 / DI 容器 / 工厂，全部是文件边界 + 纯函数 + 数据表。
- 不把 isolated 与 cdp 拆成两个模块（共享 90% 逻辑，差异不是变化原因）。
- 不按业务功能切工具（`navigation.js` / `input.js` 这类）。
- 不给 `playwright-core` 建 `BrowserDriver` 端口（只有一个适配器）。
- 不给 tab 建 class / 值对象。
- 不保留 `browser.js` 的 re-export 转发层；直接改所有 import。
- `client/index.js` 单文件不拆。

## P3：`lib/` 全部 `throw` 的分类

读取时点：HEAD `1694b2c`（2026-11-06），行号为当时的文件行号。本表是拆分前的历史存档：
`lib/browser.js` 已不在仓库里，表内行号不按当前文件校对，只用于追溯每类 throw 的归属；P4 调用
图表同理。当前代码的位置一律按符号名定位（见「进程内对象契约」的开头约定）。分类口径：

- **跨调用**：违反条件来自跨多次调用积累的状态（会话状态机、标签页注册表、ref 表、投屏会话、
  连接生命周期），换一次调用不会自愈，必须修状态或重启。收敛进 `lib/invariants.js`。
- **单次**：只由本次调用参数（以及当前页面的即时度量）决定，改参数重试即可。留在各能力函数入口。
- **运行时**：既不是不变量也不是入参校验，是操作结果（如等待超时），留在能力函数里。

### `lib/browser.js`

| 行 | 类别 | 违反后果 | 目标归属 |
|---|---|---|---|
| 294 | 跨调用 | 对不存在的 tab 取页对象会抛 TypeError 或操作错页 | `invariants.assertTabExists` |
| 300 | 跨调用 | 没有 active tab 时页面工具作用在 `undefined` 上 | `invariants.assertBrowserRunning` |
| 308 | 跨调用 | CDP 连接已失效仍 `newPage`，报 Target closed | `invariants.assertCdpConnected` |
| 480 | 单次 | 端点字符串不是 URL，连接必然失败 | `session.launch`（入参） |
| 483 | 单次 | 只支持 http 端点 | `session.launch` |
| 486 | 单次 | 非 loopback 端点会把 CDP 暴露给外部主机 | `session.launch` |
| 496 | 跨调用 | 运行中热切 mode 会让隔离进程被当成 CDP 连接关闭 | `invariants.assertModeNotHotSwitched` |
| 503 | 跨调用 | 运行中热切端点会连到另一浏览器而旧浏览器泄漏 | `invariants.assertEndpointNotHotSwitched` |
| 521 | 跨调用 | 并发 launch 期间会话被 close，返回已摘除的实例 | `invariants.assertNotClosedDuringLaunch` |
| 524 | 跨调用 | 并发 launch 失败时后到者拿到半初始化会话 | `invariants.assertLaunchSettled` |
| 556 | 跨调用 | 启动过程中继续 newPage，留下半初始化会话与孤儿进程 | `invariants.assertNotClosedDuringLaunch` |
| 572 | 跨调用 | 无 context 时接管后所有页面能力不可用 | `invariants.assertCdpContext`（接管前置） |
| 579 | 跨调用 | 无标签页时接管得到空会话 | `invariants.assertCdpHasPages`（接管前置） |
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
| `screencast.js:21-24` 注释「同一时刻最多持有一个 CDP 会话」 | `assertSingleScreencast` | 两个 CDP 会话同时推帧，面板画面在两个页面间串台 | `invariants.js`（生产路径由串行队列保证，见下） |
| `browser.js:150-151` 注释「ref 表按页隔离」 | `assertRefBelongsToTab` | 切 tab 后旧 ref 落到另一页，点击位置错误 | `invariants.js`（与 294/994 同源） |

`assertSingleScreencast` 目前只被 `tests/invariants.mjs` 的 `assertSingleScreencast` 用例调用，
生产路径不再调用它。
同一时刻只持有一个 CDP 会话由 `lib/screencast.js` 的内部串行队列结构性保证：`start` / `stop`
都经 `Screencast` 的 `enqueue` 排队（`start` / `stop` / `_start` / `_stop` 都走队列），`_start` 先
`_stop` 掉旧会话；该断言保留给纯函数测试。

### 协议层的两条契约（不 `throw`，转 `error` 事件）

| 位置（原） | 契约 | 处理 | 目标归属 |
|---|---|---|---|
| `panel.js:333-340` 协议版本不符 | 同一面板 host 只讲一个版本，首帧版本不符即关闭连接（1002） | `protocol.isSupportedProtocol` 判定后回 `protocol-mismatch` 错误事件 | `protocol.js` + `panel.js` |
| `panel.js:363-368` + `session.js:540-546` 最后一个标签页不可关 | 与工具层同一条不变量；判据是「目标 tab 所属会话的页数」 | 面板只有 tab 列表、没有 session 对象，`panel.js` 先按 `sameSessionTabs.length <= 1` 预检并回 `last-tab`；`session.closeTab` 内仍调 `invariants.assertCanCloseLastTab` 兜底，并把 `error.code` 置为 `'last-tab'`（`panel.js:372` 按 code 转错误） | `invariants.js` + `session.js` + `panel.js` |

## 不变量清单（`lib/invariants.js`）

全部纯函数：只读传入参数，不读全局 `Map`，不做 I/O。每个函数一句「违反后果」注释。

| 函数 | 判据 | 错误信息（保持原口径） |
|---|---|---|
| `assertBrowserRunning(session)` | 会话存在且至少一个标签页（0 页按「尚未启动」处理） | 浏览器尚未启动，请先调用 browser_e2e_start |
| `assertCurrentTabAvailable(session)` | 会话存在、`activeTabId` 非 null/undefined，且该 id 在 `pages` 里 | 浏览器尚未启动或没有可用标签页，请先 browser_e2e_start |
| `assertTabExists(session, tabId)` | `tabId` 在该会话 `pages` 里 | tab {id} 不存在，请先 browser_e2e_tabs 获取最新 tab_id |
| `assertCanCloseLastTab(session)` | 会话标签页数 > 1 | 这是最后一个标签页，不能关闭；如需结束整个浏览器请用 browser_e2e_close |
| `assertNotClosedDuringLaunch(session)` | 会话状态不是 closing/closed | 浏览器已关闭（启动与关闭并发），请重新调用 browser_e2e_start |
| `assertLaunchSettled(session)` | 并发启动落定后会话有浏览器 | 浏览器启动失败（同一会话的并发启动未成功），请重试 browser_e2e_start |
| `assertModeNotHotSwitched(currentMode, requestedMode)` | 请求 mode 与已运行会话一致 | 浏览器已启动（{当前} 模式）；如需切换为 {请求} 模式请先 browser_e2e_close |
| `assertEndpointNotHotSwitched(currentEndpoint, requestedEndpoint)` | 请求端点与已运行会话一致 | 浏览器已启动（CDP 端点 {当前}）；如需切换为 {请求} 请先 browser_e2e_close |
| `assertCdpConnected(session, isConnected)` | 会话仍持有 CDP context，且 `isConnected`（调用方传入的 `browser.isConnected()` 结果）不为 `false`；未探测（undefined）时只按 context | CDP 浏览器连接已失效，请重新 browser_e2e_start |
| `assertCdpContext(context)` | 接管前置：至少一个 context | CDP 浏览器没有可用的 context |
| `assertCdpHasPages(pages)` | 接管前置：至少一个已打开标签页 | CDP 浏览器没有已打开的标签页，无法接管 |
| `assertRefBelongsToTab(tab, ref)` | ref 在该 tab 的 ref 表 | ref {ref} 不存在，请先 browser_e2e_snapshot 获取最新 ref |
| `assertRefRevalidated(ref, check)` | 元素仍命中且宽高 > 0 | ref {ref} 已失效…（两条原文案） |
| `assertSingleScreencast(activeCdp)` | `activeCdp` 为 null/undefined（当前没有持有 CDP 会话） | 同一时刻只能有一个投屏会话（违反后果：画面串台） |

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
  单次 JPEG 帧（`capture.js` 的 `captureJpeg`）未传 `quality` 时也取它的 `quality`，不另写默认值。
- host 侧：`mergeConfig`（用户当场操作，越界回错误）与 `initialConfigOf`（插件配置可能被手改脏，
  逐字段回退默认）都从区间表派生。
- client 侧：`client/index.js` 不手写区间与默认值，由 `scripts/build-client.mjs` 把
  `PANEL_CONFIG_LIMITS` / `DEFAULT_SCREENCAST_CONFIG` / 协议版本 / 路由路径注入成常量块；
  `tests/invariants.mjs` 校验 `lib/client.js` 里的注入块与 `lib/protocol.js` 逐字段相等。
- 漂移禁令：host 上限改小、client 仍按旧上限 clamp 会让面板收到 `invalid-config`。当前需要保持一致
  的口径：`panel.js` 的 `mergeConfig` / `initialConfigOf`、`client/index.js` 的 `normalizeConfig`
  与 `CONFIG_FIELDS`（面板画面设置）、以及注入块里的 `DEFAULT_SCREENCAST_CONFIG`；client 不再有
  独立的插件设置字段表。为避免行号随重构漂移，此清单按符号名维护。

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
- 启动收尾（`launch` 的 `finally` 分支）发现会话已是 `closing` 时，必须走 `closeSettled`：先按
  本次目标 mode 拆掉已建立的浏览器（isolated 强制结束进程、cdp 只断连），再把 `closing` 收成
  `closed`，不留半初始化会话与孤儿进程。注意这不是给转移表加边：`closing --launchSettled-->`
  仍非法（`tests/invariants.mjs` 的非法转移用例覆盖），`launchSettled` 只在非关闭路径上使用。
- `ready` 表示「浏览器可用」，允许 0 个标签页；标签页增删不改会话状态，0 页是可恢复态：
  页面工具（`assertBrowserRunning` / `assertCurrentTabAvailable`）仍报「浏览器尚未启动」，
  `browser_e2e_start` 的复用路径按模式处理 —— 隔离模式补建一页后返回复用结果，CDP 模式报
  「CDP 浏览器已没有打开的标签页」的可诊断错误。`page.on('close')` / `page.on('crash')` 只调
  `removePage`，不写 `session.state`；浏览器是否关闭只由 `close` 决定（`ready --close--> closing`）。
- 复用分支（已有浏览器）同样建立落定信号（`launchingPromise` / `launchTask`），并发 `close` 等它
  走完再关浏览器、并发 `launch` 等它落定；返回成功前复查会话仍在 registry 里且不是
  `closing` / `closed`，不满足就抛并发关闭错误，不返回假的 `reused: true`。
- 并发 launch：后到者等待同一个落定 Promise，不另起浏览器；等待期间被 close 走
  `assertNotClosedDuringLaunch`，落定后仍无浏览器走 `assertLaunchSettled`。
- 计时口径：`idle/ready` 才装空闲计时器；`launching/closing/closed` 不装（`touch` 跳过），
  启动落定后重新计时。

## 进程回收三道兜底（与 README「进程回收」一致）

1. **空闲回收**：`DSH_BROWSER_IDLE_MS`（默认 600000，0 关闭）内无任何工具调用则关闭该会话浏览器；
   计时器只回收它所属的会话对象，不碰同 key 后来新建的会话。
   已知边界（已记录，未修）：计时从「本次工具调用开始」算，一次 `browser_e2e_wait` 等调用若本身
   耗时超过 `DSH_BROWSER_IDLE_MS`，浏览器可能在等待期间被回收，该次调用随后报「浏览器尚未启动」。
   规避：把 `DSH_BROWSER_IDLE_MS` 设为 0 或大于单次调用时长。
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
| ~~`requireRef`~~ | 3 | click / fill / snapshot 重建后（该函数已不在代码里，click / fill 直接调 `assertRefBelongsToTab`） | `page.js` |
| `titleOf` | 3 | tabs / listPanelTabs | `page.js`（页面标题属于页面层） |

结论：`page.js` 与 `capture.js` 之间不存在互相依赖（`capture.screenshot` 接收 `(session, tab, options)`，
`session.launch` 单向调用 `capture.ensureArtifactsDir`），不需要合并；`panel.js` 负责把
`panelPage(panelId)` 解析出的 page 传给 `Screencast.start`，因此 `screencast.js` 不回指会话层。

## 边界

- `invariants.js` 的断言只在「违反=状态损坏」处使用；入参校验留在能力函数入口，不搬进来。
- `auth.js` 删除是**能力删除**：需同时删 `page.js` 对 `topUpIfChallenged` 的 `import` 与 `navigate`
  里的调用、`index.js` 的 `setConnectionResolver` 注入，并删 `tests/auth.mjs`；删除后导航不再自动
  补票，其余能力不受影响。
- `capture.js` 删除同样是**能力删除**：需同时改 `session.js` 的产物目录（`import { ensureArtifactsDir }`
  与 `launch` 里的调用）、`download.js` 的下载目录派生（`import { ensureArtifactsDir }`）、`tools.js`
  的截图工具（`import { screenshot }` 与 `browser_e2e_screenshot`
  定义）、`panel.js` 的刷新帧（`import { captureJpeg }` 与 `request-frame` 分支）；删除后截图能力随之
  消失，面板刷新按钮也没有可截的帧源。
- 上述两条都是能力删除，不是零改动模块删除。
- `invariants.js` 删除后约束会散回各能力函数（删除测试的反向判据）。

## 已知结构性债务

以下是独立复核确认、但本轮**未处置**的结构性项；处置时须先改本规格再动代码。

| 项 | 现状 | 未处置理由 |
|---|---|---|
| `page.js` 粒度过大 | 1380 行（2026-11-07 实测；新增 hover / drag 前为 1144）、27 个导出，混装：标签页注册表与生命周期、事件环（console/network 环形缓冲、ref 表）、snapshot 的 DOM→xpath/role/name 启发式、七种交互动作、视口度量、展示格式化。 | 拆分面覆盖所有页面能力，回归风险高；且本规格「三层与被切分的文件」的模块表把这几块整体划给 `page.js`，拆分须先改规格。建议拆为 `snapshot.js`（DOM 快照引擎）与 `observation.js`（事件环），交互与格式化留在 `page.js`。P0-3 的 delta / query / frame 分支与基线对比仍留在 `page.js`，未改变本债务；后续拆分时一并迁入 `snapshot.js`。 |
| 视口度量三份 | `page.js` 的 `viewportBounds`、`capture.js` 的 `viewportBounds`、`capture.js` 内联的 `innerWidth/innerHeight` 兜底。 | 收敛需要新建公共模块或调整依赖方向（`capture.js` 现仅依赖 `protocol.js`），会改动本规格的依赖图，故留待拆分 `page.js` 时一并处理。 |
| `session.js` 粒度过大 | 约 680 行、16 个导出，混装四类变化原因：会话注册表与状态机、`launch`/`close` 与进程回收、面板事件总线、面板读模型（`panelPage`/`listPanelTabs`）与工具能力（`tabs`）。与 `page.js` 同性质。 | 面板读模型（`panelPage`/`listPanelTabs`）与事件总线是「面板视图」关注点，与浏览器生命周期无关，建议拆 `lib/view.js`；但 `sessions` Map 是私有状态，拆分需同时决定注册表暴露面，属本规格模块表变更，须先改规格。**处置前不得再往 `session.js` 加职责。** |
| 串行队列两份 | `lib/panel.js` 与 `lib/screencast.js` 各有一份 enqueue/queue 实现（除队列字段名外逻辑相同）。 | 两者分属不同模块的私有同步原语，抽出公共模块会增加一条依赖边并改本规格依赖图，留待拆分 `session.js` / `page.js` 时一并评估。 |
| 会话解析入口不统一 | 9 个工具用 `sessionOf`（会创建会话对象：navigate/snapshot/click/fill/scroll/press/screenshot/wait/evaluate），`console`/`network` 用 `requireSession`，`tabs`/`close_tab` 分别经 `listSessionTabs`/`closeTab` 内部读注册表（不创建）。未启动时前一类会留下 idle 会话条目，且报错文案不同（「浏览器尚未启动或没有可用标签页」vs「浏览器尚未启动，请先调用…」）。 | 行为差异只影响未启动时的会话表残留与文案，不影响已有会话；统一入口需要逐工具核对语义，留待后续。 |
| 展示格式化四处 | `page.js` 的 `timeOf`/`oneLine`、`session.js` 的 `tabs` 文本拼装、`tools.js` 的标题拼串、`client/index.js` 的 `formatClock`；其中 `timeOf` 取 ISO 的 UTC 段、`formatClock` 用本地时区，同一瞬间显示不同。 | 上移格式化会改动 `tools.js` 全部 `run` 的返回契约，属较大重构，留待单独一轮。 |
| client 文案 / 样式孤儿键 | `client/index.js` 现有 17 个无引用 EN 文案键（`EN` 共 45 键）与 9 个无引用 `st` 样式键（`st` 共 44 键，含 `st.url`）；2026-11-07 解析两个对象并统计引用实测。 | 属整洁度，不影响行为；清理需与 `tests/client-bundle.mjs` 的文案断言一起核对，留待单独一轮。 |
| 工具描述里的 limit / timeoutMs 默认值 | `lib/tools.js` 描述与 `lib/page.js` 写死「默认 100」「默认 10000」，与已收敛的视口 / 快照 / 截图 / 缓冲上限常量同类，但尚无单一来源。 | 需新增常量并补本规格的常量口径，属 11 条 P2 清单外的同类残留，留待后续。 |

## 验收

1. `npm run test:unit` 通过（脚本内容见 `package.json`：`node tests/invariants.mjs &&
   node tests/client-bundle.mjs && node tests/screencast.mjs`）：覆盖全部不变量断言、状态机全部
   合法/非法转移、`panelTabId` 组合与拆分、协议常量与 client 注入块一致性、投屏设置单一来源、
   投屏串行队列。
2. 按改动面跑可执行命令（每条都以 `npm run test:unit` 打底；含 `tests/` 的命令会真起无头 Edge）：
   - 改 `session.js`：`npm run test:unit && node tests/panel.mjs && node tests/multitab.mjs && node tests/reclaim.mjs`
     （`panel.js` 也覆盖 session 的面板面）。
   - 改 `capture.js`：`npm run test:unit && node tests/tools.mjs && node tests/panel.mjs`。
   - 改 `page.js` / `tools.js`：`npm run test:unit && node tests/tools.mjs && node tests/multitab.mjs`。
   - 改 `protocol.js` / `panel.js` / `index.js`：`npm run test:unit && node tests/panel.mjs`。
   - 无法判断改动面时：`npm run test:unit && npm run test:integration`。
3. `lib/` 内不再有 `browser.js`（无 re-export 转发层），所有 import 直接指向新文件。
4. 三级测试全绿（说明见 README「开发」节）：单元 `npm run test:unit`（不启动浏览器）→ 集成
   `npm run test:integration`（真起无头 Edge，脚本串行）→ 手工 GUI 验证（`browser_e2e_*` 工具
   与右侧面板）。进程计数类断言以回落到运行前基线为准，不看绝对值。
