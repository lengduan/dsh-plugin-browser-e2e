# 参考 OpenManus 的浏览器操控待开发项

状态: 待评估（backlog，未立项、无代码改动）
基线: 本仓 `50b6a15`（30 个 `browser_e2e_*` 工具）；OpenManus `3309bf4`（2026-08-16，主分支浅克隆）
一手材料: `.scratch/openmanus-study/OpenManus`（`.scratch/` 不入库；复核用 `git clone --depth 1 https://github.com/FoundationAgents/OpenManus.git`）
关联: `0001-architecture-invariants.md`（不变量）、`0003-决策记录.md`（已否决项，本文引用不覆盖其结论）

本文只记录「未来可能参考 OpenManus 完善浏览器操控能力」的候选方向，不是已定案规格：

- 与既有决策冲突的项（B2、B3、C 组）在本文只做事实记录，不改变 `0003` 的结论；要动先在本文登记待评估项并取得决策，`0003` 只读不回填。
- 选一项立项时，先写功能规格（`specs/功能规格/NNNN-<slug>.md`，现有最大编号 `0038`），再改代码；验收标准写在那份规格里，本文不写。
- 引用实现一律写「文件 + 符号名」不写行号；`0003` 的否决理由不复述，只给编号。

## 一、OpenManus 的浏览器操控做法

OpenManus 有两条并存的浏览器通路，能力与实现完全不同，不能混着看。

**通路 1：Browser Use CLI 3.0（MCP，manus 默认路径）**

- `app/agent/manus.py` 的 `_BROWSER_USE_SERVER_ID` / `_BROWSER_USE_COMMAND` / `_BROWSER_USE_ARGS` 把 `uvx browser-use --cli-mcp` 作为默认 MCP server 拉起；`_BROWSER_USE_TRANSPORT_INSTRUCTIONS` 告诉模型把 Browser Use skill 里的 `browser-use <<'PY'` 换成 `browser_exec` 的 Python body。
- `app/agent/browser.py` 的 `BrowserAgent.initialize` 建立 stdio 连接；模型侧只有 `browser_exec` 与 `browser_screenshot` 两个工具，外加 Browser Use 的 canonical skill，两者共用同一个持久 browser-harness 会话。
- 结果：工具面只有两个工具，复杂交互靠「写驱动层 Python 脚本」完成。这是它用小工具面覆盖大量交互的原因（`README.md`「Browser automation」节）。

**通路 2：沙箱浏览器（sandbox_agent + Daytona）**

- `app/agent/sandbox_agent.py` 用 `SandboxBrowserTool`，`BrowserContextHelper` 为其附带状态回填；README 说明操作过程可通过 VNC 链接看到（`README.md` 的 sandbox 段）。
- `app/agent/browser.py` 的 `BrowserContextHelper.get_browser_state` / `format_next_step_prompt`：每步取 `get_current_state()` 的 `url` / `title` / `tabs` / `pixels_above` / `pixels_below`，并把返回的 base64 截图作为 user message 追加进 memory，下一步提示里带当前地址、标签页数与视口上方/下方内容量。
- `app/prompt/browser.py` 的 `SYSTEM_PROMPT` / `NEXT_STEP_PROMPT` 是这条通路的动作模型：输入只列可交互元素 `[index]<type>text</type>`，非交互元素仅作上下文；一次可提交多个动作组成的序列，有 `max_actions` 上限，「某个动作让页面显著变化时序列被打断、返回新状态」；另有 `done`、`extract_content`、`scroll_up/down`、`go_to_url`、`click_element`、`input_text` 等动作名。

**其它相关实现**

- `app/tool/computer_use_tool.py` 的 `ComputerUseTool`：桌面级坐标操控，`action` 覆盖 `move_to` / `click` / `scroll` / `typing` / `press` / `wait` / `mouse_down` / `mouse_up` / `drag_to` / `hotkey` / `screenshot`，带 `x` / `y` / `button` / `num_clicks` / `amount` / `text` / `key` / `keys` / `duration`。
- `app/tool/ask_human.py` 的 `AskHuman`：同步 `input()` 向人提问，用于验证码之类的人工步骤。
- `app/tool/mcp.py` 的 `MCPClients.connect_stdio` / `_initialize_and_list_tools` / `server_instructions`：工具面由外部 MCP server 提供，支持工具名前缀与 server instructions 注入。
- `app/tool/crawl4ai.py` 的 `Crawl4aiTool`：网页抓取并输出 markdown / AI-ready 正文。
- 外部文档（不在 OpenManus 仓内）：browser-use 的 `Agent.load_and_rerun` 支持保存成功轨迹后重放、不逐步调模型（`https://github.com/browser-use/browser-use` README）。

## 二、候选待开发项

分级按「改动面 × 收益」：P1 是小改动、与现有契约不冲突；P2 需要设计取舍；「待决策」是触碰既有契约、须先取得用户决策并记录到本文。

### A 组：与现有架构不冲突

**A1 动作后的视觉状态回填（P2，成本主要在图片体积）**

- 本仓现状：`browser_e2e_screenshot` 只在被调用时落盘并（`attachments` 可用时）返回图片块；动作类工具返回文本，不附画面。模型想知道点击后的视觉结果必须再调一次截图，多一次往返。
- OpenManus：`BrowserContextHelper.format_next_step_prompt` 每步把 base64 截图追加进 memory（通路 2），状态文本含 `pixels_above` / `pixels_below`。
- 可借鉴：把「最近一次动作后的画面」做成工具结果的一部分。风险是本仓截图上限（单边 8192、总像素 4194304）与每步一图的上下文成本，需要实测。
- 建议：不做无条件自动截图；先给 `snapshot` 或交互类工具加可选开关（默认关），并把缩略图尺寸上限写进功能规格。

**A2 只列可交互元素的读取模式（P1）**

- 本仓现状：`browser_e2e_snapshot` 全 DOM 上限 `SNAPSHOT_LIMIT`（4000 节点），体积是 README「已知限制」里写明的痛点；`delta` 与 `query` 是压缩手段，但没有「只列可交互元素」这一档。
- OpenManus：`app/prompt/browser.py` 的 `SYSTEM_PROMPT` 输入格式只给交互元素编号，非交互元素仅作上下文。
- 建议：`snapshot` 或 `read` 增 `interactiveOnly`（按 role / 可操作性过滤），落在快照扫描脚本与参数校验，不碰 ref 表契约。需在功能规格里定义「可交互」判定表，避免与 `read` 的 controls 语义重叠。

**A3 带元素编号的截图（P2）**

- 本仓现状：快照节点已带 `box`（CSS 像素），`click` / `hover` / `drag` 支持 `x`+`y`；但截图里没有编号，模型无法把画面上的元素与 ref 对应。
- OpenManus：`SYSTEM_PROMPT` 第 6 条「元素序号标在包围盒右上角」；`ComputerUseTool` 的 `screenshot` 供视觉定位。
- 建议：截图增可选叠加编号（`overlay: 'refs'`）。实现方式要先定：页面内注入绘制会改页面 DOM，宿主侧合成需要图像处理依赖；CDP 的 `Page.captureScreenshot` 从本仓既有用法看只接受区域与缩放，是否支持叠加未核对协议文档。三种都要评估对本仓「不向页面注入内容」的影响面。成本最高，优先级最低。

**A4 固定时长等待（P1）**

- 本仓现状：`browser_e2e_wait` 四选一（`selector` / `expression` / `url` / `response`），没有「纯等 N 毫秒」；只能靠 `evaluate` 跑 `await new Promise(r => setTimeout(r, n))` 绕。
- OpenManus：`ComputerUseTool.parameters` 的 `wait` 动作 + `duration`（默认 0.5 秒）；`SYSTEM_PROMPT` 里也有「页面未加载完用 wait 动作」。
- 建议：`wait` 增 `durationMs`，与四条件互斥。风险是鼓励偷懒等待，README 需写明优先条件等待。

**A5 鼠标按下 / 抬起分离（P2，低优先）**

- 本仓现状：`click` 有 `button` / `clickCount` / `modifiers`，`press` 有键盘 `action=down/up`，`drag` 是一次性按下-移动-抬起。没有鼠标 `down` / `up` 分离。
- OpenManus：`ComputerUseTool` 的 `mouse_down` / `mouse_up`。
- 建议：只在 `drag` 覆盖不了「按住不放、跨多次调用移动」的特殊交互时才做；若做，必须定义释放兜底（参照 README「按住键会残留」的同一问题）。

### B 组：需要设计取舍

**B1 动作序列的页面变化中断（P2）**

- 本仓现状：`browser_e2e_recipe`（`lib/recipe.js` 的 `runRecipe`）支持 1-20 步声明式步骤，首个失败即停、不回滚；没有「页面显著变化就跳过剩余步骤」的语义，也没有 `max_actions` 之外的分支控制。
- OpenManus：`SYSTEM_PROMPT` 的「动作序列 + 页面变化打断序列、返回新状态」；`max_actions` 限制一次提交的步数。
- 建议：`recipe` 增可选 `stopOnPageChange`（导航或主文档变化后跳过剩余步骤，返回已执行/已跳过清单）。改动集中在步骤执行循环与报告，但「页面显著变化」的判据要写清（本仓已有 ref 表清空与事件环重置，可复用）。

**B2 动作轨迹的结构化记录与重放（待决策）**

- 本仓现状：`lib/history.js` 只落 `seq` / `at` / `tool` / `ok` / `summary` / `session`，不记入参原文与返回值（README「动作历史的边界」明文），脱敏只覆盖 `SENSITIVE_ARGS` 里的字段；因此无法重放。
- OpenManus：OpenManus 自身不重放；browser-use 提供 `Agent.load_and_rerun`（外部文档），可保存成功轨迹后用新变量重跑。
- 冲突：要重放必须先记入参原文，与现有「不记录入参、字段级脱敏」的边界直接冲突，也与 `0003` #10 的 B/C 切片（宿主动作环，已否决）立场相邻。做之前先在本文登记决策项（`0003` 是只读决策史，不回填），定结构化入参范围、脱敏表与 opt-in 开关。

**B3 驱动层脚本逃生口（待决策，与 `0003` #9 同性质）**

- 本仓现状：`browser_e2e_evaluate` 只跑页面内 JS，`browser_e2e_recipe` 是声明式数据；没有在 Playwright / 驱动层执行调用方脚本的通路。
- OpenManus：通路 1 的 `browser_exec`（模型传 Python body，持久 harness 会话）就是这条通路，也是它两个工具覆盖大量交互的原因。
- 冲突：`0003` #9 已否决「原始 CDP 逃生口」，`0003` #12 F 已否决「门面式 index + call 工具面」，两条理由都指向绕过既有不变量与门控。B3 是同一性质的第二条动作通路；若要做，先在本文登记门控模型重新决策项并取得结论（现有 `observe` / `interact` / `script` 装不下）。

### C 组：不建议借鉴

- **C1 桌面级 computer use**：本仓定位是浏览器 e2e（`0001`），桌面鼠标键盘与桌面截图归宿主或其它插件；浏览器内坐标点击本仓已有（`click` 的 `x`+`y`）。
- **C2 托管云浏览器 / 远程浏览器**：OpenManus 的 `BROWSER_USE_API_KEY` / `BU_CDP_URL` 与 Daytona 沙箱与「本机系统 Edge/Chrome + 右侧面板」的定位（`0002`、`0034`）冲突；「接已有浏览器」本仓已由 CDP 接管覆盖（`0008`）。
- **C3 可插拔 MCP 工具面**：本仓是固定工具表（`lib/tools.js`），工具面由插件定义；引入 MCP server 桥会新增一层进程与生命周期管理，收益不抵成本。
- **C4 crawl4ai 抓取**：`browser_e2e_fetch` 已覆盖浏览器内取正文，`read` / `recipe.extract` 覆盖结构化提取；crawl4ai 的 markdown 化与 LLM 抽取属模型侧处理，不是工具缺能力。
- **C5 ask_human**：本仓 `captcha_check` + `wait_for_human` 已是轮询、完成信号、超时不算错误的形态，比同步 `input()` 更适合无头与远程场景。

### 已覆盖、无需借鉴

元素索引（本仓 `snapshot` 的 ref `@N`）、多标签页（`tabs` / `navigate` 的 `new_tab`）、人工介入（`wait_for_human`）、接已有浏览器（CDP 接管）、截图附件、下载、网络与控制台取证、组合键（`press` 支持 `Control+A` 形式）。

## 三、推进方式

1. 按 `AGENTS.md`「做需求前先读规格」的流程，从 A 组或 B1 里选一项写功能规格（编号从 `0039` 起）。
2. A 组可合并为一份（同属交互辅助、零协议改动）；B1 单独一份；B2 / B3 先在本文登记决策项并取得结论，未决策前不实现。
3. 每项实现后在 README「Known Limitations and Deferred Work」与本文同步状态（已实现 / 已否决 / 仍待评估），避免两处口径漂移。
