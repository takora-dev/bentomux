/* ---------------- search palette (sidebar trigger → modal) ----------------
   Live filter for sidebar nav, terminal panes, and active tabs. Triggered
   by the sidebar search button (renderSidebar) and Ctrl/Cmd+K (keyboard.ts).
   Picking an item closes the modal and runs the item's `onPick`. */

import { h } from '../dom';
import { ic, IC } from '../icons';
import { ui, type TabEntry } from '../state';
import { db, branches, runtime } from '../store';
import { go } from '../router';
import { openModal, currentModal } from '../components/modal';
import { leavesOf, activate, tabTitle } from './tabs';
import { primePaneFocus } from './terminal';
import { commandEntries } from '../plugin/registry';
import { ensureActive } from '../plugin/loader';
import { contributionLabel } from '../plugin/icons';

interface SearchItem {
  kind: 'nav' | 'pane' | 'tab';
  id: string;
  label: string;
  sub: string;
  icon: keyof typeof IC;
  onPick: () => void;
}

interface Section {
  title: string;
  items: SearchItem[];
}

function buildSearchItems(): Section[] {
  const sections: Section[] = [];

  const navItems: SearchItem[] = [
    { kind: 'nav', id: 'nav:settings', label: 'Settings', sub: 'Theme, palette, terminal font', icon: 'gear',
      onPick: () => { void import('./settings').then(m => m.openSettingsModal()); } },
  ];
  sections.push({ title: 'Menu', items: navItems });

  const paneItems: SearchItem[] = [];
  for (const t of ui.tabs.filter(t => t.route.view === 'terminal')) {
    const ws = db.workspaces.find(w => w.id === t.workspaceId);
    const workspaceName = ws?.name || 'terminal';
    for (const pid of leavesOf(t)) {
      const st = runtime[pid];
      const status = st?.state ?? (st?.running ? 'working' : 'idle');
      const agent = st?.runtime || 'shell';
      const branch = branches.get(t.workspaceId || '') || workspaceName;
      const tabName = t.title || branch;
      paneItems.push({
        kind: 'pane',
        id: 'pane:' + pid,
        label: tabName,
        sub: workspaceName + ' · ' + status + ' · ' + agent,
        icon: 'git',
        onPick: () => { primePaneFocus(pid); activate(t.id); },
      });
    }
  }
  if (paneItems.length) sections.push({ title: 'Terminal panes', items: paneItems });

  /* Active tabs: skip single-pane terminal tabs that have no custom title
     (their pane row already covers them). Resource pages always show. */
  const tabItems: SearchItem[] = [];
  for (const t of ui.tabs) {
    if (t.route.view === 'terminal' && !t.tree && !t.title) continue;
    tabItems.push({
      kind: 'tab',
      id: 'tab:' + t.id,
      label: tabTitle(t),
      sub: tabKind(t),
      icon: tabIcon(t),
      onPick: () => activate(t.id),
    });
  }
  if (tabItems.length) sections.push({ title: 'Tabs', items: tabItems });

  /* plugin commands: declared in a manifest, so they appear in the palette
     even before the plugin's code has been imported. Picking one activates
     the plugin first (activation is lazy) and then runs the handler. */
  const pluginItems: SearchItem[] = commandEntries().map(entry => ({
    kind: 'nav' as const,
    id: 'plugin:' + entry.contribution.id,
    label: contributionLabel(entry.contribution),
    sub: 'Plugin · ' + entry.pluginName,
    icon: 'board' as keyof typeof IC,
    onPick: () => {
      void ensureActive(entry.pluginId).then(ok => {
        if (ok) entry.run();
        else console.warn(`[plugin:${entry.pluginId}] could not activate to run \`${entry.contribution.id}\``);
      });
    },
  }));
  if (pluginItems.length) sections.push({ title: 'Plugins', items: pluginItems });

  return sections;
}

function tabKind(t: TabEntry): string {
  if (t.route.view === 'terminal') return 'Terminal tab';
  if (t.route.view === 'agentDetail') return 'Agent · ' + t.route.tab;
  if (t.route.view === 'diff') return 'File diff';
  if (t.route.view === 'commit') return 'Commit · ' + t.route.short;
  return 'Agents page';
}

function tabIcon(t: TabEntry): keyof typeof IC {
  if (t.route.view === 'terminal') return 'git';
  if (t.route.view === 'agentDetail') return 'bot';
  if (t.route.view === 'commit') return 'git';
  return 'lines';
}

function itemMatches(item: SearchItem, q: string): boolean {
  if (!q) return true;
  return (item.label + ' ' + item.sub).toLowerCase().includes(q);
}

function paintList(sections: Section[], q: string, activeIndex: { i: number }, listHost: HTMLElement): void {
  listHost.innerHTML = '';
  const flat: SearchItem[] = [];

  if (!sections.length) {
    listHost.append(h('div', { class: 'search-palette-empty' }, 'Nothing to search yet.'));
    return;
  }

  for (const sec of sections) {
    const visible = sec.items.filter(i => itemMatches(i, q));
    if (!visible.length) continue;
    listHost.append(h('div', { class: 'search-palette-section' }, sec.title));
    for (const item of visible) {
      const idx = flat.length;
      flat.push(item);
      const isActive = idx === activeIndex.i;
      const li = h('li', {
        class: 'search-palette-item' + (isActive ? ' active' : ''),
        dataset: { idx: String(idx) },
        onmouseenter: () => setActive(idx, activeIndex, listHost),
        onclick: () => pickAndClose(item),
      },
        ic(item.icon),
        h('span', { class: 'item-label' }, item.label),
        h('span', { class: 'item-sub' }, item.sub));
      listHost.append(li);
    }
  }

  if (!flat.length) {
    listHost.append(h('div', { class: 'search-palette-empty' }, 'No matches for \u201C' + q + '\u201D.'));
  }
  if (flat.length && activeIndex.i >= flat.length) activeIndex.i = 0;
  /* re-highlight the active row (innerHTML wipe cleared the .active class) */
  const act = listHost.querySelector('.search-palette-item[data-idx="' + activeIndex.i + '"]');
  if (act) act.classList.add('active');
}

function setActive(idx: number, activeIndex: { i: number }, listHost: HTMLElement): void {
  if (activeIndex.i === idx) return;
  const prev = listHost.querySelector('.search-palette-item.active');
  if (prev) prev.classList.remove('active');
  activeIndex.i = idx;
  const next = listHost.querySelector('.search-palette-item[data-idx="' + idx + '"]');
  if (next) {
    next.classList.add('active');
    (next as HTMLElement).scrollIntoView({ block: 'nearest' });
  }
}

function pickAndClose(item: SearchItem): void {
  /* close first so render() inside onPick doesn't try to repaint a removed node */
  const m = currentModal;
  if (m) m.close();
  item.onPick();
}

export function openSearchModal(): void {
  if (currentModal) return; /* one modal at a time — keyboard handler also guards */

  const sections = buildSearchItems();
  const activeIndex = { i: 0 };
  const input = h('input', {
    class: 'search-palette-input',
    type: 'search',
    placeholder: 'Search menus, panes, and tabs\u2026',
    'aria-label': 'Search',
    spellcheck: 'false',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const ico = ic('search');
  ico.classList.add('search-palette-ico');
  const listHost = h('div', { class: 'search-palette-list' });

  const body = h('div', { class: 'search-palette-body' },
    h('div', { class: 'search-palette-input-wrap' }, ico, input),
    listHost);

  function repaint(): void {
    paintList(sections, input.value.trim().toLowerCase(), activeIndex, listHost);
  }
  repaint();

  input.addEventListener('input', () => { activeIndex.i = 0; repaint(); });

  /* arrow keys + Enter on the input (focus stays in input while typing) */
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    const total = listHost.querySelectorAll('.search-palette-item').length;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (total) setActive((activeIndex.i + 1) % total, activeIndex, listHost); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (total) setActive((activeIndex.i - 1 + total) % total, activeIndex, listHost); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim().toLowerCase();
      const items = sections.flatMap(s => s.items).filter(i => itemMatches(i, q));
      const pick = items[activeIndex.i];
      if (pick) pickAndClose(pick);
    }
  });

  openModal({
    title: 'Search',
    body,
    /* no footer — the input is the primary control; Esc/overlay close is enough */
  });
  /* widen the dialog for the palette (override .dialog 440px cap) */
  const dialog = document.querySelector('.dialog.cmd-palette, .dialog') as HTMLElement | null;
  if (dialog) dialog.classList.add('cmd-palette');
  setTimeout(() => { input.focus(); input.select(); }, 0);
}
