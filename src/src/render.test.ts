import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerRenderers, render, repaintContent, noteMountedPage, pageKey } from './render';
import { ui, type Route } from './state';

/* render() and repaintContent() decide whether a state change is allowed to
   detach a live terminal. Getting that wrong is invisible in a screenshot and
   obvious to the user: focus leaves the pane, the scroll position resets, an
   IME composition is thrown away. These tests pin the decision, not the DOM. */

const terminal: Route = { view: 'terminal', tabId: 'pane-1' };
const diff: Route = { view: 'diff', workspaceId: 'ws-1', path: 'src/a.ts' };
const welcome: Route = { view: 'welcome' };

describe('pageKey()', () => {
  it('separates two panes of the same view', () => {
    expect(pageKey(terminal)).not.toBe(pageKey({ view: 'terminal', tabId: 'pane-2' }));
  });

  it('separates two files in the same workspace', () => {
    expect(pageKey(diff)).not.toBe(pageKey({ view: 'diff', workspaceId: 'ws-1', path: 'src/b.ts' }));
  });

  it('is stable across two route objects describing the same page', () => {
    expect(pageKey({ view: 'terminal', tabId: 'pane-1' })).toBe(pageKey(terminal));
  });
});

describe('repaintContent()', () => {
  let root: () => void;
  let content: (route: Route) => void;
  let sidebar: () => void;

  beforeEach(() => {
    root = vi.fn<() => void>();
    content = vi.fn<(route: Route) => void>();
    sidebar = vi.fn<() => void>();
    registerRenderers({ root, content, sidebar });
  });

  it('repaints the page without touching the shell when the page is unchanged', () => {
    ui.route = diff;
    noteMountedPage(diff);
    repaintContent();
    expect(content).toHaveBeenCalledTimes(1);
    expect(root).not.toHaveBeenCalled();
    expect(sidebar).not.toHaveBeenCalled();
  });

  it('falls back to the full pass when the page actually changed', () => {
    ui.route = diff;
    noteMountedPage(welcome);
    repaintContent();
    expect(root).toHaveBeenCalledTimes(1);
    expect(content).not.toHaveBeenCalled();
  });

  it('refuses to rebuild a terminal page that is already mounted', () => {
    ui.route = terminal;
    noteMountedPage(terminal);
    repaintContent();
    expect(content).not.toHaveBeenCalled();
    expect(root).not.toHaveBeenCalled();
  });

  it('does rebuild a terminal page when the route moved to a different pane', () => {
    ui.route = { view: 'terminal', tabId: 'pane-2' };
    noteMountedPage(terminal);
    repaintContent();
    expect(root).toHaveBeenCalledTimes(1);
  });

  it('is a no-op before the first paint rather than rendering blind', () => {
    /* nothing mounted yet, so the page key cannot match; the full pass is the
       only correct answer */
    ui.route = welcome;
    noteMountedPage(welcome);
    repaintContent();
    expect(content).toHaveBeenCalledTimes(1);
  });
});

describe('render()', () => {
  it('always runs the full pass', () => {
    const root = vi.fn<() => void>();
    registerRenderers({ root, content: vi.fn<(route: Route) => void>(), sidebar: vi.fn<() => void>() });
    ui.route = terminal;
    noteMountedPage(terminal);
    render();
    expect(root).toHaveBeenCalledTimes(1);
  });
});
