import { describe, it, expect } from 'vitest';
import { SCROLL_SENSITIVITY, wheelTargetRow } from './wheel';

/* A wheel gesture that lands on the wrong row is invisible in a type check and
   obvious to the user: the pane scrolls too far, not at all, or walks off the
   end of the scrollback. These tests pin the arithmetic. */

const CELL = 15;

describe('wheelTargetRow()', () => {
  it('moves up by the configured sensitivity over the cell height', () => {
    /* 120px of delta at a 15px cell is 8 rows before the sensitivity, 24 after */
    expect(wheelTargetRow(100, -120, CELL, 500)).toBe(100 - (120 * SCROLL_SENSITIVITY) / CELL);
  });

  it('moves down by the same distance', () => {
    const up = wheelTargetRow(100, -120, CELL, 500);
    expect(wheelTargetRow(up, 120, CELL, 500)).toBe(100);
  });

  it('always moves at least one row, so a gentle trackpad flick is never eaten', () => {
    expect(wheelTargetRow(100, -1, CELL, 500)).toBe(99);
    expect(wheelTargetRow(100, 1, CELL, 500)).toBe(101);
  });

  it('stops at the top and at the bottom of the scrollback', () => {
    expect(wheelTargetRow(2, -120, CELL, 500)).toBe(0);
    expect(wheelTargetRow(499, 120, CELL, 500)).toBe(500);
    expect(wheelTargetRow(500, 120, CELL, 500)).toBe(500);
  });

  it('stays put when the cell height has not been measured yet', () => {
    expect(wheelTargetRow(37, -120, 0, 500)).toBe(37);
    expect(wheelTargetRow(37, -120, Number.NaN, 500)).toBe(37);
  });

  it('stays put when there is no scrollback', () => {
    expect(wheelTargetRow(0, -120, CELL, 0)).toBe(0);
  });
});