# Program-reported terminal status

Bentomux accepts root-program status through OSC 7501. This is independent of
spinner characters, loading text, and terminal layout; no agent-specific parser
or extension is required when the program already supports the protocol.

## Negotiation and reports

A program sends `ESC ]7501;? ESC \\`. The persistent PTY host replies on the
program's input with `ESC ]7501;?:states=idle,working,done,blocked,error ESC \\`,
even when no app window is attached.

Example report (shown with shell escapes):

```sh
printf '\033]7501;state=working:app=my-agent\033\\'
```

Reports accept BEL or ST termination. Fields are colon-separated:

- `state`: `idle`, `working`, `done`, `blocked`, `error`, or `clear`.
- `app`: optional identifier, 1–32 ASCII letters/digits or `_.+-`.
- `kind`: optional classification of a blocked activity.
- `msg`: optional base64-encoded UTF-8 message, at most 2048 decoded bytes.
- A nonempty `id` denotes a child record and does not replace the pane status.

Malformed reports are ignored. OSC buffering is capped at 8192 bytes; oversized
sequences are discarded through their terminator. Decoded messages containing
control characters are rejected. Reports are display metadata, not authorization
or proof that a task succeeded.

## Runtime behavior

Precedence is existing bridge integration, then OSC status, then the existing
screen-manifest/activity fallback. Ordinary terminal output does not expire an
explicit status. A `clear` report restores fallback detection. Shell integration
markers for a new prompt or command completion (OSC 133 A/D) clear the previous
program report; pane exit removes the app's snapshot cache.

Known agents still require a matching live process. An unregistered program can
supply its own `app` identity while there is a live child beneath the pane shell.
For reliable lifetime handling, programs should clear their report before exit
or use a shell that emits OSC 133 markers. A silent program exit followed by an
unrelated command cannot always be distinguished for unregistered programs.

The current UI has three states: `working` remains working, `blocked` and `error`
map to blocked, and `idle` and `done` map to idle. The original report and metadata
remain in the terminal snapshot. `done` describes a completed run, not necessarily
a completed user task.

The daemon owns the status alongside the terminal model, so reconnecting clients
receive it in snapshots without requiring the program to emit it again. This
snapshot change uses PTY-host protocol version 8. Agent releases without OSC 7501
support continue to use their existing detection rules. Programs already running
without protocol negotiation may need to be restarted to enable reporting.
