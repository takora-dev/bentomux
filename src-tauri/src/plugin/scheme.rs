/* ---------------- plugin platform: the `plugin://` asset scheme ----------------
Spec: docs/PLUGIN_PLATFORM.md §10. Decision: docs/adr/0003.

Plugin code and assets are served to the webview from a custom scheme rather
than eval / blob: / data:, so every plugin has a real, inspectable URL space
the loader can cache-bust and a reviewer can trace. The production CSP names
this scheme in script-src / style-src / img-src and widens nothing else.

URL forms (they differ per platform, and the CSP must name both):
  macOS, Linux : plugin://localhost/<plugin-id>/<path>
  Windows      : http://plugin.localhost/<plugin-id>/<path>

The handler is the one place a plugin-supplied path reaches the filesystem,
so it resolves through safe_join and refuses anything outside the plugin's
own installed version directory. */

use tauri::http::{Request, Response, StatusCode};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder};

use crate::state::AppStateManager;

pub const SCHEME: &str = "plugin";

/// Directory an installed plugin's assets are served from, resolved from the
/// registry rather than from the URL: the request names an id and a path, and
/// the host decides which version directory that id currently means. Serving
/// by URL alone would let a rollback or update leave the two disagreeing.
fn version_dir_for(ctx: &UriSchemeContext<'_, tauri::Wry>, id: &str) -> Option<std::path::PathBuf> {
    let state = ctx.app_handle().state::<AppStateManager>();
    let snapshot = state.get_state();
    let record = snapshot.plugins.iter().find(|r| r.id == id)?;
    let dir = ctx
        .app_handle()
        .path()
        .app_data_dir()
        .ok()?
        .join("plugins")
        .join(&record.id)
        .join(&record.version);
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// Split `/acme.habit-tracker/index.js` into (id, "index.js"). Returns None
/// when the URL has no plugin id at all.
fn split_path(path: &str) -> Option<(&str, &str)> {
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    match trimmed.split_once('/') {
        Some((id, rest)) => Some((id, rest)),
        /* a bare id with no trailing path: serve nothing, the caller decides */
        None => Some((trimmed, "")),
    }
}

/// Strip the `@v/<token>/` version segment the loader puts in every plugin
/// URL. The token only exists to change the URL when the install changes, so
/// the webview's module map cannot hand back an old sibling module. Files
/// are always resolved from the registry's current version directory, so the
/// token is ignored for lookup.
fn strip_version_segment(rel: &str) -> &str {
    match rel.strip_prefix("@v/") {
        Some(rest) => rest.split_once('/').map(|(_, r)| r).unwrap_or(""),
        None => rel,
    }
}

fn content_type_for(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "html" | "htm" => "text/html; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Access-Control-Allow-Origin", "*")
        .body(b"not found".to_vec())
        .unwrap_or_else(|_| Response::new(b"not found".to_vec()))
}

fn forbidden(reason: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Access-Control-Allow-Origin", "*")
        .body(reason.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(b"forbidden".to_vec()))
}

/**
 * CORS is not optional here.
 *
 * `import()` is a module fetch, and module fetches always use CORS mode. The
 * app's page lives at `http://localhost:5173` in dev and `http://tauri.localhost`
 * in production, while plugin modules are served from `http://plugin.localhost`
 * — a different host, therefore a different origin. Without this header the
 * browser refuses the response and all the caller sees is
 * "Failed to fetch dynamically imported module", which says nothing about the
 * real cause.
 *
 * Neither Tauri nor wry adds this: both document that a custom-protocol server
 * must set it itself. `*` is safe because the scheme is only reachable from
 * this app's own webviews, and every request is already constrained to a
 * plugin's own installed directory by `safe_join`.
 */
const CORS: (&str, &str) = ("Access-Control-Allow-Origin", "*");

pub fn handle(
    ctx: UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let path = request.uri().path().to_string();

    let Some((id, rel)) = split_path(&path) else {
        responder.respond(not_found());
        return;
    };
    let rel = strip_version_segment(rel);
    if rel.is_empty() {
        responder.respond(not_found());
        return;
    }

    let Some(root) = version_dir_for(&ctx, id) else {
        responder.respond(not_found());
        return;
    };

    /* the single filesystem reach for plugin-controlled paths */
    let resolved = match crate::plugin::safe_join(&root, rel) {
        Some(p) => p,
        None => {
            responder.respond(forbidden("path escapes the plugin folder"));
            return;
        }
    };
    if !resolved.is_file() {
        responder.respond(not_found());
        return;
    }

    match std::fs::read(&resolved) {
        Ok(bytes) => {
            let response = Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", content_type_for(&resolved))
                .header(CORS.0, CORS.1)
                /* plugin code is fetched as a module; a stale cache would keep
                running the previous version after an update */
                .header("Cache-Control", "no-cache")
                .body(bytes)
                .unwrap_or_else(|_| Response::new(Vec::new()));
            responder.respond(response);
        }
        Err(_) => responder.respond(not_found()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_plugin_id_from_asset_path() {
        assert_eq!(split_path("/acme.t/index.js"), Some(("acme.t", "index.js")));
        assert_eq!(
            split_path("/acme.t/assets/icon.svg"),
            Some(("acme.t", "assets/icon.svg"))
        );
        assert_eq!(split_path("/acme.t"), Some(("acme.t", "")));
        assert_eq!(split_path("/"), None);
        assert_eq!(split_path(""), None);
    }

    /* Every response must carry the CORS header. Without it the browser
    refuses a module fetch and the only symptom is "Failed to fetch
    dynamically imported module", which points at nothing. */
    #[test]
    fn every_response_carries_cors() {
        for response in [not_found(), forbidden("nope")] {
            let header = response
                .headers()
                .get("Access-Control-Allow-Origin")
                .map(|v| v.to_str().unwrap_or(""));
            assert_eq!(header, Some("*"), "a response was built without CORS");
        }
        assert_eq!(CORS.0, "Access-Control-Allow-Origin");
        assert_eq!(CORS.1, "*");
    }

    #[test]
    fn version_segment_is_stripped_before_lookup() {
        assert_eq!(strip_version_segment("@v/ab12cd34/index.js"), "index.js");
        assert_eq!(strip_version_segment("@v/ab12cd34/assets/a.svg"), "assets/a.svg");
        assert_eq!(strip_version_segment("index.js"), "index.js");
    }

    #[test]
    fn content_types_cover_what_plugins_ship() {
        use std::path::Path;
        assert_eq!(
            content_type_for(Path::new("a.js")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            content_type_for(Path::new("a.mjs")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            content_type_for(Path::new("a.css")),
            "text/css; charset=utf-8"
        );
        assert_eq!(content_type_for(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(content_type_for(Path::new("a.png")), "image/png");
        assert_eq!(
            content_type_for(Path::new("a.unknown")),
            "application/octet-stream"
        );
        assert_eq!(
            content_type_for(Path::new("noext")),
            "application/octet-stream"
        );
    }
}
