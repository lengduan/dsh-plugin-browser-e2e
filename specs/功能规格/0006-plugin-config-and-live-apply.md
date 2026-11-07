# 插件配置与运行中即时生效

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表、投屏设置口径）；specs/项目规格/0002-panel-protocol-v1.md（投屏设置（区间与默认值的唯一来源）、`configure` 命令、`state` 形状）
代码: lib/index.js / lib/panel.js / lib/protocol.js / lib/defaults.js / tests/panel.mjs / tests/invariants.mjs

## 需求

插件在宿主设置页提供六项配置：启动模式的默认值、CDP 端点、四项投屏参数。保存后不重载插件，就要对后续启动与正在运行的面板生效；同时 profile 里的配置可能被手改成脏值，不能因为它让面板或启动整体失败。收益：改设置即刻可见，脏值只影响对应那一项。

## 行为

- Config schema：`lib/index.js` 导出的 `Config` 共六个字段——`defaultMode`（`Schema.union(['isolated', 'cdp']).default('isolated')`）、`cdpEndpoint`（`Schema.string().default(DEFAULT_CDP_ENDPOINT)`）、`quality` / `maxWidth` / `maxHeight` / `everyNthFrame`（`Schema.number()`，不设 schema 默认值）；六个字段全部调用 `.volatile()`，声明为即时字段。`Schema` 由动态 `import('@deepseek-ai/schemastery')` 得到，导入失败时为 `undefined`，此时导出的 `Config` 也是 `undefined`，宿主按「无配置」处理（`lib/index.js` 注释口径；该依赖由宿主 profile 提供）。
- 读取：`configValue(raw)` 对带 `get()` 的对象调 `get()` 取当前快照（`.volatile()` 字段在宿主里是稳定引用，保存设置只替换引用里的快照），`get()` 抛错时返回 `undefined`，非引用的原始值原样返回。
- 启动缺省：`launchDefaultsOf(config)` 返回 `{ mode?, cdpEndpoint? }`：`defaultMode` 只认 `isolated` / `cdp`，`cdpEndpoint` 只收非空字符串，非法值当作未配置；`apply` 里的 `launchDefaults` 是 getter，`browser_e2e_start` 每次调用都重新读取，因此保存后对后续启动即时生效。
- 投屏初始参数：`screencastConfigOf(config)` 把四个投屏字段摊平成普通值交给 `new PanelHub({ config })`；`PanelHub` 构造里 `initialConfigOf(options?.config)` 从 `DEFAULT_SCREENCAST_CONFIG` 起步，按 `PANEL_CONFIG_LIMITS` 逐字段覆盖：缺失（`undefined` / `null`）跳过，非整数或越界跳过，同一批里合法字段照常生效。
- 运行中保存：`apply` 注册 `ctx.on('loader/volatile-update', ...)`，回调重读配置并调 `hub.applyConfig(screencastConfigOf(config))`。`applyConfig` 用 `initialConfigOf` 重算完整设置：与当前设置 `JSON.stringify` 相同就直接返回，不重开投屏；有变化则先 `restartScreencast()`（`screencast.stop()` 再 `ensureScreencast(activeTabId)`）再 `broadcastState()`，失败由 `reportError(PANEL_ERROR_CODES.configSyncFailed, error)` 上报；Hub 已 `dispose` 时只更新内存里的 `this.config`，不再开投屏。
- 两条入口的失败策略不同：socket 的 `configure` 走 `mergeConfig`（用户当场操作，字段非整数或越界抛错，`PanelHub` 的 `handleCommand` 回 `invalid-config` 错误事件）；插件配置走 `initialConfigOf`（脏值逐字段回退默认，不抛错）。两者共用 `lib/protocol.js` 的 `PANEL_CONFIG_LIMITS` 区间表，默认值共用 `DEFAULT_SCREENCAST_CONFIG`，协议表是唯一来源。
- 投屏参数语义：四项透传给 `lib/screencast.js` 的 `Screencast` 的 `_start` 里的 `Page.startScreencast`——`quality` 是 JPEG 质量 10-100，`maxWidth` / `maxHeight` 是推帧最大宽高 100-4096，`everyNthFrame` 是每 N 帧推一帧 1-10。

## 边界

- 保存设置不重载插件：`.volatile()` 让宿主只替换配置引用里的快照并广播 `loader/volatile-update`；`configValue` 每次读 `get()`，`launchDefaults` getter 每次 `browser_e2e_start` 重读。
- 配置默认值不会让已启动会话报 mode 不一致：`browser_e2e_start` 把默认值作为 `launch` 的第四参（`defaults`），不并进 `args`；已启动时的一致性校验只看显式传参（见 `0002-browser-launch-and-reuse.md`）。
- `configure` 只改宿主进程内 `PanelHub` 的 `config` 字段，不写回 profile；插件重载后回到插件 `Config` 的值。
- 脏值逐字段回退：单字段非法（越界、非整数、`null`、字符串如 `wide`）只丢该字段，同批合法字段仍然生效，不会整份配置失败；配置本身不是对象时 `configValue` 与 `screencastConfigOf` 都按「没配」处理。
- 投屏四项在 Config schema 里不设默认值：默认值与区间只由 `lib/protocol.js` 的 `DEFAULT_SCREENCAST_CONFIG` / `PANEL_CONFIG_LIMITS` 决定，避免宿主与 client 各写一份默认值。
- 设置没有变化时 `applyConfig` 直接返回，一次保存不会无谓地重开投屏。
- `Config` 为 `undefined`（schema 不可用）时：`launchDefaultsOf(undefined)` 返回 `{}`（`launch` 用内置缺省），`screencastConfigOf(undefined)` 给出四个 `undefined`，`initialConfigOf` 全部回退 `DEFAULT_SCREENCAST_CONFIG`。
- 明确不重复：client 设置卡片的区间 clamp 与 `configure` 命令的协议语义属面板协议，见项目规格 `0002-panel-protocol-v1.md` 与功能规格 `0002-browser-launch-and-reuse.md`。

## 验收

1. `node tests/panel.mjs`（真起无头 Edge）：用例 B 设置合并的 `部分字段合并`、`空 patch 不动原值`、`quality 越界报错`、`非整数报错`、`config 非对象报错`；用例 E 启动缺省的 `配置 defaultMode=cdp 被首次启动消费`、`未提供配置时默认 isolated`、`配置默认值不让已启动会话报 mode 不一致`、`volatile 更新后 start 即时读到新 defaultMode / cdpEndpoint`、`mode=cdpp 的 start 显式报错且不启动 isolated`；用例 F 投屏接线的 `PanelHub 构造时合并 Config 投屏参数`、`非法投屏参数逐字段回退默认`、`applyConfig 回推含新 config 的 state`、`applyConfig 非法值回退默认`、`apply 读取 volatile 配置引用`；端到端段落里的 `非法设置回 error 事件`（`invalid-config`）。判定：exit 0、输出无 FAIL。
2. `node tests/invariants.mjs`（不起浏览器）：`投屏区间与默认值自洽（默认值逐项落在区间内）`、`生成的 bundle 常量与 protocol.js 逐字段一致`、`默认 CDP 端点单源：bundle 注入值等于 lib/defaults.js，client 源文件不手写 9222`、`默认 CDP 端点宿主侧取自 lib/defaults.js（session / index 不各写一份）`、`client 源文件只留注入标记，不手写区间与默认值`、`captureJpeg：未传 quality 时取 DEFAULT_SCREENCAST_CONFIG.quality`。判定：exit 0、输出无 FAIL。
3. `node tests/screencast.mjs`（假 CDP，不起浏览器）：`configure 顺序为 restart -> broadcast`、`configure 返回 accept 且未回错误`——与 `applyConfig` 是同一「先按新参数重开投屏、再广播状态」的顺序。判定：exit 0、输出无 FAIL。
