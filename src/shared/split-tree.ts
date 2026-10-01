/* ---------------- pane layout tree for split terminal tabs ----------------
   A tab holds a binary tree of shells: leaves are pty ids, internal nodes are
   split axes ('v' = side by side, 'h' = stacked). Pure data + operations,
   shared by main (persistence) and the renderer (which mirrors every
   mutation locally so both sides grow identical trees). */

export type PaneNode =
  | { kind: 'leaf'; id: string }
  | { kind: 'split'; key: string; dir: 'v' | 'h'; first: PaneNode; second: PaneNode };

export type SplitNode = Extract<PaneNode, { kind: 'split' }>;

export function leafNode(id: string): PaneNode {
  return { kind: 'leaf', id };
}

let keySeq = 0;
/* caller supplies keys when splitting so main and renderer name the new
   node identically without an extra round-trip */
export function newNodeKey(): string {
  return 's-' + Date.now().toString(36) + '-' + (keySeq++).toString(36) + Math.random().toString(36).slice(2, 5);
}

export function leafIds(t: PaneNode): string[] {
  return t.kind === 'leaf' ? [t.id] : [...leafIds(t.first), ...leafIds(t.second)];
}

export function firstLeafId(t: PaneNode): string {
  return t.kind === 'leaf' ? t.id : firstLeafId(t.first);
}

export function treeHasLeaf(t: PaneNode, id: string): boolean {
  return t.kind === 'leaf' ? t.id === id : treeHasLeaf(t.first, id) || treeHasLeaf(t.second, id);
}

export function treeHasKey(t: PaneNode, key: string): boolean {
  return t.kind === 'split' && (t.key === key || treeHasKey(t.first, key) || treeHasKey(t.second, key));
}

/* divide the pane `paneId` in two; no-op on non-matching leaves.
   `before` puts the new pane first (up/left), default appends after (right/down) */
export function splitLeaf(t: PaneNode, paneId: string, dir: 'v' | 'h', newId: string, key: string, before = false): PaneNode {
  if (t.kind === 'leaf') {
    if (t.id !== paneId) return t;
    const oldLeaf = t;
    const newLeaf = leafNode(newId);
    return { kind: 'split', key, dir, first: before ? newLeaf : oldLeaf, second: before ? oldLeaf : newLeaf };
  }
  return { ...t, first: splitLeaf(t.first, paneId, dir, newId, key, before), second: splitLeaf(t.second, paneId, dir, newId, key, before) };
}

/* remove a leaf; the enclosing axis collapses to its surviving branch.
   Returns null when the last leaf goes away. */
export function removeLeaf(t: PaneNode, paneId: string): PaneNode | null {
  if (t.kind === 'leaf') return t.id === paneId ? null : t;
  const first = removeLeaf(t.first, paneId);
  if (!first) return t.second;
  const second = removeLeaf(t.second, paneId);
  if (!second) return first;
  return first === t.first && second === t.second ? t : { ...t, first, second };
}

export function setSplitDir(t: PaneNode, key: string, dir: 'v' | 'h'): PaneNode {
  if (t.kind === 'leaf') return t;
  const self: SplitNode = t.key === key ? { ...t, dir } : t;
  return { ...self, first: setSplitDir(self.first, key, dir), second: setSplitDir(self.second, key, dir) };
}

/* fresh pty ids after a relaunch: rewrite leaves through the map */
export function remapLeaves(t: PaneNode, map: Map<string, string>): PaneNode {
  if (t.kind === 'leaf') return leafNode(map.get(t.id) || t.id);
  return { kind: 'split', key: t.key, dir: t.dir, first: remapLeaves(t.first, map), second: remapLeaves(t.second, map) };
}

/* one-off migration for tabs persisted before layout trees existed */
export function treeFromLegacy(ids: string[], dir?: 'v' | 'h'): PaneNode | undefined {
  if (!ids.length) return undefined;
  let t = leafNode(ids[0]);
  for (const id of ids.slice(1)) {
    const node: SplitNode = { kind: 'split', key: newNodeKey(), dir: dir === 'h' ? 'h' : 'v', first: t, second: leafNode(id) };
    t = node;
  }
  return t;
}
