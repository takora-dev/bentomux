import type { AppearanceEffects } from '../../shared/types';
import { resolveAppearanceEffects } from '../appearance-effects';
import { h, markup } from '../dom';
import { IC } from '../icons';
import { field } from './modal';
import { toggleSeg } from './toggle';

const LINUX_BLUR_PROMPT = `Help me enable desktop blur behind Bentomux on Linux.
Inspect my desktop environment, compositor, session type (Wayland/X11), and the actual Bentomux window class/app ID first. Do not assume a window identity or blur support.
On GNOME, check for a compatible Blur my Shell extension and its Applications blur support. On other desktops, use supported compositor-specific per-window blur rules.
Explain the proposed changes and ask permission before installing anything or changing desktop settings. Back up affected settings and preserve existing application rules. Enable blur only for Bentomux, not all applications. Keep whole-window opacity at 100% so text and terminal content remain solid.
Do not modify Bentomux source code or weaken desktop security. If blur is unsupported, explain the limitation and recommend Solid mode instead of claiming CSS can blur the desktop.
After approval, apply the minimal configuration, verify it, provide rollback steps, and ask me to visually confirm the result with dark mode and Translucency → Glass enabled.`;

function linuxBlurHelp(): { button: HTMLElement; panel: HTMLElement } {
  const prompt = h('textarea', {
    class: 'linux-blur-prompt', readonly: true, rows: 9,
    'aria-label': 'Linux blur setup prompt for your agent',
  }, LINUX_BLUR_PROMPT) as HTMLTextAreaElement;
  const status = h('div', { role: 'status', 'aria-live': 'polite' });
  const copy = h('button', {
    type: 'button', class: 'btn', onclick: async () => {
      try {
        await navigator.clipboard.writeText(LINUX_BLUR_PROMPT);
        status.textContent = 'Prompt copied. Paste it into your coding agent.';
      } catch {
        prompt.focus();
        prompt.select();
        status.textContent = 'Could not copy automatically. Copy the selected prompt manually.';
      }
    },
  }, 'Copy agent prompt');
  const panel = h('div', { class: 'linux-blur-help', hidden: true },
    h('p', null, 'Blur depends on your Linux desktop. Without compositor support, Glass only adds transparency.'),
    h('p', null, 'Ask your agent to configure blur using the prompt below. Bentomux does not change desktop settings automatically.'),
    prompt, copy, status);
  const label = 'Linux blur requirements and agent setup prompt';
  const button = h('button', {
    type: 'button', class: 'iconbtn linux-blur-warning', title: label,
    'aria-label': label, 'aria-expanded': 'false', onclick: () => {
      panel.hidden = !panel.hidden;
      button.setAttribute('aria-expanded', String(!panel.hidden));
    },
  }, markup('span', { class: 'ic' }, IC.warning));
  return { button, panel };
}

export function appearanceEffectsControls(
  value: AppearanceEffects | undefined,
  onChange: (next: AppearanceEffects) => void,
): HTMLElement {
  const linux = document.documentElement.classList.contains('linux');
  let current = resolveAppearanceEffects(value);
  const toggle = toggleSeg(current.enabled, enabled => {
    current = { ...current, enabled };
    onChange({ ...current });
  }, { labels: ['Solid', 'Glass'] });
  const help = linux ? linuxBlurHelp() : null;
  return h('div', { class: 'appearance-effects' },
    field('Translucency', h('div', { class: 'appearance-effects-toggle' }, toggle, help?.button)),
    help?.panel,
    h('div', { class: 'settings-hint' }, 'Dark mode only. Applies to the sidebar, topbar, bottom frame, menus and dialogs. Light mode, terminal and content backgrounds stay solid.'),
    !linux && h('div', { class: 'settings-hint' }, 'Desktop blur depends on the OS.'),
    h('div', { class: 'settings-hint' }, 'Accessibility preferences can keep surfaces solid.'));
}
