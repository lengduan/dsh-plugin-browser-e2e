# 多步脚本 / recipe

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表、依赖方向、P3「单次 / 运行时」分类、进程回收口径）；specs/项目规格/0002-panel-protocol-v1.md（一次调用只产生一条既有 `action` 事件，不改协议）；specs/功能规格/0004-snapshot-and-ref-table.md（ref 表按页隔离、导航清空 ref）；specs/功能规格/0007-click-fill-targets.md（ref / selector / x + y 三选一与报错口径）；specs/功能规格/0013-wait-url-and-response.md（wait 的四类条件与超时口径）；specs/功能规格/0017-structured-read.md（结构化读取与本项 `extract` 的分工）；specs/功能规格/0019-evaluate-timeout.md（页面脚本求值边界，本项不提供脚本步骤）；specs/功能规格/0023-tool-permission-gating.md（门控待决策，本项不新增脚本执行面）；specs/功能规格/0027-assert-tool.md（断言工具与本项「步骤失败不抛错」的并列口径）
代码: lib/recipe.js / lib/tools.js / lib/page.js / tests/recipe.mjs / README.md

本项范围只到**声明式步骤**：一步 = 一次既有页面动作，步骤种类固定为 `navigate / wait / click / fill / press / hover / scroll / extract`。**不含任意脚本执行**：没有 `evaluate` 步骤，`wait` 步不接受 `expression` 条件，也不接受 UserScript / 宿主 Node 脚本。任意脚本执行（anweat `script.run_userscript`、Fisfzy `ego_script` 语义）另判「影响大 → 待决策」，候选与影响面见 `.scratch/browser-plugin-survey/plans/20-recipe-script.md` §1 与 §6.5，不在本规格契约内。

## 需求

一串固定操作（登录 → 填表 → 提交）现在必须拆成 N 次工具调用：每次一个动作、一次往返、一条面板 `action`，中途某步失败后模型要从上下文里自己拼出「走到哪一步、哪一步错了」。本功能新增 `browser_e2e_recipe`：一次调用按顺序执行 1-20 个声明式步骤，首个失败即停，返回逐步结果与失败步号，已执行步骤不回滚。

收益：往返次数与上下文增长按步数收敛；失败位置与已完成前缀由返回值给出，不靠模型回忆；步骤是数据不是代码，可复用既有页面的全部校验与安全口径。

## 行为

### 输入

工具 `browser_e2e_recipe`：

| 参数 | 类型 | 约束 |
|---|---|---|
| `steps` | array | 必填；1-20 步；每步是一个对象，`type` 必填 |
| `tab_id` | string | 可选；缺省 active tab；一次调用的全部步骤作用于同一个标签页 |
| `timeoutMs` | integer | 可选；整次调用的总预算，`1000`-`120000`，默认 `60000` |

步骤字段（`type` 决定可用的字段；给不属于该类型的字段直接报错，不静默忽略）：

| type | 必填 | 可选 | 复用实现 |
|---|---|---|---|
| `navigate` | `url` | `waitUntil`（load / domcontentloaded / networkidle，默认 load） | `page.js` 的 `navigate` |
| `wait` | `selector` / `url` / `response` 三选一 | `state`（仅 selector）、`urlMatch`（url / response）、`responseMethod` / `statusMin` / `statusMax` / `includeBuffered` / `failOnRequestFailed`（仅 response）、`timeoutMs`（1000-60000，默认 10000） | `page.js` 的 `waitFor` |
| `click` | `ref` / `selector` / `x` + `y` 三选一 | — | `page.js` 的 `click` |
| `fill` | 三选一 + `value`（字符串，可空串表示清空） | `mode`（insert / keystrokes，默认 insert）、`delayMs`（仅 keystrokes，0-1000） | `page.js` 的 `fill` |
| `press` | `key` | — | `page.js` 的 `press` |
| `hover` | 三选一 | `settleMs`（0-5000，默认 300） | `page.js` 的 `hover` |
| `scroll` | `delta_x` / `delta_y` 至少一个非 0 | `x` + `y`（视口坐标，须同时给） | `page.js` 的 `scroll` |
| `extract` | — | `selector`（缺省 `body`）、`mode`（text / html / links / attribute，默认 text）、`attribute`（`mode=attribute` 时必填）、`limit`（1-200，默认 100，仅 links） | `lib/recipe.js` 内固定页内脚本，代码不来自调用方 |

字段名与对应工具的顶层参数同名（`click` 的 `ref/selector/x/y`、`wait` 的 `selector/state/urlMatch` 等），不另立一套命名。

### 校验

**一级（`normalizeRecipe`，任何页面调用之前完成，失败即抛错、一个动作都不执行）**：`steps` 类型与条数；每步是对象；`type` 是否在枚举；每步字段是否属于该 `type`；必填是否非空；枚举值与数字区间；三选一（`click` / `fill` 用 `page.js` 的 `targetOf`，`hover` 用 `requireTarget`，报错原文加「第 `<i>` 步（`<type>`）：」前缀）；`wait` 的条件个数先按 `selector` / `url` / `response` 判（`expression` 不在可选之列），条件内部参数再交 `page.js` 的 `waitConditionOf` 校验；`extract` 的 `mode` / `attribute` / `limit` 耦合；`timeoutMs` 范围。

**二级（步骤执行时，由被复用的能力函数自己判）**：`fill` 的 `mode` ↔ `delayMs` 耦合与逐键字符上限、坐标越界、selector 语法、ref 失效与元素不可见等。这类违规表现为该步失败（不另写一套校验，保持单一来源）。

一级错误文案（`i` 从 1 起）：

| 情形 | 文案 |
|---|---|
| `steps` 不是数组 | `steps 必须是数组（1-20 步），收到 <type>` |
| 条数为 0 或大于 20 | `steps 必须是 1-20 步，收到 <n> 步` |
| 某步不是对象 | `第 <i> 步必须是对象` |
| `type` 缺失 | `第 <i> 步缺少 type（可选 navigate / wait / click / fill / press / hover / scroll / extract）` |
| `type` 非法 | `第 <i> 步的 type "<v>" 不支持，可选 navigate / wait / click / fill / press / hover / scroll / extract` |
| 字段不属于该类型 | `第 <i> 步（<type>）不接受字段 <names>；该步骤可用字段：<allowed>` |
| `wait` 给 `expression` | `第 <i> 步（wait）不接受 expression 条件：recipe 不执行调用方提供的页面脚本；需要页面内脚本条件请单独调用 browser_e2e_wait 或 browser_e2e_evaluate` |
| `wait` 条件个数不是 1 | `第 <i> 步（wait）必须且只能给 selector / url / response 之一，当前收到：<names 或 无>` |
| `navigate` 缺 `url` | `第 <i> 步（navigate）缺少 url（非空字符串）` |
| `fill` 缺 `value` | `第 <i> 步（fill）的 value 必须是字符串（空串表示清空），收到 <type>` |
| `press` 缺 `key` | `第 <i> 步（press）缺少 key（非空字符串）` |
| `scroll` 全 0 | `第 <i> 步（scroll）的 delta_x / delta_y 至少有一个非 0，否则页面不会滚动` |
| `extract` 属性模式缺 `attribute` | `第 <i> 步（extract）的 mode=attribute 需要 attribute（非空字符串）` |
| `timeoutMs` 越界 / 非整数 | `timeoutMs 必须是 1000 到 120000 之间的整数（毫秒），收到 <v>` |

`wait` / `click` / `fill` / `hover` 的既有文案由 `page.js` 的 `waitConditionOf` / `targetOf` / `requireTarget` 原样给出（例如 `点击目标只能给一种：ref / selector / x + y 三选一，避免点错位置`），只在前面加步骤前缀，不在本模块重写。

### 输出

工具返回渲染后的多行文本，首行是摘要（`lib/tools.js` 的 `summaryOf` 取首行做面板动作摘要）：

- 全部完成：`recipe 完成：<completed>/<total> 步（标签页 <tabId>，耗时 <ms>ms，输出 <k> 项）`
- 步骤失败：`recipe 在第 <i> 步（<type>）失败：<completed>/<total> 步已完成，已执行步骤不回滚（标签页 <tabId>，耗时 <ms>ms）`
- 预算耗尽（下一步之前）：`recipe 超出总预算 <timeoutMs>ms：在第 <i> 步前停止，已完成 <completed>/<total> 步，已执行步骤不回滚（标签页 <tabId>）`
- 预算耗尽（末步之后才发现）：`recipe 全部 <total> 步已执行，但总耗时 <ms>ms 超出预算 <timeoutMs>ms（标签页 <tabId>）`
- 标签页关闭：`recipe 中断：标签页 <tabId> 在运行时关闭，已完成 <completed>/<total> 步，已执行步骤不回滚`

其后每条一行：`PASS [<i>] <type>：<该步摘要>` / `FAIL [<i>] <type>：<失败原因>`；有 `extract` 输出时追加 `输出 [<i>] extract（<mode>）：<value>`。失败时文末追加一行 `失败的步骤不回滚；调整后可从剩余步骤继续，已执行过的步骤不要重复。`

`runRecipe` 返回的结构化报告（`renderRecipeReport` 消费它；`browser_e2e_recipe` 的 `run` 不读字段，只返回字符串）：

```
{
  ok: boolean,        // 仅 status === 'completed'
  status: 'completed' | 'step_failed' | 'budget_exceeded' | 'page_closed',
  total, completed,   // 整数；completed 只计成功完成的步
  tabId, url,         // url 为结束时 page.url()，取不到时为空串
  elapsedMs, timeoutMs,
  steps: [{ index, type, ok, elapsedMs, summary?, message? }],   // 只含已执行步骤
  outputs: [{ step, type: 'extract', mode, value, truncated }],
  outputsTruncated: boolean,
  failedStep?: { index, type, message },
  summary
}
```

`extract` 的 value 一律是字符串；所有输出合计上限 20000 字符（`RECIPE_OUTPUT_TEXT_LIMIT`），被裁剪的输出条目 `truncated: true` 且顶层 `outputsTruncated: true`，渲染文末追加 `（输出已截断：上限 20000 字符）`。

### 状态变化

- 会话：不新增字段、不改状态机；入口经 `sessionOf` 刷新空闲计时，**每个步骤开始前再调一次 `session.touch()`**，使「一次 recipe」与「N 次工具调用」的活性口径一致。
- 标签页：`navigate` 步沿用既有语义（清空 ref 表、控制台 / 网络环、快照基线，并把该页设为 active）；其余步骤只作用于 `tab_id` 指定的页，不改 `activeTabId`。不写 `refs`、不写 `snapshotBaselines`、不清环。
- 面板：整次调用只产生一条既有 `action` 事件（摘要为报告首行），失败时按 `lib/index.js` 的既有包装广播 `失败：<一级校验文案>`；tab 列表、投屏目标、面板配置不变。
- 浏览器进程：不重启、不关闭；isolated 与 cdp 行为一致（步骤只调页面能力，与载体无关）。
- 磁盘：本工具不落盘（`screenshot` / `download` / `upload` 都不是步骤）。

## 边界

- **不做任意脚本执行**：无 `evaluate` 步骤、`wait` 不接受 `expression`；这是本项的安全边界，不因后续步骤类型扩张而放宽（新增脚本步骤需要先做 P1-14 门控决策）。
- **首个失败即停**，不重试、不跳过、不回滚；已产生的页面副作用（导航、填值、提交）保留。
- **步骤失败不抛错**，由 `ok: false` 与 `failedStep` 表达；只有一级校验、浏览器未启动、`tab_id` 不存在、入口时页面已关闭才抛错。理由与 `0027` 相同：已执行前缀是事实，抛错会把结构化报告丢掉。
- `ref` 只在「recipe 开始前最后一次 `browser_e2e_snapshot`」之后有效；含 `navigate` 步骤的 recipe 里，其后的 `ref` 步必然报 `ref @N 不存在`（`navigate` 清空 ref 表），此时只能用 `selector` / `x + y`。recipe 自己不产生 ref。
- 一个 recipe 只作用于一个标签页：没有 `new_tab`、没有 `tab_id` 切换、没有 `close_tab` / `start` / `close` 步骤，也没有嵌套 recipe。
- 预算只在**步骤之间**检查；正在执行的 Playwright 动作无法中断，单步可超出总预算，末步之后补一次检查并如实报 `budget_exceeded`。`wait` 步的实际超时取 `min(步 timeoutMs, 剩余预算)`，因此预算将尽时通常表现为该步等待超时（错误文案里的「上限」是被截断后的值）。
- 空闲回收：`DSH_BROWSER_IDLE_MS` 小于单步最长耗时（如 `wait` 的 60000ms）时，浏览器可能在步骤执行期间被回收，随后调用报「浏览器尚未启动或没有可用标签页」——与 `0001` 已记录的 `browser_e2e_wait` 同类边界，规避方式相同。
- `extract` 只读主文档：`document.querySelector` 不穿透 shadow DOM、不进入 iframe（iframe 待 P1-9）；`links` 模式只取 `a[href]` 的前 `limit` 条；`text` 取 `innerText`（渲染后可见文本），不做可读性清洗（`article-clean` / JSON-LD 不属本项，见 `0017`）。
- 与其它工具的分工：要一次判定多条断言用 `browser_e2e_assert`（`0027`）；要一次拿结构化 controls / links / tables / forms 用 `browser_e2e_read`（`0017`）；要执行页面脚本用 `browser_e2e_evaluate`（超时上限见 `0019`）。recipe 不复制这三者的语义。
- 不提供：分支 / 循环 / 变量 / 步骤间取值传递；失败重试；并行步骤；步骤级截图；`drag` / `upload` / `download` / `dialog` 步骤；跨 tab 步骤。
- 权限门控（P1-14）尚未实现：将来门控需要把 `browser_e2e_recipe` 按**当次步骤集合**定性（含 `click` / `fill` / `press` / `hover` / `scroll` 即为 `interact`，否则 `observe`），与 `wait` 带 `expression` 的按参数升级同类；本项不预做该判定。

## 验收

1. `node tests/recipe.mjs`（tester 新建，用例名由本规格固定）exit 0、`FAIL 0`，纯校验与渲染组（不启动浏览器）：
   - `recipe 常量与工具描述一致`（`RECIPE_MAX_STEPS` / `RECIPE_DEFAULT_TIMEOUT_MS` / `RECIPE_MIN_TIMEOUT_MS` / `RECIPE_MAX_TIMEOUT_MS` / `RECIPE_OUTPUT_TEXT_LIMIT` 与工具描述、README 表述一致）。
   - `steps 非数组报错`、`steps 为空或超过 20 步报错`、`单步不是对象报错`、`type 缺失或非法报错`、`步骤带未知字段报错并列出可用字段`。
   - `wait 步不接受 expression 条件`、`wait 步三选一必须且只能给一个`、`wait 步 timeoutMs 越界报错`。
   - `click 步三选一报错（0 个）`、`click 步三选一报错（2 个）`、`fill 步缺 value 报错`、`hover 步 settleMs 越界报错`、`scroll 步两个方向都为 0 报错`、`extract 步 attribute 模式缺 attribute 报错`、`extract 步 limit 越界报错`。
   - `timeoutMs 越界与非整数报错`、`合法 recipe 归一化后保留步序与字段`、`校验失败不产生任何页面调用`（假 session）。
   - `renderRecipeReport 四种摘要文案`、`renderRecipeReport 逐步 PASS / FAIL 行`、`renderRecipeReport 截断输出到 20000 字符`、`summaryOf 取 recipe 报告首行`。
2. 同文件执行组（真起无头 Edge，本地 `node:http` 夹具页面）exit 0、`FAIL 0`：
   - `recipe 登录链路导航等待填写点击全部完成`（`ok: true`、`completed === total`、`status: 'completed'`）。
   - `recipe 首步失败后不再执行后续步骤`（`steps.length === 1`、`status: 'step_failed'`）。
   - `recipe 步骤失败返回结构化报告且不抛错`（`ok: false` 且 `failedStep.index` 正确）。
   - `recipe 含 navigate 时后续 ref 步报 ref 不存在`。
   - `recipe wait 步命中 selector`、`recipe wait 步超时按步骤失败返回`。
   - `recipe 总预算耗尽在下一步前停止`（`status: 'budget_exceeded'`，`completed < total`）。
   - `recipe extract 取文本 / 链接 / 属性三种模式`、`recipe extract 未命中元素报步骤失败`。
   - `recipe 只作用于指定 tab_id`、`recipe 不写 ref 表与快照基线`。
   - `recipe 页面被关闭时报告 page_closed`（`status: 'page_closed'`，`completed` 为已完成前缀）。
3. `node tests/tools.mjs` exit 0、`FAIL 0`：`注册的工具与工具表逐项一致` 与 `工具名唯一且统一带 browser_e2e_ 前缀` 不回退（工具表新增一项，断言从表派生）。
4. `node tests/panel.mjs` exit 0、`FAIL 0`：`作用于页面的工具都接受 tab_id` 的检查列表纳入 `recipe` 后通过；参数契约用例不回退。
5. `npm run test:unit` exit 0；`npm run test:integration` exit 0（串行真起无头 Edge，进程类断言以回落到运行前基线为准）。跑全量前先确认 `tests/dialog.mjs` 存在：读取时点（2026-11-08 02:50，HEAD `a722fea` + P1-13 未提交改动）`package.json` 的 `test:integration` 已引用该文件而文件尚未创建，缺失时全量门禁不可用，属外部并行改动，不是本项缺陷。
