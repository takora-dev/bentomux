import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { selectEl } from './select';
import { closeContextMenu } from './menu';
import { currentModal, field, openModal } from './modal';

const options: Array<[string, string]> = [['a', 'Alpha'], ['b', 'Beta'], ['c', 'Charlie']];
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 5));
const key = (target: HTMLElement, value: string): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
};
const row = (index: number): HTMLButtonElement => {
  const element = document.querySelectorAll('[role="option"]')[index];
  if (!(element instanceof HTMLButtonElement)) throw new Error('Missing option ' + index);
  return element;
};

afterEach(() => {
  closeContextMenu();
  currentModal?.close();
  document.body.replaceChildren();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  document.querySelectorAll('[data-select-styles]').forEach(el => el.remove());
});

describe('palette-style select', () => {
  it('uses the palette trigger style and displays the selected value', () => {
    const select = selectEl(options, 'b');
    expect(select.tagName).toBe('BUTTON');
    expect(select.type).toBe('button');
    expect(select.classList.contains('palette-select')).toBe(true);
    expect(select.getAttribute('role')).toBe('combobox');
    expect(select.value).toBe('b');
    expect(select.querySelector('.select-label')?.textContent).toBe('Beta');
    expect(select.querySelector('.palette-caret svg')).not.toBeNull();
  });

  it('defaults to the first option and preserves extra attributes', () => {
    const select = selectEl(options, undefined, { 'aria-label': 'Font', class: 'font-select' });
    expect(select.value).toBe('a');
    expect(select.getAttribute('aria-label')).toBe('Font');
    expect(select.classList.contains('font-select')).toBe(true);
    expect(select.classList.contains('select-input')).toBe(true);
  });

  it('receives initial modal focus before later inputs', async () => {
    const root = document.createElement('div');
    root.id = 'modalRoot';
    document.body.append(root);
    const select = selectEl(options, 'a');
    const input = document.createElement('input');
    openModal({ body: [field('Font', select), input] });
    await flush();
    expect(document.activeElement).toBe(select);
  });

  it('opens the shared popup with a checkmark and accessible selected state', () => {
    const select = selectEl(options, 'b');
    document.body.append(field('Font', select));
    select.click();
    const menu = document.querySelector('[role="listbox"]');
    expect(menu?.classList.contains('ctx-menu')).toBe(true);
    expect(menu?.classList.contains('select-menu')).toBe(true);
    expect(menu?.getAttribute('aria-label')).toBe('Font');
    expect(select.getAttribute('aria-expanded')).toBe('true');
    expect(select.getAttribute('aria-controls')).toBe(menu?.id);
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
    expect(row(1).getAttribute('aria-selected')).toBe('true');
    expect(row(1).querySelector('.ctx-hint')?.textContent).toBe('✓');
    expect(row(1).querySelector('.ctx-hint')?.getAttribute('aria-hidden')).toBe('true');
    expect(row(1).hasAttribute('title')).toBe(false);
    expect(select.getAttribute('aria-activedescendant')).toBe(row(1).id);
  });

  it.each(['', 'dark', 'dark palette-pastel-pixel'].flatMap(theme =>
    [false, true].map(glass => ({ theme, glass })),
  ))('keeps option backgrounds solid (theme: $theme, glass: $glass)', ({ theme, glass }) => {
    const style = document.createElement('style');
    style.dataset.selectStyles = '';
    style.textContent = ['src/theme.css', 'src/styles/20-components.css']
      .map(path => readFileSync(path, 'utf8')).join('\n');
    document.head.append(style);
    document.documentElement.className = `${theme} ${glass ? 'appearance-glass' : ''}`;
    document.documentElement.style.setProperty('--glass-opacity', '0%');
    const select = selectEl(options, 'b');
    const reference = document.createElement('div');
    reference.style.background = 'var(--floating-solid)';
    document.body.append(select, reference);
    select.click();
    const menu = document.querySelector<HTMLElement>('[role="listbox"]');
    if (!menu) throw new Error('Missing options popup');
    const solidBackground = getComputedStyle(reference).backgroundColor;
    expect(solidBackground).not.toBe('');
    expect(solidBackground).not.toBe('transparent');
    expect(getComputedStyle(menu).backgroundColor).toBe(solidBackground);
    // happy-dom skips @supports and color-mix; also check the real glass selectors.
    const css = style.textContent.replace(/\/\*[\s\S]*?\*\//g, '');
    const translucentRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , declarations]) => /background:\s*color-mix\([^;]+transparent/.test(declarations));
    expect(translucentRules.length).toBeGreaterThan(0);
    expect(translucentRules.filter(([, selector]) => menu.matches(selector.trim()))).toHaveLength(0);
  });

  it('updates the label and fires input/change exactly once when picked', () => {
    const select = selectEl(options, 'a');
    const onInput = vi.fn();
    const onChange = vi.fn();
    select.addEventListener('input', onInput);
    select.addEventListener('change', onChange);
    document.body.append(select);
    select.click();
    row(2).click();
    expect(select.value).toBe('c');
    expect(select.querySelector('.select-label')?.textContent).toBe('Charlie');
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(select.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(select);
  });

  it('does not report a change when the current option is picked', () => {
    const select = selectEl(options, 'b');
    const onChange = vi.fn();
    select.addEventListener('change', onChange);
    document.body.append(select);
    select.click();
    row(1).click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('synchronizes programmatic values without emitting a change', () => {
    const select = selectEl(options, 'a');
    const onChange = vi.fn();
    select.addEventListener('change', onChange);
    select.value = 'c';
    expect(select.querySelector('.select-label')?.textContent).toBe('Charlie');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('opens and selects with Arrow keys and Enter', async () => {
    const select = selectEl(options, 'a');
    document.body.append(select);
    key(select, 'ArrowDown');
    await flush();
    key(select, 'ArrowDown');
    expect(row(1).classList.contains('active')).toBe(true);
    key(select, 'Enter');
    expect(select.value).toBe('b');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('supports Home, End, wraparound and typeahead without changing value early', async () => {
    const select = selectEl(options, 'a');
    document.body.append(select);
    select.click();
    await flush();
    key(select, 'End');
    expect(row(2).classList.contains('active')).toBe(true);
    key(select, 'ArrowDown');
    expect(row(0).classList.contains('active')).toBe(true);
    key(select, 'Home');
    key(select, 'c');
    expect(row(2).classList.contains('active')).toBe(true);
    expect(select.value).toBe('a');
    key(select, 'Enter');
    expect(select.value).toBe('c');
  });

  it('closes only the popup on Escape and keeps focus on the trigger', async () => {
    const select = selectEl(options, 'a');
    const parent = document.createElement('div');
    const onEscape = vi.fn();
    parent.addEventListener('keydown', onEscape);
    parent.append(select);
    document.body.append(parent);
    select.click();
    await flush();
    key(select, 'Escape');
    expect(onEscape).not.toHaveBeenCalled();
    expect(select.getAttribute('aria-expanded')).toBe('false');
    expect(select.hasAttribute('aria-activedescendant')).toBe(false);
    expect(document.activeElement).toBe(select);
  });

  it('closes on Tab without trapping keyboard focus', async () => {
    const select = selectEl(options);
    document.body.append(select);
    select.click();
    await flush();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    select.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(select.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on an outside pointerdown and toggles closed on a second click', async () => {
    const select = selectEl(options);
    document.body.append(select);
    select.click();
    await flush();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(select.getAttribute('aria-expanded')).toBe('false');
    select.click();
    select.click();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('owns one popup at a time and resets the previous trigger', () => {
    const first = selectEl(options);
    const second = selectEl(options);
    document.body.append(first, second);
    first.click();
    second.click();
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(second.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('[role="listbox"]')).toHaveLength(1);
  });

  it('does not open disabled or empty controls', () => {
    const disabled = selectEl(options, 'a', { disabled: true });
    const empty = selectEl([]);
    document.body.append(disabled, empty);
    disabled.click();
    key(disabled, 'ArrowDown');
    empty.click();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(empty.value).toBe('');
  });
});
