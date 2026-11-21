# 锁屏状态探测（native/lockscreen）

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块边界与依赖方向）；本功能不进入 `lib/` 调用图
代码: native/lockscreen/src/main.rs / native/lockscreen/probe.js / native/lockscreen/build.ps1 / native/lockscreen/README.md

## 需求

端到端验证经常需要在机器锁屏、屏保、用户离开时改变行为（例如截图内容必然不可信、等待类工具应当尽早失败），
但 `lib/` 全部是页面层能力，没有任何宿主会话状态的观测手段。

本功能提供一个进程外的小型探针，供宿主侧在任何一次工具调用前判断「这台机器当前是否锁屏」，
判定结果只有三种：已锁 / 未锁 / 无法判定。

## 行为

- 输入：无必填参数。`probeLock({ json, timeoutMs })` 可请求四路明细与超时预算（默认 5000ms）。
- 输出：`{ verdict: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN', exitCode: number, detail?: object }`。
  `detail.confidence` 为 `high` / `low` / `none`，`detail.signals` 是每条探测的原始读数。
- 状态变化：不碰会话、标签页、浏览器进程与面板；只 fork 一个短命子进程读系统状态，
  冷启动约 60~90ms，子进程随即退出。

判定由四路独立探测交叉验证：

| 探测 | 权重 | 依据 |
|---|---|---|
| `input_desktop` | 3 强 | 前台窗口所在桌面能否命名（`ACCESS_DENIED`→已锁）；前台不可得时看光标处窗口类是否为锁屏背板 |
| `wts_flags` | 3 强 | `WTSQuerySessionInformationW(WTSSessionInfoEx)` 的 `SessionFlags` |
| `foreground_window` | 2 强 | 前台窗口进程是否为 `LogonUI`（锁屏宿主）；解析失败记 `None` |
| `shell_window` | 1 弱 | `explorer` 桌面 shell 是否仍在 |

强信号（权重 ≥ 2）全部一致才给结论，置信 `high`；强信号互相冲突返回 `UNKNOWN`，不采信任一方。
全部强信号失效时才退到弱信号池，置信度降 `low`。

## 边界

- **仅 Windows**。非 `win32` 平台 `probeLock` 抛 `LockProbeUnavailableError`（`code=LOCKPROBE_UNAVAILABLE`）。
  跨平台工具链里应当在调用前先查 `probeAvailable()`。
- 探针 exe 不存在、启动失败、超时、退出码非 0/1/2 时同样抛 `LockProbeUnavailableError`；
  调用方不得把"探针不可用"当作"未锁屏"。`UNKNOWN` 与"不可用"是两种不同的降级。
- **进程枚举不可用**：`CreateToolhelp32Snapshot` 与 `EnumProcesses` 在 DSH 派生的子进程里被 Job Object
  裁剪（实测仅可见 13 条后代进程，真实 289 条；C# 同样如此）。本探针因此不使用进程快照，
  改用 `QueryFullProcessImageNameW` 由窗口句柄反查进程名。
- **`SessionFlags` 单独不可信**：本机实测曾读到 `0`（LOCK）但系统实际未锁。它是强信号之一而非唯一判据。
  （2026-11-21 再实测：真实锁屏期间该路 186/186 全对，是四条路线里唯一全程正确的信号。）
- **服务化场景未验证**：Session 0 下 `OpenInputDesktop` 会失败，需显式传目标 session id；当前只查当前会话。
- 不处理屏保（`ScreenSaverEngine`）与「已登录但无交互」两种介于锁与不锁之间的状态。

- **input_desktop 旧判据（桌面名是否为 Default）已废，改用前台窗口桌面归属（实测订正 2026-11-21）**：
  旧实现靠 `OpenInputDesktop` 拿桌面名、等于 `Default` 就判未锁，而真实锁屏时该调用照样成功且
  名字仍是 `Default`（Win10/11 的 LockApp 与登录界面共用 WinSta0），整段锁屏全程误判。
  新判据改为看**前台窗口所在桌面能否命名**：锁屏时前台窗口（`LockApp.exe` / `LogonUI.exe`）在
  我们无权访问的安全桌面上，`GetThreadDesktop` 返回 NULL 且 `GetLastError()==ERROR_ACCESS_DENIED`（=5）；
  未锁屏时前台窗口就在本线程桌面上，名字一致。同一次锁屏实测的对照组：本线程桌面 5 个普通窗口
  `GetThreadDesktop` 全部正常返回 `Default`，只有锁屏前台窗口被拒。
  锁屏持续一段时间后 `GetForegroundWindow` 会返回 NULL，此时改用**光标处窗口类**：锁屏时该位置是
  `LockApp` 的 `LockScreenBackstopFrame`（实测铺满全屏，11 个采样点全中），未锁屏时是普通应用窗口。
  该判据只读，覆盖 `fg=NULL` 的整个锁屏阶段；若光标处类名不可辨认仍返回 `None`，不猜。
- **`LockScreenBackstopFrame` 的归属**：锁屏期 `EnumWindows` 枚举的 300 个窗口里该类命中 0 次，
  说明它在锁屏安全桌面上、只能经光标命中观测到；这保证了「光标处是它」不会在未锁屏时误伤。
- **「检测线程桌面是否被切走」这条思路在本机不成立**：锁屏期 `GetThreadDesktop(自身)` 仍是 `Default`；
  `OpenDesktop("Winlogon")` 返回 5、`"LogonUI"` 返回 2，`EnumDesktops` 只列出 `Default` 与
  `DummyDesktopForInstantResume` —— 安全桌面既不可枚举也不可打开，只能通过前台窗口的桌面归属间接观测。
- **foreground_window 的两处修正**：旧实现把「进程名解析失败（`?`）」落到 `_ => Some(false)` 判未锁，
  而锁屏期 `OpenProcess` 恰好会被拒（实测前台窗口取到的进程名就是 `?`），等于凭空猜「未锁」；
  现改为 `None`。`lockapp.exe` 仍记 `None`：实测锁屏期前台确为 LockApp 的
  `Windows.UI.Core.CoreWindow`，但参考系里缺少「未锁屏时 LockApp 从不当前台」的证据，保守起见
  不把它升成 `locked`，其证据价值由第 1 路的桌面归属承担。
- **旧判据的失效规模（修复前的实测基线，留作对照）**：Win+L 锁屏 6.6 分钟、每 2s 采样共 245 次，
  锁屏期 186 个样本里 wts_flags 全程 locked，但旧 input_desktop **185/186 判 unlocked**；
  两个权重 3 的强信号全程冲突，聚合器按规则返回 UNKNOWN(low) —— 整段锁屏期没给出 LOCKED。
  该批样本的结论分布：UNKNOWN 185、UNLOCKED 49、LOCKED 仅 1（解锁前瞬时）。
  修复后同一场景的对照见验收节「端到端双向复验」（711 条锁屏样本全 LOCKED/high）。

## 验收

- `node native/lockscreen/selftest.mjs` —— exit 0、无 FAIL，输出 `bridge ok` 与当前 verdict。
- `pwsh native/lockscreen/build.ps1` —— 末尾自测 7 条用例全部 PASS，且重建后 exe 可独立运行。
- 人工核对：锁屏（Win+L）后立即运行，verdict 变为 LOCKED、进程退出码 1；解锁后回到 UNLOCKED、退出码 0。
  **实测订正（2026-11-21）：这条的旧实现不成立。** 真实锁屏 6.6 分钟期间 186 个样本，verdict 从未稳定变为
  LOCKED（185 次 UNKNOWN + 1 次解锁前的瞬时 LOCKED），原因见「边界」中已被废掉的旧判据；解锁后能正确回到
  UNLOCKED。改用「前台窗口桌面归属 + 光标窗口类」两条判据后，锁屏期实测 `input_desktop` 与 `wts_flags`
  同时判 locked、verdict=`LOCKED`/`high`、退出码 1，覆盖 `GetForegroundWindow` 返回 NULL 的整个锁屏阶段。
- **端到端双向复验（2026-11-21 17:06 ~ 17:46，一次连续采样 1125 条）**：未锁 413 条全 `UNLOCKED`
  （`input_desktop` 明细为 `fg_desktop='Default' 与自己所在桌面一致`），随后系统自动锁屏，
  在 886→888 秒的相邻两样本之间翻转，锁屏 711 条全 `LOCKED`/`high`。锁屏期第一条判据给出
  `fg_desktop 不可访问 err=5（安全桌面）`（前台窗口从普通桌面切到了安全桌面，`GetForegroundWindow`
  仍可返回句柄、但其 `GetThreadDesktop` 被拒），与 `wts_flags` 完全一致。
  零误判：711 条锁屏样本的 `wts_flags` 全为 locked；413 条未锁样本的 `input_desktop` 无一判 locked。