/* ---------------- default shell detection ----------------
Rust port of src/main/shell-detect.ts + path-lookup.ts.
Windows: pwsh → powershell → cmd, found by scanning PATH × PATHEXT
(never spawns where.exe). Unix: bash → zsh → fish → /bin/sh. */

use crate::lock::LockExt;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellChoice {
    pub file: String,
    pub args: Vec<String>,
}

/* one of Prefs['shell']; kept as a plain string so main stays decoupled from the shared type */
pub type ShellPref = str; /* "system" | "powershell" | "cmd" | "gitbash" | "wsl" */

/* ---------------- PATH lookup without spawning where.exe ----------------
where.exe reports misses through the Windows console API, which leaks
into the terminal even when stdio is piped, and every spawn synchronously
blocks the main process. Scanning PATH × PATHEXT on the filesystem answers
the same question for the CLI tools Bentomux detects. Results are cached
briefly so repeated detections cost nothing while still noticing newly
installed tools. */

const CACHE_TTL: Duration = Duration::from_secs(60);

struct PathCache {
    at: Instant,
    files: HashMap<String, PathBuf>,
}

fn path_cache() -> &'static Mutex<Option<PathCache>> {
    static CACHE: OnceLock<Mutex<Option<PathCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[cfg(windows)]
fn path_dirs() -> Vec<String> {
    (std::env::var("PATH").unwrap_or_default())
        .split(';')
        .map(|d| d.trim().trim_matches('"').to_string())
        .filter(|d| !d.is_empty())
        /* UNC shares can stall the scan */
        .filter(|d| !d.starts_with(r"\\"))
        .collect()
}

#[cfg(windows)]
fn path_exts() -> Vec<String> {
    (std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string()))
        .split(';')
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .collect()
}

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[cfg(unix)]
fn path_dirs() -> Vec<String> {
    let mut dirs: Vec<String> = (std::env::var("PATH").unwrap_or_default())
        .split(':')
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .collect();
    /* a GUI-launched app inherits launchd's minimal PATH, so the homebrew /
    /usr/local installs the "not found on PATH" message points at are
    otherwise invisible */
    for extra in ["/usr/local/bin", "/opt/homebrew/bin"] {
        if !dirs.iter().any(|d| d == extra) {
            dirs.push(extra.to_string());
        }
    }
    dirs
}

/* lowercase filename → full path of its FIRST matching dir (PATH order) */
#[cfg(windows)]
fn path_files() -> HashMap<String, PathBuf> {
    if let Some(cache) = path_cache().lock_recover().as_ref() {
        if cache.at.elapsed() < CACHE_TTL {
            return cache.files.clone();
        }
    }
    let mut files = HashMap::new();
    for dir in path_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if let Ok(name) = entry.file_name().into_string() {
                let key = name.to_lowercase();
                files
                    .entry(key)
                    .or_insert_with(|| PathBuf::from(&dir).join(&name));
            }
        }
    }
    *path_cache().lock_recover() = Some(PathCache {
        at: Instant::now(),
        files: files.clone(),
    });
    files
}

#[cfg(unix)]
fn path_files() -> HashMap<String, PathBuf> {
    if let Some(cache) = path_cache().lock_recover().as_ref() {
        if cache.at.elapsed() < CACHE_TTL {
            return cache.files.clone();
        }
    }
    let mut files = HashMap::new();
    for dir in path_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            /* only executables count as shell/tool candidates on unix */
            let is_exec = entry
                .metadata()
                .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false);
            if is_exec {
                files
                    .entry(name.to_lowercase())
                    .or_insert_with(|| PathBuf::from(&dir).join(&name));
            }
        }
    }
    *path_cache().lock_recover() = Some(PathCache {
        at: Instant::now(),
        files: files.clone(),
    });
    files
}

/* first full path of `name` on PATH (`name` may carry its own extension); None when absent */
pub fn find_on_path(name: &str) -> Option<String> {
    let files = path_files();
    #[cfg(windows)]
    {
        let has_ext = name
            .rfind('.')
            .map(|i| name[i + 1..].chars().all(|c| c.is_ascii_alphanumeric()))
            .unwrap_or(false);
        if has_ext {
            return files
                .get(&name.to_lowercase())
                .map(|p| p.to_string_lossy().into_owned());
        }
        for ext in path_exts() {
            let key = format!("{}{}", name, ext).to_lowercase();
            if let Some(hit) = files.get(&key) {
                return Some(hit.to_string_lossy().into_owned());
            }
        }
        None
    }
    #[cfg(unix)]
    {
        files
            .get(&name.to_lowercase())
            .map(|p| p.to_string_lossy().into_owned())
    }
}

/* ---------------- shell choice ---------------- */

fn detect_shell_cached() -> &'static Mutex<Option<ShellChoice>> {
    static CACHED: OnceLock<Mutex<Option<ShellChoice>>> = OnceLock::new();
    CACHED.get_or_init(|| Mutex::new(None))
}

pub fn detect_shell() -> ShellChoice {
    if let Some(cached) = detect_shell_cached().lock_recover().as_ref() {
        return cached.clone();
    }
    let choice = detect_shell_uncached();
    *detect_shell_cached().lock_recover() = Some(choice.clone());
    choice
}

#[cfg(windows)]
fn detect_shell_uncached() -> ShellChoice {
    for (name, args) in [
        ("pwsh.exe", vec!["-NoLogo".to_string()]),
        ("powershell.exe", vec!["-NoLogo".to_string()]),
        ("cmd.exe", vec![]),
    ] {
        if let Some(found) = find_on_path(name) {
            return ShellChoice { file: found, args };
        }
    }
    ShellChoice {
        file: std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()),
        args: vec![],
    }
}

#[cfg(unix)]
fn detect_shell_uncached() -> ShellChoice {
    /* honour the user's chosen shell from System Preferences / chsh */
    if let Ok(shell_env) = std::env::var("SHELL") {
        let path = std::path::PathBuf::from(&shell_env);
        if path.exists() {
            return ShellChoice {
                file: shell_env,
                args: vec!["-l".to_string()],
            };
        }
    }
    for name in ["zsh", "bash", "fish"] {
        if let Some(found) = find_on_path(name) {
            return ShellChoice {
                file: found,
                args: vec!["-l".to_string()],
            };
        }
    }
    ShellChoice {
        file: "/bin/sh".to_string(),
        args: vec![],
    }
}

/* common Git-for-Windows install roots, most likely first */
#[cfg(windows)]
fn git_bash_candidates() -> Vec<String> {
    let roots: Vec<String> = [
        std::env::var("ProgramFiles").ok(),
        std::env::var("ProgramFiles(x86)").ok(),
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|l| format!("{}\\Programs", l)),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut out = Vec::new();
    for root in roots {
        out.push(format!("{}\\Git\\bin\\bash.exe", root));
        out.push(format!("{}\\Git\\usr\\bin\\bash.exe", root));
    }
    out
}

/* the shell a new pane should spawn with, honoring the user's settings pick.
`pref` is one of: "system" | "powershell" | "cmd" | "gitbash" | "wsl". */
pub fn resolve_shell(pref: Option<&str>) -> ShellChoice {
    match pref {
        None | Some("system") => detect_shell(),
        #[cfg(windows)]
        Some("powershell") => match find_on_path("powershell.exe") {
            Some(found) => ShellChoice {
                file: found,
                args: vec!["-NoLogo".to_string()],
            },
            None => detect_shell(),
        },
        #[cfg(unix)]
        Some("powershell") => match find_on_path("pwsh") {
            Some(found) => ShellChoice {
                file: found,
                args: vec!["-NoLogo".to_string()],
            },
            None => detect_shell(),
        },
        #[cfg(windows)]
        Some("cmd") => ShellChoice {
            file: find_on_path("cmd.exe")
                .or_else(|| std::env::var("ComSpec").ok())
                .unwrap_or_else(|| "cmd.exe".to_string()),
            args: vec![],
        },
        #[cfg(windows)]
        Some("gitbash") => match git_bash_candidates()
            .into_iter()
            .find(|p| PathBuf::from(p).exists())
        {
            Some(bash) => ShellChoice {
                file: bash,
                args: vec!["-i".to_string(), "-l".to_string()],
            },
            None => detect_shell(),
        },
        #[cfg(windows)]
        Some("wsl") => ShellChoice {
            file: find_on_path("wsl.exe").unwrap_or_else(|| "wsl.exe".to_string()),
            args: vec![],
        },
        #[cfg(unix)]
        Some("zsh") => match find_on_path("zsh") {
            Some(found) => ShellChoice {
                file: found,
                args: vec!["-l".to_string()],
            },
            None => detect_shell(),
        },
        #[cfg(unix)]
        Some("bash") => match find_on_path("bash") {
            Some(found) => ShellChoice {
                file: found,
                args: vec!["-l".to_string()],
            },
            None => detect_shell(),
        },
        #[cfg(unix)]
        Some("fish") => match find_on_path("fish") {
            Some(found) => ShellChoice {
                file: found,
                args: vec![],
            },
            None => detect_shell(),
        },
        #[cfg(unix)]
        Some("pi") => match find_on_path("pi") {
            Some(found) => ShellChoice {
                file: found,
                args: vec![],
            },
            None => detect_shell(),
        },
        /* platform-specific picks that don't exist on this OS (or unknown
        prefs entirely): fall back to the detected default rather than
        spawning a nonexistent binary */
        Some(_) => detect_shell(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_on_path_finds_common_tool() {
        /* sh/bash/zsh exist on every dev machine this suite runs on */
        let hit = find_on_path("sh")
            .or_else(|| find_on_path("bash"))
            .or_else(|| find_on_path("zsh"));
        assert!(hit.is_some(), "expected a shell on PATH");
        let hit = hit.unwrap();
        assert!(PathBuf::from(&hit).exists());
    }

    #[test]
    fn test_find_on_path_miss_is_none() {
        assert_eq!(find_on_path("definitely-not-a-real-tool-xyz"), None);
    }

    /* packaged apps launched from Finder/Dock inherit launchd's minimal PATH;
    the standard unix install dirs must still be scanned */
    #[cfg(unix)]
    #[test]
    fn test_path_dirs_includes_standard_install_dirs() {
        let dirs = path_dirs();
        assert!(dirs.iter().any(|d| d == "/usr/local/bin"), "{dirs:?}");
        assert!(dirs.iter().any(|d| d == "/opt/homebrew/bin"), "{dirs:?}");
    }

    #[test]
    fn test_detect_shell_returns_existing_file() {
        let shell = detect_shell();
        assert!(PathBuf::from(&shell.file).exists(), "{}", shell.file);
    }

    #[test]
    fn test_detect_shell_is_cached() {
        let a = detect_shell();
        let b = detect_shell();
        assert_eq!(a, b);
    }

    #[test]
    fn test_resolve_shell_honors_prefs() {
        for pref in [
            None,
            Some("system"),
            Some("powershell"),
            Some("cmd"),
            Some("gitbash"),
            Some("wsl"),
        ] {
            let shell = resolve_shell(pref);
            assert!(
                PathBuf::from(&shell.file).exists(),
                "pref {:?} → {}",
                pref,
                shell.file
            );
        }
    }
}
