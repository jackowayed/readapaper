"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import SyncedReader from "./SyncedReader";
import { persistProgressOffset } from "@/lib/offline-queue";
import { clear, move, QUEUE_CHANGE_EVENT, readQueue, remove } from "@/lib/listen-queue";

type QueueItem = {
  id: string;
  title: string;
  text: string;
  progressOffset: number;
  missing?: boolean;
};

/** Shared offline-safe sender for queue progress: PUT `{ offset }`. */
function sendOffset(id: string, offset: number) {
  return fetch(`/api/articles/${id}/progress`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset }),
  });
}

/**
 * ListenQueuePlayer — continuous TTS over the client-side listen queue.
 *
 * - Loads article ids from `lib/listen-queue` (localStorage) and fetches each
 *   `GET /api/articles/[id]` JSON (title/text/progressOffset) as needed.
 * - Renders the existing `SyncedReader` for the current item (`key` remount
 *   per id so `startOffset` restores that item's saved offset), persisting
 *   the playhead through the shared offline-safe sender.
 * - `onEnded` advances to the next id and auto-plays it: a flag + effect
 *   clicks the freshly mounted player's Listen button, so playback continues
 *   without another tap (`speechSynthesis.speak` is allowed outside gestures
 *   on desktop Chrome and after the initial Play tap on iOS).
 * - Playback is keyed off the current *id* (not the head index), so a
 *   front-insert (`enqueueNext`) mid-play never disturbs the spoken item.
 */
export default function ListenQueuePlayer() {
  const [ids, setIds] = useState<string[]>([]);
  const [items, setItems] = useState<Record<string, QueueItem>>({});
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const playerRef = useRef<HTMLDivElement>(null);
  // Set when the current id changed via natural drain: the effect below
  // clicks Play on the newly mounted SyncedReader (autoplay-after-advance).
  // Manual selection leaves this false (user taps Play themselves).
  const autoPlayRef = useRef(false);
  const fetchingRef = useRef(new Set<string>());

  const refreshIds = useCallback(() => {
    setIds(readQueue());
  }, []);

  useEffect(() => {
    refreshIds();
    window.addEventListener(QUEUE_CHANGE_EVENT, refreshIds);
    window.addEventListener("storage", refreshIds);
    window.addEventListener("focus", refreshIds);
    return () => {
      window.removeEventListener(QUEUE_CHANGE_EVENT, refreshIds);
      window.removeEventListener("storage", refreshIds);
      window.removeEventListener("focus", refreshIds);
    };
  }, [refreshIds]);

  // Default to the head of the queue (select only — no autoplay on load).
  useEffect(() => {
    setCurrentId((cur) => {
      if (cur && ids.includes(cur)) return cur;
      return ids[0] ?? null;
    });
  }, [ids]);

  const fetchItem = useCallback(async (id: string) => {
    if (fetchingRef.current.has(id)) return;
    fetchingRef.current.add(id);
    try {
      const res = await fetch(`/api/articles/${id}`);
      if (!res.ok) {
        setFailedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
        return;
      }
      const body = (await res.json()) as {
        title?: string;
        text?: string;
        progressOffset?: number;
      };
      if (typeof body.text !== "string" || !body.text) {
        setFailedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
        return;
      }
      setItems((prev) => ({
        ...prev,
        [id]: {
          id,
          title: typeof body.title === "string" && body.title ? body.title : "Untitled",
          text: body.text as string,
          progressOffset:
            typeof body.progressOffset === "number" && Number.isFinite(body.progressOffset)
              ? body.progressOffset
              : 0,
        },
      }));
    } catch {
      setFailedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    } finally {
      fetchingRef.current.delete(id);
    }
  }, []);

  // Fetch titles for the list + the current item's text as needed.
  useEffect(() => {
    for (const id of ids) {
      if (!items[id] && !failedIds.includes(id)) void fetchItem(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, currentId, fetchItem]);

  const current = currentId ? items[currentId] : undefined;

  const handlePosition = useCallback(
    (next: number) => {
      if (!current) return;
      persistProgressOffset(current.id, next, current.text.length, sendOffset).catch(() => {});
    },
    [current]
  );

  const advanceFrom = useCallback(
    (finishedId: string) => {
      const order = readQueue();
      const idx = order.indexOf(finishedId);
      const candidates = idx === -1 ? order : order.slice(idx + 1);
      // Skip ids that already failed to load (deleted/empty) so one dead
      // entry can't stall the rest of the queue.
      const next = candidates.find((id) => !failedIds.includes(id));
      if (next) {
        autoPlayRef.current = true;
        setCurrentId(next);
      }
    },
    [failedIds]
  );

  const handleEnded = useCallback(() => {
    if (currentId) advanceFrom(currentId);
  }, [currentId, advanceFrom]);

  // Autoplay-after-advance: click Play on the freshly mounted SyncedReader.
  // Runs only for drain-driven advances (autoPlayRef); manual selection
  // waits for the user's own tap. Scoped to this player's container, where
  // the only `button.primary` is SyncedReader's Play toggle.
  useEffect(() => {
    if (!autoPlayRef.current || !current) return;
    const btn = playerRef.current?.querySelector(
      'section[aria-label="Listen in sync"] button.primary'
    ) as HTMLButtonElement | null;
    if (btn && /Listen|Resume|Retry/.test(btn.textContent ?? "")) {
      autoPlayRef.current = false;
      btn.click();
    }
  }, [currentId, current]);

  function onRemove(id: string) {
    remove(id);
    refreshIds();
    setItems((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function onMove(id: string, dir: -1 | 1) {
    move(id, dir);
    refreshIds();
  }

  function onClear() {
    clear();
    setCurrentId(null);
    refreshIds();
  }

  function onSelect(id: string) {
    autoPlayRef.current = false;
    setCurrentId(id);
  }

  if (!ids.length) {
    return (
      <div>
        <p className="muted">
          Your listen queue is empty. Add articles from the <Link href="/">library</Link> with “Add
          to queue” and they’ll play here one after another.
        </p>
        <p>
          <Link href="/">← Back to library</Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      <p>
        <Link href="/">← Back to library</Link>
      </p>
      <ol className="list" aria-label="Listen queue">
        {ids.map((id, i) => {
          const item = items[id];
          const missing = failedIds.includes(id);
          const isCurrent = id === currentId;
          return (
            <li key={id} className="card" aria-current={isCurrent ? "true" : undefined}>
              <div className="row">
                <span className="muted" aria-hidden="true">
                  {i + 1}.
                </span>{" "}
                {isCurrent ? (
                  <strong>{item?.title ?? (missing ? "(unavailable)" : "…")}</strong>
                ) : (
                  <span>{item?.title ?? (missing ? "(unavailable)" : "…")}</span>
                )}
              </div>
              <div className="row">
                {!isCurrent && !missing && (
                  <button onClick={() => onSelect(id)} aria-label={`Play ${item?.title ?? id}`}>
                    Play
                  </button>
                )}
                <button
                  onClick={() => onMove(id, -1)}
                  disabled={i === 0}
                  aria-label={`Move up ${item?.title ?? id}`}
                >
                  ↑
                </button>
                <button
                  onClick={() => onMove(id, 1)}
                  disabled={i === ids.length - 1}
                  aria-label={`Move down ${item?.title ?? id}`}
                >
                  ↓
                </button>
                <button onClick={() => onRemove(id)} aria-label={`Remove ${item?.title ?? id}`}>
                  Remove
                </button>
              </div>
              {missing && (
                <p className="muted">
                  Couldn’t load this article (deleted or empty).{" "}
                  <button onClick={() => onRemove(id)} aria-label={`Remove ${id}`}>
                    Remove it
                  </button>
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <p>
        <button onClick={onClear}>Clear queue</button>
      </p>

      <div ref={playerRef}>
        {current ? (
          <section aria-label={`Now playing: ${current.title}`}>
            <h2>{current.title}</h2>
            <SyncedReader
              key={current.id}
              text={current.text}
              title={current.title}
              startOffset={current.progressOffset}
              onPosition={handlePosition}
              onEnded={handleEnded}
            />
          </section>
        ) : currentId ? (
          <p className="muted">Loading…</p>
        ) : null}
      </div>
    </div>
  );
}
