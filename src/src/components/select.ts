/* ---------------- select (palette-style popup) ---------------- */

import { h, markup } from '../dom';
import { IC } from '../icons';
import { closeContextMenu, contextMenuAnchoredTo, openContextMenu } from './menu';

let nextId = 0;

/* A button-backed select keeps the value/change contract used by callers,
   while its options use the same in-app popup as the palette picker. */
export function selectEl(opts: Array<[string, string]>, val?: string, attrs?: Record<string, unknown>): HTMLButtonElement {
  const label = h('span', { class: 'palette-name select-label' });
  const button = h('button', {
    ...(attrs || {}),
    class: 'select-input palette-select' + (attrs?.class ? ' ' + String(attrs.class) : ''),
    type: 'button', role: 'combobox', 'aria-haspopup': 'listbox', 'aria-expanded': 'false',
  }, label, markup('span', { class: 'ic palette-caret', 'aria-hidden': 'true' }, IC.chev)) as HTMLButtonElement;
  const menuId = `select-options-${++nextId}`;
  const labels = new Map(opts);
  let value = '';
  Object.defineProperty(button, 'value', {
    get: () => value,
    set: (next: string) => {
      value = labels.has(next) ? next : '';
      label.textContent = labels.get(value) ?? '';
      button.setAttribute('value', value);
    },
  });
  button.value = val ?? opts[0]?.[0] ?? '';

  const open = (): void => {
    if (button.disabled || !opts.length) return;
    if (contextMenuAnchoredTo(button)) { closeContextMenu(); return; }
    const rect = button.getBoundingClientRect();
    button.focus();
    openContextMenu(rect.left, rect.bottom + 4, opts.map(([optionValue, text]) => ({
      label: text,
      hint: optionValue === button.value ? '✓' : undefined,
      action: () => {
        if (button.disabled || !button.isConnected) return;
        button.focus();
        if (button.value === optionValue) return;
        button.value = optionValue;
        button.dispatchEvent(new Event('input', { bubbles: true }));
        button.dispatchEvent(new Event('change', { bubbles: true }));
      },
    })), button, {
      role: 'listbox', id: menuId,
      selectedIndex: opts.findIndex(([optionValue]) => optionValue === button.value),
      minWidth: rect.width,
      onClose: () => {
        button.setAttribute('aria-expanded', 'false');
        button.removeAttribute('aria-controls');
        button.removeAttribute('aria-activedescendant');
      },
    });
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', menuId);
  };
  button.addEventListener('click', open);
  button.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    open();
  });
  return button;
}
