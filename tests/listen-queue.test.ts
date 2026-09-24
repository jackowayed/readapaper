import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clear,
  enqueue,
  enqueueNext,
  LISTEN_QUEUE_KEY,
  loadQueue,
  move,
  readQueue,
  remove,
  type ListenQueueStorage,
} from "../lib/listen-queue";

function memStorage(): ListenQueueStorage & { raw(): string | null } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    raw: () => map.get(LISTEN_QUEUE_KEY) ?? null,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("listen-queue (localStorage article-id order)", () => {
  it("reads [] when empty, corrupt, or non-array", () => {
    const s = memStorage();
    expect(readQueue(s)).toEqual([]);
    expect(loadQueue(s)).toEqual([]);
    s.setItem(LISTEN_QUEUE_KEY, "not-json{{");
    expect(readQueue(s)).toEqual([]);
    s.setItem(LISTEN_QUEUE_KEY, JSON.stringify({ not: "array" }));
    expect(readQueue(s)).toEqual([]);
  });

  it("drops non-string entries and dupes on read", () => {
    const s = memStorage();
    s.setItem(LISTEN_QUEUE_KEY, JSON.stringify(["a", 42, null, "b", "a", "", "c"]));
    expect(readQueue(s)).toEqual(["a", "b", "c"]);
  });

  it("returns [] with no storage (SSR) and never throws on write failure", () => {
    expect(readQueue(null)).toEqual([]);
    expect(enqueue("a", null)).toEqual([]);
    expect(enqueueNext("a", null)).toEqual([]);
    expect(remove("a", null)).toEqual([]);
    expect(move("a", 1, null)).toEqual([]);
    expect(clear(null)).toEqual([]);
    const throwing: ListenQueueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => enqueue("a", throwing)).not.toThrow();
    expect(enqueue("a", throwing)).toEqual(["a"]);
    expect(() => clear(throwing)).not.toThrow();
  });

  it("enqueue appends in order and ignores dupes + falsy ids", () => {
    const s = memStorage();
    expect(enqueue("a", s)).toEqual(["a"]);
    expect(enqueue("b", s)).toEqual(["a", "b"]);
    expect(enqueue("a", s)).toEqual(["a", "b"]);
    expect(enqueue("", s)).toEqual(["a", "b"]);
    expect(s.raw()).toBe(JSON.stringify(["a", "b"]));
  });

  it("enqueueNext front-inserts and moves existing ids to the front", () => {
    const s = memStorage();
    enqueue("a", s);
    enqueue("b", s);
    expect(enqueueNext("c", s)).toEqual(["c", "a", "b"]);
    expect(enqueueNext("b", s)).toEqual(["b", "c", "a"]);
    // Front-inserting the head is a no-op.
    expect(enqueueNext("b", s)).toEqual(["b", "c", "a"]);
  });

  it("remove drops the id wherever it sits", () => {
    const s = memStorage();
    enqueue("a", s);
    enqueue("b", s);
    enqueue("c", s);
    expect(remove("b", s)).toEqual(["a", "c"]);
    expect(remove("missing", s)).toEqual(["a", "c"]);
    expect(remove("a", s)).toEqual(["c"]);
  });

  it("move swaps one slot up/down and no-ops at edges or when absent", () => {
    const s = memStorage();
    enqueue("a", s);
    enqueue("b", s);
    enqueue("c", s);
    expect(move("b", -1, s)).toEqual(["b", "a", "c"]);
    expect(move("b", 1, s)).toEqual(["a", "b", "c"]);
    // Edges are no-ops.
    expect(move("a", -1, s)).toEqual(["a", "b", "c"]);
    expect(move("c", 1, s)).toEqual(["a", "b", "c"]);
    expect(move("missing", -1, s)).toEqual(["a", "b", "c"]);
    // Zero dir is a no-op.
    expect(move("b", 0, s)).toEqual(["a", "b", "c"]);
  });

  it("clear empties the queue", () => {
    const s = memStorage();
    enqueue("a", s);
    enqueue("b", s);
    expect(clear(s)).toEqual([]);
    expect(readQueue(s)).toEqual([]);
    expect(s.raw()).toBeNull();
  });

  it("persists across reads (round-trip through storage JSON)", () => {
    const s = memStorage();
    enqueue("a", s);
    enqueueNext("b", s);
    move("a", -1, s);
    expect(loadQueue(s)).toEqual(["a", "b"]);
  });
});
