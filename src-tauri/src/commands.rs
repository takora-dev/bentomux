/* ---------------- IPC command surface (the only bridge into the backend) ----------------
Rust port of src/main/ipc.ts + workspaces.ts. Commands keep the camelCase
names the Electron preload used (get_state, workspace_add, tab_create,
...) so the renderer's invoke() calls map 1:1 without a rename layer.
Phases 5-9 bodies (git/agents/bridge/remote) are wired in their own
phases; git + agent shims compile in already. */

use tauri::Emitter;
use tauri::Manager;
use tauri::State;

use crate::pty::PtyManager;
use crate::split_tree::{
    first_leaf_id, leaf_ids, leaf_node, new_node_key, remove_leaf, set_split_dir, split_leaf,
    tree_has_key, tree_has_leaf, Dir, PaneNode,
};
use crate::state::{
    AppState, AppStateManager, CustomPalette, OverlaySize, Prefs, RemotePrefs, TabRec,
    WorkspaceRec,
};
use std::collections::HashMap;

/* the renderer can address any tab by any of its pane ids */
const MAX_PANES: usize = 8;

fn tree_of(r: &TabRec) -> PaneNode {
    r.split_tree.clone().unwrap_or_else(|| leaf_node(&r.id))
}

fn rec_with_tree(r: &TabRec, tree: Option<PaneNode>) -> TabRec {
    match tree {
        None | Some(PaneNode::Leaf { .. }) => TabRec {
            id: match tree {
                Some(PaneNode::Leaf { id }) => id,
                _ => r.id.clone(),
            },
            workspace_id: r.workspace_id.clone(),
            split_tree: None,
            title: r.title.clone(),
        },
        Some(split @ PaneNode::Split { .. }) => TabRec {
            id: first_leaf_id(&split).to_string(),
            workspace_id: r.workspace_id.clone(),
            split_tree: Some(split),
            title: r.title.clone(),
        },
    }
}

fn find_rec_by_pane<'a>(state: &'a AppState, pane_id: &str) -> Option<&'a TabRec> {
    state
        .open_tabs
        .iter()
        .find(|r| tree_has_leaf(&tree_of(r), pane_id))
}

fn normalized_path(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).to_string()
}

/* every mutation through the manager persists automatically */

#[tauri::command]
pub fn get_state(state: State<'_, AppStateManager>) -> AppState {
    state.get_state()
}

/* merge a partial Prefs over the current one; omitted fields keep their value */
#[tauri::command]
pub fn prefs_update(partial: serde_json::Value, state: State<'_, AppStateManager>) -> AppState {
    state.patch_prefs(|cur| merge_prefs(cur, &partial))
}

fn merge_prefs(cur: &mut Prefs, p: &serde_json::Value) {
    let obj = p.as_object();
    if obj.is_none() {
        return;
    }
    let obj = obj.unwrap();

    // Handle font specially: explicit null clears it
    if let Some(font_val) = obj.get("font") {
        cur.font = if font_val.is_null() {
            None
        } else {
            font_val.as_str().map(|s| s.to_string())
        };
    }

    // Other fields: only update if present and non-null
    if let Some(v) = obj.get("theme").and_then(|v| v.as_str()) {
        cur.theme = Some(v.to_string());
    }
    if let Some(v) = obj.get("palette").and_then(|v| v.as_str()) {
        cur.palette = Some(v.to_string());
    }
    if let Some(v) = obj.get("fontSize").and_then(|v| v.as_f64()) {
        cur.font_size = Some(v);
    }
    if let Some(v) = obj.get("shell").and_then(|v| v.as_str()) {
        cur.shell = Some(v.to_string());
    }
    if let Some(v) = obj.get("paneHidden").and_then(|v| v.as_bool()) {
        cur.pane_hidden = Some(v);
    }
    if let Some(v) = obj.get("sidebarWidth").and_then(|v| v.as_f64()) {
        cur.sidebar_width = Some(v);
    }
    if let Some(v) = obj.get("notifEnabled").and_then(|v| v.as_bool()) {
        cur.notif_enabled = Some(v);
    }
    if let Some(v) = obj.get("notifSound").and_then(|v| v.as_bool()) {
        cur.notif_sound = Some(v);
    }

    // Complex fields
    if let Some(v) = obj.get("shortcuts") {
        if let Ok(m) = serde_json::from_value::<HashMap<String, String>>(v.clone()) {
            cur.shortcuts = Some(m);
        }
    }
    if let Some(v) = obj.get("expanded") {
        if let Ok(m) = serde_json::from_value::<HashMap<String, bool>>(v.clone()) {
            cur.expanded = Some(m);
        }
    }
    if let Some(v) = obj.get("tabTitles") {
        if let Ok(m) = serde_json::from_value::<HashMap<String, String>>(v.clone()) {
            cur.tab_titles = Some(m);
        }
    }
    if let Some(v) = obj.get("recentFolders") {
        if let Ok(l) = serde_json::from_value::<Vec<String>>(v.clone()) {
            cur.recent_folders = Some(l);
        }
    }
    if let Some(v) = obj.get("approvalOverlay") {
        if let Ok(s) = serde_json::from_value::<OverlaySize>(v.clone()) {
            cur.approval_overlay = Some(s);
        }
    }
    if let Some(v) = obj.get("remote") {
        if let Ok(r) = serde_json::from_value::<RemotePrefs>(v.clone()) {
            cur.remote = Some(r);
        }
    }
    if let Some(v) = obj.get("customPalette") {
        if let Ok(c) = serde_json::from_value::<CustomPalette>(v.clone()) {
            cur.custom_palette = Some(c);
        }
    }
}

/* ---------------- workspaces ---------------- */

/* the "Recent Folder" submenu is capped so the list stays scannable */
const MAX_RECENT_FOLDERS: usize = 8;

/* newest first, no case-insensitive duplicates, folders that vanished from
disk pruned. Called from workspace_add so every path that opens a folder
(sidebar menu, compact button, welcome CTA, plugin facade) is recorded. */
fn remember_recent(prefs: &mut Prefs, path: &str) {
    let norm = normalized_path(path);
    let mut list: Vec<String> = prefs
        .recent_folders
        .take()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| normalized_path(p).to_lowercase() != norm.to_lowercase())
        .filter(|p| std::path::Path::new(p).is_dir())
        .collect();
    list.insert(0, norm);
    list.truncate(MAX_RECENT_FOLDERS);
    prefs.recent_folders = Some(list);
}

/* native folder picker; returns the absolute path of the chosen folder or
null when the user cancels. rfd opens its own OS dialog (no Tauri
plugin/capability required). Blocking here is fine — the renderer awaits
the response the same way it awaited Electron's dialog.showOpenDialog. */
#[tauri::command]
pub fn workspace_choose() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Add workspace folder")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn workspace_add(path: String, state: State<'_, AppStateManager>) -> AppState {
    let norm = normalized_path(&path);
    let existing = state
        .get_state()
        .workspaces
        .iter()
        .find(|w| w.path.to_lowercase() == norm.to_lowercase())
        .cloned();
    if let Some(ws) = existing {
        let ws_id = ws.id;
        return state.patch_state(|s| {
            remember_recent(&mut s.prefs, &norm);
            s.active_workspace_id = Some(ws_id);
        });
    }
    let id = format!(
        "ws-{}{:0>3}",
        crate::split_tree::to_base36(chrono::Utc::now().timestamp_millis().max(0) as u64),
        crate::split_tree::to_base36(rand::random::<u32>() as u64 % 36u64.pow(3))
    );
    let name = std::path::Path::new(&norm)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Workspace")
        .to_string();
    let ws_id = id.clone();
    // git watcher + branch hook wired in Phase 5 (git.rs).
    crate::git::watch_workspace(&id, &norm);
    state.patch_state(|s| {
        s.workspaces.push(WorkspaceRec {
            id,
            path: norm.clone(),
            name,
        });
        s.active_workspace_id = Some(ws_id);
        remember_recent(&mut s.prefs, &norm);
    })
}

#[tauri::command]
pub fn workspace_remove(
    id: String,
    state: State<'_, AppStateManager>,
    pty: State<'_, PtyManager>,
) -> AppState {
    pty.kill_terms_for_workspace(&id);
    crate::git::unwatch_workspace(&id);
    state.patch_state(|s| {
        s.workspaces.retain(|w| w.id != id);
        s.open_tabs.retain(|t| t.workspace_id != id);
        if s.active_workspace_id.as_deref() == Some(id.as_str()) {
            s.active_workspace_id = None;
        }
    })
}

/* the renderer sends the full workspace-id order after a drag & drop;
anything but an exact permutation of the current ids is rejected */
#[tauri::command]
pub fn workspace_reorder(ids: Vec<String>, state: State<'_, AppStateManager>) -> AppState {
    let cur = state.get_state();
    if ids.len() != cur.workspaces.len() {
        return cur;
    }
    let by_id: std::collections::HashMap<_, _> = cur
        .workspaces
        .iter()
        .map(|w| (w.id.clone(), w.clone()))
        .collect();
    let mut ordered = Vec::with_capacity(ids.len());
    for id in &ids {
        match by_id.get(id) {
            Some(ws) => ordered.push(ws.clone()),
            None => return cur, /* not a permutation: reject the whole move */
        }
    }
    state.patch_state(|s| s.workspaces = ordered)
}

#[tauri::command]
pub fn tab_reorder(ids: Vec<String>, state: State<'_, AppStateManager>) -> AppState {
    let cur = state.get_state();
    if ids.len() != cur.open_tabs.len() {
        return cur;
    }
    let by_id: HashMap<_, _> = cur
        .open_tabs
        .iter()
        .map(|t| (t.id.clone(), t.clone()))
        .collect();
    let mut seen = std::collections::HashSet::with_capacity(ids.len());
    let mut ordered = Vec::with_capacity(ids.len());
    for id in &ids {
        if !seen.insert(id) {
            return cur;
        }
        match by_id.get(id) {
            Some(tab) => ordered.push(tab.clone()),
            None => return cur,
        }
    }
    state.patch_state(|s| s.open_tabs = ordered)
}

#[tauri::command]
pub fn workspace_active(id: Option<String>, state: State<'_, AppStateManager>) -> AppState {
    if state.get_state().active_workspace_id != id {
        state.patch_state(|s| s.active_workspace_id = id);
    }
    state.get_state()
}

/* ---------------- terminal tabs ---------------- */

fn create_tab(
    workspace_id: &str,
    state: &State<'_, AppStateManager>,
    pty: &State<'_, PtyManager>,
) -> Result<TabRec, String> {
    let ws = state
        .get_state()
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .cloned()
        .ok_or_else(|| "Unknown workspace".to_string())?;
    crate::git::watch_workspace(&ws.id, &ws.path); /* idempotent */
    /* resolve the shell from live prefs so a settings change applies to the next pane */
    let pref = state.get_state().prefs.shell.clone();
    let term_id = pty.create_term(&ws.id, &ws.path, pref.as_deref())?;
    /* inherit the workspace's last custom title so a closed tab's name survives */
    let inherited = state
        .get_state()
        .prefs
        .tab_titles
        .as_ref()
        .and_then(|m| m.get(workspace_id))
        .cloned();
    state.patch_state(|s| {
        s.open_tabs.push(TabRec {
            id: term_id.clone(),
            workspace_id: workspace_id.to_string(),
            split_tree: None,
            title: inherited.clone(),
        });
    });
    Ok(TabRec {
        id: term_id,
        workspace_id: workspace_id.to_string(),
        split_tree: None,
        title: inherited,
    })
}

#[tauri::command]
pub fn tab_restore(state: State<'_, AppStateManager>, pty: State<'_, PtyManager>) -> Vec<TabRec> {
    let (workspaces, open_tabs) = {
        let s = state.get_state();
        (s.workspaces, s.open_tabs)
    };
    /* start git HEAD watchers for every persisted workspace; without this
    a restored session never receives branch-change events because
    watch_workspace is only called on workspace_add / tab_create / tab_split */
    for ws in &workspaces {
        crate::git::watch_workspace(&ws.id, &ws.path);
    }
    let created = pty.restore_terms(&workspaces, &open_tabs);
    state.patch_state(|s| s.open_tabs = created.clone());
    created
}

#[tauri::command]
pub fn tab_create(
    workspace_id: String,
    state: State<'_, AppStateManager>,
    pty: State<'_, PtyManager>,
) -> Result<TabRec, String> {
    create_tab(&workspace_id, &state, &pty)
}

#[tauri::command]
pub fn tab_split(
    pane_id: String,
    dir: Option<String>,
    key: Option<String>,
    state: State<'_, AppStateManager>,
    pty: State<'_, PtyManager>,
) -> Result<TabRec, String> {
    let (rec, ws) = {
        let s = state.get_state();
        let rec = find_rec_by_pane(&s, &pane_id)
            .cloned()
            .ok_or_else(|| "Unknown tab".to_string())?;
        if leaf_ids(&tree_of(&rec)).len() >= MAX_PANES {
            return Err("Pane limit reached".to_string());
        }
        let ws = s
            .workspaces
            .iter()
            .find(|w| w.id == rec.workspace_id)
            .cloned()
            .ok_or_else(|| "Unknown workspace".to_string())?;
        (rec, ws)
    };
    crate::git::watch_workspace(&ws.id, &ws.path); /* idempotent */
    let pref = state.get_state().prefs.shell.clone();
    let term_id = pty.create_term(&ws.id, &ws.path, pref.as_deref())?;
    let tree = split_leaf(
        tree_of(&rec),
        &pane_id,
        if dir.as_deref() == Some("h") {
            Dir::H
        } else {
            Dir::V
        },
        &term_id,
        &key.unwrap_or_else(new_node_key),
    );
    state.patch_state(|s| {
        s.open_tabs = s
            .open_tabs
            .iter()
            .map(|r| {
                if r == &rec {
                    rec_with_tree(r, Some(tree.clone()))
                } else {
                    r.clone()
                }
            })
            .collect();
    });
    Ok(TabRec {
        id: term_id,
        workspace_id: rec.workspace_id,
        split_tree: None,
        title: rec.title,
    })
}

#[tauri::command]
pub fn tab_rename(pane_id: String, raw_title: String, state: State<'_, AppStateManager>) {
    let rec = find_rec_by_pane(&state.get_state(), &pane_id).cloned();
    let Some(rec) = rec else { return };
    let title = raw_title.trim().to_string();
    let workspace_id = rec.workspace_id.clone();
    let tab_id = rec.id.clone();
    state.patch_state(|s| {
        s.open_tabs = s
            .open_tabs
            .iter()
            .map(|r| {
                if r.id != tab_id {
                    return r.clone();
                }
                let mut out = r.clone();
                out.title = if title.is_empty() {
                    None
                } else {
                    Some(title.clone())
                };
                out
            })
            .collect();
        let titles = s
            .prefs
            .tab_titles
            .get_or_insert_with(std::collections::HashMap::new);
        if title.is_empty() {
            titles.remove(&workspace_id);
        } else {
            titles.insert(workspace_id, title);
        }
    });
}

#[tauri::command]
pub fn tab_set_dir(node_key: String, dir: String, state: State<'_, AppStateManager>) {
    let d = if dir == "h" { Dir::H } else { Dir::V };
    let rec = state
        .get_state()
        .open_tabs
        .iter()
        .find(|r| {
            r.split_tree
                .as_ref()
                .is_some_and(|t| tree_has_key(t, &node_key))
        })
        .cloned();
    let Some(rec) = rec else { return };
    let tab_id = rec.id.clone();
    let Some(tree) = rec.split_tree.clone() else {
        return;
    };
    let new_tree = set_split_dir(tree, &node_key, d);
    state.patch_state(|s| {
        s.open_tabs = s
            .open_tabs
            .iter()
            .map(|r| {
                if r.id == tab_id {
                    TabRec {
                        split_tree: Some(new_tree.clone()),
                        ..r.clone()
                    }
                } else {
                    r.clone()
                }
            })
            .collect();
    });
}

#[tauri::command]
pub fn tab_close_pane(
    pane_id: String,
    state: State<'_, AppStateManager>,
    pty: State<'_, PtyManager>,
) -> AppState {
    let cur = state.get_state();
    pty.kill_term(&pane_id);
    let rec = find_rec_by_pane(&cur, &pane_id).cloned();
    match rec {
        Some(rec) => {
            let tab_id = rec.id.clone();
            let mut open_tabs = cur.open_tabs.clone();
            let mut dropped_tab = false;
            for r in open_tabs.iter_mut() {
                if r.id != tab_id {
                    continue;
                }
                let tree = remove_leaf(tree_of(r), &pane_id);
                match tree {
                    Some(t) => {
                        let updated = rec_with_tree(r, Some(t));
                        *r = updated;
                    }
                    None => dropped_tab = true, /* last pane gone: drop the tab */
                }
                break;
            }
            if dropped_tab {
                open_tabs.retain(|r| r.id != tab_id);
            }
            state.patch_state(|s| s.open_tabs = open_tabs);
            state.get_state()
        }
        None => {
            /* not a tab: wipe any leftover record matching the pane id directly */
            state.patch_state(|s| {
                s.open_tabs
                    .retain(|t| t.id != pane_id && t.workspace_id != pane_id)
            });
            state.get_state()
        }
    }
}

#[tauri::command]
pub fn tab_close(
    id: String,
    state: State<'_, AppStateManager>,
    pty: State<'_, PtyManager>,
) -> AppState {
    let cur = state.get_state();
    let rec = find_rec_by_pane(&cur, &id).cloned();
    match rec {
        Some(rec) => {
            let tab_id = rec.id.clone();
            for leaf in leaf_ids(&tree_of(&rec)) {
                pty.kill_term(&leaf);
            }
            state.patch_state(|s| s.open_tabs.retain(|t| t.id != tab_id));
            state.get_state()
        }
        None => {
            pty.kill_term(&id);
            state.patch_state(|s| s.open_tabs.retain(|t| t.id != id));
            state.get_state()
        }
    }
}

#[tauri::command]
pub fn pty_write(id: String, data: String, pty: State<'_, PtyManager>) -> Result<(), String> {
    pty.write_term(&id, &data)
}

#[tauri::command]
pub fn pty_resize(
    id: String,
    cols: u16,
    rows: u16,
    pty: State<'_, PtyManager>,
) -> Result<(), String> {
    pty.resize_term(&id, cols, rows)
}

/* ---------------- git ---------------- */

/* every git op shells out and blocks (`status -uall` walks the whole worktree,
`push` waits on the network for up to 120s). A non-async #[tauri::command]
runs on the app main thread, so the WebView froze until git returned; these
hop to the blocking pool instead and the renderer paints its loading state
while the invoke is in flight. */
async fn git_off_main<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("git task failed: {}", e))
}

#[tauri::command]
pub async fn git_status(
    workspace_id: String,
    state: State<'_, AppStateManager>,
) -> Result<crate::git::GitStatusResult, String> {
    let path = workspace_path(&workspace_id, &state)?;
    git_off_main(move || crate::git::status(&path)).await
}

#[tauri::command]
pub async fn git_diff(
    workspace_id: String,
    path: Option<String>,
    state: State<'_, AppStateManager>,
) -> Result<crate::git::GitDiffResult, String> {
    let ws_path = workspace_path(&workspace_id, &state)?;
    git_off_main(move || crate::git::diff(&ws_path, path.as_deref())).await
}

#[tauri::command]
pub async fn git_diff_stat(
    workspace_id: String,
    state: State<'_, AppStateManager>,
) -> Result<crate::git::GitDiffStatResult, String> {
    let path = workspace_path(&workspace_id, &state)?;
    git_off_main(move || crate::git::diff_stat(&path)).await
}

#[tauri::command]
pub async fn git_push(
    workspace_id: String,
    set_upstream: bool,
    state: State<'_, AppStateManager>,
) -> Result<crate::git::GitCommandResult, String> {
    let path = workspace_path(&workspace_id, &state)?;
    git_off_main(move || crate::git::push(&path, set_upstream)).await
}

#[tauri::command]
pub async fn git_remote_info(
    workspace_id: String,
    state: State<'_, AppStateManager>,
) -> Result<crate::git::GitRemoteInfo, String> {
    let path = workspace_path(&workspace_id, &state)?;
    git_off_main(move || crate::git::remote_info(&path)).await
}

#[tauri::command]
pub async fn git_history(
    workspace_id: String,
    state: State<'_, AppStateManager>,
) -> Result<crate::git::GitHistoryResult, String> {
    let path = workspace_path(&workspace_id, &state)?;
    git_off_main(move || crate::git::history(&path)).await
}

#[tauri::command]
pub async fn git_show(
    workspace_id: String,
    oid: String,
    state: State<'_, AppStateManager>,
) -> Result<crate::git::GitCommitDetail, String> {
    let path = workspace_path(&workspace_id, &state)?;
    /* `detail` is the one git reader that returns a Result, so the two layers of
    error are flattened here rather than swallowed */
    git_off_main(move || crate::git::detail(&path, &oid)).await?
}

#[tauri::command]
pub fn git_branch_for(path: String) -> Result<Option<String>, String> {
    crate::git::branch_for(&path)
}

fn workspace_path(
    workspace_id: &str,
    state: &State<'_, AppStateManager>,
) -> Result<String, String> {
    state
        .get_state()
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .map(|w| w.path.clone())
        .ok_or_else(|| format!("Unknown workspace: {}", workspace_id))
}

/* ---------------- agents (bodies land in Phase 6) ---------------- */

use crate::state::AgentInfo;

#[tauri::command]
pub fn agents_list(state: State<'_, AppStateManager>) -> Vec<AgentInfo> {
    let list = crate::runtime::agents_info(&state.get_state().workspaces);
    state.patch_state(|s| s.agents = list.clone());
    list
}

#[tauri::command]
pub fn agents_config(
    agent_id: String,
    state: State<'_, AppStateManager>,
) -> crate::runtime::AgentConfigView {
    crate::runtime::agent_config_view(&state.get_state().workspaces, &agent_id).unwrap_or_default()
}

#[tauri::command]
pub fn agents_set_model_settings(
    agent_id: String,
    patch: crate::runtime::ModelSettingsPatch,
    state: State<'_, AppStateManager>,
) -> crate::runtime::AgentConfigView {
    let workspaces = state.get_state().workspaces.clone();
    let view = crate::runtime::set_agent_model_settings(&workspaces, &agent_id, patch)
        .unwrap_or_else(|_| crate::runtime::AgentConfigView::default());
    let list = crate::runtime::agents_info(&state.get_state().workspaces);
    state.patch_state(|s| s.agents = list);
    view
}

#[tauri::command]
pub fn agent_hooks_status() -> crate::runtime::AgentHooksStatus {
    crate::runtime::agent_hooks_status()
}

/* the hook CLI is unpacked next to the binary as a Tauri resource; Node
itself is guaranteed on the machine because Claude Code requires it */
#[tauri::command]
pub fn agent_hooks_install(app: tauri::AppHandle) -> crate::runtime::AgentHooksStatus {
    crate::runtime::agent_hooks_install(&crate::bridge::hook_script_path(&app))
}

#[tauri::command]
pub fn agent_hooks_uninstall() -> crate::runtime::AgentHooksStatus {
    crate::runtime::agent_hooks_uninstall()
}

/* ---------- agent approval decisions ---------- */

#[tauri::command]
pub fn agent_approval_resolve(request_id: String, decision: String) -> bool {
    if request_id.is_empty() {
        return false;
    }
    match decision.as_str() {
        "allow" => crate::bridge::resolve_approval(&request_id, true),
        "deny" => crate::bridge::resolve_approval(&request_id, false),
        _ => false,
    }
}

#[tauri::command]
pub fn agent_approval_pending() -> Option<crate::bridge::AgentApprovalRequest> {
    crate::bridge::pending_approval()
}

/* overlay Jump: hide the approval window first, then explicitly foreground
Bentomux so the click cannot leave the always-on-top overlay in front. */
#[tauri::command]
pub fn agent_approval_jump(app: tauri::AppHandle, pane_id: Option<String>, cwd: Option<String>) {
    if let Some(overlay) = app.get_webview_window("approval-overlay") {
        let _ = overlay.set_always_on_top(false);
        let _ = overlay.hide();
    }
    if let Some(w) = app.get_webview_window("main") {
        if w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
        }
        let _ = w.show();
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
        let _ = w.set_always_on_top(false);
    }
    let notice = crate::bridge::AgentEventNotice {
        kind: "jump".into(),
        pane_id,
        agent: "claude".into(),
        message: String::new(),
        cwd,
        session_id: None,
    };
    let retry_app = app.clone();
    let retry_notice = notice.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        if let Some(w) = retry_app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
        }
        let _ = retry_app.emit_to("main", "agent:event", &retry_notice);
    });
    let _ = app.emit_to("main", "agent:event", &notice);
}

#[tauri::command]
pub fn agent_approval_hide(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("approval-overlay") {
        let _ = w.hide();
    }
}

/* report the active terminal tab's anchor pane so the approval overlay
can stay hidden while that tab is on screen */
#[tauri::command]
pub fn agent_set_active_tab(tab_id: Option<String>) {
    crate::bridge::set_active_tab_anchor(tab_id);
}

/* ---------------- resources (memory / skills / MCP) ---------------- */

#[tauri::command]
pub fn res_list(
    kind: crate::state::ResourceKind,
    state: State<'_, AppStateManager>,
) -> Vec<crate::agents::resources::ResourceItem> {
    let workspaces = state.get_state().workspaces.clone();
    crate::agents::resources::list_resources(&workspaces, kind, &state)
}

#[tauri::command]
pub fn res_save(
    payload: crate::agents::resources::ResourceSavePayload,
    state: State<'_, AppStateManager>,
) -> Result<Vec<crate::agents::resources::ResourceItem>, String> {
    let workspaces = state.get_state().workspaces.clone();
    crate::agents::resources::save_resource(&workspaces, payload, &state)
}

#[tauri::command]
pub fn res_delete(
    kind: crate::state::ResourceKind,
    id: String,
    state: State<'_, AppStateManager>,
) -> Vec<crate::agents::resources::ResourceItem> {
    let workspaces = state.get_state().workspaces.clone();
    crate::agents::resources::delete_resource(&workspaces, kind, id, &state)
}

#[tauri::command]
pub fn res_toggle(
    kind: crate::state::ResourceKind,
    id: String,
    on: bool,
    state: State<'_, AppStateManager>,
) -> Vec<crate::agents::resources::ResourceItem> {
    let workspaces = state.get_state().workspaces.clone();
    crate::agents::resources::toggle_resource(&workspaces, kind, id, on, &state)
}

/* ---------------- remote monitor (phone browser) ---------------- */

#[tauri::command]
pub fn remote_info(
    _app: tauri::AppHandle,
    state: State<'_, AppStateManager>,
) -> crate::remote::RemotePairing {
    crate::remote::pairing_info(&state)
}

#[tauri::command]
pub fn remote_set_enabled(
    app: tauri::AppHandle,
    on: bool,
    state: State<'_, AppStateManager>,
) -> crate::remote::RemotePairing {
    crate::remote::set_remote_enabled(&app, &state, on)
}

#[tauri::command]
pub fn remote_set_port(
    app: tauri::AppHandle,
    port: u16,
    state: State<'_, AppStateManager>,
) -> crate::remote::RemotePairing {
    crate::remote::set_remote_port(&app, &state, port)
}

/* ---------------- window chrome ---------------- */

#[tauri::command]
pub fn win_minimize(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn win_toggle_maximize(window: tauri::Window, app: tauri::AppHandle) {
    let now_max = !window.is_maximized().unwrap_or(false);
    let _ = if now_max {
        window.maximize()
    } else {
        window.unmaximize()
    };
    /* keep the shared maximize-state guard in sync so the OS-driven
    Resized handler does not double-emit on the same transition; emit
    directly so programmatic toggles (e.g. the titlebar maxBtn) also
    notify the renderer, mirroring Electron's win.on('maximize'). */
    if let Some(state) = app.try_state::<crate::WindowMaxState>() {
        state.0.store(now_max, std::sync::atomic::Ordering::SeqCst);
    }
    let _ = app.emit("win:maximized", now_max);
}

#[tauri::command]
pub fn win_toggle_fullscreen(window: tauri::Window, app: tauri::AppHandle) {
    let now_full = !window.is_fullscreen().unwrap_or(false);
    let _ = window.set_fullscreen(now_full);
    /* same double-emit guard as win_toggle_maximize: sync the shared
    fullscreen-state guard, then emit so programmatic toggles (Cmd+Ctrl+F)
    notify the renderer immediately. */
    if let Some(state) = app.try_state::<crate::WindowFullState>() {
        state.0.store(now_full, std::sync::atomic::Ordering::SeqCst);
    }
    let _ = app.emit("win:fullscreen", now_full);
}

#[tauri::command]
pub fn win_close(window: tauri::Window) {
    let _ = window.close();
}

/* Quit for real. The default quit deliberately leaves the pty host daemon and
its panes running, so this is the escape hatch for "I want nothing left
behind": stop every pane, stop the daemon, then exit the app. */
#[tauri::command]
pub fn app_quit(stop_panes: bool, pty: State<'_, PtyManager>, app: tauri::AppHandle) {
    if stop_panes {
        pty.shutdown_host();
    }
    app.exit(0);
}

/* Kill cloudflared and the remote HTTP server before the NSIS/MSI installer
overwrites cloudflared.exe, and stop the pty host: on Windows the installer
cannot replace a running exe, and the host is that exe. Called by the
renderer immediately before tauri-plugin-updater's install().

Only Windows needs any of it: the lock is on a file the installer rewrites.
macOS/Linux unlink the old bundle and leave running processes alone, so the
daemon — and every live pane in it — is left running. */
#[tauri::command]
pub fn shutdown_for_update(pty: State<'_, PtyManager>) {
    if !cfg!(target_os = "windows") {
        return;
    }
    pty.shutdown_host();
    crate::remote::stop_tunnel();
    crate::remote::stop_remote();
}

/* Stage pasted clipboard bytes as a temp file and return the absolute path.
A WebView hands the renderer clipboard files without any filesystem path,
so copying the bytes out is the only way a pasted screenshot or file
becomes something the shell/agent can actually open. The renderer sends
the clipboard's own filename so the extension survives. */
const CLIPBOARD_TEMP_PREFIX: &str = "bentomux-clipboard-";
const CLIPBOARD_TEMP_MAX_AGE: std::time::Duration =
    std::time::Duration::from_secs(7 * 24 * 60 * 60);

pub fn cleanup_clipboard_temp_files() {
    let temp_dir = std::env::temp_dir();
    let cutoff = std::time::SystemTime::now().checked_sub(CLIPBOARD_TEMP_MAX_AGE);
    let Ok(entries) = std::fs::read_dir(temp_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_clipboard_file = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with(CLIPBOARD_TEMP_PREFIX))
            .unwrap_or(false);
        if !is_clipboard_file {
            continue;
        }
        let old_enough = cutoff
            .zip(entry.metadata().ok().and_then(|meta| meta.modified().ok()))
            .map(|(cutoff, modified)| modified < cutoff)
            .unwrap_or(false);
        if old_enough {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tauri::command]
pub fn temp_write_file(name: String, data: String) -> Result<String, String> {
    use std::io::Write;
    let bytes = base64_decode(&data).map_err(|e| e.to_string())?;
    let path = std::env::temp_dir().join(format!(
        "{}{}-{}",
        CLIPBOARD_TEMP_PREFIX,
        rand::random::<u32>(),
        safe_temp_name(&name)
    ));
    std::fs::File::create(&path)
        .and_then(|mut f| f.write_all(&bytes))
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/* the name comes from the OS clipboard, i.e. from outside the app: collapse
path separators so the result can never climb out of the temp dir, and fall
back to a fixed suffix when nothing name-like is left. `create()` may still
reject a Windows-reserved name (CON, NUL, a stray ':'), which surfaces as an
error and makes the renderer paste the bare name instead of a path. */
pub(crate) fn safe_temp_name(name: &str) -> String {
    let flat: String = name
        .chars()
        .map(|c| {
            if std::path::is_separator(c) || c == '\0' {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = flat.trim();
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '.') {
        return "paste.bin".to_string();
    }
    trimmed.chars().take(120).collect()
}

fn base64_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s)
}

#[cfg(test)]
mod tests {
    use super::{remember_recent, safe_temp_name, MAX_RECENT_FOLDERS};
    use crate::state::Prefs;

    #[test]
    fn keeps_extension_and_flattens_traversal() {
        assert_eq!(safe_temp_name("image.png"), "image.png");
        assert_eq!(
            safe_temp_name("Screenshot 2026-09-15 at 12.49.20.png"),
            "Screenshot 2026-09-15 at 12.49.20.png"
        );
        /* separators cannot survive, so the result can never leave temp_dir */
        assert_eq!(safe_temp_name("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(safe_temp_name("/etc/passwd"), "_etc_passwd");
        assert!(!safe_temp_name("../../etc/passwd").contains('/'));
    }

    #[test]
    fn falls_back_and_caps_length() {
        assert_eq!(safe_temp_name(""), "paste.bin");
        assert_eq!(safe_temp_name("..."), "paste.bin");
        assert_eq!(safe_temp_name("report.pdf").len(), 10);
        assert_eq!(safe_temp_name(&"a".repeat(500)).chars().count(), 120);
    }

    /* remember_recent only keeps paths that still exist on disk, so the test
    works against real (temporary) directories. */
    fn temp_dirs(tag: &str, count: usize) -> (std::path::PathBuf, Vec<String>) {
        let root = std::env::temp_dir().join(format!(
            "bentomux-recent-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let dirs = (0..count)
            .map(|i| {
                let dir = root.join(format!("ws{i}"));
                std::fs::create_dir_all(&dir).unwrap();
                dir.to_string_lossy().to_string()
            })
            .collect();
        (root, dirs)
    }

    #[test]
    fn recent_folders_are_newest_first_without_duplicates() {
        let (root, dirs) = temp_dirs("order", 2);
        let mut prefs = Prefs::default();

        remember_recent(&mut prefs, &dirs[0]);
        remember_recent(&mut prefs, &dirs[1]);
        /* re-adding the first folder moves it to the front instead of duplicating */
        remember_recent(&mut prefs, &dirs[0]);

        let list = prefs.recent_folders.clone().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], dirs[0]);
        assert_eq!(list[1], dirs[1]);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn recent_folders_cap_and_prune_missing_dirs() {
        let (root, dirs) = temp_dirs("cap", MAX_RECENT_FOLDERS + 2);
        let mut prefs = Prefs::default();
        for dir in &dirs {
            remember_recent(&mut prefs, dir);
        }
        let list = prefs.recent_folders.clone().unwrap();
        assert_eq!(list.len(), MAX_RECENT_FOLDERS);
        assert_eq!(list[0], dirs[MAX_RECENT_FOLDERS + 1]);

        /* a folder deleted from disk drops out on the next update */
        std::fs::remove_dir_all(&dirs[MAX_RECENT_FOLDERS + 1]).ok();
        remember_recent(&mut prefs, &dirs[0]);
        let list = prefs.recent_folders.clone().unwrap();
        assert!(!list.iter().any(|p| p == &dirs[MAX_RECENT_FOLDERS + 1]));
        assert_eq!(list[0], dirs[0]);
        std::fs::remove_dir_all(root).ok();
    }
}
