"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { warmOfflineCache } from "@/lib/offline-cache";

export default function SaveForm() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!url.trim()) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setError("You're offline — reconnect to save new articles.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/articles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);
      setUrl("");
      router.refresh();
      // Proactive offline sync: the library button stays mounted through
      // router.refresh(), so warm here — the newly saved article (and the
      // refreshed library) lands in the service-worker cache immediately,
      // without waiting for the next full page load.
      if (navigator.onLine) void warmOfflineCache();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="save-row">
        <input
          type="url"
          required
          placeholder="Paste an article URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Article URL"
        />
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
