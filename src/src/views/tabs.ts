/* ---------------- tabs (titlebar tabstrip; terminals + resource pages) ---------------- */

import { $, h } from '../dom';
import type { TabRec } from '../../shared/types';
import { leafNode, leafIds, firstLeafId, splitLeaf, removeLeaf, setSplitDir, newNodeKey, treeHasKey, type PaneNode } from '../../shared/split-tree';
import { ui, type Route, type TabEntry } from '../state';
import { db, branches, activity } from '../store';
import { render } from '../render';
import { disposeTerminal, mostRecentPane, resetPaneRatio } from './terminal';
import { openContextMenu } from '../components/menu';
import { openModal } from '../components/modal';
import { refreshChangesPill } from './gitPanel';
import { tabRenderer } from '../plugin/registry';
import { ensureActive, pluginDisplayName } from '../plugin/loader';
import { emitTabActivated, emitTabClosed } from '../main';
import api from '../../preload/bentomux';

const TAB_TITLE_MAX = 80;

export function tabFor(id: string | null): TabEntry | undefined {
  return ui.tabs.find(t => t.id === id);
}

export function tabKey(route: Route): string {
  if (route.view === 'terminal') return 'term:' + route.tabId;
  if (route.view === 'agentDetail') return 'agent:' + route.agentId + ':' + route.tab;
  if (route.view === 'diff') return 'diff:' + route.workspaceId + ':' + route.path;
  if (route.view === 'commit') return 'commit:' + route.workspaceId + ':' + route.oid;
  if (route.view === 'plugin') return 'plugin:' + route.pluginId + ':' + route.tabId;
  return route.view;
}

/* all pane ids of a terminal tab (single-pane tabs: just the anchor id) */
export function leavesOf(t: TabEntry): string[] {
  if (t.route.view !== 'terminal') return [];
  return t.tree ? leafIds(t.tree) : [t.route.tabId];
}

function entryForPane(paneId: string): TabEntry | undefined {
  return ui.tabs.find(t => t.route.view === 'terminal' && leavesOf(t).includes(paneId));
}

/* tab key ('term:<anchor>') owning this pane — for menus outside tabs.ts */
export function tabKeyForPane(paneId: string): string | null {
  return entryForPane(paneId)?.id ?? null;
}

export function tabTitle(t: TabEntry): string {
  const route = t.route;
  if (route.view === 'terminal') {
    if (t.title) return t.title;
    return branches.get(t.workspaceId || '') || 'Terminal';
  }
  if (route.view === 'agentDetail') {
    const cap = route.tab === 'model' ? 'Model' : route.tab === 'memory' ? 'Memory' : route.tab === 'skills' ? 'Skills' : 'MCP';
    const name = db.agents?.find(a => a.id === route.agentId)?.name || route.agentId;
    return name + ' · ' + cap;
  }
  if (route.view === 'diff') return diffTabTitle(route.path);
  if (route.view === 'commit') return route.short;
  if (route.view === 'plugin') return t.title || route.title;
  return 'Agents';
}

/* one file per tab — show just the basename; the full path lives in the
   tab's tooltip */
function diffTabTitle(path: string): string {
  const base = path.split('/').pop() || path;
  return base || 'Diff';
}

function syncActiveWorkspaceMarker(workspaceId: string | undefined): void {
  if (!workspaceId) return;
  if (db.activeWorkspaceId === workspaceId) return;
  db.activeWorkspaceId = workspaceId;
  void api.setActiveWorkspace(workspaceId);
  /* the titlebar Changes pill is keyed on the active workspace — re-fetch
     so +N -N reflects the newly-active folder without the user opening
     the Git panel */
  void refreshChangesPill();
}

function pushHistory(from: string, to: string): void {
  if (from === to) return;
  if (ui.history[ui.history.length - 1] === from) return;
  /* non-terminal routes don't have a tab in ui.tabs; skip them so history
     only tracks terminal-tab navigation and stays resolvable on back-step */
  if (from && !ui.tabs.some(t => t.id === from)) return;
  ui.history.push(from);
  if (ui.history.length > 60) ui.history.shift();
  ui.future = [];
}

export function setRoute(route: Route): void {
  /* the titlebar tab strip holds terminals, diff pages, and plugin tabs;
     other resource pages (agents, agentDetail) live as standalone pages and
     never become a tab — we just update ui.route and re-render. */
  if (route.view !== 'terminal' && route.view !== 'diff' && route.view !== 'plugin' && route.view !== 'commit') {
    if (ui.activeTab) pushHistory(ui.activeTab, '');
    ui.route = route;
    render();
    return;
  }
  const key = tabKey(route);
  let t = ui.tabs.find(x => x.id === key);
  if (!t) {
    const workspaceId = route.view === 'diff' ? route.workspaceId
      : route.view === 'commit' ? route.workspaceId
      : route.view === 'plugin' ? undefined
      : findWorkspaceForTab(route.tabId);
    t = { id: key, route, workspaceId };
    ui.tabs.push(t);
  }
  if (route.view === 'terminal') {
    t.workspaceId = t.workspaceId || findWorkspaceForTab(route.tabId);
    if (!activity[route.tabId]) activity[route.tabId] = Date.now();
  }
  activate(key);
}

/**
 * Open a plugin-contributed tab.
 *
 * Plugin tabs are full citizens: grouped in the strip, part of back/forward
 * history, and restored on restart. A tab whose plugin is no longer installed
 * or enabled cannot be opened at all — the registry has no renderer for it —
 * which is why this reports failure rather than opening an empty page.
 */
export function openPluginTab(pluginId: string, tabId: string, title: string): boolean {
  if (!tabRenderer(pluginId, tabId)) return false;
  setRoute({ view: 'plugin', pluginId, tabId, title });
  return true;
}

function findWorkspaceForTab(tabId: string): string | undefined {
  return lastCreatedWs.get(tabId);
}

/* workspace binding for freshly created tabs, filled at creation time */
export const lastCreatedWs = new Map<string, string>();

/* create local tab entries for tabs restored by main at launch */
export function registerRestoredTab(rec: TabRec): void {
  if (ui.tabs.some(t => t.route.view === 'terminal' && t.route.tabId === rec.id)) return;
  ui.tabs.push({ id: 'term:' + rec.id, route: { view: 'terminal', tabId: rec.id }, workspaceId: rec.workspaceId, tree: rec.splitTree, title: rec.title });
}

export function activate(id: string): void {
  if (ui.activeTab) pushHistory(ui.activeTab, id);
  const t = tabFor(id) || ui.tabs[0];
  if (!t) return;
  ui.activeTab = t.id;
  ui.route = t.route;
  /* the sidebar's active-workspace marker follows the tab being viewed;
     non-terminal tabs keep the last workspace marked */
  syncActiveWorkspaceMarker(t.workspaceId);
  /* switching to a terminal tab dismisses the Git Tools right-panel so the
     full content area is available for the shell; the panel can be
     re-opened from its titlebar pill regardless of route */
  if (t.route.view === 'terminal') { ui.gitPanelOpen = false; }
  /* report the pane this tab lands on, so a plugin knows what is on screen
     before xterm takes focus. A split opens on its first leaf; a single-pane
     tab is its own leaf. markFocusedPane refines this the moment the user
     clicks a different pane. */
  emitTabActivated(
    t.id,
    t.route.view === 'terminal' ? t.tree ? firstLeafId(t.tree) : t.route.tabId : null,
  );
  render();
}

function pickNextTab(removedIndex: number): TabEntry | null {
  const fromHistory = ui.history.pop();
  if (fromHistory) {
    const t = tabFor(fromHistory);
    if (t) return t;
  }
  return ui.tabs[Math.max(0, removedIndex - 1)] || ui.tabs[0] || null;
}

function dropIdsFrom(...lists: string[][]): string[][] {
  return lists.map(list => list.filter(x => !ui.tabs.some(t => t.id === x)));
}

export async function closeTab(id: string): Promise<void> {
  const i = ui.tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  emitTabClosed(id);
  const t = ui.tabs[i];
  await shutdownTab(t);
  ui.tabs.splice(i, 1);
  [ui.history, ui.future] = dropIdsFrom(ui.history, ui.future);

  const next = pickNextTab(i);
  if (next) activate(next.id);
  else goMemory();
}

/* kill the ptys of every pane and drop per-tab renderer state; caller updates ui.tabs */
async function shutdownTab(t: TabEntry): Promise<void> {
  const leaves = leavesOf(t);
  if (!leaves.length) return;
  await api.closeTab(leaves[0]); /* main removes the whole record */
  for (const id of leaves) {
    disposeTerminal(id);
    delete activity[id];
    lastCreatedWs.delete(id);
  }
}

export async function closeOtherTabs(keepId: string): Promise<void> {
  const victims = ui.tabs.filter(t => t.id !== keepId);
  for (const t of victims) emitTabClosed(t.id);
  for (const t of victims) await shutdownTab(t);
  const dead = new Set(victims.map(t => t.id));
  ui.tabs = ui.tabs.filter(t => !dead.has(t.id));
  ui.history = ui.history.filter(x => !dead.has(x));
  ui.future = ui.future.filter(x => !dead.has(x));
  activate(keepId);
}

export async function closeAllTabs(): Promise<void> {
  for (const t of [...ui.tabs]) emitTabClosed(t.id);
  for (const t of [...ui.tabs]) await shutdownTab(t);
  ui.tabs = [];
  ui.history = [];
  ui.future = [];
  ui.activeTab = null;
  goMemory();
}

function tabContextMenu(x: number, y: number, id: string): void {
  const t = tabFor(id);
  openContextMenu(x, y, [
    { label: 'Rename tab…', disabled: !t || t.route.view !== 'terminal', action: () => beginRename(id) },
    { label: 'Close tab', action: () => void closeTab(id) },
    { label: 'Close other tabs', disabled: ui.tabs.length < 2, action: () => void closeOtherTabs(id) },
    { label: 'Close all tabs', action: () => void closeAllTabs() },
  ]);
}

function findTabButton(id: string): HTMLElement | null {
  return $('.tab[data-tab="' + CSS.escape(id) + '"]', $('#tabstrip'));
}

function findTabLabel(btn: HTMLElement): HTMLElement | null {
  return $('.tabname', btn);
}

function commitTitleOnBlur(input: HTMLInputElement, t: TabEntry, done: { v: boolean }): void {
  if (done.v) return;
  done.v = true;
  commitTitle(t, input.value);
}

/* inline rename: swap the label for an input inside the tab button;
   Enter/blur commits, Escape restores, empty clears back to the default title */
export function beginRename(id: string): void {
  const t = tabFor(id);
  if (!t || t.route.view !== 'terminal') return;
  const btn = findTabButton(id);
  if (!btn) return;
  const existing = $('.tabname-edit', btn);
  if (existing) { existing.focus(); return; }
  const label = findTabLabel(btn);
  if (!label) return;
  const input = makeRenameInput(t);
  const done = { v: false };
  input.addEventListener('blur', () => commitTitleOnBlur(input, t, done));
  label.replaceWith(input);
  input.focus();
  input.select();
}

function makeRenameInput(t: TabEntry): HTMLInputElement {
  const input = h('input', {
    class: 'tabname-edit',
    value: t.title || '',
    spellcheck: 'false',
    onmousedown: (e: Event) => e.stopPropagation(),
    onclick: (e: Event) => e.stopPropagation(),
    ondblclick: (e: Event) => e.stopPropagation(),
    onkeydown: (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.blur();
      else if (e.key === 'Escape') {
        input.value = t.title || '';
        input.blur();
        render();
      }
    },
  }) as HTMLInputElement;
  return input;
}

function commitTitle(t: TabEntry, value: string): void {
  if (t.route.view !== 'terminal') return;
  const name = value.trim().slice(0, TAB_TITLE_MAX);
  t.title = name || undefined;
  /* any pane id works — main resolves the owning record */
  api.renameTab(t.route.tabId, name);
  render();
}

function goMemory(): void {
  ui.activeTab = null;
  ui.route = { view: 'welcome' };
  /* render directly — setRoute skips tab creation for non-terminal routes */
  render();
}

export async function newTerminalTab(wsId?: string): Promise<void> {
  const ws = db.workspaces.find(w => w.id === (wsId || db.activeWorkspaceId));
  if (!ws) return;
  try {
    const rec = await api.createTab(ws.id);
    lastCreatedWs.set(rec.id, ws.id);
    activity[rec.id] = Date.now();
    setRoute({ view: 'terminal', tabId: rec.id });
    if (rec.title) {
      /* main pre-assigns the workspace's remembered title */
      const entry = tabFor('term:' + rec.id);
      if (entry) { entry.title = rec.title; render(); }
    }
  } catch (e) {
    console.error('create tab failed', e);
    reportPaneFailure(e);
  }
}

/* A pane that cannot start means the pty host daemon is unreachable — every
   later pane fails the same way, so say it once where the user can see it
   instead of only in a console they never open. */
let paneFailureShown = false;

function reportPaneFailure(e: unknown): void {
  if (paneFailureShown) return;
  paneFailureShown = true;
  const m = openModal({
    title: 'Cannot start terminal',
    body: h('div', {},
      h('p', { style: 'margin:0 0 6px' }, 'The background session daemon did not answer.'),
      h('p', { style: 'margin:0;color:var(--ink-2)' }, String(e)),
      h('p', { style: 'margin:6px 0 0;color:var(--ink-2)' }, 'Restart Bentomux. If it keeps happening, the log is in your temp folder as bentomux-pty.log.')),
    footer: h('div', {}, h('button', { class: 'btn primary', onclick: () => m.close() }, 'OK')),
  });
}

/* split the pane `paneId`: new shell to its right/below ('v'/'h').
   `before` puts it left/above instead. Key generated here so main and
   renderer grow identical trees. */
export async function splitTerminalPane(paneId: string, dir: 'v' | 'h' = 'v', before = false): Promise<void> {
  const entry = entryForPane(paneId);
  if (!entry || entry.route.view !== 'terminal') return;
  const key = newNodeKey();
  try {
    const rec = await api.splitTab(paneId, dir, key, before);
    const base = entry.tree ?? leafNode(entry.route.tabId);
    entry.tree = splitLeaf(base, paneId, dir, rec.id, key, before);
    activity[rec.id] = Date.now();
    if (entry.workspaceId) lastCreatedWs.set(rec.id, entry.workspaceId);
    render();
  } catch (e) {
    console.error('split pane failed', e);
  }
}

/* flip one axis between side-by-side and stacked (addressed by node key);
   the divider returns to an even 50/50 split */
export function setNodeDir(nodeKey: string, dir: 'v' | 'h'): void {
  const entry = ui.tabs.find(t => t.route.view === 'terminal' && t.tree && treeHasKey(t.tree, nodeKey));
  if (!entry || !entry.tree) return;
  entry.tree = setSplitDir(entry.tree, nodeKey, dir);
  resetPaneRatio(nodeKey);
  api.setSplitDir(nodeKey, dir);
  render();
}

/* close one pane; its axis collapses, anchor re-keys when it was the first pane */
export async function closeTerminalPane(paneId: string): Promise<void> {
  const entry = entryForPane(paneId);
  if (!entry || entry.route.view !== 'terminal') return;
  const before = entry.tree ?? leafNode(entry.route.tabId);
  disposeTerminal(paneId);
  delete activity[paneId];
  lastCreatedWs.delete(paneId);
  await api.closePane(paneId);
  const tree = removeLeaf(before, paneId);
  if (!tree) {
    await closeTab(entry.id);
    return;
  }
  reanchorEntryOnPaneClose(entry, tree);
  render();
}

/* Cmd+W / File > Close Pane: the focused pane of a split tab goes first; a
   tab down to its last pane (or any non-terminal tab) closes entirely */
export function closeFocusedPaneOrTab(): void {
  const entry = ui.tabs.find(t => t.id === ui.activeTab);
  if (!entry) return;
  if (entry.route.view === 'terminal') {
    void closeTerminalPane(mostRecentPane(leavesOf(entry)));
    return;
  }
  void closeTab(entry.id);
}

function reanchorEntryOnPaneClose(entry: TabEntry, tree: PaneNode): void {
  if (entry.route.view !== 'terminal') return;
  const newAnchor = firstLeafId(tree);
  if (entry.route.tabId !== newAnchor) rekeyTabToAnchor(entry, newAnchor);
  entry.tree = tree.kind === 'split' ? tree : undefined;
}

function rekeyTabToAnchor(entry: TabEntry, newAnchor: string): void {
  /* keep tab key + route anchored on the surviving first pane, like main re-keyed */
  const oldKey = entry.id;
  entry.route = { view: 'terminal', tabId: newAnchor };
  entry.id = 'term:' + newAnchor;
  ui.history = ui.history.map(k => (k === oldKey ? entry.id : k));
  ui.future = ui.future.map(k => (k === oldKey ? entry.id : k));
  if (ui.activeTab === oldKey) { ui.activeTab = entry.id; ui.route = entry.route; }
}

export function stepHistory(dir: -1 | 1): void {
  if (dir === -1) {
    const prev = ui.history.pop();
    if (!prev) return;
    if (ui.activeTab) ui.future.push(ui.activeTab);
    jumpToHistoryEntry(prev);
  } else {
    const next = ui.future.pop();
    if (!next) return;
    if (ui.activeTab) ui.history.push(ui.activeTab);
    jumpToHistoryEntry(next);
  }
}

function jumpToHistoryEntry(id: string): void {
  const t = tabFor(id);
  if (!t) return;
  ui.activeTab = id;
  ui.route = t.route;
  render();
}

let wheelWired = false;
let draggedTabId: string | null = null;
let dragTargetTabId: string | null = null;
let dragBelow = false;
let dragMoved = false;

function clearTabDropMarks(): void {
  for (const el of document.querySelectorAll('.tab.drop-above, .tab.drop-below')) {
    el.classList.remove('drop-above', 'drop-below');
  }
}

function updateTabDrag(x: number, y: number): void {
  if (!draggedTabId) return;
  const target = document.elementFromPoint(x, y)?.closest<HTMLElement>('.tab');
  if (!target || target.dataset.tab === draggedTabId) {
    dragTargetTabId = null;
    clearTabDropMarks();
    return;
  }
  const source = tabFor(draggedTabId);
  const targetEntry = tabFor(target.dataset.tab || null);
  if (!source || !targetEntry || source.workspaceId !== targetEntry.workspaceId) {
    dragTargetTabId = null;
    clearTabDropMarks();
    return;
  }
  const bounds = target.getBoundingClientRect();
  dragBelow = x > bounds.left + bounds.width / 2;
  dragTargetTabId = target.dataset.tab || null;
  clearTabDropMarks();
  target.classList.add(dragBelow ? 'drop-below' : 'drop-above');
}

function finishTabDrag(): void {
  const sourceId = draggedTabId;
  const targetId = dragTargetTabId;
  const below = dragBelow;
  draggedTabId = null;
  dragTargetTabId = null;
  dragBelow = false;
  clearTabDropMarks();
  document.body.classList.remove('tab-dragging');
  if (!sourceId || !targetId || sourceId === targetId) return;
  reorderTab(sourceId, targetId, below);
  activate(sourceId);
}

function reorderTab(draggedId: string, targetId: string, below: boolean): void {
  const source = tabFor(draggedId);
  const target = tabFor(targetId);
  if (!source || !target || source.workspaceId !== target.workspaceId) return;
  const tabs = ui.tabs.filter(t => t.workspaceId === source.workspaceId);
  const from = tabs.indexOf(source);
  const targetIndex = tabs.indexOf(target);
  if (from < 0 || targetIndex < 0) return;
  const [moved] = tabs.splice(from, 1);
  const insertAt = tabs.indexOf(target);
  tabs.splice(below ? insertAt + 1 : insertAt, 0, moved);
  let index = 0;
  ui.tabs = ui.tabs.map(tab => tab.workspaceId === source.workspaceId
    ? tabs[index++] : tab);
  void api.reorderTabs(
    ui.tabs
      .filter(tab => tab.route.view === 'terminal')
      .map(tab => tab.route.view === 'terminal' ? tab.route.tabId : ''),
  );
  renderTabs();
}

function workspaceLabel(workspaceId: string | undefined): string {
  if (!workspaceId) return 'Other';
  /* plugin tabs group under their plugin rather than under a workspace */
  if (workspaceId.startsWith('plugin:')) {
    const id = workspaceId.slice('plugin:'.length);
    return pluginDisplayName(id);
  }
  return db.workspaces.find(w => w.id === workspaceId)?.name || 'Workspace';
}

function tabWorkspaceKey(t: TabEntry): string {
  /* plugin tabs belong to no workspace, so they group under their plugin's
     name instead of landing in the catch-all bucket with unbound terminals */
  if (t.route.view === 'plugin') return 'plugin:' + t.route.pluginId;
  return t.workspaceId || 'other';
}

function tabButton(t: TabEntry): HTMLElement {
  const title = tabTitle(t);
  /* diff and commit tabs carry a repo-relative path or a sha in their route —
     surface it in the tooltip so same-named files from different folders are
     told apart */
  const tooltip = t.route.view === 'diff'
    ? t.route.path
    : t.route.view === 'commit'
      ? t.route.oid
      : [workspaceLabel(t.workspaceId), title, t.title ?
        'Double-click to rename' : ''].filter(Boolean).join('\n');
  return h('button',
    {
      class: 'tab' + (t.id === ui.activeTab ? ' active' : ''),
      title: tooltip,
      dataset: { tab: t.id },
      /* no-op on an already-active tab: render() rebuilds the strip,
         which would eat the second click's dblclick for rename */
      onclick: (e: MouseEvent) => {
        if (ui.activeTab !== t.id) activate(t.id);
      },
      onpointerdown: (e: PointerEvent) => {
        if (e.button !== 0) return;
        draggedTabId = t.id;
        dragTargetTabId = null;
        dragMoved = false;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      },
      onpointermove: (e: PointerEvent) => {
        if (draggedTabId !== t.id) return;
        if (Math.abs(e.movementX) + Math.abs(e.movementY) <= 3) return;
        dragMoved = true;
        document.body.classList.add('tab-dragging');
        updateTabDrag(e.clientX, e.clientY);
      },
      onpointerup: (e: PointerEvent) => {
        if (draggedTabId !== t.id) return;
        if (dragMoved) e.preventDefault();
        updateTabDrag(e.clientX, e.clientY);
        finishTabDrag();
      },
      onpointercancel: finishTabDrag,
      ondblclick: () => beginRename(t.id),
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        tabContextMenu(e.clientX, e.clientY, t.id);
      },
    },
    h('span', { class: 'tabname' }, title),
    h('span', {
      class: 'tabx',
      onpointerdown: (e: Event) => e.stopPropagation(),
      onclick: (e: Event) => { e.stopPropagation(); void closeTab(t.id); },
    }, '×'),
  );
}

function addTabButton(): HTMLElement {
  return h('button', {
    class: 'tabadd',
    title: db.activeWorkspaceId ? 'New terminal in active workspace' : 'Add a workspace folder first',
    disabled: !db.activeWorkspaceId,
    onclick: () => void newTerminalTab(),
  }, '+');
}

function wireWheelOnce(strip: HTMLElement): void {
  if (wheelWired) return;
  wheelWired = true;
  strip.addEventListener('pointermove', (e: PointerEvent) => {
    if (draggedTabId) updateTabDrag(e.clientX, e.clientY);
  });
  strip.addEventListener('pointerup', (e: PointerEvent) => {
    if (draggedTabId) finishTabDrag();
  });
  strip.addEventListener('wheel', (e: WheelEvent) => {
    if (strip.scrollWidth > strip.clientWidth) {
      strip.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
}

function scrollActiveTabIntoView(strip: HTMLElement): void {
  const act = $('.tab.active', strip);
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function renderTabs(): void {
  const strip = $('#tabstrip');
  strip.classList.add('tabstrip');
  $('#titlebar').classList.add('has-tabs');
  strip.innerHTML = '';
  const visibleTabs = ui.tabs.filter(
    t => t.route.view === 'terminal' || t.route.view === 'diff'
      || t.route.view === 'commit' || t.route.view === 'plugin',
  );
  const groups = new Map<string, TabEntry[]>();
  for (const tab of visibleTabs) {
    const key = tabWorkspaceKey(tab);
    const group = groups.get(key) || [];
    group.push(tab);
    groups.set(key, group);
  }
  for (const [workspaceId, tabs] of groups) {
    const name = workspaceLabel(workspaceId === 'other' ? undefined : workspaceId);
    const group = h('div', {
      class: 'tabgroup',
      title: name,
      dataset: { workspace: workspaceId },
    });
    if (db.prefs.showTabGroupNames !== false) {
      group.append(h('span', { class: 'tabgroup-name' }, name));
    }
    group.append(...tabs.map(tabButton));
    strip.append(group);
  }
  /* plugin tabs that are declared but not yet open appear in the add menu
     rather than the strip, so the strip stays a record of what is open */
  if (ui.tabs.some(t => t.route.view === 'terminal')) strip.append(addTabButton());

  /* overflow strip scrolls horizontally instead of clipping tabs */
  wireWheelOnce(strip);
  scrollActiveTabIntoView(strip);
}
