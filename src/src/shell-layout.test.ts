import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { $, h } from './dom';

const shellHtml = readFileSync('src/index.html', 'utf8');
const themeCss = readFileSync('src/theme.css', 'utf8');
const baseCss = readFileSync('src/styles/00-base.css', 'utf8');
const frameCss = readFileSync('src/styles/10-frame.css', 'utf8');
const componentCss = readFileSync('src/styles/20-components.css', 'utf8');

function mountShell(compact: boolean = false): void {
  document.body.classList.toggle('pane-hidden', compact);
  const parsed = new DOMParser().parseFromString(shellHtml, 'text/html');
  const app = parsed.querySelector('.app');
  if (!app) throw new Error('Missing app shell');
  document.body.append(document.importNode(app, true));
  document.head.append(
    h('style', { 'data-shell-test': true }, themeCss),
    h('style', { 'data-shell-test': true }, baseCss),
    h('style', { 'data-shell-test': true }, frameCss),
    h('style', { 'data-shell-test': true }, componentCss));
  $('#sidebarBottom').append(
    h('button', { class: 'iconbtn sidebar-gear', 'aria-label': 'Open settings' }),
    h('button', { class: 'iconbtn sidebar-remote', 'aria-label': 'Remote control from phone' }));
}

afterEach(() => {
  document.body.replaceChildren();
  document.body.className = '';
  document.documentElement.className = '';
  document.querySelectorAll('[data-shell-test]').forEach(el => el.remove());
});

describe('sidebar shell layout', () => {
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
    const frame = getComputedStyle($('#win'));
    expect(getComputedStyle($('.sidebar')).backgroundColor).toBe(frame.backgroundColor);
    expect(getComputedStyle($('#titlebar')).backgroundColor).toBe(frame.backgroundColor);
    const content = getComputedStyle($('#content'));
    expect(content.backgroundColor).not.toBe(frame.backgroundColor);
    expect(content.borderTopLeftRadius).toBe('12px');
    expect(content.borderTopRightRadius).toBe('12px');
    expect(content.borderBottomLeftRadius).toBe('12px');
    expect(content.borderBottomRightRadius).toBe('12px');
    expect(content.overflow).toBe('hidden');
    expect(content.padding).toBe('0px');
    expect(content.margin).toBe('0px 8px 8px 0px');
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
