import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openContextMenu, closeContextMenu, contextMenuAnchoredTo } from './menu';

/* Every dismissable surface in the app installs capture-phase listeners on
   document and window. The bug they all had: closing removed some of them, or
   removed them from the wrong phase, and the next open stacked another set.
   A menu that leaks is not a crash — it is an Escape key that closes two menus
   at once, or a click that dismisses something already gone. */

const entries = () => [
  { label: 'Rename', onSelect: vi.fn() },
  { label: 'Close', onSelect: vi.fn() },
];

/* the menu defers its listeners by a tick so the click that opened it cannot
   dismiss it — wait for that */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 5));

describe('context menu lifecycle', () => {
  beforeEach(() => { closeContextMenu(); });
  afterEach(() => { closeContextMenu(); });

  it('opens one menu and reports it as current', () => {
    openContextMenu(10, 10, entries());
    expect(document.querySelectorAll('.ctx-menu').length).toBe(1);
    expect(contextMenuAnchoredTo(document.body)).toBe(false);
  });

  it('replaces the previous menu instead of stacking a second one', () => {
    openContextMenu(10, 10, entries());
    openContextMenu(40, 40, entries());
    expect(document.querySelectorAll('.ctx-menu').length).toBe(1);
  });

  it('closes on Escape and leaves nothing in the DOM', async () => {
    openContextMenu(10, 10, entries());
    await flush();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelectorAll('.ctx-menu').length).toBe(0);
  });

  it('does not respond to Escape after it was closed', async () => {
    openContextMenu(10, 10, entries());
    await flush();
    closeContextMenu();
    /* a leaked keydown listener would throw or reopen here; nothing should
       happen at all */
    expect(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }).not.toThrow();
    expect(document.querySelectorAll('.ctx-menu').length).toBe(0);
  });

  it('closes on a pointerdown outside it', async () => {
    openContextMenu(10, 10, entries());
    await flush();
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelectorAll('.ctx-menu').length).toBe(0);
  });

  it('survives close being called twice', async () => {
    openContextMenu(10, 10, entries());
    await flush();
    closeContextMenu();
    expect(() => closeContextMenu()).not.toThrow();
  });

  it('does not fire an entry callback when dismissed', async () => {
    const list = entries();
    openContextMenu(10, 10, list);
    await flush();
    closeContextMenu();
    expect(list[0].onSelect).not.toHaveBeenCalled();
  });
});
