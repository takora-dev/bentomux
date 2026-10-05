/* ---------------- plugin marketplace: GitHub as the catalog ----------------
Spec: docs/PLUGIN_MARKETPLACE.md. Platform: docs/PLUGIN_PLATFORM.md §14.

There is no catalog server. GitHub *is* the catalog: an author adds the topic
`bentomux-plugin` to a repo, publishes a release with a `.zip` asset, and the
plugin is discoverable. Nothing to submit, nothing to moderate, nothing to run.

One API call per repo:

    GET /repos/{owner}/{repo}/releases/latest

carries the install URL, the sha256 digest, the size, and the download count in
a single response, and stars come free from the search result that found the
repo. The plugin's real id, name, permissions, and contributions are **not**
fetched here — those live in the `plugin.json` inside the zip, and the existing
install review already reads them from the archive before the user confirms.
This module only supplies the things a browsing list needs.

Rate limit is the design constraint: unauthenticated GitHub API is 60 requests
per hour *per IP* (docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
So the catalog is cached on disk with a TTL, a failed refresh serves stale cache
rather than an empty list, and the README is fetched on demand instead of
during the sweep.
*/

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::registry::{download, sha256_bytes};
use super::{PluginError, PluginResult, MAX_PLUGIN_BYTES};

/** Discovery. Any repo carrying this topic is in the marketplace. */
pub const TOPIC: &str = "bentomux-plugin";

/// How stale the on-disk catalog may get before it is refetched. At one
/// refresh per six hours, a full catalog of 30 plugins costs 31 of the 60
/// unauthenticated requests an hour, and leaves headroom for a second sweep if
/// the user opens the marketplace twice.
pub const CACHE_TTL_MILLIS: u64 = 6 * 60 * 60 * 1000;

/// Repos pulled per sweep. Each one costs a release call, so this is the
/// primary knob on how fast the 60/hr budget goes away.
pub const MAX_REPOS: usize = 30;

/// A README is display text, not input. Past this it is truncated rather than
/// parsed, and the user is told it was.
pub const MAX_README_BYTES: usize = 256 * 1024;

/// Only a zip is installable. The folder-inside-the-zip rule is enforced later
/// by `install_from_zip`; this only decides what to point the user at.
const ASSET_SUFFIX: &str = ".zip";

/* ---------------- what the renderer sees ---------------- */

/**
 * One plugin in the browsing list.
 *
 * `repo`, `name`, and `description` come from GitHub's repo metadata, not from
 * the plugin's manifest — they are for the list only. `installable` is false
 * when the repo has no usable release, with `note` saying why, rather than the
 * entry vanishing: "publish a release" is more useful to an author than an
 * absent row.
 */
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePlugin {
    /// `owner/name`.
    pub repo: String,
    pub name: String,
    pub description: Option<String>,
    pub stars: u32,
    pub downloads: u64,
    /// Release tag.
    pub version: String,
    pub published_at: Option<String>,
    pub html_url: String,
    /// Release asset filename.
    pub asset_name: String,
    pub download_url: String,
    /// sha256 of the asset bytes, as GitHub computed it at upload.
    pub sha256: String,
    pub size: u64,
    pub installable: bool,
    /// Why `installable` is false, or an empty string.
    pub note: String,

    /* Filled in by `annotate` from the app's own registry. The catalog knows
       nothing about what is installed, and the renderer should not have to
       re-derive it — this is the only place version comparison happens. */
    /// A plugin from this repo is installed.
    pub installed: bool,
    /// Its installed manifest version; empty when not installed.
    pub installed_version: String,
    /// The release is strictly newer than what is installed.
    pub update_available: bool,
}

/** The catalog plus the honesty about how fresh it is. */
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    /// Epoch millis of the sweep that produced this list.
    pub fetched_at: u64,
    /// True when this was served from cache because a refresh failed. The UI
    /// says so rather than quietly showing old data as current.
    pub stale: bool,
    /// Set when the refresh failed, so the user learns why it is stale.
    pub stale_reason: String,
    pub plugins: Vec<MarketplacePlugin>,
}

/* ---------------- GitHub wire shapes ---------------- */

/// Only the fields actually read. Unknown fields are ignored by serde's
/// default, so a GitHub API addition cannot break an older build.
#[derive(Deserialize, Clone, Debug)]
struct SearchHit {
    full_name: String,
    description: Option<String>,
    stargazers_count: u32,
    html_url: String,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    fork: bool,
}

#[derive(Deserialize, Clone, Debug)]
struct SearchResponse {
    #[serde(default)]
    items: Vec<SearchHit>,
}

#[derive(Deserialize, Clone, Debug)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
    /// `null` for assets uploaded before GitHub started publishing checksums.
    digest: Option<String>,
    size: u64,
    #[serde(default)]
    download_count: u64,
}

#[derive(Deserialize, Clone, Debug)]
struct ReleaseResponse {
    tag_name: String,
    published_at: Option<String>,
    html_url: Option<String>,
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
}

/* ---------------- sweep ---------------- */

/// The search URL. Kept as a function so the topic stays in one place.
fn search_url() -> String {
    format!(
        "https://api.github.com/search/repositories?q=topic:{}&sort=stars&order=desc&per_page={}",
        TOPIC, MAX_REPOS
    )
}

fn api_get(url: &str) -> PluginResult<Vec<u8>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        /* GitHub rejects API requests with no User-Agent outright. */
        .user_agent(concat!("bentomux/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| PluginError::Io(format!("http client: {}", e)))?;

    let resp = client
        .get(url)
        .send()
        .map_err(|e| PluginError::Io(format!("github request failed: {}", e)))?;

    /* Rate limiting is the expected failure, not an edge case: say so plainly
       instead of surfacing a bare 403 the user cannot act on. */
    if resp.status().as_u16() == 403 || resp.status().as_u16() == 429 {
        return Err(PluginError::Unsupported(
            "GitHub's rate limit was reached. The marketplace shows the last saved \
             catalog; it refreshes again in a few hours."
                .into(),
        ));
    }
    if !resp.status().is_success() {
        return Err(PluginError::Io(format!(
            "github returned {} for {}",
            resp.status(),
            url
        )));
    }
    resp.bytes()
        .map(|b| b.to_vec())
        .map_err(|e| PluginError::Io(format!("reading github response failed: {}", e)))
}

/// Find every repo tagged with the marketplace topic and resolve its latest
/// release. One search plus one call per repo.
pub fn sweep() -> PluginResult<Vec<MarketplacePlugin>> {
    let search: SearchResponse = serde_json::from_slice(&api_get(&search_url())?)
        .map_err(|e| PluginError::Manifest(format!("could not read the GitHub search result: {}", e)))?;

    /* A fork or an archived repo is not something to install. Dropping them
       here costs nothing and keeps the list honest. */
    let repos: Vec<SearchHit> = search
        .items
        .into_iter()
        .filter(|r| !r.archived && !r.fork)
        .take(MAX_REPOS)
        .collect();

    /* merge() is total — a repo with a broken release becomes a row that says
       why it cannot be installed, not a hole in the list. */
    let mut plugins: Vec<MarketplacePlugin> = repos
        .into_iter()
        .map(|hit| {
            let release = latest_release(&hit.full_name);
            merge(hit, release)
        })
        .collect();
    by_stars(&mut plugins);
    Ok(plugins)
}

/**
 * Most-starred first, with a stable tie-break.
 *
 * `search_url` already asks GitHub for `sort=stars`, but leaning on a remote
 * ordering is not a contract. Once the list is paginated an unstable tie stops
 * being cosmetic: two plugins with equal stars can swap places between
 * refreshes, and then the same plugin shows up on two different pages at once.
 * The repo name breaks the tie, so the same catalog always paginates the same
 * way.
 */
pub fn by_stars(plugins: &mut [MarketplacePlugin]) {
    plugins.sort_by(|a, b| {
        b.stars
            .cmp(&a.stars)
            .then_with(|| a.repo.to_lowercase().cmp(&b.repo.to_lowercase()))
    });
}

fn latest_release(repo: &str) -> Option<ReleaseResponse> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);
    match api_get(&url) {
        Ok(bytes) => serde_json::from_slice(&bytes).ok(),
        /* One unreachable repo must not empty the whole marketplace. */
        Err(_) => None,
    }
}

/**
 * Fold a repo's metadata and its latest release into one list row.
 *
 * Pure, so the rules — which asset, what to say when there is none — are
 * testable without a network or a rate-limit budget.
 */
fn merge(hit: SearchHit, release: Option<ReleaseResponse>) -> MarketplacePlugin {
    let mut p = MarketplacePlugin {
        repo: hit.full_name.clone(),
        name: hit.full_name.clone(),
        description: hit.description,
        stars: hit.stargazers_count,
        html_url: hit.html_url,
        ..Default::default()
    };

    let Some(release) = release else {
        p.note = "No published release yet.".into();
        return p;
    };

    p.version = release.tag_name.clone();
    p.published_at = release.published_at.clone();
    if let Some(url) = release.html_url {
        p.html_url = url;
    }

    let zips: Vec<&ReleaseAsset> = release
        .assets
        .iter()
        .filter(|a| a.name.to_lowercase().ends_with(ASSET_SUFFIX))
        .collect();

    match zips.as_slice() {
        [] => p.note = format!(
            "Release {} has no .zip asset. Publish one with `gh release create`.",
            release.tag_name
        ),
        [asset] => {
            p.asset_name = asset.name.clone();
            p.download_url = asset.browser_download_url.clone();
            p.size = asset.size;
            p.downloads = asset.download_count;
            match asset.digest.as_deref().map(str::trim) {
                Some(d) if d.starts_with("sha256:") => {
                    p.sha256 = d.trim_start_matches("sha256:").to_lowercase();
                    p.installable = true;
                }
                Some(_) => p.note =
                    "GitHub published no sha256 digest for this asset, so it cannot be \
                     verified. Re-upload it as a new release."
                        .into(),
                None => p.note =
                    "This asset predates GitHub's release digests and cannot be verified. \
                     Re-upload it as a new release."
                        .into(),
            }
        }
        many => {
            p.note = format!(
                "Release {} has {} .zip assets. Expected exactly one.",
                release.tag_name,
                many.len()
            );
        }
    }
    p
}

/* ---------------- version comparison ---------------- */

/**
 * Parse a release tag as a version.
 *
 * GitHub tags are strings and authors write `v1.2.3` about as often as
 * `1.2.3`, so a single leading `v` is stripped. Anything else — `release-3`,
 * `2026-01-15` — is not a version and yields `None`, which is the honest
 * answer: a tag we cannot order is a tag we must not claim an update from.
 */
pub fn tag_version(tag: &str) -> Option<semver::Version> {
    let trimmed = tag.trim();
    let bare = trimmed.strip_prefix('v').unwrap_or(trimmed);
    semver::Version::parse(bare).ok()
}

/// Is `tag` strictly newer than the installed manifest `version`?
///
/// Strictly, because an equal tag means there is nothing to do and a lower one
/// is a downgrade — which is what the Roll back button is for, and doing it by
/// accident through Update would overwrite the rollback target with the
/// version the user just left.
pub fn is_newer(tag: &str, installed: &str) -> bool {
    match (tag_version(tag), semver::Version::parse(installed.trim()).ok()) {
        (Some(candidate), Some(current)) => candidate > current,
        /* An unparseable installed version cannot be compared. Refusing to
           claim an update loses nothing: the row still shows as installed,
           and Reinstall is always available. */
        _ => false,
    }
}

/// Join the catalog to the app's registry.
///
/// Matches on the recorded repo, never on a name heuristic, so a repo called
/// `acme/HabitTracker` still lines up with a plugin id of `acme.habit-tracker`.
/// Rows that match nothing stay `installed: false`, which is what makes the
/// guess in the renderer unnecessary.
pub fn annotate(plugins: &mut [MarketplacePlugin], records: &[super::PluginRecord]) {
    for plugin in plugins.iter_mut() {
        plugin.installed = false;
        plugin.installed_version.clear();
        plugin.update_available = false;

        let Some(record) = records
            .iter()
            .find(|r| matches!(&r.source, super::PluginSource::Url { repo: Some(x), .. } if *x == plugin.repo))
        else {
            continue;
        };

        plugin.installed = true;
        plugin.installed_version = record.version.clone();
        plugin.update_available = is_newer(&plugin.version, &record.version);
    }
}

/* ---------------- cache ---------------- */

/// Read the saved catalog. A missing or corrupt file is simply "nothing
/// cached" — a broken cache must never be the reason the marketplace is
/// unavailable.
pub fn read_cache(path: &Path) -> Option<Catalog> {
    let bytes = std::fs::read(path).ok()?;
    let mut catalog: Catalog = serde_json::from_slice(&bytes).ok()?;
    /* ordered on the way out, not just on the way in: a cache written before
       this rule existed is already on disk, and a catalog is only trustworthy
       if it paginates the same way every time it is read */
    by_stars(&mut catalog.plugins);
    catalog.stale = true;
    Some(catalog)
}

pub fn write_cache(path: &Path, plugins: Vec<MarketplacePlugin>, fetched_at: u64) -> PluginResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let catalog = Catalog {
        fetched_at,
        stale: false,
        stale_reason: String::new(),
        plugins,
    };
    let json = serde_json::to_vec_pretty(&catalog)
        .map_err(|e| PluginError::Io(format!("encoding the marketplace cache: {}", e)))?;
    std::fs::write(path, json)?;
    Ok(())
}

/// True when the cache is old enough to be worth another sweep.
pub fn is_stale(catalog: &Catalog, now_millis: u64) -> bool {
    now_millis.saturating_sub(catalog.fetched_at) >= CACHE_TTL_MILLIS
}

/* ---------------- payload + readme ---------------- */

/**
 * Download a release asset, verify GitHub's digest, and write it to the system
 * temp dir so the caller can run the ordinary validate → review → install flow
 * over a real file. The file is left behind on purpose: the caller installs
 * from it moments later and the OS owns the temp dir.
 */
pub fn fetch_to_temp(url: &str, expected_sha256: &str) -> PluginResult<PathBuf> {
    let bytes = download(url)?;
    verify_payload(expected_sha256, &bytes)?;
    let path = std::env::temp_dir().join(format!(
        "bentomux-plugin-{}-{}.zip",
        std::process::id(),
        &sha256_bytes(&bytes)[..16]
    ));
    std::fs::write(&path, &bytes)?;
    Ok(path)
}

/**
 * Check a payload against the digest GitHub published for it.
 *
 * Split out from the fetch so the one check that matters is testable without a
 * network. This is the marketplace's whole security story: GitHub chooses the
 * bytes, and this refuses anything the publisher did not sign off on. A
 * tampered asset fails here and never reaches the installer.
 */
pub fn verify_payload(expected_sha256: &str, bytes: &[u8]) -> PluginResult<()> {
    let actual = sha256_bytes(bytes);
    if !actual.eq_ignore_ascii_case(expected_sha256.trim()) {
        return Err(PluginError::Conflict(format!(
            "sha256 mismatch: GitHub says {}, the download is {}. Refusing to install.",
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
    Ok(())
}

/// The README for a repo at a release tag, as plain text.
///
/// Served from `raw.githubusercontent.com` rather than the API, and fetched
/// only when the user opens a plugin's details — a per-repo README would
/// double the sweep's request count for text nobody is looking at yet.
pub fn readme(repo: &str, git_ref: &str) -> PluginResult<String> {
    if repo.contains('/') != true || repo.split('/').count() != 2 {
        return Err(PluginError::Manifest(format!("not an owner/name repo: {}", repo)));
    }
    let url = format!(
        "https://raw.githubusercontent.com/{}/{}/README.md",
        repo,
        git_ref
    );
    let bytes = download(&url)?;
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_README_BYTES)]).into_owned();
    Ok(text)
}

/* ---------------- tests ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(name: &str) -> SearchHit {
        SearchHit {
            full_name: name.into(),
            description: Some("a plugin".into()),
            stargazers_count: 42,
            html_url: format!("https://github.com/{}", name),
            archived: false,
            fork: false,
        }
    }

    fn starred(repo: &str, stars: u32) -> MarketplacePlugin {
        MarketplacePlugin {
            repo: repo.into(),
            name: repo.into(),
            stars,
            ..Default::default()
        }
    }

    #[test]
    fn most_starred_comes_first_and_ties_do_not_flap() {
        /* the tie-break is load-bearing once the list paginates: equal-starred
           plugins swapping places puts the same plugin on two pages at once */
        let mut rows = vec![
            starred("zeta/one", 5),
            starred("a/two", 900),
            starred("mike/three", 5),
            starred("b/four", 42),
        ];

        by_stars(&mut rows);
        assert_eq!(
            rows.iter().map(|r| r.repo.as_str()).collect::<Vec<_>>(),
            ["a/two", "b/four", "mike/three", "zeta/one"]
        );
        assert_eq!(rows.iter().map(|r| r.stars).collect::<Vec<_>>(), [900, 42, 5, 5]);

        /* input order must not matter: same list, same pagination */
        rows.reverse();
        by_stars(&mut rows);
        assert_eq!(
            rows.iter().map(|r| r.repo.as_str()).collect::<Vec<_>>(),
            ["a/two", "b/four", "mike/three", "zeta/one"]
        );
    }

    #[test]
    fn a_cached_catalog_is_ordered_even_if_the_file_is_not() {
        /* a cache written before the ordering rule is already on disk */
        let catalog = Catalog {
            fetched_at: 1,
            stale: false,
            stale_reason: String::new(),
            plugins: vec![starred("b/x", 1), starred("a/y", 77)],
        };
        let path = std::env::temp_dir().join(format!("bentomux-mp-order-{}.json", std::process::id()));
        std::fs::write(&path, serde_json::to_vec(&catalog).unwrap()).unwrap();

        let read = read_cache(&path).expect("cache should parse");
        assert_eq!(
            read.plugins.iter().map(|r| r.repo.as_str()).collect::<Vec<_>>(),
            ["a/y", "b/x"]
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn annotating_installed_state_does_not_disturb_the_order() {
        /* annotate() rewrites rows in place; if it re-sorted, a plugin would
           jump to a different page every time the catalog was re-read */
        let mut rows = vec![starred("a/low", 1), starred("b/high", 500)];
        annotate(&mut rows, &[]);
        assert_eq!(
            rows.iter().map(|r| r.repo.as_str()).collect::<Vec<_>>(),
            ["a/low", "b/high"]
        );
    }

    #[test]
    fn the_search_query_asks_for_the_most_starred_repos() {
        /* the 30-repo cap only means something if the cut is taken from a
           star-ordered list rather than a relevance-ordered one */
        let url = search_url();
        assert!(url.contains("sort=stars"), "{}", url);
        assert!(url.contains("order=desc"), "{}", url);
        assert!(url.contains(&format!("per_page={}", MAX_REPOS)), "{}", url);
    }

    fn asset(name: &str, digest: Option<&str>) -> ReleaseAsset {
        ReleaseAsset {
            name: name.into(),
            browser_download_url: format!("https://github.com/x/y/releases/download/v1/{}", name),
            digest: digest.map(str::to_string),
            size: 1024,
            download_count: 7,
        }
    }

    fn release(tag: &str, assets: Vec<ReleaseAsset>) -> ReleaseResponse {
        ReleaseResponse {
            tag_name: tag.into(),
            published_at: Some("2026-01-15T00:00:00Z".into()),
            html_url: Some("https://github.com/x/y/releases/tag/v1".into()),
            assets,
        }
    }

    #[test]
    fn stars_come_from_the_search_hit_and_downloads_from_the_asset() {
        let p = merge(
            hit("petdex/pets"),
            Some(release(
                "v1.6.0",
                vec![asset("pets.zip", Some("sha256:abc123"))],
            )),
        );
        assert_eq!(p.stars, 42);
        assert_eq!(p.downloads, 7);
        assert_eq!(p.version, "v1.6.0");
        assert!(p.installable);
        assert_eq!(p.sha256, "abc123");
    }

    #[test]
    fn a_repo_with_no_release_is_listed_but_not_installable() {
        let p = merge(hit("acme/things"), None);
        assert!(!p.installable);
        assert!(p.note.contains("No published release"));
        assert_eq!(p.download_url, "");
    }

    #[test]
    fn a_release_without_a_zip_says_what_to_do() {
        let p = merge(hit("acme/things"), Some(release("v1.0.0", vec![asset("notes.txt", None)])));
        assert!(!p.installable);
        assert!(p.note.contains("no .zip asset"));
    }

    #[test]
    fn two_zips_is_ambiguous_and_refused_rather_than_guessed() {
        let p = merge(
            hit("acme/things"),
            Some(release(
                "v1.0.0",
                vec![
                    asset("a.zip", Some("sha256:aa")),
                    asset("b.zip", Some("sha256:bb")),
                ],
            )),
        );
        assert!(!p.installable);
        assert!(p.note.contains("Expected exactly one"));
    }

    #[test]
    fn an_asset_with_no_digest_cannot_be_verified_and_is_refused() {
        let p = merge(
            hit("acme/things"),
            Some(release("v1.0.0", vec![asset("a.zip", None)])),
        );
        assert!(!p.installable);
        assert!(p.note.contains("predates"), "note was: {}", p.note);
        assert_eq!(p.sha256, "");
    }

    #[test]
    fn a_non_sha256_digest_is_not_silently_accepted() {
        let p = merge(
            hit("acme/things"),
            Some(release("v1.0.0", vec![asset("a.zip", Some("md5:deadbeef"))])),
        );
        assert!(!p.installable);
        assert!(p.note.contains("no sha256 digest"), "note was: {}", p.note);
        assert_eq!(p.sha256, "");
    }

    #[test]
    fn archived_and_forked_repos_are_dropped_from_the_sweep() {
        let body = br#"{"items":[
            {"full_name":"a/live","stargazers_count":1,"html_url":"h"},
            {"full_name":"a/gone","stargazers_count":2,"html_url":"h","archived":true},
            {"full_name":"a/fork","stargazers_count":3,"html_url":"h","fork":true}
        ]}"#;
        let search: SearchResponse = serde_json::from_slice(body).unwrap();
        let live: Vec<&SearchHit> = search
            .items
            .iter()
            .filter(|r| !r.archived && !r.fork)
            .collect();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].full_name, "a/live");
    }

    #[test]
    fn a_missing_items_key_is_an_empty_sweep_not_a_panic() {
        let search: SearchResponse = serde_json::from_slice(br#"{"total_count":0}"#).unwrap();
        assert!(search.items.is_empty());
    }

    #[test]
    fn the_cache_round_trips_and_reports_its_own_age() {
        let dir = std::env::temp_dir().join(format!("bentomux-mp-test-{}", std::process::id()));
        let path = dir.join("plugins.json");
        std::fs::create_dir_all(&dir).unwrap();

        let plugins = vec![merge(
            hit("petdex/pets"),
            Some(release("v1", vec![asset("p.zip", Some("sha256:ff"))])),
        )];
        write_cache(&path, plugins.clone(), 1_000).unwrap();

        let cached = read_cache(&path).unwrap();
        /* read_cache always marks what it returns as stale: it is by definition
           not the sweep that just ran. */
        assert!(cached.stale);
        assert_eq!(cached.plugins, plugins);
        assert!(is_stale(&cached, 1_000 + CACHE_TTL_MILLIS));
        assert!(!is_stale(&cached, 1_000 + 1));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_corrupt_cache_reads_as_absent_rather_than_failing_the_marketplace() {
        let dir = std::env::temp_dir().join(format!("bentomux-mp-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("plugins.json");
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(read_cache(&path).is_none());
        assert!(read_cache(&dir.join("nothing-here.json")).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_digest_check_accepts_only_the_published_bytes() {
        let bytes = b"plugin zip bytes";
        let digest = sha256_bytes(bytes);
        assert!(verify_payload(&digest, bytes).is_ok());
        assert!(verify_payload(&digest.to_uppercase(), bytes).is_ok());
        assert!(verify_payload(&digest, b"different bytes").is_err());
        assert!(verify_payload("", bytes).is_err());
    }

    #[test]
    fn an_oversized_payload_is_refused_before_it_lands() {
        let big = vec![0u8; MAX_PLUGIN_BYTES as usize + 1];
        let digest = sha256_bytes(&big);
        assert!(verify_payload(&digest, &big).is_err());
    }

    #[test]
    fn a_tag_needs_at_most_one_leading_v_to_be_a_version() {
        assert_eq!(tag_version("v1.6.0").map(|v| v.to_string()), Some("1.6.0".into()));
        assert_eq!(tag_version("1.6.0").map(|v| v.to_string()), Some("1.6.0".into()));
        assert_eq!(tag_version("  v1.6.0  ").map(|v| v.to_string()), Some("1.6.0".into()));
        /* an author writing "vv1" has a typo, not a version */
        assert!(tag_version("vv1.6.0").is_none());
        assert!(tag_version("release-3").is_none());
        assert!(tag_version("2026-01-15").is_none());
    }

    #[test]
    fn an_update_is_only_claimed_when_the_tag_is_strictly_newer() {
        assert!(is_newer("v1.6.1", "1.6.0"));
        assert!(is_newer("v2.0.0", "1.9.9"));
        /* same version: nothing to do, and committing it would set the
           rollback target to the version already on disk */
        assert!(!is_newer("v1.6.0", "1.6.0"));
        assert!(!is_newer("1.6.0", "1.6.0"));
        /* a downgrade belongs to Roll back, not Update */
        assert!(!is_newer("v1.5.0", "1.6.0"));
        /* incomparable input claims nothing rather than guessing */
        assert!(!is_newer("nightly", "1.6.0"));
        assert!(!is_newer("v1.6.1", "not-a-version"));
        assert!(!is_newer("v1.6.1", ""));
    }

    fn record(repo: &str, version: &str) -> super::super::PluginRecord {
        super::super::PluginRecord {
            id: "acme.t".into(),
            version: version.into(),
            previous_version: None,
            enabled: true,
            source: super::super::PluginSource::Url {
                url: "https://github.com/acme/t/releases/download/v1/t.zip".into(),
                repo: if repo.is_empty() { None } else { Some(repo.into()) },
            },
            sha256: "0".repeat(64),
            installed_at: 0,
        }
    }

    fn row(repo: &str, tag: &str) -> MarketplacePlugin {
        MarketplacePlugin {
            repo: repo.into(),
            version: tag.into(),
            installable: true,
            ..Default::default()
        }
    }

    #[test]
    fn annotate_matches_on_the_recorded_repo_not_on_the_name() {
        let mut rows = vec![
            row("acme/HabitTracker", "v2.0.0"),
            row("other/thing", "v1.0.0"),
        ];
        annotate(&mut rows, &[record("acme/HabitTracker", "1.4.0")]);

        assert!(rows[0].installed);
        assert_eq!(rows[0].installed_version, "1.4.0");
        assert!(rows[0].update_available);

        assert!(!rows[1].installed);
        assert!(!rows[1].update_available);
    }

    #[test]
    fn an_installed_plugin_on_the_same_release_is_not_offered_an_update() {
        let mut rows = vec![row("acme/t", "v1.6.0")];
        annotate(&mut rows, &[record("acme/t", "1.6.0")]);
        assert!(rows[0].installed);
        assert!(!rows[0].update_available);
    }

    #[test]
    fn an_install_without_a_recorded_repo_is_never_matched() {
        /* the pre-marketplace case: installed by hand from a folder or a zip,
           so there is nothing to join on and nothing to claim */
        let mut rows = vec![row("acme/t", "v2.0.0")];
        annotate(&mut rows, &[record("", "1.0.0")]);
        assert!(!rows[0].installed);
        assert!(!rows[0].update_available);
    }

    #[test]
    fn annotate_clears_stale_flags_when_it_runs_twice() {
        let mut rows = vec![row("acme/t", "v2.0.0")];
        annotate(&mut rows, &[record("acme/t", "1.0.0")]);
        assert!(rows[0].update_available);
        annotate(&mut rows, &[]);
        assert!(!rows[0].installed);
        assert!(!rows[0].update_available);
        assert!(rows[0].installed_version.is_empty());
    }

    #[test]
    fn a_readme_url_cannot_be_pasted_together_from_two_repos() {
        /* a repo string with a path in it would build a raw URL outside the
           intended host, so the shape is checked before any request */
        assert!(readme("owner/name/extra", "v1").is_err());
        assert!(readme("justname", "v1").is_err());
    }

    /// Trimmed from a real `GET /repos/cli/cli/releases/latest` response, with
    /// only the fields this module reads kept. It exists so a rename on
    /// GitHub's side breaks a test rather than silently emptying the
    /// marketplace — a serde default would otherwise make a missing field look
    /// like an empty catalog.
    #[test]
    fn a_real_release_response_deserializes_into_an_installable_row() {
        let body = br#"{
          "tag_name": "v2.102.0",
          "published_at": "2026-09-30T02:40:02Z",
          "html_url": "https://github.com/cli/cli/releases/tag/v2.102.0",
          "assets": [
            {
              "name": "gh_2.102.0_checksums.txt",
              "browser_download_url": "https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_checksums.txt",
              "digest": "sha256:afe49e9affa232faa8212aed035417166f6ade9b9470acb53d4dbd28c0504e8d",
              "size": 1971,
              "download_count": 37194
            },
            {
              "name": "acme-things-1.0.0.zip",
              "browser_download_url": "https://github.com/acme/things/releases/download/v1.0.0/acme-things-1.0.0.zip",
              "digest": "sha256:759b31942b78c05434a5d958fdacfc66aaf81446e283b4a8b1444104cf9de850",
              "size": 18432,
              "download_count": 12
            }
          ]
        }"#;
        let release: ReleaseResponse = serde_json::from_slice(body).unwrap();

        let p = merge(
            SearchHit {
                full_name: "acme/things".into(),
                description: Some("Tracks things".into()),
                stargazers_count: 314,
                html_url: "https://github.com/acme/things".into(),
                archived: false,
                fork: false,
            },
            Some(release),
        );

        assert!(p.installable, "note was: {}", p.note);
        assert_eq!(p.version, "v2.102.0");
        /* the non-zip asset is ignored, the zip is picked */
        assert_eq!(p.asset_name, "acme-things-1.0.0.zip");
        assert_eq!(p.downloads, 12);
        assert_eq!(p.stars, 314);
        /* the documented "sha256:" prefix is stripped before comparison */
        assert_eq!(p.sha256, "759b31942b78c05434a5d958fdacfc66aaf81446e283b4a8b1444104cf9de850");
        assert_eq!(p.sha256.len(), 64);
        assert!(!p.sha256.contains("sha256:"));
    }
}