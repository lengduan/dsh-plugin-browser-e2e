# 网页标签 / 选中文本注入对话

状态: 已否决（2026-11-08，整项不立项）
关联: specs/项目规格/0001-architecture-invariants.md（模块表、依赖方向、面板只读定位、`invariants.js` 边界）；specs/项目规格/0002-panel-protocol-v1.md（路由表、面板只读边界、命令 / 事件表本项不变）；specs/项目规格/0003-未处理项.md（本项由 Lead 录入）；specs/功能规格/0001-client-entry-activation-failure.md（客户端 `inject` 仅有 `slots` / `sidebarRightTabs`、注册面固定为面板座位）；specs/功能规格/0002-browser-launch-and-reuse.md（`headless` 默认 `true` 的载体语义）；specs/功能规格/0006-plugin-config-and-live-apply.md（本项不改 Config）；specs/功能规格/0009-auth-topup.md（本项不导航，不触发补票）；README.md「右侧实时浏览器面板」「面板协议与路由」「Model Experience」「Known Limitations and Deferred Work」
代码: 决策通过后预计 `lib/mention.js`（新建）/ `lib/protocol.js` / `lib/index.js` / `client/index.js` / `lib/client.js`（构建产物）/ `scripts/protocol-inject.mjs` / `tests/mention.mjs`（新建）/ `tests/client-bundle.mjs` / `tests/invariants.mjs` / `tests/panel.mjs` / `README.md`

> 2026-11-08 决策：**整项否决、不立项**。理由：①「选中文本」半在现有载体下不可实现——隔离模式默认无头（`lib/session.js` 的 `launch`），面板把页面转成 JPEG 帧、没有文字层，插件也不是浏览器扩展、没有内容脚本监听 `selectionchange`，要做只能先改载体；②「网页标签」半的宿主能力已实证可用（本机宿主 asar 的 `dsh/node_modules/@deepseek-ai/dsh-client-ui-input-trigger@0.2.2-rc.1` 提供 `ctx.inputTriggers` 服务与 `registerSource(src)`，`(trigger, name)` 唯一、返回 disposer），但它要反转已实现的 `0001-client-entry-activation-failure` 的「inject 只有 `slots` / `sidebarRightTabs` 两个服务」并改 `tests/client-bundle.mjs` 的两条断言，同时把页面作者可控的正文注入用户消息（prompt injection 面），收益（省一次复制 URL）不抵这两项代价。
> 下文「行为 / 验收」保留为方案 A2 的原始草案，仅作历史记录，不得据此实施。

取证基线：HEAD `b1a092d`，工具表 22 个（`lib/tools.js` 的 `buildToolTable`），客户端注入面见 `package.json` 的 `dsh.client.inject` 与 `tests/client-bundle.mjs` 的 `模块导出 apply 与 inject`。取证后 P1-11 提交 `94cddf3` 只动 `README.md` / `package.json` 的测试脚本行 / `tests/` / `0020-session-reset.md`，未触及 `lib/`、`client/` 与本项引用的规格，上述事实仍成立。

## 需求

用户想指着「我正在被 agent 驱动的这个页面」提问时，现在只能手动把 URL（或正文）复制进输入框：面板只是 JPEG 画面，地址栏只读，模型也拿不到用户指的是哪一页。本功能在输入框加一个 `@` 源「网页标签」，选中一个标签页后，发送时把该页的标题、URL 与正文以 `<browser-tab>` 块交给模型，省掉手抄一步。收益：用户以「指」代替「描述」，模型拿到的正文带明确来源与边界标记。

「选中文本注入」一半在现有载体下不可实现：隔离模式默认 `headless: true`（`lib/session.js` 的 `launch`），用户看不到浏览器窗口；面板又把页面转成 JPEG（`client/index.js` 的帧渲染），没有任何可划选的文字层；插件也不是浏览器扩展，没有内容脚本可监听 `selectionchange`。该半见「边界」与计划 §6.3，随载体决策另议。

## 行为

### 输入

一、`@` 候选（客户端输入源，`client/index.js`）

| 项 | 值 |
|---|---|
| `trigger` | `@` |
| `name` | `网页标签`（同时是 @ 菜单分组标题与 chip 的 source 标识） |
| `order` | `10`（排在宿主自带「文件与文件夹 / 对话」之后） |
| 数据源 | `GET /api/dsh-browser-e2e/mention/tabs?session=<会话id>`，客户端 2 秒 TTL 合并同一次菜单展开的并发请求 |
| 过滤 | 只列该会话的标签页；URL 必须是 `http:` / `https:`，排除 `about:blank`、`chrome://`、`chrome-extension://`、`file://`；`query` 对标题与 URL 做大小写不敏感包含匹配 |
| 上限 | 50 条（菜单自身可滚动；`query` 作用在服务端返回的全量清单上） |
| 候选形状 | `{name, description, icon:'file', hint:'浏览器'}`；`name` 是标题（空则 URL，再空则 `tab`，截 60 字），同标题追加 ` ·2`、` ·3` 消歧；`description` 是 URL |
| 选中 | `onPick` 返回 `{insert:{source:'网页标签', ref:'{"tabId","url","title"}', label:标题, clipboardText:'@标题'}}` |

二、发送时提取（客户端 `codec.serialize` → 宿主路由）

- `POST /api/dsh-browser-e2e/mention/extract`，请求体 `{ "tabId": "<会话key#tN>" }`，体积上限 16 KiB。
- 宿主按 `panelTabId` 解析出目标页（`lib/session.js` 的 `panelPage`），读取标题与正文；正文取 `article, main, [role="main"]` 或 `body` 的 `innerText`，求值超时 5000ms。
- 正文归一：`\r\n?` → `\n`；水平空白串压成单空格；行首行尾空白去掉；连续空行压到最多一空行；`trim`。
- 正文按 20000 字符截断，超出置 `truncated: true`。
- 返回 `{ url, title, text, truncated, block }`：`text` 是归一后的纯正文（测试与排查用），`block` 是宿主办好转义与截断标记的最终文本块（见「输出」），客户端原样使用、不再二次拼装，保证格式化规则只有一份实现。

三、`@` 候选路由

`GET /api/dsh-browser-e2e/mention/tabs?session=<会话id>`

- 200：`{ tabs: [{ id, url, title }] }`；没有可提及的页时 `tabs: []`，不报错。
- 400：缺 `session` 参数（`{ error: 'session is required' }`）。
- 405：非 GET；403：非 loopback 或跨站（复用 `lib/fence.js` 的 `isLoopbackRequest`）。
- 只读：绝不启动浏览器、不建会话、不刷新空闲计时；实现复用 `lib/session.js` 的 `listPanelTabs()` 后按 `sessionId` 过滤。

### 输出

`serialize` 返回的文本块（属性做 XML 转义，`&` → `&amp;`、`"` → `&quot;`、`<` → `&lt;`）：

```
<browser-tab url="https://example.test/form" title="订单提交页">
页面上可见正文……
</browser-tab>
```

- 截断时在正文末尾追加一行 `[content truncated]`。
- 正文中出现的 `</browser-tab`（大小写不敏感）转义为 `<\/browser-tab`，避免页面正文提前闭合边界块。
- 这是用户消息的一部分，不是系统提示，也不是工具结果；`<browser-tab>` 只是数据边界标记，页面作者的文案仍可能诱导模型，README 需写明「按不可信数据处理」。

### 失败形态

| 场景 | 行为 |
|---|---|
| 提取路由 4xx/5xx | `serialize` 抛错，**阻断发送**，输入框保留草稿与 chip（语义：显式失败优于静默降级） |
| 标签页已关闭 / 不存在 | `404 {error:'标签页已关闭，请重新选择'}` → 客户端抛 `引用标签页失败：标签页已关闭，请重新选择` |
| 非 http(s) 页面 | `400 {error:'只能引用 http(s) 页面'}` |
| 正文求值超时 | 5000ms 内返回 500 `{error:'读取页面正文超时（5000ms）'}`；页面脚本本身不可中断（与快照同限制） |
| 缺 `session` / 方法不对 / 非 loopback | 400 / 405 / 403，客户端 `candidates` 吞成空列表（@ 菜单不因路由错误炸掉） |
| 宿主缺 `inputTriggers` 服务 | 客户端跳过注册并 `console.warn`，@ 菜单没有「网页标签」分组，面板与工具不受影响 |
| 宿主缺 `webServer`（CLI） | 两条路由不挂；没有 GUI 也就没有 composer，工具照常可用 |

### 状态变化

- 会话：不变（不创建会话条目、不改 `state` / `pages` / `activeTabId`、**不刷新空闲计时**）。
- 标签页：不变（不导航、不点击、不写 ref 表与事件环、不写快照基线）。
- 面板：不变（不新增命令 / 事件 / 错误码；面板仍是只读画面，`@` 源与面板无数据往来）。
- 浏览器进程：不启动、不接管、不关闭；隔离模式没有浏览器时 `tabs: []`。
- 协议表：只在 `lib/protocol.js` 增加两条路由路径常量；`PANEL_COMMANDS` / `PANEL_EVENTS` / `PANEL_ERROR_CODES` 不变。
- 客户端：`package.json` 的 `dsh.client.inject` 增加一个宿主包（`@deepseek-ai/dsh-client-ui-input-trigger`），客户端模块导出的 `inject` 由 `["slots","sidebarRightTabs"]` 变为三个服务；`apply` 多注册一个输入源；两个面板座位不变。

## 边界

- **载体**：隔离模式默认无头（`lib/session.js` 的 `launch` 里 `headless = options.headless ?? true`），页面只经面板的 JPEG 帧呈现，没有可选文本；`headless: false` 或 `cdp` 模式下用户能在真实窗口里划选，但插件没有内容脚本可观测选区。**「选中文本注入」不在本规格范围内**，候选方案见 `.scratch/browser-plugin-survey/plans/23-tab-mention-injection.md` §6.3，随 P2-25（多载体）/ P2-24（跟随当前标签页）一起决策。
- **不提重取副本**：只读已经登记在会话里的那个页面；不像竞品那样为「用户标签页」新开一页重取 URL。因此拿不到登录态副本以外的新鲜内容，也不会新开标签页或触发导航补票（`0009-auth-topup.md` 只覆盖导航挑战，本项不导航）。
- **CDP 模式**：被接管的页面就是用户浏览器的真实页面，提取到的是其当前正文（含用户隐私）；路由只接受 loopback + 同源，且只在用户主动打开 `@` 菜单并选中时被调用，不做后台轮询。
- **大页面**：20000 字符截断；不返回 HTML、不返回图片、不解析 PDF；`innerText` 不含隐藏元素与伪元素。
- **求值超时不可中断**：5000ms 超时只让本次请求失败，页面脚本可能继续跑（与 `browser_e2e_snapshot` 的已知限制同性质）。
- **竞态**：提取期间页面被关闭 → 404；提取期间导航 → 以当时文档的正文为准（不重试）。
- **并发**：方案 A2 无 token 暂存、无跨调用状态；同一会话连续两次 `@` 互不影响。方案 A1（token + `agent/pre-step`）才有暂存表与 10 分钟 TTL，本规格不采用。
- **不做**：标签组提及；多选；图片 / 附件；把提取结果写回面板或工具结果；向模型注入系统提示或常驻上下文；`@` 源出现在非 Web 宿主（CLI / headless）。
- **依赖已注册的页**：只提及 `listPanelTabs()` 能看到的页（本插件会话的页）。用户自己浏览器里未被接管的标签页不在候选内；要覆盖它得先有扩展或载体改造（P2-25）。

## 验收

1. `node tests/mention.mjs` 退出码 0 且输出无 `FAIL`（该文件由 tester 新建，全部用假 chromium / 假页面，不启动浏览器）：
   - 候选：`mention 候选只列本会话的页`、`mention 候选只收 http(s) 并排除 about:blank`、`mention 候选按标题与 URL 过滤且不区分大小写`、`mention 候选上限 50 条`、`mention 候选不启动浏览器也不创建会话`。
   - 提取：`mention 提取返回标题 URL 与正文`、`mention 提取按 20000 字符截断并标记 truncated`、`mention 提取把正文里的闭合标签转义`、`mention 提取时页面已关闭返回 404`、`mention 提取非 http(s) 页面返回 400`、`mention 提取超时在 5000ms 内返回错误`、`mention 提取不刷新空闲计时`。
   - 路由：`mention 路由非 loopback 返回 403`、`mention 路由方法不对返回 405`、`mention 请求体非法 JSON 返回 400`、`mention 路由缺 session 参数返回 400`。
2. `node tests/client-bundle.mjs` 退出码 0：新增 `客户端 inject 含 inputTriggers`、`@ 源注册 trigger 与 order`、`@ 候选按 query 过滤且最多 50`、`serialize 成功返回 browser-tab 块`、`serialize 失败抛错不静默降级`、`卸载时释放 @ 源`；既有 `apply 只向面板两个 slot 注入回调（设置页与插件卡片座位已移除）`、`座位注册：面板两个 slot 同 key 不同组件` 仍通过。
3. `node scripts/build-client.mjs` 退出码 0 后 `node tests/invariants.mjs` 退出码 0：`源码 ↔ 产物一致：injectProtocol(readSource()) 即 lib/client.js 全文`、`协议版本与路径`、`生成的 bundle 常量与 protocol.js 逐字段一致` 与新增 `mention 路由常量与注入块一致` 通过；`命令表与事件表是协议的唯一来源`、`错误码表是 error.code 的唯一来源，isPanelErrorCode 只认表内 code` 的既有逐项断言不变。
4. `node tests/panel.mjs` 退出码 0：`工具表共 22 个`（本项不加工具）、`面板状态路由已注册`、新增 `面板 mention 路由已注册`、`未知命令 kind 回 invalid-command 错误事件`（命令表不变）通过。
5. `npm run test:unit` 与 `npm run test:integration` 各退出码 0（集成测试串行，真起无头 Edge）。
6. 手工 GUI 冒烟（真机）：模型先用 `browser_e2e_start` + `browser_e2e_navigate` 打开一页；用户在输入框敲 `@` 出现「网页标签」分组并列出该页；选中后发送，消息气泡包含 `<browser-tab url=… title=…>` 块且模型能复述正文要点；关闭该标签页后再选同一条候选发送，发送被阻断、输入框草稿与 chip 保留。
