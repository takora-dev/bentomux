/* ---------------- per-agent screen manifests ----------------
Rule strings for Claude Code are ported from herdr's bundled
manifest (github.com/herdrdev/herdr, src/detect/manifests/claude.toml).
The pi manifest is verified against the installed
@earendil-works/pi-coding-agent dist source (spinner-anchored working
line + footer-stats idle line, both scoped to the bottom lines so
transcript history can never impersonate a live turn). */

use super::rules::{Matcher, RegionName, Rule, RunState, S};

fn rule(
    id: &str,
    state: RunState,
    priority: i32,
    region: RegionName,
    skip: bool,
    match_: Matcher,
) -> Rule {
    Rule {
        id: id.to_string(),
        state,
        priority,
        region,
        skip_state_update: skip,
        match_,
    }
}

fn contains_all(items: &[&str]) -> Matcher {
    Matcher {
        contains: Some(items.iter().map(|s| s.to_string()).collect()),
        ..Default::default()
    }
}

fn any_of(items: Vec<Matcher>) -> Matcher {
    Matcher {
        any: Some(items),
        ..Default::default()
    }
}

pub fn claude_manifest() -> super::rules::AgentManifest {
    super::rules::AgentManifest {
        agent: "claude".to_string(),
        rules: vec![
            /* transient overlay — never flips state */
            rule(
                "transcript_viewer",
                RunState::Unknown,
                1000,
                RegionName::Bottom(3),
                true,
                Matcher {
                    contains: Some(S("showing detailed transcript")),
                    any: Some(vec![
                        contains_all(&["ctrl+o", "to toggle"]),
                        contains_all(&["ctrl+e", "show all"]),
                        contains_all(&["↑↓ scroll"]),
                    ]),
                    ..Default::default()
                },
            ),
            /* busy spinner in the window title (braille ≤2.1.227, half-circles after) */
            rule(
                "osc_title_working",
                RunState::Working,
                1100,
                RegionName::OscTitle,
                false,
                Matcher {
                    regex: Some(S("^[\\u{2800}-\\u{28FF}\\u{25D0}-\\u{25D3}] ")),
                    ..Default::default()
                },
            ),
            rule(
                "live_turn_working",
                RunState::Working,
                970,
                RegionName::Bottom(12),
                false,
                Matcher {
                    any: Some(vec![
                        Matcher {
                            line_regex: Some(S("^\\s*[⏸⏵].*esc to interrupt(?:\\s|·|$)")),
                            ..Default::default()
                        },
                        Matcher {
                            line_regex: Some(S(
                                "^\\s*[\\*·✳✻✦]\\s+\\S.*…(?:\\s+\\(\\d+[smh](?:\\s|·)|\\s*$)",
                            )),
                            ..Default::default()
                        },
                    ]),
                    ..Default::default()
                },
            ),
            /* permission / approval prompts */
            rule(
                "permission_proceed",
                RunState::Blocked,
                980,
                RegionName::WholeRecent,
                false,
                Matcher {
                    all: Some(vec![
                        contains_all(&["do you want to proceed?"]),
                        any_of(vec![
                            Matcher {
                                line_regex: Some(S("^\\s*(?:❯\\s*)?1\\.\\s*yes\\b")),
                                ..Default::default()
                            },
                            Matcher {
                                line_regex: Some(S("^\\s*2\\.\\s*no\\b")),
                                ..Default::default()
                            },
                            contains_all(&["esc to cancel"]),
                        ]),
                    ]),
                    ..Default::default()
                },
            ),
            rule(
                "selection_form",
                RunState::Blocked,
                980,
                RegionName::WholeRecent,
                false,
                Matcher {
                    contains: Some(S("enter to select")),
                    any: Some(vec![
                        contains_all(&["tab/arrow keys to navigate"]),
                        contains_all(&["arrow keys to navigate"]),
                        contains_all(&["arrows to navigate"]),
                        contains_all(&["↑/↓ to navigate"]),
                        contains_all(&["↑↓ to navigate"]),
                    ]),
                    ..Default::default()
                },
            ),
            rule(
                "plan_confirm",
                RunState::Blocked,
                970,
                RegionName::WholeRecent,
                false,
                Matcher {
                    contains: Some(S("would you like to proceed?")),
                    not: Some(vec![Matcher {
                        line_regex: Some(S("^\\s*❯\\s*$")),
                        ..Default::default()
                    }]),
                    ..Default::default()
                },
            ),
            /* idle prompt box inside the bottom frame */
            rule(
                "live_prompt_box",
                RunState::Idle,
                900,
                RegionName::PromptBoxBody,
                false,
                Matcher {
                    line_regex: Some(vec!["^\\s*❯".to_string(), "^\\s*[│║]\\s*[❯>]".to_string()]),
                    not: Some(vec![
                        contains_all(&["enter to select"]),
                        contains_all(&["esc to cancel"]),
                        contains_all(&["tab/arrow keys"]),
                    ]),
                    ..Default::default()
                },
            ),
            /* OSC fallbacks: ✳ title = idle; progress settled/reset (state 4 or 0) = idle */
            rule(
                "osc_title_idle",
                RunState::Idle,
                250,
                RegionName::OscTitle,
                false,
                Matcher {
                    regex: Some(S("^[\u{2733}] ")),
                    ..Default::default()
                },
            ),
            rule(
                "osc_progress_idle",
                RunState::Idle,
                250,
                RegionName::OscProgress,
                false,
                Matcher {
                    regex: Some(vec!["^0;".to_string(), "^4;0$".to_string()]),
                    ..Default::default()
                },
            ),
            /* weakest blocker evidence — anything asking a question */
            rule(
                "legacy_no_prompt_blocker",
                RunState::Blocked,
                300,
                RegionName::WholeRecent,
                false,
                Matcher {
                    any: Some(vec![
                        Matcher {
                            all: Some(vec![
                                contains_all(&["do you want to"]),
                                any_of(vec![contains_all(&["yes"]), contains_all(&["❯"])]),
                            ]),
                            ..Default::default()
                        },
                        Matcher {
                            all: Some(vec![
                                contains_all(&["would you like to"]),
                                any_of(vec![contains_all(&["yes"]), contains_all(&["❯"])]),
                            ]),
                            ..Default::default()
                        },
                        contains_all(&["waiting for permission"]),
                        contains_all(&["review your answers"]),
                    ]),
                    not: Some(vec![Matcher {
                        line_regex: Some(S("^\\s*❯\\s*$")),
                        ..Default::default()
                    }]),
                    ..Default::default()
                },
            ),
        ],
    }
}

#[derive(serde::Deserialize)]
struct RawManifest {
    id: String,
    #[serde(default)]
    aliases: Vec<String>,
    rules: Vec<RawRule>,
}

#[derive(serde::Deserialize)]
struct RawRule {
    id: String,
    state: RunState,
    priority: i32,
    region: String,
    #[serde(default)]
    skip_state_update: bool,
    #[serde(flatten)]
    matcher: Matcher,
}

const TOML_MANIFESTS: &[(&str, &str)] = &[
    ("amp", include_str!("../../../resources/manifests/amp.toml")),
    (
        "antigravity",
        include_str!("../../../resources/manifests/antigravity.toml"),
    ),
    (
        "claude",
        include_str!("../../../resources/manifests/claude.toml"),
    ),
    (
        "cline",
        include_str!("../../../resources/manifests/cline.toml"),
    ),
    (
        "codex",
        include_str!("../../../resources/manifests/codex.toml"),
    ),
    (
        "cursor",
        include_str!("../../../resources/manifests/cursor.toml"),
    ),
    (
        "devin",
        include_str!("../../../resources/manifests/devin.toml"),
    ),
    (
        "droid",
        include_str!("../../../resources/manifests/droid.toml"),
    ),
    (
        "gemini",
        include_str!("../../../resources/manifests/gemini.toml"),
    ),
    (
        "copilot",
        include_str!("../../../resources/manifests/github-copilot.toml"),
    ),
    (
        "grok",
        include_str!("../../../resources/manifests/grok.toml"),
    ),
    (
        "hermes",
        include_str!("../../../resources/manifests/hermes.toml"),
    ),
    (
        "kilo",
        include_str!("../../../resources/manifests/kilo.toml"),
    ),
    (
        "kimi",
        include_str!("../../../resources/manifests/kimi.toml"),
    ),
    (
        "kiro",
        include_str!("../../../resources/manifests/kiro.toml"),
    ),
    (
        "maki",
        include_str!("../../../resources/manifests/maki.toml"),
    ),
    (
        "muse",
        include_str!("../../../resources/manifests/muse.toml"),
    ),
    (
        "opencode",
        include_str!("../../../resources/manifests/opencode.toml"),
    ),
    ("pi", include_str!("../../../resources/manifests/pi.toml")),
    (
        "qodercli",
        include_str!("../../../resources/manifests/qodercli.toml"),
    ),
    (
        "qwen",
        include_str!("../../../resources/manifests/qwen.toml"),
    ),
];

fn parse_region(raw: &str) -> Option<RegionName> {
    let number = |prefix: &str| raw.strip_prefix(prefix)?.strip_suffix(')')?.parse().ok();
    Some(match raw {
        "osc_title" => RegionName::OscTitle,
        "osc_progress" => RegionName::OscProgress,
        "whole_recent" => RegionName::WholeRecent,
        "whole_recent_without_current_prompt_marker" => {
            RegionName::WholeRecentWithoutCurrentPromptMarker
        }
        "after_last_prompt_marker" => RegionName::AfterLastPromptMarker,
        "after_last_horizontal_rule" => RegionName::AfterLastHorizontalRule,
        "prompt_box_body" => RegionName::PromptBoxBody,
        "last_non_empty_above_prompt_box" => RegionName::LastLineAbovePromptBox,
        _ if raw.starts_with("bottom_non_empty_lines(") => {
            RegionName::Bottom(number("bottom_non_empty_lines(")?)
        }
        _ if raw.starts_with("top_non_empty_lines(") => {
            RegionName::Top(number("top_non_empty_lines(")?)
        }
        _ => return None,
    })
}

fn manifest_from_toml(agent: &str) -> Option<super::rules::AgentManifest> {
    let (_, source) = TOML_MANIFESTS.iter().find(|(_, source)| {
        toml::from_str::<RawManifest>(source)
            .map(|m| m.id == agent || m.aliases.iter().any(|a| a == agent))
            .unwrap_or(false)
    })?;
    let raw: RawManifest = toml::from_str(source).ok()?;
    Some(super::rules::AgentManifest {
        agent: raw.id,
        rules: raw
            .rules
            .into_iter()
            .filter_map(|r| {
                Some(Rule {
                    id: r.id,
                    state: r.state,
                    priority: r.priority,
                    region: parse_region(&r.region)?,
                    skip_state_update: r.skip_state_update,
                    match_: r.matcher,
                })
            })
            .collect(),
    })
}

pub fn manifest_for(agent: &str) -> Option<super::rules::AgentManifest> {
    manifest_from_toml(agent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detect::rules::{evaluate, ScreenInput};

    #[test]
    fn manifest_evaluates_title_spinner_as_working() {
        let m = claude_manifest();
        let d = evaluate(
            &m,
            &ScreenInput {
                osc_title: "\u{2800} generating…".to_string(),
                osc_progress: String::new(),
                lines: vec!["some output".to_string()],
            },
        );
        assert_eq!(d.state, Some(RunState::Working));
    }

    #[test]
    fn manifest_evaluates_permission_as_blocked() {
        let m = claude_manifest();
        let d = evaluate(
            &m,
            &ScreenInput {
                osc_title: String::new(),
                osc_progress: String::new(),
                lines: vec![
                    "Do you want to proceed?".to_string(),
                    "❯ 1. yes".to_string(),
                    "  2. no".to_string(),
                    "esc to cancel".to_string(),
                ],
            },
        );
        assert_eq!(d.state, Some(RunState::Blocked));
    }

    #[test]
    fn manifest_idles_on_empty_prompt() {
        let m = claude_manifest();
        let d = evaluate(
            &m,
            &ScreenInput {
                osc_title: String::new(),
                osc_progress: String::new(),
                lines: vec![
                    "plain output".to_string(),
                    "━━━━━━━━━━━━━━".to_string(),
                    "❯".to_string(),
                ],
            },
        );
        assert_eq!(d.state, Some(RunState::Idle));
    }
    #[test]
    fn loads_downloaded_manifest_and_alias() {
        let m = manifest_for("codex").expect("codex manifest");
        assert!(manifest_for("cursor-agent").is_some());
        let d = evaluate(
            &m,
            &ScreenInput {
                osc_title: "⠋ working".to_string(),
                osc_progress: String::new(),
                lines: vec!["output".to_string()],
            },
        );
        assert_eq!(d.state, Some(RunState::Working));
    }
    #[test]
    fn every_supplied_manifest_loads() {
        for (agent, _) in TOML_MANIFESTS {
            let manifest = manifest_for(agent).expect("manifest should load");
            assert!(!manifest.rules.is_empty(), "{agent} has no rules");
        }
    }
    #[test]
    fn pi_history_must_not_read_as_working() {
        /* the reported bug: a stale "Working" line still visible in the
        transcript kept the tab on working while the agent sat idle.
        The old whole_recent rule matched it anywhere in the viewport;
        the scoped rule must only fire inside the bottom lines, and the
        footer stats line must read as idle. */
        let m = manifest_for("pi").expect("pi manifest");
        let idle_with_history = evaluate(
            &m,
            &ScreenInput {
                osc_title: String::new(),
                osc_progress: String::new(),
                lines: vec![
                    "⠋ Working (esc to interrupt)".to_string(),
                    "done, edited foo.ts".to_string(),
                    "ran tests: 12 passed".to_string(),
                    "anything else?".to_string(),
                    "sure, go ahead".to_string(),
                    "all done".to_string(),
                    "~/proj (main)".to_string(),
                    "↑1.2k ↓800 12.4%/200k  my-model".to_string(),
                ],
            },
        );
        assert_eq!(
            idle_with_history.state,
            Some(RunState::Idle),
            "got {:?}",
            idle_with_history.rule_id
        );
        let live = evaluate(
            &m,
            &ScreenInput {
                osc_title: String::new(),
                osc_progress: String::new(),
                lines: vec![
                    "editing foo.ts".to_string(),
                    "~/proj (main)".to_string(),
                    "↑1.2k ↓800 12.4%/200k  my-model".to_string(),
                    "⠙ Working (esc to interrupt)".to_string(),
                ],
            },
        );
        assert_eq!(live.state, Some(RunState::Working));
    }
    #[test]
    fn opencode_history_must_not_read_as_working() {
        /* the reported bug: opencode finishes while its pane sits unfocused
        behind a newly opened terminal, and the tab sticks on working. The
        old whole_recent interrupt-hint rule kept matching the stale
        "esc to interrupt" line still visible in the transcript. Scoped to
        the bottom lines, history must not impersonate a live turn. */
        let m = manifest_for("opencode").expect("opencode manifest");
        let idle_with_history = evaluate(
            &m,
            &ScreenInput {
                osc_title: String::new(),
                osc_progress: String::new(),
                lines: vec![
                    "esc to interrupt · working".to_string(),
                    "done, edited foo.ts".to_string(),
                    "ran tests: 12 passed".to_string(),
                    "all done".to_string(),
                    "summary of changes".to_string(),
                    "file list".to_string(),
                    "token usage 12.4k".to_string(),
                    "session info".to_string(),
                    "Type your message…".to_string(),
                    "› ".to_string(),
                    "hint: /help for commands".to_string(),
                    "cwd ~/proj (main)".to_string(),
                ],
            },
        );
        assert!(
            idle_with_history.state != Some(RunState::Working),
            "stale history read as working via {:?}",
            idle_with_history.rule_id
        );
        let live = evaluate(
            &m,
            &ScreenInput {
                osc_title: String::new(),
                osc_progress: String::new(),
                lines: vec![
                    "editing foo.ts".to_string(),
                    "esc to interrupt · working".to_string(),
                ],
            },
        );
        assert_eq!(live.state, Some(RunState::Working));
    }
}
