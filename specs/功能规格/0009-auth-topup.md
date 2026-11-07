# 鉴权补票

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/auth.js` 职责、边界「auth.js 删除是能力删除」）；specs/项目规格/0002-panel-protocol-v1.md（事件表：`action` 的 `summary` 取工具返回首行）
代码: lib/auth.js / lib/page.js / lib/index.js / tests/auth.mjs

## 需求

导航落到本机服务的登录挑战页（缺 launch-token）时，插件自动向宿主的 connection 服务换一条带 token 的地址并重试一次，让后续快照、点击不被挑战页挡住；宿主没有该服务或换不到地址时静默保持原导航结果。

## 行为

- **触发**：`page.js` 的 `navigate` 在 `page.goto(url, { waitUntil, timeout: 30000 })` 之后调 `auth.js` 的 `topUpIfChallenged(page, url, response)`。判定在 `isAuthChallenge`：`page.evaluate` 读 `document.title`（整体）与 `document.body?.innerText` 的前 `AUTH_PROBE_TEXT_LIMIT`（4000）个字符，用 `AUTH_CHALLENGE_PATTERN`（`/authenticat(e|ion)\s+required/i`）匹配标题或正文，任一命中即视为登录挑战。触发不看 HTTP 状态码。
- **动作**：`tryAuthTopUp` 依次过四道闸：目标地址必须是 loopback 的 `http` / `https`（`isLoopbackTarget` 用 `isLoopbackHostname`）；`setConnectionResolver` 注入的读取器必须存在且读得到 `connection`；`connection.authenticatedUrl` 必须是函数且返回非空、与原文不同的字符串；最后 `page.goto(authenticated, { waitUntil: 'load', timeout: 30000 })`。
- **只补一次**：`topUpIfChallenged` 对一次 `navigate` 只调一次 `tryAuthTopUp`，不递归、不按 tab 记忆；`auth.js` 不保存标签页状态，每次导航各判一次、各补一次。
- **标注**：补票成功时 `navigate` 返回 `authRetried: true`、`response` 换成补票的响应，`summary` 追加 `，已补票`；跳过或失败时 `authRetried: false`，`navigate` 用原 `response` 与当前页面状态返回，不重试、不抛错。
- **注入**：`index.js` 的 `apply` 调 `setConnectionResolver(() => (typeof ctx.get === 'function' ? ctx.get('connection') : undefined))`；`connection` 不写进插件 `inject`，服务不存在时读取返回 `undefined`，补票静默跳过（`auth.js` 的模块级 `connectionResolver` 缺省为 `null`）。

## 边界

- 非 loopback 目标不补票：`data:` URL 或远程主机即使标题 / 正文像挑战页也不补，`tryAuthTopUp` 第一道闸就返回 `null`。
- 正文取不到：`isAuthChallenge` 的 `evaluate` 抛错时按「未命中」处理，不补票、不抛错。
- 挑战页不是 HTML：不做 MIME 或状态码判断，只看渲染后的标题与 `body.innerText`；没有 body 文本时正文视为空串，只有标题命中才补票。
- resolver 缺失：`connectionResolver` 为 `null` / 非函数，`connection` 为空，或 `authenticatedUrl` 不是函数，都直接返回 `null`。
- resolver 异常：读取器抛错、`authenticatedUrl` 抛错、返回非字符串 / 空串 / 与原文相同，一律返回 `null`，导航结果不变。
- 补票请求自身失败：`page.goto` 抛错（网络错误、超时）时返回 `null`、导航结果保持原响应；`goto` 若正常返回 4xx / 5xx 响应（如 404），按补票成功处理（`authRetried: true`），导航的 `url` / `status` 取补票后的结果 —— `tests/auth.mjs` 用例 6 的 `重试到 404 也返回结果` 覆盖这条。
- 多次导航各自独立：前一次补过票不影响下一次；每个 tab 的每次 `navigate` 都重新判定。
- 删除 `auth.js` 是能力删除：要同时删 `page.js` 的 `import { topUpIfChallenged }` 与 `navigate` 里的调用、`index.js` 的 `setConnectionResolver` 注入，并删 `tests/auth.mjs`（口径见 `specs/项目规格/0001-architecture-invariants.md` 的「边界」）。

## 验收

- `node tests/auth.mjs`：exit 0、无 FAIL。用例 1 `命中挑战且 loopback 时补票成功`（`标记 authRetried`、`页面已进入登录后页面`、`正文是 welcome`、`只补票一次`、`summary 标注已补票`）；用例 2 `Resolver 返回同一地址 → 不补票`（`authRetried 为 false`、`页面停留在挑战页`）；用例 3 `没有 connection 服务 → 静默跳过`（`不抛错且不补票`）；用例 4 `Resolver 抛错 → 静默跳过`（`不抛错且不补票`）；用例 5 `非 loopback 目标不补票`（`data: 目标保持原状`、`没有调用补票`）；用例 6 `补票失败（404 地址）不抛错`（`重试到 404 也返回结果`）；用例 7 `补票地址与原文相同/空串时跳过`（`空串不补票`）。
