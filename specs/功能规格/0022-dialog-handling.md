# 对话框处理

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（「三层与被切分的文件」模块表里 `lib/page.js` 的职责、「进程内对象契约 · 标签页条目」字段表、P3 的「运行时」类错误归属）；specs/项目规格/0002-panel-protocol-v1.md（本项不改协议）；specs/功能规格/0005-console-network-ring.md（同属页面观测数据，但对话框记录独立成环）
代码: lib/page.js / lib/observation.js / lib/tools.js / tests/dialog.mjs / tests/cdp.mjs / tests/panel.mjs

## 需求

页面弹出 `alert` / `confirm` / `prompt` 时，我方既读不到文案、也选不了应答：Playwright 在没有 `dialog` 监听器时一律自动 dismiss，`confirm()` 永远返回 `false`、`prompt()` 永远返回 `null`，因此验证不了「确认框里的文字对不对」，也走不了「点确定」分支。本项在页面事件环里记录每个对话框的类型、文案、prompt 默认值与实际应答，并允许按标签页设置后续对话框的应答策略。

## 行为

### 工具与参数

唯一入口是新工具 `browser_e2e_dialog`。不给 click / fill / press / navigate 加对话框参数：对话框是页面级事件、与元素定位无关，给多个工具各加一个策略参数属于多工具联动，且一次只能覆盖「这一下动作」。

| 参数 | 类型 | 必填 | 区间 / 枚举 | 默认 | 说明 |
|---|---|---|---|---|---|
| `policy` | string | 否 | `dismiss` \| `accept` | 不传表示只读 | 设置该标签页后续对话框的应答策略；`accept` 时 `prompt` 用 `prompt_text`（没给就用页面默认值） |
| `prompt_text` | string | 否 | 0..1000 字符 | 未给表示用页面默认值 | 只在 `policy: "accept"` 时允许出现；与 `policy: "dismiss"`、以及单独给 `prompt_text`（没有 `policy`）都互斥 |
| `limit` | integer | 否 | 非正整数回退 20；超过 50 按 50 | 20 | 读取尾部条数，最新在最后 |
| `tab_id` | string | 否 | — | active tab | 与其它页面工具一致，缺省作用于当前 active tab |

- 根 schema：`params({...})`，`required: []`，`additionalProperties: false`；四个参数都可省略（`{}` 合法，等价于读当前 active tab 的记录）。

### 应答时机与作用域

- 每个标签页在 `attachPageHooks` 里注册一次 `page.on('dialog')`；事件到达时**立即**按当时策略应答，不等下一次工具调用。不存在「对话框挂起、稍后再答」的状态。
- 策略按标签页独立，存在标签页条目的 `dialogPolicy` / `dialogPromptText` 上；新建 / 接管 / 新开的标签页都从 `dismiss` 开始。
- 策略只对设置之后打开的对话框生效；正在应答中的对话框不受后续设置影响。
- `beforeunload` 一律 accept，与策略无关（与 Playwright 无监听器时的内部默认 `Dialog._close()` 一致，避免改变离开页面时的导航语义）；仍写一条记录。

### 记录

- 每个对话框写一条到该标签页的 `dialogRing`，上限 50 条，超出从头淘汰（复用 `pushRing`）。
- 字段：`at`（ISO 串）、`type`（`alert` / `confirm` / `prompt` / `beforeunload`，由 `dialog.type()` 原样透传）、`message`（截断到 2000 字符，超出追加 `...(已截断)`）、`defaultValue`（prompt 的页面默认值，其它类型为空串）、`accepted`（布尔，实际应答）、`error`（应答失败时的错误文本，成功为空串）。

### 返回形状

- 只读：`{ tabId, policy, promptText, total, count, entries, text, summary }`。
  - `promptText` 未设置时为 `null`，设置为字符串（可为空串）。
  - `summary`：`对话框记录 ${count} 条（策略 ${policy}）`；`promptText` 非 null 时追加 `，prompt 文本 "${promptText}"`。
  - `text` 每行：`${HH:MM:SS.mmm} ${type} ${已接受|已取消} ${message}`；`type` 为 prompt 时追加 `（默认值：${defaultValue}）`；`error` 非空时追加 `（应答失败：${error}）`。空记录为 `（暂无对话框记录）`。文本块整体上限 20000 字符，超出截断并追加 `...(已截断)`。
- 设置策略：`{ tabId, policy, promptText, summary }`；`summary` 为 `对话框策略已设为 dismiss（自动取消）`，accept 且未给文本时为 `对话框策略已设为 accept（自动确认，prompt 用页面默认值）`，accept 且给了文本时追加 `，prompt 文本 "${promptText}"`。
- 工具返回文本：设了策略时为「设置摘要 + 读取摘要 + 文本块」，只读时为「读取摘要 + 文本块」。

### 错误文案（逐字）

- `policy 只支持 dismiss（取消）或 accept（确认），收到 ${JSON.stringify(policy)}`
- `prompt_text 只在 policy=accept 时生效；要输入 prompt 文本请同时传 policy: "accept"`
- `prompt_text 必须是字符串（可传空串表示输入空值），收到 ${typeof promptText}`
- `prompt_text 最多 1000 个字符，收到 ${promptText.length} 个`
- `浏览器尚未启动，请先调用 browser_e2e_start`（工具用 `requireSession`，与 console / network 同一入口，未启动时不留下 idle 会话条目）
- `浏览器尚未启动或没有可用标签页，请先 browser_e2e_start`（`assertCurrentTabAvailable`）
- `tab ${tabId} 不存在，请先 browser_e2e_tabs 获取最新 tab_id`（`assertTabExists`）

### 状态变化

- 会话 / 浏览器进程：不变。
- 标签页：只读写 `dialogPolicy` / `dialogPromptText` / `dialogRing`；`refs`、快照基线、`consoleRing` / `networkRing` 都不动。
- 导航：`browser_e2e_navigate` 在导航前清空该标签页的 `dialogRing`，与 `refs` / 快照基线 / 事件环的清空口径一致；`dialogPolicy` / `dialogPromptText` 保留。
- 页面：对话框被应答后页面 JS 继续执行；不导航、不重载、不重建 ref。
- 面板：每次工具调用产生一条既有 `action` 摘要（`lib/index.js` 的 `execute` 包装），无新命令 / 事件 / 错误码；面板仍是只读视图。

## 边界

- 记录写入发生在页面事件回调里，可能比触发它的工具调用返回晚几毫秒；连续调用读不到时再读一次（或轮询 `total`），这不是错误。
- 明确不做「先挂起、看到文案再决定」：那需要所有页面工具都能容忍被对话框阻塞，而 `browser_e2e_evaluate` 目前没有超时；因此同一轮里无法「先读文案、再按文案决定接受 / 取消」。要验证文案用默认 `dismiss`（记录照写）；要走确认分支就先设 `accept` 再触发。
- accept 的语义由浏览器决定：`confirm` → `true`，`prompt` → `prompt_text` 或页面默认值，`alert` 无返回值；dismiss 的语义：`confirm` → `false`，`prompt` → `null`，`alert` 直接关闭。
- 不处理浏览器自身弹出的对话框：HTTP 认证、权限请求、`window.print()`、`window.open` 窗口。
- 策略与记录都按标签页隔离，不做跨标签页 / 会话级全局策略，也不做 iframe 单独策略（整个页面一套）。
- 不把对话框记录写进控制台环或网络环，不新增面板事件，不新增 `lib/invariants.js` 断言（入参错误与应答失败都不代表跨调用状态损坏）。
- 应答失败（例如对话框在应答前已被浏览器关闭）只写入该条记录的 `error`，工具本身不报错、不重试；页面若因此停在阻塞态，用 `browser_e2e_close` 收尾。
- CDP 接管模式下应答的是用户真实浏览器里的对话框：默认 `dismiss` 与 Playwright 无监听器时的行为一致；设了 `accept` 就等同替用户点了确定，属于调用方显式选择。

## 验收

1. `node tests/dialog.mjs`：exit 0、无 FAIL；结束时 `msedge` 主进程回落到运行前基线。用例名（`check` 的 label）：
   - `默认策略为 dismiss 且无对话时返回空记录`
   - `默认策略下 confirm 被取消、页面走取消分支并记录文案`
   - `policy=accept 时 confirm 被确认、页面走确认分支`
   - `alert 被应答后页面脚本继续执行且记录 type=alert`
   - `prompt 默认取消返回 null 并记录默认值`
   - `prompt accept 未给 prompt_text 时使用页面默认值`
   - `prompt accept 给了 prompt_text 时用该文本、记录仍保留默认值`
   - `prompt_text 与 policy=dismiss 或缺失 policy 时报错`
   - `policy 非法值报错并给出取值指引`
   - `prompt_text 非字符串 / 超长分别报错`
   - `对话框记录环形上限 50 条，超出淘汰最旧`
   - `limit 取尾部、非正整数回退默认、超过 50 按 50`
   - `策略与记录按 tab_id 隔离，新标签页从 dismiss 开始`
   - `未知 tab_id 报错`
   - `未启动时工具报「浏览器尚未启动」`
   - `工具声明 policy 枚举与 limit / prompt_text / tab_id 参数`
2. `node tests/cdp.mjs`：exit 0、无 FAIL，含用例 `CDP 接管下 confirm 被策略应答并记录`（接管真实 Edge 后设 `accept`，触发 confirm 能读到记录、页面走确认分支）。
3. `node tests/panel.mjs`：exit 0、无 FAIL（工具表逐项注册、参数 schema 合法两条用例自动覆盖新工具）。
4. `npm run test:unit`：exit 0、无 FAIL（本项不改协议与不变量，作回归）。
5. 全量回归 `npm run test:integration`（真起无头 Edge、串行）exit 0、无 FAIL；该聚合脚本当前包含 `tests/download.mjs`（既有工作树状态），提交前以当时 `package.json` 的脚本为准。
6. `git diff --stat` 只含本项显式路径：`lib/page.js`、`lib/tools.js`、`README.md`、`specs/项目规格/0001-architecture-invariants.md`、`specs/功能规格/0022-dialog-handling.md`、`tests/dialog.mjs`、`tests/cdp.mjs`、`tests/panel.mjs`；不含 `.scratch/`。
