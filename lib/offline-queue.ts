/**
 * Offline progress queue — pending `PUT /api/articles/:id/progress` writes
 * made while offline, persisted in localStorage and replayed on reconnect.
 *
 * Entries written by offset-aware clients carry both the canonical `offset`
 * and the derived `progress` mirror; entries from legacy clients carry only
 * `progress` and are converted via `fractionToOffset` at flush time when a
 * text length can be resolved (otherwise the legacy fraction is replayed).
 *
 * Storage is injectable so this stays unit-testable without a DOM.
 */

import { clampOffset, fractionToOffset, offsetToFraction } from "./progress-sync";

export type PendingProgress = {
  id: string;
  /** Canonical char offset. Absent on entries queued by legacy clients. */
  offset?: number;
  /** Derived fraction mirror (0..1). Always present; legacy replay fallback. */
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
    // Tolerate legacy { id, progress } entries (no offset) and strip
    // non-numeric offsets; default a missing updatedAt to now.
    return parsed
      .filter(
        (e): e is PendingProgress =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as PendingProgress).id === "string" &&
          typeof (e as PendingProgress).progress === "number"
      )
      .map((e) => ({
        id: e.id,
        progress: e.progress,
        ...(typeof e.offset === "number" && Number.isFinite(e.offset) ? { offset: e.offset } : {}),
        updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : new Date().toISOString(),
      }));
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
  progress: number,
  textLength?: number
): PendingProgress[] {
  if (!storage || !id) return readPendingProgress(storage);
  const clamped = clampProgress(progress);
  const rest = readPendingProgress(storage).filter((e) => e.id !== id);
  const entry: PendingProgress =
    typeof textLength === "number" && Number.isFinite(textLength)
      ? {
          id,
          offset: fractionToOffset(clamped, textLength),
          progress: clamped,
          updatedAt: new Date().toISOString(),
        }
      : { id, progress: clamped, updatedAt: new Date().toISOString() };
  const next = [...rest, entry];
  writeQueue(storage, next);
  return next.slice(-MAX_PENDING);
}

/** Upsert the latest canonical offset for an article (drops falsy ids). */
export function enqueueProgressOffset(
  storage: QueueStorage | null = defaultStorage(),
  id: string,
  offset: number,
  textLength: number
): PendingProgress[] {
  if (!storage || !id) return readPendingProgress(storage);
  const clamped = clampOffset(offset, textLength);
  const rest = readPendingProgress(storage).filter((e) => e.id !== id);
  const next = [
    ...rest,
    {
      id,
      offset: clamped,
      progress: offsetToFraction(clamped, textLength),
      updatedAt: new Date().toISOString(),
    },
  ];
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

/** Sends the canonical char offset: body `PUT /api/articles/:id/progress` as `{ offset }`. */
export type OffsetProgressSender = (
  id: string,
  offset: number
) => Promise<Response | { ok: boolean }>;

/** Resolves an article's `text.length` for legacy-fraction → offset conversion. */
export type TextLengthResolver = (id: string) => number | undefined | Promise<number | undefined>;

export type FlushOptions = {
  /**
   * When set, entries with a resolvable offset are replayed through this
   * sender as `{ offset }`. Entries whose offset can't be resolved (legacy
   * `{ id, progress }` shapes with no text length) fall back to the legacy
   * `send` as `{ progress }`.
   */
  sendOffset?: OffsetProgressSender;
  /** Text-length source for converting legacy fraction entries to offsets. */
  getTextLength?: TextLengthResolver;
};

function isOk(res: Response | { ok: boolean }): boolean {
  return res.ok;
}

function isGone(res: Response | { ok: boolean }): boolean {
  return "status" in res && res.status === 404;
}

/**
 * Replay queued progress writes. Entries that send OK — or 404 (article
 * deleted, nothing left to sync) — are dropped; the rest stay queued.
 *
 * Offset-aware replay: entries carrying a numeric `offset` are sent via
 * `opts.sendOffset` when provided (legacy `{ id, progress }` entries are
 * converted with `fractionToOffset` using `opts.getTextLength`). Anything
 * without a resolvable offset falls back to the legacy `send` fraction path,
 * so old callers keep working unchanged.
 */
export async function flushPendingProgress(
  send: ProgressSender,
  storage: QueueStorage | null = defaultStorage(),
  opts: FlushOptions = {}
): Promise<{ flushed: number; remaining: PendingProgress[] }> {
  const pending = readPendingProgress(storage);
  if (!storage || pending.length === 0) return { flushed: 0, remaining: pending };
  let flushed = 0;
  const remaining: PendingProgress[] = [];
  for (const entry of pending) {
    let offset: number | undefined =
      typeof entry.offset === "number" && Number.isFinite(entry.offset) ? entry.offset : undefined;
    if (offset === undefined && opts.getTextLength) {
      try {
        const len = await opts.getTextLength(entry.id);
        if (typeof len === "number" && Number.isFinite(len)) {
          offset = fractionToOffset(entry.progress, len);
        }
      } catch {
        offset = undefined;
      }
    }
    try {
      const res =
        offset !== undefined && opts.sendOffset
          ? await opts.sendOffset(entry.id, offset)
          : await send(entry.id, entry.progress);
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
 * Try a live offset PUT first; on network failure queue for later replay.
 * Returns "sent" when the server acknowledged, "queued" otherwise.
 */
export async function persistProgressOffset(
  id: string,
  offset: number,
  textLength: number,
  send: OffsetProgressSender,
  storage: QueueStorage | null = defaultStorage()
): Promise<"sent" | "queued"> {
  const clamped = clampOffset(offset, textLength);
  try {
    const res = await send(id, clamped);
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
  enqueueProgressOffset(storage, id, clamped, textLength);
  return "queued";
}

/**
 * Try a live PUT first; on network failure queue for later replay.
 * Returns "sent" when the server acknowledged, "queued" otherwise.
 *
 * Back-compat wrapper: behaves exactly as before when `textLength` is
 * omitted (queues a legacy fraction-only entry); when `textLength` is known
 * the queued entry also carries the canonical offset.
 */
export async function persistProgress(
  id: string,
  progress: number,
  send: ProgressSender,
  storage: QueueStorage | null = defaultStorage(),
  textLength?: number
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
  enqueueProgress(storage, id, progress, textLength);
  return "queued";
}
