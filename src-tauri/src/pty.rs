/* ---------------- one pty per terminal tab (client side) ----------------
The ptys themselves belong to the pty host daemon (pty_host.rs) so they
survive this process exiting. This manager is the client: it spawns the
daemon on first use, keeps the app's view of which terms exist, and turns
host messages into the same `pty:data` / `pty:exit` events and broadcast
channels the rest of the backend already consumed. */

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

use crate::pty_host::{connect_host, HostStream, PROTOCOL_VERSION};
use crate::split_tree::{
    first_leaf_id, leaf_ids, leaf_node, remap_leaves, remove_leaf, tree_from_legacy, PaneNode,
};
use crate::state::{TabRec, WorkspaceRec};

/* a spawn that never gets answered means the daemon died mid-request */
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/* Coalesce pty:data emits: busy agents produce many small daemon lines per
frame, and each app.emit is an IPC serialize+post into the WebView. Buffer
per pane and flush at ~60 Hz so one burst costs one emit. */
const PTY_FLUSH_MS: u64 = 16;
const PTY_MAX_BUFFER: usize = 256 * 1024;

/* how long a command may wait for start()'s daemon handshake. Comfortably
above the handshake's own worst case (connect + two request timeouts) so
it never cuts a slow-but-working host off. */
const READY_TIMEOUT: Duration = Duration::from_secs(45);

/* snapshot of a term's identity for callers that don't need the handles */
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
    pub id: String,
    pub workspace_id: String,
    pub pid: u32,
    pub alive: bool,
}

/* what the daemon reports about itself and the panes it owns */
struct HostStatus {
    version: u64,
    terms: HashMap<String, TermInfo>,
}

/* whether the daemon we just connected to is one we want to drive */
#[derive(Debug, PartialEq)]
enum HostVerdict {
    Use,
    /* replace it, for this reason */
    Replace(&'static str),
}

fn host_verdict(version: u64, term_count: usize, just_spawned: bool) -> HostVerdict {
    if version != PROTOCOL_VERSION {
        return HostVerdict::Replace("protocol mismatch");
    }
    /* nothing to preserve, and it still carries the environment of whatever
    launch started it: panes opened now should see this launch's PATH */
    if !just_spawned && term_count == 0 {
        return HostVerdict::Replace("no live panes");
    }
    HostVerdict::Use
}

pub struct PtyManager {
    terms: Arc<Mutex<HashMap<String, TermInfo>>>,
    /* the handle is set by start(), which runs inside Tauri's setup; the
    reader thread takes the Arc and reads it at emit time, so panes that
    produce output before that still reach the renderer */
    app: Arc<OnceLock<tauri::AppHandle>>,
    /* observers of raw pty output (agent detection feeds a headless parser) */
    data_tx: tokio::sync::broadcast::Sender<(String, String)>,
    exit_tx: tokio::sync::broadcast::Sender<(String, i32)>,
    /* request/response plumbing against the daemon */
    out: Arc<Mutex<Option<mpsc::Sender<String>>>>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
    seq: AtomicU64,
    /* the daemon handshake is done by start(), which can take seconds when
    the host has to be spawned. Commands arrive on WebView2's threads the
    moment the window paints, so they wait on this gate instead of racing
    an empty transport. */
    ready: Mutex<bool>,
    ready_cv: Condvar,
}

pub fn decode_pty_bytes(carry: &mut Vec<u8>, bytes: &[u8]) -> Option<String> {
    carry.extend_from_slice(bytes);

    let emit_len = match std::str::from_utf8(carry) {
        Ok(_) => carry.len(),
        Err(err) if err.error_len().is_none() => err.valid_up_to(),
        Err(_) => carry.len(),
    };

    if emit_len == 0 {
        return None;
    }

    let chunk = String::from_utf8_lossy(&carry[..emit_len]).into_owned();
    carry.drain(..emit_len);
    Some(chunk)
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

impl PtyManager {
    /* Cheap and I/O-free on purpose: this runs on the Tauri Builder, before
    the window exists, so `pty` is managed before WebView2 can fire its
    first IPC call. The daemon handshake happens in start(), inside setup. */
    pub fn new() -> Self {
        let (data_tx, _) = tokio::sync::broadcast::channel(1024);
        let (exit_tx, _) = tokio::sync::broadcast::channel(256);
        PtyManager {
            terms: Arc::new(Mutex::new(HashMap::new())),
            app: Arc::new(OnceLock::new()),
            data_tx,
            exit_tx,
            out: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            seq: AtomicU64::new(1),
            ready: Mutex::new(false),
            ready_cv: Condvar::new(),
        }
    }

    /* Connect to (or spawn) the pty host daemon and publish the app handle.
    Runs inside Tauri's setup; a command that arrives while this is still
    working waits on the ready gate rather than seeing an empty manager. */
    pub fn start(&self, app: tauri::AppHandle) {
        let _ = self.app.set(app);
        self.connect_with_handshake();
        self.open_gate();
    }

    fn open_gate(&self) {
        let mut ready = self.ready.lock().unwrap();
        *ready = true;
        self.ready_cv.notify_all();
    }

    /* Block until start() has finished. The gate opens even when the
    handshake failed, so commands then report "PTY host not connected"
    instead of hanging forever.

    The timeout is insurance, not a normal path: the handshake is already
    bounded (connect 6s + request 15s, at most twice), so this can only
    fire if start() was never called at all. A command that reports a
    missing host beats a window that never answers. */
    fn wait_ready(&self) {
        let mut ready = self.ready.lock().unwrap();
        let deadline = std::time::Instant::now() + READY_TIMEOUT;
        while !*ready {
            let now = std::time::Instant::now();
            if now >= deadline {
                eprintln!("[bentomux] pty manager never became ready; commands report no host");
                return;
            }
            let (guard, _) = self.ready_cv.wait_timeout(ready, deadline - now).unwrap();
            ready = guard;
        }
    }

    /* A daemon outlives app updates and app restarts, so before trusting one
    check that it speaks this build's protocol and that there is actually
    something worth keeping in it. A daemon with no live pane is replaced
    too: it still carries the environment of whatever launch started it,
    and panes opened now should see this launch's PATH. */
    fn connect_with_handshake(&self) {
        for attempt in 0..2 {
            let (stream, just_spawned) = match connect_host() {
                Ok(pair) => pair,
                Err(error) => {
                    /* without a host there are no terminals at all; the
                    commands that need one report the failure */
                    eprintln!("[bentomux] pty host unavailable: {error}");
                    return;
                }
            };
            self.attach_transport(stream);

            let status = match self.host_status() {
                Ok(status) => status,
                Err(error) => {
                    eprintln!("[bentomux] pty host handshake failed: {error}");
                    return;
                }
            };
            let verdict = host_verdict(status.version, status.terms.len(), just_spawned);
            match verdict {
                HostVerdict::Use => return,
                HostVerdict::Replace(why) => {
                    if attempt == 1 {
                        eprintln!(
                            "[bentomux] pty host still not current ({why}); continuing with it"
                        );
                        return;
                    }
                    eprintln!("[bentomux] restarting pty host ({why})");
                    self.restart_host();
                }
            }
        }
    }

    /* stop the daemon and wait for it to stop answering, so the next
    connect_host() starts a fresh one instead of racing the dying process.
    Called from connect_with_handshake, so it must not wait on the gate
    that start() only opens after the handshake returns. */
    fn restart_host(&self) {
        self.shutdown_host_now();
        if !crate::pty_host::wait_host_gone(Duration::from_secs(4)) {
            eprintln!("[bentomux] pty host still listening after shutdown");
        }
    }

    /* subscribe to raw pty output (id, chunk) */
    pub fn on_term_data(&self) -> tokio::sync::broadcast::Receiver<(String, String)> {
        self.data_tx.subscribe()
    }

    /* subscribe to term exits (id, exit code) */
    pub fn on_term_exit(&self) -> tokio::sync::broadcast::Receiver<(String, i32)> {
        self.exit_tx.subscribe()
    }

    fn attach_transport(&self, stream: HostStream) {
        let HostStream { reader, mut writer } = stream;
        let (out_tx, out_rx) = mpsc::channel::<String>();

        /* A write failure used to be swallowed here, and every later request
        then sat out the full timeout with nothing in the log. Drop the
        sender instead, so send() fails immediately and says why. */
        let out_slot = self.out.clone();
        std::thread::spawn(move || {
            while let Ok(line) = out_rx.recv() {
                if writer.write_all(line.as_bytes()).is_err() || writer.flush().is_err() {
                    *out_slot.lock().unwrap() = None;
                    break;
                }
            }
        });

        *self.out.lock().unwrap() = Some(out_tx);

        let terms = self.terms.clone();
        let pending = self.pending.clone();
        let data_tx = self.data_tx.clone();
        let exit_tx = self.exit_tx.clone();
        /* the handle arrives with start(); read it per emit so output that
        lands before setup finishes is not dropped on the floor */
        let app = self.app.clone();
        let out_slot = self.out.clone();
        /* per-pane coalescing buffers, flushed on a 16 ms cadence by the
        flusher thread below. data_tx (remote dirty-set, tests) still
        gets every chunk immediately — only the WebView emit batches. */
        let coalesce: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
        let flush_buffers = coalesce.clone();
        let flush_app = app.clone();
        let flush_data = data_tx.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(PTY_FLUSH_MS));
            let batch: Vec<(String, String)> = {
                let mut guard = flush_buffers.lock().unwrap();
                if guard.is_empty() {
                    continue;
                }
                guard.drain().collect()
            };
            for (id, chunk) in batch {
                let _ = flush_data.send((id.clone(), chunk.clone()));
                if let Some(app) = flush_app.get() {
                    let _ = app.emit("pty:data", (id, chunk));
                }
            }
            /* no handle yet (start() has not run) and no observers: this
            transport has nobody to serve, so let the thread end */
            if flush_app.get().is_none() && flush_data.receiver_count() == 0 {
                break;
            }
        });
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                let kind = msg
                    .get("t")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let id = msg
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                /* Every reply carries the request id, whatever its type.
                Settle after the message arm updates local state so the caller
                cannot wake before `spawned` or `terms` is published. Replies
                without `n` are unsolicited hot ticks and settle() ignores them. */
                match kind.as_str() {
                    "data" => {
                        let Some(bytes) = msg.get("data").and_then(Value::as_str).and_then(unb64)
                        else {
                            settle(&pending, &msg);
                            continue;
                        };
                        let chunk = String::from_utf8_lossy(&bytes).into_owned();
                        /* coalesce before the WebView emit; data_tx fans out
                        from the flusher so ordering per pane is preserved.
                        The app handle arrives with start(), so read it at
                        emit time rather than capturing an Option. */
                        let mut guard = coalesce.lock().unwrap();
                        let entry = guard.entry(id.clone()).or_default();
                        if entry.len() + chunk.len() > PTY_MAX_BUFFER {
                            let pending = std::mem::take(entry);
                            drop(guard);
                            let _ = data_tx.send((id.clone(), pending.clone()));
                            if let Some(app) = app.get() {
                                let _ = app.emit("pty:data", (id.clone(), pending));
                            }
                            coalesce.lock().unwrap().insert(id, chunk);
                        } else {
                            entry.push_str(&chunk);
                        }
                    }
                    "snapshot" => {
                        let snapshot = crate::terminal::TerminalSnapshot {
                            text: msg
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            html: msg
                                .get("html")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            title: msg
                                .get("title")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            progress: msg
                                .get("progress")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            last_data_at: msg
                                .get("lastDataAt")
                                .and_then(Value::as_u64)
                                .unwrap_or(0),
                        };
                        crate::detect::screen::update_snapshot(&id, snapshot);
                    }
                    "exit" => {
                        crate::detect::screen::clear_snapshot(&id);
                        let code = msg.get("code").and_then(Value::as_i64).unwrap_or(0) as i32;
                        if let Some(term) = terms.lock().unwrap().get_mut(&id) {
                            term.alive = false;
                        }
                        let _ = exit_tx.send((id.clone(), code));
                        if let Some(app) = app.get() {
                            let _ = app.emit("pty:exit", (id, code));
                        }
                    }
                    /* the host is the source of truth for what exists */
                    "terms" => {
                        if let Some(list) = msg.get("terms").and_then(Value::as_array) {
                            let mut map = terms.lock().unwrap();
                            map.clear();
                            for entry in list {
                                if let Some(info) = term_info_from(entry) {
                                    map.insert(info.id.clone(), info);
                                }
                            }
                        }
                    }
                    "spawned" => {
                        if let Some(info) = term_info_from(&msg) {
                            terms.lock().unwrap().insert(info.id.clone(), info);
                        }
                    }
                    _ => {}
                }
                settle(&pending, &msg);
            }
            /* the daemon is gone: fail fast from here on instead of waiting
            out a timeout on every request */
            *out_slot.lock().unwrap() = None;
        });
    }

    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed)
    }

    fn send(&self, msg: Value) -> Result<(), String> {
        let out = self.out.lock().unwrap();
        let Some(tx) = out.as_ref() else {
            return Err("PTY host not connected".to_string());
        };
        let mut line = msg.to_string();
        line.push('\n');
        tx.send(line)
            .map_err(|e| format!("PTY host write failed: {}", e))
    }

    /* fire-and-forget request that carries a reply id */
    fn request(&self, msg: Value) -> Result<Value, String> {
        let n = self.next_seq();
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(n, tx);
        let mut msg = msg;
        if let Some(obj) = msg.as_object_mut() {
            obj.insert("n".to_string(), json!(n));
        }
        if let Err(error) = self.send(msg) {
            self.pending.lock().unwrap().remove(&n);
            return Err(error);
        }
        let reply = match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(reply) => reply,
            Err(_) => {
                self.pending.lock().unwrap().remove(&n);
                return Err("PTY host did not answer".to_string());
            }
        };
        if reply.get("t").and_then(Value::as_str) == Some("error") {
            let message = reply
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("spawn failed");
            return Err(message.to_string());
        }
        Ok(reply)
    }

    /* on-demand full snapshot (text+html) for a pane, bypassing the cache.
    Used by the remote mirror on watch: the 500 ms hot tick is text-only,
    so a fresh watcher renders html once via the daemon directly. */
    pub fn snapshot_html(&self, id: &str) -> Option<crate::terminal::TerminalSnapshot> {
        let reply = self
            .request(json!({ "t": "snapshot-html", "id": id }))
            .ok()?;
        if reply.get("t").and_then(Value::as_str) != Some("snapshot") {
            return None;
        }
        Some(crate::terminal::TerminalSnapshot {
            text: reply
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            html: reply
                .get("html")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            title: reply
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            progress: reply
                .get("progress")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            last_data_at: reply.get("lastDataAt").and_then(Value::as_u64).unwrap_or(0),
        })
    }

    /* ask the daemon to start streaming a pane, replaying its screen buffer */
    fn attach(&self, id: &str) {
        let _ = self.send(json!({ "t": "attach", "id": id }));
    }

    pub fn create_term(
        &self,
        workspace_id: &str,
        workspace_path: &str,
        shell_pref: Option<&str>,
    ) -> Result<String, String> {
        self.wait_ready();
        let reply = self.request(json!({
            "t": "spawn",
            "workspaceId": workspace_id,
            "path": workspace_path,
            "shell": shell_pref,
        }))?;
        let id = reply
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "PTY host returned no term id".to_string())?
            .to_string();
        self.attach(&id);
        Ok(id)
    }

    /* openTabs were persisted with their old ids. A pane whose shell is still
    running in the daemon is reattached as-is (that is the whole point of
    the daemon); anything else gets a fresh shell under a new id. */
    pub fn restore_terms(&self, workspaces: &[WorkspaceRec], open_tabs: &[TabRec]) -> Vec<TabRec> {
        /* Without this the restore can run before the transport exists:
        host_terms() would fail, the live list would read empty, and every
        persisted tab would be replaced with a fresh shell — orphaning the
        panes still running in the daemon. */
        self.wait_ready();
        let live = match self.host_terms() {
            Ok(live) => live,
            Err(error) => {
                eprintln!("[bentomux] pty host list failed: {error}");
                HashMap::new()
            }
        };
        let mut claimed: HashSet<String> = HashSet::new();
        let mut created = Vec::new();
        for tab in open_tabs {
            let Some(ws) = workspaces.iter().find(|w| w.id == tab.workspace_id) else {
                continue;
            };
            let tree: PaneNode = tab.split_tree.clone().unwrap_or_else(|| leaf_node(&tab.id));
            let mut map = HashMap::new();
            for old in leaf_ids(&tree) {
                let reusable = live
                    .get(&old)
                    .map(|info| info.alive && info.workspace_id == ws.id)
                    .unwrap_or(false);
                if reusable {
                    self.attach(&old);
                    claimed.insert(old.clone());
                    map.insert(old.clone(), old);
                    continue;
                }
                match self.create_term(&ws.id, &ws.path, None) {
                    Ok(fresh) => {
                        claimed.insert(fresh.clone());
                        map.insert(old, fresh);
                    }
                    Err(e) => eprintln!("[bentomux] pane restore failed for {} {}", ws.path, e),
                }
            }
            if map.is_empty() {
                continue;
            }
            /* prune leaves whose shell could not be spawned */
            let mut fresh: Option<PaneNode> = Some(remap_leaves(tree.clone(), &map));
            for old in leaf_ids(&tree) {
                if map.contains_key(&old) {
                    continue;
                }
                match fresh.and_then(|f| remove_leaf(f, &old)) {
                    Some(f) => fresh = Some(f),
                    None => {
                        fresh = None;
                        break;
                    }
                }
            }
            let Some(fresh) = fresh else { continue };
            created.push(match fresh {
                PaneNode::Leaf { id } => TabRec {
                    id,
                    workspace_id: ws.id.clone(),
                    split_tree: None,
                    title: tab.title.clone(),
                },
                split @ PaneNode::Split { .. } => TabRec {
                    id: first_leaf_id(&split).to_string(),
                    workspace_id: ws.id.clone(),
                    split_tree: Some(split),
                    title: tab.title.clone(),
                },
            });
        }
        /* panes nothing claimed are leftovers from a tab the user closed in a
        previous run; leaving them would be a shell leak with no way to see
        it, so they go now */
        for id in live.keys() {
            if !claimed.contains(id) {
                self.kill_term(id);
            }
        }
        created
    }

    fn host_status(&self) -> Result<HostStatus, String> {
        let reply = self.request(json!({ "t": "list" }))?;
        let mut terms = HashMap::new();
        if let Some(list) = reply.get("terms").and_then(Value::as_array) {
            for entry in list {
                if let Some(info) = term_info_from(entry) {
                    terms.insert(info.id.clone(), info);
                }
            }
        }
        Ok(HostStatus {
            /* a daemon too old to report a version is v0 by definition */
            version: reply.get("v").and_then(Value::as_u64).unwrap_or(0),
            terms,
        })
    }

    fn host_terms(&self) -> Result<HashMap<String, TermInfo>, String> {
        Ok(self.host_status()?.terms)
    }

    pub fn get_term(&self, id: &str) -> Option<TermInfo> {
        self.wait_ready();
        self.terms.lock().unwrap().get(id).cloned()
    }

    pub fn write_term(&self, id: &str, data: &str) -> Result<(), String> {
        self.wait_ready();
        if !self.terms.lock().unwrap().contains_key(id) {
            return Err(format!("Terminal not found: {}", id));
        }
        crate::runtime::note_user_input(id);
        self.send(json!({ "t": "write", "id": id, "data": b64(data.as_bytes()) }))
    }

    pub fn resize_term(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.wait_ready();
        /* unknown terms resize as a no-op, like the pre-daemon version */
        if !self.terms.lock().unwrap().contains_key(id) {
            return Ok(());
        }
        self.send(json!({ "t": "resize", "id": id, "cols": cols, "rows": rows }))
    }

    pub fn kill_term(&self, id: &str) -> bool {
        self.wait_ready();
        let known = self.terms.lock().unwrap().remove(id).is_some();
        if known {
            crate::detect::screen::clear_snapshot(id);
            let _ = self.send(json!({ "t": "kill", "id": id }));
        }
        known
    }

    pub fn kill_terms_for_workspace(&self, workspace_id: &str) {
        self.wait_ready();
        let ids: Vec<String> = {
            let map = self.terms.lock().unwrap();
            map.values()
                .filter(|t| t.workspace_id == workspace_id)
                .map(|t| t.id.clone())
                .collect()
        };
        for id in ids {
            self.kill_term(&id);
        }
    }

    pub fn kill_all_terms(&self) {
        self.wait_ready();
        let ids: Vec<String> = self.terms.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.kill_term(&id);
        }
    }

    pub fn live_terms(&self) -> Vec<TermInfo> {
        self.wait_ready();
        self.terms
            .lock()
            .unwrap()
            .values()
            .filter(|t| t.alive)
            .cloned()
            .collect()
    }

    /* the daemon outlives the app, but it cannot outlive the binary being
    replaced on disk: used right before an update installs */
    pub fn shutdown_host(&self) {
        self.wait_ready();
        self.shutdown_host_now();
    }

    fn shutdown_host_now(&self) {
        let _ = self.send(json!({ "t": "shutdown" }));
        self.terms.lock().unwrap().clear();
    }
}

fn term_info_from(value: &Value) -> Option<TermInfo> {
    Some(TermInfo {
        id: value.get("id")?.as_str()?.to_string(),
        workspace_id: value
            .get("workspaceId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        pid: value.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32,
        alive: value.get("alive").and_then(Value::as_bool).unwrap_or(true),
    })
}

/* hand a reply to whoever is blocked on its request id */
fn settle(pending: &Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>, msg: &Value) {
    let Some(n) = msg.get("n").and_then(Value::as_u64) else {
        return;
    };
    let tx = pending.lock().unwrap().remove(&n);
    if let Some(tx) = tx {
        let _ = tx.send(msg.clone());
    }
}

/* 't-' + millis in base36 + a per-process counter, padded to the same 4 chars
the TS version's random suffix had. The counter replaced 4 random base36
chars because those collide by the birthday problem: 100 ids out of 36^4
fail ~0.3% of the time, and a collision means two panes share one id. The
daemon is the only caller, so a counter is unique for as long as ids live. */
pub fn new_term_id() -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let millis = (chrono::Utc::now().timestamp_millis().max(0)) as u64;
    let seq = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(
        "t-{}{:0>4}",
        crate::split_tree::to_base36(millis),
        crate::split_tree::to_base36(seq)
    )
}

/* legacy tabs whose tree is absent still resolve through treeFromLegacy in
state.rs; this helper is kept for callers that need the same shape */
pub fn legacy_tree(ids: &[String], stacked: bool) -> Option<PaneNode> {
    tree_from_legacy(
        ids,
        Some(if stacked {
            crate::split_tree::Dir::H
        } else {
            crate::split_tree::Dir::V
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty_host;

    /* a private daemon per test: bind first so the test knows the real port,
    then hand the listener to the server. No fixed port, no bind race. */
    struct TestHost {
        addr: std::net::SocketAddr,
        token: String,
    }

    fn test_manager(tag: &str) -> (TestHost, PtyManager) {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind test host");
        let addr = listener.local_addr().expect("test host addr");
        let token = format!("test-token-{}-{}", tag, std::process::id());
        let token_for_server = token.clone();
        std::thread::spawn(move || {
            pty_host::serve(listener, token_for_server, false);
        });
        let host = TestHost { addr, token };
        /* the accept loop is already listening; retry only guards the first
        moment of the server thread starting up */
        let mut last = String::new();
        for _ in 0..300 {
            match pty_host::connect_at(host.addr, &host.token) {
                Ok(stream) => return (host, manager_with(stream)),
                Err(error) => {
                    last = error;
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
        panic!("test host never came up at {}: {last}", host.addr);
    }

    fn connect_test_manager(host: &TestHost) -> PtyManager {
        let stream = pty_host::connect_at(host.addr, &host.token).expect("test host connect");
        manager_with(stream)
    }

    fn manager_with(stream: crate::pty_host::HostStream) -> PtyManager {
        let manager = PtyManager::new();
        manager.attach_transport(stream);
        /* The host pushes its term list right after the hello, and the reader
        thread fills the local map from it asynchronously (with a clear()
        first). A `list` request cannot be answered before that push has been
        read, so this is the ordering barrier connect_with_handshake() gets
        for free from its handshake. Without it a test can reach get_term() or
        write_term() before the push lands and read an empty map — which is
        what made the reconnect test fail under full-suite load. */
        let _ = manager.host_status();
        /* tests hand the transport over directly, so the manager is ready
        without the start() handshake */
        manager.open_gate();
        manager
    }

    fn temp_dir(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "bentomux-pty-{}-{}-{}",
            tag,
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    fn ws(id: &str) -> WorkspaceRec {
        WorkspaceRec {
            id: id.into(),
            path: temp_dir(id),
            name: id.into(),
        }
    }

    #[test]
    fn test_decode_pty_bytes_preserves_split_utf8() {
        let mut carry = Vec::new();
        assert_eq!(decode_pty_bytes(&mut carry, &[0xE2, 0x94]), None);
        assert_eq!(decode_pty_bytes(&mut carry, &[0x80]), Some("─".to_string()));
    }

    #[test]
    fn test_spawn_write_read_exit() {
        let (_host, mgr) = test_manager("spawn");
        let mut data_rx = mgr.on_term_data();
        let mut exit_rx = mgr.on_term_exit();

        let workspace = ws("spawn");
        /* windows: cmd starts instantly and skips user pwsh profiles; unix:
        the detected default (bash) as before */
        let shell_pref = if cfg!(windows) { Some("cmd") } else { None };
        let id = mgr
            .create_term(&workspace.id, &workspace.path, shell_pref)
            .expect("spawn");

        let info = mgr.get_term(&id).expect("term registered");
        assert!(info.alive);
        assert!(info.pid > 0);

        /* echo a marker and expect it back through the pty. Reading
        accumulates every chunk because one echoed line arrives split. */
        let command = "echo BENTOMUX_TEST_MARKER\r\n";
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let mut seen = String::new();
        let mut last_write: Option<std::time::Instant> = None;
        while !seen.contains("BENTOMUX_TEST_MARKER") {
            if std::time::Instant::now() >= deadline {
                panic!("marker never appeared in pty output; saw {seen:?}");
            }
            match data_rx.try_recv() {
                Ok((tid, chunk)) => {
                    assert_eq!(tid, id);
                    seen.push_str(&chunk);
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    let due = last_write
                        .map(|at: std::time::Instant| at.elapsed() >= Duration::from_secs(2))
                        .unwrap_or(true);
                    if due {
                        mgr.write_term(&id, command).expect("write");
                        last_write = Some(std::time::Instant::now());
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
                Err(_) => break,
            }
        }
        assert!(seen.contains("BENTOMUX_TEST_MARKER"));

        mgr.kill_term(&id);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut exited = false;
        while std::time::Instant::now() < deadline {
            if let Ok((tid, _)) = exit_rx.try_recv() {
                assert_eq!(tid, id);
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(exited, "no exit event after kill");
        assert_eq!(mgr.get_term(&id), None, "term removed from map on kill");
    }

    /* the feature this daemon exists for: quitting the app must not take the
    agent CLIs with it, and the next launch must find them again */
    #[test]
    fn test_terms_survive_client_restart() {
        let (host, mgr) = test_manager("survive");
        let workspace = ws("survive");
        let shell_pref = if cfg!(windows) { Some("cmd") } else { None };
        let id = mgr
            .create_term(&workspace.id, &workspace.path, shell_pref)
            .expect("spawn");
        let pid = mgr.get_term(&id).expect("registered").pid;

        /* leave a marker on the pane's screen, then let it settle */
        let marker = "BENTOMUX_SURVIVOR\r\n";
        mgr.write_term(&id, &format!("echo {marker}"))
            .expect("write");
        std::thread::sleep(Duration::from_millis(1500));

        /* the app "quits": drop the whole manager, socket and all */
        drop(mgr);

        /* a fresh app instance reconnects and restores the same tab */
        let second = connect_test_manager(&host);
        let tabs = vec![TabRec {
            id: id.clone(),
            workspace_id: workspace.id.clone(),
            split_tree: None,
            title: Some("restored".into()),
        }];
        let restored = second.restore_terms(&[workspace.clone()], &tabs);
        assert_eq!(restored.len(), 1);
        assert_eq!(
            restored[0].id, id,
            "reattached to the live pane, not a fresh shell"
        );

        let info = second.get_term(&id).expect("term still known");
        assert!(info.alive, "pane must still be running");
        assert_eq!(info.pid, pid, "same process, not a respawn");

        /* the daemon sends a formatted terminal-state snapshot on attach */
        let mut data_rx = second.on_term_data();
        second.resize_term(&id, 100, 30).expect("resize");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut seen = String::new();
        while !seen.contains("BENTOMUX_SURVIVOR") && std::time::Instant::now() < deadline {
            match data_rx.try_recv() {
                Ok((_, chunk)) => seen.push_str(&chunk),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                Err(_) => break,
            }
        }
        assert!(
            seen.contains("BENTOMUX_SURVIVOR"),
            "replay missing; saw {seen:?}"
        );

        second.kill_term(&id);
    }

    #[test]
    fn test_two_panes_survive_ten_reconnect_cycles() {
        let (host, first) = test_manager("reconnect-10x");
        let workspace = ws("reconnect-10x");
        /* The test only needs a pane that stays alive and echoes, so it takes
        the detected default like every other test here. Naming "pi" made the
        suite depend on whether that agent happened to be installed: on CI it
        silently fell back to a shell, on a dev machine it spawned a real
        agent, and neither run tested the same thing. */
        let shell_pref: Option<&str> = None;
        let left = first
            .create_term(&workspace.id, &workspace.path, shell_pref)
            .expect("left shell spawn");
        let right = first
            .create_term(&workspace.id, &workspace.path, shell_pref)
            .expect("right shell spawn");
        let left_pid = first.get_term(&left).expect("left registered").pid;
        let right_pid = first.get_term(&right).expect("right registered").pid;
        let tree = crate::split_tree::split_leaf(
            leaf_node(&left),
            &left,
            crate::split_tree::Dir::V,
            &right,
            "reconnect-10x",
        );
        let tab = TabRec {
            id: left.clone(),
            workspace_id: workspace.id.clone(),
            split_tree: Some(tree),
            title: Some("two pane reconnect".into()),
        };

        let mut current = Some(first);
        for cycle in 0..10 {
            drop(current.take());
            let next = connect_test_manager(&host);
            let restored = next.restore_terms(&[workspace.clone()], &[tab.clone()]);
            assert_eq!(restored.len(), 1, "restore failed on cycle {cycle}");
            let restored_tree = restored[0].split_tree.as_ref().expect("split preserved");
            let leaves = crate::split_tree::leaf_ids(restored_tree);
            assert_eq!(leaves.len(), 2, "pane count changed on cycle {cycle}");
            assert!(
                leaves.contains(&left) && leaves.contains(&right),
                "pane ids changed on cycle {cycle}: {leaves:?}"
            );
            assert_eq!(
                next.get_term(&left).expect("left after restore").pid,
                left_pid
            );
            assert_eq!(
                next.get_term(&right).expect("right after restore").pid,
                right_pid
            );

            let mut data_rx = next.on_term_data();
            let left_marker = format!("BENTOMUX_RECONNECT_LEFT_{cycle}");
            let right_marker = format!("BENTOMUX_RECONNECT_RIGHT_{cycle}");
            next.write_term(&left, &format!("echo {left_marker}\r\n"))
                .expect("left write");
            next.write_term(&right, &format!("echo {right_marker}\r\n"))
                .expect("right write");
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let mut left_seen = false;
            let mut right_seen = false;
            while !(left_seen && right_seen) && std::time::Instant::now() < deadline {
                match data_rx.try_recv() {
                    Ok((id, chunk)) => {
                        if id == left && chunk.contains(&left_marker) {
                            left_seen = true;
                        }
                        if id == right && chunk.contains(&right_marker) {
                            right_seen = true;
                        }
                    }
                    Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
                    Err(_) => break,
                }
            }
            assert!(
                left_seen && right_seen,
                "markers missing on cycle {cycle}: left={left_seen}, right={right_seen}"
            );
            current = Some(next);
        }

        if let Some(last) = current {
            assert!(last.kill_term(&left));
            assert!(last.kill_term(&right));
        }
    }

    #[test]
    fn test_host_verdict_picks_between_use_and_replace() {
        use HostVerdict::{Replace, Use};
        /* a daemon this build can drive, holding panes worth keeping */
        assert_eq!(host_verdict(PROTOCOL_VERSION, 3, false), Use);
        /* a daemon we just started is current by definition */
        assert_eq!(host_verdict(PROTOCOL_VERSION, 0, true), Use);
        /* a leftover daemon with nothing to preserve: refresh it so new panes
        get this launch's environment */
        assert_eq!(
            host_verdict(PROTOCOL_VERSION, 0, false),
            Replace("no live panes")
        );
        /* any other protocol is refused, panes or not */
        assert_eq!(
            host_verdict(PROTOCOL_VERSION + 1, 3, false),
            Replace("protocol mismatch")
        );
        assert_eq!(host_verdict(0, 3, false), Replace("protocol mismatch"));
        assert_eq!(host_verdict(0, 0, true), Replace("protocol mismatch"));
    }

    /* The manager is managed on the Tauri Builder, before the window exists,
    so a command can arrive while start() is still doing the daemon
    handshake. Those commands must wait for the transport, not run against
    an empty manager. */
    #[test]
    fn test_commands_wait_for_the_ready_gate() {
        let (host, mgr) = test_manager("ready-gate");
        /* a fresh manager that has not been started: the gate is closed */
        let pending = Arc::new(PtyManager::new());
        assert!(!*pending.ready.lock().unwrap());

        let waiter = pending.clone();
        let joined = std::thread::spawn(move || {
            /* this would return an empty vec immediately if the gate were
            missing; with it, the call parks until the gate opens */
            waiter.live_terms()
        });
        std::thread::sleep(Duration::from_millis(150));
        assert!(
            !joined.is_finished(),
            "live_terms must block while the gate is closed"
        );
        pending.open_gate();
        let terms = joined.join().expect("waiter thread");
        assert!(terms.is_empty(), "no terms are known before the handshake");

        /* once started, the same call sees the live pane without delay */
        let workspace = ws("ready-gate");
        let shell_pref = if cfg!(windows) { Some("cmd") } else { None };
        let id = mgr
            .create_term(&workspace.id, &workspace.path, shell_pref)
            .expect("spawn");
        assert!(mgr.live_terms().iter().any(|t| t.id == id));
        mgr.kill_term(&id);
        drop(host);
    }

    /* a reconnecting app must not be streamed panes it has not asked for: the
    chunks would reach the renderer before the replay `attach` sends */
    #[test]
    fn test_reconnected_client_is_not_streamed_before_attach() {
        let (host, first) = test_manager("attach-reset");
        let workspace = ws("attach-reset");
        let shell_pref = if cfg!(windows) { Some("cmd") } else { None };
        let id = first
            .create_term(&workspace.id, &workspace.path, shell_pref)
            .expect("spawn");
        let mut first_rx = first.on_term_data();
        first.write_term(&id, "echo FIRST\r\n").expect("write");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut seen = String::new();
        while !seen.contains("FIRST") && std::time::Instant::now() < deadline {
            match first_rx.try_recv() {
                Ok((_, chunk)) => seen.push_str(&chunk),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                Err(_) => break,
            }
        }
        assert!(
            seen.contains("FIRST"),
            "pane never produced output; saw {seen:?}"
        );

        /* the app "quits" and a new one connects and lists, but does not
        attach yet */
        drop(first);
        let second = connect_test_manager(&host);
        let live = second.host_terms().expect("list");
        assert!(live.contains_key(&id), "pane should still be listed");
        let mut second_rx = second.on_term_data();
        second.write_term(&id, "echo SECOND\r\n").expect("write");
        std::thread::sleep(Duration::from_millis(1500));
        let leaked: Vec<String> = std::iter::from_fn(|| second_rx.try_recv().ok())
            .map(|(_, chunk)| chunk)
            .collect();
        assert!(leaked.is_empty(), "streamed before attach: {leaked:?}");

        /* after attach the formatted terminal state arrives */
        second.attach(&id);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut replay = String::new();
        while !replay.contains("FIRST") && std::time::Instant::now() < deadline {
            match second_rx.try_recv() {
                Ok((_, chunk)) => replay.push_str(&chunk),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                Err(_) => break,
            }
        }
        assert!(replay.contains("FIRST"), "replay missing; saw {replay:?}");

        second.kill_term(&id);
    }

    /* the daemon must speak the version this build expects */
    #[test]
    fn test_host_reports_the_protocol_version() {
        let (_host, mgr) = test_manager("protocol");
        let status = mgr.host_status().expect("status");
        assert_eq!(status.version, PROTOCOL_VERSION);
    }

    #[test]
    fn test_resize_and_unknown_term_errors() {
        let (_host, mgr) = test_manager("resize");
        let workspace = ws("resize");
        let id = mgr
            .create_term(&workspace.id, &workspace.path, None)
            .expect("spawn");

        mgr.resize_term(&id, 100, 30).expect("resize");
        /* unknown terms resize as a no-op, write as an error (like TS) */
        mgr.resize_term("t-nope", 80, 24).unwrap();
        assert!(mgr.write_term("t-nope", "hi").is_err());
        assert!(!mgr.kill_term("t-nope"));
        mgr.kill_term(&id);
    }

    #[test]
    fn test_restore_terms_remaps_and_prunes() {
        let (_host, mgr) = test_manager("restore");
        let workspace = ws("restore");

        /* a persisted tab with a two-pane split tree under old ids */
        let old_tree = crate::split_tree::split_leaf(
            leaf_node("old-a"),
            "old-a",
            crate::split_tree::Dir::V,
            "old-b",
            "k1",
        );
        let open_tabs = vec![TabRec {
            id: "old-a".into(),
            workspace_id: workspace.id.clone(),
            split_tree: Some(old_tree),
            title: Some("restored".into()),
        }];

        let restored = mgr.restore_terms(&[workspace.clone()], &open_tabs);
        assert_eq!(restored.len(), 1);
        let tab = &restored[0];
        assert_eq!(tab.title.as_deref(), Some("restored"));
        let tree = tab.split_tree.as_ref().expect("split preserved");
        let leaves = leaf_ids(tree);
        assert_eq!(leaves.len(), 2);
        assert!(
            leaves.iter().all(|l| mgr.get_term(l).is_some()),
            "fresh panes registered"
        );
        assert!(!leaves.contains(&"old-a".to_string()));
        assert_eq!(tab.id, first_leaf_id(tree));

        /* single-pane legacy tab (no tree) restores as a plain tab */
        let legacy: Vec<String> = vec!["x1".into()];
        let single = TabRec {
            id: "x1".into(),
            workspace_id: workspace.id.clone(),
            split_tree: tree_from_legacy(&legacy, None),
            title: None,
        };
        let restored = mgr.restore_terms(&[workspace.clone()], &[single]);
        assert_eq!(restored.len(), 1);
        assert!(restored[0].split_tree.is_none());
        assert!(mgr.get_term(&restored[0].id).is_some());

        /* unknown workspace tabs are skipped, and their panes are not left
        running in the daemon */
        let orphan = TabRec {
            id: "z1".into(),
            workspace_id: "ws-gone".into(),
            split_tree: None,
            title: None,
        };
        assert!(mgr.restore_terms(&[workspace], &[orphan]).is_empty());

        mgr.kill_all_terms();
        assert!(mgr.live_terms().is_empty());
    }

    #[test]
    fn test_kill_terms_for_workspace() {
        let (_host, mgr) = test_manager("ws-kill");
        let a = ws("ws-a");
        let b = ws("ws-b");
        let ta = mgr.create_term(&a.id, &a.path, None).unwrap();
        let tb = mgr.create_term(&b.id, &b.path, None).unwrap();

        mgr.kill_terms_for_workspace(&a.id);
        assert_eq!(mgr.get_term(&ta), None);
        assert!(mgr.get_term(&tb).is_some());

        mgr.kill_all_terms();
        assert_eq!(mgr.get_term(&tb), None);
    }

    #[test]
    fn test_term_id_shape_and_uniqueness() {
        let ids: Vec<String> = (0..100).map(|_| new_term_id()).collect();
        assert!(ids.iter().all(|id| id.starts_with("t-")));
        let uniq: std::collections::HashSet<&String> = ids.iter().collect();
        assert_eq!(uniq.len(), 100);
    }

    /* Every reply carries the request id, whatever its type. Settling only
    the arms that used to ask for something left the snapshot reply out,
    and the caller sat out the full REQUEST_TIMEOUT — the first watch
    frame on a phone took 15s and then fell back to a blank render. */
    #[test]
    fn a_reply_of_any_type_settles_the_waiter() {
        let pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert(7, tx);

        settle(
            &pending,
            &serde_json::json!({"t": "snapshot", "n": 7, "html": "<b>"}),
        );
        let reply = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("the snapshot reply must reach the caller, not time out");
        assert_eq!(reply["html"], "<b>");
        assert!(
            pending.lock().unwrap().is_empty(),
            "the waiter stays behind"
        );

        /* the hot tick sends snapshots with no id at all: that is a broadcast,
        not an answer, and it must not disturb the waiters */
        let (tx2, _rx2) = mpsc::channel();
        pending.lock().unwrap().insert(8, tx2);
        settle(
            &pending,
            &serde_json::json!({"t": "snapshot", "id": "t-1", "text": "hi"}),
        );
        assert_eq!(pending.lock().unwrap().len(), 1);
    }
}
