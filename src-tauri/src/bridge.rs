/* ---------------- agent hook bridge ----------------
Rust port of src/main/bridge.ts. Agents configured with Bentomux's managed
hooks (agent_hooks.rs) run resources/bentomux-hook.cjs on PermissionRequest.
The CLI forwards the payload over a Unix socket or Windows named pipe, one
JSON line per connection. PermissionRequest connections stay open until the
user decides in the renderer; the directive JSON then goes back on the same
connection so the agent itself executes the decision — no keystroke
synthesis. Everything fails open: a dead bridge means the agent falls back
to its native prompt. */

use std::collections::HashMap;
#[cfg(all(test, unix))]
use std::io::Read;
#[cfg(unix)]
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{path::BaseDirectory, Emitter, Manager};

use crate::bridge_config::bridge_address;
use crate::pty::PtyManager;

/* the renderer-facing approval request (shared/types AgentApprovalRequest) */
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentApprovalRequest {
    pub request_id: String,
    pub pane_id: Option<String>,
    pub agent: String,
    pub tool_name: String,
    pub summary: String,
    pub cwd: Option<String>,
    pub session_id: Option<String>,
}

/* agent boundary events surface to the renderer (shared/types
AgentEventNotice — jump only today) */
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventNotice {
    pub kind: String,
    pub pane_id: Option<String>,
    pub agent: String,
    pub message: String,
    pub cwd: Option<String>,
    pub session_id: Option<String>,
}

struct Pending {
    req: AgentApprovalRequest,
    response: mpsc::Sender<Option<String>>,
}

struct HookReg {
    created: Vec<std::sync::Arc<dyn Fn(&AgentApprovalRequest) + Send + Sync>>,
    closed: Vec<std::sync::Arc<dyn Fn(&str) + Send + Sync>>,
}

struct BridgeState {
    app: Option<tauri::AppHandle>,
    pending: HashMap<String, Pending>,
    /* insertion order of pending ids: HashMap iteration is arbitrary and the
       overlay replay must surface the newest blocked request */
    order: Vec<String>,
    hooks: HookReg,
}

fn bridge_state() -> &'static Mutex<BridgeState> {
    static STATE: OnceLock<Mutex<BridgeState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(BridgeState {
            app: None,
            pending: HashMap::new(),
            order: Vec::new(),
            hooks: HookReg {
                created: Vec::new(),
                closed: Vec::new(),
            },
        })
    })
}

static SEQ: AtomicU64 = AtomicU64::new(0);

/* Node's module loader cannot load a script from a verbatim \\?\ path
(lstat on the drive letter fails with EISDIR), and Tauri's resolve()
returns one on Windows. Strip the prefix the way dunce would; UNC paths
map back to \\server\share form. */
fn plain_path(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if let Some(rest) = s.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{rest}");
    }
    s.strip_prefix("\\\\?\\").unwrap_or(&s).to_string()
}

/* absolute path of the hook CLI agents execute — unpacked next to the
binary as a Tauri resource (packaged equivalent of process.resourcesPath) */
pub fn hook_script_path(app: &tauri::AppHandle) -> String {
    /* packaged: declared as `../resources/bentomux-hook.cjs`, so the bundler
    stores it under `_up_/resources/` — resolve() applies that rewrite */
    if let Ok(bundled) = app
        .path()
        .resolve("../resources/bentomux-hook.cjs", BaseDirectory::Resource)
    {
        if bundled.is_file() {
            return plain_path(&bundled);
        }
    }
    /* dev: resource_dir may not contain the bundled resources yet, so fall
    back to the project's resources/ folder (electron's
    app.getAppPath()/resources in dev) */
    let dev =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/bentomux-hook.cjs");
    if dev.is_file() {
        return dev.to_string_lossy().into_owned();
    }
    "bentomux-hook.cjs".to_string()
}

/* ---------- subscribers (remote monitor) ---------- */

pub fn on_approval_created(cb: impl Fn(&AgentApprovalRequest) + Send + Sync + 'static) {
    bridge_state()
        .lock()
        .unwrap()
        .hooks
        .created
        .push(Arc::new(cb));
}

pub fn on_approval_closed(cb: impl Fn(&str) + Send + Sync + 'static) {
    bridge_state()
        .lock()
        .unwrap()
        .hooks
        .closed
        .push(Arc::new(cb));
}

/* currently-blocked requests, so a client that connects late (phone
opened after the agent got stuck) still sees the decision it must make */
pub fn pending_approvals() -> Vec<AgentApprovalRequest> {
    bridge_state()
        .lock()
        .unwrap()
        .pending
        .values()
        .map(|p| p.req.clone())
        .collect()
}
/* Replay the request when a newly-created overlay missed the initial event
while its WebView was still loading. Returns the NEWEST blocked request, so
the replay surfaces what the user is being asked about now — an arbitrary
HashMap entry could resurrect a stale one instead. */
pub fn pending_approval() -> Option<AgentApprovalRequest> {
    let st = bridge_state().lock().unwrap();
    st.order
        .iter()
        .rev()
        .find_map(|id| st.pending.get(id).map(|p| p.req.clone()))
}

/* ---------- helpers ---------- */

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/* one-line summary of what is being approved: bash commands raw, other
tools as compact JSON */
fn summarize(input: &serde_json::Value) -> String {
    if let Some(c) = input.get("command").and_then(|v| v.as_str()) {
        if !c.trim().is_empty() {
            return c.trim().to_string();
        }
    }
    serde_json::to_string(input).unwrap_or_else(|_| "{}".to_string())
}

/* PermissionRequest decision, per Claude Code hookSpecificOutput schema */
fn directive(decision: bool) -> String {
    let body = if decision {
        serde_json::json!({ "behavior": "allow" })
    } else {
        serde_json::json!({ "behavior": "deny", "message": "Denied from Bentomux", "interrupt": false })
    };
    serde_json::to_string(&serde_json::json!({
        "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": body }
    }))
    .unwrap_or_default()
}

fn emit(event: &str, payload: &impl Serialize) {
    let Some(app) = &bridge_state().lock().unwrap().app else {
        return;
    };
    let _ = app.emit(event, payload);
}

/* surface an agent boundary event to the renderer (used by the jump
command) — kept public for commands.rs */
pub fn emit_agent_event(notice: &AgentEventNotice) {
    emit("agent:event", notice);
}

/* ---------- pending lifecycle ---------- */

pub fn close_pending(request_id: &str) {
    let mut st = bridge_state().lock().unwrap();
    let Some(pending) = st.pending.remove(request_id) else {
        return;
    };
    st.order.retain(|id| id != request_id);
    let hooks = st.hooks.closed.clone();
    let _ = pending.response.send(None);
    drop(st);
    emit("agent:approvalClosed", &request_id);
    for cb in &hooks {
        cb(request_id);
    }
}

pub fn drop_pane(pane_id: &str) {
    let ids: Vec<String> = bridge_state()
        .lock()
        .unwrap()
        .pending
        .values()
        .filter(|p| p.req.pane_id.as_deref() == Some(pane_id))
        .map(|p| p.req.request_id.clone())
        .collect();
    for id in ids {
        close_pending(&id);
    }
}

pub fn resolve_approval(request_id: &str, decision: bool) -> bool {
    let mut st = bridge_state().lock().unwrap();
    let Some(pending) = st.pending.remove(request_id) else {
        return false;
    };
    st.order.retain(|id| id != request_id);
    let hooks = st.hooks.closed.clone();
    let _ = pending.response.send(Some(directive(decision) + "\n"));
    drop(st);
    emit("agent:approvalClosed", &request_id);
    for cb in &hooks {
        cb(request_id);
    }
    true
}

/* anchor pane of the tab the renderer currently shows; reported by the
renderer on every activation so the overlay can stay hidden while the
user is already looking at the requesting pane */
/* approval notifications live ONLY in the floating overlay (port of
Electron's src/main/overlay.ts showApprovalOverlay). Every blocked request
raises it, even while Bentomux is focused: a blocked agent is exactly the
thing the user must act on, so there is no "already looking at it" opt-out. */
fn desktop_notify() {
    let Some(app) = bridge_state().lock().unwrap().app.clone() else {
        return;
    };
    let notify_enabled = {
        let s = app.state::<crate::state::AppStateManager>();
        s.get_state().prefs.notif_enabled.unwrap_or(true)
    };
    if !notify_enabled {
        return;
    }
    crate::overlay::show_approval_overlay(&app);
}

/* ---------- connection handling ---------- */

fn request_id() -> String {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("ar-{}-{}", to_base36(n), to_base36(now_ms()))
}

fn to_base36(mut n: u64) -> String {
    const CH: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(CH[(n % 36) as usize]);
        n /= 36;
    }
    out.iter().rev().map(|&b| b as char).collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_envelope(raw: &str) -> Option<(String, Option<String>, serde_json::Value)> {
    let obj: serde_json::Value = serde_json::from_str(raw).ok()?;
    let o = obj.as_object()?;
    if o.get("v").and_then(serde_json::Value::as_u64) != Some(1) {
        return None;
    }
    let event = o
        .get("event")
        .and_then(serde_json::Value::as_str)?
        .to_string();
    let pane = o
        .get("pane")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let payload = o.get("payload")?.clone();
    if !payload.is_object() {
        return None;
    }
    Some((event, pane, payload))
}

fn dispatch(line: &str, response: mpsc::Sender<Option<String>>) -> bool {
    if let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) {
        if obj.get("method").and_then(|v| v.as_str()) == Some("pane.report_agent") {
            let params = obj.get("params").and_then(|v| v.as_object());
            let pane = params
                .and_then(|p| p.get("pane_id"))
                .and_then(|v| v.as_str());
            let agent = params.and_then(|p| p.get("agent")).and_then(|v| v.as_str());
            let state = params.and_then(|p| p.get("state")).and_then(|v| v.as_str());
            if let (Some(pane), Some(agent), Some(state)) = (pane, agent, state) {
                let message = params
                    .and_then(|p| p.get("message"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                crate::runtime::report_agent_state(pane, agent, state, message);
                let _ = response.send(Some("{}\n".to_string()));
                return true;
            }
        }
        if obj.get("method").and_then(|v| v.as_str()) == Some("pane.report_agent_session") {
            let _ = response.send(Some("{}\n".to_string()));
            return true;
        }
    }
    let Some((event, pane, payload)) = parse_envelope(line) else {
        return false;
    };
    if event != "PermissionRequest" {
        return false;
    }
    let Some(tool_name) = str_field(&payload, "tool_name") else {
        return false;
    };
    let input = payload
        .get("tool_input")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let req = AgentApprovalRequest {
        request_id: request_id(),
        pane_id: pane,
        agent: "claude".to_string(),
        tool_name,
        summary: summarize(&input),
        cwd: str_field(&payload, "cwd"),
        session_id: str_field(&payload, "session_id"),
    };
    let rid = req.request_id.clone();
    {
        let mut st = bridge_state().lock().unwrap();
        st.order.push(rid.clone());
        st.pending.insert(
            rid,
            Pending {
                req: req.clone(),
                response,
            },
        );
        let created = st.hooks.created.clone();
        drop(st);
        for cb in &created {
            cb(&req);
        }
        /* Create/show the overlay before emitting the request. A newly-created
        WebView cannot receive events emitted before its page subscribes. */
        desktop_notify();
        emit("agent:approval", &req);
    }
    true
}

#[cfg(unix)]
fn handle_connection(mut stream: std::os::unix::net::UnixStream) {
    let Ok(read) = stream.try_clone() else { return };
    let mut reader = BufReader::new(read);
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let (response_tx, response_rx) = mpsc::channel();
    if !dispatch(line.trim(), response_tx) {
        return;
    }
    if let Ok(Some(response)) = response_rx.recv() {
        let _ = stream.write_all(response.as_bytes());
    }
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

#[cfg(windows)]
async fn handle_connection(mut stream: tokio::net::windows::named_pipe::NamedPipeServer) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let mut reader = tokio::io::BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
        return;
    }
    stream = reader.into_inner();
    let (response_tx, response_rx) = mpsc::channel();
    if !dispatch(line.trim(), response_tx) {
        return;
    }
    let response = tokio::task::spawn_blocking(move || response_rx.recv())
        .await
        .ok()
        .and_then(Result::ok);
    if let Some(Some(response)) = response {
        let _ = stream.write_all(response.as_bytes()).await;
    }
}

/* ---------- listener lifecycle ---------- */

#[cfg(unix)]
fn live_socket(addr: &str) -> bool {
    std::os::unix::net::UnixStream::connect(addr).is_ok()
}

/* The socket sits in a world-writable temp dir. 0600 means only this user can
connect: anything that can talk to it can inject approval requests and
answer the ones an agent is blocked on. */
#[cfg(unix)]
fn restrict_socket(addr: &str) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(addr, std::fs::Permissions::from_mode(0o600)) {
        eprintln!("[bentomux] bridge socket chmod failed on {addr}: {e}");
    }
}

#[cfg(unix)]
pub fn start_bridge(app: tauri::AppHandle, pty: &PtyManager) {
    bridge_state().lock().unwrap().app = Some(app.clone());

    let addr = bridge_address();
    {
        use std::path::Path;
        if Path::new(&addr).exists() {
            if live_socket(&addr) {
                eprintln!("[bentomux] bridge address busy: {addr}");
                return;
            }
            let _ = std::fs::remove_file(&addr); /* stale socket already gone */
        }
    }
    /* drop pending approvals when the requesting terminal pane exits */
    let mut exit_rx = pty.on_term_exit();
    std::thread::spawn(move || loop {
        use tokio::sync::broadcast::error::TryRecvError;
        match exit_rx.try_recv() {
            Ok((pane_id, _)) => {
                crate::runtime::clear_reported_agent(&pane_id);
                drop_pane(&pane_id);
            }
            Err(TryRecvError::Empty) | Err(TryRecvError::Lagged(_)) => {
                std::thread::sleep(std::time::Duration::from_millis(25))
            }
            Err(TryRecvError::Closed) => break,
        }
    });

    let listener = match std::os::unix::net::UnixListener::bind(&addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[bentomux] bridge bind failed on {addr}: {e}");
            return;
        }
    };
    restrict_socket(&addr);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    std::thread::spawn(|| handle_connection(s));
                }
                Err(e) => eprintln!("[bentomux] bridge accept error: {e}"),
            }
        }
    });
}

#[cfg(windows)]
pub fn start_bridge(app: tauri::AppHandle, pty: &PtyManager) {
    bridge_state().lock().unwrap().app = Some(app);
    let addr = bridge_address();
    let mut exit_rx = pty.on_term_exit();
    std::thread::spawn(move || loop {
        use tokio::sync::broadcast::error::TryRecvError;
        match exit_rx.try_recv() {
            Ok((pane_id, _)) => drop_pane(&pane_id),
            Err(TryRecvError::Empty) | Err(TryRecvError::Lagged(_)) => {
                std::thread::sleep(std::time::Duration::from_millis(25))
            }
            Err(TryRecvError::Closed) => break,
        }
    });
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Runtime::new() {
            Ok(runtime) => runtime,
            Err(error) => {
                eprintln!("[bentomux] bridge runtime failed: {error}");
                return;
            }
        };
        runtime.block_on(async move {
            use tokio::net::windows::named_pipe::ServerOptions;
            /* a named-pipe instance serves exactly ONE client, and between
            "client N accepted" and "instance N+1 created" there is a window
            where NO listener exists — a hook connecting then gets ENOENT,
            treats the bridge as dead, and its approval never surfaces. Keep
            the next instance pre-created at all times. */
            let mut next = match ServerOptions::new().create(&addr) {
                Ok(server) => Some(server),
                Err(error) => {
                    eprintln!("[bentomux] bridge pipe bind failed on {addr}: {error}");
                    return;
                }
            };
            loop {
                let server = match next.take() {
                    Some(server) => server,
                    None => match ServerOptions::new().create(&addr) {
                        Ok(server) => server,
                        Err(error) => {
                            eprintln!("[bentomux] bridge pipe bind failed on {addr}: {error}");
                            return;
                        }
                    },
                };
                if let Err(error) = server.connect().await {
                    eprintln!("[bentomux] bridge pipe accept error: {error}");
                    continue;
                }
                /* the next instance must exist before this connection is
                handled — handling blocks until the user decides */
                next = match ServerOptions::new().create(&addr) {
                    Ok(server) => Some(server),
                    Err(error) => {
                        eprintln!("[bentomux] bridge pipe bind failed on {addr}: {error}");
                        None
                    }
                };
                tokio::spawn(handle_connection(server));
            }
        });
    });
}

#[cfg(not(any(unix, windows)))]
pub fn start_bridge(_app: tauri::AppHandle, _pty: &PtyManager) {}

pub fn stop_bridge() {
    let mut st = bridge_state().lock().unwrap();
    st.order.clear();
    for (_, pending) in st.pending.drain() {
        let _ = pending.response.send(None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::LazyLock;
    static TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn test_lock() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap()
    }

    #[test]
    fn base36_roundtrip() {
        assert_eq!(to_base36(0), "0");
        assert_eq!(to_base36(35), "z");
        assert_eq!(to_base36(36), "10");
        assert_eq!(to_base36(46655), "zzz");
    }

    #[test]
    fn plain_path_strips_verbatim_prefix() {
        assert_eq!(
            plain_path(std::path::Path::new(r"\\?\C:\Users\x\bentomux-hook.cjs")),
            r"C:\Users\x\bentomux-hook.cjs"
        );
        assert_eq!(
            plain_path(std::path::Path::new(r"\\?\UNC\srv\share\hook.cjs")),
            r"\\srv\share\hook.cjs"
        );
        assert_eq!(
            plain_path(std::path::Path::new(r"C:\plain\hook.cjs")),
            r"C:\plain\hook.cjs"
        );
    }

    #[test]
    fn summarize_prefers_command_then_json() {
        let cmd = serde_json::json!({ "command": "  ls -la  " });
        assert_eq!(summarize(&cmd), "ls -la");
        let no_cmd = serde_json::json!({ "foo": "bar", "n": 1 });
        assert_eq!(summarize(&no_cmd), r#"{"foo":"bar","n":1}"#);
    }

    #[test]
    fn directive_matches_claude_schema() {
        let allow: serde_json::Value = serde_json::from_str(&directive(true)).unwrap();
        let d = &allow["hookSpecificOutput"]["decision"];
        assert_eq!(d["behavior"], "allow");
        let deny: serde_json::Value = serde_json::from_str(&directive(false)).unwrap();
        let d = &deny["hookSpecificOutput"]["decision"];
        assert_eq!(d["behavior"], "deny");
        assert_eq!(d["interrupt"], false);
    }

    #[test]
    fn parse_envelope_requires_v1_object_payload() {
        assert!(
            parse_envelope(r#"{"v":1,"event":"PermissionRequest","pane":"t1","payload":{}}"#)
                .is_some()
        );
        assert!(parse_envelope(r#"{"v":2,"event":"PermissionRequest","payload":{}}"#).is_none());
        assert!(parse_envelope(r#"not json"#).is_none());
        assert!(parse_envelope(
            r#"{"v":1,"event":"PermissionRequest","pane":null,"payload":"str"}"#
        )
        .is_none());
    }

    #[test]
    fn dispatch_accepts_reported_agent_state() {
        let (tx, rx) = mpsc::channel();
        assert!(dispatch(
            r#"{"method":"pane.report_agent","params":{"pane_id":"pane-omp","agent":"omp","state":"working"}}"#,
            tx,
        ));
        assert_eq!(rx.recv().unwrap().unwrap(), "{}\n");
        assert!(crate::runtime::has_reported_agent("pane-omp"));
        crate::runtime::clear_reported_agent("pane-omp");
    }

    #[test]
    fn request_id_has_ar_prefix() {
        let a = request_id();
        let b = request_id();
        assert!(a.starts_with("ar-"));
        assert_ne!(a, b);
    }

    #[test]
    fn pending_approval_returns_the_newest_block() {
        let _guard = test_lock();
        stop_bridge();
        let (tx1, _rx1) = mpsc::channel();
        let (tx2, _rx2) = mpsc::channel();
        assert!(dispatch(
            r#"{"v":1,"event":"PermissionRequest","pane":"p1","payload":{"tool_name":"Bash","tool_input":{"command":"one"}}}"#,
            tx1,
        ));
        assert!(dispatch(
            r#"{"v":1,"event":"PermissionRequest","pane":"p2","payload":{"tool_name":"Bash","tool_input":{"command":"two"}}}"#,
            tx2,
        ));
        let newest = pending_approval().expect("pending after two dispatches");
        assert_eq!(newest.summary, "two");
        /* resolving the newest falls the replay back to the older block */
        assert!(resolve_approval(&newest.request_id, true));
        assert_eq!(pending_approval().expect("older block remains").summary, "one");
        stop_bridge();
    }

    #[test]
    fn str_field_filters_empty() {
        assert_eq!(
            str_field(&serde_json::json!({"a":"x"}), "a").as_deref(),
            Some("x")
        );
        assert_eq!(str_field(&serde_json::json!({"a":""}), "a"), None);
        assert_eq!(str_field(&serde_json::json!({"a":5}), "a"), None);
    }

    #[test]
    fn dispatch_and_resolve_round_trip_uses_response_channel() {
        let _guard = test_lock();
        stop_bridge();
        let (tx, rx) = mpsc::channel();
        assert!(dispatch(
            r#"{"v":1,"event":"PermissionRequest","pane":"pane-1","payload":{"tool_name":"Bash","tool_input":{"command":"echo ok"}}}"#,
            tx,
        ));
        let pending = pending_approvals();
        assert_eq!(pending.len(), 1);
        let request_id = pending[0].request_id.clone();
        assert!(resolve_approval(&request_id, true));
        let response = rx.recv().unwrap().unwrap();
        let json: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(json["hookSpecificOutput"]["decision"]["behavior"], "allow");
        stop_bridge();
    }
    #[cfg(unix)]
    #[test]
    fn bridge_socket_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("bentomux-perm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let addr = path.to_string_lossy().into_owned();
        restrict_socket(&addr);
        let mode = std::fs::metadata(&addr).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "socket mode {:o}", mode);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn unix_socket_connection_returns_resolved_directive() {
        let _guard = test_lock();
        use std::os::unix::net::UnixStream;
        use std::time::Duration;
        stop_bridge();
        let (server, mut client) = UnixStream::pair().unwrap();
        std::thread::spawn(|| handle_connection(server));
        client.write_all(br#"{"v":1,"event":"PermissionRequest","pane":"pane-1","payload":{"tool_name":"Bash","tool_input":{"command":"echo ok"}}}
"#).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let request_id = loop {
            if let Some(request) = pending_approvals().into_iter().next() {
                break request.request_id;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert!(resolve_approval(&request_id, false));
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        let json: serde_json::Value = serde_json::from_str(response.trim()).unwrap();
        assert_eq!(json["hookSpecificOutput"]["decision"]["behavior"], "deny");
    }
}
