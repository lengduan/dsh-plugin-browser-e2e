# 浏览器实例池与每会话隔离 context

状态: 已实现
关联: 项目规格 0001-architecture-invariants.md（模块边界与依赖方向）；0021-session-reset.md（会话重置）；0040-freeze-animations.md（动画冻结，与本文正交）
代码: lib/pool.js / lib/session.js / lib/page.js / lib/invariants.js / lib/doctor.js / tests/pool.mjs / tests/pool-sessions.mjs

## 需求

每个会话各起一个浏览器时，实测 4 个实例 = 35 个进程 / 1940 MB / 空闲 6.7% 单核；
1 个实例 + 4 个隔离 context = 12 个进程 / 748 MB / 空闲 0.5% 单核。
省的是**进程数与内存**（约 -1.2 GB / -23 进程），CPU 那一半由 `freezeAnimations`（功能规格 0040）负责，两者正交。

因此把「浏览器进程」与「会话」解耦：**进程共享，状态隔离**。多个会话共用同一个无头浏览器进程，
每个会话持有一个自己的 `BrowserContext`（Playwright 的隔离存储分区）。

## 行为

### 池的契约（`lib/pool.js`）

| 导出 | 语义 |
|---|---|
| `acquire(options)` | 申请一份使用权。该启动签名下没有浏览器就拉起，有就复用；并发调用共用同一个 `launchTask`，不会并行拉第二个。返回 `{ browser, reused, launchCount, signature }` |
| `release(signature)` | 归还一份使用权。租约归零才装池级空闲计时，**不立即关浏览器** |
| `abandon(signature)` | 归还租约，并在租约归零时**立刻**收掉浏览器（启动失败路径用：那一轮已经把浏览器拉起来了，但会话没建成） |
| `shutdown(reason)` | 立刻关掉所有槽的共享浏览器（插件卸载、测试收尾） |
| `poolStats()` | 只读快照：`state` / `hasBrowser` / `leases` / `launchCount` / `idleArmed` / `slots` |
| `onBrowserGone(listener)` | 订阅「共享浏览器意外断开」（崩溃 / 被外部结束） |
| `signatureOf(options)` | 启动签名：只有 `headless` / `proxy` / `channel` / `executablePath` / `userDataDir` 参与 |
| `resetPoolForTest()` | 仅测试用：清计时器与状态，不关浏览器 |

**按启动签名分槽**：`browser_e2e_start` 的 `headless` / `proxy` / `carrier` 是逐次调用参数，
不同会话合法地可以要求不同形态的浏览器（一个 headless 一个可见、或 edge 与 chrome 并存）。
同签名共享一个浏览器进程（这才是池化的收益），不同签名各占一个槽，互不复用也不互相报错。
视口与登录态属于 context 级，**不进签名**。

池级空闲：某槽租约归零后（该浏览器的**所有 context 都已关闭**）`DSH_BROWSER_POOL_IDLE_MS`（默认 120000ms，上限 600000ms）到点关掉该槽的浏览器。
  - `0` 表示**立即回收**：租约一归零就关，不等计时器（省内存优先）。
  - 非法值（非数字、负数、空白串）一律**改写成 0**，即同样立即回收；不再静默降级成「永不回收」
    ——那会把一个环境变量笔误变成内存与进程永不释放。解析规则见 `resolvePoolIdleMs()`。
默认比会话级 `DSH_BROWSER_IDLE_MS`（10 分钟）短：context 都空了说明这一轮用完，留一个空转的浏览器没有意义。

**两个空闲时限的对照**（都取 0 时都是「立即关闭」，区别在触发点）：

| 环境变量 | 管什么 | 触发点 | 范围 | 默认 |
|---|---|---|---|---|
| `DSH_BROWSER_IDLE_MS` | 会话的隔离 context | 该会话无调用满时限 | 60000–600000（**下限 1 分钟**，见下） | 600000（10 分钟） |
| `DSH_BROWSER_POOL_IDLE_MS` | 共享的无头浏览器进程 | 该浏览器**最后一个 context 关闭**（租约归零）后 | 0–600000（**上限 10 分钟**） | 120000（2 分钟） |

context 级下限 1 分钟的理由：`touchSession()` 在**操作开始时**就装计时器，操作本身可能 await 数秒；
时限过小会在操作过程中把 context 关掉，表现出来就是「工具调用中途报浏览器未启动」。
上限 10 分钟同理，防止误配一个巨大值让 process 永不回收。

### 会话的契约（`lib/session.js` / `lib/page.js`）

- isolated 启动：`pool.acquire()` → `browser.newContext({ storageState, viewport })`。
  `session.browser` 指向**共享**浏览器实例，`session.context` 指向**本会话自己的**隔离 context。
- `browser_e2e_close`（`close(key)`）：只 `session.context.close()` 并归还租约，**不关共享浏览器**。
  文案为「已关闭本会话的浏览器上下文」。最后一个租约归还后浏览器由池空闲回收关闭。
- `page.js` 的临时页（`createTransientPage`）一律走 `session.context.newPage()`：
  池化后会话与浏览器不再一一对应，在共享浏览器上 `browser.newPage` 会开出**不属于任何会话**的孤儿 context。
- `assertBrowserRunning` 在 isolated + `ready` 时额外要求 `session.context` 非空：
  浏览器在、页也在但本会话的 context 已被关掉时，报可诊断的「尚未启动」而不是 `Target closed`。
- 共享浏览器意外断开时，池广播 `onBrowserGone`，会话层把所有持有它的会话一并 `close` 掉（风险 R1）。
  主动 `shutdown` 不广播。

### 不池化的部分

**CDP 模式不池化**（决策 D6）：接管的是用户自己的浏览器，进程不属于插件，维持原路径。
`browser_e2e_start` / `browser_e2e_close` 的参数与文案除 `close` 的摘要外全部不变（决策 D2）；
**不引入浏览器 ID / 句柄的对外契约**（决策 D3）：`sessionKey(exec)` 已能定位调用方，隔离 context 内部按会话记即可。

## 边界

- **`session.browser` 字段不能删**：`invariants.js` / `page.js` / `session.js` / `snapshot.js` / `tools.js` 都读它，
  只能改指向（从「本会话独有」改为「共享实例」）。
- **一个会话 close 不影响别的会话**：这是本规格最重要的一条。已在 `tests/pool-sessions.mjs` 用例 3 实测
  （A 关闭后 B 仍能导航与求值、cookie / localStorage 互不可见）。
- **启动失败必须收掉自己拉起的浏览器**：走 `abandon` 以便没人使用时立刻关闭；否则它会空转到池级空闲计时，
  且后续 `acquire` 会把它当「可复用」借出去（实测会让注入假 chromium 的用例连坐 11 条）。
- **关闭与 acquire 的竞态**：`shutdownSlot` **先摘槽再关进程**。否则关闭期间的新 `acquire` 会拿到正在死的槽，
  把即将关掉的浏览器借出去，调用方立刻失效（实测表现为「两次 launch 报 reused=false 却只起一个浏览器」）。
- **`reused` 是会话级而非池级**：两个会话各自首次启动时都返回 `reused=false`，即使它们共享同一个浏览器进程。
  对外契约不变（决策 D2），调用方不应据此判断进程数。
- **context.close 不保证存在**：测试注入的假 context 可能没有 `close`，关闭路径用 `context.close?.()` 兜住。
- **探针 / 诊断不创建状态**：`poolStats()` 与 doctor 的 `pool` 项都是只读，不给浏览器续命。
- **跨平台**：池本身跨平台；本规格覆盖的隔离 context 行为与 `freezeAnimations` 一样与平台无关。

## 验收

- `node tests/pool.mjs` —— 39 项纯逻辑用例（假 launch 注入，不启真浏览器）：首次拉起 / 复用 / 并发合流 /
  租约与空闲计时 / 分签名分槽 / **两会话共享浏览器且关一个不影响另一个** / 意外断开广播 / 主动关闭不广播。
- `node tests/pool-sessions.mjs` —— 28 项真机用例：两会话共享同一浏览器实例、各自 context 不同、
  登录态互不可见、close A 后 B 仍可导航与求值、重新 start 得到干净 context、
  全部 close 后租约归零且池级空闲到点才关浏览器、context 级空闲到期只关自己。
- `node tests/reclaim.mjs` —— 27 项：空闲回收与 `session/disposed` 两条路径都断言「会话不再持有 context」
  与「池关掉了共享浏览器」。
- `node tests/invariants.mjs` —— 90 项：状态机、启动失败清理、关闭兜底。
- `node tests/doctor.mjs` —— 32 项：报告固定七项，含池状态一行。
- 回归：`assert` / `clipboard` / `dialog` / `download` / `fetch` / `follow` / `frames` / `human` /
  `raw-http` / `read` / `recipe` / `snapshot` / `upload` / `wait` / `click-press` / `auth-state` /
  `screencast` / `freeze` / `multitab` / `session-reset` / `carrier` / `panel` / `tools` 全部绿。

## 已知局限

- **共享浏览器崩溃会同时影响所有会话**（现状下不会）。已按风险 R1 处理：广播断开并摘除所有持有它的会话，
  但不做自动重启（重启会让所有会话静默换进程，代价更高）。
- **进程数不再等于会话数**：任何按「msedge 主进程数」判断「有没有泄漏」的脚本都要改成看 `poolStats()`
  或 `activeSessionKeys()`。本规格实施时已把 `tests/reclaim.mjs` 的判据同步改掉。
- **不同启动签名会各自留一个浏览器进程**：例如同时有 headless 与可见浏览器时进程数是 2 而不是 1。
  这是保留逐次调用参数自由的代价，不是泄漏。
- **未实测**：池在真实多会话高并发（>2 会话同时 start / close）下的行为只做了 2 会话与并发合流用例，
  没有压测。
## profile 目录：账户锁定防护的第一层（步骤 6）

`pool` 改用 `launchPersistentContext`，把每个槽的 profile 落在磁盘上，目的是让 Chromium 跳过「空密码探测
Windows 登录接口」这一步——那里每轮都会记一笔 4625 登录失败，本机策略 10 次 / 14 分钟即锁账户。

| 项 | 取值 / 语义 |
|---|---|
| 目录根 | `~/.dsh/browser-e2e/browser-profile/`，`DSH_BROWSER_E2E_HOME` 可改 |
| 槽目录 | 按启动签名分：`<headless|visible>-<edge|chrome>-<hash8>`。**Chromium 独占 user-data-dir**：实测第二个实例用同一目录直接报 `Target page, context or browser has been closed` |
| 常驻 | 不随池 shutdown / 空闲回收删除（决策 D13）。收益公式因此是「每次槽生命周期最多一次 4625」 |
| 哨兵值 | 启动前把 `password_manager.os_password_last_changed` 写成 `9223372036854775807`（字符串），启动后由 Chromium 改写成真实值。这是验收判据，无需管理员 |
| 合并写入 | 只动 `password_manager` 段，其余 30+ 个 Chromium 状态字段原样保留；损坏的 JSON 备份为 `.corrupt` 后重建 |

### 锁屏闸门

只在**真正拉起进程**的分支执行（复用路径不检测）。

- `UNKNOWN`（探针读不到前台桌面等）与「探针不可用」（非 Windows / 缺 exe / 超时）是两种降级，**都不阻塞启动**。
- `LOCKED` 时**默认尝试安全启动**（profile 已预置标记，理论上不再产生 4625）；仅当 profile 目录写不进去时才拒绝并说明原因（决策 D11）。

### `--disable-features` 合并

Playwright 先放默认 15 项、再追加用户 args，是两个独立开关；「重复开关取哪个」无权威结论。
因此 `mergeDisabledFeatures()` 把**默认 15 项 + 我们的 2 项**拼成**单一开关**放在最后，
无论 Chromium 取首个还是末个，结果一致。
## 复核发现与修正（步骤 7 独立复核）

第三轮独立复核（三个只读子代理）提出并已修正：

| 问题 | 位置 | 修正 |
|---|---|---|
| 并发合流分支返回未归一的 `BrowserContext`（无 `newContext`/`version`），并发第二个会话必然失败 | `lib/pool.js:164-169` | 与常规复用分支同样归一成 `Browser`，已实测两条都拿到完整 Browser |
| `disableFeatures` 无调用方，`--disable-features` 整条是死代码 | `lib/pool.js:193` / `lib/session.js` | `session.js` 的 `poolAcquire` 显式传 `EXTRA_DISABLED_FEATURES` |
| 手抄的「Playwright 默认 15 项」与实际依赖有 2 增 2 漏 | `lib/pool.js` | 按 `playwright-core@1.63.0` 的 `coreBundle.js` 逐字对齐（15 项），并留 `.scratch/extract-features.mjs` 供升级后核对 |
| `native/` 不在 `package.json` 的 `files` 里，发布形态下锁屏闸门静默失效 | `package.json` | `files` 加入 `native/lockscreen` |
| 锁屏闸门的「安全启动可用」判据是「刚写过没报错」，与调用方重复且必然成功 | `lib/pool.js:409-416` | 改为回读实际值，标记缺失才拒绝 |
| `password_manager` 非对象时整体替换，静默丢字段 | `lib/browser-profile.js:126-129` | 原值保留到 `password_manager_original` |
| 多条测试断言恒真或方向相反（`launchCount >= 2`、只断言后值、`typeof === 'string'` 等） | `tests/pool.mjs` / `pool-sessions.mjs` / `reclaim.mjs` | 补前值断言、改前后差、真传 viewport；`launchCount` 判据取「合计最多拉起一次」 |

**测试断言复核的后续补强（第二轮）**：

| 位置 | 原问题 | 修正 |
|---|---|---|
| `tests/freeze.mjs` | `made.created === true` 是字面量恒真；`afterNav.running === 0` 因页面本来没动画而平凡真 | 加阴性对照（同一脚本在未冻结页必须 `running >= 1`）；并把「冻结页上新造动画仍 running」固定成显式断言 |
| `tests/session-reset.mjs` | 池化后零池状态断言，close 漏 `release` 完全测不出 | 补 3 条：重置前 2 份租约、close 后回 1、close+start 后回 2（非 3） |
| `tests/multitab.mjs` | `typeof info.summary === 'string'` 恒真 | 改为「首次不复用 + 只持 1 份租约 + 单槽」 |

**仍未消除的已知局限**：

- `tests/browser-profile.mjs` 的「池记录了 Local State 已被消费」一条判据仍是「浏览器非空」，`slot.localStateConsumed` 无读取方；真正的判据在下一行「哨兵值被改写」，那条有效。
- `freezeAnimations` 拦不住导航后**新造**的动画（见功能规格 0040 的「已知局限」，已实测确认并写成断言）。
- 进程计数类测试互相争抢 profile，`reclaim` 与 `pool-sessions` 并发跑会同时崩溃，必须串行。
- `page.js` 的 `createTransientPage` 没有直接测试文件（全库 grep 无命中），其跨会话隔离只经 `tests/pool-sessions.mjs` 间接覆盖。
第二轮复核追加修正（同一批复核员深挖后）：

| 问题 | 位置 | 修正 |
|---|---|---|
| 启动失败 / 启动中被 close 且 context 未建时，直接 `closeBrowser(session.browser)`，而它是共享实例 → 连带打死同签名的其它会话 | `lib/session.js:963,989` | 改走 `abandonSessionContext`（归还租约，租约归零才由池关） |
| `persistent.close()` 失败被 `.catch(() => {})` 吞掉，`shutdownSlot` 仍报 `closed:true` | `lib/pool.js:317` | 记 `closeFailed` 并如实返回；`shutdown()` 透传该字段 |
| `launching` 期间被 `shutdown` 摘槽，launch 落定后浏览器无人持有（直到进程退出） | `lib/pool.js:217-224` | 落定后检查槽是否还在 Map 里，不在就当场 close 并让本次 acquire 报错 |

新增用例覆盖上述分支：`tests/pool.mjs` 用例 14（启动中途 shutdown 不留孤儿 + 池内为空）、用例 15（关闭失败 closed 如实为 false），共 44 PASS。