/* ---------------- simple config-file adapters ----------------
Rust port of src/main/agents/generic.ts.
qwen · codex · opencode · gemini · cursor · kilo · qwenpaw
One file because each adapter is a thin spec over the same mechanics:
detect by config dir or binary on PATH, no resource management
(all capabilities false), and model settings mapped into the tool's
own config file — native slots where they exist, a namespaced
`bentomux.modelSettings` block where the tool has none. */

use std::path::{Path, PathBuf};

use crate::state::{Capabilities, ResourceKind};

use super::types::{AdapterCtx, AgentAdapter, ListMap, ModelSettingsCap, ResourceDef};
use super::util::{
    context_to_number, dir_exists, on_path, parse_env_file, read_json, read_text, read_toml_table,
    read_toml_top, upsert_env_file, upsert_toml_table, upsert_toml_top, write_json, write_text,
};
use crate::runtime::{FormatChoice, ModelField, ModelSettingsPatch, ModelSettingsView};

/* model in a JSON settings file; url + key in a sibling .env file
(the gemini-cli / qwen-code pattern) */
fn json_model_env_cap(opts: GenEnvOpt) -> ModelSettingsCap {
    let suggestions = opts.suggestions.clone();
    let write_target = format!(
        "{} + {}",
        opts.settings_file.to_string_lossy(),
        opts.env_file.to_string_lossy()
    );
    ModelSettingsCap {
        fields: vec![ModelField::Model, ModelField::BaseUrl, ModelField::ApiKey],
        formats: vec![],
        suggestions,
        write_target,
        get: Box::new({
            let sf = opts.settings_file.clone();
            let ef = opts.env_file.clone();
            let bv = opts.base_url_var.clone();
            let ak = opts.api_key_var.clone();
            move || {
                let obj = read_json::<serde_json::Value>(&sf.to_string_lossy())
                    .unwrap_or(serde_json::Value::Null);
                let env = parse_env_file(&read_text(&ef.to_string_lossy()).unwrap_or_default());
                ModelSettingsView {
                    model: obj
                        .get("model")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    base_url: env.get(&bv).cloned().unwrap_or_default(),
                    context: String::new(),
                    format: String::new(),
                    has_api_key: env.get(&ak).map(|s| !s.is_empty()).unwrap_or(false),
                }
            }
        }),
        set: Box::new({
            let sf = opts.settings_file.clone();
            let ef = opts.env_file.clone();
            let bv = opts.base_url_var.clone();
            let ak = opts.api_key_var.clone();
            move |patch: ModelSettingsPatch| {
                if let Some(m) = patch.model {
                    let mut obj = read_json::<serde_json::Value>(&sf.to_string_lossy())
                        .unwrap_or(serde_json::json!({}));
                    if m.is_empty() {
                        obj.as_object_mut().map(|o| o.remove("model"));
                    } else {
                        obj["model"] = serde_json::Value::String(m);
                    }
                    write_json(&sf.to_string_lossy(), &obj);
                }
                let mut env: std::collections::HashMap<String, Option<String>> =
                    std::collections::HashMap::new();
                if let Some(b) = patch.base_url {
                    env.insert(bv.clone(), if b.is_empty() { None } else { Some(b) });
                }
                if let Some(Some(k)) = patch.api_key {
                    env.insert(ak.clone(), if k.is_empty() { None } else { Some(k) });
                }
                if !env.is_empty() {
                    let raw = read_text(&ef.to_string_lossy()).unwrap_or_default();
                    write_text(&ef.to_string_lossy(), &upsert_env_file(&raw, &env));
                }
            }
        }),
    }
}

struct GenEnvOpt {
    settings_file: PathBuf,
    env_file: PathBuf,
    base_url_var: String,
    api_key_var: String,
    suggestions: Vec<String>,
}

/* fields with no native slot in the tool's schema ride in a namespaced
`bentomux` block the tool ignores, so Apply always round-trips */
fn bentomux_block_cap(
    file: &Path,
    fields: Vec<ModelField>,
    formats: Vec<FormatChoice>,
) -> ModelSettingsCap {
    let f = file.to_path_buf();
    ModelSettingsCap {
        fields,
        formats,
        suggestions: vec![],
        write_target: f.to_string_lossy().to_string(),
        get: Box::new({
            let f2 = f.clone();
            move || {
                let obj = read_json::<serde_json::Value>(&f2.to_string_lossy())
                    .unwrap_or(serde_json::json!({}));
                let s = obj
                    .get("bentomux")
                    .and_then(|b| b.get("modelSettings"))
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                let str = |k: &str| s.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
                ModelSettingsView {
                    model: str("model"),
                    base_url: str("baseUrl"),
                    context: str("context"),
                    format: str("format"),
                    has_api_key: s.contains_key("apiKey"),
                }
            }
        }),
        set: Box::new({
            let f2 = f.clone();
            move |patch: ModelSettingsPatch| {
                let mut obj = read_json::<serde_json::Value>(&f2.to_string_lossy())
                    .unwrap_or(serde_json::json!({}));
                let mut t = obj
                    .get("bentomux")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                let mut block = t
                    .get("modelSettings")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                let mut apply = |key: &str, v: &Option<String>| {
                    if let Some(val) = v {
                        if val.is_empty() {
                            block.remove(key);
                        } else {
                            block.insert(key.to_string(), serde_json::Value::String(val.clone()));
                        }
                    }
                };
                apply("model", &patch.model);
                apply("baseUrl", &patch.base_url);
                apply("context", &patch.context);
                apply("format", &patch.format);
                match &patch.api_key {
                    Some(Some(v)) if !v.is_empty() => {
                        block.insert("apiKey".into(), serde_json::Value::String(v.clone()));
                    }
                    Some(_) => {
                        block.remove("apiKey");
                    }
                    None => {}
                }
                if block.is_empty() {
                    t.remove("modelSettings");
                } else {
                    t.insert("modelSettings".into(), serde_json::Value::Object(block));
                }
                if t.is_empty() {
                    obj.as_object_mut().map(|o| o.remove("bentomux"));
                } else {
                    obj["bentomux"] = serde_json::Value::Object(t);
                }
                write_json(&f2.to_string_lossy(), &obj);
            }
        }),
    }
}

struct SimpleAdapter {
    id: &'static str,
    name: &'static str,
    detect: Box<dyn Fn() -> bool + Send + Sync>,
    config_path: Box<dyn Fn() -> String + Send + Sync>,
    cap: Option<ModelSettingsCap>,
}

impl AgentAdapter for SimpleAdapter {
    fn id(&self) -> &str {
        self.id
    }
    fn name(&self) -> &str {
        self.name
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            memory: false,
            skills: false,
            mcp: false,
        }
    }
    fn detect(&self) -> bool {
        (self.detect)()
    }
    fn list(&self, _kind: ResourceKind) -> ListMap {
        ListMap::new()
    }
    fn write(&self, _kind: ResourceKind, _id: String, _name: String, _def: ResourceDef) {}
    fn remove(&self, _kind: ResourceKind, _id: String, _def: Option<&ResourceDef>) {}
    fn model_settings(&self) -> Option<&ModelSettingsCap> {
        self.cap.as_ref()
    }
    fn config_path(&self) -> Option<String> {
        Some((self.config_path)())
    }
}

/* ---------------- per-tool mapping ---------------- */

pub fn qwen_adapter(ctx: &AdapterCtx) -> Box<dyn AgentAdapter> {
    let home = PathBuf::from(&ctx.home);
    let settings_file = home.join(".qwen").join("settings.json");
    let env_file = home.join(".qwen").join(".env");
    let cap = json_model_env_cap(GenEnvOpt {
        settings_file: settings_file.clone(),
        env_file: env_file.clone(),
        base_url_var: "OPENAI_BASE_URL".into(),
        api_key_var: "OPENAI_API_KEY".into(),
        suggestions: vec![
            "qwen3-coder-plus".into(),
            "qwen3-coder-flash".into(),
            "qwen-max".into(),
            "qwen-plus".into(),
        ],
    });
    Box::new(SimpleAdapter {
        id: "qwen",
        name: "Qwen CLI",
        detect: Box::new({
            let d1 = home.join(".qwen");
            move || dir_exists(&d1.to_string_lossy()) || on_path("qwen")
        }),
        config_path: Box::new(move || settings_file.to_string_lossy().to_string()),
        cap: Some(cap),
    })
}

pub fn gemini_adapter(ctx: &AdapterCtx) -> Box<dyn AgentAdapter> {
    let home = PathBuf::from(&ctx.home);
    let settings_file = home.join(".gemini").join("settings.json");
    let env_file = home.join(".gemini").join(".env");
    let cap = json_model_env_cap(GenEnvOpt {
        settings_file: settings_file.clone(),
        env_file: env_file.clone(),
        base_url_var: "GOOGLE_GEMINI_BASE_URL".into(),
        api_key_var: "GEMINI_API_KEY".into(),
        suggestions: vec![
            "gemini-3-pro".into(),
            "gemini-3-flash".into(),
            "gemini-2.5-pro".into(),
            "gemini-2.5-flash".into(),
        ],
    });
    Box::new(SimpleAdapter {
        id: "gemini",
        name: "Gemini CLI",
        detect: Box::new({
            let d1 = home.join(".gemini");
            move || dir_exists(&d1.to_string_lossy()) || on_path("gemini")
        }),
        config_path: Box::new(move || settings_file.to_string_lossy().to_string()),
        cap: Some(cap),
    })
}

pub fn cursor_adapter(ctx: &AdapterCtx) -> Box<dyn AgentAdapter> {
    let home = PathBuf::from(&ctx.home);
    let cfg = home.join(".cursor").join("settings.json");
    let d = home.join(".cursor");
    Box::new(SimpleAdapter {
        id: "cursor",
        name: "Cursor",
        detect: Box::new(move || dir_exists(&d.to_string_lossy()) || on_path("cursor")),
        config_path: Box::new(move || cfg.to_string_lossy().to_string()),
        cap: None,
    })
}

pub fn kilo_adapter(ctx: &AdapterCtx) -> Box<dyn AgentAdapter> {
    let cfg = PathBuf::from(&ctx.home)
        .join(".config")
        .join("kilo")
        .join("config.json");
    let d = cfg.parent().unwrap().to_path_buf();
    let cap = bentomux_block_cap(
        &cfg,
        vec![
            ModelField::Model,
            ModelField::BaseUrl,
            ModelField::Context,
            ModelField::ApiKey,
            ModelField::Format,
        ],
        vec![],
    );
    Box::new(SimpleAdapter {
        id: "kilo",
        name: "Kilo Code",
        detect: Box::new(move || dir_exists(&d.to_string_lossy()) || on_path("kilo")),
        config_path: Box::new(move || cfg.to_string_lossy().to_string()),
        cap: Some(cap),
    })
}

pub fn qwenpaw_adapter(ctx: &AdapterCtx) -> Box<dyn AgentAdapter> {
    let cfg = PathBuf::from(&ctx.home)
        .join(".qwenpaw")
        .join("config.json");
    let d = cfg.parent().unwrap().to_path_buf();
    let cap = bentomux_block_cap(
        &cfg,
        vec![
            ModelField::Model,
            ModelField::BaseUrl,
            ModelField::Context,
            ModelField::ApiKey,
            ModelField::Format,
        ],
        vec![],
    );
    Box::new(SimpleAdapter {
        id: "qwenpaw",
        name: "QwenPaw",
        detect: Box::new(move || dir_exists(&d.to_string_lossy()) || on_path("qwenpaw")),
        config_path: Box::new(move || cfg.to_string_lossy().to_string()),
        cap: Some(cap),
    })
}

pub fn codex_adapter(ctx: &AdapterCtx) -> Box<dyn AgentAdapter> {
    let cfg = PathBuf::from(&ctx.home).join(".codex").join("config.toml");
    let provider = "bentomux";
    let prov_table = format!("model_providers.{provider}");
    let env_key_var = "BENTOMUX_API_KEY";

    let cap = {
        let cfg = cfg.clone();
        let prov_table = prov_table.clone();
        ModelSettingsCap {
            fields: vec![
                ModelField::Model,
                ModelField::BaseUrl,
                ModelField::Context,
                ModelField::ApiKey,
                ModelField::Format,
            ],
            formats: vec![
                FormatChoice {
                    value: "chat".into(),
                    label: "OpenAI · Chat Completions".into(),
                },
                FormatChoice {
                    value: "responses".into(),
                    label: "OpenAI · Responses".into(),
                },
            ],
            suggestions: vec![
                "gpt-5.3-codex".into(),
                "gpt-5.2-codex".into(),
                "gpt-5".into(),
                "o4-mini".into(),
            ],
            write_target: cfg.to_string_lossy().to_string(),
            get: Box::new({
                let cfg = cfg.clone();
                let prov_table = prov_table.clone();
                move || {
                    let raw = read_text(&cfg.to_string_lossy()).unwrap_or_default();
                    let top = read_toml_top(&raw);
                    let prov = read_toml_table(&raw, &prov_table);
                    let own = read_toml_table(&raw, "bentomux");
                    let str =
                        |v: Option<&toml::Value>| v.and_then(toml_val_str).unwrap_or_default();
                    ModelSettingsView {
                        model: str(top.get("model")),
                        base_url: str(prov.get("base_url")),
                        context: own
                            .get("context")
                            .map(|v| v.to_string())
                            .unwrap_or_default(),
                        format: str(prov.get("wire_api")),
                        has_api_key: own.contains_key("api_key") || prov.contains_key("env_key"),
                    }
                }
            }),
            set: Box::new({
                let cfg = cfg.clone();
                let prov_table = prov_table.clone();
                move |patch: ModelSettingsPatch| {
                    let mut raw = read_text(&cfg.to_string_lossy()).unwrap_or_default();
                    let mut prov_writes: std::collections::HashMap<String, Option<toml::Value>> =
                        std::collections::HashMap::new();
                    if let Some(b) = &patch.base_url {
                        prov_writes.insert("base_url".into(), opt_str(b));
                    }
                    if let Some(f) = &patch.format {
                        prov_writes.insert("wire_api".into(), opt_str(f));
                    }
                    if let Some(Some(k)) = &patch.api_key {
                        prov_writes.insert(
                            "env_key".into(),
                            if k.is_empty() {
                                None
                            } else {
                                Some(toml::Value::String(env_key_var.into()))
                            },
                        );
                    }
                    if patch.model.is_some() {
                        raw = upsert_toml_top(
                            &raw,
                            "model",
                            patch.model.as_ref().and_then(|m| {
                                if m.is_empty() {
                                    None
                                } else {
                                    Some(toml::Value::String(m.clone()))
                                }
                            }),
                        );
                    }
                    if !prov_writes.is_empty() {
                        let mut merged = prov_writes.clone();
                        merged.insert("name".into(), Some(toml::Value::String("Bentomux".into())));
                        raw = upsert_toml_table(&raw, &prov_table, &merged);
                        let after = read_toml_table(&raw, &prov_table);
                        let active = after.iter().any(|(k, v)| k != "name" && toml_nonempty(v));
                        raw = upsert_toml_top(
                            &raw,
                            "model_provider",
                            if active {
                                Some(toml::Value::String(provider.into()))
                            } else {
                                None
                            },
                        );
                    }
                    let mut own: std::collections::HashMap<String, Option<toml::Value>> =
                        std::collections::HashMap::new();
                    if let Some(c) = &patch.context {
                        if let Some(n) = context_to_number(c) {
                            own.insert("context".into(), Some(toml::Value::Integer(n)));
                        } else if c.is_empty() {
                            own.insert("context".into(), None);
                        } else {
                            own.insert("context".into(), Some(toml::Value::String(c.clone())));
                        }
                    }
                    if let Some(Some(k)) = &patch.api_key {
                        own.insert(
                            "api_key".into(),
                            if k.is_empty() {
                                None
                            } else {
                                Some(toml::Value::String(k.clone()))
                            },
                        );
                    }
                    if !own.is_empty() {
                        raw = upsert_toml_table(&raw, "bentomux", &own);
                    }
                    write_text(&cfg.to_string_lossy(), &raw);
                }
            }),
        }
    };
    let d = cfg.parent().unwrap().to_path_buf();
    Box::new(SimpleAdapter {
        id: "codex",
        name: "OpenAI Codex",
        detect: Box::new(move || dir_exists(&d.to_string_lossy()) || on_path("codex")),
        config_path: Box::new({
            let cfg = cfg.clone();
            move || cfg.to_string_lossy().to_string()
        }),
        cap: Some(cap),
    })
}

pub fn opencode_adapter(ctx: &AdapterCtx) -> Box<dyn AgentAdapter> {
    let cfg = PathBuf::from(&ctx.home)
        .join(".config")
        .join("opencode")
        .join("opencode.json");
    let provider = "bentomux";
    let prefix = format!("{provider}/");
    let cap = {
        let cfg = cfg.clone();
        let prefix = prefix.clone();
        ModelSettingsCap {
            fields: vec![
                ModelField::Model,
                ModelField::BaseUrl,
                ModelField::Context,
                ModelField::ApiKey,
                ModelField::Format,
            ],
            formats: vec![
                FormatChoice {
                    value: "@ai-sdk/openai-compatible".into(),
                    label: "OpenAI-compatible".into(),
                },
                FormatChoice {
                    value: "@ai-sdk/anthropic".into(),
                    label: "Anthropic".into(),
                },
                FormatChoice {
                    value: "@ai-sdk/google".into(),
                    label: "Google Generative AI".into(),
                },
            ],
            suggestions: vec![
                "gpt-5".into(),
                "claude-sonnet-4-5".into(),
                "qwen3-coder-plus".into(),
            ],
            write_target: cfg.to_string_lossy().to_string(),
            get: Box::new({
                let cfg = cfg.clone();
                let prefix = prefix.clone();
                move || {
                    let obj = read_json::<serde_json::Value>(&cfg.to_string_lossy())
                        .unwrap_or(serde_json::json!({}));
                    let p = obj
                        .get("provider")
                        .and_then(|pr| pr.get(provider))
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    let full = obj
                        .get("model")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let model = full
                        .strip_prefix(&prefix)
                        .map(str::to_string)
                        .unwrap_or_default();
                    let entry = if model.is_empty() {
                        None
                    } else {
                        p.get("models").and_then(|m| m.get(&model))
                    }
                    .cloned();
                    ModelSettingsView {
                        model: model.clone(),
                        base_url: p
                            .get("options")
                            .and_then(|o| o.get("baseURL"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        context: entry
                            .as_ref()
                            .and_then(|e| e.get("contextWindow"))
                            .and_then(|c| c.as_i64())
                            .map(|n| n.to_string())
                            .unwrap_or_default(),
                        format: p
                            .get("npm")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        has_api_key: p.get("options").and_then(|o| o.get("apiKey")).is_some(),
                    }
                }
            }),
            set: Box::new({
                let cfg = cfg.clone();
                let prefix = prefix.clone();
                move |patch: ModelSettingsPatch| {
                    let mut obj = read_json::<serde_json::Value>(&cfg.to_string_lossy())
                        .unwrap_or(serde_json::json!({}));
                    let mut providers = obj
                        .get("provider")
                        .and_then(|v| v.as_object())
                        .cloned()
                        .unwrap_or_default();
                    let prev = providers
                        .get(provider)
                        .cloned()
                        .unwrap_or(serde_json::json!({}));
                    let mut next = prev.as_object().cloned().unwrap_or_default();
                    next.insert("name".into(), serde_json::Value::String("Bentomux".into()));
                    let mut options = next
                        .get("options")
                        .and_then(|v| v.as_object())
                        .cloned()
                        .unwrap_or_default();

                    if let Some(b) = &patch.base_url {
                        if b.is_empty() {
                            options.remove("baseURL");
                        } else {
                            options.insert("baseURL".into(), serde_json::Value::String(b.clone()));
                        }
                    }
                    match &patch.api_key {
                        Some(Some(k)) if !k.is_empty() => {
                            options.insert("apiKey".into(), serde_json::Value::String(k.clone()));
                        }
                        Some(_) => {
                            options.remove("apiKey");
                        }
                        None => {}
                    }
                    if !options.is_empty() {
                        next.insert("options".into(), serde_json::Value::Object(options));
                    } else {
                        next.remove("options");
                    }
                    if let Some(f) = &patch.format {
                        if f.is_empty() {
                            next.remove("npm");
                        } else {
                            next.insert("npm".into(), serde_json::Value::String(f.clone()));
                        }
                    }

                    if let Some(m) = &patch.model {
                        if m.is_empty() {
                            obj.as_object_mut().map(|o| o.remove("model"));
                            next.remove("models");
                        } else {
                            let old_full = obj
                                .get("model")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let old_mid = old_full.strip_prefix(&prefix).map(str::to_string);
                            let mut models = next
                                .get("models")
                                .and_then(|v| v.as_object())
                                .cloned()
                                .unwrap_or_default();
                            let mut entry = if old_mid.as_deref() == Some(m.as_str()) {
                                models
                                    .get(m)
                                    .cloned()
                                    .unwrap_or_else(|| serde_json::json!({}))
                                    .as_object()
                                    .cloned()
                                    .unwrap_or_default()
                            } else {
                                serde_json::Map::new()
                            };
                            entry.insert("name".into(), serde_json::Value::String(m.clone()));
                            let cmap = if patch.context.is_some() {
                                patch
                                    .context
                                    .as_ref()
                                    .and_then(|c| context_to_number(c))
                                    .map(|n| serde_json::Value::Number(n.into()))
                            } else {
                                None
                            };
                            match cmap {
                                Some(v) => {
                                    entry.insert("contextWindow".into(), v);
                                }
                                None if patch.context.is_some() => {
                                    entry.remove("contextWindow");
                                }
                                None => {}
                            }
                            if let Some(om) = old_mid {
                                if om != *m {
                                    models.remove(&om);
                                }
                            }
                            models.insert(m.clone(), serde_json::Value::Object(entry));
                            next.insert("models".into(), serde_json::Value::Object(models));
                            obj["model"] = serde_json::Value::String(format!("{prefix}{m}"));
                        }
                    }

                    let has_content = next
                        .get("npm")
                        .and_then(|v| v.as_str())
                        .map(|s| !s.is_empty())
                        .unwrap_or(false)
                        || next
                            .get("options")
                            .map(|o| !o.as_object().map(|x| x.is_empty()).unwrap_or(true))
                            .unwrap_or(false)
                        || next
                            .get("models")
                            .map(|m| !m.as_object().map(|x| x.is_empty()).unwrap_or(true))
                            .unwrap_or(false);
                    if has_content {
                        providers.insert(provider.into(), serde_json::Value::Object(next));
                    } else {
                        providers.remove(provider);
                    }
                    if providers.is_empty() {
                        obj.as_object_mut().map(|o| o.remove("provider"));
                    } else {
                        obj["provider"] = serde_json::Value::Object(providers);
                    }
                    write_json(&cfg.to_string_lossy(), &obj);
                }
            }),
        }
    };
    let d = cfg.parent().unwrap().to_path_buf();
    Box::new(SimpleAdapter {
        id: "opencode",
        name: "OpenCode",
        detect: Box::new(move || dir_exists(&d.to_string_lossy()) || on_path("opencode")),
        config_path: Box::new({
            let cfg = cfg.clone();
            move || cfg.to_string_lossy().to_string()
        }),
        cap: Some(cap),
    })
}

/* helpers for mapping optional strings/TOML values */
fn toml_val_str(v: &toml::Value) -> Option<String> {
    match v {
        toml::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

fn opt_str(s: &str) -> Option<toml::Value> {
    if s.is_empty() {
        None
    } else {
        Some(toml::Value::String(s.to_string()))
    }
}

fn toml_nonempty(v: &toml::Value) -> bool {
    match v {
        toml::Value::String(s) => !s.is_empty(),
        other => other != &toml::Value::String(String::new()),
    }
}
