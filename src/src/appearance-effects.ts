import type { AppearanceEffects } from '../shared/types';

export const DEFAULT_APPEARANCE_EFFECTS: Readonly<AppearanceEffects> = {
  enabled: false,
  opacity: 80,
  blur: 16,
};

export function resolveAppearanceEffects(value?: Partial<AppearanceEffects> | null): AppearanceEffects {
  const bounded = (n: number | undefined, fallback: number, max: number): number =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : fallback;
  return {
    enabled: value?.enabled === true,
    opacity: bounded(value?.opacity, DEFAULT_APPEARANCE_EFFECTS.opacity, 100),
    blur: bounded(value?.blur, DEFAULT_APPEARANCE_EFFECTS.blur, 40),
  };
}

/* Only background paints consume these tokens: never fade text, images or
   the xterm renderer with element opacity. Native desktop blur is OS-owned. */
export function applyAppearanceEffects(
  value?: Partial<AppearanceEffects> | null,
  root: HTMLElement = document.documentElement,
): void {
  const effects = resolveAppearanceEffects(value);
  root.classList.toggle('appearance-glass', effects.enabled);
  // Solid/Glass uses a fixed preset, including for legacy slider preferences.
  root.style.setProperty('--glass-opacity', DEFAULT_APPEARANCE_EFFECTS.opacity + '%');
  root.style.setProperty('--glass-blur', effects.blur + 'px');
}
