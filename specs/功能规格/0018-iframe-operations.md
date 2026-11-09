# iframe 内元素操作

状态: 已实现（方案 A1）
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/page.js` 的职责；进程内对象契约「标签页条目」与各工具返回字段；不变量清单 `assertRefBelongsToTab` / `assertRefRevalidated`；已知结构性债务「page.js 粒度过大」）；specs/项目规格/0003-决策记录.md（本项由 Lead 录入）；specs/功能规格/0004-snapshot-and-ref-table.md（ref 生命周期）；specs/功能规格/0007-click-fill-targets.md（目标解析、坐标口径与失败文案）；specs/功能规格/0012-snapshot-delta-query-frame.md（frame 快照、子 frame 只读与跨源报错）；README.md「Known Limitations and Deferred Work」（快照只读同源 iframe；悬停与拖拽只作用于主 frame）
代码: 已落地：新增 `lib/frame.js`（`frameListOf` / `describeFrames` / `frameInfoOf` / `resolveFrame` / `actionFrameOf`，快照与交互工具共用同一份定位实现）；`lib/snapshot.js` 的 frame 解析改为复用 `frame.js`（行为与文案不变）；`lib/page.js` 的 `click` / `fill` / `scroll` 新增 `frame` 分支与互斥校验、frame 卸载文案；`lib/tools.js` 三个工具的参数与描述；`tests/frames.mjs`（新建，23 条用例，本规格「3. 采纳方案 A1 后的实施验收」点名的 4 条用例已补：`frame 1 内点击后 press 生效` / `frame 内坐标点击按主视口命中` / `frame 导航后 selector 重新解析` / `t1 与 t2 的 frame 互不影响`）；`tests/cdp.mjs` 新增 `CDP 接管下 frame 内 selector 点击生效` / `CDP 接管下跨源 frame 内 selector 点击生效`；`tests/tools.mjs` 新增 `click / fill / scroll 的参数表含 frame` / `press 的参数表不含 frame`；`package.json` 的 `test:integration`；`README.md`；`specs/项目规格/0001`（模块表与依赖图）。`press` 不加 `frame`；`hover` / `drag` / `upload` 仍只作用主 frame。

## 需求

支付、登录、嵌入式编辑器常把关键控件放在 iframe 内。P0-3 已让 `browser_e2e_snapshot` 通过 `frame` 参数读取同源 iframe（子 frame 节点 `ref: null`，只读），但 `browser_e2e_click` / `browser_e2e_fill` 的 `ref` 与 `selector` 仍只在主文档解析，`browser_e2e_scroll` 只滚动主文档，`browser_e2e_press` 只作用于当前焦点。使用者在 iframe 页面上能「看见」子 frame 内容，却无法用 `selector` 在子 frame 内点击、填写或滚动。

本项已决策为方案 A1（`frame` 只与 `selector` / 滚动组合，子 frame 不分配 ref；跨源支持，见「边界」决策点 D1）。决策时判定为**影响大**、不是「单工具新增参数」的依据：

- 任务书硬约束 1 把「改既有工具语义」「多工具联动」「定位方向」列为影响大；本项同时命中三项：改 `click` / `fill` / `scroll` 的既有目标语义，联动 `snapshot` 的 `frame` 与 ref 定位模型，新增「frame 内寻址」这一维定位方向。
- `0012-snapshot-delta-query-frame.md` 原明文写「不为 `click` / `fill` / `press` / `scroll` 增加 `frame` 参数（留给 P1-9）」（本项采纳 A1 后已解除，见该文件「边界」的「不做」节）和「子 frame 只读：不分配 ref」；`0004-snapshot-and-ref-table.md` 固定「ref 表按标签页一张、全量快照整表重建」；`0007-click-fill-targets.md` 固定 click / fill 的「ref / selector / x + y 三选一」目标模型。本项落地改写了这三份功能规格的既有语义，不是只新增参数。
- `lib/page.js` 的 `targetOf` / `revalidateRef` 被 click / fill / hover / drag / upload 五个能力共用；若按原意图实现「子 frame 也分配 ref」（README 预埋的 `f<N>@M`），五个能力与 `lib/invariants.js` 都要改，且 README 已声明 hover / drag / upload 只作用主 frame，工具族会出现新的不一致。
- `press` 没有元素目标，`scroll` 没有元素目标且现有语义是真实滚轮事件；给它们加 `frame` 需要分别定义「焦点如何进入 frame」「滚轮落在哪个滚动容器」，不是参数平移。
- 跨源 iframe 涉及平台能力选择：P0-3 的快照只读取同源 iframe。Playwright 在 Chromium 下以 `Frame` 抽象覆盖跨源 OOPIF，本仓 isolated 与 `connectOverCDP` 两种模式是否同样可用已按 D1 实测（结论为可用，证据见「边界」），因此 click / fill / scroll 不做同源限制；不需要退回原始 CDP 按 target 切换（那属于 P2-26「原始 CDP / HTTP 逃生口」的能力面，不并入本项）。

候选方案：

- **A：扩展现有工具加 `frame`。** A1＝`frame` 只与 `selector` / 滚动组合，子 frame 不分配 ref；A2＝A1 再加子 frame ref（`f<N>@M` 复合地址）。已采纳 A1；A2 未采纳，另立。
- **B：新增 iframe 专用工具组**（如 `browser_e2e_frame_click` / `frame_fill` / `frame_scroll`）。隔离性好，但复制四套 schema 与文案，工具数从 18 增加，模型要在两组工具间选，且不解决 ref 寻址。
- **C：frameLocator 句柄工具**（先取 `fr1` 句柄，后续工具带句柄）。适合同一 frame 内连续多步，但引入新的跨调用状态（句柄归属、导航失效、tab 关闭清理）与新不变量，成本最高。

本规格已确认，构成实现契约。下文「行为」中的「方案 A1 的目标契约」是实施依据；当前代码未实现，验收第 1 组是实施前的回归基线。

## 行为

### 当前行为（缺口与既有边界）

- `click(session, target, tabId)` 与 `fill(session, target, value, tabId)`：先 `currentTab`，再 `targetOf(target, 'click' | 'fill')` 解析 `ref` / `selector` / `x + y` 三选一；`ref` 路径查 `tab.refs` 后由 `revalidateRef` 在**主文档**执行 `document.evaluate` 复验，`selector` 路径用 `page.locator(selector)`；坐标路径用 `page.mouse.click`。三者都不进入子 frame。
- `scroll(session, options, tabId)`：解析 `delta_x` / `delta_y`（至少一个非 0），可选 `x` / `y` 先 `page.mouse.move`，再 `page.mouse.wheel`；只滚动主文档。
- `press(session, keyName, tabId)`：`page.keyboard.press(keyName)`，作用于当前焦点，无目标参数。
- `snapshot(session, tabId, options)`：`resolveSnapshotFrame` 解析 `frame`（整数索引，0 为主文档、`n≥1` 按 `page.frames()` 顺序过滤主文档后的第 n 个；字符串先 name 精确匹配、再 url 子串匹配）；`index > 0` 时 `assertSameOriginFrame` 拒绝跨源；`readSnapshotRaw` 用 `frame.evaluate` 读取；`runFullSnapshot` / `runDeltaSnapshot` / `runQuery` 对子 frame 一律 `ref: null`，不写 `tab.refs`。
- 坐标点击的机制边界：`page.mouse.click` 按主视口 CSS 像素命中，浏览器会把落在 iframe 区域内的点派发到该 frame 的文档。也就是说，不用 `frame` 参数也能点到 iframe 里的元素（前提是坐标算准）；本项不为坐标路径增加 frame 语义。该机制目前没有测试覆盖。
- 既有不变量：ref 表挂在标签页条目的 `tab.refs`（按页隔离），`assertRefBelongsToTab(refs, ref)` 只查表，`assertRefRevalidated(ref, check)` 只判命中与尺寸；子 frame 不分配 ref，所以现有不变量没有被跨 frame 误用。

### 方案 A1 的目标契约

#### 输入

`frame` 是修饰参数，不参与 click / fill 的「三选一」计数；`targetOf` 的三选一逻辑保持不变。

| 工具 | 新参数 | 类型 | 缺省 | 允许组合 | 语义 |
|---|---|---|---|---|---|
| `browser_e2e_click` | `frame` | integer \| string | `0`（主文档） | 只能与 `selector` 组合 | 在该 frame 内解析 `selector` 并点击 |
| `browser_e2e_fill` | `frame` | integer \| string | `0`（主文档） | 只能与 `selector` 组合 | 在该 frame 内解析 `selector` 并填写 |
| `browser_e2e_scroll` | `frame` | integer \| string | `0`（主文档） | 与 `delta_x` / `delta_y` 组合；与 `x` / `y` 互斥 | 把鼠标移到该 frame 元素中心后滚动 |
| `browser_e2e_press` | 无 | — | — | — | 仍作用于当前焦点；不支持 frame（推荐，见决策点 D4） |

`frame` 的定位规则与 `browser_e2e_snapshot` 完全一致，复用同一份实现：整数 `0` 为主文档、`n≥1` 为本次调用 `frameListOf(page)` 的第 n 个；字符串先按 `frame.name()` 精确匹配，无命中再按 `frame.url()` 子串匹配；多命中报错要求改用索引；每次调用重新取列表，索引只对本次调用有效。`frame: 0` 与不传 `frame` 行为与摘要都等价。定位之外的校验不复用快照：click / fill / scroll 不做同源限制（D1），`snapshot` 的同源判定保持原样。

#### 输出

- 仅当 `frame.index > 0` 时，返回值追加 `frame: { index, name, url, parentIndex }`（与快照的 `frame` 字段同形）；`frame: 0` 与不传 `frame` 保持既有返回形状逐字不变（不追加字段）。
- `summary` 在 `frame.index > 0` 时追加 `（frame <index>）`，且 `name` 非空时写成 `（frame <index> "<name>"）`；`frame: 0` 不加后缀，保持既有摘要逐字不变。**例外**：`scroll` 的 frame 分支有自己的措辞 `向 frame（索引 N）中心 (x, y) 发送滚动 (dx, dy)；实际滚动量由页面决定`，已含索引且保留了实际滚动量，不套用上面的通用后缀。
- `click` 的 `mode` 仍为 `ref` / `selector` / `point`；frame 分支的 `mode` 为 `selector`。`fill` 同理。`scroll` 的 `mode` 仍为 `scroll`。

#### 行为

- `click` / `fill`，`frame.index > 0`：
  1. 先解析 frame；不做同源检查（D1 实测跨源可用，证据见「边界」）。
  2. 用 `frame.locator(selector)` 定位；click 先 `waitFor({ state: 'visible', timeout: 5000 })`，再 `click({ timeout: 10000 })`。
  3. fill 追加 `assertFillable(locator, label)`（label 带 frame 描述），再 `click` 与 `fill(value, { timeout: 10000 })`；写入语义仍是 Playwright 的替换式填充。
  4. frame 在解析后、操作前 detach 或导航：捕获 Playwright 的 detached / Target closed / Execution context destroyed 类错误，改写为 `frame（索引 N）已不可用（已导航或卸载），请重新 browser_e2e_snapshot`；其余错误保留原始文本。
- `scroll`，`frame.index > 0`：
  1. 解析 frame；不做同源检查（D1 实测跨源可用，证据见「边界」）。
  2. 取 `frame.frameElement()`；`scrollIntoViewIfNeeded()` 后读 `boundingBox()`（Playwright 对子 frame 元素的 `boundingBox()` 返回相对主 frame 的坐标）。
  3. 取中心点并过既有 `assertPointInViewport`；`page.mouse.move` 到中心，再 `page.mouse.wheel(deltaX, deltaY)`，保持真实滚轮事件语义。
  4. `frameElement()` 返回空、frame detach、或中心点不可见时报错，不静默滚主文档。
- `press`：不加 `frame`。焦点在子 frame 内时，`page.keyboard.press` 会发给该 frame 的焦点元素（先用 click / fill 在该 frame 内建立焦点）。若未来要求 `press` 直接指定 frame，需同时加元素聚焦参数（`ref` / `selector`），属另一设计（决策点 D4）。

#### 失败文案

| 场景 | 文案 |
|---|---|
| `frame` 类型非法 | `frame 必须是 0 或正整数（0 为主文档），收到 <值>`（字符串仍允许；与快照同一文案） |
| `frame` 索引越界 | `frame 索引 <n> 不存在：当前页共 <m> 个 frame（<可用索引与 name/url>），请重新 browser_e2e_snapshot 查看` |
| `frame` 字符串未命中 / 多命中 | 与 `0012-snapshot-delta-query-frame.md` 的 frame 定位文案一致（未找到列可用索引；多命中列候选并要求改用索引） |
| click / fill 同时给 `frame` 与 `ref` | `frame 只能与 selector 组合：子 frame 不分配 ref，请先用 browser_e2e_snapshot { frame } 取 selector，或对主文档使用 ref` |
| click / fill 同时给 `frame` 与 `x` / `y` | `frame 与 x + y 只能给一种：x + y 按主视口坐标命中（可落在 iframe 上），frame 用于在该 iframe 内解析 selector` |
| scroll 同时给 `frame` 与 `x` / `y` | `frame 与 x + y 只能给一种：frame 决定滚动目标，x + y 决定主视口滚动位置` |
| frame 已不可用 | `frame（索引 <n>）已不可用（已导航或卸载），请重新 browser_e2e_snapshot` |

#### 超时与取消

- 沿用既有超时：click / fill 的 `waitFor` 5000ms、`click` 10000ms、`fill` 10000ms；不新增参数。
- `frame` 解析是同步纯函数，无超时；scroll 的 `frameElement` / `boundingBox` 走 Playwright 默认行为，不额外加计时。
- 不新增取消通道：工具调用中途的取消不在本项范围；frame 导航导致的执行上下文销毁按上面的文案归一。

### 状态变化

- 会话：不新增字段，状态机（`idle / launching / ready / closing / closed`）不变。
- 标签页：不新增字段；`tab.refs` 与 `snapshotBaselines` 在 A1 下完全不动。frame 解析结果只在本次调用内有效，不落任何状态。
- 面板：工具摘要照旧进入 `action` 事件；带 frame 的调用在摘要末尾多一个 `（frame N）` 后缀。面板协议、客户端 bundle、`panelTabId` 规则不变。
- 浏览器进程：无变化；isolated 与 cdp 两种模式都只使用 Playwright 的 `Page` / `Frame`，不新起进程、不新建 context。

## 边界

- **同源 vs 跨源（决策点 D1）：已实测，支持跨源。** 夹具主文档在 `http://127.0.0.1:<mainPort>`，子 iframe 在 `http://localhost:<framePort>/frame.html`：两者不同源，且 Chromium 把该子 frame 放进独立进程（OOPIF），主文档读 `contentDocument` 被拒（`contentDocumentBlocked: true`），CDP `Target.getTargets` 中出现独立的 `type: iframe` target。命令 `node .scratch/expr/cross-origin-frame.mjs`（exit 0），isolated（`chromium.launch({ channel: 'msedge', headless: true })`）与 cdp（`connectOverCDP` 接管 `--remote-debugging-port` 的 Edge）两种模式结果相同：`frame.evaluate` 读到子 frame 文档（`ready: true`）、`frame.locator('#target').click()` 成功且 `window.__clicked === true`、`frame.frameElement()` 的 `boundingBox()` 返回 `{ x: 8, y: 8, width: 604, height: 404 }`（相对主视口）。因此 click / fill / scroll 不做同源限制；`snapshot` 仍按 P0-3 只读同源 iframe（本次不放宽，操作跨源 frame 时 `selector` 由调用方提供）。
- **嵌套 frame**：`frameListOf` 返回 `page.frames()` 的扁平列表，含嵌套 frame；`frameInfoOf` 的 `parentIndex` 指向父 frame 在本次列表中的索引。`frame.locator` 直接作用于最内层 frame，不需要逐层进入。scroll 对嵌套 frame 取 `frame.frameElement()` 的中心点；Playwright 文档声明子 frame 元素的 `boundingBox()` 相对主 frame，但嵌套两层以上的实测覆盖为零，列为测试风险。
- **frame 导航后 ref 失效**：A1 不给子 frame 分配 ref，因此不存在「子 frame ref 失效」；旧 ref 仍只属于主文档，主文档新文档请求照旧清空 `tab.refs`。子 frame 导航后，`frame` 索引每次调用重新解析，字符串 name / url 可能变化；`selector` 每次在目标 frame 内重新解析，元素不存在时由 Playwright 超时报错，不会静默点到旧元素。若采纳 A2，子 frame 导航必须让该 frame 的 ref 分桶失效，并补不变量（见下）。
- **坐标目标的坐标系（决策点 D2）**：A1 规定 `frame` 非 0 时 `x + y` 不可与 `frame` 同用；坐标始终是**主视口 CSS 像素**，与 `elementHandle.boundingBox()` 的口径一致。理由：`page.mouse` 只认主视口坐标；若接受 frame 内坐标，要对每层 iframe 依次取 `frameElement().boundingBox()` 并累加偏移，嵌套时误差与失效点成倍增加。frame 内按坐标操作的需求用「主视口坐标直接点」满足（浏览器命中 iframe），或改用 `frame + selector`。
- **`ref` 在子 frame 下如何分配（决策点 D3，本项最大设计张力）**：A1 维持 P0-3 的「子 frame 不分配 ref」。子 frame 的元素操作靠 `frame + selector`；`snapshot { frame, query }` 返回的 `selector` 从此可配合同一 `frame` 传给 click / fill（P0-3 的「只用于展示」边界被解除，见规格同步）。A2 若引入 `f<N>@M`：`tab.refs` 仍是一张表，但条目要携带 frame 身份（Playwright `Frame` 对象，不用易漂移的索引）；`revalidateRef` 要在条目所属 frame 内复验；子 frame 全量快照只清该 frame 的 ref 分桶、不能 `tab.refs.clear()`；`framenavigated` 要失效对应分桶；click / fill / hover / drag / upload 五个能力都要改；`lib/invariants.js` 需要新增「ref 条目的 frame 仍属于当前 tab 且未 detach」的跨调用断言。这是一次 ref 定位模型迁移，不能与 A1 混在一个提交里。
- **press 的焦点边界**：`press` 不保证焦点在哪个 frame；调用方应先用 `frame + selector` 的 click / fill 把焦点放进目标 frame。若页面脚本在 frame 内 `blur()`，`press` 会落到主文档或无处，这是页面行为，不是工具失败。
- **scroll 的命中边界**：滚轮落在 frame 元素中心，由浏览器决定命中该 frame 的哪个可滚动容器；iframe 有覆盖层、`pointer-events: none`、或中心点位于视口外时可能滚到父页或不动。实现必须先 `scrollIntoViewIfNeeded` 并校验中心点在视口内；仍无法保证一定滚动 iframe，摘要只报告已发送的滚动量。
- **frame 定位边界**：`frame` 不是 0 或正整数 / 字符串为空 / 索引越界 / 字符串未命中 / 多命中 / `frame.url()` 为空或 `about:blank` / `about:srcdoc` 时，全部沿用快照的判据与文案。`about:blank` / `about:srcdoc` / 空 url 视为同源，`data:` / `blob:` url 的 origin 为 `null` 按跨源处理；这两条只影响 `snapshot` 的同源判定，click / fill / scroll 不做同源判定（D1）。
- **工具族不一致**：`browser_e2e_hover` / `browser_e2e_drag` / `browser_e2e_upload` 仍只作用主 frame（README 已知限制）。A1 落地后 click / fill / scroll 支持 frame，这三个不支持；必须在 README 与工具描述里写明，或另立一项决定是否扩展到全部交互工具（决策点 D5）。本规格不把 hover / drag / upload 纳入实现范围。
- **不做**：不给 `press` 增加无目标的 `frame`；不做自动「所有 frame 一起操作」；不做 frame 句柄（方案 C）；不做跨源 CDP target 切换（P2-26）；不做子 frame ref（A1，A2 另立）；不改 `snapshot` 的默认多 frame 行为、4000 上限、delta 基线口径；不改面板、协议、客户端；不改 `hover` / `drag` / `upload`。

## 验收

### 1. 实施前的回归基线（当前代码可执行）

- `node tests/snapshot.mjs`：exit 0 且无 FAIL。frame 组用例名：`frame 索引 0 等价主文档`、`frame 索引 1 读到同源 iframe`、`frame 按 name 定位`、`frame 按 url 子串定位`、`frame 越界报错`、`frame 未命中报错`、`frame 多命中报错`、`frame 跨源报错`、`子 frame 快照不污染主文档 ref`、`frame + delta 报子 frame 变化`、`frame + query 返回 ref=null`。
- `node tests/tools.mjs`：exit 0 且无 FAIL。相关用例名：用例 5 的 `selector 点击生效`、`坐标点击生效（真实鼠标事件）`、`三种目标都不给时报错`；用例 5B 的 `ref 写入生效`、`selector 写入生效`、`坐标写入生效`；用例 5C 的 `滚动后 window.scrollY 增加`、`返回 deltaX / deltaY 与摘要`、`坐标滚动继续增加 scrollY`。
- `npm run test:unit`：exit 0。
- `npm run test:integration`：exit 0（串行真起无头 Edge；进程类断言以回落到运行前基线为准）。

### 2. 决策记录

- `specs/项目规格/0003-决策记录.md` 存在本项（P1-9）的记录（决策行由 Lead 维护）。判定命令：
  `pwsh -NoProfile -Command "if (Select-String -Path 'specs\项目规格\0003-决策记录.md' -Pattern 'P1-9') { exit 0 } else { exit 1 }"`，exit 0。

### 3. 采纳方案 A1 后的实施验收

- `node tests/frames.mjs`（由 tester 新建，用例名由本规格固定）：exit 0 且无 FAIL。用例名：
  - 正常：`frame 1 内 selector 点击生效`、`frame 1 内 selector 填写生效`、`frame 1 内滚动生效`、`frame 1 内点击后 press 生效`、`frame 0 与不传 frame 等价`、`frame 按 name 定位 selector 点击`、`嵌套 frame 内 selector 点击生效`、`frame 内坐标点击按主视口命中`、`跨源 frame 内 selector 点击生效`（双端口夹具，主文档与子 frame 不同源）。
  - 边界：`frame 与 ref 同时给报错`、`frame 与坐标同时给报错`、`frame 越界报错`、`frame 导航后 selector 重新解析`、`scroll 的 frame 与坐标互斥报错`、`t1 与 t2 的 frame 互不影响`。
- `node tests/cdp.mjs`：exit 0 且无 FAIL。新增用例名：`CDP 接管下 frame 内 selector 点击生效`、`CDP 接管下跨源 frame 内 selector 点击生效`。
- `node tests/tools.mjs`：exit 0 且无 FAIL。用例 10 新增断言名：`click / fill / scroll 的参数表含 frame`、`press 的参数表不含 frame`。
- `npm run test:unit` 与 `npm run test:integration`：exit 0（`tests/frames.mjs` 由 Lead 批准后加入 `package.json` 的 `test:integration`）。
