# 结构化读取

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表新增 `lib/read.js`、依赖方向图、进程内对象契约「能力函数返回值被 `tools.js` 各工具 `run` 读的字段」、验收的改动面清单）；specs/项目规格/0002-panel-protocol-v1.md（`action` 事件取返回值首行，本项不改协议）；specs/功能规格/0004-snapshot-and-ref-table.md（可见性判据、ref 表生命周期，本项不读不写 `tab.refs`）；specs/功能规格/0007-click-fill-targets.md（selector 目标的分支语义，本项产出的 selector 直接走该分支）；specs/功能规格/0012-snapshot-delta-query-frame.md（快照的过滤 / 增量，与本项的划界见「边界」）
代码: lib/read.js / lib/tools.js / tests/read.mjs

## 需求

`browser_e2e_snapshot` 已经把整页可见元素压成 `{ tag, id, classes, role, name, text, box, depth, xpath }` 的扁平节点表并分配 ref，但它不携带结构化数据：节点里没有 `href`，表格没有表头与行列矩阵，控件没有 `value` / `checked` / `disabled` / `options`，也没有可直接用于后续操作的唯一 CSS selector。只想回答「页面上有哪些链接、各自指向哪里」「这张表有哪些行」「这个表单有哪些字段、提交按钮是否禁用」时，只能每次自己写 `browser_e2e_evaluate` 脚本：没有固定返回形状、没有输出大小上限、没有唯一 selector 的生成与校验。本规格固定一个只读工具 `browser_e2e_read`，按 `controls` / `links` / `tables` / `forms` 四节返回结构化记录，每条记录带一个经页内校验的 CSS selector，可直接传给 `browser_e2e_click` / `browser_e2e_fill`。

## 行为

### 工具与参数

- 工具名 `browser_e2e_read`，定义在 `lib/tools.js` 的 `buildToolTable`；能力实现在 `lib/read.js` 的导出 `readStructured(session, options, tabId)`。
- 新增工具而不是扩展 `browser_e2e_snapshot`：快照的契约是「全 DOM 节点 + ref 表」，`0012` 已把 delta / query / frame 三种模式挂在同一工具上；本项不改 ref、不写 delta 基线，输出与失败语义（表格行列、href、控件状态）都与快照不同，挂进快照会让一个工具承担两种契约。竞品的 `observe.read` 也与索引 / 定位工具分开。
- 参数（全部可选，无互斥关系）：

| 参数 | 类型 | 缺省 | 约束 |
|---|---|---|---|
| `sections` | string[] | `['controls', 'links', 'tables']` | 取值 `controls` / `links` / `tables` / `forms`；重复值去重；空数组报错；未知值报错。输出顺序固定为 controls → links → tables → forms，与书写顺序无关 |
| `maxItems` | integer | `50` | 1–100；每节最多列出的条目数，表格还用它限制每张表列出的行数 |
| `includeValues` | boolean | `false` | `true` 时返回控件当前值（`password` / `file` 控件除外） |
| `selector` | string | 无 | CSS 选择器；作为作用域根，只在它及其后代里查找，必须是合法选择器且至少命中一个元素。空串按「未给」处理（与 `0007` 的 ref / selector 约定一致） |
| `tab_id` | string | active tab | 由 `currentTab` 解析 |

- 参数校验在 `readStructured` 入口（单次入参，不进 `lib/invariants.js`），文案见「边界」。

### 页内扫描（`lib/read.js` 的私有 `readScript`）

- 入口：`page.evaluate(readScript, { sections, maxItems, includeValues, selector })`。
- 遍历范围：主文档。默认根是 `document.body`（没有 body 时 `document.documentElement`）；给 `selector` 时根是 `document.querySelector(selector)`。遍历集合是「根自身 + `root.querySelectorAll('*')`」，文档顺序；不进入 shadow root，不进入任何 iframe（同源也不进）。
- 扫描上限 `READ_SCAN_LIMIT = 20000` 个元素：到上限即停止遍历，返回 `scanTruncated: true`，计数随之不完整。
- 可见性判据与 `0004` 的 `snapshotScript` 内 `visibleEnough` 相同：`getBoundingClientRect()` 宽或高不大于 0 直接排除；`checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })` 可用时用它的结果；该 API 抛错时回退 `getComputedStyle` 的 `display !== 'none'` 且 `visibility` 不是 `hidden` / `collapse`。不可见元素不列出（含 `input[type=hidden]`、折叠菜单、`display:none` 的模态框）。
- 分类（文档顺序处理，一个元素至多归入一节）：
  - `controls`：`input` / `select` / `textarea` / `button`；`contenteditable` 为真；显式 `role` 属于 `button, checkbox, radio, switch, combobox, textbox, searchbox, slider, spinbutton, menuitem, menuitemcheckbox, menuitemradio, tab, option`。
  - `links`：`a[href]` / `area[href]`。
  - `tables`：`table`，或显式 `role` 属于 `table, grid, treegrid`。
  - `forms`：`form` 元素。表单不吞掉内部控件：控件同时出现在 `controls` 与所属表单的 `fieldCount` 里。
- 计数与截断：每节先全部计数（`counts`），只给前 `maxItems` 个建记录；`omitted` 为「命中数 − 实际列出数」（含后续文本预算丢弃的条目）。

### 唯一 selector

- 每条记录带 `selector`（绝对 CSS 选择器，相对整个 document 生成，与作用域无关，因此可直接交给 `browser_e2e_click` / `browser_e2e_fill` 的 `selector` 参数）与 `unique`（布尔）。
- 候选按顺序生成，每个候选立即用 `document.querySelectorAll(候选).length === 1` 校验，第一个唯一者胜出：
  1. `#<id>`（id 经 `CSS.escape`）；
  2. `<tag>[data-testid="<v>"]`；
  3. 表单控件 `<tag>[name="<v>"]`（`input` 追加 `[type="<t>"]`；`radio` / `checkbox` 再追加 `[value="<v>"]`）；
  4. 链接 `a[href="<原始 href 属性值>"]`（属性值转义；`href` 为空时跳过）；
  5. 从 `html` 起的 `tag:nth-of-type(n)` 链（`n` 为该元素在同类标签兄弟中的序号，从 1 起）。
- 都不唯一时返回第 5 项并置 `unique: false`、`matches: <命中数>`。`unique: false` 的 selector 不能直接用于 `click` / `fill`（Playwright strict 模式会因多元素报错），工具描述里写清这一点。
- 选择器串超过 500 字符时省略 `selector` 字段并置 `unique: false`（不返回被截断的半截选择器）。

### 记录字段

布尔状态字段一律「只在为真时出现」，省略即「否」。字符串长度上限在括号内；超长按字符截断并追加 `…`。

- 控件：
  - `role`：显式 `role` 优先，否则隐式角色（`input` 按 `type` 映射：`checkbox` → `checkbox`、`radio` → `radio`、`submit` / `reset` / `button` / `image` → `button`、`range` → `slider`、`number` → `spinbutton`、`search` → `searchbox`、其余 → `textbox`；`select` 单值 `combobox`、多值 `listbox`；`textarea` `textbox`；`button` `button`；`contenteditable` 为空串）。
  - `name`（200）：`aria-labelledby` 指向元素文本 → `aria-label` → `label[for]` / 祖先 `label` 文本 → `placeholder` → 按钮 / 链接 / 选项自身文本 → `title` → `alt`。
  - `type`：`input` 的 `type`；`select-one` / `select-multiple`；`textarea`；`button`；`contenteditable`。ARIA 控件没有 `type`。
  - `hasValue`：`input`（`checkbox` / `radio` / `button` / `submit` / `reset` / `image` 除外；`file` 的 `hasValue` 表示已选文件数大于 0）、`textarea`、`select`、`contenteditable` 上给出布尔。
  - `value`（500）：仅 `includeValues: true` 且控件不是 `password` / `file` 时出现；`select` 单选取选中项 `value`，多选取数组。
  - `checked`：`input[type=checkbox|radio]` 的 `checked`，或 `aria-checked`；只在为 `true` 或 `'mixed'` 时出现。
  - `disabled` / `readonly` / `required`：原生属性或 `aria-disabled` / `aria-readonly` / `aria-required` 为真时出现。
  - `options` / `optionsTotal`：`select` 的 `[{ value, label, selected? }]`，最多 `READ_OPTIONS_LIMIT = 100` 条；超出时给 `optionsTotal`（选项总数）。
  - `form`：所属表单的 selector（`el.form` 或最近的 `form` 祖先；不在表单里省略）。
  - `selector` / `unique` / `matches?`：见「唯一 selector」。
- 链接：`{ text（200）, href（500，绝对地址）, target（仅 `_blank` 时）, hrefTruncated?, selector, unique }`。
- 表格：`{ name?（caption 或 aria-label，200）, headers: string[], rows: string[][], totalRows, omittedRows?, selector, unique }`。
  - `headers`：最后一个 `thead` 行的单元格文本；没有 `thead` 且首行单元格全部是 `th` 时取首行；否则空数组。
  - `rows`：表体行，每行是单元格文本数组（每格 `READ_CELL_LIMIT = 120`，空白折叠）；`colspan` / `rowspan` 不展开。
  - `totalRows`：DOM 中表体行数；`omittedRows = totalRows - rows.length`，大于 0 时出现。
  - ARIA 表格：行取 `[role=row]`，表头取首行的 `[role=columnheader]`，单元格取 `[role=columnheader|rowheader|cell|gridcell]`。
- 表单：`{ id?, name?, action（500，绝对地址）, method（小写，缺省 get）, fieldCount, selector, unique }`；`fieldCount` 是该表单子树里被归为 controls 的元素数（截断前）。

### 返回与文本

- 能力函数返回 `{ tabId, url, mode: 'read', sections, counts, omitted, controls?, links?, tables?, forms?, text, summary, truncated, scanTruncated }`；只带请求的节，未请求的节字段不出现。
- `counts` / `omitted` 是 `{ controls?, links?, tables?, forms? }`，同样只带请求的节。
- `truncated` 为真当且仅当下列任一成立：`omitted` 中任一项大于 0；任一表格的 `omittedRows` 大于 0；文本预算丢弃过条目。
- `summary`：`结构化读取` + 请求节的 `<节名> <n>` 以 ` / ` 连接；有截断时追加 `（已截断）`。例：`结构化读取 控件 2 / 链接 3 / 表格 1`。
- 工具层输出：`${summary}\n当前页面：${url}（标签页 ${tabId}）\n\n${text}`。
- `text` 每节两行：标题 `<节名> <列出数> 个（共 <命中数> 个，已截断）`（未截断时省略括号），下一行是该节记录数组的紧凑 JSON（`JSON.stringify`，无缩进）。节名依次为 `控件` / `链接` / `表格` / `表单`。
- 文本预算 `READ_TEXT_LIMIT = 16000` 字符，只约束 `text`（各节标题行 + JSON），不约束工具层追加的摘要与「当前页面」行，也不约束末尾提示行：每节份额为 `floor(16000 / 请求节数)`，标题行计入该节份额。某节超过份额时，从该节数组末尾整条丢弃；表格先丢该表 `rows` 末尾的行并累加 `omittedRows`，行丢完再丢整张表。被丢弃的条数计入 `omitted`，并在文末追加一行 `（文本已按 16000 字符上限截断；要读更多请只请求一节，或用 selector 缩小范围）`。
- `scanTruncated` 为真时文末追加一行 `（已扫描 20000 个元素后停止，结果可能不完整；请用 selector 缩小范围）`。
- 命中为 0 的节仍输出两行（如 `链接 0 个` 与 `[]`），不报错。
- 面板：`lib/index.js` 的注册包装用 `summaryOf` 取返回值首行广播 `action` 事件，与其它工具一致。

### 状态变化

- 会话：不新增字段，不改变 `state`。
- 标签页：不写 `tab.refs`（不分配 ref、不清空 ref 表），不写快照 delta 基线，不改 `activeTabId`、不改 `loading`。
- 面板与协议：不改 `lib/protocol.js`、`lib/panel.js`、`client/index.js`。
- 浏览器进程：无变化。

### 模式、超时与取消

- isolated 与 cdp 行为一致：同一条 `page.evaluate` 链路，只按元素自身尺寸判可见，不依赖固定视口，没有按模式分支的逻辑。
- 不新增超时与取消：与 `snapshot` 现状一致（`page.evaluate` 无超时、不接 `AbortSignal`）；宿主侧超时终止由路线图 P1-10（evaluate 超时终止）统一覆盖。耗时由 `READ_SCAN_LIMIT` 与 `maxItems` 限住。

## 边界

- 只读主文档：不进入任何 iframe（同源也不进）。页面主体在 iframe 里时本工具只返回主文档结果。iframe 内的结构化读取与操作待路线图 P1-9（iframe 内元素操作）；`0012` 的 `frame` 参数只作用于 `browser_e2e_snapshot`，不适用于本工具。
- 不进入 shadow root：`document.body.querySelectorAll('*')` 不穿透，open shadow root 内的控件 / 链接 / 表格读不到；closed shadow root 本来就读不到。
- 与 `0012`（P0-3）的划界：`snapshot` 的 `query` 模式返回的是扁平节点记录（`tag` / `role` / `name` / `text` / `box` / `xpath` / `selector`），没有 `href`、没有表格行列矩阵、没有控件 `value` / `checked` / `options` / 表单归属；`delta` 是快照差异；`frame` 是定位范围。三者都不产出本规格的四节记录。本工具不写 ref、不建基线，可与快照在同一页面交替调用，互不影响。
- 与 `browser_e2e_evaluate` 的分工：evaluate 能用自写脚本拿到同样的数据，本工具的价值是固定记录形状、页内校验过的唯一 selector、输出预算与稳定的省略语义，不是「只有本工具能读」。因此 `content` / `markdown` / `plain text` 正文提取不在本项范围（`document.body.innerText` 一行 evaluate 可得）。
- 同名 radio 逐条列出，不合并成 radiogroup 记录；不返回 `constraints`（`min` / `max` / `pattern` / `validity` 等约束与表单校验状态）。
- 表格不识别分页与虚拟滚动：不在 DOM 里的行拿不到，`totalRows` 只是 DOM 行数；不做 `coverage` / `reason` 标注（竞品的分页 / 虚拟化提示不在本项）。
- `input[type=file]` 只给 `hasValue`，不返回已选文件名（上传能力见 `0010`）。
- 链接 `href` 超过 500 字符时截断并置 `hrefTruncated: true`，截断后的值不可用于导航；`data:` 长地址同样按此截断。
- 参数错误文案：
  - `sections` 不是数组：`sections 需要 controls / links / tables / forms 的数组，收到 <JSON>`
  - `sections` 是空数组：`sections 至少要给一个：controls / links / tables / forms`
  - 未知节：`未知 section "<值>"；可选 controls / links / tables / forms`
  - `maxItems` 非 1–100 的整数：`maxItems 必须是 1..100 的整数，收到 <JSON>`
  - `selector` 不是字符串：`selector 需要字符串，收到 <JSON>`
  - `selector` 不是合法 CSS 选择器：`selector "<值>" 不是合法 CSS 选择器：<浏览器原始信息>；请先用 browser_e2e_snapshot 确认页面结构`
  - `selector` 没有匹配元素：`selector "<值>" 没有匹配元素；请先用 browser_e2e_snapshot 确认页面结构，或去掉 selector 读整页`
- `tab_id` 不存在：沿用 `assertTabExists` 的 `tab <id> 不存在，请先 browser_e2e_tabs 获取最新 tab_id`；未启动或 0 页：沿用 `assertCurrentTabAvailable` 的 `浏览器尚未启动或没有可用标签页，请先 browser_e2e_start`。
- 并发：只读，同一 tab 上并发调用不互斥，各自基于调用时的页面状态出结果；不做跨调用缓存。
- 页面在 evaluate 期间导航或关闭：Playwright 抛错原样抛出（与 `snapshot` 一致），不改写成中文文案。
- 宿主侧 `page.evaluate` 返回非对象（页面被替换等极端情况）：报 `结构化读取失败：页面返回了非对象结果`。

## 验收

> 本规格状态为「已确认」时 `tests/read.mjs` 尚未创建，由本项 tester 按下列用例实现；全绿后本规格状态改「已实现」并复核每条标签仍成立。

1. `node tests/read.mjs`：exit 0、无 FAIL。用例与 `check` 标签：
   - 用例 1（夹具）：`夹具页加载成功`、`默认读取返回控件 / 链接 / 表格三节`、`未请求的表单节不出现`。
   - 用例 2（控件）：`文本输入带 role / name / type`、`select 带 options 与 selected`、`多选 select 的 type 为 select-multiple`、`checkbox 带 checked`、`disabled 提交按钮带 disabled`、`readonly 输入带 readonly`、`required 输入带 required`、`password 控件不给 value 但 hasValue`、`includeValues 返回文本控件的 value`、`includeValues 不返回 password 的 value`、`contenteditable 作为控件列出`、`不可见控件不列出`、`控件带所属表单 selector`。
   - 用例 3（链接）：`链接带绝对 href`、`链接 text 与记录对应`、`target=_blank 标出 target`、`超长 href 截断并标 hrefTruncated`、`不可见链接不列出`。
   - 用例 4（表格）：`表头取 thead 最后一行`、`rows 按单元格拆分`、`无 thead 且首行全 th 时取首行做表头`、`无表头表格 headers 为空且 rows 含全部行`、`totalRows 记录 DOM 行数`、`maxItems 截断行并给 omittedRows`、`ARIA table 按 role=row / gridcell 读取`。
   - 用例 5（唯一 selector 可直接操作）：`控件 selector 可用于 fill`、`链接 selector 可用于 click`、`表格 selector 命中表格元素`、`重复结构下 selector 仍唯一`、`unique 为 true 的记录都能在页面里唯一命中`。
   - 用例 6（表单节）：`sections 只给 forms 时只返回表单`、`表单记录带 action / method / fieldCount`。
   - 用例 7（作用域与参数）：`selector 限定到表单后只读到该表单控件`、`selector 无匹配时报错并提示 snapshot`、`selector 非法时报「不是合法 CSS 选择器」`、`sections 空数组报错`、`未知 section 报错`、`maxItems 越界报错`、`maxItems=1 时每节只列 1 条并标已截断`、`sections 顺序无关且输出固定顺序`、`sections 重复值去重`。
   - 用例 8（截断与预算）：`文本超预算时按节份额截断并计入 omitted`、`只请求 links 时该节可用全部预算`。
   - 用例 9（工具契约）：`browser_e2e_read 注册且带 tab_id`、`read 未知 tab 报既有文案`、`read 未启动时报既有文案`。
   - 用例 10（不污染既有状态）：`read 后 snapshot 的 ref 仍可点击`、`read 不改变 tab.refs 内容`。
   - 收尾：`msedge 主进程回落到运行前基线`。
2. `node tests/tools.mjs`：exit 0、无 FAIL（快照、点击、填写、上传不回归；用例 10 的 `注册的工具与工具表逐项一致` 覆盖新增工具的注册顺序）。
3. `node tests/panel.mjs`：exit 0、无 FAIL（用例 C 的 `注册的工具与工具表逐项一致（顺序与名字）`；`作用于页面的工具都接受 tab_id` 的清单加入 `read` 后仍通过）。
4. `node tests/multitab.mjs`：exit 0、无 FAIL（ref 按页隔离与跨 tab 行为不受影响）。
5. `npm run test:unit`：exit 0、无 FAIL（本项不动 `lib/protocol.js` 与 `client/index.js`，`client-bundle` 与注入块一致性断言不受影响）。
6. `npm run test:integration`：exit 0、无 FAIL，且脚本清单包含 `node tests/read.mjs`。
