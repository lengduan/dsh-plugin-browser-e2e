# 架构不变量与会话状态机

状态: 已实现
关联: ../功能规格/0001-client-entry-activation-failure.md（客户端注册面）；0002-panel-protocol-v1.md（面板协议契约）
代码: lib/invariants.js / lib/session.js / lib/page.js / lib/snapshot.js / lib/observation.js / lib/read.js / lib/recipe.js / lib/capture.js / lib/download.js / lib/fetch.js / lib/raw.js / lib/errors.js / lib/hash.js / lib/viewport.js / lib/auth.js / lib/auth-state.js / lib/carrier.js / lib/doctor.js / lib/human.js / lib/history.js / lib/gate.js / lib/frame.js / lib/tools.js / lib/protocol.js / lib/defaults.js / lib/panel.js / lib/index.js / lib/screencast.js / lib/fence.js / client/index.js / lib/client.js（构建产物） / tests/invariants.mjs

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
实现层   session.js  page.js  snapshot.js  observation.js  read.js  recipe.js  capture.js  download.js
         fetch.js  raw.js  auth.js  auth-state.js  carrier.js  doctor.js  human.js  history.js
         gate.js  frame.js  screencast.js
公共     invariants.js（不变量断言）       fence.js（安全围栏）      defaults.js（全局默认值）
         errors.js（超时判定）  hash.js（SHA-256）  viewport.js（视口基准尺寸）
```

| 文件 | 职责 | 明确不含 |
|---|---|---|
| `lib/protocol.js` | 面板协议 v1 的单一契约来源：路由路径、版本、关闭码、命令表、事件表、投屏设置区间与默认值、`panelTabId` 组合规则 | 运行时状态、连接对象 |
| `lib/invariants.js` | 跨调用不变量断言函数；每个函数配「违反后果」注释；全部纯函数 | 入参校验、I/O、读全局 Map |
| `lib/fence.js` | loopback 围栏（既有） | 不变 |
| `lib/defaults.js` | 插件全局默认值：`DEFAULT_CDP_ENDPOINT`；`session.js` 的启动缺省端点、`doctor.js` 的端点缺省与修法文案、`index.js` 的 Config 默认值、`tools.js` 的工具描述与 `scripts/protocol-inject.mjs` 的客户端注入共用这一份 | 运行时状态 |
| `lib/carrier.js` | 载体枚举与探测：`CARRIERS` / `DEFAULT_CARRIER` / `CARRIER_LABELS`、`carrierLabel`、`detectCarrier`（edge 不探测、chrome 按环境变量→PATH→平台惯例位置、auto 回退 edge）、`searchSummary`；只查文件，不启动浏览器 | 会话状态、进程回收、面板、协议 |
| `lib/profile-copy.js` | CDP 复制接管的 profile 复制：`defaultEdgeUserDataDir`（平台惯例位置）、`resolveProfileSource`（源目录校验）、`copyUserProfile`（登录态 + 扩展白名单复制，失败删除半份副本）、`removeUserProfileDir`、`defaultProfileCopyDir`；不做浏览器启动与 CDP 连接 | 会话状态机、CDP 连接、进程回收、协议、面板 |
| `lib/auth-state.js` | 登录态导入 / 导出的校验与文件 I/O：storageState 读取（绝对路径、16 MiB 上限、形状校验、域名后缀过滤与域名收集）、导出路径解析（只允许 `~/.dsh/browser-e2e/auth/` 下的 `.json`）、原子写盘（临时文件 + rename，0600）；返回值与错误文案不含 cookie 名 / 值 | 会话状态机、页面能力、协议、面板 |
| `lib/errors.js` | Playwright 异常判定：`isTimeoutError`（错误名 `TimeoutError`，或文案匹配 `timeout ... exceeded`）；`fetch.js` / `raw.js` / `download.js` 的请求与导航超时共用这一份 | 运行时状态、I/O、各能力模块的报错文案与重试策略 |
| `lib/hash.js` | 摘要：`sha256Of(buffer)` 返回十六进制 SHA-256；`observation.js` 的网络正文、`raw.js` 的 HTTP 正文、`download.js` 的整包读入共用。流式摘要（`streamToFd` 逐块 `update`）是不同环节，不在本模块 | 运行时状态、I/O、流式 hash |
| `lib/viewport.js` | 视口基准尺寸：`viewportBounds(page, viewport)`——有固定视口用视口，否则取页面实际内尺寸（`innerWidth` / `innerHeight` 兜底），页内取值异常返回 `null`；`page.js` 的坐标校验与 `capture.js` 的 clip 边界、截图基准尺寸共用 | 标签页生命周期、坐标与截图尺寸的校验规则、截图参数 |
| `lib/session.js` | 会话注册表（`Map`）、显式状态机、`launch/close/closeTab/closeBySessionId/closeAll`、空闲与关闭兜底计时、面板事件总线、`tabs/listPanelTabs/panelPage`、`activeSessionKeys`（只读会话 key 列表，`doctor.js` 用来给当前会话做只读视图）、`peekSession`（只读会话视图，不创建会话、不刷新空闲计时）；导出 `normalizeCdpEndpoint` 与 `IDLE_CLOSE_MS` / `CLOSE_TIMEOUT_MS` 供诊断复用 | 页面能力、截图落盘、鉴权补票 |
| `lib/page.js` | 标签页条目与生命周期（`addPage/removePage/currentTab/createPage`、`attachPageHooks`）、事件环的写入（console / network 环形缓冲、`networkContext`、ref 表）、快照基线的持有与失效（`snapshotBaselines`：delta 的 key / 摘要 / ref / epoch，`invalidateBaselines` 在导航与 frame 换文档时调用）、`navigate`、`followTab`（默认标签页绑定与用户当前页判定）、`/click/fill/hover/drag/upload/clipboard/scroll/press/waitFor/assertPage/evaluate`、对话框策略与记录的写入（`dialogPolicy` / `dialogPromptText` / `dialogRing` 字段与 `page.on('dialog')` 应答）、`titleOf`、展示格式化（`nowAt` / `pushRing` / `truncateText` / `timeOf` / `oneLine`）；console 级别的归一与排序位次（`CONSOLE_LEVELS` / `CONSOLE_LEVEL_ALIASES` / `normalizeConsoleLevel` / `consoleLevelRank`）为事件环的共用口径，留在本文件导出、由 `observation.js` 单向借用 | 落盘、协议、面板连接、结构化读取（`lib/read.js`）、快照引擎（`lib/snapshot.js`）、事件环的只读视图与网络正文（`lib/observation.js`）、视口度量（`lib/viewport.js`） |
| `lib/snapshot.js` | DOM 快照引擎与快照能力：页内扫描脚本（`snapshotScript`）、ref 分配、delta / query / frame 分支（`runFullSnapshot` / `runDeltaSnapshot` / `runQuery` / `resolveSnapshotFrame` / `assertSameOriginFrame`）、快照基线的比较与文本整形（字段摘要、节点行格式化、文本截断）、`SNAPSHOT_*` 常量 | 标签页生命周期、事件环写入、交互动作、网络正文、协议、面板 |
| `lib/observation.js` | 事件环的只读视图与网络正文：console / network 读取（`consoleEntries` / `networkEntries`）、level 过滤视图、对话框策略与记录读取（`setDialogPolicy` / `dialogEntries`）、网络详情与正文解码（`networkDetail` / `bodyViewOf` / `decodeText`）、敏感头脱敏（`SENSITIVE_HEADERS` / `REDACTED_HEADER_VALUE`）、`NETWORK_BODY_*` 常量 | 标签页生命周期、事件环写入、快照、交互动作、协议、面板、落盘 |
| `lib/read.js` | 结构化页面读取：页内扫描 controls / links / tables / forms，唯一 CSS selector 生成与校验，记录整形与文本预算（`readStructured`） | 生命周期、事件环、ref 表、交互动作、截图、面板 |
| `lib/recipe.js` | 多步声明式步骤编排：一级参数校验、按序执行与总预算、逐步汇总与输出截断（`normalizeRecipe` / `runRecipe` / `renderRecipeReport`）；页面交互一律复用 `page.js` 的既有能力函数，只 `extract` 一种只读页内取值为自带固定脚本 | 生命周期、页面能力实现、事件环、协议、面板 |
| `lib/capture.js` | 截图参数与尺寸校验、clip / 倍率、产物目录（`artifactsRoot` 单一定义，`ensureArtifactsDir` 由它派生）、单次 JPEG 帧（`captureJpeg(page, options)`）、JPEG quality 区间常量（`MIN_SHOT_QUALITY` / `MAX_SHOT_QUALITY`）；视口基准尺寸复用 `lib/viewport.js` 的 `viewportBounds` | 面板连接、会话注册表、视口度量的实现 |
| `lib/download.js` | 下载落盘与完整性校验：URL 直接取回 / 点击触发 download 事件、下载目录与文件名、大小上限、SHA-256 | 会话生命周期、面板连接、页面交互实现 |
| `lib/fetch.js` | 临时页抓取与正文提取：临时页开 / 关（经 `createTransientPage`）、导航与稳定等待、标题与正文提取、字符预算与截断（`fetchText`） | 会话生命周期、标签页登记、ref 表、事件环、截图、面板 |
| `lib/raw.js` | 原始 HTTP 逃生口（仅 `mode=context`）：用当前标签页所属浏览器上下文的请求客户端发任意方法 / 头 / 正文，文本与二进制正文分支、重定向与字符截断（rawHttp）；敏感响应头脱敏不在此定义，`redactHeaders` 复用 `observation.js` 的 `SENSITIVE_HEADERS` / `REDACTED_HEADER_VALUE`（`page.js` 的 `networkDetail` 用同一份）；原始 CDP 与服务端直连模式未实现（见 `0003-决策记录.md` #9） | 会话生命周期、标签页登记、事件环、ref 表、快照、投屏、面板、落盘 |
| `lib/doctor.js` | 环境诊断（只读）：运行时与依赖版本、系统 Edge 候选路径、CDP 端点可达性与 `/json/version` 识别、当前会话只读视图、产物 / 下载目录可写性、环境变量合法性；报告为固定六项文本，不启动浏览器、不改会话与进程 | 生命周期、页面能力、截图落盘、面板协议 |
| `lib/auth.js` | 登录挑战识别与 loopback 补票（可整体删除而不影响其它能力） | 会话状态 |
| `lib/history.js` | 动作历史的落盘与脱敏：路径解析、脱敏纯函数、JSONL 追加与有界裁剪、读回；导出 `DEFAULT_HISTORY_LIMIT` / `MAX_HISTORY_LIMIT` / `HISTORY_MAX_ENTRIES` / `HISTORY_PRUNE_SLACK` / `HISTORY_SUMMARY_LIMIT` / `SENSITIVE_ARGS` / `actionHistoryPath` / `historyEnabled` / `redactActionSummary` / `appendAction` / `listActions` | 面板广播、协议、会话状态、页面能力、工具定义 |
| `lib/human.js` | 人机协同等待：页内人机验证探测、轮询判定与完成信号（`humanCheck` / `waitForHuman`） | 会话生命周期、面板、工具定义 |
| `lib/gate.js` | 工具级权限门控的纯函数层：配置归一（缺失取默认、非法 fail-closed）、工具定性读取（缺失按 `interact`）、`wait + expression` 的按参数升级、判定与拒绝文案；不做 I/O、不碰会话状态 | 会话状态、页面能力、面板、协议 |
| `lib/frame.js` | 页面 frame 定位：主文档索引 0、其余按 `page.frames()` 顺序过滤主文档编号、字符串按 name / url 匹配、可用索引文案；快照与 `click` / `fill` / `scroll` 共用同一份实现，不做同源检查（由调用方决定） | 会话状态、页面能力、面板、协议 |
| `lib/screencast.js` | CDP 投屏适配器（帧源之一） | 面板状态 |
| `lib/tools.js` | 30 个 `browser_e2e_*` 工具的表（name / description / parameters / run / output） | 生命周期、面板挂载 |
| `lib/panel.js` | 面板状态、命令分发、投屏目标同步、设置合并 | 工具定义 |
| `lib/index.js` | 插件 Config、`apply` 注册与生命周期（工具注册、session/disposed、卸载、面板路由挂载） | 工具实现细节 |
| `client/index.js` | 客户端 bundle（单文件，不拆）；协议常量、命令 / 事件表与默认 CDP 端点由 `scripts/build-client.mjs`（经 `scripts/protocol-inject.mjs`）从 `lib/protocol.js` / `lib/defaults.js` 注入 | — |
| `lib/client.js` | `client/index.js` 的构建产物（头注释 + 协议常量注入块 + 源码），包内实际被宿主加载的客户端 bundle；由 `scripts/build-client.mjs` 生成，手改会被下一次构建覆盖 | 手写逻辑（客户端逻辑只改 `client/index.js`） |

依赖方向（实现层单向，禁止回指）：

```
tools.js → session.js / page.js / snapshot.js / observation.js / recipe.js / read.js / capture.js / download.js / fetch.js / raw.js / human.js / history.js / defaults.js / doctor.js / carrier.js
index.js → tools.js / panel.js / session.js / auth.js / history.js / gate.js / defaults.js / protocol.js / carrier.js
panel.js → protocol.js / session.js / screencast.js / capture.js / fence.js
session.js → page.js / capture.js / invariants.js / protocol.js / fence.js / defaults.js / carrier.js / auth-state.js
page.js → auth.js / invariants.js / viewport.js / frame.js
snapshot.js → page.js（只借 currentTab / withTimeout；当前未使用 invariants.js）/ frame.js
observation.js → page.js（只借 currentTab、级别归一、展示格式化与环常量）/ hash.js
read.js → page.js
recipe.js → page.js
download.js → page.js / capture.js / errors.js / hash.js
fetch.js → page.js / read.js / errors.js
raw.js → page.js / observation.js / errors.js / hash.js
human.js → page.js
auth.js → fence.js
screencast.js → protocol.js
capture.js → protocol.js / viewport.js
history.js → page.js（只借 timeOf / oneLine 两个展示纯函数；不回调会话层，不 import 页面能力）
doctor.js → session.js / capture.js / defaults.js
invariants.js → carrier.js（只借 `carrierLabel` 拼错误文案；断言本身仍不读全局 Map、不做 I/O）
protocol.js / fence.js / defaults.js / errors.js / hash.js / viewport.js / gate.js / frame.js / carrier.js / auth-state.js → （无内部依赖）
```

`tools.js` 直接 import 13 个能力模块（session / page / recipe / read / capture / download / fetch / raw / human / history / defaults / doctor / carrier），另加拆分出来的 snapshot / observation 两个能力模块（共 15 个），新增能力时同步本图。

`snapshot.js` 与 `observation.js` 都不 import 对方，也不被 `page.js` import：页面层不感知这两个能力模块，
避免造 `page → snapshot` / `page → observation` 回指。

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
| `activeTabId` | `page.js` 的 `addPage` / `removePage` / `currentTab` / `navigate` / `followTab` 读写；`session.js` 的 `tabs` / `listPanelTabs` 读 | 当前标签页 |
| `nextTabSeq` | `page.js` 的 `addPage` 读并自增；`session.js` 的 `sessionOf` 初始化 | 分配 `t<N>` |
| `hookedPages` | `page.js` 的 `attachPageHooks` 读 / 写 | 防止同一个 page 重复挂监听 |
| `mode` | `page.js` 的 `createPage` / `clipboard` 读；`fetch.js` 的 `fetchText` 读 | 选择 `newPage` 路径、CDP 模式下限制未过滤的剪贴板写入、临时页判定来源 |
| `carrier` | `session.js` 的 `sessionOf`（初始 `edge`）/ `launch`（隔离写实际载体、CDP 写 `edge`）/ `reuseInfo` / `assertReuseCompatible` 读写；`invariants.js` 的 `assertCarrierNotHotSwitched` 由调用方传值 | 复用摘要的载体名与「已启动后换载体」的热切换判据 |
| `context` | `page.js` 的 `createPage` 读 | 新建页面（方案 A 后 isolated 与 CDP 都有显式 context，全部标签页共享 cookie / localStorage） |
| `storageState` | `session.js` 的 `launch`（isolated 写导入来源与域名过滤，未导入为 null）/ `assertReuseCompatible` 读 | 已启动后是否允许复用同一份登录态；值为 `{ path, domains }`，不复制 cookie |
| `browser` | `page.js` 的 `createPage` 读 | 隔离模式新建页面与前置检查 |
| `viewport` | `page.js` 的 `createPage` 读 | 隔离模式新页视口 |
| `headless` | `session.js` 的 `sessionOf`（初始 null）与 `launch`（isolated 写本次启动值、cdp 写 false）写；`human.js` 的 `waitForHuman` 读 | 人工等待结果的可见性提示 |
| `state` | 写：`session.js`（`nextSessionState` 的调用点）；读：`invariants.js` 的 `assertNotClosedDuringLaunch`、`human.js` 的 `waitForHuman` | `closing` / `closed` 期间拦截启动与人工等待，并发关闭后立即报错而不是轮询到超时 |
| `touch` | `page.js` 的 `scroll`、`observation.js` 的 `consoleEntries` / `networkEntries` / `dialogEntries` / `networkDetail`、`download.js` 的 `download`、`recipe.js` 的 `runRecipe` 调用；定义在 `session.js` 的 `sessionOf`（挂 `touchSession`） | 刷新空闲计时 |

#### 标签页条目（`page.js` 的 `addPage` 创建）

| 字段 | 读写方（符号） |
|---|---|
| `id` / `page` / `loading` / `origin` | `session.js` 的 `tabs` / `listPanelTabs` 读；`capture.js` 的 `screenshot` 读 `tab.page` |
| `refs` / `consoleRing` / `networkRing` / `networkByRequest` / `networkContext` / `nextNetworkSeq` / `snapshotBaselines` / `dialogRing` / `dialogPolicy` / `dialogPromptText` / `heldKeys` | 字段的创建与写入方是 `page.js`（`addPage` / `attachPageHooks` / `clearRings` / `invalidateBaselines` / 对话框应答）；`snapshot.js` 读写 `refs` 与 `snapshotBaselines`（`runFullSnapshot` / `runDeltaSnapshot` / `runQuery`），`observation.js` 只读 `consoleRing` / `networkRing` / `networkContext` / `networkByRequest` 与 `dialogRing` / `dialogPolicy` / `dialogPromptText`（`consoleEntries` / `networkEntries` / `networkDetail` / `dialogEntries`），`setDialogPolicy` 写对话框策略两项；两个新模块都只读写既有字段、不新增跨模块字段。`heldKeys` 是跨调用按住的按键名集合，`navigate` 在 `goto` 前释放并清空 |

`snapshot.js` / `observation.js` 与 `page.js` 之间只通过上面这张表的既有字段协作：
`page.js` 的 `addPage` / `attachPageHooks` 持有并写入事件环与快照基线，两个新模块不得新增字段，
也不反向被 `page.js` import。`SENSITIVE_HEADERS` / `REDACTED_HEADER_VALUE` / `isTextMime` /
`decodeText` / `NETWORK_BODY_*` 的归属是 `observation.js`（`raw.js` 与 `networkDetail` 共用这一份）。

`heldKeys` 只由 `press`（`action=down/up`）与 `navigate` 读写，按标签页隔离；页面对象关闭即消失，不参与会话状态机，也不作为不变量判据。

#### 其他跨模块字段

- `capture.js` 的 `ensureArtifactsDir` 写 `session.artifactsDir`。
- `panel.js` 的 `ensureScreencast` 读 `screencast.tabId` / `screencast.page`，据此判断「同一个 tab
  但页面对象已经换了」；`Screencast` 的 `cdp` 字段只在 `screencast.js` 内部读写。
- 能力函数返回值被 `tools.js` 各工具 `run` 读的字段（按工具名）：
  - `browser_e2e_start`：`reused` / `summary` / `url` / `mode` / `endpoint` / `artifactsDir`（`storageState` 计数只在 `run` 之外被测试读取，`run` 只读 `summary`）；
  - `browser_e2e_auth_export`：`run` 只读 `summary`，返回格式化字符串；`file` / `bytes` / `cookies` / `origins` / `domains` / `overwrite` 由能力函数返回但 `run` 不读，不会到达模型；
  - `browser_e2e_navigate`：`summary` / `title` / `tabId`；
  - `browser_e2e_tabs`：`action=list` 读 `summary` / `mode` / `text`；`action=close` 读 `summary` / `activeTabId`；
    `action=follow` 读 `summary` / `source` / `previousTabId` / `candidates` / `tabs` / `failedProbeCount` / `activated` / `tabId`，返回格式化字符串，`changed` / `ambiguous` / `url` / `title` 由能力函数返回但 `run` 不读；
  - `browser_e2e_snapshot`：`summary` / `url` / `tabId` / `text` / `mode` / `frame` / `baseline` / `added` / `changed` / `removed` / `matches` / `truncated` / `scanTruncated`（`mode` / `frame` / `scanTruncated` 各模式都返回；`baseline` / `added` / `changed` / `removed` 只在 delta，`matches` 只在 query）；
  - `browser_e2e_read`：`summary` / `url` / `tabId` / `text` / `mode` / `sections` / `truncated` / `scanTruncated`；
  - `browser_e2e_screenshot`：`file` / `data` / `meta`（`summary`、`mediaType`、`name`、`bytes` 等）；
  - `browser_e2e_console`：`summary` / `total` / `matched` / `count` / `level` / `text`；
  - `browser_e2e_network`：列表模式（不传 `request_id`）读 `summary` / `count` / `total` / `text`；
    详情模式（传 `request_id`）读 `summary` / `text`；
  - `browser_e2e_wait`：`summary` / `mode` / `timeoutMs` / `elapsedMs`；
    selector 条件另读 `state`；url 条件另读 `urlMatch` / `matchedUrl` / `matchedCurrent`；
    response 条件另读 `urlMatch` / `responseMethod` / `statusMin` / `statusMax` / `includeBuffered` /
    `matchedResponse`（`url` / `method` / `status` / `mimeType` / `at` / `buffered`）；
  - `browser_e2e_evaluate`：`summary` / `value`；
  - `browser_e2e_click` / `fill` / `hover` / `drag` / `scroll` / `press` / `close`：只读 `summary`；
  - `browser_e2e_upload`：`summary` / `multiple` / `accept` / `totalBytes` / `visible` / `replaced` / `selected`；
  - `browser_e2e_download`：`summary` / `file` / `filename` / `bytes` / `sha256` / `source` / `url` / `suggestedFilename` / `finalUrl`；
  - `browser_e2e_fetch`：`run` 读 `summary` / `title` / `tabId` / `mode` / `empty` / `text`，返回格式化字符串；`url` / `statusCode` / `truncated` / `elapsedMs` 由能力函数返回但 `run` 不读，不会到达模型；
  - `browser_e2e_http`：`run` 只读 `summary` 与 `body` 的 `kind` / `bytes` / `chars` / `text` / `sha256`，返回 `summary + 换行 + 正文` 的格式化字符串；`mode` / `url` / `finalUrl` / `status` / `ok` / `headers` / `redirect` / `elapsedMs` 由能力函数返回但 `run` 不读，不会到达模型；
  - `browser_e2e_assert`：`pass` / `total` / `passed` / `failed` / `checks` / `tabId` / `url` / `elapsedMs` / `summary`；
    `checks` 每项为 `{ index, kind, expected, pass, actual }`，`selector` 条目另带 `state`，`url` 条目另带 `urlMatch`。
  - `browser_e2e_clipboard`：`summary` / `action` / `target` / `rich` / `sanitized` / `accepted` / `inserted` / `plainChars` / `htmlChars` / `plainDerived`。
  - `browser_e2e_dialog`：`run` 只读 `summary` 与 `text`（设置策略时另读 `setDialogPolicy` 返回的 `summary`），返回格式化字符串；`policy` / `promptText` / `total` / `count` / `entries` 由能力函数返回但 `run` 不读，不会到达模型。
  - `browser_e2e_captcha_check`：`summary` / `detected` / `kind` / `evidence` / `url` / `tabId`；
  - `browser_e2e_wait_for_human`：`summary` / `needed` / `resolved` / `waitedMs` / `polls` / `probeErrors` / `detected` / `kind` / `url` / `reason` / `selector` / `headless` / `timeoutMs` / `pollMs` / `tabId` / `hint` / `lastProbeError`（后两项仅对应情形出现）。

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
- **运行时**：既不是不变量也不是入参校验，是操作结果（如等待超时、页面脚本执行超时），留在能力函数里。
  页面脚本超时的中断走 `lib/page.js` 的 `interruptPageScript`（`page.context().newCDPSession(page)` 的
  `Runtime.terminateExecution`）；中断失败同样只是操作结果，不代表会话或页面状态损坏，因此不进
  `lib/invariants.js`。

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
| `assertCarrierNotHotSwitched(currentCarrier, requestedCarrier)` | 请求载体（`auto` 已解析成具体值）与已运行隔离会话一致；载体名经 `carrierLabel` 展示 | 浏览器已启动（载体 {当前}）；如需切换为 {请求} 请先 browser_e2e_close |
| `assertCdpConnected(session, isConnected)` | 会话仍持有 CDP context，且 `isConnected`（调用方传入的 `browser.isConnected()` 结果）不为 `false`；未探测（undefined）时只按 context | CDP 浏览器连接已失效，请重新 browser_e2e_start |
| `assertCdpContext(context)` | 接管前置：至少一个 context | CDP 浏览器没有可用的 context |
| `assertCdpHasPages(pages)` | 接管前置：至少一个已打开标签页 | CDP 浏览器没有已打开的标签页，无法接管 |
| `assertSessionContext(session)` | isolated 且 `state=ready` 的会话持有显式 context（方案 A 的每会话一个 context） | 隔离模式浏览器上下文缺失，请重新 browser_e2e_close 再 browser_e2e_start |
| `assertRefBelongsToTab(refs, ref)` | ref 在该 tab 的 ref 表（首参是该标签页条目的 `refs` Map，不是标签页条目） | ref {ref} 不存在，请先 browser_e2e_snapshot 获取最新 ref |
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
- `lib/index.js` 的 `Config` 四个投屏字段只负责设置页展示：描述里的区间与默认值从
  `PANEL_CONFIG_LIMITS` / `DEFAULT_SCREENCAST_CONFIG` 插值生成，不再手写数字（依赖图因此有
  `index.js → protocol.js`）；字段名与「不设 schema 默认值、由 `panel.js` 回退」的行为不变。
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
  本次目标 mode 拆掉已建立的浏览器（isolated 走 `closeBrowser`，超时只如实记录、不强杀进程，
  见下文「关闭兜底」；cdp 只断连），再把 `closing` 收成 `closed`，不留半初始化会话与孤儿进程。
  注意这不是给转移表加边：`closing --launchSettled-->`
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

关闭兜底：`DSH_BROWSER_CLOSE_TIMEOUT_MS`（默认 5000）到点后放弃等待，保证关闭路径一定有返回；
但 Playwright 的 `Browser` 没有结束进程的接口（`process()` 只存在于 `BrowserServer` / `ElectronApplication`），
所以超时后**无法强制结束进程**，`close` 返回 `timedOut: true`，摘要明确写「进程可能仍在运行，请手动结束」，
不谎称已关闭。CDP 模式只断连，绝不结束用户浏览器进程。

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
- `history.js` 的落盘是独立子目录 `~/.dsh/browser-e2e/history/`（与 `artifacts/` 同根、不混用），
  脱敏只在写入前执行一次、只覆盖 `SENSITIVE_ARGS` 表里的字段；`action` 事件载荷、面板显示与
  工具返回值一律不变。删除该模块是**能力删除**：需同时删 `tools.js` 的 `browser_e2e_history`
  定义与 `index.js` 的两处写入接线。
- `invariants.js` 删除后约束会散回各能力函数（删除测试的反向判据）。

## 已知结构性债务

以下是独立复核确认、但本轮**未处置**的结构性项；处置时须先改本规格再动代码。

| 项 | 现状 | 未处置理由 |
|---|---|---|
| `page.js` 粒度过大 | 一期已处置（M2）：`snapshot.js` / `observation.js` 已拆出。M2 施工前后实测（HEAD `41957e9` → M2 完成时）：`page.js` 4158 行 / 87 导出 → 2787 行 / 73 导出；`snapshot.js` 880 行 / 4 导出、`observation.js` 515 行 / 13 导出。**2026-11-08 在 HEAD `6057bd6` 复测（行数按 `(Get-Content).Count`、导出按 `^export` 计数）：`page.js` 2867 行 / 73 导出、`snapshot.js` 823 行 / 4 导出、`observation.js` 509 行 / 13 导出**。迁出的是快照引擎（含 delta / query / frame 与基线比较）与观察 / 网络正文（含 `SENSITIVE_HEADERS` / `decodeText`，B-A3 / B-A4 的归属随之落定）；`page.js` 保留标签页注册表与生命周期、`attachPageHooks` 的事件环写入、`snapshotBaselines` 失效、`navigate` / `followTab`、交互动作、等待、断言、剪贴板、`evaluate`、展示格式化。 | 二期待办：`interaction` / `wait` / `assert` / `clipboard` / `evaluate` 仍在 `page.js`（约 1900 行、5 类变化原因），拆它们要再改一次模块表与依赖图，按 0003 的决策节奏另立批次；本表一期的拆法不覆盖这几块。 |
| 视口度量三份 | **已处置（M3）**：收敛到 `lib/viewport.js` 的单一 `viewportBounds`。实测（HEAD `ef93636` 工作区，M3 施工后）：定义 1 处（`lib/viewport.js`）；消费方 `lib/page.js` 1 处调用（`assertPointInViewport`）、`lib/capture.js` 2 处调用（clip 边界校验与 `shotBaseSize`）。`shotBaseSize` 的第三份内联改为调用同一函数，正常路径与原实现逐字等价；唯一差异是页内取值异常时该函数返回 `null`（原内联写法透传页面错误），只发生在页面已关闭 / 崩溃、截图本来也无法完成的路径。 | 已处置；保留行以便追溯。 |
| `session.js` 粒度过大 | 2026-11-08 实测 844 行、21 个导出（原记「约 680 行、16 个导出」为更早基线），混装四类变化原因：会话注册表与状态机、`launch`/`close` 与进程回收、面板事件总线、面板读模型（`panelPage`/`listPanelTabs`）与工具能力（`tabs`）。与 `page.js` 同性质。 | 面板读模型（`panelPage`/`listPanelTabs`）与事件总线是「面板视图」关注点，与浏览器生命周期无关，建议拆 `lib/view.js`；但 `sessions` Map 是私有状态，拆分需同时决定注册表暴露面，属本规格模块表变更，须先改规格。**处置前不得再往 `session.js` 加职责。** |
| 串行队列两份 | `lib/panel.js` 与 `lib/screencast.js` 各有一份 enqueue/queue 实现（除队列字段名外逻辑相同）。 | 两者分属不同模块的私有同步原语，抽出公共模块会增加一条依赖边并改本规格依赖图，留待拆分 `session.js` / `page.js` 时一并评估。 |
| 会话解析入口不统一 | 10 个工具用 `sessionOf`（会创建会话对象：navigate/snapshot/tabs 的 follow/click/fill/scroll/press/screenshot/wait/evaluate），`console`/`network` 用 `requireSession`，`tabs` 的 list / close 分别经 `listSessionTabs`/`closeTab` 内部读注册表（不创建）。未启动时前一类会留下 idle 会话条目，且报错文案不同（「浏览器尚未启动或没有可用标签页」vs「浏览器尚未启动，请先调用…」）。 | 行为差异只影响未启动时的会话表残留与文案，不影响已有会话；统一入口需要逐工具核对语义，留待后续。 |
| 展示格式化四处 | `page.js` 的 `timeOf`/`oneLine`、`session.js` 的 `tabs` 文本拼装、`tools.js` 的标题拼串、`client/index.js` 的 `formatClock`；其中 `timeOf` 取 ISO 的 UTC 段、`formatClock` 用本地时区，同一瞬间显示不同。 | 上移格式化会改动 `tools.js` 全部 `run` 的返回契约，属较大重构，留待单独一轮。 |
| client 文案 / 样式孤儿键 | `client/index.js` 现有 17 个无引用 EN 文案键（`EN` 共 45 键）与 9 个无引用 `st` 样式键（`st` 共 44 键，含 `st.url`）；2026-11-07 解析两个对象并统计引用实测。 | 属整洁度，不影响行为；清理需与 `tests/client-bundle.mjs` 的文案断言一起核对，留待单独一轮。 |
| 工具描述里的 limit / timeoutMs 默认值 | 已处置（M1）：`wait` 的默认超时（`DEFAULT_WAIT_TIMEOUT_MS`）与 status 区间（`WAIT_STATUS_MIN` / `WAIT_STATUS_MAX`）、`console` / `network` 的默认 limit（`DEFAULT_RING_QUERY_LIMIT`）、`download` 的默认总预算（`DEFAULT_DOWNLOAD_TIMEOUT_MS`）、`assert` 条数（`ASSERT_MAX_CHECKS`）、`recipe` 的逐键延迟 / hover 等待（`KEYSTROKE_MAX_DELAY_MS` / `MAX_SETTLE_MS` / `DEFAULT_SETTLE_MS`）、`upload` 的 MiB 上限（`sizeText` 从字节常量派生）都改由能力模块导出的常量插值；`evaluate` 仍为 `DEFAULT_EVALUATE_TIMEOUT_MS` / `MIN_EVALUATE_TIMEOUT_MS` / `MAX_EVALUATE_TIMEOUT_MS`。 | 已处置；保留行以便追溯。 |
| 进程回收环境变量的校验规则与默认值两套 | `session.js` 用 `Number(process.env.… ?? 默认值)` 直取（不校验，`DSH_BROWSER_CLOSE_TIMEOUT_MS=0` 直接生效、负数 / NaN 也照用）；`doctor.js` 另有一套校验（`integerTextOf` 后 `IDLE_CLOSE_MS` 要求非负整数、`CLOSE_TIMEOUT_MS` 要求正整数），修复文案仍写死「默认 600000 / 5000」。同一输入两者结论相反：`DSH_BROWSER_CLOSE_TIMEOUT_MS=0` 时 `session.js` 用 0（`setTimeout(…, 0)` 与 `browser.close()` 竞争），`doctor.js` 报 WARN「不是正整数」。 | 需要先定规格：0 / 负数是否合法、校验归 `session.js` 还是 `doctor.js`；收紧运行时校验会碰回收口径，留待单独一轮。 |
| `recipe.js` 的 `STEP_FIELDS` 与 `tools.js` 的步骤 schema 两份手工同步 | `recipe.js` 的 `STEP_FIELDS` 是按步骤类型的运行期白名单（`normalizeStep` 用它拒绝未声明字段）；`tools.js` 的 `steps.items` 是扁平 `properties` + `additionalProperties: false`，不按步骤类型分组。两侧字段集合当前一致，靠注释互相提醒。 | 收敛成单一来源要改 `tools.js` 的 schema 生成方式（`oneOf` + `additionalProperties: false`），会改模型看到的参数形状，风险大于收益，留待单独一轮。 |
| 页内脚本三套注入口径 | 函数序列化 + 参数（`read.js` / `snapshot.js` / clipboard）、字符串 IIFE（`human.js` 的 `humanProbeScript`）、字符串拼接表达式（`page.js` 的 `assertExpressionCheck`）；字符串脚本无法在模块解析期做语法检查。 | 属代码风格；页内脚本不能直接 import 普通函数，统一口径要逐个改页内脚本并跑真起 Edge 的回归，收益不抵风险。 |
| 临时页机制在 `page.js`，业务消费者只有 `fetch.js` | `page.js` 持 `transientPages` / `pendingTransient` 与 `createTransientPage` / `isTransientPage` / `hasPendingTransientPage`；`fetch.js` 是唯一业务消费者，`session.js` 的 CDP `context.on('page')` 又依赖两个判定。 | 移动会造 `fetch → session` 或反向依赖（依赖图里没有 `session.js → fetch.js`）；`page.js` 不 import 会话层，故机制留在页面生命周期模块。 |
| `visibleEnough` 三处页内脚本内联副本 | `snapshot.js` 的 `snapshotScript`、`page.js` 的 `assertSelectorCheck`、`read.js` 的 `readScript` 各一份同判据实现（assert 版与 read 版除 `rect` 取值位置外逐字相同）。 | 共享需把函数序列化成源码字符串再注入三个页内脚本，收益不抵风险；改可见性口径必须三处同改。 |

## 验收

1. `npm run test:unit` 通过（脚本内容见 `package.json`：`node tests/invariants.mjs &&
   node tests/client-bundle.mjs && node tests/screencast.mjs`）：覆盖全部不变量断言、状态机全部
   合法/非法转移、`panelTabId` 组合与拆分、协议常量与 client 注入块一致性、投屏设置单一来源、
   投屏串行队列。
2. 按改动面跑可执行命令（每条都以 `npm run test:unit` 打底；含 `tests/` 的命令会真起无头 Edge）：
   - 改 `session.js`：`npm run test:unit && node tests/panel.mjs && node tests/multitab.mjs && node tests/reclaim.mjs`
     （`panel.js` 也覆盖 session 的面板面）。
   - 改 `capture.js`：`npm run test:unit && node tests/tools.mjs && node tests/panel.mjs`。
   - 改 `page.js` / `tools.js`：`npm run test:unit && node tests/tools.mjs && node tests/multitab.mjs && node tests/follow.mjs`。
   - 改 `snapshot.js`：`npm run test:unit && node tests/snapshot.mjs && node tests/tools.mjs && node tests/read.mjs`。
   - 改 `observation.js`：`npm run test:unit && node tests/tools.mjs && node tests/dialog.mjs && node tests/fetch.mjs && node tests/raw-http.mjs`。
   - 改 `read.js`：`npm run test:unit && node tests/tools.mjs && node tests/panel.mjs`。
   - 改 `errors.js` / `hash.js` / `viewport.js`：`npm run test:unit && node tests/tools.mjs && node tests/panel.mjs`。
   - 改 `history.js`：`node tests/invariants.mjs`（用例 M：纯函数 + 临时目录，不起浏览器）
     与 `node tests/panel.mjs`（真起无头 Edge，串行）。
   - 改 `fetch.js`：`npm run test:unit && node tests/fetch.mjs && node tests/tools.mjs && node tests/panel.mjs`。
   - 改 `protocol.js` / `panel.js` / `index.js`：`npm run test:unit && node tests/panel.mjs`。
   - 改 `doctor.js`：`npm run test:unit && node tests/doctor.mjs && node tests/panel.mjs`。
   - 改 `raw.js`：`npm run test:unit && node tests/raw-http.mjs && node tests/tools.mjs && node tests/panel.mjs`。
   - 无法判断改动面时：`npm run test:unit && npm run test:integration`。
3. `lib/` 内不再有 `browser.js`（无 re-export 转发层），所有 import 直接指向新文件。
4. 三级测试全绿（说明见 README「开发」节）：单元 `npm run test:unit`（不启动浏览器）→ 集成
   `npm run test:integration`（真起无头 Edge，脚本串行）→ 手工 GUI 验证（`browser_e2e_*` 工具
   与右侧面板）。进程计数类断言以回落到运行前基线为准，不看绝对值。
