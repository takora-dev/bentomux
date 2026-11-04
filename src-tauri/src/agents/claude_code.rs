/* ---------------- Claude Code adapter ----------------
Rust port of src/main/agents/claude-code.ts.
memory : ~/.claude/rules/<id>.md (global) · <ws>/.claude/rules/<id>.md (project)
         only files carrying the bentomux ownership marker are managed
skills : ~/.claude/skills/<id>/SKILL.md · native off via skillOverrides
mcp    : "mcpServers" inside ~/.claude.json (user scope)
model  : "model" + an env block (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN)
         in ~/.claude/settings.json */

use std::fs;
use std::path::PathBuf;

use crate::agents::types::{
    AdapterCtx, AgentAdapter, ListMap, McpDef, MemoryDef, MemoryScope, ResourceDef, SkillDef,
};
use crate::agents::util::{
    dir_exists, frontmatter, mtime, on_path, parse_frontmatter, read_json, read_text, rm_rf,
    strip_memory_marker, with_memory_marker, write_json, write_text,
};
use crate::state::{Capabilities, ResourceKind};

use super::types::{ListedEntry, ModelSettingsCap};

pub struct ClaudeCodeAdapter {
    home: PathBuf,
    workspaces: Vec<crate::state::WorkspaceRec>,
    model_settings_cap: ModelSettingsCap,
}

impl ClaudeCodeAdapter {
    pub fn new(ctx: &AdapterCtx) -> Self {
        let home = PathBuf::from(&ctx.home);
        let settings_json = home.join(".claude").join("settings.json");
        let cap = ModelSettingsCap {
            fields: vec![
                crate::runtime::ModelField::Model,
                crate::runtime::ModelField::BaseUrl,
                crate::runtime::ModelField::ApiKey,
            ],
            formats: vec![],
            suggestions: vec![
                "claude-opus-4-1-20250805".into(),
                "claude-sonnet-4-5-20250929".into(),
                "claude-haiku-4-5-20251001".into(),
            ],
            write_target: settings_json.to_string_lossy().to_string(),
            get: Box::new({
                let sj = settings_json.clone();
                move || {
                    let obj = read_json::<serde_json::Value>(&sj.to_string_lossy())
                        .unwrap_or(serde_json::json!({}));
                    let env = obj
                        .get("env")
                        .and_then(|v| v.as_object())
                        .cloned()
                        .unwrap_or_default();
                    let str = |v: &serde_json::Value| v.as_str().unwrap_or("").to_string();
                    let model = obj.get("model").map(&str).unwrap_or_default();
                    let base_url = env.get("ANTHROPIC_BASE_URL").map(&str).unwrap_or_default();
                    let has_key = env
                        .get("ANTHROPIC_AUTH_TOKEN")
                        .map(|v| !str(v).is_empty())
                        .unwrap_or(false)
                        || env
                            .get("ANTHROPIC_API_KEY")
                            .map(|v| !str(v).is_empty())
                            .unwrap_or(false);
                    crate::runtime::ModelSettingsView {
                        model,
                        base_url,
                        context: String::new(),
                        format: String::new(),
                        has_api_key: has_key,
                    }
                }
            }),
            set: Box::new({
                let sj = settings_json.clone();
                move |patch: crate::runtime::ModelSettingsPatch| {
                    let mut obj = read_json::<serde_json::Value>(&sj.to_string_lossy())
                        .unwrap_or(serde_json::json!({}));
                    if let Some(m) = patch.model {
                        if m.is_empty() {
                            obj.as_object_mut().map(|o| o.remove("model"));
                        } else {
                            obj["model"] = serde_json::Value::String(m);
                        }
                    }
                    let mut env = obj
                        .get("env")
                        .and_then(|v| v.as_object())
                        .cloned()
                        .unwrap_or_default();
                    let mut env_changed = false;
                    if let Some(b) = patch.base_url {
                        env_changed = true;
                        if b.is_empty() {
                            env.remove("ANTHROPIC_BASE_URL");
                        } else {
                            env.insert("ANTHROPIC_BASE_URL".into(), serde_json::Value::String(b));
                        }
                    }
                    if let Some(Some(k)) = patch.api_key {
                        env_changed = true;
                        if k.is_empty() {
                            env.remove("ANTHROPIC_AUTH_TOKEN");
                        } else {
                            env.insert("ANTHROPIC_AUTH_TOKEN".into(), serde_json::Value::String(k));
                        }
                    }
                    if env_changed {
                        if env.is_empty() {
                            obj.as_object_mut().map(|o| o.remove("env"));
                        } else {
                            obj["env"] = serde_json::Value::Object(env);
                        }
                    }
                    write_json(&sj.to_string_lossy(), &obj);
                }
            }),
        };
        ClaudeCodeAdapter {
            home,
            workspaces: ctx.workspaces.clone(),
            model_settings_cap: cap,
        }
    }

    fn root(&self) -> PathBuf {
        self.home.join(".claude")
    }
    fn rules_global(&self) -> PathBuf {
        self.root().join("rules")
    }
    fn skills_root(&self) -> PathBuf {
        self.root().join("skills")
    }
    fn claude_json(&self) -> PathBuf {
        self.home.join(".claude.json")
    }
    fn settings_json(&self) -> PathBuf {
        self.root().join("settings.json")
    }

    fn memory_files(&self) -> Vec<(String, String, String, MemoryDef)> {
        let mut out = Vec::new();
        let mut scan = |dir: &PathBuf, scope: MemoryScope, ws_path: Option<String>| {
            if !dir_exists(&dir.to_string_lossy()) {
                return;
            }
            let Ok(rd) = fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if !name.ends_with(".md") {
                    continue;
                }
                let file = e.path();
                let p = file.to_string_lossy().to_string();
                let Some(raw) = read_text(&p) else { continue };
                let Some((id, title, content)) = strip_memory_marker(&raw) else {
                    continue;
                };
                out.push((
                    if id.is_empty() {
                        name.trim_end_matches(".md").to_string()
                    } else {
                        id.clone()
                    },
                    p,
                    if title.is_empty() { id.clone() } else { title },
                    MemoryDef {
                        scope: scope.clone(),
                        workspace_path: ws_path.clone(),
                        content,
                    },
                ));
            }
        };
        scan(&self.rules_global(), MemoryScope::Global, None);
        for w in &self.workspaces {
            scan(
                &PathBuf::from(&w.path).join(".claude").join("rules"),
                MemoryScope::Project,
                Some(w.path.clone()),
            );
        }
        out
    }
}

impl AgentAdapter for ClaudeCodeAdapter {
    fn id(&self) -> &str {
        "claude-code"
    }
    fn name(&self) -> &str {
        "Claude Code"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            memory: true,
            skills: true,
            mcp: true,
        }
    }

    fn detect(&self) -> bool {
        dir_exists(&self.root().to_string_lossy())
            || self.claude_json().exists()
            || on_path("claude")
    }

    fn list(&self, kind: ResourceKind) -> ListMap {
        let mut map = ListMap::new();
        match kind {
            ResourceKind::Memory => {
                for (id, file, name, def) in self.memory_files() {
                    map.insert(
                        id,
                        ListedEntry {
                            def: ResourceDef::Memory(def),
                            updated_at: mtime(&file),
                            name: Some(name),
                        },
                    );
                }
            }
            ResourceKind::Skills => {
                if !dir_exists(&self.skills_root().to_string_lossy()) {
                    return map;
                }
                let Ok(rd) = fs::read_dir(self.skills_root()) else {
                    return map;
                };
                for e in rd.flatten() {
                    let dir = e.path();
                    let skill_file = dir.join("SKILL.md");
                    let p = skill_file.to_string_lossy().to_string();
                    let Some(raw) = read_text(&p) else { continue };
                    let (attrs, body) = parse_frontmatter(&raw);
                    let dir_name = e.file_name().to_string_lossy().to_string();
                    let key = attrs.get("name").cloned().unwrap_or(dir_name);
                    map.insert(
                        key.clone(),
                        ListedEntry {
                            def: ResourceDef::Skill(SkillDef {
                                description: attrs.get("description").cloned().unwrap_or_default(),
                                instructions: body.trim().to_string(),
                            }),
                            updated_at: mtime(&p),
                            name: Some(key),
                        },
                    );
                }
            }
            ResourceKind::Mcp => {
                let obj = read_json::<serde_json::Value>(&self.claude_json().to_string_lossy())
                    .unwrap_or(serde_json::Value::Null);
                let servers = obj
                    .get("mcpServers")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                let updated = mtime(&self.claude_json().to_string_lossy());
                for (id, s) in servers {
                    let def = McpDef {
                        command: s
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        args: s
                            .get("args")
                            .and_then(|v| v.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x.as_str().map(str::to_string))
                                    .collect()
                            })
                            .unwrap_or_default(),
                        env: s
                            .get("env")
                            .and_then(|v| v.as_object())
                            .map(|o| {
                                o.iter()
                                    .filter_map(|(k, v)| {
                                        v.as_str().map(|s| (k.clone(), s.to_string()))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    };
                    map.insert(
                        id,
                        ListedEntry {
                            def: ResourceDef::Mcp(def),
                            updated_at: updated,
                            name: None,
                        },
                    );
                }
            }
        }
        map
    }

    fn write(&self, kind: ResourceKind, id: String, name: String, def: ResourceDef) {
        match (kind, def) {
            (ResourceKind::Memory, ResourceDef::Memory(d)) => {
                let project_ws = if d.scope == MemoryScope::Project {
                    d.workspace_path.as_deref()
                } else {
                    None
                };
                let file = if let Some(ws) = project_ws {
                    PathBuf::from(ws)
                        .join(".claude")
                        .join("rules")
                        .join(format!("{id}.md"))
                } else {
                    self.rules_global().join(format!("{id}.md"))
                };
                write_text(
                    &file.to_string_lossy(),
                    &with_memory_marker(&id, &name, &d.content),
                );
            }
            (ResourceKind::Skills, ResourceDef::Skill(d)) => {
                let desc = if d.description.is_empty() {
                    name
                } else {
                    d.description
                };
                write_text(
                    &self
                        .skills_root()
                        .join(&id)
                        .join("SKILL.md")
                        .to_string_lossy(),
                    &frontmatter(&id, &desc, &d.instructions),
                );
            }
            (ResourceKind::Mcp, ResourceDef::Mcp(d)) => {
                let mut obj = read_json::<serde_json::Value>(&self.claude_json().to_string_lossy())
                    .unwrap_or(serde_json::json!({}));
                let mut servers = obj
                    .get("mcpServers")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                servers.insert(id, serde_json::json!({ "type": "stdio", "command": d.command, "args": d.args, "env": d.env }));
                obj["mcpServers"] = serde_json::Value::Object(servers);
                write_json(&self.claude_json().to_string_lossy(), &obj);
            }
            _ => {}
        }
    }

    fn remove(&self, kind: ResourceKind, id: String, def: Option<&ResourceDef>) {
        match kind {
            ResourceKind::Memory => {
                let mut targets = vec![self.rules_global().join(format!("{id}.md"))];
                match def.and_then(|d| match d {
                    ResourceDef::Memory(m) => m.workspace_path.clone(),
                    _ => None,
                }) {
                    Some(ws) => targets.push(
                        PathBuf::from(ws)
                            .join(".claude")
                            .join("rules")
                            .join(format!("{id}.md")),
                    ),
                    None => {
                        for w in &self.workspaces {
                            targets.push(
                                PathBuf::from(&w.path)
                                    .join(".claude")
                                    .join("rules")
                                    .join(format!("{id}.md")),
                            );
                        }
                    }
                }
                for f in targets {
                    let _ = fs::remove_file(f);
                }
            }
            ResourceKind::Skills => rm_rf(&self.skills_root().join(&id).to_string_lossy()),
            ResourceKind::Mcp => {
                if let Some(mut obj) =
                    read_json::<serde_json::Value>(&self.claude_json().to_string_lossy())
                {
                    if let Some(servers) = obj.get_mut("mcpServers").and_then(|v| v.as_object_mut())
                    {
                        if servers.remove(&id).is_some() {
                            write_json(&self.claude_json().to_string_lossy(), &obj);
                        }
                    }
                }
            }
        }
    }

    fn has_native_toggle(&self) -> bool {
        true
    }
    fn native_toggle(&self, kind: ResourceKind, id: String, on: bool) {
        if kind != ResourceKind::Skills {
            return;
        }
        let mut obj = read_json::<serde_json::Value>(&self.settings_json().to_string_lossy())
            .unwrap_or(serde_json::json!({}));
        let mut overrides = obj
            .get("skillOverrides")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        if on {
            overrides.remove(&id);
        } else {
            overrides.insert(id, serde_json::Value::String("off".into()));
        }
        if !overrides.is_empty() {
            obj["skillOverrides"] = serde_json::Value::Object(overrides);
        } else if let Some(o) = obj.as_object_mut() {
            o.remove("skillOverrides");
        }
        write_json(&self.settings_json().to_string_lossy(), &obj);
    }

    fn is_natively_off(&self, kind: ResourceKind, id: String) -> bool {
        if kind != ResourceKind::Skills {
            return false;
        }
        read_json::<serde_json::Value>(&self.settings_json().to_string_lossy())
            .as_ref()
            .and_then(|o| o.get("skillOverrides"))
            .and_then(|v| v.as_object())
            .and_then(|m| m.get(&id))
            .and_then(|v| v.as_str())
            .map(|s| s == "off")
            .unwrap_or(false)
    }

    fn model_settings(&self) -> Option<&ModelSettingsCap> {
        Some(&self.model_settings_cap)
    }
    fn config_path(&self) -> Option<String> {
        Some(self.settings_json().to_string_lossy().to_string())
    }
}
