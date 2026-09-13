"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { OFFLINE_READY_EVENT, readOfflineReady, warmOfflineCache } from "@/lib/offline-cache";

/**
 * Proactive offline control for the library page. Warms the service-worker
 * cache (library + every article document, including unopened ones) on every
 * load while online, and offers a manual refresh. Shows how many articles are
 * cached so going offline has no surprises.
 */
export default function OfflineCacheButton() {
  const [state, setState] = useState<"idle" | "warming" | "ready" | "unsupported">("idle");
  const [articles, setArticles] = useState(0);
  const ran = useRef(false);

  const warm = useCallback(async (quiet = false) => {
    if (!("serviceWorker" in navigator) || !navigator.onLine) {
      if (!("serviceWorker" in navigator)) setState("unsupported");
      return;
    }
    // When a previous count is on screen, revalidate silently in the
    // background so the label never flashes back to "Caching…"; otherwise
    // show the warming state.
    if (!quiet) setState("warming");
    try {
      // Wait for the worker to take control so these requests get cached.
      // `ready` alone is not enough: it resolves at activation, which can
      // win the race against clients.claim(), leaving this page
      // uncontrolled — its fetches would then succeed over the network
      // without landing in any cache. Poll controller explicitly.
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error("sw-timeout")), 10000)),
      ]);
      const controlled =
        navigator.serviceWorker.controller !== null ||
        (await Promise.race([
          new Promise<boolean>((resolve) => {
            const onChange = () => {
              navigator.serviceWorker.removeEventListener("controllerchange", onChange);
              resolve(true);
            };
            navigator.serviceWorker.addEventListener("controllerchange", onChange);
          }),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10000)),
        ]));
      if (!controlled) {
        setState((s) => (s === "warming" ? "idle" : s));
        return;
      }
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
    // Proactive sync: warm on every library load while online (no throttle —
    // a refresh right after saving must pick up the newest articles). When a
    // stale count is showing, the warm runs quietly in the background.
    if (!ran.current && navigator.onLine) {
      ran.current = true;
      void warm(prev !== null);
    }
    // Same-tab warms triggered elsewhere (e.g. SaveForm warming right after
    // a save, which doesn't remount this button through router.refresh()).
    function onReady() {
      const cur = readOfflineReady();
      if (cur) {
        setArticles(cur.count);
        setState("ready");
      }
    }
    window.addEventListener(OFFLINE_READY_EVENT, onReady);
    return () => window.removeEventListener(OFFLINE_READY_EVENT, onReady);
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
      <button onClick={() => void warm(false)} disabled={state === "warming"}>
        {label}
      </button>
    </p>
  );
}
