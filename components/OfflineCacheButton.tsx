"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { readOfflineReady, shouldWarm, warmOfflineCache } from "@/lib/offline-cache";

/**
 * Proactive offline control for the library page. Warms the service-worker
 * cache (library + every article document, including unopened ones) once on
 * load while online, and offers a manual refresh. Shows how many articles are
 * cached so going offline has no surprises.
 */
export default function OfflineCacheButton() {
  const [state, setState] = useState<"idle" | "warming" | "ready" | "unsupported">("idle");
  const [articles, setArticles] = useState(0);
  const ran = useRef(false);

  const warm = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !navigator.onLine) {
      if (!("serviceWorker" in navigator)) setState("unsupported");
      return;
    }
    setState("warming");
    try {
      // Wait for the worker to take control so these requests get cached.
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error("sw-timeout")), 10000)),
      ]);
      const { articles: n } = await warmOfflineCache();
      setArticles(n);
      setState("ready");
    } catch {
      setState((s) => (s === "warming" ? "idle" : s));
    }
  }, []);

  useEffect(() => {
    const prev = readOfflineReady();
    if (prev) {
      setArticles(prev.count);
      setState("ready");
    }
    if (!ran.current && navigator.onLine) {
      ran.current = true;
      // Auto-warm only when stale; the button always forces a refresh.
      if (shouldWarm()) void warm();
    }
  }, [warm]);

  if (state === "unsupported") return null;

  const label =
    state === "warming"
      ? "Caching for offline…"
      : state === "ready"
        ? `✓ ${articles} article${articles === 1 ? "" : "s"} available offline · Refresh`
        : "↓ Make available offline";

  return (
    <p className="muted" role="status">
      <button onClick={() => void warm()} disabled={state === "warming"}>
        {label}
      </button>
    </p>
  );
}
