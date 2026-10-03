import { describe, expect, it } from "vitest";
import {
  OFFLINE_FINGERPRINT_KEY,
  readOfflineReady,
  warmOfflineCache,
  type WarmStorage,
} from "../lib/offline-cache";

function memStorage(): WarmStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

type StubRes = { ok: boolean; json: () => Promise<unknown> };

function stubFetcher(routes: Record<string, StubRes | Error>) {
  return async (url: string): Promise<StubRes> => {
    const hit = routes[url];
    if (hit instanceof Error) throw hit;
    if (!hit) return { ok: false, json: async () => null };
    return hit;
  };
}

const okJson = (v: unknown): StubRes => ({ ok: true, json: async () => v });
const ok: StubRes = { ok: true, json: async () => null };

describe("offline cache warming", () => {
  it("reads null when nothing warmed or data corrupt", () => {
    const s = memStorage();
    expect(readOfflineReady(s)).toBeNull();
    s.setItem("readapaper:offline-ready", "nope{{");
    expect(readOfflineReady(s)).toBeNull();
    expect(readOfflineReady(null)).toBeNull();
  });

  it("warms home + every active article and persists the count", async () => {
    const s = memStorage();
    const fetch = stubFetcher({
      "/": ok,
      "/api/articles?archived=0": okJson([{ id: "a" }, { id: "b" }, { id: "c" }]),
      "/a/a": ok,
      "/a/b": ok,
      "/a/c": ok,
    });
    const { warmed, total, articles } = await warmOfflineCache(fetch, s);
    expect(total).toBe(3);
    expect(articles).toBe(3);
    expect(warmed).toBe(4); // home + 3 articles
    expect(readOfflineReady(s)?.count).toBe(3);
    expect(typeof readOfflineReady(s)?.at).toBe("string");
  });

  it("tolerates per-article failures and skips bad ids", async () => {
    const s = memStorage();
    const fetch = stubFetcher({
      "/": ok,
      "/api/articles?archived=0": okJson([{ id: "a" }, { id: 42 }, {}, { id: "b" }]),
      "/a/a": ok,
      "/a/b": new Error("offline mid-warm"),
    });
    const { warmed, total, articles } = await warmOfflineCache(fetch, s);
    expect(total).toBe(2);
    expect(articles).toBe(1); // only a; b failed mid-warm
    expect(warmed).toBe(2); // home + a
    expect(readOfflineReady(s)?.count).toBe(1);
  });

  it("requests the active-only list so archived articles stay out of the cache", async () => {
    const s = memStorage();
    const seen: string[] = [];
    const fetch = async (url: string): Promise<StubRes> => {
      seen.push(url);
      if (url === "/") return ok;
      return okJson([]);
    };
    await warmOfflineCache(fetch, s);
    expect(seen).toContain("/api/articles?archived=0");
    expect(seen).not.toContain("/api/articles");
  });

  it("returns zeros when the list fetch fails", async () => {
    const s = memStorage();
    const fetch = stubFetcher({ "/": ok, "/api/articles?archived=0": new Error("down") });
    const { warmed, total, articles } = await warmOfflineCache(fetch, s);
    expect(total).toBe(0);
    expect(articles).toBe(0);
    expect(warmed).toBe(1); // home still warmed
  });

  it("keeps the previous count when the list fetch fails (no clobber to 0)", async () => {
    const s = memStorage();
    s.setItem(
      "readapaper:offline-ready",
      JSON.stringify({ count: 3, at: new Date().toISOString() })
    );
    const fetch = stubFetcher({ "/": ok, "/api/articles?archived=0": new Error("down") });
    const { total, articles } = await warmOfflineCache(fetch, s);
    expect(total).toBe(3);
    expect(articles).toBe(3);
    // The stored count is untouched — the UI keeps showing the last good warm.
    expect(readOfflineReady(s)?.count).toBe(3);
  });

  it("works without storage", async () => {
    const fetch = stubFetcher({ "/": ok, "/api/articles?archived=0": okJson([]) });
    const { warmed, total, articles } = await warmOfflineCache(fetch, null);
    expect(warmed).toBe(1);
    expect(total).toBe(0);
    expect(articles).toBe(0);
  });

  it("skips the per-article fan-out when the article set is unchanged", async () => {
    const s = memStorage();
    const routes: Record<string, StubRes> = {
      "/": ok,
      "/api/articles?archived=0": okJson([{ id: "a" }, { id: "b" }]),
      "/a/a": ok,
      "/a/b": ok,
    };
    expect(await warmOfflineCache(stubFetcher(routes), s)).toEqual({
      warmed: 3,
      total: 2,
      articles: 2,
    });
    const seen: string[] = [];
    const fetch = async (url: string): Promise<StubRes> => {
      seen.push(url);
      return routes[url] ?? { ok: false, json: async () => null };
    };
    // Library page + list still refetched (counts/progress stay fresh), but
    // no article document is fetched twice.
    expect(await warmOfflineCache(fetch, s)).toEqual({ warmed: 1, total: 2, articles: 2 });
    expect(seen).toEqual(["/", "/api/articles?archived=0"]);
  });

  it("re-warms the fan-out when the article set changes", async () => {
    const s = memStorage();
    await warmOfflineCache(
      stubFetcher({ "/": ok, "/api/articles?archived=0": okJson([{ id: "a" }]), "/a/a": ok }),
      s
    );
    const seen: string[] = [];
    const fetch = async (url: string): Promise<StubRes> => {
      seen.push(url);
      if (url === "/") return ok;
      if (url === "/api/articles?archived=0") return okJson([{ id: "a" }, { id: "b" }]);
      return ok;
    };
    const { articles } = await warmOfflineCache(fetch, s);
    expect(articles).toBe(2);
    expect(seen).toContain("/a/a");
    expect(seen).toContain("/a/b");
  });

  it("retries failed articles next pass (no fingerprint on partial warms)", async () => {
    const s = memStorage();
    await warmOfflineCache(
      stubFetcher({
        "/": ok,
        "/api/articles?archived=0": okJson([{ id: "a" }, { id: "b" }]),
        "/a/a": ok,
        "/a/b": new Error("flaky"),
      }),
      s
    );
    expect(s.getItem(OFFLINE_FINGERPRINT_KEY)).toBeNull();
    const seen: string[] = [];
    const fetch = async (url: string): Promise<StubRes> => {
      seen.push(url);
      if (url === "/") return ok;
      if (url === "/api/articles?archived=0") return okJson([{ id: "a" }, { id: "b" }]);
      return ok;
    };
    expect((await warmOfflineCache(fetch, s)).articles).toBe(2);
    expect(seen).toContain("/a/b");
    expect(s.getItem(OFFLINE_FINGERPRINT_KEY)).not.toBeNull();
  });

  it("caps concurrent article fetches", async () => {
    const s = memStorage();
    const ids = ["a", "b", "c", "d", "e", "f"];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = async (url: string): Promise<StubRes> => {
      if (url === "/") return ok;
      if (url === "/api/articles?archived=0") return okJson(ids.map((id) => ({ id })));
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return ok;
    };
    const { articles } = await warmOfflineCache(fetch, s, { concurrency: 2 });
    expect(articles).toBe(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
