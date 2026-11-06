/* ---------------- wheel arithmetic ----------------
   Every wheel gesture has to end in one number: which row of the scrollback the
   viewport should show next. xterm computes that itself for the gestures it
   takes (its delta × scrollSensitivity, divided by the cell height it has
   cached), and views/terminal.ts repeats the same sum for the gestures xterm
   drops, so both feel the same. Kept dependency-free so the arithmetic can be
   tested without booting the app. */

/* the multiplier xterm is configured with in createXterm: the value VS Code
   ships for its own xterm panes, and what makes a trackpad's few-pixel deltas
   land on a whole row instead of being eaten by the fractional accumulator */
export const SCROLL_SENSITIVITY = 3;

/* The row a gesture lands on. `cellHeight` is measured from the DOM by the
   caller, because the renderer's cached dimensions are exactly what can be
   wrong in the case the caller exists for. A gesture always moves at least one
   row and never past either end of the scrollback; an unmeasured pane (a cell
   height of 0) stays where it is rather than jumping to a guessed row. */
export function wheelTargetRow(from: number, deltaY: number, cellHeight: number, baseY: number): number {
  if (!(cellHeight > 0)) return from;
  const lines = Math.max(1, Math.round((Math.abs(deltaY) * SCROLL_SENSITIVITY) / cellHeight));
  const next = from + (deltaY < 0 ? -lines : lines);
  return Math.min(Math.max(next, 0), Math.max(baseY, 0));
}