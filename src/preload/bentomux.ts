/* ---------------- preload: typed bridge over Tauri IPC ----------------
   Port of src/preload/index.ts from the Electron build. Mirrors the
   `BentomuxApi` shape 1:1 so existing renderer code keeps working
   unchanged after the migration.

   Deliberately NOT installed on `window`. Plugin code runs in this same
   realm (docs/adr/0001-in-realm-plugin-execution.md), so a global handle
   would hand every installed plugin the full command surface, bypassing
   the permission-scoped `ctx` facade entirely. Renderer modules import
   the default export instead.

   IPC mapping (Electron → Tauri v2):
     ipcRenderer.invoke(channel, ...args) → invoke<T>(cmd, { ...args })
       Tauri takes a SINGLE args object whose keys match the Rust command's
       snake_case parameter names; snake_case ↔ camelCase is automatic on
       the JS side, so we pass camelCase keys (matching the original JS
       call sites) and let Tauri convert.
     ipcRenderer.send(channel, ...args)   → invoke<T>(cmd, { ...args })
       There is no separate fire-and-forget channel; `invoke` is the
       single command path. We call it and ignore the returned promise,
       which matches the original `send` semantics.
     ipcRenderer.on(channel, cb)          → listen<T>(event, cb) and return
       the unlisten function from `listen`.

   Channels (Electron-style `ipcMain.handle/on` names) translate to
   Tauri command names registered in `src-tauri/src/lib.rs`.
   --------------------------------------------------------------- */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type {
  AgentApprovalRequest,
  AgentConfigView,
  AgentEventNotice,
  AgentHooksStatus,
  AgentInfo,
  AppState,
  FileDropEvent,
  GitCommandResult,
  GitDiffResult,
  GitDiffStatResult,
  GitRemoteInfo,
  GitHistoryResult,
  GitCommitDetail,
  GitStatusResult,
  ModelSettingsPatch,
  Prefs,
  RemotePairing,
  ResourceItem,
  ResourceKind,
  ResourceSavePayload,
  RuntimeStatus,
  TabRec,
} from '../shared/types';
import type {
  PluginManifest,
  PluginRecord,
  ValidationReport,
} from '../src/plugin/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | undefined;
  void listen<T>(event, e => cb(e.payload)).then(fn => {
    unlisten = fn;
  });
  return () => {
    if (unlisten) unlisten();
  };
}

async function invokeWithRetry<T>(command: string, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await invoke<T>(command);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise(resolve => window.setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

/* wry reports drag positions in different units per platform, and
   tauri-runtime-wry wraps every one of them in PhysicalPosition without
   converting:
     macOS  (wkwebview)  draggingLocation()/frame() → AppKit points, already
                         flipped to a top-left origin → these ARE CSS pixels
     Linux  (webkitgtk)  connect_drag_motion x/y → GTK logical units → CSS px
     Windows (webview2)  ScreenToClient() → physical pixels, needs / DPR
   Dividing on macOS or Linux would halve the point on a HiDPI screen and
   drop the path into the wrong pane (or no pane at all). */
const DROP_POSITION_SCALE = /Win/.test(navigator.platform) ? (window.devicePixelRatio || 1) : 1;

const api = {
  /* clipboard helpers */
  saveTempFile: (name: string, data: string) => invoke<string>('temp_write_file', { name, data }),

  /* native OS drag & drop. Tauri intercepts drops at the window level, so the
     renderer's HTML5 `drop` event never carries a filesystem path — the only
     way to learn where a dropped file lives is this webview event. Positions
     are normalised to CSS pixels so document.elementFromPoint() can be used. */
  onFileDrop: (cb: (e: FileDropEvent) => void): (() => void) => {
    let unlisten: UnlistenFn | undefined;
    void getCurrentWebview().onDragDropEvent(ev => {
      const p = ev.payload;
      if (p.type === 'leave') return cb({ type: 'leave', x: 0, y: 0, paths: [] });
      const scale = DROP_POSITION_SCALE;
      cb({
        type: p.type,
        x: p.position.x / scale,
        y: p.position.y / scale,
        paths: p.type === 'over' ? [] : p.paths,
      });
    }).then(fn => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  },

  /* window chrome */
  minimize: () => { void invoke('win_minimize'); },
  toggleMaximize: () => { void invoke('win_toggle_maximize'); },
  toggleFullscreen: () => { void invoke('win_toggle_fullscreen'); },
  close: () => { void invoke('win_close'); },
  onMaximized: (cb: (max: boolean) => void) => subscribe<boolean>('win:maximized', cb),
  onFullscreen: (cb: (full: boolean) => void) => subscribe<boolean>('win:fullscreen', cb),

  /* persisted state */
  /* WebView2 can dispatch the first IPC call while its native startup is
     still settling. Retry only this read-only bootstrap call; later commands
     run after boot has completed. */
  getState: () => invokeWithRetry<AppState>('get_state'),
  setPrefs: (partial: Omit<Partial<Prefs>, 'font'> & { font?: string | null }) => invoke<AppState>('prefs_update', { partial }),

  /* workspaces */
  chooseFolder: () => invoke<string | null>('workspace_choose'),
  addWorkspace: (path: string) => invoke<AppState>('workspace_add', { path }),
  removeWorkspace: (id: string) => invoke<AppState>('workspace_remove', { id }),
  reorderWorkspaces: (ids: string[]) => invoke<AppState>('workspace_reorder', { ids }),
  reorderTabs: (ids: string[]) => invoke<AppState>('tab_reorder', { ids }),
  setActiveWorkspace: (id: string | null) => { void invoke('workspace_active', { id }); },

  /* terminal tabs (panes: a tab may hold up to two shells side by side) */
  restoreTabs: () => invoke<TabRec[]>('tab_restore'),
  createTab: (workspaceId: string) => invoke<TabRec>('tab_create', { workspaceId }),
  splitTab: (paneId: string, dir?: 'v' | 'h', key?: string) =>
    invoke<TabRec>('tab_split', { paneId, dir, key }),
  setSplitDir: (nodeKey: string, dir: 'v' | 'h') => { void invoke('tab_set_dir', { nodeKey, dir }); },
  renameTab: (id: string, title: string) => { void invoke('tab_rename', { paneId: id, rawTitle: title }); },
  closePane: (paneId: string) => invoke<AppState>('tab_close_pane', { paneId }),
  closeTab: (id: string) => invoke<AppState>('tab_close', { id }),
  writeTab: (id: string, data: string) => { void invoke('pty_write', { id, data }); },
  resizeTab: (id: string, cols: number, rows: number) => { void invoke('pty_resize', { id, cols, rows }); },
  onPtyData: (cb: (id: string, chunk: string) => void) =>
    /* backend emits `pty:data` as a 2-tuple (id, chunk) → JSON [id, chunk] */
    subscribe<[string, string]>('pty:data', p => cb(p[0], p[1])),
  onPtyExit: (cb: (id: string, code: number) => void) =>
    subscribe<[string, number]>('pty:exit', p => cb(p[0], p[1])),

  /* quitting: stopPanes=false leaves the background daemon and its agents
     running (the default), true stops every pane first */
  quitApp: (stopPanes: boolean) => invoke<void>('app_quit', { stopPanes }),

  /* git */
  branchFor: (path: string) => invoke<string | null>('git_branch_for', { path }),
  onBranch: (cb: (workspaceId: string, branch: string | null) => void) =>
    /* backend emits `branch` as a 2-tuple (workspaceId, branch) → JSON array */
    subscribe<[string, string | null]>('branch', p => cb(p[0], p[1])),
  gitStatus: (workspaceId: string) => invoke<GitStatusResult>('git_status', { workspaceId }),
  gitDiff: (workspaceId: string, path: string | null) =>
    invoke<GitDiffResult>('git_diff', { workspaceId, path }),
  gitDiffStat: (workspaceId: string) => invoke<GitDiffStatResult>('git_diff_stat', { workspaceId }),
  gitPush: (workspaceId: string, setUpstream: boolean) =>
    invoke<GitCommandResult>('git_push', { workspaceId, setUpstream }),
  gitRemoteInfo: (workspaceId: string) => invoke<GitRemoteInfo>('git_remote_info', { workspaceId }),
  gitHistory: (workspaceId: string) => invoke<GitHistoryResult>('git_history', { workspaceId }),
  gitShow: (workspaceId: string, oid: string) => invoke<GitCommitDetail>('git_show', { workspaceId, oid }),

  /* agents & resources */
  agents: () => invoke<AgentInfo[]>('agents_list'),
  agentConfig: (agentId: string) => invoke<AgentConfigView>('agents_config', { agentId }),
  setAgentModelSettings: (agentId: string, patch: ModelSettingsPatch) =>
    invoke<AgentConfigView>('agents_set_model_settings', { agentId, patch }),
  listResources: (kind: ResourceKind) => invoke<ResourceItem[]>('res_list', { kind }),
  saveResource: (p: ResourceSavePayload) => invoke<ResourceItem[]>('res_save', { payload: p }),
  deleteResource: (kind: ResourceKind, id: string) => invoke<ResourceItem[]>('res_delete', { kind, id }),
  toggleResource: (kind: ResourceKind, id: string, on: boolean) =>
    invoke<ResourceItem[]>('res_toggle', { kind, id, on }),

  /* runtime status */
  onRuntimeStatus: (cb: (statuses: Record<string, RuntimeStatus>) => void) =>
    subscribe<Record<string, RuntimeStatus>>('rt:status', cb),

  /* agent approvals (hook bridge) */
  onAgentApproval: (cb: (req: AgentApprovalRequest) => void) =>
    subscribe<AgentApprovalRequest>('agent:approval', cb),
  onAgentApprovalClosed: (cb: (requestId: string) => void) =>
    subscribe<string>('agent:approvalClosed', cb),
  onAgentEvent: (cb: (notice: AgentEventNotice) => void) =>
    subscribe<AgentEventNotice>('agent:event', cb),
  resolveApproval: (requestId: string, decision: 'allow' | 'deny') =>
    invoke<boolean>('agent_approval_resolve', { requestId, decision }),
  approvalPending: () => invoke<AgentApprovalRequest | null>('agent_approval_pending'),
  hideApproval: () => invoke('agent_approval_hide'),
  approvalJump: (paneId: string | null, cwd: string | null) =>
    invoke<void>('agent_approval_jump', { paneId, cwd }),
  setActiveTab: (tabId: string | null) => { void invoke('agent_set_active_tab', { tabId }); },
  agentHooksStatus: () => invoke<AgentHooksStatus>('agent_hooks_status'),
  agentHooksInstall: () => invoke<AgentHooksStatus>('agent_hooks_install'),
  agentHooksUninstall: () => invoke<AgentHooksStatus>('agent_hooks_uninstall'),

  /* remote control (phone browser, HTTPS via cloudflare tunnel) */
  remoteInfo: () => invoke<RemotePairing>('remote_info'),
  remoteSetEnabled: (on: boolean) => invoke<RemotePairing>('remote_set_enabled', { on }),
  remoteSetPort: (port: number) => invoke<RemotePairing>('remote_set_port', { port }),

  /* plugin platform (docs/PLUGIN_PLATFORM.md) */
  pluginList: () => invoke<PluginRecord[]>('plugin_list'),
  pluginChooseFolder: () => invoke<string | null>('plugin_choose_folder'),
  pluginChooseZip: () => invoke<string | null>('plugin_choose_zip'),
  pluginChooseNewFolder: () => invoke<string | null>('plugin_choose_new_folder'),
  pluginTemplates: () => invoke<{ name: string; contributes: string[] }[]>('plugin_templates'),
  pluginSkillTargets: () =>
    invoke<{ agentId: string; agentName: string; path: string; installed: boolean }[]>('plugin_skill_targets'),
  pluginInstallSkill: (agentId: string) =>
    invoke<string>('plugin_install_skill', { agentId }),
  pluginScaffold: (p: {
    template: string; dest: string; id: string; name: string;
    version: string; description: string; author: string;
  }) => invoke<ValidationReport>('plugin_scaffold', p),
  pluginValidate: (path: string, bundled?: boolean) =>
    invoke<ValidationReport>('plugin_validate', { path, bundled }),
  pluginManifest: (id: string) => invoke<PluginManifest>('plugin_manifest', { id }),
  pluginInstallFolder: (path: string) => invoke<PluginRecord>('plugin_install_folder', { path }),
  pluginInstallZip: (path: string) => invoke<PluginRecord>('plugin_install_zip', { path }),
  pluginInstallUrl: (url: string, sha256: string) =>
    invoke<PluginRecord>('plugin_install_url', { url, sha256 }),
  pluginSetEnabled: (id: string, enabled: boolean) =>
    invoke<AppState>('plugin_set_enabled', { id, enabled }),
  pluginUpdate: (path: string) => invoke<PluginRecord>('plugin_update', { path }),
  pluginRollback: (id: string) => invoke<PluginRecord>('plugin_rollback', { id }),
  pluginUninstall: (id: string, removeData: boolean) =>
    invoke<AppState>('plugin_uninstall', { id, removeData }),
  pluginDataGet: (id: string, key: string) => invoke<unknown>('plugin_data_get', { id, key }),
  pluginDataSet: (id: string, key: string, value: unknown) =>
    invoke<void>('plugin_data_set', { id, key, value }),
  pluginDataDelete: (id: string, key: string) => invoke<void>('plugin_data_delete', { id, key }),
  pluginDataKeys: (id: string) => invoke<string[]>('plugin_data_keys', { id }),
  pluginSafeMode: () =>
    invoke<{ safeMode: boolean; attempts: number; requested: boolean }>('plugin_safe_mode'),
  pluginReportReady: () => invoke<void>('plugin_report_ready'),
  pluginLeaveSafeMode: () => invoke<void>('plugin_leave_safe_mode'),
};

/* generic passthrough: the only command path that takes a command name as
   data. Needed for `shutdown_for_update` (a lifecycle command that has no
   place on the app-facing surface) and by the plugin host's allowlisted
   `backend.invoke`. Callers outside the plugin host should prefer a named
   method so the surface stays greppable. */
const raw = {
  invoke: <T = void>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args),
};

export type BentomuxApiType = typeof api;
export default api;
export { raw };
