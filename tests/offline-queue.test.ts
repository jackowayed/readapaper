import { describe, expect, it } from "vitest";
import {
  clearPendingProgress,
  enqueueProgress,
  enqueueProgressOffset,
  flushPendingProgress,
  PENDING_PROGRESS_KEY,
  persistProgress,
  persistProgressOffset,
  readPendingProgress,
  removePendingProgress,
  type QueueStorage,
} from "../lib/offline-queue";

function memStorage(): QueueStorage & { dump(): unknown } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    dump: () => map.get("readapaper:pending-progress"),
  };
}

describe("offline progress queue", () => {
  it("reads [] when empty or corrupt", () => {
    const s = memStorage();
    expect(readPendingProgress(s)).toEqual([]);
    s.setItem("readapaper:pending-progress", "not-json{{");
    expect(readPendingProgress(s)).toEqual([]);
    s.setItem("readapaper:pending-progress", JSON.stringify({ not: "array" }));
    expect(readPendingProgress(s)).toEqual([]);
  });

  it("enqueues and upserts latest progress per article", () => {
    const s = memStorage();
    enqueueProgress(s, "a", 0.2);
    enqueueProgress(s, "b", 0.5);
    enqueueProgress(s, "a", 0.9);
    const q = readPendingProgress(s);
    expect(q).toHaveLength(2);
    expect(q.find((e) => e.id === "a")?.progress).toBe(0.9);
  });

  it("clamps progress to 0..1 and ignores empty ids", () => {
    const s = memStorage();
    enqueueProgress(s, "a", 5);
    enqueueProgress(s, "", 0.5);
    const q = readPendingProgress(s);
    expect(q).toHaveLength(1);
    expect(q[0]?.progress).toBe(1);
  });

  it("removes and clears entries", () => {
    const s = memStorage();
    enqueueProgress(s, "a", 0.1);
    enqueueProgress(s, "b", 0.2);
    removePendingProgress(s, "a");
    expect(readPendingProgress(s).map((e) => e.id)).toEqual(["b"]);
    clearPendingProgress(s);
    expect(readPendingProgress(s)).toEqual([]);
  });

  it("flush drops sent + 404-gone entries, keeps failures", async () => {
    const s = memStorage();
    enqueueProgress(s, "ok", 0.1);
    enqueueProgress(s, "gone", 0.2);
    enqueueProgress(s, "fail", 0.3);
    const send = async (id: string) => {
      if (id === "gone") return { ok: false, status: 404 } as unknown as Response;
      if (id === "fail") throw new Error("offline");
      return { ok: true } as { ok: boolean };
    };
    const { flushed, remaining } = await flushPendingProgress(send, s);
    expect(flushed).toBe(2);
    expect(remaining.map((e) => e.id)).toEqual(["fail"]);
    expect(readPendingProgress(s).map((e) => e.id)).toEqual(["fail"]);
  });

  it("persistProgress sends live, queues when offline", async () => {
    const s = memStorage();
    expect(await persistProgress("a", 0.4, async () => ({ ok: true }), s)).toBe("sent");
    expect(readPendingProgress(s)).toEqual([]);

    expect(await persistProgress("b", 0.4, async () => ({ ok: true }), null)).toBe("sent");

    expect(
      await persistProgress(
        "c",
        0.4,
        async () => {
          throw new Error("down");
        },
        s
      )
    ).toBe("queued");
    expect(readPendingProgress(s).map((e) => e.id)).toEqual(["c"]);
  });
});

describe("offline progress queue (offsets)", () => {
  it("enqueueProgressOffset stores offset + derived mirror and coalesces", () => {
    const s = memStorage();
    enqueueProgressOffset(s, "a", 5, 10);
    enqueueProgressOffset(s, "b", 2, 10);
    enqueueProgressOffset(s, "a", 8, 10);
    const q = readPendingProgress(s);
    expect(q).toHaveLength(2);
    expect(q.find((e) => e.id === "a")).toMatchObject({ offset: 8, progress: 0.8 });
  });

  it("enqueueProgressOffset clamps to [0, textLength]", () => {
    const s = memStorage();
    enqueueProgressOffset(s, "hi", 10 ** 9, 10);
    enqueueProgressOffset(s, "lo", -4, 10);
    const q = readPendingProgress(s);
    expect(q.find((e) => e.id === "hi")).toMatchObject({ offset: 10, progress: 1 });
    expect(q.find((e) => e.id === "lo")).toMatchObject({ offset: 0, progress: 0 });
  });

  it("legacy enqueue stays fraction-only; textLength-aware enqueue adds offset", () => {
    const s = memStorage();
    enqueueProgress(s, "legacy", 0.5);
    expect(readPendingProgress(s).find((e) => e.id === "legacy")).toMatchObject({
      progress: 0.5,
    });
    expect(readPendingProgress(s).find((e) => e.id === "legacy")?.offset).toBeUndefined();
    enqueueProgress(s, "known", 0.5, 10);
    expect(readPendingProgress(s).find((e) => e.id === "known")).toMatchObject({
      offset: 5,
      progress: 0.5,
    });
  });

  it("read tolerates legacy entries and strips non-numeric offsets", () => {
    const s = memStorage();
    s.setItem(
      PENDING_PROGRESS_KEY,
      JSON.stringify([
        { id: "old", progress: 0.5, updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "weird", progress: 0.2, offset: "x", updatedAt: "2026-01-01T00:00:00.000Z" },
      ])
    );
    const q = readPendingProgress(s);
    expect(q).toHaveLength(2);
    expect(q.find((e) => e.id === "old")?.offset).toBeUndefined();
    expect(q.find((e) => e.id === "weird")?.offset).toBeUndefined();
    expect(q.find((e) => e.id === "weird")?.progress).toBe(0.2);
  });

  it("flush with a legacy sender replays mixed shapes as fractions", async () => {
    const s = memStorage();
    s.setItem(PENDING_PROGRESS_KEY, JSON.stringify([{ id: "old", progress: 0.5, updatedAt: "t" }]));
    enqueueProgressOffset(s, "new", 3, 10);
    const calls: Array<[string, number]> = [];
    const { flushed } = await flushPendingProgress(async (id, progress) => {
      calls.push([id, progress]);
      return { ok: true };
    }, s);
    expect(flushed).toBe(2);
    expect(calls).toContainEqual(["old", 0.5]);
    expect(calls).toContainEqual(["new", 0.3]);
    expect(readPendingProgress(s)).toEqual([]);
  });

  it("flush converts legacy entries via fractionToOffset when length resolves", async () => {
    const s = memStorage();
    s.setItem(PENDING_PROGRESS_KEY, JSON.stringify([{ id: "old", progress: 0.5, updatedAt: "t" }]));
    enqueueProgressOffset(s, "new", 3, 10);
    const offsetCalls: Array<[string, number]> = [];
    const legacyCalls: Array<[string, number]> = [];
    const { flushed } = await flushPendingProgress(
      async (id, progress) => {
        legacyCalls.push([id, progress]);
        return { ok: true };
      },
      s,
      {
        getTextLength: (id) => (id === "old" ? 10 : undefined),
        sendOffset: async (id, offset) => {
          offsetCalls.push([id, offset]);
          return { ok: true };
        },
      }
    );
    expect(flushed).toBe(2);
    expect(offsetCalls).toContainEqual(["old", 5]);
    expect(offsetCalls).toContainEqual(["new", 3]);
    expect(legacyCalls).toEqual([]);
  });

  it("flush falls back to the legacy fraction when length is unresolvable", async () => {
    const s = memStorage();
    s.setItem(PENDING_PROGRESS_KEY, JSON.stringify([{ id: "old", progress: 0.5, updatedAt: "t" }]));
    const offsetCalls: Array<[string, number]> = [];
    const legacyCalls: Array<[string, number]> = [];
    const { flushed } = await flushPendingProgress(
      async (id, progress) => {
        legacyCalls.push([id, progress]);
        return { ok: true };
      },
      s,
      {
        getTextLength: () => undefined,
        sendOffset: async (id, offset) => {
          offsetCalls.push([id, offset]);
          return { ok: true };
        },
      }
    );
    expect(flushed).toBe(1);
    expect(offsetCalls).toEqual([]);
    expect(legacyCalls).toEqual([["old", 0.5]]);
  });

  it("persistProgressOffset sends live, queues with mirror when offline", async () => {
    const s = memStorage();
    expect(await persistProgressOffset("a", 4, 10, async () => ({ ok: true }), s)).toBe("sent");
    expect(readPendingProgress(s)).toEqual([]);

    expect(
      await persistProgressOffset(
        "b",
        4,
        10,
        async () => {
          throw new Error("down");
        },
        s
      )
    ).toBe("queued");
    expect(readPendingProgress(s)).toEqual([
      expect.objectContaining({ id: "b", offset: 4, progress: 0.4 }),
    ]);
  });

  it("persistProgress queues offset-aware entries when textLength is known", async () => {
    const s = memStorage();
    const down = async () => {
      throw new Error("down");
    };
    expect(await persistProgress("k", 0.5, down, s, 10)).toBe("queued");
    expect(await persistProgress("l", 0.5, down, s)).toBe("queued");
    const q = readPendingProgress(s);
    expect(q.find((e) => e.id === "k")).toMatchObject({ offset: 5, progress: 0.5 });
    expect(q.find((e) => e.id === "l")?.offset).toBeUndefined();
  });
});
