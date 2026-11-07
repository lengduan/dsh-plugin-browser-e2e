# 悬停与拖拽

状态: 已实现
关联: specs/项目规格/0001-architecture-invariants.md（模块表 `lib/page.js` / `lib/tools.js`、进程内对象契约「能力函数返回值」、ref 相关不变量 `assertRefBelongsToTab` / `assertRefRevalidated`）；specs/项目规格/0002-panel-protocol-v1.md（事件表 `action`：工具动作以 `{tool, summary, at}` 广播到面板）
代码: lib/page.js / lib/tools.js / tests/tools.mjs / tests/panel.mjs

## 需求

悬停展开菜单/提示、拖拽排序与滑块需要完整的可信指针事件链。用 `evaluate` 合成事件时 `isTrusted` 为 false，页面会拒绝，验证会假通过；新增两个工具把这两类动作交给 Playwright 的真实鼠标输入，并沿用 `browser_e2e_click` 的三种定位语义。

## 行为

### `browser_e2e_hover`

- 输入（除 `tab_id` 外均作用于目标解析）：
  - `ref`（`@N`）/ `selector`（CSS 选择器）/ `x` + `y`（视口 CSS 像素）三选一，判定口径与 `browser_e2e_click` 一致：空串视为未给，`x` 与 `y` 都是有限数字才算坐标目标，0 种或多于 1 种都报错；`tab_id` 缺省用当前 active tab。
  - `settleMs`：悬停后等待页面反应的毫秒数，整数区间 0-5000，缺省 300；`0` 表示不等待，越界或非整数报错。
- 输出：`{ mode, ref, tag, name, selector, x, y, settleMs, summary }`，`mode` 为 `ref` / `selector` / `point`，按分支只带对应字段；`summary` 分别为 `悬停 ${ref} (${tag} "${name}")`、`悬停 selector "${selector}"`、`悬停坐标 (${x}, ${y})`。工具层在摘要后追加一行 `悬停后页面可能变化，如需操作新出现的元素请重新 browser_e2e_snapshot。`
- 目标与动作：
  - `ref`：先 `assertRefBelongsToTab` 查本页 ref 表，再 `revalidateRef` 复验（xpath 仍命中且宽高为正），通过后 `scrollIntoViewIfNeeded()`，最后 `locator.hover({ timeout: 10000 })`。
  - `selector`：`locator.waitFor({ state: 'visible', timeout: 5000 })` 后 `hover({ timeout: 10000 })`。
  - `x` + `y`：`assertPointInViewport` 校验后 `page.mouse.move(x, y)`，是真实鼠标移动，点中哪个元素由页面决定。
  - `settleMs > 0` 时动作后 `page.waitForTimeout(settleMs)`，让 CSS `:hover` 过渡与 `mouseover` 处理器先落定再返回。
- 状态：不写 ref 表、不改会话状态机、不动标签页与进程；面板只多一条 `action` 广播（工具名 + 摘要）。

### `browser_e2e_drag`

- 输入：
  - `from` 与 `to` 必填，各是一个目标对象，内部同样是 `ref` / `selector` / `x` + `y` 三选一；源与目标分别判定，缺一种或多于一种都报错。
  - `steps`：mousedown 之后、mouseup 之前发出的插值 `mousemove` 次数，整数区间 1-60，缺省 12；`1` 表示只在目标位置发一次移动。
  - `settleMs`：释放后等待页面更新的毫秒数，整数区间 0-5000，缺省 300。
  - `tab_id` 可选，缺省当前 active tab。
- 输出：`{ fromMode, toMode, path, steps, settleMs, from, to, summary }`；`path` 为 `dragTo`（两侧都是元素目标）或 `mouse`（任一侧是坐标）；`from` / `to` 按分支带 `ref` + `tag` + `name`、`selector` 或 `x` + `y`；`summary` 形如 `拖拽 @3 (li "A") → @6 (li "C")（steps=12）`。工具层在摘要后追加 `拖拽后 DOM 可能已重排，请重新 browser_e2e_snapshot 再继续。`
- 预检（全部在按下鼠标之前完成）：
  - 两侧 `ref` 都先 `assertRefBelongsToTab` + `revalidateRef`；任一侧失效直接报错，不产生任何鼠标事件。
  - 两侧 `selector` 都先 `waitFor({ state: 'visible', timeout: 5000 })`。
  - 坐标侧先过 `assertPointInViewport`。
- 动作路径：
  - 两侧都是元素目标：`locator(from).dragTo(locator(to), { steps, timeout: 10000 })`。由 Playwright 完成源的 actionability、`mousemove → mousedown → 带 steps 的 mousemove → mouseup`；Chromium 下 Playwright 的拖拽拦截会把这些移动转成原生 `dragenter` / `dragover` / `drop`，因此 HTML5 `draggable` 与监听 pointer 事件的页面走同一条真实输入链。
  - 任一侧是坐标：手写 `page.mouse` 序列。源为元素时 `scrollIntoViewIfNeeded()` + `hover({ timeout: 10000 })` + `boundingBox()` 中心；源为坐标时校验后 `mouse.move`。随后 `mouse.down()`；目标为元素时 `scrollIntoViewIfNeeded()` + `boundingBox()` 中心（未命中或零尺寸报错），目标为坐标时校验后用 `mouse.move(center, { steps })`；最后 `mouse.up()`。`mouse.down()` 成功后用 `try/finally` 保证异常时也补一次 `mouse.up()`，避免按键卡在按下状态污染后续调用。
  - `dragTo` 路径若在源已按下后失败（例如目标在动作中途被移除），包装层在 `catch` 里 best-effort 调一次 `page.mouse.up()` 再原样抛出 Playwright 错误；不吞错、不改写错误文案。
  - `settleMs > 0` 时释放后 `page.waitForTimeout(settleMs)`。
- 状态：不写 ref 表、不改会话状态机；动作可能改变 DOM，旧 ref 是否仍有效由下一次 `revalidateRef` 判定；面板只多一条 `action` 广播。

### 与既有语义的关系

- 两种工具都复用 `browser_e2e_click` 的定位语义、ref 查表 / 复验口径与坐标越界文案，不新增协议字段、不改面板只读定位、不改客户端 bundle。
- 拖拽的“源定位 + 目标定位”是两组独立的三选一，不是把 `click` 的单个目标扩成两个。

## 边界

- 非法输入：
  - hover 三种目标都没给：`缺少悬停目标：请给 ref（snapshot 得到的 @N）、selector（CSS 选择器）或 x + y（视口坐标）三选一`；多于一种：`悬停目标只能给一种：ref / selector / x + y 三选一，避免悬停到错误元素`。
  - drag 某一侧没给：`缺少拖拽起点（from）目标：...` / `缺少拖拽终点（to）目标：...`；某一侧多于一种：`拖拽起点（from）目标只能给一种：ref / selector / x + y 三选一，避免拖拽错元素`（`to` 同理）。
  - `steps` 非 1-60 整数：`steps 必须是 1-60 的整数，收到 ${steps}`；`settleMs` 非 0-5000 整数：`settleMs 必须是 0-5000 的整数，收到 ${settleMs}`。
  - 坐标负数 / 越界沿用 `坐标不能为负数`、`坐标 x=… 超出视口宽度…`、`坐标 y=… 超出视口高度…` 文案。
- ref 生命周期：动作前失效报 `ref @N 不存在…` 或 `ref @N 已失效…`，且不产生鼠标事件；动作中途元素被移除 / 变为不可见时，`dragTo` 以 Playwright 的 actionability 超时报错（英文原文，不翻译），包装层补释放鼠标按键；hover 在 `hover()` 的 actionability 处同样报 Playwright 超时。
- 不可见或被遮挡的元素：不暴露 `force` / `sourcePosition` / `targetPosition`，不绕过 actionability，也不静默点/拖到别处；确需按坐标操作时用 `x` + `y`。
- 超时固定：等可见 5000ms、动作 10000ms，均不暴露参数；`settleMs` 的等待发生在动作完成之后，不计入动作超时。
- isolated 与 cdp：两条路径相同；cdp 模式没有固定视口时，坐标校验用页面实际 `innerWidth` / `innerHeight`（与 click 一致）。后台标签页的 CSS 过渡可能被节流，`settleMs` 只保证等待时长，不保证过渡一定完成。
- 不处理的场景：跨 frame（与 click 当前能力一致）、触屏手势、把操作系统文件拖入页面（文件上传是另一功能点）、拖拽中途页面导航（由 Playwright 报执行上下文销毁）。HTML5 目标若在 `dragover` 里不 `preventDefault()`，浏览器会拒绝 drop，这是页面行为，不是工具失败。
- 并发：同一页面上同时发起 hover / drag / click 不设互斥；工具调用本身串行由调用方保证，工具不引入新的跨调用不变量。

## 验收

1. `node tests/tools.mjs` 退出码 0、无 FAIL。以下 check 标签由本功能新增（规格确认时尚未存在，由 tester 落地后按此文案断言）：
   - hover：`悬停 ref 展开 CSS 菜单`、`悬停 selector 触发 mouseover 计数`、`坐标悬停移动真实鼠标且未触发 click`、`hover 的 settleMs 实际等待`、`hover 失效 ref 报已失效且未移动鼠标`、`hover 三种目标都不给时报错`。
   - drag：`元素到元素拖拽重排列表并触发 dragstart/dragover/drop`、`坐标拖拽触发 pointerdown/pointermove/pointerup 且 isTrusted 为 true`、`steps 控制中间 mousemove 次数`、`拖拽目标 ref 失效时未按下鼠标`、`drag 坐标越界报错`、`drag 缺 from/to 或单侧多目标报错`、`steps 与 settleMs 非法报错`。
2. `node tests/panel.mjs` 退出码 0、无 FAIL：现有 `注册的工具与工具表逐项一致（顺序与名字）` 与 `工具名唯一且统一带 browser_e2e_ 前缀` 会自动覆盖两个新工具；tester 把 `hover` / `drag` 加入 `作用于页面的工具都接受 tab_id` 的名单。
3. `npm run test:unit` 退出码 0、无 FAIL。
4. `npm run test:integration` 退出码 0、无 FAIL（真起无头 Edge，串行执行）。
