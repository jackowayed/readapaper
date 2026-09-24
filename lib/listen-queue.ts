/**
 * listen-queue — client-side queue of article ids for continuous TTS playback.
 *
 * The queue lives entirely in localStorage (per-browser, offline-safe, zero
 * server state): `readapaper:listen-queue` holds a JSON array of article ids
 * in play order. The `/listen` player loads the ids and fetches each
 * `GET /api/articles/[id]` JSON (title/text) as needed.
 *
 * Storage is injectable (same pattern as `lib/offline-queue.ts`) so this
 * stays unit-testable without a DOM. Every mutation broadcasts
 * `QUEUE_CHANGE_EVENT` on `window` so same-tab UI (library count, player
 * list) stays in sync — the `storage` event only fires cross-tab.
 */

export type ListenQueueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const LISTEN_QUEUE_KEY = "readapaper:listen-queue";

/** Broadcast on every mutation so same-tab listeners can re-read. */
export const QUEUE_CHANGE_EVENT = "listen-queue:change";

/** -1 = move earlier (up), +1 = move later (down). */
export type MoveDirection = -1 | 1;

function defaultStorage(): ListenQueueStorage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // private-mode / SSR: no storage
  }
  return null;
}

function notify(): void {
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new Event(QUEUE_CHANGE_EVENT));
    }
  } catch {
    // never throw from a mutation helper
  }
}

function sanitize(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of ids) {
    if (typeof e !== "string" || !e) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/** Read the queue in order; `[]` when empty, corrupt, or storage is missing. */
export function readQueue(storage: ListenQueueStorage | null = defaultStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LISTEN_QUEUE_KEY);
    if (!raw) return [];
    return sanitize(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Alias for `readQueue` (spec names both `readQueue`/`load`). */
export const loadQueue = readQueue;

function writeQueue(storage: ListenQueueStorage, ids: string[]): string[] {
  const clean = sanitize(ids);
  try {
    storage.setItem(LISTEN_QUEUE_KEY, JSON.stringify(clean));
  } catch {
    // private-mode quota: keep the in-memory return value, skip broadcast
    return clean;
  }
  notify();
  return clean;
}

/** Append `id` unless already queued (no dupes). Ignores falsy ids. */
export function enqueue(
  id: string,
  storage: ListenQueueStorage | null = defaultStorage()
): string[] {
  if (!storage || !id) return readQueue(storage);
  const q = readQueue(storage);
  if (q.includes(id)) return q;
  return writeQueue(storage, [...q, id]);
}

/**
 * Play-next: dedupe, then insert at the front of the queue. "Front" is the
 * literal head of the stored order (simplest semantics per spec) — the
 * `/listen` player keys playback off the current id (not the head index),
 * so a front-insert mid-play never disturbs the item being spoken; the
 * inserted item plays when the player reaches the head of the list.
 */
export function enqueueNext(
  id: string,
  storage: ListenQueueStorage | null = defaultStorage()
): string[] {
  if (!storage || !id) return readQueue(storage);
  const q = readQueue(storage).filter((e) => e !== id);
  return writeQueue(storage, [id, ...q]);
}

/** Remove `id` wherever it sits (no-op when absent). */
export function remove(
  id: string,
  storage: ListenQueueStorage | null = defaultStorage()
): string[] {
  if (!storage || !id) return readQueue(storage);
  return writeQueue(
    storage,
    readQueue(storage).filter((e) => e !== id)
  );
}

/**
 * Swap `id` one slot toward `dir` (-1 = earlier/up, +1 = later/down).
 * No-op at the edges or when `id` is absent. Any nonzero sign works;
 * values other than ±1 use their sign.
 */
export function move(
  id: string,
  dir: MoveDirection | number,
  storage: ListenQueueStorage | null = defaultStorage()
): string[] {
  if (!storage || !id) return readQueue(storage);
  const q = readQueue(storage);
  const i = q.indexOf(id);
  if (i === -1) return q;
  const j = i + (dir < 0 ? -1 : dir > 0 ? 1 : 0);
  if (j < 0 || j >= q.length || j === i) return q;
  const next = [...q];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return writeQueue(storage, next);
}

/** Empty the queue. */
export function clear(storage: ListenQueueStorage | null = defaultStorage()): string[] {
  if (!storage) return [];
  try {
    storage.removeItem(LISTEN_QUEUE_KEY);
  } catch {
    // ignore
  }
  notify();
  return [];
}
