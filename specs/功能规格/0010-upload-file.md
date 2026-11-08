# 文件上传

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/page.js` 的职责与「明确不含」、不变量清单 `assertRefBelongsToTab` / `assertRefRevalidated`、P3「跨调用 / 单次 / 运行时」的 throw 分类口径）；specs/项目规格/0002-panel-protocol-v1.md（面板只读、工具行为只由 `browser_e2e_*` 发起、`action` 事件取返回值首行）；specs/功能规格/0007-click-fill-targets.md（ref / selector / x + y 三选一语义同源）；specs/功能规格/0004-snapshot-and-ref-table.md（ref 来源与可见性判据）
代码: lib/page.js / lib/tools.js / tests/upload.mjs / tests/cdp.mjs

## 需求

表单里的文件控件（头像、附件、数据导入）是端到端验证的硬缺口：`browser_e2e_evaluate` 里用 `DataTransfer` 合成 `File` 走不到浏览器真实的文件选择路径，验证不了「选本地文件 → 提交 → 服务端收到」。本规格固定 `browser_e2e_upload` 的参数、宿主侧路径校验、目标控件校验、覆盖与清空语义，让模型能把宿主本地文件附加到 `input[type=file]` 上。

## 行为

### 工具与参数

- 工具名 `browser_e2e_upload`，定义在 `lib/tools.js` 的 `buildToolTable`；能力实现在 `lib/page.js` 的导出 `upload(session, target, files, options, tabId)`。
- 目标参数 `ref` / `selector` / `x` + `y`：与 `browser_e2e_click` / `browser_e2e_fill` 同一判据（空串不算给；`x` 与 `y` 都是有限数字才算坐标目标），由 `lib/page.js` 的私有 `targetOf(target, 'upload')` 解析，三选一：
  - 0 种：`缺少上传目标：请给 ref（snapshot 得到的 @N）、selector（CSS 选择器）或 x + y（视口坐标）三选一`
  - 多于 1 种：`上传目标只能给一种：ref / selector / x + y 三选一，避免传错控件`
- `files`：必填，宿主上的绝对路径字符串或字符串数组。工具层把单个字符串归一为单元素数组；形态不对的报错见「边界」。
- `maxBytes`：整数，缺省 `DEFAULT_MAX_UPLOAD_BYTES`（20 MiB = 20971520），取值 1..`MAX_UPLOAD_BYTES`（512 MiB = 536870912）；约束的是本次 `files` 的总字节数。
- `clear`：布尔，缺省 true，语义见「覆盖与清空」。
- `tab_id`：可选，缺省当前 active tab。
- 扩展名不限：不校验控件的 `accept`，不按扩展名改写文件名或 MIME；浏览器按路径读原文件，MIME 由扩展名推导，与真人选择一致。

### 宿主侧路径校验

在能力函数入口按下列顺序逐项校验，任一失败即抛错，不静默跳过：

- 数量：`files` 多于 `MAX_UPLOAD_FILES`（20）个 → `一次最多上传 20 个文件，收到 N 个；请分批上传`
- 绝对路径：`isAbsolute` 为假 → `文件路径必须是绝对路径：<p>；请给出宿主上的完整路径（如 C:\tmp\a.txt）`
- 存在性：`statSync` 失败 → `文件不存在：<p>；请确认路径拼写，并确认文件在运行插件的这台机器上`
- 是普通文件：`stat.isFile()` 为假 → `路径不是文件：<p>；请指向具体文件（目录上传不在本工具范围）`
- 可读：`accessSync(p, constants.R_OK)` 失败 → `文件不可读（宿主权限不足）：<p>；请检查文件 ACL，或换一个文件`
- 总大小：`files` 的 `size` 之和超过 `maxBytes` → `文件总大小 <total> 字节超过上限 maxBytes=<n> 字节；请提高 maxBytes（上限 536870912）或换更小的文件`
- 校验通过后把每个路径的 `size` 与 `basename` 交给后续步骤；路径原样交给 Playwright，不复制、不改写文件内容。

### 目标控件校验

- 用一个 `locator.evaluate` 读控件信息：`{ tag, type, disabled, multiple, accept, count, visible }`，其中 `count` 是当前 `files.length`，`visible` 由 `getBoundingClientRect` 的正尺寸与 `checkVisibility` 判定。
- 不是 `input`：`目标不是文件控件：<label> 是 <tag>；本工具只接受 input[type=file]，请先用 browser_e2e_snapshot 找到文件控件，再传它的 selector`
- 是 `input` 但 `type` 不是 `file`：`目标是 input[type=<type>]，不是文件控件；请传 input[type=file] 的 selector`
- `disabled`：`文件控件已禁用（disabled）：<label>；页面不会接受这次选择，请先解除禁用或换一个控件`
- 多文件但控件没有 `multiple` 属性：`该控件不支持多选（没有 multiple 属性），收到 N 个文件：<names>；请只传 1 个文件，或改用支持多选的控件`
- `evaluate` 抛错（元素已从页面移除）：`目标文件控件不可用：<label>；请重新 browser_e2e_snapshot 后重试`
- `label` 的取值：ref 路径为 `ref @N`，selector 路径为 `selector "<s>"`，坐标路径为 `坐标 (x, y)`。
- 可见性口径：ref 路径先经 `assertRefRevalidated`，零尺寸按「已失效（当前尺寸 …，不可见）」报错；selector 路径只要求 attached，不要求可见（真实页面的文件控件常被 `display:none` 隐藏后再由 label 触发），摘要里注明「当前不可见」；坐标路径由页面自己决定是否打开文件选择器。

### 三种路径的下发

- ref：`assertRefBelongsToTab` 取条目 → `revalidateRef` 复验 → `page.locator('xpath=' + item.xpath)` → 控件校验 → `setInputFiles(files, { timeout: 10000 })`。
- selector：`page.locator(selector)` → `waitFor({ state: 'attached', timeout: 5000 })`，超时改写成 `选择器 "<s>" 在 5000ms 内没有匹配到元素；请先用 browser_e2e_snapshot 确认文件控件的选择器` → 控件校验 → `setInputFiles(files, { timeout: 10000 })`。
- x + y：`assertPointInViewport` → 先建 `page.waitForEvent('filechooser', { timeout: 5000 })` 的 promise 并挂 `.catch`（避免未处理拒绝）→ `page.mouse.click(x, y)` 真实点击 → 等选择器：
  - 超时（含 promise 以错误落定）：`点击坐标 (x, y) 后 5000ms 内没有出现文件选择器；请确认该位置会打开文件选择，或改用 ref / selector`
  - `chooser.element()` 读到的不是 `input[type=file]`：`坐标 (x, y) 处打开的文件选择器不属于 input[type=file]（<tag>）；请改用 ref / selector`
  - 多选校验用 `chooser.isMultiple()`；下发用 `chooser.setFiles(files, { timeout: 10000 })`。
- 控件校验未通过时，x + y 路径在 `setFiles` 之前就抛错，不调用 `setFiles`，页面收不到 `change` 事件。
- `setInputFiles` / `setFiles` 自身的超时与浏览器错误不改写，原样抛出（与 click / fill 一致）。

### 覆盖与清空

- `clear: true`（缺省）：`setInputFiles(files)` 直接替换当前选择（Playwright 的下发语义就是替换），不额外先清空一次，避免同一控件连发两次 `change`；摘要按操作前读到的 `count` 回显「已替换原有 N 个选择」。
- `clear: false`：只在控件当前没有选择时设置。已有 `N > 0` → `控件已选择 N 个文件，clear=false 不会覆盖；要替换请传 clear: true，要清空请传 files: [] 且 clear: true`。追加不可实现：Playwright 不能把已选 `File` 还原成宿主路径，本工具也不读取已选文件内容。
- `files: []` 且 `clear: true`：`setInputFiles([])` 清空选择，摘要 `清空 <label> 的 N 个已选文件`；原本就空时摘要 `控件本来没有已选文件（<label>）`，仍按成功返回（幂等）。
- `files: []` 且 `clear: false`：`files 为空且 clear=false：不会改变当前选择；要清空已选文件请传 clear: true`。
- `clear: false` 与 `x` + `y` 组合：`x + y 路径不支持 clear=false（要先点击才能读到控件当前选择）；请改用 ref / selector`，在点击之前拒绝。
- 重复调用默认覆盖：工具描述与返回值末行都写明「再次调用会覆盖本次选择」。

### 返回与状态

- 能力函数返回 `{ mode, ref, selector, x, y, files: [{ name, size }], totalBytes, multiple, accept, visible, replaced, cleared, summary }`（不适用字段省略）。
- 摘要：`上传 N 个文件到 <label>：<name>（<size> 字节）、…`（单文件不带间隔号）；坐标路径的 `<label>` 为 `坐标 (x, y)`。
- 工具返回三行文本：首行摘要；第二行 `控件：multiple|单文件` ＋ `，accept="<a>"`（没有 accept 时省略，超过 120 字符截断加 `…`）＋ `；共 <n> 字节` ＋ `；当前不可见（按 DOM 注入）`（仅不可见时）＋ `；已替换原有 N 个选择`（仅 N>0 时）＋ `；页面当前选择 N 个文件`（仅读回的选择数不等于本次下发文件数时）；第三行 `再次调用会覆盖本次选择（clear 默认 true）；要清空已选文件请传 files: []。`
- 设置后做一次尽力而为的读回（读 `input.files` 的 `name` 与 `length`），元素已移除或页面脚本清空选择都不算失败，只用于在摘要里补一句 `页面当前选择 N 个文件`；成功判据只有「下发调用没有抛错」。
- 面板：`lib/index.js` 的注册包装用 `summaryOf` 取首行广播 `action` 事件，与其它工具一致；不改 `lib/protocol.js`、`lib/panel.js`、`client/index.js`。
- 会话 / 标签页 / 进程：只读宿主文件、只改页面控件的选择；不新建页、不改视口、不关闭浏览器；失败时不改变控件原有选择（x + y 路径在点击前拒绝，或在 `setFiles` 前拒绝）。

## 边界

- 两种模式：ref 与 selector 路径在 isolated 与 cdp 下走同一条 Playwright 下发链（底层是 `DOM.setFileInputFiles`）；x + y 路径依赖 Playwright 的 filechooser 拦截，cdp 接管下的可用性由验收条目单独判定。
- 只处理主 frame：`page.locator` 与 `page.mouse` 都在主 frame 作用域，iframe 内的文件控件匹配不到；跨 frame 操作由 P1-9 单独处理。
- 不做 `<label>` 代理：ref / selector 指向 `<label>` 时报「目标不是文件控件」，不静默下钻到 `label input[type=file]`；调用方应给控件本身的 selector（如 `label[for=x] + input[type=file]` 或 `input[type=file]`）。
- 不做 `webkitdirectory` 目录上传：`files` 只接受文件路径，目录在校验阶段按「路径不是文件」拒绝。
- 不校验 `accept`、不校验页面脚本是否真的把文件发出去；上传完成后不自动点提交、不等待上传请求。
- 页面可能在 `change` 事件里清空选择或替换掉控件（常见于受控组件与「选完即传」的组件），本工具不据此判定失败；需要断言「服务端收到」时由调用方继续用 `browser_e2e_network` 或页面断言。
- 并发：同一控件被并发上传时不做互斥，最后落定的一次生效（两次都会触发 `change`）。
- 不支持取消：与其它工具一致不接 `AbortSignal`；耗时只受 5000ms（等元素 / 等选择器）与 10000ms（下发）约束。
- 点击后页面跳转、关闭或被遮罩拦住导致选择器永不到达 → 报 5000ms 超时文案，不重试。
- 宿主校验与浏览器读文件之间有竞态：校验通过后文件被删除或改小，由浏览器侧报错并原样抛出。
- 参数形态错误的文案：`files` 缺失或空字符串 → `缺少必填参数 files（绝对路径字符串或其数组）`；既不是字符串也不是数组 → `files 需要绝对路径字符串或其数组，收到 <JSON.stringify>`；数组里含非字符串或空字符串 → `files 里有一项不是非空字符串：<JSON.stringify>；请传宿主上的绝对路径`；`maxBytes` 非整数或越界 → `maxBytes 必须是 1..536870912 的整数，收到 <JSON.stringify>`。
- `tab_id` 不存在、浏览器未启动、ref 不存在 / 已失效：沿用 `assertTabExists`、`assertCurrentTabAvailable`、`assertRefBelongsToTab`、`assertRefRevalidated` 的既有文案，本规格不新增。

## 验收

> 本规格状态为「已实现」：下列 9 组用例与收尾断言由 `tests/upload.mjs` 覆盖，第 4 条的两个 CDP 用例由 `tests/cdp.mjs` 覆盖；每条标签在 `node tests/upload.mjs` / `node tests/cdp.mjs` 输出里可直接核对。

1. `node tests/upload.mjs`：exit 0、无 FAIL。用例与 `check` 标签：
   - 用例 1（夹具）：`本地夹具页面加载成功`、`可见文件控件出现在 snapshot 里`、`隐藏文件控件不在 snapshot 里`。
   - 用例 2（ref 路径）：`ref 上传生效`、`input.files 的名字与入参一致`、`change 事件触发一次且 files.length 为 1`。
   - 用例 3（selector 路径）：`隐藏文件控件用 selector 上传生效`、`摘要标注当前不可见`。
   - 用例 4（多文件）：`multiple 控件接受 2 个文件`、`files 顺序与入参一致`。
   - 用例 5（坐标路径）：`坐标点击接住文件选择器并写入`。
   - 用例 6（覆盖与清空）：`第二次上传替换第一次的选择`、`摘要回显已替换原有的 1 个选择`、`files 传空数组后 files.length 为 0`、`clear=false 且已有选择时报错且选择未变`、`files 为空且 clear=false 时报错`、`clear=false 与 x + y 组合在点击前报错`。
   - 用例 7（宿主侧校验）：`相对路径报「必须是绝对路径」`、`不存在的路径报「文件不存在」`、`目录报「路径不是文件」`、`超过 maxBytes 报「超过上限」`、`21 个文件报「一次最多上传 20 个」`、`maxBytes 越界报「1..536870912」`、`files 非字符串非数组报形态错误`。
   - 用例 8（目标控件校验）：`文本输入框报「不是文件控件」`、`disabled 文件控件报「已禁用」`、`label 报「目标不是文件控件」`、`无 multiple 的控件传 2 个文件报「不支持多选」`、`三种目标都不给报「缺少上传目标」`、`两种目标同给报「只能给一种」`、`失效 ref 报「已失效」`。
   - 用例 9（工具契约）：`browser_e2e_upload 把 files 列为必填`、`files 支持字符串与数组`、`upload 接受 tab_id`。
   - 收尾：`msedge 主进程回落到运行前基线`。
2. `node tests/tools.mjs`：exit 0、无 FAIL（快照 / 点击 / 填写无回归；用例 10 的 `注册的工具与工具表逐项一致` 覆盖新增工具的注册顺序）。
3. `node tests/panel.mjs`：exit 0、无 FAIL（用例 C 的 `注册的工具与工具表逐项一致（顺序与名字）` 覆盖新增工具；`作用于页面的工具都接受 tab_id` 的覆盖由 `tests/upload.mjs` 用例 9 的工具契约标签 `upload 接受 tab_id` 承担，因为 `tests/panel.mjs` 的 tab_id 名单是硬编码，不含 upload）。
4. cdp 模式：`node tests/cdp.mjs` 中新增用例的 `CDP 接管下 selector 上传生效`、`CDP 接管下坐标上传生效`；找不到 Edge 时按现有 SKIP 口径以 0 退出。
5. `npm run test:unit` 与 `npm run test:integration`：exit 0、输出无 FAIL；`test:integration` 必须包含 `node tests/upload.mjs`（由计划指定的步骤加入脚本清单）。
