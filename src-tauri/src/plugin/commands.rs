/* ---------------- plugin platform: IPC commands ----------------
Spec: docs/PLUGIN_PLATFORM.md §8, §11.

Every command here is reachable from the renderer's bridge. Mutating ones
go through AppStateManager::patch_state so the registry is persisted in the
same call that changes it — the plugin list must never be ahead of disk. */

use serde::Serialize;
use tauri::{Manager, State};

use crate::plugin::boot;
use crate::plugin::data;
use crate::plugin::marketplace;
use crate::plugin::registry;
use crate::plugin::validate::{self, ValidateOptions, ValidationReport};
use crate::plugin::{PluginError, PluginRecord, PluginResult, PluginSource};
use crate::state::{AppState, AppStateManager};

/* ---------------- errors on the wire ---------------- */

/// Commands hand the renderer a structured error rather than a bare string,
/// so Plugin Studio can show a validation report as a list instead of one
/// wall of prose. `code` is stable; `messages` is what a human reads.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub messages: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<ValidationReport>,
}

impl From<PluginError> for CommandError {
    fn from(e: PluginError) -> Self {
        match e {
            PluginError::Validation(messages) => CommandError {
                code: "validation".into(),
                message: messages.join("; "),
                messages,
                report: None,
            },
            other => CommandError {
                code: match other {
                    PluginError::Io(_) => "io",
                    PluginError::Manifest(_) => "manifest",
                    PluginError::NotFound(_) => "not-found",
                    PluginError::Conflict(_) => "conflict",
                    PluginError::Unsupported(_) => "unsupported",
                    PluginError::Validation(_) => unreachable!(),
                }
                .into(),
                message: other.to_string(),
                messages: vec![],
                report: None,
            },
        }
    }
}

impl From<PluginError> for String {
    fn from(e: PluginError) -> Self {
        serde_json::to_string(&CommandError::from(e))
            .unwrap_or_else(|_| "{\"code\":\"io\",\"message\":\"unknown error\"}".to_string())
    }
}

/* ---------------- paths ---------------- */

/// Resolve the plugin directories from the app data dir, with bundled plugins
/// picked up from the packaged resources when present.
fn plugin_paths(app: &tauri::AppHandle) -> PluginResult<registry::PluginPaths> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| PluginError::Io(format!("app data dir unavailable: {}", e)))?;
    let mut paths = registry::PluginPaths::new(&base);

    /* bundled plugins ship as a resource directory. The dev fallback mirrors
    bridge.rs: the bundler rewrites a leading `..` to `_up_`, and running
    from a source tree has no resource dir at all. */
    if let Ok(dir) = app.path().resolve(
        "../resources/plugin-bundled",
        tauri::path::BaseDirectory::Resource,
    ) {
        if dir.is_dir() {
            paths = paths.with_bundled(dir);
        }
    }
    Ok(paths)
}

/* ---------------- listing ---------------- */

#[tauri::command]
pub fn plugin_list(state: State<'_, AppStateManager>) -> Vec<PluginRecord> {
    state.get_state().plugins
}

/// Native folder picker for the install flow. Separate from `workspace_choose`
/// so the dialog carries plugin wording — the two are different actions and a
/// user should not have to guess which one they are in.
#[tauri::command]
pub fn plugin_choose_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose a plugin folder")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

/// Native file picker for a plugin archive. The renderer cannot reach the
/// filesystem, so the path has to come from an OS dialog.
#[tauri::command]
pub fn plugin_choose_zip() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose a plugin package")
        .add_filter("Plugin package", &["zip"])
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

/// Where the Creator wizard should put a new plugin: an empty folder the user
/// picks. Separate from `plugin_choose_folder` because creating a plugin is
/// not installing one, and the wizard must not overwrite an existing project.
#[tauri::command]
pub fn plugin_choose_new_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose an empty folder for the new plugin")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

/* ---------------- template scaffolding ---------------- */

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub name: String,
    pub contributes: Vec<String>,
}

/// The templates available to the Creator, read from the bundled resources.
/// Read from disk rather than hardcoded so a template added to the repo shows
/// up without a code change.
#[tauri::command]
pub fn plugin_templates(app: tauri::AppHandle) -> Vec<TemplateInfo> {
    let Some(root) = templates_root(&app) else {
        return vec![];
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return vec![];
    };

    let mut out: Vec<TemplateInfo> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let manifest_path = e.path().join("plugin.json");
            let text = std::fs::read_to_string(&manifest_path).ok()?;
            let raw: serde_json::Value = serde_json::from_str(&text).ok()?;
            let contributes = raw
                .get("contributes")
                .and_then(|c| c.as_object())
                .map(|m| m.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            Some(TemplateInfo { name, contributes })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Scaffold a plugin from a template into `dest`.
///
/// Refuses a non-empty destination: the wizard must never overwrite a folder
/// the user already has work in, and a half-overwritten plugin is worse than
/// a refused one. Placeholders are substituted here rather than in the
/// renderer so the same code path serves the CLI and the app.
#[tauri::command]
pub fn plugin_scaffold(
    template: String,
    dest: String,
    id: String,
    name: String,
    version: String,
    description: String,
    author: String,
    app: tauri::AppHandle,
) -> Result<ValidationReport, String> {
    use crate::plugin::validate::{validate_dir_with, ValidateOptions};

    let Some(root) = templates_root(&app) else {
        return Err(String::from(PluginError::NotFound(
            "plugin templates are not bundled with this build".into(),
        )));
    };
    /* the template name comes from the renderer, so it is untrusted input:
    resolve it through safe_join rather than joining a raw string */
    let source = crate::plugin::safe_join(&root, &template)
        .ok_or_else(|| String::from(PluginError::NotFound(format!("template `{}`", template))))?;
    if !source.is_dir() {
        return Err(String::from(PluginError::NotFound(format!(
            "template `{}`",
            template
        ))));
    }

    let dest_path = std::path::Path::new(&dest);
    if dest_path.exists() {
        let empty = std::fs::read_dir(dest_path)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false);
        if !empty {
            return Err(String::from(PluginError::Conflict(format!(
                "{} already exists and is not empty",
                dest
            ))));
        }
    }
    std::fs::create_dir_all(dest_path).map_err(|e| String::from(PluginError::Io(e.to_string())))?;

    let values = [
        ("id", id.as_str()),
        ("name", name.as_str()),
        ("version", version.as_str()),
        ("description", description.as_str()),
        ("author", author.as_str()),
    ];

    copy_scaffold(&source, dest_path, &values).map_err(String::from)?;

    /* validate what we just wrote: a scaffold that does not validate is a bug
    in the template, and the user should hear about it immediately rather
    than after writing code against it */
    let report = validate_dir_with(dest_path, &ValidateOptions::default());
    Ok(report)
}

fn copy_scaffold(
    from: &std::path::Path,
    to: &std::path::Path,
    values: &[(&str, &str)],
) -> PluginResult<()> {
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.metadata()?.is_dir() {
            std::fs::create_dir_all(&dst)?;
            copy_scaffold(&src, &dst, values)?;
            continue;
        }
        let text = std::fs::read_to_string(&src)?;
        let mut filled = text;
        for (key, value) in values {
            filled = filled.replace(&format!("{{{{{}}}}}", key), value);
        }
        std::fs::write(&dst, filled)?;
    }
    Ok(())
}

fn templates_root(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .resolve(
            "../resources/plugin-templates",
            tauri::path::BaseDirectory::Resource,
        )
        .ok()
        .filter(|d| d.is_dir())
}

/* ---------------- authoring skill ---------------- */

const SKILL_ID: &str = "bentomux-plugin-author";

/// Where each agent runtime keeps its skills, as (agent id, display name,
/// directory). Only agents whose skill directory this app already manages are
/// listed: installing into a runtime whose layout we do not understand would
/// be guessing.
fn skill_targets(home: &std::path::Path) -> Vec<(String, String, std::path::PathBuf)> {
    vec![(
        "claude".to_string(),
        "Claude Code".to_string(),
        home.join(".claude").join("skills"),
    )]
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTarget {
    pub agent_id: String,
    pub agent_name: String,
    pub path: String,
    /// The skill is already installed there.
    pub installed: bool,
}

/// The agent skill directories this build can install into.
#[tauri::command]
pub fn plugin_skill_targets() -> Vec<SkillTarget> {
    let Some(home) = dirs::home_dir() else {
        return vec![];
    };
    skill_targets(&home)
        .into_iter()
        .map(|(agent_id, agent_name, dir)| {
            let installed = dir.join(SKILL_ID).join("SKILL.md").is_file();
            SkillTarget {
                agent_id,
                agent_name,
                path: dir.to_string_lossy().to_string(),
                installed,
            }
        })
        .collect()
}

/// Copy the authoring skill into an agent's skills directory.
///
/// The skill is a folder, not a single file: its reference documents and
/// examples are what make it useful, and the app's own Skills UI reads only
/// `SKILL.md`. That means the skill appears in that UI, but editing it there
/// touches only `SKILL.md` — the references must be edited on disk. That is a
/// deliberate trade: it avoids reshaping the agent-resources subsystem, which
/// is stable and serves every other resource kind.
#[tauri::command]
pub fn plugin_install_skill(agent_id: String, app: tauri::AppHandle) -> Result<String, String> {
    let Some(home) = dirs::home_dir() else {
        return Err(String::from(PluginError::Io("no home directory".into())));
    };
    let Some((_, _, root)) = skill_targets(&home)
        .into_iter()
        .find(|(id, _, _)| *id == agent_id)
    else {
        return Err(String::from(PluginError::NotFound(format!(
            "agent `{}` has no known skills directory",
            agent_id
        ))));
    };

    let source = app
        .path()
        .resolve(
            "../resources/plugin-skill/bentomux-plugin-author",
            tauri::path::BaseDirectory::Resource,
        )
        .ok()
        .filter(|d| d.is_dir())
        .ok_or_else(|| {
            String::from(PluginError::NotFound(
                "the authoring skill is not bundled with this build".into(),
            ))
        })?;

    let dest = root.join(SKILL_ID);
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| String::from(PluginError::Io(e.to_string())))?;
    }
    std::fs::create_dir_all(&dest).map_err(|e| String::from(PluginError::Io(e.to_string())))?;
    copy_scaffold(&source, &dest, &[]).map_err(String::from)?;

    Ok(dest.to_string_lossy().to_string())
}

/// Validate a folder or a packaged `.zip` the user picked, without installing
/// it. This is what Plugin Studio calls before showing the "Install" button.
#[tauri::command]
pub fn plugin_validate(path: String, bundled: Option<bool>) -> ValidationReport {
    let opts = ValidateOptions {
        bundled: bundled.unwrap_or(false),
    };
    validate::validate_path_with(std::path::Path::new(&path), &opts)
}

/// Read a manifest from an installed plugin, for the Studio detail screen.
#[tauri::command]
pub fn plugin_manifest(
    id: String,
    app: tauri::AppHandle,
    state: State<'_, AppStateManager>,
) -> Result<crate::plugin::PluginManifest, String> {
    let paths = plugin_paths(&app).map_err(String::from)?;
    let record = state
        .get_state()
        .plugins
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| String::from(PluginError::NotFound(id.clone())))?;
    let dir = paths.version_dir(&record.id, &record.version);
    validate::read_manifest_unchecked(&dir).map_err(String::from)
}

/* ---------------- install / update ---------------- */

#[tauri::command]
pub fn plugin_install_folder(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppStateManager>,
) -> Result<PluginRecord, String> {
    let paths = plugin_paths(&app).map_err(String::from)?;
    let record =
        registry::install_from_folder(&paths, std::path::Path::new(&path)).map_err(String::from)?;

    state.patch_state(|s| {
        /* reinstalling replaces the record rather than duplicating it */
        s.plugins.retain(|r| r.id != record.id);
        s.plugins.push(record.clone());
    });
    Ok(record)
}

#[tauri::command]
pub fn plugin_install_zip(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppStateManager>,
) -> Result<PluginRecord, String> {
    let paths = plugin_paths(&app).map_err(String::from)?;
    let record =
        registry::install_from_zip(&paths, std::path::Path::new(&path)).map_err(String::from)?;

    state.patch_state(|s| {
        s.plugins.retain(|r| r.id != record.id);
        s.plugins.push(record.clone());
    });
    Ok(record)
}

/// Install from an HTTPS URL with a pinned digest. The digest is required:
/// without it the URL owner could change what code the app runs.
#[tauri::command]
pub async fn plugin_install_url(
    url: String,
    sha256: String,
    app: tauri::AppHandle,
    state: State<'_, AppStateManager>,
) -> Result<PluginRecord, String> {
    let paths = plugin_paths(&app).map_err(String::from)?;
    /* blocking HTTP on a worker thread: the download must not stall the
    webview's IPC thread while the user watches a spinner */
    let record = tauri::async_runtime::spawn_blocking(move || {
        registry::install_from_url(&paths, &url, &sha256)
    })
    .await
    .map_err(|e| format!("{{\"code\":\"io\",\"message\":\"{}\"}}", e))?
    .map_err(String::from)?;

    state.patch_state(|s| {
        s.plugins.retain(|r| r.id != record.id);
        s.plugins.push(record.clone());
    });
    Ok(record)
}

/* ---------------- marketplace ---------------- */

/// Where the saved catalog lives. GitHub's unauthenticated limit is 60 requests
/// per hour per IP, so the sweep is cached and reused rather than repeated on
/// every open of the marketplace.
fn marketplace_cache(app: &tauri::AppHandle) -> PluginResult<std::path::PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| PluginError::Io(format!("app data dir unavailable: {}", e)))?;
    Ok(base.join("plugin-marketplace.json"))
}

/**
 * The plugin marketplace, served from GitHub.
 *
 * Cache first: a fresh catalog comes back without touching the network at all,
 * which is both the common case and the only way this fits inside the
 * unauthenticated rate limit. A failed sweep falls back to the saved catalog
 * marked stale — an empty list with no explanation is worse than yesterday's
 * data labelled as yesterday's.
 *
 * `force` backs the Refresh button.
 */
#[tauri::command]
pub async fn plugin_marketplace_index(
    app: tauri::AppHandle,
    state: State<'_, AppStateManager>,
    force: Option<bool>,
) -> Result<marketplace::Catalog, String> {
    let cache = marketplace_cache(&app).map_err(String::from)?;
    let records = state.get_state().plugins;

    if !force.unwrap_or(false) {
        if let Some(mut cached) = marketplace::read_cache(&cache) {
            if !marketplace::is_stale(&cached, super::now_millis()) {
                marketplace::annotate(&mut cached.plugins, &records);
                return Ok(cached);
            }
        }
    }

    let sweep_cache = cache.clone();
    let swept = tauri::async_runtime::spawn_blocking(move || {
        let plugins = marketplace::sweep()?;
        marketplace::write_cache(&sweep_cache, plugins, super::now_millis())
    })
    .await
    .map_err(|e| format!("{{\"code\":\"io\",\"message\":\"{}\"}}", e));

    let mut catalog = match swept {
        Ok(Ok(())) => marketplace::read_cache(&cache).unwrap_or_default(),
        Ok(Err(e)) => stale_or_fail(&cache, e.to_string())?,
        Err(json) => stale_or_fail(&cache, json)?,
    };
    /* The sweep knows nothing about this machine's installs, so the join is
       done here, on every response — cached or fresh. Doing it inside the
       sweep would bake one user's installed set into a file another user reads. */
    marketplace::annotate(&mut catalog.plugins, &records);
    Ok(catalog)
}

/// Serve the saved catalog with the reason it is out of date, or report the
/// failure outright when there is nothing saved to fall back on.
fn stale_or_fail(cache: &std::path::Path, reason: String) -> Result<marketplace::Catalog, String> {
    match marketplace::read_cache(cache) {
        Some(mut cached) => {
            cached.stale = true;
            cached.stale_reason = reason;
            Ok(cached)
        }
        None => Err(reason),
    }
}

/**
 * Install a plugin the user picked out of the marketplace.
 *
 * Separate from `plugin_install_zip` for one reason: it records the GitHub repo
 * on the install, and that repo is the only reliable join between a catalog row
 * and an installed plugin. A hand-picked zip has no repo and therefore never
 * matches a row — it shows no update, which is the honest answer for a plugin
 * the app cannot trace.
 */
/**
 * Install a plugin the user picked out of the marketplace.
 *
 * Separate from `plugin_install_zip` for one reason: it records the GitHub repo
 * on the install, and that repo is the only reliable join between a catalog row
 * and an installed plugin. A hand-picked zip has no repo and therefore never
 * matches a row — it shows no update, which is the honest answer for a plugin
 * the app cannot trace.
 *
 * The body lives in `install_from_marketplace` so it can be tested without a
 * running Tauri app; this wrapper only unwraps the command arguments.
 */
#[tauri::command]
pub fn plugin_marketplace_install(
    path: String,
    repo: String,
    url: String,
    app: tauri::AppHandle,
    state: State<'_, AppStateManager>,
) -> Result<PluginRecord, String> {
    let paths = plugin_paths(&app).map_err(String::from)?;
    install_from_marketplace(&paths, &state, &path, &repo, &url).map_err(String::from)
}

/**
 * `patch_state_sync`, not `patch_state`: an install has already copied code to
 * disk, so a debounced record write that never lands leaves version directories
 * with no registry entry pointing at them. A human clicks this once, so the
 * "coalesce rapid bursts" argument for debouncing does not apply.
 */
fn install_from_marketplace(
    paths: &registry::PluginPaths,
    state: &AppStateManager,
    path: &str,
    repo: &str,
    url: &str,
) -> PluginResult<PluginRecord> {
    let mut record = registry::install_from_zip(paths, std::path::Path::new(path))?;
    record.source = PluginSource::Url {
        url: url.to_string(),
        repo: Some(repo.to_string()),
    };

    state.patch_state_sync(|s| {
        /* installing over an existing id is an update by another name; one
           record per plugin keeps the list and the rollback target sane */
        s.plugins.retain(|r| r.id != record.id);
        s.plugins.push(record.clone());
    });
    Ok(record)
}

/**
 * Update an installed plugin to the marketplace's latest release.
 */
#[tauri::command]
pub fn plugin_marketplace_update(
    path: String,
    sha256: String,
    repo: String,
    url: String,
    app: tauri::AppHandle,
    state: State<'_, AppStateManager>,
) -> Result<PluginRecord, String> {
    let paths = plugin_paths(&app).map_err(String::from)?;
    update_from_marketplace(&paths, &state, &path, &sha256, &repo, &url).map_err(String::from)
}

/// The update body. Three checks before anything touches the registry, in order
/// of what they protect the user from:
///
/// 1. **The digest, re-verified.** The renderer downloaded this file and
///    already checked it, but the decision is made across two IPC calls, so the
///    bytes are hashed again here rather than trusted from a path.
/// 2. **The manifest, read without installing.** It comes out of the archive,
///    not out of the catalog, so a repo cannot claim a version it does not ship.
/// 3. **Strictly newer.** Refused *before* `commit_update`, because committing
///    an equal or older version would set the rollback target to the version
///    already on disk — quietly destroying the only way back.
fn update_from_marketplace(
    paths: &registry::PluginPaths,
    state: &AppStateManager,
    path: &str,
    sha256: &str,
    repo: &str,
    url: &str,
) -> PluginResult<PluginRecord> {
    let archive = std::path::Path::new(path);
    let bytes = std::fs::read(archive)
        .map_err(|e| PluginError::Io(format!("reading the download: {}", e)))?;
    marketplace::verify_payload(sha256, &bytes)?;

    let fresh = peek_manifest(&bytes)?;

    let current = state
        .get_state()
        .plugins
        .into_iter()
        .find(|r| matches!(&r.source, PluginSource::Url { repo: Some(x), .. } if x == repo))
        .ok_or_else(|| {
            PluginError::NotFound(format!("{} is not installed from this repository", repo))
        })?;

    if fresh.id != current.id {
        return Err(PluginError::Conflict(format!(
            "this release is {} but the installed plugin is {}",
            fresh.id, current.id
        )));
    }
    if !marketplace::is_newer(&fresh.version, &current.version) {
        return Err(PluginError::Conflict(format!(
            "{} is already installed; this release is {}, which is not newer",
            current.id, fresh.version
        )));
    }

    let installed = registry::install_from_zip(paths, archive)?;

    let mut out: Option<PluginRecord> = None;
    state.patch_state_sync(|s| {
        if let Some(existing) = s.plugins.iter_mut().find(|r| r.id == installed.id) {
            registry::commit_update(paths, existing, &installed.version, installed.sha256.clone());
            /* keep the repo, or the next sweep forgets where this came from and
               the plugin silently stops being offered updates */
            existing.source = PluginSource::Url {
                url: url.to_string(),
                repo: Some(repo.to_string()),
            };
            out = Some(existing.clone());
        }
    });
    out.ok_or_else(|| PluginError::NotFound(installed.id))
}

/// Read the manifest out of a downloaded archive without installing it.
///
/// This is the one place an archive is opened twice — the peek cannot be
/// skipped without trusting the catalog's version claim, which is the very
/// thing under test. It unpacks a throwaway copy of bytes already on disk, into
/// a directory no other Bentomux on this machine will collide with.
fn peek_manifest(bytes: &[u8]) -> PluginResult<crate::plugin::PluginManifest> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = std::env::temp_dir().join(format!("bentomux-mp-peek-{}", stamp));
    let zip_path = root.with_extension("zip");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root)?;

    let result = (|| -> PluginResult<crate::plugin::PluginManifest> {
        std::fs::write(&zip_path, bytes)?;
        let file = std::fs::File::open(&zip_path)?;
        let mut zip = zip::ZipArchive::new(file)
            .map_err(|e| PluginError::Manifest(format!("not a readable zip: {}", e)))?;
        zip.extract_unwrapped_root_dir(&root, zip::read::root_dir_common_filter)
            .map_err(|e| PluginError::Io(format!("extract failed: {}", e)))?;
        validate::validate_for_install(&root, &ValidateOptions::default())
    })();

    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_file(&zip_path);
    result
}

/**
 * Download a release asset to a temp file, digest checked, and return its
 * path. The renderer then runs the ordinary `plugin_validate` → review →
 * `plugin_install_zip` sequence over it, so a marketplace install lands in
 * exactly the same audited flow as a zip the user picked by hand.
 */
#[tauri::command]
pub async fn plugin_fetch_url(url: String, sha256: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        marketplace::fetch_to_temp(&url, &sha256)
    })
    .await
    .map_err(|e| format!("{{\"code\":\"io\",\"message\":\"{}\"}}", e))?
    .map_err(String::from)
    .map(|p| p.to_string_lossy().into_owned())
}

/// A plugin's README at its release tag, as plain text.
///
/// Fetched on demand rather than during the sweep: one README per plugin would
/// double the request count for text the user has not asked to see yet.
#[tauri::command]
pub async fn plugin_marketplace_readme(
    repo: String,
    git_ref: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || marketplace::readme(&repo, &git_ref))
        .await
        .map_err(|e| format!("{{\"code\":\"io\",\"message\":\"{}\"}}", e))?
        .map_err(String::from)
}

/* ---------------- enable / disable ---------------- */

#[tauri::command]
pub fn plugin_set_enabled(
    id: String,
    enabled: bool,
    state: State<'_, AppStateManager>,
) -> Result<AppState, String> {
    let mut failure: Option<PluginError> = None;
    let next = state.patch_state(|s| {
        if let Err(e) = registry::set_enabled(&mut s.plugins, &id, enabled) {
            failure = Some(e);
        }
    });
    match failure {
        Some(e) => Err(String::from(e)),
        None => Ok(next),
    }
}

/* ---------------- update / rollback ---------------- */

/// Install a newer version and keep the outgoing one as the rollback target.
#[tauri::command]
pub fn plugin_update(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppStateManager>,
) -> Result<PluginRecord, String> {
    let paths = plugin_paths(&app).map_err(String::from)?;
    let fresh =
        registry::install_from_folder(&paths, std::path::Path::new(&path)).map_err(String::from)?;

    let mut out: Option<PluginRecord> = None;
    state.patch_state(|s| {
        if let Some(existing) = s.plugins.iter_mut().find(|r| r.id == fresh.id) {
            registry::commit_update(&paths, existing, &fresh.version, fresh.sha256.clone());
            out = Some(existing.clone());
        }
    });
    out.ok_or_else(|| String::from(PluginError::NotFound(fresh.id)))
}

#[tauri::command]
pub fn plugin_rollback(
    id: String,
    app: tauri::AppHandle,
    state: State<'_, AppStateManager>,
) -> Result<PluginRecord, String> {
    let paths = plugin_paths(&app).map_err(String::from)?;
    let mut out: Option<PluginRecord> = None;
    let mut failure: Option<PluginError> = None;

    state.patch_state(|s| {
        let Some(rec) = s.plugins.iter_mut().find(|r| r.id == id) else {
            failure = Some(PluginError::NotFound(id.clone()));
            return;
        };
        match registry::rollback(&paths, rec) {
            Ok(()) => out = Some(rec.clone()),
            Err(e) => failure = Some(e),
        }
    });

    match (out, failure) {
        (Some(r), _) => Ok(r),
        (None, Some(e)) => Err(String::from(e)),
        (None, None) => Err(String::from(PluginError::NotFound(id))),
    }
}

/* ---------------- uninstall ---------------- */

/// Remove the plugin. `remove_data` is the separate, explicit action: plugin
/// data survives a plain uninstall, because it belongs to the user.
#[tauri::command]
pub fn plugin_uninstall(
    id: String,
    remove_data: bool,
    app: tauri::AppHandle,
    state: State<'_, AppStateManager>,
) -> Result<AppState, String> {
    let paths = plugin_paths(&app).map_err(String::from)?;
    let mut failure: Option<PluginError> = None;

    let next = state.patch_state(|s| {
        if let Err(e) = registry::uninstall(&paths, &mut s.plugins, &id, remove_data) {
            failure = Some(e);
        }
    });

    match failure {
        Some(e) => Err(String::from(e)),
        None => Ok(next),
    }
}

/* ---------------- plugin data ---------------- */

#[tauri::command]
pub fn plugin_data_get(
    id: String,
    key: String,
    app: tauri::AppHandle,
) -> Result<Option<serde_json::Value>, String> {
    let paths = plugin_paths(&app).map_err(String::from)?;
    data::get(&paths, &id, &key).map_err(String::from)
}

#[tauri::command]
pub fn plugin_data_set(
    id: String,
    key: String,
    value: serde_json::Value,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let paths = plugin_paths(&app).map_err(String::from)?;
    data::set(&paths, &id, &key, value).map_err(String::from)
}

#[tauri::command]
pub fn plugin_data_delete(id: String, key: String, app: tauri::AppHandle) -> Result<(), String> {
    let paths = plugin_paths(&app).map_err(String::from)?;
    data::delete(&paths, &id, &key).map_err(String::from)
}

#[tauri::command]
pub fn plugin_data_keys(id: String, app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let paths = plugin_paths(&app).map_err(String::from)?;
    Ok(data::keys(&paths, &id))
}

/* ---------------- boot / safe mode ---------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeModeStatus {
    pub safe_mode: bool,
    pub attempts: u32,
    pub requested: bool,
}

#[tauri::command]
pub fn plugin_safe_mode(state: State<'_, AppStateManager>) -> SafeModeStatus {
    let s = state.get_state();
    SafeModeStatus {
        safe_mode: s.safe_mode,
        attempts: s.boot_attempts,
        requested: boot::requested_on_cli(),
    }
}

/// The renderer reports a successful first paint. Until this lands, the boot
/// attempt counter keeps climbing and the third attempt runs in safe mode.
#[tauri::command]
pub fn plugin_report_ready(state: State<'_, AppStateManager>) {
    boot::clear_boot(&state);
}

/// Leave safe mode for this session by re-enabling every plugin that safe
/// mode had suppressed, then reloading the window so activation runs again.
#[tauri::command]
pub fn plugin_leave_safe_mode(
    app: tauri::AppHandle,
    state: State<'_, AppStateManager>,
) -> Result<(), String> {
    state.patch_state(|s| {
        s.safe_mode = false;
        s.boot_attempts = 0;
    });
    /* a reload is the honest way back: plugin modules are already imported in
    this realm and cannot be unloaded, so re-activating them in place would
    double-register every contribution */
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval("window.location.reload()");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------------- marketplace update ---------------- */

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bentomux-scaffold-{}-{}", tag, std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A release zip of `id` at `version`, plus the digest the catalog would
    /// publish for it. Both come from one zip, which is the only way the two
    /// ever agree — exactly as they do for a real `gh release create`.
    fn release(root: &std::path::Path, id: &str, version: &str) -> (std::path::PathBuf, String) {
        let archive = root.join(format!("{}-{}.zip", id, version));
        let file = std::fs::File::create(&archive).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        writer.start_file("plugin.json", opts).unwrap();
        std::io::Write::write_all(
            &mut writer,
            format!(
                r#"{{"id":"{}","name":"T","version":"{}","apiVersion":1,"entry":"index.js",
                    "contributes":{{"commands":[{{"id":"{}.go","title":"Go"}}]}}}}"#,
                id, version, id
            )
            .as_bytes(),
        )
        .unwrap();
        writer.start_file("index.js", opts).unwrap();
        std::io::Write::write_all(&mut writer, b"export function activate() {}").unwrap();
        writer.finish().unwrap();

        let digest = crate::plugin::registry::sha256_bytes(&std::fs::read(&archive).unwrap());
        (archive, digest)
    }

    /// A stand-in for the release asset URL the catalog would carry.
    const ASSET: &str = "https://github.com/acme/t/releases/download/v2.0.0/t.zip";

    fn manager(root: &std::path::Path, tag: &str) -> AppStateManager {
        AppStateManager::new(root.join(format!("{}.json", tag)))
    }

    #[test]
    fn an_update_bumps_the_version_and_keeps_the_old_one_as_the_rollback_target() {
        let root = tmp("mp-update");
        let paths = registry::PluginPaths::new(&root);
        let mgr = manager(&root, "update");
        let repo = "acme/t";

        let (v1, _) = release(&root, "acme.t", "1.0.0");
        install_from_marketplace(&paths, &mgr, &v1.to_string_lossy(), repo, ASSET).unwrap();

        let (v2, d2) = release(&root, "acme.t", "1.1.0");
        let out = update_from_marketplace(
            &paths,
            &mgr,
            &v2.to_string_lossy(),
            &d2,
            repo,
            ASSET,
        )
        .unwrap();

        assert_eq!(out.version, "1.1.0");
        /* the whole point of commit_update: the way back is intact */
        assert_eq!(out.previous_version.as_deref(), Some("1.0.0"));
        assert!(paths.version_dir("acme.t", "1.0.0").is_dir());
        assert!(paths.version_dir("acme.t", "1.1.0").is_dir());

        /* and the provenance survives, or the next sweep offers no
           further update and the user cannot tell where the code came from */
        assert!(matches!(
            &out.source,
            PluginSource::Url { repo: Some(r), url } if r == repo && url == ASSET
        ));
        assert_eq!(v1.exists(), true, "sanity: the old zip is still on disk");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_update_to_the_same_version_is_refused_so_the_rollback_target_survives() {
        let root = tmp("mp-same");
        let paths = registry::PluginPaths::new(&root);
        let mgr = manager(&root, "same");
        let repo = "acme/t";

        let (v1, _) = release(&root, "acme.t", "1.0.0");
        install_from_marketplace(&paths, &mgr, &v1.to_string_lossy(), repo, ASSET).unwrap();

        let (v1_again, d) = release(&root, "acme.t", "1.0.0");
        let err = update_from_marketplace(
            &paths,
            &mgr,
            &v1_again.to_string_lossy(),
            &d,
            repo,
            ASSET,
        )
        .unwrap_err();
        assert!(err.to_string().contains("not newer"), "{}", err);

        /* unchanged on disk, and still no phantom rollback target */
        let record = mgr.get_state().plugins.into_iter().next().unwrap();
        assert_eq!(record.version, "1.0.0");
        assert_eq!(record.previous_version, None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_downgrade_through_update_is_refused() {
        let root = tmp("mp-down");
        let paths = registry::PluginPaths::new(&root);
        let mgr = manager(&root, "down");
        let repo = "acme/t";

        let (v2, _) = release(&root, "acme.t", "2.0.0");
        install_from_marketplace(&paths, &mgr, &v2.to_string_lossy(), repo, ASSET).unwrap();

        let (v1, d) = release(&root, "acme.t", "1.0.0");
        let err = update_from_marketplace(&paths, &mgr, &v1.to_string_lossy(), &d, repo, ASSET)
            .unwrap_err();
        assert!(err.to_string().contains("not newer"), "{}", err);
        assert_eq!(mgr.get_state().plugins[0].version, "2.0.0");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_release_that_is_a_different_plugin_is_refused() {
        let root = tmp("mp-id");
        let paths = registry::PluginPaths::new(&root);
        let mgr = manager(&root, "id");

        let (mine, _) = release(&root, "acme.t", "1.0.0");
        install_from_marketplace(&paths, &mgr, &mine.to_string_lossy(), "acme/t", ASSET).unwrap();

        /* a repo whose release swaps the plugin id inside the archive: the
           catalog cannot reach this, but the archive must still be believed */
        let (theirs, d) = release(&root, "evil.t", "9.9.9");
        let err = update_from_marketplace(&paths, &mgr, &theirs.to_string_lossy(), &d, "acme/t", ASSET)
            .unwrap_err();
        assert!(err.to_string().contains("installed plugin is"), "{}", err);
        assert_eq!(mgr.get_state().plugins.len(), 1);
        assert_eq!(mgr.get_state().plugins[0].id, "acme.t");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_update_with_a_wrong_digest_is_refused_before_anything_is_installed() {
        let root = tmp("mp-digest");
        let paths = registry::PluginPaths::new(&root);
        let mgr = manager(&root, "digest");

        let (v1, _) = release(&root, "acme.t", "1.0.0");
        install_from_marketplace(&paths, &mgr, &v1.to_string_lossy(), "acme/t", ASSET).unwrap();

        /* a tampered archive: valid zip, right plugin, wrong bytes vs digest */
        let (v2, _) = release(&root, "acme.t", "1.1.0");
        let wrong = "0".repeat(64);
        let err =
            update_from_marketplace(&paths, &mgr, &v2.to_string_lossy(), &wrong, "acme/t", ASSET)
                .unwrap_err();
        assert!(err.to_string().contains("sha256 mismatch"), "{}", err);
        /* nothing installed, no new version directory */
        assert!(!paths.version_dir("acme.t", "1.1.0").exists());
        assert_eq!(mgr.get_state().plugins[0].version, "1.0.0");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_update_for_a_repo_that_is_not_installed_is_refused() {
        let root = tmp("mp-norepo");
        let paths = registry::PluginPaths::new(&root);
        let mgr = manager(&root, "norepo");

        let (v1, _) = release(&root, "acme.t", "1.0.0");
        /* installed by hand from a folder, so no repo is recorded — the exact
           state a pre-marketplace install is left in */
        let record = registry::install_from_zip(&paths, &v1).unwrap();
        assert!(matches!(record.source, PluginSource::Folder { .. }));
        mgr.patch_state_sync(|s| s.plugins.push(record));

        let (v2, d) = release(&root, "acme.t", "1.1.0");
        let err =
            update_from_marketplace(&paths, &mgr, &v2.to_string_lossy(), &d, "acme/t", ASSET)
            .unwrap_err();
        assert!(matches!(err, PluginError::NotFound(_)), "{:?}", err);
        assert_eq!(mgr.get_state().plugins[0].version, "1.0.0");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_marketplace_install_replaces_an_existing_record_instead_of_duplicating_it() {
        let root = tmp("mp-dup");
        let paths = registry::PluginPaths::new(&root);
        let mgr = manager(&root, "dup");

        let (v1, _) = release(&root, "acme.t", "1.0.0");
        install_from_marketplace(&paths, &mgr, &v1.to_string_lossy(), "acme/t", ASSET).unwrap();
        let (v2, _) = release(&root, "acme.t", "2.0.0");
        install_from_marketplace(&paths, &mgr, &v2.to_string_lossy(), "acme/t", ASSET).unwrap();

        let state = mgr.get_state();
        assert_eq!(state.plugins.len(), 1, "one row per plugin");
        assert_eq!(state.plugins[0].version, "2.0.0");
        std::fs::remove_dir_all(&root).ok();
    }

    /* the substitution is what turns a template into a plugin; a missed
    placeholder would ship a manifest with a literal `{{id}}` in it */
    #[test]
    fn copy_scaffold_substitutes_every_placeholder() {
        let base = tmp("subst");
        let from = base.join("tpl");
        let to = base.join("out");
        std::fs::create_dir_all(&from).unwrap();
        /* the caller owns destination creation — plugin_scaffold does it */
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(
            from.join("plugin.json"),
            r#"{"id":"{{id}}","name":"{{name}}","version":"{{version}}"}"#,
        )
        .unwrap();

        copy_scaffold(
            &from,
            &to,
            &[
                ("id", "acme.x"),
                ("name", "X"),
                ("version", "1.0.0"),
                ("description", ""),
                ("author", ""),
            ],
        )
        .unwrap();

        let out = std::fs::read_to_string(to.join("plugin.json")).unwrap();
        assert_eq!(out, r#"{"id":"acme.x","name":"X","version":"1.0.0"}"#);
        assert!(!out.contains("{{"), "no placeholder may survive: {}", out);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn copy_scaffold_walks_nested_directories() {
        let base = tmp("nested");
        let from = base.join("tpl");
        std::fs::create_dir_all(from.join("assets")).unwrap();
        std::fs::write(from.join("assets").join("note.txt"), "{{name}}").unwrap();
        let to = base.join("out");

        copy_scaffold(&from, &to, &[("name", "Deep")]).unwrap();
        assert_eq!(
            std::fs::read_to_string(to.join("assets").join("note.txt")).unwrap(),
            "Deep"
        );

        std::fs::remove_dir_all(&base).ok();
    }
}
