/* Generates the plugin scaffold templates and the SDK type file.
 *
 * Run: node scripts/gen-plugin-templates.mjs
 *
 * The templates are generated rather than hand-maintained so that all seven
 * stay in step: a change to the SDK type file or to a shared scaffold snippet
 * lands in every template at once. Phase 7's skill generator reads these same
 * files, so the AI authoring skill can never describe a template that no
 * longer exists. */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'resources/plugin-templates';
const SDK = 'resources/plugin-sdk';

/* ---------------- SDK types ----------------
   Self-contained on purpose: a plugin is a standalone folder and cannot
   import from the app's source tree. Keep in sync with src/src/plugin/types.ts
   — `npm run plugin:templates:check` fails if the two drift. */
const sdkDts = `/* Bentomux Plugin SDK — the types a plugin author writes against.
 *
 * A copy of the context API at the version this scaffold was generated from.
 * Plugins are standalone folders and cannot import from the app, so this file
 * is self-contained.
 *
 * Reference: docs/PLUGIN_PLATFORM.md in the Bentomux repository. */

export interface PluginIcon {
  type: 'builtin' | 'image';
  /** builtin only: one of the host's icon names. */
  name?: string;
  /** image only: a path inside the plugin folder. */
  path?: string;
}

export interface Contribution {
  /** Must be namespaced under the plugin id: \`<pluginId>.<name>\`. */
  id: string;
  title?: string;
  icon?: PluginIcon;
  /** topbar / sidebar / dock only: the command id this entry fires. */
  command?: string;
}

export interface Contributions {
  commands?: Contribution[];
  topbar?: Contribution[];
  sidebar?: Contribution[];
  dock?: Contribution[];
  tabs?: Contribution[];
  modals?: Contribution[];
  widgets?: Contribution[];
  settings?: Contribution[];
  services?: Contribution[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  minAppVersion?: string;
  description?: string;
  author?: string;
  entry: string;
  icon?: PluginIcon;
  permissions?: PluginPermission[];
  /** HTTPS origins the plugin may fetch() or load images from. Baked into the CSP at build time. */
  network?: string[];
  contributes?: Contributions;
}

export type PluginPermission =
  | 'storage' | 'app.read' | 'app.prefs.write' | 'app.window' | 'files.temp'
  | 'workspaces.write' | 'tabs.write' | 'terminal.read' | 'terminal.input'
  | 'git.read' | 'git.push' | 'agents.read' | 'agents.write'
  | 'remote.control' | 'backend.invoke';

export type Cleanup = () => void;
export type RenderFn = (host: HTMLElement) => void | Cleanup;

export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface PluginUi {
  command(id: string, handler: (args?: unknown) => void | Promise<void>): void;
  tab(id: string, render: RenderFn): void;
  modal(id: string, render: RenderFn): void;
  widget(id: string, render: RenderFn): void;
  settingsSection(id: string, build: (paint: () => void) => HTMLElement): void;
  service(id: string, run: (signal: AbortSignal) => void | Promise<void>): void;
  /** Open a tab this plugin declared. Throws if it was never declared. */
  openTab(id: string): void;
  /** Open a modal this plugin declared. Throws if it was never declared. */
  openModal(id: string): void;
}

export type PluginHostEvent = 'workspace:changed' | 'tab:activated' | 'tab:closed';

export interface PluginEvents {
  on(event: PluginHostEvent, cb: (payload: unknown) => void): Cleanup;
}

/**
 * The object handed to \`activate\`.
 *
 * Only the namespaces your manifest's permissions unlock are usable: calling
 * an undeclared bridge method throws a named error rather than working by
 * accident. That is a contract, not a sandbox — plugin code runs inside
 * Bentomux and shares its realm, so it is not isolated from the app.
 */
export interface PluginContext {
  readonly plugin: { id: string; version: string };
  readonly log: (...args: unknown[]) => void;
  readonly storage: PluginStorage;
  readonly app: Record<string, (...args: never[]) => unknown>;
  readonly events: PluginEvents;
  readonly ui: PluginUi;
  readonly dispose: (fn: Cleanup) => void;
}

export interface PluginModule {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
`;

/* ---------------- shared scaffold pieces ---------------- */

const entry = extra => `/* {{name}} — a Bentomux plugin.
 *
 * Entry point. Bentomux imports this as an ES module and calls \`activate(ctx)\`
 * the first time the plugin runs.
 *
 * Everything registered here must be declared in plugin.json first.
 * Registering an id the manifest never declared is an error; declaring an id
 * that is never registered is a warning. That pairing is what keeps the
 * manifest an honest description of what the plugin adds.
 *
 * See bentomux-plugin-sdk.d.ts for the full context API. */

/** @param {import('./bentomux-plugin-sdk').PluginContext} ctx */
export function activate(ctx) {
  ctx.log('{{name}} activated');

  ctx.ui.command('{{id}}.hello', () => {
    ctx.log('hello from {{name}}');
  });
${extra}
}

/* Optional. Runs when the plugin is disabled or reloaded. Use ctx.dispose()
   for teardown registered during activate. */
export function deactivate() {}
`;

const manifest = (contributes, permissions = []) => JSON.stringify({
  id: '{{id}}',
  name: '{{name}}',
  version: '{{version}}',
  apiVersion: 1,
  description: '{{description}}',
  author: '{{author}}',
  entry: 'index.js',
  icon: { type: 'builtin', name: 'board' },
  ...(permissions.length ? { permissions } : {}),
  contributes,
}, null, 2) + '\n';

const readme = `# {{name}}

A Bentomux plugin scaffold.

| File | Purpose |
|---|---|
| \`plugin.json\` | The manifest: identity, permissions, and what this plugin contributes. |
| \`index.js\` | The entry point. Bentomux imports it and calls \`activate(ctx)\`. |
| \`bentomux-plugin-sdk.d.ts\` | Types for the context API. |

Edit \`plugin.json\` to change what the plugin adds, then implement the handlers
in \`index.js\`. Validate the result with:

    bentomux --plugin-validate .

Reference: \`docs/PLUGIN_PLATFORM.md\` in the Bentomux repository.
`;

/* ---------------- templates ----------------
   Every one of these is a *valid plugin on disk* after placeholder
   substitution. That is what lets one artifact serve three jobs: the wizard's
   scaffold, the CI fixture, and the example an authoring agent reads. */

const templates = {
  basic: {
    manifest: manifest({
      commands: [{ id: '{{id}}.hello', title: '{{name}}: Hello' }],
    }),
    entry: entry(''),
  },

  sidebar: {
    manifest: manifest({
      commands: [
        { id: '{{id}}.hello', title: '{{name}}: Hello' },
        /* the button and the command it fires are separate contributions and
           need separate ids — one is the row, the other is what it does */
        { id: '{{id}}.open', title: '{{name}}: Open' },
      ],
      sidebar: [{
        id: '{{id}}.sidebar',
        title: '{{name}}',
        icon: { type: 'builtin', name: 'board' },
        command: '{{id}}.open',
      }],
    }),
    entry: entry(`
  /* The sidebar row is rendered from plugin.json before this code runs, and
     the click activates the plugin first — so registering the handler here
     needs no attention to ordering. */
  ctx.ui.command('{{id}}.open', () => {
    ctx.log('sidebar item clicked');
  });
`),
  },

  topbar: {
    manifest: manifest({
      commands: [
        { id: '{{id}}.hello', title: '{{name}}: Hello' },
        { id: '{{id}}.open', title: '{{name}}: Open' },
      ],
      topbar: [{
        id: '{{id}}.topbar',
        title: '{{name}}',
        icon: { type: 'builtin', name: 'board' },
        command: '{{id}}.open',
      }],
    }),
    entry: entry(`
  ctx.ui.command('{{id}}.open', () => {
    ctx.log('topbar button clicked');
  });
`),
  },

  modal: {
    manifest: manifest({
      commands: [{ id: '{{id}}.open', title: '{{name}}: Open dialog' }],
      modals: [{ id: '{{id}}.dialog', title: '{{name}}' }],
    }),
    entry: entry(`
  /* A modal renders into the app's own modal root, so it gets the same
     overlay, focus handling, and Escape behaviour as every built-in dialog. */
  ctx.ui.modal('{{id}}.dialog', host => {
    host.textContent = 'Hello from {{name}}.';

    /* Return a cleanup and it runs when the dialog closes. */
    return () => ctx.log('dialog closed');
  });

  ctx.ui.command('{{id}}.open', () => ctx.ui.openModal('{{id}}.dialog'));
`),
  },

  tab: {
    manifest: manifest({
      commands: [{ id: '{{id}}.open', title: '{{name}}: Open tab' }],
      tabs: [{
        id: '{{id}}.tab',
        title: '{{name}}',
        icon: { type: 'builtin', name: 'board' },
      }],
    }),
    entry: entry(`
  ctx.ui.tab('{{id}}.tab', host => {
    host.textContent = 'Hello from the {{name}} tab.';

    /* Return a cleanup and it runs when the tab body is torn down. */
    return () => ctx.log('tab torn down');
  });

  ctx.ui.command('{{id}}.open', () => ctx.ui.openTab('{{id}}.tab'));
`),
  },

  widget: {
    manifest: manifest({
      commands: [{ id: '{{id}}.count', title: '{{name}}: Count a visit' }],
      widgets: [{ id: '{{id}}.widget', title: '{{name}}' }],
    }, ['storage']),
    entry: entry(`
  /* Widgets appear on the welcome page — the app's dashboard. Keep them to a
     summary: the card is a glance, not a workspace. */
  const paint = async host => {
    const count = (await ctx.storage.get('count')) ?? 0;
    host.textContent = 'Counted ' + count + ' time' + (count === 1 ? '' : 's');
  };

  ctx.ui.widget('{{id}}.widget', host => {
    void paint(host);
    return () => ctx.log('widget removed');
  });

  /* ctx.storage needs the "storage" permission in plugin.json. */
  ctx.ui.command('{{id}}.count', async () => {
    const count = (await ctx.storage.get('count')) ?? 0;
    await ctx.storage.set('count', count + 1);
    ctx.log('count is now', count + 1);
  });
`),
  },

  service: {
    manifest: manifest({
      commands: [{ id: '{{id}}.ping', title: '{{name}}: Ping' }],
      services: [{ id: '{{id}}.worker', title: '{{name}} worker' }],
    }),
    entry: entry(`
  /* A service starts at boot, once the window is interactive. It has no click
     to wait for, so a plugin that declares one is activated eagerly rather
     than lazily. The AbortSignal fires when the plugin is disabled. */
  ctx.ui.service('{{id}}.worker', async signal => {
    ctx.log('worker started');
    while (!signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, 60000));
      if (signal.aborted) break;
      ctx.log('worker tick');
    }
    ctx.log('worker stopped');
  });

  ctx.ui.command('{{id}}.ping', () => ctx.log('pong'));
`),
  },
};

/* ---------------- write ---------------- */

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(SDK, { recursive: true });
writeFileSync(join(SDK, 'bentomux-plugin-sdk.d.ts'), sdkDts);

for (const [name, t] of Object.entries(templates)) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), t.manifest);
  writeFileSync(join(dir, 'index.js'), t.entry);
  writeFileSync(join(dir, 'bentomux-plugin-sdk.d.ts'), sdkDts);
  writeFileSync(join(dir, 'README.md'), readme);
}

console.log('generated ' + Object.keys(templates).length + ' templates: ' + Object.keys(templates).join(', '));
