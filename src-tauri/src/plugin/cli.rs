/* ---------------- plugin platform: CLI surfaces ----------------
   Spec: docs/PLUGIN_PLATFORM.md §11, §8.

   Two flags, both on the app binary, following the `--pty-host` self-exec
   pattern in main.rs: the same executable, a different entry point. They
   exist so an authoring agent can validate and inspect plugins from a
   terminal without opening the app — that is what makes the
   generate → validate → fix loop able to run on its own.

     bentomux --plugin-validate <dir> [--json]   exit 0 ok / 1 errors / 2 usage
     bentomux --safe-mode                        start with plugins disabled
*/

use std::io::Write;
use std::path::Path;

use super::validate::{self, ValidateOptions};

pub const VALIDATE_FLAG: &str = "--plugin-validate";
pub const JSON_FLAG: &str = "--json";
/// Allows the reserved `bentomux.` publisher. Only the packaging step and the
/// bundled-plugin check should pass this; a third-party plugin using the
/// reserved publisher is exactly what it guards against.
pub const BUNDLED_FLAG: &str = "--bundled";

const EXIT_OK: i32 = 0;
const EXIT_INVALID: i32 = 1;
const EXIT_USAGE: i32 = 2;

fn usage(mut out: impl Write) -> i32 {
    let _ = writeln!(
        out,
        "usage: bentomux {VALIDATE_FLAG} <plugin-dir> [{JSON_FLAG}] [{BUNDLED_FLAG}]\n\
         \n\
         Validates a plugin folder without executing it.\n\
         \n\
         options:\n\
         \x20 {JSON_FLAG}      machine-readable report on stdout\n\
         \x20 {BUNDLED_FLAG}   allow the reserved `bentomux.` publisher\n\
         \n\
         exits: 0 valid, 1 validation errors, 2 usage error"
    );
    EXIT_USAGE
}

/// Entry point for `--plugin-validate`. Writes the report to stdout and
/// returns the process exit code.
pub fn run_validate(args: &[String]) -> i32 {
    let mut dir: Option<&str> = None;
    let mut json = false;
    let mut bundled = false;

    for arg in args {
        match arg.as_str() {
            JSON_FLAG => json = true,
            BUNDLED_FLAG => bundled = true,
            VALIDATE_FLAG => {}
            other if other.starts_with('-') => {
                eprintln!("unknown option: {}", other);
                return usage(std::io::stderr());
            }
            other => {
                if dir.is_some() {
                    eprintln!("only one plugin directory may be given");
                    return usage(std::io::stderr());
                }
                dir = Some(other);
            }
        }
    }

    let Some(dir) = dir else {
        return usage(std::io::stderr());
    };
    let path = Path::new(dir);
    /* a folder, or a packaged .zip — the same two shapes the Studio review
       screen accepts, so an agent validating a release asset is checking the
       exact thing a user would install */
    if !path.is_dir() && !path.is_file() {
        eprintln!("not a plugin folder or package: {}", dir);
        return EXIT_USAGE;
    }

    let report = validate::validate_path_with(path, &ValidateOptions { bundled });

    if json {
        match serde_json::to_string_pretty(&report) {
            Ok(body) => println!("{}", body),
            Err(e) => {
                eprintln!("could not serialize the report: {}", e);
                return EXIT_USAGE;
            }
        }
    } else {
        print_human(&report);
    }

    if report.ok {
        EXIT_OK
    } else {
        EXIT_INVALID
    }
}

fn print_human(report: &validate::ValidationReport) {
    match &report.manifest {
        /* a salvaged manifest may have parsed an id but no name; showing a
        blank where the title goes reads as a bug rather than a missing
        field, and the missing field is already listed below */
        Some(m) if !m.name.trim().is_empty() => {
            println!("{} {}  ({})", m.name, m.version, m.id)
        }
        Some(m) if !m.id.trim().is_empty() => println!("{}", m.id),
        Some(_) => println!("(no readable manifest)"),
        None => println!("(no readable manifest)"),
    }
    for issue in &report.errors {
        match &issue.path {
            Some(p) => println!("  error   [{}] {}  ({})", issue.code, issue.message, p),
            None => println!("  error   [{}] {}", issue.code, issue.message),
        }
    }
    for issue in &report.warnings {
        match &issue.path {
            Some(p) => println!("  warning [{}] {}  ({})", issue.code, issue.message, p),
            None => println!("  warning [{}] {}", issue.code, issue.message),
        }
    }
    if report.ok {
        println!("valid");
    } else {
        println!("{} error(s)", report.errors.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn plugin_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bentomux-cli-{}-{}", tag, std::process::id()));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn valid_plugin_exits_zero() {
        let dir = plugin_dir("ok");
        fs::write(
            dir.join("plugin.json"),
            r#"{"id":"acme.t","name":"T","version":"1.0.0","apiVersion":1,"entry":"index.js"}"#,
        )
        .unwrap();
        fs::write(dir.join("index.js"), "export function activate() {}").unwrap();

        let code = run_validate(&args(&[VALIDATE_FLAG, dir.to_str().unwrap(), JSON_FLAG]));
        assert_eq!(code, EXIT_OK);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn invalid_plugin_exits_one() {
        let dir = plugin_dir("bad");
        fs::write(dir.join("plugin.json"), "{ not json").unwrap();
        let code = run_validate(&args(&[VALIDATE_FLAG, dir.to_str().unwrap(), JSON_FLAG]));
        assert_eq!(code, EXIT_INVALID);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_directory_is_a_usage_error() {
        let code = run_validate(&args(&[VALIDATE_FLAG, "/definitely/not/here", JSON_FLAG]));
        assert_eq!(code, EXIT_USAGE);
    }

    #[test]
    fn no_directory_is_a_usage_error() {
        assert_eq!(run_validate(&args(&[VALIDATE_FLAG])), EXIT_USAGE);
        assert_eq!(run_validate(&args(&[])), EXIT_USAGE);
    }

    #[test]
    fn bundled_flag_is_accepted_and_allows_the_reserved_publisher() {
        let dir = plugin_dir("bundled");
        fs::write(
            dir.join("plugin.json"),
            r#"{"id":"bentomux.t","name":"T","version":"1.0.0","apiVersion":1,"entry":"index.js"}"#,
        )
        .unwrap();
        fs::write(dir.join("index.js"), "export function activate() {}").unwrap();

        /* without the flag the reserved publisher is refused */
        assert_eq!(
            run_validate(&args(&[VALIDATE_FLAG, dir.to_str().unwrap()])),
            EXIT_INVALID
        );
        /* with it, the bundled plugin validates */
        assert_eq!(
            run_validate(&args(&[VALIDATE_FLAG, dir.to_str().unwrap(), BUNDLED_FLAG])),
            EXIT_OK
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_flag_is_a_usage_error() {
        let dir = plugin_dir("unknown");
        let code = run_validate(&args(&[VALIDATE_FLAG, dir.to_str().unwrap(), "--wat"]));
        assert_eq!(code, EXIT_USAGE);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn json_report_is_machine_readable_for_an_agent() {
        let dir = plugin_dir("agentjson");
        fs::write(
            dir.join("plugin.json"),
            r#"{"id":"acme.t","name":"T","version":"1.0.0","apiVersion":1,"entry":"missing.js"}"#,
        )
        .unwrap();

        let report = validate::validate_dir(&dir);
        let value = serde_json::to_value(&report).unwrap();
        assert_eq!(value["ok"], false);
        assert!(value["errors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["code"] == "entry-missing"));

        fs::remove_dir_all(&dir).ok();
    }
}
