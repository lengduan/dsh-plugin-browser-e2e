# 面板协议 v1

状态: 已实现
关联: 0001-architecture-invariants.md（架构约束、panelTabId 规则、投屏设置单一来源）
代码: lib/protocol.js / lib/panel.js / client/index.js / scripts/build-client.mjs / tests/invariants.mjs

## 需求

面板协议原来有三处描述（`README.md`、`lib/panel.js` 头注释、`client/index.js` 头注释）与两处
版本常量，改一处会与其它处漂移。本文与 `lib/protocol.js` 把命令、事件、版本、路由路径、
投屏设置区间与默认值、`panelTabId` 组合规则收敛成一份契约；客户端所需的常量由
`scripts/build-client.mjs` 在构建时从 `lib/protocol.js` 注入。

收益：改协议只改 `lib/protocol.js`，host 与 client 的校验都从表派生。

## 契约

### 路由与版本

| 项 | 值 | 常量 |
|---|---|---|
| 状态路由 | `GET /api/dsh-browser-e2e/state` | `PANEL_STATE_PATH` |
| socket 路由 | `WS /api/dsh-browser-e2e/socket` | `PANEL_SOCKET_PATH` |
| 协议版本 | `1` | `PANEL_PROTOCOL_VERSION` |
| 版本不符关闭码 | `1002` | `PANEL_PROTOCOL_MISMATCH_CLOSE_CODE` |

- 两条路由都做 loopback 围栏（`lib/fence.js`）：socket 地址与 Host 头都必须是 loopback，
  拒绝 `sec-fetch-site: cross-site`，同源 Origin 放行；非 loopback 在升级之前返回 403。
- 首帧 `v` 与 `PANEL_PROTOCOL_VERSION` 不一致时回 `protocol-mismatch` 错误事件并关闭连接（1002）；
  后续帧版本不符只回错误事件、不断开。

### 命令表（client → host）

| 命令 | 参数 | 语义 |
|---|---|---|
| `attach` | `sessionId?` | 绑定连接所属会话，回 `hello{state}` |
| `select-tab` | `tabId` | 选中并固定面板 tab |
| `close-tab` | `tabId` | 关闭该页面；最后一个页面回 `last-tab` 错误 |
| `request-frame` | 无 | 宿主立即截一帧 JPEG 推回（刷新按钮） |
| `configure` | `config{quality?,maxWidth?,maxHeight?,everyNthFrame?}` | 合并设置并重开投屏 |

未知命令一律回 `invalid-command` 错误事件，不静默丢弃。

### 事件表（host → client）

| 事件 | 载荷 |
|---|---|
| `hello` | `{state}`（attach 的应答） |
| `state` | `{state}` |
| `frame` | `{tabId, seq, width, height, data}`（base64 JPEG，seq 单调递增，client 丢弃旧帧） |
| `action` | `{trace:{tool, summary, at}}` |
| `error` | `{code, message}` |

`state` 形状：`{tabs, activeTabId, running, mode, endpoint, config}`；
`tabs` 项为 `{id, url, title, loading, origin, sessionId, mode, endpoint}`；
`mode` / `endpoint` 由当前选中 tab 的所属会话推导，无 tab 时按隔离模式回退
（`mode: 'isolated'`、`endpoint: ''`）。

### 投屏设置（区间与默认值的唯一来源）

| 字段 | 区间 | 默认 |
|---|---|---|
| `quality` | 10-100 | 70 |
| `maxWidth` | 100-4096 | 1280 |
| `maxHeight` | 100-4096 | 800 |
| `everyNthFrame` | 1-10 | 1 |

- host：`mergeConfig`（用户当场操作，越界回 `invalid-config`）与 `initialConfigOf`（插件配置可能
  被手改脏，逐字段回退默认）都遍历 `PANEL_CONFIG_LIMITS`。
- client：不手写区间与默认值；`scripts/build-client.mjs` 把 `PANEL_PROTOCOL_VERSION`、
  `PANEL_SOCKET_PATH`、`PANEL_CONFIG_LIMITS`、`DEFAULT_SCREENCAST_CONFIG` 生成常量块，
  替换 `client/index.js` 里的 `/* @inject:panel-protocol:start|end */` 标记。
- `tests/invariants.mjs` 校验生成的 `lib/client.js` 常量块与 `lib/protocol.js` 逐字段相等，
  并断言 `client/index.js` 里不再手写这些值。

### `panelTabId`

组合 `key + '#' + tabId`，拆分以最后一个 `#` 为界（会话 key 可含 `#`，tab_id 为 `t<N>`）。
唯一实现 `lib/protocol.js:panelTabId / parsePanelTabId`；`session.js` 与 `panel.js` 都从那里取，
不再各写一份（基线 `browser.js:1651-1662` 与 `panel.js:41-51` 两份逐字重复）。

## 边界

- 面板只是视图：不启动浏览器、不操作页面；所有行为只能由 `browser_e2e_*` 工具发起。
- 宿主不提供 `webServer` 时（CLI 场景）不挂路由，工具照常可用。
- `configure` 只改宿主进程内配置，不写回 profile；插件重载后回到插件 Config 的值。
- 投屏是 CDP `Page.startScreencast`：静态页面不产生新帧，刷新按钮走 `captureJpeg` 兜底。

## 验收

1. `node tests/invariants.mjs`：协议常量与 client 注入块一致、命令/事件表、`panelTabId` 往返。
2. `node tests/panel.mjs`：围栏、设置合并、表驱动工具契约、WebSocket 端到端（hello / 帧 /
   动作 / configure / request-frame / 未知命令 / 协议版本不符 / 关闭后状态清空）。
3. `node tests/client-bundle.mjs`：`SUMMARY: 36 passed, 0 failed`，含 `parseEvent` / `reduceEvent`
   对协议表派生的行为断言。
4. `node scripts/build-client.mjs` 通过后 `lib/client.js` 为最新生成物。
