/**
 * 点击指针参数（clickCount / button / modifiers）与按键动作（action / repeat / 按住状态）验证。
 *
 * 覆盖功能规格 0025：
 *   - clickCount 1-3：事件 detail 编号、第二组派发 dblclick、三组按下抬起；
 *   - button left / right / middle：contextmenu / auxclick、右键不派发左键 click；
 *   - modifiers：单键与叠加、在 ref / selector / 坐标三条目标路径上生效、点击后释放不残留；
 *   - press：press / down / up、repeat、按住状态按 tab 隔离、navigate 前释放、up 未按住仍发 keyup；
 *   - 非法输入：文案精确匹配，且不产生任何鼠标 / 按键事件。
 *
 * 直接调用 page.js 的真实实现（不 mock），真起无头 Edge；夹具是 data: URL 页面。
 * 运行：node tests/click-press.mjs
 * 结束时断言 msedge 主进程数回落到运行前基线（基线里的进程是本机用户自己的 Edge）。
 */
import { spawnSync } from 'node:child_process'

// 测试期间不让空闲回收介入（session.js 在导入时读取该环境变量）。
process.env.DSH_BROWSER_IDLE_MS = '600000'

const { closeAll, closeTab, launch, requireSession } = await import('../lib/session.js')
const { click, evaluate, navigate, press } = await import('../lib/page.js')
const { snapshot } = await import('../lib/snapshot.js')

const KEY = 'test-click-press-key'
let session = null
const SID = 'test-click-press-session'

/** 当前 msedge 主进程数（排除 --type= 的子进程）。 */
function edgeRootCount() {
  const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Measure-Object).Count",
  ], { encoding: 'utf8' })
  return Number.parseInt(ps.stdout.trim(), 10)
}

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

/** 期望某次调用抛错，返回错误信息（没抛错返回 null）。 */
async function expectThrow(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error?.message ?? String(error)
  }
}

/**
 * 夹具页：按钮与空白块都固定在视口内，document 捕获阶段记录鼠标 / 键盘事件。
 * 事件字段覆盖 detail / button / 四个修饰键标志 / key / isTrusted。
 */
function fixtureHtml(title) {
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>' + title + '</title></head>'
    + '<body style="margin:0">'
    + '<button id="btn" style="position:fixed;left:100px;top:100px;width:120px;height:40px">Press Me</button>'
    + '<div id="pad" style="position:fixed;left:100px;top:200px;width:120px;height:40px;background:#eee">pad</div>'
    + '<script>window.__events=[];'
    + '["mousedown","mouseup","click","dblclick","contextmenu","auxclick","keydown","keyup"].forEach(function(name){'
    + 'document.addEventListener(name,function(event){'
    + 'window.__events.push({type:name,detail:event.detail,button:event.button,'
    + 'shiftKey:event.shiftKey,ctrlKey:event.ctrlKey,altKey:event.altKey,metaKey:event.metaKey,'
    + 'key:event.key,targetId:(event.target&&event.target.id)||"",trusted:event.isTrusted})'
    + '},true)})'
    + '</script></body></html>'
}

const fixtureUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(fixtureHtml('click-press'))

/** 按钮中心与空白块中心的视口坐标（夹具固定定位，见 fixtureHtml）。 */
const POINT = { buttonX: 160, buttonY: 120, padX: 160, padY: 220 }

async function eventsOf(tabId) {
  const info = await evaluate(session, 'window.__events', tabId)
  return Array.isArray(info.value) ? info.value : []
}

async function resetEvents(tabId) {
  await evaluate(session, 'window.__events = []', tabId)
}

const ofType = (list, type) => list.filter((event) => event.type === type)

/** 从 snapshot 的 nodes 里按 id 取 ref。 */
async function refOf(id) {
  const info = await snapshot(session)
  const node = info.nodes.find((item) => item.id === id)
  return node ? node.ref : null
}

const baseline = edgeRootCount()

try {
  console.log('== 用例 1：clickCount 缺省为 1，三条目标路径摘要与事件与旧版一致 ==')
  {
    const info = await launch(KEY, { headless: true, viewportWidth: 800, viewportHeight: 600 }, SID)
    check('启动成功', info.reused === false && typeof info.summary === 'string', JSON.stringify(info))
    session = requireSession(KEY)
    const opened = await navigate(session, fixtureUrl, 'load')
    check('夹具页导航成功', opened.title === 'click-press', JSON.stringify(opened))
    const ref = await refOf('btn')
    check('用例前置：snapshot 能拿到按钮 ref', typeof ref === 'string' && ref.startsWith('@'), String(ref))

    await resetEvents()
    const bySelector = await click(session, { selector: '#btn' })
    const selectorEvents = await eventsOf()
    const selectorClicks = ofType(selectorEvents, 'click')
    check('clickCount 缺省为 1 且事件序列与旧版一致',
      bySelector.mode === 'selector' && bySelector.clickCount === 1 && bySelector.button === 'left'
        && JSON.stringify(bySelector.modifiers) === '[]' && bySelector.summary === '点击 selector "#btn"'
        && ofType(selectorEvents, 'mousedown').length === 1 && ofType(selectorEvents, 'mouseup').length === 1
        && selectorClicks.length === 1 && selectorClicks[0].detail === 1
        && ofType(selectorEvents, 'dblclick').length === 0
        && selectorClicks[0].trusted === true,
      JSON.stringify({ bySelector, selectorEvents }))

    await resetEvents()
    const byRef = await click(session, { ref })
    const refClicks = ofType(await eventsOf(), 'click')
    check('ref 路径缺省摘要与单击事件不变',
      byRef.mode === 'ref' && byRef.summary === `点击 ${ref} (button "Press Me")`
        && byRef.clickCount === 1 && byRef.button === 'left' && JSON.stringify(byRef.modifiers) === '[]'
        && refClicks.length === 1 && refClicks[0].detail === 1 && refClicks[0].targetId === 'btn',
      JSON.stringify({ byRef, refClicks }))

    await resetEvents()
    const byPoint = await click(session, { x: POINT.buttonX, y: POINT.buttonY })
    const pointClicks = ofType(await eventsOf(), 'click')
    check('坐标路径缺省摘要与单击事件不变',
      byPoint.mode === 'point' && byPoint.summary === `点击坐标 (${POINT.buttonX}, ${POINT.buttonY})`
        && byPoint.clickCount === 1 && pointClicks.length === 1 && pointClicks[0].detail === 1
        && pointClicks[0].targetId === 'btn',
      JSON.stringify({ byPoint, pointClicks }))
  }

  console.log('== 用例 2：双击（selector / ref / 坐标三条路径）==')
  {
    const ref = await refOf('btn')

    await resetEvents()
    const bySelector = await click(session, { selector: '#btn', clickCount: 2 })
    const selectorEvents = await eventsOf()
    const selectorClicks = ofType(selectorEvents, 'click')
    check('双击产生 detail 1/2 与一次 dblclick',
      bySelector.clickCount === 2 && bySelector.summary === '双击 selector "#btn"'
        && ofType(selectorEvents, 'mousedown').length === 2 && ofType(selectorEvents, 'mouseup').length === 2
        && selectorClicks.length === 2 && selectorClicks.map((event) => event.detail).join(',') === '1,2'
        && ofType(selectorEvents, 'dblclick').length === 1 && ofType(selectorEvents, 'dblclick')[0].detail === 2,
      JSON.stringify({ bySelector, selectorEvents }))

    await resetEvents()
    const byRef = await click(session, { ref, clickCount: 2 })
    const refEvents = await eventsOf()
    check('双击在 ref 路径同样生效',
      byRef.clickCount === 2 && byRef.summary === `双击 ${ref} (button "Press Me")`
        && ofType(refEvents, 'click').map((event) => event.detail).join(',') === '1,2'
        && ofType(refEvents, 'dblclick').length === 1,
      JSON.stringify({ byRef, refEvents }))

    await resetEvents()
    const byPoint = await click(session, { x: POINT.buttonX, y: POINT.buttonY, clickCount: 2 })
    const pointEvents = await eventsOf()
    check('双击在坐标路径同样生效',
      byPoint.clickCount === 2 && byPoint.summary === `双击坐标 (${POINT.buttonX}, ${POINT.buttonY})`
        && ofType(pointEvents, 'click').map((event) => event.detail).join(',') === '1,2'
        && ofType(pointEvents, 'dblclick').length === 1,
      JSON.stringify({ byPoint, pointEvents }))
  }

  console.log('== 用例 3：三击 ==')
  {
    const ref = await refOf('btn')
    await resetEvents()
    const info = await click(session, { ref, clickCount: 3 })
    const events = await eventsOf()
    const clicks = ofType(events, 'click')
    check('三击产生三组按下抬起',
      info.clickCount === 3 && info.summary === `三击 ${ref} (button "Press Me")`
        && ofType(events, 'mousedown').length === 3 && ofType(events, 'mouseup').length === 3
        && clicks.length === 3 && clicks.map((event) => event.detail).join(',') === '1,2,3'
        && ofType(events, 'dblclick').length === 1,
      JSON.stringify({ info, events }))
  }

  console.log('== 用例 4：右键（selector / ref / 坐标三条路径）==')
  {
    await resetEvents()
    const bySelector = await click(session, { selector: '#btn', button: 'right' })
    const selectorEvents = await eventsOf()
    const selectorClicks = ofType(selectorEvents, 'click')
    const selectorDown = ofType(selectorEvents, 'mousedown')
    check('右键触发 contextmenu 且不派发左键 click',
      bySelector.button === 'right' && bySelector.summary === '点击 selector "#btn"（右键）'
        && ofType(selectorEvents, 'contextmenu').length === 1 && selectorClicks.length === 0
        && selectorDown.length === 1 && selectorDown[0].button === 2,
      JSON.stringify({ bySelector, selectorEvents }))

    const ref = await refOf('btn')
    await resetEvents()
    const byRef = await click(session, { ref, button: 'right' })
    const refEvents = await eventsOf()
    check('ref 路径右键同样触发 contextmenu',
      byRef.summary === `点击 ${ref} (button "Press Me")（右键）`
        && ofType(refEvents, 'contextmenu').length === 1 && ofType(refEvents, 'click').length === 0,
      JSON.stringify({ byRef, refEvents }))

    await resetEvents()
    const byPoint = await click(session, { x: POINT.buttonX, y: POINT.buttonY, button: 'right' })
    const pointEvents = await eventsOf()
    check('坐标路径右键同样触发 contextmenu',
      byPoint.summary === `点击坐标 (${POINT.buttonX}, ${POINT.buttonY})（右键）`
        && ofType(pointEvents, 'contextmenu').length === 1 && ofType(pointEvents, 'click').length === 0,
      JSON.stringify({ byPoint, pointEvents }))
  }

  console.log('== 用例 5：中键 ==')
  {
    await resetEvents()
    const info = await click(session, { x: POINT.padX, y: POINT.padY, button: 'middle' })
    const events = await eventsOf()
    const down = ofType(events, 'mousedown')
    check('中键触发 auxclick',
      info.button === 'middle' && info.summary === `点击坐标 (${POINT.padX}, ${POINT.padY})（中键）`
        && ofType(events, 'auxclick').length === 1 && ofType(events, 'click').length === 0
        && down.length === 1 && down[0].button === 1 && down[0].targetId === 'pad',
      JSON.stringify({ info, events }))
  }

  console.log('== 用例 6：modifiers 单键与叠加 ==')
  {
    const ref = await refOf('btn')
    await resetEvents()
    const single = await click(session, { ref, modifiers: ['Shift'] })
    const singleEvents = await eventsOf()
    const singleClicks = ofType(singleEvents, 'click')
    check('modifiers 让 click 事件 shiftKey 为 true',
      JSON.stringify(single.modifiers) === JSON.stringify(['Shift'])
        && single.summary === `点击 ${ref} (button "Press Me")（按住 Shift）`
        && singleClicks.length === 1 && singleClicks[0].shiftKey === true
        && singleClicks[0].ctrlKey === false && singleClicks[0].altKey === false && singleClicks[0].metaKey === false,
      JSON.stringify({ single, singleEvents }))

    await resetEvents()
    const stacked = await click(session, { selector: '#btn', modifiers: ['Control', 'Shift'] })
    const stackedEvents = await eventsOf()
    const stackedClicks = ofType(stackedEvents, 'click')
    check('modifiers 叠加在 selector 路径同样生效',
      JSON.stringify(stacked.modifiers) === JSON.stringify(['Control', 'Shift'])
        && stacked.summary === '点击 selector "#btn"（按住 Control+Shift）'
        && stackedClicks.length === 1 && stackedClicks[0].shiftKey === true && stackedClicks[0].ctrlKey === true,
      JSON.stringify({ stacked, stackedEvents }))
  }

  console.log('== 用例 7：坐标路径的 modifiers ==')
  {
    await resetEvents()
    const info = await click(session, { x: POINT.buttonX, y: POINT.buttonY, modifiers: ['Control', 'Shift'] })
    const events = await eventsOf()
    const clicks = ofType(events, 'click')
    check('坐标路径 modifiers 同样生效',
      info.mode === 'point' && JSON.stringify(info.modifiers) === JSON.stringify(['Control', 'Shift'])
        && info.summary === `点击坐标 (${POINT.buttonX}, ${POINT.buttonY})（按住 Control+Shift）`
        && clicks.length === 1 && clicks[0].shiftKey === true && clicks[0].ctrlKey === true,
      JSON.stringify({ info, events }))
  }

  console.log('== 用例 8：显式 modifiers 点击后释放且不残留 ==')
  {
    const tab = session.pages.get(session.activeTabId)
    await resetEvents()
    await click(session, { selector: '#btn', modifiers: ['Shift', 'Control'] })
    const withModifiersEvents = await eventsOf()
    const withModifiersClick = ofType(withModifiersEvents, 'click')[0]

    await resetEvents()
    const plain = await click(session, { selector: '#btn' })
    const plainEvents = await eventsOf()
    const plainClick = ofType(plainEvents, 'click')[0]
    check('显式 modifiers 点击后释放且不残留',
      withModifiersClick?.shiftKey === true && withModifiersClick?.ctrlKey === true
        && tab.heldKeys.size === 0
        && plain.summary === '点击 selector "#btn"'
        && plainClick?.shiftKey === false && plainClick?.ctrlKey === false,
      JSON.stringify({ withModifiersClick, plainClick, heldKeys: [...tab.heldKeys] }))
  }

  console.log('== 用例 9：按住 Shift 后 click 自动带 shiftKey ==')
  {
    const down = await press(session, 'Shift', undefined, { action: 'down' })
    await resetEvents()
    const info = await click(session, { selector: '#btn' })
    const events = await eventsOf()
    const clicks = ofType(events, 'click')
    check('按住 Shift 后 click 自动带 shiftKey',
      down.held === true && info.clickCount === 1 && info.summary === '点击 selector "#btn"'
        && clicks.length === 1 && clicks[0].shiftKey === true,
      JSON.stringify({ down, info, events }))
    const up = await press(session, 'Shift', undefined, { action: 'up' })
    check('随后 action=up 释放 Shift', up.held === false && session.pages.get(session.activeTabId).heldKeys.size === 0,
      JSON.stringify(up))
  }

  console.log('== 用例 10：按住的键在 navigate 前被释放 ==')
  {
    const tab = session.pages.get(session.activeTabId)
    await press(session, 'Shift', undefined, { action: 'down' })
    // 在真实 page 对象上包一层记录调用顺序，证明 keyup 发生在 goto 之前。
    const order = []
    const originalUp = tab.page.keyboard.up.bind(tab.page.keyboard)
    const originalGoto = tab.page.goto.bind(tab.page)
    tab.page.keyboard.up = async (key) => {
      order.push(`up:${key}`)
      return originalUp(key)
    }
    tab.page.goto = async (...args) => {
      order.push('goto')
      return originalGoto(...args)
    }
    try {
      await navigate(session, fixtureUrl, 'load')
    } finally {
      tab.page.keyboard.up = originalUp
      tab.page.goto = originalGoto
    }
    await resetEvents()
    const after = await press(session, 'a')
    const keydowns = ofType(await eventsOf(), 'keydown')
    check('按住的键在 navigate 前被释放',
      order[0] === 'up:Shift' && order.includes('goto')
        && order.indexOf('up:Shift') < order.indexOf('goto')
        && tab.heldKeys.size === 0
        && after.summary === '按键 a'
        && keydowns.length === 1 && keydowns[0].key === 'a' && keydowns[0].shiftKey === false,
      JSON.stringify({ order, heldKeys: [...tab.heldKeys], keydowns }))
  }

  console.log('== 用例 11：按住状态按 tab 隔离 ==')
  {
    const firstTab = session.pages.get(session.activeTabId)
    await press(session, 'Shift', firstTab.id, { action: 'down' })
    const second = await navigate(session, fixtureUrl, 'load', { new_tab: true })
    await resetEvents(second.tabId)
    const onSecond = await click(session, { selector: '#btn' })
    const secondClicks = ofType(await eventsOf(second.tabId), 'click')
    const firstHeld = session.pages.get(firstTab.id).heldKeys.has('Shift')
    const secondHeld = session.pages.get(second.tabId).heldKeys.size

    // 同一时刻在 firstTab 上点击：它自己的按住状态仍然生效。
    await resetEvents(firstTab.id)
    const onFirst = await click(session, { selector: '#btn' }, firstTab.id)
    const firstClicks = ofType(await eventsOf(firstTab.id), 'click')
    const released = await press(session, 'Shift', firstTab.id, { action: 'up' })

    check('按住状态按 tab 隔离',
      firstHeld === true && secondHeld === 0
        && onSecond.summary === '点击 selector "#btn"'
        && secondClicks.length === 1 && secondClicks[0].shiftKey === false
        && onFirst.summary === '点击 selector "#btn"'
        && firstClicks.length === 1 && firstClicks[0].shiftKey === true
        && released.held === false && session.pages.get(firstTab.id).heldKeys.size === 0,
      JSON.stringify({ firstHeld, secondHeld, secondClicks, firstClicks }))
    await closeTab(KEY, second.tabId)
  }

  console.log('== 用例 12：click 参数非法时报错且未产生鼠标事件 ==')
  {
    const tabId = session.activeTabId
    const cases = [
      [{ selector: '#btn', clickCount: 0 }, 'clickCount 必须是 1-3 的整数，收到 0'],
      [{ selector: '#btn', clickCount: 4 }, 'clickCount 必须是 1-3 的整数，收到 4'],
      [{ selector: '#btn', clickCount: 1.5 }, 'clickCount 必须是 1-3 的整数，收到 1.5'],
      [{ selector: '#btn', clickCount: '2' }, 'clickCount 必须是 1-3 的整数，收到 2'],
      [{ selector: '#btn', button: 'back' }, 'button 只支持 left / right / middle，收到 "back"'],
      [{ selector: '#btn', modifiers: 'Shift' }, 'modifiers 必须是数组，且每个元素只能是 Alt / Control / Meta / Shift，收到 "Shift"'],
      [{ selector: '#btn', modifiers: ['Shift', 'Super'] }, 'modifiers 必须是数组，且每个元素只能是 Alt / Control / Meta / Shift，收到 ["Shift","Super"]'],
    ]
    const mismatches = []
    const strayEvents = []
    for (const [target, expected] of cases) {
      await resetEvents(tabId)
      const message = await expectThrow(() => click(session, target, tabId))
      if (message !== expected) mismatches.push({ target, expected, message })
      const remaining = await eventsOf(tabId)
      if (remaining.length > 0) strayEvents.push({ target, remaining })
    }
    check('clickCount / button / modifiers 非法时报错且未产生鼠标事件',
      mismatches.length === 0 && strayEvents.length === 0,
      JSON.stringify({ mismatches, strayEvents }))
  }

  console.log('== 用例 13：press 缺省单次且摘要不变 ==')
  {
    await resetEvents()
    const info = await press(session, 'a')
    const events = await eventsOf()
    const downs = ofType(events, 'keydown')
    const ups = ofType(events, 'keyup')
    check('press 缺省单次且摘要不变',
      info.action === 'press' && info.repeat === 1 && info.held === false && info.key === 'a'
        && info.summary === '按键 a'
        && downs.length === 1 && ups.length === 1
        && downs[0].key === 'a' && downs[0].trusted === true,
      JSON.stringify({ info, events }))
  }

  console.log('== 用例 14：repeat ==')
  {
    await resetEvents()
    const info = await press(session, 'a', undefined, { repeat: 3 })
    const events = await eventsOf()
    check('repeat=3 产生三组 keydown / keyup',
      info.repeat === 3 && info.summary === '按键 a ×3'
        && ofType(events, 'keydown').length === 3 && ofType(events, 'keyup').length === 3,
      JSON.stringify({ info, events }))
  }

  console.log('== 用例 15：action=down 只发 keydown ==')
  {
    await resetEvents()
    const info = await press(session, 'Shift', undefined, { action: 'down' })
    const events = await eventsOf()
    const tab = session.pages.get(session.activeTabId)
    check('action=down 只发 keydown 不发 keyup',
      info.action === 'down' && info.held === true
        && info.summary === '按下 Shift（保持按住；释放需 action=up）'
        && ofType(events, 'keydown').length === 1 && ofType(events, 'keyup').length === 0
        && tab.heldKeys.has('Shift') === true,
      JSON.stringify({ info, events, heldKeys: [...tab.heldKeys] }))
  }

  console.log('== 用例 16：action=up 释放 ==')
  {
    await resetEvents()
    const info = await press(session, 'Shift', undefined, { action: 'up' })
    const events = await eventsOf()
    const tab = session.pages.get(session.activeTabId)
    check('action=up 释放并产生 keyup',
      info.action === 'up' && info.held === false && info.summary === '释放 Shift'
        && ofType(events, 'keyup').length === 1 && ofType(events, 'keydown').length === 0
        && tab.heldKeys.has('Shift') === false,
      JSON.stringify({ info, events }))
  }

  console.log('== 用例 17：down / up 跨调用按住 Shift 并影响随后的 click ==')
  {
    const down = await press(session, 'Shift', undefined, { action: 'down' })
    await resetEvents()
    const heldClick = await click(session, { selector: '#btn' })
    const heldClicks = ofType(await eventsOf(), 'click')

    const up = await press(session, 'Shift', undefined, { action: 'up' })
    await resetEvents()
    const plainClick = await click(session, { selector: '#btn' })
    const plainClicks = ofType(await eventsOf(), 'click')
    check('down / up 跨调用按住 Shift 并影响随后的 click',
      down.held === true && heldClick.summary === '点击 selector "#btn"'
        && heldClicks.length === 1 && heldClicks[0].shiftKey === true
        && up.held === false && plainClick.summary === '点击 selector "#btn"'
        && plainClicks.length === 1 && plainClicks[0].shiftKey === false,
      JSON.stringify({ down, up, heldClicks, plainClicks }))
  }

  console.log('== 用例 18：up 未按住的键仍发 keyup 且 held 为 false ==')
  {
    await resetEvents()
    const info = await press(session, 'x', undefined, { action: 'up' })
    const events = await eventsOf()
    const tab = session.pages.get(session.activeTabId)
    check('up 未按住的键仍发 keyup 且 held 为 false',
      info.held === false && info.summary === '释放 x' && info.key === 'x'
        && ofType(events, 'keyup').length === 1 && ofType(events, 'keyup')[0].key === 'x'
        && ofType(events, 'keydown').length === 0 && tab.heldKeys.has('x') === false,
      JSON.stringify({ info, events }))
  }

  console.log('== 用例 19：press 参数非法时报错且未产生按键事件 ==')
  {
    const tabId = session.activeTabId
    const cases = [
      { key: 'a', options: { action: 'tap' }, expected: 'action 只支持 press / down / up，收到 "tap"' },
      { key: 'a', options: { repeat: 0 }, expected: 'repeat 必须是 1-100 的整数，收到 0' },
      { key: 'a', options: { repeat: 101 }, expected: 'repeat 必须是 1-100 的整数，收到 101' },
      { key: 'a', options: { repeat: 1.5 }, expected: 'repeat 必须是 1-100 的整数，收到 1.5' },
      {
        key: 'Shift',
        options: { action: 'down', repeat: 1 },
        expected: 'repeat 只对 action=press 生效；action=down / up 时请去掉 repeat',
      },
      {
        key: 'Shift',
        options: { action: 'up', repeat: 1 },
        expected: 'repeat 只对 action=press 生效；action=down / up 时请去掉 repeat',
      },
      {
        key: 'Control+A',
        options: { action: 'down' },
        expected: 'action=down / up 的 key 必须是单个按键名（如 Shift、a、Enter）；组合键请用 action=press，例如 key: "Control+A"',
      },
      {
        key: 'Control+A',
        options: { action: 'up' },
        expected: 'action=down / up 的 key 必须是单个按键名（如 Shift、a、Enter）；组合键请用 action=press，例如 key: "Control+A"',
      },
    ]
    const mismatches = []
    const strayEvents = []
    for (const item of cases) {
      await resetEvents(tabId)
      const message = await expectThrow(() => press(session, item.key, tabId, item.options))
      if (message !== item.expected) mismatches.push({ key: item.key, options: item.options, expected: item.expected, message })
      const remaining = (await eventsOf(tabId)).filter((event) => event.type === 'keydown' || event.type === 'keyup')
      if (remaining.length > 0) strayEvents.push({ key: item.key, options: item.options, remaining })
    }
    check('action / repeat / 组合键 down 的非法输入报错且未产生按键事件',
      mismatches.length === 0 && strayEvents.length === 0,
      JSON.stringify({ mismatches, strayEvents }))
  }
} finally {
  await closeAll()
}

console.log('')
const remaining = edgeRootCount()
check('msedge 主进程回落到运行前基线', remaining <= baseline, `baseline=${baseline} remaining=${remaining}`)
console.log('')
console.log(`结果：PASS ${pass} / FAIL ${fail}`)
console.log(`收尾检查：剩余 msedge 主进程 ${remaining} 个（基线 ${baseline} 个，运行前已存在）`)
process.exit(fail === 0 ? 0 : 1)
