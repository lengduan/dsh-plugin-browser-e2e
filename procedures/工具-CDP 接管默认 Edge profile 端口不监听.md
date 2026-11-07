# 工具-CDP 接管默认 Edge profile 端口不监听

> **触发**：用 `--remote-debugging-port=9222` 启动 Edge，进程命令行里能看到这个参数，但 `http://127.0.0.1:9222/json/version` 报「由于目标计算机积极拒绝」；换成临时空目录启动却正常
> **锚点**：`--remote-debugging-port`、`--user-data-dir`、`json/version`、`9222`、`User Data`、`积极拒绝`、`EdgeCDP-Link`
> **验证**：`Invoke-WebRequest http://127.0.0.1:9222/json/version` 返回带 `webSocketDebuggerUrl` 的 JSON；再开 `edge://version` 看「用户配置路径」是否仍是真实 profile

## 首选

把默认 profile 目录做成 junction，传 junction 路径启动（数据不变，路径变了）：

```powershell
cmd /c 'mklink /J "C:\Users\IT\AppData\Local\EdgeCDP-Link" "C:\Users\IT\AppData\Local\Microsoft\Edge\User Data"'
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 --user-data-dir="C:\Users\IT\AppData\Local\EdgeCDP-Link"
```

必须先确认没有 Edge 在跑（同一 user-data-dir 有实例时，新进程会被单例吸收后退出，端口照样不开）。

## 被挡时

- junction 不适用（跨盘、权限不足）时，复制 profile 到非默认路径再启动：`robocopy "…\User Data" "D:\edge-cdp" /E /XD "Cache" "Code Cache" "GPUCache"`。代价：GB 级复制，且新版 Chromium 的 App-Bound Encryption 可能让部分 cookie 解不开（**未验证**，需实测登录态）。
- 不需要登录态时，直接给一个专用空目录启动，最省事。

## 别再来

| 弯路 | 为什么不通 |
| --- | --- |
| 直接把 `--user-data-dir` 指向默认 `User Data` 路径 | 命令行带着端口参数，但 Chromium 136+ 会忽略它，端口不监听；Edge 153 实测复现 |
| 以为端口没开，重复启动第二个带端口的进程 | 同 user-data-dir 单例生效：新进程把参数转交已有实例后退出，`new pids` 为空，端口仍未开 |
| 用 `%TEMP%\edge-cdp-demo` 之类的空目录"先接通再说" | 能连通但 profile 是全新初始化的空库：无登录、无书签、无扩展，用户看到的就是"一个全新的浏览器" |
| 想给已经运行中的浏览器补开调试端口 | 参数只在进程启动那一刻生效，没有运行时入口 |

## 注意

- 判定用的是 **user-data-dir 路径字符串**（是否等于默认 profile 路径），不是数据本身。同一份数据换个路径就能开端口——这是判断"是不是安全策略而不是参数错误"的关键。
- 这是 **Chromium 136+ 的刻意安全限制**，junction 属于绕过它。代价：端口无鉴权，本机任何进程连上即可完全操纵该已登录浏览器（读 cookie、已登录站点的页面内容），用完即关。
- 数据安全上 junction 不制造双开：单例锁仍落在同一个 profile 目录，不会出现两个进程同时写。
- 排查时先看 `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"` 里 browser 级进程的**完整命令行**，再判断是"参数没生效"还是"参数没传对"。

证据：2026-11-07 本会话，Edge 153.0.4234.32（Chromium 153.0.8010.37），三组对照——默认路径端口不开、空目录正常、junction 正常；`edge://version` 用户配置路径 `…\EdgeCDP-Link\Default`，Local State 中 `gaia=941082240@qq.com`，Bookmarks 478 条。
