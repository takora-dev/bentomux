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

  it.each([
    ['linux dark', true],
    ['linux dark palette-pastel-pixel', true],
    ['linux', false],
    ['windows dark', false],
    ['macos dark', false],
  ] as const)('adds glass highlights only on Linux in dark Glass mode (%s)', (classes, simulated) => {
    mountStyles();
    document.documentElement.className = classes;
    applyAppearanceEffects({ enabled: true });
    const win = document.createElement('div');
    win.className = 'win';
    const app = document.createElement('div');
    app.className = 'app';
    app.append(win);
    document.body.append(app);
    const terminal = xtermTheme();
    const background = getComputedStyle(win).backgroundImage;
    expect(background.includes('linear-gradient')).toBe(simulated);
    expect(background.includes('radial-gradient')).toBe(simulated);
    expect(getComputedStyle(win).opacity).not.toBe('0.94');
    applyAppearanceEffects({ enabled: false });
    win.classList.add('style-cache-refresh');
    expect(getComputedStyle(win).backgroundImage).not.toContain('gradient');
    expect(xtermTheme()).toEqual(terminal);
  });

  it('exposes the desktop to compositor blur using the shared glass tint on Linux', () => {
    const css = readFileSync('src/styles/10-frame.css', 'utf8');
    const linuxRule = css.split(':root.dark.appearance-glass:where(.linux) .win{')[1].split('}')[0];
    expect(linuxRule).toContain('background-color:var(--chrome-glass)');
    expect(linuxRule).not.toContain('94%');
    const config = JSON.parse(readFileSync('src-tauri/tauri.linux.conf.json', 'utf8'));
    expect(config.app.windows[0]).toMatchObject({ transparent: true, backgroundColor: '#00000000' });
  });

  it('lets accessibility solid backgrounds override the Linux glass layers', () => {
    const css = readFileSync('src/styles/10-frame.css', 'utf8');
    const linuxRule = css.indexOf(':root.dark.appearance-glass:where(.linux) .win');
    expect(linuxRule).toBeGreaterThan(-1);
    for (const preference of ['prefers-reduced-transparency:reduce', 'forced-colors:active', 'prefers-contrast:more']) {
      expect(css.indexOf(preference)).toBeGreaterThan(linuxRule);
    }
    // The later background shorthands clear gradient layers, not just their color.
    expect(css.slice(css.indexOf('@media (prefers-reduced-transparency')))
      .toContain('background:var(--chrome-solid)');
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

  it.each(['linux', 'windows', 'macos'])('shows Linux setup help only on Linux (%s)', platform => {
    document.documentElement.className = platform + ' dark';
    const change = vi.fn();
    const controls = appearanceEffectsControls(undefined, change);
    document.body.append(controls);
    const help = controls.querySelector<HTMLElement>('.linux-blur-help');
    const warning = controls.querySelector<HTMLButtonElement>('.linux-blur-warning');
    expect(Boolean(warning)).toBe(platform === 'linux');
    expect(Boolean(help)).toBe(platform === 'linux');
    expect(buttonFor('Solid').classList.contains('on')).toBe(true);
    if (platform === 'linux') {
      expect(controls.textContent).toContain('Without compositor support, Glass only adds transparency.');
      expect(help?.hidden).toBe(true);
      expect(warning?.getAttribute('aria-expanded')).toBe('false');
      expect(warning?.querySelector('svg')).not.toBeNull();
      expect(warning?.textContent).toBe('');
      warning?.click();
      expect(help?.hidden).toBe(false);
      expect(warning?.getAttribute('aria-expanded')).toBe('true');
      const prompt = help?.querySelector('textarea');
      expect(prompt?.readOnly).toBe(true);
      expect(prompt?.value).toContain('Blur my Shell');
      expect(prompt?.value).toContain('whole-window opacity at 100%');
      expect(prompt?.value).toContain('ask permission');
      expect(prompt?.value).toContain('rollback');
      warning?.click();
      expect(help?.hidden).toBe(true);
    } else {
      expect(controls.textContent).not.toContain('Linux');
    }
    expect(controls.textContent).toContain('Accessibility preferences');
    expect(change).not.toHaveBeenCalled();
  });

  it.each([true, false])('copies the agent prompt or provides a manual fallback (clipboard: %s)', async succeeds => {
    document.documentElement.className = 'linux dark';
    document.body.append(appearanceEffectsControls(undefined, vi.fn()));
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    if (succeeds) write.mockResolvedValue();
    else write.mockRejectedValue(new Error('Clipboard unavailable'));
    try {
      document.querySelector<HTMLButtonElement>('.linux-blur-warning')!.click();
      buttonFor('Copy agent prompt').click();
      await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent)
        .toContain(succeeds ? 'Prompt copied' : 'Copy the selected prompt manually'));
      const prompt = document.querySelector('textarea')!;
      expect(write).toHaveBeenCalledWith(prompt.value);
      if (!succeeds) {
        expect(document.activeElement).toBe(prompt);
        expect(prompt.selectionEnd).toBe(prompt.value.length);
      }
    } finally {
      write.mockRestore();
    }
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
