//! Program-reported terminal state (OSC 7501), independent of screen rendering.

use base64::Engine;
use serde::{Deserialize, Serialize};

pub const MAX_OSC_BYTES: usize = 8192;
pub const CAPABILITIES: &[u8] = b"\x1b]7501;?:states=idle,working,done,blocked,error\x1b\\";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProgramState {
    Idle,
    Working,
    Done,
    Blocked,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProgramStatus {
    pub state: ProgramState,
    pub app: Option<String>,
    pub kind: Option<String>,
    pub message: Option<String>,
}

#[derive(Default)]
pub struct StatusProtocol {
    pub status: Option<ProgramStatus>,
    pub query_pending: bool,
    pub discarding_osc: bool,
}

impl StatusProtocol {
    pub fn handle(&mut self, payload: &str) {
        if payload == "?" {
            self.query_pending = true;
            return;
        }
        if payload.len() > MAX_OSC_BYTES || payload.chars().any(char::is_control) {
            return;
        }
        let mut fields = std::collections::HashMap::new();
        for field in payload.split(':') {
            let Some((key, value)) = field.split_once('=') else {
                return;
            };
            if fields.insert(key, value).is_some() {
                return;
            }
        }
        // Named records describe child activities, not the pane's root program.
        if fields.get("id").is_some_and(|id| !id.is_empty()) {
            return;
        }
        let state = match fields.get("state").copied() {
            Some("idle") => ProgramState::Idle,
            Some("working") => ProgramState::Working,
            Some("done") => ProgramState::Done,
            Some("blocked") => ProgramState::Blocked,
            Some("error") => ProgramState::Error,
            Some("clear") => {
                self.status = None;
                return;
            }
            _ => return,
        };
        let app = fields.get("app").copied();
        if app.is_some_and(|app| {
            app.is_empty()
                || app.len() > 32
                || !app
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.+-".contains(&b))
        }) {
            return;
        }
        let message = if let Some(encoded) = fields.get("msg") {
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
                return;
            };
            let Ok(text) = String::from_utf8(bytes) else {
                return;
            };
            if text.len() > 2048 || text.chars().any(char::is_control) {
                return;
            }
            Some(text)
        } else {
            None
        };
        self.status = Some(ProgramStatus {
            state,
            app: app.map(str::to_owned),
            kind: fields.get("kind").map(|s| (*s).to_owned()),
            message,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_programs_without_an_agent_registry() {
        let mut protocol = StatusProtocol::default();
        for app in ["pi", "claude-code", "custom-agent"] {
            protocol.handle(&format!("state=working:app={app}:msg=SGVsbG8="));
            let status = protocol.status.as_ref().unwrap();
            assert_eq!(status.app.as_deref(), Some(app));
            assert_eq!(status.message.as_deref(), Some("Hello"));
            assert_eq!(status.state, ProgramState::Working);
        }
        protocol.handle("state=clear");
        assert!(protocol.status.is_none());
    }

    #[test]
    fn invalid_and_child_reports_preserve_root_status() {
        let mut protocol = StatusProtocol::default();
        protocol.handle("state=working");
        let previous = protocol.status.clone();
        for payload in [
            "state=unknown",
            "state=idle:id=child",
            "state=idle:app=bad/name",
            "state=idle:msg=bad!",
            "state=idle:msg=Cg==",
            "state=idle:msg=/w==",
            "state=idle:state=error",
            "state=idle:kind=bad\n",
            "broken",
        ] {
            protocol.handle(payload);
            assert_eq!(protocol.status, previous, "{payload}");
        }
        protocol.handle(&format!("state=idle:extra={}", "x".repeat(MAX_OSC_BYTES)));
        assert_eq!(protocol.status, previous);
    }
}
