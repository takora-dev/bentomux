/* ---------------- keyboard ---------------- */

import { ui } from './state';
import { db } from './store';
import { render } from './render';
import { currentModal } from './components/modal';
import { leavesOf, splitTerminalPane, stepHistory, closeFocusedPaneOrTab } from './views/tabs';
import { mostRecentPane, focusRelativePane, focusPaneInDirection } from './views/terminal';
import { openSearchModal } from './views/search';
import api from '../preload/bentomux';

/* app-level shortcuts; Settings › Keybindings overrides these by action id */
/* use Cmd on macOS, Ctrl on Windows/Linux */
export const IS_MAC = navigator.platform.toLowerCase().includes('mac');
const MOD = IS_MAC ? 'meta' : 'ctrl';

/* every rebindable action. Splits and history keep Bentomux's own defaults;
   the focus actions start unbound and are what a terminal preset (Ghostty,
   iTerm2) binds. An empty string means explicitly unbound — see accelFor. */
const DEFAULT_ACCELS = {
  palette: `${MOD}+k`,
  splitDefault: `${MOD}+\\`,
  splitAlt: `${MOD}+shift+\\`,
  splitLeft: `${MOD}+alt+ArrowLeft`,
  splitUp: `${MOD}+alt+ArrowUp`,
  focusLeft: '',
  focusRight: '',
  focusUp: '',
  focusDown: '',
  focusPrev: '',
  focusNext: '',
  historyBack: IS_MAC ? 'meta+[' : '',
  historyForward: IS_MAC ? 'meta+]' : '',
} as const;
export type ActionId = keyof typeof DEFAULT_ACCELS;

export type KeyPresetId = 'default' | 'ghostty' | 'iterm';

/* Keybinding presets let someone coming from another terminal keep their
   muscle memory. Values mirror each terminal's own defaults:
     Ghostty (src/config/Config.zig): super+d = new_split:right,
       super+shift+d = new_split:down, super+[ / super+] = goto_split
       previous/next, super+alt+arrows = goto_split up/down/left/right.
     iTerm2: cmd+d split, cmd+shift+d split down, cmd+alt+arrows move between
       splits, cmd+[ / cmd+] switch tabs (which is Bentomux's tab history).
   A preset wins over Bentomux's own bindings, so choosing Ghostty leaves tab
   history and split-left/up unbound under that preset; they stay reachable
   through the Default preset and the pane context menu. */
const PRIMARY = IS_MAC ? 'meta' : 'ctrl';

export const KEY_PRESETS: Record<KeyPresetId, Record<string, string>> = {
  /* empty = no overrides, accelFor falls back to DEFAULT_ACCELS */
  default: {},
  ghostty: {
    palette: `${PRIMARY}+k`,
    splitDefault: `${PRIMARY}+d`,
    splitAlt: `${PRIMARY}+shift+d`,
    splitLeft: '',
    splitUp: '',
    focusLeft: `${PRIMARY}+alt+ArrowLeft`,
    focusRight: `${PRIMARY}+alt+ArrowRight`,
    focusUp: `${PRIMARY}+alt+ArrowUp`,
    focusDown: `${PRIMARY}+alt+ArrowDown`,
    focusPrev: `${PRIMARY}+[`,
    focusNext: `${PRIMARY}+]`,
    historyBack: '',
    historyForward: '',
  },
  iterm: {
    palette: `${PRIMARY}+k`,
    splitDefault: `${PRIMARY}+d`,
    splitAlt: `${PRIMARY}+shift+d`,
    splitLeft: '',
    splitUp: '',
    focusLeft: `${PRIMARY}+alt+ArrowLeft`,
    focusRight: `${PRIMARY}+alt+ArrowRight`,
    focusUp: `${PRIMARY}+alt+ArrowUp`,
    focusDown: `${PRIMARY}+alt+ArrowDown`,
    /* iTerm2 keeps cmd+[ / cmd+] for switching tabs, so prev/next split is
       left unbound and tab history keeps its default keys */
    focusPrev: '',
    focusNext: '',
    historyBack: IS_MAC ? 'meta+[' : '',
    historyForward: IS_MAC ? 'meta+]' : '',
  },
};

/* accelerators the app reserves outside the rebindable shortcut map. Settings
   validates a captured key against these so a rebind cannot silently collide
   with a native menu item or a hardcoded handler:
     - File ▸ Close Pane is a native menu item on CmdOrCtrl+W (menu.rs); on
       Windows/Linux the DOM handler below binds Ctrl+W to the same action.
     - Cmd/Ctrl+C and Cmd/Ctrl+V are the terminal's own copy/paste
       (views/terminal.ts); both modifiers are accepted there, so both are
       reserved on every platform.
     - Cmd+Ctrl+F toggles fullscreen (the handler in initKeyboard below).
     - Escape closes a modal. It can never be captured (accelFromEvent requires
       a modifier); listed so this set matches the fixed rows shown in Settings. */
export const RESERVED_ACCELS: ReadonlyArray<readonly [string, string]> = [
  [`${MOD}+w`, 'Close Pane (File menu)'],
  ['ctrl+c', 'Copy selection'],
  ['meta+c', 'Copy selection'],
  ['ctrl+v', 'Paste'],
  ['meta+v', 'Paste'],
  ['ctrl+meta+f', 'Toggle fullscreen'],
  ['escape', 'Close modal'],
];

/** write a preset's bindings and record which preset is active */
export function applyKeyPreset(id: KeyPresetId): void {
  const overrides: Record<string, string> = { ...KEY_PRESETS[id] };
  db.prefs.shortcuts = overrides;
  db.prefs.keyPreset = id;
  void api.setPrefs({ shortcuts: overrides, keyPreset: id });
}

/** the accelerator currently bound to an action (pref override or default).
    an explicit empty-string override means "unbound" and is respected. */
export function accelFor(action: ActionId): string {
  const overrides = db.prefs.shortcuts;
  if (overrides && action in overrides) return overrides[action];
  return DEFAULT_ACCELS[action];
}

/** "ctrl+shift+k" → "Ctrl+Shift+K" (or "Cmd+Shift+K" on macOS) for display */
export function formatAccel(accel: string): string {
  if (!accel) return '';
  const parts = accel.split('+');
  const key = parts.pop() || '';
  const prettyKey = key.length === 1 ? key.toUpperCase()
    : key.toLowerCase() === 'arrowleft' ? '←'
    : key.toLowerCase() === 'arrowup' ? '↑'
    : key.toLowerCase() === 'arrowright' ? '→'
    : key.toLowerCase() === 'arrowdown' ? '↓'
    : key.charAt(0).toUpperCase() + key.slice(1);
  const modParts = parts.map(p => {
    const lower = p.toLowerCase();
    if (lower === 'meta') return IS_MAC ? 'Cmd' : 'Ctrl';
    if (lower === 'ctrl') return IS_MAC ? 'Ctrl' : 'Ctrl';
    return p.charAt(0).toUpperCase() + p.slice(1);
  });
  return [...modParts, prettyKey].join('+');
}

/* compare a keydown against a "ctrl+shift+k"-style accelerator */
function accelMatches(e: KeyboardEvent, accel: string): boolean {
  if (!accel) return false;
  const parts = accel.toLowerCase().split('+');
  return e.ctrlKey === parts.includes('ctrl')
    && e.shiftKey === parts.includes('shift')
    && e.altKey === parts.includes('alt')
    && e.metaKey === parts.includes('meta')
    && e.key.toLowerCase() === parts[parts.length - 1];
}

function splitFocusedPane(dir: 'v' | 'h', before = false): void {
  const entry = ui.tabs.find(t => t.id === ui.activeTab);
  if (entry) void splitTerminalPane(mostRecentPane(leavesOf(entry)), dir, before);
}

/* the panes of the active terminal tab (empty when it is not a terminal) */
function activePaneIds(): string[] {
  const entry = ui.tabs.find(t => t.id === ui.activeTab);
  return entry ? leavesOf(entry) : [];
}

export function initKeyboard(): void {
  document.addEventListener('keydown', e => {
    if (currentModal) {
      if (e.key === 'Escape') { e.preventDefault(); currentModal.close(); }
      return;
    }

    /* shortcuts are matched against the bindings from Settings, listed
       before the typing check so they work even when focus is in an input */
    if (accelMatches(e, accelFor('palette'))) {
      e.preventDefault();
      openSearchModal();
      return;
    }

    if (ui.route.view === 'terminal') {
      const ids = activePaneIds();
      /* splits: Cmd+\ right, Cmd+Shift+\ down, Cmd+Alt+Left/Up left/up by
         default; a preset may rebind them (Cmd+D / Cmd+Shift+D) */
      if (accelMatches(e, accelFor('splitDefault'))) { e.preventDefault(); splitFocusedPane('v'); return; }
      if (accelMatches(e, accelFor('splitAlt'))) { e.preventDefault(); splitFocusedPane('h'); return; }
      if (accelMatches(e, accelFor('splitLeft'))) { e.preventDefault(); splitFocusedPane('v', true); return; }
      if (accelMatches(e, accelFor('splitUp'))) { e.preventDefault(); splitFocusedPane('h', true); return; }

      /* pane focus — bound by the Ghostty / iTerm2 presets */
      if (accelMatches(e, accelFor('focusLeft'))) { e.preventDefault(); focusPaneInDirection(ids, 'left'); return; }
      if (accelMatches(e, accelFor('focusRight'))) { e.preventDefault(); focusPaneInDirection(ids, 'right'); return; }
      if (accelMatches(e, accelFor('focusUp'))) { e.preventDefault(); focusPaneInDirection(ids, 'up'); return; }
      if (accelMatches(e, accelFor('focusDown'))) { e.preventDefault(); focusPaneInDirection(ids, 'down'); return; }
      if (accelMatches(e, accelFor('focusPrev'))) { e.preventDefault(); focusRelativePane(ids, -1); return; }
      if (accelMatches(e, accelFor('focusNext'))) { e.preventDefault(); focusRelativePane(ids, 1); return; }

      /* Windows/Linux: Ctrl+W closes the focused pane, or the tab when it is
         down to its last pane. macOS keeps this in the native menu
         (src-tauri/src/menu.rs) — a DOM handler there would close a second
         pane whenever the webview also saw the key. Terminal route only, so
         Ctrl+W never discards typed input on some other tab. */
      if (!IS_MAC && e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        closeFocusedPaneOrTab();
        return;
      }
    }

    const tag = (e.target as HTMLElement).tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable;

    /* tab history: Cmd+[ back, Cmd+] forward by default; a preset may
       rebind or unbind them */
    if (accelMatches(e, accelFor('historyBack'))) { e.preventDefault(); stepHistory(-1); return; }
    if (accelMatches(e, accelFor('historyForward'))) { e.preventDefault(); stepHistory(1); return; }

    if (e.metaKey && e.ctrlKey && e.key === 'f') {
      e.preventDefault();
      void api.toggleFullscreen();
      return;
    }

    if (e.key === 'Escape' && !typing) {
      if (ui.sidebarOpen) { ui.sidebarOpen = false; render(); }
    }
  });
}
