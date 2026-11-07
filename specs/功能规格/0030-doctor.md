# 环境诊断（doctor）

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表、依赖方向、会话状态机、进程回收；本项不新增不变量）；specs/项目规格/0002-panel-protocol-v1.md（不新增命令 / 事件 / 错误码）；specs/功能规格/0002-browser-launch-and-reuse.md（启动缺省值、`mode` 与端点校验的既有口径）；specs/功能规格/0006-plugin-config-and-live-apply.md（插件配置默认值的只读来源）；specs/功能规格/0008-cdp-attach.md（接管端点只允许 loopback http 的既有口径）；README.md「浏览器启动与模式」「环境变量与产物目录」
代码: lib/doctor.js / lib/session.js / lib/capture.js / lib/tools.js / tests/doctor.mjs

## 需求

浏览器起不来时，现在只有一次失败的 `browser_e2e_start` 与它带出的单条错误文本：模型无法区分「没装 Edge」「CDP 端点没在监听」「环境变量写脏」还是「会话已被别的调用关掉」，只能逐项试错或把原始报错甩给用户。本功能新增 `browser_e2e_doctor`：一次调用给出六项环境检查的结构化报告（每项 `OK` / `WARN` / `FAIL` / `SKIP` + 一句证据 + 修法），不启动浏览器、不改任何状态。

## 行为

### 输入

工具 `browser_e2e_doctor`，参数全部可选：

| 参数 | 类型 | 约束 | 缺省 |
|---|---|---|---|
| `mode` | string | `isolated` / `cdp` | 插件配置 `defaultMode`，未配置时 `isolated` |
| `cdpEndpoint` | string | 非空；必须 http + loopback（校验复用启动路径的 `normalizeCdpEndpoint`） | 插件配置 `cdpEndpoint`，未配置时 `lib/defaults.js` 的 `DEFAULT_CDP_ENDPOINT` |
| `probeTimeoutMs` | integer | 100-10000 | 1500 |

- `mode` / `cdpEndpoint` 的缺省值来自 `lib/tools.js` 注入的 `launchDefaults()`（`browser_e2e_start` 用的同一个 getter），因此设置页保存后无需重载插件即可读到新值。
- 只有入参非法才抛错，文案与启动路径一致：`mode 只支持 isolated / cdp，收到 <JSON 值>`、`probeTimeoutMs 必须是 100..10000 的整数，收到 <值>`。`cdpEndpoint` 非法**不抛错**，作为 `cdp` 项 `FAIL` 报出（诊断工具不能因为被诊断对象坏了就失败）。
- 一次调用固定输出六项检查，按 `runtime` → `edge` → `cdp` → `session` → `paths` → `env` 顺序；同一 `id` 只出现一行。

### 检查项

| id | 查什么 | `OK` | `WARN` / `FAIL` / `SKIP` |
|---|---|---|---|
| `runtime` | `process.version` / `platform` / `arch`；插件版本（包内 `package.json`）；`playwright-core` 版本 | `Node <v>（<platform> <arch>）；插件 <ver>；playwright-core <ver>` | `playwright-core` 解析失败：`FAIL`；插件版本读取失败：`WARN`（其余字段照报） |
| `edge` | 系统 Edge 可执行文件，判据与 Playwright `channel: 'msedge'` 的解析规则一致（见「边界」） | 命中路径 | 全部候选不存在：`FAIL`；平台不在 win32 / darwin / linux：`SKIP` |
| `cdp` | 端点归一 + TCP 连得上 + `GET /json/version` 是 CDP 端点 | `<endpoint> 可接管（<Browser>）` | 端点非法或连不上：`FAIL`；端口通但不是 CDP：`WARN`；`mode` 为 `isolated`：`SKIP` |
| `session` | 本会话在注册表里的只读视图（`peekSession`） | 未启动：`本会话未启动浏览器（工具调用时按需启动）`；运行中：`<mode> 模式运行中，<n> 个标签页，连接正常` | `launching` / `closing`：`WARN`；`ready` 但 `browser.isConnected()` 为 false：`FAIL` |
| `paths` | 产物根目录可写；下载目录（`DSH_BROWSER_DOWNLOAD_DIR`）合法 | 根目录可写 + 下载目录 | 根目录不可写、下载目录不是绝对路径：`FAIL` |
| `env` | `DSH_BROWSER_IDLE_MS`、`DSH_BROWSER_CLOSE_TIMEOUT_MS`、`DSH_BROWSER_PROXY` 的合法性 | 三项合法（含「未设置」） | 空闲回收非法：`FAIL`；关闭兜底或代理非法：`WARN` |

细节判据：

- `edge`：Windows 依次尝试 `process.env.LOCALAPPDATA`、`PROGRAMFILES`、`PROGRAMFILES(X86)`、`process.env.HOMEDRIVE + '\Program Files'`、`process.env.HOMEDRIVE + '\Program Files (x86)'` 五类前缀，每类拼 `\Microsoft\Edge\Application\msedge.exe`，取第一个存在的文件；darwin 查 `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`；linux 查 `/opt/microsoft/msedge/msedge`。**不读 `EDGE_PATH`**（该变量只被 `tests/cdp.mjs` 使用，Playwright 启动时不读它，纳入会造成「doctor 说能起、start 起不来」的假通过）。
- `cdp`：只有 `mode` 为 `cdp` 才探测。先按 `normalizeCdpEndpoint` 归一（非法直接 `FAIL`，文案沿用启动路径原文），再对 `<host>:<port>` 建 TCP 连接（上限 `probeTimeoutMs`），连上后 `GET /json/version`（同一上限），要求响应为 JSON 且含字符串 `webSocketDebuggerUrl`。`Browser` 字段存在时展示它。探测只读，不建立 CDP 会话、不占用浏览器、不关页面。
- `session`：`peekSession(key)` 是注册表的只读视图（`state` / `mode` / `endpoint` / `pages` / `activeTabId` / `connected` / `artifactsDir`），**不创建会话、不刷新空闲计时**。报告末尾在本进程还有别的会话持有浏览器时追加 `；本进程另有 <n> 个会话持有浏览器`。
- `paths`：产物根目录是 `~/.dsh/browser-e2e/artifacts`（`lib/capture.js` 的 `artifactsRoot()`，与 `ensureArtifactsDir` 同一份定义）。根目录已存在时写入并立即删除一个探针文件 `<root>/.doctor-probe`，这是本工具唯一的写操作；不存在时沿祖先链找最近存在的目录，判其可写并在报告里写 `尚未创建；父目录 <ancestor> 可写（首次启动时创建）`。下载目录取 `DSH_BROWSER_DOWNLOAD_DIR`（必须绝对路径，判据与 `lib/download.js` 的 `downloadDirFor` 一致）；未设置时写 `默认（<会话产物目录或产物根目录>/downloads/，启动后派生）`。
- `env`：`DSH_BROWSER_IDLE_MS` 必须是「未设置」或非负整数；`DSH_BROWSER_CLOSE_TIMEOUT_MS` 必须是「未设置」或正整数；`DSH_BROWSER_PROXY` 必须是「未设置」或能解析出 http(s) 协议与主机。报告里的生效值取自 `lib/session.js` 导出的 `IDLE_CLOSE_MS` / `CLOSE_TIMEOUT_MS`（模块加载时按同一表达式算出的值），并标明是默认值还是环境变量给的。

### 输出

工具返回一段文本（与其余只读工具一致，无自定义 output schema）。首行统计，其后每项一行，非 `OK` 项各带一行修法，末行结论：

```
环境诊断：共 6 项，5 通过 / 0 警告 / 1 失败 / 0 跳过（模式 cdp，端点 http://127.0.0.1:9222）
[OK] runtime：Node v24.11.0（win32 x64）；插件 0.2.0；playwright-core 1.63.0
[OK] edge：C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
[FAIL] cdp：http://127.0.0.1:9222 连不上（ECONNREFUSED，152ms）
   修复：用 msedge.exe --remote-debugging-port=9222 --user-data-dir=<非默认目录> 启动浏览器后重试；Chrome/Edge 136+ 对默认数据目录忽略该开关
[OK] session：本会话未启动浏览器（工具调用时按需启动）
[OK] paths：产物根目录 C:\Users\<user>\.dsh\browser-e2e\artifacts 尚未创建；父目录 C:\Users\<user>\.dsh 可写（首次启动时创建）；下载目录 默认（<产物根目录>/downloads/，启动后派生）
[OK] env：空闲回收 600000ms（默认）；关闭兜底 5000ms（默认）；代理 未设置
结论：先修 [FAIL] 项再 browser_e2e_start（本工具不启动浏览器、不改任何状态）。
```

- 行格式固定为 `[<STATUS>] <id>：<detail>`，`STATUS` ∈ `OK` / `WARN` / `FAIL` / `SKIP`（大写，半角方括号，`id` 与 detail 之间是中文冒号）；修法行固定为三个空格 + `修复：` + 文本。
- 首行统计固定为 `环境诊断：共 6 项，<ok> 通过 / <warn> 警告 / <fail> 失败 / <skip> 跳过（模式 <mode>，端点 <endpoint>）`。
- 末行按最严重项给结论：有 `FAIL` 时 `结论：先修 [FAIL] 项再 browser_e2e_start（本工具不启动浏览器、不改任何状态）。`；只有 `WARN` 时 `结论：无阻塞项；[WARN] 项可能导致后续调用异常（本工具不启动浏览器、不改任何状态）。`；全部 `OK` / `SKIP` 时 `结论：环境就绪，可以直接 browser_e2e_start（本工具不启动浏览器、不改任何状态）。`
- 面板动作摘要取首行（`summaryOf` 对字符串取首行），无需改协议。

### 失败形态

- 入参非法（`mode` 非枚举、`probeTimeoutMs` 非整数或越界）：抛错，无部分报告。
- 环境问题一律不抛错：六项照报，问题项由 `STATUS` 与修法行表达；这是与 `browser_e2e_start` 的分工（start 必须失败，doctor 负责解释为什么）。
- `peekSession` 拿到的会话在诊断期间被关闭：`session` 项按当时快照报 `WARN`（`会话正在 closing` 或 `已关闭`），不让整份报告失败。

### 状态变化

- 会话：不变。不创建会话条目、不改 `state` / `pages` / `activeTabId` / `artifactsDir`、不刷新空闲计时（诊断本身不会续命浏览器）。
- 标签页 / 面板 / 协议：不变；成功与失败各产生一条既有 `action` 事件。不改 `lib/protocol.js`、`lib/panel.js`、`client/index.js`，无需重建 `lib/client.js`。
- 浏览器进程：不启动、不接管、不关闭。唯一的副作用是 `paths` 项在已存在的产物根目录里写一个探针文件并立即删除。

## 边界

- **不启动浏览器**：doctor 不调 `chromium.launch` / `connectOverCDP`，因此不能证明「Edge 一定能起」。`edge` 项只按 Playwright 同一条路径规则判断可执行文件是否存在。Playwright 升级若改变 `channel: 'msedge'` 的前缀顺序，doctor 可能误报 `OK`；报告里给出实际命中的路径，作为排查锚点。
- **不安装、不下载、不修复**：不同于 anweat 的 `runtime.install`（下载 Chromium，600 秒超时、需要 `install` 审批）与 Fisfzy `ego_doctor` 只体检不安装的取舍——本项只报告，安装与修复留给用户。
- **「profile 被占用」不单独探测**：隔离模式每次用 Playwright 一次性临时 profile（`playwright_chromiumdev_profile-*`），不存在被占用的路径；CDP 模式下用户的浏览器在插件连上之前就已经启动或没启动，占用/忽略调试开关表现为「端口连不上」，因此该场景由 `cdp` 项的修法文案覆盖，不新增进程扫描（要扫进程就得起子进程，且与「零副作用」冲突）。
- **CDP 探测不建会话**：只做 TCP + 一次 `GET /json/version`。不做 `connectOverCDP`，否则会与用户浏览器建立真实连接、可能触发接管副作用，也会与正在运行的会话抢同一个端点。
- **只探 loopback**：端点沿用启动路径的校验（`http` + loopback），因此远端 CDP 端点仍然不支持；`cdp` 项的修法文案与 `0008-cdp-attach.md` 一致，不引入新口径。
- **代理只校验格式，不探活**：`DSH_BROWSER_PROXY` 写错协议会在这里被指出，但代理端口是否可用不探测（探活失败不等于启动失败，且会引入额外网络请求）。
- **目录可写判定只在根目录已存在时写探针**：根目录不存在时用最近祖先的 `fs.access(W_OK)`，Windows 上该 API 对目录 ACL 判定不精确，属已知限制；不可写分支无法在 Windows 上用 `chmod` 稳定构造，tester 不要求覆盖。
- **环境变量在模块加载时生效**：`lib/session.js` 的 `IDLE_CLOSE_MS` / `CLOSE_TIMEOUT_MS` 在 import 时求值；doctor 报的是这两个生效值加当时 `process.env` 的原始串。进程运行中改环境变量不会改变已加载的值，报告以生效值为准。
- **只诊断本会话**：不列出其它会话的浏览器（只给「另有 N 个会话」计数），不诊断宿主、profile、网络、防火墙。
- 权限门控尚未实现（P1-14 待决策）：本工具只读，不引入白名单 / 豁免概念。
- 不做：安装 Edge、清理残留进程、重置会话、自动重试 `start`、生成诊断压缩包、把报告写文件。

## 验收

1. `node tests/doctor.mjs` 退出码 0 且无 `FAIL`（该文件由 tester 新建，用例名由本规格固定，全部不启动浏览器）：
   - 报告骨架：`doctor 报告首行是统计行`、`doctor 报告固定六项且每项一行`、`doctor 非 OK 项各带一行修复`、`doctor 结论行按最严重项`。
   - `runtime` / `edge`：`doctor runtime 报告 Node 与插件与 playwright-core 版本`、`doctor edge 按 Playwright 的 msedge 候选前缀命中注入路径`、`doctor edge 全部候选不存在时失败并给出首个查找位置`、`doctor edge 非支持平台时跳过`。
   - `cdp`：`doctor cdp 在 isolated 模式跳过并提示传 mode=cdp`、`doctor cdp 端点可达且 /json/version 合法时通过`、`doctor cdp 端口可通但不是 CDP 时警告`、`doctor cdp 端口连不上时失败`、`doctor cdp 请求超时在 probeTimeoutMs 内返回`、`doctor cdp 非 loopback 端点失败并复用启动错误原文`、`doctor cdp 非 http 端点失败`。
   - `session`：`doctor session 未启动时报未启动`、`doctor session 已启动时报模式与标签页数`、`doctor session 连接失效时报失败`、`doctor session 处于 launching 时报警告`、`doctor 不创建会话也不刷新空闲计时`。
   - `paths`：`doctor paths 报告产物根目录与下载目录`、`doctor paths 根目录不存在时沿祖先链判定`、`doctor paths 下载目录非绝对路径时失败`。
   - `env`：`doctor env 默认值正常`、`doctor env 空闲回收非法时失败`、`doctor env 关闭兜底非法时警告`、`doctor env 代理缺协议时警告`、`doctor env 代理合法时不报警`。
   - 入参与工具表：`doctor 工具定义在工具表里且参数 schema 正确`、`doctor 非法 mode 报错`、`doctor probeTimeoutMs 越界报错`、`doctor 汇总摘要被 summaryOf 采用`。
2. `node tests/panel.mjs` 退出码 0：`工具表共 <N> 个`（N 取本次合并后的实际工具数）与「注册的工具与工具表逐项一致」通过；`作用于页面的工具都接受 tab_id` 不含 `doctor`（doctor 无 `tab_id`）。判定：exit 0、输出无 `FAIL`。
3. `node tests/tools.mjs` 退出码 0：`注册的工具与工具表逐项一致`、`工具表共 <N> 个（含 read）`、`工具名唯一且统一带 browser_e2e_ 前缀` 与参数契约用例通过，既有用例不回退。判定：exit 0、输出无 `FAIL`。
4. `npm run test:unit` 退出码 0。
5. `npm run test:integration` 退出码 0（串行真起无头 Edge；进程类断言以回落到运行前基线为准）。
6. 手工冒烟（真机）：未启动任何带调试端口的浏览器时调用 `browser_e2e_doctor { mode: "cdp" }`，报告含 `[FAIL] cdp：` 与以 `用 msedge.exe --remote-debugging-port=` 开头的修法行，且调用前后 `browser_e2e_tabs` 仍报「浏览器尚未启动」。
