"use client";
import { useEffect, useRef } from "react";
import { persistProgress } from "@/lib/offline-queue";
import { fractionToOffset } from "@/lib/progress-sync";

export default function ThemeControl() {
  useEffect(() => {
    const saved = localStorage.getItem("theme") || "light";
    document.documentElement.dataset.theme = saved;
  }, []);

  function setTheme(t: string) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem("theme", t);
    const size = localStorage.getItem("fontScale") || "100";
    document.documentElement.style.fontSize = `${(16 * Number(size)) / 100}px`;
  }

  function adjustFont(delta: number) {
    const cur = Number(localStorage.getItem("fontScale") || "100");
    const next = Math.min(150, Math.max(80, cur + delta));
    localStorage.setItem("fontScale", String(next));
    document.documentElement.style.fontSize = `${(16 * next) / 100}px`;
  }

  useEffect(() => {
    const size = localStorage.getItem("fontScale") || "100";
    document.documentElement.style.fontSize = `${(16 * Number(size)) / 100}px`;
  }, []);

  return (
    <div style={{ display: "flex", gap: "0.4rem" }}>
      <button onClick={() => setTheme("light")} title="Light">
        ☀
      </button>
      <button onClick={() => setTheme("sepia")} title="Sepia">
        📜
      </button>
      <button onClick={() => setTheme("dark")} title="Dark">
        🌙
      </button>
      <button onClick={() => adjustFont(-10)} title="Smaller">
        A-
      </button>
      <button onClick={() => adjustFont(10)} title="Larger">
        A+
      </button>
    </div>
  );
}

// Hook: persist + restore reading progress for an article.
//
// Offset mode (unified progress): pass `textLength` + `onPosition` and the
// hook converts the scroll fraction to a canonical char offset, handing it to
// the owner via `onPosition` — the owner (ReaderClient) persists through the
// shared offline-safe sender, so read + listen share one write path. Without
// `onPosition` the hook keeps its legacy behavior (persists `{ progress }`
// itself). `enabled` gates the scroll listener so only read mode persists.
export type ReadingProgressOptions = {
  textLength?: number;
  enabled?: boolean;
  onPosition?: (offset: number) => void;
};

export function useReadingProgress(
  articleId: string,
  initial: number,
  opts?: ReadingProgressOptions
) {
  const textLength = opts?.textLength;
  const enabled = opts?.enabled ?? true;
  const onPositionRef = useRef<((offset: number) => void) | undefined>(undefined);
  onPositionRef.current = opts?.onPosition;
  const saved = useRef(false);
  useEffect(() => {
    if (!saved.current && initial > 0) {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, h * Math.min(1, initial));
      saved.current = true;
    }
  }, [initial]);

  // Ignore scroll events for ~1s after a listen-driven handoff: toggling
  // listen -> read flips `enabled` false -> true and scrolls programmatically
  // to the listen offset; that scroll must not fight or re-persist.
  const suppressUntilRef = useRef(0);
  const wasEnabledRef = useRef(enabled);
  useEffect(() => {
    if (enabled && !wasEnabledRef.current) suppressUntilRef.current = Date.now() + 1000;
    wasEnabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    function onScroll() {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        if (document.hidden) return;
        if (Date.now() < suppressUntilRef.current) return;
        const h = document.documentElement.scrollHeight - window.innerHeight;
        if (h <= 0) return;
        const p = Math.min(1, Math.max(0, window.scrollY / h));
        const notify = onPositionRef.current;
        if (notify && typeof textLength === "number" && Number.isFinite(textLength)) {
          notify(fractionToOffset(p, textLength));
          return;
        }
        // Legacy path (no owner): persist the fraction directly, offline-safe.
        persistProgress(articleId, p, async (id, progress) =>
          fetch(`/api/articles/${id}/progress`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ progress }),
          })
        ).catch(() => {});
      }, 600);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [articleId, enabled, textLength]);
}
