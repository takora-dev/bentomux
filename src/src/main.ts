/* ============================================================
   Bentomux — calm desktop for AI agent runtime workspaces.
   Entry point: root render, content dispatch, shell wiring, boot.
   ============================================================ */

import '../styles.css';
import { $, $$, h } from './dom';
import { rel, abs } from './time';
import { ui, type Route, type TabEntry } from './state';
import { db, setDb, branches, runtime, activity } from './store';
import { registerRenderers, render } from './render';
import { renderTabs, activate, stepHistory, registerRestoredTab } from './views/tabs';
import { openAddWorkspaceMenu, renderSidebar, patchPaneStatuses, toggleGitPanel, closeRailFlyout } from './views/sidebar';
import { agentsPage, agentDetailPage } from './views/agents';
import { welcomePage, disposeWidgets } from './views/welcome';
import {
  initTerminalEvents,
  terminalPage,
  applyTerminalFont,
  clearTerminalSelections,
} from './views/terminal';
import { initKeyboard } from './keyboard';
import { refreshChangesPill, startPillHeartbeat } from './views/gitPanel';
import { initAgentEvents } from './views/agent-events';
import { initAutoUpdate, updateStatus, onUpdateChange } from './updates';
import { topbarEntries, tabRenderer, modalRenderer } from './plugin/registry';
import { openPluginTab } from './views/tabs';
import { openModal } from './components/modal';
import { initPlugins, ensureActive, pluginAssetUrl, onPluginsChanged, bindHost, onTeardown } from './plugin/loader';
import { contributionIcon, contributionLabel } from './plugin/icons';
import api from '../preload/bentomux';
import { getCurrentWindow } from '@tauri-apps/api/window';
document.documentElement.classList.toggle('macos', /Mac/.test(navigator.platform));
/* Windows runs frameless (tauri.windows.conf.json) and draws its own window
   buttons, so the stylesheet needs to know which platform it is on. */
document.documentElement.classList.toggle('windows', /Win/.test(navigator.platform));

/* Suppress native browser context menu everywhere except inside
   .terminal-page which wires its own contextmenu handler. */
document.addEventListener('contextmenu', e => {
  if (!(e.target as Element).closest('.terminal-page')) e.preventDefault();
});

const MIN_SIDEBAR_WIDTH = 248;
const MAX_SIDEBAR_RATIO = 0.5;

/* ---------------- render root ---------------- */

const PALETTE_CLASSES = ['palette-catppuccin', 'palette-rose-pine', 'palette-gruvbox', 'palette-dracula', 'palette-nord', 'palette-classic', 'palette-eink'];

function applyPaletteClass(palette: string | undefined): void {
  const root = document.documentElement;
  for (const c of PALETTE_CLASSES) root.classList.remove(c);
  if (palette && palette !== 'default') root.classList.add('palette-' + palette);
}

function applyFontPrefs(): void {
  const root = document.documentElement;
  if (db.prefs.font) root.style.setProperty('--term-font', db.prefs.font);
  else root.style.removeProperty('--term-font');
  if (db.prefs.fontSize) root.style.setProperty('--term-font-size', db.prefs.fontSize + 'px');
  else root.style.removeProperty('--term-font-size');
}

function applyShellPrefs(): void {
  document.documentElement.style.setProperty('--sidebar-width', (db.prefs.sidebarWidth || MIN_SIDEBAR_WIDTH) + 'px');
  document.title = 'Bentomux';
  document.body.classList.toggle('pane-hidden', db.prefs.paneHidden === true);
  document.body.classList.toggle('git-panel-open', ui.gitPanelOpen);
  document.documentElement.classList.toggle('dark', resolveTheme() === 'dark');
  applyPaletteClass(db.prefs.palette);
  applyFontPrefs();
  $('#sidebar').classList.toggle('open', ui.sidebarOpen);
  $('#scrim').classList.toggle('show', ui.sidebarOpen);
}

function renderRoot(): void {
  applyShellPrefs();
  renderSidebar();
  renderTabs();
  renderContentInner(ui.route);
}

function findTerminalEntry(route: Route): TabEntry | undefined {
  if (route.view !== 'terminal') return undefined;
  return ui.tabs.find(t => t.route.view === 'terminal' && (t.route === route || t.route.tabId === route.tabId));
}

function renderContentInner(route: Route): void {
  const c = $('#content');
  const body = $('#tabbody');
  c.classList.remove('full');
  c.classList.remove('fullbleed');

  if (route.view === 'terminal') {
    const entry = findTerminalEntry(route);
    const exists = !!entry || db.openTabs.some(t => t.id === route.tabId);
    c.classList.add('full');
    body.innerHTML = '';
    const start = entry && entry.route.view === 'terminal' ? (entry.tree ?? entry.route.tabId) : route.tabId;
    const result = terminalPage(start);
    body.append(exists ? result : h('div', { class: 'page' }, h('p', {}, 'Terminal not found.')));
  } else if (route.view === 'welcome') {
    body.innerHTML = '';
    body.append(welcomePage());
  } else if (route.view === 'agents') {
    ui.route = { view: 'welcome' };
    body.innerHTML = '';
    body.append(welcomePage());
  } else if (route.view === 'agentDetail') {
    body.innerHTML = '';
    body.append(agentDetailPage(route.agentId, route.tab));
  } else if (route.view === 'diff') {
    /* shiki (core + grammars, ~1.3 MB) loads lazily with the diff view —
       never part of first paint. Plain loading text holds the slot. */
    c.classList.add('fullbleed');
    body.innerHTML = '';
    body.append(h('div', { class: 'page' }, h('p', {}, 'Loading diff…')));
    void import('./views/diff').then(m => {
      if (ui.route.view !== 'diff') return;
      body.innerHTML = '';
      body.append(m.diffPage(route.workspaceId, route.path));
    });
  } else if (route.view === 'commit') {
    c.classList.add('fullbleed');
    body.innerHTML = '';
    body.append(h('div', { class: 'page' }, h('p', {}, 'Loading commit…')));
    void import('./views/commit').then(m => {
      if (ui.route.view !== 'commit') return;
      body.innerHTML = '';
      body.append(m.commitPage(route.workspaceId, route.oid, route.short));
    });
  } else if (route.view === 'plugin') {
    /* a plugin tab renders into a host element it is given. The renderer is
       looked up fresh each paint: the plugin may have been reloaded since the
       tab was opened, and an updated renderer must win. */
    body.innerHTML = '';
    const render = tabRenderer(route.pluginId, route.tabId);
    if (!render) {
      /* the owning plugin is gone or disabled — a tab that cannot render
         says so rather than showing an empty page */
      body.append(h('div', { class: 'page' },
        h('p', {}, `The plugin that provided this tab is no longer active.`)));
    } else {
      const host = h('div', { class: 'page plugin-tab-page' });
      body.append(host);
      void ensureActive(route.pluginId).then(() => {
        const live = tabRenderer(route.pluginId, route.tabId);
        if (!live) return;
        try {
          const cleanup = live(host);
          if (typeof cleanup === 'function') registerPluginViewCleanup(route.pluginId, cleanup);
        } catch (e) {
          console.error(`[plugin:${route.pluginId}] tab \`${route.tabId}\` threw`, e);
          host.textContent = 'This plugin tab failed to render.';
        }
      });
    }
  } else {
    body.innerHTML = '';
    body.append(h('div', { class: 'page' }, h('p', {}, 'Unknown view.')));
  }
}

/* Plugin view cleanups are keyed by plugin so a plugin that is disabled or
   reloaded releases its mounted UI even while its tab stays open. */
const pluginViewCleanups = new Map<string, Array<() => void>>();

function registerPluginViewCleanup(pluginId: string, cleanup: () => void): void {
  const list = pluginViewCleanups.get(pluginId) ?? [];
  list.push(cleanup);
  pluginViewCleanups.set(pluginId, list);
}

/**
 * Render a plugin-declared modal into the app's own modal root.
 *
 * Uses the existing openModal so a plugin modal gets the same overlay, focus
 * handling, and Escape behaviour as every built-in one — a plugin should not
 * be able to produce a dialog that looks or behaves differently.
 */
export function openPluginModalInApp(pluginId: string, modalId: string, title: string): boolean {
  const render = modalRenderer(pluginId, modalId);
  if (!render) return false;
  const host = h('div', { class: 'plugin-modal-body' });
  const modal = openModal({ title, body: host });
  try {
    const cleanup = render(host);
    if (typeof cleanup === 'function') {
      modal.overlay.addEventListener('plugin:closed', () => cleanup(), { once: true });
      /* openModal's own close removes the overlay; observe removal so the
         cleanup runs however the modal was dismissed */
      const observer = new MutationObserver(() => {
        if (!document.body.contains(modal.overlay)) {
          cleanup();
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  } catch (e) {
    console.error(`[plugin:${pluginId}] modal \`${modalId}\` threw`, e);
    host.textContent = 'This dialog failed to render.';
  }
  return true;
}

export function disposePluginViews(pluginId?: string): void {
  const ids = pluginId ? [pluginId] : [...pluginViewCleanups.keys()];
  for (const id of ids) {
    for (const cleanup of pluginViewCleanups.get(id)?.splice(0) ?? []) {
      try {
        cleanup();
      } catch (e) {
        console.error(`[plugin:${id}] view cleanup threw`, e);
      }
    }
    pluginViewCleanups.delete(id);
  }
}

/* ---------------- app bar wiring ---------------- */

function togglePaneHidden(): void {
  clearTerminalSelections();
  /* the rail flyout is a body-level popover, so the stylesheet hiding the rail
     cannot take it down with the sidebar; expanding the sidebar ends it here */
  closeRailFlyout();
  db.prefs.paneHidden = !(db.prefs.paneHidden === true);
  void api.setPrefs({ paneHidden: db.prefs.paneHidden });
  document.body.classList.toggle('pane-hidden', db.prefs.paneHidden === true);
  /* the compact rail only exists while the sidebar is minimized, and its
     buttons are built by renderSidebar() — the CSS alone cannot fill it */
  renderSidebar();
}

function wirePaneToggle(): void {
  $('#paneBtn').addEventListener('click', togglePaneHidden);
  $('#paneTopBtn').addEventListener('click', togglePaneHidden);
  $('#compactAddBtn').addEventListener('click', e => openAddWorkspaceMenu(e.currentTarget as HTMLElement));
  $('#compactSettingsBtn').addEventListener('click', () => {
    void import('./views/settings').then(m => m.openSettingsModal());
  });
}

function wireHistory(): void {
  $('#backBtn').addEventListener('click', () => stepHistory(-1));
  $('#redoBtn').addEventListener('click', () => stepHistory(1));
  $('#backTopBtn').addEventListener('click', () => stepHistory(-1));
  $('#redoTopBtn').addEventListener('click', () => stepHistory(1));
}

function wireScrim(): void {
  $('#scrim').addEventListener('pointerdown', () => { ui.sidebarOpen = false; render(); });
}

/* Resolve actual dark/light from pref, falling back to OS for 'system'/undefined */
export function resolveTheme(): 'light' | 'dark' {
  if (db.prefs.theme === 'dark') return 'dark';
  if (db.prefs.theme === 'light') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function toggleTheme(): void {
  db.prefs.theme = db.prefs.theme === 'dark' ? 'light' : 'dark';
  void api.setPrefs({ theme: db.prefs.theme });
  document.documentElement.classList.toggle('dark', resolveTheme() === 'dark');
  render(); /* terminals re-theme in place */
}

export function setThemeMode(mode: 'light' | 'dark' | 'system'): void {
  if (db.prefs.theme === mode) return;
  db.prefs.theme = mode;
  void api.setPrefs({ theme: mode });
  document.documentElement.classList.toggle('dark', resolveTheme() === 'dark');
  render();
}

export function setPalette(palette: import('../shared/types').PaletteName): void {
  if (db.prefs.palette === palette) return;
  db.prefs.palette = palette;
  void api.setPrefs({ palette });
  applyPaletteClass(palette);
  render();
}

export function setTerminalFont(font: string | null | undefined): void {
  db.prefs.font = font === null ? undefined : (font || undefined);
  void api.setPrefs({ font: font === null ? null : db.prefs.font });
  applyFontPrefs();
  applyTerminalFont();
}

export function setTerminalFontSize(size: number | undefined): void {
  db.prefs.fontSize = size;
  void api.setPrefs({ fontSize: db.prefs.fontSize });
  applyFontPrefs();
  applyTerminalFont();
}

function wireTheme(): void {
  $('#themeBtn').addEventListener('click', toggleTheme);
}

function wireWindowControls(): void {
  api.onMaximized(max => {
    ui.maximized = max;
    document.body.classList.toggle('maximized', max);
  });
  /* The three OS buttons only exist on Windows (the other platforms keep their
     native frame), but the handlers are harmless there: the elements are in
     the DOM either way and the commands are cross-platform. */
  $('#winMinBtn').addEventListener('click', () => { api.minimize(); });
  $('#winMaxBtn').addEventListener('click', () => { api.toggleMaximize(); });
  /* X closes the window, but the backend turns that into a hide: the app
     keeps running in the background with its tray icon (see src-tauri/
     src/tray.rs), so agents, the approval bridge and the remote monitor stay
     alive. Left-click the tray icon to bring the window back; Quit for real
     is the tray menu's Quit item or Settings -> Quit. */
  $('#winCloseBtn').addEventListener('click', () => { api.close(); });
  wireWindowDrag();
}

/* Manual window drag, threshold-based: invoke startDragging() only after the
   pointer actually moves. Starting it on bare mousedown makes a click without
   movement open a drag session that never sees the mouseup — macOS then eats
   the next click and overrides the cursor. */
const DRAG_SKIP = 'button, a, input, select, textarea, .tab';

function wireWindowDrag(): void {
  const bar = $('#titlebar');
  let armed: { x: number; y: number } | null = null;
  bar.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest(DRAG_SKIP)) return;
    e.preventDefault();
    armed = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('mousemove', e => {
    if (!armed) return;
    if (e.buttons !== 1) { armed = null; return; }
    if (Math.hypot(e.clientX - armed.x, e.clientY - armed.y) < 4) return;
    armed = null;
    void getCurrentWindow().startDragging();
  });
  window.addEventListener('mouseup', () => { armed = null; });
  bar.addEventListener('dblclick', e => {
    if ((e.target as Element).closest(DRAG_SKIP)) return;
    api.toggleMaximize();
  });
}

function clampSidebarWidth(clientX: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(window.innerWidth * MAX_SIDEBAR_RATIO, clientX));
}

function wireSidebarResize(): void {
  const resize = $('#sidebarResize');
  let resizing = false;
  resize.addEventListener('pointerdown', e => {
    if (window.matchMedia('(max-width:900px)').matches) return;
    resizing = true;
    resize.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing-sidebar');
  });
  resize.addEventListener('pointermove', e => {
    if (!resizing) return;
    db.prefs.sidebarWidth = clampSidebarWidth(e.clientX);
    document.documentElement.style.setProperty('--sidebar-width', db.prefs.sidebarWidth + 'px');
  });
  resize.addEventListener('pointerup', () => {
    if (!resizing) return;
    resizing = false;
    void api.setPrefs({ sidebarWidth: db.prefs.sidebarWidth });
    document.body.classList.remove('resizing-sidebar');
  });
}

function wireAppBar(): void {
  wirePaneToggle();
  wireHistory();
  wireScrim();
  wireTheme();
  wireWindowControls();
  wireSidebarResize();
  wireGitPill();
  wirePluginTopbar();
}

/* ---------------- plugin host lifecycle events ----------------
   The three events a plugin may subscribe to. They are derived from state the
   app already tracks rather than from new backend emitters, so subscribing
   costs nothing when no plugin is listening. */

function subscribeHostEvent(event: string, cb: (payload: unknown) => void): () => void {
  switch (event) {
    case 'workspace:changed':
      return api.onBranch((wsId, branch) => cb({ workspaceId: wsId, branch }));
    case 'tab:activated':
      return onTabActivated(cb);
    case 'tab:closed':
      return onTabClosed(cb);
    default:
      console.warn(`[plugin-host] unknown host event \`${event}\``);
      return () => {};
  }
}

const tabActivatedSubs = new Set<(payload: unknown) => void>();
const tabClosedSubs = new Set<(payload: unknown) => void>();

function onTabActivated(cb: (payload: unknown) => void): () => void {
  tabActivatedSubs.add(cb);
  return () => { tabActivatedSubs.delete(cb); };
}

function onTabClosed(cb: (payload: unknown) => void): () => void {
  tabClosedSubs.add(cb);
  return () => { tabClosedSubs.delete(cb); };
}

/** Called by the tab strip when the active tab changes. */
export function emitTabActivated(tabId: string | null): void {
  for (const cb of tabActivatedSubs) {
    try {
      cb({ tabId });
    } catch (e) {
      console.error('[plugin-host] tab:activated listener threw', e);
    }
  }
}

/** Called by the tab strip when a tab is removed. */
export function emitTabClosed(tabId: string): void {
  for (const cb of tabClosedSubs) {
    try {
      cb({ tabId });
    } catch (e) {
      console.error('[plugin-host] tab:closed listener threw', e);
    }
  }
}

/* ---------------- plugin-contributed topbar buttons ----------------
   Rendered from the manifest alone, so a button appears even though the
   plugin's code has not been imported. The click activates the plugin first
   (lazy activation) and then runs the command. */

function wirePluginTopbar(): void {
  const host = document.getElementById('pluginTopbar');
  if (!host) return;
  host.innerHTML = '';
  for (const entry of topbarEntries()) {
    const icon = contributionIcon(entry.pluginId, entry.contribution, pluginAssetUrl);
    const label = contributionLabel(entry.contribution);
    const btn = h('button', {
      class: 'tbtn plugin-topbar-btn',
      type: 'button',
      title: `${label} — ${entry.pluginName}`,
      'aria-label': label,
      dataset: { plugin: entry.pluginId, contribution: entry.contribution.id },
      onclick: () => {
        void ensureActive(entry.pluginId).then(ok => {
          if (ok) entry.run();
          else console.warn(`[plugin:${entry.pluginId}] could not activate to run \`${entry.contribution.id}\``);
        });
      },
    }, icon ?? h('span', { class: 'plugin-topbar-label' }, label));
    host.append(btn);
  }
}

function wireGitPill(): void {
  const pill = document.getElementById('gitChangesPill');
  if (!pill) return;
  pill.addEventListener('click', () => toggleGitPanel());
}

registerRenderers({ root: renderRoot, content: renderContentInner, sidebar: renderSidebar });

/* ---------------- clock: refresh relative times ---------------- */

/* The Changes-pill heartbeat lives in gitPanel.ts (startPillHeartbeat): 15 s,
   stood down while the panel's own 4 s poll covers the active workspace, and
   skipped while the tab is hidden. */
startPillHeartbeat();

setInterval(() => {
  $$('[data-ts]').forEach(el => {
    const ts = Number((el as HTMLElement).dataset.ts);
    el.textContent = String(ts).length > 6 ? rel(ts) : '';
    el.title = abs(ts);
  });
}, 30000);

/* ---------------- boot ---------------- */

async function loadInitialBranches(): Promise<void> {
  await Promise.all(db.workspaces.map(async w => {
    branches.set(w.id, await api.branchFor(w.path));
  }));
}

let statusAudio: AudioContext | null = null;
const lastAgentStates: Record<string, string | null | undefined> = {};

/* Global error handler: catch unhandled promise rejections so UI failures
   are visible instead of silently breaking plugin views. */
window.addEventListener('unhandledrejection', e => {
  console.error('[unhandled-rejection]', e.reason);
});

async function playAgentStatusSound(kind: 'finished' | 'blocked' | 'idle'): Promise<void> {
  if (db.prefs.notifEnabled === false || db.prefs.notifSound === false) return;
  const AudioCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return;
  statusAudio ??= new AudioCtor();
  await statusAudio.resume();
  const now = statusAudio.currentTime;
  const notes = kind === 'blocked' ? [220, 165] : kind === 'finished' ? [660, 880] : [520, 660];
  for (const [index, frequency] of notes.entries()) {
    const oscillator = statusAudio.createOscillator();
    const gain = statusAudio.createGain();
    const at = now + index * 0.12;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.22, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    oscillator.connect(gain).connect(statusAudio.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.24);
  }
}

function notifyAgentTransition(id: string, state: string | null | undefined): void {
  const previous = lastAgentStates[id];
  lastAgentStates[id] = state;
  if (previous === undefined || previous === state) return;
  if (state === 'blocked') void playAgentStatusSound('blocked');
  else if (previous === 'working' && state === 'idle') void playAgentStatusSound('finished');
  else if (previous === 'blocked' && state === 'idle') void playAgentStatusSound('idle');
}


function subscribeRuntime(): void {
  /* Runtime ticks arrive ~1 Hz per backend change. A full renderSidebar()
     rebuilds the whole nav each time; patch the status rows in place and
     only fall back to a full render when the pane set itself changed. */
  let pending: ReturnType<typeof setTimeout> | null = null;
  api.onRuntimeStatus(statuses => {
    let structureChanged = false;
    for (const [id, st] of Object.entries(statuses)) {
      notifyAgentTransition(id, st.state);
      if (!(id in runtime)) structureChanged = true;
      runtime[id] = st;
      if (st.running) activity[id] = Date.now();
    }
    for (const id of Object.keys(runtime)) {
      if (!(id in statuses)) { delete runtime[id]; structureChanged = true; }
    }
    if (structureChanged) { renderSidebar(); return; }
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      if (!patchPaneStatuses()) renderSidebar();
    }, 100);
  });
}

function restoreInitialView(restored: import('../shared/types').TabRec[]): void {
  if (restored.length) { activate('term:' + restored[0].id); return; }
  if (!db.workspaces.length) { ui.route = { view: 'welcome' }; }
  render();
}

function logSmokeIfRequested(): void {
  if ((window as unknown as { __BENTOMUX_SMOKE?: boolean }).__BENTOMUX_SMOKE) {
    console.log('[smoke-render] ok workspaces=' + db.workspaces.length + ' tabs=' + ui.tabs.length);
  }
}

/* The boot splash is static markup in index.html (see the inline style there),
   so it is on screen from the first frame. Fade it out once the initial route
   has rendered and remove it — idempotent because the boot error path may call
   it too. Double rAF: the first frame applies the route, the second confirms
   the browser actually painted it, so the fade never reveals a half-built
   shell. */
let bootSplashGone = false;
function hideBootSplash(): void {
  if (bootSplashGone) return;
  bootSplashGone = true;
  const splash = document.getElementById('bootSplash');
  if (!splash) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      splash.classList.add('boot-splash--done');
      /* remove after the fade; the timeout is the fallback for a splash that
         never fires transitionend (reduced-motion, hidden window) */
      splash.addEventListener('transitionend', () => splash.remove(), { once: true });
      window.setTimeout(() => splash.remove(), 400);
    });
  });
}

function wireUpdateBanner(): void {
  const banner = document.getElementById('updateBanner');
  if (!banner) return;
  const b = banner;
  let dismissed = false;

  function paint(): void {
    const s = updateStatus;
    if (dismissed || (s.phase !== 'available' && s.phase !== 'ready')) {
      b.hidden = true;
      return;
    }
    b.hidden = false;
    b.innerHTML = '';
    const msg = s.phase === 'ready'
      ? 'Bentomux v' + s.available + ' installed — restart to apply'
      : 'Bentomux v' + s.available + ' available';
    const settingsBtn = h('button', {
      class: 'btn primary',
      type: 'button',
      onclick: () => { void import('./views/settings').then(m => m.openSettingsModal()); },
    }, s.phase === 'ready' ? 'Restart' : 'Update');
    const closeBtn = h('button', {
      class: 'btn ghost',
      type: 'button',
      onclick: () => { dismissed = true; b.hidden = true; },
    }, '×');
    b.append(h('span', { class: 'update-banner-msg' }, msg), settingsBtn, closeBtn);
  }

  onUpdateChange(paint);
  paint();
}

async function boot(): Promise<void> {
  const bootStart = performance.now();
  setDb(await api.getState());

  /* wire the plugin host before anything can activate a plugin: storage and
     events need modules that import this one, so they are handed over rather
     than imported from the loader */
  bindHost({
    storageGet: (id, key) => api.pluginDataGet(id, key),
    storageSet: (id, key, value) => api.pluginDataSet(id, key, value),
    storageDelete: (id, key) => api.pluginDataDelete(id, key),
    storageKeys: id => api.pluginDataKeys(id),
    hostEvent: (event, cb) => subscribeHostEvent(event, cb),
    openTab: (pluginId, tabId, title) => openPluginTab(pluginId, tabId, title),
    openModal: (pluginId, modalId, title) => openPluginModalInApp(pluginId, modalId, title),
  });
  /* a disabled or reloaded plugin must release the UI it mounted in the
     shell, not just its registry entries */
  onTeardown(pluginId => {
    disposePluginViews(pluginId);
    disposeWidgets();
  });

  /* Sync dark class when OS theme changes and user is on 'system' */
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!db.prefs.theme || db.prefs.theme === 'system') {
      document.documentElement.classList.toggle('dark', resolveTheme() === 'dark');
      render();
    }
  });

  /* live subscriptions before anything renders */
  initTerminalEvents();
  api.onBranch((wsId, branch) => {
    branches.set(wsId, branch);
    renderSidebar();
    renderTabs();
    /* the pill is keyed on the active workspace; if the branch that just
       changed belongs to the active workspace, re-fetch the diff stat so
       the +N -N stays in sync without the user opening the panel. */
    if (wsId === db.activeWorkspaceId) void refreshChangesPill();
  });
  subscribeRuntime();
  initAgentEvents();

  /* restore last session's tabs as fresh shells. Awaited: tab registration
     must land before the first paint or the initial route is empty. */
  const restored = await api.restoreTabs();
  for (const rec of restored) {
    registerRestoredTab(rec);
    activity[rec.id] = Date.now();
  }

  wireAppBar();
  initKeyboard();

  restoreInitialView(restored);
  hideBootSplash();
  logSmokeIfRequested();
  console.info('[perf] renderer-boot-ms=' + Math.round(performance.now() - bootStart));

  /* everything below is deferred past first paint: branch names, the Changes
     pill, and plugin activation each cost IPC git spawns. They fill in
     within a beat without blocking the shell. */
  void loadInitialBranches().then(() => renderSidebar());
  void refreshChangesPill();

  /* Plugins come last, and deliberately: their activation must not delay the
     shell's first paint. Services start here too, once the window is
     interactive (docs/PLUGIN_PLATFORM.md §2). A failure in this step is the
     plugin host's problem, never the app's — boot has already succeeded. */
  void initPlugins()
    .then(() => {
      /* a successful boot clears the safe-mode counter; if the app got this
         far, the previous failures were not this session's */
      return api.pluginReportReady();
    })
    .catch(e => console.error('[plugin-host] init failed', e));

  /* surfaces that render plugin entries re-render when the registry changes:
     activation is lazy, so a button's icon or a widget's body can appear
     after the first paint */
  onPluginsChanged(() => {
    wirePluginTopbar();
    renderSidebar();
    if (ui.route.view === 'welcome') renderContentInner(ui.route);
  });

  /* update check (after render so UI is not blocked) */
  wireUpdateBanner();
  initAutoUpdate(db.prefs.autoUpdate !== false);
}
boot().catch(e => {
  console.error(e);
  /* boot never reached first paint, so the splash is still up: take it down
     or it would hide the only explanation the user gets */
  hideBootSplash();
  document.body.innerText = 'Bentomux boot error: ' + (e instanceof Error ? e.message : String(e));
});
