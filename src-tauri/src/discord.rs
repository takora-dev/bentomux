/* ---------------- Discord Rich Presence (IPC client for the Discord app) --------
The Discord desktop client exposes a local IPC endpoint per running instance:
a unix socket at `$XDG_RUNTIME_DIR`/`$TMPDIR`/`discord-ipc-N` on macOS and
Linux, a named pipe `\\.\pipe\discord-ipc-N` on Windows. There is no HTTP
listener and no other way to set a presence from outside the client, so this
module is the whole feature: find a live endpoint, open it, handshake, then
keep one connection open per application id and push activity updates over it.

The wire is a stream of frames, each `[u32 op][u32 length][payload]`, both
integers little-endian. The length is sent even though the op implies it,
because every client sends both and the server reads both. The two opcodes
used here are HANDSHAKE (0) and FRAME (1); the server's answers carry op 1
and are read only to confirm the handshake.

The connection is per application id for the app's lifetime, because Discord
ties a presence to the connection: a new socket each update makes the presence
flicker, and closing one clears it. That is also why `discord_clear_activity`
drops the connection — Discord removes the presence when the socket goes away.

Commands are async and do their I/O on a blocking thread: a connect to a
missing endpoint has to wait out its timeout, and that wait must not sit on
the webview's thread.
 */

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::Mutex;
use std::time::Duration;

/// Discord drops an activity whose field is past its own documented limit, so
/// these caps mirror Discord's, not ours.
const MAX_DETAILS: usize = 128;
const MAX_STATE: usize = 128;
const MAX_VALUE: usize = 128;
const MAX_BUTTON_LABEL: usize = 32;
const MAX_BUTTONS: usize = 2;

/// A presence belongs to the application id in the handshake, so this is the
/// Discord application id, never a user or bot token.
const MAX_APP_ID_LEN: usize = 64;

/// Discord picks the lowest free index, so the first probe usually finds it.
const MAX_ENDPOINTS: u32 = 10;

/// Every read and write is bounded: a socket left behind by a crashed client
/// must make the call fail fast rather than hang the caller.
#[cfg_attr(windows, allow(dead_code))]
const IO_TIMEOUT: Duration = Duration::from_millis(1500);

/// The two opcodes this module sends: HANDSHAKE opens a connection, FRAME
/// carries a command on it. Discord's answers are FRAME.
const HANDSHAKE: u32 = 0;
const FRAME: u32 = 1;

/* ---------------- what a caller may set ---------------- */

/// One activity button. Discord renders at most two, under the presence.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityButton {
    pub label: String,
    pub url: String,
}

/// A Rich Presence activity. Only the fields a developer sets are modelled;
/// timestamps are epoch millis and pass through as given.
///
/// Deserialized in camelCase, because that is the app's wire convention
/// between the renderer and a Tauri command. It is *not* what Discord
/// wants — see `ActivityWire`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Activity {
    /// Required, and must be one of Discord's approved application names
    /// ("Visual Studio Code", "Terminal", ...).
    pub details: String,
    pub state: String,
    pub large_image: Option<String>,
    pub large_text: Option<String>,
    pub small_image: Option<String>,
    pub small_text: Option<String>,
    pub start_timestamp: Option<i64>,
    pub end_timestamp: Option<i64>,
    pub buttons: Vec<ActivityButton>,
}

/// The activity as Discord's IPC protocol wants it: **snake_case**.
///
/// This is not cosmetic. Discord's client parses the activity object itself,
/// so a camelCase `largeImage` / `startTimestamp` is not an error — it is
/// simply an unknown key that gets dropped, and the presence renders with no
/// image and no elapsed timer. The IPC layer echoes whatever it was sent, so
/// the echo looks healthy either way and only the rendered presence tells the
/// truth. Which is why `startTimestamp` in particular matters: without it
/// there is no timer.
#[derive(Debug, Serialize)]
struct ActivityWire<'a> {
    details: &'a str,
    state: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    large_image: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    large_text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    small_image: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    small_text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_timestamp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end_timestamp: Option<i64>,
    #[serde(skip_serializing_if = "<[ActivityButton]>::is_empty")]
    buttons: &'a [ActivityButton],
}

impl Activity {
    fn to_wire(&self) -> ActivityWire<'_> {
        ActivityWire {
            details: &self.details,
            state: &self.state,
            large_image: self.large_image.as_deref(),
            large_text: self.large_text.as_deref(),
            small_image: self.small_image.as_deref(),
            small_text: self.small_text.as_deref(),
            start_timestamp: self.start_timestamp,
            end_timestamp: self.end_timestamp,
            buttons: self.buttons.as_slice(),
        }
    }
}

/// Truncate rather than reject: a long project path should still produce a
/// presence, and Discord would have cut it anyway.
fn clamp(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max - 1).collect::<String>() + "…"
}

/// A button without an https URL is dropped. Discord renders it as a link,
/// so a `javascript:` or `file:` one is not a button worth sending.
fn valid_button(button: &ActivityButton) -> bool {
    button.url.starts_with("https://") && button.url.len() <= 512
}

fn sanitized(activity: &Activity) -> Activity {
    Activity {
        details: clamp(&activity.details, MAX_DETAILS),
        state: clamp(&activity.state, MAX_STATE),
        large_image: activity.large_image.clone(),
        large_text: activity.large_text.clone().map(|v| clamp(&v, MAX_VALUE)),
        small_image: activity.small_image.clone(),
        small_text: activity.small_text.clone().map(|v| clamp(&v, MAX_VALUE)),
        start_timestamp: activity.start_timestamp,
        end_timestamp: activity.end_timestamp,
        buttons: activity
            .buttons
            .iter()
            .take(MAX_BUTTONS)
            .filter(|b| valid_button(b))
            .map(|b| ActivityButton {
                label: clamp(&b.label, MAX_BUTTON_LABEL),
                url: b.url.clone(),
            })
            .collect(),
    }
}

/* ---------------- the wire ---------------- */

fn frame(op: u32, payload: &serde_json::Value) -> Vec<u8> {
    let body = serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec());
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(&op.to_le_bytes());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

/// Read one frame and return the opcode from its **header**, draining the body.
///
/// The opcode lives in the header only. Discord's reply to a handshake is
/// `{"cmd":"DISPATCH","data":{…},"evt":"READY","nonce":null}` with no `op`
/// key in the JSON at all, so reading it out of the body makes every
/// handshake look unanswered. The body is still drained: leaving it in the
/// stream would shift every later frame by its own length.
fn read_op(stream: &mut impl Read) -> Option<u32> {
    let mut header = [0u8; 8];
    stream.read_exact(&mut header).ok()?;
    let op = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    /* a length past this is not a frame we asked for; drop the connection
       rather than allocate whatever the peer claimed */
    if len > 64 * 1024 {
        return None;
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).ok()?;
    Some(op)
}

#[cfg(unix)]
type Endpoint = std::os::unix::net::UnixStream;

/// A Windows named pipe opens as a file, which is the only way to talk to one
/// without an async runtime; the pipe path is what we reopen each time.
#[cfg(windows)]
type Endpoint = std::fs::File;

#[cfg(windows)]
fn endpoint_path(index: u32) -> String {
    format!(r"\\.\pipe\discord-ipc-{index}")
}

#[cfg(unix)]
fn endpoint_path(index: u32) -> std::path::PathBuf {
    /* Linux distributions put it under $XDG_RUNTIME_DIR, which matters because
       a flatpak or snap Discord creates no entry in $TMPDIR. */
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| std::env::var_os("TMPDIR").map(std::path::PathBuf::from))
        .unwrap_or_else(std::env::temp_dir)
        .join(format!("discord-ipc-{index}"))
}

#[cfg(windows)]
fn open_endpoint(index: u32) -> Option<Endpoint> {
    let path = endpoint_path(index);
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .ok()
}

#[cfg(unix)]
fn open_endpoint(index: u32) -> Option<Endpoint> {
    let path = endpoint_path(index);
    /* A socket file left behind by a crashed Discord exists but refuses to
       connect; `exists` alone would report it as a running client. */
    path.exists()
        .then(|| std::os::unix::net::UnixStream::connect(path).ok())
        .flatten()
}

/// Whether a Discord client is running. Cheap — it stats the endpoint paths
/// rather than connecting, so it is safe to call from a status surface.
#[tauri::command]
pub fn discord_status() -> bool {
    (0..MAX_ENDPOINTS).any(|i| open_endpoint(i).is_some())
}

/* ---------------- connections ---------------- */

struct Connection {
    endpoint: Endpoint,
    /// Discord matches an answer to a request by nonce, so ours has to vary.
    nonce: u64,
}

static CONNECTIONS: Mutex<Option<Vec<(String, Connection)>>> = Mutex::new(None);

fn with_connections<R>(f: impl FnOnce(&mut Vec<(String, Connection)>) -> R) -> R {
    let mut guard = CONNECTIONS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Vec::new))
}

/// Open and handshake a connection for `app_id`, or reuse the live one.
fn connect(app_id: &str) -> Result<(), String> {
    if app_id.is_empty() || app_id.len() > MAX_APP_ID_LEN {
        return Err(format!(
            "discord app id must be 1-{MAX_APP_ID_LEN} characters"
        ));
    }
    with_connections(|conns| {
        if conns.iter().any(|(id, _)| id == app_id) {
            return Ok(());
        }
        let mut endpoint = (0..MAX_ENDPOINTS).find_map(open_endpoint).ok_or_else(|| {
            "no Discord IPC endpoint found — is the Discord desktop app running?".to_string()
        })?;
        #[cfg(unix)]
        endpoint
            .set_read_timeout(Some(IO_TIMEOUT))
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        endpoint
            .set_write_timeout(Some(IO_TIMEOUT))
            .map_err(|e| e.to_string())?;
        let handshake = frame(HANDSHAKE, &serde_json::json!({ "v": 1, "client_id": app_id }));
        endpoint.write_all(&handshake).map_err(|e| e.to_string())?;
        /* Discord answers a handshake with a FRAME carrying READY. There is
           no acknowledgement for the handshake itself, so accepting any
           well-formed frame is the strongest signal available. */
        match read_op(&mut endpoint) {
            Some(FRAME) => {}
            Some(other) => {
                return Err(format!("unexpected opcode {other} in the Discord handshake"))
            }
            None => return Err("Discord did not answer the handshake".to_string()),
        }
        conns.push((app_id.to_string(), Connection { endpoint, nonce: 0 }));
        Ok(())
    })
}

/// Push one activity frame. A write failure means Discord went away, so the
/// connection is dropped and the next call re-handshakes.
fn send_activity(app_id: &str, activity: serde_json::Value) -> Result<(), String> {
    with_connections(|conns| {
        let index = conns
            .iter()
            .position(|(id, _)| id == app_id)
            .ok_or_else(|| "no Discord connection".to_string())?;
        let conn = &mut conns[index].1;
        conn.nonce += 1;
        let payload = serde_json::json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": activity },
            "nonce": format!("{app_id}-{}", conn.nonce),
        });
        match conn.endpoint.write_all(&frame(FRAME, &payload)) {
            Ok(()) => Ok(()),
            Err(e) => {
                conns.remove(index);
                Err(format!("Discord connection lost: {e}"))
            }
        }
    })
}

/* ---------------- commands ---------------- */

/// Set the presence for `app_id`, connecting on first use.
///
/// Ok means the frame reached the Discord client. Discord sends no
/// acknowledgement for an activity, so this cannot promise a presence is on
/// screen — the application id also has to match an asset set the developer
/// uploaded, and nothing here can check that.
#[tauri::command]
pub async fn discord_set_activity(app_id: String, activity: Activity) -> Result<(), String> {
    let activity = sanitized(&activity);
    tauri::async_runtime::spawn_blocking(move || {
        connect(&app_id)?;
        send_activity(&app_id, serde_json::to_value(activity.to_wire()).unwrap_or_default())
    })
    .await
    .map_err(|e| format!("Discord task failed: {e}"))?
}

/// Clear the presence for `app_id` and close its connection. Discord removes
/// the presence when the socket closes, so this is also the plugin's exit path.
#[tauri::command]
pub async fn discord_clear_activity(app_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        /* Best effort: a client that is already gone has nothing to clear, and
           failing here would turn a normal shutdown into an error the user
           has to interpret. */
        let _ = send_activity(&app_id, serde_json::Value::Null);
        with_connections(|conns| conns.retain(|(id, _)| id != &app_id));
        Ok(())
    })
    .await
    .map_err(|e| format!("Discord task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn activity(details: &str) -> Activity {
        Activity { details: details.into(), ..Default::default() }
    }

    #[test]
    fn frame_is_little_endian_op_then_length() {
        let bytes = frame(1, &serde_json::json!({ "a": 1 }));
        assert_eq!(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]), 1);
        assert_eq!(
            u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize,
            bytes.len() - 8
        );
    }

    #[test]
    fn long_details_are_truncated_not_rejected() {
        let out = sanitized(&activity(&"x".repeat(400)));
        assert_eq!(out.details.chars().count(), MAX_DETAILS);
    }

    #[test]
    fn buttons_need_https_and_at_most_two_are_kept() {
        let out = sanitized(&Activity {
            buttons: vec![
                ActivityButton { label: "a".into(), url: "https://example.com".into() },
                ActivityButton { label: "b".into(), url: "https://example.org".into() },
                ActivityButton { label: "c".into(), url: "https://example.net".into() },
            ],
            ..Default::default()
        });
        assert_eq!(out.buttons.len(), MAX_BUTTONS);

        let unsafe_url = sanitized(&Activity {
            buttons: vec![ActivityButton {
                label: "x".into(),
                url: "javascript:alert(1)".into(),
            }],
            ..Default::default()
        });
        assert!(unsafe_url.buttons.is_empty());
    }

    #[test]
    fn clear_succeeds_whether_or_not_discord_runs() {
        /* No client, no connection: clear must not fail, or disabling the
           plugin surfaces an error the user cannot act on. */
        tauri::async_runtime::block_on(discord_clear_activity("0".into())).unwrap();
        assert!(with_connections(|c| c.is_empty()));
    }

    #[test]
    fn the_wire_format_is_snake_case_not_the_apps_camel_case() {
        /* Discord's client parses the activity itself and drops any key it
           does not know, so camelCase here means a presence with no image and
           no timer — and the IPC echo still looks healthy. This pins the
           translation. */
        let activity = Activity {
            details: "Bentomux".into(),
            state: "proj".into(),
            large_image: Some("logo".into()),
            large_text: Some("Bentomux".into()),
            small_image: Some("logo".into()),
            small_text: Some("working".into()),
            start_timestamp: Some(1_700_000_000_000),
            end_timestamp: None,
            buttons: Vec::new(),
        };
        let wire = serde_json::to_value(activity.to_wire()).unwrap();
        for key in [
            "details",
            "state",
            "large_image",
            "large_text",
            "small_image",
            "small_text",
            "start_timestamp",
        ] {
            assert!(wire.get(key).is_some(), "wire must carry `{key}`: {wire}");
        }
        for key in [
            "largeImage",
            "smallImage",
            "smallText",
            "largeText",
            "startTimestamp",
        ] {
            assert!(wire.get(key).is_none(), "wire must not carry `{key}`: {wire}");
        }
    }

    #[test]
    fn absent_wire_fields_are_omitted_not_sent_as_null() {
        /* Discord renders an explicit null differently from an absent key, so
           the wire form skips them rather than serializing `None`. */
        let wire = serde_json::to_value(Activity::default().to_wire()).unwrap();
        assert!(wire.get("large_image").is_none());
        assert!(wire.get("buttons").is_none());
        assert_eq!(wire.get("details").unwrap(), "");
    }

    #[test]
    fn the_opcode_comes_from_the_header_not_the_body() {
        /* Discord's handshake reply has no `op` key in its JSON — reading it
           from the body made every handshake look unanswered, so this pins
           the header as the only place the opcode is read from. */
        let frame = super::frame(super::FRAME, &serde_json::json!({
            "cmd": "DISPATCH",
            "data": { "v": 1 },
            "evt": "READY",
            "nonce": null,
        }));
        let op = read_op(&mut frame.as_slice()).expect("a well-formed frame reads back");
        assert_eq!(op, super::FRAME);
    }

    #[test]
    fn a_truncated_frame_reads_as_none() {
        let mut frame = super::frame(super::FRAME, &serde_json::json!({ "cmd": "DISPATCH" }));
        frame.truncate(frame.len() - 3);
        assert_eq!(read_op(&mut frame.as_slice()), None);
    }

    #[test]
    fn an_absurd_length_is_refused_without_allocating_it() {
        let mut header = Vec::new();
        header.extend_from_slice(&super::FRAME.to_le_bytes());
        header.extend_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(read_op(&mut header.as_slice()), None);
    }
}
