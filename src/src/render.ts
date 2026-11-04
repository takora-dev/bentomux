/* ---------------- render registry ----------------
   Views trigger re-renders through here; the actual implementations
   live in main.ts and are registered at boot. This keeps views and the
   root renderer from importing each other. */

import { ui, type Route } from './state';

let rootFn: (() => void) | null = null;
let contentFn: ((route: Route) => void) | null = null;
let sidebarFn: (() => void) | null = null;

/* Which page the DOM currently shows, so a content-only repaint can tell
   "same page, new data" from "different page". Keyed on the route shape plus
   the ids that identify the page, never on object identity — callers rebuild
   the route object freely. */
let mountedPage: string | null = null;

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

/** Called by the content renderer once it has put a page in the DOM. */
export function noteMountedPage(route: Route): void {
  mountedPage = pageKey(route);
}

/** What the DOM is currently showing, or null before the first paint. */
export function mountedPageKey(): string | null {
  return mountedPage;
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
 * renderContent() repaints only the page area, and it *skips a terminal route
 * whose panes are already mounted*. That skip is the whole point: content
 * innerHTML = '' detaches every xterm host and re-appends it, which drops
 * keyboard focus, scroll position and IME composition for a repaint the user
 * did not ask for. A theme toggle, a pane split, a tab rename — none of them
 * change which page is on screen.
 */
/* Two levels of repaint, because most state changes touch one region.
 *
 * render() is the full pass: shell prefs, sidebar, tab strip, content. Use it
 * when the thing that changed can move any of the three — a new workspace, a
 * new tab, a route change.
 *
 * repaintContent() repaints only the page area, and it *skips a terminal route
 * whose panes are already mounted*. That skip is the whole point: the content
 * renderer starts with `innerHTML = ''`, which detaches every xterm host and
 * re-appends it, dropping keyboard focus, scroll position and IME composition
 * for a repaint the user did not ask for. A theme toggle, a pane split, a tab
 * rename — none of them change which page is on screen.
 */
export function render(): void {
  if (rootFn) rootFn();
}

export function repaintContent(): void {
  if (!contentFn) return;
  /* a different page needs the full pass: the tab strip and the sidebar both
     track the active route */
  if (pageKey(ui.route) !== mountedPage) { render(); return; }
  if (ui.route.view === 'terminal') return;
  contentFn(ui.route);
}
export function renderContent(): void {
  if (contentFn) contentFn(ui.route);
}
export function renderSidebar(): void {
  if (sidebarFn) sidebarFn();
}
