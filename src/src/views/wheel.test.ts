import { describe, it, expect, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { wireWheelGuard } from './wheel';

/* The guard exists for the two gestures xterm gets wrong: a Windows program
   that never receives its mouse report, and a trackpad flick too small for
   xterm to report. Every other gesture must reach xterm untouched — a guard
   that rewrites a normal scroll moves by its own arithmetic instead of
   xterm's, which is what made one notch a double scroll. */

describe('wheel routing', () => {
  interface Setup {
    tracking?: 'none' | 'any';
    /* focus reporting is what such a program leaves behind on Windows */
    focus?: boolean;
    mouseReportsWork?: boolean;
    pageScroll?: () => ((data: string) => void) | undefined;
  }

  function setup(options: Setup = {}) {
    const { tracking = 'none', focus = false, mouseReportsWork = true } = options;
    const host = document.createElement('div');
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    screen.getBoundingClientRect = () => ({ height: 150 } as DOMRect);
    host.append(screen);
    const term = {
      rows: 10,
      modes: { mouseTrackingMode: tracking, sendFocusMode: focus },
      buffer: { active: { type: 'normal', baseY: 100, viewportY: 50 } },
    } as unknown as Terminal;
    wireWheelGuard(term, host, new AbortController().signal, {
      pageScroll: options.pageScroll,
      mouseReportsWork,
    });
    return { screen };
  }

  /* the case from the field: one notch moved 14 rows on Windows because the
     guard recomputed it, where xterm's own accumulator would have moved five */
  it('leaves a scrollback gesture to xterm', () => {
    const { screen } = setup();
    const reached = vi.fn();
    screen.addEventListener('wheel', reached);
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });
    screen.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(reached).toHaveBeenCalledOnce();
  });

  it('forwards a flick too small for xterm to report as one line', () => {
    const { screen } = setup({ tracking: 'any' });
    const received: WheelEvent[] = [];
    screen.addEventListener('wheel', e => received.push(e));
    screen.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -2 }));
    expect(received).toHaveLength(1);
    expect(received[0].deltaY).toBe(-1);
    expect(received[0].deltaMode).toBe(WheelEvent.DOM_DELTA_LINE);
  });

  it('leaves a large tracked wheel event to xterm', () => {
    const { screen } = setup({ tracking: 'any' });
    const received = vi.fn();
    screen.addEventListener('wheel', received);
    screen.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }));
    expect(received).toHaveBeenCalledOnce();
  });

  /* Windows ConPTY drops the mouse reports, so the gesture has to become the
     page keys the program scrolls with. Each direction gets its own guard: the
     60ms throttle is not what this test is about, and one shared clock would
     make the second gesture's fate depend on how fast the loop runs. */
  it('sends a page key for each wheel direction when mouse reports do not arrive', () => {
    for (const [deltaY, key] of [[-20, '\x1b[5~'], [120, '\x1b[6~']] as const) {
      const send = vi.fn();
      const { screen } = setup({ focus: true, mouseReportsWork: false, pageScroll: () => send });
      const reached = vi.fn();
      screen.addEventListener('wheel', reached);
      screen.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY }));
      expect(send.mock.calls).toEqual([[key]]);
      expect(reached).not.toHaveBeenCalled();
    }
  });

  it('sends page keys for a program that tracks the mouse but never asks for focus', () => {
    const send = vi.fn();
    const { screen } = setup({ tracking: 'any', mouseReportsWork: false, pageScroll: () => send });
    screen.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 }));
    expect(send.mock.calls).toEqual([['\x1b[5~']]);
  });

  it('throttles a burst into one page and opens again after the window', () => {
    const send = vi.fn();
    const { screen } = setup({ focus: true, mouseReportsWork: false, pageScroll: () => send });
    /* fake timers own `performance.now`, not a spy on it: a spy that does not
       take effect leaves the assertions below measuring how fast the machine
       dispatches five events instead of what the throttle does */
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const frozen = performance.now();
      vi.advanceTimersByTime(1000);
      expect(performance.now() - frozen).toBe(1000);
      const wheel = () =>
        screen.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -20 }));
      for (let i = 0; i < 5; i++) wheel();
      expect(send).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60);
      wheel();
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send page keys when mouse reports work, for an untouched pane, or for a modified wheel', () => {
    const send = vi.fn();
    for (const opts of [
      { focus: true, mouseReportsWork: true },
      { focus: false, mouseReportsWork: false },
    ]) {
      const { screen } = setup({ ...opts, pageScroll: () => send });
      screen.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }));
    }
    const { screen } = setup({ focus: true, mouseReportsWork: false, pageScroll: () => send });
    for (const key of ['altKey', 'shiftKey'] as const) {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
      Object.defineProperty(event, key, { value: true });
      screen.dispatchEvent(event);
    }
    expect(send).not.toHaveBeenCalled();
  });
});
