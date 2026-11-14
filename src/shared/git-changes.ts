import type { GitStatusEntry } from './types';

export type GitChangeGroup = 'staged' | 'unstaged';
export interface GitChangeRow { group: GitChangeGroup; entry: GitStatusEntry; key: string }

/* A file with both index and worktree changes is an independent row in each. */
export function gitChangeRows(entries: GitStatusEntry[]): GitChangeRow[] {
  const staged: GitChangeRow[] = [];
  const unstaged: GitChangeRow[] = [];
  for (const entry of entries) {
    const conflict = entry.status.includes('U') || ['AA', 'DD'].includes(entry.status);
    if (!conflict && entry.indexStatus !== ' ' && entry.indexStatus !== '?') {
      staged.push({ group: 'staged', entry, key: 'staged:' + entry.path });
    }
    if (conflict || entry.status === '??' || entry.workTreeStatus !== ' ') {
      unstaged.push({ group: 'unstaged', entry, key: 'unstaged:' + entry.path });
    }
  }
  return [...staged, ...unstaged];
}

export function gitActionTargets(rows: GitChangeRow[], group: GitChangeGroup): { entries: GitStatusEntry[]; unsupported: number } {
  const candidates = rows.filter(row => row.group === group);
  const supported = candidates.filter(({ entry }) => !/[RCU]/.test(entry.status) && !['AA', 'DD'].includes(entry.status));
  return { entries: supported.map(row => row.entry), unsupported: candidates.length - supported.length };
}

export function hasStagedChanges(entries: GitStatusEntry[]): boolean {
  return gitChangeRows(entries).some(row => row.group === 'staged');
}
