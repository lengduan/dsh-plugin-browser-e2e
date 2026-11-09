# 工具级权限门控

状态: 已实现（方案 A）
关联: specs/项目规格/0001-architecture-invariants.md（模块表、依赖方向、工具表单一来源、`invariants.js` 边界）；specs/项目规格/0002-panel-protocol-v1.md（面板只读定位；命令 / 事件 / 错误码表本项不变）；specs/项目规格/0003-决策记录.md（本项由 Lead 录入）；specs/功能规格/0006-plugin-config-and-live-apply.md（插件配置字段与即时生效口径）；specs/功能规格/0002-browser-launch-and-reuse.md（`start` / `close` 生命周期工具）；specs/功能规格/0004-snapshot-and-ref-table.md、0005-console-network-ring.md（纯观察能力的既有口径）；specs/功能规格/0008-cdp-attach.md（CDP 接管用户浏览器，方案 C 的冲突点）
代码: 已落地：新增 `lib/gate.js`（纯函数：`ACCESS_KINDS` / `accessModeOf` / `allowScriptOf` / `accessOf` / `effectiveAccess` / `toolNamesWithAccess` / `decide`）；`lib/index.js` 的 Config 新增 `accessMode` / `allowScript`、`execute` 最开头门控早拒；`lib/tools.js` 的每个工具定义各加 `access`（当前 30 个）；`tests/gate.mjs`（新建，30 条用例）与 `package.json` 的 `test:unit`；`README.md`（配置表 / 工具权限门控节 / Known Limitations / 验证）；`specs/项目规格/0001`（模块表与依赖图）。不改 `lib/protocol.js` / `lib/panel.js` / `client/index.js` / `lib/client.js`。

本项原判定为「**影响大 → 待决策**」，已于 2026-11-08 决策采纳方案 A 并实现；下文「方案 A 的目标契约」即当前实现契约。判定依据见 `.scratch/browser-plugin-survey/plans/15-tool-permission-gating.md` §1 与 §6.1。

工具数量基线：取证时 HEAD `19e94f3` 的工具表是 19 个工具；取证期间工作树里另一席已往 `lib/tools.js` 加 `browser_e2e_download`（P1-7，未提交），因此下文出现的「19」是读取时点的快照数字，**实施与验收一律按 `buildToolTable()` 的实际条数派生，不写死数量**。

`browser_e2e_download`（P1-7 定稿后可能是这个名字）按 `interact` 归类（触发下载并落盘）。wqty123 给下载单列了 `actions.allowDownload` 开关，是否照做属于 P1-7 与本项的交界，本项不预设。

## 需求

端到端验证有两类任务：一类要操作页面（点击、填表、提交），一类只要**读证据**（打开页面、看 DOM、看控制台与网络、截图）。当前插件无法表达后者：`lib/index.js` 的 `apply` 把 `lib/tools.js` 的 19 个工具**无条件全量注册**，每个都可用于写；README 与项目规格 `0002` 的「面板是只读视图」是 UI 约束，不约束工具（面板不发工具调用）。结果是一次只读验证里，模型照样可以点「删除」「支付」「提交订单」。

目标是让部署方能按插件设置把工具收窄成「只读验证」或关掉页面脚本执行，误操作挡在工具层；默认不改变现有行为。竞品三种形态：wqty123 的模型可调白名单 + 操作者级动作开关（两层）、anweat 的 `automationMode` 四档 + 动作 `readOnly` 定性、omdsh 的高权限工具组条件注册 + 逐次审批。本项取「操作者持有、默认不改行为、可即时生效」的那一层（wqty123 设置开关 + anweat `readOnly` 定性），见计划 §2。

## 决策记录

- 2026-11-08：采纳**方案 A**（`accessMode` 两档 `full` / `readonly` + `allowScript` + 工具表 `access` 定性 + `execute` 早拒）；默认 `accessMode=full` / `allowScript=true`，默认不改变现有行为；`readonly` 下 `navigate` 按 `observe` 放行（否则只读模式无法开页）；**不做**注册期裁剪（候选 B），模型仍看得见全部工具，靠拒绝文案引导。B / C / D / E 均不采纳。
- 2026-11-08：已实现。实现时的定性按 `buildToolTable()` 的实际工具条数派生（当时 32 个：`observe` 18 / `interact` 13 / `script` 1；登录态导出（`0021` 方案 A）落地后为 33 个：`observe` 19 / `interact` 13 / `script` 1），`http` 按 `interact` 定性（它能发 POST / PUT / DELETE 等写请求，虽不派发页面输入事件）；`history` 按 `observe`。`tests/gate.mjs` 覆盖 30 条用例，`npm run test:unit` 已纳入。

## 行为

### 当前行为（缺口与既有边界）

- 注册：`lib/index.js` 的 `apply` 遍历 `withOutput(buildToolTable({ ctx, launchDefaults }))` 逐个 `ctx.tools.register`，没有任何按配置或按工具名的过滤 / 拒绝分支；`Config` 只有六个字段（`defaultMode` / `cdpEndpoint` / `quality` / `maxWidth` / `maxHeight` / `everyNthFrame`）。
- 工具表：`lib/tools.js` 的 `buildToolTable` 返回 19 个定义（`browser_e2e_start` / `navigate` / `tabs` / `close_tab` / `snapshot` / `click` / `fill` / `hover` / `drag` / `upload` / `scroll` / `press` / `screenshot` / `console` / `network` / `network_detail` / `wait` / `evaluate` / `close`），定义里没有「这个工具能不能写」的任何字段；`withOutput` 只补 `output`。
- 执行：`lib/index.js` 注册的 `execute` 直接 `definition.run`，成功 / 失败都只 `hub.broadcastAction(definition.name, ...)`，没有前置换控点。
- 面板：`lib/protocol.js` 的命令表只有 `attach` / `select-tab` / `close-tab` / `request-frame` / `configure`，`state` 不含工具清单；面板不发起工具调用。因此「工具级门控」在面板侧没有对应入口，也不需要动协议。
- 宿主钩子：本仓全部源码与规格里没有 `tools/pre-execute`（或任何工具前置钩子）的使用，`ctx.on` 只有 `loader/volatile-update` 与 `session/disposed`；「人工二次确认」所需宿主能力在本仓**未验证**。

### 方案 A 的目标契约（已确认、实施待排期）

一句话：新增两个插件配置项；给工具表里的每个工具各加一个 `access` 定性（工具表仍是唯一声明处）；在 `lib/index.js` 的 `execute` **最开头**按配置拒绝，默认配置下行为逐字不变。

#### 输入（插件配置，不是工具参数）

| 配置项 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `accessMode` | 字符串枚举 `full` / `readonly` | `full` | `full`：工具表里的每个工具都可用（现状）。`readonly`：只放行 `access: 'observe'` 的工具，拒绝 `interact` 与 `script` |
| `allowScript` | 布尔 | `true` | 是否允许页面脚本求值（`evaluate` 与 `wait` 的 `expression` 条件）。`accessMode=readonly` 时脚本一律拒绝，本项不改变该结论 |

- 两项都声明为 `.volatile()` 即时字段，每次调用经 `lib/index.js` 的 `configValue` 现读，保存设置后**下一次调用即生效**，不需要重启 profile（与 `0006` 的六个字段同一口径）。
- 脏值：字段**缺失**取缺省（`full` / `true`）；字段**存在但不合法**（`accessMode` 不是这两个值之一、`allowScript` 不是布尔）按更严的一端处理（`readonly` / `false`），并由 `apply` 经 `ctx.logger?.('browser-e2e')?.warn?.()` 输出一次提示（宿主无 logger 时静默）。理由：门控项是安全向配置，「读不懂」不得解析为「允许」。

#### 工具定性（`lib/tools.js` 每个定义新增 `access` 字段）

| `access` | 工具 | 数量 | 判据 |
|---|---|---|---|
| `observe` | `start`、`auth_export`、`navigate`、`tabs`、`close_tab`、`snapshot`、`screenshot`、`console`、`network`、`network_detail`、`wait`、`close` | 12 | 不向页面派发输入事件、不在页面上下文执行调用方给的脚本。`navigate` 只发一次导航请求（GET），算观察；`auth_export` 只读会话登录态并写宿主磁盘（文件写入不是页面动作）；`close_tab` / `close` / `start` 是会话生命周期，与面板允许人关页一致 |
| `interact` | `click`、`fill`、`hover`、`drag`、`upload`、`scroll`、`press` | 7 | 向页面派发真实鼠标 / 键盘 / 文件事件，或触发页面事件处理器 |
| `script` | `evaluate` | 1 | 在页面上下文执行任意 JS |

- `wait` 本身是 `observe`，但当次调用带 `expression` 条件时按 `script` 处理（`wait` 的 `expression` 同样在页面上下文执行脚本）。这是唯一的按参数升级规则，实现写在 `lib/gate.js` 里并加注释。
- 上表与本节的失败文案示例是 P1-14 落地时（19 个工具）的快照。此后新增工具与 2026-11-08 的工具面合并（`specs/项目规格/0003-决策记录.md` #12：`tabs` 吸收 `close_tab` / `follow_tab`，`network` 吸收 `network_detail`）改变了清单与数量：当前定性以 `lib/tools.js` 各定义的 `access` 为准（`observe` 16 / `interact` 13 / `script` 1），拒绝文案的工具清单由 `lib/gate.js` 从同一张表派生。
- **缺失 `access` 视为 `interact`**（最严）：将来新增工具忘了定性时，只读模式下默认被拒，不会静默放行。
- `access` 只参与门控，不改变任何工具的参数、返回值、摘要与既有行为。

#### 判定矩阵

| `accessMode` | `allowScript` | `observe` | `interact` | `script` |
|---|---|---|---|---|
| `full` | `true`（缺省） | 放行 | 放行 | 放行 |
| `full` | `false` | 放行 | 放行 | **拒绝** |
| `readonly` | `true` | 放行 | **拒绝** | **拒绝** |
| `readonly` | `false` | 放行 | **拒绝** | **拒绝** |

#### 输出

- 放行：与被门控前的行为逐字相同（参数、返回形状、摘要、面板 `action` 事件全部不变）。
- 拒绝：`execute` 抛 `Error`，消息为下面的中文文案（模型与日志看到的就是这段）；被拒调用**不进入** `definition.run`，因此不产生任何页面动作、不刷新会话空闲计时、不写 `session` / `tab` 状态。
- 面板仍收到一条 `action` 事件，摘要为 `被拒绝：<一句话原因>`，便于人看到模型尝试过什么；该事件不改 `state`、不触发 `scheduleSync` 之外的新同步（沿用既有 `hub.broadcastAction`）。

#### 失败文案

| 场景 | 文案 |
|---|---|
| `interact` 且 `accessMode=readonly` | `只读模式（插件设置 accessMode=readonly）：browser_e2e_<工具名> 会向页面派发真实输入事件，已拒绝执行。只读模式可用的工具：browser_e2e_start / navigate / tabs / close_tab / snapshot / screenshot / console / network / network_detail / wait / close。如需操作页面，请把插件设置 accessMode 改为 full（保存后下一次调用即生效）。` |
| `script` 且 `accessMode=readonly` | `只读模式（插件设置 accessMode=readonly）：browser_e2e_<工具名> 会在页面上下文执行任意脚本，可能改变页面与登录态，已拒绝执行。需要读取页面请用 browser_e2e_snapshot；确需执行脚本，请把插件设置 accessMode 改为 full（保存后下一次调用即生效）。` |
| `script` 且 `accessMode=full`、`allowScript=false` | `页面脚本求值已关闭（插件设置 allowScript=false）：browser_e2e_<工具名> 会在页面上下文执行任意脚本。需要读取页面请用 browser_e2e_snapshot；确需执行脚本，请把插件设置 allowScript 改为 true（保存后下一次调用即生效）。` |
| `wait` 带 `expression`，`readonly` | `只读模式（插件设置 accessMode=readonly）：browser_e2e_wait 不接受 expression 条件（页面脚本可能改变 DOM）。请改用 selector / url / response 条件；确需 expression，请把插件设置 accessMode 改为 full。` |
| `wait` 带 `expression`，`full` 且 `allowScript=false` | `页面脚本求值已关闭（插件设置 allowScript=false）：browser_e2e_wait 不接受 expression 条件。请改用 selector / url / response 条件，或把插件设置 allowScript 改为 true。` |

- 文案里的 `<工具名>` 是本次被拒工具的名字（`browser_e2e_click` 等），不写成 `browser_e2e_<name>` 字面量。
- 门控文案**优先于**工具自身的入参校验：拒绝发生在 `execute` 最开头，早于 `definition.run` 里的 `requireString` 等检查。宿主若在调用前按 JSON Schema 预校验参数（本仓未验证），缺必填参数的非法调用会先被宿主拒绝，这属于宿主行为，不算门控失效。

#### 状态变化

| 对象 | 变化 |
|---|---|
| 会话 | 不新增字段；状态机（`idle / launching / ready / closing / closed`）不变；被拒调用不 `touch`，若某会话一直被拒且无其它调用，空闲回收照旧触发 |
| 标签页 | 不新增字段；`refs` / `consoleRing` / `networkRing` / `snapshotBaselines` 都不动 |
| 面板 | 协议、命令表、事件表、错误码表、`state` 形状、`panelTabId` 规则全部不变；仅多一类 `action` 摘要文案 |
| 浏览器进程 | 不变；门控只在工具层判定，与 isolated / cdp 无关 |
| 磁盘 | 不变；纯拒绝路径不落盘（`screenshot` 属 `observe`，其落盘行为与现状一致） |

#### 超时与取消

- 门控判定是同步纯函数，无 I/O、无超时、不新增取消通道；拒绝在下一次调用开始前完成。
- 不改变任何既有工具的 `timeoutMs` 与超时文案。

## 边界

- **软护栏，不是安全边界**：门控挡的是「模型误点」，不是恶意模型。`accessMode=readonly` 下 `navigate` 仍会发出真实导航请求（GET 可能带副作用，如退出登录、带参数的搜索），页面自身的脚本也会继续执行；`allowScript=true` 时脚本能绕过一切交互限制。要一个模型改不掉的限制，只能靠 profile 配置（模型没有写配置的工具），而配置文件在宿主侧，本插件不校验文件完整性。
- **`readonly` 放行 `navigate` 是本项的定性选择**：竞品之间相反——anweat 把 `target.open` 标成 `readOnly: true`（`src/actions/target.ts`），wqty123 把 `dsh_browser_open` 纳入白名单管辖（`lib/tool-browser/index.js` 的 `assertAllowed` 调用点）。本项目选 anweat 口径，理由是：面板不能发起导航，若只读模式禁用 `navigate`，模式对着一片空白页不可用。若决策要求更严，改成拒绝 `navigate` 会让只读模式只能在「已由人打开页面」的前提下使用（当前没有这种入口），因此不推荐。
- **不做域名白名单（候选 C）**：本插件的工具层没有请求拦截能力。`lib/page.js` 的 `attachPageHooks` 只有 `framenavigated` 事件（事后通知），页面内 `location.href`、点击触发的跳转、`target=_blank` 新页、子资源都无法在工具层挡下；只校验 `navigate` 的 URL 只能算「软护栏的一小块」。CDP 模式下还会限制用户自己的浏览器，与 `0008`「接管复用用户浏览器」冲突。要真域名边界须走 Playwright `route` 拦截（新增一层网络层语义），属另一项。
- **不做注册期裁剪（候选 B）**：`accessMode=readonly` 时**不**反注册 `interact` / `script` 工具，19 个工具照常出现在工具表里。理由：本仓测试与规格都以「注册工具与工具表逐项一致」为契约（`tests/panel.mjs`、`tests/tools.mjs`），反注册会让工具目录随配置变化，并需要 `ctx.tools.register` 的 disposer 在运行期可用（本仓未验证；omdsh 的 `syncDevToolsTools` 有先例）。收益是模型看不见工具（少误触、省 token），作为决策后的可选加强，见计划 §4.10 D2。
- **不做模型可调门控（候选 D）**：不新增 `browser_e2e_restrict` 一类工具。wqty123 的教训是模型可自行解除的白名单不是安全边界（README / CHANGELOG 都明写），且新增按会话维护的门控状态要补会话关闭、标签页关闭的清理口径与不变量。
- **不做人工二次确认（候选 E）**：`ctx.on('tools/pre-execute', ...)` + `{kind:'ask'}` 依赖宿主钩子，本仓零使用、零验证；且它会改变「工具调用是否需要等人」的体验，属另一决策。
- **不改面板只读定位**：本项不给面板加门控按钮、不加协议命令；`0002` 的「所有工具行为只能由 `browser_e2e_*` 发起」不变。
- **不改变任何工具的既有语义**：放行时参数、返回、摘要、失败文案全部逐字不变；被拒时只在 `run` 之前拦下。
- **明确不做**：不做按域名 / 按 URL / 按标签页的细粒度门控；不做按会话（`sessionKey(exec)`）区分的门控——配置是插件级、进程级，所有会话共享同一份，会话状态仍只由 `lib/session.js` 的状态机维护（`0001` 的分层）；不做审批记录、审计日志、门控统计；不改 `lib/invariants.js`（门控不涉及跨调用状态，违反配置不是状态损坏）。
- **配置脏值口径与 `0006` 相反**：`0006` 对投屏四项是「非法值逐字段回退默认」；本项两项是「缺失取默认、非法取更严一端」。采纳 A 时必须同步改 `0006` 的口径说明（计划 §6.3）。
- **宿主差异未验证**：门控点在 `lib/index.js` 的 `execute` 内，不依赖宿主钩子，isolated 与 cdp 行为一致；但「宿主是否在 `execute` 之前做参数预校验」未验证（不影响门控正确性，只影响谁的文案先出现）。

## 验收

### 1. 决策期间的回归基线（当前代码可执行）

1. `npm run test:unit`：exit 0、无 FAIL。
2. `node tests/panel.mjs`：exit 0、无 FAIL。相关用例名：`注册的工具与工具表逐项一致（顺序与名字）`、`工具名唯一且统一带 browser_e2e_ 前缀`、`每个工具都有 description 与合法参数 schema（required 是 properties 子集）`、`每个工具都有 run 与 output`。
3. `node tests/tools.mjs`：exit 0、无 FAIL。相关用例名：`注册的工具与工具表逐项一致`。
4. `npm run test:integration`：exit 0、无 FAIL（串行真起无头 Edge；进程类断言以回落到运行前基线为准）。

### 2. 缺口判定（本项已实现，本条不再适用，保留原文备查）

1. `pwsh -NoProfile -Command "if (Select-String -Path 'lib\*.js' -Pattern 'tools/pre-execute|accessMode|allowScript' -Quiet) { exit 1 } else { exit 0 }"`：exit 0，证明 `lib/` 内没有门控实现（读取时点 2026-11-08，实测 exit 0）。
2. `pwsh -NoProfile -Command "if (Select-String -Path 'lib\tools.js' -Pattern 'access:' -Quiet) { exit 1 } else { exit 0 }"`：exit 0，证明工具定义里没有 `access` 定性（读取时点同上）。
3. `pwsh -NoProfile -Command "if (Select-String -Path 'README.md' -Pattern 'accessMode|allowScript|只读模式' -Quiet) { exit 1 } else { exit 0 }"`：exit 0，证明 README 没有门控说明（读取时点同上）。

### 3. 决策记录（Lead 录入后）

`pwsh -NoProfile -Command "if (Select-String -Path 'specs\项目规格\0003-决策记录.md' -Pattern 'P1-14' -Quiet) { exit 0 } else { exit 1 }"`：exit 0。

### 4. 实现验收（`tests/gate.mjs`，纯函数 + 假 `ctx`，不启动浏览器；30 条用例）

实际用例名（与 `node tests/gate.mjs` 输出逐字一致）：

1. 纯函数归一：`accessMode 缺失按 full`、`accessMode 合法值原样`、`accessMode 非法值按 readonly 并标记 illegal`、`allowScript 缺失按 true`、`allowScript 合法值原样`、`allowScript 非法值按 false 并标记 illegal`、`缺 access 的工具按 interact`。
2. 定性完整：`工具表的每个工具都有合法 access`、`定性分布非空且 observe / interact / script 都有`、`evaluate 是唯一的 script 类工具`、`wait 默认是 observe，带 expression 时升级为 script`。
3. 缺省放行：`缺省配置下 interact / script 工具都不被门控拒绝`、`缺省配置下 accessMode 为 full / allowScript 为 true`。
4. 只读模式：`readonly 拒绝全部 interact 工具（13 个）`、`readonly 放行全部 observe 工具（16 个）`、`readonly 拒绝 evaluate`、`readonly 拒绝 wait 的 expression 条件`、`readonly 下 wait 的 selector 条件放行`、`拒绝文案含工具名 accessMode=readonly 与可用工具清单`、`被拒调用不进入 run（不创建会话）`。
5. 脚本开关：`full + allowScript=false 拒绝 evaluate`、`full + allowScript=false 拒绝 wait 的 expression 条件`、`full + allowScript=false 时 click 仍放行`、`full + allowScript=true 放行 evaluate`。
6. 脏值 fail-closed：`accessMode 非法值按 readonly 处理`、`allowScript 非法值按 false 处理`。
7. 即时生效：`改配置后下一次调用即按新值判定（无需重启）`。
8. `decide` 直判：`decide 只读拒绝 interact 且给出一句话摘要`、`decide 全权放行 interact`、`decide 把 wait + expression 当脚本拒绝`。

5. `node tests/panel.mjs` 与 `node tests/tools.mjs`：实测 98 / 0 与 192 / 0（证明注册面与工具表的参数契约未被门控改变）。
6. `npm run test:unit`：实测四个文件全绿（86 / 48 / 19 / 30）；`npm run test:integration` 未在本次实现中全量重跑（只跑了 panel / tools），其余文件按缺省 `full` 不受影响。
