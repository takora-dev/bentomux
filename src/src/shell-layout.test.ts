import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { $, h, markup } from './dom';
import { IC } from './icons';
import { runtimeIcon } from './components/runtime-status';
import { openModal, currentModal } from './components/modal';
import { selectEl } from './components/select';

const shellHtml = readFileSync('src/index.html', 'utf8');
const themeCss = readFileSync('src/theme.css', 'utf8');
const baseCss = readFileSync('src/styles/00-base.css', 'utf8');
const frameCss = readFileSync('src/styles/10-frame.css', 'utf8');
const componentCss = readFileSync('src/styles/20-components.css', 'utf8');
const settingsCss = readFileSync('src/styles/30-settings.css', 'utf8');
const gitCss = readFileSync('src/styles/50-git.css', 'utf8');
const paletteCss = readFileSync('src/styles/60-palettes.css', 'utf8');
const updateCss = readFileSync('src/styles/80-updates.css', 'utf8');
const backgroundCss = readFileSync('src/styles/95-backgrounds.css', 'utf8');

function mountShell(compact: boolean = false): void {
  document.body.classList.toggle('pane-hidden', compact);
  const parsed = new DOMParser().parseFromString(shellHtml, 'text/html');
  const app = parsed.querySelector('.app');
  if (!app) throw new Error('Missing app shell');
  document.body.append(document.importNode(app, true), h('div', { id: 'modalRoot' }));
  document.head.append(
    h('style', { 'data-shell-test': true }, themeCss),
    h('style', { 'data-shell-test': true }, baseCss),
    h('style', { 'data-shell-test': true }, frameCss),
    h('style', { 'data-shell-test': true }, componentCss),
    h('style', { 'data-shell-test': true }, settingsCss),
    h('style', { 'data-shell-test': true }, gitCss),
    h('style', { 'data-shell-test': true }, paletteCss),
    h('style', { 'data-shell-test': true }, updateCss),
    h('style', { 'data-shell-test': true }, backgroundCss));
  $('#sidebarBottom').append(
    h('button', { class: 'iconbtn sidebar-gear', 'aria-label': 'Open settings' }),
    h('button', { class: 'iconbtn sidebar-remote', 'aria-label': 'Remote control from phone' }));
}

afterEach(() => {
  currentModal?.close();
  document.body.replaceChildren();
  document.body.className = '';
  document.documentElement.className = '';
  document.querySelectorAll('[data-shell-test]').forEach(el => el.remove());
});

describe('sidebar shell layout', () => {
  it.each([false, true])('allows the native desktop backdrop only in dark mode (dark: %s)', dark => {
    for (const [path, effect] of [
      ['src-tauri/tauri.conf.json', 'underWindowBackground'],
      ['src-tauri/tauri.windows.conf.json', 'acrylic'],
    ]) {
      const config = JSON.parse(readFileSync(path, 'utf8'));
      const main = config.app.windows.find((window: { label: string }) => window.label === 'main');
      expect(main.transparent, path).toBe(true);
      expect(main.backgroundColor, path).toBe('#00000000');
      expect(main.windowEffects.effects, path).toContain(effect);
    }
    document.documentElement.classList.toggle('dark', dark);
    mountShell();
    for (const selector of ['html', 'body', '.app']) {
      const style = getComputedStyle($(selector));
      if (!dark && selector === 'body') {
        expect(style.backgroundColor).toBe(getComputedStyle(document.documentElement).getPropertyValue('--bg'));
      } else {
        expect(['', 'transparent', 'rgba(0, 0, 0, 0)'], selector).toContain(style.backgroundColor);
      }
      expect(['', 'none', 'initial'], selector).toContain(style.backgroundImage);
    }
  });
  it('keeps bottom controls in the sidebar without a separate footer', () => {
    mountShell();
    expect($('.sidebar-gear').closest('.sidebar-actions')).not.toBeNull();
    expect($('.sidebar-remote').closest('.sidebar-actions')).not.toBeNull();
    expect($('#themeBtn').closest('.sidebar-actions')).toBeNull();
    expect($('#themeBtn').closest('#sidebarBottom')).toBeNull();
    expect($('#themeBtn').closest('#titlebar .win-controls')).not.toBeNull();
    expect(document.querySelectorAll('#themeBtn')).toHaveLength(1);
    expect(document.querySelector('.sidebar-bottom, .compact-sidebar-footer, #compactSettingsBtn')).toBeNull();
    expect($('#sidebarResize')).not.toBeNull();
    // Live dock renders must not discard the static theme button or its listener.
    const theme = $('#themeBtn');
    $('#sidebarBottom').replaceChildren();
    expect($('#themeBtn')).toBe(theme);
  });

  it.each([false, true])('joins the chrome around rounded full-bleed content (dark: %s)', dark => {
    document.documentElement.classList.toggle('dark', dark);
    mountShell();
    $('#content').classList.add('full', 'fullbleed');
    const chromeFill = dark ? 'transparent' : getComputedStyle(document.documentElement).getPropertyValue('--surface');
    expect(getComputedStyle($('.sidebar')).backgroundColor).toBe(chromeFill);
    expect(getComputedStyle($('#titlebar')).backgroundColor).toBe(chromeFill);
    const content = getComputedStyle($('#content'));
    expect(content.backgroundColor).toBe(getComputedStyle(document.documentElement).getPropertyValue('--content-bg'));
    expect(content.borderTopLeftRadius).toBe('12px');
    expect(content.borderTopRightRadius).toBe('12px');
    expect(content.borderBottomLeftRadius).toBe('12px');
    expect(content.borderBottomRightRadius).toBe('12px');
    expect(content.overflow).toBe('hidden');
    expect(content.padding).toBe('0px');
    expect(content.margin).toBe('0px 8px 8px 0px');
  });

  it('softens chrome text without changing the content palette or layout', () => {
    document.documentElement.classList.add('dark');
    mountShell();
    const root = getComputedStyle(document.documentElement);
    const sidebar = getComputedStyle($('.sidebar'));
    const titlebar = getComputedStyle($('#titlebar'));
    expect(root.getPropertyValue('--surface')).toBe('#222428');
    expect(root.getPropertyValue('--bg')).toBe('#17181B');
    expect(sidebar.color).toBe('#E3E6EB');
    expect(titlebar.color).toBe(sidebar.color);
    expect(getComputedStyle($('.sidebar-gear')).color).toBe('#C1C7D0');
    expect(getComputedStyle($('#content')).color).toBe(getComputedStyle(document.body).color);
    const time = h('time', { class: 'workspace-time' }, 'now');
    $('.sidebar').append(time);
    expect(getComputedStyle(time).color).toBe('#9EA7B5');
    expect(root.getPropertyValue('--ink-2')).toBe('#A6ABB3');
    expect(root.getPropertyValue('--ink-3')).toBe('#71767E');
    expect(titlebar.height).toBe('38px');
    expect(sidebar.gridColumn).toBe('1');
    expect(getComputedStyle($('#win')).gridTemplateColumns).toBe('248px minmax(0,1fr) 0');
    expect(getComputedStyle($('#content')).getPropertyValue('backdrop-filter')).toBe('');
  });

  it.each([false, true])('shares the floating material outside the app frame (dark: %s)', dark => {
    document.documentElement.classList.toggle('dark', dark);
    mountShell();
    const modal = openModal({ title: 'Search', body: h('input', { class: 'search-palette-input' }) });
    const dialog = modal.overlay.querySelector('.dialog');
    if (!(dialog instanceof HTMLElement)) throw new Error('Missing dialog');
    dialog.classList.add('cmd-palette');
    const reference = getComputedStyle(dialog);
    expect(reference.borderTopLeftRadius).toBe('12px');
    expect(getComputedStyle(document.documentElement).getPropertyValue('--floating-opacity')).toBe(dark ? '32%' : '100%');
    for (const className of ['ctx-menu', 'remote-pop', 'ws-flyout', 'app-tooltip', 'update-banner']) {
      const panel = h('div', { class: className }, 'Floating text');
      document.body.append(panel);
      expect(panel.closest('.app')).toBeNull();
      const style = getComputedStyle(panel);
      expect(style.backgroundColor).toBe(reference.backgroundColor);
      expect(style.borderTopLeftRadius).toBe('12px');
      expect(style.color).toBe(reference.color);
      expect(style.boxShadow).toBe(reference.boxShadow);
    }
    expect(reference.color).toBe(dark ? '#E3E6EB' : getComputedStyle(document.body).color);
    expect(getComputedStyle(dialog.querySelector('input')!).color).toBe(reference.color);
  });

  it.each([false, true])('keeps tooltips solid without backdrop blur (dark: %s)', dark => {
    document.documentElement.classList.toggle('dark', dark);
    mountShell();
    const tooltip = h('div', { class: 'app-tooltip' }, 'Refresh');
    const reference = h('div', { style: 'background:var(--floating-solid)' });
    document.body.append(tooltip, reference);
    expect(getComputedStyle(tooltip).backgroundColor).toBe(getComputedStyle(reference).backgroundColor);
    expect(['', 'none']).toContain(getComputedStyle(tooltip).getPropertyValue('backdrop-filter'));
    // happy-dom ignores @supports; ensure the real browser's glass rule excludes tooltips.
    const glassRule = componentCss.match(/@supports[\s\S]*?\n\}/)?.[0];
    expect(glassRule).toBeDefined();
    expect(glassRule).not.toContain('.app-tooltip');
  });

  it.each([false, true])('keeps Git Tools rounded and borderless, translucent only in dark mode (dark: %s)', dark => {
    document.documentElement.classList.toggle('dark', dark);
    document.body.classList.add('git-panel-open');
    mountShell();
    const panel = getComputedStyle($('#gitPanel'));
    expect(panel.gridColumn).toBe('3');
    expect(panel.gridRow).toBe('2');
    expect(panel.borderTopLeftRadius).toBe('12px');
    expect(panel.borderBottomRightRadius).toBe('12px');
    expect(panel.margin).toBe('0px 8px 8px 0px');
    expect(panel.overflow).toBe('hidden');
    expect(panel.backgroundColor).toBe(dark ? 'transparent' : getComputedStyle(document.documentElement).getPropertyValue('--surface'));
    expect(panel.boxShadow).toBe('none');
    for (const width of [panel.borderTopWidth, panel.borderRightWidth, panel.borderBottomWidth, panel.borderLeftWidth]) {
      expect(['', '0px']).toContain(width);
    }
    expect(['', 'none']).toContain(panel.getPropertyValue('backdrop-filter'));
    // Guard the shared backdrop and solid accessibility fallback explicitly.
    expect(gitCss).toMatch(/@supports[^\{]+\{\s*:root\.dark \.right-sidebar\{background:transparent\}/);
    expect(gitCss).not.toMatch(/backdrop-filter:blur\([^)]*\);/);
    expect(gitCss).toMatch(/@media \(prefers-reduced-transparency:reduce\),\(prefers-contrast:more\),\(forced-colors:active\)\{\s*:root\.dark \.right-sidebar\{background:var\(--surface\)\}/);
  });

  it.each([false, true])('keeps the Changes badge flat until Git Tools opens (dark: %s)', dark => {
    document.documentElement.classList.toggle('dark', dark);
    mountShell();
    const pill = $('#gitChangesPill');
    const badge = getComputedStyle(pill);
    expect(badge.boxShadow).toBe('none');
    expect(badge.textShadow).toBe('none');
    expect(badge.backgroundColor).toBe('transparent');
    expect(['', '0px']).toContain(badge.borderTopWidth);
    expect(badge.borderTopLeftRadius).toBe('8px');
    document.body.classList.add('git-panel-open');
    const reference = h('span', { style: 'background:var(--tint)' });
    $('#titlebar').append(reference);
    expect(getComputedStyle(pill).backgroundColor).toBe(getComputedStyle(reference).backgroundColor);
    expect(getComputedStyle(pill).boxShadow).toBe('none');
  });

  it.each([false, true])('keeps the Search shortcut badge flat and readable (dark: %s)', dark => {
    document.documentElement.classList.toggle('dark', dark);
    mountShell();
    const shortcut = h('span', { class: 'shortcut' }, 'Ctrl K');
    const trigger = h('button', { class: 'nav-item search-trigger' }, 'Search', shortcut);
    $('#nav').append(trigger);
    const badge = getComputedStyle(shortcut);
    expect(badge.backgroundColor).toBe('transparent');
    expect(badge.boxShadow).toBe('none');
    expect(badge.textShadow).toBe('none');
    expect(['', '0px']).toContain(badge.borderTopWidth);
    expect(badge.color).toBe(getComputedStyle(trigger).color);
    expect(componentCss).toContain('.search-trigger:is(:hover,:focus-visible) .shortcut{background:var(--tint);color:var(--ink)}');
  });

  it.each([false, true])('keeps palette-style selects aligned inside background cards (dark: %s)', dark => {
    document.documentElement.classList.toggle('dark', dark);
    mountShell();
    const select = selectEl([['sidebar', 'Sidebar'], ['terminal', 'Terminal']], 'sidebar');
    document.body.append(h('div', { class: 'dialog' }, h('div', { class: 'bg-card bg-area-card' }, select)));
    expect(getComputedStyle(select).display).toBe('flex');
    expect(getComputedStyle(select).height).toBe('32px');
    const caret = select.querySelector('.palette-caret');
    if (!(caret instanceof HTMLElement)) throw new Error('Missing select caret');
    expect(getComputedStyle(caret).width).toBe('12px');
    expect(getComputedStyle(caret).height).toBe('12px');
  });

  it.each([false, true])('uses soft neutral primary buttons in the default palette (dark: %s)', dark => {
    document.documentElement.classList.toggle('dark', dark);
    mountShell();
    const primary = h('button', { class: 'btn primary' }, 'Confirm');
    const modal = openModal({ body: primary });
    const style = getComputedStyle(primary);
    // happy-dom drops color-mix declarations; check the fill at the source and
    // use computed text/weight to verify that the default-only selector applies.
    expect(componentCss).toMatch(/:root:not\(\[class\*="palette-"\]\) \.btn\.primary\{\s*background:color-mix\(in srgb,var\(--ink\) 10%,transparent\)/);
    expect(style.color).toBe(getComputedStyle(modal.overlay.querySelector('.dialog')!).color);
    expect(style.fontWeight).toBe('600');
  });

  it.each(['catppuccin', 'custom'])('preserves primary button accents in the %s palette', palette => {
    document.documentElement.classList.add('palette-' + palette);
    mountShell();
    const primary = h('button', { class: 'btn primary' }, 'Confirm');
    const reference = h('span', { style: 'background:var(--accent)' });
    document.head.append(h('style', { 'data-shell-test': true }, ':root{--c-accent:#a04080;--c-ink:#242424;--c-bg:#eeeeee}'));
    document.body.append(primary, reference);
    expect(getComputedStyle(primary).backgroundColor).toBe(getComputedStyle(reference).backgroundColor);
    expect(getComputedStyle(primary).color).toBe('#fff');
  });

  it('blurs translucent floating panels and retains the accessible solid fallback', () => {
    // happy-dom cannot render backdrop-filter or color-mix; guard these
    // declarations directly rather than claiming to test their visual output.
    expect(componentCss).toContain('background:color-mix(in srgb,var(--floating-solid) var(--floating-opacity),transparent)');
    expect(componentCss).toContain('backdrop-filter:blur(8px)');
    expect(componentCss).toMatch(/@supports[^\{]+\{\s*:root\.dark :is\(/);
    expect(frameCss).toMatch(/@supports[^\{]+\{\s*:root\.dark \.win\{/);
    expect(componentCss).toMatch(/:root :is\(\.dialog,\.remote-pop\) :is\([^)]*\.field select[^)]*\.update-status-card[^)]*\)\{\s*background-color:var\(--floating-control\)/);
    expect(componentCss).toMatch(/@media \(prefers-reduced-transparency:reduce\),\(prefers-contrast:more\),\(forced-colors:active\)\{[\s\S]*background:var\(--floating-solid\);\s*-webkit-backdrop-filter:none;\s*backdrop-filter:none;/);
  });

  it.each([false, true])('matches floating item selections to the sidebar (dark: %s)', dark => {
    document.documentElement.classList.toggle('dark', dark);
    mountShell();
    const reference = h('button', { class: 'nav-item workspace-child active' }, 'Sidebar');
    $('.sidebar').append(reference);
    const tint = getComputedStyle(reference).backgroundColor;
    for (const [panelClass, itemClass] of [
      ['dialog', 'nav-item active'],
      ['dialog', 'search-palette-item active'],
      ['ctx-menu', 'ctx-item active'],
      ['ws-flyout', 'nav-item workspace-child active'],
    ]) {
      const item = h('button', { class: itemClass }, 'Selected item');
      const panel = h('div', { class: panelClass }, item);
      document.body.append(panel);
      expect(getComputedStyle(item).backgroundColor).toBe(tint);
      expect(getComputedStyle(item).color).toBe(getComputedStyle(panel).color);
    }
    const selected = h('button', { class: 'on' }, 'Dark');
    const primary = h('button', { class: 'btn primary' }, 'Confirm');
    const sub = h('span', { class: 'item-sub' }, 'main');
    const modal = openModal({ body: [
      h('div', { class: 'seg' }, selected),
      h('button', { class: 'search-palette-item active' }, sub), primary,
    ] });
    expect(getComputedStyle(selected).backgroundColor).toBe(tint);
    expect(getComputedStyle(primary).backgroundColor).not.toBe(tint);
    expect(getComputedStyle(sub).opacity).toBe('1');
    expect(getComputedStyle(sub).color).not.toBe(getComputedStyle(primary).backgroundColor);
    modal.close();
  });

  it.each([false, true])('uses quiet active rows and smaller topbar tabs (dark: %s)', dark => {
    document.documentElement.classList.toggle('dark', dark);
    mountShell();
    const title = h('span', { class: 'workspace-name' }, 'Claude Code');
    const icon = runtimeIcon('claude', true);
    const row = h('button', { class: 'nav-item sub workspace-child active', style: '--runtime-color:#D97757' }, icon, title);
    const sidebarHover = h('button', { style: 'background:var(--tint)' });
    $('.sidebar').append(row, sidebarHover);
    expect(getComputedStyle(row).backgroundColor).toBe(getComputedStyle(sidebarHover).backgroundColor);
    expect(getComputedStyle(title).color).toBe(getComputedStyle($('.sidebar')).color);
    expect(icon.querySelector('[fill="#D97757"]')).not.toBeNull();

    const tile = markup('span', { class: 'tab-tile' }, IC.term);
    const tab = h('button', { class: 'tab active' }, tile, h('span', { class: 'tabname' }, 'Terminal'));
    const topbarHover = h('button', { style: 'background:var(--tint)' });
    $('#tabstrip').append(tab);
    $('#titlebar').append(topbarHover);
    expect(getComputedStyle(tab).backgroundColor).toBe(getComputedStyle(topbarHover).backgroundColor);
    expect(getComputedStyle(tab).color).toBe(getComputedStyle($('#titlebar')).color);
    expect(getComputedStyle(tab).borderTopLeftRadius).toBe('8px');
    expect(getComputedStyle(tab).height).toBe('28px');
    expect(getComputedStyle(tile).width).toBe('14px');
    expect(getComputedStyle(tile).height).toBe('14px');
    const svg = tile.querySelector('svg');
    if (!svg) throw new Error('Missing tab icon');
    expect(getComputedStyle(svg).width).toBe('10px');
    expect(getComputedStyle(svg).height).toBe('10px');
  });

  it.each([false, true])('has borderless chrome and visible bottom actions (compact: %s)', compact => {
    mountShell(compact);
    const actions = getComputedStyle($('.sidebar-actions'));
    expect(actions.display).toBe('flex');
    expect(actions.marginTop).toBe('auto');
    expect(actions.backgroundColor).toBe('transparent');
    expect(getComputedStyle($('#sidebarBottom')).display).toBe('flex');
    // Remote stays at the right edge when expanded and centered in the rail.
    expect(getComputedStyle($('.sidebar-remote')).marginLeft).toBe(compact ? '0px' : 'auto');
    expect(actions.flexDirection || 'row').toBe(compact ? 'column' : 'row');
    expect(getComputedStyle($('#titlebar')).display).toBe('flex');
    for (const [element, edge] of [
      [$('.sidebar'), 'borderRightWidth'],
      [$('#titlebar'), 'borderBottomWidth'],
      [$('.sidebar-actions'), 'borderTopWidth'],
    ] as const) {
      expect(['', '0px']).toContain(getComputedStyle(element)[edge]);
    }
  });
});
