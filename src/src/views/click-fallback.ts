import type { Terminal } from '@xterm/xterm';

/* ---------------- click fallback ----------------
   Windows ConPTY never delivers a mouse report to the program it hosts: the
   console host turns VT mouse input into console mouse events, and a program
   reading its input as bytes never sees those. A program that offers a
   clickable control therefore cannot be clicked, no matter what the
   terminal sends.

   The way back is the key the program binds for the same action. Pi's
   fullscreen transcript shows a "Jump to latest message" hint while the
   transcript is scrolled up, and binds ctrl+end for it (tui.altScreen.bottom),
   so a click on that hint sends that key instead of a report that would be
   dropped.

   Only the hint is clicked this way. Every other click is left alone, so
   text selection in an ordinary shell keeps working. */

/* the hint, without the arrow Pi draws in front of it */
const JUMP_TO_LATEST = 'jump to latest message';

/* the key Pi binds for that hint: ctrl+end, in the bytes xterm itself sends */
const CTRL_END = '\x1b[1;5F';

interface Cell {
  row: number;
  column: number;
  width: number;
}

/* The cell the hint occupies, in the visible rows. A cell is one column, so
   the hint is found cell by cell: the arrow in front of it is one character
   and one cell, but a wide glyph would make a string index and a cell index
   disagree. */
export function findJumpToLatestCell(term: Terminal): Cell | undefined {
  const buffer = term.buffer.active;
  const needle = JUMP_TO_LATEST;
  for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const chars: string[] = [];
    const cellOf: number[] = [];
    for (let column = 0; column < term.cols; column++) {
      const cell = line.getCell(column);
      const text = cell ? cell.getChars() : ' ';
      for (const char of text) {
        chars.push(char);
        cellOf.push(column);
      }
    }
    const at = chars.join('').toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const first = cellOf[at];
    const last = cellOf[at + needle.length - 1];
    return { row, column: first, width: last - first + 1 };
  }
  return undefined;
}

/* The cell a pointer is over, from the DOM: the screen element shows the
   viewport, so its box is the grid the cell rows and columns are cut from. */
export function pointerCell(term: Terminal, host: HTMLElement, clientX: number, clientY: number): Cell | undefined {
  const screen = host.querySelector('.xterm-screen');
  if (!screen) return undefined;
  const rect = screen.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0) || term.cols <= 0 || term.rows <= 0) return undefined;
  const column = Math.floor((clientX - rect.left) / (rect.width / term.cols));
  const row = Math.floor((clientY - rect.top) / (rect.height / term.rows));
  if (column < 0 || column >= term.cols || row < 0 || row >= term.rows) return undefined;
  return { row: term.buffer.active.viewportY + row, column, width: 1 };
}

/* Sends ctrl+end when the click lands on Pi's "jump to latest message"
   hint, so the click does what the program would have done with it. */
export function wireClickFallback(
  term: Terminal, host: HTMLElement, signal: AbortSignal,
  options: {
    /* whether a mouse report actually reaches the program */
    clickReportsWork: boolean;
    /* writes a key sequence into the pane's program */
    sendKey?: () => ((data: string) => void) | undefined;
  },
): void {
  host.addEventListener('mousedown', (e: MouseEvent) => {
    if (options.clickReportsWork || e.button !== 0) return;
    /* only a program that owns the viewport: in an ordinary shell a click
       selects text, and that must keep working */
    if (!term.modes.sendFocusMode) return;
    const send = options.sendKey?.();
    if (!send) return;
    const hint = findJumpToLatestCell(term);
    if (!hint) return;
    const pointer = pointerCell(term, host, e.clientX, e.clientY);
    if (!pointer) return;
    if (pointer.row !== hint.row) return;
    if (pointer.column < hint.column || pointer.column >= hint.column + hint.width) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    send(CTRL_END);
  }, { capture: true, signal });
}
