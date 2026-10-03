/* ============================================================
   Bentomux — shared contract between main, preload and renderer.
   One source of truth for state shapes and the typed IPC API.
   ============================================================ */

export type ResourceKind = 'memory' | 'skills' | 'mcp';
export type AgentId = string;

import type { PaneNode } from './split-tree';
export type { PaneNode } from './split-tree';

/* plugin platform wire types. Defined next to the renderer's plugin host
   (src/src/plugin/types.ts) because that module is also the SDK a plugin
   author reads; re-exported here so the bridge and state shapes stay in one
   contract file. The Rust mirror lives in src-tauri/src/plugin/mod.rs. */
import type {
  PluginManifest,
  PluginRecord,
  ValidationReport,
} from '../src/plugin/types';
export type {
  PluginIcon,
  Contribution,
  Contributions,
  ContributionKind,
  PluginManifest,
  PluginPermission,
  PluginSource,
  PluginRecord,
  ValidationIssue,
  ValidationReport,
} from '../src/plugin/types';
export { ALL_PERMISSIONS, CONTRIBUTION_KINDS, BACKEND_ALLOWLIST } from '../src/plugin/types';

export interface WorkspaceRec {
  id: string;
  path: string;
  name: string;
}

export interface TabRec {
  id: string;
  workspaceId: string;
  /* split view layout; undefined when the tab holds a single pane.
     id is always the first (topmost-leftmost) leaf of the tree. */
  splitTree?: PaneNode;
  /* custom tab title; absent/empty falls back to branch or workspace name */
  title?: string;
}

export type PaletteName = 'default' | 'catppuccin' | 'catppuccin-frappe' | 'catppuccin-macchiato' | 'catppuccin-mocha' | 'rose-pine' | 'gruvbox' | 'dracula' | 'nord' | 'classic' | 'eink' | 'tokyo-night' | 'pastel-pixel' | 'pi-web' | 'custom';
export const PALETTES: PaletteName[] = ['default', 'catppuccin', 'catppuccin-frappe', 'catppuccin-macchiato', 'catppuccin-mocha', 'rose-pine', 'gruvbox', 'dracula', 'nord', 'classic', 'eink', 'tokyo-night', 'pastel-pixel', 'pi-web', 'custom'];

/* Custom palette: three source colors. Every semantic token is derived from
   them in CSS (`:root.palette-custom`), so one set of colors covers both
   light and dark mode. Hex or `rgb(r,g,b)`, anything else is rejected so a
   typo in the settings field can never blank out the app's own tokens. */
export interface CustomPalette {
  bg: string;
  ink: string;
  accent: string;
}
export const CUSTOM_KEYS: Array<keyof CustomPalette> = ['bg', 'ink', 'accent'];
export const DEFAULT_CUSTOM_PALETTE: CustomPalette = { bg: '#11161d', ink: '#e6edf3', accent: '#58a6ff' };

/* Per-zone wallpaper for the app chrome (Settings → Appearance → Background).
   `image` is a bare file name inside app_data_dir/backgrounds/ — the backend
   resolves it there and rejects anything else, so a pref can never point
   outside that directory. Absent fields fall back to the documented
   defaults: fit cover, position 50%/50%, opacity 1, blur 0, dim 0. */
export interface BackgroundPosition {
  x: number; /* 0–100, percent across the image */
  y: number;
}
export type BackgroundFit = 'cover' | 'contain' | 'tile';
export interface BackgroundSpec {
  image: string;
  fit?: BackgroundFit;
  position?: BackgroundPosition;
  /* image transparency over the zone's own color (0–1, default 1) */
  opacity?: number;
  /* css blur in px (default 0) */
  blur?: number;
  /* dark overlay strength for text readability (0–1, default 0) */
  dim?: number;
  /* zoom relative to the fit result, percent (default 100) */
  scale?: number;
}
export interface Backgrounds {
  sidebar?: BackgroundSpec;
  topbar?: BackgroundSpec;
  content?: BackgroundSpec;
  /* behind the terminal text itself — sits on .terminal-page, above the
     workspace wallpaper, and applies to every workspace's panes */
  terminal?: BackgroundSpec;
}

export interface Prefs {
  theme?: 'light' | 'dark' | 'system';
  palette?: PaletteName;
  /* source colors for the 'custom' palette; absent = built-in default */
  customPalette?: CustomPalette;
  /* per-zone background images; absent = plain palette colors */
  backgrounds?: Backgrounds;
  /* terminal font family (CSS font stack) + size in px; absent = built-in default */
  font?: string;
  fontSize?: number;
  /** shell for NEW terminals; absent = auto-detect */
  shell?: 'system' | 'zsh' | 'bash' | 'fish' | 'powershell' | 'cmd' | 'gitbash' | 'wsl';
  /* app-shortcut overrides: action id → accelerator ("ctrl+shift+k") */
  shortcuts?: Record<string, string>;
  paneHidden?: boolean;
  sidebarWidth?: number;
  /* workspace name labels before tab groups in the top bar; absent = shown */
  showTabGroupNames?: boolean;
  /* terminal split divider positions: split-node key → '%' of the axis */
  paneRatios?: Record<string, number>;
  expanded?: Record<string, boolean>;
  /* last custom tab title per workspace; new tabs inherit it so closing
     a tab never loses the name */
  tabTitles?: Record<string, string>;
  /* folders picked through the add-workspace menu, newest first (capped at 8);
     feeds the "Recent Folder" submenu */
  recentFolders?: string[];
  /* user-resized approval overlay window (px); absent = built-in default */
  approvalOverlay?: { w: number; h: number };
  /* agent approval notifications; absent = enabled (overlay pop + chime) */
  notifEnabled?: boolean;
  notifSound?: boolean;
  /* remote monitor (phone browser); absent = disabled */
  remote?: RemotePrefs;
  /* auto-update; absent = enabled */
  autoUpdate?: boolean;
}

export interface RemotePrefs {
  enabled?: boolean;
  port?: number;
  /* pairing token embedded in the QR URL; generated on first enable so
     paired devices survive restarts */
  token?: string;
}

/* toggle-off definitions with no native flag in the agent's own config
   live here so toggling back on restores them exactly */
export interface ResourceSnapshot {
  kind: ResourceKind;
  name: string;
  updatedAt: number;
  data: Record<string, unknown>;
}

export type ShadowStore = Record<AgentId, Partial<Record<ResourceKind, Record<string, ResourceSnapshot>>>>;

export interface AppState {
  version: number;
  workspaces: WorkspaceRec[];
  openTabs: TabRec[];
  activeWorkspaceId: string | null;
  shadow: ShadowStore;
  prefs: Prefs;
  /* detected agent runtimes; populated by main on boot + on every
     `agents:list` IPC so the sidebar/detail page can render without
     a separate fetch */
  agents: AgentInfo[];
  /* installed plugins — the registry only. Plugin code lives under
     app_data_dir/plugins/<id>/<version>/; see docs/PLUGIN_PLATFORM.md. */
  plugins: PluginRecord[];
}

export interface Capabilities {
  memory: boolean;
  skills: boolean;
  mcp: boolean;
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  detected: boolean;
  capabilities: Capabilities;
  /* the agent's current default model, if any (null when no model form) */
  currentModel: string | null;
  /* config file path the adapter writes to; null when read-only */
  configPath: string | null;
}

/* editable model settings exposed on an agent's Model tab */
export type ModelField = 'model' | 'baseUrl' | 'context' | 'apiKey' | 'format';

export interface FormatChoice {
  value: string;
  label: string;
}

export interface ModelSettingsView {
  model: string;
  baseUrl: string;
  context: string;
  format: string;
  /* the stored key is never sent back to the renderer — presence only */
  hasApiKey: boolean;
}

export interface ModelSettingsPatch {
  model?: string;
  baseUrl?: string;
  context?: string;
  /* new key value; undefined = keep current, null = clear */
  apiKey?: string | null;
  format?: string;
}

export interface AgentConfigView {
  id: AgentId;
  name: string;
  detected: boolean;
  capabilities: Capabilities;
  currentModel: string | null;
  /* null when the agent exposes no editable model settings */
  modelSettings: ModelSettingsView | null;
  /* which fields the form renders, in display order */
  modelFields: ModelField[];
  /* choices for the format field; empty means free-text input */
  modelFormats: FormatChoice[];
  /* well-known model ids offered as suggestions (custom ids always allowed) */
  modelSuggestions: string[];
  /* file(s) the Apply button actually writes to */
  modelWriteTarget: string | null;
  configPath: string | null;
  /* live counts of each resource kind the agent already owns; drives the
     "Configure" buttons on the agent settings modal */
  counts: ResourceCounts;
}

export interface ResourceCounts {
  memory: number;
  skills: number;
  mcp: number;
}

/* ---------------- resource definitions (what lands in agent files) ---------------- */

export interface MemoryDef {
  scope: 'global' | 'project';
  workspacePath?: string | null;
  content: string;
}

export interface SkillDef {
  description: string;
  instructions: string;
}

export interface McpDef {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type ResourceDef = MemoryDef | SkillDef | McpDef;

/* normalized item as shown on a Resources page card */
export interface ResourceItem {
  id: string;
  kind: ResourceKind;
  name: string;
  agentIds: AgentId[];
  status: 'on' | 'off';
  updated: number;
  /* memory */
  scope?: 'global' | 'project';
  workspacePath?: string | null;
  content?: string;
  /* skills */
  description?: string;
  instructions?: string;
  /* mcp */
  configJson?: string;
}

export interface ResourceSavePayload {
  kind: ResourceKind;
  id: string | null; /* null = create */
  name: string;
  agentIds: AgentId[];
  enabled: boolean;
  scope?: 'global' | 'project';
  workspacePath?: string | null;
  content?: string;
  instructions?: string;
  configJson?: string;
}

/* ---------------- git operations (main-side CLI wrappers) ---------------- */

export interface GitStatusEntry {
  path: string;
  /** two-letter XY status, e.g. " M", "M ", "A ", "??", "R " */
  status: string;
  indexStatus: string;
  workTreeStatus: string;
}

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  hasUntracked: boolean;
}

export interface GitFileDiff {
  path: string;
  status: string;
  patch: string;
}

export interface GitDiffResult {
  isRepo: boolean;
  files: GitFileDiff[];
}

export interface GitDiffStatResult {
  isRepo: boolean;
  additions: number;
  deletions: number;
}

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitRemoteInfo {
  isRepo: boolean;
  remote: string | null;
  defaultBranch: string | null;
}

/** A branch, remote-tracking branch, or tag pointing at a commit. */
export interface GitRef {
  name: string;
  kind: 'branch' | 'remote' | 'tag';
  /** true for the branch HEAD is on */
  head: boolean;
}

/** One commit in the graph. `parents` is what the renderer draws lanes from. */
export interface GitCommit {
  oid: string;
  short: string;
  parents: string[];
  author: string;
  /** unix seconds */
  timestamp: number;
  subject: string;
  refs: GitRef[];
}

export interface GitHistoryResult {
  isRepo: boolean;
  commits: GitCommit[];
}

/** One changed file inside a commit, with its patch and its own line counts. */
export interface GitCommitFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

/** Everything the commit detail page renders. */
export interface GitCommitDetail {
  isRepo: boolean;
  oid: string;
  short: string;
  author: string;
  email: string;
  /** unix seconds */
  timestamp: number;
  subject: string;
  /** the commit message with its subject line removed */
  body: string;
  parents: string[];
  refs: GitRef[];
  files: GitCommitFile[];
  additions: number;
  deletions: number;
}

/* ---------------- agent runtime detection ----------------
   herdr-style: process identity from the process table plus a
   screen-manifest state evaluation over the live terminal buffer. */

export type AgentRunState = 'idle' | 'working' | 'blocked';

export interface RuntimeStatus {
  running: boolean;
  runtime: string | null;
  /* semantic state; null when no known agent owns the tab */
  state?: AgentRunState | null;
  /* which rule/manifest produced the state — for debugging */
  matchedRule?: string | null;
  /* how the state was derived */
  source?: 'manifest' | 'activity' | 'process' | null;
}

/* ---------------- agent approvals (hook bridge) ----------------
   Agents with Bentomux's managed hooks forward events to the main-process
   bridge; PermissionRequest stays blocked until the user decides. */

export interface AgentApprovalRequest {
  requestId: string;
  /* terminal pane (term id) the agent runs in; null when the session was
     not launched from Bentomux — jump falls back to matching cwd */
  paneId: string | null;
  agent: string;
  toolName: string;
  /* human-readable one-liner: bash command text or compact JSON input */
  summary: string;
  cwd: string | null;
  sessionId: string | null;
}

export interface AgentEventNotice {
  /* jump only: focus Bentomux and land on the requesting pane */
  kind: 'jump';
  paneId: string | null;
  agent: string;
  message: string;
  cwd: string | null;
  sessionId: string | null;
}

export interface AgentHooksStatus {
  installed: boolean;
  settingsPath: string;
  error: string | null;
}

/* ---------------- remote monitor (phone browser) ----------------
   Optional HTTP+WS server in main that mirrors pane screens and relays
   agent approvals to a paired phone. Read-only except approve/deny. */

export interface RemotePaneInfo {
  id: string;
  title: string;
  workspace: string;
  state: AgentRunState | null;
  runtime: string | null;
}

export interface RemotePairing {
  enabled: boolean;
  running: boolean;
  port: number;
  token: string;
  /* the single pairing URL (tunnel URL + token); empty while the tunnel
     URL is still pending */
  urls: string[];
  /* data URL of the primary URL as a QR code; null on failure */
  qr: string | null;
  /* last server start failure (e.g. port already in use) */
  error: string | null;
  /* cloudflare quick tunnel: the https://trycloudflare.com URL with the
     token attached, once cloudflared prints it */
  tunnelUrl: string | null;
  tunnelQr: string | null;
  tunnelError: string | null;
}

/* ---------------- the preload bridge ---------------- */

/** A native OS drag & drop over the webview. `x`/`y` are CSS pixels relative
 *  to the window origin (the bridge normalises Tauri's per-platform raw
 *  coordinates). `paths` carries absolute filesystem paths for `enter`/`drop`,
 *  empty otherwise. */
export interface FileDropEvent {
  type: 'enter' | 'over' | 'drop' | 'leave';
  x: number;
  y: number;
  paths: string[];
}

export interface BentomuxApi {
  /* clipboard helpers: stage pasted clipboard bytes as a temp file and
     return its absolute path */
  saveTempFile(name: string, data: string): Promise<string>;

  /* native file drag & drop over the window */
  onFileDrop(cb: (e: FileDropEvent) => void): () => void;

  /* window chrome */
  minimize(): void;
  toggleMaximize(): void;
  toggleFullscreen(): void;
  close(): void;
  onMaximized(cb: (max: boolean) => void): () => void;
  onFullscreen(cb: (full: boolean) => void): () => void;

  /* persisted app state */
  getState(): Promise<AppState>;
  setPrefs(partial: Omit<Partial<Prefs>, 'font'> & { font?: string | null }): Promise<AppState>;

  /* zone background images (Settings → Appearance → Background) */
  backgroundPick(): Promise<string | null>;
  backgroundRead(name: string): Promise<{ mime: string; data: string }>;
  backgroundDelete(name: string): Promise<void>;

  /* workspaces */
  chooseFolder(): Promise<string | null>;
  addWorkspace(path: string): Promise<AppState>;
  removeWorkspace(id: string): Promise<AppState>;
  /** persist a new sidebar order; `ids` must be a permutation of the current workspace ids */
  reorderWorkspaces(ids: string[]): Promise<AppState>;
  /** persist terminal tab order; `ids` must be a permutation of current tabs */
  reorderTabs(ids: string[]): Promise<AppState>;
  setActiveWorkspace(id: string | null): void;

  /* terminal tabs (panes: recursive splits, side by side or stacked) */
  restoreTabs(): Promise<TabRec[]>;
  createTab(workspaceId: string): Promise<TabRec>;
  splitTab(paneId: string, dir?: 'v' | 'h', key?: string, before?: boolean): Promise<TabRec>;
  setSplitDir(nodeKey: string, dir: 'v' | 'h'): void;
  renameTab(id: string, title: string): void;
  closePane(paneId: string): Promise<AppState>;
  closeTab(id: string): Promise<AppState>;
  writeTab(id: string, data: string): void;
  resizeTab(id: string, cols: number, rows: number): void;
  onPtyData(cb: (id: string, chunk: string) => void): () => void;
  onPtyExit(cb: (id: string, code: number) => void): () => void;
  /* stopPanes=false keeps the background daemon (and its agents) alive */
  quitApp(stopPanes: boolean): Promise<void>;

  /* git */
  branchFor(path: string): Promise<string | null>;
  onBranch(cb: (workspaceId: string, branch: string | null) => void): () => void;
  gitStatus(workspaceId: string): Promise<GitStatusResult>;
  gitDiff(workspaceId: string, path: string | null): Promise<GitDiffResult>;
  gitDiffStat(workspaceId: string): Promise<GitDiffStatResult>;
  gitPush(workspaceId: string, setUpstream: boolean): Promise<GitCommandResult>;
  gitRemoteInfo(workspaceId: string): Promise<GitRemoteInfo>;
  gitHistory(workspaceId: string): Promise<GitHistoryResult>;
  gitShow(workspaceId: string, oid: string): Promise<GitCommitDetail>;

  /* agents & resources */
  agents(): Promise<AgentInfo[]>;
  agentConfig(agentId: string): Promise<AgentConfigView>;
  setAgentModelSettings(agentId: string, patch: ModelSettingsPatch): Promise<AgentConfigView>;
  listResources(kind: ResourceKind): Promise<ResourceItem[]>;
  saveResource(p: ResourceSavePayload): Promise<ResourceItem[]>;
  deleteResource(kind: ResourceKind, id: string): Promise<ResourceItem[]>;
  toggleResource(kind: ResourceKind, id: string, on: boolean): Promise<ResourceItem[]>;

  /* agent runtime status per tab */
  onRuntimeStatus(cb: (statuses: Record<string, RuntimeStatus>) => void): () => void;

  /* agent approvals (hook bridge) */
  onAgentApproval(cb: (req: AgentApprovalRequest) => void): () => void;
  onAgentApprovalClosed(cb: (requestId: string) => void): () => void;
  onAgentEvent(cb: (notice: AgentEventNotice) => void): () => void;
  resolveApproval(requestId: string, decision: 'allow' | 'deny'): void;
  /* overlay-only: read the still-pending request, and dismiss the island */
  approvalPending(): Promise<AgentApprovalRequest | null>;
  hideApproval(): Promise<void>;
  /* destroy the overlay window (window.close() is refused by WebView2) */
  approvalDismiss(): Promise<void>;
  /* focus Bentomux and jump to the requesting pane (overlay Jump button) */
  approvalJump(paneId: string | null, cwd: string | null): void;
  agentHooksStatus(): Promise<AgentHooksStatus>;
  agentHooksInstall(): Promise<AgentHooksStatus>;
  agentHooksUninstall(): Promise<AgentHooksStatus>;

  /* remote control (phone browser, HTTPS via cloudflare tunnel) */
  remoteInfo(): Promise<RemotePairing>;
  remoteSetEnabled(on: boolean): Promise<RemotePairing>;
  remoteSetPort(port: number): Promise<RemotePairing>;

  /* plugin platform (docs/PLUGIN_PLATFORM.md) */
  pluginList(): Promise<PluginRecord[]>;
  pluginChooseFolder(): Promise<string | null>;
  pluginChooseZip(): Promise<string | null>;
  pluginChooseNewFolder(): Promise<string | null>;
  pluginTemplates(): Promise<{ name: string; contributes: string[] }[]>;
  pluginSkillTargets(): Promise<{ agentId: string; agentName: string; path: string; installed: boolean }[]>;
  pluginInstallSkill(agentId: string): Promise<string>;
  pluginScaffold(p: {
    template: string; dest: string; id: string; name: string;
    version: string; description: string; author: string;
  }): Promise<ValidationReport>;
  pluginValidate(path: string, bundled?: boolean): Promise<ValidationReport>;
  pluginManifest(id: string): Promise<PluginManifest>;
  pluginInstallFolder(path: string): Promise<PluginRecord>;
  pluginInstallZip(path: string): Promise<PluginRecord>;
  pluginInstallUrl(url: string, sha256: string): Promise<PluginRecord>;
  pluginSetEnabled(id: string, enabled: boolean): Promise<AppState>;
  pluginUpdate(path: string): Promise<PluginRecord>;
  pluginRollback(id: string): Promise<PluginRecord>;
  pluginUninstall(id: string, removeData: boolean): Promise<AppState>;
  pluginDataGet(id: string, key: string): Promise<unknown>;
  pluginDataSet(id: string, key: string, value: unknown): Promise<void>;
  pluginDataDelete(id: string, key: string): Promise<void>;
  pluginDataKeys(id: string): Promise<string[]>;
  pluginSafeMode(): Promise<{ safeMode: boolean; attempts: number; requested: boolean }>;
  pluginReportReady(): Promise<void>;
  pluginLeaveSafeMode(): Promise<void>;
}
