// 锁屏多路线检测：一次运行汇总所有探测，返回单一结论。
// 用法: lockprobe.exe [--json] [--selftest]
use std::ffi::c_void;
use std::process::ExitCode;
use std::time::Instant;

#[repr(C)]
struct LastInputInfo {
    cb_size: u32,
    dw_time: u32,
}

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[link(name = "user32")]
extern "system" {
    fn GetThreadDesktop(tid: u32) -> *mut c_void;
    fn GetCursorPos(p: *mut Point) -> i32;
    fn WindowFromPoint(p: Point) -> *mut c_void;
    fn GetUserObjectInformationW(h: *mut c_void, index: i32, info: *mut u16, len: u32, needed: *mut u32) -> i32;
    fn GetForegroundWindow() -> *mut c_void;
    fn GetWindowThreadProcessId(h: *mut c_void, pid: *mut u32) -> u32;
    fn GetClassNameW(h: *mut c_void, buf: *mut u16, n: i32) -> i32;
    fn GetLastInputInfo(li: *mut LastInputInfo) -> i32;
    fn GetShellWindow() -> *mut c_void;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentThreadId() -> u32;
    fn GetTickCount() -> u32;
    fn GetLastError() -> u32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn QueryFullProcessImageNameW(h: *mut c_void, flags: u32, buf: *mut u16, size: *mut u32) -> i32;
    fn CloseHandle(h: *mut c_void) -> i32;
}

#[link(name = "wtsapi32")]
extern "system" {
    fn WTSQuerySessionInformationW(server: *mut c_void, session: i32, class: i32, buf: *mut *mut c_void, bytes: *mut u32) -> i32;
    fn WTSFreeMemory(p: *mut c_void);
}

const UOI_NAME: i32 = 2;
const ERROR_ACCESS_DENIED: u32 = 5;
const WTSSESSIONINFOEX: i32 = 25;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

fn wide_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

fn read_u32(base: *const u8, off: usize) -> u32 {
    let mut b = [0u8; 4];
    for i in 0..4 { b[i] = unsafe { *base.add(off + i) }; }
    u32::from_le_bytes(b)
}

/// 由窗口句柄解析出可执行文件名（小写）。
fn window_process_name(hwnd: *mut c_void) -> Option<String> {
    if hwnd.is_null() { return None; }
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 { return None; }
        let ph = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if ph.is_null() { return None; }
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(ph, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(ph);
        if ok == 0 { return None; }
        let full = String::from_utf16_lossy(&buf[..size as usize]);
        let base = full.rsplit(['\\', '/']).next().unwrap_or(&full);
        Some(base.to_lowercase())
    }
}

/// 读取桌面 / 窗口站对象的名字；失败返回 None。
fn user_object_name(h: *mut c_void) -> Option<String> {
    if h.is_null() { return None; }
    unsafe {
        let mut buf = [0u16; 256];
        let mut need = 0u32;
        let ok = GetUserObjectInformationW(h, UOI_NAME, buf.as_mut_ptr(), (buf.len() * 2) as u32, &mut need);
        if ok == 0 { None } else { Some(wide_to_string(&buf)) }
    }
}

/// 路线 1 的判定核心：前台窗口所在桌面还能不能被我命名。
///
/// 换掉旧判据的原因（实测 2026-11-21）：锁屏期间 `OpenInputDesktop` 依然成功且桌面名仍是
/// `Default`，于是「桌面名 == Default 即未锁」全程误判；真正随锁屏改变的，是前台窗口
/// （LogonUI / LockApp）那张桌面的可及性——锁屏时它是我无权访问的安全桌面，
/// `GetThreadDesktop` 返回 NULL 且 `GetLastError() == ERROR_ACCESS_DENIED`。
fn judge_desktop_access(
    own: &str,
    has_foreground: bool,
    tid: u32,
    fg_desktop: Option<&str>,
    err: u32,
) -> (Option<bool>, String) {
    if !has_foreground {
        return (None, "no foreground window".into());
    }
    if tid == 0 {
        return (None, "foreground window has no thread".into());
    }
    match fg_desktop {
        Some(name) if name.eq_ignore_ascii_case(own) => (
            Some(false),
            format!("fg_desktop=\"{}\" 与自己所在桌面一致", name),
        ),
        Some(name) if name.eq_ignore_ascii_case("winlogon") => (
            Some(true),
            format!("fg_desktop=\"{}\" 是安全桌面", name),
        ),
        Some(name) => (
            None,
            format!("fg_desktop=\"{}\" 与自身桌面 \"{}\" 不同，不据此定论", name, own),
        ),
        None if err == ERROR_ACCESS_DENIED => (
            Some(true),
            format!("fg_desktop 不可访问 err={}（安全桌面）", err),
        ),
        None => (None, format!("fg_desktop 查询失败 err={}", err)),
    }
}

/// 光标所在窗口的类名。
/// 锁屏时该窗口由锁屏界面（`LockApp` 的 `LockScreenBackstopFrame`）占住；
/// 未锁屏时是普通应用窗口。这条判据不依赖前台窗口，覆盖 `GetForegroundWindow()` 返回 NULL 的锁屏阶段。
fn class_at_cursor() -> Option<String> {
    unsafe {
        let mut pt = Point { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 { return None; }
        let h = WindowFromPoint(pt);
        if h.is_null() { return None; }
        let mut buf = [0u16; 256];
        let n = GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32);
        if n <= 0 { return None; }
        Some(String::from_utf16_lossy(&buf[..n as usize]))
    }
}

/// 锁屏背板窗口类名（`LockApp` / `LogonUI` 的锁屏层）。
fn is_lock_screen_class(class: &str) -> bool {
    class.eq_ignore_ascii_case("LockScreenBackstopFrame")
}

/// 路线 1：前台窗口的桌面归属（强信号）。
///
/// 两条互补的判据，都不依赖「输入桌面名是否为 Default」：
/// 1. 前台窗口所在桌面能否被我命名——锁屏时前台在安全桌面上，`GetThreadDesktop` 被拒；
/// 2. 前台窗口不可得时（锁屏后期 `GetForegroundWindow` 返回 NULL），看光标位置命中哪个窗口：
///    锁屏界面由 `LockApp` 的 `LockScreenBackstopFrame` 铺满全屏，该窗口类只在锁屏时出现。
fn probe_input_desktop() -> (Option<bool>, String) {
    unsafe {
        let own = match user_object_name(GetThreadDesktop(GetCurrentThreadId())) {
            Some(name) => name,
            None => return (None, format!("own desktop name failed err={}", GetLastError())),
        };
        let fg = GetForegroundWindow();
        if fg.is_null() {
            // 锁屏后期前台窗口不再可见，改用光标处的窗口类。
            return match class_at_cursor() {
                Some(class) if is_lock_screen_class(&class) => {
                    (Some(true), format!("no foreground; cursor on class=\"{}\"", class))
                }
                Some(class) => (
                    None,
                    format!("no foreground; cursor on class=\"{}\"，不据此定论", class),
                ),
                None => (None, "no foreground window; cursor class unavailable".into()),
            };
        }
        let mut pid = 0u32;
        let tid = GetWindowThreadProcessId(fg, &mut pid);
        let dh = GetThreadDesktop(tid);
        let err = GetLastError();
        let name = user_object_name(dh);
        let (verdict, detail) = judge_desktop_access(&own, true, tid, name.as_deref(), err);
        // 前台窗口能命名且与本线程桌面一致时仍可能漏判（历史锁屏出现过残留窗口当前台），
        // 用光标处的窗口类做一次只读复核：命中锁屏背板即改判已锁。
        if verdict == Some(false) {
            if let Some(class) = class_at_cursor() {
                if is_lock_screen_class(&class) {
                    return (Some(true), format!("{}; 但 cursor class=\"{}\" 为锁屏背板", detail, class));
                }
            }
        }
        (verdict, detail)
    }
}

/// 路线 2：WTSINFOEXW 会话标志（强信号）。
/// 布局：Level @0, Data @8（因内部 LARGE_INTEGER 对齐）
///   SessionId @8, State @12, Flags @16；Flags: 1=UNLOCK 0=LOCK
fn probe_wts_flags() -> (Option<bool>, String) {
    unsafe {
        let mut buf: *mut c_void = std::ptr::null_mut();
        let mut bytes = 0u32;
        if WTSQuerySessionInformationW(std::ptr::null_mut(), -1, WTSSESSIONINFOEX, &mut buf, &mut bytes) == 0 {
            return (None, format!("query failed err={}", GetLastError()));
        }
        if buf.is_null() || bytes < 20 {
            WTSFreeMemory(buf);
            return (None, format!("short buffer bytes={}", bytes));
        }
        let base = buf as *const u8;
        let level = read_u32(base, 0);
        let session_id = read_u32(base, 8);
        let state = read_u32(base, 12);
        let flags = read_u32(base, 16);
        WTSFreeMemory(buf);

        let state_name = match state { 0 => "Active", 1 => "Connected", 4 => "Disconnected", _ => "Other" };
        let locked = match flags { 0 => Some(true), 1 => Some(false), _ => None };
        let detail = format!(
            "flags={}({}) state={}({}) session={} level={}",
            flags,
            match flags { 0 => "LOCK", 1 => "UNLOCK", _ => "INVALID" },
            state, state_name, session_id, level
        );
        (locked, detail)
    }
}

/// 路线 3：前台窗口是否为锁屏 UI（弱信号，仅作旁证）。
fn probe_foreground() -> (Option<bool>, String) {
    unsafe {
        let h = GetForegroundWindow();
        if h.is_null() {
            return (None, "no foreground window".into());
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, &mut pid);
        let mut cls = [0u16; 256];
        let n = GetClassNameW(h, cls.as_mut_ptr(), cls.len() as i32);
        let class = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
        let proc = window_process_name(h).unwrap_or_else(|| "?".into());
        // LogonUI 承载锁屏/登录界面；LockApp 常驻，单独出现不代表锁屏。
        // 进程名解析不出（"?"）时一律记 None：既可能是锁屏期 OpenProcess 被拒，也可能是
        // 未锁屏时受保护进程当前台，两种方向都不敢断言，交给别的信号。
        let locked = match proc.as_str() {
            "logonui.exe" => Some(true),
            "lockapp.exe" => None,
            "?" => None,
            _ => Some(false),
        };
        (locked, format!("pid={} proc={} class={}", pid, proc, class))
    }
}

/// 路线 4：桌面 shell（explorer）是否仍在（弱信号）。
fn probe_shell() -> (Option<bool>, String) {
    unsafe {
        let h = GetShellWindow();
        if h.is_null() {
            return (Some(true), "no shell window".into());
        }
        let proc = window_process_name(h).unwrap_or_else(|| "?".into());
        (Some(proc != "explorer.exe"), format!("shell={}", proc))
    }
}

fn probe_idle() -> String {
    unsafe {
        let mut li = LastInputInfo { cb_size: 8, dw_time: 0 };
        if GetLastInputInfo(&mut li) == 0 { return "unavailable".into(); }
        let ms = GetTickCount().wrapping_sub(li.dw_time);
        format!("{}s", ms / 1000)
    }
}

struct Signal {
    name: &'static str,
    locked: Option<bool>,
    weight: u32,
    detail: String,
    micros: u128,
}

/// 强信号（weight>=2）全一致则定论；否则退到弱信号；再冲突即 UNKNOWN。
fn aggregate(signals: &[Signal]) -> (Option<bool>, &'static str, Vec<String>) {
    let mut conflicts = Vec::new();

    let strong: Vec<&Signal> = signals.iter().filter(|s| s.weight >= 2 && s.locked.is_some()).collect();
    if !strong.is_empty() {
        let first = strong[0].locked.unwrap();
        let disagree: Vec<&Signal> = strong.iter().copied().filter(|s| s.locked.unwrap() != first).collect();
        if disagree.is_empty() {
            return (Some(first), "high", conflicts);
        }
        for s in &disagree {
            conflicts.push(format!(
                "{} 判为 {}，与 {} 冲突",
                s.name,
                if s.locked.unwrap() { "已锁" } else { "未锁" },
                strong[0].name
            ));
        }
        return (None, "low", conflicts);
    }

    let weak: Vec<&Signal> = signals.iter().filter(|s| s.locked.is_some()).collect();
    if weak.is_empty() { return (None, "none", conflicts); }
    let first = weak[0].locked.unwrap();
    if weak.iter().all(|s| s.locked.unwrap() == first) {
        return (Some(first), "low", conflicts);
    }
    (None, "none", conflicts)
}

fn selftest() -> bool {
    let mk = |n: &'static str, l: Option<bool>, w: u32| Signal {
        name: n, locked: l, weight: w, detail: String::new(), micros: 0,
    };
    let cases: Vec<(&str, Vec<Signal>, Option<bool>)> = vec![
        ("全部一致=解锁", vec![mk("desktop", Some(false), 3), mk("wts", Some(false), 3)], Some(false)),
        ("全部一致=锁定", vec![mk("desktop", Some(true), 3), mk("wts", Some(true), 3)], Some(true)),
        ("强信号冲突", vec![mk("desktop", Some(true), 3), mk("wts", Some(false), 3)], None),
        ("仅弱信号=锁定", vec![mk("logonui", Some(true), 1)], Some(true)),
        ("仅弱信号冲突", vec![mk("logonui", Some(true), 1), mk("fg", Some(false), 1)], None),
        ("无有效信号", vec![mk("desktop", None, 3)], None),
        ("强信号+弱信号干扰", vec![mk("desktop", Some(false), 3), mk("wts", Some(false), 3), mk("fg", Some(true), 2)], None),
    ];
    let mut pass = true;
    for (name, sigs, expect) in cases {
        let (got, conf, _) = aggregate(&sigs);
        let ok = got == expect;
        if !ok { pass = false; }
        let f = |o: Option<bool>| o.map(|b| if b { "LOCKED" } else { "UNLOCKED" });
        println!("  [{}] {:<22} -> {:?} (期望 {:?}, conf={})",
            if ok { "PASS" } else { "FAIL" }, name, f(got), f(expect), conf);
    }

    // input_desktop 新判据的分支覆盖：own 固定为普通用户桌面 "Default"
    let desk_cases: Vec<(&str, &str, bool, u32, Option<&str>, u32, Option<bool>)> = vec![
        ("桌面:前台在自己桌面=未锁", "Default", true, 100, Some("Default"), 0, Some(false)),
        ("桌面:前台在 Winlogon=已锁", "Default", true, 100, Some("Winlogon"), 0, Some(true)),
        ("桌面:前台桌面不可访问=已锁", "Default", true, 100, None, 5, Some(true)),
        ("桌面:查询失败非拒绝=不猜", "Default", true, 100, None, 6, None),
        ("桌面:无前台窗口=不猜", "Default", false, 0, None, 0, None),
        ("桌面:前台无线程=不猜", "Default", true, 0, Some("Default"), 0, None),
        ("桌面:前台在别的用户桌面=不猜", "Default", true, 100, Some("Other"), 0, None),
    ];
    for (name, own, has_fg, tid, fg_desk, err, expect) in desk_cases {
        let (got, _) = judge_desktop_access(own, has_fg, tid, fg_desk, err);
        let ok = got == expect;
        if !ok { pass = false; }
        let f = |o: Option<bool>| o.map(|b| if b { "LOCKED" } else { "UNLOCKED" });
        println!("  [{}] {:<22} -> {:?} (期望 {:?})",
            if ok { "PASS" } else { "FAIL" }, name, f(got), f(expect));
    }

    // 光标窗口类判据：锁屏背板只在锁屏时铺满全屏
    let class_cases: Vec<(&str, &str, bool)> = vec![
        ("光标:锁屏背板=已锁", "LockScreenBackstopFrame", true),
        ("光标:普通窗口=不判锁", "Chrome_WidgetWin_1", false),
        ("光标:空类名=不判锁", "", false),
    ];
    for (name, class, expect) in class_cases {
        let got = is_lock_screen_class(class);
        let ok = got == expect;
        if !ok { pass = false; }
        println!("  [{}] {:<22} -> {}", if ok { "PASS" } else { "FAIL" }, name, got);
    }
    pass
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--selftest") {
        return if selftest() { ExitCode::SUCCESS } else { ExitCode::from(3) };
    }
    let json = args.iter().any(|a| a == "--json");

    let total = Instant::now();
    let mut signals = Vec::new();
    let mut run = |name: &'static str, weight: u32, f: &dyn Fn() -> (Option<bool>, String)| {
        let t = Instant::now();
        let (locked, detail) = f();
        signals.push(Signal { name, locked, weight, detail, micros: t.elapsed().as_micros() });
    };

    run("input_desktop", 3, &probe_input_desktop);
    run("wts_flags", 3, &probe_wts_flags);
    run("foreground_window", 2, &probe_foreground);
    run("shell_window", 1, &probe_shell);
    let idle = probe_idle();
    let total_ms = total.elapsed().as_secs_f64() * 1000.0;

    let (verdict, confidence, conflicts) = aggregate(&signals);
    let verdict_str = match verdict { Some(true) => "LOCKED", Some(false) => "UNLOCKED", None => "UNKNOWN" };

    if json {
        let mut s = String::from("{\n");
        s.push_str(&format!("  \"verdict\": \"{}\",\n", verdict_str));
        s.push_str(&format!("  \"confidence\": \"{}\",\n", confidence));
        s.push_str(&format!("  \"idle\": \"{}\",\n", idle));
        s.push_str(&format!("  \"totalMs\": {:.2},\n", total_ms));
        s.push_str("  \"signals\": [\n");
        for (i, sig) in signals.iter().enumerate() {
            let l = match sig.locked { Some(true) => "\"locked\"", Some(false) => "\"unlocked\"", None => "null" };
            s.push_str(&format!(
                "    {{\"name\": \"{}\", \"locked\": {}, \"weight\": {}, \"micros\": {}, \"detail\": \"{}\"}}{}\n",
                sig.name, l, sig.weight, sig.micros, sig.detail.replace('"', "'"),
                if i + 1 < signals.len() { "," } else { "" }));
        }
        s.push_str("  ]\n}");
        println!("{}", s);
    } else {
        println!();
        println!("  锁屏检测: {}   置信度={}   耗时={:.2}ms", verdict_str, confidence, total_ms);
        println!();
        println!("  {:<18} {:<10} {:<5} {}", "探测路线", "判定", "权重", "细节");
        println!("  {}", "-".repeat(80));
        for sig in &signals {
            let l = match sig.locked { Some(true) => "LOCKED", Some(false) => "UNLOCKED", None => "不确定" };
            println!("  {:<18} {:<10} {:<5} {} ({}µs)", sig.name, l, sig.weight, sig.detail, sig.micros);
        }
        println!("  {:<18} {:<10} {:<5} idle={}", "idle_time", "—", "—", idle);
        if !conflicts.is_empty() {
            println!();
            for c in &conflicts {
                println!("  ! {}", c);
            }
        }
        println!();
    }

    match verdict {
        Some(true) => ExitCode::from(1),
        Some(false) => ExitCode::SUCCESS,
        None => ExitCode::from(2),
    }
}