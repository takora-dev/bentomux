/* ---------------- git branch per workspace + CLI operations ----------------
Rust port of src/main/git.rs (branch watch) + src/main/git-ops.ts
(status/diff/push/remoteInfo). Reads .git/HEAD directly for the branch
and polls the git dir; shells out to git (never node-pty) for the ops.
Handles .git as a file (worktrees / submodules).

`history()` is the one addition with no Electron counterpart — the commit
graph is new UI, not a port (see docs/adr/0002-parity-rule-amended.md). */

use crate::lock::LockExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;

/* ---------------- git dir + branch detection ---------------- */

pub fn git_dir_for(ws_path: &str) -> Option<String> {
    let dot = Path::new(ws_path).join(".git");
    if !dot.exists() {
        return None;
    }
    let head = dot.join("HEAD");
    if head.exists() {
        return Some(dot.to_string_lossy().into_owned());
    }
    /* .git file: "gitdir: /path/to/real/gitdir" */
    if let Ok(content) = std::fs::read_to_string(&dot) {
        let first = content.trim();
        if let Some(rest) = first.strip_prefix("gitdir:") {
            let real = rest.trim();
            let real = if Path::new(real).is_absolute() {
                real.to_string()
            } else {
                Path::new(ws_path).join(real).to_string_lossy().into_owned()
            };
            let real_head = Path::new(&real).join("HEAD");
            return if real_head.exists() { Some(real) } else { None };
        }
    }
    None
}

pub fn branch_for(ws_path: &str) -> Result<Option<String>, String> {
    Ok(read_branch(ws_path))
}

pub fn read_branch(ws_path: &str) -> Option<String> {
    let dir = git_dir_for(ws_path)?;
    let content = std::fs::read_to_string(Path::new(&dir).join("HEAD")).ok()?;
    let head = content.trim();
    if let Some(rest) = head.strip_prefix("ref: refs/heads/") {
        Some(rest.to_string())
    } else if let Some(rest) = head.strip_prefix("ref: refs/") {
        Some(rest.to_string())
    } else {
        /* detached HEAD: first 7 chars of the hash */
        Some(head.chars().take(7).collect())
    }
}

/* ---------------- branch watcher (fs.watch on .git/HEAD + 4s poll) ----------------
The Electron version pairs an fs.watch on the git dir with a 4s poll.
We mirror that with a notify::recommended_watcher on the git dir (fires on
HEAD changes, 60ms debounce) plus a per-workspace poll as the safety net. */

type BranchCb = Box<dyn Fn(&str, Option<&str>) + Send + Sync>;

struct WatchState {
    watchers: HashMap<String, Option<String>>, /* workspaceId → last branch */
    notify: Option<BranchCb>,
    handle: Option<tauri::AppHandle>,
}

fn watch_state() -> &'static Mutex<Option<WatchState>> {
    use std::sync::OnceLock;
    static STATE: OnceLock<Mutex<Option<WatchState>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

/* called once from setup; provides the app handle for branch events */
pub fn init_watch(handle: tauri::AppHandle) {
    let mut guard = watch_state().lock_recover();
    if guard.is_none() {
        *guard = Some(WatchState {
            watchers: HashMap::new(),
            notify: None,
            handle: Some(handle),
        });
    }
}

pub fn on_branch_change(cb: impl Fn(&str, Option<&str>) + Send + Sync + 'static) {
    let mut guard = watch_state().lock_recover();
    let st = guard.get_or_insert_with(|| WatchState {
        watchers: HashMap::new(),
        notify: None,
        handle: None,
    });
    st.notify = Some(Box::new(cb));
}

fn emit_branch(workspace_id: &str, branch: Option<&str>) {
    if let Some(st) = watch_state().lock_recover().as_ref() {
        if let Some(cb) = &st.notify {
            cb(workspace_id, branch);
        }
        if let Some(app) = &st.handle {
            let _ = app.emit("branch", (workspace_id, branch));
        }
    }
}

/* true while a workspace is still registered (not yet unwatched) */
fn registered(workspace_id: &str) -> bool {
    watch_state()
        .lock_recover()
        .as_ref()
        .is_some_and(|s| s.watchers.contains_key(workspace_id))
}

/* read the branch, compare to the stored last value, and emit the event when
it changed. true when the workspace is still registered (not unwatched). */
fn check_and_emit(workspace_id: &str, ws_path: &str) -> bool {
    let cur = read_branch(ws_path);
    let should_emit = {
        let mut guard = watch_state().lock_recover();
        match guard
            .as_mut()
            .and_then(|s| s.watchers.get_mut(workspace_id))
        {
            Some(prev) => {
                if *prev != cur {
                    *prev = cur.clone();
                    true
                } else {
                    false
                }
            }
            None => return false, /* workspace unregistered: stop the loop */
        }
    };
    if should_emit {
        emit_branch(workspace_id, cur.as_deref());
    }
    true
}

pub fn watch_workspace(workspace_id: &str, ws_path: &str) {
    unwatch_workspace(workspace_id);
    {
        let mut guard = watch_state().lock_recover();
        let st = guard.get_or_insert_with(|| WatchState {
            watchers: HashMap::new(),
            notify: None,
            handle: None,
        });
        st.watchers
            .insert(workspace_id.to_string(), read_branch(ws_path));
    }
    let ws_path = ws_path.to_string();
    let wid = workspace_id.to_string();

    /* instant trigger: fs-watch the git dir, ignore transient files, then
    quietly re-check the branch (git.ts's `setTimeout(check,60)`). */
    if let Some(dir) = git_dir_for(&ws_path) {
        let dir = dir.clone();
        let wid2 = wid.clone();
        let ws2 = ws_path.clone();
        std::thread::spawn(move || {
            use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
            let (tx, rx) = std::sync::mpsc::channel();
            let on_event = move |res: notify::Result<notify::Event>| {
                let _ = tx.send(res);
            };
            if let Ok(mut watcher) = RecommendedWatcher::new(on_event, notify::Config::default()) {
                if watcher
                    .watch(Path::new(&dir), RecursiveMode::NonRecursive)
                    .is_ok()
                {
                    for ev in rx.into_iter().flatten() {
                        match ev.kind {
                            EventKind::Access(_)
                            | EventKind::Create(_)
                            | EventKind::Modify(_)
                            | EventKind::Remove(_) => {}
                            _ => continue,
                        }
                        let is_head = ev
                            .paths
                            .iter()
                            .any(|p| p.file_name().and_then(|n| n.to_str()) == Some("HEAD"));
                        if is_head {
                            std::thread::sleep(Duration::from_millis(60));
                            check_and_emit(&wid2, &ws2);
                            if !registered(&wid2) {
                                break; /* workspace unwatched */
                            }
                        }
                    }
                }
            }
        });
    }

    /* safety-net poll, mirroring the Electron interval; stops on unwatch */
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(4));
        if !check_and_emit(&wid, &ws_path) {
            break;
        }
    });
}

pub fn unwatch_workspace(workspace_id: &str) {
    if let Some(st) = watch_state().lock_recover().as_mut() {
        st.watchers.remove(workspace_id);
    }
}

pub fn unwatch_all() {
    if let Some(st) = watch_state().lock_recover().as_mut() {
        st.watchers.clear();
    }
}

/* ---------------- git CLI operations ---------------- */

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    /* two-letter XY status, e.g. " M", "M ", "A ", "??", "R " */
    pub status: String,
    pub index_status: String,
    pub work_tree_status: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<GitStatusEntry>,
    pub has_untracked: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub path: String,
    pub status: String,
    pub patch: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub is_repo: bool,
    pub files: Vec<GitFileDiff>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffStatResult {
    pub is_repo: bool,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteInfo {
    pub is_repo: bool,
    pub remote: Option<String>,
    pub default_branch: Option<String>,
}

/* ---------------- history (commit graph) ---------------- */

/* a branch, remote-tracking branch, or tag pointing at a commit */
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitRef {
    pub name: String,
    /* "branch" | "remote" | "tag" */
    pub kind: String,
    /* true for the branch HEAD is on */
    pub head: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub oid: String,
    pub short: String,
    pub parents: Vec<String>,
    pub author: String,
    /* unix seconds */
    pub timestamp: i64,
    pub subject: String,
    pub refs: Vec<GitRef>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryResult {
    pub is_repo: bool,
    pub commits: Vec<GitCommit>,
}

const MAX_BUFFER: usize = 8 * 1024 * 1024; /* 8 MiB per stream — git diff of a big repo */
const DEFAULT_TIMEOUT_MS: u64 = 60_000;

#[derive(Default)]
struct RunOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

/* blocked git run with per-stream buffer cap + timeout; mirrors runProcess */
fn run_process(cwd: &str, args: &[&str], timeout_ms: Option<u64>) -> Result<RunOutput, String> {
    #[allow(unused_mut)]
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    /* suppress the brief console window flash on Windows */
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000 /* CREATE_NO_WINDOW */);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("git spawn failed: {}", e))?;

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    /* stdout/stderr configured as piped above, so take() always yields a stream */
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let so = std::thread::spawn(move || drain_capped(stdout));
    let se = std::thread::spawn(move || drain_capped(stderr));

    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = RunOutput {
                    code: status.code().unwrap_or(0),
                    stdout: so.join().unwrap_or_default(),
                    stderr: se.join().unwrap_or_default(),
                };
                return Ok(out);
            }
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    return Err(format!(
                        "git {} timed out after {}ms",
                        args.join(" "),
                        timeout.as_millis()
                    ));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => return Err(format!("git wait failed: {}", e)),
        }
    }
}

fn drain_capped(reader: impl std::io::Read) -> String {
    let mut r = reader;
    let mut out = String::new();
    let mut buf = [0u8; 8192];
    let mut total = 0usize;
    loop {
        match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                total += n;
                if total > MAX_BUFFER {
                    break;
                }
                out.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
            Err(_) => break,
        }
    }
    out
}

/* Every git call here is a process spawn, and on macOS a spawn costs ~90ms
whatever it runs (`git --version` measures the same as `git log -n200`). The
work git does is a rounding error next to that, so the thing worth minimising
is the *number* of spawns, and any two calls that do not depend on each other
run on their own thread. `scope` lets them borrow ws_path/oid directly. */

fn ensure_ok(r: &RunOutput, what: &str) -> Result<(), String> {
    if r.code == 0 {
        return Ok(());
    }
    let msg = r.stderr.trim();
    let msg = if msg.is_empty() { r.stdout.trim() } else { msg };
    Err(if msg.is_empty() {
        format!("{} exited with code {}", what, r.code)
    } else {
        msg.to_string()
    })
}

/* ---------------- status ---------------- */

fn parse_status(parts: &[String]) -> (Option<String>, u32, u32, Vec<GitStatusEntry>, bool) {
    let mut branch = None;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut entries = Vec::new();
    let mut has_untracked = false;
    let mut i = 0;
    while i < parts.len() {
        let p = &parts[i];
        if let Some(rest) = p.strip_prefix("## ") {
            if let Some(d) = rest.find("...") {
                branch = Some(rest[..d].to_string());
            } else if !rest.starts_with("HEAD") {
                branch = rest.split(' ').next().map(String::from);
            }
            if let Some(start) = rest.find('[') {
                let body = &rest[start..];
                if let Some(a) = parse_named(body, "ahead") {
                    ahead = a;
                }
                if let Some(b) = parse_named(body, "behind") {
                    behind = b;
                }
            }
            i += 1;
            continue;
        }
        if let Some(mut entry) = parse_status_line(p) {
            /* porcelain rename: "R <orig>\0<new>"; consume the next segment */
            if (entry.index_status == "R" || entry.index_status == "C") && i + 1 < parts.len() {
                let next = parts[i + 1].clone();
                if !next.is_empty() {
                    entry.path = next;
                    entries.push(entry);
                    i += 2;
                    continue;
                }
            }
            if entry.index_status == "?" && entry.work_tree_status == "?" {
                has_untracked = true;
            }
            entries.push(entry);
        }
        i += 1;
    }
    (branch, ahead, behind, entries, has_untracked)
}

fn parse_named(body: &str, name: &str) -> Option<u32> {
    let idx = body.find(name)?;
    let rest = &body[idx + name.len()..];
    let rest = rest.trim_start_matches([' ', '(', ',']);
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn parse_status_line(line: &str) -> Option<GitStatusEntry> {
    if line.len() < 4 {
        return None;
    }
    let index_status = line.chars().next().unwrap_or(' ');
    let work_tree_status = line.chars().nth(1).unwrap_or(' ');
    let path = &line[3..];
    if path.is_empty() {
        return None;
    }
    Some(GitStatusEntry {
        path: path.to_string(),
        status: line[..2].to_string(),
        index_status: index_status.to_string(),
        work_tree_status: work_tree_status.to_string(),
    })
}

pub fn status(ws_path: &str) -> GitStatusResult {
    if git_dir_for(ws_path).is_none() {
        return GitStatusResult::default();
    }
    let Ok(r) = run_process(
        ws_path,
        &["status", "--porcelain=v1", "-z", "-uall", "--branch"],
        None,
    ) else {
        return GitStatusResult {
            is_repo: true,
            ..Default::default()
        };
    };
    if let Err(e) = ensure_ok(&r, "git status") {
        eprintln!("[bentomux] git status: {}", e);
        return GitStatusResult {
            is_repo: true,
            ..Default::default()
        };
    }
    let parts: Vec<String> = r
        .stdout
        .split('\0')
        .map(String::from)
        .filter(|s| !s.is_empty())
        .collect();
    let (branch, ahead, behind, entries, has_untracked) = parse_status(&parts);
    GitStatusResult {
        is_repo: true,
        branch,
        ahead,
        behind,
        entries,
        has_untracked,
    }
}

/* ---------------- diff ---------------- */

pub fn diff(ws_path: &str, path: Option<&str>) -> GitDiffResult {
    if git_dir_for(ws_path).is_none() {
        return GitDiffResult::default();
    }
    /* for an untracked file, mark intent-to-add so git's diff machinery includes it */
    if let Some(path) = path {
        let _ = run_process(ws_path, &["add", "-N", "--", path], None);
    }
    let mut args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", "--unified=3"];
    if let Some(path) = path {
        args.push("--");
        args.push(path);
    }
    let Ok(r) = run_process(ws_path, &args, None) else {
        return GitDiffResult {
            is_repo: true,
            ..Default::default()
        };
    };
    if let Err(e) = ensure_ok(&r, "git diff") {
        eprintln!("[bentomux] git diff: {}", e);
        return GitDiffResult {
            is_repo: true,
            ..Default::default()
        };
    }
    let files = parse_diff_blocks(&r.stdout);
    GitDiffResult {
        is_repo: true,
        files,
    }
}

fn parse_diff_blocks(stdout: &str) -> Vec<GitFileDiff> {
    diff_blocks(stdout)
        .map(|block| {
            let (path, status) = block_path_status(block);
            GitFileDiff {
                path,
                status,
                patch: format!("diff --git {}", block),
            }
        })
        .collect()
}

/* the per-file blocks of a `git diff` / `git show` patch. Every caller splits
the same way, so the split lives here rather than being repeated. */
fn diff_blocks(stdout: &str) -> impl Iterator<Item = &str> {
    stdout.split("diff --git ").filter(|b| !b.is_empty())
}

fn block_path_status(block: &str) -> (String, String) {
    let header = block.lines().next().unwrap_or("");
    /* "a/<path> b/<path>" — the simple split on " b/" handles common paths */
    let path = match header.find(" b/") {
        Some(idx) => header[idx + 3..].to_string(),
        None => header.to_string(),
    };
    let status = if block.contains("new file") {
        "A"
    } else if block.contains("deleted file") {
        "D"
    } else if block.contains("rename ") {
        "R"
    } else if block.contains("copy ") {
        "C"
    } else {
        "M"
    };
    (path, status.to_string())
}

/* +N/-N for one file's block, counted from the patch itself so the commit
detail view needs one git call instead of a second --numstat pass.

Counting starts at the first `@@`: before it, `---`/`+++` are file headers,
but inside a hunk a line reading `+++foo` is genuinely an added line and
must count. Binary files have no hunk and correctly report 0/0. */
fn count_patch_lines(block: &str) -> (u64, u64) {
    let mut adds = 0u64;
    let mut dels = 0u64;
    let mut in_hunk = false;
    for line in block.lines() {
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        if !in_hunk || line.starts_with('\\') {
            continue; /* headers, and the "\ No newline at end of file" marker */
        }
        if line.starts_with('+') {
            adds += 1;
        } else if line.starts_with('-') {
            dels += 1;
        }
    }
    (adds, dels)
}

/* ---------------- diff stat (totals for the Changes pill) ---------------- */

pub fn diff_stat(ws_path: &str) -> GitDiffStatResult {
    if git_dir_for(ws_path).is_none() {
        return GitDiffStatResult::default();
    }
    let Ok(r) = run_process(ws_path, &["diff", "--numstat"], None) else {
        return GitDiffStatResult {
            is_repo: true,
            ..Default::default()
        };
    };
    if let Err(e) = ensure_ok(&r, "git diff --numstat") {
        eprintln!("[bentomux] git diff --numstat: {}", e);
        return GitDiffStatResult {
            is_repo: true,
            ..Default::default()
        };
    }
    let mut additions = 0u64;
    let mut deletions = 0u64;
    for line in r.stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut it = trimmed.splitn(3, '\t');
        let a = it.next().unwrap_or("");
        let d = it.next().unwrap_or("");
        if a == "-" || d == "-" {
            continue; /* binary */
        }
        additions += a.parse::<u64>().unwrap_or(0);
        deletions += d.parse::<u64>().unwrap_or(0);
    }
    GitDiffStatResult {
        is_repo: true,
        additions,
        deletions,
    }
}

/* ---------------- push ---------------- */

fn has_upstream(ws_path: &str) -> bool {
    match run_process(
        ws_path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        None,
    ) {
        Ok(r) => r.code == 0 && !r.stdout.trim().is_empty(),
        Err(_) => false,
    }
}

pub fn push(ws_path: &str, set_upstream: bool) -> GitCommandResult {
    if git_dir_for(ws_path).is_none() {
        return GitCommandResult {
            ok: false,
            stderr: "Not a git repository".into(),
            ..Default::default()
        };
    }
    let mut args: Vec<String> = vec!["push".to_string()];
    if set_upstream && !has_upstream(ws_path) {
        if let Some(branch) = status(ws_path).branch {
            args.push("--set-upstream".to_string());
            args.push("origin".to_string());
            args.push(branch);
        }
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let r = run_process(ws_path, &arg_refs, Some(120_000)).unwrap_or_default();
    GitCommandResult {
        ok: r.code == 0,
        stdout: r.stdout,
        stderr: r.stderr,
        code: r.code,
    }
}

/* ---------------- remote info ---------------- */

pub fn remote_info(ws_path: &str) -> GitRemoteInfo {
    if git_dir_for(ws_path).is_none() {
        return GitRemoteInfo::default();
    }
    let Ok(r) = run_process(ws_path, &["remote"], None) else {
        return GitRemoteInfo {
            is_repo: true,
            ..Default::default()
        };
    };
    if let Err(e) = ensure_ok(&r, "git remote") {
        eprintln!("[bentomux] git remote: {}", e);
        return GitRemoteInfo {
            is_repo: true,
            ..Default::default()
        };
    }
    let remote = r
        .stdout
        .lines()
        .map(|s| s.trim())
        .find(|s| !s.is_empty())
        .map(String::from);
    let Some(remote) = remote else {
        return GitRemoteInfo {
            is_repo: true,
            remote: None,
            default_branch: None,
        };
    };
    let default_branch = {
        let head_arg = format!("refs/remotes/{}/HEAD", remote);
        let arg_refs: Vec<&str> = vec!["--short", &head_arg];
        run_process(ws_path, &arg_refs, None).ok().and_then(|h| {
            if h.code == 0 {
                h.stdout.trim().split('/').next_back().map(String::from)
            } else {
                None
            }
        })
    };
    GitRemoteInfo {
        is_repo: true,
        remote: Some(remote),
        default_branch,
    }
}

/* ---------------- history (commit graph) ---------------- */

/* the graph renders `-n` commits at a time; a repo with a longer history just
shows the newest window rather than paging */
const HISTORY_LIMIT: usize = 200;
/* record/field separators for `git log --pretty=format:` — control characters
cannot appear in a subject or author name, so they are unambiguous */
const FIELD_SEP: char = '\u{1f}';
const RECORD_SEP: char = '\u{1e}';

fn ref_kind_and_name(full: &str) -> Option<(&'static str, &str)> {
    if let Some(n) = full.strip_prefix("refs/heads/") {
        Some(("branch", n))
    } else if let Some(n) = full.strip_prefix("refs/remotes/") {
        Some(("remote", n))
    } else if let Some(n) = full.strip_prefix("refs/tags/") {
        Some(("tag", n))
    } else {
        None
    }
}

/* `%(objectname)\x1f%(*objectname)\x1f%(HEAD)\x1f%(refname)` → (commit oid, ref).
An annotated tag's ref points at the tag object, so `%(*objectname)` (the
dereferenced commit) wins when it is present. */
fn parse_ref_line(line: &str) -> Option<(String, GitRef)> {
    let mut it = line.split(FIELD_SEP);
    let obj = it.next()?.trim();
    let deref = it.next().unwrap_or("").trim();
    let head = it.next().unwrap_or("").trim() == "*";
    let full = it.next()?.trim();
    let oid = if deref.is_empty() { obj } else { deref };
    let (kind, name) = ref_kind_and_name(full)?;
    /* refs/remotes/<remote>/HEAD is a symbolic ref to the remote's default
    branch — it duplicates that branch's label, so it is dropped */
    if name.ends_with("/HEAD") {
        return None;
    }
    Some((
        oid.to_string(),
        GitRef {
            name: name.to_string(),
            kind: kind.to_string(),
            head,
        },
    ))
}

fn sort_refs(refs: &mut [GitRef]) {
    refs.sort_by_key(|r| match (r.head, r.kind.as_str()) {
        (true, _) => 0,
        (false, "branch") => 1,
        (false, "remote") => 2,
        _ => 3,
    });
}

/* every branch / remote branch / tag, keyed by the commit it points at */
fn collect_refs(ws_path: &str) -> HashMap<String, Vec<GitRef>> {
    let mut refs: HashMap<String, Vec<GitRef>> = HashMap::new();
    let ref_fmt = format!(
        "--format=%(objectname){sep}%(*objectname){sep}%(HEAD){sep}%(refname)",
        sep = FIELD_SEP
    );
    let Ok(fr) = run_process(
        ws_path,
        &[
            "for-each-ref",
            ref_fmt.as_str(),
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
        None,
    ) else {
        return refs;
    };
    if fr.code == 0 {
        for line in fr.stdout.lines() {
            if let Some((oid, r)) = parse_ref_line(line) {
                refs.entry(oid).or_default().push(r);
            }
        }
    }
    refs
}

/* `--date-order` is load-bearing, not cosmetic: it guarantees no parent is
listed before all of its children, which is the invariant the renderer's
lane assignment relies on. */
pub fn history(ws_path: &str) -> GitHistoryResult {
    if git_dir_for(ws_path).is_none() {
        return GitHistoryResult::default();
    }
    let pretty = format!(
        "--pretty=format:%H{sep}%P{sep}%an{sep}%at{sep}%s{rec}",
        sep = FIELD_SEP,
        rec = RECORD_SEP
    );
    let limit = format!("-n{}", HISTORY_LIMIT);
    let args = [
        "log",
        "--all",
        "--date-order",
        limit.as_str(),
        pretty.as_str(),
        "--no-color",
    ];
    /* the log and the refs are independent, so they spawn side by side: serially
    they cost ~180ms of pure process startup for a panel open */
    let (log, refs) = std::thread::scope(|s| {
        let l = s.spawn(|| run_process(ws_path, &args, None));
        let r = s.spawn(|| collect_refs(ws_path));
        (
            l.join().ok().and_then(Result::ok),
            /* refs are decoration — a panicked worker costs labels, not the graph */
            r.join().ok().unwrap_or_default(),
        )
    });
    let Some(r) = log else {
        return GitHistoryResult {
            is_repo: true,
            ..Default::default()
        };
    };
    /* a repo with no commits yet exits non-zero with an empty stdout; that is
    an empty graph, not a failure */
    if r.code != 0 && r.stdout.trim().is_empty() {
        return GitHistoryResult {
            is_repo: true,
            commits: Vec::new(),
        };
    }
    if let Err(e) = ensure_ok(&r, "git log") {
        eprintln!("[bentomux] git log: {}", e);
        return GitHistoryResult {
            is_repo: true,
            commits: Vec::new(),
        };
    }

    let mut refs = refs;

    let mut commits = Vec::new();
    for record in r.stdout.split(RECORD_SEP) {
        /* git separates records with a newline, which lands at the head of
        every record after the first */
        let record = record.trim_start_matches('\n');
        if record.is_empty() {
            continue;
        }
        let mut it = record.split(FIELD_SEP);
        let oid = it.next().unwrap_or("").to_string();
        if oid.is_empty() {
            continue;
        }
        let parents: Vec<String> = it
            .next()
            .unwrap_or("")
            .split_whitespace()
            .map(String::from)
            .collect();
        let author = it.next().unwrap_or("").to_string();
        let timestamp: i64 = it.next().unwrap_or("0").trim().parse().unwrap_or(0);
        let subject = it.next().unwrap_or("").to_string();
        let mut commit_refs = refs.remove(&oid).unwrap_or_default();
        sort_refs(&mut commit_refs);
        commits.push(GitCommit {
            short: oid.chars().take(7).collect(),
            oid,
            parents,
            author,
            timestamp,
            subject,
            refs: commit_refs,
        });
    }
    GitHistoryResult {
        is_repo: true,
        commits,
    }
}

/* ---------------- commit detail ---------------- */

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub patch: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    pub is_repo: bool,
    pub oid: String,
    pub short: String,
    pub author: String,
    pub email: String,
    /* unix seconds */
    pub timestamp: i64,
    pub subject: String,
    /* the commit message with its subject line removed */
    pub body: String,
    pub parents: Vec<String>,
    pub refs: Vec<GitRef>,
    pub files: Vec<GitCommitFile>,
    pub additions: u64,
    pub deletions: u64,
}

/* Unlike status/diff/history, this one reports failure instead of returning an
empty default: the user asked for one specific commit, and silently showing
an empty page for a bad oid would read as "this commit is empty". */
pub fn detail(ws_path: &str, oid: &str) -> Result<GitCommitDetail, String> {
    if git_dir_for(ws_path).is_none() {
        return Ok(GitCommitDetail::default());
    }
    let meta_fmt = format!(
        "--format=%H{sep}%P{sep}%an{sep}%ae{sep}%at{sep}%s{sep}%b",
        sep = FIELD_SEP
    );
    let meta_args = ["show", "-s", meta_fmt.as_str(), "--no-color", oid];
    /* `--first-parent` is load-bearing here too: a plain `git show <merge>`
    prints no diff at all, so every merge commit would look empty. With it,
    a merge diffs against its first parent — which is what the graph row the
    user clicked implies. */
    let patch_args = [
        "show",
        "--format=",
        "--patch",
        "--first-parent",
        "--no-color",
        "--no-ext-diff",
        "--unified=3",
        oid,
    ];

    /* all three are independent; serially they are ~285ms of process startup
    for one click, in parallel the page waits for the slowest single spawn */
    let (meta, patch, mut refs) = std::thread::scope(|s| {
        let m = s.spawn(|| run_process(ws_path, &meta_args, None));
        let p = s.spawn(|| run_process(ws_path, &patch_args, None));
        let r = s.spawn(|| collect_refs(ws_path));
        (
            m.join().ok().and_then(Result::ok),
            p.join().ok().and_then(Result::ok),
            r.join().ok().unwrap_or_default(),
        )
    });
    let meta = meta.ok_or("git show could not be run")?;
    ensure_ok(&meta, "git show")?;
    /* a patch that failed to run is not fatal: the message, the parents and the
    decorations are still worth showing, so an empty file list is the honest
    degradation rather than an error page */
    let patch = patch.filter(|d| d.code == 0);

    let mut fields = meta.stdout.split(FIELD_SEP);
    let full = fields.next().unwrap_or("").trim().to_string();
    let parents: Vec<String> = fields
        .next()
        .unwrap_or("")
        .split_whitespace()
        .map(String::from)
        .collect();
    let author = fields.next().unwrap_or("").to_string();
    let email = fields.next().unwrap_or("").to_string();
    let timestamp: i64 = fields.next().unwrap_or("0").trim().parse().unwrap_or(0);
    let subject = fields.next().unwrap_or("").to_string();
    /* %b is the last field, so it keeps whatever newlines the message had */
    let body = fields.next().unwrap_or("").trim_end().to_string();

    let mut files = Vec::new();
    let mut additions = 0u64;
    let mut deletions = 0u64;
    if let Some(d) = patch {
        for block in diff_blocks(&d.stdout) {
            let (path, status) = block_path_status(block);
            let (adds, dels) = count_patch_lines(block);
            additions += adds;
            deletions += dels;
            files.push(GitCommitFile {
                path,
                status,
                additions: adds,
                deletions: dels,
                patch: format!("diff --git {}", block),
            });
        }
    }

    let mut refs = refs.remove(&full).unwrap_or_default();
    sort_refs(&mut refs);
    Ok(GitCommitDetail {
        is_repo: true,
        short: full.chars().take(7).collect(),
        oid: full,
        author,
        email,
        timestamp,
        subject,
        body,
        parents,
        refs,
        files,
        additions,
        deletions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "bentomux-git-{}-{}-{}",
            tag,
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_string_lossy().into_owned();
        run_process(&p, &["init", "-q"], None).expect("git init");
        run_process(&p, &["config", "user.email", "test@bentomux"], None).ok();
        run_process(&p, &["config", "user.name", "test"], None).ok();
        /* hermetic vs the machine's global config: commit.gpgsign=true makes
        every commit spawn the agent's pinentry, which blocks headless runs */
        run_process(&p, &["config", "commit.gpgsign", "false"], None).ok();
        run_process(&p, &["config", "tag.gpgsign", "false"], None).ok();
        p
    }

    fn write_file(dir: &str, name: &str, content: &str) {
        std::fs::write(std::path::Path::new(dir).join(name), content).unwrap();
    }

    #[test]
    fn git_dir_and_branch_detection() {
        let repo = temp_repo("branch");
        assert!(git_dir_for(&repo).is_some());
        let branch = read_branch(&repo).unwrap_or_default();
        assert!(branch == "master" || branch == "main");

        let not_repo = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(git_dir_for(&not_repo).is_none());
        assert_eq!(read_branch(&not_repo), None);
    }

    #[test]
    fn git_status_reports_changes() {
        let repo = temp_repo("status");
        write_file(&repo, "a.txt", "hello\n");
        let st = status(&repo);
        assert!(st.is_repo);
        assert!(st.has_untracked);
        assert_eq!(st.entries.len(), 1);
        assert_eq!(st.entries[0].status, "??");
        assert_eq!(st.entries[0].path, "a.txt");
        assert!(st.branch.is_some());
    }

    #[test]
    fn git_diff_and_stat() {
        let repo = temp_repo("diff");
        write_file(&repo, "a.txt", "one\n");
        run_process(&repo, &["add", "a.txt"], None).unwrap();
        run_process(&repo, &["commit", "-qm", "init"], None).unwrap();
        write_file(&repo, "a.txt", "one\ntwo\n");

        let files = diff(&repo, None);
        assert!(files.is_repo);
        assert_eq!(files.files.len(), 1);
        assert_eq!(files.files[0].status, "M");
        assert!(files.files[0].patch.contains("diff --git"));

        let ds = diff_stat(&repo);
        assert!(ds.is_repo);
        assert!(ds.additions >= 1);
    }

    #[test]
    fn git_remote_info_empty_repo() {
        let repo = temp_repo("remote");
        let info = remote_info(&repo);
        assert!(info.is_repo);
        assert_eq!(info.remote, None);
    }

    #[test]
    fn git_history_orders_children_before_parents() {
        let repo = temp_repo("history");
        write_file(&repo, "a.txt", "one\n");
        run_process(&repo, &["add", "a.txt"], None).unwrap();
        run_process(&repo, &["commit", "-qm", "first"], None).unwrap();
        run_process(&repo, &["checkout", "-qb", "side"], None).unwrap();
        write_file(&repo, "b.txt", "two\n");
        run_process(&repo, &["add", "b.txt"], None).unwrap();
        run_process(&repo, &["commit", "-qm", "side work"], None).unwrap();
        run_process(&repo, &["checkout", "-q", "-"], None).unwrap();
        /* annotated tag: its ref points at the tag object, not the commit, so
        this is what exercises the %(*objectname) dereference */
        run_process(&repo, &["tag", "-a", "v1.0", "-m", "release"], None).unwrap();

        let h = history(&repo);
        assert!(h.is_repo);
        assert_eq!(h.commits.len(), 2);
        assert_eq!(h.commits[0].subject, "side work");
        assert_eq!(h.commits[1].subject, "first");
        /* the invariant the lane layout depends on: every parent appears
        after its child */
        let pos: std::collections::HashMap<&str, usize> = h
            .commits
            .iter()
            .enumerate()
            .map(|(i, c)| (c.oid.as_str(), i))
            .collect();
        for (i, c) in h.commits.iter().enumerate() {
            for p in &c.parents {
                if let Some(&pi) = pos.get(p.as_str()) {
                    assert!(pi > i, "parent {} listed before child {}", p, c.oid);
                }
            }
        }
        /* the checked-out branch is labelled, and marked as HEAD */
        let head_refs: Vec<&GitRef> = h
            .commits
            .iter()
            .flat_map(|c| &c.refs)
            .filter(|r| r.head)
            .collect();
        assert_eq!(head_refs.len(), 1, "exactly one HEAD ref: {:?}", head_refs);
        assert_eq!(head_refs[0].kind, "branch");
        assert!(
            !head_refs[0].name.contains('/'),
            "a local branch, not origin/…"
        );

        /* the annotated tag resolved to the commit it points at, and is not
        mistaken for a branch */
        let tagged: Vec<&GitRef> = h
            .commits
            .iter()
            .flat_map(|c| &c.refs)
            .filter(|r| r.kind == "tag")
            .collect();
        assert_eq!(tagged.len(), 1, "one tag ref: {:?}", tagged);
        assert_eq!(tagged[0].name, "v1.0");
        assert!(!tagged[0].head);
        assert!(
            h.commits[0].refs.iter().any(|r| r.name == "side"),
            "the branch we checked out and left is labelled: {:?}",
            h.commits[0].refs
        );
        /* the tag points at the base commit, which is also where HEAD went back
        to — so that row carries both, and HEAD sorts first so the label row
        reads like `git log --decorate` */
        let decorated = h
            .commits
            .iter()
            .find(|c| c.refs.iter().any(|r| r.head))
            .expect("a HEAD row");
        assert_eq!(
            decorated.refs.len(),
            2,
            "HEAD branch + tag: {:?}",
            decorated.refs
        );
        assert!(
            decorated.refs[0].head,
            "HEAD ref leads the list: {:?}",
            decorated.refs
        );
        assert_eq!(decorated.refs[1].kind, "tag");
        assert_eq!(h.commits[0].short.len(), 7);
        assert!(h.commits[0].timestamp > 0);
    }

    #[test]
    fn count_patch_lines_counts_hunk_content_only() {
        /* a line whose content starts with `--` or `++` is content, not a file
        header, and must still count */
        let block = "a/x.txt b/x.txt\n\
index 111..222 100644\n\
--- a/x.txt\n\
+++ b/x.txt\n\
@@ -1,3 +1,3 @@\n\
 ctx\n\
---removed dashes\n\
+++added pluses\n\
\\ No newline at end of file\n";
        assert_eq!(count_patch_lines(block), (1, 1));

        /* binary: no hunk, so no counts */
        let binary = "a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n";
        assert_eq!(count_patch_lines(binary), (0, 0));
    }

    #[test]
    fn git_detail_reports_message_files_and_counts() {
        let repo = temp_repo("detail");
        write_file(&repo, "a.txt", "one\n");
        run_process(&repo, &["add", "a.txt"], None).unwrap();
        run_process(&repo, &["commit", "-qm", "first\n\nWhy it matters."], None).unwrap();
        write_file(&repo, "a.txt", "one\ntwo\n");
        run_process(&repo, &["add", "a.txt"], None).unwrap();
        run_process(&repo, &["commit", "-qm", "second"], None).unwrap();

        let head = history(&repo).commits[0].oid.clone();
        let d = detail(&repo, &head).expect("detail for a real commit");
        assert!(d.is_repo);
        assert_eq!(d.oid, head);
        assert_eq!(d.short.len(), 7);
        assert_eq!(d.subject, "second");
        assert_eq!(d.author, "test");
        assert!(d.timestamp > 0);
        assert_eq!(d.parents.len(), 1);
        assert_eq!(d.files.len(), 1);
        assert_eq!(d.files[0].path, "a.txt");
        assert_eq!(d.files[0].status, "M");
        assert_eq!(d.files[0].additions, 1);
        assert_eq!(d.files[0].deletions, 0);
        assert_eq!((d.additions, d.deletions), (1, 0));
        assert!(d.files[0].patch.contains("@@"));
        /* HEAD points at the newest commit, so that is the decorated one */
        assert!(
            d.refs.iter().any(|r| r.head),
            "the HEAD branch is decorated: {:?}",
            d.refs
        );

        /* a multi-line message keeps its body, minus the subject */
        let root = d.parents[0].clone();
        let first = detail(&repo, &root).expect("detail for the root commit");
        assert_eq!(first.subject, "first");
        assert_eq!(first.body, "Why it matters.");
        assert!(first.parents.is_empty(), "root commit has no parents");
        assert_eq!(first.files[0].status, "A");
        assert!(
            first.refs.is_empty(),
            "the root commit carries no refs: {:?}",
            first.refs
        );
    }

    /* `git show <merge>` prints no diff at all, so without --first-parent every
    merge commit would render as an empty page. This is the guard for that. */
    #[test]
    fn git_detail_of_a_merge_diffs_against_its_first_parent() {
        let repo = temp_repo("detail-merge");
        write_file(&repo, "a.txt", "one\n");
        run_process(&repo, &["add", "a.txt"], None).unwrap();
        run_process(&repo, &["commit", "-qm", "base"], None).unwrap();
        run_process(&repo, &["checkout", "-qb", "side"], None).unwrap();
        write_file(&repo, "b.txt", "two\n");
        run_process(&repo, &["add", "b.txt"], None).unwrap();
        run_process(&repo, &["commit", "-qm", "side work"], None).unwrap();
        run_process(&repo, &["checkout", "-q", "-"], None).unwrap();
        run_process(
            &repo,
            &["merge", "-q", "--no-ff", "side", "-m", "merge side"],
            None,
        )
        .unwrap();

        let head = history(&repo).commits[0].oid.clone();
        let d = detail(&repo, &head).expect("detail for the merge");
        assert_eq!(d.parents.len(), 2, "a merge has two parents");
        assert_eq!(d.files.len(), 1, "the merge is not empty: {:?}", d.files);
        assert_eq!(d.files[0].path, "b.txt");
        assert_eq!(d.files[0].status, "A");
        assert_eq!(d.files[0].additions, 1);
    }

    #[test]
    fn git_detail_of_an_unknown_oid_is_an_error() {
        let repo = temp_repo("detail-bad");
        write_file(&repo, "a.txt", "one\n");
        run_process(&repo, &["add", "a.txt"], None).unwrap();
        run_process(&repo, &["commit", "-qm", "first"], None).unwrap();
        assert!(detail(&repo, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef").is_err());
        /* outside a repo there is nothing to look up, but that is not an error */
        let outside = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(
            !detail(&outside, "HEAD")
                .expect("not-a-repo is a value")
                .is_repo
        );
    }

    #[test]
    fn git_detail_line_counts_match_git_numstat() {
        /* the counts are derived from the patch rather than a second --numstat
        call, so this cross-checks them against git's own arithmetic on a
        commit that adds, deletes, and renames in one go */
        let repo = temp_repo("detail-counts");
        write_file(&repo, "keep.txt", "a\nb\nc\n");
        write_file(&repo, "gone.txt", "x\n");
        write_file(&repo, "old.txt", "one\ntwo\nthree\n");
        run_process(&repo, &["add", "."], None).unwrap();
        run_process(&repo, &["commit", "-qm", "base"], None).unwrap();

        write_file(&repo, "keep.txt", "a\nB\nc\nd\n");
        run_process(&repo, &["rm", "-q", "gone.txt"], None).unwrap();
        run_process(&repo, &["mv", "old.txt", "new.txt"], None).unwrap();
        write_file(&repo, "added.txt", "p\nq\n");
        run_process(&repo, &["add", "."], None).unwrap();
        run_process(&repo, &["commit", "-qm", "mixed"], None).unwrap();

        let head = history(&repo).commits[0].oid.clone();
        let d = detail(&repo, &head).expect("detail for the mixed commit");
        assert_eq!(
            d.files.len(),
            4,
            "add, delete, rename, modify: {:?}",
            d.files
        );

        /* git's own numbers for the same commit */
        let ns = run_process(
            &repo,
            &["show", "--numstat", "--format=", "--first-parent", &head],
            None,
        )
        .unwrap();
        let mut expected = 0u64;
        for line in ns.stdout.lines().filter(|l| !l.trim().is_empty()) {
            let mut it = line.splitn(3, '\t');
            let a = it.next().unwrap_or("");
            let del = it.next().unwrap_or("");
            if a == "-" || del == "-" {
                continue; /* binary */
            }
            expected += a.parse::<u64>().unwrap_or(0);
        }
        assert_eq!(
            d.additions, expected,
            "additions disagree with git --numstat"
        );

        let modified = d
            .files
            .iter()
            .find(|f| f.path == "keep.txt")
            .expect("keep.txt");
        assert_eq!(
            (modified.additions, modified.deletions),
            (2, 1),
            "replaced b with B and appended d"
        );
        let renamed = d
            .files
            .iter()
            .find(|f| f.path == "new.txt")
            .expect("rename target");
        assert_eq!(renamed.status, "R");
        let removed = d
            .files
            .iter()
            .find(|f| f.path == "gone.txt")
            .expect("gone.txt");
        assert_eq!((removed.status.as_str(), removed.deletions), ("D", 1));
    }

    #[test]
    fn git_history_empty_repo_is_not_an_error() {
        let repo = temp_repo("history-empty");
        let h = history(&repo);
        assert!(h.is_repo);
        assert!(h.commits.is_empty());

        let outside = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(!history(&outside).is_repo);
    }

    #[test]
    fn parse_ref_line_classifies_and_dereferences() {
        /* annotated tag: objectname is the tag object, *objectname the commit */
        let (oid, r) = parse_ref_line("tagobj\u{1f}commitsha\u{1f}\u{1f}refs/tags/v1.0").unwrap();
        assert_eq!(oid, "commitsha");
        assert_eq!(r.name, "v1.0");
        assert_eq!(r.kind, "tag");
        assert!(!r.head);

        let (oid, r) = parse_ref_line("abc\u{1f}\u{1f}*\u{1f}refs/heads/main").unwrap();
        assert_eq!(oid, "abc");
        assert!(r.head && r.kind == "branch");

        let (_, r) = parse_ref_line("abc\u{1f}\u{1f}\u{1f}refs/remotes/origin/main").unwrap();
        assert_eq!(r.name, "origin/main");
        assert_eq!(r.kind, "remote");

        /* the remote's symbolic default-branch ref duplicates origin/main */
        assert!(parse_ref_line("abc\u{1f}\u{1f}\u{1f}refs/remotes/origin/HEAD").is_none());
        assert!(parse_ref_line("abc\u{1f}\u{1f}\u{1f}refs/stash").is_none());
    }

    /* porcelain -z splits renames across NUL segments. Faithful to the Electron
    port: the original code consumed the next NUL segment as the path,
    which for git's `R <target>\0<source>` shape yields the source name. */
    #[test]
    fn git_status_reports_rename() {
        let repo = temp_repo("rename");
        write_file(&repo, "old.txt", "hi\n");
        run_process(&repo, &["add", "old.txt"], None).unwrap();
        run_process(&repo, &["commit", "-qm", "init"], None).unwrap();
        run_process(&repo, &["mv", "old.txt", "moved.txt"], None).unwrap();
        let st = status(&repo);
        assert!(st.is_repo);
        assert!(
            st.entries.iter().any(|e| e.index_status == "R"),
            "rename detected with index R: {:?}",
            st.entries
        );
    }

    #[test]
    fn parse_status_branch_line() {
        let parts = vec![
            "## main...origin/main [ahead 3, behind 1]".to_string(),
            " M file.ts".to_string(),
        ];
        let (branch, ahead, behind, entries, _) = parse_status(&parts);
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!(ahead, 3);
        assert_eq!(behind, 1);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].index_status, " ");
        assert_eq!(entries[0].work_tree_status, "M");
    }

    #[test]
    fn parse_status_untracked_and_rename() {
        let parts = vec![
            "## main".to_string(),
            " x1".to_string(),
            "?? new.txt".to_string(),
            "R  old.txt".to_string(),
            "renamed.txt".to_string(),
        ];
        let (_, _, _, entries, has_untracked) = parse_status(&parts);
        assert!(has_untracked);
        assert!(entries.iter().any(|e| e.path == "new.txt"));
        assert!(entries.iter().any(|e| e.path == "renamed.txt"));
    }

    /* the fs.watch on .git/HEAD fires an instant branch event, not just the 4s poll */
    #[test]
    fn branch_watcher_fires_on_checkout() {
        let repo = temp_repo("watch");
        let main = read_branch(&repo).unwrap();
        assert!(main == "master" || main == "main");

        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Option<String>>::new()));
        let seen2 = seen.clone();
        on_branch_change(move |_, branch| {
            seen2.lock().unwrap().push(branch.map(String::from));
        });
        watch_workspace("watch-ws", &repo);

        /* new branch updates .git/HEAD → the fs watcher should notice quickly */
        run_process(&repo, &["checkout", "-qb", "feature-x"], None).unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
        loop {
            if seen
                .lock()
                .unwrap()
                .iter()
                .any(|b| b.as_deref() == Some("feature-x"))
            {
                unwatch_workspace("watch-ws");
                return;
            }
            if std::time::Instant::now() >= deadline {
                unwatch_workspace("watch-ws");
                panic!("branch watcher never reported the feature-x branch");
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}
