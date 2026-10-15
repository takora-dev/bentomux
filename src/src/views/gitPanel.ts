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
import { graphBody } from './gitGraph';
import api from '../../preload/bentomux';

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
}

/* the panel is mounted once per (open, workspace) pair and then polls itself,
   so the sidebar's 1 Hz re-render no longer re-runs the git shellouts */
const PANEL_POLL_MS = 4000;
const PILL_POLL_MS = 15000;

/* Shared pill/panel scheduler: the titlebar pill heartbeat stands down while
   the panel's own poll covers the active workspace, so the two never race
   two git processes at the same numstat. */
let panelPolling = false;
let pillTimer: ReturnType<typeof setInterval> | null = null;

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
      disabled: state.loading,
    },
      h('span', { style: 'font-size:14px' }, '↻')));
}

function buildFilesList(state: PanelState): HTMLElement {
  const list = h('div', { class: 'git-files-list' });
  const wrap = h('div', { class: 'git-section git-files' },
    h('div', { class: 'git-section-h' },
      h('span', { class: 'grow' }, 'Changes'),
      h('span', { class: 'muted' }, state.loading
        ? 'Refreshing…'
        : (state.status?.entries.length ?? 0) + ' files')),
    list);

  if (!state.status) {
    list.append(h('div', { class: 'git-empty' }, 'Loading…'));
    return wrap;
  }
  if (state.status.isRepo === false) {
    list.append(h('div', { class: 'git-empty' }, 'Initialize a repository to use Git Tools.'));
    return wrap;
  }
  if (!state.status.entries.length) {
    list.append(h('div', { class: 'git-empty' }, 'Working tree clean.'));
    return wrap;
  }
  const wsId = activeWsId();
  if (!wsId) return wrap;
  for (const entry of state.status.entries) list.append(fileRow(entry, wsId));
  return wrap;
}

function fileRow(entry: GitStatusEntry, wsId: string): HTMLElement {
  /* the right panel's file list is a navigator; each file's diff opens as
     its own titlebar tab (route `{ view: 'diff', workspaceId, path }` —
     setRoute() re-activates the existing tab when the file is already open).
     The active file is whichever one `ui.route` is currently viewing. */
  const active = ui.route.view === 'diff' && ui.route.workspaceId === wsId && ui.route.path === entry.path;
  const btn = h('button', {
    class: 'git-file-row' + (active ? ' active' : ''),
    type: 'button',
    title: fileRowTitle(entry.status) + ' — ' + entry.path,
    onclick: () => { go({ view: 'diff', workspaceId: wsId, path: entry.path }); },
  },
    h('span', { class: 'xy' }, formatStatusBadge(entry.status)),
    h('span', { class: 'name' }, entry.path));
  return btn;
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

function buildHistory(state: PanelState): HTMLElement {
  const commits = state.history?.commits ?? null;
  const wrap = h('div', { class: 'git-section git-history' },
    h('div', { class: 'git-section-h' },
      h('span', { class: 'grow' }, 'History'),
      h('span', { class: 'muted' }, commits ? commits.length + ' commits' : '')));

  if (!commits) {
    wrap.append(h('div', { class: 'git-empty' }, 'Loading…'));
  } else if (state.history?.isRepo === false) {
    wrap.append(h('div', { class: 'git-empty' }, 'Not a git repository.'));
  } else if (!commits.length) {
    wrap.append(h('div', { class: 'git-empty' }, 'No commits yet.'));
  } else {
    const key = graphKey(commits);
    if (state.graph?.key !== key) state.graph = { key, node: graphBody(commits, activeWsId() ?? '') };
    markActive(state.graph.node, activeCommitOid());
    wrap.append(state.graph.node);
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
  if (state.inflight) return; /* one git pass at a time per panel */
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
        api.gitDiffStat(wsId),
      ]);
      state.status = s;
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
    const ds = await api.gitDiffStat(wsId);
    paintChangesPill(ds.isRepo, ds.additions, ds.deletions);
  } catch (e: unknown) {
    console.error('refreshChangesPill failed', e);
    paintChangesPill(false, 0, 0);
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
  };

  function paint(): void {
    root.innerHTML = '';
    root.append(
      buildHeader(state, paint),
      h('div', { class: 'git-panel-body' },
        buildFilesList(state),
        buildHistory(state)),
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
    if (document.visibilityState !== 'visible') return;
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
