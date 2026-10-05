/* ---------------- modal (one modal, every use) ---------------- */

import { $, h, type Kid } from '../dom';

export interface Modal {
  close(): void;
  overlay: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
}

export let currentModal: Modal | null = null;

export function openModal(opts: { title?: string; body?: HTMLElement | Kid[]; footer?: HTMLElement; onClose?: () => void; size?: 'wide' }): Modal {
  const overlay = h('div', { class: 'overlay' });
  /* `wide` for browsing surfaces — a catalog list or a settings form needs
     room a 440px confirm dialog cannot give. The default stays narrow. */
  const dialog = h('div', { class: 'dialog' + (opts.size === 'wide' ? ' dialog-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || '' });
  if (opts.title) dialog.append(h('div', { class: 'dialog-h' }, opts.title));
  const bodyEl = h('div', { class: 'dialog-b' });
  if (opts.body) {
    const kids = (Array.isArray(opts.body) ? opts.body : [opts.body]).flat(9)
      .filter((k): k is Node | string => k != null && k !== false);
    bodyEl.append(...(kids as unknown as (Node | string)[]));
  }
  const footEl = h('div', { class: 'dialog-f' });
  if (opts.footer) footEl.append(opts.footer);
  dialog.append(bodyEl, footEl);
  overlay.append(dialog);
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) close(); });
  $('#modalRoot').append(overlay);

  function close(): void {
    if (currentModal && currentModal.overlay === overlay) currentModal = null;
    overlay.remove();
    if (opts.onClose) opts.onClose();
  }
  currentModal = { close, overlay, body: bodyEl, foot: footEl };

  const first = bodyEl.querySelector('input,textarea,select') || footEl.querySelector('.primary,.btn');
  if (first) setTimeout(() => (first as HTMLElement).focus(), 0);
  return { close, overlay, body: bodyEl, foot: footEl };
}

export function field(label: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'field' }, h('label', {}, label), control);
}
