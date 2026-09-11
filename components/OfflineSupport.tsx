"use client";
import { useEffect, useState } from "react";
import { flushPendingProgress, readPendingProgress } from "@/lib/offline-queue";
import { readOfflineReady } from "@/lib/offline-cache";

/**
 * Registers /sw.js once, then flushes queued progress writes whenever the
 * browser comes back online. Also surfaces connectivity + pending count so
 * readers know their position will sync later.
 */
export default function OfflineSupport() {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [ready, setReady] = useState(0);

  useEffect(() => {
    setOnline(navigator.onLine);
    setPending(readPendingProgress().length);
    setReady(readOfflineReady()?.count ?? 0);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    async function flush() {
      try {
        const { remaining } = await flushPendingProgress(async (id, progress) => {
          const res = await fetch(`/api/articles/${id}/progress`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ progress }),
          });
          return res;
        });
        setPending(remaining.length);
      } catch {
        // stay queued
      }
    }

    function onOnline() {
      setOnline(true);
      setPending(readPendingProgress().length);
      void flush();
    }
    function onOffline() {
      setOnline(false);
    }
    // Refresh the count when other tabs / progress writes update the queue.
    function onStorage(e: StorageEvent) {
      if (e.key === "readapaper:pending-progress") {
        setPending(readPendingProgress().length);
      }
      if (e.key === "readapaper:offline-ready") {
        setReady(readOfflineReady()?.count ?? 0);
      }
    }

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("storage", onStorage);
    // Flush once on mount in case we loaded while already online.
    if (navigator.onLine) void flush();
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  if (online && pending === 0) return null;
  return (
    <p className="muted" role="status" style={{ textAlign: "center", margin: "0.5rem 0 0" }}>
      {!online
        ? `Offline — ${ready ? `${ready} article${ready === 1 ? "" : "s"} ready to read` : "no articles cached yet; reconnect and open the library to cache them"}. Progress will sync when you reconnect${
            pending ? ` (${pending} pending)` : ""
          }.`
        : `${pending} reading-progress update${pending === 1 ? "" : "s"} pending sync…`}
    </p>
  );
}
