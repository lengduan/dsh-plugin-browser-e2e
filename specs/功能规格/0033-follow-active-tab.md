# 跟随用户当前标签页

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/page.js`、隐式接口 `activeTabId` 的读写方、能力函数返回值被 `tools.js` 读取的字段、P3 throw 分类）；specs/项目规格/0002-panel-protocol-v1.md（`state.activeTabId` 是面板自己的选中项，本项不改协议）；specs/功能规格/0002-browser-launch-and-reuse.md（复用摘要取 active 页地址、`activeTabId` 由 `addPage` 初始化）；specs/功能规格/0008-cdp-attach.md（接管时 `activeTabId` 取第一页、`context.on('page')` 增量登记 adopted 页）；specs/功能规格/0004-snapshot-and-ref-table.md（ref 表按页隔离）；specs/功能规格/0013-wait-url-and-response.md（显式 `tab_id` 在调用开始时解析、等待期间不跟随 active tab 切换）
代码: lib/page.js / lib/tools.js / tests/follow.mjs / tests/cdp.mjs

## 需求

用户在真实浏览器里切到另一个标签页后，不传 `tab_id` 的页面工具仍作用在会话内部的 active tab（`lib/page.js` 的 `currentTab` 只认显式 `tab_id`，否则取 `session.activeTabId`；`lib/tools.js` 的 `TAB_ID_PARAM` 描述为「缺省用当前 active tab」）。agent 想「跟随用户正看着的页」只能先 `browser_e2e_tabs` 再逐个工具传 `tab_id`。本规格固定一个新工具 `browser_e2e_follow_tab`：把后续页面工具的默认目标绑定到某个标签页；不给 `tab_id` 时自动判定用户当前正在看的标签页，`activate: true` 时把该页带到前台。只做一次显式绑定，不做静默自动跟随（理由见「边界」）。

## 行为

### 工具与参数

- 工具名 `browser_e2e_follow_tab`，定义在 `lib/tools.js` 的 `buildToolTable`，位置在 `browser_e2e_close_tab` 与 `browser_e2e_snapshot` 之间；能力实现在 `lib/page.js` 的导出 `followTab(session, options)`。
- 根 schema 由 `params({...})` 生成：`required: []`、`additionalProperties: false`，两个参数都可省略。

| 参数 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `tab_id` | string | 未给（含空串） | 要绑定的标签页 id（`browser_e2e_tabs` 得到，形如 `t2`）。给了就跳过自动判定 |
| `activate` | boolean | `false` | 绑定后把该页带到前台（`page.bringToFront()`）；只认 `=== true` |

- `tab_id` 不是字符串（number / boolean / object / null）报 `tab_id 必须是字符串（browser_e2e_tabs 得到的 t1、t2…）；不传表示自动判定用户当前标签页`。空串按未给处理，与 `currentTab` 的空串口径一致。
- 两个参数不互斥，都不是必填；没有额外的互斥组合。

### 目标解析

1. 入口先 `assertBrowserRunning(session)`：没有会话或 0 个标签页时沿用 `浏览器尚未启动，请先调用 browser_e2e_start`。
2. 显式 `tab_id`：`assertTabExists(session, tabId)`，不存在沿用 `tab {id} 不存在，请先 browser_e2e_tabs 获取最新 tab_id`；判定来源记为 `explicit`。
3. 无 `tab_id`：判定用户当前正在看的标签页。
   - 对 `session.pages` 的每个条目并行探测主文档：`page.evaluate(() => ({ visibility: document.visibilityState, focus: document.hasFocus() }))`。单页超时 `FOLLOW_PROBE_TIMEOUT_MS`（2000ms，`lib/page.js` 导出）；超时、抛错（页面已关、受保护页面、主线程卡死、返回值不是对象）只把该页从候选里剔除并计入 `failedProbeCount`，不让整次调用失败。
   - 判定优先级，命中即返回：
     1. 恰好一个候选 `focus === true` → 该页，来源 `focused`；
     2. 否则恰好一个候选 `visibility === 'visible'` → 该页，来源 `visible`；
     3. 否则 `session.activeTabId` 仍落在可探测候选里 → 保持当前页，来源 `current`，`ambiguous: true`（0 个可见或多于 1 个可见都走这条，不猜别的页）。
   - 候选为空（所有页探测失败）报 `无法判定用户当前标签页：所有标签页都未能返回可见性（{首个失败原因}）；请先 browser_e2e_tabs，再带 tab_id 调用 browser_e2e_follow_tab`。
   - 候选非空但既不唯一、当前页又不在候选里，报 `无法判定用户当前标签页：{N} 个标签页同时可见或都不可见，当前默认标签页也不在可探测结果里；请先 browser_e2e_tabs，再带 tab_id 调用 browser_e2e_follow_tab`。
   - 候选按 `session.pages` 的登记顺序排列；返回与文本最多列 `FOLLOW_PROBE_DISPLAY_LIMIT`（10）条，其余以计数呈现。
4. `activate: true` 只在「显式 `tab_id`」或「判定来源为 `focused` / `visible`」时执行 `page.bringToFront()`：成功记 `activated: true`；抛错报 `标签页 {id} 带到前台失败：{原始 message}；默认标签页未改变`，且不写 `activeTabId`。来源为 `current` 时即使传了 `activate` 也不切前台，返回 `activated: false`（避免在没判定准的情况下抢用户焦点）。
5. 写 `session.activeTabId = tab.id`。ref 表、控制台 / 网络环形缓冲、快照基线、对话框记录都按页隔离，跟随不清理、不重建；旧页的 ref 仍然有效（与竞品「跟随后重排页面编号」的等价效果由按页隔离的架构保证）。

### 返回、文本与状态

- 能力函数返回：`{ tabId, previousTabId, changed, source, activated, ambiguous, candidates, failedProbeCount, url, title, tabs, summary }`。
  - `previousTabId` 可能为 `null`；`changed = previousTabId !== tabId`；`ambiguous = source === 'current'`；`tabs = session.pages.size`。
  - `candidates` 只在无参模式返回：`[{ tabId, visibility, focus }]`，探测失败的页不列出，最多 `FOLLOW_PROBE_DISPLAY_LIMIT` 条；`failedProbeCount` 只在无参模式返回。
- `summary` 三种形态：`跟随标签页 {id}（{标题或 URL}）`；`跟随标签页 {id}（{标题或 URL}），已带到前台`；`未能唯一判定用户当前标签页，保持标签页 {id}（{标题或 URL}）`。`lib/index.js` 的 `execute` 用 `summaryOf` 取首行广播面板 `action` 事件，摘要里不出现页面正文。
- 工具层文本：摘要行；`判定依据：显式 tab_id | 窗口焦点所在页 | 唯一可见页 | 多个页同时可见或都不可见，保持当前`；`上一个默认标签页：{id | 无}`；无参模式追加 `探测结果：t1 visible / 已聚焦；t2 hidden / 未聚焦`（最多 10 条，超出追加 `…等 {n} 个`）；`activate` 为真时追加 `已请求带到前台：{是 | 否}` 与 `无头模式没有可见窗口，activate 只对 CDP 接管 / 有头隔离模式有可见效果。`；末行 `后续作用于页面的工具不传 tab_id 时默认作用在 {id}。`
- 会话：只改 `activeTabId`；`state` / `pages` / `mode` / `endpoint` / `artifactsDir` 不变；不新建标签页、不关闭、不导航。
- 面板：不改 `lib/protocol.js` / `lib/panel.js` / `client/index.js`，不需要重建 `lib/client.js`；`state.activeTabId` 是面板自己的选中项（`0002`），本工具不广播事件，面板 tab 条与画面不受影响。
- 进程：不启动、不关闭、不改视口；`activate` 只调 `page.bringToFront()`，不调系统窗口 API。

## 边界

- **不做静默自动跟随**：用户切页后，不传 `tab_id` 的工具不会自动改绑，仍需显式调用本工具。竞品的做法是切页后暂停并在面板里让人选择「留在原页面 / 跟随当前页面」（omdsh `extensions/dsh-browser/src/background/tab-affinity.ts` 的 `TabAffinityStatus` / `affinityFailure`，`src/panel/strings.ts` 的 `tabHandoff`），我方面板是只读视图（`0002`），没有这条人工通道。要做到「每次工具调用都实时跟随」，必须改 14 个页面工具的默认目标解析与 `activeTabId` 的含义，属另一项规格的范围，本项不做。
- isolated 模式下用户自己新开的标签页不登记：`lib/session.js` 的 `launch` 只在 `cdp` 分支注册 `context.on('page')`，因此无参判定只能在会话已登记的页里选；`cdp` 模式接管期间新开的页以 `adopted` 登记，可被判定。
- 无头模式没有可见窗口：`document.visibilityState` / `document.hasFocus()` 可能全部为 `visible` 或全部为 `hidden`，此时按 `current` 保持并在文本里说明；要确定性绑定请显式传 `tab_id`。
- 受保护页面（`edge://` 等）与主线程卡死的页面探测失败或超时，不进入候选；探测本身不会终止页面脚本（与 `0019-evaluate-timeout.md` 不同，本工具只做宿主侧超时）。
- 只探主文档：页面级可见性不进入 iframe；iframe 内操作由 `0018-iframe-operations.md` 处理。
- 不改变 active tab 的定义：仍然表示「不传 `tab_id` 时页面工具作用的页」，本工具只是新增一个写入方（与 `navigate` 带 `tab_id` 时写 `activeTabId` 同类）。
- 不新增 `lib/invariants.js` 断言：未知 tab 用既有 `assertTabExists`，无页用既有 `assertBrowserRunning`；探测失败与页面被关是操作结果（P3 分类「运行时」），不是跨调用状态损坏；入参校验留在能力函数入口（「单次」）。
- 不提供取消 / `AbortSignal` 参数：探测固定 2000ms 每页并行，整次调用约 2000ms 量级。
- 并发：同一会话并发 follow 以最后落定者为准；follow 与 `browser_e2e_close_tab` 并发时，若目标在探测后被关，报 `标签页 {id} 在跟随过程中已关闭，请先 browser_e2e_tabs 确认最新标签页`，不把已摘除的 tab 写回 `activeTabId`。
- 不选窗口、不做窗口级聚焦：`activate` 只对目标页调 `page.bringToFront()`，多窗口下哪个窗口在前台由浏览器决定。

## 验收

1. `node tests/follow.mjs`（真起无头 Edge；假页面用例不需要浏览器但同文件运行）：exit 0、输出无 FAIL。用例与 `check` 标签：
   - 用例 1（假页面，不启浏览器，直接给 `followTab` 传会话字面量）：`聚焦页优先于其他可见页`、`唯一可见页被选中`、`多页可见且无焦点时保持当前（source=current）`、`全部不可见时保持当前（source=current）`、`探测失败的页不计入候选且 failedProbeCount 正确`、`所有页探测失败时报「无法判定用户当前标签页」`、`无法判定且传 activate 时不切前台`。
   - 用例 2（显式绑定）：`显式 tab_id 绑定成功且 changed=true`、`重复绑定同一页 changed=false`、`绑定后缺省 tab_id 的快照作用于新绑定页`、`tabs 的 active 标记随绑定切换`、`activate=true 返回 activated=true`、`activate 后目标页 document.visibilityState 为 visible`。
   - 用例 3（无参判定，真浏览器）：`activate 后无参判定回到被激活页`（断言 `tabId === 't1'`，`source` 为 `focused` / `visible` / `current` 之一）、`单页会话无参判定返回该页`、`无参判定不新建也不关闭标签页`。
   - 用例 4（边界与并发）：`未知 tab_id 报「不存在」`、`tab_id 非字符串报错`、`未启动时报「浏览器尚未启动」`、`零页时报「浏览器尚未启动」`、`主线程卡死的页不阻塞判定（整次调用 5000ms 内返回）`、`并发 closeTab 与 follow 后 activeTabId 仍指向存在的页`。
   - 收尾：`msedge 主进程回落到运行前基线`。
2. `node tests/cdp.mjs`：exit 0、无 FAIL。新增 `CDP 接管下显式 tab_id 绑定生效`、`CDP 接管下无参判定返回 adopted 页`、`CDP 绑定不改变浏览器进程与页面数`；找不到 Edge 时按现有 SKIP 口径以 0 退出。
3. `node tests/panel.mjs`：exit 0、无 FAIL。`工具表共 32 个`（本项落地时由 28 更新为 29，P2-26/27/28 合入后现为 32）、`注册的工具与工具表逐项一致（顺序与名字）`、`作用于页面的工具都接受 tab_id`（名单加入 `follow_tab`）、`browser_e2e_follow_tab 的 tab_id 可选、activate 为布尔`。
4. `node tests/tools.mjs`：exit 0、无 FAIL。`工具表共 32 个（含 read / dialog / follow_tab / fetch / http / history）`。
5. `node tests/read.mjs`：exit 0、无 FAIL。`browser_e2e_read 注册且带 tab_id`（其中的工具总数断言同步为 29）。
6. `npm run test:unit` 与 `npm run test:integration`：exit 0、输出无 FAIL；`package.json` 的 `test:integration` 包含 `node tests/follow.mjs`。
7. 客户端未变：`git status --porcelain lib/client.js lib/protocol.js lib/panel.js client/index.js` 输出为空。
