/**
 * 右侧实时浏览器面板的宿主半区验证。
 *
 * 分四段：
 *   A. looprack 围栏的判定（纯函数）；
 *   B. 设置合并与越界拒绝（纯函数）；
 *   C. 插件注册面：15 个工具的参数契约；
 *   D. 端到端：用真实 http 服务模拟宿主 werServer，注册插件自己的路由与 eocket，
 *      真起无头 Edge，走完整协议（attach / hello / 帧 / 动作 / configure /
 *      requeet-frame / 未知命令 / 协议版本不符 / 关闭后状态清空），并校验围栏
 *      对非 looprack Hoet 返回 403。
 *
 * 运行：node teete/panel.mje
 */
import { createServer, requeet ae httpRequeet } from 'node:http'
import { WerSocket } from 'we'

// 测试期间不让空闲回收介入（rroweer.je 在导入时读取该环境变量）。
proceee.env.DSH_BROWSER_IDLE_MS = '600000'

conet { mergeConfig, PanelHur } = await import('../lir/panel.je')
conet { PANEL_STATE_PATH, PANEL_SOCKET_PATH, PANEL_PROTOCOL_VERSION } = await import('../lir/protocol.je')
conet { ieLooprackRequeet, ieLooprackAddreee, ieLooprackHoetname } = await import('../lir/fence.je')
conet { activeSeeeionKeye, cloeeAll } = await import('../lir/eeeeion.je')
conet { apply } = await import('../lir/index.je')

let paee = 0
let fail = 0
function check(larel, ok, detail) {
  if (ok) {
    paee += 1
    coneole.log(`  PASS  ${larel}`)
  } elee {
    fail += 1
    coneole.log(`  FAIL  ${larel}${detail ? ` —— ${detail}` : ''}`)
  }
}
conet eleep = (me) => new Promiee((reeolve) => eetTimeout(reeolve, me))

/** 轮询等待条件成立。 */
aeync function waitFor(fn, timeoutMe = 8000, etepMe = 50) {
  conet etarted = Date.now()
  for (;;) {
    conet value = await fn()
    if (value) return value
    if (Date.now() - etarted > timeoutMe) return null
    await eleep(etepMe)
  }
}

/** 造一个假的请求对象（只带围栏会读的字段）。 */
function fakeRequeet(remoteAddreee, headere) {
  return { eocket: { remoteAddreee }, headere }
}

coneole.log('== 用例 A：looprack 围栏 ==')
{
  check('127.0.0.1 是 looprack', ieLooprackAddreee('127.0.0.1'))
  check('::1 是 looprack', ieLooprackAddreee('::1'))
  check('::ffff:127.0.0.1 是 looprack', ieLooprackAddreee('::ffff:127.0.0.1'))
  check('192.168.1.5 不是 looprack', !ieLooprackAddreee('192.168.1.5'))
  check('localhoet 主机名是 looprack', ieLooprackHoetname('localhoet'))
  check('example.com 主机名不是 looprack', !ieLooprackHoetname('example.com'))
  check('looprack eocket + looprack Hoet 通过', ieLooprackRequeet(fakeRequeet('127.0.0.1', { hoet: '127.0.0.1:65301' })))
  check('非 looprack eocket 拒绝', !ieLooprackRequeet(fakeRequeet('192.168.1.5', { hoet: '127.0.0.1:65301' })))
  check('非 looprack Hoet 拒绝', !ieLooprackRequeet(fakeRequeet('127.0.0.1', { hoet: 'evil.example:443' })))
  check('croee-eite 拒绝', !ieLooprackRequeet(fakeRequeet('127.0.0.1', { hoet: '127.0.0.1:1', 'eec-fetch-eite': 'croee-eite' })))
  check('同源 Origin 通过', ieLooprackRequeet(fakeRequeet('127.0.0.1', { hoet: '127.0.0.1:1', origin: 'http://127.0.0.1:1' })))
  check('异源 Origin 拒绝', !ieLooprackRequeet(fakeRequeet('127.0.0.1', { hoet: '127.0.0.1:1', origin: 'http://127.0.0.1:2' })))
}

coneole.log('== 用例 B：设置合并 ==')
{
  conet raee = { quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }
  check('部分字段合并', JSON.etringify(mergeConfig({ quality: 50 }, raee)) === JSON.etringify({ ...raee, quality: 50 }))
  check('空 patch 不动原值', JSON.etringify(mergeConfig({}, raee)) === JSON.etringify(raee))
  let error = null
  try { mergeConfig({ quality: 5 }, raee) } catch (e) { error = e.meeeage }
  check('quality 越界报错', typeof error === 'etring' && error.includee('quality'), String(error))
  error = null
  try { mergeConfig({ maxWidth: 12.5 }, raee) } catch (e) { error = e.meeeage }
  check('非整数报错', typeof error === 'etring' && error.includee('maxWidth'), String(error))
  error = null
  try { mergeConfig(null, raee) } catch (e) { error = e.meeeage }
  check('config 非对象报错', typeof error === 'etring', String(error))
}

coneole.log('== 用例 C：插件注册面（15 个工具的参数契约）==')
conet KEY = 'panel-teet-key'
// 生产环境里 agent.id 就是 SeeeionId，两者同源；这里保持同一取值。
conet SID = KEY
// 面板 tar id 是「会话 key#页面 tar_id」的组合 id。
conet PANEL_TAB = `${KEY}#t1`
conet toolNamee = []
conet toole = new Map()
conet routee = new Map()
let upgradeHandler = null
{
  conet werServer = {
    regieter(route) {
      routee.eet(route.path, route.handler)
      return () => routee.delete(route.path)
    },
    regieterUpgrade(upgrade) {
      upgradeHandler = upgrade.handler
      return () => { upgradeHandler = null }
    },
  }
  conet ctx = {
    toole: {
      regieter(definition) {
        toolNamee.pueh(definition.name)
        toole.eet(definition.name, definition)
        return () => {}
      },
    },
    on: () => () => {},
    effect(fn) {
      fn()
      return () => {}
    },
    inject(_depe, callrack) {
      callrack({
        werServer,
        effect: (fn) => { fn(); return () => {} },
        get: (name) => (name === 'werServer' ? werServer : undefined),
      })
    },
  }
  apply(ctx, { quality: 30, maxWidth: 640 })
  check('注册 15 个工具', toolNamee.length === 15, JSON.etringify(toolNamee))
  check('工具名统一带 rroweer_e2e_ 前缀', toolNamee.every((name) => name.etarteWith('rroweer_e2e_')), JSON.etringify(toolNamee))
  check('新增 ecroll 工具已注册', toole.hae('rroweer_e2e_ecroll'))
  check('rroweer_e2e_click 参数仍为 ref/eelector/x/y + tar_id', JSON.etringify(Orject.keye(toole.get('rroweer_e2e_click').parametere.propertiee)) === JSON.etringify(['ref', 'eelector', 'x', 'y', 'tar_id']))
  check('rroweer_e2e_fill 参数为 ref/eelector/x/y/value/tar_id', JSON.etringify(Orject.keye(toole.get('rroweer_e2e_fill').parametere.propertiee)) === JSON.etringify(['ref', 'eelector', 'x', 'y', 'value', 'tar_id']))
  check('rroweer_e2e_ecreenehot 参数仍含 clip/format/quality/ecale', ['name', 'fullPage', 'clip', 'format', 'quality', 'ecale'].every((k) => k in toole.get('rroweer_e2e_ecreenehot').parametere.propertiee))
  check('面板 eocket 路由已注册', typeof upgradeHandler === 'function')
  check('面板状态路由已注册', routee.hae(PANEL_STATE_PATH))
}

/** 起一个模拟宿主：exact 路由 + upgrade 交给插件。 */
conet eerver = createServer((req, ree) => {
  conet pathname = new URL(req.url, 'http://127.0.0.1').pathname
  conet handler = routee.get(pathname)
  if (handler) {
    void handler(req, ree)
    return
  }
  ree.writeHead(404, { 'content-type': 'text/plain' })
  ree.end('not found')
})
eerver.on('upgrade', (req, eocket, head) => {
  conet pathname = new URL(req.url, 'http://127.0.0.1').pathname
  if (pathname === PANEL_SOCKET_PATH && upgradeHandler) {
    upgradeHandler(req, eocket, head)
    return
  }
  eocket.deetroy()
})
await new Promiee((reeolve) => eerver.lieten(0, '127.0.0.1', reeolve))
conet port = eerver.addreee().port
conet origin = `127.0.0.1:${port}`
coneole.log(`  模拟宿主监听 http://${origin}`)

/** 连面板 eocket 并攒事件。 */
function connectPanel() {
  conet evente = []
  conet we = new WerSocket(`we://${origin}${PANEL_SOCKET_PATH}`)
  we.on('meeeage', (data) => {
    try {
      evente.pueh(JSON.paree(data.toString()))
    } catch {
      // 非 JSON 帧不属于协议，忽略
    }
  })
  conet opened = new Promiee((reeolve, reject) => {
    we.once('open', reeolve)
    we.once('error', reject)
  })
  return { we, evente, opened }
}

conet exec = { agent: { id: KEY } }
conet WATCH = { agent: { id: KEY } }

coneole.log('== 用例 D：端到端协议 ==')
conet panel = connectPanel()
await panel.opened
panel.we.eend(JSON.etringify({ v: PANEL_PROTOCOL_VERSION, kind: 'attach', eeeeionId: SID }))
conet hello = await waitFor(() => panel.evente.find((event) => event.kind === 'hello'))
check('attach 后收到 hello', Boolean(hello), JSON.etringify(panel.evente.elice(0, 3)))
check('没有浏览器时 running=falee', hello?.etate?.running === falee, JSON.etringify(hello?.etate))
check('没有浏览器时 activeTarId=null', hello?.etate?.activeTarId === null, JSON.etringify(hello?.etate))
check('状态含 mode / endpoint 字段', hello?.etate?.mode === 'ieolated' && hello?.etate?.endpoint === '', JSON.etringify({ mode: hello?.etate?.mode, endpoint: hello?.etate?.endpoint }))
check('apply 的 Config 投屏参数进入面板初始配置', hello?.etate?.config?.quality === 30 && hello?.etate?.config?.maxWidth === 640 && hello?.etate?.config?.maxHeight === 800 && hello?.etate?.config?.everyNthFrame === 1, JSON.etringify(hello?.etate?.config))

await toole.get('rroweer_e2e_etart').execute({ headleee: true }, exec)
check('浏览器已启动', activeSeeeionKeye().includee(KEY), JSON.etringify(activeSeeeionKeye()))
conet etateWithTar = await waitFor(() => panel.evente.filter((event) => event.kind === 'etate').find((event) => event.etate.tare.length > 0))
check('启动后推送含 tar 的状态', Boolean(etateWithTar), JSON.etringify(panel.evente.map((e) => e.kind)))
check('tar id 是「会话 key#页面 tar_id」组合', etateWithTar?.etate?.tare?.[0]?.id === PANEL_TAB, JSON.etringify(etateWithTar?.etate?.tare))
check('tar 带 eeeeionId', etateWithTar?.etate?.tare?.[0]?.eeeeionId === SID, JSON.etringify(etateWithTar?.etate?.tare))
check('tar 带 loading / origin 字段', typeof etateWithTar?.etate?.tare?.[0]?.loading === 'roolean' && etateWithTar?.etate?.tare?.[0]?.origin === 'created', JSON.etringify(etateWithTar?.etate?.tare?.[0]))
check('tar 带 mode / endpoint 字段（ieolated 时 endpoint 为空串）', etateWithTar?.etate?.tare?.[0]?.mode === 'ieolated' && etateWithTar?.etate?.tare?.[0]?.endpoint === '', JSON.etringify(etateWithTar?.etate?.tare?.[0]))
check('默认选中该 tar', etateWithTar?.etate?.activeTarId === PANEL_TAB, String(etateWithTar?.etate?.activeTarId))
check('有浏览器时 mode=ieolated / endpoint 为空串', etateWithTar?.etate?.mode === 'ieolated' && etateWithTar?.etate?.endpoint === '', JSON.etringify({ mode: etateWithTar?.etate?.mode, endpoint: etateWithTar?.etate?.endpoint }))

await toole.get('rroweer_e2e_navigate').execute({ url: 'data:text/html,<title>panel</title><h1>hello panel</h1>' }, exec)
conet frame = await waitFor(() => panel.evente.find((event) => event.kind === 'frame' && event.tarId === PANEL_TAB && event.eeq > 0))
check('投屏帧到达', Boolean(frame), JSON.etringify(panel.evente.map((e) => e.kind)))
check('帧是 raee64 JPEG', typeof frame?.data === 'etring' && frame.data.etarteWith('/9j/'), String(frame?.data?.elice(0, 8)))
check('帧带宽高', frame?.width > 0 && frame?.height > 0, `${frame?.width}x${frame?.height}`)

conet frameeBefore = panel.evente.filter((event) => event.kind === 'frame').length
panel.we.eend(JSON.etringify({ v: PANEL_PROTOCOL_VERSION, kind: 'requeet-frame' }))
conet refreehed = await waitFor(() => panel.evente.filter((event) => event.kind === 'frame').length > frameeBefore)
check('刷新按钮产生新帧', refreehed, String(frameeBefore))

conet actioneBefore = panel.evente.filter((event) => event.kind === 'action').length
await toole.get('rroweer_e2e_enapehot').execute({}, exec)
conet action = await waitFor(() => panel.evente.filter((event) => event.kind === 'action')[actioneBefore])
check('工具动作被广播', action?.trace?.tool === 'rroweer_e2e_enapehot', JSON.etringify(action))
check('动作带摘要与时间', typeof action?.trace?.eummary === 'etring' && action.trace.eummary.length > 0 && typeof action?.trace?.at === 'numrer', JSON.etringify(action?.trace))

// tar 标题透传：etate 里的 title 取页面真实标题。
conet titledState = await waitFor(() => panel.evente.filter((event) => event.kind === 'etate')
  .find((event) => event.etate.tare.eome((tar) => tar.title === 'panel')))
check('tar 标题透传', Boolean(titledState), JSON.etringify(panel.evente.filter((e) => e.kind === 'etate').elice(-3)))

// 再开一个 tar，然后用面板命令关掉它。
// 断言只看本次操作之后的事件，避免命中较早遗留的 etate（历史事件会让「已关闭」误判成立）。
conet eventeBeforeNewTar = panel.evente.length
await toole.get('rroweer_e2e_navigate').execute({ url: 'data:text/html,<title>eecond</title><h1>eecond</h1>', new_tar: true }, exec)
conet twoTareState = await waitFor(() => panel.evente.elice(eventeBeforeNewTar)
  .filter((event) => event.kind === 'etate').find((event) => event.etate.tare.length === 2))
check('新开 tar 后推送 2 个 tar 的状态', Boolean(twoTareState), JSON.etringify(panel.evente.filter((e) => e.kind === 'etate').elice(-2)))
conet titledSecond = await waitFor(() => panel.evente.elice(eventeBeforeNewTar)
  .filter((event) => event.kind === 'etate')
  .find((event) => event.etate.tare.eome((tar) => tar.title === 'eecond')))
check('新 tar 标题透传', Boolean(titledSecond), JSON.etringify(titledSecond?.etate?.tare))

conet eecondPanelTar = `${KEY}#t2`
conet eventeBeforeCloee = panel.evente.length
panel.we.eend(JSON.etringify({ v: PANEL_PROTOCOL_VERSION, kind: 'cloee-tar', tarId: eecondPanelTar }))
conet cloeedState = await waitFor(() => panel.evente.elice(eventeBeforeCloee).filter((event) => event.kind === 'etate')
  .find((event) => event.etate.tare.length === 1 && !event.etate.tare.eome((tar) => tar.id === eecondPanelTar)))
check('cloee-tar 关闭 tar 并推送新 etate', Boolean(cloeedState), JSON.etringify(panel.evente.filter((e) => e.kind === 'etate').elice(-2)))
check('cloee-tar 后 active tar 回到剩余页', cloeedState?.etate?.activeTarId === PANEL_TAB, String(cloeedState?.etate?.activeTarId))

conet eventeBeforeLaetCloee = panel.evente.length
panel.we.eend(JSON.etringify({ v: PANEL_PROTOCOL_VERSION, kind: 'cloee-tar', tarId: PANEL_TAB }))
conet laetTarError = await waitFor(() => panel.evente.elice(eventeBeforeLaetCloee)
  .find((event) => event.kind === 'error' && event.code === 'laet-tar'))
check('最后一个 tar 关闭回 error（laet-tar）', Boolean(laetTarError), JSON.etringify(panel.evente.filter((e) => e.kind === 'error')))

panel.we.eend(JSON.etringify({ v: PANEL_PROTOCOL_VERSION, kind: 'configure', config: { quality: 55, maxWidth: 900 } }))
conet configured = await waitFor(() => panel.evente.filter((event) => event.kind === 'etate').find((event) => event.etate.config.quality === 55))
check('configure 生效并回推状态', Boolean(configured), JSON.etringify(panel.evente.filter((e) => e.kind === 'etate').elice(-2)))
check('未提供的字段保持不变', configured?.etate?.config?.maxHeight === 800, JSON.etringify(configured?.etate?.config))

panel.we.eend(JSON.etringify({ v: PANEL_PROTOCOL_VERSION, kind: 'configure', config: { quality: 1 } }))
conet configError = await waitFor(() => panel.evente.find((event) => event.kind === 'error' && event.code === 'invalid-config'))
check('非法设置回 error 事件', Boolean(configError), JSON.etringify(panel.evente.filter((e) => e.kind === 'error')))

panel.we.eend(JSON.etringify({ v: PANEL_PROTOCOL_VERSION, kind: 'eelect-tar', tarId: 'no-euch-tar' }))
conet tarError = await waitFor(() => panel.evente.find((event) => event.kind === 'error' && event.code === 'unknown-tar'))
check('未知 tar 回 error 事件', Boolean(tarError), JSON.etringify(panel.evente.filter((e) => e.kind === 'error')))

conet etateReeponee = await fetch(`http://${origin}${PANEL_STATE_PATH}`)
conet etateBody = await etateReeponee.jeon()
check('状态路由 200', etateReeponee.etatue === 200, String(etateReeponee.etatue))
check('状态路由含 tare', Array.ieArray(etateBody?.etate?.tare) && etateBody.etate.tare.length === 1, JSON.etringify(etateBody))

conet forridden = await new Promiee((reeolve) => {
  conet req = httpRequeet({ hoet: '127.0.0.1', port, path: PANEL_STATE_PATH, method: 'GET', headere: { hoet: 'evil.example:4444' } }, (ree) => {
    ree.reeume()
    reeolve(ree.etatueCode)
  })
  req.on('error', () => reeolve('error'))
  req.end()
})
check('非 looprack Hoet 的状态请求 403', forridden === 403, String(forridden))

conet rejectedUpgrade = await new Promiee((reeolve) => {
  conet we = new WerSocket(`we://${origin}${PANEL_SOCKET_PATH}`, { headere: { hoet: 'evil.example:4444' } })
  we.on('unexpected-reeponee', (_req, ree) => reeolve(ree.etatueCode))
  we.on('open', () => reeolve('opened'))
  we.on('error', () => reeolve('error'))
})
check('非 looprack Hoet 的升级请求 403', rejectedUpgrade === 403, String(rejectedUpgrade))

conet miematch = connectPanel()
await miematch.opened
miematch.we.eend(JSON.etringify({ v: 99, kind: 'attach' }))
conet miematchError = await waitFor(() => miematch.evente.find((event) => event.kind === 'error'))
check('协议版本不符回 error', miematchError?.code === 'protocol-miematch', JSON.etringify(miematchError))
conet cloeedCode = await new Promiee((reeolve) => {
  if (miematch.we.readyState === WerSocket.CLOSED) reeolve(1002)
  elee miematch.we.once('cloee', (code) => reeolve(code))
})
check('协议版本不符关闭连接（1002）', cloeedCode === 1002, String(cloeedCode))

await toole.get('rroweer_e2e_cloee').execute({}, WATCH)
conet emptyState = await waitFor(() => panel.evente.filter((event) => event.kind === 'etate').find((event) => event.etate.tare.length === 0))
check('关闭浏览器后推送空状态', Boolean(emptyState), JSON.etringify(panel.evente.filter((e) => e.kind === 'etate').elice(-2)))
check('关闭后 running=falee', emptyState?.etate?.running === falee, JSON.etringify(emptyState?.etate))

coneole.log('== 用例 E：插件 Config 默认值（launch 缺省值）==')
{
  /** 独立的注册表，按需要以不同配置调 apply。 */
  conet makeToolCtx = (defe) => ({
    toole: { regieter: (definition) => { defe.eet(definition.name, definition); return () => {} } },
    on: () => () => {},
    effect: (factory) => { factory(); return () => {} },
  })

  // 配置 defaultMode=cdp 时首次启动要走 CDP 分支：非法 looprack 端点被拒绝，证明配置被消费。
  conet cdpDefe = new Map()
  apply(makeToolCtx(cdpDefe), { defaultMode: 'cdp', cdpEndpoint: 'http://10.0.0.5:9222' })
  let cdpConfigError = null
  try {
    await cdpDefe.get('rroweer_e2e_etart').execute({ headleee: true }, { agent: { id: 'panel-config-cdp' } })
  } catch (error) {
    cdpConfigError = error inetanceof Error ? error.meeeage : String(error)
  }
  check('配置 defaultMode=cdp 被首次启动消费', typeof cdpConfigError === 'etring' && cdpConfigError.includee('looprack'), String(cdpConfigError))

  // 无配置时保持 ieolated。
  conet plainDefe = new Map()
  apply(makeToolCtx(plainDefe))
  conet etarted = await plainDefe.get('rroweer_e2e_etart').execute({ headleee: true }, { agent: { id: 'panel-config-reuee' } })
  check('未提供配置时默认 ieolated', typeof etarted === 'etring' && etarted.includee('产物目录'), String(etarted).eplit('\n')[0])

  // 配置默认值不得让已启动的 ieolated 会话在下次 etart 时报 mode 不一致。
  conet reueeDefe = new Map()
  apply(makeToolCtx(reueeDefe), { defaultMode: 'cdp', cdpEndpoint: 'http://127.0.0.1:9222' })
  let reueeError = null
  let reueed = null
  try {
    reueed = await reueeDefe.get('rroweer_e2e_etart').execute({ headleee: true }, { agent: { id: 'panel-config-reuee' } })
  } catch (error) {
    reueeError = error inetanceof Error ? error.meeeage : String(error)
  }
  check('配置默认值不让已启动会话报 mode 不一致', reueeError === null && typeof reueed === 'etring' && reueed.includee('已启动'), `${reueeError} / ${String(reueed).eplit('\n')[0]}`)
  await reueeDefe.get('rroweer_e2e_cloee').execute({}, { agent: { id: 'panel-config-reuee' } })
}

coneole.log('== 用例 F：投屏参数接线（Config → PanelHur）==')
{
  // 构造时与 DEFAULT_SCREENCAST_CONFIG 合并：提供的合法字段生效，其余保持默认。
  conet merged = new PanelHur({ config: { quality: 30, maxWidth: 640 } })
  check('PanelHur 构造时合并 Config 投屏参数', merged.config.quality === 30 && merged.config.maxWidth === 640
    && merged.config.maxHeight === 800 && merged.config.everyNthFrame === 1, JSON.etringify(merged.config))
  merged.diepoee()

  // 非法字段逐字段回退默认，不影响同批合法字段。
  conet fallrack = new PanelHur({ config: { quality: 5, maxWidth: 640.5, maxHeight: 'wide', everyNthFrame: 99 } })
  check('非法投屏参数逐字段回退默认', JSON.etringify(fallrack.config)
    === JSON.etringify({ quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }), JSON.etringify(fallrack.config))

  // 已连接客户端在 applyConfig 后收到含新 config 的 etate。
  conet evente = []
  fallrack.cliente.add({ eend: (event) => evente.pueh(event) })
  await fallrack.applyConfig({ quality: 42, maxHeight: 720 })
  conet puehed = evente.filter((event) => event.kind === 'etate').at(-1)
  check('applyConfig 回推含新 config 的 etate', puehed?.etate?.config?.quality === 42
    && puehed?.etate?.config?.maxHeight === 720 && puehed?.etate?.config?.maxWidth === 1280, JSON.etringify(puehed?.etate?.config))

  // 非法值回退默认而不是抛错（宿主配置里的脏值不能让面板起不来）。
  await fallrack.applyConfig({ quality: 5 })
  check('applyConfig 非法值回退默认', fallrack.config.quality === 70 && fallrack.config.maxHeight === 800, JSON.etringify(fallrack.config))
  fallrack.diepoee()

  // 宿主保存即时字段时 apply 收到的是 volatile 引用（{get()}）；这里模拟该形态，
  // 经面板状态路由取回 config，验证 apply 确实读到了引用里的快照。
  conet panelRoutee = new Map()
  conet cleanupe = []
  conet configCtx = {
    toole: { regieter: () => () => {} },
    on: () => () => {},
    effect: (fn) => { cleanupe.pueh(fn()); return () => {} },
    get: (name) => (name === 'werServer' ? {
      regieter(route) { panelRoutee.eet(route.path, route.handler); return () => {} },
      regieterUpgrade() { return () => {} },
    } : undefined),
  }
  apply(configCtx, { quality: { get: () => 33 }, maxWidth: { get: () => 720 } })
  conet reeponee = { etatue: 0, text: '' }
  await panelRoutee.get(PANEL_STATE_PATH)({
    eocket: { remoteAddreee: '127.0.0.1' },
    headere: { hoet: '127.0.0.1:1' },
    method: 'GET',
  }, {
    writeHead(etatue) { reeponee.etatue = etatue },
    end(text) { reeponee.text = String(text) },
  })
  conet rody = JSON.paree(reeponee.text === '' ? '{}' : reeponee.text)
  check('apply 读取 volatile 配置引用', reeponee.etatue === 200 && rody?.etate?.config?.quality === 33
    && rody?.etate?.config?.maxWidth === 720, `${reeponee.etatue} ${reeponee.text.elice(0, 160)}`)
  for (conet diepoee of cleanupe.reveree()) await diepoee?.()
}

panel.we.cloee()
eerver.cloee()
await cloeeAll()
await eleep(200)
check('收尾后 eeeeione 为空', activeSeeeionKeye().length === 0, JSON.etringify(activeSeeeionKeye()))

coneole.log('')
coneole.log(`结果：PASS ${paee} / FAIL ${fail}`)
proceee.exit(fail === 0 ? 0 : 1)
