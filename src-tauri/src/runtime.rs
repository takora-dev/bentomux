/* ---------------- agent runtime detection + config views ----------------
Phase 6 stub. The shared type contract (AgentInfo, AgentConfigView, etc.)
lives here so Phase 4 commands compile; sysinfo process polling and
screen-manifest evaluation land in Phase 6. */

use serde::{Deserialize, Serialize};

use crate::state::{AgentInfo, Capabilities};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentRunState {
    Idle,
    Working,
    Blocked,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub running: bool,
    pub runtime: Option<String>,
    /* semantic state; null when no known agent owns the tab */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<AgentRunState>,
    /* which rule/manifest produced the state — for debugging */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_rule: Option<String>,
    /* how the state was derived */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/* editable model settings exposed on an agent's Model tab */
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelSettingsView {
    pub model: String,
    pub base_url: String,
    pub context: String,
    pub format: String,
    /* the stored key is never sent back — presence only */
    pub has_api_key: bool,
}
impl Default for ModelSettingsView {
    fn default() -> Self {
        ModelSettingsView {
            model: String::new(),
            base_url: String::new(),
            context: String::new(),
            format: String::new(),
            has_api_key: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelSettingsPatch {
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub context: Option<String>,
    /* new key value; None = keep current, Some(empty) = clear */
    pub api_key: Option<Option<String>>,
    pub format: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModelField {
    Model,
    BaseUrl,
    Context,
    ApiKey,
    Format,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FormatChoice {
    pub value: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ResourceCounts {
    pub memory: u32,
    pub skills: u32,
    pub mcp: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentConfigView {
    pub id: String,
    pub name: String,
    pub detected: bool,
    pub capabilities: Capabilities,
    pub current_model: Option<String>,
    pub model_settings: Option<ModelSettingsView>,
    pub model_fields: Vec<ModelField>,
    pub model_formats: Vec<FormatChoice>,
    pub model_suggestions: Vec<String>,
    pub model_write_target: Option<String>,
    pub config_path: Option<String>,
    pub counts: ResourceCounts,
}
impl Default for AgentConfigView {
    fn default() -> Self {
        AgentConfigView {
            id: String::new(),
            name: String::new(),
            detected: false,
            capabilities: Capabilities::default(),
            current_model: None,
            model_settings: None,
            model_fields: vec![],
            model_formats: vec![],
            model_suggestions: vec![],
            model_write_target: None,
            config_path: None,
            counts: ResourceCounts::default(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentHooksStatus {
    pub installed: bool,
    pub settings_path: String,
    pub error: Option<String>,
}

/* ---------------- agent runtime poller ----------------
Rust port of src/main/runtime.ts — two-layer detection, herdr-style:
1. identity — poll the process table (sysinfo), walk each tab's shell
   descendant tree, match known agent binaries (claude, pi, codex, …)
2. state — evaluate screen-manifest rules against a vt100 headless
   render of the tab's live output; agents without a manifest fall back
   to an output-activity pulse (recent data = working).

Wired from `init()` (called once in setup): it stores the app handle,
starts the screen feed, and spawns a 2s poller thread. Status is
published on `rt:status` when anything changes, and mirrored into
`latest` for surfaces outside the renderer (remote monitor). */

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{Emitter, Manager};

use crate::detect::{manifests::manifest_for, rules, screen};
use crate::pty::PtyManager;

struct RuntimeState {
    app: Option<tauri::AppHandle>,
    /* subscribers outside the renderer, keyed on the latest status set */
    update_hooks: Vec<Box<dyn Fn(&BTreeMap<String, RuntimeStatus>) + Send + Sync>>,
    last_states: HashMap<String, AgentRunState>,
}

fn runtime_state() -> &'static Mutex<Option<RuntimeState>> {
    static STATE: OnceLock<Mutex<Option<RuntimeState>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

const WORKING_PULSE_MS: u64 = 1500;

/* most recent tick's statuses — read by surfaces that don't live in the
renderer (remote monitor) */
static LATEST: OnceLock<Mutex<BTreeMap<String, RuntimeStatus>>> = OnceLock::new();
fn latest() -> &'static Mutex<BTreeMap<String, RuntimeStatus>> {
    LATEST.get_or_init(|| Mutex::new(BTreeMap::new()))
}
#[derive(Clone)]
struct ReportedAgent {
    agent: String,
    state: AgentRunState,
}

static REPORTED: OnceLock<Mutex<HashMap<String, ReportedAgent>>> = OnceLock::new();
fn reported() -> &'static Mutex<HashMap<String, ReportedAgent>> {
    REPORTED.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn report_agent_state(pane_id: &str, agent: &str, state: &str, _message: Option<String>) {
    let state = match state {
        "working" => AgentRunState::Working,
        "blocked" => AgentRunState::Blocked,
        "idle" => AgentRunState::Idle,
        _ => return,
    };
    reported().lock().unwrap().insert(
        pane_id.to_string(),
        ReportedAgent {
            agent: agent.to_string(),
            state,
        },
    );
}

pub fn clear_reported_agent(pane_id: &str) {
    reported().lock().unwrap().remove(pane_id);
}

pub fn has_reported_agent(pane_id: &str) -> bool {
    reported().lock().unwrap().contains_key(pane_id)
}
static USER_INPUT_AT: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
fn user_input_at() -> &'static Mutex<HashMap<String, u64>> {
    USER_INPUT_AT.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn note_user_input(pane_id: &str) {
    user_input_at()
        .lock()
        .unwrap()
        .insert(pane_id.to_string(), now_ms());
}

fn input_is_recent(pane_id: &str) -> bool {
    now_ms().saturating_sub(
        user_input_at()
            .lock()
            .unwrap()
            .get(pane_id)
            .copied()
            .unwrap_or(0),
    ) < 750
}

pub fn latest_runtime_statuses() -> BTreeMap<String, RuntimeStatus> {
    latest().lock().unwrap().clone()
}

pub fn on_runtime_update(cb: impl Fn(&BTreeMap<String, RuntimeStatus>) + Send + Sync + 'static) {
    let mut guard = runtime_state().lock().unwrap();
    if let Some(st) = guard.as_mut() {
        st.update_hooks.push(Box::new(cb));
    }
}

/* store the tick + notify the renderer and hook subscribers, but only
when something actually changed */
fn publish(statuses: &BTreeMap<String, RuntimeStatus>) {
    {
        let mut lat = latest().lock().unwrap();
        *lat = statuses.clone();
    }
    let mut guard = runtime_state().lock().unwrap();
    let Some(st) = guard.as_mut() else { return };
    let hooks = &mut st.update_hooks;
    for hook in hooks.iter_mut() {
        hook(statuses);
    }
    if let Some(app) = &st.app {
        let _ = app.emit("rt:status", statuses);
    }
}

/* Which state transitions earn an OS notification. Only working -> done
   (idle) and working -> blocked, per the settings copy. */
fn transition_notice(prev: &AgentRunState, next: &AgentRunState) -> Option<&'static str> {
    match (prev, next) {
        (AgentRunState::Working, AgentRunState::Idle) => Some("finished"),
        (AgentRunState::Working, AgentRunState::Blocked) => Some("blocked"),
        _ => None,
    }
}

/* pane -> "agent in workspace" for the notification body */
fn pane_label(app: &tauri::AppHandle, pane_id: &str, agent: &str) -> String {
    let s = app.state::<crate::state::AppStateManager>().get_state();
    let rec = s.open_tabs.iter().find(|r| {
        let tree = r
            .split_tree
            .clone()
            .unwrap_or_else(|| crate::split_tree::leaf_node(&r.id));
        crate::split_tree::tree_has_leaf(&tree, pane_id)
    });
    let title = rec
        .and_then(|r| r.title.clone())
        .filter(|t| !t.trim().is_empty())
        .or_else(|| {
            rec.and_then(|r| {
                s.workspaces
                    .iter()
                    .find(|w| w.id == r.workspace_id)
                    .map(|w| w.name.clone())
            })
        });
    match title {
        Some(t) => format!("{agent} in {t}"),
        None => agent.to_string(),
    }
}

/* Fire an OS notification for a working -> done/blocked transition.
   Only manifest- and integration-derived states qualify: the "activity"
   fallback flips on a 1.5 s output pulse and would notify on every shell
   command in a pane whose agent has no manifest. */
fn notify_state_change(
    app: &tauri::AppHandle,
    pane_id: &str,
    st: &RuntimeStatus,
    prev: &AgentRunState,
    next: &AgentRunState,
) {
    let Some(kind) = transition_notice(prev, next) else {
        return;
    };
    if !matches!(st.source.as_deref(), Some("manifest") | Some("integration")) {
        return;
    }
    let prefs = app
        .state::<crate::state::AppStateManager>()
        .get_state()
        .prefs;
    /* the Notifications master switch wins over the per-event one */
    let enabled = prefs.notif_enabled.unwrap_or(true) && prefs.notif_agent_state.unwrap_or(true);
    if !enabled {
        return;
    }
    let agent = st.runtime.as_deref().unwrap_or("agent");
    let where_ = pane_label(app, pane_id, agent);
    let body = if kind == "blocked" {
        format!("{where_} is blocked and waiting for you")
    } else {
        format!("{where_} finished")
    };
    if let Err(e) = crate::notify::send(app, "Bentomux", &body) {
        eprintln!("[bentomux] agent state notification failed: {e}");
    }
}

struct Proc {
    pid: u32,
    ppid: u32,
    name: String,
    cmd: Option<String>,
}

struct Match {
    agent: String,
    depth: usize,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* binary-name matchers, ported verbatim from runtime.ts */
const NAME_RE: &[(&str, &str)] = &[
    ("claude", r"^claude(-code)?(-[\w.]+)?(\.exe|\.cmd|\.bat)?$"),
    ("pi", r"^pi(-agent)?(\.exe|\.cmd|\.bat)?$"),
    ("codex", r"^codex(-[\w.]+)?(\.exe|\.cmd|\.bat)?$"),
    ("gemini", r"^gemini(-[\w.]+)?(\.exe|\.cmd|\.bat)?$"),
    ("opencode", r"^opencode(-[\w.]+)?(\.exe|\.cmd|\.bat)?$"),
    ("copilot", r"^(copilot|ghcs)(\.exe|\.cmd|\.bat)?$"),
    ("cursor", r"^cursor-agent(\.exe|\.cmd|\.bat)?$"),
    ("grok", r"^grok(\.exe|\.cmd|\.bat)?$"),
    ("omp", r"^(omp|oh-my-pi)(\.exe|\.cmd|\.bat)?$"),
    ("amp", r"^amp(\.exe|\.cmd|\.bat)?$"),
    ("antigravity", r"^antigravity(-cli)?(\.exe|\.cmd|\.bat)?$"),
    ("cline", r"^cline(\.exe|\.cmd|\.bat)?$"),
    ("devin", r"^devin(-cli)?(\.exe|\.cmd|\.bat)?$"),
    ("hermes", r"^hermes(-agent)?(\.exe|\.cmd|\.bat)?$"),
    ("kiro", r"^kiro(-cli)?(\.exe|\.cmd|\.bat)?$"),
    ("maki", r"^maki(\.exe|\.cmd|\.bat)?$"),
    ("muse", r"^muse(-code|-cli)?(\.exe|\.cmd|\.bat)?$"),
    ("qodercli", r"^qoder(?:cli|cn)?(\.exe|\.cmd|\.bat)?$"),
];

const MINOR_RE: &str = r"^(qwenpaw|qwen|kimi|kilo|droid)(-code)?(\.exe|\.cmd|\.bat)?$";

/* Patterns are compiled once: match_agent runs per descendant process on
every runtime tick, so building the 18 binary-name regexes inline meant
~hundreds of regex compilations per second. */
fn name_res() -> &'static [(&'static str, regex::Regex)] {
    static RES: OnceLock<Vec<(&'static str, regex::Regex)>> = OnceLock::new();
    RES.get_or_init(|| {
        NAME_RE
            .iter()
            .filter_map(|(agent, re)| regex::Regex::new(re).ok().map(|c| (*agent, c)))
            .collect()
    })
}

fn claude_cmd_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r#"(^|[\\/"])claude(\.exe)?(["']?\s|$)"#)
            .expect("valid claude wrapper regex")
    })
}

fn minor_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(MINOR_RE).expect("valid minor-agent regex"))
}

/* one binary-name guess against the known-agent patterns */
fn match_binary_name(name: &str) -> Option<&'static str> {
    /* process names are lowercase in practice — only allocate when they aren't */
    let n: Cow<'_, str> = if name.bytes().any(|b| b.is_ascii_uppercase()) {
        Cow::Owned(name.to_lowercase())
    } else {
        Cow::Borrowed(name)
    };
    for (agent, re) in name_res() {
        if re.is_match(&n) {
            return Some(agent);
        }
    }
    if let Some(m) = minor_re().captures(&n) {
        return Some(match m.get(1).unwrap().as_str() {
            "qwenpaw" => "qwenpaw",
            "qwen" => "qwen",
            "kimi" => "kimi",
            "kilo" => "kilo",
            "droid" => "droid",
            "amp" => "amp",
            _ => unreachable!(),
        });
    }
    None
}

/* The directory of an installed npm package inside a path — `@scope/pkg` for
   a scoped package, `pkg` otherwise. When a shim hands the package entry point
to the interpreter, the file name is a generic `cli.js`/`index.js` and only the
package directory carries the agent name
   (`node …\node_modules\@github\copilot\dist\index.js`). */
fn npm_package_name(token: &str) -> Option<&str> {
    const MARKER: &str = "node_modules/";
    let tail = &token[token.rfind(MARKER)? + MARKER.len()..];
    let mut segments = tail.split('/').filter(|segment| !segment.is_empty());
    let first = segments.next()?;
    if first.starts_with('@') {
        segments.next()
    } else {
        Some(first)
    }
}

fn match_agent(name: &str, cmd: Option<&str>) -> Option<&'static str> {
    if let Some(agent) = match_binary_name(name) {
        return Some(agent);
    }
    /* the command-line pass is only reached when the binary name gave no
    answer, so the lowercased cmd string is built lazily here. Backslashes
    are folded to `/` so the Windows PEB command line (which keeps the
    `@scope\pkg` install path as written by the npm shim) matches the same
    patterns as a POSIX argv. */
    let c = cmd
        .map(|s| s.to_lowercase().replace('\\', "/"))
        .unwrap_or_default();
    /* npm-wrapper invocations only visible in the command line */
    if c.contains("@anthropic-ai/claude-code") {
        return Some("claude");
    }
    /* (^|[\\/"])claude(\.exe)?(["']?\s|$) on the first 240 chars */
    {
        let head: String = c.chars().take(240).collect();
        if claude_cmd_re().is_match(&head) {
            return Some("claude");
        }
    }
    if c.contains("@earendil-works/pi-coding-agent")
        || c.contains("@mariozechner/pi-coding-agent")
        || c.contains(".pi/agent")
    {
        return Some("pi");
    }
    if c.contains("@openai/codex") {
        return Some("codex");
    }
    if c.contains("oh-my-pi") || c.contains("oh_my_pi") || c.contains("/omp") {
        return Some("omp");
    }
    if c.contains("@google/gemini-cli") {
        return Some("gemini");
    }
    /* Hermes ships a generated `/bin/sh` shim that execs python with a
    multi-kilobyte inline bootstrap, so neither the binary name nor any
    argument token is `hermes`: the TUI process reports name="python3" with
    argv[0]="python3", and its node child reports `ui-tui/dist/entry.js`.
    The install root is the only stable evidence in either command line, and
    it must be paired with a hermes path so a project directory that merely
    shares the name does not read as the agent. */
    if c.contains(".hermes/hermes-agent")
        || c.contains("/hermes-agent/hermes")
        || c.contains("hermes_cli.main")
        || c.contains("hermes-agent/ui-tui")
    {
        return Some("hermes");
    }
    /* The agent name is not always a bare token. Node CLIs that set
    `process.title` (pi, omp, …) replace their own argv[0], so on macOS
    sysinfo reports name="node" with the real name stranded in the argument
    list ("pi BENTOMUX_BRIDGE=…"); an interpreter-launched CLI keeps
    argv[0]="node" instead and carries the launcher path
    ("node /usr/local/bin/codex", measured). Retry the binary-name patterns
    on the file name of every argument token, and on the npm package
    directory of an installed package. */
    for token in c.split_whitespace() {
        /* quote marks survive when the arg holding the path was quoted */
        let token = token.trim_matches(|ch| ch == '"' || ch == '\'');
        let file_name = token.rsplit('/').next().unwrap_or(token);
        if let Some(agent) = match_binary_name(file_name) {
            return Some(agent);
        }
        if let Some(agent) = npm_package_name(token).and_then(match_binary_name) {
            return Some(agent);
        }
    }
    None
}

fn snapshot(sys: &mut System) -> Vec<Proc> {
    /* Runtime detection needs parent, name, and command only. Avoid refreshing
    CPU, memory, disk, cwd, environment, and executable metadata for every
    process on each tick. The System instance is reused across ticks so the
    process table is refreshed in place instead of re-enumerated. */
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new()
            .with_cmd(UpdateKind::Always)
            .without_cpu()
            .without_memory()
            .without_disk_usage()
            .without_cwd()
            .without_root()
            .without_environ()
            .without_exe(),
    );
    sys.processes()
        .iter()
        .map(|(pid, p)| Proc {
            pid: pid.as_u32(),
            ppid: p.parent().map(|pp| pp.as_u32()).unwrap_or(0),
            name: p.name().to_string_lossy().to_string(),
            cmd: if p.cmd().is_empty() {
                None
            } else {
                Some(
                    p.cmd()
                        .iter()
                        .map(|c| c.to_string_lossy())
                        .collect::<Vec<_>>()
                        .join(" "),
                )
            },
        })
        .collect()
}

/* Note: Electron's ps-list resolves cmd via /proc on Linux; on macOS the
process name is used and cmd rarely surfaces for the agent wrapper. The
binary-name matcher covers both platforms. */
fn deepest_match(start_pid: u32, by_parent: &HashMap<u32, Vec<&Proc>>) -> Option<Match> {
    let mut best: Option<Match> = None;
    let mut seen: HashSet<u32> = HashSet::new();
    seen.insert(start_pid);
    let mut frontier = vec![start_pid];
    let mut depth = 0usize;
    while !frontier.is_empty() && depth < 16 {
        depth += 1;
        let mut next: Vec<u32> = Vec::new();
        for pid in frontier {
            for child in by_parent.get(&pid).into_iter().flatten() {
                if seen.contains(&child.pid) {
                    continue;
                }
                seen.insert(child.pid);
                next.push(child.pid);
                if let Some(m) = match_agent(&child.name, child.cmd.as_deref()) {
                    if best.is_none() || depth < best.as_ref().unwrap().depth {
                        best = Some(Match {
                            agent: m.to_string(),
                            depth,
                        });
                    }
                }
            }
        }
        frontier = next;
    }
    best
}

fn status_for(tab_id: &str, match_: Option<Match>) -> RuntimeStatus {
    let Some(m) = match_ else {
        clear_reported_agent(tab_id);
        return RuntimeStatus {
            running: false,
            runtime: None,
            state: None,
            matched_rule: None,
            source: None,
        };
    };
    let mut base = RuntimeStatus {
        running: true,
        runtime: Some(m.agent.clone()),
        state: None,
        matched_rule: None,
        source: None,
    };
    if let Some(reported) = reported().lock().unwrap().get(tab_id).cloned() {
        base.runtime = Some(reported.agent);
        base.state = Some(reported.state);
        base.source = Some("integration".to_string());
        return base;
    }
    let (osc_title, osc_progress, last_data_at) = screen::screen_meta(tab_id);
    let lines = screen::screen_lines(tab_id);
    let manifest = manifest_for(&m.agent);

    let Some(manifest) = manifest.as_ref().filter(|_| !lines.is_empty()) else {
        let working =
            !input_is_recent(tab_id) && now_ms().saturating_sub(last_data_at) < WORKING_PULSE_MS;
        base.state = Some(if working {
            AgentRunState::Working
        } else {
            AgentRunState::Idle
        });
        base.source = Some("activity".to_string());
        return base;
    };

    let det = rules::evaluate(
        manifest,
        &rules::ScreenInput {
            osc_title,
            osc_progress,
            lines,
        },
    );

    if det.skip_state_update {
        /* transient overlay (transcript view, pickers): hold the previous state */
        let prev = runtime_state()
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|st| st.last_states.get(tab_id))
            .cloned()
            .unwrap_or(AgentRunState::Working);
        base.state = Some(prev);
        base.matched_rule = det.rule_id;
        base.source = Some("manifest".to_string());
        return base;
    }
    match det.state {
        None | Some(rules::RunState::Unknown) => {
            /* default_known_agent_idle_fallback */
            base.state = Some(AgentRunState::Idle);
            base.source = Some("manifest".to_string());
        }
        Some(rules::RunState::Idle) => base.state = Some(AgentRunState::Idle),
        Some(rules::RunState::Working) => base.state = Some(AgentRunState::Working),
        Some(rules::RunState::Blocked) => base.state = Some(AgentRunState::Blocked),
    }
    if matches!(det.state, Some(_)) && det.state != Some(rules::RunState::Unknown) {
        base.matched_rule = det.rule_id;
    }
    base.source = Some("manifest".to_string());
    base
}

pub fn init(app: tauri::AppHandle) {
    {
        let mut guard = runtime_state().lock().unwrap();
        *guard = Some(RuntimeState {
            app: Some(app.clone()),
            update_hooks: Vec::new(),
            last_states: HashMap::new(),
        });
    }

    /* the PTY daemon owns the authoritative terminal parser and publishes
    immutable snapshots; runtime only evaluates the cached snapshots. */
    /* per-tab runtime poller. Base cadence stays 1s so status dots feel
    live, but idle machines back off to 5s: sysinfo refresh + tree walk +
    manifest eval per tick is the hottest backend loop in the app. */
    const BASE_TICK_MS: u64 = 1000;
    const IDLE_TICK_MS: u64 = 5000;
    std::thread::spawn(move || {
        let mut sys = System::new();
        let mut last_statuses: BTreeMap<String, RuntimeStatus> = BTreeMap::new();
        let mut idle_ticks: u32 = 0;
        loop {
            let terms = app.state::<PtyManager>().live_terms();
            if terms.is_empty() {
                if !last_statuses.is_empty() {
                    last_statuses = BTreeMap::new();
                    publish(&last_statuses);
                }
                idle_ticks = idle_ticks.saturating_add(1);
                std::thread::sleep(std::time::Duration::from_millis(if idle_ticks >= 3 {
                    IDLE_TICK_MS
                } else {
                    BASE_TICK_MS
                }));
                continue;
            }
            let procs = snapshot(&mut sys);
            let mut by_parent: HashMap<u32, Vec<&Proc>> = HashMap::new();
            for p in &procs {
                by_parent.entry(p.ppid).or_default().push(p);
            }
            let mut statuses: BTreeMap<String, RuntimeStatus> = BTreeMap::new();
            for t in &terms {
                let prev = runtime_state()
                    .lock()
                    .unwrap()
                    .as_ref()
                    .and_then(|s| s.last_states.get(&t.id).cloned());
                let st = status_for(&t.id, deepest_match(t.pid, &by_parent));
                if let (Some(prev), Some(next)) = (&prev, &st.state) {
                    notify_state_change(&app, &t.id, &st, prev, next);
                }
                if st.state.is_some() {
                    runtime_state().lock().unwrap().as_mut().map(|s| {
                        s.last_states
                            .insert(t.id.clone(), st.state.clone().unwrap())
                    });
                } else {
                    /* agent gone: forget the old state so the next agent in
                       this pane cannot inherit it and fire a stale notice */
                    runtime_state()
                        .lock()
                        .unwrap()
                        .as_mut()
                        .map(|s| s.last_states.remove(&t.id));
                }
                statuses.insert(t.id.clone(), st);
            }
            /* match the Electron change-detection: only publish a new frame
            when the payload differs. BTreeMap<RuntimeStatus> derives
            PartialEq, so compare structs directly instead of serializing
            the whole map to JSON on every tick. */
            if statuses != last_statuses {
                last_statuses = statuses.clone();
                idle_ticks = 0;
                publish(&statuses);
            } else {
                idle_ticks = idle_ticks.saturating_add(1);
            }
            std::thread::sleep(std::time::Duration::from_millis(if idle_ticks >= 5 {
                IDLE_TICK_MS
            } else {
                BASE_TICK_MS
            }));
        }
    });
}

pub fn agent_config_view(
    workspaces: &[crate::state::WorkspaceRec],
    agent_id: &str,
) -> Option<AgentConfigView> {
    crate::agents::index::agent_config_view(workspaces, agent_id)
}

pub fn set_agent_model_settings(
    workspaces: &[crate::state::WorkspaceRec],
    agent_id: &str,
    patch: ModelSettingsPatch,
) -> Result<AgentConfigView, String> {
    crate::agents::index::set_agent_model_settings(workspaces, agent_id, patch)
}

pub fn agent_hooks_status() -> AgentHooksStatus {
    crate::agent_hooks::read_hook_status(&crate::agent_hooks::default_settings_path())
}

pub fn agent_hooks_install(script_path: &str) -> AgentHooksStatus {
    crate::agent_hooks::install_hooks(&crate::agent_hooks::default_settings_path(), script_path)
}

pub fn agent_hooks_uninstall() -> AgentHooksStatus {
    crate::agent_hooks::uninstall_hooks(&crate::agent_hooks::default_settings_path())
}

/* live detection + model settings come from the agent adapters */
pub fn agents_info(workspaces: &[crate::state::WorkspaceRec]) -> Vec<AgentInfo> {
    crate::agents::index::agents_info(workspaces)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, ppid: u32, name: &str, cmd: Option<&str>) -> Proc {
        Proc {
            pid,
            ppid,
            name: name.to_string(),
            cmd: cmd.map(|s| s.to_string()),
        }
    }

    /* ---------- binary-name matching ---------- */

    #[test]
    fn match_agent_known_binary_names() {
        for (name, expect) in [
            ("claude", "claude"),
            ("claude-code", "claude"),
            ("claude-code-1.0.5", "claude"),
            ("claude.exe", "claude"),
            ("pi", "pi"),
            ("pi-agent", "pi"),
            ("codex", "codex"),
            ("codex-1.2.3", "codex"),
            ("gemini", "gemini"),
            ("opencode", "opencode"),
            ("copilot", "copilot"),
            ("cursor-agent", "cursor"),
            ("grok", "grok"),
        ] {
            assert_eq!(match_agent(name, None), Some(expect), "name {name}");
        }
    }

    #[test]
    fn match_agent_minor_agents() {
        assert_eq!(match_agent("qwen", None), Some("qwen"));
        assert_eq!(match_agent("qwen-code", None), Some("qwen"));
        assert_eq!(match_agent("qwenpaw", None), Some("qwenpaw"));
        assert_eq!(match_agent("qwenpaw-code", None), Some("qwenpaw"));
        assert_eq!(match_agent("kimi", None), Some("kimi"));
        assert_eq!(match_agent("droid", None), Some("droid"));
        assert_eq!(match_agent("amp", None), Some("amp"));
    }

    #[test]
    fn match_agent_ignores_plain_shells() {
        assert_eq!(match_agent("bash", None), None);
        assert_eq!(match_agent("zsh", None), None);
        assert_eq!(match_agent("node", None), None);
        assert_eq!(match_agent("git", None), None);
    }

    #[test]
    fn transition_notice_covers_done_and_blocked_only() {
        use AgentRunState::{Blocked, Idle, Working};
        assert_eq!(transition_notice(&Working, &Idle), Some("finished"));
        assert_eq!(transition_notice(&Working, &Blocked), Some("blocked"));
        assert_eq!(transition_notice(&Idle, &Working), None);
        assert_eq!(transition_notice(&Blocked, &Idle), None);
        assert_eq!(transition_notice(&Working, &Working), None);
    }

    #[test]
    fn match_agent_resolves_npm_wrappers_via_cmd() {
        /* trailing /claude token (preceded by slash, end-of-line) matches the
        token rule; an inline `claude-code` in the middle of the tail does not */
        assert_eq!(
            match_agent("node", Some("/usr/local/bin/claude")),
            Some("claude")
        );
        assert_eq!(
            match_agent("node", Some("node /usr/local/bin/claude --mcp")),
            Some("claude")
        );
        assert_eq!(
            match_agent("npm", Some("npm exec @anthropic-ai/claude-code")),
            Some("claude")
        );
        assert_eq!(
            match_agent("node", Some(".\\node_modules\\@openai\\codex")),
            Some("codex")
        );
        assert_eq!(
            match_agent("node", Some("@google/gemini-cli foo")),
            Some("gemini")
        );
        assert_eq!(match_agent("node", Some(".pi/agent run")), Some("pi"));
    }

    /* measured: an npm shim on POSIX is a symlink to the package entry point,
    but the kernel writes the *shim* path into argv[1], not the package path
    (`node /usr/local/bin/codex --version`), so the file name of the
    argument is what identifies the agent on macOS/Linux */
    #[test]
    fn match_agent_reads_launcher_paths() {
        assert_eq!(
            match_agent("node", Some("node /usr/local/bin/codex --version")),
            Some("codex")
        );
        assert_eq!(
            match_agent("node", Some("node /usr/local/bin/gemini")),
            Some("gemini")
        );
        assert_eq!(
            match_agent("node", Some("node /usr/local/bin/claude-code")),
            Some("claude")
        );
        assert_eq!(
            match_agent("node", Some("node /usr/local/bin/kimi")),
            Some("kimi")
        );
        /* measured: `hermes --tui` is a generated sh shim that execs python
        with a ~7 KB inline bootstrap, so the agent's own process reports
        name="python3" and argv[0]="python3" — no argument token is ever
        `hermes`. Only the install root in the command line identifies it. */
        assert_eq!(
            match_agent(
                "python3",
                Some(
                    "/Users/mac/.hermes/tools/python-3.14.7-darwin-x64/bin/python3 -I -c import os\012sys.path.insert(0, '/Users/mac/.hermes/hermes-agent')\012from hermes_cli.main import main"
                )
            ),
            Some("hermes")
        );
        assert_eq!(
            match_agent(
                "node",
                Some("node --expose-gc /Users/mac/.hermes/hermes-agent/ui-tui/dist/entry.js")
            ),
            Some("hermes")
        );
        /* a python-based agent keeps the interpreter in argv[0] as well */
        assert_eq!(
            match_agent(
                "python3",
                Some(
                    "/Users/mac/.hermes/hermes-agent/venv/bin/python3 /Users/mac/.hermes/hermes-agent/venv/bin/hermes"
                )
            ),
            Some("hermes")
        );
        /* Windows `.cmd`/`.ps1` shims run under cmd.exe before node starts */
        assert_eq!(
            match_agent("cmd.exe", Some("C:/WINDOWS/system32/cmd.exe /d /c \"C:/Users/mac/AppData/Roaming/npm/droid.cmd\"")),
            Some("droid")
        );
        /* a non-agent launcher path stays unmatched */
        assert_eq!(
            match_agent("node", Some("node /usr/lib/pipeline/index.js")),
            None
        );
    }

    /* when the shim passes the package entry point to node itself the file name
    is a generic cli.js/index.js, so the npm package directory is the only
    agent evidence — the shape Windows npm shims and `npm exec` produce */
    #[test]
    fn match_agent_reads_npm_package_dirs() {
        assert_eq!(
            match_agent(
                "node",
                Some("node /usr/local/lib/node_modules/@openai/codex/bin/codex.js")
            ),
            Some("codex")
        );
        assert_eq!(
            match_agent(
                "node.exe",
                Some(
                    "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\mac\\AppData\\Roaming\\npm\\node_modules\\@github\\copilot\\dist\\index.js\""
                )
            ),
            Some("copilot")
        );
        assert_eq!(
            match_agent(
                "node.exe",
                Some("\"node.exe\" \"C:\\Users\\mac\\AppData\\Roaming\\npm\\node_modules\\@qwen-code\\qwen-code\\cli.js\"")
            ),
            Some("qwen")
        );
        assert_eq!(
            match_agent("node", Some("node /app/node_modules/lodash/index.js")),
            None
        );
    }

    #[test]
    fn match_agent_unknown_returns_none() {
        assert_eq!(match_agent("deno", Some("deno run server.ts")), None);
        assert_eq!(match_agent("tmux", None), None);
    }

    /* ---------- process-tree walking ---------- */

    fn parent_map(procs: &[Proc]) -> HashMap<u32, Vec<&Proc>> {
        let mut by_parent: HashMap<u32, Vec<&Proc>> = HashMap::new();
        for p in procs {
            by_parent.entry(p.ppid).or_default().push(p);
        }
        by_parent
    }

    #[test]
    fn deepest_match_finds_agent_descendant_at_shallowest_depth() {
        /* shell → node → claude-code. The node wrapper itself matches via the
        trailing /claude token, so the shallowest agent (depth 1) wins. */
        let procs = vec![
            proc(1, 0, "zsh", None),
            proc(2, 1, "node", Some("node /usr/local/bin/claude")),
            proc(3, 2, "claude-code", None),
        ];
        let m = deepest_match(1, &parent_map(&procs)).unwrap();
        assert_eq!(m.agent, "claude");
        assert_eq!(m.depth, 1);
    }

    #[test]
    fn deepest_match_prefers_shallowest_agent() {
        /* two agents; the shallowest (depth 1) must win over depth 3 */
        let procs = vec![
            proc(1, 0, "zsh", None),
            proc(2, 1, "codex", None),
            proc(3, 1, "node", Some("node gemini")),
            proc(4, 3, "gemini", None),
        ];
        let m = deepest_match(1, &parent_map(&procs)).unwrap();
        assert_eq!(m.agent, "codex");
        assert_eq!(m.depth, 1);
    }

    #[test]
    fn deepest_match_none_when_no_agent_in_tree() {
        let procs = vec![
            proc(1, 0, "bash", None),
            proc(2, 1, "git", None),
            proc(3, 1, "ls", None),
        ];
        assert!(deepest_match(1, &parent_map(&procs)).is_none());
    }

    /* macOS: pi sets process.title, so sysinfo reports name="node" and the
    real name lands in the argument list — the tab used to read as "shell"
    unless a grandchild happened to carry ".pi/agent" in its argv */
    #[test]
    fn match_agent_reads_title_rewritten_pi() {
        assert_eq!(
            match_agent("node", Some("pi BENTOMUX_BRIDGE=/tmp/bentomux-bridge.sock")),
            Some("pi")
        );
        assert_eq!(match_agent("node", Some("pi")), Some("pi"));
        /* the launcher path is recognized too; pi itself rewrites argv[0] */
        assert_eq!(
            match_agent("node", Some("node /usr/local/bin/pi")),
            Some("pi")
        );
        /* unrelated node processes stay unmatched */
        assert_eq!(
            match_agent("node", Some("node server.js --port 3000")),
            None
        );
        assert_eq!(
            match_agent("node", Some("node /usr/lib/pipeline/index.js")),
            None
        );
    }

    #[test]
    fn match_agent_recognizes_omp_and_pi_wrappers() {
        assert_eq!(match_agent("omp", None), Some("omp"));
        assert_eq!(
            match_agent("node", Some("node ./oh-my-pi/bin/omp")),
            Some("omp")
        );
        assert_eq!(
            match_agent("node", Some("node @mariozechner/pi-coding-agent")),
            Some("pi")
        );
    }

    /* Windows: `process.title` only renames the console (libuv calls
    SetConsoleTitleW), so sysinfo reports the real image name "node.exe" and
    the npm shim's backslash install path is the only agent evidence */
    #[test]
    fn match_agent_reads_windows_npm_shim_paths() {
        assert_eq!(
            match_agent(
                "node.exe",
                Some(
                    "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\mac\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js\""
                )
            ),
            Some("pi")
        );
        assert_eq!(
            match_agent(
                "node.exe",
                Some("\"node.exe\" \"C:\\Users\\mac\\.pi\\agent\\npm\\node_modules\\pi-intercom\\dist\\cli.js\"")
            ),
            Some("pi")
        );
        assert_eq!(
            match_agent(
                "node.exe",
                Some("\"node.exe\" \"C:\\Users\\mac\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js\"")
            ),
            Some("claude")
        );
        /* plain node processes under Windows still resolve to nothing */
        assert_eq!(
            match_agent("node.exe", Some("\"node.exe\" \"C:\\app\\server.js\"")),
            None
        );
    }

    /* Linux: libuv's uv_set_process_title calls prctl(PR_SET_NAME), so
    /proc/<pid>/stat comm — what sysinfo reads as the name — becomes "pi" */
    #[test]
    fn match_agent_reads_linux_prctl_name() {
        assert_eq!(match_agent("pi", Some("pi --resume")), Some("pi"));
    }

    #[test]
    fn deepest_match_respects_start_identity_miss() {
        /* the start process itself matches nothing even if it is a real agent;
        we only look at descendants, mirroring the TS behavior */
        let procs = vec![proc(1, 0, "claude", None)];
        assert!(deepest_match(1, &parent_map(&procs)).is_none());
    }

    #[test]
    fn deepest_match_does_not_loop_on_cycles() {
        let procs = vec![
            proc(1, 0, "bash", None),
            proc(2, 1, "bash", None),
            proc(1, 2, "bash", None), /* cycle back to the root */
        ];
        /* must terminate (depth cap) without hanging */
        assert!(deepest_match(1, &parent_map(&procs)).is_none());
    }
    #[test]
    fn missing_agent_process_clears_reported_state() {
        report_agent_state("pane-quit", "pi", "working", None);
        let status = status_for("pane-quit", None);
        assert!(!status.running);
        assert!(status.runtime.is_none());
        assert!(!has_reported_agent("pane-quit"));
    }
}
