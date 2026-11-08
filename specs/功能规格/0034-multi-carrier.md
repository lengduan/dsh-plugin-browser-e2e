# 多载体选择

状态: 已确认（采纳方案 B1；实施待排期）
关联: specs/项目规格/0001-architecture-invariants.md（模块表与依赖图、进程内对象契约「session 对象」、不变量清单、能力函数返回值字段）；specs/项目规格/0002-panel-protocol-v1.md（`state` 形状、`tabs` 项字段、面板只读边界）；specs/项目规格/0003-未处理项.md（本项由 Lead 录入）；specs/功能规格/0002-browser-launch-and-reuse.md（启动 / 复用 / 摘要 / 热切换拒绝 / 边界「只驱动系统 Edge」）；specs/功能规格/0008-cdp-attach.md（CDP 接管不参与载体选择）；specs/功能规格/0006-plugin-config-and-live-apply.md（Config 六字段口径与即时生效）；README.md「浏览器启动与模式」「配置」「Known Limitations and Deferred Work」
代码: 当前无代码改动（本项已确认、实施待排期）。方案 B1 落地时预计涉及 lib/carrier.js（新建）/ lib/session.js / lib/invariants.js / lib/index.js / lib/tools.js / README.md / tests/carrier.mjs（新建），并同步 specs/功能规格/0002-browser-launch-and-reuse.md、0006-plugin-config-and-live-apply.md、0008-cdp-attach.md。

## 需求

现状：`browser_e2e_start` 的隔离模式只驱动本机系统 Edge——`lib/session.js` 的常量 `BROWSER_CHANNEL = 'msedge'`，`launch` 的隔离分支固定 `chromiumImpl.launch({ channel: BROWSER_CHANNEL, ... })`；工具参数、插件 `Config`、`lib/defaults.js` 都没有表达「用哪个浏览器」的入口。用户在日常使用 Chrome 的环境里验证页面，或者本机没有 Edge（部分 Linux / 精简 Windows 环境），只能改用 `mode: 'cdp'` 自己先起浏览器并记端点，或者放弃验证。

本项要让使用者在「系统 Edge」之外**显式选择**本机已安装的 Chrome，并在本机同时装有多个 Chromium 内核浏览器时按 `auto` 取第一个可用的；选择只在隔离模式生效，CDP 接管仍由端点决定载体。收益：没有 Edge 的环境也能跑隔离模式，在 Chrome 上验证的页面不必再手工起 CDP。

本项原判定为**影响大 → 待决策**，已于 2026-11-08 决策采纳方案 B1；不是「单工具新增可选参数」。依据：

- 任务书硬约束 1 把「改既有工具语义」「回收口径」「载体定位」「多工具联动」列为影响大。本项同时命中「改既有工具语义」（`browser_e2e_start` 的参数表、返回字段与摘要文案）与「载体定位」（`0002-browser-launch-and-reuse.md`「边界」明文「只驱动系统 Edge（`BROWSER_CHANNEL` 固定为 `msedge`），不提供其他 channel 或可执行路径参数」；README 摘要与 `package.json` 的 description 同口径写「用系统 Edge」）。改的是「只驱动 Edge」这条已确认的定位，不是给一个已有维度加取值。
- 联动面：要新增跨调用不变量（载体重启语义）、把插件 `Config` 从六字段扩到七字段（`0006` 明文「共六个字段」）、改 `browser_e2e_start` 的返回契约（`0001` 的「能力函数返回值」表逐个字段列出）、改 README 多处；若同时要在面板显示载体，还要改 `0002-panel-protocol-v1.md` 的 `state` / `tabs` 契约与客户端 bundle。
- 回收口径**不变**是本项可以收窄影响的部分：隔离模式拉起的仍是 Playwright 管理的自有进程，`closeBrowser` 的强制结束兜底不改；CDP 接管仍只断连。这一点让推荐候选 B1 可以做到「默认路径逐字不变」，但不能改变上述判定。

## 决策记录

- 2026-11-08：采纳**方案 B1**（`browser_e2e_start` 新增 `carrier` 三值 + `Config.defaultCarrier` + 新建 `lib/carrier.js` 探测）；默认 `edge` 时参数、返回、摘要逐字不变；**不采纳** B2（面板显示载体）与 B3；`carrier` 只对隔离模式生效，CDP 忽略；工具参数不接受可执行路径，Chrome 路径只由 `DSH_BROWSER_CHROME_PATH` 与平台惯例位置决定（本机已确认 Chrome 与 Edge 均存在，可在真机验证）。本机 Chrome 位于 `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`。
- 状态为「已确认、实施待排期」：下文「方案 B1 的目标契约」是实现契约，当前代码未实现；验收第 1 组是实施前的回归基线。

## 行为

### 当前行为（缺口与既有边界）

- `browser_e2e_start` 的参数只有 `headless` / `proxy` / `viewportWidth` / `viewportHeight` / `mode` / `cdpEndpoint`（`lib/tools.js` 的 `buildToolTable` 里 `browser_e2e_start` 的 `parameters`），没有载体参数；描述首句写「启动浏览器（本机系统 Edge，headless 默认开启）」。
- `lib/session.js` 的 `launch`：`mode` 缺省取 `options.mode ?? defaults.mode`，只认 `cdp`，其余落 `isolated`；隔离分支 `chromiumImpl.launch({ channel: BROWSER_CHANNEL, headless, ignoreHTTPSErrors: true, ...(proxy ? { proxy: { server: proxy } } : {}) })`；返回 `{ reused: false, mode, headless, channel, version, viewport, tabs, artifactsDir, summary }`，摘要写死「系统 Edge」。
- 复用分支 `reuseInfo` 返回 `{ reused, mode, version, url, tabs, summary }`，摘要同样写死「系统 Edge」；`assertReuseCompatible` 只校验显式传入的 `mode` / `cdpEndpoint`。
- CDP 分支不读任何载体信息，摘要写死「系统 Edge」（`connectOverCDP` 不返回产品名），返回不带 `channel`。
- `lib/index.js` 的 `Config` 共六个字段（`defaultMode` / `cdpEndpoint` / 四个投屏参数），`launchDefaultsOf` 只放行 `mode` / `cdpEndpoint`。
- `lib/defaults.js` 只有 `DEFAULT_CDP_ENDPOINT`，没有载体相关常量。
- `lib/invariants.js` 没有载体一致性断言；`lib/session.js` 的 `assertReuseCompatible` 是唯一在复用时做参数一致性校验的地方。
- `lib/page.js` 的 `createPage` 只按 `session.mode` 选择 `session.context.newPage()` 或 `session.browser.newPage({ viewport })`，不感知载体；`lib/panel.js` 的 `state` 只输出 `mode` / `endpoint`；`lib/session.js` 的 `listPanelTabs` 每个 tab 只带 `mode` / `endpoint`。
- 既有功能规格 `0002-browser-launch-and-reuse.md` 的「边界」把「不提供其他 channel 或可执行路径参数」写成明确不处理项；`0006` 把 `Config` 固定为六字段。

### 方案 B1（已确认、实施待排期）

#### 工具与参数

扩展既有 `browser_e2e_start`，不新增工具。理由：载体是启动参数，与 `mode` / `cdpEndpoint` 同层；新增一个「先选载体再 start」的工具会引入跨调用状态与第二个真值来源，且在工具数量（当前 22）上制造无收益的变化。

| 参数 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `carrier` | string，枚举 `edge` / `chrome` / `auto` | 未给时取插件 `Config` 的 `defaultCarrier`，再缺省 `edge` | 仅隔离模式有效。`edge` 走 Playwright `channel: 'msedge'`（与现状一致）；`chrome` 用 `lib/carrier.js` 探测出的 Chrome 可执行文件走 `executablePath`；`auto` 按 `chrome` → `edge` 顺序取第一个可用的 |

- 根 schema 仍由 `params(...)` 生成：`additionalProperties: false`，`carrier` 不是必填。
- 非法取值（`number` / `boolean` / `null` / 其它字符串）报 `carrier 只支持 edge / chrome / auto，收到 {JSON.stringify(值)}`，在登记会话之前抛出，不留会话条目（与 `mode` 的既有校验同口径）。
- 不开放「任意可执行路径」给模型：插件 `Config` 增加 `defaultCarrier` 只是枚举值；Chrome 路径探测支持环境变量覆盖（`DSH_BROWSER_CHROME_PATH`），不新增工具参数接受路径。理由：接受模型传入的任意路径等于在本机执行任意程序，与 README「不提供可执行路径参数」的安全取舍冲突，且超出一个端到端验证插件的范围。
- `carrier` 与 `mode: 'cdp'` 同时给：不报错，忽略 `carrier`，并在工具文本里追加一行 `CDP 模式载体由接管端点决定，carrier 参数不参与。`；返回不带 `carrier` 字段（保持 CDP 分支既有返回形状）。

#### 载体解析（`lib/carrier.js`，新建）

- 常量：`CARRIERS = ['edge', 'chrome', 'auto']`、`DEFAULT_CARRIER = 'edge'`、`CARRIER_LABELS = { edge: '系统 Edge', chrome: '系统 Chrome', auto: '自动' }`。
- `carrierLabel(carrier)` 返回中文展示名；未知值按 `edge` 处理。
- `detectCarrier(carrier, env = process.env, platform = process.platform)` 返回 `{ kind: 'edge'|'chrome', executablePath?: string }`：
  - `edge`：直接返回 `{ kind: 'edge' }`，调用方用 `channel: 'msedge'`，不做文件探测（与现状零差异，避免误把用户安装的 Edge Beta 当稳定版）。
  - `chrome`：按三级顺序找 Chrome 可执行文件——`DSH_BROWSER_CHROME_PATH`（非空且文件存在）→ PATH 上的 `chrome`（Windows 补 `.exe`）→ 平台惯例安装位置（Windows：`%ProgramFiles%\Google\Chrome\Application\chrome.exe`、`%ProgramFiles(x86)%\...`、`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`；macOS：`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`；Linux：`/usr/bin/google-chrome-stable`、`/usr/bin/google-chrome`、`/opt/google/chrome/chrome`）。命中返回 `{ kind: 'chrome', executablePath }`。
  - `auto`：先按 `chrome` 探测，命中即返回；否则返回 `{ kind: 'edge' }`。
  - 全部落空：抛 `本机没有找到 Google Chrome（查过：{searchSummary('chrome') 的列表}）；请安装 Chrome、在插件设置里把 defaultCarrier 改为 edge，或设置 DSH_BROWSER_CHROME_PATH 指向 chrome.exe`。
- `searchSummary(kind)` 返回本次实际检查过的名称与展开后的绝对路径（用户能照着去文件管理器核对），错误文案与诊断复用同一份。

#### 启动、返回与摘要

- `lib/session.js` 新增内部 `carrierOf(value)`：只认 `edge` / `chrome` / `auto`，其余按 `edge`（入参非法已在 `launch` 入口报错，这里只做缺省归一）。
- `launch` 隔离分支：`const requested = carrierOf(options.carrier ?? defaults.carrier)`，`const resolved = detectCarrier(requested)`；`chromiumImpl.launch({ ...(resolved.kind === 'edge' ? { channel: BROWSER_CHANNEL } : { executablePath: resolved.executablePath }), headless, ignoreHTTPSErrors: true, ...(proxy ? { proxy: { server: proxy } } : {}) })`。
- `session.carrier` 写实际落地的 `'edge' | 'chrome'`（`auto` 记录解析结果）；`session.mode` 不变；`session.channel` 不新增字段（`channel` 只保留给返回里的 Playwright 取值）。
- 隔离分支返回追加 `carrier`（`'edge' | 'chrome'`）；`summary` 从 `启动浏览器 系统 Edge ${version}（…）` 改为 `启动浏览器 ${carrierLabel(carrier)} ${version}（…）`。`edge` 载体时字符串与现状逐字相同。
- 复用分支 `reuseInfo` 追加 `carrier`；摘要从 `浏览器已启动（${mode === 'cdp' ? 'CDP 接管' : '隔离'}模式，系统 Edge ${version}，N 个标签页）` 改为 `…${mode === 'cdp' ? 'CDP 接管' : '隔离'}模式，${carrierLabel(session.carrier)} ${version}，N 个标签页）`；`edge` 时逐字不变，CDP 时保持 `系统 Edge`。
- 热切换：`assertReuseCompatible` 在既有 `mode` / `cdpEndpoint` 校验之后加 `if (options.carrier !== undefined) assertCarrierNotHotSwitched(session.carrier, carrierOf(options.carrier))`。只对显式传参生效（插件配置默认值不参与，与既有口径一致）；`auto` 也先解析成具体载体再比较，解析结果与当前不同即报错（不静默换浏览器）。

#### 状态与进程

- 会话：新增 `session.carrier` 字段；状态机、`pages` / `activeTabId` / `viewport` / `artifactsDir` 不变；0 页补建路径不变。
- 标签页：条目结构不变，`origin` 仍为 `created`；面板 tab 不新增字段（B1）。
- 进程：隔离模式仍是 Playwright 拉起的自有进程，`closeBrowser` 的超时强制结束兜底不改；被拉起的 Chrome 使用一次性 profile，不复用用户正在运行的 Chrome 实例、不读取用户登录态（与 `mode: 'cdp'` 的区别要在 README 写明）。
- 面板：B1 不改 `lib/protocol.js` / `lib/panel.js` / `client/index.js`，`state` 仍只有 `mode` / `endpoint`，面板看不出载体；这是本项刻意的范围裁剪。

### 候选方案

- **B0：维持现状**（不实现）。零风险，但 Chrome 用户与无 Edge 环境继续只能用 CDP 接管。
- **B1：`carrier` 三值 + `Config.defaultCarrier` + 新建 `lib/carrier.js` 探测**（已采纳）。默认 `edge` 时行为与摘要逐字不变；面板与协议零改动；回收口径不变。
- **B2：B1 + 面板显示载体**。`lib/protocol.js` 的 `state` 与 `tabs` 项增加 `carrier` 字段，`lib/panel.js` 透传，`client/index.js` 工具条 chip 显示，重建 `lib/client.js`，同步项目规格 `0002` 与 `tests/panel.mjs`。收益是可解释「现在驱动的是哪个浏览器」，代价是协议契约变更 + 客户端构建。
- **B3：对齐 wqty123 的完整载体面**（内置 Electron / 桌面侧栏 / 桌面桥 / `auto` 实时切换 / 载体就绪状态 / 缺失态载体）。本仓是 `dsh web` 插件，面板是只读 WebSocket 视图，没有 Electron 宿主 API 与安装器；引入要新增运行时依赖与宿主能力探测，超出本仓定位。**不建议**。

## 边界

- 不提供「内置 Chromium」：本仓依赖 `playwright-core`，不自带浏览器二进制，也没有下载浏览器的安装步骤；`channel: 'chromium'` 依赖完整 `playwright` 的浏览器注册表，本仓不可用。要支持内置载体必须换依赖或加下载器，属 B3。
- 不做桌面侧栏 / Electron 宿主 / 桌面桥载体：本仓没有 Electron 宿主通道（面板是浏览器 WebSocket + 只读投屏），与 wqty123 的形态不同。
- 不做载体实时热切换：已启动后传不同 `carrier` 直接报错，必须 `browser_e2e_close` 后重开。理由：本仓的 `close` 是唯一回收路径（含强制结束进程兜底与面板 `closed` 广播），热切换要在一处同时释放旧进程、重建页面、失效 ref 表与事件环，并处理并发工具调用，属于另一项规格。
- 不让工具参数接受可执行路径：Chrome 路径只由 `DSH_BROWSER_CHROME_PATH` 或平台惯例位置决定；`Config` 只增加枚举 `defaultCarrier`。
- `carrier` 只对隔离模式生效：CDP 的浏览器由用户自己启动，产品名不可知，摘要继续写「系统 Edge」；不因为 `carrier` 改变接管端点校验（仍只允许 loopback / http）。
- 无头与代理不受影响：`headless` / `proxy` 仍只对隔离模式生效，`carrier` 与它们不互斥。
- 并发：同一 key 的并发 `launch` 以先落定者的载体为准；后到者若显式传了不同 `carrier`，在落定后由 `assertReuseCompatible` 报错，不并行拉起第二个浏览器。
- 探测在 `launch` 内同步执行（几次 `existsSync`），不设超时与取消；探测失败不留半初始化会话（抛错发生在 `chromiumImpl.launch` 之前，`launch` 的 `finally` 按 `launchFailed` 回 `idle`）。
- 除 `lib/invariants.js` 新增的那条断言外不新增断言；非法 `carrier`、Chrome 缺失属「单次」入参 / 环境校验，留在 `launch` 入口；只有「已启动后换载体」是跨调用状态，进 `invariants.js`。

## 验收

### 1. 决策期间的回归基线（当前代码可执行）

- `node tests/invariants.mjs`（不启浏览器）：exit 0、输出无 FAIL。相关既有用例：`状态全集为 idle / launching / ready / closing / closed`、`assertModeNotHotSwitched：不一致的两个方向都报错`、`assertEndpointNotHotSwitched：端点不一致报错并带两端点`、`隔离模式 newPage 抛错：launch 失败、状态回 idle 并关闭浏览器`、`复用路径 0 标签页（isolated）：自动补建一页并返回成功`。
- `node tests/tools.mjs`（真起无头 Edge）：exit 0、输出无 FAIL。相关既有用例：`启动成功且有 summary`、`工具表共 22 个（含 read / dialog）`、`msedge 主进程回落到运行前基线`。
- `node tests/panel.mjs`（真起无头 Edge）：exit 0、输出无 FAIL。相关既有用例：`browser_e2e_start 的 mode 参数声明枚举`、`配置 defaultMode=cdp 被首次启动消费`、`未提供配置时默认 isolated`、`配置默认值不让已启动会话报 mode 不一致`、`tab 带 mode / endpoint 字段（isolated 时 endpoint 为空串）`。
- `node tests/cdp.mjs`（需要本机 Edge；找不到时脚本打 SKIP 并以 0 退出）：exit 0、无 FAIL。
- `npm run test:unit` 与 `npm run test:integration`：exit 0、输出无 FAIL（进程类断言以回落到运行前基线为准）。

### 2. 决策记录（Lead 录入后）

- `specs/项目规格/0003-未处理项.md` 存在本项（P2-25）的待决策行。判定命令：
  `pwsh -NoProfile -Command "if (Select-String -Path 'specs\项目规格\0003-未处理项.md' -Pattern 'P2-25') { exit 0 } else { exit 1 }"`，exit 0。

### 3. 决策通过并采纳 B1 后的实施验收

- `node tests/carrier.mjs`（由 tester 新建，用例名由本规格固定）：exit 0、输出无 FAIL。
  - 纯函数（注入假 `chromium` 与假 `env` / `platform`，不启浏览器）：`detectCarrier：edge 不探测文件直接返回 edge`、`detectCarrier：chrome 命中 DSH_BROWSER_CHROME_PATH`、`detectCarrier：chrome 命中 PATH`、`detectCarrier：chrome 命中平台安装位置`、`detectCarrier：auto 优先 chrome、无 Chrome 时回退 edge`、`detectCarrier：都找不到时报错并列出查过的位置`、`carrier 非法值报错且不登记会话`、`carrier=edge 时 launch 传 channel=msedge`、`carrier=chrome 时 launch 传 executablePath 而不是 channel`、`默认不传 carrier 时启动摘要与既有逐字一致`、`carrier=chrome 的启动摘要写系统 Chrome`、`复用返回带 carrier 且摘要含载体名`、`已启动后传不同 carrier 报热切换错误`、`显式 auto 解析结果与当前不同时报热切换错误`、`CDP 模式忽略 carrier 且返回不带 carrier`。
  - 真机（可选，按 `tests/cdp.mjs` 的 SKIP 口径：找不到浏览器时打印 SKIP 并以 0 退出）：`本机装有 Chrome 时 carrier=chrome 启动成功`、`未装 Chrome 时错误文案列出搜索位置`。
- `node tests/invariants.mjs`：exit 0、无 FAIL。新增用例名：`assertCarrierNotHotSwitched：两个方向都报错并带载体名`、`carrier 不进入会话状态机（转移表与 carrier 无关）`。
- `node tests/tools.mjs`：exit 0、无 FAIL。新增断言名：`browser_e2e_start 的参数表含 carrier 枚举`、`默认启动仍拉起 msedge（carrier 缺省为 edge）`。
- `node tests/panel.mjs`：exit 0、无 FAIL。新增断言名：`browser_e2e_start 的 carrier 参数声明枚举`、`工具总数不因本项变化`（B1 不新增工具；数字按当时 `tests/panel.mjs` 的实测值同步，不写死为 22 或 23）。
- `node tests/cdp.mjs`：exit 0、无 FAIL。新增用例名：`CDP 模式忽略 carrier 参数`。
- `npm run test:unit` 与 `npm run test:integration`：exit 0、输出无 FAIL。
- 客户端未变：`pwsh -NoProfile -Command "git status --porcelain lib/client.js lib/protocol.js lib/panel.js client/index.js"` 输出为空（B1 不改协议与面板）。若决策采纳 B2，本条改为「上述文件有预期改动，且 `node scripts/build-client.mjs` 重建后 `node tests/invariants.mjs` 与 `node tests/client-bundle.mjs` exit 0」。
