/* ---------------- ui state (session-only, not persisted) ---------------- */

import type { PaneNode } from '../shared/split-tree';

export type Route =
  | { view: 'terminal'; tabId: string }
  | { view: 'welcome' }
  | { view: 'agents' }
  | { view: 'agentDetail'; agentId: string; tab: 'model' | 'memory' | 'skills' | 'mcp' }
  | { view: 'diff'; workspaceId: string; path: string; staged?: boolean }
  /* one commit's detail page, opened by clicking a row in the commit graph */
  | { view: 'commit'; workspaceId: string; oid: string; short: string }
  /* a tab contributed by a plugin. `tabId` is the contribution id the
     manifest declared; the body comes from the plugin's own renderer. */
  | { view: 'plugin'; pluginId: string; tabId: string; title: string };

export interface TabEntry {
  id: string;
  route: Route;
  workspaceId?: string;
  /* split view layout; undefined when the tab holds a single pane.
     route.tabId stays the anchor until that pane closes. */
  tree?: PaneNode;
  /* custom tab title (terminal tabs only); falls back to branch/workspace name */
  title?: string;
}

export const ui = {
  route: { view: 'welcome' } as Route,
  tabs: [] as TabEntry[],
  activeTab: null as string | null,
  sel: null as string | null,
  sidebarOpen: false,
  gitPanelOpen: false,
  maximized: false,
  history: [] as string[],
  future: [] as string[],
};
