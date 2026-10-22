# Addendum 2 to ADR-0005: vercel-labs/wterm

Second candidate for the terminal renderer, verified against the repo and npm on
2026-10-22. Read after ADR-0005 and its first addendum (ghostty-web).

## Verified facts

- Apache-2.0, 3,509 stars, pushed 2026-10-17, repo created 2026-04-14; latest
  @wterm/core, @wterm/dom and @wterm/ghostty 0.5.4 released 2026-09-29, steady
  0.5.x cadence, perf and fix PRs merged daily. Sources:
  https://api.github.com/repos/vercel-labs/wterm ,
  https://registry.npmjs.org/@wterm/core , repo releases page.
- Architecture is the strongest of the three candidates: pluggable cores behind a
  TerminalCore interface. Options: (a) built-in lightweight Zig-to-WASM core
  (~26 kB) covering VT100/VT220/xterm basics, or (b) @wterm/ghostty, full
  libghostty WASM for complete VT compliance (Kitty keyboard protocol,
  synchronized output mode 2026, OSC 7/10/11/52, grapheme clusters, DEC line
  drawing). Same interface either way. The renderer is DOM, not canvas: native
  selection, find, IME and accessibility come from the browser. Sources:
  packages/@wterm/core/README.md, packages/@wterm/ghostty/README.md.
- Extras that map to Bentomux workload: setRenderingPaused() for background
  panes (parsing continues, painting stops) matches the multi-pane agent use case
  exactly; term.fit() built in; write(), onData, resize(), onTitle and destroy()
  present; setThemeColors() supports live theme changes, which is the gap that
  disqualified ghostty-web. WebSocket transport with bounded backpressure exists,
  but Bentomux keeps its own portable-pty bridge and feeds write() directly.
- term.write(string | Uint8Array) accepts binary; current UTF-8-lossy string
  chunks (src-tauri/src/pty.rs decode_pty_bytes) work as-is, and a byte path can
  be added later without changing the renderer.
- Defect history matches real terminal apps: PRs #122/#121 fixed Ghostty WASM
  page-capacity crashes, precisely a renderer-crash-class bug (fixed in 0.5.x,
  closed 2026-09-30). Still open at check time: #246 cell measurement wrong under
  an ancestor CSS transform (Bentomux uses CSS transforms in split panes; impact
  unverified), #245 scroll-to-empty-space after clear with deep scrollback. The
  built-in core lacks grapheme clustering and reflows text on shrink (#236/#237),
  mitigated entirely by using the @wterm/ghostty core.

## wterm vs ghostty-web for Bentomux

| Axis | ghostty-web | wterm (@wterm/dom + @wterm/ghostty) |
|---|---|---|
| Emulator engine | Ghostty WASM | Built-in Zig core or libghostty WASM (selectable) |
| Renderer | Canvas | DOM (native selection/find/a11y) |
| Live theme change | No (ignored after open) | Yes (setThemeColors) |
| Background pane pause | No | Yes (setRenderingPaused) |
| Migration shape | Import-compatible with xterm.js | Different API, but small, documented surface |
| Maturity | 3k stars, stable 0.4.0 (2025-12) | 3.5k stars, stable 0.5.4 (2026-09); Vercel Labs experiment badge |
| Biggest risk | API-compat plus renderer bugs open | Labs-experiment status; DOM renderer perf unproven; CSS-transform bug open |

Update 2026-10-22 (later same day): the migration was executed. @wterm/dom plus
@wterm/ghostty 0.5.4 replaced @xterm/* in src/src/views/terminal.ts, and the
concerns above are now load-bearing choices: live theme via setThemeColors,
Shift+Enter mapped from CSI-u to a literal newline, file-paste staging, OSC
links opened through the opener plugin, and wallpaper transparency via the
--term-bg CSS override. Typecheck, Vite build, and the 300 backend tests pass.
The Labs badge still applies: versions are pinned and API churn is a watch item.

The case for wterm is real, but the Vercel Labs experiment badge is the project
itself signaling that support and API stability are not promises. Both candidates
stay behind xterm.js until the pilot below runs.

## Pilot (revised, replaces the ghostty-web-only plan in ADR-0005)

Same isolation strategy: a small API wrapper in src/src/views/terminal.ts
(write, onData, onResize, theme, fit, dispose) whose xterm.js implementation
ships now. Then a hidden experiment flag creates new panes on @wterm/dom plus
@wterm/ghostty (not the built-in core: missing grapheme clustering and reflow
are blockers). Exercise agent mode heavily, tmux, vim/htop, theme swaps
mid-session, and background panes with setRenderingPaused. Acceptance before any
switch: no page-capacity-class crashes over a week of real use, split-pane
transforms (issue #246) verified or fixed, memory comparable to or better than
xterm.js, and wterm leaving Labs or equivalent stability commitments.

## Rollback (2026-10-22, later)

The migration was rolled back. Reason: the renderer crashed outright in a
tauri dev session (window opens then exits), and while one contributing cause
was found and kept (the notify_permission UNUserNotificationCenter guard in
src-tauri/src/commands.rs — unrelated to wterm, kept because crash reports
proved it), the wterm + libghostty path did not reach a stable boot during the
session. Per the pilot acceptance bar (a week of real use, integration cost,
Labs status), xterm.js was restored: src/src/views/terminal.ts and main.ts
reverted to HEAD, @xterm/* deps reinstalled, @wterm/* removed.

The ADRs and this addendum stand as the evaluation record. If the wterm pilot
is retried, start from commit before 2026-10-22's migration attempt and land
it behind the wrapper with a runtime flag, one pane at a time.
