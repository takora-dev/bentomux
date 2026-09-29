---
name: bentomux-plugin-author
description: Author, extend, and validate Bentomux plugins. Use when asked to build a plugin for Bentomux, add a sidebar item / topbar button / tab / modal / widget / command / background service to it, or fix a plugin that fails validation.
---

# Authoring Bentomux plugins

A Bentomux plugin is a folder with a `plugin.json` manifest and an ES module
entry point. The app loads the entry into its own page and calls
`activate(ctx)`. The plugin registers what its manifest declared, and the app
renders it.

## The loop

1. **Read the manifest reference** — `references/manifest.md`. It is generated
   from the schema the app actually enforces.
2. **Pick the closest template** from `examples/` and copy it. Do not start
   from a blank file: every template is a valid plugin and shows the shape.
3. **Write the manifest first.** Declare every contribution and every
   permission before writing code that uses them.
4. **Implement `activate(ctx)`** — see `references/ctx-api.md` and
   `references/contribution-points.md`.
5. **Validate**, and keep going until it passes:

       bentomux --plugin-validate . --json

   Read `references/validation.md` for what each issue code means. One run
   reports every problem, so fix them all at once.
6. **Run it in the app** — Settings → Plugins → Install plugin… — then
   restart Bentomux when the app asks. The plugin list is read at startup, so
   a plugin installed in the running session appears after the relaunch.

## Rules that are not negotiable

- **Ids must be namespaced**: every contribution id starts with the plugin id
  (`acme.my-plugin.open`). Two contributions never share an id.
- **Declare before you register.** Registering an id the manifest does not
  declare is an error. Declaring an id that never gets registered is a warning
  — the manifest must be an honest description of what the plugin adds.
- **Permissions are a contract, not a sandbox.** Declare only what you use.
  Never tell a user the permission list isolates the plugin; it does not.
- **Plugins cannot add backend commands.** They are frontend-only. If a request
  needs a new Rust command, say so plainly instead of faking it with frontend
  code that cannot work.
- **Never inline SVG or HTML from a file.** Icons are a built-in name or an
  image path.

## Reference files

| File | Read it when |
|---|---|
| `references/manifest.md` | Writing or changing `plugin.json` |
| `references/permissions.md` | The plugin touches app data, git, terminal, or storage |
| `references/ctx-api.md` | Implementing `activate(ctx)` |
| `references/contribution-points.md` | Choosing what to add, or opening a tab/modal |
| `references/validation.md` | A validation run failed |

## Examples

`examples/` holds the seven templates — `basic`, `sidebar`, `topbar`,
`modal`, `tab`, `widget`, `service` — with their placeholders already
filled in, so each one is a concrete plugin you can read and copy.

## Testing without the app

`bentomux --plugin-validate` runs from a terminal and needs no window, which
is what makes this loop workable without launching Bentomux.
