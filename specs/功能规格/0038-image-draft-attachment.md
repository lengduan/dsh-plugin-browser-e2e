# 图片草稿 / 附件回写会话

状态: 待决策
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/capture.js` / `lib/panel.js`、依赖方向、进程内对象契约「能力函数返回值」、不变量边界）；specs/项目规格/0002-panel-protocol-v1.md（路由与版本、命令表、事件表、错误码表、「边界」第 1 条面板只读定位、投屏设置单一来源）；specs/项目规格/0003-未处理项.md（本项由 Lead 录入）；specs/功能规格/0003-screenshot-output.md（截图参数、`screenshot` 返回形状、附件写入与输出契约）；specs/功能规格/0031-tab-mention-injection.md（同属 composer 面，待决策）；specs/功能规格/0032-panel-history-direct-control.md（同属面板只读定位面，待决策）
代码: 现状由 lib/tools.js（`screenshotOutput`、`browser_e2e_screenshot`）、lib/capture.js（`screenshot`）承担；决策通过后预计 lib/protocol.js / lib/panel.js / lib/draft.js（新建）/ lib/index.js / client/index.js / tests/draft.mjs（新建）/ tests/panel.mjs / tests/client-bundle.mjs / tests/invariants.mjs / README.md

> 本项按任务书硬约束 1 判「**影响大 → 待决策**」：草稿是宿主客户端输入区（composer）的状态，本插件没有写入通道；要做只能先让宿主提供草稿 API，或改 `0002` 的命令表并把面板从只读视图扩成输入区写者（与 P2-22 composer 提及、P2-23 面板直控同一决策面）。判定依据、候选与影响面见 `.scratch/browser-plugin-survey/plans/30-image-draft-attachment.md` §1 与 §6。
> 因此状态不写「已确认」：下文「行为 1」是已实现、今天可验收的现状（附件回写会话），「行为 2」是决策通过后才存在的目标契约草案（当前代码未实现），「行为 3」是本项明确不做的事。
> 取证基线：HEAD `94cddf3`（22 个工具）读取实现与规格；取证期间外部会话提交 `72db7c9`（P1-15 剪贴板，工具 22→23），未触及 `lib/capture.js`、本文件引用的 `0002` 与 `0003` 语义。本文件按符号名定位，不写行号。

## 需求

截图取证之后，图片现在只出现在工具结果与对话历史里；人想把它放进自己下一条消息，或让 agent 把刚才那一屏放进输入区，都没有通道，只能自己去产物目录找文件再手动附加。

本项把一个能力拆成两半，分别定契约：

- **附件回写会话**：工具产出的图片作为会话内容块，模型与人都在历史里看到。这一半已有等效能力，本规格只固定其行为，不新增需求。
- **图片草稿**：用户输入区里待发送的图片附件。输入区属于 DSH 宿主客户端，插件侧没有写草稿的通道；这一半是待决策项。

收益：前半保证「截图取证 → 直接看到那张图」这条路不退化；后半决策通过后，人点一下就能把当前画面放进待发送消息，省掉找文件与手动附加。

## 行为

### 行为 1（已实现）：截图附件回写会话

- 输入：`browser_e2e_screenshot` 的 `name` / `fullPage` / `clip` / `format` / `quality` / `scale` / `tab_id`，语义、校验顺序与失败文案见 `0003-screenshot-output.md`。
- 落盘：`lib/capture.js` 的 `screenshot(session, tab, options)` 返回 `{ file, data, meta, summary }`；`data` 是图片原始字节（Buffer），`meta` 含 `width` / `height` / `format` / `mediaType` / `bytes` / `fullPage` / `name`，传了 `clip` / `scale` 才带对应字段。
- 回写：`lib/tools.js` 的 `browser_e2e_screenshot.run` 在 `ctx.get('attachments')` 存在且其 `saveImage` 是函数时，调用 `saveImage({ data, mediaType, name })`，把宿主返回的 `{ attachmentId, mediaType, bytes, width, height, name? }` 写进 `meta.attachment`；`screenshotOutput().render` 返回一段文本加一个 `{ type: 'image', attachment }` 内容块。`data` 不返回给模型。
- 状态变化：会话内容增加一个图片内容块（宿主按图片块渲染）；标签页、面板、浏览器进程都不变。
- 失败：附件服务缺席或 `saveImage` 抛错时只返回文本，文件仍按 `file` 落盘（`0003-screenshot-output.md` 的「落盘与返回」「边界」已固定这条降级）。

### 行为 2（待决策，目标契约草案）：输入区图片草稿

> 仅当决策采纳方案 B 且宿主提供草稿通道时成立；决策前不实现，本节不是当前行为。

- 入口：面板工具条的「放入输入框」按钮，协议命令 `stage-draft`（无参数）。目标会话是当前选中标签页所属会话（`session.sessionId ?? session.key`）。
- 宿主处理链：`lib/draft.js` 的 `stageDraft(session, tab, deps)` 依次做四件事：
  1. `deps.capture`（缺省 `lib/capture.js` 的 `screenshot`）截一张 PNG：视口整屏，不带 `clip` / `fullPage`，`format: 'png'`；
  2. 宿主 `attachments.imageLimits` 存在时，按 `maxImageBytes` / `maxImageDimension` / `maxImagePixels` 校验字节、单边与总像素；
  3. `attachments.saveImage({ data, mediaType, name })` 存成附件；
  4. `composer.stageAttachment({ sessionId, ref })` 交给宿主输入区草稿。
- 输出：事件 `draft-staged`，载荷 `{ attachmentId, mediaType, bytes, width, height, name, summary }`（附件字段与行为 1 的附件引用同形，`summary` 是一行人类可读提示，如 `已放入输入框：1200x800 (image/png, 123456 字节)`）。
- 能力门控：`ctx.get('composer')` 不存在或没有 `stageAttachment` 时回 `draft-unavailable`，客户端把按钮禁用并显示「当前宿主未提供输入区草稿通道」；不静默退化成截图。
- 失败文案与错误码：无 active tab → `no-active-tab`「没有可放进输入框的画面：当前没有打开的浏览器」；截图失败 → `capture-failed`；`saveImage` 或 `stageAttachment` 失败 → `draft-failed`，消息带宿主原因；超出宿主 `imageLimits` → `draft-failed`，消息「图片超出宿主输入区限制：…」。
- 状态变化：会话内容不变（草稿未提交）；标签页、面板、浏览器进程不变；不刷新空闲计时（与 `request-frame` 相同，只截一帧）。

### 行为 3（明确不做）

- 不伪造用户消息：不调用 `session.append('user/message', ...)`，不调 `ctx.sessionController.prompt`。
- 不接管、不注入宿主 composer：不对宿主输入区做 DOM 事件或值注入。
- 不做通用文件附件、不做批量投放、不做草稿持久化。

## 边界

- 宿主输入区里未发送的草稿不落库（宿主自身限制：草稿提交前只留在浏览器里）；插件不缓存草稿，插件重载后面板侧不恢复任何草稿状态。
- 一次命令一张图；连续两次得到两张草稿，顺序由宿主接纳；插件侧无跨调用状态，因此不新增不变量。
- isolated 与 cdp 都能截图；cdp 无固定视口时按页面内尺寸截（同 `0003`）。
- 面板 socket 无鉴权、`activeTabId` 是全局共享的（`0002` 已知限制）；`stage-draft` 会让本机任意进程可以往输入区放图，这是本项新增的安全面，决策时必须权衡。
- 宿主没有 `webServer`（CLI）时没有面板、没有命令；工具照常可用。
- 未验证：宿主工具结果里的图片是否原生可拖入输入区（`dsh-client-ui-attachment` 的说明只写到「已加载的会话图片可拖入输入框作为图片附件」，没写工具结果图片）。若原生拖拽已覆盖，本项实际缺口只剩「模型主动预填」，见计划 §1 的 G 验证。
- 不处理：把页面上的 `<img>` 或已下载文件转成草稿；跨会话投放；草稿编辑与排序。

## 验收

> 第 1 条现在就能跑；第 2 至 4 条以「行为 2 落地」为前提，当前不成立（状态是待决策）。

1. 现状（今天可跑）：`node tests/tools.mjs` 退出码 0 且输出无 `FAIL`，命中用例 10 的 `截图工具返回 { file, meta }`、`附件服务可用时 render 返回文本 + image 块`、`图片实际存入附件服务`、`附件服务不可用时只返回文本`；`npm run test:unit` 退出码 0。
2. 行为 2 落地后（tester 新建 `tests/draft.mjs`，用假 attachments、假 composer、假 capture，不启动浏览器）：
   - `草稿：截一张图存为附件并调用宿主通道一次`
   - `草稿：宿主无通道时回 draft-unavailable 且不调 saveImage`
   - `草稿：无 active tab 时回 no-active-tab`
   - `草稿：宿主 imageLimits 拒绝时回 draft-failed 并带原因`
   - `草稿：投放不改会话页数与 activeTabId`
   - `草稿：投放不刷新空闲计时`
3. 行为 2 落地后的协议与客户端：
   - `node tests/invariants.mjs` 退出码 0：既有 `命令表与事件表是协议的唯一来源`、`错误码表是 error.code 的唯一来源，isPanelErrorCode 只认表内 code` 覆盖新增常量。
   - `node tests/panel.mjs` 退出码 0：`stage-draft 端到端（发命令收到 draft-staged）`、`宿主缺草稿通道时收到 draft-unavailable`。
   - `node tests/client-bundle.mjs` 退出码 0：`草稿按钮在宿主未声明通道时禁用`、`草稿成功后不在客户端保存草稿`。
   - `node scripts/build-client.mjs` 退出码 0 后 `lib/client.js` 为最新产物，`node tests/invariants.mjs` 的「源码 ↔ 产物一致」断言通过。
4. 手工 GUI（行为 2 落地后，真机）：点「放入输入框」→ 宿主输入区出现该图；发送后消息里是同一张图；宿主未提供通道时按钮禁用并给出原因；连点两次出现两张草稿。
