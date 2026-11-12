# Terminal renderer: WebGL addon as the default, DOM renderer as the fallback

Date: 2026-11-12

## Context

Bentomux renders every pane with `@xterm/xterm` 6.0.0 in the Tauri WebView, fed by a
Rust `portable-pty` backend (`src/src/views/terminal.ts`). Users reported the app
burning roughly half a core while the interface looked idle.

xterm 6.0.0 ships **only** the DOM renderer. There is no canvas renderer in the core
package (`node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts:584` creates a
`DomRenderer`). The DOM renderer rebuilds the painted rows as real DOM nodes, one
`<span>` per cell, every frame
(`node_modules/@xterm/xterm/src/browser/renderer/dom/DomRendererRowFactory.ts:172`),
and the WebView then re-lays-out and re-paints that text through WebCore.

A `sample` of the production WebContent process confirmed this is the hot path, not
JavaScript:

```
76.5%  WebCore Layout+Paint   (RenderBlock::layout, RenderBlock::paint,
                              RenderLayer::paintLayerContents, WidthIterator::advance)
12.9%  WebCore other
 2.3%  JSC (JavaScript engine)
```

After swapping in the WebGL addon, WebCore layout and paint no longer appear in the
profile at all; the process falls to idle wait and IPC.

The previous renderer decision, ADR-0005, was written on 2026-10-22 and deliberately
**did not** adopt the WebGL addon, because upstream issue #6068 reported that
`WebglAddon.dispose()` does not release the WebGL2 context. ADR-0005 was later
deleted in `7135e20` ("intentional") and no replacement record was left behind, so
this decision had no standing record to contradict.

## Findings (verified 2026-11-12 against primary sources)

### Version drift in the repository

The version fields read `0.2.57` while tags through `v0.2.76` had already been cut.
The same drift was fixed once before, in `0d91fa9`, which bumped all five version
fields together. The repo has no guard that keeps them in sync, and
`.github/workflows/build.yml` only rewrites `src-tauri/tauri.conf.json` from the tag
name, so `package.json` and `src-tauri/Cargo.toml` keep whatever they last had.

Note: the plugin manifest field `minAppVersion` is only ever validated as well-formed
semver (`src-tauri/src/plugin/validate.rs:567-574`). No code path compares it against
the running app's version, so the drift did not gate plugin installs. The number the
user sees in Settings comes from `getVersion()` (`src/src/updates.ts:74`), which Tauri
reads from `tauri.conf.json`.

### xterm.js status and the WebGL addon's own open bugs

- `@xterm/xterm` latest is still **6.0.0**; the 6.1 line is beta only
  (`6.1.0-beta.337`).
- `@xterm/addon-webgl` latest is still **0.19.0**; the 0.20 line is beta only
  (`0.20.0-beta.330`).
- **0.19.0 is the only stable pairing**: it was published in the same batch as xterm
  6.0.0. Every `0.20.0-beta.*` requires `@xterm/xterm ^6.1.0-beta.331` or newer as a
  peer dependency, so adopting it would mean adopting a beta of both.
- `@xterm/addon-canvas` is not an option: its last release (0.7.0) declares
  `@xterm/xterm ^5.0.0`.

Open upstream issues against 6.0.0, re-checked against the GitHub API on 2026-11-12:

- **#6068 — closed 2026-10-29, milestone 7.0.0.** `WebglAddon.dispose()` does not
  release the WebGL2 context. The issue body carries a self-contained repro and names
  the workaround: reach into `addon._renderer._gl` and call
  `WEBGL_lose_context.loseContext()` after disposing. The reported failure is not the
  disposed terminal breaking — it is a **still-live** terminal losing its renderer once
  the browser's per-document live-context cap (~16, driver-dependent) is crossed.
  The issue is closed against 7.0.0, which is not released.
- **#6239 — open.** Terminal is blank for a frame when a renderer is set while the
  render service is paused.
- **#6238 — open.** `clearTextureAtlas()` is a silent no-op once atlas page 0's current
  texture is in use.
- **#6063 — open.** `Buffer.resize` can leave viewport rows with no live `BufferLine`.

### Why #6068 is reachable in Bentomux

The addon is created per terminal in `createXterm` (`src/src/views/terminal.ts:511`)
and the terminal is disposed when its tab closes
(`src/src/views/terminal.ts:739`, `disposeTerminal`). Opening and closing tabs
therefore creates and disposes a WebGL2 context each time. The issue is explicit
that this needs no leak in the embedder to trigger: the count that matters is the
**cumulative** number of created-and-disposed contexts, not the number of live panes.

### What the addon already handles

- **`minimumContrastRatio`** is applied when the texture atlas is built
  (`addon-webgl/src/TextureAtlas.ts:394-409`), i.e. once per glyph and cached, not
  per cell per frame as the DOM renderer does
  (`xterm/src/browser/renderer/dom/DomRendererRowFactory.ts:481-496`).
- **Synchronized output (DEC private mode 2026)** is handled by xterm core
  (`xterm/src/common/InputHandler.ts:1972, 2203, 2301`). Bentomux never emits it
  itself, and the measured `?2026h` / `?2026l` counts on a real agent stream were
  balanced (27 and 27).
- **A missing WebGL2 context** throws inside the renderer
  (`addon-webgl/src/WebglRenderer.ts:89-91`), which the loader catches.

### The renderer lifecycle on dispose

`AddonManager.loadAddon` snapshots `instance.dispose` before replacing it with its
own wrapper (`xterm/src/common/public/AddonManager.ts:26-31`), and the wrapper calls
that snapshot (`AddonManager.ts:51`). `WebglRenderer`'s teardown removes the canvas
from the DOM and drops the render layers but leaves the context alive
(`addon-webgl/src/WebglRenderer.ts:144-150`). The `gl` field is not nulled on
dispose, so the context can still be released afterwards — which is exactly what the
upstream workaround does.

## Decision

1. **Load the WebGL addon by default, with the DOM renderer as the fallback.**
   `@xterm/addon-webgl@0.19.0` is the only stable pairing with xterm 6.0.0. The
   addon is optional in the failure direction: if the WebGL2 context cannot be
   created, the loader catches the error and xterm keeps the DOM renderer it already
   installed at `open()`, so the pane behaves exactly as before.

2. **Release the WebGL2 context explicitly on dispose**, closing the half of #6068
   that is reachable from Bentomux. The loader wraps the addon's `dispose` so that
   `WEBGL_lose_context.loseContext()` runs after the addon's own teardown. The
   wrapper is installed **before** `term.loadAddon()`, because the addon manager
   snapshots `dispose` at load time; the context is looked up lazily at dispose time
   because it does not exist until `activate()` has run.

   The release runs in a `finally`, so a throwing teardown still frees the context —
   that release is the whole point of the wrapper. A missing context or a missing
   extension is not an error: the addon build without those private fields simply
   falls back to the old behaviour rather than crashing the pane.

3. **Fall back to the DOM renderer when the context is lost.** A driver reset or a
   sleeping machine can drop the context. xterm's DOM renderer is still installed, so
   the addon is disposed and the pane keeps painting instead of going blank.

4. **Sync the version fields to the release being cut.** `package.json`,
   `package-lock.json` (both the root and the `""` package entry),
   `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` are bumped together with
   `src-tauri/tauri.conf.json`, following the precedent set by `0d91fa9`. The
   repository still has no guard against this drift recurring.

   The bump to 0.2.77 is part of the same change because the renderer swap is what
   the release carries.

## Consequences

- The renderer's dominant cost moves off the CPU's layout and paint path and onto the
  GPU. On a controlled full-screen TUI workload (45x120, 10 frames/s, ~36 KB/s) the
  WebContent process fell from 19.73% to 7.17% average CPU, and the WebContent plus
  GPU total fell from 28.17% to 18.16%, at an unchanged event rate and byte stream.
- A pane on a machine without WebGL2 keeps the DOM renderer and its old cost. That is
  the intended trade: the addon is an optimisation, never a requirement.
- #6068 is mitigated, not fixed: the fix belongs in the addon and is queued for 7.0.0.
  The wrapper reaches into `addon._renderer._gl`, a private field, so an addon release
  that renames it would silently stop releasing the context. `loadGpuRenderer` treats
  a missing context as "nothing to release" rather than an error, so the failure mode
  is the old bug returning, not a crash.
- #6239 can still blank a pane for one frame when the renderer is set while the
  render service is paused. That window is narrow and self-correcting.
- The version fields are correct as of this commit but will drift again on the next
  release that forgets one of the five files.

## Verification

### The mitigation, measured in a real browser

Chrome 157, the published `@xterm/addon-webgl@0.19.0` build, and the exact code
path from `loadGpuRenderer`. Two arms, each in a freshly launched browser so that
one arm's leaked contexts cannot reach the other.

Arms that create and dispose a terminal 40 times, while one terminal stays open:

| Arm | The live terminal's context afterwards |
|---|---|
| addon loaded and disposed plainly | **`isContextLost() === true`** — the open pane lost its renderer |
| with the `loseContext()` wrapper | **`isContextLost() === false`** — the open pane is intact |

And the leak itself, counted over 20 create/dispose cycles:

| Arm | Contexts still alive after dispose |
|---|---|
| plainly | **20 of 20** |
| with the wrapper | **0 of 20** |

The wrapper reaches the context through `addon._renderer._gl`; both names survive in
the published `lib/addon-webgl.mjs` (it is a prebuilt bundle, not minified
TypeScript), and the chain is present in the production bundle
(`out/renderer/assets/main-*.js`).

### The gates

```
npm run typecheck                                  pass
npm run test:ts                                    11 passed
npm run test:renderer                              79 passed (9 files)
cargo fmt --manifest-path src-tauri/Cargo.toml --check    exit 0
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings   no issues
npm run test:backend                               311 passed
npm run build                                      ok
```

The renderer tests pin the contract around the addon: that it is loaded, that a
machine without WebGL2 still gets a working terminal, that a lost context falls back
to the DOM renderer, that a context loss after dispose is survivable, that the
context is released on dispose, that it is released even when the addon's own
teardown throws, and that an addon without the private fields is not a crash.

## What we gave up

The DOM renderer was the only path with no GPU dependency, and it remains reachable
as a fallback. Nothing else was given up: selection, copy, links, transparency, theme
swaps, resize, scroll and the alternate screen all behave the same under the WebGL
renderer, and the fallback keeps them working when the addon cannot start.
