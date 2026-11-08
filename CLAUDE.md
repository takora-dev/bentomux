# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite dev server at http://localhost:5173 (frontend only)
npm run build        # Vite build -> out/renderer/ (main + approval windows)
npm run preview      # Preview built frontend
npm run typecheck    # tsc --noEmit (checks src/src/**/*.ts, src/shared/**/*.ts)
npx tsc --noEmit --skipLibCheck  # alternate typecheck

# Tauri (requires Rust toolchain)
npm run tauri dev    # Full app: Vite + Rust backend + WebView
npm run tauri build  # Production bundle (dmg/app/nsis/msi)
cargo check --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml

# Backend unit tests — use this instead of bare `cargo test`:
npm run test:backend # cargo test --lib + Windows comctl32-v6 manifest for the harness
```

No linter or formatter is configured. On Windows a bare `cargo test` links a
harness that dies at load (STATUS_ENTRYPOINT_NOT_FOUND: the binary imports
`comctl32!TaskDialogIndirect` via rfd but has no Common-Controls-v6 manifest);
`npm run test:backend` wraps the working invocation (see
`src-tauri/build.rs`).

## Architecture

Bentomux is a desktop app for managing AI agent runtime workspaces. This repo (`Bentomux-v2/`) is a **Tauri 2 port** of the original Electron app at `../Bentomux/` — keep parity 1:1, do not redesign or add features. The migration is complete: `../Bentomux/` is now the reference for behaviour, not a parallel codebase to keep in step.

**One deliberate exception:** the plugin platform (`docs/PLUGIN_PLATFORM.md`) is a new feature and a new architecture layer, added alongside the existing UI rather than replacing it. It knowingly breaks the parity rule — see `docs/adr/0002-parity-rule-amended.md`. Do not "fix" it back to parity.

### Stack

- **Frontend:** Vanilla TypeScript + Vite, xterm.js (`@xterm/xterm` + `addon-fit`/`addon-web-links`), Shiki for highlighting. No framework.
- **Backend:** Rust + Tauri 2.1, `tokio` (full), `portable-pty`, `sysinfo`, `notify`, `axum` (ws), `rfd` (native folder picker), `serde`/`serde_yaml`/`toml`.
- **Build:** Vite builds two pages to `out/renderer/`; Tauri loads `http://localhost:5173` in dev, `../out/renderer` in prod (`src-tauri/tauri.conf.json`).

### Project Layout

```
src/                    # Vite root
  index.html            # Main window entry
  approval.html         # Always-on-top approval overlay window
  src/                  # Renderer TS modules (vanilla TS, alias @/ -> src/src/)
  shared/               # Types + split-tree logic shared with backend
  preload/              # Legacy type stubs (Tauri uses direct invoke, not contextBridge)
src-tauri/
  src/                  # Rust backend (see below)
  capabilities/default.json  # Window + permission grants (main + approval-overlay)
  tauri.conf.json       # App config, bundle, windows, resources
  tauri.windows.conf.json  # Windows overlay: frameless main window (decorations:false)
  tauri.linux.conf.json    # Linux: transparent frameless window + app controls + CSS rounded corners
  build.rs              # tauri-build
  icons/                # App icons
resources/
  bentomux-hook.cjs     # Agent hook CLI (bundled as resource)
  remote-page.html      # Remote monitor page
installers/             # install.sh / install.ps1 / install.cmd one-liners for releases
scripts/                # release-manifest.mjs (latest.json + Homebrew cask), verify-installer.{sh,ps1}
out/renderer/           # Vite build output (gitignored, frontendDist)
vite.config.ts          # root: src/, two rollup inputs (main + approval), @ alias
tsconfig.json           # ES2022/ESNext, bundler resolution, strict
```

### Frontend (Renderer)

Plain TS modules in `src/src/` — no bundled framework. Two windows share the same Vite build via `rollupOptions.input`. Communicates with Rust via `invoke()` / `listen()` from `@tauri-apps/api`. Path alias `import ... from '@/...'` resolves to `src/src/`.

### Backend (Rust) — `src-tauri/src/`

| Module | Role |
|--------|------|
| `lib.rs` / `main.rs` | Tauri builder setup: registers `AppStateManager`, `PtyManager`, `WindowMaxState`; inits `git::init_watch`, `runtime::init`, `bridge::start_bridge`; tracks maximize state via `AtomicBool` + `win:maximized` event |
| `state.rs` | Persisted app state at `app_data_dir/bentomux.json` — Rust port of `src/main/store.ts`. All structs use `#[serde(rename_all="camelCase")]` for exact JSON compat with Electron's `bentomux.json` |
| `commands.rs` | Tauri `#[tauri::command]` handlers — sole renderer-to-backend API |
| `pty.rs` | PTY management via `portable-pty` |
| `pty_host.rs` | Persistent PTY daemon (`bentomux --pty-host`): owns every pty master so panes outlive the app process, plus the reconnect protocol the app client speaks |
| `shell.rs` | Shell spawning helpers |
| `split_tree.rs` | Pane layout tree (ported from `src/shared/split-tree.ts`) |
| `detect/` | Agent state detection: `manifests.rs`, `rules.rs`, `screen.rs` (screen buffer parsing, YAML/TOML agent configs) |
| `agents/` | Agent integrations: `claude_code.rs`, `generic.rs`, `pi.rs`, `resources.rs`, `types.rs`, `util.rs` |
| `bridge.rs` + `bridge_config.rs` | Approval bridge: Unix socket that managed agent hooks write `PermissionRequest`s to |
| `agent_hooks.rs` | Hook wiring for agents |
| `git.rs` | Git file watching via `notify` |
| `overlay.rs` | Approval overlay window management (`OverlaySize`) |
| `remote.rs` | Remote monitor (axum ws + `tokio-tungstenite`, QR via `qrcode`, `local-ip-address`) |
| `runtime.rs` | Headless screen feed + process poller (`sysinfo`) |

Identifier: `app.bentomux.desktop`. Capabilities: `core:default`, `core:window:default`, `core:event:default` for windows `main` and `approval-overlay` (`src-tauri/capabilities/default.json`). CSP is **on** and strict (`src-tauri/tauri.conf.json` → `app.security.csp`): `default-src 'self'`, no `unsafe-eval`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`. Plugin origins are added to `script-src`/`style-src`/`connect-src` by `scripts/gen-plugin-csp.mjs`, which CI checks — a new plugin origin means regenerating that list, not editing the config by hand. `style-src` carries `'unsafe-inline'` because xterm and Shiki set inline styles; `npm run check:csp-inline-styles` guards that.

### Conventions

- Terminal panes are owned by the pty host daemon (`src-tauri/src/pty_host.rs`),
  not the app process — quitting leaves agents running on purpose. Never kill
  panes on `ExitRequested`; `app_quit(stopPanes=true)` is the explicit escape
  hatch. The daemon protocol is versioned (`pty_host::PROTOCOL_VERSION`): bump
  it whenever a message shape changes, and the app will replace a stale daemon
  on the next launch.
- Persisted JSON on disk must stay `camelCase` — serde renames are load-bearing for existing `bentomux.json` files.
- Work only in `Bentomux-v2/`; do not modify `../Bentomux/` (original Electron source).
- Rust style: explicit error types, no TODOs, no skipped error handling.
- CI gates on `npm run typecheck`, `npm run test:ts`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `npm run test:backend`. Run those five before pushing; a warning is a failure.

### Importing Other Agent Configs

If `~/.codex/config.toml`, `./.codex/`, `~/.gemini/settings.json`, `./.gemini/` or `GEMINI.md` exist, offer to import: reply `/import` to scan (MCP servers, slash commands, subagents, skills, instructions), then `/import --yes=<digest>` to apply. Or run `claude import` from a terminal if `/import` is unavailable.
