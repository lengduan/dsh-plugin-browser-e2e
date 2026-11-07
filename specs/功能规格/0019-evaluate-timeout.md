# evaluate 超时终止

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/page.js` 职责；P3「运行时」类错误；进程回收口径与空闲计时）；specs/项目规格/0002-panel-protocol-v1.md（工具失败只经既有 `action` 事件上报，不改协议）；specs/功能规格/0012-snapshot-delta-query-frame.md（页面脚本超时的既有已知限制，本项不改变 snapshot 行为）
代码: lib/page.js / lib/tools.js / tests/tools.mjs / tests/cdp.mjs / tests/multitab.mjs

## 需求

页面内死循环、或表达式返回一个永不 resolve 的 Promise 时，`browser_e2e_evaluate` 现在会一直挂住：Playwright 的 `page.evaluate` 没有 timeout 选项，`lib/page.js` 的 `evaluate` 只能等页面自己结束。默认空闲回收（`DSH_BROWSER_IDLE_MS`，600000ms）到点才会因回收关掉浏览器而让调用失败，设 0 时永久挂起。给 evaluate 一个执行上限，到点中断页内脚本并报错，页面与会话保持可用。

## 行为

### 输入

- 工具 `browser_e2e_evaluate` 新增可选参数 `timeoutMs`：`integer`，允许区间 `1000`-`120000`（含两端），默认 `30000`；`expression` 仍必填，`tab_id` 语义不变（缺省当前 active tab）。
- 能力函数 `lib/page.js` 的 `evaluate` 增加第四个参数 `options = {}`（只读 `options.timeoutMs`）；既有 `evaluate(session, expression, tabId)` 调用逐字兼容。
- 默认值、下限、上限只来自 `lib/page.js` 的三个导出常量 `DEFAULT_EVALUATE_TIMEOUT_MS`（30000）、`MIN_EVALUATE_TIMEOUT_MS`（1000）、`MAX_EVALUATE_TIMEOUT_MS`（120000）；工具描述与错误文案从常量插值，不另写字面量。
- 非法值统一抛错，不静默 clamp：`timeoutMs 必须是 1000 到 120000 之间的整数（毫秒），收到 ${timeoutMs}`。

### 输出

- 成功：返回 `{ value, elapsedMs, timeoutMs, summary }`。`summary` 文案与现在一致（`求值 JS 表达式（返回 ${type}）`）；`elapsedMs` 从发起 `page.evaluate` 到该次求值结束（含返回值的可序列化判定前），不含取页与校验入参的时间。
- 超时且中断命令已下发成功，抛错：
  `脚本执行超时：实际执行 ${elapsedMs}ms（上限 ${timeoutMs}ms）；已中断页面主线程正在执行的脚本，页面与标签页保持打开。等待永不返回的 Promise 不会被中断；如脚本本应更久，请提高 timeoutMs（上限 120000）后重试`
- 超时且中断命令下发失败，抛错：
  `脚本执行超时：实际执行 ${elapsedMs}ms（上限 ${timeoutMs}ms）；未能中断页面内脚本（${reason}），页面可能仍在执行该脚本；请重新 browser_e2e_snapshot 确认页面状态，或 browser_e2e_close 后重开浏览器`
  `reason` 为底层错误消息的前 200 个字符。
- 非超时的求值错误（页面已关闭、表达式语法错误、返回值不可序列化等）原样抛出，不包装成超时。
- 工具层失败仍由 `lib/index.js` 的 `execute` 捕获并广播一条面板 `action` 事件（摘要 `失败：<上面的文案>`），不改 `lib/protocol.js` 的事件形状与错误码表。

### 状态变化

- 会话：保持 `ready`，不触发状态转移；不新增 `lib/invariants.js` 断言（超时是运行时结果，重试可自愈）。
- 标签页：目标页不关闭、不导航；`refs`、`consoleRing`、`networkRing`、`networkByRequest` 都不清空。中断只作用于该页主线程当前正在执行的脚本，DOM 可能停在脚本中途修改的状态。
- 面板：收到一条失败 `action` 摘要；tab 列表、投屏目标、面板配置都不变。
- 浏览器进程：isolated 不重启、不关闭；CDP 接管只断连的既有口径不变（本项只发 CDP 命令，不碰连接生命周期）。

## 边界

- 只中断目标页主线程当前正在执行的那段脚本。Worker、Service Worker、跨源 iframe 与同源子 frame 内的死循环是否被中断未验证；本项不承诺覆盖。
- 表达式可以返回 Promise（Playwright 会等它 resolve）：这类「等待中」的求值没有正在执行的脚本，`Runtime.terminateExecution` 不会让页内 Promise 结束。宿主仍按 `timeoutMs` 返回超时错误；页内 Promise 会继续 pending，直到它自己完成、页面导航或页面关闭。
- 「中断成功」只表示 CDP 命令已成功下发并中断了当前执行，不表示页面里所有脚本都已停止；文案已按这个口径写。
- 中断命令依赖求值前先行建立的 CDP 会话：发起 `page.evaluate` 之前用 `page.context().newCDPSession(page)` 建好会话，超时后下发 `Runtime.terminateExecution` 再 detach；不能在超时到点后再新建会话（页面主线程死循环时新建与下发都会排队不返回，实测已证）。页面已崩溃或已关闭时会失败，此时仍返回超时错误并带「未能中断」。
- 中断可能打断页面自己的事件处理或框架渲染，留下半完成的 DOM；本项不自动重新 snapshot、不回滚 DOM，需要时由调用方重新 `browser_e2e_snapshot`。
- 空闲回收竞态：若 `DSH_BROWSER_IDLE_MS` 小于 `timeoutMs`，浏览器可能在超时前被回收，该次调用随后报「浏览器尚未启动或没有可用标签页」。与 `0001` 已记录的 `browser_e2e_wait` 同类边界，规避方式相同（设 0 或大于单次调用时长）。
- CDP 接管模式下中断会打断用户浏览器里该页正在执行的脚本；这是接管既有语义的延伸，不新增确认步骤。
- 不处理：`expression` 长度上限（保持现状无上限）、返回值体积上限（保持现有 `JSON.stringify` 兜底）、超时后自动重试、给 `snapshot` 的内部页面脚本加终止（`0012` 的「页面脚本无法被终止」保持不变）。

## 验收

1. `node tests/tools.mjs`：用例名 `evaluate 默认/下限/上限常量与工具描述一致` PASS，进程 exit 0、输出 `FAIL 0`。
2. `node tests/tools.mjs`：用例名 `evaluate 正常表达式返回结果且不触发超时` PASS（`value` 正确、`elapsedMs` 为整数且小于 `timeoutMs`），exit 0、`FAIL 0`。
3. `node tests/tools.mjs`：用例名 `evaluate 死循环在 timeoutMs 到点返回超时错误` PASS（错误含 `脚本执行超时` 与 `实际执行`，耗时落在 1000ms 到 5000ms 之间），exit 0、`FAIL 0`。
4. `node tests/tools.mjs`：用例名 `evaluate 超时文案包含已中断与页面保持打开` PASS（含 `已中断页面主线程正在执行的脚本` 与 `页面与标签页保持打开`），exit 0、`FAIL 0`。
5. `node tests/tools.mjs`：用例名 `evaluate 超时后同一页面仍可继续求值` PASS（紧接着求值 `document.title` 返回字符串），exit 0、`FAIL 0`。
6. `node tests/tools.mjs`：用例名 `evaluate 超时后页面定时器仍在运行` PASS（超时前启动的 `setInterval` 计数继续增长），exit 0、`FAIL 0`。
7. `node tests/tools.mjs`：用例名 `evaluate 永不 resolve 的 await 按时返回超时错误` PASS（错误含 `脚本执行超时`，且外部保险计时器未先触发），exit 0、`FAIL 0`。
8. `node tests/tools.mjs`：用例名 `evaluate timeoutMs 低于下限/高于上限/非整数分别报错` PASS（三次错误都含 `timeoutMs 必须是 1000 到 120000 之间的整数`），exit 0、`FAIL 0`。
9. `node tests/tools.mjs`：用例名 `browser_e2e_evaluate 工具透传 timeoutMs 并声明 integer 参数` PASS（工具 `execute` 抛超时错、`parameters.properties.timeoutMs.type === 'integer'`、`required` 仍只有 `expression`），exit 0、`FAIL 0`。
10. `node tests/cdp.mjs`：用例名 `CDP 模式 evaluate 死循环超时后页面仍可求值` PASS，exit 0、`FAIL 0`。
11. `node tests/multitab.mjs`：用例名 `一个 tab 的 evaluate 超时不影响另一个 tab` PASS，exit 0、`FAIL 0`。
12. `npm run test:unit` exit 0；`npm run test:integration` exit 0（串行执行，两者的 `FAIL` 计数都为 0）。
