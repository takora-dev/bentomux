/* Changes selection follows the platform's Ctrl/Cmd toggle and Shift range. */
export function selectGitFile(
  paths: string[], selected: Set<string>, anchor: string | null, path: string,
  toggle: boolean, range: boolean,
): { selected: Set<string>; anchor: string } {
  const index = paths.indexOf(path);
  const anchorIndex = anchor === null ? -1 : paths.indexOf(anchor);
  if (range && index >= 0 && anchorIndex >= 0) {
    const next = toggle ? new Set(selected) : new Set<string>();
    for (const item of paths.slice(Math.min(index, anchorIndex), Math.max(index, anchorIndex) + 1)) next.add(item);
    return { selected: next, anchor: anchor! };
  }
  if (toggle) {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path); else next.add(path);
    return { selected: next, anchor: path };
  }
  return { selected: new Set([path]), anchor: path };
}
