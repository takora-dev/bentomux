# Manifest reference

Generated from `resources/plugin-schema.json` — do not edit by hand.

A plugin is a folder containing `plugin.json` and an ES module entry.

## Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | publisher.name, exactly two segments of [a-z0-9-]+. The `bentomux` publisher is reserved for bundled plugins. |
| `name` | string | yes | Display name shown in Plugin Studio. |
| `version` | string | yes | Semver. Also the on-disk version directory name. |
| `apiVersion` | integer | yes | Hard gate: the host refuses a major it does not implement. |
| `minAppVersion` | string | no | Soft gate: a mismatch warns, it does not refuse. |
| `description` | string | no | One line shown in the install review. |
| `author` | string | no | Who wrote the plugin. |
| `entry` | string | yes | Path to the ES module entry, relative to the plugin root and inside it. |
| `icon` | any | no | A builtin icon name or an image file inside the plugin folder. Inline markup is never accepted. |
| `permissions` | array | no | Namespaces of the app the plugin may use. A contract, not a sandbox. |
| `network` | array | no | HTTPS origins the plugin may fetch() or load images from. Baked into connect-src/img-src at build time; shown in the install review. |
| `contributes` | object | no | What the plugin adds. Declaring an id that is never registered is a warning; registering an undeclared id is an error. |

`apiVersion` must be `1`.

## `contributes`

Contribution kinds, exactly these names:

- `commands`
- `topbar`
- `sidebar`
- `dock`
- `tabs`
- `modals`
- `widgets`
- `settings`
- `services`

Each kind is an array. Every contribution needs an `id` namespaced under the
plugin id (`<pluginId>.<name>`), and ids must be unique across **all** kinds —
a command and a sidebar row are different contributions and need different ids.

A `topbar`, `sidebar`, or `dock` entry must name the `command` it fires, and
that command must appear in `contributes.commands`.

## `id`

`publisher.name` — exactly two segments, each `[a-z0-9-]+`, no leading or
trailing dash. The `bentomux` publisher is reserved for plugins shipped with
the app.

## `permissions`

- `storage`
- `app.read`
- `app.prefs.write`
- `app.window`
- `files.temp`
- `workspaces.write`
- `tabs.write`
- `terminal.read`
- `terminal.input`
- `git.read`
- `git.push`
- `agents.read`
- `agents.write`
- `remote.control`
- `backend.invoke`

Unknown names are a validation error, so a typo cannot silently grant nothing.

## `network`

HTTPS origins the plugin may `fetch()` or load images from, as bare
`https://host[:port]` origins with no path. The generator
(`scripts/gen-plugin-csp.mjs`) bakes them into the Tauri CSP's
`connect-src` and `img-src` at build time, and the Studio install review
shows them next to the permissions. A malformed origin is a validation
error (`network-invalid`); a host outside the last build stays blocked
until the next release. Petdex declares `https://petdex.dev` (manifest)
and `https://assets.petdex.dev` (redirect target + sprites) for this
reason.
