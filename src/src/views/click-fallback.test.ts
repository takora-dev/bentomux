import { describe, it, expect, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { findJumpToLatestCell, pointerCell, wireClickFallback } from './click-fallback';

/* Windows ConPTY never delivers a mouse report to the program it hosts, so a
   click on a program's clickable hint cannot reach it. The way back is the
   key the program binds for that action: Pi's "Jump to latest message" hint
   is bound to ctrl+end.

   These tests pin the mapping, and just as importantly the places where the
   click must be left alone: an ordinary shell click selects text, and that
   has to keep working. */

interface CellSpec {
  chars: string;
  width?: number;
}

/* A fake terminal whose visible rows are given as text. The buffer's line
   getter hands back cells, so the helper finds the hint the same way it does
   in the real thing. */
function makeTerm(rows: string[], options: { focus?: boolean; cols?: number } = {}) {
  const { focus = true, cols = 80 } = options;
  const line = (text: string) => {
    const cells: { getChars: () => string }[] = [];
    for (const char of text) {
      cells.push({ getChars: () => char });
    }
    while (cells.length < cols) {
      cells.push({ getChars: () => ' ' });
    }
    return {
      getCell: (column: number) => cells[column],
      length: cells.length,
    };
  };
  const lines = rows.map(line);
  const term = {
    rows: rows.length,
    cols,
    modes: { sendFocusMode: focus },
    buffer: {
      active: {
        type: 'normal',
        viewportY: 0,
        baseY: 100,
        getLine: (row: number) => lines[row],
      },
    },
  } as unknown as Terminal;
  return term;
}

/* A host whose screen element covers the grid, so a clientX/clientY maps
   onto a cell. */
function makeHost(term: ReturnType<typeof makeTerm>) {
  const host = document.createElement('div');
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  screen.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: term.cols * 10, height: term.rows * 20 }) as DOMRect;
  host.append(screen);
  return { host, screen };
}

describe('findJumpToLatestCell()', () => {
  it('finds the hint and the column it starts at', () => {
    const term = makeTerm([
      'some transcript line',
      '  ↓ Jump to latest message · Ctrl+End ',
    ]);
    const cell = findJumpToLatestCell(term);
    expect(cell).toBeDefined();
    /* the arrow and the spaces take four columns, so the hint starts at 4 */
    expect(cell?.row).toBe(1);
    expect(cell?.column).toBe(4);
    expect(cell?.width).toBe('Jump to latest message'.length);
  });

  it('returns nothing when the hint is not on screen', () => {
    const term = makeTerm(['nothing to see here']);
    expect(findJumpToLatestCell(term)).toBeUndefined();
  });

  it('finds the hint regardless of its case', () => {
    const term = makeTerm(['JUMP TO LATEST MESSAGE']);
    expect(findJumpToLatestCell(term)).toBeDefined();
  });
});

describe('pointerCell()', () => {
  it('maps a pointer position onto the cell under it', () => {
    const term = makeTerm(['a', 'b']);
    const { host } = makeHost(term);
    const cell = pointerCell(term, host, 25, 25);
    expect(cell?.row).toBe(1);
    expect(cell?.column).toBe(2);
  });

  it('returns nothing outside the grid', () => {
    const term = makeTerm(['a', 'b']);
    const { host } = makeHost(term);
    expect(pointerCell(term, host, 500, 500)).toBeUndefined();
  });
});

describe('click fallback', () => {
  function setup(options: {
    rows?: string[];
    focus?: boolean;
    clickReportsWork?: boolean;
  } = {}) {
    const rows = options.rows ?? ['  ↓ Jump to latest message · Ctrl+End '];
    const term = makeTerm(rows, { focus: options.focus });
    const { host, screen } = makeHost(term);
    const send = vi.fn();
    wireClickFallback(term, host, new AbortController().signal, {
      clickReportsWork: options.clickReportsWork ?? false,
      sendKey: () => send,
    });
    return { screen, send };
  }

  it('sends ctrl+end when the hint is clicked', () => {
    const { screen, send } = setup();
    /* the hint starts at column 4, and the cell is 10 wide */
    screen.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 45, clientY: 5 }),
    );
    expect(send).toHaveBeenCalledWith('\x1b[1;5F');
  });

  it('leaves a click elsewhere alone, so text selection still works', () => {
    const { screen, send } = setup({ rows: ['a plain transcript line'] });
    screen.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves the click alone where mouse reports do arrive', () => {
    const { screen, send } = setup({ clickReportsWork: true });
    screen.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 45, clientY: 5 }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves the click alone when no program owns the viewport', () => {
    const { screen, send } = setup({ focus: false });
    screen.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 45, clientY: 5 }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores a click with another mouse button', () => {
    const { screen, send } = setup();
    screen.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2, clientX: 45, clientY: 5 }),
    );
    expect(send).not.toHaveBeenCalled();
  });
});
