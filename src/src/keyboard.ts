/* ---------------- keyboard ---------------- */

import { ui } from './state';
import { db } from './store';
import { render } from './render';
import { currentModal } from './components/modal';
import { leavesOf, splitTerminalPane, stepHistory, closeFocusedPaneOrTab } from './views/tabs';
import { mostRecentPane } from './views/terminal';
import { openSearchModal } from './views/search';
import api from '../preload/bentomux';

/* app-level shortcuts; Settings › Keybindings overrides these by action id */
/* use Cmd on macOS, Ctrl on Windows/Linux */
const IS_MAC = navigator.platform.toLowerCase().includes('mac');
const MOD = IS_MAC ? 'meta' : 'ctrl';

const DEFAULT_ACCELS = {
  palette: `${MOD}+k`,
  splitDefault: `${MOD}+\\`,
  splitAlt: `${MOD}+shift+\\`,
  splitLeft: `${MOD}+alt+ArrowLeft`,
  splitUp: `${MOD}+alt+ArrowUp`,
} as const;
export type ActionId = keyof typeof DEFAULT_ACCELS;

/** the accelerator currently bound to an action (pref override or default) */
export function accelFor(action: ActionId): string {
  return db.prefs.shortcuts?.[action] || DEFAULT_ACCELS[action];
}

/** "ctrl+shift+k" → "Ctrl+Shift+K" (or "Cmd+Shift+K" on macOS) for display */
export function formatAccel(accel: string): string {
  const parts = accel.split('+');
  const key = parts.pop() || '';
  const prettyKey = key.length === 1 ? key.toUpperCase()
    : key.toLowerCase() === 'arrowleft' ? '\u2190'
    : key.toLowerCase() === 'arrowup' ? '\u2191'
    : key.toLowerCase() === 'arrowright' ? '\u2192'
    : key.toLowerCase() === 'arrowdown' ? '\u2193'
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
      /* Ctrl+\ splits right, Ctrl+Shift+\ splits down,
         Ctrl+Alt+Left splits left, Ctrl+Alt+Up splits up */
      if (accelMatches(e, accelFor('splitDefault'))) { e.preventDefault(); splitFocusedPane('v'); return; }
      if (accelMatches(e, accelFor('splitAlt'))) { e.preventDefault(); splitFocusedPane('h'); return; }
      if (accelMatches(e, accelFor('splitLeft'))) { e.preventDefault(); splitFocusedPane('v', true); return; }
      if (accelMatches(e, accelFor('splitUp'))) { e.preventDefault(); splitFocusedPane('h', true); return; }

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

    /* Mac navigation: Cmd+[ back, Cmd+] forward */
    if (e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (e.key === '[') { e.preventDefault(); stepHistory(-1); return; }
      if (e.key === ']') { e.preventDefault(); stepHistory(1); return; }
      /* Cmd+Ctrl+F = macOS fullscreen */
    }
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
