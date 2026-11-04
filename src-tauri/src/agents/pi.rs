/* ---------------- pi adapter (Mario Zechner's pi coding agent) ----------------
Rust port of src/main/agents/pi.ts.
memory : marker-wrapped sections inside ~/.pi/agent/AGENTS.md (global)
         and <ws>/AGENTS.md (project)
skills : ~/.pi/agent/skills/<id>/SKILL.md
mcp    : not supported by design — capability stays false
model  : custom providers in ~/.pi/agent/models.json under our "bentomux"
         provider id */

use std::fs;
use std::path::PathBuf;

use crate::agents::types::{
    AdapterCtx, AgentAdapter, ListMap, MemoryDef, MemoryScope, ResourceDef, SkillDef,
};
use crate::agents::util::{
    context_to_number, dir_exists, frontmatter, mtime, normalize_memory_markers, on_path,
    parse_frontmatter, parse_sections, read_json, read_text, remove_section, rm_rf, upsert_section,
    write_json, write_text,
};
use crate::runtime::{FormatChoice, ModelField, ModelSettingsPatch, ModelSettingsView};
use crate::state::{Capabilities, ResourceKind};

use super::types::{ListedEntry, ModelSettingsCap};

const MANAGED_PROVIDER: &str = "bentomux";

pub struct PiAdapter {
    root: PathBuf,
    workspaces: Vec<crate::state::WorkspaceRec>,
    model_settings_cap: ModelSettingsCap,
}

impl PiAdapter {
    pub fn new(ctx: &AdapterCtx) -> Self {
        let root = std::env::var("PI_CODING_AGENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(&ctx.home).join(".pi").join("agent"));
        let models_json = root.join("models.json");
        let cap = ModelSettingsCap {
            fields: vec![
                ModelField::Model,
                ModelField::BaseUrl,
                ModelField::Context,
                ModelField::ApiKey,
                ModelField::Format,
            ],
            formats: vec![
                FormatChoice {
                    value: "openai-completions".into(),
                    label: "OpenAI · Chat Completions".into(),
                },
                FormatChoice {
                    value: "openai-responses".into(),
                    label: "OpenAI · Responses".into(),
                },
                FormatChoice {
                    value: "anthropic-messages".into(),
                    label: "Anthropic · Messages".into(),
                },
                FormatChoice {
                    value: "google-generative-ai".into(),
                    label: "Google · Generative AI".into(),
                },
            ],
            suggestions: vec![],
            write_target: models_json.to_string_lossy().to_string(),
            get: Box::new({
                let mj = models_json.clone();
                move || {
                    let providers = read_json::<serde_json::Value>(&mj.to_string_lossy())
                        .and_then(|v| v.get("providers").and_then(|p| p.as_object()).cloned())
                        .unwrap_or_default();
                    let p = providers
                        .get(MANAGED_PROVIDER)
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    let model = p
                        .get("models")
                        .and_then(|m| m.as_object())
                        .map(|m| m.keys().next().cloned().unwrap_or_default())
                        .unwrap_or_default();
                    let win = if !model.is_empty() {
                        p.get("models")
                            .and_then(|m| m.as_object())
                            .and_then(|mm| mm.get(&model))
                            .and_then(|e| e.get("contextWindow"))
                            .and_then(|c| c.as_i64())
                    } else {
                        None
                    };
                    ModelSettingsView {
                        model,
                        base_url: p
                            .get("baseUrl")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        context: win.map(|n| n.to_string()).unwrap_or_default(),
                        format: p
                            .get("api")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        has_api_key: p
                            .get("apiKey")
                            .is_some_and(|v| v.as_str().map(|s| !s.is_empty()).unwrap_or(false)),
                    }
                }
            }),
            set: Box::new({
                let mj = models_json.clone();
                move |patch: ModelSettingsPatch| {
                    let mut obj = read_json::<serde_json::Value>(&mj.to_string_lossy())
                        .unwrap_or(serde_json::json!({}));
                    let mut providers = obj
                        .get("providers")
                        .and_then(|v| v.as_object())
                        .cloned()
                        .unwrap_or_default();
                    let prev = providers
                        .get(MANAGED_PROVIDER)
                        .cloned()
                        .unwrap_or(serde_json::json!({}));
                    let mut next = if prev.is_object() {
                        prev.as_object()
                            .unwrap()
                            .clone()
                            .into_iter()
                            .collect::<serde_json::Map<_, _>>()
                    } else {
                        serde_json::Map::new()
                    };

                    if let Some(b) = patch.base_url {
                        if b.is_empty() {
                            next.remove("baseUrl");
                        } else {
                            next.insert("baseUrl".into(), serde_json::Value::String(b));
                        }
                    }
                    if let Some(f) = patch.format {
                        if f.is_empty() {
                            next.remove("api");
                        } else {
                            next.insert("api".into(), serde_json::Value::String(f));
                        }
                    }
                    match patch.api_key {
                        Some(None) => {
                            next.remove("apiKey");
                        }
                        Some(Some(k)) if !k.is_empty() => {
                            next.insert("apiKey".into(), serde_json::Value::String(k));
                        }
                        _ => {}
                    }

                    if let Some(m) = patch.model {
                        if m.is_empty() {
                            next.remove("models");
                        } else {
                            let mut models = next
                                .get("models")
                                .and_then(|v| v.as_object())
                                .cloned()
                                .unwrap_or_default();
                            let old = models.keys().next().cloned().unwrap_or_default();
                            if !old.is_empty() && old != m {
                                models.remove(&old);
                            }
                            let entry = models
                                .get(&m)
                                .cloned()
                                .unwrap_or_else(|| serde_json::json!({}));
                            let mut emap = if entry.is_object() {
                                entry.as_object().unwrap().clone()
                            } else {
                                serde_json::Map::new()
                            };
                            emap.insert("name".into(), serde_json::Value::String(m.clone()));
                            if let Some(c) = patch.context {
                                if let Some(n) = context_to_number(&c) {
                                    emap.insert(
                                        "contextWindow".into(),
                                        serde_json::Value::Number(n.into()),
                                    );
                                } else {
                                    emap.remove("contextWindow");
                                }
                            }
                            models.insert(m, serde_json::Value::Object(emap));
                            next.insert("models".into(), serde_json::Value::Object(models));
                        }
                    }

                    let has_content = next
                        .get("baseUrl")
                        .and_then(|v| v.as_str())
                        .map(|s| !s.is_empty())
                        .unwrap_or(false)
                        || next.contains_key("api")
                        || next.contains_key("apiKey")
                        || next
                            .get("models")
                            .and_then(|v| v.as_object())
                            .map(|m| !m.is_empty())
                            .unwrap_or(false);
                    if has_content {
                        providers.insert(MANAGED_PROVIDER.into(), serde_json::Value::Object(next));
                    } else {
                        providers.remove(MANAGED_PROVIDER);
                    }
                    if providers.is_empty() {
                        obj.as_object_mut().map(|o| o.remove("providers"));
                    } else {
                        obj["providers"] = serde_json::Value::Object(providers);
                    }
                    write_json(&mj.to_string_lossy(), &obj);
                }
            }),
        };
        PiAdapter {
            root,
            workspaces: ctx.workspaces.clone(),
            model_settings_cap: cap,
        }
    }

    fn agents_global(&self) -> PathBuf {
        self.root.join("AGENTS.md")
    }
    fn skills_root(&self) -> PathBuf {
        self.root.join("skills")
    }
    fn settings_json(&self) -> PathBuf {
        self.root.join("settings.json")
    }
}

impl AgentAdapter for PiAdapter {
    fn id(&self) -> &str {
        "pi"
    }
    fn name(&self) -> &str {
        "pi"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            memory: true,
            skills: true,
            mcp: false,
        }
    }

    fn detect(&self) -> bool {
        dir_exists(&self.root.to_string_lossy()) || on_path("pi")
    }

    fn list(&self, kind: ResourceKind) -> ListMap {
        let mut map = ListMap::new();
        match kind {
            ResourceKind::Memory => {
                let mut scan = |file: &PathBuf, scope: MemoryScope, ws_path: Option<String>| {
                    let p = file.to_string_lossy().to_string();
                    let Some(raw) = read_text(&p) else { return };
                    let ts = mtime(&p);
                    for (id, title, content) in parse_sections(&raw) {
                        map.insert(
                            id.clone(),
                            ListedEntry {
                                def: ResourceDef::Memory(MemoryDef {
                                    scope: scope.clone(),
                                    workspace_path: ws_path.clone(),
                                    content,
                                }),
                                updated_at: ts,
                                name: Some(if title.is_empty() { id } else { title }),
                            },
                        );
                    }
                };
                scan(&self.agents_global(), MemoryScope::Global, None);
                for w in &self.workspaces {
                    scan(
                        &PathBuf::from(&w.path).join("AGENTS.md"),
                        MemoryScope::Project,
                        Some(w.path.clone()),
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
                    let skill_file = e.path().join("SKILL.md");
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
            ResourceKind::Mcp => {}
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
                    PathBuf::from(ws).join("AGENTS.md")
                } else {
                    self.agents_global()
                };
                let p = file.to_string_lossy().to_string();
                write_text(
                    &p,
                    &upsert_section(&read_text(&p).unwrap_or_default(), &id, &name, &d.content),
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
            _ => {}
        }
    }

    fn remove(&self, kind: ResourceKind, id: String, def: Option<&ResourceDef>) {
        match kind {
            ResourceKind::Memory => {
                let mut targets = vec![self.agents_global()];
                match def.and_then(|d| match d {
                    ResourceDef::Memory(m) => m.workspace_path.clone(),
                    _ => None,
                }) {
                    Some(ws) => targets.push(PathBuf::from(ws).join("AGENTS.md")),
                    None => {
                        for w in &self.workspaces {
                            targets.push(PathBuf::from(&w.path).join("AGENTS.md"));
                        }
                    }
                }
                for f in targets {
                    let p = f.to_string_lossy().to_string();
                    if let Some(raw) = read_text(&p) {
                        if normalize_memory_markers(&raw)
                            .contains(&format!("bentomux:memory:{id}:begin"))
                        {
                            write_text(&p, &remove_section(&raw, &id));
                        }
                    }
                }
            }
            ResourceKind::Skills => rm_rf(&self.skills_root().join(&id).to_string_lossy()),
            ResourceKind::Mcp => {}
        }
    }

    fn model_settings(&self) -> Option<&ModelSettingsCap> {
        Some(&self.model_settings_cap)
    }
    fn config_path(&self) -> Option<String> {
        Some(self.settings_json().to_string_lossy().to_string())
    }
}
