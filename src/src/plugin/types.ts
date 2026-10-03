/* ---------------- plugin SDK: the types a plugin author writes against ----------------
   Spec: docs/PLUGIN_PLATFORM.md §4–§7. Vocabulary: CONTEXT.md.

   This module is the SDK's source of truth on the renderer side. It mirrors
   the Rust manifest model in src-tauri/src/plugin/mod.rs — the two are kept in
   sync by hand, and `plugin-sdk/bentomux-plugin-sdk.d.ts` is generated from
   this file for authors who want types without the app's source.

   Nothing here imports app internals: a plugin author reads this and the spec,
   not the renderer's module graph. */

/* ---------------- manifest ---------------- */

export interface PluginIcon {
  type: 'builtin' | 'image';
  /** `builtin` only: a name from the host's icon set. */
  name?: string;
  /** `image` only: a path inside the plugin folder, served over `plugin://`. */
  path?: string;
}

export interface Contribution {
  /** Must be namespaced under the plugin id: `<pluginId>.<name>`. */
  id: string;
  title?: string;
  icon?: PluginIcon;
  /** For topbar / sidebar / dock: the command id this entry fires. */
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

export type ContributionKind = keyof Contributions;

export const CONTRIBUTION_KINDS: ContributionKind[] = [
  'commands', 'topbar', 'sidebar', 'dock', 'tabs', 'modals', 'widgets', 'settings', 'services',
];

export interface PluginManifest {
  /** `publisher.name`, both segments `[a-z0-9-]+`. */
  id: string;
  name: string;
  version: string;
  /** Hard gate: the host refuses a major it does not implement. */
  apiVersion: number;
  /** Soft gate: a mismatch warns, it does not refuse. */
  minAppVersion?: string;
  description?: string;
  author?: string;
  entry: string;
  icon?: PluginIcon;
  permissions?: PluginPermission[];
  /** HTTPS origins the plugin may fetch() or load images from. Baked into CSP at build time. */
  network?: string[];
  contributes?: Contributions;
}

/* ---------------- permissions ---------------- */

export type PluginPermission =
  | 'storage'
  | 'app.read'
  | 'app.prefs.write'
  | 'app.window'
  | 'files.temp'
  | 'workspaces.write'
  | 'tabs.write'
  | 'terminal.read'
  | 'terminal.input'
  | 'git.read'
  | 'git.push'
  | 'agents.read'
  | 'agents.write'
  | 'remote.control'
  | 'backend.invoke';

export const ALL_PERMISSIONS: PluginPermission[] = [
  'storage', 'app.read', 'app.prefs.write', 'app.window', 'files.temp',
  'workspaces.write', 'tabs.write', 'terminal.read', 'terminal.input',
  'git.read', 'git.push', 'agents.read', 'agents.write', 'remote.control',
  'backend.invoke',
];

/**
 * Which bridge methods each permission unlocks.
 *
 * This is the *contract* a plugin's manifest declares against — not a
 * security boundary. Plugin code runs in the app's own realm and shares its
 * globals, so a plugin determined to reach past this facade can. What the
 * facade buys is legibility: an undeclared call throws a named error instead
 * of working by accident, and the Studio review screen can show a user
 * exactly what a plugin asked for. See docs/adr/0001.
 */
export const PERMISSION_METHODS: Record<PluginPermission, string[]> = {
  'storage': [],
  'app.read': ['getState', 'onBranch', 'onRuntimeStatus', 'onAgentEvent', 'onAgentApproval', 'onAgentApprovalClosed', 'onFileDrop'],
  'app.prefs.write': ['setPrefs'],
  'app.window': ['minimize', 'toggleMaximize', 'toggleFullscreen', 'close', 'onMaximized', 'quitApp'],
  'files.temp': ['saveTempFile'],
  'workspaces.write': ['chooseFolder', 'addWorkspace', 'removeWorkspace', 'reorderWorkspaces', 'setActiveWorkspace'],
  'tabs.write': ['createTab', 'splitTab', 'setSplitDir', 'renameTab', 'closePane', 'closeTab', 'setActiveTab'],
  'terminal.read': ['onPtyData', 'onPtyExit'],
  'terminal.input': ['writeTab', 'resizeTab'],
  'git.read': ['branchFor', 'gitStatus', 'gitDiff', 'gitDiffStat', 'gitRemoteInfo'],
  'git.push': ['gitPush'],
  'agents.read': ['agents', 'agentConfig', 'listResources', 'agentHooksStatus'],
  'agents.write': ['setAgentModelSettings', 'saveResource', 'deleteResource', 'toggleResource', 'agentHooksInstall', 'agentHooksUninstall', 'resolveApproval'],
  'remote.control': ['remoteInfo', 'remoteSetEnabled', 'remoteSetPort'],
  'backend.invoke': [],
};

/** Commands `backend.invoke` will forward. Read-only on purpose. */
export const BACKEND_ALLOWLIST: string[] = [
  'get_state',
  'git_status',
  'git_diff',
  'git_diff_stat',
  'git_remote_info',
  'git_branch_for',
  'agents_list',
  'agents_config',
  'res_list',
  'agent_hooks_status',
  'remote_info',
];

/* ---------------- registry records ---------------- */

export type PluginSource =
  | { kind: 'bundled' }
  | { kind: 'folder'; path: string }
  | { kind: 'url'; url: string };

export interface PluginRecord {
  id: string;
  version: string;
  previousVersion?: string;
  enabled: boolean;
  source: PluginSource;
  sha256: string;
  installedAt: number;
}

/* ---------------- validation report ---------------- */

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationReport {
  ok: boolean;
  manifest?: PluginManifest;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/* ---------------- runtime context ---------------- */

export type Cleanup = () => void;
/** A render callback may return a cleanup, or nothing. */
export type RenderFn = (host: HTMLElement) => void | Cleanup;

export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface PluginUi {
  /** Register the handler for a command the manifest declared. */
  command(id: string, handler: (args?: unknown) => void | Promise<void>): void;
  /** Register the body renderer for a tab the manifest declared. */
  tab(id: string, render: RenderFn): void;
  modal(id: string, render: RenderFn): void;
  widget(id: string, render: RenderFn): void;
  settingsSection(id: string, build: (paint: () => void) => HTMLElement): void;
  /** Register a background service. Started at boot for plugins that declare one. */
  service(id: string, run: (signal: AbortSignal) => void | Promise<void>): void;

  /**
   * Open a tab this plugin declared. Declaring a tab puts it in the tab
   * strip's add menu; a command handler calls this to open it. Throws when
   * the id was never declared or no renderer is registered for it.
   */
  openTab(id: string): void;
  /** Open a modal this plugin declared, rendered into the app's modal root. */
  openModal(id: string): void;
}

export type PluginHostEvent = 'workspace:changed' | 'tab:activated' | 'tab:closed';

/**
 * The payload each host event carries.
 *
 * `tab:activated` fires twice per tab switch: once with a null `paneId` when
 * the strip moves, and again from the pane once xterm takes focus. Read the
 * last one — a plugin that wants to know which pane the user is looking at
 * cannot get it any other way, since pane focus otherwise lives only in the
 * DOM.
 */
export interface PluginHostEventPayloads {
  'workspace:changed': { workspaceId: string; branch: string | null };
  'tab:activated': { tabId: string | null; paneId: string | null };
  'tab:closed': { tabId: string };
}

export interface PluginEvents {
  on(event: 'workspace:changed', cb: (payload: PluginHostEventPayloads['workspace:changed']) => void): Cleanup;
  on(event: 'tab:activated', cb: (payload: PluginHostEventPayloads['tab:activated']) => void): Cleanup;
  on(event: 'tab:closed', cb: (payload: PluginHostEventPayloads['tab:closed']) => void): Cleanup;
}

export interface PluginContext {
  readonly plugin: { id: string; version: string };
  readonly log: (...args: unknown[]) => void;
  readonly storage: PluginStorage;
  readonly app: Record<string, (...args: never[]) => unknown>;
  readonly events: PluginEvents;
  readonly ui: PluginUi;
  /** Register teardown work; every entry runs on deactivate. */
  readonly dispose: (fn: Cleanup) => void;
}

/** The module shape a plugin's entry must export. */
export interface PluginModule {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/* ---------------- errors ---------------- */

export class PluginError extends Error {
  constructor(message: string, readonly code: string = 'plugin-error') {
    super(message);
    this.name = 'PluginError';
  }
}
