# web_fetch 改接浏览器

状态: 已实现（仅 B 切片；宿主 provider 接管待决策）
关联: specs/项目规格/0001-architecture-invariants.md（模块表与依赖方向、工具表单一来源、会话级浏览器与进程回收三道兜底、`invariants.js` 边界）；specs/项目规格/0002-panel-protocol-v1.md（面板只读定位；命令 / 事件 / 错误码表本项不动）；specs/项目规格/0003-未处理项.md（本项由 Lead 录入）；specs/功能规格/0002-browser-launch-and-reuse.md（浏览器按会话隔离、isolated / cdp 差异、复用与热切换拒绝）；specs/功能规格/0008-cdp-attach.md（CDP 接管用户浏览器与登录态、close 只断连）；specs/功能规格/0016-download-integrity.md（既有「经当前浏览器上下文请求」的 url 模式，与本项的分工）；specs/功能规格/0017-structured-read.md（页面读取的既有分工与文本预算）；README.md「Summary」「工具一览」「Known Limitations and Deferred Work」
代码: B 切片已落地：`lib/fetch.js`（新建，`fetchText`）/ `lib/page.js`（`createTransientPage` / `isTransientPage` / `addPage` 早退）/ `lib/session.js`（CDP `context.on('page')` 跳过临时页）/ `lib/tools.js`（`browser_e2e_fetch`，工具表 30 → 31）/ `README.md` / `docs/architecture.html` / `package.json` / `specs/项目规格/0001-architecture-invariants.md` / 本规格同步；测试面 `tests/fetch.mjs`（新建）/ `tests/cdp.mjs` / `tests/panel.mjs` / `tests/tools.mjs` / `tests/read.mjs` 已补。候选 A 未实现（`lib/fetch-provider.js` / `lib/index.js` 的 `inject` 与 provider 注册 / `cordis.patch.yml` / `package.json` / `tests/fetch-provider.mjs` 均未动）。两种候选都不改 `lib/protocol.js` / `lib/panel.js` / `client/index.js` / `lib/client.js`。

## 需求

宿主内置 `web_fetch` 是模型抓网页正文的工具：定义在宿主 `@deepseek-ai/dsh-tool-web`，参数只有 `url`（必填），返回 `{ url, statusCode, body: { kind: 'html' | 'text', content }, truncated }`，由 `ctx.web` 服务在调用时解析 provider。本插件没有任何抓取入口：`lib/index.js` 的 `inject` 只有 `['tools']`，`lib/tools.js` 的 `buildToolTable` 全部是 `browser_e2e_*` 工具（HEAD `94cddf3` 为 22 个），`lib/` 里检索不到 `registerFetchProvider` / `fetchProvider`（`git grep` 0 命中）。模型想「用浏览器抓一页正文」只能自己拼 `browser_e2e_navigate` + `browser_e2e_read` / `browser_e2e_evaluate`，代价是**当前标签页被导航走**、ref 表与事件环被重置、面板画面跳到目标页，抓完还得再导航回来。

竞品 Tabbit 的做法是**接管宿主 `web_fetch`**：`src/web-fetch/index.ts:242-244` 用 `ctx.web.registerFetchProvider(new TabbitFetchProvider(ctx.tabbit))` 注册 id 为 `tabbit-browser` 的 provider（`src/web-fetch/index.ts:68-69`），`inject` 声明 `['web', 'tabbit']`（`:239`）；再用 `cordis.patch.yml:75-78` 把宿主 `web` 行的 `fetchProvider` 从内置 `http` 改钉成 `tabbit-browser`，使「注册了也永远不会被选中」变成「唯一会被使用的通道」（文件头注释 `:27-34`）。它为此专门配了两道权限闸（`src/permissions/index.ts:11-22` 的 `pageAccess` 总闸 + `intranetFetch` 内网闸，`:62` 把 `web_fetch` 列为受管工具）。

本项判定为**影响大 → 待决策**，不是「单工具新增参数」。依据：

1. **越出本插件职责边界**：本插件对外只有 `browser_e2e_*` 工具表与右侧只读面板（README「Summary」：「所有页面操作只能由工具发起，面板是只读视图」；「工具一览」：「22 个工具统一带 `browser_e2e_` 前缀」）。接管 `web_fetch` 让本插件成为宿主的**全局网络抓取通道**，而不是一个会话内可选的工具：影响面从「本会话的一次工具调用」扩到「所有会话的所有 `web_fetch` 调用」。
2. **需要宿主 provider 接管**：要生效必须同时做两件事——(a) 在 `lib/index.js` 增加对 `ctx.web` 的依赖并调 `registerFetchProvider`（本仓当前 `inject` 只有 `tools`，且 `package.json` 未声明 `@deepseek-ai/dsh-web`）；(b) 在 `cordis.patch.yml` 按 id **整行替换**宿主 `web` 行（宿主 patch 不做深合并，必须重述 `searchProvider`），把 `fetchProvider` 钉到本插件 id。其中 (b) 属于 profile 配置层，不是工具面。
3. **改宿主工具面语义**：宿主 `web_fetch` 的描述、输出 schema、系统提示（「web_fetch returns external, untrusted page content」）与错误码都归宿主所有。改钉 provider 后同名工具的**抓取语义**变成「浏览器渲染 + 会话 cookie」，且**没有回落**：宿主选择规则是「钉了 id 就只用它；钉的 id 已注册但 `available()` 为 false 报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`」，浏览器不可用时该工具对所有会话直接失败（Tabbit 在 `cordis.patch.yml:70-72` 明确接受这个权衡）。
4. **接口不匹配（硬冲突）**：宿主 `WebFetchProvider.fetch(request, signal)` 的请求体只有 `{ url }`（宿主类型声明 `WebFetchRequest` 只有 `readonly url: string`），**没有会话标识**；而本插件的浏览器是**按会话隔离**的（`lib/tools.js` 的 `sessionKey(exec)` 取 `agent.id`，`lib/session.js` 的 `sessions` 按 key 各一份，README「重置会话」：「`browser_e2e_close` 只关闭本 agent 会话的浏览器」）。provider 拿不到 calling agent，就无法知道该用哪个会话的浏览器；可选的变通（全局单浏览器 / 用 `tools/pre-execute` 记录当前 agent 再经异步上下文传递 / 取「最近一个 ready 会话」）分别是改载体定位、依赖未验证的异步上下文、跨会话泄漏登录态。
5. **权限面与门控前置未落地**：经浏览器抓任意 URL 会带上真实 cookie（cdp 模式尤甚），需要 SSRF / 内网闸才谈得上「安全接管」；本仓门控（P1-14）本身仍未决策（`specs/项目规格/0003-未处理项.md` #3），本项不能先把抓取通道打开再补门。

另有一点产品语义要先说清：**isolated 模式没有登录态**。`lib/page.js` 的 `createPage` 在非 CDP 分支走 `session.browser.newPage({ viewport })`，Playwright 的 `browser.newPage` 每次新建一个 browser context（`node_modules/playwright-core/types/types.d.ts:11232`）——隔离模式的每个标签页各自一个 context，一次性 profile 关闭即丢弃。因此「带登录态的浏览器抓取」只在 `mode: 'cdp'`（接管用户浏览器）下成立；默认 isolated 下本项买到的是「真实 Edge 的 JS 渲染与请求指纹」，不是登录态。

候选方案（细节与影响面见 `.scratch/browser-plugin-survey/plans/28-web-fetch-browser.md` §1、§4、§6）：

- **A（竞品同构，需决策）**：注册 `browser-e2e` fetch provider 并改钉宿主 `web` 行。解锁条件：先定「provider 如何定位会话浏览器」与「抓取权限闸」两件事，且接受浏览器不可用时 `web_fetch` 全局失败、不再回落内置 `http`。
- **B（推荐退路，影响小）**：**不动宿主**，新增本插件自己的 `browser_e2e_fetch`：临时页 + 与 `browser_e2e_read` 同源的正文提取，返回 `{ url, statusCode, title, text, truncated }`。与宿主的 `web_fetch` 分工：本工具走会话浏览器（cdp 模式下带登录态、可被面板看到、受空闲回收约束），宿主 `web_fetch` 保持匿名直连。工具面只增一个工具，不改既有契约。
- **C（不做）**：维持 `browser_e2e_navigate` + `browser_e2e_read` / `browser_e2e_evaluate` 的既有组合，只在 README 写清分工。收益最小，仅在本项连 B 也不排期时成立。

**A 组仍未决策**：候选 A 的目标契约不构成实现契约，当前代码未实现；B 组已按 §4.2 的实现契约落地，验收第 2 组对应已实现的行为，第 1 组是立项时「现在就能跑的缺口基线」，第 3 组只在决策采纳 A 时适用。

## 行为

### 当前行为（缺口与既有边界）

- **宿主侧**：`web_fetch` 工具在 `@deepseek-ai/dsh-tool-web`；参数 `{ url }`（必填），输出 `{ url, statusCode, body, truncated }`，`body.kind` 为 `html` / `text`。provider 选择由 `ctx.web` 在调用时决定：钉的 id 已注册且 `available()` 为真 → 用它；钉的 id 未注册 → `WEB_PROVIDER_CONFIGURED_MISSING`；已注册但不可用 → `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`；未钉 id 且恰好一个可用 → 用它；未钉 id 且多个可用 → `WEB_PROVIDER_AMBIGUOUS`；未钉 id 且没有可用 → `WEB_PROVIDER_UNAVAILABLE`。宿主基础组合的 `web` 行把 `fetchProvider` 钉成 `http`（同组合还挂 `web-fetch-http` 与 `tool-web`），因此**不替换该行就永远选不到新 provider**。
- **本插件侧**：`lib/index.js` 的 `inject = ['tools']`，`apply` 只做工具注册、`session/disposed` 回收、`closeAll`、面板路由；没有 `ctx.web` 依赖，也没有任何 provider 注册。`lib/tools.js` 的 `buildToolTable` 是唯一工具声明处，`withOutput` 给每个定义补 `output`（缺省纯文本）。
- **最接近的既有能力（不构成等效）**：`browser_e2e_download` 的 `url` 模式在 `lib/download.js` 的 `fetchToFile` 里用 `tab.page.context().request.get` 取回响应体——共享该 context 的 Cookie，但**不渲染 JS、不提取正文、必定落盘**，且要求已有标签页。`browser_e2e_navigate` + `browser_e2e_read` / `evaluate` 能拿到渲染后正文，但会导航并重置当前页的 ref 表与事件环（`lib/page.js` 的 `navigate` 先 `clearRings` / `refs.clear()` / `invalidateBaselines`）。
- **会话与标签页**：浏览器按会话隔离（`sessionKey(exec)`）；`lib/page.js` 的 `createPage` 可在不登记标签页的情况下建页（`addPage` 才登记），`touchSession` 只在 `sessionOf` / 能力入口刷新空闲计时。
- **面板与协议**：`0002` 固定面板只读、命令与事件表不变；本项两种候选都不新增命令 / 事件。

### 候选 A 的目标契约（决策通过后）

- 新增 `lib/fetch-provider.js`，导出 `createFetchProvider(deps)`，返回实现宿主 `WebFetchProvider` 的对象：`{ id: 'browser-e2e', available(), ready?(), fetch(request, signal) }`。
- `available()` 只做本地廉价检查、不发网络请求：返回「本进程至少有一个处于 `ready` 且至少一个标签页的会话」。**这是 A 的核心待决点**：该语义等于「任意会话的浏览器可被任意会话的 `web_fetch` 借用」，与按会话隔离冲突；替代方案见计划 §4.1。
- `fetch({ url }, signal)`：`new URL(url)` 失败或协议不是 http / https → 抛宿主 `WebError`（`FETCH_INVALID_URL`）；用**由 provider 自己选定**的浏览器开临时页 → `goto(url, { waitUntil: 'domcontentloaded', timeout })` → 等 `settleMs` → 页内提取 `{ title, text }` → 关页 → 返回 `{ url: 最终地址, statusCode: 响应状态（无响应对象回退 200）, body: { kind: 'text', content: 标题存在时拼成 '# 标题\n\n正文' }, truncated }`。非 2xx 是结果不是错误（宿主契约）。超时抛 `FETCH_TIMEOUT`，其它失败抛 `FETCH_FAILED`；`signal` 中止时立即关页并抛 `FETCH_FAILED`。
- `lib/index.js`：经 `ctx.inject(['web'], (webCtx) => webCtx.effect(() => webCtx.web.registerFetchProvider(provider)))` 注册（与既有 `webServer` 的软注入同一写法），`package.json` 增加对 `@deepseek-ai/dsh-web` 的运行期依赖（用于 `WebError`）。
- `cordis.patch.yml`：按 id 整行替换宿主 `web` 行，重述 `searchProvider` 并写入 `fetchProvider: browser-e2e`。
- 抓取权限：需在 `tools/pre-execute` 上报 `{ kind: 'ask' }` / 拒绝（或等 P1-14 门控落地后再接），内网 / 回环目标单独一档；本条未定则不实现。

### 候选 B 的目标契约（若 A 否决）

- 工具名 `browser_e2e_fetch`，定义在 `lib/tools.js` 的 `buildToolTable`（放在 `browser_e2e_download` 之后）；能力实现在 `lib/fetch.js` 的导出 `fetchText(session, options, tabId)`。
- 参数（根 schema `required: ['url']`、`additionalProperties: false`）：

| 参数 | 类型 | 缺省 | 约束 |
|---|---|---|---|
| `url` | string | 必填 | 只接受 http / https 绝对地址 |
| `settleMs` | integer | `400` | 0–5000；`domcontentloaded` 之后等待页面稳定的时长，`0` 表示不等 |
| `timeoutMs` | integer | `25000` | 1000–60000；只约束导航（`goto`），不约束整次调用 |
| `maxChars` | integer | `16000` | 1–180000；正文上限，超出截断并置 `truncated` |
| `tab_id` | string | active tab | 用它所属**浏览器上下文**建临时页，因此共享该页的 Cookie / 登录态 |

- 取页链路：`currentTab(session, tab_id)` 解析目标页 → 用 `lib/page.js` 新增的 `createTransientPage(session, tabId)` 建临时页 → `goto` → 等 `settleMs` → `page.evaluate` 提取 → `finally` 关页。
  实测偏差（相对计划 §4.2）：**只有 CDP 模式**能用当前页的 `context().newPage()`；isolated 模式下 `browser.newPage` 建出的 context 不接受再 `newPage`（Playwright 报 `Please use browser.newContext()`），因此 isolated 分支改为 `session.browser.newPage({ viewport })`（关闭该页会一并关闭它所属 context）。isolated 本来每个标签页各自一个 context、没有跨页登录态可共享，所以「临时页共享当前页 Cookie」只在 CDP 模式成立（与本规格「需求」节末尾关于 isolated 无登录态的判断一致）。
- 临时页不登记：`lib/page.js` 用模块级 WeakSet 记「临时页」（导出 `createTransientPage` / `isTransientPage`），`addPage` 对临时页直接返回 `null`，`lib/session.js` 的 CDP 分支 `context.on('page')` 跳过临时页。不这么做的话，CDP 模式下 `context.newPage()` 会被那条监听登记成 `adopted` 标签页，抓取期间 `browser_e2e_tabs` 与面板 tab 条会多出一页。
- 页内提取脚本：根取 `document.querySelector('article, main, [role="main"]') || document.body`，取 `innerText`；标题取 `document.title`。与竞品 `src/web-fetch/index.ts:214-219` 同口径。
- 返回：`{ tabId, url: 最终地址, statusCode, title, text, truncated, empty, elapsedMs, mode, summary }`。非 2xx 照常返回结果（`statusCode` 为准），不抛错；`empty` 表示正文提取到 0 字符。
- 工具文本：`${summary}`、`标题：${title || '（空）'}`、`来源标签页：${tabId}（${mode === 'cdp' ? 'CDP 接管' : '隔离'}）`、正文为空时追加一行提示，最后是空行 + 正文。
- 失败文案（中文，带修复指引）：
  - `url 必须是 http / https 的绝对地址，收到 <JSON.stringify>`
  - `url 只支持 http / https，收到 <protocol>`
  - `浏览器尚未启动或没有可用标签页，请先 browser_e2e_start`（`currentTab` 落到 `assertCurrentTabAvailable` 的既有文案）
  - `获取超时：${timeoutMs}ms 内未完成（${url}）；可调大 timeoutMs（上限 60000）`
  - `获取失败：${原始 message}（${url}）`
  - `正文为空（${url}，HTTP ${status}）：页面可能在脚本渲染完成后才有内容，可调大 settleMs，或改用 browser_e2e_navigate + browser_e2e_read`
- 不新增 `lib/invariants.js` 断言：未知 tab 与未启动 / 无可用页分别经既有 `assertTabExists` / `assertCurrentTabAvailable`（都由 `currentTab` 触发）；临时页关不掉、导航失败都是操作结果（「运行时」），入参校验留在能力函数入口（「单次」）。

### 共同状态变化

- 会话：不新增字段；`session.state` 不变；空闲计时由入口的 `sessionOf` / `touchSession` 刷新（A 无会话概念，由 provider 自己选定浏览器，见计划 §4.1）。
- 标签页：B 不登记临时页、不改 `activeTabId`、不写 `tab.refs`、不写快照基线、不写 console / network 环形缓冲；临时页不挂 `attachPageHooks`，因此也不产生事件环记录。A 关页后不留孤儿标签页。
- 面板：不广播新事件、不改 `state`；B 的临时页不进 `session.pages`，因此不出现在 `browser_e2e_tabs` 与面板 tab 条（isolated 与 CDP 两种模式一致）。
- 进程：都不新起浏览器进程；B 复用当前会话浏览器，A 复用既有会话浏览器（或决策后的专用实例）；两者都要在 `finally` 里关页，异常路径不得留下孤儿页。

## 边界

- **A 的全局副作用**：接管后 `web_fetch` 对所有会话生效；浏览器不可用时不再回落内置 `http`（`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`）。钉错 id 会让该工具在整个 profile 里失效，属配置层故障，工具层无法自愈。
- **A 的会话归属**：provider 接口不含会话标识，实现只能三选一——全局单浏览器（改载体定位）、异步上下文关联（未验证宿主是否保留上下文）、取最近 ready 会话（跨会话泄漏登录态）。未定之前不实现。
- **A 的权限**：带真实 cookie 抓任意 URL 需要 SSRF / 内网闸与人工审批；本仓无 `tools/pre-execute` 使用先例，且门控 P1-14 未决策。
- **B 的前置**：必须已有启动中的浏览器与至少一个标签页；未启动报「浏览器尚未启动」，与 `createPage` 一致。
- **B 的临时页在 CDP 模式下对外可见**：`context.newPage()` 会在用户浏览器里真实开一个标签页，抓完即关，用户会看到一闪；本插件不把它登记为标签页（`isTransientPage` 豁免），所以 `browser_e2e_tabs` 与面板都不列它。isolated 模式不可见（无头）。
- **B 不承载「反爬绕过」**：真实 Edge 的指纹与 JS 渲染能过一部分站点，但本工具不做 UA / 指纹伪装、不点击、不等待特定元素；反爬强校验站点仍会失败，失败按导航错误原样报。
- **B 的正文口径**：`innerText` 只含渲染后的可见文本，隐藏节点、`<script>` / `<style>` 天然剔除；表格按行文本流出，不保留结构（要结构用 `browser_e2e_read`）。不进入 iframe 与 shadow root（与 `0017` 同口径）。
- **既有契约的例外**：`0008-cdp-attach.md` 的「增量接管」原文是「接管后注册 `context.on('page')`，用户在浏览器里新开的标签页也以 `adopted` 加入本会话」；本项要加一句例外——**本插件自己创建的临时页不登记**（用户新开的页照旧登记）。该例外只影响 CDP 分支的一条监听判断。
- **B 不返回 HTML**：需要 `outerHTML` 用 `browser_e2e_evaluate`（体积风险自担）。
- **B 的非文本响应**：PDF / 图片 / 二进制按 `innerText` 取到空串，返回 `empty: true` 与 `statusCode`；不解析、不落盘（要落盘用 `browser_e2e_download`）。
- **超时与取消**：B 的 `timeoutMs` 只约束 `goto`；`settleMs` 固定等待；`evaluate` 无超时（与快照 / 结构化读取一致），整次调用不接 `AbortSignal`，取消靠 `timeoutMs` 与页面自身响应。A 的 `signal` 中止只保证关页，`goto` 的中断由 Playwright 负责。
- **空闲回收**：单次抓取超过 `DSH_BROWSER_IDLE_MS` 时浏览器可能在抓取期间被回收（与 README「等待 URL 与网络响应」记录的同类边界），长抓取前把该值调 0 或调大。
- **明确不做**：Markdown 转换、按 URL 缓存或去重、代理选择参数（跟随浏览器启动参数）、抓取结果写入网络环形缓冲、并发限流、`web_fetch` 与 `browser_e2e_fetch` 的结果归一。

## 验收

### 1. 缺口基线（现在就能跑，判定缺口真实存在）

1. `node -e "import('./lib/tools.js').then(m => { const t = m.buildToolTable({ launchDefaults: () => ({}) }); console.log(t.length); console.log(t.map(d => d.name).filter(n => /fetch/.test(n)).join(',') || '(无)') })"` → 第一行是 `buildToolTable()` 的实际条数（不写死：HEAD `94cddf3` 为 22，P1-15 合入后为 23），第二行为 `(无)`。
2. `git grep -n -e registerFetchProvider -e fetchProvider -- lib client` → 无输出、退出码 1。
3. `node tests/panel.mjs` → exit 0、无 FAIL，且含有对工具表条数的断言（立项时 HEAD `94cddf3` 为 `工具表共 22 个`；P1-15 合入后为「工具表共 23 个」；本项落地后为「工具表共 31 个」，P2-28 合入后现为「工具表共 32 个」）；本项落地时必须同步这条断言。

### 2. 候选 B 落地后（`.scratch/browser-plugin-survey/plans/28-web-fetch-browser.md` §9 的用例）

1. `node tests/fetch.mjs`（新建；真起无头 Edge + 本地 HTTP 夹具）：exit 0、无 FAIL。用例与 `check` 标签：
   - 用例 1（夹具与正常抓取）：`夹具页加载成功`、`抓取返回最终 URL / 状态码 200 / 标题`、`正文含夹具页关键文本`、`正文不含 script 与隐藏节点文本`、`302 后返回最终地址`。
   - 用例 2（参数与错误）：`url 非字符串报错`、`非 http(s) 协议报错`、`timeoutMs 越界报错`、`settleMs 越界报错`、`maxChars 越界报错`、`未知 tab_id 报「不存在」`、`未启动时报「浏览器尚未启动或没有可用标签页」`。
   - 用例 3（登录态共享）：`CDP 模式下夹具页 set-cookie 后同一 tab 的抓取带上 Cookie`；isolated 模式每页各自一个 context，不测 Cookie 共享，只测抓取正常返回。
   - 用例 4（不污染既有状态）：`抓取后 tabs 数量不变`、`抓取后 activeTabId 不变`、`抓取后当前页 URL 不变`、`抓取后 tab.refs 内容不变`、`抓取不向 console / network 环形缓冲新增记录`、`抓取后面板 tab 列表不含临时页`、`临时页不进 session.pages`。
   - 用例 5（截断与空正文）：`maxChars 截断并置 truncated`、`非 2xx 返回结果不抛错`、`二进制响应返回 empty 与状态码`、`正文为空时不抛错且提示改用 navigate + read`。
   - 用例 6（超时与关页）：`导航超过 timeoutMs 报「获取超时」`、`失败路径不留下额外页面（浏览器 pages 数回到抓取前）`。
   - 收尾：`msedge 主进程回落到运行前基线`。
2. `node tests/panel.mjs` → exit 0、无 FAIL；`工具表共 N 个` 的断言按新条数更新，`作用于页面的工具都接受 tab_id` 的名单加入 `fetch`。
3. `node tests/cdp.mjs`（需要本机 Edge；找不到 Edge 时按现有 SKIP 口径以 0 退出）→ exit 0、无 FAIL。新增：`CDP 模式下抓取不新增标签页`、`CDP 模式下抓取不改变 activeTabId`、`CDP 模式下抓取后页面数回到抓取前`。
4. `node tests/tools.mjs` → exit 0、无 FAIL；`注册的工具与工具表逐项一致` 与工具表条数断言同步。
5. `npm run test:unit` → exit 0、无 FAIL（本项不动 `lib/protocol.js` 与 `client/index.js`）。
6. `npm run test:integration` → exit 0、无 FAIL，且 `package.json` 的 `test:integration` 清单包含 `node tests/fetch.mjs`（`tests/cdp.mjs` 已在清单内）。
7. `git status --porcelain lib/client.js lib/protocol.js lib/panel.js client/index.js` → 输出为空（客户端与协议未变）。

### 3. 候选 A 落地后（仅在决策采纳 A 时适用）

1. `node tests/fetch-provider.mjs`（新建；假 `ctx.web` 注册表 + 假浏览器，不启真浏览器）：exit 0、无 FAIL。`check` 标签：`provider id 为 browser-e2e`、`重复注册抛 WEB_DUPLICATE_PROVIDER`、`available() 在无 ready 会话时为 false`、`available() 不发网络请求`、`fetch 返回 url / statusCode / body.kind=text / truncated`、`标题非空时正文以 "# 标题" 开头`、`非法 url 抛 FETCH_INVALID_URL`、`非 http(s) 抛 FETCH_INVALID_URL`、`导航超时抛 FETCH_TIMEOUT`、`其他失败抛 FETCH_FAILED`、`失败与中止路径都关闭临时页`。
2. `node tests/tools.mjs` → exit 0、无 FAIL（工具表条数不变，A 不新增 `browser_e2e_*` 工具）。
3. 手工 GUI 验证（真宿主 profile）：启动本插件浏览器后调用 `web_fetch`，结果正文来自浏览器渲染（在目标页可见的登录态内容能被取到）；`browser_e2e_close` 后再调用，报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` 而不是回落直连；`git diff --stat cordis.patch.yml` 显示只改了 `web` 行的 `fetchProvider`（`searchProvider` 原样保留）。
4. `npm run test:unit` 与 `npm run test:integration` → exit 0、无 FAIL。
