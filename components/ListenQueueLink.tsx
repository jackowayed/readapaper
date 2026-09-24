"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { QUEUE_CHANGE_EVENT, readQueue } from "@/lib/listen-queue";

/**
 * ListenQueueLink — client-side queue count (the queue lives in
 * localStorage, so no server component can know N). Hidden when the queue
 * is empty; otherwise `▶ Listen queue (N)` linking to `/listen`. Listens
 * for same-tab mutations + cross-tab storage + refocus.
 */
export default function ListenQueueLink() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const refresh = () => setCount(readQueue().length);
    refresh();
    window.addEventListener(QUEUE_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(QUEUE_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  if (count === 0) return null;
  return (
    <p>
      <Link href="/listen" aria-label={`Listen queue, ${count} articles`}>
        ▶ Listen queue ({count})
      </Link>
    </p>
  );
}
