# 待整理（inbox）

<!-- 一行一条：现象 + 一句话解法。够格的按 _模板.md 升成卡后删掉这条。 -->

- 现象：headless 停在带无限 CSS 动画的大页面上时 CPU 异常高（DSH GUI 实测 167.8% 单核、空白页仅 1.3%），且 Playwright 默认 `--disable-renderer-backgrounding` 让它永不节流。解法：`browser_e2e_start { freezeAnimations: true }`（本插件 0040），每次换文档自动注入 `animation:none` + `pause()`，实测 14.9% → 1.3%。坑：只插 CSS 无效（WAAPI 动画不受约束，175.4% 仍高），两句缺一不可；Playwright 的 `reducedMotion: 'reduce'` 不能替代——它只声明媒体偏好，纯 CSS keyframes 照样 running。
- 现象：用 junction 路径（EdgeCDP-Link）当 `--user-data-dir` 启动过真实 Edge profile 后，再用默认路径启动同一 profile，用户扩展目录被回收、`Secure Preferences` 里扩展条目被丢弃（2026-11-09 复现：5 个刚装好的扩展目录在 10:16 被清空，prefs 条目残留；11/7 22:21 junction 启动 + 11/8 10:18 默认启动的那次丢失与之同形）。解法：要接真实 profile 就别开调试端口，或另用一次性 profile；别在同一个 profile 上混用两种路径启动。（2026-11-09 10:47 补证：同一 profile 的 cookie 库只剩 97 条 / 33 个 host，无 11-08 条目、11-07 仅剩 9 条，即 cookie 与扩展在 junction 启动的同一时间被清空。）
- 现象/方案验证：把真实 Edge profile 的最小登录集合（Local State / Preferences / Secure Preferences / Network\Cookies / Login Data / Web Data / Bookmarks / Local Storage）复制到临时目录，用 `--user-data-dir=<副本> --remote-debugging-port=9222` 启动再 CDP 接管。2026-11-09 实测：原 profile 的 Cookies SHA256 前后一致、完全没被改动；副本里 Edge 账户仍登录（941082240@qq.com，同步已启用），GitHub 的 v10 cookie（user_session 等）可用；但 v20 cookie 大量失效——原库 104 条，副本浏览器只能读出 55 条，figma / aliyun / linkedin / 公司 wiki 等 host 整批消失，Local Storage 的 storageState origins 为 0。结论：复制方案能保证「不动原件」，但只能共享 v10 与账户令牌，v20 与 localStorage 共享不了。
- 现象：Edge 里点 Chrome 应用商店的「添加至 Chrome」后，安装确认是浏览器原生弹窗（不在页面 DOM），CDP/Playwright 点不到；`--disable-extensions` 启动会连商店安装一起抑制，`--disable-extensions-except` 会让 9222 端口不监听。解法：确认弹窗用 UI Automation（`UIAutomationClient` 找 Button 名 `添加扩展` 后 InvokePattern.Invoke）；Chrome 商店需要代理时，SwitchyOmega 一类扩展会用 PAC 覆盖 `--proxy-server`，要么临时切换其情景模式到走代理的档位，要么在 `--disable-extensions` 下改用 Edge 加载项商店装。
- 现象：卸载 `@linxin666/dsh-web-all` 聚合包的瞬间，当前会话里由它提供的工具（如 `win_bash`）立即从工具集消失，随后再调就是 unknown tool；profile 的 `cordis.patch.yml` 里 `- id: web-ui-*` 覆盖行在卸载后全部变成无目标 patch（启动告警），且独立重装子包后 row id 变成 `ui-task-board` / `session-archive` / `dsh-win-bash` 等，覆盖行必须逐个改写，否则 session-archive 的自动删除（true/15 天/记手工归档）与 win-bash 的 `syncWithLiangShen: false` 会静默回落默认值。解法：卸载前先备份 profile、把启用子插件与覆盖行列清；卸载后按新 row id 改写 patch（`name` 可省略、`config` 整行替换），重装子包用 plugin_manager install_bundle 逐个装（task-board 必须排在 task-board-team 之前）。
- 现象：把 profile 里用 `link:`（plugin_manager install_bundle 装本地目录）的插件名写进 agent 预设的 plugins 列表，预设显示「加载失败 / never started」，但声明行本身 fiberPhase=active，Host 日志不可见。原因：该包真实路径在 profile 之外，插件里静态 `import "@deepseek-ai/dsh-tools"` 这类包在宿主模块解析里找不到（Node 从 realpath 向上找不到 profile 的 node_modules）；顶层 bundle 行的插件同样写法却正常，差异只在 preset 内挂载这一条链路。解法：这类插件只依赖 `node:` 内置模块，工具定义按注册表契约手写（name/description/parameters/output.render/execute），不静态 import `@deepseek-ai/*`；改完把对应 `include:preset-*` 行关掉再打开重挂载。- 现象：`chromium.launch` 显式拒绝 `userDataDir`（连塞 args 绕过都被拦），只能 `launchPersistentContext`；但它返回 `BrowserContext` 而非 `Browser`，取 `.browser()` 才拿到共享 Browser 实例。坑：同一个 `user-data-dir` **不能**被两个实例同时占用，第二个直接报 `Target page, context or browser has been closed`。解法：池按启动签名给每个槽分一个 profile 子目录（`resolveSlotProfileDir`），不是共用根目录。
- 现象：并发 `acquire` 会拉起两个浏览器（实测 launches=3、same=false），即使开头有 `if (slot.launchTask)` 合流。原因：合流分支之后还有 `await` 预热（写 Local State / 锁屏探测），第二个调用在那段 await 期间看到 `launchTask` 仍是 null。解法：`slot.launchTask` 必须在**第一个 await 之前**赋值，预热放进这个 task 内部，而不是 task 之前。
- 现象：浏览器已起、但会话没建成时（`newPage` 失败）抛错，租约归还了但浏览器留在池里永远不关，`tests/invariants.mjs` 从 0 FAIL 变 11 FAIL 且后续用例连环失败。解法：加 `pool.abandon(signature)`——归还租约并在归零时**立刻** shutdownSlot，与正常 `release`（只装空闲计时）区分开。
- 现象：`shutdownSlot` 在 `browser.close()` 期间仍留在 `slots` Map 里，并发 `acquire` 借到正在关闭的浏览器，实测 `launches=3 same=false`。解法：先把槽从 Map 摘掉再去 close；关闭期间用 `closingSlots` Set 抑制 `disconnected` 广播。
- 现象：测试里紧接着跑第二个同签名浏览器会起不来（status=1，stderr 只有 `run_main:107` 没有错误文本）。原因：前一个浏览器刚关闭，Chromium 释放 `user-data-dir` 有延迟，立即复用同一 profile 目录必然失败。解法：给子进程独立的 `DSH_BROWSER_E2E_HOME`（`tests/reclaim.mjs` 用例 F 即此法）。
- 现象：测试注入的假 context 没有 `close` 方法，`context.close()` 直接 `TypeError`（`tests/carrier.mjs` 曾因此 exit=1）。解法：统一用 `Promise.resolve(context.close?.())`。
- 现象：Win+L 真实锁屏 6.6 分钟、每 2s 采样一次共 245 次，锁屏探针几乎全程返回 UNKNOWN（185/245）或 UNLOCKED（49/245），
  只有解锁前约 2.5s 出现过 1 次 LOCKED。原因：probe_input_desktop（native/lockscreen/src/main.rs:80）靠 OpenInputDesktop
  拿到的桌面名判锁，真锁屏时它仍返回 Default（权重 3 的强信号全程判 unlocked），与 wts_flags 的 locked 全程冲突，
  聚合器按「强信号冲突 -> UNKNOWN」规则压掉了结论；probe_foreground 又主动把所有 lockapp.exe 映射成 None，
  而锁屏期前台窗口实测是别的残留窗口，于是这一路也帮不上。后果：assertSafeToLaunch 的「已锁屏」分支在真实锁屏下
  根本不会命中，账户锁定防护第一层等于没生效（仍靠 profile 预置标记兜底）。
  已修（2026-11-21 二次锁屏实测）：任务书给的两条候选思路在本机都不成立——锁屏期 GetThreadDesktop(自身) 仍是 Default
  （线程桌面没被切走），OpenDesktop("Winlogon") 恒返回 5、"LogonUI" 返回 2，EnumDesktops 也只列出 Default 与
  DummyDesktopForInstantResume，安全桌面不可枚举也不可打开。**有效判据**：前台窗口所在桌面能否命名——锁屏期前台是
  LockApp 的 Windows.UI.Core.CoreWindow（PID 18652），GetThreadDesktop 对它返回 NULL 且 GetLastError()==5，
  同一时刻本线程桌面上 5 个普通窗口全部正常返回 Default，有区分力。坑：锁屏持续一段时间后 GetForegroundWindow 变成
  NULL（前台锁屏窗口不再可见），此时 GetCursorPos + WindowFromPoint 拿到的窗口类是 LockApp 的
  LockScreenBackstopFrame（实测铺满全屏，11 个采样点全中），它是覆盖 fg=NULL 阶段的第二条只读判据；该类在
  EnumWindows 的 300 个窗口里命中 0 次，属锁屏安全桌面，故不会在未锁屏时误伤。此路两判据都保留：能命名时看桌面归属，
  不能命名时看光标类名。
- 现象：`page.addInitScript({ content })` 里的脚本在文档创建后、页面脚本前执行，那时 `document.documentElement` 与 `document.head` **都是 null**（实测 readyState=loading，三者皆 false），任何 `(document.head || document.documentElement).appendChild(style)` 都会抛 `Cannot read properties of null`，整段脚本中断——既不注入也不留哨兵，表现为「init script 静默无效」而 `evaluate` 同一份脚本却正常。解法：`ensureStyle` 里 `const root = document.head || document.documentElement; if (!root) return false`，并挂 `DOMContentLoaded` 一次性补挂 + 交给周期 sweep 自愈；不要假设 init 阶段 DOM 就绪。
- 现象：给会话层某个同步写字段的路径改成 `await applyFreezeSwitch(...)`（为了让函数变 async），`tests/reclaim.mjs` 用例 G 立刻报「非法会话状态转移：launching --launch-->」。原因：该 await 位于 `session.state = nextSessionState(state, 'launch')` **之前**，并发 launch 在那次让出事件循环的窗口里看到状态仍是 idle，抢先走转移表。解法：状态转移必须先于**任何** await；此处没有页面操作，改成同步写字段即可，不要为了统一风格给同步路径套 async。

- 现象：批量迁移脚本按「函数名白名单」匹配（只认 `edgeRootCount` / `playwrightEdgeRootCount`），漏掉了同类的 `edgeRoots`——它同样是无 timeout 的 spawnSync 数进程实现，且是唯一用池槽前缀过滤的那份；脚本对未匹配的文件静默跳过、不报错，导致「23 个全部迁移完成」的声称实际应为 24 个。独立复核会话抓到。解法：批量迁移前先用「反模式特征」而非「函数名」全仓取清单（如 `grep -l 'Measure-Object' tests/`），迁移后再用同一特征复查，要求残留数归零（新建的共享模块除外）；「剩下的都对」这种声称必须用命令列出剩余项验证，不能靠白名单遍历的完整性推断。
