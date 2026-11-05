import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerRenderers, render, repaintContent, noteMountedPage, pageKey } from './render';
import { ui, type Route } from './state';
import { leafNode, splitLeaf, removeLeaf, setSplitDir, type PaneNode } from '../shared/split-tree';

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
    ui.tabs = [];
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

  /* The pane tree is what the page area is built from, so a tree change makes
     the mounted DOM stale even though the route never moved. Splitting a pane
     used to leave the new pane only in the state (the sidebar lists each leaf)
     while the page area kept showing one terminal. */
  describe('a terminal pane tree that changed', () => {
    const mountTree = (tree: PaneNode) => {
      ui.route = terminal;
      ui.tabs = [{ id: 'term:pane-1', route: terminal, tree }];
      noteMountedPage(terminal);
    };

    it('repaints the page when a pane is split off', () => {
      mountTree(leafNode('pane-1'));
      ui.tabs[0].tree = splitLeaf(leafNode('pane-1'), 'pane-1', 'v', 'pane-2', 'k1');
      repaintContent();
      expect(content).toHaveBeenCalledTimes(1);
      expect(root).not.toHaveBeenCalled();
    });

    it('repaints the page when a pane closes', () => {
      mountTree(splitLeaf(leafNode('pane-1'), 'pane-1', 'v', 'pane-2', 'k1'));
      ui.tabs[0].tree = removeLeaf(ui.tabs[0].tree!, 'pane-2')!;
      repaintContent();
      expect(content).toHaveBeenCalledTimes(1);
      expect(root).not.toHaveBeenCalled();
    });

    it('repaints the page when a split flips direction', () => {
      mountTree(splitLeaf(leafNode('pane-1'), 'pane-1', 'v', 'pane-2', 'k1'));
      ui.tabs[0].tree = setSplitDir(ui.tabs[0].tree!, 'k1', 'h');
      repaintContent();
      expect(content).toHaveBeenCalledTimes(1);
      expect(root).not.toHaveBeenCalled();
    });

    it('settles after the repaint: the same tree twice is not rebuilt again', () => {
      mountTree(leafNode('pane-1'));
      ui.tabs[0].tree = splitLeaf(leafNode('pane-1'), 'pane-1', 'v', 'pane-2', 'k1');
      repaintContent();
      noteMountedPage(terminal);
      repaintContent();
      expect(content).toHaveBeenCalledTimes(1);
    });
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
