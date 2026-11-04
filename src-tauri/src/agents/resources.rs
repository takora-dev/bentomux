/* ---------------- resources orchestrator ----------------
Rust port of src/main/resources.ts. Merges what is materialized in
each agent's real files with what Bentomux keeps in its shadow store
(toggle-off without a native flag), and routes save/toggle/delete to
the right adapters. */

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::state::{AppStateManager, ResourceKind, ResourceSnapshot, ShadowStore, WorkspaceRec};

use super::index;
use super::types::{AgentAdapter, McpDef, MemoryDef, MemoryScope, ResourceDef, SkillDef};
use super::util::{slugify, unique_slug};

/* the renderer-facing resource row */
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResourceItem {
    pub id: String,
    pub kind: ResourceKind,
    pub name: String,
    pub agent_ids: Vec<String>,
    pub status: String,
    pub updated: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_json: Option<String>,
}

/* renderer → saveResource payload */
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSavePayload {
    pub kind: ResourceKind,
    pub id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub agent_ids: Vec<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<Option<String>>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub config_json: Option<String>,
}

struct Rich {
    item: ResourceItem,
    /* agents where the definition is currently materialized in real files */
    live: HashSet<String>,
}

fn blank(kind: ResourceKind, id: String) -> Rich {
    let scope = if kind == ResourceKind::Memory {
        Some("global".to_string())
    } else {
        None
    };
    Rich {
        item: ResourceItem {
            id,
            name: String::new(),
            kind,
            agent_ids: Vec::new(),
            status: "off".to_string(),
            updated: 0,
            scope,
            workspace_path: None,
            content: None,
            description: None,
            instructions: None,
            config_json: None,
        },
        live: HashSet::new(),
    }
}

fn fill_from_entry(
    r: &mut Rich,
    agent_id: &str,
    name: Option<&str>,
    def: &ResourceDef,
    updated_at: u64,
) {
    let it = &mut r.item;
    if !it.agent_ids.iter().any(|a| a == agent_id) {
        it.agent_ids.push(agent_id.to_string());
    }
    if let Some(n) = name {
        if !n.is_empty() && (it.name == it.id || it.name.is_empty()) {
            it.name = n.to_string();
        }
    }
    if updated_at > it.updated {
        it.updated = updated_at;
    }
    r.live.insert(agent_id.to_string());
    match def {
        ResourceDef::Memory(m) => {
            it.scope = Some(if m.scope == MemoryScope::Project {
                "project".to_string()
            } else {
                "global".to_string()
            });
            it.workspace_path = Some(m.workspace_path.clone());
            it.content = Some(m.content.clone());
        }
        ResourceDef::Skill(s) => {
            it.description = Some(s.description.clone());
            it.instructions = Some(s.instructions.clone());
        }
        ResourceDef::Mcp(c) => {
            let json = serde_json::json!({ "command": c.command, "args": c.args, "env": c.env });
            it.config_json = Some(serde_json::to_string_pretty(&json).unwrap_or_default());
        }
    }
}

fn str_from_value(map: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    map.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

fn fill_from_snapshot(r: &mut Rich, agent_id: &str, snap: &ResourceSnapshot) {
    let kind = r.item.kind.clone();
    let it = &mut r.item;
    if !it.agent_ids.iter().any(|a| a == agent_id) {
        it.agent_ids.push(agent_id.to_string());
    }
    if it.name.is_empty() || it.name == it.id {
        it.name = snap.name.clone();
    }
    if snap.updated_at > it.updated {
        it.updated = snap.updated_at;
    }
    let d = &snap.data;
    match kind {
        ResourceKind::Memory => {
            if it.content.is_none() {
                it.content = str_from_value(d, "content");
            }
            if let Some(s) = str_from_value(d, "scope") {
                it.scope = Some(s);
            }
            if it.workspace_path.is_none() {
                it.workspace_path = str_from_value(d, "workspacePath").map(Some);
            }
        }
        ResourceKind::Skills => {
            if it.instructions.is_none() {
                it.instructions = str_from_value(d, "instructions");
            }
            if it.description.is_none() {
                it.description = str_from_value(d, "description");
            }
        }
        ResourceKind::Mcp => {
            if it.config_json.is_none() && d.get("command").is_some() {
                let json = serde_json::json!({
                    "command": str_from_value(d, "command").unwrap_or_default(),
                    "args": d.get("args").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>()).unwrap_or_default(),
                    "env": d.get("env").and_then(|v| v.as_object()).map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect::<HashMap<_, _>>()).unwrap_or_default(),
                });
                it.config_json = Some(serde_json::to_string_pretty(&json).unwrap_or_default());
            }
        }
    }
}

fn caps(a: &dyn AgentAdapter, kind: &ResourceKind) -> bool {
    let c = a.capabilities();
    match kind {
        ResourceKind::Memory => c.memory,
        ResourceKind::Skills => c.skills,
        ResourceKind::Mcp => c.mcp,
    }
}

fn merged(
    kind: ResourceKind,
    adapters: &[Box<dyn AgentAdapter>],
    shadow: &ShadowStore,
) -> Vec<Rich> {
    let mut map: HashMap<String, Rich> = HashMap::new();
    for ad in adapters {
        if !caps(ad.as_ref(), &kind) || !ad.detect() {
            continue;
        }
        for (id, entry) in ad.list(kind.clone()) {
            let r = map
                .entry(id.clone())
                .or_insert_with(|| blank(kind.clone(), id.clone()));
            fill_from_entry(
                r,
                ad.id(),
                entry.name.as_deref(),
                &entry.def,
                entry.updated_at,
            );
        }
    }
    for ad in adapters {
        let snaps = shadow
            .get(ad.id())
            .and_then(|m| m.get(&kind))
            .cloned()
            .unwrap_or_default();
        for (id, snap) in snaps {
            let r = map
                .entry(id.clone())
                .or_insert_with(|| blank(kind.clone(), id.clone()));
            if r.live.contains(ad.id()) {
                continue; /* live copy wins */
            }
            fill_from_snapshot(r, ad.id(), &snap);
        }
    }
    let mut out: Vec<Rich> = map.into_values().collect();
    for r in &mut out {
        r.item.status = if r.live.is_empty() {
            "off".to_string()
        } else {
            "on".to_string()
        };
        /* native-off items keep their files but read as Off */
        for ad in adapters {
            if r.live.contains(ad.id()) && ad.is_natively_off(kind.clone(), r.item.id.clone()) {
                r.item.status = "off".to_string();
                break;
            }
        }
    }
    out.sort_by_key(|e| std::cmp::Reverse(e.item.updated));
    out
}

/* build the canonical ResourceDef an agent's write() should materialize */
fn def_from_build(p: &ResourceSavePayload) -> Result<ResourceDef, String> {
    match p.kind {
        ResourceKind::Memory => {
            let project = p.scope.as_deref() == Some("project");
            Ok(ResourceDef::Memory(MemoryDef {
                scope: if project {
                    MemoryScope::Project
                } else {
                    MemoryScope::Global
                },
                workspace_path: if project {
                    p.workspace_path.as_ref().and_then(|w| w.clone())
                } else {
                    None
                },
                content: p
                    .content
                    .clone()
                    .unwrap_or_default()
                    .replace("\r\n", "\n")
                    .trim()
                    .to_string(),
            }))
        }
        ResourceKind::Skills => {
            let instructions = p
                .instructions
                .clone()
                .unwrap_or_default()
                .replace("\r\n", "\n");
            let description = instructions.trim().chars().take(100).collect::<String>();
            Ok(ResourceDef::Skill(SkillDef {
                description,
                instructions,
            }))
        }
        ResourceKind::Mcp => {
            let raw = p.config_json.clone().unwrap_or_default();
            let obj: serde_json::Value = serde_json::from_str(&raw)
                .map_err(|_| "Configuration must be valid JSON.".to_string())?;
            let command = obj
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if command.trim().is_empty() {
                return Err("Configuration must include a \"command\" string.".to_string());
            }
            let args = obj
                .get("args")
                .map(|v| {
                    v.as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect::<Vec<_>>()
                        })
                        .or_else(|| {
                            v.as_str()
                                .map(|s| s.split_whitespace().map(String::from).collect())
                        })
                        .unwrap_or_default()
                })
                .unwrap_or_default();
            let env = obj
                .get("env")
                .and_then(|v| v.as_object())
                .map(|o| {
                    o.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                        .collect::<HashMap<_, _>>()
                })
                .unwrap_or_default();
            Ok(ResourceDef::Mcp(McpDef { command, args, env }))
        }
    }
}

/* reconstruct a def from an existing ResourceItem (for remove()/toggle) */
fn def_from_item(item: &ResourceItem) -> Option<ResourceDef> {
    match item.kind {
        ResourceKind::Memory => Some(ResourceDef::Memory(MemoryDef {
            scope: if item.scope.as_deref() == Some("project") {
                MemoryScope::Project
            } else {
                MemoryScope::Global
            },
            workspace_path: item.workspace_path.clone().flatten(),
            content: item.content.clone().unwrap_or_default(),
        })),
        ResourceKind::Skills => Some(ResourceDef::Skill(SkillDef {
            description: item.description.clone().unwrap_or_default(),
            instructions: item.instructions.clone().unwrap_or_default(),
        })),
        ResourceKind::Mcp => {
            let raw = item.config_json.as_deref().unwrap_or("");
            serde_json::from_str::<serde_json::Value>(raw)
                .ok()
                .map(|obj| {
                    ResourceDef::Mcp(McpDef {
                        command: obj
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        args: obj
                            .get("args")
                            .and_then(|v| v.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x.as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default(),
                        env: obj
                            .get("env")
                            .and_then(|v| v.as_object())
                            .map(|o| {
                                o.iter()
                                    .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                })
        }
    }
}

fn def_to_data(def: &ResourceDef) -> serde_json::Map<String, serde_json::Value> {
    match def {
        ResourceDef::Memory(m) => {
            let mut o = serde_json::Map::new();
            o.insert(
                "scope".into(),
                serde_json::json!(if m.scope == MemoryScope::Project {
                    "project"
                } else {
                    "global"
                }),
            );
            if let Some(wp) = &m.workspace_path {
                o.insert("workspacePath".into(), serde_json::json!(wp));
            }
            o.insert("content".into(), serde_json::json!(m.content));
            o
        }
        ResourceDef::Skill(s) => {
            let mut o = serde_json::Map::new();
            o.insert("description".into(), serde_json::json!(s.description));
            o.insert("instructions".into(), serde_json::json!(s.instructions));
            o
        }
        ResourceDef::Mcp(c) => {
            serde_json::json!({ "command": c.command, "args": c.args, "env": c.env })
                .as_object()
                .cloned()
                .unwrap_or_default()
        }
    }
}

pub fn list_resources(
    workspaces: &[WorkspaceRec],
    kind: ResourceKind,
    state: &AppStateManager,
) -> Vec<ResourceItem> {
    let adapters = index::all(workspaces);
    let shadow = state.get_state().shadow;
    merged(kind, &adapters, &shadow)
        .into_iter()
        .map(|r| r.item)
        .collect()
}

pub fn save_resource(
    workspaces: &[WorkspaceRec],
    p: ResourceSavePayload,
    state: &AppStateManager,
) -> Result<Vec<ResourceItem>, String> {
    let def = def_from_build(&p)?;
    let adapters = index::all(workspaces);
    let shadow = state.get_state().shadow;
    let current = merged(p.kind.clone(), &adapters, &shadow);
    let taken: HashSet<&str> = current
        .iter()
        .filter(|r| r.item.id != p.id.as_deref().unwrap_or(""))
        .map(|r| r.item.id.as_str())
        .collect();
    let id = match &p.id {
        Some(i) if !i.is_empty() => i.clone(),
        _ => unique_slug(
            &slugify(&p.name),
            &taken.iter().map(|s| s.to_string()).collect(),
        ),
    };

    let prev = current.iter().find(|r| r.item.id == id);
    let prev_agent_ids = prev.map(|r| r.item.agent_ids.clone()).unwrap_or_default();
    let targets: Vec<String> = p
        .agent_ids
        .iter()
        .filter(|a| {
            adapters
                .iter()
                .find(|x| x.id() == *a)
                .map(|x| caps(x.as_ref(), &p.kind))
                .unwrap_or(false)
        })
        .cloned()
        .collect();

    /* unassign agents dropped from the selection */
    for a_id in prev_agent_ids.iter().filter(|a| !targets.contains(a)) {
        let ad = match index::find_adapter(a_id, &adapters) {
            Some(x) => x,
            None => continue,
        };
        if let Some(prev) = prev {
            if let Some(d) = def_from_item(&prev.item) {
                let _ = catch(|| ad.remove(p.kind.clone(), id.clone(), Some(&d)));
            }
        }
        state.set_snapshot(a_id, p.kind.clone(), &id, None);
        ad.native_toggle(p.kind.clone(), id.clone(), true);
    }

    for a_id in &targets {
        let ad = match index::find_adapter(a_id, &adapters) {
            Some(x) => x,
            None => continue,
        };
        let res = catch(|| {
            if p.enabled {
                ad.write(p.kind.clone(), id.clone(), p.name.clone(), def.clone());
                state.set_snapshot(a_id, p.kind.clone(), &id, None);
                ad.native_toggle(p.kind.clone(), id.clone(), true);
            } else if ad.has_native_toggle()
                && ((prev.map(|r| r.live.contains(a_id)).unwrap_or(false))
                    || ad.is_natively_off(p.kind.clone(), id.clone()))
            {
                ad.native_toggle(p.kind.clone(), id.clone(), false);
            } else {
                if prev.map(|r| r.live.contains(a_id)).unwrap_or(false) {
                    if let Some(d) = prev.and_then(|r| def_from_item(&r.item)) {
                        ad.remove(p.kind.clone(), id.clone(), Some(&d));
                    }
                }
                state.set_snapshot(
                    a_id,
                    p.kind.clone(),
                    &id,
                    Some(ResourceSnapshot {
                        kind: p.kind.clone(),
                        name: p.name.clone(),
                        updated_at: now_ms(),
                        data: def_to_data(&def),
                    }),
                );
            }
        });
        if let Err(e) = res {
            return Err(format!("save failed for {a_id}: {e}"));
        }
    }

    Ok(list_resources(workspaces, p.kind.clone(), state))
}

pub fn toggle_resource(
    workspaces: &[WorkspaceRec],
    kind: ResourceKind,
    id: String,
    on: bool,
    state: &AppStateManager,
) -> Vec<ResourceItem> {
    let adapters = index::all(workspaces);
    let shadow = state.get_state().shadow;
    let current = merged(kind.clone(), &adapters, &shadow);
    let rich = match current.into_iter().find(|r| r.item.id == id) {
        Some(r) => r,
        None => return list_resources(workspaces, kind, state),
    };
    let live = rich.live.clone();
    for a_id in &rich.item.agent_ids {
        let ad = match index::find_adapter(a_id, &adapters) {
            Some(x) => x,
            None => continue,
        };
        let item_def = def_from_item(&rich.item);
        let res = catch(|| {
            if on {
                if let Some(d) = &item_def {
                    ad.write(kind.clone(), id.clone(), rich.item.name.clone(), d.clone());
                }
                state.set_snapshot(a_id, kind.clone(), &id, None);
                ad.native_toggle(kind.clone(), id.clone(), true);
            } else if ad.has_native_toggle()
                && (live.contains(a_id) || ad.is_natively_off(kind.clone(), id.clone()))
            {
                ad.native_toggle(kind.clone(), id.clone(), false); /* definition stays, flagged off natively */
            } else {
                if let Some(d) = &item_def {
                    ad.remove(kind.clone(), id.clone(), Some(d));
                }
                state.set_snapshot(
                    a_id,
                    kind.clone(),
                    &id,
                    Some(ResourceSnapshot {
                        kind: kind.clone(),
                        name: rich.item.name.clone(),
                        updated_at: now_ms(),
                        data: def_to_data(item_def.as_ref().unwrap_or(&ResourceDef::Mcp(McpDef {
                            command: String::new(),
                            args: Vec::new(),
                            env: HashMap::new(),
                        }))),
                    }),
                );
            }
        });
        if let Err(e) = res {
            eprintln!(
                "[bentomux] toggle failed {} {} {e}",
                a_id,
                kind_to_str(&kind)
            );
            return list_resources(workspaces, kind, state);
        }
    }
    list_resources(workspaces, kind, state)
}

pub fn delete_resource(
    workspaces: &[WorkspaceRec],
    kind: ResourceKind,
    id: String,
    state: &AppStateManager,
) -> Vec<ResourceItem> {
    let adapters = index::all(workspaces);
    let shadow = state.get_state().shadow;
    let current = merged(kind.clone(), &adapters, &shadow);
    let rich = match current.into_iter().find(|r| r.item.id == id) {
        Some(r) => r,
        None => return list_resources(workspaces, kind, state),
    };
    let item_def = def_from_item(&rich.item);
    for a_id in &rich.item.agent_ids {
        let ad = match index::find_adapter(a_id, &adapters) {
            Some(x) => x,
            None => continue,
        };
        let res = catch(|| {
            if let Some(d) = &item_def {
                ad.remove(kind.clone(), id.clone(), Some(d));
            }
            state.set_snapshot(a_id, kind.clone(), &id, None);
            ad.native_toggle(kind.clone(), id.clone(), true); /* clear any leftover override */
        });
        if let Err(e) = res {
            eprintln!(
                "[bentomux] delete failed {} {} {e}",
                a_id,
                kind_to_str(&kind)
            );
            return list_resources(workspaces, kind, state);
        }
    }
    list_resources(workspaces, kind, state)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* run an adapter write/remove/toggle, trapping a panic the way Electron
try/catch around the async adapter call did */
fn catch<F: FnOnce()>(f: F) -> Result<(), String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(()) => Ok(()),
        Err(payload) => Err(panic_message(&payload)),
    }
}

fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown adapter error".to_string()
    }
}

fn kind_to_str(kind: &ResourceKind) -> &'static str {
    match kind {
        ResourceKind::Memory => "memory",
        ResourceKind::Skills => "skills",
        ResourceKind::Mcp => "mcp",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::types::ListMap;
    use crate::agents::types::ListedEntry;
    use crate::state::Capabilities;

    struct FakeAdapter {
        entries: HashMap<ResourceKind, ListMap>,
        caps: Capabilities,
    }

    impl AgentAdapter for FakeAdapter {
        fn id(&self) -> &str {
            "fake"
        }
        fn name(&self) -> &str {
            "Fake"
        }
        fn capabilities(&self) -> Capabilities {
            self.caps.clone()
        }
        fn detect(&self) -> bool {
            true
        }
        fn list(&self, kind: ResourceKind) -> ListMap {
            self.entries.get(&kind).cloned().unwrap_or_default()
        }
        fn write(&self, _k: ResourceKind, _id: String, _n: String, _d: ResourceDef) {}
        fn remove(&self, _k: ResourceKind, _id: String, _d: Option<&ResourceDef>) {}
        fn model_settings(&self) -> Option<&crate::agents::types::ModelSettingsCap> {
            None
        }
        fn config_path(&self) -> Option<String> {
            None
        }
    }

    fn mem_def(ws: Option<&str>, content: &str) -> ResourceDef {
        ResourceDef::Memory(MemoryDef {
            scope: if ws.is_some() {
                MemoryScope::Project
            } else {
                MemoryScope::Global
            },
            workspace_path: ws.map(str::to_string),
            content: content.to_string(),
        })
    }

    #[test]
    fn blank_scope_is_global_only_for_memory() {
        assert_eq!(
            blank(ResourceKind::Memory, "m1".into())
                .item
                .scope
                .as_deref(),
            Some("global")
        );
        assert_eq!(blank(ResourceKind::Skills, "s1".into()).item.scope, None);
        assert_eq!(blank(ResourceKind::Mcp, "c1".into()).item.scope, None);
        assert_eq!(blank(ResourceKind::Memory, "m1".into()).item.status, "off");
    }

    #[test]
    fn def_from_build_mcp_accepts_valid_json() {
        let p = ResourceSavePayload {
            kind: ResourceKind::Mcp,
            id: None,
            name: "db".into(),
            agent_ids: vec![],
            enabled: true,
            scope: None,
            workspace_path: None,
            content: None,
            instructions: None,
            config_json: Some(
                r#"{"command":"npx","args":["-y","@mcp/db"],"env":{"K":"V"}}"#.into(),
            ),
        };
        match def_from_build(&p).unwrap() {
            ResourceDef::Mcp(c) => {
                assert_eq!(c.command, "npx");
                assert_eq!(c.args, vec!["-y", "@mcp/db"]);
                assert_eq!(c.env.get("K").map(String::as_str), Some("V"));
            }
            _ => panic!("expected Mcp def"),
        }
    }

    #[test]
    fn def_from_build_mcp_rejects_bad_json_and_missing_command() {
        let mut p = ResourceSavePayload {
            kind: ResourceKind::Mcp,
            id: None,
            name: "x".into(),
            agent_ids: vec![],
            enabled: true,
            scope: None,
            workspace_path: None,
            content: None,
            instructions: None,
            config_json: Some("not json".into()),
        };
        assert_eq!(
            def_from_build(&p).unwrap_err(),
            "Configuration must be valid JSON."
        );
        p.config_json = Some(r#"{"args":[]}"#.into());
        assert_eq!(
            def_from_build(&p).unwrap_err(),
            "Configuration must include a \"command\" string."
        );
    }

    #[test]
    fn def_from_build_memory_keeps_project_workspace() {
        let p = ResourceSavePayload {
            kind: ResourceKind::Memory,
            id: None,
            name: "m".into(),
            agent_ids: vec![],
            enabled: true,
            scope: Some("project".into()),
            workspace_path: Some(Some("/ws".into())),
            content: Some(" body\r\n\r\n ".into()),
            instructions: None,
            config_json: None,
        };
        match def_from_build(&p).unwrap() {
            ResourceDef::Memory(m) => {
                assert_eq!(m.scope, MemoryScope::Project);
                assert_eq!(m.workspace_path.as_deref(), Some("/ws"));
                assert_eq!(m.content, "body");
            }
            _ => panic!("expected memory def"),
        }
    }

    #[test]
    fn def_from_build_skills_truncates_description_to_100_chars() {
        let long: String = "x".repeat(150);
        let p = ResourceSavePayload {
            kind: ResourceKind::Skills,
            id: None,
            name: "s".into(),
            agent_ids: vec![],
            enabled: true,
            scope: None,
            workspace_path: None,
            content: None,
            instructions: Some(long.clone()),
            config_json: None,
        };
        match def_from_build(&p).unwrap() {
            ResourceDef::Skill(s) => assert_eq!(s.description.chars().count(), 100),
            _ => panic!("expected skill def"),
        }
    }

    #[test]
    fn merged_blends_live_and_shadow_and_live_wins() {
        let mut entries = HashMap::new();
        let mut mem_list: ListMap = HashMap::new();
        mem_list.insert(
            "m1".into(),
            ListedEntry {
                def: mem_def(None, "live content"),
                updated_at: 200,
                name: Some("Memory One".into()),
            },
        );
        let skills_list: ListMap = HashMap::new();
        entries.insert(ResourceKind::Memory, mem_list);
        entries.insert(ResourceKind::Skills, skills_list.clone());
        entries.insert(ResourceKind::Mcp, HashMap::new());
        let fake = FakeAdapter {
            entries,
            caps: Capabilities {
                memory: true,
                skills: false,
                mcp: false,
            },
        };
        let adapters: Vec<Box<dyn AgentAdapter>> = vec![Box::new(fake)];

        /* shadow has m1 (should lose to live) and a skills row (no live, kept) */
        let mut shadow: ShadowStore = HashMap::new();
        let mut per_kind: HashMap<ResourceKind, HashMap<String, ResourceSnapshot>> = HashMap::new();
        let mut mem_snaps = HashMap::new();
        mem_snaps.insert(
            "m1".into(),
            ResourceSnapshot {
                kind: ResourceKind::Memory,
                name: "Memory One".into(),
                updated_at: 999,
                data: serde_json::json!({ "scope": "global", "content": "shadow content" })
                    .as_object()
                    .cloned()
                    .unwrap(),
            },
        );
        let mut skill_snaps = HashMap::new();
        skill_snaps.insert(
            "s1".into(),
            ResourceSnapshot {
                kind: ResourceKind::Skills,
                name: "Skill One".into(),
                updated_at: 50,
                data: serde_json::json!({ "description": "d", "instructions": "i" })
                    .as_object()
                    .cloned()
                    .unwrap(),
            },
        );
        per_kind.insert(ResourceKind::Memory, mem_snaps);
        per_kind.insert(ResourceKind::Skills, skill_snaps);
        shadow.insert("fake".into(), per_kind);

        let rows = merged(ResourceKind::Memory, &adapters, &shadow);
        /* only memory kind requested */
        assert_eq!(rows.len(), 1);
        let m = &rows[0];
        assert_eq!(m.item.id, "m1");
        assert_eq!(m.item.status, "on"); /* live present */
        assert_eq!(m.item.content.as_deref(), Some("live content")); /* live wins */
        assert_eq!(m.item.agent_ids, vec!["fake".to_string()]);
    }

    #[test]
    fn merged_reports_off_when_only_shadow_holds_the_item() {
        let entries = HashMap::new();
        let fake = FakeAdapter {
            entries,
            caps: Capabilities {
                memory: true,
                skills: true,
                mcp: false,
            },
        };
        let adapters: Vec<Box<dyn AgentAdapter>> = vec![Box::new(fake)];
        let mut shadow: ShadowStore = HashMap::new();
        let mut per_kind: HashMap<ResourceKind, HashMap<String, ResourceSnapshot>> = HashMap::new();
        let mut mem_snaps = HashMap::new();
        mem_snaps.insert(
            "ghost".into(),
            ResourceSnapshot {
                kind: ResourceKind::Memory,
                name: "Ghost".into(),
                updated_at: 1,
                data: serde_json::json!({ "content": "c" })
                    .as_object()
                    .cloned()
                    .unwrap(),
            },
        );
        per_kind.insert(ResourceKind::Memory, mem_snaps);
        shadow.insert("fake".into(), per_kind);

        let rows = merged(ResourceKind::Memory, &adapters, &shadow);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].item.status, "off");
        assert!(rows[0].live.is_empty());
        assert_eq!(rows[0].item.content.as_deref(), Some("c"));
    }
}
