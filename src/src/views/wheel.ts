import type { Terminal } from '@xterm/xterm';

/* Wheel handling for a pane. The guard only takes gestures xterm gets wrong:

     - On Windows, ConPTY throws away the mouse reports an application asks
       for, so a fullscreen program never sees the wheel. Page Up and Page Down
       are the keys such programs scroll with, and ConPTY delivers those.
     - A trackpad flick of a few pixels lands below one cell, which xterm drops
       before reporting it, so nothing at all happens.

   Everything else is left alone. A normal scrollback gesture that this module
   rewrote would move by this module's arithmetic instead of xterm's, and the
   two disagree: xterm keeps a fractional accumulator and a cached scrollTop of
   its own, so a gesture recomputed from `viewportY` lands somewhere else. */

/* xterm's wheel multiplier. A macOS trackpad sends dozens of 2-10px events per
   gesture, so 3 is what makes a gentle flick land on a row (the value VS Code
   ships for its own panes). A Windows mouse sends one event of deltaY 100 per
   notch instead, where the same multiplier turns a notch into 14 rows — half a
   pane — while every native Windows terminal moves about three. */
export const SCROLL_SENSITIVITY = 3;
export const WINDOWS_SCROLL_SENSITIVITY = 1;

export function wireWheelGuard(
  term: Terminal, host: HTMLElement, signal: AbortSignal,
  options: {
    /* writes a key sequence into the pane's program */
    pageScroll?: () => ((data: string) => void) | undefined;
    /* whether a mouse report actually reaches the program */
    mouseReportsWork: boolean;
  },
): void {
  let forwarding = false;
  let lastPageAt = -Infinity;
  host.addEventListener('wheel', (e: WheelEvent) => {
    if (forwarding || e.ctrlKey || e.deltaY === 0) return;
    /* `sendFocusMode` is the mark a program that owns the screen leaves behind,
       and `mouseTrackingMode` catches the ones that never ask for focus. */
    const ownsViewport = term.modes.sendFocusMode || term.modes.mouseTrackingMode !== 'none';
    if (!options.mouseReportsWork && ownsViewport && !e.shiftKey && !e.altKey) {
      const page = options.pageScroll?.();
      if (page) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const now = performance.now();
        /* one page per 60ms: a burst still scrolls, and a program that redraws
           a whole screen per key keeps up */
        if (now - lastPageAt >= 60) {
          page(e.deltaY < 0 ? '\x1b[5~' : '\x1b[6~');
          lastPageAt = now;
        }
        return;
      }
    }
    if (term.modes.mouseTrackingMode === 'none') return;
    /* xterm drops small pixel deltas before reporting them: forward one line
       for the gesture it would have swallowed */
    if (e.shiftKey || e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || Math.abs(e.deltaY) >= 50) return;
    if (!(e.target instanceof Element)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    forwarding = true;
    try {
      e.target.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY,
        deltaY: Math.sign(e.deltaY), deltaMode: WheelEvent.DOM_DELTA_LINE,
        altKey: e.altKey, shiftKey: e.shiftKey,
      }));
    } finally {
      forwarding = false;
    }
  }, { capture: true, passive: false, signal });
}
