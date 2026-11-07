# 双击、鼠标键与修饰键、按住释放

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/page.js`、标签页条目字段 `heldKeys`、能力函数返回值口径）；specs/功能规格/0007-click-fill-targets.md（目标三选一、ref 查表 / 复验与单击口径）；specs/项目规格/0002-panel-protocol-v1.md（`action` 事件取摘要首行，本项不改协议）
代码: lib/page.js / lib/tools.js / tests/click-press.mjs

## 需求

Shift 区间选择、右键菜单、双击打开 / 放大、按住 Shift 或 Control 再操作，是验收里常见的真人输入路径；现在 `browser_e2e_click` 只有左键单击、`browser_e2e_press` 只有一次按下并抬起，表达不了这些动作。给这两个工具增加可选参数，缺省行为与现有一致，不新增工具。

## 行为

### `browser_e2e_click` 的指针参数

| 参数 | 类型 | 区间 | 缺省 | 语义 |
|---|---|---|---|---|
| `clickCount` | integer | 1-3 | 1 | 1 单击、2 双击、3 三击；`clickCount=N` 产生 N 组 mousedown / mouseup，`detail` 依次为 1..N，浏览器在第二组时派发 `dblclick` |
| `button` | string enum | `left` / `right` / `middle` | `left` | 鼠标键；右键触发 `contextmenu`，中键触发 `auxclick` |
| `modifiers` | array | 元素为 `Alt` / `Control` / `Meta` / `Shift` | 空 | 点击期间额外按住的修饰键 |

- 目标三选一（`ref` / `selector` / `x`+`y`）、ref 查表与复验、坐标越界与既有错误文案都不变；三个参数对三条目标路径同样生效。
- 事件由 Playwright 的真实输入产生（`isTrusted=true`）：元素路径用 `locator.click({ clickCount, button, timeout: 10000 })`，坐标路径用 `page.mouse.click(x, y, { clickCount, button })`。
- `modifiers` 是叠加语义：在已按住的键之上再按下这些键，点击后只释放本次按下的键（`page.keyboard.down` / `up` 包裹这次点击）；不传表示不额外按，已按住的键仍然生效（Playwright 的鼠标事件使用键盘当前按住的修饰键）。要排除已按住的键，先调用 `browser_e2e_press` 的 `action=up` 释放。
- 返回：原字段不变，另带 `clickCount` / `button` / `modifiers`（`modifiers` 固定为数组，未给时为空数组）。
- 摘要：缺省组合（单击、左键、无修饰键）与现状逐字一致（`点击 @3 (button "Submit")` / `点击 selector "#x"` / `点击坐标 (10, 20)`）；双击 / 三击时把动作词换成 `双击` / `三击`，右键 / 中键与修饰键在尾部追加括号：`双击 @3 (button "Submit")`、`点击 @3 (button "Submit")（右键）`、`点击坐标 (10, 20)（按住 Control+Shift）`、`双击 @3 (button "Submit")（右键，按住 Shift）`。
- 工具层文本仍在摘要后追加 `如需继续操作请重新 browser_e2e_snapshot。`；面板 `action` 事件取摘要首行，协议不变。

### `browser_e2e_press` 的动作参数

| 参数 | 类型 | 区间 | 缺省 | 语义 |
|---|---|---|---|---|
| `action` | string enum | `press` / `down` / `up` | `press` | `press` 按下并抬起一次；`down` 只发 keydown 并保持按住；`up` 只发 keyup |
| `repeat` | integer | 1-100 | 1 | 只对 `action=press` 生效；重复整次按下 / 抬起 |

- `action=press`：与现状一致，`page.keyboard.press(key)`；`key` 沿用 Playwright 的按键名与组合键字符串（`Enter`、`Tab`、`Control+A`、`Control+Shift+T`），`repeat>1` 时循环调用 `repeat` 次。
- `action=down`：`page.keyboard.down(key)`，只发 keydown、不发 keyup；`key` 必须是单个按键名（含 `Shift` / `Control` / `Alt` / `Meta` 这类修饰键本身）。
- `action=up`：`page.keyboard.up(key)`，只发 keyup；若该键没有被本工具按住过，仍发送 keyup，返回 `held=false`。
- `action=down` / `up` 不接受组合键字符串与 `repeat`（显式给 `repeat` 即报错，包括 `repeat=1`）：组合键归 `action=press`，重复按住没有明确语义。
- 返回：`{ key, action, repeat, held, summary }`；`held` 表示本次调用后该键是否被本工具保持按住。
- 摘要：`action=press` 为 `按键 ${key}`，`repeat>1` 时追加 ` ×${repeat}`（缺省仍与现状逐字一致）；`action=down` 为 `按下 ${key}（保持按住；释放需 action=up）`；`action=up` 为 `释放 ${key}`。

### 按住状态

- 按住的键按标签页记账：`page.js` 的 `addPage` 在标签页条目上建 `heldKeys`（`Set`），`press` 的 down / up 读写它，`navigate` 在 `goto` 前逐个 `keyboard.up` 释放并清空。
- 不跨标签页：在 `t1` 按住的键不会出现在 `t2`；关闭标签页或会话时页面对象消失，按住状态随之消失。
- 没有自动释放计时：按住多久由调用方决定，忘记 `action=up` 时该键会一直影响后续输入，直到释放、导航或关页。
- 按住修饰键后的跨工具效果是真实浏览器行为，不是另一套状态机：不传 `modifiers` 的 `click` 事件会带上该修饰键（`shiftKey` / `ctrlKey` 等为 true），`fill` 的 `mode=keystrokes` 会输入大写等被修饰键转换后的字符；`fill` 的 `mode=insert` 不受影响。

### 状态变化

- 不新建 / 不切换标签页，不改 `activeTabId`，不改会话状态机，不新增浏览器进程，不动面板协议与只读定位。
- 只改变页面内的指针 / 键盘事件、焦点、选区与页面自身状态；面板只多一条 `action` 广播（工具名 + 摘要首行）。

## 边界

- 参数错误一律在任何输入事件之前抛出：
  - `clickCount` 非 1-3 整数：`clickCount 必须是 1-3 的整数，收到 ${clickCount}`。
  - `button` 非法：`button 只支持 left / right / middle，收到 "${button}"`。
  - `modifiers` 非数组或含非法值：`modifiers 必须是数组，且每个元素只能是 Alt / Control / Meta / Shift，收到 ${JSON.stringify(modifiers)}`。
  - `action` 非法：`action 只支持 press / down / up，收到 "${action}"`。
  - `repeat` 非 1-100 整数：`repeat 必须是 1-100 的整数，收到 ${repeat}`。
  - `repeat` 与 down / up 同给（包括 `repeat=1`）：`repeat 只对 action=press 生效；action=down / up 时请去掉 repeat`。
  - down / up 给组合键：`action=down / up 的 key 必须是单个按键名（如 Shift、a、Enter）；组合键请用 action=press，例如 key: "Control+A"`。
- 目标类错误沿用既有口径：未启动 / 无标签页走 `assertCurrentTabAvailable`，未知 tab 走 `assertTabExists`，ref 不存在 / 已失效走 `assertRefBelongsToTab` / `assertRefRevalidated`，坐标越界走 `assertPointInViewport`；本项不新增不变量。
- 双击 / 三击：`dblclick` 在第二组点击完成时派发一次；三击是否选中整行由页面与浏览器决定，工具只保证事件序列与 `detail` 编号。
- 右键：页面 `contextmenu` 处理器会触发；浏览器原生右键菜单是否弹出取决于模式与浏览器，工具不负责关闭，菜单可能遮挡后续输入，建议随后点击页面空白处。
- 中键：页面 `mousedown` / `auxclick` 会触发；「在新标签页打开链接」是浏览器行为，isolated 下新页不在本工具的标签页注册表里，cdp 下会操作用户真实浏览器。验证链接行为优先用左键配页面事件。
- 元素不可见或被遮挡：ref / selector 路径沿用 actionability，超时 10000ms 抛 Playwright 原文错误；不提供 `force`，不绕过检查；坐标路径不校验命中。
- 按住期间切换焦点或标签页：keyup 落到当时的焦点元素；跨 tab 不自动释放。页面在按住期间自行导航时 Playwright 的修饰键状态保留，工具感知不到，需显式 `action=up`。
- `modifiers` 在 scrollIntoView 与 actionability 期间就已按住，极少数依赖 hover 状态选择器的页面可能因此在动作前改变命中；需要严格先定位后按键时，拆成 `press action=down` + 不带 `modifiers` 的 `click` + `press action=up`。
- frame：`click` 的 `ref` / `selector` 仍限主文档（iframe 内元素操作属 P1-9，待决策）；`press` 发往页面当前焦点，焦点在 iframe 内时按键照样生效，不需要 frame 参数。
- 超时：selector 等可见 5000ms、点击 10000ms，均不暴露参数；`press` 无超时；`repeat` 最多 100 次不设总时间预算，期间页面导航会由 Playwright 报执行上下文销毁。
- 明确不做：鼠标按下 / 抬起跨调用（长按鼠标）、三击以上、触屏手势、拖拽（已有 `browser_e2e_drag`）、系统级快捷键、自动释放计时、真实 IME。

## 验收

1. `node tests/click-press.mjs`：exit 0、无 FAIL。以下 check 标签由本功能新增（规格确认时尚未存在，由 tester 落地后按此文案断言）：
   - click：`clickCount 缺省为 1 且事件序列与旧版一致`、`双击产生 detail 1/2 与一次 dblclick`、`三击产生三组按下抬起`、`右键触发 contextmenu 且不派发左键 click`、`中键触发 auxclick`、`modifiers 让 click 事件 shiftKey 为 true`、`坐标路径 modifiers 同样生效`、`显式 modifiers 点击后释放且不残留`、`按住 Shift 后 click 自动带 shiftKey`、`按住的键在 navigate 前被释放`、`按住状态按 tab 隔离`、`clickCount / button / modifiers 非法时报错且未产生鼠标事件`。
   - press：`press 缺省单次且摘要不变`、`repeat=3 产生三组 keydown / keyup`、`action=down 只发 keydown 不发 keyup`、`action=up 释放并产生 keyup`、`down / up 跨调用按住 Shift 并影响随后的 click`、`up 未按住的键仍发 keyup 且 held 为 false`、`action / repeat / 组合键 down 的非法输入报错且未产生按键事件`。
2. `node tests/tools.mjs`：exit 0、无 FAIL。现有 `ref 点击生效`、`selector 点击生效`、`坐标点击生效（真实鼠标事件）`、`三种目标都不给时报错` 不回归；用例 10 追加 `click 参数含 clickCount / button / modifiers` 与 `press 参数含 action / repeat`。
3. `node tests/panel.mjs`：exit 0、无 FAIL（`注册的工具与工具表逐项一致（顺序与名字）`、`作用于页面的工具都接受 tab_id` 已含 click / press，参数扩展不破坏既有断言）。
4. `node tests/multitab.mjs` 与 `node tests/cdp.mjs`：exit 0、无 FAIL；cdp 追加 `CDP 接管下双击与右键事件生效`、`CDP 接管下按住 Shift 点击生效`。
5. `npm run test:unit`：exit 0、无 FAIL。
6. `npm run test:integration`：exit 0、无 FAIL，且脚本包含 `node tests/click-press.mjs`。
