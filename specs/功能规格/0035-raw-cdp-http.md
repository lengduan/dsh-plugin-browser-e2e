# 原始 CDP / HTTP 逃生口

状态: 已实现（仅 B1）；A（原始 CDP 与 `mode=server`）与 C（CDP 白名单子集）已否决（2026-11-08）
关联: specs/项目规格/0001-architecture-invariants.md（模块表与依赖方向、进程内对象契约、不变量清单、`invariants.js` 边界、验收命令）；specs/项目规格/0002-panel-protocol-v1.md（面板只读定位与投屏链路，本项不改协议）；specs/项目规格/0003-未处理项.md（本项待决策、P1-14 门控）；specs/功能规格/0008-cdp-attach.md（CDP 接管与「close 只断连」承诺）；specs/功能规格/0005-console-network-ring.md（事件环重置口径）；specs/功能规格/0019-evaluate-timeout.md（脚本超时与中断）；specs/功能规格/0015-network-response-body.md（请求详情与敏感头脱敏口径）；specs/功能规格/0016-download-integrity.md（既有浏览器上下文网络出口）；specs/功能规格/0006-plugin-config-and-live-apply.md（Config 字段与脏值口径）；specs/功能规格/0023-tool-permission-gating.md（工具定性 `access` 与门控判定矩阵）
代码: 候选 B1 已落地：新增 `lib/raw.js`（`rawHttp`）、`lib/tools.js` 注册 `browser_e2e_http`、`lib/page.js` 导出复用符号，同步 `README.md`、`docs/architecture.html`、`package.json` 与 `specs/项目规格/0001-architecture-invariants.md`；原始 CDP（`rawCdp`）与 `mode=server` 未实现。不改 `lib/protocol.js` / `lib/panel.js` / `client/index.js` / `lib/client.js`。

本项原按任务书硬约束 1 判「**影响大 → 待决策**」；Lead 采纳候选 B1（只做 `browser_e2e_http` 的 `mode=context`）作为可独立施工的切片——它不动既有承诺、不改配置与门控，因此只施工该切片，B1 已落地。2026-11-08 进一步决策：候选 A（原始 CDP 与 `mode=server`）与候选 C（CDP 白名单子集）**均否决**（理由见「边界」的否决条）。下文「候选 A 的目标契约」仅作历史记录，不得据此实施。判定依据见 `.scratch/browser-plugin-survey/plans/27-raw-cdp-http.md` §1 与 §6.4。

工具数量基线：取证时 HEAD `94cddf3` 的 `lib/tools.js` 的 `buildToolTable()` 是 22 个工具；本项不写死数量，实施与验收按 `buildToolTable()` 实际条数派生。

## 需求

Playwright 的抽象覆盖不到一些验证点：`Performance.getMetrics` 的性能指标、Service Worker 注册与版本、请求拦截与改包、target 级信息，以及「不经页面上下文、不回 CORS」的 HTTP 断言。竞品给了两个逃生口：Fisfzy 的 `ego_cdp`（任意 CDP `method` + `params`）与 `ego_http`（任意 method / headers / body，`browser` 与 `server` 两种模式），omdsh 把 devtools 组做成高权限工具组（条件注册 + 逐次审批）。

本项的目标是给本插件补同类的两个入口，使「Playwright 抽象之外」的验证不必退回人工 DevTools；收益是 `browser_e2e_*` 覆盖面扩大，代价是执行面与安全面扩张，因此必须先决策。

## 行为

### 当前行为（缺口与既有边界）

- 工具表里没有任何原始 CDP 或通用 HTTP 工具：`lib/tools.js` 的 `buildToolTable()`（HEAD 22 项）逐项无 `cdp` / `http` / `devtools`；`node -e` 过滤 `/cdp|http/` 得空（`browser_e2e_http` 与 `browser_e2e_cdp` 都不存在）。
- 唯一的页面脚本入口是 `lib/page.js` 的 `evaluate`：`page.evaluate(expression)` 加 `DEFAULT_EVALUATE_TIMEOUT_MS`，超时经 `page.context().newCDPSession(page)` 建临时 CDP 会话并发 `Runtime.terminateExecution`（`interruptPageScript`）。它证明「page 级 CDP 会话在 isolated 与 cdp 两种模式下都可用」，但只支持一个方法，且不能取回 CDP 命令的返回值之外的任何东西。
- 唯一的宿主侧 HTTP 出口是 `lib/download.js` 的 `fetchToFile`：`tab.page.context().request.get(url, { timeout, failOnStatusCode: false })`，校验 2xx / `Content-Length` / `maxBytes` 后写盘并算 SHA-256；不返回正文文本、不支持 GET 以外的方法与自定义头。
- 面板投屏走 CDP `Page.startScreencast`：`lib/screencast.js` 的 `_start` / `_stop` 与内部串行队列保证同一时刻最多一个投屏会话（`0001`「`assertSingleScreencast` 保留给纯函数测试」）。
- 无工具级门控：`lib/index.js` 的 `apply` 对 `withOutput(buildToolTable(...))` 全量注册，`execute` 直接 `definition.run`，无前置拒绝分支；`Config` 只有 `defaultMode` / `cdpEndpoint` / `quality` / `maxWidth` / `maxHeight` / `everyNthFrame` 六个字段。工具定性 `access` 与门控判定矩阵在 `0023-tool-permission-gating.md` 里仍待决策（`0003` #3）。

### 候选 A 的目标契约（决策通过后）

两个新工具：`browser_e2e_cdp`（原始 CDP）与 `browser_e2e_http`（通用 HTTP）。放在 `lib/raw.js`，只 import `lib/page.js` 的 `currentTab` / `settleWithin`（后者需从 `lib/page.js` 导出）与 `lib/defaults.js`；不 import 会话层。

#### `browser_e2e_cdp` 输入

| 参数 | 类型 | 缺省 | 约束与语义 |
|---|---|---|---|
| `method` | string | 必填 | CDP 方法名，`Domain.command` 形式（`^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$`），长度 <= 100；大小写按 CDP 协议原样传 |
| `params` | object | 省略 | `additionalProperties: true`；`JSON.stringify` 后 <= 65536 字节，超限报错不截断 |
| `target` | string | `page` | 枚举 `page` / `browser`；`page` 走 `page.context().newCDPSession(currentTab(...).page)`，`browser` 走 `session.browser.newBrowserCDPSession()` |
| `tab_id` | string | active tab | 仅 `target=page` 时参与；`target=browser` 时传了报错 |
| `timeoutMs` | integer | 5000 | 100–30000；只约束 `send` 的等待，不约束页面内的后续执行 |
| `maxChars` | integer | 65536 | 1024–65536；返回值序列化后的字符上限 |

#### `browser_e2e_cdp` 输出

- 返回 `{ target, method, tabId, result, text, chars, truncated, elapsedMs, summary }`。
- `result` 是 CDP 返回的原始对象（`undefined` 按 `null` 处理）；`text` 是 `JSON.stringify(result, null, 2)`，超过 `maxChars` 时截断并置 `truncated: true`，超限不报错。
- 序列化失败（循环引用 / BigInt）时回退 `String(result)`，`result: null`，`text` 带说明。
- `summary`：`CDP ${method}（${target === 'page' ? `页 ${tabId}` : '浏览器级'}，${elapsedMs}ms）`；截断时追加 `（结果已截断到 ${maxChars} 字符）`。
- 会话关闭后**不保留** CDP 会话：每次调用在 `finally` 里 `settleWithin(cdp.detach(), 500)`，不跨调用缓存。

#### `browser_e2e_cdp` 失败文案

| 场景 | 文案 |
|---|---|
| 缺 `method` | `缺少必填参数 method（非空字符串，形如 Performance.getMetrics）` |
| `method` 格式错 | `method 必须是 Domain.command 形式（如 Performance.getMetrics），收到 <JSON.stringify>` |
| `params` 非对象 | `params 必须是 JSON 对象，收到 <JSON.stringify>` |
| `params` 超限 | `params 序列化后 <N> 字节，超过上限 65536；请把大参数拆到多次调用，或改用 browser_e2e_evaluate` |
| `target` 非法 | `target 只支持 page / browser，收到 <JSON.stringify>` |
| `target=browser` 且传 `tab_id` | `target=browser 时不接受 tab_id：浏览器级命令不属于任何标签页` |
| 未启动 / 无页 | 沿用 `assertCurrentTabAvailable`：`浏览器尚未启动或没有可用标签页，请先 browser_e2e_start` |
| `tab_id` 不存在 | 沿用 `assertTabExists`：`tab <id> 不存在，请先 browser_e2e_tabs 获取最新 tab_id` |
| 超时 | `CDP 命令超时：<method> 未在 <timeoutMs>ms 内返回；该命令可能仍在执行，可重试或调大 timeoutMs（上限 30000）` |
| CDP 报错 | `CDP 命令失败：<method> → <原始 message>（code <code>）；方法不存在时换用当前浏览器版本支持的域` |
| 建会话失败 | `无法建立 CDP 会话：<原因>；CDP 接管下请确认 browser_e2e_start 仍可用` |

#### `browser_e2e_http` 输入

| 参数 | 类型 | 缺省 | 约束与语义 |
|---|---|---|---|
| `url` | string | 必填 | http / https 绝对地址；`new URL` 失败或协议不符直接报错 |
| `method` | string | `GET` | 枚举 `GET` / `POST` / `PUT` / `PATCH` / `DELETE` / `HEAD` / `OPTIONS`（拒绝 `CONNECT` / `TRACE` / 任意扩展方法） |
| `headers` | object | 省略 | 字符串键值对，最多 50 项，单项值 <= 8192 字符；`authorization` / `cookie` / `set-cookie` 等敏感头默认脱敏 |
| `body` | string | 省略 | <= 262144 字符；`GET` / `HEAD` 带 body 报错 |
| `mode` | string | `context` | 枚举 `context` / `server`；`context` 走 `page.context().request`（共享该页 Cookie，走浏览器启动时的代理），`server` 走宿主 `fetch`（不带 Cookie、不走 Playwright 代理） |
| `timeout_ms` | integer | 30000 | 1000–120000 |
| `max_chars` | integer | 65536 | 1–65536；只约束返回正文文本，不约束下载体积 |
| `tab_id` | string | active tab | 仅 `mode=context` 时参与 |

#### `browser_e2e_http` 输出

- 返回 `{ mode, url, finalUrl, status, ok, headers, body, redirect, elapsedMs, summary }`。
- `headers` 是响应头对象，敏感头替换为 `[已隐藏]`（与 `0015` 的 `SENSITIVE_HEADERS` / `REDACTED_HEADER_VALUE` 同口径；`lib/page.js` 需把这两个符号导出）。
- `body`：`{ kind, mimeType, bytes, chars, text, truncated, sha256? }`；文本类（`content-type` 命中 `text/*`、`application/json`、`application/xml`、`application/javascript`、`application/x-www-form-urlencoded`）给 `text`，按 `max_chars` 截断；二进制类只给 `bytes` 与 `sha256`（不返回 base64）。
- 非 2xx 是结果不是错误（`failOnStatusCode: false`），`ok` 为 `status` 在 200–299。
- `redirect`：`{ finalUrl, count }`；最多跟随 20 次（Playwright 默认值），超出按请求失败报错。实现偏差（2026-11-08 实测）：Playwright 1.63 的 `APIResponse` 没有 `request()` / `redirectedFrom()`，取不到逐跳请求链，因此 `count` 只能给 `0`（未重定向）/ `1`（重定向过），不是逐跳计数；跟随上限仍由 `maxRedirects: 20` 保证。
- `summary`：`HTTP ${method} ${host}${pathname} → ${status} ${mimeType || '-'}（${chars} 字符，${elapsedMs}ms，${mode === 'context' ? '浏览器上下文' : '宿主直连'}）`。

#### `browser_e2e_http` 失败文案

| 场景 | 文案 |
|---|---|
| `url` 缺失 / 非绝对 / 协议不符 | `url 必须是 http / https 的绝对地址，收到 <JSON.stringify>` |
| `method` 非法 | `method 只支持 GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS，收到 <JSON.stringify>` |
| `headers` 非对象 | `headers 必须是字符串键值对对象，收到 <JSON.stringify>` |
| 头超限 | `headers 超过上限（50 项 / 单项 8192 字符），当前 <N> 项` |
| `body` 与 GET / HEAD 冲突 | `GET / HEAD 请求不能带 body` |
| `body` 超限 | `body 超过上限 262144 字符，当前 <N>` |
| `mode` 非法 | `mode 只支持 context / server，收到 <JSON.stringify>` |
| `timeout_ms` / `max_chars` 越界 | `timeout_ms 必须是 1000..120000 的整数，收到 <值>` / `max_chars 必须是 1..65536 的整数，收到 <值>` |
| 未启动 / 无页（context 模式） | 沿用 `assertCurrentTabAvailable` |
| 超时 | `HTTP 请求超时：<url> 在 <timeout_ms>ms 内未完成；可调大 timeout_ms（上限 120000）` |
| 连接失败 / DNS / TLS | `HTTP 请求失败：<url> → <原始 message>` |
| `server` 模式被门控关闭 | `宿主直连 HTTP 已关闭（插件设置 allowRawHttpServer=false）：请改用 mode=context，或把该设置改为 true（下一次调用即生效）` |

#### 门控（候选 A 的前提，与 P1-14 合并决策）

- `Config` 新增两项，均 `.volatile()`：`allowRawCdp`（boolean，默认 `false`）、`allowRawHttpServer`（boolean，默认 `false`）。
- 工具表新增 `access: 'escape'` 定性（`lib/tools.js`）：`browser_e2e_cdp` 与 `browser_e2e_http`（`mode=server` 时按参数升级）。`0023` 的判定矩阵加一列，缺 `access` 的默认定性按 `0023` 现行规则仍是 `interact`，本项不改那条规则。
- 关闭时 `execute` 前置拒绝，文案：
  - `原始 CDP 逃生口已关闭（插件设置 allowRawCdp=false）：browser_e2e_cdp 可执行任意浏览器命令（包括关闭浏览器）。确认风险后把该设置改为 true（下一次调用即生效）。`
  - `宿主直连 HTTP 已关闭（插件设置 allowRawHttpServer=false）：browser_e2e_http 的 mode=server 不经浏览器上下文、不带登录态。改用 mode=context，或把该设置改为 true。`
- 门控是软护栏（与 `0023` 边界同口径）：模型改不了插件配置，但配置在宿主侧，本插件不校验配置文件完整性。

#### 候选 B1：只做 HTTP、`context` 模式（可独立施工，判「影响小」）

- 只新增 `browser_e2e_http`，`mode` 缺省 `context` 且**不接受** `server`（传 `server` 报 `mode 只支持 context`）。
- 能力等价于把 `lib/download.js` 的 `fetchToFile` 泛化：任意 method / headers / body、返回正文、不落盘、共享当前页 Cookie。
- 不需要新配置项、不改 `Config`、不改门控；判「影响小」，可先改规格（`0001` 模块表与返回值表）再实现。

#### 候选 B2：只做只读 CDP 域 + HTTP `context` 模式（保守变体）

- `browser_e2e_cdp` 只允许白名单方法：`Performance.getMetrics`、`DOMSnapshot.captureSnapshot`、`DOM.getDocument`、`DOM.getOuterHTML`、`DOM.getBoxModel`、`CSS.getComputedStyleForNode`、`Target.getTargets`、`Browser.getVersion`、`SystemInfo.getInfo`、`ServiceWorker.enable`。
- 拒绝 `Page.*` / `Runtime.*` / `Input.*` / `Network.*` / `Fetch.*` / `Browser.close` / `Browser.crash` / `Target.*`（除 `getTargets`）/ `Emulation.*` / `Storage.*` / `Security.*`，报 `CDP 方法不在只读白名单：<method>；需要的方法请提交决策或用 browser_e2e_evaluate`。
- 白名单维护在 `lib/raw.js` 的 `READONLY_CDP_METHODS`（常量，加注释说明来源与扩展规则）。这样不动 `0008` 的 close 承诺。

### 状态变化（候选 A / B1 共同）

| 对象 | 变化 |
|---|---|
| 会话 | 不新增字段；`session.state` 不变；入口经 `sessionOf` 刷新空闲计时（与页面工具一致） |
| 标签页 | 不改 `activeTabId`、不写 `refs` / 快照基线；`browser_e2e_cdp` 的页面域命令可能改 DOM / URL，ref 由既有 `assertRefRevalidated` 在下次点击时兜底报错 |
| 事件环 | 不写 `consoleRing` / `networkRing`；`browser_e2e_http` 不发导航，不触发 `isNewDocumentRequest`；`browser_e2e_cdp` 的 `Page.navigate` 绕过 `navigate` 的 `clearRings` / `refs.clear`（见边界） |
| 面板 | 协议、命令表、事件表、错误码表、`state` 形状全不变；只在既有 `execute` 包装里多一条 `action` 摘要（`lib/index.js` 的 `broadcastAction`） |
| 浏览器进程 | 不新起进程；`browser_e2e_cdp` 无方法白名单时**可以**关闭用户浏览器（候选 A 的固有风险）；`browser_e2e_http` 不产生进程 |
| 磁盘 | 不落盘（HTTP 正文只回文本，不给保存路径） |

### 超时与取消

- `browser_e2e_cdp`：`timeoutMs` 只约束 `send`；超时后 `detach` 同样受 `settleWithin(…, 500)` 兜底，不阻塞工具返回。不接 `exec.signal`，没有中途取消入口（与快照 / 结构化读取一致）。
- `browser_e2e_http`：`timeout_ms` 传给 Playwright `context.request` 的 `timeout` 与宿主 `fetch` 的 `AbortSignal.timeout(timeout_ms)`；超时后响应体不再读取。CDP 模式下 `context.request` 走宿主网络栈，不占用户浏览器标签页。
- 单次调用超过 `DSH_BROWSER_IDLE_MS` 时浏览器可能被空闲回收（README 已记录同类边界），`context` 模式随后报「浏览器尚未启动」。

## 边界

- **与 `0008` 的 close 承诺冲突（候选 A）**：`0008`「启动返回」与 `browser_e2e_close` 的摘要写明 `CDP 模式不会关闭你的浏览器，browser_e2e_close 只断开连接`；无方法白名单的 `browser_e2e_cdp` 可以发 `Browser.close` / `Browser.crash` / `Target.closeTarget`，直接关闭用户浏览器。承诺只覆盖 `browser_e2e_close`，不覆盖逃生口；采纳候选 A 必须在 `0008` 的「边界」加例外句，采纳候选 B2 则不需要。
- **绕过不变量**：`browser_e2e_cdp` 的 `Page.close` 可关到 0 页，绕过 `assertCanCloseLastTab`；`Page.navigate` 绕过 `navigate` 的 `clearRings` / `refs.clear` / `invalidateBaselines`，旧 console / network 记录可能留在新文档上（`0005` 的「新文档不得混进旧记录」只对 `navigate` 与主框架 document 请求成立）；`Runtime.evaluate` 绕过 `0019` 的超时中断（页面死循环只能 `browser_e2e_close`）。这些是逃生口的定义性后果，不是缺陷；`lib/invariants.js` 不新增断言（违反不来自跨调用积累，而来自一次外部命令），由下一次工具调用按现有断言兜底报错。
- **干扰面板投屏**：`Page.stopScreencast` 会停掉同一 target 上的投屏（`lib/screencast.js` 的 `_start` 不感知外部 stop），面板画面停止更新，直到下一次 `configure` / `select-tab` 重开；`Page.startScreencast` 的帧不会进入面板。`0002` 的「面板只读」不禁止工具改浏览器状态，但这条联动必须在 README 写清。
- **浏览器级 CDP 的范围**：候选 A 的 `target=browser` 只发 browser 域命令（`Browser.*`、`Target.getTargets`、`SystemInfo.*`、`Performance.*`），**不转发** `Target.attachToTarget` 的子会话消息（Playwright `CDPSession` 对扁平子会话的事件转发未验证，且它会绕开本会话的 `session.pages`）；需要操作其他 target 用 `target=page` + `tab_id`。
- **HTTP 语义差异**：`mode=context` 不受 CORS 限制（不是页面内 `fetch`），共享 Cookie 与 `browser_e2e_start` 的 `proxy`；`mode=server` 走宿主 `fetch`，不带 Cookie、不走代理、可访问 loopback / 内网（含本机 DSH GUI 与云元数据端点）——与 `fence.js` 无关，`fence.js` 只保护面板路由。竞品 `ego_http` 的 `browser` 模式是页内 fetch（受 CORS），本项不采用那个语义。
- **不做**：CDP 事件订阅（`Runtime.consoleAPICalled` 等，用 `browser_e2e_console`）；`Target.attachToTarget` / OOPIF 子会话转发；CDP 方法白名单之外的参数结构校验（CDP 自己报错）；HTTP 上传流式 body / multipart / 文件上传（用 `browser_e2e_upload`）；HTTP 落盘（用 `browser_e2e_download`）；浏览器上下文 cookie 的读写（P1-12 已确认、待实现）；`CONNECT` / `TRACE` / 任意扩展方法；WebSocket 帧级操作。
- **原始 CDP 逃生口与 `mode=server` 已否决（2026-11-08）**：A（任意 CDP 方法）会绕过既有不变量——`Page.close` 绕过 `assertCanCloseLastTab`、`Page.navigate` 绕过 `clearRings` / `refs.clear`、`Runtime.evaluate` 绕过 evaluate 的 `timeoutMs` 与 `terminateExecution`、`Page.stopScreencast` 停掉投屏、`Browser.close` 与 `0008`「CDP 模式不会关闭你的浏览器」的承诺冲突；门控现有的 `observe` / `interact` / `script` 三类装不下，需新增第 4 类 `escape`；`mode=server` 是宿主直连外发（不带 Cookie、不走代理、可打内网）。C（白名单子集）仍是通用命令通道，形态不对——将来需要暗色模式 / 网络节流 / 性能指标时，应做成具体的命名工具（如 `browser_e2e_emulate` / `browser_e2e_metrics`，走 Playwright `CDPSession` 在插件内部实现），而不是开旁路。
- **明确不改变**：`lib/protocol.js` / `lib/panel.js` / `client/index.js` / `lib/client.js`；协议版本与命令 / 事件 / 错误码表；`browser_e2e_close` 的语义；会话状态机与回收口径。

## 验收

### 1. 决策期间的回归基线（当前代码可执行）

1. `npm run test:unit`：exit 0、无 FAIL。
2. `node tests/panel.mjs`：exit 0、无 FAIL。相关用例名：`工具表共 <N> 个`（N 随施工时 `buildToolTable()` 实际值；HEAD `94cddf3` 为 22）、`注册的工具与工具表逐项一致（顺序与名字）`、`每个工具都有 description 与合法参数 schema（required 是 properties 子集）`。
3. `node tests/tools.mjs`：exit 0、无 FAIL。相关用例名：`注册的工具与工具表逐项一致`。
4. `node tests/cdp.mjs`：exit 0、无 FAIL（本机无 Edge 时按现有 SKIP 口径 exit 0）。

### 2. 缺口判定（当前代码可执行；实现后预期非 0，届时删除本条）

1. `node -e "import('./lib/tools.js').then(m=>{const t=m.buildToolTable({launchDefaults:()=>({})});const hit=t.map(d=>d.name).filter(n=>/cdp|http|raw/.test(n));console.log(t.length, JSON.stringify(hit))})"`：输出 `<实际条数> []`（读取时点 2026-11-08 工作树实测 `23 []`，HEAD `94cddf3` 为 22；命中列表为空）。
2. `git grep -n -e newBrowserCDPSession -e "browser_e2e_cdp" -e "browser_e2e_http" -- lib README.md`：无输出、exit 1。
3. `node -e "const s=require('fs').readFileSync('README.md','utf8');console.log(/逃生口|原始 CDP|browser_e2e_cdp/.test(s)?'有':'无')"`：输出 `无`。

### 3. 决策记录（Lead 录入后）

`pwsh -NoProfile -Command "if (Select-String -Path 'specs\项目规格\0003-未处理项.md' -Pattern 'P2-26' -Quiet) { exit 0 } else { exit 1 }"`：exit 0。

### 4. 采纳候选 B1 后（tester 新建 `tests/raw-http.mjs`，真起无头 Edge + `node:http` 夹具）

1. `node tests/raw-http.mjs`：exit 0、无 FAIL。正常路径用例名：`GET 返回 200 与文本正文`、`POST 带 JSON body 与响应回显`、`自定义请求头被服务端收到`、`响应头按对象返回`、`非 2xx 返回状态不抛错`、`redirect 后 finalUrl 是最终地址`、`context 模式带上当前页 Cookie`。
2. `node tests/raw-http.mjs`：exit 0、无 FAIL。参数与错误用例名：`url 缺失报错`、`非 http(s) 协议报错`、`method 非法报错`、`GET 带 body 报错`、`headers 非对象报错`、`timeout_ms 越界报错`、`max_chars 越界报错`、`mode=server 在 B1 下报「只支持 context」`、`未知 tab_id 报「不存在」`、`未启动时报「浏览器尚未启动或没有可用标签页」`。
3. `node tests/raw-http.mjs`：exit 0、无 FAIL。隔离与状态用例名：`请求不改变当前页 URL`、`请求不新增标签页`、`请求不写 console 环`、`请求不写 network 环`、`不落盘（产物目录无新文件）`。
4. `node tests/raw-http.mjs`：exit 0、无 FAIL。收尾用例名：`msedge 主进程回落到运行前基线`。
5. `node tests/panel.mjs` / `node tests/tools.mjs`：exit 0、无 FAIL，且工具表条数断言与 `buildToolTable()` 实际值一致。

### 5. 采纳候选 A（或 B2）后（tester 新建 `tests/raw-cdp.mjs`，夹具照 `tests/cdp.mjs` 起 `--remote-debugging-port` 的真实 Edge）

1. `node tests/raw-cdp.mjs`：exit 0、无 FAIL。只读命令用例名：`Performance.getMetrics 返回指标数组`、`DOM.getDocument 返回根节点`、`Target.getTargets 返回至少一个 page`、`Browser.getVersion 返回 product 字符串`。
2. `node tests/raw-cdp.mjs`：exit 0、无 FAIL。参数与错误用例名：`method 缺失报错`、`method 格式非法报错`、`params 非对象报错`、`params 超限报错`、`target 非法报错`、`target=browser 传 tab_id 报错`、`不存在的 CDP 方法报「命令失败」并带 code`、`timeoutMs 越界报错`、`未知 tab_id 报「不存在」`。
3. `node tests/raw-cdp.mjs`：exit 0、无 FAIL。模式差异用例名：`isolated 模式下 page 级 CDP 可用`、`cdp 接管模式下 page 级 CDP 可用`、`cdp 接管模式下 browser 级 CDP 可用（若 newBrowserCDPSession 在 connectOverCDP 下不可用则改为 SKIP 并注明）`。
4. `node tests/raw-cdp.mjs`：exit 0、无 FAIL。门控用例名（候选 A）：`allowRawCdp=false 时拒绝 browser_e2e_cdp`、`allowRawCdp=true 时放行`、`allowRawHttpServer=false 时拒绝 mode=server`、`拒绝文案含设置名与「下一次调用即生效」`。
5. `node tests/raw-cdp.mjs`：exit 0、无 FAIL。收尾用例名：`CDP 会话在每次调用后 detach（进程内不残留会话）`、`msedge 主进程回落到运行前基线`。
