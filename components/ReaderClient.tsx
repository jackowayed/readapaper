"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Article } from "@/lib/types";
import SyncedReader from "./SyncedReader";
import { useReadingProgress } from "./ThemeControl";
import { persistProgressOffset } from "@/lib/offline-queue";
import { clampOffset, offsetToFraction } from "@/lib/progress-sync";

/** Shared offline-safe sender for read + listen: PUT `{ offset }`, queued on failure. */
function sendOffset(id: string, offset: number) {
  return fetch(`/api/articles/${id}/progress`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset }),
  });
}

export default function ReaderClient({ article }: { article: Article }) {
  const [mode, setMode] = useState<"read" | "listen">("read");
  const textLength = article.text.length;
  // Canonical unified position, owned here (last-writer-wins across modes).
  const [offset, setOffset] = useState(() => clampOffset(article.progressOffset ?? 0, textLength));

  // Single write path for both modes: update the local anchor + persist
  // offline-safe. Read mode feeds this (throttled) from scroll via
  // useReadingProgress; listen mode feeds it (throttled) from SyncedReader.
  const handlePosition = useCallback(
    (next: number) => {
      const clamped = clampOffset(next, textLength);
      setOffset(clamped);
      persistProgressOffset(article.id, clamped, textLength, sendOffset).catch(() => {});
    },
    [article.id, textLength]
  );

  useReadingProgress(article.id, offsetToFraction(article.progressOffset ?? 0, textLength), {
    textLength,
    enabled: mode === "read",
    onPosition: handlePosition,
  });

  // listen -> read handoff: after the article HTML remounts, scroll to the
  // last listen offset. (Skipped on first mount — the hook restores there.
  // The hook also ignores scroll events for ~1s after this programmatic
  // scroll so the two don't fight.)
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (mode !== "read") return;
    const h = document.documentElement.scrollHeight - window.innerHeight;
    if (h > 0) window.scrollTo(0, offsetToFraction(offsetRef.current, textLength) * h);
  }, [mode, textLength]);

  return (
    <div>
      <div className="mode-toggle" role="tablist" aria-label="Read or listen">
        <button className={mode === "read" ? "primary" : ""} onClick={() => setMode("read")}>
          📖 Read
        </button>
        <button className={mode === "listen" ? "primary" : ""} onClick={() => setMode("listen")}>
          🎧 Listen in sync
        </button>
      </div>

      {mode === "read" ? (
        <article
          className="article-body"
          // Sanitized server-side with DOMPurify allowlist (see lib/extract.ts)
          dangerouslySetInnerHTML={{ __html: article.html }}
        />
      ) : (
        <SyncedReader
          text={article.text}
          title={article.title}
          startOffset={offset}
          onPosition={handlePosition}
        />
      )}
    </div>
  );
}
