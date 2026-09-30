/* ---------------- plugin platform: static validation ----------------
Spec: docs/PLUGIN_PLATFORM.md §11.

The Validator answers one question without executing anything: would this
folder install and activate cleanly? It is the surface an authoring agent
loops against (`bentomux --plugin-validate <dir> --json`), so every issue
carries a stable `code` the caller can branch on, and the report is
JSON-serializable as-is.

Deliberately NOT here: JavaScript syntax checking. That needs a parser the
app does not ship; the CLI surface shells out to `node --check` and the
in-app surface surfaces a SyntaxError at activation instead. */

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use super::{
    safe_join, valid_id, Contribution, Contributions, PluginError, PluginManifest, PluginResult,
    API_VERSION, MAX_PLUGIN_BYTES, PERMISSIONS, RESERVED_PUBLISHER,
};

/// Stable issue codes. An agent branches on these, so they are part of the
/// contract and must not be reworded casually.
pub mod codes {
    pub const MANIFEST_MISSING: &str = "manifest-missing";
    pub const MANIFEST_UNREADABLE: &str = "manifest-unreadable";
    pub const MANIFEST_INVALID: &str = "manifest-invalid";
    pub const ID_SHAPE: &str = "id-shape";
    pub const ID_RESERVED: &str = "id-reserved";
    pub const VERSION_INVALID: &str = "version-invalid";
    pub const API_VERSION_UNKNOWN: &str = "api-version-unknown";
    pub const MIN_APP_VERSION_INVALID: &str = "min-app-version-invalid";
    pub const ENTRY_MISSING: &str = "entry-missing";
    pub const ENTRY_ESCAPES_ROOT: &str = "entry-escapes-root";
    pub const ENTRY_EMPTY: &str = "entry-empty";
    pub const ENTRY_NOT_MODULE: &str = "entry-not-module";
    pub const CONTRIBUTION_ID_SHAPE: &str = "contribution-id-shape";
    pub const CONTRIBUTION_ID_DUPLICATE: &str = "contribution-id-duplicate";
    pub const PERMISSION_UNKNOWN: &str = "permission-unknown";
    pub const NETWORK_INVALID: &str = "network-invalid";
    pub const PERMISSION_UNUSED: &str = "permission-unused";
    pub const COMMAND_UNDECLARED: &str = "command-undeclared";
    pub const ICON_UNKNOWN: &str = "icon-unknown";
    pub const ICON_MISSING: &str = "icon-missing";
    pub const SIZE_EXCEEDED: &str = "size-exceeded";
    pub const NO_CONTRIBUTIONS: &str = "no-contributions";
}

/// Icon names the renderer's `IC` map provides. Kept in sync by hand: the map
/// lives in TypeScript and there is no codegen step between the two.
pub const BUILTIN_ICONS: &[&str] = &[
    "lines", "plus", "git2", "chat", "chev", "board", "git", "folder", "bot", "search", "gear",
    "term", "key", "dots", "bell", "phone",
];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl Issue {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Issue {
            code: code.to_string(),
            message: message.into(),
            path: None,
        }
    }

    fn at(code: &str, message: impl Into<String>, path: impl Into<String>) -> Self {
        Issue {
            code: code.to_string(),
            message: message.into(),
            path: Some(path.into()),
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<PluginManifest>,
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
}

impl ValidationReport {
    fn empty() -> Self {
        ValidationReport {
            ok: false,
            manifest: None,
            errors: vec![],
            warnings: vec![],
        }
    }

    fn finish(mut self) -> Self {
        self.ok = self.errors.is_empty();
        self
    }
}

#[derive(Clone, Debug)]
pub struct ValidateOptions {
    /// Bundled plugins ship under the reserved publisher; third-party ones
    /// must not. Set by the caller, since the folder alone cannot say.
    pub bundled: bool,
}

impl Default for ValidateOptions {
    fn default() -> Self {
        ValidateOptions { bundled: false }
    }
}

/// Validate a plugin folder. Never panics and never executes plugin code:
/// a malformed manifest is a report, not an error.
pub fn validate_dir(root: &Path) -> ValidationReport {
    validate_dir_with(root, &ValidateOptions::default())
}

/// The outcome of trying to read a manifest. The three cases are genuinely
/// different to a caller: `Unreadable` means there is nothing to show, while
/// `Salvaged` means the fields that parsed are real and the semantic checks
/// should still run over them.
enum ManifestRead {
    Ok(PluginManifest),
    Salvaged(PluginManifest, Vec<Issue>),
    Unreadable(Vec<Issue>),
}

pub fn validate_dir_with(root: &Path, opts: &ValidateOptions) -> ValidationReport {
    let mut report = ValidationReport::empty();

    let (manifest, structural) = match read_manifest(root) {
        ManifestRead::Ok(m) => (Some(m), Vec::new()),
        ManifestRead::Salvaged(m, issues) => (Some(m), issues),
        ManifestRead::Unreadable(issues) => (None, issues),
    };
    report.errors.extend(structural);

    if let Some(manifest) = &manifest {
        check_identity(manifest, opts, &mut report);
        check_entry(root, manifest, &mut report);
        check_contributions(manifest, &mut report);
        check_permissions(manifest, &mut report);
        check_network(manifest, &mut report);
        check_icons(root, manifest, &mut report);
    }
    check_size(root, &mut report);

    report.manifest = manifest;
    report.finish()
}

/// Read and parse the manifest.
///
/// On a strict-parse failure this returns a **salvaged** manifest alongside
/// the structural issues, so the semantic checks still run and one invocation
/// reports everything that is wrong. A strict parse alone would stop at the
/// first unknown field: an agent that fixes `topbars` → `topbar`, re-runs,
/// then discovers its id is wrong, re-runs, then discovers its version is not
/// semver, is paying three round trips where one would do — and that loop is
/// the whole reason this validator exists.
fn read_manifest(root: &Path) -> ManifestRead {
    let path = root.join("plugin.json");
    if !path.is_file() {
        return ManifestRead::Unreadable(vec![Issue::at(
            codes::MANIFEST_MISSING,
            "plugin.json is missing from the plugin folder",
            "plugin.json",
        )]);
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            return ManifestRead::Unreadable(vec![Issue::at(
                codes::MANIFEST_UNREADABLE,
                format!("cannot read plugin.json: {}", e),
                "plugin.json",
            )])
        }
    };

    let raw: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return ManifestRead::Unreadable(vec![Issue::at(
                codes::MANIFEST_INVALID,
                format!("plugin.json is not valid JSON: {}", e),
                "plugin.json",
            )])
        }
    };

    match serde_json::from_value::<PluginManifest>(raw.clone()) {
        Ok(m) => ManifestRead::Ok(m),
        Err(strict_error) => {
            let (salvage, issues) = diagnose(&raw, &strict_error);
            ManifestRead::Salvaged(salvage, issues)
        }
    }
}

/// Walk a manifest that failed the strict parse, reporting every structural
/// problem and salvaging whatever fields are usable so the semantic checks
/// can still run over them.
fn diagnose(
    raw: &serde_json::Value,
    strict_error: &serde_json::Error,
) -> (PluginManifest, Vec<Issue>) {
    let mut issues = Vec::new();
    let mut salvage = PluginManifest::default();

    let Some(obj) = raw.as_object() else {
        issues.push(Issue::at(
            codes::MANIFEST_INVALID,
            "plugin.json must be a JSON object",
            "plugin.json",
        ));
        return (salvage, issues);
    };

    const KNOWN_TOP: &[&str] = &[
        "id",
        "name",
        "version",
        "apiVersion",
        "minAppVersion",
        "description",
        "author",
        "entry",
        "icon",
        "permissions",
        "network",
        "contributes",
    ];

    for key in obj.keys() {
        if !KNOWN_TOP.contains(&key.as_str()) {
            issues.push(Issue::at(
                codes::MANIFEST_INVALID,
                format!("unknown manifest field `{}`", key),
                "plugin.json",
            ));
        }
    }

    /* strings the semantic pass can work with. `name` is the exception: no
    other check covers it, so its absence is reported here. */
    for field in ["id", "version", "entry"] {
        match obj.get(field) {
            None => issues.push(Issue::at(
                codes::MANIFEST_INVALID,
                format!("required field `{}` is missing", field),
                "plugin.json",
            )),
            Some(v) => match v.as_str() {
                Some(s) => match field {
                    "id" => salvage.id = s.to_string(),
                    "version" => salvage.version = s.to_string(),
                    "entry" => salvage.entry = s.to_string(),
                    _ => {}
                },
                None => issues.push(Issue::at(
                    codes::MANIFEST_INVALID,
                    format!("field `{}` must be a string", field),
                    "plugin.json",
                )),
            },
        }
    }

    match obj.get("name") {
        None => issues.push(Issue::at(
            codes::MANIFEST_INVALID,
            "required field `name` is missing",
            "plugin.json",
        )),
        Some(v) => match v.as_str() {
            Some(s) => salvage.name = s.to_string(),
            None => issues.push(Issue::at(
                codes::MANIFEST_INVALID,
                "field `name` must be a string",
                "plugin.json",
            )),
        },
    }

    match obj.get("apiVersion") {
        None => issues.push(Issue::at(
            codes::MANIFEST_INVALID,
            "required field `apiVersion` is missing",
            "plugin.json",
        )),
        Some(v) => match v.as_u64() {
            Some(n) => salvage.api_version = n as u32,
            None => issues.push(Issue::at(
                codes::MANIFEST_INVALID,
                "field `apiVersion` must be a number",
                "plugin.json",
            )),
        },
    }

    if let Some(v) = obj.get("minAppVersion") {
        match v.as_str() {
            Some(s) => salvage.min_app_version = Some(s.to_string()),
            None => issues.push(Issue::at(
                codes::MANIFEST_INVALID,
                "field `minAppVersion` must be a string",
                "plugin.json",
            )),
        }
    }

    if let Some(v) = obj.get("icon") {
        match serde_json::from_value::<super::PluginIcon>(v.clone()) {
            Ok(icon) => salvage.icon = Some(icon),
            Err(_) => issues.push(Issue::at(
                codes::MANIFEST_INVALID,
                "`icon` must be { \"type\": \"builtin\", \"name\": … } or { \"type\": \"image\", \"path\": … }",
                "plugin.json",
            )),
        }
    }

    /* permissions: name each unknown one rather than failing the parse */
    match obj.get("permissions") {
        None => {}
        Some(v) => match v.as_array() {
            None => issues.push(Issue::at(
                codes::MANIFEST_INVALID,
                "`permissions` must be an array of strings",
                "plugin.json",
            )),
            Some(list) => {
                for entry in list {
                    match entry.as_str() {
                        None => issues.push(Issue::at(
                            codes::MANIFEST_INVALID,
                            "every permission must be a string",
                            "plugin.json",
                        )),
                        Some(name) => salvage.permissions.push(name.to_string()),
                    }
                }
            }
        },
    }

    /* network: HTTPS origins only, no paths. Salvaged as plain strings so the
    semantic pass can judge each one. */
    match obj.get("network") {
        None => {}
        Some(v) => match v.as_array() {
            None => issues.push(Issue::at(
                codes::MANIFEST_INVALID,
                "`network` must be an array of strings",
                "plugin.json",
            )),
            Some(list) => {
                for entry in list {
                    match entry.as_str() {
                        None => issues.push(Issue::at(
                            codes::MANIFEST_INVALID,
                            "every network origin must be a string",
                            "plugin.json",
                        )),
                        Some(origin) => salvage.network.push(origin.to_string()),
                    }
                }
            }
        },
    }

    /* contributions: name every key that is not a known kind, and every kind
    whose value is not a list. A typo here silently contributes nothing at
    runtime, which is the failure mode hardest to notice by hand. */
    if let Some(v) = obj.get("contributes") {
        match v.as_object() {
            None => issues.push(Issue::at(
                codes::MANIFEST_INVALID,
                "`contributes` must be an object",
                "plugin.json",
            )),
            Some(map) => {
                for key in map.keys() {
                    if !super::CONTRIBUTION_KINDS.contains(&key.as_str()) {
                        issues.push(Issue::at(
                            codes::MANIFEST_INVALID,
                            format!(
                                "unknown contribution kind `{}` (expected one of: {})",
                                key,
                                super::CONTRIBUTION_KINDS.join(", ")
                            ),
                            "plugin.json",
                        ));
                    }
                }
                for kind in super::CONTRIBUTION_KINDS {
                    let Some(value) = map.get(*kind) else {
                        continue;
                    };
                    let Some(array) = value.as_array() else {
                        issues.push(Issue::at(
                            codes::MANIFEST_INVALID,
                            format!("`contributes.{}` must be an array", kind),
                            "plugin.json",
                        ));
                        continue;
                    };
                    let mut parsed = Vec::new();
                    for entry in array {
                        match serde_json::from_value::<super::Contribution>(entry.clone()) {
                            Ok(c) => parsed.push(c),
                            Err(e) => issues.push(Issue::at(
                                codes::MANIFEST_INVALID,
                                format!("`contributes.{}` entry is malformed: {}", kind, e),
                                "plugin.json",
                            )),
                        }
                    }
                    assign_kind(&mut salvage.contributes, kind, parsed);
                }
            }
        }
    }

    /* the strict parser's own message is the catch-all: if the diagnosis above
    found nothing specific, the author still needs to know something failed */
    if issues.is_empty() {
        issues.push(Issue::at(
            codes::MANIFEST_INVALID,
            format!(
                "plugin.json does not match the manifest schema: {}",
                strict_error
            ),
            "plugin.json",
        ));
    }
    (salvage, issues)
}

fn assign_kind(contributions: &mut Contributions, kind: &str, list: Vec<Contribution>) {
    match kind {
        "commands" => contributions.commands = list,
        "topbar" => contributions.topbar = list,
        "sidebar" => contributions.sidebar = list,
        "dock" => contributions.dock = list,
        "tabs" => contributions.tabs = list,
        "modals" => contributions.modals = list,
        "widgets" => contributions.widgets = list,
        "settings" => contributions.settings = list,
        "services" => contributions.services = list,
        _ => {}
    }
}

fn check_identity(m: &PluginManifest, opts: &ValidateOptions, report: &mut ValidationReport) {
    if !valid_id(&m.id) {
        report.errors.push(Issue::at(
            codes::ID_SHAPE,
            format!(
                "id `{}` must be `publisher.name`, lowercase letters/digits/dashes only",
                m.id
            ),
            "plugin.json",
        ));
    }
    if !opts.bundled && m.id.split('.').next() == Some(RESERVED_PUBLISHER) {
        report.errors.push(Issue::at(
            codes::ID_RESERVED,
            format!(
                "the `{}` publisher is reserved for plugins shipped with the app",
                RESERVED_PUBLISHER
            ),
            "plugin.json",
        ));
    }
    if semver::Version::parse(&m.version).is_err() {
        report.errors.push(Issue::at(
            codes::VERSION_INVALID,
            format!("version `{}` is not valid semver", m.version),
            "plugin.json",
        ));
    }
    if m.api_version != API_VERSION {
        report.errors.push(Issue::at(
            codes::API_VERSION_UNKNOWN,
            format!(
                "apiVersion {} is not supported by this build (expected {})",
                m.api_version, API_VERSION
            ),
            "plugin.json",
        ));
    }
    if let Some(min) = &m.min_app_version {
        if semver::Version::parse(min).is_err() {
            report.errors.push(Issue::at(
                codes::MIN_APP_VERSION_INVALID,
                format!("minAppVersion `{}` is not valid semver", min),
                "plugin.json",
            ));
        }
    }
}

fn check_entry(root: &Path, m: &PluginManifest, report: &mut ValidationReport) {
    let resolved = match safe_join(root, &m.entry) {
        Some(p) => p,
        None => {
            report.errors.push(Issue::at(
                codes::ENTRY_ESCAPES_ROOT,
                format!("entry `{}` must stay inside the plugin folder", m.entry),
                &m.entry,
            ));
            return;
        }
    };
    if !resolved.is_file() {
        report.errors.push(Issue::at(
            codes::ENTRY_MISSING,
            format!("entry `{}` does not exist", m.entry),
            &m.entry,
        ));
        return;
    }
    match fs::read_to_string(&resolved) {
        Ok(body) if body.trim().is_empty() => {
            report.errors.push(Issue::at(
                codes::ENTRY_EMPTY,
                format!("entry `{}` is empty", m.entry),
                &m.entry,
            ));
        }
        Ok(body) => {
            /* Cheap shape check only — the host imports this as an ES module,
            so a classic script would fail at activation with a confusing
            error. Catching it here keeps the message actionable. */
            let has_module_syntax =
                body.contains("export") || body.contains("import ") || body.contains("import(");
            if !has_module_syntax {
                report.warnings.push(Issue::at(
                    codes::ENTRY_NOT_MODULE,
                    format!(
                        "entry `{}` has no import/export statement; the host loads plugins as ES modules",
                        m.entry
                    ),
                    &m.entry,
                ));
            }
        }
        Err(e) => {
            report.errors.push(Issue::at(
                codes::ENTRY_MISSING,
                format!("cannot read entry `{}`: {}", m.entry, e),
                &m.entry,
            ));
        }
    }
}

fn check_contributions(m: &PluginManifest, report: &mut ValidationReport) {
    let mut seen: Vec<&str> = Vec::new();
    let prefix = format!("{}.", m.id);
    let commands = m.contributes.command_ids();

    for (kind, c) in m.contributes.all() {
        if !c.id.starts_with(&prefix) {
            report.errors.push(Issue::at(
                codes::CONTRIBUTION_ID_SHAPE,
                format!(
                    "{} id `{}` must be namespaced under the plugin id (`{}…`)",
                    kind, c.id, prefix
                ),
                "plugin.json",
            ));
        }
        if seen.contains(&c.id.as_str()) {
            report.errors.push(Issue::at(
                codes::CONTRIBUTION_ID_DUPLICATE,
                format!("contribution id `{}` is declared more than once", c.id),
                "plugin.json",
            ));
        }
        seen.push(&c.id);

        if let Some(target) = &c.command {
            if !commands.contains(&target.as_str()) {
                report.errors.push(Issue::at(
                    codes::COMMAND_UNDECLARED,
                    format!(
                        "{} `{}` points at command `{}`, which contributes.commands does not declare",
                        kind, c.id, target
                    ),
                    "plugin.json",
                ));
            }
        }
    }

    if m.contributes.is_empty() {
        report.warnings.push(Issue::new(
            codes::NO_CONTRIBUTIONS,
            "plugin declares no contributions; it will activate but add nothing",
        ));
    }
}

fn check_permissions(m: &PluginManifest, report: &mut ValidationReport) {
    let mut seen: Vec<&str> = Vec::new();
    for p in &m.permissions {
        if !PERMISSIONS.contains(&p.as_str()) {
            report.errors.push(Issue::at(
                codes::PERMISSION_UNKNOWN,
                format!("permission `{}` is not recognised", p),
                "plugin.json",
            ));
            continue;
        }
        if seen.contains(&p.as_str()) {
            report.warnings.push(Issue::at(
                codes::PERMISSION_UNUSED,
                format!("permission `{}` is declared twice", p),
                "plugin.json",
            ));
        }
        seen.push(p);
    }
}

/// Every entry must be a bare `https://host[:port]` origin: no path, no
/// credentials, no wildcard, no other scheme. A path would silently not match
/// the CSP origin the generator emits, so the plugin would fail at runtime
/// with a message pointing at the policy rather than the manifest.
fn valid_network_origin(origin: &str) -> bool {
    let rest = match origin.strip_prefix("https://") {
        Some(r) => r,
        None => return false,
    };
    if rest.is_empty()
        || rest.contains('/')
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains('@')
        || rest.contains('*')
        || rest.contains(' ')
    {
        return false;
    }
    let host = rest.split(':').next().unwrap_or("");
    if host.is_empty() || host.starts_with('.') || host.starts_with('-') {
        return false;
    }
    if let Some(port) = rest.split(':').nth(1) {
        if port.is_empty() || port.len() > 5 || !port.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }
    if rest.split(':').count() > 2 {
        return false;
    }
    true
}

fn check_network(m: &PluginManifest, report: &mut ValidationReport) {
    let mut seen: Vec<&str> = Vec::new();
    for origin in &m.network {
        if !valid_network_origin(origin) {
            report.errors.push(Issue::at(
                codes::NETWORK_INVALID,
                format!(
                    "network origin `{}` must be a bare https://host[:port] with no path",
                    origin
                ),
                "plugin.json",
            ));
            continue;
        }
        if seen.contains(&origin.as_str()) {
            report.warnings.push(Issue::at(
                codes::PERMISSION_UNUSED,
                format!("network origin `{}` is declared twice", origin),
                "plugin.json",
            ));
        }
        seen.push(origin);
    }
}

fn check_icons(root: &Path, m: &PluginManifest, report: &mut ValidationReport) {
    let mut check = |icon: &super::PluginIcon, owner: &str| match icon {
        super::PluginIcon::Builtin { name } => {
            if !BUILTIN_ICONS.contains(&name.as_str()) {
                report.errors.push(Issue::at(
                    codes::ICON_UNKNOWN,
                    format!(
                        "{} icon `{}` is not a builtin icon (one of: {})",
                        owner,
                        name,
                        BUILTIN_ICONS.join(", ")
                    ),
                    "plugin.json",
                ));
            }
        }
        super::PluginIcon::Image { path } => {
            let ok = safe_join(root, path).map(|p| p.is_file()).unwrap_or(false);
            if !ok {
                report.errors.push(Issue::at(
                    codes::ICON_MISSING,
                    format!(
                        "{} icon image `{}` is missing or outside the plugin folder",
                        owner, path
                    ),
                    path,
                ));
            }
        }
    };

    if let Some(icon) = &m.icon {
        check(icon, "manifest");
    }
    for (kind, c) in m.contributes.all() {
        if let Some(icon) = &c.icon {
            check(icon, kind);
        }
    }
}

/// Sum every file under the plugin root. A symlink is counted as its target's
/// size and refused if it points outside — an installed plugin must be a
/// self-contained tree.
fn check_size(root: &Path, report: &mut ValidationReport) {
    fn walk(dir: &Path, total: &mut u64, escape: &mut bool) -> std::io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let meta = entry.metadata()?;
            if meta.is_dir() {
                walk(&path, total, escape)?;
            } else if meta.is_file() {
                *total += meta.len();
            } else if meta.file_type().is_symlink() {
                match path.canonicalize() {
                    Ok(real) => {
                        let root_real = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
                        if !real.starts_with(&root_real) {
                            *escape = true;
                        } else if let Ok(m) = fs::metadata(&real) {
                            *total += m.len();
                        }
                    }
                    Err(_) => *escape = true,
                }
            }
        }
        Ok(())
    }

    let mut total = 0u64;
    let mut escape = false;
    if walk(root, &mut total, &mut escape).is_ok() {
        if escape {
            report.errors.push(Issue::new(
                codes::ENTRY_ESCAPES_ROOT,
                "plugin contains a symlink pointing outside its own folder",
            ));
        }
        if total > MAX_PLUGIN_BYTES {
            report.errors.push(Issue::new(
                codes::SIZE_EXCEEDED,
                format!(
                    "plugin is {} bytes, over the {} byte cap",
                    total, MAX_PLUGIN_BYTES
                ),
            ));
        }
    }
}

/// Convenience for the CLI and the install path: validate and hand back the
/// manifest, or the report that explains why not.
pub fn validate_for_install(root: &Path, opts: &ValidateOptions) -> PluginResult<PluginManifest> {
    let report = validate_dir_with(root, opts);
    if report.ok {
        report
            .manifest
            .ok_or_else(|| PluginError::Manifest("validator returned no manifest".into()))
    } else {
        Err(PluginError::Validation(
            report.errors.iter().map(|i| i.message.clone()).collect(),
        ))
    }
}
/// Read a manifest without validating — used by the scheme handler, which
/// serves files for an already-installed plugin and must not re-run checks.
pub fn read_manifest_unchecked(root: &Path) -> PluginResult<PluginManifest> {
    match read_manifest(root) {
        ManifestRead::Ok(m) | ManifestRead::Salvaged(m, _) => Ok(m),
        ManifestRead::Unreadable(issues) => Err(PluginError::Manifest(
            issues
                .into_iter()
                .map(|i| i.message)
                .collect::<Vec<_>>()
                .join("; "),
        )),
    }
}

/// All contribution ids a manifest declares, for the loader's registry.
pub fn declared_ids(c: &Contributions) -> Vec<(String, String)> {
    c.all()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.id.clone()))
        .collect()
}

/// Resolve an asset path for the `plugin://` handler.
pub fn resolve_asset(root: &Path, rel: &str) -> PluginResult<PathBuf> {
    safe_join(root, rel).ok_or_else(|| {
        PluginError::Unsupported(format!("asset path `{}` escapes the plugin folder", rel))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        dir: PathBuf,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "bentomux-validate-{}-{}",
                tag,
                std::process::id()
            ));
            fs::remove_dir_all(&dir).ok();
            fs::create_dir_all(&dir).unwrap();
            Fixture { dir }
        }

        fn write(&self, rel: &str, body: &str) -> &Self {
            let path = self.dir.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(path, body).unwrap();
            self
        }

        fn manifest(&self, body: &str) -> &Self {
            self.write("plugin.json", body)
        }

        fn validate(&self) -> ValidationReport {
            validate_dir(&self.dir)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.dir).ok();
        }
    }

    const GOOD_MANIFEST: &str = r#"{
        "id": "acme.habit-tracker",
        "name": "Habit Tracker",
        "version": "1.0.0",
        "apiVersion": 1,
        "entry": "index.js",
        "permissions": ["storage"],
        "contributes": {
            "commands": [{ "id": "acme.habit-tracker.open", "title": "Open" }],
            "sidebar": [{
                "id": "acme.habit-tracker.sidebar",
                "title": "Habits",
                "command": "acme.habit-tracker.open"
            }]
        }
    }"#;

    #[test]
    fn valid_plugin_passes_with_no_issues() {
        let f = Fixture::new("ok");
        f.manifest(GOOD_MANIFEST).write(
            "index.js",
            "export function activate(ctx) { ctx.log('hi'); }",
        );
        let r = f.validate();
        assert!(r.ok, "expected ok, got errors: {:?}", r.errors);
        assert!(r.errors.is_empty());
        assert!(
            r.warnings.is_empty(),
            "unexpected warnings: {:?}",
            r.warnings
        );
        assert_eq!(r.manifest.unwrap().id, "acme.habit-tracker");
    }

    #[test]
    fn missing_manifest_is_reported_not_panicked() {
        let f = Fixture::new("nomanifest");
        let r = f.validate();
        assert!(!r.ok);
        assert_eq!(r.errors[0].code, codes::MANIFEST_MISSING);
        assert!(r.manifest.is_none());
    }

    #[test]
    fn malformed_manifest_reports_schema_error() {
        let f = Fixture::new("badjson");
        f.manifest("{ not json").write("index.js", "export {}");
        let r = f.validate();
        assert!(!r.ok);
        assert_eq!(r.errors[0].code, codes::MANIFEST_INVALID);
    }

    #[test]
    fn bad_id_shape_is_refused() {
        let f = Fixture::new("badid");
        f.manifest(&GOOD_MANIFEST.replace("acme.habit-tracker", "habit-tracker"))
            .write("index.js", "export {}");
        let r = f.validate();
        assert!(!r.ok);
        assert!(r.errors.iter().any(|i| i.code == codes::ID_SHAPE));
    }

    #[test]
    fn reserved_publisher_refused_for_third_party_but_allowed_when_bundled() {
        let f = Fixture::new("reserved");
        f.manifest(&GOOD_MANIFEST.replace("acme.habit-tracker", "bentomux.session-notes"))
            .write("index.js", "export {}");

        let third_party = f.validate();
        assert!(!third_party.ok);
        assert!(third_party
            .errors
            .iter()
            .any(|i| i.code == codes::ID_RESERVED));

        let bundled = validate_dir_with(&f.dir, &ValidateOptions { bundled: true });
        assert!(
            bundled.ok,
            "bundled plugins may use the reserved publisher: {:?}",
            bundled.errors
        );
    }

    #[test]
    fn unknown_permission_is_an_error_not_a_silent_no_op() {
        let f = Fixture::new("perm");
        f.manifest(&GOOD_MANIFEST.replace(r#""storage""#, r#""storage", "teleport""#))
            .write("index.js", "export {}");
        let r = f.validate();
        assert!(!r.ok);
        assert!(r.errors.iter().any(|i| i.code == codes::PERMISSION_UNKNOWN));
    }

    #[test]
    fn command_reference_must_be_declared() {
        let f = Fixture::new("cmdref");
        f.manifest(&GOOD_MANIFEST.replace(
            "acme.habit-tracker.open\"\n            }]",
            "acme.habit-tracker.other\"\n            }]",
        ))
        .write("index.js", "export {}");
        let r = f.validate();
        assert!(
            !r.ok,
            "a button pointing at an undeclared command must fail"
        );
        assert!(r.errors.iter().any(|i| i.code == codes::COMMAND_UNDECLARED));
    }

    #[test]
    fn entry_must_exist_and_stay_inside() {
        let f = Fixture::new("entry");
        f.manifest(GOOD_MANIFEST);
        let missing = f.validate();
        assert!(!missing.ok);
        assert!(missing
            .errors
            .iter()
            .any(|i| i.code == codes::ENTRY_MISSING));

        let f2 = Fixture::new("entry2");
        f2.manifest(&GOOD_MANIFEST.replace("index.js", "../escape.js"))
            .write("index.js", "export {}");
        let escape = f2.validate();
        assert!(!escape.ok);
        assert!(escape
            .errors
            .iter()
            .any(|i| i.code == codes::ENTRY_ESCAPES_ROOT));
    }

    #[test]
    fn empty_entry_is_refused() {
        let f = Fixture::new("empty");
        f.manifest(GOOD_MANIFEST).write("index.js", "   \n  ");
        let r = f.validate();
        assert!(!r.ok);
        assert!(r.errors.iter().any(|i| i.code == codes::ENTRY_EMPTY));
    }

    #[test]
    fn unknown_api_version_is_refused() {
        let f = Fixture::new("apiver");
        f.manifest(&GOOD_MANIFEST.replace(r#""apiVersion": 1"#, r#""apiVersion": 99"#))
            .write("index.js", "export {}");
        let r = f.validate();
        assert!(!r.ok);
        assert!(r
            .errors
            .iter()
            .any(|i| i.code == codes::API_VERSION_UNKNOWN));
    }

    #[test]
    fn duplicate_contribution_id_is_refused() {
        let f = Fixture::new("dupe");
        f.manifest(
            r#"{
                "id": "acme.x", "name": "X", "version": "1.0.0", "apiVersion": 1,
                "entry": "index.js",
                "contributes": {
                    "commands": [{ "id": "acme.x.a", "title": "A" }],
                    "sidebar": [{ "id": "acme.x.a", "title": "Also A" }]
                }
            }"#,
        )
        .write("index.js", "export {}");
        let r = f.validate();
        assert!(!r.ok);
        assert!(r
            .errors
            .iter()
            .any(|i| i.code == codes::CONTRIBUTION_ID_DUPLICATE));
    }

    #[test]
    fn unknown_builtin_icon_is_refused() {
        let f = Fixture::new("icon");
        f.manifest(&GOOD_MANIFEST.replace(
            r#""title": "Open" }"#,
            r#""title": "Open", "icon": { "type": "builtin", "name": "sparkles" } }"#,
        ))
        .write("index.js", "export {}");
        let r = f.validate();
        assert!(!r.ok);
        assert!(r.errors.iter().any(|i| i.code == codes::ICON_UNKNOWN));
    }

    #[test]
    fn missing_icon_image_is_refused() {
        let f = Fixture::new("iconimg");
        f.manifest(&GOOD_MANIFEST.replace(
            r#""entry": "index.js","#,
            r#""entry": "index.js", "icon": { "type": "image", "path": "icon.svg" },"#,
        ))
        .write("index.js", "export {}");
        let r = f.validate();
        assert!(!r.ok);
        assert!(r.errors.iter().any(|i| i.code == codes::ICON_MISSING));

        f.write("icon.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
        assert!(f.validate().ok);
    }

    #[test]
    fn plugin_without_contributions_warns_but_passes() {
        let f = Fixture::new("nocon");
        f.manifest(
            r#"{
                "id": "acme.quiet", "name": "Quiet", "version": "1.0.0",
                "apiVersion": 1, "entry": "index.js"
            }"#,
        )
        .write("index.js", "export function activate() {}");
        let r = f.validate();
        assert!(r.ok, "{:?}", r.errors);
        assert!(r.warnings.iter().any(|i| i.code == codes::NO_CONTRIBUTIONS));
    }

    #[test]
    fn classic_script_entry_warns_because_host_loads_modules() {
        let f = Fixture::new("classic");
        f.manifest(GOOD_MANIFEST)
            .write("index.js", "window.thing = 1;");
        let r = f.validate();
        assert!(r.ok, "{:?}", r.errors);
        assert!(r.warnings.iter().any(|i| i.code == codes::ENTRY_NOT_MODULE));
    }

    #[test]
    fn oversized_plugin_is_refused() {
        let f = Fixture::new("big");
        f.manifest(GOOD_MANIFEST).write("index.js", "export {}");
        /* one byte over the cap, written sparsely enough to stay cheap */
        let big = f.dir.join("padding.bin");
        let file = fs::File::create(&big).unwrap();
        file.set_len(MAX_PLUGIN_BYTES + 1).unwrap();
        drop(file);
        let r = f.validate();
        assert!(!r.ok);
        assert!(r.errors.iter().any(|i| i.code == codes::SIZE_EXCEEDED));
    }

    #[test]
    fn report_serializes_with_camel_case_for_the_agent() {
        let f = Fixture::new("json");
        f.manifest("{ nope");
        let json = serde_json::to_value(f.validate()).unwrap();
        assert_eq!(json["ok"], false);
        assert!(json["errors"][0]["code"].is_string());
        assert!(
            json["manifest"].is_null(),
            "absent manifest omits the field"
        );
    }

    /* the authoring loop is the reason this validator exists: one run must
    report everything wrong, not the first thing the parser tripped over */
    #[test]
    fn a_broken_manifest_reports_every_problem_in_one_pass() {
        let f = Fixture::new("multierror");
        f.manifest(
            r#"{
                "id": "habit-tracker",
                "version": "not-semver",
                "apiVersion": 99,
                "entry": "../escape.js",
                "permissions": ["teleport"],
                "contributes": { "topbars": [], "commands": "nope" }
            }"#,
        );

        let r = f.validate();
        assert!(!r.ok);
        let codes: Vec<&str> = r.errors.iter().map(|i| i.code.as_str()).collect();

        assert!(
            codes.contains(&codes::MANIFEST_INVALID),
            "bad contribution key: {:?}",
            codes
        );
        assert!(
            codes.contains(&codes::PERMISSION_UNKNOWN),
            "bad permission: {:?}",
            codes
        );

        /* and once the structure parses, the semantic pass still runs */
        let f2 = Fixture::new("multierror2");
        f2.manifest(
            r#"{
                "id": "habit-tracker", "name": "X", "version": "not-semver",
                "apiVersion": 99, "entry": "../escape.js"
            }"#,
        )
        .write("index.js", "export {}");
        let r2 = f2.validate();
        let codes2: Vec<&str> = r2.errors.iter().map(|i| i.code.as_str()).collect();
        assert!(codes2.contains(&codes::ID_SHAPE), "{:?}", codes2);
        assert!(codes2.contains(&codes::VERSION_INVALID), "{:?}", codes2);
        assert!(codes2.contains(&codes::API_VERSION_UNKNOWN), "{:?}", codes2);
        assert!(codes2.contains(&codes::ENTRY_ESCAPES_ROOT), "{:?}", codes2);
        assert!(
            r2.errors.len() >= 4,
            "one run, four independent problems: {:?}",
            codes2
        );
    }

    #[test]
    fn network_origins_must_be_bare_https_origins() {
        for good in ["https://petdex.dev", "https://assets.petdex.dev", "https://api.x.io:8443"] {
            assert!(valid_network_origin(good), "{good} should pass");
        }
        for bad in [
            "http://petdex.dev",
            "https://petdex.dev/api/manifest",
            "https://petdex.dev?x=1",
            "https://user@petdex.dev",
            "https://*.petdex.dev",
            "petdex.dev",
            "",
        ] {
            assert!(!valid_network_origin(bad), "{bad} should fail");
        }
    }

    #[test]
    fn declared_network_origins_pass_and_bad_ones_fail() {
        let f = Fixture::new("net");
        f.manifest(&GOOD_MANIFEST.replace(
            r#""entry": "index.js","#,
            r#""entry": "index.js", "network": ["https://petdex.dev", "https://assets.petdex.dev"],"#,
        ))
        .write("index.js", "export {}");
        let r = f.validate();
        assert!(r.ok, "{:?}", r.errors);
        assert_eq!(r.manifest.unwrap().network.len(), 2);

        let g = Fixture::new("netbad");
        g.manifest(&GOOD_MANIFEST.replace(
            r#""entry": "index.js","#,
            r#""entry": "index.js", "network": ["https://petdex.dev/api", "http://x.io"],"#,
        ))
        .write("index.js", "export {}");
        let bad = g.validate();
        assert!(!bad.ok);
        assert_eq!(
            bad.errors.iter().filter(|i| i.code == codes::NETWORK_INVALID).count(),
            2
        );
    }

    #[test]
    fn duplicate_network_origin_warns() {
        let f = Fixture::new("netdupe");
        f.manifest(&GOOD_MANIFEST.replace(
            r#""entry": "index.js","#,
            r#""entry": "index.js", "network": ["https://x.io", "https://x.io"],"#,
        ))
        .write("index.js", "export {}");
        let r = f.validate();
        assert!(r.ok, "{:?}", r.errors);
        assert!(r.warnings.iter().any(|i| i.message.contains("declared twice")));
    }

    #[test]
    fn diagnose_names_every_unknown_top_level_field() {
        let f = Fixture::new("unknownfields");
        f.manifest(
            r#"{
                "id": "acme.x", "name": "X", "version": "1.0.0", "apiVersion": 1,
                "entry": "index.js", "publisher": "acme", "homepage": "https://x"
            }"#,
        )
        .write("index.js", "export {}");
        let r = f.validate();
        let messages: Vec<&str> = r.errors.iter().map(|i| i.message.as_str()).collect();
        assert!(
            messages.iter().any(|m| m.contains("publisher")),
            "{:?}",
            messages
        );
        assert!(
            messages.iter().any(|m| m.contains("homepage")),
            "{:?}",
            messages
        );
    }
}
