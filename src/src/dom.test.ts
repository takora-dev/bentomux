import { describe, it, expect } from 'vitest';
import { h, markup, $, $$ } from './dom';

describe('h()', () => {
  it('builds an element with attributes and text children', () => {
    const el = h('div', { class: 'pane', 'data-tab-id': 't1' }, 'hello');
    expect(el.tagName).toBe('DIV');
    expect(el.className).toBe('pane');
    expect(el.getAttribute('data-tab-id')).toBe('t1');
    expect(el.textContent).toBe('hello');
  });

  it('drops null, undefined and false attributes instead of writing "null"', () => {
    const el = h('input', { type: 'text', disabled: false, value: null, placeholder: undefined });
    expect(el.hasAttribute('disabled')).toBe(false);
    expect(el.hasAttribute('value')).toBe(false);
    expect(el.hasAttribute('placeholder')).toBe(false);
    expect(el.getAttribute('type')).toBe('text');
  });

  it('writes a true attribute as an empty one, the way HTML means it', () => {
    const el = h('button', { disabled: true }, 'x');
    expect(el.hasAttribute('disabled')).toBe(true);
    expect(el.getAttribute('disabled')).toBe('');
  });

  it('assigns dataset keys rather than stringifying them', () => {
    const el = h('div', { dataset: { ts: '17', pane: 'a' } });
    expect(el.dataset.ts).toBe('17');
    expect(el.dataset.pane).toBe('a');
  });

  it('wires an on* key as a listener, not as an attribute', () => {
    let clicks = 0;
    const el = h('button', { onclick: () => { clicks += 1; } }, 'go');
    expect(el.hasAttribute('onclick')).toBe(false);
    el.click();
    expect(clicks).toBe(1);
  });

  it('flattens nested children and skips the holes', () => {
    const el = h('div', null, ['a', null, ['b', false, ['c']]], undefined);
    expect(el.textContent).toBe('abc');
    expect(el.childNodes.length).toBe(3);
  });
});

describe('markup()', () => {
  it('puts trusted markup inside a real element', () => {
    const el = markup('span', { class: 'ic' }, '<svg><path d="M0 0"/></svg>');
    expect(el.className).toBe('ic');
    expect(el.querySelector('svg path')).not.toBeNull();
  });

  it('still applies the attributes it was given', () => {
    const el = markup('div', { 'aria-hidden': 'true' }, '<b>x</b>');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.textContent).toBe('x');
  });
});

describe('$() and $$()', () => {
  it('scopes the query to the root it is given', () => {
    const root = h('div', null,
      h('p', { class: 'row' }, 'first'),
      h('p', { class: 'row' }, 'second'));
    expect($('.row', root).textContent).toBe('first');
    expect($$('.row', root).map(el => el.textContent)).toEqual(['first', 'second']);
  });

  it('returns an empty list rather than null when nothing matches', () => {
    expect($$('.nope', h('div'))).toEqual([]);
  });
});
