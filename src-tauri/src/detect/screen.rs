/* ---------------- cached PTY screen snapshots ----------------
The authoritative vt100 parser lives in terminal.rs inside the persistent
PTY host. This module is deliberately a cache only: runtime detection and
remote rendering consume snapshots produced by that single parser. */

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::terminal::TerminalSnapshot;

fn screens() -> &'static Mutex<HashMap<String, TerminalSnapshot>> {
    static SCREENS: OnceLock<Mutex<HashMap<String, TerminalSnapshot>>> = OnceLock::new();
    SCREENS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn update_snapshot(id: &str, mut snapshot: TerminalSnapshot) {
    let mut guard = screens().lock().unwrap();
    /* an empty cwd means "this message did not carry one", never "the pane
    moved to /" — OSC 7 arrives rarely next to the 500 ms hot tick, so the
    last known value has to outlive a tick that omits it */
    if snapshot.cwd.is_empty() {
        if let Some(cur) = guard.get(id) {
            snapshot.cwd = cur.cwd.clone();
        }
    }
    match guard.get_mut(id) {
        /* hot tick carries text+meta only (see terminal.rs snapshot()): keep
        the cached html from the last explicit render so the remote mirror
        does not go blank between watched renders */
        Some(cur) if snapshot.html.is_empty() => {
            cur.text = snapshot.text;
            cur.title = snapshot.title;
            cur.progress = snapshot.progress;
            cur.last_data_at = snapshot.last_data_at;
            cur.cwd = snapshot.cwd;
        }
        _ => {
            guard.insert(id.to_string(), snapshot);
        }
    }
}

pub fn clear_snapshot(id: &str) {
    screens().lock().unwrap().remove(id);
}

pub fn screen_dump(id: &str) -> String {
    screens()
        .lock()
        .unwrap()
        .get(id)
        .map(|s| s.text.clone())
        .unwrap_or_default()
}

pub fn screen_lines(id: &str) -> Vec<String> {
    screen_dump(id)
        .lines()
        .map(|line| line.trim_end().to_string())
        .filter(|line| !line.trim().is_empty())
        .collect()
}

pub fn screen_meta(id: &str) -> (String, String, u64) {
    screens()
        .lock()
        .unwrap()
        .get(id)
        .map(|s| (s.title.clone(), s.progress.clone(), s.last_data_at))
        .unwrap_or_default()
}

pub fn screen_dump_html(id: &str) -> String {
    screens()
        .lock()
        .unwrap()
        .get(id)
        .map(|s| s.html.clone())
        .unwrap_or_default()
}

/* the pane's working directory, or "" when no shell has reported one */
pub fn screen_cwd(id: &str) -> String {
    screens()
        .lock()
        .unwrap()
        .get(id)
        .map(|s| s.cwd.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_exposes_runtime_lines_and_metadata() {
        update_snapshot(
            "cache-test",
            TerminalSnapshot {
                text: "  ready  \n\n".into(),
                html: "<span>ready</span>".into(),
                title: "Pi".into(),
                progress: "3;50".into(),
                last_data_at: 42,
                cwd: "/tmp/a b".into(),
            },
        );
        assert_eq!(screen_lines("cache-test"), vec!["  ready"]);
        assert_eq!(screen_meta("cache-test"), ("Pi".into(), "3;50".into(), 42));
        assert_eq!(screen_dump_html("cache-test"), "<span>ready</span>");
        assert_eq!(screen_cwd("cache-test"), "/tmp/a b");
        clear_snapshot("cache-test");
        assert!(screen_lines("cache-test").is_empty());
    }

    /* the hot tick omits html and may omit cwd; neither may erase what the
    last full snapshot knew */
    #[test]
    fn a_hot_tick_keeps_the_last_known_cwd() {
        update_snapshot(
            "cwd-test",
            TerminalSnapshot {
                text: "a".into(),
                html: "<b>a</b>".into(),
                title: String::new(),
                progress: String::new(),
                last_data_at: 1,
                cwd: "/work".into(),
            },
        );
        update_snapshot(
            "cwd-test",
            TerminalSnapshot {
                text: "ab".into(),
                html: String::new(),
                title: String::new(),
                progress: String::new(),
                last_data_at: 2,
                cwd: String::new(),
            },
        );
        assert_eq!(screen_cwd("cwd-test"), "/work");
        assert_eq!(screen_dump_html("cwd-test"), "<b>a</b>");
        clear_snapshot("cwd-test");
    }
}
