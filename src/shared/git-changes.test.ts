import { test } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { gitActionTargets, gitChangeRows, hasStagedChanges } from './git-changes.ts';
import type { GitStatusEntry } from './types.ts';

function entry(path: string, status: string): GitStatusEntry {
  return { path, status, indexStatus: status[0], workTreeStatus: status[1] };
}
test('groups changes independently while keeping conflicts in unstaged', () => {
  const rows = gitChangeRows([entry('both', 'MM'), entry('new', '??'), entry('deleted', 'D '), entry('conflict', 'AA')]);
  deepStrictEqual(rows.map(row => row.key), [
    'staged:both', 'staged:deleted', 'unstaged:both', 'unstaged:new', 'unstaged:conflict',
  ]);
});

test('bulk targets separate staged and unstaged, and count unsupported entries', () => {
  const rows = gitChangeRows([entry('both', 'MM'), entry('new', '??'), entry('rename', 'R '), entry('conflict', 'AA')]);
  const staged = gitActionTargets(rows, 'staged');
  const unstaged = gitActionTargets(rows, 'unstaged');
  deepStrictEqual(staged.entries.map(item => item.path), ['both']);
  strictEqual(staged.unsupported, 1);
  deepStrictEqual(unstaged.entries.map(item => item.path), ['both', 'new']);
  strictEqual(unstaged.unsupported, 1);
});

test('only resolved staged entries enable committing', () => {
  strictEqual(hasStagedChanges([]), false);
  strictEqual(hasStagedChanges([entry('new', '??'), entry('edit', ' M'), entry('conflict', 'AA')]), false);
  strictEqual(hasStagedChanges([entry('file', 'M ')]), true);
  strictEqual(hasStagedChanges([entry('file', 'D ')]), true);
});
