# 断言工具

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/page.js` 职责；进程内对象契约「其他跨模块字段 · `browser_e2e_assert`」；P3 分类「单次」与「运行时」）；specs/项目规格/0002-panel-protocol-v1.md（`action` 事件，不改协议）；specs/功能规格/0004-snapshot-and-ref-table.md（`visibleEnough` 的可见性口径）；specs/功能规格/0013-wait-url-and-response.md（等待条件与 URL 匹配语义，「超时抛错」的既有口径）；specs/功能规格/0019-evaluate-timeout.md（页面内脚本求值的超时边界）；README.md「工具一览」
代码: lib/page.js / lib/tools.js / tests/assert.mjs

## 需求

端到端验证的结论应当结构化：一次调用给出「通过 / 未通过 + 每条断言的期望与实际证据」。当前只能 `browser_e2e_evaluate` 自己写表达式再读返回值，或 `browser_e2e_wait` 等到超时抛错；模型容易把「返回了字符串」当成通过，也拿不到逐条证据。本功能新增 `browser_e2e_assert`：对当前页一次性判定 1-20 条断言（selector / text / url / expression），逐条返回 `pass` 与实测值；未通过不抛错，由返回值的 `pass` 字段表达结论。

## 行为

### 输入

工具 `browser_e2e_assert`：

| 参数 | 类型 | 约束 |
|---|---|---|
| `checks` | array | 必填；1-20 条；每项是对象 |
| `tab_id` | string | 可选，缺省 active tab；一次调用的全部断言作用于同一个标签页 |

每条断言的字段：

| 字段 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `selector` | string | 非空；与其余三个条件互斥 | CSS 选择器，按 `state` 判定命中元素的可见状态 |
| `text` | string | 非空；互斥 | `document.body.innerText` 必须包含该子串（区分大小写） |
| `url` | string | 非空；互斥 | 主框架完整地址按 `urlMatch` 匹配 |
| `expression` | string | 非空；互斥 | 页面内同步 JS 表达式，真值即通过；不等待 Promise |
| `state` | string | 仅 `selector`；`attached` / `visible` / `hidden` / `detached`，缺省 `visible` | 期望的命中状态 |
| `urlMatch` | string | 仅 `url`；`includes` / `glob` / `regex`，缺省 `includes` | 与 `browser_e2e_wait` 同一套 URL 匹配语义 |

`state` 的判据（`count` 为命中元素数，`visibleCount` 为其中可见的个数）：

| state | 通过条件 |
|---|---|
| `attached` | `count > 0` |
| `visible`（缺省） | `visibleCount > 0` |
| `hidden` | `visibleCount === 0` |
| `detached` | `count === 0` |

可见性口径与 `snapshotScript` 的 `visibleEnough` 一致：`getBoundingClientRect()` 宽高均大于 0，且 `checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })` 为真；该 API 抛错时回退「`display !== 'none'` 且 `visibility` 不是 `hidden` / `collapse`」。不做遮挡检测，不算 `opacity: 0`。

参数校验在发起任何页面调用之前完成；任一项不合法直接抛错，不返回部分结果：

| 情形 | 错误文案 |
|---|---|
| `checks` 不是数组 | `checks 必须是数组（1-20 条断言），收到 <type>` |
| 条数为 0 或大于 20 | `checks 必须是 1-20 条，收到 <n> 条` |
| 某条不是对象 | `第 <i> 条断言必须是对象` |
| 某条的四个条件给了 0 个或 ≥2 个（空串按未给处理） | `第 <i> 条断言必须且只能给 selector / text / url / expression 之一，当前收到：<names 或 无>` |
| `state` 用于非 `selector` 条目 | `第 <i> 条断言的 state 只对 selector 有效（当前是 <kind> 条件）` |
| `state` 不在枚举 | `第 <i> 条断言的 state "<v>" 不支持，可选 attached / visible / hidden / detached` |
| `urlMatch` 用于非 `url` 条目 | `第 <i> 条断言的 urlMatch 只对 url 有效（当前是 <kind> 条件）` |
| `urlMatch` 不在枚举 | `第 <i> 条断言的 urlMatch "<v>" 不支持，可选 includes / glob / regex` |
| `urlMatch=regex` 编译失败 | `第 <i> 条断言：` + 既有 `urlMatcherOf` 的错误原文 |
| `expression` 语法非法 | `第 <i> 条断言的 expression 语法无效：<message>；只能是表达式，不能含语句或顶层 await` |
| `selector` 语法非法（浏览器解析失败） | `第 <i> 条断言的 selector 无效（<selector>）：<浏览器原文>；请修正 CSS 选择器` |

`i` 为 1 起的条目序号。`selector` 语法非法属于入参错误，抛错，**不**记为断言未通过。

### 判定与证据

逐条按 `checks` 数组顺序执行，**不短路**：一条未通过不影响后续条目执行与返回。每条的 `actual` 是实测证据（字符串）：

- `selector`：未命中为 `未命中任何元素`；命中为 `命中 <count> 个（可见 <visibleCount> 个）；首个：<描述>`，描述形如 `div#ok.btn "提交成功"`（标签小写，`#id` 与 `.class` 只在有值时出现，文本取 `textContent` 空白折叠后前 40 字并加引号，为空则省略该段）。命中数超过 200 时可见数只统计前 200 个，文案改为 `…（可见 <visibleCount> 个，只统计前 200 个）`。
- `text`：命中为 `命中（第 <offset> 个字符起，上下文 "<前后各 20 字>"）`；未命中为 `未找到；页面可见文本 <n> 字，开头 "<前 120 字>"`（空白折叠）。
- `url`：`实际地址 <page.url()>`。
- `expression`：真值为 `真值（返回 <预览>）`，假值为 `假值（返回 <预览>）`，求值抛错为 `求值抛错：<message>`（该条 `pass: false`，其余条目继续）。预览取 `JSON.stringify(返回值)` 截 200 字，结果为 `undefined` 时改用 `String(返回值)`。

返回形状：

```
{
  pass: boolean,          // 全部条目通过才为 true
  total, passed, failed,  // 整数
  tabId, url,             // 目标标签页 id 与全部条目执行完后的 page.url()
  elapsedMs,              // 整次调用耗时（毫秒）
  checks: [{ index, kind, expected, pass, actual, state?, urlMatch? }],
  summary
}
```

- `kind` 取 `selector` / `text` / `url` / `expression`；`index` 从 1 起；`expected` 为该条的匹配模式或表达式原文。
- `state` 只在 `selector` 条目出现，`urlMatch` 只在 `url` 条目出现；其余条目不带这两个字段。
- `summary` 单行：全通过为 `断言通过：<total>/<total> 条（标签页 <tabId>，耗时 <n>ms）`；有未通过为 `断言失败：<passed>/<total> 条通过（未通过第 <i、j> 条；标签页 <tabId>，耗时 <n>ms）`，未通过超过 5 条时只列前 5 条并追加 `等`。

工具层渲染：首行 `summary`；其后每条一行 `PASS [<index>] <kind>: "<expected>" → <actual>` 或 `FAIL [<index>] <kind>: "<expected>" → <actual>`；有未通过时文末追加一行 `未通过的断言不抛错；需要等待条件满足时先用 browser_e2e_wait。`

### 失败形态

- 任一条未通过：工具调用成功，返回 `pass: false` 与全部条目的证据；面板 `action` 事件的 `summary` 即该次返回的 `summary`（失败摘要同样上报）。
- 以下情形抛错，不返回部分结果：入参非法；浏览器未启动或没有可用标签页（`浏览器尚未启动或没有可用标签页，请先 browser_e2e_start`）；`tab_id` 不存在（`tab <id> 不存在，请先 browser_e2e_tabs 获取最新 tab_id`）；执行期间页面关闭（`断言期间标签页已关闭（<tabId>），请重新 browser_e2e_tabs 获取可用标签页`）。
- `selector` / `text` 检查的页内脚本执行失败（页面关闭、执行上下文被导航销毁等）按运行时错误抛错，文案为 `断言的 <kind> 检查执行失败（<expected>）：<message>`，不记为该条未通过；`expression` 的页面求值错误按该条未通过处理（`求值抛错：…`），但页面已关闭时仍抛上面的关闭错误。
- 不提供 `timeoutMs`、不重试：每条断言都是一次即时判定。

### 状态变化

- 会话：不新增字段、不改变 `state`；经 `sessionOf` 入口刷新空闲计时（与 `evaluate` / `waitFor` 一致），不额外调用 `session.touch()`。
- 标签页：只读 DOM、`innerText` 与 `page.url()`；不写 `refs`、不写 `snapshotBaselines`、不清 `consoleRing` / `networkRing`、不改 `activeTabId`。
- 面板：成功与失败各广播一条既有 `action` 事件；不改 `lib/protocol.js`、`lib/panel.js`、`client/index.js` 与构建产物 `lib/client.js`（无需 rebuild-client）。
- 浏览器进程：无变化。isolated 与 cdp 两种模式行为一致（断言只读当前页，与载体无关）。

## 边界

- 与 `browser_e2e_wait` 的分工：assert 只判定「此刻」，不等待；需要「直到满足」用 wait。wait 超时仍抛运行时错误、不返回结构化结论（`0013-wait-url-and-response.md`「超时口径」），两者是不同工具的不同口径，不是同一能力的两种返回风格。
- `expression` 按同步表达式求值：返回 Promise 视为真值，不 await；需要等异步结果用 `browser_e2e_evaluate` 或 `browser_e2e_wait`。含语句（如 `a; b`）或顶层 `await` 的写法在入参校验阶段被拒。
- `expression` 检查不复用 `browser_e2e_evaluate`（需要在页内先算真值、只回小对象），因此 `0019-evaluate-timeout.md` 给 evaluate 的超时上限不作用于本工具：页面内死循环会挂住整次调用，直到页面关闭或空闲回收（`DSH_BROWSER_IDLE_MS`）介入。可能长时间运行的判定请改用 `browser_e2e_evaluate`（0019 落定后带默认 30000ms 上限）。
- `text` 匹配 `document.body.innerText`：只含渲染后的可见文本，`display: none` 与未挂载内容不匹配；区分大小写（与 `snapshot` 的 `query.text` 大小写不敏感不同）。不承诺覆盖 shadow root 内部文本。
- `selector` 用 `document.querySelectorAll`，不穿透 shadow DOM；只作用于主文档，不含 iframe 子文档；跨源与同源子 frame 的断言待 P1-9（`0018-iframe-operations.md`）。
- `url` 只看主框架地址（含 hash；`pushState` / `replaceState` 会更新该值），匹配语义与 `0013-wait-url-and-response.md` 的 `url` 条件一致并复用同一实现：`includes` 子串、`glob` 整串（`*` 非 `/`、`**` 任意、`?` 单个非 `/`）、`regex` 子串语义。
- 断言之间不隔离：同一调用里前一条 `expression` 对 DOM 的修改会影响后一条；不回滚。并发调用不加锁，同一页面并发 assert 各自独立、不共享结果。
- 不做：网络 / 控制台 / 存储 / 无障碍树的断言（分别用 `browser_e2e_network`、`browser_e2e_console`、`browser_e2e_evaluate`）；不做重试轮询；不做跨 tab 批量断言（一次一个 `tab_id`）；不返回全部命中元素（只给计数与首个证据）；不生成截图证据；不做自动重试或失败重跑。
- 权限门控尚未实现（P1-14 待决策）：本工具只读，不引入白名单 / 豁免概念。

## 验收

1. `node tests/assert.mjs` 退出码 0 且无 FAIL（该文件由 tester 新建，下列用例名由本规格固定）：
   - 通过组：`assert 三条断言全通过返回 pass=true`、`assert selector attached 对隐藏元素通过`、`assert selector 缺省 visible 对隐藏元素不通过`、`assert selector hidden 与 detached 语义`、`assert text 命中并给出偏移`、`assert url includes 匹配`、`assert url glob 匹配`、`assert url regex 匹配`、`assert expression 真值`。
   - 失败与证据组：`assert 一条不通过时其余条目仍执行`、`assert text 未命中给出页面文本开头`、`assert text 区分大小写且不匹配隐藏文本`、`assert expression 假值`、`assert expression 抛错只让该条失败`、`assert selector 未命中证据为未命中任何元素`、`assert checks 每项含 index / kind / expected / pass / actual`。
   - 渲染与摘要组：`assert summary 全通过文案`、`assert summary 未通过时列出条目号`、`assert render 每条一行 PASS 或 FAIL`、`assert summary 被 summaryOf 采用`。
   - 校验组：`assert checks 非数组报错`、`assert checks 为空数组或超过 20 条报错`、`assert 单条给两个条件报错`、`assert 单条一个条件都不给报错`、`assert 空串按未给处理`、`assert state 用于非 selector 条目报错`、`assert state 非法值报错`、`assert urlMatch 用于非 url 条目报错`、`assert urlMatch 非法值报错`、`assert url regex 非法报错带条目号`、`assert expression 语法非法在入参阶段报错`、`assert selector 语法非法抛错而不是判失败`。
   - 目标与状态组：`assert 按 tab_id 只作用于指定标签页`、`assert 未启动时报浏览器未启动`、`assert 不写 ref 表与快照基线`。
2. `node tests/tools.mjs` 退出码 0 且无 FAIL：`注册的工具与工具表逐项一致`、`工具名唯一且统一带 browser_e2e_ 前缀` 不回退（工具表新增一项，断言从表派生，不需改写法）。
3. `node tests/panel.mjs` 退出码 0：`作用于页面的工具都接受 tab_id` 的检查列表纳入 `assert` 后通过；`工具名唯一且统一带 browser_e2e_ 前缀` 与参数契约用例不回退。
4. `npm run test:unit` 退出码 0。
5. `npm run test:integration` 退出码 0（串行真起无头 Edge；进程类断言以回落到运行前基线为准）；`node tests/assert.mjs` 是否登记进该聚合脚本由 Lead 决定，未登记时以第 1 条单跑为准。
