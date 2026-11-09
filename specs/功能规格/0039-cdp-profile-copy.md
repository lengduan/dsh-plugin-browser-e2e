# CDP 复制接管

状态: 已实现
关联: specs/功能规格/0008-cdp-attach.md（CDP 接管基础行为）；specs/功能规格/0002-browser-launch-and-reuse.md（启动与复用）；specs/功能规格/0021-auth-state-import.md（登录态导入，与本项互不替代）；specs/项目规格/0001-architecture-invariants.md（会话状态机、模块表、进程回收）
代码: lib/session.js / lib/profile-copy.js / lib/carrier.js / lib/tools.js / tests/cdp-copy.mjs / tests/cdp.mjs

## 需求

`mode: 'cdp'` 原本只接管「已经用远程调试端口启动的浏览器」。当用户想让插件操作自己真实在用的 Edge（带登录态与扩展）时，只能用 junction / 别名路径把同一个 profile 以另一个 `--user-data-dir` 打开，实测会导致该 profile 的 v20 cookie 与扩展被清（见 `procedures/_inbox.md`）。

本项提供一条安全路径：插件先把用户 profile 的登录态与扩展复制到副本目录，用副本启动 Edge，再接管副本。原 profile 只被读取一次，不被连接、不被改写。

## 行为

- **入口与参数**：`browser_e2e_start` 新增三个参数，只在 `mode: 'cdp'` 下有意义：
  - `cdpCopyProfile`（boolean，默认 false）：为 true 时执行复制接管；
  - `cdpProfileSource`（string，可选）：源 User Data 目录；缺省用 `defaultEdgeUserDataDir()`（Windows `%LOCALAPPDATA%\Microsoft\Edge\User Data`，macOS `~/Library/Application Support/Microsoft Edge`，Linux `$XDG_CONFIG_HOME/microsoft-edge`）；
  - `cdpProfileDir`（string，可选）：副本目录；缺省 `<tmpdir>/dsh-browser-e2e-cdp/profile-<时间戳>-<随机>`。
  - 未开 `cdpCopyProfile` 却传 `cdpProfileSource` / `cdpProfileDir`，或 `mode: 'isolated'` 传这两个参数：直接报 `cdpProfileSource / cdpProfileDir 只在 cdpCopyProfile=true 时生效；当前 mode=...、cdpCopyProfile=...`，不静默忽略。
- **复制白名单**（`lib/profile-copy.js`）：只复制登录态与扩展所需的最小集合，不复制缓存：
  - 文件：`Local State`、`First Run`、`Default/Preferences`、`Default/Secure Preferences`、`Default/Login Data`、`Default/Web Data`、`Default/Bookmarks`、`Default/Network/Cookies`；
  - 目录：`Default/Local Storage`、`Default/Extensions`、`Default/Local Extension Settings`、`Default/Extension State`、`Default/Extension Rules`、`Default/Extension Scripts`、`Default/Sync Extension Settings`。
  - 源目录缺 `Local State` 报 `profile 源目录不是 Edge User Data（缺少 Local State）：<路径>`；目录不存在报 `profile 源目录不存在：<路径>；...`。
  - 副本目录已存在时报 `profile 副本目录已存在：<路径>；请换一个 cdpProfileDir，或先删除该目录`，不覆盖。
  - 复制中途失败（源 profile 被运行中的 Edge 占用等）时删除半份副本再抛错：`复制 profile 失败（EBUSY/EPERM/EACCES）：源目录正被运行中的 Edge 占用，请先完全关闭 Edge 再重试；源目录：<路径>`。
- **启动与接管**：复制完成后用 `resolveEdgeExecutable()` 解析系统 Edge（`EDGE_PATH` 优先，其次平台惯例安装位置），以
  `msedge.exe --user-data-dir=<副本> --remote-debugging-port=<端点端口> --profile-directory=Default --no-first-run about:blank` 启动，轮询 `/json/version`（上限 20 秒）后再 `connectOverCDP`。
  - 端口取归一后 `cdpEndpoint` 的端口（缺省 9222）；端点仍走 0008 的 loopback / http 校验。
  - 副本启动失败或 20 秒内端口未就绪：结束进程、删除副本目录，报 `副本 Edge 启动后 20 秒内没有监听调试端口 <port>；已结束副本进程并删除副本目录。...`。
  - 副本进程异常退出时只清理，不让后续步骤挂起。
- **返回**：新接管时返回字段 `cdpProfile: { source, dir, copiedFiles, copiedDirs }`，摘要追加 `，已复制 profile 到 <dir>`；工具层再追加一行「已复制 profile 到 ...（来源 ...，含 N 个文件 / M 个目录：登录态与扩展；原 profile 未改动）」与「browser_e2e_close 会结束副本浏览器并删除副本目录。」。直连接管不返回 `cdpProfile`，形状与摘要保持 0008 原文案。
- **close**：复制接管的会话在 `close` 时先断 CDP，再结束副本进程（Windows 用 `taskkill /PID <pid> /T /F`，其他平台 `SIGKILL`），最后删除副本目录（副本含明文凭据，默认必须删除）。成功返回 `{ closed: true, mode: 'cdp', cdpProfileCleaned: true, summary: '已结束插件启动的副本浏览器并删除副本目录（原 profile 未改动）' }`；目录删不掉时 `cdpProfileCleaned: false`，摘要改为「副本目录删除失败，请手动清理」。
- **不热切换**：已启动会话再传 `cdpCopyProfile` 且与当前会话的复制/直连状态不一致时，`assertReuseCompatible` 报 `浏览器已启动（CDP 复制接管 / CDP 直连 模式）；如需切换请先 browser_e2e_close 再 browser_e2e_start`。
- **启动中被 close**：`launch` 的 `finally` 在 `closing` 与启动失败两条清理路径里都调用 `stopCopiedProfile`，不把副本进程与明文目录留下。
- **防呆（直连接管）**：`cdpCopyProfile` 未开时，接管前开一个临时页读 `edge://version` 的「用户配置路径」（取父目录得到 User Data），用 `realpath` 解析 junction / 符号链接后与 `defaultEdgeUserDataDir()` 比较；命中默认 profile 时关闭临时页、断开连接并报 `CDP 模式拒绝直接接管系统 Edge 的默认 Profile：...请改用 cdpCopyProfile: true ...`。读不到「用户配置路径」或内部页不可访问时放行，不阻断。不用 `Browser.getBrowserCommandLine`：该命令要求浏览器启动时带 `--enable-automation`，常规启动读不到。临时页在 `context.on('page')` 注册之前创建并关闭，不进入标签页列表。

## 边界

- 只支持系统 Edge：`resolveEdgeExecutable` 找不到时报错并列出查过的位置；不支持 Chrome 的复制接管。
- 副本是明文凭据（cookie、密码库、扩展数据、历史）：目录只创建在用户给的路径或系统临时目录，close 默认删除；用户手工中断（进程被杀）时副本目录可能残留，需要自行清理。
- 副本里 App-Bound 加密（v20）的 cookie 与 localStorage 不一定能解密：实测原库 104 条，副本浏览器可读 55 条，figma / aliyun / linkedin / 公司 wiki 等 host 消失；v10 cookie（如 GitHub）与 Edge 账户登录可保留。这是 Chromium 换 user-data-dir 的行为，本项不做绕过；需要完整登录态时在副本里手动登录一次。
- 复制期间必须完全关闭 Edge；未关闭时按复制失败的占用错误处理，不复制半份数据。
- 不改变 isolated 模式与 storageState 导入的任何行为；本项与 0021 是两条独立路径（0021 是「导出/导入登录态文件」，本项是「复制整个 profile 目录」）。

## 验收

- `node tests/cdp-copy.mjs`：exit 0、无 FAIL。用例：`源目录不存在时报错`、`isolated 模式传复制参数被拒绝`、`接管成功且 mode 为 cdp`、`返回 cdpProfile 来源与副本目录`、`摘要标注已复制 profile`、`副本包含 Local State / Preferences / Secure Preferences`、`副本包含 cookies 与扩展目录`、`副本包含扩展本地存储`、`接管副本后有标签页`、`会话记录了副本启动信息`、`已启动后关闭复制开关被拒绝`、`源 profile 文件未被改写`、`源扩展目录仍在`、`close 返回 cdp 模式`、`close 摘要说明原 profile 未改动`、`副本目录已删除`、`源 profile 仍然存在`、`防呆用浏览器就绪`、`直连默认 Profile 被拒绝`。
- `node tests/cdp.mjs`：exit 0、无 FAIL（直连接管行为保持 0008 原文案与语义）。
