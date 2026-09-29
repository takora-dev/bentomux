/* runnable check for the custom-palette color parser (node --test) */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isColor, toHex } from './color.ts';

test('accepts hex and rgb, rejects anything CSS would not resolve', () => {
  for (const ok of ['#fff', '#1a2b3c', '  #1A2B3C ', 'rgb(1,2,3)', 'rgb(1 2 3)']) {
    assert.equal(isColor(ok), true, ok);
  }
  for (const bad of ['', '#ff', 'red', 'rgb(1,2)', 'url(x)', '#fff;background:red', 'rgb(1,2,3))']) {
    assert.equal(isColor(bad), false, bad);
  }
});

test('normalizes to #rrggbb for the native color picker', () => {
  assert.equal(toHex('#fff'), 'ffffff');
  assert.equal(toHex('#1A2B3C'), '1a2b3c');
  assert.equal(toHex('rgb(88, 166, 255)'), '58a6ff');
  assert.equal(toHex('rgb(88 166 255)'), '58a6ff');
  assert.equal(toHex('rgb(999,0,7)'), 'ff0007', 'channels clamp at 255');
  assert.equal(toHex('nope'), '');
});
