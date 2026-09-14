"use client";
import { useCallback, useEffect, useState } from "react";

type Status = { configured: boolean; activeCount: number };

/**
 * Kindle send control. Rendered by React (status loads in useEffect) so the
 * server HTML and the first client render match exactly — the previous
 * inline-script-injected DOM mutated #kindle-root before hydration finished,
 * tripping a React hydration mismatch on every library load.
 */
export default function KindleSend() {
  const [label] = useState("📚 Send 50 latest to Kindle");
  const [sending, setSending] = useState(false);
  const [sendingLabel] = useState("Sending to Kindle…");
  const [hint, setHint] = useState("Checking Kindle status…");
  const [toast, setToast] = useState("");
  const [enabled, setEnabled] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/kindle/status");
      const s = (await r.json()) as Status;
      const n = typeof s.activeCount === "number" ? s.activeCount : 0;
      if (s.configured && n > 0) {
        setEnabled(true);
        setHint(`Send the ${Math.min(50, n)} latest of ${n} active articles.`);
      } else if (s.configured) {
        setEnabled(false);
        setHint("No active articles to send yet.");
      } else {
        setEnabled(false);
        setHint("Kindle sending needs SMTP setup — see .env.example.");
      }
    } catch {
      setHint("Kindle status unavailable.");
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  async function onSend() {
    setSending(true);
    setToast("");
    try {
      const r = await fetch("/api/kindle/send", { method: "POST" });
      const d = (await r.json()) as {
        ok?: boolean;
        count?: number;
        error?: string;
        setup?: string;
      };
      if (r.status === 200 && d?.ok) {
        setToast(`Sent ${d.count} articles to Kindle.`);
      } else {
        setToast(String(d?.error || d?.setup || `Send failed (${r.status})`));
      }
    } catch {
      setToast("Kindle send failed — try again.");
    } finally {
      setSending(false);
      void refreshStatus();
    }
  }

  return (
    <div id="kindle-root" data-testid="kindle-root" className="kindle-row">
      <button
        id="kindle-send"
        data-testid="kindle-send"
        type="button"
        disabled={!enabled || sending}
        onClick={() => void onSend()}
      >
        {sending ? sendingLabel : label}
      </button>{" "}
      <span id="kindle-hint" data-testid="kindle-status" className="muted" role="status">
        {hint}
      </span>
      <p
        id="kindle-toast"
        data-testid="kindle-toast"
        className="muted"
        role="status"
        aria-live="polite"
        hidden={!toast}
      >
        {toast}
      </p>
    </div>
  );
}
