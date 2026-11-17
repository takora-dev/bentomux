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

On Windows, ConPTY may discard capability queries. New shells default
`PI_PROGRAM_STATUS=1` so Pi can report directly; an existing environment setting
is respected. Restart the pane to apply this setting.

On Windows the wheel is rebuilt from the parts of the terminal that survive
ConPTY. Both halves are measured, not assumed, by
`pty::tests::test_windows_conpty_strips_the_mouse_mode_switches` and
`pty::tests::test_windows_conpty_never_delivers_a_mouse_report`:

- **ConPTY drops the alternate screen** (`?1049h`) and the mouse-mode switches
  (`?1000h`, `?1002h`, `?1003h`, `?1006h`) from the program's output. A
  fullscreen program therefore stays in the normal buffer, and its redraws land
  in xterm's history rather than in a transcript of its own. Focus reporting
  (`?1004h`) survives, which is what marks a program as owning the screen; a
  program that tracks the mouse but never asks for focus is recognised by its
  mouse-mode request, which xterm does receive.
- **A mouse report never reaches the program**, in any shape: the console host
  parses the input stream and drops it. This is not a matter of which mouse
  mode is active, of the report format (SGR or X10), or of how the bytes are
  written. The same test sends a plain letter first, so the finding is about
  the report and not about a broken pipe.

The renderer answers with keys instead, since those ConPTY does deliver:

- **A wheel gesture** over a pane whose program owns the screen becomes Page
  Up / Page Down (`\x1b[5~` / `\x1b[6~`), at most one page per 60 ms. That
  relies on the program binding those keys: Pi does
  (`tui.altScreen.pageUp` / `pageDown`, and `tui.editor.pageUp` / `pageDown`
  outside fullscreen), and codex carries `page_up` / `page_down` bindings too.
  A program that binds neither ignores the key, which leaves that pane exactly
  as it was before — not scrollable by mouse, and no worse. The gate is a
  platform test on Windows, not a measurement, so if ConPTY ever forwards
  mouse input this fallback has to be removed rather than kept.
- **A click** on a clickable control becomes the key the program binds for the
  same action. Pi's "Jump to latest message" hint is `ctrl+end`
  (`tui.altScreen.bottom`), so clicking the hint sends `ctrl+end`.

Panning an ordinary shell's scrollback is left to xterm. One notch arrives as a
single `deltaY` 100 event on Windows and as dozens of 2-10 px events on a macOS
trackpad, so xterm's wheel sensitivity is 1 on Windows (≈5 rows a notch) and 3,
the trackpad value, everywhere else (≈14 rows a notch on Windows).

The current UI has three states: `working` remains working, `blocked` and `error`
map to blocked, and `idle` and `done` map to idle. The original report and metadata
remain in the terminal snapshot. `done` describes a completed run, not necessarily
a completed user task.

The daemon owns the status alongside the terminal model, so reconnecting clients
receive it in snapshots without requiring the program to emit it again. This
snapshot change uses PTY-host protocol version 9. Upgrading from an older daemon
replaces it and stops its existing panes; save any work before restarting the app.
Agent releases without OSC 7501 support continue to use their existing detection rules. Programs already running
without protocol negotiation may need to be restarted to enable reporting.
