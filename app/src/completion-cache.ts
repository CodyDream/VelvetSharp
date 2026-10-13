/** VelvetSharp Phase 12 — prefix-chain completion cache (pure, unit-testable).
 *
 *  THE OLD BUG (user's other agent spotted it from reading the code — correct):
 *  the Phase 10 cache stored one entry per file and looked it up with
 *  `cached.prefix === prefix`, while its own comment said it existed "so the
 *  NEXT keystroke (a longer prefix, usually) already merges the fresh, richer
 *  answer". A longer prefix NEVER equals the cached prefix, so the cache could
 *  not do the one job it was documented to do.
 *
 *  THE FIX: store a small ring of recent (prefix → items) entries per file and
 *  look up the LONGEST cached prefix that is a prefix of the current one — a
 *  cache computed for "tr" is a valid superset for "tri", so we filter it by
 *  the current prefix and merge it into the floor. Empty-string entries act as
 *  a remembered "universe" for the just-typed-first-letter case.
 */

export interface CacheItem {
  label: string;
  filterText?: string;
}

export interface CacheEntry {
  prefix: string;
  items: CacheItem[];
}

export type CacheStore = Map<string, CacheEntry[]>;

export function newCacheStore(): CacheStore {
  return new Map();
}

/** longest cached prefix that is a prefix of `prefix`, filtered to it */
export function cacheLookup(store: CacheStore, path: string, prefix: string): CacheItem[] {
  const list = store.get(path);
  if (!list || !list.length) return [];
  const pl = prefix.toLowerCase();
  let best: CacheEntry | null = null;
  for (const e of list) {
    if (!pl.startsWith(e.prefix.toLowerCase())) continue; // "" matches everything (universe)
    if (!best || e.prefix.length > best.prefix.length) best = e;
  }
  if (!best) return [];
  return best.items.filter((it) => String(it.filterText ?? it.label ?? "").toLowerCase().startsWith(pl));
}

/** newest-first ring per path (max 8), same-prefix entries replaced */
export function cacheStore(store: CacheStore, path: string, prefix: string, items: CacheItem[]): void {
  if (!items.length) return;
  const list = store.get(path) ?? [];
  const rest = list.filter((e) => e.prefix !== prefix);
  rest.unshift({ prefix, items });
  store.set(path, rest.slice(0, 8));
}
