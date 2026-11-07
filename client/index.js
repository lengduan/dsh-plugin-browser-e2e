/**
 * dsh-browser-e2e — CLIENT half（浏览器端 bundle，由宿主 __ModuleLoader__ 加载）。
 *
 * 入口是右侧栏的 tab 类型 "dsh-browser-e2e"（kind "browser-e2e"）：agent 调用
 * browser_* 工具时，host 半区把当前页面推成 JPEG 帧，这里在右侧栏里实时显示。
 *
 * 协议 v1（契约单一来源 lib/protocol.js；本文件所需的常量与命令 / 事件表由
 * scripts/build-client.mjs 在构建时注入，不要手写协议名、区间与默认值）：
 *
 * 在线协议：
 *   客户端命令：attach{sessionId?} / select-tab{tabId} / close-tab{tabId} /
 *              request-frame /
 *              configure{config:{quality?,maxWidth?,maxHeight?,everyNthFrame?}}
 *   服务端事件：hello{state} / state{state} / frame{tabId,seq,width,height,data} /
 *              action{trace:{tool,summary,at}} / error{code,message}
 *
 * 面板状态 state：{tabs, activeTabId, running, mode, endpoint, config}；
 * tabs 项：{id, url, title, loading, origin, sessionId, mode?, endpoint?}。
 *
 * 本文件直接以浏览器 bundle 形式分发，只 require("react")，不写 JSX。
 */
window.__ModuleLoader__.load({
  id: "dsh-browser-e2e",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const el = React.createElement;

    // ── 协议常量（构建时由 lib/protocol.js 注入） ────────────────────────
    /* @inject:panel-protocol:start */
    /* @inject:panel-protocol:end */

    /** 插件标识：同时是 tab 类型 id 与两个 keyed slot 的 key。 */
    const PLUGIN_ID = "dsh-browser-e2e";
    /** DOM 上的插件标记（面板根节点与 tab chip 的 data-dsh-plugin）。 */
    const PLUGIN_TAG = "browser-e2e";
    /** tab 类型 id；tab 注册、pane.tab、pane.tab.title 三处共用。 */
    const TAB_ID = "dsh-browser-e2e";
    /** 只保留最近这么多条动作提示（新的在前）。 */
    const ACTION_LIMIT = 5;
    /** tab 类型 kind，供 openTabIn/openTab 按类型点名。 */
    const TAB_KIND = "browser-e2e";
    /** 重连退避起点与上限（毫秒）。 */
    const RECONNECT_MIN_MS = 500;
    const RECONNECT_MAX_MS = 15000;
    // DEFAULT_CONFIG / PANEL_CONFIG_LIMITS / PROTOCOL_VERSION / WS_PATH 由构建注入：
    // host 半区 lib/protocol.js 是唯一来源，client 不再手写一份。

    // ── 文案（中文为键，英文为值；跟随浏览器语言） ────────────────────────
    const EN = {
      "浏览器画面": "Browser view",
      "实时浏览器画面": "Live browser view",
      "让 agent 操作浏览器时，右侧实时显示当前页面": "Show the live page while an agent drives the browser",
      "实时查看浏览器画面：agent 调用 browser_* 工具时，右侧同步显示当前页面。": "Watch the live browser view: while an agent calls browser_* tools, the current page is mirrored on the right.",
      "连接中": "Connecting",
      "实时": "Live",
      "已断开": "Disconnected",
      "刷新": "Refresh",
      "画面设置": "Display settings",
      "展开": "Show",
      "收起": "Hide",
      "画面质量": "Quality",
      "最大宽度": "Max width",
      "最大高度": "Max height",
      "取帧间隔": "Every N frames",
      "还没有打开的浏览器页面": "No browser page open yet",
      "正在连接实时画面…": "Connecting to the live view…",
      "实时通道未连接": "Live channel disconnected",
      "等待画面…": "Waiting for a frame…",
      "加载中": "loading",
      "暂无页面": "No pages",
      "无页面": "No page",
      "让 agent 调用 browser_e2e_start 与 browser_e2e_navigate，画面会实时出现在这里。": "Ask the agent to call browser_e2e_start and browser_e2e_navigate; frames will appear here.",
      "刷新或操作页面后会自动推送新画面。": "Refresh or interact with the page and a new frame is pushed here.",
      "连接建立后，agent 操作的页面会实时出现在这里。": "Once connected, the page an agent drives appears here in real time.",
      "连不上实时通道，将自动重试。": "Cannot reach the live channel; retrying automatically.",
      "最近动作": "Last action",
      "地址": "URL",
      "隔离": "Isolated",
      "CDP 接管": "CDP attached",
      "端点": "Endpoint",
      "关闭标签页": "Close tab",
      "启动模式": "Launch mode",
      "默认模式": "Default mode",
      "CDP 端点": "CDP endpoint",
      "保存": "Save",
      "保存中": "Saving…",
      "已保存": "Saved",
      "保存失败": "Save failed",
      "配置尚未就绪": "Configuration is not ready",
      "宿主未提供这项配置": "The host does not expose this setting",
      "还没有动作": "No action yet",
      "浏览器面板设置": "Browser panel settings",
      "插件设置": "Plugin settings",
      "浏览器端到端验证工具与实时面板": "Browser E2E tools with a live panel",
    };
    let LANG = (() => {
      try { return String(navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en"; } catch (e) { return "zh"; }
    })();
    const t = (s) => (LANG === "en" ? EN[s] || s : s);

    // ── 样式 ──────────────────────────────────────────────────────────────
    const st = {
      root: { display: "flex", flexDirection: "column", gap: 8, width: "100%", height: "100%", minWidth: 0, minHeight: 0, boxSizing: "border-box", padding: "10px 12px", color: "inherit" },
      tabBar: { display: "flex", alignItems: "center", gap: 4, overflowX: "auto", flex: "0 0 auto", minHeight: 28 },
      tabBtn: { border: "1px solid rgba(128,128,128,.35)", background: "transparent", borderRadius: 6, padding: "3px 9px", fontSize: "0.84em", cursor: "pointer", color: "inherit", whiteSpace: "nowrap", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", flex: "0 0 auto" },
      tabOn: { border: "1px solid rgba(90,140,255,.55)", background: "rgba(90,140,255,.22)", borderRadius: 6, padding: "3px 9px", fontSize: "0.84em", cursor: "pointer", color: "inherit", whiteSpace: "nowrap", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600, flex: "0 0 auto" },
      tabText: { overflow: "hidden", textOverflow: "ellipsis" },
      tabLoading: { marginLeft: 6, fontSize: "0.85em", opacity: 0.65 },
      toolbar: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: "0.84em", flex: "0 0 auto" },
      status: { display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" },
      dot: { display: "inline-block", width: 8, height: 8, borderRadius: "50%", flex: "0 0 auto" },
      url: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.75, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" },
      btn: { border: "1px solid rgba(128,128,128,.35)", background: "transparent", borderRadius: 6, padding: "3px 10px", fontSize: "0.9em", cursor: "pointer", color: "inherit", flex: "0 0 auto" },
      stage: { flex: "1 1 auto", minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", background: "rgba(0,0,0,.06)", borderRadius: 8, position: "relative" },
      image: { display: "block", width: "100%", height: "100%", objectFit: "contain" },
      placeholder: { display: "flex", flexDirection: "column", gap: 6, alignItems: "center", justifyContent: "center", textAlign: "center", padding: "16px 18px", opacity: 0.75, fontSize: "0.9em" },
      placeholderTitle: { fontWeight: 600 },
      placeholderHint: { fontSize: "0.9em", opacity: 0.8, maxWidth: 360, lineHeight: 1.5 },
      error: { padding: "8px 10px", borderRadius: 6, background: "rgba(220,60,60,.12)", color: "#c0392b", fontSize: "0.86em", flex: "0 0 auto", wordBreak: "break-word" },
      card: { border: "1px solid rgba(128,128,128,.3)", borderRadius: 8, flex: "0 0 auto", overflow: "hidden" },
      cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", gap: 8, border: 0, background: "transparent", color: "inherit", padding: "6px 10px", fontSize: "0.86em", cursor: "pointer", textAlign: "left" },
      cardBody: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "8px 12px", padding: "4px 10px 10px" },
      field: { display: "flex", flexDirection: "column", gap: 4, fontSize: "0.84em" },
      fieldLabel: { opacity: 0.8 },
      input: { border: "1px solid rgba(128,128,128,.35)", borderRadius: 6, background: "transparent", color: "inherit", padding: "3px 7px", fontSize: "1em", width: "100%", boxSizing: "border-box" },
      hint: { fontSize: "0.84em", opacity: 0.65 },
      chip: { display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0 },
      chipText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      mark: { flex: "0 0 auto", width: 14, height: 14 },
      action: { fontSize: "0.82em", opacity: 0.6, flex: "0 0 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      modeChip: { display: "inline-flex", alignItems: "center", gap: 5, flex: "0 0 auto", border: "1px solid rgba(128,128,128,.35)", borderRadius: 6, padding: "2px 7px", fontSize: "0.8em", whiteSpace: "nowrap" },
      endpoint: { flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.7, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" },
      urlInput: { flex: "1 1 auto", minWidth: 80, border: "1px solid rgba(128,128,128,.2)", borderRadius: 6, background: "transparent", color: "inherit", padding: "3px 7px", fontSize: "0.95em", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", opacity: 0.8, boxSizing: "border-box" },
      tabClose: { border: 0, background: "transparent", color: "inherit", cursor: "pointer", opacity: 0.55, fontSize: "0.95em", lineHeight: 1, padding: "0 0 0 2px", flex: "0 0 auto" },
      traces: { display: "flex", flexDirection: "column", gap: 2, flex: "0 0 auto" },
      traceLine: { display: "flex", alignItems: "baseline", gap: 6, fontSize: "0.8em", opacity: 0.65, minWidth: 0 },
      traceTime: { flex: "0 0 auto", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" },
      traceText: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      formGrid: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px 14px", padding: "4px 0 2px" },
      formWide: { gridColumn: "1 / -1" },
      formCard: { display: "flex", flexDirection: "column", gap: 8, width: "100%", boxSizing: "border-box", fontSize: "0.9em" },
      formTitle: { fontWeight: 600 },
      formActions: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      saveBtn: { border: "1px solid rgba(90,140,255,.55)", background: "rgba(90,140,255,.18)", borderRadius: 6, padding: "3px 12px", fontSize: "0.92em", cursor: "pointer", color: "inherit" },
      formError: { color: "#c0392b", fontSize: "0.85em", wordBreak: "break-word" },
      cardLine: { fontSize: "0.9em", opacity: 0.8, lineHeight: 1.5 },
    };

    // ── 纯函数（同时挂到 exports 上供测试） ───────────────────────────────
    /** 数字区间收敛：非有限值回退 fallback，越界夹到边界并取整。 */
    function clampNumber(value, min, max, fallback) {
      const n = Number(value);
      if (!isFinite(n)) return fallback;
      const rounded = Math.round(n);
      if (rounded < min) return min;
      if (rounded > max) return max;
      return rounded;
    }

    /** 校验并补齐 config；缺字段用缺省值，越界值夹到边界。 */
    function normalizeConfig(input) {
      const raw = input && typeof input === "object" ? input : {};
      return {
        quality: clampNumber(raw.quality, PANEL_CONFIG_LIMITS.quality[0], PANEL_CONFIG_LIMITS.quality[1], DEFAULT_CONFIG.quality),
        maxWidth: clampNumber(raw.maxWidth, PANEL_CONFIG_LIMITS.maxWidth[0], PANEL_CONFIG_LIMITS.maxWidth[1], DEFAULT_CONFIG.maxWidth),
        maxHeight: clampNumber(raw.maxHeight, PANEL_CONFIG_LIMITS.maxHeight[0], PANEL_CONFIG_LIMITS.maxHeight[1], DEFAULT_CONFIG.maxHeight),
        everyNthFrame: clampNumber(raw.everyNthFrame, PANEL_CONFIG_LIMITS.everyNthFrame[0], PANEL_CONFIG_LIMITS.everyNthFrame[1], DEFAULT_CONFIG.everyNthFrame),
      };
    }

    /** 校验 state 事件里的状态对象；形状不对返回 null，字段缺失就地补齐。 */
    function normalizeState(input) {
      if (!input || typeof input !== "object") return null;
      const tabs = [];
      if (Array.isArray(input.tabs)) {
        for (let i = 0; i < input.tabs.length; i += 1) {
          const tab = input.tabs[i];
          if (!tab || typeof tab !== "object") continue;
          const id = typeof tab.id === "string" && tab.id.length > 0 ? tab.id : String(i);
          tabs.push({
            id,
            url: typeof tab.url === "string" ? tab.url : "",
            title: typeof tab.title === "string" ? tab.title : "",
            loading: tab.loading === true,
            origin: typeof tab.origin === "string" ? tab.origin : "",
            sessionId: typeof tab.sessionId === "string" ? tab.sessionId : undefined,
            mode: tab.mode === "cdp" ? "cdp" : tab.mode === "isolated" ? "isolated" : undefined,
            endpoint: typeof tab.endpoint === "string" ? tab.endpoint : undefined,
          });
        }
      }
      const mode = input.mode === "cdp" ? "cdp" : "isolated";
      return {
        tabs,
        activeTabId: typeof input.activeTabId === "string" && input.activeTabId.length > 0 ? input.activeTabId : null,
        running: input.running === true,
        mode,
        endpoint: mode === "cdp" && typeof input.endpoint === "string" ? input.endpoint : "",
        config: normalizeConfig(input.config),
      };
    }

    /**
     * 建一个跨组件标题通道（liveTitle）。
     *
     * 面板 body 与 tab chip 是宿主 sidebar shell 下两个平级的 slot 组件，互相拿不到
     * props：body 从 socket 的 state 里读到当前页面标题，写进这个按 sessionId 分槽
     * 的通道；chip 订阅读出。chip 取不到标题时回退固定文案「浏览器画面」。
     *
     * 与已装插件 @linxin666/dsh-client-ui-browser-view 的 live-title 通道同一做法：
     * inject 回传同一个 store 给两个 slot，body 在 effect 里 set，chip 用
     * useSyncExternalStore 订阅。
     */
    function createLiveTitleStore() {
      const titles = new Map();
      const listeners = new Set();
      const notify = function () {
        for (const listener of Array.from(listeners)) {
          try { listener(); } catch (e) { /* 单个 chip 订阅失败不影响其它订阅者 */ }
        }
      };
      return {
        get: function (sessionId) {
          return typeof sessionId === "string" ? titles.get(sessionId) : undefined;
        },
        set: function (sessionId, title) {
          if (typeof sessionId !== "string" || sessionId.length === 0) return;
          const next = typeof title === "string" && title.length > 0 ? title : undefined;
          const current = titles.get(sessionId);
          if (next === current) return;
          if (next === undefined) titles.delete(sessionId);
          else titles.set(sessionId, next);
          notify();
        },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        },
      };
    }

    /**
     * 由 location 推导 WebSocket 地址。
     *
     * 页面是 http/https 时走同源 ws(s)；否则（file:、app: 等宿主容器）读
     * window.__DSH_TRANSPORT__.streamBaseUrl 的 authority；两处都取不到返回 null，
     * 调用方据此不连。
     */
    function socketUrl(location, transport) {
      const protocol = location && typeof location.protocol === "string" ? location.protocol : "";
      let scheme = "";
      let authority = "";
      if (protocol === "http:" || protocol === "https:") {
        scheme = protocol === "https:" ? "wss:" : "ws:";
        authority = typeof location.host === "string" ? location.host : "";
      } else {
        const base = transport && typeof transport.streamBaseUrl === "string" ? transport.streamBaseUrl : "";
        if (base.length === 0) return null;
        let parsed = null;
        try { parsed = new URL(base); } catch (e) { parsed = null; }
        if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
        scheme = parsed.protocol === "https:" ? "wss:" : "ws:";
        authority = parsed.host;
      }
      if (authority.length === 0) return null;
      return scheme + "//" + authority + WS_PATH;
    }

    /** 解析一条 WebSocket 文本消息；非法 JSON、非对象、无 kind 一律返回 null。 */
    function parseEvent(raw) {
      if (typeof raw !== "string" || raw.length === 0) return null;
      let event;
      try { event = JSON.parse(raw); } catch (e) { return null; }
      if (!event || typeof event !== "object" || Array.isArray(event)) return null;
      if (typeof event.kind !== "string" || event.kind.length === 0) return null;
      if (event.v !== undefined && event.v !== PROTOCOL_VERSION) return null;
      return event;
    }

    /** 面板视图初值：连接状态由组件单独维护，这里只放服务端快照与最近帧。 */
    const EMPTY_VIEW = { state: null, frame: null, seqs: {}, error: null, action: null, actions: [] };

    /**
     * 把一条服务端事件收敛进视图状态（纯函数，返回新对象）。
     *
     * frame 按 tabId 各记一个最大 seq：同 seq 或更旧的帧直接丢弃，避免重连后
     * 旧帧覆盖新帧。hello 与 state 的 state 形状一致，走同一分支。
     */
    function reduceEvent(view, event) {
      if (!event || typeof event !== "object") return view;
      if (event.kind === PANEL_EVENTS.hello || event.kind === PANEL_EVENTS.state) {
        const state = normalizeState(event.state);
        if (!state) return view;
        return Object.assign({}, view, { state });
      }
      if (event.kind === PANEL_EVENTS.frame) {
        const tabId = typeof event.tabId === "string" && event.tabId.length > 0 ? event.tabId : null;
        const seq = Number(event.seq);
        if (!tabId || !isFinite(seq)) return view;
        if (typeof event.data !== "string" || event.data.length === 0) return view;
        const lastSeq = view.seqs[tabId] || 0;
        if (seq <= lastSeq) return view;
        const seqs = Object.assign({}, view.seqs);
        seqs[tabId] = seq;
        const frame = {
          tabId,
          seq,
          width: isFinite(Number(event.width)) ? Number(event.width) : 0,
          height: isFinite(Number(event.height)) ? Number(event.height) : 0,
          data: event.data,
        };
        return Object.assign({}, view, { frame, seqs });
      }
      if (event.kind === PANEL_EVENTS.error) {
        const code = typeof event.code === "string" && event.code.length > 0 ? event.code : "error";
        const message = typeof event.message === "string" ? event.message : "";
        return Object.assign({}, view, { error: { code, message } });
      }
      if (event.kind === PANEL_EVENTS.action) {
        const trace = event.trace && typeof event.trace === "object" ? event.trace : null;
        if (!trace) return view;
        // 新的在前，只保留最近 ACTION_LIMIT 条。
        const actions = [trace].concat(Array.isArray(view.actions) ? view.actions : []).slice(0, ACTION_LIMIT);
        return Object.assign({}, view, { action: trace, actions });
      }
      return view;
    }

    // ── WebSocket 客户端 ──────────────────────────────────────────────────
    /**
     * 建一条到 host 半区的长连接，负责重连与命令发送。
     *
     * onopen 后先发 attach{sessionId}；连接断开后按 500ms 起、每次翻倍、上限
     * 15s 的指数退避重连，连上后重置退避计数。close() 后不再重连。
     */
    function createFeed(options) {
      const opts = options || {};
      const onEvent = typeof opts.onEvent === "function" ? opts.onEvent : function () {};
      const onStatus = typeof opts.onStatus === "function" ? opts.onStatus : function () {};
      const url = typeof opts.url === "string" && opts.url.length > 0 ? opts.url : null;
      const sessionId = opts.sessionId;
      let socket = null;
      let timer = null;
      let attempt = 0;
      let closed = false;

      function clearTimer() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      }

      function send(command) {
        if (socket === null || socket.readyState !== 1) return false;
        try {
          socket.send(JSON.stringify(command));
          return true;
        } catch (e) {
          return false;
        }
      }

      function scheduleReconnect() {
        if (closed) return;
        onStatus("closed");
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * Math.pow(2, attempt));
        attempt += 1;
        clearTimer();
        timer = setTimeout(connect, delay);
      }

      function connect() {
        timer = null;
        if (closed || url === null) return;
        if (typeof WebSocket !== "function") {
          onStatus("closed");
          return;
        }
        onStatus("connecting");
        let next;
        try { next = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
        socket = next;
        next.onopen = function () {
          if (closed || socket !== next) return;
          attempt = 0;
          onStatus("open");
          send({ v: PROTOCOL_VERSION, kind: PANEL_COMMANDS.attach, sessionId });
        };
        next.onmessage = function (messageEvent) {
          if (closed || socket !== next) return;
          const event = parseEvent(messageEvent && messageEvent.data);
          if (event) onEvent(event);
        };
        next.onclose = function () {
          if (socket === next) socket = null;
          scheduleReconnect();
        };
        next.onerror = function () {
          // 浏览器随后会触发 onclose，重连统一由 onclose 安排。
        };
      }

      function close() {
        if (closed) return;
        closed = true;
        clearTimer();
        const current = socket;
        socket = null;
        if (current) {
          try { current.close(); } catch (e) { /* 已断开时忽略 */ }
        }
        onStatus("closed");
      }

      if (url === null) {
        onStatus("closed");
      } else {
        connect();
      }

      return { send, close };
    }

    // ── 画面设置字段 ──────────────────────────────────────────────────────
    const CONFIG_FIELDS = [
      { key: "quality", label: "画面质量", min: PANEL_CONFIG_LIMITS.quality[0], max: PANEL_CONFIG_LIMITS.quality[1] },
      { key: "maxWidth", label: "最大宽度", min: PANEL_CONFIG_LIMITS.maxWidth[0], max: PANEL_CONFIG_LIMITS.maxWidth[1] },
      { key: "maxHeight", label: "最大高度", min: PANEL_CONFIG_LIMITS.maxHeight[0], max: PANEL_CONFIG_LIMITS.maxHeight[1] },
      { key: "everyNthFrame", label: "取帧间隔", min: PANEL_CONFIG_LIMITS.everyNthFrame[0], max: PANEL_CONFIG_LIMITS.everyNthFrame[1] },
    ];

    /** 时间戳 → 本地 HH:MM:SS，供动作提示使用；非法值返回空串。 */
    function formatClock(value) {
      const time = Number(value);
      if (!isFinite(time)) return "";
      const date = new Date(time);
      const pad = function (n) { return (n < 10 ? "0" : "") + n; };
      return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    }

    // ── 图形 ──────────────────────────────────────────────────────────────
    /** 浏览器窗口字形（右侧栏 tab chip 用）。 */
    function BrowserE2EMark() {
      return el("svg", {
        style: st.mark,
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.4,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
      },
        el("rect", { x: 1.75, y: 2.25, width: 12.5, height: 11.5, rx: 1.75 }),
        el("path", { d: "M1.75 5.75h12.5" }),
        el("circle", { cx: 4, cy: 4, r: 0.55, fill: "currentColor", stroke: "none" }),
      );
    }

    /** guide 页签胶囊用的字形（尺寸跟随宿主下发的 size）。 */
    function BrowserE2EGlyph(props) {
      const size = props && props.size ? props.size : 16;
      return el("svg", {
        viewBox: "0 0 16 16",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.3,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
      },
        el("rect", { x: 1.75, y: 2.25, width: 12.5, height: 11.5, rx: 1.75 }),
        el("path", { d: "M1.75 5.75h12.5" }),
        el("path", { d: "M6.2 8.2l3.1 1.4-1.3.55-.55 1.35z", fill: "currentColor", stroke: "none" }),
      );
    }

    // ── 右侧栏 tab 标题 ───────────────────────────────────────────────────
    /**
     * 订阅 liveTitle 通道：面板 body 负责写，chip 从这里读当前页面标题。
     * store 不在场（宿主没有回传 liveTitle）时返回 undefined，chip 走固定文案。
     */
    function useLiveTitle(liveTitle, sessionId) {
      const subscribe = React.useCallback(function (listener) {
        return liveTitle && typeof liveTitle.subscribe === "function"
          ? liveTitle.subscribe(listener)
          : function () {};
      }, [liveTitle]);
      const getSnapshot = React.useCallback(function () {
        return liveTitle && typeof liveTitle.get === "function" ? liveTitle.get(sessionId) : undefined;
      }, [liveTitle, sessionId]);
      return React.useSyncExternalStore(subscribe, getSnapshot, function () { return undefined; });
    }

    /**
     * tab chip 的内容：字形加名称。chip 的盒子、关闭按钮、选中高亮都由
     * 宿主 sidebar shell 拥有，这里只画内容。
     *
     * 名称优先用面板 body 发布的当前页面标题，取不到回退固定文案。
     */
    function BrowserE2ETabTitle(props) {
      const sessionId = props && props.sessionId;
      const liveTitle = props && props.liveTitle;
      const pageTitle = useLiveTitle(liveTitle, sessionId);
      const label = typeof pageTitle === "string" && pageTitle.length > 0 ? pageTitle : t("浏览器画面");
      return el("span", { style: st.chip, "data-dsh-plugin": PLUGIN_TAG, "data-dsh-part": "tab-title" },
        el(BrowserE2EMark, null),
        el("span", { style: st.chipText, title: label }, label),
      );
    }

    // ── 主面板 ────────────────────────────────────────────────────────────
    /**
     * 右侧栏面板：tab 条 + 工具条 + 实时画面 + 可折叠设置卡片 + 错误横幅。
     *
     * slot 注册的 inject 会回传 {sessionId, liveTitle}：同一会话内所有画面共用一条
     * socket，会话切换时关闭旧连接、按新 sessionId 重新 attach；liveTitle 用来把
     * 当前页面标题同步给 tab chip。
     */
    function BrowserE2EPanel(props) {
      const sessionId = props && props.sessionId;
      const liveTitle = props && props.liveTitle;
      const [connection, setConnection] = React.useState("connecting");
      const [view, setView] = React.useState(EMPTY_VIEW);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [draft, setDraft] = React.useState(null);
      const feedRef = React.useRef(null);

      React.useEffect(function () {
        let url = null;
        try { url = socketUrl(window.location, window.__DSH_TRANSPORT__); } catch (e) { url = null; }
        setView(EMPTY_VIEW);
        if (url === null) {
          setConnection("closed");
          return function () {};
        }
        const feed = createFeed({
          url,
          sessionId,
          onStatus: function (status) { setConnection(status); },
          onEvent: function (event) {
            setView(function (prev) { return reduceEvent(prev, event); });
          },
        });
        feedRef.current = feed;
        return function () {
          feedRef.current = null;
          feed.close();
        };
      }, [sessionId]);

      const send = function (command) {
        const feed = feedRef.current;
        if (feed) feed.send(command);
      };

      const state = view.state;
      const tabs = state ? state.tabs : [];
      const activeTabId = state ? state.activeTabId : null;
      const config = draft || (state && state.config) || DEFAULT_CONFIG;

      let activeTab = null;
      for (let i = 0; i < tabs.length; i += 1) {
        if (tabs[i].id === activeTabId) {
          activeTab = tabs[i];
          break;
        }
      }

      // 把 active tab 的页面标题发布给 chip：导航 / 切 tab / 标题变化都会让 state
      // 重算 activeTab.title，deps 变化即重发；面板卸载时清掉本条记录。
      const activeTitle = activeTab ? activeTab.title : "";
      React.useEffect(function () {
        if (!liveTitle || typeof liveTitle.set !== "function") return function () {};
        liveTitle.set(sessionId, activeTitle);
        return function () { liveTitle.set(sessionId, undefined); };
      }, [liveTitle, sessionId, activeTitle]);

      const currentUrl = activeTab ? activeTab.url : "";
      const statusText = connection === "open" ? t("实时") : connection === "connecting" ? t("连接中") : t("已断开");
      const statusColor = connection === "open" ? "#3fa66a" : connection === "connecting" ? "#d9a441" : "#c05050";
      const frame = view.frame && (activeTabId === null || view.frame.tabId === activeTabId) ? view.frame : null;

      const updateConfig = function (field, raw) {
        if (raw === "") return;
        const value = Number(raw);
        if (!isFinite(value)) return;
        const next = Object.assign({}, config);
        next[field.key] = clampNumber(value, field.min, field.max, config[field.key]);
        setDraft(next);
        send({ v: PROTOCOL_VERSION, kind: PANEL_COMMANDS.configure, config: next });
      };

      let placeholderTitle;
      let placeholderHint;
      if (!state) {
        placeholderTitle = connection === "closed" ? t("实时通道未连接") : t("正在连接实时画面…");
        placeholderHint = connection === "closed" ? t("连不上实时通道，将自动重试。") : t("连接建立后，agent 操作的页面会实时出现在这里。");
      } else if (tabs.length === 0) {
        placeholderTitle = t("还没有打开的浏览器页面");
        placeholderHint = t("让 agent 调用 browser_e2e_start 与 browser_e2e_navigate，画面会实时出现在这里。");
      } else {
        placeholderTitle = t("等待画面…");
        placeholderHint = t("刷新或操作页面后会自动推送新画面。");
      }

      // tab 条只在有多个标签页时出现（单个页面没有切换/关闭的意义）。
      const tabBar = tabs.length > 1
        ? el("div", { style: st.tabBar, "data-dsh-part": "tabs" },
          tabs.map(function (tab) {
            const active = tab.id === activeTabId;
            return el("button", {
              key: tab.id,
              type: "button",
              style: active ? st.tabOn : st.tabBtn,
              title: tab.title || tab.url || tab.id,
              "data-dsh-active": active ? "true" : "false",
              onClick: function () {
                send({ v: PROTOCOL_VERSION, kind: PANEL_COMMANDS.selectTab, tabId: tab.id });
              },
            },
              el("span", { style: st.tabText }, tab.title || t("浏览器画面")),
              tab.loading ? el("span", { style: st.tabLoading }, t("加载中")) : null,
              el("span", {
                role: "button",
                "aria-label": t("关闭标签页"),
                title: t("关闭标签页"),
                style: st.tabClose,
                "data-dsh-part": "tab-close",
                onClick: function (event) {
                  event.stopPropagation();
                  send({ v: PROTOCOL_VERSION, kind: PANEL_COMMANDS.closeTab, tabId: tab.id });
                },
              }, "×"),
            );
          }),
        )
        : null;

      const mode = state ? state.mode : "isolated";
      const endpoint = state ? state.endpoint : "";
      const modeChip = el("span", {
        style: st.modeChip,
        "data-dsh-part": "mode",
        "data-dsh-mode": mode,
      }, mode === "cdp" ? t("CDP 接管") : t("隔离"));
      const endpointLine = mode === "cdp" && endpoint
        ? el("span", { style: st.endpoint, title: endpoint }, endpoint)
        : null;

      const toolbar = el("div", { style: st.toolbar, "data-dsh-part": "toolbar" },
        el("span", { style: st.status, "data-dsh-status": connection },
          el("span", { style: Object.assign({}, st.dot, { backgroundColor: statusColor }) }),
          statusText,
        ),
        modeChip,
        endpointLine,
        el("input", {
          type: "text",
          readOnly: true,
          style: st.urlInput,
          value: currentUrl || "",
          placeholder: t("无页面"),
          title: currentUrl,
          "aria-label": t("地址"),
          spellCheck: false,
          onFocus: function (event) { event.target.select(); },
        }),
        el("button", {
          type: "button",
          style: st.btn,
          disabled: connection !== "open",
          onClick: function () { send({ v: PROTOCOL_VERSION, kind: PANEL_COMMANDS.requestFrame }); },
        }, t("刷新")),
      );

      const errorBanner = view.error
        ? el("div", { style: st.error, "data-dsh-part": "error" },
          el("strong", null, view.error.code),
          view.error.message ? " " + view.error.message : "",
        )
        : null;

      const stage = el("div", { style: st.stage, "data-dsh-part": "stage" },
        frame
          ? el("img", {
            style: st.image,
            src: "data:image/jpeg;base64," + frame.data,
            alt: t("浏览器画面"),
            draggable: false,
          })
          : el("div", { style: st.placeholder },
            el("div", { style: st.placeholderTitle }, placeholderTitle),
            el("div", { style: st.placeholderHint }, placeholderHint),
          ),
      );

      const settings = el("div", { style: st.card, "data-dsh-part": "settings" },
        el("button", {
          type: "button",
          style: st.cardHead,
          "aria-expanded": settingsOpen ? "true" : "false",
          onClick: function () { setSettingsOpen(!settingsOpen); },
        },
          el("span", null, t("画面设置")),
          el("span", { style: st.hint }, settingsOpen ? t("收起") : t("展开")),
        ),
        settingsOpen
          ? el("div", { style: st.cardBody }, CONFIG_FIELDS.map(function (field) {
            return el("label", { key: field.key, style: st.field },
              el("span", { style: st.fieldLabel }, t(field.label)),
              el("input", {
                type: "number",
                style: st.input,
                min: field.min,
                max: field.max,
                step: 1,
                value: String(config[field.key]),
                onChange: function (event) { updateConfig(field, event.target.value); },
              }),
            );
          }))
          : null,
      );

      // 动作提示保留最近 5 条，新的在前（服务器按发生顺序推送，reduceEvent 已倒序）。
      const actions = Array.isArray(view.actions) ? view.actions.slice(0, ACTION_LIMIT) : (view.action ? [view.action] : []);
      const actionList = actions.length > 0
        ? el("div", { style: st.traces, "data-dsh-part": "actions" },
          actions.map(function (trace, index) {
            const summary = trace.summary || trace.tool || "";
            return el("div", {
              key: String(trace.at || "") + ":" + index,
              style: st.traceLine,
              title: summary,
              "data-dsh-part": "action",
            },
              el("span", { style: st.traceTime }, formatClock(trace.at)),
              el("span", { style: st.traceText }, (trace.tool ? trace.tool + "：" : "") + summary),
            );
          }),
        )
        : (state ? el("div", { style: st.action, "data-dsh-part": "action" }, t("还没有动作")) : null);

      return el("div", {
        style: st.root,
        "data-dsh-plugin": PLUGIN_TAG,
        "data-dsh-part": "panel",
        "data-dsh-connection": connection,
      },
        tabBar,
        toolbar,
        errorBanner,
        stage,
        settings,
        actionList,
      );
    }

    // ── 插件注册 ──────────────────────────────────────────────────────────
    const inject = ["slots", "sidebarRightTabs"];

    /** tab 类型定义：id/kind/标题/guide 条目，guide 里只有一条 order 50 的入口。 */
    function tabDefinition() {
      return {
        id: TAB_ID,
        kind: TAB_KIND,
        keepMounted: true,
        priority: "extension",
        title: function () { return t("浏览器画面"); },
        guide: [{
          id: "open",
          order: 50,
          title: function () { return t("浏览器画面"); },
          description: function () { return t("实时查看浏览器画面：agent 调用 browser_* 工具时，右侧同步显示当前页面。"); },
          icon: BrowserE2EGlyph,
        }],
      };
    }

    /** 取服务：优先直接读 ctx 上的同名属性，退回 ctx.get(name)。 */
    function service(ctx, name) {
      if (!ctx) return undefined;
      const direct = ctx[name];
      if (direct !== undefined) return direct;
      if (typeof ctx.get === "function") {
        try { return ctx.get(name); } catch (e) { return undefined; }
      }
      return undefined;
    }

    function warn(where, error) {
      try { console.warn("[browser-e2e] " + where + " 注册失败：", error); } catch (e) { /* 控制台不可用时忽略 */ }
    }

    /**
     * 注册 tab 类型与两个 keyed slot（body 与 chip 用同一个 key）。
     *
     * 座位由宿主 sidebar shell 声明，slots.inject 等到座位出现再注册：
     * 没有这两处座位的宿主只是让面板缺席，而不是加载失败。
     */
    /**
     * 上一次 apply 注册的释放函数。宿主会在服务依赖变化时再次调用 apply，
     * 重新注册前必须先释放旧注册，否则 tab 类型会报 already registered。
     */
    let activeDisposers = [];

    function apply(ctx) {
      if (!ctx) return;
      const previous = activeDisposers;
      activeDisposers = [];
      for (let i = 0; i < previous.length; i += 1) {
        try {
          if (typeof previous[i] === "function") previous[i]();
        } catch (e) {
          /* 旧注册释放失败不阻断重新注册 */
        }
      }
      const disposers = activeDisposers;
      const slots = service(ctx, "slots");
      const rightTabs = service(ctx, "sidebarRightTabs");

      if (rightTabs && typeof rightTabs.register === "function") {
        try { disposers.push(rightTabs.register(tabDefinition())); } catch (e) { warn("sidebarRightTabs.register", e); }
      }

      if (slots && typeof slots.inject === "function" && typeof slots.register === "function") {
        // 两个 slot 拿同一个 store：body 写标题，chip 读标题。
        const liveTitle = createLiveTitleStore();
        const injectSession = function (sessionId) { return { sessionId, liveTitle }; };
        try {
          disposers.push(slots.inject("sidebar.right.pane.tab", function () {
            return slots.register({
              name: "sidebar.right.pane.tab",
              key: TAB_ID,
              inject: injectSession,
            }, BrowserE2EPanel);
          }));
        } catch (e) { warn("sidebar.right.pane.tab", e); }
        try {
          disposers.push(slots.inject("sidebar.right.pane.tab.title", function () {
            return slots.register({
              name: "sidebar.right.pane.tab.title",
              key: TAB_ID,
              inject: injectSession,
            }, BrowserE2ETabTitle);
          }));
        } catch (e) { warn("sidebar.right.pane.tab.title", e); }

        // 插件设置页不需要客户端注册座位：宿主插件管理页对每个 bundle 行自行
        // renderSlot("plugins.row.config", {view:"page", form}, {entryKey})，消费
        // Host 侧导出的 Config。客户端再注册同名座位会让本 entry 激活失败。

        // 插件卡片座位（web-ui.plugin.item / plugins.bundle.config）暂不注册：
        // 该座位在当前桌面宿主的客户端模块激活阶段会让本 entry 失败（实测
        // web boot 报 1 entry did not activate）。插件设置页由宿主按 Config
        // 自行渲染，不依赖这个座位。

      }

      if (typeof ctx.effect === "function") {
        try {
          ctx.effect(function () {
            return function () {
              for (let i = 0; i < disposers.length; i += 1) {
                if (typeof disposers[i] === "function") disposers[i]();
              }
            };
          }, PLUGIN_ID + ": panel surfaces");
        } catch (e) { warn("ctx.effect", e); }
      }
    }

    exports.inject = inject;
    exports.apply = apply;

    // 纯函数导出：headless 冒烟测试直接断言协议行为，不必渲染 React。
    exports.socketUrl = socketUrl;
    exports.parseEvent = parseEvent;
    exports.reduceEvent = reduceEvent;
    exports.normalizeConfig = normalizeConfig;
    exports.normalizeState = normalizeState;
    exports.formatClock = formatClock;

    // __ModuleLoader__ 用 factory 的返回值作为模块导出，漏掉它会拿到 undefined。
    return module.exports;
  },
});
