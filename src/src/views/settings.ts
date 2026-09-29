/* ---------------- settings modal (left menu + section content) ----------------
   Opens as a modal with an internal menu; sections plug into SECTIONS below.
   Ships Appearance, Keybindings, Notifications, and Updates. */

import { h, markup } from '../dom';
import { currentModal, field, openModal } from '../components/modal';
import { selectEl } from '../components/select';
import { toggleSeg } from '../components/toggle';
import { ic, IC } from '../icons';
import { db } from '../store';
import { setThemeMode, setPalette, setTerminalFont, setTerminalFontSize } from '../main';
import { accelFor, formatAccel, type ActionId } from '../keyboard';
import { PALETTES, type PaletteName, type AgentHooksStatus, type Prefs } from '../../shared/types';
import {
  updateStatus, checkForUpdate, installUpdate, restartApp, onUpdateChange,
  type UpdatePhase,
} from '../updates';
import { openUrl } from '@tauri-apps/plugin-opener';
import { settingsSectionEntries } from '../plugin/registry';
import { onPluginsChanged } from '../plugin/loader';
import { contributionLabel } from '../plugin/icons';
import { buildPluginsSection } from './pluginStudio';
import api from '../../preload/bentomux';

/* persist one pref key and run any immediate side effect; callers repaint
   the modal content afterwards */
function setPref<K extends keyof Prefs>(key: K, value: Prefs[K], apply?: () => void): void {
  db.prefs[key] = value;
  const patch: Prefs = {};
  patch[key] = value;
  void api.setPrefs(patch);
  apply?.();
}

/* muted explanation line under a field */
function hint(text: string): HTMLElement {
  return h('div', { class: 'settings-hint' }, text);
}

const PALETTE_LABELS: Record<PaletteName, string> = {
  default: 'Default',
  catppuccin: 'Catppuccin',
  'rose-pine': 'Rosé Pine',
  gruvbox: 'Gruvbox',
  dracula: 'Dracula',
  nord: 'Nord',
  classic: 'Classic',
  eink: 'E-Ink',
  'tokyo-night': 'Tokyo Night',
  'pastel-pixel': 'Pastel Pixel',
};

/* three dots echo the palette's surface / accent / ink so users can
   recognize the theme at a glance without reading the label */
const PALETTE_SWATCH: Record<PaletteName, [string, string, string]> = {
  default: ['#F9FAFB', '#2563EB', '#1F2328'],
  catppuccin: ['#eff1f5', '#1e66f5', '#4c4f69'],
  'rose-pine': ['#faf4ed', '#286983', '#575279'],
  gruvbox: ['#fbf1c7', '#458588', '#3c3836'],
  dracula: ['#f8f8f2', '#bd93f9', '#282a36'],
  nord: ['#eceff4', '#5e81ac', '#2e3440'],
  classic: ['#fff6e5', '#ffcd75', '#3b2a1f'],
  eink: ['#ffffff', '#000000', '#000000'],
  'tokyo-night': ['#eceef2', '#2e7de9', '#34355a'],
  'pastel-pixel': ['#fdf9f0', '#a088d8', '#5c4a3d'],
};

function syncSeg(seg: HTMLElement, onIndex: number): void {
  Array.from(seg.children as HTMLCollectionOf<HTMLElement>).forEach((el, i) =>
    el.classList.toggle('on', i === onIndex));
}

/* ---------------- Appearance ---------------- */

function themeIndex(): number {
  if (db.prefs.theme === 'light') return 0;
  if (db.prefs.theme === 'dark') return 1;
  return 2; /* 'system' or undefined */
}

function buildModeSeg(paint: () => void): HTMLElement {
  const seg = h('div', { class: 'seg' },
    h('button', { onclick: () => { setThemeMode('light'); paint(); } }, 'Light'),
    h('button', { onclick: () => { setThemeMode('dark'); paint(); } }, 'Dark'),
    h('button', { onclick: () => { setThemeMode('system'); paint(); } }, 'System'));
  syncSeg(seg, themeIndex());
  return seg;
}

function buildPaletteGrid(paint: () => void): HTMLElement {
  const current: PaletteName = (db.prefs.palette as PaletteName) || 'default';
  const grid = h('div', { class: 'palette-grid' });
  for (const p of PALETTES) {
    const [bg, accent, ink] = PALETTE_SWATCH[p];
    const isCurrent = p === current;
    const card = h('button', {
      class: 'palette-card' + (isCurrent ? ' current' : ''),
      type: 'button',
      'data-palette': p,
      onclick: () => { setPalette(p); paint(); },
    },
      h('span', { class: 'palette-swatch' },
        h('span', { style: 'background:' + bg }),
        h('span', { style: 'background:' + accent }),
        h('span', { style: 'background:' + ink })),
      h('span', { class: 'palette-name' }, PALETTE_LABELS[p]),
      h('span', { class: 'palette-check' }, '✓'));
    grid.append(card);
  }
  return grid;
}

/* Curated terminal fonts with guaranteed Unicode box-drawing support.
   Each stack includes fallbacks so missing fonts gracefully degrade. */
const TERM_FONTS: Array<{ label: string; stack: string }> = [
  { label: 'Default', stack: '' },
  { label: 'SF Mono', stack: '"SF Mono", Monaco, Menlo, monospace' },
  { label: 'Menlo', stack: 'Menlo, Monaco, monospace' },
  { label: 'Monaco', stack: 'Monaco, Menlo, monospace' },
  { label: 'Cascadia Code', stack: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  { label: 'Consolas', stack: 'Consolas, "Courier New", monospace' },
  { label: 'JetBrains Mono', stack: '"JetBrains Mono", Menlo, monospace' },
  { label: 'Fira Code', stack: '"Fira Code", "Fira Mono", monospace' },
  { label: 'DejaVu Sans Mono', stack: '"DejaVu Sans Mono", monospace' },
  { label: 'Liberation Mono', stack: '"Liberation Mono", monospace' },
  { label: 'Courier New', stack: '"Courier New", Courier, monospace' },
];

const TERM_FONT_SIZES = [10, 11, 12, 12.5, 13, 14, 15, 16, 18];
const DEFAULT_FONT_SIZE = 12.5;

function buildFontSelect(): HTMLElement {
  const sel = selectEl(
    TERM_FONTS.map(f => [f.stack, f.label]),
    db.prefs.font || '');
  sel.addEventListener('change', () => setTerminalFont(sel.value === '' ? null : sel.value));
  return sel;
}

function buildFontSizeSelect(): HTMLElement {
  const current = db.prefs.fontSize || DEFAULT_FONT_SIZE;
  const opts: Array<[string, string]> = TERM_FONT_SIZES.map(s => [String(s), s === DEFAULT_FONT_SIZE ? s + ' (default)' : String(s)]);
  const sel = selectEl(opts, String(current));
  sel.addEventListener('change', () => {
    const v = parseFloat(sel.value);
    setTerminalFontSize(Number.isFinite(v) ? v : undefined);
  });
  return sel;
}

function buildAppearanceSection(paint: () => void): HTMLElement {
  return h('div', { class: 'settings-section' },
    field('Theme', buildModeSeg(paint)),
    field('Palette', buildPaletteGrid(paint)),
    field('Terminal font', buildFontSelect()),
    field('Font size', buildFontSizeSelect()));
}

/* ---------------- Keybindings ---------------- */

interface KeyAction {
  id: ActionId;
  label: string;
}

const KEY_ACTIONS: KeyAction[] = [
  { id: 'palette', label: 'Open search palette' },
  { id: 'splitDefault', label: 'Split pane (default direction)' },
  { id: 'splitAlt', label: 'Split pane (alternate direction)' },
];

const FIXED_KEY_ROWS: Array<[string, string]> = [
  ['Copy selection', 'Ctrl+C'],
  ['Paste', 'Ctrl+V'],
  ['Close modal', 'Esc'],
];

function keyRow(action: KeyAction, paint: () => void): HTMLElement {
  const chip = h('button', {
    class: 'key-chip',
    type: 'button',
    title: 'Click, then press the new shortcut',
    onclick: () => startKeyCapture(action, chip, paint),
  }, formatAccel(accelFor(action.id)));
  return h('div', { class: 'keys-row' },
    h('span', { class: 'keys-label' }, action.label),
    chip);
}

function fixedKeyRow(label: string, accel: string): HTMLElement {
  return h('div', { class: 'keys-row' },
    h('span', { class: 'keys-label' }, label),
    h('span', { class: 'key-chip static' }, accel));
}

function accelFromEvent(e: KeyboardEvent): string | null {
  const mods = [
    e.ctrlKey && 'ctrl',
    e.metaKey && 'meta',
    e.altKey && 'alt',
    e.shiftKey && 'shift',
  ].filter((m): m is string => !!m);
  /* at least one modifier, so plain typing can never be bound */
  if (!mods.length) return null;
  return [...mods, e.key.toLowerCase()].join('+');
}

/* one-shot key capture for rebinding. Listens on window in the capture
   phase so the global shortcut handler (document bubble) never sees the
   keystroke; a pointerdown outside the chip cancels. */
function startKeyCapture(action: KeyAction, chip: HTMLElement, paint: () => void): void {
  chip.classList.add('capturing');
  chip.textContent = 'Press keys…';
  const cleanup = (): void => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerdown', onOutside, true);
  };
  function onKey(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { cleanup(); paint(); return; }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const accel = accelFromEvent(e);
    if (!accel) return;
    cleanup();
    const clash = KEY_ACTIONS.find(o => o.id !== action.id && accelFor(o.id) === accel);
    if (clash) {
      chip.classList.remove('capturing');
      chip.textContent = 'Used by \u201C' + clash.label + '\u201D';
      setTimeout(paint, 1400);
      return;
    }
    db.prefs.shortcuts = { ...(db.prefs.shortcuts || {}), [action.id]: accel };
    void api.setPrefs({ shortcuts: db.prefs.shortcuts });
    paint();
  }
  function onOutside(e: PointerEvent): void {
    if (e.target === chip) return;
    cleanup();
    paint();
  }
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onOutside, true);
}

function buildKeysSection(paint: () => void): HTMLElement {
  const rows = h('div', { class: 'keys-list' });
  for (const a of KEY_ACTIONS) rows.append(keyRow(a, paint));
  for (const [label, accel] of FIXED_KEY_ROWS) rows.append(fixedKeyRow(label, accel));
  return h('div', { class: 'settings-section' },
    rows,
    hint('Click a shortcut, then press the new combination. Escape cancels.'));
}

/* ---------------- Notifications (approval overlay + hooks) ---------------- */

function notifToggle(key: 'notifEnabled' | 'notifSound', paint: () => void): HTMLElement {
  return toggleSeg(db.prefs[key] !== false, on => setPref(key, on, paint));
}

function buildNotificationsSection(paint: () => void): HTMLElement {
  const statusLine = h('span', { class: 'settings-hint' }, 'Checking…');
  const action = h('button', { class: 'btn ghost', type: 'button' }, '…');
  let current: AgentHooksStatus | null = null;

  const paintStatus = (): void => {
    if (!current) return;
    if (current.error) { action.textContent = 'Retry'; statusLine.textContent = current.error; return; }
    action.textContent = current.installed ? 'Remove hooks' : 'Install hooks';
    statusLine.textContent = current.installed
      ? 'Installed — ' + current.settingsPath
      : 'Not installed';
  };
  action.addEventListener('click', () => {
    if (!current) return;
    const next = current.installed
      ? api.agentHooksUninstall()
      : api.agentHooksInstall();
    void next.then(st => { current = st; paintStatus(); });
  });
  void api.agentHooksStatus().then(st => { current = st; paintStatus(); });

  return h('div', { class: 'settings-section' },
    field('Notifications', notifToggle('notifEnabled', paint)),
    hint('Shows approval requests and plays status sounds when an agent finishes, becomes blocked, or returns to idle. With this off, on-screen notifications are suppressed; phone approvals still work.'),
    field('Notification sound', notifToggle('notifSound', paint)),
    field('Approval hooks', h('div', { class: 'hooks-row' }, action, statusLine)),
    hint('Claude Code asks Bentomux for permission decisions, answered in the floating overlay. Requires Node on PATH; agents fail open when Bentomux is closed.'));
}

/* ---------------- Updates ---------------- */

const PHASE_LABEL: Record<UpdatePhase, string> = {
  idle:        'Not checked yet',
  checking:    'Checking…',
  current:     'Up to date',
  available:   'Update available',
  downloading: 'Downloading…',
  ready:       'Ready to install',
  error:       'Check failed',
};

function buildUpdatesSection(paint: () => void): HTMLElement {
  const statusLine = h('span', { class: 'settings-hint' }, '…');
  const checkBtn   = h('button', { class: 'btn', type: 'button' }, 'Check now') as HTMLButtonElement;
  const actionBtn  = h('button', { class: 'btn primary', type: 'button', style: 'display:none' }, '') as HTMLButtonElement;
  const fallback   = h('a', { class: 'settings-hint', href: '#', style: 'display:none' }, 'Open release page') as HTMLAnchorElement;
  let unsub: (() => void) | null = null;

  function paintStatus(): void {
    const s = updateStatus;
    statusLine.textContent = PHASE_LABEL[s.phase]
      + (s.phase === 'available' || s.phase === 'ready' ? ' — v' + s.available : '')
      + (s.phase === 'downloading' ? ' ' + s.progress + '%' : '')
      + (s.phase === 'error' ? ': ' + s.error : '');

    const showInstall = s.phase === 'available';
    const showRestart = s.phase === 'ready';
    const showFallback = s.phase === 'error';

    actionBtn.style.display = (showInstall || showRestart) ? '' : 'none';
    actionBtn.textContent   = showRestart ? 'Restart now' : 'Install update';
    fallback.style.display  = showFallback ? '' : 'none';
    fallback.href           = s.releaseUrl;
    checkBtn.disabled       = s.phase === 'checking' || s.phase === 'downloading';
  }

  paintStatus();
  unsub = onUpdateChange(paintStatus);
  /* detach when the section is removed from DOM */
  statusLine.addEventListener('disconnectedCallback', () => unsub?.());

  checkBtn.addEventListener('click', () => { void checkForUpdate(); });
  actionBtn.addEventListener('click', () => {
    if (updateStatus.phase === 'ready') { void restartApp(); }
    else { void installUpdate(); }
  });
  fallback.addEventListener('click', e => { e.preventDefault(); void openUrl(updateStatus.releaseUrl); });

  const versionHint = h('div', { class: 'settings-hint' },
    'Installed: v' + (updateStatus.version || '…'));

  /* keep installed version up to date if it resolved after modal open */
  const unsubVersion = onUpdateChange(() => {
    versionHint.textContent = 'Installed: v' + (updateStatus.version || '…');
  });
  versionHint.addEventListener('disconnectedCallback', () => unsubVersion());

  return h('div', { class: 'settings-section' },
    field('Auto-update',
      toggleSeg(db.prefs.autoUpdate !== false, on => setPref('autoUpdate', on, paint))),
    hint('Check for updates on launch and every 6 hours when enabled.'),
    versionHint,
    field('Status', h('div', { class: 'hooks-row' }, checkBtn, statusLine)),
    h('div', { class: 'hooks-row', style: 'margin-top:8px;gap:8px' }, actionBtn, fallback));
}

/* ---------------- Sessions (the pty host daemon) ---------------- */

/* Panes live in a daemon that outlives the app, which is the point — but it
   also means Cmd+Q no longer stops anything. This is the one place that does.
   The confirm is inline rather than a nested modal: only one modal can be open
   at a time, and this section already lives inside one. */
function buildSessionsSection(_paint: () => void): HTMLElement {
  const row = h('div', { class: 'hooks-row' });
  let armed = false;

  const draw = (): void => {
    row.innerHTML = '';
    if (!armed) {
      row.append(h('button', {
        class: 'btn',
        type: 'button',
        onclick: () => { armed = true; draw(); },
      }, 'Quit and stop all panes'));
      return;
    }
    row.append(
      h('span', { class: 'settings-hint' }, 'Stop every running pane and quit?'),
      h('button', {
        class: 'btn ghost',
        type: 'button',
        onclick: () => { armed = false; draw(); },
      }, 'Cancel'),
      h('button', {
        class: 'btn primary',
        type: 'button',
        onclick: () => { void api.quitApp(true); },
      }, 'Stop and quit'),
    );
  };
  draw();

  return h('div', { class: 'settings-section' },
    hint('Panes run in a background daemon, so quitting or closing Bentomux leaves your agents working. Reopen Bentomux and they are still there.'),
    field('Stop everything', row),
    hint('Stops every pane and the daemon, then quits. Nothing is left running.'));
}

/* ---------------- modal shell ---------------- */

interface SettingsSection {
  id: string;
  label: string;
  icon: keyof typeof IC;
  build: (paint: () => void) => HTMLElement;
}

const SECTIONS: SettingsSection[] = [
  { id: 'appearance', label: 'Appearance', icon: 'lines', build: buildAppearanceSection },
  { id: 'keys', label: 'Keybindings', icon: 'key', build: buildKeysSection },
  { id: 'notifications', label: 'Notifications', icon: 'bell', build: buildNotificationsSection },
  { id: 'sessions', label: 'Sessions', icon: 'term', build: buildSessionsSection },
  { id: 'plugins', label: 'Plugins', icon: 'board', build: buildPluginsSection },
  { id: 'updates', label: 'Updates', icon: 'gear', build: buildUpdatesSection },
];

/* Plugin-contributed settings sections are appended after the built-ins, so a
   plugin can never displace a section the app itself depends on. */
function allSections(): SettingsSection[] {
  const contributed: SettingsSection[] = settingsSectionEntries().map(entry => ({
    id: `plugin:${entry.contribution.id}`,
    label: contributionLabel(entry.contribution),
    icon: 'board' as keyof typeof IC,
    build: entry.build,
  }));
  return [...SECTIONS, ...contributed];
}

export function openSettingsModal(): void {
  if (currentModal) return; /* one modal at a time — keyboard handler also guards */
  let sections = allSections();
  let activeId = sections[0].id;

  const menuHost = h('div', { class: 'settings-menu' });
  const contentHost = h('div', { class: 'settings-content' });
  let menuItems: Array<{ btn: HTMLElement; id: string }> = [];

  function buildMenu(): void {
    menuHost.innerHTML = '';
    menuItems = [];
    for (const s of sections) {
      const btn = h('button', {
        class: 'nav-item',
        type: 'button',
        onclick: () => { if (activeId !== s.id) { activeId = s.id; paint(); } },
      }, ic(s.icon), h('span', {}, s.label));
      menuItems.push({ btn, id: s.id });
      menuHost.append(btn);
    }
  }

  function paint(): void {
    const section = sections.find(s => s.id === activeId) ?? sections[0];
    contentHost.innerHTML = '';
    contentHost.append(section.build(paint));
    for (const { btn, id } of menuItems) btn.classList.toggle('active', id === activeId);
  }

  buildMenu();
  paint();

  /* installing, enabling, or uninstalling a plugin changes the section list
     while this modal is open — without this the removed plugin's menu entry
     stayed clickable */
  const off = onPluginsChanged(() => {
    sections = allSections();
    if (!sections.some(s => s.id === activeId)) activeId = sections[0].id;
    buildMenu();
    paint();
  });

  const modal = openModal({
    title: 'Settings',
    body: h('div', { class: 'settings-modal' }, menuHost, contentHost),
    onClose: off,
  });
  const dialog = modal.overlay.querySelector('.dialog');
  if (dialog) dialog.classList.add('settings-dialog');
}
