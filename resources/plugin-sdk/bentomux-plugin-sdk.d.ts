/* Bentomux Plugin SDK — the types a plugin author writes against.
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
  /** Must be namespaced under the plugin id: `<pluginId>.<name>`. */
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
 * The object handed to `activate`.
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
