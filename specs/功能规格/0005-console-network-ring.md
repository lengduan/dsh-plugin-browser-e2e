# 控制台与网络请求的事件环

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（「三层与被切分的文件」模块表里 `lib/page.js` 的职责条目、「进程内对象契约 · 标签页条目」、P3「`lib/browser.js`」表里未启动就读取 console / network 记录的条目、「已知结构性债务 · 展示格式化四处」）
代码: lib/page.js / lib/observation.js / lib/tools.js / tests/tools.mjs / tests/invariants.mjs

## 需求

页面运行中产生的控制台输出与网络请求需要可回读，供模型判断页面是否报错、哪个请求失败；读取只取尾部并带上限，页面换成新文档后旧记录不得混进新文档。

## 行为

### 缓冲与记录

- 每个标签页条目（`addPage` 创建）自带控制台与网络四个容器：`consoleRing`、`networkRing`、`networkByRequest`、`networkContext`（`request_id` → `{ request, response }`），初始都为空；对话框记录另见 `0022-dialog-handling.md`（`dialogRing` 独立于这两个环）；`nextNetworkSeq` 从 0 起，用于分配 `n<N>`。`attachPageHooks` 用 `session.hookedPages` 保证同一个 page 只挂一次监听，避免重复记账。
- 上限常量 `RING_LIMIT`（500，`lib/page.js` 导出）。`pushRing` 追加后若超过上限，从头部 `splice` 掉多出的最旧记录，保留最新。
- 控制台：`console` 事件记 `{ level, text, at }`，`level` 取 `msg.type()`（Playwright 消息类型原样透传，不做归一），`text` 经 `truncateText` 截到 `CONSOLE_TEXT_LIMIT`（2000 字符）并在末尾追加 `...(已截断)`，`at` 为 `nowAt()` 的 ISO 串。
- 未捕获异常：`pageerror` 记为 `level: 'error'`，`text` 取 `error.message`，同样截断。
- 网络：`request` 先建占位并压入 `networkRing`：
  - `{ request_id, url, method, status: 0, mimeType: '', failure: '', at }`，`status` 为 0 表示还没有拿到响应；`request_id` 是按标签页自增的 `n<N>`（`n1`、`n2` …），文档重置与环形淘汰都不复用；
  - 同一个对象同时以 request 为键存进 `networkByRequest`，所以 `response` 与 `requestfailed` 是原地改字段，不二次查 ring。
- `response`：用 `networkByRequest.get(response.request())` 取到记录后写 `status = response.status()`、`mimeType = headers()['content-type'] ?? ''`。
- `requestfailed`：取到记录后写 `failure = request.failure()?.errorText ?? 'request failed'`。
- `networkByRequest` 淘汰：`request` 事件数量可能远多于 response，Map 超过 `RING_LIMIT` 时按插入顺序删除最旧的键；ring 由 `pushRing` 独立淘汰，两者口径都是 `RING_LIMIT`。`networkRing` 淘汰最旧记录时同步删掉该记录的 `networkContext` 条目，关页 / 崩溃随标签页条目一起丢弃。

### 重置

- 判据是「主框架新文档请求」，由 `isNewDocumentRequest(request, page)` 判定：`request.isNavigationRequest()` 为真，且 `request.frame() === page.mainFrame()`；`frame()` 抛错（所属 frame 已 detach）时按 false 处理。
- 命中时先 `clearRings(entry)`（清空 `consoleRing` / `networkRing` / `networkByRequest` / `networkContext`；`request_id` 计数不归零，旧 id 不会被新文档的记录冒名顶替），再 `entry.refs.clear()`，之后才登记本次请求，因此新文档自身已发出的 document 与子请求不会被误删。
- `navigate` 另清两次：`goto` 之前 `clearRings(tab)` 与 `tab.refs.clear()`（导航失败也不让旧记录挂在新结果上），`goto` 与补票之后再次 `tab.refs.clear()`。
- 不重置的场景：SPA 路由变化、hash 变化不产生主框架 document 请求，事件环与 ref 表保留。`framenavigated` 只把 `entry.loading` 置回 true 并广播 `changed`，不碰 ring。

### 读取

- `consoleEntries(session, limit = 100, tabId, options = {})` 与 `networkEntries(session, limit = 100, tabId)` 先 `session.touch()` 刷新空闲计时，再经 `currentTab(session, tabId)` 取标签页（显式 `tab_id` 优先，缺省用 active）。`options.level` 可选（只对 console 生效），语义见 `0026-console-level-filter.md`。
- `limit` 口径：`Number.isInteger(limit) && limit > 0` 时取 `Math.min(limit, RING_LIMIT)`，否则回退 100。返回条数由 `ring.slice(-take)` 决定，最新在最后。给了 `level` 时先过滤后截尾；`take` 仍由 `limit` 决定，`matched` 是命中总数，`count` 是本次条数。
- 返回形状 `{ tabId, total, matched, count, level, entries, text, summary }`：`total` 是过滤前 ring 当前长度，`matched` 是按 `level` 过滤后的命中条数（未给 `level` 时等于 `total`），`count` 是本次返回条数 `Math.min(matched, take)`，`level` 是归一后的规范名（未给时为 `null`），`entries` 直接引用命中集合尾部 `count` 条记录对象。
- 控制台文本每行 `${timeOf(at)} ${level} ${oneLine(text)}`；网络文本每行由 `timeOf(at)`、`[${request_id}]`、`method`、`status`、`mimeType || '-'`、`url` 依次拼成，`status <= 0` 显示 `0(无响应)`，`failure` 非空时追加 `失败: ${failure}`。单条请求的请求头 / 请求体 / 响应头 / 响应体读取见 `0015-network-response-body.md`。
- `timeOf` 取 `at.slice(11, 23)`，即 ISO 串里的 `HH:MM:SS.mmm`（UTC，不是本地时区）；`oneLine` 把换行压成空格，保证一条记录占一行。
- 空记录文案：控制台 `（暂无控制台记录）`，网络 `（暂无网络记录）`。摘要：`控制台记录 N 条`、`网络请求 N 条`。控制台给了 `level` 且 `total > 0`、`matched === 0` 时文案为 `（缓冲 N 条记录，没有 level ≥ X 的条目）`；摘要为 `控制台记录 N 条（level ≥ X，命中 M 条 / 缓冲 T 条）`，未给 `level` 时摘要保持 `控制台记录 N 条` 逐字不变。
- 工具层（`browser_e2e_console` / `browser_e2e_network`）：参数为 `limit`（integer，缺省 100）、`tab_id` 与 console 专有的 `level`（string，取值与别名见 `0026-console-level-filter.md`）；`browser_e2e_network` 另有 `request_id` / `max_chars` / `timeout_ms` / `include_sensitive` 四个详情参数（传 `request_id` 时走详情分支，见 `0015-network-response-body.md`）。`args.limit ?? 100` 传给能力函数，`total > count` 时在摘要后追加 `（缓冲共 ${info.total} 条，只取尾部 ${info.count} 条）`，换行后接 `text`。控制台给了 `level` 且 `matched > count` 时 note 改为 `（命中 ${info.matched} 条，只取尾部 ${info.count} 条）`，否则为空串。两个工具用 `requireSession(sessionKey(exec))` 取会话，不经 `sessionOf` 创建会话。

## 边界

- 未启动读取：`requireSession` 内部走 `assertBrowserRunning`，报 `浏览器尚未启动，请先调用 browser_e2e_start`。console / network 属于用 `requireSession` 的只读工具，未启动时不会在会话表里留下 idle 条目（项目规格「已知结构性债务 · 会话解析入口不统一」）。
- `tab_id` 不存在：`currentTab` 走 `assertTabExists`，报 `tab ${tabId} 不存在，请先 browser_e2e_tabs 获取最新 tab_id`。
- `response` / `requestfailed` 找不到占位记录时直接返回、不补建：占位已被淘汰、或事件来自未挂钩的页，记录保持 `status: 0` / `failure: ''`。
- `limit` 边界：0、负数、非整数（小数 / 字符串）一律回退 100；大于 `RING_LIMIT` 的值按 `RING_LIMIT` 截断。
- 记录只存在进程内、挂在标签页条目上：关页即随条目消失，不落盘、不跨会话保留。
- 控制台级别过滤（`level`）：严重级别序 `debug < log < info < warning < error`，别名 `warn` 等同 `warning`；参数值先 `trim()` 再转小写，记录侧 `level` 走同一归一路径；给 `level` 时保留 `rank(entry.level) >= rank(level)` 的记录（`rank` -1 的不可判级类型例外，见下一条）。
- 不可判级类型（Playwright 的 `dir` / `table` / `trace` / `assert` 等五级之外的记录类型）`rank` 为 -1，任何 `level` 下都返回，不静默丢弃。
- 非法 `level` 报 `level 只支持 debug / log / info / warning / error（warn 等同 warning），收到 "<值>"；不传 level 则返回全部记录`，值用 `JSON.stringify` 渲染；校验顺序是先 `session.touch()` 与 `currentTab`，再归一 `level`，因此「未启动 / tab 不存在」优先于 `level` 错误；`level` 校验失败不读取、不修改任何记录。
- `matched` 上限是 `RING_LIMIT`（500）；`level` 生效时 `limit` 的 0 / 负数 / 小数 / 字符串回退 100 口径不变。
- 已知限制（代码注释明示）：`text` 取 `msg.text()`，是 Playwright 对 `args` 的序列化结果而不是原始对象；截断按字符数进行后再追加 `...(已截断)`，最终长度会超过 2000。
- 显示时区：`timeOf` 取 ISO 串的 UTC 段，同一瞬间与本地时区显示不同（项目规格「已知结构性债务 · 展示格式化四处」）。

## 验收

1. `node tests/tools.mjs`：exit 0、无 FAIL。相关 `check` 标签：
   - 用例 2：`捕获到 console.log`、`捕获到 console.warn`、`捕获到 pageerror`、`条目结构含 level / text / at`。
   - 用例 3：`记录到页面请求且 status=200`、`记录到 404 请求且 status=404`、`记录含 method / mimeType`、`导航清空旧记录（不含用例 2 的页面）`。
   - 用例 3B：`reload 后旧 console 记录不再出现`、`reload 后新文档 console 记录保留`、`reload 后旧网络记录不再出现`、`reload 后新文档自身请求保留（document + 子请求）`。
   - 用例 3C：`网络 event Map 不超过 RING_LIMIT`、`淘汰的是最旧请求（保留最后 RING_LIMIT 条）`、`网络 ring 同样只保留 RING_LIMIT 条`。
2. `node tests/invariants.mjs`：exit 0、无 FAIL。用例 K 的 `tools.js 的工具描述从常量插值，不写死默认值` 断言 `lib/tools.js` 引用 `RING_LIMIT` 且不出现 500 这样的缓冲上限字面量。
3. 未启动读取的底层断言由 `node tests/invariants.mjs` 用例 A 的 `没有会话时 assertBrowserRunning 报「尚未启动」` 覆盖。
4. 缺口（未验证，不据此判定通过）：`limit` 默认 100 与 clamp、非正整数回退、空记录文案、按 `tab_id` 分别读取两页时的事件环隔离，当前测试文件里没有对应用例。
5. 级别过滤（`0026-console-level-filter.md`）：`node tests/tools.mjs` 新增用例 2B「console 级别过滤」，check 名为 `debug / log / info / warn / error 五级全部记录`、`level=error 只回 error（含 pageerror）`、`level=warn 等同 warning（含 warning 与 error）`、`level=debug 不过滤（matched 等于 total）`、`不可判级类型在 level=error 下仍保留`、`先过滤后截尾（matched 大于 count，只回最新 count 条）`、`返回含 total / matched / count / level`、`level 生效时摘要写明命中与缓冲`、`无命中文案与暂无记录文案可区分`、`非法 level 报错且不改记录`。
6. `node tests/panel.mjs` 用例 C 新增 `browser_e2e_console 的 level 参数声明枚举`：enum 含 `debug` / `log` / `info` / `warning` / `error` / `warn`，且 `limit` / `tab_id` 仍在 properties。
7. `npm run test:unit` 的 `tests/invariants.mjs` 新增用例 L「console 级别归一与排序」，用例 K 增补「工具描述从常量插值」对 `CONSOLE_LEVELS` 的断言。
8. 默认不传 `level` 时，用例 2 / 3 / 3B / 3C / 3D / 3E 的 `total` / `count` / `text` / 摘要文案逐字不变。
