import { test } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { selectGitFile } from './git-selection.ts';

const paths = ['a', 'b', 'c', 'd'];
test('selects, toggles, and selects a range without losing the anchor', () => {
  let s = selectGitFile(paths, new Set(), null, 'b', false, false);
  s = selectGitFile(paths, s.selected, s.anchor, 'd', true, false);
  deepStrictEqual([...s.selected], ['b', 'd']);
  s = selectGitFile(paths, s.selected, s.anchor, 'b', false, true);
  deepStrictEqual([...s.selected], ['b', 'c', 'd']);
  strictEqual(s.anchor, 'd');
  s = selectGitFile(paths, s.selected, s.anchor, 'c', true, false);
  deepStrictEqual([...s.selected], ['b', 'd']);
  s = selectGitFile(paths, s.selected, s.anchor, 'a', false, false);
  deepStrictEqual([...s.selected], ['a']);
});
test('range with a stale anchor selects only the clicked file', () => {
  const s = selectGitFile(paths, new Set(['a']), 'missing', 'c', false, true);
  deepStrictEqual([...s.selected], ['c']);
});
