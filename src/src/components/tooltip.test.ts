import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from '../dom';
import { installTooltips } from './tooltip';

let stop: () => void;
const hover = (el: HTMLElement, pointerType: string = 'mouse'): void => {
  el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType }));
};
const bubble = (): HTMLElement | null => document.querySelector('[role="tooltip"]');

beforeEach(() => {
  vi.useFakeTimers();
  stop = installTooltips();
});
afterEach(() => {
  stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('glass tooltips', () => {
  it('uses existing titles as text and suppresses the native tooltip only while hovered', () => {
    const title = '<img src=x onerror=alert(1)>';
    const button = h('button', { title }, 'Action');
    document.body.append(button);
    hover(button);
    expect(button.hasAttribute('title')).toBe(false);
    vi.advanceTimersByTime(399);
    expect(bubble()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(bubble()?.textContent).toBe(title);
    expect(bubble()?.querySelector('img')).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBe(bubble()?.id);
    button.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    expect(bubble()).toBeNull();
    expect(button.title).toBe(title);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
  });

  it('supports dynamic controls and keeps one tooltip as the pointer moves', () => {
    const first = h('button', { title: 'First' }, h('span', null, 'Child'));
    const second = h('button', { title: 'Second' }, 'Second');
    document.body.append(first, second);
    hover(first.querySelector('span')!);
    vi.advanceTimersByTime(400);
    expect(bubble()?.textContent).toBe('First');
    hover(second);
    expect(first.title).toBe('First');
    vi.advanceTimersByTime(400);
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(bubble()?.textContent).toBe('Second');
  });

  it('preserves accessible names and existing descriptions', () => {
    const icon = h('button', { title: 'Open settings', 'aria-describedby': 'help' });
    document.body.append(icon);
    hover(icon);
    expect(icon.getAttribute('aria-label')).toBe('Open settings');
    vi.advanceTimersByTime(400);
    expect(icon.getAttribute('aria-describedby')).toBe('help ' + bubble()?.id);
    stop();
    expect(icon.getAttribute('aria-label')).toBeNull();
    expect(icon.getAttribute('aria-describedby')).toBe('help');
    expect(icon.title).toBe('Open settings');
  });

  it('shows on keyboard focus and dismisses without consuming Escape', () => {
    const button = h('button', { title: 'Keyboard hint', 'aria-label': 'Keep this name' });
    document.body.append(button);
    const matches = button.matches.bind(button);
    vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(400);
    expect(bubble()?.textContent).toBe('Keyboard hint');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    button.dispatchEvent(escape);
    expect(bubble()).toBeNull();
    expect(escape.defaultPrevented).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Keep this name');
    expect(button.title).toBe('Keyboard hint');
  });

  it('tracks live title updates without showing duplicate native tooltips', async () => {
    const time = h('time', { title: 'Old time' }, 'now');
    document.body.append(time);
    hover(time);
    vi.advanceTimersByTime(400);
    time.title = 'New time';
    await vi.advanceTimersByTimeAsync(1);
    expect(bubble()?.textContent).toBe('New time');
    expect(time.hasAttribute('title')).toBe(false);
    stop();
    expect(time.title).toBe('New time');
  });

  it('dismisses when a live sidebar render removes the anchor', async () => {
    const button = h('button', { title: 'Temporary row' }, 'Row');
    document.body.append(button);
    hover(button);
    vi.advanceTimersByTime(400);
    button.remove();
    await vi.advanceTimersByTimeAsync(1);
    expect(bubble()).toBeNull();
    expect(button.title).toBe('Temporary row');
  });

  it('ignores touch and cancels pending hints on click, scroll or teardown', () => {
    const button = h('button', { title: 'Hint' }, 'Action');
    document.body.append(button);
    hover(button, 'touch');
    vi.advanceTimersByTime(400);
    expect(bubble()).toBeNull();
    expect(button.title).toBe('Hint');
    hover(button);
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(400);
    expect(bubble()).toBeNull();
    hover(button);
    vi.advanceTimersByTime(400);
    button.dispatchEvent(new Event('scroll'));
    expect(bubble()).toBeNull();
    hover(button);
    stop();
    vi.advanceTimersByTime(400);
    expect(bubble()).toBeNull();
    expect(button.title).toBe('Hint');
    hover(button);
    vi.advanceTimersByTime(400);
    expect(bubble()).toBeNull();
  });
});
