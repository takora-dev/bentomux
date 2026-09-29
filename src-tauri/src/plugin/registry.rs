/* ---------------- plugin platform: registry + install lifecycle ----------------
Spec: docs/PLUGIN_PLATFORM.md §3, §8.

The registry is the persisted record of what is installed; the code lives
beside it under `plugins/<id>/<version>/` and never inside bentomux.json.
Keeping the two apart is what makes rollback and "uninstall but keep my
data" possible without rewriting the store.

Layout under the app data dir:
  plugins/<id>/<version>/…     installed code, one dir per version
  plugin-data/<id>.json        plugin-owned values, survive uninstall

Every filesystem path a manifest supplies goes through safe_join, and every
version directory is written to a temp location first so a failed install
cannot leave a half-written plugin behind. */

use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

use super::validate::{self, ValidateOptions};
use super::{
    PluginError, PluginManifest, PluginRecord, PluginResult, PluginSource, MAX_PLUGIN_BYTES,
};

/* ---------------- paths ---------------- */

#[derive(Clone, Debug)]
pub struct PluginPaths {
    /// `plugins/` — installed code, `<id>/<version>/`
    pub code_root: PathBuf,
    /// `plugin-data/` — per-plugin JSON, `<id>.json`
    pub data_root: PathBuf,
    /// Where bundled plugins are unpacked from resources on first run.
    pub bundled_root: Option<PathBuf>,
}

impl PluginPaths {
    pub fn new(app_data_dir: &Path) -> Self {
        PluginPaths {
            code_root: app_data_dir.join("plugins"),
            data_root: app_data_dir.join("plugin-data"),
            bundled_root: None,
        }
    }

    pub fn with_bundled(mut self, dir: PathBuf) -> Self {
        self.bundled_root = Some(dir);
        self
    }

    pub fn version_dir(&self, id: &str, version: &str) -> PathBuf {
        self.code_root.join(id).join(version)
    }

    pub fn plugin_dir(&self, id: &str) -> PathBuf {
        self.code_root.join(id)
    }

    pub fn data_file(&self, id: &str) -> PathBuf {
        self.data_root.join(format!("{}.json", id))
    }

    /// Every installed version of a plugin, newest-looking order irrelevant —
    /// callers sort. Used by rollback and by the one-version retention rule.
    pub fn installed_versions(&self, id: &str) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(entries) = fs::read_dir(self.plugin_dir(id)) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    if let Some(name) = entry.file_name().to_str() {
                        out.push(name.to_string());
                    }
                }
            }
        }
        out.sort();
        out
    }
}

/* ---------------- hashing ---------------- */

/// sha256 over the plugin tree: relative path + length + bytes, in sorted
/// order, so the digest is stable across machines and filesystems. Used to
/// detect a tampered install and to cache-bust the entry module URL.
pub fn hash_tree(root: &Path) -> PluginResult<String> {
    fn collect(dir: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) -> std::io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let meta = entry.metadata()?;
            if meta.is_dir() {
                collect(&path, base, out)?;
            } else if meta.is_file() {
                let rel = path
                    .strip_prefix(base)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, path));
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    collect(root, root, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    for (rel, path) in files {
        let bytes = fs::read(&path)?;
        hasher.update(rel.as_bytes());
        hasher.update(b"\0");
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
    }
    Ok(hex_encode(&hasher.finalize()))
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_encode(&hasher.finalize())
}

/* ---------------- install sources ---------------- */

/// Copy a plugin folder the user picked. The source is left untouched: an
/// installed plugin is a snapshot, not a link, so editing the original later
/// cannot silently change what the app runs.
pub fn install_from_folder(paths: &PluginPaths, source: &Path) -> PluginResult<PluginRecord> {
    if !source.is_dir() {
        return Err(PluginError::NotFound(format!(
            "{} is not a folder",
            source.display()
        )));
    }
    let manifest = validate::validate_for_install(source, &ValidateOptions::default())?;
    let staging = stage_dir(paths, &manifest.id, &manifest.version)?;

    copy_tree(source, &staging)?;

    finalize_install(
        paths,
        &manifest,
        staging,
        PluginSource::Folder {
            path: source.to_string_lossy().to_string(),
        },
    )
}

/// Install from a zip archive already on disk (the CLI path, and what the
/// download path produces before this is called).
pub fn install_from_zip(paths: &PluginPaths, archive: &Path) -> PluginResult<PluginRecord> {
    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| PluginError::Manifest(format!("not a readable zip: {}", e)))?;

    let staging_root = temp_staging(paths)?;
    zip.extract_unwrapped_root_dir(&staging_root, zip::read::root_dir_common_filter)
        .map_err(|e| PluginError::Io(format!("extract failed: {}", e)))?;

    /* validate before moving anything into place: a bad archive must not
    leave a version directory behind for the registry to trip over */
    let manifest = validate::validate_for_install(&staging_root, &ValidateOptions::default())?;
    let dest = stage_dir(paths, &manifest.id, &manifest.version)?;
    copy_tree(&staging_root, &dest)?;
    fs::remove_dir_all(&staging_root).ok();

    finalize_install(
        paths,
        &manifest,
        dest,
        PluginSource::Folder {
            path: archive.to_string_lossy().to_string(),
        },
    )
}

/// Install a plugin that ships inside the app. Bundled plugins may use the
/// reserved publisher and are enabled on first sight.
pub fn install_bundled(paths: &PluginPaths, source: &Path) -> PluginResult<PluginRecord> {
    let manifest = validate::validate_for_install(source, &ValidateOptions { bundled: true })?;
    let dest = stage_dir(paths, &manifest.id, &manifest.version)?;
    copy_tree(source, &dest)?;
    finalize_install(paths, &manifest, dest, PluginSource::Bundled)
}

/// Download a plugin zip over HTTPS and verify it against a pinned digest.
///
/// The digest is mandatory. An unpinned remote install would let whoever
/// controls the URL change what code the app runs, which is a worse trade
/// than asking the publisher to state a hash up front.
pub fn install_from_url(
    paths: &PluginPaths,
    url: &str,
    expected_sha256: &str,
) -> PluginResult<PluginRecord> {
    let bytes = download(url)?;
    let actual = sha256_bytes(&bytes);
    if !actual.eq_ignore_ascii_case(expected_sha256.trim()) {
        return Err(PluginError::Conflict(format!(
            "sha256 mismatch: expected {}, got {}",
            expected_sha256.trim(),
            actual
        )));
    }
    if bytes.len() as u64 > MAX_PLUGIN_BYTES {
        return Err(PluginError::Conflict(format!(
            "download is {} bytes, over the {} byte cap",
            bytes.len(),
            MAX_PLUGIN_BYTES
        )));
    }

    let tmp = paths
        .code_root
        .join(format!(".download-{}.zip", std::process::id()));
    if let Some(parent) = tmp.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&tmp, &bytes)?;
    let result = install_from_zip(paths, &tmp);
    fs::remove_file(&tmp).ok();

    let mut record = result?;
    record.source = PluginSource::Url {
        url: url.to_string(),
    };
    Ok(record)
}

fn download(url: &str) -> PluginResult<Vec<u8>> {
    if !url.starts_with("https://") {
        return Err(PluginError::Unsupported(
            "plugin installs must come from an https:// URL".into(),
        ));
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| PluginError::Io(format!("http client: {}", e)))?;
    let resp = client
        .get(url)
        .send()
        .map_err(|e| PluginError::Io(format!("download failed: {}", e)))?;
    if !resp.status().is_success() {
        return Err(PluginError::Io(format!(
            "download failed with status {}",
            resp.status()
        )));
    }
    resp.bytes()
        .map(|b| b.to_vec())
        .map_err(|e| PluginError::Io(format!("reading download failed: {}", e)))
}

/* ---------------- lifecycle operations ---------------- */

/// Enable or disable without touching the installed code. Disabling is how a
/// user takes a broken plugin out of the picture without losing its data.
pub fn set_enabled(
    records: &mut Vec<PluginRecord>,
    id: &str,
    enabled: bool,
) -> PluginResult<PluginRecord> {
    let rec = records
        .iter_mut()
        .find(|r| r.id == id)
        .ok_or_else(|| PluginError::NotFound(id.to_string()))?;
    rec.enabled = enabled;
    Ok(rec.clone())
}

/// Remove the installed code and keep plugin data. `remove_data` is the
/// separate, explicitly-asked-for action: losing user data to a mis-click is
/// not an acceptable default.
pub fn uninstall(
    paths: &PluginPaths,
    records: &mut Vec<PluginRecord>,
    id: &str,
    remove_data: bool,
) -> PluginResult<()> {
    let idx = records
        .iter()
        .position(|r| r.id == id)
        .ok_or_else(|| PluginError::NotFound(id.to_string()))?;

    let dir = paths.plugin_dir(id);
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    if remove_data {
        let data = paths.data_file(id);
        if data.exists() {
            fs::remove_file(&data)?;
        }
    }
    records.remove(idx);
    Ok(())
}

/// Record a successful update: the outgoing version becomes the rollback
/// target, and only one previous version is kept on disk.
pub fn commit_update(
    paths: &PluginPaths,
    record: &mut PluginRecord,
    new_version: &str,
    sha256: String,
) {
    let old = record.version.clone();
    record.previous_version = Some(old.clone());
    record.version = new_version.to_string();
    record.sha256 = sha256;

    /* retention: drop every version directory that is neither current nor the
    one rollback target */
    let keep = [record.version.as_str(), old.as_str()];
    for version in paths.installed_versions(&record.id) {
        if !keep.contains(&version.as_str()) {
            fs::remove_dir_all(paths.version_dir(&record.id, &version)).ok();
        }
    }
}

/// Flip a plugin back to its previous version. The rollback target stays on
/// disk precisely so this needs no network and no re-download.
pub fn rollback(paths: &PluginPaths, record: &mut PluginRecord) -> PluginResult<()> {
    let prev = record
        .previous_version
        .clone()
        .ok_or_else(|| PluginError::Conflict(format!("{} has no previous version", record.id)))?;
    let dir = paths.version_dir(&record.id, &prev);
    if !dir.is_dir() {
        return Err(PluginError::NotFound(format!(
            "previous version {} is no longer on disk",
            prev
        )));
    }
    let sha = hash_tree(&dir)?;
    let current = record.version.clone();
    record.version = prev;
    record.previous_version = Some(current);
    record.sha256 = sha;
    Ok(())
}

/* ---------------- bundled sync ---------------- */

/// Install or refresh the plugins that ship with the app. Idempotent: a
/// bundled plugin whose digest already matches is left alone, so this is safe
/// to call on every boot.
pub fn sync_bundled(paths: &PluginPaths, records: &mut Vec<PluginRecord>) -> Vec<PluginError> {
    let mut errors = Vec::new();
    let Some(root) = paths.bundled_root.clone() else {
        return errors;
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return errors;
    };

    /* ids the app still ships; anything bundled and absent from this list is
       pruned below */
    let mut shipped: Vec<String> = Vec::new();

    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(manifest) = validate::validate_for_install(&dir, &ValidateOptions { bundled: true })
        else {
            /* a bundled plugin that fails validation is a packaging bug; the
            app keeps running without it rather than refusing to boot */
            errors.push(PluginError::Validation(vec![format!(
                "bundled plugin at {} failed validation",
                dir.display()
            )]));
            continue;
        };
        shipped.push(manifest.id.clone());

        let digest = match hash_tree(&dir) {
            Ok(d) => d,
            Err(e) => {
                errors.push(e);
                continue;
            }
        };

        match records.iter_mut().find(|r| r.id == manifest.id) {
            Some(existing) => {
                /* Re-place when the content changed OR when the version
                directory is missing. The second case is what repairs an
                install left in a staging directory by an earlier build: the
                registry's hash still matches, so a hash-only check would
                skip it and the plugin would stay unreadable forever. */
                let placed = paths
                    .version_dir(&manifest.id, &manifest.version)
                    .join("plugin.json")
                    .is_file();
                if existing.sha256 != digest || !placed {
                    match place_version(paths, &manifest, &dir) {
                        Ok(()) => {
                            if existing.sha256 != digest {
                                commit_update(paths, existing, &manifest.version, digest);
                            } else {
                                existing.sha256 = digest;
                            }
                        }
                        Err(e) => errors.push(e),
                    }
                }
            }
            None => match place_version(paths, &manifest, &dir) {
                Ok(()) => {
                    let mut rec = PluginRecord::new(
                        manifest.id.clone(),
                        manifest.version.clone(),
                        PluginSource::Bundled,
                        digest,
                    );
                    rec.enabled = true;
                    records.push(rec);
                }
                Err(e) => errors.push(e),
            },
        }
    }

    /* A bundled plugin the app no longer ships must leave the registry too:
       the copy unpacked on an earlier boot would otherwise keep running from
       the user's plugin dir with nothing left to refresh it. Plugin data
       stays — the same default an uninstall has. */
    let mut idx = 0;
    while idx < records.len() {
        let id = records[idx].id.clone();
        let unshipped = matches!(records[idx].source, PluginSource::Bundled)
            && !shipped.contains(&id);
        if !unshipped {
            idx += 1;
            continue;
        }
        let dir = paths.plugin_dir(&id);
        if !dir.exists() || fs::remove_dir_all(&dir).is_ok() {
            records.remove(idx);
            continue;
        }
        errors.push(PluginError::Io(format!(
            "could not remove unshipped bundled plugin `{}`",
            id
        )));
        idx += 1;
    }
    errors
}

/// Copy a source tree into its final `plugins/<id>/<version>/` directory.
///
/// Goes through staging so an interrupted copy never looks like a finished
/// install, then renames into place — the same two steps every other install
/// path uses. Skipping the rename leaves the plugin in a `.staging-*`
/// directory that `version_dir()` cannot find, which surfaces much later as an
/// unreadable manifest and an entry URL with no file in it.
fn place_version(
    paths: &PluginPaths,
    manifest: &PluginManifest,
    source: &Path,
) -> PluginResult<()> {
    let staging = stage_dir(paths, &manifest.id, &manifest.version)?;
    if let Err(e) = copy_tree(source, &staging) {
        fs::remove_dir_all(&staging).ok();
        return Err(e);
    }
    let dest = paths.version_dir(&manifest.id, &manifest.version);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    if dest.exists() {
        fs::remove_dir_all(&dest)?;
    }
    fs::rename(&staging, &dest).map_err(|e| {
        fs::remove_dir_all(&staging).ok();
        PluginError::Io(format!("could not place plugin: {}", e))
    })?;
    Ok(())
}

/* ---------------- helpers ---------------- */

/// Stage a version into a temp sibling, so an interrupted copy never looks
/// like a finished install.
fn stage_dir(paths: &PluginPaths, id: &str, version: &str) -> PluginResult<PathBuf> {
    let dest = paths.version_dir(id, version);
    let staging = dest.with_file_name(format!(".staging-{}-{}", version, std::process::id()));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;
    Ok(staging)
}

fn temp_staging(paths: &PluginPaths) -> PluginResult<PathBuf> {
    let dir = paths.code_root.join(format!(
        ".unpack-{}-{}",
        std::process::id(),
        super::now_millis()
    ));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Move a staged tree into its final version directory and hash it.
fn finalize_install(
    paths: &PluginPaths,
    manifest: &PluginManifest,
    staging: PathBuf,
    source: PluginSource,
) -> PluginResult<PluginRecord> {
    let dest = paths.version_dir(&manifest.id, &manifest.version);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    if dest.exists() {
        /* reinstalling the same version replaces it: the user asked for this
        exact folder to be installed, so the on-disk copy is stale */
        fs::remove_dir_all(&dest)?;
    }
    fs::rename(&staging, &dest).map_err(|e| {
        fs::remove_dir_all(&staging).ok();
        PluginError::Io(format!("could not place plugin: {}", e))
    })?;

    let sha = hash_tree(&dest)?;
    Ok(PluginRecord::new(
        manifest.id.clone(),
        manifest.version.clone(),
        source,
        sha,
    ))
}

fn copy_tree(from: &Path, to: &Path) -> PluginResult<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let meta = entry.metadata()?;
        if meta.is_dir() {
            copy_tree(&src, &dst)?;
        } else if meta.is_file() {
            fs::copy(&src, &dst)?;
        }
        /* symlinks are skipped: an installed plugin is a self-contained tree,
        and the validator already flags links that leave the folder */
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bentomux-reg-{}-{}", tag, std::process::id()));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_plugin(dir: &Path, id: &str, version: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("plugin.json"),
            format!(
                r#"{{
                    "id": "{}", "name": "T", "version": "{}", "apiVersion": 1,
                    "entry": "index.js",
                    "contributes": {{ "commands": [{{ "id": "{}.go", "title": "Go" }}] }}
                }}"#,
                id, version, id
            ),
        )
        .unwrap();
        fs::write(dir.join("index.js"), "export function activate() {}").unwrap();
    }

    fn paths(tag: &str) -> (PluginPaths, PathBuf) {
        let root = tmp(tag);
        (PluginPaths::new(&root), root)
    }

    #[test]
    fn installs_a_folder_and_hashes_it() {
        let (p, root) = paths("install");
        let src = root.join("src-plugin");
        write_plugin(&src, "acme.t", "1.0.0");

        let rec = install_from_folder(&p, &src).unwrap();
        assert_eq!(rec.id, "acme.t");
        assert_eq!(rec.version, "1.0.0");
        assert!(
            rec.enabled,
            "a plugin the user chose to install starts enabled"
        );
        assert_eq!(rec.sha256.len(), 64);
        assert!(p.version_dir("acme.t", "1.0.0").join("index.js").is_file());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn install_refuses_an_invalid_plugin_and_leaves_nothing_behind() {
        let (p, root) = paths("invalid");
        let src = root.join("bad");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("plugin.json"), "{ not json").unwrap();

        assert!(install_from_folder(&p, &src).is_err());
        assert!(!p.code_root.join("bad").exists());
        assert_eq!(p.installed_versions("bad").len(), 0);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reinstall_replaces_the_same_version() {
        let (p, root) = paths("reinstall");
        let src = root.join("src-plugin");
        write_plugin(&src, "acme.t", "1.0.0");
        let first = install_from_folder(&p, &src).unwrap();

        fs::write(
            src.join("index.js"),
            "export function activate() { return 2; }",
        )
        .unwrap();
        let second = install_from_folder(&p, &src).unwrap();

        assert_ne!(
            first.sha256, second.sha256,
            "content changed, digest must follow"
        );
        assert_eq!(p.installed_versions("acme.t"), vec!["1.0.0"]);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn enable_disable_toggles_the_flag_only() {
        let (p, root) = paths("toggle");
        let src = root.join("src-plugin");
        write_plugin(&src, "acme.t", "1.0.0");
        let mut records = vec![install_from_folder(&p, &src).unwrap()];

        set_enabled(&mut records, "acme.t", false).unwrap();
        assert!(!records[0].enabled);
        assert!(
            p.version_dir("acme.t", "1.0.0").is_dir(),
            "code stays on disk"
        );

        set_enabled(&mut records, "acme.t", true).unwrap();
        assert!(records[0].enabled);

        assert!(set_enabled(&mut records, "nope.nope", true).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn uninstall_keeps_data_unless_asked_otherwise() {
        let (p, root) = paths("uninstall");
        let src = root.join("src-plugin");
        write_plugin(&src, "acme.t", "1.0.0");
        let mut records = vec![install_from_folder(&p, &src).unwrap()];

        fs::create_dir_all(&p.data_root).unwrap();
        fs::write(p.data_file("acme.t"), r#"{"notes":"keep me"}"#).unwrap();

        uninstall(&p, &mut records, "acme.t", false).unwrap();
        assert!(records.is_empty());
        assert!(!p.plugin_dir("acme.t").exists());
        assert!(p.data_file("acme.t").is_file(), "data survives by default");

        /* second round, this time asking for data removal */
        let mut records = vec![install_from_folder(&p, &src).unwrap()];
        uninstall(&p, &mut records, "acme.t", true).unwrap();
        assert!(!p.data_file("acme.t").exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn update_keeps_exactly_one_previous_version_and_gc_older() {
        let (p, root) = paths("update");
        let src = root.join("src-plugin");
        write_plugin(&src, "acme.t", "1.0.0");
        let mut rec = install_from_folder(&p, &src).unwrap();

        for version in ["1.1.0", "1.2.0"] {
            write_plugin(&src, "acme.t", version);
            install_from_folder(&p, &src).unwrap();
            let sha = hash_tree(&p.version_dir("acme.t", version)).unwrap();
            commit_update(&p, &mut rec, version, sha);
        }

        assert_eq!(rec.version, "1.2.0");
        assert_eq!(rec.previous_version.as_deref(), Some("1.1.0"));
        let on_disk = p.installed_versions("acme.t");
        assert_eq!(on_disk, vec!["1.1.0", "1.2.0"], "1.0.0 garbage-collected");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rollback_swaps_current_and_previous() {
        let (p, root) = paths("rollback");
        let src = root.join("src-plugin");
        write_plugin(&src, "acme.t", "1.0.0");
        let mut rec = install_from_folder(&p, &src).unwrap();

        write_plugin(&src, "acme.t", "2.0.0");
        install_from_folder(&p, &src).unwrap();
        let sha = hash_tree(&p.version_dir("acme.t", "2.0.0")).unwrap();
        commit_update(&p, &mut rec, "2.0.0", sha);

        rollback(&p, &mut rec).unwrap();
        assert_eq!(rec.version, "1.0.0");
        assert_eq!(rec.previous_version.as_deref(), Some("2.0.0"));
        assert!(p.version_dir("acme.t", "1.0.0").is_dir());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rollback_without_a_previous_version_is_refused() {
        let (p, root) = paths("norollback");
        let src = root.join("src-plugin");
        write_plugin(&src, "acme.t", "1.0.0");
        let mut rec = install_from_folder(&p, &src).unwrap();

        assert!(rollback(&p, &mut rec).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn url_install_requires_https_and_a_matching_digest() {
        let (p, root) = paths("url");

        let insecure = install_from_url(&p, "http://example.com/x.zip", "00");
        assert!(matches!(insecure, Err(PluginError::Unsupported(_))));

        /* https but unreachable: the digest check never runs, and nothing is
        written into the code root */
        let unreachable = install_from_url(&p, "https://127.0.0.1:1/x.zip", "00");
        assert!(unreachable.is_err());
        assert_eq!(p.installed_versions("acme.t").len(), 0);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bundled_sync_is_idempotent_and_uses_the_reserved_publisher() {
        let (p, root) = paths("bundled");
        let bundled = root.join("bundled");
        write_plugin(
            &bundled.join("session-notes"),
            "bentomux.session-notes",
            "1.0.0",
        );
        let p = p.with_bundled(bundled.clone());

        let mut records = Vec::new();
        let errors = sync_bundled(&p, &mut records);
        assert!(errors.is_empty(), "{:?}", errors);
        assert_eq!(records.len(), 1);
        assert!(records[0].enabled);
        assert!(matches!(records[0].source, PluginSource::Bundled));
        let first_sha = records[0].sha256.clone();

        /* second boot: nothing changes */
        let errors = sync_bundled(&p, &mut records);
        assert!(errors.is_empty());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].sha256, first_sha);

        /* the app ships a new build of the bundled plugin */
        write_plugin(
            &bundled.join("session-notes"),
            "bentomux.session-notes",
            "1.1.0",
        );
        let errors = sync_bundled(&p, &mut records);
        assert!(errors.is_empty(), "{:?}", errors);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].version, "1.1.0");
        assert_eq!(records[0].previous_version.as_deref(), Some("1.0.0"));

        fs::remove_dir_all(&root).ok();
    }

    /* A build that stops shipping a bundled plugin must also retire it: the
       copy unpacked on the previous boot lives in the user's plugin dir, and
       without this prune it keeps running forever. */
    #[test]
    fn bundled_sync_prunes_plugins_the_app_no_longer_ships() {
        let (p, root) = paths("bundled-prune");
        let bundled = root.join("bundled");
        write_plugin(
            &bundled.join("session-notes"),
            "bentomux.session-notes",
            "1.0.0",
        );
        write_plugin(&bundled.join("notes"), "bentomux.notes", "1.0.0");
        let p = p.with_bundled(bundled.clone());

        let mut records = Vec::new();
        let errors = sync_bundled(&p, &mut records);
        assert!(errors.is_empty(), "{:?}", errors);
        assert_eq!(records.len(), 2);

        /* a plugin the user installed is never touched by the prune */
        records.push(PluginRecord::new(
            "acme.t".into(),
            "1.0.0".into(),
            PluginSource::Folder {
                path: String::new(),
            },
            "sha".into(),
        ));

        /* the next build stops shipping session-notes */
        fs::remove_dir_all(bundled.join("session-notes")).unwrap();
        let errors = sync_bundled(&p, &mut records);
        assert!(errors.is_empty(), "{:?}", errors);

        let ids: Vec<&str> = records.iter().map(|r| r.id.as_str()).collect();
        assert!(!ids.contains(&"bentomux.session-notes"), "pruned");
        assert!(ids.contains(&"bentomux.notes"), "still shipped");
        assert!(ids.contains(&"acme.t"), "third-party kept");
        assert!(!p.plugin_dir("bentomux.session-notes").exists());

        fs::remove_dir_all(&root).ok();
    }

    /* The bundled sync used to copy into a `.staging-*` directory and stop,
    leaving the plugin somewhere `version_dir()` never looks. The failure
    surfaced much later as an unreadable manifest and a module URL with no
    file in it, so it is pinned here. */
    #[test]
    fn bundled_sync_lands_in_the_version_directory_not_a_staging_dir() {
        let (p, root) = paths("bundled-place");
        let bundled = root.join("bundled");
        write_plugin(&bundled.join("notes"), "bentomux.notes", "1.0.0");
        let p = p.with_bundled(bundled.clone());

        let mut records = Vec::new();
        let errors = sync_bundled(&p, &mut records);
        assert!(errors.is_empty(), "{:?}", errors);

        let version_dir = p.version_dir("bentomux.notes", "1.0.0");
        assert!(
            version_dir.is_dir(),
            "plugin must be at plugins/<id>/<version>/"
        );
        assert!(version_dir.join("plugin.json").is_file());
        assert!(version_dir.join("index.js").is_file());

        /* and nothing may be left behind in a staging directory */
        let leftovers: Vec<String> = fs::read_dir(p.plugin_dir("bentomux.notes"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "staging leftovers: {:?}", leftovers);

        /* a second boot must not duplicate or move anything */
        let errors = sync_bundled(&p, &mut records);
        assert!(errors.is_empty(), "{:?}", errors);
        assert_eq!(records.len(), 1);
        assert!(p.version_dir("bentomux.notes", "1.0.0").is_dir());

        fs::remove_dir_all(&root).ok();
    }

    /* An install left in a staging directory by an older build has a registry
    hash that still matches, so a hash-only check would never repair it.
    The version directory's existence is part of the decision. */
    #[test]
    fn bundled_sync_repairs_an_install_left_in_staging() {
        let (p, root) = paths("bundled-repair");
        let bundled = root.join("bundled");
        write_plugin(&bundled.join("notes"), "bentomux.notes", "1.0.0");
        let p = p.with_bundled(bundled.clone());

        /* simulate the broken state: a record whose hash matches, but whose
        files sit in a staging directory */
        let mut records = Vec::new();
        let digest = hash_tree(&bundled.join("notes")).unwrap();
        records.push(PluginRecord::new(
            "bentomux.notes".into(),
            "1.0.0".into(),
            PluginSource::Bundled,
            digest,
        ));
        let staging = p.plugin_dir("bentomux.notes").join(".staging-1.0.0-999");
        copy_tree(&bundled.join("notes"), &staging).unwrap();
        assert!(!p.version_dir("bentomux.notes", "1.0.0").is_dir());

        let errors = sync_bundled(&p, &mut records);
        assert!(errors.is_empty(), "{:?}", errors);
        assert!(
            p.version_dir("bentomux.notes", "1.0.0")
                .join("plugin.json")
                .is_file(),
            "the missing version directory must be repaired even though the hash matched"
        );
        assert_eq!(records.len(), 1);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn third_party_cannot_use_the_reserved_publisher() {
        let (p, root) = paths("reserved");
        let src = root.join("src-plugin");
        write_plugin(&src, "bentomux.fake", "1.0.0");

        assert!(install_from_folder(&p, &src).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn hash_tree_is_stable_and_content_sensitive() {
        let dir = tmp("hash");
        fs::write(dir.join("a.txt"), "one").unwrap();
        fs::write(dir.join("b.txt"), "two").unwrap();
        let h1 = hash_tree(&dir).unwrap();
        let h2 = hash_tree(&dir).unwrap();
        assert_eq!(h1, h2, "same tree, same digest");

        fs::write(dir.join("b.txt"), "three").unwrap();
        assert_ne!(
            h1,
            hash_tree(&dir).unwrap(),
            "content change must move the digest"
        );

        fs::remove_dir_all(&dir).ok();
    }
}
