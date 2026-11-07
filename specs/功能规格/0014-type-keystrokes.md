# 逐字符输入（keystrokes）

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（`lib/page.js` 职责、单次入参错误留在能力函数入口、验收命令「改 page.js / tools.js」）；specs/功能规格/0007-click-fill-targets.md（填写目标解析与默认 insert 语义）
代码: lib/page.js / lib/tools.js / tests/tools.mjs

## 需求

`browser_e2e_fill` 对 ref / selector 现在走 `locator.fill`，一次赋值只触发一次 input。受控组件（React / Vue）、掩码输入、防抖输入以及只监听 keydown / keypress / keyup 的输入框，真人操作是逐键路径，fill 覆盖不到，验证结论会与真实用户分叉。给同一工具增加可选 `mode=keystrokes`：默认 insert 行为不变，需要时清空后按真实按键逐字符写入。

## 行为

### 输入

- 工具仍是 `browser_e2e_fill`，不新增工具；目标三选一（`ref` / `selector` / `x`+`y`）与 `value` 必填不变。
- 新增 `mode`：`insert` | `keystrokes`，缺省 `insert`。`insert` 沿用现有 `locator.fill(value)` 语义：一次赋值、替换现有内容、只触发一次 input，不产生按键事件。
- 新增 `delayMs`：整数 0-1000，缺省 0；只允许与 `mode=keystrokes` 同时出现，表示相邻按键之间的等待毫秒数。
- `mode=keystrokes` 只支持 `ref` / `selector`；`x`+`y` 目标在点击前报错（坐标目标无法可靠清空，也无法校验可编辑性）。
- 字符数上限 2000（按 Unicode 码点计，与 Playwright 逐字符遍历的单位一致）；`delayMs × 字符数` 不得超过 30000 ms。
- 能力层 `fill(session, target, value, tabId, options)` 接受空串（等价于只清空、不按任何键）；工具层仍由 `requireString` 拒绝空 `value`，空值在工具入口就被拒（现状不变）。

### 写入路径（ref / selector）

1. 目标解析、ref 复验（ref 路径）、等可见（selector 路径）、`assertFillable`（checkbox / radio 拒绝）与现有 insert 路径相同，沿用 `0007-click-fill-targets.md` 的文案与顺序。
2. `mode=keystrokes` 额外校验目标类型：`input[type=text|search|tel|url|email|password|number]`、`textarea`、`contenteditable`（含 editing host）可用；`select` 与 `input[type=file|date|color|range|...]` 等非文本目标报中文错误。
3. 与现有路径一样先 `locator.click({ timeout: 10000 })`，再用 `locator.fill('', { timeout: 10000 })` 清空，最后 `locator.pressSequentially(value, { delay: delayMs, timeout: 10000 })`。Playwright 对可编辑元素的清空是「全选 + Delete」，因此每次清空固定产生 1 次 Delete 按键；清空前目标非空时还会产生 1 次 input，原本为空时不产生 input。
4. 按键序列：US 键盘可表达的字符每个产生 keydown / keypress / input / keyup；`\n` 与 `\r` 映射为 Enter；中文、emoji 等不在 US 键盘布局中的字符由 Playwright 走 `Input.insertText`，每个码点只产生一次 input，不产生 keydown / keyup；`\t` 不会被当作 Tab 键（它走 insertText 路径），需要移动焦点时先用 `browser_e2e_press`。
5. 不模拟 IME composition：中文输入没有 compositionstart / compositionupdate / compositionend。

### 输出

- `insert`：返回形状与现状逐字段一致（`mode` 仍表示目标路径 `ref` / `selector` / `point`，`value` 为传入文本，`summary` 不变）。
- `keystrokes`：在现状字段上追加 `inputMode: 'keystrokes'`、`chars`（码点数）、`delayMs`；摘要为 `逐键填写 <目标> <- "<value>"（<chars> 个字符，delayMs=<n>）`。<目标> 与现有摘要同格式：`ref @N (tag "name")` 或 `selector "..."`。
- 不回读最终 value：受控组件、掩码、`maxlength`、`input[type=number]` 等都会改写值，`value === 最终 DOM 值` 不是本工具的不变量；需要断言最终值时，由调用方用 `browser_e2e_evaluate` 或后续断言工具完成。
- 工具层仍只把 `info.summary` 作为文本返回；面板动作提示取摘要首行（现状，不需要改协议）。

### 状态变化

- 不新增 / 不切换标签页，不改会话状态机，不改面板协议与只读定位，不新增浏览器进程；只有页面内焦点与输入值变化。
- isolated 与 cdp 两种模式走同一条 Playwright API，无分支差异。后台标签页里 `document.hasFocus()` 为 false 的编辑器可能忽略按键；本项不做 focus emulation（详见「边界」）。

## 边界

- 目标错误沿用：缺目标 / 多目标 / tab 不存在 / 未启动 / ref 失效 / checkbox / radio 的文案见 `0007-click-fill-targets.md`，本项不改。
- `mode` 非法：`mode 只支持 insert / keystrokes，收到 "..."`。
- `mode=insert` 传 `delayMs`：`delayMs 只对 mode=keystrokes 生效；mode=insert 请去掉 delayMs`。
- `delayMs` 非整数或越界：`delayMs 必须是 0-1000 的整数，收到 ...`。
- 字符数超限：`mode=keystrokes 一次最多 2000 个字符（按码点计），收到 N 个；长文本请用默认 mode=insert`。
- 时间预算超限：`mode=keystrokes 的 delayMs × 字符数不能超过 30000 ms（当前 N × M = P ms）；请减小 delayMs 或分段输入`。
- 坐标 + keystrokes：`mode=keystrokes 需要 ref 或 selector（坐标目标无法可靠清空和校验可编辑性）；请改用 ref / selector，或使用默认 mode=insert`。
- 目标是 select：`<label> 是下拉选择控件 select，不能逐键输入；请先用 browser_e2e_click 展开，再用 browser_e2e_press（方向键 / Enter）选择`。
- 目标是非文本 input 或其他元素：`<label> 不是可逐键输入的文本目标（<tag>[type=<type>]）；需要 input / textarea / contenteditable，非文本控件请改用默认 mode=insert`。
- 目标类型探测的 `evaluate` 返回 null 时跳过中文类型校验，由 Playwright 在 click / fill('') / pressSequentially 处报错（沿用现状「evaluate 失败跳过校验」的处理）。
- 单行 input 里传换行会作为 Enter 键，可能触发表单提交；需要换行请用 textarea。
- 防抖组件：工具在最后一个按键后立即返回，不等组件内部 debounce 落定；调用方需要时用 `browser_e2e_wait` 等目标状态。
- 掩码输入的最终显示值可能与 value 不同，这是本工具不做读回校验的前提，不是失败。
- 明确不做：真实 IME、组合键（Control+A 等用 `browser_e2e_press`）、Tab 键、坐标路径的逐键清空、后台标签页 focus emulation。

## 验收

1. `node tests/tools.mjs`：exit 0、无 FAIL。用例 5E（逐键模式）至少包含以下 check 标签并通过：
   - `keystrokes 逐键写入并替换旧值`
   - `keystrokes 每个字符产生 keydown / keyup`
   - `keystrokes 清空产生一次 Delete`
   - `keystrokes 支持 contenteditable`
   - `keystrokes 在 textarea 中把 \n 作为 Enter`
   - `keystrokes 的 delayMs 拉长总耗时`
   - `keystrokes 逐字符触发受控输入`
   - `keystrokes 逐字符触发掩码输入`
   - `keystrokes 不回读最终 value`
   - `keystrokes 中文走 insertText、不产生 keydown`
   - `keystrokes 坐标目标报错`
   - `keystrokes 对 select / 非文本 input 报错`
   - `delayMs 只允许 keystrokes`
   - `delayMs 越界报错`
   - `mode 非法报错`
   - `keystrokes 超过 2000 字符报错`
   - `delayMs × 字符数超过 30000ms 报错`
   - `mode 缺省为 insert 且不产生按键事件`
2. `node tests/tools.mjs` 用例 10：`fill 参数含 mode 枚举与 delayMs` 通过（`mode.enum` 为 `["insert","keystrokes"]`，`delayMs` 在 properties，`value` 仍在 required）。
3. `node tests/panel.mjs`：exit 0、无 FAIL（工具参数契约用例仍通过，新增参数不破坏既有断言）。
4. `npm run test:unit`：exit 0、无 FAIL（未改不变量与协议常量）。
5. `node tests/multitab.mjs` 与 `node tests/cdp.mjs`：exit 0、无 FAIL（回归；本项不新增 CDP 专项用例）。
6. 未验证 / 非目标：真实 React / Vue 应用组件、真实 IME、CDP 后台标签页的 `document.hasFocus()` 行为；夹具用原生 JS 模拟受控、防抖与掩码。
