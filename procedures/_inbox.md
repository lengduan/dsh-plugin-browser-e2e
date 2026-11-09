# 待整理（inbox）

<!-- 一行一条：现象 + 一句话解法。够格的按 _模板.md 升成卡后删掉这条。 -->

- 现象：用 junction 路径（EdgeCDP-Link）当 `--user-data-dir` 启动过真实 Edge profile 后，再用默认路径启动同一 profile，用户扩展目录被回收、`Secure Preferences` 里扩展条目被丢弃（2026-11-09 复现：5 个刚装好的扩展目录在 10:16 被清空，prefs 条目残留；11/7 22:21 junction 启动 + 11/8 10:18 默认启动的那次丢失与之同形）。解法：要接真实 profile 就别开调试端口，或另用一次性 profile；别在同一个 profile 上混用两种路径启动。（2026-11-09 10:47 补证：同一 profile 的 cookie 库只剩 97 条 / 33 个 host，无 11-08 条目、11-07 仅剩 9 条，即 cookie 与扩展在 junction 启动的同一时间被清空。）
- 现象/方案验证：把真实 Edge profile 的最小登录集合（Local State / Preferences / Secure Preferences / Network\Cookies / Login Data / Web Data / Bookmarks / Local Storage）复制到临时目录，用 `--user-data-dir=<副本> --remote-debugging-port=9222` 启动再 CDP 接管。2026-11-09 实测：原 profile 的 Cookies SHA256 前后一致、完全没被改动；副本里 Edge 账户仍登录（941082240@qq.com，同步已启用），GitHub 的 v10 cookie（user_session 等）可用；但 v20 cookie 大量失效——原库 104 条，副本浏览器只能读出 55 条，figma / aliyun / linkedin / 公司 wiki 等 host 整批消失，Local Storage 的 storageState origins 为 0。结论：复制方案能保证「不动原件」，但只能共享 v10 与账户令牌，v20 与 localStorage 共享不了。
- 现象：Edge 里点 Chrome 应用商店的「添加至 Chrome」后，安装确认是浏览器原生弹窗（不在页面 DOM），CDP/Playwright 点不到；`--disable-extensions` 启动会连商店安装一起抑制，`--disable-extensions-except` 会让 9222 端口不监听。解法：确认弹窗用 UI Automation（`UIAutomationClient` 找 Button 名 `添加扩展` 后 InvokePattern.Invoke）；Chrome 商店需要代理时，SwitchyOmega 一类扩展会用 PAC 覆盖 `--proxy-server`，要么临时切换其情景模式到走代理的档位，要么在 `--disable-extensions` 下改用 Edge 加载项商店装。
