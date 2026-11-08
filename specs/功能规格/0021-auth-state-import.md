# 登录态导入与持久化

状态: 已确认（采纳方案 A；实施待排期）
关联: specs/项目规格/0001-architecture-invariants.md（模块表、`session` 对象契约、不变量清单、会话状态机、进程回收三道兜底、已知结构性债务「`session.js` 粒度过大」）；specs/项目规格/0002-panel-protocol-v1.md（面板只读定位；命令 / 事件 / 错误码表不变）；specs/项目规格/0003-未处理项.md（本项由 Lead 录入）；specs/功能规格/0002-browser-launch-and-reuse.md（`launch` 参数、复用与热切换拒绝）；specs/功能规格/0008-cdp-attach.md（接管复用用户登录态、close 只断连）；specs/功能规格/0009-auth-topup.md（loopback 补票，与本项不重叠）；specs/功能规格/0020-session-reset.md（close + start 的上下文重置口径）
代码: 当前无代码改动（本项已确认、实施待排期）。方案 A 落地时预计涉及 `lib/auth-state.js`（新建）/ `lib/session.js` / `lib/page.js` / `lib/tools.js` / `lib/invariants.js` / `tests/auth-state.mjs`（新建）/ `tests/invariants.mjs` / `README.md`；不改 `lib/protocol.js` / `client/index.js` / `lib/client.js`。

## 需求

需要登录的站点，每轮端到端验证都要人工登录：isolated 模式是一次性 profile，`browser_e2e_close`（含空闲回收）之后 cookie / localStorage 随进程消失，插件没有任何把登录态带出或带回来的入口。`lib/auth.js` 的「认证补票」只处理本机 DSH GUI 的 loopback launch-token 挑战，不读不写 cookie / storage，也不跨会话（见 0009 与本规格「边界」的区分）。

竞品把「登录后的浏览器状态」当一等能力：anweat 用命名 `storageState` profile，在创建 context 时按域名过滤导入、可选在 context 关闭时写回；Fisfzy 用 CDP `Storage.setCookies` 把系统浏览器 cookie 按域名导入持久 profile，另有 `ego_auth_flush` 把 cookie jar 刷到磁盘。本项目标：能把已保存的登录态带进本会话，并能把当前会话的登录态保存成文件，让「登录后的流程」可重复验证。

本项原判定为**影响大 → 待决策**，已决策采纳方案 A（见下「决策记录」），依据如下（不是「单工具新增参数」）：

1. **载体定位**：isolated 模式当前没有会话级 cookie 罐。`lib/page.js` 的 `createPage` 在非 CDP 分支调 `session.browser.newPage({ viewport })`；Playwright 的 `browser.newPage` 是「新建一个 browser context 再建页，关页即关该 context」（`node_modules/playwright-core/types/types.d.ts:11232`，读取时点 2026-11-08）。因此现有每个标签页各是一个 context，标签页之间不共享 cookie / localStorage，也就没有「整个会话的登录态」可导入。要让导入对全会话生效，必须把 isolated 改为**每会话一个显式 context**，这是对既有标签页隔离语义、`0001` 的 `session` 对象契约（`context` 字段现由 `createPage` 仅在 CDP 分支读）与 `0020` 既有表述的修改。
2. **回收口径 / 持久化**：`lib/session.js` 的 `close` 是唯一收尾路径（显式 `browser_e2e_close`、空闲回收 `touchSession`、`session/disposed` 的 `closeBySessionId`、卸载 `closeAll` 都落到它）。自动持久化必须在关闭前导出 `context.storageState()` 并写盘，等于给 close 增加 I/O 与新的失败语义；换成持久 user-data-dir（`launchPersistentContext`）则把一次性 profile 变成跨会话载体，同样改回收口径。
3. **CDP 接管语义**：接管复用的是用户自己的浏览器与登录态（0008），导入等于往用户浏览器写 cookie，导出等于把用户 cookie 复制到磁盘；两者都需要单独决策，并与 0008「只断连、不关标签页」、0020「CDP 不清用户数据」保持一致。
4. **敏感数据落盘**：`storageState` 是明文凭据（cookie 值 + localStorage 值）。写不写、写到哪、权限、返回值是否回显、是否进日志，都要先定。

候选方案（细节与影响面见 `.scratch/browser-plugin-survey/plans/13-auth-state-import.md` §1、§6）：

- **A（已采纳）**：isolated 改为每会话一个显式 context；`browser_e2e_start` 新增 `storageState`（绝对路径，仅新启动时生效）与 `storageDomains`（可选域过滤）；新增 `browser_e2e_auth_export`（显式导出到 `~/.dsh/browser-e2e/auth/` 下的 `.json`）；**不自动持久化**，close 行为不变。导入/导出本身是新增参数与新工具，但前提的 context 统一属影响大，因此整项仍需先决策。
- **B**：持久 profile（`launchPersistentContext`，目录归插件所有）。自动跨会话保留，改载体定位与回收口径，成本最高。
- **C**：close 时自动导出、下次 start 自动导入。改 close 契约与回收口径，且崩溃 / 卸载路径无法保证落盘。
- **D**：对已启会话热导入（重建 context）。会让全部 tab、ref 基线、事件环、面板 tab 一起换掉，属改会话状态机。
- **A0（不推荐的最小切片）**：保持每页一个 context，逐页 `newPage({ storageState })`。新增参数即可实现（影响小），但语义是「每页一份登录态快照」：`new_tab` 的新页要重新导入，某一页登录后产生的新 cookie 不会传播到其它页，不能称为会话登录态；只作为决策被否决后的退路。

## 决策记录

- 2026-11-08：采纳**方案 A**（isolated 改为每会话一个显式 context + 显式导入 / 导出，不自动持久化）；同时定决策点 D4：导出（写侧）只允许 `~/.dsh/browser-e2e/auth/` 下的 `.json`，导入（读侧）仍接受任意绝对路径。B（持久 profile）/ C（close 自动导出）/ D（热导入）/ A0（每页一份）不采纳。
- 当前状态为「已确认、实施待排期」：下文「行为」的方案 A 目标是实现契约，当前代码未实现；验收第 1、2 组仍是现在可跑的基线与缺口判定。

## 行为

### 当前行为（缺口与既有边界）

- **启动与上下文**：`lib/session.js` 的 `launch` 在 isolated 分支用 `chromiumImpl.launch({ channel: 'msedge', headless, ignoreHTTPSErrors: true, proxy? })` 起浏览器，随后 `browser.newPage({ viewport: session.viewport })` 建首屏；不创建显式 context、不传 `storageState`。CDP 分支取 `browser.contexts()[0]` 接管既有页面。`sessionOf` 创建的对象里有 `context` 字段，但 isolated 分支从不赋值。
- **标签页**：`lib/page.js` 的 `createPage` 在 CDP 分支用 `session.context.newPage()`，其它情况用 `session.browser.newPage({ viewport })`；按上一条的 Playwright 语义，isolated 的每个标签页各自一个 context。
- **关闭与回收**：`lib/session.js` 的 `close` 先把会话从 `sessions` / `keyBySessionId` 摘除，再按模式收浏览器（`closeBrowser` 带 `DSH_BROWSER_CLOSE_TIMEOUT_MS` 兜底 / CDP 只 `browser.close()` 断连）；不读取、不写回任何登录态。`touchSession` 的空闲计时到点也走 `close`，因此登录态可能在无人操作时直接消失。
- **导入 / 导出**：`lib/` 内没有 `storageState`、`context.cookies`、`addCookies`、`userDataDir`、`launchPersistentContext` 的任何使用（2026-11-08 对 `lib/*.js` 检索无命中）；`lib/tools.js` 的 `browser_e2e_start` 参数只有 `headless` / `proxy` / `viewportWidth` / `viewportHeight` / `mode` / `cdpEndpoint`，没有登录态入口；没有导出类工具。
- **既有补票（不重叠）**：`lib/auth.js` 的 `topUpIfChallenged` / `tryAuthTopUp` 只在导航后命中 `AUTH_CHALLENGE_PATTERN`、且目标为 loopback http(s) 时，向宿主 `connection.authenticatedUrl` 换一条带 launch-token 的地址重试一次；不读不写 cookie / storage，不落盘，不跨会话，不处理第三方站点。唯一重合的场景是「本机 DSH GUI 的 loopback 登录挑战」，该场景已经由补票覆盖，**部分无需实现**；其余站点的登录态导入 / 导出不在补票能力面内。
- **面板 / 协议**：`0002` 固定面板是只读视图，命令表只有 `attach` / `select-tab` / `close-tab` / `request-frame` / `configure`；本项不新增命令与事件，也不改 `state` 形状。

### 推荐方案 A 的目标契约（决策通过后）

#### 输入

| 工具 | 参数 | 类型 | 缺省 | 语义 |
|---|---|---|---|---|
| `browser_e2e_start` | `storageState` | string（宿主绝对路径，`.json`） | 不传 = 现状 | 仅新启动时读取；在 isolated 建 context 前把文件作为 `storageState` 传给 `browser.newContext` |
| `browser_e2e_start` | `storageDomains` | string[]，元素是域名后缀（`example.com` / `*.example.com` 归一为同义） | 不传 = 文件内全部条目 | 只导入命中域名的 cookie 与 origin；命中规则同竞品：去掉前导 `.` 与 `*.` 后，`host === d` 或 `host.endsWith('.' + d)` |
| `browser_e2e_auth_export` | `path` | string（宿主绝对路径，`.json`，必须位于 `~/.dsh/browser-e2e/auth/` 下），必填 | — | 导出到的文件；上级目录不存在时由插件创建；已存在时默认报错 |
| `browser_e2e_auth_export` | `domains` | string[] | 不传 = 当前上下文全部条目 | 只导出命中域名的 cookie / origin |
| `browser_e2e_auth_export` | `overwrite` | boolean | `false` | 文件已存在时必须显式 `true` 才覆盖 |

`mode: 'cdp'` 与 `storageState` 互斥，`mode: 'cdp'` 下调用导出工具也直接报错（在 `connectOverCDP` 之前拒绝导入，避免先建连再失败）。

#### 输出

- `browser_e2e_start` 新增返回字段 `storageState: { path, cookies, origins, domains }`（`cookies` / `origins` 是条目数，`domains` 是导入到的域名数组，升序去重）；不传 `storageState` 时**不返回**该字段，返回形状与摘要逐字不变。摘要追加 `，已导入 <N> 个 cookie、<M> 个 origin（<D> 个域名）`。
- `browser_e2e_auth_export` 返回 `{ file, bytes, cookies, origins, domains, overwrite }`；工具文本摘要为 `已导出登录态到 <path>：<N> 个 cookie、<M> 个 origin（<D> 个域名）；文件含明文凭据，勿提交仓库`。**返回值与日志不含任何 cookie 名 / 值**，只出现域名与计数。
- 写盘用「同目录临时文件 + rename」原子替换，文件权限 `0o600`（POSIX；Windows 上 mode 位不生效，只保证文件名与内容正确）。

#### 失败文案

| 场景 | 文案 |
|---|---|
| `storageState` 非字符串 / 空串 | `storageState 必须是 .json 文件的绝对路径，收到 <JSON.stringify>；请先用 browser_e2e_auth_export 生成` |
| 不是绝对路径 | `storageState 必须是绝对路径：<p>；请给出宿主上的完整路径（如 C:\tmp\state.json）` |
| 文件不存在 / 不是文件 | `storageState 文件不存在：<p>；请确认路径拼写，并确认文件在运行插件的这台机器上` / `storageState 路径不是文件：<p>；请指向具体的 .json 文件` |
| 不是合法 JSON | `storageState 不是合法 JSON：<p>；请确认它是 Playwright storageState（cookies / origins）文件` |
| 文件过大（> 16 MiB） | `storageState 文件过大：<size> 字节，上限 16777216 字节；请换一份更小的登录态文件，或先用 storageDomains 收窄导入范围` |
| 形状非法 | `storageState 形状非法：cookies 必须是数组、origins 每项必须是带 origin 字符串的对象；请用 browser_e2e_auth_export 生成` |
| `storageDomains` 形态非法 | `storageDomains 必须是域名后缀字符串数组，收到 <JSON.stringify>；例如 ["example.com"]` |
| 域过滤后为空 | `storageState 里没有命中 storageDomains 的条目（cookie 域名与 origin 主机都没匹配）；请检查域名后缀，或去掉 storageDomains` |
| 已启动时再传 `storageState` | `浏览器已启动（isolated / CDP 接管）；storageState 只在启动时生效，如需更换登录态请先 browser_e2e_close 再 browser_e2e_start` |
| CDP + `storageState` | `CDP 模式不导入登录态：接管的是用户自己的浏览器，其 cookie 由用户维护；请在 isolated 模式使用 storageState` |
| CDP + 导出 | `CDP 模式不导出登录态：那会把用户浏览器的 cookie 写到磁盘；请在 isolated 模式导出` |
| 导出前未启动 | 沿用 `浏览器尚未启动，请先调用 browser_e2e_start` |
| `path` 非绝对 / 非 `.json` | `path 必须是 .json 文件的绝对路径，收到 <JSON.stringify>；例如 C:\tmp\state.json` |
| `path` 不在允许目录 | `导出路径必须位于 ~/.dsh/browser-e2e/auth/ 下：<p>；该目录存放明文登录态，避免误写进仓库工作树` |
| 文件已存在且未覆盖 | `文件已存在：<p>；导出的是明文凭据，确认覆盖请传 overwrite: true` |
| 写盘失败 | `导出登录态失败：<原因>；未写入目标文件（临时文件已清理）` |

#### 状态变化

| 对象 | 变化 |
|---|---|
| 会话 | isolated 的 `session.context` 从「无」变为「启动时创建的显式 context」；新增 `session.storageState = { path, domains }` 仅用于复用一致性与诊断；状态机（`idle / launching / ready / closing / closed`）不新增状态 |
| 标签页 | 同一会话的全部标签页改为 `session.context.newPage()`，共享 cookie / localStorage；tab_id、ref 表、事件环、快照基线规则不变 |
| 面板 | 不变：`opened` / `closed` / `changed` 与 `state` 形状都不变；不新增命令 / 事件 / 错误码 |
| 浏览器进程 | 不变：isolated 仍是插件拉起的临时进程，close 仍结束进程；不写 user-data-dir |
| close / 回收 | **不变**：close 不导出、不写盘；导出只能由 `browser_e2e_auth_export` 显式触发 |
| 磁盘 | 只新增「导出时由调用方指定路径」的一个文件；不新增插件自有登录态目录 |

#### 超时与取消

- 读 `storageState` 文件是同步读 + JSON 解析，设上限（建议 16 MiB，超过按 `storageState 文件过大…` 报错），不设超时；上下文创建沿用 Playwright / 浏览器自身超时，不新增参数。
- 导出 `context.storageState()` 走 Playwright 默认行为，不新增超时参数；调用中没有取消通道（与现有工具一致）。

## 边界

- **不自动持久化**：close（含空闲回收、`session/disposed`、卸载）不导出登录态；忘在 close 前导出就丢失，这是推荐方案 A 的明确取舍。自动持久化属候选 B / C，须另立决策。
- **不支持热导入**：已启动会话传 `storageState` 一律报错，不重建 context、不换 tab、不动 ref；与 `mode` / `cdpEndpoint` 的热切换拒绝口径一致。
- **CDP 模式明确不做**：不导入、不导出、不改用户浏览器 cookie；接管复用的就是用户现有登录态（0008），需要保存用户浏览器状态应在浏览器侧自行处理。
- **载体是 Playwright `storageState` 文件**，不是浏览器 user-data-dir：只含 cookies 与每个 origin 的 localStorage，不含 sessionStorage、IndexedDB、CacheStorage、Service Worker 缓存、HTTP 认证凭据。仅依赖 sessionStorage / IndexedDB 的登录（部分 SPA、OAuth PKCE 存储）不会因此恢复，需在 README 写明。
- **域过滤是安全边界而非完整沙箱**：不传 `storageDomains` 时按文件内全部条目导入（与 Playwright 默认一致），摘要会列出域名；传了则只导入命中域名。导入他人文件可能造成会话固定 / 串号，调用方负责文件来源；插件不校验 cookie 的 `secure` / `sameSite` 与目标站策略是否兼容。
- **导出的是明文凭据**：默认不覆盖已有文件、返回值不含值、文件权限 0600。**写侧只允许 `~/.dsh/browser-e2e/auth/` 下的 `.json` 文件**（决策点 D4 已定）：导出的是明文 cookie + localStorage，插件无法判断目标路径是否落在某个仓库工作树内，因此不设目录豁免；目录不存在时由插件创建。导入读侧仍接受任意绝对路径，因为读的是调用方自己提供的文件。README 必须给出「导出物不要提交、不要放进 profile」的警告。
- **并发**：并发 `start` 都带同一份 `storageState` 时，后到者按既有 `launchTask` 落定后复用，不重建 context；带不同 `storageState` / `storageDomains` 时后到者报错，先到者会话不受影响。
- **空状态**：文件里 cookies 与 origins 都为空时允许（视为「显式从空登录态开始」），摘要报 0；导出当前上下文为空时仍写文件并提示 `当前上下文没有 cookie / localStorage，导出的是空状态`。
- **与既有规格的联动**：采纳 A 后，`0020` 的「close 再 start 后 cookie 与 localStorage 已清空」只在**不带** `storageState` 时成立；带 `storageState` 的 start 会按文件恢复，`0020` 需同步加条件（见实施计划 §6.3）。
- **明确不做**：不读系统 Chrome / Edge 的 cookie 库（Fisfzy `ego_login_import` 那条 ABE 风险路径）、不做扩展桥接配对、不做 profile 命名管理、不做多 profile 切换、不做 cookie 过期刷新、不做登录表单自动化、不新增 `browser_e2e_login` 之类的高层工具。

## 验收

### 1. 决策期间的回归基线（当前代码可执行）

1. `node tests/multitab.mjs`：exit 0、无 FAIL。相关用例名 `启动成功`、`new_tab 生成 t2 且标记 newTab`、`t2 成为 active`、`t1 的 ref 在 t2 上失效`。
2. `node tests/reclaim.mjs`：exit 0、无 FAIL。相关用例名 `显式 close 返回 closed=true`、`显式 close 后 Edge 主进程已回落`、`launch 落定后空闲回收仍然生效`、`后到的一次按复用返回同一实例`。
3. `node tests/auth.mjs`：exit 0、无 FAIL。相关用例名 `命中挑战且 loopback 时补票成功`、`只补票一次`、`data: 目标保持原状`。
4. `node tests/cdp.mjs`：exit 0、无 FAIL（本机无 Edge 时按脚本既有 SKIP 口径以 0 退出）。相关用例名 `接管成功且 mode 为 cdp`、`close 返回 cdp 模式`、`浏览器进程仍然存活`。
5. `npm run test:unit`：exit 0、无 FAIL。

### 2. 缺口判定（当前代码可执行）

1. `pwsh -NoProfile -Command "if (Select-String -Path 'lib\*.js' -Pattern 'storageState|addCookies|launchPersistentContext|userDataDir' -Quiet) { exit 1 } else { exit 0 }"`：exit 0，证明 `lib/` 内没有登录态读写能力（读取时点 2026-11-08；后续实现后本命令预期变成非 0，届时删除本条）。
2. `pwsh -NoProfile -Command "if ((Select-String -Path 'lib\page.js' -Pattern 'browser.newPage').Count -ge 1) { exit 0 } else { exit 1 }"`：exit 0，证明 isolated 仍走 `browser.newPage`（每个标签页一个新 context，见 `createPage`；采纳 A 后本命令预期变成非 0，届时删除本条）。

### 3. 决策记录（Lead 录入后）

- `pwsh -NoProfile -Command "if (Select-String -Path 'specs\项目规格\0003-未处理项.md' -Pattern 'P1-12') { exit 0 } else { exit 1 }"`：exit 0。

### 4. 采纳方案 A 后的实施验收（决策通过后由 tester 新建 `tests/auth-state.mjs`）

1. `node tests/auth-state.mjs`：exit 0、无 FAIL。正常用例名：`导入 storageState 后页面 cookie 生效`、`导入 storageState 后同源 localStorage 生效`、`导入后新开标签页共享同一登录态`、`导出文件是 Playwright storageState 形状`、`导出的文件可在下一次 start 重新导入`、`未传 storageState 时启动摘要与现状一致`、`启动摘要标注导入的 cookie / origin / 域名数`。
2. `node tests/auth-state.mjs`：边界用例名 `storageState 文件不存在时报错`、`storageState 不是合法 JSON 时报错`、`storageState 形状非法时报错`、`storageState 相对路径报错`、`storageDomains 过滤只导入命中域名`、`storageDomains 无命中时报错`、`已启动时再传 storageState 报错且不重建 context`、`CDP 模式传 storageState 先报错且不建立连接`、`导出路径已存在且未传 overwrite 时报错`、`导出路径不在 ~/.dsh/browser-e2e/auth/ 时报错`、`导出返回值不含 cookie 值`、`空上下文导出仍成功并标注空状态`、`两个会话各自导入不同 storageState 互不影响`、`close 后不带 storageState 再 start 登录态清空`。
3. `node tests/invariants.mjs`：exit 0、无 FAIL。新增用例名 `assertSessionContext：isolated ready 会话无 context 时报错`、`assertSessionContext：有 context 时通过`。
4. `node tests/tools.mjs`：exit 0、无 FAIL。新增用例名 `start 的参数表含 storageState 与 storageDomains`、`auth_export 的参数表含 path / domains / overwrite 且 path 必填`。
5. `node tests/multitab.mjs`：exit 0、无 FAIL；`t2 成为 active` 仍 PASS（证明 context 统一没有破坏 tab 管理；跨标签页共享登录态的用例在 `tests/auth-state.mjs` 的第 1 组）。
6. `node tests/reclaim.mjs`：exit 0、无 FAIL；进程断言仍以回落到运行前基线为准（证明 close 口径未变）。
7. `npm run test:unit` 与 `npm run test:integration`：均 exit 0、无 FAIL（`tests/auth-state.mjs` 经 Lead 批准后加入 `package.json` 的 `test:integration`，串行执行）。
