# 下载与完整性校验

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表、依赖方向、进程内对象契约「能力函数返回值」、P3 throw 分类「单次 / 跨调用 / 运行时」）；specs/项目规格/0002-panel-protocol-v1.md（面板只读、`action` 事件取返回值首行）；specs/功能规格/0002-browser-launch-and-reuse.md（isolated / cdp 会话与产物目录）；specs/功能规格/0003-screenshot-output.md（`ensureArtifactsDir` 产物目录口径）；specs/功能规格/0007-click-fill-targets.md（ref / selector / x + y 三选一语义，本项触发路径直接复用 `click`）
代码: lib/download.js / lib/tools.js / tests/download.mjs / tests/cdp.mjs

## 需求

下载类端到端验证（发票、报表导出、附件）不能只看页面有没有反应：必须拿到真实落盘的文件、字节数与内容摘要，才能断言「下载成功且内容一致」。竞品分别提供了按 URL 直接取回（anweat `target.download`、wqty123 `dsh_browser_download`）和点击后等待下载事件（Fisfzy `ego_download`）两条路径；本规格把两条合并成一个工具，并固定目录、文件名、大小上限、超时与 SHA-256 校验口径。

## 行为

### 工具与参数

- 工具名 `browser_e2e_download`，定义在 `lib/tools.js` 的 `buildToolTable`；能力实现在 `lib/download.js` 的导出 `download(session, options, tabId)`。
- 两种下载来源二选一，必须且只能给一种：
  - `url`：HTTP(S) 地址，直接经当前标签页所属浏览器上下文的请求客户端取回，不导航当前页；与页面共享 Cookie / 登录态。
  - 触发目标 `ref` / `selector` / `x` + `y`：先登记 `page.waitForEvent('download')`，再用既有 `click` 语义点击，等待浏览器产生下载事件。
- 参数：

| 参数 | 类型 | 区间 / 默认 | 说明 |
|---|---|---|---|
| `url` | string | 无默认 | HTTP(S)；与触发目标互斥 |
| `ref` | string | 无默认 | snapshot 得到的 `@N`；与 `url` / `selector` / `x`+`y` 互斥 |
| `selector` | string | 无默认 | CSS 选择器；与 `url` / `ref` / `x`+`y` 互斥 |
| `x` / `y` | number | 无默认 | 视口坐标；两者都必须是有限数字，与其它来源互斥 |
| `filename` | string | 无默认 | 纯文件名（不含目录），覆盖服务器建议名；见「文件名」 |
| `maxBytes` | integer | 默认 `DEFAULT_MAX_DOWNLOAD_BYTES`（104857600，100 MiB）；1..`MAX_DOWNLOAD_BYTES`（1073741824，1 GiB） | 本次单个文件的上限 |
| `expectedSha256` | string | 无默认 | 64 位十六进制；给了就强校验，不匹配即失败并删除文件 |
| `timeoutMs` | integer | 默认 60000；1000..300000 | 等待下载事件 / HTTP 请求与写盘的总预算 |
| `tab_id` | string | 缺省当前 active tab | 目标标签页 |

- 参数校验顺序固定：来源互斥 → `url` 协议 → `filename` → `maxBytes` → `expectedSha256` → `timeoutMs` → 下载目录环境变量 → `currentTab`。前七步不依赖浏览器是否启动（目录步骤可能创建目录，但不写文件）。

### 下载目录（默认值与唯一可配置项）

- 默认目录：`<session.artifactsDir>/downloads/`，即 `~/.dsh/browser-e2e/artifacts/<YYYYMMDD-HHmmss>/downloads/`。同一会话的所有下载共用一个目录，由 `lib/capture.js` 的 `ensureArtifactsDir(session)` 派生并 `mkdirSync(..., { recursive: true })`。
- 唯一覆盖项：环境变量 `DSH_BROWSER_DOWNLOAD_DIR`（绝对路径）。设置后所有会话的下载都写到这里；每次调用重新读取，空串视为未设置。相对路径直接报错，不静默回退默认目录。
- 不提供按次 `savePath` / `saveDir`：本插件没有「工作区」概念，`sessionKey` 是 agent 维度；允许模型传任意宿主绝对路径会把「下载」变成任意文件写入能力（wqty123 用 `downloadDir` 准入闸门解决同一问题，本规格用固定目录 + 环境变量替代）。
- 目录创建失败（权限、磁盘、路径非法）在写文件前报错，不留半成品。

### 文件名

- 显式 `filename` 严格校验：必须是纯文件名，不含 `/`、`\`；不含控制字符与 `< > : " | ? *`；不能是空串、`.`、`..` 或纯点号；不能以 `.` 或空格结尾；不能是 Windows 保留设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM1`-`COM9`、`LPT1`-`LPT9`，不区分大小写，按第一个点号前的主体判断）；长度不超过 180 字符。任一不满足直接报错，不做静默截断或替换。
- 未给 `filename` 时按优先级取：`Content-Disposition` 的 `filename*` → `filename` → URL 路径最后一段（百分号解码）→ `download`。服务器建议名按宽松口径清洗：只取 basename（丢弃 `/`、`\` 前的目录部分），去掉控制字符与不可见字符，Windows 非法字符替换为 `_`，去掉末尾的点与空格；清洗后为空、`.`、`..` 或纯点号时回退 `download`；保留设备名前加 `_`；超过 180 字符时截断但保留扩展名。
- 同名文件绝不覆盖：在目标文件已存在时按 `name-1.ext`、`name-2.ext` … 递增，最多尝试 1000 个；仍无可用名则报错。并发下载同一名字时，先创建成功的调用拿到原名，另一个拿后缀。
- 写入采用「以独占方式创建最终文件」：文件在写入前已确认不存在；可捕获的失败（校验、超限、超时、写盘错误）删除该文件。不先写固定 `.part` 名，避免多个下载互相覆盖。进程崩溃 / 断电等不可捕获的失败可能留下一个未写完的最终名文件，调用方应以字节数 / SHA-256 判定，不能只看文件存在。

### 大小、空文件与 SHA-256

- `maxBytes` 约束单个文件：URL 模式先看 `Content-Length`，声明超限时在读取正文前报错；正文读入后再次按实际长度判定。点击触发模式边读边计数，超过上限立即销毁下载流、删除已写入的部分并报错。
- 0 字节一律按失败处理：删除文件并报错，不返回一个空文件路径。
- 成功时始终计算 SHA-256（`node:crypto`，边写边更新，返回 64 位小写十六进制）。
- 传了 `expectedSha256` 时，计算完成后比对；不匹配删除文件并报错，错误里同时给出期望值与实际值。校验通过时正常返回，摘要里带实际 SHA-256。

### 返回

能力函数返回：

```js
{
  source: 'request' | 'browser',
  file,              // 最终绝对路径
  filename,          // 最终文件名（含冲突后缀）
  suggestedFilename, // 服务器建议名；显式 filename 时仍回传服务器建议名，没有则为空串
  url,               // 请求的 URL 或下载事件报告的 URL
  finalUrl,          // 仅 URL 模式且重定向后不同时返回
  bytes,
  sha256,
  timeoutMs,
  elapsedMs,
  summary
}
```

- 工具返回三行文本：

```text
下载 1080 字节 -> C:\Users\me\.dsh\browser-e2e\artifacts\20261107-230000\downloads\report.pdf
sha256：eeebbc4b...4ba6
来源：直接请求 http://127.0.0.1:19387/files/report.pdf（123ms）
```

  点击触发时第三行为 `来源：点击触发 <下载事件 URL>（123ms）`。首行是 `summaryOf` 取的面板动作摘要。
- 不把文件字节返回给模型，也不走 `attachments` 服务：下载产物是任意文件，不是图片内容块。

### 超时与取消

- `timeoutMs` 是总预算：URL 模式传给 `context.request.get`，读完正文后再按截止时间检查一次；点击触发模式用于 `waitForEvent('download')`，拿到事件后的写盘同样受截止时间约束（到点销毁下载流）。
- 不提供取消参数，也不接 `AbortSignal`（与既有工具一致）。超时后删除半成品并报错；下载不支持断点续传或重试。
- 点击动作自身另有 5000ms（等元素）/10000ms（点击）上限，因此点击触发模式的端到端耗时可能略超 `timeoutMs`；`elapsedMs` 如实返回。

### 状态变化

- 会话：不改变 `state`、`pages`、`activeTabId`、`mode`；CDP 会话首次下载时 `ensureArtifactsDir` 会建出并写回 `artifactsDir`，已存在则不变。调用开始与结束都会刷新空闲计时（`session.touch()`）。长下载超过 `DSH_BROWSER_IDLE_MS` 时仍可能在下载期间被空闲回收，这是既有等待类工具的同一已知边界。
- 标签页：URL 模式不导航、不新建页；点击触发模式只执行一次点击，可能由页面自身导航或开新页，工具不额外建页。下载结束后 active tab 保持点击后的实际状态。
- 面板：只经 `lib/index.js` 的注册包装广播一条 `action` 事件，摘要取返回值首行；不新增命令 / 事件 / 错误码，`lib/protocol.js`、`lib/panel.js`、`client/index.js` 均不改。
- 进程：不启动 / 不关闭浏览器；文件落盘后即使会话关闭也保留。Playwright 自己的临时下载副本在 context 关闭时由其清理，与本工具写出的最终文件无关。

## 边界

- 明确不处理：
  - `browser_e2e_navigate` 直接导航到附件地址触发的下载。事件在调用前已经发生，工具无法追溯；请改用 `url` 模式。
  - `browser_e2e_evaluate` 或页面脚本在工具调用之外触发的下载；只有本次 `browser_e2e_download` 调用期间、点击之后产生的第一个下载事件会被接收。
  - 一次调用下载多个文件；一个调用只处理一个下载事件。页面同时触发多个下载时只接第一个，其余由 Playwright 自行处理（临时文件随 context 关闭删除）。
  - 断点续传、Range 请求、重试、取消、限速、代理认证、PDF 解析、压缩包解压、病毒扫描、内容类型白名单。
  - 按次指定宿主路径 / 目录；只支持 `DSH_BROWSER_DOWNLOAD_DIR` 覆盖目录。
- 直接 URL 模式只做 `context.request`，**不做** anweat 那种「请求失败后改用导航捕获附件」的回退。需要页面导航或前端 JS 才能拿到文件的站点，用点击触发模式。
- 直接 URL 模式把响应体整体读入内存后再写盘（Playwright 的 `APIResponse` 只提供 `body()`）；`Content-Length` 预检能挡住声明超限的响应，但分块传输的超大响应会在读入后才按 `maxBytes` 拒绝，默认 100 MiB、硬上限 1 GiB 是内存风险边界。
- 点击触发模式使用 `download.createReadStream()`，不使用 `download.path()`：Playwright 文档明确 `path()` 在远程连接下抛错（`node_modules/playwright-core/types/types.d.ts` 的 `Download.path` 注释，版本 1.63.0），本项不依赖「CDP 接管是否算远程」这一判断，统一走流式接口；`saveAs()` 虽然可用，但无法边写边限流与算哈希，因此也不使用。
- 点击目标只在主 frame：`ref` / `selector` / 坐标都走既有 `click`，iframe 内元素不支持（P1-9 处理）。下载事件本身是标签页级的，iframe 或页面脚本触发的下载能被本次监听接住；但触发点击仍只能在主 frame。
- 两种模式：isolated 与 cdp 走同一套 `context.request` / `waitForEvent('download')` / `createReadStream` 链；CDP 模式不新建页、不改视口、不结束用户浏览器。若用户浏览器策略或站点设置拒绝下载，Playwright 以 `download.failure()` 返回原因，工具按失败处理并删除半成品。
- URL 模式接受 2xx；3xx 由 Playwright 自动跟随（默认上限 20 次）；最终状态非 2xx 报错，不保存错误页。服务器返回 200 的 HTML 错误页会被当作正常文件保存，本工具不做内容嗅探；调用方用字节数 / SHA-256 / 后续解析判断。
- 响应没有 `Content-Disposition` 且 URL 最后一段为空（如 `https://example.com/`）时文件名回退 `download`。
- 文件名清洗不改变扩展名，也不阻止 `.exe`、`.js` 等可执行扩展名；工具只负责落盘，是否运行/打开由调用方决定。
- 并发：同一会话并发下载不做互斥，各自独立写文件；同名时靠独占创建与后缀避免覆盖。不同会话默认落在不同时间戳产物目录；同一秒启动的会话可能共用目录，仍靠后缀避免覆盖。
- 浏览器在下载途中被关闭、页面崩溃、磁盘写满、目标目录不可写：下载流或写盘报错，工具尽力删除已写入的部分并抛出原始错误（带 `下载中断` 前缀），不返回成功。
- 宿主没有 `webServer`、没有面板连接、没有 `attachments` 服务都不影响本工具。
- 不新增跨调用不变量：下载没有跨调用积累的注册表或状态机；参数错误留在 `download` 入口，浏览器未启动 / tab 不存在沿用 `currentTab` 的 `assertCurrentTabAvailable` / `assertTabExists`，因此 `lib/invariants.js` 不新增断言。
- 与 `browser_e2e_http` 的分工：只要响应正文、不要落盘与 SHA-256 时用 `browser_e2e_http`（仅 `mode=context`）；需要落盘或完整性校验时仍用 `browser_e2e_download`。
- 与 `browser_e2e_fetch` 的分工：下载走「url 直取 / 点击触发」并落盘；只要渲染后的正文走 `browser_e2e_fetch`（开临时页抓取，不落盘）。两者都经会话浏览器、共享登录态。

## 验收

> 本规格状态为「已确认」时 `tests/download.mjs` 尚未创建，由本项 tester 按下列用例实现；全绿后本规格状态改「已实现」并复核每条仍成立。

1. `node tests/download.mjs`：exit 0、无 FAIL。用例组与关键 `check` 标签：
   - 直接 URL（用例 1）：`直接 URL 下载落盘`、`返回字节数与文件大小一致`、`sha256 与已知内容一致`、`响应头文件名优先于 URL 末段`、`显式 filename 覆盖服务器建议名`、`同名下载自动加 -1 后缀且不覆盖`、`cookie 随会话带到下载请求`、`重定向后 finalUrl 指向最终地址`。
   - 完整性（用例 2）：`expectedSha256 匹配时成功`、`expectedSha256 不匹配时报错并删除文件`、`0 字节响应报错且不留文件`、`Content-Length 超限在读取前报错`、`分块响应超限时中止并删除半成品`、`HTTP 404 报错且不留文件`、`直接 URL 超时时报错且不留文件`。
   - 点击触发（用例 3）：`ref 点击触发下载并落盘`、`selector 点击触发下载并落盘`、`x + y 点击触发下载并落盘`、`点击没有触发下载时报超时`、`失效 ref 报错且不等待完整超时`、`url 与触发目标同给报互斥`、`两种触发目标同给报三选一`、`缺少下载来源报错`。
   - 目录与文件名（用例 4）：`默认落在产物目录的 downloads 子目录`、`DSH_BROWSER_DOWNLOAD_DIR 覆盖目录`、`相对 DSH_BROWSER_DOWNLOAD_DIR 报错`、`显式 filename 含路径分隔符被拒`、`显式 filename 为 .. 被拒`、`服务器文件名含路径穿越时只取 basename`、`服务器建议名为 Windows 保留名时加下划线`。
   - 参数与生命周期（用例 5）：`maxBytes 越界报错`、`timeoutMs 越界报错`、`expectedSha256 形态非法报错`、`未启动时下载报「浏览器尚未启动」`、`不存在的 tab_id 报错`、`下载不改变 tab 数量与 activeTabId`；收尾 `msedge 主进程回落到运行前基线`。
2. `node tests/cdp.mjs`：exit 0、无 FAIL。新增用例的 `CDP 接管下直接 URL 下载成功`、`CDP 接管下点击触发下载成功（createReadStream 路径）`、`CDP 下载 sha256 与内容一致`、`CDP 下载不新建标签页`；找不到 Edge 时按现有 SKIP 口径以 0 退出。
3. `node tests/tools.mjs`：exit 0、无 FAIL。`注册的工具与工具表逐项一致` 覆盖新增工具注册；既有截图 / 点击 / 填写 / 快照无回归。
4. `node tests/panel.mjs`：exit 0、无 FAIL。用例 C 的 `注册的工具与工具表逐项一致（顺序与名字）`、`作用于页面的工具都接受 tab_id` 覆盖新增工具的参数面；面板协议未变。
5. `npm run test:unit`：exit 0、无 FAIL。不新增不变量，`tests/invariants.mjs` 只做既有断言回归。
6. 全量：`npm run test:integration`（由本项 tester 把 `node tests/download.mjs` 加入 `test:integration` 脚本后）exit 0、输出无 FAIL。
