# 会话上下文重置

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（会话状态机、进程回收三道兜底、`session` 对象契约）；specs/项目规格/0002-panel-protocol-v1.md（面板只读定位、命令 / 事件 / 错误码表不改）；specs/功能规格/0002-browser-launch-and-reuse.md（launch / 复用 / 关闭）；specs/功能规格/0004-snapshot-and-ref-table.md（ref 表按页隔离与清空）；specs/功能规格/0005-console-network-ring.md（事件环按新文档重置）；specs/功能规格/0008-cdp-attach.md（CDP 接管只断连）
代码: lib/session.js / lib/page.js / lib/tools.js / tests/session-reset.mjs / tests/cdp.mjs

## 需求

在同一 agent 会话内把浏览器恢复到干净上下文：清掉 cookie、localStorage、sessionStorage 与已打开页面，并让 ref 表、控制台 / 网络记录失效，用于验证两种登录态或从脏页面恢复。

经评估，本项**不新增工具**：isolated（默认）模式下 `browser_e2e_close` + `browser_e2e_start` 已重建浏览器进程与一次性 profile，`browser_e2e_navigate` 已按新文档重置 ref 表与事件环；anweat「每个 session 独立 context」的隔离效果，在我方由「每个 agent 一个浏览器进程」覆盖。CDP 模式只断连，不清用户浏览器数据（明确不处理）。

## 行为

### 输入

不新增 `browser_e2e_*` 工具、参数或协议命令。重置由既有操作组合承担：

- **上下文与进程重置（isolated，默认模式）**：`browser_e2e_close`（无参数）→ `browser_e2e_start`（参数沿用现有表，全部可选：`headless` / `proxy` / `viewportWidth` / `viewportHeight` / `mode` / `cdpEndpoint`）。`close` 删掉本 agent 的会话对象并收掉浏览器；`start` 新建会话对象、起新临时 profile、分配新标签页 `t1`。
- **单页回到空白**：`browser_e2e_navigate` 的 `url: "about:blank"`（缺省作用于 active tab，可带 `tab_id`）。
- **ref 表与事件环重置**：`browser_e2e_navigate` 到任意新文档；同 URL reload 也算，hash 变化与 SPA 路由不算（判据见 `lib/page.js` 的 `isNewDocumentRequest`）。

组合不是原子操作：两步之间会话不存在。要沿用非默认的运行参数，`start` 必须重新显式传 `mode` / `cdpEndpoint`——`browser_e2e_close` 不把上一会话的 mode / endpoint 留给下一次 start。

### 输出

- `browser_e2e_close`：isolated 返回 `浏览器已关闭`；CDP 返回 `已断开 CDP 连接（用户浏览器保持运行）`。既有文案，不改。
- `browser_e2e_start`：isolated 返回 `启动浏览器 系统 Edge <version>（headless=<bool>，视口 WxH）`，`reused` 为 `false`；CDP 返回 `接管 CDP 浏览器 <endpoint>（N 个标签页，系统 Edge <version>）`。
- `browser_e2e_navigate`：返回 `tabId`（重开后的第一页为 `t1`）与既有 `导航到 <url>（标签页 t<N>，HTTP ...）` 摘要；该页 `refs` 清空，事件环清空后只保留新文档自身的请求。
- 不新增错误文案。两步之间调用页面工具，沿用 `浏览器尚未启动，请先调用 browser_e2e_start` / `浏览器尚未启动或没有可用标签页，请先 browser_e2e_start`；`start` 失败沿用既有启动错误。

### 状态变化

| 对象 | isolated：close → start | CDP：close → start |
|---|---|---|
| 会话 | 旧对象从 `sessions` / `keyBySessionId` 删除，新对象进入 `ready`；agent id 不变 | 旧对象删除；重连后新对象进入 `ready`，`mode: 'cdp'` |
| 标签页 | 旧页随进程结束全部消失；新页 `t1`（`origin: 'created'`），`nextTabSeq` 从 1 重新分配 | 用户浏览器标签页不动；重连按 `context.pages()` 重新接管（`origin: 'adopted'`），tab_id 从 `t1` 重新分配 |
| cookie / storage | 新临时 profile 全空（cookie、localStorage、sessionStorage、IndexedDB、缓存随旧 profile 一起丢弃） | **保留**，上述存储面都不清；明确不处理 |
| ref 表 / 事件环 | 随旧页销毁；新页空 | 新页条目空；用户原页面的历史记录不回放 |
| 面板 | 收到 `closed`：tab 条清空、`ensureScreencast(null)` 停投屏；`opened` 后重取 tab、按新页面对象重开投屏 | 同左；重连后 tab 列表按用户浏览器重新接管 |
| 浏览器进程 | 旧 Edge 主进程结束（`closeBrowser` 等 graceful close，`DSH_BROWSER_CLOSE_TIMEOUT_MS` 到点后不强杀、只如实报告可能残留），随后起新进程 | 不启动、不结束；只断连再连 |
| 空闲计时 | `close` 清旧计时器；`launch` 落定后 `touchSession` 重装，从落定起满额（默认 `DSH_BROWSER_IDLE_MS`=600000） | 同左 |
| 其它 agent 会话 | 不受影响：`sessions` 按 agent key 隔离，`close(key)` 只删本 key | 不受影响；但同一 CDP 浏览器被多个会话接管时标签页视图共享，是 `0008` 的既有口径 |
| 产物目录 | 新会话经 `ensureArtifactsDir` 生成新目录；旧截图文件仍在磁盘 | 同左 |

## 边界

- **明确不新增 `browser_e2e_reset` / `browser_e2e_reset_session`**：两者在本仓要么是 `close` + `start` 的两步包装（无新能力，还需伪装成原子操作），要么要求「保留进程、原地重建 context」，后者需要串行锁或新的 `resetting` 状态，属影响大（见实施计划 §6）。
- **CDP 模式不清 cookie / storage、不关用户标签页**：与 README「CDP 只断连」一致；清用户真实浏览器数据超出接管语义。需要干净上下文时用 isolated 会话，或在用户浏览器里自行清理。
- **不按单个标签页清登录态**：cookie / storage 是 context 级；`close` + `start` 会影响本 agent 的全部标签页。只想要 ref 表 / 事件环重置时用 `browser_e2e_navigate`，不要关浏览器。
- **不保留、不导出登录态**：登录态导入与持久化属 `0021-auth-state-import`，本项不做。
- **不恢复旧标签页 URL**：新 `start` 得到一张空白页；要回到原页面由调用方重新 `navigate`。
- **不保证原子性与并发安全**：两步之间任何页面工具都会报未启动；并发 `start` 复用同一实例；启动中的 `close` 由 `launch` 的收尾路径清理并按 `closing → closed` 落定，启动落定前会话已被 close 时后到的 `launch` 报「浏览器已关闭（启动与关闭并发）」。既有行为，不新增互斥。
- **失败不回滚**：`start` 失败则当前无浏览器，重试 `start` 即可；`close` 在未启动时返回 `浏览器未启动，无需关闭`，不报错。
- **不改变回收口径**：仍走同一 `close` 路径与 `CLOSE_TIMEOUT_MS` 兜底，进程断言以回落到运行前基线为准；重置不引入额外的进程或回收兜底。
- **空闲计时归零**：旧计时器在 `close` 里清掉，新浏览器在 `launch` 落定后才开始计时；不会把「重置前的空闲时长」继承给新会话。
- **面板 / 协议零新增**：不新增命令、事件、错误码；面板只按既有 `opened` / `closed` / `changed` 触发 `state` 同步。

## 验收

1. `node tests/session-reset.mjs`（tester 新建）：用例名 `重置前 cookie 与 localStorage 已写入` PASS，exit 0、输出 `FAIL 0`。
2. `node tests/session-reset.mjs`：用例名 `close 再 start 后 cookie 与 localStorage 已清空` PASS（`document.cookie` 不含重置前写入的键、`localStorage` 同名键为 `null`、`start` 返回 `reused === false`），exit 0、`FAIL 0`。
3. `node tests/session-reset.mjs`：用例名 `重置后标签页从 t1 重新开始且只有一页` PASS（`tabs` 长度为 1、`tab_id === 't1'`、`active === true`），exit 0、`FAIL 0`。
4. `node tests/session-reset.mjs`：用例名 `重置不影响另一个会话的登录态` PASS（另一个 key 的 `document.cookie` 仍含它自己的 cookie，`activeSessionKeys` 同时包含两个 key），exit 0、`FAIL 0`。
5. `node tests/session-reset.mjs`：用例名 `重置后旧计时器清空且新会话重新计时` PASS（close 后旧会话对象 `idleTimer === null`；start 后新对象与旧对象不同且 `idleTimer !== null`），exit 0、`FAIL 0`。
6. `node tests/cdp.mjs`：用例名 `CDP 模式下 close 再 start 不清用户浏览器 cookie` PASS（重连后 `document.cookie` 仍含重置前写入的键、`mode === 'cdp'`、`reused === false`），exit 0、`FAIL 0`。
7. `node tests/reclaim.mjs`：用例名 `显式 close 仍然生效` 与 `超时后 Edge 主进程已回落` 均 PASS，exit 0、`FAIL 0`（证明重置没有改动回收口径）。
8. `node tests/tools.mjs`：用例 3B 的 `reload 后旧 console 记录不再出现` 与 `reload 后新文档自身请求保留（document + 子请求）` 均 PASS，exit 0、`FAIL 0`（证明事件环重置仍由 `navigate` 承担）。
9. `node tests/multitab.mjs`：用例名 `t1 的 ref 在 t2 上失效` PASS，exit 0、`FAIL 0`（证明 ref 表仍按页隔离、不跨页残留）。
10. `npm run test:unit` exit 0、无 `FAIL`；`npm run test:integration` 串行执行 exit 0、无 `FAIL`。
