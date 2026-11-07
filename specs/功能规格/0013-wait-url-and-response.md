# 等待 URL 与网络响应

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/page.js` 职责；进程内对象契约「其他跨模块字段 · `browser_e2e_wait`」；P3「`lib/browser.js`」表内 wait 超时一条）；specs/功能规格/0005-console-network-ring.md（网络记录字段、`RING_LIMIT` 与「主框架新文档请求」重置判据）；README.md「事件环重置」
代码: lib/page.js / lib/tools.js / tests/wait.mjs

## 需求

「点完后跳到 X」「点完后发出 Y 请求」是端到端验证最常见的两条断言。`browser_e2e_wait` 目前只支持 `selector` 与 `expression`：要等地址或响应，只能写 `expression` 轮询 `location`，既多一次页面往返，又有竞态——响应可能在轮询开始前就已到达（竞品 `includeBuffered` 正是解这个）。本功能在同一个工具上增加 `url` 与 `response` 两类条件：等当前或未来地址命中，等匹配 URL / method / 状态区间的网络响应到达；超时与既有 wait 一样是运行时错误。

## 行为

### 输入

工具 `browser_e2e_wait` 由「`selector` / `expression` 二选一」扩展为四选一：

| 条件参数 | 类型 | 约束 |
|---|---|---|
| `selector` | string | CSS 选择器；与 `state` 配合；与其他三个条件互斥 |
| `expression` | string | 页面内 JS 表达式，返回真值即满足；与其他三个条件互斥 |
| `url` | string | 地址匹配模式；与其他三个条件互斥 |
| `response` | string | 响应的 URL 匹配模式；与其他三个条件互斥 |

四个条件必须且只能给一个（空字符串按未给处理）。给 0 个或同时给 ≥2 个直接报错，不启动等待。

其余参数：

| 参数 | 类型 | 缺省 | 适用条件 | 约束 |
|---|---|---|---|---|
| `state` | string | `visible` | `selector` | `attached` / `visible` / `hidden` / `detached` |
| `urlMatch` | string | `includes` | `url` / `response` | `includes` / `glob` / `regex` |
| `responseMethod` | string | 无（不限） | `response` | 非空；比较时两边转大写 |
| `statusMin` | integer | `100` | `response` | 100–599 整数；不得大于 `statusMax` |
| `statusMax` | integer | `599` | `response` | 100–599 整数；不得小于 `statusMin` |
| `includeBuffered` | boolean | `true` | `response` | 等待开始前已完成的响应是否参与匹配 |
| `failOnRequestFailed` | boolean | `true` | `response` | 匹配的请求失败时是否立即报错 |
| `timeoutMs` | integer | `10000` | 全部 | 正整数 |
| `tab_id` | string | active tab | 全部 | 目标标签页 id |

条件专属参数错配时直接报错，不静默忽略：`state` 用于非 `selector` 条件、`urlMatch` 用于非 `url` / `response` 条件、`responseMethod` / `statusMin` / `statusMax` / `includeBuffered` / `failOnRequestFailed` 用于非 `response` 条件。

URL 匹配方式（`urlMatch`，`url` 与 `response` 共用同一套语义，匹配对象都是完整 URL 字符串，区分大小写）：

- `includes`（缺省）：`url.includes(pattern)` 子串命中。
- `glob`：整串匹配，`*` 匹配任意个非 `/` 字符，`**` 匹配任意个字符（含 `/`），`?` 匹配单个非 `/` 字符；其余正则元字符按字面转义。
- `regex`：把 `pattern` 当 JavaScript 正则源（`new RegExp(pattern)`，子串语义，不自动加 `^` / `$`）；编译失败报错并指出可改用 `includes`。

### url 条件

- 匹配对象是主框架当前地址 `page.url()`（含 hash；`history.pushState` / `replaceState` 与 hash 变化都会更新该值，已核对 playwright-core 1.63.0 的 `frameCommittedSameDocumentNavigation` 实现）。
- 调用开始先同步比对一次当前地址：命中则立即返回，`matchedCurrent: true`、`elapsedMs` 约 0；未命中则以约 100ms 间隔轮询 `page.url()`，直到命中或超时，命中时 `matchedCurrent: false`。
- 只保证地址命中，不等待文档加载完成（`navigate` 的 `waitUntil` 负责文档生命周期，见边界）。
- 命中返回 `{ mode: 'url', tabId, pattern, urlMatch, matchedUrl, matchedCurrent, timeoutMs, elapsedMs, summary }`；`summary` 形如 `等待 URL 命中 <url>（includes，当前地址已满足 / 等待期间导航到达，耗时 12ms）`。
- 超时抛错：`等待 URL 匹配超时：实际等待 <n>ms（上限 <m>ms）；匹配方式 <mode>，目标 <pattern>；当前地址 <url>`。
- 等待期间页面关闭：抛「等待 URL 期间标签页已关闭（<tab_id>），请重新 browser_e2e_tabs 获取可用标签页」。

### response 条件

- 匹配对象是 Playwright 页面级 `response` 事件：`response.url()`、`response.request().method()`、`response.status()`、`response.headers()['content-type']`。URL 按 `urlMatch` 匹配；`responseMethod` 给定时方法须相等（两边转大写）；状态须落在 `[statusMin, statusMax]` 闭区间。
- `includeBuffered: true`（缺省）：等待开始时先按发生顺序扫描该标签页的 `tab.networkRing`，取 `status > 0`、URL 与 method 匹配、状态在区间内的第一条记录，立即返回并标 `buffered: true`。缓冲窗口是「当前文档」——与网络环的重置判据一致（`specs/功能规格/0005-console-network-ring.md`「重置」节）；环上限为 `RING_LIMIT`（500），更早的记录已被淘汰。CDP 接管模式下只覆盖 `attachPageHooks` 挂上之后的记录，接管前已完成的响应不在缓冲里。
- `includeBuffered: false`：只匹配等待开始后到达的响应。
- 等待未来响应时临时监听 `response` / `requestfailed` / `close`：命中 `response` 即返回 `buffered: false`；无论命中、超时、请求失败还是页面关闭，临时监听都必须移除。
- 请求失败：`failOnRequestFailed: true`（缺省）时，等待期间 URL 与 method 匹配的请求失败立即抛错，文案带 failure 原文与「如属预期（例如导航中止），传 failOnRequestFailed=false 继续等待其它响应」；为 `false` 时继续等待，失败请求只进超时诊断列表。已缓冲历史里已失败的请求不参与匹配，也不触发立即失败。
- 超时抛错，文案包含：实际等待与上限、条件描述（`urlMatch` / method / status 区间）、已缓冲响应条数、URL 与 method 命中但状态不符的最多 3 条、匹配失败请求的最多 3 条，以及「缓存命中或 Service Worker 代理的响应可能不产生 response 事件，可加 cache-busting 查询参数后重试」提示。
- 命中返回 `{ mode: 'response', tabId, pattern, urlMatch, responseMethod, statusMin, statusMax, includeBuffered, matchedResponse, timeoutMs, elapsedMs, summary }`；`responseMethod` 未给时为 `null`，`statusMin` / `statusMax` 为本次生效的区间值；`matchedResponse` 为 `{ url, method, status, mimeType, at, buffered }`（`at` 对缓冲命中取请求记录时间，对未来响应取命中时刻）。`summary` 形如 `等待响应命中：POST http://127.0.0.1:19387/api/order（HTTP 200，application/json，调用前已缓冲，耗时 3ms）`。
- 不读响应体、不返回完整响应头列表；需要响应体时等 P0-6（`specs/功能规格/0007-network-response-body.md`）。

### 输出与工具层渲染

- `selector`：`{ mode: 'selector', state, timeoutMs, elapsedMs, summary }`（与现状一致）。
- `expression`：`{ mode: 'expression', timeoutMs, elapsedMs, summary }`；不再返回 `state`，传 `state` 报错。
- `tools.js` 的第二行按 `mode` 渲染：`selector` 为 `状态：<state>，上限 <n>ms`；`expression` 为 `上限 <n>ms`；`url` 为 `匹配方式：<urlMatch>；命中来源：当前地址 / 等待期间的新地址；上限 <n>ms`；`response` 为 `匹配方式：<urlMatch>；命中来源：调用前已缓冲 / 等待期间到达；上限 <n>ms`。

### 状态变化

- 会话：不新增字段、不改变 `state`；`session.touch()` 仍只在工具调用入口刷新空闲计时。
- 标签页：不新增字段；只读 `tab.networkRing`，不写记录、不写 `refs`；显式 `tab_id` 在调用开始时解析，等待期间不跟随 active tab 切换。
- 面板：成功时 `summary` 进入 `action` 事件；不改面板协议、`lib/protocol.js` 与客户端 bundle。
- 浏览器进程：无变化。空闲回收仍以「本次工具调用开始」计时，单次等待超过 `DSH_BROWSER_IDLE_MS` 时浏览器可能在等待期间被回收（项目规格「进程回收三道兜底」记录的既有边界）。

## 边界

- 超时口径：与既有 `selector` / `expression` 一致，抛运行时错误，不返回结构化 `{ reached: false }`。竞品把超时做成成功返回的数据；本插件保持「工具失败即抛错」的既有口径，超时诊断信息（当前地址、已捕获响应、失败请求）全部放进错误文案，调用方不需要解析返回值猜结果。本口径只约束本工具的四类条件；新增的 browser_e2e_wait_for_human 是显式协同等待，超时按预期结果返回 resolved:false（见 0029-human-wait-captcha.md），与 0027-assert-tool.md「两者是不同工具的不同口径」同一处理，不改本工具任何行为。
- 等待期间页面导航：
  - `url` 条件只看主框架地址，导航/重定向/SHA 与 `pushState` 都会继续轮询直到命中或超时。
  - `response` 条件：网络环按主框架新文档请求重置，缓冲窗口随之切到新文档；已挂上的 `response` 监听继续生效，新文档自己发出的匹配响应仍可命中。
- 页面关闭或崩溃：`url` 轮询发现 `page.isClosed()`、`response` 收到 `close` / `crash` 事件时立即报「标签页已关闭」，不等满 `timeoutMs`。
- `includeBuffered: true` 的误报风险：等待前已经完成的同 URL 响应会立即命中（这正是它解决的问题）。对同一 URL 周期性轮询的页面，等待「点击后新发起的那一次」时必须传 `includeBuffered: false`，或用更精确的 URL / method / status 条件。
- 缓存与服务端推送：由内存缓存或 Service Worker 直接提供、不产生网络往返的响应可能不触发 `response` 事件，等待会超时；超时文案给出 cache-busting 提示。这是 Playwright/CDP 事件层限制，本功能不绕过。
- 匹配范围：`response` 是页面级事件，子 frame 的请求也可能命中，不提供按 frame 过滤；`url` 只看主框架。跨源 iframe 的定位/操作仍待 P1-9（`specs/功能规格/0010-iframe-operations.md`）。
- 轮询精度：`url` 每约 100ms 检查一次，存在时间短于轮询间隔的中间地址可能被跳过；`timeoutMs` 精度同样约 ±100ms。需要精确观察每次导航请用后续的导航历史能力（本规格不做）。
- 需要明确的非目标：不等待请求发出（`request`）、不等待下载、不等待控制台消息、不按 frame 过滤、不读响应体、不做跨 tab 匹配、不提供调用中取消（宿主工具调用没有取消入口，只能靠 `timeoutMs` 兜底）。
- 非法输入：`url` / `response` 为空字符串按未给处理（计入四选一错误）；`responseMethod` 空串、`statusMin` / `statusMax` 非 100–599 整数或倒置、`urlMatch` 不在枚举、`regex` 编译失败、`timeoutMs` 非正整数，均在等待前报错，错误文案给出可选值或修复方式。
- `data:` / `about:blank` 等地址可被 `url` 正常匹配；`url` 正则按完整 URL 字符串测试，不做 URL 解码。
- 并发：同一页面允许并发多个 wait，各自独立监听、互不共享结果；本规格不加锁，也不保证两个并发 wait 看到同一条响应。

## 验收

1. `node tests/wait.mjs` 退出码 0 且无 FAIL（该文件由 tester 新建，夹具见实施计划；下列用例名由本规格固定）：
   - url 组：`wait url 当前地址立即命中（matchedCurrent）`、`wait url 等待未来导航`、`wait url glob 匹配`、`wait url regex 匹配`、`wait url 跟随 SPA pushState`、`wait url 超时报当前地址`、`wait url 按 tab_id 作用于指定标签页`、`wait url 期间关页报标签页已关闭`。
   - response 组：`wait response 等待期间到达（buffered=false）`、`wait response 已缓冲命中（buffered=true）`、`wait response includeBuffered=false 时已到达响应导致超时`、`wait response 导航后旧文档缓冲不参与匹配`、`wait response method 过滤`、`wait response status 区间过滤`、`wait response 状态不符时超时错误列出已捕获响应`、`wait response 请求失败默认立即报错`、`wait response failOnRequestFailed=false 时超时错误列出失败请求`、`wait response 期间关页报标签页已关闭`、`wait 结束后临时监听已移除`。
   - 校验组：`wait 四种条件都不给报错`、`wait 同时给两个条件报四选一`、`wait selector 与 expression 同时给仍报二选一`、`wait urlMatch 非法报错`、`wait regex 非法报错`、`wait responseMethod 空串报错`、`wait status 区间非法或倒置报错`、`wait 条件专属参数错配报错`、`wait 非正整数 timeoutMs 报错`。
2. `node tests/tools.mjs` 退出码 0 且无 FAIL：既有 `wait selector 成功并返回耗时`、`wait 的 summary 含 selector 与耗时`、`wait expression 成功`、`wait 超时报错且带实际等待时长`、`selector 与 expression 同时给时报错`、`非法 selector 抛解析错误而不是「超时」文案` 全部 PASS；用例 10 的「注册的工具与工具表逐项一致」「工具名唯一且统一带 browser_e2e_ 前缀」不回退。
3. `node tests/panel.mjs` 退出码 0：`作用于页面的工具都接受 tab_id` 与工具参数契约断言不回退。
4. `node tests/multitab.mjs` 退出码 0：ref 按页隔离、`tab_id` 语义不回退。
5. `npm run test:unit` 退出码 0。
6. `npm run test:integration` 退出码 0（串行真起无头 Edge；进程类断言以回落到运行前基线为准）。`tests/wait.mjs` 不写入 `package.json` 的聚合脚本，由第 1 条单独跑；是否登记为后续维护项，由 Lead 决定。
