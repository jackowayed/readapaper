/**
 * Proactive offline cache warming — fetch the library + every article
 * document through the service worker so unopened articles stay readable
 * offline. The service worker caches these responses on the way through
 * (see public/sw.js); this module just triggers the requests and records
 * what was warmed.
 */

export type OfflineReady = {
  count: number;
  at: string;
};

export type WarmStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const OFFLINE_READY_KEY = "readapaper:offline-ready";
/**
 * Same-tab notification fired (on `window`) after a warm persists its count.
 * `storage` events only fire in *other* tabs, so components that need to
 * reflect a warm triggered elsewhere on the same page (e.g. a save warming
 * the cache while the library button stays mounted through
 * `router.refresh()`) listen for this instead.
 */
export const OFFLINE_READY_EVENT = "readapaper:offline-ready-change";

function defaultStorage(): WarmStorage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // SSR / private mode: no storage
  }
  return null;
}

export function readOfflineReady(
  storage: WarmStorage | null = defaultStorage()
): OfflineReady | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(OFFLINE_READY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as OfflineReady).count === "number" &&
      typeof (parsed as OfflineReady).at === "string"
    ) {
      return parsed as OfflineReady;
    }
    return null;
  } catch {
    return null;
  }
}

type WarmFetcher = (url: string) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

function defaultFetcher(url: string) {
  return fetch(url);
}

/**
 * Warm the offline cache: library page first, then every article document.
 * Failures are tolerated per-URL (offline mid-warm keeps what succeeded).
 * Returns { warmed, total, articles } and persists the article count for the UI.
 * (`warmed` includes the library page; the UI only reports `articles` —
 * nobody cares that a chrome page is cached.)
 */
export async function warmOfflineCache(
  fetcher: WarmFetcher = defaultFetcher,
  storage: WarmStorage | null = defaultStorage()
): Promise<{ warmed: number; total: number; articles: number }> {
  let total = 0;
  let warmed = 0;
  let articles = 0;
  // Fallback when this warm can't reach the article list (offline mid-warm,
  // transient failure): report the last good count and leave storage
  // untouched — a failed warm must not pretend nothing is cached.
  const fallback = readOfflineReady(storage)?.count ?? 0;
  try {
    // Library page first so `/` itself renders offline.
    const home = await fetcher("/");
    if (home.ok) warmed += 1;

    // Active articles only: archived items stay out of the offline cache.
    const listRes = await fetcher("/api/articles?archived=0");
    if (!listRes.ok) return { warmed, total: fallback, articles: fallback };
    const list: unknown = await listRes.json();
    const ids = Array.isArray(list)
      ? list
          .map((a) => (typeof a === "object" && a !== null ? (a as { id?: unknown }).id : null))
          .filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    total = ids.length;

    const results = await Promise.allSettled(ids.map((id) => fetcher(`/a/${id}`)));
    articles = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
    warmed += articles;
  } catch {
    // Fetch threw (offline mid-warm, …): keep whatever succeeded for `warmed`
    // but report the last good article count without persisting.
    return { warmed, total: fallback, articles: fallback };
  }
  return finish(storage, warmed, total, articles);
}

function finish(
  storage: WarmStorage | null,
  warmed: number,
  total: number,
  articles: number
): { warmed: number; total: number; articles: number } {
  try {
    storage?.setItem(
      OFFLINE_READY_KEY,
      JSON.stringify({ count: articles, at: new Date().toISOString() } satisfies OfflineReady)
    );
    // Notify same-tab listeners (storage events don't fire in the tab that
    // wrote). Guarded for SSR / node (unit tests) where window is absent.
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new Event(OFFLINE_READY_EVENT));
    }
  } catch {
    // storage unavailable — result still returned
  }
  return { warmed, total, articles };
}
