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
| `input_desktop` | 3 强 | `OpenInputDesktop` 能否拿到 `Default` 桌面 |
| `wts_flags` | 3 强 | `WTSQuerySessionInformationW(WTSSessionInfoEx)` 的 `SessionFlags` |
| `foreground_window` | 2 强 | 前台窗口进程是否为 `LogonUI`（锁屏宿主） |
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
- **服务化场景未验证**：Session 0 下 `OpenInputDesktop` 会失败，需显式传目标 session id；当前只查当前会话。
- 不处理屏保（`ScreenSaverEngine`）与「已登录但无交互」两种介于锁与不锁之间的状态。

## 验收

- `node native/lockscreen/selftest.mjs` —— exit 0、无 FAIL，输出 `bridge ok` 与当前 verdict。
- `pwsh native/lockscreen/build.ps1` —— 末尾自测 7 条用例全部 PASS，且重建后 exe 可独立运行。
- 人工核对：锁屏（Win+L）后立即运行，`verdict` 变为 `LOCKED`、进程退出码 1；解锁后回到 `UNLOCKED`、退出码 0。
