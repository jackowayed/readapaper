/**
 * Offline progress queue — pending `PUT /api/articles/:id/progress` writes
 * made while offline, persisted in localStorage and replayed on reconnect.
 *
 * Storage is injectable so this stays unit-testable without a DOM.
 */

export type PendingProgress = {
  id: string;
  progress: number;
  updatedAt: string;
};

export type QueueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const PENDING_PROGRESS_KEY = "readapaper:pending-progress";
export const MAX_PENDING = 100;

function clampProgress(p: number): number {
  if (Number.isNaN(p)) return 0;
  return Math.min(1, Math.max(0, p));
}

function defaultStorage(): QueueStorage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // private-mode / SSR: no storage
  }
  return null;
}

export function readPendingProgress(
  storage: QueueStorage | null = defaultStorage()
): PendingProgress[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PENDING_PROGRESS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PendingProgress =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as PendingProgress).id === "string" &&
        typeof (e as PendingProgress).progress === "number"
    );
  } catch {
    return [];
  }
}

function writeQueue(storage: QueueStorage, entries: PendingProgress[]): void {
  storage.setItem(PENDING_PROGRESS_KEY, JSON.stringify(entries.slice(-MAX_PENDING)));
}

/** Upsert the latest progress for an article (drops falsy ids). */
export function enqueueProgress(
  storage: QueueStorage | null = defaultStorage(),
  id: string,
  progress: number
): PendingProgress[] {
  if (!storage || !id) return readPendingProgress(storage);
  const clamped = clampProgress(progress);
  const rest = readPendingProgress(storage).filter((e) => e.id !== id);
  const next = [...rest, { id, progress: clamped, updatedAt: new Date().toISOString() }];
  writeQueue(storage, next);
  return next.slice(-MAX_PENDING);
}

export function removePendingProgress(
  storage: QueueStorage | null = defaultStorage(),
  id: string
): PendingProgress[] {
  if (!storage) return [];
  const next = readPendingProgress(storage).filter((e) => e.id !== id);
  writeQueue(storage, next);
  return next;
}

export function clearPendingProgress(storage: QueueStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(PENDING_PROGRESS_KEY);
  } catch {
    // ignore
  }
}

export type ProgressSender = (id: string, progress: number) => Promise<Response | { ok: boolean }>;

function isOk(res: Response | { ok: boolean }): boolean {
  return res.ok;
}

function isGone(res: Response | { ok: boolean }): boolean {
  return "status" in res && res.status === 404;
}

/**
 * Replay queued progress writes. Entries that send OK — or 404 (article
 * deleted, nothing left to sync) — are dropped; the rest stay queued.
 */
export async function flushPendingProgress(
  send: ProgressSender,
  storage: QueueStorage | null = defaultStorage()
): Promise<{ flushed: number; remaining: PendingProgress[] }> {
  const pending = readPendingProgress(storage);
  if (!storage || pending.length === 0) return { flushed: 0, remaining: pending };
  let flushed = 0;
  const remaining: PendingProgress[] = [];
  for (const entry of pending) {
    try {
      const res = await send(entry.id, entry.progress);
      if (isOk(res) || isGone(res)) flushed += 1;
      else remaining.push(entry);
    } catch {
      remaining.push(entry);
    }
  }
  writeQueue(storage, remaining);
  return { flushed, remaining };
}

/**
 * Try a live PUT first; on network failure queue for later replay.
 * Returns "sent" when the server acknowledged, "queued" otherwise.
 */
export async function persistProgress(
  id: string,
  progress: number,
  send: ProgressSender,
  storage: QueueStorage | null = defaultStorage()
): Promise<"sent" | "queued"> {
  try {
    const res = await send(id, clampProgress(progress));
    if (isOk(res)) {
      removePendingProgress(storage, id);
      return "sent";
    }
    if (isGone(res)) {
      removePendingProgress(storage, id);
      return "sent";
    }
  } catch {
    // network down — fall through to queue
  }
  enqueueProgress(storage, id, progress);
  return "queued";
}
