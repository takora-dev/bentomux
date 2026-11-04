/* ---------------- file/config helpers shared by agent adapters ----------------
Rust port of src/main/agents/util.ts + the plain-file bit of path-lookup.ts.
Handles JSON/ENV/TOML config editing, SKILL.md frontmatter, AGENTS.md
memory sections and the bentomux ownership marker. */

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use crate::shell::find_on_path;

pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true; /* leading dashes dropped */
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let s = out.trim_end_matches('-');
    if s.is_empty() {
        "item".to_string()
    } else {
        s.chars().take(48).collect()
    }
}

pub fn unique_slug(base: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(base) {
        return base.to_string();
    }
    let mut i = 2;
    loop {
        let cand = format!("{base}-{i}");
        if !taken.contains(&cand) {
            return cand;
        }
        i += 1;
    }
}

pub fn dir_exists(p: &str) -> bool {
    fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

pub fn read_text(p: &str) -> Option<String> {
    fs::read_to_string(p).ok()
}

pub fn read_json<T: serde::de::DeserializeOwned>(p: &str) -> Option<T> {
    let raw = read_text(p)?;
    serde_json::from_str(&raw).ok()
}

pub fn write_text(p: &str, content: &str) {
    if let Some(dir) = PathBuf::from(p).parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(mut f) = fs::File::create(p) {
        let _ = f.write_all(content.as_bytes());
    }
}

pub fn write_json(p: &str, value: &serde_json::Value) {
    let s = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
    write_text(p, &(s + "\n"));
}

/* ---------------- .env-style files (qwen / gemini CLI pick keys up from here) ---------------- */

pub fn parse_env_file(raw: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in raw.lines() {
        let t = line.trim();
        let body = t.strip_prefix("export ").unwrap_or(t).trim();
        let Some(eq) = body.find('=') else { continue };
        let key = body[..eq].trim();
        if key.is_empty()
            || !key
                .chars()
                .next()
                .map(|c| c.is_ascii_alphabetic() || c == '_')
                .unwrap_or(false)
        {
            continue;
        }
        let mut v = body[eq + 1..].trim().to_string();
        if (v.starts_with('"') && v.ends_with('"') && v.len() >= 2)
            || (v.starts_with('\'') && v.ends_with('\'') && v.len() >= 2)
        {
            v = v[1..v.len() - 1].to_string();
        }
        out.insert(key.to_string(), v);
    }
    out
}

/* upsert KEY=VALUE lines; a null value removes the key's line.
Other lines (comments, blanks, foreign keys) keep their order. */
pub fn upsert_env_file(raw: &str, entries: &HashMap<String, Option<String>>) -> String {
    let mut lines: Vec<String> = raw.lines().map(str::to_string).collect();
    for (key, value) in entries {
        let pat = format!(r"^\s*(?:export\s+)?{}\s*=", regex::escape(key));
        let at = lines.iter().position(|l| {
            regex::Regex::new(&pat)
                .map(|r| r.is_match(l))
                .unwrap_or(false)
        });
        match value {
            None => {
                if let Some(i) = at {
                    lines.remove(i);
                }
            }
            Some(v) => {
                if let Some(i) = at {
                    lines[i] = format!("{key}={v}");
                } else {
                    lines.push(format!("{key}={v}"));
                }
            }
        }
    }
    collapse_blank(lines).join("\n")
}

fn collapse_blank(lines: Vec<String>) -> Vec<String> {
    let mut out = Vec::with_capacity(lines.len());
    let mut prev_blank = true;
    for l in lines {
        let blank = l.trim().is_empty();
        if blank && prev_blank {
            continue;
        }
        out.push(l);
        prev_blank = blank;
    }
    while out.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        out.pop();
    }
    out
}

/* '128000' | '128k' | '1m' → token count; None when unparsable */
pub fn context_to_number(s: &str) -> Option<i64> {
    let t = s.trim().to_lowercase();
    let re = regex::Regex::new(r"^(\d+(?:\.\d+)?)\s*(k|m)?$").unwrap();
    let cap = re.captures(&t)?;
    let n: f64 = cap.get(1)?.as_str().parse().ok()?;
    let mult: f64 = match cap.get(2).map(|m| m.as_str()) {
        Some("k") => 1024.0,
        Some("m") => 1024.0 * 1024.0,
        _ => 1.0,
    };
    Some((n * mult).round() as i64)
}

/* ---------------- minimal TOML editing (codex config.toml) ----------------
Supports exactly what the adapters need: bare-key scalar entries at the
top level and inside one-level [table] sections. Comments and foreign
content are preserved verbatim. */

pub type TomlValue = toml::Value;

fn toml_line_key(line: &str) -> Option<String> {
    let re = regex::Regex::new(r"^([A-Za-z0-9_-]+)\s*=").unwrap();
    re.captures(line.trim())
        .map(|c| c.get(1).unwrap().as_str().to_string())
}

fn toml_header_name(line: &str) -> Option<String> {
    let re = regex::Regex::new(r"^\s*\[([^\]]+)\]").unwrap();
    re.captures(line)
        .map(|c| c.get(1).unwrap().as_str().trim().to_string())
}

fn read_toml_entries(raw: &str, table: Option<&str>) -> HashMap<String, toml::Value> {
    let mut out = HashMap::new();
    let mut current: Option<String> = None;
    for line in raw.lines() {
        if let Some(h) = toml_header_name(line) {
            current = Some(h);
            continue;
        }
        let Some(key) = toml_line_key(line) else {
            continue;
        };
        let in_table = current.is_some();
        let want_table = table.is_some();
        if in_table != want_table {
            continue;
        }
        if let Some(want) = table {
            if current.as_deref() != Some(want) {
                continue;
            }
        }
        if let Some(eq) = line.find('=') {
            let t = line[eq + 1..].trim();
            if let Ok(v) = t.parse::<toml::Value>() {
                out.insert(key, v);
            }
        }
    }
    out
}

pub fn read_toml_top(raw: &str) -> HashMap<String, toml::Value> {
    read_toml_entries(raw, None)
}

pub fn read_toml_table(raw: &str, table: &str) -> HashMap<String, toml::Value> {
    read_toml_entries(raw, Some(table))
}

fn toml_scalar(v: &toml::Value) -> String {
    match v {
        toml::Value::String(s) => format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")),
        other => other.to_string(),
    }
}

fn replace_or_insert(
    lines: &mut Vec<String>,
    key: &str,
    value: &toml::Value,
    from: usize,
    to: usize,
) {
    for line in lines.iter_mut().take(to).skip(from) {
        if toml_line_key(line).as_deref() == Some(key) {
            *line = format!("{key} = {}", toml_scalar(value));
            return;
        }
    }
    lines.insert(to, format!("{key} = {}", toml_scalar(value)));
}

fn drop_key(lines: &mut Vec<String>, key: &str, from: usize, to: usize) {
    for i in from..to {
        if toml_line_key(&lines[i]).as_deref() == Some(key) {
            lines.remove(i);
            return;
        }
    }
}

fn first_table(lines: &[String]) -> usize {
    lines
        .iter()
        .position(|l| toml_header_name(l).is_some())
        .unwrap_or(lines.len())
}

/* set one top-level scalar; None removes it. Insertion point is right
before the first [table] header (or EOF). */
pub fn upsert_toml_top(raw: &str, key: &str, value: Option<toml::Value>) -> String {
    let mut lines: Vec<String> = raw.lines().map(str::to_string).collect();
    let end = first_table(&lines);
    if let Some(v) = &value {
        replace_or_insert(&mut lines, key, v, 0, end);
    } else {
        drop_key(&mut lines, key, 0, end);
    }
    collapse_blank(lines).join("\n")
}

/* set entries inside one [table] section; a None drops the key.
A missing section is appended. */
pub fn upsert_toml_table(
    raw: &str,
    table: &str,
    entries: &HashMap<String, Option<toml::Value>>,
) -> String {
    let mut lines: Vec<String> = raw.lines().map(str::to_string).collect();
    let start = lines
        .iter()
        .position(|l| toml_header_name(l).as_deref() == Some(table));
    let start = match start {
        Some(i) => i,
        None => {
            let mut fresh = lines;
            if !fresh.is_empty() && !fresh.last().map(|l| l.trim().is_empty()).unwrap_or(true) {
                fresh.push(String::new());
            }
            fresh.push(format!("[{table}]"));
            for (k, v) in entries {
                if let Some(v) = v {
                    fresh.push(format!("{k} = {}", toml_scalar(v)));
                }
            }
            return collapse_blank(fresh).join("\n");
        }
    };
    let mut end = start + 1;
    while end < lines.len() && toml_header_name(&lines[end]).is_none() {
        end += 1;
    }
    for (key, value) in entries {
        if let Some(v) = value {
            replace_or_insert(&mut lines, key, v, start + 1, end);
        } else {
            drop_key(&mut lines, key, start + 1, end);
        }
    }
    collapse_blank(lines).join("\n")
}

pub fn mtime(p: &str) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        })
        .unwrap_or(0)
}

pub fn rm_rf(p: &str) {
    let _ = fs::remove_dir_all(p);
}

pub fn on_path(binary: &str) -> bool {
    find_on_path(binary).is_some()
}

/* ---------------- SKILL.md frontmatter ---------------- */

pub fn frontmatter(name: &str, description: &str, body: &str) -> String {
    let desc = description.replace('\n', " ");
    format!(
        "---\nname: {name}\ndescription: {desc}\n---\n\n{}\n",
        body.trim()
    )
}

pub fn parse_frontmatter(raw: &str) -> (std::collections::HashMap<String, String>, String) {
    let mut attrs = HashMap::new();
    if let Some(rest) = raw.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let head = &rest[..end];
            let body_start = end + 4;
            let body = raw[body_start..].trim_start().to_string();
            for line in head.lines() {
                if let Some(colon) = line.find(':') {
                    attrs.insert(
                        line[..colon].trim().to_string(),
                        line[colon + 1..].trim().to_string(),
                    );
                }
            }
            return (attrs, body);
        }
    }
    (attrs, raw.to_string())
}

/* ---------------- bentomux ownership marker (memory files / AGENTS.md sections) ---------------- */

pub fn normalize_memory_markers(raw: &str) -> String {
    raw.replace("takora:memory:", "bentomux:memory:")
}

pub fn memory_marker(id: &str) -> String {
    format!("<!-- bentomux:memory:{id} -->")
}

pub fn with_memory_marker(id: &str, title: &str, content: &str) -> String {
    format!("{}\n# {title}\n\n{}\n", memory_marker(id), content.trim())
}

pub fn strip_memory_marker(raw: &str) -> Option<(String, String, String)> {
    let normalized = normalize_memory_markers(raw);
    let re = regex::Regex::new(
        r"(?m)^<!--\s*bentomux:memory:([^\s>]+)\s*-->\s*(?:#\s*(.+?)\s*$)?\s*([\s\S]*)$",
    )
    .unwrap();
    let cap = re.captures(&normalized)?;
    Some((
        cap.get(1)?.as_str().to_string(),
        cap.get(2)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default(),
        cap.get(3)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default(),
    ))
}

/* ---------------- pi-style AGENTS.md sections ---------------- */

fn section_begin(id: &str) -> String {
    format!("<!-- bentomux:memory:{id}:begin -->")
}
fn section_end(id: &str) -> String {
    format!("<!-- bentomux:memory:{id}:end -->")
}

fn esc(s: &str) -> String {
    regex::escape(s)
}

pub fn upsert_section(raw_in: &str, id: &str, title: &str, content: &str) -> String {
    let raw = normalize_memory_markers(raw_in);
    let block = format!(
        "{}\n# {title}\n\n{}\n{}",
        section_begin(id),
        content.trim(),
        section_end(id)
    );
    let re = regex::Regex::new(&format!(
        "{}[\\s\\S]*?{}",
        esc(&section_begin(id)),
        esc(&section_end(id))
    ))
    .unwrap();
    if re.is_match(&raw) {
        return re.replace(&raw, block.as_str()).to_string();
    }
    let sep = if raw.trim().is_empty() { "" } else { "\n\n" };
    format!("{}{}{}\n", raw.trim_end(), sep, block)
}

pub fn remove_section(raw_in: &str, id: &str) -> String {
    let raw = normalize_memory_markers(raw_in);
    let re = regex::Regex::new(&format!(
        r"\n?\s*{}[\s\S]*?{}\s*",
        esc(&section_begin(id)),
        esc(&section_end(id))
    ))
    .unwrap();
    collapse_blank(
        re.replace_all(&raw, "\n")
            .lines()
            .map(str::to_string)
            .collect(),
    )
    .join("\n")
}

#[allow(clippy::type_complexity)]
pub fn parse_sections(raw_in: &str) -> Vec<(String, String, String)> {
    let raw = normalize_memory_markers(raw_in);
    /* Electron's regex used a `\1` backreference to require the section-END
    marker to carry the same id as the BEGIN marker. Rust's `regex` crate
    does not support backreferences (linear-time guarantee), so we scan
    manually: find each BEGIN marker, grab its id, then take the first
    END marker with that same id — equivalent to the non-greedy `.*?`
    match in the TS original. */
    let begin = regex::Regex::new(r"<!--\s*bentomux:memory:([^\s:>]+):begin\s*-->").unwrap();
    let mut out = Vec::new();
    let mut pos = 0usize;
    while let Some(m) = begin.captures(&raw[pos..]) {
        let mv = m.get(0).unwrap();
        let id = m.get(1).unwrap().as_str();
        let after_begin = pos + mv.end();
        let end_pat = format!("<!--\\s*bentomux:memory:{}:end\\s*-->", regex::escape(id));
        let Ok(end_re) = regex::Regex::new(&end_pat) else {
            /* unreachable: regex::escape is always valid */
            return out;
        };
        let rest = &raw[after_begin..];
        let Some(end_m) = end_re.find(rest) else {
            break;
        };
        let body = &rest[..end_m.start()];
        /* optional title: a leading `# heading` line, then the content */
        let trimmed = body.trim_start();
        let (title, content) = if let Some(rest2) = trimmed.strip_prefix('#') {
            let title_line = rest2.lines().next().unwrap_or("").trim().to_string();
            let content = rest2
                .lines()
                .skip(1)
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();
            (title_line, content)
        } else {
            ("".to_string(), body.trim().to_string())
        };
        out.push((id.to_string(), title, content));
        pos = after_begin + end_m.end();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> String {
        "<!-- bentomux:memory:alpha:begin -->\n# Title A\ncontent A\n<!-- bentomux:memory:alpha:end -->\n<!-- bentomux:memory:beta:begin -->\ncontent B\n<!-- bentomux:memory:beta:end -->".to_string()
    }

    #[test]
    fn parse_sections_extracts_multiple_with_matching_ids() {
        let sections = parse_sections(&sample());
        assert_eq!(sections.len(), 2);
        assert_eq!(
            sections[0],
            (
                "alpha".to_string(),
                "Title A".to_string(),
                "content A".to_string()
            )
        );
        assert_eq!(
            sections[1],
            ("beta".to_string(), "".to_string(), "content B".to_string())
        );
    }

    #[test]
    fn parse_sections_does_not_panic_on_backreference_style_regex() {
        /* regression guard: the Electron original used a `\1` backreference
        which Rust's regex crate rejects; the scan must run cleanly. */
        let sections = parse_sections(&sample());
        assert_eq!(sections.len(), 2);
    }

    #[test]
    fn parse_sections_mismatched_end_id_is_skipped() {
        /* begin carries `alpha`, but the next end marker carries `gamma`;
        no matching end → nothing is emitted (non-greedy + backref
        semantics would also reject a mismatched id). */
        let raw =
            "<!-- bentomux:memory:alpha:begin -->\ncontent\n<!-- bentomux:memory:gamma:end -->";
        let sections = parse_sections(raw);
        assert!(sections.is_empty());
    }

    #[test]
    fn parse_sections_empty_and_plain_text() {
        assert!(parse_sections("").is_empty());
        assert!(parse_sections("hello world, no markers").is_empty());
    }
}
