import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { xtermTheme } from './terminal-theme';

const themeCss = readFileSync('src/theme.css', 'utf8');
const xtermCss = readFileSync('node_modules/@xterm/xterm/css/xterm.css', 'utf8');
const frameCss = readFileSync('src/styles/10-frame.css', 'utf8');
const componentCss = readFileSync('src/styles/20-components.css', 'utf8');
const backgroundCss = readFileSync('src/styles/95-backgrounds.css', 'utf8');

beforeEach(() => {
  const style = document.createElement('style');
  style.dataset.terminalThemeTest = '';
  style.textContent = xtermCss + themeCss + frameCss + componentCss + backgroundCss;
  document.head.append(style);
});

afterEach(() => {
  document.documentElement.className = '';
  document.body.replaceChildren();
  document.querySelectorAll('[data-terminal-theme-test]').forEach(el => el.remove());
});

describe('terminal theme', () => {
  it('uses the supplied Slate, text, accent and selection for the default dark terminal', () => {
    document.documentElement.classList.add('dark');
    expect(xtermTheme()).toMatchObject({
      background: '#282C34', foreground: '#E6E7ED',
      cursor: '#8B9CF4', cursorAccent: '#282C34',
      selectionBackground: '#343440', selectionForeground: '#E6E7ED',
    });
    expect(getComputedStyle(document.documentElement).getPropertyValue('--content-bg')).toBe('#282C34');
    expect(getComputedStyle(document.documentElement).getPropertyValue('--ink')).toBe('#E6E7ED');
    const page = document.createElement('div');
    page.className = 'terminal-page';
    const body = document.createElement('div');
    body.className = 'mux-body';
    page.append(body);
    document.body.append(page);
    expect(getComputedStyle(page).backgroundColor).toBe('#282C34');
    expect(getComputedStyle(body).backgroundColor).toBe('#282C34');
  });

  it('paints the full workspace terminal content area Soft Slate, including the surrounding gutters', () => {
    document.documentElement.classList.add('dark');
    const content = document.createElement('main');
    content.className = 'content full';
    const tabstrip = document.createElement('div');
    tabstrip.className = 'tabstrip';
    const tabbody = document.createElement('div');
    tabbody.className = 'tabbody';
    const page = document.createElement('div');
    page.className = 'terminal-page';
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const viewport = document.createElement('div');
    viewport.className = 'xterm-viewport';
    xterm.append(viewport);
    page.append(xterm);
    tabbody.append(page);
    content.append(tabstrip, tabbody);
    document.body.append(content);
    for (const surface of [content, tabstrip, page, viewport]) {
      expect(getComputedStyle(surface).backgroundColor, surface.className).toBe('#282C34');
    }
  });

  it('uses the default Slate canvas for non-terminal app content', () => {
    document.documentElement.classList.add('dark');
    const content = document.createElement('main');
    content.className = 'content';
    document.body.append(content);
    expect(getComputedStyle(content).backgroundColor).toBe('#282C34');
  });

  it('keeps light mode unchanged when toggling out of dark mode', () => {
    document.documentElement.classList.add('dark');
    xtermTheme();
    document.documentElement.classList.remove('dark');
    expect(xtermTheme()).toMatchObject({
      background: '#FFFFFF', foreground: '#1F2328',
      cursor: '#5A6472', cursorAccent: '#FFFFFF',
    });
  });

  it.each(['palette-pastel-pixel', 'palette-nord', 'palette-catppuccin', 'palette-custom'])('keeps the dark terminal Slate with %s active', palette => {
    document.documentElement.className = 'dark ' + palette;
    expect(xtermTheme()).toMatchObject({
      background: '#282C34', foreground: '#E2E6ED',
      cursor: '#A8C7FA', cursorAccent: '#282C34',
      selectionBackground: '#46546B',
    });
    if (palette === 'palette-pastel-pixel') {
      const root = getComputedStyle(document.documentElement);
      expect(root.getPropertyValue('--bg')).toBe('#332e46');
      expect(root.getPropertyValue('--content-bg')).toBe('#272b3b');
    }
  });

  it.each(['palette-pastel-pixel', 'palette-nord', 'palette-catppuccin', 'palette-custom'])('preserves the selected %s palette in light mode', palette => {
    document.documentElement.className = palette;
    const root = getComputedStyle(document.documentElement);
    expect(root.getPropertyValue('--terminal-bg')).toBe('');
    expect(xtermTheme().background).toBe(root.getPropertyValue('--content-bg'));
    expect(xtermTheme().foreground).toBe(root.getPropertyValue('--ink'));
  });

  it.each(['bg-content', 'bg-terminal'])('preserves wallpaper transparency for %s', zone => {
    document.documentElement.className = 'dark ' + zone;
    expect(xtermTheme()).toMatchObject({
      background: 'rgba(0,0,0,0)', cursorAccent: '#282C34',
    });
    const page = document.createElement('div');
    page.className = 'terminal-page';
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const viewport = document.createElement('div');
    viewport.className = 'xterm-viewport';
    xterm.append(viewport);
    page.append(xterm);
    document.body.append(page);
    expect(getComputedStyle(page).backgroundColor).toBe('transparent');
    expect(getComputedStyle(viewport).backgroundColor).toBe('transparent');
  });
});
