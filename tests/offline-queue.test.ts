import { describe, expect, it } from "vitest";
import {
  clearPendingProgress,
  enqueueProgress,
  flushPendingProgress,
  persistProgress,
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
