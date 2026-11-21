# 锁屏状态探针

判断当前 Windows 会话是否锁屏。供 DSH 宿主侧在工具调用前做前置判断。

**功能规格**：`specs/功能规格/0042-lockscreen-probe.md`

## 用法

```js
import { probeLock, isLocked, probeAvailable } from './native/lockscreen/probe.js'

if (probeAvailable() && isLocked()) {
  // 锁屏时的降级策略
}

const { verdict, detail } = probeLock({ json: true })
// verdict: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN'
// detail.confidence: 'high' | 'low' | 'none'
```

也可直接用命令行：

```powershell
bin\lockprobe.exe              # 人读，带四路明细
bin\lockprobe.exe --json       # 机读
bin\lockprobe.exe --selftest   # 只跑聚合逻辑用例
pwsh build.ps1                  # 重新编译
```

退出码：`0` 未锁 / `1` 已锁 / `2` 无法判定。

## 原理

Windows 没有直接查询「是否锁屏」的 API，锁屏是**多个系统状态的组合结果**。本探针并行采集四路
独立信号，交叉验证后才给结论。

### 1. 前台窗口的桌面归属（权重 3）

```
own  = GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME)   // 本线程桌面
fg   = GetForegroundWindow()
tid  = GetWindowThreadProcessId(fg)
dh   = GetThreadDesktop(tid)                                                        // 前台窗口所在桌面
name = GetUserObjectInformationW(dh, UOI_NAME)                                      // 失败时看 GetLastError
```

**判据**：前台窗口所在桌面能命名且等于本线程桌面 → 未锁；能命名但叫 `Winlogon` →
已锁；**无法命名且 `GetLastError()==ERROR_ACCESS_DENIED` → 已锁**（前台窗口在我无权访问的
安全桌面上，这正是锁屏界面）。

**第二条判据（补锁屏后期）**：锁屏持续一段时间后 `GetForegroundWindow()` 会返回 NULL
（前台锁屏窗口不再可见），此时改用光标处的窗口类：

```
GetCursorPos(&pt); WindowFromPoint(pt) → GetClassNameW
```

锁屏时该位置是 `LockApp` 的 `LockScreenBackstopFrame`（实测铺满全屏，11 个采样点全中，
含四个角与对角线）；未锁屏时是普通应用窗口。这一路**只读**，且在该阶段仍与 `wts_flags`
一致。若光标处既非锁屏背板也非可辨认类名，仍返回 `None`，交给聚合器退到别的信号。

**为什么不用「`OpenInputDesktop` 拿到的桌面名是否为 `Default`」**（旧实现，已废）：

- 实测 2026-11-21 真实锁屏 6.6 分钟，每 2s 采样 245 次，锁屏期 186 个样本里该路
  **185 次判未锁**：锁屏时 `OpenInputDesktop` 依然成功，返回的桌面名仍是 `Default`。
  它与 `wts_flags` 全程冲突，聚合器按「强信号冲突 → UNKNOWN」把正确结论压掉了。
- 实测同一次锁屏：前台窗口是 `LockApp.exe`（PID 18652，`Windows.UI.Core.CoreWindow`），
  它的 `GetThreadDesktop` 返回 NULL 且 `GetLastError()==5`；而同一时刻枚举本线程桌面上的
  5 个普通窗口，`GetThreadDesktop` 全部正常返回 `Default`。**这是有区分力的。**
- 本线程桌面**始终**是 `Default`（锁屏时也没被切走），所以「检测线程桌面是否被切走」这条
  思路在本机不成立；`OpenDesktop("Winlogon")` 在锁屏期返回 5、`"LogonUI"` 返回 2，
  `EnumDesktops` 也只列出 `Default` 与 `DummyDesktopForInstantResume`，安全桌面根本不可枚举。
- 锁屏持续一段时间后 `GetForegroundWindow` 会返回 NULL（前台锁屏窗口不再归我们可见）。
  实测这次锁屏 25 分钟全程都是该状态，故追加了光标处的窗口类判据（见下条），而不是返回 `None`。
- **`LockScreenBackstopFrame` 只在锁屏时出现**：锁屏期 `EnumWindows` 枚举的 300 个窗口里
  该类命中 0 次 —— 它属于锁屏安全桌面，只能在光标命中时看到。因此「光标处是它」既覆盖
  `fg=NULL` 阶段，也不会在未锁屏时误伤。
- 历史那轮锁屏曾出现**后台残留窗口当前台**（`deepseek harness.exe`），那时仅凭前台窗口桌面归属
  会漏判；现在即使前台窗口判为未锁，也会再用光标窗口类复核一次，命中锁屏背板即改判已锁。

### 2. WTS 会话标志（权重 3）

> 本路在实测中是唯一全程正确的信号（锁屏期 186/186 判 locked），但规格要求它不单独作为唯一判据，
> 因此仍需第 1 路提供独立旁证。

```
WTSQuerySessionInformationW(NULL, -1, WTSSessionInfoEx /* 25 */, &buf, &bytes)
```

返回 `WTSINFOEXW`，其中 `SessionFlags` 为 `WTS_SESSIONSTATE_UNLOCK`(1) 或 `WTS_SESSIONSTATE_LOCK`(0)。

**关键坑：结构体偏移**。`WTSINFOEXW` 声明为：

```c
typedef struct {
    DWORD Level;          // 偏移 0
    WTSINFOEX_LEVEL Data; // 因内部 LARGE_INTEGER 需要 8 字节对齐，实际偏移 8（不是 4）
} WTSINFOEXW;
```

所以字段位置是 `Level@0 / SessionId@8 / State@12 / Flags@16`。按常见的「Level 占 4 字节」假设
从偏移 4 读会全部错位，得到一个看起来合理但错误的 `flags`。

**实测警告**：本机曾读到 `flags=0`（LOCK）而系统实际未锁，同时 `input_desktop` 明确可访问。
该字段可靠度低于第 1 路，因此两者冲突时聚合器返回 `UNKNOWN`，不采信任一方。

### 3. 前台窗口归属（权重 2）

`GetForegroundWindow` → `GetWindowThreadProcessId` → `QueryFullProcessImageNameW`。

进程为 `LogonUI.exe` 说明前台就是锁屏界面（**强**）；为 `LockApp.exe` 记 `None`
（**LockApp 常驻，未锁屏时也在运行**，这是最容易被误用的信号）；**进程名解析失败记 `None`**
（锁屏期 `OpenProcess` 对锁屏进程会被拒绝，旧实现把这种失败当成「未锁」，等于猜）；
其它进程 → 未锁。

用 `QueryFullProcessImageNameW` 而非进程枚举，原因见下节。

### 4. 桌面 shell 存活（权重 1）

`GetShellWindow` 拿到 `Program Manager` 窗口，其所属进程是 `explorer.exe`。
锁屏 / 登录界面下 shell 窗口会消失或换主。

### 聚合规则

```
强信号（权重 ≥ 2）全部一致  → 结论，置信 high
强信号互相冲突              → UNKNOWN，置信 low
强信号全失效、弱信号一致    → 结论，置信 low
其余                        → UNKNOWN
```

**宁可答 UNKNOWN 也不猜**：调用方可以据此选择保守策略，但不会被一个错误结论误导。

## 关键实现约束

### 进程枚举在 DSH 子进程里不可用

`CreateToolhelp32Snapshot` 与 `EnumProcesses` 都受 Windows **Job Object** 裁剪。实测同一台机器：

| 调用环境 | CreateToolhelp32Snapshot | EnumProcesses | Get-Process |
|---|---|---|---|
| pwsh 进程内 | 292（含 LockApp） | 289 | 289 |
| **DSH 派生子进程** | **13** | **13** | 291 |
| 官方 System32 工具 | 正常 | 正常 | 正常 |

DSH 把子进程放进 Job Object（`IsProcessInJob` 返回 `True`），继承后枚举被裁剪为仅可见该 Job
下的后代进程（那 13 条全是 msedgewebview2 与 DSH 自身）。**这与实现语言无关**：C# 写同样的程序
在子进程里同样只返回 13 条。

因此本探针**放弃进程快照这条路**，改用「由窗口句柄反查进程名」，该路径不受 Job 裁剪。

### `WTSINFOEXW` 的对齐

见上文第 2 路。这是本实现第二个真实踩过的坑。

### 服务化场景

Session 0（服务）下没有交互桌面，`OpenInputDesktop` 会失败。此时应显式传入目标 session id 查
`WTS`，且结论只代表那个会话。**本探针当前只查当前会话，服务化场景未验证。**

## 性能

| 项目 | 耗时 |
|---|---|
| 冷启动（含进程创建） | 60~90 ms |
| 四路探测合计（内部） | 2.5~4 ms |
| `input_desktop` | 约 40 µs |
| `wts_flags` | 约 2.4 ms（跨进程 RPC，大头） |
| `foreground_window` | 约 90 µs |
| `shell_window` | 约 60 µs |

单文件 exe（约 190 KB），无运行时依赖，静态链接 Win32 导入表。

若需高频轮询，可只取 `input_desktop` 一路（微秒级），代价是失去交叉验证。

## 构建

需要 Rust 工具链（`rustc`）。**不需要 MSVC**：默认 target 为
`x86_64-pc-windows-msvc`，但 `rust-lld` 与默认链接器都能直接产 exe。

```powershell
pwsh native/lockscreen/build.ps1   # 编译并跑自测
node native/lockscreen/selftest.mjs # 只跑桥接自测
```

`bin/lockprobe.exe` 已提交在仓库里，没有 Rust 工具链也能直接用。

## 文件

```
native/lockscreen/
├── src/main.rs      Rust 源码（四路探测 + 聚合 + 内置自测）
├── probe.js         ESM 桥接：跨平台守卫、spawn、解析
├── selftest.mjs     桥接自测
├── build.ps1        构建脚本
├── README.md        本文
└── bin/lockprobe.exe 提交的构建产物
```
