/* Marketplace list paging and search.
 *
 * Pure on purpose. The interesting cases here are all off-by-one traps — a
 * result set that shrinks under the current page, an exact multiple of the page
 * size, a query that matches nothing — and they are much easier to pin down
 * here than through the modal. */

/** Rows per page. Ten keeps a page readable in the modal. */
export const PAGE_SIZE = 10;

/** The fields a person would plausibly type into a search box. */
export interface Searchable {
  name: string;
  description?: string | null;
  repo: string;
}

/**
 * Case-insensitive match over name, description and owner/repo.
 *
 * Runs over the list already in memory rather than issuing a second GitHub
 * search: the catalog is capped at 30 repos and fetched whole, and a query per
 * keystroke would spend the 10-per-minute search rate limit on a text box the
 * user can type faster than the network can answer.
 */
export function filterPlugins<T extends Searchable>(plugins: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return plugins;
  return plugins.filter((p) =>
    [p.name, p.description ?? '', p.repo].some((f) => f.toLowerCase().includes(q)));
}

export interface Page<T> {
  /** The rows for this page. Empty when the query matched nothing. */
  items: T[];
  /** Zero-based, always within range — an out-of-range request is clamped,
   *  not rejected, so a shrinking result set can never strand the view on a
   *  blank page. */
  page: number;
  /** At least 1, so "Page 1 of 1" reads correctly for an empty catalog. */
  pages: number;
  total: number;
}

export function paginate<T>(items: T[], page: number, pageSize: number = PAGE_SIZE): Page<T> {
  const per = Math.max(1, pageSize);
  const pages = Math.max(1, Math.ceil(items.length / per));
  const safe = Math.min(Math.max(0, page), pages - 1);
  return {
    items: items.slice(safe * per, safe * per + per),
    page: safe,
    pages,
    total: items.length,
  };
}