/* ---------------- agent events from the bridge ----------------
   Approval decisions live entirely in the overlay window (src/main/
   overlay.ts) — the main renderer shows no notification UI. It only
   reacts to jump requests by focusing the pane, and reports the active
   tab's anchor pane to main so the bridge knows when the user is
   already looking at the requesting pane. */

import { ui, type Route, type TabEntry } from '../state';
import { db } from '../store';
import { leafIds, leafNode } from '../../shared/split-tree';
import type { AgentEventNotice } from '../../shared/types';
import { activate } from './tabs';
import { primePaneFocus } from './terminal';
import api from '../../preload/bentomux';

type TerminalEntry = TabEntry & { route: Extract<Route, { view: 'terminal' }> };
const isTerminal = (t: TabEntry): t is TerminalEntry => t.route.view === 'terminal';

const treeOf = (t: TerminalEntry) => t.tree ?? leafNode(t.route.tabId);

/* pane → its tab entry; falls back to prefix-matching cwd against
   workspace paths for sessions Bentomux did not spawn */
function entryFor(paneId: string | null, cwd: string | null): TabEntry | undefined {
  if (paneId) {
    const byPane = ui.tabs.find(t => isTerminal(t) && leafIds(treeOf(t)).includes(paneId));
    if (byPane) return byPane;
  }
  if (!cwd) return undefined;
  const norm = cwd.replace(/[\\/]+$/, '').toLowerCase();
  const ws = db.workspaces.find(w => norm.startsWith(w.path.toLowerCase()));
  if (!ws) return undefined;
  return ui.tabs.find(t => isTerminal(t) && t.workspaceId === ws.id);
}

function jumpTo(paneId: string | null, cwd: string | null): void {
  const entry = entryFor(paneId, cwd);
  if (!entry || !isTerminal(entry)) return;
  if (paneId && leafIds(treeOf(entry)).includes(paneId)) primePaneFocus(paneId);
  activate(entry.id);
}

export function initAgentEvents(): void {
  api.onAgentEvent(notice => {
    if (notice.kind === 'jump') jumpTo(notice.paneId, notice.cwd);
  });
}
