/* ---------------- authoritative PTY terminal model ----------------
The persistent PTY host owns the only vt100 parser for a pane. The app
receives immutable snapshots for runtime detection and the remote mirror;
it must not parse the same byte stream a second time. */

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use vt100::Parser;

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;
const SCROLLBACK: usize = 500;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TerminalSnapshot {
    pub text: String,
    pub html: String,
    pub title: String,
    pub progress: String,
    pub last_data_at: u64,
    /* pane working directory, from OSC 7. Empty until the shell reports one:
    not every shell emits OSC 7, and a pane that has not been told must not
    look like one sitting in `/`. */
    pub cwd: String,
}

pub struct TerminalModel {
    term: Parser,
    title: String,
    progress: String,
    cwd: String,
    last_data_at: u64,
    osc_carry: Vec<u8>,
}

impl Default for TerminalModel {
    fn default() -> Self {
        Self::new(DEFAULT_ROWS, DEFAULT_COLS)
    }
}

impl TerminalModel {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self {
            term: Parser::new(rows, cols, SCROLLBACK),
            title: String::new(),
            progress: String::new(),
            cwd: String::new(),
            last_data_at: 0,
            osc_carry: Vec::new(),
        }
    }

    pub fn set_size(&mut self, rows: u16, cols: u16) {
        self.term.set_size(rows.max(1), cols.max(1));
    }

    pub fn process(&mut self, chunk: &[u8]) {
        feed(
            &mut self.term,
            &mut self.title,
            &mut self.progress,
            &mut self.cwd,
            &mut self.osc_carry,
            chunk,
        );
        if has_visible_activity(chunk) {
            self.last_data_at = now_ms();
        }
    }

    pub fn state_formatted(&self) -> Vec<u8> {
        let screen = self.term.screen();
        let mut state = if screen.alternate_screen() {
            b"\x1b[?1049h".to_vec()
        } else {
            b"\x1b[?1049l\x1b[3J".to_vec()
        };
        state.extend(screen.state_formatted());
        state
    }

    pub fn snapshot(&self) -> TerminalSnapshot {
        TerminalSnapshot {
            text: self.text(),
            /* html is the expensive half of a snapshot (per-cell style walk
            over the whole grid). Consumers that need it (remote mirror)
            ask explicitly via snapshot_html(); the 500 ms hot tick must
            not pay for it on panes nobody watches. */
            html: String::new(),
            title: self.title.clone(),
            progress: self.progress.clone(),
            last_data_at: self.last_data_at,
            cwd: self.cwd.clone(),
        }
    }

    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    pub fn text(&self) -> String {
        self.term.screen().contents()
    }

    pub fn snapshot_html(&self) -> TerminalSnapshot {
        TerminalSnapshot {
            text: self.term.screen().contents(),
            html: screen_dump_html(&self.term),
            title: self.title.clone(),
            progress: self.progress.clone(),
            last_data_at: self.last_data_at,
            cwd: self.cwd.clone(),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* OSC 7 carries a URI, not a path: `file://host/path%20with%20spaces`.
We want the path back, so drop the scheme and authority and undo the
percent-encoding. A pane that reports nothing keeps its previous cwd. */
fn decode_osc7_uri(payload: &str) -> Option<String> {
    let rest = payload.strip_prefix("file://")?;
    let path = match rest.find('/') {
        Some(0) => rest,
        /* `file://host/path` — strip the authority; a non-empty host other
        than localhost names a remote share we have no path for */
        Some(slash) => {
            let host = &rest[..slash];
            if !host.is_empty() && host != "localhost" {
                return None;
            }
            &rest[slash..]
        }
        None => return None,
    };
    if path.is_empty() {
        return None;
    }
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

fn handle_osc(title: &mut String, progress: &mut String, cwd: &mut String, payload: &[u8]) {
    let text = String::from_utf8_lossy(payload);
    if let Some(rest) = text.strip_prefix("0;").or_else(|| text.strip_prefix("2;")) {
        *title = rest.to_string();
    } else if let Some(rest) = text.strip_prefix("7;") {
        if let Some(path) = decode_osc7_uri(rest) {
            *cwd = path;
        }
    } else if let Some(rest) = text.strip_prefix("9;") {
        let mut parts = rest.split(';');
        match parts.next() {
            Some("4") => *progress = parts.collect::<Vec<_>>().join(";"),
            Some("0") => progress.clear(),
            _ => {}
        }
    }
}

fn feed(
    term: &mut Parser,
    title: &mut String,
    progress: &mut String,
    cwd: &mut String,
    osc_carry: &mut Vec<u8>,
    chunk: &[u8],
) {
    if osc_carry.is_empty() && !chunk.contains(&0x1b) {
        term.process(chunk);
        return;
    }

    let mut stream = std::mem::take(osc_carry);
    stream.reserve(chunk.len());
    stream.extend_from_slice(chunk);

    let mut render = Vec::with_capacity(stream.len());
    let mut i = 0usize;
    while i < stream.len() {
        if stream[i] == 0x1b && i + 1 < stream.len() && stream[i + 1] == b']' {
            let mut end = None;
            let mut j = i + 2;
            while j < stream.len() {
                if stream[j] == 0x07 {
                    end = Some(j);
                    break;
                }
                if stream[j] == 0x1b && j + 1 < stream.len() && stream[j + 1] == b'\\' {
                    end = Some(j);
                    break;
                }
                j += 1;
            }
            match end {
                Some(e) => {
                    handle_osc(title, progress, cwd, &stream[i + 2..e]);
                    i = if stream[e] == 0x1b { e + 2 } else { e + 1 };
                }
                None => {
                    *osc_carry = stream[i..].to_vec();
                    break;
                }
            }
        } else {
            let start = i;
            i += 1;
            while i < stream.len() && stream[i] != 0x1b {
                i += 1;
            }
            render.extend_from_slice(&stream[start..i]);
        }
    }
    if !render.is_empty() {
        term.process(&render);
    }
}

fn has_visible_activity(chunk: &[u8]) -> bool {
    let mut i = 0;
    while i < chunk.len() {
        if chunk[i] == 0x1b {
            i += 1;
            while i < chunk.len() {
                let b = chunk[i];
                i += 1;
                if (0x40..=0x7e).contains(&b) {
                    break;
                }
            }
            continue;
        }
        if chunk[i] >= 0x20 && chunk[i] != b' ' {
            return true;
        }
        i += 1;
    }
    false
}

const ANSI16: [&str; 16] = [
    "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
];

fn ansi_css(c: vt100::Color) -> String {
    match c {
        vt100::Color::Default => String::new(),
        vt100::Color::Idx(i) => ANSI16.get(i as usize).copied().unwrap_or("").to_string(),
        vt100::Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
    }
}

fn cell_style(cell: &vt100::Cell) -> String {
    let mut out = String::new();
    let (mut fg, mut bg) = (cell.fgcolor(), cell.bgcolor());
    if cell.inverse() {
        std::mem::swap(&mut fg, &mut bg);
    }
    if fg != vt100::Color::Default {
        out.push_str("color:");
        out.push_str(&ansi_css(fg));
        out.push(';');
    }
    if bg != vt100::Color::Default {
        out.push_str("background:");
        out.push_str(&ansi_css(bg));
        out.push(';');
    }
    if cell.bold() {
        out.push_str("font-weight:bold;");
    }
    if cell.italic() {
        out.push_str("font-style:italic;");
    }
    if cell.underline() {
        out.push_str("text-decoration:underline;");
    }
    out
}

fn escape_cell(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

fn screen_dump_html(term: &Parser) -> String {
    let screen = term.screen();
    let (rows, cols) = screen.size();
    let mut out = String::new();
    for r in 0..rows {
        let mut line = String::new();
        let mut prev_style = String::new();
        let mut open = false;
        let mut col = 0u16;
        while col < cols {
            let Some(cell) = screen.cell(r, col) else {
                break;
            };
            if cell.is_wide_continuation() {
                col += 1;
                continue;
            }
            let takes_two = cell.is_wide();
            if cell.has_contents()
                || cell.fgcolor() != vt100::Color::Default
                || cell.bgcolor() != vt100::Color::Default
                || cell.bold()
                || cell.italic()
                || cell.underline()
                || cell.inverse()
            {
                let style = cell_style(cell);
                if style != prev_style {
                    if open {
                        line.push_str("</span>");
                    }
                    open = false;
                    if !style.is_empty() {
                        line.push_str("<span style=\"");
                        line.push_str(&style);
                        line.push_str("\">");
                        open = true;
                    }
                    prev_style = style;
                }
                line.push_str(&escape_cell(&cell.contents()));
            } else {
                if open {
                    line.push_str("</span>");
                    open = false;
                }
                prev_style.clear();
                line.push(' ');
            }
            col += if takes_two { 2 } else { 1 };
        }
        while line.ends_with(' ') {
            line.pop();
        }
        if open {
            line.push_str("</span>");
        }
        /* every row of the grid, always. A dump that started at the first
        non-blank row changed height from frame to frame, and a mirror whose
        height breathes makes the phone re-place its scroll on every frame
        — which WebKit paints as a two-pass glitch (WebKit #261692), so a
        block of the screen showed up missing on Safari only. */
        if r > 0 {
            out.push('\n');
        }
        out.push_str(&line);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc_is_stripped_and_split_sequences_are_preserved() {
        let mut model = TerminalModel::default();
        model.process(b"\x1b]0;hel");
        model.process(b"lo\x07\x1b[31mred\x1b[0m");
        assert_eq!(model.snapshot().title, "hello");
        assert!(model.snapshot().text.contains("red"));
        assert!(!model.snapshot().text.contains('\u{1b}'));
    }

    #[test]
    fn osc7_reports_the_pane_cwd_percent_decoded() {
        let mut model = TerminalModel::default();
        model.process(b"\x1b]7;file://localhost/Users/me/my%20project\x07$ ");
        assert_eq!(model.cwd(), "/Users/me/my project");

        /* a bare host is optional; a real host is not a local path */
        model.process(b"\x1b]7;file:///tmp/a%2Bb\x07");
        assert_eq!(model.cwd(), "/tmp/a+b");
        model.process(b"\x1b]7;file://server/share\x07");
        assert_eq!(
            model.cwd(),
            "/tmp/a+b",
            "a foreign host must not move the pane"
        );
    }

    #[test]
    fn osc7_split_across_chunks_and_survives_other_output() {
        let mut model = TerminalModel::default();
        model.process(b"\x1b]7;file:///a/b");
        assert_eq!(model.cwd(), "", "an unfinished OSC carries no cwd yet");
        model.process(b"-c\x07plain text");
        assert_eq!(model.cwd(), "/a/b-c");
        assert!(model.text().contains("plain text"));
    }

    #[test]
    fn state_replay_contains_rendered_text() {
        let mut model = TerminalModel::default();
        model.process(b"hello");
        assert!(String::from_utf8(model.state_formatted())
            .unwrap()
            .contains("hello"));
    }

    #[test]
    fn osc_title_progress_and_resize_are_kept_in_the_shared_model() {
        let mut model = TerminalModel::default();
        model.process(b"\x1b]2;pi pane\x07\x1b]9;4;3;50\x07ready");
        let snap = model.snapshot();
        assert_eq!(snap.title, "pi pane");
        assert_eq!(snap.progress, "3;50");
        assert_eq!(snap.cwd, "");
        assert!(snap.text.contains("ready"));
        model.set_size(24, 200);
        model.process("x".repeat(150).as_bytes());
        assert!(model.snapshot_html().html.contains(&"x".repeat(150)));
        /* the hot tick snapshot skips html: runtime detection reads text,
        title, and progress only */
        assert!(model.snapshot().html.is_empty());
    }
}

#[cfg(test)]
mod probe_row_preservation {
    use super::*;

    /* a mirror screen must be a screen: every row of the grid present, in
    order, including the blank ones an agent just cleared. A dump that
    drops or collapses rows is content loss, not a rendering quirk. */
    #[test]
    fn a_dump_keeps_every_row_of_the_grid() {
        let mut m = TerminalModel::new(6, 20);
        m.process(b"one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix");
        let html = m.snapshot_html().html;
        let rows: Vec<&str> = html.split('\n').collect();
        assert_eq!(rows.len(), 6, "row count drifted: {rows:?}");
        assert_eq!(rows[0], "one");
        assert_eq!(rows[5], "six");
    }

    #[test]
    fn a_cleared_middle_keeps_its_rows() {
        let mut m = TerminalModel::new(6, 20);
        m.process(b"one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix");
        m.process(b"\x1b[3;1H\x1b[2K\x1b[4;1H\x1b[2K");
        let html = m.snapshot_html().html;
        let rows: Vec<&str> = html.split('\n').collect();
        assert_eq!(rows.len(), 6, "a cleared row collapsed the dump: {rows:?}");
        assert_eq!(rows[1], "two");
        assert_eq!(rows[2], "");
        assert_eq!(rows[3], "");
        assert_eq!(rows[4], "five");
    }

    #[test]
    fn leading_blank_rows_are_kept_so_the_height_is_stable() {
        let mut m = TerminalModel::new(6, 20);
        /* a TUI that homes the cursor and draws from the middle: the rows
        above it stay blank, and the mirror must still be 6 rows tall or
        the phone's scroll offset moves on every frame */
        m.process(b"\x1b[4;1Hbottom line");
        let html = m.snapshot_html().html;
        let rows: Vec<&str> = html.split('\n').collect();
        assert_eq!(rows.len(), 6, "leading blanks were dropped: {rows:?}");
        assert_eq!(rows[3], "bottom line");
        assert!(rows[..3].iter().all(|r| r.is_empty()));
    }
}
