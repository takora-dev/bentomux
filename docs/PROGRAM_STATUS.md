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
ConPTY. What survives is measured, not assumed, by
`pty::tests::test_windows_conpty_strips_the_mouse_mode_switches` and
`pty::tests::test_windows_conpty_records_whether_a_mouse_report_arrives`:

- **ConPTY drops the mouse-mode switches** (`?1000h`, `?1002h`, `?1003h`,
  `?1006h`) from the program's output, so xterm never learns that the program
  wants mouse reports and never sends one. Every build tested does this. Focus
  reporting (`?1004h`) survives, which is what marks a program as owning the
  screen; a program that tracks the mouse without asking for focus is
  recognised by its mouse-mode request.
- **The alternate screen** (`?1049h`) is not a reliable signal and nothing is
  decided from it: conhost on Windows 10/11 strips it, the newer conhost on the
  CI runner forwards it. A fullscreen program therefore stays in xterm's normal
  buffer on some builds and gets a real alternate screen on others, and its
  redraws land in the scrollback either way. The test prints which one it saw
  instead of failing on it.
- **Whether the input path would carry a mouse report** is also a property of
  the build: the conhost this was first measured on drops SGR and X10 both, the
  newer one delivers them. That does not move the renderer, because a report is
  only sent by a client that saw the program's switch, and no build forwards
  that switch. The test prints what the build did and fails only when the pipe
  itself is broken.

The renderer answers with keys instead, since those ConPTY does deliver:

- **A wheel gesture** over a pane whose program owns the screen becomes Page
  Up / Page Down (`\x1b[5~` / `\x1b[6~`), at most one page per 60 ms. That
  relies on the program binding those keys: Pi does
  (`tui.altScreen.pageUp` / `pageDown`, and `tui.editor.pageUp` / `pageDown`
  outside fullscreen), and codex carries `page_up` / `page_down` bindings too.
  A program that binds neither ignores the key, which leaves that pane exactly
  as it was before — not scrollable by mouse, and no worse. The gate is a
  platform test on Windows, not a measurement, so the fallback has to go if
  ConPTY ever starts forwarding the mouse-mode switches: the assertion in
  `test_windows_conpty_strips_the_mouse_mode_switches` is the tripwire, and it
  fails with that instruction when it fires.
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
