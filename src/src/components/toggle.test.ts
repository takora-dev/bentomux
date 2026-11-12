import { describe, it, expect, vi } from 'vitest';
import { toggleSeg } from './toggle';

/* The segmented toggle is the only boolean control in the app, and its
   contract is narrow: report a change once, never twice, and never report a
   click on the side that is already on. Settings and the agent resource tabs
   both persist on that callback. */
describe('toggleSeg()', () => {
  it('marks the current side as on and the other as off', () => {
    const el = toggleSeg(true, () => {});
    const [off, on] = Array.from(el.querySelectorAll('.seg-opt')) as HTMLElement[];
    expect(on.classList.contains('on')).toBe(true);
    expect(off.classList.contains('on')).toBe(false);
  });

  it('reports a change exactly once when the other side is clicked', () => {
    const onChange = vi.fn();
    const el = toggleSeg(false, onChange);
    const onBtn = el.querySelectorAll('.seg-opt')[1] as HTMLElement;
    onBtn.click();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not report a click on the side that is already active', () => {
    const onChange = vi.fn();
    const el = toggleSeg(true, onChange);
    const onBtn = el.querySelectorAll('.seg-opt')[1] as HTMLElement;
    onBtn.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('repaints itself so the caller does not have to', () => {
    const el = toggleSeg(false, () => {});
    const [off, on] = Array.from(el.querySelectorAll('.seg-opt')) as HTMLElement[];
    on.click();
    expect(on.classList.contains('on')).toBe(true);
    expect(off.classList.contains('on')).toBe(false);
  });

  it('accepts custom labels', () => {
    const el = toggleSeg(true, () => {}, { labels: ['Active', 'Inactive'] });
    expect(el.textContent).toBe('ActiveInactive');
  });

  it('renders as span elements when it has to nest inside a button', () => {
    const el = toggleSeg(true, () => {}, { tag: 'span' });
    const kids = Array.from(el.querySelectorAll('.seg-opt'));
    expect(kids.every(k => k.tagName === 'SPAN')).toBe(true);
    expect(kids.every(k => k.getAttribute('role') === 'button')).toBe(true);
  });

  it('is a real button by default, so it is keyboard reachable', () => {
    const el = toggleSeg(true, () => {});
    const kids = Array.from(el.querySelectorAll('.seg-opt'));
    expect(kids.every(k => k.tagName === 'BUTTON')).toBe(true);
    expect(kids.every(k => k.getAttribute('type') === 'button')).toBe(true);
  });
});
