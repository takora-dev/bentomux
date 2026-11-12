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

export interface MenuOptions {
  role?: 'menu' | 'listbox';
  id?: string;
  selectedIndex?: number;
  minWidth?: number;
  onClose?: () => void;
}

let onClosed: (() => void) | null = null;
let current: HTMLElement | null = null;
/* element that opened the menu as a left-click toggle; pointerdowns on it
   don't dismiss the menu so its own click handler can close it instead */
let toggleAnchor: Element | null = null;
let dismissFn: ((e: Event) => void) | null = null;
let keyFn: ((e: KeyboardEvent) => void) | null = null;
/* one controller per open menu: aborting it removes every listener the menu
   installed, including the deferred ones below */
let dismiss = new AbortController();
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
  /* every listener the menu installed hangs off this one signal */
  dismiss.abort();
  dismiss = new AbortController();
  dismissFn = null;
  keyFn = null;
  current?.remove();
  current = null;
  const callback = onClosed;
  onClosed = null;
  callback?.();
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

export function openContextMenu(x: number, y: number, entries: MenuEntry[], toggleAnchorEl?: Element, options: MenuOptions = {}): void {
  closeContextMenu();
  const menu = buildMenu(entries, false);
  const listbox = options.role === 'listbox';
  if (options.id) menu.id = options.id;
  if (options.minWidth != null) menu.style.minWidth = Math.min(options.minWidth, window.innerWidth - 8) + 'px';
  if (listbox) {
    menu.classList.add('select-menu');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', toggleAnchorEl?.getAttribute('aria-label') || toggleAnchorEl?.textContent || 'Options');
  }
  document.body.append(menu);
  const rows = Array.from(menu.querySelectorAll<HTMLElement>(':scope > .ctx-item'));
  let active = Math.max(0, Math.min(options.selectedIndex ?? 0, rows.length - 1));
  const activate = (index: number): void => {
    active = index;
    rows.forEach((row, i) => row.classList.toggle('active', i === active));
    const row = rows[active];
    if (row) {
      toggleAnchorEl?.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    }
  };
  if (listbox) {
    rows.forEach((row, index) => {
      row.id = `${menu.id}-option-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === options.selectedIndex));
      const hint = row.querySelector('.ctx-hint');
      if (hint?.textContent === '✓') {
        hint.setAttribute('aria-hidden', 'true');
        row.removeAttribute('title');
      }
      row.tabIndex = -1;
      row.addEventListener('pointerdown', e => e.preventDefault());
      row.addEventListener('pointerenter', () => activate(index));
    });
    activate(active);
  }

  /* clamp inside the viewport once measured */
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  current = menu;
  toggleAnchor = toggleAnchorEl ?? null;
  onClosed = options.onClose ?? null;
  /* opening again without closing first must not leave the previous menu's
     listeners attached to the new controller */
  dismiss.abort();
  dismiss = new AbortController();

  dismissFn = (e: Event): void => {
    if (toggleAnchor && e.target instanceof Node && toggleAnchor.contains(e.target)) return;
    if (!menu.contains(e.target as Node)) closeContextMenu();
  };
  let typed = '';
  let typedAt = 0;
  keyFn = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      closeContextMenu();
      if (listbox) {
        e.preventDefault();
        e.stopPropagation();
        if (toggleAnchorEl instanceof HTMLElement && toggleAnchorEl.isConnected) toggleAnchorEl.focus();
      }
      return;
    }
    if (!listbox || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Tab') { closeContextMenu(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (rows.length) activate((active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === 'Home' || e.key === 'End') {
      if (rows.length) activate(e.key === 'Home' ? 0 : rows.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      rows[active]?.click();
    } else if (e.key.length === 1) {
      const now = Date.now();
      typed = (now - typedAt < 600 ? typed : '') + e.key.toLocaleLowerCase();
      typedAt = now;
      const prefix = [...typed].every(char => char === typed[0]) ? typed[0] : typed;
      const start = typed.length === 1 || prefix.length === 1 ? active + 1 : active;
      for (let offset = 0; offset < rows.length; offset++) {
        const index = (start + offset) % rows.length;
        if (rows[index].querySelector('.ctx-label')?.textContent?.toLocaleLowerCase().startsWith(prefix)) {
          activate(index);
          break;
        }
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  /* defer so the very event that opened the menu can't dismiss it */
  setTimeout(() => {
    if (!current || !dismissFn || !keyFn) return;
    const opts = { capture: true, signal: dismiss.signal };
    document.addEventListener('pointerdown', dismissFn, opts);
    document.addEventListener('contextmenu', dismissFn, opts);
    document.addEventListener('keydown', keyFn, opts);
    window.addEventListener('blur', closeContextMenu, { signal: dismiss.signal });
  }, 0);
}
