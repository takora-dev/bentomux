import type { AppearanceEffects } from '../../shared/types';
import { resolveAppearanceEffects } from '../appearance-effects';
import { h } from '../dom';
import { field } from './modal';
import { toggleSeg } from './toggle';

export function appearanceEffectsControls(
  value: AppearanceEffects | undefined,
  onChange: (next: AppearanceEffects) => void,
): HTMLElement {
  let current = resolveAppearanceEffects(value);
  const toggle = toggleSeg(current.enabled, enabled => {
    current = { ...current, enabled };
    onChange({ ...current });
  }, { labels: ['Solid', 'Glass'] });
  return h('div', { class: 'appearance-effects' },
    field('Translucency', toggle),
    h('div', { class: 'settings-hint' }, 'Dark mode only. Applies to the sidebar, topbar, bottom frame, menus and dialogs. Light mode, terminal and content backgrounds stay solid.'),
    h('div', { class: 'settings-hint' }, 'Desktop blur depends on the OS; accessibility preferences can keep surfaces solid.'));
}
