/* runnable check for marketplace paging and search (node --test) */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterPlugins, paginate, PAGE_SIZE, type Searchable } from './marketplace.ts';

function catalog(n: number): Searchable[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `plugin ${i + 1}`,
    description: i % 2 ? 'a terminal thing' : null,
    repo: `owner/${i + 1}`,
  }));
}

test('a page holds ten and pages are numbered from one', () => {
  const page = paginate(catalog(25), 0);
  assert.equal(page.items.length, PAGE_SIZE);
  assert.equal(page.page, 0);
  assert.equal(page.pages, 3);
  assert.equal(page.total, 25);
});

test('the last page is short rather than padded', () => {
  const page = paginate(catalog(25), 2);
  assert.equal(page.items.length, 5, '25 over 3 pages leaves 5 on the last');
  assert.equal(page.items[0].name, 'plugin 21');
});

test('an exact multiple of the page size gets no empty trailing page', () => {
  const page = paginate(catalog(30), 0);
  assert.equal(page.pages, 3, '30 rows is 3 full pages, not 3 plus a blank');
  const last = paginate(catalog(30), 2);
  assert.equal(last.items.length, PAGE_SIZE);
});

test('an out-of-range page is clamped, never an empty screen', () => {
  /* the case that strands a user: they sit on page 3, then type a query that
     leaves 4 matches, and the view must not go blank */
  const page = paginate(catalog(4), 7);
  assert.equal(page.page, 0);
  assert.equal(page.pages, 1);
  assert.equal(page.items.length, 4);

  const empty = paginate([], 5);
  assert.equal(empty.page, 0);
  assert.equal(empty.pages, 1);
  assert.deepEqual(empty.items, [], 'an empty catalog reads Page 1 of 1');
});

test('a negative page clamps to the first', () => {
  assert.equal(paginate(catalog(25), -3).page, 0);
});

test('an empty search keeps every row', () => {
  const all = catalog(5);
  for (const q of ['', '   ']) assert.equal(filterPlugins(all, q).length, 5);
});

test('search covers name, description and owner/repo, case-insensitively', () => {
  const rows = catalog(6);
  assert.equal(filterPlugins(rows, 'PLUGIN 3').length, 1);
  assert.equal(filterPlugins(rows, 'terminal').length, 3, 'odd rows have a description');
  assert.equal(filterPlugins(rows, 'owner/5').length, 1);
});

test('a query that matches nothing returns nothing, not everything', () => {
  assert.deepEqual(filterPlugins(catalog(6), 'nothing-here'), []);
});

test('search then page: filtering happens before slicing', () => {
  const found = filterPlugins(catalog(25), 'terminal');
  const page = paginate(found, 0);
  assert.equal(page.total, 12, 'odd rows only');
  assert.equal(page.pages, 2);
  assert.equal(page.items.length, 10);
});