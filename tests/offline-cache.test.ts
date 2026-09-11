import { describe, expect, it } from "vitest";
import { readOfflineReady, warmOfflineCache, type WarmStorage } from "../lib/offline-cache";

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

  it("warms home + every article and persists the count", async () => {
    const s = memStorage();
    const fetch = stubFetcher({
      "/": ok,
      "/api/articles": okJson([{ id: "a" }, { id: "b" }, { id: "c" }]),
      "/a/a": ok,
      "/a/b": ok,
      "/a/c": ok,
    });
    const { warmed, total } = await warmOfflineCache(fetch, s);
    expect(total).toBe(3);
    expect(warmed).toBe(4); // home + 3 articles
    expect(readOfflineReady(s)?.count).toBe(4);
    expect(typeof readOfflineReady(s)?.at).toBe("string");
  });

  it("tolerates per-article failures and skips bad ids", async () => {
    const s = memStorage();
    const fetch = stubFetcher({
      "/": ok,
      "/api/articles": okJson([{ id: "a" }, { id: 42 }, {}, { id: "b" }]),
      "/a/a": ok,
      "/a/b": new Error("offline mid-warm"),
    });
    const { warmed, total } = await warmOfflineCache(fetch, s);
    expect(total).toBe(2);
    expect(warmed).toBe(2); // home + a
  });

  it("returns zeros when the list fetch fails", async () => {
    const s = memStorage();
    const fetch = stubFetcher({ "/": ok, "/api/articles": new Error("down") });
    const { warmed, total } = await warmOfflineCache(fetch, s);
    expect(total).toBe(0);
    expect(warmed).toBe(1); // home still warmed
  });

  it("works without storage", async () => {
    const fetch = stubFetcher({ "/": ok, "/api/articles": okJson([]) });
    const { warmed, total } = await warmOfflineCache(fetch, null);
    expect(warmed).toBe(1);
    expect(total).toBe(0);
  });
});
