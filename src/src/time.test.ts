import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rel, abs, dshort, clock, HOUR, DAY } from './time';

/* `rel` is what the sidebar and the tab strip show for every timestamp, so an
   off-by-one at a boundary is a visible bug ("60m" instead of "1h"). */
describe('rel()', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);

  /* rel() reads Date.now(), so the clock has to be pinned for a boundary
     assertion to mean anything */
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); });

  const at = (agoMs: number): string => rel(now - agoMs);

  it('calls anything under a minute "now"', () => {
    expect(at(0)).toBe('now');
    expect(at(59_999)).toBe('now');
  });

  it('switches to minutes at exactly one minute', () => {
    expect(at(60_000)).toBe('1m');
    expect(at(60_000 * 59)).toBe('59m');
  });

  it('switches to hours at exactly one hour, never showing "60m"', () => {
    expect(at(HOUR - 1)).toBe('59m');
    expect(at(HOUR)).toBe('1h');
    expect(at(HOUR * 23)).toBe('23h');
  });

  it('switches to days at exactly one day, never showing "24h"', () => {
    expect(at(DAY - 1)).toBe('23h');
    expect(at(DAY)).toBe('1d');
    expect(at(DAY * 13)).toBe('13d');
  });

  it('switches to weeks at fourteen days', () => {
    expect(at(DAY * 14)).toBe('2w');
    expect(at(DAY * 69)).toBe('9w');
  });

  it('falls back to a calendar date past ten weeks', () => {
    /* the exact string is locale-dependent; the point is that it stopped
       being a relative count */
    const out = at(DAY * 70);
    expect(out).not.toMatch(/^[0-9]+[mhdw]$/);
    expect(out.length).toBeGreaterThan(2);
  });
});

describe('absolute formatters', () => {
  const ts = Date.UTC(2026, 2, 4, 9, 7, 0);

  it('abs() keeps both the date and the time', () => {
    const out = abs(ts);
    expect(out).toContain('2026');
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it('dshort() is a date with no time attached', () => {
    expect(dshort(ts)).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('clock() is a time with no date attached', () => {
    expect(clock(ts)).toMatch(/\d{1,2}:\d{2}/);
    expect(clock(ts)).not.toContain('2026');
  });
});
