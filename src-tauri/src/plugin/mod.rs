/* ---------------- plugin platform: manifest model + shared constants ----------------
Spec: docs/PLUGIN_PLATFORM.md. Vocabulary: CONTEXT.md.

A plugin is a folder holding `plugin.json` and an ES module entry. This
module owns the manifest types, the permission vocabulary, and the error
type every other plugin submodule reports through. Nothing here touches
Tauri or the filesystem beyond what a caller hands in, so the whole model
is unit-testable without a running app. */

use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::{Component, Path, PathBuf};

pub mod boot;
pub mod cli;
pub mod commands;
pub mod data;
pub mod marketplace;
pub mod registry;
pub mod scheme;
pub mod validate;

/// API surface version this build implements. A plugin declaring anything
/// else is refused outright — the shape of `ctx` and the contribution ids are
/// not negotiable at runtime (docs/adr/0001).
pub const API_VERSION: u32 = 1;

/// Publisher reserved for plugins shipped inside the app.
pub const RESERVED_PUBLISHER: &str = "bentomux";

/// Hard ceiling on an installed plugin's unpacked size. Plugins are code the
/// app loads into its own realm, so an unbounded bundle is a denial of
/// service on the shell itself.
pub const MAX_PLUGIN_BYTES: u64 = 5 * 1024 * 1024;

/// Permission names the host understands. Anything else in a manifest is a
/// validation error, so a typo cannot silently grant nothing.
pub const PERMISSIONS: &[&str] = &[
    "storage",
    "app.read",
    "app.prefs.write",
    "app.window",
    "files.temp",
    "workspaces.write",
    "tabs.write",
    "terminal.read",
    "terminal.input",
    "git.read",
    "git.push",
    "agents.read",
    "agents.write",
    "remote.control",
    "backend.invoke",
];

/// Commands a plugin may reach through `backend.invoke`. Read-only on
/// purpose: every entry here is a capability handed to *every* installed
/// plugin, so extending it is a security review, not a convenience.
pub const BACKEND_ALLOWLIST: &[&str] = &[
    "get_state",
    "git_status",
    "git_diff",
    "git_diff_stat",
    "git_remote_info",
    "git_branch_for",
    "agents_list",
    "agents_config",
    "res_list",
    "agent_hooks_status",
    "remote_info",
];

/// Contribution kinds, in the order the Studio review screen lists them.
pub const CONTRIBUTION_KINDS: &[&str] = &[
    "commands", "topbar", "sidebar", "dock", "tabs", "modals", "widgets", "settings", "services",
];

/* ---------------- errors ---------------- */

#[derive(Debug)]
pub enum PluginError {
    Io(String),
    Manifest(String),
    Validation(Vec<String>),
    NotFound(String),
    Conflict(String),
    Unsupported(String),
}

impl fmt::Display for PluginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PluginError::Io(m) => write!(f, "io error: {}", m),
            PluginError::Manifest(m) => write!(f, "manifest error: {}", m),
            PluginError::Validation(items) => write!(f, "{}", items.join("; ")),
            PluginError::NotFound(m) => write!(f, "not found: {}", m),
            PluginError::Conflict(m) => write!(f, "conflict: {}", m),
            PluginError::Unsupported(m) => write!(f, "unsupported: {}", m),
        }
    }
}

impl std::error::Error for PluginError {}

impl From<std::io::Error> for PluginError {
    fn from(e: std::io::Error) -> Self {
        PluginError::Io(e.to_string())
    }
}

pub type PluginResult<T> = Result<T, PluginError>;

/* ---------------- manifest ---------------- */

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_app_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub entry: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<PluginIcon>,
    #[serde(default)]
    pub permissions: Vec<String>,
    /// HTTPS origins the plugin may fetch() or load images from. Baked into
    /// connect-src/img-src at build time by scripts/gen-plugin-csp.mjs; shown
    /// in the install review alongside permissions.
    #[serde(default)]
    pub network: Vec<String>,
    #[serde(default)]
    pub contributes: Contributions,
}

/// A plugin icon is never inline markup: `dom.ts` reserves innerHTML for
/// compile-time constants and forbids file content, so the host accepts a
/// builtin icon name or an image path it serves over `plugin://`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum PluginIcon {
    Builtin { name: String },
    Image { path: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Contributions {
    pub commands: Vec<Contribution>,
    pub topbar: Vec<Contribution>,
    pub sidebar: Vec<Contribution>,
    pub dock: Vec<Contribution>,
    pub tabs: Vec<Contribution>,
    pub modals: Vec<Contribution>,
    pub widgets: Vec<Contribution>,
    pub settings: Vec<Contribution>,
    pub services: Vec<Contribution>,
}

impl Contributions {
    /// Every contribution across every kind, for id-uniqueness and namespace
    /// checks that must not care which surface a contribution targets.
    pub fn all(&self) -> Vec<(&'static str, &Contribution)> {
        let mut out: Vec<(&'static str, &Contribution)> = Vec::new();
        for (kind, list) in self.lists() {
            for c in list {
                out.push((kind, c));
            }
        }
        out
    }

    pub fn lists(&self) -> [(&'static str, &Vec<Contribution>); 9] {
        [
            ("commands", &self.commands),
            ("topbar", &self.topbar),
            ("sidebar", &self.sidebar),
            ("dock", &self.dock),
            ("tabs", &self.tabs),
            ("modals", &self.modals),
            ("widgets", &self.widgets),
            ("settings", &self.settings),
            ("services", &self.services),
        ]
    }

    /// Ids of declared commands — the set a button may point at.
    pub fn command_ids(&self) -> Vec<&str> {
        self.commands.iter().map(|c| c.id.as_str()).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.all().is_empty()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contribution {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<PluginIcon>,
    /// Command fired by a topbar / sidebar / dock entry. Absent on kinds that
    /// render their own body (tabs, modals, widgets, settings, services).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

/* ---------------- registry records ---------------- */

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub id: String,
    pub version: String,
    /// The version a rollback would restore. Kept until a third version
    /// arrives, then garbage-collected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_version: Option<String>,
    pub enabled: bool,
    pub source: PluginSource,
    /// sha256 of the installed tree, so an update can be diffed and a
    /// tampered install detected.
    pub sha256: String,
    pub installed_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PluginSource {
    /// Shipped inside the app under the reserved publisher.
    Bundled,
    Folder {
        path: String,
    },
    Url {
        url: String,
        /// `owner/name` on GitHub, when the install came from the marketplace.
        ///
        /// This is the join key between a catalog row and an installed
        /// plugin: a repo name is not a plugin id, and guessing
        /// `owner/name` → `owner.name` is wrong often enough to strand a user
        /// on an old version. `default` because records written before this
        /// field existed must still load.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repo: Option<String>,
    },
}

impl PluginRecord {
    pub fn new(id: String, version: String, source: PluginSource, sha256: String) -> Self {
        PluginRecord {
            id,
            version,
            previous_version: None,
            enabled: true,
            source,
            sha256,
            installed_at: now_millis(),
        }
    }
}

pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ---------------- path safety ---------------- */

/// Join `rel` onto `root`, refusing anything that could escape it: absolute
/// paths, drive/prefix components, and `..` anywhere in the chain. Every
/// path a plugin controls (entry, icon, an asset the scheme serves) goes
/// through here — a plugin folder is untrusted input even when the user
/// installed it on purpose.
///
/// Returns `Some` for a path that is inside the root but does not exist yet,
/// so callers can tell "missing" apart from "forbidden". Those are different
/// errors with different fixes, and an authoring agent branches on the code.
///
/// The containment check canonicalizes the deepest ancestor that exists
/// rather than the leaf: a symlinked *directory* inside the plugin can
/// otherwise point outside it while the leaf itself is absent, and the leaf
/// is exactly what a request for a not-yet-created file looks like.
pub fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        return None;
    }
    for comp in candidate.components() {
        match comp {
            Component::Normal(_) => {}
            _ => return None,
        }
    }

    let real_root = root.canonicalize().ok()?;
    let joined = root.join(candidate);

    /* the leaf exists: canonicalize it and require containment. This also
    resolves a symlinked leaf to its real target, so a link pointing out
    of the plugin folder is caught here. */
    if let Ok(real_joined) = joined.canonicalize() {
        return if real_joined.starts_with(&real_root) {
            Some(real_joined)
        } else {
            None
        };
    }

    /* the leaf is absent. Walk up to the deepest ancestor that exists and
    check *that* for containment — otherwise a symlinked directory inside
    the plugin could point outside it while the leaf itself is missing,
    which is exactly what a not-yet-created file looks like. */
    let mut probe = joined.parent()?;
    loop {
        if let Ok(real_probe) = probe.canonicalize() {
            if !real_probe.starts_with(&real_root) {
                return None;
            }
            let tail = joined.strip_prefix(probe).ok()?;
            return Some(real_probe.join(tail));
        }
        probe = probe.parent()?;
    }
}

/// The manifest's `id` shape: `publisher.name`, both segments `[a-z0-9-]+`.
pub fn valid_id(id: &str) -> bool {
    let mut parts = id.split('.');
    let (Some(publisher), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let segment_ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && !s.starts_with('-')
            && !s.ends_with('-')
    };
    segment_ok(publisher) && segment_ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_shape_is_publisher_dot_name() {
        assert!(valid_id("acme.habit-tracker"));
        assert!(valid_id("bentomux.session-notes"));
        assert!(!valid_id("habit-tracker"), "single segment rejected");
        assert!(!valid_id("acme.tracker.extra"), "three segments rejected");
        assert!(!valid_id("Acme.tracker"), "uppercase rejected");
        assert!(!valid_id("acme."), "empty name rejected");
        assert!(!valid_id(".tracker"), "empty publisher rejected");
        assert!(!valid_id("acme.tra_cker"), "underscore rejected");
        assert!(!valid_id("acme.-tracker"), "leading dash rejected");
        assert!(!valid_id("acme.tracker-"), "trailing dash rejected");
    }

    #[test]
    fn safe_join_rejects_traversal_and_absolute_paths() {
        let dir = std::env::temp_dir().join(format!("bentomux-paths-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.js"), "export {}").unwrap();
        std::fs::write(dir.join("assets").join("icon.svg"), "<svg/>").unwrap();

        assert!(safe_join(&dir, "index.js").is_some());
        assert!(safe_join(&dir, "assets/icon.svg").is_some());
        assert!(safe_join(&dir, "../escape.js").is_none());
        assert!(safe_join(&dir, "assets/../../escape.js").is_none());
        assert!(safe_join(&dir, "/etc/passwd").is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    /* "missing" and "forbidden" are different answers: a caller that cannot
    tell them apart reports the wrong fix to an authoring agent */
    #[test]
    fn safe_join_distinguishes_missing_from_forbidden() {
        let dir = std::env::temp_dir().join(format!("bentomux-paths2-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("assets")).unwrap();

        let missing = safe_join(&dir, "not-yet-written.js");
        assert!(
            missing.is_some(),
            "an absent file inside the root is not an escape"
        );
        assert!(!missing.unwrap().exists());

        let missing_nested = safe_join(&dir, "assets/deep/also-missing.js");
        assert!(
            missing_nested.is_some(),
            "absent intermediate dirs are fine too"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /* a symlinked directory must not become a way out of the plugin folder,
    even when the leaf under it does not exist yet */
    #[cfg(unix)]
    #[test]
    fn safe_join_refuses_a_symlinked_directory_escape() {
        let base = std::env::temp_dir().join(format!("bentomux-paths3-{}", std::process::id()));
        let root = base.join("plugin");
        let outside = base.join("outside");
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "private").unwrap();

        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        assert!(
            safe_join(&root, "link/secret.txt").is_none(),
            "existing leaf reached through a link"
        );
        assert!(
            safe_join(&root, "link/absent.txt").is_none(),
            "an absent leaf under a symlinked dir is still an escape"
        );

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn contribution_kinds_cover_every_list() {
        let c = Contributions::default();
        let lists = c.lists();
        assert_eq!(lists.len(), CONTRIBUTION_KINDS.len());
        for (i, kind) in CONTRIBUTION_KINDS.iter().enumerate() {
            assert_eq!(
                lists[i].0, *kind,
                "kind order must match the Studio review list"
            );
        }
    }

    #[test]
    fn manifest_round_trips_camel_case() {
        let raw = serde_json::json!({
            "id": "acme.habit-tracker",
            "name": "Habit Tracker",
            "version": "1.0.0",
            "apiVersion": 1,
            "minAppVersion": "0.3.0",
            "entry": "index.js",
            "permissions": ["storage"],
            "network": ["https://api.acme.test"],
            "contributes": {
                "commands": [{ "id": "acme.habit-tracker.open", "title": "Open" }]
            }
        });
        let m: PluginManifest = serde_json::from_value(raw).unwrap();
        assert_eq!(m.network, vec!["https://api.acme.test"]);
        assert_eq!(m.api_version, 1);
        assert_eq!(m.min_app_version.as_deref(), Some("0.3.0"));
        assert_eq!(m.contributes.command_ids(), vec!["acme.habit-tracker.open"]);
        assert_eq!(m.contributes.topbar.len(), 0);
        assert_eq!(m.contributes.all().len(), 1);
    }

    #[test]
    fn unknown_keys_are_refused() {
        let raw = serde_json::json!({
            "id": "acme.x", "name": "X", "version": "1.0.0",
            "apiVersion": 1, "entry": "index.js",
            "contributes": { "topbars": [] }
        });
        assert!(
            serde_json::from_value::<PluginManifest>(raw).is_err(),
            "a typo'd contribution key must fail loudly, not silently contribute nothing"
        );
    }
}
