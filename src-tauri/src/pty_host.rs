/* ---------------- persistent pty host ----------------
A PTY dies with whoever owns its master fd: when the UI process exited the
fd closed, the kernel hung up the slave, and every agent CLI in a pane got
SIGHUP. So the master fds live in a separate daemon instead — the app runs
`bentomux --pty-host` on first use and talks to it over a loopback socket.
Quitting, crashing, or force-quitting the app now leaves the agent CLIs
running; the next launch lists the live terms and reattaches to them.

The transport is deliberately the same code on every platform. A per-OS one
(unix socket / windows named pipe) cannot be exercised on the machine you
are not on, and a transport bug there shows up as every request timing out
with nothing in the log — the loopback socket plus the token in the 0600
address file gives the same protection as a 0600 unix socket, and is
testable anywhere.

Protocol: newline-delimited JSON, one line per message, base64 for the two
byte-carrying fields. Requests carry an `n` id the reply echoes back.
(ponytail: JSON+base64 costs ~33% on the pty hot path; a binary framing is
the upgrade path if a benchmark ever says the encode matters.) */

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::bridge_config::{bridge_env_for, instance_suffix};
use crate::pty::{decode_pty_bytes, new_term_id};
use crate::shell::resolve_shell;
use crate::terminal::TerminalModel;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};

/* argv flag that turns this binary into the daemon instead of the app */
pub const HOST_FLAG: &str = "--pty-host";

/* bumped whenever the message shapes below change. The app refuses to drive a
daemon that answers with a different number: a daemon outlives app updates,
so a silent mismatch would surface as confusing misbehaviour in the field
with nothing to diagnose it. */
pub const PROTOCOL_VERSION: u64 = 6;

/* how long to wait for the freshly spawned daemon to accept a connection */
const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);

/* idle ticks (1s each) before a daemon with no live pane and no client exits */
const IDLE_TICKS: u32 = 10;
/* Full text+HTML snapshots are expensive: runtime detection polls at 1 Hz,
while the terminal data stream remains realtime. */
const SNAPSHOT_INTERVAL_MS: u64 = 500;

/* ---------------- address ----------------

The daemon publishes where it listens plus a shared secret. The file is
owner-only (0600) on unix, which is what keeps another local process from
reading the token and driving the user's shells. */

fn address_path() -> PathBuf {
    std::env::temp_dir().join(format!("bentomux-pty{}.json", instance_suffix()))
}

struct Address {
    port: u16,
    token: String,
}

fn read_address() -> Option<Address> {
    let raw = std::fs::read_to_string(address_path()).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    Some(Address {
        port: value.get("port")?.as_u64()? as u16,
        token: value.get("token")?.as_str()?.to_string(),
    })
}

fn write_address(port: u16, token: &str) -> std::io::Result<()> {
    let path = address_path();
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    /* created owner-only rather than chmod-ed after, so the token is never
    briefly world-readable */
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&path)?;
    file.write_all(
        json!({ "port": port, "token": token })
            .to_string()
            .as_bytes(),
    )?;
    file.flush()
}

fn clear_address() {
    let _ = std::fs::remove_file(address_path());
}

fn new_token() -> String {
    use base64::Engine;
    let bytes: [u8; 32] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn log_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("bentomux-pty{}.log", instance_suffix()))
}

/* ---------------- client transport ---------------- */

pub struct HostStream {
    pub reader: Box<dyn BufRead + Send>,
    pub writer: Box<dyn Write + Send>,
    /* clone of the underlying socket kept as a shutdown handle: dropping a
    client must sever the connection immediately (unblocking the reader
    thread) instead of waiting for the daemon to notice EOF */
    pub socket: TcpStream,
}

fn open_stream(addr: &Address) -> std::io::Result<HostStream> {
    let stream = TcpStream::connect(("127.0.0.1", addr.port))?;
    let _ = stream.set_nodelay(true);
    let mut writer = stream.try_clone()?;
    let socket = stream.try_clone()?;
    /* the daemon ignores anything that does not open with the token */
    writeln!(writer, "{}", json!({ "t": "hello", "token": addr.token }))?;
    writer.flush()?;
    Ok(HostStream {
        reader: Box::new(BufReader::new(stream)),
        writer: Box::new(writer),
        socket,
    })
}

/* connect to a specific daemon (tests run a private one) */
pub fn connect_at(addr: SocketAddr, token: &str) -> Result<HostStream, String> {
    open_stream(&Address {
        port: addr.port(),
        token: token.to_string(),
    })
    .map_err(|e| format!("pty host unreachable at {addr}: {e}"))
}

/* connect to the daemon, starting it if nothing is listening yet. The flag is
true when this call started the daemon, which tells the caller the daemon is
already current and must not be restarted. */
pub fn connect_host() -> Result<(HostStream, bool), String> {
    if let Some(addr) = read_address() {
        if let Ok(stream) = open_stream(&addr) {
            return Ok((stream, false));
        }
    }
    spawn_host_process()?;
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        if let Some(addr) = read_address() {
            if let Ok(stream) = open_stream(&addr) {
                return Ok((stream, true));
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "pty host unreachable: no daemon published {}",
                address_path().display()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/* wait until the published address stops answering, so the next connect_host()
starts a fresh daemon instead of racing the dying process */
pub fn wait_host_gone(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let alive = read_address()
            .map(|addr| open_stream(&addr).is_ok())
            .unwrap_or(false);
        if !alive {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn spawn_host_process() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {}", e))?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(HOST_FLAG);
    cmd.stdin(std::process::Stdio::null());
    /* the daemon outlives the app, so it cannot keep the app's stdio: give it
    its own log file to keep startup failures diagnosable */
    let log = log_path();
    match std::fs::File::create(&log) {
        Ok(file) => match file.try_clone() {
            Ok(second) => {
                cmd.stdout(file);
                cmd.stderr(second);
            }
            Err(_) => {
                cmd.stdout(std::process::Stdio::null());
                cmd.stderr(std::process::Stdio::null());
            }
        },
        Err(_) => {
            cmd.stdout(std::process::Stdio::null());
            cmd.stderr(std::process::Stdio::null());
        }
    }
    /* its own process group: a Ctrl+C or terminal hangup aimed at the app's
    group must not take the agent CLIs down with it */
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map_err(|e| format!("pty host spawn failed: {}", e))?;
    Ok(())
}

/* ---------------- daemon state ---------------- */

/* the hot path (pty reader thread) only ever touches this, never the term map */
struct TermShared {
    id: String,
    workspace_id: String,
    pid: u32,
    alive: AtomicBool,
    attached: AtomicBool,
    last_snapshot_at: AtomicU64,
    stream_gate: Mutex<()>,
    terminal: Mutex<TerminalModel>,
}

struct HostTerm {
    shared: Arc<TermShared>,
    /* held open for resize, and to keep the slave from hanging up: dropping
    the master kills the child, which is why it lives in the daemon */
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

/* resize the pty and the parser together, then hand back a fresh render: the
resize reflows the grid, so a text-only frame would leave a watcher looking
at a stale screen until the next output happened to arrive */
fn apply_size(term: &HostTerm, rows: u16, cols: u16) -> crate::terminal::TerminalSnapshot {
    {
        let _gate = term.shared.stream_gate.lock().unwrap();
        term.shared.terminal.lock().unwrap().set_size(rows, cols);
        let _ = term.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
    let snapshot = term.shared.terminal.lock().unwrap().snapshot_html();
    term.shared
        .last_snapshot_at
        .store(now_ms(), Ordering::Relaxed);
    snapshot
}

/* the app is the only real client, but a connection is served on its own
thread so a second one can take over immediately instead of queueing behind
a client that never closed cleanly. The newest connection wins; the older
one keeps its socket but receives nothing. */
struct ClientSlot {
    generation: u64,
    tx: Option<mpsc::Sender<String>>,
}

struct Host {
    terms: Mutex<HashMap<String, HostTerm>>,
    client: Mutex<ClientSlot>,
}

impl Host {
    fn new() -> Self {
        Host {
            terms: Mutex::new(HashMap::new()),
            client: Mutex::new(ClientSlot {
                generation: 0,
                tx: None,
            }),
        }
    }

    /* become the active client; returns the generation to clear later */
    fn set_client(&self, tx: mpsc::Sender<String>) -> u64 {
        /* Stop every stream before publishing new client sender. Otherwise a
        reader can enqueue live bytes into the new client between its
        handshake and attach snapshot, corrupting restore ordering. */
        for term in self.terms.lock().unwrap().values() {
            let _gate = term.shared.stream_gate.lock().unwrap();
            term.shared.attached.store(false, Ordering::SeqCst);
        }
        let mut slot = self.client.lock().unwrap();
        slot.generation += 1;
        slot.tx = Some(tx);
        slot.generation
    }

    /* only the active client clears the slot: a superseded one must not */
    fn clear_client(&self, generation: u64) {
        let mut slot = self.client.lock().unwrap();
        if slot.generation == generation {
            slot.tx = None;
        }
    }

    fn client_connected(&self) -> bool {
        self.client.lock().unwrap().tx.is_some()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

fn send_line(host: &Host, line: String) {
    let tx = host.client.lock().unwrap().tx.clone();
    if let Some(tx) = tx {
        let _ = tx.send(line); /* a dead client is noticed by the reader loop */
    }
}

fn send_json(host: &Host, value: Value) {
    let mut line = value.to_string();
    line.push('\n');
    send_line(host, line);
}

fn reply(host: &Host, n: u64, mut value: Value) {
    if let Some(obj) = value.as_object_mut() {
        obj.insert("n".to_string(), json!(n));
    }
    send_json(host, value);
}

fn encoded_data_line(id: &str, bytes: &[u8]) -> String {
    let mut line = json!({ "t": "data", "id": id, "data": b64(bytes) }).to_string();
    line.push('\n');
    line
}

fn send_snapshot(host: &Host, id: &str, snapshot: &crate::terminal::TerminalSnapshot) {
    /* html goes over the wire only when rendered (watched panes / attach /
    resize). The 500 ms hot tick sends text+meta so runtime detection stays
    live without the per-cell style walk or the extra IPC bytes. */
    let mut obj = json!({
        "t": "snapshot",
        "id": id,
        "text": snapshot.text,
        "title": snapshot.title,
        "progress": snapshot.progress,
        "lastDataAt": snapshot.last_data_at,
        "cwd": snapshot.cwd,
    });
    if !snapshot.html.is_empty() {
        obj["html"] = snapshot.html.clone().into();
    }
    send_json(host, obj);
}

fn term_list(host: &Host) -> Value {
    let terms = host.terms.lock().unwrap();
    Value::Array(
        terms
            .values()
            .map(|t| {
                json!({
                    "id": t.shared.id,
                    "workspaceId": t.shared.workspace_id,
                    "pid": t.shared.pid,
                    "alive": t.shared.alive.load(Ordering::SeqCst),
                })
            })
            .collect(),
    )
}

/* ---------------- request handling ---------------- */

fn handle_line(host: &Arc<Host>, line: &str) {
    let Ok(msg) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let kind = msg.get("t").and_then(Value::as_str).unwrap_or("");
    let id = msg
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let n = msg.get("n").and_then(Value::as_u64).unwrap_or(0);

    match kind {
        "list" => {
            let terms = term_list(host);
            reply(
                host,
                n,
                json!({ "t": "terms", "v": PROTOCOL_VERSION, "terms": terms }),
            );
        }
        "spawn" => {
            let workspace_id = msg
                .get("workspaceId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let path = msg
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let shell = msg.get("shell").and_then(Value::as_str).map(str::to_string);
            match spawn_term(host, &workspace_id, &path, shell.as_deref()) {
                Ok((term_id, pid)) => reply(
                    host,
                    n,
                    json!({
                        "t": "spawned",
                        "id": term_id,
                        "pid": pid,
                        "workspaceId": workspace_id,
                        "alive": true,
                    }),
                ),
                Err(error) => reply(host, n, json!({ "t": "error", "id": id, "message": error })),
            }
        }
        "attach" => {
            let shared = host
                .terms
                .lock()
                .unwrap()
                .get(&id)
                .map(|t| t.shared.clone());
            if let Some(shared) = shared {
                /* Serialize state replay with live output. Without this gate,
                two sender threads can enqueue live bytes before the state
                snapshot, corrupting xterm styles after reconnect. */
                /* Replay and the attached transition are one critical
                section. This prevents a reader from updating the parser
                after the replay snapshot but before `attached=true`, which
                would otherwise leave the renderer one chunk behind. */
                {
                    let _gate = shared.stream_gate.lock().unwrap();
                    let state = shared.terminal.lock().unwrap().state_formatted();
                    if !state.is_empty() {
                        /* The line is prebuilt before enqueue; no socket write
                        or blocking I/O happens while the gate is held. */
                        send_line(host, encoded_data_line(&shared.id, &state));
                    }
                    shared.attached.store(true, Ordering::SeqCst);
                }
                /* Detection snapshot is independent of xterm replay ordering;
                render it after releasing the hot stream gate. Attach needs
                full html (remote may already watch this pane); the hot
                tick afterwards sends text-only. */
                let snapshot = shared.terminal.lock().unwrap().snapshot_html();
                shared.last_snapshot_at.store(now_ms(), Ordering::Relaxed);
                send_snapshot(host, &shared.id, &snapshot);
            }
        }
        "snapshot-html" => {
            /* on-demand full render for the remote mirror's watch path.
            The 500 ms hot tick is text-only; a fresh watcher pays for
            the per-cell style walk exactly once here. */
            if let Some(shared) = host
                .terms
                .lock()
                .unwrap()
                .get(&id)
                .map(|t| t.shared.clone())
            {
                let snapshot = shared.terminal.lock().unwrap().snapshot_html();
                let mut obj = json!({
                    "t": "snapshot",
                    "id": id,
                    "text": snapshot.text,
                    "html": snapshot.html,
                    "title": snapshot.title,
                    "progress": snapshot.progress,
                    "lastDataAt": snapshot.last_data_at,
                    "cwd": snapshot.cwd,
                });
                if n != 0 {
                    if let Some(o) = obj.as_object_mut() {
                        o.insert("n".to_string(), json!(n));
                    }
                }
                send_json(host, obj);
            } else if n != 0 {
                reply(
                    host,
                    n,
                    json!({ "t": "error", "id": id, "message": "unknown pane" }),
                );
            }
        }
        "write" => {
            let Some(bytes) = msg.get("data").and_then(Value::as_str).and_then(unb64) else {
                return;
            };
            let terms = host.terms.lock().unwrap();
            if let Some(term) = terms.get(&id) {
                let mut writer = term.writer.lock().unwrap();
                let _ = writer.write_all(&bytes);
                let _ = writer.flush();
            }
        }
        "resize" => {
            let cols = msg.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16;
            let rows = msg.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16;
            let terms = host.terms.lock().unwrap();
            if let Some(term) = terms.get(&id) {
                let snapshot = apply_size(term, rows, cols);
                send_snapshot(host, &term.shared.id, &snapshot);
            }
        }
        "kill" => {
            let removed = host.terms.lock().unwrap().remove(&id);
            if let Some(term) = removed {
                if term.shared.alive.load(Ordering::SeqCst) {
                    let _ = term.killer.lock().unwrap().kill();
                }
            }
        }
        /* the app is about to replace the binary on disk (windows installer
        cannot overwrite a running exe): drop everything and get out */
        "shutdown" => {
            let terms: Vec<HostTerm> = host.terms.lock().unwrap().drain().map(|(_, t)| t).collect();
            for term in terms {
                if term.shared.alive.load(Ordering::SeqCst) {
                    let _ = term.killer.lock().unwrap().kill();
                }
            }
            clear_address();
            std::process::exit(0);
        }
        _ => {}
    }
}

/* ---------------- pty lifecycle ---------------- */

fn spawn_term(
    host: &Arc<Host>,
    workspace_id: &str,
    path: &str,
    shell_pref: Option<&str>,
) -> Result<(String, u32), String> {
    let shell = resolve_shell(shell_pref);
    let id = new_term_id();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("PTY creation failed: {}", e))?;

    let mut cmd = CommandBuilder::new(&shell.file);
    for arg in &shell.args {
        cmd.arg(arg);
    }
    cmd.cwd(path);
    cmd.env("TERM", "xterm-256color");
    for (k, v) in bridge_env_for(&id) {
        cmd.env(k, v);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Shell spawn failed: {}", e))?;

    let pid = child.process_id().unwrap_or(0);
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("writer failed: {}", e))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("reader failed: {}", e))?;
    let killer = child.clone_killer();

    let shared = Arc::new(TermShared {
        id: id.clone(),
        workspace_id: workspace_id.to_string(),
        pid,
        alive: AtomicBool::new(true),
        attached: AtomicBool::new(false),
        last_snapshot_at: AtomicU64::new(0),
        stream_gate: Mutex::new(()),
        terminal: Mutex::new(TerminalModel::default()),
    });

    host.terms.lock().unwrap().insert(
        id.clone(),
        HostTerm {
            shared: shared.clone(),
            master: pair.master,
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
        },
    );

    /* reader: ring every byte, forward decoded chunks to the client when the
    pane is attached. Decoding runs even while detached so a multi-byte
    character split across chunks still lines up after an attach. */
    let host_r = host.clone();
    let shared_r = shared.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        let mut carry = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, /* EOF: master closed */
                Ok(n) => {
                    let chunk = decode_pty_bytes(&mut carry, &buf[..n]);
                    /* Base64/JSON work happens before the gate. Inside it we
                    only process the parser and enqueue an already-built
                    line, keeping the hot critical section bounded. */
                    let encoded_chunk = chunk
                        .as_deref()
                        .map(|text| encoded_data_line(&shared_r.id, text.as_bytes()));
                    let attached = {
                        let _gate = shared_r.stream_gate.lock().unwrap();
                        shared_r.terminal.lock().unwrap().process(&buf[..n]);
                        if shared_r.attached.load(Ordering::SeqCst) {
                            if let Some(line) = encoded_chunk {
                                send_line(&host_r, line);
                            }
                            true
                        } else {
                            false
                        }
                    };
                    if attached {
                        let now = now_ms();
                        let previous = shared_r.last_snapshot_at.load(Ordering::Relaxed);
                        if now.saturating_sub(previous) >= SNAPSHOT_INTERVAL_MS
                            && shared_r
                                .last_snapshot_at
                                .compare_exchange(
                                    previous,
                                    now,
                                    Ordering::Relaxed,
                                    Ordering::Relaxed,
                                )
                                .is_ok()
                        {
                            /* Full text+HTML rendering is intentionally
                            coalesced. Raw bytes remain realtime; runtime
                            and remote already tick at 250 ms. */
                            let snapshot = shared_r.terminal.lock().unwrap().snapshot();
                            send_snapshot(&host_r, &shared_r.id, &snapshot);
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    /* waiter: reap the child and report the real exit code. The term stays in
    the map so the pane keeps showing its dead screen until the app closes
    it, exactly like the pre-daemon behaviour. */
    let host_w = host.clone();
    let shared_w = shared.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code() as i32).unwrap_or(0);
        shared_w.alive.store(false, Ordering::SeqCst);
        send_json(
            &host_w,
            json!({ "t": "exit", "id": shared_w.id, "code": code }),
        );
    });

    Ok((id, pid))
}

/* ---------------- server ---------------- */

fn idle_watch(host: Arc<Host>) {
    let mut idle = 0u32;
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let live = host
            .terms
            .lock()
            .unwrap()
            .values()
            .any(|t| t.shared.alive.load(Ordering::SeqCst));
        let connected = host.client_connected();
        if live || connected {
            idle = 0;
            continue;
        }
        idle += 1;
        /* nothing to preserve and nobody listening: do not linger as a stray
        daemon on the user's machine */
        if idle >= IDLE_TICKS {
            clear_address();
            std::process::exit(0);
        }
    }
}

/* Serve until the process is killed. `idle_exit` is off for in-process test
servers, which must not take the test harness down with them. */
pub fn serve(listener: TcpListener, token: String, idle_exit: bool) -> i32 {
    let host = Arc::new(Host::new());
    if idle_exit {
        let watcher = host.clone();
        std::thread::spawn(move || idle_watch(watcher));
    }
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let host = host.clone();
        let token = token.clone();
        std::thread::spawn(move || serve_client(stream, &host, &token));
    }
    0
}

fn serve_client(stream: TcpStream, host: &Arc<Host>, token: &str) {
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut line = String::new();

    /* first line must carry the token; anything else is dropped without a
    reply so a stray local process cannot even probe the daemon */
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let allowed = serde_json::from_str::<Value>(line.trim())
        .map(|hello| {
            hello.get("t").and_then(Value::as_str) == Some("hello")
                && hello.get("token").and_then(Value::as_str) == Some(token)
        })
        .unwrap_or(false);
    if !allowed {
        return;
    }

    let (tx, rx) = mpsc::channel::<String>();
    let generation = host.set_client(tx);
    let writer = std::thread::spawn(move || {
        let mut out = write_half;
        while let Ok(line) = rx.recv() {
            if out.write_all(line.as_bytes()).is_err() {
                break;
            }
            let _ = out.flush();
        }
        let _ = out.shutdown(std::net::Shutdown::Both);
    });

    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        handle_line(host, line.trim());
    }

    /* dropping the sender ends the writer thread's loop */
    host.clear_client(generation);
    let _ = writer.join();
}

/* entry point for `bentomux --pty-host` */
pub fn run_host() -> i32 {
    /* already serving? this instance is redundant */
    if let Some(addr) = read_address() {
        if open_stream(&addr).is_ok() {
            return 0;
        }
    }
    /* port 0 lets the OS pick a free one; the address file is how the app
    finds it, so the daemon never occupies a fixed port */
    let listener = match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[bentomux] pty host bind failed: {error}");
            return 1;
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(error) => {
            eprintln!("[bentomux] pty host address failed: {error}");
            return 1;
        }
    };
    let token = new_token();
    if let Err(error) = write_address(port, &token) {
        eprintln!("[bentomux] pty host could not publish its address: {error}");
        return 1;
    }
    /* (ponytail: two daemons starting at the same instant can both pass the
    liveness check above and the loser's port is overwritten in the file.
    The app only spawns after a failed connect, and the loser exits on idle
    with no panes, so this needs two launches in the same millisecond.) */
    serve(listener, token, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_file_is_per_instance() {
        std::env::remove_var("BENTOMUX_SMOKE");
        std::env::remove_var("BENTOMUX_USER_DATA_SUFFIX");
        let path = address_path();
        assert!(
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .contains("bentomux-pty"),
            "path: {}",
            path.display()
        );
    }

    /* the token is the only thing keeping another local process out of the
    user's shells, so a wrong one must not be served */
    #[test]
    fn wrong_token_is_refused() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            serve(listener, "right-token".to_string(), false);
        });
        std::thread::sleep(Duration::from_millis(100));

        assert!(
            connect_at(addr, "wrong-token").is_ok(),
            "socket connect still succeeds"
        );
        let mut bad = connect_at(addr, "wrong-token").expect("connect");
        /* the daemon drops it, so the request never gets an answer */
        bad.writer
            .write_all(b"{\"t\":\"list\",\"n\":1}\n")
            .expect("write");
        bad.writer.flush().expect("flush");
        let mut reply = String::new();
        assert_eq!(
            bad.reader.read_line(&mut reply).unwrap_or(0),
            0,
            "got: {reply:?}"
        );

        let mut good = connect_at(addr, "right-token").expect("connect");
        good.writer
            .write_all(b"{\"t\":\"list\",\"n\":2}\n")
            .expect("write");
        good.writer.flush().expect("flush");
        let mut line = String::new();
        assert!(
            good.reader.read_line(&mut line).unwrap_or(0) > 0,
            "token should be accepted"
        );
        assert_eq!(serde_json::from_str::<Value>(line.trim()).unwrap()["n"], 2);
    }

    #[test]
    fn base64_roundtrip() {
        let raw = b"\x1b[31mred\x1b[0m \xe2\x94\x80";
        assert_eq!(unb64(&b64(raw)).as_deref(), Some(raw.as_slice()));
        assert_eq!(unb64("not base64!!"), None);
    }
}
