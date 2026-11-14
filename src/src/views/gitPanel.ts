/* ---------------- Git Tools (right-side panel) ----------------
   Shows status, a navigable file list (clicking a file opens the diff in
   its own titlebar tab). Also owns the live `+N -N` text for the Changes
   pill in the titlebar; `main.ts` imports `refreshChangesPill` to trigger
   the update at boot (and any time the active workspace changes) so the
   pill is accurate even before the user opens the panel. */

import { h } from '../dom';
import { db } from '../store';
import { ui } from '../state';
import { go } from '../router';
import type {
  GitStatusResult, GitRemoteInfo, GitStatusEntry, GitHistoryResult,
} from '../../shared/types';
import api from '../../preload/bentomux';
import { openModal } from '../components/modal';
import { openContextMenu } from '../components/menu';
import { selectGitFile } from '../../shared/git-selection';
import { gitActionTargets, gitChangeRows, hasStagedChanges, type GitChangeGroup, type GitChangeRow } from '../../shared/git-changes';

interface PanelState {
  status: GitStatusResult | null;
  remote: GitRemoteInfo | null;
  /* null until the first fetch; the graph is not re-fetched by the silent
     poll because `git log --all` is far heavier than `git status` */
  history: GitHistoryResult | null;
  /* the rendered graph node, reused across repaints while the commits are
     unchanged — otherwise a background status change rebuilds 200 rows and
     throws away the graph's scroll position */
  graph: { key: string; node: HTMLElement } | null;
  /* a refresh (mount or button) is in flight and the panel shows a spinner */
  loading: boolean;
  /* any git pass is in flight, including silent background polls */
  inflight: boolean;
  busy: boolean;
  message: string;
  error: string;
  selected: Set<string>;
  anchor: string | null;
}

/* the panel is mounted once per (open, workspace) pair and then polls itself,
   so the sidebar's 1 Hz re-render no longer re-runs the git shellouts */
const PANEL_POLL_MS = 4000;
const PILL_POLL_MS = 15000;
const changesCollapsed = { staged: false, unstaged: false };
let historyCollapsed = false;
let historyHeight = 180;

/* Shared pill/panel scheduler: the titlebar pill heartbeat stands down while
   the panel's own poll covers the active workspace, so the two never race
   two git processes at the same numstat. */
let panelPolling = false;
let pillTimer: ReturnType<typeof setInterval> | null = null;
const diffStatInflight = new Map<string, ReturnType<typeof api.gitDiffStat>>();

function gitDiffStat(wsId: string): ReturnType<typeof api.gitDiffStat> {
  const existing = diffStatInflight.get(wsId);
  if (existing) return existing;
  const request = api.gitDiffStat(wsId).finally(() => { diffStatInflight.delete(wsId); });
  diffStatInflight.set(wsId, request);
  return request;
}

export function notifyPanelPolling(active: boolean): void {
  panelPolling = active;
}

/* The live panel poll, if any. A workspace switch builds a new root while the
   old interval is still waiting out its 4s tick — clear it at supersede/close
   time instead of letting the detached panel keep polling (and repainting the
   titlebar pill with the previous workspace's numbers). */
let activePoll: ReturnType<typeof setInterval> | null = null;

export function stopPanelPoll(): void {
  if (activePoll !== null) { clearInterval(activePoll); activePoll = null; }
  notifyPanelPolling(false);
}

export function startPillHeartbeat(): void {
  if (pillTimer !== null) return;
  pillTimer = setInterval(() => {
    if (ui.gitPanelOpen || panelPolling) return;
    if (document.visibilityState !== 'visible') return;
    void refreshChangesPill();
  }, PILL_POLL_MS);
}

function activeWsId(): string | null {
  return db.activeWorkspaceId;
}

/* shared with the commit detail page, which shows the same per-file badges */
export function formatStatusBadge(xy: string): string {
  /* a one-letter per side (X = index, Y = worktree) is enough for the user;
     the full XY is in the title attribute. */
  if (xy === '??') return 'U';
  if (xy === '!!') return 'I';
  const x = xy[0] || ' ';
  const y = xy[1] || ' ';
  return (x === ' ' ? '·' : x) + (y === ' ' ? '·' : y);
}

export function fileRowTitle(xy: string): string {
  if (xy === '??') return 'Untracked';
  if (xy === '!!') return 'Ignored';
  const map: Record<string, string> = {
    M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed',
  };
  const x = xy[0] || ' ';
  const y = xy[1] || ' ';
  return [map[x] || x, map[y] || y].filter(s => s !== ' ').join(' / ');
}

function buildHeader(state: PanelState, paint: () => void): HTMLElement {
  const ws = db.workspaces.find(w => w.id === activeWsId());
  const name = ws?.name || 'No workspace';
  const branch = state.status?.branch ?? null;
  return h('div', { class: 'right-sidebar-h' },
    h('div', { class: 'grow' },
      h('b', {}, 'Git · ' + name),
      h('div', { class: 'muted', style: 'margin-top:2px' }, state.status?.isRepo === false ? 'Not a git repository' : (branch ? 'On ' + branch : 'Detached HEAD'))),
    h('button', {
      class: 'tbtn',
      title: state.loading ? 'Refreshing…' : 'Refresh',
      onclick: () => void refresh(state, paint),
      'aria-label': 'Refresh',
      disabled: state.loading || state.busy,
    },
      h('span', { style: 'font-size:14px' }, '↻')));
}

function buildFilesList(state: PanelState, paint: () => void): HTMLElement {
  const list = h('div', { class: 'git-files-list' });
  const wrap = h('div', { class: 'git-section git-files' + (changesCollapsed.staged && changesCollapsed.unstaged ? ' collapsed' : '') }, list);

  if (!state.status) {
    list.append(h('div', { class: 'git-empty' }, 'Loading…'));
    return wrap;
  }
  if (state.status.isRepo === false) {
    list.append(h('div', { class: 'git-empty' }, 'Initialize a repository to use Git Tools.'));
    return wrap;
  }
  const wsId = activeWsId();
  if (!wsId) return wrap;
  const rows = gitChangeRows(state.status.entries);
  for (const [group, label] of [['staged', 'Staged'], ['unstaged', 'Unstaged']] as const) {
    const items = rows.filter(row => row.group === group);
    const toggle = h('button', {
      class: 'git-change-group', type: 'button', 'aria-expanded': String(!changesCollapsed[group]),
      onclick: () => {
        changesCollapsed[group] = !changesCollapsed[group];
        if (changesCollapsed[group]) {
          for (const item of items) state.selected.delete(item.key);
          if (state.anchor && items.some(item => item.key === state.anchor)) state.anchor = null;
        }
        paint();
      },
    }, h('span', { 'aria-hidden': 'true' }, changesCollapsed[group] ? '▸' : '▾'),
    h('span', { class: 'grow' }, label), h('span', { class: 'muted' }, String(items.length)));
    const actions = h('button', {
      class: 'tbtn git-changes-actions', type: 'button', title: label + ' actions', 'aria-label': label + ' actions',
      disabled: state.busy || state.inflight || !items.length,
      onclick: () => {
        const rect = actions.getBoundingClientRect();
        openBulkMenu(rect.left, rect.bottom, group, state, paint);
      },
    }, '⋯');
    list.append(h('div', { class: 'git-changes-header' }, toggle, actions));
    if (!changesCollapsed[group]) for (const row of items) list.append(fileRow(row, wsId, state, paint));
  }
  return wrap;
}

function statusMark(status: string, label: string): HTMLElement {
  const kind: Record<string, string> = { M: 'modified', A: 'added', '?': 'added', D: 'deleted', U: 'conflict', R: 'other', C: 'other', T: 'modified' };
  const text = status === ' ' ? '·' : status;
  return h('span', { class: 'git-status-mark ' + (kind[status] || 'other'), title: label, 'aria-label': label }, text);
}

function fileRow(row: GitChangeRow, wsId: string, state: PanelState, paint: () => void): HTMLElement {
  const { entry, group, key } = row;
  /* the right panel's file list is a navigator; each file's diff opens as
     its own titlebar tab (route `{ view: 'diff', workspaceId, path }` —
     setRoute() re-activates the existing tab when the file is already open).
     The active file is whichever one `ui.route` is currently viewing. */
  const active = ui.route.view === 'diff' && ui.route.workspaceId === wsId && ui.route.path === entry.path && !!ui.route.staged === (group === 'staged');
  const conflict = entry.status.includes('U') || ['AA', 'DD'].includes(entry.status);
  const btn = h('button', {
    class: 'git-file-row' + (active ? ' active' : '') + (state.selected.has(key) ? ' selected' : ''),
    'data-key': key,
    'aria-pressed': String(state.selected.has(key)),
    type: 'button',
    title: (conflict ? 'Merge conflict' : fileRowTitle(entry.status)) + ' — ' + entry.path,
    'aria-label': entry.path + ' — ' + group + ' — ' + (conflict ? 'Merge conflict' : fileRowTitle(entry.status)),
    onclick: (e: MouseEvent) => {
      const selection = selectGitFile(gitChangeRows(state.status?.entries ?? []).filter(item => !changesCollapsed[item.group]).map(item => item.key), state.selected, state.anchor, key, e.ctrlKey || e.metaKey, e.shiftKey);
      state.selected = selection.selected;
      state.anchor = selection.anchor;
      syncFileSelection(btn, state);
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) go({ view: 'diff', workspaceId: wsId, path: entry.path, staged: group === 'staged' });
    },
    oncontextmenu: (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.selected.has(key)) {
        state.selected = new Set([key]);
        state.anchor = key;
        syncFileSelection(btn, state);
      }
      openFileMenu(e.clientX, e.clientY, state, paint);
    },
  },
    h('span', { class: 'git-status-marks' },
      ...(conflict ? [statusMark('U', 'Merge conflict')]
        : entry.status === '??' ? [statusMark('?', 'Untracked')]
        : [statusMark(group === 'staged' ? entry.indexStatus : entry.workTreeStatus, group + ': ' + fileRowTitle(group === 'staged' ? entry.indexStatus + ' ' : ' ' + entry.workTreeStatus))])),
    h('span', { class: 'name' }, entry.path));
  return btn;
}

function syncFileSelection(row: HTMLElement, state: PanelState): void {
  for (const item of row.closest('.git-files-list')?.querySelectorAll<HTMLElement>('.git-file-row') ?? []) {
    const selected = state.selected.has(item.dataset.key ?? '');
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-pressed', String(selected));
  }
}

function openFileMenu(x: number, y: number, state: PanelState, paint: () => void): void {
  const wsId = activeWsId();
  if (!wsId) return;
  const rows = gitChangeRows(state.status?.entries ?? []).filter(row => state.selected.has(row.key));
  const staged = gitActionTargets(rows, 'staged').entries;
  const unstaged = gitActionTargets(rows, 'unstaged').entries;
  const busy = state.busy || state.inflight;
  const label = (action: string, count: number): string => `${action} ${count} ${count === 1 ? 'file' : 'files'}`;
  openContextMenu(x, y, [
    { label: label('Stage', unstaged.length), disabled: busy || !unstaged.length, action: () => void runFileActions(state, paint, 'stage', unstaged, wsId) },
    { label: label('Unstage', staged.length), disabled: busy || !staged.length, action: () => void runFileActions(state, paint, 'unstage', staged, wsId) },
    { sep: true },
    { label: label('Discard', unstaged.length), disabled: busy || !unstaged.length, action: () => confirmDiscard(state, paint, unstaged, wsId) },
  ]);
}

function openBulkMenu(x: number, y: number, group: GitChangeGroup, state: PanelState, paint: () => void): void {
  const wsId = activeWsId();
  if (!wsId) return;
  const rows = gitChangeRows(state.status?.entries ?? []);
  const staged = gitActionTargets(rows, 'staged');
  const unstaged = gitActionTargets(rows, 'unstaged');
  const busy = state.busy || state.inflight;
  const label = (name: string, target: typeof staged): string =>
    `${name} (${target.entries.length}${target.unsupported ? `; ${target.unsupported} unsupported` : ''})`;
  openContextMenu(x, y, group === 'staged' ? [
    { label: label('Unstage all', staged), disabled: busy || !staged.entries.length, action: () => void runFileActions(state, paint, 'unstage', staged.entries, wsId) },
  ] : [
    { label: label('Stage all', unstaged), disabled: busy || !unstaged.entries.length, action: () => void runFileActions(state, paint, 'stage', unstaged.entries, wsId) },
    { sep: true },
    { label: label('Discard all unstaged', unstaged), disabled: busy || !unstaged.entries.length, action: () => confirmDiscard(state, paint, unstaged.entries, wsId) },
  ]);
}

function confirmDiscard(state: PanelState, paint: () => void, entries: GitStatusEntry[], wsId = activeWsId()): void {
  const untracked = entries.filter(entry => entry.status === '??').length;
  const modal = openModal({ title: 'Discard changes', body: [
    h('p', {}, `Discard unstaged changes in ${entries.length} ${entries.length === 1 ? 'file' : 'files'}? Staged changes are kept.`),
    untracked ? h('p', {}, `${untracked} untracked ${untracked === 1 ? 'file will' : 'files will'} be permanently deleted.`) : null,
    h('p', {}, 'This cannot be undone.'),
    h('ul', { class: 'git-discard-files' }, ...entries.map(entry => h('li', {}, entry.path))),
  ] });
  modal.foot.append(
    h('button', { class: 'btn', onclick: () => modal.close() }, 'Cancel'),
    h('button', { class: 'btn danger', onclick: () => { modal.close(); void runFileActions(state, paint, 'discard', entries, wsId); } }, 'Discard'),
  );
}

async function runFileActions(state: PanelState, paint: () => void, action: 'stage' | 'unstage' | 'discard', entries: GitStatusEntry[], wsId = activeWsId()): Promise<void> {
  if (!wsId || wsId !== activeWsId() || state.busy || state.inflight) return;
  state.busy = true;
  state.error = '';
  paint();
  const errors: string[] = [];
  for (const entry of entries) {
    try {
      const operation = action === 'discard' ? (entry.status === '??' ? 'discard-untracked' : 'discard-tracked') : action;
      await api.gitManage(wsId, operation, entry.path);
    }
    catch (error) { errors.push(`${entry.path}: ${String(error)}`); }
  }
  state.error = errors.join('\n');
  state.busy = false;
  if (wsId === activeWsId()) await refresh(state, paint);
}

async function commit(state: PanelState, paint: () => void): Promise<void> {
  const wsId = activeWsId();
  if (!wsId || state.busy || state.inflight || !state.status?.isRepo || !hasStagedChanges(state.status.entries)) return;
  if (!state.message.trim()) {
    state.error = 'Commit message cannot be empty.';
    paint();
    return;
  }
  state.busy = true;
  state.error = '';
  paint();
  try {
    await api.gitManage(wsId, 'commit', state.message);
    state.message = '';
  } catch (error) {
    state.error = String(error);
  } finally {
    state.busy = false;
    if (wsId === activeWsId()) await refresh(state, paint, { history: true });
  }
}

function buildControls(state: PanelState, paint: () => void): HTMLElement {
  const disabled = state.busy || state.inflight || !state.status?.isRepo;
  const staged = hasStagedChanges(state.status?.entries ?? []);
  const message = h('input', { type: 'text', placeholder: 'Write a commit message…', 'aria-label': 'Commit message', disabled }) as HTMLInputElement;
  const button = h('button', { class: 'btn primary', type: 'button', disabled: disabled || !staged, onclick: () => void commit(state, paint) }, 'Commit');
  message.value = state.message;
  message.addEventListener('input', () => { state.message = message.value; });
  return h('div', { class: 'git-section git-commit' },
    h('div', { class: 'git-section-h' }, 'Commit'), message,
    button,
    state.error ? h('div', { class: 'git-action-error', role: 'alert' }, state.error) : null);
}

/* ---------------- history (commit graph) ---------------- */

/* a graph rebuild is worth avoiding when nothing moved; the oids and the ref
   decorations are everything the rendering depends on */
function graphKey(commits: GitHistoryResult['commits']): string {
  return commits.length + '|' + (commits[0]?.oid ?? '') + '|' +
    commits.flatMap(c => c.refs.map(r => r.name + (r.head ? '*' : ''))).join(',');
}

/* the active commit lives in ui.route, so the panel has to repaint when the
   route moves or the selected graph row keeps the previous highlight */
function activeCommitOid(): string {
  return ui.route.view === 'commit' ? ui.route.oid : '';
}

/* the selection lives in ui.route, so it is applied to the cached graph node in
   place. Rebuilding the panel to change one class would reset the changes
   list's scroll position on every commit click. */
function markActive(node: HTMLElement, oid: string): void {
  for (const row of node.querySelectorAll<HTMLElement>('.git-graph-row')) {
    row.classList.toggle('active', row.dataset.oid === oid);
  }
}

function buildHistory(state: PanelState, paint: () => void): HTMLElement {
  const commits = state.history?.commits ?? null;
  const body = h('div', { class: 'git-history-body' });
  const wrap = h('div', { class: 'git-section git-history' + (historyCollapsed ? ' collapsed' : '') },
    h('button', {
      class: 'git-history-toggle', type: 'button', 'aria-expanded': String(!historyCollapsed),
      onclick: () => { historyCollapsed = !historyCollapsed; paint(); },
    }, h('span', { 'aria-hidden': 'true' }, historyCollapsed ? '▸' : '▾'),
    h('span', { class: 'grow' }, 'History'),
    h('span', { class: 'muted' }, commits ? commits.length + ' commits' : '')));
  if (historyCollapsed) return wrap;
  wrap.style.height = historyHeight + 'px';
  const resize = h('div', {
    class: 'git-history-resize', role: 'separator', tabindex: '0', 'aria-label': 'Resize history',
    'aria-orientation': 'horizontal', 'aria-valuemin': '80',
    'aria-valuenow': String(historyHeight),
  });
  const setHeight = (height: number): void => {
    const parent = wrap.parentElement;
    const controls = parent?.querySelector<HTMLElement>('.git-commit');
    const files = parent?.querySelector<HTMLElement>('.git-files');
    const filesReserve = changesCollapsed.staged && changesCollapsed.unstaged ? (files?.offsetHeight ?? 0) : 100;
    const max = Math.max(80, (parent?.clientHeight ?? 700) - (controls?.offsetHeight ?? 0) - filesReserve);
    historyHeight = Math.max(80, Math.min(max, height));
    wrap.style.height = historyHeight + 'px';
    resize.setAttribute('aria-valuemax', String(max));
    resize.setAttribute('aria-valuenow', String(historyHeight));
  };
  resize.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = event.clientY;
    const initial = wrap.offsetHeight;
    resize.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent): void => { setHeight(initial + start - e.clientY); };
    const stop = (): void => {
      resize.removeEventListener('pointermove', move);
      resize.removeEventListener('pointerup', stop);
      resize.removeEventListener('pointercancel', stop);
    };
    resize.addEventListener('pointermove', move);
    resize.addEventListener('pointerup', stop);
    resize.addEventListener('pointercancel', stop);
  });
  resize.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    setHeight(historyHeight + (event.key === 'ArrowUp' ? 20 : -20));
  });
  wrap.prepend(resize);
  wrap.append(body);

  if (!commits) {
    body.append(h('div', { class: 'git-empty' }, 'Loading…'));
  } else if (state.history?.isRepo === false) {
    body.append(h('div', { class: 'git-empty' }, 'Not a git repository.'));
  } else if (!commits.length) {
    body.append(h('div', { class: 'git-empty' }, 'No commits yet.'));
  } else {
    const key = graphKey(commits);
    if (state.graph?.key === key) {
      markActive(state.graph.node, activeCommitOid());
      body.append(state.graph.node);
      return wrap;
    }
    /* The commit graph draws its own SVG and is the heaviest thing in this
       panel, while the panel opens on the file list. Load its module on first
       need, then keep the node — the key above already says when it is stale. */
    body.append(h('div', { class: 'git-empty' }, 'Loading graph…'));
    void import('./gitGraph').then(m => {
      if (state.graph?.key === key) return;
      state.graph = { key, node: m.graphBody(commits, activeWsId() ?? '') };
      /* the panel may have been repainted, or closed, while the module
         loaded: only swap in place if this container is still on screen */
      if (!body.isConnected) return;
      markActive(state.graph.node, activeCommitOid());
      body.replaceChildren(state.graph.node);
    });
  }
  return wrap;
}

/* ---------------- data flow ---------------- */

interface RefreshOpts {
  /* background poll: no spinner, no history fetch, and no repaint when the
     data did not move, so the file list keeps its scroll position while the
     panel sits idle */
  silent?: boolean;
  /* fetch the commit graph as well; defaults to on for a non-silent refresh */
  history?: boolean;
}

async function refresh(state: PanelState, paint: () => void, opts: RefreshOpts = {}): Promise<void> {
  if (state.inflight || state.busy) return; /* one git pass at a time per panel */
  state.inflight = true;
  const wantHistory = opts.history ?? !opts.silent;
  const snapshot = (): string => JSON.stringify([state.status, state.remote, state.history]);
  const before = snapshot();
  if (!opts.silent) {
    state.loading = true;
    paint();
  }
  try {
    const wsId = activeWsId();
    if (!wsId) {
      state.status = { isRepo: false, branch: null, ahead: 0, behind: 0, entries: [], hasUntracked: false };
      state.remote = { isRepo: false, remote: null, defaultBranch: null };
      state.history = { isRepo: false, commits: [] };
    } else {
      /* a silent poll is the 4s heartbeat, and it is the only thing here that
         runs forever — so it asks for the two values that can actually change
         under the user (status, line counts) and leaves the graph and the
         remote alone. Each skipped call is ~120ms of git process startup. */
      const wantSlow = wantHistory || !state.history || !state.remote;
      const [s, r, hst, ds] = await Promise.all([
        api.gitStatus(wsId),
        wantSlow ? api.gitRemoteInfo(wsId) : Promise.resolve(null),
        wantSlow ? api.gitHistory(wsId) : Promise.resolve(null),
        gitDiffStat(wsId),
      ]);
      if (wsId !== activeWsId()) return;
      state.status = s;
      const paths = new Set(gitChangeRows(s.entries).map(row => row.key));
      state.selected = new Set([...state.selected].filter(path => paths.has(path)));
      if (state.anchor && !paths.has(state.anchor)) state.anchor = null;
      if (r) state.remote = r;
      if (hst) state.history = hst;
      /* the pill lives in the titlebar, outside this panel's DOM; painting it
         here rather than calling refreshChangesPill() keeps the numstat call in
         the batch above instead of adding a serial spawn after it */
      paintChangesPill(ds.isRepo, ds.additions, ds.deletions);
    }
  } catch (e: unknown) {
    console.error('gitPanel refresh failed', e);
  } finally {
    state.inflight = false;
    state.loading = false;
  }
  if (!opts.silent || snapshot() !== before) paint();
}

/* ---------------- Changes pill ----------------
   The pill lives in the titlebar (outside this panel's DOM). It needs to
   be accurate even before the panel is opened, so the boot flow in
   main.ts calls `refreshChangesPill()` directly. This module owns the
   DOM mutation and the "no workspace / not a git repo → hide" rule. */

function paintChangesPill(isRepo: boolean, additions: number, deletions: number): void {
  const pill = document.getElementById('gitChangesPill');
  if (!pill) return;
  if (!isRepo) { pill.setAttribute('hidden', ''); return; }
  pill.removeAttribute('hidden');
  const add = pill.querySelector('[data-role="add"]');
  const del = pill.querySelector('[data-role="del"]');
  if (add) add.textContent = '+' + additions;
  if (del) del.textContent = '-' + deletions;
}

export async function refreshChangesPill(): Promise<void> {
  const wsId = activeWsId();
  if (!wsId) { paintChangesPill(false, 0, 0); return; }
  try {
    const ds = await gitDiffStat(wsId);
    if (wsId === activeWsId()) paintChangesPill(ds.isRepo, ds.additions, ds.deletions);
  } catch (e: unknown) {
    console.error('refreshChangesPill failed', e);
    if (wsId === activeWsId()) paintChangesPill(false, 0, 0);
  }
}

/* ---------------- mount ---------------- */

/* the node the sidebar currently has mounted; `isConnected` is the invalidation
   signal — the sidebar clears the slot when the panel is closed, so a detached
   root means "rebuild (and re-fetch) on the next open" */
let mounted: {
  wsId: string | null;
  root: HTMLElement;
  commitOid: string;
  /* re-mark the selected row on the already-mounted graph, without repainting */
  markActive: (oid: string) => void;
} | null = null;

export function gitPanelPage(): HTMLElement {
  const wsId = activeWsId();
  if (mounted && mounted.wsId === wsId && mounted.root.isConnected) {
    const oid = activeCommitOid();
    if (mounted.commitOid !== oid) {
      mounted.commitOid = oid;
      mounted.markActive(oid);
    }
    return mounted.root;
  }

  const root = h('div', { class: 'git-panel-root' });

  const state: PanelState = {
    status: null, remote: null, history: null, graph: null, loading: false, inflight: false,
    busy: false, message: '', error: '', selected: new Set(), anchor: null,
  };

  function paint(): void {
    root.innerHTML = '';
    root.append(
      buildHeader(state, paint),
      h('div', { class: 'git-panel-body' },
        buildControls(state, paint),
        buildFilesList(state, paint),
        buildHistory(state, paint)),
    );
  }

  mounted = {
    wsId,
    root,
    commitOid: activeCommitOid(),
    markActive: (oid) => { if (state.graph) markActive(state.graph.node, oid); },
  };
  paint();
  void refresh(state, paint);

  /* the panel owns its own freshness now that it is not re-mounted: slow poll
     while it is on screen, self-clearing once the sidebar drops the node.
     Skipped while the tab is hidden — git output cannot change what the user
     sees, and each tick costs process spawns. */
  const poll = setInterval(() => {
    if (!root.isConnected) {
      clearInterval(poll);
      if (activePoll === poll) activePoll = null;
      notifyPanelPolling(false);
      return;
    }
    if (document.visibilityState !== 'visible' || state.busy) return;
    void refresh(state, paint, { silent: true });
  }, PANEL_POLL_MS);
  /* a rebuild for another workspace supersedes this mount: take down its
     interval now rather than on the next tick, so the detached panel stops
     repainting the titlebar pill with the old workspace's numbers */
  if (activePoll !== null) clearInterval(activePoll);
  activePoll = poll;

  /* notify the shared scheduler so the titlebar pill can stand down while
     the panel's own poll covers the active workspace */
  notifyPanelPolling(true);

  return root;
}
