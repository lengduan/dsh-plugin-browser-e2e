# 动作历史持久化与脱敏

状态: 已实现（仅 A 切片）；B（宿主动作环 + `actions` 事件）与 C（面板显示脱敏摘要）已否决（2026-11-08）
关联: specs/项目规格/0001-architecture-invariants.md（模块表新增 `lib/history.js`、依赖方向、验收命令）；specs/项目规格/0002-panel-protocol-v1.md（`action` 事件载荷、面板只读定位——本项一律不改）；specs/项目规格/0003-决策记录.md #5（宿主侧动作环 + `actions` 事件属协议增量，待决策，本项不做）；specs/功能规格/0006-plugin-config-and-live-apply.md（`Config` 九项，本项不新增配置项）；specs/功能规格/0032-panel-history-direct-control.md（面板抽屉只在前端内存、不脱敏，本项是另一条读回通道）；specs/功能规格/0007-click-fill-targets.md、0022-dialog-handling.md（`fill` / `dialog` 的摘要形状是脱敏规则的输入）
代码: lib/history.js / lib/index.js / lib/tools.js / tests/invariants.mjs / tests/panel.mjs

## 需求

排障要回答「刚才那几步到底填了什么、点在哪、什么时间」。现在面板只在内存里留最近 5 条动作提示（`client/index.js` 的 `ACTION_LIMIT`），P2-23 的抽屉也只是同一份前端内存放大到 50 条（`0032`）；浏览器一关、面板一刷新、插件一重载，动作序列就没有了，也没有任何落盘副本可供事后核对。

本规格把动作历史落成宿主侧的一件事：每次 `browser_e2e_*` 工具调用结束（成功或失败）向一个 append-only JSONL 文件追加一条记录，**写入前**按工具身份脱敏用户输入，再用新工具 `browser_e2e_history` 读回。收益是失败复盘不再依赖会话上下文，且磁盘上不留明文输入。竞品 wqty123 把这分成两半——`dsh_browser_history` 是内存操作日志（500 条、渲染最近 20 条、输出脱敏），持久化那份是浏览轨迹（`HistoryStore`，独立 JSONL）；本规格只取「动作历史 + 落盘 + 脱敏」，不做浏览轨迹（`navigate` 摘要已带目标地址）。

## 行为

### 记录（写入方：`lib/index.js` 的工具注册包装）

- 每个 `browser_e2e_*` 工具调用写一条，成功与失败都写；`browser_e2e_history` 自身不写（避免读历史这个动作反复进入历史）。
- 记录形状 `{seq:number, at:number, tool:string, ok:boolean, summary:string, session?:string}`：
  - `seq`：同一文件内单调递增。进程内首次写该文件时从「文件最后一条的 `seq` + 1」起算；文件不存在从 1 起。不做跨进程去重。
  - `at`：`Date.now()`，与 `action` 事件的 `trace.at` 同口径。
  - `summary`：成功取 `lib/tools.js` 的 `summaryOf(value)`（既有摘要口径），失败取 `失败：<message>`（与 `action` 事件逐字一致）；写入前先脱敏、再截到 `HISTORY_SUMMARY_LIMIT`（500 个 UTF-16 码元），超出追加 `...(已截断)`。
  - `session`：`lib/tools.js` 的 `sessionKey(exec)`，非空字符串才写；用于读回的默认隔离。
- 写入方不持久化工具入参（`args` 只用于计算脱敏，不落盘），也不持久化返回值。

### 存储位置与保留

- 路径：`lib/history.js` 的 `actionHistoryPath()` 默认 `~/.dsh/browser-e2e/history/actions.jsonl`（与 `lib/capture.js` 的 `ensureArtifactsDir` 同一个 `~/.dsh/browser-e2e/` 根，另立 `history` 子目录，不混进按启动时间分桶的 `artifacts`）。`DSH_BROWSER_HISTORY_FILE` 给绝对路径时以它为准（测试与多实例隔离用），路径不是绝对路径时按默认路径处理。
- 首次写入时 `mkdir` 建目录；POSIX 上目录 0o700、文件创建时 0o600（Windows 上无效果，不额外断言）。
- 上限：`HISTORY_MAX_ENTRIES`（2000，`DSH_BROWSER_HISTORY_MAX` 覆盖为正整数时生效）与裁剪余量 `HISTORY_PRUNE_SLACK`（200）。追加后已写条数超过「上限 + 余量」时整份重写为最后 `上限` 条：写同目录临时文件再 `rename` 覆盖；重写失败保留原文件，计数不清零，等下一次追加重试。
- 不做按天过期、不做压缩、不做导出。

### 开关

- `DSH_BROWSER_HISTORY=0` 时 `appendAction` 直接返回 `null`，不建目录、不写文件；读回不受影响（既有文件仍可读）。

### 脱敏（唯一执行点：写入前，`lib/history.js` 的 `redactActionSummary`）

- 规则表 `SENSITIVE_ARGS`：`browser_e2e_fill` → `['value']`；`browser_e2e_dialog` → `['prompt_text']`。取值来自本次调用的工具入参，不经摘要反解析。
- 对每个非空字符串字段值，把摘要里**所有**出现替换成 `[已脱敏 N 个字符]`（N 按 Unicode 码点计）。替换用 `split` / `join`，不走正则，避免值里的正则元字符与引号导致漏配。
- 规则的理由：`lib/page.js` 的 `fill` 摘要形如 `填写 <目标> <- "<value>"` 与 `逐键填写 <目标> <- "<value>"（…）`，`setDialogPolicy` 的摘要形如 `对话框策略已设为 accept（自动确认，prompt 文本 "<prompt_text>"）`——现有工具里只有这两处把用户输入原样放进摘要。例：`填写 @3 (input "密码") <- "[已脱敏 6 个字符]"`（只替换值本身，摘要原有的包裹引号保留）。
- 脱敏只作用于落盘副本与 `browser_e2e_history` 的读回文本；`action` 事件载荷、面板显示、工具返回值一律不变。

### 读回（新工具 `browser_e2e_history`，`lib/tools.js` 的常量 `HISTORY_TOOL_NAME`）

- 参数：
  - `limit`：integer，1-200，默认 20。非整数或 ≤0 回退默认，超出 200 截到 200（与 `lib/page.js` 的 `consoleEntries` / `networkEntries` 的 limit 口径一致，不抛错）。
  - `tool`：string，可选，按工具名精确过滤（如 `browser_e2e_fill`）。
  - `ok`：boolean，可选，只取成功（`true`）或失败（`false`）。
  - `scope`：枚举 `self` / `all`，默认 `self`；`self` 只看 `session` 等于本次调用 `sessionKey(exec)` 的记录，`all` 不过滤会话。
- 返回（`textOutput` 的字符串，首行为摘要）：
  - 有记录：首行 `动作历史 N 条（共 M 条${过滤说明}）`，第二行 `文件：<绝对路径>`，之后每条一行 `#<seq> <HH:MM:SS.mmm> <tool> <summary>`，最新在前。`过滤说明` 为 `；tool=…` / `；ok=…` / `；scope=all` 中实际生效部分的拼接，没有过滤项时为空。`M` 是保留窗口内的有效记录数（超过 `HISTORY_MAX_ENTRIES` 时按最近 2000 条算），`N` 是本次返回条数。
  - 文件里没有任何记录（`total === 0`）：只有一行 `还没有动作记录（文件：<绝对路径>）`，没有条目行。
  - 有记录但过滤后零命中（`total > 0` 且 `count === 0`）：首行 `动作历史 0 条（共 M 条${过滤说明}）`、第二行文件行、第三行 `（没有匹配的记录）`。
  - 读文件失败（非「文件不存在」）：按无记录返回，并在首行后追加一行 `读取历史失败：<message>`；不抛错、不改任何状态。
  - 时间显示复用 `lib/page.js` 的 `timeOf`（把 `at` 换成 ISO 后再取，得到 UTC 的 `HH:MM:SS.mmm`），与 console / network 记录同口径；摘要单行化复用 `oneLine`。
- 无浏览器依赖：未启动、已关闭、`isolated` / `cdp` 都可用同一份读回；不调用 `session.touch`，不建会话条目。

### 状态变化

- 会话 / 标签页 / 浏览器进程 / 面板 / 投屏 / 协议：全部不变。
- 磁盘：新增（或追加）一个历史文件；它是本规格唯一的持久化产物。
- 记录失败（目录不可写、磁盘满、JSON 序列化异常）只吞掉错误，工具调用照常返回原结果；读回退化为空/旧数据。

## 边界

- 脱敏只覆盖 `fill` 与 `dialog` 两个已知把输入放进摘要的工具。新增工具若在摘要里回显输入，必须同时扩 `SENSITIVE_ARGS`——这是维护约束，代码不自动识别（测试只钉现有两个工具的真实摘要形状）。
- `navigate` / `wait` 摘要可能带 URL 查询参数（如 `?token=…`），本规格不脱敏：脱敏会破坏 URL 可读性，取舍是「默认 `scope=self` 限制可见范围」。要更严需另立规格。
- `evaluate` 摘要只含返回类型、不含脚本；脚本失败时错误文案可能回显脚本里的标识符，本规格不额外处理（错误文案由能力层决定）。
- 面板抽屉（`0032`）不从本文件读：B / C 切片已于 2026-11-08 否决——宿主动作环 + `actions` 事件（改 `0002` 事件表）只解决「打开面板前的动作可见 / 多连接共享 / 刷新不丢」，而面板已有本连接 50 条、宿主已有落盘 2000 条，第三份状态要再定一套上限与清理规则；需要完整历史时由模型用 `browser_e2e_history` 读回。面板显示不脱敏的现状也不变。
- 不记录页面访问轨迹（URL / 标题按页）、不记录 tab 归属、不记录耗时：`action` 载荷里没有这些字段，本规格不扩协议。
- 多实例：同一台机器两个 DSH 实例写同一文件时，追加是单行写（`appendFileSync`），但裁剪重写会互相覆盖、可能丢记录；本规格按「单实例」假设，不做跨进程锁。
- 手工改过的历史文件不在保证范围：读回按字段类型过滤（`at` 数字、`tool` 字符串、`ok` 布尔，`summary` 非字符串按空串），坏行与空行跳过，文件头 BOM 先剥；不做逐行修复。
- `scope=all` 会读到同一台机器上其它会话的记录（路径不按 profile 分区，其它 profile 的会话也在同一文件里）；默认 `self` 是有意的隔离取舍，不视为缺陷。
- 明确不做：按天过期、重放（`replay`）、按 tab / 页面过滤、把历史注入系统提示或会话上下文、写入时加密。

## 验收

1. `node tests/invariants.mjs`：exit 0、输出无 FAIL。新增「用例 M：动作历史落盘与脱敏」（用例 L 已被 console 级别用例占用，本项顺延为 M），用例名如下（由 tester 落盘，命名照抄；夹具用 `mkdtempSync` 建临时目录，每个用例通过 `DSH_BROWSER_HISTORY_FILE` 指向自己的文件，不碰真实 `~/.dsh`）：
   - `脱敏：fill 的写入值不落盘`
   - `脱敏：keystrokes 形态同样掩码`
   - `脱敏：dialog 的 prompt_text 不落盘`
   - `脱敏：值含引号与换行仍整段掩码`
   - `脱敏：空值与其它工具不改摘要`
   - `落盘：追加一条且字段完整`
   - `落盘：已有文件时 seq 从末尾继续`
   - `落盘：超过上限加余量后裁剪最旧`
   - `落盘：坏行与 BOM 不影响读回`
   - `落盘：DSH_BROWSER_HISTORY=0 不建文件`
   - `落盘：摘要超长按上限截断`
   - `读回：最新在前、limit 截断、total 正确`
   - `读回：tool / ok / scope 过滤`
   - `读回：文件不存在时返回空而不是报错`
   - `接线：注册的工具失败时写入 ok=false 记录`（假 ctx + `apply`，调一个在入参校验阶段必抛的工具，如缺 `url` 的 `browser_e2e_navigate`，不起浏览器）
   - `接线：browser_e2e_history 自身不记录`
2. `node tests/panel.mjs`（真起无头 Edge，与其它集成测试串行；该测试必须在调用 `apply` 前把 `DSH_BROWSER_HISTORY_FILE` 指到临时目录，否则会写真实用户目录）：exit 0、无 FAIL。新增：
   - `browser_e2e_history 声明 limit / tool / ok / scope 参数`
   - `真实 fill 的明文不出现在历史文件里`
   - `browser_e2e_history 读回刚发生的 fill（摘要为掩码）`
3. `node -e "import('./lib/protocol.js').then(m=>console.log(Object.values(m.PANEL_EVENTS).length,Object.values(m.PANEL_COMMANDS).length,Object.values(m.PANEL_ERROR_CODES).length))"` → 输出 `5 5 13`（协议未变）。
4. `node -e "import('./lib/history.js').then(m=>console.log(m.actionHistoryPath()))"` → 输出以 `.dsh\browser-e2e\history\actions.jsonl`（Windows）或 `.dsh/browser-e2e/history/actions.jsonl` 结尾；设了 `DSH_BROWSER_HISTORY_FILE` 时等于该值。
5. 脱敏落盘实测（先跑第 2 条的 fill 用例，再读同一临时文件）：
   `Select-String -Path $env:DSH_BROWSER_HISTORY_FILE -SimpleMatch 'secret-P@ss' -Quiet` → `False`；
   `Select-String -Path $env:DSH_BROWSER_HISTORY_FILE -SimpleMatch '[已脱敏' -Quiet` → `True`。
6. `npm run test:unit`（`tests/invariants.mjs` → `tests/client-bundle.mjs` → `tests/screencast.mjs` 串行）：exit 0、无 FAIL。
7. 手工 GUI 抽查（不作为 CI 门槛）：连做 ≥3 次工具调用（含一次 `browser_e2e_fill`），调 `browser_e2e_history` 能看到这几条、时间与工具名正确、`fill` 的摘要里是 `[已脱敏 N 个字符]`；重启插件后同一命令仍能看到（落盘生效）。
