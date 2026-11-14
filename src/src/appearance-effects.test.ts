import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyAppearanceEffects, DEFAULT_APPEARANCE_EFFECTS, resolveAppearanceEffects } from './appearance-effects';
import { appearanceEffectsControls } from './components/appearance-effects';
import { xtermTheme } from './terminal-theme';

function mountStyles(): void {
  const style = document.createElement('style');
  style.dataset.effectsTest = '';
  style.textContent = ['src/theme.css', 'src/styles/10-frame.css', 'src/styles/20-components.css', 'src/styles/30-settings.css']
    .map(path => readFileSync(path, 'utf8')).join('\n');
  document.head.append(style);
}

function buttonFor(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(el => el.textContent === label);
  if (!button) throw new Error('Missing toggle: ' + label);
  return button;
}

afterEach(() => {
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  document.querySelectorAll('[data-effects-test]').forEach(el => el.remove());
  document.body.replaceChildren();
});

describe('appearance effects', () => {
  it('keeps old preferences solid by default', () => {
    expect(DEFAULT_APPEARANCE_EFFECTS.opacity).toBe(80);
    expect(resolveAppearanceEffects()).toEqual(DEFAULT_APPEARANCE_EFFECTS);
    expect(resolveAppearanceEffects(null)).toEqual(DEFAULT_APPEARANCE_EFFECTS);
    applyAppearanceEffects();
    expect(document.documentElement.classList.contains('appearance-glass')).toBe(false);
  });

  it('bounds malformed stored values before writing CSS', () => {
    expect(resolveAppearanceEffects({ enabled: true, opacity: -1, blur: 999 }))
      .toEqual({ enabled: true, opacity: 0, blur: 40 });
    expect(resolveAppearanceEffects({ opacity: Infinity, blur: NaN })).toEqual(DEFAULT_APPEARANCE_EFFECTS);
    expect(resolveAppearanceEffects({ opacity: 101, blur: -1 })).toEqual({ enabled: false, opacity: 100, blur: 0 });
  });

  it.each(['', 'dark', 'dark palette-pastel-pixel'])('applies saved effects without changing the theme or terminal (%s)', theme => {
    mountStyles();
    document.documentElement.className = theme;
    const terminal = xtermTheme();
    applyAppearanceEffects({ enabled: true, opacity: 65, blur: 12 });
    const root = document.documentElement;
    expect(root.classList.contains('appearance-glass')).toBe(true);
    expect(root.style.getPropertyValue('--glass-opacity')).toBe('80%');
    expect(root.style.getPropertyValue('--glass-blur')).toBe('12px');
    expect(getComputedStyle(root).getPropertyValue('--floating-opacity')).toBe(theme.includes('dark') ? '80%' : '100%');
    expect(xtermTheme()).toEqual(terminal);
    expect(root.style.opacity).toBe('');
    applyAppearanceEffects({ enabled: false, opacity: 65, blur: 12 });
    expect(root.classList.contains('appearance-glass')).toBe(false);
    expect(root.style.getPropertyValue('--glass-opacity')).toBe('80%');
    expect(getComputedStyle(root).getPropertyValue('--floating-opacity')).toBe('100%');
  });

  it('scopes all Glass CSS overrides to dark mode', () => {
    for (const path of ['src/theme.css', 'src/styles/10-frame.css', 'src/styles/20-components.css']) {
      expect(readFileSync(path, 'utf8')).not.toContain(':root.appearance-glass');
    }
  });

  it.each(['dialog dialog-wide', 'dialog cmd-palette'].flatMap(className =>
    [false, true].flatMap(dark => [false, true].map(enabled => ({ className, dark, enabled }))),
  ))('uses dense Glass only for dark modals ($className, dark: $dark, enabled: $enabled)', ({ className, dark, enabled }) => {
    mountStyles();
    document.documentElement.classList.toggle('dark', dark);
    applyAppearanceEffects({ enabled, opacity: 65, blur: 12 });
    const dialog = document.createElement('div');
    dialog.className = className;
    // Resolve the material token through a supported percentage property;
    // happy-dom cannot render the actual color-mix background.
    const probe = document.createElement('div');
    probe.style.width = 'var(--floating-opacity)';
    dialog.append(probe);
    document.body.append(dialog);
    expect(getComputedStyle(probe).width).toBe(dark && enabled ? '95%' : '100%');
  });

  it('restores saved Glass automatically when switching from light to dark', () => {
    mountStyles();
    applyAppearanceEffects({ enabled: true, opacity: 65, blur: 12 });
    const root = document.documentElement;
    expect(getComputedStyle(root).getPropertyValue('--floating-opacity')).toBe('100%');
    root.classList.add('dark');
    expect(getComputedStyle(root).getPropertyValue('--floating-opacity')).toBe('80%');
    root.classList.remove('dark');
    expect(getComputedStyle(root).getPropertyValue('--floating-opacity')).toBe('100%');
  });

  it('hides Translucency in light mode and shows it again in dark mode without losing the choice', () => {
    mountStyles();
    const change = vi.fn();
    const controls = appearanceEffectsControls({ ...DEFAULT_APPEARANCE_EFFECTS, enabled: true }, change);
    document.body.append(controls);
    expect(getComputedStyle(controls).display).toBe('none');
    document.documentElement.classList.add('dark');
    // happy-dom does not invalidate descendant styles when an ancestor class changes.
    controls.classList.add('style-cache-refresh');
    expect(getComputedStyle(controls).display).not.toBe('none');
    expect(buttonFor('Glass').classList.contains('on')).toBe(true);
    document.documentElement.classList.remove('dark');
    controls.classList.remove('style-cache-refresh');
    expect(getComputedStyle(controls).display).toBe('none');
    expect(change).not.toHaveBeenCalled();
  });

  it('offers only Solid and Glass without opacity or blur sliders', () => {
    const change = vi.fn();
    document.body.append(appearanceEffectsControls(undefined, change));
    expect(buttonFor('Solid').classList.contains('on')).toBe(true);
    expect(buttonFor('Glass').classList.contains('on')).toBe(false);
    expect(document.querySelectorAll('button')).toHaveLength(2);
    expect(document.querySelector('input')).toBeNull();
    expect(document.body.textContent).toContain('Dark mode only');
    expect(change).not.toHaveBeenCalled();
  });

  it('previews Solid and Glass immediately and restores the selection when reopened', () => {
    const change = vi.fn(applyAppearanceEffects);
    document.body.append(appearanceEffectsControls(undefined, change));
    buttonFor('Glass').click();
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_APPEARANCE_EFFECTS, enabled: true });
    expect(document.documentElement.classList.contains('appearance-glass')).toBe(true);
    buttonFor('Solid').click();
    expect(change).toHaveBeenLastCalledWith(DEFAULT_APPEARANCE_EFFECTS);
    expect(document.documentElement.classList.contains('appearance-glass')).toBe(false);
    document.body.replaceChildren(appearanceEffectsControls({ ...DEFAULT_APPEARANCE_EFFECTS, enabled: true }, change));
    expect(buttonFor('Glass').classList.contains('on')).toBe(true);
    expect(document.querySelector('input')).toBeNull();
  });

  it('preserves stored effect values when switching modes', () => {
    const change = vi.fn();
    document.body.append(appearanceEffectsControls({ enabled: true, opacity: 55, blur: 24 }, change));
    buttonFor('Solid').click();
    expect(change).toHaveBeenLastCalledWith({ enabled: false, opacity: 55, blur: 24 });
    buttonFor('Glass').click();
    expect(change).toHaveBeenLastCalledWith({ enabled: true, opacity: 55, blur: 24 });
  });

  it.each([0, 65, 80, 85, 90, 95, 100])('uses the 80% Glass preset without fading text (saved: %s)', opacity => {
    applyAppearanceEffects({ enabled: true, opacity, blur: 0 });
    expect(document.documentElement.style.getPropertyValue('--glass-opacity')).toBe('80%');
    expect(document.documentElement.style.getPropertyValue('--glass-blur')).toBe('0px');
    expect(document.documentElement.style.opacity).toBe('');
  });
});
