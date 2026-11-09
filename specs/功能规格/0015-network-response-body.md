# 网络响应体读取

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/page.js` / `lib/tools.js`；进程内对象契约「标签页条目」与「能力函数返回值」）；specs/项目规格/0002-panel-protocol-v1.md（本项不改协议）；specs/功能规格/0005-console-network-ring.md（事件环、重置与列表读取）
代码: lib/page.js / lib/observation.js / lib/tools.js / tests/tools.mjs

## 需求

`browser_e2e_network` 只回 url / method / status / mimeType / failure，验证接口返回内容时模型只能从 DOM 反推。本项让模型按 `request_id` 读取单条请求的请求头、请求体、响应头与响应体：JSON 自动格式化，文本有字符上限，二进制只回大小与摘要；列表模式原有参数与语义保持不变。详情读取最初是独立工具 `browser_e2e_network_detail`，2026-11-08 的工具面合并后并入 `browser_e2e_network` 的 `request_id` 分支（决策与理由见 `specs/项目规格/0003-决策记录.md` #12），行为不变。

## 行为

### 列表与 request_id

- `browser_e2e_network` 的列表参数仍是 `limit` 与 `tab_id`（另见「详情模式」的四个参数），默认值、尾部截取、`summary` / `count` / `total`、空记录文案与失败记录文案都不变。
- 每条网络记录新增 `request_id`：`attachPageHooks` 在 `request` 事件里按标签页自增分配 `n1`、`n2`…；同一个 id 在标签页存续期内不复用，`clearRings` 清空记录也不重置计数。
- 列表文本每行在时间后加 `[n<N>]`，例如 `12:00:00.000 [n3] GET 200 application/json http://…`；`networkRing` 条目仍是最新在最后。
- `networkRing`、`networkByRequest` 之外新增内部容器 `networkContext`（`request_id` → `{ request, response }`），由 `lib/page.js` 写入、`lib/observation.js` 读取。`RING_LIMIT` 淘汰、`clearRings`、关页 / 崩溃都同步删掉对应上下文；`request` 事件保存 Request，`response` 事件补上 Response。

### 详情模式（`browser_e2e_network` 传 `request_id`）

- 作用：按 `request_id` 读一条仍在环形缓冲里的记录；列表语义不变，`request_id` 缺省时仍走列表分支，传入时走详情分支。
- 参数（`additionalProperties: false`）：
  - `request_id`：string，可选；给了就按 `n1`、`n2`… 读详情，形如 `n3`，来自 `browser_e2e_network` 列表。空串与非字符串按「缺少必填参数」报错，省略等于列表模式。
  - `tab_id`：string，可选；语义与其它页面工具一致，缺省用 active tab。
  - `max_chars`：integer，可选，1..`NETWORK_BODY_TEXT_LIMIT`（65536），默认 `NETWORK_BODY_TEXT_LIMIT`；控制文本正文与请求体最多返回多少字符，二进制不受此参数影响。
  - `timeout_ms`：integer，可选，`NETWORK_BODY_TIMEOUT_MIN_MS`（100）..`NETWORK_BODY_TIMEOUT_MAX_MS`（30000），默认 `NETWORK_BODY_TIMEOUT_MS`（5000）。
  - `include_sensitive`：boolean，可选，默认 false；为 false 时 `authorization` / `cookie` / `set-cookie` / `proxy-authorization` / `x-api-key` / `x-auth-token` / `x-csrf-token` / `x-xsrf-token` 等头的值显示 `[已隐藏]`。
- 参数互斥：`request_id` 与 `limit` 不能同时给（报 `request_id 模式下不接受 limit：看列表用 limit，读详情用 request_id`）；`max_chars` / `timeout_ms` / `include_sensitive` 只在传 `request_id` 时生效，列表模式下传了报错（不静默忽略）。
- 入口：能力函数 `networkDetail(session, requestId, options, tabId)`（`lib/observation.js`），先 `session.touch()`，再经 `currentTab(session, tabId)` 取标签页；工具层用 `requireSession(sessionKey(exec))`，未启动时不创建 idle 会话，报错口径与列表模式一致。
- 返回：工具只渲染 `summary` 一行与多行 `text`；能力函数同时返回结构化对象：`{ tabId, request_id, url, method, status, mimeType, failure, at, redirect, request: { headers, postData }, response: { headers, body }, summary, text }`。

### 读取时机

- 事件里只保存 Request / Response 引用与轻量元数据，**不在事件里读 body**：列表读取保持零 I/O；避免为每条响应（含图片、SSE、长轮询）缓冲正文而让事件回调挂住或吃内存。
- 调用 `networkDetail` 时才执行 `request.allHeaders()` / `request.postDataBuffer()` / `response.allHeaders()` / `response.body()`；正文失败只影响本次详情调用，不影响列表与其它请求。
- `response.body()` 与请求体读取都套 `timeout_ms` 超时。超时后底层读取不保证被取消，只丢弃结果；这是 Playwright 的限制，写入边界。

### 正文视图

- 响应 `status` 为 0 且没有 `failure`：`response.body.kind = 'pending'`，文本提示「请求尚未完成」，不抛错。
- 有 `failure`：`kind = 'failed'`，文本给出 `failure`，不读取正文。
- 状态 301 / 302 / 303 / 307 / 308：`kind = 'redirect'`，不调用 `response.body()`（Playwright 对 3xx 响应直接拒读）；文本给出状态、`location` 与后续请求的 `request_id`（能从 `request.redirectedTo()` 对应到仍在缓冲里的记录时）。304 等其它 3xx 没有正文也没有重定向目标：`kind = 'none'`，文本写「无正文（3xx）」。
- 正文为空（如 204）：`kind = 'empty'`，字节数为 0。
- 文本类（`text/*`、`*/*+json`、`*/*+xml`、`application/json`、`application/xml`、`application/javascript`、`application/x-www-form-urlencoded` 等，或 mime 为空且字节里没有 NUL）：`kind = 'text'` 或 `'json'`。按 `content-type` 的 `charset` 解码，缺省 UTF-8；解码后最多保留 `max_chars` 个字符，`truncated` 标记是否截断，另回 `bytes`（原始字节数）、`chars`（原始字符数）、`sha256`。
- JSON：完整正文未被 `max_chars` 截断，且能 `JSON.parse`，且（mime 含 `json` 或文本以 `{` / `[` 开头）时，`kind = 'json'`，同时返回 `json` 解析结果，`text` 用两空格缩进格式化；截断的正文不解析，按 `text` 返回。
- 二进制（图片、PDF、字体、音视频、zip、octet-stream 等）：`kind = 'binary'`，只回 `mimeType`、`bytes`、`sha256`；**不返回 base64**，也不写正文。需要内容比对时用 `bytes` / `sha256`。
- 请求体走同一套分类（`request.postDataBuffer()`），同样受 `max_chars`、JSON 格式化与二进制规则约束；无请求体时 `postData = null`。
- 头：请求与响应都用 `allHeaders()`，头名统一转小写后返回；默认按 `include_sensitive` 脱敏，头为空时显式写「（无）」。

### 重置、隔离与模式

- 事件环按现有判据重置：主框架新文档请求命中时 `clearRings` 清空 `consoleRing` / `networkRing` / `networkByRequest` 与 `networkContext`，之后才登记本次请求；`request_id` 计数不重置，因此旧 id 不会被新文档的记录冒名顶替。
- 主页面的重定向链沿用现有重置口径：第一跳已清空旧文档；主文档重定向的中间跳会被后续「主框架导航请求」再次清空，最终只保留最后一条。子资源（fetch / XHR / 图片等）重定向不是导航请求，各跳各留一条记录，可分别读取。
- `tab_id` 隔离：id 只在所属标签页的 `networkRing` 里查找；不同标签页的 `n1` 互不影响。
- CDP 模式与 isolated 走同一 Playwright 路径（`response.body()` / `request.allHeaders()` 等），无分支差异；接管前已经发生的请求没有记录，接管后的事件才登记。
- 不新增 `lib/invariants.js` 断言：`request_id` 不存在、正文不可读都属于可恢复的查询失败，不是跨调用状态损坏。

## 边界

- `request_id` 传了但不是字符串、或是空串：工具层报 `缺少必填参数 request_id（非空字符串）`；省略 `request_id` 是列表模式，不是错误。
- 格式不是 `n` 加正整数：报 `request_id 格式不对：需要 browser_e2e_network 返回的 n<N>（例如 n3），收到 …`。
- id 不在当前标签页记录里（已淘汰、已导航重置、从没出现过）：报 `网络记录里没有 request_id …（当前环形缓冲 N 条）：可能已被 500 条上限淘汰，或页面已导航导致记录重置；请重新调用 browser_e2e_network 获取最新 request_id`。
- `max_chars` 不是 1..65536 的整数、`timeout_ms` 不是 100..30000 的整数：在能力函数入口报错，不读正文。
- 页面已关闭 / 浏览器已关闭：由 `assertTabExists` / `assertCurrentTabAvailable` / `assertBrowserRunning` 报原有错误；详情读正文期间页面被关，`body()` 的异常转成「响应体不可读」错误并提示在同一文档内重读。
- 流式响应（SSE、长轮询、大文件未结束）：`response.body()` 在响应结束前不返回，到 `timeout_ms` 报超时；底层读取不取消，已知边界。
- 大响应：正文在浏览器侧已整块缓冲后才截断，`max_chars` 只限制返回给模型的文本，不限制 Playwright 的读取内存；超大文件建议在页面内用 `fetch` 流式处理或改用下载能力。
- 字符解码：优先按 `charset`，不认识的 charset 回退 UTF-8；按字节截断后再解码时，末尾可能有一个替换字符。
- 敏感内容：默认只脱敏头；请求体、响应体与 URL 查询参数不脱敏，读取前应确认目标环境允许把内容写进会话。
- 主文档重定向的中间跳不保证出现在列表里（见「重置、隔离与模式」）；子资源重定向可以看到 3xx 记录，但其正文为空，属于正常结果。
- 请求被标记 `failure` 但已收到响应（如 204 / 205 在 Playwright 下触发 `net::ERR_ABORTED`）时按状态分类：204 / 205 为 `empty`（空正文）；只有没有响应对象的失败才是 `failed`。
- 并发：同一 `request_id` 的多次详情调用都是只读，允许并发；Playwright 会复用同一次正文读取。不提供取消/中断接口。
- 明确不做：不提供 base64 正文、不按 URL 猜测式脱敏正文、不按 frame 过滤（网络记录本来就是页面级）、不把正文落盘、不改列表工具的 `limit` 语义、不改面板协议。

## 验收

1. `node tests/tools.mjs`：exit 0、输出无 FAIL。新增「用例 3D：网络详情」与「用例 3E：网络正文边界与错误」，至少覆盖以下 check 标签（标签名按此固定，便于复跑核对）：
   - `网络列表条目带 request_id`
   - `detail 读取 JSON 正文并格式化`
   - `detail 读取请求头`
   - `detail 读取请求体`
   - `敏感请求头默认隐藏、include_sensitive 后可见`
   - `detail 读取响应头`
   - `二进制正文只给大小、mime 与 sha256`
   - `max_chars 截断正文并标记 truncated`
   - `404 响应正文可读`
   - `失败请求返回 failure 且没有响应体`
   - `重定向响应不给正文并指向最终请求`
   - `最终响应正文可读`
   - `未完成请求返回 pending 而不是挂起`
   - `流式响应读取超时报错`
   - `导航后旧 request_id 报已重置`
   - `未知或非法 request_id 报错`
   - `max_chars / timeout_ms 越界报错`
   - `网络上下文随环形缓冲淘汰`
   - `detail 按 tab_id 隔离`
2. `npm run test:unit`：exit 0、无 FAIL；`tests/invariants.mjs` 用例 K 的 `tools.js 的工具描述从常量插值，不写死默认值` 仍通过（新描述里的字符上限与超时默认值必须从 `lib/observation.js` 导出的常量插值）。
3. `npm run test:integration`：exit 0、无 FAIL（串行真起无头 Edge；`tests/panel.mjs` 按工具表派生断言，合并后的 `browser_e2e_network` 自动纳入表驱动契约）。
4. `node tests/panel.mjs`：exit 0、无 FAIL；`browser_e2e_network 声明 limit / request_id / max_chars / timeout_ms / include_sensitive / tab_id`。
