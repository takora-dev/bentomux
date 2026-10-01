/* ---------------- persisted app state (app_data_dir/bentomux.json) ----------------
Rust port of src/main/store.ts. Owned by the backend; the renderer
reaches it only through Tauri commands. All structs serialize in the
exact camelCase JSON shape the Electron version wrote, so existing
bentomux.json files load unchanged. */

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::plugin::PluginRecord;
use crate::split_tree::{first_leaf_id, tree_from_legacy, Dir, PaneNode};

const VERSION: u32 = 6;

/* ---------------- shared type contract (src/shared/types.ts) ---------------- */

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WorkspaceRec {
    pub id: String,
    pub path: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabRec {
    pub id: String,
    pub workspace_id: String,
    /* split view layout; absent when the tab holds a single pane.
    id is always the first (topmost-leftmost) leaf of the tree. */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub split_tree: Option<PaneNode>,
    /* custom tab title; absent/empty falls back to branch or workspace name */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
pub enum ResourceKind {
    #[serde(rename = "memory")]
    Memory,
    #[serde(rename = "skills")]
    Skills,
    #[serde(rename = "mcp")]
    Mcp,
}

/* user-resized approval overlay window (px); absent = built-in default */
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverlaySize {
    pub w: f64,
    pub h: f64,
}

/* main window geometry (logical px) remembered across launches. The rect is
only recorded while the window is in its normal state, so `maximized` can
unmaximize back to it (see `lib::save_window_bounds`). */
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub maximized: bool,
}

/* mirrors the main window's minWidth/minHeight in tauri.conf.json: a rect
smaller than this came from a transient state and is not worth restoring */
pub const MIN_WINDOW_W: f64 = 900.0;
pub const MIN_WINDOW_H: f64 = 600.0;

impl WindowBounds {
    pub fn is_usable(&self) -> bool {
        self.w >= MIN_WINDOW_W && self.h >= MIN_WINDOW_H
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemotePrefs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /* pairing token embedded in the QR URL; generated on first enable so
    paired devices survive restarts */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

/* three source colors for the user-defined palette; every other token is
   derived from them in CSS */
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomPalette {
    pub bg: String,
    pub ink: String,
    pub accent: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub theme: Option<String>,
    pub palette: Option<String>,
    pub custom_palette: Option<CustomPalette>,
    /* terminal font family (CSS font stack) + size in px; absent = built-in default */
    pub font: Option<String>,
    pub font_size: Option<f64>,
    /* shell for NEW terminals; absent = auto-detect (pwsh → powershell → cmd) */
    pub shell: Option<String>,
    /* app-shortcut overrides: action id → accelerator ("ctrl+shift+k") */
    pub shortcuts: Option<HashMap<String, String>>,
    pub pane_hidden: Option<bool>,
    pub sidebar_width: Option<f64>,
    /* main window size/position; absent = the tauri.conf.json default */
    pub window: Option<WindowBounds>,
    /* terminal split divider positions: split-node key → '%' of the axis.
    Node keys are generated per split, so a stale entry is only ever an
    unused key, never a wrong divider. */
    pub pane_ratios: Option<HashMap<String, f64>>,
    pub expanded: Option<HashMap<String, bool>>,
    /* last custom tab title per workspace; new tabs inherit it so closing
    a tab never loses the name */
    pub tab_titles: Option<HashMap<String, String>>,
    /* folders picked through the add-workspace menu, newest first (capped at 8);
    feeds the "Recent Folder" submenu */
    pub recent_folders: Option<Vec<String>>,
    /* user-resized approval overlay window (px); absent = built-in default */
    pub approval_overlay: Option<OverlaySize>,
    /* agent approval notifications; absent = enabled (overlay pop + chime) */
    pub notif_enabled: Option<bool>,
    pub notif_sound: Option<bool>,
    /* remote monitor (phone browser); absent = disabled */
    pub remote: Option<RemotePrefs>,
    /* auto-update; absent = enabled */
    pub auto_update: Option<bool>,
    /* consecutive boot attempts without a successful first paint. Drives the
    automatic safe-mode entry (plugin::boot); 0 after any good boot. */
    pub boot_attempts: Option<u32>,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            /* "system" so a fresh install follows the OS appearance; an
            explicit light/dark pick is persisted and wins from then on */
            theme: Some("system".to_string()),
            palette: Some("default".to_string()),
            custom_palette: None,
            font: None,
            font_size: None,
            shell: None,
            shortcuts: None,
            pane_hidden: Some(false),
            sidebar_width: Some(248.0),
            window: None,
            pane_ratios: None,
            expanded: Some(HashMap::new()),
            tab_titles: None,
            recent_folders: None,
            approval_overlay: None,
            notif_enabled: None,
            notif_sound: None,
            remote: None,
            auto_update: None,
            boot_attempts: None,
        }
    }
}

/* toggle-off definitions with no native flag in the agent's own config
live here so toggling back on restores them exactly */
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub kind: ResourceKind,
    pub name: String,
    pub updated_at: u64,
    pub data: serde_json::Map<String, serde_json::Value>,
}

/* AgentId → ResourceKind → resource id → snapshot */
pub type ShadowStore = HashMap<String, HashMap<ResourceKind, HashMap<String, ResourceSnapshot>>>;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Capabilities {
    pub memory: bool,
    pub skills: bool,
    pub mcp: bool,
}

impl Default for Capabilities {
    fn default() -> Self {
        Capabilities {
            memory: false,
            skills: false,
            mcp: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub detected: bool,
    pub capabilities: Capabilities,
    /* the agent's current default model, if any (null when no model form) */
    pub current_model: Option<String>,
    /* config file path the adapter writes to; null when read-only */
    pub config_path: Option<String>,
}

impl Default for AgentInfo {
    fn default() -> Self {
        AgentInfo {
            id: String::new(),
            name: String::new(),
            detected: false,
            capabilities: Capabilities::default(),
            current_model: None,
            config_path: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppState {
    pub version: u32,
    pub workspaces: Vec<WorkspaceRec>,
    pub open_tabs: Vec<TabRec>,
    pub active_workspace_id: Option<String>,
    pub shadow: ShadowStore,
    pub prefs: Prefs,
    /* detected agent runtimes; populated on boot + on every agents:list
    command so the sidebar/detail page can render without a separate fetch */
    pub agents: Vec<AgentInfo>,
    /* installed plugins. The registry only: plugin code lives under
    app_data_dir/plugins/<id>/<version>/ and plugin data under
    plugin-data/<id>.json, so this stays a small, diffable list. */
    pub plugins: Vec<PluginRecord>,
    /* session-only, never persisted: this boot is running with third-party
    plugins disabled. `serde(skip)` keeps it out of bentomux.json — safe
    mode is a fact about this session, not a saved preference. */
    #[serde(skip)]
    pub safe_mode: bool,
    /* how many consecutive boot attempts led here, for the banner copy */
    #[serde(skip)]
    pub boot_attempts: u32,
}

impl Default for AppState {
    fn default() -> Self {
        AppState {
            version: VERSION,
            workspaces: vec![],
            open_tabs: vec![],
            active_workspace_id: None,
            shadow: HashMap::new(),
            prefs: Prefs::default(),
            agents: vec![],
            plugins: vec![],
            safe_mode: false,
            boot_attempts: 0,
        }
    }
}

/* ---------------- tabs persisted before layout trees existed ----------------
carried flat extraIds; migrate into a split tree like normTab() did */

fn norm_tab(o: &serde_json::Value) -> Option<TabRec> {
    let id = o.get("id").and_then(|v| v.as_str())?;
    let workspace_id = o.get("workspaceId").and_then(|v| v.as_str())?;

    let title = o
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.to_string());

    let split_tree = match o.get("splitTree") {
        Some(v) if v.is_object() => serde_json::from_value::<PaneNode>(v.clone()).ok(),
        _ => None,
    };

    let mut tab = TabRec {
        id: id.to_string(),
        workspace_id: workspace_id.to_string(),
        split_tree,
        title,
    };

    if tab.split_tree.is_none() {
        let extra_ids: Vec<String> = o
            .get("extraIds")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        if !extra_ids.is_empty() {
            let dir = match o.get("splitDir").and_then(|v| v.as_str()) {
                Some("h") => Dir::H,
                _ => Dir::V,
            };
            let mut ids = vec![id.to_string()];
            ids.extend(extra_ids);
            if let Some(tree) = tree_from_legacy(&ids, Some(dir)) {
                tab.id = first_leaf_id(&tree).to_string();
                tab.split_tree = Some(tree);
            }
        }
    }

    Some(tab)
}

/* ---------------- state manager ---------------- */

pub struct AppStateManager {
    state: Mutex<AppState>,
    path: PathBuf,
}

impl AppStateManager {
    /* Resolve the store path without a live AppHandle so state can be
    managed on the Builder — before WebView2 initialises — eliminating
    the race that causes the Windows "state not managed" boot error. */
    pub fn pre_build_path() -> PathBuf {
        #[cfg(target_os = "windows")]
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        #[cfg(target_os = "macos")]
        let base = std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library").join("Application Support"))
            .unwrap_or_else(|| PathBuf::from("."));
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share"))
            })
            .unwrap_or_else(|| PathBuf::from("."));
        // Must match the active Tauri identifier so dev and production stores stay separate.
        let identifier = if std::env::var_os("BENTOMUX_USER_DATA_SUFFIX").is_some() {
            "app.bentomux.dev"
        } else {
            "app.bentomux.desktop"
        };
        base.join(identifier).join("bentomux.json")
    }

    /* wires the store to the Tauri app data dir (userData equivalent) */
    pub fn with_app_handle(app: &tauri::AppHandle) -> Self {
        use tauri::Manager;
        let dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        Self::new(dir.join("bentomux.json"))
    }

    pub fn new(path: PathBuf) -> Self {
        let mut state = AppState::default();
        if !load_from(&mut state, &path) {
            /* first run after the rebrand: adopt the pre-rebrand store so the
            user's workspaces/tabs/prefs survive the rename */
            if let Some(parent) = path.parent() {
                let legacy = parent
                    .parent()
                    .unwrap_or(parent)
                    .join("Takora")
                    .join("takora.json");
                load_from(&mut state, &legacy);
            }
        }
        /* palettes renamed before the rebrand: map stale values over */
        if state.prefs.palette.as_deref() == Some("takora") {
            state.prefs.palette = Some("default".to_string());
        }
        if state.prefs.palette.as_deref() == Some("pixel") {
            state.prefs.palette = Some("classic".to_string());
        }
        let mgr = AppStateManager {
            state: Mutex::new(state),
            path,
        };
        let st = mgr.state.lock().unwrap().clone();
        persist(&mgr.path, &st);
        mgr
    }

    pub fn get_state(&self) -> AppState {
        self.state.lock().unwrap().clone()
    }

    /* every mutation goes through here so each change is persisted.
    Writes are debounced: rapid patch bursts (drag, typing prefs, tab
    churn) coalesce into one disk write instead of one tmp+backup+rename
    cycle per call. */
    pub fn patch_state<F>(&self, updater: F) -> AppState
    where
        F: FnOnce(&mut AppState),
    {
        let mut state = self.state.lock().unwrap();
        updater(&mut state);
        let snapshot = state.clone();
        drop(state);
        schedule_persist(self.path.clone(), snapshot);
        self.state.lock().unwrap().clone()
    }

    /* synchronous write-through for paths where losing the write is worse
    than the disk cost: boot counter, tests, shutdown */
    pub fn patch_state_sync<F>(&self, updater: F) -> AppState
    where
        F: FnOnce(&mut AppState),
    {
        let mut state = self.state.lock().unwrap();
        updater(&mut state);
        persist(&self.path, &state);
        state.clone()
    }

    /* blocking flush for paths that must not lose data (tests, shutdown) */
    pub fn flush(&self) {
        if let Some(p) = pending().lock().unwrap().take() {
            persist(&p.path, &p.state);
            return;
        }
        let st = self.state.lock().unwrap().clone();
        persist(&self.path, &st);
    }

    pub fn patch_prefs<F>(&self, updater: F) -> AppState
    where
        F: FnOnce(&mut Prefs),
    {
        self.patch_state(|s| updater(&mut s.prefs))
    }

    pub fn shadow_for(
        &self,
        agent_id: &str,
    ) -> HashMap<ResourceKind, HashMap<String, ResourceSnapshot>> {
        self.state
            .lock()
            .unwrap()
            .shadow
            .get(agent_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn set_snapshot(
        &self,
        agent_id: &str,
        kind: ResourceKind,
        id: &str,
        snap: Option<ResourceSnapshot>,
    ) {
        self.patch_state(|s| {
            let per_agent = s.shadow.entry(agent_id.to_string()).or_default();
            let per_kind = per_agent.entry(kind.clone()).or_default();
            match snap {
                Some(snap) => {
                    per_kind.insert(id.to_string(), snap);
                }
                None => {
                    per_kind.remove(id);
                }
            }
            if per_kind.is_empty() {
                per_agent.remove(&kind);
            }
            if per_agent.is_empty() {
                s.shadow.remove(agent_id);
            }
        });
    }
}

/* parse + adopt one store file; false when missing/unreadable.
Same-version AND older files are adopted forward-only: keep the user's
workspaces/tabs/prefs/shadow and add new fields with their defaults. */
fn load_from(state: &mut AppState, path: &Path) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(raw) = serde_json::from_str::<serde_json::Value>(&content) else {
        /* missing or unreadable file: nothing to adopt */
        return false;
    };

    let version = raw.get("version").and_then(|v| v.as_u64());
    match version {
        Some(v) if v == VERSION as u64 => adopt(state, &raw),
        Some(v) if (v as u32) < VERSION => adopt(state, &raw),
        _ => {}
    }
    true
}

/* spread raw over the defaults field-by-field (the {...state, ...raw}
semantics of the TypeScript version), with legacy tabs normalized */
fn adopt(state: &mut AppState, raw: &serde_json::Value) {
    let mut patched: AppState =
        serde_json::from_value(raw.clone()).unwrap_or_else(|_| AppState::default());
    if let Some(tabs) = raw.get("openTabs").and_then(|v| v.as_array()) {
        patched.open_tabs = tabs.iter().filter_map(norm_tab).collect();
    }
    if raw.get("shadow").map(|v| v.is_null()).unwrap_or(true) {
        patched.shadow = HashMap::new();
    }
    /* Stamp the CURRENT version, not the file's.
    Adopting the old number meant every save wrote the old number back, so a
    v3 store stayed "v3" forever and each boot re-ran the same adoption path.
    The value is a migration marker: once this build has read the file, the
    file is in this build's shape. */
    patched.version = VERSION;
    *state = patched;
}

/* debounced persist: first patch in a burst writes through after
PERSIST_DEBOUNCE_MS; further patches inside the window only refresh the
pending snapshot, so N rapid patches cost 1 disk write. Backup rotation
is hourly, not per-write. */
const PERSIST_DEBOUNCE_MS: u64 = 400;
const BACKUP_INTERVAL: Duration = Duration::from_secs(3600);

struct PendingPersist {
    path: PathBuf,
    state: AppState,
    at: Instant,
}

fn pending() -> &'static Mutex<Option<PendingPersist>> {
    static PENDING: OnceLock<Mutex<Option<PendingPersist>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(None))
}

fn last_backup_at() -> &'static Mutex<Option<Instant>> {
    static LAST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

fn schedule_persist(path: PathBuf, state: AppState) {
    let due = {
        let mut guard = pending().lock().unwrap();
        let first = guard.is_none();
        *guard = Some(PendingPersist {
            path: path.clone(),
            state,
            at: Instant::now(),
        });
        first
    };
    if !due {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(PERSIST_DEBOUNCE_MS));
        loop {
            let next = {
                let guard = pending().lock().unwrap();
                match guard.as_ref() {
                    Some(p) if p.at.elapsed() >= Duration::from_millis(PERSIST_DEBOUNCE_MS) => {
                        drop(guard);
                        pending().lock().unwrap().take()
                    }
                    _ => None,
                }
            };
            match next {
                Some(p) => persist(&p.path, &p.state),
                None => {
                    std::thread::sleep(Duration::from_millis(PERSIST_DEBOUNCE_MS));
                    if pending().lock().unwrap().is_none() {
                        break;
                    }
                }
            }
        }
    });
}

/* atomic-ish write: tmp file → backup → rename, like the Electron persist() */
fn persist(path: &Path, state: &AppState) {
    let write = || -> Result<(), String> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("mkdir failed: {}", e))?;
        }
        /* compact JSON: pretty-printing costs bytes + time on every one of
        the 44 patch_state call sites, and nothing reads this file by hand */
        let json = serde_json::to_string(state).map_err(|e| format!("serialize failed: {}", e))?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| format!("write failed: {}", e))?;
        if path.exists() {
            /* hourly backup rotation instead of a rename on every write:
            same crash safety, far fewer directory ops under patch bursts */
            let mut last = last_backup_at().lock().unwrap();
            let due = last.map(|t| t.elapsed() >= BACKUP_INTERVAL).unwrap_or(true);
            if due {
                let bak = path.with_extension("json.bak");
                fs::rename(path, &bak).map_err(|e| format!("backup failed: {}", e))?;
                *last = Some(Instant::now());
            }
        }
        fs::rename(&tmp, path).map_err(|e| format!("rename failed: {}", e))?;
        Ok(())
    };
    if let Err(e) = write() {
        eprintln!("[bentomux] persist failed: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::split_tree::leaf_node;

    fn temp_path(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bentomux-test-{}-{}", tag, std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join("bentomux.json")
    }

    fn cleanup(path: &Path) {
        if let Some(dir) = path.parent() {
            fs::remove_dir_all(dir).ok();
        }
    }

    #[test]
    fn test_defaults_match_electron() {
        let path = temp_path("defaults");
        let mgr = AppStateManager::new(path.clone());
        let st = mgr.get_state();
        assert_eq!(st.version, 6);
        assert!(st.workspaces.is_empty());
        assert!(st.open_tabs.is_empty());
        assert_eq!(st.active_workspace_id, None);
        assert_eq!(st.prefs.theme.as_deref(), Some("system"));
        assert_eq!(st.prefs.palette.as_deref(), Some("default"));
        assert_eq!(st.prefs.pane_hidden, Some(false));
        assert_eq!(st.prefs.sidebar_width, Some(248.0));
        assert!(st.prefs.expanded.as_ref().unwrap().is_empty());
        assert!(st.plugins.is_empty());
        cleanup(&path);
    }

    #[test]
    fn test_patch_state_persists_across_reload() {
        let path = temp_path("patch");
        {
            let mgr = AppStateManager::new(path.clone());
            mgr.patch_state(|s| {
                s.workspaces.push(WorkspaceRec {
                    id: "ws-1".into(),
                    path: "/tmp/proj".into(),
                    name: "proj".into(),
                });
                s.active_workspace_id = Some("ws-1".into());
            });
            mgr.patch_prefs(|p| {
                p.theme = Some("dark".into());
                p.font_size = Some(14.0);
            });
            /* patch_state is debounced; flush before re-reading from disk */
            mgr.flush();
        }
        let mgr = AppStateManager::new(path.clone());
        let st = mgr.get_state();
        assert_eq!(st.workspaces.len(), 1);
        assert_eq!(st.workspaces[0].name, "proj");
        assert_eq!(st.active_workspace_id.as_deref(), Some("ws-1"));
        assert_eq!(st.prefs.theme.as_deref(), Some("dark"));
        assert_eq!(st.prefs.font_size, Some(14.0));
        cleanup(&path);
    }

    /* tabs persisted before layout trees existed carried flat extraIds */
    #[test]
    fn test_legacy_tab_extra_ids_migration() {
        let path = temp_path("legacy-tab");
        fs::write(
            &path,
            serde_json::json!({
                "version": 5,
                "openTabs": [{
                    "id": "t1", "workspaceId": "ws-1",
                    "extraIds": ["t2", "t3"], "splitDir": "h"
                }]
            })
            .to_string(),
        )
        .unwrap();
        let mgr = AppStateManager::new(path.clone());
        let st = mgr.get_state();
        assert_eq!(st.open_tabs.len(), 1);
        let tab = &st.open_tabs[0];
        assert_eq!(tab.id, "t1");
        let tree = tab.split_tree.as_ref().unwrap();
        assert_eq!(
            crate::split_tree::leaf_ids(tree),
            vec!["t1".to_string(), "t2".to_string(), "t3".to_string()]
        );
        assert!(matches!(tree, PaneNode::Split { dir: Dir::H, .. }));
        cleanup(&path);
    }

    #[test]
    fn test_blank_title_dropped() {
        let path = temp_path("blank-title");
        fs::write(
            &path,
            serde_json::json!({
                "version": 5,
                "openTabs": [
                    { "id": "t1", "workspaceId": "ws-1", "title": "   " },
                    { "id": "t2", "workspaceId": "ws-1", "title": "real" }
                ]
            })
            .to_string(),
        )
        .unwrap();
        let mgr = AppStateManager::new(path.clone());
        let st = mgr.get_state();
        assert_eq!(st.open_tabs[0].title, None);
        assert_eq!(st.open_tabs[1].title.as_deref(), Some("real"));
        cleanup(&path);
    }

    /* forward-only: old bentomux.json never loses data on an upgrade */
    #[test]
    fn test_older_version_adopts_user_data() {
        let path = temp_path("v4");
        fs::write(
            &path,
            serde_json::json!({
                "version": 4,
                "workspaces": [{ "id": "w1", "path": "/x", "name": "x" }],
                "prefs": { "theme": "dark" },
                "shadow": {}
            })
            .to_string(),
        )
        .unwrap();
        let mgr = AppStateManager::new(path.clone());
        let st = mgr.get_state();
        assert_eq!(st.workspaces.len(), 1);
        assert_eq!(st.prefs.theme.as_deref(), Some("dark"));
        /* new fields arrive with their defaults */
        assert_eq!(st.prefs.palette.as_deref(), Some("default"));
        assert!(st.agents.is_empty());
        cleanup(&path);
    }

    /* palettes renamed before the rebrand: map stale values over */
    #[test]
    fn test_palette_rename() {
        let path = temp_path("palette");
        fs::write(
            &path,
            serde_json::json!({
                "version": 5,
                "prefs": { "palette": "takora" }
            })
            .to_string(),
        )
        .unwrap();
        let mgr = AppStateManager::new(path.clone());
        assert_eq!(mgr.get_state().prefs.palette.as_deref(), Some("default"));

        fs::write(
            &path,
            serde_json::json!({
                "version": 5,
                "prefs": { "palette": "pixel" }
            })
            .to_string(),
        )
        .unwrap();
        let mgr = AppStateManager::new(path);
        assert_eq!(mgr.get_state().prefs.palette.as_deref(), Some("classic"));
    }

    /* custom palette colors survive a save/load round trip; an older file
       without them loads with the field absent */
    #[test]
    fn test_custom_palette_roundtrip() {
        let path = temp_path("custom-palette");
        let mut mgr = AppStateManager::new(path.clone());
        mgr.patch_state_sync(|s| {
            s.prefs.palette = Some("custom".to_string());
            s.prefs.custom_palette = Some(CustomPalette {
                bg: "#11161d".to_string(),
                ink: "rgb(230, 237, 243)".to_string(),
                accent: "#58a6ff".to_string(),
            });
        });
        let reloaded = AppStateManager::new(path.clone()).get_state();
        assert_eq!(reloaded.prefs.palette.as_deref(), Some("custom"));
        assert_eq!(
            reloaded.prefs.custom_palette,
            Some(CustomPalette {
                bg: "#11161d".to_string(),
                ink: "rgb(230, 237, 243)".to_string(),
                accent: "#58a6ff".to_string(),
            })
        );

        fs::write(
            &path,
            serde_json::json!({ "version": 5, "prefs": { "palette": "custom" } }).to_string(),
        )
        .unwrap();
        assert!(AppStateManager::new(path.clone())
            .get_state()
            .prefs
            .custom_palette
            .is_none());
        cleanup(&path);
    }

    #[test]
    fn test_snapshot_set_and_remove() {
        let path = temp_path("shadow");
        let mgr = AppStateManager::new(path.clone());
        let snap = ResourceSnapshot {
            kind: ResourceKind::Skills,
            name: "review".into(),
            updated_at: 42,
            data: serde_json::json!({ "instructions": "hi" })
                .as_object()
                .unwrap()
                .clone(),
        };
        mgr.set_snapshot("claude", ResourceKind::Skills, "review", Some(snap));
        assert!(mgr.shadow_for("claude").contains_key(&ResourceKind::Skills));
        assert_eq!(
            mgr.get_state().shadow["claude"][&ResourceKind::Skills]["review"].name,
            "review"
        );

        mgr.set_snapshot("claude", ResourceKind::Skills, "review", None);
        assert!(mgr.shadow_for("claude").is_empty());
        /* empty branches are pruned, not left behind */
        assert!(!mgr.get_state().shadow.contains_key("claude"));
        cleanup(&path);
    }

    /* A store written by an older build must come back stamped with the
    current version, or every save writes the old number back and the
    migration path re-runs forever. */
    #[test]
    fn test_adopting_an_old_store_stamps_the_current_version() {
        let path = temp_path("version-stamp");
        fs::write(
            &path,
            serde_json::json!({ "version": 3, "workspaces": [] }).to_string(),
        )
        .unwrap();

        let mgr = AppStateManager::new(path.clone());
        assert_eq!(mgr.get_state().version, 6, "in memory");
        /* and on disk, after any mutation */
        mgr.patch_prefs(|p| p.theme = Some("dark".into()));
        mgr.flush();
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["version"], 6, "persisted");
        cleanup(&path);
    }

    /* broken/missing files must not take the app down: defaults win */
    #[test]
    fn test_unreadable_file_falls_back_to_defaults() {
        let path = temp_path("broken");
        fs::write(&path, "not json at all {{{").unwrap();
        let mgr = AppStateManager::new(path.clone());
        let st = mgr.get_state();
        assert_eq!(st.version, 6);
        assert!(st.workspaces.is_empty());
        cleanup(&path);
    }

    /* v5 stores predate the plugin platform; they must adopt forward-only */
    #[test]
    fn test_v5_store_gains_an_empty_plugin_registry() {
        let path = temp_path("v5-plugins");
        fs::write(
            &path,
            serde_json::json!({
                "version": 5,
                "workspaces": [{ "id": "w1", "path": "/x", "name": "x" }]
            })
            .to_string(),
        )
        .unwrap();
        let mgr = AppStateManager::new(path.clone());
        let st = mgr.get_state();
        assert_eq!(st.workspaces.len(), 1, "user data survives the bump");
        assert!(
            st.plugins.is_empty(),
            "the registry arrives empty, not missing"
        );
        cleanup(&path);
    }

    /* a window too small to be the real one (e.g. saved while it was being
    configured) must not be restored */
    #[test]
    fn test_window_bounds_usability_guard() {
        let saved = WindowBounds {
            x: 40.0,
            y: 40.0,
            w: 1400.0,
            h: 900.0,
            maximized: false,
        };
        assert!(saved.is_usable());
        assert!(!WindowBounds { w: 899.0, ..saved.clone() }.is_usable());
        assert!(!WindowBounds { h: 599.0, ..saved }.is_usable());
    }

    /* JSON on disk must match the Electron camelCase contract exactly */
    #[test]
    fn test_json_shape_is_camel_case() {
        let path = temp_path("shape");
        let mgr = AppStateManager::new(path.clone());
        mgr.patch_state(|s| {
            s.open_tabs.push(TabRec {
                id: "t1".into(),
                workspace_id: "ws-1".into(),
                split_tree: Some(leaf_node("t1")),
                title: Some("dev".into()),
            });
        });
        mgr.flush();
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let tab = &raw["openTabs"][0];
        assert_eq!(tab["workspaceId"], "ws-1");
        assert_eq!(tab["title"], "dev");
        assert!(tab.get("split_tree").is_none()); /* only camelCase splitTree */
        assert!(tab["splitTree"].is_object());
        assert_eq!(raw["activeWorkspaceId"], serde_json::Value::Null);
        cleanup(&path);
    }
}
