# 面板操作历史 / 面板直控

状态: 已实现（A 切片：动作历史抽屉）；B / C 切片（面板直控）待决策
关联: specs/项目规格/0002-panel-protocol-v1.md（面板协议 v1、面板只读定位、命令 / 事件 / 错误码表）；specs/项目规格/0001-architecture-invariants.md（模块表「`client/index.js` 客户端 bundle、`lib/client.js` 构建产物」、依赖方向）；specs/项目规格/0003-未处理项.md（面板直控由 Lead 录入）；specs/功能规格/0020-session-reset.md、0021-auth-state-import.md、0023-tool-permission-gating.md、0024-clipboard.md、0029-human-wait-captcha.md（都明文「不改面板只读定位」，本项直控部分与这些句子同源冲突）；README.md「右侧实时浏览器面板」「面板协议与路由」
代码: client/index.js / tests/client-bundle.mjs

> 本规格只确认「面板操作历史（动作抽屉）」这一可施工切片：不改协议、不改只读定位、不改工具面。
> 「面板直控」判**影响大 → 待决策**（理由见 `.scratch/browser-plugin-survey/plans/24-panel-history-direct-control.md` §1 与 §6），
> 不写入本规格的行为与验收；决策前不实现。

## 需求

排障时要回答「刚才那几步到底做了什么」：面板现在只在动作提示里显示最近 5 条，第 6 条起被丢弃，也没有任何可展开的视图。结果是模型连做十几步后，人只能回到会话里翻工具结果，或者重跑一遍。

本规格把「动作历史」做成面板视图的一部分：宿主仍只在动作发生时广播一条既有 `action` 事件，客户端保留最近 50 条，并提供工具条入口展开成抽屉回看。收益是面板内即可回看较长操作序列；代价是这份历史只活在前端组件实例里（重连不丢、刷新 / 卸载会丢），不落盘、不脱敏——持久化与脱敏属 `0037-action-history-persist.md`（P2-28），不在本规格。

竞品 Fisfzy 的「历史抽屉」实际是**页面 / 空间轨迹**（缩略图、点击 pin 回看），工具调用历史在它的宿主状态里只保留 10 条并只渲染在 TUI 面板；本规格把「动作历史」转译为我方模型下可落地的那一半（动作记录 + 抽屉），不做缩略图与 pin（我方没有每页缩略图模型），也不做页面轨迹（`state.tabs` 的标签条已能切回页面）。

## 行为

### 数据与保留

- 数据来源不变：只消费既有 `action` 事件，载荷仍是 `{v, kind:'action', trace:{tool, summary, at}}`（协议表 `PANEL_EVENTS.action`，形状见 `0002`）。宿主 `PanelHub.broadcastAction` 的发送时机、摘要口径、失败摘要（`失败：<文案>`）一律不变。
- 客户端保留上限集中在 `client/index.js` 的常量：`ACTION_LIMIT`（内联提示条数，保持 5，既有行为）与新增 `ACTION_HISTORY_LIMIT`（历史抽屉保留条数，取 50，整数 ≥ `ACTION_LIMIT`）。
- `reduceEvent` 的 `action` 分支：把 `trace` 前插后按 `ACTION_HISTORY_LIMIT` 截断；`trace` 不是对象时原样返回（既有行为）。`EMPTY_VIEW.actions` 字段沿用。
- 内联动作提示（`st.traces` 区）仍只渲染 `view.actions` 的前 `ACTION_LIMIT` 条，DOM 结构（`data-dsh-part="actions"` 与其下 `data-dsh-part="action"`）不变。

### 入口与抽屉

- 工具条（`data-dsh-part="toolbar"`）在「刷新」按钮之后新增一个切换按钮：文本「历史」、`title` / `aria-label` 为「操作历史」、`data-dsh-part="history-toggle"`、`aria-expanded` 反映当前开合。按钮不禁用（无动作时可打开并看到空态）。
- 开合状态是组件本地 `useState` 布尔 `historyOpen`（缺省 `false`）。点击按钮切换；抽屉内的关闭按钮文本「关闭」、`data-dsh-part="history-close"`，只负责置回 `false`。
- `historyOpen === true` 时，用抽屉替换画布区：根节点子顺序仍为 `tabBar → toolbar → errorBanner →（抽屉 或 stage）→ settings → actionList`。抽屉根 `data-dsh-part="history"`，内含：
  - 标题行：文本「操作历史」+ 计数「共 N 条」（N = `view.actions.length`，最大 50）；
  - 列表（`overflow-y: auto`，`maxHeight` 内滚动），每行 `data-dsh-part="history-item"`：`formatClock(trace.at)` + `（tool ? tool + '：' : ''）+ (summary || tool)`，`title` 给完整文本、长文本 ellipsis 截断；新的在前（与 `view.actions` 顺序一致）。
  - 空态：`view.actions` 为空时渲染「还没有动作」的占位行（`data-dsh-part="history-empty"`），不渲染列表。
- `historyOpen === false` 时渲染既有 `stage`（`data-dsh-part="stage"`，图片 / 占位文案），行为逐字不变。

### 状态变化

- 会话 / 标签页 / 浏览器进程：完全不变。本规格不新增工具、不发协议命令、不触发 `captureJpeg` / 投屏重开。
- 面板：`state` / `hello` / `frame` / `error` 的解析与渲染不变；只多一个本地布尔与一份更长的 `actions` 数组。
- 历史内容随 `action` 事件累积：抽屉开着时新事件到达也照常记录并渲染；内联提示同步更新前 5 条。
- 连接断开重连（`createFeed` 的退避重连）不重置组件状态，历史保留；面板组件卸载或页面刷新后清空。

## 边界

- **面板直控不在本规格范围**：面板向页面派发输入（指针 / 键盘 / 导航）需要新增协议命令、改写 `0002` 的「面板默认只读」与命令 / 错误码表，并与工具调用并发竞争页面；判影响大 → 待决策，候选与影响面见计划 §6，由 Lead 录入 `specs/项目规格/0003-未处理项.md`。本规格的「只读」定位不变：面板仍不启动浏览器、不操作页面，唯一例外仍只有 `close-tab`。
- **不新增宿主侧历史环**：宿主不在内存里保存动作、不在 `attach` 时回放、不扩 `hello` / `state` 形状。因此「打开面板前发生的动作」「另一个面板连接收到的动作」都不在抽屉里；要跨连接 / 跨刷新回看需改协议（计划 §6 候选 B）。
- **不持久化、不脱敏**：历史只在前端内存，刷新即失；`summary` 按宿主既有口径原样显示（可能含页面文案、URL、输入值摘要），不在客户端做脱敏；持久化与脱敏归 P2-28。
- **不推断成败**：`action.trace` 没有 `ok` / `ms` 字段，客户端不按摘要前缀（如「失败：」）着色或过滤，避免把文案当结构。要结构化成败需宿主扩事件载荷（协议变更）。
- **不做快捷键**：不注册全局键盘监听，不提供 Esc 关闭；避免与宿主页面快捷键抢事件。
- **多连接**：每个面板连接各自的视图状态，抽屉内容不共享、不同步（与 `0002` 已记录的「`activeTabId` 不按连接隔离」不是同一件事：本项不新增全局状态）。
- **大摘要**：单条 `summary` 可能很长（宿主取返回值首行）；行内 ellipsis + `title`，不做二次截断常量，避免与宿主摘要口径分叉。

## 验收

1. `node scripts/build-client.mjs`：exit 0，`lib/client.js` 更新；随后 `node tests/invariants.mjs` exit 0、无 FAIL（含「源码 ↔ 产物一致」「命令 / 事件表与预期逐项相等」两条既有断言）。
2. `node -e "import('./lib/protocol.js').then(m=>console.log(Object.values(m.PANEL_EVENTS).length,Object.values(m.PANEL_COMMANDS).length,Object.values(m.PANEL_ERROR_CODES).length))"`：输出 `5 5 13`（本规格不新增事件 / 命令 / 错误码）。
3. `node tests/client-bundle.mjs`：exit 0、无 FAIL。本项新增用例（由 tester 落盘，命名照抄）：
   - `历史抽屉：工具条有历史按钮`（`data-dsh-part="history-toggle"`，文本含「历史」）
   - `历史抽屉：点击按钮展开抽屉`（出现 `data-dsh-part="history"`，`stage` 消失）
   - `历史抽屉：没有动作时显示空态`（`data-dsh-part="history-empty"`，文本「还没有动作」）
   - `历史抽屉：第 6 条动作只在抽屉里可见`（内联 `actions` 下 `action` 行仍为 5 条；抽屉 `history-item` 为 6 条）
   - `历史抽屉：抽屉保留最近 50 条并丢弃最旧`（推 51 条后 `history-item` 为 50 条，首条为第 51 条，末条不含第 1 条）
   - `历史抽屉：新的在前`（`history-item` 首行文本含最新一条的 tool 与 summary）
   - `历史抽屉：关闭后回到画面`（点 `history-close` 后 `history` 消失、`stage` 出现）
   - `历史抽屉：action 不带 trace 时不记录`（推 `{kind:'action'}` 后条目数不变）
   - 既有 `动作提示只保留最近 5 条，新的在前` 不改动、仍通过（内联口径未变）
4. `node tests/panel.mjs`：exit 0、无 FAIL。既有 `工具动作被广播`、`动作带摘要与时间`、`刷新按钮产生新帧` 不回归（协议与宿主行为未改）。
5. `npm run test:unit`（`tests/invariants.mjs` → `tests/client-bundle.mjs` → `tests/screencast.mjs` 串行）：exit 0、无 FAIL。
6. 手工 GUI 抽查（不作为 CI 门槛）：打开面板、让模型连做 ≥8 次工具调用，点「历史」能看到 8 条以上、时间与工具名正确、点关闭回画面、抽屉打开期间新动作继续进入列表顶部。

> 本规格状态为「已实现」：验收 3 的 8 条历史用例由 `tests/client-bundle.mjs` 覆盖（标签与上文逐字一致），内联提示「只保留最近 5 条」的既有断言未改动；验收 2 的计数由 `tests/panel.mjs` 的 `命令 / 事件 / 错误码计数为 5 / 5 / 13` 固定。面板直控（B / C 切片）仍为待决策，未实现。
