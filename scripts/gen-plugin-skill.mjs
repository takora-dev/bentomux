/* Generates the `bentomux-plugin-author` skill from the platform's real
 * sources.
 *
 * Run: node scripts/gen-plugin-skill.mjs
 * Check: node scripts/gen-plugin-skill.mjs --check   (CI; fails on drift)
 *
 * The skill is the knowledge an authoring agent loads. Its reference files
 * describe the manifest schema, the permission table, the ctx API, and the
 * contribution points — all of which also exist in code. Two hand-written
 * copies would diverge within a release or two, and the agent would confidently
 * write plugins against a shape the app no longer accepts. So the references
 * are generated from the same files the app is built from:
 *
 *   resources/plugin-schema.json          ← the manifest schema
 *   src/src/plugin/types.ts               ← permissions, allowlist, ctx API
 *   src-tauri/src/plugin/mod.rs           ← contribution kinds, limits
 *   src-tauri/src/plugin/validate.rs      ← issue codes
 *   resources/plugin-templates/           ← examples, copied verbatim
 *
 * CI re-runs this and fails if the committed output differs, so a schema
 * change that forgets the skill is caught at review time rather than by a user
 * whose generated plugin does not load. */

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, cpSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CHECK = process.argv.includes('--check');
const SKILL = resolve('resources/plugin-skill/bentomux-plugin-author');
const SCHEMA_PATH = resolve('resources/plugin-schema.json');

/* ---------------- sources ---------------- */

function readSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
}

function readTypes() {
  return readFileSync(resolve('src/src/plugin/types.ts'), 'utf8');
}

function readRust(file) {
  return readFileSync(resolve('src-tauri/src/plugin', file), 'utf8');
}

/** Pull a `export const NAME = [ ... ]` string array out of a TS file. */
function tsStringArray(source, name) {
  const re = new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
  const match = source.match(re);
  if (!match) throw new Error(`could not find ${name} in types.ts`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}

/** Pull a Rust `pub const NAME: &[&str] = &[ ... ];` list. */
function rustStringArray(source, name) {
  const re = new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`, 'm');
  const match = source.match(re);
  if (!match) throw new Error(`could not find ${name} in the Rust source`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
}

/* ---------------- generated references ---------------- */

function manifestReference(schema) {
  const fields = Object.entries(schema.properties).map(([name, spec]) => {
    const required = schema.required?.includes(name) ? 'yes' : 'no';
    const type = spec.type ?? (spec.$ref ? 'object' : 'any');
    const note = (spec.description ?? '').replace(/\s+/g, ' ');
    return `| \`${name}\` | ${type} | ${required} | ${note} |`;
  });

  const kinds = rustStringArray(readRust('mod.rs'), 'CONTRIBUTION_KINDS');
  const permissions = tsStringArray(readTypes(), 'ALL_PERMISSIONS');
  const apiVersion = schema.properties.apiVersion?.const ?? 1;

  return `# Manifest reference

Generated from \`resources/plugin-schema.json\` — do not edit by hand.

A plugin is a folder containing \`plugin.json\` and an ES module entry.

## Fields

| Field | Type | Required | Notes |
|---|---|---|---|
${fields.join('\n')}

\`apiVersion\` must be \`${apiVersion}\`.

## \`contributes\`

Contribution kinds, exactly these names:

${kinds.map(k => `- \`${k}\``).join('\n')}

Each kind is an array. Every contribution needs an \`id\` namespaced under the
plugin id (\`<pluginId>.<name>\`), and ids must be unique across **all** kinds —
a command and a sidebar row are different contributions and need different ids.

A \`topbar\`, \`sidebar\`, or \`dock\` entry must name the \`command\` it fires, and
that command must appear in \`contributes.commands\`.

## \`id\`

\`publisher.name\` — exactly two segments, each \`[a-z0-9-]+\`, no leading or
trailing dash. The \`bentomux\` publisher is reserved for plugins shipped with
the app.

## \`permissions\`

${permissions.map(p => `- \`${p}\``).join('\n')}

Unknown names are a validation error, so a typo cannot silently grant nothing.

## \`network\`

HTTPS origins the plugin may \`fetch()\` or load images from, as bare
\`https://host[:port]\` origins with no path. The generator
(\`scripts/gen-plugin-csp.mjs\`) bakes them into the Tauri CSP's
\`connect-src\` and \`img-src\` at build time, and the Studio install review
shows them next to the permissions. A malformed origin is a validation
error (\`network-invalid\`); a host outside the last build stays blocked
until the next release. Petdex declares \`https://petdex.dev\` (manifest)
and \`https://assets.petdex.dev\` (redirect target + sprites) for this
reason.
`;
}

function permissionsReference() {
  const types = readTypes();
  const permissions = tsStringArray(types, 'ALL_PERMISSIONS');
  const allowlist = tsStringArray(types, 'BACKEND_ALLOWLIST');

  /* the method tables are a nested record, not a flat array: parse the block */
  const block = types.match(/export const PERMISSION_METHODS[^{]*\{([\s\S]*?)\n\};/);
  const methods = {};
  if (block) {
    for (const m of block[1].matchAll(/'([^']+)':\s*\[([\s\S]*?)\]/g)) {
      methods[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map(x => x[1]);
    }
  }

  const rows = permissions.map(p => {
    const list = methods[p] ?? [];
    if (p === 'storage') return `| \`storage\` | \`ctx.storage\` (get / set / delete / keys) |`;
    if (p === 'backend.invoke') return `| \`backend.invoke\` | \`ctx.app.invoke(command, args)\`, restricted to the allowlist below |`;
    return `| \`${p}\` | ${list.length ? list.map(m => `\`ctx.app.${m}\``).join(', ') : '—'} |`;
  });

  return `# Permissions reference

Generated from \`src/src/plugin/types.ts\` — do not edit by hand.

Every capability a plugin uses must be declared in \`plugin.json\` first. The
host hands over only what was declared; calling an undeclared method throws a
named error rather than working by accident.

| Permission | Unlocks |
|---|---|
${rows.join('\n')}

## \`backend.invoke\` allowlist

\`ctx.app.invoke(command, args)\` forwards only these, and they are read-only:

${allowlist.map(c => `- \`${c}\``).join('\n')}

## What permissions are not

They are a **contract, not a sandbox**. Plugin code runs inside Bentomux and
shares its JavaScript realm, so a plugin is not isolated from the app. The
permission list makes a plugin's intent legible to the user and checkable by
the validator — it does not contain a hostile plugin. Do not describe it to a
user as a security boundary.
`;
}

function ctxReference() {
  const types = readTypes();
  /* quote the interfaces straight from the source of truth */
  const grab = name => {
    const re = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`, 'm');
    const m = types.match(re);
    if (!m) throw new Error(`could not find interface ${name}`);
    return `export interface ${name} {${m[1]}\n}`;
  };

  return `# Context API reference

Generated from \`src/src/plugin/types.ts\` — do not edit by hand.

\`activate(ctx)\` receives this object:

\`\`\`ts
${grab('PluginContext')}
\`\`\`

## Registering contributions

\`\`\`ts
${grab('PluginUi')}
\`\`\`

Every id passed to a registration call must already be declared in
\`plugin.json\`. Registering an undeclared id is an error; declaring an id that
is never registered is a warning. That pairing is what keeps a manifest an
honest description of what the plugin adds.

The render callbacks for tabs, modals, and widgets take the host element to
fill, and may return a cleanup function that runs when that surface is torn
down.

## Storage

\`\`\`ts
${grab('PluginStorage')}
\`\`\`

Values must be JSON-serializable. The store is one file per plugin, capped at
1 MB, and it **survives uninstall** unless the user explicitly asks for its
removal.

## Events

\`\`\`ts
${grab('PluginEvents')}
\`\`\`

The host fires \`workspace:changed\`, \`tab:activated\`, and \`tab:closed\`.

## Teardown

Return nothing from \`activate\`; register cleanup with \`ctx.dispose(fn)\` or by
returning a function from a render callback. ES modules cannot be unloaded, so
a plugin that does not release its listeners and DOM will keep them after it is
disabled.
`;
}

function contributionPointsReference() {
  return `# Contribution points

What a plugin can add, and what each one means in the app.

| Kind | Where it appears | What the plugin registers |
|---|---|---|
| \`commands\` | The command palette (Ctrl/Cmd+K) | \`ctx.ui.command(id, handler)\` |
| \`topbar\` | Titlebar, right side | fires its \`command\` |
| \`sidebar\` | Sidebar, below the workspace list | fires its \`command\` |
| \`dock\` | Sidebar bottom dock, beside Settings | fires its \`command\` |
| \`tabs\` | Tab strip, grouped under the plugin's name | \`ctx.ui.tab(id, render)\` |
| \`modals\` | The app's modal root | \`ctx.ui.modal(id, render)\` |
| \`widgets\` | Welcome page card grid | \`ctx.ui.widget(id, render)\` |
| \`settings\` | Settings modal, after the built-in sections | \`ctx.ui.settingsSection(id, build)\` |
| \`services\` | Headless, runs while the app is open | \`ctx.ui.service(id, run)\` |

## Activation timing

- A plugin with **only UI contributions** activates **lazily** — its buttons and
  rows render from \`plugin.json\` before any code runs, and the code loads on
  first use. This is why the manifest must declare everything.
- A plugin that declares a **service** activates **at boot**, after the window
  is interactive, because a background task has no click to wait for.

## Opening what you declared

Declaring a tab or a modal does not show it. A command handler opens it:

\`\`\`js
ctx.ui.command('acme.my-plugin.open', () => ctx.ui.openTab('acme.my-plugin.tab'));
\`\`\`

\`openTab\` / \`openModal\` throw when the id was never declared, or when no
renderer has been registered for it yet.

## Icons

An icon is either a built-in name or an image file inside the plugin folder:

\`\`\`json
{ "type": "builtin", "name": "board" }
{ "type": "image", "path": "icon.svg" }
\`\`\`

Built-in names: lines, plus, git2, chat, chev, board, git, folder, bot, search,
gear, term, key, dots, bell, phone.

Inline SVG is **not** accepted: the host reserves raw markup for its own
compile-time icons. An image icon does not follow the theme's text colour.

## What a plugin cannot do

- **Add a backend command.** Plugins are frontend-only. They compose the
  allowlisted read-only commands in \`backend.invoke\`; anything needing a new
  Rust command is out of scope and should be said so plainly rather than faked.
- **Declare keyboard shortcuts.** Commands appear in the palette; binding keys
  is not supported yet.
- **Contribute a theme or palette.**
`;
}

function validationReference() {
  const codes = [...readRust('validate.rs').matchAll(/pub const ([A-Z_]+): &str = "([^"]+)";/g)]
    .map(m => ({ name: m[1], code: m[2] }));

  const mod = readRust('mod.rs');
  const maxBytes = mod.match(/MAX_PLUGIN_BYTES: u64 = ([^;]+);/)?.[1] ?? '5 * 1024 * 1024';

  return `# Validation reference

Generated from \`src-tauri/src/plugin/validate.rs\` — do not edit by hand.

Validate with:

    bentomux --plugin-validate <folder>          # human-readable
    bentomux --plugin-validate <folder> --json   # machine-readable

Exit codes: \`0\` valid, \`1\` errors found, \`2\` usage error.

**One run reports every problem it can find**, not just the first — so fix all
of them and run once more rather than iterating one error at a time.

## Issue codes

| Code | Meaning |
|---|---|
${codes.map(c => `| \`${c.code}\` | ${c.name.toLowerCase().replace(/_/g, ' ')} |`).join('\n')}

## Limits

- Total plugin size: 5 MB (${maxBytes} bytes), symlinks pointing outside the
  folder are refused.
- \`apiVersion\` must match the host's, currently 1. A mismatch is refused
  outright, not warned about.
- \`minAppVersion\` is advisory: a mismatch warns, it does not refuse.

## What is not checked statically

JavaScript syntax. The CLI path shells out to \`node --check\`; the in-app
validator does not, and a syntax error surfaces as a failed activation instead.
Run the CLI before installing.
`;
}

function skillMd() {
  return `---
name: bentomux-plugin-author
description: Author, extend, and validate Bentomux plugins. Use when asked to build a plugin for Bentomux, add a sidebar item / topbar button / tab / modal / widget / command / background service to it, or fix a plugin that fails validation.
---

# Authoring Bentomux plugins

A Bentomux plugin is a folder with a \`plugin.json\` manifest and an ES module
entry point. The app loads the entry into its own page and calls
\`activate(ctx)\`. The plugin registers what its manifest declared, and the app
renders it.

## The loop

1. **Read the manifest reference** — \`references/manifest.md\`. It is generated
   from the schema the app actually enforces.
2. **Pick the closest template** from \`examples/\` and copy it. Do not start
   from a blank file: every template is a valid plugin and shows the shape.
3. **Write the manifest first.** Declare every contribution and every
   permission before writing code that uses them.
4. **Implement \`activate(ctx)\`** — see \`references/ctx-api.md\` and
   \`references/contribution-points.md\`.
5. **Validate**, and keep going until it passes:

       bentomux --plugin-validate . --json

   Read \`references/validation.md\` for what each issue code means. One run
   reports every problem, so fix them all at once.
6. **Run it in the app** — Settings → Plugins → Install plugin… — then
   restart Bentomux when the app asks. The plugin list is read at startup, so
   a plugin installed in the running session appears after the relaunch.

## Rules that are not negotiable

- **Ids must be namespaced**: every contribution id starts with the plugin id
  (\`acme.my-plugin.open\`). Two contributions never share an id.
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
| \`references/manifest.md\` | Writing or changing \`plugin.json\` |
| \`references/permissions.md\` | The plugin touches app data, git, terminal, or storage |
| \`references/ctx-api.md\` | Implementing \`activate(ctx)\` |
| \`references/contribution-points.md\` | Choosing what to add, or opening a tab/modal |
| \`references/validation.md\` | A validation run failed |

## Examples

\`examples/\` holds the seven templates — \`basic\`, \`sidebar\`, \`topbar\`,
\`modal\`, \`tab\`, \`widget\`, \`service\` — with their placeholders already
filled in, so each one is a concrete plugin you can read and copy.

## Testing without the app

\`bentomux --plugin-validate\` runs from a terminal and needs no window, which
is what makes this loop workable without launching Bentomux.
`;
}

/* ---------------- write ---------------- */

const files = {
  'SKILL.md': skillMd(),
  'references/manifest.md': manifestReference(readSchema()),
  'references/permissions.md': permissionsReference(),
  'references/ctx-api.md': ctxReference(),
  'references/contribution-points.md': contributionPointsReference(),
  'references/validation.md': validationReference(),
};

/* Examples: the templates with their placeholders FILLED IN.
 *
 * An agent copies from these. A file full of `{{id}}` invites it to copy the
 * braces literally, or to guess what belongs there; a concrete, valid plugin
 * shows the real shape and can be validated as-is. */
const EXAMPLE_VALUES = {
  id: 'acme.example',
  name: 'Example Plugin',
  version: '1.0.0',
  description: 'An example plugin, used as a reference by the authoring skill.',
  author: 'Example Author',
};

function fill(text) {
  let out = text;
  for (const [key, value] of Object.entries(EXAMPLE_VALUES)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

const examples = {};
for (const name of readdirSync(resolve('resources/plugin-templates'))) {
  const dir = resolve('resources/plugin-templates', name);
  if (!existsSync(join(dir, 'plugin.json'))) continue;
  for (const file of readdirSync(dir)) {
    if (file === 'bentomux-plugin-sdk.d.ts') continue;
    examples[`examples/templates/${name}/${file}`] = fill(readFileSync(join(dir, file), 'utf8'));
  }
}

const all = { ...files, ...examples };

/* ---------------- check or write ---------------- */

/* Compare text ignoring line-ending style. The generator emits LF, but the
 * worktree may hold CRLF: git's `core.autocrlf=true` rewrites text files on
 * checkout (it is the default on GitHub's windows-latest runners), and an
 * editor can too. Line endings are never the drift this check exists to catch
 * — a schema or API change is — so normalise before comparing rather than
 * failing on a file nobody edited. `.gitattributes` pins these paths to LF so
 * the committed bytes stay stable regardless; this is the belt to that braces. */
function sameText(a, b) {
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

if (CHECK) {
  const drift = [];
  for (const [rel, content] of Object.entries(all)) {
    const path = join(SKILL, rel);
    if (!existsSync(path)) {
      drift.push(`missing: ${rel}`);
      continue;
    }
    if (!sameText(readFileSync(path, 'utf8'), content)) drift.push(`out of date: ${rel}`);
  }
  if (existsSync(SKILL)) {
    const onDisk = walk(SKILL);
    for (const rel of onDisk) {
      if (!(rel in all)) drift.push(`stale: ${rel}`);
    }
  }
  if (drift.length) {
    console.error('the plugin skill is out of date with the platform:');
    for (const d of drift) console.error('  ' + d);
    console.error('\nrun: npm run plugin:skill');
    process.exit(1);
  }
  console.log('plugin skill is up to date');
} else {
  rmSync(SKILL, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(all)) {
    const path = join(SKILL, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    /* Always LF, whatever the checkout uses. Some of this content is quoted
     * straight out of src/src/plugin/types.ts and src-tauri/src/plugin/*.rs,
     * so on a checkout with core.autocrlf=true the generated files would
     * otherwise carry CRLF from those inputs while the template literals
     * around them carry LF — mixed endings inside one file, and a diff that
     * shows every line changed. `.gitattributes` pins these paths to LF; this
     * makes the generator itself agree on every platform. */
    writeFileSync(path, content.replace(/\r\n/g, '\n'));
  }
  console.log(`generated ${Object.keys(all).length} files into resources/plugin-skill/bentomux-plugin-author`);
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, base));
    else out.push(path.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return out;
}
