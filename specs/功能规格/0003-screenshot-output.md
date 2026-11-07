# 截图参数与产物落盘

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/capture.js`、进程内对象契约「能力函数返回值」、P3 throw 分类 `capture.js` 条目、投屏设置口径）；specs/项目规格/0002-panel-protocol-v1.md（命令表 `request-frame`、事件表 `frame`、错误码表 `capture-failed`、投屏设置区间与默认值的唯一来源）
代码: lib/capture.js / lib/tools.js / lib/panel.js / tests/tools.mjs / tests/cdp.mjs / tests/panel.mjs / tests/invariants.mjs

## 需求

`browser_e2e_screenshot` 把当前页面的渲染结果写到本地文件，再把路径与元数据交回模型；宿主提供附件服务时图片本身也作为附件返回。本规格固定参数、校验顺序、尺寸上限、倍率语义与产物命名，避免同名覆盖、越界输出与静默降级。

## 行为

### 参数（工具表 `browser_e2e_screenshot`，能力函数 `capture.js` 的 `screenshot`）

- `name`：文件名前缀，不含扩展名。白名单为 `SHOT_NAME_PATTERN`（只允许 ASCII 字母、数字、`.`、`_`、`-`）；显式传值必须通过校验，空串、纯空白、`.`、`..`、含 `..`、含 `/` 或 `\` 都报错，不静默回退默认名。合法名字后追加唯一后缀（`uniqueSuffix`：`Date.now()` 的 36 进制 + 模块级自增计数 `shotNameSeq`），实际文件名 `<name>-<后缀>.<扩展名>`。
- 未传 `name`（`undefined` / `null`）才使用默认名 `shot-${uniqueSuffix()}`，同样带唯一后缀。
- `fullPage`：布尔，缺省 `false`；为真时截整页。
- `clip`：`{ x, y, width, height }`，四值必须为整数，`x` / `y` 非负，`width` / `height` 不小于 1；坐标相对视口、单位 CSS 像素。
- `format`：`png`（缺省）或 `jpeg`（取值集合为 `SHOT_FORMATS`）。
- `quality`：仅 `format: "jpeg"` 有效，1-100 整数；未传时不给 Playwright 传 quality，由 Playwright 取自身默认值。
- `scale`：`"css"` / `"device"`（`SHOT_SCALES`）或整数 1 / 2 / 3（`SHOT_NUMERIC_SCALES`）；缺省不传，走 Playwright 默认（`device`，即设备像素比）。数值倍率不交给 Playwright，改走 CDP `Page.captureScreenshot`。
- `tab_id`：目标标签页，缺省当前 active tab（`currentTab`）。

### 校验顺序与失败文案（`screenshot` 内短路，首个失败即抛）

1. `format` 非法：`不支持的截图格式 "webp"，只支持 png 或 jpeg`。
2. `quality` 已传但格式不是 jpeg：`quality 仅适用于 format="jpeg"`；不是 1-100 的整数：`quality 必须是 1-100 的整数，收到 0`。
3. `scale` 形态非法：`scale 只支持 "css" / "device" / 1 / 2 / 3，收到 4`（收到的值经 `JSON.stringify` 回显，字符串形态带引号）。
4. `clip` 形态（`assertClip`）：不是对象 `clip 必须是 { x, y, width, height } 对象`；某值非整数 `clip.x 必须是整数，收到 1.5`；负起点 `clip.x / clip.y 不能为负数，收到 x=-1, y=0`；宽高小于 1 `clip.width / clip.height 必须 >= 1，收到 0x50`。
5. `clip` 与 `fullPage` 同时给：`clip 与 fullPage 不能同时使用`。
6. `name`（`safeShotName`）：`截图 name 只允许字母、数字、"."、"_"、"-"，且不能含 ".." 或路径分隔符，收到 "../../outside"`（收到值经 `JSON.stringify` 回显）。
7. `clip` 越当前视口宽 / 高（`viewportBounds`）：`clip 超出视口宽度：x + width = 900 > 视口宽度 800`、`clip 超出视口高度：y + height = 620 > 视口高度 600`。
8. 输出尺寸：按实际倍率换算出的 `outWidth` / `outHeight`（`Math.round`），单边超 `MAX_SHOT_EDGE`（8192）报 `截图输出 8193x900 超出单边上限 8192`；总像素超 `MAX_SHOT_PIXELS`（4194304）报 `截图输出 2400x1800 共 4320000 像素，超出上限 4194304`。

`name` 的第 6 步在第 7、8 步之前：文件名校验失败时不会先算视口或尺寸。

### 尺寸基准与倍率

- 基准尺寸（`shotBaseSize`）：有 `clip` 用 clip 的宽高；`fullPage` 用 `document.documentElement.scrollWidth/scrollHeight` 与 `document.body` 的滚动尺寸取较大值；否则有固定视口用视口，无固定视口用 `window.innerWidth / innerHeight` 兜底。
- 倍率因子：数值倍率即该整数；`"css"` 为 1；`"device"` 与缺省取页面 `window.devicePixelRatio`。输出尺寸上限按因子换算后的值判定。
- 数值倍率路径：`page.context().newCDPSession(page)` 后发 `Page.captureScreenshot`，`format` 透传；仅当 `format` 为 jpeg 且传了 `quality` 才带 `quality`；`captureBeyondViewport` 默认 `false`，`fullPage` 时改 `true` 并显式给整页 clip `{ x: 0, y: 0, width: base.width, height: base.height, scale }`。用户 clip 一律加 `window.scrollX / scrollY` 换成页面坐标；无 clip 时也显式给视口 clip（当前滚动起点 + 基准宽高），否则倍率不生效；用完 `detach`。
- `"css"` / `"device"` / 缺省路径交给 `page.screenshot`：`type` 传 format，按需带 `clip`、`quality` 与 `scale`（只有 css / device 两种形态带 `scale`）。

### 落盘与返回

- 目录：`ensureArtifactsDir(session)` 在会话首次调用时创建 `~/.dsh/browser-e2e/artifacts/<YYYYMMDD-HHmmss>` 并写回 `session.artifactsDir`，同一会话后续复用。
- 扩展名：`format: "jpeg"` 用 `.jpeg`，其余用 `.png`。
- `capture.js` 返回 `{ file, data, meta, summary }`：`file` 为绝对路径；`data` 为图片原始字节（Buffer）；`summary` 为 `截图 WxH -> <file>`；`meta` 含 `width` / `height`（优先取 `imageSize` 从 PNG / JPEG 文件头解析的实际尺寸，解析失败退回按倍率换算出的 `outWidth` / `outHeight`）、`format`、`mediaType`（`image/png` / `image/jpeg`）、`bytes`、`fullPage`、`name`（含扩展名）；传了 `clip` 才带 `clip`，传了 `scale` 才带 `scale`（原样回传入参形态，数值倍率为整数）。
- 工具层（`browser_e2e_screenshot` 的 `run`）：`ctx.get('attachments')` 存在且 `saveImage` 是函数时，用 `data`、`meta.mediaType`、`meta.name` 存附件，成功后把 `attachmentId` / `mediaType` / `bytes` / `width` / `height`（宿主返回 `name` 时也带 `name`）写进 `meta.attachment`；`saveImage` 抛错则丢弃 attachment。工具返回 `{ file, meta: { ...meta, attachment?, summary } }`，不把 `data` 返回给模型。
- 输出契约（`screenshotOutput`）：`meta` 必填 `summary` / `width` / `height` / `format` / `mediaType` / `bytes` / `fullPage` / `name`；`render` 在无附件时只产生一段文本 `截图 WxH -> 路径` + `路径：<file>（mediaType，bytes 字节）`，有附件时追加一段 `image` 内容块。
- 面板刷新帧：`request-frame` 命令用 `panelPage(activeTabId)` 与 `captureJpeg`（quality 取 `this.config.quality`）截一帧 base64 JPEG，推回 `frame` 事件；失败按 `capture-failed` 上报。`captureJpeg` 无 page 返回 `null`；`quality` 不是整数时取 `DEFAULT_SCREENCAST_CONFIG.quality`（唯一来源为 `lib/protocol.js`）；宽高优先取文件头解析值，其次 `viewportSize()`，再退 0。

## 边界

- `clip` 与 `fullPage` 同时给直接报错，不静默让其中一个生效。
- `name` 显式传空串、纯空白、`.`、`..` 一律报错，不静默回退默认名；路径穿越与路径分隔符被白名单挡住，不会写到产物目录之外。
- `format: "png"` 带 `quality` 报错而不是忽略该字段。
- 输出超上限在落盘前报错，不写半成品；数值倍率放大整页是主要触发路径。
- 同一毫秒内两次同名截图、以及两次都未传 name 的截图，靠自增序号得到不同文件名，不互相覆盖。
- 宿主无 `attachments` 服务、或 `saveImage` 抛错时退回纯文本输出，文件此时已经落盘，仍可按 `file` 路径访问。
- `viewportBounds` 的页面求值失败（页面已关闭等）返回 `null`，此时跳过 clip 越视口校验；输出尺寸校验仍按基准尺寸执行。
- CDP 接管模式没有固定视口，clip 边界与无 clip 的输出尺寸都按页面内尺寸兜底；隔离模式按启动视口。
- 不处理的场景：截图来源只有 `tab.page` 这一个页面对象，不做跨页拼接；附件 schema 的 `name` 可选，宿主不返回该字段时 `meta.attachment` 里不写 `name`。

## 验收

1. `node tests/tools.mjs` 退出码 0 且无 FAIL。用例 7「截图增强（clip / jpeg / 校验链）」覆盖：`clip 截图落盘`、`clip 截图尺寸为 100x50`、`meta 尺寸与文件一致`、`首行为 summary`、`scale 1 输出 100x50`、`scale 2 输出 200x100`、`scale 3 输出 300x150`、`非法 scale 数字报错`、`非法 scale 字符串报错`、`jpeg 截图落盘且扩展名正确`、`jpeg 尺寸为视口 800x600`、`clip 越出视口报错且带数字`、`非法 format 报错`、`png 带 quality 报错`、`非整数 clip 报错`、`name 含路径穿越被拒`、`name 含路径分隔符被拒`、`显式传 name "" 被拒且文案带 name`、`同名截图不覆盖且都落盘`、`无 name 的默认截图名带唯一后缀且不覆盖`、`同一毫秒内两次无 name 截图不覆盖（默认名带自增序号）`、`meta.scale 原样回传 css 形态`、`滚动后 clip 取到视口内容（蓝色，不是白图）`、`滚动后 scale:1 与 scale:"css" 像素一致`、`无 clip scale:2 输出 1600x1200（倍率真实生效）`、`无 clip scale:3 输出 2400x1800 超像素上限报错`、`整页 scale:1 输出 800x2400 且上下两段颜色正确`；用例 10 覆盖 `截图工具返回 { file, meta }`、`附件服务可用时 render 返回文本 + image 块`、`图片实际存入附件服务`、`附件服务不可用时只返回文本`。
2. `node tests/cdp.mjs` 退出码 0 且无 FAIL：用例 3 的 `截图成功（无固定视口时按内尺寸兜底）` 断言 CDP 接管下截图元数据宽高为正。
3. `node tests/panel.mjs` 退出码 0 且无 FAIL：用例 D 的 `刷新按钮产生新帧` 断言发 `request-frame` 后 `frame` 事件数增加。
4. `node tests/invariants.mjs` 退出码 0 且无 FAIL：用例 J 的 `captureJpeg：未传 quality 时取 DEFAULT_SCREENCAST_CONFIG.quality`、`capture.js 的默认质量来自 protocol.js，没有写死数字`、`captureJpeg：显式 quality 优先于默认值`。
