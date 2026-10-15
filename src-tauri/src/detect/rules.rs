/* ---------------- screen-manifest rule engine ----------------
Rust port of src/main/detect/rules.ts — compact port of herdr's
agent-detection idea: ordered rules with priorities are evaluated
against regions of the live terminal screen (bottom lines, prompt box,
OSC title/progress) and the first match decides the semantic state
(idle / working / blocked). */

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunState {
    Idle,
    Working,
    Blocked,
    Unknown,
}

/* slices of the current screen a rule can be matched against.
Consumed only by the rule engine (never serialized over IPC), so it is
authored directly in the manifest just like the TS object literal. */
#[derive(Clone, Debug, PartialEq)]
pub enum RegionName {
    OscTitle,
    OscProgress,
    /* last N non-empty lines, oldest first */
    Bottom(u32),
    Top(u32),
    /* everything below the last horizontal rule (Claude Code's prompt box) */
    PromptBoxBody,
    /* the non-empty line just above that rule */
    LastLineAbovePromptBox,
    /* last ~40 non-empty lines joined — whole-recent fallback */
    WholeRecent,
    WholeRecentWithoutCurrentPromptMarker,
    AfterLastPromptMarker,
    AfterLastHorizontalRule,
}

fn region_text(region: &RegionName, screen: &ScreenInput) -> (String, Vec<String>) {
    let empty = (String::new(), Vec::new());
    let recent = |n: usize| {
        let start = screen.lines.len().saturating_sub(n);
        let lines: Vec<String> = screen.lines[start..].to_vec();
        (lines.join("\n"), lines)
    };
    match region {
        RegionName::OscTitle => (screen.osc_title.clone(), vec![screen.osc_title.clone()]),
        RegionName::OscProgress => (
            screen.osc_progress.clone(),
            vec![screen.osc_progress.clone()],
        ),
        RegionName::WholeRecent => recent(40),
        RegionName::WholeRecentWithoutCurrentPromptMarker => {
            let mut lines = screen.lines.clone();
            if let Some(i) = lines
                .iter()
                .rposition(|l| l.trim_start().starts_with('❯') || l.trim_start().starts_with('>'))
            {
                lines.truncate(i);
            }
            (lines.join("\n"), lines)
        }
        RegionName::AfterLastPromptMarker => {
            let start = screen
                .lines
                .iter()
                .rposition(|l| {
                    let t = l.trim_start();
                    t.starts_with('❯') || t.starts_with('>')
                })
                .unwrap_or(0);
            let lines = screen.lines[start..].to_vec();
            (lines.join("\n"), lines)
        }
        RegionName::AfterLastHorizontalRule | RegionName::PromptBoxBody => {
            let idx = screen.lines.iter().rposition(|l| rule_line(l));
            match idx {
                Some(i) if i + 1 < screen.lines.len() => {
                    let lines: Vec<String> = screen.lines[i + 1..].to_vec();
                    (lines.join("\n"), lines)
                }
                _ => empty,
            }
        }
        RegionName::LastLineAbovePromptBox => {
            let idx = screen.lines.iter().rposition(|l| rule_line(l));
            match idx {
                Some(i) if i > 0 => (
                    screen.lines[i - 1].clone(),
                    vec![screen.lines[i - 1].clone()],
                ),
                _ => empty,
            }
        }
        RegionName::Bottom(n) => recent(*n as usize),
        RegionName::Top(n) => {
            let lines: Vec<String> = screen.lines.iter().take(*n as usize).cloned().collect();
            (lines.join("\n"), lines)
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Matcher {
    pub contains: Option<Vec<String>>,
    pub regex: Option<Vec<String>>,
    /* TOML manifests author this as `line_regex` (snake_case); the struct
    renames to camelCase for JSON compat, so accept both spellings or
    every TOML line_regex rule is silently dropped on deserialize */
    #[serde(alias = "line_regex")]
    pub line_regex: Option<Vec<String>>,
    pub any: Option<Vec<Matcher>>,
    pub all: Option<Vec<Matcher>>,
    pub not: Option<Vec<Matcher>>,
}

/* helper to build matchers concisely in manifests (single string or list) */
#[allow(non_snake_case)]
pub fn S(s: &str) -> Vec<String> {
    vec![s.to_string()]
}

#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    pub id: String,
    pub state: RunState,
    pub priority: i32,
    pub region: RegionName,
    /* matched but state stays: transient overlays (transcript view, pickers) */
    pub skip_state_update: bool,
    pub match_: Matcher,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgentManifest {
    pub agent: String,
    pub rules: Vec<Rule>,
}

/* what the caller hands in; `lines` is non-empty screen text, oldest first,
bottom of the viewport last */
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ScreenInput {
    pub osc_title: String,
    pub osc_progress: String,
    pub lines: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    /* null = nothing matched, caller applies its fallback */
    pub state: Option<RunState>,
    pub rule_id: Option<String>,
    pub skip_state_update: bool,
}

fn rule_line(line: &str) -> bool {
    let t = line.trim_start();
    let count = t
        .chars()
        .take_while(|c| *c == '─' || *c == '━' || *c == '═')
        .count();
    count >= 6 && t.chars().count() == count
}

/* Matcher semantics mirror herdr's compiled_gate_matches
(src/detect/manifest.rs): every `contains` needle (case-insensitive),
every `regex` (case-sensitive, run against the whole region text —
patterns carry their own `(?m)`/`(?i)` flags), and every `line_regex`
(case-sensitive, each must hit at least one line) must hold; `any`
needs one branch, `all` needs every branch, `not` forbids any branch.
An empty gate matches — there is no "no evidence means no match"
special case upstream. */
fn matches_matcher(m: &Matcher, text: &str, lines: &[String]) -> bool {
    let contains = m.contains.as_deref().unwrap_or(&[]);
    let regex = m.regex.as_deref().unwrap_or(&[]);
    let line_regex = m.line_regex.as_deref().unwrap_or(&[]);
    let lower_text = text.to_lowercase();

    if !contains
        .iter()
        .all(|s| lower_text.contains(&s.to_lowercase()))
    {
        return false;
    }
    if !regex.iter().all(|r| regex_multi_hit(r, text)) {
        return false;
    }
    if !line_regex
        .iter()
        .all(|r| lines.iter().any(|line| regex_line_hit(r, line)))
    {
        return false;
    }
    if let Some(any) = &m.any {
        if !any.is_empty() && !any.iter().any(|sub| matches_matcher(sub, text, lines)) {
            return false;
        }
    }
    if let Some(all) = &m.all {
        if !all.iter().all(|sub| matches_matcher(sub, text, lines)) {
            return false;
        }
    }
    if let Some(not) = &m.not {
        if not.iter().any(|sub| matches_matcher(sub, text, lines)) {
            return false;
        }
    }
    true
}

/* Compiled-regex cache. Manifests are re-evaluated on every runtime tick
(once a second, per tab), so compiling inside the matcher rebuilt the
same patterns continuously. Keyed on the pattern source; an invalid
pattern is cached as None so the `contains` fallback is taken too. */
fn compiled(r: &str) -> Option<regex::Regex> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<regex::Regex>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().unwrap();
    if let Some(hit) = guard.get(r) {
        return hit.clone();
    }
    let built = regex::Regex::new(r).ok();
    guard.insert(r.to_string(), built.clone());
    built
}

/* TS: new RegExp(r, 'm').test(text) — an unanchored search that also lets
^ / $ match at any line boundary. We approximate: try `^`/`$` multi-line
semantics by matching against each line (oldest-first join already gives
us each physical line), falling back to a substring regex search. */
fn regex_multi_hit(r: &str, text: &str) -> bool {
    match compiled(r) {
        Some(re) => re.is_match(text),
        None => text.contains(r),
    }
}

fn regex_line_hit(r: &str, line: &str) -> bool {
    match compiled(r) {
        Some(re) => re.is_match(line),
        None => line.contains(r),
    }
}

fn matches_rule(rule: &Rule, screen: &ScreenInput) -> bool {
    let (text, lines) = region_text(&rule.region, screen);
    if text.trim().is_empty() {
        return false;
    }
    /* manifests are authored lowercase; matching is case-insensitive */
    matches_matcher(&rule.match_, &text, &lines)
}

/** Evaluate rules highest-priority-first. First match wins. */
pub fn evaluate(manifest: &AgentManifest, screen: &ScreenInput) -> Detection {
    let mut rules: Vec<&Rule> = manifest.rules.iter().collect();
    rules.sort_by(|a, b| b.priority.cmp(&a.priority));
    for rule in rules {
        if !matches_rule(rule, screen) {
            continue;
        }
        if rule.skip_state_update {
            return Detection {
                state: None,
                rule_id: Some(rule.id.clone()),
                skip_state_update: true,
            };
        }
        return Detection {
            state: Some(rule.state),
            rule_id: Some(rule.id.clone()),
            skip_state_update: false,
        };
    }
    Detection {
        state: None,
        rule_id: None,
        skip_state_update: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matcher_rule(
        id: &str,
        state: RunState,
        priority: i32,
        region: RegionName,
        m: Matcher,
    ) -> Rule {
        Rule {
            id: id.to_string(),
            state,
            priority,
            region,
            skip_state_update: false,
            match_: m,
        }
    }

    fn manifest() -> AgentManifest {
        /* representative subset mirroring real agent rules */
        AgentManifest {
            agent: "claude".to_string(),
            rules: vec![
                matcher_rule(
                    "osc_title_working",
                    RunState::Working,
                    1100,
                    RegionName::OscTitle,
                    Matcher {
                        regex: Some(S("^[\u{2800}-\u{28FF}\u{25D0}-\u{25D3}] ")),
                        ..Default::default()
                    },
                ),
                matcher_rule(
                    "prompt_box_idle",
                    RunState::Idle,
                    900,
                    RegionName::PromptBoxBody,
                    Matcher {
                        line_regex: Some(S(r"^\s*❯")),
                        ..Default::default()
                    },
                ),
                matcher_rule(
                    "blocked_q",
                    RunState::Blocked,
                    980,
                    RegionName::WholeRecent,
                    Matcher {
                        contains: Some(S("do you want to proceed?")),
                        ..Default::default()
                    },
                ),
            ],
        }
    }

    #[test]
    fn high_priority_working_wins() {
        let m = manifest();
        let d = evaluate(
            &m,
            &ScreenInput {
                osc_title: "\u{2800} running".to_string(),
                osc_progress: String::new(),
                lines: vec!["some output".to_string()],
            },
        );
        assert_eq!(d.state, Some(RunState::Working));
        assert_eq!(d.rule_id.as_deref(), Some("osc_title_working"));
    }

    #[test]
    fn blocked_beats_lower_idle() {
        let m = manifest();
        let d = evaluate(
            &m,
            &ScreenInput {
                osc_title: String::new(),
                osc_progress: String::new(),
                lines: vec![
                    "12:".to_string(),
                    "do you want to proceed?".to_string(),
                    "❯ 1. yes".to_string(),
                ],
            },
        );
        assert_eq!(d.state, Some(RunState::Blocked));
    }

    #[test]
    fn no_match_returns_null() {
        let m = manifest();
        let d = evaluate(
            &m,
            &ScreenInput {
                osc_title: String::new(),
                osc_progress: String::new(),
                lines: vec!["plain output".to_string()],
            },
        );
        assert_eq!(d.state, None);
        assert_eq!(d.rule_id, None);
    }

    #[test]
    fn match_is_case_insensitive() {
        let m = manifest();
        let d = evaluate(
            &m,
            &ScreenInput {
                osc_title: String::new(),
                osc_progress: String::new(),
                lines: vec!["DO YOU WANT TO PROCEED?".to_string()],
            },
        );
        assert_eq!(d.state, Some(RunState::Blocked));
    }

    /* TOML manifests spell this key `line_regex` (snake_case) while the
    struct serializes as camelCase for JSON IPC — the alias must keep
    both spellings live, or every TOML line_regex rule is silently
    dropped on deserialize (19 of 21 manifests hit this) */
    #[test]
    fn matcher_accepts_snake_case_line_regex() {
        let parsed: Matcher =
            toml::from_str(r#"line_regex = ['^\s*❯']"#).expect("snake_case must parse");
        assert_eq!(parsed.line_regex, Some(vec!["^\\s*❯".to_string()]));
        let parsed: Matcher =
            toml::from_str(r#"lineRegex = ['^\s*❯']"#).expect("camelCase must parse");
        assert_eq!(parsed.line_regex, Some(vec!["^\\s*❯".to_string()]));
    }

    /* the compiled-regex cache is on the 1 Hz tick path; a pattern that fails
    to compile must still be cached (as None) and fall back to a substring
    search on every subsequent call, not just the first */
    #[test]
    fn invalid_regex_caches_and_falls_back_to_contains() {
        let bad = r"^(unclosed[[:alpha:";
        assert!(regex::Regex::new(bad).is_err());
        assert!(!regex_line_hit(bad, "nothing here"));
        assert!(regex_line_hit(bad, &format!("prefix {bad} suffix")));
        assert!(regex_multi_hit(bad, &format!("multi\n{bad}\nline")));
        /* a valid pattern still works through the same cache */
        assert!(regex_line_hit(r"^\s*❯", "  ❯ 1. yes"));
        assert!(!regex_line_hit(r"^\s*❯", "text ❯ not at start"));
    }

    /* herdr parity: every pattern in a `regex`/`line_regex` list must
    hold (ALL), not just one (ANY). A single-element list behaves the
    same either way, which is why the port's divergence went unnoticed. */
    #[test]
    fn multi_pattern_line_regex_requires_every_pattern() {
        let m = Matcher {
            line_regex: Some(vec![
                r"^\s*question\s*$".to_string(),
                r"^\s*\? ".to_string(),
            ]),
            ..Default::default()
        };
        assert!(matches_matcher(
            &m,
            "question\n? what next",
            &["question".into(), "? what next".into()]
        ));
        assert!(!matches_matcher(&m, "? what next", &["? what next".into()]));
    }

    /* herdr parity: `regex`/`line_regex` run against the original-case
    text; only `contains` is case-insensitive. */
    #[test]
    fn regex_matching_is_case_sensitive_like_herdr() {
        let m = Matcher {
            regex: Some(vec!["MCP tasks".to_string()]),
            ..Default::default()
        };
        assert!(matches_matcher(&m, "MCP tasks still running", &[]));
        assert!(!matches_matcher(&m, "mcp tasks still running", &[]));
        let ci = Matcher {
            contains: Some(vec!["mcp tasks".to_string()]),
            ..Default::default()
        };
        assert!(matches_matcher(&ci, "MCP TASKS STILL RUNNING", &[]));
    }

    /* herdr parity: a gate with no matchers at all still matches. */
    #[test]
    fn empty_gate_matches_like_herdr() {
        assert!(matches_matcher(&Matcher::default(), "anything", &[]));
    }
}
