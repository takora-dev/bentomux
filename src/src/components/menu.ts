/* ---------------- context menu (one popup, every right-click) ---------------- */

import { h, markup } from '../dom';
import { IC } from '../icons';

export interface MenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  /* icon SVG from icons.ts (a compile-time constant), drawn left of the label */
  icon?: string;
  /* color swatch dots drawn left of the label instead of an icon (palette
     picker); takes precedence over `icon` */
  swatch?: string[];
  /* dim secondary text after the label, e.g. the folder a path lives in */
  hint?: string;
  /* tooltip text; defaults to `hint` when omitted */
  title?: string;
  /* nested entries: a flyout opens on hover (click toggles it) */
  submenu?: MenuEntry[];
}
export interface MenuSep { sep: true }
export type MenuEntry = MenuItem | MenuSep;

let current: HTMLElement | null = null;
/* element that opened the menu as a left-click toggle; pointerdowns on it
   don't dismiss the menu so its own click handler can close it instead */
let toggleAnchor: Element | null = null;
let dismissFn: ((e: Event) => void) | null = null;
let keyFn: ((e: KeyboardEvent) => void) | null = null;
/* the one open submenu flyout, its owning row, and the grace timer that keeps
   it alive while the pointer crosses from the row into the flyout */
let submenuEl: HTMLElement | null = null;
let submenuOwner: HTMLElement | null = null;
let submenuTimer: number | null = null;

function cancelSubmenuClose(): void {
  if (submenuTimer != null) {
    clearTimeout(submenuTimer);
    submenuTimer = null;
  }
}

function closeSubmenu(): void {
  cancelSubmenuClose();
  submenuEl?.remove();
  submenuEl = null;
  submenuOwner?.setAttribute('aria-expanded', 'false');
  submenuOwner = null;
}

function scheduleSubmenuClose(): void {
  cancelSubmenuClose();
  /* short grace period: the pointer may be travelling from the row into the
     flyout, and closing on pointerleave alone would make that impossible */
  submenuTimer = window.setTimeout(() => {
    submenuTimer = null;
    closeSubmenu();
  }, 160);
}

export function closeContextMenu(): void {
  closeSubmenu();
  toggleAnchor = null;
  if (dismissFn) {
    document.removeEventListener('pointerdown', dismissFn, true);
    document.removeEventListener('contextmenu', dismissFn, true);
    dismissFn = null;
  }
  if (keyFn) {
    document.removeEventListener('keydown', keyFn, true);
    keyFn = null;
  }
  window.removeEventListener('blur', closeContextMenu);
  current?.remove();
  current = null;
}

export function contextMenuAnchoredTo(el: Element): boolean {
  return current != null && toggleAnchor === el;
}

/* the flyout lives inside the menu element (not inside the row) so the menu's
   own dismiss check — `menu.contains(target)` — covers it, and so a click in
   the flyout cannot bubble into the row's toggle handler. */
function openSubmenu(menu: HTMLElement, owner: HTMLElement, entries: MenuEntry[]): void {
  if (submenuOwner === owner) {
    cancelSubmenuClose();
    return;
  }
  closeSubmenu();
  const fly = buildMenu(entries, true);
  menu.append(fly);
  const r = owner.getBoundingClientRect();
  const fr = fly.getBoundingClientRect();
  /* to the right of the row; flip to the left when the viewport edge is near */
  let left = r.right + 2;
  if (left + fr.width > window.innerWidth - 4) left = r.left - fr.width - 2;
  left = Math.max(4, Math.min(left, window.innerWidth - fr.width - 4));
  /* align with the row, clamped inside the viewport */
  const top = Math.max(4, Math.min(r.top - 5, window.innerHeight - fr.height - 4));
  fly.style.left = left + 'px';
  fly.style.top = top + 'px';

  fly.addEventListener('pointerenter', cancelSubmenuClose);
  /* a flyout torn down from under the pointer fires pointerleave on its way
     out; only the live flyout may schedule its own close */
  fly.addEventListener('pointerleave', () => { if (submenuEl === fly) scheduleSubmenuClose(); });
  submenuEl = fly;
  submenuOwner = owner;
  owner.setAttribute('aria-expanded', 'true');
}

function buildMenu(entries: MenuEntry[], isSub: boolean): HTMLElement {
  const menu = h('div', { class: 'ctx-menu' + (isSub ? ' ctx-sub' : ''), role: 'menu' });
  for (const entry of entries) {
    if ('sep' in entry) { menu.append(h('div', { class: 'ctx-sep' })); continue; }
    const tip = entry.title ?? entry.hint;
    const item = h('button', {
      class: 'ctx-item' + (entry.disabled ? ' disabled' : ''),
      role: 'menuitem',
      ...(tip ? { title: tip } : {}),
      ...(entry.submenu ? { 'aria-haspopup': 'true', 'aria-expanded': 'false' } : {}),
    },
      entry.swatch ? h('span', { class: 'ctx-swatch' },
        ...entry.swatch.map(c => h('span', { style: 'background:' + c }))) : null,
      entry.icon ? markup('span', { class: 'ctx-icon' }, entry.icon) : null,
      h('span', { class: 'ctx-label' }, entry.label),
      entry.hint ? h('span', { class: 'ctx-hint' }, entry.hint) : null,
      entry.submenu ? markup('span', { class: 'ctx-chev' }, IC.chev) : null);
    const submenu = entry.submenu;
    item.addEventListener('click', () => {
      if (entry.disabled) return;
      if (submenu) {
        /* click is the keyboard/no-hover fallback for the hover-opened flyout */
        if (submenuOwner === item) closeSubmenu();
        else openSubmenu(menu, item, submenu);
        return;
      }
      closeContextMenu();
      entry.action?.();
    });
    if (submenu) {
      item.addEventListener('pointerenter', () => {
        if (!entry.disabled) openSubmenu(menu, item, submenu);
      });
      item.addEventListener('pointerleave', scheduleSubmenuClose);
    } else {
      /* hovering any row outside the open flyout closes it, the usual menu
         behaviour. Rows inside the flyout are excluded — without that check
         the flyout would close itself the moment the pointer entered one of
         its own items. */
      item.addEventListener('pointerenter', () => {
        if (submenuEl?.contains(item)) return;
        closeSubmenu();
      });
    }
    menu.append(item);
  }
  return menu;
}

export function openContextMenu(x: number, y: number, entries: MenuEntry[], toggleAnchorEl?: Element): void {
  closeContextMenu();
  const menu = buildMenu(entries, false);
  document.body.append(menu);

  /* clamp inside the viewport once measured */
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  current = menu;
  toggleAnchor = toggleAnchorEl ?? null;

  dismissFn = (e: Event): void => {
    if (toggleAnchor && e.target instanceof Node && toggleAnchor.contains(e.target)) return;
    if (!menu.contains(e.target as Node)) closeContextMenu();
  };
  keyFn = (e: KeyboardEvent): void => { if (e.key === 'Escape') closeContextMenu(); };
  /* defer so the very event that opened the menu can't dismiss it */
  setTimeout(() => {
    if (!current || !dismissFn || !keyFn) return;
    document.addEventListener('pointerdown', dismissFn, true);
    document.addEventListener('contextmenu', dismissFn, true);
    document.addEventListener('keydown', keyFn, true);
    window.addEventListener('blur', closeContextMenu);
  }, 0);
}
