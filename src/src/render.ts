/* ---------------- render registry ----------------
   Views trigger re-renders through here; the actual implementations
   live in main.ts and are registered at boot. This keeps views and the
   root renderer from importing each other. */

import { ui, type Route } from './state';
import type { PaneNode } from '../shared/split-tree';

let rootFn: (() => void) | null = null;
let contentFn: ((route: Route) => void) | null = null;
let sidebarFn: (() => void) | null = null;

/* Which page the DOM currently shows, so a content-only repaint can tell
   "same page, new data" from "different page". Keyed on the route shape plus
   the ids that identify the page, never on object identity — callers rebuild
   the route object freely. */
let mountedPage: string | null = null;
/* A terminal page's DOM *is* its pane tree: the panes, the dividers and their
   nesting are built from it. Splitting, re-orienting or closing a pane keeps
   pageKey() identical while making the mounted DOM stale, so the record of
   what is on screen has to carry the tree's shape as well. */
let mountedTree: string | null = null;

export function pageKey(route: Route): string {
  switch (route.view) {
    case 'terminal': return `terminal:${route.tabId ?? ''}`;
    case 'diff': return `diff:${route.workspaceId}:${route.path}`;
    case 'commit': return `commit:${route.workspaceId}:${route.oid}`;
    case 'agentDetail': return `agentDetail:${route.agentId}:${route.tab ?? ''}`;
    case 'plugin': return `plugin:${route.pluginId}:${route.tabId}`;
    default: return route.view;
  }
}

/* the shape the DOM was built from, with leaf ids and split directions */
function treeShape(route: Route): string | null {
  if (route.view !== 'terminal') return null;
  const entry = ui.tabs.find(t => t.route.view === 'terminal' && t.route.tabId === route.tabId);
  return entry?.tree ? shapeOf(entry.tree) : '';
}

function shapeOf(node: PaneNode): string {
  return node.kind === 'leaf'
    ? node.id
    : node.dir + '(' + shapeOf(node.first) + ',' + shapeOf(node.second) + ')';
}

/** Called by the content renderer once it has put a page in the DOM. */
export function noteMountedPage(route: Route): void {
  mountedPage = pageKey(route);
  mountedTree = treeShape(route);
}

/** True when the DOM already shows exactly this page, pane tree included. */
export function pageIsMounted(route: Route): boolean {
  return pageKey(route) === mountedPage && treeShape(route) === mountedTree;
}

export function registerRenderers(fns: {
  root: () => void;
  content: (route: Route) => void;
  sidebar: () => void;
}): void {
  rootFn = fns.root;
  contentFn = fns.content;
  sidebarFn = fns.sidebar;
}

/* Two levels of repaint, because most state changes touch one region.
 *
 * render() is the full pass: shell prefs, sidebar, tab strip, content. Use it
 * when the thing that changed can move any of the three — a new workspace, a
 * new tab, a route change.
 *
 * repaintContent() repaints only the page area. For a stateless page that is
 * enough on its own. A terminal page is the exception: its DOM *is* the pane
 * tree, so it is rebuilt when the tree changed and left alone when it did not.
 * The content renderer starts with `innerHTML = ''`, which detaches every
 * xterm host and re-appends it, dropping keyboard focus, scroll position and
 * IME composition for a repaint the user did not ask for — a theme toggle or a
 * tab rename must not pay that.
 */
export function render(): void {
  if (rootFn) rootFn();
}

export function repaintContent(): void {
  if (!contentFn) return;
  /* a different page needs the full pass: the tab strip and the sidebar both
     track the active route */
  if (pageKey(ui.route) !== mountedPage) { render(); return; }
  /* same page, different pane tree: the page area is built from the tree, so
     it has to be rebuilt. Content only — neither the sidebar nor the tab
     strip tracks the tree. */
  if (treeShape(ui.route) !== mountedTree) { contentFn(ui.route); return; }
  if (ui.route.view === 'terminal') return;
  contentFn(ui.route);
}
export function renderContent(): void {
  if (contentFn) contentFn(ui.route);
}
export function renderSidebar(): void {
  if (sidebarFn) sidebarFn();
}
