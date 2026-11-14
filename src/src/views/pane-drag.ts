export type PaneSide = 'left' | 'right' | 'top' | 'bottom';

export function paneDropSide(x: number, y: number, rect: DOMRect): PaneSide {
  const dx = (x - rect.left) / rect.width - 0.5;
  const dy = (y - rect.top) / rect.height - 0.5;
  return Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'top' : 'bottom');
}

/* Pointer events work in Tauri even when native file-drop intercepts HTML5 DnD. */
export function wirePaneDrag(
  handle: HTMLElement,
  pane: HTMLElement,
  move: (targetId: string, side: PaneSide) => void,
): void {
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let target: HTMLElement | null = null;
  let side: PaneSide = 'right';

  const clearTarget = (): void => {
    if (target) delete target.dataset.dropSide;
    target = null;
  };
  const stop = (): void => {
    const captured = pointerId;
    pointerId = null;
    dragging = false;
    clearTarget();
    document.body.classList.remove('terminal-pane-dragging');
    document.removeEventListener('keydown', cancelOnEscape, true);
    window.removeEventListener('blur', stop);
    if (captured !== null && handle.hasPointerCapture(captured)) handle.releasePointerCapture(captured);
  };
  const cancelOnEscape = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    stop();
  };
  const updateTarget = (e: PointerEvent): void => {
    clearTarget();
    const candidate = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.pane');
    if (!candidate || candidate === pane || candidate.closest('.mux-body') !== pane.closest('.mux-body')) return;
    target = candidate;
    side = paneDropSide(e.clientX, e.clientY, target.getBoundingClientRect());
    target.dataset.dropSide = side;
  };

  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0 || pointerId !== null) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    handle.setPointerCapture(e.pointerId);
    document.addEventListener('keydown', cancelOnEscape, true);
    window.addEventListener('blur', stop);
  });
  handle.addEventListener('pointermove', e => {
    if (pointerId !== e.pointerId) return;
    if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
    dragging = true;
    document.body.classList.add('terminal-pane-dragging');
    updateTarget(e);
  });
  handle.addEventListener('pointerup', e => {
    if (pointerId !== e.pointerId) return;
    if (dragging) updateTarget(e);
    const targetId = dragging ? target?.dataset.pane : undefined;
    const dropSide = side;
    stop();
    if (targetId) move(targetId, dropSide);
  });
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('lostpointercapture', stop);
}
