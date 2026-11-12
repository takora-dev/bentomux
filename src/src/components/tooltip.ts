/* Delegated tooltips for existing title attributes, including live/plugin UI.
   Native browser tooltips cannot be styled. Suppress them only while their
   custom counterpart owns the anchor, then restore the original attributes. */
import { h } from '../dom';

const ID = 'bentomux-tooltip';
const DELAY = 400;

export function installTooltips(): () => void {
  const listeners = new AbortController();
  let anchor: HTMLElement | null = null;
  let title = '';
  let bubble: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | null = null;
  let ownsLabel = false;

  function hide(): void {
    clearTimeout(timer);
    timer = undefined;
    observer?.disconnect();
    observer = null;
    bubble?.remove();
    bubble = null;
    if (anchor) {
      if (!anchor.hasAttribute('title')) anchor.setAttribute('title', title);
      anchor.removeAttribute('data-tooltip-anchor');
      const described = (anchor.getAttribute('aria-describedby') || '').split(/\s+/)
        .filter(id => id && id !== ID).join(' ');
      if (described) anchor.setAttribute('aria-describedby', described);
      else anchor.removeAttribute('aria-describedby');
      if (ownsLabel && anchor.getAttribute('aria-label') === title) anchor.removeAttribute('aria-label');
    }
    anchor = null;
    ownsLabel = false;
  }

  function position(): void {
    if (!anchor || !bubble) return;
    const rect = anchor.getBoundingClientRect();
    const box = bubble.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left + (rect.width - box.width) / 2, window.innerWidth - box.width - 8));
    const below = rect.bottom + 8;
    const top = below + box.height <= window.innerHeight - 8 ? below : rect.top - box.height - 8;
    bubble.style.left = Math.round(left) + 'px';
    bubble.style.top = Math.round(Math.max(8, Math.min(top, window.innerHeight - box.height - 8))) + 'px';
  }

  function show(): void {
    if (!anchor?.isConnected) { hide(); return; }
    bubble = h('div', { id: ID, class: 'app-tooltip', role: 'tooltip' }, title);
    document.body.append(bubble);
    const described = anchor.getAttribute('aria-describedby');
    anchor.setAttribute('aria-describedby', [described, ID].filter(Boolean).join(' '));
    position();
  }

  function activate(next: HTMLElement): void {
    if (next === anchor) return;
    hide();
    const text = next.getAttribute('title');
    if (!text?.trim()) return;
    anchor = next;
    title = text;
    // Preserve the accessible name of icon-only controls while title is absent.
    ownsLabel = !next.hasAttribute('aria-label') && !next.hasAttribute('aria-labelledby') && !next.textContent?.trim();
    if (ownsLabel) next.setAttribute('aria-label', title);
    next.setAttribute('data-tooltip-anchor', '');
    next.removeAttribute('title');
    observer = new MutationObserver(() => {
      if (!anchor?.isConnected) { hide(); return; }
      const updated = anchor.getAttribute('title');
      if (updated === null) return;
      if (ownsLabel && anchor.getAttribute('aria-label') === title) anchor.setAttribute('aria-label', updated);
      title = updated;
      anchor.removeAttribute('title');
      if (!title.trim()) { hide(); return; }
      if (bubble) { bubble.textContent = title; position(); }
    });
    observer.observe(next, { attributes: true, attributeFilter: ['title'] });
    // A sidebar render may replace the hovered row without firing pointerout.
    observer.observe(document.body, { childList: true, subtree: true });
    timer = setTimeout(show, DELAY);
  }

  function titled(target: EventTarget | null): HTMLElement | null {
    const node = target instanceof Element ? target.closest('[title],[data-tooltip-anchor]') : null;
    return node instanceof HTMLElement ? node : null;
  }

  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const next = titled(event.target);
    if (next) activate(next);
  }, { signal: listeners.signal });
  document.addEventListener('pointerout', event => {
    if (anchor && !(event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) hide();
  }, { signal: listeners.signal });
  document.addEventListener('focusin', event => {
    const next = titled(event.target);
    if (next?.matches(':focus-visible')) activate(next);
  }, { signal: listeners.signal });
  document.addEventListener('focusout', hide, { signal: listeners.signal });
  document.addEventListener('pointerdown', hide, { signal: listeners.signal });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); }, { signal: listeners.signal });
  document.addEventListener('scroll', hide, { capture: true, signal: listeners.signal });
  window.addEventListener('resize', hide, { signal: listeners.signal });
  window.addEventListener('blur', hide, { signal: listeners.signal });

  return () => { listeners.abort(); hide(); };
}
