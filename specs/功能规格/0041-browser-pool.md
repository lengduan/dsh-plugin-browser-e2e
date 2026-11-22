# 浏览器实例池与每会话隔离 context

状态: 已实现
关联: 项目规格 0001-architecture-invariants.md（模块边界与依赖方向）；0020-session-reset.md（会话重置）；0040-animation-freeze.md（动画冻结，与本文正交）
代码: lib/pool.js / lib/session.js / lib/page.js / lib/invariants.js / lib/doctor.js / tests/pool.mjs / tests/pool-sessions.mjs / tests/pool-idle-zero.mjs / tests/idle-bounds.mjs

## 需求

每个会话各起一个浏览器时，实测 4 个实例 = 35 个进程 / 1940 MB / 空闲 6.7% 单核；
1 个实例 + 4 个隔离 context = 12 个进程 / 748 MB / 空闲 0.5% 单核。
省的是**进程数与内存**（约 -1.2 GB / -23 进程），CPU 那一半由 `freezeAnimations`（功能规格 0040）负责，两者正交。

因此把「浏览器进程」与「会话」解耦：**进程共享，状态隔离**。多个会话共用同一个无头浏览器进程，
每个会话持有一个自己的 `BrowserContext`（Playwright 的隔离存储分区）。

池**不感知**动画守护：两者正交——池按浏览器进程分槽，守护按 page 装、按会话开关（见 0040）。

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


## 决策记录（空闲回收语义）

本规格最初只写了两个空闲时限的默认值，没规定 `0`、非法值与边界。以下条目是实施后由用户逐条确认的补充决策，
正文「两个空闲时限的对照」表与 `resolveIdleMs()` / `resolvePoolIdleMs()` 的实现都以本节为准。

| # | 决策 | 来源 |
|---|---|---|
| D4 | 每个 context 单独空闲监听，沿用 `IDLE_CLOSE_MS`（默认 10 分钟） | 计划 D4，用户 m2492 |
| **D4-a** | `DSH_BROWSER_IDLE_MS` 加**下限 60000ms**：避免计时器在操作中途把 context 关掉 | 用户 m4819 |
| **D4-b** | `DSH_BROWSER_IDLE_MS` 加**上限 600000ms**，默认 600000 | 用户 m4819 |
| **D4-c** | `DSH_BROWSER_IDLE_MS` 非法值回落默认值（不再出现 NaN → 计时器立刻触发） | 加边界时的推论，与 D5-b 对齐 |
| D5 | 池级空闲 `DSH_BROWSER_POOL_IDLE_MS`，默认 120000ms | 计划 D5，用户 m2552 |
| **D5-a** | 池级 `0` 表示**立即回收**（原实现为「关闭池级回收」→ 进程永不释放） | 用户 m3138 |
| **D5-b** | 池级非法值一律**改写成 0**（同样立即回收），不再静默降级成「永不回收」 | 用户 m3138 |
| **D5-c** | 池级加**上限 600000ms**（10 分钟），默认 120000（2 分钟） | 用户 m4819 |
| **D4-d / D5-d** | 用户的原始意图是「两个时限取 `0` 都立即关闭，区别只在触发点」。加了 D4-a 的下限后，**只有池级真的立即关**；context 级的 `0` 会被抬到 60000ms。见下「决策变更的原因」第三节 | 用户 m4678，被 D4-a 覆盖 |

### 决策变更的原因

规格最初给两个时限都定了默认值，但没定义 `0` 与边界。实施后改了两处语义，原因不同，不能混为一谈。

#### 一、context 级：从「允许设 0」改为「夹在上下限之间」

**原因：context 的空闲判断不可靠，设小会在操作中途误关。**

会话层的空闲回收靠 `touchSession()` 续期，而它在**操作开始时**装计时器——问题是操作本身会 await：

- `tabs()` 刷新计时后还要逐页读 `url()` / `title`；
- `navigate` / `snapshot` / `evaluate` 等一次调用可能耗时数秒。

也就是说 API 层面**无法可靠知道「这个 context 现在是否真的空闲」**：我们只能在调用开始时打一个时间戳，
无法得知调用是否已经结束。时限设得比单次操作短，计时器就会在工具调用进行到一半时把 context 关掉，
对外表现为「工具调用中途报浏览器未启动」，而这种失败时机对使用者极难理解。

既然「精确检测空闲」做不到，就只能**用边界兜底**：下限 60000ms 保证单个操作不会被打断，
上限 600000ms 防止误配一个巨大值让 context 永不回收。这就是把 `0` 从「合法关闭回收」改成「抬到下限」的原因。

#### 二、池级：从「`0` = 永不关闭」改为「`0` = 立即关闭」

**原因：没必要一直放在内存里；重启一个无头浏览器的代价可以接受。**

浏览器进程没有「操作进行中」这层歧义——它的空闲判据是确定的（该签名的**租约归零**，即所有 context 都关完了），
所以可以放心地设成「租约一归零就关」。原实现把 `0` 当作「关闭空闲回收」，等于让一个没人使用的浏览器
常驻内存直到 DSH 服务重启，收益为零、成本是实实在在的常驻内存与进程。

重启代价实测（本机，`tests/reclaim.mjs` 同口径的无头 Edge）：

| 场景 | 耗时 |
|---|---|
| 冷启动浏览器 + 建会话 + 首屏导航 | 约 4.5 s |
| 会话复用（浏览器已在） | 约 0.6 s |
| **关掉浏览器后重新拉起** | **约 3.0 s** |

3 秒的冷启动换来的是「没人用就立刻释放内存与进程」。对这个插件来说这是划算的：
`browser_e2e_*` 是交互式验证工具，两次使用之间通常隔了很久，让浏览器空转没有意义；
真需要连续使用时，连续调用之间租约不会归零，浏览器也不会被关。

实测（`DSH_BROWSER_POOL_IDLE_MS=0`，两个会话共享一个浏览器）：

| 步骤 | `poolStats().hasBrowser` | 说明 |
|---|---|---|
| 两个会话都 start | `true`（leases=2） | 浏览器在，两个租约 |
| 关掉会话 A | `true`（leases=1） | **没有误关**：租约未归零 |
| 会话 B 再开一页并导航 | 成功 | 浏览器确实还能用 |
| 关掉会话 B（租约归零） | `false` | 立即回收 |

这条是 `0` 敢设成「立即回收」的关键前提：触发点是租约归零而非单次 `close`，
所以多会话场景下不会因为某一个会话结束就把别人正在用的浏览器关掉。

#### 三、两条原因叠加后的最终结果

用户最初的意图（D4-d / D5-d）是「两个时限取 `0` 都立即关闭，区别只在触发点」。
但 D4-a 给 context 加了 1 分钟下限之后，这个意图**只有池级还能成立**：

| | context 级 | 池级 |
|---|---|---|
| 空闲判据 | 该会话**无调用**满时限（靠 `touchSession` 续期，判据不可靠） | 该浏览器**租约归零**（所有 context 都关完，判据确定） |
| `0` 的实际效果 | **抬到下限 60000ms**，不是立即关 | **立即关**（租约归零当刻） |
| 为什么不照字面立即关 | 会在操作中途误关（第一节） | 无歧义，且重启代价小（第二节） |

这是两条要求冲突后**有意选择的取舍**：宁可让 context 的 `0` 不符合字面直觉，
也不接受「工具调用中途浏览器被关掉」这种难以排查的失败。实现见 `resolveIdleMs()`
（`lib/session.js`）与 `resolvePoolIdleMs()`（`lib/pool.js`），验收见 `tests/idle-bounds.mjs`。

### 两个时限的取值语义速查

| 输入 | `DSH_BROWSER_IDLE_MS`（context） | `DSH_BROWSER_POOL_IDLE_MS`（浏览器） |
|---|---|---|
| 不设 | 600000 | 120000 |
| `0` | 60000（抬到下限） | 0（立即回收） |
| `1` / `59999` | 60000 | 原值 |
| `300000` | 300000 | 300000 |
| `9999999` | 600000（压到上限） | 600000（压到上限） |
| `abc` / `-5` / 空白串 | 600000（回落默认） | 0（立即回收） |

### 测试专用开关

`DSH_BROWSER_IDLE_MS_MIN_OVERRIDE` 只给测试用：把 context 级下限临时放宽，好让「空闲到点会回收」的用例
在几秒内跑完而不是真等 60 秒（`tests/reclaim.mjs` 用例 A / F 依赖它）。**生产环境不设此变量，下限仍是 60 秒。**

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

- `node tests/pool.mjs` —— 58 项纯逻辑用例（假 launch 注入，不启真浏览器）：首次拉起 / 复用 / 并发合流 /
  租约与空闲计时 / 分签名分槽 / **两会话共享浏览器且关一个不影响另一个** / 意外断开广播 / 主动关闭不广播 /
  启动中被 shutdown 不留孤儿浏览器 / 关闭失败如实报告 / `resolvePoolIdleMs()` 解析规则。
- `node tests/pool-idle-zero.mjs` —— 23 项：池级 `0` 与各类非法值的端到端语义（每种子进程加载一次池，
  含阴性对照「30ms 到点确实关」）。
- `node tests/idle-bounds.mjs` —— 23 项：两个空闲时限的边界与非法值处理（14 种取值 × 子进程）。
- `node tests/pool-sessions.mjs` —— 28 项真机用例：两会话共享同一浏览器实例、各自 context 不同、
  登录态互不可见、close A 后 B 仍可导航与求值、重新 start 得到干净 context、
  全部 close 后租约归零且池级空闲到点才关浏览器、context 级空闲到期只关自己。
- `node tests/pool-concurrency.mjs` —— 48 项真机用例（多会话并发调度）：走真实工具表 `run`、
  用不同 `exec.agent.id` 模拟独立会话。4 会话并发 start 只冷启 1 次 / 4 会话并发完整工作流且登录态互不可见 /
  并发中关 2 个会话不影响其余 / 关闭后重启得干净 context / 8 会话并发压测 / 启动中并发 close 的竞态 /
  池级空闲窗口内接入复用并取消计时 / 共享浏览器被杀后多会话一并收尾且能各自重启 / 不同签名各占一槽。
  内部以子进程拉起 `tests/pool-concurrency-child.mjs`（池级时限在模块导入时读定，同进程改环境变量无效）。
- `node tests/reclaim.mjs` —— 27 项：空闲回收与 `session/disposed` 两条路径都断言「会话不再持有 context」
  与「池关掉了共享浏览器」；用例 A 用子进程 + `DSH_BROWSER_IDLE_MS_MIN_OVERRIDE` 跑等效 300ms 空闲
  （真等 60 秒不现实），用例 F 覆盖「空闲时限小于启动耗时」的竞态。
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
- **多会话高并发：已实测（2026-11-22，`tests/pool-concurrency.mjs`）**，取代原先的「>2 会话同时 start / close 未实测」。
  走真实工具表（`buildToolTable` 的 `run`，即 DSH 里多会话使用插件的真实入口）+ 真起无头 Edge + 本地真实网页负载，
  用不同 `exec.agent.id` 模拟独立会话。48 项断言全绿，覆盖：4 会话并发 start（只冷启 1 次）、
  4 会话并发跑完整工作流（导航 / 求值 / 快照 / 结构读，cookie 与 localStorage 互不串味）、
  并发中关 2 个会话而剩余会话不受影响、关闭后重启拿到干净 context、
  8 会话并发压测（仍只冷启 1 次、8 份租约、各自隔离）、启动中并发 close 的竞态、
  池级空闲窗口内新会话接入（复用并取消计时）、共享浏览器被外部杀掉后多会话一并收尾且能各自重启、
  不同启动签名各占一槽。**调度结论：未发现调度缺陷。**
  仍未覆盖：CDP 模式（决策 D6 不池化）与跨进程多 DSH 实例共享同一个池（池是进程内单例）。
- **账户锁定防护：已实测（两轮、含锁屏），结论是「实验无效」**（2026-11-21，见上文「4625 实测结论」）。
  第二轮专在锁屏（`LOCKED`）下跑，A 臂 2 次 + B 臂 3 次，**按 PID 归属全部 0 条 4625**；第一轮未锁屏也是 0 条。
  阳性对照在两种条件下都没起来，因此**无法判定防护有效或无效**。这条取代了原先的
  「未实测：账户锁定防护是否真的不再产生 4625」。
- **4625 观测本身依赖提权**：本机默认账户不在管理员组，`Get-WinEvent -LogName Security` 报
  「Attempted to perform an unauthorized operation」；而 `-FilterHashtable` 在无权限时返回的
  「找不到与指定的选择条件匹配的事件」与「窗口内确实 0 条」**在消息层面无法区分**。
  `.scratch/read-4625.ps1` 因此把非管理员下的空结果一律判为 `PERMISSION_DENIED`，不猜成 0 条。
- **防护是否有效仍未证实，且判据本身存疑**：两轮共 8 次启动（第二轮锁屏下 5 次）都没有 4625，
  连阳性对照都起不来。这意味着「本插件的启动路径会稳定产生 4625」这个**隐含前提本身可能不成立**，
  而不是「防护生效」。真正被证伪的是这个前提；防护的必要性取决于机器上实际打出的那些 4625
  （来自其它 DSH 会话 / 其它 Edge 实例）是否与本插件同源——这点仍未测明。
- **当前定位（2026-11-21 决定）：保留实现，但不声称有效。** 三个选项是「保留但降级 / 去掉改用
  chromium.launch / 先查清既有 4625 来源」；选第一条的理由是成本极低（一个常驻 profile 目录 +
  一层启动逻辑，风险为零），而删掉要重跑进程类测试、且若那些 4625 确与浏览器有关风险会回来。
  代价是这份防护的真实价值仍是**未知**而非「已验证」。要转向「验证」，唯一的路是查清本机既有
  msedge 4625 的来源（那需要按 `authPackage` / `logonProcess` 深挖，本轮未做）。
- **4625 归属必须按 PID，不能按时间窗**：本机同时有其它 DSH 会话在调 `browser_e2e_start`，
  实测按时间窗判断会把别人的 4625 算到自己头上（第二轮就发生了：3 条 4625 的 PID 24580 / 11284 / 27384
  都不属于本实验）。`.scratch/ab-locked.mjs` 因此记录启动前后的 Edge 主进程 PID 集合，
  用差集定出本次启动的 PID，再与 4625 的 `ProcessId` 字段逐条比对。
## profile 目录：账户锁定防护的第一层（步骤 6）

`pool` 改用 `launchPersistentContext`，把每个槽的 profile 落在磁盘上，目的是让 Chromium 跳过「空密码探测
Windows 登录接口」这一步——那里每轮都会记一笔 4625 登录失败，本机策略 10 次 / 14 分钟即锁账户。

| 项 | 取值 / 语义 |
|---|---|
| 目录根 | `~/.dsh/browser-e2e/browser-profile/`，`DSH_BROWSER_E2E_HOME` 可改 |
| 槽目录 | 按启动签名分：`<headless|visible>-<edge|chrome>-<hash8>`。**Chromium 独占 user-data-dir**：实测第二个实例用同一目录直接报 `Target page, context or browser has been closed` |
| 常驻 | 不随池 shutdown / 空闲回收删除（决策 D13）。收益公式因此是「每次槽生命周期最多一次 4625」 |
| 哨兵值 | 启动前把 `password_manager.os_password_last_changed` 写成 `9223372036854775807`（字符串）。**它只是一个字段级契约，不是「防护生效」的验收判据**（三条局限见下） |
| 合并写入 | 只动 `password_manager` 段，其余 30+ 个 Chromium 状态字段原样保留；损坏的 JSON 备份为 `.corrupt` 后重建 |

### 哨兵值法的三条局限（已实测确认，不要把「字段被写回」当成「跳过探测」）

哨兵值原来被当成「账户锁定防护已生效」的验收判据，现确认**不成立**，三条原因叠加：

1. **只在关闭时落盘**——启动后 3.1 秒内读到的始终是哨兵原值，只有 `close()` 之后才变真实值。
   因此在 `acquire()` 里启动后立刻回读只能读到原值，判据恒为「未消费」
   （证据：`.scratch/probe-sentinel-timing.mjs`、`.scratch/probe-sentinel-flush.mjs`）。
2. **幂等导致根本不写入**——`ensureLocalStateSeed()`（`lib/browser-profile.js:137`）发现已有合法字符串就跳过，
   profile 跑过一次之后再也不写哨兵值；此时判据 `after !== SENTINEL` 因为我们什么都没改而恒真。
3. **「字段被写回」与「跳过探测」之间没有等价关系**——这是逻辑缺口，哨兵法无论如何都补不上：
   Chromium 改写这个字段只说明它读到了值，不说明它据此放弃了空密码探测。

因此实现上改为如实记账：`poolStats().slots[].localStateConsumed` 只在**本轮真的写入过**标记时才有意义
（`'written'` / `'unchanged'`，幂等跳过时为 `'skipped'`），另提供 `localStateFlushedAfterClose`
（`close()` 之后的回读，`null` 表示还没关闭过）。二者都只描述字段，**不得**用作防护功效的判据。

### 4625 实测结论（2026-11-21，两轮 A/B 双臂对照）

两轮都做了 A/B 对照，第二轮专门在**已锁屏**状态下做（锁探针 `LOCKED`，启动前后各验一次）。
判据是「4625 事件的 `ProcessId` 是否等于本次浏览器主进程 PID」——**按 PID 归属，不按时间窗**：
本机同时有其它 DSH 会话在调 `browser_e2e_start`，按时间窗会把别人的 4625 算到自己头上（实测发生过）。

| 轮次 | 臂 | profile | 启动 | 锁状态 | 4625（按 PID 归属） |
|---|---|---|---|---|---|
| 1 | A（写哨兵） | `ab-profiles/A-1795263890981-e47779` | 1 | 未锁 | **0** |
| 1 | B（空 profile 阳性对照） | `B-1795263948527-a8fa49`、`B-1795264832883-3730ea` | 2 | 未锁 | **0**、**0** |
| 2 | B（空 profile 阳性对照） | `B-locked-1795266686293-bd36ca`、`B-locked-1795267071286-6b06a8`、`B-locked-1795267486734-304153` | 3 | **LOCKED** | **0**、**0**、**0** |
| 2 | A（写哨兵） | `A-locked-1795266939205-42ef74`、`A-locked-1795267403447-a57924` | 2 | **LOCKED** | **0**、**0** |

第二轮 5 次启动的实测 PID 为 `26016`（A）、`26648`（B）等；同一时段 Security 日志里的 3 条 4625 分别来自
PID `24580` / `11284` / `27384`，**都不属于本实验的任何一次启动**（`27384` 在 A 臂启动前就在运行）。
公网对照：基线（实验前 200 条上限）按进程归集为 msedge=149 / 空=45 / chrome=5 / svchost=1，
最新一条在 `20:14:33`——也就是说这台机器**确实会**产生 msedge 的 4625，只是不是本插件的启动路径产生的。

**判定：实验无效（阳性对照在两种条件下都没起来）。** 无论是否锁屏，全新空 profile 启动的浏览器
都没有产生一条 4625。A 臂的 0 条因此**不能**归因于「哨兵值生效」，只能说明在这条启动路径上
观测不到 4625。「防护有效」与「防护无效」都**未被证实**。

结论的边界要说清：本实验证伪的是「**本插件的启动路径**会稳定产生 4625」这一隐含前提；
它**不能**证明整个机器上不存在空密码探测，因为别的进程（另一 DSH 会话、其它 Edge 实例）确实打出了 4625。
第一层防护是否必要，取决于那些 4625 的来源是否与我们的启动路径同源——这点本轮**仍未测明**。

另外，A 臂关闭后哨兵值仍是原值（`sentinelUnchangedAfterClose: true`，两轮都如此），
比「只在关闭时落盘」更差：即便 `close()` 之后 Chromium 也没有改写这个字段。这进一步说明该字段不适合当判据。

### default context 的定位（`launchPersistentContext` 的固有副产物）

`launchPersistentContext(dir)` 返回的**是 `BrowserContext` 而不是 `Browser`**，且这个 context 是 profile 宿主：
它随浏览器创建、承载磁盘 profile、**不能单独关闭**——关它等于关掉整个浏览器进程（实测见下）。因此每个槽内有两层 context：

| 层 | 数量 | 归属 | 能否单独关闭 | 参与池的关闭判断 |
|---|---|---|---|---|
| default（profile 宿主） | **恒为 1** | `slot.persistent` | **否**，关它即杀浏览器 | **否** |
| 会话隔离 context | 每会话 1 个 | `session.context`（`browser.newContext()`） | 是 | **否** |

实测（本机无头 Edge，2026-11-21）：

| 场景 | `browser.contexts()` |
|---|---|
| 1 个会话 | 2（default + 该会话） |
| 2 个会话（同一共享 Browser） | 3（default + 2 个会话） |
| 会话全部关闭、浏览器仍在（池级空闲未到点） | **1**（只剩 default） |

**池的关闭判断只看 `slot.leases`，从不清点 `browser.contexts()`。** 这是关键性质：

- `release()`（`lib/pool.js`）把租约减一，归零时装池级空闲计时（`0` 则立即 `shutdownSlot`）；
- `abandon()` 同口径，归零时立刻 `shutdownSlot`；
- `contexts()` 在 `lib/` 里只有两处调用，**都属于 CDP 路径**（`session.js` 的 `assertCdpProfileIsolated`
  与 CDP 接管取用户 context），与池的关闭判断无关。

因此 default context 不会阻塞回收：它存在与否都不影响「租约归零 → 关浏览器」这条链路。
`shutdownSlot()` 关的是 `slot.persistent`（profile 宿主），会连带收掉浏览器与那个 default context；
若只关 `browser` 而不关 `persistent`，某些 Playwright 版本会留下 persistent context 未关闭的告警。

**实测确认（池级 `DSH_BROWSER_POOL_IDLE_MS=0`）**：启动后 `contexts=2`、`leases=1`；
关掉唯一会话后 `hasBrowser=false`、`slots=0`——尽管那时 default context 仍然活着，浏览器照样被回收。

#### 为什么不能「启动后就关掉 default context」

实测两条路径都失败（`launchPersistentContext` 的返回值语义是「整个持久化 profile 会话」，不持有独立浏览器生命周期）：

| 路径 | 结果 |
|---|---|
| `persistent.close()` | `browser.isConnected()` 变 `false`，`contexts()` 归 0，后续 `newContext()` 报 `Target page, context or browser has been closed` |
| 只对 default context 调 `ctx.close()`（先另建一个自己的 context 形成 2 个并存） | 同样 `isConnected()=false`；连**已存在的另一个 context** 也一并失效，`browserContext.newPage` 报同样的错 |

结论：想让「后续路径完全等同于共享 Browser + 每会话隔离 context」，**无法通过关掉 default context 达成**。
它必须一直存活到 `shutdownSlot()`，代价是一个空 `about:blank` 页的内存；收益是保住 4625 防护（本章开头）。

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

**第三轮补强（2026-11-21）**：

| 位置 | 原问题 | 修正 |
|---|---|---|
| `tests/browser-profile.mjs` | 「池记录了 Local State 已被消费」判据写成 `got.browser !== null`，恒为真；`slot.localStateConsumed` 无读取方，恒为 `false` 也无人发现 | 改读池的真实记账；`localStateConsumed` 改三态（`written` / `unchanged` / `skipped`），另加 `localStateFlushedAfterClose`（`close()` 之后回读）。「哨兵值被改写」的措辞降级为「仅证明字段被消费，不证明跳过探测」——原措辞暗示的等价关系已被 4625 实测证伪 |
| `tests/pool-sessions.mjs` | `page.js` 的 `createTransientPage` 无直接测试，跨会话隔离只经 fetch 链路间接覆盖 | 新增用例 4b（6 条断言）：临时页被标记 transient、落在**自己的** context、不出现在另一会话的 context、不计入 `session.pages`、关闭后页面数回基线。该文件 28 → 34 PASS |

> 上面「`localStateConsumed` 无读取方」这条值得记一笔：一个字段没有任何读取方，它写错了也没人会发现。
> 这正是「恒真断言」掩盖问题的典型形态——把断言改成读真实字段，问题当场就暴露了（当时立刻 FAIL）。

**第二轮复核追加修正（同一批复核员深挖后）**：

| 问题 | 位置 | 修正 |
|---|---|---|
| 启动失败 / 启动中被 close 且 context 未建时，直接 `closeBrowser(session.browser)`，而它是共享实例 → 连带打死同签名的其它会话 | `lib/session.js:963,989` | 改走 `abandonSessionContext`（归还租约，租约归零才由池关） |
| `persistent.close()` 失败被 `.catch(() => {})` 吞掉，`shutdownSlot` 仍报 `closed:true` | `lib/pool.js:317` | 记 `closeFailed` 并如实返回；`shutdown()` 透传该字段 |
| `launching` 期间被 `shutdown` 摘槽，launch 落定后浏览器无人持有（直到进程退出） | `lib/pool.js:217-224` | 落定后检查槽是否还在 Map 里，不在就当场 close 并让本次 acquire 报错 |

新增用例覆盖上述分支：`tests/pool.mjs` 用例 14（启动中途 shutdown 不留孤儿 + 池内为空）、用例 15（关闭失败 closed 如实为 false），共 44 PASS。

**仍未消除的已知局限**：

> **[已过时 2026-11-22]** `freezeAnimations` 拦不住导航后**新造**的动画（见功能规格 0040 的「已知局限」，已实测确认并写成断言）。
>
> 现在：已由 0040 的「动态守护」收掉——250ms sweep + `Element.prototype.animate` patch 之后，后插 `!important` 样式与后建 WAAPI 动画都会归零，该条已不是局限（见 0040「行为」与「已知局限」整段改写）。
> 变更原因：一次性 `domcontentloaded` 冻结拦不住之后新造的动画，需求要求任何时刻新出现的动画都不持续耗 CPU。
- 进程计数类测试互相争抢 profile，`reclaim` 与 `pool-sessions` 并发跑会同时崩溃，必须串行。