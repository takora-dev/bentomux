/* ---------------- notification permission gate ----------------
   One place that asks the OS whether Bentomux may notify, and one dialog
   pointing a blocked user at the right settings pane. Used by the settings
   toggles and by boot, so a fresh install authorizes before the first
   agent alert (macOS drops notifications that were never authorized). */

import { h } from './dom';
import { currentModal, openModal } from './components/modal';
import api from '../preload/bentomux';

const isMacOs = /Mac/i.test(navigator.platform);
const isWindows = /Win/i.test(navigator.platform);

function notifySettingsHint(): string {
  if (isMacOs) return 'Open System Settings → Notifications → Bentomux and pick Banners or Alerts. Focus / Do Not Disturb hides notifications too.';
  if (isWindows) return 'Open Settings → System → Notifications and turn notifications on for Bentomux.';
  return 'Open your desktop notification settings and allow notifications for Bentomux.';
}

/* One dialog for "the OS is not letting us notify", so a blocked user gets a
   way out instead of silence. */
export function notifyBlocked(): void {
  if (currentModal) return;
  const m = openModal({
    title: 'Notifications are blocked',
    body: h('div', {},
      h('p', { style: 'margin:0 0 8px' }, 'Your system is not allowing Bentomux to show notifications, so agent alerts stay hidden.'),
      h('p', { style: 'margin:0;color:var(--ink-2)' }, notifySettingsHint())),
    footer: h('div', {},
      h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'Not now'),
      h('button', {
        class: 'btn primary',
        type: 'button',
        onclick: () => {
          m.close();
          void api.notifyOpenSettings().catch(e => console.warn('[notifications] open settings failed', e));
        },
      }, 'Open settings')),
  });
}

/* Ask the OS (macOS raises its prompt on the first ask) and warn when it
   says no. Resolves false so callers can skip the send. */
export function ensureNotifyPermission(): Promise<boolean> {
  return api.notifyPermission(true)
    .then(state => {
      if (state === 'denied') { notifyBlocked(); return false; }
      return true;
    })
    .catch(() => true);
}
