import { afterEach, describe, expect, it, vi } from 'vitest';
import { paneDropSide, wirePaneDrag } from './pane-drag';

const rect = { left: 100, top: 100, width: 400, height: 200 } as DOMRect;

function setup() {
  document.body.innerHTML = '<div class="mux-body"><div class="pane" data-pane="a"><button>Move</button></div><div class="pane" data-pane="b"></div></div>';
  const pane = document.querySelector<HTMLElement>('[data-pane="a"]')!;
  const target = document.querySelector<HTMLElement>('[data-pane="b"]')!;
  const handle = pane.querySelector('button')!;
  let captured = false;
  handle.setPointerCapture = vi.fn(() => { captured = true; });
  handle.hasPointerCapture = vi.fn(() => captured);
  handle.releasePointerCapture = vi.fn(() => { captured = false; });
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect);
  const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
  const move = vi.fn();
  wirePaneDrag(handle, pane, move);
  const pointer = (type: string, x = 490, y = 200, pointerId = 1): void => {
    handle.dispatchEvent(new PointerEvent(type, { pointerId, clientX: x, clientY: y, button: 0, bubbles: true }));
  };
  return { pane, target, handle, move, pointer, hit };
}

afterEach(() => {
  window.dispatchEvent(new Event('blur'));
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.body.className = '';
});

describe('pane drop direction', () => {
  it.each([
    [110, 200, 'left'], [490, 200, 'right'],
    [300, 110, 'top'], [300, 290, 'bottom'],
  ])('maps (%i, %i) to %s', (x, y, side) => {
    expect(paneDropSide(x as number, y as number, rect)).toBe(side);
  });
});

describe('pane pointer drag', () => {
  it('previews the drop and moves only on release', () => {
    const { target, move, pointer } = setup();
    pointer('pointerdown', 110, 110);
    pointer('pointermove');
    expect(target.dataset.dropSide).toBe('right');
    expect(move).not.toHaveBeenCalled();
    pointer('pointerup');
    expect(move).toHaveBeenCalledExactlyOnceWith('b', 'right');
    expect(target.dataset.dropSide).toBeUndefined();
    expect(document.body.classList.contains('terminal-pane-dragging')).toBe(false);
  });

  it('does not drag a click or tiny movement', () => {
    const { move, pointer } = setup();
    pointer('pointerdown', 110, 110);
    pointer('pointermove', 112, 111);
    pointer('pointerup', 112, 111);
    expect(move).not.toHaveBeenCalled();
  });

  it.each(['pointercancel', 'lostpointercapture', 'escape', 'blur'])('cancels on %s', reason => {
    const { target, move, pointer } = setup();
    pointer('pointerdown', 110, 110);
    pointer('pointermove');
    if (reason === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    else if (reason === 'blur') window.dispatchEvent(new Event('blur'));
    else pointer(reason);
    pointer('pointerup');
    expect(move).not.toHaveBeenCalled();
    expect(target.dataset.dropSide).toBeUndefined();
    expect(document.body.classList.contains('terminal-pane-dragging')).toBe(false);
  });

  it.each(['self', 'outside', 'other-layout'])('ignores drops on %s', location => {
    const { pane, target, move, pointer, hit } = setup();
    if (location === 'self') hit.mockReturnValue(pane);
    if (location === 'outside') hit.mockReturnValue(null);
    if (location === 'other-layout') {
      const other = document.createElement('div');
      other.className = 'mux-body';
      document.body.append(other);
      other.append(target);
    }
    pointer('pointerdown', 110, 110);
    pointer('pointermove');
    pointer('pointerup');
    expect(move).not.toHaveBeenCalled();
  });

  it('rechecks the release position instead of using a stale target', () => {
    const { move, pointer, hit } = setup();
    pointer('pointerdown', 110, 110);
    pointer('pointermove');
    hit.mockReturnValue(null);
    pointer('pointerup');
    expect(move).not.toHaveBeenCalled();
  });
});
