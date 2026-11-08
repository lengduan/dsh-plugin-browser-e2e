# 剪贴板写入与粘贴投递

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/page.js` 职责与「明确不含」、隐式接口「能力函数返回值被 `tools.js` 各工具 `run` 读的字段」、P3「跨调用 / 单次 / 运行时」的 throw 分类）；specs/项目规格/0002-panel-protocol-v1.md（面板只读、工具行为只由 `browser_e2e_*` 发起、`action` 事件取摘要首行）；specs/功能规格/0007-click-fill-targets.md（ref 复验与「ref / selector 二选一」文案同源）；specs/功能规格/0010-upload-file.md（主 frame 限制、isolated / cdp 差异的写法）；specs/功能规格/0014-type-keystrokes.md（后台标签页 `document.hasFocus()` 与按键路径的边界口径）
代码: lib/page.js / lib/tools.js / tests/clipboard.mjs

## 需求

富文本编辑器、画布类应用与「只处理 paste 事件」的自研组件，真人录入走的是浏览器粘贴路径；`browser_e2e_fill` 只做赋值或逐键输入，覆盖不到 paste 处理器，`browser_e2e_evaluate` 里手写 DataTransfer 又要重复页内脚本与净化逻辑。本规格固定 `browser_e2e_clipboard` 的两个动作：`write` 把文本与可选富文本 HTML 写进浏览器剪贴板，`paste` 把带 `text/plain` / `text/html` 两种口味的粘贴事件投递到指定元素（缺省当前焦点元素），让「复制按钮 → 剪贴板」与「剪贴板 → 富文本编辑器」两条链路都可端到端验证。本规格的「读」指页面通过 paste 事件读取本次投递的内容，不提供把系统剪贴板内容读回工具结果的动作（理由见「边界」）。

## 行为

### 工具与参数

- 工具名 `browser_e2e_clipboard`，定义在 `lib/tools.js` 的 `buildToolTable`；能力实现在 `lib/page.js` 的导出 `clipboard(session, options, tabId)`。
- `action`：必填，枚举 `write` | `paste`。其它值在能力函数入口报 `action 只支持 write / paste，收到 <JSON.stringify>`。
- `text`：字符串，可选。`write` 时 `text` 为空且没给 `html` → `action=write 需要 text 或 html 至少一个非空值；例如 text: "hello" 或 html: "<b>hi</b>"`；`paste` 时必须是长度大于 0 的字符串，否则报 `action=paste 需要非空 text（页面没有可消费的纯文本口味）`。非字符串（boolean / number / null）报 `text 必须是字符串，收到 <JSON.stringify>`。
- `html`：字符串，可选；空串按未给处理（与 `text` 的空串口径一致）。非字符串报 `html 必须是字符串，收到 <JSON.stringify>`。
- `sanitize`：布尔，缺省 `true`；只影响带 `html` 的调用（`write` 与 `paste` 都生效）。`sanitize: false` 只在 isolated 模式允许；cdp 模式报 `sanitize=false 只在 isolated 模式可用：cdp 接管的是用户真实浏览器，不能把未过滤的 HTML 交给页面；请改用 sanitize=true 或 isolated 模式`。
- `ref` / `selector`：粘贴目标，二选一；`paste` 时都可以不给（用当前焦点元素）。两个同时给报 `粘贴目标只能给一种：ref / selector 二选一（都不给时用当前焦点元素）`。`write` 时任意一个出现即报 `action=write 不作用页面元素：请去掉 ref / selector（写剪贴板不需要目标）`。
- 不提供 `x` + `y` 目标：坐标不能可靠判定「粘贴到哪个可编辑元素」。
- `tab_id`：可选，缺省当前 active tab；`write` 也用这个页面作为执行剪贴板 API 的上下文（不是目标元素）。
- 载荷上限：`text` 超过 `CLIPBOARD_TEXT_LIMIT`（100000 字符）报 `一次最多投递 100000 个字符（收到 N 个）；请拆分内容后分多次操作`；`html` 超过 `CLIPBOARD_HTML_LIMIT`（200000 字符）报 `一次最多投递 200000 个 HTML 字符（收到 N 个）；请裁剪 HTML 或改用 text`。长度按 UTF-16 码元计（`String.prototype.length`）。

### 目标解析

- 入口先 `currentTab(session, tabId)`：未启动 / 0 页沿用 `assertCurrentTabAvailable`，`tab_id` 不存在沿用 `assertTabExists` 的文案。
- `ref`：`assertRefBelongsToTab` 取条目 → `revalidateRef` 复验（xpath 仍命中且有正尺寸）→ `page.locator('xpath=' + item.xpath)`；失效文案沿用 `assertRefRevalidated` 的两条。
- `selector`：`page.locator(selector)` → `waitFor({ state: 'attached', timeout: 5000 })`；超时报 `选择器 "<s>" 在 5000ms 内没有匹配到元素；请先用 browser_e2e_snapshot 确认粘贴目标的选择器`。不要求可见：`contenteditable` 容器常被父级裁剪或在可滚动区域外，attached 即可投递。
- 都不给：页内取 `document.activeElement`；`null`、`body`、`html` 都算没有焦点元素 → `当前没有可粘贴的焦点元素（activeElement 是 <tag>）；请给 ref 或 selector，或先 browser_e2e_click 聚焦目标`。

### 粘贴投递（action=paste）

- 页内脚本对一个元素执行：`el.focus?.()` → 组装 `DataTransfer`：`setData('text/plain', text)`，`html` 给了就 `setData('text/html', sanitize ? 净化结果 : html)` → `new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })` → `el.dispatchEvent(event)`。
- 若构造 `ClipboardEvent` 时 Chromium 没有接受 `clipboardData`（`event.clipboardData === null`），退路是用 `Object.defineProperty(event, 'clipboardData', { value: dt })` 覆盖实例属性后重发；两者都失败报 `当前页面无法构造带数据的 paste 事件（ClipboardEvent.clipboardData 不可写）；请改用 browser_e2e_evaluate 自建事件，或升级 Edge`。
- `accepted` = 页面调用了 `preventDefault()`（`dispatchEvent` 返回 `false`）。
- 未消费兜底：目标本身是 `HTMLInputElement`（type 不是 `file` / `checkbox` / `radio` 之外的文本类不限）或 `HTMLTextAreaElement`，且 `accepted === false` 时，用原生 value setter 在 `selectionStart..selectionEnd` 处插入 `text` 并派发 `input` 事件（`new Event('input', { bubbles: true })`），返回 `inserted: true`。只插入 `text`，不插入 HTML；`inserted` 与 `accepted` 可以同时为 `false`（页面既不处理 paste 也不可写值）。
- 不做页面等待：与 `click` / `fill` 一致，投递后立即返回，不等防抖与渲染；需要等页面反应时由调用方接 `browser_e2e_wait`。
- 未消费不是失败：返回 `accepted: false`，摘要注明「页面没有消费 paste 事件」，由调用方判断该页面是否本就不支持粘贴。

### HTML 净化

- `sanitize: true`（缺省）时，页内脚本用 `DOMParser` 解析后按下列规则清理，再把 `body.innerHTML` 交给 `DataTransfer`：
  - 整元素移除：`script`、`style`、`iframe`、`frame`、`frameset`、`object`、`embed`、`form`、`input`、`button`、`select`、`textarea`、`template`、`noscript`、`meta`、`link`、`base`、`svg`、`math`。
  - 属性移除：名字以 `on` 开头的全部属性；`srcdoc`、`formaction`、`action`；`href` / `src` / `xlink:href` 的值形如 `javascript:` / `data:` / `vbscript:`（忽略前导空白与大小写）。
  - 保留 `style` 属性与常规排版标签（`p` / `div` / `span` / 列表 / 表格 / 标题 / `a[href]` / `pre` / `code` / `blockquote` 等），不重写 URL 协议白名单以外的普通 http(s) 链接。
- 净化只保证「不把可执行元素与事件属性交给页面」，不是完整 XSS 过滤器；需要原样投递（例如验证被测应用自己的净化逻辑）时用 `sanitize: false`（仅 isolated 模式）。

### 剪贴板写入（action=write）

- 页内脚本先探测 `window.isSecureContext === true` 且 `navigator.clipboard.write` 是函数；不满足返回 `insecure-context`，宿主报 `当前页面不是安全上下文（<origin>），浏览器不提供剪贴板写入 API；请改用 action=paste（合成粘贴事件不依赖安全上下文），或在 https / localhost 页面重试`。
- isolated 模式：每次 `action=write` 写入前都对该页面所属浏览器上下文重新授予 `clipboard-write`（`context.grantPermissions(['clipboard-write'])`）。不缓存「已授予」，因为 `grantPermissions` 是整表授予：此前若授予过 `clipboard-read`，只授一次会被覆盖，之后的写入会失败。；cdp 模式**不授权**，写入被拒绝时报 `页面拒绝写剪贴板（NotAllowedError）：<原始 message>；cdp 模式不会自动改你的浏览器权限，请在该站点手动允许写剪贴板，或改用 action=paste`。
- 写入内容：`ClipboardItem` 同时带 `text/plain`（`text`）与 `text/html`（`html` 给了才带）；`text` 为空而 `html` 非空时，纯文本口味由净化后的 HTML 的 `innerText` 推导，并在返回值里标 `plainDerived: true`。
- 写入失败（`NotAllowedError` / `DataError` / `TypeError` 等）由宿主包一层中文前缀后原样抛出原始 message；不同步、不重试、不清空剪贴板。
- 返回 `{ action: 'write', tabId, rich, plainChars, htmlChars, plainDerived, summary }`。摘要三种形态：
  - `写入剪贴板：纯文本 <n> 个字符`
  - `写入剪贴板：富文本 HTML（<m> 字符）+ 纯文本 <n> 个字符`
  - `写入剪贴板：富文本 HTML（<m> 字符），纯文本由 HTML 推导（<n> 个字符）`

### 返回与状态

- 能力函数返回：
  - `paste`：`{ action: 'paste', tabId, target: { mode: 'ref' | 'selector' | 'focused', ref?, selector?, tag?, name? }, chars, htmlChars, rich, sanitized, accepted, inserted, summary }`（不适用字段省略）。
  - `write`：见上。
- 摘要与错误信息**只出现长度、目标描述与状态，不出现 payload 内容**（页面文本 / 剪贴板内容不进面板动作事件与会话日志）。
- 目标描述与既有摘要同风格：`ref @N (tag "name")`、`selector "<s>"`、`当前焦点元素`。
- 粘贴摘要：`粘贴到 <目标>：<n> 个字符` ＋ 有 HTML 时 `（含 HTML，<m> 字符）` ＋ `；页面已消费 paste 事件` / `；页面没有消费 paste 事件` ＋ `；已在光标处插入文本`（仅兜底生效）。
- 工具返回三行文本：摘要；`目标：<描述>；sanitize=<true|false>；口味：text|text+html`；第三行按动作给指引——`paste` 为 `若页面没有消费该事件，说明它没有 paste 处理器；真实快捷键粘贴可先 action=write 再 browser_e2e_press("Control+V")（不保证投递成功）。`，`write` 为 `isolated 模式会自动授予本会话浏览器上下文 clipboard-write；cdp 模式不授权，被拒绝时请手动允许该站点写剪贴板。`
- 面板：`lib/index.js` 的注册包装用 `summaryOf` 取首行广播 `action` 事件，与其它工具一致；不改 `lib/protocol.js`、`lib/panel.js`、`client/index.js`，不需要重建客户端。
- 会话 / 标签页 / 进程：只改页面内选中状态与剪贴板；不新建页、不改视口、不关闭浏览器、不新增进程，不改会话状态机。
- 不新增 `lib/invariants.js` 断言：剪贴板能力没有跨调用积累的状态；授权是幂等操作，入参校验留在能力函数入口（P3 分类为「单次」）。

## 边界

- 只处理主 frame：`page.locator` 与页内脚本都在主 frame；iframe 内的可编辑元素由 P1-9 单独处理。
- 不提供真实系统快捷键投递（`method=system`）：Playwright 没有系统剪贴板 API，快捷键粘贴依赖页面获得窗口焦点，无头与后台标签页下不可靠，cdp 模式还会改写用户真实剪贴板；`action=write` + `browser_e2e_press("Control+V")` 保留为调用方自行组合的逃生口，本工具不承诺投递成功。
- 不提供剪贴板读回动作（不返回系统剪贴板内容）：读取会被动把用户真实剪贴板内容带进模型上下文（cdp 模式尤其是用户自己的剪贴板），且 `clipboard-read` 授权会改变被测页能力、可能让「复制按钮」用例假通过。验证复制按钮的推荐路径是「点击复制 → action=paste 回填到页面 → 断言页面内容」；测试需要在 isolated 模式自证写入内容时，由测试自己授予 `clipboard-read` 后页内读回。
- 非安全上下文（非 https / 非 localhost / 非 file）没有 `navigator.clipboard`：`write` 报固定错误，`paste` 不受影响。
- 页面 `Permissions-Policy` 禁用 `clipboard-write` 时写入被拒绝，按写入失败报错，不绕过。
- isolated 模式授予 `clipboard-write` 会替换该浏览器上下文此前的权限授予（Playwright 的 `grantPermissions` 底层是 CDP `Browser.grantPermissions` 整表授予）；`write` 与测试自己授予 `clipboard-read` 交替出现时，后一次授予以最后一次为准，调用方需在每次读回前重新授予。
- cdp 模式不自动授权，`write` 多数情况下会被拒绝；`paste` 两种模式走同一条 Playwright 链路，无差异。
- 后台标签页里 `document.hasFocus()` 为 false 的编辑器可能忽略兜底插入；本工具不做 focus emulation（与 `0014-type-keystrokes.md` 同口径）。
- `accepted=false` 是观测结果，不是失败；`inserted=false` 时页面既没有 paste 处理器也没有可写值，调用方应改用 `browser_e2e_fill` 或检查目标是否选错。
- 不支持取消：与其它工具一致不接 `AbortSignal`；页内脚本同步执行，无额外超时（`selector` 的 5000ms 等 attached 是唯一等待）。
- 并发：同一页面并发投递不做互斥，最后落定的一次生效；并发 `write` 以最后完成的一次为准。
- 不校验 `text` / `html` 的语义（例如 HTML 是否是合法片段交给 `DOMParser` 容错），不做长度以外的体积/编码转换。

## 验收

1. `node tests/clipboard.mjs`：exit 0、无 FAIL。用例与 `check` 标签：
   - 用例 1（夹具，`http://127.0.0.1` 本地服务）：`夹具页面加载成功`、`夹具页面是安全上下文`、`contenteditable 目标在 snapshot 里`。
   - 用例 2（缺省焦点目标）：`无目标时投递到当前焦点元素`、`页内 handler 收到 text/plain`、`页内 handler 收到 text/html`、`事件冒泡且可取消`。
   - 用例 3（ref / selector 目标）：`ref 粘贴送达并聚焦目标`、`selector 粘贴送达`、`ref 与 selector 同时给报「只能给一种」`、`selector 5000ms 无匹配时报错`、`失效 ref 报「已失效」`。
   - 用例 4（HTML 净化）：`sanitize 移除 script`、`sanitize 移除 on* 事件属性`、`sanitize 移除 input / button`、`sanitize 移除 javascript: URL`、`sanitize=false（isolated）保留 onerror 属性`。
   - 用例 5（兜底与未消费）：`input 未消费时在光标处插入文本`、`inserted 时触发 input 事件`、`textarea 未消费时插入`、`普通 div 未消费时 accepted=false 且不抛错`、`没有焦点元素时报「没有可粘贴的焦点元素」`。
   - 用例 6（写入）：`write 纯文本可被页内读回`、`write 同时带 text 与 html 时两种口味都在`、`write 只给 html 时 plainDerived=true`、`write 摘要不含 payload 内容`。
   - 用例 7（参数校验）：`action 缺失报错`、`action 非法报错`、`write 同时没有 text 与 html 报错`、`paste 的 text 为空报错`、`text 非字符串报错`、`html 空串视为未给`、`超长 text 报「100000」`、`超长 html 报「200000」`、`write 带 ref 报「不作用页面元素」`、`未启动时报「浏览器尚未启动或没有可用标签页」`、`未知 tab_id 报「不存在」`。
   - 用例 8（工具契约）：`browser_e2e_clipboard 的 action 为必填枚举`、`paste 目标参数含 ref / selector`、`参数含 sanitize 与 tab_id`、`write 不接受 ref 目标`。
   - 收尾：`msedge 主进程回落到运行前基线`。
2. `node tests/panel.mjs`：exit 0、无 FAIL。`注册的工具与工具表逐项一致（顺序与名字）` 通过；`作用于页面的工具都接受 tab_id` 的硬编码名单由测试补入 `clipboard` 后通过。
3. `node tests/tools.mjs`：exit 0、无 FAIL（快照 / 点击 / 填写 / 按键无回归）。
4. `node tests/cdp.mjs`：exit 0、无 FAIL。新增 `CDP 接管下粘贴事件投递生效`、`CDP 接管下 sanitize=false 报错`；找不到 Edge 时按现有 SKIP 口径以 0 退出。cdp 模式下的 `write` 不设失败断言（是否被授权取决于用户浏览器），只覆盖 `sanitize=false` 的拒绝路径。
5. `npm run test:unit` 与 `npm run test:integration`：exit 0、输出无 FAIL；`test:integration` 必须包含 `node tests/clipboard.mjs`。
6. 未验证 / 非目标：非安全上下文（`data:` / 普通 http 站点）的 `write` 错误路径没有夹具；真实 React / Quill / ProseMirror 组件与真实系统快捷键粘贴不在本项验证范围。
