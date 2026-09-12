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
/** Auto-warm at most this often; the manual button always warms. */
export const WARM_MAX_AGE_MS = 10 * 60 * 1000;

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
 * True when no warm has run yet or the last one is older than maxAgeMs.
 * Guards the automatic warm so every library visit doesn't refetch all
 * articles (in dev each render is slow; in prod it's just wasted traffic).
 */
export function shouldWarm(
  storage: WarmStorage | null = defaultStorage(),
  maxAgeMs: number = WARM_MAX_AGE_MS,
  now: number = Date.now()
): boolean {
  const prev = readOfflineReady(storage);
  if (!prev) return true;
  const at = Date.parse(prev.at);
  if (Number.isNaN(at)) return true;
  return now - at > maxAgeMs;
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
  try {
    // Library page first so `/` itself renders offline.
    const home = await fetcher("/");
    if (home.ok) warmed += 1;

    // Active articles only: archived items stay out of the offline cache.
    const listRes = await fetcher("/api/articles?archived=0");
    if (!listRes.ok) return finish(storage, warmed, total, articles);
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
    // offline mid-warm — keep whatever succeeded
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
  } catch {
    // storage unavailable — result still returned
  }
  return { warmed, total, articles };
}
