<div align="center">
    <img src="assets/bentomux.png" alt="Bentomux logo" width="128">
  <h1>Bentomux</h1>
</div>

Bentomux a customizable desktop companion that brings AI agents, development tools, and productivity features into one cozy workspace.

<img src="assets/screenshot.png" alt="Bentomux screenshot — split-pane terminals with an agent runtime and a plain shell" width="100%">

## Features

**Workspaces & Terminals**
- Project-based workspaces with persistent state
- Multiple terminal tabs with split right/down layouts
- Configurable shells and terminal settings

**Git**
- Branch and file status monitoring
- Changes and per-file diffs

**AI Agents**
- Live agent status per terminal
- Support for multiple AI coding agents

**Plugins**
- Extend the workspace with plugins like **Kanban, To-Do, and Pomodoro** etc
- Support for custom and future plugins

**Remote Access**
- Access and control your workspace from mobile
- Monitor terminals and AI agents remotely
- QR-code pairing

**Cozy Workspace**
- Light/dark themes and custom palettes
- Custom backgrounds and layouts
- Personalizable workspace settings

## Install

```sh
# macOS / Linux / WSL2
curl -fsSL https://bentomux.netlify.app/install.sh | sh
```

```powershell
# Windows PowerShell
powershell -ExecutionPolicy Bypass -c "irm https://bentomux.netlify.app/install.ps1 | iex"
```

Where policy or endpoint security blocks PowerShell running straight from the internet:

```bat
curl.exe -fsSLo install.cmd https://bentomux.netlify.app/install.cmd && install.cmd && del install.cmd
```

```sh
# Homebrew
brew install takora-dev/tap/bentomux
```

Every installer reads the release manifest (`releases/latest/download/latest.json`), downloads the build for your platform and refuses to install it unless the SHA-256 matches. The builds are not signed or notarized yet, so macOS may ask you to confirm the first launch under System Settings → Privacy & Security.

## Getting started

### Requirements

- Node.js and npm
- Rust and Cargo for the Tauri application
- A supported desktop platform: macOS, Windows, or Linux

### Development

```sh
npm install
npm run tauri dev
```

`npm run dev` starts the Vite frontend only. Use `npm run tauri dev` to run the complete desktop application with the Rust backend.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the Vite frontend at `http://localhost:5173` |
| `npm run build` | Build the two frontend pages to `out/renderer/` |
| `npm run preview` | Preview the built frontend |
| `npm run typecheck` | Run TypeScript type checking with `tsc --noEmit` |
| `npm run tauri dev` | Run the complete Tauri desktop application |
| `npm run tauri build` | Build distributable Tauri bundles |
| `npm run test:release` | Check the release manifest and Homebrew cask generator |
| `npm run test:installer` | Install into a throwaway prefix from a fixture manifest |
| `cargo check --manifest-path src-tauri/Cargo.toml` | Check the Rust backend |

There is currently no configured JavaScript test runner, linter, or formatter.

## Architecture

```
src/                          # Vite frontend root
  index.html                  # Main window entrypoint
  approval.html               # Approval overlay entrypoint
  src/                        # Vanilla TypeScript renderer modules
    views/                    # Terminal, Git, diff, agents, settings, remote, and tabs views
    components/               # Shared UI components
    highlight/                # Shiki syntax highlighting
  shared/                     # Types and split-tree logic shared with Rust
  preload/                    # Legacy type stubs retained for compatibility
src-tauri/
  src/                        # Rust Tauri backend
    state.rs                  # Persisted application state
    commands.rs               # Renderer-to-backend Tauri commands
    pty.rs                    # PTY session management
    git.rs                    # Git watching and operations
    runtime.rs                # Process polling and runtime status
    bridge.rs                 # Agent approval bridge
    overlay.rs                # Approval overlay window management
    remote.rs                 # HTTP/WebSocket remote monitor
    agents/                   # Agent integrations and resource management
    detect/                   # Screen parsing and manifest rules
  capabilities/default.json  # Window and event permissions
  tauri.conf.json             # Tauri windows, bundles, and resources
resources/
  bentomux-hook.cjs            # Agent hook CLI
  remote-page.html             # Remote monitor page
vite.config.ts                # Two-page Vite build configuration
```

The renderer communicates with Rust through Tauri `invoke()` commands and `listen()` events. Rust owns PTYs, Git watching, persisted state, runtime detection, approval handling, and the remote monitor. Persisted state stays compatible with the existing Bentomux JSON format and uses camelCase keys.

## Building

```sh
npm run build
npm run tauri build
```

Tauri bundles macOS (`dmg`, `app`), Windows (`nsis`, `msi`), and Linux targets supported by the local toolchain. The agent hook and remote monitor page are bundled as application resources.

## Development notes

- Work in this repository only; the original Electron application is in the sibling `../Bentomux/` directory.
- `out/renderer/` is generated build output and is not source code.
- The frontend is intentionally kept close to the Electron version while backend responsibilities migrate to Rust.
- Persisted state must remain camelCase so existing `bentomux.json` files continue to load correctly.

## License

MIT — see [LICENSE](LICENSE).
