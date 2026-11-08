# 快照与 ref 表

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/page.js` 的职责、进程内对象契约「标签页条目」的 `refs` 字段、不变量清单 `assertRefBelongsToTab` / `assertRefRevalidated`）；specs/项目规格/0002-panel-protocol-v1.md（事件表 `action`：工具动作以 `{tool, summary, at}` 广播到面板）
代码: lib/page.js / lib/snapshot.js / lib/invariants.js / lib/tools.js / tests/tools.mjs / tests/multitab.mjs / tests/invariants.mjs

## 需求

`browser_e2e_snapshot` 把整页可见 DOM 压成一份带坐标与可读名称的节点清单，并给每个节点分配 `@N` 形式的 ref，供后续 `click` / `fill` 免写 CSS 选择器地定位。本规格固定返回形状、快照判定规则与 ref 生命周期，避免切 tab 或页面变化后 ref 作用到错误元素。

## 行为

### 入口与返回

- 工具 `browser_e2e_snapshot` 接受 `tab_id`（缺省 active tab）与可选的 `delta` / `query` / `frame`（后三者见 `0012-snapshot-delta-query-frame.md`）；能力函数是 `lib/snapshot.js` 的 `snapshot(session, tabId, options)`；目标页由 `currentTab` 解析，未知 tab 报 `tab <id> 不存在，请先 browser_e2e_tabs 获取最新 tab_id`。
- `snapshot` 在页面上下文执行 `snapshotScript({ limit: SNAPSHOT_LIMIT, ... })`，`SNAPSHOT_LIMIT` 为 4000；页面脚本另受扫描上限 20000 约束。
- 返回 `{ tabId, url, mode, frame, count, total, truncated, nodes, text, summary, scanTruncated }`；delta / query 的返回形状见 `0012-snapshot-delta-query-frame.md`：
  - `nodes` 每项为 `{ ref, tag, id, classes, role, name, text, box, depth, xpath }`；`ref` 为 `@N`，按本次返回顺序从 0 起编号；`classes` 是字符串数组；`box` 为 `{ x, y, width, height }`，视口相对 CSS 像素、四值取整；`depth` 为到 `body` 的层级（`body` 的直接子元素为 1）。
  - `count` 为本次返回条数，`total` 为本次已扫描到的可见节点数（扫描上限 20000，`scanTruncated` 为真时它等于扫描上限而不是页面真实总数）；`truncated` 为 `total > SNAPSHOT_LIMIT`。
  - `text` 为可读行文本，每行形如 `<缩进>[N] <tag>#<id>.<classes> "<name>" box(x,y,w,h)`（`#<id>` 与 `.<classes>` 只在有值时出现，`N` 为去掉 `@` 的 ref），缩进为 `depth` 个两空格；无可见元素时为 `（未发现可见元素）`；截断时在末尾追加 `（已截断：共 <total> 个可见元素，只返回前 4000 个）`。
  - `summary` 为 `快照 <count> 个可见元素`，截断时追加 `（共 <total> 个，已截断到 4000 个）`。
- 工具层把结果拼成 `<summary>\n当前页面：<url>（标签页 <tabId>）\n\n<text>` 返回；该次调用的 `summary` 同时进入面板 `action` 事件。

### 节点判定规则（`snapshotScript` 内）

- 遍历范围：`document.body.querySelectorAll('*')`，不含 `body` 自身。
- 忽略标签（`SKIP_TAGS`）：`script`、`style`、`noscript`、`template`、`meta`、`link`、`head`、`title`、`base`。
- 可见性（`visibleEnough`）：`getBoundingClientRect()` 的宽或高不大于 0 直接排除；`checkVisibility` 可用时用 `checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })` 判定；该 API 抛错（旧内核不支持参数）时回退 `getComputedStyle`：`display !== 'none'` 且 `visibility` 不是 `hidden` / `collapse`。
- `role`（`roleFor`）：元素显式 `role` 属性优先；`input` 按 `type` 映射（`checkbox` / `radio` 同名，`submit` / `button` 为 `button`，其余为 `textbox`）；其余按 `roleByTag` 映射（如 `a` → `link`、`button` → `button`、`select` → `combobox`、`textarea` → `textbox`、`img` → `img`、`nav` → `navigation`、`main` → `main`、`header` → `banner`、`footer` → `contentinfo`、`aside` → `complementary`、`form` → `form`、`table` → `table`、`ul` / `ol` → `list`、`li` → `listitem`、`h1`-`h6` → `heading`）；无映射为空串。
- `name`（`nameFor`，长度上限 80）：`aria-label` → `aria-labelledby` 指向元素的 `textContent` 拼接 → 表单控件（`INPUT` / `SELECT` / `TEXTAREA`）的 `placeholder` → `label[for]`（id 经 `CSS.escape` 转义）→ 祖先 `label` 文本 → `value` / `name` 属性 → 元素文本（仅当不是 `CONTAINER_TAGS` 里的容器标签，或元素带 `role` 属性）→ `alt` → 空串。
- `text`（`textOf`）：`textContent` 的空白折叠并 `trim`，超 120 字符截断并追加 `…`。
- `classes`：`classList` 前 8 个。
- `xpath`（`xpathFor`）：`id` 匹配 `^[A-Za-z_][A-Za-z0-9_.:-]*$` 时直接给 `//*[@id="<id>"]`；否则从元素向上逐层拼 `tag[idx]`，`idx` 为该元素在同类标签兄弟中的序号（从 1 起），结果形如 `/html/body/div[1]/button[2]`。
- `CONTAINER_TAGS`（`html`、`body`、`div`、`section`、`article`、`main`、`header`、`footer`、`aside`、`nav`、`form`、`ul`、`ol`、`dl`、`table`、`thead`、`tbody`、`tfoot`、`tr`、`fieldset`、`details`、`dialog`、`figure`）不作为后代文本的 name 来源，避免祖先重复整页文本。

### ref 生命周期

- ref 表挂在标签页条目上（`tab.refs`，`Map<ref, node>`），按页隔离。
- 全量 `snapshot` 先 `tab.refs.clear()`，再按返回顺序逐条 `set(ref, item)`：ref 表只含本次返回的节点。
- delta `snapshot` 不清空 ref 表：仍在的元素沿用基线 ref，变化元素更新表项内容但 ref 不变，新增元素从基线 `nextRef` 递增分配，被移除元素的 ref 删除。全量快照仍会重置编号并使旧 ref 失效。
- 导航清空 ref 表：`navigate` 在 `goto` 前清一次、认证补票重试后再清一次；页面内主框架新文档请求（`isNewDocumentRequest` 命中）也会清空，因此同 URL reload 与 `goto` 同地址这类新文档同样让旧 ref 失效，hash 变化与 SPA 路由不触发该判据。
- 使用 ref：`click` / `fill` 先 `assertRefBelongsToTab(tab.refs, ref)` 查表，再 `revalidateRef`（页面内用 `document.evaluate` 按 xpath 取节点并读 `getBoundingClientRect`），最后 `assertRefRevalidated` 判定；两处都通过才按 `xpath=` locator 操作。
- 复验失败文案（`lib/invariants.js`）：
  - 查表不到：`ref @N 不存在，请先 browser_e2e_snapshot 获取最新 ref`；
  - xpath 不再命中：`ref @N 已失效，请重新 browser_e2e_snapshot`；
  - 命中但宽或高为 0：`ref @N 已失效（当前尺寸 0x20，不可见），请重新 browser_e2e_snapshot`。

## 边界

- 页面没有可见元素时返回 `count: 0`、`nodes: []`，文本为 `（未发现可见元素）`，不抛错。
- 超限截断只裁返回条数：`total` 保持实际可见节点数，`truncated` 为真，文本尾部有截断提示；ref 表只登记返回的节点，截断边界内的 ref 仍可正常点击。
- 在另一个标签页使用旧 ref：按目标页自己的 ref 表查找，查不到即报 `不存在`；若目标页此后重新快照过，`@N` 指向该页本次快照的第 N 个节点，不再指原元素（编号按快照重建）。
- `snapshot` 依赖当前 active tab：无标签页时报 `浏览器尚未启动或没有可用标签页，请先 browser_e2e_start`；显式 `tab_id` 不存在时报 `tab t9 不存在，请先 browser_e2e_tabs 获取最新 tab_id`。
- id 含引号等选择器元字符时，`label[for]` 查询经 `CSS.escape` 转义，不会让整次快照因 `SyntaxError` 失败。
- 快照脚本的 `cap` 只在入参为非正数 / 非整数时回退 4000，正常路径由调用方传 `SNAPSHOT_LIMIT`。
- 不处理的场景：`text` 取 `textContent`，会包含隐藏后代的文本，仅作展示用（代码注释已明示）。
- delta 无基线（首次快照 / 新文档 / 注册表 epoch 变化）时退化为全量，`baseline` 字段说明原因，不抛错。
- frame 非 0 时快照只读：节点不分配 ref、不写 `tab.refs`，跨源 iframe 报错（P1-9 处理）。
- query 不建立 delta 基线、不修改 `tab.refs`。

## 验收

1. `node tests/tools.mjs` 退出码 0 且无 FAIL：
   - 用例 4 的 `snapshot 返回 summary 与 truncated 字段`、`节点结构含 id / classes / name / depth`、`文本含 box(...)`、`文本含按钮标签与缩进`、`返回项数不少于 2`、`能从文本解析出 ref`、`ref 点击生效`。
   - 用例 4B 的 `id 含引号时 snapshot 不抛错`、`id 含引号时仍能读到 label[for] 文本`。
   - 用例 6 的 `失效 ref 报「已失效，请重新 snapshot」`、`失效 ref 的 fill 同样报「已失效」而不是点空`。
   - 用例 9 的 `truncated 为 true`、`只返回 4000 条`、`total 记录实际可见节点数`、`文本尾部有截断提示`、`截断后的 ref 点击仍生效`。
2. `node tests/multitab.mjs` 退出码 0 且无 FAIL：用例 3 的 `t1 快照拿到 A 按钮 ref`、`带 tab_id 点击 t1 生效`、`t1 的 ref 在 t2 上失效`、`t2 快照是 B 按钮`；用例 4 的 `缺省快照作用于 active（t2）`、`active 切换后缺省快照跟到 t1`；用例 6 的 `snapshot 未知 tab 报错`；用例 7 的 `恢复后可 snapshot`。
3. `node tests/invariants.mjs` 退出码 0 且无 FAIL：用例 C 的 `assertRefBelongsToTab 按页隔离：别的页 ref 不存在`、`assertRefRevalidated：未命中与零尺寸是两种文案`。
4. `node tests/snapshot.mjs` 退出码 0 且无 FAIL：delta / query / frame 用例（见 `0012-snapshot-delta-query-frame.md`）。
