# 点击与填写的目标解析

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（「P3：`lib/` 全部 `throw` 的分类」中 `lib/browser.js` 表里 click / fill 的入参与 ref 相关条目、「不变量清单」`assertRefBelongsToTab` / `assertRefRevalidated`、「没有 throw 但必须写成不变量的两处」ref 按页隔离、「P3：`lib/` 全部 `throw` 的分类」中 `lib/index.js` 表里 fill 目标缺失的工具层纵深校验）
代码: lib/page.js / lib/tools.js / lib/invariants.js / tests/tools.mjs / tests/multitab.mjs / tests/invariants.mjs

## 需求

点击与填写都接受三种目标（ref、selector、视口坐标），三者语义与失败原因不同；本规格固定三选一的判定、坐标越界口径、ref 失效口径与可填类型口径，避免点到空处、填错元素或切换勾选状态。

## 行为

### 目标解析

- 入口：`click(session, target, tabId)` 与 `fill(session, target, value, tabId)` 都先经 `currentTab(session, tabId)` 取标签页，再调 `lib/page.js` 导出的 `targetOf(target, verb)`（`lib/recipe.js` 的步骤校验也复用它），`verb` 为 `click` / `fill`。
- `ref` 与 `selector` 只在「是字符串且长度大于 0」时算作给了，空串视为未给（归一为 `null`）；`hasPoint` 只在 `x` 与 `y` 都是有限数字（`Number.isFinite`）时成立。
- `frame`（可选，见 `0018-iframe-operations.md`）是修饰参数，不参与 `ref` / `selector` / `x + y` 的三选一计数：它只能与 `selector` 组合，在该 frame 内解析并操作该 selector；与 `ref` 或坐标同用时按 `0018` 的失败文案报错。
- 0 种目标：click 报 `缺少点击目标：请给 ref（snapshot 得到的 @N）、selector（CSS 选择器）或 x + y（视口坐标）三选一`；fill 报 `缺少填写目标：需要 ref / selector / x + y 三者之一`。
- 多于 1 种目标：click 报 `点击目标只能给一种：ref / selector / x + y 三选一，避免点错位置`；fill 报 `填写目标只能给一种：ref / selector / x + y 三选一，避免填错位置`。
- 分支优先级为 ref、selector、坐标。因此 ref 与坐标同时给会被「只能给一种」拦下；只给 `x` 不给 `y` 时该组不算坐标目标，若同时给了 ref 就按 ref 处理、多余的单个坐标被忽略。
- 工具层：`browser_e2e_click` 不做额外目标前置校验，把 `args.ref` / `args.selector` / `args.x` / `args.y` 原样交给 `click`；`browser_e2e_fill` 先用 `requireString(args, 'value')` 校验 `value` 为非空字符串（报 `缺少必填参数 value（非空字符串）`），再按同样的三选一判据预检，都没给时报 `需要 ref / selector / x + y 三者之一`。

### 坐标校验

- `assertPointInViewport(page, x, y, viewport = page.viewportSize())` 是 `lib/page.js` 的模块内私有函数，click / fill / scroll 的坐标分支都过它。
- 负数：`坐标不能为负数，收到 x=${x}, y=${y}`。
- 视口基准：`viewport` 有值时直接用其宽高（隔离模式的固定视口）；没有时走 `viewportBounds` 的 `page.evaluate`，取 `window.innerWidth || document.documentElement.clientWidth || 0` 与 `innerHeight || clientHeight || 0`。
- `viewportBounds` 抛错时返回 `null`，`assertPointInViewport` 直接返回，跳过越界校验。
- `x` 超过视口宽 - 1：`坐标 x=${x} 超出视口宽度（视口宽度 ${bounds.width}，可用范围 0-${bounds.width - 1}）`；`y` 超过视口高 - 1：`坐标 y=${y} 超出视口高度（视口高度 ${bounds.height}，可用范围 0-${bounds.height - 1}）`。

### 点击

- 可选指针参数：`clickCount`（1-3 整数，缺省 1；2 为双击、3 为三击）、`button`（`left` / `right` / `middle`，缺省 `left`）、`modifiers`（`Alt` / `Control` / `Meta` / `Shift` 数组，缺省不额外按）。三者对三条目标路径都生效，目标解析、ref 查表 / 复验、坐标越界与失败文案不变；事件序列、摘要与错误文案见 `0025-click-modifiers-double-press.md`。
- ref 路径：
  - `assertRefBelongsToTab(tab.refs, ref)` 取条目，不在本页 ref 表时报 `ref ${ref} 不存在，请先 browser_e2e_snapshot 获取最新 ref`；
  - `revalidateRef` 在页面里按 `item.xpath` 用 `document.evaluate` 复验，结果交 `assertRefRevalidated`：未命中报 `ref ${ref} 已失效，请重新 browser_e2e_snapshot`，宽高非正报 `ref ${ref} 已失效（当前尺寸 ${Math.round(check.width)}x${Math.round(check.height)}，不可见），请重新 browser_e2e_snapshot`；
  - 复验通过后 `page.locator('xpath=' + item.xpath)` 先 `scrollIntoViewIfNeeded()` 再 `click({ timeout: 10000, clickCount, button })`；`modifiers` 用 `page.keyboard.down` / `up` 包裹这次点击。
- selector 路径：`page.locator(selector)` 先 `waitFor({ state: 'visible', timeout: 5000 })`，再 `click({ timeout: 10000, clickCount, button })`；`modifiers` 同上；等可见超时抛 Playwright 自身的超时错误，未改写成中文文案。
- 坐标路径：`assertPointInViewport` 通过后 `page.mouse.click(x, y, { clickCount, button })`，`modifiers` 用 `page.keyboard.down` / `up` 包裹；是真实鼠标事件；点中哪个元素完全由页面决定，工具不做命中校验。
- 返回：ref → `{ mode: 'ref', ref, tag, name, summary }`，摘要 `点击 ${ref} (${tag} "${name}")`；selector → `{ mode: 'selector', selector, summary }`，摘要 `点击 selector "${selector}"`；坐标 → `{ mode: 'point', x, y, summary }`，摘要 `点击坐标 (${x}, ${y})`。三条路径都另带 `clickCount` / `button` / `modifiers`；摘要只在非缺省组合时变化，见 `0025-click-modifiers-double-press.md`。
- 工具层输出在摘要后追加 `如需继续操作请重新 browser_e2e_snapshot。`。

### 填写

- ref 与 selector 路径都先 `assertFillable(locator, label)`：`locator.evaluate` 读 `tagName` 与 `type`，元素是 `input[type=checkbox|radio]` 时抛 `${label} 是可切换控件 input[type=${info.type}]，填写不会改变勾选状态；请改用 browser_e2e_click 切换`，`label` 为 `ref ${ref}` 或 `selector "${selector}"`；`evaluate` 失败（返回 null）时跳过该校验。
- ref 路径：ref 表查找与 `revalidateRef` 复验同 click → `scrollIntoViewIfNeeded()` → `assertFillable` → `click({ timeout: 10000 })` → `fill(value, { timeout: 10000 })`；返回 `{ mode: 'ref', ref, tag, label: item.name, value, summary }`，摘要 `填写 ${ref} (${tag} "${name}") <- "${value}"`。
- selector 路径：`waitFor({ state: 'visible', timeout: 5000 })` → `assertFillable` → `click({ timeout: 10000 })` → `fill(value, { timeout: 10000 })`；返回 `{ mode: 'selector', selector, value, summary }`。
- 坐标路径：`assertPointInViewport` → `page.mouse.click(x, y)` → `page.keyboard.type(value)`。这条路径不经过 `assertFillable`（没有 locator），也不清空原值，`type` 只在光标处追加；`mode=keystrokes` 不支持坐标目标，在点击前报错，见 `0014-type-keystrokes.md`。
- 写入语义（`mode=insert`，缺省）：ref / selector 用 Playwright 的 `locator.fill`，会替换输入框现有内容并触发 input 事件；能力层接受空串（等价于清空），但工具层 `requireString` 要求非空，空值在工具入口就被拒。
- 写入语义（`mode=keystrokes`）：ref / selector 在 click 与可填校验后先 `locator.fill('')` 清空（产生 1 次 Delete 与 1 次 input），再 `locator.pressSequentially(value, { delay, timeout: 10000 })` 逐字符输入；只支持 ref / selector，目标限文本 input / textarea / contenteditable；最终值可能被组件改写，工具不回读。参数、按键序列与错误文案见 `0014-type-keystrokes.md`。
- 工具层输出只取 `info.summary`。

## 边界

- `tab_id` 不存在：`currentTab` 走 `assertTabExists`，报 `tab ${tabId} 不存在，请先 browser_e2e_tabs 获取最新 tab_id`。
- 未启动或 0 页：`currentTab` 走 `assertCurrentTabAvailable`，报 `浏览器尚未启动或没有可用标签页，请先 browser_e2e_start`。
- 元素不可见：selector 路径在 5000ms 等可见处超时抛错；ref 路径在复验处就失败（零尺寸文案），不会静默点空。
- ref 生命周期：ref 存在标签页条目的 `refs` Map 里，`snapshot` 时整表重建（先 clear，再按节点下标写 `@N`）；`navigate` 与主框架新文档请求都会 `refs.clear()`；切 tab 后旧 ref 不在新 tab 的表里，报「不存在」。
- snapshot 之后元素被移除或变成零尺寸：复验报「已失效」。元素仍在但位置变了：复验只看 xpath 是否命中与宽高是否为正，不比对坐标，仍按 xpath 点击。
- 组合边界：ref 与 selector 同时给 → 三选一报错；`x` 给而 `y` 缺 → 不算坐标目标；fill 的坐标分支不校验可填类型，点中 checkbox 的行为是点击切换，不会报「可切换控件」。
- 越界校验依赖页面内尺寸度量：CDP 接管且 `page.evaluate` 抛错时 `viewportBounds` 返回 `null`，越界校验被跳过。
- 双击 / 三击：`clickCount=N` 产生 N 组 mousedown / mouseup（`detail` 依次 1..N），浏览器在第二组派发一次 `dblclick`；三击是否选中整行由页面决定。
- 右键 / 中键：页面 `contextmenu` / `auxclick` 会触发；原生右键菜单与中键开新标签是浏览器行为，工具不负责关闭，也不保证新页进入标签页注册表。
- 修饰键叠加：`modifiers` 在已按住的键之上再按住，点击后只释放本次按下的键；`press action=down` 按住的键会继续影响后续 click / fill，需显式释放，`navigate` 前自动释放。

## 验收

1. `node tests/tools.mjs`：exit 0、无 FAIL。相关 `check` 标签：
   - 用例 4：`能从文本解析出 ref`、`ref 点击生效`。
   - 用例 5：`selector 点击生效`、`坐标点击生效（真实鼠标事件）`、`三种目标都不给时报错`。
   - 用例 5B：`ref 写入生效`、`selector 写入生效`、`坐标写入生效`、`三种目标都不给时报错`。
   - 用例 5D：`checkbox 用 ref 填写报「可切换控件」并提示改用 click`、`radio 用 ref 填写报「可切换控件」`、`fill 后 checkbox / radio 勾选状态未变`、`随后用 click 能正常切换 checkbox`、`同页文本框 fill 仍生效`。
   - 用例 6：`失效 ref 报「已失效，请重新 snapshot」`、`失效 ref 的 fill 同样报「已失效」而不是点空`。
   - 用例 10：`fill 把 value 列为必填并提供四种目标参数`、`fill 参数含 mode 枚举与 delayMs`。
   - 用例 5E：按 `0014-type-keystrokes.md` 验收第 1 条的全部 check 标签。
2. `node tests/multitab.mjs`：exit 0、无 FAIL。用例 3 的 `带 tab_id 点击 t1 生效`、`t1 的 ref 在 t2 上失效`；用例 6 的 `click 未知 tab 报错`。
3. `node tests/invariants.mjs`：exit 0、无 FAIL。用例 C 的 `assertRefBelongsToTab 按页隔离：别的页 ref 不存在`、`assertRefRevalidated：未命中与零尺寸是两种文案`。
4. 缺口（未验证，不据此判定通过）：坐标负数与超视口两侧文案、ref 与 selector 同时给、只给 `x` 或只给 `y`，测试文件里没有对应用例；这几条按 `assertPointInViewport` 与 `targetOf` 的实现口径描述。
5. `node tests/click-press.mjs`：exit 0、无 FAIL，check 标签见 `0025-click-modifiers-double-press.md` 验收第 1 条；`node tests/tools.mjs` 用例 10 追加 `click 参数含 clickCount / button / modifiers` 与 `press 参数含 action / repeat`。
