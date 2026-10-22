# Terminal renderer: stay on xterm.js for now; a full-Rust UI is possible but is a rewrite

Date: 2026-10-22

## Context

Bentomux renders every pane with @xterm/xterm 6.0.0 (FitAddon, WebLinksAddon) in the
Tauri WebView, fed by a Rust `portable-pty` backend (see `src/src/views/terminal.ts`,
`src-tauri/Cargo.toml`). The user has hit occasional renderer crashes that require
restarting the whole app. Two questions: are there alternatives, and can the terminal
be rendered in pure Rust with no JS/TS frontend at all?

## Findings (verified 2026-10-22 against primary sources)

### xterm.js status and known instability

- `xtermjs/xterm.js`: MIT, not archived, last push 2026-10-13, npm `@xterm/xterm`
  latest 6.0.0 published 2026-10-13. Actively maintained. Sources:
  https://api.github.com/repos/xtermjs/xterm.js ,
  https://registry.npmjs.org/@xterm%2Fxterm
- WebGL renderer (`@xterm/addon-webgl`, webgl2 canvas) and renderer lifecycle have
  open bugs matching "render is crash / blank / needs restart" symptoms:
  - #6063 (open, 2026-09-18): `Buffer.resize` can leave viewport rows with no live
    `BufferLine` when growing rows with `ybase > 0` — uncaught TypeErrors in
    `lineFeed`/`_eraseInBufferLine`. https://github.com/xtermjs/xterm.js/issues/6063
  - #6239 (open, 2026-10-17): terminal blank for a frame when renderer set while
    render service paused. https://github.com/xtermjs/xterm.js/issues/6239
  - #6238 (open, 2026-10-16): WebGL `clearTextureAtlas()` silent no-op.
    https://github.com/xtermjs/xterm.js/issues/6238
  - #6068 (open, 2026-08-22): `WebglAddon.dispose()` does not release the WebGL2
    context — long sessions accumulate GPU contexts. https://github.com/xtermjs/xterm.js/issues/6068
  - #5114 (closed): long-running output crashes the browser; #4368 (closed): macOS
    Chrome crashes with heavy output. Both match "PTY stream crashes renderer".
- Note: Bentomux does not use the WebGL addon today; the default is the DOM/canvas
  mixed renderer. Crashes are therefore in the core renderer, not the GPU addon —
  but the WebGL addon is the common workaround people reach for, and it has its own
  context-leak bugs (above).

### Alternatives for a WebView-hosted terminal

- **hterm** (Chromium terminal): repo `chromium/hterm` is archived (last push
  2022-06-29). Not viable. https://api.github.com/repos/chromium/hterm
- **No maintained xterm.js fork** of comparable maturity was found. VS Code, Hyper,
  and Theia all still consume xterm.js itself.
- Conclusion: inside a system WebView, xterm.js is effectively the only mature option.
  Any "alternative" in-DOM renderer means writing one from scratch on top of a VT
  parser — that is a new project, not a migration.

### Full-Rust rendering (no JS/TS)

- **Tauri cannot drop its system WebView.** The window and IPC are built on
  WKWebView/WebView2/WebKitGTK; there is no supported headless/native-UI mode
  (see tauri.conf.json usage in this repo; upstream discussions like
  tauri-apps/tauri#14963 "Bundle chromium renderer" confirm WebView is core).
  So "Tauri but pure Rust UI" is a contradiction; the app would need a new shell.
- Viable pure-Rust stacks, all active as of 2026-10:
  - **egui** 0.32.x (2026-10-15 update, GPU-rendered, immediate mode).
  - **iced**, **slint**, **dioxus** — also active, but none ship a terminal widget.
  - Terminal *emulation* crates (state machines, not renderers):
    - `alacritty_terminal` 0.26.0 (2026-04-06; library extracted from Alacritty;
      provides `Term`, grid, damage iterators; license Apache-2.0).
      https://crates.io/crates/alacritty_terminal ,
      https://github.com/alacritty/alacritty/tree/master/alacritty_terminal
    - `vte` 0.15.0 (2025-02-02; ANSI/VT parser, 86M downloads, used by wezterm).
      https://crates.io/crates/vte
  - None of these render anything. Alacritty's own GPU renderer (`alacritty` binary)
    is tied to winit/wgpu and is a whole application, not an embeddable widget.

### Migration cost

- Swap in another WebView-hosted terminal: **not available** — no viable substitute.
- Pure-Rust rewrite (egui/iced + alacritty_terminal + portable-pty): **large rewrite**.
  Everything Vue-less but DOM-based today (splits, tabs, sidebar, plugins, settings,
  Shiki, marketplace UI) lives in TS/CSS. ADR-0001/0003's plugin platform explicitly
  depends on the JS realm: plugins run as ES modules in the WebView and contribute
  real DOM. A native-Rust UI breaks the entire plugin architecture, not just the pane.

## Decision

Stay on xterm.js. Mitigate crashes instead of migrating:

1. Wrap `term.write()` / terminal callbacks in try/catch and recreate the xterm
   instance (or the pane) on renderer exception instead of requiring an app restart.
   Issue #6063 shows the crash is an uncaught TypeError during buffer ops — a pane-level
   recovery catches it. (The state.ts/updates.ts already persist PTY-side state;
   reconnect the PTY to the new instance.)
2. Do not adopt the WebGL addon as a "fix"; it trades crashes for GPU-context leaks
   (#6068) until upstream fixes it.
3. Track #6063 and #6239; both were open against 6.0.0, the version Bentomux uses.

## Consequences

- Renderer crashes remain possible until upstream fixes #6063/#6239, but they become
  pane-level, recoverable events rather than app restarts.
- A future pure-Rust UI (egui + alacritty_terminal + portable-pty) is feasible and
  actively maintained upstream, but implies abandoning the Tauri WebView, the entire
  TS frontend, and the in-realm plugin platform (ADR-0001/0003). That is a new major
  version of Bentomux, not a dependency swap.

## Addendum (same date): coder/ghostty-web — the one real alternative

The original conclusion ("no in-WebView alternative") was missing one project:
[coder/ghostty-web](https://github.com/coder/ghostty-web). Verified facts:

- MIT, 2,983 stars, last push 2026-10-15, active issue triage. Sources:
  https://api.github.com/repos/coder/ghostty-web
- What it is: Ghostty's terminal emulator compiled to WASM, driving a
  canvas renderer, shipped with an **xterm.js-compatible API** — migration is
  meant to be "change your import from `@xterm/xterm` to `ghostty-web`"
  plus an `await init()` (WASM load). Zero runtime dependencies, ~400KB WASM.
  https://raw.githubusercontent.com/coder/ghostty-web/main/README.md
- Ships its own FitAddon (xterm.js API compatible, included; no separate package).
  Link detection is built in (OSC 8 + URL), so WebLinksAddon is replaced too.
  Source: `lib/addons/fit.ts`, `lib/link-detector.ts` in the repo.

### Gaps vs Bentomux's current usage

- `term.options.theme = ...` **after** open() is silently ignored (console.warn,
  "not yet fully supported") — `lib/terminal.ts` case 'theme'. Bentomux swaps
  themes on live panes (`terminal.ts:79`, `terminal.ts:585`), so palette changes
  would need pane recreation or an upstream fix.
- Open API-compat bugs as of 2026-10-10..16: `translateToString`/`getChars`
  return '' for empty cells (#205), Alt+key sends no ESC prefix (#203),
  Ctrl+C-with-selection sends ^C instead of copying on Linux/Windows (#204).
- Open rendering bugs: full repaint every frame at fractional devicePixelRatio with
  seams between cells (#198); `term.write('')` throws (#199). #198 is close to the
  class of problem we are trying to escape.
- youngest stable release 0.4.0 is 2025-12-09; 81 published versions exist but
  development is `next`-channel heavy. Version history:
  https://registry.npmjs.org/ghostty-web , CHANGELOG.md in the repo.
- Young project (first release 2025-11-13). It builds Ghostty's WASM from source
  with a small patch; upstream `libghostty` is expected to shrink that patch
  (README, Mitchell Hashimoto's libghostty writeup).

### Assessment

ghostty-web is a credible migration target — same API shape, real emulation engine,
active maintainer (Coder), and it exists precisely because of xterm.js's renderer
bugs. But it does not yet meet Bentomux's needs: live theme swaps are unsupported,
three input/API-compat bugs touch code paths Bentomux exercises (selection copy,
Alt meta keys), and issue #198 is itself a renderer artifact. It is young; xterm.js
has 21k stars and a decade of hardening.

Revised guidance: keep ADR-0005's decision (stay on xterm.js + pane-level recovery)
as the default, and track ghostty-web as the escape hatch. Re-evaluate after:
(a) theme-after-open() is supported, (b) #198/#199/#203/#204/#205 are fixed and in
a stable release, and (c) it ships at least one further stable release. If xterm.js
crashes persist past the pane-recovery mitigation, a pilot swap of one pane behind a
compatibility wrapper (both libraries behind `src/src/views/terminal.ts`'s helper
functions) is a medium-size change, not a rewrite.

## What we gave up

The first version of this ADR said no in-WebView alternative existed; ghostty-web
corrects that. What remains true: no alternative has xterm.js's maturity, and the
full-Rust rewrite path (above) is unchanged.
