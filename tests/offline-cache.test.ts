import { describe, expect, it } from "vitest";
import {
  readOfflineReady,
  shouldWarm,
  warmOfflineCache,
  WARM_MAX_AGE_MS,
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

  it("works without storage", async () => {
    const fetch = stubFetcher({ "/": ok, "/api/articles?archived=0": okJson([]) });
    const { warmed, total, articles } = await warmOfflineCache(fetch, null);
    expect(warmed).toBe(1);
    expect(total).toBe(0);
    expect(articles).toBe(0);
  });
});

describe("shouldWarm", () => {
  it("warms when never warmed, corrupt, or stale", () => {
    const s = memStorage();
    expect(shouldWarm(s)).toBe(true);
    s.setItem("readapaper:offline-ready", "nope{{");
    expect(shouldWarm(s)).toBe(true);
    s.setItem(
      "readapaper:offline-ready",
      JSON.stringify({ count: 3, at: new Date(Date.now() - WARM_MAX_AGE_MS - 1000).toISOString() })
    );
    expect(shouldWarm(s)).toBe(true);
  });

  it("skips when freshly warmed", () => {
    const s = memStorage();
    s.setItem(
      "readapaper:offline-ready",
      JSON.stringify({ count: 3, at: new Date().toISOString() })
    );
    expect(shouldWarm(s)).toBe(false);
    expect(shouldWarm(null)).toBe(true);
  });
});
