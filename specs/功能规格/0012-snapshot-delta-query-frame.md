# 快照增量 / 过滤 / 跨 frame

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/page.js` 的职责；进程内对象契约「标签页条目」与「browser_e2e_snapshot 返回字段」；已知结构性债务「page.js 粒度过大」）；specs/功能规格/0004-snapshot-and-ref-table.md（全量快照形状与 ref 生命周期，本规格的 delta 分支修订该文件的「ref 生命周期」节）；README.md「事件环重置」
代码: lib/page.js / lib/snapshot.js / lib/tools.js / tests/snapshot.mjs

## 需求

`browser_e2e_snapshot` 每次返回整页可见 DOM。操作一次就重取一次全量，会把 4000 条上限带来的体积（README 实测 4100 个 div 的模型可见文本约 189 KB）反复推入上下文；快照脚本只遍历主文档 `document.body`，同源 iframe 内的元素读不到。本功能在同一个工具上增加三个可选能力：只返回自上次快照以来的变化节点（delta）、按 text / CSS selector / role 过滤定位（query）、读取指定同源 iframe（frame）。缺省全量行为、4000 条上限与既有 ref 语义保持不变。

## 行为

### 输入

工具 `browser_e2e_snapshot` 原只接受 `tab_id`，新增三个可选参数：

| 参数 | 类型 | 缺省 | 约束 |
|---|---|---|---|
| `delta` | boolean | `false` | 与 `query` 互斥；与 `frame` 可组合 |
| `query` | object | 无 | 与 `delta` 互斥；与 `frame` 可组合 |
| `frame` | integer \| string | `0` | integer：`0` 为主文档，`n≥1` 为按 `page.frames()` 顺序过滤掉主文档后的第 `n` 个；string：先精确匹配 frame 的 `name`，无命中再按 `url` 子串匹配；只接受同源 frame |

`query` 子字段：

| 字段 | 类型 | 缺省 | 约束 |
|---|---|---|---|
| `text` | string | 无 | 非空；不区分大小写的子串，匹配元素的 `name` 或正文文本（正文只取前 500 字符） |
| `selector` | string | 无 | 非空；CSS 选择器；与 `text` 互斥 |
| `role` | string | 无 | 非空；作为附加过滤，可与 `text` 或 `selector` 组合 |
| `limit` | integer | `20` | 1–100 |
| `includeHidden` | boolean | `false` | 为 `true` 时保留不可见元素并标 `hidden: true` |

必填与互斥：

- `query` 至少给 `text` / `selector` / `role` 之一。
- `query.text` 与 `query.selector` 互斥。
- `delta: true` 与 `query` 同时出现直接报错，不执行页面脚本。
- `frame: 0` 与不传 `frame` 等价。

### 输出

所有模式返回 `{ tabId, url, mode, frame, summary, text, ... }`：

- `mode` 为 `'full' | 'delta' | 'query'`；`frame` 为 `{ index, name, url, parentIndex }`，主文档 `index: 0`、`parentIndex: null`。
- `summary` 为一行摘要（进入面板 `action` 事件），`text` 为模型可见正文。
- 所有模式另带 `scanTruncated`（是否因扫描上限提前停止，见「边界」）。

**full**（不传 `delta` / `query`）：

- 返回既有字段 `count` / `total` / `truncated` / `nodes` / `text` / `summary`；`nodes` 每项仍是 `{ ref, tag, id, classes, role, name, text, box, depth, xpath }`。
- 主文档：`tab.refs` 先清空，再按本次返回顺序分配 `@0..@n-1`；同时把本次结果写成该 frame 的 delta 基线（稳定 key → 摘要与 ref、`nextRef`、页面脚本 epoch、version）。
- 子 frame（`frame` 非 0）：只读；`nodes` 每项 `ref` 为 `null`，不读不写 `tab.refs`；文本行不带 `[N]` 前缀；只写该 frame 的 delta 基线。
- `summary` 保持 `快照 <count> 个可见元素`，截断时追加「共 `<total>` 个，已截断到 4000 个」。
- `total` 是本次已扫描到的可见节点数：`scanTruncated` 为真时它等于扫描上限 20000，而不是页面真实总数；full 的 `truncated` 仍按 `total > 4000` 判定。

**delta**：

- 返回 `{ mode: 'delta', baseline, version, added, changed, removed, addedCount, changedCount, removedCount, unchangedCount, total, truncated, nodes?, text, summary }`。
- `baseline` 取 `'ok' | 'missing' | 'reset'`：
  - `'missing'`：该 frame 从未建立基线（第一次快照）；
  - `'reset'`：有基线但已失效（主文档新文档请求、子 frame 导航、页面脚本注册表 epoch 变化）；
  - 两者都退化为全量：额外返回 `nodes`（形状同 full），按 full 规则重建该 frame 的 ref 与基线；`text` 首行说明「无增量基线（首次快照或页面已更换），已返回全量」。
- `baseline: 'ok'` 时：
  - `added` 为新增节点，`changed` 为仍存在但摘要变化的节点，两者都带 `ref`；`changed` 每项另带 `changedFields`（差异字段名数组，取值 `tag` / `id` / `classes` / `role` / `name` / `text`）。
  - `removed` 每项为 `{ ref, tag, name, xpath }`，`ref` 为被移除元素在基线中的 ref；子 frame 无 ref 时为 `null`。
  - 判据：按页面脚本分配的稳定 key 识别同一元素，摘要只比较 `tag` / `id` / `classes` / `role` / `name` / `text`；不比较 `box` 与 `depth`（滚动、布局移动不产生变化），不比较 `xpath`（兄弟增删造成的路径漂移不产生变化）。元素被替换表现为旧 key 消失（`removed`）加新 key 出现（`added`），或被同一 key 的摘要变化捕获（`changed`）。
  - 主文档：delta **不清空** `tab.refs`，按 key 增量并入——仍在的元素沿用基线 ref，新增元素分配 `@<nextRef>` 并递增，被移除元素的 ref 从表中删除。旧 ref 对仍存在的元素继续有效；全量快照仍会重置编号并让旧 ref 全部失效（既有行为）。
- `truncated` 为真当且仅当以下任一成立：本次返回的变化节点数被 4000 条上限裁掉；对比范围被前 4000 条可见节点裁掉；`scanTruncated` 为真。文本末尾给出对应说明。
- `text` 首行 `增量 v<version>（标签页 <tabId>，frame <index>）`；随后按「新增 N 个」「变化 M 个」「移除 K 个」分段；三者都为空时输出一行「（无可见变化）」。文本字符上限 20000，超出时截断并追加提示。
- `summary`：`增量：新增 <addedCount> / 变化 <changedCount> / 移除 <removedCount>（标签页 <tabId>）`。

**query**：

- 返回 `{ mode: 'query', count, totalMatched, matches, truncated, text, summary }`。
- `matches` 每项 `{ ref, tag, id, classes, role, name, text, box, xpath, selector, hidden? }`：
  - `selector` 为可直接传给 `browser_e2e_click` / `browser_e2e_fill` 的 `selector` 参数的 CSS 选择器（id 优先，否则从 `body` 起的 `tag:nth-of-type(n)` 链）；
  - `ref` 为该元素在当前 `tab.refs` 中的 ref；不在表中（4000 条以外、未全量快照过、或子 frame）时为 `null`；
  - `frame` 非 0 时，`selector` 是在该子 frame 内生成的路径，主文档的 `click` / `fill` 不能直接使用（P1-9 前只用于展示与后续扩展）；
  - `hidden` 只在 `includeHidden: true` 且元素不可见时为 `true`。
- 匹配规则：`selector` 直接 `querySelectorAll`；`text` / `role` 遍历元素（`scanLimit` 上限）；可见元素优先、文档顺序其次；嵌套命中只保留最内层语义元素（可聚焦 / 可编辑 / 带 `role` / 带 `tabindex` / 带 `href`），容器祖先与文本后代丢弃；去重后最多取 `limit` 条，`totalMatched` 为去重后总命中数。
- `query` 不修改 `tab.refs`，也不修改 delta 基线。
- 未命中返回 `count: 0` 与说明性文本，不抛错。
- `truncated` 为 `totalMatched > count`。
- `summary`：`查询命中 <count> 个元素`。

### 状态变化

- 会话：不新增会话字段，不改变 `state`。
- 标签页：条目内部新增 `snapshotBaselines`（按 frame 分桶：epoch、key → 摘要与 ref、`nextRef`、version）。`refs` 只在主文档的 full / delta 更新；子 frame 快照不读写 `refs`。主文档新文档请求（与事件环同一判据）把 `snapshotBaselines` 标记失效（丢弃 key / ref，保留 `baseline: 'reset'` 的判定依据）；子 frame 导航把该 frame 的基线标记失效；SPA 路由与 hash 变化不产生新文档请求，基线保留。每个 tab 各自独立，互不影响。
- 面板：工具仍以返回文本首行作为 `summary` 进入面板 `action` 事件；不改面板协议与客户端。
- 浏览器进程：无变化。

## 边界

- frame 定位：
  - `frame` 不是 `0` 或正整数：报「frame 必须是 0 或正整数（0 为主文档）」。
  - 索引越界：报错并列出可用 frame 的索引、name 与 url。
  - 字符串未命中：报错并列出可用索引。
  - 字符串多命中：报错并列出候选索引 / name / url，要求改用索引。
  - 跨源 frame：报错，说明 P0-3 只读取同源 iframe，跨源 iframe 的定位与操作待 P1-9。
  - `frame.url()` 为空、`about:blank`、`about:srcdoc` 视为同源。
  - frame 已 detach 或读取失败：报「已不可用（已导航或卸载）」或带原始原因的读取失败。
- delta：
  - 同一 tab 的 delta 调用应串行（上一次返回后再发下一次）；并发两次 delta 不保证两次都看到变化（后到者基于先到者更新后的基线），不新增锁。
  - 页面每帧改文本 / class 会产生持续变化，属预期；仅位置移动不报变化，但节点返回的 `box` 始终是本次实测值。
  - 页面脚本注册表被页面重置（epoch 变化）→ `baseline: 'reset'` 并退化为全量，不报错。
  - 4000 条以外的节点不参与对比，也不进基线。
  - 子 frame 的 delta 与 query 都不分配 ref；delta 的 `removed.xpath` 与 query 的 `selector` 都是子 frame 内路径，P1-9 前不能用于主文档操作；子 frame 内元素操作等 P1-9。
- query：
  - 非法 CSS selector 报「不是合法 CSS 选择器」，不抛页面异常。
  - `includeHidden` 只影响可见性过滤，不影响 ref 解析。
  - 连续两次 query 互不影响；query 不建立基线。
- 超时与上限：
  - 页面脚本整体执行 15s 超时（宿主侧 `Promise.race`），超时报「快照执行超时（15000ms）」；页面脚本无法被终止，可能继续占用页面线程（已知限制）。
  - 扫描上限 20000 个元素，超出时 `scanTruncated: true` 并在文本提示。
  - delta 与 query 的文本各 20000 字符上限；delta 的 `removed` 列表最多列出 200 个 ref，超出以「等 N 个」汇总。
- 不做的场景：
  - 不为 `click` / `fill` / `press` / `scroll` 增加 `frame` 参数（留给 P1-9）。
  - 不读取跨源 iframe（留给 P1-9）。
  - 不做 `region` 参数、不做可访问性语义树、不做变化自动推送（MutationObserver 订阅）、不做基线持久化或跨会话复用。
  - 不改 4000 条上限数值，不改面板渲染，不改协议表。

## 验收

1. `node tests/snapshot.mjs` 退出码 0 且无 FAIL。该文件由 tester 新建，用例名由本规格固定：
   - delta 组：`delta 无变化返回三零与提示`、`delta 新增节点带新 ref`、`新增 ref 可点击`、`delta 删除节点列出旧 ref`、`被移除的 ref 再点击报不存在`、`delta 文本变化带 changedFields`、`delta 仅位置移动不报变化`、`delta 滚动不报变化`、`首帧 delta 退化为全量（baseline=missing）`、`新文档后 delta 退化为全量（baseline=reset）`、`SPA 路由后 delta 基线保留`、`delta 只对比前 4000 个节点并标 truncated`、`delta 与 query 同用报互斥`。
   - query 组：`query selector 命中且 selector 可点击`、`query text 命中`、`query role 命中`、`query limit 边界`、`query limit 越界报错`、`query text 与 selector 互斥报错`、`query 三者都不给报错`、`query 非法 selector 报错`、`query 未命中不抛错`、`query includeHidden 生效`、`query 不改变 ref 表`。
   - frame 组：`frame 索引 0 等价主文档`、`frame 索引 1 读到同源 iframe`、`frame 按 name 定位`、`frame 按 url 子串定位`、`frame 越界报错`、`frame 未命中报错`、`frame 多命中报错`、`frame 跨源报错`、`子 frame 快照不污染主文档 ref`、`frame + delta 报子 frame 变化`、`frame + query 返回 ref=null`。
   - 其他：`t1 与 t2 的 delta 基线互不影响`、`未知 tab 报既有文案`、`缺省快照仍为全量且 truncated=false`。
2. `node tests/tools.mjs` 退出码 0 且无 FAIL：用例 4、4B、9 的既有断言不回退（全量快照形状、`label[for]` 转义、4000 截断与截断后 ref 点击）。
3. `node tests/multitab.mjs` 退出码 0 且无 FAIL：用例 3 的 `t1 快照拿到 A 按钮 ref`、`t1 的 ref 在 t2 上失效`、`t2 快照是 B 按钮`；用例 4 的 `缺省快照作用于 active（t2）`、`active 切换后缺省快照跟到 t1`；用例 6 的 `snapshot 未知 tab 报错`；用例 7 的 `恢复后可 snapshot`。
4. `npm run test:unit` 退出码 0（本功能不动 `lib/protocol.js`、`client/index.js`、`lib/invariants.js`）。
5. `npm run test:integration` 退出码 0（串行真起无头 Edge；进程类断言以回落到运行前基线为准）。
