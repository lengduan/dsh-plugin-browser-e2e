# 客户端座位注册面与 entry 激活失败

状态: 已实现
关联: 无（项目规格目录尚无正式条目）
代码: client/index.js / lib/client.js / tests/client-bundle.mjs / README.md

## 需求

记录并约束一次真实故障：新版客户端 bundle 在右侧面板之外又注册了插件设置页座位
（`plugins.row.config`）与插件卡片座位（`plugins.bundle.config` / `web-ui.plugin.item`），
桌面宿主加载后 `dsh-browser-e2e` 这个客户端 entry 激活失败，整个 GUI 页面 boot 失败
（表现为 DSH 桌面客户端启动不起来）。

收益：把「客户端只能注册面板所需的座位」写成可验收的约束，避免后续功能再踩同一个坑。

## 行为

- 客户端 bundle 的注册面固定为：
  - `sidebarRightTabs.register(tabDefinition())`：tab 类型 `dsh-browser-e2e`，只注册一次。
  - `slots.inject("sidebar.right.pane.tab", ...)` + `slots.inject("sidebar.right.pane.tab.title", ...)`：
    面板 body 与右侧栏 chip 两个 keyed 座位，共用一个 liveTitle 通道。
- 客户端 `inject` 服务依赖只有 `["slots", "sidebarRightTabs"]`；不再注册设置 / 卡片座位，
  也不再通过 `configForms` 懒取宿主服务（该入口已从 bundle 移除）。
- `apply(ctx)` 可重入：宿主再次调用时先执行上一次保存的 disposer，再重新注册；
  不得出现 `tab type id "dsh-browser-e2e" is already registered`。
- 插件级设置页不靠客户端座位：宿主插件管理页按本插件导出的 `Config` 自行
  `renderSlot("plugins.row.config", { view: "page", form }, { entryKey })`。
- 客户端不注册 `plugins.row.config`、`plugins.bundle.config`、`web-ui.plugin.item`
  三个座位（当前桌面宿主上注册会让本 entry 失败）。

## 边界

- 宿主缺 `slots` / `sidebarRightTabs` 服务时，对应注册跳过或抛错被 `warn` 吞掉，
  面板缺席但不影响 entry 激活。
- 插件卡片功能在当前宿主版本下不可用；等宿主侧座位注册问题修复后，才允许恢复
  卡片注册，恢复时必须按「验收」第 3 条做一次真实页面验证。
- 座位注册失败的错误文本是排查锚点：
  - `web boot: 1 entry did not activate` + `<entry id>: failed`
  - `sidebarRightTabs.register 注册失败：... tab type id "dsh-browser-e2e" is already registered`
- 安装层面：插件的 `cordis.patch.yml` 是 bundle patch，只能由 bundle 层消费；
  不要把它覆盖到 profile 根目录的用户 patch 层，否则会出现同一插件被插入两次的
  假象（本次排查中先遇到该干扰项）。重装 profile 时只替换插件包自身的
  `lib/`、`package.json` 等文件，不动 profile 的 `cordis.patch.yml`。

## 验收

1. `node tests/client-bundle.mjs` 输出 `SUMMARY: 36 passed, 0 failed`；其中断言
   `api.inject` 恰为 `["slots","sidebarRightTabs"]`、`apply` 只产生 2 条 `slots.inject`、
   2 条 `slots.register`。
2. `node scripts/build-client.mjs` 通过后，`lib/client.js` 是最新生成物：构建注入协议常量、
   命令 / 事件表与默认 CDP 端点（头注释 + 注入块），`node tests/invariants.mjs` 用
   `scripts/protocol-inject.mjs` 断言 `HEADER + injectProtocol(readSource())` 与 `lib/client.js`
   全文一致；部署到 profile 的产物 hash 与仓库产物相同。
3. 用独立 profile（复用 desktop 的 bundles 与本插件）+ `dsh <profile>` 起 web 服务，
   用系统 Edge 打开首页并在 8 秒后检查控制台：不得出现
   `web boot: ... did not activate`、`already registered`；页面标题为 `DeepSeek Harness`，
   正文可交互。
4. 全量串行 9 个测试：invariants / client-bundle / screencast / panel / tools / auth /
   multitab / cdp / reclaim，合计 356 PASS / 0 FAIL（2026-11-07 实测，见 `.scratch/review-loop/03-执行记录.md`）。
