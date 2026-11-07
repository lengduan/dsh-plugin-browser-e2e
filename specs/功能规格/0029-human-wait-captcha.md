# 人机协同等待与验证码检测

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/human.js`；进程内对象契约 `session.headless` 与两个工具的返回字段；进程回收「空闲回收」的既有边界）；specs/项目规格/0002-panel-protocol-v1.md（`action` 事件与面板只读定位，不改协议）；specs/功能规格/0013-wait-url-and-response.md（既有四条件等待的「超时抛错」口径；本工具口径不同）；specs/功能规格/0027-assert-tool.md（新工具用返回值表达结论、与 wait 不同口径的先例）；specs/功能规格/0019-evaluate-timeout.md（页内脚本求值的超时边界）；README.md「工具一览」
代码: lib/human.js / lib/session.js / lib/tools.js / tests/human.mjs

## 需求

扫码登录、2FA、滑块 / reCAPTCHA 这类步骤必须由真人完成，agent 只能停住等。当前插件没有任何「人机验证」检测，也没有「停下来等用户处理完再继续」的工具：模型只能让用户自己盯着面板，然后盲目重试 `browser_e2e_wait`，整条验证链断在人工步骤。本功能新增两个工具：`browser_e2e_captcha_check` 探测当前页面是否有人机验证（结构化返回类型与证据），`browser_e2e_wait_for_human` 把页面交给用户并轮询等待验证消失（可选「登录成功」选择器），超时返回 `resolved:false` 而不是抛错。

## 行为

### 工具与输入

工具 `browser_e2e_captcha_check`（非阻塞检测）：

| 参数 | 类型 | 缺省 | 约束 |
|---|---|---|---|
| `textScan` | boolean | `true` | `false` 时只做 DOM 结构检测，不读页面文本 |
| `tab_id` | string | 当前 active tab | 目标标签页 |

工具 `browser_e2e_wait_for_human`（阻塞等待）：

| 参数 | 类型 | 缺省 | 约束 |
|---|---|---|---|
| `reason` | string | `confirm` | 空白折叠后保留前 200 个字符（超出截断，不报错）；用于摘要与结果回显，语义自由（captcha / login / 2fa / confirm 等） |
| `timeoutMs` | integer | `60000` | 5000–300000（含两端）；上限低于默认空闲回收 600000，避免默认配置下等待期间浏览器被回收 |
| `pollMs` | integer | `1500` | 250–10000（含两端） |
| `selector` | string | 无 | 可选 CSS 选择器，作为「登录成功 / 已就绪」信号；空串与纯空白按未给处理 |
| `textScan` | boolean | `true` | 同检测工具 |
| `tab_id` | string | 当前 active tab | 调用开始时解析一次，等待期间不跟随 active tab 切换 |

纯入参校验（`timeoutMs` / `pollMs` / `reason` / `textScan`）在发起页面调用之前完成；`selector` 语法校验在解析标签页之后、进入轮询之前完成。任一项不合法直接抛错（中文，带修复指引）：

| 情形 | 错误文案 |
|---|---|
| `timeoutMs` 非整数或越界 | `timeoutMs 必须是 5000-300000 的整数，收到 <值>` |
| `pollMs` 非整数或越界 | `pollMs 必须是 250-10000 的整数，收到 <值>` |
| `reason` 不是字符串 | `reason 必须是字符串（如 captcha / login / 2fa / confirm）` |
| `textScan` 不是布尔值 | `textScan 必须是布尔值（true 读页面文本，false 只看 DOM 结构）` |
| `selector` 在等待开始前无法解析 | `selector 无法在等待开始前解析：<原始 message>；请检查 CSS 选择器后重试` |

浏览器未启动 / 没有可用标签页 / `tab_id` 不存在，沿用 `currentTab` 的既有断言文案。`textScan` 两个工具共用同一校验；`timeoutMs` / `pollMs` / `reason` 只属于 `browser_e2e_wait_for_human`。

### 检测规则

探测脚本在页面主 frame 内执行：检测工具调用一次；等待工具每轮调用一次（见下节）。返回 `{ detected, kind, evidence }`。

结构检测按下列顺序逐组尝试，命中第一组即返回该组 `kind`；`evidence` 为该组中实际命中的单个选择器，形如 `selector: .g-recaptcha`：

| 顺序 | 选择器 | kind |
|---|---|---|
| 1 | `iframe[src*="hcaptcha"]`、`.h-captcha` | `hcaptcha` |
| 2 | `iframe[src*="turnstile"]`、`.cf-turnstile` | `turnstile` |
| 3 | `iframe[src*="cloudflare"]`、`#challenge-form`、`.challenge-form` | `cloudflare` |
| 4 | `iframe[src*="recaptcha"]`、`.g-recaptcha`、`[data-sitekey]:not(.h-captcha):not(.cf-turnstile)` | `recaptcha` |
| 5 | `#captcha`、`.captcha` | `captcha` |

`kind` 是尽力而为的分类：元素只有 `data-sitekey` 且没有已知的 hCaptcha / Turnstile class 时按 `recaptcha` 处理；分类不影响「是否检测到」，只影响报告与提示文案。

结构检测未命中且 `textScan: true` 时做文本兜底：取 `document.body.innerText` 前 120000 个字符，大小写不敏感匹配下列短语（正则语义，下列为必须命中的最小集合，实现可以增补）；命中返回 `{ detected: true, kind: 'captcha', evidence: 'text: <匹配原文前 40 字>' }`：

- `verify (that )?you are (a )?human`
- `i.?m not a robot`
- `confirm you.?re human`
- `your activity looks unusual`
- `checking your browser`
- `enable javascript and cookies to continue`
- `人机验证`
- `安全验证`
- `我是人类`
- `滑块验证`
- `拖动滑块`
- `按住滑块`
- `点击.{0,8}验证`

文本兜底只在页面主机名不是 loopback 时执行：`localhost`、`127.0.0.1`、`::1`、`[::1]` 与以 `.localhost` 结尾的主机名一律跳过文本检测（本机页面是用户自己的工具界面，正文可能引用验证码字样），结构检测不受此限。主机名为空（`data:` / `about:blank`）不跳过。

两处都未命中返回 `{ detected: false, kind: null, evidence: '' }`。检测工具在页面不可读（导航中、已关闭、执行上下文销毁）时抛错，不返回 `detected:false`：`检测人机验证失败：页面不可读（可能正在导航或已关闭）：<原始 message>；请稍后重试`。

### 等待判定

`browser_e2e_wait_for_human` 先做纯参数校验，再解析标签页、校验 `selector` 语法，然后进入轮询循环；每一轮：

1. 会话状态为 `closing` / `closed` 时抛 `等待人工处理期间浏览器已关闭（可能是空闲回收），请重新 browser_e2e_start 后再试`。
2. `page.isClosed()` 为真时抛 `等待人工处理期间标签页已关闭（<tabId>），请重新 browser_e2e_tabs 获取可用标签页`。
3. 计数一次轮询（`polls`），执行探针。探针抛错时 `probeErrors` 加一、记 `lastProbeError`，本轮标记「未观测成功」并跳到第 7 步（登录提交后的导航会让页面脚本短暂不可读，不能据此判定任何结论）。
4. 探针成功时记 `detected` 与 `kind`；`detected` 为真则 `needed = true`。
5. 给了 `selector` 时执行 `page.locator(selector).count() > 0`；抛错按本轮「未命中」处理（页面正在导航）。
6. 本轮观测成功、`detected` 为假，且 `selector` 为空或已命中 → 立即返回 `resolved: true`。
7. 已到 `timeoutMs` 截止 → 退出循环，返回 `resolved: false`。
8. 等待 `min(pollMs, 剩余时间)` 后进入下一轮（最后一轮不睡眠）。

首次轮询立即执行，因此无验证码、无 `selector` 的页面在约一次探针的时间内返回（`needed:false`、`resolved:true`）；探针失败不会被当成「未检测到」，只有观测成功且未检测到才可能返回 `resolved:true`。

### 输出与渲染

`browser_e2e_captcha_check` 的返回对象：`{ detected, kind, evidence, url, tabId, summary }`。工具文本：

```
人机验证：检测到 <kind>        （未检测到时为「人机验证：未检测到」）
当前页面：<url>（标签页 <tabId>）
依据：<evidence>               （仅 detected 时出现）
```

`browser_e2e_wait_for_human` 的返回对象：

```
{
  needed, resolved,        // 布尔；needed = 等待期间是否至少一次检测到人机验证
  waitedMs, polls,         // 整数；实际等待毫秒、已执行探测次数（含最终判定那次）
  detected, kind,          // 最后一次成功探针的检测结果；kind 为等待期间最后一次检测到的类型，未检测到过为 null
  probeErrors,             // 等待期间探针失败次数；0 表示每轮都成功
  url, reason, selector,   // selector 未给时为 ''
  timeoutMs, pollMs,
  headless,                // session.headless：隔离模式本次启动是否 headless；cdp 模式为 false；未知为 null
  tabId,
  hint,                    // 仅 resolved=false 时出现
  lastProbeError,          // 仅 probeErrors>0 时出现
  summary
}
```

工具文本：首行 `summary`；其后 `当前页面：<url>（标签页 <tabId>）`；给了 `selector` 时追加 `完成信号：<selector>`；`resolved:false` 时追加 `提示：<hint>`；`probeErrors>0` 时追加 `最近一次探测失败：<lastProbeError>`。

`summary` 固定文案（`<reason>` 为空白折叠后的值）：

| 情形 | 文案 |
|---|---|
| 完成、检测到过、无 selector | `等待人工处理完成：<reason>（<kind> 已消失，耗时 <n>ms，轮询 <k> 次）` |
| 完成、检测到过、有 selector | `等待人工处理完成：<reason>（<kind> 已消失，完成信号 <selector> 已出现，耗时 <n>ms，轮询 <k> 次）` |
| 完成、从未检测到、有 selector | `等待完成：<reason>（未检测到人机验证，完成信号 <selector> 已出现，耗时 <n>ms，轮询 <k> 次）` |
| 完成、从未检测到、无 selector | `无需等待：<reason>（未检测到人机验证，耗时 <n>ms，轮询 <k> 次）` |
| 超时、最后仍检测到 | `等待人工处理超时：<reason>（仍检测到 <kind>，已等 <n>ms，轮询 <k> 次）` |
| 超时、未检测到但 selector 未出现 | `等待人工处理超时：<reason>（未检测到人机验证，但完成信号 <selector> 未出现，已等 <n>ms，轮询 <k> 次）` |
| 超时、每轮探针都失败 | `等待人工处理超时：<reason>（页面探测全部失败，已等 <n>ms，轮询 <k> 次）` |

`hint` 固定文案：`headless` 为真时 `仍未完成：当前浏览器是 headless 的（用户看不到窗口），请先 browser_e2e_close，再以 headless=false 重新 browser_e2e_start，或改用 cdp 模式接管可见浏览器；确认用户已完成验证后可再次调用 browser_e2e_wait_for_human。`；否则 `仍未完成：请确认用户已在浏览器窗口中完成验证，完成后可再次调用 browser_e2e_wait_for_human。`

### 状态变化

- 会话：新增 `headless` 字段（`sessionOf` 初始为 `null`；`launch` 在 isolated 分支写本次启动的 `headless`，在 cdp 分支写 `false`）；不改 `session.state`；入口经 `sessionOf` 刷新空闲计时，等待期间不再刷新。
- 标签页：只读探针与 `locator.count()`；不写 `refs`、`snapshotBaselines`、`consoleRing` / `networkRing`，不改 `activeTabId`。
- 面板：不改协议、错误码与客户端 bundle；结束后经 `lib/index.js` 广播既有 `action` 事件（首行摘要）。等待期间面板不显示额外状态，模型必须在调用前把「去哪个窗口做什么」说清。
- 浏览器进程：无变化；不改回收口径。

## 边界

- 载体可见性：isolated 模式默认 `headless: true`，用户看不到窗口，除页面自解（挑战脚本自动完成、页面自行移除）外本工具只能等出超时；结果里的 `headless` 与 `hint` 用于让模型给出「关掉后以 headless=false 重启 / 改用 cdp」的可执行指引。cdp 模式按可见处理，不探测用户浏览器本身是否 headless。可见窗口也可能被其它窗口遮挡；面板画面可确认当前页，但面板是只读视图，不能代替用户在窗口内操作。
- 检测是启发式：结构选择器 + 文本短语。误报（正文讨论验证码的页面、含「安全验证」字样的设置页）会让等待不结束，可传 `textScan:false` 或用 `selector` 收窄；漏报（纯图片验证码、无已知 class 的自绘组件、跨源 iframe 子文档内部、shadow DOM 内部文本）会让等待立即 `resolved:true`（`needed:false`），调用方需自行用 `browser_e2e_snapshot` / `browser_e2e_read` 或 `selector` 兜底。检测结果不是「页面一定没有验证」的证明。
- 只检测主 frame 的文档：跨源挑战以「主文档里的 iframe 元素」形态被结构检测命中；iframe 子文档内部、shadow root 内部不做遍历。
- 等待只作用于调用开始时解析的标签页。同页导航 / 重定向不影响（探针失败按瞬时错误继续）；用户登录若打开新标签页，需 `browser_e2e_tabs` 后在新标签页重新调用。`selector` 也只在该标签页的主文档内匹配。
- `selector` 的入口语法校验只做一次：极少数情况下页面正在导航会让 `locator.count()` 抛出非语法错误，同样按「无法在等待开始前解析」报错，重试即可；工具不重试、不缓存校验结果。
- 探针是一次页面脚本求值，不可被 `timeoutMs` 打断：页面主线程死循环或不返回时整次调用会挂住（与 `browser_e2e_evaluate` 相同，`0019-evaluate-timeout.md` 落定后另行收敛）。等待本身不提供调用中取消，只能靠 `timeoutMs` 到期退出。
- 超时不是错误：`resolved:false` 是预期结果，不是异常；这与 `browser_e2e_wait` 四类条件「超时抛运行时错误」的口径不同（`0013-wait-url-and-response.md`），与 `browser_e2e_assert` 用返回值表达结论同一处理（`0027-assert-tool.md`）。既有 `browser_e2e_wait` 的行为不变。
- 单次等待超过 `DSH_BROWSER_IDLE_MS` 时浏览器可能在等待期间被空闲回收（`0001-architecture-invariants.md`「进程回收三道兜底」记录的既有边界）；默认 `timeoutMs` 上限 300000 低于默认空闲 600000，改小 `DSH_BROWSER_IDLE_MS` 时需自行保证大于单次等待。
- 并发：同一页面可并发多个等待，各自独立轮询、不共享结果，也不保证两个等待看到同一时刻的页面状态。不新增跨调用不变量：所有异常都是单次入参错误或运行时结果，不写 `lib/invariants.js`。
- 明确不做：不做自动识别验证码内容 / OCR / 打码；不做面板内输入或直控（面板只读定位不变，改动属方向性决策）；不做审批流（本工具是阻塞等待，不是权限确认）；不做跨 tab 等待；不返回页面截图。
- 权限门控尚未实现（P1-14 待决策）：本工具不是只读工具（它把页面交给用户操作），但当前没有门控可接。

## 验收

1. `node tests/human.mjs` 退出码 0 且输出无 `FAIL`（该文件由 tester 新建，下列用例名由本规格固定）：
   - 检测组：`captcha 无验证码页面返回 detected=false`、`captcha 识别 recaptcha 并给出 selector 证据`、`captcha 识别 hcaptcha`、`captcha 识别 turnstile`、`captcha 识别 cloudflare 挑战页`、`captcha 识别通用 captcha`、`captcha 文本兜底识别 data: 页面的中文提示`、`captcha loopback 页面不做文本兜底`、`captcha textScan=false 时不做文本兜底`、`captcha 按 tab_id 只检测指定标签页`、`captcha 未启动时报浏览器尚未启动`。
   - 等待组：`wait_human 无验证码时立即 resolved=true 且 needed=false`、`wait_human 验证码消失后 resolved=true 且 needed=true`、`wait_human selector 作为完成信号`、`wait_human 验证码仍在时 selector 出现也不提前 resolved`、`wait_human 超时返回 resolved=false 且带 kind 与提示`、`wait_human 导航期间探针失败不中断等待`、`wait_human 等待期间标签页关闭立即报错`、`wait_human 按 tab_id 作用于指定标签页`、`wait_human headless 会话在超时结果里标注 headless`、`wait_human 不写 ref 表与事件环`、`wait_human 并发两个等待互不干扰`。
   - 校验组：`wait_human timeoutMs 越界或非整数报错`、`wait_human pollMs 越界或非整数报错`、`wait_human 非法 selector 在等待前报错`、`wait_human reason 超长截断到 200 字符`。
2. `node tests/panel.mjs` 退出码 0 且无 `FAIL`：`工具表共 <N> 个` 中 `<N>` 为施工后 `buildToolTable()` 的实际条数（HEAD 21 + 本项 2；若 P1-13 已提交则为 22 + 2 = 24）；`作用于页面的工具都接受 tab_id` 的名单纳入 `captcha_check` / `wait_for_human`。
3. `node tests/tools.mjs` 退出码 0 且无 `FAIL`：`注册的工具与工具表逐项一致`、`工具名唯一且统一带 browser_e2e_ 前缀` 不回退。
4. `npm run test:unit` 退出码 0（不启动浏览器）。
5. `npm run test:integration` 退出码 0（串行真起无头 Edge；进程类断言以回落到运行前基线为准）。`tests/human.mjs` 是否登记进该聚合脚本由 Lead 决定，未登记时以第 1 条单跑为准。
6. 工具数核对：`node -e "import('./lib/tools.js').then(({buildToolTable})=>console.log(buildToolTable({ctx:{get:()=>undefined},launchDefaults:()=>({})}).length))"` 输出与第 2 条一致。
