# dsh-plugin-browser-e2e

DeepSeek Harness（DSH）浏览器端到端验证插件：提供浏览器操控能力，自动回收浏览器进程。

用系统 Edge（Playwright `channel: 'msedge'`）驱动，不触发 360 进程防护弹窗；装进 profile 后对所有会话与工作区可用，目标项目无需安装任何依赖。

## 工具

| 工具 | 作用 |
|---|---|
| `browser_start` | 启动浏览器（headless 默认开启），同一会话内复用同一实例 |
| `browser_e2e_navigate` | 导航到 URL，`waitUntil` 支持 load / domcontentloaded / networkidle；导航时清空控制台与网络缓冲 |
| `browser_e2e_snapshot` | 扫描可交互元素并分配 ref（`@N`），带 `box` 坐标、`depth`、`role`，上限 400 条并标记 `truncated` |
| `browser_e2e_click` | 点击：`ref`（点击前复验可见性，失效报错）/ `selector`（先等可见）/ `x`+`y`（真实鼠标事件）三选一 |
| `browser_fill` | 向 ref 对应的输入框填入文本 |
| `browser_e2e_press` | 按下键盘按键 |
| `browser_e2e_screenshot` | 截图：支持 `clip` / `format`(png\|jpeg) / `quality` / `scale`(css\|device)，截图前校验参数与输出尺寸；落盘返回路径，宿主有附件服务时一并返回图片 |
| `browser_e2e_console` | 读取控制台记录（log/info/warn/error/debug 与未捕获异常），环形 500 条，`limit` 取尾部 |
| `browser_e2e_network` | 读取网络记录（url/method/status/mimeType/failure），环形 500 条，`limit` 取尾部 |
| `browser_e2e_wait` | 等待条件：`selector`（配合 `state`）或 `expression` 二选一，`timeoutMs` 默认 10000，超时报实际等待时长 |
| `browser_evaluate` | 在页面上下文执行 JavaScript 表达式并返回 JSON 结果 |
| `browser_e2e_close` | 关闭本会话的浏览器实例 |

工具名统一带 `browser_e2e_` 前缀（`browser_fill` 除外），可与提供 `browser_*` 的插件（如 `@linxin666/dsh-client-ui-browser-view`）共存而不冲突。

## 进程回收

浏览器进程挂在 DSH 服务上，对话结束、会话切走、子代理结束都不会自动回收，因此本插件有三道回收：

1. **空闲回收**：超过 10 分钟没有任何 `browser_*` 调用，自动关闭该会话的浏览器；`DSH_BROWSER_IDLE_MS` 可改（设 0 关闭该行为）。
2. **会话回收**：`session/disposed` 时按 `session.id` 精确关闭对应浏览器。
3. **卸载回收**：插件卸载或热替换时关闭全部浏览器。

关闭本身也有兜底：Edge 偶发在 graceful close 阶段卡住（进程已退出但 Playwright 等不到退出事件），`DSH_BROWSER_CLOSE_TIMEOUT_MS`（默认 5000）到点后直接结束主进程，避免关闭调用永久挂起。

## 产物目录

截图落在 `~/.dsh/browser-e2e/artifacts/<时间戳>/`。

## 安装

```sh
# <sha> 取本仓当前 HEAD：git rev-parse --short HEAD
# pwsh / bash 下 `#` 与 `&` 是保留字符，spec 必须整体加引号
dsh plugin --profile desktop add 'github:lengduan/dsh-plugin-browser-e2e&<sha>'
```

git 依赖是快照，锁在指定 commit：改完源码要 commit + push，再在 profile 目录重新解析（`pnpm update dsh-browser-e2e`，或重新 add 新 sha），否则 profile 里跑的仍是旧提交。

## 开发

```sh
# 回收行为验证：真起无头 Edge，断言会话状态清空且进程退出（脚本自设 8 秒空闲）
node tests/reclaim.mjs

# 工具能力验证：console / network / snapshot box / 三种点击 / clip 截图 / wait
node tests/tools.mjs
```

纯 JS，无构建步骤；`package.json` 的 `files` 只含 `lib` 与 `cordis.patch.yml`，测试脚本不会被安装进 profile。
