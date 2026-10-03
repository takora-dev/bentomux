# Bentomux Plugin Platform

Governing spec for the "everything is a plugin" workstream. It supersedes the Non-Goals clause of `MIGRATION_TO_TAURI.md` for this workstream only (see `docs/adr/0002-parity-rule-amended.md`). Vocabulary is fixed in `CONTEXT.md` — read that first; the terms **Plugin**, **Contribution**, **Plugin Context**, and **Plugin Skill** have specific meanings here.

**Status:** designed, not built. Execution order lives in `.zcode/plans/plan-plugin-platform.md`.

---

## 1. Scope

**v1 delivers:** import and install from a folder or an HTTPS URL; enable, disable, update, roll back, uninstall; seven templates plus the Creator wizard; a static Validator with a CLI and an in-app surface; the `bentomux-plugin-author` Plugin Skill; a `--safe-mode` escape hatch.

**v1 does not deliver:** backend (Rust) contributions from plugins, a hosted registry, process isolation, theme/palette contributions, right-panel panels, or plugin-declared keyboard shortcuts. See §14.

---

## 2. Execution model

A plugin is a folder containing `plugin.json` and an ES module entry. The host loads the entry into the **main window's JavaScript realm** over a custom `plugin://` scheme and calls `activate(ctx)`. On disable it calls `deactivate()` and drops every contribution the plugin registered.

Two rules follow from this and are not negotiable in v1:

- **Permissions are a contract, not a security boundary.** Same-realm code shares the page's globals. The `ctx` facade exists so a plugin's intent is legible and statically checkable — not to contain a hostile plugin. See `docs/adr/0001-in-realm-plugin-execution.md`, including its "What we gave up" section.
- **Plugins cannot add backend commands.** They compose an allowlisted set through `backend.invoke`. See `docs/adr/0004-frontend-only-plugins.md`.

### Activation timing

| Plugin declares | Activates |
|---|---|
| UI contributions only | Lazily, on first use (button click, tab open, palette pick) |
| A service (`contributes.services`) | At boot, **after** the window is interactive and painted |

The host renders declared UI contributions from the manifest alone — a topbar button appears without the plugin's code ever running. This is what lets Plugin Studio show "this plugin will add 2 topbar buttons, 1 tab, 3 commands" before you enable it, and what lets the Validator check the full contribution surface without executing anything.

### Module identity

ES modules cannot be unloaded. Reloading a plugin re-imports it under a cache-busting URL (`?h=<sha256-8>`), which creates a fresh module instance but leaks the previous module's scope. `deactivate()` is therefore a real obligation: it must release listeners and DOM. Honest teardown keeps the leak to memory rather than behavior.

---

## 3. Package layout

```
acme.habit-tracker/          # folder name is the plugin id
  plugin.json                # manifest — required
  index.js                   # entry module (ESM) — required
  bentomux-plugin-sdk.d.ts   # SDK types, copied in by the Creator — recommended
  icon.svg                   # optional
  …any other assets
```

Installed at `app_data_dir/plugins/<id>/<version>/`. Plugin **code** never lives in `bentomux.json`; only the registry does.

---

## 4. Manifest — `plugin.json`

```json
{
  "id": "acme.habit-tracker",
  "name": "Habit Tracker",
  "version": "1.0.0",
  "apiVersion": 1,
  "minAppVersion": "0.3.0",
  "description": "Track daily habits from a sidebar list and a welcome widget.",
  "author": "Acme",
  "entry": "index.js",
  "icon": { "type": "builtin", "name": "board" },
  "permissions": ["storage", "app.read", "tabs.write"],
  "contributes": {
    "commands": [
      { "id": "acme.habit-tracker.open", "title": "Open Habit Tracker" }
    ],
    "sidebar": [
      { "id": "acme.habit-tracker.sidebar", "title": "Habits", "icon": { "type": "builtin", "name": "board" }, "command": "acme.habit-tracker.open" }
    ],
    "tabs": [
      { "id": "acme.habit-tracker.dashboard", "title": "Habits", "icon": { "type": "builtin", "name": "board" } }
    ],
    "widgets": [
      { "id": "acme.habit-tracker.widget", "title": "Habit streak" }
    ]
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | `publisher.name`, both segments `[a-z0-9-]+`. The `bentomux` publisher is reserved for bundled plugins. |
| `name` | yes | Display name. |
| `version` | yes | Semver. Also the on-disk version directory name. |
| `apiVersion` | yes | Integer. **Hard gate** — the host refuses an unknown major with a clear error. |
| `minAppVersion` | no | Semver. **Soft gate** — a mismatch warns, it does not refuse. Refusing a plugin that works fine because the app moved on is worse than the warning. |
| `description`, `author` | no | Shown in Plugin Studio. |
| `entry` | yes | Path relative to the plugin root. |
| `icon` | no | `{ "type": "builtin", "name": <one of IC> }` or `{ "type": "image", "path": "icon.svg" }`. Never inline HTML — see §11. |
| `permissions` | no | Defaults to `[]`. Unknown names are a validation error. |
| `contributes` | no | Defaults to `{}`. Unknown keys are a validation error. |

Contribution ids must be namespaced under the plugin id (`<pluginId>.<name>`) and unique across the manifest.

---

## 5. Permissions

Each permission unlocks a namespace on `ctx`. Declaring a permission the plugin does not need is a warning, not an error — but it shows up in Studio's review screen, which is the point.

| Permission | Unlocks |
|---|---|
| `storage` | `ctx.storage` (§9) |
| `app.read` | `getState`, `onBranch`, `onRuntimeStatus`, `onAgentEvent`, `onAgentApproval`, `onAgentApprovalClosed`, `onFileDrop` |
| `app.prefs.write` | `setPrefs` |
| `app.window` | `minimize`, `toggleMaximize`, `toggleFullscreen`, `close`, `onMaximized`, `quitApp` |
| `files.temp` | `saveTempFile` |
| `workspaces.write` | `chooseFolder`, `addWorkspace`, `removeWorkspace`, `reorderWorkspaces`, `setActiveWorkspace` |
| `tabs.write` | `createTab`, `splitTab`, `setSplitDir`, `renameTab`, `closePane`, `closeTab` |
| `terminal.read` | `onPtyData`, `onPtyExit` |
| `terminal.input` | `writeTab`, `resizeTab` |
| `git.read` | `branchFor`, `gitStatus`, `gitDiff`, `gitDiffStat`, `gitRemoteInfo` |
| `git.push` | `gitPush` |
| `agents.read` | `agents`, `agentConfig`, `listResources`, `agentHooksStatus` |
| `agents.write` | `setAgentModelSettings`, `saveResource`, `deleteResource`, `toggleResource`, `agentHooksInstall`, `agentHooksUninstall`, `resolveApproval` |
| `remote.control` | `remoteInfo`, `remoteSetEnabled`, `remoteSetPort` |
| `backend.invoke` | `ctx.app.invoke(command, args)` — restricted to the allowlist below |

`terminal.read` is separate from `app.read` on purpose: terminal output routinely contains secrets the user typed.

**`backend.invoke` allowlist (v1) is read-only:** `get_state`, `git_status`, `git_diff`, `git_diff_stat`, `git_remote_info`, `git_branch_for`, `agents_list`, `agents_config`, `res_list`, `agent_hooks_status`, `remote_info`. Write commands are excluded. Extending this list grants every installed plugin the new capability — it is a review surface, and should be treated as one.

---

## 6. Plugin Context

```ts
interface PluginContext {
  readonly plugin: { id: string; version: string };
  readonly log: (...args: unknown[]) => void;

  readonly storage: PluginStorage;        // requires "storage"
  readonly app: ScopedAppApi;             // scoped to declared permissions
  readonly events: PluginEvents;          // host lifecycle events
  readonly ui: UiRegistration;            // keyed by manifest-declared ids

  /** Register teardown work. Every entry runs on deactivate. */
  readonly dispose: (fn: () => void) => void;
}

interface UiRegistration {
  command(id: string, handler: (args?: unknown) => void | Promise<void>): void;
  tab(id: string, render: (host: HTMLElement) => void | (() => void)): void;
  modal(id: string, render: (host: HTMLElement) => void | (() => void)): void;
  widget(id: string, render: (host: HTMLElement) => void | (() => void)): void;
  settingsSection(id: string, build: (paint: () => void) => HTMLElement): void;
  service(id: string, run: (signal: AbortSignal) => void | Promise<void>): void;
}

interface PluginEvents {
  on(event: 'workspace:changed' | 'tab:activated' | 'tab:closed', cb: (payload: unknown) => void): () => void;
}
```

Registration is **keyed by ids declared in the manifest**. Registering an id the manifest never declared is an error the host reports; declaring an id the plugin never registers is a warning. The `render`/`build` callbacks return an optional cleanup function, which the host also runs on deactivate — belt and braces alongside `ctx.dispose`.

`ctx.app` exposes the same method names as `BentomuxApi` for the methods the plugin's permissions unlock, and nothing else. Calling an undeclared method throws a named error, so the mistake is loud rather than silent.

---

## 7. Contribution points

| Kind | Manifest key | Appears in | Host seam | Body registered by |
|---|---|---|---|---|
| Topbar button | `contributes.topbar` | Titlebar, right cluster | `src/index.html:19`, `main.ts wireAppBar` | fires its `command` |
| Sidebar item | `contributes.sidebar` | Sidebar `#nav` list | `views/sidebar.ts:509 renderSidebar` | fires its `command` |
| Dock item | `contributes.dock` | Sidebar bottom dock | `views/sidebar.ts:527 renderBottomDock` | fires its `command` |
| Command | `contributes.commands` | Command palette | `views/search.ts:30 buildSearchItems` | `ui.command(id, fn)` |
| Tab | `contributes.tabs` | Tab strip + content area | `state.ts Route`, `tabs.ts:21/574`, `main.ts:83` | `ui.tab(id, render)` |
| Modal | `contributes.modals` | `#modalRoot` | `components/modal.ts:14 openModal` | `ui.modal(id, render)` |
| Widget | `contributes.widgets` | Welcome page card grid | `views/welcome.ts:20 welcomePage` | `ui.widget(id, render)` |
| Settings section | `contributes.settings` | Settings modal nav | `views/settings.ts:400 SECTIONS` | `ui.settingsSection(id, build)` |
| Service | `contributes.services` | — (headless) | `main.ts:359 boot` | `ui.service(id, run)` |

Plugin tabs are **full citizens**: grouped by workspace in the tab strip, part of back/forward history, and restored on restart — but only if the plugin is still installed and enabled. Otherwise the tab is dropped silently and the reason is written to the plugin log.

**Not in v1:** plugin-declared keyboard shortcuts. A shortcut needs a stable action registry, and today `keyboard.ts DEFAULT_ACCELS` and `settings.ts KEY_ACTIONS` are parallel hardcoded lists. Plugin commands appear in the palette; binding them to keys waits until that duplication is resolved, so we don't add a third source of truth.

---

## 8. Lifecycle

```
import/install → validate → extract to plugins/<id>/<version>/ → registry entry → (enable)
   enable  → activate: import entry, call activate(ctx), register contributions
   disable → call deactivate(), run dispose hooks, drop contributions, keep code + data
   update  → install new version dir, activate it, keep the previous version dir
   rollback→ flip registry to the previous version dir
   uninstall → deactivate, delete version dirs, remove registry entry, KEEP data
```

- **Install** is an explicit user action, so the plugin is enabled by default. The install dialog carries an "Enable after install" checkbox, checked.
- **Update** keeps exactly one previous version. When a third arrives the oldest is garbage-collected. A "Roll back" action appears in Studio whenever a previous version exists.
- **Uninstall** deletes code and keeps Plugin Data, with a separate, default-off "also remove data" checkbox. Losing user data to a mis-click is not an acceptable default.
- **Errored plugins** are marked, their contributions are hidden, and Studio shows the error with a one-click retry. A service that throws marks its plugin errored; it does not take down the app.

### Safe mode

If the shell cannot boot, the user cannot reach Plugin Studio to disable the culprit — so there are two exits:

- `bentomux --safe-mode` starts with every third-party plugin disabled and shows a banner explaining why, offering to re-enable one at a time.
- The app increments a boot-attempt counter before the webview loads and clears it when the renderer reports a successful first paint. **Two consecutive failed boots automatically start the next one in safe mode.**

The auto-trigger alone would be dangerous — "boot failed" is hard to distinguish from an unrelated crash — which is why the manual flag ships alongside it rather than instead of it.

---

## 9. Storage

`ctx.storage` is a per-plugin JSON store at `app_data_dir/plugin-data/<id>.json`, written atomically with the same temp-file-plus-rename discipline as `state.rs::persist()`.

```ts
interface PluginStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}
```

Values must be JSON-serializable. A soft cap of 1 MB per plugin applies, enforced with a clear error rather than a silent truncation. Plugin Data outlives the plugin (§8) — it is the user's data, not the plugin's.

---

## 10. Loading and the `plugin://` scheme

Plugin files are served over a registered custom scheme (`docs/adr/0003-plugin-code-over-custom-scheme.md`). Tauri exposes custom schemes to the webview as `plugin://localhost/<id>/<path>` on macOS and Linux, and `http://plugin.localhost/<id>/<path>` on Windows — **verify both forms against the running app during implementation**; the CSP must name both.

- The entry module loads as `plugin://localhost/<id>/<entry>?h=<sha256-8>`.
- The host resolves every request against that plugin's own root and **refuses** paths containing `..`, absolute paths, and symlinks that escape the root.
- The production CSP gains the plugin scheme in `script-src`, `style-src`, and `img-src`. Nothing else in the policy widens: no `'unsafe-eval'`, no `blob:`, no `data:` in `script-src`.

## Network access

A plugin that reaches an outside website declares it in `plugin.json` under `network`, as bare `https://host[:port]` origins with no path. `scripts/gen-plugin-csp.mjs` bakes them into `connect-src` and `img-src` at build time; a malformed origin fails validation (`network-invalid`). The Studio install review shows the declared hosts next to the permissions. A host outside the last build stays blocked until the next release — that limit is stated in the review, not hidden.

---

## 11. Validation

The Validator is implemented once in Rust with two surfaces: an IPC command for the app, and `bentomux --plugin-validate <dir> [--json]` using the same self-exec pattern as the pty host, so an agent can run it from a terminal without opening the app. Exit codes: `0` ok, `1` errors found, `2` usage.

**Static checks — no code is executed:**

1. `plugin.json` exists, parses, and matches the schema.
2. `id` matches `^[a-z0-9-]+\.[a-z0-9-]+$` and does not use the reserved `bentomux` publisher (bundled plugins are exempt).
3. `version` is semver; `apiVersion` is a known integer; `minAppVersion` is semver.
4. `entry` exists, is inside the plugin root, and is non-empty.
5. Every contribution id is namespaced under the plugin id and unique.
6. Every permission name is known.
7. Every `command` referenced by a topbar/sidebar/dock contribution exists in `contributes.commands`.
8. Icon references resolve: a builtin name exists in `IC`, or the image file exists.
9. Total plugin size is within the cap (5 MB).

**JS syntax is checked by the CLI surface only**, by shelling out to `node --check` on a temporary `.mjs` copy of the entry. Node is guaranteed present in the authoring workflow (`npm run plugin:validate`) but is *not* assumed at app runtime, so the in-app Validator checks structure and catches syntax errors at activation, where `import()` throws a `SyntaxError` the host reports as a plugin error.

**Icons never come from inline HTML.** `dom.ts` reserves `innerHTML` for compile-time constants and explicitly forbids file content, so a plugin icon is either a builtin `IC` name or an image file served over `plugin://` and rendered as `<img>`. No SVG sanitizer is written in v1 — a hand-rolled sanitizer for third-party SVG is a large, easy-to-get-wrong attack surface, and this sidesteps it entirely. Trade-off accepted: an image icon does not follow the theme's ink color.

---

## 12. The AI Plugin Agent

The agent is **`bentomux-plugin-author`** — a Plugin Skill (see `CONTEXT.md`; distinct from an Agent Skill). It teaches an agent to turn a natural-language request into an installable plugin.

**It ships as a folder**, not a single file, because progressive disclosure matters at this size:

```
resources/plugin-skill/bentomux-plugin-author/
  SKILL.md                          # the workflow, and when to read each reference
  references/manifest.md            # field-by-field, generated from the schema
  references/permissions.md         # the §5 table, generated
  references/ctx-api.md             # the §6 contract, generated
  references/contribution-points.md # the §7 table, generated
  references/validation.md          # the §11 checks, generated
  examples/                         # copies of the templates
```

**The app never pretends to be the model.** Plugin Studio scaffolds, validates, and packages; the intelligence is the user's agent, working on the folder with its own tools. After scaffolding, Studio shows *"Now ask your agent: 'implement this plugin using the bentomux-plugin-author skill'"* with a copy button.

**Installation:** Studio copies the skill folder into a chosen agent's skills directory via one new command. It then appears in the existing Skills UI, because that UI reads `<root>/skills/<id>/SKILL.md`. Accepted consequence: editing the skill through the Skills UI touches only `SKILL.md` — the reference files must be edited on disk.

**Anti-drift:** the reference files and examples are **generated** from `resources/plugin-schema.json` and `resources/plugin-templates/` by `scripts/gen-plugin-skill.mjs`. The generated output is committed, and CI re-runs the generator and fails if the result differs. Templates and skill cannot silently diverge.

**The skill states the limits plainly**, because "add a backend feature" is the most likely thing a user asks for and the most likely thing an agent would fake: plugins are frontend-only (ADR-0004), permissions are a contract not a wall (ADR-0001), and there is no sandbox (ADR-0001).

---

## 13. Templates

Seven templates, each a **valid plugin on disk** — this is what makes them useful as CI fixtures and as agent examples, not just as scaffolding.

| Template | Contents |
|---|---|
| `basic` | manifest + `index.js` + SDK types + one command. The minimal valid plugin. |
| `sidebar` | basic + a sidebar item |
| `topbar` | basic + a topbar button |
| `modal` | basic + a modal opened by a command |
| `tab` | basic + a workspace tab |
| `widget` | basic + a welcome-page widget |
| `service` | basic + a background service |

Templates live at `resources/plugin-templates/<name>/` and ship as bundle resources, following the existing `resources/manifests/` pattern. The Creator copies a folder and substitutes `{{id}}`, `{{name}}`, `{{version}}`, `{{author}}`.

**One artifact, three jobs:** a template is the wizard's scaffold, the CI fixture (substitute → validate → assert), and the example the agent reads.

---

## 14. Non-goals for v1

- **Backend contributions.** No Rust from plugins; the sidecar pattern (a child process speaking a JSON-line protocol, as `pty_host` does) is the deferred escape hatch for work that must outlive the window or run in another language.
- **A hosted registry.** Install-from-URL with a pinned sha256 covers distribution. A static `plugins.json` in a release asset is a credible v2 registry with no server to run.
- **Isolation.** See ADR-0001's "What we gave up".
- **Theme and palette contributions.** `PALETTES` is a build-time enum; making it dynamic is a separate design.
- **Right-panel panels.** The Git panel slot stays hardcoded; widgets live on the welcome page instead.
- **Plugin-declared keyboard shortcuts.** See §7.
- **Dogfooding `remote.ts`.** Converting the Remote dock item into a bundled plugin is the API's acceptance test, run manually before v1 ships — not part of the build. If the API cannot host `remote.ts` without a hack, the API is not finished.

---

## 15. Verification

**CI, mechanical:** the CLI Validator runs over all seven substituted templates; Rust unit tests cover validation (valid, bad id, unknown permission, missing entry, reserved prefix, path escape), registry operations (install/enable/update/rollback/uninstall with data retention), and the safe-mode boot counter; the skill-drift check from §12; the existing typecheck, build, `cargo check`, `npm run test:backend`, and `tauri build` still pass on all three platforms.

**In-app, on demand:** a "Run self-check" action in Studio activates any plugin, asserts its contributions registered, deactivates, and asserts the surface is clean.

**Honest gap:** there is no automated end-to-end test of the *renderer's* activation cycle. This stack has no headless webview and the repo has no JavaScript test runner, so a true E2E would mean adding a browser automation dependency and a new CI stage. v1 does not; the activation cycle is covered by the in-app self-check plus a manual gate before release. If the frontend grows past thin registration logic, revisit this.
